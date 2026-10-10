import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { ExecutionObservation } from 'crabot-shared'
import type { ToolDefinition } from '../engine/types.js'
import { assertAuthorizedTools } from './tool-authorization.js'

export function executionObservation(input: Pick<ExecutionObservation, 'role' | 'impl' | 'source'> & Partial<ExecutionObservation>): ExecutionObservation {
  return { schema_version: 1, policy_version: 1, state: 'planned', observed_at: null, revision: null,
    tools: null, child_profiles: [], mcp_servers: [], skills: [], native_tools: null, constraints: [], ...input }
}

export function requestObservation(tools: readonly ToolDefinition[], input: Pick<ExecutionObservation, 'role' | 'impl' | 'source'> & Partial<ExecutionObservation>): ExecutionObservation {
  assertAuthorizedTools(tools)
  const definitions = tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    role: tool.authorization!.role, entry: tool.authorization!.entry }))
  const mcpServers = [...new Set(tools.flatMap(tool => typeof tool.traceMetadata?.mcp_server === 'string' ? [tool.traceMetadata.mcp_server] : /^mcp__(.+?)__/.exec(tool.name)?.[1] ?? []))]
  const facts = { role: input.role, impl: input.impl, definitions, child_profiles: input.child_profiles ?? [],
    skills: input.skills ?? [], constraints: input.constraints ?? [], mcp_servers: mcpServers }
  return executionObservation({ ...input, state: 'assembled', observed_at: new Date().toISOString(),
    revision: createHash('sha256').update(JSON.stringify({ policy_version: 1, ...facts })).digest('hex'),
    tools: tools.map(tool => tool.name),
    mcp_servers: mcpServers,
  })
}

function safeId(value: string): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || value.includes('\0')) throw new Error('Invalid execution observation identity')
  return encodeURIComponent(value)
}
export function observationFile(workersDir: string, workerId: string, incarnationId: string, childId?: string): string {
  return path.join(workersDir, safeId(workerId), 'observations', childId ? `child-${safeId(childId)}.json` : `${safeId(incarnationId)}.json`)
}

/** Must complete before the provider request / CLI spawn; failure propagates to lifecycle cleanup. */
export async function persistObservation(file: string, observation: ExecutionObservation): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(observation), { mode: 0o600 })
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }) }
}

export async function readObservation(file: string, fallback: ExecutionObservation): Promise<ExecutionObservation> {
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
  const value = JSON.parse(raw) as ExecutionObservation
  if (value.schema_version !== 1 || value.policy_version !== 1 || value.state !== 'assembled'
    || value.role !== fallback.role || value.impl !== fallback.impl || value.worker_id !== fallback.worker_id
    || (fallback.incarnation_id !== undefined && value.incarnation_id !== fallback.incarnation_id) || value.subagent_id !== fallback.subagent_id
    || typeof value.observed_at !== 'string' || !Number.isFinite(Date.parse(value.observed_at))
    || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)
    || value.native_tools !== null
    || !(value.tools === null || (Array.isArray(value.tools) && value.tools.every(item => typeof item === 'string')))
    || ![value.child_profiles, value.mcp_servers, value.skills, value.constraints].every(list => Array.isArray(list) && list.every(item => typeof item === 'string'))
    || !['manager_request', 'builtin_request', 'cli_provision'].includes(value.source)) throw new Error('Corrupt execution observation')
  return value
}
