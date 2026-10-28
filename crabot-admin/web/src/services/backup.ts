/**
 * 备份导出 API 客户端。
 */
import { api, fetchAdmin } from './api'

export interface BackupOptions {
  categories: string[]
  defaults: string[]
}

export async function fetchBackupOptions(): Promise<BackupOptions> {
  return api.get<BackupOptions>('/backup/options')
}

/**
 * 触发浏览器下载导出归档。
 * 使用 fetch + Blob URL，以便携带 Authorization header。
 */
export async function downloadBackup(categories: string[], includeSecrets: boolean): Promise<void> {
  const q = new URLSearchParams({
    categories: categories.join(','),
    includeSecrets: String(includeSecrets),
  })
  const res = await fetchAdmin(`/api/backup/export?${q.toString()}`, {
    method: 'GET',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? '导出失败')
  }
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const match = disposition.match(/filename="([^"]+)"/)
  const filename = match ? match[1] : `crabot-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
