export interface ReflectionWindow {
  window_start: string
  window_end: string
}

export interface FinishDailyReflectionInput {
  outcome: 'completed' | 'partial'
  summary: string
  pending_items: string[]
  evidence_refs: string[]
  summary_delivered?: boolean
}

export interface ReflectionRecordSummary {
  record_ref: string
  kind: 'manager_episode' | 'worker' | 'human_input'
  source_id: string
  activity_at: string
  summary: string
  gaps: string[]
}

export interface ReflectionWorkerTrace {
  seq: number
  incarnation_fingerprint: string
  upper_bound: { harness: number; native: number; legacy: number }
}

/** Host-owned source references. Never accepted from model input. */
export type ReflectionSource =
  | { kind: 'manager_episode'; manager_key: string; episode_id: string; log_bytes: number; span_ids: string[] }
  | { kind: 'human_input'; manager_key: string; message_ids: string[] }
  | { kind: 'worker'; worker_id: string; traces: ReflectionWorkerTrace[]; turn_ids: string[]; event_count: number; gaps: string[] }

export interface ReflectionRecord extends ReflectionRecordSummary {
  source: ReflectionSource
  digest: string
}

export interface ReflectionEvidence {
  content: string
  gaps: string[]
}

export interface ReflectionManifest {
  records: ReflectionRecord[]
  gaps: string[]
}

export interface DailyReflectionResult extends FinishDailyReflectionInput, ReflectionWindow {
  run_id: string
  completed_at: string
  validation_errors: string[]
}

/** One workflow may span several Manager episodes; no raw trace payload is copied here. */
export interface DailyReflectionState extends ReflectionWindow {
  run_id: string
  schedule_id: string
  trigger_id: string
  target_session: { channel_id: string; session_id: string; type: 'private' | 'group' }
  episode_ids: string[]
  analysis_worker_ids: string[]
  manifest?: ReflectionManifest
  directory_complete: boolean
  read_records: Record<string, boolean>
  cursors: Record<string, { record_ref?: string; offset: number }>
  summary_delivered: boolean
  result?: DailyReflectionResult
  confirmation_pending?: boolean
  confirmation_error?: string
}

export interface DailyReflectionAdmission extends ReflectionWindow {
  target_session: { channel_id: string; session_id: string; type: 'private' | 'group' }
  schedule_id: string
  trigger_id: string
}

export interface CompleteDailyReflectionParams extends ReflectionWindow {
  schedule_id: string
  trigger_id: string
}

export interface CompleteDailyReflectionResult {
  status: 'applied' | 'already_applied'
  watermark: string
}
