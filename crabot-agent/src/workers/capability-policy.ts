import path from 'node:path'
import type { MCPServerConfig, ResolvedPermissions, SkillConfig } from '../types.js'
import { filterMcpServersForWorker } from '../agent/mcp-connector.js'
import type { CapabilityBundle, WorkerImplId } from './types.js'

export const CRABOT_BUILTIN_SKILL_NAMES: ReadonlySet<string> = new Set([
  'tmp-page',
  'scrapling-official',
  'workspace-context-maintenance',
  'writing-plans',
  'systematic-debugging',
  'verification-before-completion',
  'memory-graph-linking',
  'crabot-cli',
])

export const REQUIRED_MAINLINE_WORKER_SKILL_NAMES = [
  'tmp-page',
  'workspace-context-maintenance',
] as const

export const NON_AGENT_CRABOT_SKILL_NAMES: ReadonlySet<string> = new Set([
  'memory-graph-linking',
  'crabot-cli',
])

/** Remove Crabot-internal workflows that are not an Agent Skill from a catalog. */
export function filterNonAgentCrabotSkills(
  skills: ReadonlyArray<SkillConfig>,
): SkillConfig[] {
  return skills.filter((skill) => !NON_AGENT_CRABOT_SKILL_NAMES.has(skill.name))
}

export const MAINLINE_ONLY_CRABOT_SKILL_NAMES: ReadonlySet<string> = new Set([
  'tmp-page',
  'workspace-context-maintenance',
])

export const DIRECT_CHILD_BUILTIN_SKILL_NAMES: ReadonlySet<string> = new Set([
  'writing-plans',
  'systematic-debugging',
  'verification-before-completion',
])

export const TMP_PAGE_MCP_SERVER_NAME = 'crabot-tmp-page'

export const TMP_PAGE_BRIDGE_ENV = {
  dataDir: 'CRABOT_TMP_PAGE_BRIDGE_DATA_DIR',
  baseUrl: 'CRABOT_TMP_PAGE_BRIDGE_BASE_URL',
  workerId: 'CRABOT_TMP_PAGE_BRIDGE_WORKER_ID',
  port: 'CRABOT_TMP_PAGE_BRIDGE_PORT',
} as const

export interface TmpPageBridgeLaunch {
  readonly command: string
  readonly args: readonly string[]
  readonly dataDir: string
  readonly baseUrl: string
  readonly port: number
}

export interface WorkerCapabilityPolicyInput {
  readonly impl: WorkerImplId
  readonly workerId: string
  readonly permissions: ResolvedPermissions
  readonly skills: ReadonlyArray<SkillConfig>
  readonly mcpServers: ReadonlyArray<MCPServerConfig>
  readonly tmpPageBridge?: TmpPageBridgeLaunch
}

function assertUniqueBuiltinSkillNames(skills: ReadonlyArray<SkillConfig>): void {
  const seen = new Set<string>()
  for (const skill of skills) {
    if (!CRABOT_BUILTIN_SKILL_NAMES.has(skill.name)) continue
    if (seen.has(skill.name)) {
      throw new Error(`worker capability policy: duplicate Crabot builtin Skill '${skill.name}'`)
    }
    seen.add(skill.name)
  }
}

export function selectMainlineWorkerSkills(
  skills: ReadonlyArray<SkillConfig>,
  availableMcpServers: ReadonlyArray<MCPServerConfig>,
  includeUserSkills: boolean,
): SkillConfig[] {
  assertUniqueBuiltinSkillNames(skills)
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  for (const name of REQUIRED_MAINLINE_WORKER_SKILL_NAMES) {
    if (!byName.has(name)) {
      throw new Error(`worker capability policy: required Crabot builtin Skill '${name}' is unavailable`)
    }
  }

  const selectedBuiltinNames = new Set<string>(REQUIRED_MAINLINE_WORKER_SKILL_NAMES)
  if (availableMcpServers.some((server) => server.name === 'scrapling')) {
    if (!byName.has('scrapling-official')) {
      throw new Error("worker capability policy: required Crabot builtin Skill 'scrapling-official' is unavailable")
    }
    selectedBuiltinNames.add('scrapling-official')
  }

  return skills.filter((skill) =>
    selectedBuiltinNames.has(skill.name)
    || (includeUserSkills && !CRABOT_BUILTIN_SKILL_NAMES.has(skill.name)))
}

export function createTmpPageMcpServerConfig(
  workerId: string,
  launch: TmpPageBridgeLaunch,
): MCPServerConfig {
  if (!workerId.trim()) throw new Error('worker capability policy: tmp-page bridge requires worker_id')
  if (!launch.command.trim() || launch.args.length === 0) {
    throw new Error('worker capability policy: tmp-page bridge launch command is unavailable')
  }
  if (!launch.dataDir.trim()) throw new Error('worker capability policy: tmp-page bridge data directory is unavailable')
  if (!path.isAbsolute(launch.dataDir)) {
    throw new Error('worker capability policy: tmp-page bridge data directory must be absolute')
  }
  if (!launch.baseUrl.trim()) throw new Error('worker capability policy: tmp-page bridge base URL is unavailable')
  let parsedBaseUrl: URL
  try {
    parsedBaseUrl = new URL(launch.baseUrl)
  } catch {
    throw new Error('worker capability policy: tmp-page bridge base URL is invalid')
  }
  if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
    throw new Error('worker capability policy: tmp-page bridge base URL must use http or https')
  }
  if (!Number.isInteger(launch.port) || launch.port < 1 || launch.port > 65_535) {
    throw new Error('worker capability policy: tmp-page bridge port is invalid')
  }

  return {
    name: TMP_PAGE_MCP_SERVER_NAME,
    transport: 'stdio',
    command: launch.command,
    args: [...launch.args],
    env: {
      [TMP_PAGE_BRIDGE_ENV.dataDir]: launch.dataDir,
      [TMP_PAGE_BRIDGE_ENV.baseUrl]: launch.baseUrl,
      [TMP_PAGE_BRIDGE_ENV.workerId]: workerId,
      [TMP_PAGE_BRIDGE_ENV.port]: String(launch.port),
    },
  }
}

export function buildWorkerCapabilityBundle(input: WorkerCapabilityPolicyInput): CapabilityBundle {
  if (input.mcpServers.some((server) => server.name === TMP_PAGE_MCP_SERVER_NAME)) {
    throw new Error(`worker capability policy: MCP server name '${TMP_PAGE_MCP_SERVER_NAME}' is reserved`)
  }
  const mcpServers = filterMcpServersForWorker(input.mcpServers, input.permissions)
  const skills = selectMainlineWorkerSkills(
    input.skills,
    mcpServers,
    input.permissions.tool_access.mcp_skill,
  )

  if (input.impl === 'builtin') return { skills, mcp_servers: mcpServers }
  if (!input.tmpPageBridge) {
    throw new Error(`worker capability policy: ${input.impl} requires the tmp-page stdio bridge`)
  }
  return {
    skills,
    mcp_servers: [...mcpServers, createTmpPageMcpServerConfig(input.workerId, input.tmpPageBridge)],
  }
}
