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
  install_source?: 'managed' | 'system'
  connection_mode?: WorkerConnectionConfig['mode']
  credential_scope?: WorkerConnectionCapability['credential_scope']
  configured: boolean
  policy_revision: number
  connection_revision?: string
  translator?: WorkerConnectionCapability
  verification: 'never' | 'running' | 'passed' | 'failed' | 'grandfathered'
  ready: boolean
  capabilities: { fork: boolean; revive: boolean; goalMode: boolean; subagent: boolean; structuredTrace: boolean }
  connection_capabilities: WorkerConnectionCapability[]
  observed_at: string
  last_verified_at?: string
  detail?: string
}

export const workerManagementService = {
  async getConfig(): Promise<WorkerImplementationConfig> {
    return api.get<WorkerImplementationConfig>('/agent/worker-implementations')
  },

  async putConfig(expectedRevision: number, implementations: Record<WorkerImplId, WorkerImplementationPolicy>): Promise<WorkerImplementationConfig> {
    return api.put<WorkerImplementationConfig>('/agent/worker-implementations', {
      expected_revision: expectedRevision,
      implementations,
    })
  },

  async listStatus(): Promise<WorkerImplementationStatus[]> {
    const result = await api.get<{ items: WorkerImplementationStatus[] }>('/agent/worker-implementations/status')
    return result.items
  },

  async startOperation(impl: CLIWorkerImplId, action: 'install' | 'verify', expectedRevision: number): Promise<{
    operation_id: string
    state: string
    passed?: boolean
    version?: string
    detail?: string
  }> {
    return api.post(`/agent/worker-implementations/${impl}/operations`, {
      action,
      expected_revision: expectedRevision,
    })
  },
}
