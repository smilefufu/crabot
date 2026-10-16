import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkerHarness, type SpawnWorkerParams } from '../../../src/workers/harness/harness.js'
import { LedgerStore } from '../../../src/workers/harness/ledger-store.js'
import { WorkerContextStore } from '../../../src/workers/harness/context-store.js'
import { WorkspaceManager } from '../../../src/workers/harness/workspace-manager.js'
import { WorkerRequestGuard } from '../../../src/workers/harness/request-guard.js'
import { boundedRequestPermissions } from '../../../src/workers/harness/request-permissions.js'
import { TrustedHumanInputStore } from '../../../src/manager/trusted-human-input-store.js'
import { ConversationRequestStore } from '../../../src/manager/conversation-request-store.js'
import { ConversationRequestAuthority } from '../../../src/manager/conversation-request-authority.js'
import { assertExecutionPolicy } from '../../../src/workers/execution-policy.js'
import type { WorkerAdapter, SpawnSpec } from '../../../src/workers/types.js'
import type { RequestPermissionSource, ConversationRequestSource } from '../../../src/manager/request-permission-sources.js'
import type { ResolvedPermissions, ChannelMessage } from '../../../src/types.js'

const key = 'voice::shared' as const
const time = '2026-10-16T00:00:00.000Z'
describe('request spawn binds before any carrier side effect', () => {
  let root: string, ledger: LedgerStore, contexts: WorkerContextStore, requests: ConversationRequestStore, guard: WorkerRequestGuard, harness: WorkerHarness, workspaces: WorkspaceManager
  let source: ConversationRequestSource, recordId: string, caller: ConversationRequestAuthority, params: SpawnWorkerParams
  let group: RequestPermissionSource, friend: RequestPermissionSource | null
  let originalResolve: WorkspaceManager['resolve']
  let provision: ReturnType<typeof vi.fn>, spawn: ReturnType<typeof vi.fn>, resolve: ReturnType<typeof vi.spyOn>, connection: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'request-spawn-')); await fs.mkdir(path.join(root, 'a')); await fs.mkdir(path.join(root, 'b'))
    const permissions: ResolvedPermissions = { tool_access: { memory: true, messaging: true, task: true, mcp_skill: true, file_io: true, browser: true, shell: true, remote_exec: false, desktop: true }, cli_access: { provider: 'write', agent: 'write', mcp: 'write', skill: 'write', schedule: 'write', channel: 'write', friend: 'write', permission: 'write', config: 'write', undo: 'write' }, storage: { workspace_path: path.join(root, 'a'), access: 'read' }, memory_scopes: [] }
    group = { kind: 'group', subject_id: key, is_master: false, resolved: structuredClone(permissions) }
    friend = { kind: 'friend', subject_id: 'actual-owner', is_master: true, resolved: { ...structuredClone(permissions), storage: { workspace_path: path.join(root, 'b'), access: 'readwrite' } } }
    const current = async (kind: 'group' | 'friend') => structuredClone(kind === 'group' ? group : friend)
    const inputs = new TrustedHumanInputStore(path.join(root, 'managers'), { now: () => time, resolveSender: async () => ({ id: 'actual-owner', display_name: 'Owner', permission: 'master', channel_identities: [{ channel_id: 'voice', platform_user_id: 'actual-speaker' }], created_at: time, updated_at: time }) })
    requests = new ConversationRequestStore(path.join(root, 'managers'), inputs, { now: () => time, resolveSources: async origin => { source = origin; return { group: structuredClone(group), friend: structuredClone(friend) } } })
    const message: ChannelMessage = { platform_message_id: 'real-message', session: { channel_id: 'voice', session_id: 'shared', type: 'group' }, sender: { platform_user_id: 'actual-speaker', platform_display_name: 'Owner', friend_id: 'forged' }, content: { type: 'text', text: '在已授权目录完成任务，回原会话。' }, features: { is_mention_crab: true }, platform_timestamp: time }
    const admitted = await inputs.capture(key, [message]), record = await requests.forInputs(key, admitted).create({ source_id: admitted[0].source_id, delivery: 'origin' }); recordId = record.request_id
    caller = new ConversationRequestAuthority(requests, key, recordId, 'request', current)
    ledger = new LedgerStore(path.join(root, 'ledgers')); contexts = new WorkerContextStore(path.join(root, 'workers'))
    guard = new WorkerRequestGuard(ledger, contexts, requests, current)
    workspaces = new WorkspaceManager(path.join(root, 'workspaces')); originalResolve = workspaces.resolve.bind(workspaces); resolve = vi.spyOn(workspaces, 'resolve')
    provision = vi.fn(async () => {}); spawn = vi.fn(async (spec: SpawnSpec) => ({ worker_id: spec.worker_id, incarnation_id: spec.incarnation_id, seq: 1, impl: 'builtin', session_ref: 'actual-session' }))
    const adapter = { implId: 'builtin', provision, spawn, capabilities: () => ({ fork: true, revive: true, goalMode: false, subagent: false, structuredTrace: true }), state: async () => 'running', readTrace: async () => ({ events: [], nextCursor: { offset: 0 } }) } as unknown as WorkerAdapter
    connection = vi.fn(async () => ({ env: {}, dispose: async () => {} }))
    harness = new WorkerHarness({ adapters: new Map([['builtin', adapter]]), defaultImpl: 'builtin', ledger, workspaces, workersDir: path.join(root, 'workers'), now: () => time, requestGuard: () => guard, assertExecutionPolicy, admitWorkerConnection: connection })
    params = { managerKey: key, title: 'owner task', prompt: '完整要求', workspace: path.join(root, 'b'), origin: { trigger_type: 'system', creator_friend_id: 'forged' }, report_to: { channel_id: 'wrong', session_id: 'wrong' }, target_session: { channel_id: 'wrong', session_id: 'wrong', type: 'private' }, principal_permissions: permissions }
  })
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })

  it('fixes actual origin, both bindings and separate request ceilings before workspace/provision/spawn', async () => {
    const original = originalResolve
    resolve.mockImplementation(async (id, requested) => { expect((await requests.get(key, recordId))!.record.worker_ids).toContain(id); return original(id, requested) })
    provision.mockImplementation(async () => { const all = await ledger.listAllWorkers(); expect(all).toHaveLength(1); expect((await guard.load(all[0].worker.worker_id))!.source.sender_friend_id).toBe('actual-owner') })
    const result = await harness.spawnRequestWorker(params, caller)
    expect(result.status).toBe('spawned')
    expect(result.worker.origin).toMatchObject({ trigger_type: 'message', creator_friend_id: 'actual-owner', request: { request_id: recordId, execution_scope: 'request' } })
    expect(result.worker.report_to).toEqual({ channel_id: 'voice', session_id: 'shared' })
    const context = await contexts.read(result.worker.worker_id)
    expect(context).toMatchObject({ schema_version: 2, creator_friend_id: 'actual-owner', manager_key: key, target_session: { channel_id: 'voice', session_id: 'shared', type: 'group' }, principal_permissions: { storage: { workspace_path: await fs.realpath(path.join(root, 'b')), access: 'readwrite' } } })
    expect(context!.request).toEqual(result.worker.origin.request)
    expect(provision).toHaveBeenCalledOnce(); expect(spawn).toHaveBeenCalledOnce()
  })

  it('concurrent exact plan retries return the original Worker without creating another workspace or carrier', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => harness.spawnRequestWorker(params, caller)))
    expect(new Set(results.map(result => result.worker.worker_id)).size).toBe(1)
    expect(results.map(result => result.status).filter(status => status === 'spawned')).toHaveLength(1)
    expect(spawn).toHaveBeenCalledOnce(); expect(provision).toHaveBeenCalledOnce(); expect(resolve).toHaveBeenCalledOnce(); expect(connection).toHaveBeenCalledOnce()
    expect((await requests.get(key, recordId))!.record.worker_ids).toEqual([results[0].worker.worker_id])
  })

  it('refuses to attach new authority through the old spawn entry or to a different manager', async () => {
    await expect(harness.spawnWorker({ ...params, origin: { ...params.origin, request: { schema_version: 1, request_id: recordId, source_sha256: 'a'.repeat(64), execution_scope: 'request' } } })).rejects.toThrow('BOUND_ADMISSION')
    await expect(harness.spawnRequestWorker({ ...params, managerKey: 'voice::other' }, caller)).rejects.toThrow('manager mismatch')
    expect(connection).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled()
  })

  it('does not prepare a connection or workspace when durable request association fails', async () => {
    vi.spyOn(requests, 'attachWorker').mockRejectedValue(new Error('disk full'))
    await expect(harness.spawnRequestWorker(params, caller)).rejects.toThrow('disk full')
    expect(connection).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled(); expect(provision).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled()
    expect((await ledger.getLedger(key)).workers).toHaveLength(0)
  })

  it.each(['workspace', 'provision'] as const)('rechecks revocation after %s and never starts a carrier', async point => {
    if (point === 'workspace') { const original = originalResolve; resolve.mockImplementation(async (id, requested) => { const value = await original(id, requested); friend = null; return value }) }
    else provision.mockImplementation(async () => { friend = null })
    await expect(harness.spawnRequestWorker(params, caller)).rejects.toThrow(/PERMISSION_DENIED|CAPABILITY_UNKNOWN/)
    expect(spawn).not.toHaveBeenCalled()
    if (point === 'workspace') expect(provision).not.toHaveBeenCalled()
  })

  it('preserves a failed half-written binding and refuses to restart its original plan', async () => {
    const write = fs.writeFile.bind(fs)
    const fail = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, ...args) => { if (String(file).includes('.context.json.tmp-')) throw new Error('context write failed'); return (write as any)(file, ...args) })
    await expect(harness.spawnRequestWorker(params, caller)).rejects.toThrow('context write failed')
    fail.mockRestore()
    await expect(harness.spawnRequestWorker(params, caller)).rejects.toThrow(/binding|context/i)
    expect(spawn).not.toHaveBeenCalled(); expect(provision).not.toHaveBeenCalled(); expect(connection).toHaveBeenCalledOnce()
  })

  it('never widens a snapshot by combining sources or by intersecting disjoint storage', async () => {
    await expect(boundedRequestPermissions(group, friend!)).rejects.toThrow('different request permission sources')
    const moved = structuredClone(friend!); moved.resolved.storage = { workspace_path: path.join(root, 'a'), access: 'read' }; moved.resolved.cli_access.provider = 'read'
    const narrowed = await boundedRequestPermissions(friend!, moved)
    expect(narrowed.storage).toBeNull(); expect(narrowed.cli_access.provider).toBe('read')
    moved.resolved.storage = { workspace_path: path.join(root, 'b'), access: 'read' }
    expect((await boundedRequestPermissions(friend!, moved)).storage?.access).toBe('read')
  })
})
