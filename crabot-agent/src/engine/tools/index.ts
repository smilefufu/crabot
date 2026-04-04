import { createBashTool } from './bash-tool'
import { createReadTool } from './read-tool'
import { createWriteTool } from './write-tool'
import { createEditTool } from './edit-tool'
import { createGlobTool } from './glob-tool'
import { createGrepTool } from './grep-tool'
import { createSkillTool } from './skill-tool'
import type { ToolDefinition, ToolPermissionLevel } from '../types'
import type { BuiltinToolConfig } from '../../types.js'

export interface BuiltinToolsOptions {
  readonly skillsDir?: string
}

function buildBaseTools(cwd: string, bashTimeout?: number, skillsDir?: string): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createBashTool(cwd, bashTimeout),
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createGlobTool(cwd),
    createGrepTool(cwd),
  ]
  if (skillsDir) {
    tools.push(createSkillTool(skillsDir))
  }
  return tools
}

export function getAllBuiltinTools(cwd: string, options?: BuiltinToolsOptions): ReadonlyArray<ToolDefinition> {
  return buildBaseTools(cwd, undefined, options?.skillsDir)
}

export function getConfiguredBuiltinTools(
  cwd: string,
  config?: BuiltinToolConfig,
  options?: BuiltinToolsOptions,
): ToolDefinition[] {
  if (!config) {
    return [...getAllBuiltinTools(cwd, options)]
  }

  const baseTools = buildBaseTools(cwd, config.bash_timeout, options?.skillsDir)

  // Filter: enabled_tools takes precedence over disabled_tools
  let filtered: ToolDefinition[]
  if (config.enabled_tools) {
    const enabledSet = new Set(config.enabled_tools)
    filtered = baseTools.filter((t) => enabledSet.has(t.name))
  } else if (config.disabled_tools) {
    const disabledSet = new Set(config.disabled_tools)
    filtered = baseTools.filter((t) => !disabledSet.has(t.name))
  } else {
    filtered = baseTools
  }

  // Apply permission_overrides (immutable: create new tool objects)
  if (config.permission_overrides) {
    const overrides = config.permission_overrides
    filtered = filtered.map((tool) => {
      const override = overrides[tool.name] as ToolPermissionLevel | undefined
      if (override) {
        return { ...tool, permissionLevel: override }
      }
      return tool
    })
  }

  return filtered
}

export {
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createSkillTool,
}
