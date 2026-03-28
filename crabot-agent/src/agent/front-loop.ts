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

          // make_decision -> return structured decision immediately
          if (block.name === 'make_decision') {
            const decision = parseMakeDecision(block.input as Record<string, unknown>)

            const toolSpanId = traceCallback?.onToolCallStart('make_decision', JSON.stringify(block.input).slice(0, 200))
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

function parseMakeDecision(input: Record<string, unknown>): MessageDecision {
  const type = input.type as string

  switch (type) {
    case 'direct_reply':
      return {
        type: 'direct_reply',
        reply: { type: 'text', text: (input.reply_text as string) ?? '' },
      }

    case 'create_task': {
      const replyText = input.immediate_reply_text as string | undefined
      return {
        type: 'create_task',
        task_title: (input.task_title as string) ?? '未命名任务',
        task_description: (input.task_description as string) ?? '',
        task_type: (input.task_type as string) ?? 'general',
        immediate_reply: {
          type: 'text',
          text: replyText ?? '',
        },
      }
    }

    case 'supplement_task':
      if (!input.task_id) {
        return { type: 'direct_reply', reply: { type: 'text', text: '无法确定目标任务，请指明您想调整哪个任务。' } }
      }
      return {
        type: 'supplement_task',
        task_id: input.task_id as string,
        supplement_content: (input.supplement_content as string) ?? '',
        confidence: (input.confidence as 'high' | 'low') ?? 'low',
        immediate_reply: {
          type: 'text',
          text: (input.immediate_reply_text as string) ?? '',
        },
      }

    case 'silent':
      return { type: 'silent' }

    default:
      return { type: 'direct_reply', reply: { type: 'text', text: '未知的决策类型' } }
  }
}


