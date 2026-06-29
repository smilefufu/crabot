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
import { createSetCwdTool } from './set-cwd-tool'
import type { SetCwdContext } from './set-cwd-tool'
import type { BgToolDeps } from './output-tool'
import type { ToolDefinition, ToolPermissionLevel } from '../types'
import type { BuiltinToolConfig, SkillConfig } from '../../types.js'

export type { BashBgContext }
export type { BgToolDeps }
export type { SetCwdContext }

export interface BuiltinToolsOptions {
  /**
   * 可用 skill 列表（含 skill_dir 绝对路径）。提供且非空时注册 Skill 工具。
   * agent 子进程同主机直接 fs.read 这些路径，无需复制到 instance 目录。
   */
  readonly availableSkills?: ReadonlyArray<SkillConfig>
  /** Optional bg-entities deps. 提供时 Bash 支持超 10s 自动转后台；不提供时只能跑同步前台 */
  readonly bgEntityCtx?: BashBgContext
  /** Optional bg-tool deps (Output / Kill / ListEntities). 提供时注册这三个工具 */
  readonly bgToolDeps?: BgToolDeps
  /** 仅 main worker 提供；subagent 不传则 set_cwd 工具不注册。 */
  readonly setCwdCtx?: SetCwdContext
}

function buildBaseTools(
  getCwd: () => string,
  bashTimeout?: number,
  availableSkills?: ReadonlyArray<SkillConfig>,
  bgCtx?: BashBgContext,
  bgToolDeps?: BgToolDeps,
  setCwdCtx?: SetCwdContext,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createBashTool(getCwd, bashTimeout, bgCtx),
    createReadTool(getCwd),
    createWriteTool(getCwd),
    createEditTool(getCwd),
    createGlobTool(getCwd),
    createGrepTool(getCwd),
  ]
  if (availableSkills && availableSkills.length > 0) {
    tools.push(createSkillTool({ availableSkills }))
  }
  if (bgToolDeps) {
    tools.push(createOutputTool(bgToolDeps))
    tools.push(createKillTool(bgToolDeps))
    tools.push(createListEntitiesTool(bgToolDeps))
  }
  if (setCwdCtx) {
    tools.push(createSetCwdTool(setCwdCtx))
  }
  return tools
}

export function getAllBuiltinTools(getCwd: () => string, options?: BuiltinToolsOptions): ReadonlyArray<ToolDefinition> {
  return buildBaseTools(getCwd, undefined, options?.availableSkills, options?.bgEntityCtx, options?.bgToolDeps, options?.setCwdCtx)
}

export function getConfiguredBuiltinTools(
  getCwd: () => string,
  config?: BuiltinToolConfig,
  options?: BuiltinToolsOptions,
): ToolDefinition[] {
  if (!config) {
    return [...getAllBuiltinTools(getCwd, options)]
  }

  const baseTools = buildBaseTools(getCwd, config.bash_timeout, options?.availableSkills, options?.bgEntityCtx, options?.bgToolDeps, options?.setCwdCtx)

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
  createSetCwdTool,
}
