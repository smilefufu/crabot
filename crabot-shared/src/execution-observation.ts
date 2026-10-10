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
  constraints: string[]
}
