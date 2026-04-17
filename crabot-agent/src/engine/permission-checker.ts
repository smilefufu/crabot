import type { ToolDefinition, ToolPermissionConfig, PermissionDecision } from './types'

/**
 * Pre-filter tools before injecting them to the LLM.
 * Tools in the deny list (or outside an allow list) are dropped so the LLM
 * never sees them. Unused when checkPermission callback is set (dynamic decisions
 * can't be evaluated statically) or when mode is bypass.
 */
export function filterToolsByPermission<T extends ToolDefinition>(
  tools: ReadonlyArray<T>,
  config?: ToolPermissionConfig,
): T[] {
  if (!config || config.mode === 'bypass' || config.checkPermission) {
    return [...tools]
  }
  const names = new Set(config.toolNames ?? [])
  if (config.mode === 'allowList') {
    return tools.filter(t => names.has(t.name))
  }
  return tools.filter(t => !names.has(t.name))
}

/**
 * Check whether a tool call is permitted under the given permission config.
 *
 * Logic:
 * 1. If config has checkPermission callback → delegate to it (overrides static checks)
 * 2. No config or mode='bypass' → allowed (unless tool is dangerous with no config)
 * 3. mode='allowList' → allowed only if toolName in toolNames
 * 4. mode='denyList' → allowed unless toolName in toolNames
 * 5. If tool.permissionLevel='dangerous' and no explicit permission → denied
 */
export async function checkToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  tool: ToolDefinition,
  config?: ToolPermissionConfig,
): Promise<PermissionDecision> {
  // If callback exists, it overrides all static checks
  if (config?.checkPermission !== undefined) {
    return config.checkPermission(toolName, input)
  }

  // No config → check dangerous tools, otherwise allow
  if (config === undefined) {
    if (tool.permissionLevel === 'dangerous') {
      return {
        allowed: false,
        reason: `Tool '${toolName}' is marked as dangerous and requires explicit permission`,
      }
    }
    return { allowed: true }
  }

  // Bypass mode → always allowed
  if (config.mode === 'bypass') {
    return { allowed: true }
  }

  const toolNames = config.toolNames ?? []
  const isInList = toolNames.includes(toolName)

  if (config.mode === 'allowList') {
    if (isInList) {
      return { allowed: true }
    }
    return {
      allowed: false,
      reason: `Tool '${toolName}' is not in the allow list`,
    }
  }

  // denyList: 用户已明确声明禁用清单，视为已接管权限决策；
  // dangerous 的默认保护只在"无 config"场景生效，此处不再叠加。
  if (isInList) {
    return {
      allowed: false,
      reason: `Tool '${toolName}' is in the deny list`,
    }
  }

  return { allowed: true }
}
