import type { ModuleId, SessionId, FriendId } from 'crabot-shared'
import type { ResolvedPermissions } from '../types.js'

/** protocol-admin §3.2.8; framework input, never a model-selected authority. */
export interface ConversationRequestSource {
  source_id: string
  channel_id: ModuleId
  session_id: SessionId
  session_type: 'group'
  platform_message_id: string
  platform_user_id: string
  sender_friend_id: FriendId | null
}
export interface RequestPermissionSource {
  kind: 'group' | 'friend'
  subject_id: string
  is_master: boolean
  resolved: ResolvedPermissions
}
export interface ResolveRequestPermissionSourcesParams { source: ConversationRequestSource }
export interface ResolveRequestPermissionSourcesResult {
  group: RequestPermissionSource
  friend: RequestPermissionSource | null
}
