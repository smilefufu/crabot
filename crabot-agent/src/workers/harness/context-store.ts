import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'

import { CLI_DOMAINS, type ResolvedPermissions, type StoragePermission, type ToolAccessConfig } from '../../types.js'

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

function isResolvedPermissions(value: unknown): value is ResolvedPermissions {
  if (!isRecord(value) || !hasOnlyKeys(value, ['tool_access', 'cli_access', 'storage', 'memory_scopes'])) return false
  const toolAccess = value.tool_access
  if (!isRecord(toolAccess) || !hasOnlyKeys(toolAccess, TOOL_ACCESS_KEYS) ||
    !TOOL_ACCESS_KEYS.every((key) => typeof toolAccess[key] === 'boolean')) return false
  const cliAccess = value.cli_access
  if (!isRecord(cliAccess) || !hasOnlyKeys(cliAccess, CLI_ACCESS_KEYS) ||
    !CLI_ACCESS_KEYS.every((key) => cliAccess[key] === 'none' || cliAccess[key] === 'read' || cliAccess[key] === 'write')) return false
  return isStoragePermission(value.storage) && Array.isArray(value.memory_scopes) && value.memory_scopes.every((scope) => typeof scope === 'string')
}

function validateContext(value: unknown, path: string): WorkerContext {
  if (!isRecord(value) || !hasOnlyKeys(value, ['principal_permissions'])) {
    throw new Error(`WorkerContextStore: invalid context at ${path}`)
  }
  if (value.principal_permissions !== undefined && !isResolvedPermissions(value.principal_permissions)) {
    throw new Error(`WorkerContextStore: invalid principal_permissions at ${path}`)
  }
  return value.principal_permissions === undefined ? {} : { principal_permissions: value.principal_permissions }
}

/** Harness 持有的跨实现 worker 身份快照；文件内容严格限于协议定义字段。 */
export class WorkerContextStore {
  constructor(private readonly workersDir: string) {}

  private pathFor(workerId: string): string {
    return join(this.workersDir, workerId, CONTEXT_FILE)
  }

  async write(workerId: string, context: WorkerContext): Promise<void> {
    const path = this.pathFor(workerId)
    const dir = join(this.workersDir, workerId)
    const tmpPath = join(dir, `.${CONTEXT_FILE}.tmp-${randomUUID()}`)
    validateContext(context, path)
    await fs.mkdir(dir, { recursive: true })
    try {
      await fs.writeFile(tmpPath, JSON.stringify(context), 'utf-8')
      await fs.rename(tmpPath, path)
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
    return validateContext(parsed, path)
  }
}
