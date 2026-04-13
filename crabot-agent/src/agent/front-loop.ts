/**
 * Front Loop - Mini agent loop for Front Handler v2
 *
 * <=5 rounds: call LLM -> if tool_use, execute -> loop
 * Decision tools (reply, create_task, supplement_task, stay_silent) -> return immediately
 * end_turn -> wrap as direct_reply
 * max rounds exceeded -> forced create_task with tool history
 *
 * Uses engine LLMAdapter via callNonStreaming instead of direct Anthropic SDK.
 */

import type { LLMAdapter } from '../engine/llm-adapter.js'
import { callNonStreaming } from '../engine/llm-adapter.js'
import type {
  EngineMessage,
  ContentBlock,
  TextBlock,
  ToolDefinition,
} from '../engine/types.js'
import {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
} from '../engine/types.js'
import type { ToolExecutor } from './tool-executor.js'
import type {
  MessageDecision,
  ToolHistoryEntry,
  FrontLoopResult,
  TraceCallback,
} from '../types.js'
import { getAllFrontTools, DECISION_TOOL_NAMES, type DecisionToolName } from './front-tools.js'

const FRONT_MAX_ROUNDS = 5

export interface FrontLoopParams {
  readonly systemPrompt: string
  readonly userMessage: string | ContentBlock[]
  /** Raw user text (for task title extraction on forced termination) */
  readonly rawUserText: string
  /** silent 仅在群聊且未被 @ 时可用 */
  readonly allowSilent: boolean
  /** 当前活跃任务 ID 列表，为空时不暴露 supplement_task 工具 */
  readonly activeTaskIds: readonly string[]
  readonly adapter: LLMAdapter
  readonly model: string
  readonly toolExecutor: ToolExecutor
  readonly traceCallback?: TraceCallback
}

export async function runFrontLoop(params: FrontLoopParams): Promise<FrontLoopResult> {
  const { systemPrompt, userMessage, rawUserText, allowSilent, activeTaskIds, adapter, model, toolExecutor, traceCallback } = params
  const tools: ToolDefinition[] = getAllFrontTools(allowSilent, activeTaskIds)
  const messages: EngineMessage[] = [createUserMessage(userMessage)]
  const toolHistory: ToolHistoryEntry[] = []

  const loopSpanId = traceCallback?.onLoopStart('front', {
    system_prompt: systemPrompt,
    model,
    tools: tools.map(t => t.name),
  })

  let llmSpanId: string | undefined

  try {
    for (let round = 0; round < FRONT_MAX_ROUNDS; round++) {
      const inputSummary = round === 0
        ? (typeof userMessage === 'string' ? userMessage.slice(0, 150) : '[multimodal message]')
        : `(round ${round + 1})`
      llmSpanId = traceCallback?.onLlmCallStart(round + 1, inputSummary)

      const response = await callNonStreaming(adapter, {
        systemPrompt,
        messages,
        tools,
        model,
      })

      // Trace: record LLM response
      let textOutput = ''
      let toolUseCount = 0
      for (const block of response.content) {
        if (block.type === 'text') textOutput += block.text
        if (block.type === 'tool_use') toolUseCount++
      }
      if (llmSpanId) {
        traceCallback?.onLlmCallEnd(llmSpanId, {
          stopReason: response.stopReason ?? undefined,
          outputSummary: textOutput.slice(0, 200) || undefined,
          toolCallsCount: toolUseCount > 0 ? toolUseCount : undefined,
          fullInput: round === 0 ? (typeof userMessage === 'string' ? userMessage : '[multimodal message]') : undefined,
          fullOutput: textOutput || undefined,
        })
        llmSpanId = undefined
      }

      // Case 1: end_turn -> wrap text as direct_reply
      if (response.stopReason === 'end_turn') {
        const text = response.content
          .filter((b): b is TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('')
          .trim()

        if (text) {
          const decision: MessageDecision = { type: 'direct_reply', reply: { type: 'text', text } }
          if (loopSpanId) traceCallback?.onLoopEnd(loopSpanId, 'completed', round + 1)
          return { decision }
        }

        if (allowSilent) {
          if (loopSpanId) traceCallback?.onLoopEnd(loopSpanId, 'completed', round + 1)
          return { decision: { type: 'silent' } }
        }

        // 私聊/被@场景下 LLM 没输出文本也没调决策工具，注入提示让它重试
        messages.push(createAssistantMessage(response.content, 'end_turn', response.usage))
        messages.push(createUserMessage('你必须调用一个决策工具（reply / create_task）输出决策，不能留空。请现在调用。'))
        continue
      }

      // Case 2: tool_use
      if (response.stopReason === 'tool_use') {
        messages.push(createAssistantMessage(response.content, 'tool_use', response.usage))

        const toolResultMessages: EngineMessage[] = []

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue

          // Decision tools -> parse and return immediately
          if (DECISION_TOOL_NAMES.has(block.name)) {
            const rawInput = block.input as Record<string, unknown>
            const decision = parseDecisionTool(block.name as DecisionToolName, rawInput)

            const toolSpanId = traceCallback?.onToolCallStart(block.name, JSON.stringify(rawInput).slice(0, 200))
            if (toolSpanId) traceCallback?.onToolCallEnd(toolSpanId, `decision: ${decision.type}`)

            if (loopSpanId) traceCallback?.onLoopEnd(loopSpanId, 'completed', round + 1)
            return { decision }
          }

          // Other tools -> execute
          const toolSpanId = traceCallback?.onToolCallStart(block.name, JSON.stringify(block.input).slice(0, 200))
          const result = await toolExecutor.execute(block.name, block.input as Record<string, unknown>)

          if (toolSpanId) {
            traceCallback?.onToolCallEnd(toolSpanId, result.output.slice(0, 200), result.isError ? result.output : undefined)
          }

          toolResultMessages.push(createToolResultMessage(block.id, result.output, result.isError))

          if (!result.isError) {
            toolHistory.push({
              tool_name: block.name,
              input_summary: JSON.stringify(block.input).slice(0, 200),
              output_summary: result.output.slice(0, 500),
            })
          }
        }

        // Merge all tool results into a single EngineToolResultMessage
        if (toolResultMessages.length > 0) {
          const allToolResults = toolResultMessages.flatMap(msg => {
            if ('toolResults' in msg) {
              return msg.toolResults
            }
            return []
          })
          if (allToolResults.length > 0) {
            messages.push({
              id: crypto.randomUUID(),
              role: 'user',
              toolResults: allToolResults as ReadonlyArray<{ readonly tool_use_id: string; readonly content: string; readonly is_error: boolean }>,
              timestamp: Date.now(),
            })
          }
        }
      }
    }

    // Max rounds exceeded -> forced create_task with tool history
    const taskTitle = rawUserText.length > 80 ? rawUserText.slice(0, 80) + '...' : (rawUserText || '用户请求')
    const taskDescription = rawUserText || (typeof userMessage === 'string' ? userMessage : '[multimodal message]')

    if (loopSpanId) traceCallback?.onLoopEnd(loopSpanId, 'completed', FRONT_MAX_ROUNDS)

    return {
      decision: {
        type: 'create_task',
        task_title: taskTitle,
        task_description: taskDescription,
        task_type: 'general',
        immediate_reply: { type: 'text', text: '' },
        front_context: toolHistory.length > 0 ? toolHistory : undefined,
      },
      toolHistory: toolHistory.length > 0 ? toolHistory : undefined,
    }
  } catch (error) {
    if (llmSpanId) traceCallback?.onLlmCallEnd(llmSpanId, { error: String(error).slice(0, 200) })
    if (loopSpanId) traceCallback?.onLoopEnd(loopSpanId, 'failed', 0)
    throw error
  }
}

/**
 * 将决策工具调用解析为 MessageDecision
 */
function parseDecisionTool(toolName: DecisionToolName, input: Record<string, unknown>): MessageDecision {
  switch (toolName) {
    case 'reply':
      return {
        type: 'direct_reply',
        reply: { type: 'text', text: (input.text as string) ?? '' },
      }

    case 'create_task':
      return {
        type: 'create_task',
        task_title: (input.task_title as string) ?? '未命名任务',
        task_description: (input.task_description as string) ?? '',
        task_type: (input.task_type as string) ?? 'general',
        immediate_reply: {
          type: 'text',
          text: (input.ack_text as string) ?? '',
        },
      }

    case 'supplement_task':
      return {
        type: 'supplement_task',
        task_id: (input.task_id as string) ?? '',
        supplement_content: (input.content as string) ?? '',
        immediate_reply: {
          type: 'text',
          text: (input.ack_text as string) ?? '',
        },
      }

    case 'stay_silent':
      return { type: 'silent' }

    default: {
      const _exhaustive: never = toolName
      throw new Error(`Unknown decision tool: ${_exhaustive}`)
    }
  }
}
