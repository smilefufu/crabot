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
  type FetchMediaResult,
} from 'crabot-shared'

import { FeishuClient, FeishuClientError, type SendReceive } from './feishu-client.js'
import { FeishuDocReader } from './feishu-doc-reader.js'
import { parseFeishuDocUrl, extractFeishuDocUrls } from './feishu-url.js'
import { WsSubscriber } from './ws-subscriber.js'
import { SessionManager } from './session-manager.js'
import { MessageStore, type StoredMessage } from './message-store.js'
import { splitTextByTableLimit } from './card-table-guard.js'
import { buildFeishuRemediation, writeScopeForPath } from './feishu-remediation.js'
import {
  detectMentionCrab,
  injectMentionTags,
  replaceMentionsInline,
  mapMessageContent,
} from './event-mapper.js'
import type {
  BackfillHistoryParams,
  BackfillHistoryResult,
  ChannelMessage,
  ChannelCapabilities,
  FeishuChannelConfig,
  FeishuChatType,
  FeishuDomain,
  FeishuMention,
  FindOrCreatePrivateSessionParams,
  GetHistoryParams,
  GetMessageParams,
  GetSessionParams,
  GetSessionsParams,
  HistoryMessage,
  MarkdownFormat,
  MessageContent,
  MessageFeatures,
  PlatformUserInfoResult,
  Session,
  SessionType,
  SendMessageParams,
  SendMessageResult,
  SyncSessionsParams,
  SyncSessionsResult,
  DeleteSessionResult,
  ListContactsParams,
  ListContactsResult,
  ListGroupsParams,
  ListGroupsResult,
  ListGroupMembersParams,
  ListGroupMembersResult,
  GroupMember,
  ContactItem,
  GroupItem,
  MentionTarget,
  FetchMediaParams,
} from './types.js'

/**
 * 飞书 Channel 模块需要订阅的事件清单 — single source of truth。
 *
 * EventDispatcher 注册和 onboarder finish() 引导都源于此常量。
 *
 * 命名约定：identifier 的 `_v1` 后缀是事件标识符本身的一部分，飞书后台 UI 显示的
 * "v2.0" 标签是 schema 版本，两者独立。这些 identifier 就是当前飞书 v2.0 schema
 * 下使用的字符串，不需要也不应该改为 `_v2`。
 */
export const SUBSCRIBED_EVENTS = [
  { name: '接收消息',     identifier: 'im.message.receive_v1' },
  { name: '机器人进群',   identifier: 'im.chat.member.bot.added_v1' },
  { name: '机器人出群',   identifier: 'im.chat.member.bot.deleted_v1' },
  { name: '用户进群',     identifier: 'im.chat.member.user.added_v1' },
  { name: '用户出群',     identifier: 'im.chat.member.user.deleted_v1' },
  { name: '群信息修改',   identifier: 'im.chat.updated_v1' },
] as const

export type SubscribedEventIdentifier = typeof SUBSCRIBED_EVENTS[number]['identifier']

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

const READ_SCOPE_BY_KIND: Record<string, string> = {
  docx: 'docx:document:readonly',
  wiki: 'wiki:wiki:readonly',
  sheets: 'sheets:spreadsheet:readonly',
  file: 'drive:drive:readonly',
}

export class FeishuChannel extends ModuleBase {
  private readonly feishuConfig: FeishuChannelConfig
  private readonly dataDir: string
  private readonly client: FeishuClient
  private readonly subscriber: WsSubscriber
  private readonly sessionManager: SessionManager
  private readonly messageStore: MessageStore
  private readonly mediaHandleStore: MediaHandleStore
  private readonly mediaCleaner: MediaCleaner
  private readonly docReader: FeishuDocReader
  private mediaFetch!: MediaFetchManager

  private botOpenId: string | null = null
  private botName: string | null = null

  /** open_id → 飞书用户昵称缓存。事件 payload 不含 sender 名，需要调 contact API */
  private readonly displayNameCache: Map<string, { name: string; fetchedAt: number }> = new Map()
  private static readonly DISPLAY_NAME_TTL_MS = 24 * 60 * 60 * 1000 // 24h
  // 负缓存：getUser 失败 / 用户无名时短期内不再重试，避免每条消息都走 contact API
  private static readonly DISPLAY_NAME_NEG_TTL_MS = 5 * 60 * 1000
  private static readonly DISPLAY_NAME_CACHE_MAX = 2000

  private readonly docTitleCache: Map<string, { title: string; fetchedAt: number }> = new Map()
  private static readonly DOC_TITLE_TTL_MS = 60 * 60 * 1000 // 1h
  private static readonly DOC_TITLE_CACHE_MAX = 500

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
    this.mediaHandleStore = new MediaHandleStore(config.data_dir)
    this.mediaCleaner = new MediaCleaner(config.data_dir, 7)
    this.mediaFetch = new MediaFetchManager({
      store: this.mediaHandleStore,
      channelId: this.config.moduleId,
      download: (rec) => rec.credential.file_token
        ? this.downloadDriveFileToDisk(rec.credential.file_token as string, rec.filename)
        : this.downloadAndPersistMedia(
            rec.credential.platform_message_id as string,
            rec.credential.file_key as string,
            rec.kind,
            rec.filename,
          ),
      publishEvent: (event) => this.rpcClient.publishEvent(event, this.config.moduleId).then(() => undefined),
    })
    this.docReader = new FeishuDocReader(this.client)

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

    await this.mediaHandleStore.init()
    this.messageStore.startCleanup()
    this.mediaCleaner.startCleanup()

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => this.safeHandle('message.receive', () => this.handleMessageReceive(data)),
      'im.chat.member.bot.added_v1': (data) => this.safeHandle('bot.added', () => this.handleBotAdded(data)),
      'im.chat.member.bot.deleted_v1': (data) => this.safeHandle('bot.deleted', () => this.handleBotDeleted(data)),
      'im.chat.member.user.added_v1': (data) => this.safeHandle('user.added', () => this.handleUsersAdded(data)),
      'im.chat.member.user.deleted_v1': (data) => this.safeHandle('user.deleted', () => this.handleUsersDeleted(data)),
      'im.chat.updated_v1': (data) => this.safeHandle('chat.updated', () => this.handleChatUpdated(data)),
    })

    await this.subscriber.start(dispatcher)
    this.bootstrapGroupSessions()
      .then(() => this.repairBrokenGroupTitles())
      .catch((err) => {
        console.warn('[FeishuChannel] bootstrap aborted:', err)
      })
  }

  /**
   * 扫描已有 group sessions，title 等于 chat_id 占位的，逐个调 getChat 补群名。
   * 兜底场景：bootstrap 错过 / handleBotAdded 时 data.name 和 getChat 都失败留下 oc_xxx。
   */
  private async repairBrokenGroupTitles(): Promise<void> {
    const broken = this.sessionManager.listSessions('group')
      .filter((s) => s.title === s.platform_session_id)
    if (broken.length === 0) return
    let repaired = 0
    for (const s of broken) {
      try {
        const chat = await this.client.getChat(s.platform_session_id)
        const name = chat.name?.trim()
        if (!name || name === s.platform_session_id) continue
        const updated = this.sessionManager.applyChatUpdate(s.platform_session_id, { title: name })
        if (updated && updated.title === name) {
          repaired += 1
          await this.publishSessionChanged('updated', updated)
        }
      } catch (err) {
        if (isPermissionDenied(err)) {
          this.warnScopeMissing('im:chat:readonly', '群名补齐', err)
          return
        }
        console.warn(`[FeishuChannel] repair title ${s.platform_session_id} failed:`, err)
      }
    }
    if (repaired > 0) console.log(`[FeishuChannel] repaired ${repaired} group titles (was chat_id placeholder)`)
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

    const mapped = mapMessageContent(message.message_type ?? 'text', message.content ?? '{}', mentions)

    // sender 昵称解析（contact API）和媒体下载彼此独立，并行节省 ~100ms
    const [senderName, rawContent] = await Promise.all([
      senderOpenId ? this.resolveDisplayName(senderOpenId) : Promise.resolve(''),
      this.applyMediaContent(mapped, message.message_id),
    ])
    const content = await this.enrichContentWithDocTitles(rawContent)

    const placeholderTitle = isGroup
      ? await this.resolveGroupTitle(message.chat_id)
      : (senderName || senderOpenId || message.chat_id)
    const { session } = this.sessionManager.upsert({
      platform_session_id: platformSessionId,
      type: sessionType,
      title: placeholderTitle,
      sender_id: senderOpenId,
      sender_name: senderName || senderOpenId,
    })

    // 文件惰性 handle 在 applyMediaContent（先于此处 session 解析）登记，此处补写 session_id 供慢档事件路由
    if (content.type === 'file' && content.handle) {
      await this.mediaHandleStore.setSessionId(content.handle, session.id)
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
      payload: {
        channel_id: this.config.moduleId,
        message: channelMessage,
        ...(this.botName ? { crab_display_name: this.botName } : {}),
        // 飞书消息正文里 mention 的字面通常是占位符或昵称，但 mentions 元数据
        // 用 open_id 标识——多机器人群里 dispatcher / worker 用此值判断哪条 mention 是自己。
        ...(this.botOpenId ? { crab_self_handle: `@${this.botOpenId}` } : {}),
      },
      timestamp: generateTimestamp(),
    }
    await this.rpcClient.publishEvent(event, this.config.moduleId)
  }

  /**
   * 把 mapper 输出的 image/file 内容补齐媒体信息。
   * - 图片：急切下载（VLM 要内联看图，需本地文件），写 file_path + status=ready
   * - 非图片文件：惰性——不下载，只登记 handle + 元信息 + status=not_fetched
   */
  private async applyMediaContent(
    mapped: ReturnType<typeof mapMessageContent>,
    messageId: string,
  ): Promise<MessageContent> {
    const { content, raw } = mapped
    if (content.type === 'image' && raw?.image_keys?.length) {
      const downloads: Array<{ filePath: string; mimeType?: string; size: number } | null> = []
      for (let index = 0; index < raw.image_keys.length; index++) {
        downloads.push(await this.downloadAndPersistMedia(
          messageId,
          raw.image_keys[index],
          'image',
          undefined,
          `-${index + 1}`,
        ))
      }
      const media = downloads.flatMap((r) => r ? [{
        media_url: r.filePath,
        mime_type: r.mimeType ?? 'application/octet-stream',
        filename: path.basename(r.filePath),
        size: r.size,
      }] : [])
      const failedCount = downloads.length - media.length
      const failureNote = failedCount === 0
        ? ''
        : failedCount === downloads.length
          ? '[图片下载失败]'
          : `[${failedCount} 张图片下载失败]`
      const text = [content.text, failureNote].filter(Boolean).join('\n')

      if (media.length === 0) return { type: 'text', text: text || '[图片下载失败]' }
      return {
        ...content,
        text,
        media,
        media_url: media[0].media_url,
        status: 'ready',
      }
    }
    if (content.type === 'image' && raw?.image_key) {
      const r = await this.downloadAndPersistMedia(messageId, raw.image_key, 'image')
      if (!r) return { type: 'text', text: '[图片下载失败]' }
      return {
        ...content,
        file_path: r.filePath,
        status: 'ready',
        mime_type: r.mimeType ?? content.mime_type,
        ...(r.size !== undefined ? { size: r.size } : {}),
      }
    }
    if (content.type === 'file' && raw?.file_key) {
      const handle = await this.mediaHandleStore.put({
        kind: 'file',
        ...(raw.filename !== undefined ? { filename: raw.filename } : {}),
        ...(content.size !== undefined ? { size: content.size } : {}),
        credential: { platform_message_id: messageId, file_key: raw.file_key },
      })
      return { ...content, handle, status: 'not_fetched' }
    }
    return content
  }

  /**
   * 拿用户昵称：先查缓存，未命中调 contact API。
   * 失败 / 用户无名时存入短 TTL 负缓存（避免每条消息都重试），返回空串供调用方 fallback。
   */
  private async resolveDisplayName(openId: string): Promise<string> {
    const cached = this.displayNameCache.get(openId)
    if (cached) {
      const ttl = cached.name ? FeishuChannel.DISPLAY_NAME_TTL_MS : FeishuChannel.DISPLAY_NAME_NEG_TTL_MS
      if (Date.now() - cached.fetchedAt < ttl) return cached.name
    }
    let name = ''
    try {
      name = (await this.client.getUser(openId)).name || ''
    } catch (err) {
      console.warn(`[FeishuChannel] resolveDisplayName failed for ${openId}:`, err)
    }
    this.cacheDisplayName(openId, name)
    return name
  }

  private cacheDisplayName(openId: string, name: string): void {
    if (this.displayNameCache.size >= FeishuChannel.DISPLAY_NAME_CACHE_MAX) {
      const firstKey = this.displayNameCache.keys().next().value
      if (firstKey !== undefined) this.displayNameCache.delete(firstKey)
    }
    this.displayNameCache.set(openId, { name, fetchedAt: Date.now() })
  }

  /**
   * 下载消息媒体到本地，按 magic bytes 探测真实格式。
   *
   * - image: 用 magic bytes 检测 png/jpg/gif/webp/bmp，决定扩展名 + mime_type
   * - file: 用 filenameHint 的扩展名；没有就 .bin
   * - 失败返回 null（调用方自行降级）
   */
  private async downloadAndPersistMedia(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    filenameHint?: string,
    filenameSuffix = '',
  ): Promise<{ filePath: string; mimeType?: string; size: number } | null> {
    try {
      const buffer = await this.client.downloadResource(messageId, fileKey, type)
      let ext: string
      let mimeType: string | undefined
      if (type === 'image') {
        const det = detectImageMime(buffer)
        ext = det.ext
        mimeType = det.mime
      } else {
        const fromHint = filenameHint ? path.extname(filenameHint) : ''
        ext = fromHint && /^\.[A-Za-z0-9]{1,8}$/.test(fromHint) ? fromHint : '.bin'
      }
      const filePath = path.join(this.dataDir, 'media', `${messageId}${filenameSuffix}${ext}`)
      await fsp.writeFile(filePath, buffer)
      return { filePath, mimeType, size: buffer.length }
    } catch (err) {
      console.warn(`[FeishuChannel] media download failed for ${messageId} (${type}):`, err)
      return null
    }
  }

  /** drive 文件落盘。扩展名优先用下载响应头里的文件名，其次 handle 登记时的 filename，拿不到则 .bin。失败返回 null。 */
  private async downloadDriveFileToDisk(
    fileToken: string,
    filenameHint?: string,
  ): Promise<{ filePath: string; mimeType?: string; size: number } | null> {
    try {
      const { buffer, filename, mimeType } = await this.client.downloadDriveFile(fileToken)
      const nameForExt = filename ?? filenameHint ?? ''
      const fromName = nameForExt ? path.extname(nameForExt) : ''
      const ext = fromName && /^\.[A-Za-z0-9]{1,8}$/.test(fromName) ? fromName : '.bin'
      const filePath = path.join(this.dataDir, 'media', `drive_${fileToken}${ext}`)
      await fsp.writeFile(filePath, buffer)
      return { filePath, size: buffer.length, ...(mimeType ? { mimeType } : {}) }
    } catch (err) {
      console.warn(`[FeishuChannel] drive download failed for ${fileToken}:`, err)
      const detail = err instanceof Error ? err.message : String(err)
      const looksLikePermission = /403|permission|forbidden|99991663|99991672/i.test(detail)
      const hint = looksLikePermission
        ? '这通常是权限问题：① 应用缺 drive:drive:readonly 下载权限，或 ② 这个文件没有分享给本应用。' +
          '解决：在飞书把该文件（或其所在文件夹）分享给应用作为协作者，或到开发者后台开通 drive 读权限并创建版本发布。'
        : ''
      throw new Error(`下载飞书文件失败（${detail}）。${hint}`.trim())
    }
  }

  /**
   * 解析群名：已有 session 且 title 不是 chat_id 占位 → 复用；否则调 getChat；失败 fallback 到 chat_id。
   * 避免新建 session 时把 oc_xxx 当成 title 落盘。
   */
  private async resolveGroupTitle(chatId: string): Promise<string> {
    const existing = this.sessionManager.findByPlatformId(chatId)
    if (existing && existing.title && existing.title !== chatId) return existing.title
    try {
      const chat = await this.client.getChat(chatId)
      const name = chat.name?.trim()
      if (name) return name
    } catch (err) {
      console.warn(`[FeishuChannel] resolveGroupTitle ${chatId} failed:`, err)
    }
    return chatId
  }

  /**
   * 对 text 内容中出现的飞书 URL，尝试取标题注解（仅轻量取 title，不取全文）。
   * 失败降级为 [飞书文档] url，绝不阻塞消息。
   */
  private async enrichContentWithDocTitles(content: MessageContent): Promise<MessageContent> {
    if (!content.text) return content
    const urls = extractFeishuDocUrls(content.text)
    if (urls.length === 0) return content

    // 并行获取所有 URL 的标题注解，再统一替换
    const refs = urls.map(url => ({ url, ref: parseFeishuDocUrl(url)! }))
    const annotations = await Promise.all(refs.map(({ ref }) => this.fetchDocTitleAnnotation(ref)))

    let text = content.text
    for (let i = 0; i < refs.length; i++) {
      text = text.replace(refs[i].url, `${annotations[i]} ${refs[i].url}`)
    }
    return { ...content, text }
  }

  private async fetchDocTitleAnnotation(ref: NonNullable<ReturnType<typeof parseFeishuDocUrl>>): Promise<string> {
    const cached = this.docTitleCache.get(ref.token)
    if (cached && Date.now() - cached.fetchedAt < FeishuChannel.DOC_TITLE_TTL_MS) {
      return docTitleLabel(cached.title)
    }
    try {
      const meta = await this.docReader.readMeta(ref)
      if (this.docTitleCache.size >= FeishuChannel.DOC_TITLE_CACHE_MAX) {
        const firstKey = this.docTitleCache.keys().next().value
        if (firstKey !== undefined) this.docTitleCache.delete(firstKey)
      }
      this.docTitleCache.set(ref.token, { title: meta.title, fetchedAt: Date.now() })
      return docTitleLabel(meta.title)
    } catch {
      return '[飞书文档]'
    }
  }

  private async handleBotAdded(data: { chat_id?: string; name?: string; type?: string }): Promise<void> {
    if (!data.chat_id) return
    let title = data.name?.trim() ?? ''
    if (!title) {
      try {
        const chat = await this.client.getChat(data.chat_id)
        title = chat.name?.trim() || data.chat_id
      } catch (err) {
        if (isPermissionDenied(err)) {
          this.warnScopeMissing('im:chat:readonly', '群名查询', err)
        } else {
          console.warn(`[FeishuChannel] getChat ${data.chat_id} failed:`, err)
        }
        title = data.chat_id
      }
    }
    let participants: Array<{ platform_user_id: string; role: 'member' }> = []
    try {
      const members = await this.client.getChatMembers(data.chat_id)
      participants = members.map((m) => ({ platform_user_id: m.open_id, role: 'member' as const }))
    } catch (err) {
      if (isPermissionDenied(err)) {
        this.warnScopeMissing('im:chat.members:read', '群成员查询', err)
      } else {
        console.warn(`[FeishuChannel] getChatMembers failed for ${data.chat_id}:`, err)
      }
    }
    const { session, created } = this.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: data.chat_id,
      title,
      participants,
    })
    await this.publishSessionChanged(created ? 'created' : 'updated', session)

    // bot 首次入群 → 一次性拉历史。用户确认这是唯一自动回填场景
    if (created) {
      this.backfillHistory({ session_id: session.id })
        .then((r) => console.log(`[FeishuChannel] auto backfill ${session.id}: backfilled=${r.backfilled_count}, skipped=${r.skipped_count}, has_more=${r.has_more}`))
        .catch((err) => console.warn(`[FeishuChannel] auto backfill failed for ${session.id}:`, err))
    }
  }

  private async handleBotDeleted(data: { chat_id?: string }): Promise<void> {
    if (!data.chat_id) return
    const removed = this.sessionManager.removeByPlatformId(data.chat_id)
    if (!removed) return
    await this.publishSessionChanged('removed', { ...removed, participants: [] })
  }

  private async handleUsersAdded(data: { chat_id?: string; users?: Array<{ user_id?: { open_id?: string }; name?: string }> }): Promise<void> {
    if (!data.chat_id) return
    const newcomers = (data.users ?? [])
      .map((u) => ({
        open_id: u.user_id?.open_id ?? '',
        name: u.name?.trim() ?? '',
      }))
      .filter((u) => u.open_id !== '')
    const added = newcomers.map((u) => ({ platform_user_id: u.open_id, role: 'member' as const }))
    const updated = this.sessionManager.applyParticipantsAdded(data.chat_id, added)
    if (updated) {
      await this.publishSessionChanged('participants_changed', updated)
      // 仅群聊 + 有真正新加入者时，额外推送 system_event message 让 agent 走 dispatcher
      if (updated.type === 'group' && newcomers.length > 0) {
        await this.publishMembersAddedSystemEvent(updated, newcomers)
      }
    }
  }

  /**
   * 把"有新成员进群"包装成 ChannelMessage(type=system_event) 推给 admin。
   * 见 base-protocol.md §5.4 system_event 和
   * crabot-docs/superpowers/specs/2026-06-02-channel-system-event-design.md
   */
  private async publishMembersAddedSystemEvent(
    session: Session,
    newcomers: ReadonlyArray<{ open_id: string; name: string }>,
  ): Promise<void> {
    const affected_users = newcomers.map((u) => ({
      platform_user_id: u.open_id,
      platform_display_name: u.name || u.open_id,
    }))
    const namesText = affected_users.map((u) => u.platform_display_name).join('、')
    const text = `已加入：${namesText}`
    const now = generateTimestamp()
    const channelMessage: ChannelMessage = {
      platform_message_id: `system:members_added:${session.platform_session_id}:${now}`,
      session: {
        session_id: session.id,
        channel_id: this.config.moduleId,
        type: 'group',
      },
      sender: {
        platform_user_id: this.botOpenId ?? '',
        platform_display_name: this.botName ?? '',
      },
      content: {
        type: 'system_event',
        event_type: 'members_added',
        affected_users,
        text,
      },
      features: { is_mention_crab: false },
      platform_timestamp: now,
    }
    const event: Event = {
      id: generateId(),
      type: 'channel.message_received',
      source: this.config.moduleId,
      payload: { channel_id: this.config.moduleId, message: channelMessage },
      timestamp: now,
    }
    await this.rpcClient.publishEvent(event, this.config.moduleId)
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
    let membersScopeMissing = false
    while (true) {
      let chatPage: { items: Array<{ chat_id: string; name: string }>; page_token?: string; has_more: boolean }
      try {
        chatPage = await this.client.listChats({ page_token: pageToken, page_size: 50 })
      } catch (err) {
        if (isPermissionDenied(err)) {
          this.warnScopeMissing('im:chat:readonly', '群列表读取', err)
          return
        }
        throw err
      }

      for (const it of chatPage.items) {
        let participants: Array<{ platform_user_id: string; role: 'member' }> = []
        if (!membersScopeMissing) {
          try {
            const members = await this.client.getChatMembers(it.chat_id)
            participants = members.map((m) => ({ platform_user_id: m.open_id, role: 'member' as const }))
          } catch (err) {
            if (isPermissionDenied(err)) {
              membersScopeMissing = true
              this.warnScopeMissing('im:chat.members:read', '群成员同步', err)
            } else {
              console.warn(`[FeishuChannel] bootstrap skip members ${it.chat_id}:`, err)
            }
          }
        }
        this.sessionManager.upsertGroupSessionFromSnapshot({
          platform_session_id: it.chat_id,
          title: it.name || it.chat_id,
          participants,
        })
        total += 1
      }
      if (!chatPage.has_more || !chatPage.page_token) break
      pageToken = chatPage.page_token
    }
    console.log(
      `[FeishuChannel] bootstrap done: ${total} groups synced${membersScopeMissing ? '（成员未拉，待事件补齐）' : ''}`,
    )
  }

  private warnScopeMissing(missingScope: string, label: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(
      `[FeishuChannel] ${label}降级：缺 scope ${missingScope}。请去飞书开发者后台为应用申请该权限并等待审批通过。原始错误：${msg}`,
    )
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
    this.registerMethod('backfill_history', this.handleBackfillHistory.bind(this))
    this.registerMethod('get_platform_user_info', this.handleGetPlatformUserInfo.bind(this))
    this.registerMethod('sync_sessions', this.handleSyncSessions.bind(this))
    this.registerMethod('delete_session', this.handleDeleteSession.bind(this))
    this.registerMethod('list_contacts', this.handleListContacts.bind(this))
    this.registerMethod('list_groups', this.handleListGroups.bind(this))
    this.registerMethod('list_group_members', this.handleListGroupMembers.bind(this))
    this.registerMethod('get_config', this.handleGetConfig.bind(this))
    this.registerMethod('update_config', this.handleUpdateConfig.bind(this))
    this.registerMethod('read_document', this.handleReadDocument.bind(this))
    this.registerMethod('add_reaction', this.handleAddReaction.bind(this))
    this.registerMethod('fetch_media', this.handleFetchMedia.bind(this))
    this.registerMethod('feishu_get', this.handleFeishuGet.bind(this))
    this.registerMethod('feishu_download', this.handleFeishuDownload.bind(this))
    this.registerMethod('feishu_write', this.handleFeishuWrite.bind(this))
  }

  /**
   * kind → emoji 映射表。新增 kind 必须先改协议。
   * Spec: 2026-06-04-channel-task-pickup-reaction-design.md §2
   */
  private static readonly REACTION_EMOJI_BY_KIND: Record<string, string> = {
    acknowledged: 'OnIt',
  }

  private async handleAddReaction(params: {
    session_id: string
    platform_message_id: string
    kind: string
  }): Promise<{ added: boolean }> {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throwError('NOT_FOUND', `Session not found: ${params.session_id}`)
    const emoji = FeishuChannel.REACTION_EMOJI_BY_KIND[params.kind]
    if (!emoji) throwError('INVALID_ARGUMENT', `Unknown reaction kind: ${params.kind}`)
    await this.client.addReaction(params.platform_message_id, emoji)
    return { added: true }
  }

  private async handleFetchMedia(params: FetchMediaParams): Promise<FetchMediaResult> {
    return this.mediaFetch.fetch(params.handle)
  }

  private async handleSendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throwError('NOT_FOUND', `Session not found: ${params.session_id}`)

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
      // 飞书 markdown 卡片每张最多 5 个表格，超出会返回 230099。
      // 在原始 text 上按段切分，先做 @mention 内联替换，再逐条发送。
      const rawText = params.content.text ?? ''
      const rawChunks = splitTextByTableLimit(rawText)
      const mentionMap = this.resolveMentions(params.features?.mentions)
      let lastResult!: { message_id: string; create_time: string }
      for (const rawChunk of rawChunks) {
        const willUseMarkdown = decideMarkdownEnabled(this.feishuConfig.markdown_format, rawChunk)
        const mode: 'text' | 'card' = willUseMarkdown ? 'card' : 'text'
        // 先做内联替换（at_name 匹配），再对未匹配的 mention 末尾追加
        const { text: inlinedText, unmatched } = replaceMentionsInline(rawChunk, mentionMap, mode)
        const sendText = injectMentionTags(inlinedText, unmatched, mode)
        const card = this.buildMarkdownCard(sendText)
        lastResult = card
          ? await this.client.sendCard(receive, card)
          : await this.client.sendText(receive, sendText)
        const chunkSentAt = isoFromMillis(lastResult.create_time) ?? generateTimestamp()
        await this.messageStore.append(
          session.id,
          this.buildOutboundStored(
            lastResult.message_id,
            rawChunks.length === 1 ? params.content : { ...params.content, text: rawChunk },
            chunkSentAt,
          ),
        )
      }
      return {
        platform_message_id: lastResult.message_id,
        sent_at: isoFromMillis(lastResult.create_time) ?? generateTimestamp(),
      }
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
    const rawText = params.content.text ?? ''
    const mentionMap = this.resolveMentions(params.features?.mentions)
    const willUseMarkdown = decideMarkdownEnabled(this.feishuConfig.markdown_format, rawText)
    const mode: 'text' | 'card' = willUseMarkdown ? 'card' : 'text'
    const { text: inlinedText, unmatched } = replaceMentionsInline(rawText, mentionMap, mode)
    const text = injectMentionTags(inlinedText, unmatched, mode)
    const card = this.buildMarkdownCard(text)
    return card
      ? { msgType: 'interactive', contentJson: JSON.stringify(card) }
      : { msgType: 'text', contentJson: JSON.stringify({ text }) }
  }

  /**
   * 飞书 interactive 卡片 schema 2.0 + markdown 元素：原生支持完整 GFM（含 header /
   * table / 代码块 / 列表）。schema 1.0 的 markdown 子集残缺——直接踩过坑，别回退。
   * 返回 null 表示走纯文本 msg_type=text。@ 标签由调用方注入。
   */
  private buildMarkdownCard(text: string): {
    schema: '2.0'
    config: { wide_screen_mode: boolean }
    body: { elements: Array<{ tag: string; content: string }> }
  } | null {
    if (!decideMarkdownEnabled(this.feishuConfig.markdown_format, text)) return null
    return {
      schema: '2.0',
      config: { wide_screen_mode: true },
      body: { elements: [{ tag: 'markdown', content: text }] },
    }
  }

  private async loadContentBuffer(content: MessageContent): Promise<{ buf: Buffer; filename: string }> {
    if (content.file_path) {
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
   * 把 SendMessageFeatures.mentions（MentionTarget[]）转为内部格式 {open_id, at_name?}[]。
   * platform_user_id 必须以 ou_ 开头（飞书 open_id），否则跳过。
   */
  private resolveMentions(mentions: MentionTarget[] | undefined): Array<{ open_id: string; at_name?: string }> {
    if (!mentions?.length) return []
    return mentions
      .filter((m) => /^ou_/.test(m.platform_user_id))
      .map((m) => ({ open_id: m.platform_user_id, at_name: m.at_name }))
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

  private assertFileSize(size: number): void {
    if (size > MAX_FILE_SIZE) {
      throwError('CHANNEL_FILE_TOO_LARGE', `file size ${size} exceeds limit ${MAX_FILE_SIZE}`)
    }
  }

  // ── capabilities ───────────────────────────────────────────────────────────

  private handleGetCapabilities(): ChannelCapabilities {
    return {
      supported_message_types: ['text', 'image', 'file'],
      supported_features: ['mention', 'quote', 'reaction'],
      supports_history_query: true,
      supports_platform_user_query: true,
      max_message_length: null,
      max_file_size: MAX_FILE_SIZE,
      supports_file_path: true,
      supports_list_contacts: true,
      supports_list_groups: true,
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

    const pageSize = params.pagination?.page_size ?? params.limit ?? 20
    // limit 语义 = 取最新 N 条；走 messageStore 的 slice(-limit) 分支需要 page=undefined
    const page = params.limit ? undefined : (params.pagination?.page ?? 1)

    const local = await this.messageStore.query({
      sessionId: session.id,
      timeRange: params.time_range,
      keyword: params.keyword,
      page,
      pageSize,
    })

    if (local.items.length > 0) {
      return paginated(local.items.map(toHistoryMessage), page ?? 1, pageSize, local.total)
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
        const items: HistoryMessage[] = []
        for (const m of remote.items) {
          items.push(await this.historyMapper(m, session.id))
        }
        return paginated(items, 1, pageSize, items.length)
      } catch (err) {
        console.warn('[FeishuChannel] history fallback failed:', err)
      }
    }
    return paginated<HistoryMessage>([], page ?? 1, pageSize, 0)
  }

  private async handleGetMessage(params: GetMessageParams): Promise<HistoryMessage> {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throwError('NOT_FOUND', 'Session not found')
    const local = await this.messageStore.findByMessageId(session.id, params.platform_message_id)
    if (local) return toHistoryMessage(local)
    const remote = await this.client.getMessage(params.platform_message_id)
    if (!remote) throwError('NOT_FOUND', 'Message not found')
    return this.historyMapper(remote, session.id)
  }

  private handleBackfillHistory(params: BackfillHistoryParams): Promise<BackfillHistoryResult> {
    return this.backfillHistory(params)
  }

  /**
   * 从飞书 im.v1.message.list 拉取指定群的历史消息，写入本地 message-store。
   * 触发场景：bot 首次进群事件（自动）/ Admin Web 群条目手动按钮（RPC backfill_history）。
   * 安全保护：默认窗口 7 天 / 默认上限 200 条 / 同 session 并发互斥 / 已存在 platform_message_id 跳过。
   */
  private readonly backfillInProgress = new Set<string>()
  private static readonly BACKFILL_DEFAULT_COUNT = 500
  private static readonly BACKFILL_HARD_CAP = 500

  private async backfillHistory(params: BackfillHistoryParams): Promise<BackfillHistoryResult> {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throwError('NOT_FOUND', `Session not found: ${params.session_id}`)
    if (session.type !== 'group') throwError('INVALID_ARGUMENT', 'Only group sessions support backfill')

    if (this.backfillInProgress.has(session.id)) {
      throwError('CONFLICT', `Backfill already in progress for session ${session.id}`)
    }
    this.backfillInProgress.add(session.id)

    try {
      const maxCount = Math.min(
        Math.max(1, params.max_count ?? FeishuChannel.BACKFILL_DEFAULT_COUNT),
        FeishuChannel.BACKFILL_HARD_CAP,
      )

      const stored = await this.messageStore.query({ sessionId: session.id })
      const existingIds = new Set(stored.items.map((i) => i.platform_message_id))

      // 默认不限时间下界，仅当调用方显式传 after/before 时才带上
      const afterSec = params.after ? Math.floor(new Date(params.after).getTime() / 1000).toString() : undefined
      let beforeSec: string | undefined
      if (params.before) {
        beforeSec = Math.floor(new Date(params.before).getTime() / 1000).toString()
      } else if (stored.items.length > 0) {
        // 自动续拉：从本地已存最早一条的前一秒往更早回溯，让"反复点击"真的能拿到新数据
        let oldestMs = Number.POSITIVE_INFINITY
        for (const m of stored.items) {
          const t = new Date(m.platform_timestamp).getTime()
          if (Number.isFinite(t) && t < oldestMs) oldestMs = t
        }
        if (Number.isFinite(oldestMs)) {
          beforeSec = Math.max(0, Math.floor((oldestMs - 1000) / 1000)).toString()
        }
      }

      let pageToken: string | undefined = undefined
      let backfilledCount = 0
      let skippedCount = 0
      let oldestMs: number | null = null
      let newestMs: number | null = null
      let hasMore = false

      while (backfilledCount < maxCount) {
        const remaining = maxCount - backfilledCount
        // page_size 上限 50；多拉一些抵消 dedup
        const pageSize = Math.min(50, Math.max(remaining, 20))
        const resp = await this.client.listMessages({
          container_id_type: 'chat',
          container_id: session.platform_session_id,
          ...(afterSec ? { start_time: afterSec } : {}),
          ...(beforeSec ? { end_time: beforeSec } : {}),
          // 按时间倒序拉，先拿最近的，page_token 接着往更早回溯
          sort_type: 'ByCreateTimeDesc',
          page_size: pageSize,
          page_token: pageToken,
        })

        for (const m of resp.items) {
          const platformId = (m as Record<string, unknown>).message_id as string | undefined
          if (!platformId) continue
          if (existingIds.has(platformId)) {
            skippedCount += 1
            continue
          }

          const history = await this.historyMapper(m, session.id)
          await this.messageStore.append(session.id, {
            ...history,
            direction: 'inbound',
          })
          existingIds.add(platformId)
          backfilledCount += 1

          const ts = new Date(history.platform_timestamp).getTime()
          if (Number.isFinite(ts)) {
            if (oldestMs === null || ts < oldestMs) oldestMs = ts
            if (newestMs === null || ts > newestMs) newestMs = ts
          }

          if (backfilledCount >= maxCount) break
        }

        hasMore = resp.has_more
        if (!hasMore || !resp.page_token) break
        pageToken = resp.page_token
      }

      return {
        session_id: session.id,
        backfilled_count: backfilledCount,
        skipped_count: skippedCount,
        has_more: hasMore,
        oldest_ts: oldestMs !== null ? new Date(oldestMs).toISOString() : undefined,
        newest_ts: newestMs !== null ? new Date(newestMs).toISOString() : undefined,
      }
    } finally {
      this.backfillInProgress.delete(session.id)
    }
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

  private async handleListContacts(params: ListContactsParams): Promise<ListContactsResult> {
    const pageSize = params.pagination?.page_size ?? 50

    // 收集所有联系人，org contacts 优先（有头像等更多信息）
    const merged = new Map<string, ContactItem>()

    // 1. 从通讯录拉取（可能因权限不足失败，非致命）
    try {
      const raw = await this.client.listContacts({ page_size: 200 })
      for (const it of raw.items) {
        if (it.open_id && it.name) {
          merged.set(it.open_id, {
            platform_user_id: it.open_id,
            display_name: it.name,
            ...(it.avatar_url ? { avatar_url: it.avatar_url } : {}),
          })
        }
      }
    } catch {
      // 应用未开通通讯录权限时跳过，不影响群成员查找
    }

    // 2. 从所有已知群会话拉取成员（覆盖通讯录没有的群成员）
    const groupSessions = this.sessionManager.listSessions('group')
    for (const session of groupSessions) {
      try {
        const members = await this.client.getChatMembers(session.platform_session_id)
        for (const m of members) {
          if (m.open_id && m.name && !merged.has(m.open_id) && m.open_id !== this.botOpenId) {
            merged.set(m.open_id, { platform_user_id: m.open_id, display_name: m.name })
          }
        }
      } catch {
        // 该群查不到成员时跳过
      }
    }

    const allItems = Array.from(merged.values()).filter((it) => it.display_name !== '')
    const filtered = params.search
      ? allItems.filter((it) => it.display_name.toLowerCase().includes(params.search!.toLowerCase()))
      : allItems

    return {
      items: filtered.slice(0, pageSize),
      pagination: {
        page: 1,
        page_size: pageSize,
        total_items: filtered.length,
        total_pages: 1,
      },
    }
  }

  private async handleListGroups(params: ListGroupsParams): Promise<ListGroupsResult> {
    const pageSize = params.pagination?.page_size ?? 50
    const raw = await this.client.listChats({ page_size: pageSize })

    const filtered = params.search
      ? raw.items.filter((it) => it.name.toLowerCase().includes(params.search!.toLowerCase()))
      : raw.items

    const items = filtered.map((it): GroupItem => ({
      platform_session_id: it.chat_id,
      group_name: it.name,
    }))

    return {
      items,
      pagination: {
        page: 1,
        page_size: pageSize,
        total_items: items.length,
        total_pages: raw.has_more ? 2 : 1,
      },
    }
  }

  private async handleListGroupMembers(params: ListGroupMembersParams): Promise<ListGroupMembersResult> {
    const session = this.sessionManager.findById(params.session_id)
    if (!session) throwError('NOT_FOUND', `Session ${params.session_id} not found`)
    if (session.type !== 'group') throwError('INVALID_ARGUMENT', `Session ${params.session_id} is not a group`)

    const members = await this.client.getChatMembers(session.platform_session_id)
    const all: GroupMember[] = members.map((m) => ({
      platform_user_id: m.open_id,
      display_name: m.name || undefined,
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
      member_count: all.length,
      members_complete: true,
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
      group: {
        only_respond_to_mentions: this.feishuConfig.only_respond_to_mentions,
        allow_write: this.feishuConfig.allow_write !== false,
      },
      markdown_format: this.feishuConfig.markdown_format,
      crab_platform_user_id: this.botOpenId ?? '',
    }
    return {
      config: cfg,
      schema: {
        'credentials.app_secret': { sensitive: true, hot_reload: false, description: 'App Secret，变更需重启' },
        'credentials.app_id': { hot_reload: false, description: 'App ID，变更需重启' },
        'credentials.domain': { hot_reload: false, description: '接入域，变更需重启' },
        'group.only_respond_to_mentions': { hot_reload: true, description: '群聊仅响应 @ Crabot' },
        'group.allow_write': { hot_reload: true, description: '允许写操作（POST/PUT/PATCH/DELETE 透传，默认开启；关闭后 agent 无法修改飞书数据）' },
        'markdown_format': { hot_reload: true, description: 'Markdown 渲染开关：auto / on / off' },
      },
    }
  }

  /**
   * Admin Web 把 handleGetConfig 的嵌套结构原样回传，所以 incoming 字段路径必须
   * 跟 get 输出一一对应：credentials.* / group.* / markdown_format。敏感字段如果
   * 收到 mask 占位符 *** 表示用户没改，跳过覆盖避免清掉真值。
   */
  private handleUpdateConfig(params: {
    config?: {
      credentials?: { app_id?: string; app_secret?: string; domain?: FeishuDomain; owner_open_id?: string }
      group?: { only_respond_to_mentions?: boolean; allow_write?: boolean }
      markdown_format?: MarkdownFormat
    }
  }): { config: Record<string, unknown>; requires_restart: boolean } {
    const incoming = params.config ?? {}
    let requiresRestart = false

    const creds = incoming.credentials ?? {}
    if (typeof creds.app_id === 'string' && creds.app_id && creds.app_id !== this.feishuConfig.app_id) {
      this.feishuConfig.app_id = creds.app_id
      requiresRestart = true
    }
    if (typeof creds.app_secret === 'string' && creds.app_secret && creds.app_secret !== '***') {
      this.feishuConfig.app_secret = creds.app_secret
      requiresRestart = true
    }
    if (creds.domain && creds.domain !== this.feishuConfig.domain) {
      this.feishuConfig.domain = creds.domain
      requiresRestart = true
    }
    if (creds.owner_open_id !== undefined) {
      this.feishuConfig.owner_open_id = creds.owner_open_id || undefined
    }

    const group = incoming.group ?? {}
    if (typeof group.only_respond_to_mentions === 'boolean') {
      this.feishuConfig.only_respond_to_mentions = group.only_respond_to_mentions
    }
    if (typeof group.allow_write === 'boolean') {
      this.feishuConfig.allow_write = group.allow_write
    }

    if (incoming.markdown_format && MARKDOWN_FORMAT_VALUES.includes(incoming.markdown_format)) {
      this.feishuConfig.markdown_format = incoming.markdown_format
    }

    const masked = this.handleGetConfig().config
    return { config: masked, requires_restart: requiresRestart }
  }

  /** 原生只读透传：仅 GET /open-apis/*，授权由 app scope 兜底。 */
  private async handleFeishuGet(params: { path: string; query?: Record<string, string | number> }): Promise<{ data: unknown }> {
    const { path: p, query } = params
    if (!p || typeof p !== 'string' || !p.startsWith('/open-apis/') || p.includes('..')) {
      throwError('INVALID_ARGUMENT', 'path 必须以 /open-apis/ 开头且不含 ..')
    }
    const data = await this.client.rawGet(p, query)
    return { data }
  }

  /** 原生写透传：POST/PUT/PATCH/DELETE /open-apis/*。受 allow_write 开关控制；403 给写 scope 引导。 */
  private async handleFeishuWrite(params: {
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    body?: unknown
    query?: Record<string, string | number>
  }): Promise<Record<string, unknown>> {
    if (this.feishuConfig.allow_write === false) {
      return {
        error_code: 'WRITE_DISABLED',
        message: '这台 crabot 的飞书 channel 关闭了写操作。要开启：去 Admin → 该 channel 配置 → 打开「允许写操作」。',
      }
    }
    const { method, path: p, body, query } = params
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      throwError('INVALID_ARGUMENT', 'method 必须是 POST/PUT/PATCH/DELETE；只读请用 feishu_get')
    }
    if (!p || typeof p !== 'string' || !p.startsWith('/open-apis/') || p.includes('..')) {
      throwError('INVALID_ARGUMENT', 'path 必须以 /open-apis/ 开头且不含 ..')
    }
    try {
      const data = await this.client.rawRequest({ method, path: p, ...(body !== undefined ? { body } : {}), ...(query ? { query } : {}) })
      return { data }
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'PERMISSION_DENIED') {
        const scope = writeScopeForPath(p)
        if (scope) {
          const remediation = buildFeishuRemediation({ appId: this.feishuConfig.app_id, domain: this.feishuConfig.domain, missingScope: scope, intent: 'write' })
          return { error_code: 'PERMISSION_DENIED', message: remediation.message, remediation }
        }
        return { error_code: 'PERMISSION_DENIED', message: '飞书拒绝了这个写操作，通常是应用缺该 API 的写权限。请到飞书开发者后台开通对应写权限并创建版本发布，并确认应用是目标资源的协作者。' }
      }
      throw err
    }
  }

  /** 把 drive file_token 登记为 media handle，agent 再用 fetch_media 取本地路径。 */
  private async handleFeishuDownload(params: { file_token: string; filename?: string; size?: number }): Promise<{ handle: string; status: 'not_fetched' }> {
    if (!params.file_token) throwError('INVALID_ARGUMENT', 'file_token is required')
    const handle = await this.mediaHandleStore.put({
      kind: 'file',
      ...(params.filename ? { filename: params.filename } : {}),
      ...(typeof params.size === 'number' ? { size: params.size } : {}),
      credential: { file_token: params.file_token },
    })
    return { handle, status: 'not_fetched' }
  }

  private async handleReadDocument(params: { url: string; max_chars?: number }): Promise<Record<string, unknown>> {
    const { url, max_chars } = params
    if (!url || typeof url !== 'string') throwError('INVALID_ARGUMENT', 'url is required')

    const ref = parseFeishuDocUrl(url)
    if (!ref) throwError('INVALID_ARGUMENT', `不是飞书云文档 URL：${url}`)
    if (ref.kind === 'unknown') {
      throwError('UNSUPPORTED', `本期不支持读取此类型飞书文档，支持：docx / wiki / sheets / file。URL: ${url}`)
    }

    try {
      const result = await this.docReader.read(ref, { maxChars: max_chars })
      if (result.type === 'file') {
        const handle = await this.mediaHandleStore.put({
          kind: 'file',
          ...(result.filename ? { filename: result.filename } : {}),
          credential: { file_token: result.file_token as string },
        })
        return { type: 'file', title: result.title, handle, status: 'not_fetched', ...(result.filename ? { filename: result.filename } : {}), url }
      }
      return { ...result, url }
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? ''
      if (code === 'PERMISSION_DENIED') {
        const errCtx = err as { missing_scope?: string; feishu_code?: number; feishu_message?: string }
        const missingScope = errCtx.missing_scope
          ?? READ_SCOPE_BY_KIND[ref!.kind] ?? 'drive:drive:readonly'
        const feishu_code = errCtx.feishu_code
        const feishu_message = errCtx.feishu_message
        const remediation = buildFeishuRemediation({
          appId: this.feishuConfig.app_id,
          domain: this.feishuConfig.domain,
          missingScope,
          feishu_code,
          feishu_message,
        })
        return { error_code: 'PERMISSION_DENIED', message: remediation.message, remediation, url, feishu_code, feishu_message }
      }
      if (code === 'NOT_FOUND') throwError('NOT_FOUND', `文档不存在或已删除：${url}`)
      if (code === 'UNSUPPORTED') throwError('UNSUPPORTED', (err as Error).message)
      throw err
    }
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

  // ============================================================================
  // 历史消息 mapper（远端查询/回填复用）
  // ============================================================================

  /**
   * 把飞书 im.v1.message.list / getMessage 返回的原始消息记录映射为 HistoryMessage，
   * 复用 mapMessageContent + applyMediaContent，使 file 消息正确产生惰性 handle。
   * 保留 mentions、parent_id→reply_to_message_id、root_id→root_message_id。
   * @param sessionId 可选，传入时为 file handle 登记 session_id
   */
  private async historyMapper(
    m: Record<string, unknown>,
    sessionId?: string,
  ): Promise<HistoryMessage> {
    const sender = (m.sender as Record<string, unknown> | undefined) ?? {}
    const senderId = (sender.id as string) ?? ''
    const body = (m.body as Record<string, unknown> | undefined) ?? {}
    const msgType = (m.msg_type as string) ?? 'text'
    const contentJson = (body.content as string) ?? '{}'
    // REST API 返回的 mentions 格式与事件不同（id 为字符串 + id_type），归一化后再传给 mapMessageContent
    const rawMentions = (m.mentions as Array<Record<string, unknown>> | undefined) ?? []
    const mentions = normalizeRESTMentions(rawMentions)
    const messageId = (m.message_id as string) ?? ''

    const mapped = mapMessageContent(msgType, contentJson, mentions)

    // 仅 file 类型登记惰性 handle（图片在历史查询不下载）
    // 优先复用已有 handle（按 message_id + file_key 去重），避免每次查询 mint 新 handle 导致 store 无界增长
    let content: MessageContent
    if (mapped.content.type === 'file') {
      const fileKey = mapped.raw?.file_key
      let existingHandle: string | undefined
      if (fileKey) {
        existingHandle = this.mediaHandleStore.findByCredential({ platform_message_id: messageId, file_key: fileKey })
      }
      if (existingHandle) {
        content = { ...mapped.content, handle: existingHandle, status: 'not_fetched' as const }
      } else {
        content = await this.applyMediaContent(mapped, messageId)
      }
      if (sessionId && content.type === 'file' && content.handle) {
        await this.mediaHandleStore.setSessionId(content.handle, sessionId)
      }
    } else if (mapped.content.type === 'image') {
      // 历史 image 不下载图片，补 text 占位避免 agent 侧渲染空白
      // post 内嵌图片已有 text（拍平后的富文本），仅纯 image 消息需补 `[图片]`
      content = { ...mapped.content, text: mapped.content.text ?? '[图片]' }
    } else {
      content = mapped.content
    }

    const features: MessageFeatures = {
      is_mention_crab: false,
      ...(mapped.features.mentions ? { mentions: mapped.features.mentions } : {}),
      ...((m as Record<string, unknown>).parent_id
        ? { reply_to_message_id: (m as Record<string, unknown>).parent_id as string }
        : {}),
      ...((m as Record<string, unknown>).root_id &&
        (m as Record<string, unknown>).root_id !== (m as Record<string, unknown>).parent_id
        ? { root_message_id: (m as Record<string, unknown>).root_id as string }
        : {}),
    }

    return {
      platform_message_id: messageId,
      sender: { platform_user_id: senderId, platform_display_name: senderId },
      content,
      features,
      platform_timestamp: isoFromMillis((m.create_time as string) ?? '') ?? new Date().toISOString(),
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * 归一化飞书 REST API（im.v1.message.list / getMessage）的 mentions 格式为事件格式（FeishuMention）。
 *
 * REST 返回：
 *   { key, id: "ou_xxx", id_type: "open_id", name, tenant_key }
 * 事件格式：
 *   { key, id: { open_id: "ou_xxx" }, name, tenant_key }
 *
 * 已符合事件格式的（id 是对象）原样返回。
 */
function normalizeRESTMentions(raw: Array<Record<string, unknown>>): FeishuMention[] {
  return raw.map((m) => {
    const id = m.id
    if (typeof id === 'string' && id) {
      const idType = (m.id_type as string) ?? 'open_id'
      const normalizedId: FeishuMention['id'] = {}
      if (idType === 'open_id') {
        normalizedId.open_id = id
      } else if (idType === 'user_id') {
        normalizedId.user_id = id
      } else if (idType === 'union_id') {
        normalizedId.union_id = id
      } else {
        // 未知 id_type 兜底为 open_id
        normalizedId.open_id = id
      }
      return {
        key: (m.key as string) ?? '',
        id: normalizedId,
        name: (m.name as string) ?? '',
        tenant_key: m.tenant_key as string | undefined,
      }
    }
    // id 已经是对象（事件格式），直接 cast
    return m as unknown as FeishuMention
  })
}

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

function docTitleLabel(title: string): string {
  return title ? `[飞书文档·${title}]` : '[飞书文档]'
}

function isPermissionDenied(err: unknown): boolean {
  return err instanceof RpcError && err.code === 'PERMISSION_DENIED'
}
