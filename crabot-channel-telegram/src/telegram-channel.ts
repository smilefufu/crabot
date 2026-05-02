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
import {
  ModuleBase,
  type ModuleConfig,
  generateId,
  generateTimestamp,
  type Event,
  decideMarkdownEnabled,
  markdownToTelegramHtml,
  MARKDOWN_FORMAT_VALUES,
  type MarkdownFormat,
  type TelegramParseMode,
} from 'crabot-shared'
import { TelegramClient, TelegramApiError } from './telegram-client.js'
import { SessionManager } from './session-manager.js'
import { MessageStore } from './message-store.js'
import { splitText } from './text-splitter.js'
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
const MAX_CAPTION_LENGTH = 1024
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

    // 跳过服务消息（入群、退群等），它们没有用户内容
    if (message.new_chat_members || message.left_chat_member) return

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

    await this.messageStore.appendInbound({
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
    this.registerMethod('get_config', this.handleGetConfig.bind(this))
    this.registerMethod('update_config', this.handleUpdateConfig.bind(this))
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

    console.log(
      `[TelegramChannel] Sending message to chat ${chatId} (${text.length} chars): ${text.slice(0, 50)}...`
    )

    const sentIds = await this.dispatchSend(params, chatId, text, replyTo)
    const firstId = String(sentIds[0])
    const sentAt = generateTimestamp()

    await this.messageStore.appendOutbound({
      sessionId: params.session_id,
      platformMessageId: firstId,
      text: text || '[非文本消息]',
      contentType: params.content.type,
      timestamp: sentAt,
    })

    return { platform_message_id: firstId, sent_at: sentAt }
  }

  /**
   * 按 content.type 选择发送方式，超长文本/caption 自动按 Telegram 限制切分多条。
   * 第一条消息绑定 reply_to_message_id，后续接力发送不带 reply_to。
   * 返回所有发出的 message_id（顺序）。
   */
  private async dispatchSend(
    params: SendMessageParams,
    chatId: string,
    text: string,
    replyTo: number | undefined
  ): Promise<number[]> {
    const { type, file_path, media_url, filename } = params.content
    const source = file_path ?? media_url
    const hasMedia = (type === 'image' || type === 'file') && !!source

    if (hasMedia) {
      const media = await loadMediaSource(source!)
      const sendFn = type === 'image'
        ? this.client.sendPhoto.bind(this.client)
        : this.client.sendDocument.bind(this.client)

      // 切分以 caption 上限为准：第一段塞 caption，后续段独立发 text。
      // 每段 <= MAX_CAPTION_LENGTH < MAX_MESSAGE_LENGTH，单条 sendMessage 安全。
      const chunks = splitText(text, MAX_CAPTION_LENGTH)
      const captionRender = chunks.length > 0 ? this.renderTextForTelegram(chunks[0]) : null

      const firstMsg = await sendFn(chatId, media, {
        ...(replyTo ? { reply_to_message_id: replyTo } : {}),
        ...(captionRender ? { caption: captionRender.text, parse_mode: captionRender.parseMode } : {}),
        ...(type === 'file' && filename ? { filename } : {}),
      })
      const ids = [firstMsg.message_id]

      for (let i = 1; i < chunks.length; i++) {
        const render = this.renderTextForTelegram(chunks[i])
        const sent = await this.client.sendMessage(chatId, render.text, { parse_mode: render.parseMode })
        ids.push(sent.message_id)
      }
      return ids
    }

    return this.sendTextChunks(chatId, text, replyTo)
  }

  /**
   * 切分以原始 markdown 文本为准，每段独立渲染：标签膨胀超限时整段降级纯文本。
   * 跨段的 markdown 标记（如 chunk N-1 开 ** 在 chunk N 闭）会丢格式，但不会发出非法 HTML。
   */
  private async sendTextChunks(
    chatId: string,
    text: string,
    replyTo: number | undefined
  ): Promise<number[]> {
    const chunks = splitText(text, MAX_MESSAGE_LENGTH)
    const sources = chunks.length === 0 ? [text] : chunks

    const ids: number[] = []
    for (let i = 0; i < sources.length; i++) {
      const render = this.renderTextForTelegram(sources[i])
      const sent = await this.client.sendMessage(chatId, render.text, {
        ...(i === 0 && replyTo ? { reply_to_message_id: replyTo } : {}),
        parse_mode: render.parseMode,
      })
      ids.push(sent.message_id)
    }
    return ids
  }

  /** 渲染结果若超过 Telegram 长度上限会整段降级为纯文本。 */
  private renderTextForTelegram(chunk: string): { text: string; parseMode?: TelegramParseMode } {
    if (!decideMarkdownEnabled(this.telegramConfig.markdown_format, chunk)) {
      return { text: chunk }
    }
    const html = markdownToTelegramHtml(chunk)
    if (html.length > MAX_MESSAGE_LENGTH) return { text: chunk }
    return { text: html, parseMode: 'HTML' }
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

  private async handleGetHistory(params: GetHistoryParams) {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throw new Error('Session not found')

    const pageSize = params.limit ?? params.pagination?.page_size ?? 20
    const page = params.limit ? undefined : (params.pagination?.page ?? 1)

    const { items, total } = await this.messageStore.query({
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

  private async handleGetMessage(params: GetMessageParams) {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throw new Error('Session not found')

    const msg = await this.messageStore.findByMessageId(params.session_id, params.platform_message_id)
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
  // 配置管理（protocol-channel §6.1）
  // ============================================================================

  private handleGetConfig() {
    const cfg: Record<string, unknown> = {
      platform: 'telegram',
      credentials: {
        bot_token: '***',
        ...(this.telegramConfig.webhook_secret ? { webhook_secret: '***' } : {}),
      },
      mode: this.telegramConfig.mode,
      ...(this.telegramConfig.webhook_url ? { webhook_url: this.telegramConfig.webhook_url } : {}),
      markdown_format: this.telegramConfig.markdown_format,
      crab_platform_user_id: this.botUser ? String(this.botUser.id) : '',
    }
    return {
      config: cfg,
      schema: {
        'credentials.bot_token': { sensitive: true, hot_reload: false, description: 'Bot Token，变更需重启' },
        'credentials.webhook_secret': { sensitive: true, hot_reload: false, description: 'Webhook 签名密钥，变更需重启' },
        'mode': { hot_reload: false, description: '消息接收模式 polling / webhook，变更需重启' },
        'webhook_url': { hot_reload: false, description: 'Webhook 模式回调地址，变更需重启' },
        'markdown_format': { hot_reload: true, description: 'Markdown 渲染开关：auto / on / off' },
      },
    }
  }

  private handleUpdateConfig(params: {
    config?: {
      credentials?: { bot_token?: string; webhook_secret?: string }
      mode?: 'polling' | 'webhook'
      webhook_url?: string
      markdown_format?: MarkdownFormat
    }
  }): { config: Record<string, unknown>; requires_restart: boolean } {
    const incoming = params.config ?? {}
    let requiresRestart = false

    const creds = incoming.credentials ?? {}
    // 空串与 *** 占位符一律跳过（admin 端 mask 回显或留空都是"未改动"信号；
    // 真要清掉敏感字段请走"停模块 + 改 env"，避免一次保存意外擦掉凭证）
    if (typeof creds.bot_token === 'string' && creds.bot_token && creds.bot_token !== '***') {
      this.telegramConfig.bot_token = creds.bot_token
      requiresRestart = true
    }
    if (typeof creds.webhook_secret === 'string' && creds.webhook_secret && creds.webhook_secret !== '***') {
      this.telegramConfig.webhook_secret = creds.webhook_secret
      requiresRestart = true
    }
    if (incoming.mode && incoming.mode !== this.telegramConfig.mode) {
      this.telegramConfig.mode = incoming.mode
      requiresRestart = true
    }
    if (typeof incoming.webhook_url === 'string' && incoming.webhook_url !== this.telegramConfig.webhook_url) {
      this.telegramConfig.webhook_url = incoming.webhook_url || undefined
      requiresRestart = true
    }
    if (incoming.markdown_format && MARKDOWN_FORMAT_VALUES.includes(incoming.markdown_format)) {
      this.telegramConfig.markdown_format = incoming.markdown_format
    }

    const masked = this.handleGetConfig().config
    return { config: masked, requires_restart: requiresRestart }
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

async function loadMediaSource(source: string): Promise<string | Buffer> {
  try {
    return await fs.readFile(source)
  } catch {
    return source
  }
}

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
