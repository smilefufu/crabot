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
import { ModuleBase, type ModuleConfig } from './core/module-base.js'
import { generateId, generateTimestamp, type Event } from './core/base-protocol.js'
import { WechatClient } from './wechat-client.js'
import { SessionManager } from './session-manager.js'
import { MessageStore } from './message-store.js'
import type {
  WechatRawEvent,
  WebhookEnvelope,
  WechatChannelConfig,
  ChannelMessage,
  ChannelCapabilities,
  SendMessageParams,
  SendMessageResult,
  GetSessionsParams,
  GetSessionParams,
  FindOrCreatePrivateSessionParams,
  GetHistoryParams,
  SessionType,
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
  private readonly messageStore: MessageStore
  private readonly wechatConfig: WechatChannelConfig
  private readonly dataDir: string

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
    this.messageStore = new MessageStore(config.data_dir)

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

    // 启动消息接收
    if (this.wechatConfig.mode === 'socketio') {
      await this.startSocketIO()
    } else if (this.wechatConfig.mode === 'webhook') {
      await this.startWebhookServer()
    }
  }

  protected override async onStop(): Promise<void> {
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

    // 创建/更新 Session
    const { session } = this.sessionManager.upsert({
      platform_session_id: platformSessionId,
      type: isGroup ? 'group' : 'private',
      title: event.conversation.name,
      sender_wxid: event.sender.wxid,
      sender_name: event.sender.name,
    })

    // 转换消息类型（MessageType 枚举：0=TEXT, 1=IMAGE, 18=QUOTE, ...）
    const msgType = event.message.type
    const msgContent = event.message.content as { text?: string; at_string?: string; resource_url?: string }
    const hasText = msgType === 0 || msgType === 18 || msgType === 20  // TEXT, QUOTE, APP_MSG

    const contentType = msgType === 1 ? 'image' as const : 'text' as const
    const textContent = hasText
      ? msgContent.text ?? JSON.stringify(event.message.content)
      : `[${messageTypeName(msgType)}]`

    // 检测 @Crabot
    const atString = msgContent.at_string ?? ''
    const isMentionCrab = isGroup && atString.split(',').some(wxid => wxid.trim() === event.puppet.wxid)

    // 获取 Crabot 群昵称（仅群聊）
    const crabDisplayName = isGroup
      ? await this.getCrabGroupNick(platformSessionId, event.puppet.wxid)
      : undefined

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
      content: {
        type: contentType,
        text: textContent,
      },
      features: {
        is_mention_crab: isMentionCrab,
      },
      platform_timestamp: generateTimestamp(),
    }

    // 记录入站消息
    this.messageStore.appendInbound({
      sessionId: session.id,
      platformMessageId: event.message.id,
      senderName: event.sender.name,
      senderPlatformUserId: event.sender.wxid,
      text: textContent,
      contentType,
      timestamp: channelMessage.platform_timestamp,
    })

    // 发布 channel.message_received 事件
    const crabotEvent: Event = {
      id: generateId(),
      type: 'channel.message_received',
      source: this.config.moduleId,
      payload: {
        channel_id: this.config.moduleId,
        message: channelMessage,
        ...(crabDisplayName !== undefined ? { crab_display_name: crabDisplayName } : {}),
      },
      timestamp: generateTimestamp(),
    }

    await this.rpcClient.publishEvent(crabotEvent, this.config.moduleId)
    console.log(`[WechatChannel] Published channel.message_received, session=${session.id}`)
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
    this.registerMethod('get_session', this.handleGetSession.bind(this))
    this.registerMethod('find_or_create_private_session', this.handleFindOrCreatePrivateSession.bind(this))
    this.registerMethod('get_history', this.handleGetHistory.bind(this))
  }

  // ============================================================================
  // Channel 协议方法实现
  // ============================================================================

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

    if (params.content.type === 'image' && params.content.media_url) {
      await this.client.sendImage(wxid, params.content.media_url)
    } else if (params.content.type === 'file' && params.content.media_url) {
      await this.client.sendFile(wxid, params.content.media_url)
    } else {
      await this.client.sendText(wxid, text)
    }

    const messageId = generateId()
    const sentAt = generateTimestamp()

    // 记录出站消息
    this.messageStore.appendOutbound({
      sessionId: params.session_id,
      platformMessageId: messageId,
      text: text || '[非文本消息]',
      contentType: params.content.type,
      timestamp: sentAt,
    })

    return { platform_message_id: messageId, sent_at: sentAt }
  }

  private handleGetCapabilities(): ChannelCapabilities {
    return {
      supported_message_types: ['text', 'image', 'file'],
      supported_features: [],
      supports_history_query: true,
      supports_platform_user_query: false,
      max_message_length: null,
      max_file_size: null,
      supports_file_path: false,
      allowed_file_paths: [],
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

  private handleGetHistory(params: GetHistoryParams) {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throw new Error('Session not found')

    const page = params.pagination?.page ?? 1
    const pageSize = params.pagination?.page_size ?? 20

    const { items, total } = this.messageStore.query({
      sessionId: params.session_id,
      keyword: params.keyword,
      limit: params.limit,
      page: params.limit ? undefined : page,
      pageSize: params.limit ? undefined : pageSize,
    })

    // 将内部 HistoryMessage 转换为 protocol-channel.md §3.3 协议格式
    const protocolItems = items.map((m) => ({
      platform_message_id: m.platform_message_id,
      sender: {
        platform_user_id: m.sender_platform_user_id ?? m.sender_name,
        platform_display_name: m.sender_name,
      },
      content: {
        type: m.content_type ?? 'text',
        text: m.content,
      },
      features: {
        is_mention_crab: false,
      },
      platform_timestamp: m.timestamp,
    }))

    return {
      items: protocolItems,
      pagination: {
        page,
        page_size: params.limit ?? pageSize,
        total_items: total,
        total_pages: Math.ceil(total / (params.limit ?? pageSize)),
      },
    }
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

// 对齐 wechat-connector 的 MessageType 枚举（content.type，非微信原始 field_type）
function messageTypeName(type: number): string {
  const names: Record<number, string> = {
    0: '文本',
    1: '图片',
    2: '语音',
    3: '名片',
    4: '转账',
    5: '红包',
    6: '系统通知',
    9: '文件',
    10: '视频',
    11: '链接',
    15: '小程序',
    17: '拍一拍',
    18: '引用',
    20: '应用消息',
    34: '语音',
    43: '视频',
    47: '表情',
    10000: '系统消息',
    10002: '撤回',
  }
  return names[type] ?? `未知类型(${type})`
}
