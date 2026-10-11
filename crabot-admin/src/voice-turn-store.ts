import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { voiceSessionId, sha256CanonicalJson, validateSubmitVoiceTurn, type Friend, type SubmitVoiceTurnParams, type SyncVoiceTerminalParams, type VoiceRegistration, type VoiceTurnAuthorizedPayload, type VoiceTurnResult } from 'crabot-shared'

type Turn = { result: VoiceTurnResult; payload?: VoiceTurnAuthorizedPayload }
type Channel = { enrollment_revision: number; registrations: VoiceRegistration[] }
type State = { channels: Record<string, Channel>; turns: Record<string, Turn> }

export { voiceSessionId } from 'crabot-shared'
function key(channelId: string, turnId: string): string { return JSON.stringify([channelId, turnId]) }
function fail(message: string): never { throw Object.assign(new Error(message), { code: 'INVALID_PARAMS' }) }

/** Durable authorized text outbox; realtime connection identity is deliberately never restored. */
export class VoiceTurnStore {
  private state: State = { channels: {}, turns: {} }
  private readonly live = new Map<string, { epoch: string | null; foreground: boolean }>()
  private serial: Promise<unknown> = Promise.resolve()
  private readonly filename: string
  constructor(dataDir: string) { this.filename = path.join(dataDir, 'voice-turns.json') }
  async load(): Promise<void> {
    try {
      const state = JSON.parse(await fs.readFile(this.filename, 'utf8')) as State
      if (!state.channels || !state.turns || typeof state.channels !== 'object' || typeof state.turns !== 'object') throw new Error('Corrupt voice turn store')
      this.state = state
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.live.clear()
  }
  registrations(channelId: string): Channel {
    return structuredClone(Object.prototype.hasOwnProperty.call(this.state.channels, channelId) ? this.state.channels[channelId] : { enrollment_revision: 0, registrations: [] })
  }
  async enroll(channelId: string, friendId: string, displayName: string, modelId: string): Promise<VoiceRegistration> {
    return this.change(state => {
      const channel = Object.prototype.hasOwnProperty.call(state.channels, channelId) ? state.channels[channelId] : { enrollment_revision: 0, registrations: [] }
      Object.defineProperty(state.channels, channelId, { value: channel, enumerable: true, configurable: true, writable: true })
      if (channel.registrations.some(r => r.status === 'pending')) fail('当前仍有登记任务待完成，请先撤销该任务')
      if (channel.registrations.some(r => r.status !== 'revoked' && r.friend_id === friendId)) fail('该成员已经登记')
      const registration: VoiceRegistration = { registration_id: randomUUID(), display_name: displayName, friend_id: friendId, model_id: modelId, status: 'pending', terminal_cleared: false }
      channel.registrations.push(registration); channel.enrollment_revision++
      return registration
    })
  }
  async revoke(channelId: string, registrationId: string): Promise<void> {
    await this.change(state => {
      const channel = Object.prototype.hasOwnProperty.call(state.channels, channelId) ? state.channels[channelId] : undefined
      const registration = channel?.registrations.find(r => r.registration_id === registrationId)
      if (!registration) fail('Unknown voice registration')
      if (registration.status !== 'revoked') { registration.status = 'revoked'; registration.terminal_cleared = false; channel!.enrollment_revision++ }
    })
  }
  async sync(params: SyncVoiceTerminalParams): Promise<void> {
    if (params.completed_enrollment && params.cleared_registration) fail('One voice acknowledgement at a time')
    if (params.completed_enrollment || params.cleared_registration) {
      await this.change(state => {
        const channel = Object.prototype.hasOwnProperty.call(state.channels, params.channel_id) ? state.channels[params.channel_id] : undefined
        const ack = params.completed_enrollment ?? params.cleared_registration!
        const registration = channel?.registrations.find(r => r.registration_id === ack.registration_id)
        if (!channel || !registration || ack.enrollment_revision !== channel.enrollment_revision) fail('Stale voice enrollment acknowledgement')
        if (params.completed_enrollment) {
          if (registration.model_id !== params.completed_enrollment.model_id || !['pending', 'active'].includes(registration.status)) fail('Invalid voice enrollment task/model')
          registration.status = 'active'
        } else {
          if (registration.status !== 'revoked') fail('Registration has not been revoked')
          registration.terminal_cleared = true
        }
      })
    }
    this.live.set(params.channel_id, { epoch: params.connection_epoch, foreground: params.foreground })
  }
  disconnect(channelId: string): void { this.live.delete(channelId) }
  pending(): VoiceTurnAuthorizedPayload[] {
    return Object.values(this.state.turns).filter(t => t.result.status === 'pending' && t.payload).map(t => structuredClone(t.payload!))
  }
  status(channelId: string, turnId: string, digest: string): VoiceTurnResult {
    const turn = this.state.turns[key(channelId, turnId)]
    if (!turn) return { status: 'unknown' }
    if (turn.result.payload_sha256 !== digest) return { status: 'rejected', reason: '同一轮 ID 的内容不一致' }
    return structuredClone(turn.result)
  }
  async submit(params: SubmitVoiceTurnParams, resolveFriend: (registrationId: string) => Friend | undefined): Promise<{ result: VoiceTurnResult; payload?: VoiceTurnAuthorizedPayload }> {
    validateSubmitVoiceTurn(params)
    const digest = sha256CanonicalJson(params)
    return this.change(state => {
      const id = key(params.channel_id, params.turn_id)
      const previous = state.turns[id]
      if (previous) {
        if (previous.result.payload_sha256 !== digest) return { result: { status: 'rejected' as const, reason: '同一轮 ID 的内容不一致' } }
        return { result: structuredClone(previous.result), ...(previous.result.status === 'pending' && previous.payload ? { payload: structuredClone(previous.payload) } : {}) }
      }
      const channel = Object.prototype.hasOwnProperty.call(state.channels, params.channel_id) ? state.channels[params.channel_id] : undefined
      const live = this.live.get(params.channel_id)
      let reason: string | undefined
      if (!live?.foreground || live.epoch !== params.connection_epoch) reason = '语音连接已失效'
      else if (params.session_id !== voiceSessionId(params.channel_id)) reason = '家庭群 Session 不匹配'
      else if (!channel || channel.enrollment_revision !== params.enrollment_revision) reason = '声纹登记版本已变化'
      const messages: VoiceTurnAuthorizedPayload['messages'] = []
      const anonymous = new Map<string, string>()
      if (!reason) for (const message of params.messages) {
        const registration = channel!.registrations.find(r => r.registration_id === message.sender.platform_user_id && r.status === 'active')
        const friend = registration && resolveFriend(registration.registration_id)
        if (!registration || !friend || friend.id !== registration.friend_id || !friend.channel_identities.some(ci => ci.channel_id === params.channel_id && ci.platform_user_id === registration.registration_id)) { reason = '本轮存在未知、未绑定或已撤销的说话者'; break }
        const speaker = message.features.voice!.anonymous_speaker
        if (anonymous.has(speaker) && anonymous.get(speaker) !== registration.registration_id) { reason = '同一匿名说话者身份有争议'; break }
        anonymous.set(speaker, registration.registration_id)
        messages.push({ message: { ...structuredClone(message), sender: { ...message.sender, friend_id: friend.id } }, friend: structuredClone(friend) })
      }
      const result: VoiceTurnResult = { status: reason ? 'rejected' : 'pending', payload_sha256: digest, ...(reason ? { reason } : {}) }
      const payload: VoiceTurnAuthorizedPayload | undefined = reason ? undefined : {
        channel_id: params.channel_id, session_id: params.session_id, turn_id: params.turn_id, connection_epoch: params.connection_epoch, enrollment_revision: params.enrollment_revision,
        payload_sha256: digest, messages,
        reply_context: { channel_id: params.channel_id, session_id: params.session_id, turn_id: params.turn_id, connection_epoch: params.connection_epoch, expires_at: new Date(Date.now() + 60000).toISOString() },
      }
      state.turns[id] = { result, ...(payload ? { payload } : {}) }
      return { result, ...(payload ? { payload } : {}) }
    })
  }
  async confirm(channelId: string, turnId: string, digest: string): Promise<VoiceTurnResult> {
    return this.change(state => {
      const turn = state.turns[key(channelId, turnId)]
      if (!turn || turn.result.payload_sha256 !== digest || turn.result.status === 'rejected') fail('Voice turn confirmation does not match')
      turn.result.status = 'accepted'
      return structuredClone(turn.result)
    })
  }
  private async change<T>(update: (state: State) => T): Promise<T> {
    const operation = this.serial.then(async () => {
      const state = structuredClone(this.state)
      const result = update(state)
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
