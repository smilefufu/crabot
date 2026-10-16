import type { ConversationRequestSource } from 'crabot-shared'
export type { ConversationRequestSource } from 'crabot-shared'
import { isResolvedPermissionsSnapshot } from '../workers/harness/context-store.js'
import type { ResolvedPermissions } from '../types.js'

/** protocol-admin §3.2.8; framework input, never a model-selected authority. */
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

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}
export function matchesRequestPermissionSource(value: unknown, kind: RequestPermissionSource['kind'], subject: string | null): value is RequestPermissionSource {
  return exact(value, ['kind', 'subject_id', 'is_master', 'resolved']) && value.kind === kind && !!subject && value.subject_id === subject
    && typeof value.is_master === 'boolean' && (kind !== 'group' || !value.is_master) && isResolvedPermissionsSnapshot(value.resolved)
}
/** Validates whole, separate sources without changing or combining permission snapshots. */
export function assertRequestPermissionSources(origin: ConversationRequestSource, value: unknown): asserts value is ResolveRequestPermissionSourcesResult {
  if (!exact(value, ['group', 'friend']) || origin.session_type !== 'group'
    || !matchesRequestPermissionSource(value.group, 'group', `${origin.channel_id}::${origin.session_id}`)
    || value.friend !== null && !matchesRequestPermissionSource(value.friend, 'friend', origin.sender_friend_id)) throw new Error('Invalid request permission sources')
}

export interface ResolveRequestPermissionSourceParams {
  source: ConversationRequestSource
  kind: 'group' | 'friend'
}
export interface ResolveRequestPermissionSourceResult {
  source: RequestPermissionSource | null
}
