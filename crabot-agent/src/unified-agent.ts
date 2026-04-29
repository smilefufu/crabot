/**
 * UnifiedAgent - 合并 Flow + Agent 的统一智能体模块
 *
 * 整合编排层（原 Flow）和智能体层（原 Agent）的能力
 *
 * @see crabot-docs/protocols/protocol-agent-v2.md
 */

import { ModuleBase, type ModuleConfig, type Event, type ModuleId, type TraceStoreInterface } from 'crabot-shared'
import { resolveTimezone } from './utils/time.js'
import type {
  UnifiedAgentConfig,
  OrchestrationConfig,
  AgentLayerConfig,
  ChannelMessage,
  MessageDecision,
  ExecuteTaskResult,
  ExecuteTaskParams,
  DeliverHumanResponseResult,
  MemoryPermissions,
  ResolvedPermissions,
  ToolAccessConfig,
  StoragePermission,
  SessionPermissionConfig,
  FriendPermissionConfig,
  TaskId,
  FriendId,
  Friend,
  LLMRoleRequirement,
  GetConfigResult,
  UpdateConfigParams,
  UpdateConfigResult,
  LLMConnectionInfo,
  TraceCallback,
  BuiltinToolConfig,
  SkillConfig,
} from './types.js'
import { SessionManager } from './orchestration/session-manager.js'
import { SwitchMapHandler } from './orchestration/switchmap-handler.js'
import { PermissionChecker } from './orchestration/permission-checker.js'
import { WorkerSelector } from './orchestration/worker-selector.js'
import { ContextAssembler } from './orchestration/context-assembler.js'
import { DecisionDispatcher } from './orchestration/decision-dispatcher.js'
import { MemoryWriter } from './orchestration/memory-writer.js'
import { AttentionScheduler, type AttentionConfig, type BufferedMessage } from './orchestration/attention-scheduler.js'
import { FrontHandler, type FrontHandlerLlmConfig } from './agent/front-handler.js'
import { createAdapter, type LLMFormat } from './engine/llm-adapter.js'
import type { ToolExecutorDeps } from './agent/tool-executor.js'
import { WorkerHandler, type SdkEnvConfig } from './agent/worker-handler.js'
import type { ToolPermissionConfig, ToolDefinition as EngineToolDefinition } from './engine/types.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpConnector } from './agent/mcp-connector.js'
import { createCrabMessagingServer, type PathMapping } from './mcp/crab-messaging.js'
import { TraceStore } from './core/trace-store.js'
import { getAgentTraceDir } from './core/data-paths.js'
import { PromptManager } from './prompt-manager.js'
import { SUBAGENT_DEFINITIONS, type SubAgentDefinition } from './agent/subagent-prompts.js'
import { createLSPManager, type LSPManager } from './lsp/lsp-manager.js'
import type { SupplementTaskDecision } from './types.js'

const BARRIER_TIMEOUT_MS = 8_000

/**
 * fail-closed 兜底：权限解析失败时用最小权限（仅 messaging），避免未绑定模板或 Admin 不可用时放开全部工具。
 */
const FAIL_CLOSED_TOOL_ACCESS: ToolAccessConfig = {
  memory: false,
  messaging: true,
  task: false,
  mcp_skill: false,
  file_io: false,
  browser: false,
  shell: false,
  remote_exec: false,
  desktop: false,
}

/**
 * Map ToolAccessConfig to engine's ToolPermissionConfig denyList.
 */
function toToolPermissionConfig(
  toolAccess: ToolAccessConfig,
  tools: ReadonlyArray<EngineToolDefinition>,
): ToolPermissionConfig {
  const deniedTools = tools
    .filter(t => {
      const category = t.category ?? 'mcp_skill'
      return !toolAccess[category]
    })
    .map(t => t.name)

  return deniedTools.length === 0
    ? { mode: 'bypass' as const }
    : { mode: 'denyList' as const, toolNames: deniedTools }
}

export class UnifiedAgent extends ModuleBase {
  // 编排层组件
  private sessionManager: SessionManager
  private switchmapHandler: SwitchMapHandler
  private permissionChecker: PermissionChecker
  private workerSelector: WorkerSelector
  private contextAssembler: ContextAssembler
  private decisionDispatcher: DecisionDispatcher
  private memoryWriter: MemoryWriter
  private attentionScheduler: AttentionScheduler

  // 智能体层组件（可选，取决于配置）
  private frontHandler?: FrontHandler
  private frontHandlerFormat?: LLMFormat
  private workerHandler?: WorkerHandler
  private mcpConnector: McpConnector = new McpConnector()
  private roles: Set<'front' | 'worker'> = new Set()
  /** SDK 环境配置（Worker 专用） */
  private sdkEnvWorker?: SdkEnvConfig
  /** SDK 环境配置（Digest 摘要模型） */
  private digestSdkEnv?: SdkEnvConfig
  /** Worker sandbox 路径映射（每次 executeTask 时更新） */
  private sandboxPathMappingsRef: { current: PathMapping[] } = { current: [] }
  /** 当前消息处理的记忆权限（Front tool 使用） */
  private currentMemPerms?: MemoryPermissions
  /** 当前 session 的解析后权限（模板 + Session 覆盖） */
  private currentResolvedPerms?: ResolvedPermissions | null

  // 配置
  private orchestrationConfig: OrchestrationConfig
  private agentConfig?: AgentLayerConfig
  private extra: Record<string, unknown>

  // 端口缓存
  private adminPort?: number
  private memoryPort?: number
  // Session memory_scopes 缓存（TTL 60s，session config 变更不频繁）
  private sessionScopesCache: Map<string, { scopes: string[]; expiresAt: number }> = new Map()
  private channelPorts: Map<ModuleId, number> = new Map()
  /** Crabot 群昵称缓存: channel_id → display_name */
  private crabDisplayNames: Map<ModuleId, string> = new Map()

  // Trace 存储
  private traceStore: TraceStore
  private lspManager: LSPManager
  private traceCleanupInterval?: ReturnType<typeof setInterval>
  private promptManager: PromptManager

  constructor(config: UnifiedAgentConfig) {
    const moduleConfig: ModuleConfig = {
      moduleId: config.module_id,
      moduleType: config.module_type,
      version: config.version,
      protocolVersion: config.protocol_version,
      port: config.port,
      subscriptions: [
        'channel.message_authorized',
        'admin.task_status_changed',
        'module_manager.module_stopped',
        'admin.friend_updated',
        'admin.friend_deleted',
      ],
    }

    super(moduleConfig)

    this.traceStore = new TraceStore(100, getAgentTraceDir())
    this.lspManager = createLSPManager()

    this.promptManager = new PromptManager()

    this.orchestrationConfig = config.orchestration
    this.agentConfig = config.agent_config
    this.extra = config.extra ?? {}

    // 初始化编排层组件
    this.sessionManager = new SessionManager(this.orchestrationConfig.session_state_ttl)
    this.switchmapHandler = new SwitchMapHandler(
      this.sessionManager,
      this.rpcClient,
      config.module_id,
      async () => await this.getAdminPort()
    )
    this.permissionChecker = new PermissionChecker(
      this.rpcClient,
      config.module_id,
      async () => await this.getAdminPort()
    )
    this.workerSelector = new WorkerSelector(this.rpcClient, config.module_id)
    this.contextAssembler = new ContextAssembler(
      this.rpcClient,
      config.module_id,
      this.orchestrationConfig,
      async () => await this.getAdminPort(),
      async () => await this.getMemoryPort()
    )
    this.memoryWriter = new MemoryWriter(
      this.rpcClient,
      config.module_id,
      async () => await this.getMemoryPort()
    )
    this.decisionDispatcher = new DecisionDispatcher(
      this.rpcClient,
      config.module_id,
      this.contextAssembler,
      this.memoryWriter,
      async () => await this.getAdminPort(),
      async (channelId) => await this.getChannelPort(channelId),
      (params) => this.handleExecuteTask(params),
    )

    // 初始化群聊注意力调度（从 extra 读取配置，fallback 到协议默认值）
    const attentionConfig: AttentionConfig = {
      group_attention_min_ms: (config.extra?.group_attention_min_ms as number) ?? 5000,
      group_attention_max_ms: (config.extra?.group_attention_max_ms as number) ?? 300000,
    }
    this.attentionScheduler = new AttentionScheduler(
      attentionConfig,
      (sessionId, messages) => this.processGroupBatch(sessionId, messages)
    )

    // 初始化智能体层组件（如果有配置）
    if (this.agentConfig) {
      this.initializeAgentLayer(this.agentConfig)
    }

    // 注册 RPC 方法
    this.registerMethods()
  }

  /**
   * 检查 Agent 是否已配置（LLM API key 是否存在）
   */
  isConfigured(): boolean {
    const mc = this.agentConfig?.model_config
    if (!mc) return false
    // 任意一个 slot 有配置即认为已配置
    return Object.values(mc).some(m => m && m.apikey && m.model_id)
  }

  /**
   * 初始化智能体层
   */
  private initializeAgentLayer(config: AgentLayerConfig): void {
    // 设置角色
    for (const role of config.roles) {
      this.roles.add(role)
    }

    // MCP connections managed by mcpConnector in onStart()

    const { basePersonality, workerPersonality, frontSkillListing } =
      this.buildPromptParts(config.system_prompt, config.skills)

    // MCP config factory: creates fresh in-process McpServer instances per task
    // External MCP servers are managed by this.mcpConnector (connected in onStart)
    const createMcpConfigs = (): Record<string, McpServer> => ({
      'crab-messaging': createCrabMessagingServer({
        rpcClient: this.rpcClient,
        moduleId: this.config.moduleId,
        getAdminPort: () => this.getAdminPort(),
        resolveChannelPort: (channelId) => this.getChannelPort(channelId),
      }, this.sandboxPathMappingsRef),
    })

    // 初始化 Front Handler（如果有 front 角色）
    if (this.roles.has('front')) {
      const frontModelConfig = config.model_config?.triage
      if (frontModelConfig) {
        const adapter = createAdapter({
          endpoint: frontModelConfig.endpoint,
          apikey: frontModelConfig.apikey,
          format: frontModelConfig.format as LLMFormat,
          ...(frontModelConfig.account_id ? { accountId: frontModelConfig.account_id } : {}),
        })
        const llmConfig: FrontHandlerLlmConfig = {
          adapter,
          model: frontModelConfig.model_id,
        }
        this.frontHandler = new FrontHandler(llmConfig, this.buildToolExecutorDeps(), {
          getSystemPrompt: (isGroup) => this.promptManager.assembleFrontPrompt({
            isGroup, adminPersonality: basePersonality, workerCapabilities: this.getWorkerCapabilitySummary(), skillListing: frontSkillListing,
          }),
          mcpConfigFactory: createMcpConfigs,
          getTimezone: () => resolveTimezone(this.agentConfig?.timezone),
        })
        this.frontHandlerFormat = frontModelConfig.format as LLMFormat
      }
    }

    // 解析 digest 模型配置（回退链：digest → triage → worker 的配置）
    const digestModelConfig = config.model_config?.digest ?? config.model_config?.triage ?? config.model_config?.worker
    if (digestModelConfig) {
      this.digestSdkEnv = this.buildSdkEnv(digestModelConfig)
    }

    // 初始化 Worker Handler（如果有 worker 角色）
    if (this.roles.has('worker')) {
      const workerModelConfig = config.model_config?.worker
      if (workerModelConfig) {
        this.sdkEnvWorker = this.buildSdkEnv(workerModelConfig)

        // 启动 LSP Manager（coding_expert sub-agent 使用）
        void this.lspManager.start(process.cwd())

        this.workerHandler = this.createWorkerHandler(
          this.sdkEnvWorker, config.model_config, workerPersonality,
          createMcpConfigs, config.builtin_tool_config, config.skills)
        this.decisionDispatcher.setWorkerHandler(this.workerHandler)
        // 让 ContextAssembler 同进程同步读取 worker 实时快照（用于 Front 汇报进度）
        this.contextAssembler.setLiveSnapshotProvider(
          (taskId) => this.workerHandler?.getLiveSnapshot(taskId)
        )
      }
    }
  }

  private buildToolExecutorDeps(): ToolExecutorDeps {
    return {
      rpcClient: this.rpcClient,
      moduleId: this.config.moduleId,
      getAdminPort: () => this.getAdminPort(),
      getActiveTasks: () => this.getActiveTasksList(),
      getMemoryPort: () => this.getMemoryPort(),
      memoryWriteVisibility: () => this.currentMemPerms?.write_visibility ?? 'public',
      memoryWriteScopes: () => this.currentMemPerms?.write_scopes ?? [],
    }
  }

  /**
   * 从 LLMConnectionInfo 构建 SDK 环境配置
   */
  private buildSdkEnv(connInfo: LLMConnectionInfo): SdkEnvConfig {
    return {
      modelId: connInfo.model_id,
      format: connInfo.format,
      supportsVision: connInfo.supports_vision,
      env: {
        LLM_BASE_URL: connInfo.endpoint,
        LLM_API_KEY: connInfo.apikey || 'dummy-key',
        ...(connInfo.account_id ? { LLM_ACCOUNT_ID: connInfo.account_id } : {}),
      },
    }
  }

  private buildSubAgentConfigs(
    modelConfig: Record<string, LLMConnectionInfo>
  ): ReadonlyArray<{ readonly definition: SubAgentDefinition; readonly sdkEnv: SdkEnvConfig }> {
    return SUBAGENT_DEFINITIONS
      .map((def) => {
        const connInfo = this.resolveSubAgentSlot(def, modelConfig)
        if (!connInfo) return null
        return {
          definition: def,
          sdkEnv: this.buildSdkEnv(connInfo),
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
  }

  /**
   * 解析 sub-agent 的 model slot，支持 vision 降级。
   *
   * 优先级：
   *  1. 显式配置的 slot（且能力匹配）
   *  2. 对于需要 vision 的 slot，降级到任意已配且 supports_vision=true 的模型
   *  3. 都没有 → 返回 undefined（跳过该 sub-agent）
   */
  private resolveSubAgentSlot(
    def: SubAgentDefinition,
    modelConfig: Record<string, LLMConnectionInfo>
  ): LLMConnectionInfo | undefined {
    const needsVision = def.recommendedCapabilities.includes('vision')
    const explicit = modelConfig[def.slotKey]

    // 显式配置且能力匹配
    if (explicit) {
      if (!needsVision || explicit.supports_vision) {
        return explicit
      }
      console.log(`[SubAgent] Slot '${def.slotKey}' model lacks vision capability, trying fallback`)
    }

    // 需要 vision 能力：从其他 slot 中找一个 VLM
    if (needsVision) {
      for (const [key, connInfo] of Object.entries(modelConfig)) {
        if (key !== def.slotKey && connInfo.supports_vision) {
          console.log(`[SubAgent] Slot '${def.slotKey}' falling back to '${key}' model (${connInfo.model_id})`)
          return connInfo
        }
      }
      console.log(`[SubAgent] No VLM available for slot '${def.slotKey}', skipping`)
      return undefined
    }

    // 非 vision slot，未配置则跳过
    if (!explicit) {
      console.log(`[SubAgent] Slot '${def.slotKey}' not configured, skipping ${def.toolName}`)
    }
    return explicit
  }

  private createWorkerHandler(
    workerSdkEnv: SdkEnvConfig,
    modelConfig: Record<string, LLMConnectionInfo>,
    workerPersonality: string | undefined,
    createMcpConfigs: () => Record<string, McpServer>,
    builtinToolConfig?: BuiltinToolConfig,
    skills?: ReadonlyArray<SkillConfig>,
  ): WorkerHandler {
    const subAgentConfigs = this.buildSubAgentConfigs(modelConfig)
    const subAgentHints = subAgentConfigs.map(({ definition }) => ({
      toolName: definition.toolName,
      workerHint: definition.workerHint,
    }))
    // workerPersonality 仅承载 admin personality（system_prompt）；skill listing 走独立通道，
    // 由 WorkerHandler 内部 buildSkillListingSnapshot 实时从 this.skills 拼装，
    // 保证 updateSkills 后下一轮 LLM 调用即时生效。
    const handler = new WorkerHandler(workerSdkEnv, {
      systemPrompt: workerPersonality ?? '',
      longTermPreloadLimit: this.orchestrationConfig.worker_long_term_memory_limit,
      extra: this.extra,
      getTimezone: () => resolveTimezone(this.agentConfig?.timezone),
    }, {
      mcpConfigFactory: createMcpConfigs,
      deps: {
        rpcClient: this.rpcClient,
        moduleId: this.config.moduleId,
        resolveChannelPort: (channelId) => this.getChannelPort(channelId),
        getMemoryPort: () => this.getMemoryPort(),
        getAdminPort: () => this.getAdminPort(),
        getPermissionConfig: (tools) => this.getToolPermissionConfig(tools),
      },
      builtinToolConfig,
      mcpConnector: this.mcpConnector,
      digestSdkEnv: this.digestSdkEnv,
      subAgentConfigs,
      skills: skills ?? [],
      lspManager: this.lspManager,
      memoryWriter: this.memoryWriter,
      promptManager: this.promptManager,
      subAgentHints,
    })
    void handler.loadConfirmedSnapshot()
    return handler
  }

  /**
   * 构建 skill catalog XML（渐进式披露 Tier 1：name + description）
   * 输出格式遵循 Agent Skills 开源标准的 <available_skills> XML 格式。
   */
  private static buildSkillXml(
    skills: ReadonlyArray<{ id: string; name: string; description?: string }>
  ): string {
    return skills
      .map((s) => {
        const desc = s.description || s.name
        return `<skill>\n<name>${s.name}</name>\n<description>${desc}</description>\n</skill>`
      })
      .join('\n')
  }

  private static buildSkillListing(
    skills: ReadonlyArray<{ id: string; name: string; description?: string }> | undefined,
    intro: string
  ): string {
    if (!skills || skills.length === 0) return ''
    return `${intro}\n\n<available_skills>\n${UnifiedAgent.buildSkillXml(skills)}\n</available_skills>`
  }

  private buildPromptParts(
    systemPrompt?: string,
    skills?: ReadonlyArray<{ id: string; name: string; description?: string }>
  ): {
    basePersonality?: string
    /** 与 basePersonality 内容相同，仅命名上对应"传给 WorkerHandler 的 personality 字段"。 */
    workerPersonality?: string
    frontSkillListing?: string
  } {
    const basePersonality = systemPrompt || undefined
    // workerPersonality 仅承载 admin personality；skill listing 走独立通道，
    // 由 WorkerHandler 内部 buildSkillListingSnapshot 实时从 this.skills 拼装。
    const workerPersonality = basePersonality

    const frontIntro =
      '## 技能（Skill）\n\n' +
      '以下技能为特定任务提供专业能力。当用户的请求匹配某个技能的描述时，' +
      '**必须使用 create_task**，不能用 reply 直接回答。\n' +
      '即使问题看起来简单（如"502是什么原因"），只要它属于某个技能的职责范围，就必须 create_task。'
    const frontSkillListing = UnifiedAgent.buildSkillListing(skills, frontIntro) || undefined

    return { basePersonality, workerPersonality, frontSkillListing }
  }

  /**
   * 注册 RPC 方法
   */
  private registerMethods(): void {
    // 编排接口
    this.registerMethod('process_message', this.handleProcessMessage.bind(this))
    this.registerMethod('create_task_from_schedule', this.handleCreateTaskFromSchedule.bind(this))

    // Agent 接口
    this.registerMethod('get_role', this.handleGetRole.bind(this))
    this.registerMethod('get_status', this.handleGetStatus.bind(this))
    this.registerMethod('get_llm_requirements', this.handleGetLLMRequirements.bind(this))

    // 配置管理接口
    this.registerMethod('get_config', this.handleGetConfig.bind(this))
    this.registerMethod('update_config', this.handleUpdateConfig.bind(this))

    if (this.roles.has('worker')) {
      this.registerMethod('execute_task', this.handleExecuteTask.bind(this))
      this.registerMethod('deliver_human_response', this.handleDeliverHumanResponse.bind(this))
      this.registerMethod('cancel_task', this.handleCancelTask.bind(this))
    }

    // Trace 接口
    this.registerMethod('get_traces', this.handleGetTraces.bind(this))
    this.registerMethod('get_trace', this.handleGetTrace.bind(this))
    this.registerMethod('clear_traces', this.handleClearTraces.bind(this))
    this.registerMethod('search_traces', this.handleSearchTraces.bind(this))
    this.registerMethod('get_trace_tree', this.handleGetTraceTree.bind(this))
  }

  // ============================================================================
  // 事件处理
  // ============================================================================

  /**
   * 处理接收到的事件
   */
  protected override async onEvent(event: Event): Promise<void> {
    switch (event.type) {
      case 'channel.message_authorized':
        await this.handleMessageReceived(event.payload as { message: ChannelMessage; friend: Friend; crab_display_name?: string })
        break

      case 'admin.task_status_changed':
        await this.handleTaskStatusChanged(event.payload as { task_id: string; new_status: string; final_reply?: string })
        break

      case 'module_manager.module_stopped':
        await this.handleModuleStopped(event.payload as { module_id: ModuleId; reason: string })
        break

      case 'admin.friend_updated':
      case 'admin.friend_deleted': {
        // 清除 Friend 缓存
        const friendPayload = event.payload as { friend_id: FriendId }
        this.permissionChecker.clearFriendCache(friendPayload.friend_id)
        break
      }
    }
  }

  /**
   * 处理消息接收事件（来自 channel.message_authorized，消息已通过 Admin 鉴权）
   *
   * 群聊消息走注意力调度，其余直接处理。
   * @see protocol-agent-v2.md §5.1 SwitchMap, §5.2 Attention Scheduler
   */
  private async handleMessageReceived(payload: { message: ChannelMessage; friend: Friend; crab_display_name?: string }): Promise<void> {
    const { message, friend, crab_display_name } = payload
    const { session } = message

    // 缓存 Crabot 群昵称（来自 Channel 事件）
    if (crab_display_name && session.channel_id) {
      this.crabDisplayNames.set(session.channel_id, crab_display_name)
    }

    // 0. 检查是否已配置
    if (!this.isConfigured()) {
      await this.sendConfigMissingReply(message)
      return
    }

    // 群聊消息走注意力调度（@mention 消息立即触发巡检）
    if (session.type === 'group') {
      this.attentionScheduler.enqueue(session.session_id, message, friend)
      return
    }

    // 私聊消息直接处理（带 SwitchMap）
    await this.processDirectMessage(message, friend)
  }

  /**
   * 私聊消息处理（SwitchMap：同 session 新消息取消旧请求）
   */
  private async processDirectMessage(message: ChannelMessage, friend: Friend): Promise<void> {
    const { session, sender, content } = message

    // 1. 更新 session 状态
    this.sessionManager.updateLastMessageTime(session.session_id)

    // 2. switchMap 处理：取消旧请求，合并被中断消息
    const requestId = crypto.randomUUID()
    const mergedMessages = await this.switchmapHandler.handleNewMessage(
      session.session_id,
      requestId,
      message
    )

    // 3. 创建 Trace
    const trace = this.traceStore.startTrace({
      module_id: this.config.moduleId,
      trigger: {
        type: 'message',
        summary: mergedMessages.length > 1
          ? `[merged×${mergedMessages.length}] ${mergedMessages.map((m) => (m.content.text ?? '').slice(0, 50)).join(' | ').slice(0, 200)}`
          : (content.text ?? '[非文本消息]').slice(0, 200),
        source: session.channel_id,
      },
    })

    let barrierTaskIds: string[] = []

    try {
      // 4. 如果没有配置 Front Agent 能力，需要调用外部 Agent
      if (!this.roles.has('front') || !this.frontHandler) {
        this.traceStore.endTrace(trace.trace_id, 'failed', { summary: 'No front agent configured' })
        return
      }

      // 5. 解析权限（模板 + Session 覆盖）
      const resolvedPerms = await this.resolveSessionPermissions(friend, session.session_id)
      this.currentResolvedPerms = resolvedPerms
      const memPerms = await this.deriveMemoryPermissions(friend, session.session_id, resolvedPerms)

      // 6. 组装上下文（带 span 追踪耗时）
      const ctxSpan = this.traceStore.startSpan(trace.trace_id, {
        type: 'context_assembly',
        details: {
          context_type: 'front',
          channel_id: session.channel_id,
          session_id: session.session_id,
        },
      })
      const context = await this.contextAssembler.assembleFrontContext(
        {
          channel_id: session.channel_id,
          session_id: session.session_id,
          sender_id: sender.platform_user_id,
          // 合并所有消息的文本作为上下文（与 processGroupBatch 保持一致）
          message: mergedMessages.map((m) => m.content.text ?? '').join('\n'),
          friend_id: sender.friend_id,
          session_type: 'private',
        },
        friend,
        memPerms
      )
      this.traceStore.endSpan(trace.trace_id, ctxSpan.span_id, 'completed')

      // 7. 构建 TraceCallback
      const traceCallback = this.buildTraceCallback(trace.trace_id)

      barrierTaskIds = this.setupBarriers(session.channel_id, session.session_id)

      // 8. 调用 Front Agent（传入合并后的消息列表）
      this.currentMemPerms = memPerms
      const result = await this.frontHandler.handleMessage({
        messages: mergedMessages,
        context,
      }, traceCallback)

      // 9. Abort 检查：若已被更新消息取代，跳过 dispatch（防止并发双发 reply）
      if (this.sessionManager.getPendingRequest(session.session_id) !== requestId) {
        this.traceStore.endTrace(trace.trace_id, 'completed', {
          summary: 'superseded by newer message',
        })
        return
      }

      // 10. 分发决策
      for (const decision of result.decisions) {
        const decisionSummary = decision.type === 'direct_reply'
          ? (decision.reply.text ?? '').slice(0, 100)
          : decision.type === 'create_task'
          ? decision.task_title
          : decision.type === 'supplement_task'
          ? `supplement → ${decision.task_id}: ${decision.supplement_content.slice(0, 60)}`
          : 'silent'

        const decisionSpan = this.traceStore.startSpan(trace.trace_id, {
          type: 'decision',
          details: { decision_type: decision.type, summary: decisionSummary },
        })

        if (decision.type === 'supplement_task' && this.workerHandler) {
          const delivered = await this.handleLocalSupplement(decision, session, trace.trace_id, decisionSpan.span_id)
          if (!delivered) {
            // 目标任务不存在 → 改写为 create_task，确保用户请求被真正执行
            await this.decisionDispatcher.dispatch(
              {
                type: 'create_task',
                task_title: decision.supplement_content.slice(0, 60) || '用户追加请求',
                task_description: decision.supplement_content,
                immediate_reply: decision.immediate_reply ?? { type: 'text', text: '' },
              },
              {
                channel_id: session.channel_id,
                session_id: session.session_id,
                messages: mergedMessages,
                senderFriend: friend,
                memoryPermissions: memPerms,
              },
              {
                traceStore: this.traceStore as TraceStoreInterface,
                traceId: trace.trace_id,
                parentSpanId: decisionSpan.span_id,
              }
            )
          }
        } else {
          await this.decisionDispatcher.dispatch(
            decision,
            {
              channel_id: session.channel_id,
              session_id: session.session_id,
              messages: mergedMessages,
              senderFriend: friend,
              memoryPermissions: memPerms,
            },
            {
              traceStore: this.traceStore as TraceStoreInterface,
              traceId: trace.trace_id,
              parentSpanId: decisionSpan.span_id,
            }
          )
        }

        this.traceStore.endSpan(trace.trace_id, decisionSpan.span_id, 'completed')
      }

      this.releaseBarriers(barrierTaskIds, result.decisions)

      // 11. 写入短期记忆：分诊决策事件（fire-and-forget，不阻塞 completeRequest）
      if (sender.friend_id && result.decisions.length > 0) {
        const messageBrief = mergedMessages
          .map((m) => m.content.text ?? '')
          .join(' ')
          .slice(0, 80)

        for (const decision of result.decisions) {
          if (decision.type === 'silent') continue

          const memSpan = this.traceStore.startSpan(trace.trace_id, {
            type: 'memory_write',
            details: {
              friend_id: sender.friend_id,
              channel_id: session.channel_id,
              decision_type: decision.type,
            },
          })

          this.memoryWriter.writeTriageDecision({
            friend_name: friend.display_name,
            friend_id: sender.friend_id,
            channel_id: session.channel_id,
            session_id: session.session_id,
            message_brief: messageBrief,
            decision: decision.type as 'direct_reply' | 'create_task' | 'supplement_task',
            task_id: 'task_id' in decision ? (decision as { task_id: string }).task_id : undefined,
            visibility: memPerms.write_visibility,
            scopes: memPerms.write_scopes,
          }).then(() => {
            this.traceStore.endSpan(trace.trace_id, memSpan.span_id, 'completed')
          }).catch(() => {
            this.traceStore.endSpan(trace.trace_id, memSpan.span_id, 'failed')
          })
        }
      }

      this.traceStore.endTrace(trace.trace_id, 'completed', {
        summary: this.extractReplyText(result.decisions)?.slice(0, 200) ?? 'completed',
      })
    } catch (error) {
      this.clearAllBarriers(barrierTaskIds)
      const msg = error instanceof Error ? error.message : String(error)
      this.traceStore.endTrace(trace.trace_id, 'failed', { summary: msg, error: msg })
    } finally {
      this.switchmapHandler.completeRequest(session.session_id, requestId)
    }
  }

  /**
   * 群聊批量消息处理（注意力调度巡检回调）
   *
   * 巡检间隔到期后调用，传入该周期内积累的所有消息。
   * Agent 判断是否需要回复：有回复 → 重置间隔；无关消息 → 退避间隔。
   *
   * @see protocol-agent-v2.md §5.2
   */
  private async processGroupBatch(sessionId: string, buffered: BufferedMessage[]): Promise<void> {
    if (buffered.length === 0) return

    // 使用最后一条消息的 friend 信息作为代表
    const lastEntry = buffered[buffered.length - 1]
    const messages = buffered.map((b) => b.message)
    const session = messages[0].session

    // 检查 Front Agent 能力
    if (!this.roles.has('front') || !this.frontHandler) {
      return
    }

    // 创建 Trace
    const summary = messages
      .map((m) => `${m.sender.platform_display_name}: ${(m.content.text ?? '').slice(0, 50)}`)
      .join(' | ')
      .slice(0, 200)
    const trace = this.traceStore.startTrace({
      module_id: this.config.moduleId,
      trigger: {
        type: 'message',
        summary: `[group×${messages.length}] ${summary}`,
        source: session.channel_id,
      },
    })

    let barrierTaskIds: string[] = []

    try {
      // 群聊 barrier：仅在有 @bot 消息时设置（非 @bot 群聊消息不暂停 worker）
      const hasMention = messages.some(m => m.features.is_mention_crab)
      if (hasMention) {
        barrierTaskIds = this.setupBarriers(session.channel_id, sessionId)
      }

      // 群聊权限：group_default 模板 + Session 覆盖
      const resolvedPerms = await this.resolveGroupPermissions(sessionId)
      this.currentResolvedPerms = resolvedPerms
      const memPerms = resolvedPerms
        ? {
            write_visibility: 'internal' as const,
            write_scopes: resolvedPerms.memory_scopes,
            read_min_visibility: 'internal' as const,
            read_accessible_scopes: resolvedPerms.memory_scopes,
          }
        : await this.buildSessionMemoryPermissions(sessionId)

      // 组装上下文
      const ctxSpan = this.traceStore.startSpan(trace.trace_id, {
        type: 'context_assembly',
        details: {
          context_type: 'front',
          channel_id: session.channel_id,
          session_id: sessionId,
          message_batch: messages.map(m => ({
            sender: m.sender.platform_display_name,
            text: (m.content.text ?? '').slice(0, 500),
            is_mention_crab: m.features.is_mention_crab,
          })),
        },
      })
      const lastMsg = messages[messages.length - 1]
      const context = await this.contextAssembler.assembleFrontContext(
        {
          channel_id: session.channel_id,
          session_id: sessionId,
          sender_id: lastMsg.sender.platform_user_id,
          message: messages.map((m) => m.content.text ?? '').join('\n'),
          friend_id: lastMsg.sender.friend_id,
          session_type: 'group',
          crab_display_name: this.crabDisplayNames.get(session.channel_id),
        },
        lastEntry.friend,
        memPerms
      )
      this.traceStore.endSpan(trace.trace_id, ctxSpan.span_id, 'completed')

      const traceCallback = this.buildTraceCallback(trace.trace_id)

      // 调用 Front Agent，传入整批消息
      this.currentMemPerms = memPerms
      const result = await this.frontHandler.handleMessage({
        messages,
        context,
      }, traceCallback)

      // 判断是否产生了有意义的回复
      const hasReply = result.decisions.some(
        (d) => d.type === 'direct_reply' || d.type === 'create_task' || d.type === 'supplement_task'
      )

      if (hasReply) {
        // 分发决策
        for (const decision of result.decisions) {
          const decisionSpan = this.traceStore.startSpan(trace.trace_id, {
            type: 'decision',
            details: {
              decision_type: decision.type,
              summary: decision.type === 'direct_reply'
                ? (decision.reply.text ?? '').slice(0, 100)
                : decision.type === 'create_task'
                ? decision.task_title
                : decision.type === 'supplement_task'
                ? `supplement → ${decision.task_id}: ${decision.supplement_content.slice(0, 60)}`
                : 'silent',
            },
          })

          await this.decisionDispatcher.dispatch(
            decision,
            {
              channel_id: session.channel_id,
              session_id: sessionId,
              messages: messages,
              senderFriend: lastEntry.friend,
              memoryPermissions: memPerms,
            },
            {
              traceStore: this.traceStore as TraceStoreInterface,
              traceId: trace.trace_id,
              parentSpanId: decisionSpan.span_id,
            }
          )

          this.traceStore.endSpan(trace.trace_id, decisionSpan.span_id, 'completed')
        }
      }
      // else: silent discard — 不发送任何回复

      this.releaseBarriers(barrierTaskIds, result.decisions)

      // 报告结果，调整注意力巡检间隔
      this.attentionScheduler.reportResult(sessionId, hasReply)

      this.traceStore.endTrace(trace.trace_id, 'completed', {
        summary: hasReply
          ? (this.extractReplyText(result.decisions)?.slice(0, 200) ?? 'replied')
          : 'silent discard',
      })
    } catch (error) {
      this.clearAllBarriers(barrierTaskIds)
      const msg = error instanceof Error ? error.message : String(error)
      this.traceStore.endTrace(trace.trace_id, 'failed', { summary: msg, error: msg })
    }
  }

  /**
   * 配置缺失时发送提示消息给用户
   */
  private async sendConfigMissingReply(message: ChannelMessage): Promise<void> {
    try {
      const channelPort = await this.getChannelPort(message.session.channel_id)
      const reply: ChannelMessage = {
        platform_message_id: `reply-${Date.now()}`,
        session: message.session,
        sender: { friend_id: 'system', platform_user_id: 'crabot', platform_display_name: 'Crabot' },
        content: {
          type: 'text',
          text: 'Crabot 尚未配置 LLM 模型。请管理员在 Admin 界面完成配置后重试。',
        },
        features: { is_mention_crab: false },
        platform_timestamp: new Date().toISOString(),
      }

      await this.rpcClient.call(
        channelPort,
        'send_message',
        { message: reply },
        this.config.moduleId,
      )
    } catch (error) {
      console.error('Failed to send config missing reply:', error instanceof Error ? error.message : error)
    }
  }

  /**
   * 从 Friend 权限和 Session 配置派生记忆读写权限参数
   *
   * - master 权限：写入 private，读取不过滤（可见所有私有记忆）
   * - normal 权限：写入 internal + session memory_scopes，读取限 session memory_scopes
   *
   * 优先从 Admin.get_session_config 读取 session.memory_scopes，
   * fallback 到 [sessionId]（兼容未配置的场景）。
   */
  private async deriveMemoryPermissions(friend: Friend, sessionId: string, resolvedPerms?: ResolvedPermissions | null): Promise<MemoryPermissions> {
    if (friend.permission === 'master') {
      return {
        write_visibility: 'private',
        write_scopes: [],
        read_min_visibility: 'private',
        read_accessible_scopes: undefined,
      }
    }

    // Use resolved permissions if available, otherwise fall back to RPC
    const memoryScopes = resolvedPerms?.memory_scopes ?? await this.getSessionMemoryScopes(sessionId)
    return {
      write_visibility: 'internal',
      write_scopes: memoryScopes,
      read_min_visibility: 'internal',
      read_accessible_scopes: memoryScopes,
    }
  }

  /**
   * 从 Admin 获取合并后的 session 权限（模板 + Session 覆盖）
   */
  private async resolveSessionPermissions(
    friend: Friend,
    sessionId: string,
  ): Promise<ResolvedPermissions | null> {
    const friendPermissions = await this.fetchFriendPermissions(friend)
    if (friendPermissions === null) {
      return null
    }
    if (friendPermissions.config) {
      return friendPermissions.resolved
    }

    const templateId = friend.permission === 'master'
      ? 'master_private'
      : (friend.permission_template_id ?? 'standard')

    if (!templateId) return null
    return this.resolvePermissionsForTemplate(templateId, sessionId)
  }

  private async fetchFriendPermissions(friend: Friend): Promise<{
    config: FriendPermissionConfig | null
    resolved: ResolvedPermissions | null
  } | null> {
    try {
      const adminPort = await this.getAdminPort()
      return await this.rpcClient.call<
        { friend_id: string },
        { config: FriendPermissionConfig | null; resolved: ResolvedPermissions | null }
      >(adminPort, 'get_friend_permissions', { friend_id: friend.id }, this.config.moduleId)
    } catch (err) {
      console.warn(`[Agent] Failed to resolve friend permissions for ${friend.id}:`, err)
      return null
    }
  }

  /**
   * 群聊权限解析：使用 group_default 模板 + Session 覆盖
   */
  private async resolveGroupPermissions(sessionId: string): Promise<ResolvedPermissions | null> {
    const resolved = await this.resolvePermissionsForTemplate('group_default', sessionId)
    if (!resolved) return null
    // 群聊：memory_scopes 为空时 fallback 到 [sessionId]，避免写入跨群可见
    const memoryScopes = resolved.memory_scopes.length > 0 ? resolved.memory_scopes : [sessionId]
    return { ...resolved, memory_scopes: memoryScopes }
  }

  /**
   * 从 Admin 获取模板 + Session 配置并增量合并。两个 RPC 并行调用。
   */
  private async resolvePermissionsForTemplate(templateId: string, sessionId: string): Promise<ResolvedPermissions | null> {
    try {
      const adminPort = await this.getAdminPort()

      const [templateResult, sessionResult] = await Promise.all([
        this.rpcClient.call<
          { template_id: string },
          { template: { tool_access: ToolAccessConfig; storage: StoragePermission | null; memory_scopes: string[] } }
        >(adminPort, 'get_permission_template', { template_id: templateId }, this.config.moduleId),
        this.rpcClient.call<
          { session_id: string },
          { config: SessionPermissionConfig | null }
        >(adminPort, 'get_session_config', { session_id: sessionId }, this.config.moduleId),
      ])

      const template = templateResult.template
      const sessionConfig = sessionResult.config

      const toolAccess = sessionConfig?.tool_access
        ? { ...template.tool_access, ...sessionConfig.tool_access }
        : { ...template.tool_access }

      const storage = sessionConfig?.storage !== undefined
        ? sessionConfig.storage
        : template.storage

      const memoryScopes = sessionConfig?.memory_scopes !== undefined
        ? sessionConfig.memory_scopes
        : template.memory_scopes

      return { tool_access: toolAccess, storage, memory_scopes: memoryScopes }
    } catch (err) {
      console.warn(`[Agent] Failed to resolve permissions for template ${templateId}:`, err)
      return null
    }
  }

  /**
   * Get current session's tool permission config for worker use
   */
  getToolPermissionConfig(tools: ReadonlyArray<EngineToolDefinition>): ToolPermissionConfig {
    // fail-closed：权限解析失败时按最小权限兜底，不放开全部工具
    const toolAccess = this.currentResolvedPerms?.tool_access ?? FAIL_CLOSED_TOOL_ACCESS
    return toToolPermissionConfig(toolAccess, tools)
  }

  /**
   * 从 Admin 获取 Session 的 memory_scopes（带 TTL 缓存），fallback 到 [sessionId]
   */
  private async getSessionMemoryScopes(sessionId: string): Promise<string[]> {
    const cached = this.sessionScopesCache.get(sessionId)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.scopes
    }

    let scopes: string[] = [sessionId]
    try {
      const adminPort = await this.getAdminPort()
      const result = await this.rpcClient.call<
        { session_id: string },
        { config: { memory_scopes?: string[] } | null }
      >(adminPort, 'get_session_config', { session_id: sessionId }, this.config.moduleId)
      if (result.config?.memory_scopes && result.config.memory_scopes.length > 0) {
        scopes = result.config.memory_scopes
      }
    } catch {
      // Admin 不可达或 session 未配置，使用默认值
    }

    this.sessionScopesCache.set(sessionId, { scopes, expiresAt: Date.now() + 60_000 })
    return scopes
  }

  /**
   * 构建非 master 的 session 级 MemoryPermissions（群聊 / channel 内部调用共用）
   */
  private async buildSessionMemoryPermissions(sessionId: string): Promise<MemoryPermissions> {
    const memoryScopes = await this.getSessionMemoryScopes(sessionId)
    return {
      write_visibility: 'internal',
      write_scopes: memoryScopes,
      read_min_visibility: 'internal',
      read_accessible_scopes: memoryScopes,
    }
  }

  /**
   * 本地投递纠偏消息给 Worker。
   * 返回 true 表示成功投递，false 表示任务不存在（调用方应回退为 create_task）。
   */
  private async handleLocalSupplement(
    decision: import('./types.js').SupplementTaskDecision,
    session: { channel_id: string; session_id: string },
    traceId: string,
    parentSpanId: string,
  ): Promise<boolean> {
    // Step 1: Verify task exists BEFORE doing anything
    if (!this.workerHandler!.hasActiveTask(decision.task_id)) {
      const span = this.traceStore.startSpan(traceId, {
        type: 'tool_call' as const,
        parent_span_id: parentSpanId,
        details: {
          tool_name: 'supplement_fallback',
          input_summary: `task ${decision.task_id} not found, will fallback to create_task`,
        },
      })
      this.traceStore.endSpan(traceId, span.span_id, 'completed', {
        output_summary: 'task not found, fallback to create_task',
      })
      return false
    }

    // Step 2: Task verified — send immediate reply
    const replyText = decision.immediate_reply?.text
      || `收到，正在调整：${decision.supplement_content.slice(0, 60)}`
    const replySpan = this.traceStore.startSpan(traceId, {
      type: 'tool_call' as const,
      parent_span_id: parentSpanId,
      details: {
        tool_name: 'supplement_reply',
        input_summary: `reply: "${replyText.slice(0, 100)}"`,
      },
    })
    if (replyText) {
      try {
        const channelPort = await this.getChannelPort(session.channel_id)
        await this.rpcClient.call(channelPort, 'send_message', {
          session_id: session.session_id,
          content: { type: 'text', text: replyText },
        }, this.config.moduleId)
        this.traceStore.endSpan(traceId, replySpan.span_id, 'completed', {
          output_summary: 'sent',
        })
      } catch (err) {
        this.traceStore.endSpan(traceId, replySpan.span_id, 'failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    } else {
      this.traceStore.endSpan(traceId, replySpan.span_id, 'completed', {
        output_summary: 'skipped (no text)',
      })
    }

    // Step 3: Deliver supplement to local Worker
    const deliverSpan = this.traceStore.startSpan(traceId, {
      type: 'tool_call' as const,
      parent_span_id: parentSpanId,
      details: {
        tool_name: 'supplement_deliver',
        input_summary: `task_id=${decision.task_id}, content="${decision.supplement_content.slice(0, 100)}"`,
      },
    })
    try {
      this.workerHandler!.deliverHumanResponse(decision.task_id, [{
        platform_message_id: `supplement-${Date.now()}`,
        session: { channel_id: session.channel_id, session_id: session.session_id, type: 'private' as const },
        sender: { friend_id: 'system', platform_user_id: 'system', platform_display_name: 'System' },
        content: { type: 'text' as const, text: `用户补充指示：${decision.supplement_content}` },
        features: { is_mention_crab: false },
        platform_timestamp: new Date().toISOString(),
      }])
      this.traceStore.endSpan(traceId, deliverSpan.span_id, 'completed', {
        output_summary: `delivered to task ${decision.task_id}`,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.traceStore.endSpan(traceId, deliverSpan.span_id, 'failed', {
        error: msg,
      })
    }

    return true
  }

  /**
   * 从决策列表中提取 Agent 发出的第一条回复文本
   */
  private extractReplyText(decisions: MessageDecision[]): string | undefined {
    for (const decision of decisions) {
      if (decision.type === 'direct_reply' && decision.reply.text) {
        return decision.reply.text
      }
      if (decision.type === 'create_task' && decision.immediate_reply.text) {
        return decision.immediate_reply.text
      }
      if (decision.type === 'supplement_task' && decision.immediate_reply?.text) {
        return decision.immediate_reply.text
      }
    }
    return undefined
  }

  private setupBarriers(channelId: string, sessionId: string): string[] {
    if (!this.workerHandler) return []
    const taskIds = this.workerHandler.getActiveTasksByOrigin(channelId, sessionId)
    for (const taskId of taskIds) {
      this.workerHandler.setBarrierForTask(taskId, BARRIER_TIMEOUT_MS)
    }
    return taskIds
  }

  private releaseBarriers(barrierTaskIds: string[], decisions: MessageDecision[]): void {
    if (barrierTaskIds.length === 0) return
    const supplementedTaskIds = new Set(
      decisions
        .filter((d): d is SupplementTaskDecision => d.type === 'supplement_task')
        .map(d => d.task_id)
    )
    for (const taskId of barrierTaskIds) {
      if (!supplementedTaskIds.has(taskId)) {
        this.workerHandler?.clearBarrierForTask(taskId)
      }
    }
  }

  private clearAllBarriers(barrierTaskIds: string[]): void {
    for (const taskId of barrierTaskIds) {
      this.workerHandler?.clearBarrierForTask(taskId)
    }
  }

  /**
   * 处理任务状态变更事件
   */
  private async handleTaskStatusChanged(payload: {
    task_id: string
    new_status: string
    final_reply?: string
  }): Promise<void> {
    const { task_id, new_status, final_reply } = payload

    // 只处理完成或失败状态，且有最终回复
    if ((new_status !== 'completed' && new_status !== 'failed') || !final_reply) {
      return
    }

    try {
      // 查询任务信息
      const adminPort = await this.getAdminPort()
      const taskInfo = await this.rpcClient.call<
        { task_id: string },
        {
          task_id: string
          title: string
          status: string
          source?: {
            origin: string
            source_module_id?: string
            channel_id?: string
            session_id?: string
            friend_id?: string
          }
        }
      >(adminPort, 'get_task', { task_id }, this.config.moduleId)

      if (!taskInfo.source) {
        return
      }

      const content =
        new_status === 'completed'
          ? final_reply
          : '任务处理失败，请稍后重试'

      // 根据来源类型路由回复
      if (taskInfo.source.origin === 'admin_chat' && taskInfo.source.source_module_id) {
        // Admin Chat 来源 - 通过 Admin 模块发送回调
        await this.rpcClient.call(
          adminPort,
          'send_chat_message',
          {
            module_id: taskInfo.source.source_module_id,
            content: { type: 'text', text: content },
            metadata: {
              task_id,
              status: new_status,
            },
          },
          this.config.moduleId
        )
      } else if (
        taskInfo.source.origin === 'human' &&
        taskInfo.source.channel_id &&
        taskInfo.source.session_id
      ) {
        // Channel 来源 - 通过 Channel 模块发送消息
        const channelPort = await this.getChannelPort(taskInfo.source.channel_id)
        await this.rpcClient.call(
          channelPort,
          'send_message',
          {
            session_id: taskInfo.source.session_id,
            content: { type: 'text', text: content },
          },
          this.config.moduleId
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${this.config.moduleId}] Error handling task status changed:`, message)
    }
  }

  /**
   * 处理模块停止事件
   */
  private async handleModuleStopped(payload: { module_id: ModuleId; reason: string }): Promise<void> {
    const { module_id, reason } = payload

    // 清除端口缓存，下次调用时重新解析
    this.channelPorts.delete(module_id)

    // 正常关闭无需处理
    if (reason === 'shutdown') {
      return
    }

    console.warn(
      `[${this.config.moduleId}] Module ${module_id} stopped unexpectedly: ${reason}`
    )

    try {
      const adminPort = await this.getAdminPort()

      // 查询该 Worker 上正在处理的任务
      const tasksResult = await this.rpcClient.call<
        {
          assigned_worker: string
          status: string[]
        },
        { tasks: Array<{ task_id: string; status: string }> }
      >(
        adminPort,
        'query_tasks',
        {
          assigned_worker: module_id,
          status: ['planning', 'executing', 'waiting_human'],
        },
        this.config.moduleId
      )

      if (!tasksResult.tasks || tasksResult.tasks.length === 0) {
        return
      }

      console.log(
        `[${this.config.moduleId}] Found ${tasksResult.tasks.length} affected tasks on crashed worker ${module_id}`
      )

      // 处理受影响的任务
      for (const task of tasksResult.tasks) {
        try {
          // 标记任务失败
          await this.rpcClient.call(
            adminPort,
            'update_task_status',
            {
              task_id: task.task_id,
              status: 'failed',
              reason: `Worker ${module_id} crashed (${reason})`,
            },
            this.config.moduleId
          )

          console.log(
            `[${this.config.moduleId}] Task ${task.task_id} marked as failed due to worker crash`
          )
        } catch (taskError) {
          const message =
            taskError instanceof Error ? taskError.message : String(taskError)
          console.error(
            `[${this.config.moduleId}] Failed to update task ${task.task_id}:`,
            message
          )
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${this.config.moduleId}] Error handling module stopped:`, message)
    }
  }

  // ============================================================================
  // RPC 方法处理器
  // ============================================================================

  private async handleProcessMessage(params: {
    message: ChannelMessage
    source_type?: 'channel' | 'admin_chat'
    callback_info?: { source_module_id: string; request_id: string }
  }): Promise<{ decision_types: string[]; task_ids?: string[] }> {
    const { message, source_type, callback_info } = params

    // Admin Chat 来源
    if (source_type === 'admin_chat' && callback_info) {
      return this.processAdminChatMessage(message, callback_info)
    }

    // Channel 来源 - 使用标准消息处理流程
    if (source_type === 'channel' || !source_type) {
      // 直接触发消息处理（跳过权限检查，因为来自内部调用）
      const sessionId = message.session.session_id

      // 更新 session 状态
      this.sessionManager.updateLastMessageTime(sessionId)

      // switchMap 处理
      const requestId = crypto.randomUUID()
      const mergedMessages = await this.switchmapHandler.handleNewMessage(sessionId, requestId, message)

      try {
        // 检查是否有 Front Agent 能力
        if (!this.roles.has('front') || !this.frontHandler) {
          return { decision_types: [] }
        }

        // 组装上下文（channel 内部调用无 permResult，从 session 配置读取 memory_scopes）
        const channelMemPerms = await this.buildSessionMemoryPermissions(sessionId)
        const context = await this.contextAssembler.assembleFrontContext(
          {
            channel_id: message.session.channel_id,
            session_id: sessionId,
            sender_id: message.sender.platform_user_id,
            message: mergedMessages.map((m) => m.content.text ?? '').join('\n'),
            friend_id: message.sender.friend_id,
            session_type: message.session.type,
          },
          undefined,
          channelMemPerms
        )

        // 调用 Front Agent
        this.currentMemPerms = channelMemPerms
        const result = await this.frontHandler.handleMessage({
          messages: mergedMessages,
          context,
        })

        // 检查是否已被更新消息取代
        if (this.sessionManager.getPendingRequest(sessionId) !== requestId) {
          return { decision_types: [] }
        }

        // 分发决策
        const taskIds: TaskId[] = []
        const decisionTypes: string[] = []

        for (const decision of result.decisions) {
          decisionTypes.push(decision.type)
          const dispatchResult = await this.decisionDispatcher.dispatch(decision, {
            channel_id: message.session.channel_id,
            session_id: sessionId,
            messages: mergedMessages,
            memoryPermissions: channelMemPerms,
          })
          if (dispatchResult.task_id) {
            taskIds.push(dispatchResult.task_id)
          }
        }

        return {
          decision_types: decisionTypes,
          task_ids: taskIds.length > 0 ? taskIds : undefined,
        }
      } finally {
        this.switchmapHandler.completeRequest(sessionId, requestId)
      }
    }

    return { decision_types: [] }
  }

  /**
   * 处理 Admin Chat 消息
   */
  private async processAdminChatMessage(
    message: ChannelMessage,
    callbackInfo: { source_module_id: string; request_id: string }
  ): Promise<{ decision_types: string[]; task_ids?: string[] }> {
    // Admin Chat 使用固定 session ID
    const sessionId = 'admin-chat'

    // 更新 session 状态
    this.sessionManager.updateLastMessageTime(sessionId)

    // switchMap 处理
    const requestId = crypto.randomUUID()
    const mergedMessages = await this.switchmapHandler.handleNewMessage(sessionId, requestId, message)

    // 创建 Trace
    const trace = this.traceStore.startTrace({
      module_id: this.config.moduleId,
      trigger: {
        type: 'message',
        summary: mergedMessages.length > 1
          ? `[merged×${mergedMessages.length}] ${mergedMessages.map((m) => (m.content.text ?? '').slice(0, 50)).join(' | ').slice(0, 200)}`
          : (message.content.text ?? '[非文本消息]').slice(0, 200),
        source: 'admin-web',
      },
    })

    try {
      // 检查是否已配置
      if (!this.isConfigured()) {
        await this.rpcClient.call(
          await this.getAdminPort(),
          'chat_callback',
          {
            request_id: callbackInfo.request_id,
            reply_type: 'direct_reply',
            content: 'Crabot 尚未配置 LLM 模型。请在全局设置中完成配置后重试。',
          },
          this.config.moduleId
        )
        this.traceStore.endTrace(trace.trace_id, 'failed', { summary: 'Agent not configured' })
        return { decision_types: [] }
      }

      // 检查是否有 Front Agent 能力
      if (!this.roles.has('front') || !this.frontHandler) {
        // 发送错误回复
        await this.rpcClient.call(
          await this.getAdminPort(),
          'chat_callback',
          {
            request_id: callbackInfo.request_id,
            reply_type: 'direct_reply',
            content: '系统暂时不可用',
          },
          this.config.moduleId
        )
        this.traceStore.endTrace(trace.trace_id, 'failed', { summary: 'No front agent configured' })
        return { decision_types: [] }
      }

      // Admin Chat 使用 master 级权限（私有，无 scope 过滤）
      const masterMemPerms: MemoryPermissions = {
        write_visibility: 'private',
        write_scopes: [],
        read_min_visibility: 'private',
        read_accessible_scopes: undefined,
      }

      // 组装上下文（Admin Chat 专用，带 span 追踪耗时）
      const ctxSpan = this.traceStore.startSpan(trace.trace_id, {
        type: 'context_assembly',
        details: {
          context_type: 'front',
          channel_id: 'admin-web',
          session_id: sessionId,
        },
      })
      const context = await this.contextAssembler.assembleFrontContext(
        {
          channel_id: 'admin-web',
          session_id: sessionId,
          sender_id: 'master',
          message: mergedMessages.map((m) => m.content.text ?? '').join('\n'),
          friend_id: message.sender.friend_id ?? 'master',
          session_type: 'private',
        },
        {
          id: 'master',
          display_name: 'Master',
          permission: 'master',
          channel_identities: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        masterMemPerms
      )
      this.traceStore.endSpan(trace.trace_id, ctxSpan.span_id, 'completed')

      // 构建 TraceCallback
      const traceCallback = this.buildTraceCallback(trace.trace_id)

      // 调用 Front Agent
      this.currentMemPerms = masterMemPerms
      const result = await this.frontHandler.handleMessage({
        messages: mergedMessages,
        context,
      }, traceCallback)

      // 检查是否已被更新消息取代
      if (this.sessionManager.getPendingRequest(sessionId) !== requestId) {
        this.traceStore.endTrace(trace.trace_id, 'completed', { summary: 'superseded by newer message' })
        return { decision_types: [] }
      }

      // 分发决策（使用 Admin Chat 回调）
      const taskIds: TaskId[] = []
      const decisionTypes: string[] = []

      for (const decision of result.decisions) {
        decisionTypes.push(decision.type)

        // 记录 decision span
        const decisionSpan = this.traceStore.startSpan(trace.trace_id, {
          type: 'decision',
          details: {
            decision_type: decision.type,
            summary: decision.type === 'direct_reply'
              ? (decision.reply.text ?? '').slice(0, 100)
              : decision.type === 'create_task'
              ? decision.task_title
              : decision.type === 'supplement_task'
              ? `supplement → ${decision.task_id}: ${decision.supplement_content.slice(0, 60)}`
              : 'silent',
          },
        })

        const dispatchResult = await this.decisionDispatcher.dispatch(
          decision,
          {
            channel_id: 'admin-web',
            session_id: sessionId,
            messages: mergedMessages,
            senderFriend: {
              id: 'master',
              display_name: 'Master',
              permission: 'master' as const,
              channel_identities: [],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            memoryPermissions: masterMemPerms,
            admin_chat_callback: callbackInfo,
          },
          {
            traceStore: this.traceStore as TraceStoreInterface,
            traceId: trace.trace_id,
            parentSpanId: decisionSpan.span_id,
          }
        )

        this.traceStore.endSpan(trace.trace_id, decisionSpan.span_id, 'completed')

        if (dispatchResult.task_id) {
          taskIds.push(dispatchResult.task_id)
        }
      }

      // 写入短期记忆：分诊决策事件（fire-and-forget，不阻塞主流程）
      if (message.content.text && result.decisions.length > 0) {
        const messageBrief = mergedMessages
          .map((m) => m.content.text ?? '')
          .join(' ')
          .slice(0, 80)

        for (const decision of result.decisions) {
          if (decision.type === 'silent') continue

          const memSpan = this.traceStore.startSpan(trace.trace_id, {
            type: 'memory_write',
            details: {
              friend_id: message.sender.friend_id ?? 'master',
              channel_id: 'admin-web',
              decision_type: decision.type,
            },
          })

          this.memoryWriter.writeTriageDecision({
            friend_name: 'Master',
            friend_id: message.sender.friend_id ?? 'master',
            channel_id: 'admin-web',
            session_id: sessionId,
            message_brief: messageBrief,
            decision: decision.type as 'direct_reply' | 'create_task' | 'supplement_task',
            task_id: 'task_id' in decision ? (decision as { task_id: string }).task_id : undefined,
            visibility: masterMemPerms.write_visibility,
            scopes: masterMemPerms.write_scopes,
          }).then(() => {
            this.traceStore.endSpan(trace.trace_id, memSpan.span_id, 'completed')
          }).catch(() => {
            this.traceStore.endSpan(trace.trace_id, memSpan.span_id, 'failed')
          })
        }
      }

      this.traceStore.endTrace(trace.trace_id, 'completed', {
        summary: this.extractReplyText(result.decisions)?.slice(0, 200) ?? 'completed',
      })

      return {
        decision_types: decisionTypes,
        task_ids: taskIds.length > 0 ? taskIds : undefined,
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.traceStore.endTrace(trace.trace_id, 'failed', { summary: msg, error: msg })
      throw error
    } finally {
      this.switchmapHandler.completeRequest(sessionId, requestId)
    }
  }

  private async handleCreateTaskFromSchedule(params: {
    schedule_id: string
    task_type?: string
    title: string
    description: string
    preferred_worker_specialization?: string
  }): Promise<{ task_id: string; assigned_worker: ModuleId }> {
    const { schedule_id, task_type, title, description, preferred_worker_specialization } = params

    try {
      // 选择 Worker
      const workerId = await this.workerSelector.selectWorker({
        specialization_hint: preferred_worker_specialization,
      })

      // 创建任务
      const adminPort = await this.getAdminPort()
      const taskResult = await this.rpcClient.call<
        {
          title: string
          description: string
          assigned_worker: string
          source: { origin: string; source_module_id: string }
          input?: Record<string, unknown>
        },
        { task: { id: string } }
      >(
        adminPort,
        'create_task',
        {
          title,
          description,
          assigned_worker: workerId,
          source: {
            origin: 'system',
            source_module_id: this.config.moduleId,
          },
          input: { schedule_id },
        },
        this.config.moduleId
      )

      const taskId = taskResult.task.id

      console.log(
        `[${this.config.moduleId}] Created task ${taskId} from schedule ${schedule_id}, assigned to ${workerId}`
      )

      // 组装调度任务上下文并启动 Worker 执行
      const workerContext = await this.contextAssembler.assembleScheduledTaskContext()

      this.decisionDispatcher.executeScheduledTaskInBackground(
        {
          id: taskId,
          title,
          description,
          priority: 'normal',
          task_type,
        },
        workerContext,
      )

      return { task_id: taskId, assigned_worker: workerId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `[${this.config.moduleId}] Failed to create task from schedule ${schedule_id}:`,
        message
      )
      throw new Error(`Failed to create task from schedule: ${message}`)
    }
  }

  private handleGetRole(): {
    roles: string[]
    specialization: string
    max_concurrent_tasks: number
  } {
    return {
      roles: Array.from(this.roles),
      specialization: this.agentConfig?.specialization ?? 'general',
      max_concurrent_tasks: this.agentConfig?.max_concurrent_tasks ?? 5,
    }
  }

  /**
   * 返回模块需要的 LLM 配置需求
   */
  private handleGetLLMRequirements(): {
    model_format: string
    requirements: LLMRoleRequirement[]
  } {
    return {
      model_format: 'anthropic',
      requirements: [
        {
          key: 'triage',
          description: '分诊模型，用于 Front Agent 消息意图判断和快速决策（可选）',
          required: false,
          used_by: ['front'],
          fallback: 'global_default',
        },
        {
          key: 'worker',
          description: '执行模型，用于 Worker Agent 执行实际任务（可选）',
          required: false,
          used_by: ['worker'],
          fallback: 'global_default',
        },
        {
          key: 'digest',
          description: '摘要模型，用于生成进度汇报摘要（可选，推荐小型快速模型）',
          required: false,
          used_by: ['worker'],
          fallback: 'global_default',
        },
        ...SUBAGENT_DEFINITIONS.map((def) => ({
          key: def.slotKey,
          description: def.slotDescription,
          required: false as const,
          used_by: ['worker'] as Array<'front' | 'worker'>,
          recommended_capabilities: [...def.recommendedCapabilities],
          fallback: 'none' as const,
        })),
      ],
    }
  }

  private async handleGetStatus(): Promise<{
    roles: string[]
    idle: boolean
    processing_messages: number
    active_sessions: number
    current_task_count: number
    available_capacity: number
    specialization: string
  }> {
    const maxCapacity = this.agentConfig?.max_concurrent_tasks ?? 5
    const currentTaskCount = this.workerHandler?.getActiveTaskCount() ?? 0

    return {
      roles: Array.from(this.roles),
      idle: this.sessionManager.getPendingSessionCount() === 0,
      processing_messages: this.sessionManager.getPendingSessionCount(),
      active_sessions: this.sessionManager.getActiveSessionCount(),
      current_task_count: currentTaskCount,
      available_capacity: Math.max(0, (this.agentConfig?.available_capacity ?? maxCapacity) - currentTaskCount),
      specialization: this.agentConfig?.specialization ?? 'general',
    }
  }

  private async handleExecuteTask(params: ExecuteTaskParams & {
    parent_trace_id?: string
    parent_span_id?: string
    related_task_id?: string
  }): Promise<ExecuteTaskResult & { trace_id?: string }> {
    if (!this.workerHandler) {
      throw new Error('Worker handler not configured')
    }

    const { parent_trace_id, parent_span_id, related_task_id, ...taskParams } = params

    // 更新 sandbox 路径映射（crab-messaging send_message 需要路径转换）
    this.sandboxPathMappingsRef.current = taskParams.context.sandbox_path_mappings ?? []

    // 创建 Trace
    const trace = this.traceStore.startTrace({
      module_id: this.config.moduleId,
      trigger: {
        type: 'task',
        summary: taskParams.task.task_title.slice(0, 200),
        source: taskParams.context.task_origin?.channel_id,
        task_type: taskParams.task.task_type,
      },
      parent_trace_id,
      parent_span_id,
      related_task_id,
    })

    const traceCallback = this.buildTraceCallback(trace.trace_id)

    // Add context_assembly span for worker context
    const ctxSpan = this.traceStore.startSpan(trace.trace_id, {
      type: 'context_assembly',
      details: {
        context_type: 'worker',
        channel_id: taskParams.context.task_origin?.channel_id,
        session_id: taskParams.context.task_origin?.session_id,
      },
    })
    this.traceStore.endSpan(trace.trace_id, ctxSpan.span_id, 'completed')

    const traceContext: import('./agent/worker-handler').WorkerTraceContext = {
      traceStore: this.traceStore,
      traceId: trace.trace_id,
      relatedTaskId: related_task_id,
    }

    try {
      const result = await this.workerHandler.executeTask(taskParams, traceCallback, traceContext)
      this.traceStore.endTrace(trace.trace_id, result.outcome === 'completed' ? 'completed' : 'failed', {
        summary: result.summary.slice(0, 200),
        error: result.outcome === 'failed' ? result.summary : undefined,
      })
      return { ...result, trace_id: trace.trace_id }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.traceStore.endTrace(trace.trace_id, 'failed', { summary: msg, error: msg })
      throw error
    }
  }

  private handleDeliverHumanResponse(params: {
    task_id: TaskId
    messages: ChannelMessage[]
  }): DeliverHumanResponseResult {
    if (!this.workerHandler) {
      throw new Error('Worker handler not configured')
    }

    this.workerHandler.deliverHumanResponse(params.task_id, params.messages)
    return { received: true, task_status: 'executing' }
  }

  private handleCancelTask(params: { task_id: TaskId; reason: string }): { cancelled: true } {
    if (!this.workerHandler) {
      throw new Error('Worker handler not configured')
    }

    this.workerHandler.cancelTask(params.task_id, params.reason)
    return { cancelled: true }
  }

  // ============================================================================
  // 配置管理
  // ============================================================================

  /**
   * 获取当前配置
   */
  private handleGetConfig(): GetConfigResult {
    if (!this.agentConfig) {
      throw new Error('Agent config not configured')
    }

    return {
      config: this.agentConfig,
    }
  }

  /**
   * 热更新配置
   */
  private async handleUpdateConfig(params: UpdateConfigParams): Promise<UpdateConfigResult> {
    if (!this.agentConfig) {
      throw new Error('Agent config not configured')
    }

    const changedFields: string[] = []
    let restartRequired = false

    // 先收集所有状态变更，最后统一触发 handler 重建，避免多次重建
    const modelConfigChanged = params.model_config !== undefined
    const skillsChanged = params.skills !== undefined
    const systemPromptChanged = params.system_prompt !== undefined

    // 更新模型配置
    if (params.model_config) {
      this.agentConfig.model_config = {
        ...this.agentConfig.model_config,
        ...params.model_config,
      }
      changedFields.push('model_config')
    }

    // 更新系统提示词（热更新：worker 在下一轮 LLM 调用时通过 callback 看到新 prompt）
    if (params.system_prompt !== undefined) {
      this.workerHandler?.updateSystemPrompt(params.system_prompt)
      this.agentConfig.system_prompt = params.system_prompt
      changedFields.push('system_prompt')
    }

    // 更新 MCP Servers（热更新：mcpConnector.reconnect 原子接管；失败抛出由 admin 感知）
    if (params.mcp_servers !== undefined) {
      await this.mcpConnector.reconnect(params.mcp_servers)
      this.agentConfig.mcp_servers = params.mcp_servers
      changedFields.push('mcp_servers')
    }

    // 更新 Skills（热更新：worker 在下一轮 LLM 调用时通过 callback 看到新 skill 列表）
    if (params.skills !== undefined) {
      this.workerHandler?.updateSkills(params.skills)
      this.agentConfig.skills = params.skills
      changedFields.push('skills')
    }

    // 根据变更字段，按需触发 handler 重建
    if (modelConfigChanged || skillsChanged || systemPromptChanged) {
      const mergedModelConfig = this.agentConfig.model_config ?? {}
      // skills / system_prompt 变更时 Front 必须重建（Front prompt closure 在构造时绑定 personality + skill listing）；
      // Worker 已通过 updateSkills / updateSystemPrompt 热更新，无需重建（重建会让 in-flight task 的 RPC 路由
      // 找不到原 activeTasks 条目）。仅 model_config 变化才重建 Worker。
      await this.updateLlmClients(mergedModelConfig, {
        forceFrontRebuild: skillsChanged || systemPromptChanged,
        skipWorkerRebuild: !modelConfigChanged,
      })
    }

    // 更新扩展配置（热生效，下次使用对应功能时生效）
    if (params.extra !== undefined && Object.keys(params.extra).length > 0) {
      this.extra = { ...this.extra, ...params.extra }
      this.workerHandler?.updateExtra(params.extra)
      changedFields.push('extra')
    }

    // 更新最大迭代次数
    if (params.max_iterations !== undefined) {
      this.agentConfig.max_iterations = params.max_iterations
      changedFields.push('max_iterations')
      // FrontHandler 和 WorkerHandler 的 max_iterations 在构造时设置
      // 更新后需要重新创建 Handler 或重启
      restartRequired = true
    }

    console.log(`[${this.config.moduleId}] Config updated: ${changedFields.join(', ')}`)
    if (restartRequired) {
      console.log(`[${this.config.moduleId}] Restart required for changes to take effect`)
    }

    return {
      restart_required: restartRequired,
      config: this.agentConfig,
      changed_fields: changedFields,
    }
  }

  /**
   * 热更新 LLM 客户端
   * @param modelConfig 新的模型配置
   * @param options.forceFrontRebuild 强制重建 Front handler（skills / system_prompt 等 prompt 依赖字段变更时用）
   * @param options.skipWorkerRebuild 跳过 Worker handler 重建（skills / system_prompt 走 worker 自己的热更新方法
   *   updateSkills / updateSystemPrompt，重建会鬼存 in-flight task 的 activeTasks）
   */
  private async updateLlmClients(
    modelConfig: Record<string, LLMConnectionInfo>,
    options: { forceFrontRebuild?: boolean; skipWorkerRebuild?: boolean } = {},
  ): Promise<void> {
    const { basePersonality, workerPersonality, frontSkillListing } =
      this.buildPromptParts(this.agentConfig?.system_prompt, this.agentConfig?.skills)

    // MCP config factory: creates fresh in-process McpServer instances per task
    const createMcpConfigs = (): Record<string, McpServer> => ({
      'crab-messaging': createCrabMessagingServer({
        rpcClient: this.rpcClient,
        moduleId: this.config.moduleId,
        getAdminPort: () => this.getAdminPort(),
        resolveChannelPort: (channelId) => this.getChannelPort(channelId),
      }, this.sandboxPathMappingsRef),
    })

    // 更新 Front Agent
    if (this.roles.has('front')) {
      const frontConfig = modelConfig.triage
      if (frontConfig) {
        const formatChanged = this.frontHandlerFormat !== frontConfig.format
        if (this.frontHandler && !formatChanged && !options.forceFrontRebuild) {
          this.frontHandler.updateLlmConfig({
            endpoint: frontConfig.endpoint,
            apikey: frontConfig.apikey,
            model: frontConfig.model_id,
            ...(frontConfig.account_id ? { accountId: frontConfig.account_id } : {}),
          })
          console.log(`[${this.config.moduleId}] Front Agent LLM config updated`)
        } else {
          const adapter = createAdapter({
            endpoint: frontConfig.endpoint,
            apikey: frontConfig.apikey,
            format: frontConfig.format as LLMFormat,
            ...(frontConfig.account_id ? { accountId: frontConfig.account_id } : {}),
          })
          const llmConfig: FrontHandlerLlmConfig = {
            adapter,
            model: frontConfig.model_id,
          }
          this.frontHandler = new FrontHandler(llmConfig, this.buildToolExecutorDeps(), {
            getSystemPrompt: (isGroup) => this.promptManager.assembleFrontPrompt({
              isGroup, adminPersonality: basePersonality, workerCapabilities: this.getWorkerCapabilitySummary(), skillListing: frontSkillListing,
            }),
            mcpConfigFactory: createMcpConfigs,
            getTimezone: () => resolveTimezone(this.agentConfig?.timezone),
          })
          this.frontHandlerFormat = frontConfig.format as LLMFormat
          console.log(`[${this.config.moduleId}] Front Agent handler created (format: ${frontConfig.format})`)
        }
      }
    }

    // 更新 Digest 模型（在 Worker 之前，因为 WorkerHandler 构造需要 digestSdkEnv）
    const digestConfig = modelConfig.digest ?? modelConfig.triage ?? modelConfig.worker
    if (digestConfig) {
      this.digestSdkEnv = this.buildSdkEnv(digestConfig)
    }

    // 更新 Worker Agent — 仅 model_config 真正变化时重建（skills / system_prompt 走热更新方法）
    if (this.roles.has('worker') && !options.skipWorkerRebuild) {
      const workerConfig = modelConfig.worker
      if (workerConfig) {
        this.sdkEnvWorker = this.buildSdkEnv(workerConfig)
        this.workerHandler = this.createWorkerHandler(
          this.sdkEnvWorker, modelConfig, workerPersonality,
          createMcpConfigs, this.agentConfig?.builtin_tool_config, this.agentConfig?.skills)
        this.decisionDispatcher.setWorkerHandler(this.workerHandler)
        console.log(`[${this.config.moduleId}] Worker Agent SDK env ${this.workerHandler ? 'updated' : 'created from config push'}`)
      }
    }
  }

  // ============================================================================
  // Trace 辅助方法
  // ============================================================================

  /**
   * 构建 TraceCallback，用于向 TraceStore 写入 Span
   */
  private buildTraceCallback(traceId: string): TraceCallback {
    const store = this.traceStore
    // 闭包追踪父 span ID，用于建立 llm_call / tool_call 的父子关系
    let currentLoopSpanId: string | undefined
    let currentLlmSpanId: string | undefined

    return {
      onLoopStart(loopLabel?: string, initData?: {
        system_prompt?: string
        model?: string
        tools?: string[]
        mcp_servers?: Array<{ name: string; status: string }>
        skills?: string[]
      }): string {
        const span = store.startSpan(traceId, {
          type: 'agent_loop',
          details: {
            loop_label: loopLabel,
            ...(initData ?? {}),
          },
        })
        currentLoopSpanId = span.span_id
        return span.span_id
      },

      onLoopEnd(spanId: string, status: 'completed' | 'failed', iterationCount: number): void {
        store.endSpan(traceId, spanId, status, { iteration_count: iterationCount } as Partial<import('./types.js').AgentLoopDetails>)
        if (currentLoopSpanId === spanId) currentLoopSpanId = undefined
      },

      onLlmCallStart(iteration: number, inputSummary: string, attempt?: number): string {
        const span = store.startSpan(traceId, {
          type: 'llm_call',
          parent_span_id: currentLoopSpanId,
          details: { iteration, attempt, input_summary: inputSummary },
        })
        currentLlmSpanId = span.span_id
        return span.span_id
      },

      onLlmCallEnd(spanId: string, result: { stopReason?: string; outputSummary?: string; toolCallsCount?: number; fullInput?: string; fullOutput?: string; error?: string }): void {
        store.endSpan(traceId, spanId, result.error ? 'failed' : 'completed', {
          stop_reason: result.stopReason,
          output_summary: result.error ?? result.outputSummary,
          tool_calls_count: result.toolCallsCount,
          full_input: result.fullInput,
          full_output: result.fullOutput,
        } as Partial<import('./types.js').LlmCallDetails>)
        if (currentLlmSpanId === spanId) currentLlmSpanId = undefined
      },

      onToolCallStart(toolName: string, inputSummary: string): string {
        const span = store.startSpan(traceId, {
          type: 'tool_call',
          parent_span_id: currentLlmSpanId,
          details: { tool_name: toolName, input_summary: inputSummary },
        })
        return span.span_id
      },

      onToolCallEnd(spanId: string, outputSummary: string, error?: string): void {
        store.endSpan(traceId, spanId, error ? 'failed' : 'completed', {
          output_summary: outputSummary,
          error,
        } as Partial<import('./types.js').ToolCallDetails>)
      },
    }
  }

  // ============================================================================
  // Trace RPC 方法
  // ============================================================================

  private handleGetTraces(params: { limit?: number; offset?: number; status?: string }): { traces: import('./types.js').AgentTrace[]; total: number } {
    return this.traceStore.getTraces(params.limit, params.offset, params.status)
  }

  private async handleGetTrace(params: { trace_id: string }): Promise<{ trace: import('./types.js').AgentTrace }> {
    const trace = await this.traceStore.getFullTrace(params.trace_id)
    if (!trace) {
      throw new Error(`Trace not found: ${params.trace_id}`)
    }
    return { trace }
  }

  private handleClearTraces(params: { before?: string; trace_ids?: string[] }): { cleared_count: number } {
    const count = this.traceStore.clearTraces(params.before, params.trace_ids)
    return { cleared_count: count }
  }

  private handleSearchTraces(params: {
    task_id?: string
    time_range?: { start: string; end: string }
    keyword?: string
    status?: string
    limit?: number
    offset?: number
  }): { traces: import('./core/trace-store.js').TraceIndexEntry[]; total: number } {
    return this.traceStore.searchTraces(params)
  }

  private handleGetTraceTree(params: { task_id: string }): import('./core/trace-store.js').TraceTree {
    return this.traceStore.getTraceTree(params.task_id)
  }

  // ============================================================================
  // 健康检查
  // ============================================================================

  protected override async getHealthDetails(): Promise<Record<string, unknown>> {
    return {
      roles: Array.from(this.roles),
      idle: this.sessionManager.getPendingSessionCount() === 0,
      processing_messages: this.sessionManager.getPendingSessionCount(),
      active_sessions: this.sessionManager.getActiveSessionCount(),
      current_task_count: this.workerHandler?.getActiveTaskCount() ?? 0,
      llm_status: this.isConfigured() ? 'ready' : 'not_configured',
      sdk_status: (this.frontHandler || this.sdkEnvWorker) ? 'ready' : 'not_configured',
      mcp_servers_count: this.mcpConnector.count,
    }
  }

  // ============================================================================
  // 端口解析
  // ============================================================================

  /**
   * Get external MCP tool names for Front prompt injection.
   * Front doesn't call these tools — it uses this list to know what Worker can do.
   */
  /**
   * Build a concise capability summary for Front prompt injection.
   * Front only needs category-level awareness to route create_task decisions,
   * not per-tool parameter docs.
   * Returns one entry per MCP server (category) with tool names listed.
   */
  private getWorkerCapabilitySummary(): Array<{ category: string; tools: string[] }> {
    const grouped = new Map<string, string[]>()
    for (const t of this.mcpConnector.getAllTools()) {
      // Delimiter is __ (double underscore); server names may contain single underscores
      const m = t.name.match(/^mcp__(.+?)__(.+)$/)
      const category = m ? m[1] : 'other'
      const toolName = m ? m[2] : t.name
      const list = grouped.get(category) ?? []
      list.push(toolName)
      grouped.set(category, list)
    }
    return Array.from(grouped.entries()).map(([category, tools]) => ({ category, tools }))
  }

  private getActiveTasksList(): Array<{ task_id: string; status: string; started_at: string; title?: string }> {
    return this.workerHandler?.getActiveTasksForQuery() ?? []
  }

  private async getAdminPort(): Promise<number> {
    if (this.adminPort === undefined) {
      const modules = await this.rpcClient.resolve({ module_type: 'admin' }, this.config.moduleId)
      this.adminPort = modules[0]?.port ?? 3000
    }
    return this.adminPort
  }

  private async getMemoryPort(): Promise<number> {
    if (this.memoryPort === undefined) {
      const modules = await this.rpcClient.resolve({ module_type: 'memory' }, this.config.moduleId)
      this.memoryPort = modules[0]?.port ?? 19002
    }
    return this.memoryPort
  }

  private async getChannelPort(channelId: ModuleId): Promise<number> {
    let port = this.channelPorts.get(channelId)
    if (port === undefined) {
      const modules = await this.rpcClient.resolve({ module_id: channelId }, this.config.moduleId)
      port = modules[0]?.port ?? 0
      this.channelPorts.set(channelId, port)
    }
    return port
  }

  // ============================================================================
  // 生命周期
  // ============================================================================

  protected override async onStart(): Promise<void> {
    this.sessionManager.startCleanup()

    // Connect to external MCP servers (Admin-configured)
    if (this.agentConfig?.mcp_servers && this.agentConfig.mcp_servers.length > 0) {
      console.log(
        `[${this.config.moduleId}] Connecting to ${this.agentConfig.mcp_servers.length} MCP server(s)...`
      )
      await this.mcpConnector.connectAll(this.agentConfig.mcp_servers)
      console.log(
        `[${this.config.moduleId}] ${this.mcpConnector.count} MCP server(s) connected`
      )
    }

    // Startup cleanup of expired JSONL trace files
    const retentionDays = parseInt(process.env.TRACE_RETENTION_DAYS ?? '30', 10) || 30
    try {
      const removed = this.traceStore.cleanupOldFiles(retentionDays)
      if (removed > 0) {
        console.log(`[${this.config.moduleId}] Cleaned up ${removed} expired trace file(s) (retention: ${retentionDays}d)`)
      }
    } catch { /* best effort */ }

    // Daily cleanup interval
    const ONE_DAY_MS = 24 * 60 * 60 * 1000
    this.traceCleanupInterval = setInterval(() => {
      try {
        const count = this.traceStore.cleanupOldFiles(retentionDays)
        if (count > 0) {
          console.log(`[${this.config.moduleId}] Daily cleanup: removed ${count} expired trace file(s)`)
        }
      } catch { /* best effort */ }
    }, ONE_DAY_MS)
  }

  protected override async onStop(): Promise<void> {
    this.sessionManager.stopCleanup()
    this.attentionScheduler.stopAll()

    if (this.traceCleanupInterval) {
      clearInterval(this.traceCleanupInterval)
      this.traceCleanupInterval = undefined
    }

    // Disconnect external MCP servers
    await this.mcpConnector.disconnectAll()

    // Stop LSP servers
    await this.lspManager.stop()
  }
}
