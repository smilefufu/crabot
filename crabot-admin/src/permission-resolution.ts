/**
 * Permission resolution helpers
 *
 * 用于把 friend 侧 ResolvedPermissions 与 session 侧 ResolvedPermissions 按字段并集合并：
 *   - tool_access: 按 OR
 *   - cli_access: 按 rank 取大（none < read < write）
 *   - storage: 同一 workspace_path 下 access 取更宽松；不同 path 直接取更受限的一侧
 *     （保守：避免拿一侧的 path + 另一侧的 access 制造未授权 readwrite）
 *   - memory_scopes: 取并集去重（顺序：a 先，再 b 中独有项）
 *
 * 所有返回值都是新对象 / 拷贝，调用方可安全 mutate（且不影响输入），符合项目 immutability 约束。
 *
 * 设计意图：让 hook 层用统一一份 ResolvedPermissions 判断 cli_access / tool_access，
 * 不再在 agent 侧分私聊/群聊两条解析路径。
 */

import type { ResolvedPermissions, ToolAccessConfig, CliAccessConfig, CliPerm, StoragePermission } from './types.js'
import { TOOL_CATEGORIES, CLI_DOMAINS } from './types.js'

export function unionCliPerm(a: CliPerm, b: CliPerm): CliPerm {
  const rank = { none: 0, read: 1, write: 2 } as const
  return rank[a] >= rank[b] ? a : b
}

export function unionStorage(
  a: StoragePermission | null,
  b: StoragePermission | null,
): StoragePermission | null {
  if (!a) return b ? { ...b } : null
  if (!b) return { ...a }
  // path 一致 → access 按 readwrite > read 取宽
  if ('workspace_path' in a && 'workspace_path' in b && a.workspace_path === b.workspace_path) {
    const access: 'read' | 'readwrite' = (a.access === 'readwrite' || b.access === 'readwrite') ? 'readwrite' : 'read'
    return { workspace_path: a.workspace_path, access }
  }
  // path 不同 → 不能 union（拿一侧 path + 另一侧 readwrite 会制造未授权写入）。
  // 保守取更受限的一侧：read 胜 readwrite；都 read 时取 a 侧；都 readwrite 时也取 a。
  if (a.access === 'read' && b.access === 'readwrite') return { ...a }
  if (b.access === 'read' && a.access === 'readwrite') return { ...b }
  return { ...a }
}

function cloneResolved(r: ResolvedPermissions): ResolvedPermissions {
  return {
    tool_access: { ...r.tool_access },
    cli_access: { ...r.cli_access },
    storage: r.storage ? { ...r.storage } : null,
    memory_scopes: [...r.memory_scopes],
  }
}

export function unionResolved(
  a: ResolvedPermissions | null,
  b: ResolvedPermissions | null,
): ResolvedPermissions | null {
  if (!a && !b) return null
  if (!a) return cloneResolved(b!)
  if (!b) return cloneResolved(a)

  const tool_access = {} as ToolAccessConfig
  for (const k of TOOL_CATEGORIES) {
    tool_access[k] = a.tool_access[k] || b.tool_access[k]
  }

  const cli_access = {} as CliAccessConfig
  for (const d of CLI_DOMAINS) {
    cli_access[d] = unionCliPerm(a.cli_access[d], b.cli_access[d])
  }

  const storage = unionStorage(a.storage, b.storage)
  const memory_scopes = Array.from(new Set([...a.memory_scopes, ...b.memory_scopes]))

  return { tool_access, cli_access, storage, memory_scopes }
}
