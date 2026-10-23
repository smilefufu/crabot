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
export interface WorkspaceMaintenanceStatus {
  maintenance: boolean
}

export interface WorkspaceRelocationPreviewRequest {
  target: string
}
export interface WorkspaceRelocationIssue {
  path: string
  reason: 'absolute_link' | 'external_link' | 'git_worktree' | 'python_environment' | 'external_hardlink' | 'mount_point' | 'special_file' | 'unreadable'
}
export interface WorkspaceRelocationPreviewResult {
  revision: number
  source: string
  target: string
  mode: 'unchanged' | 'rename' | 'copy'
  workspaces: WorkspaceRecord[]
  retained_workspaces: WorkspaceRecord[]
  usage?: WorkspaceUsage
  available_bytes?: string
  issues: WorkspaceRelocationIssue[]
  execution: WorkspaceExecutionInventory
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

export interface VerifyWorkspaceRelocationStartParams {
  intent_id: string
  target: string
  expected_revision: number
  confirmed: true
}
export interface VerifyWorkspaceRelocationStartResult extends VerifyWorkspaceRelocationStartParams {
  verified: true
}

export interface WorkspaceRelocationAccepted {
  intent_id: string
  accepted: true
}
export interface WorkspaceRelocationUnchanged {
  source: string
  unchanged: true
}
export type WorkspaceRelocationStartResult = WorkspaceRelocationAccepted | WorkspaceRelocationUnchanged

export interface WorkspaceRelocationJobQuery {
  intent_id?: string
}
export interface VerifyWorkspaceRelocationJobQueryResult extends WorkspaceRelocationJobQuery {
  verified: true
}
export type WorkspaceRelocationJobStage = 'preparing' | 'stopping' | 'moving' | 'closing_executors' | 'switching' | 'validating' | 'finalizing' | 'restoring' | 'finished' | 'unknown'
export interface WorkspaceRelocationJobStatus {
  intent_id: string
  state: 'preparing' | 'running' | 'completed' | 'needs_attention' | 'committed'
  stage: WorkspaceRelocationJobStage
  source?: string
  target?: string
}
export interface WorkspaceRelocationStatusResult {
  available: boolean
  job: WorkspaceRelocationJobStatus | null
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
export interface WorkspaceRelocationRecoveryOffer {
  intent_id: string
  completion_sha256: string
  finalizing_sha256: string
}
export interface WorkspaceRelocationRecoveryPreviewResult {
  available: boolean
  recovery: WorkspaceRelocationRecoveryOffer | null
}
export interface StartWorkspaceRelocationRecoveryParams extends VerifyWorkspaceRelocationRecoveryRequestParams {
  confirmed: true
}
export interface WorkspaceRelocationRecoveryAccepted {
  intent_id: string
  recovery_id: string
  accepted: true
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

export type VerifyWorkspaceRelocationRecoveryRuntimeParams = VerifyWorkspaceRelocationRecoveryRequestParams
export interface VerifyWorkspaceRelocationRecoveryRuntimeResult {
  verified: true
  intent_id: string
  recovery_id: string
  completion_sha256: string
  finalizing_sha256: string
  launch_sha256: string
  plan_sha256: string
  root_selected_sha256: string
  instance_id: string
  module_id: 'crabot-agent'
  runtime_id: string
}
export type VerifyWorkspaceRelocationRecoveryRootParams = VerifyWorkspaceRelocationRecoveryRuntimeParams
export type VerifyWorkspaceRelocationRecoveryRootResult = VerifyWorkspaceRelocationRecoveryRuntimeResult

export interface VerifyWorkspaceRelocationRecoveryFinalizationParams {
  action: WorkspaceRelocationFinalizationAction
}
export interface VerifyWorkspaceRelocationRecoveryFinalizationResult {
  verified: true
  intent_id: string
  recovery_id: string
  completion_sha256: string
  finalizing_sha256: string
  launch_sha256: string
  plan_sha256: string
  instance_id: string
  admin_runtime_id: string
  action: WorkspaceRelocationFinalizationAction
}
export type PrepareWorkspaceRelocationRecoveryCompletionParams = VerifyWorkspaceRelocationRecoveryRequestParams
export interface PrepareWorkspaceRelocationRecoveryCompletionResult {
  prepared: true
  intent_id: string
  recovery_id: string
  completion_sha256: string
  finalizing_sha256: string
  launch_sha256: string
  plan_sha256: string
  instance_id: string
  admin_runtime_id: string
}

export type VerifyWorkspaceRelocationRecoveryReleaseParams = VerifyWorkspaceRelocationRecoveryRequestParams
export type VerifyWorkspaceRelocationRecoveryReleaseResult = Omit<VerifyWorkspaceRelocationRecoveryFinalizationResult, 'action'>
export type ReleaseWorkspaceRelocationRecoveryCompletionResult = Omit<PrepareWorkspaceRelocationRecoveryCompletionResult, 'prepared'> & { released: true }

export type ResumeWorkspaceRelocationRecoveryWebParams = VerifyWorkspaceRelocationRecoveryRequestParams
export type ResumeWorkspaceRelocationRecoveryWebResult = Omit<PrepareWorkspaceRelocationRecoveryCompletionResult, 'prepared'> & { resumed: true }

export interface WorkspaceRecoveryRuntimeRegistration {
  schema_version: 1
  instance_id: string
  runtime_id: string
  module_id: string
  root_pid: number
  process_start_identity: string
  module_port: number
  created_at: string
}
export interface WorkspaceRecoveryRuntimeStart {
  schema_version: 1
  recovery_id: string
  plan_sha256: string
  definition_sha256: string
  parent: WorkerProcessIdentity
  process: WorkerProcessIdentity
  runtime: WorkspaceRecoveryRuntimeRegistration
  created_at: string
}
export interface WorkspaceRecoveryRuntimeInvocation {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}
