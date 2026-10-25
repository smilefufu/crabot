import path from 'node:path'
import { PlaybackReceipts } from './playback-receipts.js'
import { ReplyPlayback } from './reply-playback.js'
import { GuidedPlayback } from './guided-playback.js'
import type { VoiceGuidedEnrollment } from 'crabot-shared'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Server } from 'node:net'
import os from 'node:os'
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import { ModuleBase, RpcError, VoiceInputBuffer, VOICE_MODEL_VERSIONS, encodeVoiceFrame, parseVoiceClientControl, validateVoiceManagementRequest, VoiceProtocolVersionError, validateVoiceOwnerActivation, sha256CanonicalJson, assertVoiceUuid, transcribeAudio, voiceSessionId,
  type GetVoiceConfigResult, type ModuleConfig, type RpcHandlerContext, type SensitiveRpcMethod, type SubmitVoiceTurnParams, type SyncVoiceTerminalParams, type VoiceAdminActionParams, type VoiceAdminActionResult,
  type VoiceCatalog, type VoiceDeviceOwner, type VoiceManagementResult, type SyncVoiceTerminalResult, type VoiceOutputParams, type VoiceOutputResult, type VoicePlaybackContext, type VoiceOutputState, type GetVoiceOutputStateParams, type GetVoicePlaybackReceiptParams, type VoiceClientControl, type VoicePairing, type VoiceReplyContext, type VoiceServerControl, type VoiceTerminalState, type VoiceTurnResult } from 'crabot-shared'
import { TerminalStore } from './terminal-store.js'
import { voiceTransport } from './transport.js'

interface Connection {
  socket: WebSocket; epoch: string; foreground: boolean; lastHeartbeat: number
  speechEnabled: boolean; activity: VoiceOutputState['activity']
  microphone: VoiceTerminalState['microphone']; playback: VoiceTerminalState['playback']
  appliedRevision: number; confirmedRevision: number; helloSent: boolean
  input?: VoiceInputBuffer; processing?: AbortController; processingTurn?: string
}
interface ReplySlot { context: VoiceReplyContext; digest: string; responseId?: string }
function failed(message: string): never { throw new RpcError('CHANNEL_SEND_FAILED', message) }
function compatible(models: { segmentation: string; embedding: string }): boolean {
  return models.segmentation === VOICE_MODEL_VERSIONS.segmentation && models.embedding === VOICE_MODEL_VERSIONS.embedding
}
function sameOwner(a: VoiceDeviceOwner, b: VoiceDeviceOwner): boolean {
  return a.profile_id === b.profile_id && a.display_name === b.display_name && a.model_id === b.model_id
}
function fields(raw: unknown, allowed: string[]): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) throw new RpcError('INVALID_PARAMS', 'Invalid voice parameters')
}
function paginate<T>(items: T[], params: { pagination?: { page?: number; page_size?: number } } = {}) {
  const page = params.pagination?.page ?? 1, size = params.pagination?.page_size ?? 20
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 100) throw new RpcError('INVALID_PARAMS', 'Invalid pagination')
  return { items: items.slice((page - 1) * size, page * size), pagination: { page, page_size: size, total_items: items.length, total_pages: Math.ceil(items.length / size) } }
}

export class VoiceChannel extends ModuleBase {
  private guided?: VoiceGuidedEnrollment
  private guidedStep = 0
  private guidedPlayback?: { id: string; step: 1 | 2 | 3; player: GuidedPlayback }
  private readonly receipts: PlaybackReceipts
  private reservation?: { id: string; connection: Connection; finish(accepted: boolean): void }
  private readonly outputContexts = new Map<string, VoicePlaybackContext>()
  private readonly terminal: TerminalStore
  private settings!: GetVoiceConfigResult
  private connection?: Connection
  private pairing?: VoicePairing & { socket?: WebSocket; owner?: VoiceDeviceOwner }
  private reply?: ReplySlot
  private playback?: ReplyPlayback
  private readonly playbacks = new Map<string, ReplyPlayback>()
  private replyTimer?: ReturnType<typeof setTimeout>
  private syncTail: Promise<void> = Promise.resolve()
  private heartbeatSyncing = false
  private closeTransport?: () => void
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private stopped = false
  private adminPort?: number
  private readonly createdAt = new Date().toISOString()
  constructor(config: ModuleConfig, dataDirectory: string, private readonly runtimeBearer: string) {
    super(config)
    this.terminal = new TerminalStore(dataDirectory)
    this.receipts = new PlaybackReceipts(path.join(dataDirectory, 'playback-receipts'))
    this.registerMethod('voice_admin_action', (params: VoiceAdminActionParams, ctx?: RpcHandlerContext) => this.adminAction(params, ctx?.authorizationBearer))
    this.registerMethod('update_config', async () => { this.disconnect(); await this.refreshConfig(); return { updated: true } })
    this.registerMethod('get_capabilities', () => ({ supported_message_types: ['text'], supported_features: [], supports_history_query: false, supports_platform_user_query: true,
      max_message_length: 120, max_file_size: 0, supports_file_path: false, supports_list_contacts: true, supports_list_groups: true, supports_list_group_members: true,
      voice: { protocol_version: 9, send_timeout_ms: 30000 } }))
    this.registerMethod('get_sessions', async (params: { type?: string; pagination?: { page?: number; page_size?: number } }) => { await this.refreshConfig(); return paginate(params?.type === 'private' ? [] : [this.session()], params) })
    this.registerMethod('get_session', async (params: { session_id: string }) => { this.assertSession(params.session_id); await this.refreshConfig(); return { session: this.session() } })
    this.registerMethod('get_private_session', () => { throw new RpcError('CHANNEL_UNSUPPORTED_FEATURE', 'Voice has only a voice group') })
    this.registerMethod('list_contacts', async (params: { search?: string; pagination?: { page?: number; page_size?: number } }) => {
      await this.refreshConfig()
      return paginate(this.settings.contacts.filter(c => !params?.search || c.display_name.includes(params.search)).map(c => ({ platform_user_id: c.platform_user_id, display_name: c.display_name })), params)
    })
    this.registerMethod('list_groups', async (params: { search?: string; pagination?: { page?: number; page_size?: number } }) => {
      await this.refreshConfig()
      return paginate(!params?.search || '语音群'.includes(params.search) ? [{ platform_session_id: 'household', group_name: '语音群', member_count: this.boundContacts().length }] : [], params)
    })
    this.registerMethod('list_group_members', async (params: { session_id: string; pagination?: { page?: number; page_size?: number } }) => {
      this.assertSession(params.session_id); await this.refreshConfig()
      const members = this.boundContacts().map(c => ({ platform_user_id: c.platform_user_id, display_name: c.display_name, role: 'member' }))
      return { ...paginate(members, params), member_count: members.length, members_complete: true }
    })
    this.registerMethod('get_platform_user_info', async (params: { platform_user_id: string }) => {
      await this.refreshConfig()
      const contact = this.settings.contacts.find(c => c.platform_user_id === params.platform_user_id)
      if (!contact) throw new RpcError('NOT_FOUND', 'Voice contact not found')
      return { platform_user_id: contact.platform_user_id, display_name: contact.display_name }
    })
    this.registerMethod('get_history', () => { throw new RpcError('CHANNEL_HISTORY_UNAVAILABLE', 'Voice text history is owned by the conversation Manager') })
    this.registerMethod('get_message', () => { throw new RpcError('NOT_FOUND', 'Voice does not keep a second message archive') })
    this.registerMethod('send_message', () => { throw new RpcError('CHANNEL_UNSUPPORTED_FEATURE', '当前语音回复必须使用 voice_reply 标签') })
    this.registerMethod('voice_output', (params: VoiceOutputParams, ctx?: RpcHandlerContext) => this.voiceOutput(params, ctx?.authorizationBearer))
    this.registerMethod('get_voice_output_state', async (params: GetVoiceOutputStateParams, ctx?: RpcHandlerContext) => { fields(params, ['channel_id', 'session_id']); await this.verifyOutputTarget(params, ctx?.authorizationBearer); return this.outputState() })
    this.registerMethod('get_voice_playback_receipt', async (params: GetVoicePlaybackReceiptParams, ctx?: RpcHandlerContext) => {
      fields(params, ['channel_id', 'session_id', 'playback_id']); await this.verifyOutputTarget(params, ctx?.authorizationBearer)
      const receipt = this.receipts.get(params.playback_id, params.channel_id, params.session_id)
      const play = this.playbacks.get(params.playback_id)
      return play?.active ? { playback_id: params.playback_id, status: 'active', played_samples: play.playedSamples } : receipt
    })
  }
  protected override async onStart(): Promise<void> {
    if (!this.runtimeBearer) throw new Error('Voice runtime bearer is required')
    await this.terminal.load(); await this.refreshConfig()
    this.heartbeatTimer = setInterval(() => {
      const c = this.connection
      if (c && Date.now() - c.lastHeartbeat > 5000) this.disconnect()
      else if (c) { try { this.send(c.socket, { type: 'heartbeat' }); this.heartbeatSync() } catch { this.disconnect() } }
      if (this.pairing && Date.parse(this.pairing.expires_at) <= Date.now()) { this.pairing.socket?.terminate(); this.pairing = undefined }
    }, 2000)
  }
  protected override get listenHost(): string { return '127.0.0.1' }
  protected override createServer(rpc: (req: IncomingMessage, res: ServerResponse) => void): Server {
    const transport = voiceTransport(rpc, socket => this.connected(socket))
    this.closeTransport = transport.close
    return transport.server
  }
  protected override async onStop(): Promise<void> {
    this.stopped = true; if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.disconnect(); this.pairing?.socket?.terminate(); this.pairing = undefined; this.closeTransport?.()
  }
  private async admin<P, R>(method: SensitiveRpcMethod, params: P): Promise<R> {
    if (!this.adminPort) { const modules = await this.rpcClient.resolve({ module_type: 'admin' }, this.config.moduleId); if (!modules[0]) throw new Error('Admin is unavailable'); this.adminPort = modules[0].port }
    return this.rpcClient.callSensitive(this.adminPort, method, params, this.config.moduleId, { authorizationBearer: this.runtimeBearer, timeoutMs: 15000 })
  }
  private async refreshConfig(): Promise<void> {
    this.settings = await this.admin('get_voice_config', { channel_id: this.config.moduleId })
    if (this.pairing && (this.pairing.url !== this.settings.terminal_entry?.url || this.pairing.tls_fingerprint_sha256 !== this.settings.terminal_entry?.tls_fingerprint_sha256)) {
      this.pairing.socket?.terminate(); this.pairing = undefined
    }
  }
  private async sync(ack: Partial<SyncVoiceTerminalParams> = {}): Promise<void> {
    const c = this.connection
    const operation = this.syncTail.then(async () => {
      if (c !== this.connection) return
      const result = await this.admin<SyncVoiceTerminalParams, SyncVoiceTerminalResult>('sync_voice_terminal', { channel_id: this.config.moduleId, connection_epoch: c?.epoch ?? null, foreground: c?.foreground ?? false, ...ack })
      if (c !== this.connection) return
      const previousSetup = this.settings.setup_status
      this.settings.setup_status = result.setup_status
      const previousOwner = this.settings.owner_activation
      this.settings.owner_activation = result.owner_activation
      if (result.owner_activation?.status === 'completed' && this.terminal.pendingActivation === result.owner_activation.operation_id) await this.terminal.activate(result.owner_activation.operation_id)
      this.applyCatalog(result.catalog)
      if (c?.helloSent) {
        if (previousSetup !== result.setup_status) this.send(c.socket, { type: 'setup_status', status: result.setup_status })
        if (result.owner_activation && JSON.stringify(previousOwner) !== JSON.stringify(result.owner_activation)) this.send(c.socket, { type: 'owner_activation', activation: result.owner_activation })
        await this.reconcileGuided(c, result.guided_enrollment)
        this.pushCatalog(c)
      }
    })
    this.syncTail = operation.catch(() => {}); return operation
  }
  private heartbeatSync(): void {
    if (this.heartbeatSyncing) return
    this.heartbeatSyncing = true
    void this.sync().catch(() => this.disconnect()).finally(() => { this.heartbeatSyncing = false })
  }
  private catalog(): VoiceCatalog {
    return { enrollment_revision: this.settings.enrollment_revision, contacts: this.settings.contacts.map(({ platform_user_id, display_name }) => ({ platform_user_id, display_name })), registrations: this.settings.registrations, pending_enrollment: this.settings.pending_enrollment }
  }
  private async reconcileGuided(c: Connection, offer: VoiceGuidedEnrollment | null): Promise<void> {
    if (c !== this.connection) return
    if (this.guided) {
      const result = await this.admin<unknown, VoiceManagementResult>('get_voice_management_result', { channel_id: this.config.moduleId, connection_epoch: c.epoch, request_id: this.guided.operation_id })
      if (result.status === 'completed' || result.status === 'rejected') {
        const operationId = this.guided.operation_id
        this.guidedPlayback?.player.cancel(); this.guidedPlayback = undefined; this.guided = undefined
        this.send(c.socket, { type: 'guided_end', operation_id: operationId, status: result.status, message: result.message ?? (result.status === 'completed' ? '声音记录已登记完成' : '本次录入已结束') })
      }
      return
    }
    if (!offer || offer.connection_epoch !== c.epoch || !c.foreground || !c.speechEnabled || c.input || c.processing || this.playback || this.reservation || c.activity === 'recording') return
    this.cancelInteraction(); this.guided = offer; this.guidedStep = 0
    this.send(c.socket, { type: 'guided_enroll', enrollment: offer })
  }
  private async cancelGuided(c: Connection): Promise<void> {
    const guided = this.guided
    if (!guided) return
    this.guided = undefined; this.guidedPlayback?.player.cancel(); this.guidedPlayback = undefined
    try {
      await this.refreshConfig()
      if (this.settings.pending_enrollment?.registration.registration_id === guided.task.registration.registration_id) {
        await this.admin('manage_voice_contacts', { channel_id: this.config.moduleId, connection_epoch: c.epoch,
          request: { request_id: randomUUID(), expected_revision: this.settings.enrollment_revision, command: { action: 'cancel_enrollment', registration_id: guided.task.registration.registration_id } } })
      }
    } finally {
      if (c === this.connection) this.send(c.socket, { type: 'guided_end', operation_id: guided.operation_id, status: 'rejected', message: '本次录入已停止；麦克风关闭' })
    }
  }
  private playGuided(c: Connection, operationId: string, step: 1 | 2 | 3): void {
    const guided = this.guided
    if (!guided || guided.operation_id !== operationId || guided.connection_epoch !== c.epoch || !c.foreground || !c.speechEnabled
      || c.microphone !== 'closed' || this.guidedPlayback || !this.settings.tts_connection || Date.parse(guided.task.expires_at) <= Date.now()
      || step !== this.guidedStep && step !== this.guidedStep + 1) throw new Error('Guided capture is not ready')
    const lines = ['你好，这是我的第一段声音，请记住我的说话方式。', '我正在录入自己的声音，以后请认出是我在说话。', '很高兴认识你，以后我会经常和你聊天。', '今天的阳光很好，我想和你分享身边的事情。', '我会自然地说完这句话，请听听我的声音。', '现在我正在说话，这段录音会用来认识我。'].filter(text => !text.includes(this.settings.config.wake_word))
    if (lines.length < 3) throw new Error('Wake phrase conflicts with enrollment prompts')
    const text = (step === 1 ? `${guided.task.registration.display_name}，你好。我来记住你的声音，并登记为好友。愿意的话，` : '') + `请读：${lines[step - 1]}`
    const id = randomUUID(); this.guidedStep = step
    const player = new GuidedPlayback(this.settings.tts_connection, text, Date.parse(guided.task.expires_at), {
      valid: () => { if (this.connection !== c || this.guided !== guided || !c.foreground || !c.speechEnabled || c.microphone !== 'closed') throw new Error('Guided context expired') },
      start: () => this.send(c.socket, { type: 'guided_prompt_start', operation_id: operationId, step, playback_id: id, text }),
      audio: (sequence, pcm) => { if (c.socket.bufferedAmount > 50000) throw new Error('Guided audio queue full'); c.socket.send(encodeVoiceFrame(2, id, sequence, pcm)) },
      end: samples => this.send(c.socket, { type: 'guided_prompt_end', operation_id: operationId, playback_id: id, sample_count: samples }),
    })
    this.guidedPlayback = { id, step, player }
    void player.done.then(() => {
      if (this.guidedPlayback?.id !== id || this.guided !== guided || this.connection !== c || !c.foreground || !c.speechEnabled || Date.parse(guided.task.expires_at) <= Date.now()) return
      this.guidedPlayback = undefined
      this.send(c.socket, { type: 'guided_record', operation_id: operationId, step, playback_id: id })
    }).catch(() => { if (this.guided === guided && this.connection === c) void this.cancelGuided(c).catch(() => undefined) })
  }
  private applyCatalog(catalog: VoiceCatalog): void {
    if (catalog.enrollment_revision < this.settings.enrollment_revision) return
    const friends = new Map(this.settings.contacts.map(c => [c.platform_user_id, c.friend_id]))
    if (this.settings.enrollment_revision !== catalog.enrollment_revision && (this.connection?.input || this.connection?.processing)) {
      this.cancelInteraction()
      if (this.connection) this.send(this.connection.socket, { type: 'error', code: 'VOICE_DIRECTORY_CHANGED', message: '声纹目录已更新，请重新开始本轮' })
    }
    this.settings = { ...this.settings, ...catalog, contacts: catalog.contacts.map(c => ({ ...c, ...(friends.get(c.platform_user_id) ? { friend_id: friends.get(c.platform_user_id) } : {}) })) }
  }
  private pushCatalog(c: Connection): void {
    if (c.appliedRevision !== this.settings.enrollment_revision) this.send(c.socket, { type: 'catalog', catalog: this.catalog() })
    else this.confirmCatalog(c)
  }
  private confirmCatalog(c: Connection): void {
    if (c.appliedRevision !== this.settings.enrollment_revision || this.settings.registrations.some(r => r.status === 'revoked' && !r.terminal_cleared)) { c.confirmedRevision = -1; return }
    if (c.confirmedRevision !== c.appliedRevision) { c.confirmedRevision = c.appliedRevision; this.send(c.socket, { type: 'catalog_confirmed', enrollment_revision: c.confirmedRevision }) }
  }
  private assertSession(id: string): void { if (id !== voiceSessionId(this.config.moduleId)) throw new RpcError('NOT_FOUND', 'Voice group session not found') }
  private boundContacts() { return this.settings.contacts.filter(c => c.friend_id !== undefined) }
  private activeRegistrations() { return this.settings.registrations.filter(r => r.status === 'active') }
  private session() {
    return { id: voiceSessionId(this.config.moduleId), channel_id: this.config.moduleId, type: 'group', platform_session_id: 'household', title: '语音群',
      participants: this.boundContacts().map(c => ({ friend_id: c.friend_id!, platform_user_id: c.platform_user_id, role: 'member' })),
      permissions: { tool_access: { memory: true, messaging: true, task: false, mcp_skill: false, file_io: false, browser: false, shell: false, remote_exec: false, desktop: false }, storage: null },
      memory_scopes: [voiceSessionId(this.config.moduleId)], workspace_path: '', created_at: this.createdAt, updated_at: this.createdAt }
  }
  private state(): VoiceTerminalState {
    const c = this.connection
    return { owner_activation: this.settings.owner_activation, ...(this.pairing?.owner ? { pairing_owner: this.pairing.owner } : {}), paired: this.terminal.paired, connected: !!c, foreground: c?.foreground ?? false, microphone: c?.microphone ?? 'closed', playback: c?.playback ?? 'idle', aec_verified: false,
      enrollment_revision: this.settings.enrollment_revision, contacts: this.settings.contacts, registrations: this.settings.registrations,
      pending_enrollment: this.settings.pending_enrollment, unconfirmed_contacts: this.settings.unconfirmed_contacts,
      hosts: [...new Set(Object.values(os.networkInterfaces()).flatMap(addresses => (addresses ?? []).filter(a => !a.internal).map(a => a.family === 'IPv6' ? '[' + a.address + ']' : a.address)))],
      ...(this.pairing ? { pairing_id: this.pairing.pairing_id, ...(this.pairing.socket ? { verification_code: this.pairing.verification_code } : {}) } : {}) }
  }
  private async adminAction(raw: VoiceAdminActionParams, bearer?: string): Promise<VoiceAdminActionResult> {
    fields(raw, ['channel_id', 'command', 'owner_activation'])
    if (raw.channel_id !== this.config.moduleId || !bearer) throw new RpcError('UNAUTHORIZED', 'Human Admin is required')
    const modules = await this.rpcClient.resolve({ module_type: 'admin' }, this.config.moduleId)
    if (!modules[0]) throw new RpcError('SERVICE_UNAVAILABLE', 'Admin is unavailable')
    await this.rpcClient.callSensitive(modules[0].port, 'verify_voice_admin', { channel_id: this.config.moduleId }, this.config.moduleId, { authorizationBearer: bearer, timeoutMs: 3000 })
    const command = raw.command
    if (raw.owner_activation !== undefined) {
      if (command.action !== 'confirm_pairing') throw new RpcError('INVALID_PARAMS', 'Owner activation is only valid for pairing confirmation')
      validateVoiceOwnerActivation(raw.owner_activation)
    }
    switch (command.action) {
      case 'status': fields(command, ['action']); await this.refreshConfig(); return { action: 'status', state: this.state() }
      case 'create_pairing': {
        fields(command, ['action']); if (this.terminal.paired) throw new RpcError('INVALID_PARAMS', '请先撤销已有终端')
        await this.refreshConfig()
        if (!this.settings.terminal_entry) throw new RpcError('INVALID_PARAMS', '请先保存手机可访问的后台地址')
        this.pairing?.socket?.terminate()
        this.pairing = { protocol_version: 9, channel_id: this.config.moduleId, pairing_id: randomUUID(), ...this.settings.terminal_entry, nonce: randomBytes(32).toString('base64url'), verification_code: String(randomInt(100000, 1000000)), expires_at: new Date(Date.now() + 60000).toISOString() }
        return { action: 'create_pairing', pairing: { ...this.pairing } }
      }
      case 'confirm_pairing': {
        fields(command, ['action', 'pairing_id']); await this.refreshConfig(); const pairing = this.pairing
        if (!pairing?.socket || pairing.socket.readyState !== WebSocket.OPEN || pairing.pairing_id !== command.pairing_id || Date.parse(pairing.expires_at) <= Date.now()) throw new RpcError('INVALID_PARAMS', '配对核对已失效')
        const activation = raw.owner_activation
        if (this.settings.owner_activation_required && this.settings.owner_activation?.status !== 'completed') {
          const expected = this.settings.owner_activation
          if (!activation || !expected || activation.status !== 'pending' || activation.operation_id !== expected.operation_id || activation.registration_id !== expected.registration_id || activation.platform_user_id !== expected.platform_user_id || !pairing.owner || !sameOwner(activation.owner, pairing.owner) || !sameOwner(expected.owner, pairing.owner)) throw new RpcError('INVALID_PARAMS', '请重新核对设备所有者和原激活操作')
        } else if (activation) throw new RpcError('INVALID_PARAMS', '已有渠道不能重新认主')
        this.pairing = undefined
        let credential: string
        try { credential = await this.terminal.pair(activation?.operation_id) }
        catch (error) { if (!this.pairing && pairing.socket.readyState === WebSocket.OPEN && Date.parse(pairing.expires_at) > Date.now()) this.pairing = pairing; throw error }
        this.send(pairing.socket, { type: 'paired', credential, owner_activation: activation ?? null }); pairing.socket.close()
        return { action: 'confirm_pairing', confirmed: true }
      }
      case 'revoke_terminal': fields(command, ['action']); await this.terminal.revoke(); this.disconnect(); this.pairing?.socket?.terminate(); this.pairing = undefined; return { action: 'revoke_terminal', revoked: true }
      case 'enroll_new': case 'enroll': case 'rename_contact': case 'delete_registration': case 'cancel_enrollment': {
        const { request_id, expected_revision, ...management } = command
        validateVoiceManagementRequest({ request_id, expected_revision, command: management })
        if (command.action !== 'rename_contact') this.cancelInteraction()
        await this.refreshConfig()
        if (this.connection) {
          this.send(this.connection.socket, { type: 'catalog', catalog: this.catalog() })
          if ((command.action === 'enroll' || command.action === 'enroll_new') && this.settings.pending_enrollment && this.connection.foreground) this.send(this.connection.socket, { type: 'enroll', task: this.settings.pending_enrollment })
        }
        return { action: command.action, result: { status: this.settings.pending_enrollment ? 'pending' : 'completed', catalog: this.catalog() } }
      }
      default: throw new RpcError('INVALID_PARAMS', 'Invalid voice action')
    }
  }
  private send(socket: WebSocket, control: VoiceServerControl): void {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Terminal disconnected')
    if (socket.bufferedAmount > 50000) throw new Error('Terminal queue exceeds one second')
    const text = JSON.stringify(control)
    if (Buffer.byteLength(text) > 65536) throw new Error('Voice catalog exceeds control frame limit')
    socket.send(text)
  }
  private sendHello(c: Connection): void {
    this.send(c.socket, { type: 'hello', connection_epoch: c.epoch, setup_status: this.settings.setup_status, config: this.settings.config, catalog: this.catalog(), owner_activation: this.settings.owner_activation,
      destinations: [this.settings.asr_connection && { capability: 'asr' as const, ...this.settings.asr_connection }, this.settings.tts_connection && { capability: 'tts' as const, ...this.settings.tts_connection }].filter(Boolean).map(value => {
        const connection = value!; return { capability: connection.capability, endpoint: connection.endpoint }
      }) })
    c.helloSent = true
  }
  private connected(socket: WebSocket): void {
    let authenticated = false, pairingOnly = false, queue = Promise.resolve()
    const handshake = setTimeout(() => { if (!authenticated && !pairingOnly) socket.terminate() }, 5000)
    socket.on('error', () => {})
    socket.on('close', () => { clearTimeout(handshake); if (this.connection?.socket === socket) this.disconnect(); if (this.pairing?.socket === socket) this.pairing = undefined })
    const reject = (error?: unknown) => {
      try { this.send(socket, { type: 'error', code: error instanceof VoiceProtocolVersionError ? 'VOICE_VERSION_UNSUPPORTED' : 'VOICE_REJECTED', message: error instanceof VoiceProtocolVersionError ? error.message : '本轮无法继续，请检查连接、登记和音频状态' }) } catch { /* disconnected */ }
      socket.terminate()
    }
    socket.on('message', (raw: RawData, binary: boolean) => {
      try {
        const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)
        const control = binary ? undefined : parseVoiceClientControl(data.toString('utf8'))
        if (control?.type === 'heartbeat' && authenticated) {
          const c = this.connection; if (!c || c.socket !== socket) throw new Error('Connection changed')
          const wasReady = c.foreground && c.speechEnabled && c.activity === 'idle'
          c.lastHeartbeat = Date.now(); c.foreground = control.foreground; c.microphone = control.microphone; c.playback = control.playback; c.appliedRevision = control.enrollment_revision
          c.speechEnabled = control.speech_enabled; c.activity = control.activity
          if (!c.foreground || !c.speechEnabled) this.cancelInteraction()
          if ((!c.foreground || !c.speechEnabled) && this.guided) void this.cancelGuided(c).catch(() => undefined)
          if (!wasReady && c.foreground && c.speechEnabled && c.activity === 'idle') this.outputReady()
          this.heartbeatSync(); return
        }
        if (control?.type === 'cancel' && authenticated) {
          if (control.playback_id && control.playback_id !== this.playback?.id && control.playback_id !== this.reservation?.id) return
          if (control.turn_id && control.turn_id !== this.connection?.input?.turnId && control.turn_id !== this.connection?.processingTurn && control.turn_id !== this.reply?.context.turn_id) return
          this.cancelInteraction(); return
        }
        if (control?.type === 'playback_ready' && authenticated) { if (this.reservation?.connection.socket === socket && this.reservation.id === control.playback_id) this.reservation.finish(control.accepted); return }
        if (control?.type === 'playback' && authenticated) { this.playbackReceipt(control); return }
        if (control?.type === 'playback_progress' && authenticated) { if (this.connection?.socket === socket) this.playbacks.get(control.playback_id)?.progress(control.played_samples); return }
        queue = queue.then(async () => {
          if (!authenticated) {
            if (pairingOnly || binary || !control) throw new Error('Handshake required')
            if (control.type === 'pair') {
              const p = this.pairing
              if (this.terminal.paired || !p || p.socket || p.nonce !== control.nonce || Date.parse(p.expires_at) <= Date.now()) throw new Error('Pairing expired')
              p.socket = socket; p.owner = structuredClone(control.owner); p.nonce = ''; pairingOnly = true
              this.send(socket, { type: 'pair_waiting', pairing_id: p.pairing_id, verification_code: p.verification_code }); return
            }
            if (control.type !== 'hello' || !this.terminal.matches(control.credential) || !compatible(control.models) || this.connection) throw new Error('Terminal authentication/model mismatch')
            await this.refreshConfig()
            if (this.settings.owner_activation_required && this.settings.owner_activation?.status === 'pending' && control.owner && !sameOwner(control.owner, this.settings.owner_activation.owner)) throw new Error('Owner profile mismatch')
            if (this.stopped || socket.readyState !== WebSocket.OPEN || this.connection) throw new Error('Connection changed')
            this.connection = { socket, epoch: randomUUID(), foreground: false, speechEnabled: false, activity: 'idle', lastHeartbeat: Date.now(), microphone: 'closed', playback: 'idle', appliedRevision: -1, confirmedRevision: -1, helloSent: false }
            authenticated = true; clearTimeout(handshake); await this.sync(); this.sendHello(this.connection); return
          }
          const c = this.connection; if (!c || c.socket !== socket) throw new Error('Connection changed')
          if (binary) { if (!c.input) throw new Error('No ready turn'); c.input.append(data); data.fill(0); return }
          await this.control(c, control!)
        }).catch(reject)
      } catch (error) { reject(error) }
    })
  }
  private async control(c: Connection, control: VoiceClientControl): Promise<void> {
    switch (control.type) {
      case 'guided_prompt': await this.sync(); if (this.guided?.operation_id === control.operation_id) this.playGuided(c, control.operation_id, control.step); return
      case 'guided_playback':
        if (this.guided?.operation_id === control.operation_id && this.guidedPlayback?.id === control.playback_id) this.guidedPlayback.player.receipt(control.status, control.played_samples)
        return
      case 'guided_cancel': if (this.guided?.operation_id === control.operation_id) await this.cancelGuided(c); return
      case 'owner_saved': {
        if (!c.foreground) throw new Error('Foreground terminal required')
        try { await this.sync({ owner_saved: control.saved }) }
        catch {
          if (c === this.connection) this.send(c.socket, { type: 'error', code: 'VOICE_OWNER_PENDING', message: '手机声纹已保存，后台尚未完成联系人和 Master 关联；请重试同步，若仍失败请在后台处理' })
          return
        }
        if (c === this.connection && this.settings.owner_activation) this.send(c.socket, { type: 'owner_activation', activation: this.settings.owner_activation })
        return
      }
      case 'turn_start':
        if (!c.foreground || c.input || c.processing || this.playback || this.reservation) throw new Error('Voice is not ready')
        this.reply = undefined; await this.refreshConfig(); await this.sync()
        if (c.confirmedRevision !== this.settings.enrollment_revision || this.settings.pending_enrollment) { this.send(c.socket, { type: 'error', code: 'VOICE_CATALOG_NOT_READY', message: '请等待声纹目录同步或完成当前登记' }); return }
        if (this.settings.owner_activation_required && this.settings.owner_activation?.status !== 'completed') { this.send(c.socket, { type: 'error', code: 'VOICE_OWNER_NOT_READY', message: '请先完成设备所有者关联' }); return }
        if (this.settings.setup_status !== 'complete') { this.send(c.socket, { type: 'error', code: 'VOICE_REJECTED', message: '请先完成语音创建向导' }); return }
        if (!this.settings.asr_connection || !this.settings.tts_connection || !this.connection || this.connection !== c || !c.foreground) throw new Error('Voice configuration unavailable')
        c.input = new VoiceInputBuffer(control.turn_id); this.send(c.socket, { type: 'turn_ready', turn_id: control.turn_id }); return
      case 'turn_end': await this.completeTurn(c, control); return
      case 'turn_query': {
        const status = await this.admin<{ channel_id: string; turn_id: string; payload_sha256: string }, VoiceTurnResult>('get_voice_turn_status', { channel_id: this.config.moduleId, turn_id: control.turn_id, payload_sha256: control.payload_sha256 })
        this.send(c.socket, { type: 'turn_status', turn_id: control.turn_id, ...status }); return
      }
      case 'enrollment_done': {
        if (!c.foreground || control.model_id !== VOICE_MODEL_VERSIONS.embedding) throw new Error('Enrollment acknowledgement mismatch')
        await this.sync({ completed_enrollment: { registration_id: control.registration_id, model_id: control.model_id, enrollment_revision: control.enrollment_revision } }); return
      }
      case 'registration_cleared': await this.sync({ cleared_registration: { registration_id: control.registration_id, enrollment_revision: control.enrollment_revision } }); return
      case 'catalog_applied': c.appliedRevision = control.enrollment_revision; c.confirmedRevision = -1; await this.sync(); this.confirmCatalog(c); return
      case 'contact_action': {
        if (!c.foreground) throw new Error('Foreground terminal required')
        if (control.request.command.action !== 'rename_contact') this.cancelInteraction()
        await this.sync()
        const result = await this.admin<unknown, VoiceManagementResult>('manage_voice_contacts', { channel_id: this.config.moduleId, connection_epoch: c.epoch, request: control.request })
        if (c !== this.connection) return
        this.applyCatalog(result.catalog); this.send(c.socket, { type: 'contact_result', request_id: control.request.request_id, result }); return
      }
      case 'contact_action_query': {
        await this.sync()
        const result = await this.admin<unknown, VoiceManagementResult>('get_voice_management_result', { channel_id: this.config.moduleId, connection_epoch: c.epoch, request_id: control.request_id })
        if (c === this.connection) { this.applyCatalog(result.catalog); this.send(c.socket, { type: 'contact_result', request_id: control.request_id, result }) }; return
      }
      default: throw new Error('Unexpected terminal control')
    }
  }
  private async completeTurn(c: Connection, control: Extract<VoiceClientControl, { type: 'turn_end' }>): Promise<void> {
    const input = c.input
    if (!input || input.turnId !== control.turn_id || !c.foreground || !compatible(control.models) || control.enrollment_revision !== this.settings.enrollment_revision) throw new Error('Turn state/model/revision mismatch')
    const pcm = input.finish(control.audio_sample_count); c.input = undefined
    const controller = new AbortController(); c.processing = controller; c.processingTurn = control.turn_id
    const deadline = setTimeout(() => controller.abort(), 10000)
    let submittedDigest: string | undefined
    try {
      if (control.segments.some(s => s.identity_status === 'matched' && !this.activeRegistrations().some(r => r.registration_id === s.registration_id))) throw new Error('声纹引用已失效，请重说或重新登记')
      const messages: SubmitVoiceTurnParams['messages'] = []
      for (const segment of control.segments) {
        const text = await transcribeAudio(this.settings.asr_connection!, pcm.subarray(segment.start_sample * 2, segment.end_sample * 2), controller.signal)
        const registration = segment.identity_status === 'matched' ? this.activeRegistrations().find(r => r.registration_id === segment.registration_id) : undefined
        messages.push({ platform_message_id: control.turn_id + ':' + segment.segment_index, session: { channel_id: this.config.moduleId, session_id: voiceSessionId(this.config.moduleId), type: 'group' },
          sender: { platform_user_id: registration?.platform_user_id ?? `unknown:${control.turn_id}:${segment.anonymous_speaker}`, platform_display_name: registration?.display_name ?? `陌生人 (${segment.anonymous_speaker})` }, content: { type: 'text', text },
          features: { is_mention_crab: true, voice: { turn_id: control.turn_id, segment_index: segment.segment_index, start_sample: segment.start_sample, end_sample: segment.end_sample, anonymous_speaker: segment.anonymous_speaker, identity_status: segment.identity_status, ...(segment.registration_id ? { registration_id: segment.registration_id } : {}) } }, platform_timestamp: new Date().toISOString() })
      }
      controller.signal.throwIfAborted(); clearTimeout(deadline)
      if (this.connection !== c || !c.foreground) throw new Error('Terminal interaction ended')
      const params: SubmitVoiceTurnParams = { channel_id: this.config.moduleId, session_id: voiceSessionId(this.config.moduleId), turn_id: control.turn_id, connection_epoch: c.epoch, enrollment_revision: control.enrollment_revision, messages }
      const digest = sha256CanonicalJson(params)
      this.reply = { digest, context: { channel_id: params.channel_id, session_id: params.session_id, turn_id: params.turn_id, connection_epoch: c.epoch, expires_at: new Date(Date.now() + 60000).toISOString() } }
      const reply = this.reply
      this.replyTimer = setTimeout(() => { if (this.reply === reply) { this.send(c.socket, { type: 'error', code: 'VOICE_REPLY_EXPIRED', message: '本轮回答等待已结束', turn_id: reply.context.turn_id }); this.cancelInteraction() } }, 60000)
      submittedDigest = digest
      const result = await this.admin<SubmitVoiceTurnParams, VoiceTurnResult>('submit_voice_turn', params)
      if (result.status === 'rejected' && this.reply?.context.turn_id === control.turn_id) this.reply = undefined
      if (this.connection === c) this.send(c.socket, { type: 'turn_status', turn_id: control.turn_id, ...result, payload_sha256: result.payload_sha256 ?? digest })
    } catch (error) {
      if (!submittedDigest && this.reply?.context.turn_id === control.turn_id) this.reply = undefined
      if (this.connection === c) {
        let result: VoiceTurnResult = { status: 'rejected', reason: error instanceof Error ? error.message : '本轮失败' }
        if (submittedDigest) {
          try { result = await this.admin('get_voice_turn_status', { channel_id: this.config.moduleId, turn_id: control.turn_id, payload_sha256: submittedDigest }) }
          catch { result = { status: 'unknown', payload_sha256: submittedDigest, reason: '接纳状态暂时无法确认，请查询原轮次' } }
        }
        this.send(c.socket, { type: 'turn_status', turn_id: control.turn_id, ...result })
      }
    } finally { clearTimeout(deadline); pcm.fill(0); if (c.processing === controller) { c.processing = undefined; c.processingTurn = undefined } }
  }
  private assertReply(context: VoiceReplyContext): { c: Connection; slot: ReplySlot } {
    fields(context, ['channel_id', 'session_id', 'turn_id', 'connection_epoch', 'expires_at'])
    this.assertSession(context.session_id)
    const c = this.connection, slot = this.reply
    if (!c?.foreground || !slot || context.channel_id !== this.config.moduleId || context.turn_id !== slot.context.turn_id || context.connection_epoch !== c.epoch
      || !Number.isFinite(Date.parse(context.expires_at)) || Date.parse(context.expires_at) > Date.now() + 60000
      || (!slot.responseId && (Date.parse(context.expires_at) <= Date.now() || Date.parse(slot.context.expires_at) <= Date.now()))) failed('语音回答机会已结束，请重新开始')
    return { c, slot }
  }
  private async verifyOutputTarget(target: GetVoiceOutputStateParams, bearer?: string): Promise<void> {
    if (!target || target.channel_id !== this.config.moduleId) throw new RpcError('INVALID_PARAMS', 'Voice target differs')
    this.assertSession(target.session_id)
    if (!this.adminPort) await this.refreshConfig()
    await this.rpcClient.callSensitive(this.adminPort!, 'verify_voice_agent', { channel_id: this.config.moduleId }, this.config.moduleId, { authorizationBearer: bearer, timeoutMs: 3000 })
  }
  private outputState(): VoiceOutputState {
    const c = this.connection
    return { channel_id: this.config.moduleId, session_id: voiceSessionId(this.config.moduleId), connection_epoch: c?.epoch ?? null,
      foreground: c?.foreground ?? false, speech_enabled: c?.speechEnabled ?? false,
      activity: this.guided || this.settings?.pending_enrollment ? 'management' : c?.activity ?? 'idle', current_turn_id: this.reply?.context.turn_id ?? null }
  }
  private outputReady(): void {
    const c = this.connection
    if (!c || this.stopped) return
    void this.rpcClient.publishEvent({ id: randomUUID(), type: 'channel.voice_output_ready', source: this.config.moduleId, timestamp: new Date().toISOString(),
      payload: { channel_id: this.config.moduleId, session_id: voiceSessionId(this.config.moduleId), connection_epoch: c.epoch } }, this.config.moduleId).catch(() => {})
  }
  private assertOutput(context: VoicePlaybackContext, starting = false): Connection {
    fields(context, ['binding', 'connection_epoch', 'kind', 'turn_id'])
    fields(context.binding, ['channel_id', 'session_id', 'response_id', 'request_id', 'worker_id', 'worker_turn_id'])
    this.assertSession(context.binding.session_id)
    if (context.binding.channel_id !== this.config.moduleId || typeof context.binding.response_id !== 'string' || !context.binding.response_id
      || !['reply', 'notification'].includes(context.kind) || (!!context.binding.worker_id !== !!context.binding.worker_turn_id)) failed('Invalid voice delivery binding')
    const c = this.connection
    if (!c?.foreground || !c.speechEnabled || c.epoch !== context.connection_epoch || this.settings.setup_status !== 'complete' || this.settings.pending_enrollment || this.guided
      || c.input || (c.processing && (context.kind !== 'reply' || c.processingTurn !== context.turn_id)) || c.activity === 'management' || c.activity === 'recording') failed('终端暂时不适合发声')
    if (starting && (this.playback || this.reservation)) failed('播放忙')
    if (starting && context.kind === 'notification' && c.activity !== 'idle') failed('当前对话尚未结束')
    if (context.kind === 'reply' && (!context.turn_id || this.reply?.context.turn_id !== context.turn_id)) failed('当前回答已结束')
    if (context.kind === 'reply' && this.reply?.responseId && this.reply.responseId !== context.binding.response_id) failed('回应归属已变化')
    if (context.kind === 'reply' && !this.reply?.responseId && Date.parse(this.reply!.context.expires_at) <= Date.now()) failed('当前回答已过期')
    return c
  }
  private async preparePlayback(c: Connection, id: string, context: VoicePlaybackContext): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => finish(false), 3000)
      const finish = (accepted: boolean) => {
        if (settled) return
        settled = true; clearTimeout(timer)
        if (!accepted && this.reservation?.id === id) this.reservation = undefined
        if (accepted && this.connection === c) resolve(); else reject(new Error('Terminal refused playback reservation'))
      }
      this.reservation = { id, connection: c, finish }
      try { this.send(c.socket, { type: 'playback_prepare', playback_id: id, context }) }
      catch { finish(false) }
    })
  }
  private async voiceOutput(raw: VoiceOutputParams, bearer?: string): Promise<VoiceOutputResult> {
    fields(raw, ['voice_reply_context', 'delivery_context', 'event'])
    if (!!raw.voice_reply_context === !!raw.delivery_context) throw new RpcError('INVALID_PARAMS', 'Exactly one voice output context is required')
    const legacy = raw.voice_reply_context
    const context: VoicePlaybackContext = raw.delivery_context ?? {
      binding: { channel_id: legacy!.channel_id, session_id: legacy!.session_id, response_id: legacy!.turn_id },
      connection_epoch: legacy!.connection_epoch, kind: 'reply', turn_id: legacy!.turn_id,
    }
    await this.verifyOutputTarget(context.binding, bearer)
    const event = raw.event
    let eventFields = ['type', 'playback_id']
    if (event.type === 'pending_results') eventFields = ['type', 'count']
    else if (event.type === 'response_end') eventFields = ['type']
    else if (event.type === 'reply_text') eventFields = ['type', 'playback_id', 'sequence', 'text']
    fields(event, eventFields)
    if (event.type === 'pending_results') {
      if (!Number.isSafeInteger(event.count) || event.count < 0) throw new RpcError('INVALID_PARAMS', 'Invalid pending count')
      if (!this.connection || this.connection.epoch !== context.connection_epoch) failed('终端连接已变化')
      this.send(this.connection.socket, { type: 'pending_results', count: event.count })
      return { accepted: true }
    }
    if (event.type === 'response_end') {
      const c = this.assertOutput(context)
      if (this.playback) failed('播放尚未收口')
      if (context.kind === 'reply') { this.send(c.socket, { type: 'response_end', turn_id: context.turn_id! }); this.reply = undefined }
      if (this.replyTimer) clearTimeout(this.replyTimer)
      this.outputReady()
      return { accepted: true }
    }
    if (!['reply_start', 'reply_text', 'reply_end', 'reply_cancel'].includes(event.type)) throw new RpcError('INVALID_PARAMS', '非法播放事件')
    assertVoiceUuid(event.playback_id)
    let play = this.playbacks.get(event.playback_id)
    if (event.type === 'reply_cancel') { play?.cancel('runtime取消播报'); return { accepted: true } }
    if (event.type === 'reply_start') {
      if (play) {
        if (JSON.stringify(this.outputContexts.get(event.playback_id)) !== JSON.stringify(context)) failed('播放归属冲突')
        return { accepted: true }
      }
      const c = this.assertOutput(context, true)
      if (context.kind === 'reply') {
        const slot = this.reply!
        if (legacy) this.assertReply(legacy)
        const status = await this.admin<unknown, VoiceTurnResult>('get_voice_turn_status', { channel_id: this.config.moduleId, turn_id: context.turn_id!, payload_sha256: slot.digest })
        if (status.status !== 'accepted') failed('本轮尚未持久接纳')
      }
      if (!this.settings.tts_connection || !this.terminal.receiptIdentity) failed('TTS或终端不可用')
      await this.preparePlayback(c, event.playback_id, context)
      try {
        this.assertOutput(context)
        if (this.reservation?.id !== event.playback_id || this.reservation.connection !== c) failed('播放预留已失效')
        if (context.kind === 'reply') { this.reply!.responseId = context.binding.response_id; if (this.replyTimer) clearTimeout(this.replyTimer); this.replyTimer = undefined }
        if (context.kind === 'notification') { if (this.replyTimer) clearTimeout(this.replyTimer); this.replyTimer = undefined; this.reply = undefined }
        this.receipts.prepare(event.playback_id, this.terminal.receiptIdentity, context.binding)
        play = new ReplyPlayback(event.playback_id, this.settings.tts_connection, {
          valid: () => { this.assertOutput(context); if (c.socket.bufferedAmount > 50000) failed('播放队列已满') },
          text: (sequence, text) => this.send(c.socket, { type: 'playback_text', playback_id: event.playback_id, sequence, text }),
          audio: (sequence, pcm) => c.socket.send(encodeVoiceFrame(2, event.playback_id, sequence, pcm)),
          end: (_text, sample_count, text_segment_count) => { this.receipts.ending(event.playback_id, sample_count); this.send(c.socket, { type: 'playback_end', playback_id: event.playback_id, sample_count, text_segment_count }) },
          cancel: () => { try { this.send(c.socket, { type: 'playback_cancel', playback_id: event.playback_id }) } catch { /* closing */ } },
        })
        this.playback = play; this.playbacks.set(event.playback_id, play); this.outputContexts.set(event.playback_id, structuredClone(context))
        const done = play.done.then(result => {
          const receipt = this.receipts.report({ playback_id: event.playback_id, status: 'completed', played_samples: result.played_samples }, this.terminal.receiptIdentity!)
          if (receipt?.status !== 'completed') throw new Error('Playback completion was not saved')
          if (this.connection === c) this.send(c.socket, { type: 'playback_confirmed', playback_id: event.playback_id })
          this.outputReady(); return { ...result, sent_at: receipt.sent_at! }
        }).finally(() => {
          if (this.playback === play) this.playback = undefined
          if (this.connection === c) c.playback = 'idle'
          this.playbacks.delete(event.playback_id); this.outputContexts.delete(event.playback_id)
          if (!this.playback && this.connection === c && this.reply?.responseId === context.binding.response_id) {
            if (this.replyTimer) clearTimeout(this.replyTimer)
            const reply = this.reply
            this.replyTimer = setTimeout(() => { if (this.reply === reply && !this.playback) this.cancelInteraction() }, 60000)
          }
        })
        void done.catch(() => {})
        this.send(c.socket, { type: 'playback_start', playback_id: event.playback_id, turn_id: context.turn_id ?? event.playback_id })
        return { accepted: true }
      } catch (error) {
        if (play) play.cancel('播放准备或开始失败')
        else try { this.send(c.socket, { type: 'playback_cancel', playback_id: event.playback_id }) } catch { /* no active playback */ }
        throw error
      } finally { if (this.reservation?.id === event.playback_id) this.reservation = undefined }
    }
    if (!play || JSON.stringify(this.outputContexts.get(event.playback_id)) !== JSON.stringify(context)) failed('播放ID或归属不一致')
    this.assertOutput(context)
    if (event.type === 'reply_text') {
      try { if (!play.append(event.sequence, event.text)) return { accepted: false, code: 'VOICE_OUTPUT_BACKPRESSURE' } } catch { play.cancel('语音文字非法'); failed('语音文字超长、乱序或重复冲突') }
      return { accepted: true }
    }
    play.end()
    return { accepted: true }
  }
  private playbackReceipt(control: Extract<VoiceClientControl, { type: 'playback' }>): void {
    const play = this.playbacks.get(control.playback_id)
    if (play) {
      if (control.status === 'started' && this.connection) this.connection.playback = 'playing'
      play.receipt(control.status, control.played_samples)
      if (control.status !== 'started' && control.status !== 'completed' && this.terminal.receiptIdentity) this.receipts.report(control, this.terminal.receiptIdentity)
      return
    }
    if (!this.connection || !this.terminal.receiptIdentity) return
    const receipt = this.receipts.report(control, this.terminal.receiptIdentity)
    if (receipt) { this.send(this.connection.socket, { type: 'playback_confirmed', playback_id: control.playback_id }); this.outputReady() }
  }
  private cancelPlayback(reason: string): void {
    this.playback?.cancel(reason); this.playback = undefined
  }
  private cancelInteraction(): void {
    this.reservation?.finish(false); this.reservation = undefined
    this.connection?.input?.clear(); if (this.connection) this.connection.input = undefined
    this.connection?.processing?.abort(); if (this.connection) { this.connection.processing = undefined; this.connection.processingTurn = undefined }
    if (this.replyTimer) clearTimeout(this.replyTimer); this.replyTimer = undefined
    this.playbacks.clear(); this.outputContexts.clear(); this.reply = undefined; this.cancelPlayback('语音交互已结束')
  }
  private disconnect(): void {
    this.guided = undefined; this.guidedPlayback?.player.cancel(); this.guidedPlayback = undefined
    this.cancelInteraction(); const c = this.connection; this.connection = undefined; c?.socket.terminate()
    if (!this.stopped) void this.sync().catch(() => {})
  }
}
