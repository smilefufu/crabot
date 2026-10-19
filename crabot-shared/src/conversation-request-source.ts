import type { ModuleId, SessionId, FriendId } from './base-protocol.js'

/** protocol-admin §3.2.8; framework-proven original input, never a model authority claim. */
export interface ConversationRequestSource {
  source_id: string
  channel_id: ModuleId
  session_id: SessionId
  session_type: 'group'
  platform_message_id: string
  platform_user_id: string
  sender_friend_id: FriendId | null
}
