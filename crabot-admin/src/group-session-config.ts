import fs from 'node:fs/promises'
import { RpcError, generateTimestamp } from 'crabot-shared'
import { CLI_DOMAINS, TOOL_CATEGORIES, type GroupSessionPermissionConfig } from './types.js'

export interface GroupSessionConfigRecord {
  channel_id: string
  session_id: string
  config: GroupSessionPermissionConfig
}

export function groupSessionConfigKey(channelId: string, sessionId: string): string {
  return JSON.stringify([channelId, sessionId])
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseGroupSessionConfig(value: unknown, updatedAt = generateTimestamp()): GroupSessionPermissionConfig {
  const invalid = () => { throw new RpcError('INVALID_PARAMS', 'Invalid group permission config') }
  if (!isObject(value)) return invalid()
  if (Object.keys(value).some(key => !['tool_access', 'cli_access', 'storage', 'memory_scopes', 'template_id', 'updated_at'].includes(key))) return invalid()
  if (value.tool_access !== undefined && (!isObject(value.tool_access)
    || Object.entries(value.tool_access).some(([key, enabled]) => !(TOOL_CATEGORIES as readonly string[]).includes(key) || typeof enabled !== 'boolean'))) return invalid()
  if (value.cli_access !== undefined && (!isObject(value.cli_access)
    || Object.entries(value.cli_access).some(([key, access]) => !(CLI_DOMAINS as readonly string[]).includes(key) || !['none', 'read', 'write'].includes(access as string)))) return invalid()
  if (value.storage !== undefined && value.storage !== null && (!isObject(value.storage)
    || Object.keys(value.storage).some(key => !['workspace_path', 'access'].includes(key))
    || typeof value.storage.workspace_path !== 'string' || !value.storage.workspace_path.trim()
    || !['read', 'readwrite'].includes(value.storage.access as string))) return invalid()
  if (value.memory_scopes !== undefined && (!Array.isArray(value.memory_scopes)
    || value.memory_scopes.some(scope => typeof scope !== 'string' || !scope.trim()))) return invalid()
  if (value.template_id !== undefined && (typeof value.template_id !== 'string' || !value.template_id.trim())) return invalid()
  const config = structuredClone(value) as unknown as GroupSessionPermissionConfig
  return { ...config, tool_access: { ...config.tool_access, desktop: false }, updated_at: updatedAt }
}

export function parseGroupSessionConfigRecord(value: unknown): GroupSessionConfigRecord | null {
  if (!isObject(value) || typeof value.channel_id !== 'string' || !value.channel_id.trim()
    || typeof value.session_id !== 'string' || !value.session_id.trim() || !isObject(value.config)
    || typeof value.config.updated_at !== 'string' || !Number.isFinite(Date.parse(value.config.updated_at))) return null
  try {
    return { channel_id: value.channel_id, session_id: value.session_id, config: parseGroupSessionConfig(value.config, value.config.updated_at) }
  } catch {
    return null
  }
}

export async function quarantineGroupSessionConfigs(filePath: string, records: unknown[], source: 'startup' | 'import'): Promise<void> {
  const directory = await fs.mkdtemp(`${filePath}.quarantine-`)
  await fs.writeFile(`${directory}/records.json`, JSON.stringify(records, null, 2), { mode: 0o600 })
  await fs.writeFile(`${directory}/report.json`, JSON.stringify({
    source, created_at: generateTimestamp(), isolated_count: records.length,
    reason: 'Missing verified channel/session identity or invalid group permission config; excluded from authorization. Re-save on a verified group.',
  }, null, 2), { mode: 0o600 })
  console.warn(`[Admin] Isolated ${records.length} session permission record(s): ${directory}`)
}

export async function loadGroupSessionConfigs(filePath: string): Promise<Map<string, GroupSessionPermissionConfig>> {
  let data: string
  try {
    data = await fs.readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
  const records: unknown = JSON.parse(data)
  if (!Array.isArray(records)) throw new Error('Invalid session permission store')
  const configs = new Map<string, GroupSessionPermissionConfig>()
  const isolated: unknown[] = []
  for (const raw of records) {
    const entry = parseGroupSessionConfigRecord(raw)
    if (!entry) isolated.push(raw)
    else configs.set(groupSessionConfigKey(entry.channel_id, entry.session_id), entry.config)
  }
  if (isolated.length > 0) {
    // Preserve evidence before replacing the active store. Failures must abort startup.
    await quarantineGroupSessionConfigs(filePath, isolated, 'startup')
    await fs.writeFile(`${filePath}.tmp`, JSON.stringify(serializeGroupSessionConfigs(configs), null, 2), { mode: 0o600 })
    await fs.rename(`${filePath}.tmp`, filePath)
  }
  return configs
}

export function serializeGroupSessionConfigs(configs: ReadonlyMap<string, GroupSessionPermissionConfig>): GroupSessionConfigRecord[] {
  return Array.from(configs, ([key, config]) => {
    const [channel_id, session_id] = JSON.parse(key) as [string, string]
    return { channel_id, session_id, config }
  })
}
