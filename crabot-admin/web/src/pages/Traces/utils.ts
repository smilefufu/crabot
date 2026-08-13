/**
 * Traces 页面工具（P6-A 后只剩维护面需要的 formatBytes）。
 * legacy AgentTrace 相关的格式化助手已随 v2 raw surface 一并退役。
 */

/** 把字节数转人类可读字符串（B / KB / MB / GB）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
