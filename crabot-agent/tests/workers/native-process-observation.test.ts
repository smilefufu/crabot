import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ClaudeCodeAdapter } from '../../src/workers/claude-code/adapter.js'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter.js'
import { CodexAppServerClient } from '../../src/workers/codex/app-server-client.js'
import type { IncarnationHandle, WorkerAdapter } from '../../src/workers/types.js'

let directory: string
beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'native-process-observation-')) })
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }) })
function make(impl: 'claude-code' | 'codex') {
  const tmux = { readProcessCarrier: vi.fn(), killSession: vi.fn() }
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
