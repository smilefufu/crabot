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

/**
 * fail-loud 兜底:manager episode 失败的两种形态。
 *
 * `ManagerLoop` 只有 F2 会抛错;最常见的 F1(LLM 挂 / key 过期 / 限流耗尽重试)记
 * `outcome:'failed'`、把整批输入推回 mailbox,然后**正常 resolve**。所以判据必须双管:
 * `catch` 抓 F2,`outcome ∈ {failed, aborted}` 抓 F1。只写 try/catch 抓不住最常见的那种。
 *
 * 住在这里而不是 `unified-agent.ts`:除了三条人类消息入口,`bootstrap.ts` 的 worker 事件
 * 出口也要按同一套判据上报(`BootstrapDeps.reportEpisodeFailure`),两边必须是同一个类型。
 *
 * @see crabot-docs/superpowers/plans/2026-08-01-mw-p7-j-cutover.md §三
 */
export type ManagerEpisodeFailure =
  | { readonly kind: 'threw'; readonly error: unknown }
  | { readonly kind: 'outcome'; readonly outcome: 'failed' | 'aborted' }
