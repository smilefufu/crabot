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
})
