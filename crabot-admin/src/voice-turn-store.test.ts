import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256CanonicalJson, type Friend, type SubmitVoiceTurnParams } from 'crabot-shared'
import { voiceSessionId, VoiceTurnStore } from './voice-turn-store.js'

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-turns-'))
  const store = new VoiceTurnStore(dir); await store.load()
  const channel = '客厅'
  const epoch = randomUUID()
  const friends = new Map<string, Friend>()
  for (const name of ['A', 'B']) {
    const registration = await store.enroll(channel, name, name, 'campplus-v1')
    const revision = store.registrations(channel).enrollment_revision
    await store.sync({ channel_id: channel, connection_epoch: epoch, foreground: true, completed_enrollment: { registration_id: registration.registration_id, model_id: 'campplus-v1', enrollment_revision: revision } })
    friends.set(registration.registration_id, { id: name, display_name: name, permission: name === 'A' ? 'master' : 'normal', channel_identities: [{ channel_id: channel, platform_user_id: registration.registration_id, platform_display_name: name }], created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  }
  const turnId = randomUUID()
  const registrations = store.registrations(channel)
  const params: SubmitVoiceTurnParams = { channel_id: channel, session_id: voiceSessionId(channel), turn_id: turnId, connection_epoch: epoch, enrollment_revision: registrations.enrollment_revision, messages: ['A', 'B', 'A'].map((name, index) => ({ platform_message_id: turnId + ':' + index, session: { channel_id: channel, session_id: voiceSessionId(channel), type: 'group' }, sender: { platform_user_id: registrations.registrations.find(r => r.friend_id === name)!.registration_id, platform_display_name: name }, content: { type: 'text', text: ['开灯', '不要开', '好，那算了'][index] }, features: { is_mention_crab: true, voice: { turn_id: turnId, segment_index: index, start_sample: index * 32000, end_sample: (index + 1) * 32000, anonymous_speaker: name } }, platform_timestamp: new Date().toISOString() })) }
  return { dir, store, channel, epoch, friends, params, resolve: (id: string) => friends.get(id) }
}
describe('whole voice turn authorization and durable acknowledgement', () => {
  it('admits A B A together with ordinary group identity and survives pending/accepted restarts', async () => {
    const f = await fixture()
    try {
      const submission = await f.store.submit(f.params, f.resolve)
      expect(submission.result.status).toBe('pending')
      expect(submission.payload?.messages.map(m => m.message.sender.friend_id)).toEqual(['A', 'B', 'A'])
      expect(submission.payload?.messages.every(m => m.message.session.type === 'group')).toBe(true)
      const restored = new VoiceTurnStore(f.dir); await restored.load()
      expect(restored.pending()).toHaveLength(1)
      const hash = sha256CanonicalJson(f.params)
      expect(restored.status(f.channel, f.params.turn_id, hash).status).toBe('pending')
      await restored.confirm(f.channel, f.params.turn_id, hash)
      const final = new VoiceTurnStore(f.dir); await final.load()
      expect(final.status(f.channel, f.params.turn_id, hash).status).toBe('accepted')
      expect(final.pending()).toEqual([])
      expect((await final.submit(f.params, () => undefined)).result.status).toBe('accepted')
    } finally { await fs.rm(f.dir, { recursive: true, force: true }) }
  })
  it('rejects a complete turn when B is unknown, revoked or rebound, and never persists a partial authorized payload', async () => {
    for (const scenario of ['unknown', 'revoked', 'rebound']) {
      const f = await fixture()
      try {
        const id = f.params.messages[1].sender.platform_user_id
        if (scenario === 'unknown') f.params.messages[1].sender.platform_user_id = 'unknown:' + f.params.turn_id + ':B'
        if (scenario === 'revoked') { await f.store.revoke(f.channel, id); f.params.enrollment_revision = f.store.registrations(f.channel).enrollment_revision }
        if (scenario === 'rebound') f.friends.set(id, { ...f.friends.get(id)!, id: 'C' })
        const submission = await f.store.submit(f.params, f.resolve)
        expect(submission.result.status).toBe('rejected')
        expect(submission.payload).toBeUndefined()
        expect(f.store.pending()).toEqual([])
        expect(await fs.readFile(path.join(f.dir, 'voice-turns.json'), 'utf8')).not.toContain('不要开')
      } finally { await fs.rm(f.dir, { recursive: true, force: true }) }
    }
  })
  it('deduplicates concurrent submissions, refuses conflicting content, and does not restore a live epoch', async () => {
    const f = await fixture()
    try {
      const [a, b] = await Promise.all([f.store.submit(f.params, f.resolve), f.store.submit(f.params, f.resolve)])
      expect(a.result).toEqual(b.result); expect(f.store.pending()).toHaveLength(1)
      const changed = structuredClone(f.params); changed.messages[0].content.text = 'changed'
      expect((await f.store.submit(changed, f.resolve)).result.status).toBe('rejected')
      const restored = new VoiceTurnStore(f.dir); await restored.load()
      const newTurn = structuredClone(f.params); newTurn.turn_id = randomUUID()
      for (const m of newTurn.messages) { m.features.voice!.turn_id = newTurn.turn_id; m.platform_message_id = newTurn.turn_id + ':' + m.features.voice!.segment_index }
      expect((await restored.submit(newTurn, f.resolve)).result.reason).toMatch(/连接/)
      expect(restored.pending()).toHaveLength(1)
    } finally { await fs.rm(f.dir, { recursive: true, force: true }) }
  })
  it('requires the exact current registration task, model and revision for completion/clear', async () => {
    const f = await fixture()
    try {
      const id = f.params.messages[1].sender.platform_user_id
      await f.store.revoke(f.channel, id)
      const revision = f.store.registrations(f.channel).enrollment_revision
      await expect(f.store.sync({ channel_id: f.channel, connection_epoch: f.epoch, foreground: true, completed_enrollment: { registration_id: id, model_id: 'campplus-v1', enrollment_revision: revision } })).rejects.toThrow()
      await expect(f.store.sync({ channel_id: f.channel, connection_epoch: f.epoch, foreground: true, cleared_registration: { registration_id: id, enrollment_revision: revision - 1 } })).rejects.toThrow()
      await f.store.sync({ channel_id: f.channel, connection_epoch: f.epoch, foreground: true, cleared_registration: { registration_id: id, enrollment_revision: revision } })
      expect(f.store.registrations(f.channel).registrations.find(r => r.registration_id === id)).toMatchObject({ status: 'revoked', terminal_cleared: true })
    } finally { await fs.rm(f.dir, { recursive: true, force: true }) }
  })
})
