/**
 * 从 Crabot 备份归档读取某类别 payload。
 * 归档内路径相对根（manifest.json + payload/...），与 archive-reader 列出的条目一致。
 * 设计依据：2026-06-19-crabot-backup-import-design.md §4
 */
import { readArchiveTextFile } from '../../openclaw-import/archive-reader.js'

export { readArchiveTextFile }

/** 读归档内某 JSON 数组文件；不存在 / 非数组 / 解析失败均返回 []。 */
export async function readJsonArrayFromArchive(
  archivePath: string,
  entryPath: string,
): Promise<unknown[]> {
  const text = await readArchiveTextFile(archivePath, entryPath)
  if (text === null) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
