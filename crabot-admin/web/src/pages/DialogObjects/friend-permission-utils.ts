import type { StoragePermission, ToolAccessConfig } from '../../types'
import type { FriendPermissionConfig } from '../../services/friend'

function cloneStorage(storage: StoragePermission | null): StoragePermission | null {
  return storage ? { ...storage } : null
}

function cloneToolAccess(toolAccess: ToolAccessConfig): ToolAccessConfig {
  return { ...toolAccess }
}

export function summarizeFriendStorage(storage: StoragePermission | null): string {
  if (!storage) return '未开启'
  return `${storage.workspace_path} · ${storage.access === 'read' ? '只读' : '读写'}`
}

export function summarizeFriendMemoryScopes(sessionId: string, scopes: string[]): string {
  if (scopes.length === 0) return '未设置范围'
  if (scopes.length === 1 && scopes[0] === sessionId) return '当前会话'
  return scopes.join(', ')
}

export function parseMemoryScopes(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((scope) => scope.trim())
    .filter(Boolean)
}

export type FriendPermissionEffectiveConfig = Pick<
  FriendPermissionConfig,
  'tool_access' | 'storage' | 'memory_scopes'
>

export function buildExplicitFriendPermissionConfig(
  config: FriendPermissionEffectiveConfig
): FriendPermissionEffectiveConfig {
  return {
    tool_access: cloneToolAccess(config.tool_access),
    storage: cloneStorage(config.storage),
    memory_scopes: [...config.memory_scopes],
  }
}
