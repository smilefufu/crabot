import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { TmuxDriver } from '../../src/workers/tmux/driver.js'
import { removeTmuxControlEndpoint, type TmuxControlEndpoint } from '../../src/workers/tmux/control-monitor.js'
import { once } from 'node:events'
import { join } from 'node:path'
import type { WorkspaceRelocationIncarnation } from 'crabot-shared'
import { tmpdir } from 'node:os'
import { ClaudeCodeAdapter } from '../../src/workers/claude-code/adapter.js'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter.js'
import { CodexAppServerClient } from '../../src/workers/codex/app-server-client.js'
import type { IncarnationHandle, WorkerAdapter } from '../../src/workers/types.js'

let directory: string
beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'native-process-observation-')) })
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }) })
function make(impl: 'claude-code' | 'codex') {
  const tmux = { readProcessCarrier: vi.fn(), readOptionalProcessCarrier: vi.fn(), killSession: vi.fn() }
  const adapter: WorkerAdapter = impl === 'claude-code'
    ? new ClaudeCodeAdapter({ dataDir: directory, claudeConfigPath: join(directory, 'claude.json'), claudeProjectsDir: directory, tmux: tmux as any })
    : new CodexWorkerAdapter({ dataDir: directory, codexHomeSource: directory, tmux: tmux as any })
  const h: IncarnationHandle = { worker_id: 'worker', incarnation_id: 'fixed-incarnation', seq: 1, impl, session_ref: 'native-session' }
  const runtime = { worker_id: h.worker_id, incarnation_id: h.incarnation_id, seq: h.seq, sessionName: 'crabot-w-worker-1' }
  const runtimes: Map<string, any> = (adapter as any).runtimes
  runtimes.set('worker#1', runtime)
  return { adapter, tmux, h, runtime, runtimes }
}

describe.each(['claude-code', 'codex'] as const)('%s read-only process observation', impl => {
  it.each(['missing identity', 'different incarnation', 'different impl', 'different Worker', 'different seq', 'missing runtime'])('does not cold-reconstruct or mutate an unverified carrier: %s', async change => {
    const f = make(impl), rebuild = vi.spyOn(f.adapter as any, 'ensureRuntime')
    await fs.mkdir(join(directory, 'worker'))
    await fs.writeFile(join(directory, 'worker/meta-1.json'), '{"state":"running"}')
    if (change === 'missing identity') delete f.h.incarnation_id
    if (change === 'different incarnation') (f.h as any).incarnation_id = 'replacement'
    if (change === 'different impl') (f.h as any).impl = impl === 'codex' ? 'claude-code' : 'codex'
    if (change === 'different Worker') (f.h as any).worker_id = 'other'
    if (change === 'different seq') (f.h as any).seq = 2
    if (change === 'missing runtime') f.runtimes.clear()
    await expect(f.adapter.captureExecutionProcesses!(f.h)).rejects.toMatchObject({ code: 'WORKER_CARRIER_UNVERIFIED' })
    expect(rebuild).not.toHaveBeenCalled(); expect(f.tmux.readProcessCarrier).not.toHaveBeenCalled(); expect(f.tmux.killSession).not.toHaveBeenCalled()
    expect(await fs.readdir(directory)).toEqual(['worker'])
    expect(await fs.readdir(join(directory, 'worker'))).toEqual(['meta-1.json'])
    expect(await fs.readFile(join(directory, 'worker/meta-1.json'), 'utf8')).toBe('{"state":"running"}')
  })
  it('rejects a mismatched resident session without tmux query or stop', async () => {
    const f = make(impl); f.runtime.sessionName = 'unrelated-session'
    await expect(f.adapter.captureExecutionProcesses!(f.h)).rejects.toMatchObject({ code: 'WORKER_CARRIER_UNVERIFIED' })
    expect(f.tmux.readProcessCarrier).not.toHaveBeenCalled(); expect(f.tmux.killSession).not.toHaveBeenCalled()
  })
})

it('Claude headless observation uses the actual live ChildProcess and leaves it running', async () => {
  const f = make('claude-code')
  const child = spawn(process.execPath, ['-e', 'process.send("ready");const timer=setInterval(()=>{},1000);setTimeout(()=>clearInterval(timer),30000)'], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const ended = once(child, 'exit')
  try {
    await once(child, 'message'); (f.runtime as any).headlessChild = child
    const processes = await f.adapter.captureExecutionProcesses!(f.h)
    expect(processes).toMatchObject([{ pid: child.pid, parent: process.pid }])
    expect(Object.isFrozen(processes)).toBe(true)
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull(); expect(f.tmux.killSession).not.toHaveBeenCalled()
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended }
  await expect(f.adapter.captureExecutionProcesses!(f.h)).rejects.toMatchObject({ code: 'CRABOT_PROCESS_SCOPE' })
})

it('Codex refuses a resident runtime replaced during its client observation', async () => {
  const f = make('codex')
  ;(f.runtime as any).headlessClient = { captureExecutionProcesses() { f.runtimes.set('worker#1', { ...f.runtime }); return [] } }
  await expect(f.adapter.captureExecutionProcesses!(f.h)).rejects.toMatchObject({ code: 'WORKER_CARRIER_UNVERIFIED' })
})

it.skipIf(process.platform === 'win32')('Codex app-server observes its actual process even after a protocol-only disconnect', async () => {
  const f = make('codex'), ready = join(directory, 'ready')
  const source = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');const timer=setInterval(()=>{},1000);setTimeout(()=>clearInterval(timer),30000)`
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
  const client = new CodexAppServerClient({ command: quote(process.execPath) + ' -e ' + quote(source), cwd: directory, env: { PATH: process.env.PATH ?? '' } })
  ;(f.runtime as any).headlessClient = client
  try {
    const deadline = Date.now() + 5000
    while (!(await fs.stat(ready).catch(() => null))) { expect(Date.now()).toBeLessThan(deadline); await new Promise(resolve => setTimeout(resolve, 10)) }
    ;(client as any).finish(new Error('controlled protocol disconnect'))
    const processes = await f.adapter.captureExecutionProcesses!(f.h)
    expect(processes.some(item => item.pid === (client as any).child.pid && item.parent === process.pid)).toBe(true)
    expect((client as any).child.exitCode).toBeNull(); expect(f.tmux.killSession).not.toHaveBeenCalled()
  } finally { expect(await client.terminate()).toBe(true) }
  expect(() => client.captureExecutionProcesses()).toThrow('已退出')
})

function fixedIncarnation(h: IncarnationHandle): WorkspaceRelocationIncarnation {
  return { incarnation_id: h.incarnation_id!, impl: h.impl, seq: h.seq, workspace: join(directory, 'project'), started_at: '2026-10-20T00:00:00.000Z' }
}
async function coldMetadata(f: ReturnType<typeof make>, fixed: WorkspaceRelocationIncarnation) {
  f.runtimes.clear()
  await fs.mkdir(join(directory, 'worker'))
  const file = join(directory, 'worker', 'meta-1.json')
  await fs.writeFile(file, JSON.stringify({ seq: 1, session_id: f.h.session_ref, workspace_root: fixed.workspace, state: 'running' }))
  return file
}
async function finiteCarrier(f: ReturnType<typeof make>) {
  const child = spawn(process.execPath, ['-e', 'process.send("ready");setTimeout(()=>process.exit(0),30000)'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const exited = once(child, 'exit'); void exited.catch(() => {})
  await once(child, 'message')
  const carrier = { session_name: 'crabot-w-worker-1', session_id: '$1', pane_id: '%1', pane_pid: child.pid, dead: false, server_pid: process.pid }
  f.tmux.readProcessCarrier.mockResolvedValue(carrier)
  return { carrier, child, close: async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited } }
}

describe.each(['claude-code', 'codex'] as const)('%s fixed cold mainline observation', impl => {
  it('uses the original bounded metadata and actual kernel tree without reconstructing, stopping or rewriting', async () => {
    const f = make(impl), fixed = fixedIncarnation(f.h), file = await coldMetadata(f, fixed), live = await finiteCarrier(f)
    const rebuild = vi.spyOn(f.adapter as any, 'ensureRuntime'), before = await fs.readFile(file)
    try {
      const observed = await (f.adapter.captureExecutionProcesses as any)(f.h, fixed)
      expect(observed).toMatchObject([{ pid: live.child.pid, parent: process.pid }])
      expect(f.runtimes.size).toBe(0); expect(rebuild).not.toHaveBeenCalled(); expect(f.tmux.killSession).not.toHaveBeenCalled()
      expect(await fs.readFile(file)).toEqual(before)
      expect(live.child.exitCode).toBeNull()
    } finally { await live.close() }
  }, 30000)
  for (const damage of ['fixed identity', 'fixed impl', 'fixed seq', 'unsafe Worker', 'unsafe seq', 'fork', 'query', 'wrong seq', 'wrong workspace', 'wrong session', 'missing', 'broken', 'null', 'oversize', 'hard link']) it(`refuses unverifiable cold metadata before querying tmux: ${damage}`, async () => {
    const f = make(impl), fixed = fixedIncarnation(f.h), file = await coldMetadata(f, fixed), rebuild = vi.spyOn(f.adapter as any, 'ensureRuntime')
    if (damage === 'fixed identity') (fixed as any).incarnation_id = 'replacement'
    else if (damage === 'fixed impl') (fixed as any).impl = impl === 'codex' ? 'claude-code' : 'codex'
    else if (damage === 'fixed seq') (fixed as any).seq = 2
    else if (damage === 'unsafe Worker') (f.h as any).worker_id = '../other'
    else if (damage === 'unsafe seq') { (f.h as any).seq = 0; (fixed as any).seq = 0 }
    else if (damage === 'fork') (fixed as any).forked_from = 'main'
    else if (damage === 'query') (fixed as any).query_id = 'query'
    else if (damage === 'missing') await fs.unlink(file)
    else if (damage === 'broken') await fs.writeFile(file, '{broken')
    else if (damage === 'null') await fs.writeFile(file, 'null')
    else if (damage === 'oversize') await fs.writeFile(file, 'x'.repeat(65537))
    else if (damage === 'hard link') await fs.link(file, join(directory, 'linked-meta.json'))
    else {
      const value = JSON.parse(await fs.readFile(file, 'utf8'))
      if (damage === 'wrong seq') value.seq = 2
      else if (damage === 'wrong workspace') value.workspace_root = join(directory, 'other')
      else if (damage === 'wrong session') value.session_id = 'other-session'
      await fs.writeFile(file, JSON.stringify(value))
    }
    await expect((f.adapter.captureExecutionProcesses as any)(f.h, fixed)).rejects.toMatchObject({ code: 'WORKER_CARRIER_UNVERIFIED' })
    expect(f.tmux.readProcessCarrier).not.toHaveBeenCalled(); expect(rebuild).not.toHaveBeenCalled(); expect(f.tmux.killSession).not.toHaveBeenCalled()
  })
  it('rejects a linked Worker directory instead of reading another directory', async () => {
    const f = make(impl), fixed = fixedIncarnation(f.h), file = await coldMetadata(f, fixed)
    const target = join(directory, 'linked-worker')
    await fs.rename(join(directory, 'worker'), target)
    await fs.symlink(target, join(directory, 'worker'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect((f.adapter.captureExecutionProcesses as any)(f.h, fixed)).rejects.toMatchObject({ code: 'WORKER_CARRIER_UNVERIFIED' })
    expect(f.tmux.readProcessCarrier).not.toHaveBeenCalled()
    expect(await fs.readFile(join(target, 'meta-1.json'), 'utf8')).toContain('native-session')
  })
  it.skipIf(process.platform === 'win32')('rejects a linked metadata file before opening another file', async () => {
    const f = make(impl), fixed = fixedIncarnation(f.h), file = await coldMetadata(f, fixed), target = join(directory, 'other-meta.json')
    await fs.rename(file, target); await fs.symlink(target, file)
    await expect((f.adapter.captureExecutionProcesses as any)(f.h, fixed)).rejects.toMatchObject({ code: 'WORKER_CARRIER_UNVERIFIED' })
    expect(f.tmux.readProcessCarrier).not.toHaveBeenCalled()
  })
  it.each(['metadata changed', 'resident appeared', 'adapter disposed'])('refuses a concurrent change: %s', async change => {
    const f = make(impl), fixed = fixedIncarnation(f.h), file = await coldMetadata(f, fixed), live = await finiteCarrier(f)
    let changed = false
    f.tmux.readProcessCarrier.mockImplementation(async () => {
      if (!changed) {
        changed = true
        if (change === 'metadata changed') {
          const value = JSON.parse(await fs.readFile(file, 'utf8')); value.state = 'idle'; await fs.writeFile(file, JSON.stringify(value))
        } else if (change === 'resident appeared') f.runtimes.set('worker#1', f.runtime)
        else await f.adapter.dispose()
      }
      return live.carrier
    })
    try {
      await expect((f.adapter.captureExecutionProcesses as any)(f.h, fixed)).rejects.toMatchObject({ code: 'WORKER_CARRIER_UNVERIFIED' })
      expect(f.tmux.readProcessCarrier).toHaveBeenCalledTimes(change === 'metadata changed' ? 2 : 1)
      expect(f.tmux.killSession).not.toHaveBeenCalled(); expect(live.child.exitCode).toBeNull()
    } finally { await live.close() }
  }, 30000)
  it.each(['handle', 'fixed context'])('freezes the original caller %s before waiting for carrier facts', async target => {
    const f = make(impl), fixed = fixedIncarnation(f.h)
    await coldMetadata(f, fixed)
    const live = await finiteCarrier(f)
    f.tmux.readProcessCarrier.mockImplementation(async () => {
      if (target === 'handle') (f.h as any).worker_id = 'replacement'
      else (fixed as any).workspace = join(directory, 'replacement')
      return live.carrier
    })
    try { expect(await (f.adapter.captureExecutionProcesses as any)(f.h, fixed)).toMatchObject([{ pid: live.child.pid }]) }
    finally { await live.close() }
  }, 30000)
})

function hasPrivateTmuxSupport(): boolean {
  if (process.platform === 'win32') return false
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true } catch { return false }
}
it.skipIf(!hasPrivateTmuxSupport())('joins cold adapters to an actual private tmux pane without using the default server', async () => {
  const socket = 'crabot-cold-' + randomUUID(), workerId = 'cold-' + randomUUID(), name = `crabot-w-${workerId}-1`
  const wrapper = join(directory, 'tmux-private'), ready = join(directory, 'tmux-ready')
  await fs.writeFile(wrapper, `#!/bin/sh\nexec tmux -L ${socket} "$@"\n`, { mode: 0o700 })
  const driver = new TmuxDriver({ tmuxBin: wrapper }), quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
  const source = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>process.exit(0),30000)`
  let endpoint: TmuxControlEndpoint | undefined
  try {
    endpoint = await driver.newSession({ name, cwd: directory, command: quote(process.execPath) + ' -e ' + quote(source) })
    const deadline = Date.now() + 5000
    while (!await fs.stat(ready).catch(() => null)) { expect(Date.now()).toBeLessThan(deadline); await new Promise(resolve => setTimeout(resolve, 10)) }
    const pid = Number(await fs.readFile(ready, 'utf8'))
    for (const impl of ['claude-code', 'codex'] as const) {
      const root = join(directory, impl), worker = join(root, workerId), file = join(worker, 'meta-1.json')
      await fs.mkdir(worker, { recursive: true })
      const h: IncarnationHandle = { worker_id: workerId, incarnation_id: 'fixed-' + impl, impl, seq: 1, session_ref: 'private-session' }
      const fixed = fixedIncarnation(h)
      await fs.writeFile(file, JSON.stringify({ seq: 1, workspace_root: fixed.workspace, session_id: h.session_ref, state: 'running' }))
      const adapter = impl === 'claude-code' ? new ClaudeCodeAdapter({ dataDir: root, tmux: driver, claudeConfigPath: join(root, 'claude.json'), claudeProjectsDir: root })
        : new CodexWorkerAdapter({ dataDir: root, tmux: driver, codexHomeSource: root })
      const rebuild = vi.spyOn(adapter as any, 'ensureRuntime'), before = await fs.readFile(file)
      try {
        expect(await adapter.captureExecutionProcesses(h, fixed)).toMatchObject([{ pid }])
        expect((adapter as any).runtimes.size).toBe(0); expect(rebuild).not.toHaveBeenCalled()
        expect(await fs.readFile(file)).toEqual(before)
      } finally { await adapter.dispose() }
    }
  } finally {
    try { execFileSync(wrapper, ['kill-server'], { stdio: 'ignore', timeout: 5000 }) } catch { /* Only this private socket. */ }
    if (endpoint) await removeTmuxControlEndpoint(endpoint)
  }
}, 30000)


describe.each(['claude-code', 'codex'] as const)('%s fixed legacy ended cold mainline', impl => {
  it('returns only absence after unchanged exited metadata and two exact native absences', async () => {
    const f = make(impl), fixed = fixedIncarnation(f.h), file = await coldMetadata(f, fixed)
    const value = JSON.parse(await fs.readFile(file, 'utf8')); value.state = 'exited'; await fs.writeFile(file, JSON.stringify(value))
    const before = await fs.readFile(file), rebuild = vi.spyOn(f.adapter as any, 'ensureRuntime')
    f.tmux.readOptionalProcessCarrier.mockResolvedValue(null)
    expect(await (f.adapter.captureExecutionProcesses as any)(f.h, fixed, true)).toEqual([])
    expect(f.tmux.readOptionalProcessCarrier).toHaveBeenCalledTimes(2)
    expect(f.tmux.readOptionalProcessCarrier).toHaveBeenCalledWith('crabot-w-worker-1')
    expect(f.tmux.readProcessCarrier).not.toHaveBeenCalled(); expect(f.tmux.killSession).not.toHaveBeenCalled()
    expect(rebuild).not.toHaveBeenCalled(); expect(f.runtimes.size).toBe(0); expect(await fs.readFile(file)).toEqual(before)
  })
  it.each(['active metadata', 'query error', 'appeared carrier', 'metadata changed', 'resident appeared', 'adapter disposed'])('preserves unknown or conflict: %s', async change => {
    const f = make(impl), fixed = fixedIncarnation(f.h), file = await coldMetadata(f, fixed)
    const value = JSON.parse(await fs.readFile(file, 'utf8')); value.state = change === 'active metadata' ? 'running' : 'exited'; await fs.writeFile(file, JSON.stringify(value))
    let calls = 0
    f.tmux.readOptionalProcessCarrier.mockImplementation(async () => {
      calls++
      if (change === 'query error') throw new Error('native observation unavailable')
      if (change === 'appeared carrier' && calls > 1) return { session_name: 'crabot-w-worker-1', session_id: '$1', pane_id: '%1', pane_pid: process.pid, dead: false, server_pid: process.pid }
      if (calls === 1 && change === 'metadata changed') await fs.writeFile(file, JSON.stringify({ ...value, state: 'running' }))
      if (change === 'resident appeared') f.runtimes.set('worker#1', f.runtime)
      if (change === 'adapter disposed') await f.adapter.dispose()
      return null
    })
    await expect((f.adapter.captureExecutionProcesses as any)(f.h, fixed, true)).rejects.toBeDefined()
    expect(f.tmux.killSession).not.toHaveBeenCalled()
  })
  it('keeps the real live process despite the legacy-ended context', async () => {
    const f = make(impl), fixed = fixedIncarnation(f.h); await coldMetadata(f, fixed)
    const live = await finiteCarrier(f)
    f.tmux.readOptionalProcessCarrier.mockResolvedValue(live.carrier)
    try {
      expect(await (f.adapter.captureExecutionProcesses as any)(f.h, fixed, true)).toMatchObject([{ pid: live.child.pid }])
      expect(live.child.exitCode).toBeNull(); expect(f.tmux.killSession).not.toHaveBeenCalled()
    } finally { await live.close() }
  }, 30000)
  it('does not consume the compatibility context without the original fixed identity', async () => {
    const f = make(impl); f.runtimes.clear(); f.tmux.readOptionalProcessCarrier.mockResolvedValue(null)
    await expect((f.adapter.captureExecutionProcesses as any)(f.h, undefined, true)).rejects.toBeDefined()
    expect(f.tmux.readOptionalProcessCarrier).not.toHaveBeenCalled()
  })
})

it.skipIf(!hasPrivateTmuxSupport())('observes real absent private servers through both cold adapters without starting a server', async () => {
  const socket = join(directory, 'absent-private.sock'), wrapper = join(directory, 'tmux-private-absent')
  await fs.writeFile(wrapper, `#!/bin/sh\nexec tmux -S '${socket}' "$@"\n`, { mode: 0o700 })
  const driver = new TmuxDriver({ tmuxBin: wrapper })
  for (const impl of ['claude-code', 'codex'] as const) {
    const root = join(directory, impl), worker = join(root, 'worker'); await fs.mkdir(worker, { recursive: true })
    const h: IncarnationHandle = { worker_id: 'worker', incarnation_id: 'old-' + impl, impl, seq: 1, session_ref: 'original-session' }
    const fixed = fixedIncarnation(h), file = join(worker, 'meta-1.json')
    await fs.writeFile(file, JSON.stringify({ seq: 1, workspace_root: fixed.workspace, session_id: h.session_ref, state: 'exited' }))
    const adapter = impl === 'claude-code' ? new ClaudeCodeAdapter({ dataDir: root, tmux: driver, claudeConfigPath: join(root, 'claude.json'), claudeProjectsDir: root })
      : new CodexWorkerAdapter({ dataDir: root, tmux: driver, codexHomeSource: root })
    const before = await fs.readFile(file), rebuild = vi.spyOn(adapter as any, 'ensureRuntime')
    try {
      expect(await (adapter.captureExecutionProcesses as any)(h, fixed, true)).toEqual([])
      expect(await fs.readFile(file)).toEqual(before); expect(rebuild).not.toHaveBeenCalled()
      await expect(fs.stat(socket)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await adapter.dispose() }
  }
}, 30000)
