import type { LLMAdapter } from './llm-adapter'
import { callNonStreaming } from './llm-adapter'
import type {
  ContentBlock,
  EngineMessage,
  EngineOptions,
  EngineResult,
  EngineTurnEvent,
  RawReasoningBlock,
  ToolUseBlock,
} from './types'
import {
  createUserMessage,
  createAssistantMessage,
  createBatchToolResultMessage,
} from './types'
import { ContextManager } from './context-manager'
import { partitionToolCalls } from './tool-framework'
import { executeToolBatches, type HookConfig } from './tool-orchestration'
import { compressToolResultImages, pruneOldImages } from './image-utils'
import { formatError } from './error-utils'
import type { HookInput } from '../hooks/types'
import { executeHooks } from '../hooks/hook-executor'
import { parseSystemMarker, type AuditResultMarker } from '../agent/audit-result-marker.js'
import * as fs from 'fs'
import { getWorkspaceDir } from '../core/data-paths.js'

// --- Public Interface ---

export interface RunEngineParams {
  readonly prompt: string | import('./types').ContentBlock[]
  readonly adapter: LLMAdapter
  readonly options: EngineOptions
  /** 从已有消息历史恢复，跳过初始 createUserMessage(prompt)。用于 waiting→executing 续跑。 */
  readonly initialMessages?: EngineMessage[]
}

const DEFAULT_MAX_TURNS = 200
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000

// 推理类模型偶尔以 end_turn 结束但只发 reasoning 不发 text。注入追问让其重说，
// 超过上限仍空就老实返回空 finalText——绝不让另一个 LLM 替它编。
const MAX_SILENT_END_TURN_RETRIES = 3

// stop_reason='max_tokens' + text='' 走独立计数器：单纯加 prompt 会让 input 更大、
// reasoning 烧得更多，必须先压缩再重跑。
const MAX_MAX_TOKENS_COMPACT_RETRIES = 2

// audit 跑中 LLM 直接 end_turn 兜底拦截（Task 13）：drain 之后若仍有活跃 audit
// + LLM 想 end_turn，engine 注入提示拦截续 loop，最多 3 次后 abort active audit
// + 放行 end_turn。独立计数器，跟 silentEndTurnCount 不复用——前者是"没说话"
// 后者是"audit 在跑你不能走"，语义不同。
// spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.6
const MAX_AUDIT_PENDING_END_TURN_RETRIES = 3
const AUDIT_PENDING_END_TURN_PROMPT =
  '你不能直接 end_turn——audit 仍在跑。请调 wait_for_signal 等审完成，或调其他工具响应当前任务。'

// 规则细节由 agent 自己的 system prompt 维护（assembleAgentPrompt 的 end_turn
// self-check + 收尾责任段），这里只做 engine 层的机制兜底钩子——告诉模型违反了
// 哪条规则、要求重新汇报。把规则写两份会产生维护漂移。
// 注：caller 可传 suppressForcedSummary 跳过此机制（已发 info 消息 / 有 goal / scheduled 任务时）。
const FORCED_SUMMARY_PROMPT =
  '你刚才以 end_turn 结束但还没有向人类发送任何内容。\n' +
  '如果本次任务有需要告知的结果或进度，请调用 send_message 工具发出后再 end_turn。'

// 缓冲消息延迟 flush 时发送失败（如文件路径不对 / channel 挂了 / session 没了），失败发生在
// 工具调用轮之外、无法走工具返回值回传。engine 把失败摘要+原因注入给 worker，让它修正重发
// 或如实告知人类——而不是让失败被静默吞掉、worker 误以为已送达（trace a72623ec 成因之二）。
const MAX_OUTBOUND_FLUSH_FAILURE_RETRIES = 3
function buildOutboundFlushFailurePrompt(
  failures: ReadonlyArray<{ readonly summary: string; readonly error: string }>,
): string {
  const lines = failures.map((f) => `  - "${f.summary}"：${f.error}`).join('\n')
  return (
    '[系统] 你刚才要发给用户的消息没有成功发出，用户没有收到：\n' +
    lines +
    '\n请修正问题后重新用 send_message 发送；如果确实发不出去，用人话如实告诉用户你遇到的情况（不要提系统内部细节）。'
  )
}
/** 续轮重试耗尽后写进 task 失败原因（EngineResult.error）的文案——让人能直接看出哪条没发出、为什么。 */
function buildOutboundFlushFailureReason(
  failures: ReadonlyArray<{ readonly summary: string; readonly error: string }>,
): string {
  const lines = failures.map((f) => `"${f.summary}"（${f.error}）`).join('；')
  return (
    `有消息始终无法送达用户：连续 ${MAX_OUTBOUND_FLUSH_FAILURE_RETRIES} 轮重试后仍发送失败 —— ${lines}。`
    + '任务未能把结果交付给用户。'
  )
}

// drain 路径分流结果：caller 决定是否 early-return buildResult('completed')。
// spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.5
interface DrainDispatchResult {
  /** 经 marker 分流后剩下的 user message 内容（非 marker 部分），由 caller 注入到 messages */
  readonly remainingTexts: ReadonlyArray<string | ContentBlock[]>
  /** true 时 caller 应 buildResult('completed') 直接退出（audit pass + 无后续 pending） */
  readonly shouldExitCompleted: boolean
  /** audit pass 后 flush 缓冲交付失败、且重试已耗尽 → caller 应 buildResult('failed', …, 此原因)。 */
  readonly flushFailedReason?: string
}

/** 缓冲 flush + 交付追踪的统一入口签名（见 runEngine 内 flushAndTrackDelivery）。
 *  'ok'=无失败；'retry'=有失败未超限（已注入提示让 worker 重发）；{failedReason}=重试耗尽。 */
type FlushDeliveryTracker = () => Promise<'ok' | 'retry' | { readonly failedReason: string }>

/**
 * 把 humanQueue.drainPending 的内容按 system marker 分流：
 *   - audit_result.pass=true  → 调 flushOutboundBuffer + clearActiveAuditId；无后续 pending 时 shouldExitCompleted=true
 *   - audit_result.pass=false → 调 dropOutboundBuffer + clearActiveAuditId；注入 detailedReport 让 agent 续作
 *   - audit_aborted          → 调 clearActiveAuditId；注入"原 audit 已废"提示
 *   - audit_pending          → 防御性当 user message 转发（理论上不会通过 drain 出现，它是 endTurnGate 注入路径）
 *   - 其他文本 / ContentBlock[] → 透传到 remainingTexts
 *
 * 副作用：直接对 messages 数组 push（marker fail/aborted 的注入消息）；marker 处理后调对应 EngineOptions 钩子。
 * remainingTexts 由 caller 负责注入——helper 不直接 push 普通 supplement 以保留 caller 的 trace 注入逻辑。
 */
async function drainAndDispatchMarkers(
  drained: ReadonlyArray<string | ContentBlock[]>,
  options: EngineOptions,
  messages: EngineMessage[],
  totalTurns: number,
  flushAndTrack?: FlushDeliveryTracker,
): Promise<DrainDispatchResult> {
  const remainingTexts: Array<string | ContentBlock[]> = []
  const auditResults: AuditResultMarker[] = []
  let hasAborted = false
  const abortedTexts: string[] = []
  // audit pass 后 flush 交付失败：任一失败都阻止"静默标完成"；超限时 flushFailedReason 让 caller 标失败。
  let auditPassFlushHadFailure = false
  let flushFailedReason: string | undefined

  for (const content of drained) {
    if (typeof content !== 'string') {
      remainingTexts.push(content)
      continue
    }
    const marker = parseSystemMarker(content)
    if (marker === null) {
      remainingTexts.push(content)
      continue
    }
    if (marker.type === 'audit_result') {
      auditResults.push(marker)
    } else if (marker.type === 'audit_aborted') {
      hasAborted = true
      abortedTexts.push(
        `[系统] 你之前的 audit (${marker.auditId}) 已被取消（${marker.reason || '原因未提供'}）。请按当前 task.goal 继续行动。`,
      )
    } else {
      // audit_pending：理论上不会从 drainPending 出来（它由 endTurnGate 直接 return 注入），
      // 防御性当作 user message 透传给 agent。
      remainingTexts.push(content)
    }
  }

  // 处理 audit_aborted（在 audit_result 之前清掉 activeAuditId，再注入提示）
  if (hasAborted) {
    options.clearActiveAuditId?.()
    for (const text of abortedTexts) {
      messages.push(createUserMessage(text))
      options.onSystemInjection?.({
        type: 'supplement',
        text,
        turnNumber: totalTurns,
        injectedAtMs: Date.now(),
      })
    }
  }

  // 处理 audit_result：通常一条；若多条按顺序处理（最后一条决定 final 行为）。
  let lastPass: boolean | null = null
  for (const result of auditResults) {
    options.clearActiveAuditId?.()
    if (result.pass) {
      // pass：engine 内部 flush buffer，不作为 user message 注入。
      // flushAndTrack 内部处理 flush + pending 追踪 + 失败提示注入：
      //   'retry' → 提示已进 messages，置 auditPassFlushHadFailure 阻止静默标完成；
      //   {failedReason} → 重试耗尽，让 caller 标失败。
      const r = flushAndTrack ? await flushAndTrack() : 'ok'
      if (r === 'retry') {
        auditPassFlushHadFailure = true
      } else if (r !== 'ok') {
        flushFailedReason = r.failedReason
      }
      lastPass = true
    } else {
      // fail：丢弃 buffer + 注入 detailedReport 让 worker 续作
      options.dropOutboundBuffer?.()
      const failReport = formatAuditFailReport(result)
      messages.push(createUserMessage(failReport))
      options.onSystemInjection?.({
        type: 'supplement',
        text: failReport,
        turnNumber: totalTurns,
        injectedAtMs: Date.now(),
      })
      lastPass = false
    }
  }

  // shouldExitCompleted：最后一条 audit_result.pass=true，且没有任何后续要 agent 响应的内容
  //（无剩余 user message、无 aborted 提示、humanQueue 也没新 pending）。
  // hasPending 此刻已被 drain 清空（drainPending 是消费性），但 drain-and-process 期间可能
  // 又被 push 进新 supplement，所以再 check 一次 hasPending。
  const stillHasPending = options.humanMessageQueue?.hasPending === true
  const shouldExitCompleted =
    lastPass === true &&
    remainingTexts.length === 0 &&
    !hasAborted &&
    !stillHasPending &&
    !auditPassFlushHadFailure

  return {
    remainingTexts,
    shouldExitCompleted,
    ...(flushFailedReason !== undefined ? { flushFailedReason } : {}),
  }
}

/** 构造 audit fail 时注入给 worker 的 user message 文案。
 *  框架：差距对照的是"人类的要求"而非 worker 自己的承诺（判决锚点 = 人类原话，
 *  spec 2026-06-10-audit-anchor-human-request §3.5），并明确给出两条出口。 */
function formatAuditFailReport(result: AuditResultMarker): string {
  const lines: string[] = [
    '[crabot 内部 / 仅你可见] 自检发现交付与人类的要求还有差距——这是你和系统之间的事，人类看不见，不要把这段内容转给人类。',
    '',
  ]
  if (result.failedCriteria.length > 0) {
    lines.push(`## 人类要求里还没满足的（${result.failedCriteria.length} 项）`)
    for (const c of result.failedCriteria) {
      lines.push(`- ${c}`)
    }
    lines.push('')
  }
  if (result.detailedReport) {
    lines.push('## 详细报告（含自检对人类要求的提炼，理解有误可在续作中用证据反驳）')
    lines.push(result.detailedReport)
    lines.push('')
  }
  lines.push('## 接下来')
  lines.push('- 补完缺口后重新 send_message 交付，系统会自动再审；不要原样重发同一条消息')
  lines.push(
    '- 客观做不到 / 人类要求自相矛盾 / 你认为自检理解错了需求 → '
    + "send_message(intent='ask_human') 向人类说明情况（用人话，不要提自检机制或贴这段报告）",
  )
  return lines.join('\n')
}

// endTurnGate 'wait' 路径的挂起超时兜底——与 WAIT_FOR_SIGNAL_TIMEOUT_MS 对齐（24 小时）。
// 正常路径不依赖它：audit onExit 必然 push marker 唤醒。
const GATE_WAIT_BARRIER_TIMEOUT_MS = 24 * 60 * 60 * 1000

/**
 * endTurnGate 返回 { kind: 'wait' } 后的挂起处理：audit 已异步派出，engine 直接
 * setBarrier + waitBarrier 等 humanQueue push（audit 结果 / 用户 supplement），唤醒后
 * 走 drainAndDispatchMarkers 既有分流。全程不烧 LLM 轮次——取代旧的「注入
 * [audit_pending] 文本 → LLM 读完整上下文 → 调 wait_for_signal」往返（每轮 audit
 * 浪费一次全量 context 的 LLM 调用）。
 *
 * 返回 'exit' → caller buildResult('completed') 退出（audit pass + 无后续 pending，
 * flush 已在 dispatch 内完成）；'continue' → caller continue 进下一轮 LLM。
 * spec: 2026-06-10-audit-anchor-human-request-design.md §4.7
 */
async function waitGateAuditAndDispatch(
  options: EngineOptions,
  messages: EngineMessage[],
  totalTurns: number,
  abortSignal?: AbortSignal,
  flushAndTrack?: FlushDeliveryTracker,
): Promise<'exit' | 'continue' | { readonly failedReason: string }> {
  const queue = options.humanMessageQueue
  if (!queue) {
    // 防御：audit gate 必然由带 humanQueue 的 worker loop 注入；缺 queue 无从等待，
    // fail-open 放行 end_turn（audit 结果将无人消费，但不能让 loop 永久挂死）。
    return 'exit'
  }
  // push 先于挂起到达（如 supplement 已 pending）→ 跳过 barrier 直接 drain，避免错过唤醒。
  if (!queue.hasPending) {
    queue.setBarrier(GATE_WAIT_BARRIER_TIMEOUT_MS)
    await queue.waitBarrier(abortSignal)
  }
  const drained = queue.drainPending()
  const dispatch = await drainAndDispatchMarkers(drained, options, messages, totalTurns, flushAndTrack)
  // audit pass 后交付始终发不出去、重试耗尽 → 让 caller 把任务标失败（不静默标完成）。
  if (dispatch.flushFailedReason) return { failedReason: dispatch.flushFailedReason }
  if (dispatch.shouldExitCompleted) return 'exit'
  for (const content of dispatch.remainingTexts) {
    messages.push(createUserMessage(content))
    options.onSystemInjection?.({
      type: 'supplement',
      text: typeof content === 'string' ? content : '[ContentBlock[] supplement]',
      turnNumber: totalTurns,
      injectedAtMs: Date.now(),
    })
  }
  return 'continue'
}

// --- Core Loop ---

export async function runEngine(params: RunEngineParams): Promise<EngineResult> {
  const { prompt, adapter, options, initialMessages } = params
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  const abortSignal = options.abortSignal

  const messages: EngineMessage[] = initialMessages ? [...initialMessages] : [createUserMessage(prompt)]
  const contextManager = new ContextManager({
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  })

  // 外部 observer（progress digest 等）通过 messagesRef 只读访问当前 messages。
  // 每轮 onTurn 之前以及主循环开头各刷新一次 —— 足以让定时 flush（≥秒级间隔）
  // 看到最近一轮的对话快照，主 loop 自身零开销（仅 slice）。
  const messagesRef = options.messagesRef
  const refreshMessagesRef = (): void => {
    if (messagesRef) {
      messagesRef.current = messages.slice()
    }
  }
  const fireOnTurn = (event: EngineTurnEvent): void => {
    refreshMessagesRef()
    options.onTurn?.(event)
  }

  let totalTurns = 0
  let finalText = ''
  let silentEndTurnCount = 0
  let outboundFlushFailureRetries = 0
  // 未解决的交付失败：flush 失败后置上，只有后续真正送出至少一条（sentCount>0）才清除。
  // 收尾时若仍非 null → 标 failed，避免"worker 续轮不重发、直接 end_turn，空 buffer flush 被当成送达"
  // 的静默完成（PR #8 review Finding 1）。
  let pendingDeliveryFailure: string | null = null
  let maxTokensCompactRetryCount = 0
  // Task 13: audit 跑中 LLM 直接 end_turn 兜底拦截计数器，独立于 silentEndTurnCount。
  // spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.6
  let auditPendingEndTurnRetries = 0
  // 由上一轮追问设置、下一轮 onTurn 消费一次后清零。
  let pendingForcedSummaryAttempt: number | undefined = undefined

  // skipReflection 判定信号（spec 2026-06-03 §7.2.1）：
  // - tool_call_count: 每 turn 处理后累加 toolUseBlocks.length
  // - wrote_memory_or_scene: worker 调用过 store_memory 或 set_scene_profile 任一即置 true
  let toolCallCount = 0
  let wroteMemoryOrScene = false
  const REFLECTION_TRIGGER_TOOLS = new Set(['store_memory', 'set_scene_profile'])

  // 早退工具：调用后 engine 立刻退出 loop
  let exitToolCall: { name: string; input: Record<string, unknown> } | undefined = undefined

  // 唯一的缓冲 flush 入口：调 flushOutboundBuffer 并据结果维护 pendingDeliveryFailure 追踪。
  //   'ok'            → 无失败（可能已清 pending），调用方照常收尾
  //   'retry'         → 有失败但未超限：已注入提示 + 记 pending，调用方续轮让 worker 重发
  //   { failedReason} → 有失败且重试耗尽：调用方 buildResult('failed', …, reason)
  const flushAndTrackDelivery = async (): Promise<'ok' | 'retry' | { readonly failedReason: string }> => {
    if (!options.flushOutboundBuffer) return 'ok'
    const result = await options.flushOutboundBuffer()
    const failures = result?.failures ?? []
    const sentCount = result?.sentCount ?? 0
    if (failures.length > 0) {
      if (outboundFlushFailureRetries < MAX_OUTBOUND_FLUSH_FAILURE_RETRIES) {
        outboundFlushFailureRetries++
        pendingDeliveryFailure = buildOutboundFlushFailureReason(failures)
        const failPrompt = buildOutboundFlushFailurePrompt(failures)
        messages.push(createUserMessage(failPrompt))
        options.onSystemInjection?.({ type: 'supplement', text: failPrompt, turnNumber: totalTurns, injectedAtMs: Date.now() })
        return 'retry'
      }
      return { failedReason: buildOutboundFlushFailureReason(failures) }
    }
    // 真送出至少一条 → 交付已送达，清 pending；空 buffer no-op 则保持 pending 不变。
    if (sentCount > 0) pendingDeliveryFailure = null
    return 'ok'
  }

  // 收尾出口：有未解决的交付失败（flush 失败后 worker 没重发成功）→ 标 failed 写清原因，否则 completed。
  const finishTask = (): EngineResult =>
    buildResult(
      pendingDeliveryFailure ? 'failed' : 'completed',
      finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene,
      pendingDeliveryFailure ?? undefined,
    )

  const workingDirectory = getWorkspaceDir()
  const hooks: HookConfig | undefined = options.hookRegistry ? {
    registry: options.hookRegistry,
    context: {
      workingDirectory,
      adapter,
      model: options.model,
      lspManager: options.lspManager,
      senderIsMaster: options.senderIsMaster,
      resolvedPermissions: options.resolvedPermissions,
      contentReviewer: options.contentReviewer,
      sessionType: options.sessionType,
    },
  } : undefined

  for (let turn = 0; turn < maxTurns; turn++) {
    // Check abort before starting a turn
    if (abortSignal?.aborted) {
      return buildResult('aborted', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene)
    }

    // Check if context compaction is needed
    // disableCompaction=true 时整体 bypass（subagent 路径）；详见 EngineOptions 注释。
    if (!options.disableCompaction && contextManager.shouldCompact(messages)) {
      await compactInPlace(messages, contextManager, adapter, options)
    }

    // Call LLM (non-streaming by default; streaming infra preserved for rollback
    // via adapters that opt out of `complete()`).
    let response: import('./llm-adapter').LLMCallResponse
    const currentSystemPrompt = typeof options.systemPrompt === 'function'
      ? (options.systemPrompt as () => string)()
      : options.systemPrompt
    const currentTools = typeof options.tools === 'function'
      ? (options.tools as () => ReadonlyArray<import('./types').ToolDefinition>)()
      : options.tools
    // 快照本轮实际使用的 systemPrompt/tools 给 fork observer（见 EngineMessagesRef 注释）
    if (messagesRef) {
      messagesRef.systemPrompt = currentSystemPrompt
      messagesRef.tools = currentTools
    }
    const llmStartedAtMs = Date.now()
    let llmCallMs = 0
    try {
      response = await callNonStreaming(adapter, {
        messages,
        systemPrompt: currentSystemPrompt,
        tools: [...currentTools],
        model: options.model,
        maxTokens: options.maxTokens,
        signal: abortSignal,
        onRetry: (event) => {
          if (options.onLiveProgress) {
            options.onLiveProgress({
              type: 'llm_retry',
              turn: totalTurns + 1,                  // 即将开始的这一轮
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              source: event.source,
              error: event.error.message,
            })
          }
        },
      })
      llmCallMs = Date.now() - llmStartedAtMs
    } catch (error) {
      if (abortSignal?.aborted) {
        return buildResult('aborted', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene)
      }
      console.error('[query-loop] LLM call threw:', error)
      return buildResult('failed', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene, formatError(error))
    }

    const processed = partitionResponseContent(response.content)
    totalTurns++

    // Live progress: assistant text arrived (fires before tool execution).
    // 注意：emit 在 totalTurns++ 之后，turn 数与 onTurn.turnNumber 对齐。
    if (options.onLiveProgress && processed.text.length > 0) {
      options.onLiveProgress({
        type: 'turn_assistant',
        turn: totalTurns,
        text: processed.text,
      })
    }

    // Update usage tracking
    if (response.usage) {
      contextManager.updateFromUsage(response.usage)
    }

    // Build assistant message content blocks (preserves reasoning ordering: reasoning → text → tool_use)
    const contentBlocks = buildAssistantContent(processed.reasoningBlocks, processed.text, processed.toolUseBlocks)
    const stopReason = normalizeStopReason(response.stopReason)

    const assistantMessage = createAssistantMessage(contentBlocks, stopReason, response.usage)
    messages.push(assistantMessage)

    // skipReflection 信号累加（spec 2026-06-03 §7.2.1）
    toolCallCount += processed.toolUseBlocks.length
    if (!wroteMemoryOrScene) {
      for (const block of processed.toolUseBlocks) {
        if (REFLECTION_TRIGGER_TOOLS.has(block.name)) {
          wroteMemoryOrScene = true
          break
        }
      }
    }

    const forcedSummaryAttempt = pendingForcedSummaryAttempt
    pendingForcedSummaryAttempt = undefined

    finalText = processed.text

    if (stopReason === null) {
      fireOnTurn(buildSilentTurnEvent(
        totalTurns, processed.text, stopReason, llmCallMs, llmStartedAtMs, forcedSummaryAttempt, response.usage,
      ))
      return buildResult(
        'failed',
        finalText,
        totalTurns,
        contextManager,
        messages,
        exitToolCall,
        toolCallCount,
        wroteMemoryOrScene,
        'LLM stream missing terminal stopReason; task was not completed.',
      )
    }

    if (stopReason !== 'tool_use') {
      // end_turn 收口前最后一次 supplement check：防止 LLM end_turn 与 finalize 落盘之间
      // 的微秒级窗口窃听不到 supplement。supplement 自然取代 forced summary——LLM 看到
      // 用户消息会响应，不必再走 silent retry 路径。
      //
      // 同时识别 audit_result / audit_aborted system marker：
      //   - audit_result.pass=true + 无后续 pending → flush buffer + buildResult('completed')
      //   - audit_result.pass=false → 丢 buffer + 注入 detailedReport 续 loop
      //   - audit_aborted → 注入"原 audit 已废"提示续 loop
      // spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.5
      if (options.humanMessageQueue?.hasPending) {
        const supplements = options.humanMessageQueue.drainPending()
        const dispatch = await drainAndDispatchMarkers(supplements, options, messages, totalTurns, flushAndTrackDelivery)
        if (dispatch.flushFailedReason) {
          return buildResult('failed', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene, dispatch.flushFailedReason)
        }
        if (dispatch.shouldExitCompleted) {
          return finishTask()
        }
        for (const content of dispatch.remainingTexts) {
          messages.push(createUserMessage(content))
          options.onSystemInjection?.({
            type: 'supplement',
            text: typeof content === 'string' ? content : '[ContentBlock[] supplement]',
            turnNumber: totalTurns,
            injectedAtMs: Date.now(),
          })
        }
        continue
      }

      // --- Stop hook ---
      if (hooks) {
        const stopInput: HookInput = { event: 'Stop', workingDirectory }
        const matching = hooks.registry.getMatching('Stop', stopInput)
        if (matching.length > 0) {
          const stopResult = await executeHooks(matching, stopInput, hooks.context)
          if (stopResult.action === 'block' && stopResult.message) {
            messages.push(createUserMessage(stopResult.message))
            options.onSystemInjection?.({
              type: 'stop_hook',
              text: stopResult.message,
              turnNumber: totalTurns,
              injectedAtMs: Date.now(),
            })
            continue
          }
        }
      }

      // Task 13: audit 跑中 LLM 直接 end_turn 兜底拦截。
      // 顺序意义：在 drain（上方 humanMessageQueue?.hasPending 块）之后判断——
      // 让 audit_result.pass=true 优先 drained → clearActiveAuditId → 此处 hasActiveAudit=false
      // 不会误拦截已完成的 audit。drain 没拿到 result 但 audit 仍在跑时（agent 跳过 wait_for_signal
      // 直接 end_turn 的非法路径），注入拦截续 loop；3 次后 abort active audit + 放行 end_turn。
      // spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.6
      if (options.hasActiveAudit?.() === true) {
        if (auditPendingEndTurnRetries < MAX_AUDIT_PENDING_END_TURN_RETRIES) {
          auditPendingEndTurnRetries++
          fireOnTurn(buildSilentTurnEvent(
            totalTurns, processed.text, stopReason, llmCallMs, llmStartedAtMs, undefined, response.usage,
          ))
          messages.push(createUserMessage(AUDIT_PENDING_END_TURN_PROMPT))
          options.onSystemInjection?.({
            type: 'audit_pending_intercept',
            text: AUDIT_PENDING_END_TURN_PROMPT,
            turnNumber: totalTurns,
            injectedAtMs: Date.now(),
          })
          continue
        }
        // 兜底耗尽：abort active audit + fall through 让 end_turn 通过。
        // abortActiveAudit 内部会清 activeAuditId / 推 audit_aborted marker / dropOutboundBuffer——
        // 后续路径（max_tokens compact / silent forced_summary / endTurnGate）按正常 end_turn 收尾。
        options.abortActiveAudit?.('end_turn_retries_exhausted')
      }

      const isSilentText = processed.text.trim().length === 0

      // max_tokens + text='' 单独走 compact-retry 路径。单纯加 FORCED_SUMMARY_PROMPT
      // 反而让 input 更大；正确做法是丢掉空回复 + 压缩 + 重跑。
      // 压缩阈值无视 shouldCompact——后者估算不含 system prompt + tools，对 reasoning
      // 模型 + 大量工具的场景系统性低估。
      if (isSilentText && stopReason === 'max_tokens') {
        // disableCompaction（subagent）路径：没有 compact 这条退路，直接以空 finalText 收尾。
        // 父 agent 通过 outcome + totalTurns + 空 output 判断要不要拆任务 / 上调 budget。
        if (!options.disableCompaction && maxTokensCompactRetryCount < MAX_MAX_TOKENS_COMPACT_RETRIES) {
          maxTokensCompactRetryCount++
          fireOnTurn(buildSilentTurnEvent(totalTurns, processed.text, stopReason, llmCallMs, llmStartedAtMs, undefined, response.usage))
          messages.pop()
          await compactInPlace(messages, contextManager, adapter, options)
          continue
        }
        // 配额耗尽（或 subagent 禁用了 compact）：input 已被压过两次仍 max_tokens，
        // 再走 forced-summary 会让 input 更大；此时只能诚实返回空 finalText。
        return finishTask()
      }

      // 真静默 end_turn：早 return 路径不 fire onTurn，这里先补 fire 让 trace 看到这一轮。
      // 但 caller 可通过 suppressForcedSummary 回调表达"silent end_turn 是正常完成态"——
      // 用于新 unified loop（交付走 send_message 工具、不写 finalText）。
      if (isSilentText && options.suppressForcedSummary?.() === true) {
        fireOnTurn(buildSilentTurnEvent(
          totalTurns, processed.text, stopReason, llmCallMs, llmStartedAtMs, forcedSummaryAttempt, response.usage,
        ))
        if (options.endTurnGate) {
          const gateResult = await options.endTurnGate()
          if (typeof gateResult === 'string') {
            messages.push(createUserMessage(gateResult))
            options.onSystemInjection?.({
              type: 'forced_summary',
              text: gateResult,
              turnNumber: totalTurns,
              injectedAtMs: Date.now(),
            })
            continue
          }
          if (gateResult?.kind === 'fail') {
            return buildResult('failed', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene, gateResult.reason)
          }
          if (gateResult !== null) {
            // { kind: 'wait' }：audit 已派出，engine 直接挂起等结果（spec 2026-06-10 §4.7）
            const outcome = await waitGateAuditAndDispatch(options, messages, totalTurns, abortSignal, flushAndTrackDelivery)
            if (outcome === 'exit') {
              return finishTask()
            }
            if (typeof outcome === 'object') {
              return buildResult('failed', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene, outcome.failedReason)
            }
            continue
          }
        }
        // endTurnGate 返回 null（audit pass / 无 gate）→ flush 缓冲后正常退出。
        // 防御性 guard：理论上 endTurnGate null 意味着无 audit 或 audit 已 pass；
        // 万一 gate 实现 bug 返回 null 但 audit 仍在跑，此 guard 防止 pre-audit 内容 leak。
        // spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 8 + §4.1
        if (options.hasActiveAudit?.() !== true) {
          const r = await flushAndTrackDelivery()
          if (r === 'retry') continue
          if (r !== 'ok') {
            return buildResult('failed', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene, r.failedReason)
          }
        }
        return finishTask()
      }
      if (isSilentText && silentEndTurnCount < MAX_SILENT_END_TURN_RETRIES) {
        silentEndTurnCount++
        fireOnTurn(buildSilentTurnEvent(
          totalTurns, processed.text, stopReason, llmCallMs, llmStartedAtMs, forcedSummaryAttempt, response.usage,
        ))
        messages.push(createUserMessage(FORCED_SUMMARY_PROMPT))
        options.onSystemInjection?.({
          type: 'forced_summary',
          text: FORCED_SUMMARY_PROMPT,
          turnNumber: totalTurns,
          injectedAtMs: Date.now(),
        })
        pendingForcedSummaryAttempt = silentEndTurnCount
        continue
      }

      // 有文字的 end_turn / forced_summary 次数耗尽的静默 end_turn：同样属于"早 return 路径"，
      // 补 fire 让 trace 看到这一轮（同 suppressForcedSummary 路径的处理逻辑）。
      fireOnTurn(buildSilentTurnEvent(
        totalTurns, processed.text, stopReason, llmCallMs, llmStartedAtMs, forcedSummaryAttempt, response.usage,
      ))
      if (options.endTurnGate) {
        const gateResult = await options.endTurnGate()
        if (typeof gateResult === 'string') {
          messages.push(createUserMessage(gateResult))
          options.onSystemInjection?.({
            type: 'forced_summary',
            text: gateResult,
            turnNumber: totalTurns,
            injectedAtMs: Date.now(),
          })
          continue
        }
        if (gateResult?.kind === 'fail') {
          return buildResult('failed', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene, gateResult.reason)
        }
        if (gateResult !== null) {
          // { kind: 'wait' }：audit 已派出，engine 直接挂起等结果（spec 2026-06-10 §4.7）
          const outcome = await waitGateAuditAndDispatch(options, messages, totalTurns, abortSignal, flushAndTrackDelivery)
          if (outcome === 'exit') {
            return finishTask()
          }
          if (typeof outcome === 'object') {
            return buildResult('failed', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene, outcome.failedReason)
          }
          continue
        }
      }
      // endTurnGate 返回 null（audit pass / 无 gate）→ flush 缓冲后正常退出。
      // 防御性 guard：理论上 endTurnGate null 意味着无 audit 或 audit 已 pass；
      // 万一 gate 实现 bug 返回 null 但 audit 仍在跑，此 guard 防止 pre-audit 内容 leak。
      // spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 8 + §4.1
      if (options.hasActiveAudit?.() !== true) {
        const r = await flushAndTrackDelivery()
        if (r === 'retry') continue
        if (r !== 'ok') {
          return buildResult('failed', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene, r.failedReason)
        }
      }
      return finishTask()
    }

    // ── Barrier check: wait for potential supplement before executing tools ──
    if (options.humanMessageQueue?.hasBarrier) {
      await options.humanMessageQueue.waitBarrier(abortSignal)

      // Check abort after waiting
      if (abortSignal?.aborted) {
        return buildResult('aborted', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene)
      }

      // If supplement arrived during wait, cancel tools and inject
      if (options.humanMessageQueue.hasPending) {
        const cancelledResults = processed.toolUseBlocks.map(block => ({
          tool_use_id: block.id,
          content: '[操作已取消：收到用户实时纠偏，请根据新指示重新决策]',
          is_error: false,
        }))
        messages.push(createBatchToolResultMessage(cancelledResults))

        // 防御性 marker 分流：理论上 pre-tool barrier 唤醒不会拿到 audit_result（audit 在
        // wait_for_signal 之后唤醒，走 post-tool 路径），但为防 marker 从此路径漏过去，统一走分流。
        // 这里如果拿到 audit_result.pass=true 且无剩余内容，仍按"已完成"退出。
        const supplements = options.humanMessageQueue.drainPending()
        const dispatch = await drainAndDispatchMarkers(supplements, options, messages, totalTurns, flushAndTrackDelivery)
        if (dispatch.flushFailedReason) {
          return buildResult('failed', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene, dispatch.flushFailedReason)
        }
        if (dispatch.shouldExitCompleted) {
          // 工具被 cancelled 但已 push 了 cancelled tool_result，messages 上的状态是完整的——
          // 直接以 completed 退出。
          fireOnTurn({
            turnNumber: totalTurns,
            assistantText: processed.text,
            toolCalls: processed.toolUseBlocks.map(b => ({
              id: b.id,
              name: b.name,
              input: b.input,
              output: '[cancelled by supplement]',
              isError: false,
            })),
            stopReason,
            llmCallMs,
            llmStartedAtMs,
            ...(forcedSummaryAttempt !== undefined ? { forcedSummaryAttempt } : {}),
            ...(response.usage ? { usage: response.usage } : {}),
          })
          return finishTask()
        }
        for (const content of dispatch.remainingTexts) {
          messages.push(createUserMessage(content))
          options.onSystemInjection?.({
            type: 'supplement',
            text: typeof content === 'string' ? content : '[ContentBlock[] supplement]',
            turnNumber: totalTurns,
            injectedAtMs: Date.now(),
          })
        }

        // Fire onTurn with cancelled tools for trace recording.
        // Cancelled tools never executed → omit per-tool timing entirely.
        fireOnTurn({
          turnNumber: totalTurns,
          assistantText: processed.text,
          toolCalls: processed.toolUseBlocks.map(b => ({
            id: b.id,
            name: b.name,
            input: b.input,
            output: '[cancelled by supplement]',
            isError: false,
          })),
          stopReason,
          llmCallMs,
          llmStartedAtMs,
          ...(forcedSummaryAttempt !== undefined ? { forcedSummaryAttempt } : {}),
          ...(response.usage ? { usage: response.usage } : {}),
        })

        continue  // Skip tool execution, go to next LLM turn
      }
      // else: barrier cleared without supplement → proceed normally
    }

    // turnZeroOnly 强制：在 turn 0 之后的轮次，turnZeroOnly 工具调用被拒绝
    const isAfterTurnZero = totalTurns > 1  // totalTurns=1 表示刚处理完 turn 0 响应
    if (isAfterTurnZero) {
      const violatingBlocks = processed.toolUseBlocks
        .filter(b => currentTools.find(t => t.name === b.name)?.turnZeroOnly === true)
      const violatingIds = new Set(violatingBlocks.map(b => b.id))
      const turnZeroViolationMessage = (name: string) =>
        `[Tool '${name}' is only callable on turn 0; the trigger message has already been processed. If you need to early-exit, you cannot do so anymore—proceed with the task normally.]`

      if (violatingBlocks.length > 0) {
        const violatingResults = processed.toolUseBlocks
        .map(b => ({
          tool_use_id: b.id,
          content: violatingIds.has(b.id)
            ? turnZeroViolationMessage(b.name)
            : '[skipped: turnZeroOnly violation in same turn]',
          is_error: violatingIds.has(b.id),
        }))

        // 本轮只要有 turnZeroOnly 违规，就跳过实际工具执行；但必须为所有
        // tool_use 补齐 tool_result，否则下一轮重放会触发 LLM API 400。
        messages.push(createBatchToolResultMessage(violatingResults))
        // fire onTurn for trace recording
        fireOnTurn({
          turnNumber: totalTurns,
          assistantText: processed.text,
          toolCalls: processed.toolUseBlocks.map(b => ({
            id: b.id,
            name: b.name,
            input: b.input,
            output: violatingResults.find(r => r.tool_use_id === b.id)?.content ?? '',
            isError: violatingResults.find(r => r.tool_use_id === b.id)?.is_error ?? false,
          })),
          stopReason,
          llmCallMs,
          llmStartedAtMs,
          ...(forcedSummaryAttempt !== undefined ? { forcedSummaryAttempt } : {}),
          ...(response.usage ? { usage: response.usage } : {}),
        })
        continue
      }
    }

    // exitsLoop 检测：若任一 tool_use 是 exitsLoop 工具，直接退出 loop。
    // 不调用 call，但仍 push 合成 tool_result，保证 finalMessages / checkpoint
    // 可被 LLM API 重放（assistant tool_use 不能悬空）。
    const exitBlock = processed.toolUseBlocks.find(b => {
      const def = currentTools.find(t => t.name === b.name)
      return def?.exitsLoop === true
    })
    if (exitBlock) {
      exitToolCall = {
        name: exitBlock.name,
        input: exitBlock.input as Record<string, unknown>,
      }
      const exitToolResultById = new Map(processed.toolUseBlocks.map(b => {
        const def = currentTools.find(t => t.name === b.name)
        const content = def?.exitsLoop === true ? '[exit_tool]' : '[skipped: exitsLoop tool selected]'
        return [b.id, { content, isError: def?.exitsLoop !== true }] as const
      }))
      messages.push(createBatchToolResultMessage(processed.toolUseBlocks.map(b => {
        const r = exitToolResultById.get(b.id)
        return {
          tool_use_id: b.id,
          content: r?.content ?? '[skipped: exitsLoop tool selected]',
          is_error: r?.isError ?? false,
        }
      })))
      // Fire onTurn for trace recording after all same-turn tool_use blocks have results.
      fireOnTurn({
        turnNumber: totalTurns,
        assistantText: processed.text,
        toolCalls: processed.toolUseBlocks.map(b => {
          const r = exitToolResultById.get(b.id)
          return {
            id: b.id,
            name: b.name,
            input: b.input,
            output: r?.content ?? '[skipped: exitsLoop tool selected]',
            isError: r?.isError ?? false,
          }
        }),
        stopReason,
        llmCallMs,
        llmStartedAtMs,
        ...(forcedSummaryAttempt !== undefined ? { forcedSummaryAttempt } : {}),
        ...(response.usage ? { usage: response.usage } : {}),
      })
      return finishTask()
    }

    // Execute tools
    const batches = partitionToolCalls(processed.toolUseBlocks, currentTools)
    // Live progress: tools about to start
    if (options.onLiveProgress) {
      options.onLiveProgress({
        type: 'tools_start',
        tools: processed.toolUseBlocks.map(b => ({
          name: b.name,
          input_summary: summarizeToolInput(b.input),
        })),
      })
    }
    const toolResults = await executeToolBatches(batches, currentTools, {
      abortSignal,
      ...(options.timezone ? { timezone: options.timezone } : {}),
    }, options.permissionConfig, hooks)
    // Live progress: tools finished
    if (options.onLiveProgress) {
      options.onLiveProgress({
        type: 'tools_end',
        results: processed.toolUseBlocks.map((b, i) => ({
          name: b.name,
          input_summary: summarizeToolInput(b.input),
          is_error: toolResults[i]?.is_error ?? false,
        })),
      })
    }

    // Process images based on model capability
    let processedResults: typeof toolResults
    if (options.supportsVision) {
      // VLM: compress images (resize + JPEG) then pass through
      processedResults = await compressToolResultImages(toolResults)
    } else {
      // LLM: save images to temp files, replace with text description
      processedResults = toolResults.map((r) => {
        if (!r.images?.length) return r

        const descriptions: string[] = [r.content]
        for (let i = 0; i < r.images.length; i++) {
          const img = r.images[i]
          const filename = `screenshot-${Date.now()}-${i}.png`
          const filePath = `/tmp/${filename}`
          fs.writeFileSync(filePath, Buffer.from(img.data, 'base64'))
          descriptions.push(`[Image saved to ${filePath}] Use Bash tool to analyze with OCR if needed.`)
        }
        return { ...r, content: descriptions.join('\n'), images: undefined }
      })
    }

    // Add tool results as a single batched message
    messages.push(createBatchToolResultMessage(processedResults))

    // Fire onTurn only after tool_result is in messages. Checkpoint/resume and
    // progress observers treat onTurn as the clean turn boundary, so every
    // assistant tool_use must already have matching toolResults here.
    fireOnTurn({
      turnNumber: totalTurns,
      assistantText: processed.text,
      toolCalls: processed.toolUseBlocks.map((b, i) => {
        const r = toolResults[i]
        const tc: EngineTurnEvent['toolCalls'][number] = {
          id: b.id,
          name: b.name,
          input: b.input,
          output: r?.content ?? '',
          isError: r?.is_error ?? false,
          ...(r?.duration_ms !== undefined ? { durationMs: r.duration_ms } : {}),
          ...(r?.started_at_ms !== undefined ? { startedAtMs: r.started_at_ms } : {}),
        }
        return tc
      }),
      stopReason,
      llmCallMs,
      llmStartedAtMs,
      ...(forcedSummaryAttempt !== undefined ? { forcedSummaryAttempt } : {}),
      ...(response.usage ? { usage: response.usage } : {}),
      ...(response.diagnostics ? { diagnostics: response.diagnostics } : {}),
    })

    // ── Post-tool barrier check ──
    // 工具可能在执行中 setBarrier（如 send_message(intent='ask_human')）。
    // 若 barrier 已设，等待人类回复后再进入下一轮 LLM；
    // pending push 会自动 clearBarrier；wait 结束后 drain pending 注入为新 user message。
    //
    // 注意：这里不做 abort check——先让下方 drainPending 把 supplement 注入 messages，
    // 再由下一轮 LLM call（callNonStreaming）响应 abortSignal。
    // 这样即使 abort 和 supplement 同时到达，supplement 也不会被 abort 路径吞掉。
    // （pre-tool barrier check 因为需要取消工具执行，必须先 check abort；这里无此需要。）
    if (options.humanMessageQueue?.hasBarrier) {
      await options.humanMessageQueue.waitBarrier(abortSignal)
    }

    // 判定本 turn 是否含进了 outboundBuffer 的 send_message——若是，则跳过 drainPending，
    // 防止 supplement 在 turn 边界打乱 info+end_turn 组合判定（spec 2026-06-07 §4.2）。
    // barrier wait 仍然要做（ask_human 等设了 barrier 的工具不受影响）。
    // 被跳过的 supplement 留在 humanQueue 里，等 audit gate 触发后由后续路径自然 drain。
    const bufferedSendMessageInTurn = processed.toolUseBlocks.some((tu, i) => {
      const bare = tu.name.replace(/^mcp__[^_]+__/, '')
      if (bare !== 'send_message' && bare !== 'send_private_message') return false
      const r = toolResults[i]
      return typeof r?.content === 'string' && r.content.includes('"buffered":true')
    })

    // Inject any pending human supplement messages.
    // 同时分流 audit_result / audit_aborted system marker（spec §4.5）：
    //   - audit_result.pass=true + 无剩余 pending → flush buffer + 直接 buildResult('completed')
    //   - audit_result.pass=false → 丢 buffer + 注入 detailedReport 续 loop
    //   - audit_aborted → 注入"原 audit 已废"提示续 loop
    // 这是 audit_result marker 的主要进入路径（wait_for_signal setBarrier → audit 完成 push 唤醒 → 此处 drain）。
    if (options.humanMessageQueue && !bufferedSendMessageInTurn) {
      const supplements = options.humanMessageQueue.drainPending()
      const dispatch = await drainAndDispatchMarkers(supplements, options, messages, totalTurns, flushAndTrackDelivery)
      if (dispatch.flushFailedReason) {
        // audit pass 后交付始终发不出去、重试耗尽 → 标失败、写清原因（不静默标完成）。
        return buildResult('failed', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene, dispatch.flushFailedReason)
      }
      if (dispatch.shouldExitCompleted) {
        // audit pass + 无后续 pending：直接以 completed 退出 agent 实例。spec §4.5
        return finishTask()
      }
      for (const content of dispatch.remainingTexts) {
        messages.push(createUserMessage(content))
        options.onSystemInjection?.({
          type: 'supplement',
          text: typeof content === 'string' ? content : '[ContentBlock[] supplement]',
          turnNumber: totalTurns,
          injectedAtMs: Date.now(),
        })
      }
    }

    // stop_reason='tool_use' 续 turn 之前 flush 缓冲——agent 还在干活，
    // 之前缓冲的 send_message(intent='info') 是"过程信息"不是"最终交付"，
    // 应当在下一轮 LLM 调用前真正发给用户，否则会被卡到 audit pass 才能见。
    // 非 goal mode / 空 buffer 场景，flushOutboundBuffer 内部为 no-op。
    //
    // 等审态下不能 flush——pre-audit 的 final 候选必须等 audit verdict
    // 才决定 flush(pass) / drop(fail) / abort(改 goal)。
    // 等审态新发的 send_message(info) 已经被 Task 6 的 immediate-send 路径绕开 buffer，
    // 所以此处只可能是 pre-audit 内容，绝不能在此 flush（spec §4.1 "未审消息不到达用户"）。
    //
    // **Revision 2026-06-09 第 1 段**：加 !bufferedSendMessageInTurn 守门。本 turn 缓冲了新条
    // send_message 时，跳过这道 flush —— buffer 留给下一轮 LLM 决策，"send_message + 立即 end_turn"
    // 组合才能命中 endTurnGate 派 audit。否则刚 push 进 buffer 的最新条会被本 turn 末就 flush 出去，
    // 等于 buffer 完没进下一 turn 就被自己 flush（trace 7470b21d 案例）。
    // 与 L788 的 drainPending 守门是一对，必须同时挡。
    // spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 8 + §4.1 + §4.2 Revision 第 1 段
    if (
      options.hasActiveAudit?.() !== true
      && !bufferedSendMessageInTurn
    ) {
      // 发送失败 → flushAndTrackDelivery 注入提示（下一轮 LLM 修正重发）+ 记 pending；重试耗尽 → 标失败退出。
      const r = await flushAndTrackDelivery()
      if (r !== 'ok' && r !== 'retry') {
        return buildResult('failed', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene, r.failedReason)
      }
    }

    // Prune old images — keep only the most recent N screenshots
    if (options.supportsVision) {
      pruneOldImages(messages)
    }
  }

  // Loop exhausted
  return buildResult('max_turns', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene)
}

// --- Helpers ---

async function compactInPlace(
  messages: EngineMessage[],
  contextManager: ContextManager,
  adapter: LLMAdapter,
  options: EngineOptions,
): Promise<void> {
  const startedAtMs = Date.now()
  const beforeCount = messages.length
  options.onCompactionStart?.()
  try {
    const compacted = await contextManager.compactWithLLM(messages, adapter, options.model)
    const finalMessages = options.onAfterCompaction
      ? options.onAfterCompaction(compacted)
      : compacted
    messages.length = 0
    for (const msg of finalMessages) {
      messages.push(msg)
    }
  } finally {
    options.onCompactionEnd?.({
      beforeCount,
      afterCount: messages.length,
      durationMs: Date.now() - startedAtMs,
    })
  }
}

function buildSilentTurnEvent(
  turnNumber: number,
  assistantText: string,
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null,
  llmCallMs: number,
  llmStartedAtMs: number | undefined,
  forcedSummaryAttempt?: number,
  usage?: import('./types.js').LLMTokenUsage,
): EngineTurnEvent {
  return {
    turnNumber,
    assistantText,
    toolCalls: [],
    stopReason,
    llmCallMs,
    ...(llmStartedAtMs !== undefined ? { llmStartedAtMs } : {}),
    ...(forcedSummaryAttempt !== undefined ? { forcedSummaryAttempt } : {}),
    ...(usage ? { usage } : {}),
  }
}

function buildResult(
  outcome: EngineResult['outcome'],
  finalText: string,
  totalTurns: number,
  contextManager: ContextManager,
  messages: readonly EngineMessage[],
  exitToolCall: { name: string; input: Record<string, unknown> } | undefined,
  toolCallCount: number,
  wroteMemoryOrScene: boolean,
  error?: string
): EngineResult {
  const usage = contextManager.getCumulativeUsage()
  return {
    outcome,
    finalText,
    totalTurns,
    usage,
    // 浅拷贝防共享：runEngine 退出后 messages 不再被改，但 buildResult 直接持有引用会让
    // 未来的重构面临"我以为 EngineResult 是不可变的，结果上游 push 了一条消息"的隐患。
    finalMessages: [...messages],
    tool_call_count: toolCallCount,
    wrote_memory_or_scene: wroteMemoryOrScene,
    ...(exitToolCall !== undefined ? { exitToolCall } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

function buildAssistantContent(
  reasoningBlocks: ReadonlyArray<RawReasoningBlock>,
  text: string,
  toolUseBlocks: ReadonlyArray<ToolUseBlock>
): ContentBlock[] {
  const blocks: ContentBlock[] = []

  // Reasoning must precede text/tool_use so Codex replay keeps encrypted_content intact
  for (const block of reasoningBlocks) {
    blocks.push(block)
  }

  if (text.length > 0) {
    blocks.push({ type: 'text', text })
  }

  for (const block of toolUseBlocks) {
    blocks.push(block)
  }

  return blocks
}

function partitionResponseContent(content: ReadonlyArray<ContentBlock>): {
  readonly text: string
  readonly toolUseBlocks: ReadonlyArray<ToolUseBlock>
  readonly reasoningBlocks: ReadonlyArray<RawReasoningBlock>
} {
  const textParts: string[] = []
  const toolUseBlocks: ToolUseBlock[] = []
  const reasoningBlocks: RawReasoningBlock[] = []
  for (const block of content) {
    if (block.type === 'text') textParts.push(block.text)
    else if (block.type === 'tool_use') toolUseBlocks.push(block)
    else if (block.type === 'raw_reasoning') reasoningBlocks.push(block)
  }
  return { text: textParts.join(''), toolUseBlocks, reasoningBlocks }
}

function normalizeStopReason(
  raw: string | null
): 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null {
  switch (raw) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
      return raw
    default:
      return null
  }
}

/**
 * 把工具输入压缩成 200 字以内的人类可读摘要，用于 live snapshot。
 * Bash 优先取 command 第一行；其它工具走 JSON.stringify 截断。
 */
function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input || typeof input !== 'object') return ''
  const cmd = (input as { command?: unknown }).command
  if (typeof cmd === 'string') {
    const firstLine = cmd.split('\n', 1)[0].trim()
    return firstLine.length > 200 ? firstLine.slice(0, 200) + '…' : firstLine
  }
  const file = (input as { file_path?: unknown }).file_path
  if (typeof file === 'string') return file.length > 200 ? file.slice(0, 200) + '…' : file
  try {
    const json = JSON.stringify(input)
    return json.length > 200 ? json.slice(0, 200) + '…' : json
  } catch {
    return ''
  }
}
