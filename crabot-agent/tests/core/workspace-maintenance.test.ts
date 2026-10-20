import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { UnifiedAgent } from '../../src/unified-agent.js'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { RpcError } from 'crabot-shared'
import { verifyWorkspaceRelocationAuthority } from '../../src/core/workspace-relocation-authority.js'
import type { LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import type { UnifiedAgentConfig } from '../../src/types.js'

vi.mock('../../src/core/workspace-relocation-authority.js', () => ({ verifyWorkspaceRelocationAuthority: vi.fn() }))

const config: UnifiedAgentConfig = {
  module_id: 'crabot-agent', module_type: 'agent', version: '0.2.0', protocol_version: '3.4.0', port: 19999,
  orchestration: { front_context_recent_messages_window_hours: 1, front_context_recent_messages_max_cap: 1, front_context_short_term_memory_window_hours: 1, front_context_short_term_memory_max_cap: 1, worker_recent_messages_window_hours: 1, worker_recent_messages_max_cap: 1, worker_short_term_memory_window_hours: 1, worker_short_term_memory_max_cap: 1, worker_long_term_memory_limit: 1, front_agent_timeout: 1, session_state_ttl: 1, worker_config_refresh_interval: 1, front_agent_queue_max_length: 1, front_agent_queue_timeout: 1 },
  agent_config: { instance_id: 'crabot-agent', roles: [], system_prompt: 'fixture', model_config: { powerful: { endpoint: 'https://fixture.invalid', apikey: 'fixture', model_id: 'fixture', format: 'openai', provider_id: 'fixture' } } },
}

describe.each(['relocation.json', 'relocation-workers.json'])('workspace maintenance execution admission: %s', record => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('blocks messages, schedules, and Harness dispatch before metadata or ledger writes', async () => {
    const data = await fs.mkdtemp(path.join(tmpdir(), 'crabot-agent-workspace-gate-'))
    vi.stubEnv('DATA_DIR', data); vi.stubEnv('CRABOT_AGENT_DATA_DIR', path.join(data, 'agent'))
    const agent = new UnifiedAgent(config) as any
    const ledgerWrite = vi.spyOn(agent.managerStack.ledger, 'upsertWorker')
    const route = vi.spyOn(agent.managerStack.registry, 'routeSchedule')
    try {
      agent.assertRuntimeExecutionAdmission()
      await fs.mkdir(path.join(data, 'workspace-control'), { recursive: true })
      await fs.writeFile(path.join(data, 'workspace-control', record), 'fixed job')
      await expect(agent.handleMessageReceived({ crab_display_name: 'must not cache' })).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      await expect(agent.handleTriggerSchedule({ schedule_id: 'script' })).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      await expect(agent.managerStack.harness.sendToWorker('old', 'new input')).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      await expect(agent.managerStack.harness.spawnWorker({ managerKey: 'admin-web::admin-chat', title: 'new', prompt: 'new',
        origin: { trigger_type: 'human' }, report_to: { channel_id: 'admin-web', session_id: 'admin-chat' },
      })).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      expect(agent.crabDisplayNames.size).toBe(0)
      expect(ledgerWrite).not.toHaveBeenCalled(); expect(route).not.toHaveBeenCalled()
    } finally { await agent.managerStack.dispose(); await fs.rm(data, { recursive: true, force: true }) }
  })

  it('blocks direct Manager ingress, late notifications, and queued wakes without creating an episode', async () => {
    const data = await fs.mkdtemp(path.join(tmpdir(), 'crabot-manager-workspace-gate-'))
    vi.stubEnv('DATA_DIR', data); vi.stubEnv('CRABOT_AGENT_DATA_DIR', path.join(data, 'agent'))
    const agent = new UnifiedAgent(config) as any, registry = agent.managerStack.registry
    const loop = vi.spyOn(registry, 'getOrCreate')
    try {
      await fs.mkdir(path.join(data, 'workspace-control'), { recursive: true })
      await fs.writeFile(path.join(data, 'workspace-control', record), '{}')
      await expect(registry.routeHumanMessages('admin-web', 'admin-chat', [])).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      await expect(registry.routeMediaNotification({ channelId: 'admin-web', sessionId: 'admin-chat', text: 'late' })).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      await expect(registry.runWake('admin-web::admin-chat', undefined)).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      expect(loop).not.toHaveBeenCalled()
      // Protection does not fabricate closure or make a display inventory prove a verified stop.
      expect((await agent.managerStack.harness.getWorkspaceExecutionInventory()).ready).toBe(false)
    } finally { await agent.managerStack.dispose(); await fs.rm(data, { recursive: true, force: true }) }
  })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function captureFixture() {
  const data = await fs.mkdtemp(path.join(tmpdir(), 'crabot-agent-workspace-capture-'))
  vi.stubEnv('DATA_DIR', data); vi.stubEnv('CRABOT_AGENT_DATA_DIR', path.join(data, 'agent'))
  const agent = new UnifiedAgent(config) as any, harness = agent.managerStack.harness
  harness.deps.isWorkspaceRelocationReady = () => true
  const params = { intent_id: randomUUID(), launch_id: randomUUID() }
  const proof = { verified: true as const, ...params, intent_sha256: 'a'.repeat(64), launch_sha256: 'b'.repeat(64), action: 'capture_workers' as const }
  const verify = vi.mocked(verifyWorkspaceRelocationAuthority).mockReset().mockResolvedValue(proof)
  const server = http.createServer((req, res) => { void agent.handleRequest(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/capture_workspace_relocation_workers`
  const call = async (body = params, bearer = 'fixed-job') => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
      body: JSON.stringify({ id: randomUUID(), source: 'forged-admin', method: 'capture_workspace_relocation_workers', params: body }) })
    return response.json() as Promise<any>
  }
  return { data, agent, harness, params, proof, verify, call, cleanup: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await agent.managerStack.dispose(); await fs.rm(data, { recursive: true, force: true })
  } }
}

describe('fixed coordinator capture RPC', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('does not accept source or a body credential in place of an Authorization header', async () => {
    const f = await captureFixture(), drain = vi.spyOn(f.agent, 'quiesceExecutionAdmissions')
    try {
      const response = await f.call({ ...f.params, bearer: 'fixed-job' } as any, '')
      expect(response.error?.code).toBe('UNAUTHORIZED')
      expect(f.verify).not.toHaveBeenCalled(); expect(drain).not.toHaveBeenCalled()
      await expect(f.agent.executionAdmissions.run(async () => 'still open')).resolves.toBe('still open')
    } finally { await f.cleanup() }
  })

  it('rejects unknown credentials before quiescence', async () => {
    const f = await captureFixture(), drain = vi.spyOn(f.agent, 'quiesceExecutionAdmissions')
    try {
      f.verify.mockRejectedValue(new RpcError('FORBIDDEN', 'unknown job'))
      expect((await f.call()).error?.code).toBe('FORBIDDEN')
      expect(drain).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })

  it.each(['action', 'worker_id', 'target'])('refuses an extra %s field without silently widening the RPC', async field => {
    const f = await captureFixture(), drain = vi.spyOn(f.agent, 'quiesceExecutionAdmissions')
    try {
      expect((await f.call({ ...f.params, [field]: 'extra' } as any)).error?.code).toBe('INVALID_PARAMS')
      expect(f.verify).not.toHaveBeenCalled(); expect(drain).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })

  it('drains a real admitted operation, then returns all stable identities without changing task state or origin', async () => {
    const f = await captureFixture(), finish = deferred(), entered = deferred()
    const admission = f.agent.executionAdmissions.run(async () => { entered.resolve(); await finish.promise })
    const drain = vi.spyOn(f.agent, 'quiesceExecutionAdmissions')
    try {
      await entered.promise
      for (const id of ['closed', 'native']) {
        const worker: LedgerWorker = {
        worker_id: id, manager_key: 'channel::session', task: { id, title: 'private task', status: id === 'closed' ? 'closed' : 'halted', created_at: new Date().toISOString(), input: { secret: 'private' } },
        origin: { trigger_type: 'message', creator_friend_id: 'unchanged' }, report_to: { channel_id: 'channel', session_id: 'session' },
        incarnations: id === 'closed' ? [{ incarnation_id: 'old-inc', impl: 'legacy', seq: 1, state: 'exited', workspace: path.join(f.data, 'old'), started_at: new Date().toISOString(), ended_at: new Date().toISOString(), ended_reason: 'pre_migration' }] : [], updated_at: new Date().toISOString(),
        }
        if (id === 'closed') {
          worker.legacy_source = { kind: 'v2_admin_task', admin_task_id: id, imported_at: new Date().toISOString(), trace_ids: [] }
          await f.agent.managerStack.ledger.importLegacyWorker('channel::session', worker)
        } else await f.agent.managerStack.ledger.upsertWorker('channel::session', id, () => worker)
      }
      const before = await f.agent.managerStack.ledger.listAllWorkers()
      let settled = false
      const response = f.call().then(value => { settled = true; return value })
      await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce())
      expect(settled).toBe(false); expect(f.verify).toHaveBeenCalledOnce()
      await expect(f.agent.executionAdmissions.run(async () => {})).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      finish.resolve(); await admission
      const value = await response
      expect(value.success).toBe(true)
      expect(value.data.workers.map((worker: any) => worker.worker_id)).toEqual(['closed', 'native'])
      expect(value.data.workers[0].incarnations[0].impl).toBe('legacy')
      expect(value.data.workers[1].incarnations).toEqual([])
      expect(JSON.stringify(value)).not.toMatch(/private task|creator_friend_id|fixed-job/)
      expect(await f.agent.managerStack.ledger.listAllWorkers()).toEqual(before)
      expect(f.verify).toHaveBeenCalledTimes(2)
      for (const [options] of f.verify.mock.calls) expect(options.params).toEqual({ ...f.params, action: 'capture_workers' })
    } finally { finish.resolve(); await admission; await f.cleanup() }
  })

  it('does not return success after credentials are revoked during drainage and keeps admission closed', async () => {
    const f = await captureFixture(), finish = deferred(), drain = vi.spyOn(f.agent, 'quiesceExecutionAdmissions')
    const admission = f.agent.executionAdmissions.run(async () => { await finish.promise })
    try {
      f.verify.mockResolvedValueOnce(f.proof).mockRejectedValue(new RpcError('FORBIDDEN', 'revoked'))
      const response = f.call()
      await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce())
      finish.resolve(); await admission
      expect((await response).error?.code).toBe('FORBIDDEN')
      await expect(f.agent.executionAdmissions.run(async () => {})).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
    } finally { finish.resolve(); await admission; await f.cleanup() }
  })

  it('does not turn unfinished startup reconciliation into an empty successful scope', async () => {
    const f = await captureFixture()
    try {
      f.harness.deps.isWorkspaceRelocationReady = () => false
      expect((await f.call()).error?.code).toBe('WORKSPACE_MAINTENANCE')
      expect(f.verify).toHaveBeenCalledOnce()
    } finally { await f.cleanup() }
  })

  it('refuses a changed fixed proof after drainage', async () => {
    const f = await captureFixture()
    try {
      f.verify.mockResolvedValueOnce(f.proof).mockResolvedValue({ ...f.proof, intent_sha256: 'c'.repeat(64) })
      expect((await f.call()).error?.code).toBe('FORBIDDEN')
      await expect(f.agent.executionAdmissions.run(async () => {})).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
    } finally { await f.cleanup() }
  })

  it('rejects shutdown before freezing anything', async () => {
    const f = await captureFixture(), drain = vi.spyOn(f.agent, 'quiesceExecutionAdmissions')
    try {
      f.agent.runtimeClosing = true
      expect((await f.call()).error?.code).toBe('WORKSPACE_MAINTENANCE')
      expect(drain).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })
})
