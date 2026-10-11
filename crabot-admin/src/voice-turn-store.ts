import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { voiceSessionId, sha256CanonicalJson, validateSubmitVoiceTurn, type Friend, type SubmitVoiceTurnParams, type SyncVoiceTerminalParams, type VoiceContact, type VoiceRegistration, type VoiceReplyContext, type VoiceTurnAuthorizedPayload, type VoiceTurnResult } from 'crabot-shared'

type StoredPayload = Omit<VoiceTurnAuthorizedPayload, 'reply_context'>
type Turn = { result: VoiceTurnResult; payload?: StoredPayload }
type Channel = { enrollment_revision: number; contacts: Omit<VoiceContact, 'friend_id'>[]; registrations: VoiceRegistration[] }
type State = { version: 2; channels: Record<string, Channel>; turns: Record<string, Turn> }

export { voiceSessionId } from 'crabot-shared'
function key(channelId: string, turnId: string): string { return JSON.stringify([channelId, turnId]) }
function fail(message: string): never { throw Object.assign(new Error(message), { code: 'INVALID_PARAMS' }) }
function channel(state: State, id: string): Channel {
  if (!Object.prototype.hasOwnProperty.call(state.channels, id)) Object.defineProperty(state.channels, id, { value: { enrollment_revision: 0, contacts: [], registrations: [] }, enumerable: true, configurable: true, writable: true })
  return state.channels[id]
}

/** Durable authorized text outbox; realtime connection and reply opportunities never reach disk. */
export class VoiceTurnStore {
  private state: State = { version: 2, channels: {}, turns: {} }
  private readonly live = new Map<string, { epoch: string | null; foreground: boolean }>()
  private readonly contexts = new Map<string, VoiceReplyContext>()
  private serial: Promise<unknown> = Promise.resolve()
  private readonly filename: string
  constructor(dataDir: string) { this.filename = path.join(dataDir, 'voice-turns.json') }
  async load(): Promise<void> {
    try {
      const state = JSON.parse(await fs.readFile(this.filename, 'utf8')) as State
      if (state.version !== 2) throw new Error('Incompatible voice WIP store; use a separate v2 data directory')
      if (!state.channels || !state.turns || typeof state.channels !== 'object' || typeof state.turns !== 'object' || Object.values(state.channels).some(c => !Array.isArray(c.contacts) || !Array.isArray(c.registrations)) || Object.values(state.turns).some(t => t.payload && 'reply_context' in t.payload)) throw new Error('Corrupt voice turn store')
      this.state = state
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.live.clear(); this.contexts.clear()
  }
  registrations(channelId: string): Channel {
    return structuredClone(Object.prototype.hasOwnProperty.call(this.state.channels, channelId) ? this.state.channels[channelId] : { enrollment_revision: 0, contacts: [], registrations: [] })
  }
  async createContact(channelId: string, displayName: string): Promise<VoiceContact> {
    return this.change(state => {
      const contact = { platform_user_id: randomUUID(), display_name: displayName }
      channel(state, channelId).contacts.push(contact)
      return contact
    })
  }
  async enroll(channelId: string, platformUserId: string, modelId: string): Promise<VoiceRegistration> {
    return this.change(state => {
      const current = channel(state, channelId), contact = current.contacts.find(c => c.platform_user_id === platformUserId)
      if (!contact) fail('渠道联系人不存在')
      if (current.registrations.some(r => r.status === 'pending')) fail('当前仍有登记任务待完成，请先撤销该任务')
      if (current.registrations.some(r => r.status !== 'revoked' && r.platform_user_id === platformUserId)) fail('该联系人已经登记，请先删除旧声纹')
      const registration: VoiceRegistration = { registration_id: randomUUID(), display_name: contact.display_name, platform_user_id: platformUserId, model_id: modelId, status: 'pending', terminal_cleared: false }
      current.registrations.push(registration); current.enrollment_revision++
      return registration
    })
  }
  async revoke(channelId: string, registrationId: string): Promise<void> {
    await this.change(state => {
      const current = Object.prototype.hasOwnProperty.call(state.channels, channelId) ? state.channels[channelId] : undefined
      const registration = current?.registrations.find(r => r.registration_id === registrationId)
      if (!registration) fail('Unknown voice registration')
      if (registration.status !== 'revoked') { registration.status = 'revoked'; registration.terminal_cleared = false; current!.enrollment_revision++ }
    })
  }
  async sync(params: SyncVoiceTerminalParams): Promise<void> {
    if (params.completed_enrollment && params.cleared_registration) fail('One voice acknowledgement at a time')
    if (params.completed_enrollment || params.cleared_registration) {
      await this.change(state => {
        const current = Object.prototype.hasOwnProperty.call(state.channels, params.channel_id) ? state.channels[params.channel_id] : undefined
        const ack = params.completed_enrollment ?? params.cleared_registration!
        const registration = current?.registrations.find(r => r.registration_id === ack.registration_id)
        if (!current || !registration || ack.enrollment_revision !== current.enrollment_revision) fail('Stale voice enrollment acknowledgement')
        if (params.completed_enrollment) {
          if (registration.model_id !== params.completed_enrollment.model_id || !['pending', 'active'].includes(registration.status)) fail('Invalid voice enrollment task/model')
          registration.status = 'active'
        } else {
          if (registration.status !== 'revoked') fail('Registration has not been revoked')
          registration.terminal_cleared = true
        }
      })
    }
    if (!params.foreground || this.live.get(params.channel_id)?.epoch !== params.connection_epoch) this.contexts.delete(params.channel_id)
    this.live.set(params.channel_id, { epoch: params.connection_epoch, foreground: params.foreground })
  }
  connectionState(channelId: string): { epoch: string | null; foreground: boolean } | undefined {
    const state = this.live.get(channelId); return state ? { ...state } : undefined
  }
  disconnect(channelId: string): void { this.live.delete(channelId); this.contexts.delete(channelId) }
  private withContext(payload: StoredPayload): VoiceTurnAuthorizedPayload {
    const live = this.live.get(payload.channel_id), context = this.contexts.get(payload.channel_id)
    const valid = live?.foreground && live.epoch === payload.connection_epoch && context?.turn_id === payload.turn_id && Date.parse(context.expires_at) > Date.now()
    return { ...structuredClone(payload), reply_context: valid ? structuredClone(context!) : { channel_id: payload.channel_id, session_id: payload.session_id, turn_id: payload.turn_id, connection_epoch: payload.connection_epoch, expires_at: new Date(0).toISOString() } }
  }
  authorized(channelId: string, turnId: string, digest: string): VoiceTurnAuthorizedPayload {
    const turn = this.state.turns[key(channelId, turnId)]
    if (!turn?.payload || turn.result.payload_sha256 !== digest || !['pending', 'accepted'].includes(turn.result.status)) fail('Authorized voice turn does not match')
    return this.withContext(turn.payload)
  }
  pending(): VoiceTurnAuthorizedPayload[] {
    return Object.values(this.state.turns).filter(t => t.result.status === 'pending' && t.payload).map(t => this.withContext(t.payload!))
  }
  status(channelId: string, turnId: string, digest: string): VoiceTurnResult {
    const turn = this.state.turns[key(channelId, turnId)]
    if (!turn) return { status: 'unknown' }
    if (turn.result.payload_sha256 !== digest) return { status: 'rejected', reason: '同一轮 ID 的内容不一致' }
    return structuredClone(turn.result)
  }
  async submit(params: SubmitVoiceTurnParams, resolveFriend: (platformUserId: string) => Friend | undefined, checkGroup: () => Promise<boolean>): Promise<{ result: VoiceTurnResult; payload?: VoiceTurnAuthorizedPayload }> {
    validateSubmitVoiceTurn(params)
    const digest = sha256CanonicalJson(params)
    const submission = await this.change(async state => {
      const id = key(params.channel_id, params.turn_id), previous = state.turns[id]
      if (previous) {
        if (previous.result.payload_sha256 !== digest) return { result: { status: 'rejected' as const, reason: '同一轮 ID 的内容不一致' } }
        return { result: structuredClone(previous.result), ...(previous.result.status === 'pending' && previous.payload ? { payload: previous.payload } : {}) }
      }
      const current = Object.prototype.hasOwnProperty.call(state.channels, params.channel_id) ? state.channels[params.channel_id] : { enrollment_revision: 0, contacts: [], registrations: [] }
      const live = this.live.get(params.channel_id)
      let reason: string | undefined
      if (!live?.foreground || live.epoch !== params.connection_epoch) reason = '语音连接已失效'
      else if (params.session_id !== voiceSessionId(params.channel_id)) reason = '语音群 Session 不匹配'
      else if (current.enrollment_revision !== params.enrollment_revision) reason = '声纹登记版本已变化'
      else if (!await checkGroup()) reason = '语音群未满足现有群启用条件'
      const latest = this.live.get(params.channel_id)
      if (!reason && (!latest?.foreground || latest.epoch !== params.connection_epoch)) reason = '语音连接已失效'
      const messages: StoredPayload['messages'] = []
      if (!reason) for (const message of params.messages) {
        const voice = message.features.voice!
        if (voice.identity_status === 'matched') {
          const registration = current.registrations.find(r => r.registration_id === voice.registration_id && r.status === 'active')
          if (!registration || registration.platform_user_id !== message.sender.platform_user_id || !current.contacts.some(c => c.platform_user_id === registration.platform_user_id)) { reason = '声纹引用已失效或不属于该联系人'; break }
        } else if (message.sender.platform_user_id !== `unknown:${params.turn_id}:${voice.anonymous_speaker}`) { reason = '陌生人片段 ID 不匹配'; break }
        const friend = voice.identity_status === 'matched' ? resolveFriend(message.sender.platform_user_id) : undefined
        if (friend && !friend.channel_identities.some(ci => ci.channel_id === params.channel_id && ci.platform_user_id === message.sender.platform_user_id)) { reason = '联系人绑定不一致'; break }
        messages.push({ message: { ...structuredClone(message), sender: { ...message.sender, ...(friend ? { friend_id: friend.id } : {}) } }, ...(friend ? { friend: structuredClone(friend) } : {}) })
      }
      const result: VoiceTurnResult = { status: reason ? 'rejected' : 'pending', payload_sha256: digest, ...(reason ? { reason } : {}) }
      const payload: StoredPayload | undefined = reason ? undefined : { channel_id: params.channel_id, session_id: params.session_id, turn_id: params.turn_id, connection_epoch: params.connection_epoch, enrollment_revision: params.enrollment_revision, payload_sha256: digest, messages }
      state.turns[id] = { result, ...(payload ? { payload } : {}) }
      return { result, ...(payload ? { payload } : {}), newTurn: true }
    })
    if ('newTurn' in submission && submission.newTurn) {
      this.contexts.delete(params.channel_id)
      const live = this.live.get(params.channel_id)
      if (submission.payload && live?.foreground && live.epoch === params.connection_epoch) this.contexts.set(params.channel_id, { channel_id: params.channel_id, session_id: params.session_id, turn_id: params.turn_id, connection_epoch: params.connection_epoch, expires_at: new Date(Date.now() + 60000).toISOString() })
    }
    return { result: submission.result, ...(submission.payload ? { payload: this.withContext(submission.payload) } : {}) }
  }
  async confirm(channelId: string, turnId: string, digest: string): Promise<VoiceTurnResult> {
    return this.change(state => {
      const turn = state.turns[key(channelId, turnId)]
      if (!turn || turn.result.payload_sha256 !== digest || turn.result.status === 'rejected') fail('Voice turn confirmation does not match')
      turn.result.status = 'accepted'
      return structuredClone(turn.result)
    })
  }
  private async change<T>(update: (state: State) => T | Promise<T>): Promise<T> {
    const operation = this.serial.then(async () => {
      const state = structuredClone(this.state), result = await update(state)
      await fs.mkdir(path.dirname(this.filename), { recursive: true })
      const tmp = this.filename + '.' + randomUUID() + '.tmp'
      try { await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 }); await fs.rename(tmp, this.filename) }
      finally { await fs.rm(tmp, { force: true }) }
      this.state = state
      return result
    })
    this.serial = operation.catch(() => {})
    return operation
  }
}
