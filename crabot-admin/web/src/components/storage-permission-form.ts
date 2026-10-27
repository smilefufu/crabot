import type { StoragePermission } from '../types'

export function storagePermissionFromFields(enabled: boolean, all: boolean, directory: string, access: 'read' | 'readwrite'): StoragePermission | null {
  if (!enabled) return null
  if (all) return { scope: 'all', access }
  return { workspace_path: directory, access }
}
