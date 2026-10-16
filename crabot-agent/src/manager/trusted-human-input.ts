import type { ChannelMessage, FriendId } from '../types.js'
import type { ManagerKey } from './types.js'

/** protocol-agent-v3: immutable received input, never an authorization credential. */
export interface TrustedHumanInput {
  source_id: string
  manager_key: ManagerKey
  sequence: number
  received_at: string
  identity_status: 'friend' | 'stranger' | 'unresolved'
  sender_friend_id: FriendId | null
  message: ChannelMessage
}
