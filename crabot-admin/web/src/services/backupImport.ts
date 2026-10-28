/**
 * Crabot 原生备份导入 API 客户端。
 *
 * overview：上传备份归档，探测 product 类型（crabot / openclaw）。
 * execute：仅 crabot product 适用，按类别执行导入。
 */
import { api, fetchAdmin } from './api'

export type ImportOverview =
  | { product: 'crabot'; staged_id: string; categories: string[] }
  | { product: 'openclaw' }

export interface CrabotImportSummary {
  results: Array<{
    kind: string
    id: string
    status: string
    reason?: string
  }>
  errors: string[]
}

/** 上传归档并获取 overview（原始二进制流上传，与 openclaw-import/parse 对齐）。 */
export async function uploadForImportOverview(file: File): Promise<ImportOverview> {
  const res = await fetchAdmin('/api/backup/import/overview', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: file,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? '解析备份失败')
  }
  return res.json()
}

/** 执行 Crabot 原生导入（product=crabot 时调用）。 */
export async function executeCrabotImport(params: {
  staged_id: string
  categories: string[]
  on_conflict: 'skip' | 'overwrite'
}): Promise<CrabotImportSummary> {
  return api.post<CrabotImportSummary>('/backup/import/execute', params)
}
