import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isStoragePermission } from 'crabot-shared'
import { CLI_DOMAINS } from '../../types.js'
import type { ResolvedPermissions } from '../../types.js'
import type { RequestPermissionSource } from '../../manager/request-permission-sources.js'

/** Intersection within one already selected source, never a union of group and friend. */
export async function boundedRequestPermissions(ceiling: RequestPermissionSource, current: RequestPermissionSource): Promise<ResolvedPermissions> {
  if (ceiling.kind !== current.kind || ceiling.subject_id !== current.subject_id) throw new Error('Cannot combine different request permission sources')
  const before = ceiling.resolved, now = current.resolved, rank = { none: 0, read: 1, write: 2 }
  const tool_access = Object.fromEntries(Object.keys(before.tool_access).map(key => [key, before.tool_access[key as keyof typeof before.tool_access] && now.tool_access[key as keyof typeof now.tool_access]])) as unknown as ResolvedPermissions['tool_access']
  const cli_access = Object.fromEntries(CLI_DOMAINS.map(domain => [domain, rank[before.cli_access[domain]] <= rank[now.cli_access[domain]] ? before.cli_access[domain] : now.cli_access[domain]])) as ResolvedPermissions['cli_access']
  let storage: ResolvedPermissions['storage'] = null
  if (before.storage && now.storage && isStoragePermission(before.storage) && isStoragePermission(now.storage)) {
    const access = before.storage.access === 'readwrite' && now.storage.access === 'readwrite' ? 'readwrite' : 'read'
    if ('scope' in before.storage && 'scope' in now.storage) storage = { scope: 'all', access }
    else try {
      const first = 'workspace_path' in before.storage ? await fs.realpath(before.storage.workspace_path) : undefined
      const second = 'workspace_path' in now.storage ? await fs.realpath(now.storage.workspace_path) : undefined
      const inside = (parent: string, child: string) => { const relative = path.relative(parent, child); return !relative || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) }
      let root = first ?? second
      if (first && second) {
        if (inside(first, second)) root = second
        else if (!inside(second, first)) root = undefined
      }
      if (root && (await fs.stat(root)).isDirectory()) storage = { workspace_path: root, access }
    } catch { /* Unverifiable roots grant no storage scope. */ }
  }
  return { tool_access, cli_access, storage, memory_scopes: before.memory_scopes.filter(scope => now.memory_scopes.includes(scope)) }
}
