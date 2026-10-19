import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { allowed, checkFileAccess, denied } from '../../src/permissions/tool-authorization.js'
import { TrustedHumanInputStore } from '../../src/manager/trusted-human-input-store.js'
import { ConversationRequestStore } from '../../src/manager/conversation-request-store.js'
import { ConversationRequestAuthority } from '../../src/manager/conversation-request-authority.js'
import type { ChannelMessage } from '../../src/types.js'
import type { RequestPermissionSource, ResolveRequestPermissionSourcesResult } from '../../src/manager/request-permission-sources.js'

const key = 'voice::shared' as const
const message: ChannelMessage = { platform_message_id: '1', session: { channel_id: 'voice', session_id: 'shared', type: 'group' }, sender: { platform_user_id: 'speaker-a', platform_display_name: 'A' }, content: { type: 'text', text: 'Read A and write B; use my permission if needed.' }, features: { is_mention_crab: true }, platform_timestamp: '2026-10-16T00:00:00.000Z' }
describe('Request authority checks the fixed ceiling and current full operation before side effects', () => {
  let directory: string, store: ConversationRequestStore, requestId: string
  let group: RequestPermissionSource, personal: RequestPermissionSource, current: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-authority-')); await fs.mkdir(path.join(directory, 'a')); await fs.mkdir(path.join(directory, 'b'))
    const source = (kind: 'group' | 'friend', subject: string, folder: string, access: 'read' | 'readwrite'): RequestPermissionSource => ({ kind, subject_id: subject, is_master: kind === 'friend', resolved: {
      tool_access: { memory: true, messaging: true, task: false, mcp_skill: false, file_io: true, browser: false, shell: false, remote_exec: false, desktop: false }, cli_access: { provider: 'none', agent: 'none', mcp: 'none', skill: 'none', schedule: 'none', channel: 'none', friend: 'none', permission: 'none', config: 'none', undo: 'none' }, storage: { workspace_path: path.join(directory, folder), access }, memory_scopes: [],
    } })
    group = source('group', key, 'a', 'read'); personal = source('friend', 'actual-a', 'b', 'readwrite')
    const inputs = new TrustedHumanInputStore(directory, { now: () => '2026-10-16T01:00:00.000Z', resolveSender: async () => ({ id: 'actual-a', permission: 'master', display_name: 'A', created_at: '', updated_at: '', channel_identities: [{ channel_id: 'voice', platform_user_id: 'speaker-a' }] }) })
    store = new ConversationRequestStore(directory, inputs, { now: () => '2026-10-16T01:00:00.000Z', resolveSources: async (): Promise<ResolveRequestPermissionSourcesResult> => ({ group, friend: personal }) })
    const captured = await inputs.capture(key, [message]); requestId = (await store.forInputs(key, captured).create({ source_id: captured[0].source_id, delivery: 'origin' })).request_id
    current = vi.fn(async (kind: 'group' | 'friend') => kind === 'group' ? group : personal)
  })
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }) })
  const file = (target: string, write: boolean) => (source: RequestPermissionSource) => checkFileAccess(source.resolved, target, '/', write)
  function authority(scope: 'group' | 'request' = 'request') { return new ConversationRequestAuthority(store, key, requestId, scope, current) }
  it('selects one complete source, supplies only its two validated snapshots, and performs the action once', async () => {
    const execute = vi.fn(async frame => { await fs.writeFile(path.join(directory, 'b/result'), 'authorized'); return frame })
    const frame = await authority().run(file(path.join(directory, 'b/result'), true), execute)
    expect(frame.request.request_id).toBe(requestId); expect(frame.source.sender_friend_id).toBe('actual-a')
    expect(frame.ceiling.kind).toBe('friend'); expect(frame.current.subject_id).toBe('actual-a')
    expect(execute).toHaveBeenCalledTimes(1); expect(await fs.readFile(path.join(directory, 'b/result'), 'utf8')).toBe('authorized')
  })
  it('prefers group without looking up personal authority and never gives shared execution personal fallback', async () => {
    const execute = vi.fn(async frame => frame.ceiling.kind)
    expect(await authority().run(file(path.join(directory, 'a/item'), false), execute)).toBe('group')
    expect(current.mock.calls.map(call => call[0])).toEqual(['group'])
    await expect(authority('group').run(file(path.join(directory, 'b/item'), true), execute)).rejects.toThrow(/PERMISSION_DENIED/)
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('refuses field-splicing and later widening while allowing a still valid unrelated source', async () => {
    const execute = vi.fn(async () => 'unexpected')
    await expect(authority().run(file(path.join(directory, 'a/item'), true), execute)).rejects.toThrow(/PERMISSION_DENIED/)
    personal.resolved.storage = { workspace_path: directory, access: 'readwrite' }
    await expect(authority().run(file(path.join(directory, 'outside'), true), execute)).rejects.toThrow(/PERMISSION_DENIED/)
    personal.resolved.tool_access.file_io = false
    expect(await authority().run(file(path.join(directory, 'a/item'), false), async () => 'still public')).toBe('still public')
    expect(execute).not.toHaveBeenCalled()
  })
  it('rechecks real current Master, ownership and lookup availability on every action', async () => {
    const onlyMaster = async (source: RequestPermissionSource) => source.is_master ? allowed : denied('PERMISSION_DENIED', 'Master required')
    const execute = vi.fn(async () => 'done')
    await authority().run(onlyMaster, execute); personal.is_master = false
    await expect(authority().run(onlyMaster, execute)).rejects.toThrow(/PERMISSION_DENIED/)
    personal.is_master = true; personal.subject_id = 'other-master'
    await expect(authority().run(onlyMaster, execute)).rejects.toThrow(/PERMISSION_DENIED/)
    current.mockRejectedValue(new Error('Admin unavailable'))
    await expect(authority().run(onlyMaster, execute)).rejects.toThrow(/CAPABILITY_UNKNOWN/)
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('a closed or missing request cannot run; closing during authorization prevents the delayed action', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const execute = vi.fn(async () => 'unexpected')
    current.mockImplementation(async () => { await waiting; return group })
    const pending = authority().run(async () => allowed, execute)
    await vi.waitFor(() => expect(current).toHaveBeenCalledTimes(1)); await store.close(key, requestId); release()
    await expect(pending).rejects.toThrow(/closed/)
    await expect(authority().run(async () => allowed, execute)).rejects.toThrow(/closed/)
    await expect(new ConversationRequestAuthority(store, 'voice::other', requestId, 'request', current).run(async () => allowed, execute)).rejects.toThrow(/not found/)
    expect(execute).not.toHaveBeenCalled()
  })
  it('does not replay failed or unknown external side effects or treat one action as request completion', async () => {
    const execute = vi.fn(async () => { await fs.writeFile(path.join(directory, 'b/result'), 'side effect'); throw new Error('lost external receipt') })
    await expect(authority().run(file(path.join(directory, 'b/result'), true), execute)).rejects.toThrow('lost external receipt')
    expect(execute).toHaveBeenCalledTimes(1); expect(await fs.readFile(path.join(directory, 'b/result'), 'utf8')).toBe('side effect')
    expect((await store.get(key, requestId))?.record.status).toBe('open')
  })
})
