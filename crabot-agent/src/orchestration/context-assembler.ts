/**
 * Context Assembler - 上下文组装器
 *
 * 并行获取聊天历史、记忆、模块端点，组装 Agent 执行上下文
 *
 * @see protocol-agent-v2.md 3.2.2 FrontAgentContext
 * @see protocol-agent-v2.md 3.2.3 WorkerAgentContext
 */

import { isClaimCommand, isClaimSystemHint, type ModuleId, type SessionId, type RpcClient, type RpcTraceContext } from 'crabot-shared'
import type {
  OrchestrationConfig,
  FrontAgentContext,
  WorkerAgentContext,
  ChannelMessage,
  ShortTermMemoryEntry,
  TaskSummary,
  ResolvedModule,
  Friend,
  MemoryPermissions,
  RuntimeSceneProfile,
  SceneProfile,
  SceneIdentity,
  LiveTaskSnapshot,
} from '../types.js'
import { buildRuntimeSceneProfile } from './scene-profile-resolver.js'

interface AssembleParams {
  channel_id: ModuleId
  session_id: SessionId
  sender_id: string
  message: string
  friend_id?: string
  session_type?: 'private' | 'group'
  crab_display_name?: string
}

interface MemoryFetchParams {
  friendId?: string
  limit?: number
  minVisibility?: 'private' | 'internal' | 'public'
  accessibleScopes?: string[]
  sessionType?: 'private' | 'group'
}

type FetchShortTermMemoryParams = MemoryFetchParams

/**
 * 过滤 channel.history 里的认主类噪声：
 * - 用户发的 `/认主` `/pair` `/apply` 指令本身（admin 已拦截，agent 看到也只会鹦鹉学舌）
 * - admin 自动回出的引导话术（"渠道未认主..." 等）
 * 这些消息被注入 history 会让 LLM 误以为还要继续走"让用户去后台审批"流程。
 */
function filterChannelClaimNoise(message: ChannelMessage): boolean {
  if (message.content?.type !== 'text') return true
  const text = message.content.text
  return !isClaimCommand(text) && !isClaimSystemHint(text)
}

export class ContextAssembler {
  /**
   * 同进程读取 Worker 实时快照的回调（由 UnifiedAgent 注入）。
   * Worker 与 ContextAssembler 同属一个 Agent 进程，无需 RPC，函数引用直读 Map。
   */
  private getLiveSnapshot?: (taskId: string) => LiveTaskSnapshot | undefined

  constructor(
    private rpcClient: RpcClient,
    private moduleId: string,
    private config: OrchestrationConfig,
    private getAdminPort: () => number | Promise<number>,
    private getMemoryPort: () => number | Promise<number>
  ) {}

  /**
   * 由 UnifiedAgent 在 worker handler 实例化后调用，注入 live snapshot getter。
   * 注入式而非构造时传入：worker handler 创建晚于 ContextAssembler。
   */
  setLiveSnapshotProvider(getter: (taskId: string) => LiveTaskSnapshot | undefined): void {
    this.getLiveSnapshot = getter
  }

  /**
   * Trace 用：在 traceCtx 提供时把内部并行子任务包成子 span，方便定位耗时。
   * 没有 traceCtx 时直接执行 fn，0 开销。
   */
  private async withSubSpan<T>(
    traceCtx: RpcTraceContext | undefined,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!traceCtx) return fn()
    const span = traceCtx.traceStore.startSpan(traceCtx.traceId, {
      type: 'context_fetch',
      parent_span_id: traceCtx.parentSpanId,
      details: { label },
    })
    try {
      const result = await fn()
      traceCtx.traceStore.endSpan(traceCtx.traceId, span.span_id, 'completed')
      return result
    } catch (err) {
      traceCtx.traceStore.endSpan(traceCtx.traceId, span.span_id, 'failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  /**
   * 组装 Front Agent 上下文
   * @see protocol-agent-v2.md 3.2.2
   */
  async assembleFrontContext(
    params: AssembleParams,
    friend: Friend | undefined,
    memoryPermissions: MemoryPermissions,
    traceCtx?: RpcTraceContext,
  ): Promise<FrontAgentContext> {
    const sessionType = params.session_type ?? 'private'
    const [recentMessages, shortTermMemories, activeTasks, recentlyClosedTasks, sceneProfile] = await Promise.all([
      this.withSubSpan(traceCtx, 'fetch_recent_messages', () => this.fetchRecentMessages(
        params.session_id,
        params.channel_id,
        this.config.front_context_recent_messages_limit,
        sessionType
      )),
      this.withSubSpan(traceCtx, 'fetch_short_term_memory', () => this.fetchShortTermMemory({
        friendId: params.friend_id,
        limit: this.config.front_context_memory_limit,
        minVisibility: memoryPermissions.read_min_visibility,
        accessibleScopes: memoryPermissions.read_accessible_scopes,
        sessionType,
      })),
      this.withSubSpan(traceCtx, 'fetch_active_tasks', () => this.fetchActiveTasks()),
      this.withSubSpan(traceCtx, 'fetch_recently_closed_tasks', () => this.fetchRecentlyClosedTasks(params.channel_id, params.session_id, 5)),
      this.withSubSpan(traceCtx, 'resolve_scene_profile', () => this.resolveSceneProfile(params.channel_id, params.session_id, sessionType, params.friend_id)),
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
      ...(recentlyClosedTasks.length > 0 ? { recently_closed_tasks: recentlyClosedTasks } : {}),
      crab_display_name: params.crab_display_name,
      available_tools: [],
      ...(sceneProfile ? { scene_profile: sceneProfile } : {}),
    }
  }

  /**
   * 组装 Worker Agent 上下文
   * @see protocol-agent-v2.md 3.2.3
   */
  async assembleWorkerContext(
    params: AssembleParams,
    memoryPermissions: MemoryPermissions,
    traceCtx?: RpcTraceContext,
  ): Promise<WorkerAgentContext> {
    const workerSessionType = params.session_type ?? 'private'
    // long_term_memories 不在此处预 fetch：用消息原话当 query 召回质量差（短/抽象/无主题
    // 的指令性消息常见），而且 worker 已经有 crab-memory MCP 的 search_long_term tool，
    // 需要历史背景时由 worker 自己按需精准查。预填 + tool 双路径只会污染上下文。
    const [
      recentMessages,
      shortTermMemories,
      adminEndpoint,
      memoryEndpoint,
      channelEndpoints,
      sceneProfile,
    ] = await Promise.all([
      this.withSubSpan(traceCtx, 'fetch_recent_messages', () => this.fetchRecentMessages(
        params.session_id,
        params.channel_id,
        this.config.worker_recent_messages_limit,
        workerSessionType
      )),
      this.withSubSpan(traceCtx, 'fetch_short_term_memory', () => this.fetchShortTermMemory({
        friendId: params.friend_id,
        limit: this.config.worker_short_term_memory_limit,
        minVisibility: memoryPermissions.read_min_visibility,
        accessibleScopes: memoryPermissions.read_accessible_scopes,
        sessionType: workerSessionType,
      })),
      this.withSubSpan(traceCtx, 'resolve_admin_module', () => this.resolveModule('admin')),
      this.withSubSpan(traceCtx, 'resolve_memory_module', () => this.resolveModule('memory')),
      this.withSubSpan(traceCtx, 'resolve_channel_modules', () => this.resolveModules('channel')),
      this.withSubSpan(traceCtx, 'resolve_scene_profile', () => this.resolveSceneProfile(
        params.channel_id,
        params.session_id,
        workerSessionType,
        params.friend_id,
      )),
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
      long_term_memories: [],  // worker 用 search_long_term tool 按需查，不再预 fetch
      available_tools: [],
      admin_endpoint: adminEndpoint,
      memory_endpoint: memoryEndpoint,
      channel_endpoints: channelEndpoints,
      memory_permissions: {
        write_visibility: memoryPermissions.write_visibility,
        write_scopes: memoryPermissions.write_scopes,
      },
      ...(sceneProfile ? { scene_profile: sceneProfile } : {}),
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
        return result.messages.filter(filterChannelClaimNoise)
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
      // 注入 session 上下文，转换为 ChannelMessage，并过滤认主指令 + 引导话术
      return result.items
        .map((msg) => ({
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
        .filter(filterChannelClaimNoise)
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
        priority: t.priority,
        assigned_worker: t.assigned_worker,
        plan_summary: t.plan?.summary,
        latest_progress: this.extractLatestProgress(t.messages),
        source_channel_id: t.source.channel_id,
        source_session_id: t.source.session_id,
        updated_at: t.updated_at,
        // 飞行中状态：worker 同进程内存表，仅 status=executing 且本进程在跑时有值
        live: t.status === 'executing' ? this.getLiveSnapshot?.(t.id) : undefined,
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

  /**
   * 抓本 session 最近结束（completed / failed / aborted）的若干个任务，
   * 按 updated_at desc 排序。给 Front 用来识别"继续之前那个 ..."的指代。
   *
   * 注意：list_tasks 已经有 source_channel_id / source_friend_id 的过滤，但没有
   * source_session_id 过滤。这里先按 channel_id 拉一批，本地按 session_id 二次过滤。
   */
  private async fetchRecentlyClosedTasks(
    channelId: ModuleId,
    sessionId: SessionId,
    limit: number,
  ): Promise<TaskSummary[]> {
    try {
      const adminPort = await this.getAdminPort()
      const result = await this.rpcClient.call<
        { filter: { status: string[]; source_channel_id?: string }; pagination?: { page: number; page_size: number } },
        {
          items: Array<{
            id: string
            title: string
            status: string
            priority: string
            assigned_worker?: string
            plan?: { summary?: string }
            source: { channel_id?: string; session_id?: string }
            messages?: Array<{ content: string; timestamp: string }>
            updated_at?: string
            result?: { summary?: string; final_reply?: { text?: string } }
          }>
        }
      >(
        adminPort,
        'list_tasks',
        {
          filter: { status: ['completed', 'failed', 'aborted'], source_channel_id: channelId },
          pagination: { page: 1, page_size: 50 },
        },
        this.moduleId
      )
      return result.items
        .filter(t => t.source.session_id === sessionId)
        .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
        .slice(0, limit)
        .map(t => ({
          task_id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          assigned_worker: t.assigned_worker,
          plan_summary: t.plan?.summary,
          // 已结束任务的"latest_progress"用 result.summary 比 messages 末条更精准
          latest_progress: t.result?.summary
            ? (t.result.summary.length > 100 ? t.result.summary.slice(0, 100) + '...' : t.result.summary)
            : this.extractLatestProgress(t.messages),
          source_channel_id: t.source.channel_id,
          source_session_id: t.source.session_id,
          updated_at: t.updated_at,
        }))
    } catch {
      return []
    }
  }

  // ==========================================================================
  // 场景画像
  // ==========================================================================

  /**
   * 解析当前会话的 RuntimeSceneProfile。
   * - 失败一律返回 null（不阻塞上下文组装）
   * - METHOD_NOT_FOUND 容忍（对接 Memory v0.1.0 旧版本）
   */
  private async resolveSceneProfile(
    channelId: ModuleId,
    sessionId: SessionId,
    sessionType: 'private' | 'group',
    friendId: string | undefined,
  ): Promise<RuntimeSceneProfile | null> {
    try {
      const memoryPort = await this.getMemoryPort()

      let scene: SceneIdentity | null = null
      if (sessionType === 'group') {
        scene = { type: 'group_session', channel_id: channelId, session_id: sessionId }
      } else if (friendId) {
        scene = { type: 'friend', friend_id: friendId }
      }
      if (!scene) return null

      const resp = await this.rpcClient.call<
        { scene: SceneIdentity },
        { profile: SceneProfile | null }
      >(memoryPort, 'get_scene_profile', { scene }, this.moduleId)

      return buildRuntimeSceneProfile(resp?.profile ?? null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Method not found') || msg.includes('METHOD_NOT_FOUND')) {
        return null
      }
      console.warn(`[${this.moduleId}] resolveSceneProfile failed:`, err)
      return null
    }
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
