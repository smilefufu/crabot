/**
 * Config Loader - 配置加载器
 *
 * 支持从 Admin 获取配置，失败则回退到本地 YAML 配置
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import type { RpcClient } from './module-base.js'
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
   * 优先从 Admin 获取，失败则回退到本地配置
   */
  static async load(
    configPath: string,
    rpcClient: RpcClient,
    adminEndpoint?: string
  ): Promise<UnifiedAgentConfig> {
    const moduleId = process.env.Crabot_MODULE_ID || 'crabot-agent'

    // 如果配置了 Admin endpoint，尝试从 Admin 获取配置
    if (adminEndpoint) {
      const adminConfig = await this.loadFromAdmin(moduleId, rpcClient, adminEndpoint)
      if (adminConfig) {
        console.log(`[ConfigLoader] Loaded config from Admin for ${moduleId}`)
        return adminConfig
      }
    }

    // 回退到本地 YAML 配置
    console.log(`[ConfigLoader] Loading config from local file: ${configPath}`)
    return this.loadFromYaml(configPath)
  }

  /**
   * 从 Admin 获取配置
   */
  private static async loadFromAdmin(
    moduleId: string,
    rpcClient: RpcClient,
    adminEndpoint: string
  ): Promise<UnifiedAgentConfig | null> {
    try {
      // 解析 Admin 端口
      const adminPort = this.parsePortFromEndpoint(adminEndpoint)
      if (!adminPort) {
        console.warn(`[ConfigLoader] Invalid admin endpoint: ${adminEndpoint}`)
        return null
      }

      // 调用 Admin 的 get_agent_config RPC 方法
      const result = await rpcClient.call<
        { instance_id: string },
        GetAgentConfigResult
      >(
        adminPort,
        'get_agent_config',
        { instance_id: moduleId },
        moduleId
      )

      // 将 Admin 配置转换为 UnifiedAgentConfig
      return this.convertAdminConfigToLocal(result.config, moduleId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[ConfigLoader] Failed to load config from Admin: ${message}`)
      return null
    }
  }

  /**
   * 从本地 YAML 文件加载配置
   */
  private static loadFromYaml(configPath: string): UnifiedAgentConfig {
    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`)
    }

    const configContent = fs.readFileSync(configPath, 'utf-8')

    // 替换环境变量
    const expandedConfig = configContent.replace(/\$\{(\w+)\}/g, (_, varName) => {
      return process.env[varName] || ''
    })

    const config = yaml.load(expandedConfig) as UnifiedAgentConfig

    // 验证必需的配置
    if (!config.module_id) {
      config.module_id = process.env.Crabot_MODULE_ID || 'crabot-agent'
    }
    if (!config.port && process.env.Crabot_PORT) {
      config.port = parseInt(process.env.Crabot_PORT, 10)
    }

    return config
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
        worker_recent_messages_limit: 50,
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