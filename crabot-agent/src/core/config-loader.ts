/**
 * Config Loader - 配置加载器
 *
 * 从 Admin 获取配置。Admin 是唯一的配置来源，获取失败则报错。
 */

import type { RpcClient } from 'crabot-shared'
import type {
  UnifiedAgentConfig,
  AgentLayerConfig,
  LLMConnectionInfo,
  MCPServerConfig,
  SkillConfig,
} from '../types.js'

// ============================================================================
// Admin RPC 接口类型
// ============================================================================

interface GetAgentConfigResult {
  config: {
    instance_id: string
    role: 'front' | 'worker'
    system_prompt: string
    model_config: Record<string, LLMConnectionInfo>
    mcp_servers?: MCPServerConfig[]
    skills?: SkillConfig[]
    max_iterations?: number
    tools_readonly?: boolean
  }
}

// ============================================================================
// ConfigLoader
// ============================================================================

export class ConfigLoader {
  /**
   * 加载配置
   * Admin 是唯一的配置来源，获取失败则报错
   */
  static async load(
    _configPath: string,
    rpcClient: RpcClient,
    adminEndpoint?: string
  ): Promise<UnifiedAgentConfig> {
    const moduleId = process.env.Crabot_MODULE_ID || 'crabot-agent'

    if (!adminEndpoint) {
      throw new Error('[ConfigLoader] Admin endpoint not configured. Agent cannot start without Admin.')
    }

    const config = await this.loadFromAdmin(moduleId, rpcClient, adminEndpoint)
    console.log(`[ConfigLoader] Loaded config from Admin for ${moduleId}`)
    return config
  }

  /**
   * 从 Admin 获取配置
   */
  private static async loadFromAdmin(
    moduleId: string,
    rpcClient: RpcClient,
    adminEndpoint: string
  ): Promise<UnifiedAgentConfig> {
    const adminPort = this.parsePortFromEndpoint(adminEndpoint)
    if (!adminPort) {
      throw new Error(`[ConfigLoader] Invalid admin endpoint: ${adminEndpoint}`)
    }

    const result = await rpcClient.call<
      { instance_id: string },
      GetAgentConfigResult
    >(
      adminPort,
      'get_agent_config',
      { instance_id: moduleId },
      moduleId
    )

    return this.convertAdminConfigToLocal(result.config, moduleId)
  }

  /**
   * 将 Admin 的 AgentInstanceConfig 转换为 UnifiedAgentConfig
   */
  private static convertAdminConfigToLocal(
    adminConfig: GetAgentConfigResult['config'],
    moduleId: string
  ): UnifiedAgentConfig {
    // 构造 AgentLayerConfig
    const agentConfig: AgentLayerConfig = {
      instance_id: adminConfig.instance_id,
      roles: ['front', 'worker'],
      system_prompt: adminConfig.system_prompt,
      model_config: adminConfig.model_config,
      max_iterations: adminConfig.max_iterations,
      mcp_servers: adminConfig.mcp_servers,
      skills: adminConfig.skills,
      tools_readonly: adminConfig.tools_readonly,
      specialization: 'Unified agent with front and worker capabilities',
      supported_task_types: ['general'],
    }

    // 构造 UnifiedAgentConfig
    return {
      module_id: moduleId,
      module_type: 'agent',
      version: '0.2.0',
      protocol_version: '0.2.0',
      port: process.env.Crabot_PORT ? parseInt(process.env.Crabot_PORT, 10) : 19002,
      orchestration: {
        admin_config_path: process.env.DATA_DIR || './data',
        front_context_recent_messages_limit: 20,
        front_context_memory_limit: 5,
        worker_recent_messages_limit: 20,
        worker_short_term_memory_limit: 10,
        worker_long_term_memory_limit: 5,
        front_agent_timeout: 30,
        session_state_ttl: 3600,
        worker_config_refresh_interval: 60,
        front_agent_queue_max_length: 100,
        front_agent_queue_timeout: 300,
      },
      agent_config: agentConfig,
    }
  }

  /**
   * 创建未配置状态的默认配置
   * 协议 §7.4: Agent 在 LLM 未配置时正常启动，等待 Admin 推送配置
   */
  static createUnconfiguredConfig(): UnifiedAgentConfig {
    const moduleId = process.env.Crabot_MODULE_ID || 'crabot-agent'
    return {
      module_id: moduleId,
      module_type: 'agent',
      version: '0.2.0',
      protocol_version: '0.2.0',
      port: process.env.Crabot_PORT ? parseInt(process.env.Crabot_PORT, 10) : 19002,
      orchestration: {
        admin_config_path: process.env.DATA_DIR || './data',
        front_context_recent_messages_limit: 20,
        front_context_memory_limit: 5,
        worker_recent_messages_limit: 20,
        worker_short_term_memory_limit: 10,
        worker_long_term_memory_limit: 5,
        front_agent_timeout: 30,
        session_state_ttl: 3600,
        worker_config_refresh_interval: 60,
        front_agent_queue_max_length: 100,
        front_agent_queue_timeout: 300,
      },
      agent_config: {
        instance_id: moduleId,
        roles: ['front', 'worker'],
        system_prompt: '',
        model_config: {},
        specialization: 'Unified agent with front and worker capabilities',
        supported_task_types: ['general'],
      },
    }
  }

  /**
   * 从 endpoint URL 解析端口
   */
  private static parsePortFromEndpoint(endpoint: string): number | null {
    try {
      const url = new URL(endpoint)
      const port = parseInt(url.port, 10)
      return isNaN(port) ? null : port
    } catch {
      // 如果不是完整 URL，尝试直接解析端口
      const match = endpoint.match(/:(\d+)/)
      if (match) {
        const port = parseInt(match[1], 10)
        return isNaN(port) ? null : port
      }
      return null
    }
  }
}