import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { sha256CanonicalJson } from 'crabot-shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChannelMessage, Friend } from '../../src/types.js'
import { TrustedHumanInputStore } from '../../src/manager/trusted-human-input-store.js'
import { ConversationRequestStore } from '../../src/manager/conversation-request-store.js'
import type { ConversationRequestSource, ResolveRequestPermissionSourcesResult } from '../../src/manager/request-permission-sources.js'

const key = 'voice::shared' as const
const raw = (id: string, text = 'Read A. Write B.', sender = 'speaker-a'): ChannelMessage => ({
  platform_message_id: id, session: { channel_id: 'voice', session_id: 'shared', type: 'group' },
  sender: { platform_user_id: sender, platform_display_name: sender }, content: { type: 'text', text },
  features: { is_mention_crab: true }, platform_timestamp: '2026-10-16T00:00:00.000Z',
})
const permissions = { tool_access: { memory: false, messaging: true, task: false, mcp_skill: false, file_io: true, browser: false, shell: false, remote_exec: false, desktop: false }, cli_access: { provider: 'none', agent: 'none', mcp: 'none', skill: 'none', schedule: 'none', channel: 'none', friend: 'none', permission: 'none', config: 'none', undo: 'none' }, storage: null, memory_scopes: [] } as const
const resolved = (source: ConversationRequestSource): ResolveRequestPermissionSourcesResult => ({
  group: { kind: 'group', subject_id: key, is_master: false, resolved: structuredClone(permissions) as never },
  friend: source.sender_friend_id ? { kind: 'friend', subject_id: source.sender_friend_id, is_master: true, resolved: structuredClone(permissions) as never } : null,
})

describe('Conversation request immutable scope, source and delivery', () => {
  let directory: string, inputs: TrustedHumanInputStore, requests: ConversationRequestStore
  let resolve: ReturnType<typeof vi.fn>, now: string
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-requests-')); now = '2026-10-16T01:00:00.000Z'
    inputs = new TrustedHumanInputStore(directory, { now: () => now, resolveSender: async (_channel, sender): Promise<Friend | null> => sender === 'speaker-a' ? {
      id: 'actual-a', display_name: 'A', permission: 'master', channel_identities: [{ channel_id: 'voice', platform_user_id: sender }], created_at: now, updated_at: now,
    } : null })
    resolve = vi.fn(async (source: ConversationRequestSource) => resolved(source))
    requests = new ConversationRequestStore(directory, inputs, { now: () => now, resolveSources: resolve })
  })
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }) })
  async function window(message = raw('1')) {
    const [source] = await inputs.capture(key, [message])
    return { source, context: requests.forInputs(key, [source]) }
  }
  async function requestFile() { const [folder] = await fs.readdir(directory); return path.join(directory, folder, 'requests.json') }

  it('fixes the complete original source, exact selection, separate ceilings and origin target before actions', async () => {
    const { source, context } = await window()
    const request = await context.create({ source_id: source.source_id, quote: 'Write B.', delivery: 'origin' })
    expect(request).toMatchObject({ schema_version: 1, manager_key: key, source_id: source.source_id, source_sha256: sha256CanonicalJson(source), selection: { start: 8, end: 16 },
      delivery: { kind: 'origin', requester_friend_id: null }, worker_ids: [], status: 'open', created_at: now })
    expect(request.request_id).toBe(sha256CanonicalJson([source.source_id, 8, 16]))
    expect(resolve.mock.calls[0][0]).toEqual({ source_id: source.source_id, channel_id: 'voice', session_id: 'shared', session_type: 'group', platform_message_id: '1', platform_user_id: 'speaker-a', sender_friend_id: 'actual-a' })
    const loaded = await requests.get(key, request.request_id)
    expect(loaded?.source.message.content.text).toBe('Read A. Write B.')
    expect(loaded?.record).toEqual(request)
    expect((await fs.stat(await requestFile())).mode & 0o777).toBe(0o600)
  })
  it('hashes the durable wire JSON when host objects carry undefined optional fields', async () => {
    const message = raw('1'); message.content.media_url = undefined
    const [source] = await inputs.capture(key, [message])
    const context = requests.forInputs(key, [source])
    const saved = await context.create({ source_id: source.source_id, delivery: 'origin' })
    const [replayed] = await inputs.capture(key, [message])
    expect(replayed).toEqual(source)
    expect((await requests.get(key, saved.request_id))?.source).toEqual(source)
    expect(saved.source_sha256).toBe(sha256CanonicalJson(source))
  })
  it('current input windows cannot select an old or another speaker source merely by its ID', async () => {
    const old = await window(); const fresh = await window(raw('2', 'Another request', 'unknown'))
    await expect(fresh.context.create({ source_id: old.source.source_id, delivery: 'origin' })).rejects.toThrow(/not in.*input/i)
    await expect(requests.forInputs(key, []).create({ source_id: fresh.source.source_id, delivery: 'origin' })).rejects.toThrow(/not in.*input/i)
    expect(resolve).not.toHaveBeenCalled()
  })
  it('snapshots admitted input references before caller mutation and refuses forged copies or wrong sessions', async () => {
    const { source, context } = await window(); source.message.content.text = 'caller rewrote the authorization'
    const saved = await context.create({ source_id: source.source_id, delivery: 'origin' })
    expect((await requests.get(key, saved.request_id))?.source.message.content.text).toBe('Read A. Write B.')
    await expect(requests.forInputs(key, [source]).create({ source_id: source.source_id, delivery: 'origin' })).rejects.toThrow(/source/i)
    expect(() => requests.forInputs('voice::elsewhere', [source])).toThrow(/target/i)
  })
  it('does not let caller or resolver mutation change an in-flight proposal or its authority subject', async () => {
    const { source, context } = await window()
    resolve.mockImplementationOnce((origin: ConversationRequestSource) => {
      const value = resolved(origin); origin.sender_friend_id = 'substituted-friend'
      return Promise.resolve(value)
    })
    const proposal = { source_id: source.source_id, quote: 'Read A.', delivery: 'origin' as const }
    const pending = context.create(proposal); proposal.quote = 'Write B.'
    const saved = await pending
    expect(saved.selection).toEqual({ start: 0, end: 7 })
    expect(saved.permission_sources.friend?.subject_id).toBe('actual-a')
    expect((await requests.get(key, saved.request_id))?.record).toEqual(saved)
  })
  it('retries and process recovery return the same original ceiling instead of re-resolving a wider grant', async () => {
    const { source, context } = await window(); const first = await context.create({ source_id: source.source_id, delivery: 'origin' })
    now = '2026-10-16T05:00:00.000Z'; resolve.mockImplementation(async origin => { const value = resolved(origin); value.group.resolved.tool_access.shell = true; return value })
    const recovered = new ConversationRequestStore(directory, inputs, { now: () => now, resolveSources: resolve })
    expect(await recovered.forInputs(key, [source]).create({ source_id: source.source_id, delivery: 'origin' })).toEqual(first)
    expect(resolve).toHaveBeenCalledTimes(1)
  })
  it('allows disjoint tasks in one message, refuses ambiguous overlap and deduplicates concurrent retries', async () => {
    const { source, context } = await window()
    const first = await context.create({ source_id: source.source_id, quote: 'Read A.', delivery: 'origin' })
    const second = await context.create({ source_id: source.source_id, quote: 'Write B.', delivery: 'origin' })
    expect(first.request_id).not.toBe(second.request_id)
    await expect(context.create({ source_id: source.source_id, quote: 'A. Write', delivery: 'origin' })).rejects.toThrow('REQUEST_SCOPE_CONFLICT')
    const repeats = await Promise.all(Array.from({ length: 5 }, () => context.create({ source_id: source.source_id, quote: 'Write B.', delivery: 'origin' })))
    expect(repeats.every(item => item.request_id === second.request_id)).toBe(true); expect(resolve).toHaveBeenCalledTimes(2)
  })
  it('requires a unique exact nonempty quote and does not split a surrogate pair', async () => {
    const { source, context } = await window(raw('1', 'Go 😀. Go again.'))
    for (const quote of ['', ' ', 'Go', 'rewritten request', '\ud83d', '\ude00']) {
      await expect(context.create({ source_id: source.source_id, quote, delivery: 'origin' })).rejects.toThrow(/selection/i)
    }
    expect((await context.create({ source_id: source.source_id, quote: '😀', delivery: 'origin' })).selection).toEqual({ start: 3, end: 5 })
    expect(resolve).toHaveBeenCalledTimes(1)
  })
  it('only binds private delivery to this known original sender and never lets another caller change it', async () => {
    const { source, context } = await window(raw('1', 'Send the result privately to me'))
    const saved = await context.create({ source_id: source.source_id, delivery: 'requester_private' })
    expect(saved.delivery).toEqual({ kind: 'requester_private', requester_friend_id: 'actual-a' })
    await expect(context.create({ source_id: source.source_id, delivery: 'origin' })).rejects.toThrow(/delivery/i)
    const unknown = await window(raw('2', 'Send it privately to me', 'unknown'))
    await expect(unknown.context.create({ source_id: unknown.source.source_id, delivery: 'requester_private' })).rejects.toThrow(/known.*sender/i)
    expect(resolve).toHaveBeenCalledTimes(1)
  })
  it('rejects a malformed or substituted permission source before publishing any request', async () => {
    const { source, context } = await window()
    for (const mutate of [(value: any) => value.group.is_master = true, (value: any) => value.friend.subject_id = 'other-master', (value: any) => value.group.resolved.tool_access = {}, (value: any) => value.extra = true]) {
      resolve.mockImplementation(async origin => { const value = resolved(origin); mutate(value); return value })
      await expect(context.create({ source_id: source.source_id, delivery: 'origin' })).rejects.toThrow(/permission/i)
    }
    expect(await requests.get(key, sha256CanonicalJson([source.source_id, 0, source.message.content.text!.length]))).toBeNull()
  })
  it('does not create a request when source, permission resolution, clock or atomic commit fails', async () => {
    const { source, context } = await window()
    resolve.mockRejectedValueOnce(new Error('Admin unavailable'))
    await expect(context.create({ source_id: source.source_id, delivery: 'origin' })).rejects.toThrow('Admin unavailable')
    now = 'invalid'; await expect(context.create({ source_id: source.source_id, delivery: 'origin' })).rejects.toThrow(/time/i)
    now = '2026-10-16T01:00:00.000Z'
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk failure'))
    await expect(context.create({ source_id: source.source_id, delivery: 'origin' })).rejects.toThrow('disk failure')
    const id = sha256CanonicalJson([source.source_id, 0, 16]); expect(await requests.get(key, id)).toBeNull()
    expect((await context.create({ source_id: source.source_id, delivery: 'origin' })).request_id).toBe(id)
  })
  it('persists Worker association before provision, refuses cross-request reuse, and closes without deleting facts', async () => {
    const { source, context } = await window()
    const one = await context.create({ source_id: source.source_id, quote: 'Read A.', delivery: 'origin' })
    const two = await context.create({ source_id: source.source_id, quote: 'Write B.', delivery: 'origin' })
    await requests.attachWorker(key, one.request_id, 'worker-1'); await requests.attachWorker(key, one.request_id, 'worker-1')
    expect((await requests.get(key, one.request_id))?.record.worker_ids).toEqual(['worker-1'])
    await expect(requests.attachWorker(key, two.request_id, 'worker-1')).rejects.toThrow(/already bound/i)
    await requests.close(key, one.request_id); await requests.close(key, one.request_id)
    await expect(requests.attachWorker(key, one.request_id, 'worker-2')).rejects.toThrow(/closed/i)
    expect((await context.create({ source_id: source.source_id, quote: 'Read A.', delivery: 'origin' })).status).toBe('closed')
    expect((await requests.get(key, one.request_id))?.source.sender_friend_id).toBe('actual-a')
  })
  it('failed Worker association or close commits leave the last durable state intact', async () => {
    const { source, context } = await window(); const saved = await context.create({ source_id: source.source_id, delivery: 'origin' })
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('failed association'))
    await expect(requests.attachWorker(key, saved.request_id, 'worker-1')).rejects.toThrow('failed association')
    expect((await requests.get(key, saved.request_id))?.record.worker_ids).toEqual([])
    rename.mockRejectedValueOnce(new Error('failed close')); await expect(requests.close(key, saved.request_id)).rejects.toThrow('failed close')
    expect((await requests.get(key, saved.request_id))?.record.status).toBe('open')
  })
  it('preserves future/corrupt files and rejects mutated source hashes or selections on recovery', async () => {
    const { source, context } = await window(); const saved = await context.create({ source_id: source.source_id, delivery: 'origin' })
    const target = await requestFile(); const valid = await fs.readFile(target, 'utf8')
    for (const mutate of [(v: any) => v.version = 2, (v: any) => v.requests[0].extra = true, (v: any) => v.requests[0].source_sha256 = '0'.repeat(64), (v: any) => v.requests[0].selection.end--, (v: any) => v.requests[0].delivery.requester_friend_id = 'other-friend', (v: any) => v.requests[0].worker_ids = ['duplicate', 'duplicate']]) {
      const value = JSON.parse(valid); mutate(value); const corrupted = JSON.stringify(value); await fs.writeFile(target, corrupted)
      await expect(requests.get(key, saved.request_id)).rejects.toThrow()
      await expect(context.create({ source_id: source.source_id, delivery: 'origin' })).rejects.toThrow()
      expect(await fs.readFile(target, 'utf8')).toBe(corrupted)
    }
    await fs.writeFile(target, valid)
    const [folder] = await fs.readdir(directory); await fs.rm(path.join(directory, folder, 'request-sources.json'))
    await expect(requests.get(key, saved.request_id)).rejects.toThrow(/source/i)
  })
})
