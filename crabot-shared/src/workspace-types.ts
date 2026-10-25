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
