/**
 * Worker implementation 管理服务（P6-B §3.19.12 / protocol-agent-v3 §6.5）。
 * 类型逐字段对齐协议；不以 UI 自创字段名。
 */

import { api } from './api'

export type WorkerImplId = 'builtin' | 'claude-code' | 'codex'
export type CLIWorkerImplId = Exclude<WorkerImplId, 'builtin'>

export type WorkerConnectionConfig =
  | { mode: 'native_account' }
  | { mode: 'admin_provider'; provider_id: string; model_id: string }
  | { mode: 'existing_host' }

export interface WorkerImplementationPolicy {
  enabled: boolean
  preference?: string
  connection?: WorkerConnectionConfig
}

export interface WorkerImplementationConfig {
  revision: number
  default_impl: WorkerImplId
  implementations: Record<WorkerImplId, WorkerImplementationPolicy>
}

export interface WorkerConnectionCapability {
  mode: 'native_account' | 'admin_provider' | 'existing_host'
  translator_id: string
  translator_version: string
  cli_version_range: string
  provider_formats?: string[]
  endpoint_policy?: 'official_only' | 'custom_base_url'
  credential_transport: 'native_store' | 'process_env' | 'agent_runtime_file'
  model_selection: 'native_default' | 'explicit_model'
  credential_scope: 'managed' | 'runtime_user_home' | 'admin_runtime'
}

export interface WorkerImplementationStatus {
  impl: WorkerImplId
  installed: boolean
  version?: string
  install_source?: 'user'
  global_install_detected?: boolean
  connection_mode?: WorkerConnectionConfig['mode']
  credential_scope?: WorkerConnectionCapability['credential_scope']
  configured: boolean
  policy_revision: number
  connection_revision?: string
  translator?: WorkerConnectionCapability
  verification: 'never' | 'running' | 'passed' | 'failed' | 'grandfathered'
  verification_stale?: boolean
  degraded?: string
  ready: boolean
  capabilities: { fork: boolean; revive: boolean; goalMode: boolean; subagent: boolean; structuredTrace: boolean }
  connection_capabilities: WorkerConnectionCapability[]
  observed_at: string
  last_verified_at?: string
  detail?: string
}

/** §3.19.12.1 合并 GET 响应。 */
export interface GetWorkerImplementationsResult {
  config: WorkerImplementationConfig
  agent_status: 'available' | 'unavailable'
  agent_config_revision?: number
  statuses: WorkerImplementationStatus[]
  unavailable_reason?: string
}

export interface WorkerOperationView {
  operation_id: string
  state: string
  passed?: boolean
  version?: string
  detail?: string
}

export const workerManagementService = {
  /** 合并读：config + 实时 status + 不可用原因（Agent 挂了和没配置不再混淆）。 */
  async getAll(): Promise<GetWorkerImplementationsResult> {
    return api.get<GetWorkerImplementationsResult>('/agent/worker-implementations')
  },

  async putConfig(expectedRevision: number, config: { default_impl: WorkerImplId; implementations: Record<WorkerImplId, WorkerImplementationPolicy> }): Promise<WorkerImplementationConfig> {
    const result = await api.put<{ config: WorkerImplementationConfig }>('/agent/worker-implementations', {
      expected_revision: expectedRevision,
      config,
    })
    return result.config
  },

  async startVerify(impl: CLIWorkerImplId, expectedRevision: number): Promise<WorkerOperationView> {
    const result = await api.post<{ operation: WorkerOperationView }>(`/agent/worker-implementations/${impl}/verify`, {
      expected_revision: expectedRevision,
    })
    return result.operation
  },
}
