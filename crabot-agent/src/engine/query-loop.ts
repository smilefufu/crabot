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
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000

// 推理类模型偶尔以 end_turn 结束但只发 reasoning 不发 text。注入追问让其重说，
// 超过上限仍空就老实返回空 finalText——绝不让另一个 LLM 替它编。
const MAX_SILENT_END_TURN_RETRIES = 3

// stop_reason='max_tokens' + text='' 走独立计数器：单纯加 prompt 会让 input 更大、
// reasoning 烧得更多，必须先压缩再重跑。
const MAX_MAX_TOKENS_COMPACT_RETRIES = 2

// 规则细节由 agent 自己的 system prompt 维护（assembleAgentPrompt 的 end_turn
// self-check + 收尾责任段），这里只做 engine 层的机制兜底钩子——告诉模型违反了
// 哪条规则、要求重新汇报。把规则写两份会产生维护漂移。
// 注：caller 可传 suppressForcedSummary 跳过此机制（已发 info 消息 / 有 goal / scheduled 任务时）。
const FORCED_SUMMARY_PROMPT =
  '你刚才以 end_turn 结束但还没有向人类发送任何内容。\n' +
  '如果本次任务有需要告知的结果或进度，请调用 send_message 工具发出后再 end_turn。'

// --- Core Loop ---

export async function runEngine(params: RunEngineParams): Promise<EngineResult> {
  const { prompt, adapter, options, initialMessages } = params
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  const abortSignal = options.abortSignal

  const messages: EngineMessage[] = initialMessages ? [...initialMessages] : [createUserMessage(prompt)]
  const contextManager = new ContextManager({
    maxContextTokens: options.contextWindowTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
  })

  // compaction 真实 usage 触发（spec 2026-07-21 改动 3）：
  // 每轮 LLM 响应后用 response.usage 算出全量 prompt 大小并记录当时的消息数；
  // usage 缺失 / compaction 后观测失效时回退估算路径（含 system prompt + tools）。
  let lastObservedContextTokens: number | undefined = undefined
  let messageCountAtObservation = 0

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
  let maxTokensCompactRetryCount = 0
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

  const finishTask = (): EngineResult =>
    buildResult(
      'completed',
      finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene,
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
      ...(options.getResolvedPermissions ? { getResolvedPermissions: options.getResolvedPermissions } : {}),
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
    // systemPrompt/tools 在 shouldCompact 之前解析——usage 缺失的估算路径要计入两者。
    const currentSystemPrompt = typeof options.systemPrompt === 'function'
      ? (options.systemPrompt as () => string)()
      : options.systemPrompt
    const currentTools = typeof options.tools === 'function'
      ? (options.tools as () => ReadonlyArray<import('./types').ToolDefinition>)()
      : options.tools
    if (!options.disableCompaction && contextManager.shouldCompact(messages, {
      lastObservedContextTokens,
      messageCountAtObservation,
      systemPrompt: currentSystemPrompt,
      tools: currentTools,
    })) {
      const compaction = await compactInPlace(messages, contextManager, adapter, options, abortSignal)
      if (!compaction.ok) {
        // 压缩是唯一的下压手段（engine 无 provider 溢出恢复路径）。压不下去还继续跑，
        // 只会每轮再烧一次注定失败的摘要调用、最终撞窗口——直接以可诊断的原因收尾。
        if (compaction.aborted) {
          return buildResult('aborted', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene)
        }
        return buildResult('failed', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene, `上下文压缩失败：${compaction.failedReason}`)
      }
      // compaction 改写了 messages，上一轮的 usage 观测已失效，回退估算路径
      lastObservedContextTokens = undefined
    }

    // Call LLM (non-streaming by default; streaming infra preserved for rollback
    // via adapters that opt out of `complete()`).
    let response: import('./llm-adapter').LLMCallResponse
    // 快照本轮实际使用的 systemPrompt/tools 给 fork observer（见 EngineMessagesRef 注释）
    if (messagesRef) {
      messagesRef.systemPrompt = currentSystemPrompt
      messagesRef.tools = currentTools
    }
    const beforeLlmCall = options.onBeforeLlmCall?.()
    if (beforeLlmCall) await beforeLlmCall
    const llmStartedAtMs = Date.now()
    let llmCallMs = 0
    try {
      response = await callNonStreaming(adapter, {
        messages,
        systemPrompt: currentSystemPrompt,
        tools: [...currentTools],
        model: options.model,
        maxTokens: options.maxTokens,
        thinking: options.thinking,
        signal: abortSignal,
        configChangedSignal: options.configChangedSignal,
        configGeneration: options.configGeneration,
        onConfigChanged: options.onConfigChanged,
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
    const hasRemainingTurn = turn + 1 < maxTurns

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
      // 记录全量 prompt 大小供下一轮 shouldCompact 判定（spec 2026-07-21 改动 3）。
      // 此刻 messages 尚未 push 本轮 assistant 消息，长度正好是本次请求的 prompt 消息数。
      lastObservedContextTokens =
        response.usage.inputTokens +
        (response.usage.cacheReadTokens ?? 0) +
        (response.usage.cacheCreationTokens ?? 0)
      messageCountAtObservation = messages.length
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
      // 的微秒级窗口漏掉人类补充。补充消息自然取代 forced summary，继续下一轮响应。
      if (hasRemainingTurn && options.humanMessageQueue?.hasPending) {
        const supplements = options.humanMessageQueue.drainPending()
        for (const content of supplements) {
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

      const isSilentText = processed.text.trim().length === 0

      // max_tokens + text='' 单独走 compact-retry 路径。单纯加 FORCED_SUMMARY_PROMPT
      // 反而让 input 更大；正确做法是丢掉空回复 + 压缩 + 重跑。
      // 压缩无视 shouldCompact 阈值——max_tokens 已是 context 打满的硬信号，
      // 保留这条无视阈值的兜底路径（spec 2026-07-21 改动 3 语义不变量）。
      if (isSilentText && stopReason === 'max_tokens') {
        // disableCompaction（subagent）路径：没有 compact 这条退路，直接以空 finalText 收尾。
        // 父 agent 通过 outcome + totalTurns + 空 output 判断要不要拆任务 / 上调 budget。
        if (!options.disableCompaction && maxTokensCompactRetryCount < MAX_MAX_TOKENS_COMPACT_RETRIES) {
          maxTokensCompactRetryCount++
          fireOnTurn(buildSilentTurnEvent(totalTurns, processed.text, stopReason, llmCallMs, llmStartedAtMs, undefined, response.usage))
          messages.pop()
          const compaction = await compactInPlace(messages, contextManager, adapter, options, abortSignal)
          if (!compaction.ok) {
            // max_tokens 已是 context 打满的硬信号，压缩又没压成 —— 再 continue 只是
            // 拿同样超大的 input 重跑一次。诚实收尾，不把"没压成"当成配额耗尽。
            if (compaction.aborted) {
              return buildResult('aborted', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene)
            }
            return buildResult('failed', finalText, totalTurns, contextManager, messages, exitToolCall, toolCallCount, wroteMemoryOrScene, `上下文压缩失败：${compaction.failedReason}`)
          }
          // compaction 改写了 messages，上一轮的 usage 观测已失效，回退估算路径
          lastObservedContextTokens = undefined
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
      }
      if (!isSilentText && stopReason === 'end_turn' && options.assistantTextEndTurnHandler) {
        const assistantTextResult = await options.assistantTextEndTurnHandler({
          assistantText: processed.text,
          turnNumber: totalTurns,
        })
        if (assistantTextResult.kind === 'inject') {
          messages.push(createUserMessage(assistantTextResult.text))
          options.onSystemInjection?.({
            type: 'assistant_text_end_turn',
            text: assistantTextResult.text,
            turnNumber: totalTurns,
            injectedAtMs: Date.now(),
          })
          continue
        }
        return finishTask()
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

        if (hasRemainingTurn) {
          const supplements = options.humanMessageQueue.drainPending()
          for (const content of supplements) {
            messages.push(createUserMessage(content))
            options.onSystemInjection?.({
              type: 'supplement',
              text: typeof content === 'string' ? content : '[ContentBlock[] supplement]',
              turnNumber: totalTurns,
              injectedAtMs: Date.now(),
            })
          }
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
      ...(options.hasPendingExternalInputs ? { hasPendingExternalInput: options.hasPendingExternalInputs } : {}),
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

    // Inject any pending human supplement messages.
    if (hasRemainingTurn && options.humanMessageQueue) {
      const supplements = options.humanMessageQueue.drainPending()
      for (const content of supplements) {
        messages.push(createUserMessage(content))
        options.onSystemInjection?.({
          type: 'supplement',
          text: typeof content === 'string' ? content : '[ContentBlock[] supplement]',
          turnNumber: totalTurns,
          injectedAtMs: Date.now(),
        })
      }
    }

    // ── External input injection (turn boundary) ──
    // worker inbox 等外部输入源在 turn 边界消费：工具执行完成后、下一轮 LLM 调用前，
    // drain 回调返回的每条输入作为 user message 注入（取出即从源队列移除，FIFO/优先级/
    // receipt 结算由 caller 负责）。仅在有剩余 turn 时 drain（最后一轮注入无人消费）。
    // 回调抛错只跳过本轮（输入保留在源队列，下一轮重试），不影响 burst——与上方
    // supplement 同序，先于下一轮 LLM 调用的 abort 响应。
    if (hasRemainingTurn && options.drainExternalInputs) {
      let externalInputs: ReadonlyArray<string> = []
      try {
        externalInputs = await options.drainExternalInputs()
      } catch (error) {
        console.error(`[engine] drainExternalInputs failed (turn ${totalTurns}), inputs kept in source queue:`,
          error instanceof Error ? error.message : String(error))
      }
      for (const text of externalInputs) {
        messages.push(createUserMessage(text))
        options.onSystemInjection?.({
          type: 'external_input',
          text,
          turnNumber: totalTurns,
          injectedAtMs: Date.now(),
        })
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

/**
 * compaction 结果。失败时 messages 保持原样——**绝不用"假压缩"冒充成功**
 * （旧实现的文本回退对 tool_result 正文一字不减，等于每轮再烧一次注定失败的摘要调用）。
 */
type CompactionOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly aborted: true }
  | { readonly ok: false; readonly aborted: false; readonly failedReason: string }

async function compactInPlace(
  messages: EngineMessage[],
  contextManager: ContextManager,
  adapter: LLMAdapter,
  options: EngineOptions,
  abortSignal?: AbortSignal,
): Promise<CompactionOutcome> {
  const startedAtMs = Date.now()
  const beforeCount = messages.length
  options.onCompactionStart?.()
  let failedReason: string | undefined
  try {
    const compacted = await contextManager.compactWithLLM(messages, adapter, options.model, abortSignal)
    const finalMessages = options.onAfterCompaction
      ? options.onAfterCompaction(compacted)
      : compacted
    messages.length = 0
    for (const msg of finalMessages) {
      messages.push(msg)
    }
    return { ok: true }
  } catch (error) {
    if (abortSignal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) {
      failedReason = 'aborted'
      return { ok: false, aborted: true }
    }
    console.error('[query-loop] context compaction failed:', error)
    failedReason = formatError(error)
    return { ok: false, aborted: false, failedReason }
  } finally {
    // 失败时 afterCount === beforeCount，且带上 failedReason——onCompactionEnd 不得谎报压缩成功
    options.onCompactionEnd?.({
      beforeCount,
      afterCount: messages.length,
      durationMs: Date.now() - startedAtMs,
      ...(failedReason !== undefined ? { failedReason } : {}),
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
