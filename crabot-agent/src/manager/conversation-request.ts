import type { FriendId } from '../types.js'
import type { ManagerKey } from './types.js'
import type { ResolveRequestPermissionSourcesResult } from './request-permission-sources.js'

/** protocol-agent-v3: fixed request facts; IDs locate records, they never grant authority. */
export interface ConversationRequestDelivery {
  kind: 'origin' | 'requester_private'
  requester_friend_id: FriendId | null
}
export interface ConversationRequestRecord {
  schema_version: 1
  request_id: string
  manager_key: ManagerKey
  source_id: string
  source_sha256: string
  selection: { start: number; end: number }
  created_at: string
  permission_sources: ResolveRequestPermissionSourcesResult
  delivery: ConversationRequestDelivery
  worker_ids: string[]
  status: 'open' | 'closed'
}

export interface ConversationRequestBinding {
  schema_version: 1
  request_id: string
  source_sha256: string
  execution_scope: 'group' | 'request'
}
