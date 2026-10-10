import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sha256CanonicalJson, validateSubmitVoiceTurn, type VoiceReplyContext, type VoiceTurnAuthorizedPayload } from 'crabot-shared'

type StoredPayload = Omit<VoiceTurnAuthorizedPayload, 'reply_context'>
export interface VoiceInboxRecord {
  channel_id: string
  turn_id: string
  payload_sha256: string
  accepted_at: string
  phase: 'accepted' | 'managed'
  confirmed: boolean
  payload?: StoredPayload
}

function validatePayload(payload: StoredPayload): void {
  if (!payload || !Array.isArray(payload.messages) || !payload.messages.length) throw new Error('Invalid authorized voice batch')
  const original = {
    channel_id: payload.channel_id, session_id: payload.session_id, turn_id: payload.turn_id, connection_epoch: payload.connection_epoch, enrollment_revision: payload.enrollment_revision,
    messages: payload.messages.map(({ message, friend }) => {
      if (!friend || message.sender.friend_id !== friend.id || !friend.channel_identities.some(ci => ci.channel_id === payload.channel_id && ci.platform_user_id === message.sender.platform_user_id)) throw new Error('Voice sender binding mismatch')
      const { friend_id, ...sender } = message.sender
      return { ...message, sender }
    }),
  }
  validateSubmitVoiceTurn(original)
  if (sha256CanonicalJson(original) !== payload.payload_sha256) throw new Error('Authorized voice digest mismatch')
}

/** Whole-turn durable ingress. A managed record keeps dedup facts; text belongs to Manager history. */
export class VoiceInbox {
  private readonly records = new Map<string, VoiceInboxRecord>()
  private readonly contexts = new Map<string, VoiceReplyContext>()
  constructor(private readonly directory: string) {}
  private key(channelId: string, turnId: string): string { return sha256CanonicalJson([channelId, turnId]) }
  load(): void {
    this.records.clear(); this.contexts.clear()
    if (!fs.existsSync(this.directory)) return
    for (const filename of fs.readdirSync(this.directory)) {
      if (!/^[0-9a-f]{64}\.json$/.test(filename)) continue
      const record = JSON.parse(fs.readFileSync(path.join(this.directory, filename), 'utf8')) as VoiceInboxRecord
      const key = this.key(record.channel_id, record.turn_id)
      if (filename !== key + '.json' || !['accepted', 'managed'].includes(record.phase) || typeof record.confirmed !== 'boolean' || !/^[0-9a-f]{64}$/.test(record.payload_sha256) || (record.phase === 'accepted' && !record.payload)) throw new Error('Corrupt voice ingress record')
      if (record.payload) {
        validatePayload(record.payload)
        if (record.payload.channel_id !== record.channel_id || record.payload.turn_id !== record.turn_id || record.payload.payload_sha256 !== record.payload_sha256) throw new Error('Corrupt voice ingress identity')
      }
      this.records.set(key, record)
    }
  }
  accept(payload: VoiceTurnAuthorizedPayload): VoiceInboxRecord {
    validatePayload(payload)
    const key = this.key(payload.channel_id, payload.turn_id)
    const existing = this.records.get(key)
    if (existing) {
      if (existing.payload_sha256 !== payload.payload_sha256) throw new Error('Conflicting authorized voice turn')
      return existing
    }
    const { reply_context, ...stored } = structuredClone(payload)
    const record: VoiceInboxRecord = { channel_id: payload.channel_id, turn_id: payload.turn_id, payload_sha256: payload.payload_sha256, accepted_at: new Date().toISOString(), phase: 'accepted', confirmed: false, payload: stored }
    this.write(key, record)
    if (reply_context?.channel_id === payload.channel_id && reply_context.session_id === payload.session_id && reply_context.turn_id === payload.turn_id && reply_context.connection_epoch === payload.connection_epoch && Date.parse(reply_context.expires_at) > Date.now() && Date.parse(reply_context.expires_at) <= Date.now() + 60000) this.contexts.set(key, reply_context)
    return record
  }
  pending(): VoiceInboxRecord[] {
    return [...this.records.values()].filter(r => r.phase === 'accepted' || !r.confirmed).sort((a, b) => a.accepted_at.localeCompare(b.accepted_at))
  }
  context(record: VoiceInboxRecord): VoiceReplyContext | undefined { return this.contexts.get(this.key(record.channel_id, record.turn_id)) }
  confirm(record: VoiceInboxRecord): void {
    this.write(this.key(record.channel_id, record.turn_id), { ...record, confirmed: true })
    record.confirmed = true
  }
  managed(record: VoiceInboxRecord): void {
    const key = this.key(record.channel_id, record.turn_id)
    const { payload, ...metadata } = record
    this.write(key, { ...metadata, phase: 'managed' })
    record.phase = 'managed'; delete record.payload
    this.contexts.delete(key)
  }
  private write(key: string, record: VoiceInboxRecord): void {
    fs.mkdirSync(this.directory, { recursive: true })
    const filename = path.join(this.directory, key + '.json')
    const tmp = filename + '.' + randomUUID() + '.tmp'
    try { fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 }); fs.renameSync(tmp, filename) }
    finally { fs.rmSync(tmp, { force: true }) }
    this.records.set(key, record)
  }
}
