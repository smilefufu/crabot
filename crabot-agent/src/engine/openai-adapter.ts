/**
 * OpenAI Chat Completions LLM Adapter
 */

import type { LLMAdapter, LLMAdapterConfig, LLMStreamParams, LLMCallResponse } from './llm-adapter-types.js'
import { isToolResultMessage, extractText, buildImageUrl, readSSELines, mergeConsecutiveUserMessages, wrapOnRetry } from './llm-adapter-types.js'
import type { EngineMessage, ToolDefinition, StreamChunk, ContentBlock } from './types.js'
import { HttpResponseError, streamWithRetry, withRetry } from './retry-utils.js'
import { isMaterialChunk, parseToolInput } from './stream-processor.js'

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

type OpenAIMessage =
  | { readonly role: 'user'; readonly content: string | OpenAIContentPart[] }
  | OpenAIAssistantMessage
  | OpenAIToolMessage
  | { readonly role: 'system'; readonly content: string }

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
        result.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content })
      }
      continue
    }

    if (msg.role === 'assistant') {
      const textContent = extractText(msg.content)
      const toolUseParts = msg.content.filter((b) => b.type === 'tool_use')

      const toolCalls: OpenAIToolCall[] = toolUseParts.map((b) => {
        const tu = b as { id: string; name: string; input: Record<string, unknown> }
        return {
          id: tu.id,
          type: 'function' as const,
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        }
      })

      result.push({
        role: 'assistant',
        content: textContent || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }

    if (typeof msg.content === 'string') {
      result.push({ role: 'user', content: msg.content })
      continue
    }

    const contentParts: OpenAIContentPart[] = msg.content.map((block: ContentBlock): OpenAIContentPart => {
      if (block.type === 'image') {
        return { type: 'image_url', image_url: { url: buildImageUrl(block.source) } }
      }
      return { type: 'text', text: block.type === 'text' ? block.text : '' }
    })

    result.push({ role: 'user', content: contentParts })
  }

  return mergeConsecutiveUserMessages(result, (content) =>
    Array.isArray(content) ? content : [{ type: 'text' as const, text: content as string } as OpenAITextContent],
  )
}

// --- OpenAI Tool Conversion ---

export function toOpenAITool(tool: ToolDefinition): OpenAITool {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }
}

type OpenAIFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'function_call'
type EngineStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null

function mapOpenAIFinishReason(raw: string | null | undefined): EngineStopReason {
  switch (raw as OpenAIFinishReason | null | undefined) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    default:
      return null
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
    yield* streamWithRetry(
      'openai-adapter',
      () => this.streamOnce(params),
      {
        abortSignal: params.signal,
        isMaterial: isMaterialChunk,
        onRetry: wrapOnRetry(params.onRetry, 'pre-stream'),
      },
    )
  }

  async complete(params: LLMStreamParams): Promise<LLMCallResponse> {
    const messages = normalizeMessagesForOpenAI(params.messages)
    const tools = params.tools.map(toOpenAITool)

    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.maxTokens ?? 4096,
      messages: [{ role: 'system', content: params.systemPrompt }, ...messages],
      stream: false,
    }
    if (tools.length > 0) {
      body.tools = tools
    }

    const data = await withRetry(
      'openai-adapter',
      async () => {
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
          throw new HttpResponseError(response.status, errorText, 'openai-adapter')
        }
        return response.json() as Promise<{
          choices?: Array<{
            message?: {
              content?: string | null
              tool_calls?: Array<{
                id: string
                function?: { name?: string; arguments?: string }
              }>
            }
            finish_reason?: string | null
          }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }>
      },
      {
        abortSignal: params.signal,
        onRetry: wrapOnRetry(params.onRetry, 'complete'),
      },
    )

    const choice = data.choices?.[0]
    const msg = choice?.message
    const content: ContentBlock[] = []

    if (msg?.content) {
      content.push({ type: 'text', text: msg.content })
    }
    if (msg?.tool_calls) {
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name ?? '',
          input: parseToolInput(tc.function?.arguments ?? ''),
        })
      }
    }

    const stopReason = mapOpenAIFinishReason(choice?.finish_reason ?? null)
    const usage = data.usage
    return {
      content,
      stopReason,
      ...(usage
        ? { usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } }
        : {}),
    }
  }

  private async *streamOnce(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
    const messages = normalizeMessagesForOpenAI(params.messages)
    const tools = params.tools.map(toOpenAITool)

    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.maxTokens ?? 4096,
      messages: [{ role: 'system', content: params.systemPrompt }, ...messages],
      stream: true,
      stream_options: { include_usage: true },
    }

    if (tools.length > 0) {
      body.tools = tools
    }

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
      throw new HttpResponseError(response.status, errorText, 'openai-adapter')
    }

    if (!response.body) {
      throw new Error('openai-adapter: no response body received')
    }

    let messageStarted = false
    const activeToolCalls = new Map<number, string>()

    for await (const line of readSSELines(response.body)) {
      if (line === '[DONE]') break

      let data: Record<string, unknown>
      try {
        data = JSON.parse(line)
      } catch {
        continue
      }

      if (!messageStarted) {
        messageStarted = true
        yield { type: 'message_start', messageId: (data as { id?: string }).id ?? 'msg_openai' }
      }

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
          if (delta.content) {
            yield { type: 'text_delta', text: delta.content }
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.id) {
                activeToolCalls.set(tc.index, tc.id)
                yield { type: 'tool_use_start', id: tc.id, name: tc.function?.name ?? '' }
              }
              if (tc.function?.arguments) {
                yield { type: 'tool_use_delta', id: activeToolCalls.get(tc.index) ?? '', inputJson: tc.function.arguments }
              }
            }
          }
        }

        const stopReason = mapOpenAIFinishReason(choice.finish_reason)
        if (stopReason !== null) {
          if (choice.finish_reason === 'tool_calls') {
            for (const [, id] of activeToolCalls) {
              yield { type: 'tool_use_end', id }
            }
            activeToolCalls.clear()
          }
          yield {
            type: 'message_end',
            stopReason,
            ...(usage ? { usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } } : {}),
          }
        }
      }

      if (usage && (!choices || choices.length === 0)) {
        yield {
          type: 'message_end',
          stopReason: null,
          usage: { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 },
        }
      }
    }
  }
}
