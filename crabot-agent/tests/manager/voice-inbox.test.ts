import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256CanonicalJson, voiceSessionId, type SubmitVoiceTurnParams, type VoiceTurnAuthorizedPayload } from 'crabot-shared'
import { VoiceInbox } from '../../src/manager/voice-inbox.js'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-inbox-')); directories.push(dir)
  const channel = 'living-room', turn = randomUUID(), epoch = randomUUID(), session = voiceSessionId(channel)
  const request: SubmitVoiceTurnParams = { channel_id: channel, session_id: session, turn_id: turn, connection_epoch: epoch, enrollment_revision: 2,
    messages: ['A', 'B', 'A'].map((speaker, index) => ({
      platform_message_id: turn + ':' + index, session: { channel_id: channel, session_id: session, type: 'group' },
      sender: { platform_user_id: speaker, platform_display_name: speaker }, content: { type: 'text', text: ['开灯', '别开', '好的'][index] },
      features: { is_mention_crab: true, voice: { turn_id: turn, segment_index: index, start_sample: index * 32000, end_sample: (index + 1) * 32000, anonymous_speaker: speaker } }, platform_timestamp: new Date().toISOString(),
    })) }
  const payload: VoiceTurnAuthorizedPayload = { ...request, payload_sha256: sha256CanonicalJson(request),
    reply_context: { channel_id: channel, session_id: session, turn_id: turn, connection_epoch: epoch, expires_at: new Date(Date.now() + 50000).toISOString() },
    messages: request.messages.map(message => ({ message: { ...message, sender: { ...message.sender, friend_id: message.sender.platform_user_id } }, friend: {
      id: message.sender.platform_user_id, display_name: message.sender.platform_user_id, permission: message.sender.platform_user_id === 'A' ? 'master' : 'normal',
      channel_identities: [{ channel_id: channel, platform_user_id: message.sender.platform_user_id, platform_display_name: message.sender.platform_user_id }], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } })) }
  const inbox = new VoiceInbox(dir); inbox.load()
  return { dir, inbox, payload }
}
describe('durable whole voice batch ingress', () => {
  it('persists all A B A messages before confirmation and never restores a playback context', () => {
    const { dir, inbox, payload } = fixture(), record = inbox.accept(payload)
    expect(inbox.context(record)).toEqual(payload.reply_context)
    expect(fs.statSync(path.join(dir, fs.readdirSync(dir)[0])).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8')).not.toContain('expires_at')
    const restored = new VoiceInbox(dir); restored.load()
    expect(restored.pending()[0].payload?.messages.map(m => m.message.sender.friend_id)).toEqual(['A', 'B', 'A'])
    expect(restored.pending()[0].confirmed).toBe(false)
    expect(restored.context(restored.pending()[0])).toBeUndefined()
    restored.confirm(restored.pending()[0]); restored.managed(restored.pending()[0])
    const completed = new VoiceInbox(dir); completed.load()
    expect(completed.pending()).toEqual([])
    expect(completed.accept(payload)).toMatchObject({ phase: 'managed', confirmed: true })
  })
  it('refuses digest changes or corrupt persisted batches before Manager sees them', () => {
    const { dir, inbox, payload } = fixture()
    inbox.accept(payload)
    const conflict = structuredClone(payload); conflict.messages[1].message.content.text = '换了内容'
    expect(() => inbox.accept(conflict)).toThrow('digest')
    const file = path.join(dir, fs.readdirSync(dir)[0]), record = JSON.parse(fs.readFileSync(file, 'utf8'))
    record.payload.messages.pop(); fs.writeFileSync(file, JSON.stringify(record))
    expect(() => new VoiceInbox(dir).load()).toThrow('digest')
  })
  it('a failed disk write cannot turn into a runtime acknowledgement', () => {
    const { dir, payload } = fixture(), obstruction = path.join(dir, 'file')
    fs.writeFileSync(obstruction, '')
    const inbox = new VoiceInbox(obstruction)
    expect(() => inbox.accept(payload)).toThrow()
    expect(inbox.pending()).toEqual([])
  })
})
