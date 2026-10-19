import { WorkerNotReadyError } from '../../../src/workers/implementation-selection.js'
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
import { checkFileAccess } from '../../../src/permissions/tool-authorization.js'
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
    await fs.mkdir(path.join(root, 'data'), { mode: 0o700 }); await fs.mkdir(path.join(root, 'workspaces'), { mode: 0o700 })
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
    workspaces = new WorkspaceManager(path.join(root, 'workspaces'), path.join(root, 'data')); originalResolve = workspaces.resolve.bind(workspaces); resolve = vi.spyOn(workspaces, 'resolve')
    provision = vi.fn(async () => {}); spawn = vi.fn(async (spec: SpawnSpec) => ({ worker_id: spec.worker_id, incarnation_id: spec.incarnation_id, seq: 1, impl: 'builtin', session_ref: 'actual-session' }))
    const adapter = { implId: 'builtin', provision, spawn, capabilities: () => ({ fork: true, revive: true, goalMode: false, subagent: false, structuredTrace: true }), state: async () => 'running', readTrace: async () => ({ events: [], nextCursor: { offset: 0 } }) } as unknown as WorkerAdapter
    connection = vi.fn(async () => ({ env: {}, dispose: vi.fn(async () => {}) }))
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

  it('cannot use a host-supplied custom runtime to bypass the resource guard', async () => {
    await expect(harness.spawnRequestWorker({ ...params, builtin: {} as never }, caller)).rejects.toThrow('HOST_CONFIGURED')
    expect(provision).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled()
  })
  it.each(['read', 'null'] as const)('admits an omitted workspace with %s extra storage and preserves the request', async storage => {
    if (storage === 'null') {
      // Keep the original ceilings; revoke only the extra range, not file_io.
      group.resolved.storage = null
      friend!.resolved.storage = null
    }
    const { worker } = await harness.spawnRequestWorker({ ...params, workspace: undefined }, caller)
    expect(worker.origin.creator_friend_id).toBe('actual-owner')
    expect(worker.report_to).toEqual({ channel_id: 'voice', session_id: 'shared' })
    const workspace = worker.incarnations[0].workspace!
    expect(workspace).toBe(path.join(await fs.realpath(root), 'workspaces/default/tasks', worker.worker_id))
    expect((await contexts.read(worker.worker_id))!.principal_permissions!.storage).toEqual(storage === 'null' ? null : { workspace_path: await fs.realpath(path.join(root, 'a')), access: 'read' })
    expect(provision).toHaveBeenCalledOnce(); expect(spawn).toHaveBeenCalledOnce()
  })

  it('rechecks both file_io switches for actual default writes after revocation', async () => {
    const { worker } = await harness.spawnRequestWorker({ ...params, workspace: undefined }, caller)
    const workspace = worker.incarnations[0].workspace!, file = path.join(workspace, 'result.txt')
    const managed = harness.managedWorkspaceScope(worker.worker_id, workspace)
    const write = () => guard.runResource(worker.worker_id, source => checkFileAccess(source.resolved, file, '/', true, managed), async () => fs.writeFile(file, 'OWNED'))
    await write(); expect(await fs.readFile(file, 'utf8')).toBe('OWNED')
    group.resolved.tool_access.file_io = false; friend!.resolved.tool_access.file_io = false
    await expect(write()).rejects.toThrow('PERMISSION_DENIED')
    expect(await fs.readFile(file, 'utf8')).toBe('OWNED')
  })

  it('releases connection admission and activation fence on a preparation denial', async () => {
    const release = vi.fn()
    ;(harness as any).deps.acquireWorkerFence = () => ({ release })
    await fs.writeFile(path.join(root, 'a/AGENTS.md'), 'rules')
    const publicCaller = new ConversationRequestAuthority(requests, key, recordId, 'group', async () => structuredClone(group))
    await expect(harness.spawnRequestWorker({ ...params, workspace: path.join(root, 'a') }, publicCaller)).rejects.toThrow('PERMISSION_DENIED')
    expect(release).toHaveBeenCalledOnce()
    expect((await connection.mock.results[0].value).dispose).toHaveBeenCalledOnce()
    expect(provision).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled()
  })

  it('workspace instruction normalization cannot create a link through a read-only source', async () => {
    await fs.writeFile(path.join(root, 'a/AGENTS.md'), 'rules')
    const publicCaller = new ConversationRequestAuthority(requests, key, recordId, 'group', async () => structuredClone(group))
    await expect(harness.spawnRequestWorker({ ...params, workspace: path.join(root, 'a') }, publicCaller)).rejects.toThrow(/PERMISSION_DENIED/)
    expect(await fs.lstat(path.join(root, 'a/CLAUDE.md')).catch(() => null)).toBeNull()
    expect(provision).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled()
  })
  it.each(['input', 'resume', 'handoff', 'query', 'branch'] as const)('refuses %s with a closed original request even though the legacy snapshot would permit it', async operation => {
    const { worker } = await harness.spawnRequestWorker(params, caller)
    const mainline = worker.incarnations[0], adapter = (harness as any).deps.adapters.get('builtin')
    const action = vi.fn(); Object.assign(adapter, { sendInput: action, resume: action, fork: action, respondToUi: action })
    await requests.close(key, recordId)
    if (operation === 'input') await expect((harness as any).attemptInput(adapter, { worker_id: worker.worker_id, impl: 'builtin', seq: 1, session_ref: 'actual-session' }, 'redirect', false)).rejects.toThrow('closed')
    if (operation === 'resume') await expect((harness as any).reviveIncarnation(key, worker, mainline, adapter, 'resume')).rejects.toThrow('closed')
    if (operation === 'handoff') await expect((harness as any).handoffIncarnation(key, worker, mainline, 'codex', 'handoff')).rejects.toThrow('closed')
    if (operation === 'query') await expect(harness.queryWorker(worker.worker_id, 'query')).rejects.toThrow('closed')
    if (operation === 'branch') {
      const fork = { ...mainline, incarnation_id: 'fork-inc', seq: 2, forked_from: mainline.incarnation_id, query_id: 'fork-query' }
      await ledger.upsertWorker(key, worker.worker_id, prev => ({ ...prev!, incarnations: [...prev!.incarnations, fork] }))
      const receipts = (harness as any).queryReceiptStore
      await receipts.create({ worker_id: worker.worker_id, manager_key: key, query_id: 'fork-query', question_preview: 'query', created_at: time, updated_at: time, establishment_deadline_at: '2026-10-16T00:00:10Z', state: 'starting', manager_notification: { status: 'not_required' } })
      await receipts.markRunning(worker.worker_id, 'fork-query', 2, time)
      await expect(harness.sendToExecutionBranch(worker.worker_id, 'fork-inc', 'branch', 'delivery', async () => {})).rejects.toThrow('closed')
    }
    expect(action).not.toHaveBeenCalled()
  })
  it('a denied UI confirmation does not consume the snapshot or send a native key', async () => {
    const { worker } = await harness.spawnRequestWorker(params, caller)
    const mainline = worker.incarnations[0], adapter = (harness as any).deps.adapters.get('builtin')
    const action = vi.fn(); adapter.respondToUi = action
    const store = (harness as any).uiSnapshotStore
    const snapshot = await store.prepare({ worker_id: worker.worker_id, manager_key: key, incarnation_id: mainline.incarnation_id,
      impl: 'builtin', seq: 1, fingerprint: 'confirm-1', actions: [{ action_id: 'confirm', kind: 'keys', keys: ['Enter'] }], created_at: time }, true, time)
    await requests.close(key, recordId)
    await expect(harness.respondToWorkerUi(worker.worker_id, snapshot.snapshot_id, 'confirm')).rejects.toThrow('closed')
    expect((await store.get(worker.worker_id, snapshot.snapshot_id)).status).toBe('active')
    expect(action).not.toHaveBeenCalled()
  })
  it('current grants cannot promote a directory-scoped original request into a native full-host handoff', async () => {
    const { worker } = await harness.spawnRequestWorker(params, caller)
    friend!.resolved.storage = { workspace_path: '/', access: 'readwrite' }
    await expect((harness as any).handoffIncarnation(key, worker, worker.incarnations[0], 'codex', 'switch')).rejects.toThrow(/PERMISSION_DENIED/)
    expect(connection).toHaveBeenCalledOnce()
  })
  it('startup reconciliation preserves a broken binding and never probes it as a legacy Worker', async () => {
    const { worker } = await harness.spawnRequestWorker(params, caller)
    const adapter = (harness as any).deps.adapters.get('builtin'), state = vi.fn(async () => 'running')
    adapter.state = state
    await fs.rm(path.join(root, 'workers', worker.worker_id, 'context.json'))
    const report = await harness.reconcileOnStartup()
    expect(report.failed).toContain(worker.worker_id); expect(state).not.toHaveBeenCalled()
    expect((await ledger.findWorker(worker.worker_id))!.worker.origin.request).toEqual(worker.origin.request)
  })
  it('a queued input rechecks its verified caller before delivery after that identity is revoked', async () => {
    const { worker } = await harness.spawnRequestWorker(params, caller)
    const adapter = (harness as any).deps.adapters.get('builtin'), action = vi.fn()
    adapter.sendInput = action
    const inbox = (harness as any).getInbox(worker.worker_id)
    inbox.hold('fixture-pause')
    const authorize = vi.fn(() => guard.authorizeControl(worker.worker_id, caller, async () => ({ allowed: true })))
    await harness.sendToWorker(worker.worker_id, 'queued owner command', { authorize })
    expect(inbox.pending).toBe(1); expect(action).not.toHaveBeenCalled()
    friend = null
    inbox.release('fixture-pause')
    await expect((harness as any).flushInbox(worker.worker_id)).rejects.toThrow('PERMISSION_DENIED')
    expect(authorize).toHaveBeenCalled(); expect(action).not.toHaveBeenCalled()
    expect(inbox.pending).toBe(1)
  })
  it('preserves implementation readiness details without masking them as missing personal permission', async () => {
    const failure = new WorkerNotReadyError('builtin', [], { builtin: 'model unavailable' })
    ;(harness as any).deps.selectWorkerImpl = () => { throw failure }
    await expect(harness.spawnRequestWorker(params, caller)).rejects.toBe(failure)
    expect(connection).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled()
  })
  it('a group-specific implementation rejection still permits a whole valid friend source', async () => {
    ;(harness as any).deps.selectWorkerImpl = (_impl: unknown, _excluded: unknown, permissions: ResolvedPermissions) => {
      if (permissions.storage?.access === 'read') throw new WorkerNotReadyError(undefined, ['builtin'], {})
      return 'builtin'
    }
    expect((await harness.spawnRequestWorker(params, caller)).status).toBe('spawned')
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
