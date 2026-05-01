/**
 * Worker Handler v3 - 任务执行处理器（self-built engine）
 *
 * 使用自建 engine 替代 claude-agent-sdk 的 query()：
 * - runEngine() + AnthropicAdapter 驱动 LLM 循环
 * - ToolDefinition[] 统一工具注册
 * - humanMessageQueue 注入纠偏消息
 * - AbortController 取消任务
 * - MCP Server 工具自动转换为 ToolDefinition
 */

import {
  runEngine,
  createAdapter,
  defineTool,
  getConfiguredBuiltinTools,
  ProgressDigest,
  filterToolsByPermission,
} from '../engine/index.js'
import { BgEntityRegistry } from '../engine/bg-entities/registry.js'
import { TransientShellRegistry } from '../engine/bg-entities/bg-shell.js'
import type { BgEntityOwner } from '../engine/bg-entities/types.js'
import type { BashBgContext } from '../engine/tools/index.js'
import type { BgToolDeps } from '../engine/tools/index.js'
import type {
  ToolDefinition,
  EngineTurnEvent,
  EngineResult,
  ContentBlock,
  ProgressDigestConfig,
  ProgressDigestDeps,
  ToolPermissionConfig,
  LiveProgressEvent,
} from '../engine/index.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MemoryWriter } from '../orchestration/memory-writer.js'
import type {
  ExecuteTaskParams,
  ExecuteTaskResult,
  WorkerAgentContext,
  WorkerTaskState,
  TaskId,
  TaskOrigin,
  ChannelMessage,
  TraceCallback,
  SkillConfig,
  BuiltinToolConfig,
  LiveTaskSnapshot,
  LiveToolCall,
  LiveCompletedTool,
  ResolvedPermissions,
} from '../types.js'
import type { RpcClient } from 'crabot-shared'
import { createCrabMemoryServer } from '../mcp/crab-memory.js'
import type { MemoryTaskContext } from '../mcp/crab-memory.js'
import { mcpServerToToolDefinitions } from './mcp-tool-bridge.js'
import { formatMessageContent, resolveImageBlocks } from './media-resolver.js'
import type { McpConnector } from './mcp-connector.js'
import { createSubAgentTool } from '../engine/sub-agent.js'
import type { SubAgentDefinition } from './subagent-prompts.js'
import { DELEGATE_TASK_SYSTEM_PROMPT } from './subagent-prompts.js'
import { HumanMessageQueue } from '../engine/human-message-queue.js'
import { createCodingExpertHookRegistry, createCliBlockHook } from '../hooks/defaults.js'
import { HookRegistry } from '../hooks/hook-registry.js'
import { PromptManager, formatChannelMessageLine } from '../prompt-manager.js'
import { formatNow, formatChannelMessageTime, resolveTimezone } from '../utils/time.js'
import { getInstanceSkillsDir } from '../core/data-paths.js'

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

type ProgressReportMode = 'silent' | 'text_forward' | 'digest'

function getReportMode(
  sessionType: 'private' | 'group' | undefined,
  isMasterPrivate: boolean,
  extra: Record<string, unknown>,
): ProgressReportMode {
  const raw = sessionType === 'group'
    ? extra.progress_report_group
    : isMasterPrivate
      ? extra.progress_report_master_private
      : extra.progress_report_other_private
  if (raw === 'silent' || raw === 'text_forward' || raw === 'digest') return raw
  return 'digest'
}

const LOG_FILE = path.join(process.cwd(), '../data/worker-handler-debug.log')

function log(msg: string) {
  const ts = new Date().toISOString()
  try { fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`) } catch { /* ignore */ }
}

export interface WorkerHandlerConfig {
  /**
   * Admin personality（system_prompt）。仅承载 personality，不再包含 skill listing。
   * skillListing 通过 `updateSkills` 维护，由 worker-handler 内 buildSkillListingSnapshot 即时拼装。
   */
  systemPrompt: string
  extra?: Record<string, unknown>
  /** 解析已校验的 IANA 时区，用于 prompt 时间感知。每次 LLM 调用 / 工具执行前重新读取，反映 admin 配置热更新 */
  getTimezone?: () => string
}

export interface WorkerDeps {
  rpcClient: RpcClient
  moduleId: string
  resolveChannelPort: (channelId: string) => Promise<number>
  getMemoryPort: () => Promise<number>
  /** Admin RPC 端口解析（get_task_details 工具用） */
  getAdminPort?: () => Promise<number>
  /**
   * 返回当前 task 的 permissionConfig（基于 task 自带的 resolved_permissions，
   * 缺省时回退到全局/会话级解析或 FAIL_CLOSED 兜底）。
   * 把 resolvedPerms 显式传入而不是读 UnifiedAgent 上的全局字段，是为了避免并发任务串改。
   */
  getPermissionConfig?: (
    tools: ReadonlyArray<ToolDefinition>,
    resolvedPerms?: ResolvedPermissions,
  ) => ToolPermissionConfig
}

import type { LLMFormat } from '../engine/llm-adapter'

export interface WorkerTraceContext {
  traceStore: import('../core/trace-store').TraceStore
  traceId: string
  relatedTaskId?: string
}

export interface SdkEnvConfig {
  modelId: string
  format: LLMFormat
  supportsVision?: boolean
  env: Record<string, string>
}

function adapterFromSdkEnv(sdkEnv: SdkEnvConfig) {
  return createAdapter({
    endpoint: sdkEnv.env.LLM_BASE_URL ?? '',
    apikey: sdkEnv.env.LLM_API_KEY ?? '',
    format: sdkEnv.format,
    ...(sdkEnv.env.LLM_ACCOUNT_ID ? { accountId: sdkEnv.env.LLM_ACCOUNT_ID } : {}),
  })
}


// ============================================================================
// WorkerHandler
// ============================================================================

export interface WorkerHandlerOptions {
  mcpConfigFactory?: () => Record<string, McpServer>
  deps?: WorkerDeps
  builtinToolConfig?: BuiltinToolConfig
  mcpConnector?: McpConnector
  digestSdkEnv?: SdkEnvConfig
  subAgentConfigs?: ReadonlyArray<{ readonly definition: SubAgentDefinition; readonly sdkEnv: SdkEnvConfig }>
  skills?: ReadonlyArray<SkillConfig>
  lspManager?: import('../lsp/lsp-manager').LSPManager
  memoryWriter?: MemoryWriter
  /**
   * Prompt 装配器。Worker 在每轮 LLM 调用前用它把 personality + skill listing + sub-agent
   * 重新拼成 system prompt，以便 updateSkills / updateSystemPrompt 即时生效。
   */
  promptManager?: PromptManager
  /**
   * Sub-agent hint 列表，用于注入到 worker prompt 末尾的"可用专项 Sub-agent"段落。
   * 来自 createWorkerHandler 解析 SUBAGENT_DEFINITIONS 后的实际可用列表。
   */
  subAgentHints?: ReadonlyArray<{ readonly toolName: string; readonly workerHint: string }>
}

export class WorkerHandler {
  private sdkEnv: SdkEnvConfig
  private systemPrompt: string
  private activeTasks: Map<TaskId, WorkerTaskState> = new Map()
  /** Human message queues for active tasks */
  private humanQueues: Map<TaskId, HumanMessageQueue> = new Map()
  /**
   * 飞行中任务的实时快照：current_turn / 上一轮模型话 / active_tools / 最近完成的工具。
   * 由 onLiveProgress 回调维护；executeTask 完成时清理。
   * ContextAssembler 同进程同步读取（getLiveSnapshot）以注入 Front prompt。
   */
  private liveSnapshots: Map<TaskId, LiveTaskSnapshot> = new Map()
  /** recent_completed 保留的最大条数 */
  private static readonly RECENT_COMPLETED_LIMIT = 5
  private mcpConfigFactory: (() => Record<string, McpServer>) | undefined
  private deps?: WorkerDeps
  private builtinToolConfig?: BuiltinToolConfig
  private mcpConnector?: McpConnector
  private extra: Record<string, unknown>
  private digestSdkEnv?: SdkEnvConfig
  private readonly subAgentConfigs: ReadonlyArray<{ readonly definition: SubAgentDefinition; readonly sdkEnv: SdkEnvConfig }>
  private skills: ReadonlyArray<SkillConfig>
  private readonly lspManager?: import('../lsp/lsp-manager').LSPManager
  private memoryWriter?: MemoryWriter
  private confirmedSnapshotBlock: string = ''
  private readonly promptManager?: PromptManager
  private readonly subAgentHints: ReadonlyArray<{ readonly toolName: string; readonly workerHint: string }>
  private readonly getTimezone: () => string
  /** Worker-singleton bg entity registry (persistent, disk-backed) */
  private readonly bgRegistry = new BgEntityRegistry()
  /** Worker-singleton transient shell registry (in-memory, task-bound) */
  private readonly transientShells = new TransientShellRegistry()
  /** Per-task output cursor map: key = `${taskId}:${entityId}` → byte offset */
  private readonly bgCursorMap = new Map<string, number>()

  constructor(
    sdkEnv: SdkEnvConfig,
    config: WorkerHandlerConfig,
    options?: WorkerHandlerOptions,
  ) {
    this.sdkEnv = sdkEnv
    this.mcpConfigFactory = options?.mcpConfigFactory
    this.deps = options?.deps
    this.systemPrompt = config.systemPrompt
    this.builtinToolConfig = options?.builtinToolConfig
    this.mcpConnector = options?.mcpConnector
    this.extra = config.extra ?? {}
    this.digestSdkEnv = options?.digestSdkEnv
    this.subAgentConfigs = options?.subAgentConfigs ?? []
    this.skills = options?.skills ?? []
    this.lspManager = options?.lspManager
    this.memoryWriter = options?.memoryWriter
    this.promptManager = options?.promptManager
    this.subAgentHints = options?.subAgentHints ?? []
    this.getTimezone = config.getTimezone ?? (() => resolveTimezone(undefined))

    // 确保 instance skills 目录存在；如果 ctor 已经注入了 skills，立刻 sync 到磁盘
    // 让目录反映当前内存状态（防止 worker 重启后磁盘是空的而内存是 stale 的）
    const skillsRoot = getInstanceSkillsDir()
    fs.mkdirSync(skillsRoot, { recursive: true })
    if (this.skills.length > 0) {
      void this.writeSkillsToInstancePath(this.skills).catch((err) => {
        console.error('[WorkerHandler] init skills disk write failed:', err)
      })
    }
  }

  async loadConfirmedSnapshot(): Promise<void> {
    if (!this.memoryWriter) return
    try {
      const snap = await this.memoryWriter.fetchConfirmedSnapshot()
      if (!snap) return
      const lines: string[] = [`## 你已知的长期事实 / 经验 / 概念（snapshot ${snap.snapshot_id}）`, '']
      for (const type of ['fact', 'lesson', 'concept'] as const) {
        const items = snap.by_type[type]
        if (items.length === 0) continue
        lines.push(`### ${type}`)
        for (const it of items) lines.push(`- (${it.id}) ${it.brief}`)
        lines.push('')
      }
      this.confirmedSnapshotBlock = lines.join('\n').trim()
    } catch (error) {
      console.error('[WorkerHandler] Failed to load confirmed snapshot:', error)
    }
  }

  /**
   * 热加载：更新 skills 列表 + atomic write 到 instance 级目录。
   * 改动后：进行中 task 调 Skill 工具会读到最新 SKILL.md（race window <1ms）。
   */
  updateSkills(newSkills: ReadonlyArray<SkillConfig>): void {
    this.skills = newSkills
    // Atomic write 到 instance-level 路径，确保 skill-tool 下次调用能读到最新内容
    void this.writeSkillsToInstancePath(newSkills).catch((err) => {
      console.error('[WorkerHandler] updateSkills disk write failed:', err)
    })
  }

  private async writeSkillsToInstancePath(skills: ReadonlyArray<SkillConfig>): Promise<void> {
    const skillsRoot = getInstanceSkillsDir()
    const tmpDir = `${skillsRoot}.tmp.${process.pid}.${Date.now()}`
    await fs.promises.mkdir(tmpDir, { recursive: true })
    for (const skill of skills) {
      const skillDir = path.join(tmpDir, skill.name)
      await fs.promises.mkdir(skillDir, { recursive: true })
      await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), skill.content, 'utf-8')
      if (skill.skill_dir) {
        await fs.promises.writeFile(path.join(skillDir, '.skill_dir'), skill.skill_dir, 'utf-8')
      }
    }
    // POSIX atomic swap：先删旧 + rename tmp → 目标。删除 + rename 之间有微小窗口
    // 但比 partial overwrite 安全
    await fs.promises.rm(skillsRoot, { recursive: true, force: true })
    // 确保父目录存在
    await fs.promises.mkdir(path.dirname(skillsRoot), { recursive: true })
    await fs.promises.rename(tmpDir, skillsRoot)
  }

  /**
   * 热加载：更新 base system prompt（admin personality）。下次 LLM 调用时生效。
   *
   * `undefined` 表示"不变"，保留当前值；caller 想清空 personality 应明确传 `''`。
   * 这与 handleUpdateConfig 的 `!== undefined` 守卫语义一致：
   * undefined 是 "字段未改动"，空字符串是 "明确设为空"。
   */
  updateSystemPrompt(newPrompt: string | undefined): void {
    if (newPrompt === undefined) return
    this.systemPrompt = newPrompt
  }

  /**
   * 热加载：更新 extra（progress_digest_interval_seconds 等）。
   * 下次 executeTask 构造 ProgressDigest 时会读到新值。
   */
  updateExtra(extra: Record<string, unknown>): void {
    this.extra = { ...this.extra, ...extra }
  }

  async executeTask(
    params: ExecuteTaskParams,
    traceCallback?: TraceCallback,
    traceContext?: WorkerTraceContext,
  ): Promise<ExecuteTaskResult> {
    const { task, context } = params
    const taskState: WorkerTaskState = {
      taskId: task.task_id,
      status: 'executing',
      startedAt: new Date().toISOString(),
      title: task.task_title,
      abortController: new AbortController(),
      pendingHumanMessages: [],
      taskOrigin: context.task_origin,
    }
    this.activeTasks.set(task.task_id, taskState)

    // Init live snapshot（query-loop 的 onLiveProgress 会逐步填充）
    this.liveSnapshots.set(task.task_id, {
      task_id: task.task_id,
      current_turn: 0,
      started_at: Date.now(),
      active_tools: [],
      recent_completed: [],
    })

    // Create human message queue for this task
    const humanQueue = new HumanMessageQueue()
    this.humanQueues.set(task.task_id, humanQueue)

    let digest: ProgressDigest | undefined
    try {
      // skillsDir 在 worker init / updateSkills 时已经写好（instance-level），这里不再 per-task 写盘

      // Build tools — adapter / sub-agent trace config 等无依赖项先行构造
      const adapter = adapterFromSdkEnv(this.sdkEnv)
      const subAgentTraceConfig = traceContext ? {
        traceStore: traceContext.traceStore,
        parentTraceId: traceContext.traceId,
        relatedTaskId: traceContext.relatedTaskId,
      } : undefined

      // Trace search tool (异步 import，提前加载，lambda 内只用同步引用)
      const traceSearchTool = traceContext
        ? (await import('./trace-search-tool.js')).createSearchTracesTool(traceContext.traceStore)
        : undefined

      // get_task_details 工具：让 worker 能查任意历史任务的完整执行复盘（用于"继续上次"场景）
      // digest LLM 用于超阈值时压缩；缺省则只截断
      const digestAdapterForTool = this.digestSdkEnv ? adapterFromSdkEnv(this.digestSdkEnv) : undefined
      const getTaskDetailsTool = (traceContext && this.deps?.getAdminPort)
        ? (await import('./get-task-details-tool.js')).createGetTaskDetailsTool({
            rpcClient: this.deps.rpcClient,
            moduleId: this.deps.moduleId,
            getAdminPort: this.deps.getAdminPort,
            traceStore: traceContext.traceStore,
            digestAdapter: digestAdapterForTool,
            digestModelId: this.digestSdkEnv?.modelId,
          })
        : undefined

      // 工具列表构造改为 callback 形式：每轮 LLM 调用前由 query-loop 重新 resolve，
      // 让 admin push config（updateSkills / updateSystemPrompt）能在同一 task 内热生效。
      // 注意：lambda 内捕获 taskState / context / humanQueue 等闭包变量，
      // 行为与原一次性构造等价。
      const buildToolsDynamic = (): ReadonlyArray<ToolDefinition> => {
        const tools: ToolDefinition[] = []

        // 3a. ask_human built-in tool
        tools.push(defineTool({
          name: 'mcp__crabot-worker__ask_human',
          description: '请求人类反馈或确认',
          inputSchema: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '向人类提出的问题' },
              options: {
                type: 'array',
                items: { type: 'string' },
                description: '可选的选项列表',
              },
            },
            required: ['question'],
          },
          isReadOnly: false,
          call: async (input) => {
            taskState.status = 'waiting_for_human'
            return {
              output: JSON.stringify({
                status: 'waiting',
                message: '已向人类发送问题，等待响应...',
                question: (input as { question: string }).question,
              }),
              isError: false,
            }
          },
        }))

        // 3b. crab-memory MCP server tools
        const memoryTaskCtx: MemoryTaskContext = {
          taskId: task.task_id,
          channelId: context.task_origin?.channel_id,
          sessionId: context.task_origin?.session_id,
          visibility: context.memory_permissions?.write_visibility ?? 'public',
          scopes: context.memory_permissions?.write_scopes ?? [],
          sourceType: context.task_origin ? 'conversation' : 'system',
          sessionType: context.task_origin?.session_type,
          senderFriendId: context.sender_friend?.id,
        }
        if (this.deps?.getMemoryPort) {
          const crabMemoryServer = createCrabMemoryServer({
            rpcClient: this.deps.rpcClient,
            moduleId: this.deps.moduleId,
            getMemoryPort: this.deps.getMemoryPort,
          }, memoryTaskCtx)
          tools.push(...mcpServerToToolDefinitions(crabMemoryServer, 'crab-memory'))
        }

        // 3c. External MCP server tools (crab-messaging, etc.)
        const externalMcpServers = this.mcpConfigFactory?.() ?? {}
        for (const [serverName, server] of Object.entries(externalMcpServers)) {
          tools.push(...mcpServerToToolDefinitions(server, serverName))
        }

        // 3d. External MCP tools (from Admin-managed servers via McpConnector)
        if (this.mcpConnector) {
          const externalTools = this.mcpConnector.getAllTools()
          tools.push(...externalTools)
        }

        // 3e. Built-in file/shell tools (filtered by Admin config)
        const skillsSnapshot = this.skills
        const bgOwner: BgEntityOwner = {
          friend_id: context.sender_friend?.id ?? `__system_${context.task_origin?.session_id ?? 'unknown'}`,
          session_id: context.task_origin?.session_id,
          channel_id: context.task_origin?.channel_id,
        }
        const bgEntityCtx: BashBgContext = {
          registry: this.bgRegistry,
          transient: this.transientShells,
          workerContext: context,
          owner: bgOwner,
          taskId: task.task_id,
        }
        const bgToolDeps: BgToolDeps = {
          registry: this.bgRegistry,
          transient: this.transientShells,
          cursorMap: this.bgCursorMap,
          taskId: task.task_id,
          ownerFriendId: bgOwner.friend_id,
        }
        tools.push(...getConfiguredBuiltinTools(
          os.homedir(),
          this.builtinToolConfig,
          {
            skillsDir: skillsSnapshot.length > 0 ? getInstanceSkillsDir() : undefined,
            bgEntityCtx,
            bgToolDeps,
          },
        ))

        // 3f. Sub-agent delegation tools
        // baseToolsPermissionConfig 仅基于 base 工具集，给 sub-agent 用：
        //   sub-agent 内部只能见 baseTools，所以它的 permissionConfig 也只需覆盖 base 工具命名。
        const baseToolsRaw = [...tools]
        const baseToolsPermissionConfig: ToolPermissionConfig =
          this.deps?.getPermissionConfig?.(baseToolsRaw, context.resolved_permissions) ?? { mode: 'bypass' }
        const baseTools = filterToolsByPermission(baseToolsRaw, baseToolsPermissionConfig)

        for (const { definition, sdkEnv: subSdkEnv } of this.subAgentConfigs) {
          const hookRegistry = definition.hooks === 'coding_expert'
            ? createCodingExpertHookRegistry()
            : undefined

          tools.push(createSubAgentTool({
            name: definition.toolName,
            description: definition.toolDescription,
            adapter: adapterFromSdkEnv(subSdkEnv),
            model: subSdkEnv.modelId,
            systemPrompt: definition.systemPrompt,
            subTools: baseTools,
            maxTurns: definition.maxTurns,
            supportsVision: subSdkEnv.supportsVision,
            parentHumanQueue: humanQueue,
            traceConfig: subAgentTraceConfig,
            hookRegistry,
            lspManager: hookRegistry ? this.lspManager : undefined,
            permissionConfig: baseToolsPermissionConfig,
          }))
        }

        // 3g. Generic delegate_task tool (uses Worker's own model)
        tools.push(createSubAgentTool({
          name: 'delegate_task',
          description: '将子任务委派给一个独立的执行者。执行者在独立上下文中运行，使用与你相同的模型和工具，只返回最终结果。适合：(1) 子任务的中间过程会污染你的上下文 (2) 子任务可以独立完成，不需要你的持续关注',
          adapter,
          model: this.sdkEnv.modelId,
          systemPrompt: DELEGATE_TASK_SYSTEM_PROMPT,
          subTools: baseTools,
          maxTurns: 30,
          supportsVision: this.sdkEnv.supportsVision,
          parentHumanQueue: humanQueue,
          traceConfig: subAgentTraceConfig,
          permissionConfig: baseToolsPermissionConfig,
        }))

        // 3h. Trace search tool
        if (traceSearchTool) {
          tools.push(traceSearchTool)
        }

        // 3i. get_task_details tool（人话化的任务复盘）
        if (getTaskDetailsTool) {
          tools.push(getTaskDetailsTool)
        }

        // 最终过滤：用「完整 tools 集合」重算 permissionConfig，
        // 否则 delegate_*/trace_search 等后注入的工具因不在 baseToolsPermissionConfig 的 denyList 里而漏过 filter，
        // 导致 LLM 看见但 runEngine 用 initialPermissionConfig 又拒绝（违反「无权限工具不注入 prompt」）。
        const fullPermissionConfig: ToolPermissionConfig =
          this.deps?.getPermissionConfig?.(tools, context.resolved_permissions) ?? { mode: 'bypass' }
        return filterToolsByPermission(tools, fullPermissionConfig)
      }

      // System prompt 也改为 callback：admin push config 触发 updateSystemPrompt 后下一轮生效。
      const buildSystemPromptDynamic = (): string => this.buildSystemPrompt(context)

      // 5. Build task message（一次性，task 启动后用户请求/记忆等不变）
      const taskMessage = await this.buildTaskMessage(task, context)

      // 6. Set up trace and progress tracking
      const isMasterPrivate =
        context.sender_friend?.permission === 'master'
        && context.task_origin?.session_type === 'private'

      let loopSpanId: string | undefined
      const taskOrigin = context.task_origin

      // 初始 snapshot：用于 trace 记录 + 给 runEngine 的 permissionConfig option（兜底）。
      // runEngine 内部会在每轮调用 buildToolsDynamic 重新拿最新工具列表。
      const initialTools = buildToolsDynamic()
      const initialPermissionConfig: ToolPermissionConfig =
        this.deps?.getPermissionConfig?.(initialTools, context.resolved_permissions) ?? { mode: 'bypass' }

      log(`Starting worker engine: model=${this.sdkEnv.modelId}, task=${task.task_title}, tools=${initialTools.length}`)

      // Start loop span
      loopSpanId = traceCallback?.onLoopStart('worker', {
        system_prompt: undefined,
        model: this.sdkEnv.modelId,
        tools: initialTools.map(t => t.name),
      })

      // 创建进度汇报（根据会话场景分支）
      let textForwardMode = false
      if (taskOrigin && this.deps) {
        const reportMode = getReportMode(
          taskOrigin.session_type,
          isMasterPrivate,
          this.extra,
        )

        if (reportMode === 'digest') {
          const ex = this.extra
          const intervalSec = typeof ex.progress_digest_interval_seconds === 'number'
            ? ex.progress_digest_interval_seconds
            : 120
          const digestMode: 'llm' | 'extract' = ex.progress_digest_mode === 'extract' ? 'extract' : 'llm'
          const digestAdapter = (digestMode !== 'extract' && this.digestSdkEnv)
            ? adapterFromSdkEnv(this.digestSdkEnv)
            : undefined

          const digestConfig: ProgressDigestConfig = {
            intervalMs: intervalSec * 1000,
            mode: digestMode,
            isMasterPrivate,
          }

          const deps = this.deps
          const digestDeps: ProgressDigestDeps = {
            sendToUser: (text: string) => this.sendToUser(taskOrigin, text),
            getChatHistory: async (limit: number) => {
              try {
                const channelPort = await deps.resolveChannelPort(taskOrigin.channel_id)
                const result = await deps.rpcClient.call<
                  { session_id: string; limit: number },
                  { items: Array<{ sender_name: string; content: string }> }
                >(channelPort, 'get_history', {
                  session_id: taskOrigin.session_id,
                  limit,
                }, deps.moduleId)
                return (result.items ?? []).map(m => `${m.sender_name}: ${m.content}`)
              } catch {
                return []
              }
            },
            digestAdapter,
            digestModelId: this.digestSdkEnv?.modelId,
          }

          digest = new ProgressDigest(digestConfig, digestDeps)
        } else if (reportMode === 'text_forward') {
          textForwardMode = true
        }
        // reportMode === 'silent' → no digest, no text forward
      }

      // 6b. CLI 权限控制：非 master 私聊注入 CLI 拦截 hook
      let workerHookRegistry: HookRegistry | undefined
      if (!isMasterPrivate) {
        workerHookRegistry = new HookRegistry()
        workerHookRegistry.register(createCliBlockHook())
      }

      // 6c. 注入 CLI 环境变量（CRABOT_TOKEN + CRABOT_ACTOR）
      // 总是注入（不论 isMasterPrivate）—— token 只是让子进程能调 CLI；
      // 真正的权限边界在 CLI 层 (block-cli-write hook 限制 write 命令到 master_private)。
      // 不注入会让群聊/非 master 任务的 read 类 CLI（如 'crabot mcp list'）也跑不起来。
      if (!process.env.CRABOT_TOKEN) {
        const dataDir = process.env.DATA_DIR ?? './data'
        const tokenPath = path.join(dataDir, 'admin', 'internal-token')
        try {
          const token = fs.readFileSync(tokenPath, 'utf-8').trim()
          process.env.CRABOT_TOKEN = token
        } catch {
          // internal-token 不存在时不注入，CLI 命令将报错
        }
      }
      // CRABOT_ACTOR 让 CLI undo log / audit log 把 worker 子进程的写操作正确记为 'agent'
      // 而不是默认的 'human'。
      process.env.CRABOT_ACTOR = 'agent'

      // CRABOT_TASK_FRIEND_ID：当前 task 关联的 friend（master 私聊 = master id；定时任务 = 空）。
      // CLI write 命令（如 `crabot schedule add`）从这里读取并填到请求体的 creator_friend_id，
      // **不通过 CLI flag 传**，避免 LLM 通过命令行参数伪造身份。block-cli-write hook 已经把
      // write 命令限制在 master_private，所以这里非空时一定是 master。
      const taskFriendId = context.task_origin?.friend_id
      if (taskFriendId) {
        process.env.CRABOT_TASK_FRIEND_ID = taskFriendId
      } else {
        delete process.env.CRABOT_TASK_FRIEND_ID
      }

      // 7. Run engine — systemPrompt 和 tools 传 lambda，每轮 LLM 调用前 query-loop 重新 resolve
      // maxTurns: 主任务允许长时间执行（探索类任务可能跑 1000+ turn）；context-manager 在
      // 80% 窗口时自动 compaction 兜底。真正死循环可通过 supplement_task 或 abort 中断。
      const engineResult = await runEngine({
        prompt: taskMessage,
        adapter,
        options: {
          systemPrompt: buildSystemPromptDynamic,
          tools: buildToolsDynamic,
          model: this.sdkEnv.modelId,
          maxTurns: 2000,
          supportsVision: this.sdkEnv.supportsVision,
          permissionConfig: initialPermissionConfig,
          timezone: this.getTimezone(),
          abortSignal: taskState.abortController.signal as AbortSignal,
          humanMessageQueue: humanQueue,
          hookRegistry: workerHookRegistry,
          onLiveProgress: (event: LiveProgressEvent) => {
            // Update in-memory snapshot so ContextAssembler can read it.
            // 容错：如果任务已被清理（极端情况下 abort 后还有 in-flight 回调），略过。
            if (!this.liveSnapshots.has(task.task_id)) return
            switch (event.type) {
              case 'turn_assistant':
                this.updateLiveSnapshot(task.task_id, prev => ({
                  ...prev,
                  current_turn: event.turn,
                  last_assistant_text: event.text.slice(0, 400),
                }))
                break
              case 'tools_start': {
                const now = Date.now()
                const active: LiveToolCall[] = event.tools.map(t => ({
                  name: t.name,
                  input_summary: t.input_summary,
                  started_at: now,
                }))
                this.updateLiveSnapshot(task.task_id, prev => ({ ...prev, active_tools: active }))
                break
              }
              case 'tools_end': {
                const now = Date.now()
                const completed: LiveCompletedTool[] = event.results.map(r => ({
                  name: r.name,
                  input_summary: r.input_summary,
                  is_error: r.is_error,
                  ended_at: now,
                }))
                this.updateLiveSnapshot(task.task_id, prev => {
                  const merged = [...prev.recent_completed, ...completed]
                  const trimmed = merged.length > WorkerHandler.RECENT_COMPLETED_LIMIT
                    ? merged.slice(merged.length - WorkerHandler.RECENT_COMPLETED_LIMIT)
                    : merged
                  return { ...prev, active_tools: [], recent_completed: trimmed }
                })
                break
              }
            }
          },
          onTurn: (event: EngineTurnEvent) => {
            // onTurn fires after LLM + tools complete; back-date spans with engine timings.
            const inputSummary = event.turnNumber === 1
              ? task.task_title.slice(0, 150)
              : `(turn ${event.turnNumber})`
            const llmEndedAtMs = event.llmStartedAtMs !== undefined && event.llmCallMs !== undefined
              ? event.llmStartedAtMs + event.llmCallMs
              : undefined
            const llmSpanId = traceCallback?.onLlmCallStart(event.turnNumber, inputSummary, undefined, event.llmStartedAtMs)

            for (const tc of event.toolCalls) {
              const toolEndedAtMs = tc.startedAtMs !== undefined && tc.durationMs !== undefined
                ? tc.startedAtMs + tc.durationMs
                : undefined
              const toolSpanId = traceCallback?.onToolCallStart(
                tc.name,
                JSON.stringify(tc.input ?? {}).slice(0, 200),
                tc.startedAtMs,
              )
              if (toolSpanId) {
                traceCallback?.onToolCallEnd(
                  toolSpanId,
                  tc.output?.slice(0, 500) || '(no output)',
                  tc.isError ? tc.output : undefined,
                  toolEndedAtMs,
                )
              }
            }

            if (llmSpanId) {
              traceCallback?.onLlmCallEnd(
                llmSpanId,
                {
                  stopReason: event.stopReason ?? undefined,
                  outputSummary: event.assistantText.slice(0, 200) || undefined,
                  toolCallsCount: event.toolCalls.length > 0 ? event.toolCalls.length : undefined,
                },
                llmEndedAtMs,
              )
            }

            // Progress: delegate based on report mode
            if (!humanQueue.hasPending) {
              if (digest) {
                digest.ingest(event)
              } else if (textForwardMode && taskOrigin) {
                const text = event.assistantText.trim()
                if (text.length > 0) {
                  this.sendToUser(taskOrigin, text).catch(() => {})
                }
              }
            }
          },
        },
      })

      // Dispose ProgressDigest (also in finally block as safety net)
      digest?.dispose()

      // End loop span
      const isError = engineResult.outcome === 'failed'
      if (loopSpanId) {
        traceCallback?.onLoopEnd(loopSpanId, isError ? 'failed' : 'completed', engineResult.totalTurns)
      }
      if (engineResult.error) {
        log(`Engine error (outcome=${engineResult.outcome}, turns=${engineResult.totalTurns}): ${engineResult.error}`)
      }

      // 8. Summarize if finalText is empty or the default placeholder
      // For failed outcomes, use the engine error as the summary instead of generating an optimistic one
      let finalEngineResult = engineResult
      if (isError && engineResult.error) {
        finalEngineResult = { ...engineResult, finalText: `执行失败 (${engineResult.totalTurns}轮后): ${engineResult.error}` }
      } else if (!engineResult.finalText || engineResult.finalText === '任务已完成，但模型未生成输出') {
        const summary = await this.summarizeTaskOutcome(
          task.task_title,
          engineResult.totalTurns,
          engineResult.outcome,
          engineResult.finalText,
        )
        finalEngineResult = { ...engineResult, finalText: summary }
      }

      // 9. Map EngineResult → ExecuteTaskResult
      return this.mapEngineResult(task.task_id, finalEngineResult)

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log(`Worker error: ${errorMessage}`)
      if (taskState.abortController.signal.aborted) {
        return { task_id: task.task_id, outcome: 'failed', summary: '任务被取消' }
      }
      return {
        task_id: task.task_id,
        outcome: 'failed',
        summary: `执行失败: ${errorMessage}`,
        final_reply: { type: 'text', text: `抱歉，执行任务时出现错误: ${errorMessage}` },
      }
    } finally {
      digest?.dispose()
      this.humanQueues.get(task.task_id)?.clearBarrier()
      this.humanQueues.delete(task.task_id)
      this.activeTasks.delete(task.task_id)
      this.liveSnapshots.delete(task.task_id)
      // Kill all transient shells owned by this task (persistent shells survive)
      this.transientShells.killAllOwnedBy(task.task_id)
      // Clean up cursor map entries for this task to avoid memory leak
      for (const key of this.bgCursorMap.keys()) {
        if (key.startsWith(`${task.task_id}:`)) {
          this.bgCursorMap.delete(key)
        }
      }
    }
  }

  /**
   * Call LLM to generate a human-readable summary when the engine finishes
   * without producing a clear final text.
   */
  private async summarizeTaskOutcome(
    taskTitle: string,
    turnCount: number,
    outcome: string,
    lastText: string,
  ): Promise<string> {
    try {
      const adapter = adapterFromSdkEnv(this.sdkEnv)
      const { callNonStreaming } = await import('../engine/llm-adapter.js')
      const { createUserMessage } = await import('../engine/types.js')
      const response = await callNonStreaming(adapter, {
        messages: [createUserMessage(
          `任务"${taskTitle}"已${outcome === 'completed' ? '完成' : '结束'}，共执行了${turnCount}轮操作。` +
          (lastText ? `\n最后的输出是：${lastText.slice(0, 500)}` : '') +
          `\n请用1-2句话向用户简要报告任务执行情况和结果。不要提及内部实现细节。`
        )],
        systemPrompt: '你是一个任务执行助手，需要向用户简要报告任务结果。语言简洁自然。',
        tools: [],
        model: this.sdkEnv.modelId,
      })
      const text = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('')
      return text || lastText || '任务已完成'
    } catch {
      return lastText || '任务已完成'
    }
  }

  /**
   * Map EngineResult to ExecuteTaskResult
   */
  private mapEngineResult(
    taskId: TaskId,
    result: EngineResult,
  ): ExecuteTaskResult {
    const isError = result.outcome === 'failed' || result.outcome === 'aborted'
    const finalText = result.finalText || '任务已完成，但模型未生成输出'

    if (result.outcome === 'aborted') {
      return { task_id: taskId, outcome: 'failed', summary: '任务被取消' }
    }

    return {
      task_id: taskId,
      outcome: isError ? 'failed' : 'completed',
      summary: finalText,
      final_reply: { type: 'text', text: finalText },
    }
  }

  deliverHumanResponse(taskId: TaskId, messages: ChannelMessage[]): void {
    const taskState = this.activeTasks.get(taskId)
    if (!taskState) {
      log(`[supplement] deliverHumanResponse: task ${taskId} NOT FOUND. activeTasks keys: [${Array.from(this.activeTasks.keys()).join(', ')}]`)
      throw new Error(`Task not found: ${taskId}`)
    }

    log(`[supplement] deliverHumanResponse: queued ${messages.length} messages for task ${taskId} (status: ${taskState.status})`)

    // Build supplement text from messages
    const supplement = messages
      .map(m => m.content.text ?? '')
      .filter(t => t.length > 0)
      .join('\n')

    if (supplement) {
      const humanQueue = this.humanQueues.get(taskId)
      if (humanQueue) {
        humanQueue.push(
          `[实时纠偏 - 来自用户]\n` +
          `用户在任务执行期间发来了补充指示：\n\n` +
          `"${supplement}"\n\n` +
          `请结合当前任务进展，调整你的执行方向。`,
        )
        log(`[supplement] pushed to humanMessageQueue for task ${taskId}`)
      }
    }

    // Also store in pendingHumanMessages for backward compat with task state
    taskState.pendingHumanMessages.push(...messages)
    taskState.status = 'executing'
  }

  cancelTask(taskId: TaskId, _reason: string): void {
    const taskState = this.activeTasks.get(taskId)
    if (taskState) {
      taskState.abortController.abort()
      taskState.status = 'cancelled'
    }
  }

  getActiveTaskCount(): number { return this.activeTasks.size }

  hasActiveTask(taskId: TaskId): boolean {
    return this.activeTasks.has(taskId)
  }

  setBarrierForTask(taskId: TaskId, timeoutMs: number): boolean {
    const queue = this.humanQueues.get(taskId)
    if (!queue) return false
    queue.setBarrier(timeoutMs)
    return true
  }

  clearBarrierForTask(taskId: TaskId): void {
    const queue = this.humanQueues.get(taskId)
    queue?.clearBarrier()
  }

  /**
   * 同进程同步读取某个任务的实时执行快照。
   * 仅当任务正在 worker engine 内执行时才有值；任务结束（成功/失败/中止）后即被清理。
   */
  getLiveSnapshot(taskId: TaskId): LiveTaskSnapshot | undefined {
    return this.liveSnapshots.get(taskId)
  }

  private updateLiveSnapshot(taskId: TaskId, mutate: (prev: LiveTaskSnapshot) => LiveTaskSnapshot): void {
    const prev = this.liveSnapshots.get(taskId)
    if (!prev) return
    this.liveSnapshots.set(taskId, mutate(prev))
  }

  getActiveTasksByOrigin(channelId: string, sessionId: string): TaskId[] {
    const result: TaskId[] = []
    for (const [taskId, state] of this.activeTasks) {
      if (
        state.taskOrigin?.channel_id === channelId &&
        state.taskOrigin?.session_id === sessionId
      ) {
        result.push(taskId)
      }
    }
    return result
  }

  getActiveTasksForQuery(): Array<{ task_id: string; status: string; started_at: string; title?: string }> {
    return Array.from(this.activeTasks.values()).map(t => ({
      task_id: t.taskId,
      status: t.status,
      started_at: t.startedAt,
      title: t.title,
    }))
  }

  /**
   * 从 this.skills 实时拼装 worker skill listing 段落。
   * updateSkills 改 this.skills 后，下一轮 buildSystemPrompt 自动反映新列表。
   */
  private buildSkillListingSnapshot(): string | undefined {
    if (!this.skills || this.skills.length === 0) return undefined
    const intro =
      '\n\n以下技能为特定任务提供专业指引。当任务匹配某个技能的描述时，' +
      '必须先调用 Skill 工具（输入技能名称）加载完整指引，然后按指引操作。' +
      '这是强制要求——先加载技能，再执行任务。'
    const body = this.skills.map((s) => {
      const desc = s.description || s.name
      return `<skill>\n<name>${s.name}</name>\n<description>${desc}</description>\n</skill>`
    }).join('\n')
    return `${intro}\n\n<available_skills>\n${body}\n</available_skills>`
  }

  private buildSystemPrompt(context: WorkerAgentContext): string {
    const baseAssembled = this.promptManager
      ? this.promptManager.assembleWorkerPrompt({
        adminPersonality: this.systemPrompt || undefined,
        skillListing: this.buildSkillListingSnapshot(),
        availableSubAgents: this.subAgentHints,
      })
      : this.systemPrompt
    const parts: string[] = [baseAssembled]
    if (context.available_tools.length > 0) {
      parts.push('\n## 可用工具')
      for (const t of context.available_tools) { parts.push(`- ${t.name}: ${t.description}`) }
    }
    if (context.sandbox_path_mappings && context.sandbox_path_mappings.length > 0) {
      parts.push('\n## 文件访问路径')
      for (const m of context.sandbox_path_mappings) {
        parts.push(`- ${m.sandbox_path} -> ${m.host_path} (${m.read_only ? '只读' : '读写'})`)
      }
    }
    if (this.confirmedSnapshotBlock) {
      parts.push('\n' + this.confirmedSnapshotBlock)
    }
    return parts.join('\n')
  }

  private async buildTaskMessage(task: ExecuteTaskParams['task'], context: WorkerAgentContext): Promise<string | ContentBlock[]> {
    const parts: string[] = []
    const now = new Date()
    const timezone = this.getTimezone()

    parts.push(`当前时间: ${formatNow(timezone, now)}`)
    parts.push('')

    if (context.scene_profile) {
      parts.push(`## 场景画像（${context.scene_profile.label}）`)
      parts.push('以下内容是当前场景必须加载并遵守的上下文：')
      parts.push('')
      parts.push(context.scene_profile.content)
      parts.push('')
    }
    parts.push('## 任务信息')
    parts.push(`- 标题: ${task.task_title}`)
    parts.push(`- 优先级: ${task.priority}`)
    if (task.plan) { parts.push(`- 计划: ${task.plan}`) }

    // trigger_messages: 用户的原始请求（核心内容）
    // 多行格式保留：trigger 可能含完整的用户原文，单行渲染会强制截断
    if (context.trigger_messages && context.trigger_messages.length > 0) {
      parts.push(`\n## 用户请求（共 ${context.trigger_messages.length} 条消息）`)
      for (const msg of context.trigger_messages) {
        const time = msg.platform_timestamp ? formatChannelMessageTime(msg.platform_timestamp, timezone, now) : ''
        const stamp = time ? ` [${time}]` : ''
        parts.push(`\n### ${msg.sender.platform_display_name}${stamp}`)
        parts.push(formatMessageContent(msg))
      }
      if (task.task_description) {
        parts.push(`\n## 任务分类\n${task.task_description}`)
      }
    } else {
      // 无 trigger_messages（如定时任务），回退到 task_description
      parts.push(`\n## 任务描述\n${task.task_description}`)
    }

    if (context.sender_friend) {
      parts.push(`\n## 发送者信息`)
      parts.push(`- 名称: ${context.sender_friend.display_name}`)
      parts.push(`- 权限: ${context.sender_friend.permission}`)
    }

    if (context.task_origin) {
      parts.push('\n## 任务来源（crab-messaging 工具请使用这些 ID）')
      parts.push(`- Channel ID: ${context.task_origin.channel_id}`)
      parts.push(`- Session ID: ${context.task_origin.session_id}`)
    }
    const hasShortTerm = context.short_term_memories.length > 0
    parts.push('\n## 记忆系统')
    if (hasShortTerm) {
      parts.push(`\n### 短期记忆（${context.short_term_memories.length} 条）`)
      parts.push('近期事件流水账，记录跨所有 channel/session 的事件摘要。不是聊天记录。')
    }
    parts.push('\n### 长期记忆')
    parts.push('长期记忆**不预填**到上下文。当任务需要历史经验、过去做过的类似事、相关事实背景时，')
    parts.push('主动调用 `crab-memory.search_long_term` 工具按主题精准查询，必要时再用 `crab-memory.get_memory` 取详情。')
    if (context.recent_messages && context.recent_messages.length > 0) {
      parts.push(`\n## 最近相关消息（共 ${context.recent_messages.length} 条）`)
      for (const m of context.recent_messages) {
        parts.push(formatChannelMessageLine(m, { timezone, now, maxLen: 500 }))
      }
    }

    // Front immediate reply — tell Worker what was already said to avoid repetition
    if (context.front_immediate_reply) {
      parts.push('\n## 已发送的即时回复')
      parts.push(`你已经向用户发送了："${context.front_immediate_reply}"`)
      parts.push('不要重复类似的确认或复述，直接开始执行任务。')
    }

    // front_context from forced Front termination
    const taskWithContext = task as { front_context?: Array<{ tool_name: string; output_summary: string }> }
    if (taskWithContext.front_context && Array.isArray(taskWithContext.front_context)) {
      parts.push('\n## Front Agent 已完成的工作')
      parts.push('（以下信息已获取，请直接使用，不要重复查询）')
      for (const entry of taskWithContext.front_context) {
        parts.push(`- ${entry.tool_name}: ${entry.output_summary}`)
      }
    }

    const textContent = parts.join('\n')

    // VLM Worker: resolve images from trigger messages into ContentBlock[]
    if (this.sdkEnv.supportsVision && context.trigger_messages?.length) {
      const imageBlocks = await resolveImageBlocks(context.trigger_messages)
      if (imageBlocks.length > 0) {
        return [
          { type: 'text' as const, text: textContent },
          ...imageBlocks,
        ]
      }
    }

    return textContent
  }

  /**
   * Send a message to the user during task execution.
   */
  private async sendToUser(
    taskOrigin: TaskOrigin,
    text: string,
  ): Promise<void> {
    if (!this.deps) return
    try {
      const channelPort = await this.deps.resolveChannelPort(taskOrigin.channel_id)
      await this.deps.rpcClient.call(channelPort, 'send_message', {
        session_id: taskOrigin.session_id,
        content: { type: 'text', text },
      }, this.deps.moduleId)
    } catch { /* ignore send failures */ }
  }

}
