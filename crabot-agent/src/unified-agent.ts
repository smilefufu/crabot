/**
 * UnifiedAgent - 合并 Flow + Agent 的统一智能体模块
 *
 * 整合编排层（原 Flow）和智能体层（原 Agent）的能力
 *
 * @see crabot-docs/protocols/protocol-agent-v2.md
 */

import * as path from 'path'
import { ModuleBase, type ModuleConfig } from './core/module-base.js'
import type { Event, ModuleId } from './core/base-protocol.js'
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
  TaskId,
  FriendId,
  Friend,
  LLMRoleRequirement,
  GetConfigResult,
  UpdateConfigParams,
  UpdateConfigResult,
  LLMConnectionInfo,
  TraceCallback,
} from './types.js'
import { SessionManager } from './orchestration/session-manager.js'
import { SwitchMapHandler } from './orchestration/switchmap-handler.js'
import { PermissionChecker } from './orchestration/permission-checker.js'
import { WorkerSelector } from './orchestration/worker-selector.js'
import { ContextAssembler } from './orchestration/context-assembler.js'
import { DecisionDispatcher } from './orchestration/decision-dispatcher.js'
import { MemoryWriter } from './orchestration/memory-writer.js'
import { AttentionScheduler, type AttentionConfig, type BufferedMessage } from './orchestration/attention-scheduler.js'
import { FrontHandler } from './agent/front-handler.js'
import type { LLMClientConfig } from './agent/llm-client.js'
import type { ToolExecutorDeps } from './agent/tool-executor.js'
import { WorkerHandler, type SdkEnvConfig } from './agent/worker-handler.js'
import type { McpServerConfig as SdkMcpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { MCPManager } from './agent/mcp-manager.js'
import { createCrabMessagingServer, type PathMapping } from './mcp/crab-messaging.js'
import { TraceStore } from './core/trace-store.js'
import { PromptManager } from './prompt-manager.js'

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
  private workerHandler?: WorkerHandler
  private mcpManager?: MCPManager
  private roles: Set<'front' | 'worker'> = new Set()
  /** SDK 环境配置（Worker 专用） */
  private sdkEnvWorker?: SdkEnvConfig
  /** Worker sandbox 路径映射（每次 executeTask 时更新） */
  private sandboxPathMappingsRef: { current: PathMapping[] } = { current: [] }

  // 配置
  private orchestrationConfig: OrchestrationConfig
  private agentConfig?: AgentLayerConfig

  // 端口缓存
  private adminPort?: number
  private memoryPort?: number
  private channelPorts: Map<ModuleId, number> = new Map()
  /** Crabot 群昵称缓存: channel_id → display_name */
  private crabDisplayNames: Map<ModuleId, string> = new Map()

  // Trace 存储
  private traceStore: TraceStore
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

    const traceDir = path.join(process.env.DATA_DIR ?? './data', 'agent', 'traces')
    this.traceStore = new TraceStore(100, traceDir)

    const agentDataDir = process.env.DATA_DIR
      ? path.join(process.env.DATA_DIR, 'agent')
      : path.join('./data', 'agent')
    this.promptManager = new PromptManager(agentDataDir)
    this.promptManager.init()

    this.orchestrationConfig = config.orchestration
    this.agentConfig = config.agent_config

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
      this.workerSelector,
      this.contextAssembler,
      this.memoryWriter,
      async () => await this.getAdminPort(),
      async (channelId) => await this.getChannelPort(channelId)
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
    const defaultModel = this.agentConfig?.model_config?.default
    return !!(defaultModel && defaultModel.apikey && defaultModel.model_id)
  }

  /**
   * 初始化智能体层
   */
  private initializeAgentLayer(config: AgentLayerConfig): void {
    // 设置角色
    for (const role of config.roles) {
      this.roles.add(role)
    }

    // 初始化 MCP Manager（如果有配置）
    if (config.mcp_servers && config.mcp_servers.length > 0) {
      this.mcpManager = new MCPManager({
        getModuleId: () => this.config.moduleId,
      })
    }

    // 构建 SDK 环境变量（通过 LiteLLM 代理）
    const adminPersonality = this.enhanceSystemPrompt(config.system_prompt, config.skills)

    // MCP config factory: creates fresh McpServer instances per runSdk() call
    // This avoids the "Already connected to a transport" Protocol reuse error
    const externalMcpConfigs = this.buildExternalMcpConfigs(config.mcp_servers)
    const createMcpConfigs = (): Record<string, SdkMcpServerConfig> => ({
      'crab-messaging': createCrabMessagingServer({
        rpcClient: this.rpcClient,
        moduleId: this.config.moduleId,
        getAdminPort: () => this.getAdminPort(),
        resolveChannelPort: (channelId) => this.getChannelPort(channelId),
      }, this.sandboxPathMappingsRef) as unknown as SdkMcpServerConfig,
      ...externalMcpConfigs,
    })

    // 初始化 Front Handler（如果有 front 角色）
    if (this.roles.has('front')) {
      const frontModelConfig = config.model_config?.fast ?? config.model_config?.default
      if (frontModelConfig) {
        const llmConfig: LLMClientConfig = {
          endpoint: frontModelConfig.endpoint,
          apikey: frontModelConfig.apikey,
          model: frontModelConfig.model_id,
        }
        const toolExecutorDeps: ToolExecutorDeps = {
          rpcClient: this.rpcClient,
          moduleId: this.config.moduleId,
          getAdminPort: () => this.getAdminPort(),
          resolveChannelPort: (channelId) => this.getChannelPort(channelId),
          getActiveTasks: () => this.getActiveTasksList(),
        }
        this.frontHandler = new FrontHandler(llmConfig, toolExecutorDeps, {
          systemPrompt: this.promptManager.assembleFrontPrompt(adminPersonality || undefined),
        })
      }
    }

    // 初始化 Worker Handler（如果有 worker 角色）
    if (this.roles.has('worker')) {
      const workerModelConfig = config.model_config?.smart ?? config.model_config?.default
      if (workerModelConfig) {
        this.sdkEnvWorker = this.buildSdkEnv(workerModelConfig)
        const workerSdkEnv = this.sdkEnvWorker
        // MCP 服务器配置转换为 SDK 格式（stdio 类型直传）
        this.workerHandler = new WorkerHandler(workerSdkEnv, {
          systemPrompt: this.promptManager.assembleWorkerPrompt(adminPersonality || undefined),
        }, createMcpConfigs, {
          rpcClient: this.rpcClient,
          moduleId: this.config.moduleId,
          resolveChannelPort: (channelId) => this.getChannelPort(channelId),
        })
      }
    }
  }

  /**
   * 从 LLMConnectionInfo 构建 SDK 环境配置
   */
  private buildSdkEnv(connInfo: LLMConnectionInfo): SdkEnvConfig {
    return {
      modelId: connInfo.model_id,
      env: {
        ANTHROPIC_BASE_URL: connInfo.endpoint,
        ANTHROPIC_API_KEY: connInfo.apikey || 'dummy-key',
      },
    }
  }

  /**
   * 将 MCPServerConfig[] 转换为 SDK 的 Record<string, SdkMcpServerConfig>
   */
  private buildExternalMcpConfigs(
    configs?: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }>
  ): Record<string, SdkMcpServerConfig> {
    if (!configs || configs.length === 0) return {}
    const result: Record<string, SdkMcpServerConfig> = {}
    for (const cfg of configs) {
      result[cfg.name] = {
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env,
      } as unknown as SdkMcpServerConfig
    }
    return result
  }

  /**
   * 增强 system_prompt，添加 Skills 信息
   */
  private enhanceSystemPrompt(
    basePrompt: string,
    skills?: Array<{ id: string; name: string; content: string }>
  ): string {
    if (!skills || skills.length === 0) {
      return basePrompt
    }

    const skillsSection = skills
      .map((skill) => `### ${skill.name}\n${skill.content}`)
      .join('\n\n')

    return `${basePrompt}

## 可用技能

${skillsSection}

当用户请求与上述技能相关的任务时，请使用对应的技能来完成。`
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

    try {
      // 4. 如果没有配置 Front Agent 能力，需要调用外部 Agent
      if (!this.roles.has('front') || !this.frontHandler) {
        this.traceStore.endTrace(trace.trace_id, 'failed', { summary: 'No front agent configured' })
        return
      }

      // 5. 派生记忆读写权限
      const memPerms = this.deriveMemoryPermissions(friend, session.session_id)

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

      // 8. 调用 Front Agent（传入合并后的消息列表）
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
          : decision.type === 'forward_to_worker'
          ? `task_id: ${decision.task_id}`
          : 'silent'

        const decisionSpan = this.traceStore.startSpan(trace.trace_id, {
          type: 'decision',
          details: { decision_type: decision.type, summary: decisionSummary },
        })

        // supplement_task: deliver directly to local Worker (bypass Admin lookup)
        if (decision.type === 'supplement_task' && this.workerHandler) {
          await this.handleLocalSupplement(decision, session, trace.trace_id, decisionSpan.span_id)
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
              traceStore: this.traceStore,
              traceId: trace.trace_id,
              parentSpanId: decisionSpan.span_id,
            }
          )
        }

        this.traceStore.endSpan(trace.trace_id, decisionSpan.span_id, 'completed')
      }

      // 11. 写入短期记忆：分诊决策事件
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

          await this.memoryWriter.writeTriageDecision({
            friend_name: friend.display_name,
            friend_id: sender.friend_id,
            channel_id: session.channel_id,
            session_id: session.session_id,
            message_brief: messageBrief,
            decision: decision.type as 'direct_reply' | 'create_task' | 'forward_to_worker' | 'supplement_task',
            task_id: 'task_id' in decision ? (decision as { task_id: string }).task_id : undefined,
            visibility: memPerms.write_visibility,
            scopes: memPerms.write_scopes,
          })

          this.traceStore.endSpan(trace.trace_id, memSpan.span_id, 'completed')
        }
      }

      this.traceStore.endTrace(trace.trace_id, 'completed', {
        summary: this.extractReplyText(result.decisions)?.slice(0, 200) ?? 'completed',
      })
    } catch (error) {
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

    try {
      const memPerms = this.deriveMemoryPermissions(lastEntry.friend, sessionId)

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
      const result = await this.frontHandler.handleMessage({
        messages,
        context,
      }, traceCallback)

      // 判断是否产生了有意义的回复
      const hasReply = result.decisions.some(
        (d) => d.type === 'direct_reply' || d.type === 'create_task'
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
                : decision.type === 'forward_to_worker'
                ? `task_id: ${decision.task_id}`
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
              traceStore: this.traceStore,
              traceId: trace.trace_id,
              parentSpanId: decisionSpan.span_id,
            }
          )

          this.traceStore.endSpan(trace.trace_id, decisionSpan.span_id, 'completed')
        }
      }
      // else: silent discard — 不发送任何回复

      // 报告结果，调整注意力巡检间隔
      this.attentionScheduler.reportResult(sessionId, hasReply)

      this.traceStore.endTrace(trace.trace_id, 'completed', {
        summary: hasReply
          ? (this.extractReplyText(result.decisions)?.slice(0, 200) ?? 'replied')
          : 'silent discard',
      })
    } catch (error) {
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
   * 从 Friend 权限派生记忆读写权限参数
   *
   * - master 权限：写入 private，读取不过滤（可见所有私有记忆）
   * - normal 权限：写入 internal + session scope，读取限当前 session scope
   */
  private deriveMemoryPermissions(friend: Friend, sessionId: string): MemoryPermissions {
    if (friend.permission === 'master') {
      return {
        write_visibility: 'private',
        write_scopes: [],
        read_min_visibility: 'private',
        read_accessible_scopes: undefined,
      }
    }

    return {
      write_visibility: 'internal',
      write_scopes: [sessionId],
      read_min_visibility: 'internal',
      read_accessible_scopes: [sessionId],
    }
  }

  /**
   * Handle supplement_task locally — deliver directly to Worker without Admin roundtrip.
   * In unified agent mode, the Worker is local, no need to look up worker_agent_id via Admin.
   */
  private async handleLocalSupplement(
    decision: import('./types.js').SupplementTaskDecision,
    session: { channel_id: string; session_id: string },
    traceId: string,
    parentSpanId: string,
  ): Promise<void> {
    // Step 1: Send immediate reply (auto-generate if LLM didn't provide one)
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

    // Step 2: Deliver to local Worker
    const deliverSpan = this.traceStore.startSpan(traceId, {
      type: 'tool_call' as const,
      parent_span_id: parentSpanId,
      details: {
        tool_name: 'supplement_deliver',
        input_summary: `task_id=${decision.task_id}, content="${decision.supplement_content.slice(0, 100)}"`,
      },
    })

    // Check: is there a local Worker with this task?
    const activeTasks = this.workerHandler!.getActiveTasksForQuery()
    const matchingTask = activeTasks.find(t => t.task_id === decision.task_id)

    if (!matchingTask) {
      this.traceStore.endSpan(traceId, deliverSpan.span_id, 'failed', {
        error: `task_id=${decision.task_id} not found in activeTasks. Active: [${activeTasks.map(t => t.task_id).join(', ')}]`,
      })
      return
    }

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
        output_summary: `delivered to task ${decision.task_id} (status: ${matchingTask.status})`,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.traceStore.endSpan(traceId, deliverSpan.span_id, 'failed', {
        error: msg,
      })
    }
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
      if (decision.type === 'forward_to_worker' && decision.immediate_reply?.text) {
        return decision.immediate_reply.text
      }
    }
    return undefined
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
        { tasks: Array<{ task_id: string; task_type: string; status: string }> }
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

        // 组装上下文（channel 内部调用无 permResult，默认使用 normal friend 权限）
        const channelMemPerms: MemoryPermissions = {
          write_visibility: 'internal',
          write_scopes: [sessionId],
          read_min_visibility: 'internal',
          read_accessible_scopes: [sessionId],
        }
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
              : decision.type === 'forward_to_worker'
              ? `task_id: ${decision.task_id}`
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
            traceStore: this.traceStore,
            traceId: trace.trace_id,
            parentSpanId: decisionSpan.span_id,
          }
        )

        this.traceStore.endSpan(trace.trace_id, decisionSpan.span_id, 'completed')

        if (dispatchResult.task_id) {
          taskIds.push(dispatchResult.task_id)
        }
      }

      // 写入短期记忆：分诊决策事件
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

          await this.memoryWriter.writeTriageDecision({
            friend_name: 'Master',
            friend_id: message.sender.friend_id ?? 'master',
            channel_id: 'admin-web',
            session_id: sessionId,
            message_brief: messageBrief,
            decision: decision.type as 'direct_reply' | 'create_task' | 'forward_to_worker' | 'supplement_task',
            task_id: 'task_id' in decision ? (decision as { task_id: string }).task_id : undefined,
            visibility: masterMemPerms.write_visibility,
            scopes: masterMemPerms.write_scopes,
          })

          this.traceStore.endSpan(trace.trace_id, memSpan.span_id, 'completed')
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
    task_type: string
    title: string
    description: string
    preferred_worker_specialization?: string
  }): Promise<{ task_id: string; assigned_worker: ModuleId }> {
    const { schedule_id, task_type, title, description, preferred_worker_specialization } = params

    try {
      // 选择 Worker
      const workerId = await this.workerSelector.selectWorker({
        task_type,
        specialization_hint: preferred_worker_specialization,
      })

      // 创建任务
      const adminPort = await this.getAdminPort()
      const taskResult = await this.rpcClient.call<
        {
          title: string
          description: string
          task_type: string
          assigned_worker: string
          source: { origin: string; source_module_id: string }
          refs?: { schedule_id: string }
        },
        { task_id: string }
      >(
        adminPort,
        'create_task',
        {
          title,
          description,
          task_type,
          assigned_worker: workerId,
          source: {
            origin: 'system',
            source_module_id: this.config.moduleId,
          },
          refs: { schedule_id },
        },
        this.config.moduleId
      )

      console.log(
        `[${this.config.moduleId}] Created task ${taskResult.task_id} from schedule ${schedule_id}, assigned to ${workerId}`
      )

      return { task_id: taskResult.task_id, assigned_worker: workerId }
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
    supported_task_types: string[]
    max_concurrent_tasks: number
  } {
    return {
      roles: Array.from(this.roles),
      specialization: this.agentConfig?.specialization ?? 'general',
      supported_task_types: this.agentConfig?.supported_task_types ?? [],
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
          key: 'default',
          description: '默认执行模型，Front 和 Worker 默认使用',
          required: true,
          used_by: ['front', 'worker'],
        },
        {
          key: 'fast',
          description: '快速响应模型，用于 Front Agent 快速分诊（可选）',
          required: false,
          used_by: ['front'],
        },
        {
          key: 'smart',
          description: '深度推理模型，用于 Worker Agent 复杂任务（可选）',
          required: false,
          used_by: ['worker'],
        },
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
    supported_task_types: string[]
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
      supported_task_types: this.agentConfig?.supported_task_types ?? ['general'],
    }
  }

  private async handleExecuteTask(params: ExecuteTaskParams & {
    parent_trace_id?: string
    parent_span_id?: string
  }): Promise<ExecuteTaskResult> {
    if (!this.workerHandler) {
      throw new Error('Worker handler not configured')
    }

    const { parent_trace_id, parent_span_id, ...taskParams } = params

    // 更新 sandbox 路径映射（crab-messaging send_message 需要路径转换）
    this.sandboxPathMappingsRef.current = taskParams.context.sandbox_path_mappings ?? []

    // 创建 Trace
    const trace = this.traceStore.startTrace({
      module_id: this.config.moduleId,
      trigger: {
        type: 'task',
        summary: taskParams.task.task_title.slice(0, 200),
        source: taskParams.context.task_origin?.channel_id,
      },
      parent_trace_id,
      parent_span_id,
    })

    const traceCallback = this.buildTraceCallback(trace.trace_id)

    try {
      const result = await this.workerHandler.executeTask(taskParams, traceCallback)
      this.traceStore.endTrace(trace.trace_id, result.outcome === 'completed' ? 'completed' : 'failed', {
        summary: result.summary.slice(0, 200),
        error: result.outcome === 'failed' ? result.summary : undefined,
      })
      return result
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

    // 更新模型配置（需要热更新 LLM 客户端）
    if (params.model_config) {
      this.agentConfig.model_config = {
        ...this.agentConfig.model_config,
        ...params.model_config,
      }
      changedFields.push('model_config')

      // 热更新 LLM 客户端
      await this.updateLlmClients(params.model_config)
    }

    // 更新系统提示词（需要重启才能生效）
    if (params.system_prompt !== undefined) {
      this.agentConfig.system_prompt = params.system_prompt
      changedFields.push('system_prompt')
      restartRequired = true
    }

    // 更新 MCP Servers（需要重启才能生效）
    if (params.mcp_servers !== undefined) {
      this.agentConfig.mcp_servers = params.mcp_servers
      changedFields.push('mcp_servers')
      restartRequired = true
    }

    // 更新 Skills（需要重启才能生效）
    if (params.skills !== undefined) {
      this.agentConfig.skills = params.skills
      changedFields.push('skills')
      restartRequired = true
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
   */
  private async updateLlmClients(modelConfig: Record<string, LLMConnectionInfo>): Promise<void> {
    const adminPersonality = this.enhanceSystemPrompt(
      this.agentConfig?.system_prompt ?? '',
      this.agentConfig?.skills
    )

    // MCP config factory: creates fresh McpServer instances per runSdk() call
    const externalMcpConfigs = this.buildExternalMcpConfigs(this.agentConfig?.mcp_servers)
    const createMcpConfigs = (): Record<string, SdkMcpServerConfig> => ({
      'crab-messaging': createCrabMessagingServer({
        rpcClient: this.rpcClient,
        moduleId: this.config.moduleId,
        getAdminPort: () => this.getAdminPort(),
        resolveChannelPort: (channelId) => this.getChannelPort(channelId),
      }, this.sandboxPathMappingsRef) as unknown as SdkMcpServerConfig,
      ...externalMcpConfigs,
    })

    // 更新 Front Agent
    if (this.roles.has('front') && this.frontHandler) {
      const frontConfig = modelConfig.fast ?? modelConfig.default
      if (frontConfig) {
        this.frontHandler.updateLlmConfig({
          endpoint: frontConfig.endpoint,
          apikey: frontConfig.apikey,
          model: frontConfig.model_id,
        })
        console.log(`[${this.config.moduleId}] Front Agent LLM config updated`)
      }
    }

    // 更新 Worker Agent
    if (this.roles.has('worker') && this.workerHandler) {
      const workerConfig = modelConfig.smart ?? modelConfig.default
      if (workerConfig) {
        this.sdkEnvWorker = this.buildSdkEnv(workerConfig)
        const updatedWorkerSdkEnv = this.sdkEnvWorker
        this.workerHandler = new WorkerHandler(updatedWorkerSdkEnv, {
          systemPrompt: this.promptManager.assembleWorkerPrompt(adminPersonality || undefined),
        }, createMcpConfigs, {
          rpcClient: this.rpcClient,
          moduleId: this.config.moduleId,
          resolveChannelPort: (channelId) => this.getChannelPort(channelId),
        })
        console.log(`[${this.config.moduleId}] Worker Agent SDK env updated`)
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

      onLlmCallEnd(spanId: string, result: { stopReason?: string; outputSummary?: string; toolCallsCount?: number; fullInput?: string; fullOutput?: string }): void {
        store.endSpan(traceId, spanId, 'completed', {
          stop_reason: result.stopReason,
          output_summary: result.outputSummary,
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

  private handleGetTrace(params: { trace_id: string }): { trace: import('./types.js').AgentTrace } {
    const trace = this.traceStore.getTrace(params.trace_id)
    if (!trace) {
      throw new Error(`Trace not found: ${params.trace_id}`)
    }
    return { trace }
  }

  private handleClearTraces(params: { before?: string; trace_ids?: string[] }): { cleared_count: number } {
    const count = this.traceStore.clearTraces(params.before, params.trace_ids)
    return { cleared_count: count }
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
      sdk_status: (this.frontHandler || this.sdkEnvWorker) ? 'ready' : 'not_configured',
      mcp_servers_count: this.mcpManager?.count ?? 0,
    }
  }

  // ============================================================================
  // 端口解析
  // ============================================================================

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

    // MCP Servers 现在由 SDK 管理连接，这里只做日志记录
    if (this.agentConfig?.mcp_servers && this.agentConfig.mcp_servers.length > 0) {
      console.log(
        `[${this.config.moduleId}] ${this.agentConfig.mcp_servers.length} MCP server(s) configured, will be managed by SDK`
      )
    }
  }

  protected override async onStop(): Promise<void> {
    this.sessionManager.stopCleanup()
    this.attentionScheduler.stopAll()

    // 停止 MCP Servers
    if (this.mcpManager) {
      await this.mcpManager.stopAll()
    }
  }
}
