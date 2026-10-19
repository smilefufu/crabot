import { isStoragePermission } from 'crabot-shared'
import { CLI_DOMAINS, TOOL_CATEGORIES, type FriendPermissionConfig, type StoragePermission } from './types.js'

export type FriendPermissionRecord = { friend_id: string; config: FriendPermissionConfig; storage_override?: never }
  | { friend_id: string; storage_override: StoragePermission; config?: never }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function parseFriendPermissionRecords(value: unknown): FriendPermissionRecord[] {
  const invalid = () => { throw new Error('Invalid friend permission store') }
  if (!Array.isArray(value)) return invalid()
  const seen = new Set<string>()
  for (const entry of value) {
    if (!object(entry) || typeof entry.friend_id !== 'string' || !entry.friend_id.trim() || seen.has(entry.friend_id)
      || Object.keys(entry).length !== 2) return invalid()
    seen.add(entry.friend_id)
    if ('storage_override' in entry) {
      if (!entry.storage_override || !isStoragePermission(entry.storage_override)) return invalid()
    } else {
      const config = entry.config
      if (!object(config) || Object.keys(config).some(key => !['tool_access', 'cli_access', 'storage', 'memory_scopes', 'updated_at'].includes(key))
        || !object(config.tool_access) || Object.entries(config.tool_access).some(([key, enabled]) => !(TOOL_CATEGORIES as readonly string[]).includes(key) || typeof enabled !== 'boolean')
        || config.cli_access !== undefined && (!object(config.cli_access) || Object.entries(config.cli_access).some(([key, access]) => !(CLI_DOMAINS as readonly string[]).includes(key) || !['none', 'read', 'write'].includes(access as string)))
        || config.storage !== undefined && !isStoragePermission(config.storage)
        || !Array.isArray(config.memory_scopes) || config.memory_scopes.some(scope => typeof scope !== 'string')
        || typeof config.updated_at !== 'string') return invalid()
    }
  }
  return structuredClone(value) as FriendPermissionRecord[]
}
export function serializeFriendPermissionRecords(configs: ReadonlyMap<string, FriendPermissionConfig>, overrides: ReadonlyMap<string, StoragePermission>): FriendPermissionRecord[] {
  return parseFriendPermissionRecords([
    ...Array.from(configs, ([friend_id, config]) => ({ friend_id, config })),
    ...Array.from(overrides, ([friend_id, storage_override]) => ({ friend_id, storage_override })),
  ])
}
