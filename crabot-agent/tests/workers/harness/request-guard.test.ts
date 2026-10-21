import { WorkerRequestToolScope } from '../../../src/workers/harness/request-tools.js'
import { authorizeTool, fileAuthorization, entryAuthorization, roleAuthorization } from '../../../src/permissions/tool-authorization.js'
import { defineTool } from '../../../src/engine/index.js'
import { buildWorkerTools } from '../../../src/manager/tools/worker-tools.js'
import { UnifiedAgent } from '../../../src/unified-agent.js'
import { WorkerHarness } from '../../../src/workers/harness/harness.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allowed, checkFileAccess, denied } from '../../../src/permissions/tool-authorization.js'
import { TrustedHumanInputStore } from '../../../src/manager/trusted-human-input-store.js'
import { ConversationRequestStore } from '../../../src/manager/conversation-request-store.js'
import { ConversationRequestAuthority } from '../../../src/manager/conversation-request-authority.js'
import { WorkerRequestGuard } from '../../../src/workers/harness/request-guard.js'
import { WorkerContextStore } from '../../../src/workers/harness/context-store.js'
import { LedgerStore } from '../../../src/workers/harness/ledger-store.js'
import type { ChannelMessage, Friend } from '../../../src/types.js'
import type { ConversationRequestSource, RequestPermissionSource } from '../../../src/manager/request-permission-sources.js'

const key = 'voice::shared' as const
const time = '2026-10-16T00:00:00.000Z'
const message = (id: string, who: string, text = 'Perform this request'): ChannelMessage => ({ platform_message_id: id, session: { channel_id: 'voice', session_id: 'shared', type: 'group' }, sender: { platform_user_id: who, platform_display_name: who }, content: { type: 'text', text }, features: { is_mention_crab: true }, platform_timestamp: time })
describe('Worker request guard never borrows a neighbouring speaker or legacy snapshot', () => {
  let root: string, sourceStore: TrustedHumanInputStore, requests: ConversationRequestStore, contexts: WorkerContextStore, ledger: LedgerStore, guard: WorkerRequestGuard
  let people: Map<string, Friend>, current: ReturnType<typeof vi.fn>, group: RequestPermissionSource, ownerRequest: string
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-request-guard-')); await fs.mkdir(path.join(root, 'a')); await fs.mkdir(path.join(root, 'b'))
    people = new Map(['owner', 'peer', 'master'].map(who => [who, { id: who, display_name: who, permission: who === 'peer' ? 'normal' : 'master', created_at: time, updated_at: time, channel_identities: [{ channel_id: 'voice', platform_user_id: who }] } as Friend]))
    const perms = { tool_access: { memory: true, messaging: true, task: true, mcp_skill: true, file_io: true, browser: true, shell: true, remote_exec: true, desktop: true }, cli_access: { provider: 'write', agent: 'write', mcp: 'write', skill: 'write', schedule: 'write', channel: 'write', friend: 'write', permission: 'write', config: 'write', undo: 'write' }, storage: { workspace_path: path.join(root, 'a'), access: 'read' }, memory_scopes: [] } as const
    group = { kind: 'group', subject_id: key, is_master: false, resolved: structuredClone(perms) as never }
    current = vi.fn(async (kind: 'group' | 'friend', origin: ConversationRequestSource) => {
      if (kind === 'group') return group
      const friend = people.get(origin.platform_user_id)
      if (!friend || friend.id !== origin.sender_friend_id || !friend.channel_identities.some(ci => ci.channel_id === origin.channel_id && ci.platform_user_id === origin.platform_user_id)) return null
      const resolved = structuredClone(perms) as RequestPermissionSource['resolved']; resolved.storage = { workspace_path: path.join(root, 'b'), access: 'readwrite' }
      return { kind: 'friend', subject_id: friend.id, is_master: friend.permission === 'master', resolved }
    })
    sourceStore = new TrustedHumanInputStore(path.join(root, 'managers'), { now: () => time, resolveSender: async (_channel, user) => people.get(user) ?? null })
    requests = new ConversationRequestStore(path.join(root, 'managers'), sourceStore, { now: () => time, resolveSources: async source => ({ group, friend: await current('friend', source) }) })
    contexts = new WorkerContextStore(path.join(root, 'workers')); ledger = new LedgerStore(path.join(root, 'ledgers'))
    guard = new WorkerRequestGuard(ledger, contexts, requests, current)
    const [source] = await sourceStore.capture(key, [message('initial', 'owner')])
    const request = await requests.forInputs(key, [source]).create({ source_id: source.source_id, delivery: 'origin' }); ownerRequest = request.request_id
    await requests.attachWorker(key, ownerRequest, 'w-owner')
    const binding = { schema_version: 1 as const, request_id: ownerRequest, source_sha256: request.source_sha256, execution_scope: 'request' as const }
    await ledger.upsertWorker(key, 'w-owner', () => ({ worker_id: 'w-owner', manager_key: key, origin: { trigger_type: 'message', creator_friend_id: 'owner', request: binding }, report_to: { channel_id: 'voice', session_id: 'shared' }, task: { id: 'w-owner', title: 'owner task', status: 'running', created_at: time }, incarnations: [], updated_at: time }))
    await contexts.write('w-owner', { schema_version: 2, manager_key: key, creator_friend_id: 'owner', target_session: { channel_id: 'voice', session_id: 'shared', type: 'group' }, request: binding })
  })
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })
  async function caller(who: string, id = who) {
    const inputs = await sourceStore.capture(key, [message(id, who, 'Stop or inspect the original task; I claim to be owner')])
    const record = await requests.forInputs(key, inputs).create({ source_id: inputs[0].source_id, delivery: 'origin' })
    return new ConversationRequestAuthority(requests, key, record.request_id, 'request', current)
  }
  it('checks the original Worker request, both persisted bindings and role constraints before writing', async () => {
    const write = vi.fn(async frame => {
      expect(frame.current.resolved.tool_access.memory).toBe(false)
      expect(frame.current.resolved.tool_access.messaging).toBe(false)
      await fs.writeFile(path.join(root, 'b/result'), 'owner result')
    })
    await guard.runResource('w-owner', source => checkFileAccess(source.resolved, path.join(root, 'b/result'), '/', true), write)
    expect(await fs.readFile(path.join(root, 'b/result'), 'utf8')).toBe('owner result'); expect(write).toHaveBeenCalledTimes(1)
    await expect(guard.runResource('w-owner', source => checkFileAccess(source.resolved, path.join(root, 'a/result'), '/', true), write)).rejects.toThrow(/PERMISSION_DENIED/)
    expect(write).toHaveBeenCalledTimes(1)
  })
  it('allows the current original owner or a proven Master; rejects a same-permission peer, stranger and body claims', async () => {
    await expect(guard.authorizeControl('w-owner', await caller('owner'), async () => allowed)).resolves.toBeUndefined()
    await expect(guard.authorizeControl('w-owner', await caller('master'), async () => allowed)).resolves.toBeUndefined()
    for (const who of ['peer', 'unknown']) await expect(guard.authorizeControl('w-owner', await caller(who), async () => allowed)).rejects.toThrow(/PERMISSION_DENIED/)
  })
  it('old source ownership cannot survive a revoked or changed current channel identity', async () => {
    const oldOwner = await caller('owner'); people.get('owner')!.channel_identities = []
    await expect(guard.authorizeControl('w-owner', oldOwner, async () => allowed)).rejects.toThrow(/PERMISSION_DENIED|CAPABILITY_UNKNOWN/)
    const oldMaster = await caller('master'); people.get('master')!.permission = 'normal'
    await expect(guard.authorizeControl('w-owner', oldMaster, async () => allowed)).rejects.toThrow(/PERMISSION_DENIED/)
  })
  it('later role grants never promote an old peer source into Master control', async () => {
    const peer = await caller('peer'); people.get('peer')!.permission = 'master'
    await expect(guard.authorizeControl('w-owner', peer, async () => allowed)).rejects.toThrow(/PERMISSION_DENIED/)
    await expect(guard.authorizeControl('w-owner', await caller('peer', 'new-master-message'), async () => allowed)).resolves.toBeUndefined()
  })
  it('keeps public group collaboration while personal internals require the isolated context', async () => {
    const found = (await ledger.findWorker('w-owner'))!.worker
    const publicBinding = { ...found.origin.request!, execution_scope: 'group' as const }
    await requests.attachWorker(key, ownerRequest, 'w-public')
    await ledger.upsertWorker(key, 'w-public', () => ({ ...found, worker_id: 'w-public', task: { ...found.task, id: 'w-public' }, origin: { ...found.origin, request: publicBinding } }))
    await contexts.write('w-public', { schema_version: 2, manager_key: key, creator_friend_id: 'owner', target_session: { channel_id: 'voice', session_id: 'shared', type: 'group' }, request: publicBinding })
    await expect(guard.authorizeControl('w-public', await caller('peer'), async () => allowed)).resolves.toBeUndefined()
    const execute = vi.fn(async () => 'unexpected')
    await expect(guard.runResource('w-public', source => checkFileAccess(source.resolved, path.join(root, 'b/result'), '/', true), execute)).rejects.toThrow(/PERMISSION_DENIED/)
    await expect(guard.runResource('w-owner', async source => source.resolved.tool_access.memory ? allowed : denied('PERMISSION_DENIED', 'Worker Memory forbidden'), execute)).rejects.toThrow(/PERMISSION_DENIED/)
    const owner = await caller('owner', 'shared-owner-control')
    // A real owner still cannot put a personal task's raw internals into shared history.
    const [origin] = (await sourceStore.list(key)).filter(input => input.message.platform_message_id === 'shared-owner-control')
    const record = await requests.forInputs(key, [origin]).create({ source_id: origin.source_id, delivery: 'origin' })
    const shared = new ConversationRequestAuthority(requests, key, record.request_id, 'group', current)
    await expect(guard.authorizeControl('w-owner', shared, async () => allowed)).rejects.toThrow('REQUEST_CONTEXT_REQUIRED')
    await expect(guard.authorizeControl('w-owner', owner, async () => allowed)).resolves.toBeUndefined()
    expect(execute).not.toHaveBeenCalled()
  })
  it('checks current authority and closed request state for every new Worker resource action', async () => {
    const action = vi.fn(async () => 'unexpected')
    await requests.close(key, ownerRequest)
    await expect(guard.runResource('w-owner', async () => allowed, action)).rejects.toThrow(/closed/)
    expect(action).not.toHaveBeenCalled()
  })
  it('lost, changed or half-written bindings fail closed and are never treated as legacy', async () => {
    const file = path.join(root, 'workers/w-owner/context.json'), valid = await fs.readFile(file, 'utf8')
    for (const mutate of [(v: any) => delete v.request, (v: any) => v.request.request_id = 'c'.repeat(64), (v: any) => v.creator_friend_id = 'peer', (v: any) => v.request.source_sha256 = 'c'.repeat(64)]) {
      const value = JSON.parse(valid); mutate(value); await fs.writeFile(file, JSON.stringify(value))
      await expect(guard.load('w-owner')).rejects.toThrow()
    }
    await fs.rm(file)
    await expect(guard.load('w-owner')).rejects.toThrow(/binding|context/i)
  })
  function resourceHarness() {
    const harness = Object.create(WorkerHarness.prototype) as WorkerHarness
    Object.assign(harness, { deps: { ledger, requestGuard: () => guard }, contextStore: contexts })
    return harness
  }
  async function activeExecution() {
    await ledger.upsertWorker(key, 'w-owner', prev => ({ ...prev!, incarnations: [{ incarnation_id: 'inc-owner', seq: 1, impl: 'builtin', state: 'idle', workspace: path.join(root, 'b'), session_ref: 'session-owner', started_at: time }] }))
    return { kind: 'worker' as const, worker_id: 'w-owner', incarnation_id: 'inc-owner' }
  }
  it('CLI gateway requires Shell plus requested domain/access from the same original and current source', async () => {
    const execution = await activeExecution(), harness = resourceHarness()
    expect(await harness.authorizeAgentCliExecution(execution, 'schedule', 'write')).toMatchObject({ request_verified: true, shell: true, cli_access: 'write' })
    // Group supplies Shell, current friend supplies CLI; neither supplies the complete action.
    const originalCurrent = current.getMockImplementation()!
    group.resolved.cli_access.schedule = 'none'
    current.mockImplementation(async (kind, source) => {
      const result = await originalCurrent(kind, source)
      if (result?.kind === 'friend') result.resolved.tool_access.shell = false
      return result
    })
    await expect(harness.authorizeAgentCliExecution(execution, 'schedule', 'write')).rejects.toThrow('PERMISSION_DENIED')
    current.mockImplementation(async () => { throw new Error('unavailable') })
    await expect(harness.authorizeAgentCliExecution(execution, 'schedule', 'write')).rejects.toThrow('CAPABILITY_UNKNOWN')
  })
  it('CLI authority rechecks exact execution after asynchronous authorization without reopening a closed Worker', async () => {
    const execution = await activeExecution(), harness = resourceHarness()
    const originalCurrent = current.getMockImplementation()!
    current.mockImplementation(async (kind, source) => {
      const result = await originalCurrent(kind, source)
      await ledger.upsertWorker(key, 'w-owner', prev => ({ ...prev!, task: { ...prev!.task, status: 'closed' } }))
      return result
    })
    await expect(harness.authorizeAgentCliExecution(execution, 'schedule', 'read')).rejects.toThrow(/FORBIDDEN|closed/)
    expect((await ledger.findWorker('w-owner'))!.worker.task.status).toBe('closed')
  })
  it('CLI authority never falls back on half bindings', async () => {
    const execution = await activeExecution(), harness = resourceHarness()
    await fs.rm(path.join(root, 'workers/w-owner/context.json'))
    await expect(harness.authorizeAgentCliExecution(execution, 'schedule', 'read')).rejects.toThrow('CAPABILITY_UNKNOWN')
  })
  it('production builtin tool assembly uses request scopes for real file writes and live Shell/CLI hooks', async () => {
    const runtimeAgent = Object.create(UnifiedAgent.prototype) as any
    Object.assign(runtimeAgent, { agentHandler: { createBuiltinBgToolOptions: () => undefined }, agentConfig: { skills: [{ id: 'tmp-page', name: 'tmp-page', description: 'page', skill_dir: path.join(root, 'skills') }], model_config: { powerful: { endpoint: 'https://example.invalid', apikey: 'test', model_id: 'test', format: 'anthropic' } } },
      mcpConnector: { getAllTools: () => [] }, computerUseOwner: { available: false }, imageCapability: { available: false }, config: { moduleId: 'test' }, knownSecrets: new Set() })
    const fixed = (await requests.get(key, ownerRequest))!
    const ctx = { worker_id: 'w-owner', workspace: { root: path.join(root, 'b') }, origin: (await ledger.findWorker('w-owner'))!.worker.origin,
      principal_permissions: group.resolved, request_runtime: { guard, ceilings: [fixed.record.permission_sources.group, fixed.record.permission_sources.friend!] } }
    const runtime = runtimeAgent.buildBuiltinWorkerRuntime(ctx)
    const tools = runtime.tools(), write = tools.find((tool: any) => tool.name === 'Write')
    const file = path.join(root, 'b/real-production-result')
    expect((await write.call({ file_path: file, content: 'verified' }, {})).isError).not.toBe(true)
    expect(await fs.readFile(file, 'utf8')).toBe('verified')
    expect((await write.call({ file_path: path.join(root, 'a/no-write'), content: 'bad' }, {})).isError).toBe(true)
    expect(await runtime.requestCliAuthorization({ event: 'PreToolUse', toolName: 'Bash', toolInput: { command: 'crabot schedule list' } })).toMatchObject({ action: 'continue' })
    expect(await runtime.requestCliAuthorization({ event: 'PreToolUse', toolName: 'Bash', toolInput: { command: 'crabot config get --reveal' } })).toMatchObject({ action: 'block' })
    group.resolved.tool_access.shell = false
    const oldCurrent = current.getMockImplementation()!
    current.mockImplementation(async (kind, source) => { const result = await oldCurrent(kind, source); if (result) result.resolved.tool_access.shell = false; return result })
    expect(await runtime.requestCliAuthorization({ event: 'PreToolUse', toolName: 'Bash', toolInput: { command: 'printf no' } })).toMatchObject({ action: 'block' })
    expect(() => runtimeAgent.buildBuiltinWorkerRuntime({ ...ctx, request_runtime: undefined })).toThrow('CAPABILITY_UNKNOWN')
  })
  it('does not enter a resource after the Worker is closed while current authorization was being fetched', async () => {
    const originalCurrent = current.getMockImplementation()!
    current.mockImplementation(async (kind, source) => {
      const result = await originalCurrent(kind, source)
      await ledger.upsertWorker(key, 'w-owner', prev => ({ ...prev!, task: { ...prev!.task, status: 'closed' } }))
      return result
    })
    const action = vi.fn()
    await expect(guard.runResource('w-owner', async () => allowed, action)).rejects.toThrow('closed')
    expect(action).not.toHaveBeenCalled()
  })
  it('the live desktop bridge checks the same immutable request and current authorization on every call', async () => {
    await activeExecution()
    const runtimeAgent = Object.create(UnifiedAgent.prototype) as any
    runtimeAgent.managerStack = { ledger, requestGuard: guard }
    expect(await runtimeAgent.desktopWorkerCurrent('w-owner', 'inc-owner')).toBe(true)
    const originalCurrent = current.getMockImplementation()!
    current.mockImplementation(async (kind, source) => { const result = await originalCurrent(kind, source); if (result) result.resolved.tool_access.desktop = false; return result })
    expect(await runtimeAgent.desktopWorkerCurrent('w-owner', 'inc-owner')).toBe(false)
    current.mockImplementation(async () => { throw new Error('unavailable') })
    expect(await runtimeAgent.desktopWorkerCurrent('w-owner', 'inc-owner', false)).toBe(false)
    current.mockImplementation(originalCurrent)
    await requests.close(key, ownerRequest)
    expect(await runtimeAgent.desktopWorkerCurrent('w-owner', 'inc-owner')).toBe(false)
  })
  it('the actual send/query tools retain a host-only recheck of the caller across asynchronous preparation', async () => {
    const { tools, action } = toolFixture(await caller('owner', 'queued-control'))
    for (const name of ['send_to_worker', 'query_worker']) {
      action.mockResolvedValue({ status: 'delivered' })
      await tools.find(tool => tool.name === name)!.call({ worker_id: 'w-owner', text: 'continue', question: 'inspect' })
      const options = action.mock.calls.at(-1)![2] as any
      expect(options.authorize).toBeTypeOf('function')
      people.get('owner')!.channel_identities = []
      await expect(options.authorize()).rejects.toThrow('PERMISSION_DENIED')
      people.get('owner')!.channel_identities = [{ channel_id: 'voice', platform_user_id: 'owner' }]
    }
  })
  const guardedOperations = [
    ['send_to_worker', { text: 'dangerous redirect' }], ['query_worker', { question: 'read private result' }],
    ['get_worker_state', {}], ['get_worker_activity', {}], ['get_worker_turn', {}],
    ['request_worker_interrupt', {}], ['request_worker_stop', {}],
    ['respond_to_worker_ui', { snapshot_id: 'snapshot', action_id: 'confirm' }],
    ['resolve_worker_turn', { turn_id: 'turn', resolution: 'suppressed', reason: 'verified no delivery' }],
    ['get_worker_terminal', {}], ['get_worker_detail', {}], ['inspect_workspace_git', {}],
    ['list_worker_subagents', {}], ['get_worker_subagent_detail', { subagent_id: 'child' }], ['get_worker_subagent_trace', { subagent_id: 'child' }],
  ] as const
  function toolFixture(authority: ConversationRequestAuthority, scope: 'shared' | 'request' = 'request') {
    const action = vi.fn(async () => ({ status: 'delivered', summary: 'OWNER_PRIVATE_RESULT' }))
    const harness = { findWorker: (id: string) => ledger.findWorker(id), listWorkers: (key: any) => ledger.listWorkers(key), workerView: async (workers: any[]) => ({ executing: workers, candidates: [], attention: [], history: [], excludedIdle: [] }),
      sendToWorker: action, queryWorker: action, getWorkerTerminal: action, getWorkerTurn: action, getWorkerControlOperations: action, getWorkerExecutionObservation: action, requestWorkerInterrupt: action, requestWorkerStop: action, respondToWorkerUi: action, resolveWorkerTurn: action, inspectWorkspaceGit: action,
    } as unknown as WorkerHarness
    const tools = buildWorkerTools({ harness, context: () => ({ managerKey: key, reportTo: { channel_id: 'voice', session_id: 'shared' }, principalPermissions: group.resolved }), requestGuard: guard,
      requestControl: { scope, authority: async () => authority }, readWorkerActivity: action as never, readWorkerSubagents: action as never, readWorkerSubagentDetail: action as never, readWorkerSubagentTrace: action as never,
    })
    return { action, tools, harness }
  }
  it.each(guardedOperations)('rejects a same-template peer at the real %s entry before reading/controlling any private task', async (name, args) => {
    const { tools, action } = toolFixture(await caller('peer', `peer-${name}`))
    const result = await tools.find(tool => tool.name === name)!.call({ worker_id: 'w-owner', ...args })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('PERMISSION_DENIED')
    expect(result.output).not.toContain('OWNER_PRIVATE_RESULT')
    expect(action).not.toHaveBeenCalled()
  })
  it('keeps the caller separate for concurrent tool invocations and rejects a string-field impersonation', async () => {
    const owner = await caller('owner', 'owner-concurrent'), peer = await caller('peer', 'peer-concurrent')
    const fixture = toolFixture(owner, 'shared')
    // The actual shared controller can only return group scope; a personal scope is rejected even if miswired.
    const wrong = await fixture.tools.find(tool => tool.name === 'get_worker_terminal')!.call({ worker_id: 'w-owner', source_id: 'owner' })
    expect(wrong.output).toContain('SCOPE_MISMATCH'); expect(fixture.action).not.toHaveBeenCalled()
    const harness = fixture.harness
    const groupRecord = await requests.forInputs(key, (await sourceStore.list(key)).filter(input => input.message.platform_message_id === 'peer-concurrent')).create({ source_id: (await sourceStore.list(key)).find(input => input.message.platform_message_id === 'peer-concurrent')!.source_id, delivery: 'origin' })
    const sharedPeer = new ConversationRequestAuthority(requests, key, groupRecord.request_id, 'group', current)
    let finishOwner!: () => void
    const held = new Promise<void>(resolve => { finishOwner = resolve })
    const tools = buildWorkerTools({ harness, context: () => ({ managerKey: key, reportTo: { channel_id: 'voice', session_id: 'shared' } }), requestGuard: guard, requestControl: { scope: 'request', authority: async () => owner } })
    const tools2 = buildWorkerTools({ harness, context: () => ({ managerKey: key, reportTo: { channel_id: 'voice', session_id: 'shared' } }), requestGuard: guard, requestControl: { scope: 'request', authority: async () => { await held; return peer } } })
    const foreign = tools2.find(tool => tool.name === 'get_worker_terminal')!.call({ worker_id: 'w-owner', caller: owner, sender_friend_id: 'owner' })
    const own = await tools.find(tool => tool.name === 'get_worker_terminal')!.call({ worker_id: 'w-owner' })
    finishOwner()
    expect(own.isError).toBe(false); expect((await foreign).isError).toBe(true)
    expect(fixture.action).toHaveBeenCalledOnce()
    await expect(guard.authorizeControl('w-owner', sharedPeer, async () => allowed)).rejects.toThrow('REQUEST_CONTEXT_REQUIRED')
  })
  it('does not expose personal tasks in the shared list but the real owner can list its own task', async () => {
    const owner = await caller('owner', 'owner-list')
    const fixed = await requests.get(key, ownerRequest)
    const shared = new ConversationRequestAuthority(requests, key, ownerRequest, 'group', current)
    const publicFixture = toolFixture(shared, 'shared'), ownerFixture = toolFixture(owner)
    const visible = await publicFixture.tools.find(tool => tool.name === 'list_workers')!.call({ include_terminal: true })
    expect(visible.isError).toBe(false); expect(visible.output).not.toContain('owner task')
    const own = await ownerFixture.tools.find(tool => tool.name === 'list_workers')!.call({ include_terminal: true })
    expect(own.isError).toBe(false); expect(own.output).toContain('owner task')
    expect(fixed!.record.delivery.kind).toBe('origin')
  })

  async function resourceTools() {
    const fixed = (await requests.get(key, ownerRequest))!.record
    let configured = true
    const write = vi.fn(async (input: Record<string, unknown>) => { await fs.writeFile(String(input.file_path), String(input.content)); return { output: 'written', isError: false } })
    const bash = vi.fn(async () => ({ output: 'ran', isError: false }))
    const output = vi.fn(async () => ({ output: 'PARENT_ENTITY', isError: false }))
    const scope = new WorkerRequestToolScope({ guard, workerId: 'w-owner', ceilings: [fixed.permission_sources.group, fixed.permission_sources.friend!], cwd: root,
      rawTools: permissions => configured ? [
        authorizeTool(defineTool({ name: 'Write', description: '', inputSchema: { type: 'object' }, call: write }), fileAuthorization('worker', () => permissions, () => root, 'file_path', true)),
        authorizeTool(defineTool({ name: 'Bash', description: '', inputSchema: { type: 'object' }, call: bash }), entryAuthorization('worker', 'shell', () => permissions)),
        authorizeTool(defineTool({ name: 'Output', description: '', inputSchema: { type: 'object' }, call: output }), roleAuthorization('worker')),
      ].filter(tool => tool.authorization!.available()) : [],
      skills: () => [], authorizeCommand: async permissions => permissions.tool_access.shell && permissions.cli_access.provider === 'write' ? allowed : denied('PERMISSION_DENIED', 'complete shell + provider required'),
    })
    return { scope, write, bash, output, disable: () => { configured = false } }
  }
  it('uses actual current tool closures and preserves read-A/write-B without splicing permissions', async () => {
    const { scope, write } = await resourceTools(), tool = scope.tools().find(tool => tool.name === 'Write')!
    expect((await tool.call({ file_path: path.join(root, 'b/result'), content: 'own result' })).isError).toBe(false)
    expect((await tool.call({ file_path: path.join(root, 'a/result'), content: 'forbidden' })).isError).toBe(true)
    expect(write).toHaveBeenCalledOnce(); expect(await fs.readFile(path.join(root, 'b/result'), 'utf8')).toBe('own result')
    await expect(fs.stat(path.join(root, 'a/result'))).rejects.toThrow()
  })
  it('cannot combine shell from one current source and CLI write from another', async () => {
    const { scope, bash } = await resourceTools(), base = current.getMockImplementation()!
    current.mockImplementation(async (kind, origin) => { const source = structuredClone(await base(kind, origin)); if (source) { if (kind === 'group') source.resolved.cli_access.provider = 'none'; else source.resolved.tool_access.shell = false }; return source })
    const tool = scope.tools().find(tool => tool.name === 'Bash')!
    expect((await tool.call({ command: 'crabot provider add' })).isError).toBe(true)
    expect(bash).not.toHaveBeenCalled()
  })
  it('checks the final/repaired input again and freezes arguments while authority is resolved', async () => {
    const { scope, write } = await resourceTools(), tool = scope.tools().find(tool => tool.name === 'Write')!
    expect((await tool.authorization!.check({ file_path: path.join(root, 'b/result') })).allowed).toBe(true)
    expect((await tool.call({ file_path: path.join(root, 'a/result'), content: 'bad repaired target' })).isError).toBe(true)
    const input = { file_path: path.join(root, 'b/result'), content: 'original' }, pending = tool.call(input)
    input.file_path = path.join(root, 'a/result'); input.content = 'mutated'
    expect((await pending).isError).toBe(false); expect(write).toHaveBeenCalledOnce()
    expect(await fs.readFile(path.join(root, 'b/result'), 'utf8')).toBe('original')
  })
  it('does not call a stale raw closure after configuration removal or a closed original request', async () => {
    const { scope, write, disable } = await resourceTools(), tool = scope.tools().find(tool => tool.name === 'Write')!
    disable()
    expect((await tool.call({ file_path: path.join(root, 'b/result'), content: 'bad' })).isError).toBe(true)
    await requests.close(key, ownerRequest)
    expect((await tool.call({ file_path: path.join(root, 'b/result'), content: 'bad' })).output).toContain('REQUEST_CLOSED')
    expect(write).not.toHaveBeenCalled()
  })
  it('keeps a child rebound entity tool owned by the child while rechecking the original request', async () => {
    const { scope, output } = await resourceTools(), original = scope.tools(false).find(tool => tool.name === 'Output')!
    const child = vi.fn(async () => ({ output: 'CHILD_ENTITY', isError: false }))
    const rebound = scope.wrapChildBound(original, { ...original, call: child })
    expect((await rebound.call({ entity_id: 'child-entity' })).output).toBe('CHILD_ENTITY')
    expect(child).toHaveBeenCalledOnce(); expect(output).not.toHaveBeenCalled(); expect(rebound.authorization?.role).toBe('child')
    await requests.close(key, ownerRequest)
    expect((await rebound.call({ entity_id: 'child-entity' })).isError).toBe(true); expect(child).toHaveBeenCalledOnce()
  })
  it('reports unknown execution after a side effect instead of lying about an authorization denial or replaying', async () => {
    const { scope, write } = await resourceTools(), tool = scope.tools().find(tool => tool.name === 'Write')!
    write.mockImplementationOnce(async input => { await fs.writeFile(String(input.file_path), 'committed'); throw new Error('PRIVATE_ERROR_BODY') })
    const result = await tool.call({ file_path: path.join(root, 'b/result'), content: 'body' })
    expect(result.output).toBe('TOOL_EXECUTION_OUTCOME_UNKNOWN'); expect(result.isError).toBe(true); expect(write).toHaveBeenCalledOnce()
    expect(await fs.readFile(path.join(root, 'b/result'), 'utf8')).toBe('committed')
  })
  it('keeps unavailable authority distinct from ordinary denial and never falls back to the legacy snapshot', async () => {
    const { scope, write } = await resourceTools(), tool = scope.tools().find(tool => tool.name === 'Write')!
    current.mockRejectedValue(new Error('RPC unavailable'))
    expect((await tool.call({ file_path: path.join(root, 'b/result'), content: 'bad' })).output).toContain('CAPABILITY_UNKNOWN')
    expect(write).not.toHaveBeenCalled()
  })

})
