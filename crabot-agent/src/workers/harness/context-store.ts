import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'

import { CLI_DOMAINS, type CliAccessConfig, type ResolvedPermissions, type StoragePermission, type ToolAccessConfig } from '../../types.js'

const CONTEXT_FILE = 'context.json'
const TOOL_ACCESS_KEY_MAP = {
  memory: true,
  messaging: true,
  task: true,
  mcp_skill: true,
  file_io: true,
  browser: true,
  shell: true,
  remote_exec: true,
  desktop: true,
} satisfies Record<keyof ToolAccessConfig, true>
const TOOL_ACCESS_KEYS = Object.keys(TOOL_ACCESS_KEY_MAP) as Array<keyof ToolAccessConfig>
const CLI_ACCESS_KEYS = CLI_DOMAINS
const CLI_PERMISSIONS = new Set(['none', 'read', 'write'])

export interface WorkerContext {
  readonly principal_permissions?: ResolvedPermissions
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isStoragePermission(value: unknown): value is StoragePermission | null {
  return value === null || (isRecord(value) && hasOnlyKeys(value, ['workspace_path', 'access']) &&
    typeof value.workspace_path === 'string' && (value.access === 'read' || value.access === 'readwrite'))
}

function isCompleteResolvedPermissions(value: unknown): value is ResolvedPermissions {
  if (!isRecord(value) || !hasOnlyKeys(value, ['tool_access', 'cli_access', 'storage', 'memory_scopes'])) return false
  const toolAccess = value.tool_access
  if (!isRecord(toolAccess) || !hasOnlyKeys(toolAccess, TOOL_ACCESS_KEYS) ||
    !TOOL_ACCESS_KEYS.every((key) => typeof toolAccess[key] === 'boolean')) return false
  const cliAccess = value.cli_access
  if (!isRecord(cliAccess) || !hasOnlyKeys(cliAccess, CLI_ACCESS_KEYS) ||
    !CLI_ACCESS_KEYS.every((key) => CLI_PERMISSIONS.has(String(cliAccess[key])))) return false
  return isStoragePermission(value.storage) && Array.isArray(value.memory_scopes) && value.memory_scopes.every((scope) => typeof scope === 'string')
}

function normalizeResolvedPermissionsForWrite(value: unknown, path: string): ResolvedPermissions {
  if (!isRecord(value) || !hasOnlyKeys(value, ['tool_access', 'cli_access', 'storage', 'memory_scopes'])) {
    throw new Error(`WorkerContextStore: invalid principal_permissions at ${path}`)
  }
  const toolAccess = value.tool_access
  if (!isRecord(toolAccess) || !hasOnlyKeys(toolAccess, TOOL_ACCESS_KEYS) ||
    !Object.values(toolAccess).every((item) => typeof item === 'boolean')) {
    throw new Error(`WorkerContextStore: invalid principal_permissions.tool_access at ${path}`)
  }
  const cliAccess = value.cli_access
  if (!isRecord(cliAccess) || !hasOnlyKeys(cliAccess, CLI_ACCESS_KEYS) ||
    !Object.values(cliAccess).every((item) => CLI_PERMISSIONS.has(String(item)))) {
    throw new Error(`WorkerContextStore: invalid principal_permissions.cli_access at ${path}`)
  }
  if (!isStoragePermission(value.storage) || !Array.isArray(value.memory_scopes) ||
    !value.memory_scopes.every((scope) => typeof scope === 'string')) {
    throw new Error(`WorkerContextStore: invalid principal_permissions at ${path}`)
  }

  const normalizedToolAccess = Object.fromEntries(
    TOOL_ACCESS_KEYS.map((key) => [key, toolAccess[key] === true]),
  ) as unknown as ToolAccessConfig
  const normalizedCliAccess = Object.fromEntries(
    CLI_ACCESS_KEYS.map((key) => [key, CLI_PERMISSIONS.has(String(cliAccess[key])) ? cliAccess[key] : 'none']),
  ) as CliAccessConfig
  return {
    tool_access: normalizedToolAccess,
    cli_access: normalizedCliAccess,
    storage: value.storage ? { ...value.storage } : null,
    memory_scopes: [...value.memory_scopes],
  }
}

function validatePersistedContext(value: unknown, path: string): WorkerContext {
  if (!isRecord(value) || !hasOnlyKeys(value, ['principal_permissions'])) {
    throw new Error(`WorkerContextStore: invalid context at ${path}`)
  }
  if (value.principal_permissions !== undefined && !isCompleteResolvedPermissions(value.principal_permissions)) {
    throw new Error(`WorkerContextStore: invalid principal_permissions at ${path}`)
  }
  return value.principal_permissions === undefined ? {} : { principal_permissions: value.principal_permissions }
}

function normalizeContextForWrite(value: unknown, path: string): WorkerContext {
  if (!isRecord(value) || !hasOnlyKeys(value, ['principal_permissions'])) {
    throw new Error(`WorkerContextStore: invalid context at ${path}`)
  }
  return value.principal_permissions === undefined
    ? {}
    : { principal_permissions: normalizeResolvedPermissionsForWrite(value.principal_permissions, path) }
}

/** Harness 持有的跨实现 worker 身份快照；文件内容严格限于协议定义字段。 */
export class WorkerContextStore {
  constructor(private readonly workersDir: string) {}

  private pathFor(workerId: string): string {
    return join(this.workersDir, workerId, CONTEXT_FILE)
  }

  async write(workerId: string, context: WorkerContext): Promise<WorkerContext> {
    const path = this.pathFor(workerId)
    const dir = join(this.workersDir, workerId)
    const tmpPath = join(dir, `.${CONTEXT_FILE}.tmp-${randomUUID()}`)
    // RPC 的历史 ResolvedPermissions 可能缺少后来新增的已知类目；写前补最严默认，
    // 让落盘结果始终满足 read 的严格契约，同时拒绝未知字段与非法值。
    const normalized = normalizeContextForWrite(context, path)
    await fs.mkdir(dir, { recursive: true })
    try {
      await fs.writeFile(tmpPath, JSON.stringify(normalized), 'utf-8')
      await fs.rename(tmpPath, path)
      return normalized
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined)
      throw err
    }
  }

  /** ENOENT 是历史 worker 的明确 fallback；其他读取失败一律上抛。 */
  async read(workerId: string): Promise<WorkerContext | undefined> {
    const path = this.pathFor(workerId)
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`WorkerContextStore: invalid JSON at ${path}: ${(err as Error).message}`)
    }
    return validatePersistedContext(parsed, path)
  }
}
