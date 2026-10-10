import type { FriendId, ModuleId, SessionId, TaskId } from './base-protocol.js'
import type { ImageQuality } from './image-fetch.js'
import type { VoiceMessageFeatures } from './voice.js'

/** Wire types from base-protocol; voice uses the ordinary group and Friend contracts. */
export type FriendPermission = 'master' | 'normal'
export interface ChannelIdentity {
  channel_id: ModuleId
  platform_user_id: string
  platform_display_name: string
}
export interface Friend {
  id: FriendId
  display_name: string
  permission: FriendPermission
  channel_identities: ChannelIdentity[]
  permission_template_id?: string
  created_at: string
  updated_at: string
}
export type SessionType = 'private' | 'group'
export type MessageType = 'text' | 'image' | 'file' | 'system_event'
export type SystemEventType = 'members_added' | 'scheduled'
export interface MediaItem {
  media_url: string
  mime_type: string
  filename?: string
  size?: number
}
export interface MessageContent {
  type: MessageType
  text?: string
  media_url?: string
  file_path?: string
  filename?: string
  mime_type?: string
  size?: number
  media?: MediaItem[]
  handle?: string
  status?: 'ready' | 'not_fetched' | 'fetching' | 'failed'
  event_type?: SystemEventType
  affected_users?: Array<{ platform_user_id: string; platform_display_name: string }>
  image_quality?: ImageQuality
}
export interface SessionRef {
  session_id: SessionId
  channel_id: ModuleId
  type: SessionType
}
export interface SenderRef {
  friend_id?: FriendId
  platform_user_id: string
  platform_display_name: string
}
export interface MentionRef {
  friend_id: FriendId
  platform_user_id: string
}
export interface MessageFeatures {
  is_mention_crab: boolean
  mentions?: MentionRef[]
  quote_message_id?: string
  reply_to_message_id?: string
  thread_id?: string
  action_callback?: { action_id: string; payload: Record<string, unknown> }
  voice?: VoiceMessageFeatures
}
export interface ChannelMessage {
  platform_message_id: string
  session: SessionRef
  sender: SenderRef
  content: MessageContent
  features: MessageFeatures
  platform_timestamp: string
  task_id?: TaskId
}
