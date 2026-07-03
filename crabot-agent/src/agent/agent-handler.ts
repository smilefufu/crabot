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
  createUserMessage,
  getConfiguredBuiltinTools,
  ProgressDigest,
  filterToolsByPermission,
} from '../engine/index.js'
import { createSetCwdTool, createReadTool } from '../engine/tools/index.js'
import { BgEntityRegistry } from '../engine/bg-entities/registry.js'
import { killShellTree } from '../engine/bg-entities/bg-shell.js'
import { ReadoptReaper } from '../engine/bg-entities/reaper.js'
import type { BgEntityOwner, BgEntityRecord, BgEntityStatus, BgEntityType, BgShellRegistryRecord } from '../engine/bg-entities/types.js'
import type { BashBgContext } from '../engine/tools/index.js'
import type { BgToolDeps } from '../engine/tools/index.js'
import type { TaskContext } from '../mcp/crab-messaging.js'
import { createOutboundFlush, type PathMapping, type OutboundDispatchDeps, type OutboundBufferEntry, type OutboundSendResult } from './outbound-flush.js'
import type { BgEntityTraceContext } from '../engine/bg-entities/trace.js'
import type {
  ToolDefinition,
  EngineTurnEvent,
  EngineResult,
  ContentBlock,
  EngineMessage,
  EngineMessagesRef,
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
  FrontAgentContext,
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
  Friend,
  TaskSummary,
  MemoryPermissions,
  RuntimeSceneProfile,
  AgentTrace,
} from '../types.js'
import type { RpcClient } from 'crabot-shared'
import { SYSTEM_CHANNEL_ID } from 'crabot-shared'
import { createCrabMemoryServer } from '../mcp/crab-memory.js'
import type { MemoryTaskContext } from '../mcp/crab-memory.js'
import { mcpServerToToolDefinitions } from './mcp-tool-bridge.js'
import { formatMessageContent, resolveImageBlocks, EMPTY_MESSAGE_PLACEHOLDER } from './media-resolver.js'
import type { McpConnector } from './mcp-connector.js'
import { forkEngine } from '../engine/sub-agent.js'
import type { SubAgentTraceConfig } from '../engine/sub-agent.js'
import { createDelegateTaskTool } from './delegate-task-tool.js'
import type { RunSubAgentFn, RunSubAgentInput } from './delegate-task-tool.js'
import { createSubagentCoordinatorTools } from './subagent-coordinator-tools.js'
import { createRequestRestartTool } from './restart-instance-tool.js'
import { buildSubAgentFailureOutput } from './subagent-error-classifier.js'
import { filterToolsForSubAgent } from './subagent-tool-filter.js'
import { assembleSubAgentPrompt } from './subagent-prompt-assembler.js'
import {
  SYSTEM_TRIGGER_NO_TARGET_GUIDANCE,
  SUPPLEMENT_INJECTION_TEMPLATE_GOAL,
  SUPPLEMENT_INJECTION_TEMPLATE_BASIC,
} from '../prompts/agent-sections.js'
import type { SubAgentConfig } from '../types.js'
import { HumanMessageQueue } from '../engine/human-message-queue.js'
import { createSubAgentHookRegistry, createCliPermissionHook, createSkillDirFenceHook } from '../hooks/defaults.js'
import { HookRegistry } from '../hooks/hook-registry.js'
import type { ContentReviewer } from '../hooks/types.js'
import { reviewCliContent } from './cli-content-reviewer.js'
import { PromptManager, formatChannelMessageLine, formatShortTermMemoryLine, type QuotedMessageEntry } from '../prompt-manager.js'
import { resolveSenderIdentity } from '../utils/sender-identity.js'
import { prefetchQuotedMessages } from './quoted-message-prefetcher.js'
import { formatNow, formatChannelMessageTime, resolveTimezone, formatRuntimeMs } from '../utils/time.js'
import { renderActiveTasksSection } from './active-tasks-section.js'
import { getAgentDataDir, getAdminDataDir, getAdminInternalTokenPath, getWorkspaceDir, getBgEntitiesLogsDir } from '../core/data-paths.js'
import { llmUsageToTrace } from '../core/trace-usage.js'
import { TodoStore } from './worker-todo-store.js'
import { createTodoTool } from './worker-todo-tool.js'
import { createSetTaskGoalTool } from './goal-tools.js'
import {
  buildAuditPrompt,
  buildAuditVerdictSummary,
  buildHumanQueueReport,
  buildBlockedGuidance,
  resolveAuditJudgment,
  type AuditResult,
  type ConversationEntry,
  type GoalAuditTaskGoal,
  type GoalStatus,
} from './goal-audit.js'
import { createSubmitAuditResultTool } from './goal-auditor-tools.js'
import { createWaitForSignalTool, type WaitForSignalDeps } from '../mcp/wait-for-signal.js'
import { createAsyncAuditEndTurnGate } from './end-turn-gate.js'
import { buildAuditAbortedMarker } from './audit-result-marker.js'
import {
  buildResumeWakeupMessage,
  buildRestartCompletedWakeupMessage,
  buildTerminalSupplementWakeupMessage,
} from '../core/resume-checkpoint.js'

import { reflectStructuredOutcome } from '../orchestration/structured-outcome-reflector.js'
import { AGENT_VERSION } from '../constants.js'

import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'crypto'

/**
 * 从 tool 输出 JSON 中提取 `child_trace_id`。
 * delegate_task 等派生子 trace 的工具会在返回 JSON 里带 `child_trace_id`，
 * 抓出来挂在 tool_call span.details 上，让 Admin UI 能内联展开子 trace。
 * 非 JSON / 无该字段 → 返回 undefined。
 * @internal exported for testing
 */
export function extractChildTraceIdFromOutput(output: string | undefined): string | undefined {
  if (!output) return undefined
  try {
    const parsed = JSON.parse(output) as { child_trace_id?: unknown }
    if (typeof parsed.child_trace_id === 'string' && parsed.child_trace_id.length > 0) {
      return parsed.child_trace_id
    }
  } catch {
    // 非 JSON output（如普通文本工具返回），忽略
  }
  return undefined
}

/**
 * 从 delegate_task 异步路径的 JSON output 提取 `agent_id`。
 * 异步派出的 subagent 工具立即返回 `{agent_id, status:'launched', output_file: null}`，
 * caller 用 agent_id 追踪在跑的 async subagent（喂给 wait_for_signal 的 hasActiveAsyncSubagent 判断）。
 * 非 JSON / 非 launched 状态 / 无字段 → 返回 undefined。
 * @internal exported for testing
 */
export function extractLaunchedSubagentId(output: string | undefined): string | undefined {
  if (!output) return undefined
  try {
    const parsed = JSON.parse(output) as { agent_id?: unknown; status?: unknown }
    if (
      parsed.status === 'launched'
      && typeof parsed.agent_id === 'string'
      && parsed.agent_id.length > 0
    ) {
      return parsed.agent_id
    }
  } catch {
    // 非 JSON / 非 async-launched 结果（sync 路径直接返回文字），忽略
  }
  return undefined
}

/**
 * 构造 wait_for_signal 工具（通用挂起原语，总是注入）。
 *
 * 旧版本仅在 `goalModeEnabled || asyncEnabled` 时注入，目的是"缩小工具可见面"。
 * 但 wait_for_signal 是通用挂起原语——"等媒体下载"等新场景也需要它，与 goal/async flag 无关。
 * 因此改为总是注入；滥用（无 pending 事件且无 timeout_ms 的空挂起）由工具内部预检兜底。
 *
 * `_opts` 保留以维持调用方签名稳定，不需要改注入点。
 *
 * @internal exported for testing
 */
export function maybeCreateWaitForSignalTool(
  _opts: { readonly goalModeEnabled: boolean; readonly asyncEnabled: boolean },
  deps: WaitForSignalDeps,
): ReturnType<typeof createWaitForSignalTool> | undefined {
  // 总是注入：wait_for_signal 是通用挂起原语，合法性由内部预检判定。
  return createWaitForSignalTool(deps)
}

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
  // 未配置时的默认行为需与 admin extra_schema 默认值保持一致：
  // master 私聊 digest，群聊 / 其他私聊 silent。
  return isMasterPrivate ? 'digest' : 'silent'
}

const LOG_FILE = path.join(getAgentDataDir(), 'agent-handler-debug.log')

/** subagent 完成通知里内联结果预览的字符上限；超过则截断并提示用 get_subagent_output 读全文。 */
const SUBAGENT_RESULT_PREVIEW_MAX = 2000

export interface SubAgentExitInfo {
  readonly entity_id: string
  readonly task_description: string
  readonly status: 'completed' | 'failed'
  readonly runtime_ms: number
  readonly error?: string
  readonly result_file: string | null
  readonly finalText?: string
}

/**
 * 构造 \`<sub_agent_notification>\`：成功时内联**有界结果预览**——小结果（预览即全文）让 main
 * 直接用、省掉一次 get_subagent_output；大结果截断到 SUBAGENT_RESULT_PREVIEW_MAX 并提示读全文。
 * 失败时给 error + guidance。output_file 始终附上作为全文/审计指针。
 */
export function formatSubAgentNotification(info: SubAgentExitInfo): string {
  const failed = info.status === 'failed'
  const result = info.finalText ?? ''
  const truncated = result.length > SUBAGENT_RESULT_PREVIEW_MAX
  const preview = truncated ? result.slice(0, SUBAGENT_RESULT_PREVIEW_MAX) : result
  return [
    '<sub_agent_notification>',
    `<agent_id>${info.entity_id}</agent_id>`,
    `<description>${info.task_description.slice(0, 200)}</description>`,
    `<status>${info.status}</status>`,
    `<runtime_ms>${info.runtime_ms}</runtime_ms>`,
    failed && info.error ? `<error>${info.error.slice(0, 500)}</error>` : '',
    !failed && preview
      ? `<result_preview${truncated ? ' truncated="true"' : ''}>\n${preview}\n</result_preview>`
      : '',
    info.result_file ? `<output_file>${info.result_file}</output_file>` : '',
    !failed && truncated
      ? `<guidance>结果已截断；完整内容用 get_subagent_output("${info.entity_id}") 读。</guidance>`
      : '',
    // 失败时由 main 决定如何处理：接口/网络/额度类失败（HTTP 4xx/5xx、超时等）通常应通知人类；
    // 任务逻辑问题可自行续办或调整方案。
    failed ? '<guidance>子任务失败，请判断失败性质并决定是否通知人类（接口类失败通常应通知）。</guidance>' : '',
    '</sub_agent_notification>',
  ].filter(Boolean).join('\n')
}

function log(msg: string) {
  const ts = new Date().toISOString()
  try { fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`) } catch { /* ignore */ }
}

/**
 * skipReflection 判定阈值（spec 2026-06-03 §7.2.1）。
 * worker 跑得不够这个步数就不反思（"没什么值得反思的"）。
 * 实测后觉得偏严/宽改这一处常量即可，不暴露 admin 配置。
 */
export const TOOL_CALL_REFLECTION_THRESHOLD = 10

/**
 * task 结束时是否跳过反思 LLM 调用（spec 2026-06-03 §7.2.1）。
 * 反思只在 worker 长跑（≥阈值）+ 没主动 store_memory/set_scene_profile 时跑，
 * 兜的是"worker 该记没记"的漏记 case。
 *
 * - 早退（supplement/silent）→ skip
 * - 失败 → skip（finalizeTask 内 line 1947 也独立 skip，这里 explicit）
 * - 步数 < 阈值 → skip
 * - worker 已主动写过记忆 / 场景画像 → skip
 */
export function shouldSkipTaskReflection(engineResult: {
  exitToolCall?: unknown
  outcome: string
  tool_call_count: number
  wrote_memory_or_scene: boolean
}): boolean {
  if (engineResult.exitToolCall !== undefined) return true
  if (engineResult.outcome !== 'completed') return true
  if (engineResult.tool_call_count < TOOL_CALL_REFLECTION_THRESHOLD) return true
  if (engineResult.wrote_memory_or_scene) return true
  return false
}

export interface AgentHandlerConfig {
  /**
   * Admin personality（system_prompt）。仅承载 personality，不再包含 skill listing。
   * skillListing 通过 `updateSkills` 维护，由 agent-handler 内 buildSkillListingSnapshot 即时拼装。
   */
  systemPrompt: string
  extra?: Record<string, unknown>
  /** 解析已校验的 IANA 时区，用于 prompt 时间感知。每次 LLM 调用 / 工具执行前重新读取，反映 admin 配置热更新 */
  getTimezone?: () => string
  /** 对外可达 base URL，注入 worker system prompt 供拼临时页面链接（<base>/tmp-pages/<id>）。未配置时不注入。 */
  tmpPageBaseUrl?: string
}

export interface AgentHandlerDeps {
  rpcClient: RpcClient
  moduleId: string
  resolveChannelPort: (channelId: string) => Promise<number>
  getMemoryPort: () => Promise<number>
  /** Admin RPC 端口解析（get_task_progress 工具用） */
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
  /** 反思补轮注入接口（测试用）。生产路径走默认 reflectStructuredOutcome。 */
  reflectFn?: typeof reflectStructuredOutcome
  /**
   * 沙盒路径 ↔ 主机路径映射引用。由 unified-agent 在 executeTask 时设置 current，
   * 让 outbound flush 路径能跟 send_message handler 一样把 file_path 转主机路径再发。
   * 不传时 flush 路径假设运行在本地 unified agent，按 file_path 是否绝对路径降级处理。
   * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.5
   */
  sandboxPathMappingsRef?: { current: PathMapping[] }
}

import type { LLMFormat } from '../engine/llm-adapter'

export interface WorkerTraceContext {
  traceStore: import('../core/trace-store').TraceStore
  traceId: string
  relatedTaskId?: string
}

// ============================================================================
// runWorkerLoop shared types
// ============================================================================

export interface RunWorkerLoopOptions {
  /** Override the initial user prompt sent to LLM. Default: taskMessage built from task. */
  readonly initialPrompt?: string | ContentBlock[]
  /**
   * 从已有消息历史恢复，跳过 buildTaskMessage + 初始 createUserMessage。
   * waiting → executing 续跑路径使用：传入上一轮 finalMessages + 通知消息。
   */
  readonly initialMessages?: ReadonlyArray<EngineMessage>
  /**
   * 跳过 finally 中的 humanQueues / activeTasks / liveSnapshots 清理。
   * waiting 循环续跑时由 executeTask 统一负责清理。
   */
  readonly skipCleanup?: boolean
  /**
   * 复用已有的 HumanMessageQueue（waiting → executing 续跑时传入）。
   * 若未提供，runWorkerLoop 会新建一个。
   */
  readonly providedHumanQueue?: HumanMessageQueue
  /** Extra tools appended to the dynamic tool list (e.g., exit tools for trigger flow). */
  readonly extraTools?: ReadonlyArray<ToolDefinition>
  /** Called once per turn AFTER traceCallback wiring, with the toolCalls of that turn.
   *  Used by trigger flow to detect send_message. */
  readonly onAfterTurn?: (event: EngineTurnEvent) => void
}

export interface RunWorkerLoopResult {
  readonly engineResult: EngineResult
  readonly taskState: WorkerTaskState
  readonly humanQueue: HumanMessageQueue
  readonly digest: ProgressDigest | undefined
  readonly loopSpanId: string | undefined
}

export interface SdkEnvConfig {
  modelId: string
  format: LLMFormat
  supportsVision?: boolean
  /** Provider 配置的 max_output_tokens；未配置时 adapter 走各自的处理策略 */
  maxTokens?: number
  env: Record<string, string>
}

export function adapterFromSdkEnv(sdkEnv: SdkEnvConfig) {
  return createAdapter({
    endpoint: sdkEnv.env.LLM_BASE_URL ?? '',
    apikey: sdkEnv.env.LLM_API_KEY ?? '',
    format: sdkEnv.format,
    ...(sdkEnv.env.LLM_ACCOUNT_ID ? { accountId: sdkEnv.env.LLM_ACCOUNT_ID } : {}),
  })
}

/**
 * 按 subagent / auditor 解析出的 model（LLMConnectionInfo）自建 adapter。
 * 同步(runSubAgentDirect)、异步(runSubAgentAsync)、goal_audit 三条派发路径共用，
 * 确保子 agent 始终用自己 provider 的 endpoint/apikey，绝不复用父 agent 的 adapter
 * （否则会把子模型名发到父端点，如 deepseek 模型打到 Codex 镜像 → HTTP 400）。
 */
function adapterFromModel(model: SubAgentConfig['model']) {
  return createAdapter({
    endpoint: model.endpoint,
    apikey: model.apikey,
    format: model.format,
    ...(model.account_id ? { accountId: model.account_id } : {}),
  })
}

/**
 * 给 skills 列表算一个身份 hash 用于热加载防抖去重。
 *
 * 新协议下 admin 传 `{name, skill_dir}` 引用、不传 content；agent 直接 fs.read skill_dir，
 * 所以身份就是 (name, skill_dir) 对的集合。同 admin push 同样的列表 → 同 hash → updateSkills
 * 早退；避免启动期 admin 多次 trigger 推同样配置时反复重建 tool。
 */
function computeSkillsHash(skills: ReadonlyArray<SkillConfig>): string {
  const h = createHash('sha256')
  for (const s of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    // 防御：历史脏数据可能缺 name / skill_dir 字段（admin 已在 push 侧过滤，这里防御纵深）。
    // h.update(undefined) 抛 TypeError，会让整个 update_config 推送失败（连带 subagents 不更新）。
    h.update(s.name ?? '')
    h.update('\0')
    h.update(s.skill_dir ?? '')
    h.update('\0')
  }
  return h.digest('hex')
}


// ============================================================================
// AgentHandler
// ============================================================================

export interface AgentHandlerOptions {
  mcpConfigFactory?: (taskCtx: TaskContext) => Record<string, McpServer>
  deps?: AgentHandlerDeps
  builtinToolConfig?: BuiltinToolConfig
  mcpConnector?: McpConnector
  digestSdkEnv?: SdkEnvConfig
  subAgents?: ReadonlyArray<SubAgentConfig>
  skills?: ReadonlyArray<SkillConfig>
  lspManager?: import('../lsp/lsp-manager').LSPManager
  memoryWriter?: MemoryWriter
  /**
   * Prompt 装配器。Worker 在每轮 LLM 调用前用它把 personality + skill listing + sub-agent
   * 重新拼成 system prompt，以便 updateSkills / updateSystemPrompt 即时生效。
   */
  promptManager?: PromptManager
}

export interface ExecuteTriggerMessageParams {
  /** 触发消息列表（已合并：多条相邻同 sender 消息可能合一） */
  readonly messages: ReadonlyArray<ChannelMessage>
  /** 当前活跃任务摘要 */
  readonly activeTasks: ReadonlyArray<TaskSummary>
  /** 是否群聊 */
  readonly isGroup: boolean
  /** 当前场景画像（私聊也可能有） */
  readonly sceneProfile?: RuntimeSceneProfile
  /** 触发消息发送者 friend 信息 */
  readonly senderFriend: Friend
  /** 内存权限 */
  readonly memoryPermissions: MemoryPermissions
  /** 解析后的发送者权限 */
  readonly resolvedPermissions: ResolvedPermissions
  /** Channel / session 标识 */
  readonly channelId: string
  readonly sessionId: string
  /**
   * Dispatch LLM 生成的任务摘要（dispatchAction.text）。
   * 用作 task title / description；缺省时回退到 triggerSummary（原始消息切片）。
   * 仅影响 task 元数据展示（Admin UI / Dispatcher supplement 决策清单 / Worker prompt 任务信息段），
   * worker 拿到的 trigger_messages 仍是原始保真消息。
   */
  readonly dispatchActionText?: string
  /**
   * 完整的 Front Agent context（由 unified-agent 在调用 executeTriggerMessage 前装配）。
   * 包含 recent_messages / time_windows / active_tasks / sender_friend / scene_profile / crab_display_name 等，
   * 用于构造 worker 风格的 user prompt（含 channel/session/聊天历史/活跃任务）。
   */
  readonly frontContext: FrontAgentContext
}

export interface ExecuteTriggerMessageResult {
  /** Engine 结束原因 */
  readonly outcome: 'completed' | 'failed' | 'max_turns' | 'aborted'
  /** 最终 assistant 文本（未必是发给用户的——可能仍是内部 reasoning） */
  readonly finalText: string
  /** 早退工具调用（exitsLoop=true 的工具，如 submit_audit_result）。若 loop 自然结束则 undefined */
  readonly exitToolCall?: { readonly name: string; readonly input: Record<string, unknown> }
  /** loop 内是否调过 send_message（任一 messaging tool） */
  readonly sentMessage: boolean
  /** Engine 错误信息（outcome=failed 时填） */
  readonly error?: string
  /** Trace ID（供 caller 关联） */
  readonly traceId?: string
}

export class AgentHandler {
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
  private mcpConfigFactory: ((taskCtx: TaskContext) => Record<string, McpServer>) | undefined
  private deps?: AgentHandlerDeps
  private builtinToolConfig?: BuiltinToolConfig
  private mcpConnector?: McpConnector
  private extra: Record<string, unknown>
  private digestSdkEnv?: SdkEnvConfig
  /**
   * 当前 subagent 列表（可被 updateSubagents 热更新）。
   * 注意：in-flight worker loop 启动时 snapshot 这个引用，loop 内不再读 this.subAgents——
   * 见 runWorkerLoop 顶部 `const subAgentsSnapshot = this.subAgents`。
   */
  private subAgents: ReadonlyArray<SubAgentConfig>
  private skills: ReadonlyArray<SkillConfig>
  private readonly lspManager?: import('../lsp/lsp-manager').LSPManager
  private memoryWriter?: MemoryWriter
  private readonly promptManager?: PromptManager
  private readonly getTimezone: () => string
  /** 对外 base URL（临时页面链接拼接用），注入 worker system prompt；未配置时为 undefined（不注入） */
  private readonly tmpPageBaseUrl?: string
  /** Worker-singleton bg entity registry (persistent, disk-backed) */
  private readonly bgRegistry = new BgEntityRegistry()
  /** 监视跨重启认领回来、仍存活的 shell；退出时通知（唤醒 resumed worker + 持久通知）。 */
  private readonly readoptReaper = new ReadoptReaper(
    this.bgRegistry,
    (info) => void this.deliverShellExitNotification(info),
  )
  /** Per-task output cursor map: key = `${taskId}:${entityId}` → byte offset */
  private readonly bgCursorMap = new Map<string, number>()
  /** AbortControllers for running bg sub-agents (key=entity_id); shared with BgToolDeps */
  private readonly agentAbortControllers = new Map<string, AbortController>()
  /** resume checkpoint 用：per-task traceStore 引用（与 traceContext.traceStore 同引用，onStop 补 flush 用） */
  private readonly taskTraceStores = new Map<TaskId, import('../core/trace-store').TraceStore>()
  /** updateSkills 防抖去重 —— 同 admin 重复推同样的 skills 列表跳过赋值 */
  private lastSkillsHash: string = ''
  /**
   * Bg entity exit / 重要事件的待发通知队列。key 是 address——
   *   - `friend:<friend_id>`：持久 entity 的 owner，下一次该 friend 任意 task 启动时收到
   *   - `task:<task_id>`：transient entity（task 内事件），下一轮 agent loop 收到（待 Phase 2，本期未实现）
   * 参 Claude Code enqueueShellNotification + LocalAgentTask.enqueueAgentNotification 设计。
   */
  private readonly pendingBgNotifications = new Map<string, string[]>()
  /** Interval handle for periodic 24h GC of dead entities */
  private gcIntervalHandle?: NodeJS.Timeout

  constructor(
    sdkEnv: SdkEnvConfig,
    config: AgentHandlerConfig,
    options?: AgentHandlerOptions,
  ) {
    this.sdkEnv = sdkEnv
    this.mcpConfigFactory = options?.mcpConfigFactory
    this.deps = options?.deps
    this.systemPrompt = config.systemPrompt
    this.builtinToolConfig = options?.builtinToolConfig
    this.mcpConnector = options?.mcpConnector
    this.extra = config.extra ?? {}
    this.digestSdkEnv = options?.digestSdkEnv
    this.subAgents = options?.subAgents ?? []
    this.skills = options?.skills ?? []
    this.lspManager = options?.lspManager
    this.memoryWriter = options?.memoryWriter
    this.promptManager = options?.promptManager
    this.getTimezone = config.getTimezone ?? (() => resolveTimezone(undefined))
    this.tmpPageBaseUrl = config.tmpPageBaseUrl

    // Startup: recover persistent bg entities（跨重启对账）。
    // - deadShells（宕机期间已退出）：已读 sentinel 定真实终态，这里补发退出通知（resumed/recovery worker 会收到）。
    // - alive（仍存活的 re-adopt shell）：交 reaper 周期探活，退出时再通知（本进程非其父，收不到 child exit）。
    // - stalledAgents：已在 recoverPersistent 内标 stalled（agent 循环活在进程里，重启即无）。
    void this.bgRegistry.recoverPersistent()
      .then(({ alive, deadShells }) => {
        for (const rec of deadShells) {
          void this.deliverShellExitNotification({
            entity_id: rec.entity_id,
            command: rec.command,
            status: rec.status === 'completed' ? 'completed' : 'failed',
            exit_code: rec.exit_code ?? -1,
            spawned_by_task_id: rec.spawned_by_task_id,
            ...(rec.owner.friend_id ? { owner_friend_id: rec.owner.friend_id } : {}),
          })
        }
        const aliveShells = alive.filter(
          (r): r is BgShellRegistryRecord => r.type === 'shell',
        )
        this.readoptReaper.watch(aliveShells)
      })
      .catch((err) => {
        console.error('[AgentHandler] bg-entities recovery failed:', err)
      })

    // Startup: GC dead entities older than 7 days
    void this.bgRegistry.gcDeadEntities(new Date()).catch((err) => {
      console.error('[AgentHandler] bg-entities gc failed:', err)
    })

    // Periodic 24h GC — .unref() so it does not block process exit
    this.gcIntervalHandle = setInterval(() => {
      void this.bgRegistry.gcDeadEntities(new Date()).catch((err) => {
        console.error('[AgentHandler] periodic gc failed:', err)
      })
    }, 24 * 60 * 60 * 1000)
    this.gcIntervalHandle.unref()
  }

  /**
   * Release resources (clears the periodic GC interval).
   * Call this in tests and when the worker is being shut down to avoid timer leaks.
   */
  dispose(): void {
    if (this.gcIntervalHandle) {
      clearInterval(this.gcIntervalHandle)
      this.gcIntervalHandle = undefined
    }
  }

  /**
   * 把一条 bg entity 通知挂到队列，下一次匹配 addressKey 的 task 启动时被 drain 出来
   * 拼到 user message 头部（参 Claude Code enqueueShellNotification 设计）。
   *
   * addressKey 形式：
   *   - `friend:<friend_id>`：跨 task 持久通知（持久 entity 的 owner_friend）
   *   - `task:<task_id>`：仅当前 task 内通知（transient entity；当前 phase 未实现 mid-task 注入）
   */
  enqueueBgNotification(addressKey: string, message: string): void {
    const list = this.pendingBgNotifications.get(addressKey) ?? []
    list.push(message)
    this.pendingBgNotifications.set(addressKey, list)
  }

  /** 读后台 shell 磁盘日志的尾部（默认末 4KB）；失败返回空串。用于退出通知内联输出。 */
  private async readShellLogTail(entity_id: string, maxBytes = 4000): Promise<string> {
    const logFile = path.join(getBgEntitiesLogsDir(), `${entity_id}.log`)
    let fh: Awaited<ReturnType<typeof fs.promises.open>>
    try {
      fh = await fs.promises.open(logFile, 'r')
    } catch {
      return ''
    }
    try {
      // 只读尾部 maxBytes（避免把超大日志整读进内存）；size 取自已开 fd，省一次 stat syscall。
      const { size } = await fh.stat()
      const start = Math.max(0, size - maxBytes)
      const buf = Buffer.allocUnsafe(size - start)
      await fh.read(buf, 0, buf.length, start)
      const text = buf.toString('utf8').trim()
      return start > 0 ? `[...前 ${start} 字节省略]\n${text}` : text
    } catch {
      return ''
    } finally {
      await fh.close()
    }
  }

  /**
   * 统一的后台 shell 退出通知（Phase 2 §2.4：内联输出尾部）。
   * 既服务本进程 spawn 的 shell（runShellWithGrace 转后台后退出），也服务跨重启 re-adopt /
   * 宕机期间退出的 shell（reaper / recoverPersistent）。
   * - push 该 shell 所属 task 的 humanQueue：若该 task 正挂起，立即唤醒（in-process）。
   * - enqueueBgNotification(friend)：跨 turn / 跨重启 / 下一个 task 也能收到（resumed worker 首轮会 drain）。
   * 退出通知**内联日志尾部**，常见场景无需再单独调 Output。
   */
  private async deliverShellExitNotification(info: {
    entity_id: string
    command: string
    status: 'completed' | 'failed' | 'killed'
    exit_code: number
    spawned_by_task_id: string
    owner_friend_id?: string
    runtime_ms?: number
  }): Promise<void> {
    const command = `${info.command.slice(0, 200)}${info.command.length > 200 ? '...' : ''}`
    const runtimeStr = info.runtime_ms !== undefined ? `, 运行 ${formatRuntimeMs(info.runtime_ms)}` : ''
    const tail = await this.readShellLogTail(info.entity_id)
    const tailBlock = tail
      ? `\n--- 输出尾部 ---\n${tail}\n--- 更多用 Output("${info.entity_id}") ---`
      : `\n用 Output("${info.entity_id}") 读取完整输出。`
    const message =
      `Background shell ${info.entity_id} 已退出 (status=${info.status}, exit_code=${info.exit_code}${runtimeStr})。\n` +
      `命令: ${command}${tailBlock}`
    this.humanQueues.get(info.spawned_by_task_id)?.push(`[系统] ${message}`)
    if (info.owner_friend_id) {
      this.enqueueBgNotification(`friend:${info.owner_friend_id}`, message)
    }
  }

  /**
   * 本 task 对应的 bg-notification 地址 key：`friend:<sender_friend.id 或 __system_<session>>`。
   * onShellExit 入队、各处 drain 共用此 key，保证投递/读取口径一致。
   */
  private bgFriendKey(context: WorkerAgentContext): string {
    return `friend:${context.sender_friend?.id ?? `__system_${context.task_origin?.session_id ?? 'unknown'}`}`
  }

  /** Drain 并返回 wrapped 的 <bg-notification> 块（已包标签）。无则返回空串。 */
  private drainBgNotifications(addressKey: string): string {
    const list = this.pendingBgNotifications.get(addressKey)
    if (!list || list.length === 0) return ''
    this.pendingBgNotifications.delete(addressKey)
    return list
      .map((m) => `<bg-notification>\n${m}\n</bg-notification>`)
      .join('\n')
  }

  /**
   * 热加载：更新 skills 列表。
   *
   * 新协议下 admin 传 `{name, skill_dir}` 引用，agent 直接 fs.read 绝对路径 —— 不再需要
   * 复制 SKILL.md 到 instance 目录。lastSkillsHash 用作防抖（启动期 admin 多 trigger
   * 推同样配置时，跳过重复赋值；下一轮 LLM 调用通过 buildToolsDynamic 重建 Skill 工具）。
   */
  updateSkills(newSkills: ReadonlyArray<SkillConfig>): void {
    const hash = computeSkillsHash(newSkills)
    if (hash === this.lastSkillsHash) return
    this.skills = newSkills
    this.lastSkillsHash = hash
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
   * 热加载：更新 subagent 列表。
   *
   * 设计与 skills 的区别：subagents 用 snapshot 模式，**不影响 in-flight loop**。
   * runWorkerLoop 顶部把 this.subAgents 快照进闭包，loop 内 buildToolsDynamic /
   * buildSystemPrompt 走快照，避免任务中途换 subagent 配置打乱推理。
   * 下次新 worker loop 启动时拿到最新列表。
   */
  updateSubagents(newList: ReadonlyArray<SubAgentConfig>): void {
    this.subAgents = newList
  }

  /**
   * 热加载：更新主 LLM sdkEnv（model_config 变更时调）。
   *
   * 与 updateSubagents 同样走 snapshot 模式：runWorkerLoop 启动时已 capture
   * adapter / modelId，in-flight loop 继续用旧 adapter；下次 loop 用新。
   *
   * digestSdkEnv 单独可选；不传时保留旧值（与 updateSystemPrompt 同语义）。
   */
  updateSdkEnv(sdkEnv: SdkEnvConfig, digestSdkEnv?: SdkEnvConfig): void {
    this.sdkEnv = sdkEnv
    if (digestSdkEnv !== undefined) {
      this.digestSdkEnv = digestSdkEnv
    }
  }

  /** 暴露 subagents 当前值的只读快照（测试 / 诊断用，不应在 hot loop 中调）。 */
  getSubagentsSnapshot(): ReadonlyArray<SubAgentConfig> {
    return this.subAgents
  }

  /** 暴露 sdkEnv 当前值（测试 / 诊断用）。 */
  getSdkEnvSnapshot(): SdkEnvConfig {
    return this.sdkEnv
  }

  /** 暴露 digestSdkEnv 当前值（测试 / 诊断用）；未配置返回 undefined。 */
  getDigestSdkEnvSnapshot(): SdkEnvConfig | undefined {
    return this.digestSdkEnv
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

    // waiting 循环：loop 结束后检查异步子 agent，若有则等通知再续跑
    let loopResult: RunWorkerLoopResult | undefined
    let currentHumanQueue: HumanMessageQueue | undefined

    // resume 路径：从 checkpoint 恢复 todoStore / goalRevisionUnlocked，
    // 并把 checkpoint messages + 唤醒消息作为首轮 initialMessages。
    // runWorkerLoop 检查 activeTasks.get(task_id)——提前写入即可完成 todoStore/goalRevisionUnlocked 的恢复。
    let currentInitialMessages: ReadonlyArray<EngineMessage> | undefined
    if (params.resumeFrom) {
      const { initialMessages, todoItems, goalRevisionUnlocked, cwd: resumedCwd, lastDeliveredInfoEpoch } = params.resumeFrom
      // §3.4 修复：resume 走 initialMessages 分支，query-loop 会忽略 prompt，导致 runWorkerLoop
      // 里 buildTaskMessage 的 friend 队列 drain 被丢弃（drain-and-discard）。这里在 resume 装配处
      // 主动 drain 一次并注入首轮消息，否则宕机期间到达的 bg-notification（如 re-adopt 的 shell 退出）
      // 会丢失，resumed worker 可能等一个早已到达的信号而永久挂死。
      const resumeBgNotif = this.drainBgNotifications(this.bgFriendKey(context))
      // 唤醒消息只注入一次（resume 首轮）；后续 waiting 续跑沿用现有重设逻辑。
      // request_restart 挂起的任务恢复时，注入重启专用唤醒，让 worker 自判是否已完成。
      const wakeup = params.resumeFrom.terminalSupplementText
        ? buildTerminalSupplementWakeupMessage(params.resumeFrom.terminalSupplementText)
        : this.consumeRestartResumeMarker(task.task_id)
          ? buildRestartCompletedWakeupMessage()
          : buildResumeWakeupMessage()
      // §3.4：bg-notification 必须**并入** wakeup 这条 user message，不能另起一条——否则 checkpoint 末尾
      // 若是 assistant 消息，会出现连续两条 user，违反 Anthropic 的 user/assistant 严格交替。
      const wakeupMsg =
        resumeBgNotif && 'content' in wakeup && typeof wakeup.content === 'string'
          ? createUserMessage(`${resumeBgNotif}\n\n${wakeup.content}`)
          : wakeup
      currentInitialMessages = [...initialMessages, wakeupMsg]
      // 预建 taskState 让 runWorkerLoop 直接复用（不再用 new TodoStore()）
      if (!this.activeTasks.has(task.task_id)) {
        this.activeTasks.set(task.task_id, {
          taskId: task.task_id,
          startedAt: new Date().toISOString(),
          title: task.task_title,
          triggerType: task.source?.trigger_type === 'scheduled' ? 'scheduled' : 'message',
          abortController: new AbortController(),
          pendingHumanMessages: [],
          taskOrigin: context.task_origin,
          todoStore: TodoStore.fromItems(todoItems),
          outboundBuffer: [],
          activeAuditId: undefined,
          activeAsyncSubagentIds: new Set<string>(),
          everSentMessage: false,
          humanInputEpoch: params.resumeFrom.terminalSupplementText ? 1 : 0,
          ...(lastDeliveredInfoEpoch !== undefined ? { lastDeliveredInfoEpoch } : {}),
          everBufferedMessage: false,
          silentNoDeliveryRetries: 0,
          ...(goalRevisionUnlocked !== undefined ? { goalRevisionUnlocked } : {}),
          ...(resumedCwd !== undefined ? { cwd: resumedCwd } : {}),
        })
      }
    }

    while (true) {
      try {
        loopResult = await this.runWorkerLoop(task, context, traceCallback, traceContext, {
          skipCleanup: true,
          ...(currentHumanQueue ? { providedHumanQueue: currentHumanQueue } : {}),
          ...(currentInitialMessages ? { initialMessages: currentInitialMessages } : {}),
        })
      } catch (error) {
        this.cleanupWorkerLoopResources(task.task_id)
        const errorMessage = error instanceof Error ? error.message : String(error)
        log(`Worker error: ${errorMessage}`)
        return { task_id: task.task_id, outcome: 'failed', error: `执行失败: ${errorMessage}` }
      }

      const { engineResult, taskState, humanQueue } = loopResult
      currentHumanQueue = humanQueue

      // failed 或被 abort：直接退出，不进 waiting
      if (engineResult.outcome === 'failed' || taskState.abortController.signal.aborted) {
        break
      }

      // 检查本 task 派出的、仍在运行的异步 bg-agent（subagent）。
      // **只等 subagent，不等 bg shell**：subagent 是"派出去就该等结果"；bg shell 的 fire-and-forget
      // 是合法用法（要等用显式 wait_for_signal，退出通知会唤醒），否则永不退出的后台命令会把 task
      // 永久卡在 waiting。（shell 现在也落 bgRegistry，故这里按 type 过滤。）
      const pendingChildren = (await this.bgRegistry.list({ spawned_by_task_id: task.task_id, status: ['running'] }))
        .filter((c) => c.type === 'agent')

      if (pendingChildren.length === 0) {
        break  // 无 in-flight subagent：正常完成路径
      }

      // 有 pending children → 进 waiting 态
      log(`Task ${task.task_id}: waiting for ${pendingChildren.length} async child agent(s)`)
      try {
        if (this.deps?.getAdminPort && this.deps.rpcClient) {
          const adminPort = await this.deps.getAdminPort()
          await this.deps.rpcClient.call(adminPort, 'update_task_status', {
            // TODO(protocol): 协议命名为 waiting_bg；待 admin task-state-machine 支持后 rename。
            task_id: task.task_id,
            status: 'waiting',
          }, this.deps.moduleId)
        }
      } catch (err) {
        log(`Failed to set task ${task.task_id} to waiting: ${err}`)
      }

      // 等待 humanQueue 有新内容（子 agent 通知 或 用户 supplement）
      await humanQueue.waitForPush(taskState.abortController.signal as AbortSignal)

      if (taskState.abortController.signal.aborted) {
        break
      }

      // 恢复 executing
      try {
        if (this.deps?.getAdminPort && this.deps.rpcClient) {
          const adminPort = await this.deps.getAdminPort()
          await this.deps.rpcClient.call(adminPort, 'update_task_status', {
            task_id: task.task_id,
            status: 'executing',
          }, this.deps.moduleId)
        }
      } catch (err) {
        log(`Failed to resume task ${task.task_id} to executing: ${err}`)
      }

      // 拉走所有 pending 通知，拼成新一轮的首条 user message
      const pendingNotifs = humanQueue.drainPending()
      const notifText = pendingNotifs
        .map((m) => (typeof m === 'string' ? m : '[media]'))
        .join('\n')

      // 下一轮 loop 从上一轮 finalMessages + 通知消息继续
      currentInitialMessages = [
        ...engineResult.finalMessages,
        createUserMessage(notifText),
      ]
    }

    // 清理（统一由 executeTask 处理，runWorkerLoop skipCleanup=true 跳过了）
    this.cleanupWorkerLoopResources(task.task_id)

    if (!loopResult) {
      return { task_id: task.task_id, outcome: 'failed', error: '无循环结果' }
    }

    const { engineResult, taskState } = loopResult

    if (engineResult.error) {
      log(`Engine error (outcome=${engineResult.outcome}, turns=${engineResult.totalTurns}): ${engineResult.error}`)
    }

    // 8. Failed outcomes: surface the engine error as the summary.
    let finalEngineResult = engineResult
    const isError = engineResult.outcome === 'failed'
    if (isError && engineResult.error) {
      finalEngineResult = { ...engineResult, finalText: `执行失败 (${engineResult.totalTurns}轮后): ${engineResult.error}` }
    }

    // Check if task was aborted
    if (taskState.abortController.signal.aborted) {
      return { task_id: task.task_id, outcome: 'failed', error: '任务被取消' }
    }

    // 8.5 Finalize: update admin task status + run structured reflection + memory write
    await this.finalizeTask(task.task_id, finalEngineResult, context)

    // 9. Map EngineResult → ExecuteTaskResult
    return this.mapEngineResult(task.task_id, finalEngineResult)
  }

  /**
   * 共享 worker loop：构造适配器、工具集、system prompt，运行 runEngine，
   * 返回原始结果供 executeTask（完整任务）和 executeTriggerMessage（trigger 流）分别处理收尾。
   *
   * opts 允许 trigger 流注入 extraTools（exit 工具）、initialPrompt（user 侧 trigger prompt）、
   * overdueConfig（超期提醒），以及 onAfterTurn 回调（检测 send_message 工具调用）。
   *
   * 注意：try/finally 清理（activeTasks / humanQueues / liveSnapshots / bgCursorMap）
   * 在本方法内完成，对 executeTask 和 executeTriggerMessage 两个 caller 均透明。
   */
  private async runWorkerLoop(
    task: ExecuteTaskParams['task'],
    context: WorkerAgentContext,
    traceCallback?: TraceCallback,
    traceContext?: WorkerTraceContext,
    opts?: RunWorkerLoopOptions,
  ): Promise<RunWorkerLoopResult> {
    // idempotent：trigger 路径已由 registerTriggerAndActivate 提前 set；
    // executeTask 路径仍由本方法新建。
    let taskState = this.activeTasks.get(task.task_id)
    if (!taskState) {
      taskState = {
        taskId: task.task_id,
        startedAt: new Date().toISOString(),
        title: task.task_title,
        triggerType: task.source?.trigger_type === 'scheduled' ? 'scheduled' : 'message',
        abortController: new AbortController(),
        pendingHumanMessages: [],
        taskOrigin: context.task_origin,
        todoStore: new TodoStore(),
        outboundBuffer: [],
        activeAuditId: undefined,
        activeAsyncSubagentIds: new Set<string>(),
        everSentMessage: false,
        humanInputEpoch: 0,
        everBufferedMessage: false,
        silentNoDeliveryRetries: 0,
      }
      this.activeTasks.set(task.task_id, taskState)
    }

    // Init live snapshot（query-loop 的 onLiveProgress 会逐步填充）
    this.liveSnapshots.set(task.task_id, {
      task_id: task.task_id,
      current_turn: 0,
      started_at: Date.now(),
      active_tools: [],
      recent_completed: [],
    })

    // Create human message queue for this task（waiting 续跑时复用已有 queue）
    const humanQueue = opts?.providedHumanQueue ?? new HumanMessageQueue()
    this.humanQueues.set(task.task_id, humanQueue)

    // abortAudit helper：worker 通过 set_task_goal 改 goal 成功后调用，把当前 audit 标废。
    // 步骤（spec 2026-06-07-goal-audit-async-buffered-info-design.md §4.7）：
    //   1. abort audit subagent 进程（agentAbortControllers.get(id)?.abort()）
    //   2. 立即清 outboundBuffer + activeAuditId（不等 drain 路径，避免 spawn 阶段 marker 尚未 push 时漏清）
    //   3. push <audit_aborted> marker 到 humanQueue —— 唤醒等审中的 main loop（wait_for_signal）+
    //      让 Task 11 drain 路径走 aborted 分支注入"audit 已废"提示
    //
    // idempotent：clearActiveAuditId 与本处都置 undefined，drain 路径与 abort 路径任意先后均无害。
    // fail-soft：controller 缺失 / marker push 失败都不抛，仅 console.warn。
    const abortAudit = (reason: string): void => {
      const id = taskState.activeAuditId
      if (!id) return  // 无 active audit，no-op
      // 1. abort audit subagent process（可能已 finally 清掉了 controller，no-op 即可）
      const controller = this.agentAbortControllers.get(id)
      if (controller) {
        try { controller.abort() } catch (err) {
          console.warn('[abortAudit] controller.abort failed:', err instanceof Error ? err.message : String(err))
        }
      }
      // 2. 立即清状态（drain 路径再清也无害）
      taskState.outboundBuffer.length = 0
      taskState.activeAuditId = undefined
      // 3. push audit_aborted marker —— 唤醒 wait_for_signal + 走 drain 注入提示
      try {
        humanQueue.push(buildAuditAbortedMarker({ auditId: id, reason }))
      } catch (err) {
        console.warn('[abortAudit] push marker failed:', err instanceof Error ? err.message : String(err))
      }
    }

    let digest: ProgressDigest | undefined
    let loopSpanId: string | undefined

    try {
      // Skill 工具直接读 admin 传来的 skill_dir 绝对路径；agent 不再复制 SKILL.md 到 instance 目录。

      // Snapshot subagents at loop start. updateSubagents（admin 改 subagents 或 model_config 触发）
      // 走 hot-update 改 this.subAgents，但 in-flight loop 必须用 snapshot：避免中途换 subagent
      // 列表后，LLM 看到的 system prompt 列表 / delegate_task 工具 enum 跟它之前的推理矛盾。
      // 下次新 loop 启动时取最新 this.subAgents。
      const subAgentsSnapshot = this.subAgents

      // Build tools — adapter / sub-agent trace config 等无依赖项先行构造
      const adapter = adapterFromSdkEnv(this.sdkEnv)
      const subAgentTraceConfig = traceContext ? {
        traceStore: traceContext.traceStore,
        parentTraceId: traceContext.traceId,
        relatedTaskId: traceContext.relatedTaskId,
      } : undefined

      // search_traces 工具已从 LLM 工具盘移除（spec 2026-06-09-task-trace-tool-unification.md §4.1）。
      // Agent 视角不再区分 task vs trace；查历史 task 走 find_task，看进度走 get_task_progress。
      // trace-search-tool.ts 实现仍保留，admin UI 内部仍通过 RPC 用 traceStore.searchTraces。

      // Goal mode：worker 启动时拍当前 task.goal 状态快照，构造同步 getter
      // spec: 2026-05-23-goal-mode-design.md §7.5
      //
      // hasGoal 在 crab-messaging TaskContext 和 todo 工具 deps 中都是同步 getter，
      // 但 admin RPC 是 async。折中：启动时 query 一次拍快照到 goalSetCache，
      // 之后 worker 调 set_task_goal 工具时由 callAdminRpc 包装层同步更新 cache，
      // 后续 turn 的 todo / send_message 检查 cache 立即生效，免去重复 RPC。
      const goalModeEnabled = this.isGoalModeEnabled(task.source?.trigger_type)
      let goalSetCache = false
      // conversationLog：audit 输入——seed 人类原始请求（trigger 原文），后续追加双向往来。
      // audit 判决锚点 = 人类原话（trigger + supplements），曾因空数组起步让 auditor
      // 看不到原始需求。spec 2026-06-10-audit-anchor-human-request §3.1
      const conversationLog: ConversationEntry[] = (context.trigger_messages ?? []).map(
        (m) => ({ role: 'human' as const, content: formatMessageContent(m) }),
      )
      // sentInfoMessage：send_message(intent='info') 成功至少一次。明确 end_turn 场景下，
      // 任意已送达 info 都允许作为"已有交付"收口；无法可靠判断某条 info 是过程播报还是真交付。
      let sentInfoMessage = false
      // 任务触发类型：scheduled 任务始终抑制 forced_summary
      const workerTriggerType: 'scheduled' | 'message' =
        task.source?.trigger_type === 'scheduled' ? 'scheduled' : 'message'
      if (goalModeEnabled && this.deps?.getAdminPort && this.deps.rpcClient) {
        try {
          const adminPort = await this.deps.getAdminPort()
          const resp = await this.deps.rpcClient.call<
            { task_id: string },
            { task: { goal?: unknown } }
          >(adminPort, 'get_task', { task_id: task.task_id }, this.deps.moduleId)
          goalSetCache = resp.task.goal !== undefined
        } catch {
          // admin 不可用：保持 backward-compat，等同 no goal（audit gate 透明放行）
        }
      }

      // get_task_progress 工具：让 worker 能查任意历史任务的完整执行复盘（用于"继续上次"场景）
      // digest LLM 用于超阈值时压缩；缺省则只截断
      // spec 2026-06-09-task-trace-tool-unification.md §4.1 改名 get_task_details → get_task_progress
      const digestAdapterForTool = this.digestSdkEnv ? adapterFromSdkEnv(this.digestSdkEnv) : undefined
      const getTaskProgressTool = (traceContext && this.deps?.getAdminPort)
        ? (await import('./get-task-details-tool.js')).createGetTaskProgressTool({
            rpcClient: this.deps.rpcClient,
            moduleId: this.deps.moduleId,
            getAdminPort: this.deps.getAdminPort,
            traceStore: traceContext.traceStore,
            digestAdapter: digestAdapterForTool,
            digestModelId: this.digestSdkEnv?.modelId,
          })
        : undefined

      // find_task 工具：按 task 维度找历史任务（替代 search_traces 摸排 task_id 的绕路）
      // spec 2026-06-09-task-trace-tool-unification.md §4.1 新增
      const findTaskTool = this.deps?.getAdminPort
        ? (await import('./find-task-tool.js')).createFindTaskTool({
            rpcClient: this.deps.rpcClient,
            moduleId: this.deps.moduleId,
            getAdminPort: this.deps.getAdminPort,
          })
        : undefined

      // bg-entities trace context: attach to current task's agent_loop trace.
      const bgTraceCtx: BgEntityTraceContext | undefined = traceContext
        ? { traceStore: traceContext.traceStore, traceId: traceContext.traceId }
        : undefined

      // baseTools / baseToolsPermissionConfig 是 buildToolsDynamic 内构造的；这里用 outer let
      // 提前声明，让 endTurnGate 和 mcpConfigFactory 通过 getter 拿到 audit 用的 worker baseTools +
      // permissionConfig（auditor 调 dangerous 工具如 Bash 时 runtime permission check 才能放行）。
      // spec: 2026-05-23-goal-mode-design.md §6 / §7.2（auditor 工具来源）
      let auditBaseTools: ReadonlyArray<ToolDefinition> = []
      let auditPermissionConfig: ToolPermissionConfig | undefined

      // task-scoped cwd state（spec 2026-06-08-task-scoped-cwd-design §3.1）。
      // 存在 taskState 上（不是局部变量），两条原因：
      //   1. 跨 turn：query-loop 每轮 LLM 调用都重建工具列表（buildToolsDynamic），局部变量
      //      会每轮重置回 home，丢掉上一轮 set_cwd——表现为「set_cwd 调过了但下轮 Grep/Glob 仍搜 home」。
      //   2. 跨 resume：task 进 waiting 后 resume 会重新调 runWorkerLoop（新栈帧），局部变量同样丢失；
      //      挂在跨 iteration 持久的 taskState 上才能让 resumed worker 拿回原 cwd，避免相对路径错位。
      // 未设置时回退到 WORKSPACE_DIR env 或 homedir；set_cwd 设置后本 task 内持久。
      const getCwd = (): string => taskState.cwd ?? getWorkspaceDir()
      const setCwd = (newCwd: string): void => { taskState.cwd = newCwd }

      // wait_for_signal 用：跟踪本任务派出的 async subagent entity_ids。
      // delegate_task 异步路径返回 `{agent_id, status:'launched'}`，我们在 wrapper 里
      // 抽出 agent_id 加入 taskState.activeAsyncSubagentIds；判断"是否还有 active subagent"时
      // 跟全局 agentAbortControllers 取交集——后者在 subagent 退出（completed/failed/killed）时
      // finally 清理，是可信的 active 标志。
      // spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 3 / Task 5
      // 注：Set 现挂在 taskState 上（Task 5 reviewer follow-up），runWorkerLoop 跨 iteration 持久——
      // task 进 waiting 状态后 resume（executeTask 重新调 runWorkerLoop）时仍能复用同一 task 的 Set。

      // 工具列表构造改为 callback 形式：每轮 LLM 调用前由 query-loop 重新 resolve，
      // 让 admin push config（updateSkills / updateSystemPrompt）能在同一 task 内热生效。
      // 注意：lambda 内捕获 taskState / context / humanQueue 等闭包变量，
      // 行为与原一次性构造等价。
      const buildToolsDynamic = (): ReadonlyArray<ToolDefinition> => {
        const tools: ToolDefinition[] = []

        // 3. crab-memory MCP server tools
        const memoryTaskCtx: MemoryTaskContext = {
          taskId: task.task_id,
          channelId: context.task_origin?.channel_id,
          sessionId: context.task_origin?.session_id,
          visibility: context.memory_permissions?.write_visibility ?? 'public',
          scopes: context.memory_permissions?.write_scopes ?? [],
          sourceType: context.task_origin ? 'conversation' : 'system',
          sessionType: context.task_origin?.session_type,
          senderFriendId: context.sender_friend?.id,
          // v0.3.0：scene_profile 工具仅在 master 私聊暴露 scene 参数（其他场景强制 ctx 推断）
          isMasterPrivate:
            context.sender_friend?.permission === 'master'
            && context.task_origin?.session_type === 'private',
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
        const externalMcpServers = this.mcpConfigFactory?.({
          taskId: task.task_id,
          humanQueue,
          triggerType: task.source?.trigger_type === 'scheduled' ? 'scheduled' : 'message',
          taskType: task.task_type,
          // 用 getter 形式封装本地 cache，worker 中途 set_task_goal 后下一轮工具调用立即生效。
          hasGoal: () => goalSetCache,
          // Goal mode 缓冲：send_message handler 在工作态（无 activeAudit）把 info 消息推入 outboundBuffer；
          // 等审态（hasActiveAudit=true）下立即 flush。引用 taskState 持久数组，跨 iteration 一致。
          // spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 6
          outboundBuffer: taskState.outboundBuffer,
          hasActiveAudit: () => taskState.activeAuditId !== undefined,
          // Dispatch 钩子点（spec §4.13.6 Invariant #1+#2 / §4.13.7）。dispatchOutboundMessage success
          // 路径触发；抛错路径不触发。
          // PR-1 effect：置 everSentMessage=true（永不清零）。
          // PR-2 effect：追加 task.messages（role='agent'）—— spec 2026-06-09 §4.2 invariant #3 叠加。
          onDispatched: (entry, sendResult) => {
            taskState.everSentMessage = true
            if (entry.intent === 'info') {
              taskState.lastDeliveredInfoEpoch = entry.human_input_epoch ?? taskState.humanInputEpoch
            }
            this.appendAgentMessageBestEffort(taskState.taskId, entry, sendResult)
          },
          // 进 buffer ≠ 送达：audit fail 会整体丢弃 buffer。endTurnGate 用此标志
          // 把"交付被拦"与"从未交付"区分开（spec 2026-06-10 §3.5）。
          onBuffered: () => {
            taskState.everBufferedMessage = true
          },
          getHumanInputEpoch: () => taskState.humanInputEpoch,
          // send_message 工具自愈相对 file_path 用：当前 task cwd（set_cwd 改的 taskState.cwd）。
          getCwd,
          // 透传 sub-agent trace 上下文：让 audit gate 触发的 audit subagent
          // 产生的 sub_agent_call span 挂到主 worker trace 下，admin UI 能渲染。
          // spec: 2026-05-23-goal-mode-design.md §4.2
        }) ?? {}
        for (const [serverName, server] of Object.entries(externalMcpServers)) {
          tools.push(...mcpServerToToolDefinitions(server, serverName))
        }

        // 3d. External MCP tools (from Admin-managed servers via McpConnector)
        if (this.mcpConnector) {
          const externalTools = this.mcpConnector.getAllTools()
          tools.push(...externalTools)
        }

        // task-scoped cwd（getCwd/setCwd 声明在 buildToolsDynamic 外，跨 turn 持久——见上）。
        // 子 subagent 通过 parentTools 继承 main 的工具列表（其工具内部 closure 在 getCwd 上），
        // 自动继承当前 cwd；但 set_cwd 工具单独 push 在 baseToolsRaw capture 之后，所以子不含。

        // 3e. Built-in file/shell tools (filtered by Admin config)
        const skillsSnapshot = this.skills
        const bgOwner: BgEntityOwner = {
          friend_id: context.sender_friend?.id ?? `__system_${context.task_origin?.session_id ?? 'unknown'}`,
          session_id: context.task_origin?.session_id,
          channel_id: context.task_origin?.channel_id,
        }
        // push notification 接线（R1：唤醒语义统一，不再分 transient/persistent）：
        // 委托统一的 deliverShellExitNotification——既 push 本 task humanQueue 唤醒挂起的 worker，
        // 又 enqueueBgNotification(friend) 做持久通知，且内联日志尾部（§2.4）。
        const onShellExit: BashBgContext['onShellExit'] = (info) => {
          void this.deliverShellExitNotification({
            entity_id: info.entity_id,
            command: info.command,
            status: info.status,
            exit_code: info.exit_code,
            spawned_by_task_id: task.task_id,
            owner_friend_id: bgOwner.friend_id,
            runtime_ms: info.runtime_ms,
          })
        }
        const bgEntityCtx: BashBgContext = {
          registry: this.bgRegistry,
          owner: bgOwner,
          taskId: task.task_id,
          traceContext: bgTraceCtx,
          onShellExit,
        }
        const bgToolDeps: BgToolDeps = {
          registry: this.bgRegistry,
          cursorMap: this.bgCursorMap,
          taskId: task.task_id,
          ownerFriendId: bgOwner.friend_id,
          agentAbortControllers: this.agentAbortControllers,
        }
        tools.push(...getConfiguredBuiltinTools(
          getCwd,
          this.builtinToolConfig,
          {
            // Skill 工具直接读 admin 传来的 skill_dir 绝对路径——无需复制 SKILL.md 到 instance 目录。
            availableSkills: skillsSnapshot,
            bgEntityCtx,
            bgToolDeps,
            // 故意不传 setCwdCtx：set_cwd 在 baseToolsRaw capture 之后单独 push，
            // 让 baseTools（子 subagent 用）不含 set_cwd。
          },
        ))

        // 3f. delegate_task 工具（单一入口；sub-agent 按 subagent_type 路由）
        // baseToolsPermissionConfig 仅基于 base 工具集，给 sub-agent 用：
        //   sub-agent 内部只能见 baseTools，所以它的 permissionConfig 也只需覆盖 base 工具命名。
        const baseToolsRaw = [...tools]
        // Read dedup：仅 main worker 启用（subagent 用 baseToolsRaw 里的普通 Read，
        // 避免 stub 指向不在自己上下文里的旧读）。baseToolsRaw 已在上一行 capture（普通 Read），
        // 这里替换 main 的 tools[Read] 为带去重缓存的版本——不影响 subagent。
        // mtime 为准，Edit/Write/Bash/外部改文件后 mtime 变会自动失效，故无需主动失效。
        taskState.readFileState ??= new Map()
        const readIdx = tools.findIndex((t) => t.name === 'Read')
        if (readIdx >= 0) {
          const prevRead = tools[readIdx]
          tools[readIdx] = {
            ...createReadTool(getCwd, taskState.readFileState),
            permissionLevel: prevRead.permissionLevel,
          }
        }
        // set_cwd 工具单独 push（仅 main worker 用；子 subagent 严格继承 parent cwd 不允许改）
        tools.push(createSetCwdTool({ getCwd, setCwd }))
        const baseToolsPermissionConfig: ToolPermissionConfig =
          this.deps?.getPermissionConfig?.(baseToolsRaw, context.resolved_permissions) ?? { mode: 'bypass' }
        // baseTools 构造后立刻把 outer auditBaseTools 接上，给 audit gate 的 getter 用。
        // 见 mcpConfigFactory 上方的 outer let 声明。
        const baseTools = filterToolsByPermission(baseToolsRaw, baseToolsPermissionConfig)
        // 把 baseTools 接到 outer，audit gate getter 用。
        auditBaseTools = baseTools
        auditPermissionConfig = baseToolsPermissionConfig

        if (subAgentsSnapshot.length > 0) {
          const baseRunSubAgent = this.makeRunSubAgent({
            parentTools: baseTools,
            parentTaskId: task.task_id,
            callerLabel: 'main worker',
            humanQueue,
            permissionConfig: baseToolsPermissionConfig,
            traceConfig: subAgentTraceConfig,
            asyncEnabled: isMasterPrivate,
            asyncCtx: {
              owner: {
                friend_id: context.sender_friend?.id ?? `__system_${context.task_origin?.session_id ?? 'unknown'}`,
                session_id: context.task_origin?.session_id,
                channel_id: context.task_origin?.channel_id,
              },
            },
          })
          // wrap：异步路径返回 `{agent_id, status:'launched'}` → 抓出来加入 taskState.activeAsyncSubagentIds，
          // 供 wait_for_signal.hasActiveAsyncSubagent 判断。同步路径不带 launched 状态，不影响。
          const trackingRunSubAgent: typeof baseRunSubAgent = async (subagent, input, ctx) => {
            const result = await baseRunSubAgent(subagent, input, ctx)
            if (!result.isError && typeof result.output === 'string') {
              const agentId = extractLaunchedSubagentId(result.output)
              if (agentId) taskState.activeAsyncSubagentIds.add(agentId)
            }
            return result
          }
          tools.push(createDelegateTaskTool({
            subAgents: subAgentsSnapshot,
            runSubAgent: trackingRunSubAgent,
          }))
        }

        // 3h. find_task + get_task_progress（spec 2026-06-09 §4.1）— search_traces 已从 LLM 工具盘删除
        if (findTaskTool) {
          tools.push(findTaskTool)
        }
        if (getTaskProgressTool) {
          tools.push(getTaskProgressTool)
        }

        // 3j. todo tool — per-task mutable plan
        // todo 工具永远放行 —— goal 与 todo 解耦，由 prompt 软引导决定是否需要 goal
        // spec: 2026-06-05-goal-soft-control-workflow-redesign-design.md §1
        tools.push(createTodoTool(taskState.todoStore))

        // 3j2. set_task_goal tool — worker 写下完成承诺，触发 audit gate + todo 门控解锁
        // goal mode 关闭时不注入，agent 无法设定目标，audit gate 透明放行
        // spec: 2026-05-23-goal-mode-design.md §7.3
        if (goalModeEnabled && this.deps?.getAdminPort && this.deps.rpcClient) {
          const adminDeps = this.deps
          tools.push(createSetTaskGoalTool({
            taskId: task.task_id,
            callAdminRpc: async <T = unknown>(method: string, params: unknown) => {
              const adminPort = await adminDeps.getAdminPort!()
              const result = await adminDeps.rpcClient.call<unknown, T>(adminPort, method, params, adminDeps.moduleId)
              if (method === 'set_task_goal') {
                // RPC 成功 → 同步更新本地 cache，让后续 todo 写模式 / audit gate 立即解锁
                goalSetCache = true
              }
              return result
            },
            // 改目标券：已有 goal 时重设需消费一张人类授权的券（deliverHumanResponse 发放）。
            // taskState 与 activeTasks 里同引用，能读到 supplement 到达时的置位。
            hasExistingGoal: () => goalSetCache,
            hasRevisionToken: () => taskState.goalRevisionUnlocked === true,
            consumeRevisionToken: () => { taskState.goalRevisionUnlocked = false },
            // 改 goal 成功后 abort 当前 audit（针对旧 goal 跑的）+ 清 outboundBuffer + 推 aborted marker。
            // 首次设 goal 时也调，因 activeAuditId 为 undefined 故 no-op。
            // spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.7
            abortAudit,
          }))
        }

        // 3k. Subagent coordinator tools（async 路径：list_active_subagents / get_subagent_output / stop_subagent）
        // 仅在 asyncEnabled（master + 私聊）时注入，其他场景 subagent 是同步的，无需协调工具
        if (isMasterPrivate) {
          tools.push(...createSubagentCoordinatorTools({
            taskId: task.task_id,
            bgRegistry: this.bgRegistry,
            killBgEntity: (entity_id) => this.killBgEntity(entity_id),
          }))
          tools.push(createRequestRestartTool({
            adminDataDir: getAdminDataDir(),
            requestRestart: (reason) => this.requestRestartForTask(task.task_id, reason),
          }))
        }

        // 3k2. wait_for_signal — 通用挂起原语，总是注入
        // 合法性由工具内部预检判定（无 pending 事件且无 timeout_ms 时拒绝空挂起）。
        // hasActiveAudit：taskState.activeAuditId 非空表示 task 处于"等审态"。
        // hasActiveAsyncSubagent：跟全局 agentAbortControllers 取交集——bg-agent.ts 在 finally 清理 controller，
        // 所以 "id 还在 Map 里" 等价于 "subagent 还没退出"。
        // spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 3 / Task 5
        const waitForSignalTool = maybeCreateWaitForSignalTool(
          { goalModeEnabled, asyncEnabled: isMasterPrivate },
          {
            humanQueue,
            hasActiveAudit: () => taskState.activeAuditId !== undefined,
            hasActiveAsyncSubagent: () => {
              for (const id of taskState.activeAsyncSubagentIds) {
                if (this.agentAbortControllers.has(id)) return true
              }
              return false
            },
            // R2：本 task 名下 running 的（持久）bg shell——退出时 onShellExit push humanQueue 唤醒，
            // 所以"等它退出"是合法裸挂起。可能永不退出的进程（服务/监控）仍建议带 timeout_ms。
            hasRunningBgEntity: async () => {
              const running = await this.bgRegistry.list({ status: ['running'] })
              return running.some((s) => s.type === 'shell' && s.spawned_by_task_id === task.task_id)
            },
          },
        )
        if (waitForSignalTool) tools.push(waitForSignalTool)

        // 3l. Extra tools from opts (e.g., exit tools for trigger flow)
        if (opts?.extraTools) {
          tools.push(...opts.extraTools)
        }

        // 最终过滤：用「完整 tools 集合」重算 permissionConfig，
        // 否则 delegate_*/trace_search 等后注入的工具因不在 baseToolsPermissionConfig 的 denyList 里而漏过 filter，
        // 导致 LLM 看见但 runEngine 用 initialPermissionConfig 又拒绝（违反「无权限工具不注入 prompt」）。
        const fullPermissionConfig: ToolPermissionConfig =
          this.deps?.getPermissionConfig?.(tools, context.resolved_permissions) ?? { mode: 'bypass' }
        return filterToolsByPermission(tools, fullPermissionConfig)
      }

      // System prompt 也改为 callback：admin push config 触发 updateSystemPrompt 后下一轮生效。
      // goalModeEnabled 沿用 runWorkerLoop 启动时计算的快照（line 810），跟 audit gate 口径一致：
      // extra.goal_mode_enabled !== false && trigger_type !== 'scheduled'。
      const buildSystemPromptDynamic = (): string =>
        this.buildSystemPrompt(context, subAgentsSnapshot, goalModeEnabled, task.task_id)

      // 5. Build task message（一次性，task 启动后用户请求/记忆等不变）
      // 若 opts 提供了 initialPrompt，跳过 buildTaskMessage（trigger 流自己构造 prompt）。
      let taskMessage: string | ContentBlock[]
      if (opts?.initialPrompt !== undefined) {
        taskMessage = opts.initialPrompt
      } else {
        // 拼接 bg-notification：上一次该 friend 留下的 bg entity exit 等事件
        taskMessage = await this.buildTaskMessage(task, context)
        const bgNotifBlock = this.drainBgNotifications(this.bgFriendKey(context))
        if (bgNotifBlock) {
          if (typeof taskMessage === 'string') {
            taskMessage = `${bgNotifBlock}\n\n${taskMessage}`
          } else {
            // ContentBlock[] 形式：在最前面加一个 text block
            taskMessage = [{ type: 'text', text: `${bgNotifBlock}\n\n` }, ...taskMessage]
          }
        }
      }

      // 6. Set up trace and progress tracking
      // senderIsMaster：master 在任何 session（私聊/群聊）都享受 CLI 全权（cli-permission-gate 短路依据）
      // 注意 isMasterPrivate（master + 私聊）保留给 progress digest / bg entity persistence 等独立语义
      const senderIsMaster = context.sender_friend?.permission === 'master'
      const isMasterPrivate =
        senderIsMaster
        && context.task_origin?.session_type === 'private'

      const taskOrigin = context.task_origin

      // 初始 snapshot：用于 trace 记录 + 给 runEngine 的 permissionConfig option（兜底）。
      // runEngine 内部会在每轮调用 buildToolsDynamic 重新拿最新工具列表。
      const initialTools = buildToolsDynamic()
      const initialPermissionConfig: ToolPermissionConfig =
        this.deps?.getPermissionConfig?.(initialTools, context.resolved_permissions) ?? { mode: 'bypass' }

      log(`Starting worker engine: model=${this.sdkEnv.modelId}, task=${task.task_title}, tools=${initialTools.length}`)

      // Start loop span — loop_label='task'（旧值 'worker' 由 UI agentLoopLabel 兼容映射）
      loopSpanId = traceCallback?.onLoopStart('task', {
        system_prompt: undefined,
        model: this.sdkEnv.modelId,
        tools: initialTools.map(t => t.name),
      })

      // 主 loop 对话状态的只读 holder —— engine 在每 turn 后浅拷贝刷新 current，
      // 每次 LLM 调用前快照 systemPrompt/tools；ProgressDigest 定时从这里 fork
      // 一份做摘要，主 loop 不感知。
      // 总是创建：即使本任务不启用 digest（silent / text_forward），engine 维护
      // 它无副作用，留出钩子方便日后其他 observer 复用。
      const messagesRef: EngineMessagesRef = { current: [] }
      // resume checkpoint 用：让 onStop（优雅停机）能通过 taskState 拿到最新快照。
      taskState.messagesRef = messagesRef
      // 快照 worker 执行上下文子集（权限/身份/场景）——resumed worker 据此复原工具集 + 投递
      // 目标 + report mode。缺了它 resumed worker 会落进 FAIL_CLOSED（几乎无工具）。
      taskState.resumeWorkerContext = {
        task_origin: context.task_origin,
        sender_friend: context.sender_friend,
        memory_permissions: context.memory_permissions,
        resolved_permissions: context.resolved_permissions,
        scene_profile: context.scene_profile,
      }
      // traceId 存 taskState + traceStore 存 Map，供 flushActiveCheckpoints（onStop 路径）补 flush。
      if (traceContext) {
        taskState.activeTraceId = traceContext.traceId
        this.taskTraceStores.set(task.task_id, traceContext.traceStore)
      }

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
            : 1800

          const digestConfig: ProgressDigestConfig = {
            intervalMs: intervalSec * 1000,
            isMasterPrivate,
            // trace span：让 admin UI 上能看到 digest 在哪个时刻被触发以及由谁触发
            // （定时 / 超期 / ask_human）。span 命名沿用 `__system_*__` 内部 span 风格。
            ...(traceCallback ? {
              onTraceStart: (reason) =>
                traceCallback.onToolCallStart('__system_progress_digest__', `reason=${reason}`),
              onTraceEnd: (spanId, status, details) =>
                traceCallback.onToolCallEnd(
                  spanId,
                  typeof details?.output_summary === 'string' ? details.output_summary : '(no output)',
                  status === 'failed' && typeof details?.error === 'string' ? details.error : undefined,
                ),
            } : {}),
          }

          const digestDeps: ProgressDigestDeps = {
            sendToUser: (text: string) => this.sendToUser(taskOrigin, text),
            adapter,
            modelId: this.sdkEnv.modelId,
            ...(this.sdkEnv.maxTokens !== undefined ? { maxTokens: this.sdkEnv.maxTokens } : {}),
            messagesRef,
          }

          digest = new ProgressDigest(digestConfig, digestDeps)
        } else if (reportMode === 'text_forward') {
          textForwardMode = true
        }
        // reportMode === 'silent' → no digest, no text forward
      }

      // 6b. CLI 权限闸：所有场景都注册，hook 内按 resolvedPermissions/cli_access 判定放行/拒绝
      // （历史：原本只在非 master 私聊注册 — 现已改为按 effective permissions 统一闸，
      //  isMasterPrivate 仅保留给 progress digest / bg entity persistence 等独立语义）
      const workerHookRegistry: HookRegistry = new HookRegistry()
      workerHookRegistry.register(createCliPermissionHook())
      // Skill 目录写入 fence —— 拦 Write/Edit 直接改 data/admin/skills/**，强制走 `crabot skill update`
      // 以确保 admin N=1 previous_snapshot + UI diff + restore 链路生效。
      workerHookRegistry.register(createSkillDirFenceHook())

      // 6c. 注入 CLI 环境变量（CRABOT_TOKEN + CRABOT_ACTOR）
      // 总是注入（不论 isMasterPrivate）—— token 只是让子进程能调 CLI；
      // 真正的权限边界在 cli-permission-gate hook（按 effective cli_access 判定）。
      // 不注入会让群聊/非 master 任务的 read 类 CLI（如 'crabot mcp list'）也跑不起来。
      if (!process.env.CRABOT_TOKEN) {
        const tokenPath = getAdminInternalTokenPath()
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
      // **不通过 CLI flag 传**，避免 LLM 通过命令行参数伪造身份。
      // 真正的写权限闸由 cli-permission-gate hook 按 effective cli_access[domain] + 内容审核判定；
      // 这里 friend_id 来自 task_origin，可能是 master / 普通 friend / 系统 schedule（空）。
      const taskFriendId = context.task_origin?.friend_id
      if (taskFriendId) {
        process.env.CRABOT_TASK_FRIEND_ID = taskFriendId
      } else {
        delete process.env.CRABOT_TASK_FRIEND_ID
      }

      // 7. Run engine — systemPrompt 和 tools 传 lambda，每轮 LLM 调用前 query-loop 重新 resolve
      // maxTurns: 主任务允许长时间执行（探索类任务可能跑 1000+ turn）；context-manager 在
      // 80% 窗口时自动 compaction 兜底。真正死循环可通过用户 supplement（dispatcher 注入）或 abort 中断。
      let compactionSpanId: string | undefined = undefined
      let compactionStartedAtMs: number | undefined = undefined
      const engineResult = await runEngine({
        prompt: taskMessage,
        adapter,
        ...(opts?.initialMessages ? { initialMessages: [...opts.initialMessages] } : {}),
        options: {
          systemPrompt: buildSystemPromptDynamic,
          tools: buildToolsDynamic,
          model: this.sdkEnv.modelId,
          ...(this.sdkEnv.maxTokens !== undefined ? { maxTokens: this.sdkEnv.maxTokens } : {}),
          maxTurns: 2000,
          supportsVision: this.sdkEnv.supportsVision,
          permissionConfig: initialPermissionConfig,
          timezone: this.getTimezone(),
          abortSignal: taskState.abortController.signal as AbortSignal,
          humanMessageQueue: humanQueue,
          messagesRef,
          onAfterCompaction: (messages) => {
            const injection = taskState.todoStore.formatForInjection()
            if (!injection) return messages
            return [createUserMessage(injection), ...messages]
          },
          hookRegistry: workerHookRegistry,
          senderIsMaster,
          ...(context.resolved_permissions ? { resolvedPermissions: context.resolved_permissions } : {}),
          contentReviewer: this.buildContentReviewer(),
          sessionType: context.task_origin?.session_type ?? 'private',
          // 一旦有 info 送达，就允许后续 silent end_turn 作为正常收口：系统无法可靠判断
          // 某条 info 是过程播报还是真实交付，只能尊重已送达事实。scheduled 任务同样保持静默收口。
          // 注意：这只适用于明确 stopReason='end_turn' 的收口；stopReason=null 是 adapter/stream
          // 终态缺失，query-loop 会按失败处理，不能借此完成 task。
          suppressForcedSummary: () => workerTriggerType === 'scheduled' || sentInfoMessage,
          // Goal mode 缓冲消息 flush 钩子：engine 在 stop_reason='tool_use' 续 turn 之前
          // 和 endTurnGate 返回 null 后调用。把 taskState.outboundBuffer 里截留的 info
          // 消息真正发到 channel 并清空 buffer。失败 entry 不阻塞后续 entry（continue on error）。
          //
          // 通过 createOutboundFlush + dispatchOutboundMessage 跟 send_message handler immediate-send
          // 路径共用同一份 dispatch 逻辑——支持 file_path + sandbox path mapping、friend_id-only mention
          // 反查 admin get_friend、features 组装，行为完全等价。
          //
          // spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 8 + §4.5
          flushOutboundBuffer: (() => {
            if (!this.deps?.rpcClient || !this.deps?.resolveChannelPort) return undefined
            const adminPortGetter = this.deps.getAdminPort
            if (!adminPortGetter) return undefined
            const dispatchDeps: OutboundDispatchDeps = {
              rpcClient: this.deps.rpcClient,
              moduleId: this.deps.moduleId,
              resolveChannelPort: this.deps.resolveChannelPort,
              getAdminPort: adminPortGetter,
              ...(this.deps.sandboxPathMappingsRef
                ? { sandboxPathMappingsRef: this.deps.sandboxPathMappingsRef }
                : {}),
              // spec §4.13.6 钩子点：同 mcpConfigFactory 注入 TaskContext 时一致的 effect。
              // post-tool flushOutboundBuffer / audit pass flush 路径触发。
              // PR-1 effect：everSentMessage=true。
              // PR-2 effect：append task.messages（role='agent'）— spec 2026-06-09 §4.2 invariant #3。
              onDispatched: (entry, sendResult) => {
                taskState.everSentMessage = true
                if (entry.intent === 'info') {
                  taskState.lastDeliveredInfoEpoch = entry.human_input_epoch ?? taskState.humanInputEpoch
                }
                this.appendAgentMessageBestEffort(taskState.taskId, entry, sendResult)
              },
            }
            return createOutboundFlush(taskState.outboundBuffer, dispatchDeps)
          })(),
          // engine drain 路径识别到 audit_result.pass=false / audit_aborted 时调，丢弃缓冲的"完工汇报"。
          // spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.5 / §4.7
          dropOutboundBuffer: () => {
            taskState.outboundBuffer.length = 0
          },
          // engine drain 路径处理完 audit_result / audit_aborted marker 之后调，让 task 回到"无活跃 audit"态。
          // spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.5 / §4.7
          clearActiveAuditId: () => {
            taskState.activeAuditId = undefined
          },
          // Task 13 兜底：audit 跑中 LLM 直接 end_turn 时 engine 判定是否仍有活跃 audit。
          // taskState.activeAuditId 非空表示 audit 子进程还没完成。
          // spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.6
          hasActiveAudit: () => taskState.activeAuditId !== undefined,
          // Task 13 兜底拦截耗尽 3 次后，engine 调此 abort 当前 audit。
          // 复用 set_task_goal 路径相同的 abortAudit closure——
          // controller.abort + push audit_aborted marker + 清 outboundBuffer + activeAuditId。
          // spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.6 / §4.7
          abortActiveAudit: (reason: string) => abortAudit(reason),
          endTurnGate: this.buildAsyncAuditEndTurnGate({
            goalModeEnabled,
            goalSetCacheGetter: () => goalSetCache,
            taskId: task.task_id,
            taskState,
            subAgents: subAgentsSnapshot,
            // 闭包延迟读 auditBaseTools —— 由 buildToolsDynamic 写入，engine 第一次跑前
            // 已被 callback 调用过；endTurnGate 触发时一定有值。
            getAuditBaseTools: () => auditBaseTools,
            getAuditPermissionConfig: () => auditPermissionConfig,
            ...(subAgentTraceConfig ? { traceConfig: subAgentTraceConfig } : {}),
            humanQueue,
            cwd: getWorkspaceDir(),
            owner: {
              friend_id: context.sender_friend?.id ?? `__system_${context.task_origin?.session_id ?? 'unknown'}`,
              session_id: context.task_origin?.session_id,
              channel_id: context.task_origin?.channel_id,
            },
            getConversationLog: () => [...conversationLog],
          }),
          onSystemInjection: (event) => {
            // 系统注入（supplement / overdue / forced_summary / stop_hook）作为 trace 上的 tool-call 风格 span 暴露
            const label = `__system_${event.type}__`
            const inputSummary = event.text.slice(0, 200)
            const spanId = traceCallback?.onToolCallStart(label, inputSummary, event.injectedAtMs)
            if (spanId) {
              traceCallback?.onToolCallEnd(spanId, '(engine injected user message)', undefined, event.injectedAtMs)
            }
            // 追踪 human supplement 到 conversationLog
            if (event.type === 'supplement') {
              conversationLog.push({ role: 'human', content: event.text })
            }
          },
          onCompactionStart: () => {
            // 压缩会把旧消息（含早先的 Read tool_result）摘要掉。清空 read dedup 缓存，
            // 让压缩后首次读重新全量填充——否则 stub 会指向已被摘要掉的旧 tool_result（悬空）。
            taskState.readFileState?.clear()
            // 上下文压缩开始——开个 __compaction__ span，结束时填入压缩前后消息数和耗时
            compactionStartedAtMs = Date.now()
            compactionSpanId = traceCallback?.onToolCallStart('__compaction__', 'context compaction', compactionStartedAtMs)
          },
          onCompactionEnd: (info) => {
            if (compactionSpanId) {
              const endedAtMs = (compactionStartedAtMs ?? Date.now()) + info.durationMs
              traceCallback?.onToolCallEnd(
                compactionSpanId,
                `compacted ${info.beforeCount} → ${info.afterCount} msgs in ${info.durationMs}ms`,
                undefined,
                endedAtMs,
              )
              compactionSpanId = undefined
              compactionStartedAtMs = undefined
            }
          },
          onLiveProgress: (event: LiveProgressEvent) => {
            // Update in-memory snapshot so ContextAssembler can read it.
            // 容错：如果任务已被清理（极端情况下 abort 后还有 in-flight 回调），略过。
            if (!this.liveSnapshots.has(task.task_id)) return
            switch (event.type) {
              case 'turn_assistant':
                this.updateLiveSnapshot(task.task_id, prev => {
                  const next = {
                    ...prev,
                    current_turn: event.turn,
                    last_assistant_text: event.text.slice(0, 400),
                  }
                  // LLM 成功返回了，清掉 retry 状态（仅当之前真有 retry 才更新，避免无谓的 store 通知）
                  return prev.llm_retry ? { ...next, llm_retry: undefined } : next
                })
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
                  const trimmed = merged.length > AgentHandler.RECENT_COMPLETED_LIMIT
                    ? merged.slice(merged.length - AgentHandler.RECENT_COMPLETED_LIMIT)
                    : merged
                  // 工具完成时清掉 llm_retry 状态（之前的 retry 已经过去）
                  const next = { ...prev, active_tools: [], recent_completed: trimmed }
                  if (prev.llm_retry) {
                    return { ...next, llm_retry: undefined }
                  }
                  return next
                })
                break
              }
              case 'llm_retry': {
                this.updateLiveSnapshot(task.task_id, prev => ({
                  ...prev,
                  llm_retry: {
                    attempt: event.attempt,
                    max_attempts: event.maxAttempts,
                    source: event.source,
                    last_error: event.error.slice(0, 200),
                    since: Date.now(),
                  },
                }))
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
                tc.id,
              )
              if (toolSpanId) {
                // tool 若返回 JSON 且含 child_trace_id（如 delegate_task），抓出来挂到 span.details
                // 让 Admin UI 能从这个 tool_call span 内联展开子 trace。
                const childTraceId = extractChildTraceIdFromOutput(tc.output)
                traceCallback?.onToolCallEnd(
                  toolSpanId,
                  tc.output?.slice(0, 500) || '(no output)',
                  tc.isError ? tc.output : undefined,
                  toolEndedAtMs,
                  childTraceId,
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
                  ...(event.forcedSummaryAttempt !== undefined ? { forcedSummaryAttempt: event.forcedSummaryAttempt } : {}),
                  ...(event.usage ? { usage: llmUsageToTrace(event.usage) } : {}),
                  messageCountAfter: messagesRef.current.length,
                  ...(event.diagnostics ? { diagnostics: event.diagnostics } : {}),
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

            // 追踪 agent 发出的消息到 conversationLog（send_message / send_private_message）
            for (const tc of event.toolCalls) {
              const bare = tc.name.replace(/^mcp__[^_]+__/, '')
              if ((bare === 'send_message' || bare === 'send_private_message') && !tc.isError) {
                const input = tc.input as { intent?: string; content?: string } | undefined
                const msgContent = input?.content
                const msgIntent = input?.intent as 'info' | 'ask_human' | undefined
                if (msgContent !== undefined) {
                  if (msgIntent === 'ask_human') {
                    conversationLog.push({ role: 'agent', intent: 'ask_human', content: msgContent })
                  } else {
                    // intent='info' 或默认（无 intent）均视为 info
                    sentInfoMessage = true
                    conversationLog.push({ role: 'agent', intent: 'info', content: msgContent })
                  }
                }
              }
            }

            // resume checkpoint：每 turn 结束时原子落盘（干净 turn 边界）。
            // traceContext.traceId 是本 worker loop 的 trace id（由 unified-agent 在
            // startTrace 后传入）。仅 worker trace 有 traceContext，front 路径无。
            if (traceContext && task.task_id) {
              traceContext.traceStore.flushWorkerCheckpoint(task.task_id, traceContext.traceId, {
                agent_version: AGENT_VERSION,
                system_prompt: messagesRef.systemPrompt ?? '',
                messages: messagesRef.current.slice() as import('../engine/types.js').EngineMessage[],
                worker_state: {
                  todo_items: [...taskState.todoStore.list()],
                  goal_revision_unlocked: taskState.goalRevisionUnlocked,
                  last_delivered_info_epoch: taskState.lastDeliveredInfoEpoch,
                  ...(taskState.cwd !== undefined ? { cwd: taskState.cwd } : {}),
                },
                ...(taskState.resumeWorkerContext ? { worker_context: taskState.resumeWorkerContext } : {}),
              })
            }

            // Caller hook: trigger flow uses this to detect send_message
            opts?.onAfterTurn?.(event)
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

      return {
        engineResult,
        taskState,
        humanQueue,
        digest,
        loopSpanId,
      }

    } finally {
      digest?.dispose()
      if (!opts?.skipCleanup) {
        this.humanQueues.get(task.task_id)?.clearBarrier()
        this.humanQueues.delete(task.task_id)
        this.activeTasks.delete(task.task_id)
        this.liveSnapshots.delete(task.task_id)
        this.taskTraceStores.delete(task.task_id)
        // 后台 shell 现在全是持久实体，随 task 结束存活（终态由 reaper/GC 清；可被 Kill 杀）。
        // Clean up cursor map entries for this task to avoid memory leak
        for (const key of this.bgCursorMap.keys()) {
          if (key.startsWith(`${task.task_id}:`)) {
            this.bgCursorMap.delete(key)
          }
        }
      }
    }
  }

  /**
   * 清理 runWorkerLoop 在 skipCleanup=true 模式下跳过的资源。
   * 由 executeTask 等待循环结束后调用。
   */
  private cleanupWorkerLoopResources(taskId: string): void {
    // worker loop 终结 → 删 per-task checkpoint 文件，避免它作为孤儿留盘：
    // 否则下次重启会被当 in-flight 处理（已完成的 trace 被 orphan 对账误标 failed）。
    // 必须在删 taskTraceStores 之前取到 store。
    this.taskTraceStores.get(taskId)?.clearCheckpointFile(taskId)
    this.humanQueues.get(taskId)?.clearBarrier()
    this.humanQueues.delete(taskId)
    this.activeTasks.delete(taskId)
    this.liveSnapshots.delete(taskId)
    this.taskTraceStores.delete(taskId)
    for (const key of this.bgCursorMap.keys()) {
      if (key.startsWith(`${taskId}:`)) {
        this.bgCursorMap.delete(key)
      }
    }
    // task 完成即回收名下终态 shell（记录 + 日志 + sentinel）；running 的留存（持久）。
    void this.bgRegistry.removeTerminalShellsByTask(taskId).catch((err) => {
      console.error(`[AgentHandler] removeTerminalShellsByTask(${taskId}) failed:`, err)
    })
  }

  /**
   * 工具 request_restart 的落点：**复用 ask_human 的 barrier 挂起机制**（跟 send_message(ask_human)
   * / wait_for_signal 同一套 humanQueue.setBarrier 路径）。
   *
   * 为什么用 barrier 而不是 abort：barrier 是「工具执行完（tool_result 已入 messages、checkpoint
   * 已完整 flush、fireOnTurn 已 record）之后，engine 的 post-tool barrier check 停住 loop、不再发起
   * 下一轮 LLM（主动权不交回 agent）」——这正是 ask_human 的实现。abort 则会在工具执行中途打断底层
   * stream，让 checkpoint 残缺（只有 tool_use 无 tool_result）、resume 畸形失败（已踩过的坑）。
   *
   * 流程：setBarrier 让 worker 在本 turn 干净收尾后 park（checkpoint 完整）→ spawn detached 重启
   * 杀掉 parked 的 agent（~秒级，checkpoint 早已落盘）→ reboot 后 resume-sweep 续起（task 仍是
   * 可 resume 的 in-flight 态）→ worker 收到 buildRestartCompletedWakeupMessage 后自判收尾/续跑。
   */
  private requestRestartForTask(taskId: string, reason?: string): void {
    this.writeRestartResumeMarker(taskId)
    // barrier 超时给足（重启实际只需秒级；超时仅作兜底，避免重启异常时 worker 永久 park）。
    this.humanQueues.get(taskId)?.setBarrier(10 * 60 * 1000)
    this.spawnInstanceRestart(reason)
  }

  /** detached spawn restart.mjs；搬自旧 restart-instance-tool，由 executeTask 拦截调用。 */
  private spawnInstanceRestart(reason?: string): void {
    const crabotHome = process.env.CRABOT_HOME ?? path.resolve(__dirname, '../..')
    const script = path.join(crabotHome, 'scripts', 'restart.mjs')
    if (!fs.existsSync(script)) {
      log(`[request_restart] 找不到重启脚本：${script}`)
      return
    }
    const logDir = path.join(getAdminDataDir(), '..', 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    const logFd = fs.openSync(path.join(logDir, 'restart.log'), 'a')
    const child = spawn(process.execPath, [script], {
      cwd: crabotHome,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, CRABOT_RESTART_REASON: reason ?? '' },
    })
    child.on('error', (err) => log(`[request_restart] spawn restart.mjs failed: ${err}`))
    child.unref()
  }

  private restartResumeMarkerPath(taskId: string): string {
    return path.join(getAgentDataDir(), 'restart-resume', `${taskId}.flag`)
  }

  private writeRestartResumeMarker(taskId: string): void {
    const p = this.restartResumeMarkerPath(taskId)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, new Date().toISOString())
  }

  /** 消费（存在即返回 true 并删除） */
  private consumeRestartResumeMarker(taskId: string): boolean {
    const p = this.restartResumeMarkerPath(taskId)
    if (!fs.existsSync(p)) return false
    try { fs.unlinkSync(p) } catch { /* ok */ }
    return true
  }

  /**
   * 构造 cli-permission-gate hook 用的内容审核器。
   *
   * 复用 worker 自身 LLM adapter / model（fast 档暂未单独配置）。schedule add 频率低，
   * 性能不敏感；后续若需独立 review slot，加新 sdkEnv 字段即可，不影响调用 site。
   */
  private buildContentReviewer(): ContentReviewer {
    const adapter = adapterFromSdkEnv(this.sdkEnv)
    const modelId = this.sdkEnv.modelId
    return async ({ effectivePermissions, commandText }) =>
      reviewCliContent({ effectivePermissions, commandText, adapter, modelId })
  }

  /**
   * Trigger 流的同步段：生成 taskId → register admin → activeTasks.set。
   * 返回后下一批 dispatcher 的 fetchActiveTasks 必然能拉到这个 task，
   * SessionLane handler 可以解锁处理下一批。
   *
   * 与 runTriggerWorkerLoop 配对使用。executeTriggerMessage 是两者的薄壳。
   *
   * ⚠️ 调用方必须在 await 后立即调 runTriggerWorkerLoop（或在自身 try/catch 异常时
   * `this.activeTasks.delete(pre.taskId)`），否则 register 成功但 run 未启动会留下
   * phantom 条目，下次 dispatcher 看到错位的 activeTasks。
   *
   * Spec: 2026-05-20-session-lane-dispatcher-design.md §3.3
   */
  async registerTriggerAndActivate(
    params: ExecuteTriggerMessageParams,
  ): Promise<{
    taskId: TaskId
    registered: boolean
    task: ExecuteTaskParams['task']
    context: WorkerAgentContext
    /**
     * Task 的标题 / 触发摘要。优先用 dispatch LLM 生成的 actionText（清晰任务化），
     * 缺省回退到 messages 最后一条切 100 字。同时作为 task_title /
     * activeTasks.title / task trace.trigger.summary 使用。
     */
    taskTitle: string
  }> {
    const { messages, isGroup, senderFriend, memoryPermissions, resolvedPermissions,
      channelId, sessionId, frontContext, dispatchActionText } = params

    // Fallback 路径：dispatchActionText 缺省时从原始消息切片。
    // messages 就是当前 trigger 批次（spec 2026-06-04 §3：单段时间线后，messages
    // 不再 prepend baseHistory）；取最后一条作为 trigger 摘要 = 触发批次的尾部。
    const lastMsg = messages[messages.length - 1]
    const lastMsgText = lastMsg?.content.type === 'text' ? (lastMsg.content.text ?? '') : '[非文本]'
    const triggerSummary = lastMsgText.slice(0, 100)
    // 优先用 Dispatch LLM 生成的任务摘要（清晰、抽象到任务层面），缺省时才回退到原始消息切片。
    // Spec: title 不只是 UI 展示——dispatcher 做 supplement 决策时活跃任务清单里展示的就是它。
    const taskTitle = (dispatchActionText && dispatchActionText.trim().length > 0)
      ? dispatchActionText.slice(0, 200)
      : triggerSummary
    const syntheticTaskId = `trigger-${randomUUID()}` as TaskId

    let registered = false
    try {
      await this.registerTriggerTaskToAdmin({
        syntheticTaskId,
        taskTitle,
        channelId,
        sessionId,
        senderFriendId: senderFriend.id,
        // spec 2026-06-09 §4.2: messages[0] 用触发消息原文（不截断），是 find_task 按
        // 聊天细节词命中的关键字段；跟 taskTitle 取自 dispatcher LLM 抽象描述形成互补。
        triggerMessageContent: lastMsgText,
        ...(lastMsg?.platform_message_id ? { triggerPlatformMessageId: lastMsg.platform_message_id } : {}),
      })
      registered = true
    } catch (err) {
      log(`registerTriggerAndActivate: registerToAdmin failed (continuing) syntheticTaskId=${syntheticTaskId}: ${err instanceof Error ? err.message : String(err)}`)
    }

    const task: ExecuteTaskParams['task'] = {
      task_id: syntheticTaskId,
      task_title: taskTitle,
      priority: 'normal',
    }

    const taskOrigin: TaskOrigin = {
      channel_id: channelId,
      session_id: sessionId,
      friend_id: senderFriend.id,
      session_type: isGroup ? 'group' : 'private',
    }

    const placeholderEndpoint = { module_id: '', port: 0, host: 'localhost' }
    const context: WorkerAgentContext = {
      task_origin: taskOrigin,
      sender_friend: senderFriend,
      memory_permissions: memoryPermissions,
      resolved_permissions: resolvedPermissions,
      trigger_messages: messages as ChannelMessage[],
      recent_messages: frontContext.recent_messages ?? [],
      short_term_memories: [],
      long_term_memories: [],
      available_tools: [],
      admin_endpoint: placeholderEndpoint,
      memory_endpoint: placeholderEndpoint,
      channel_endpoints: [],
      time_windows: frontContext.time_windows,
      scene_profile: frontContext.scene_profile,
    }

    // 提前 set 到 activeTasks —— 让下一批 dispatcher fetchActiveTasks 立即可见。
    // runWorkerLoop 入口已 idempotent，会复用本 taskState。
    this.activeTasks.set(syntheticTaskId, {
      taskId: syntheticTaskId,
      startedAt: new Date().toISOString(),
      title: taskTitle,
      triggerType: 'message',
      abortController: new AbortController(),
      pendingHumanMessages: [],
      taskOrigin,
      todoStore: new TodoStore(),
      outboundBuffer: [],
      activeAuditId: undefined,
      activeAsyncSubagentIds: new Set<string>(),
      everSentMessage: false,
      humanInputEpoch: 0,
      everBufferedMessage: false,
      silentNoDeliveryRetries: 0,
    })

    return { taskId: syntheticTaskId, registered, task, context, taskTitle }
  }

  /**
   * Trigger 流的异步段：buildTriggerUserPrompt → runWorkerLoop → finalizeTask。
   * 由 SessionLane handler 调 spawn 时 void 化（fire-and-forget）。
   * 内部已 try/catch，异常自己写 trace + log，不抛回上游。
   *
   * Spec: 2026-05-20-session-lane-dispatcher-design.md §3.3
   */
  async runTriggerWorkerLoop(
    params: ExecuteTriggerMessageParams,
    pre: Awaited<ReturnType<AgentHandler['registerTriggerAndActivate']>>,
    traceCallback?: TraceCallback,
    traceContext?: WorkerTraceContext,
  ): Promise<ExecuteTriggerMessageResult> {
    const { taskId, registered, task, context } = pre

    const triggerText = await this.buildTriggerUserPrompt(params, taskId)

    // If VLM is supported, attach image blocks from the current trigger messages.
    // buildTriggerUserPrompt returns a plain string, so images must be injected here.
    let initialPrompt: string | ContentBlock[] = triggerText
    if (this.sdkEnv.supportsVision) {
      const imageBlocks = await resolveImageBlocks([...params.messages])
      if (imageBlocks.length > 0) {
        const strippedText = triggerText.replace(/\[图片: [^\]]*\]\n?/g, '')
        initialPrompt = [{ type: 'text' as const, text: strippedText }, ...imageBlocks]
      }
    }

    let sentMessage = false

    let loopResult: RunWorkerLoopResult
    try {
      loopResult = await this.runWorkerLoop(task, context, traceCallback, traceContext, {
        initialPrompt,
        extraTools: [],
        onAfterTurn: (event) => {
          for (const tc of event.toolCalls) {
            const bare = tc.name.replace(/^mcp__[^_]+__/, '')
            if (bare === 'send_message' || bare === 'send_private_message') {
              if (!tc.isError) {
                sentMessage = true
              }
            }
          }
        },
      })
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      // 清理 activeTasks（runWorkerLoop 通常自己清，但本路径异常时兜底）
      this.activeTasks.delete(taskId)
      // loop 异常时不会走下方 finalizeTask——必须兜底把 admin 任务落到终态，
      // 否则任务卡 executing（master chat 状态卡依赖状态推送，会永久"执行中"）
      if (registered) {
        await this.transitionTaskStatus(taskId, 'failed', {
          result: { outcome: 'failed', finished_at: new Date().toISOString() },
        })
      }
      return {
        outcome: 'failed' as const,
        finalText: '',
        sentMessage,
        error: errMsg,
      }
    }

    const { engineResult } = loopResult

    if (registered) {
      const skipReflection = shouldSkipTaskReflection(engineResult)
      await this.finalizeTask(taskId, engineResult, context, { skipReflection })
    }

    return {
      outcome: engineResult.outcome,
      finalText: engineResult.finalText ?? '',
      sentMessage,
      ...(engineResult.exitToolCall ? { exitToolCall: engineResult.exitToolCall } : {}),
      ...(engineResult.error ? { error: engineResult.error } : {}),
    }
  }

  /**
   * 薄壳兼容入口：内部顺序调 registerTriggerAndActivate + runTriggerWorkerLoop。
   *
   * 与 executeTask 的区别：
   * - executeTask 处理 admin 已注册的 task（带 task_id）
   * - executeTriggerMessage 处理新触发消息，loop 自然结束（worker 端已无 supplement/silent 早退工具）
   *
   * Caller（unified-agent）根据 result.exitToolCall 自行 dispatch：
   * - exitToolCall === undefined → loop 自然结束（agent 已通过 send_message 工具回复人类，或没回复）
   * - 其他 exitsLoop 工具（如 submit_audit_result）由对应专用 caller 处理
   *
   * 新代码（SessionLane handler）应直接调 register + run 分步接口。
   * Spec: 2026-05-20-session-lane-dispatcher-design.md §3.3 §7
   *
   * @deprecated 调用方应直接调 registerTriggerAndActivate + runTriggerWorkerLoop。
   *             本薄壳仅为过渡兼容，预计在 SessionLane 完整落地后（Task 7/8）删除。
   */
  async executeTriggerMessage(
    params: ExecuteTriggerMessageParams,
    traceCallback?: TraceCallback,
    traceContext?: WorkerTraceContext,
  ): Promise<ExecuteTriggerMessageResult> {
    const pre = await this.registerTriggerAndActivate(params)
    return this.runTriggerWorkerLoop(params, pre, traceCallback, traceContext)
  }

  /**
   * 构造 trigger 场景的 user prompt。
   *
   * - 删除末尾 "## 指令" 段（工具 schema 自解释）
   * - 尾部提醒：用 send_message 工具回复（含 channel_id / session_id）
   * - 场景画像从 frontContext 读取（已在 system prompt 里，此处不再重复渲染）
   * - 不注入 supplement / silent 决策提示——dispatcher 在 spawn 前已做完
   */
  private async buildTriggerUserPrompt(params: ExecuteTriggerMessageParams, currentTaskId: TaskId): Promise<string> {
    const { messages: triggerMessages, activeTasks, isGroup, senderFriend, channelId, sessionId, frontContext } = params
    const parts: string[] = []
    const timezone = this.getTimezone()
    const now = new Date()
    const recentMessages = frontContext.recent_messages ?? []
    const sessionType: 'private' | 'group' = isGroup ? 'group' : 'private'
    const identityResolver = (msg: ChannelMessage) =>
      resolveSenderIdentity({
        msg,
        senderFriend,
        crabDisplayName: frontContext.crab_display_name,
        isGroup,
      })

    // 合并 recent + trigger 单段时间线（spec 2026-06-04 §3）。
    // 协议语义：recent_messages 是触发前的本 session 历史；triggerMessages 是当前触发批次
    // （含 dispatcher immediate_reply 已注入 recent_messages 末尾，时间线天然自洽）。
    // dedupe by platform_message_id 防御重叠；稳定排序保证同 timestamp 时 recent 在前。
    const seen = new Set<string>()
    const allMessages: ChannelMessage[] = []
    for (const m of [...recentMessages, ...triggerMessages]) {
      if (seen.has(m.platform_message_id)) continue
      seen.add(m.platform_message_id)
      allMessages.push(m)
    }
    allMessages.sort((a, b) => (a.platform_timestamp ?? '').localeCompare(b.platform_timestamp ?? ''))

    // 引用消息预拉：避免 helper 同步无 I/O 限制。命中后嵌套渲染 <quoted_message>，
    // 未命中只输出 reply_to / quote 属性，agent 仍可调 get_message 兜底。
    const quotedMessages = this.deps
      ? await prefetchQuotedMessages(
          allMessages,
          recentMessages,
          channelId,
          sessionId,
          sessionType,
          {
            rpcClient: this.deps.rpcClient,
            moduleId: this.deps.moduleId,
            resolveChannelPort: this.deps.resolveChannelPort,
          },
          identityResolver,
        )
      : new Map<string, QuotedMessageEntry>()

    parts.push(`当前时间: ${formatNow(timezone, now)}`)
    parts.push('')

    // ── 对话场景 ──
    parts.push('## 对话场景')
    if (isGroup) {
      const session = triggerMessages[0]?.session
      parts.push(`- 类型: 群聊`)
      parts.push(`- 对话对象: ${session?.session_id ?? sessionId}`)
      parts.push(`- 对话对象 ID: group:${session?.channel_id ?? channelId}:${session?.session_id ?? sessionId}`)
    } else {
      parts.push(`- 类型: 私聊`)
      parts.push(`- 对话对象: ${senderFriend.display_name}`)
      parts.push(`- 对话对象 ID: friend:${senderFriend.id}`)
      parts.push(`- 对话对象身份: ${senderFriend.permission}`)
    }

    // ── IM 渠道（send_message 工具需要这些 ID）──
    parts.push('\n## IM 渠道')
    parts.push(`- channel: ${channelId}`)
    parts.push(`- session: ${sessionId}`)
    if (frontContext.crab_display_name) {
      parts.push(`- 你在该渠道的昵称: ${frontContext.crab_display_name}`)
    }
    if (frontContext.crab_self_handle) {
      // 群里可能挂多个 crabot 实例：消息正文同时 @ 多个 bot 时，只有显式给出
      // 自身 handle，LLM 才能判断"哪个 @ 是发给我的"，否则就只能瞎猜。
      parts.push(`- 你在该渠道的 @handle: ${frontContext.crab_self_handle}（消息正文里出现这个字符串才是 @ 你；其它 @xxx 是发给别人的）`)
    }

    // ── 活跃任务（三分类）+ SELF marker
    parts.push(...renderActiveTasksSection({
      activeTasks,
      currentTaskId,
      currentChannel: triggerMessages[0]?.session?.channel_id ?? channelId,
      currentSession: triggerMessages[0]?.session?.session_id ?? sessionId,
      isMaster: senderFriend.permission === 'master',
      isGroup,
      timezone,
      now,
    }))

    // ── 会话历史（单段时间线：recent + trigger 合并按 timestamp 排序）──
    const recentHours = frontContext.time_windows.recent_messages_window_hours
    const recentSinceLabel = formatChannelMessageTime(
      new Date(now.getTime() - recentHours * 3600 * 1000).toISOString(),
      timezone,
      now,
    )
    const triggerIds = new Set(triggerMessages.map(m => m.platform_message_id))
    if (allMessages.length > 0) {
      parts.push(`\n## 会话历史（共 ${allMessages.length} 条，含触发消息；当前 session 最近 ${recentHours} 小时 = ${recentSinceLabel} 之后）`)
      const total = allMessages.length
      for (let i = 0; i < total; i++) {
        // 阶梯式截断 + trigger 批次本身不截断（trigger 是当前消息，整条都要看到）
        const distFromEnd = total - 1 - i
        const msg = allMessages[i]
        const isTrigger = triggerIds.has(msg.platform_message_id)
        const maxLen = isTrigger ? 2000 : (distFromEnd < 3 ? 2000 : distFromEnd < 10 ? 600 : 300)
        parts.push(formatChannelMessageLine(msg, {
          timezone, now, maxLen,
          identity: identityResolver(msg),
          quotedMessages,
        }))
      }
    } else {
      parts.push(`\n## 会话历史`)
      parts.push(`过去 ${recentHours} 小时本会话无消息。`)
    }

    // ── 行动提醒 ──
    parts.push(`\n## 行动提醒`)
    parts.push(`- 给人类回复用 \`send_message\` 工具（channel_id="${channelId}"，session_id="${sessionId}"）；最终交付也用 intent="info"，发完直接 end_turn。`)

    return parts.join('\n')
  }

  /**
   * trigger 路径超期那一刻把任务注册到 admin task 表，让后续 trigger 能通过
   * list_tasks 拿到这条 in-flight 任务、走 supplement 通道。
   *
   * 失败 best-effort：admin 不可用时 log + 继续，本 trigger 期间 supplement 通道失效，
   * 主流程继续。finalize 时调 update_task_status / update_task_outcome 会拿到
   * NOT_FOUND，由 bestEffortRpc 吞掉，不需要 register-success flag。
   *
   * Spec: crabot-docs/superpowers/specs/2026-05-18-unified-loop-cleanup-design.md §4
   */
  private async registerTriggerTaskToAdmin(params: {
    syntheticTaskId: string
    taskTitle: string
    channelId: string
    sessionId: string
    senderFriendId: string
    /**
     * 触发消息的原文。admin handleCreateTask 把它写入 task.messages[0]（role='human'）。
     * spec 2026-06-09-task-trace-tool-unification.md §4.2: 替代旧 task.description 字段，
     * 作为"按聊天细节词查找已结束 task"的命中字段；同时给 worker 启动时提供完整 context。
     */
    triggerMessageContent: string
    /** 触发消息的平台 msg_id，写入 messages[0].source.platform_message_id，便于回溯。 */
    triggerPlatformMessageId?: string
  }): Promise<void> {
    if (!this.deps?.getAdminPort || !this.deps.rpcClient) {
      log(`registerTriggerTaskToAdmin: deps missing, skipping`)
      return
    }
    const adminPort = await this.deps.getAdminPort()
    await this.deps.rpcClient.call(adminPort, 'create_task', {
      id: params.syntheticTaskId,
      title: params.taskTitle,
      source: {
        origin: 'human',
        channel_id: params.channelId,
        session_id: params.sessionId,
        friend_id: params.senderFriendId,
        trigger_type: 'message',
      },
      priority: 'normal',
      initial_message: {
        content: params.triggerMessageContent,
        role: 'human',
        source: {
          channel_id: params.channelId,
          session_id: params.sessionId,
          friend_id: params.senderFriendId,
          ...(params.triggerPlatformMessageId ? { platform_message_id: params.triggerPlatformMessageId } : {}),
        },
      },
    }, this.deps.moduleId)

    // create_task 默认建在 pending；trigger 路径必须立即推到 executing 与 worker 内存状态对齐：
    // ① 让后续 ask_human 的 executing→waiting_human transition 合法（否则 admin 状态机拒）
    // ② 让 finalizeTask 的 executing→completed/failed transition 合法（否则 bestEffortRpc 静默吞错、admin 任务永远 pending → phantom 累积）
    // 两步 transition 是 best-effort：失败只 log 不抛，主流程继续——task 已存在不必回滚 create。
    for (const status of ['planning', 'executing'] as const) {
      try {
        await this.deps.rpcClient.call(adminPort, 'update_task_status', {
          task_id: params.syntheticTaskId,
          status,
        }, this.deps.moduleId)
      } catch (err) {
        log(`registerTriggerTaskToAdmin: transition to ${status} failed (continuing): ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    }
  }

  /**
   * Engine 主 loop 结束后的收尾。对用户面"任务结束"瞬间 = update_task_status('completed')
   * 落盘那一刻；之后跑反思补轮（对 supplement 通道关闭）；最后写短期 + 长期记忆。
   *
   * 失败容忍：reflector / memory 任一步抛错都不回滚 task 状态——用户视角下任务已完成，
   * lesson 质量降级是可接受的二阶损失。
   *
   * opts.skipReflection（快答 / 早退路径）：跳过 reflectFn 的 LLM 调用，用 finalText 兜底
   * 当 outcome_brief；但 status 切换 / humanQueue drain / outcome 落地仍然要做——不可省，
   * 否则 admin task 永远 pending 变 phantom（这是 register/finalize 不配对 bug 的修复点）。
   */
  private async finalizeTask(
    taskId: TaskId,
    engineResult: EngineResult,
    context: import('../types.js').WorkerAgentContext,
    opts: { skipReflection?: boolean } = {},
  ): Promise<void> {
    if (!this.deps?.getAdminPort) {
      log(`finalize: getAdminPort missing, skipping admin patch + reflector`)
      return
    }
    const adminPort = await this.deps.getAdminPort()
    // 只有 outcome='completed' 才算"任务正常结束"，其他（failed/max_turns/aborted）均归入 'failed'。
    const finalStatus = engineResult.outcome === 'completed' ? 'completed' : 'failed'
    const finishedAt = new Date().toISOString()

    // SSOT 重整后走 transitionTaskStatus（含智能恢复：waiting_human → executing → terminal）。
    // 仍 fire-and-forget 容忍——拒绝时已 log [task-status-drift]，由 reconcileTasksAgainstTraces 兜底。
    const ok = await this.transitionTaskStatus(taskId, finalStatus, {
      result: { outcome: finalStatus, finished_at: finishedAt },
    })
    if (!ok) {
      log(`finalize: task=${taskId} status drift unrecoverable, expecting reconciliation to fix later`)
    }

    const humanQueue = this.humanQueues.get(taskId)
    if (humanQueue) {
      humanQueue.drainPending()
      humanQueue.clearBarrier()
    }

    // 失败路径：跳过反思补轮（LLM 已脱轨，再让它反思价值低且容易乱编），用 engine.error 当兜底 brief
    if (finalStatus === 'failed') {
      // max_turns 元信息独立 prefix，防被 finalText（可能是中途产出的几百字）覆盖——
      // 与 subagent trace tag 同 pattern；admin UI / master 通知都要能一眼看出"是触顶不是异常"。
      const maxTurnsTag = engineResult.outcome === 'max_turns'
        ? `[max_turns reached after ${engineResult.totalTurns} turns]`
        : ''
      const baseBrief = (engineResult.error ?? engineResult.finalText ?? '任务失败').slice(0, 200)
      const failureBrief = maxTurnsTag
        ? `${maxTurnsTag} ${baseBrief}`.slice(0, 400)
        : baseBrief
      await this.writeOutcome(taskId, adminPort, 'failed', failureBrief, [], context)
      // 通知 master 的两类 case：
      // 1) engine 主动抛错（outcome='failed' + error）：原样回传接口错
      // 2) max_turns 触顶：告知任务因轮次上限被截断，让 master 决定是否拆任务 / 调整
      //    （此前 max_turns 沉默失败，master 只能去 admin UI 才能看到，体验差）
      const shouldNotify = context.task_origin && context.sender_friend
      if (shouldNotify && engineResult.outcome === 'failed' && engineResult.error) {
        const text = `大模型接口出错：${engineResult.error}`.slice(0, 1500)
        await this.sendToUser(context.task_origin!, text)
      } else if (shouldNotify && engineResult.outcome === 'max_turns') {
        const tail = engineResult.finalText ? `\n\n最后一段输出：${engineResult.finalText.slice(0, 300)}` : ''
        const text = `任务因 max_turns 截断（跑了 ${engineResult.totalTurns} 轮仍未完成）。` +
          `建议把任务拆小后再派，或在 admin UI 调高该任务对应 worker 的 max_turns。${tail}`
        await this.sendToUser(context.task_origin!, text.slice(0, 1500))
      }
      return
    }

    // completed 路径：reflectFn 内部已有 retry + fallback 不抛错；这层 try 兜的是 LLM 不可达
    // / adapter 异常等外层错误，构造 fallback 反思继续写入，保证 outcome_brief 不留空。
    //
    // skipReflection：快答 / 早退路径跳过 reflectFn 的 LLM 调用（spec §2.4 不反思），
    // 但仍走 writeOutcome 把 finalText 当 brief 写入——保留 outcome 落地与 status 配对。
    let reflection: Awaited<ReturnType<typeof reflectStructuredOutcome>>
    if (opts.skipReflection) {
      reflection = {
        outcome_brief: engineResult.finalText.slice(0, 200),
        process_highlights: [],
        retries: 0,
        fellBackToLastText: true,
      }
      log(`finalize: skipReflection (快答/早退) — using lastAssistantText brief`)
    } else {
      try {
        const reflectFn = this.deps.reflectFn ?? reflectStructuredOutcome
        reflection = await reflectFn({
          messages: engineResult.finalMessages,
          adapter: adapterFromSdkEnv(this.sdkEnv),
          model: this.sdkEnv.modelId,
          lastAssistantText: engineResult.finalText,
        })
        log(`finalize: reflection produced (retries=${reflection.retries}, fallback=${reflection.fellBackToLastText})`)
      } catch (err) {
        log(`finalize: reflectFn threw, using lastAssistantText fallback: ${err instanceof Error ? err.message : String(err)}`)
        reflection = {
          outcome_brief: engineResult.finalText.slice(0, 200),
          process_highlights: [],
          retries: 0,
          fellBackToLastText: true,
        }
      }
    }

    await this.writeOutcome(taskId, adminPort, 'completed', reflection.outcome_brief, reflection.process_highlights, context)
  }

  /**
   * 把 outcome_brief / process_highlights 同时落到 admin（update_task_outcome）和短期/长期记忆。
   * RPC 失败 best-effort（log + 继续）；memory write 在 finalizeMemoryWrite 里也是 fire-and-forget。
   */
  private async writeOutcome(
    taskId: TaskId,
    adminPort: number,
    outcome: 'completed' | 'failed',
    outcomeBrief: string,
    processHighlights: readonly string[],
    context: import('../types.js').WorkerAgentContext,
  ): Promise<void> {
    await this.bestEffortRpc(adminPort, 'update_task_outcome', {
      task_id: taskId,
      outcome_brief: outcomeBrief,
      process_highlights: processHighlights,
    }, 'update_task_outcome')
    this.finalizeMemoryWrite(taskId, { outcome, outcome_brief: outcomeBrief, process_highlights: processHighlights }, context)
  }

  /** finalize 阶段调 admin RPC 的 best-effort 包装：失败只 log 不抛，让后续步骤继续跑。 */
  private async bestEffortRpc(
    port: number,
    method: string,
    params: Record<string, unknown>,
    label: string,
  ): Promise<void> {
    if (!this.deps) return
    try {
      await this.deps.rpcClient.call(port, method, params, this.deps.moduleId)
    } catch (err) {
      log(`finalize: ${label} failed (continuing): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * agent → admin 切 task.status 的单点封装（SSOT 原则：admin tasks.json 是 task.status 权威，
   * agent 永远不直接 mutate 字段；spec: task/trace 状态同步 SSOT 重整 2026-06-09）。
   *
   * 智能恢复：admin 状态机表（task-state-machine.ts VALID_TRANSITIONS）某些 transition 非法（如
   * waiting_human → completed）。本 helper 检测到 INVALID_STATUS_TRANSITION 时，对终态目标自动
   * 先插一步 executing 中转：waiting_human → executing → target。这覆盖了 worker loop 在
   * ask_human 后 supplement 推回但 agent 漏 RPC、loop 结束 finalize 直接切 completed 被拒的经典 case。
   *
   * 返回 false 表示拒绝且无法恢复——调用方按需 log，由 admin reconcileTasksAgainstTraces 兜底修复。
   *
   * @param taskId  任务 id
   * @param target  目标 status
   * @param opts    pending_question（waiting_human 时用）/ result（终态时用）
   * @returns true=切成功；false=拒绝且不可恢复，需 reconciliation 兜底
   */
  private async transitionTaskStatus(
    taskId: TaskId,
    target: 'executing' | 'waiting_human' | 'completed' | 'failed' | 'cancelled',
    opts?: { pendingQuestion?: string; result?: unknown },
  ): Promise<boolean> {
    if (!this.deps?.getAdminPort || !this.deps.rpcClient) {
      log(`transitionTaskStatus(${taskId}, ${target}): deps missing, skipping`)
      return false
    }
    const adminPort = await this.deps.getAdminPort()
    const moduleId = this.deps.moduleId
    const rpcClient = this.deps.rpcClient

    const callOnce = async (status: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await rpcClient.call(adminPort, 'update_task_status', {
          task_id: taskId,
          status,
          ...(opts?.pendingQuestion !== undefined ? { pending_question: opts.pendingQuestion } : {}),
          ...(opts?.result !== undefined ? { result: opts.result } : {}),
        }, moduleId)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    const first = await callOnce(target)
    if (first.ok) return true

    // 智能恢复路径：终态目标被拒（典型场景 current=waiting_human → completed/failed 非法），
    // 先把 task 拉回 executing，再切到目标态。
    const isTerminalTarget = target === 'completed' || target === 'failed' || target === 'cancelled'
    if (first.error.includes('INVALID_STATUS_TRANSITION') && isTerminalTarget) {
      log(`transitionTaskStatus(${taskId}, ${target}) rejected (${first.error}); trying executing → ${target}`)
      const mid = await callOnce('executing')
      if (mid.ok) {
        const retry = await callOnce(target)
        if (retry.ok) return true
        log(`transitionTaskStatus(${taskId}, ${target}) retry after executing failed: ${retry.error}`)
      } else {
        log(`transitionTaskStatus(${taskId}) intermediate executing also rejected: ${mid.error}`)
      }
    }

    // 拒绝且无法恢复 —— admin tasks.json 与 trace/agent 真实状态 drift，等 reconciliation 修
    log(`[task-status-drift] task=${taskId} target=${target} unrecoverable error=${first.error}`)
    return false
  }

  /**
   * 任务结束（成功 / 失败）后写短期记忆 + 长期记忆候选。
   * - completed：reflection 来自 reflectFn 的真实总结
   * - failed：reflection 来自 engine.error 截断兜底
   * 两个写入均 fire-and-forget：失败只打日志，不影响 task 状态。
   */
  private finalizeMemoryWrite(
    taskId: TaskId,
    reflection: {
      outcome: 'completed' | 'failed'
      outcome_brief: string
      process_highlights: readonly string[]
    },
    context: import('../types.js').WorkerAgentContext,
  ): void {
    if (!this.memoryWriter) return

    const taskOrigin = context.task_origin
    const channelId = taskOrigin?.channel_id ?? ''
    const sessionId = taskOrigin?.session_id ?? ''
    const friendName = context.sender_friend?.display_name ?? 'system'
    const friendId = context.sender_friend?.id ?? ''
    const visibility = context.memory_permissions?.write_visibility ?? 'internal'
    const scopes = context.memory_permissions?.write_scopes ?? []

    const taskTitle = this.activeTasks.get(taskId)?.title ?? taskId
    const outcomeLabel = reflection.outcome === 'completed' ? '完成' : '失败'

    this.memoryWriter.writeTaskFinished({
      task_id: taskId,
      task_title: taskTitle,
      outcome: reflection.outcome,
      outcome_brief: reflection.outcome_brief,
      process_highlights: [...reflection.process_highlights],
      friend_name: friendName,
      friend_id: friendId,
      channel_id: channelId,
      session_id: sessionId,
      visibility,
      scopes,
    }).catch((err) => {
      log(`finalizeMemoryWrite: writeTaskFinished failed: ${err instanceof Error ? err.message : String(err)}`)
    })

    this.memoryWriter.quickCapture({
      type: 'lesson',
      brief: `${taskTitle} → ${reflection.outcome_brief}`.slice(0, 80),
      content: `任务 ${taskId}（${taskTitle}）${outcomeLabel}：${reflection.outcome_brief}`,
      source_ref: { type: 'conversation', task_id: taskId, channel_id: channelId, session_id: sessionId },
      entities: [],
      tags: [`task_outcome:${reflection.outcome}`],
      importance_factors: {
        proximity: 0.6,
        surprisal: reflection.outcome === 'failed' ? 0.8 : 0.4,
        entity_priority: 0.5,
        unambiguity: 0.6,
      },
    }).catch(() => undefined)
  }

  /**
   * Map EngineResult to ExecuteTaskResult.
   *
   * 任务完成内容已由 worker 通过 send_message 主动发出，且 outcome_brief / process_highlights
   * 已写入 admin（update_task_outcome）。dispatcher 不再需要 summary / final_reply。
   */
  private mapEngineResult(
    taskId: TaskId,
    result: EngineResult,
  ): ExecuteTaskResult {
    if (result.outcome === 'aborted') {
      return { task_id: taskId, outcome: 'failed', error: '任务被取消' }
    }
    if (result.outcome === 'failed' || result.outcome === 'max_turns') {
      return { task_id: taskId, outcome: 'failed', error: result.error ?? 'unknown' }
    }
    return { task_id: taskId, outcome: 'completed' }
  }

  /**
   * goal mode 是否启用：admin extra 开关 + scheduled 任务硬关。
   * 与 buildSystemPrompt / endTurnGate / supplement 文案 variant 共用同一口径。
   * triggerType 用 string | undefined 接受 task.source.trigger_type 和 taskState.triggerType
   * 两种不同 union，统一只比 'scheduled' 字面。
   */
  private isGoalModeEnabled(triggerType: string | undefined): boolean {
    return this.extra?.goal_mode_enabled !== false && triggerType !== 'scheduled'
  }

  /**
   * spec 2026-06-09 §4.2 + spec A §4.13.6 invariant #3 + §4.13.7 Revision 2026-06-09 第 2 段:
   * onDispatched callback 叠加 effect — 把出站消息写入 admin task.messages（role='agent'）。
   * fire-and-forget：失败只 log，不影响 dispatch 主路径。
   *
   * 跟 deliverHumanResponse 里的 supplement 写入对称：人类入站 role='human'，agent 出站 role='agent'。
   *
   * 字段真值：
   *  - agent_intent 取 entry.intent（'info' | 'ask_human'）—— spec §4.13.7 Revision 后 entry.intent
   *    已是真值，不再固定 'info'
   *  - source.platform_message_id 取 sendResult.platform_message_id —— quote/引用回溯锚点
   *  - content 序列化媒体（[image/file: filename]），跟 deliverHumanResponse 的 formatMessageContent 对称
   */
  private appendAgentMessageBestEffort(
    taskId: string,
    entry: OutboundBufferEntry,
    sendResult: OutboundSendResult,
  ): void {
    if (!this.deps?.getAdminPort || !this.deps.rpcClient) return
    const moduleId = this.deps.moduleId
    const getAdminPortFn = this.deps.getAdminPort
    const rpcClient = this.deps.rpcClient

    // 序列化媒体：跟人类入站 formatMessageContent 概念对称——文本部分 + [type: name] 标签
    const mediaTag = entry.media_url
      ? `\n[${entry.content_type ?? 'media'}: ${entry.filename ?? entry.media_url}]`
      : entry.file_path
        ? `\n[${entry.content_type ?? 'file'}: ${entry.filename ?? entry.file_path}]`
        : ''
    const content = entry.content + mediaTag

    void (async () => {
      try {
        const adminPort = await getAdminPortFn()
        await rpcClient.call(adminPort, 'append_message', {
          task_id: taskId,
          role: 'agent',
          content,
          source: {
            channel_id: entry.channel_id,
            session_id: entry.session_id,
            platform_message_id: sendResult.platform_message_id,
          },
          agent_intent: entry.intent,
        }, moduleId)
      } catch (err) {
        log(`[onDispatched] append_message admin RPC failed (non-fatal) task=${taskId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    })()
  }

  deliverHumanResponse(taskId: TaskId, messages: ChannelMessage[]): void {
    const taskState = this.activeTasks.get(taskId)
    if (!taskState) {
      log(`[supplement] deliverHumanResponse: task ${taskId} NOT FOUND. activeTasks keys: [${Array.from(this.activeTasks.keys()).join(', ')}]`)
      throw new Error(`Task not found: ${taskId}`)
    }

    log(`[supplement] deliverHumanResponse: queued ${messages.length} messages for task ${taskId}`)

    // 渲染含媒体的消息（文件名 / 图片 url）—— 与 dispatcher buildUserPrompt 对齐
    const supplement = messages
      .map(m => formatMessageContent(m))
      .filter(t => t !== EMPTY_MESSAGE_PLACEHOLDER)
      .join('\n')

    if (supplement) {
      taskState.humanInputEpoch++
      const humanQueue = this.humanQueues.get(taskId)
      if (humanQueue) {
        const template = this.isGoalModeEnabled(taskState.triggerType)
          ? SUPPLEMENT_INJECTION_TEMPLATE_GOAL
          : SUPPLEMENT_INJECTION_TEMPLATE_BASIC
        humanQueue.push(template.replace('{supplement_content}', supplement))
        log(`[supplement] pushed to humanMessageQueue for task ${taskId}`)
      }
      // 发放"改目标券"：真实人类 supplement 到达 = 授权 worker 重设一次 goal（上限 1，不叠加）。
      taskState.goalRevisionUnlocked = true
    }

    // Also store in pendingHumanMessages for backward compat with task state
    taskState.pendingHumanMessages.push(...messages)

    // SSOT: admin tasks.json 是 task.status 权威。supplement 到达后必须把 admin 那侧也切回
    // executing，否则 task 永远卡在 waiting_human：worker loop 结束 finalize 调
    // update_task_status('completed') 会被 admin 状态机拒（waiting_human → completed 非法），
    // 导致 trace=completed 但 task=waiting_human 永久 drift（spec：task/trace 状态同步 SSOT 重整 2026-06-09）。
    // fire-and-forget：失败由 admin reconcileTasksAgainstTraces 周期对账兜底，不阻塞 supplement 投递。
    void this.transitionTaskStatus(taskId, 'executing')

    // spec 2026-06-09-task-trace-tool-unification.md §4.2:
    // 把人类对话流真值写入 admin task.messages（role='human'）。
    // fire-and-forget：humanQueue 已 push 是主路径；admin RPC 写失败只 log，不影响 supplement 投递。
    // 数据一致性影响：失败时 find_task 搜不到这条 supplement 内容，无 invariant 破坏。
    if (this.deps?.getAdminPort && this.deps.rpcClient) {
      const moduleId = this.deps.moduleId
      const getAdminPortFn = this.deps.getAdminPort
      const rpcClient = this.deps.rpcClient
      void (async () => {
        try {
          const adminPort = await getAdminPortFn()
          for (const m of messages) {
            // 用 formatMessageContent 保留媒体细节（[image: x.jpg] / [file: path] 等结构化字符串），
            // 影响 find_task search 命中率。EMPTY_MESSAGE_PLACEHOLDER 跳过空 message 不写。
            const content = formatMessageContent(m)
            if (content === EMPTY_MESSAGE_PLACEHOLDER) continue
            await rpcClient.call(adminPort, 'append_message', {
              task_id: taskId,
              role: 'human',
              content,
              source: {
                channel_id: m.session.channel_id,
                session_id: m.session.session_id,
                ...(m.sender.friend_id ? { friend_id: m.sender.friend_id } : {}),
                platform_message_id: m.platform_message_id,
              },
            }, moduleId)
          }
        } catch (err) {
          log(`[supplement] append_message admin RPC failed (non-fatal) task=${taskId}: ${err instanceof Error ? err.message : String(err)}`)
        }
      })()
    }
  }

  cancelTask(taskId: TaskId, _reason: string): void {
    // SSOT: 不再 mutate agent 内存里的 task status —— admin 那侧的 cancel_task RPC 已经
    // 把 tasks.json 改成 'cancelled'，本方法只负责 abort 当前 worker loop。
    const taskState = this.activeTasks.get(taskId)
    if (taskState) {
      taskState.abortController.abort()
    }
  }

  /**
   * 优雅停机时对所有活跃 worker task 补一次 resume checkpoint flush。
   * 覆盖 per-turn flush 的"最后一 turn 到 onStop 之间的窗口"，让 crabot stop 场景也无损。
   * 由 UnifiedAgent.onStop 调用。
   */
  flushActiveCheckpoints(): void {
    for (const [taskId, taskState] of this.activeTasks) {
      const traceId = taskState.activeTraceId
      const traceStore = this.taskTraceStores.get(taskId)
      const messagesRef = taskState.messagesRef
      if (!traceId || !traceStore || !messagesRef) continue
      try {
        traceStore.flushWorkerCheckpoint(taskId, traceId, {
          agent_version: AGENT_VERSION,
          system_prompt: messagesRef.systemPrompt ?? '',
          messages: messagesRef.current.slice() as import('../engine/types.js').EngineMessage[],
          worker_state: {
            todo_items: [...taskState.todoStore.list()],
            goal_revision_unlocked: taskState.goalRevisionUnlocked,
            last_delivered_info_epoch: taskState.lastDeliveredInfoEpoch,
            ...(taskState.cwd !== undefined ? { cwd: taskState.cwd } : {}),
          },
          ...(taskState.resumeWorkerContext ? { worker_context: taskState.resumeWorkerContext } : {}),
        })
      } catch (err) {
        // best-effort，停机路径不抛
        const msg = err instanceof Error ? err.message : String(err)
        log(`[flushActiveCheckpoints] task=${taskId} failed (non-fatal): ${msg}`)
      }
    }
  }

  getActiveTaskCount(): number { return this.activeTasks.size }

  hasActiveTask(taskId: TaskId): boolean {
    return this.activeTasks.has(taskId)
  }

  setBarrierForTask(taskId: TaskId, timeoutMs: number): boolean {
    const queue = this.humanQueues.get(taskId)
    if (!queue) return false
    // 已挂 barrier 说明该 task 已被 park（如 ask_human 的 24h barrier）。
    // setupBarriers 的「按住正在干活的 worker」是给无 barrier 的运行态 task 用的；
    // 对已 park 的 task 再 setBarrier 会因 setBarrier 内部 clearBarrier 而误唤醒它的
    // waitBarrier 等待者，让它空跑一轮 end_turn。已 park 的 task 只应由发给它的
    // supplement（pushSupplement → push 带内容）唤醒，这里跳过。
    if (queue.hasBarrier) return false
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

  /** 媒体后台下载完成事件 → 唤醒等待中的 worker。纯系统 push（不触发 goal 券 / human 语义）。 */
  wakeForMediaDownload(taskId: TaskId, note: string): void {
    this.humanQueues.get(taskId)?.push(`[系统] ${note}`)
  }

  /**
   * 临时页面（tmp-page）收到人类反馈 → 唤醒等待中的 owner worker。
   * spec: 2026-06-19-temp-interactive-page-design.md §5.2
   *
   * 两步（对两种挂法都成立，见 §5.2 表）：
   *   ① humanQueue.push(note)：同一套 barrier，无论 worker 用 ask_human 还是 wait_for_signal 挂起都唤醒。
   *   ② transitionTaskStatus(taskId, 'executing')：把 ask_human 留下的 waiting_human 切回 executing；
   *      wait_for_signal 场景本就 executing，是 no-op（transitionTaskStatus 自带幂等/智能恢复）。
   * fire-and-forget：status 切换失败由 admin reconciliation 兜底，不阻塞反馈唤醒（反馈已落盘 events.jsonl）。
   */
  wakeForPageFeedback(taskId: TaskId, note: string): void {
    this.humanQueues.get(taskId)?.push(note)
    void this.transitionTaskStatus(taskId, 'executing')
  }

  getActiveTasksForQuery(): Array<{ task_id: string; started_at: string; title?: string }> {
    // status 字段已从 WorkerTaskState 删除（SSOT 重整 2026-06-09）：admin tasks.json 是 status 权威，
    // 调用方需要 status 自行从 admin 拉。本接口只暴露 agent 内存里的纯执行态字段。
    return Array.from(this.activeTasks.values()).map(t => ({
      task_id: t.taskId,
      started_at: t.startedAt,
      title: t.title,
    }))
  }

  /**
   * 返回 agent 进程内 in-flight task 的轻量 summary，供 context-assembler union。
   * 携带 taskOrigin（channel_id / session_id）让调用方按 spec §3.2 做 session 过滤
   * （"当前 session 的活跃任务"——protocol-agent-v2.md §5.1 line 329）。
   * Spec: 2026-05-19-prefront-dispatcher-design.md §3.2
   */
  getInflightSnapshot(): ReadonlyArray<{
    task_id: string
    title: string
    trigger_type: 'message' | 'scheduled'
    source_channel_id?: string
    source_session_id?: string
    started_at?: string
  }> {
    const result: Array<{
      task_id: string
      title: string
      trigger_type: 'message' | 'scheduled'
      source_channel_id?: string
      source_session_id?: string
      started_at?: string
    }> = []
    for (const [taskId, state] of this.activeTasks) {
      result.push({
        task_id: taskId,
        title: state.title ?? taskId,
        trigger_type: state.triggerType ?? 'message',
        source_channel_id: state.taskOrigin?.channel_id,
        source_session_id: state.taskOrigin?.session_id,
        started_at: state.startedAt,
      })
    }
    return result
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

  /**
   * 直接执行 subagent 的核心 helper，被 makeRunSubAgent（delegate_task 路径）
   * 和 goal audit gate 路径（Task 7 引入的 runGoalAudit）共用。
   *
   * 与 makeRunSubAgent 的关系：makeRunSubAgent 只是把 deps 闭包包成 RunSubAgentFn 薄壳，
   * 实际执行（tool filter → prompt 装配 → adapter → sub-trace → forkEngine → 错误包装）
   * 全在这里。goal audit gate 可通过 traceSummaryPrefix/traceTaskType 定制 trace 显示
   * 而不需要复制粘贴这段逻辑。
   *
   * 返回值额外带 traceId，方便上层（如 goal audit）记录子 trace ID。
   * makeRunSubAgent 会把 traceId 摘掉再返回（RunSubAgentFn 类型不含此字段）。
   */
  private async runSubAgentDirect(
    subagent: SubAgentConfig,
    input: import('./delegate-task-tool.js').RunSubAgentInput,
    ctx: import('../engine/types.js').ToolCallContext,
    deps: {
      readonly parentTools: ReadonlyArray<import('../engine/types.js').ToolDefinition>
      readonly parentTaskId: string
      readonly callerLabel: string
      readonly humanQueue?: import('../engine/human-message-queue.js').HumanMessageQueue
      readonly permissionConfig?: import('../engine/types.js').ToolPermissionConfig
      readonly traceConfig?: SubAgentTraceConfig
      /** trace summary 前缀；缺省 `[${subagent.name}]`。goal_audit 路径传 `'[goal_audit]'`。 */
      readonly traceSummaryPrefix?: string
      /** trigger.task_type；缺省不设。goal_audit 路径传 `'goal_audit'`，Admin UI 用来标特殊样式。 */
      readonly traceTaskType?: string
      /** caller 注入的专属工具（如 audit 路径的 submit_audit_result），
       *  在 capability filter **之后** concat 进 subTools。这些工具不走 capability 体系，
       *  专属用法不污染通用过滤逻辑。 */
      readonly extraTools?: ReadonlyArray<import('../engine/types.js').ToolDefinition>
    },
  ): Promise<import('../engine/types.js').ToolCallResult & {
    readonly traceId?: string
    /** auditor 等系统侧 caller 用的 raw subagent output（裸 finalText，不被 JSON 包裹）。
     *  delegate_task 工具路径继续用 output（JSON 包了元信息）；runGoalAudit 等不要解 JSON。 */
    readonly rawOutput?: string
    /** exitsLoop 工具触发的早退判决：tool name + schema-enforced input。
     *  例：audit subagent 调 submit_audit_result(pass, failed_criteria, evidence)
     *  时直接拿到结构化判决，不必 regex parse free text。 */
    readonly exitToolCall?: { readonly name: string; readonly input: Record<string, unknown> }
    /** ForkEngineResult.outcome 顶层透出，让系统侧 caller（如 runGoalAudit）能
     *  在 isError=true 之外进一步区分 max_turns（截断）与 failed（异常）。
     *  catch 抛错路径不填（属于纯异常，按 unknown 走）。 */
    readonly outcome?: import('../engine/types.js').EngineResult['outcome']
  }> {
    // 1. filter parent tools by subagent capabilities (delegate_task always excluded by filter)
    const filteredSubTools = filterToolsForSubAgent(
      deps.parentTools,
      subagent.builtin_capabilities,
      subagent.allowed_mcp_server_ids,
      subagent.allowed_skill_ids,
    )
    // caller 注入的专属工具（如 audit 的 submit_audit_result）在 capability filter
    // 之后 concat，绕开 filter 的 unknown-default-deny 逻辑（这些工具不属于任何
    // capability group，本来就会被剔除）。
    const subTools = deps.extraTools
      ? [...filteredSubTools, ...deps.extraTools]
      : filteredSubTools

    // 2. assemble 5-section system prompt
    const systemPrompt = assembleSubAgentPrompt(subagent, {
      parentTaskId: deps.parentTaskId,
      callerLabel: deps.callerLabel,
    })

    // 3. build adapter from subagent's resolved model
    const subAdapter = adapterFromModel(subagent.model)

    // 4. resolve hook registry：lsp_diagnostics 预设（post-edit 诊断 push） + git 写操作 fence（按能力叠加）
    const wantsLspDiagnostics = subagent.hook_preset === 'lsp_diagnostics'
    const hookRegistry = createSubAgentHookRegistry({
      lspDiagnostics: wantsLspDiagnostics,
      gitWriteFence: subagent.allowed_mcp_server_ids.includes('git'),
    })
    // lspManager 仅 lsp-diagnostics 钩子需要；git-fence 不依赖它。
    const lspManager = wantsLspDiagnostics ? this.lspManager : undefined

    // 5. trace stitching: create sub-trace linked to parent trace
    const tc = deps.traceConfig
    let subTrace: AgentTrace | undefined
    let subTraceCallback: ((event: EngineTurnEvent) => void) | undefined

    if (tc) {
      // summary 前缀带 subagent name，让 Admin Traces 列表展开行一眼看出
      // "这是谁派的子任务" — 否则只能看见 task prompt 内容，分不清是哪个 subagent。
      // goal_audit 等定制路径可通过 deps.traceSummaryPrefix 覆盖。
      const taskPrompt = String(input.task).slice(0, 180)
      const summaryPrefix = deps.traceSummaryPrefix ?? `[${subagent.name}]`
      subTrace = tc.traceStore.startTrace({
        module_id: 'sub-agent',
        trigger: {
          type: 'sub_agent_call',
          summary: `${summaryPrefix} ${taskPrompt}`,
          ...(deps.traceTaskType ? { task_type: deps.traceTaskType } : {}),
        },
        parent_trace_id: tc.parentTraceId,
        parent_span_id: tc.parentSpanId,
        related_task_id: tc.relatedTaskId,
      })

      // onTurn fires post-hoc (after LLM + tools); back-date span timestamps
      // with engine-measured ms to keep the waterfall accurate.
      subTraceCallback = (event: EngineTurnEvent) => {
        const llmEndedAtMs =
          event.llmStartedAtMs !== undefined && event.llmCallMs !== undefined
            ? event.llmStartedAtMs + event.llmCallMs
            : undefined

        const llmSpan = tc.traceStore.startSpan(subTrace!.trace_id, {
          type: 'llm_call',
          details: {
            iteration: event.turnNumber,
            input_summary: `turn ${event.turnNumber}`,
          },
          ...(event.llmStartedAtMs !== undefined ? { started_at_ms: event.llmStartedAtMs } : {}),
        })

        for (const toolCall of event.toolCalls) {
          const toolEndedAtMs =
            toolCall.startedAtMs !== undefined && toolCall.durationMs !== undefined
              ? toolCall.startedAtMs + toolCall.durationMs
              : undefined

          const toolSpan = tc.traceStore.startSpan(subTrace!.trace_id, {
            type: 'tool_call',
            parent_span_id: llmSpan.span_id,
            details: {
              tool_name: toolCall.name,
              input_summary: JSON.stringify(toolCall.input ?? {}).slice(0, 200),
            },
            ...(toolCall.startedAtMs !== undefined ? { started_at_ms: toolCall.startedAtMs } : {}),
          })
          tc.traceStore.endSpan(
            subTrace!.trace_id,
            toolSpan.span_id,
            toolCall.isError ? 'failed' : 'completed',
            {
              output_summary: String(toolCall.output).slice(0, 500),
              error: toolCall.isError ? String(toolCall.output) : undefined,
            },
            toolEndedAtMs,
          )
        }

        tc.traceStore.endSpan(
          subTrace!.trace_id,
          llmSpan.span_id,
          'completed',
          {
            stop_reason: event.stopReason ?? undefined,
            output_summary: event.assistantText.slice(0, 200) || undefined,
            tool_calls_count: event.toolCalls.length > 0 ? event.toolCalls.length : undefined,
          },
          llmEndedAtMs,
        )
      }
    }

    // TODO(phase-2b): image_paths support for vision subagents
    try {
      const result = await forkEngine({
        prompt: input.task,
        adapter: subAdapter,
        model: subagent.model.model_id,
        systemPrompt,
        tools: subTools,
        maxTurns: subagent.max_turns,
        ...(subagent.model.max_tokens !== undefined ? { maxTokens: subagent.model.max_tokens } : {}),
        ...(input.context ? { parentContext: input.context } : {}),
        abortSignal: ctx.abortSignal,
        onTurn: subTraceCallback,
        supportsVision: subagent.model.supports_vision,
        hookRegistry,
        lspManager,
        permissionConfig: deps.permissionConfig,
      })

      // outcome 一并视为"非完成"的两个 case：failed（异常）+ max_turns（截断）。
      // exitToolCall 触发（exitsLoop 工具被调）= 业务终态，按 completed 处理。
      const isAbnormalExit =
        (result.outcome === 'failed' || result.outcome === 'max_turns') &&
        result.exitToolCall === undefined

      if (subTrace && tc) {
        const traceSummary = result.output.slice(0, 200) || result.error?.slice(0, 200) || ''
        // max_turns 的元信息独立维护，不被 partial output 覆盖——partial 可能有几十
        // turn 累出的文本，会顶掉 "max_turns reached" 字符串导致 trace 里分不清失败原因。
        const maxTurnsTag = result.outcome === 'max_turns'
          ? `[max_turns reached after ${result.totalTurns} turns]`
          : ''
        const baseError = isAbnormalExit
          ? (result.error?.slice(0, 200) || result.output.slice(0, 200) || undefined)
          : undefined
        const errorWithTag = maxTurnsTag
          ? (baseError ? `${maxTurnsTag} ${baseError}` : maxTurnsTag)
          : baseError
        tc.traceStore.endTrace(
          subTrace.trace_id,
          isAbnormalExit ? 'failed' : 'completed',
          {
            summary: traceSummary,
            error: errorWithTag,
          },
        )
      }

      if (isAbnormalExit) {
        const isMaxTurns = result.outcome === 'max_turns'
        const errSrc = result.error || (isMaxTurns ? undefined : result.output) || 'subagent failed without error message'
        const failure = buildSubAgentFailureOutput({
          errorSource: isMaxTurns ? new Error(`max_turns reached (${result.totalTurns} turns)`) : new Error(errSrc),
          subagentName: subagent.name,
          providerEndpoint: subagent.model.endpoint,
          model: subagent.model.model_id,
          ...(result.output ? { partialOutput: result.output } : {}),
          totalTurns: result.totalTurns,
          ...(subTrace ? { childTraceId: subTrace.trace_id } : {}),
          ...(isMaxTurns ? { kindOverride: 'max_turns' as const, stopReason: 'max_turns' as const } : { stopReason: 'failed' as const }),
        })
        return {
          output: JSON.stringify(failure),
          rawOutput: result.output,
          isError: true,
          outcome: result.outcome,
          ...(subTrace ? { traceId: subTrace.trace_id } : {}),
          ...(result.exitToolCall ? { exitToolCall: result.exitToolCall } : {}),
        }
      }

      return {
        // output 给 delegate_task 工具 caller (worker LLM) 看：JSON 包了 child_trace_id 等
        // 元信息，便于 worker 拼下一轮 prompt 追溯
        output: JSON.stringify({
          output: result.output,
          outcome: result.outcome,
          totalTurns: result.totalTurns,
          child_trace_id: subTrace?.trace_id,
        }),
        // rawOutput 给系统侧 caller（如 runGoalAudit）解 auditor 原始文本，不要解 JSON
        rawOutput: result.output,
        isError: false,
        outcome: result.outcome,
        ...(subTrace ? { traceId: subTrace.trace_id } : {}),
        // exitToolCall：sub-agent 通过 exitsLoop 工具早退时的结构化判决（如 audit
        // 的 submit_audit_result）。caller 优先用它而不是 parse free text。
        ...(result.exitToolCall ? { exitToolCall: result.exitToolCall } : {}),
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (subTrace && tc) {
        tc.traceStore.endTrace(subTrace.trace_id, 'failed', { summary: msg, error: msg })
      }
      const failure = buildSubAgentFailureOutput({
        errorSource: err,
        subagentName: subagent.name,
        providerEndpoint: subagent.model.endpoint,
        model: subagent.model.model_id,
        ...(subTrace ? { childTraceId: subTrace.trace_id } : {}),
      })
      return {
        output: JSON.stringify(failure),
        isError: true,
        ...(subTrace ? { traceId: subTrace.trace_id } : {}),
      }
    }
  }

  /**
   * Goal audit 入口：engine endTurnGate 在 worker end_turn 时调用。
   *
   * 流程：
   *  1. 拿 admin task → 验证 task.goal 存在
   *  2. 查 goal_auditor builtin from this.subAgents snapshot
   *  3. 用 buildAuditPrompt 拼输入（worker 不参与）
   *  4. 调 runSubAgentDirect 跑 auditor（独立 trace, task_type='goal_audit'）
   *  5. parseAuditReport 解析输出
   *  6. admin RPC append_task_goal_audit_entry 写历史
   *  7. pass → admin RPC complete_task_goal 同步标 complete
   *  8. 返回 AuditResult
   *
   * 注意：parentTools 传空 array——auditor 不继承 worker 工具集，
   * filterToolsForSubAgent 走 auditor 自己的 capability 过滤。
   * 没传 humanQueue / permissionConfig：auditor 是只读，不通讯。
   *
   * traceConfig 可选：caller（Task 8 crab-messaging）能拿到自己的 traceContext 时透传，
   * 让 audit subtree 挂到 worker 主 trace 下；缺省则跑无父 trace 的 standalone subagent，
   * auditTraceId 为空串。
   *
   * spec: 2026-05-23-goal-mode-design.md §7.2
   */
  async runGoalAudit(params: {
    readonly taskId: string
    readonly conversationLog: ReadonlyArray<ConversationEntry>
    readonly traceConfig?: SubAgentTraceConfig
    readonly abortSignal?: AbortSignal
    /** worker baseTools；auditor 的 capability filter（file_system+shell）在其上筛子集。
     *  缺省/空数组 = auditor 没有 Bash/Read/Grep 等工具，实测会回"环境没有工具"导致永远 fail。 */
    readonly parentTools?: ReadonlyArray<import('../engine/types.js').ToolDefinition>
    /** worker permissionConfig；缺省时 auditor 调 dangerous 工具（如 Bash）会被拒。 */
    readonly permissionConfig?: import('../engine/types.js').ToolPermissionConfig
  }): Promise<AuditResult> {
    if (!this.deps?.getAdminPort || !this.deps.rpcClient) {
      throw new Error('runGoalAudit: getAdminPort/rpcClient deps 缺失')
    }
    const adminPort = await this.deps.getAdminPort()
    const moduleId = this.deps.moduleId

    // 1. 拿 task + goal（用现有 RPC pattern）
    const taskResp = await this.deps.rpcClient.call<
      { task_id: string },
      { task: { id: string; goal?: GoalAuditTaskGoal } }
    >(adminPort, 'get_task', { task_id: params.taskId }, moduleId)
    const task = taskResp.task
    if (!task.goal) {
      throw new Error(
        `runGoalAudit: task ${params.taskId} has no goal; audit should not be triggered`,
      )
    }
    const goal = task.goal

    // 2. 拿 auditor 配置（snapshot 风格的 in-flight 不变 reference）
    const auditor = this.subAgents.find((s) => s.id === 'builtin-goal-auditor')
    if (!auditor) {
      throw new Error('runGoalAudit: goal_auditor subagent not configured')
    }

    // 3. 装输入（系统拼，worker 不插手）
    const promptText = buildAuditPrompt({
      goal,
      conversationLog: params.conversationLog,
      cwd: getWorkspaceDir(),
    })

    // 4. 跑 subagent（独立 trace, task_type='goal_audit'），注入 submit_audit_result 工具。
    const result = await this.runSubAgentDirect(
      auditor,
      {
        subagent_type: 'goal_auditor',
        task: promptText,
      },
      { ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}) },
      {
        // parentTools: 来自 worker baseTools（capability filter 会在其上筛 file_system+shell）；
        // 缺省 [] 是历史 bug，会让 auditor 没工具可用、根本无法验证任何 criterion。
        parentTools: params.parentTools ?? [],
        parentTaskId: params.taskId,
        callerLabel: 'goal_audit',
        // permissionConfig: 同样必须透传，否则 runtime check 用 dangerous 工具默认拒绝逻辑，
        // auditor 调 Bash 等会被拦回"Permission denied"。
        ...(params.permissionConfig ? { permissionConfig: params.permissionConfig } : {}),
        ...(params.traceConfig ? { traceConfig: params.traceConfig } : {}),
        traceSummaryPrefix: '[goal_audit]',
        traceTaskType: 'goal_audit',
        // submit_audit_result 是 audit 专属 exitsLoop 工具，capability filter 之后注入。
        // auditor 调它即结束，input 直接是 schema-enforced {pass, failed_criteria, evidence}。
        extraTools: [createSubmitAuditResultTool()],
      },
    )

    // 5. 解析判决（优先 tool call → max_turns/failed/aborted 直接 sentinel → fallback parseAuditReport → fallback sentinel）
    const parsed = resolveAuditJudgment(result)

    // 5b. 把 verdict 回写到 audit trace 顶层 summary，让 admin UI 直接可见
    //     (spec 2026-05-26-goal-audit-loop-completion §2.1.2)
    const auditTraceId = result.traceId ?? ''
    if (auditTraceId && params.traceConfig?.traceStore) {
      const verdictSummary = buildAuditVerdictSummary(parsed, goal)
      params.traceConfig.traceStore.appendTraceOutcome(auditTraceId, verdictSummary)
    }

    // 6. 写 audit_history —— admin 侧连续 N 次同 fail 会把 goal 自动切 blocked，读回状态。
    const appendResp = await this.deps.rpcClient.call<unknown, { task?: { goal?: { status?: GoalStatus } } }>(
      adminPort,
      'append_task_goal_audit_entry',
      {
        task_id: params.taskId,
        entry: {
          at: new Date().toISOString(),
          pass: parsed.pass,
          failed_criteria: [...parsed.failedCriteria],
          audit_trace_id: auditTraceId,
        },
      },
      moduleId,
    )
    const goalStatus = appendResp?.task?.goal?.status

    // 7. pass 路径同步把 goal 切 complete
    if (parsed.pass) {
      await this.deps.rpcClient.call<unknown, unknown>(
        adminPort,
        'complete_task_goal',
        { task_id: params.taskId },
        moduleId,
      )
    }

    return {
      pass: parsed.pass,
      failedCriteria: parsed.failedCriteria,
      detailedReport: buildHumanQueueReport(parsed, goal),
      auditTraceId,
      ...(goalStatus ? { goalStatus } : {}),
      ...(goalStatus === 'blocked'
        ? { blockedGuidance: buildBlockedGuidance(goal, parsed.failedCriteria) }
        : {}),
    }
  }

  /**
   * 构造 engine endTurnGate 闭包（异步派 audit 路径）。
   *
   * goalModeEnabled=false → 不注入 endTurnGate（透明 end_turn）。
   * goalModeEnabled=true 时返回的闭包行为：
   *  - goalSetCache=false（worker 尚未 set_task_goal）→ null（透明放行）
   *  - outboundBuffer 空 → null（无 final 待审）
   *  - 否则 spawnAuditSubagent → 设 activeAuditId → 返回 [audit_pending] marker
   *
   * runGoalAudit（同步阻塞版本）保留不动，作为未来 sync fallback 可选路径。
   *
   * spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 10
   */
  private buildAsyncAuditEndTurnGate(opts: {
    readonly goalModeEnabled: boolean
    readonly goalSetCacheGetter: () => boolean
    readonly taskId: string
    readonly taskState: WorkerTaskState
    readonly subAgents: ReadonlyArray<SubAgentConfig>
    readonly getAuditBaseTools: () => ReadonlyArray<ToolDefinition>
    /** worker 同款权限配置——auditor 跑 dangerous 工具（Bash 验 cmd criterion）必需。 */
    readonly getAuditPermissionConfig: () => ToolPermissionConfig | undefined
    readonly traceConfig?: SubAgentTraceConfig
    readonly humanQueue: HumanMessageQueue
    readonly cwd: string
    readonly owner: BgEntityOwner
    readonly getConversationLog: () => ReadonlyArray<ConversationEntry>
  }): (() => Promise<import('../engine/types.js').EndTurnGateResult>) | undefined {
    if (!opts.goalModeEnabled) return undefined
    if (!this.deps?.rpcClient || !this.deps.getAdminPort) {
      // 没 admin 通信能力 → audit gate 无法解析 goal，透明放行。
      return undefined
    }
    const adminDeps = this.deps
    const adminGetPort = this.deps.getAdminPort
    const handler = this
    return createAsyncAuditEndTurnGate({
      taskId: opts.taskId,
      taskState: opts.taskState,
      goalSetCacheGetter: opts.goalSetCacheGetter,
      rpcClient: adminDeps.rpcClient,
      moduleId: adminDeps.moduleId,
      getAdminPort: adminGetPort,
      buildSpawnDeps: (goal) => {
        // auditor 配置不存在 → spawn 抛错 → caller fail-open（console.warn）。
        // 用 throw 把"找不到 auditor"统一走 spawn 异常分支，避免在多处分散判断。
        const auditor = opts.subAgents.find((s) => s.id === 'builtin-goal-auditor')
        if (!auditor) {
          throw new Error('builtin-goal-auditor subagent not configured')
        }
        const auditAdapter = adapterFromModel(auditor.model)
        const auditPermission = opts.getAuditPermissionConfig()
        return {
          goal,
          conversationLog: opts.getConversationLog(),
          cwd: opts.cwd,
          parentTaskId: opts.taskId,
          auditor,
          parentTools: opts.getAuditBaseTools(),
          ...(auditPermission ? { permissionConfig: auditPermission } : {}),
          adapter: auditAdapter,
          owner: opts.owner,
          registry: handler.bgRegistry,
          abortControllers: handler.agentAbortControllers,
          ...(opts.traceConfig
            ? { traceContext: { traceStore: opts.traceConfig.traceStore, traceId: opts.traceConfig.parentTraceId } }
            : {}),
          humanQueue: opts.humanQueue,
        }
      },
    })
  }

  /**
   * 构造 RunSubAgentFn，注入到 delegate_task 工具。
   * 每次 createWorkerHandler 时调用，deps 绑定当次任务的 humanQueue / permissionConfig 等上下文。
   *
   * 同步路径（sync=true 或非 persistent 模式）：转发到 runSubAgentDirect。
   * 异步路径（默认）：走 spawnPersistentAgent，工具立即返回 launched，完成时通过 humanQueue 通知。
   */
  private makeRunSubAgent(deps: {
    readonly parentTools: ReadonlyArray<import('../engine/types.js').ToolDefinition>
    readonly parentTaskId: string
    readonly callerLabel: string
    readonly humanQueue?: import('../engine/human-message-queue.js').HumanMessageQueue
    readonly permissionConfig?: import('../engine/types.js').ToolPermissionConfig
    readonly traceConfig?: SubAgentTraceConfig
    /** 是否允许异步派发（master + 私聊 session）。false 时总走同步。 */
    readonly asyncEnabled?: boolean
    /** 异步派发时的 subagent 上下文（owner 信息） */
    readonly asyncCtx?: {
      readonly owner: import('../engine/bg-entities/types.js').BgEntityOwner
    }
  }): RunSubAgentFn {
    return async (subagent, input, ctx) => {
      const typedInput = input as RunSubAgentInput & { sync?: boolean }

      // 异步路径：asyncEnabled + 没有显式 sync=true
      if (deps.asyncEnabled && !typedInput.sync && deps.asyncCtx && deps.humanQueue) {
        return this.runSubAgentAsync(subagent, typedInput, deps.asyncCtx, deps)
      }

      // 同步路径（默认 fallback / 显式 sync=true）
      const { traceId: _traceId, ...result } = await this.runSubAgentDirect(subagent, input, ctx, deps)
      return result
    }
  }

  /** 异步派发 subagent：via spawnPersistentAgent，工具立即返回，完成时通知父 humanQueue。 */
  private async runSubAgentAsync(
    subagent: SubAgentConfig,
    input: RunSubAgentInput & { sync?: boolean },
    asyncCtx: {
      readonly owner: import('../engine/bg-entities/types.js').BgEntityOwner
    },
    deps: {
      readonly parentTools: ReadonlyArray<import('../engine/types.js').ToolDefinition>
      readonly parentTaskId: string
      readonly humanQueue?: import('../engine/human-message-queue.js').HumanMessageQueue
      readonly permissionConfig?: import('../engine/types.js').ToolPermissionConfig
      readonly traceConfig?: SubAgentTraceConfig
    },
  ): Promise<import('../engine/types.js').ToolCallResult> {
    const { spawnPersistentAgent } = await import('../engine/bg-entities/bg-agent.js')

    const subModel = subagent.model
    // 异步 subagent 必须按自己的 model 自建 adapter，不复用父 adapter（同步路径一致）。
    const subAdapter = adapterFromModel(subModel)

    // 子 agent 工具集：从父工具里过滤（同 runSubAgentDirect 路径）
    const subTools = filterToolsForSubAgent(
      [...deps.parentTools],
      subagent.builtin_capabilities,
      subagent.allowed_mcp_server_ids,
      subagent.allowed_skill_ids,
    )

    const finalSystemPrompt = assembleSubAgentPrompt(subagent, {
      parentTaskId: deps.parentTaskId,
      callerLabel: 'main worker (async)',
    })

    const bgTraceCtx = deps.traceConfig
      ? { traceStore: deps.traceConfig.traceStore, traceId: deps.traceConfig.parentTraceId }
      : undefined

    const entity_id = await spawnPersistentAgent({
      prompt: input.task,
      task_description: input.task,
      tools: subTools,
      ...(deps.permissionConfig ? { permissionConfig: deps.permissionConfig } : {}),
      systemPrompt: finalSystemPrompt,
      model: subModel.model_id,
      ...(subModel.max_tokens !== undefined ? { maxTokens: subModel.max_tokens } : {}),
      adapter: subAdapter,
      owner: asyncCtx.owner,
      spawned_by_task_id: deps.parentTaskId,
      registry: this.bgRegistry,
      abortControllers: this.agentAbortControllers,
      ...(bgTraceCtx ? { traceContext: bgTraceCtx } : {}),
      // 子 agent 自己的 sub_agent_call 子 trace —— 让异步 delegate 在 Admin Traces
      // 页以独立行显示并可 drill-in（与同步 runSubAgentDirect 路径一致）。
      ...(deps.traceConfig
        ? {
            subTrace: {
              traceStore: deps.traceConfig.traceStore,
              parentTraceId: deps.traceConfig.parentTraceId,
              ...(deps.traceConfig.parentSpanId ? { parentSpanId: deps.traceConfig.parentSpanId } : {}),
              ...(deps.traceConfig.relatedTaskId ? { relatedTaskId: deps.traceConfig.relatedTaskId } : {}),
              summaryPrefix: `[${subagent.name}]`,
            },
          }
        : {}),
      onExit: (info) => {
        if (!deps.humanQueue) return
        deps.humanQueue.push(formatSubAgentNotification(info))
      },
    })

    return {
      output: JSON.stringify({ agent_id: entity_id, status: 'launched', output_file: null }),
      isError: false,
    }
  }

  private buildSystemPrompt(
    context: WorkerAgentContext,
    subAgents: ReadonlyArray<SubAgentConfig>,
    goalModeEnabled: boolean,
    taskId: TaskId,
  ): string {
    // unified loop spec §3.1：使用 assembleAgentPrompt。
    const sceneProfile = context.scene_profile
      ? { label: context.scene_profile.label, content: context.scene_profile.content }
      : undefined
    // subAgents 由 runWorkerLoop 在 loop 启动时 snapshot 后传入，
    // 防止 in-flight loop 中 admin 改 subagents 后 system prompt 列表跳变。
    const availableSubAgents = subAgents.map((s) => ({
      toolName: s.name,
      workerHint: s.when_to_use.split('\n')[0] || s.description || s.name,
    }))
    const baseAssembled = this.promptManager
      ? this.promptManager.assembleAgentPrompt({
        goalModeEnabled,
        adminPersonality: this.systemPrompt || undefined,
        skillListing: this.buildSkillListingSnapshot(),
        availableSubAgents: availableSubAgents.length > 0 ? availableSubAgents : undefined,
        ...(sceneProfile ? { sceneProfile } : {}),
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
    // 临时页面（tmp-page skill）上下文：把对外 base URL + 本 worker 的 task_id 注入，
    // 让 worker 拼 <base>/tmp-pages/<page_id> 链接、并把 meta.owner_task_id 写成真实 task_id。
    // spec: 2026-06-19-temp-interactive-page-design.md §5.1 / §5.2
    if (this.tmpPageBaseUrl) {
      parts.push('\n## 临时页面')
      parts.push(`临时页面对外地址: ${this.tmpPageBaseUrl}；你的 task_id: ${taskId}`)
    }

    // 系统触发任务 + 无 target_session 时给 worker 明确指引（避免它对着 SYSTEM_SESSION 占位 session 调 send_message）
    const firstTrigger = context.trigger_messages?.[0]
    if (
      firstTrigger?.content?.type === 'system_event'
      && firstTrigger.session?.channel_id === SYSTEM_CHANNEL_ID
    ) {
      parts.push('\n' + SYSTEM_TRIGGER_NO_TARGET_GUIDANCE)
    }
    return parts.join('\n')
  }

  private async buildTaskMessage(task: ExecuteTaskParams['task'], context: WorkerAgentContext): Promise<string | ContentBlock[]> {
    const parts: string[] = []
    const now = new Date()
    const timezone = this.getTimezone()

    parts.push(`当前时间: ${formatNow(timezone, now)}`)
    parts.push('')

    // 引用消息预拉：trigger_messages + recent_messages 一起扫，命中 quotedMessages
    // 后 formatChannelMessageLine 会嵌套渲染 <quoted_message>。
    const triggerMsgs = context.trigger_messages ?? []
    const recentMsgsForPrefetch = context.recent_messages ?? []
    const identityResolver = (msg: ChannelMessage) =>
      resolveSenderIdentity({
        msg,
        senderFriend: context.sender_friend,
        crabDisplayName: undefined,
      })
    const quotedMessages: ReadonlyMap<string, QuotedMessageEntry> =
      this.deps && context.task_origin
        ? await prefetchQuotedMessages(
            [...triggerMsgs, ...recentMsgsForPrefetch],
            recentMsgsForPrefetch,
            context.task_origin.channel_id,
            context.task_origin.session_id,
            context.task_origin.session_type === 'group' ? 'group' : 'private',
            {
              rpcClient: this.deps.rpcClient,
              moduleId: this.deps.moduleId,
              resolveChannelPort: this.deps.resolveChannelPort,
            },
            identityResolver,
          )
        : new Map<string, QuotedMessageEntry>()

    if (context.scene_profile) {
      const escaped = context.scene_profile.content.replace(/<\/scene_profile>/g, '&lt;/scene_profile&gt;')
      parts.push('## 场景画像')
      parts.push(`<scene_profile label="${context.scene_profile.label}">`)
      parts.push(escaped)
      parts.push('</scene_profile>')
      parts.push('')
    }
    parts.push('## 任务信息')
    parts.push(`- 标题: ${task.task_title}`)
    parts.push(`- 优先级: ${task.priority}`)
    if (task.plan) { parts.push(`- 计划: ${task.plan}`) }

    if (context.sender_friend) {
      parts.push(`\n## 发送者信息`)
      parts.push(`- 名称: ${context.sender_friend.display_name}`)
      parts.push(`- 权限: ${context.sender_friend.permission}`)
    }

    // 系统 session（SYSTEM_CHANNEL_ID）时不渲染 task_origin —— 它对 LLM 无意义且会
    // 误导 crab-messaging 工具尝试往系统 channel 发消息。
    if (context.task_origin && context.task_origin.channel_id !== SYSTEM_CHANNEL_ID) {
      parts.push('\n## 任务来源（crab-messaging 工具请使用这些 ID）')
      parts.push(`- Channel ID: ${context.task_origin.channel_id}`)
      parts.push(`- Session ID: ${context.task_origin.session_id}`)
    }
    const shortTermHours = context.time_windows.short_term_memory_window_hours
    const recentHours = context.time_windows.recent_messages_window_hours

    parts.push('\n## 记忆系统')

    // 短期记忆（跨 channel/session 流水账）：解决跨 session 指代漂移的核心数据来源
    parts.push(`\n### 短期记忆（跨所有 channel/session 的近期事件流水，最近 ${shortTermHours} 小时，${context.short_term_memories.length} 条）`)
    if (context.short_term_memories.length > 0) {
      parts.push('当任务描述含跨 session 指代（"刚才那个 X"/"上次"/"接着之前的"）时，先看这里再行动——条目带 channel/session/task 锚点。')
      for (const mem of context.short_term_memories) {
        parts.push(formatShortTermMemoryLine(mem, { timezone, now, maxLen: 500 }))
      }
    } else {
      parts.push(`过去 ${shortTermHours} 小时内无短期记忆。需要更早的事件流水时主动调 \`crab-memory.search_short_term\`（传 query/time_range）。`)
    }

    parts.push('\n### 长期记忆')
    parts.push('长期记忆（用户偏好 / 项目事实 / 历史教训 / 概念定义）**永不预填**到上下文。任何涉及')
    parts.push('"用户的稳定偏好 / 之前做过的类似事 / 过往踩过的坑 / 项目背景事实"的判断，')
    parts.push('都必须先调 `crab-memory.search_long_term`（传 query 按主题精准检索），必要时再用 `crab-memory.get_memory_detail` 取详情。')
    parts.push('禁止凭印象或常识回答此类问题——上下文里没有相关记忆 ≠ 用户没有相关偏好。')

    // === 会话历史（合并 recent + trigger 单段时间线） ===
    // 协议语义：recent_messages 是触发消息之前的本 session 历史；trigger_messages 是
    // 决策时的输入消息。dedupe by platform_message_id 防御性 —— 理论上不重叠，
    // 实际防御后续路径偶发重复。稳定排序保证同 timestamp 时 recent 在前、trigger 在后。
    const seen = new Set<string>()
    const allMessages: ChannelMessage[] = []
    for (const m of [...recentMsgsForPrefetch, ...triggerMsgs]) {
      if (seen.has(m.platform_message_id)) continue
      seen.add(m.platform_message_id)
      allMessages.push(m)
    }
    allMessages.sort((a, b) => (a.platform_timestamp ?? '').localeCompare(b.platform_timestamp ?? ''))

    if (allMessages.length > 0) {
      parts.push(`\n## 会话历史（共 ${allMessages.length} 条，含触发消息；当前 session 最近 ${recentHours} 小时）`)
      for (const msg of allMessages) {
        parts.push(formatChannelMessageLine(msg, {
          timezone, now, maxLen: 2000,
          identity: identityResolver(msg),
          quotedMessages,
        }))
      }
    } else {
      parts.push(`\n## 会话历史`)
      parts.push(`过去 ${recentHours} 小时本会话无消息。如需更早的本会话历史，调 \`get_history\` 工具。`)
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
        // Strip [图片: /path] text references — the image is already in the VLM blocks below.
        const vlmTextContent = textContent.replace(/\[图片: [^\]]*\]\n?/g, '')
        return [
          { type: 'text' as const, text: vlmTextContent },
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

  // ============================================================================
  // Bg-entity admin RPC methods (Plan 3 Task 1)
  // ============================================================================

  async listBgEntities(opts?: {
    owner_friend_id?: string
    status?: BgEntityStatus[]
    type?: BgEntityType
  }): Promise<BgEntityRecord[]> {
    return this.bgRegistry.list(opts)
  }

  async killBgEntity(entity_id: string): Promise<{ ok: boolean; message?: string }> {
    if (entity_id.startsWith('shell_')) {
      const rec = await this.bgRegistry.get(entity_id)
      if (!rec) return { ok: false, message: 'Entity not found' }
      if (rec.status !== 'running') return { ok: false, message: `Already ${rec.status}` }
      if (rec.type !== 'shell') return { ok: false, message: 'Mismatched type' }
      killShellTree(rec.pgid)
      await this.bgRegistry.update(entity_id, {
        status: 'killed',
        ended_at: new Date().toISOString(),
      })
      return { ok: true }
    }
    if (entity_id.startsWith('agent_')) {
      const rec = await this.bgRegistry.get(entity_id)
      if (!rec) return { ok: false, message: 'Entity not found' }
      if (rec.status !== 'running') return { ok: false, message: `Already ${rec.status}` }
      const controller = this.agentAbortControllers.get(entity_id)
      if (controller) controller.abort()
      await this.bgRegistry.update(entity_id, {
        status: 'killed',
        ended_at: new Date().toISOString(),
      })
      return { ok: true }
    }
    return { ok: false, message: `Invalid entity_id: ${entity_id}` }
  }

  async getBgEntityLog(
    entity_id: string,
    opts?: { from_offset?: number; max_bytes?: number },
  ): Promise<{
    content: string
    new_offset: number
    status: BgEntityStatus
    type: BgEntityType
  }> {
    const fromOffset = opts?.from_offset ?? 0
    const maxBytes = opts?.max_bytes ?? 100_000

    const rec = await this.bgRegistry.get(entity_id)
    if (!rec) throw new Error(`Entity not found: ${entity_id}`)

    let logFile: string
    if (rec.type === 'shell') {
      logFile = rec.log_file
    } else {
      // agent: completed → result_file; otherwise messages_log_file
      if (rec.status === 'completed' && rec.result_file) {
        const content = await fs.promises.readFile(rec.result_file, 'utf-8')
        return { content, new_offset: content.length, status: rec.status, type: 'agent' }
      }
      logFile = rec.messages_log_file
    }

    // Incremental log read
    try {
      const stat = await fs.promises.stat(logFile)
      const start = Math.min(fromOffset, stat.size)
      const length = Math.min(maxBytes, stat.size - start)
      if (length <= 0) {
        return { content: '', new_offset: stat.size, status: rec.status, type: rec.type }
      }
      const fd = await fs.promises.open(logFile, 'r')
      try {
        const buf = Buffer.alloc(length)
        await fd.read(buf, 0, length, start)
        return {
          content: buf.toString('utf-8'),
          new_offset: start + length,
          status: rec.status,
          type: rec.type,
        }
      } finally {
        await fd.close()
      }
    } catch {
      return { content: '', new_offset: 0, status: rec.status, type: rec.type }
    }
  }

}
