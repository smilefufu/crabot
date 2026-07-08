/**
 * crabot-channel-dingtalk 类型定义
 *
 * 对齐：
 * - crabot base-protocol.md §5.3-5.5 的 Session / ChannelMessage
 * - crabot protocol-channel.md §3 的 Channel 接口
 * - 钉钉 Stream 机器人回调消息 schema（dingtalk-stream-sdk-nodejs 派生超集）
 *
 * 协议子集与 crabot-channel-feishu/src/types.ts 逐字对齐，仅把「飞书事件类型子集」
 * 换成「钉钉事件类型子集」，并把 FeishuChannelConfig 换成 DingtalkChannelConfig。
 */

import type { ModuleId, SessionId, MarkdownFormat } from 'crabot-shared'

export type { ModuleId, SessionId, MarkdownFormat }

// ============================================================================
// Crabot Channel 协议类型
// ============================================================================

export type MessageType = 'text' | 'image' | 'file' | 'system_event'
export type SessionType = 'private' | 'group'
export type ChannelFeature = 'mention' | 'quote' | 'reaction' | 'thread'

/** system_event 子类型，见 base-protocol.md §5.4 system_event */
export type SystemEventType = 'members_added' | 'scheduled'

export interface MessageContent {
  type: MessageType
  text?: string
  media_url?: string
  file_path?: string
  filename?: string
  mime_type?: string
  size?: number
  /** 惰性媒体下载句柄（非图片文件 status=not_fetched 时携带，传给 fetch_media RPC） */
  handle?: string
  /** 媒体就绪状态：ready=已就绪(见 file_path) / not_fetched=未下载 / fetching=下载中 / failed=失败 */
  status?: 'ready' | 'not_fetched' | 'fetching' | 'failed'
  event_type?: SystemEventType
  affected_users?: Array<{ platform_user_id: string; platform_display_name: string }>
}

export interface SessionPermissions {
  desktop: boolean
  network: {
    mode: 'allow_all' | 'whitelist' | 'blacklist'
    rules: string[]
  }
  storage: Array<{
    path: string
    access: 'read' | 'readwrite'
  }>
}

export interface SessionParticipant {
  friend_id?: string
  /** 钉钉 senderStaffId */
  platform_user_id: string
  role: 'owner' | 'admin' | 'member'
}

export interface Session {
  id: SessionId
  channel_id: ModuleId
  type: SessionType
  /** 钉钉 conversationId（群聊）或 senderStaffId（私聊） */
  platform_session_id: string
  title: string
  participants: SessionParticipant[]
  permissions: SessionPermissions
  memory_scopes: string[]
  workspace_path: string
  created_at: string
  updated_at: string
}

export interface SessionRef {
  session_id: SessionId
  channel_id: ModuleId
  type: SessionType
}

export interface SenderRef {
  friend_id?: string
  platform_user_id: string
  platform_display_name: string
}

export interface MessageMention {
  friend_id: string
  platform_user_id: string
}

export interface MessageFeatures {
  mentions?: MessageMention[]
  is_mention_crab: boolean
  quote_message_id?: string
  reply_to_message_id?: string
  thread_id?: string | number
  native_channel_id?: string
  root_message_id?: string
}

export interface ChannelMessage {
  platform_message_id: string
  session: SessionRef
  sender: SenderRef
  content: MessageContent
  features: MessageFeatures
  platform_timestamp: string
}

export interface ChannelExtensionTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
  endpoint: string
}

export interface ChannelCapabilities {
  supported_message_types: MessageType[]
  supported_features: ChannelFeature[]
  supports_history_query: boolean
  supports_platform_user_query: boolean
  max_message_length: number | null
  max_file_size: number | null
  supports_file_path: boolean
  allowed_file_paths: string[]
  /** 是否支持 list_contacts */
  supports_list_contacts: boolean
  /** 是否支持 list_groups */
  supports_list_groups: boolean
  /** 是否支持 list_group_members */
  supports_list_group_members: boolean
  /** 是否支持 fetch_media（惰性媒体按需下载） */
  supports_media_fetch?: boolean
  extensions?: ChannelExtensionTool[]
}

export interface MentionTarget {
  /** 钉钉 staffId，由 crab-messaging 从 friend_id 解析而来 */
  platform_user_id: string
  /**
   * LLM 在 content 正文里写的 @标记文本，例如 "@徐倩"。
   * 有此字段时 channel 在正文里做内联高亮替换；不提供则在消息末尾追加 @ 通知。
   */
  at_name?: string
}

export interface SendMessageFeatures {
  mentions?: MentionTarget[]
  quote_message_id?: string
  thread_id?: string | number
  reply_to_message_id?: string
  native_channel_id?: string
}

export interface SendMessageParams {
  session_id: SessionId
  content: MessageContent
  features?: SendMessageFeatures
}

export interface SendMessageResult {
  platform_message_id: string
  sent_at: string
}

export interface PaginationParams {
  page: number
  page_size: number
}

export interface PaginationResult {
  page: number
  page_size: number
  total_items: number
  total_pages: number
}

export interface GetSessionsParams {
  type?: SessionType
  pagination?: PaginationParams
}

export interface GetSessionParams {
  session_id: SessionId
}

export interface FindOrCreatePrivateSessionParams {
  /** 钉钉 senderStaffId */
  platform_user_id: string
  account_id?: string
}

export interface TimeRange {
  before?: string
  after?: string
}

export interface GetMessageParams {
  session_id: SessionId
  platform_message_id: string
}

export interface GetHistoryParams {
  session_id: SessionId
  time_range?: TimeRange
  keyword?: string
  limit?: number
  pagination?: PaginationParams
}

export interface HistoryMessage {
  platform_message_id: string
  sender: SenderRef
  content: MessageContent
  features: MessageFeatures
  platform_timestamp: string
}

export interface PlatformUserInfoResult {
  platform_user_id: string
  display_name: string
  avatar_url?: string
  extra?: Record<string, unknown>
}

export interface SyncSessionsParams {
  mode?: 'full' | 'incremental'
}

export interface SyncSessionsResult {
  added: number
  updated: number
  removed: number
}

export interface DeleteSessionResult {
  deleted: boolean
}

export interface GroupMember {
  platform_user_id: string
  display_name?: string
  role: 'owner' | 'admin' | 'member'
}

export interface ListGroupMembersParams {
  session_id: SessionId
  pagination?: PaginationParams
}

export interface ListGroupMembersResult {
  items: GroupMember[]
  pagination: {
    page: number
    page_size: number
    total_items: number
    total_pages: number
  }
  member_count: number
  members_complete: boolean
  partial_reason?: string
}

export interface FetchMediaParams {
  handle: string
}

export interface FetchMediaResult {
  status: 'ready' | 'fetching' | 'failed'
  file_path?: string
  mime_type?: string
  size?: number
  error?: string
}

// ============================================================================
// 钉钉事件类型子集
//
// dingtalk-stream-sdk-nodejs 只 typed 了 text 子集（RobotTextMessage），
// 且不含 atUsers / isInAtList。这里声明实际回调 payload 的超集，方便 event-mapper
// 防御式读取与单测构造。原始 payload = JSON.parse(DWClientDownStream.data)。
// ============================================================================

/** conversationType：'1' = 单聊，'2' = 群聊 */
export type DingtalkConversationType = '1' | '2'

export type DingtalkMsgType =
  | 'text'
  | 'richText'
  | 'picture'
  | 'audio'
  | 'video'
  | 'file'
  | string

/** atUsers 里的单个被 @ 者。钉钉给的是 dingtalkId，staffId 视配置可能缺失。 */
export interface DingtalkAtUser {
  dingtalkId?: string
  staffId?: string
}

/** richText 元素（拍平用）。图片元素带 downloadCode / pictureDownloadCode。 */
export interface DingtalkRichTextItem {
  type?: string
  text?: string
  downloadCode?: string
  pictureDownloadCode?: string
}

/**
 * 钉钉机器人回调消息（DWClientDownStream.data JSON.parse 后的结构）。
 * 字段基于 dingtalk-stream-sdk-nodejs 的 RobotMessageBase + 实际 payload 补全。
 */
export interface DingtalkInboundMessage {
  /** 群聊 = openConversationId */
  conversationId: string
  conversationType: DingtalkConversationType
  /** 群名（群聊时可能携带） */
  conversationTitle?: string
  /** 机器人自身在此对话里的 userId，用于 @ 检测 */
  chatbotUserId: string
  chatbotCorpId?: string
  senderStaffId: string
  senderNick: string
  senderId?: string
  senderCorpId?: string
  isAdmin?: boolean
  robotCode: string
  msgId: string
  msgtype: DingtalkMsgType
  createAt: number
  /** 会话级临时 webhook（免 token 即时回复），配 sessionWebhookExpiredTime 判有效期 */
  sessionWebhook?: string
  sessionWebhookExpiredTime?: number
  /** 群聊里本条消息是否 @ 了机器人 */
  isInAtList?: boolean
  atUsers?: DingtalkAtUser[]
  /** text 消息内容 */
  text?: { content?: string }
  /** markdown 消息内容 */
  markdown?: { title?: string; text?: string }
  /**
   * picture / file / richText 等消息内容。
   * - picture / file：`downloadCode`（+ file 的 fileName/fileSize）在此。
   * - richText（真机实测：群里发图 + @ 走这条）：图文混排数组在 `content.richText`，
   *   图片元素带 `downloadCode` / `pictureDownloadCode` + `type:'picture'`。
   */
  content?: {
    downloadCode?: string
    fileName?: string
    fileSize?: number | string
    richText?: DingtalkRichTextItem[]
    [key: string]: unknown
  }
  /** 其余平台字段（防御式读取） */
  [key: string]: unknown
}

// ============================================================================
// 模块配置
// ============================================================================

export interface DingtalkCacheConfig {
  /** 缓存最近 N 天消息 */
  max_days: number
  /** 每个 session 缓存最多 N 条 */
  max_messages_per_session: number
}

export interface DingtalkChannelConfig {
  /** 企业内部应用 AppKey（= Stream clientId） */
  app_key: string
  /** 企业内部应用 AppSecret（= Stream clientSecret） */
  app_secret: string
  /** 机器人 robotCode（出站发送必需） */
  robot_code: string
  /** 拥有者 staffId（可选，手动配置 DINGTALK_OWNER_STAFF_ID；跨渠道复用主人身份）。
   *  v1 不做运行时「绑定」自动认主，需手动填写。 */
  owner_staff_id?: string
  only_respond_to_mentions: boolean
  /** bot 发文本时是否按 Markdown 渲染（启用时改用 sampleMarkdown）。默认 auto */
  markdown_format: MarkdownFormat
}
