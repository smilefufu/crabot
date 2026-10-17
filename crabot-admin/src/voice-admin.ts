import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RpcError, VOICE_MODEL_VERSIONS, assertVoiceUuid, validateVoiceDeviceOwner, validateVoiceOwnerSaved, type VoiceOwnerActivation, type VoiceCatalog, validateVoiceManagementRequest, type VoiceManagementRequest, type VoiceManagementResult, type SyncVoiceTerminalResult, type AudioServiceCapability, type Friend, type GetVoiceConfigResult, type SubmitVoiceTurnParams, type SyncVoiceTerminalParams, type VoiceAdminAction, type VoiceAdminActionResult, type VoiceTurnAuthorizedPayload, type VoiceTurnResult, voiceSetupStatus, voiceTerminalEntry, parseVoiceConnection, validateInstanceId, voiceSessionId, sha256CanonicalJson, type VoiceConnectionConfig, type VoiceInstanceConfig, type VoiceTerminalEntry, type VoiceSetupMetadata } from 'crabot-shared'
import { AudioServiceRegistry } from './audio-service-registry.js'
import type { ChannelInstance } from './types.js'
import { VoiceTurnStore } from './voice-turn-store.js'
import { VoiceOwnerStore } from './voice-owner-store.js'
import { commitVoiceOwnerMaster } from './voice-owner-master.js'
import { VoiceAgentManagement } from './voice-agent-management.js'

export interface VoiceAdminDeps {
  isVoice(channelId: string): boolean
  instance(id: string): ChannelInstance | undefined
  createInstance(name: string): Promise<ChannelInstance>
  resumeInstance(id: string): Promise<ChannelInstance>
  pauseInstance(id: string): Promise<ChannelInstance>
  saveSetup(id: string, setup: VoiceSetupMetadata, autoStart: boolean): Promise<ChannelInstance>
  fingerprint(): string | undefined
  terminalHosts(): string[]
  closeGateway(id: string): void
  admissionReady(): boolean
  ownerReady(): boolean
  friends(): Friend[]
  persistFriend(friend: Friend): Promise<void>
  verifyRuntime(channelId: string, bearer?: string): Promise<void>
  verifyCore(bearer?: string): Promise<void>
  verifyHuman(bearer?: string): Promise<void>
  resolveFriend(channelId: string, platformUserId: string): Friend | undefined
  checkGroup(channelId: string, sessionId: string): Promise<boolean>
  channelAction(channelId: string, command: VoiceAdminAction, bearer: string, ownerActivation?: VoiceOwnerActivation): Promise<VoiceAdminActionResult>
  publish(payload: VoiceTurnAuthorizedPayload): Promise<void>
  publishManagement?(payload: import('crabot-shared').VoiceAgentManagementReadyPayload): Promise<void>
  configurationChanged(): Promise<void>
  testAudio(channelId: string, capability: AudioServiceCapability): Promise<unknown>
  enrollmentModelId: string
}
function invalid(message: string): never { throw new RpcError('INVALID_PARAMS', message) }
function bodyObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Expected object')
  return raw as Record<string, unknown>
}
function requireFields(v: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(v).some(k => !allowed.includes(k))) invalid('Unknown voice field')
}

export class VoiceAdmin {
  readonly audio: AudioServiceRegistry
  readonly turns: VoiceTurnStore
  readonly owners: VoiceOwnerStore
  readonly agent: VoiceAgentManagement
  private ownerWrites: Promise<unknown> = Promise.resolve()
  private replayTimer?: ReturnType<typeof setInterval>
  private replaying = false
  private webWrites: Promise<unknown> = Promise.resolve()
  constructor(dataDir: string, private readonly deps: VoiceAdminDeps) {
    this.audio = new AudioServiceRegistry(dataDir)
    this.turns = new VoiceTurnStore(dataDir)
    this.owners = new VoiceOwnerStore(dataDir)
    this.agent = new VoiceAgentManagement({ turns: this.turns, modelId: deps.enrollmentModelId, isVoice: deps.isVoice,
      verifyCore: deps.verifyCore, ready: id => { if (!deps.ownerReady()) throw new RpcError('SERVICE_UNAVAILABLE', '好友数据尚未加载'); this.assertOwnerReady(id) },
      friends: deps.friends, persist: deps.persistFriend, resolveFriend: deps.resolveFriend })
  }
  async load(): Promise<void> { await this.audio.load(); await this.turns.load(); await this.owners.load() }
  start(): void {
    if (!this.replayTimer) this.replayTimer = setInterval(() => { void this.replayPending() }, 5000)
  }
  stop(): void { if (this.replayTimer) clearInterval(this.replayTimer); this.replayTimer = undefined }
  private assertChannel(id: unknown): asserts id is string {
    if (typeof id !== 'string' || !this.deps.isVoice(id)) invalid('Voice instance required')
  }
  async getConfig(raw: unknown, bearer?: string): Promise<GetVoiceConfigResult> {
    const v = bodyObject(raw); requireFields(v, ['channel_id']); this.assertChannel(v.channel_id)
    const channelId = v.channel_id
    this.assertChannel(channelId); await this.deps.verifyRuntime(channelId, bearer)
    await this.turns.expireEnrollment(channelId)
    const config = this.audio.getConfig(channelId)
    await this.legacyOwner(channelId)
    const metadata = this.visibleMetadata(channelId)
    const contacts = metadata.contacts.map(contact => { const friend = this.deps.resolveFriend(channelId, contact.platform_user_id); return { ...contact, ...(friend ? { friend_id: friend.id } : {}) } })
    return { config, owner_activation_required: this.ownerRequired(channelId), owner_activation: this.owners.get(channelId), setup_status: this.setupStatus(channelId), terminal_entry: this.terminalEntry(channelId), ...metadata, contacts, asr_connection: this.audio.resolve(config.asr, 'asr'), tts_connection: this.audio.resolve(config.tts, 'tts') }
  }
  async verifyAgent(raw: unknown, bearer?: string): Promise<{ verified: true }> {
    const v = bodyObject(raw); requireFields(v, ['channel_id']); this.assertChannel(v.channel_id)
    await this.deps.verifyCore(bearer); return { verified: true }
  }
  async verifyAgentRuntime(bearer?: string): Promise<void> { await this.deps.verifyCore(bearer) }
  async verifyHuman(raw: unknown, bearer?: string): Promise<{ verified: true }> {
    const v = bodyObject(raw); requireFields(v, ['channel_id']); this.assertChannel(v.channel_id)
    const channelId = v.channel_id
    this.assertChannel(channelId); await this.deps.verifyHuman(bearer); return { verified: true }
  }
  validateIdentity(channelId: string, platformUserId: string): void {
    if (!this.deps.isVoice(channelId)) return
    const activation = this.owners.get(channelId)
    if (!this.turns.hasContact(channelId, platformUserId) || activation?.status === 'pending' && activation.platform_user_id === platformUserId) throw new RpcError('INVALID_PARAMS', '语音身份尚未完成声纹登记，不能绑定好友')
  }
  private async managementCaller(raw: unknown, fields: string[], bearer?: string): Promise<Record<string, unknown>> {
    const v = bodyObject(raw); requireFields(v, fields); this.assertChannel(v.channel_id)
    await this.deps.verifyRuntime(v.channel_id, bearer); assertVoiceUuid(v.connection_epoch)
    const live = this.turns.connectionState(v.channel_id)
    if (!live?.foreground || live.epoch !== v.connection_epoch) throw new RpcError('FORBIDDEN', '仅当前前台配对终端可管理声纹')
    return v
  }
  async manageContacts(raw: unknown, bearer?: string): Promise<VoiceManagementResult> {
    const v = await this.managementCaller(raw, ['channel_id', 'connection_epoch', 'request'], bearer)
    validateVoiceManagementRequest(v.request)
    this.assertOwnerReady(v.channel_id as string)
    return this.agent.serialize(() => this.turns.manage(v.channel_id as string, v.request as VoiceManagementRequest, this.deps.enrollmentModelId, false, v.connection_epoch as string))
  }
  async managementResult(raw: unknown, bearer?: string): Promise<VoiceManagementResult> {
    const v = await this.managementCaller(raw, ['channel_id', 'connection_epoch', 'request_id'], bearer)
    assertVoiceUuid(v.request_id); await this.turns.expireEnrollment(v.channel_id as string)
    return { ...this.turns.managementResult(v.channel_id as string, v.request_id), catalog: this.visibleCatalog(v.channel_id as string) }
  }
  async sync(raw: unknown, bearer?: string): Promise<SyncVoiceTerminalResult> {
    const v = bodyObject(raw); requireFields(v, ['channel_id', 'connection_epoch', 'foreground', 'completed_enrollment', 'cleared_registration', 'owner_saved'])
    this.assertChannel(v.channel_id)
    await this.deps.verifyRuntime(v.channel_id, bearer)
    await this.agent.cancelUnauthorizedSampling()
    if (v.connection_epoch !== null) assertVoiceUuid(v.connection_epoch)
    if (typeof v.foreground !== 'boolean') invalid('Invalid foreground state')
    if (v.owner_saved !== undefined) {
      if (v.completed_enrollment !== undefined || v.cleared_registration !== undefined) invalid('Owner acknowledgement must be separate')
      validateVoiceOwnerSaved(v.owner_saved)
      const live = this.turns.connectionState(v.channel_id)
      if (!v.foreground || !live?.foreground || live.epoch !== v.connection_epoch) throw new RpcError('FORBIDDEN', '仅当前前台连接可确认所有者保存')
      await this.owners.acceptSaved(v.channel_id, v.owner_saved)
      await this.finalizeOwner(v.channel_id)
    }
    for (const field of ['completed_enrollment', 'cleared_registration']) if (v[field] !== undefined) {
      const ack = bodyObject(v[field]); requireFields(ack, field === 'completed_enrollment' ? ['registration_id', 'model_id', 'enrollment_revision'] : ['registration_id', 'enrollment_revision'])
      if (typeof ack.registration_id !== 'string' || !Number.isSafeInteger(ack.enrollment_revision) || (ack.enrollment_revision as number) < 0) invalid('Invalid registration acknowledgement')
      if (field === 'completed_enrollment') {
        if (typeof ack.model_id !== 'string') invalid('Invalid enrollment model')
      }
    }
    await this.agent.serialize(() => this.turns.sync(v as unknown as SyncVoiceTerminalParams))
    return { synced: true, catalog: this.visibleCatalog(v.channel_id), guided_enrollment: this.turns.guidedEnrollment(v.channel_id), owner_activation: this.owners.get(v.channel_id), setup_status: this.setupStatus(v.channel_id) }
  }
  async submit(raw: unknown, bearer?: string): Promise<VoiceTurnResult> {
    const v = bodyObject(raw); this.assertChannel(v.channel_id)
    await this.deps.verifyRuntime(v.channel_id, bearer)
    this.assertOwnerReady(v.channel_id)
    if (this.setupStatus(v.channel_id) !== 'complete') throw new RpcError('FORBIDDEN', '请先完成语音创建向导')
    if (!this.deps.admissionReady()) throw new RpcError('SERVICE_UNAVAILABLE', 'Core Agent is not ready')
    const { result, payload } = await this.turns.submit(v as unknown as SubmitVoiceTurnParams, id => this.deps.resolveFriend(v.channel_id as string, id), () => this.deps.checkGroup(v.channel_id as string, v.session_id as string))
    if (payload) await this.deps.publish(payload)
    if (result.status !== 'pending') return result
    // Publishing is not acceptance. Core must first persist the whole batch and confirm it.
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const status = this.turns.status(v.channel_id, v.turn_id as string, result.payload_sha256!)
      if (status.status !== 'pending') return status
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return this.turns.status(v.channel_id, v.turn_id as string, result.payload_sha256!)
  }
  async status(raw: unknown, bearer?: string): Promise<VoiceTurnResult> {
    const v = this.statusParams(raw); await this.deps.verifyRuntime(v.channel_id, bearer)
    return this.turns.status(v.channel_id, v.turn_id, v.payload_sha256)
  }
  async authorized(raw: unknown, bearer?: string): Promise<VoiceTurnAuthorizedPayload> {
    await this.deps.verifyCore(bearer)
    const v = this.statusParams(raw)
    return this.turns.authorized(v.channel_id, v.turn_id, v.payload_sha256)
  }
  async confirm(raw: unknown, bearer?: string): Promise<VoiceTurnResult> {
    const v = this.statusParams(raw); await this.deps.verifyCore(bearer)
    return this.turns.confirm(v.channel_id, v.turn_id, v.payload_sha256)
  }
  private statusParams(raw: unknown): { channel_id: string; turn_id: string; payload_sha256: string } {
    const v = bodyObject(raw); requireFields(v, ['channel_id', 'turn_id', 'payload_sha256']); this.assertChannel(v.channel_id); assertVoiceUuid(v.turn_id)
    if (typeof v.payload_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.payload_sha256)) invalid('Invalid voice payload digest')
    return v as { channel_id: string; turn_id: string; payload_sha256: string }
  }
  async replayPending(): Promise<void> {
    if (this.replaying) return
    this.replaying = true
    try {
      await this.turns.expireEnrollments()
      await this.agent.cancelUnauthorizedSampling()
      if (this.deps.ownerReady()) for (const record of this.owners.pendingBindings()) {
        try { await this.finalizeOwner(record.channel_id) } catch { /* Preserve pending facts for the original operation or explicit human recovery. */ }
      }
      if (!this.deps.admissionReady()) return
      for (const payload of this.turns.agentPending()) {
        try { await this.deps.publishManagement?.(payload) }
        catch { /* Original management result remains pending and queryable. */ }
      }
      for (const payload of this.turns.pending()) {
        try { await this.deps.publish(payload) }
        catch { console.warn('[Admin] Voice batch remains pending; publication will retry') }
      }
    } finally { this.replaying = false }
  }
  async action(channelId: string, raw: unknown, bearer: string): Promise<VoiceAdminActionResult> {
    this.assertChannel(channelId); await this.deps.verifyHuman(bearer)
    const v = bodyObject(raw)
    switch (v.action) {
      case 'status': requireFields(v, ['action']); break
      case 'revoke_terminal': requireFields(v, ['action']); await this.owners.pause(channelId); break
      case 'create_pairing': requireFields(v, ['action']); break
      case 'confirm_pairing': requireFields(v, ['action', 'pairing_id']); assertVoiceUuid(v.pairing_id); break
      case 'enroll_new': case 'enroll': case 'rename_contact': case 'delete_registration': case 'cancel_enrollment': {
        const { request_id, expected_revision, ...command } = v
        const request = { request_id, expected_revision, command }
        validateVoiceManagementRequest(request)
        this.assertOwnerReady(channelId)
        const result = await this.agent.serialize(() => this.turns.manage(channelId, request, this.deps.enrollmentModelId, true))
        if (result.status !== 'rejected') {
          try { await this.deps.channelAction(channelId, v as VoiceAdminAction, bearer) }
          catch { console.warn('[Admin] Voice directory committed; terminal notification awaits reconnection') }
        }
        return { action: command.action as VoiceManagementRequest['command']['action'], result }
      }
      default: invalid('Unknown voice management action')
    }
    let activation: VoiceOwnerActivation | undefined
    if (v.action === 'confirm_pairing' && this.ownerRequired(channelId) && this.owners.get(channelId)?.status !== 'completed') {
      if (!this.deps.ownerReady()) throw new RpcError('SERVICE_UNAVAILABLE', '好友数据尚未加载')
      const status = await this.deps.channelAction(channelId, { action: 'status' }, bearer)
      if (status.action !== 'status' || status.state.pairing_id !== v.pairing_id || !status.state.pairing_owner) invalid('请先扫描并核对当前设备所有者')
      const owner = status.state.pairing_owner
      validateVoiceDeviceOwner(owner)
      const masters = this.deps.friends().filter(friend => friend.permission === 'master')
      if (masters.length > 1) throw new RpcError('CONFLICT', '存在多个 Master，需先恢复好友数据')
      const master = masters[0], previous = this.owners.record(channelId)
      if (master?.channel_identities.some(identity => identity.channel_id === channelId && identity.platform_user_id !== previous?.activation.platform_user_id)) throw new RpcError('CONFLICT', 'Master 已有不同的同渠道身份')
      const target = previous?.target_friend_id ?? master?.id ?? randomUUID()
      if (previous && master && master.id !== target) throw new RpcError('CONFLICT', '原 Master 已变更')
      activation = await this.owners.prepareInitial(channelId, v.pairing_id as string, owner, target, previous?.create_master ?? !master)
    }
    const result = await this.deps.channelAction(channelId, v as unknown as VoiceAdminAction, bearer, activation)
    if (result.action === 'status') { result.state.hosts = this.deps.terminalHosts(); result.state.owner_activation = this.owners.get(channelId) }
    return result
  }
  private ownerRequired(id: string): boolean { return this.deps.instance(id)?.voice_setup?.owner_activation_required === true }
  private assertOwnerReady(id: string): void {
    if (this.ownerRequired(id) && this.owners.get(id)?.status !== 'completed') throw new RpcError('FORBIDDEN', '请先完成设备所有者关联')
  }
  private visibleMetadata(id: string): ReturnType<VoiceTurnStore['registrations']> {
    const metadata = this.turns.registrations(id), record = this.owners.record(id), activation = record?.activation
    if (activation?.status === 'pending' && record?.mode === 'initial') {
      metadata.contacts = metadata.contacts.filter(value => value.platform_user_id !== activation.platform_user_id)
      metadata.registrations = metadata.registrations.filter(value => value.registration_id !== activation.registration_id)
    }
    return metadata
  }
  private visibleCatalog(id: string): VoiceCatalog { const { unconfirmed_contacts, ...catalog } = this.visibleMetadata(id); return catalog }
  private async legacyOwner(id: string): Promise<void> {
    if (this.ownerRequired(id) || this.owners.get(id) || !this.deps.ownerReady()) return
    const masters = this.deps.friends().filter(friend => friend.permission === 'master')
    if (masters.length !== 1) return
    const identities = masters[0].channel_identities.filter(identity => identity.channel_id === id)
    if (identities.length !== 1) return
    const metadata = this.turns.registrations(id), identity = identities[0]
    if (!metadata.contacts.some(contact => contact.platform_user_id === identity.platform_user_id)) return
    const registrations = metadata.registrations.filter(value => value.platform_user_id === identity.platform_user_id && value.status === 'active' && value.model_id === this.deps.enrollmentModelId)
    if (registrations.length !== 1) return
    const registration = registrations[0]
    if (registration.model_id !== VOICE_MODEL_VERSIONS.embedding) return
    const owner = { profile_id: randomUUID(), display_name: registration.display_name, model_id: registration.model_id }
    try { validateVoiceDeviceOwner(owner) } catch { return }
    await this.owners.prepareLegacy(id, owner, masters[0].id, registration.platform_user_id, registration.registration_id)
  }
  private finalizeOwner(id: string): Promise<VoiceOwnerActivation> {
    const operation = this.ownerWrites.then(async () => {
      if (!this.deps.ownerReady()) throw new RpcError('SERVICE_UNAVAILABLE', '好友数据尚未加载')
      const record = this.owners.record(id)
      if (!record) throw new RpcError('NOT_FOUND', '所有者激活操作不存在')
      if (record.activation.status === 'completed') return record.activation
      if (record.mode === 'legacy' && this.turns.registrations(id).registrations.filter(value => value.platform_user_id === record.activation.platform_user_id && value.model_id === record.activation.owner.model_id && value.status === 'active').length !== 1) throw new RpcError('CONFLICT', '原所有者声纹已失效，需在 Admin 恢复')
      const friendId = await commitVoiceOwnerMaster(record, { friends: () => this.deps.friends(), persist: friend => this.deps.persistFriend(friend) })
      if (record.mode === 'initial') await this.turns.commitOwnerIdentity(id, record.activation)
      return this.owners.complete(id, friendId)
    })
    this.ownerWrites = operation.catch(() => undefined)
    return operation
  }
  private setupStatus(id: string): 'draft' | 'complete' {
    const instance = this.deps.instance(id)
    if (!instance) invalid('Voice instance required')
    return voiceSetupStatus(instance.voice_setup)
  }
  private connection(id: string): VoiceConnectionConfig | null {
    this.setupStatus(id)
    const value = this.deps.instance(id)!.voice_setup?.connection
    return value ? parseVoiceConnection(value) : null
  }
  private terminalEntry(id: string): VoiceTerminalEntry | null {
    const value = this.connection(id)
    return value ? voiceTerminalEntry(value, id, this.deps.fingerprint()) : null
  }
  private async createSetup(raw: unknown): Promise<ChannelInstance> {
    const v = bodyObject(raw); requireFields(v, ['name', 'config'])
    if (typeof v.name !== 'string') invalid('Instance name required')
    const validated = validateInstanceId(v.name)
    if (!validated.ok) invalid(validated.reason)
    const existing = this.deps.instance(validated.id)
    if (existing) {
      if (existing.implementation_id !== 'channel-voice' || this.setupStatus(existing.id) !== 'draft') invalid('该名称已被使用')
      return existing
    }
    const instance = await this.deps.createInstance(validated.id)
    // The persisted draft survives configuration/registration failure and is resumed by ID.
    await this.audio.saveConfig(instance.id, v.config)
    return instance
  }
  private async saveConnection(id: string, raw: unknown, bearer: string): Promise<VoiceConnectionConfig> {
    const value = parseVoiceConnection(raw), previous = this.connection(id)
    if (JSON.stringify(value) === JSON.stringify(previous)) return value
    const status = await this.deps.channelAction(id, { action: 'status' }, bearer)
    if (status.action !== 'status') invalid('Terminal status unavailable')
    if (status.state.paired) invalid('修改连接地址前请先撤销已配对终端')
    await this.deps.saveSetup(id, { ...this.deps.instance(id)!.voice_setup, status: this.setupStatus(id), connection: value }, this.deps.instance(id)!.auto_start)
    this.deps.closeGateway(id)
    // Updating the terminal entry clears the pending nonce on the owning Channel.
    await this.deps.configurationChanged()
    return value
  }
  private async finishSetup(id: string, bearer: string): Promise<ChannelInstance> {
    if (this.setupStatus(id) === 'complete') return this.deps.instance(id)!
    const snapshot = async (): Promise<string> => {
      this.assertOwnerReady(id)
      const state = await this.deps.channelAction(id, { action: 'status' }, bearer)
      const config = this.audio.getConfig(id), metadata = this.turns.registrations(id), live = this.turns.connectionState(id)
      if (state.action !== 'status' || !state.state.paired || !state.state.connected || !state.state.foreground || state.state.microphone !== 'closed' || state.state.playback !== 'idle' || state.state.pairing_id || !live?.epoch || !live.foreground) invalid('手机需保持前台连接，并关闭待机、录音和播放')
      if (metadata.registrations.some(r => r.status === 'pending')) invalid('请完成或撤销未完成的声纹登记')
      if (!this.connection(id)) invalid('请先保存手机连接地址')
      const asr = this.audio.resolve(config.asr, 'asr'), tts = this.audio.resolve(config.tts, 'tts')
      if (!asr || !tts || !config.wake_word.trim()) invalid('请先配置 ASR、TTS 和手机端唤醒词')
      if (!await this.deps.checkGroup(id, voiceSessionId(id))) invalid('请把语音渠道联系人绑定到现有 Master；语音群沿用现有群成员规则')
      return sha256CanonicalJson({ config, asr, tts, metadata, live, connection: this.connection(id), contacts: metadata.contacts.map(c => this.deps.resolveFriend(id, c.platform_user_id) ?? null) })
    }
    const before = await snapshot()
    for (const capability of ['asr', 'tts'] as const) {
      const result = await this.deps.testAudio(id, capability) as { ok?: boolean }
      if (result?.ok !== true) invalid(`${capability.toUpperCase()} 测试未通过`)
    }
    if (before !== await snapshot()) invalid('配置或手机状态已变化，请重新检查后完成')
    return this.deps.saveSetup(id, { ...this.deps.instance(id)!.voice_setup, status: 'complete', connection: this.connection(id)! }, true)
  }
  /** Human REST only. Internal runtime endpoints are never exported on this web surface. */
  async handleWeb(req: IncomingMessage, res: ServerResponse, pathname: string, readBody: () => Promise<unknown>): Promise<boolean> {
    if (!pathname.startsWith('/api/audio-services') && pathname !== '/api/channels/voice/setup' && !/^\/api\/channels\/[^/]+\/voice\//.test(pathname)) return false
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined
    const json = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    const execute = async () => {
      await this.deps.verifyHuman(bearer)
      if (pathname === '/api/channels/voice/setup') {
        if (req.method === 'POST') json(201, { instance: await this.createSetup(await readBody()) })
        else json(405, { error: 'Method not allowed' })
        return
      }
      const service = pathname.match(/^\/api\/audio-services(?:\/([^/]+))?$/)
      if (service) {
        const id = service[1] ? decodeURIComponent(service[1]) : undefined
        if (!id && req.method === 'GET') json(200, { items: this.audio.list() })
        else if (!id && req.method === 'POST') { const provider = await this.audio.saveProvider(await readBody()); await this.deps.configurationChanged(); json(201, { provider }) }
        else if (id && req.method === 'PUT') { const provider = await this.audio.saveProvider(await readBody(), id); await this.deps.configurationChanged(); json(200, { provider }) }
        else if (id && req.method === 'DELETE') { await this.audio.removeProvider(id); json(200, { deleted: true }) }
        else json(405, { error: 'Method not allowed' })
        return
      }
      const route = pathname.match(/^\/api\/channels\/([^/]+)\/voice\/(config|action|test|connection|setup\/(?:resume|pause|finish))$/)
      if (!route) { json(404, { error: 'Not found' }); return }
      const channelId = decodeURIComponent(route[1]); this.assertChannel(channelId)
      const operation = route[2]
      if (operation.startsWith('setup/') && req.method === 'POST') {
        requireFields(bodyObject(await readBody()), [])
        if (operation === 'setup/resume') json(200, { instance: await this.deps.resumeInstance(channelId) })
        else if (operation === 'setup/pause') { this.deps.closeGateway(channelId); this.turns.disconnect(channelId); json(200, { instance: await this.deps.pauseInstance(channelId) }) }
        else json(200, { instance: await this.finishSetup(channelId, bearer!) })
      } else if (operation === 'connection' && req.method === 'GET') json(200, this.connection(channelId))
      else if (operation === 'connection' && req.method === 'PUT') json(200, await this.saveConnection(channelId, await readBody(), bearer!))
      else if (operation === 'config' && req.method === 'GET') json(200, this.audio.getConfig(channelId))
      else if (operation === 'config' && req.method === 'PUT') { const config = await this.audio.saveConfig(channelId, await readBody()); await this.deps.configurationChanged(); json(200, config) }
      else if (operation === 'action' && req.method === 'POST') json(200, await this.action(channelId, await readBody(), bearer!))
      else if (operation === 'test' && req.method === 'POST') {
        const v = bodyObject(await readBody()); requireFields(v, ['capability'])
        if (v.capability !== 'asr' && v.capability !== 'tts') invalid('Invalid audio test capability')
        json(200, await this.deps.testAudio(channelId, v.capability))
      } else json(405, { error: 'Method not allowed' })
    }
    try {
      if (req.method === 'GET') await execute()
      else { const pending = this.webWrites.then(execute); this.webWrites = pending.catch(() => {}); await pending }
    } catch (error) {
      if (!res.writableEnded) {
        const code = (error as { code?: string }).code
        json(code === 'UNAUTHORIZED' ? 401 : code === 'FORBIDDEN' ? 403 : code === 'SERVICE_UNAVAILABLE' ? 503 : 400, { error: error instanceof Error ? error.message : 'Voice request failed' })
      }
    }
    return true
  }
}
