import { afterEach, describe, it, expect, vi } from 'vitest'
import http from 'node:http'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { captureWorkspaceRelocationWorkers } from '../../src/workers/harness/workspace-relocation-scope.js'
import type { LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import { relocationMmFixture } from './fixtures/relocation-mm.js'
import { relocationAgentConfig } from './fixtures/relocation-agent-config.js'

async function fixture(mode = 'normal') {
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
      incarnations: [{ incarnation_id: 'inc', impl: 'builtin', seq: 1, state: 'running', workspace: path.join(mm.data, 'project'), session_ref: 'fixture', started_at: at }], updated_at: at }
    await agent.managerStack.ledger.upsertWorker('channel::session', 'worker', () => worker)
    const before = await agent.managerStack.ledger.listAllWorkers(), scope = captureWorkspaceRelocationWorkers(before)
    await mm.journal.capture(scope)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const params = { intent_id: mm.intent.id, launch_id: mm.launch.launch_id }
    const call = async (body = params, bearer = mm.options.bearer) => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/stop_workspace_relocation_workers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
        body: JSON.stringify({ id: randomUUID(), source: 'module-manager', method: 'stop_workspace_relocation_workers', params: body }),
      })
      return response.json() as Promise<any>
    }
    return { ...mm, agent, harness, params, stop, before, scope, call, cleanup }
  } catch (error) { await cleanup(); throw error }
}

describe('Agent fixed relocation stop RPC with real private journal and HTTP', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
  it('submits only once, retains source/delivery/task truth, and never labels the receipt an exit or closure', async () => {
    const f = await fixture()
    try {
      const first = await f.call(), again = await f.call()
      expect(first.success).toBe(true); expect(again.data).toEqual(first.data)
      expect(first.data).toEqual({ dispatch: 'dispatch', results: [{ worker_id: 'worker', incarnation_id: 'inc', status: 'submitted' }] })
      expect(f.stop).toHaveBeenCalledOnce()
      expect(await f.agent.managerStack.ledger.listAllWorkers()).toEqual(f.before)
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).submission.results).toEqual(first.data.results)
      expect(f.calls.filter(call => call.body.method === 'prepare_workspace_relocation_worker_stops')).toHaveLength(1)
      expect(f.calls.filter(call => call.body.method === 'complete_workspace_relocation_worker_stops')).toHaveLength(1)
      expect(JSON.stringify(first)).not.toMatch(/private task|creator_friend_id|closed|exit/)
    } finally { await f.cleanup() }
  }, 30000)
  it('waits for an actual Agent admission before registering stops and keeps later admissions closed', async () => {
    const f = await fixture()
    let finish!: () => void, response: Promise<any> | undefined
    const pending = new Promise<void>(resolve => { finish = resolve })
    const admission = f.agent.executionAdmissions.run(async () => { await pending })
    const drain = vi.spyOn(f.agent, 'quiesceExecutionAdmissions')
    try {
      response = f.call()
      await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce())
      expect(f.stop).not.toHaveBeenCalled()
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
      await expect(f.agent.executionAdmissions.run(async () => {})).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      finish(); await admission
      expect((await response).success).toBe(true)
      expect(f.stop).toHaveBeenCalledOnce()
    } finally { finish(); await admission; await response?.catch(() => {}); await f.cleanup() }
  }, 30000)
  it('retains uncertainty when authorization is revoked while the first adapter stop is still settling', async () => {
    const f = await fixture()
    let finish!: () => void, response: Promise<any> | undefined
    const pending = new Promise<void>(resolve => { finish = resolve })
    f.stop.mockImplementation(async () => { await pending })
    try {
      response = f.call()
      await vi.waitFor(() => expect(f.stop).toHaveBeenCalledOnce())
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).not.toBeNull()
      f.revoke(); finish()
      expect((await response).error?.code).toBe('SERVICE_UNAVAILABLE')
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).submission).toBeNull()
      expect((await f.call()).success).toBe(false)
      expect(f.stop).toHaveBeenCalledOnce()
      expect(await f.agent.managerStack.ledger.listAllWorkers()).toEqual(f.before)
    } finally { finish(); await response?.catch(() => {}); await f.cleanup() }
  }, 30000)
  it('observes a previously registered attempt without dispatching stops or fabricating a complete receipt', async () => {
    const f = await fixture()
    try {
      await f.journal.prepare(f.scope)
      expect((await f.call()).data).toEqual({ dispatch: 'observe', results: [] })
      expect(f.stop).not.toHaveBeenCalled()
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).submission).toBeNull()
      expect(await f.agent.managerStack.ledger.listAllWorkers()).toEqual(f.before)
    } finally { await f.cleanup() }
  }, 30000)
  for (const mode of ['false-prepare', 'extra-prepare', 'revoke-prepare', 'drop-prepare', 'scope-change-prepare']) it(`never dispatches after an unverified preparation: ${mode}`, async () => {
    const f = await fixture(mode)
    try {
      expect((await f.call()).error?.code).toBe('SERVICE_UNAVAILABLE')
      expect((await f.call()).success).toBe(false)
      expect(f.stop).not.toHaveBeenCalled()
      expect(f.calls.filter(call => call.body.method === 'prepare_workspace_relocation_worker_stops')).toHaveLength(1)
      expect(await f.agent.managerStack.ledger.listAllWorkers()).toEqual(f.before)
    } finally { await f.cleanup() }
  }, 30000)
  for (const mode of ['false-complete', 'drop-complete']) it(`retains the first stopping Promise after uncertain completion: ${mode}`, async () => {
    const f = await fixture(mode)
    try {
      expect((await f.call()).error?.code).toBe('SERVICE_UNAVAILABLE')
      expect((await f.call()).success).toBe(false)
      expect(f.stop).toHaveBeenCalledOnce()
      expect(f.calls.filter(call => call.body.method === 'complete_workspace_relocation_worker_stops')).toHaveLength(1)
      expect(await f.agent.managerStack.ledger.listAllWorkers()).toEqual(f.before)
    } finally { await f.cleanup() }
  }, 30000)
  for (const mode of ['missing header', 'extra field', 'startup not ready', 'shutdown']) it(`refuses before stopping any Worker: ${mode}`, async () => {
    const f = await fixture()
    try {
      let body: any = f.params, bearer = f.options.bearer, code = 'WORKSPACE_MAINTENANCE'
      if (mode === 'missing header') { body = { ...body, token: bearer }; bearer = ''; code = 'UNAUTHORIZED' }
      else if (mode === 'extra field') { body = { ...body, worker_id: 'replacement' }; code = 'INVALID_PARAMS' }
      else if (mode === 'startup not ready') f.harness.deps.isWorkspaceRelocationReady = () => false
      else f.agent.runtimeClosing = true
      expect((await f.call(body, bearer)).error?.code).toBe(code)
      expect(f.stop).not.toHaveBeenCalled()
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
    } finally { await f.cleanup() }
  }, 30000)
})
