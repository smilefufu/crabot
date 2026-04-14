/**
 * Context Assembler - 上下文组装器
 *
 * 并行获取聊天历史、记忆、模块端点，组装 Agent 执行上下文
 *
 * @see protocol-agent-v2.md 3.2.2 FrontAgentContext
 * @see protocol-agent-v2.md 3.2.3 WorkerAgentContext
 */

import type { ModuleId, SessionId, RpcClient } from 'crabot-shared'
import type {
  OrchestrationConfig,
  FrontAgentContext,
  WorkerAgentContext,
  ChannelMessage,
  ShortTermMemoryEntry,
  LongTermL0Entry,
  TaskSummary,
  ResolvedModule,
  Friend,
  MemoryPermissions,
} from '../types.js'

interface AssembleParams {
  channel_id: ModuleId
  session_id: SessionId
  sender_id: string
  message: string
  friend_id?: string
  session_type?: 'private' | 'group'
  crab_display_name?: string
}

interface FetchShortTermMemoryParams {
  friendId?: string
  limit?: number
  minVisibility?: 'private' | 'internal' | 'public'
  accessibleScopes?: string[]
  sessionType?: 'private' | 'group'
}

interface FetchLongTermMemoryParams {
  friendId?: string
  query?: string
  limit?: number
  sessionType?: 'private' | 'group'
}

export class ContextAssembler {
  constructor(
    private rpcClient: RpcClient,
    private moduleId: string,
    private config: OrchestrationConfig,
    private getAdminPort: () => number | Promise<number>,
    private getMemoryPort: () => number | Promise<number>
  ) {}

  /**
   * 组装 Front Agent 上下文
   * @see protocol-agent-v2.md 3.2.2
   */
  async assembleFrontContext(
    params: AssembleParams,
    friend: Friend | undefined,
    memoryPermissions: MemoryPermissions
  ): Promise<FrontAgentContext> {
    const sessionType = params.session_type ?? 'private'
    const [recentMessages, shortTermMemories, activeTasks] = await Promise.all([
      this.fetchRecentMessages(
        params.session_id,
        params.channel_id,
        this.config.front_context_recent_messages_limit,
        sessionType
      ),
      this.fetchShortTermMemory({
        friendId: params.friend_id,
        limit: this.config.front_context_memory_limit,
        minVisibility: memoryPermissions.read_min_visibility,
        accessibleScopes: memoryPermissions.read_accessible_scopes,
        sessionType,
      }),
      this.fetchActiveTasks(),
    ])

    return {
      sender_friend: friend ?? {
        id: params.sender_id,
        display_name: params.sender_id,
        permission: 'master',
        channel_identities: [],
        created_at: '',
        updated_at: '',
      },
      recent_messages: recentMessages,
      short_term_memories: shortTermMemories,
      active_tasks: activeTasks,
      crab_display_name: params.crab_display_name,
      available_tools: [],
    }
  }

  /**
   * 组装 Worker Agent 上下文
   * @see protocol-agent-v2.md 3.2.3
   */
  async assembleWorkerContext(
    params: AssembleParams,
    memoryPermissions: MemoryPermissions
  ): Promise<WorkerAgentContext> {
    const workerSessionType = params.session_type ?? 'private'
    const [recentMessages, shortTermMemories, longTermMemories, adminEndpoint, memoryEndpoint, channelEndpoints] =
      await Promise.all([
        this.fetchRecentMessages(
          params.session_id,
          params.channel_id,
          this.config.worker_recent_messages_limit,
          workerSessionType
        ),
        this.fetchShortTermMemory({
          friendId: params.friend_id,
          limit: this.config.worker_short_term_memory_limit,
          minVisibility: memoryPermissions.read_min_visibility,
          accessibleScopes: memoryPermissions.read_accessible_scopes,
          sessionType: workerSessionType,
        }),
        this.fetchLongTermMemory({
          friendId: params.friend_id,
          query: params.message,
          limit: this.config.worker_long_term_memory_limit,
          sessionType: workerSessionType,
        }),
        this.resolveModule('admin'),
        this.resolveModule('memory'),
        this.resolveModules('channel'),
      ])

    return {
      task_origin: {
        channel_id: params.channel_id,
        session_id: params.session_id,
        friend_id: params.friend_id,
        session_type: params.session_type,
      },
      recent_messages: recentMessages,
      short_term_memories: shortTermMemories,
      long_term_memories: longTermMemories,
      available_tools: [],
      admin_endpoint: adminEndpoint,
      memory_endpoint: memoryEndpoint,
      channel_endpoints: channelEndpoints,
      memory_permissions: {
        write_visibility: memoryPermissions.write_visibility,
        write_scopes: memoryPermissions.write_scopes,
      },
    }
  }

  /**
   * 组装调度任务上下文 — 不依赖 channel/session/friend
   */
  async assembleScheduledTaskContext(): Promise<WorkerAgentContext> {
    const [adminEndpoint, memoryEndpoint, channelEndpoints] = await Promise.all([
      this.resolveModule('admin'),
      this.resolveModule('memory'),
      this.resolveModules('channel'),
    ])

    return {
      short_term_memories: [],
      long_term_memories: [],
      available_tools: [],
      admin_endpoint: adminEndpoint,
      memory_endpoint: memoryEndpoint,
      channel_endpoints: channelEndpoints,
      memory_permissions: {
        write_visibility: 'internal',
        write_scopes: [],
      },
    }
  }

  // ==========================================================================
  // 数据获取
  // ==========================================================================

  private async fetchRecentMessages(
    sessionId: SessionId,
    channelId: ModuleId,
    limit: number,
    sessionType: 'private' | 'group' = 'private'
  ): Promise<ChannelMessage[]> {
    try {
      // admin-web 频道：从 Admin 的 get_chat_history RPC 获取（无 Channel 模块）
      if (channelId === 'admin-web') {
        const adminPort = await this.getAdminPort()
        const result = await this.rpcClient.call<
          { limit: number; before?: string },
          { messages: ChannelMessage[] }
        >(adminPort, 'get_chat_history', { limit }, this.moduleId)
        return result.messages
      }

      // 其他 Channel：通过 Module Manager 解析 Channel 模块并调用 get_history
      const modules = await this.rpcClient.resolve({ module_id: channelId }, this.moduleId)
      if (modules.length === 0) return []

      const channelPort = modules[0].port
      const result = await this.rpcClient.call<
        { session_id: SessionId; limit: number },
        { items: Array<{
          platform_message_id: string
          sender: { friend_id?: string; platform_user_id: string; platform_display_name: string }
          content: { type: string; text?: string; media_url?: string }
          features: { is_mention_crab: boolean }
          platform_timestamp: string
        }> }
      >(
        channelPort,
        'get_history',
        { session_id: sessionId, limit },
        this.moduleId
      )
      // 注入 session 上下文，转换为 ChannelMessage
      return result.items.map((msg) => ({
        platform_message_id: msg.platform_message_id,
        session: {
          session_id: sessionId,
          channel_id: channelId,
          type: sessionType,
        },
        sender: {
          friend_id: msg.sender.friend_id,
          platform_user_id: msg.sender.platform_user_id,
          platform_display_name: msg.sender.platform_display_name,
        },
        content: {
          type: msg.content.type as 'text' | 'image' | 'file',
          text: msg.content.text,
          media_url: msg.content.media_url,
        },
        features: {
          is_mention_crab: msg.features.is_mention_crab,
        },
        platform_timestamp: msg.platform_timestamp,
      }))
    } catch {
      return []
    }
  }

  private async fetchShortTermMemory(params: FetchShortTermMemoryParams): Promise<ShortTermMemoryEntry[]> {
    const { friendId, limit, minVisibility = 'public', accessibleScopes, sessionType = 'private' } = params

    // 私聊需要 friendId 做个人记忆过滤；群聊靠 scope 隔离，不需要 friendId
    if (sessionType === 'private' && !friendId) return []

    try {
      const memoryPort = await this.getMemoryPort()

      // 群聊：不按 friend_id 过滤，仅靠 accessible_scopes 隔离
      // 私聊：按 friend_id 过滤，只看到个人相关的记忆
      const filter = sessionType === 'group'
        ? undefined
        : { refs: { friend_id: friendId! } }

      const result = await this.rpcClient.call<
        {
          filter?: { refs?: Record<string, string> }
          sort_by?: string
          limit?: number
          min_visibility?: string
          accessible_scopes?: string[]
        },
        { results: ShortTermMemoryEntry[] }
      >(
        memoryPort,
        'search_short_term',
        {
          ...(filter && { filter }),
          sort_by: 'event_time',
          limit: limit ?? this.config.worker_short_term_memory_limit,
          min_visibility: minVisibility,
          ...(accessibleScopes !== undefined && { accessible_scopes: accessibleScopes }),
        },
        this.moduleId
      )
      return result.results
    } catch {
      return []
    }
  }

  private async fetchLongTermMemory(params: FetchLongTermMemoryParams): Promise<LongTermL0Entry[]> {
    const { friendId, query, limit, sessionType = 'private' } = params

    if (!query) return []
    if (sessionType === 'private' && !friendId) return []

    try {
      const memoryPort = await this.getMemoryPort()

      // 私聊：按 friend 关联的实体过滤
      // 群聊：不按 entity_id 过滤，靠 scope 隔离
      const filter = sessionType === 'group'
        ? {}
        : { entity_id: friendId }

      const result = await this.rpcClient.call<
        {
          query: string
          detail: string
          limit?: number
          filter?: { entity_id?: string }
        },
        { results: Array<{ memory: LongTermL0Entry; relevance: number }> }
      >(
        memoryPort,
        'search_long_term',
        {
          query,
          detail: 'L0',
          limit: limit ?? this.config.worker_long_term_memory_limit,
          filter,
        },
        this.moduleId
      )
      return result.results.map((r) => r.memory)
    } catch {
      return []
    }
  }

  private async fetchActiveTasks(): Promise<TaskSummary[]> {
    try {
      const adminPort = await this.getAdminPort()
      const result = await this.rpcClient.call<
        { filter: { status: string[] } },
        {
          items: Array<{
            id: string
            title: string
            status: string
            type: string
            priority: string
            assigned_worker?: string
            plan?: { summary?: string }
            source: { channel_id?: string; session_id?: string }
            messages?: Array<{ content: string; timestamp: string }>
            updated_at?: string
          }>
        }
      >(
        adminPort,
        'list_tasks',
        { filter: { status: ['pending', 'planning', 'executing', 'waiting_human'] } },
        this.moduleId
      )
      return result.items.map(t => ({
        task_id: t.id,
        title: t.title,
        status: t.status,
        task_type: t.type,
        priority: t.priority,
        assigned_worker: t.assigned_worker,
        plan_summary: t.plan?.summary,
        latest_progress: this.extractLatestProgress(t.messages),
        source_channel_id: t.source.channel_id,
        source_session_id: t.source.session_id,
        updated_at: t.updated_at,
      }))
    } catch {
      return []
    }
  }

  private extractLatestProgress(
    messages?: Array<{ content: string; timestamp: string }>
  ): string | undefined {
    if (!messages || messages.length === 0) return undefined
    const last = messages[messages.length - 1]
    return last.content.length > 100 ? last.content.slice(0, 100) + '...' : last.content
  }

  // ==========================================================================
  // 模块解析
  // ==========================================================================

  private async resolveModule(moduleType: string): Promise<ResolvedModule> {
    try {
      const modules = await this.rpcClient.resolve({ module_type: moduleType }, this.moduleId)
      if (modules.length > 0) {
        return {
          module_id: modules[0].module_id,
          port: modules[0].port,
        }
      }
    } catch {
      // 解析失败，返回空模块
    }
    return { module_id: '', port: 0 }
  }

  private async resolveModules(moduleType: string): Promise<ResolvedModule[]> {
    try {
      const modules = await this.rpcClient.resolve({ module_type: moduleType }, this.moduleId)
      return modules.map((m) => ({
        module_id: m.module_id,
        port: m.port,
      }))
    } catch {
      return []
    }
  }
}
