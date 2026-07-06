/**
 * OpenAI Chat Completions LLM Adapter
 */

import type { LLMAdapter, LLMAdapterConfig, LLMStreamParams } from './llm-adapter-types.js'
import { isToolResultMessage, extractText, buildImageUrl, readSSELines, mergeConsecutiveUserMessages, capToolResultForLLM } from './llm-adapter-types.js'
import type { EngineMessage, ToolDefinition, StreamChunk, ContentBlock, LLMTokenUsage } from './types.js'
import { HttpResponseError, StreamProtocolError } from './retry-utils.js'
import { streamWithTimeoutAndRetry } from './stream-timeout.js'

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
  // DeepSeek thinking mode 扩展字段；tool-use loop 中必须原样回传，其它 OpenAI 兼容 endpoint 忽略
  readonly reasoning_content?: string
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
        result.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: capToolResultForLLM(tr.content) })
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

      // DeepSeek thinking mode 契约：tool-use loop 中 assistant 消息必须把 reasoning_content
      // 原样回传，否则 400。其它 OpenAI 兼容 endpoint 会把这个字段当 unknown 字段忽略。
      const reasoningContent = msg.content
        .filter((b): b is { type: 'raw_reasoning'; data: Record<string, unknown> } => b.type === 'raw_reasoning')
        .map((b) => (typeof b.data.reasoning_content === 'string' ? b.data.reasoning_content : ''))
        .join('')

      result.push({
        role: 'assistant',
        content: textContent || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      } as OpenAIAssistantMessage)
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
    yield* streamWithTimeoutAndRetry('openai-adapter', (p) => this.streamOnce(p), params)
  }

  private async *streamOnce(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
    const messages = normalizeMessagesForOpenAI(params.messages)
    const tools = params.tools.map(toOpenAITool)

    const body: Record<string, unknown> = {
      model: params.model,
      ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
      messages: [{ role: 'system', content: params.systemPrompt }, ...messages],
      stream: true,
      stream_options: { include_usage: true },
    }

    if (tools.length > 0) {
      body.tools = tools
    }

    const response = await fetch(`${this.config.endpoint}/chat/completions`, {
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
    // Chat Completions 流式把 finish_reason 和（include_usage 的）usage 分别放在两个尾包里：
    // 先来 choices[0].finish_reason，再来一个 choices=[] 只带 usage 的收尾包。message_end 必须
    // 在整条流结束后只发一次，携带累积的 stopReason + usage —— 与 anthropic/responses adapter
    // 的「单次 message_end」契约一致。早期实现对两个尾包各发一次 message_end，第二次
    // stopReason=null 经 StreamProcessor 覆盖把 'tool_use' 抹成 null，导致 query-loop 不执行工具、
    // 留下无 output 的 function_call，下一轮被后端拒为 "No tool output found for function call"。
    let finalStopReason: EngineStopReason = null
    let finalUsage: LLMTokenUsage | undefined = undefined
    // response.body 是 ReadableStream。提前 break（[DONE]）或异常退出时不显式 cancel，
    // undici 在 keep-alive 路径下可能晚释放 socket / decompressor（这块是 native heap，
    // V8 看不见）。详见 2026-06-06 kernel watchdog panic 复盘 —— anthropic-adapter 是
    // 主因，这里属同类防御。
    const sseBody = response.body
    try {
    for await (const line of readSSELines(sseBody)) {
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

      const usage = extractOpenAIUsage(data.usage)
      if (usage) finalUsage = usage
      const choices = data.choices as Array<{
        delta?: {
          content?: string | null
          reasoning_content?: string | null
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
          // DeepSeek thinking mode：reasoning_content fragment 先发，保证 reasoning → text → tool_use
          // 的顺序（query-loop.buildAssistantContent 依赖 raw_reasoning 在前）
          if (delta.reasoning_content) {
            yield { type: 'raw_reasoning', data: { reasoning_content: delta.reasoning_content } }
          }

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

        if (choice.finish_reason === 'content_filter') {
          throw new HttpResponseError(
            400,
            JSON.stringify({ code: 'content_filter', message: 'OpenAI chat completion stopped by content_filter' }),
            'openai-adapter',
          )
        }
        if (choice.finish_reason === 'function_call') {
          throw new Error('openai-adapter legacy function_call streaming is not supported')
        }

        const stopReason = mapOpenAIFinishReason(choice.finish_reason)
        if (stopReason !== null) {
          finalStopReason = stopReason
          if (choice.finish_reason === 'tool_calls') {
            for (const [, id] of activeToolCalls) {
              yield { type: 'tool_use_end', id }
            }
            activeToolCalls.clear()
          }
        }
      }
    }
    } finally {
      try { await sseBody.cancel() } catch { /* already drained / errored */ }
    }

    // 单次 message_end：流正常结束（[DONE] / 自然收尾）后发出。中途 throw 不会走到这里
    // （异常从 for-await 抛出，经 finally 后传播），符合「不重放半截流」的重试语义。
    if (messageStarted) {
      if (finalStopReason === null) {
        throw new StreamProtocolError('openai-adapter stream ended without finish_reason')
      }
      yield {
        type: 'message_end',
        stopReason: finalStopReason,
        ...(finalUsage ? { usage: finalUsage } : {}),
      }
    }
  }
}

/**
 * 从 OpenAI Chat Completions usage 提取 token。
 *
 * 语义对齐（关键）：OpenAI 原生 `prompt_tokens` 是"全量输入（含 cached）"，
 * 而 Anthropic 原生 `input_tokens` 是"未命中缓存的输入"。这里把 OpenAI 拍成
 * Anthropic 语义——`inputTokens = prompt_tokens - cached_tokens`，让全链路统一：
 *   inputTokens         = 未命中缓存的输入（实际计费的 prompt 部分）
 *   cacheReadTokens     = 命中缓存读取的部分（享受折扣价）
 *   cacheCreationTokens = 写入缓存的部分（Anthropic 专属，OpenAI 缺省）
 *   全量 prompt size    = inputTokens + cacheReadTokens + cacheCreationTokens
 */
function extractOpenAIUsage(raw: unknown): LLMTokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  if (typeof u.prompt_tokens !== 'number' && typeof u.completion_tokens !== 'number') return undefined
  const promptTokens = u.prompt_tokens ?? 0
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0
  const uncached = Math.max(0, promptTokens - cached)
  return {
    inputTokens: uncached,
    outputTokens: u.completion_tokens ?? 0,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  }
}
