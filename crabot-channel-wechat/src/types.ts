/**
 * crabot-channel-wechat 类型定义
 *
 * 对齐：
 * - wechat-connector BOT_INTEGRATION.md 的 WechatRawEvent
 * - crabot base-protocol.md §5.3-5.5 的 Session / ChannelMessage
 * - crabot protocol-channel.md §3 的 Channel 接口
 */

import type { ModuleId, SessionId } from 'crabot-shared'

export type { ModuleId, SessionId }

// ============================================================================
// wechat-connector 推送的事件结构（BOT_INTEGRATION.md）
// ============================================================================

export interface WechatRawEvent {
  eventId: string
  timestamp: number

  puppet: {
    puppetId: string
    wxid: string
    nickname: string
  }

  message: {
    id: string
    msgSvrId: string | null
    type: number
    createTime: string
    content: Record<string, unknown>
  }

  sender: {
    wxid: string
    name: string
  }

  conversation: {
    id: string
    name: string
    isGroup: boolean
  }
}

/**
 * Webhook 信封（wechat-connector 推送给 Bot 的外层结构）
 */
export interface WebhookEnvelope {
  event_type: 'wechat_message'
  data: WechatRawEvent
  timestamp: number
  signature: string
}

// ============================================================================
// Crabot Channel 协议类型（对齐 crabot-docs/protocols/protocol-channel.md）
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
  /** 惰性媒体下载句柄（非图片文件 status=not_fetched 时携带，传给 fetch_media RPC） */
  handle?: string
  /** 媒体就绪状态：ready / not_fetched / fetching / failed */
  status?: 'ready' | 'not_fetched' | 'fetching' | 'failed'
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
  /** 是否支持 list_contacts */
  supports_list_contacts: boolean
  /** 是否支持 list_groups */
  supports_list_groups: boolean
  /** 是否支持 list_group_members */
  supports_list_group_members: boolean
  /** 是否支持 fetch_media（按需拉取媒体文件） */
  supports_media_fetch?: boolean
}

export interface FetchMediaParams {
  handle: string
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

export interface HistoryMessage {
  platform_message_id: string
  sender_name: string
  sender_platform_user_id?: string
  content: string
  content_type: MessageType
  timestamp: string
}

// ============================================================================
// wechat-connector REST API 响应
// ============================================================================

export interface ApiResponse<T = unknown> {
  code: number
  data: T
  message?: string
}

// ============================================================================
// 模块配置
// ============================================================================

export interface WechatChannelConfig {
  /** wechat-connector 服务器地址 */
  connector_url: string
  /** Bot API Key */
  api_key: string
  /** Webhook 签名密钥（Webhook 模式需要） */
  webhook_secret?: string
  /** 推送模式 */
  mode: 'socketio' | 'webhook'
  /** Webhook 模式下本地监听端口 */
  webhook_port?: number
}

// ============================================================================
// List Contacts / List Groups 接口
// ============================================================================

export interface ListContactsParams {
  search?: string
  pagination?: PaginationParams
}

export interface ContactItem {
  platform_user_id: string
  display_name: string
  remark?: string
  avatar_url?: string
}

export interface ListContactsResult {
  items: ContactItem[]
  pagination: {
    page: number
    page_size: number
    total_items: number
    total_pages: number
  }
}

export interface ListGroupsParams {
  search?: string
  pagination?: PaginationParams
}

export interface GroupItem {
  platform_session_id: string
  group_name: string
  member_count?: number
}

export interface ListGroupsResult {
  items: GroupItem[]
  pagination: {
    page: number
    page_size: number
    total_items: number
    total_pages: number
  }
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
