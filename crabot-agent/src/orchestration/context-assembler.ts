/**
 * Context Assembler - 上下文组装器
 *
 * 并行获取聊天历史、记忆、模块端点，组装 Agent 执行上下文
 *
 * @see protocol-agent-v2.md 3.2.2 FrontAgentContext
 * @see protocol-agent-v2.md 3.2.3 WorkerAgentContext
 */

import {
  isLegacyUnclaimedHint,
  isLegacyAlreadyClaimedHint,
  isSlashSystemResponse,
  type ModuleId,
  type SessionId,
  type RpcClient,
  type RpcTraceContext,
} from 'crabot-shared'
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
  crab_self_handle?: string
}

interface MemoryFetchParams {
  friendId?: string
  windowHours: number
  maxCap: number
  minVisibility?: 'private' | 'internal' | 'public'
  accessibleScopes?: string[]
  sessionType?: 'private' | 'group'
  excludeChannelId?: string
  excludeSessionId?: string
}

type FetchShortTermMemoryParams = MemoryFetchParams

const RECENT_TERMINAL_WINDOW_HOURS = 24
const RECENT_TERMINAL_LIMIT = 3
const ACTIVE_TASK_STATUSES = ['pending', 'planning', 'executing', 'waiting_human', 'waiting'] as const
const RECENT_TERMINAL_STATUSES = ['completed', 'failed'] as const
const NON_RECOVERABLE_FAILED_ERROR_PATTERNS = [
  'agent_restarted_during_execution',
  'user-canceled',
  'user cancelled',
  '人工取消',
] as const

function isRecoverableFailedCandidate(error: unknown): boolean {
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : String(error ?? '')
  const normalized = message.toLowerCase()
  return !NON_RECOVERABLE_FAILED_ERROR_PATTERNS.some(pattern =>
    normalized.includes(pattern.toLowerCase())
  )
}

/**
 * 对老 message store 残留的裸 claim hint outbound 做读时兜底改写：
 * - 新版（已带 [系统响应 /认主] 前缀）→ 原样
 * - 老版（无前缀的 UNCLAIMED / ALREADY_CLAIMED 裸字符串）→ 拼前缀
 * - inbound slash 字面 / 普通文本 / 非 text 内容 → 原样
 *
 * 新方案设计（spec 2026-05-25 §7.1）：
 * - inbound slash 字面（如 /认主 / /目标 a3f8）原文透传给 LLM，靠 SLASH_AWARENESS_GUIDANCE
 *   prompt 教化不模仿
 * - admin 新发出的 outbound 话术在发送时即带前缀，message store 里就是带前缀的
 * - 仅本兜底处理升级前已写入的老裸 hint
 */
export function compatLegacyClaimHint(message: ChannelMessage): ChannelMessage {
  if (message.content?.type !== 'text') return message
  const text = message.content.text
  if (typeof text !== 'string') return message
  // 已带新前缀 → 不改
  if (isSlashSystemResponse(text)) return message
  // 老版裸 hint → 加前缀
  if (isLegacyUnclaimedHint(text) || isLegacyAlreadyClaimedHint(text)) {
    return {
      ...message,
      content: { ...message.content, text: `[系统响应 /认主]\n${text}` },
    }
  }
  return message
}

interface ContextAssemblerDeps {
  rpcClient: RpcClient
  moduleId: string
  config: OrchestrationConfig
  getAdminPort: () => number | Promise<number>
  getMemoryPort: () => number | Promise<number>
  /** 可选：由 UnifiedAgent 注入，读取 agent 进程内 in-flight task 快照（避免 30s race）。
   *  Spec: 2026-05-19-prefront-dispatcher-design.md §3.2 */
  getInflightTriggerTasks?: () => ReadonlyArray<{
    task_id: string
    title: string
    trigger_type: 'message' | 'scheduled'
    source_channel_id?: string
    source_session_id?: string
  }>
  /** 可选：由 UnifiedAgent 注入，读取 worker 实时快照（用于 Front 汇报进度）。 */
  getLiveSnapshot?: (taskId: string) => LiveTaskSnapshot | undefined
}

export class ContextAssembler {
  private rpcClient: RpcClient
  private moduleId: string
  private config: OrchestrationConfig
  private getAdminPort: () => number | Promise<number>
  private getMemoryPort: () => number | Promise<number>
  private getInflightTriggerTasks?: () => ReadonlyArray<{
    task_id: string
    title: string
    trigger_type: 'message' | 'scheduled'
    source_channel_id?: string
    source_session_id?: string
  }>
  /**
   * 同进程读取 Worker 实时快照的回调（由 UnifiedAgent 注入）。
   * Worker 与 ContextAssembler 同属一个 Agent 进程，无需 RPC，函数引用直读 Map。
   */
  private getLiveSnapshot?: (taskId: string) => LiveTaskSnapshot | undefined

  constructor(deps: ContextAssemblerDeps) {
    this.rpcClient = deps.rpcClient
    this.moduleId = deps.moduleId
    this.config = deps.config
    this.getAdminPort = deps.getAdminPort
    this.getMemoryPort = deps.getMemoryPort
    this.getInflightTriggerTasks = deps.getInflightTriggerTasks
    this.getLiveSnapshot = deps.getLiveSnapshot
  }

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
    _memoryPermissions: MemoryPermissions,
    traceCtx?: RpcTraceContext,
  ): Promise<FrontAgentContext> {
    const sessionType = params.session_type ?? 'private'
    // 短期记忆改为按需查（Front/Worker 通过 search_short_term 工具自查），不再被动 fetch 拼 prompt
    const [recentMessages, activeTasks, sceneProfile] = await Promise.all([
      this.withSubSpan(traceCtx, 'fetch_recent_messages', () => this.fetchRecentMessages(
        params.session_id,
        params.channel_id,
        this.config.front_context_recent_messages_window_hours,
        this.config.front_context_recent_messages_max_cap,
        sessionType
      )),
      this.withSubSpan(traceCtx, 'fetch_active_tasks', () => this.fetchActiveTasks(params.channel_id, params.session_id)),
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
      short_term_memories: [],
      active_tasks: activeTasks,
      crab_display_name: params.crab_display_name,
      crab_self_handle: params.crab_self_handle,
      available_tools: [],
      ...(sceneProfile ? { scene_profile: sceneProfile } : {}),
      time_windows: {
        recent_messages_window_hours: this.config.front_context_recent_messages_window_hours,
        short_term_memory_window_hours: this.config.front_context_short_term_memory_window_hours,
      },
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
        this.config.worker_recent_messages_window_hours,
        this.config.worker_recent_messages_max_cap,
        workerSessionType
      )),
      this.withSubSpan(traceCtx, 'fetch_short_term_memory', () => this.fetchShortTermMemory({
        friendId: params.friend_id,
        windowHours: this.config.worker_short_term_memory_window_hours,
        maxCap: this.config.worker_short_term_memory_max_cap,
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
      time_windows: {
        recent_messages_window_hours: this.config.worker_recent_messages_window_hours,
        short_term_memory_window_hours: this.config.worker_short_term_memory_window_hours,
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
      time_windows: {
        recent_messages_window_hours: this.config.worker_recent_messages_window_hours,
        short_term_memory_window_hours: this.config.worker_short_term_memory_window_hours,
      },
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
    windowHours: number,
    maxCap: number,
    sessionType: 'private' | 'group' = 'private'
  ): Promise<ChannelMessage[]> {
    const sinceIso = new Date(Date.now() - windowHours * 3600 * 1000).toISOString()
    try {
      // admin-web 频道：从 Admin 的 get_chat_history RPC 获取（无 Channel 模块）
      if (channelId === 'admin-web') {
        const adminPort = await this.getAdminPort()
        const result = await this.rpcClient.call<
          { limit: number; before?: string; after?: string },
          { messages: ChannelMessage[] }
        >(adminPort, 'get_chat_history', { limit: maxCap, after: sinceIso }, this.moduleId)
        // admin 端不一定支持 after，本地兜底过滤
        return result.messages
          .filter((m) => !m.platform_timestamp || m.platform_timestamp >= sinceIso)
          .slice(-maxCap)
          .map(compatLegacyClaimHint)
      }

      // 其他 Channel：通过 Module Manager 解析 Channel 模块并调用 get_history
      const modules = await this.rpcClient.resolve({ module_id: channelId }, this.moduleId)
      if (modules.length === 0) return []

      const channelPort = modules[0].port
      const result = await this.rpcClient.call<
        { session_id: SessionId; limit: number; time_range?: { after?: string } },
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
        { session_id: sessionId, limit: maxCap, time_range: { after: sinceIso } },
        this.moduleId
      )
      // 注入 session 上下文，转换为 ChannelMessage，并对老裸 hint 做兜底补前缀（inbound slash 字面原样透传）
      // 后过滤：channel 不一定支持 time_range.after，本地兜底；并按 maxCap 截断尾部
      return result.items
        .filter((msg) => !msg.platform_timestamp || msg.platform_timestamp >= sinceIso)
        .slice(-maxCap)
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
        .map(compatLegacyClaimHint)
    } catch {
      return []
    }
  }

  private async fetchShortTermMemory(params: FetchShortTermMemoryParams): Promise<ShortTermMemoryEntry[]> {
    const { friendId, windowHours, maxCap, minVisibility = 'public', accessibleScopes, sessionType = 'private', excludeChannelId, excludeSessionId } = params

    // 私聊需要 friendId 做个人记忆过滤；群聊靠 scope 隔离，不需要 friendId
    if (sessionType === 'private' && !friendId) return []

    const sinceIso = new Date(Date.now() - windowHours * 3600 * 1000).toISOString()

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
          time_range?: { start?: string; end?: string }
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
          time_range: { start: sinceIso },
          sort_by: 'event_time',
          limit: maxCap,
          min_visibility: minVisibility,
          ...(accessibleScopes !== undefined && { accessible_scopes: accessibleScopes }),
        },
        this.moduleId
      )
      const results = result.results

      // 可选的客户端过滤：排除 source.channel_id 和 source.session_id 都匹配给定值的条目
      // 仅 Front 路径应用此过滤（Worker 路径不应过滤，保留所有当前 channel+session 的事件以供分析）
      if (excludeChannelId && excludeSessionId) {
        return results.filter(r =>
          !(r.source?.channel_id === excludeChannelId && r.source?.session_id === excludeSessionId)
        )
      }
      return results
    } catch {
      return []
    }
  }

  /**
   * 取"当前 session 的活跃任务清单"——dispatcher / front 视野里能 supplement 的候选。
   *
   * 过滤规则（spec 2026-05-19 §3.2 + protocol-agent-v2.md §5.1）：
   * - status ∈ {pending, planning, executing, waiting_human, waiting}（admin 侧）
   * - source_channel_id + source_session_id 完全匹配当前 session（admin 侧 + in-flight 侧都过滤）
   * - 排除 trigger_type='scheduled'（最终 union 后过滤）
   * - 来源 = admin list_tasks ∪ agent 进程内 in-flight ∪ 最近终态补充候选，按 task_id 去重（避免 admin 同步延迟 race）
   */
  private async fetchActiveTasks(channelId: string, sessionId: string): Promise<TaskSummary[]> {
    const [adminItems, recentItems] = await Promise.all([
      this.fetchAdminActiveTasks(channelId, sessionId),
      this.fetchRecentTerminalTasks(channelId, sessionId),
    ])

    const byId = new Map<string, TaskSummary>()

    // Union with agent in-flight tasks (避免 30s admin 同步延迟导致 race)
    // in-flight 侧按 session 严格过滤——只保留 channel_id + session_id 完全匹配当前 session 的。
    const inflight = this.getInflightTriggerTasks?.() ?? []
    for (const t of inflight) {
      if (t.source_channel_id !== channelId || t.source_session_id !== sessionId) continue
      byId.set(t.task_id, {
        task_id: t.task_id,
        title: t.title,
        status: 'executing',
        priority: 'normal',
        candidate_kind: 'active',
        // 'message' 不在 TaskSummary.trigger_type 联合内，归一化为 undefined（即非 scheduled）
        trigger_type: t.trigger_type === 'scheduled' ? 'scheduled' : undefined,
        source_channel_id: t.source_channel_id,
        source_session_id: t.source_session_id,
      } as TaskSummary)
    }
    // admin 优先覆盖 in-flight
    for (const t of adminItems) byId.set(t.task_id, t)

    // 过滤 scheduled task（dispatcher 不对 scheduled 做 supplement）
    const filtered: TaskSummary[] = []
    for (const t of byId.values()) {
      if (t.trigger_type === 'scheduled') continue
      filtered.push(t)
    }

    for (const t of recentItems) {
      if (!byId.has(t.task_id)) filtered.push(t)
    }
    return filtered
  }

  private async fetchAdminActiveTasks(channelId: string, sessionId: string): Promise<TaskSummary[]> {
    try {
      const adminPort = await this.getAdminPort()
      const result = await this.rpcClient.call<
        { filter: { status: string[]; source_channel_id: string; source_session_id: string } },
        {
          items: Array<{
            id: string
            title: string
            status: string
            type: string
            priority: string
            assigned_worker?: string
            plan?: { summary?: string }
            source: {
              channel_id?: string
              session_id?: string
              trigger_type?: 'manual' | 'scheduled' | 'auto' | 'event'
            }
            messages?: Array<{ content: string; timestamp: string }>
            updated_at?: string
            pending_question?: string
          }>
        }
      >(
        adminPort,
        'list_tasks',
        {
          filter: {
            status: [...ACTIVE_TASK_STATUSES],
            source_channel_id: channelId,
            source_session_id: sessionId,
          },
        },
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
        trigger_type: t.source.trigger_type,
        updated_at: t.updated_at,
        pending_question: t.pending_question,
        candidate_kind: 'active',
        // 飞行中状态：worker 同进程内存表，仅 status=executing 且本进程在跑时有值
        live: t.status === 'executing' ? this.getLiveSnapshot?.(t.id) : undefined,
      }))
    } catch (err) {
      console.warn(
        `[context-assembler] admin list_tasks failed, falling back to agent in-flight only:`,
        err instanceof Error ? err.message : String(err)
      )
      return []
    }
  }

  private async fetchRecentTerminalTasks(channelId: string, sessionId: string): Promise<TaskSummary[]> {
    const sinceMs = Date.now() - RECENT_TERMINAL_WINDOW_HOURS * 3600 * 1000
    const since = new Date(sinceMs).toISOString()
    try {
      const adminPort = await this.getAdminPort()
      const result = await this.rpcClient.call<
        { channel_id: string; session_id: string; since: string; limit: number },
        {
          items: Array<{
            id: string
            title: string
            status: string
            priority: string
            assigned_worker?: string
            source: {
              channel_id?: string
              session_id?: string
              trigger_type?: 'manual' | 'scheduled' | 'auto' | 'event'
            }
            messages?: Array<{ content: string; timestamp: string }>
            updated_at?: string
            completed_at?: string
            error?: string
          }>
        }
      >(
        adminPort,
        'list_recent_terminal_tasks',
        {
          channel_id: channelId,
          session_id: sessionId,
          since,
          limit: RECENT_TERMINAL_LIMIT,
        },
        this.moduleId
      )

      return result.items
        .filter((t) => RECENT_TERMINAL_STATUSES.includes(t.status as typeof RECENT_TERMINAL_STATUSES[number]))
        .filter((t) => t.source.channel_id === channelId && t.source.session_id === sessionId)
        .filter((t) => t.source.trigger_type !== 'scheduled')
        .filter((t) => {
          if (!t.completed_at) return false
          const completedMs = new Date(t.completed_at).getTime()
          return Number.isFinite(completedMs) && completedMs >= sinceMs
        })
        .filter((t) => t.status !== 'failed' || isRecoverableFailedCandidate(t.error))
        .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
        .slice(0, RECENT_TERMINAL_LIMIT)
        .map(t => ({
          task_id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          source_channel_id: t.source.channel_id,
          source_session_id: t.source.session_id,
          trigger_type: t.source.trigger_type,
          candidate_kind: 'recent_terminal',
          completed_at: t.completed_at,
          error: t.error,
        }))
    } catch (err) {
      console.warn(
        `[context-assembler] admin list_recent_terminal_tasks failed, continuing without recent terminal candidates:`,
        err instanceof Error ? err.message : String(err)
      )
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
   * 注意：list_recent_terminal_tasks 已经有 source_channel_id / source_session_id 过滤。
   * 本地仍保留二次过滤，避免 Admin 侧行为漂移时扩大候选范围。
   */

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
