import type { ModuleId, FriendId, SessionId, TaskId } from '../../types'
import type { IncarnationEndReason, IncarnationId, WorkerContractState, WorkerImplId, WorkspaceInstructionSnapshot } from '../types'

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'
export type TaskStatus = 'queued' | 'running' | 'halted' | 'closed'

/**
 * 载体停止的事实分类(protocol-agent-v3 §5.2)。只描述"怎么停的",不对任务成败下判断——
 * 自报、推断与成败判断全部不进状态机(2026-08-31 修正,见 base-protocol §5.10)。
 */
export type TaskHaltReason = 'turn_end' | 'worker_finalized' | 'crashed' | 'pre_migration' | 'unknown'

/**
 * task 停在 `halted` 期间附着的事实记录(spec 2026-08-31-worker-stop-oversight-design §5.1)。
 * `worker_self_report` 是 worker 的自称,不是任务达成与否的结论;化身级细节(ended_reason、
 * session 引用)留在化身记录与 turn 记录上,此处不复制。
 */
export interface TaskHaltEvidence {
  halted_at: string
  halt_reason: TaskHaltReason
  /** 仅 worker_finalized(`finish_task`)时存在。 */
  worker_self_report?: { outcome: 'completed' | 'failed'; summary: string }
  /** request_worker_stop 核验失败(unknown)时为 true。 */
  stop_unverified?: boolean
  /** 崩溃/启动失败等原因原文(事实记录,非成败判断;替换旧 task.error 的承载)。 */
  detail?: string
}

/** 唯一终态 `closed` 的关闭信息(manager/admin/系统处置产生,worker 行为不可达)。 */
export interface TaskClosedInfo {
  at: string
  by: 'manager_stop' | 'admin' | 'system' | 'migration'
  note?: string
}

/** Manager loop, worker ledger and worker ownership share this session key. */
export type ManagerKey = `${ModuleId}::${SessionId}`

interface IncarnationBase {
  /** Harness-owned stable identity. Missing values are deterministically materialized on legacy read. */
  incarnation_id?: IncarnationId
  seq: number
  state: WorkerContractState
  workspace: string
  /** The source body is held in a Harness-private artifact, never in the workspace ledger. */
  workspace_instructions?: WorkspaceInstructionSnapshot
  started_at: string
  ended_at?: string
  ended_reason?: IncarnationEndReason
  /** Legacy ledgers use numeric seq; new writes always use incarnation_id. */
  forked_from?: number | IncarnationId
  query_id?: string
}

export interface ExecutableIncarnation extends IncarnationBase {
  impl: WorkerImplId
  session_ref: string
  tmux_session?: string
}

export interface LegacyIncarnation extends IncarnationBase {
  impl: 'legacy'
  state: 'exited'
  ended_at: string
  ended_reason: IncarnationEndReason
  session_ref?: never
}

export type Incarnation = ExecutableIncarnation | LegacyIncarnation

export function isLegacyIncarnation(incarnation: Incarnation): incarnation is LegacyIncarnation {
  return incarnation.impl === 'legacy'
}

export function isExecutableIncarnation(incarnation: Incarnation): incarnation is ExecutableIncarnation {
  return incarnation.impl !== 'legacy'
}

export interface V2LegacySourceRef {
  kind: 'v2_admin_task'
  admin_task_id: TaskId
  trace_ids: string[]
  imported_at: string
}

/** Old physical ledger data retained only as audit/handoff evidence. */
export interface LegacyArchivedIncarnation {
  incarnation_id?: IncarnationId
  seq: number
  impl: WorkerImplId
  state: WorkerContractState
  workspace: string
  workspace_instructions?: WorkspaceInstructionSnapshot
  started_at: string
  ended_at?: string
  ended_reason?: IncarnationEndReason
  forked_from?: number | IncarnationId
  query_id?: string
  session_ref: string
  tmux_session?: string
}

export interface AmbiguousV3LedgerArchiveSource {
  kind: 'ambiguous_v3_ledger'
  archived_at: string
  reason: 'ambiguous_numeric_forked_from'
  original_incarnations: LegacyArchivedIncarnation[]
}

export type LegacySourceRef = V2LegacySourceRef | AmbiguousV3LedgerArchiveSource

export interface WorkerSupervision {
  version: 1
  mode: 'default' | 'periodic_report'
  next_due_at?: string
  last_observed_at?: string
  last_effective_review_at?: string
  observation?: { mainline_seq: number; cursor: { offset: number } }
  pending?: {
    due_id: string
    kind: 'default_review' | 'periodic_report'
    due_at: string
    attempts: number
    retry_after_at?: string
  }
  periodic_report?: {
    interval_ms: number
    expires_at?: string
    report_to: { channel_id: ModuleId; session_id: SessionId }
  }
}

/** Durable responsibility to wake the owning Manager after a mainline execution carrier crashed. */
export interface WorkerRecoveryNotice {
  notice_id: string
  incarnation_id: IncarnationId
  status: 'pending' | 'consumed'
  created_at: string
  attempts: number
  retry_after_at?: string
  consumed_at?: string
}

export interface LedgerWorker {
  worker_id: string
  /** Immutable session owner: storage, lookup, routing and read model all use this field. */
  manager_key: ManagerKey
  task: {
    id: TaskId
    type?: string
    title: string
    status: TaskStatus
    priority?: TaskPriority
    input?: Record<string, unknown>
    tags?: string[]
    goal?: string
    created_at: string
    /** 载体停止的事实记录(status='halted' 时存在;续办回 running 时清除)。 */
    halt?: TaskHaltEvidence
    /** 关闭信息(status='closed' 时存在)。 */
    closed?: TaskClosedInfo
  }
  origin: {
    spawned_by_episode?: string
    creator_friend_id?: FriendId
    trigger_type: 'message' | 'scheduled' | 'system'
  }
  report_to: { channel_id: ModuleId; session_id: SessionId }
  incarnations: Incarnation[]
  supervision?: WorkerSupervision
  /** Missing on historical ledgers means no recovery work is inferred. */
  recovery_notices?: WorkerRecoveryNotice[]
  legacy_source?: LegacySourceRef
  updated_at: string
}

export interface WorkerLedger {
  manager_key: ManagerKey
  workers: LedgerWorker[]
}
