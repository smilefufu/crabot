/**
 * Background entity 抽象：bg shell 和 bg sub-agent 共用同一组类型。
 * Spec: crabot-docs/superpowers/specs/2026-05-01-long-running-agent-design.md §6.1
 */

export type BgEntityType = 'shell' | 'agent'
export type BgEntityStatus = 'running' | 'completed' | 'failed' | 'killed' | 'stalled'

export interface BgEntityOwner {
  readonly friend_id: string
  readonly session_id?: string
  readonly channel_id?: string
}

interface BgEntityBase {
  readonly entity_id: string
  status: BgEntityStatus
  readonly owner: BgEntityOwner
  readonly spawned_by_task_id: string
  readonly spawned_at: string
  exit_code: number | null
  ended_at: string | null
  /** max(spawned_at, last Output call, ended_at) — 仅用于 dead entity GC */
  last_activity_at: string
}

export interface BgShellRegistryRecord extends BgEntityBase {
  readonly type: 'shell'
  readonly command: string
  readonly log_file: string
  readonly pid: number
  readonly pgid: number
  /** 进程实际启动时间（防 PID reuse） */
  readonly process_started_at: string
}

export interface BgAgentRegistryRecord extends BgEntityBase {
  readonly type: 'agent'
  readonly task_description: string
  readonly messages_log_file: string
  result_file: string | null
}

export type BgEntityRecord = BgShellRegistryRecord | BgAgentRegistryRecord

export interface RegistryFile {
  readonly entities: Record<string, BgEntityRecord>
}

export const BG_ENTITY_LIMIT_PER_OWNER = 20
export const BG_ENTITY_GC_AFTER_DAYS = 7
export const BG_OUTPUT_MAX_BYTES = 100_000
export const BG_TRANSIENT_RING_BUFFER_BYTES = 200_000
