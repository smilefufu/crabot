import fs from 'node:fs/promises'
import { EFFECTIVE_TOOL_CATEGORIES } from 'crabot-shared'
import path from 'node:path'
import { PermissionTemplateManager } from './permission-template-manager.js'
import { parseGroupSessionConfigRecord } from './group-session-config.js'
import { CLI_DOMAINS, createCliAccessConfig, type Friend, type FriendPermissionConfig, type PermissionTemplate, type ResolvedPermissions } from './types.js'

const rank = { none: 0, read: 1, write: 2 }
function coversPath(parent: string, child: string): boolean {
  if (!path.isAbsolute(parent) || !path.isAbsolute(child)) return parent === child
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
/** A read-only projection of Admin.buildResolvedFriendPermissions; regression-tested against the live resolver. */
export function impactFriendPermissions(friend: Friend, config: FriendPermissionConfig | undefined, templates: PermissionTemplateManager): ResolvedPermissions | null {
  if (friend.permission === 'master') return templates.resolvePermissions('master_private', null)
  if (config) return { tool_access: { ...config.tool_access, desktop: false }, cli_access: { ...createCliAccessConfig('none'), ...config.cli_access },
    storage: config.storage ? { ...config.storage } : null, memory_scopes: [...config.memory_scopes] }
  try { return templates.resolvePermissions(friend.permission_template_id ?? 'standard', null) }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'NOT_FOUND') return null
    throw error
  }
}
/** Potential differences only; operations still need one complete source and runtime guards. */
export function additionalRequestCapabilities(group: ResolvedPermissions, friend: ResolvedPermissions, groupId: string | null): string[] {
  const changes = EFFECTIVE_TOOL_CATEGORIES.filter(key => friend.tool_access[key] && !group.tool_access[key]).map(key => `tool:${key}`)
  if (friend.tool_access.shell) for (const key of CLI_DOMAINS) {
    if (rank[friend.cli_access[key]] > (group.tool_access.shell ? rank[group.cli_access[key]] : 0)) changes.push(`cli:${key}:${friend.cli_access[key]}`)
  }
  if (friend.tool_access.file_io && friend.storage && (!group.tool_access.file_io || !group.storage
    || !coversPath(group.storage.workspace_path, friend.storage.workspace_path)
    || friend.storage.access === 'readwrite' && group.storage.access !== 'readwrite')) changes.push(`storage:${friend.storage.access}:${friend.storage.workspace_path}`)
  if (friend.tool_access.memory && group.tool_access.memory) {
    const scopes = group.memory_scopes.length ? group.memory_scopes : groupId ? [groupId] : []
    if (!friend.memory_scopes.length || !groupId && !group.memory_scopes.length || friend.memory_scopes.some(scope => !scopes.includes(scope))) changes.push('memory:additional_query_scope')
  }
  return changes
}
async function arrayFile<T>(filename: string): Promise<T[]> {
  let raw: string
  try { raw = await fs.readFile(filename, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const data = JSON.parse(raw)
  if (!Array.isArray(data)) throw new Error(`Invalid permission input: ${path.basename(filename)}`)
  return data
}

/** Offline: no Channel/LLM calls, no chat body reads, no writes. Unknown facts stay explicit. */
export async function buildSharedRequestImpact(dataRoot: string) {
  const admin = path.join(dataRoot, 'admin'), templates = new PermissionTemplateManager()
  templates.loadFromArray(await arrayFile<PermissionTemplate>(path.join(admin, 'templates.json')))
  templates.initSystemTemplates()
  const friends = await arrayFile<Friend>(path.join(admin, 'friends.json'))
  const configs = new Map((await arrayFile<{ friend_id: string; config: FriendPermissionConfig }>(path.join(admin, 'friend-permission-configs.json'))).map(item => [item.friend_id, item.config]))
  const unknown: string[] = [], groups = new Map<string, NonNullable<ReturnType<typeof parseGroupSessionConfigRecord>>>()
  for (const raw of await arrayFile<unknown>(path.join(admin, 'session-configs.json'))) {
    const group = parseGroupSessionConfigRecord(raw)
    if (!group) { unknown.push('unverified_or_invalid_group_config'); continue }
    groups.set(JSON.stringify([group.channel_id, group.session_id]), group)
  }
  let bindings: { bindings: Array<{ kind: string; manager_key: string }> } = { bindings: [] }
  try { bindings = JSON.parse(await fs.readFile(path.join(dataRoot, 'agent', 'manager-principal-bindings.json'), 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (!Array.isArray(bindings.bindings)) throw new Error('Invalid principal bindings')
  for (const binding of bindings.bindings) if (binding.kind === 'group') {
    const i = binding.manager_key.indexOf('::')
    if (i < 1 || i + 2 === binding.manager_key.length) throw new Error('Invalid group binding')
    const channel = binding.manager_key.slice(0, i), id = binding.manager_key.slice(i + 2), key = JSON.stringify([channel, id])
    if (!groups.has(key)) groups.set(key, { channel_id: channel, session_id: id, config: { updated_at: new Date().toISOString() } })
  }
  const channels = new Set(friends.flatMap(friend => friend.channel_identities.map(identity => identity.channel_id)))
  const targets = [...groups.values()].map(group => ({ channel_id: group.channel_id, session_id: group.session_id as string | null, config: group.config }))
  for (const channel of channels) targets.push({ channel_id: channel, session_id: null, config: { updated_at: new Date().toISOString() } })
  const entries: Array<{ channel_id: string; session_id: string | null; friend_id: string; is_master: boolean; additional_capabilities: string[] }> = []
  for (const target of targets) {
    let group: ResolvedPermissions
    try { group = templates.resolveGroupPermissions(target.config.template_id ?? 'group_default', target.config) }
    catch { group = templates.resolvePermissions('minimal'); unknown.push(`missing_group_template:${target.channel_id}:${target.session_id ?? 'default'}`) }
    for (const friend of friends.filter(friend => friend.channel_identities.some(identity => identity.channel_id === target.channel_id))) {
      const personal = impactFriendPermissions(friend, configs.get(friend.id), templates)
      if (!personal) { unknown.push(`unavailable_friend_permissions:${friend.id}`); continue }
      const additions = additionalRequestCapabilities(group, personal, target.session_id)
      if (friend.permission === 'master') additions.push('master:verified_request')
      if (additions.length) entries.push({ channel_id: target.channel_id, session_id: target.session_id, friend_id: friend.id, is_master: friend.permission === 'master', additional_capabilities: additions })
    }
  }
  return { schema_version: 1, generated_at: new Date().toISOString(), scope: 'all_ordinary_groups', membership: 'same_channel_candidates_only',
    default_group_rules_included: true, unknown: [...new Set(unknown)], entries }
}
