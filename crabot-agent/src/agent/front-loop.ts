/**
 * Front Loop - Mini agent loop for Front Handler v2
 *
 * <=5 rounds: call LLM -> if tool_use, execute -> loop
 * make_decision tool -> structured decision, return immediately
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
import { getAllFrontTools } from './front-tools.js'

const FRONT_MAX_ROUNDS = 5

export interface FrontLoopParams {
  readonly systemPrompt: string
  readonly userMessage: string | ContentBlock[]
  /** Raw user text (for task title extraction on forced termination) */
  readonly rawUserText: string
  /** silent 仅在群聊且未被 @ 时可用 */
  readonly allowSilent: boolean
  readonly adapter: LLMAdapter
  readonly model: string
  readonly toolExecutor: ToolExecutor
  readonly traceCallback?: TraceCallback
}

export async function runFrontLoop(params: FrontLoopParams): Promise<FrontLoopResult> {
  const { systemPrompt, userMessage, rawUserText, allowSilent, adapter, model, toolExecutor, traceCallback } = params
  const tools: ToolDefinition[] = getAllFrontTools(allowSilent)
  const messages: EngineMessage[] = [createUserMessage(userMessage)]
  const toolHistory: ToolHistoryEntry[] = []

  const loopSpanId = traceCallback?.onLoopStart('front', {
    system_prompt: systemPrompt,
    model,
    tools: tools.map(t => t.name),
  })

  try {
    for (let round = 0; round < FRONT_MAX_ROUNDS; round++) {
      const inputSummary = round === 0
        ? (typeof userMessage === 'string' ? userMessage.slice(0, 150) : '[multimodal message]')
        : `(round ${round + 1})`
      const llmSpanId = traceCallback?.onLlmCallStart(round + 1, inputSummary)

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

        // 私聊/被@场景下 LLM 没输出文本也没调 make_decision，注入提示让它重试
        messages.push(createAssistantMessage(response.content, 'end_turn', response.usage))
        messages.push(createUserMessage('你必须调用 make_decision 工具输出决策，不能留空。请现在调用。'))
        continue
      }

      // Case 2: tool_use
      if (response.stopReason === 'tool_use') {
        messages.push(createAssistantMessage(response.content, 'tool_use', response.usage))

        const toolResultMessages: EngineMessage[] = []

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue

          // make_decision -> validate first, return structured decision or error
          if (block.name === 'make_decision') {
            const rawInput = block.input as Record<string, unknown>
            const validationError = validateMakeDecision(rawInput)

            if (validationError) {
              // 校验失败：作为 tool error 返回给 LLM，让它重试
              const toolSpanId = traceCallback?.onToolCallStart('make_decision', JSON.stringify(rawInput).slice(0, 200))
              if (toolSpanId) traceCallback?.onToolCallEnd(toolSpanId, '', validationError)

              toolResultMessages.push(createToolResultMessage(block.id, validationError, true))
              continue
            }

            const decision = parseMakeDecision(rawInput)

            const toolSpanId = traceCallback?.onToolCallStart('make_decision', JSON.stringify(rawInput).slice(0, 200))
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
    if (loopSpanId) traceCallback?.onLoopEnd(loopSpanId, 'failed', 0)
    throw error
  }
}

/** 统一读取回复文本，兼容旧的 immediate_reply_text */
function getReplyText(input: Record<string, unknown>): string {
  return (input.reply_text as string)
    ?? (input.immediate_reply_text as string)
    ?? ''
}

/**
 * 校验 make_decision 输入，返回错误提示（null 表示通过）
 */
function validateMakeDecision(input: Record<string, unknown>): string | null {
  const type = input.type as string
  if (!type) return '缺少必填参数 type'

  switch (type) {
    case 'direct_reply':
      if (!getReplyText(input)) return 'type=direct_reply 时 reply_text 为必填参数，请提供回复文本'
      break
    case 'create_task':
      if (!input.task_title) return 'type=create_task 时 task_title 为必填参数'
      break
    case 'supplement_task':
      if (!input.task_id) return 'type=supplement_task 时 task_id 为必填参数，请指明目标任务'
      break
    case 'silent':
      break
    default:
      return `未知的决策类型: ${type}，可选值: direct_reply, create_task, supplement_task, silent`
  }
  return null
}

function parseMakeDecision(input: Record<string, unknown>): MessageDecision {
  const type = input.type as string
  const replyText = getReplyText(input)

  switch (type) {
    case 'direct_reply':
      return {
        type: 'direct_reply',
        reply: { type: 'text', text: replyText },
      }

    case 'create_task':
      return {
        type: 'create_task',
        task_title: (input.task_title as string) ?? '未命名任务',
        task_description: (input.task_description as string) ?? '',
        task_type: (input.task_type as string) ?? 'general',
        immediate_reply: {
          type: 'text',
          text: replyText,
        },
      }

    case 'supplement_task':
      return {
        type: 'supplement_task',
        task_id: input.task_id as string,
        supplement_content: (input.supplement_content as string) ?? '',
        immediate_reply: replyText
          ? { type: 'text' as const, text: replyText }
          : undefined,
      }

    case 'silent':
      return { type: 'silent' }

    default:
      return { type: 'silent' }
  }
}
