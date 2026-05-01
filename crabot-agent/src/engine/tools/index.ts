import { createBashTool } from './bash-tool'
import type { BashBgContext } from './bash-tool'
import { createReadTool } from './read-tool'
import { createWriteTool } from './write-tool'
import { createEditTool } from './edit-tool'
import { createGlobTool } from './glob-tool'
import { createGrepTool } from './grep-tool'
import { createSkillTool } from './skill-tool'
import { createOutputTool } from './output-tool'
import { createKillTool } from './kill-tool'
import { createListEntitiesTool } from './list-entities-tool'
import type { BgToolDeps } from './output-tool'
import type { ToolDefinition, ToolPermissionLevel } from '../types'
import type { BuiltinToolConfig } from '../../types.js'

export type { BashBgContext }
export type { BgToolDeps }

export interface BuiltinToolsOptions {
  /** Absolute path to the skills directory (typically ${DATA_DIR}/agent/instance/skills/) */
  readonly skillsDir?: string
  /** Optional bg-entities deps. 提供时 Bash 支持 run_in_background；不提供时只能跑同步前台 */
  readonly bgEntityCtx?: BashBgContext
  /** Optional bg-tool deps (Output / Kill / ListEntities). 提供时注册这三个工具 */
  readonly bgToolDeps?: BgToolDeps
}

function buildBaseTools(
  cwd: string,
  bashTimeout?: number,
  skillsDir?: string,
  bgCtx?: BashBgContext,
  bgToolDeps?: BgToolDeps,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createBashTool(cwd, bashTimeout, bgCtx),
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createGlobTool(cwd),
    createGrepTool(cwd),
  ]
  if (skillsDir) {
    tools.push(createSkillTool(skillsDir))
  }
  if (bgToolDeps) {
    tools.push(createOutputTool(bgToolDeps))
    tools.push(createKillTool(bgToolDeps))
    tools.push(createListEntitiesTool(bgToolDeps))
  }
  return tools
}

export function getAllBuiltinTools(cwd: string, options?: BuiltinToolsOptions): ReadonlyArray<ToolDefinition> {
  return buildBaseTools(cwd, undefined, options?.skillsDir, options?.bgEntityCtx, options?.bgToolDeps)
}

export function getConfiguredBuiltinTools(
  cwd: string,
  config?: BuiltinToolConfig,
  options?: BuiltinToolsOptions,
): ToolDefinition[] {
  if (!config) {
    return [...getAllBuiltinTools(cwd, options)]
  }

  const baseTools = buildBaseTools(cwd, config.bash_timeout, options?.skillsDir, options?.bgEntityCtx, options?.bgToolDeps)

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
  createOutputTool,
  createKillTool,
  createListEntitiesTool,
}
