import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { voiceSessionId, sha256CanonicalJson, validateSubmitVoiceTurn, validateVoiceManagementRequest, assertVoiceUuid, validateVoiceOwnerActivation, type VoiceOwnerActivation, type Friend, type SubmitVoiceTurnParams, type SyncVoiceTerminalParams, type VoiceTerminalContact, type VoiceCatalog, type VoiceEnrollmentTask, type VoiceManagementRequest, type VoiceManagementResult, type VoiceRegistration, type VoiceReplyContext, type VoiceTurnAuthorizedPayload, type VoiceTurnResult } from 'crabot-shared'

type StoredPayload = Omit<VoiceTurnAuthorizedPayload, 'reply_context'>
type Turn = { result: VoiceTurnResult; payload?: StoredPayload }
type Registration = VoiceRegistration & { task_revision?: number; completed_revision?: number; revoked_revision?: number }
type RequestResult = { digest: string; status: 'pending' | 'completed' | 'rejected'; code?: string; message?: string }
type Channel = { enrollment_revision: number; contacts: VoiceTerminalContact[]; unconfirmed_contacts: VoiceTerminalContact[]; registrations: Registration[]; task: { request_id: string; registration_id: string; revision: number; expires_at: string } | null; requests: Record<string, RequestResult> }
type State = { version: 3; channels: Record<string, Channel>; turns: Record<string, Turn> }

export { voiceSessionId } from 'crabot-shared'
function key(channelId: string, turnId: string): string { return JSON.stringify([channelId, turnId]) }
function fail(message: string): never { throw Object.assign(new Error(message), { code: 'INVALID_PARAMS' }) }
function channel(state: State, id: string): Channel {
  if (!Object.prototype.hasOwnProperty.call(state.channels, id)) Object.defineProperty(state.channels, id, { value: { enrollment_revision: 0, contacts: [], unconfirmed_contacts: [], registrations: [], task: null, requests: {} }, enumerable: true, configurable: true, writable: true })
  return state.channels[id]
}
function validateDirectory(c: Channel, legacy: boolean): void {
  if (!Number.isSafeInteger(c.enrollment_revision) || c.enrollment_revision < 0) throw new Error('Corrupt voice directory revision')
  if (!legacy && !Array.isArray(c.unconfirmed_contacts)) throw new Error('Corrupt voice management store')
  for (const contact of [...c.contacts, ...(legacy ? [] : c.unconfirmed_contacts)]) {
    assertVoiceUuid(contact.platform_user_id)
    if (typeof contact.display_name !== 'string' || !contact.display_name.trim() || contact.display_name.length > 128 || 'friend_id' in contact) throw new Error('Corrupt voice contact')
  }
  for (const r of c.registrations) {
    assertVoiceUuid(r.registration_id); assertVoiceUuid(r.platform_user_id)
    if (!['pending', 'active', 'revoked'].includes(r.status) || typeof r.terminal_cleared !== 'boolean' || typeof r.model_id !== 'string' || !r.model_id || typeof r.display_name !== 'string' || !r.display_name.trim()) throw new Error('Corrupt voice registration')
  }
  if (!legacy) {
    if (!c.requests || Array.isArray(c.requests) || typeof c.requests !== 'object') throw new Error('Corrupt voice management store')
    for (const [id, r] of Object.entries(c.requests)) { assertVoiceUuid(id); if (!/^[0-9a-f]{64}$/.test(r.digest) || !['pending', 'completed', 'rejected'].includes(r.status)) throw new Error('Corrupt voice management result') }
    if (c.task !== null && (!c.task || !Number.isFinite(Date.parse(c.task.expires_at)) || !Number.isSafeInteger(c.task.revision) || !c.registrations.some(r => r.registration_id === c.task!.registration_id && r.status === 'pending') || c.requests[c.task.request_id]?.status !== 'pending')) throw new Error('Corrupt voice enrollment task')
  }
}

/** Durable authorized text outbox; realtime connection and reply opportunities never reach disk. */
export class VoiceTurnStore {
  private state: State = { version: 3, channels: {}, turns: {} }
  private readonly live = new Map<string, { epoch: string | null; foreground: boolean }>()
  private readonly contexts = new Map<string, VoiceReplyContext>()
  private serial: Promise<unknown> = Promise.resolve()
  private readonly filename: string
  constructor(dataDir: string) { this.filename = path.join(dataDir, 'voice-turns.json') }
  async load(): Promise<void> {
    try {
      const original = await fs.readFile(this.filename, 'utf8')
      const state = JSON.parse(original) as State
      if (![2, 3].includes(state.version)) throw new Error('Incompatible voice WIP store; original data preserved')
      if (!state.channels || !state.turns || typeof state.channels !== 'object' || typeof state.turns !== 'object' || Object.values(state.channels).some(c => !Array.isArray(c.contacts) || !Array.isArray(c.registrations)) || Object.values(state.turns).some(t => t.payload && 'reply_context' in t.payload)) throw new Error('Corrupt voice turn store')
      for (const c of Object.values(state.channels)) validateDirectory(c, (state.version as number) === 2)
      if ((state.version as number) === 2) {
        for (const c of Object.values(state.channels)) {
          const activeIds = new Set(c.registrations.filter(r => r.status === 'active').map(r => r.platform_user_id))
          c.unconfirmed_contacts = c.contacts.filter(contact => !activeIds.has(contact.platform_user_id))
          c.contacts = c.contacts.filter(contact => activeIds.has(contact.platform_user_id))
          c.task = null; c.requests = {}; c.enrollment_revision++
          for (const r of c.registrations) if (r.status !== 'active') { r.status = 'revoked'; r.terminal_cleared = false; r.revoked_revision = c.enrollment_revision }
        }
        state.version = 3
        for (const c of Object.values(state.channels)) validateDirectory(c, false)
        try { await fs.writeFile(this.filename + '.v2.bak', original, { mode: 0o600, flag: 'wx' }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        await this.persist(state)
      }
      this.state = state
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.live.clear(); this.contexts.clear()
  }
  registrations(channelId: string): VoiceCatalog & { unconfirmed_contacts: VoiceTerminalContact[] } {
    const c = Object.prototype.hasOwnProperty.call(this.state.channels, channelId) ? this.state.channels[channelId] : undefined
    if (!c) return { enrollment_revision: 0, contacts: [], registrations: [], pending_enrollment: null, unconfirmed_contacts: [] }
    const registrations = c.registrations.map(({ task_revision, completed_revision, revoked_revision, ...r }) => r)
    const task = c.task
    const pending_enrollment: VoiceEnrollmentTask | null = task ? { registration: registrations.find(r => r.registration_id === task.registration_id)!, enrollment_revision: task.revision, expires_at: task.expires_at } : null
    return structuredClone({ enrollment_revision: c.enrollment_revision, contacts: c.contacts, registrations, pending_enrollment, unconfirmed_contacts: c.unconfirmed_contacts })
  }
  catalog(channelId: string): VoiceCatalog { const { unconfirmed_contacts, ...catalog } = this.registrations(channelId); return catalog }
  async commitOwnerIdentity(channelId: string, activation: VoiceOwnerActivation): Promise<void> {
    validateVoiceOwnerActivation(activation)
    await this.change(state => {
      const current = channel(state, channelId)
      const existing = current.registrations.find(value => value.registration_id === activation.registration_id)
      if (existing) {
        if (existing.platform_user_id !== activation.platform_user_id || existing.model_id !== activation.owner.model_id || existing.status !== 'active' || !current.contacts.some(value => value.platform_user_id === activation.platform_user_id)) fail('所有者登记与原操作冲突')
        return
      }
      if (current.task || current.contacts.length || current.unconfirmed_contacts.length || current.registrations.length) fail('首次认主目录已有身份，不能覆盖')
      current.enrollment_revision++
      const contact = { platform_user_id: activation.platform_user_id, display_name: activation.owner.display_name }
      current.contacts.push(contact)
      current.registrations.push({ registration_id: activation.registration_id, ...contact, model_id: activation.owner.model_id, status: 'active', terminal_cleared: false, completed_revision: current.enrollment_revision })
    })
  }
  hasContact(channelId: string, platformUserId: string): boolean { return this.registrations(channelId).contacts.some(c => c.platform_user_id === platformUserId) }
  managementResult(channelId: string, requestId: string): VoiceManagementResult {
    const current = Object.prototype.hasOwnProperty.call(this.state.channels, channelId) ? this.state.channels[channelId] : undefined
    const result = current && Object.prototype.hasOwnProperty.call(current.requests, requestId) ? current.requests[requestId] : undefined
    return { status: result?.status ?? 'unknown', catalog: this.catalog(channelId), ...(result?.code ? { code: result.code, message: result.message } : {}) }
  }
  private revokeSample(c: Channel, r: Registration): void {
    if (r.status !== 'revoked') { r.status = 'revoked'; r.terminal_cleared = false; r.revoked_revision = c.enrollment_revision }
  }
  private cancelTask(c: Channel, code: string, message: string): void {
    if (!c.task) return
    const task = c.task; c.enrollment_revision++
    this.revokeSample(c, c.registrations.find(r => r.registration_id === task.registration_id)!)
    Object.assign(c.requests[task.request_id], { status: 'rejected', code, message }); c.task = null
  }
  async expireEnrollment(channelId: string): Promise<void> {
    const c = Object.prototype.hasOwnProperty.call(this.state.channels, channelId) ? this.state.channels[channelId] : undefined
    if (c?.task && Date.parse(c.task.expires_at) <= Date.now()) await this.change(state => {
      const latest = channel(state, channelId)
      if (latest.task && Date.parse(latest.task.expires_at) <= Date.now()) this.cancelTask(latest, 'EXPIRED', '声纹登记任务已过期，请重新开始')
    })
  }
  async manage(channelId: string, request: VoiceManagementRequest, modelId: string, allowUnconfirmed = false, terminalEpoch?: string): Promise<VoiceManagementResult> {
    validateVoiceManagementRequest(request); await this.expireEnrollment(channelId)
    const digest = sha256CanonicalJson(request)
    await this.change(state => {
      if (terminalEpoch && (this.live.get(channelId)?.epoch !== terminalEpoch || !this.live.get(channelId)?.foreground)) throw Object.assign(new Error('仅当前前台配对终端可管理声纹'), { code: 'FORBIDDEN' })
      const c = channel(state, channelId)
      const previous = Object.prototype.hasOwnProperty.call(c.requests, request.request_id) ? c.requests[request.request_id] : undefined
      if (previous) { if (previous.digest !== digest) fail('同一管理请求 ID 的内容不一致'); return }
      const result: RequestResult = { digest, status: 'completed' }
      const reject = (code: string, message: string) => { Object.assign(result, { status: 'rejected', code, message }); c.requests[request.request_id] = result }
      if (c.enrollment_revision !== request.expected_revision) { reject('CONFLICT', '联系人目录已变化，请核对最新列表后重试'); return }
      const command = request.command
      const taskRegistration = c.task && c.registrations.find(r => r.registration_id === c.task!.registration_id)
      const deletingTask = command.action === 'delete_registration' && c.registrations.some(r => r.registration_id === command.registration_id && r.platform_user_id === taskRegistration?.platform_user_id)
      if (c.task && command.action !== 'cancel_enrollment' && !deletingTask) { reject('BUSY', '当前有声纹录入任务，请完成或取消'); return }
      if (command.action === 'enroll_new' || command.action === 'enroll') {
        const contact = command.action === 'enroll_new' ? { platform_user_id: randomUUID(), display_name: command.display_name.trim() } : [...c.contacts, ...(allowUnconfirmed ? c.unconfirmed_contacts : [])].find(contact => contact.platform_user_id === command.platform_user_id)
        if (!contact) { reject('NOT_FOUND', '正式渠道联系人不存在'); return }
        c.enrollment_revision++
        const registration: Registration = { registration_id: randomUUID(), ...contact, model_id: modelId, status: 'pending', terminal_cleared: false, task_revision: c.enrollment_revision }
        c.registrations.push(registration)
        c.task = { request_id: request.request_id, registration_id: registration.registration_id, revision: c.enrollment_revision, expires_at: new Date(Date.now() + 60000).toISOString() }
        result.status = 'pending'
      } else if (command.action === 'rename_contact') {
        const contact = c.contacts.find(contact => contact.platform_user_id === command.platform_user_id)
        if (!contact) { reject('NOT_FOUND', '正式渠道联系人不存在'); return }
        contact.display_name = command.display_name.trim(); c.enrollment_revision++
        for (const r of c.registrations) if (r.platform_user_id === contact.platform_user_id) r.display_name = contact.display_name
      } else {
        const registration = c.registrations.find(r => r.registration_id === command.registration_id)
        if (!registration || (command.action === 'cancel_enrollment' && c.task?.registration_id !== registration.registration_id)) { reject('NOT_FOUND', '声纹任务或样本不存在'); return }
        if (command.action === 'cancel_enrollment') this.cancelTask(c, 'CANCELLED', '声纹录入已取消')
        else {
          if (taskRegistration?.platform_user_id === registration.platform_user_id) this.cancelTask(c, 'CANCELLED', '声纹已删除，录入已取消')
          c.enrollment_revision++; this.revokeSample(c, registration)
        }
      }
      c.requests[request.request_id] = result
    })
    return this.managementResult(channelId, request.request_id)
  }
  async sync(params: SyncVoiceTerminalParams): Promise<void> {
    if (params.completed_enrollment && params.cleared_registration) fail('One voice acknowledgement at a time')
    await this.expireEnrollment(params.channel_id)
    if (params.completed_enrollment || params.cleared_registration) {
      await this.change(state => {
        const current = Object.prototype.hasOwnProperty.call(state.channels, params.channel_id) ? state.channels[params.channel_id] : undefined
        const ack = params.completed_enrollment ?? params.cleared_registration!
        const registration = current?.registrations.find(r => r.registration_id === ack.registration_id)
        if (!current || !registration || !params.foreground || this.live.get(params.channel_id)?.epoch !== params.connection_epoch) fail('Stale voice enrollment acknowledgement')
        if (params.completed_enrollment) {
          if (registration.model_id !== params.completed_enrollment.model_id || registration.task_revision !== ack.enrollment_revision) fail('Invalid voice enrollment task/model/revision')
          if (!registration.completed_revision) {
            const task = current.task
            if (!task || task.registration_id !== registration.registration_id || registration.status !== 'pending' || Date.parse(task.expires_at) <= Date.now()) fail('声纹登记任务已失效')
            current.enrollment_revision++
            for (const old of current.registrations) if (old.platform_user_id === registration.platform_user_id && old.status === 'active') this.revokeSample(current, old)
            if (!current.contacts.some(c => c.platform_user_id === registration.platform_user_id)) current.contacts.push({ platform_user_id: registration.platform_user_id, display_name: registration.display_name })
            current.unconfirmed_contacts = current.unconfirmed_contacts.filter(c => c.platform_user_id !== registration.platform_user_id)
            registration.status = 'active'; registration.completed_revision = current.enrollment_revision
            current.requests[task.request_id].status = 'completed'; current.task = null
          }
        } else {
          if (registration.status !== 'revoked' || ack.enrollment_revision < (registration.revoked_revision ?? 0) || ack.enrollment_revision > current.enrollment_revision) fail('Registration has not been revoked at this revision')
          if (!registration.terminal_cleared) { registration.terminal_cleared = true; current.enrollment_revision++ }
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
      await this.persist(state)
      this.state = state
      return result
    })
    this.serial = operation.catch(() => {})
    return operation
  }
  private async persist(state: State): Promise<void> {
    await fs.mkdir(path.dirname(this.filename), { recursive: true })
    const tmp = this.filename + '.' + randomUUID() + '.tmp'
    try { await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 }); await fs.rename(tmp, this.filename) }
    finally { await fs.rm(tmp, { force: true }) }
  }
}
