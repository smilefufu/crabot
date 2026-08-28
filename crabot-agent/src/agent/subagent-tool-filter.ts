/**
 * SubAgent 工具过滤器
 *
 * 把父 worker 全工具集按 BuiltinCapabilities + MCP/Skill 白名单
 * 过滤为 subagent 实际可见的工具子集。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-17-subagent-customization-and-admin-ui-design.md §3.2
 */

import type { ToolDefinition, ToolPermissionConfig } from '../engine/types.js'
import { createSkillTool } from '../engine/tools/skill-tool.js'
import type { BuiltinCapabilities, SkillConfig } from '../types.js'
import {
  DIRECT_CHILD_BUILTIN_SKILL_NAMES,
  MAINLINE_ONLY_CRABOT_SKILL_NAMES,
  NON_AGENT_CRABOT_SKILL_NAMES,
} from '../workers/capability-policy.js'

export type ToolGroup =
  | 'file_system'
  | 'shell'
  | 'task_intel'
  | 'crab_memory'
  | 'crab_messaging'
  | 'crab_image'
  | 'skill_loading'
  | 'mcp_user'
  | 'delegate_task'
  | 'unknown'

// 注意：这些名字必须与工具 ToolDefinition.name 逐字一致（含大小写）。工具改名/删除时
// 必同步这里，否则工具会落入 'unknown' 被静默剔除。subagent-tool-filter.guard.test.ts
// 会实例化真实工具核对，漂移即测试失败。
const FILE_SYSTEM_NAMES: ReadonlySet<string> = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep'])
const SHELL_NAMES: ReadonlySet<string> = new Set(['Bash', 'Output', 'Kill', 'ListEntities'])
// 任务情报工具的当前真实名字（spec 2026-06-09 §4.1）：
// - search_traces 已从 LLM 工具盘删除，查历史任务改走 find_task
// - get_task_details 已改名 get_task_progress
// - search_short_term 是 mcp__crab-memory__ 工具，归 crab_memory 组，不在此处
const TASK_INTEL_NAMES: ReadonlySet<string> = new Set(['find_task', 'get_task_progress'])

/** 仅供守卫测试核对"名字集 ↔ 真实工具名"是否漂移；运行时不用 */
export const _BUILTIN_NAME_SETS = {
  file_system: FILE_SYSTEM_NAMES,
  shell: SHELL_NAMES,
  task_intel: TASK_INTEL_NAMES,
} as const

const MCP_PREFIX = 'mcp__'

/**
 * 把工具名分类到能力组。
 * - 内置工具按 name 匹配
 * - MCP 工具按 prefix 'mcp__<server>__' 提取 server 后映射
 *   - crab-memory / crab-messaging 是 agent 内置 MCP，单独分类
 *   - 其他 server 归 mcp_user
 * - Skill / delegate_task 单独分类
 * - 未知工具归 'unknown'，filter 时一律剔除
 */
export function classifyTool(name: string): ToolGroup {
  if (name === 'Skill') return 'skill_loading'
  if (name === 'delegate_task') return 'delegate_task'
  if (FILE_SYSTEM_NAMES.has(name)) return 'file_system'
  if (SHELL_NAMES.has(name)) return 'shell'
  if (TASK_INTEL_NAMES.has(name)) return 'task_intel'

  if (name.startsWith(MCP_PREFIX)) {
    const serverId = extractMcpServerId(name)
    if (serverId === 'crab-memory') return 'crab_memory'
    if (serverId === 'crab-messaging') return 'crab_messaging'
    if (serverId === 'crab-image') return 'crab_image'
    return 'mcp_user'
  }
  return 'unknown'
}

/** 从 'mcp__<server>__<tool>' 提取 server 名 */
export function extractMcpServerId(toolName: string): string {
  if (!toolName.startsWith(MCP_PREFIX)) return ''
  const rest = toolName.slice(MCP_PREFIX.length)
  const sepIdx = rest.indexOf('__')
  return sepIdx === -1 ? rest : rest.slice(0, sepIdx)
}

/**
 * 过滤父工具集为 subagent 可见的子集。
 *
 * - 内置能力组：按 BuiltinCapabilities flag 开关
 * - 用户 MCP：按 allowedMcpServerIds 白名单过滤（空 = 全禁）
 * - Skill 加载：父 loader 永远剔除，由 buildCapabilitiesForSubAgent 按 ID 重建
 * - crab-memory：v3.6.13 起永远剔除，旧配置中的 true 不生效
 * - delegate_task：永远剔除（subagent 不能再委派下一层）
 * - unknown：永远剔除
 */
export function filterToolsForSubAgent(
  parentTools: ReadonlyArray<ToolDefinition>,
  capabilities: BuiltinCapabilities,
  allowedMcpServerIds: string[],
): ToolDefinition[] {
  return parentTools.filter((tool) => {
    const group = classifyTool(tool.name)
    switch (group) {
      case 'file_system': return capabilities.file_system
      case 'shell': return capabilities.shell
      case 'task_intel': return capabilities.task_intel
      case 'crab_memory': return false
      case 'crab_messaging': return false
      case 'crab_image': return false
      case 'skill_loading': return false
      case 'mcp_user': return allowedMcpServerIds.includes(extractMcpServerId(tool.name))
      case 'delegate_task': return false
      case 'unknown': return false
    }
  })
}

export function selectSubAgentSkills(
  availableSkills: ReadonlyArray<SkillConfig>,
  allowedSkillIds: ReadonlyArray<string>,
  allowPermissionGatedSkills = true,
): SkillConfig[] {
  if (allowedSkillIds.length === 0) return []
  const byId = new Map(availableSkills.map((skill) => [skill.id, skill]))
  const missing = allowedSkillIds.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    throw new Error(`subagent skill policy: allowed Skill unavailable: ${missing.join(', ')}`)
  }
  const selected = allowedSkillIds.map((id) => byId.get(id)!)
  const forbidden = selected
    .filter((skill) => NON_AGENT_CRABOT_SKILL_NAMES.has(skill.name))
    .map((skill) => skill.name)
  if (forbidden.length > 0) {
    throw new Error(`subagent skill policy: Skill not available to any Agent: ${forbidden.join(', ')}`)
  }
  const mainlineOnly = selected
    .filter((skill) => MAINLINE_ONLY_CRABOT_SKILL_NAMES.has(skill.name))
    .map((skill) => skill.name)
  if (mainlineOnly.length > 0) {
    throw new Error(`subagent skill policy: Skill unavailable to builtin direct child: ${mainlineOnly.join(', ')}`)
  }
  return selected.filter((skill) =>
    allowPermissionGatedSkills || DIRECT_CHILD_BUILTIN_SKILL_NAMES.has(skill.name),
  )
}

export function permissionConfigForSubAgent(
  permissionConfig: ToolPermissionConfig | undefined,
  skills: ReadonlyArray<SkillConfig>,
): ToolPermissionConfig | undefined {
  if (!permissionConfig || !skills.some((skill) => DIRECT_CHILD_BUILTIN_SKILL_NAMES.has(skill.name))) {
    return permissionConfig
  }
  if (permissionConfig.checkPermission) {
    const inheritedCheck = permissionConfig.checkPermission
    return {
      ...permissionConfig,
      checkPermission: async (toolName, input) =>
        toolName === 'Skill' ? { allowed: true } : inheritedCheck(toolName, input),
    }
  }
  if (permissionConfig.mode === 'bypass') return permissionConfig

  const toolNames = new Set(permissionConfig.toolNames ?? [])
  if (permissionConfig.mode === 'allowList') toolNames.add('Skill')
  else toolNames.delete('Skill')
  return { ...permissionConfig, toolNames: [...toolNames] }
}

export function buildCapabilitiesForSubAgent(input: {
  readonly parentTools: ReadonlyArray<ToolDefinition>
  readonly capabilities: BuiltinCapabilities
  readonly allowedMcpServerIds: string[]
  readonly allowedSkillIds: string[]
  readonly availableSkills: ReadonlyArray<SkillConfig>
  readonly getCwd?: () => string
  readonly allowPermissionGatedSkills?: boolean
}): { readonly tools: ToolDefinition[]; readonly skills: SkillConfig[] } {
  const tools = filterToolsForSubAgent(
    input.parentTools,
    input.capabilities,
    input.allowedMcpServerIds,
  )
  const skills = selectSubAgentSkills(
    input.availableSkills,
    input.allowedSkillIds,
    input.allowPermissionGatedSkills ?? input.parentTools.some((tool) => tool.name === 'Skill'),
  )
  return {
    tools: skills.length === 0
      ? tools
      : [...tools, createSkillTool({ availableSkills: skills, getCwd: input.getCwd })],
    skills,
  }
}

export function buildToolsForSubAgent(
  input: Parameters<typeof buildCapabilitiesForSubAgent>[0],
): ToolDefinition[] {
  return buildCapabilitiesForSubAgent(input).tools
}
