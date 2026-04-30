/**
 * crabot-channel-feishu 类型定义
 *
 * 对齐：
 * - crabot base-protocol.md §5.3-5.5 的 Session / ChannelMessage
 * - crabot protocol-channel.md §3 的 Channel 接口
 * - 飞书开放平台 IM 消息事件 schema（@larksuiteoapi/node-sdk 派生子集）
 */

import type { ModuleId, SessionId } from 'crabot-shared'

export type { ModuleId, SessionId }

// ============================================================================
// Crabot Channel 协议类型
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
  /** 飞书 open_id */
  platform_user_id: string
  role: 'owner' | 'admin' | 'member'
}

export interface Session {
  id: SessionId
  channel_id: ModuleId
  type: SessionType
  /** 飞书 chat_id（群聊）或 open_id（私聊） */
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
  extensions?: ChannelExtensionTool[]
}

export interface SendMessageFeatures {
  /** @ 提及的熟人列表（friend_id），由 channel 解析为飞书 open_id */
  mentions?: string[]
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
  /** 飞书 open_id */
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

// ============================================================================
// 飞书事件类型子集
//
// 用最小子集声明事件，避免依赖 lark.EventDispatcher 内部类型，并方便单测构造。
// ============================================================================

export type FeishuChatType = 'p2p' | 'group'

export interface FeishuMention {
  key: string
  id: { open_id?: string; user_id?: string; union_id?: string }
  name: string
  tenant_key?: string
}

export interface FeishuMessageReceiveSender {
  sender_id?: { open_id?: string; user_id?: string; union_id?: string }
  sender_type?: 'user' | 'app'
  tenant_key?: string
}

export interface FeishuMessageReceiveMessage {
  message_id: string
  root_id?: string
  parent_id?: string
  create_time: string
  chat_id: string
  chat_type: FeishuChatType
  message_type: string
  content: string
  mentions?: FeishuMention[]
}

/** im.message.receive_v1 整体事件结构 */
export interface FeishuMessageReceivedEvent {
  sender: FeishuMessageReceiveSender
  message: FeishuMessageReceiveMessage
}

/** im.chat.member.bot.added_v1 / deleted_v1 事件 */
export interface FeishuChatMemberBotEvent {
  chat_id: string
  operator_id?: { open_id?: string; user_id?: string }
  external?: boolean
  /** added_v1 携带 chat name */
  name?: string
  /** added_v1 携带 chat 类型 */
  type?: 'p2p' | 'group'
}

/** im.chat.member.user.added_v1 / deleted_v1 事件 */
export interface FeishuChatMemberUserEvent {
  chat_id: string
  operator_id?: { open_id?: string }
  external?: boolean
  users?: Array<{
    user_id: { open_id?: string; user_id?: string; union_id?: string }
    name?: string
    tenant_key?: string
  }>
}

/** im.chat.updated_v1 事件 */
export interface FeishuChatUpdatedEvent {
  chat_id: string
  operator_id?: { open_id?: string }
  external?: boolean
  after_change?: {
    name?: string
    description?: string
    avatar?: string
  }
}

// ============================================================================
// 模块配置
// ============================================================================

export type FeishuDomain = 'feishu' | 'lark'

export interface FeishuCacheConfig {
  /** 缓存最近 N 天消息 */
  max_days: number
  /** 每个 session 缓存最多 N 条 */
  max_messages_per_session: number
}

export interface FeishuChannelConfig {
  app_id: string
  app_secret: string
  domain: FeishuDomain
  /** 拥有者 open_id（扫码绑定时记录，用于默认 allowFrom） */
  owner_open_id?: string
  only_respond_to_mentions: boolean
}
