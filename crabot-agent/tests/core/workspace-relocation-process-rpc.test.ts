import { afterEach, describe, it, expect, vi } from 'vitest'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { captureLegacyWorkspaceExecutions } from '../../src/workers/harness/workspace-legacy-executions.js'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { captureWorkspaceRelocationWorkers } from '../../src/workers/harness/workspace-relocation-scope.js'
import type { LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import { relocationMmFixture } from './fixtures/relocation-mm.js'
import { relocationAgentConfig } from './fixtures/relocation-agent-config.js'

async function fixture(mode = 'normal', impl: 'builtin' | 'claude-code' = 'builtin') {
  const mm = await relocationMmFixture(mode, true)
  vi.stubEnv('DATA_DIR', mm.data); vi.stubEnv('CRABOT_AGENT_DATA_DIR', path.join(mm.data, 'agent'))
  vi.stubEnv('CRABOT_MM_PORT', String(mm.options.moduleManagerPort))
  const agent = new UnifiedAgent(relocationAgentConfig) as any, harness = agent.managerStack.harness
  harness.deps.isWorkspaceRelocationReady = () => true
  const stop = vi.spyOn(harness.deps.adapters.get('builtin'), 'stop').mockResolvedValue(undefined)
  const server = http.createServer((req, res) => { void agent.handleRequest(req, res) })
  const cleanup = async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    try { await agent.managerStack.dispose() } finally { await mm.cleanup() }
  }
  try {
    const at = '2026-10-20T00:00:00.000Z'
    const worker: LedgerWorker = { worker_id: 'worker', manager_key: 'channel::session',
      task: { id: 'task', title: 'private task', status: 'running', created_at: at, input: { private: 'not in receipt' } },
      origin: { trigger_type: 'message', creator_friend_id: 'unchanged' }, report_to: { channel_id: 'channel', session_id: 'session' },
      incarnations: [{ incarnation_id: 'inc', impl, seq: 1, state: 'running', workspace: path.join(mm.data, 'project'), session_ref: 'fixture', started_at: at }], updated_at: at }
    await agent.managerStack.ledger.upsertWorker('channel::session', 'worker', () => worker)
    const before = await agent.managerStack.ledger.listAllWorkers(), scope = captureWorkspaceRelocationWorkers(before)
    await mm.journal.capture(scope)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const params = { intent_id: mm.intent.id, launch_id: mm.launch.launch_id }
    const call = async (body = params, bearer = mm.options.bearer) => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/capture_workspace_relocation_processes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
        body: JSON.stringify({ id: randomUUID(), source: 'module-manager', method: 'capture_workspace_relocation_processes', params: body }),
      })
      return response.json() as Promise<any>
    }
    return { ...mm, agent, harness, params, stop, before, scope, call, cleanup }
  } catch (error) { await cleanup(); throw error }
}

describe('Agent fixed native process capture RPC', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
  it('reads the original builtin scope without writing observations, stopping or closing', async () => {
    const f = await fixture()
    try {
      const result = await f.call()
      expect(result.success).toBe(true); expect(result.data).toEqual({ processes: [] })
      expect(await f.agent.managerStack.ledger.listAllWorkers()).toEqual(f.before)
      expect(f.records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id)).toBeNull()
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
      expect(f.stop).not.toHaveBeenCalled()
      expect(f.calls.filter(call => call.body.method === 'verify_workspace_relocation_coordinator')).toHaveLength(2)
    } finally { await f.cleanup() }
  }, 30000)
  it('observes the actual Claude headless ChildProcess through its real adapter without stopping it', async () => {
    const f = await fixture('normal', 'claude-code'), adapter = f.agent.managerStack.adapters.get('claude-code')
    const child = spawn(process.execPath, ['-e', 'process.send("ready");setTimeout(()=>process.exit(0),30000)'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    const ended = once(child, 'exit'), rebuild = vi.spyOn(adapter, 'ensureRuntime')
    try {
      await once(child, 'message')
      adapter.runtimes.set('worker#1', { worker_id: 'worker', incarnation_id: 'inc', seq: 1,
        workspaceRoot: path.join(f.data, 'project'), headlessChild: child })
      const result = await f.call()
      expect(result.success).toBe(true)
      expect(result.data.processes).toMatchObject([{ pid: child.pid, parent: process.pid }])
      expect(Object.keys(result.data.processes[0]).sort()).toEqual(['executable', 'owner', 'parent', 'pid', 'started'])
      expect(child.exitCode).toBeNull(); expect(rebuild).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
      expect(await f.agent.managerStack.ledger.listAllWorkers()).toEqual(f.before)
      expect(f.records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id)).toBeNull()
    } finally {
      adapter.runtimes.delete('worker#1')
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await ended; await f.cleanup()
    }
  }, 30000)
  it('keeps an unknown cold CLI carrier unknown without rebuilding or writing it', async () => {
    const f = await fixture('normal', 'claude-code'), adapter = f.agent.managerStack.adapters.get('claude-code')
    const rebuild = vi.spyOn(adapter, 'ensureRuntime')
    try {
      expect((await f.call()).error?.code).toBe('WORKSPACE_MAINTENANCE')
      expect(rebuild).not.toHaveBeenCalled(); expect(adapter.runtimes.size).toBe(0)
      expect(f.records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id)).toBeNull()
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
    } finally { await f.cleanup() }
  }, 30000)
  async function writeLegacyBoundary(f: Awaited<ReturnType<typeof fixture>>, ready = true, capturedAt = '2026-10-20T00:02:00.000Z') {
    const value = captureLegacyWorkspaceExecutions(await f.agent.managerStack.ledger.listAllWorkers(), capturedAt)
    const bytes = JSON.stringify(value), dir = path.join(f.data, 'workspace-control')
    await fs.writeFile(path.join(dir, 'legacy-executions.json'), bytes, { mode: 0o600 })
    if (ready) await fs.writeFile(path.join(dir, 'legacy-executions.ready'), JSON.stringify({ schema_version: 1, sha256: createHash('sha256').update(bytes).digest('hex') }), { mode: 0o600 })
    return value
  }
  it('consumes a real ready boundary through Harness and cold Claude metadata without stopping or rebuilding', async () => {
    const f = await fixture('normal', 'claude-code'), adapter = f.agent.managerStack.adapters.get('claude-code')
    try {
      await f.agent.managerStack.ledger.upsertWorker('channel::session', 'worker', (worker: LedgerWorker) => ({ ...worker,
        incarnations: worker.incarnations.map(item => ({ ...item, state: 'exited', ended_reason: 'completed', ended_at: '2026-10-20T00:01:00.000Z' })) }))
      const dir = path.join(adapter.deps.dataDir, 'worker'); await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, 'meta-1.json'); await fs.writeFile(file, JSON.stringify({ seq: 1, session_id: 'fixture', workspace_root: path.join(f.data, 'project'), state: 'exited' }))
      await writeLegacyBoundary(f)
      const capture = vi.spyOn(adapter.tmux, 'readOptionalProcessCarrier').mockResolvedValue(null), rebuild = vi.spyOn(adapter, 'ensureRuntime')
      const before = await fs.readFile(file), result = await f.call()
      expect(result.success).toBe(true); expect(result.data).toEqual({ processes: [] })
      expect(capture).toHaveBeenCalledTimes(2); expect(rebuild).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
      expect(await fs.readFile(file)).toEqual(before)
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
    } finally { await f.cleanup() }
  }, 30000)
  it.each(['prepared', 'corrupt'])('refuses %s legacy material before observing any carrier', async mode => {
    const f = await fixture(), capture = vi.spyOn(f.harness, 'captureWorkspaceRelocationProcesses')
    try {
      await writeLegacyBoundary(f, mode !== 'prepared')
      if (mode === 'corrupt') await fs.appendFile(path.join(f.data, 'workspace-control/legacy-executions.json'), 'broken')
      expect((await f.call()).error?.code).toBe('SERVICE_UNAVAILABLE')
      expect(capture).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  }, 30000)
  it('rejects a valid but replaced legacy boundary while the current carrier observation awaits', async () => {
    const f = await fixture(); let release!: () => void, response: Promise<any> | undefined
    const wait = new Promise<void>(resolve => { release = resolve })
    await writeLegacyBoundary(f)
    const capture = vi.spyOn(f.harness, 'captureWorkspaceRelocationProcesses').mockImplementation(async () => { await wait; return [] })
    try {
      response = f.call(); await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce())
      await writeLegacyBoundary(f, true, '2026-10-20T00:03:00.000Z'); release()
      expect((await response).error?.code).toBe('SERVICE_UNAVAILABLE'); expect(f.stop).not.toHaveBeenCalled()
    } finally { release(); await response?.catch(() => {}); await f.cleanup() }
  }, 30000)

  it('waits for actual Agent admissions to settle before reading CLI carriers', async () => {
    const f = await fixture()
    let release!: () => void, response: Promise<any> | undefined
    const wait = new Promise<void>(resolve => { release = resolve })
    const admission = f.agent.executionAdmissions.run(async () => { await wait })
    const drain = vi.spyOn(f.agent, 'quiesceExecutionAdmissions'), capture = vi.spyOn(f.harness, 'captureWorkspaceRelocationProcesses')
    try {
      response = f.call(); await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce())
      expect(capture).not.toHaveBeenCalled()
      await expect(f.agent.executionAdmissions.run(async () => {})).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      release(); await admission
      expect((await response).data).toEqual({ processes: [] })
      expect(capture).toHaveBeenCalledOnce()
    } finally { release(); await admission; await response?.catch(() => {}); await f.cleanup() }
  }, 30000)
  it('retains uncertainty if the actual MM revokes authority while Native observation is pending', async () => {
    const f = await fixture()
    let release!: () => void, response: Promise<any> | undefined
    const wait = new Promise<void>(resolve => { release = resolve })
    const capture = vi.spyOn(f.harness, 'captureWorkspaceRelocationProcesses').mockImplementation(async () => { await wait; return [] })
    try {
      response = f.call(); await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce())
      f.revoke(); release()
      expect((await response).error?.code).toBe('SERVICE_UNAVAILABLE')
      expect(f.records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id)).toBeNull()
      expect(f.stop).not.toHaveBeenCalled()
    } finally { release(); await response?.catch(() => {}); await f.cleanup() }
  }, 30000)
  it('does not publish a scope replaced during the final actual MM proof request', async () => {
    const f = await fixture('scope-change-on-second-proof')
    try {
      expect((await f.call()).error?.code).toBe('SERVICE_UNAVAILABLE')
      expect(f.records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id)).toBeNull()
      expect(f.stop).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  }, 30000)
  it.each(['missing header', 'body credential', 'extra pid', 'wrong job', 'revoked', 'missing scope', 'stop started', 'module stop started', 'not ready', 'closing'])('rejects before any process observation: %s', async mode => {
    const f = await fixture(mode === 'module stop started' ? 'module-stop-started' : 'normal'), capture = vi.spyOn(f.harness, 'captureWorkspaceRelocationProcesses')
    try {
      let params: any = f.params, bearer = f.options.bearer
      let expected = 'SERVICE_UNAVAILABLE'
      if (mode === 'missing header' || mode === 'body credential') { bearer = ''; params = { ...params, bearer: f.options.bearer }; expected = 'UNAUTHORIZED' }
      if (mode === 'extra pid') { params = { ...params, pids: [process.pid] }; expected = 'INVALID_PARAMS' }
      if (mode === 'wrong job') { params = { ...params, intent_id: randomUUID() }; expected = 'FORBIDDEN' }
      if (mode === 'revoked') f.revoke()
      if (mode === 'missing scope') await fs.rm(path.join(f.data, 'workspace-control/relocation-workers.json'))
      if (mode === 'stop started') await f.journal.prepare(f.scope)
      if (mode === 'module stop started') await f.moduleJournal.prepare([])
      if (mode === 'not ready') { f.harness.deps.isWorkspaceRelocationReady = () => false; expected = 'WORKSPACE_MAINTENANCE' }
      if (mode === 'closing') { f.agent.runtimeClosing = true; expected = 'WORKSPACE_MAINTENANCE' }
      const result = await f.call(params, bearer)
      expect(result.error?.code).toBe(expected)
      expect(capture).toHaveBeenCalledTimes(mode === 'not ready' ? 1 : 0); expect(f.stop).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  }, 30000)
})
