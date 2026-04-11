/**
 * Channel Host 模块类型定义
 *
 * 严格对齐协议文档：
 * - base-protocol.md §5.3 Session
 * - base-protocol.md §5.4 MessageContent
 * - base-protocol.md §5.5 ChannelMessage
 * - protocol-channel.md §3 接口定义
 * - protocol-channel.md §4 发出的事件
 */

import type { ModuleId, FriendId, SessionId } from 'crabot-shared'

// ============================================================================
// 复用 base-protocol 中的类型
// ============================================================================

export type { ModuleId, FriendId, SessionId }

// ============================================================================
// MessageContent（来自 base-protocol.md §5.4）
// ============================================================================

export type MessageType = 'text' | 'image' | 'file'

export interface MessageContent {
  type: MessageType
  text?: string
  media_url?: string
  file_path?: string
  filename?: string
  mime_type?: string
  size?: number
}

// ============================================================================
// Session（来自 base-protocol.md §5.3）
// ============================================================================

export type SessionType = 'private' | 'group'

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
  /** Admin 鉴权后填充；channel.message_received 阶段不存在 */
  friend_id?: FriendId
  platform_user_id: string
  role: 'owner' | 'admin' | 'member'
}

export interface Session {
  id: SessionId
  channel_id: ModuleId
  type: SessionType
  platform_session_id: string
  title: string
  participants: SessionParticipant[]
  permissions: SessionPermissions
  memory_scopes: string[]
  workspace_path: string
  created_at: string
  updated_at: string
}

// ============================================================================
// ChannelMessage（来自 base-protocol.md §5.5）
// ============================================================================

export interface SessionRef {
  session_id: SessionId
  channel_id: ModuleId
  type: SessionType
}

export interface SenderRef {
  /** Admin 鉴权后填充；channel.message_received 阶段不存在 */
  friend_id?: FriendId
  platform_user_id: string
  platform_display_name: string
}

export interface MentionRef {
  friend_id: FriendId
  platform_user_id: string
}

export interface MessageFeatures {
  mentions?: MentionRef[]
  quote_message_id?: string
  is_mention_crab: boolean
  thread_id?: string | number
  reply_to_message_id?: string
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

// ============================================================================
// Channel 协议类型（来自 protocol-channel.md §3）
// ============================================================================

export type ChannelFeature = 'mention' | 'quote' | 'reaction' | 'thread'

export interface ChannelCapabilities {
  supported_message_types: MessageType[]
  supported_features: ChannelFeature[]
  supports_history_query: boolean
  supports_platform_user_query: boolean
  max_message_length: number | null
  max_file_size: number | null
  supports_file_path: boolean
  allowed_file_paths: string[]
}

export interface SendMessageFeatures {
  mentions?: FriendId[]
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

export interface PaginatedResult<T> {
  items: T[]
  pagination: {
    page: number
    page_size: number
    total_items: number
    total_pages: number
  }
}

export interface GetSessionsParams {
  type?: SessionType
  pagination?: PaginationParams
}

export type GetSessionsResult = PaginatedResult<Session>

export interface GetSessionParams {
  session_id: SessionId
}

export interface GetSessionResult {
  session: Session
}

export interface FindOrCreatePrivateSessionParams {
  platform_user_id: string
  account_id?: string
}

export interface FindOrCreatePrivateSessionResult {
  session: Session
  created: boolean
}

// ============================================================================
// get_history（来自 protocol-channel.md §3.3）
// ============================================================================

export interface TimeRange {
  before?: string
  after?: string
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
  sender_name: string
  sender_platform_user_id?: string
  content: string
  content_type: MessageType
  /** 媒体 URL 或本地文件路径（image/file 消息） */
  media_url?: string
  /** 媒体 MIME 类型 */
  mime_type?: string
  /** 文件名 */
  filename?: string
  timestamp: string
}

export interface GetHistoryResult {
  items: HistoryMessage[]
  pagination: {
    page: number
    page_size: number
    total_items: number
    total_pages: number
  }
}

// ============================================================================
// Channel 配置（来自 protocol-channel.md §6）
// ============================================================================

export interface ChannelConfig {
  /** Channel 平台类型标识 */
  platform: string
  /** 平台 API 凭证（各平台不同） */
  credentials: Record<string, string>
  /** 本地消息缓存配置 */
  cache?: {
    max_days: number
    max_messages_per_session: number
  }
  /** 群聊配置 */
  group?: {
    only_respond_to_mentions: boolean
  }
  /** Crabot 在此平台上的用户 ID */
  crab_platform_user_id?: string
  /** 允许额外自定义字段（OpenClaw 插件格式） */
  [key: string]: unknown
}

export interface GetConfigResult {
  config: ChannelConfig
  schema?: Record<string, unknown>
}

export interface UpdateConfigParams {
  config: Partial<ChannelConfig>
}

export interface UpdateConfigResult {
  config: ChannelConfig
  requires_restart: boolean
}

// ============================================================================
// Friend 解析结果（来自 Admin resolve_friend）
// ============================================================================

export interface ResolvedFriend {
  id: FriendId
  display_name: string
  permission: 'master' | 'normal'
  channel_identities: Array<{
    channel_id: ModuleId
    platform_user_id: string
    platform_display_name: string
  }>
}

// ============================================================================
// OpenClaw 类型桩（不依赖真实 openclaw，通过动态 import 加载）
// ============================================================================

/**
 * OpenClaw 消息上下文（MsgContext）
 * 由 OpenClaw 插件传入，包含发送者和消息信息
 */
export interface MsgContext {
  SenderId?: string
  SenderName?: string
  SenderUsername?: string
  SessionKey?: string
  AccountId?: string
  Provider?: string
  Body?: string
  RawBody?: string
  ChatType?: string
  MessageId?: string
  /** 媒体本地文件路径（由 OpenClaw 插件 buildAgentMediaPayload 设置） */
  MediaPath?: string
  /** 媒体 MIME 类型 */
  MediaType?: string
  /** 媒体 URL（通常与 MediaPath 相同） */
  MediaUrl?: string
  /** 多媒体本地文件路径列表 */
  MediaPaths?: string[]
  /** 多媒体 URL 列表 */
  MediaUrls?: string[]
  /** 多媒体 MIME 类型列表 */
  MediaTypes?: string[]
  /** 是否 @了 bot（由 OpenClaw 插件的 WasMentioned 字段传入） */
  WasMentioned?: boolean
}

/**
 * OpenClaw 回复载荷（ReplyPayload）
 * 传给 deliver 函数，由插件发送到平台
 */
export interface ReplyPayload {
  text?: string
  mediaUrl?: string
  mediaUrls?: string[]
  replyToId?: string
  filename?: string
  mimeType?: string
}

/**
 * OpenClaw deliver 函数类型
 * 插件调用此函数将回复内容发送到平台
 */
export type DeliverFn = (payload: ReplyPayload, info: { kind: string }) => Promise<void>
