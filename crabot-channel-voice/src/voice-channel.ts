import { ReplyPlayback } from './reply-playback.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Server } from 'node:net'
import os from 'node:os'
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import { ModuleBase, RpcError, VoiceInputBuffer, VOICE_MODEL_VERSIONS, encodeVoiceFrame, parseVoiceClientControl, VoiceProtocolVersionError, sha256CanonicalJson, assertVoiceUuid, transcribeAudio, voiceSessionId,
  type GetVoiceConfigResult, type ModuleConfig, type RpcHandlerContext, type SensitiveRpcMethod, type SubmitVoiceTurnParams, type SyncVoiceTerminalParams, type VoiceAdminActionParams, type VoiceAdminActionResult,
  type VoiceOutputParams, type VoiceOutputResult, type VoiceClientControl, type VoicePairing, type VoiceReplyContext, type VoiceServerControl, type VoiceTerminalState, type VoiceTurnResult } from 'crabot-shared'
import { TerminalStore } from './terminal-store.js'
import { voiceTransport } from './transport.js'

interface Connection {
  socket: WebSocket; epoch: string; foreground: boolean; lastHeartbeat: number
  microphone: VoiceTerminalState['microphone']; playback: VoiceTerminalState['playback']
  input?: VoiceInputBuffer; processing?: AbortController; processingTurn?: string
}
interface ReplySlot { context: VoiceReplyContext; digest: string }
function failed(message: string): never { throw new RpcError('CHANNEL_SEND_FAILED', message) }
function compatible(models: { segmentation: string; embedding: string }): boolean {
  return models.segmentation === VOICE_MODEL_VERSIONS.segmentation && models.embedding === VOICE_MODEL_VERSIONS.embedding
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
  private readonly terminal: TerminalStore
  private settings!: GetVoiceConfigResult
  private connection?: Connection
  private pairing?: VoicePairing & { socket?: WebSocket }
  private reply?: ReplySlot
  private playback?: ReplyPlayback
  private readonly playbacks = new Map<string, ReplyPlayback>()
  private replyTimer?: ReturnType<typeof setTimeout>
  private enrollment?: { registration_id: string; revision: number; deadline: number }
  private closeTransport?: () => void
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private stopped = false
  private adminPort?: number
  private readonly createdAt = new Date().toISOString()
  constructor(config: ModuleConfig, dataDirectory: string, private readonly runtimeBearer: string) {
    super(config)
    this.terminal = new TerminalStore(dataDirectory)
    this.registerMethod('voice_admin_action', (params: VoiceAdminActionParams, ctx?: RpcHandlerContext) => this.adminAction(params, ctx?.authorizationBearer))
    this.registerMethod('update_config', async () => { this.disconnect(); await this.refreshConfig(); return { updated: true } })
    this.registerMethod('get_capabilities', () => ({ supported_message_types: ['text'], supported_features: [], supports_history_query: false, supports_platform_user_query: true,
      max_message_length: 120, max_file_size: 0, supports_file_path: false, supports_list_contacts: true, supports_list_groups: true, supports_list_group_members: true,
      voice: { protocol_version: 4, send_timeout_ms: 30000 } }))
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
  }
  protected override async onStart(): Promise<void> {
    if (!this.runtimeBearer) throw new Error('Voice runtime bearer is required')
    await this.terminal.load(); await this.refreshConfig()
    this.heartbeatTimer = setInterval(() => {
      const c = this.connection
      if (c && Date.now() - c.lastHeartbeat > 5000) this.disconnect()
      else if (c) { try { this.send(c.socket, { type: 'heartbeat' }); void this.sync().catch(() => this.disconnect()) } catch { this.disconnect() } }
      if (this.enrollment && this.enrollment.deadline < Date.now()) this.enrollment = undefined
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
    await this.admin('sync_voice_terminal', { channel_id: this.config.moduleId, connection_epoch: this.connection?.epoch ?? null, foreground: this.connection?.foreground ?? false, ...ack })
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
    return { paired: this.terminal.paired, connected: !!c, foreground: c?.foreground ?? false, microphone: c?.microphone ?? 'closed', playback: c?.playback ?? 'idle', aec_verified: false,
      enrollment_revision: this.settings.enrollment_revision, contacts: this.settings.contacts, registrations: this.settings.registrations,
      hosts: [...new Set(Object.values(os.networkInterfaces()).flatMap(addresses => (addresses ?? []).filter(a => !a.internal).map(a => a.family === 'IPv6' ? '[' + a.address + ']' : a.address)))],
      ...(this.pairing ? { pairing_id: this.pairing.pairing_id, ...(this.pairing.socket ? { verification_code: this.pairing.verification_code } : {}) } : {}) }
  }
  private async adminAction(raw: VoiceAdminActionParams, bearer?: string): Promise<VoiceAdminActionResult> {
    fields(raw, ['channel_id', 'command'])
    if (raw.channel_id !== this.config.moduleId || !bearer) throw new RpcError('UNAUTHORIZED', 'Human Admin is required')
    const modules = await this.rpcClient.resolve({ module_type: 'admin' }, this.config.moduleId)
    if (!modules[0]) throw new RpcError('SERVICE_UNAVAILABLE', 'Admin is unavailable')
    await this.rpcClient.callSensitive(modules[0].port, 'verify_voice_admin', { channel_id: this.config.moduleId }, this.config.moduleId, { authorizationBearer: bearer, timeoutMs: 3000 })
    const command = raw.command
    switch (command.action) {
      case 'status': fields(command, ['action']); await this.refreshConfig(); return { action: 'status', state: this.state() }
      case 'create_pairing': {
        fields(command, ['action']); if (this.terminal.paired) throw new RpcError('INVALID_PARAMS', '请先撤销已有终端')
        await this.refreshConfig()
        if (!this.settings.terminal_entry) throw new RpcError('INVALID_PARAMS', '请先保存手机可访问的后台地址')
        this.pairing?.socket?.terminate()
        this.pairing = { protocol_version: 4, channel_id: this.config.moduleId, pairing_id: randomUUID(), ...this.settings.terminal_entry, nonce: randomBytes(32).toString('base64url'), verification_code: String(randomInt(100000, 1000000)), expires_at: new Date(Date.now() + 60000).toISOString() }
        return { action: 'create_pairing', pairing: { ...this.pairing } }
      }
      case 'confirm_pairing': {
        fields(command, ['action', 'pairing_id']); await this.refreshConfig(); const pairing = this.pairing
        if (!pairing?.socket || pairing.socket.readyState !== WebSocket.OPEN || pairing.pairing_id !== command.pairing_id || Date.parse(pairing.expires_at) <= Date.now()) throw new RpcError('INVALID_PARAMS', '配对核对已失效')
        const credential = await this.terminal.pair()
        this.send(pairing.socket, { type: 'paired', credential }); pairing.socket.close(); this.pairing = undefined
        return { action: 'confirm_pairing', confirmed: true }
      }
      case 'revoke_terminal': fields(command, ['action']); await this.terminal.revoke(); this.disconnect(); this.pairing?.socket?.terminate(); this.pairing = undefined; return { action: 'revoke_terminal', revoked: true }
      case 'enroll': {
        fields(command, ['action', 'platform_user_id']); this.cancelInteraction(); await this.refreshConfig()
        const registration = this.settings.registrations.find(r => r.status === 'pending' && r.platform_user_id === command.platform_user_id)
        if (!registration || !this.connection?.foreground) throw new RpcError('SERVICE_UNAVAILABLE', '手机需在前台连接后才能登记')
        this.enrollment = { registration_id: registration.registration_id, revision: this.settings.enrollment_revision, deadline: Date.now() + 60000 }
        this.send(this.connection.socket, { type: 'enroll', registration, enrollment_revision: this.settings.enrollment_revision })
        return { action: 'enroll', registration }
      }
      case 'delete_registration': fields(command, ['action', 'registration_id']); this.cancelInteraction(); await this.refreshConfig(); this.sendClears(); return { action: 'delete_registration', revoked: true }
      default: throw new RpcError('INVALID_PARAMS', 'Invalid voice action')
    }
  }
  private send(socket: WebSocket, control: VoiceServerControl): void {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Terminal disconnected')
    if (socket.bufferedAmount > 50000) throw new Error('Terminal queue exceeds one second')
    socket.send(JSON.stringify(control))
  }
  private sendHello(c: Connection): void {
    this.send(c.socket, { type: 'hello', connection_epoch: c.epoch, config: this.settings.config, enrollment_revision: this.settings.enrollment_revision, registrations: this.settings.registrations,
      destinations: [this.settings.asr_connection && { capability: 'asr' as const, ...this.settings.asr_connection }, this.settings.tts_connection && { capability: 'tts' as const, ...this.settings.tts_connection }].filter(Boolean).map(value => {
        const connection = value!; return { capability: connection.capability, endpoint: connection.endpoint }
      }) })
    this.sendClears()
  }
  private sendClears(): void {
    if (!this.connection) return
    for (const r of this.settings.registrations) if (r.status === 'revoked' && !r.terminal_cleared) this.send(this.connection.socket, { type: 'clear_registration', registration_id: r.registration_id, enrollment_revision: this.settings.enrollment_revision })
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
          c.lastHeartbeat = Date.now(); c.foreground = control.foreground; c.microphone = control.microphone; c.playback = control.playback
          if (!c.foreground) this.cancelInteraction()
          void this.sync().catch(reject); return
        }
        if (control?.type === 'cancel' && authenticated) {
          if (control.playback_id && control.playback_id !== this.playback?.id) return
          if (control.turn_id && control.turn_id !== this.connection?.input?.turnId && control.turn_id !== this.connection?.processingTurn && control.turn_id !== this.reply?.context.turn_id) return
          this.cancelInteraction(); return
        }
        if (control?.type === 'playback' && authenticated) { this.playbackReceipt(control); return }
        queue = queue.then(async () => {
          if (!authenticated) {
            if (pairingOnly || binary || !control) throw new Error('Handshake required')
            if (control.type === 'pair') {
              const p = this.pairing
              if (this.terminal.paired || !p || p.socket || p.nonce !== control.nonce || Date.parse(p.expires_at) <= Date.now()) throw new Error('Pairing expired')
              p.socket = socket; p.nonce = ''; pairingOnly = true
              this.send(socket, { type: 'pair_waiting', pairing_id: p.pairing_id, verification_code: p.verification_code }); return
            }
            if (control.type !== 'hello' || !this.terminal.matches(control.credential) || !compatible(control.models) || this.connection) throw new Error('Terminal authentication/model mismatch')
            await this.refreshConfig()
            if (this.stopped || socket.readyState !== WebSocket.OPEN || this.connection) throw new Error('Connection changed')
            this.connection = { socket, epoch: randomUUID(), foreground: false, lastHeartbeat: Date.now(), microphone: 'closed', playback: 'idle' }
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
      case 'turn_start':
        if (!c.foreground || c.input || c.processing || this.playback || this.enrollment) throw new Error('Voice is not ready')
        this.reply = undefined; await this.refreshConfig(); await this.sync()
        if (this.settings.setup_status !== 'complete') { this.send(c.socket, { type: 'error', code: 'VOICE_REJECTED', message: '请先完成语音创建向导' }); return }
        if (!this.settings.asr_connection || !this.settings.tts_connection || !this.connection || this.connection !== c || !c.foreground) throw new Error('Voice configuration unavailable')
        c.input = new VoiceInputBuffer(control.turn_id); this.send(c.socket, { type: 'turn_ready', turn_id: control.turn_id }); return
      case 'turn_end': await this.completeTurn(c, control); return
      case 'turn_query': {
        const status = await this.admin<{ channel_id: string; turn_id: string; payload_sha256: string }, VoiceTurnResult>('get_voice_turn_status', { channel_id: this.config.moduleId, turn_id: control.turn_id, payload_sha256: control.payload_sha256 })
        this.send(c.socket, { type: 'turn_status', turn_id: control.turn_id, ...status }); return
      }
      case 'enrollment_done': {
        const task = this.enrollment
        if (!c.foreground || !task || task.deadline < Date.now() || task.registration_id !== control.registration_id || task.revision !== control.enrollment_revision || control.model_id !== VOICE_MODEL_VERSIONS.embedding) throw new Error('Enrollment acknowledgement mismatch')
        await this.sync({ completed_enrollment: { registration_id: control.registration_id, model_id: control.model_id, enrollment_revision: control.enrollment_revision } }); this.enrollment = undefined; await this.refreshConfig(); this.sendHello(c); return
      }
      case 'registration_cleared': await this.sync({ cleared_registration: { registration_id: control.registration_id, enrollment_revision: control.enrollment_revision } }); await this.refreshConfig(); return
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
      || !Number.isFinite(Date.parse(context.expires_at)) || Date.parse(context.expires_at) <= Date.now() || Date.parse(context.expires_at) > Date.now() + 60000 || Date.parse(slot.context.expires_at) <= Date.now()) failed('语音回答机会已结束，请重新开始')
    return { c, slot }
  }
  private async voiceOutput(raw: VoiceOutputParams, bearer?: string): Promise<VoiceOutputResult> {
    fields(raw, ['voice_reply_context', 'event'])
    if (!this.adminPort) await this.refreshConfig()
    await this.rpcClient.callSensitive(this.adminPort!, 'verify_voice_agent', { channel_id: this.config.moduleId }, this.config.moduleId, { authorizationBearer: bearer, timeoutMs: 3000 })
    const context = raw.voice_reply_context, { c, slot } = this.assertReply(context), event = raw.event
    fields(event, event.type === 'response_end' ? ['type'] : event.type === 'reply_text' ? ['type', 'playback_id', 'sequence', 'text'] : ['type', 'playback_id'])
    if (event.type === 'response_end') {
      if (this.playback) failed('播放尚未收口')
      this.send(c.socket, { type: 'response_end', turn_id: context.turn_id }); this.reply = undefined
      if (this.replyTimer) clearTimeout(this.replyTimer); this.playbacks.clear(); return { accepted: true }
    }
    if (!['reply_start', 'reply_text', 'reply_end', 'reply_cancel'].includes(event.type)) throw new RpcError('INVALID_PARAMS', '非法播放事件')
    assertVoiceUuid(event.playback_id)
    let play = this.playbacks.get(event.playback_id)
    if (event.type === 'reply_cancel') { play?.cancel('runtime 取消播报'); if (this.playback === play) this.playback = undefined; return { accepted: true } }
    if (event.type === 'reply_start') {
      if (play) return { accepted: true }
      if (this.playback || this.playbacks.size >= 32) failed('播放忙或本轮回复过多')
      const status = await this.admin<unknown, VoiceTurnResult>('get_voice_turn_status', { channel_id: this.config.moduleId, turn_id: context.turn_id, payload_sha256: slot.digest })
      if (status.status !== 'accepted') failed('本轮尚未持久接纳')
      this.assertReply(context); if (!this.settings.tts_connection) failed('TTS 未配置')
      play = new ReplyPlayback(event.playback_id, this.settings.tts_connection!, {
        valid: () => { this.assertReply(context); if (c.socket.bufferedAmount > 50000) failed('播放队列已满') },
        start: text => this.send(c.socket, { type: 'playback_start', playback_id: event.playback_id, turn_id: context.turn_id, text }),
        audio: (sequence, pcm) => c.socket.send(encodeVoiceFrame(2, event.playback_id, sequence, pcm)),
        end: (text, sample_count) => this.send(c.socket, { type: 'playback_end', playback_id: event.playback_id, text, sample_count }),
        cancel: () => { try { this.send(c.socket, { type: 'playback_cancel', playback_id: event.playback_id }) } catch { /* closing */ } },
      })
      this.playback = play; this.playbacks.set(event.playback_id, play)
      void play.done.finally(() => { if (this.playback === play) this.playback = undefined; if (this.connection === c) c.playback = 'idle' }).catch(() => {})
      return { accepted: true }
    }
    if (!play) failed('播放 ID 不存在')
    if (event.type === 'reply_text') {
      try { play.append(event.sequence, event.text) } catch { play.cancel('语音文字非法'); failed('语音文字超长、乱序或重复冲突') }
      return { accepted: true }
    }
    play.end()
    try { return await play.done }
    catch { throw new RpcError('CHANNEL_SEND_FAILED', '本段语音未完整播放', { played_samples: play.playedSamples, completed_text: play.completedText }) }
  }
  private playbackReceipt(control: Extract<VoiceClientControl, { type: 'playback' }>): void {
    const play = this.playbacks.get(control.playback_id)
    if (!play) return
    if (control.status === 'started' && this.connection) this.connection.playback = 'playing'
    play.receipt(control.status, control.played_samples)
    console.log(`[Voice] playback=${play.id} status=${control.status}`)
  }
  private cancelPlayback(reason: string): void {
    this.playback?.cancel(reason); this.playback = undefined
  }
  private cancelInteraction(): void {
    this.connection?.input?.clear(); if (this.connection) this.connection.input = undefined
    this.connection?.processing?.abort(); if (this.connection) { this.connection.processing = undefined; this.connection.processingTurn = undefined }
    if (this.replyTimer) clearTimeout(this.replyTimer); this.replyTimer = undefined
    this.playbacks.clear(); this.reply = undefined; this.enrollment = undefined; this.cancelPlayback('语音交互已结束')
  }
  private disconnect(): void {
    this.cancelInteraction(); const c = this.connection; this.connection = undefined; c?.socket.terminate()
    if (!this.stopped) void this.sync().catch(() => {})
  }
}
