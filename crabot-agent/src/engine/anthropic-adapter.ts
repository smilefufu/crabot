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
import { streamWithTimeoutAndRetry } from './stream-timeout.js'
import { isToolResultMessage, mergeConsecutiveUserMessages, capToolResultForLLM } from './llm-adapter-types.js'
import type { EngineMessage, ToolDefinition, StreamChunk, LLMTokenUsage } from './types.js'

// --- Default max_tokens by model family ---
// Anthropic SDK 强制要求 max_tokens；当上游（admin provider config）没配时，
// 按模型家族选一个不会被 API 拒绝且能容纳 reasoning + 实际产出的值。
// 用户可在 Admin Web 模型设置里覆盖。
function defaultAnthropicMaxTokens(model: string): number {
  const m = model.toLowerCase()
  // claude-3 / claude-3-5 / claude-3-7 系列 API 上限多为 8192
  if (m.includes('claude-3')) return 8192
  // claude-4 / claude-opus-4 / claude-sonnet-4 / claude-haiku-4 起，上限 32K-64K
  // 32K 是各档位都能接受的安全值（够 reasoning + 长响应）；想跑更长由用户在 admin 上调
  return 32768
}

// --- Anthropic Message Normalization ---

export function normalizeMessagesForAnthropic(messages: ReadonlyArray<EngineMessage>): MessageParam[] {
  const raw = messages.map((msg): MessageParam => {    if (isToolResultMessage(msg)) {
      return {
        role: 'user',
        content: msg.toolResults.map((tr) => {
          const capped = capToolResultForLLM(tr.content)
          if (tr.images?.length) {
            return {
              type: 'tool_result' as const,
              tool_use_id: tr.tool_use_id,
              is_error: tr.is_error,
              content: [
                ...(capped ? [{ type: 'text' as const, text: capped }] : []),
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
            content: capped,
            is_error: tr.is_error,
          }
        }),
      }
    }

    if (msg.role === 'assistant') {
      return {
        role: 'assistant',
        content: msg.content.flatMap((block): Array<TextBlockParam | ToolUseBlockParam> => {
          switch (block.type) {
            case 'text':
              return [{ type: 'text' as const, text: block.text }]
            case 'tool_use':
              return [
                {
                  type: 'tool_use' as const,
                  id: block.id,
                  name: block.name,
                  input: block.input,
                },
              ]
            default:
              // 不认识的 block（如 raw_reasoning）丢弃——原先映射成空 text block
              // 发给 API 是纯垃圾 token，且空 text block 本身会被 API 拒绝
              return []
          }
        }),
      }
    }

    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content }
    }

    const content: Array<TextBlockParam | ImageBlockParam | ToolUseBlockParam | ToolResultBlockParam> =
      msg.content.flatMap((block): Array<TextBlockParam | ImageBlockParam> => {
        if (block.type === 'image') {
          return [
            {
              type: 'image',
              source: {
                type: block.source.type as 'base64',
                media_type: block.source.media_type as ImageBlockParam.Source['media_type'],
                data: block.source.data,
              },
            },
          ]
        }
        // 不认识的 block 丢弃，不映射成空 text block 发给 API
        if (block.type !== 'text') return []
        return [{ type: 'text', text: block.text }]
      })

    return { role: 'user', content }
  })

  // 不认识的 block 被丢弃后可能产生 content 为空数组的消息——发给 API 会 400，
  // 整条丢弃。仅当 content 真正为空（无 text 无 tool_use）才丢：
  // 含 tool_use 的 assistant 消息 content 非空，不影响 tool_use/tool_result 配对语义。
  const nonEmpty = raw.filter((msg) => !(Array.isArray(msg.content) && msg.content.length === 0))

  return mergeConsecutiveUserMessages(nonEmpty, (content) =>
    Array.isArray(content) ? content : [{ type: 'text' as const, text: content as string }],
  )
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
      // Retries are handled by streamWithRetry() at the adapter layer.
      maxRetries: 0,
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
    yield* streamWithTimeoutAndRetry('anthropic-adapter', (p) => this.streamOnce(p), params)
  }

  private async *streamOnce(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
    const messages = normalizeMessagesForAnthropic(params.messages)
    const tools = params.tools.map(AnthropicAdapter.toAnthropicTool)

    // Prompt caching：注入 3 个 cache breakpoint（固定 5 分钟 ephemeral，SDK stable
    // 类型尚未带出 cache_control 字段，靠结构化类型直接附加）。只加缓存标记，
    // 不改消息内容本身。breakpoint 位置：1) system 末尾 2) 最后一个 tool 定义
    // 3) 最后一条消息的最后一个 content block（缓存整段会话历史前缀）。
    const EPHEMERAL = { type: 'ephemeral' } as const

    // 空 system prompt 不传（空 text block 会被 API 拒绝）
    const system = params.systemPrompt
      ? [{ type: 'text' as const, text: params.systemPrompt, cache_control: EPHEMERAL }]
      : undefined

    const cachedTools = tools.map((tool, i) =>
      i === tools.length - 1 ? { ...tool, cache_control: EPHEMERAL } : tool,
    )

    const cachedMessages = messages.map((msg, i) => {
      if (i !== messages.length - 1) return msg
      if (typeof msg.content === 'string') {
        return {
          ...msg,
          content: [{ type: 'text' as const, text: msg.content, cache_control: EPHEMERAL }],
        }
      }
      if (msg.content.length === 0) return msg
      const blocks = msg.content.map((block, j) =>
        j === msg.content.length - 1 ? { ...block, cache_control: EPHEMERAL } : block,
      )
      return { ...msg, content: blocks }
    })

    const stream = this.client.messages.stream({
      model: params.model,
      max_tokens: params.maxTokens ?? defaultAnthropicMaxTokens(params.model),
      ...(system ? { system } : {}),
      messages: cachedMessages,
      ...(cachedTools.length > 0 ? { tools: cachedTools } : {}),
    })

    // signal 通常是 task 级长寿命的（一个 task 内每个 turn 都共用）。如果只 addEventListener
    // 不 removeEventListener，每次 LLM call 都会在 signal 上挂一个 onAbort 闭包，闭包又
    // retain 完整的 stream 对象（含 TLS / Zlib / 累积 Buffer，多在 native heap），长跑后
    // RSS 可飙到 10GB+ 量级。详见 2026-06-06 kernel watchdog panic 复盘。
    let onAbort: (() => void) | null = null
    if (params.signal) {
      onAbort = () => stream.abort()
      params.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
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
        usage: extractAnthropicUsage(finalMessage.usage),
      }
    } finally {
      if (params.signal && onAbort) {
        params.signal.removeEventListener('abort', onAbort)
      }
    }
  }
}

/**
 * Anthropic SDK Stable Usage 类型只暴露 input/output_tokens，
 * 但 prompt caching 启用时 response payload 实际带 cache_creation_input_tokens
 * 和 cache_read_input_tokens（Beta 类型已有，stable 没同步）。这里宽松读取。
 */
function extractAnthropicUsage(raw: { input_tokens: number; output_tokens: number }): LLMTokenUsage {
  const extra = raw as { cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }
  const cacheCreation = typeof extra.cache_creation_input_tokens === 'number' ? extra.cache_creation_input_tokens : undefined
  const cacheRead = typeof extra.cache_read_input_tokens === 'number' ? extra.cache_read_input_tokens : undefined
  return {
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    ...(cacheCreation !== undefined ? { cacheCreationTokens: cacheCreation } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
  }
}
