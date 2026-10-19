import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { voiceSessionId, type Friend, type VoiceAgentContext } from 'crabot-shared'
import { VoiceTurnStore } from './voice-turn-store.js'
import { VoiceAgentManagement } from './voice-agent-management.js'

let root: string, store: VoiceTurnStore, agent: VoiceAgentManagement, friends: Map<string, Friend>, context: VoiceAgentContext
let persist: ReturnType<typeof vi.fn>
const channel = 'voice-agent-fixture', epoch = randomUUID()
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-agent-api-')); store = new VoiceTurnStore(root); await store.load()
  await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true })
  const initial = await store.manage(channel, { request_id: randomUUID(), expected_revision: 0, command: { action: 'enroll_new', display_name: 'Synthetic owner' } }, 'fixture')
  const task = initial.catalog.pending_enrollment!, registration = task.registration
  await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: { registration_id: registration.registration_id, model_id: 'fixture', enrollment_revision: task.enrollment_revision } })
  const owner: Friend = { id: randomUUID(), display_name: 'Synthetic owner', permission: 'master', channel_identities: [{ channel_id: channel, platform_user_id: registration.platform_user_id }], created_at: '2026-10-17', updated_at: '2026-10-17' }
  friends = new Map([[owner.id, owner]])
  const turn = randomUUID(), messageId = turn + ':0'
  const admitted = await store.submit({ channel_id: channel, session_id: voiceSessionId(channel), connection_epoch: epoch, enrollment_revision: store.catalog(channel).enrollment_revision, turn_id: turn,
    messages: [{ platform_message_id: messageId, session: { channel_id: channel, session_id: voiceSessionId(channel), type: 'group' }, sender: { platform_user_id: registration.platform_user_id, platform_display_name: owner.display_name }, content: { type: 'text', text: '记住这位访客的声音' }, features: { is_mention_crab: true, voice: { turn_id: turn, segment_index: 0, start_sample: 0, end_sample: 32000, anonymous_speaker: 'speaker-0', identity_status: 'matched', registration_id: registration.registration_id } }, platform_timestamp: new Date().toISOString() }] }, () => owner, async () => true)
  await store.confirm(channel, turn, admitted.result.payload_sha256!)
  context = { delivery: 'origin' as const, request_id: 'a'.repeat(64), turn_id: turn, source: { source_id: randomUUID(), channel_id: channel, session_id: voiceSessionId(channel), session_type: 'group', platform_message_id: messageId, platform_user_id: registration.platform_user_id, sender_friend_id: owner.id } }
  persist = vi.fn(async (friend: Friend) => { friends.set(friend.id, structuredClone(friend)) })
  agent = new VoiceAgentManagement({ turns: store, modelId: 'fixture', isVoice: id => id === channel, verifyCore: async bearer => { if (bearer !== 'core-fixture') throw new Error('Exact core required') }, ready() {}, friends: () => [...friends.values()], persist,
    resolveFriend: (id, contact) => [...friends.values()].find(friend => friend.channel_identities.some(value => value.channel_id === id && value.platform_user_id === contact)) })
})
afterEach(async () => { vi.useRealTimers(); await fs.rm(root, { recursive: true, force: true }) })
const action = (input: object) => agent.action({ ...input, context }, 'core-fixture')
async function enroll() {
  const request = { request_id: randomUUID(), expected_revision: store.catalog(channel).enrollment_revision, command: { action: 'enroll_new', display_name: 'Synthetic guest' } }
  const result = await action({ action: 'manage', request }), task = result.catalog.pending_enrollment!
  return { request, result, task }
}
async function sample(task: NonNullable<ReturnType<VoiceTurnStore['catalog']>['pending_enrollment']>) {
  await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: { registration_id: task.registration.registration_id, model_id: 'fixture', enrollment_revision: task.enrollment_revision } })
}
it('requires exact core, verified original input and the same current Master; rejects self-selected authority', async () => {
  await expect(agent.action({ action: 'list', context }, 'child')).rejects.toThrow('core')
  await expect(agent.action({ action: 'list', context, permission: 'master' }, 'core-fixture')).rejects.toThrow('Unknown')
  await expect(agent.action({ action: 'list', context: { ...context, turn_id: randomUUID() } }, 'core-fixture')).rejects.toThrow('来源')
  friends.get(context.source.sender_friend_id!)!.permission = 'normal'
  await expect(action({ action: 'list' })).rejects.toThrow('Master')
})
it('queries are read-only; normal Friend and directory become usable only after the host commits', async () => {
  const { request, task } = await enroll(); await sample(task)
  expect((await action({ action: 'result', operation_id: request.request_id })).status).toBe('pending')
  expect(persist).not.toHaveBeenCalled(); expect(store.catalog(channel).contacts).toHaveLength(1)
  const done = await action({ action: 'commit', operation_id: request.request_id })
  expect(done.status).toBe('completed'); expect(done.contacts).toHaveLength(2)
  const guest = friends.get(done.friend_id!)!
  expect(guest.permission).toBe('normal'); expect(guest.channel_identities[0].platform_user_id).toBe(task.registration.platform_user_id)
  await action({ action: 'commit', operation_id: request.request_id })
  expect(friends.size).toBe(2); expect(persist).toHaveBeenCalledOnce()
  await action({ action: 'ack', operation_id: request.request_id }); expect(store.agentPending()).toEqual([])
})
it('refuses authority changes and operations belonging to another request', async () => {
  const { request, task } = await enroll(); await sample(task)
  await expect(agent.action({ action: 'result', context: { ...context, request_id: 'b'.repeat(64) }, operation_id: request.request_id }, 'core-fixture')).rejects.toThrow('原请求')
  friends.get(context.source.sender_friend_id!)!.permission = 'normal'
  await expect(action({ action: 'commit', operation_id: request.request_id })).rejects.toThrow('Master')
  expect(store.catalog(channel).contacts).toHaveLength(1); expect(persist).not.toHaveBeenCalled()
})
it('a lost friend-write result recovers under the same IDs and an accepted sample does not expire', async () => {
  const { request, task } = await enroll(); await sample(task)
  persist.mockImplementationOnce(async friend => { friends.set(friend.id, structuredClone(friend)); throw new Error('lost write result') })
  await expect(action({ action: 'commit', operation_id: request.request_id })).rejects.toThrow('lost')
  expect(store.catalog(channel).contacts).toHaveLength(1)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000)
  expect((await action({ action: 'commit', operation_id: request.request_id })).status).toBe('completed')
  expect(friends.size).toBe(2)
})
it('does not overwrite an existing same-channel Friend identity', async () => {
  const request = { request_id: randomUUID(), expected_revision: store.catalog(channel).enrollment_revision, command: { action: 'enroll_new', display_name: 'Other name' } }
  await expect(action({ action: 'manage', request, existing_friend_id: context.source.sender_friend_id })).rejects.toThrow('身份')
  expect(store.catalog(channel).pending_enrollment).toBeNull(); expect(friends.size).toBe(1)
})
it('rechecks a queued mutation after Master revocation', async () => {
  let release!: () => void
  const held = agent.serialize(() => new Promise<void>(resolve => { release = resolve }))
  await Promise.resolve()
  const pending = enroll()
  const denied = expect(pending).rejects.toThrow('Master')
  friends.get(context.source.sender_friend_id!)!.permission = 'normal'; release(); await held; await denied
  expect(store.catalog(channel).pending_enrollment).toBeNull(); expect(persist).not.toHaveBeenCalled()
})
it('does not cancel an uncertain Friend commit or replace its operation identity', async () => {
  const { request, task } = await enroll(); await sample(task)
  persist.mockImplementationOnce(async friend => { friends.set(friend.id, structuredClone(friend)); throw new Error('lost write result') })
  await expect(action({ action: 'commit', operation_id: request.request_id })).rejects.toThrow('lost')
  const cancelled = await action({ action: 'manage', request: { request_id: randomUUID(), expected_revision: store.catalog(channel).enrollment_revision,
    command: { action: 'cancel_enrollment', registration_id: task.registration.registration_id } } })
  expect(cancelled).toMatchObject({ status: 'rejected', code: 'COMMITTING' })
  expect((await action({ action: 'commit', operation_id: request.request_id })).status).toBe('completed'); expect(friends.size).toBe(2)
})
it('rename and revoke preserve Friend identity and report deferred terminal erasure truthfully', async () => {
  const { request, task } = await enroll(); await sample(task)
  const done = await action({ action: 'commit', operation_id: request.request_id }), friend = structuredClone(friends.get(done.friend_id!)!)
  const renamed = await action({ action: 'manage', request: { request_id: randomUUID(), expected_revision: store.catalog(channel).enrollment_revision,
    command: { action: 'rename_contact', platform_user_id: task.registration.platform_user_id, display_name: 'New channel name' } } })
  expect(renamed.contacts.find(item => item.platform_user_id === task.registration.platform_user_id)?.display_name).toBe('New channel name')
  const revoked = await action({ action: 'manage', request: { request_id: randomUUID(), expected_revision: store.catalog(channel).enrollment_revision,
    command: { action: 'delete_registration', registration_id: task.registration.registration_id } } })
  expect(revoked).toMatchObject({ status: 'completed', message: expect.stringContaining('清除尚待确认') })
  expect(friends.get(done.friend_id!)).toEqual(friend); expect(revoked.contacts).toHaveLength(2)
})
it('rerecord keeps the original active sample and Friend until the replacement is committed', async () => {
  const original = store.catalog(channel).registrations.find(item => item.status === 'active')!, friend = structuredClone(friends.get(context.source.sender_friend_id!)!)
  const request = { request_id: randomUUID(), expected_revision: store.catalog(channel).enrollment_revision, command: { action: 'enroll', platform_user_id: original.platform_user_id } }
  const pending = await action({ action: 'manage', request }), task = pending.catalog.pending_enrollment!
  await sample(task)
  expect(store.catalog(channel).registrations.find(item => item.registration_id === original.registration_id)?.status).toBe('active')
  await action({ action: 'commit', operation_id: request.request_id })
  expect(store.catalog(channel).registrations.filter(item => item.status === 'active').map(item => item.registration_id)).toEqual([task.registration.registration_id])
  expect(friends.get(friend.id)).toEqual(friend); expect(persist).not.toHaveBeenCalled()
})
it('associates only the explicit existing Friend and preserves its role, name and other identities', async () => {
  const existing: Friend = { id: randomUUID(), display_name: 'Same name elsewhere', permission: 'normal', channel_identities: [{ channel_id: 'other', platform_user_id: 'stable-other' }], created_at: 'old', updated_at: 'old' }
  friends.set(existing.id, existing)
  const request = { request_id: randomUUID(), expected_revision: store.catalog(channel).enrollment_revision, command: { action: 'enroll_new', display_name: 'Channel name' } }
  const pending = await action({ action: 'manage', request, existing_friend_id: existing.id }), task = pending.catalog.pending_enrollment!
  await sample(task)
  expect((await action({ action: 'commit', operation_id: request.request_id })).friend_id).toBe(existing.id)
  expect(friends.size).toBe(2)
  expect(friends.get(existing.id)).toMatchObject({ display_name: existing.display_name, permission: 'normal', channel_identities: [existing.channel_identities[0], { channel_id: channel, platform_user_id: task.registration.platform_user_id }] })
})
