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
    extra?: Record<string, unknown>
    /** 对外可达 base URL（admin handleGetAgentConfig 注入），供 worker 拼临时页面链接 */
    tmp_page_base_url?: string
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
   * 启动期加载配置：失败退避重试，耗尽预算才落 unconfigured 兜底。
   *
   * **为什么要重试**：MM 按 start_priority 串行 spawn（admin=10 / agent=20），间隔只有 1s
   * 且没有依赖声明，而 admin 要跑完整个 onStart()（loadData / 迁移 / 各 manager / web server）
   * 才 listen —— agent 启动时那一下 pull 必然 ECONNREFUSED。旧实现 pull 一次就放弃落
   * unconfigured；而 admin 侧的 push 兜底判据是「agent 已 register」，此刻还没注册 → 推不动，
   * 双向死锁，只能 kill -9 agent。重试把 pull 这条主路径等到 admin 就绪为止。
   *
   * **为什么可以等**：MM 的健康检查只覆盖 status==='running' 的模块
   * （crabot-core/src/index.ts:939-944），status 是 register 时才置的；spawn 后到 register
   * 之间是 'starting'，MM 既不探活也没有 spawn 超时。所以推迟 register 几十秒是安全的。
   *
   * **为什么必须走 pull 而不是靠 push**：admin 的 pushConfigToAgentModules 不下发
   * system_prompt / mcp_servers，靠 push 活过来的 agent 是空 prompt + 零 MCP。
   *
   * 默认预算 60s 覆盖 admin 完整 onStart 的冷启动窗口；单次退避封顶 2s，保证
   * 「admin listen」到「agent register」的额外延迟不超过一个退避间隔。
   * 参数仅为可测注入，生产用默认值。
   */
  static async loadWithRetry(
    rpcClient: RpcClient,
    adminEndpoint: string | undefined,
    options: { budgetMs?: number; initialDelayMs?: number; maxDelayMs?: number } = {}
  ): Promise<UnifiedAgentConfig> {
    const budgetMs = options.budgetMs ?? 60_000
    const initialDelayMs = options.initialDelayMs ?? 500
    const maxDelayMs = options.maxDelayMs ?? 2_000

    // endpoint 没配是环境问题，不是启动竞态，重试只会白等一个预算
    if (adminEndpoint) {
      const startedAt = Date.now()
      const deadline = startedAt + budgetMs
      let delay = initialDelayMs
      let attempts = 0
      let lastLoggedAt = 0
      let lastError = ''

      for (;;) {
        attempts += 1
        try {
          const config = await this.load('', rpcClient, adminEndpoint)
          if (attempts > 1) {
            console.log(
              `[ConfigLoader] Admin 就绪，第 ${attempts} 次拉取成功（等待 ${Math.round((Date.now() - startedAt) / 1000)}s）`
            )
          }
          return config
        } catch (error) {
          lastError = this.describeError(error)
          const now = Date.now()
          if (attempts === 1) {
            // 首次失败只打一行，说清楚在等谁、等多久，避免每次退避都刷屏
            console.warn(
              `[ConfigLoader] Admin 暂不可达（${lastError}），等待 Admin 就绪后重试（最长 ${Math.round(budgetMs / 1000)}s）`
            )
            lastLoggedAt = now
          } else if (now - lastLoggedAt >= 10_000) {
            console.warn(
              `[ConfigLoader] 仍在等待 Admin 就绪（已等 ${Math.round((now - startedAt) / 1000)}s，第 ${attempts} 次尝试）`
            )
            lastLoggedAt = now
          }
          if (now + delay >= deadline) break
          await new Promise((resolve) => setTimeout(resolve, delay))
          delay = Math.min(delay * 2, maxDelayMs)
        }
      }

      console.warn(
        `[ConfigLoader] Failed to load config from Admin: ${lastError}（${attempts} 次尝试，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）`
      )
    } else {
      console.warn('[ConfigLoader] Failed to load config from Admin: Admin endpoint not configured')
    }

    console.warn('Starting in unconfigured mode, waiting for config push from Admin...')
    return this.createUnconfiguredConfig()
  }

  /**
   * admin 未 listen 时 Node 22 的 happy-eyeballs 抛的是 AggregateError，其 message 为空字符串
   * ——旧日志里那句 `Failed to load config from Admin: ` 冒号后什么都没有就是它。
   * 这里退回 name/errors 让日志有信息量。
   */
  private static describeError(error: unknown): string {
    if (error instanceof Error) {
      if (error.message) return error.message
      const inner = (error as { errors?: unknown[] }).errors
      if (Array.isArray(inner) && inner.length > 0) {
        return inner.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')
      }
      return error.name
    }
    return String(error)
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
      ...(adminConfig.tmp_page_base_url ? { tmp_page_base_url: adminConfig.tmp_page_base_url } : {}),
      specialization: 'Unified agent with front and worker capabilities',
    }

    // 构造 UnifiedAgentConfig
    return {
      module_id: moduleId,
      module_type: 'agent',
      version: '0.2.0',
      protocol_version: '0.2.0',
      port: process.env.Crabot_PORT ? parseInt(process.env.Crabot_PORT, 10) : 19002,
      orchestration: {
        front_context_recent_messages_window_hours: 6,
        front_context_recent_messages_max_cap: 50,
        front_context_short_term_memory_window_hours: 12,
        front_context_short_term_memory_max_cap: 30,
        worker_recent_messages_window_hours: 4,
        worker_recent_messages_max_cap: 50,
        worker_short_term_memory_window_hours: 12,
        worker_short_term_memory_max_cap: 10,
        worker_long_term_memory_limit: 5,
        front_agent_timeout: 30,
        session_state_ttl: 3600,
        worker_config_refresh_interval: 60,
        front_agent_queue_max_length: 100,
        front_agent_queue_timeout: 300,
      },
      agent_config: agentConfig,
      extra: adminConfig.extra,
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
        front_context_recent_messages_window_hours: 6,
        front_context_recent_messages_max_cap: 50,
        front_context_short_term_memory_window_hours: 12,
        front_context_short_term_memory_max_cap: 30,
        worker_recent_messages_window_hours: 4,
        worker_recent_messages_max_cap: 50,
        worker_short_term_memory_window_hours: 12,
        worker_short_term_memory_max_cap: 10,
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