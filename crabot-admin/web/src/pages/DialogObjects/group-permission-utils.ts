import type { GroupSessionPermissionConfig } from '../../services/session'
import { CLI_DOMAINS, TOOL_CATEGORIES, type CliAccessConfig, type PermissionTemplate, type StoragePermission, type ToolAccessConfig } from '../../types'

interface GroupPermissions {
  tool_access: ToolAccessConfig
  cli_access: CliAccessConfig
  storage: StoragePermission | null
  memory_scopes: string[]
}

export function resolveGroupPermissions(sessionId: string, template: PermissionTemplate, config: GroupSessionPermissionConfig | null): GroupPermissions {
  const scopes = config?.memory_scopes ?? template.memory_scopes
  return {
    tool_access: { ...template.tool_access, ...config?.tool_access, desktop: false },
    cli_access: { ...template.cli_access, ...config?.cli_access },
    storage: config?.storage !== undefined ? config.storage : template.storage,
    memory_scopes: scopes.length > 0 ? scopes : [sessionId],
  }
}

export function buildGroupPermissionOverrides(
  sessionId: string,
  template: PermissionTemplate,
  current: GroupPermissions,
  previous: GroupSessionPermissionConfig | null,
): Omit<GroupSessionPermissionConfig, 'updated_at'> {
  const base = resolveGroupPermissions(sessionId, template, null)
  const tool_access: Partial<ToolAccessConfig> = {}
  const cli_access: Partial<CliAccessConfig> = {}
  for (const category of TOOL_CATEGORIES) {
    if (category === 'desktop') continue
    if (previous?.tool_access?.[category] !== undefined || current.tool_access[category] !== base.tool_access[category]) {
      tool_access[category] = current.tool_access[category]
    }
  }
  for (const domain of CLI_DOMAINS) {
    if (previous?.cli_access?.[domain] !== undefined || current.cli_access[domain] !== base.cli_access[domain]) {
      cli_access[domain] = current.cli_access[domain]
    }
  }
  const sameScopes = (a: string[], b: string[]) => a.length === b.length && a.every((scope, i) => scope === b[i])
  const sameStorage = current.storage?.workspace_path === base.storage?.workspace_path && current.storage?.access === base.storage?.access
  const memory_scopes = previous?.memory_scopes !== undefined && sameScopes(current.memory_scopes, resolveGroupPermissions(sessionId, template, previous).memory_scopes)
    ? previous.memory_scopes : current.memory_scopes
  return {
    template_id: template.id,
    ...(Object.keys(tool_access).length > 0 ? { tool_access } : {}),
    ...(Object.keys(cli_access).length > 0 ? { cli_access } : {}),
    ...(previous?.storage !== undefined || !sameStorage ? { storage: current.storage } : {}),
    ...(previous?.memory_scopes !== undefined || !sameScopes(current.memory_scopes, base.memory_scopes) ? { memory_scopes } : {}),
  }
}
