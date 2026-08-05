/**
 * P3 台账类型 —— 逐字对齐 protocol-agent-v3.md §3(核心概念与标识)/ §7(台账与存储)。
 *
 * 复用协议已在别处落地过的类型,不重复定义:
 * - ModuleId / FriendId / SessionId / TaskId:crabot-agent/src/types.ts(从 crabot-shared 转出)
 * - WorkerImplId / WorkerContractState / IncarnationEndReason:src/workers/types.ts(P1/P2 已按协议定义)
 *
 * TaskPriority 目前既不在 crabot-shared,也不在 crabot-agent/src/types.ts 中定义,这里按
 * base-protocol §5.9 原样声明,待上游补齐后再收敛为复用,不在本任务范围内新增导出。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §3、§7
 * @see crabot-docs/protocols/base-protocol.md §5.9、§5.10
 */

import type { ModuleId, FriendId, SessionId, TaskId } from '../../types'
import type { WorkerImplId, WorkerContractState, IncarnationEndReason } from '../types'

/** base-protocol §5.9 TaskPriority(暂无上游导出,原样声明) */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'

/**
 * base-protocol §5.10 TaskStatus 的 v3 精简集(protocol-agent-v3 §5.2)。
 * 旧值(pending/planning/executing/waiting_human/waiting_bg)已在 v3 弃用,新代码不得使用。
 */
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 对话对象 ID:worker 台账的聚合键(protocol-agent-v3 §3) */
export type DialogObjectId =
  | `friend:${FriendId}` // 私聊:按 Friend 跨 channel 聚合
  | `group:${ModuleId}:${SessionId}` // 群聊:单群即一个对话对象

/** Manager 实例键:对话历史(loop 上下文)的粒度(protocol-agent-v3 §3) */
export type ManagerKey = `${ModuleId}::${SessionId}`

/** 化身(incarnation):worker 在某一实现下的一次连续执行体(protocol-agent-v3 §3) */
export interface Incarnation {
  seq: number
  impl: WorkerImplId | 'legacy'
  state: WorkerContractState
  workspace: string
  /** builtin: session 树文件引用;CLI: 原生 session id;legacy: 旧 ResumeCheckpoint 引用 */
  session_ref: string
  tmux_session?: string
  started_at: string
  ended_at?: string
  ended_reason?: IncarnationEndReason
  /** 本化身是从哪个 seq 的化身 fork 出来的一次性侧问分支;有值即表示它不在主线化身链上,
   * 不参与 send_to_worker / kill_worker / 化身接续等主线判定(protocol-agent-v3 §3、§5.3)。 */
  forked_from?: number
}

/** 台账中的 worker 条目(task 数据归并于此,agent 即真相源)(protocol-agent-v3 §3) */
export interface LedgerWorker {
  worker_id: string
  task: {
    id: TaskId
    /** Schedule/system business type; optional for ordinary worker tasks. */
    type?: string
    title: string
    status: TaskStatus // 精简状态机,见 base-protocol §5.10
    priority?: TaskPriority
    input?: Record<string, unknown>
    tags?: string[]
    goal?: string
    outcome?: string
    created_at: string
    completed_at?: string
    error?: string
  }
  origin: {
    spawned_by_session: ManagerKey
    spawned_by_episode?: string // episode trace_id,可跳转
    /** 权限身份:以谁的名义执行(权限模板解析依据) */
    creator_friend_id?: FriendId
    trigger_type: 'message' | 'scheduled' | 'system'
  }
  /** 结果回报目标,默认 = 派发 session */
  report_to: { channel_id: ModuleId; session_id: SessionId }
  incarnations: Incarnation[]
  updated_at: string
}

/** 台账文件:每对话对象一份(protocol-agent-v3 §3) */
export interface WorkerLedger {
  dialog_object_id: DialogObjectId
  workers: LedgerWorker[]
}

/** P3 内部辅助:私聊对话对象 ID(task-2-brief.md) */
export function dialogObjectIdForPrivate(friendId: string): DialogObjectId {
  return `friend:${friendId}`
}

/** P3 内部辅助:群聊对话对象 ID(task-2-brief.md) */
export function dialogObjectIdForGroup(channelId: string, sessionId: string): DialogObjectId {
  return `group:${channelId}:${sessionId}`
}
