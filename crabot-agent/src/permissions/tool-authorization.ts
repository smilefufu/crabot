import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { EffectiveToolCategory } from 'crabot-shared'
import type { ResolvedPermissions } from '../types.js'
import type { PermissionDecision, ToolDefinition } from '../engine/types.js'

export type Principal = () => ResolvedPermissions | null | undefined
export type ToolAuthorization = {
  role: 'manager' | 'worker' | 'child'
  entry: EffectiveToolCategory | 'role'
  available: () => boolean
  check: (input: Record<string, unknown>) => Promise<PermissionDecision>
}

export const allowed = { allowed: true } as const
export function denied(code: string, reason: string): PermissionDecision {
  return { allowed: false, reason: `${code}: ${reason}` }
}

/** Host-owned declaration. Wrapping call also protects direct invocation and repaired inputs. */
export function authorizeTool(tool: ToolDefinition, authorization: ToolAuthorization): ToolDefinition {
  return { ...tool, authorization, async call(input, context) {
    const decision = await authorization.check(input)
    if (!decision.allowed) return { isError: true, output: decision.reason }
    return tool.call(input, context)
  } }
}

export function roleAuthorization(role: ToolAuthorization['role']): ToolAuthorization {
  return { role, entry: 'role', available: () => true, check: async () => allowed }
}

export function entryAuthorization(role: ToolAuthorization['role'], entry: EffectiveToolCategory, principal: Principal): ToolAuthorization {
  return { role, entry, available: () => principal()?.tool_access[entry] === true, async check() {
    const permissions = principal()
    if (!permissions) return denied('CAPABILITY_UNKNOWN', '缺少可信主体授权')
    return permissions.tool_access[entry] === true ? allowed : denied('PERMISSION_DENIED', `${entry} 未获授权`)
  } }
}

/** Canonicalizes new paths and dangling links as well as existing files. */
async function canonicalPath(value: string, depth = 0): Promise<string> {
  if (depth > 40) throw new Error('符号链接层数超限')
  try { return await fs.realpath(value) } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
  const stat = await fs.lstat(value).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return null
  })
  if (stat?.isSymbolicLink()) return canonicalPath(path.resolve(path.dirname(value), await fs.readlink(value)), depth + 1)
  const parent = path.dirname(value)
  if (parent === value) throw new Error('无法解析文件路径')
  return path.join(await canonicalPath(parent, depth + 1), path.basename(value))
}

export async function checkFileAccess(principal: ReturnType<Principal>, value: string, cwd: string, write: boolean): Promise<PermissionDecision> {
  if (!principal) return denied('CAPABILITY_UNKNOWN', '缺少可信主体授权')
  if (!principal.tool_access.file_io || !principal.storage) return denied('PERMISSION_DENIED', '未授权内置文件范围')
  if (write && principal.storage.access !== 'readwrite') return denied('PERMISSION_DENIED', '文件范围只读')
  try {
    const root = await fs.realpath(principal.storage.workspace_path)
    if (!(await fs.stat(root)).isDirectory()) return denied('PERMISSION_DENIED', '授权文件范围不是目录')
    const target = await canonicalPath(path.resolve(cwd, value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value))
    const relative = path.relative(root, target)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return denied('PERMISSION_DENIED', '文件路径超出授权范围')
    return allowed
  } catch (error) { return denied('PERMISSION_DENIED', `无法核实文件范围：${(error as Error).message}`) }
}

export function fileAuthorization(role: ToolAuthorization['role'], principal: Principal, cwd: () => string, key: string, write: boolean): ToolAuthorization {
  const entry = entryAuthorization(role, 'file_io', principal)
  return { ...entry, available: () => entry.available() && principal()?.storage !== null, async check(input) {
    const value = input[key]
    if (value !== undefined && typeof value !== 'string') return denied('PERMISSION_DENIED', '文件路径必须为字符串')
    return checkFileAccess(principal(), typeof value === 'string' ? value : '.', cwd(), write)
  } }
}

export function assertAuthorizedTools(tools: readonly ToolDefinition[]): void {
  for (const tool of tools) if (!tool.authorization) throw new Error(`CAPABILITY_UNAVAILABLE: 工具 ${tool.name} 缺少宿主授权声明`)
}
