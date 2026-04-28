/**
 * crabot-channel-telegram 类型定义
 *
 * 对齐：
 * - Telegram Bot API 类型（精简版，只包含用到的字段）
 * - crabot base-protocol.md §5.3-5.5 的 Session / ChannelMessage
 * - crabot protocol-channel.md §3 的 Channel 接口
 */

import type { ModuleId, SessionId } from 'crabot-shared'

export type { ModuleId, SessionId }

// ============================================================================
// Telegram Bot API 类型（精简，只包含本模块用到的字段）
// ============================================================================

export interface TgUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
}

export interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TgMessageEntity {
  type: string
  offset: number
  length: number
  /** For text_mention: the mentioned user */
  user?: TgUser
}

export interface TgPhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export interface TgDocument {
  file_id: string
  file_unique_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface TgMediaFile {
  file_id: string
  file_unique_id: string
  duration: number
  mime_type?: string
}

export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  date: number
  text?: string
  entities?: TgMessageEntity[]
  caption?: string
  caption_entities?: TgMessageEntity[]
  photo?: TgPhotoSize[]
  document?: TgDocument
  voice?: TgMediaFile
  video?: TgMediaFile
  sticker?: { file_id: string; file_unique_id: string; emoji?: string }
  audio?: TgMediaFile
  location?: { latitude: number; longitude: number }
  new_chat_members?: TgUser[]
  left_chat_member?: TgUser
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  edited_message?: TgMessage
}

export interface TgFile {
  file_id: string
  file_unique_id: string
  file_size?: number
  file_path?: string
}

export interface TgChatMember {
  user: TgUser
  status: string
}

/** Telegram Bot API 响应信封 */
export interface TgApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
  /** Telegram 在 429 / 5xx 时返回的退避建议（秒） */
  parameters?: {
    retry_after?: number
    migrate_to_chat_id?: number
  }
}

// ============================================================================
// TelegramClient 选项
// ============================================================================

export interface TgSendOptions {
  reply_to_message_id?: number
  parse_mode?: 'HTML' | 'Markdown'
}

// ============================================================================
// Crabot Channel 协议类型（对齐 protocol-channel.md + base-protocol.md）
// ============================================================================

export type MessageType = 'text' | 'image' | 'file'
export type SessionType = 'private' | 'group'
export type ChannelFeature = 'mention' | 'quote' | 'reaction' | 'thread'

export interface MessageContent {
  type: MessageType
  text?: string
  media_url?: string
  file_path?: string
  filename?: string
  mime_type?: string
  size?: number
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

export interface MessageFeatures {
  mentions?: Array<{ friend_id: string; platform_user_id: string }>
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

export interface SendMessageParams {
  session_id: SessionId
  content: MessageContent
  features?: {
    mentions?: string[]
    quote_message_id?: string
    thread_id?: string | number
    reply_to_message_id?: string
    native_channel_id?: string
  }
}

export interface SendMessageResult {
  platform_message_id: string
  sent_at: string
}

export interface PaginationParams {
  page: number
  page_size: number
}

export interface GetSessionsParams {
  type?: SessionType
  pagination?: PaginationParams
}

export interface GetSessionParams {
  session_id: SessionId
}

export interface FindOrCreatePrivateSessionParams {
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

// ============================================================================
// MessageStore 存储格式
// ============================================================================

export interface StoredMessage {
  platform_message_id: string
  direction: 'inbound' | 'outbound'
  sender_platform_user_id: string
  sender_name: string
  content_type: MessageType
  text: string
  media_url?: string
  mime_type?: string
  filename?: string
  timestamp: string
}

// ============================================================================
// 模块配置
// ============================================================================

export interface TelegramChannelConfig {
  bot_token: string
  mode: 'polling' | 'webhook'
  webhook_url?: string
  webhook_secret?: string
}

export interface TelegramCacheConfig {
  max_days: number
  max_messages_per_session: number
}
