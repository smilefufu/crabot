/** Base protocol: null grants no extra directory; all is explicit and never inferred. */
export type StoragePermission = DirectoryStoragePermission | AllDirectoriesStoragePermission
export interface DirectoryStoragePermission {
  workspace_path: string
  access: 'read' | 'readwrite'
}
export interface AllDirectoriesStoragePermission {
  scope: 'all'
  access: 'read' | 'readwrite'
}
export function isStoragePermission(value: unknown): value is StoragePermission | null {
  if (value === null) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || !['read', 'readwrite'].includes(record.access as string)) return false
  if ('scope' in record) return record.scope === 'all' && !('workspace_path' in record)
  return typeof record.workspace_path === 'string' && !!record.workspace_path.trim() && !record.workspace_path.includes('\0')
}
