import { isDeepStrictEqual } from 'node:util'
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

/** Host-only projection: a filtered message batch cannot retain other source references. */
export function requestInputsForMessages(key: ManagerKey, messages: ReadonlyArray<ChannelMessage>, inputs: ReadonlyArray<TrustedHumanInput> = []): TrustedHumanInput[] {
  const wire = (message: ChannelMessage): unknown => {
    const { task_id, sender: { friend_id, ...sender }, ...rest } = message
    return JSON.parse(JSON.stringify({ ...rest, sender }))
  }
  return inputs.filter(input => input.manager_key === key && input.message.session.type === 'group'
    && messages.some(message => isDeepStrictEqual(wire(message), wire(input.message))))
}
