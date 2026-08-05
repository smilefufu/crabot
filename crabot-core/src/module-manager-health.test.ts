import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import ModuleManager from './index.js'
import type { ModuleRuntime } from './types.js'

function runtime(moduleId = 'health-module'): ModuleRuntime {
  return {
    module_id: moduleId,
    module_type: 'memory',
    entry: 'node noop.js',
    cwd: '.',
    auto_start: false,
    start_priority: 1,
    status: 'running',
    port: 29999,
  }
}

function manager(threshold = 3): any {
  const instance = new ModuleManager({
    health_check_failure_threshold: threshold,
    health_check_timeout: 0.05,
    modules: [],
  }, `./test-data/module-manager-health-${generateTestId()}`) as any
  instance.publishEvent = vi.fn().mockResolvedValue(undefined)
  return instance
}

let nextId = 0
function generateTestId(): number {
  nextId += 1
  return nextId
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Module Manager health reducer and probe ownership', () => {
  it('healthy and degraded clear failures; unhealthy and transport failures accumulate', async () => {
    const mm = manager(10)
    const subject = runtime()
    const outcomes: Array<unknown> = [
      new Error('connection refused'),
      { status: 'unhealthy' },
      { status: 'degraded' },
      new Error('timeout'),
      { status: 'healthy' },
    ]
    mm.sendToModule = vi.fn(async () => {
      const value = outcomes.shift()
      if (value instanceof Error) throw value
      return value
    })

    await mm.checkModuleHealth(subject)
    expect(subject.health_check_failures).toBe(1)
    await mm.checkModuleHealth(subject)
    expect(subject.health_check_failures).toBe(2)
    await mm.checkModuleHealth(subject)
    expect(subject.health_check_failures).toBe(0)
    expect(subject.last_health_status).toBe('degraded')
    await mm.checkModuleHealth(subject)
    expect(subject.health_check_failures).toBe(1)
    await mm.checkModuleHealth(subject)
    expect(subject.health_check_failures).toBe(0)
    expect(subject.last_health_status).toBe('healthy')
  })

  it('compares the previous health value before writing and emits only real transitions', async () => {
    const mm = manager(10)
    const subject = runtime()
    mm.sendToModule = vi.fn()
      .mockResolvedValueOnce({ status: 'healthy' })
      .mockResolvedValueOnce({ status: 'degraded' })
      .mockResolvedValueOnce({ status: 'degraded' })
      .mockResolvedValueOnce({ status: 'healthy' })

    for (let i = 0; i < 4; i++) await mm.checkModuleHealth(subject)

    const transitions = mm.publishEvent.mock.calls.map(([event]: any[]) => event.payload)
    expect(transitions).toEqual([
      { module_id: subject.module_id, previous: 'healthy', current: 'degraded' },
      { module_id: subject.module_id, previous: 'degraded', current: 'healthy' },
    ])
  })

  it('does not overlap probes and releases ownership after success or rejection', async () => {
    const mm = manager(10)
    const subject = runtime()
    let release!: (value: unknown) => void
    const pending = new Promise(resolve => { release = resolve })
    mm.sendToModule = vi.fn().mockReturnValueOnce(pending).mockRejectedValueOnce(new Error('aborted'))

    const first = mm.checkModuleHealth(subject)
    await mm.checkModuleHealth(subject)
    expect(mm.sendToModule).toHaveBeenCalledTimes(1)

    release({ status: 'healthy' })
    await first
    await mm.checkModuleHealth(subject)
    expect(mm.sendToModule).toHaveBeenCalledTimes(2)
    expect(mm.healthProbes.has(subject.module_id)).toBe(false)
  })

  it.each([
    undefined,
    null,
    {},
    { status: 'ready' },
  ])('counts invalid response %# as a failed probe', async (response) => {
    const mm = manager(10)
    const subject = runtime()
    mm.sendToModule = vi.fn().mockResolvedValue(response)

    await mm.checkModuleHealth(subject)

    expect(subject.health_check_failures).toBe(1)
    expect(mm.healthProbes.has(subject.module_id)).toBe(false)
  })

  it('discards a late old-child probe result without mutating its replacement', async () => {
    const mm = manager(1)
    const subject = runtime()
    const oldChild = { pid: 101 }
    const replacement = { pid: 202 }
    mm.processes.set(subject.module_id, oldChild)
    let rejectProbe!: (error: Error) => void
    mm.sendToModule = vi.fn().mockReturnValue(new Promise((_resolve, reject) => {
      rejectProbe = reject
    }))
    mm.scheduleHealthRecovery = vi.fn()

    const probe = mm.checkModuleHealth(subject)
    mm.processes.set(subject.module_id, replacement)
    subject.pid = 202
    rejectProbe(new Error('old child failed'))
    await probe

    expect(subject.health_check_failures).toBeUndefined()
    expect(subject.last_health_check).toBeUndefined()
    expect(subject.last_health_status).toBeUndefined()
    expect(subject.status).toBe('running')
    expect(subject.pid).toBe(202)
    expect(mm.processes.get(subject.module_id)).toBe(replacement)
    expect(mm.scheduleHealthRecovery).not.toHaveBeenCalled()
    expect(mm.publishEvent).not.toHaveBeenCalled()
  })

  it.each([
    'aborted-response',
    'failed-envelope',
    'malformed-response',
    'timeout',
    'slow-drip',
  ])('releases probe ownership after real HTTP %s', async (mode) => {
    let dripTimer: NodeJS.Timeout | undefined
    const server = http.createServer((_request, response) => {
      if (mode === 'aborted-response') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.write('{')
        response.destroy()
      } else if (mode === 'failed-envelope') {
        response.end(JSON.stringify({ success: false, error: { message: 'not healthy' } }))
      } else if (mode === 'malformed-response') {
        response.end('not-json')
      } else if (mode === 'slow-drip') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        dripTimer = setInterval(() => response.write(' '), 10)
      }
      // timeout deliberately leaves the response open.
    })
    await new Promise<void>((resolve, reject) => {
      server.listen(0, resolve)
      server.once('error', reject)
    })
    const port = (server.address() as { port: number }).port
    const mm = manager(10)
    const subject = runtime()
    subject.port = port

    try {
      await mm.checkModuleHealth(subject)
      expect(subject.health_check_failures).toBe(1)
      expect(mm.healthProbes.has(subject.module_id)).toBe(false)
    } finally {
      if (dripTimer) clearInterval(dripTimer)
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('submits one child-bound recovery at threshold without deleting the process map inline', async () => {
    const mm = manager(2)
    const subject = runtime()
    const fakeChild = { pid: 12345 }
    mm.processes.set(subject.module_id, fakeChild)
    mm.sendToModule = vi.fn().mockRejectedValue(new Error('unreachable'))
    mm.scheduleHealthRecovery = vi.fn(() => mm.healthRecoveries.add(subject.module_id))

    await mm.checkModuleHealth(subject)
    await mm.checkModuleHealth(subject)
    await mm.checkModuleHealth(subject)

    expect(mm.scheduleHealthRecovery).toHaveBeenCalledTimes(1)
    expect(mm.processes.get(subject.module_id)).toBe(fakeChild)
    expect(subject.status).toBe('running')
    expect(subject.last_health_status).toBe('unhealthy')
  })
})
