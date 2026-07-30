/**
 * P4 Manager loop 类型 —— 逐字对齐 protocol-agent-v3.md §4(Manager loop)。
 *
 * ManagerKey 复用 P3 台账已定义的同名类型(harness/ledger-types.ts),不重复声明——
 * manager loop 实例与 worker 台账共享同一套 `channel_id::session_id` 键空间语义。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §4
 */

import type { EngineMessage } from '../engine/index.js'
import type { ManagerKey } from '../workers/harness/ledger-types'

export type { ManagerKey }

/** Manager 会话状态(对话历史/摘要 loop 上下文),按 ManagerKey 持久化 */
export interface ManagerSessionState {
  readonly key: ManagerKey
  /** 滚动摘要块(增量压缩产物);无历史时为 undefined */
  readonly rollingSummary?: string
  /** 最近 K 条原始消息(正序) */
  readonly recent: ReadonlyArray<EngineMessage>
  /** 上次活动时间(ISO),用于压缩的 TTL 判定 */
  readonly lastActiveAt?: string
  /** 已折叠进摘要的消息条数(诊断用) */
  readonly foldedCount: number
}
