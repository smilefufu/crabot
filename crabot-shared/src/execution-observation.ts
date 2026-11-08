export interface ExecutionObservation {
  schema_version: 1
  policy_version: 1
  state: 'planned' | 'assembled' | 'legacy_unknown'
  role: 'manager' | 'worker' | 'child'
  impl: 'builtin' | 'claude-code' | 'codex' | 'manager'
  worker_id?: string
  incarnation_id?: string
  subagent_id?: string
  observed_at: string | null
  revision: string | null
  source: 'execution_plan' | 'manager_request' | 'builtin_request' | 'cli_provision' | 'legacy'
  tools: string[] | null
  child_profiles: string[]
  mcp_servers: string[]
  skills: string[]
  native_tools: null
  resources?: ExecutionResources
  constraints: string[]
}

export interface ExecutionResources {
  declared: { cpu: number | null; memory_bytes: number | null }
  observed: { visible_cpu_count: number; cpu_quota: number | null; memory_bytes: number | null }
  effective: { cpu_count: number; memory_bytes: number | null }
  protection: 'unprotected' | 'cgroup_v2' | 'unavailable'
}
