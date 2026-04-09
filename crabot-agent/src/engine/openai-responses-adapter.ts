/**
 * OpenAI Responses API LLM Adapter
 *
 * 用于直连 OpenAI Responses API (chatgpt.com/backend-api/codex 或 api.openai.com)
 */

import type { LLMAdapter, LLMAdapterConfig, LLMStreamParams } from './llm-adapter-types.js'
import { isToolResultMessage, extractText, buildImageUrl, readSSEEvents } from './llm-adapter-types.js'
import type { EngineMessage, ToolDefinition, StreamChunk, ContentBlock } from './types.js'

// --- Responses API Message Normalization ---

export function normalizeMessagesForResponses(messages: ReadonlyArray<EngineMessage>): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []

  for (const msg of messages) {
    if (isToolResultMessage(msg)) {
      for (const tr of msg.toolResults) {
        result.push({
          type: 'function_call_output',
          call_id: tr.tool_use_id,
          output: tr.is_error ? `Error: ${tr.content}` : tr.content,
        })
      }
      continue
    }

    if (msg.role === 'assistant') {
      const textContent = extractText(msg.content)
      const toolUseParts = msg.content.filter((b) => b.type === 'tool_use')

      if (textContent) {
        result.push({ type: 'message', role: 'assistant', content: textContent })
      }

      for (const b of toolUseParts) {
        const tu = b as { id: string; name: string; input: Record<string, unknown> }
        result.push({
          type: 'function_call',
          call_id: tu.id,
          name: tu.name,
          arguments: JSON.stringify(tu.input),
        })
      }
      continue
    }

    if (typeof msg.content === 'string') {
      result.push({ type: 'message', role: 'user', content: msg.content })
      continue
    }

    const hasImages = msg.content.some((b: ContentBlock) => b.type === 'image')
    if (!hasImages) {
      result.push({ type: 'message', role: 'user', content: extractText(msg.content) })
    } else {
      const contentParts = msg.content.map((block: ContentBlock) => {
        if (block.type === 'image') {
          return { type: 'input_image', image_url: buildImageUrl(block.source) }
        }
        return { type: 'input_text', text: block.type === 'text' ? block.text : '' }
      })
      result.push({ type: 'message', role: 'user', content: contentParts })
    }
  }

  return result
}

// --- Responses API Tool Conversion ---

interface ResponsesTool {
  readonly type: 'function'
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly strict: boolean
}

function toResponsesTool(tool: ToolDefinition): ResponsesTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  }
}

// --- OpenAI Responses Adapter ---

export class OpenAIResponsesAdapter implements LLMAdapter {
  private config: LLMAdapterConfig

  constructor(config: LLMAdapterConfig) {
    this.config = config
  }

  updateConfig(config: Partial<LLMAdapterConfig>): void {
    this.config = {
      endpoint: config.endpoint ?? this.config.endpoint,
      apikey: config.apikey ?? this.config.apikey,
    }
  }

  async *stream(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
    const input = normalizeMessagesForResponses(params.messages)
    const tools = params.tools.map(toResponsesTool)

    const body: Record<string, unknown> = {
      model: params.model,
      instructions: params.systemPrompt,
      input,
      stream: true,
    }

    if (params.maxTokens) {
      body.max_output_tokens = params.maxTokens
    }

    if (tools.length > 0) {
      body.tools = tools
    }

    try {
      const response = await fetch(`${this.config.endpoint}/v1/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apikey}`,
        },
        body: JSON.stringify(body),
        signal: params.signal,
      })

      if (!response.ok) {
        const errorText = await response.text()
        yield { type: 'error', error: `Responses API error ${response.status}: ${errorText}` }
        return
      }

      if (!response.body) {
        yield { type: 'error', error: 'No response body received' }
        return
      }

      let messageStarted = false
      const activeFunctionCalls = new Map<string, { callId: string; name: string }>()

      for await (const { event, data } of readSSEEvents(response.body)) {
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }

        if (!messageStarted) {
          messageStarted = true
          const resp = parsed.response as { id?: string } | undefined
          yield { type: 'message_start', messageId: resp?.id ?? 'resp_unknown' }
        }

        switch (event) {
          case 'response.output_text.delta': {
            const delta = parsed.delta as string
            if (delta) {
              yield { type: 'text_delta', text: delta }
            }
            break
          }

          case 'response.output_item.added': {
            const item = parsed.item as { type?: string; id?: string; call_id?: string; name?: string }
            if (item?.type === 'function_call' && item.id && item.call_id) {
              activeFunctionCalls.set(item.id, { callId: item.call_id, name: item.name ?? '' })
              yield { type: 'tool_use_start', id: item.call_id, name: item.name ?? '' }
            }
            break
          }

          case 'response.function_call_arguments.delta': {
            const itemId = parsed.item_id as string
            const delta = parsed.delta as string
            const fc = activeFunctionCalls.get(itemId)
            if (fc && delta) {
              yield { type: 'tool_use_delta', id: fc.callId, inputJson: delta }
            }
            break
          }

          case 'response.function_call_arguments.done': {
            const itemId = parsed.item_id as string
            const fc = activeFunctionCalls.get(itemId)
            if (fc) {
              yield { type: 'tool_use_end', id: fc.callId }
            }
            break
          }

          case 'response.completed': {
            const resp = parsed.response as {
              output?: Array<{ type?: string }>
              usage?: { input_tokens?: number; output_tokens?: number }
            } | undefined

            const hasToolCalls = resp?.output?.some(item => item.type === 'function_call') ?? false
            const usage = resp?.usage

            yield {
              type: 'message_end',
              stopReason: hasToolCalls ? 'tool_use' : 'end_turn',
              ...(usage ? { usage: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 } } : {}),
            }
            break
          }

          default:
            break
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      yield { type: 'error', error: message }
    }
  }
}
