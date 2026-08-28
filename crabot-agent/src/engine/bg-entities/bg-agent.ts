/**
 * spawnPersistentAgent — fire-and-forget background sub-agent runner.
 *
 * Starts a runEngine() loop in the background, appends live-progress events
 * to a JSONL log on disk, and updates the registry on completion / failure.
 * Returns the agent_id immediately (non-blocking).
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-01-long-running-agent-design.md
 * Plan: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-2.md Task 12
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LLMAdapter } from '../llm-adapter.js'
import type { ToolDefinition, ToolPermissionConfig } from '../types.js'
import { runEngine } from '../query-loop.js'
import { getErrorMessage } from '../tools/utils.js'
import { getBgEntitiesLogsDir } from '../../core/data-paths.js'
import type { BgEntityRegistry } from './registry.js'
import type { BgEntityOwner, BgAgentRegistryRecord } from './types.js'
import { emitInstantSpan, type BgEntityTraceContext } from './trace.js'
import type { TraceStore } from '../../core/trace-store.js'
import { recordSubAgentTurn } from '../sub-agent-trace.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SpawnPersistentAgentOpts {
  /**
   * 子 agent 的完整输入 prompt——原样作为首条 user message 喂给 runEngine。
   * 与 task_description 严格分离：曾有 caller 把截断后的展示标签当 prompt 传，
   * 导致 auditor 看不到完整验收标准（2026-06-10 goal audit 死循环事故）。
   */
  readonly prompt: string
  /** 展示标签——只用于 registry / list_entities / exit notification，不进 LLM 输入。 */
  readonly task_description: string
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly systemPrompt: string
  readonly model: string
  /** Per-call max output tokens；缺省时让 adapter 走默认行为 */
  readonly maxTokens?: number
  /** 槽位思考强度；缺省 = 跟随模型默认 */
  readonly thinking?: import('../llm-adapter-types.js').LLMThinkingConfig
  readonly adapter: LLMAdapter
  /**
   * 工具权限配置——透传给 runEngine。不传时 checkToolPermission 对 dangerous 级
   * 工具（Bash 等）一律拒绝；audit subagent 曾因此永远跑不了 cmd criterion
   * （2026-06-10 goal audit 死循环事故，spec 2026-06-10-audit-anchor-human-request §4.6）。
   */
  readonly permissionConfig?: ToolPermissionConfig
  /** Worker execution hooks inherited by the child. */
  readonly hookRegistry?: import('../../hooks/hook-registry.js').HookRegistry
  readonly lspManager?: import('../../hooks/types.js').LspManagerLike
  /** The child has no human identity of its own. */
  readonly senderIsMaster?: boolean
  /** Permission snapshot used by hooks such as the CLI permission gate. */
  readonly resolvedPermissions?: import('../../types.js').ResolvedPermissions
  readonly owner: BgEntityOwner
  readonly spawned_by_task_id: string
  /** Actual configured child type, when the caller has one. */
  readonly subagent_type?: string
  readonly registry: BgEntityRegistry
  /** Worker-maintained abort-controller map: written on spawn, deleted on finish/kill. */
  readonly abortControllers: Map<string, AbortController>
  readonly traceContext?: BgEntityTraceContext
  /**
   * 这个 sub-agent 自己的子 trace 配置（与 traceContext 区分：traceContext 往
   * 父 trace emit bg_entity_* 生命周期 span；subTrace 是 sub-agent 自己的
   * `sub_agent_call` 子 trace，记录内部 llm/tool span，让它在 Admin Traces 页
   * 以独立行显示并可 drill-in）。
   *
   * audit subagent 必须传 taskType='goal_audit'（spec
   * 2026-06-07-goal-audit-async-buffered-info-design.md），否则审计跑完不在
   * Traces 页显示（异步化重构丢失子 trace 的回归）。
   */
  readonly subTrace?: {
    readonly traceStore: TraceStore
    readonly parentTraceId: string
    readonly parentSpanId?: string
    readonly relatedTaskId?: string
    /** trigger.task_type，如 'goal_audit'（驱动 Admin Traces 的"审计"badge）。 */
    readonly taskType?: string
    /** summary 前缀，如 '[goal_audit]'。缺省直接用 task_description。 */
    readonly summaryPrefix?: string
    /** 在 TraceStore 写入前脱敏子 Agent 的 assistant text。 */
    readonly redactText?: (text: string) => string
  }
  /**
   * Async exit hook —— sub-agent loop 自然结束 / 失败时调用（killed 由 Kill 工具发出，不走这里）。
   * 用于 worker 推 push notification。抛错只 log。
   *
   * `outcome` / `exitToolCall` / `finalText` 透传 runEngine 的结构化 result，给
   * audit subagent 这类 caller（onExit 需要解析 verdict）用，免得再去读 result_file
   * 反序列化裸文本（result_file 当前只存 finalText）。runEngine 走 catch 路径时
   * 这些字段不填——caller 用 status='failed' 走 sentinel。
   */
  readonly onExit?: (info: {
    entity_id: string
    task_description: string
    status: 'completed' | 'failed'
    exit_code: number
    runtime_ms: number
    spawned_at: string
    result_file: string | null
    /** subTrace 开启时创建的 child trace id；不同于 bg entity_id。 */
    trace_id?: string
    /** 失败原因（status='failed' 时填），供 caller 把失败原因回传给父 agent / 通知人类。 */
    error?: string
    outcome?: 'completed' | 'failed' | 'max_turns' | 'aborted'
    exitToolCall?: { readonly name: string; readonly input: Record<string, unknown> }
    finalText?: string
  }) => void | Promise<void>
}

/**
 * Spawn a persistent background agent loop.
 *
 * - Registers an entry in the registry with status='running' before returning.
 * - Starts `runEngine()` in a detached async IIFE (fire-and-forget).
 * - Each LiveProgressEvent is appended as a JSON line to `<logsDir>/<id>.jsonl`.
 * - On completion, writes `<logsDir>/<id>.result.txt` and updates registry.
 * - On abort or error, updates registry to status='failed' (registry.update
 *   guards against overwriting an already-killed status).
 *
 * @returns The generated entity_id (format: `agent_<12 hex chars>`)
 */
export async function spawnPersistentAgent(opts: SpawnPersistentAgentOpts): Promise<string> {
  const entity_id = `agent_${randomBytes(6).toString('hex')}`
  const logsDir = getBgEntitiesLogsDir()
  await fs.promises.mkdir(logsDir, { recursive: true })

  const messagesLog = path.join(logsDir, `${entity_id}.jsonl`)

  const abortController = new AbortController()
  opts.abortControllers.set(entity_id, abortController)

  // 子 trace 在 fire-and-forget 外同步起，保证 spawn 返回时 Admin Traces 立刻可见。
  const subTrace = opts.subTrace
    ? opts.subTrace.traceStore.startTrace({
        module_id: 'sub-agent',
        trigger: {
          type: 'sub_agent_call',
          summary: (opts.subTrace.summaryPrefix
            ? `${opts.subTrace.summaryPrefix} ${opts.task_description}`
            : opts.task_description
          ).slice(0, 200),
          ...(opts.subTrace.taskType ? { task_type: opts.subTrace.taskType } : {}),
        },
        parent_trace_id: opts.subTrace.parentTraceId,
        ...(opts.subTrace.parentSpanId ? { parent_span_id: opts.subTrace.parentSpanId } : {}),
        ...(opts.subTrace.relatedTaskId ? { related_task_id: opts.subTrace.relatedTaskId } : {}),
      })
    : undefined
  const subTraceStore = opts.subTrace?.traceStore

  const now = new Date().toISOString()
  const record: BgAgentRegistryRecord = {
    entity_id,
    type: 'agent',
    ...(opts.subagent_type ? { subagent_type: opts.subagent_type } : {}),
    ...(subTrace ? { trace_id: subTrace.trace_id } : {}),
    status: 'running',
    task_description: opts.task_description,
    messages_log_file: messagesLog,
    result_file: null,
    owner: opts.owner,
    spawned_by_task_id: opts.spawned_by_task_id,
    spawned_at: now,
    exit_code: null,
    ended_at: null,
    last_activity_at: now,
  }
  await opts.registry.register(record)

  const agentSpawnedAtMs = Date.now()

  // fire-and-forget — intentionally not awaited by caller
  void (async () => {
    try {
      const result = await runEngine({
        prompt: opts.prompt,
        adapter: opts.adapter,
        options: {
          systemPrompt: opts.systemPrompt,
          tools: [...opts.tools],
          model: opts.model,
          ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
          ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
          ...(opts.permissionConfig ? { permissionConfig: opts.permissionConfig } : {}),
          hookRegistry: opts.hookRegistry,
          lspManager: opts.lspManager,
          senderIsMaster: opts.senderIsMaster,
          resolvedPermissions: opts.resolvedPermissions,
          abortSignal: abortController.signal,
          // 同 forkEngine：bg-agent 也是 subagent 派发路径，禁用 compaction。
          // 详见 EngineOptions.disableCompaction 注释。
          disableCompaction: true,
          ...(subTrace && subTraceStore
            ? {
                onTurn: (event) =>
                  recordSubAgentTurn(subTraceStore, subTrace.trace_id, event, opts.subTrace?.redactText),
              }
            : {}),
          onLiveProgress: (event) => {
            // Append event as a JSONL line; errors are silently swallowed so
            // logging failures never crash the agent loop.
            void fs.promises
              .appendFile(messagesLog, JSON.stringify(event) + '\n')
              .catch(() => {})
            // Bump last_activity_at on every progress event.
            void opts.registry
              .update(entity_id, {
                last_activity_at: new Date().toISOString(),
              } as Partial<BgAgentRegistryRecord>)
              .catch(() => {})
          },
        },
      })

      // Write result file and update registry on successful completion.
      const resultFile = path.join(logsDir, `${entity_id}.result.txt`)
      await fs.promises.writeFile(resultFile, result.finalText ?? '', 'utf-8')

      const endedStatus =
        result.outcome === 'completed' ? ('completed' as const) : ('failed' as const)
      const exitCode = result.outcome === 'completed' ? 0 : 1
      const runtimeMs = Date.now() - agentSpawnedAtMs
      // 失败原因：一路透传给 trace / registry / onExit，让父 agent 能拿到失败原因。
      const failureError = endedStatus === 'failed' && result.error ? result.error : undefined
      if (opts.traceContext) {
        emitInstantSpan(opts.traceContext, 'bg_entity_exit', {
          entity_id,
          type: 'agent',
          status: endedStatus,
          exit_code: exitCode,
          runtime_ms: runtimeMs,
        }, endedStatus)
      }
      if (subTrace && subTraceStore) {
        subTraceStore.endTrace(subTrace.trace_id, endedStatus, {
          summary: (result.finalText ?? '').slice(0, 200),
          ...(failureError ? { error: failureError.slice(0, 200) } : {}),
        })
      }
      await opts.registry
        .update(entity_id, {
          status: endedStatus,
          result_file: resultFile,
          exit_code: exitCode,
          ended_at: new Date().toISOString(),
          ...(failureError ? { error: failureError } : {}),
        } as Partial<BgAgentRegistryRecord>)
        .catch(() => {})
      if (opts.onExit) {
        try {
          await opts.onExit({
            entity_id,
            task_description: opts.task_description,
            status: endedStatus,
            exit_code: exitCode,
            runtime_ms: runtimeMs,
            spawned_at: now,
            result_file: resultFile,
            ...(subTrace ? { trace_id: subTrace.trace_id } : {}),
            ...(failureError ? { error: failureError } : {}),
            outcome: result.outcome,
            ...(result.exitToolCall ? { exitToolCall: result.exitToolCall } : {}),
            finalText: result.finalText ?? '',
          })
        } catch (err) {
          console.error(`[bg-agent] onExit callback failed for ${entity_id}:`, err)
        }
      }
    } catch (err) {
      // Handles both abort and unexpected errors.
      // registry.update's status-guard prevents overwriting an already-killed entry.
      const runtimeMs = Date.now() - agentSpawnedAtMs
      const errMsg = getErrorMessage(err) || 'sub-agent aborted or errored'
      if (opts.traceContext) {
        emitInstantSpan(opts.traceContext, 'bg_entity_exit', {
          entity_id,
          type: 'agent',
          status: 'failed',
          exit_code: 1,
          runtime_ms: runtimeMs,
        }, 'failed')
      }
      if (subTrace && subTraceStore) {
        subTraceStore.endTrace(subTrace.trace_id, 'failed', {
          summary: errMsg.slice(0, 200),
          error: errMsg.slice(0, 200),
        })
      }
      await opts.registry
        .update(entity_id, {
          status: 'failed' as const,
          exit_code: 1,
          ended_at: new Date().toISOString(),
          error: errMsg,
        } as Partial<BgAgentRegistryRecord>)
        .catch(() => {})
      if (opts.onExit) {
        try {
          await opts.onExit({
            entity_id,
            task_description: opts.task_description,
            status: 'failed',
            exit_code: 1,
            runtime_ms: runtimeMs,
            spawned_at: now,
            result_file: null,
            ...(subTrace ? { trace_id: subTrace.trace_id } : {}),
            error: errMsg,
          })
        } catch (err) {
          console.error(`[bg-agent] onExit callback failed for ${entity_id}:`, err)
        }
      }
    } finally {
      opts.abortControllers.delete(entity_id)
    }
  })()

  return entity_id
}
