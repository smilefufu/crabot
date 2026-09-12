/**
 * 后台实体注册、退出通知与兼容查询服务。
 * 当前 builtin Worker 的执行循环和提示词由 workers/builtin 与 prompts/builtin-worker 拥有。
 */

import { createAdapter } from '../engine/index.js'
import { BgEntityRegistry } from '../engine/bg-entities/registry.js'
import { killShellTree } from '../engine/bg-entities/bg-shell.js'
import { ReadoptReaper } from '../engine/bg-entities/reaper.js'
import type { BgEntityOwner, BgEntityRecord, BgEntityStatus, BgEntityType, BgShellRegistryRecord } from '../engine/bg-entities/types.js'
import { BG_EXIT_RETRY_DELAYS_MS } from '../engine/bg-entities/types.js'
import type { BashBgContext } from '../engine/tools/index.js'
import type { BgToolDeps } from '../engine/tools/index.js'
import type {
  WorkerAgentContext,
  WorkerTaskState,
  TaskId,
  TaskOrigin,
  ChannelMessage,
  SkillConfig,
  LiveTaskSnapshot,
  ResolvedPermissions,
  Friend,
} from '../types.js'
import type { RpcClient } from 'crabot-shared'
import { formatMessageContent, EMPTY_MESSAGE_PLACEHOLDER } from './media-resolver.js'
import type { SubAgentConfig } from '../types.js'
import { HumanMessageQueue } from '../engine/human-message-queue.js'
import { filterNonAgentCrabotSkills } from '../workers/capability-policy.js'
import { formatRuntimeMs } from '../utils/time.js'
import { getAgentDataDir, getBgEntitiesLogsDir } from '../core/data-paths.js'
import {
  formatStillRunningSnapshot,
  type RunningWaitTarget,
} from '../mcp/running-entities.js'
import { AGENT_VERSION } from '../constants.js'

import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'

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
 * caller 用 agent_id 追踪在跑的 async subagent（喂给 end_turn 的 hasActiveAsyncSubagent 判断）。
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
    // 非 JSON / 非 async-launched 结果忽略
  }
  return undefined
}

const LOG_FILE = path.join(getAgentDataDir(), 'agent-handler-debug.log')

/** subagent 完成通知里内联结果预览的字符上限；超过则截断并提示用 get_subagent_output 读全文。 */
const SUBAGENT_RESULT_PREVIEW_MAX = 2000

/** Task 终态集合。与 crabot-admin/src/task-state-machine.ts 的 TERMINAL_STATUSES 对齐
 *  （同 goal-audit.ts TERMINAL_GOAL_STATUSES 的同步一份 + 注释指向源的做法）。 */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled'])

export interface SubAgentExitInfo {
  readonly entity_id: string
  readonly task_description: string
  readonly status: 'completed' | 'failed'
  readonly runtime_ms: number
  readonly error?: string
  readonly result_file: string | null
  readonly diagnostics_file?: string
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
    info.diagnostics_file ? `<diagnostics_file>${info.diagnostics_file}</diagnostics_file>` : '',
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
 * 从 bgRegistry running 记录中提取某 task 名下的在跑对象（唤醒快照数据源）。
 * async subagent 与 bg shell 都是 registry 记录（type='agent'/'shell'），统一在此映射。
 * excludeEntityIds：正在退出的 entity 自身（registry 可能尚未更新为终态）+ 在跑的
 * goal-audit subagent（它也以 parentTaskId 注册，但对 worker 必须不可见——快照泄漏它
 * 会重新引入"教 agent 等 audit"污染，且与 end_turn 的 targets 准入自相矛盾）。
 * spec: 2026-07-16-wait-signal-targets-goal-lifecycle-design §6
 */
export function summarizeRunningEntities(
  records: ReadonlyArray<import('../engine/bg-entities/types.js').BgEntityRecord>,
  taskId: string,
  excludeEntityIds: ReadonlyArray<string> = [],
  nowMs: number = Date.now(),
): RunningWaitTarget[] {
  return records
    .filter((r) => r.spawned_by_task_id === taskId && !excludeEntityIds.includes(r.entity_id) && r.status === 'running')
    .map((r) => ({
      id: r.entity_id,
      kind: r.type === 'agent' ? ('subagent' as const) : ('bg_entity' as const),
      runtime_ms: Math.max(0, nowMs - new Date(r.spawned_at).getTime()),
      description: r.type === 'shell' ? r.command : r.task_description,
    }))
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
  extra?: Record<string, unknown>
}

export interface AgentHandlerDeps {
  rpcClient: RpcClient
  moduleId: string
  resolveChannelPort: (channelId: string) => Promise<number>
  /** Admin RPC 端口解析（get_task_progress 工具用） */
  getAdminPort?: () => Promise<number>
}

import type { LLMFormat } from '../engine/llm-adapter'
import type { LLMThinkingConfig } from '../engine/llm-adapter-types.js'

export interface WorkerTraceContext {
  traceStore: import('../core/trace-store').TraceStore
  traceId: string
  relatedTaskId?: string
}

export interface SdkEnvConfig {
  modelId: string
  format: LLMFormat
  supportsVision?: boolean
  /** Provider 配置的 max_output_tokens；未配置时 adapter 走各自的处理策略 */
  maxTokens?: number
  /** Provider 模型配置的 context_window；未配置时 engine 回退内置默认 200000 */
  contextWindow?: number
  /** 槽位思考强度；未配置 = 跟随模型默认（请求中不出现任何思考参数） */
  thinking?: LLMThinkingConfig
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
  deps?: AgentHandlerDeps
  digestSdkEnv?: SdkEnvConfig
  subAgents?: ReadonlyArray<SubAgentConfig>
  skills?: ReadonlyArray<SkillConfig>
  /** UnifiedAgent 共享的 Worker background entity registry。 */
  bgRegistry?: BgEntityRegistry
}

interface ShellExitInfo {
  readonly entity_id: string
  readonly command: string
  readonly status: 'completed' | 'failed' | 'killed'
  readonly exit_code: number
  readonly spawned_by_task_id: string
  readonly owner_friend_id?: string
  readonly worker_id?: string
  readonly runtime_ms?: number
}

type ShellExitSettlement =
  | { readonly status: 'delivered' }
  | { readonly status: 'dead_letter'; readonly reason: string }

type WorkerEntityExitInfo = ShellExitInfo | { entity_id: string; worker_id: string }

export class AgentHandler {
  private sdkEnv: SdkEnvConfig
  private activeTasks: Map<TaskId, WorkerTaskState> = new Map()
  /** Human message queues for active tasks */
  private humanQueues: Map<TaskId, HumanMessageQueue> = new Map()
  /**
   * 飞行中任务的实时快照：current_turn / 上一轮模型话 / active_tools / 最近完成的工具。
   * 由 onLiveProgress 回调维护；executeTask 完成时清理。
   * ContextAssembler 同进程同步读取（getLiveSnapshot）以注入 Front prompt。
   */
  private liveSnapshots: Map<TaskId, LiveTaskSnapshot> = new Map()
  private deps?: AgentHandlerDeps
  private extra: Record<string, unknown>
  private digestSdkEnv?: SdkEnvConfig
  /** 兼容查询接口保留的当前 subagent 配置快照。 */
  private subAgents: ReadonlyArray<SubAgentConfig>
  private skills: ReadonlyArray<SkillConfig>
  /** Worker-singleton bg entity registry (persistent, disk-backed) */
  private readonly bgRegistry: BgEntityRegistry
  /** 监视跨重启认领回来、仍存活的 shell；退出时通知（唤醒 resumed worker + 持久通知）。 */
  private readonly readoptReaper: ReadoptReaper
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
  /** Builtin WorkerInbox exit dispatcher, attached after the harness is constructed. */
  private builtinShellExitDispatcher?: (
    workerId: string,
    info: ShellExitInfo,
    onSettled: (settlement: ShellExitSettlement) => Promise<void>,
  ) => Promise<void>
  private builtinChildExitDispatcher?: (
    workerId: string,
    entityId: string,
    onSettled: (settlement: ShellExitSettlement) => Promise<void>,
  ) => Promise<void>
  /**
   * Recovered worker-owned shells must wait for harness reconciliation: before
   * `scanOrphans()` a restarted builtin adapter has no resident incarnation and
   * WorkerInbox would retain the notification at its head until unrelated input.
   */
  private workerEntityExitRoutingReady = false
  private readonly queuedWorkerEntityExits: WorkerEntityExitInfo[] = []
  /** Per-worker FIFO retained at the head while delivery is retrying. */
  private readonly workerEntityExitQueues = new Map<string, WorkerEntityExitInfo[]>()
  private readonly drainingWorkerEntityExitQueues = new Set<string>()
  /** Per-process delivery retries; delay is capped while durable pending survives restart. */
  private readonly workerEntityExitRetryTimers = new Map<string, NodeJS.Timeout>()
  /** Settlement-only retries never re-enqueue an input already accepted by WorkerInbox. */
  private readonly workerEntityExitSettlementTimers = new Map<string, NodeJS.Timeout>()
  /** Interval handle for periodic 24h GC of dead entities */
  private gcIntervalHandle?: NodeJS.Timeout

  constructor(
    sdkEnv: SdkEnvConfig,
    config: AgentHandlerConfig,
    options?: AgentHandlerOptions,
  ) {
    this.bgRegistry = options?.bgRegistry ?? new BgEntityRegistry()
    this.readoptReaper = new ReadoptReaper(
      this.bgRegistry,
      (info) => { void this.routeShellExit(info).catch((error) => console.error('[AgentHandler] readopt shell notification failed:', error)) },
    )
    this.sdkEnv = sdkEnv
    this.deps = options?.deps
    this.extra = config.extra ?? {}
    this.digestSdkEnv = options?.digestSdkEnv
    this.subAgents = options?.subAgents ?? []
    this.skills = filterNonAgentCrabotSkills(options?.skills ?? [])

    // Startup: recover persistent bg entities（跨重启对账）。
    // - deadShells（宕机期间已退出）：已读 sentinel 定真实终态，这里补发退出通知（resumed/recovery worker 会收到）。
    // - alive（仍存活的 re-adopt shell）：交 reaper 周期探活，退出时再通知（本进程非其父，收不到 child exit）。
    // - stalledAgents：已在 recoverPersistent 内标 stalled（agent 循环活在进程里，重启即无）。
    void this.bgRegistry.recoverPersistent()
      .then(({ alive, deadShells }) => {
        for (const rec of deadShells) {
          void this.routeShellExit({
            entity_id: rec.entity_id,
            command: rec.command,
            status: rec.status === 'completed' ? 'completed' : rec.status === 'killed' ? 'killed' : 'failed',
            exit_code: rec.exit_code ?? -1,
            spawned_by_task_id: rec.spawned_by_task_id,
            ...(rec.owner.friend_id ? { owner_friend_id: rec.owner.friend_id } : {}),
            ...(rec.owner.worker_id ? { worker_id: rec.owner.worker_id } : {}),
          }).catch((error) => console.error('[AgentHandler] recovered shell notification failed:', error))
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
    this.readoptReaper.stop()
    this.workerEntityExitQueues.clear()
    this.drainingWorkerEntityExitQueues.clear()
    for (const timer of this.workerEntityExitRetryTimers.values()) clearTimeout(timer)
    this.workerEntityExitRetryTimers.clear()
    for (const timer of this.workerEntityExitSettlementTimers.values()) clearTimeout(timer)
    this.workerEntityExitSettlementTimers.clear()
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

  /** Attach the WorkerInbox route for builtin-owned persistent shells. */
  setBuiltinShellExitDispatcher(dispatcher: NonNullable<AgentHandler['builtinShellExitDispatcher']>): void {
    this.builtinShellExitDispatcher = dispatcher
  }

  setBuiltinChildExitDispatcher(dispatcher: NonNullable<AgentHandler['builtinChildExitDispatcher']>): void {
    this.builtinChildExitDispatcher = dispatcher
  }

  async routeBuiltinChildExit(workerId: string, entityId: string): Promise<void> {
    const info = { worker_id: workerId, entity_id: entityId }
    if (!this.workerEntityExitRoutingReady) {
      this.queuedWorkerEntityExits.push(info)
      return
    }
    this.enqueueWorkerEntityExit(workerId, info)
    await this.drainWorkerEntityExitQueue(workerId)
  }

  /**
   * Called after builtin orphan scan and harness reconciliation complete. This
   * releases recovered worker-owned shell exits without waiting on agent startup.
   */
  async releaseRecoveredWorkerEntityExits(): Promise<void> {
    for (const record of await this.bgRegistry.list({ type: 'agent' })) {
      if (record.owner.worker_id && record.spawned_by_task_id === record.owner.worker_id && record.exit_notification?.status === 'pending') {
        this.queuedWorkerEntityExits.push({ worker_id: record.owner.worker_id, entity_id: record.entity_id })
      }
    }
    this.workerEntityExitRoutingReady = true
    const recovered = this.queuedWorkerEntityExits.splice(0)
    const workerIds = new Set<string>()
    for (const info of recovered) {
      if (!info.worker_id && 'command' in info) {
        void this.deliverShellExitNotification(info).catch((error) => {
          console.error(`[AgentHandler] recovered legacy shell notification failed for ${info.entity_id}:`, error)
        })
        continue
      }
      if (info.worker_id) {
        this.enqueueWorkerEntityExit(info.worker_id, info)
        workerIds.add(info.worker_id)
      }
    }
    // Start one independent FIFO drain per worker. Startup/liveness must not wait
    // for adapter I/O from an unrelated worker that may remain hung indefinitely.
    for (const workerId of workerIds) {
      void this.drainWorkerEntityExitQueue(workerId).catch((error) => {
        console.error(`[AgentHandler] recovered worker shell queue failed for ${workerId}:`, error)
      })
    }
  }

  private async routeShellExit(info: ShellExitInfo): Promise<void> {
    if (info.worker_id && !this.workerEntityExitRoutingReady) {
      this.queuedWorkerEntityExits.push(info)
      return
    }
    if (!info.worker_id) {
      await this.deliverShellExitNotification(info)
      return
    }

    this.enqueueWorkerEntityExit(info.worker_id, info)
    await this.drainWorkerEntityExitQueue(info.worker_id)
  }

  private enqueueWorkerEntityExit(workerId: string, info: WorkerEntityExitInfo): void {
    const queue = this.workerEntityExitQueues.get(workerId) ?? []
    if (!queue.some((queued) => queued.entity_id === info.entity_id)) queue.push(info)
    this.workerEntityExitQueues.set(workerId, queue)
  }

  private async drainWorkerEntityExitQueue(workerId: string, retryIndex = 0): Promise<void> {
    if (this.drainingWorkerEntityExitQueues.has(workerId)) return
    this.drainingWorkerEntityExitQueues.add(workerId)
    try {
      const queue = this.workerEntityExitQueues.get(workerId)
      while (queue && queue.length > 0) {
        const info = queue[0]
        if (!await this.tryRouteWorkerEntityExit(workerId, info)) {
          this.scheduleWorkerEntityExitRetry(workerId, info.entity_id, retryIndex)
          return
        }
        const retryTimer = this.workerEntityExitRetryTimers.get(info.entity_id)
        if (retryTimer) clearTimeout(retryTimer)
        this.workerEntityExitRetryTimers.delete(info.entity_id)
        queue.shift()
      }
      this.workerEntityExitQueues.delete(workerId)
    } finally {
      this.drainingWorkerEntityExitQueues.delete(workerId)
    }
  }

  private async tryRouteWorkerEntityExit(workerId: string, info: WorkerEntityExitInfo): Promise<boolean> {
    try {
      const record = await this.bgRegistry.get(info.entity_id)
      if (record?.exit_notification?.status !== 'pending') return true

      await this.bgRegistry.beginExitNotificationAttempt(info.entity_id)
      const settle = async (settlement: ShellExitSettlement) => {
        await this.settleWorkerEntityExit(info.entity_id, settlement)
      }
      if ('command' in info) {
        if (!this.builtinShellExitDispatcher) throw new Error('builtin shell exit dispatcher is not attached')
        await this.builtinShellExitDispatcher(workerId, info, settle)
      } else {
        if (!this.builtinChildExitDispatcher) throw new Error('builtin child exit dispatcher is not attached')
        await this.builtinChildExitDispatcher(workerId, info.entity_id, settle)
      }
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.bgRegistry.recordExitNotificationFailure(info.entity_id, message).catch((recordError) => {
        console.error(`[AgentHandler] failed to persist bg notification error for ${info.entity_id}:`, recordError)
      })
      console.error(
        `[AgentHandler] worker shell notification failed (entity=${info.entity_id}, worker=${workerId}):`,
        error,
      )
      return false
    }
  }

  private scheduleWorkerEntityExitRetry(workerId: string, entityId: string, retryIndex: number): void {
    if (this.workerEntityExitRetryTimers.has(entityId)) return
    const delayIndex = Math.min(retryIndex, BG_EXIT_RETRY_DELAYS_MS.length - 1)
    const timer = setTimeout(() => {
      this.workerEntityExitRetryTimers.delete(entityId)
      void this.drainWorkerEntityExitQueue(
        workerId,
        Math.min(delayIndex + 1, BG_EXIT_RETRY_DELAYS_MS.length - 1),
      )
    }, BG_EXIT_RETRY_DELAYS_MS[delayIndex])
    timer.unref?.()
    this.workerEntityExitRetryTimers.set(entityId, timer)
  }

  private async settleWorkerEntityExit(
    entityId: string,
    settlement: ShellExitSettlement,
    retryIndex = 0,
  ): Promise<void> {
    try {
      await this.bgRegistry.settleExitNotification(
        entityId,
        settlement.status,
        settlement.status === 'dead_letter' ? settlement.reason : undefined,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.bgRegistry.recordExitNotificationFailure(entityId, `settlement failed: ${message}`).catch(() => undefined)
      this.scheduleWorkerEntityExitSettlementRetry(entityId, settlement, retryIndex)
      throw error
    }
  }

  private scheduleWorkerEntityExitSettlementRetry(
    entityId: string,
    settlement: ShellExitSettlement,
    retryIndex: number,
  ): void {
    if (this.workerEntityExitSettlementTimers.has(entityId)) return
    const delayIndex = Math.min(retryIndex, BG_EXIT_RETRY_DELAYS_MS.length - 1)
    const timer = setTimeout(() => {
      this.workerEntityExitSettlementTimers.delete(entityId)
      void this.settleWorkerEntityExit(
        entityId,
        settlement,
        Math.min(delayIndex + 1, BG_EXIT_RETRY_DELAYS_MS.length - 1),
      ).catch((error) => {
        console.error(`[AgentHandler] bg notification settlement retry failed for ${entityId}:`, error)
      })
    }, BG_EXIT_RETRY_DELAYS_MS[delayIndex])
    timer.unref?.()
    this.workerEntityExitSettlementTimers.set(entityId, timer)
  }

  /**
   * Supplies the shared persistent registry to a builtin worker. The legacy
   * handler remains its owner; a second registry would split shell ownership.
   */
  getBuiltinBgEntityRegistry(): BgEntityRegistry {
    return this.bgRegistry
  }

  createBuiltinBgToolOptions(workerId: string): { bgEntityCtx: BashBgContext; bgToolDeps: BgToolDeps } {
    const owner: BgEntityOwner = { friend_id: `__system_${workerId}`, worker_id: workerId }
    const onShellExit: BashBgContext['onShellExit'] = (info) => {
      void this.routeShellExit({
        ...info,
        spawned_by_task_id: workerId,
        owner_friend_id: owner.friend_id,
        worker_id: workerId,
      }).catch((error) => {
        console.error(`[AgentHandler] worker shell exit routing failed for ${info.entity_id}:`, error)
      })
    }
    return {
      bgEntityCtx: { registry: this.bgRegistry, owner, taskId: workerId, onShellExit },
      bgToolDeps: {
        registry: this.bgRegistry,
        cursorMap: this.bgCursorMap,
        taskId: workerId,
        ownerFriendId: owner.friend_id,
        ownerWorkerId: workerId,
        agentAbortControllers: this.agentAbortControllers,
      },
    }
  }

  async hasRunningBgForWorker(workerId: string): Promise<boolean> {
    const entities = await this.bgRegistry.list()
    return entities.some((entity) =>
      entity.owner.worker_id === workerId && (
        entity.status === 'running' ||
        entity.exit_notification?.status === 'pending'
      ),
    )
  }

  /** Render the common shell exit payload for WorkerInbox system delivery. */
  async renderShellExitNotification(info: {
    entity_id: string
    command: string
    status: 'completed' | 'failed' | 'killed'
    exit_code: number
    runtime_ms?: number
  }): Promise<string> {
    const command = `${info.command.slice(0, 200)}${info.command.length > 200 ? '...' : ''}`
    const runtimeStr = info.runtime_ms !== undefined ? `, 运行 ${formatRuntimeMs(info.runtime_ms)}` : ''
    const tail = await this.readShellLogTail(info.entity_id)
    const tailBlock = tail
      ? `\n--- 输出尾部 ---\n${tail}\n--- 更多用 Output("${info.entity_id}") ---`
      : `\n用 Output("${info.entity_id}") 读取完整输出。`
    return `Background shell ${info.entity_id} 已退出 (status=${info.status}, exit_code=${info.exit_code}${runtimeStr})。\n` +
      `命令: ${command}${tailBlock}`
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
    // 唤醒快照：只进本 task 的 humanQueue（friend 通知跨 task 场景下该清单无意义）。
    // spec: 2026-07-16-wait-signal-targets-goal-lifecycle-design §6
    const stillRunning = await this.buildStillRunningLine(info.spawned_by_task_id, info.entity_id)
    this.humanQueues.get(info.spawned_by_task_id)?.push(
      `[系统] ${message}${stillRunning ? `\n${stillRunning}` : ''}`,
    )
    if (info.owner_friend_id) {
      this.enqueueBgNotification(`friend:${info.owner_friend_id}`, message)
    }
  }

  /**
   * 唤醒消息的"仍在运行"快照行——push 时刻现查现写，无新状态（spec 2026-07-16 §6）。
   * 查询失败降级为空串（快照是增强信息，绝不阻塞通知投递）。
   */
  private async buildStillRunningLine(taskId: string, excludeEntityId?: string): Promise<string> {
    try {
      const running = await this.bgRegistry.list({ status: ['running'] })
      const exclude: string[] = []
      if (excludeEntityId) exclude.push(excludeEntityId)
      return formatStillRunningSnapshot(summarizeRunningEntities(running, taskId, exclude))
    } catch {
      return ''
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
    const filteredSkills = filterNonAgentCrabotSkills(newSkills)
    const hash = computeSkillsHash(filteredSkills)
    if (hash === this.lastSkillsHash) return
    this.skills = filteredSkills
    this.lastSkillsHash = hash
  }

  /** 更新兼容查询接口的 subagent 快照。 */
  updateSubagents(newList: ReadonlyArray<SubAgentConfig>): void {
    this.subAgents = newList
  }

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

  /** runtime config 原子替换：整批更新 extra（区别于 updateExtra 的增量合并）。 */
  setExtra(extra: Record<string, unknown>): void {
    this.extra = { ...extra }
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
   * goal mode 是否启用：admin extra 开关 + scheduled 任务硬关。
   * 仅用于旧任务补充输入的兼容文案。
   * triggerType 用 string | undefined 接受 task.source.trigger_type 和 taskState.triggerType
   * 两种不同 union，统一只比 'scheduled' 字面。
   */
  private isGoalModeEnabled(triggerType: string | undefined): boolean {
    return this.extra?.goal_mode_enabled !== false && triggerType !== 'scheduled'
  }

  /**
   * 取任务的权限主体（原发起人身份 + 会话），供 unified-agent 在 supplement/resume 时
   * 重新解析权限（spec 2026-07-20-task-permission-hot-refresh §方案A）。
   * 返回 null = 任务不存在或不是消息触发任务（scheduled / 系统任务不刷新）。
   */
  getTaskPrincipal(taskId: TaskId): {
    senderFriend?: Friend
    channelId: string
    sessionId: string
    sessionType: 'private' | 'group'
  } | null {
    const taskState = this.activeTasks.get(taskId)
    // scheduled 任务带 target_session 时也有 task_origin（但无 sender_friend）——
    // 其权限由 Admin 按 creator（含 master_private）解析下发，严禁按匿名会话身份重解析。
    if (!taskState || taskState.triggerType !== 'message') return null
    const origin = taskState.resumeWorkerContext?.task_origin
    if (!origin?.channel_id || !origin.session_id || !origin.session_type) return null
    return {
      ...(taskState.resumeWorkerContext?.sender_friend
        ? { senderFriend: taskState.resumeWorkerContext.sender_friend }
        : {}),
      channelId: origin.channel_id,
      sessionId: origin.session_id,
      sessionType: origin.session_type,
    }
  }

  /**
   * 热替换任务当前生效的 ResolvedPermissions（仅本任务持有者 + checkpoint 快照，
   * 不碰任何跨任务共享状态）。替换是原子引用交换：进行中的 turn 用它开始时的
   * 权限跑完，下一 turn（buildToolsDynamic / cli gate 经 getter 重读）用新权限。
   */
  updateTaskPermissions(taskId: TaskId, perms: ResolvedPermissions): void {
    const taskState = this.activeTasks.get(taskId)
    if (!taskState) return
    taskState.resolvedPermissions = perms
    if (taskState.resumeWorkerContext) {
      taskState.resumeWorkerContext = { ...taskState.resumeWorkerContext, resolved_permissions: perms }
    }
    log(`[permissions] task ${taskId} permissions hot-refreshed`)
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

  /**
   * 中止某个 legacy AgentHandler task 的 worker loop。仅供该 handler 的本地 barrier
   * 终态兜底使用；不注册 Admin task lifecycle RPC，也不修改 Admin task 状态。
   * parked 在 barrier 上的 worker 会因 abortSignal 醒来，并在下一轮 LLM 前退出。
   *
   * @returns 是否找到活着的 worker（false = 本来就没在跑，abort 是 no-op）
   */
  abortWorker(taskId: TaskId, reason: string): boolean {
    const taskState = this.activeTasks.get(taskId)
    if (!taskState) return false
    log(`[abort-worker] task=${taskId} reason=${reason}`)
    taskState.abortController.abort()
    return true
  }

  cancelTask(taskId: TaskId, reason: string): void {
    // 兼容仍在同进程持有 legacy task 的内部调用；不修改 Admin task 状态。
    this.abortWorker(taskId, reason)
  }

  /**
   * 兜底：legacy barrier 超时自醒时，复查 Admin task 是否已经终态。
   *
   * task 已终态却继续运行会越过生命周期边界，因此这里静默 abort。Admin 不可达时
   * fail-open；只有明确读取到终态或 TASK_NOT_FOUND 时才停止本地 legacy worker。
   */
  async abortWorkerIfTaskTerminal(taskId: TaskId): Promise<void> {
    if (!this.deps?.getAdminPort || !this.deps.rpcClient) return
    if (!this.activeTasks.has(taskId)) return
    try {
      const adminPort = await this.deps.getAdminPort()
      const resp = await this.deps.rpcClient.call<
        { task_id: string },
        { task: { status: string } }
      >(adminPort, 'get_task', { task_id: taskId }, this.deps.moduleId)
      if (TERMINAL_TASK_STATUSES.has(resp.task.status)) {
        this.abortWorker(taskId, `task already ${resp.task.status} (barrier timeout guard)`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('TASK_NOT_FOUND')) {
        this.abortWorker(taskId, 'task no longer exists (barrier timeout guard)')
        return
      }
      log(`[abort-worker] terminal guard skipped task=${taskId}: ${msg}`)
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
            human_input_epoch: taskState.humanInputEpoch,
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

  getTaskResolvedPermissions(taskId: TaskId): ResolvedPermissions | undefined {
    return this.activeTasks.get(taskId)?.resolvedPermissions
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
   *   ① humanQueue.push(note)：同一套 barrier，无论 worker 用 ask_human 还是 end_turn 挂起都唤醒。
   *   ② transitionTaskStatus(taskId, 'executing')：把 ask_human 留下的 waiting_human 切回 executing；
   *      end_turn 场景本就 executing，是 no-op（transitionTaskStatus 自带幂等/智能恢复）。
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


const SUPPLEMENT_INJECTION_TEMPLATE_GOAL = `[实时纠偏 - 来自用户]
用户在任务执行期间发来了补充指示：

"{supplement_content}"

请结合当前任务进展，重新判断方向：

- 如果讨论到这里需求才明确清楚，且之前没设 goal → 现在可以 set_task_goal 写下承诺
- 如果已设过 goal 且新指示改变了原定要求 → 重新调一次 set_task_goal 改方向
  （系统已为你解锁一次重写机会）
- 如果只是小范围补充、方向不变 → 继续按原计划干，不需要改 goal
`

const SUPPLEMENT_INJECTION_TEMPLATE_BASIC = `[实时纠偏 - 来自用户]
用户在任务执行期间发来了补充指示：

"{supplement_content}"

请结合当前任务进展，调整你的执行方向。
`
