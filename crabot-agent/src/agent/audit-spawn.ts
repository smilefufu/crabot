/**
 * spawnAuditSubagent — 异步派出 goal audit subagent。
 *
 * 与 runGoalAudit（同步阻塞）的区别：本 helper 通过 spawnPersistentAgent 把 audit
 * 派成后台 bg-agent，立即返回 entity_id（不等 audit 完成）。audit 完成时由 bg-agent
 * 的 onExit 回调把 `<audit_result>` marker push 到 humanQueue —— main loop 后续
 * drainPending 自然读到这条 marker 并走 pass/fail 分支（Task 11 实现）。
 *
 * Spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.3 + §4.5
 *
 * 注意：本模块只负责"派出 + onExit 推 marker"。
 *  - 不写 admin audit_history（async 路径下，写历史由 Task 10/11 的 onExit 后续处理）
 *  - 不切 goal status（同上）
 *  - 不动 outboundBuffer（buffer 的 flush/discard 由 Task 11 的 drain 处理）
 */

import { spawnPersistentAgent } from '../engine/bg-entities/bg-agent.js'
import {
  buildAuditPrompt,
  resolveAuditJudgment,
  buildAuditVerdictSummary,
  type ConversationEntry,
  type GoalAuditTaskGoal,
  type ParsedAuditReport,
} from './goal-audit.js'
import { buildAuditResultMarker } from './audit-result-marker.js'
import { filterToolsForSubAgent } from './subagent-tool-filter.js'
import { assembleSubAgentPrompt } from './subagent-prompt-assembler.js'
import { createSubmitAuditResultTool } from './goal-auditor-tools.js'
import type { HumanMessageQueue } from '../engine/human-message-queue.js'
import type { LLMAdapter } from '../engine/llm-adapter.js'
import type { ToolDefinition } from '../engine/types.js'
import type { BgEntityOwner } from '../engine/bg-entities/types.js'
import type { BgEntityRegistry } from '../engine/bg-entities/registry.js'
import type { BgEntityTraceContext } from '../engine/bg-entities/trace.js'
import type { SubAgentConfig } from '../types.js'

/**
 * bg-agent onExit info shape —— 与 SpawnPersistentAgentOpts.onExit 对齐。
 * 直接 import 会与 bg-agent.ts 形成隐性强耦合，这里 inline 重复以保持解耦。
 */
export interface BgAgentExitInfo {
  readonly entity_id: string
  readonly task_description: string
  readonly status: 'completed' | 'failed'
  readonly exit_code: number
  readonly runtime_ms: number
  readonly spawned_at: string
  readonly result_file: string | null
  readonly trace_id?: string
  readonly outcome?: 'completed' | 'failed' | 'max_turns' | 'aborted'
  readonly exitToolCall?: { readonly name: string; readonly input: Record<string, unknown> }
  readonly finalText?: string
}

export interface SpawnAuditSubagentDeps {
  /** Goal 全文（系统侧已通过 admin RPC 取到）—— buildAuditPrompt 用。 */
  readonly goal: GoalAuditTaskGoal
  /** 任务期间对话记录（auditor 视角的"证据" verdict 输入）—— buildAuditPrompt 用。 */
  readonly conversationLog: ReadonlyArray<ConversationEntry>
  /** 工作目录（auditor prompt 里 cwd 字段）。 */
  readonly cwd: string
  /** 父任务 ID —— bg-agent 关联归属 + prompt 装配的 callerLabel 参考。 */
  readonly parentTaskId: string

  /** goal_auditor 子 agent 配置（model / hook_preset / capabilities / max_turns 等）。 */
  readonly auditor: SubAgentConfig
  /** worker baseTools —— audit subagent 在其上做 capability filter。缺省 [] 会让 auditor
   *  没工具可用导致永远 fail（详见 runGoalAudit 同名警示）。 */
  readonly parentTools: ReadonlyArray<ToolDefinition>
  /** worker 同款权限配置——不传时 runEngine 对 dangerous 工具（Bash）默认拒绝，
   *  auditor 永远验不了 cmd criterion（2026-06-10 死循环事故）。 */
  readonly permissionConfig?: import('../engine/types.js').ToolPermissionConfig
  /** audit subagent 用的 LLMAdapter（auditor.model 解析后建好的 adapter）。 */
  readonly adapter: LLMAdapter

  /** bg-agent 归属 owner（友 friend + session）。audit subagent 跟父任务同 owner。 */
  readonly owner: BgEntityOwner
  /** bg-agent registry 实例。 */
  readonly registry: BgEntityRegistry
  /** worker 维护的 abortController map —— spec §4.7 abort audit 走这个 map。 */
  readonly abortControllers: Map<string, AbortController>
  /** trace 挂载（可选）：传入则 audit 子 trace 挂到父 trace 下。 */
  readonly traceContext?: BgEntityTraceContext

  /** audit 完成时 onExit 回调推 marker 的目的地 queue。 */
  readonly humanQueue: HumanMessageQueue

  /**
   * audit verdict 解析完成后的系统回调。
   * 用于 async audit 路径把判决持久化到 admin audit_history，并 patch audit trace
   * 顶层 outcome。失败只记录，不影响 marker push 回 worker loop。
   */
  readonly onAuditResult?: (result: {
    readonly auditId: string
    readonly parsed: ParsedAuditReport
    readonly verdictSummary: { readonly summary: string; readonly error?: string }
  }) => void | Promise<void>

  /**
   * 测试 hook —— 默认走真 spawnPersistentAgent；测试里 inject mock 控制 onExit 触发时序。
   */
  readonly spawnFn?: typeof spawnPersistentAgent
}

/**
 * 异步派出 audit subagent。立即返回 entity_id 作为 audit_id。
 * audit 完成时 onExit 回调把 <audit_result> marker push 到 humanQueue（unconditional —
 * pass/fail/sentinel 都 push，后续 drain 分支自己判断）。
 *
 * onExit 回调内的所有错误（marker 构造失败 / push 失败 / verdict 解析挂掉）都被 catch
 * 后落 console.error —— 绝不能 throw，否则 bg-agent fire-and-forget 路径里没人接，
 * 会变成 unhandled rejection 干掉 agent 主进程（feedback_spawn_error_listener_timing
 * 的同款风险）。
 */
export async function spawnAuditSubagent(
  deps: SpawnAuditSubagentDeps,
): Promise<string> {
  // 1. 拼 auditor 的输入 prompt（worker 不插手）
  const promptText = buildAuditPrompt({
    goal: deps.goal,
    conversationLog: deps.conversationLog,
    cwd: deps.cwd,
  })

  // 2. 装 audit subagent 的工具集 —— 同 runGoalAudit 路径：
  //    a. 父工具按 capability filter 子集（file_system+shell）
  //    b. concat 注入 submit_audit_result exitsLoop 工具
  const filteredSubTools = filterToolsForSubAgent(
    deps.parentTools,
    deps.auditor.builtin_capabilities,
    deps.auditor.allowed_mcp_server_ids,
    deps.auditor.allowed_skill_ids,
  )
  const subTools: ReadonlyArray<ToolDefinition> = [
    ...filteredSubTools,
    createSubmitAuditResultTool(),
  ]

  // 3. 装系统 prompt（5-section subagent prompt）
  const systemPrompt = assembleSubAgentPrompt(deps.auditor, {
    parentTaskId: deps.parentTaskId,
    callerLabel: 'goal_audit (async)',
  })

  // 4. 派 bg-agent
  const spawn = deps.spawnFn ?? spawnPersistentAgent
  const auditId = await spawn({
    prompt: promptText,
    task_description: `[goal_audit] ${promptText.slice(0, 200)}`,
    tools: subTools,
    ...(deps.permissionConfig ? { permissionConfig: deps.permissionConfig } : {}),
    systemPrompt,
    model: deps.auditor.model.model_id,
    ...(deps.auditor.model.max_tokens !== undefined
      ? { maxTokens: deps.auditor.model.max_tokens }
      : {}),
    adapter: deps.adapter,
    owner: deps.owner,
    spawned_by_task_id: deps.parentTaskId,
    registry: deps.registry,
    abortControllers: deps.abortControllers,
    ...(deps.traceContext ? { traceContext: deps.traceContext } : {}),
    // audit 自己的 sub_agent_call 子 trace（taskType='goal_audit'）—— 让审计跑完
    // 在 Admin Traces 页以"审计"行显示并可 drill-in（spec 2026-06-07）。
    ...(deps.traceContext
      ? {
          subTrace: {
            traceStore: deps.traceContext.traceStore,
            parentTraceId: deps.traceContext.traceId,
            relatedTaskId: deps.parentTaskId,
            taskType: 'goal_audit',
            summaryPrefix: '[goal_audit]',
          },
        }
      : {}),
    onExit: async (info) => {
      await handleAuditExit(info as BgAgentExitInfo, deps)
    },
  })

  return auditId
}

/**
 * audit subagent 退出回调：解析 verdict → 构造 marker → push humanQueue。
 *
 * 所有失败路径都被 try/catch 包住——bg-agent 的 onExit 在 fire-and-forget 异步 IIFE
 * 内调用，throw 会逃逸成 unhandled rejection。
 */
async function handleAuditExit(
  info: BgAgentExitInfo,
  deps: Pick<SpawnAuditSubagentDeps, 'goal' | 'humanQueue' | 'onAuditResult'>,
): Promise<void> {
  try {
    const parsed = resolveAuditJudgmentFromExitInfo(info)
    const verdictSummary = buildAuditVerdictSummary(parsed, deps.goal)
    const auditTraceId = info.trace_id ?? info.entity_id
    if (deps.onAuditResult) {
      try {
        await deps.onAuditResult({
          auditId: auditTraceId,
          parsed,
          verdictSummary,
        })
      } catch (err) {
        console.error(`[audit-spawn] onAuditResult failed for ${info.entity_id}:`, err)
      }
    }
    const reportParts = [verdictSummary.summary]
    if (verdictSummary.error) reportParts.push(verdictSummary.error)
    if (parsed.rawOutput) reportParts.push(parsed.rawOutput)
    const detailedReport = sanitizeReport(reportParts.filter(Boolean).join('\n\n'))

    const marker = buildAuditResultMarker({
      auditId: info.entity_id,
      pass: parsed.pass,
      failedCriteria: parsed.failedCriteria,
      detailedReport,
    })
    deps.humanQueue.push(marker)
  } catch (err) {
    // 绝不抛——bg-agent fire-and-forget 路径下抛会变 unhandled rejection。
    console.error(`[audit-spawn] onExit handler failed for ${info.entity_id}:`, err)
  }
}

/**
 * 把 bg-agent onExit info 转换为 resolveAuditJudgment 的输入。
 *
 * - bg-agent 失败路径（catch 分支）拿不到 outcome/exitToolCall/finalText → 走 sentinel
 *   （resolveAuditJudgment 收到 outcome=undefined 会 fall through 到 Layer 3 free-text
 *   parse；finalText 也为 undefined → parseAuditReport 在空字符串上必然给 sentinel）。
 * - bg-agent 完成路径有完整字段 → 走 Layer 1 (tool call) → Layer 2 (异常 outcome)
 *   → Layer 3 (free-text fallback)。
 */
export function resolveAuditJudgmentFromExitInfo(
  info: BgAgentExitInfo,
): ParsedAuditReport {
  return resolveAuditJudgment({
    ...(info.exitToolCall ? { exitToolCall: info.exitToolCall } : {}),
    rawOutput: info.finalText ?? '',
    ...(info.outcome ? { outcome: info.outcome } : {}),
  })
}

/**
 * marker 构造前做最小化清洗：把可能出现在 verdict summary / rawOutput 里的
 * forbidden literal 直接替换掉，避免被 buildAuditResultMarker 严格校验 throw。
 *
 * 选 replace 而不是 throw：sentinel/raw evidence 是 LLM 输出，可能任意位置出现
 * 闭合标签字符串，对 caller 来说这条 audit 仍然要传达——不能因为字符匹配丢掉判决。
 */
function sanitizeReport(text: string): string {
  return text
    .replace(/<\/audit_result>/g, '<​/audit_result>')
    .replace(/<\/detailed_report>/g, '<​/detailed_report>')
}
