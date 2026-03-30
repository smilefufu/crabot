/**
 * Front Loop - Mini agent loop for Front Handler v2
 *
 * <=5 rounds: call LLM -> if tool_use, execute -> loop
 * make_decision tool -> structured decision, return immediately
 * end_turn -> wrap as direct_reply
 * max rounds exceeded -> forced create_task with tool history
 */

import type { MessageParam, ContentBlock, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages'
import type { LLMClient } from './llm-client.js'
import type { ToolExecutor } from './tool-executor.js'
import type {
  MessageDecision,
  ToolHistoryEntry,
  FrontLoopResult,
  TraceCallback,
} from '../types.js'
import { getAllFrontTools } from './front-tools.js'

const FRONT_MAX_ROUNDS = 5

export async function runFrontLoop(params: {
  systemPrompt: string
  userMessage: string
  /** Raw user text (for task title extraction on forced termination) */
  rawUserText: string
  llmClient: LLMClient
  toolExecutor: ToolExecutor
  traceCallback?: TraceCallback
}): Promise<FrontLoopResult> {
  const { systemPrompt, userMessage, rawUserText, llmClient, toolExecutor, traceCallback } = params
  const tools = getAllFrontTools()
  const messages: MessageParam[] = [{ role: 'user', content: userMessage }]
  const toolHistory: ToolHistoryEntry[] = []

  const loopSpanId = traceCallback?.onLoopStart('front', {
    system_prompt: systemPrompt,
    model: undefined,
    tools: tools.map(t => t.name),
  })

  try {
    for (let round = 0; round < FRONT_MAX_ROUNDS; round++) {
      const inputSummary = round === 0 ? userMessage.slice(0, 150) : `(round ${round + 1})`
      const llmSpanId = traceCallback?.onLlmCallStart(round + 1, inputSummary)

      const response = await llmClient.callMessages({ system: systemPrompt, messages, tools })

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
          fullInput: round === 0 ? userMessage : undefined,
          fullOutput: textOutput || undefined,
        })
      }

      // Case 1: end_turn -> wrap text as direct_reply
      if (response.stopReason === 'end_turn') {
        const text = response.content
          .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
          .map(b => b.text)
          .join('')
          .trim()

        const decision: MessageDecision = text
          ? { type: 'direct_reply', reply: { type: 'text', text } }
          : { type: 'silent' }

        if (loopSpanId) traceCallback?.onLoopEnd(loopSpanId, 'completed', round + 1)
        return { decision }
      }

      // Case 2: tool_use
      if (response.stopReason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content as MessageParam['content'] })

        const toolResults: ToolResultBlockParam[] = []

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

              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: validationError,
                is_error: true,
              })
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

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.output,
            is_error: result.isError,
          })

          if (!result.isError) {
            toolHistory.push({
              tool_name: block.name,
              input_summary: JSON.stringify(block.input).slice(0, 200),
              output_summary: result.output.slice(0, 500),
            })
          }
        }

        messages.push({ role: 'user', content: toolResults })
      }
    }

    // Max rounds exceeded -> forced create_task with tool history
    const taskTitle = rawUserText.length > 80 ? rawUserText.slice(0, 80) + '...' : (rawUserText || '用户请求')
    const taskDescription = rawUserText || userMessage

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
        confidence: (input.confidence as 'high' | 'low') ?? 'low',
        immediate_reply: {
          type: 'text',
          text: replyText,
        },
      }

    case 'silent':
      return { type: 'silent' }

    default:
      return { type: 'silent' }
  }
}


