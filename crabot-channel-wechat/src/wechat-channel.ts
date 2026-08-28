/**
 * WechatChannel - Crabot Channel 模块
 *
 * 通过 wechat-connector 的 Bot API 接入微信：
 * - 收消息：Socket.IO 连接 /puppet-events 或 Webhook 监听
 * - 发消息：REST API POST /api/v1/bot/send
 *
 * 参考 BOT_INTEGRATION.md
 */

import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  ModuleBase,
  type ModuleConfig,
  generateId,
  generateTimestamp,
  type Event,
  MediaHandleStore,
  MediaCleaner,
  MediaFetchManager,
  type MediaHandleRecord,
  type FetchMediaResult,
} from 'crabot-shared'
import { setTimeout as sleep } from 'node:timers/promises'
import { WechatClient } from './wechat-client.js'
import { formatWechatContent } from './format-wechat-content.js'
import { SessionManager } from './session-manager.js'
import { splitLongText } from './split-long-text.js'
import type {
  WechatRawEvent,
  WebhookEnvelope,
  WechatChannelConfig,
  ChannelMessage,
  ChannelCapabilities,
  MessageContent,
  SendMessageParams,
  SendMessageResult,
  GetSessionsParams,
  GetSessionParams,
  FindOrCreatePrivateSessionParams,
  GetHistoryParams,
  GetMessageParams,
  SessionType,
  ListContactsParams,
  ListContactsResult,
  ListGroupsParams,
  ListGroupsResult,
  ListGroupMembersParams,
  ListGroupMembersResult,
  GroupMember,
  ContactItem,
  GroupItem,
  FetchMediaParams,
} from './types.js'

export interface WechatChannelInitConfig {
  module_id: string
  module_type: 'channel'
  version: string
  protocol_version: string
  port: number
  data_dir: string
  wechat: WechatChannelConfig
}

export class WechatChannel extends ModuleBase {
  private readonly client: WechatClient
  private readonly sessionManager: SessionManager
  private readonly wechatConfig: WechatChannelConfig
  private readonly dataDir: string
  private readonly mediaHandleStore: MediaHandleStore
  private readonly mediaCleaner: MediaCleaner
  private readonly mediaFetch: MediaFetchManager
  /** Crabot 自己的 wxid（puppet 身份仅随事件携带，get_config 用；事件到来前 undefined） */
  private puppetWxid: string | undefined = undefined

  // Socket.IO 连接（动态 import，仅 socketio 模式使用）
  private socket: { disconnect(): void; on(event: string, handler: (...args: unknown[]) => void): void } | null = null
  // Webhook 服务器（仅 webhook 模式使用）
  private webhookServer: http.Server | null = null

  /** Crabot 群昵称缓存: chatroomName → { nick, fetchedAt } */
  private crabNickCache: Map<string, { nick: string; fetchedAt: number }> = new Map()
  private static readonly NICK_CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

  constructor(config: WechatChannelInitConfig) {
    const moduleConfig: ModuleConfig = {
      moduleId: config.module_id,
      moduleType: config.module_type,
      version: config.version,
      protocolVersion: config.protocol_version,
      port: config.port,
      subscriptions: [],
    }

    super(moduleConfig)

    // 规范化 connector_url：去掉尾部 /puppet-events（如用户从前端复制了完整连接地址）
    const cleanUrl = config.wechat.connector_url.replace(/\/puppet-events\/?$/, '').replace(/\/+$/, '')
    this.wechatConfig = { ...config.wechat, connector_url: cleanUrl }
    this.dataDir = config.data_dir
    this.client = new WechatClient(cleanUrl, config.wechat.api_key)
    this.sessionManager = new SessionManager(config.module_id, config.data_dir)
    this.mediaHandleStore = new MediaHandleStore(config.data_dir)
    this.mediaCleaner = new MediaCleaner(config.data_dir, 7)
    this.mediaFetch = new MediaFetchManager({
      store: this.mediaHandleStore,
      channelId: this.config.moduleId,
      download: (rec) => this.downloadFile(rec),
      publishEvent: (event) => this.rpcClient.publishEvent(event, this.config.moduleId).then(() => undefined),
    })

    this.registerMethods()
  }

  // ============================================================================
  // 生命周期
  // ============================================================================

  protected override async onStart(): Promise<void> {
    // 验证连通性
    try {
      const puppet = await this.client.getPuppet()
      console.log(`[WechatChannel] Connected to puppet: ${puppet.wechatNickname} (${puppet.wechatUsername}), status: ${puppet.status}`)
    } catch (error) {
      console.error('[WechatChannel] Failed to connect to wechat-connector:', error)
      throw error
    }

    // 初始化媒体 store + 清理器
    await this.mediaHandleStore.init()
    this.mediaCleaner.startCleanup()

    // 启动时从上游重建 group sessions（失败不阻塞启动）
    await this.bootstrapGroupSessions()

    // 启动消息接收
    if (this.wechatConfig.mode === 'socketio') {
      await this.startSocketIO()
    } else if (this.wechatConfig.mode === 'webhook') {
      await this.startWebhookServer()
    }
  }

  protected override async onStop(): Promise<void> {
    this.mediaCleaner.stopCleanup()
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
    if (this.webhookServer) {
      await new Promise<void>((resolve) => {
        this.webhookServer!.close(() => resolve())
      })
      this.webhookServer = null
    }
  }

  // ============================================================================
  // Socket.IO 模式
  // ============================================================================

  private async startSocketIO(): Promise<void> {
    // 动态 import socket.io-client
    const { io } = await import('socket.io-client')

    // connector_url 是服务器基础地址（构造函数已清理），/puppet-events 是 Socket.IO namespace
    const url = `${this.wechatConfig.connector_url}/puppet-events`
    console.log(`[WechatChannel] Connecting Socket.IO to ${url}`)

    const socket = io(url, {
      auth: { token: this.wechatConfig.api_key },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30000,
    })

    socket.on('connect', () => {
      console.log('[WechatChannel] Socket.IO connected')
    })

    socket.on('wechat_message', (event: WechatRawEvent) => {
      this.handleWechatEvent(event).catch((error) => {
        console.error('[WechatChannel] Error handling event:', error)
      })
    })

    socket.on('disconnect', (reason: string) => {
      console.warn(`[WechatChannel] Socket.IO disconnected: ${reason}`)
    })

    socket.on('connect_error', (err: Error) => {
      console.error('[WechatChannel] Socket.IO connect error:', err.message)
    })

    this.socket = socket
  }

  // ============================================================================
  // Webhook 模式
  // ============================================================================

  private async startWebhookServer(): Promise<void> {
    const port = this.wechatConfig.webhook_port
    if (!port) {
      throw new Error('webhook_port is required for webhook mode')
    }

    this.webhookServer = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end('Method Not Allowed')
        return
      }

      let body = ''
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        try {
          const envelope = JSON.parse(body) as WebhookEnvelope

          // 验证签名
          if (this.wechatConfig.webhook_secret) {
            const dataStr = JSON.stringify(envelope.data)
            const expected = crypto
              .createHmac('sha256', this.wechatConfig.webhook_secret)
              .update(dataStr)
              .digest('hex')

            if (envelope.signature !== expected) {
              console.warn('[WechatChannel] Webhook signature mismatch')
              res.writeHead(401)
              res.end('Invalid signature')
              return
            }
          }

          res.writeHead(200)
          res.end('OK')

          // 异步处理事件
          this.handleWechatEvent(envelope.data).catch((error) => {
            console.error('[WechatChannel] Error handling webhook event:', error)
          })
        } catch (error) {
          console.error('[WechatChannel] Invalid webhook payload:', error)
          res.writeHead(400)
          res.end('Bad Request')
        }
      })
    })

    await new Promise<void>((resolve) => {
      this.webhookServer!.listen(port, () => {
        console.log(`[WechatChannel] Webhook server listening on port ${port}`)
        resolve()
      })
    })
  }

  // ============================================================================
  // 事件处理：WechatRawEvent → ChannelMessage → publish
  // ============================================================================

  private async handleWechatEvent(event: WechatRawEvent): Promise<void> {
    const isGroup = event.conversation.isGroup
    const platformSessionId = event.conversation.id

    console.log(
      `[WechatChannel] Event: ${event.eventId}, sender=${event.sender.name} (${event.sender.wxid}), ` +
      `conversation=${event.conversation.name}, isGroup=${isGroup}`
    )

    this.puppetWxid = event.puppet?.wxid ?? this.puppetWxid

    const rawContent = event.message.content as Record<string, unknown>

    // 检测 @Crabot
    const atString = (rawContent.at_string as string | undefined) ?? ''
    const isMentionCrab = isGroup && atString.split(',').some(wxid => wxid.trim() === event.puppet.wxid)

    // 群聊门控（group.only_respond_to_mentions）：只放行定向消息——@ Crabot，或
    // 引用/回复 Crabot 发言（connector 反查补齐的 quoted_sender_wxid 与 puppet.wxid
    // 同一 ID 空间，精确对照；字段缺失即反查失败，按"无法确认引用 Crabot"丢弃）。
    // 丢弃发生在 session upsert 与事件发布之前：不建 session、不发布、无 journal。
    if (this.wechatConfig.only_respond_to_mentions === true && isGroup && !isMentionCrab) {
      const quotedSenderWxid = typeof rawContent.quoted_sender_wxid === 'string'
        ? rawContent.quoted_sender_wxid
        : undefined
      if (quotedSenderWxid !== event.puppet.wxid) {
        console.log(
          `[WechatChannel] Dropped non-directed group message, event=${event.eventId}, ` +
          `sender=${event.sender.wxid}, quoted_sender_wxid=${quotedSenderWxid ?? '(missing)'}`
        )
        return
      }
    }

    // 创建/更新 Session
    const { session } = this.sessionManager.upsert({
      platform_session_id: platformSessionId,
      type: isGroup ? 'group' : 'private',
      title: event.conversation.name,
      sender_wxid: event.sender.wxid,
      sender_name: event.sender.name,
    })

    // 格式化消息内容（所有消息类型统一通过 formatWechatContent 处理）
    const msgType = event.message.type
    const { content: formattedContent, features: extraFeatures } = formatWechatContent(msgType, rawContent)

    // 文件（公开 URL）惰性化：登记 handle，图片保持原样
    const content = await this.lazifyFileContent(formattedContent, session.id, event.message.id)

    // 获取 Crabot 群昵称（仅群聊）
    const crabDisplayName = isGroup
      ? await this.getCrabGroupNick(platformSessionId, event.puppet.wxid)
      : undefined

    // dispatcher / worker 用它区分"哪个 @ 是发给我的"。微信正文里的 @ 是 @昵称，
    // self 锚点必须用群昵称才能跟正文对得上；wxid 永远不出现在正文里、对照不上
    // （实测会导致 bot 认不出 @ 自己 / 误判收件人）。群昵称取不到时回退 wxid。
    const crabSelfHandle = crabDisplayName
      ? `@${crabDisplayName}`
      : (event.puppet?.wxid ? `@${event.puppet.wxid}` : undefined)

    // 构建 ChannelMessage
    const channelMessage: ChannelMessage = {
      platform_message_id: event.message.id,
      session: {
        session_id: session.id,
        channel_id: this.config.moduleId,
        type: session.type,
      },
      sender: {
        platform_user_id: event.sender.wxid,
        platform_display_name: event.sender.name,
      },
      content,
      features: {
        is_mention_crab: isMentionCrab,
        ...extraFeatures,
      },
      platform_timestamp: connectorTimeToISO(event.message.createTime),
    }

    // 发布 channel.message_received 事件
    const crabotEvent: Event = {
      id: generateId(),
      type: 'channel.message_received',
      source: this.config.moduleId,
      payload: {
        channel_id: this.config.moduleId,
        message: channelMessage,
        ...(crabDisplayName !== undefined ? { crab_display_name: crabDisplayName } : {}),
        ...(crabSelfHandle ? { crab_self_handle: crabSelfHandle } : {}),
      },
      timestamp: generateTimestamp(),
    }

    await this.rpcClient.publishEvent(crabotEvent, this.config.moduleId)
    console.log(`[WechatChannel] Published channel.message_received, session=${session.id}`)
  }

  // ============================================================================
  // 群聊 bootstrap（启动时从上游重建 group sessions）
  // ============================================================================

  private static readonly BOOTSTRAP_PAGE_SIZE = 50

  private async bootstrapGroupSessions(): Promise<void> {
    console.log('[WechatChannel] Group bootstrap: start')

    let fetched = 0
    let written = 0
    let skipped = 0

    try {
      let page = 1
      const pageSize = WechatChannel.BOOTSTRAP_PAGE_SIZE

      while (true) {
        const { items, pagination } = await this.client.listGroups({ page, pageSize })
        fetched += items.length

        for (const group of items) {
          try {
            const memberResp = await this.client.getGroupMembers(group.chatroomName)
            if (!memberResp?.members) {
              console.warn(
                `[WechatChannel] Skip group ${group.chatroomName}: members fetch returned null`
              )
              skipped += 1
              continue
            }

            const participants = memberResp.members.map((m) => ({
              platform_user_id: m.username,
              role: 'member' as const,
            }))

            this.sessionManager.upsertGroupSessionFromSnapshot({
              platform_session_id: group.chatroomName,
              title: group.name,
              participants,
            })
            written += 1
          } catch (err) {
            console.warn(
              `[WechatChannel] Skip group ${group.chatroomName}: members fetch failed:`,
              err
            )
            skipped += 1
          }
        }

        const totalPages = pagination?.totalPages ?? 1
        if (page >= totalPages || items.length === 0) break
        page += 1
      }
    } catch (err) {
      console.warn('[WechatChannel] Group bootstrap aborted:', err)
      return
    }

    console.log(
      `[WechatChannel] Group bootstrap done: fetched=${fetched}, written=${written}, skipped=${skipped}`
    )
  }

  // ============================================================================
  // 群昵称缓存
  // ============================================================================

  /**
   * 获取 Crabot 在群中的昵称（带 24h 缓存）
   * 通过查询群成员列表，找到 puppet.wxid 对应的 chatroom_nick
   */
  private async getCrabGroupNick(chatroomName: string, puppetWxid: string): Promise<string | undefined> {
    const cached = this.crabNickCache.get(chatroomName)
    if (cached && Date.now() - cached.fetchedAt < WechatChannel.NICK_CACHE_TTL_MS) {
      return cached.nick
    }

    try {
      const result = await this.client.getGroupMembers(chatroomName)
      if (!result?.members) return undefined

      const self = result.members.find(m => m.username === puppetWxid)
      const nick = self?.chatroom_nick || self?.nickname || undefined
      if (nick) {
        this.crabNickCache.set(chatroomName, { nick, fetchedAt: Date.now() })
      }
      return nick
    } catch {
      return undefined
    }
  }

  // ============================================================================
  // RPC 方法注册
  // ============================================================================

  private registerMethods(): void {
    this.registerMethod('send_message', this.handleSendMessage.bind(this))
    this.registerMethod('get_capabilities', this.handleGetCapabilities.bind(this))
    this.registerMethod('get_sessions', this.handleGetSessions.bind(this))
    this.registerMethod('list_contacts', this.handleListContacts.bind(this))
    this.registerMethod('list_groups', this.handleListGroups.bind(this))
    this.registerMethod('list_group_members', this.handleListGroupMembers.bind(this))
    this.registerMethod('get_session', this.handleGetSession.bind(this))
    this.registerMethod('find_or_create_private_session', this.handleFindOrCreatePrivateSession.bind(this))
    this.registerMethod('get_history', this.handleGetHistory.bind(this))
    this.registerMethod('get_message', this.handleGetMessage.bind(this))
    this.registerMethod('fetch_media', this.handleFetchMedia.bind(this))
    this.registerMethod('get_config', this.handleGetConfig.bind(this))
    this.registerMethod('update_config', this.handleUpdateConfig.bind(this))
  }

  // ============================================================================
  // Channel 协议方法实现
  // ============================================================================

  // ── config（protocol-channel.md §6.1）──────────────────────────────────────

  private handleGetConfig() {
    const cfg: Record<string, unknown> = {
      platform: 'wechat',
      credentials: {
        connector_url: this.wechatConfig.connector_url,
        api_key: '***',
      },
      group: {
        only_respond_to_mentions: this.wechatConfig.only_respond_to_mentions,
      },
      // puppet 身份仅随事件携带：事件到来前为空串（feishu 的 botOpenId 同款语义）
      crab_platform_user_id: this.puppetWxid ?? '',
    }
    return {
      config: cfg,
      schema: {
        'credentials.connector_url': { hot_reload: false, description: 'wechat-connector 地址，变更需重启' },
        'credentials.api_key': { sensitive: true, hot_reload: false, description: 'Bot API Key，变更需重启' },
        'group.only_respond_to_mentions': { hot_reload: true, description: '群聊仅响应定向消息（@ 或引用/回复 Crabot 发言）' },
      },
    }
  }

  /**
   * Admin Web 把 handleGetConfig 的嵌套结构原样回传，所以 incoming 字段路径必须
   * 跟 get 输出一一对应：credentials.* / group.*。api_key 收到掩码占位符 *** 表示
   * 用户没改，跳过覆盖避免清掉真值；credentials 变更只置 requires_restart，不改
   * 运行态连接（WechatClient 持有构造时的 URL/Key，重启才重建）。
   */
  private handleUpdateConfig(params: {
    config?: {
      credentials?: { connector_url?: string; api_key?: string }
      group?: { only_respond_to_mentions?: boolean }
    }
  }): { config: Record<string, unknown>; requires_restart: boolean } {
    const incoming = params.config ?? {}
    let requiresRestart = false

    const creds = incoming.credentials ?? {}
    if (typeof creds.connector_url === 'string' && creds.connector_url) {
      const cleaned = creds.connector_url.replace(/\/puppet-events\/?$/, '').replace(/\/+$/, '')
      if (cleaned !== this.wechatConfig.connector_url) {
        this.wechatConfig.connector_url = cleaned
        requiresRestart = true
      }
    }
    if (typeof creds.api_key === 'string' && creds.api_key && creds.api_key !== '***') {
      this.wechatConfig.api_key = creds.api_key
      requiresRestart = true
    }

    const group = incoming.group ?? {}
    if (typeof group.only_respond_to_mentions === 'boolean') {
      this.wechatConfig.only_respond_to_mentions = group.only_respond_to_mentions
    }

    return { config: this.handleGetConfig().config, requires_restart: requiresRestart }
  }

  /**
   * send_message：Agent 调用此方法发送消息到微信
   */
  private async handleSendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) {
      throw new Error(`Session not found: ${params.session_id}`)
    }

    const wxid = session.platform_session_id
    const text = params.content.text ?? ''

    console.log(`[WechatChannel] Sending message to ${wxid}: ${text.slice(0, 50)}...`)

    if ((params.content.type === 'image' || params.content.type === 'file') && params.content.file_path) {
      // 本地文件：通过 connector 的 send-file 接口上传并发送
      const fileType = params.content.type === 'image' ? 'image' as const : 'file' as const
      await this.client.sendLocalFile(wxid, params.content.file_path, fileType, params.content.filename)
    } else if (params.content.type === 'image' && params.content.media_url) {
      await this.client.sendImage(wxid, params.content.media_url)
    } else if (params.content.type === 'file' && params.content.media_url) {
      await this.client.sendFile(wxid, params.content.media_url, params.content.filename)
    } else {
      await this.sendTextSegmented(wxid, text)
    }

    const messageId = generateId()
    const sentAt = generateTimestamp()

    return { platform_message_id: messageId, sent_at: sentAt }
  }

  /**
   * 长文本主动拆段 + 串行发送，把发送顺序握在 channel-wechat 层。
   *
   * 背景：一次 POST 整段长文本给 wechat-connector 后，下游会自行拆分并异步推到
   * MQTT/Puppet，Puppet 并发处理就会让接收方看到的多条消息乱序。把拆分前置
   * 到这里后串行 await，并在段间留出 INTER_SEGMENT_DELAY_MS 让下游不至于把
   * 相邻两次请求并发处理。
   */
  private async sendTextSegmented(wxid: string, text: string): Promise<void> {
    const segments = splitLongText(text, WechatChannel.MAX_TEXT_SEGMENT_LEN)
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) await sleep(WechatChannel.INTER_SEGMENT_DELAY_MS)
      await this.client.sendText(wxid, segments[i])
    }
  }

  /** 单条文本上限（字符）。超过即在本层拆段。 */
  private static readonly MAX_TEXT_SEGMENT_LEN = 1500

  /** 段间发送间隔（毫秒）。给下游 connector → MQTT → Puppet 留串行处理窗口。 */
  private static readonly INTER_SEGMENT_DELAY_MS = 400

  private handleGetCapabilities(): ChannelCapabilities {
    return {
      supported_message_types: ['text', 'image', 'file'],
      supported_features: [],
      supports_history_query: true,
      supports_platform_user_query: false,
      max_message_length: null,
      max_file_size: null,
      supports_file_path: true,
      supports_list_contacts: true,
      supports_list_groups: true,
      supports_list_group_members: true,
      supports_media_fetch: true,
    }
  }

  private async handleFetchMedia(params: FetchMediaParams): Promise<FetchMediaResult> {
    return this.mediaFetch.fetch(params.handle)
  }

  /**
   * 把"带公开 URL 的文件"改成惰性 handle 形态（图片不动，仍传 media_url 供 agent 注入）。
   * type=file 且有 media_url → 登记 handle、改 status=not_fetched、去掉 media_url。
   */
  private async lazifyFileContent(content: MessageContent, sessionId: string, messageId?: string): Promise<MessageContent> {
    if (content.type !== 'file') return content
    // 超时降级消息（connector 60s 内没拿到 file_url）没有 media_url，但凭 message_id
    // 仍可在 fetch_media 时重查 connector 拿迟到补上的 file_url，故同样登记 handle。
    // 本地文件（file_path）或既无 URL 也无 message_id 的消息无从下载，跳过。
    if (!content.media_url && (content.file_path || !messageId)) return content
    const handle = await this.mediaHandleStore.put({
      kind: 'file',
      ...(content.filename !== undefined ? { filename: content.filename } : {}),
      ...(content.mime_type !== undefined ? { mime_type: content.mime_type } : {}),
      ...(content.size !== undefined ? { size: content.size } : {}),
      session_id: sessionId,
      credential: {
        ...(content.media_url !== undefined ? { url: content.media_url } : {}),
        ...(messageId !== undefined ? { message_id: messageId } : {}),
      },
    })
    const { media_url: _omit, ...rest } = content
    return { ...rest, handle, status: 'not_fetched' }
  }

  /**
   * wechat 媒体下载适配：credential 无 url（入站时 connector 60s 超时降级）→ 先重查
   * connector 消息记录拿迟到补上的 file_url。重查失败 throw，异常 message 经
   * MediaFetchManager 作为 fetch_media 的 error 透给 agent。
   */
  private async downloadFile(rec: MediaHandleRecord): Promise<{ filePath: string; mimeType?: string; size: number } | null> {
    if (rec.credential.url) return this.downloadFromUrl(rec)
    const url = await this.refetchLateFileUrl(rec)
    return this.downloadFromUrl({ ...rec, credential: { ...rec.credential, url } })
  }

  /** 凭 credential.message_id 重查 connector，返回迟到补上的 file_url 并写回 handle 记录。拿不到则 throw。 */
  private async refetchLateFileUrl(rec: MediaHandleRecord): Promise<string> {
    const messageId = rec.credential.message_id as string | undefined
    if (!messageId) throw new Error('媒体记录缺少下载凭证（无 url 也无 message_id），无法下载')
    const msg = await this.client.getMessageById(messageId)
    if (!msg) throw new Error(`重查渠道消息 ${messageId} 失败，暂时拿不到文件下载地址，可稍后重试 fetch_media`)
    const content = msg.content as Record<string, unknown> | undefined
    const fileUrl = typeof content?.file_url === 'string' ? content.file_url : undefined
    if (!fileUrl) {
      throw new Error(
        '文件在微信渠道侧尚未下载完成（入站时下载超时）。可稍等片刻后重试 fetch_media；若多次重试仍失败，说明渠道侧下载失败，请告知用户重新发送该文件'
      )
    }
    const handle = this.mediaHandleStore.findByCredential(rec.credential)
    if (handle) {
      const fileSize = content?.file_size
      await this.mediaHandleStore.update(handle, {
        credential: { ...rec.credential, url: fileUrl },
        ...(rec.size === undefined && typeof fileSize === 'number' ? { size: fileSize } : {}),
      })
    }
    return fileUrl
  }

  /** wechat 媒体下载：HTTP GET 公开 URL（connector 已传图床，无需 token）落盘。 */
  private async downloadFromUrl(rec: MediaHandleRecord): Promise<{ filePath: string; mimeType?: string; size: number } | null> {
    const url = rec.credential.url as string
    try {
      const res = await fetch(url)
      if (!res.ok) {
        console.warn(`[WechatChannel] media download HTTP ${res.status} for ${url}`)
        return null
      }
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = rec.filename ? path.extname(rec.filename) : ''
      const safeExt = ext && /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext : '.bin'
      const name = `${crypto.createHash('sha1').update(url).digest('hex')}${safeExt}`
      const mediaDir = path.join(this.dataDir, 'media')
      await fs.mkdir(mediaDir, { recursive: true })
      const filePath = path.join(mediaDir, name)
      await fs.writeFile(filePath, buf)
      return { filePath, size: buf.length, ...(rec.mime_type ? { mimeType: rec.mime_type } : {}) }
    } catch (err) {
      console.warn(`[WechatChannel] media download failed for ${url}:`, err)
      return null
    }
  }

  private handleGetSessions(params: GetSessionsParams) {
    const sessions = this.sessionManager.listSessions(params.type as SessionType | undefined)
    const page = params.pagination?.page ?? 1
    const pageSize = params.pagination?.page_size ?? 20
    const start = (page - 1) * pageSize
    const items = sessions.slice(start, start + pageSize)

    return {
      items,
      pagination: {
        page,
        page_size: pageSize,
        total_items: sessions.length,
        total_pages: Math.ceil(sessions.length / pageSize),
      },
    }
  }

  private async handleListContacts(params: ListContactsParams): Promise<ListContactsResult> {
    const page = params.pagination?.page ?? 1
    const pageSize = params.pagination?.page_size ?? 50
    const raw = await this.client.listContacts({
      keyword: params.search,
      page,
      pageSize,
    })

    return {
      items: raw.items.map((it): ContactItem => ({
        platform_user_id: it.username,
        display_name: it.nickname,
        ...(it.remark ? { remark: it.remark } : {}),
        ...(it.avatar_url ? { avatar_url: it.avatar_url } : {}),
      })),
      pagination: {
        page: raw.pagination.page,
        page_size: raw.pagination.pageSize,
        total_items: raw.pagination.total,
        total_pages: raw.pagination.totalPages,
      },
    }
  }

  private async handleListGroupMembers(params: ListGroupMembersParams): Promise<ListGroupMembersResult> {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throwError('NOT_FOUND', `Session ${params.session_id} not found`)
    if (session.type !== 'group') throwError('INVALID_ARGUMENT', `Session ${params.session_id} is not a group`)

    const resp = await this.client.getGroupMembers(session.platform_session_id)
    if (!resp) {
      return {
        items: [],
        pagination: { page: 1, page_size: 0, total_items: 0, total_pages: 1 },
        member_count: 0,
        members_complete: false,
        partial_reason: '上游服务暂时取不到群成员，数据可能过期。稍后重试或触发 sync_sessions 后再查。',
      }
    }

    const all: GroupMember[] = resp.members.map((m) => ({
      platform_user_id: m.username,
      display_name: m.chatroom_nick || m.nickname || undefined,
      role: 'member' as const,
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
      member_count: resp.memberCount,
      members_complete: true,
    }
  }

  private async handleListGroups(params: ListGroupsParams): Promise<ListGroupsResult> {
    const page = params.pagination?.page ?? 1
    const pageSize = params.pagination?.page_size ?? 50
    const raw = await this.client.listGroups({
      keyword: params.search,
      page,
      pageSize,
    })

    return {
      items: raw.items.map((it): GroupItem => ({
        platform_session_id: it.chatroomName,
        group_name: it.name,
      })),
      pagination: {
        page: raw.pagination.page,
        page_size: raw.pagination.pageSize,
        total_items: raw.pagination.total,
        total_pages: raw.pagination.totalPages,
      },
    }
  }

  private handleGetSession(params: GetSessionParams) {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throw new Error('Session not found')
    return { session }
  }

  private handleFindOrCreatePrivateSession(params: FindOrCreatePrivateSessionParams) {
    return this.sessionManager.upsert({
      platform_session_id: params.platform_user_id,
      type: 'private',
      title: params.platform_user_id,
      sender_wxid: params.platform_user_id,
      sender_name: params.platform_user_id,
    })
  }

  private async handleGetHistory(params: GetHistoryParams) {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throw new Error('Session not found')

    const talker = session.platform_session_id
    const requestedLimit = params.limit ?? params.pagination?.page_size ?? 20
    // connector 不支持 keyword 过滤，本地过滤会缩减结果集，多取一些以补偿
    const fetchLimit = params.keyword ? requestedLimit * 5 : requestedLimit

    const messages = await this.client.getMessages({
      talker,
      limit: fetchLimit,
      before: params.time_range?.before,
      after: params.time_range?.after,
    })

    let filtered = messages
    if (params.keyword) {
      const kw = params.keyword.toLowerCase()
      filtered = messages.filter((m) => {
        const content = m.content as Record<string, unknown> | undefined
        const text = (content?.text as string) ?? ''
        return text.toLowerCase().includes(kw)
      })
    }

    // connector 不支持 page offset，只能取最近 N 条后截取
    const protocolItems = filtered
      .slice(-requestedLimit)
      .map((m) => connectorMsgToProtocolItem(m, talker))

    return {
      items: protocolItems,
      pagination: {
        page: 1,
        page_size: requestedLimit,
        total_items: protocolItems.length,
        total_pages: 1,
      },
    }
  }

  private async handleGetMessage(params: GetMessageParams) {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throw new Error('Session not found')

    const msg = await this.client.getMessageById(params.platform_message_id)
    if (!msg) throw new Error('Message not found')

    return connectorMsgToProtocolItem(msg, session.platform_session_id)
  }

  // ============================================================================
  // 健康检查
  // ============================================================================

  protected override async getHealthDetails(): Promise<Record<string, unknown>> {
    const connected = this.socket !== null
    return {
      platform: 'wechat',
      platform_connected: connected,
      mode: this.wechatConfig.mode,
      connector_url: this.wechatConfig.connector_url,
      socket_connected: connected,
      active_sessions: this.sessionManager.listSessions().length,
    }
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/** wechat-connector 消息 → Crabot 协议 HistoryMessage 格式 */
function connectorMsgToProtocolItem(m: Record<string, unknown>, talker: string) {
  const content = m.content as Record<string, unknown>
  const fieldType = (m.fieldType as number) ?? (content.type as number) ?? 0
  const isSend = (m.fieldIsSend as number) === 1
  const { content: msgContent, features } = formatWechatContent(fieldType, content)

  return {
    platform_message_id: m.id as string,
    sender: {
      platform_user_id: isSend ? '_self' : (content.group_sender as string ?? talker),
      platform_display_name: isSend ? 'bot' : (content.group_sender as string ?? talker),
    },
    content: msgContent,
    features: {
      is_mention_crab: false,
      ...features,
    },
    platform_timestamp: connectorTimeToISO(m.fieldCreateTime as string),
  }
}

/** wechat-connector 秒/毫秒时间戳字符串 → ISO 8601 */
function connectorTimeToISO(ts: string): string {
  const value = Number(ts)
  if (!Number.isFinite(value)) return new Date().toISOString()
  const ms = value < 1e12 ? value * 1000 : value
  return new Date(ms).toISOString()
}

function throwError(code: string, message: string): never {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  throw err
}
