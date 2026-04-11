/**
 * TelegramChannel - Crabot Channel 模块主类
 *
 * 通过 Telegram Bot API 接入 Telegram：
 * - 收消息：Long Polling (getUpdates) 或 Webhook
 * - 发消息：sendMessage / sendPhoto / sendDocument
 *
 * 对齐：protocol-channel.md 所有端点
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ModuleBase, type ModuleConfig, generateId, generateTimestamp, type Event } from 'crabot-shared'
import { TelegramClient, TelegramApiError } from './telegram-client.js'
import { SessionManager } from './session-manager.js'
import { MessageStore } from './message-store.js'
import type {
  TgUpdate,
  TgMessage,
  TgUser,
  ChannelMessage,
  ChannelCapabilities,
  MessageContent,
  StoredMessage,
  SendMessageParams,
  SendMessageResult,
  GetSessionsParams,
  GetSessionParams,
  FindOrCreatePrivateSessionParams,
  GetHistoryParams,
  GetMessageParams,
  SessionType,
  TelegramChannelConfig,
  TelegramCacheConfig,
} from './types.js'

const MAX_MESSAGE_LENGTH = 4096
const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50 MB

// ============================================================================
// 配置
// ============================================================================

export interface TelegramChannelInitConfig {
  module_id: string
  module_type: 'channel'
  version: string
  protocol_version: string
  port: number
  data_dir: string
  telegram: TelegramChannelConfig
  cache?: Partial<TelegramCacheConfig>
}

// ============================================================================
// TelegramChannel
// ============================================================================

export class TelegramChannel extends ModuleBase {
  private readonly client: TelegramClient
  private readonly sessionManager: SessionManager
  private readonly messageStore: MessageStore
  private readonly telegramConfig: TelegramChannelConfig
  private readonly dataDir: string

  private botUser: TgUser | null = null
  /** Cached lowercase @username for mention detection */
  private botMentionLower: string | null = null

  private pollingActive = false
  private pollingOffset: number | undefined = undefined

  constructor(config: TelegramChannelInitConfig) {
    const moduleConfig: ModuleConfig = {
      moduleId: config.module_id,
      moduleType: config.module_type,
      version: config.version,
      protocolVersion: config.protocol_version,
      port: config.port,
      subscriptions: [],
    }

    super(moduleConfig)

    this.telegramConfig = config.telegram
    this.dataDir = config.data_dir
    this.client = new TelegramClient(config.telegram.bot_token)
    this.sessionManager = new SessionManager(config.module_id, config.data_dir)
    this.messageStore = new MessageStore(config.data_dir, config.cache)

    this.registerMethods()
  }

  // ============================================================================
  // 生命周期
  // ============================================================================

  protected override async onStart(): Promise<void> {
    this.botUser = await this.client.getMe()
    this.botMentionLower = this.botUser.username
      ? `@${this.botUser.username}`.toLowerCase()
      : null

    console.log(
      `[TelegramChannel] Bot: @${this.botUser.username} (${this.botUser.first_name}, id=${this.botUser.id})`
    )

    await fs.mkdir(path.join(this.dataDir, 'media'), { recursive: true })

    this.messageStore.startCleanup()

    if (this.telegramConfig.mode === 'polling') {
      await this.startPolling()
    } else if (this.telegramConfig.mode === 'webhook') {
      await this.setupWebhook()
    }
  }

  protected override async onStop(): Promise<void> {
    this.pollingActive = false
    this.messageStore.stopCleanup()

    if (this.telegramConfig.mode === 'webhook') {
      try {
        await this.client.deleteWebhook()
      } catch (error) {
        console.warn('[TelegramChannel] Failed to delete webhook on shutdown:', error)
      }
    }
  }

  // ============================================================================
  // Long Polling
  // ============================================================================

  private async startPolling(): Promise<void> {
    await this.client.deleteWebhook()

    this.pollingActive = true
    console.log('[TelegramChannel] Starting long polling...')

    this.pollLoop().catch((error) => {
      console.error('[TelegramChannel] Poll loop crashed:', error)
    })
  }

  private async pollLoop(): Promise<void> {
    let backoffMs = 1000

    while (this.pollingActive) {
      try {
        const updates = await this.client.getUpdates(this.pollingOffset, 30)

        backoffMs = 1000

        for (const update of updates) {
          this.pollingOffset = update.update_id + 1
          this.handleUpdate(update).catch((error) => {
            console.error('[TelegramChannel] Error handling update:', error)
          })
        }
      } catch (error) {
        if (!this.pollingActive) break

        if (error instanceof TelegramApiError && error.errorCode === 409) {
          console.warn('[TelegramChannel] Polling conflict (409): another instance is polling')
        } else {
          console.error('[TelegramChannel] Polling error:', error)
        }

        await new Promise((resolve) => setTimeout(resolve, backoffMs))
        backoffMs = Math.min(backoffMs * 2, 30_000)
      }
    }
  }

  // ============================================================================
  // Webhook
  // ============================================================================

  private async setupWebhook(): Promise<void> {
    const { webhook_url, webhook_secret } = this.telegramConfig
    if (!webhook_url) {
      throw new Error('TELEGRAM_WEBHOOK_URL is required for webhook mode')
    }

    await this.client.setWebhook(webhook_url, webhook_secret)
    console.log(`[TelegramChannel] Webhook set to: ${webhook_url}`)
  }

  protected override async onRawRequest(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    body: string
  ): Promise<boolean> {
    if (method !== 'telegram/webhook') return false

    if (this.telegramConfig.webhook_secret) {
      const headerSecret = req.headers['x-telegram-bot-api-secret-token']
      if (headerSecret !== this.telegramConfig.webhook_secret) {
        res.writeHead(401)
        res.end('Invalid secret token')
        return true
      }
    }

    try {
      const update = JSON.parse(body) as TgUpdate
      res.writeHead(200)
      res.end('OK')

      this.handleUpdate(update).catch((error) => {
        console.error('[TelegramChannel] Error handling webhook update:', error)
      })
    } catch {
      res.writeHead(400)
      res.end('Bad Request')
    }

    return true
  }

  // ============================================================================
  // Update 处理（polling 和 webhook 共用）
  // ============================================================================

  private async handleUpdate(update: TgUpdate): Promise<void> {
    const message = update.message ?? update.edited_message
    if (!message) return
    if (!message.from) return

    const chatId = String(message.chat.id)
    const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup'
    const senderId = String(message.from.id)
    const senderName = message.from.first_name +
      (message.from.last_name ? ` ${message.from.last_name}` : '')

    const chatTitle = isGroup
      ? (message.chat.title ?? `Group ${chatId}`)
      : senderName

    console.log(
      `[TelegramChannel] Message: sender=${senderName} (${senderId}), ` +
      `chat=${chatTitle}, type=${isGroup ? 'group' : 'private'}`
    )

    const { session } = this.sessionManager.upsert({
      platform_session_id: chatId,
      type: isGroup ? 'group' : 'private',
      title: chatTitle,
      sender_user_id: senderId,
      sender_name: senderName,
    })

    const content = await this.convertMessageContent(message)
    const isMentionCrab = this.detectBotMention(message)

    const channelMessage: ChannelMessage = {
      platform_message_id: String(message.message_id),
      session: {
        session_id: session.id,
        channel_id: this.config.moduleId,
        type: session.type,
      },
      sender: {
        platform_user_id: senderId,
        platform_display_name: senderName,
      },
      content,
      features: {
        is_mention_crab: isMentionCrab,
      },
      platform_timestamp: new Date(message.date * 1000).toISOString(),
    }

    this.messageStore.appendInbound({
      sessionId: session.id,
      platformMessageId: String(message.message_id),
      senderPlatformUserId: senderId,
      senderName,
      text: content.text ?? '',
      contentType: content.type,
      mediaUrl: content.media_url,
      mimeType: content.mime_type,
      filename: content.filename,
      timestamp: channelMessage.platform_timestamp,
    })

    const event: Event = {
      id: generateId(),
      type: 'channel.message_received',
      source: this.config.moduleId,
      payload: { channel_id: this.config.moduleId, message: channelMessage },
      timestamp: generateTimestamp(),
    }

    await this.rpcClient.publishEvent(event, this.config.moduleId)
    console.log(`[TelegramChannel] Published channel.message_received, session=${session.id}`)
  }

  // ============================================================================
  // 消息内容转换
  // ============================================================================

  private async convertMessageContent(msg: TgMessage): Promise<MessageContent> {
    const mediaDir = path.join(this.dataDir, 'media')

    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1]
      try {
        const { localPath } = await this.client.downloadFileToLocal(
          largest.file_id,
          mediaDir
        )
        return {
          type: 'image',
          text: msg.caption ?? undefined,
          media_url: localPath,
          mime_type: 'image/jpeg',
        }
      } catch (error) {
        console.error('[TelegramChannel] Failed to download photo:', error)
        return { type: 'text', text: msg.caption ?? '[图片下载失败]' }
      }
    }

    if (msg.document) {
      try {
        const { localPath } = await this.client.downloadFileToLocal(
          msg.document.file_id,
          mediaDir
        )
        return {
          type: 'file',
          text: msg.caption ?? undefined,
          media_url: localPath,
          filename: msg.document.file_name,
          mime_type: msg.document.mime_type,
          size: msg.document.file_size,
        }
      } catch (error) {
        console.error('[TelegramChannel] Failed to download document:', error)
        return { type: 'text', text: msg.caption ?? '[文件下载失败]' }
      }
    }

    if (msg.voice) return { type: 'text', text: '[语音消息]' }
    if (msg.video) return { type: 'text', text: msg.caption ?? '[视频消息]' }
    if (msg.sticker) return { type: 'text', text: msg.sticker.emoji ?? '[贴纸]' }
    if (msg.audio) return { type: 'text', text: msg.caption ?? '[音频消息]' }
    if (msg.location) {
      return {
        type: 'text',
        text: `[位置: ${msg.location.latitude}, ${msg.location.longitude}]`,
      }
    }

    return { type: 'text', text: msg.text ?? '' }
  }

  private detectBotMention(msg: TgMessage): boolean {
    if (!this.botUser) return false

    const entities = msg.entities ?? msg.caption_entities ?? []
    const text = msg.text ?? msg.caption ?? ''

    for (const entity of entities) {
      // @username 形式的 mention
      if (entity.type === 'mention' && this.botMentionLower) {
        const mentionText = text.slice(entity.offset, entity.offset + entity.length)
        if (mentionText.toLowerCase() === this.botMentionLower) {
          return true
        }
      }
      // 通过菜单选择的 text_mention（entity 带 user 对象，按 bot id 匹配）
      if (entity.type === 'text_mention' && entity.user?.id === this.botUser.id) {
        return true
      }
    }

    return false
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
    this.registerMethod('get_message', this.handleGetMessage.bind(this))
    this.registerMethod('get_platform_user_info', this.handleGetPlatformUserInfo.bind(this))
  }

  // ============================================================================
  // Channel 协议方法实现
  // ============================================================================

  private async handleSendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) {
      throw new Error(`Session not found: ${params.session_id}`)
    }

    const chatId = session.platform_session_id
    const text = params.content.text ?? ''
    const replyTo = params.features?.reply_to_message_id
      ? parseInt(params.features.reply_to_message_id, 10)
      : undefined
    const sendOpts = replyTo ? { reply_to_message_id: replyTo } : undefined

    console.log(`[TelegramChannel] Sending message to chat ${chatId}: ${text.slice(0, 50)}...`)

    const sentMsg = await this.sendByContentType(params, chatId, text, sendOpts)

    const messageId = String(sentMsg.message_id)
    const sentAt = generateTimestamp()

    this.messageStore.appendOutbound({
      sessionId: params.session_id,
      platformMessageId: messageId,
      text: text || '[非文本消息]',
      contentType: params.content.type,
      timestamp: sentAt,
    })

    return { platform_message_id: messageId, sent_at: sentAt }
  }

  /**
   * 按 content.type 选择发送方式。image/file 走 sendMedia，text 走 sendMessage。
   */
  private async sendByContentType(
    params: SendMessageParams,
    chatId: string,
    text: string,
    sendOpts?: { reply_to_message_id: number }
  ): Promise<{ message_id: number }> {
    const { type, file_path, media_url, filename } = params.content
    const source = file_path ?? media_url

    if ((type === 'image' || type === 'file') && source) {
      const sendFn = type === 'image'
        ? this.client.sendPhoto.bind(this.client)
        : this.client.sendDocument.bind(this.client)

      let media: string | Buffer = source
      try {
        media = await fs.readFile(source)
      } catch {
        // Not a local file — pass as URL string
      }

      return sendFn(chatId, media, {
        ...sendOpts,
        caption: text || undefined,
        ...(type === 'file' && filename ? { filename } : {}),
      })
    }

    return this.client.sendMessage(chatId, text, sendOpts)
  }

  private handleGetCapabilities(): ChannelCapabilities {
    return {
      supported_message_types: ['text', 'image', 'file'],
      supported_features: [],
      supports_history_query: true,
      supports_platform_user_query: true,
      max_message_length: MAX_MESSAGE_LENGTH,
      max_file_size: MAX_FILE_SIZE,
      supports_file_path: true,
      allowed_file_paths: [path.join(this.dataDir, 'media')],
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
      sender_user_id: params.platform_user_id,
      sender_name: params.platform_user_id,
    })
  }

  private handleGetHistory(params: GetHistoryParams) {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throw new Error('Session not found')

    const pageSize = params.limit ?? params.pagination?.page_size ?? 20
    const page = params.limit ? undefined : (params.pagination?.page ?? 1)

    const { items, total } = this.messageStore.query({
      sessionId: params.session_id,
      keyword: params.keyword,
      timeRange: params.time_range,
      page: page,
      pageSize: pageSize,
    })

    return {
      items: items.map(storedMessageToProtocol),
      pagination: {
        page: page ?? 1,
        page_size: pageSize,
        total_items: total,
        total_pages: Math.ceil(total / pageSize),
      },
    }
  }

  private handleGetMessage(params: GetMessageParams) {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throw new Error('Session not found')

    const msg = this.messageStore.findByMessageId(params.session_id, params.platform_message_id)
    if (!msg) throw new Error('Message not found')

    return storedMessageToProtocol(msg)
  }

  private async handleGetPlatformUserInfo(params: { platform_user_id: string }) {
    const userId = parseInt(params.platform_user_id, 10)
    if (isNaN(userId)) {
      throw new Error(`Invalid platform_user_id: ${params.platform_user_id}`)
    }

    const chat = await this.client.getChat(userId)
    return {
      platform_user_id: params.platform_user_id,
      display_name: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || params.platform_user_id,
      avatar_url: undefined,
      extra: {
        username: chat.username,
        chat_type: chat.type,
      },
    }
  }

  // ============================================================================
  // 健康检查
  // ============================================================================

  protected override async getHealthDetails(): Promise<Record<string, unknown>> {
    return {
      platform: 'telegram',
      platform_connected: this.botUser !== null,
      mode: this.telegramConfig.mode,
      bot_username: this.botUser?.username ?? null,
      active_sessions: this.sessionManager.listSessions().length,
      polling_active: this.pollingActive,
    }
  }
}

// ============================================================================
// 工具函数
// ============================================================================

function storedMessageToProtocol(m: StoredMessage) {
  return {
    platform_message_id: m.platform_message_id,
    sender: {
      platform_user_id: m.sender_platform_user_id,
      platform_display_name: m.sender_name,
    },
    content: {
      type: m.content_type,
      text: m.text,
      media_url: m.media_url,
      mime_type: m.mime_type,
      filename: m.filename,
    },
    features: {
      is_mention_crab: false,
    },
    platform_timestamp: m.timestamp,
  }
}
