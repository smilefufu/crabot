import type { ModuleId, FriendId, SessionId, TaskId } from '../../types'
import type { WorkerImplId, WorkerContractState, IncarnationEndReason } from '../types'

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'
export type TaskStatus = 'queued' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled'

/** Manager loop, worker ledger and worker ownership share this session key. */
export type ManagerKey = `${ModuleId}::${SessionId}`

interface IncarnationBase {
  seq: number
  state: WorkerContractState
  workspace: string
  started_at: string
  ended_at?: string
  ended_reason?: IncarnationEndReason
  forked_from?: number
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

export interface LegacySourceRef {
  kind: 'v2_admin_task'
  admin_task_id: TaskId
  trace_ids: string[]
  imported_at: string
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
    outcome?: string
    created_at: string
    completed_at?: string
    error?: string
  }
  origin: {
    spawned_by_episode?: string
    creator_friend_id?: FriendId
    trigger_type: 'message' | 'scheduled' | 'system'
  }
  report_to: { channel_id: ModuleId; session_id: SessionId }
  incarnations: Incarnation[]
  legacy_source?: LegacySourceRef
  updated_at: string
}

export interface WorkerLedger {
  manager_key: ManagerKey
  workers: LedgerWorker[]
}
