import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import ModuleManager from './index.js'
import type { ModuleRuntime } from './types.js'
import { isProcessTreeAlive } from './process-tree.js'

const fixture = path.resolve('src/test-fixtures/uv-python-sleeper.py')
const cleanupDirs: string[] = []
let nextId = 0

function makeManager(options: {
  autoRestart?: boolean
  mode?: string
  threshold?: number
  shutdownTimeout?: number
  healthTimeout?: number
} = {}): {
  mm: any
  runtime: ModuleRuntime
  pidFile: string
  events: any[]
} {
  nextId += 1
  const dataDir = path.resolve(`test-data/module-manager-lifecycle-${process.pid}-${nextId}`)
  cleanupDirs.push(dataDir)
  const pidFile = path.join(dataDir, 'python.json')
  const mode = options.mode ?? 'sleep'
  const moduleId = `tree-module-${nextId}`
  const modulePort = 29000 + nextId
  const runtime: ModuleRuntime = {
    module_id: moduleId,
    module_type: 'memory',
    entry: `uv run --no-project python "${fixture}" "${pidFile}" "${mode}" "${modulePort}"`,
    cwd: process.cwd(),
    auto_start: false,
    auto_restart: options.autoRestart ?? false,
    skip_health_check: true,
    start_priority: 1,
    status: 'stopped',
    port: modulePort,
  }
  const mm = new ModuleManager({
    shutdown_timeout: options.shutdownTimeout ?? 0.1,
    health_check_timeout: options.healthTimeout ?? 0.05,
    health_check_failure_threshold: options.threshold ?? 1,
    modules: [],
  }, dataDir) as any
  mm.modules.set(moduleId, runtime)
  const events: any[] = []
  mm.publishEvent = vi.fn(async (event: any) => { events.push(event) })
  return { mm, runtime, pidFile, events }
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for lifecycle state')
}

async function readPidFile(pidFile: string): Promise<{
  pid: number
  ppid: number
  pgid: number
  marker?: string
} | undefined> {
  try {
    return JSON.parse(await fs.readFile(pidFile, 'utf8'))
  } catch {
    return undefined
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function start(mm: any, runtime: ModuleRuntime, env: Record<string, string> = {}): Promise<{
  child: ChildProcess
  info: Awaited<ReturnType<typeof readPidFile>> & {}
}> {
  await mm.handleStartModule({ module_id: runtime.module_id, env })
  const child = await waitFor(() => mm.processes.get(runtime.module_id) as ChildProcess | undefined)
  const info = await waitFor(() => readPidFile(path.join(mm.dataDir, 'python.json')))
  if (runtime.status === 'starting') {
    const state = mm.childStates.get(child)
    if (state) state.reachedRunning = true
    runtime.status = 'running'
  }
  await waitFor(() => runtime.status === 'running' ? true : undefined)
  return { child, info }
}

function stoppedEvents(events: any[], moduleId: string): any[] {
  return events.filter(event =>
    event.type === 'module_manager.module_stopped' && event.payload.module_id === moduleId,
  )
}

async function forceCleanup(mm: any, runtime: ModuleRuntime): Promise<void> {
  mm.cancelAutoRestart(runtime.module_id)
  const child = mm.processes.get(runtime.module_id) as ChildProcess | undefined
  if (child?.pid && isProcessTreeAlive(child.pid)) {
    const exited = child.exitCode === null && child.signalCode === null
      ? new Promise<void>(resolve => child.once('exit', () => resolve()))
      : Promise.resolve()
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    await exited
  }
  mm.processes.delete(runtime.module_id)
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanupDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('Module Manager child-bound lifecycle', () => {
  it('completes startup orphan recovery before opening the MM listener', async () => {
    const { mm } = makeManager()
    mm.runtimeRegistry = {
      initialize: vi.fn(async () => undefined),
      recoverOrphans: vi.fn(async () => { throw new Error('STARTUP_ORPHAN_RECOVERY_BLOCKED') }),
    }

    await expect(mm.start()).rejects.toThrow('STARTUP_ORPHAN_RECOVERY_BLOCKED')

    expect(mm.server).toBeNull()
  })

  it('refuses to spawn when the per-module orphan gate cannot complete', async () => {
    const { mm, runtime } = makeManager()
    runtime.entry = 'definitely-not-a-real-crabot-command'
    mm.runtimeRegistry = {
      initialize: vi.fn(async () => undefined),
      recoverOrphans: vi.fn(async () => { throw new Error('ORPHAN_RECOVERY_BLOCKED') }),
    }

    await expect(mm.startModuleProcess(runtime.module_id, undefined, {}))
      .rejects.toThrow('ORPHAN_RECOVERY_BLOCKED')

    expect(mm.processes.has(runtime.module_id)).toBe(false)
  })

  it('terminates a spawned tree when its runtime record cannot be persisted', async () => {
    const { mm, runtime } = makeManager()
    let spawnedPid: number | undefined
    mm.runtimeRegistry = {
      initialize: vi.fn(async () => undefined),
      getInstanceId: vi.fn(() => 'instance-test'),
      createRuntimeId: vi.fn(() => 'runtime-write-failure'),
      recoverOrphans: vi.fn(async () => undefined),
      recordSpawn: vi.fn(async ({ rootPid }: { rootPid: number }) => {
        expect(mm.processes.has(runtime.module_id)).toBe(false)
        spawnedPid = rootPid
        throw new Error('RUNTIME_RECORD_WRITE_FAILED')
      }),
      removeRuntime: vi.fn(async () => undefined),
    }

    try {
      await expect(mm.startModuleProcess(runtime.module_id, undefined, {}))
        .rejects.toThrow('RUNTIME_RECORD_WRITE_FAILED')
      expect(spawnedPid).toBeDefined()
      await waitFor(() => spawnedPid && !isProcessTreeAlive(spawnedPid) ? true : undefined)
      expect(mm.processes.has(runtime.module_id)).toBe(false)
      expect(runtime.pid).toBeUndefined()
    } finally {
      await forceCleanup(mm, runtime)
    }
  })

  it('serializes one module while allowing different modules to proceed', async () => {
    const { mm } = makeManager()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })

    const first = mm.enqueueLifecycle('same', async () => {
      order.push('same-1-start')
      await gate
      order.push('same-1-end')
    })
    const second = mm.enqueueLifecycle('same', async () => { order.push('same-2') })
    const other = mm.enqueueLifecycle('other', async () => { order.push('other') })
    await other

    expect(order).toEqual(['same-1-start', 'other'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['same-1-start', 'other', 'same-1-end', 'same-2'])
  })

  it('drains an admitted start and refuses spawn once MM shutdown begins', async () => {
    const { mm, runtime } = makeManager()
    let entered!: () => void
    let release!: () => void
    const enteredQueue = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const queuedStart = mm.enqueueLifecycle(runtime.module_id, async () => {
      entered()
      await gate
      await mm.startModuleProcess(runtime.module_id, undefined, {})
    })
    const queuedResult = queuedStart.catch((error: Error) => error)
    await enteredQueue

    const shutdown = mm.stop()
    release()
    await shutdown

    expect((await queuedResult).message).toContain('refusing to spawn')
    expect(mm.processes.has(runtime.module_id)).toBe(false)
    await expect(mm.handleStartModule({ module_id: runtime.module_id })).rejects.toThrow('shutting down')
    await expect(mm.handleStopModule({ module_id: runtime.module_id })).rejects.toThrow('shutting down')
    await expect(mm.handleRestartModule({ module_id: runtime.module_id })).rejects.toThrow('shutting down')
  })

  it('makes repeated stop calls wait for the same active shutdown', async () => {
    const { mm } = makeManager()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    mm.lifecycleQueues.set('blocked-operation', gate)

    const firstStop = mm.stop()
    let secondResolved = false
    const secondStop = mm.stop().then(() => { secondResolved = true })
    await Promise.resolve()

    expect(secondResolved).toBe(false)
    release()
    await Promise.all([firstStop, secondStop])
  })

  it('keeps a slow health cleanup and concurrent restart on one child-tree boundary', async () => {
    const { mm, runtime, pidFile } = makeManager()
    const initial = await start(mm, runtime, { TEST_MARKER: 'old' })
    const terminate = mm.terminateChildTree.bind(mm)
    const startProcess = mm.startModuleProcess.bind(mm)
    let releaseTermination!: () => void
    const terminationGate = new Promise<void>(resolve => { releaseTermination = resolve })
    mm.terminateChildTree = vi.fn(async (...args: unknown[]) => {
      await terminationGate
      return terminate(...args)
    })
    mm.startModuleProcess = vi.fn(startProcess)

    mm.scheduleHealthRecovery(runtime, initial.child)
    await waitFor(() => mm.terminateChildTree.mock.calls.length === 1 ? true : undefined)
    await mm.handleRestartModule({
      module_id: runtime.module_id,
      env: { TEST_MARKER: 'replacement' },
    })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(mm.processes.get(runtime.module_id)).toBe(initial.child)
    expect(mm.startModuleProcess).not.toHaveBeenCalled()
    releaseTermination()

    const replacement = await waitFor(async () => {
      const info = await readPidFile(pidFile)
      const child = mm.processes.get(runtime.module_id) as ChildProcess | undefined
      return child !== initial.child && info?.marker === 'replacement' ? { child, info } : undefined
    })
    expect(pidAlive(initial.info.pid)).toBe(false)
    expect(mm.startModuleProcess).toHaveBeenCalledTimes(1)
    expect(mm.processes.get(runtime.module_id)).toBe(replacement.child)
    await forceCleanup(mm, runtime)
  })

  it('ordinary module stop calls /shutdown before tree-level escalation', async () => {
    const { mm, runtime, pidFile, events } = makeManager({ mode: 'http', shutdownTimeout: 1 })
    runtime.skip_health_check = false
    const { child } = await start(mm, runtime)
    await waitFor(async () => {
      try {
        await mm.sendToModule(runtime.port, 'health', {})
        return true
      } catch {
        return undefined
      }
    })
    const sendToModule = mm.sendToModule.bind(mm)
    mm.sendToModule = vi.fn(sendToModule)

    await mm.handleStopModule({ module_id: runtime.module_id })
    await waitFor(() => !mm.processes.has(runtime.module_id) ? true : undefined)

    expect(mm.sendToModule).toHaveBeenCalledWith(runtime.port, 'shutdown', {}, 1000)
    expect((await readPidFile(pidFile))?.shutdown_called).toBe(true)
    expect(child.pid && isProcessTreeAlive(child.pid)).toBe(false)
    expect(stoppedEvents(events, runtime.module_id).map(event => event.payload.reason)).toEqual(['shutdown'])
  })

  it('bounds an active but incomplete /shutdown response by the shutdown timeout', async () => {
    const { mm, runtime, pidFile } = makeManager({
      mode: 'http-drip',
      shutdownTimeout: 0.2,
      healthTimeout: 2,
    })
    runtime.skip_health_check = false
    await start(mm, runtime)
    await waitFor(async () => {
      try {
        await mm.sendToModule(runtime.port, 'health', {})
        return true
      } catch {
        return undefined
      }
    })

    const startedAt = Date.now()
    await mm.handleStopModule({ module_id: runtime.module_id })
    await waitFor(() => !mm.processes.has(runtime.module_id) ? true : undefined, 2000)

    expect(Date.now() - startedAt).toBeLessThan(1200)
    expect((await readPidFile(pidFile))?.shutdown_called).toBe(true)
  })

  it('force skips /shutdown even for an RPC-capable module', async () => {
    const { mm, runtime, pidFile } = makeManager({ mode: 'http', shutdownTimeout: 1 })
    runtime.skip_health_check = false
    await start(mm, runtime)
    await waitFor(async () => {
      try {
        await mm.sendToModule(runtime.port, 'health', {})
        return true
      } catch {
        return undefined
      }
    })
    const sendToModule = mm.sendToModule.bind(mm)
    mm.sendToModule = vi.fn(sendToModule)

    await mm.handleStopModule({ module_id: runtime.module_id, force: true })
    await waitFor(() => !mm.processes.has(runtime.module_id) ? true : undefined)

    expect(mm.sendToModule).not.toHaveBeenCalledWith(runtime.port, 'shutdown', {})
    expect((await readPidFile(pidFile))?.shutdown_called).toBe(false)
  })

  it('graceful stop removes the real uv -> python tree and emits one stopped event', async () => {
    const { mm, runtime, events } = makeManager()
    const { child, info } = await start(mm, runtime)

    await mm.handleStopModule({ module_id: runtime.module_id })
    await waitFor(() => mm.processes.has(runtime.module_id) ? undefined : true)

    expect(child.pid && isProcessTreeAlive(child.pid)).toBe(false)
    expect(pidAlive(info.pid)).toBe(false)
    expect(runtime.status).toBe('stopped')
    expect(stoppedEvents(events, runtime.module_id).map(event => event.payload.reason)).toEqual(['shutdown'])
  })

  it('forced stop removes an ignoring uv -> python tree', async () => {
    const { mm, runtime, events } = makeManager({ mode: 'ignore-term' })
    const { child, info } = await start(mm, runtime)

    await mm.handleStopModule({ module_id: runtime.module_id, force: true })
    await waitFor(() => mm.processes.has(runtime.module_id) ? undefined : true)

    expect(child.pid && isProcessTreeAlive(child.pid)).toBe(false)
    expect(pidAlive(info.pid)).toBe(false)
    expect(stoppedEvents(events, runtime.module_id).map(event => event.payload.reason)).toEqual(['forced'])
  })

  it('ignores child output that arrives after its log stream is finalized', async () => {
    const { mm, runtime } = makeManager()
    const { child } = await start(mm, runtime)
    const state = mm.childStates.get(child)

    await mm.handleStopModule({ module_id: runtime.module_id })
    await state.finalized
    const write = vi.spyOn(state.logStream, 'write')

    child.stdout?.emit('data', Buffer.from('late output\n'))

    expect(write).not.toHaveBeenCalled()
  })

  it('restart waits for the old tree, uses the new env snapshot, and ignores old late callbacks', async () => {
    const { mm, runtime, pidFile, events } = makeManager()
    const first = await start(mm, runtime, { TEST_MARKER: 'one' })

    await mm.handleRestartModule({ module_id: runtime.module_id, env: { TEST_MARKER: 'two' } })
    const replacement = await waitFor(async () => {
      const info = await readPidFile(pidFile)
      const child = mm.processes.get(runtime.module_id) as ChildProcess | undefined
      return info?.marker === 'two' && info.pid !== first.info.pid && child !== first.child
        ? { child: child!, info }
        : undefined
    })

    expect(pidAlive(first.info.pid)).toBe(false)
    expect(first.child.pid && isProcessTreeAlive(first.child.pid)).toBe(false)
    expect(replacement.info.marker).toBe('two')
    const replacementState = mm.childStates.get(replacement.child)
    expect((await mm.runtimeRegistry.listRecords()).map((record: { runtime_id: string }) => record.runtime_id))
      .toEqual([replacementState.runtimeId])
    const stoppedBeforeLateError = stoppedEvents(events, runtime.module_id).length

    first.child.emit('error', new Error('late old-child error'))
    await new Promise(resolve => setImmediate(resolve))

    expect(mm.processes.get(runtime.module_id)).toBe(replacement.child)
    expect(runtime.pid).toBe(replacement.child.pid)
    expect(runtime.status).toBe('running')
    expect(stoppedEvents(events, runtime.module_id)).toHaveLength(stoppedBeforeLateError)
    expect((await mm.runtimeRegistry.listRecords()).map((record: { runtime_id: string }) => record.runtime_id))
      .toEqual([replacementState.runtimeId])
    await forceCleanup(mm, runtime)
  })

  it('restart without env preserves the current actual env snapshot', async () => {
    const { mm, runtime, pidFile } = makeManager()
    const initial = await start(mm, runtime, { TEST_MARKER: 'preserved' })

    await mm.handleRestartModule({ module_id: runtime.module_id })
    const replacement = await waitFor(async () => {
      const info = await readPidFile(pidFile)
      return info?.pid !== initial.info.pid && info?.marker === 'preserved' ? info : undefined
    })

    expect(replacement.marker).toBe('preserved')
    expect(mm.envOverrides.get(runtime.module_id)).toEqual({ TEST_MARKER: 'preserved' })
    await forceCleanup(mm, runtime)
  })

  it('treats an unintentional exit code 0 as crashed', async () => {
    const { mm, runtime, events } = makeManager({ mode: 'exit-zero' })
    await start(mm, runtime)

    await waitFor(() => runtime.status === 'error' && !mm.processes.has(runtime.module_id) ? true : undefined)

    expect(stoppedEvents(events, runtime.module_id).map(event => event.payload.reason)).toEqual(['crashed'])
  })

  it('cleans the surviving python descendant when only the uv launcher crashes', async () => {
    const { mm, runtime, events } = makeManager()
    const { child, info } = await start(mm, runtime)

    child.kill('SIGKILL')
    await waitFor(() => !mm.processes.has(runtime.module_id) ? true : undefined)

    expect(pidAlive(info.pid)).toBe(false)
    expect(child.pid && isProcessTreeAlive(child.pid)).toBe(false)
    expect(runtime.status).toBe('error')
    expect(stoppedEvents(events, runtime.module_id).map(event => event.payload.reason)).toEqual(['crashed'])
  })

  it('health recovery uses the same tree finalizer and leaves no ignoring descendant', async () => {
    const { mm, runtime, events } = makeManager({ mode: 'ignore-term', threshold: 1 })
    const { child, info } = await start(mm, runtime)
    runtime.skip_health_check = false
    mm.sendToModule = vi.fn().mockRejectedValue(new Error('health transport failed'))

    await mm.checkModuleHealth(runtime)
    expect(mm.processes.get(runtime.module_id)).toBe(child)
    await waitFor(() => !mm.processes.has(runtime.module_id) ? true : undefined)

    expect(child.pid && isProcessTreeAlive(child.pid)).toBe(false)
    expect(pidAlive(info.pid)).toBe(false)
    expect(runtime.status).toBe('error')
    expect(stoppedEvents(events, runtime.module_id).map(event => event.payload.reason)).toEqual([
      'health_check_failed',
    ])
  })

  it('health failure and crash share one restart budget and reuse the current env snapshot', async () => {
    const { mm, runtime, pidFile, events } = makeManager({ autoRestart: true, threshold: 1 })
    const initial = await start(mm, runtime, { TEST_MARKER: 'stable-env' })
    runtime.skip_health_check = false
    mm.sendToModule = vi.fn().mockRejectedValue(new Error('unhealthy'))

    await mm.checkModuleHealth(runtime)
    runtime.skip_health_check = true
    const afterHealth = await waitFor(async () => {
      const info = await readPidFile(pidFile)
      const child = mm.processes.get(runtime.module_id) as ChildProcess | undefined
      return info?.pid !== initial.info.pid && info?.marker === 'stable-env' && child
        ? { child, info }
        : undefined
    }, 4000)

    expect(runtime.restart_history?.attempts).toHaveLength(1)
    expect(stoppedEvents(events, runtime.module_id).map(event => event.payload.reason)).toEqual([
      'health_check_failed',
    ])

    process.kill(-afterHealth.child.pid!, 'SIGKILL')
    const afterCrash = await waitFor(async () => {
      const info = await readPidFile(pidFile)
      const child = mm.processes.get(runtime.module_id) as ChildProcess | undefined
      return info?.pid !== afterHealth.info.pid && info?.marker === 'stable-env' && child
        ? { child, info }
        : undefined
    }, 6000)

    expect(afterCrash.info.marker).toBe('stable-env')
    expect(runtime.restart_history?.attempts).toHaveLength(2)
    expect(stoppedEvents(events, runtime.module_id).map(event => event.payload.reason)).toEqual([
      'health_check_failed',
      'crashed',
    ])
    await forceCleanup(mm, runtime)
  })

  it('manual stop does not consume automatic restart history', async () => {
    const { mm, runtime } = makeManager({ autoRestart: true })
    await start(mm, runtime)

    await mm.handleStopModule({ module_id: runtime.module_id })
    await waitFor(() => !mm.processes.has(runtime.module_id) ? true : undefined)

    expect(runtime.restart_history?.attempts ?? []).toHaveLength(0)
    expect(mm.restartTimers.has(runtime.module_id)).toBe(false)
  })

  it('a manual stop racing crash finalization cancels any newly-created restart timer', async () => {
    const { mm, runtime } = makeManager({ autoRestart: true })
    const { child } = await start(mm, runtime)

    child.kill('SIGKILL')
    await mm.handleStopModule({ module_id: runtime.module_id })
    await waitFor(() => !mm.processes.has(runtime.module_id) ? true : undefined)
    await new Promise(resolve => setTimeout(resolve, 1200))

    expect(mm.processes.has(runtime.module_id)).toBe(false)
    expect(mm.restartTimers.has(runtime.module_id)).toBe(false)
  })

  it('forced stop escalates an already-running crash finalizer without the graceful wait', async () => {
    const { mm, runtime } = makeManager({
      autoRestart: false,
      mode: 'ignore-term',
      shutdownTimeout: 2,
    })
    const { child, info } = await start(mm, runtime)

    child.kill('SIGKILL')
    const state = mm.childStates.get(child)
    await waitFor(() => state.finalizeStarted ? true : undefined)
    const startedAt = Date.now()
    await mm.handleStopModule({ module_id: runtime.module_id, force: true })
    await waitFor(() => !mm.processes.has(runtime.module_id) ? true : undefined)

    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(pidAlive(info.pid)).toBe(false)
  })

  it('allows a later forced cleanup to recover from a transient confirmation failure', async () => {
    const { mm, runtime, pidFile, events } = makeManager()
    const initial = await start(mm, runtime, { TEST_MARKER: 'old' })
    const terminate = mm.terminateChildTree.bind(mm)
    mm.terminateChildTree = vi.fn().mockRejectedValue(new Error('temporary ownership failure'))

    initial.child.kill('SIGKILL')
    const state = mm.childStates.get(initial.child)
    await waitFor(() => state.finalizeError ? true : undefined)
    expect(mm.processes.get(runtime.module_id)).toBe(initial.child)
    expect(runtime.status).toBe('error')

    mm.terminateChildTree = terminate
    await mm.handleRestartModule({
      module_id: runtime.module_id,
      force: true,
      env: { TEST_MARKER: 'new' },
    })
    const replacement = await waitFor(async () => {
      const info = await readPidFile(pidFile)
      const child = mm.processes.get(runtime.module_id) as ChildProcess | undefined
      return child !== initial.child && info?.marker === 'new' ? { child, info } : undefined
    })

    expect(pidAlive(initial.info.pid)).toBe(false)
    expect(mm.processes.get(runtime.module_id)).toBe(replacement.child)
    expect(stoppedEvents(events, runtime.module_id).map(event => event.payload.reason)).toEqual(['crashed'])
    await forceCleanup(mm, runtime)
  })

  it('does not spawn a replacement when old-tree termination cannot be confirmed', async () => {
    const { mm, runtime } = makeManager()
    const { child, info } = await start(mm, runtime, { TEST_MARKER: 'old' })
    mm.terminateChildTree = vi.fn().mockRejectedValue(new Error('tree still alive'))

    await mm.handleRestartModule({ module_id: runtime.module_id, env: { TEST_MARKER: 'new' } })
    await waitFor(() => runtime.status === 'error' ? true : undefined)
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(mm.processes.get(runtime.module_id)).toBe(child)
    expect((await readPidFile(path.join(mm.dataDir, 'python.json')))?.marker).toBe('old')
    expect(pidAlive(info.pid)).toBe(true)
    await forceCleanup(mm, runtime)
  })
})
