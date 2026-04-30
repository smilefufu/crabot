/**
 * FeishuChannel - Crabot Channel 模块主类
 *
 * 职责：
 * - 订阅飞书 IM 事件（im.message.receive_v1 + 群成员/群信息相关 5 个事件）
 * - 维护 SessionManager / MessageStore
 * - 注册 protocol-channel.md 全部必需 RPC 端点
 *
 * 对应 spec：crabot-docs/superpowers/specs/2026-04-30-native-feishu-channel-design.md
 */

import * as lark from '@larksuiteoapi/node-sdk'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ModuleBase, type ModuleConfig, generateId, generateTimestamp, type Event } from 'crabot-shared'

import { FeishuClient, FeishuClientError, type SendReceive } from './feishu-client.js'
import { WsSubscriber } from './ws-subscriber.js'
import { SessionManager } from './session-manager.js'
import { MessageStore, type StoredMessage } from './message-store.js'
import {
  detectMentionCrab,
  injectMentionTags,
  mapMessageContent,
} from './event-mapper.js'
import type {
  ChannelMessage,
  ChannelCapabilities,
  FeishuChannelConfig,
  FeishuChatType,
  FindOrCreatePrivateSessionParams,
  GetHistoryParams,
  GetMessageParams,
  GetSessionParams,
  GetSessionsParams,
  HistoryMessage,
  MessageContent,
  PlatformUserInfoResult,
  Session,
  SessionType,
  SendMessageParams,
  SendMessageResult,
  SyncSessionsParams,
  SyncSessionsResult,
  DeleteSessionResult,
} from './types.js'

const MAX_FILE_SIZE = 30 * 1024 * 1024 // 30MB（飞书附件上限）

export interface FeishuChannelInitConfig {
  module_id: string
  module_type: 'channel'
  version: string
  protocol_version: string
  port: number
  data_dir: string
  feishu: FeishuChannelConfig
}

export class FeishuChannel extends ModuleBase {
  private readonly feishuConfig: FeishuChannelConfig
  private readonly dataDir: string
  private readonly client: FeishuClient
  private readonly subscriber: WsSubscriber
  private readonly sessionManager: SessionManager
  private readonly messageStore: MessageStore

  private botOpenId: string | null = null
  private botName: string | null = null

  /** open_id → 飞书用户昵称缓存。事件 payload 不含 sender 名，需要调 contact API */
  private readonly displayNameCache: Map<string, { name: string; fetchedAt: number }> = new Map()
  private static readonly DISPLAY_NAME_TTL_MS = 24 * 60 * 60 * 1000 // 24h
  private static readonly DISPLAY_NAME_CACHE_MAX = 2000

  constructor(config: FeishuChannelInitConfig) {
    const moduleConfig: ModuleConfig = {
      moduleId: config.module_id,
      moduleType: config.module_type,
      version: config.version,
      protocolVersion: config.protocol_version,
      port: config.port,
      subscriptions: [],
    }
    super(moduleConfig)

    this.feishuConfig = config.feishu
    this.dataDir = config.data_dir
    this.client = new FeishuClient({
      app_id: config.feishu.app_id,
      app_secret: config.feishu.app_secret,
      domain: config.feishu.domain,
    })
    this.subscriber = new WsSubscriber({
      app_id: config.feishu.app_id,
      app_secret: config.feishu.app_secret,
      domain: config.feishu.domain,
    })
    this.sessionManager = new SessionManager(config.module_id, config.data_dir)
    this.messageStore = new MessageStore(config.data_dir)

    fs.mkdirSync(path.join(this.dataDir, 'media'), { recursive: true })
    this.registerMethods()
  }

  // ============================================================================
  // 生命周期
  // ============================================================================

  protected override async onStart(): Promise<void> {
    try {
      const info = await this.client.getBotInfo()
      this.botOpenId = info.open_id || null
      this.botName = info.app_name || null
      console.log(`[FeishuChannel] Bot: ${info.app_name} (open_id=${info.open_id})`)
    } catch (err) {
      console.warn('[FeishuChannel] getBotInfo failed:', err)
    }

    this.messageStore.startCleanup()

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => this.safeHandle('message.receive', () => this.handleMessageReceive(data)),
      'im.chat.member.bot.added_v1': (data) => this.safeHandle('bot.added', () => this.handleBotAdded(data)),
      'im.chat.member.bot.deleted_v1': (data) => this.safeHandle('bot.deleted', () => this.handleBotDeleted(data)),
      'im.chat.member.user.added_v1': (data) => this.safeHandle('user.added', () => this.handleUsersAdded(data)),
      'im.chat.member.user.deleted_v1': (data) => this.safeHandle('user.deleted', () => this.handleUsersDeleted(data)),
      'im.chat.updated_v1': (data) => this.safeHandle('chat.updated', () => this.handleChatUpdated(data)),
    })

    await this.subscriber.start(dispatcher)
    this.bootstrapGroupSessions().catch((err) => {
      console.warn('[FeishuChannel] bootstrap aborted:', err)
    })
  }

  protected override async onStop(): Promise<void> {
    this.messageStore.stopCleanup()
    await this.subscriber.close()
  }

  private async safeHandle(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      console.error(`[FeishuChannel] ${label} handler error:`, err)
    }
  }

  // ============================================================================
  // 事件处理
  // ============================================================================

  private async handleMessageReceive(payload: { sender?: { sender_id?: { open_id?: string }; sender_type?: string }; message?: { message_id?: string; chat_id?: string; chat_type?: string; message_type?: string; content?: string; create_time?: string; mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>; root_id?: string; parent_id?: string } }): Promise<void> {
    const message = payload.message
    if (!message?.message_id || !message.chat_id) return
    if (payload.sender?.sender_type === 'app') return // 忽略 app 自身/其他 bot

    const isGroup = (message.chat_type as FeishuChatType) === 'group'
    const senderOpenId = payload.sender?.sender_id?.open_id ?? ''

    const platformSessionId = isGroup ? message.chat_id : (senderOpenId || message.chat_id)
    const sessionType: SessionType = isGroup ? 'group' : 'private'

    const mentions = message.mentions ?? []
    const isMentionCrab = isGroup ? detectMentionCrab(mentions, this.botOpenId) : false

    if (isGroup && this.feishuConfig.only_respond_to_mentions && !isMentionCrab) {
      return
    }

    const senderName = senderOpenId ? await this.resolveDisplayName(senderOpenId) : ''
    const placeholderTitle = isGroup ? message.chat_id : (senderName || senderOpenId || message.chat_id)
    const { session } = this.sessionManager.upsert({
      platform_session_id: platformSessionId,
      type: sessionType,
      title: placeholderTitle,
      sender_id: senderOpenId,
      sender_name: senderName || senderOpenId,
    })

    const mapped = mapMessageContent(message.message_type ?? 'text', message.content ?? '{}', mentions)

    let content: MessageContent = mapped.content
    if (mapped.content.type === 'image' && mapped.raw?.image_key) {
      const filePath = await this.tryDownloadResource(message.message_id, mapped.raw.image_key, 'image', '.jpg')
      if (filePath) content = { ...content, file_path: filePath }
    } else if (mapped.content.type === 'file' && mapped.raw?.file_key) {
      const ext = mapped.raw.filename ? path.extname(mapped.raw.filename) : ''
      const filePath = await this.tryDownloadResource(message.message_id, mapped.raw.file_key, 'file', ext)
      if (filePath) content = { ...content, file_path: filePath }
    }

    const platformTimestamp = isoFromMillis(message.create_time) ?? generateTimestamp()

    const channelMessage: ChannelMessage = {
      platform_message_id: message.message_id,
      session: { session_id: session.id, channel_id: this.config.moduleId, type: session.type },
      sender: { platform_user_id: senderOpenId, platform_display_name: senderName || senderOpenId },
      content,
      features: {
        is_mention_crab: isMentionCrab,
        ...(mapped.features.mentions ? { mentions: mapped.features.mentions } : {}),
        ...(message.parent_id ? { reply_to_message_id: message.parent_id } : {}),
        ...(message.root_id && message.root_id !== message.parent_id ? { root_message_id: message.root_id } : {}),
      },
      platform_timestamp: platformTimestamp,
    }

    await this.messageStore.append(session.id, {
      direction: 'inbound',
      platform_message_id: channelMessage.platform_message_id,
      sender: channelMessage.sender,
      content: channelMessage.content,
      features: channelMessage.features,
      platform_timestamp: channelMessage.platform_timestamp,
    })

    const event: Event = {
      id: generateId(),
      type: 'channel.message_received',
      source: this.config.moduleId,
      payload: { channel_id: this.config.moduleId, message: channelMessage },
      timestamp: generateTimestamp(),
    }
    await this.rpcClient.publishEvent(event, this.config.moduleId)
  }

  /**
   * 拿用户昵称：先查缓存，未命中调 contact API。
   * 失败时返回空串，调用方自行 fallback 到 open_id。
   */
  private async resolveDisplayName(openId: string): Promise<string> {
    const cached = this.displayNameCache.get(openId)
    if (cached && Date.now() - cached.fetchedAt < FeishuChannel.DISPLAY_NAME_TTL_MS) {
      return cached.name
    }
    try {
      const user = await this.client.getUser(openId)
      const name = user.name || ''
      if (name) {
        if (this.displayNameCache.size >= FeishuChannel.DISPLAY_NAME_CACHE_MAX) {
          // 简单 LRU：删最早插入的一个（Map 保留插入顺序）
          const firstKey = this.displayNameCache.keys().next().value
          if (firstKey !== undefined) this.displayNameCache.delete(firstKey)
        }
        this.displayNameCache.set(openId, { name, fetchedAt: Date.now() })
      }
      return name
    } catch (err) {
      console.warn(`[FeishuChannel] resolveDisplayName failed for ${openId}:`, err)
      return ''
    }
  }

  private async tryDownloadResource(messageId: string, fileKey: string, type: 'image' | 'file', ext: string): Promise<string | undefined> {
    try {
      const buffer = await this.client.downloadResource(messageId, fileKey, type)
      const safeExt = ext && /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext : (type === 'image' ? '.bin' : '.bin')
      const fileName = `${messageId}${safeExt}`
      const filePath = path.join(this.dataDir, 'media', fileName)
      await fsp.writeFile(filePath, buffer)
      return filePath
    } catch (err) {
      console.warn(`[FeishuChannel] resource download failed for ${messageId} (${type}):`, err)
      return undefined
    }
  }

  private async handleBotAdded(data: { chat_id?: string; name?: string; type?: string }): Promise<void> {
    if (!data.chat_id) return
    let title = data.name ?? data.chat_id
    let participants: Array<{ platform_user_id: string; role: 'member' }> = []
    try {
      const members = await this.client.getChatMembers(data.chat_id)
      participants = members.map((m) => ({ platform_user_id: m.open_id, role: 'member' as const }))
    } catch (err) {
      console.warn(`[FeishuChannel] getChatMembers failed for ${data.chat_id}:`, err)
    }
    const { session, created } = this.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: data.chat_id,
      title,
      participants,
    })
    await this.publishSessionChanged(created ? 'created' : 'updated', session)
  }

  private async handleBotDeleted(data: { chat_id?: string }): Promise<void> {
    if (!data.chat_id) return
    const removed = this.sessionManager.removeByPlatformId(data.chat_id)
    if (!removed) return
    await this.publishSessionChanged('removed', { ...removed, participants: [] })
  }

  private async handleUsersAdded(data: { chat_id?: string; users?: Array<{ user_id?: { open_id?: string }; name?: string }> }): Promise<void> {
    if (!data.chat_id) return
    const added = (data.users ?? [])
      .map((u) => u.user_id?.open_id)
      .filter((id): id is string => !!id)
      .map((id) => ({ platform_user_id: id, role: 'member' as const }))
    const updated = this.sessionManager.applyParticipantsAdded(data.chat_id, added)
    if (updated) await this.publishSessionChanged('participants_changed', updated)
  }

  private async handleUsersDeleted(data: { chat_id?: string; users?: Array<{ user_id?: { open_id?: string } }> }): Promise<void> {
    if (!data.chat_id) return
    const removedIds = (data.users ?? [])
      .map((u) => u.user_id?.open_id)
      .filter((id): id is string => !!id)
    const updated = this.sessionManager.applyParticipantsRemoved(data.chat_id, removedIds)
    if (updated) await this.publishSessionChanged('participants_changed', updated)
  }

  private async handleChatUpdated(data: { chat_id?: string; after_change?: { name?: string } }): Promise<void> {
    if (!data.chat_id) return
    const updated = this.sessionManager.applyChatUpdate(data.chat_id, { title: data.after_change?.name })
    if (updated) await this.publishSessionChanged('updated', updated)
  }

  private async publishSessionChanged(type: 'created' | 'updated' | 'participants_changed' | 'removed', session: Session): Promise<void> {
    const event: Event = {
      id: generateId(),
      type: 'channel.session_changed',
      source: this.config.moduleId,
      payload: { type, channel_id: this.config.moduleId, session },
      timestamp: generateTimestamp(),
    }
    await this.rpcClient.publishEvent(event, this.config.moduleId)
  }

  // ============================================================================
  // bootstrap
  // ============================================================================

  private async bootstrapGroupSessions(): Promise<void> {
    let pageToken: string | undefined = undefined
    let total = 0
    while (true) {
      const { items, page_token, has_more } = await this.client.listChats({ page_token: pageToken, page_size: 50 })
      for (const it of items) {
        try {
          const members = await this.client.getChatMembers(it.chat_id)
          this.sessionManager.upsertGroupSessionFromSnapshot({
            platform_session_id: it.chat_id,
            title: it.name || it.chat_id,
            participants: members.map((m) => ({ platform_user_id: m.open_id, role: 'member' as const })),
          })
          total += 1
        } catch (err) {
          console.warn(`[FeishuChannel] bootstrap skip ${it.chat_id}:`, err)
        }
      }
      if (!has_more || !page_token) break
      pageToken = page_token
    }
    console.log(`[FeishuChannel] bootstrap done: ${total} groups synced`)
  }

  // ============================================================================
  // RPC
  // ============================================================================

  private registerMethods(): void {
    this.registerMethod('send_message', this.handleSendMessage.bind(this))
    this.registerMethod('get_capabilities', this.handleGetCapabilities.bind(this))
    this.registerMethod('get_sessions', this.handleGetSessions.bind(this))
    this.registerMethod('get_session', this.handleGetSession.bind(this))
    this.registerMethod('find_or_create_private_session', this.handleFindOrCreatePrivateSession.bind(this))
    this.registerMethod('get_history', this.handleGetHistory.bind(this))
    this.registerMethod('get_message', this.handleGetMessage.bind(this))
    this.registerMethod('get_platform_user_info', this.handleGetPlatformUserInfo.bind(this))
    this.registerMethod('sync_sessions', this.handleSyncSessions.bind(this))
    this.registerMethod('delete_session', this.handleDeleteSession.bind(this))
    this.registerMethod('get_config', this.handleGetConfig.bind(this))
    this.registerMethod('update_config', this.handleUpdateConfig.bind(this))
  }

  private async handleSendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throwError('NOT_FOUND', `Session not found: ${params.session_id}`)

    // file path 安全校验
    if (params.content.file_path) {
      this.assertFilePathAllowed(params.content.file_path)
    }

    const receive: SendReceive = {
      type: session.type === 'group' ? 'chat_id' : 'open_id',
      id: session.platform_session_id,
    }

    let result: { message_id: string; create_time: string }

    if (params.features?.reply_to_message_id) {
      const { msgType, contentJson } = await this.buildSendPayload(params)
      result = await this.client.reply(params.features.reply_to_message_id, msgType, contentJson)
    } else if (params.content.type === 'image') {
      const imageKey = await this.materializeImage(params.content)
      result = await this.client.sendImage(receive, imageKey)
    } else if (params.content.type === 'file') {
      const fileKey = await this.materializeFile(params.content)
      result = await this.client.sendFile(receive, fileKey)
    } else {
      const text = injectMentionTags(params.content.text ?? '', await this.resolveMentionsToOpenIds(params.features?.mentions))
      result = await this.client.sendText(receive, text)
    }

    const sentAt = isoFromMillis(result.create_time) ?? generateTimestamp()
    await this.messageStore.append(session.id, this.buildOutboundStored(result.message_id, params.content, sentAt))

    return { platform_message_id: result.message_id, sent_at: sentAt }
  }

  private async buildSendPayload(params: SendMessageParams): Promise<{ msgType: string; contentJson: string }> {
    if (params.content.type === 'image') {
      const imageKey = await this.materializeImage(params.content)
      return { msgType: 'image', contentJson: JSON.stringify({ image_key: imageKey }) }
    }
    if (params.content.type === 'file') {
      const fileKey = await this.materializeFile(params.content)
      return { msgType: 'file', contentJson: JSON.stringify({ file_key: fileKey }) }
    }
    const text = injectMentionTags(params.content.text ?? '', await this.resolveMentionsToOpenIds(params.features?.mentions))
    return { msgType: 'text', contentJson: JSON.stringify({ text }) }
  }

  private async loadContentBuffer(content: MessageContent): Promise<{ buf: Buffer; filename: string }> {
    if (content.file_path) {
      this.assertFilePathAllowed(content.file_path)
      const buf = await readFileOrThrow(content.file_path)
      this.assertFileSize(buf.length)
      return { buf, filename: content.filename ?? path.basename(content.file_path) }
    }
    if (content.media_url) {
      const buf = await fetchAsBuffer(content.media_url)
      this.assertFileSize(buf.length)
      const filename = content.filename ?? (path.basename(new URL(content.media_url).pathname) || 'file.bin')
      return { buf, filename }
    }
    throwError('CHANNEL_SEND_FAILED', `${content.type} content requires file_path or media_url`)
  }

  private async materializeImage(content: MessageContent): Promise<string> {
    const { buf } = await this.loadContentBuffer(content)
    return await this.client.uploadImage(buf)
  }

  private async materializeFile(content: MessageContent): Promise<string> {
    const { buf, filename } = await this.loadContentBuffer(content)
    return await this.client.uploadFile(buf, filename)
  }

  /**
   * mentions: friend_id 列表（来自 SendMessageFeatures）。
   * 当前 channel 层不维护 friend_id → open_id 映射（admin 侧统一由 admin/friend manager 管理），
   * 因此这里假设上层在调用前已经把 friend_id 替换为 open_id。
   * 若上层未替换，跳过空值并打 warning。
   */
  private async resolveMentionsToOpenIds(mentions: string[] | undefined): Promise<Array<{ open_id: string }>> {
    if (!mentions?.length) return []
    return mentions
      .filter((m) => /^ou_/.test(m))
      .map((openId) => ({ open_id: openId }))
  }

  private buildOutboundStored(messageId: string, content: MessageContent, timestamp: string): StoredMessage {
    return {
      direction: 'outbound',
      platform_message_id: messageId,
      sender: {
        platform_user_id: this.botOpenId ?? '',
        platform_display_name: this.botName ?? 'Crabot',
      },
      content,
      features: { is_mention_crab: false },
      platform_timestamp: timestamp,
    }
  }

  private assertFilePathAllowed(filePath: string): void {
    const allowed = this.allowedFilePaths()
    const normalized = path.resolve(filePath)
    if (!allowed.some((prefix) => normalized.startsWith(path.resolve(prefix)))) {
      throwError('CHANNEL_FILE_PATH_NOT_ALLOWED', `file_path not allowed: ${filePath}`)
    }
  }

  private assertFileSize(size: number): void {
    if (size > MAX_FILE_SIZE) {
      throwError('CHANNEL_FILE_TOO_LARGE', `file size ${size} exceeds limit ${MAX_FILE_SIZE}`)
    }
  }

  private allowedFilePaths(): string[] {
    return ['/tmp/', '/private/tmp/', path.join(this.dataDir, 'sessions'), path.join(this.dataDir, 'media')]
  }

  // ── capabilities ───────────────────────────────────────────────────────────

  private handleGetCapabilities(): ChannelCapabilities {
    return {
      supported_message_types: ['text', 'image', 'file'],
      supported_features: ['mention', 'quote'],
      supports_history_query: true,
      supports_platform_user_query: true,
      max_message_length: null,
      max_file_size: MAX_FILE_SIZE,
      supports_file_path: true,
      allowed_file_paths: this.allowedFilePaths(),
      extensions: [],
    }
  }

  // ── sessions ───────────────────────────────────────────────────────────────

  private handleGetSessions(params: GetSessionsParams) {
    const items = this.sessionManager.listSessions(params.type)
    const page = params.pagination?.page ?? 1
    const pageSize = params.pagination?.page_size ?? 50
    const start = (page - 1) * pageSize
    return {
      items: items.slice(start, start + pageSize),
      pagination: {
        page,
        page_size: pageSize,
        total_items: items.length,
        total_pages: Math.max(1, Math.ceil(items.length / pageSize)),
      },
    }
  }

  private handleGetSession(params: GetSessionParams) {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throwError('NOT_FOUND', 'Session not found')
    return { session }
  }

  private handleFindOrCreatePrivateSession(params: FindOrCreatePrivateSessionParams) {
    const existing = this.sessionManager.findByPlatformId(params.platform_user_id)
    if (existing) return { session: existing, created: false }
    const { session, created } = this.sessionManager.upsert({
      platform_session_id: params.platform_user_id,
      type: 'private',
      title: params.platform_user_id,
      sender_id: params.platform_user_id,
      sender_name: params.platform_user_id,
    })
    return { session, created }
  }

  // ── history / message ─────────────────────────────────────────────────────

  private async handleGetHistory(params: GetHistoryParams) {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throwError('NOT_FOUND', 'Session not found')

    const page = params.pagination?.page ?? 1
    const pageSize = params.pagination?.page_size ?? params.limit ?? 20

    const local = await this.messageStore.query({
      sessionId: session.id,
      timeRange: params.time_range,
      keyword: params.keyword,
      page,
      pageSize,
    })

    if (local.items.length > 0) {
      return paginated(local.items.map(toHistoryMessage), page, pageSize, local.total)
    }

    // fallback：飞书 im.v1.message.list（仅群聊支持 container_id_type='chat'）
    if (session.type === 'group') {
      try {
        const remote = await this.client.listMessages({
          container_id_type: 'chat',
          container_id: session.platform_session_id,
          start_time: msFromIso(params.time_range?.after),
          end_time: msFromIso(params.time_range?.before),
          page_size: pageSize,
        })
        const items = remote.items.map((m) => feishuMsgToHistory(m))
        return paginated(items, 1, pageSize, items.length)
      } catch (err) {
        console.warn('[FeishuChannel] history fallback failed:', err)
      }
    }
    return paginated<HistoryMessage>([], page, pageSize, 0)
  }

  private async handleGetMessage(params: GetMessageParams): Promise<HistoryMessage> {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throwError('NOT_FOUND', 'Session not found')
    const local = await this.messageStore.findByMessageId(session.id, params.platform_message_id)
    if (local) return toHistoryMessage(local)
    const remote = await this.client.getMessage(params.platform_message_id)
    if (!remote) throwError('NOT_FOUND', 'Message not found')
    return feishuMsgToHistory(remote)
  }

  private async handleGetPlatformUserInfo(params: { platform_user_id: string }): Promise<PlatformUserInfoResult> {
    try {
      const u = await this.client.getUser(params.platform_user_id)
      return {
        platform_user_id: u.open_id,
        display_name: u.name,
        avatar_url: u.avatar_url,
      }
    } catch (err) {
      if (err instanceof FeishuClientError && err.code === 'NOT_FOUND') {
        throwError('NOT_FOUND', err.message)
      }
      throw err
    }
  }

  private async handleSyncSessions(_params: SyncSessionsParams): Promise<SyncSessionsResult> {
    const before = this.sessionManager.listSessions('group').map((s) => s.platform_session_id)
    let added = 0
    let updated = 0
    const seen = new Set<string>()
    let pageToken: string | undefined = undefined
    while (true) {
      const { items, page_token, has_more } = await this.client.listChats({ page_token: pageToken, page_size: 50 })
      for (const it of items) {
        seen.add(it.chat_id)
        try {
          const members = await this.client.getChatMembers(it.chat_id)
          const r = this.sessionManager.upsertGroupSessionFromSnapshot({
            platform_session_id: it.chat_id,
            title: it.name || it.chat_id,
            participants: members.map((m) => ({ platform_user_id: m.open_id, role: 'member' as const })),
          })
          if (r.created) added += 1
          else updated += 1
          await this.publishSessionChanged(r.created ? 'created' : 'updated', r.session)
        } catch {
          // skip
        }
      }
      if (!has_more || !page_token) break
      pageToken = page_token
    }

    let removed = 0
    for (const oldChatId of before) {
      if (!seen.has(oldChatId)) {
        const drop = this.sessionManager.removeByPlatformId(oldChatId)
        if (drop) {
          await this.publishSessionChanged('removed', { ...drop, participants: [] })
          removed += 1
        }
      }
    }

    return { added, updated, removed }
  }

  private async handleDeleteSession(params: { session_id: string }): Promise<DeleteSessionResult> {
    const removed = this.sessionManager.removeById(params.session_id)
    if (!removed) return { deleted: false }
    await this.publishSessionChanged('removed', { ...removed, participants: [] })
    return { deleted: true }
  }

  // ── config ────────────────────────────────────────────────────────────────

  private handleGetConfig() {
    const cfg: Record<string, unknown> = {
      platform: 'feishu',
      credentials: {
        app_id: this.feishuConfig.app_id,
        app_secret: '***',
        domain: this.feishuConfig.domain,
        ...(this.feishuConfig.owner_open_id ? { owner_open_id: this.feishuConfig.owner_open_id } : {}),
      },
      group: { only_respond_to_mentions: this.feishuConfig.only_respond_to_mentions },
      crab_platform_user_id: this.botOpenId ?? '',
    }
    return {
      config: cfg,
      schema: {
        'credentials.app_secret': { sensitive: true, hot_reload: false, description: 'App Secret，变更需重启' },
        'credentials.app_id': { hot_reload: false, description: 'App ID，变更需重启' },
        'credentials.domain': { hot_reload: false, description: '接入域，变更需重启' },
        'group.only_respond_to_mentions': { hot_reload: true, description: '群聊仅响应 @ Crabot' },
      },
    }
  }

  private handleUpdateConfig(params: { config?: Partial<FeishuChannelConfig> }): { config: Record<string, unknown>; requires_restart: boolean } {
    const incoming = params.config ?? {}
    let requiresRestart = false
    if (incoming.app_id && incoming.app_id !== this.feishuConfig.app_id) {
      this.feishuConfig.app_id = incoming.app_id
      requiresRestart = true
    }
    if (incoming.app_secret) {
      this.feishuConfig.app_secret = incoming.app_secret
      requiresRestart = true
    }
    if (incoming.domain && incoming.domain !== this.feishuConfig.domain) {
      this.feishuConfig.domain = incoming.domain
      requiresRestart = true
    }
    if (typeof incoming.only_respond_to_mentions === 'boolean') {
      this.feishuConfig.only_respond_to_mentions = incoming.only_respond_to_mentions
    }
    if (incoming.owner_open_id !== undefined) {
      this.feishuConfig.owner_open_id = incoming.owner_open_id
    }
    const masked = this.handleGetConfig().config
    return { config: masked, requires_restart: requiresRestart }
  }

  // ── health ────────────────────────────────────────────────────────────────

  protected override async getHealthDetails(): Promise<Record<string, unknown>> {
    return {
      platform: 'feishu',
      domain: this.feishuConfig.domain,
      platform_connected: this.subscriber.isConnected(),
      ws_state: this.subscriber.getState(),
      ws_reconnect_count: this.subscriber.getReconnectCount(),
      ws_fail_count: this.subscriber.getFailCount(),
      ws_last_error: this.subscriber.getLastError() ?? null,
      bot_open_id: this.botOpenId,
      active_sessions: this.sessionManager.listSessions().length,
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isoFromMillis(ms: string | number | undefined): string | undefined {
  if (ms === undefined || ms === null || ms === '') return undefined
  const n = typeof ms === 'string' ? parseInt(ms, 10) : ms
  if (!Number.isFinite(n) || n <= 0) return undefined
  return new Date(n).toISOString()
}

function msFromIso(iso: string | undefined): string | undefined {
  if (!iso) return undefined
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? Math.floor(t / 1000).toString() : undefined
}

function paginated<T>(items: T[], page: number, pageSize: number, total: number) {
  return {
    items,
    pagination: {
      page,
      page_size: pageSize,
      total_items: total,
      total_pages: Math.max(1, Math.ceil(total / pageSize)),
    },
  }
}

function toHistoryMessage(stored: StoredMessage): HistoryMessage {
  return {
    platform_message_id: stored.platform_message_id,
    sender: stored.sender,
    content: stored.content,
    features: stored.features,
    platform_timestamp: stored.platform_timestamp,
  }
}

function feishuMsgToHistory(m: Record<string, unknown>): HistoryMessage {
  const sender = (m.sender as Record<string, unknown> | undefined) ?? {}
  const senderId = (sender.id as string) ?? ''
  const body = (m.body as Record<string, unknown> | undefined) ?? {}
  const msgType = (m.msg_type as string) ?? 'text'
  let text = ''
  try {
    const c = JSON.parse((body.content as string) ?? '{}')
    text = (c.text as string) ?? ''
  } catch {
    // ignore
  }
  return {
    platform_message_id: (m.message_id as string) ?? '',
    sender: { platform_user_id: senderId, platform_display_name: senderId },
    content: { type: 'text', text: text || `[${msgType}]` },
    features: { is_mention_crab: false },
    platform_timestamp: isoFromMillis((m.create_time as string) ?? '') ?? new Date().toISOString(),
  }
}

async function readFileOrThrow(filePath: string): Promise<Buffer> {
  try {
    return await fsp.readFile(filePath)
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) throwError('CHANNEL_FILE_NOT_FOUND', `file not found: ${filePath}`)
    throwError('CHANNEL_FILE_READ_FAILED', err instanceof Error ? err.message : String(err))
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code
}

async function fetchAsBuffer(url: string): Promise<Buffer> {
  const resp = await fetch(url)
  if (!resp.ok) throwError('CHANNEL_SEND_FAILED', `fetch ${url} → ${resp.status}`)
  const ab = await resp.arrayBuffer()
  return Buffer.from(ab)
}

function throwError(code: string, message: string): never {
  const err = new Error(message)
  ;(err as Error & { code: string }).code = code
  throw err
}
