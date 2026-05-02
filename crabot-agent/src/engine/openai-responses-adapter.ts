/**
 * OpenAI Responses API LLM Adapter
 *
 * 用于直连 OpenAI Responses API (chatgpt.com/backend-api/codex 或 api.openai.com)
 */

import type { LLMAdapter, LLMAdapterConfig, LLMStreamParams } from './llm-adapter-types.js'
import { isToolResultMessage, extractText, buildImageUrl, readSSEEvents, wrapOnRetry } from './llm-adapter-types.js'
import type { EngineMessage, ToolDefinition, StreamChunk, ContentBlock } from './types.js'
import { HttpResponseError, streamWithRetry } from './retry-utils.js'
import { isMaterialChunk } from './stream-processor.js'

// --- Responses API Message Normalization ---

/**
 * Split a tool_use block id that may be encoded as `call_id|fc_id` (Codex format)
 * or plain `call_id` (other backends).
 */
function splitEncodedToolId(id: string): { callId: string; itemId?: string } {
  if (!id.includes('|')) {
    return { callId: id }
  }
  const [callId, itemId] = id.split('|', 2)
  return itemId ? { callId, itemId } : { callId }
}

export function normalizeMessagesForResponses(messages: ReadonlyArray<EngineMessage>): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []

  for (const msg of messages) {
    if (isToolResultMessage(msg)) {
      for (const tr of msg.toolResults) {
        const { callId } = splitEncodedToolId(tr.tool_use_id)
        result.push({
          type: 'function_call_output',
          call_id: callId,
          output: tr.is_error ? `Error: ${tr.content}` : tr.content,
        })
      }
      continue
    }

    if (msg.role === 'assistant') {
      // Iterate blocks in order to preserve reasoning → text → tool_use sequence
      // required by the Responses API for proper replay of encrypted reasoning context.
      let pendingText = ''
      const flushText = () => {
        if (pendingText) {
          result.push({ type: 'message', role: 'assistant', content: pendingText })
          pendingText = ''
        }
      }

      for (const block of msg.content) {
        if (block.type === 'text') {
          pendingText += block.text
          continue
        }
        if (block.type === 'raw_reasoning') {
          flushText()
          result.push(block.data as Record<string, unknown>)
          continue
        }
        if (block.type === 'tool_use') {
          flushText()
          const { callId, itemId } = splitEncodedToolId(block.id)
          result.push({
            type: 'function_call',
            ...(itemId ? { id: itemId } : {}),
            call_id: callId,
            name: block.name,
            arguments: JSON.stringify(block.input),
          })
        }
      }
      flushText()
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
      ...(config.accountId !== undefined
        ? { accountId: config.accountId }
        : this.config.accountId !== undefined
        ? { accountId: this.config.accountId }
        : {}),
    }
  }

  async *stream(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
    yield* streamWithRetry(
      'openai-responses-adapter',
      () => this.streamOnce(params),
      {
        abortSignal: params.signal,
        isMaterial: isMaterialChunk,
        onRetry: wrapOnRetry(params.onRetry, 'pre-stream'),
      },
    )
  }

  private async *streamOnce(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
    const input = normalizeMessagesForResponses(params.messages)
    const tools = params.tools.map(toResponsesTool)

    // ChatGPT Codex 后端：endpoint 形如 https://chatgpt.com/backend-api/codex
    // 路径追加 /responses（对齐 codex-rs ResponsesApiRequest）
    // OpenAI 官方：endpoint 形如 https://api.openai.com/v1，同样追加 /responses
    const isCodexBackend = this.config.endpoint.includes('chatgpt.com/backend-api')

    const body: Record<string, unknown> = {
      model: params.model,
      instructions: params.systemPrompt,
      input,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: false,
      stream: true,
    }

    // Codex 特有字段：reasoning 控制和 include（传递加密的 reasoning 上下文）
    if (isCodexBackend) {
      body.reasoning = { effort: 'medium', summary: 'auto' }
      body.include = ['reasoning.encrypted_content']
    }

    // max_output_tokens 对 Codex 无效，仅 OpenAI 官方 Responses API 支持
    if (!isCodexBackend && params.maxTokens) {
      body.max_output_tokens = params.maxTokens
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apikey}`,
    }
    if (isCodexBackend && this.config.accountId) {
      headers['ChatGPT-Account-Id'] = this.config.accountId
    }

    const response = await fetch(`${this.config.endpoint}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: params.signal,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new HttpResponseError(response.status, errorText, 'openai-responses-adapter')
    }

    if (!response.body) {
      throw new Error('openai-responses-adapter: no response body received')
    }

    let messageStarted = false
    // Maps streamed item.id (fc_xxx) to the encoded block id ("call_xxx|fc_xxx") that
    // we use internally so replay emits both id and call_id to the Responses API.
    const activeFunctionCalls = new Map<string, { encodedId: string; name: string }>()

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
            const encodedId = `${item.call_id}|${item.id}`
            activeFunctionCalls.set(item.id, { encodedId, name: item.name ?? '' })
            yield { type: 'tool_use_start', id: encodedId, name: item.name ?? '' }
          }
          break
        }

        case 'response.function_call_arguments.delta': {
          const itemId = parsed.item_id as string
          const delta = parsed.delta as string
          const fc = activeFunctionCalls.get(itemId)
          if (fc && delta) {
            yield { type: 'tool_use_delta', id: fc.encodedId, inputJson: delta }
          }
          break
        }

        case 'response.function_call_arguments.done': {
          const itemId = parsed.item_id as string
          const fc = activeFunctionCalls.get(itemId)
          if (fc) {
            yield { type: 'tool_use_end', id: fc.encodedId }
          }
          break
        }

        case 'response.output_item.done': {
          // Capture reasoning items so we can replay them (with encrypted_content)
          // in subsequent turns. Required by Codex backend when include=['reasoning.encrypted_content'].
          const item = parsed.item as Record<string, unknown> | undefined
          if (item && typeof item.type === 'string' && (item.type === 'reasoning' || item.type.startsWith('reasoning.'))) {
            yield { type: 'raw_reasoning', data: { ...item } }
          }
          break
        }

        case 'response.completed': {
          const resp = parsed.response as {
            output?: Array<{ type?: string }>
            usage?: { input_tokens?: number; output_tokens?: number }
          } | undefined

          // Trust the stream: if a function_call item was emitted, the stop reason is tool_use.
          // This guards against edge cases where response.completed.output omits the function_call type.
          const hasToolCallsInOutput = resp?.output?.some(item => item.type === 'function_call') ?? false
          const hasToolCallsInStream = activeFunctionCalls.size > 0
          const hasToolCalls = hasToolCallsInOutput || hasToolCallsInStream
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
  }
}
