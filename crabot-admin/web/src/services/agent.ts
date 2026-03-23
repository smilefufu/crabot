/**
 * Agent 服务
 */

import { api } from './api'
import type {
  AgentInstance,
  AgentInstanceConfig,
  AgentImplementation,
  PaginatedResponse,
} from '../types'

interface AgentLLMRequirementsResponse {
  model_format: string
  requirements: Array<{
    key: string
    description: string
    required: boolean
    recommended_capabilities?: string[]
    used_by?: Array<'front' | 'worker'>
  }>
}

export const agentService = {
  async listInstances(): Promise<PaginatedResponse<AgentInstance>> {
    return api.get<PaginatedResponse<AgentInstance>>('/agent-instances')
  },

  async getInstance(id: string): Promise<AgentInstance> {
    return api.get<AgentInstance>(`/agent-instances/${id}`)
  },

  async getInstanceConfig(id: string): Promise<AgentInstanceConfig> {
    const response = await api.get<{ config: AgentInstanceConfig }>(`/agent-instances/${id}/config`)
    return response.config
  },

  async updateInstanceConfig(
    id: string,
    config: Partial<AgentInstanceConfig>
  ): Promise<AgentInstanceConfig> {
    return api.patch<AgentInstanceConfig>(
      `/agent-instances/${id}/config`,
      config
    )
  },

  async listImplementations(): Promise<PaginatedResponse<AgentImplementation>> {
    return api.get<PaginatedResponse<AgentImplementation>>('/agent-implementations')
  },

  async getLLMRequirements(): Promise<AgentLLMRequirementsResponse> {
    return api.get<AgentLLMRequirementsResponse>('/agent-llm-requirements')
  },

  /** 获取活跃 Agent 的配置（无需 instanceId） */
  async getConfig(): Promise<AgentInstanceConfig> {
    const response = await api.get<{ config: AgentInstanceConfig }>('/agent/config')
    return response.config
  },

  /** 更新活跃 Agent 的配置（无需 instanceId） */
  async updateConfig(config: Partial<AgentInstanceConfig>): Promise<AgentInstanceConfig> {
    const response = await api.patch<{ config: AgentInstanceConfig }>('/agent/config', config)
    return response.config
  },
}
