/** Canonical fields: protocol-workspaces. */
export interface WorkspaceRecord {
  workspace_id: string
  kind: 'project' | 'default'
  name: string
  description: string
  root: string
  source: 'managed' | 'existing'
  created_at: string
  last_used_at?: string
}
export interface WorkspaceUsage {
  status: 'pending' | 'measuring' | 'complete' | 'partial' | 'failed' | 'stale'
  measured_at?: string
  logical_bytes?: number
  allocated_bytes?: number
  file_count: number
  skipped_entries: number
}
export interface WorkspaceExecution {
  status: 'running' | 'idle' | 'unknown'
  observed_at?: string
  worker_count?: number
  running_worker_count?: number
}
export interface WorkspaceExecutionInventory {
  ready: boolean
  items: Record<string, WorkspaceExecution>
}
export interface WorkspaceSummary {
  workspace: WorkspaceRecord
  directory_status: 'ready' | 'missing' | 'unavailable'
  usage: WorkspaceUsage
  execution: WorkspaceExecution
}
export interface WorkspaceListResult {
  revision: number
  storage_root: string
  items: WorkspaceSummary[]
}
export interface WorkspaceCreateRequest {
  workspace_id: string
  name: string
  description?: string
  root?: string
}
export interface WorkspaceUpdateRequest {
  expected_revision: number
  name: string
  description: string
}
export interface WorkspaceRecordResult {
  revision: number
  workspace: WorkspaceRecord
}
export interface WorkspaceGetResult {
  revision: number
  item: WorkspaceSummary
}
export interface WorkspaceScanResult {
  workspace_id: string
  usage: WorkspaceUsage
}

export interface VerifyWorkspaceRelocationRequestParams {
  intent_id: string
  intent_sha256: string
}
export interface VerifyWorkspaceRelocationRequestResult {
  verified: true
  intent_id: string
  intent_sha256: string
}


export interface QuiesceWorkspaceRelocationWebParams {
  intent_id: string
  intent_sha256: string
}
export interface QuiesceWorkspaceRelocationWebResult {
  quiesced: true
  intent_id: string
  intent_sha256: string
}

export type WorkspaceRelocationFinalizationAction = 'prepare_web' | 'resume_web'
export interface WorkspaceRelocationFinalizationRequest {
  intent_id: string
  launch_id: string
  completion_sha256: string
}
export interface VerifyWorkspaceRelocationFinalizationParams {
  intent_id: string
  launch_id: string
  completion_sha256: string
  action: WorkspaceRelocationFinalizationAction
}
export interface VerifyWorkspaceRelocationFinalizationResult {
  verified: true
  intent_id: string
  intent_sha256: string
  launch_id: string
  launch_sha256: string
  completion_sha256: string
  action: WorkspaceRelocationFinalizationAction
}
export type PrepareWorkspaceRelocationCompletionParams = WorkspaceRelocationFinalizationRequest
export interface PrepareWorkspaceRelocationCompletionResult {
  prepared: true
  intent_id: string
  intent_sha256: string
  launch_id: string
  launch_sha256: string
  completion_sha256: string
}
export type ResumeWorkspaceRelocationWebParams = WorkspaceRelocationFinalizationRequest
export interface ResumeWorkspaceRelocationWebResult {
  resumed: true
  intent_id: string
  intent_sha256: string
  launch_id: string
  launch_sha256: string
  completion_sha256: string
}

export type WorkspaceRelocationCoordinatorAction = 'capture_workers' | 'stop_workers'
export interface VerifyWorkspaceRelocationCoordinatorParams {
  intent_id: string
  launch_id: string
  action: WorkspaceRelocationCoordinatorAction
}
export interface VerifyWorkspaceRelocationCoordinatorResult {
  verified: true
  intent_id: string
  intent_sha256: string
  launch_id: string
  launch_sha256: string
  action: WorkspaceRelocationCoordinatorAction
}

export interface VerifyWorkspaceRelocationRuntimeParams {
  intent_id: string
  launch_id: string
}
export interface VerifyWorkspaceRelocationRuntimeResult {
  verified: true
  intent_id: string
  intent_sha256: string
  launch_id: string
  launch_sha256: string
  root_selected_sha256: string
  instance_id: string
  module_id: 'crabot-agent'
  runtime_id: string
}
export type VerifyWorkspaceRelocationRootParams = VerifyWorkspaceRelocationRuntimeParams
export type VerifyWorkspaceRelocationRootResult = VerifyWorkspaceRelocationRuntimeResult

export type WorkspaceRelocationImplementation = 'builtin' | 'claude-code' | 'codex' | 'legacy'
export interface WorkspaceRelocationIncarnation {
  readonly incarnation_id: string
  readonly impl: WorkspaceRelocationImplementation
  readonly seq: number
  readonly workspace: string
  readonly started_at: string
  readonly forked_from?: number | string
  readonly query_id?: string
}
export interface WorkspaceRelocationWorker {
  readonly worker_id: string
  readonly manager_key: `${string}::${string}`
  readonly task_id: string
  readonly workspace_id?: string
  readonly incarnations: ReadonlyArray<WorkspaceRelocationIncarnation>
}
export interface CaptureWorkspaceRelocationWorkersParams {
  intent_id: string
  launch_id: string
}
export interface CaptureWorkspaceRelocationWorkersResult {
  workers: ReadonlyArray<WorkspaceRelocationWorker>
}

export type WorkspaceRelocationStopDispatch = 'dispatch' | 'observe'
export type WorkspaceRelocationStopStatus = 'submitted' | 'unknown' | 'unavailable'
export interface WorkspaceRelocationStopResult {
  readonly worker_id: string
  readonly incarnation_id: string
  readonly status: WorkspaceRelocationStopStatus
}
export interface PrepareWorkspaceRelocationWorkerStopsParams {
  intent_id: string
  launch_id: string
}
export interface PrepareWorkspaceRelocationWorkerStopsResult {
  dispatch: WorkspaceRelocationStopDispatch
}
export interface CompleteWorkspaceRelocationWorkerStopsParams {
  intent_id: string
  launch_id: string
  results: ReadonlyArray<WorkspaceRelocationStopResult>
}
export interface CompleteWorkspaceRelocationWorkerStopsResult {
  recorded: true
}

export interface StopWorkspaceRelocationWorkersParams {
  intent_id: string
  launch_id: string
}
export interface StopWorkspaceRelocationWorkersResult {
  dispatch: WorkspaceRelocationStopDispatch
  results: ReadonlyArray<WorkspaceRelocationStopResult>
}

/** Native process observation; protocol-agent-v3 §6.1. This is not an exit proof. */
export interface WorkerProcessIdentity {
  readonly pid: number
  readonly parent: number
  readonly started: string
  readonly owner: string
  readonly executable: string
}
export interface CaptureWorkspaceRelocationProcessesParams {
  intent_id: string
  launch_id: string
}
export interface CaptureWorkspaceRelocationProcessesResult {
  processes: ReadonlyArray<WorkerProcessIdentity>
}

export interface WorkspaceRecoveryRuntimePlan {
  schema_version: 1
  recovery_id: string
  launch_sha256: string
  root_selected_sha256: string
  modules: Array<{ module_id: 'crabot-agent' | 'memory-default'; runtime_id: string }>
  created_at: string
}

export interface VerifyWorkspaceRelocationRecoveryRequestParams {
  intent_id: string
  recovery_id: string
  completion_sha256: string
  finalizing_sha256: string
}
export interface VerifyWorkspaceRelocationRecoveryRequestResult {
  verified: true
  intent_id: string
  recovery_id: string
  completion_sha256: string
  finalizing_sha256: string
  instance_id: string
  admin_runtime_id: string
  mm_sha256: string
}
export type VerifyWorkspaceRelocationRecoveryAdmissionParams = VerifyWorkspaceRelocationRecoveryRequestParams
export type VerifyWorkspaceRelocationRecoveryAdmissionResult = VerifyWorkspaceRelocationRecoveryRequestResult
