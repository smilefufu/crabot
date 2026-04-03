import type { ToolDefinition, ToolPermissionConfig, PermissionDecision } from './types'

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

  // denyList
  if (isInList) {
    return {
      allowed: false,
      reason: `Tool '${toolName}' is in the deny list`,
    }
  }

  // Not in deny list, but check if dangerous
  if (tool.permissionLevel === 'dangerous') {
    return {
      allowed: false,
      reason: `Tool '${toolName}' is marked as dangerous and requires explicit permission`,
    }
  }

  return { allowed: true }
}
