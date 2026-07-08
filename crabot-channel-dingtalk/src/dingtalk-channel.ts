/**
 * DingtalkChannel - Crabot Channel 模块主类（钉钉）
 *
 * 职责：
 * - 通过 Stream 长连接订阅钉钉机器人消息（stream-subscriber）
 * - 维护 SessionManager / MessageStore / 媒体惰性下载（MediaHandleStore/MediaFetchManager/MediaCleaner）
 * - 注册 protocol-channel.md 必需的 RPC 端点子集
 *
 * 本文件是 crabot-channel-feishu/src/feishu-channel.ts 的钉钉镜像；去掉了飞书专属的
 * doc-reader / 原生透传 / backfill / card-table / url 解析 / remediation 等分支。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  ModuleBase,
  type ModuleConfig,
  generateId,
  generateTimestamp,
  type Event,
  decideMarkdownEnabled,
  MARKDOWN_FORMAT_VALUES,
  RpcError,
  MediaHandleStore,
  MediaCleaner,
  MediaFetchManager,
  type DownloadResult,
} from 'crabot-shared'

import { DingtalkClient, type SendMsgKey } from './dingtalk-client.js'
import { StreamSubscriber } from './stream-subscriber.js'
import { SessionManager } from './session-manager.js'
import { MessageStore, type StoredMessage } from './message-store.js'
import { splitText } from './text-splitter.js'
import { mapMessageContent, detectMentionCrab, type MappedMessage } from './event-mapper.js'
import type {
  DingtalkInboundMessage,
  DingtalkChannelConfig,
  DingtalkCacheConfig,
  MarkdownFormat,
  ChannelMessage,
  ChannelCapabilities,
  MessageContent,
  Session,
  SessionType,
  SendMessageParams,
  SendMessageResult,
  GetSessionsParams,
  GetSessionParams,
  DeleteSessionResult,
  FindOrCreatePrivateSessionParams,
  GetHistoryParams,
  GetMessageParams,
  HistoryMessage,
  PlatformUserInfoResult,
  GroupMember,
  ListGroupMembersParams,
  ListGroupMembersResult,
  FetchMediaParams,
  FetchMediaResult,
} from './types.js'

/** 钉钉单条消息文本上限（保守值，超长走 splitText 分条） */
const MAX_MESSAGE_LENGTH = 20000

const DEFAULT_CACHE_CONFIG: DingtalkCacheConfig = {
  max_days: 30,
  max_messages_per_session: 1000,
}

export interface DingtalkChannelInitConfig {
  module_id: string
  module_type?: 'channel'
  version?: string
  protocol_version?: string
  port: number
  data_dir: string
  dingtalk: DingtalkChannelConfig
  cache?: Partial<DingtalkCacheConfig>
}

export class DingtalkChannel extends ModuleBase {
  private readonly dingtalkConfig: DingtalkChannelConfig
  private readonly dataDir: string
  private readonly cacheConfig: DingtalkCacheConfig
  private readonly client: DingtalkClient
  private readonly subscriber: StreamSubscriber
  private readonly sessionManager: SessionManager
  private readonly messageStore: MessageStore
  private readonly mediaHandleStore: MediaHandleStore
  private readonly mediaCleaner: MediaCleaner
  private readonly mediaFetch: MediaFetchManager

  /** 机器人自身昵称（钉钉入站 payload 不含，暂无来源，保留字段供未来接线） */
  private botName: string | null = null

  /**
   * platform_session_id → 最近一次入站携带的会话级 sessionWebhook（免 token 即时回复兜底）。
   * token 发送失败时作为降级路径。
   */
  private readonly sessionWebhooks: Map<string, { url: string; expiresAt: number }> = new Map()

  constructor(config: DingtalkChannelInitConfig) {
    const moduleConfig: ModuleConfig = {
      moduleId: config.module_id,
      moduleType: config.module_type ?? 'channel',
      version: config.version ?? '0.1.0',
      protocolVersion: config.protocol_version ?? '0.1.0',
      port: config.port,
      subscriptions: [],
    }
    super(moduleConfig)

    this.dingtalkConfig = config.dingtalk
    this.dataDir = config.data_dir
    this.cacheConfig = { ...DEFAULT_CACHE_CONFIG, ...config.cache }

    this.client = new DingtalkClient({
      appKey: config.dingtalk.app_key,
      appSecret: config.dingtalk.app_secret,
      robotCode: config.dingtalk.robot_code,
    })
    this.subscriber = new StreamSubscriber({
      clientId: config.dingtalk.app_key,
      clientSecret: config.dingtalk.app_secret,
      onMessage: (msg) => this.safeHandle('message', () => this.handleMessageReceive(msg)),
    })
    this.sessionManager = new SessionManager(config.module_id, config.data_dir)
    this.messageStore = new MessageStore(config.data_dir, this.cacheConfig)
    this.mediaHandleStore = new MediaHandleStore(config.data_dir)
    this.mediaCleaner = new MediaCleaner(config.data_dir, 7)
    this.mediaFetch = new MediaFetchManager({
      store: this.mediaHandleStore,
      channelId: this.config.moduleId,
      download: (rec) =>
        this.downloadMediaByCode(rec.credential.download_code as string, rec.kind, rec.filename),
      publishEvent: (event) =>
        this.rpcClient.publishEvent(event, this.config.moduleId).then(() => undefined),
    })

    fs.mkdirSync(path.join(this.dataDir, 'media'), { recursive: true })
    this.registerMethods()
  }

  // ============================================================================
  // 生命周期
  // ============================================================================

  protected override async onStart(): Promise<void> {
    await this.mediaHandleStore.init()
    this.messageStore.startCleanup()
    this.mediaCleaner.startCleanup()
    await this.subscriber.start()
    console.log(`[DingtalkChannel] started (robotCode=${this.dingtalkConfig.robot_code})`)
  }

  protected override async onStop(): Promise<void> {
    this.messageStore.stopCleanup()
    this.mediaCleaner.stopCleanup()
    await this.subscriber.close()
  }

  private async safeHandle(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      console.error(`[DingtalkChannel] ${label} handler error:`, err)
    }
  }

  // ============================================================================
  // 入站流水线（镜像 feishu handleMessageReceive）
  // ============================================================================

  private async handleMessageReceive(msg: DingtalkInboundMessage): Promise<void> {
    // 1. 基本校验：需要 msgId 定位消息（钉钉 Stream 不回显机器人自身消息，无需额外的 bot-self 判断）
    if (!msg.msgId) return

    // 2. 路由：群聊('2')=conversationId；单聊('1')=senderStaffId
    //    注意：群聊 session key 用 conversationId，即使 senderStaffId 为空（外部/临时成员）也应继续处理；
    //    仅私聊必须有 senderStaffId 才能定位会话，否则 platformSessionId 为空被下面跳过。
    const isGroup = msg.conversationType === '2'
    const platformSessionId = isGroup ? msg.conversationId : msg.senderStaffId
    const sessionType: SessionType = isGroup ? 'group' : 'private'
    if (!platformSessionId) return

    // 私聊强制 false（对齐 feishu：@ 仅在群聊有意义）
    const isMentionCrab = isGroup ? detectMentionCrab(msg) : false

    // 3. 群聊 @-gating
    if (isGroup && this.dingtalkConfig.only_respond_to_mentions && !isMentionCrab) {
      return
    }

    // 4. 内容映射 + 媒体接线（图片急下 / 文件惰性 handle）
    const mapped = mapMessageContent(msg)
    const content = await this.applyMediaContent(mapped)

    const senderName = msg.senderNick || msg.senderStaffId
    const placeholderTitle = isGroup
      ? (msg.conversationTitle?.trim() || platformSessionId)
      : senderName

    // 5. upsert session；created → 发 session_changed
    const { session, created } = this.sessionManager.upsert({
      platform_session_id: platformSessionId,
      type: sessionType,
      title: placeholderTitle,
      sender_id: msg.senderStaffId,
      sender_name: senderName,
    })
    if (created) await this.publishSessionChanged('created', session)

    // 记住会话级 webhook 供出站兜底
    if (typeof msg.sessionWebhook === 'string' && msg.sessionWebhook) {
      this.sessionWebhooks.set(platformSessionId, {
        url: msg.sessionWebhook,
        expiresAt: typeof msg.sessionWebhookExpiredTime === 'number' ? msg.sessionWebhookExpiredTime : 0,
      })
    }

    // 文件惰性 handle 补写 session_id，供慢档下载完成事件路由
    if (content.type === 'file' && content.handle) {
      await this.mediaHandleStore.setSessionId(content.handle, session.id)
    }

    const platformTimestamp = isoFromMillis(msg.createAt) ?? generateTimestamp()

    // 6. 组 ChannelMessage
    const channelMessage: ChannelMessage = {
      platform_message_id: msg.msgId,
      session: { session_id: session.id, channel_id: this.config.moduleId, type: session.type },
      sender: { platform_user_id: msg.senderStaffId, platform_display_name: senderName },
      content,
      features: {
        is_mention_crab: isMentionCrab,
        ...(mapped.features.mentions ? { mentions: mapped.features.mentions } : {}),
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

    // 7. 发布 channel.message_received
    const event: Event = {
      id: generateId(),
      type: 'channel.message_received',
      source: this.config.moduleId,
      payload: {
        channel_id: this.config.moduleId,
        message: channelMessage,
        ...(this.botName ? { crab_display_name: this.botName } : {}),
        // 多机器人群里 dispatcher/worker 用此值判断哪条 @ 是自己（缺 chatbotUserId 时不发，避免 @undefined）
        ...(msg.chatbotUserId ? { crab_self_handle: `@${msg.chatbotUserId}` } : {}),
      },
      timestamp: generateTimestamp(),
    }
    await this.rpcClient.publishEvent(event, this.config.moduleId)
  }

  /**
   * 把 mapper 输出的 image/file 补齐媒体信息。
   * - 图片：急切下载（VLM 内联看图需本地文件），写 file_path + status=ready
   * - 文件：惰性——只登记 handle + 元信息 + status=not_fetched，credential 存 downloadCode + robotCode
   */
  private async applyMediaContent(mapped: MappedMessage): Promise<MessageContent> {
    const { content, raw } = mapped
    const downloadCode = raw?.download_code

    if (content.type === 'image') {
      if (!downloadCode) return { type: 'text', text: '[图片]' }
      const r = await this.downloadMediaByCode(downloadCode, 'image')
      if (!r) return { type: 'text', text: '[图片下载失败]' }
      return {
        ...content,
        file_path: r.filePath,
        status: 'ready',
        ...(r.mimeType ? { mime_type: r.mimeType } : {}),
        size: r.size,
      }
    }

    if (content.type === 'file') {
      if (!downloadCode) return content
      const handle = await this.mediaHandleStore.put({
        kind: 'file',
        ...(raw?.filename ? { filename: raw.filename } : {}),
        ...(content.size !== undefined ? { size: content.size } : {}),
        credential: { download_code: downloadCode, robot_code: this.dingtalkConfig.robot_code },
      })
      return { ...content, handle, status: 'not_fetched' }
    }

    return content
  }

  /**
   * 用 downloadCode 换取临时 URL 并落盘。
   * - image：按 magic bytes 探测扩展名 + mime_type
   * - file：用 filenameHint 的扩展名；拿不到则 .bin
   * 失败返回 null（调用方降级）。
   */
  private async downloadMediaByCode(
    downloadCode: string,
    kind: 'image' | 'file',
    filenameHint?: string,
  ): Promise<DownloadResult | null> {
    if (!downloadCode) return null
    try {
      const url = await this.client.getMediaDownloadUrl(downloadCode)
      const resp = await fetch(url)
      if (!resp.ok) {
        console.warn(`[DingtalkChannel] media download HTTP ${resp.status} for code ${downloadCode}`)
        return null
      }
      const buffer = Buffer.from(await resp.arrayBuffer())

      let ext: string
      let mimeType: string | undefined
      if (kind === 'image') {
        const det = detectImageMime(buffer)
        ext = det.ext
        mimeType = det.mime
      } else {
        const fromHint = filenameHint ? path.extname(filenameHint) : ''
        ext = fromHint && /^\.[A-Za-z0-9]{1,8}$/.test(fromHint) ? fromHint : '.bin'
      }
      const safe = downloadCode.replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || 'media'
      const filePath = path.join(this.dataDir, 'media', `${safe}${ext}`)
      await fsp.writeFile(filePath, buffer)
      return { filePath, size: buffer.length, ...(mimeType ? { mimeType } : {}) }
    } catch (err) {
      console.warn(`[DingtalkChannel] media download failed for code ${downloadCode} (${kind}):`, err)
      return null
    }
  }

  private async publishSessionChanged(
    type: 'created' | 'updated' | 'participants_changed' | 'removed',
    session: Session,
  ): Promise<void> {
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
  // RPC
  // ============================================================================

  private registerMethods(): void {
    this.registerMethod('send_message', this.handleSendMessage.bind(this))
    this.registerMethod('get_capabilities', this.handleGetCapabilities.bind(this))
    this.registerMethod('get_sessions', this.handleGetSessions.bind(this))
    this.registerMethod('get_session', this.handleGetSession.bind(this))
    this.registerMethod('delete_session', this.handleDeleteSession.bind(this))
    this.registerMethod('find_or_create_private_session', this.handleFindOrCreatePrivateSession.bind(this))
    this.registerMethod('get_history', this.handleGetHistory.bind(this))
    this.registerMethod('get_message', this.handleGetMessage.bind(this))
    this.registerMethod('get_platform_user_info', this.handleGetPlatformUserInfo.bind(this))
    this.registerMethod('list_group_members', this.handleListGroupMembers.bind(this))
    this.registerMethod('fetch_media', this.handleFetchMedia.bind(this))
    this.registerMethod('get_config', this.handleGetConfig.bind(this))
    this.registerMethod('update_config', this.handleUpdateConfig.bind(this))
    this.registerMethod('add_reaction', this.handleAddReaction.bind(this))
  }

  // ── send ─────────────────────────────────────────────────────────────────

  private async handleSendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throw new RpcError('NOT_FOUND', `Session not found: ${params.session_id}`)

    const content = params.content
    // 钉钉机器人 token 路径仅支持 sampleText / sampleMarkdown。
    // 媒体出站需先上传 media 换 mediaId，而 DingtalkClient 未实现上传，故暂不支持。
    if (content.type === 'image' || content.type === 'file') {
      throw new RpcError('CHANNEL_UNSUPPORTED_MESSAGE_TYPE', `钉钉机器人暂不支持发送 ${content.type} 类型消息`)
    }

    // 注：v1 出站不注入 @——features.mentions 不渲染为真 @ 通知（capabilities 亦未声明 'mention'）。
    const rawText = content.text ?? ''
    const useMarkdown = decideMarkdownEnabled(this.dingtalkConfig.markdown_format, rawText)
    const chunks = splitText(rawText, MAX_MESSAGE_LENGTH)
    const sendChunks = chunks.length > 0 ? chunks : ['']

    let lastProcessKey = ''
    let lastSentAt = generateTimestamp()

    for (const chunk of sendChunks) {
      const msgKey: SendMsgKey = useMarkdown ? 'sampleMarkdown' : 'sampleText'
      const msgParam: Record<string, unknown> = useMarkdown
        ? { title: deriveMarkdownTitle(chunk), text: chunk }
        : { content: chunk }

      lastProcessKey = await this.sendOne(session, msgKey, msgParam)
      lastSentAt = generateTimestamp()

      await this.messageStore.append(
        session.id,
        this.buildOutboundStored(
          lastProcessKey,
          sendChunks.length === 1 ? content : { ...content, text: chunk },
          lastSentAt,
        ),
      )
    }

    return { platform_message_id: lastProcessKey, sent_at: lastSentAt }
  }

  /**
   * 发送一条：群聊走 sendGroupMessage，单聊走 sendOneToOneMessage。
   * token 路径失败且该会话有未过期 sessionWebhook → 降级走 webhook（不返回 processQueryKey）。
   */
  private async sendOne(
    session: Session,
    msgKey: SendMsgKey,
    msgParam: Record<string, unknown>,
  ): Promise<string> {
    try {
      if (session.type === 'group') {
        return await this.client.sendGroupMessage(session.platform_session_id, msgKey, msgParam)
      }
      return await this.client.sendOneToOneMessage([session.platform_session_id], msgKey, msgParam)
    } catch (err) {
      const wh = this.sessionWebhooks.get(session.platform_session_id)
      if (wh && (wh.expiresAt === 0 || Date.now() < wh.expiresAt)) {
        try {
          await this.client.sendViaSessionWebhook(wh.url, buildWebhookBody(msgKey, msgParam))
          return ''
        } catch (whErr) {
          console.warn('[DingtalkChannel] sessionWebhook fallback failed:', whErr)
        }
      }
      throw err
    }
  }

  private buildOutboundStored(messageId: string, content: MessageContent, timestamp: string): StoredMessage {
    return {
      direction: 'outbound',
      platform_message_id: messageId,
      sender: {
        platform_user_id: this.dingtalkConfig.robot_code,
        platform_display_name: this.botName ?? 'Crabot',
      },
      content,
      features: { is_mention_crab: false },
      platform_timestamp: timestamp,
    }
  }

  // ── capabilities ───────────────────────────────────────────────────────────

  private handleGetCapabilities(): ChannelCapabilities {
    return {
      // 出站 v1 仅支持文本/Markdown（均为 type 'text'）；图片/文件为入站方向能力，
      // 通过 fetch_media 拉取，不在可发送类型内（对齐设计 §2 非目标：出站不发媒体）。
      supported_message_types: ['text'],
      // v1 出站仅 text/markdown、不注入 @，也无 reaction API → supported_features 留空。
      // （入站仍解析 @，见 is_mention_crab / features.mentions；add_reaction 保留为优雅 no-op。）
      supported_features: [],
      supports_history_query: true,
      supports_platform_user_query: false,
      max_message_length: MAX_MESSAGE_LENGTH,
      max_file_size: null,
      supports_file_path: false,
      allowed_file_paths: [],
      supports_list_contacts: false,
      supports_list_groups: false,
      supports_list_group_members: true,
      supports_media_fetch: true,
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
    if (!session) throw new RpcError('NOT_FOUND', 'Session not found')
    return { session }
  }

  private async handleDeleteSession(params: { session_id: string }): Promise<DeleteSessionResult> {
    const removed = this.sessionManager.removeById(params.session_id)
    if (!removed) return { deleted: false }
    await this.publishSessionChanged('removed', { ...removed, participants: [] })
    return { deleted: true }
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

  // ── history / message ───────────────────────────────────────────────────────

  private async handleGetHistory(params: GetHistoryParams) {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throw new RpcError('NOT_FOUND', 'Session not found')

    const usingLimit = !!params.limit
    const pageSize = params.pagination?.page_size ?? params.limit ?? 20
    // limit 语义 = 取最新 N 条；走 messageStore 的 slice(-limit) 分支需要 page=undefined 且透传 limit
    const page = usingLimit ? undefined : (params.pagination?.page ?? 1)

    const local = await this.messageStore.query({
      sessionId: session.id,
      timeRange: params.time_range,
      keyword: params.keyword,
      page,
      pageSize,
      limit: usingLimit ? params.limit : undefined,
    })

    return paginated(local.items.map(toHistoryMessage), page ?? 1, pageSize, local.total)
  }

  private async handleGetMessage(params: GetMessageParams): Promise<HistoryMessage> {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throw new RpcError('NOT_FOUND', 'Session not found')
    const local = await this.messageStore.findByMessageId(session.id, params.platform_message_id)
    if (!local) throw new RpcError('NOT_FOUND', 'Message not found')
    return toHistoryMessage(local)
  }

  // ── platform user ────────────────────────────────────────────────────────────

  private handleGetPlatformUserInfo(_params: { platform_user_id: string }): PlatformUserInfoResult {
    // 钉钉无直查用户 API（对齐 supports_platform_user_query=false）
    throw new RpcError(
      'CHANNEL_PLATFORM_USER_QUERY_UNAVAILABLE',
      '钉钉渠道不支持直接查询平台用户信息',
    )
  }

  // ── group members ────────────────────────────────────────────────────────────

  private handleListGroupMembers(params: ListGroupMembersParams): ListGroupMembersResult {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throw new RpcError('NOT_FOUND', `Session ${params.session_id} not found`)
    if (session.type !== 'group') throw new RpcError('INVALID_ARGUMENT', `Session ${params.session_id} is not a group`)

    // 钉钉难拿全员名单：仅返回本会话中已交互过（发言/被 @）的成员子集
    const all: GroupMember[] = session.participants.map((p) => ({
      platform_user_id: p.platform_user_id,
      role: p.role,
    }))

    const page = params.pagination?.page ?? 1
    const pageSize = params.pagination?.page_size ?? 50
    const start = (page - 1) * pageSize
    const items = all.slice(start, start + pageSize)

    return {
      items,
      pagination: {
        page,
        page_size: pageSize,
        total_items: all.length,
        total_pages: Math.max(1, Math.ceil(all.length / pageSize)),
      },
      member_count: all.length,
      members_complete: false,
      partial_reason: '仅包含已在本会话发言或被 @ 过的成员；平台未提供完整群成员名单查询能力。',
    }
  }

  // ── media ────────────────────────────────────────────────────────────────────

  private async handleFetchMedia(params: FetchMediaParams): Promise<FetchMediaResult> {
    return this.mediaFetch.fetch(params.handle)
  }

  // ── reaction ───────────────────────────────────────────────────────────────

  private handleAddReaction(_params: {
    session_id: string
    platform_message_id: string
    kind: string
  }): { added: boolean } {
    // 钉钉机器人无 reaction API
    return { added: false }
  }

  // ── config ───────────────────────────────────────────────────────────────────

  private handleGetConfig() {
    const cfg: Record<string, unknown> = {
      platform: 'dingtalk',
      // 协议 §6：用于识别 @Crabot 的机器人平台身份。钉钉无稳定 bot userId，用 robot_code。
      crab_platform_user_id: this.dingtalkConfig.robot_code,
      credentials: {
        app_key: this.dingtalkConfig.app_key,
        app_secret: '***',
        robot_code: this.dingtalkConfig.robot_code,
        ...(this.dingtalkConfig.owner_staff_id ? { owner_staff_id: this.dingtalkConfig.owner_staff_id } : {}),
      },
      cache: {
        max_days: this.cacheConfig.max_days,
        max_messages_per_session: this.cacheConfig.max_messages_per_session,
      },
      group: {
        only_respond_to_mentions: this.dingtalkConfig.only_respond_to_mentions,
      },
      markdown_format: this.dingtalkConfig.markdown_format,
    }
    return {
      config: cfg,
      schema: {
        'credentials.app_key': { hot_reload: false, description: 'AppKey，变更需重启' },
        'credentials.app_secret': { sensitive: true, hot_reload: false, description: 'AppSecret，变更需重启' },
        'credentials.robot_code': { hot_reload: false, description: 'RobotCode，变更需重启' },
        'group.only_respond_to_mentions': { hot_reload: true, description: '群聊仅响应 @ 机器人' },
        'markdown_format': { hot_reload: true, description: 'Markdown 渲染开关：auto / on / off' },
        'cache.max_days': { hot_reload: true, description: '消息缓存天数（下次清理生效）' },
        'cache.max_messages_per_session': { hot_reload: true, description: '每会话最多缓存条数（下次清理生效）' },
      },
    }
  }

  /**
   * Admin Web 把 handleGetConfig 的嵌套结构原样回传，字段路径与 get 输出一一对应：
   * credentials.* / cache.* / group.* / markdown_format。敏感字段收到 *** 表示未改，跳过。
   * 凭据类变更标 requires_restart；only_respond_to_mentions / markdown_format / cache 热更。
   */
  private handleUpdateConfig(params: {
    config?: {
      credentials?: { app_key?: string; app_secret?: string; robot_code?: string; owner_staff_id?: string }
      cache?: { max_days?: number; max_messages_per_session?: number }
      group?: { only_respond_to_mentions?: boolean }
      markdown_format?: MarkdownFormat
    }
  }): { config: Record<string, unknown>; requires_restart: boolean } {
    const incoming = params.config ?? {}
    let requiresRestart = false

    const creds = incoming.credentials ?? {}
    if (typeof creds.app_key === 'string' && creds.app_key && creds.app_key !== this.dingtalkConfig.app_key) {
      this.dingtalkConfig.app_key = creds.app_key
      requiresRestart = true
    }
    if (typeof creds.app_secret === 'string' && creds.app_secret && creds.app_secret !== '***') {
      this.dingtalkConfig.app_secret = creds.app_secret
      requiresRestart = true
    }
    if (typeof creds.robot_code === 'string' && creds.robot_code && creds.robot_code !== this.dingtalkConfig.robot_code) {
      this.dingtalkConfig.robot_code = creds.robot_code
      requiresRestart = true
    }
    if (creds.owner_staff_id !== undefined) {
      this.dingtalkConfig.owner_staff_id = creds.owner_staff_id || undefined
    }

    const group = incoming.group ?? {}
    if (typeof group.only_respond_to_mentions === 'boolean') {
      this.dingtalkConfig.only_respond_to_mentions = group.only_respond_to_mentions
    }

    if (incoming.markdown_format && MARKDOWN_FORMAT_VALUES.includes(incoming.markdown_format)) {
      this.dingtalkConfig.markdown_format = incoming.markdown_format
    }

    const cache = incoming.cache ?? {}
    if (typeof cache.max_days === 'number' && cache.max_days > 0) {
      this.cacheConfig.max_days = cache.max_days
    }
    if (typeof cache.max_messages_per_session === 'number' && cache.max_messages_per_session > 0) {
      this.cacheConfig.max_messages_per_session = cache.max_messages_per_session
    }
    // 同步到真正执行清理的 MessageStore（协议 §6.1：cache.* 热生效，无需重启）
    this.messageStore.updateCacheConfig(cache)

    const masked = this.handleGetConfig().config
    return { config: masked, requires_restart: requiresRestart }
  }

  // ── health ───────────────────────────────────────────────────────────────────

  protected override async getHealthDetails(): Promise<Record<string, unknown>> {
    return {
      platform: 'dingtalk',
      platform_connected: this.subscriber.isConnected(),
      stream_state: this.subscriber.getState(),
      stream_connect_count: this.subscriber.getConnectCount(),
      stream_fail_count: this.subscriber.getFailCount(),
      stream_last_error: this.subscriber.getLastError() ?? null,
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

/** 钉钉 sampleMarkdown 需要 title；从正文首行推导一个简短标题。 */
function deriveMarkdownTitle(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim()) ?? ''
  const stripped = firstLine.replace(/^#+\s*/, '').replace(/[*_`>#[\]()]/g, '').trim()
  const base = stripped || text.trim()
  return base.slice(0, 20).trim() || 'Crabot'
}

/** token 路径失败时的 sessionWebhook 兜底 body（钉钉 webhook 消息格式）。 */
function buildWebhookBody(msgKey: SendMsgKey, msgParam: Record<string, unknown>): Record<string, unknown> {
  if (msgKey === 'sampleMarkdown') {
    return {
      msgtype: 'markdown',
      markdown: { title: String(msgParam.title ?? ''), text: String(msgParam.text ?? '') },
    }
  }
  return { msgtype: 'text', text: { content: String(msgParam.content ?? '') } }
}

interface ImageSignature {
  mime: string
  ext: string
  match: (buf: Buffer) => boolean
}

const IMAGE_SIGNATURES: ReadonlyArray<ImageSignature> = [
  { mime: 'image/png',  ext: '.png',  match: (b) => b.length >= 8  && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: '.jpg',  match: (b) => b.length >= 3  && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif',  ext: '.gif',  match: (b) => b.length >= 6  && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { mime: 'image/webp', ext: '.webp', match: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  { mime: 'image/bmp',  ext: '.bmp',  match: (b) => b.length >= 2  && b[0] === 0x42 && b[1] === 0x4d },
]

function detectImageMime(buffer: Buffer): { mime: string; ext: string } {
  const hit = IMAGE_SIGNATURES.find((s) => s.match(buffer))
  return hit ?? { mime: 'application/octet-stream', ext: '.bin' }
}
