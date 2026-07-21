/**
 * Read 工具的 task 级去重缓存（read dedup）。
 *
 * 记录每个文件「上一次 Read 的 mtime + 行范围」。当 agent 再次以**相同范围**读取、且
 * 磁盘 mtime **未变**时，Read 返回一个轻量 stub（FILE_UNCHANGED_STUB），不再把整文件
 * 重新回灌进 context —— 直接省掉重复读的 token。trace 实测同一文件单任务内被读 18 遍、
 * 全量约 90% 内容是冗余重复。
 *
 * 设计取舍（对齐参考实现 claude-code FileReadTool 的 read dedup，取其简单版）：
 * - **以磁盘 mtime 为准**：任何人（Edit / Write / Bash / 外部进程）改了文件，mtime 必变 →
 *   下次 Read 自动失效、走全量读。因此 Edit/Write **无需**主动失效本缓存。
 * - **不算 diff**：只处理「未变 → stub / 变了 → 全量读」，不做行级 diff（简单优先）。
 * - **截断读不缓存**：单次读取被 50KB 字节上限截断时不进缓存（部分视图，全量读才安全）。
 * - **隔离**：只挂给 main worker；subagent 用普通 Read（不带本缓存）。否则 main 读过的文件
 *   会让 subagent 拿到一个指向「不在自己上下文里的旧 tool_result」的 stub。
 * - **压缩配合**：onCompactionStart 时 clear()。旧的 Read tool_result 可能被压缩摘要掉，
 *   清空后后续首次读会重新全量填充，保证 agent 总能靠「再读一次」恢复内容、不会被悬空 stub 卡死。
 */
export interface FileReadStateEntry {
  /** 上次读取时的磁盘 mtime（毫秒）。 */
  readonly mtimeMs: number
  /** 上次读取的 offset（起始行，0-based）。 */
  readonly offset: number
  /** 上次读取的 limit（最大行数）。 */
  readonly limit: number
}

export type FileReadState = Map<string, FileReadStateEntry>

export const FILE_UNCHANGED_STUB =
  '文件自上次 Read 以来未改动（磁盘 mtime 未变）。本对话中较早那次 Read 的 tool_result ' +
  '内容仍然有效，直接参考它即可，不必重复读取。如确需重新加载，可改用不同的 offset/limit。'
