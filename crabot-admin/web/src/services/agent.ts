/**
 * Agent 服务
 */

import { api } from './api'
import type {
  AgentInstanceConfig,
  AgentLLMRequirementsResponse,
} from '../types'

// P6-D：动态 AgentImplementation/AgentInstance 的读写服务已退役。
// 唯一 core Agent 配置走 /agent/config；legacy 记录见 services/legacy-archive.ts。
export const agentService = {
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
