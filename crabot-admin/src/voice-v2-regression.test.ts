import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256CanonicalJson, voiceSessionId, type Friend, type SubmitVoiceTurnParams } from 'crabot-shared'
import { VoiceTurnStore } from './voice-turn-store.js'
import { enrolledVoiceContact, revokedVoiceSample } from '../../tests/voice-fixture.js'

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-v2-'))
  const store = new VoiceTurnStore(dir); await store.load()
  const channel = 'voice-test', epoch = randomUUID(), turn = randomUUID(), session = voiceSessionId(channel)
  await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true })
  const params: SubmitVoiceTurnParams = { channel_id: channel, session_id: session, turn_id: turn, connection_epoch: epoch, enrollment_revision: 0,
    messages: ['speaker-0', 'speaker-1', 'speaker-0'].map((speaker, index) => ({ platform_message_id: turn + ':' + index,
      session: { channel_id: channel, session_id: session, type: 'group' }, sender: { platform_user_id: `unknown:${turn}:${speaker}`, platform_display_name: '陌生人' },
      content: { type: 'text', text: ['开灯', '别开', '好的'][index] }, features: { is_mention_crab: true, voice: { turn_id: turn, segment_index: index, start_sample: index * 32000, end_sample: (index + 1) * 32000, anonymous_speaker: speaker, identity_status: 'unknown' } }, platform_timestamp: new Date().toISOString() })) }
  return { dir, store, channel, epoch, params }
}
async function withFixture(test: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(); try { await test(f) } finally { await fs.rm(f.dir, { recursive: true, force: true }) }
}
describe('voice v2 ordinary strangers, stable contacts and authorized archive', () => {
  it('admits all anonymous texts with zero voice registrations in an enabled ordinary group', () => withFixture(async f => {
    const result = await f.store.submit(f.params, () => undefined, async () => true)
    expect(result.result.status).toBe('pending')
    expect(result.payload?.messages.map(m => m.message.content.text)).toEqual(['开灯', '别开', '好的'])
    expect(result.payload?.messages.every(m => !m.friend && !m.message.sender.friend_id)).toBe(true)
    expect(result.payload?.messages.map(m => m.message.sender.platform_user_id)).toEqual(f.params.messages.map(m => m.sender.platform_user_id))
  }))
  it('uses the ordinary group gate even when every speaker is a stranger', () => withFixture(async f => {
    expect((await f.store.submit(f.params, () => undefined, async () => false)).result.status).toBe('rejected')
    expect(f.store.pending()).toEqual([])
  }))
  it('keeps contacts across revoke and re-enrollment without persisting Friend bindings', () => withFixture(async f => {
    const { contact, registration: first } = await enrolledVoiceContact(f.store, f.channel, f.epoch, 'FuFu', 'campplus')
    await revokedVoiceSample(f.store, f.channel, first.registration_id)
    const result = await f.store.manage(f.channel, { request_id: randomUUID(), expected_revision: f.store.registrations(f.channel).enrollment_revision, command: { action: 'enroll', platform_user_id: contact.platform_user_id } }, 'campplus')
    const second = result.catalog.pending_enrollment!.registration
    expect(second.registration_id).not.toBe(first.registration_id)
    expect(second.platform_user_id).toBe(contact.platform_user_id)
    expect(f.store.registrations(f.channel).contacts).toEqual([contact])
    expect(await fs.readFile(path.join(f.dir, 'voice-turns.json'), 'utf8')).not.toContain('friend_id')
  }))
  it('uses current contact bindings on new turns, keeps an unbound matched speaker as stranger, and preserves historical authorization', () => withFixture(async f => {
    const { contact, registration: r, revision } = await enrolledVoiceContact(f.store, f.channel, f.epoch, 'FuFu', 'campplus')
    let binding: Friend | undefined
    const submit = async () => {
      const params = structuredClone(f.params), turn = randomUUID()
      params.turn_id = turn; params.enrollment_revision = revision
      params.messages.forEach((m, i) => {
        m.platform_message_id = `${turn}:${i}`; m.features.voice!.turn_id = turn
        if (i === 1) m.sender.platform_user_id = `unknown:${turn}:speaker-1`
        else { m.sender.platform_user_id = contact.platform_user_id; m.features.voice!.identity_status = 'matched'; m.features.voice!.registration_id = r.registration_id }
      })
      return f.store.submit(params, () => binding, async () => true)
    }
    expect((await submit()).payload?.messages.every(m => !m.friend)).toBe(true)
    binding = { id: 'master', permission: 'master', channel_identities: [{ channel_id: f.channel, platform_user_id: contact.platform_user_id }] } as Friend
    const historical = (await submit()).payload!
    expect(historical.messages.map(m => m.friend?.permission)).toEqual(['master', undefined, 'master'])
    binding = undefined
    expect((await submit()).payload?.messages.every(m => !m.friend)).toBe(true)
    binding = { id: 'other-friend', permission: 'normal', channel_identities: [{ channel_id: f.channel, platform_user_id: contact.platform_user_id }] } as Friend
    expect((await submit()).payload?.messages.map(m => m.friend?.id)).toEqual(['other-friend', undefined, 'other-friend'])
    expect(f.store.authorized(f.channel, historical.turn_id, historical.payload_sha256).messages[0].friend?.id).toBe('master')
  }))
  it('persists authorized text but never stores or restores a live reply context', () => withFixture(async f => {
    await f.store.submit(f.params, () => undefined, async () => true)
    const digest = sha256CanonicalJson(f.params)
    expect(Date.parse(f.store.authorized(f.channel, f.params.turn_id, digest).reply_context.expires_at)).toBeGreaterThan(Date.now())
    const disk = await fs.readFile(path.join(f.dir, 'voice-turns.json'), 'utf8')
    expect(disk).not.toContain('reply_context'); expect(disk).not.toContain('expires_at')
    const restored = new VoiceTurnStore(f.dir); await restored.load()
    expect(restored.authorized(f.channel, f.params.turn_id, digest).messages).toHaveLength(3)
    expect(Date.parse(restored.authorized(f.channel, f.params.turn_id, digest).reply_context.expires_at)).toBeLessThan(Date.now())
    expect(() => restored.authorized(f.channel, f.params.turn_id, 'a'.repeat(64))).toThrow()
    await restored.confirm(f.channel, f.params.turn_id, digest)
    expect(restored.authorized(f.channel, f.params.turn_id, digest).messages).toHaveLength(3)
  }))
  it('rejects a connection that expires while the ordinary group gate is resolving', () => withFixture(async f => {
    const result = await f.store.submit(f.params, () => undefined, async () => { f.store.disconnect(f.channel); return true })
    expect(result.result.status).toBe('rejected'); expect(f.store.pending()).toEqual([])
  }))
  it('admits uncertain identity as stranger and never lets it carry a candidate registration', () => withFixture(async f => {
    for (const m of f.params.messages) m.features.voice!.identity_status = 'uncertain'
    expect((await f.store.submit(f.params, () => undefined, async () => true)).payload?.messages.every(m => !m.friend)).toBe(true)
    const invalid = structuredClone(f.params); invalid.messages[0].features.voice!.registration_id = 'candidate'
    await expect(f.store.submit(invalid, () => undefined, async () => true)).rejects.toThrow()
  }))
  it('refuses old WIP archives without deleting them', () => withFixture(async f => {
    const file = path.join(f.dir, 'voice-turns.json'), old = JSON.stringify({ channels: {}, turns: {} })
    await fs.writeFile(file, old)
    await expect(new VoiceTurnStore(f.dir).load()).rejects.toThrow(/incompatible/i)
    expect(await fs.readFile(file, 'utf8')).toBe(old)
  }))
})
