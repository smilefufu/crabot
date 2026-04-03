import Anthropic from '@anthropic-ai/sdk'
import type {
  MessageParam,
  Tool as AnthropicTool,
  ImageBlockParam,
  TextBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages'
import type {
  EngineMessage,
  EngineToolResultMessage,
  ToolDefinition,
  StreamChunk,
  ContentBlock,
} from './types'

// --- Interfaces ---

export interface LLMStreamParams {
  readonly messages: EngineMessage[]
  readonly systemPrompt: string
  readonly tools: ToolDefinition[]
  readonly model: string
  readonly maxTokens?: number
  readonly signal?: AbortSignal
}

export interface LLMAdapter {
  stream(params: LLMStreamParams): AsyncGenerator<StreamChunk>
  updateConfig(config: Partial<LLMAdapterConfig>): void
}

export interface LLMAdapterConfig {
  readonly endpoint: string
  readonly apikey: string
}

// --- Message Normalization ---

function isToolResultMessage(msg: EngineMessage): msg is EngineToolResultMessage {
  return msg.role === 'user' && 'toolResults' in msg
}

export function normalizeMessagesForAnthropic(messages: ReadonlyArray<EngineMessage>): MessageParam[] {
  return messages.map((msg): MessageParam => {
    if (isToolResultMessage(msg)) {
      return {
        role: 'user',
        content: msg.toolResults.map((tr) => ({
          type: 'tool_result' as const,
          tool_use_id: tr.tool_use_id,
          content: tr.content,
          is_error: tr.is_error,
        })),
      }
    }

    if (msg.role === 'assistant') {
      return {
        role: 'assistant',
        content: msg.content.map((block) => {
          switch (block.type) {
            case 'text':
              return { type: 'text' as const, text: block.text }
            case 'tool_use':
              return {
                type: 'tool_use' as const,
                id: block.id,
                name: block.name,
                input: block.input,
              }
            default:
              return { type: 'text' as const, text: '' }
          }
        }),
      }
    }

    // User message (non-tool-result)
    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content }
    }

    const content: Array<TextBlockParam | ImageBlockParam | ToolUseBlockParam | ToolResultBlockParam> =
      msg.content.map((block): TextBlockParam | ImageBlockParam => {
        if (block.type === 'image') {
          return {
            type: 'image',
            source: {
              type: block.source.type as 'base64',
              media_type: block.source.media_type as ImageBlockParam.Source['media_type'],
              data: block.source.data,
            },
          }
        }
        return { type: 'text', text: block.type === 'text' ? block.text : '' }
      })

    return { role: 'user', content }
  })
}

// --- Anthropic Adapter ---

export class AnthropicAdapter implements LLMAdapter {
  private client: Anthropic
  private config: LLMAdapterConfig

  constructor(config: LLMAdapterConfig) {
    this.config = config
    this.client = this.createClient(config)
  }

  private createClient(config: LLMAdapterConfig): Anthropic {
    return new Anthropic({
      baseURL: config.endpoint,
      apiKey: config.apikey,
    })
  }

  static toAnthropicTool(tool: ToolDefinition): AnthropicTool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as AnthropicTool.InputSchema,
    }
  }

  updateConfig(config: Partial<LLMAdapterConfig>): void {
    const newConfig: LLMAdapterConfig = {
      endpoint: config.endpoint ?? this.config.endpoint,
      apikey: config.apikey ?? this.config.apikey,
    }

    const changed =
      newConfig.endpoint !== this.config.endpoint ||
      newConfig.apikey !== this.config.apikey

    this.config = newConfig

    if (changed) {
      this.client = this.createClient(newConfig)
    }
  }

  async *stream(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
    const messages = normalizeMessagesForAnthropic(params.messages)
    const tools = params.tools.map(AnthropicAdapter.toAnthropicTool)

    try {
      const stream = this.client.messages.stream({
        model: params.model,
        max_tokens: params.maxTokens ?? 4096,
        system: params.systemPrompt,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      })

      if (params.signal) {
        const onAbort = () => stream.abort()
        params.signal.addEventListener('abort', onAbort, { once: true })
      }

      let currentToolId: string | null = null

      stream.on('message', () => {
        // message event received
      })

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            yield { type: 'message_start', messageId: event.message.id }
            break

          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              currentToolId = event.content_block.id
              yield {
                type: 'tool_use_start',
                id: event.content_block.id,
                name: event.content_block.name,
              }
            }
            break

          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              yield { type: 'text_delta', text: event.delta.text }
            } else if (event.delta.type === 'input_json_delta') {
              yield {
                type: 'tool_use_delta',
                id: currentToolId ?? '',
                inputJson: event.delta.partial_json,
              }
            }
            break

          case 'content_block_stop':
            if (currentToolId !== null) {
              yield { type: 'tool_use_end', id: currentToolId }
              currentToolId = null
            }
            break

          case 'message_delta':
            yield {
              type: 'message_end',
              stopReason: event.delta.stop_reason ?? null,
              usage: event.usage
                ? { inputTokens: 0, outputTokens: event.usage.output_tokens }
                : undefined,
            }
            break
        }
      }

      // Get final message for accurate usage
      const finalMessage = await stream.finalMessage()
      if (finalMessage.usage) {
        yield {
          type: 'message_end',
          stopReason: finalMessage.stop_reason ?? null,
          usage: {
            inputTokens: finalMessage.usage.input_tokens,
            outputTokens: finalMessage.usage.output_tokens,
          },
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      yield { type: 'error', error: message }
    }
  }
}

// --- Adapter Factory ---

export type LLMFormat = 'anthropic' | 'openai' | 'gemini'

export interface CreateAdapterConfig {
  readonly endpoint: string
  readonly apikey: string
  readonly format: LLMFormat
}

/**
 * Factory function that creates the correct LLM adapter based on the format field.
 * Gemini uses OpenAI-compatible API via LiteLLM, so it maps to OpenAIAdapter.
 */
export function createAdapter(config: CreateAdapterConfig): LLMAdapter {
  switch (config.format) {
    case 'anthropic':
      return new AnthropicAdapter({ endpoint: config.endpoint, apikey: config.apikey })
    case 'openai':
      return new OpenAIAdapter({ endpoint: config.endpoint, apikey: config.apikey })
    case 'gemini':
      // Gemini uses OpenAI-compatible API via LiteLLM
      return new OpenAIAdapter({ endpoint: config.endpoint, apikey: config.apikey })
    default: {
      const exhaustiveCheck: never = config.format
      throw new Error(`Unsupported LLM format: ${exhaustiveCheck}`)
    }
  }
}

// --- OpenAI Message Types ---

interface OpenAITextContent {
  readonly type: 'text'
  readonly text: string
}

interface OpenAIImageUrlContent {
  readonly type: 'image_url'
  readonly image_url: { readonly url: string }
}

type OpenAIContentPart = OpenAITextContent | OpenAIImageUrlContent

interface OpenAIToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly arguments: string
  }
}

interface OpenAIUserMessage {
  readonly role: 'user'
  readonly content: string | OpenAIContentPart[]
}

interface OpenAIAssistantMessage {
  readonly role: 'assistant'
  readonly content: string | null
  readonly tool_calls?: OpenAIToolCall[]
}

interface OpenAIToolMessage {
  readonly role: 'tool'
  readonly tool_call_id: string
  readonly content: string
}

interface OpenAISystemMessage {
  readonly role: 'system'
  readonly content: string
}

type OpenAIMessage = OpenAIUserMessage | OpenAIAssistantMessage | OpenAIToolMessage | OpenAISystemMessage

interface OpenAITool {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }
}

// --- OpenAI Message Normalization ---

export function normalizeMessagesForOpenAI(messages: ReadonlyArray<EngineMessage>): OpenAIMessage[] {
  const result: OpenAIMessage[] = []

  for (const msg of messages) {
    if (isToolResultMessage(msg)) {
      for (const tr of msg.toolResults) {
        result.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: tr.content,
        })
      }
      continue
    }

    if (msg.role === 'assistant') {
      const textParts = msg.content.filter((b) => b.type === 'text')
      const toolUseParts = msg.content.filter((b) => b.type === 'tool_use')

      const textContent = textParts.map((b) => (b as { text: string }).text).join('')

      const toolCalls: OpenAIToolCall[] = toolUseParts.map((b) => {
        const tu = b as { id: string; name: string; input: Record<string, unknown> }
        return {
          id: tu.id,
          type: 'function' as const,
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input),
          },
        }
      })

      const assistantMsg: OpenAIAssistantMessage = {
        role: 'assistant',
        content: textContent || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      }

      result.push(assistantMsg)
      continue
    }

    // User message (non-tool-result)
    if (typeof msg.content === 'string') {
      result.push({ role: 'user', content: msg.content })
      continue
    }

    const contentParts: OpenAIContentPart[] = msg.content.map((block: ContentBlock): OpenAIContentPart => {
      if (block.type === 'image') {
        const mimeType = block.source.media_type
        const data = block.source.data
        const url = block.source.type === 'base64'
          ? `data:${mimeType};base64,${data}`
          : data
        return {
          type: 'image_url',
          image_url: { url },
        }
      }
      return { type: 'text', text: block.type === 'text' ? block.text : '' }
    })

    result.push({ role: 'user', content: contentParts })
  }

  return result
}

// --- OpenAI Tool Conversion ---

export function toOpenAITool(tool: ToolDefinition): OpenAITool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }
}

// --- SSE Line Reader ---

export async function* readSSELines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6)
          yield data
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim() !== '') {
      const trimmed = buffer.trim()
      if (trimmed.startsWith('data: ')) {
        yield trimmed.slice(6)
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// --- OpenAI Adapter ---

export class OpenAIAdapter implements LLMAdapter {
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
    const messages = normalizeMessagesForOpenAI(params.messages)
    const tools = params.tools.map(toOpenAITool)

    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.maxTokens ?? 4096,
      messages: [
        { role: 'system', content: params.systemPrompt },
        ...messages,
      ],
      stream: true,
      stream_options: { include_usage: true },
    }

    if (tools.length > 0) {
      body.tools = tools
    }

    try {
      const response = await fetch(`${this.config.endpoint}/v1/chat/completions`, {
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
        yield { type: 'error', error: `OpenAI API error ${response.status}: ${errorText}` }
        return
      }

      if (!response.body) {
        yield { type: 'error', error: 'No response body received' }
        return
      }

      let messageStarted = false
      const activeToolCalls = new Map<number, string>() // index -> id

      for await (const line of readSSELines(response.body)) {
        if (line === '[DONE]') break

        let data: Record<string, unknown>
        try {
          data = JSON.parse(line)
        } catch {
          continue
        }

        // Emit message_start on first chunk
        if (!messageStarted) {
          messageStarted = true
          const id = (data as { id?: string }).id ?? 'msg_openai'
          yield { type: 'message_start', messageId: id }
        }

        // Handle usage-only chunk (final chunk with stream_options.include_usage)
        const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
        const choices = data.choices as Array<{
          delta?: {
            content?: string | null
            tool_calls?: Array<{
              index: number
              id?: string
              function?: { name?: string; arguments?: string }
            }>
          }
          finish_reason?: string | null
        }> | undefined

        if (choices && choices.length > 0) {
          const choice = choices[0]
          const delta = choice.delta

          if (delta) {
            // Text content
            if (delta.content) {
              yield { type: 'text_delta', text: delta.content }
            }

            // Tool calls
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index

                // New tool call start
                if (tc.id) {
                  activeToolCalls.set(idx, tc.id)
                  yield {
                    type: 'tool_use_start',
                    id: tc.id,
                    name: tc.function?.name ?? '',
                  }
                }

                // Tool call argument delta
                if (tc.function?.arguments) {
                  const id = activeToolCalls.get(idx) ?? ''
                  yield {
                    type: 'tool_use_delta',
                    id,
                    inputJson: tc.function.arguments,
                  }
                }
              }
            }
          }

          // Finish reason
          if (choice.finish_reason === 'tool_calls') {
            for (const [, id] of activeToolCalls) {
              yield { type: 'tool_use_end', id }
            }
            activeToolCalls.clear()
            yield {
              type: 'message_end',
              stopReason: 'tool_use',
              ...(usage ? { usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } } : {}),
            }
          } else if (choice.finish_reason === 'stop') {
            yield {
              type: 'message_end',
              stopReason: 'end_turn',
              ...(usage ? { usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } } : {}),
            }
          } else if (choice.finish_reason === 'length') {
            yield {
              type: 'message_end',
              stopReason: 'max_tokens',
              ...(usage ? { usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } } : {}),
            }
          }
        }

        // Usage-only chunk (no choices, just usage)
        if (usage && (!choices || choices.length === 0)) {
          yield {
            type: 'message_end',
            stopReason: null,
            usage: {
              inputTokens: usage.prompt_tokens ?? 0,
              outputTokens: usage.completion_tokens ?? 0,
            },
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      yield { type: 'error', error: message }
    }
  }
}
