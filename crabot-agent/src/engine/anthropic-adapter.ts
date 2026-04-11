/**
 * Anthropic LLM Adapter
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  MessageParam,
  Tool as AnthropicTool,
  ImageBlockParam,
  TextBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages'
import { proxyManager } from 'crabot-shared'
import type { LLMAdapter, LLMAdapterConfig, LLMStreamParams } from './llm-adapter-types.js'
import { isToolResultMessage } from './llm-adapter-types.js'
import type { EngineMessage, ToolDefinition, StreamChunk } from './types.js'

// --- Anthropic Message Normalization ---

export function normalizeMessagesForAnthropic(messages: ReadonlyArray<EngineMessage>): MessageParam[] {
  return messages.map((msg): MessageParam => {
    if (isToolResultMessage(msg)) {
      return {
        role: 'user',
        content: msg.toolResults.map((tr) => {
          if (tr.images?.length) {
            return {
              type: 'tool_result' as const,
              tool_use_id: tr.tool_use_id,
              is_error: tr.is_error,
              content: [
                ...(tr.content ? [{ type: 'text' as const, text: tr.content }] : []),
                ...tr.images.map((img) => ({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: img.media_type as 'image/png',
                    data: img.data,
                  },
                })),
              ],
            }
          }
          return {
            type: 'tool_result' as const,
            tool_use_id: tr.tool_use_id,
            content: tr.content,
            is_error: tr.is_error,
          }
        }),
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
      httpAgent: proxyManager.getHttpsAgent(),
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
            break
        }
      }

      const finalMessage = await stream.finalMessage()
      yield {
        type: 'message_end',
        stopReason: finalMessage.stop_reason ?? null,
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      yield { type: 'error', error: message }
    }
  }
}
