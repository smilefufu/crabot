import { PermissionTemplateManager } from './permission-template-manager.js'
import { parseFriendPermissionRecords, type FriendPermissionRecord } from './friend-permission-store.js'
import { groupSessionConfigKey, parseGroupSessionConfigRecord, type GroupSessionConfigRecord } from './group-session-config.js'
import type { Friend, PermissionTemplate } from './types.js'

/** Pure metadata conversion. Callers own stopped-state proof, input binding and scoped recovery. */
export function planLegacyDirectoryPermissions(input: { friends: unknown; templates: unknown; friendConfigs: unknown; groups: unknown; bindings: unknown }, now: string) {
  if (!Array.isArray(input.friends) || !Array.isArray(input.templates) || !Array.isArray(input.groups)
    || !input.bindings || typeof input.bindings !== 'object' || !Array.isArray((input.bindings as { bindings?: unknown }).bindings)) throw new Error('Invalid legacy permission metadata')
  const templates = new PermissionTemplateManager()
  templates.loadFromArray(input.templates as PermissionTemplate[]); templates.initSystemTemplates()
  const friends = parseFriendPermissionRecords(input.friendConfigs), configs = new Map(friends.map(record => [record.friend_id, record]))
  const groups: unknown[] = structuredClone(input.groups), groupMap = new Map<string, GroupSessionConfigRecord>()
  let convertedFriends = 0, convertedGroups = 0, unknown = 0
  const friendIds = new Set<string>(), isolatedSessions = new Set<string>()
  for (const raw of groups) {
    const parsed = parseGroupSessionConfigRecord(raw)
    if (!parsed) { unknown++; if (raw && typeof raw === 'object' && 'session_id' in raw && typeof raw.session_id === 'string') isolatedSessions.add(raw.session_id); continue }
    const key = groupSessionConfigKey(parsed.channel_id, parsed.session_id)
    if (groupMap.has(key)) throw new Error('Duplicate legacy group permission identity')
    groupMap.set(key, raw as GroupSessionConfigRecord)
  }
  for (const raw of input.friends) {
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim() || !['normal', 'master'].includes(raw.permission)) { unknown++; continue }
    const friend = raw as Friend
    if (friendIds.has(friend.id)) throw new Error('Duplicate legacy friend identity')
    friendIds.add(friend.id)
    if (friend.permission === 'master') continue
    const record = configs.get(friend.id)
    if (record?.storage_override) continue
    let storage
    try { storage = record?.config ? record.config.storage ?? null : templates.resolvePermissions(friend.permission_template_id ?? 'standard').storage }
    catch { unknown++; continue }
    if (storage !== null) continue
    const next: FriendPermissionRecord = record?.config
      ? { friend_id: friend.id, config: { ...record.config, storage: { scope: 'all', access: 'readwrite' }, updated_at: now } }
      : { friend_id: friend.id, storage_override: { scope: 'all', access: 'readwrite' } }
    configs.set(friend.id, next); convertedFriends++
  }
  for (const binding of (input.bindings as { bindings: Array<Record<string, unknown>> }).bindings) {
    if (binding?.kind !== 'group') continue
    if (typeof binding.manager_key !== 'string' || binding.manager_key === 'admin-web::admin-chat' || !/^[^:]+::.+$/.test(binding.manager_key)
      || !Number.isSafeInteger(binding.generation) || (binding.generation as number) < 1
      || Object.keys(binding).some(key => !['manager_key', 'kind', 'generation'].includes(key))) { unknown++; continue }
    const separator = binding.manager_key.indexOf('::'), channel_id = binding.manager_key.slice(0, separator), session_id = binding.manager_key.slice(separator + 2)
    const key = groupSessionConfigKey(channel_id, session_id)
    if (!groupMap.has(key) && !isolatedSessions.has(session_id)) {
      const record = { channel_id, session_id, config: { updated_at: now } }
      groupMap.set(key, record); groups.push(record)
    }
  }
  for (const record of groupMap.values()) {
    let storage
    try { storage = templates.resolveGroupPermissions(record.config.template_id ?? 'group_default', record.config).storage }
    catch { unknown++; continue }
    if (storage !== null) continue
    record.config = { ...record.config, storage: { scope: 'all', access: 'readwrite' }, updated_at: now }; convertedGroups++
  }
  return { friendConfigs: [...configs.values()], groups, report: { converted_friends: convertedFriends, converted_groups: convertedGroups, unknown_objects: unknown } }
}
