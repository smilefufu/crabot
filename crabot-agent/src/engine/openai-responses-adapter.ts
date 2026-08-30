/**
 * OpenAI Responses API LLM Adapter
 *
 * 用于直连 OpenAI Responses API (chatgpt.com/backend-api/codex 或 api.openai.com)
 */

import type { LLMAdapter, LLMAdapterConfig, LLMStreamParams } from './llm-adapter-types.js'
import { isToolResultMessage, extractText, buildImageUrl, readSSEEvents, capToolResultForLLM, thinkingEffortValue } from './llm-adapter-types.js'
import type { EngineMessage, ToolDefinition, StreamChunk, ContentBlock, LLMTokenUsage } from './types.js'
import { HttpResponseError, StreamProtocolError, parseRetryAfterMs } from './retry-utils.js'
import { withStreamTimeout } from './stream-timeout.js'

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
        const capped = capToolResultForLLM(tr.content)
        result.push({
          type: 'function_call_output',
          call_id: callId,
          output: tr.is_error ? `Error: ${capped}` : capped,
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

// response.failed 的 error.code 映射到 HTTP status，让 isRetryableError 直接复用
// 状态码分类（5xx/429 重试、4xx 不重试）。未列出的 code 默认 400（不可重试）。
const STATUS_BY_FAILED_CODE: Record<string, number> = {
  server_error: 500,
  rate_limit_exceeded: 429,
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
    // 只加 TTFB/空闲超时；重试统一由 callNonStreaming 单层处理（含配置热切换唤醒）。
    yield* withStreamTimeout((signal) => this.streamOnce({ ...params, signal }), params.signal)
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
    // 思考强度（spec 2026-08 §5.2）：Codex 跟随默认保持现状 effort='medium'；槽位配置覆盖。
    // OpenAI 官方 Responses 跟随默认不发 reasoning；配置了才发。
    if (isCodexBackend) {
      body.reasoning = { effort: thinkingEffortValue(params.thinking) ?? 'medium', summary: 'auto' }
      body.include = ['reasoning.encrypted_content']
    } else {
      const reasoningEffort = thinkingEffortValue(params.thinking)
      if (reasoningEffort !== undefined) body.reasoning = { effort: reasoningEffort }
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
      const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'))
      throw new HttpResponseError(response.status, errorText, 'openai-responses-adapter', retryAfter)
    }

    if (!response.body) {
      throw new Error('openai-responses-adapter: no response body received')
    }

    let messageStarted = false
    let sawTerminalEvent = false
    // Maps streamed item.id (fc_xxx) to the encoded block id ("call_xxx|fc_xxx") that
    // we use internally so replay emits both id and call_id to the Responses API.
    const activeFunctionCalls = new Map<string, { encodedId: string; name: string }>()

    // response.body 异常退出或 throw 不显式 cancel 时，undici 在 keep-alive 路径下
    // 可能晚释放 socket / decompressor（native heap）。详见 2026-06-06 kernel watchdog
    // panic 复盘 —— anthropic-adapter 是主因，这里属同类防御。
    const sseBody = response.body
    try {
    for await (const { event, data } of readSSEEvents(sseBody)) {
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
          sawTerminalEvent = true
          const resp = parsed.response as {
            output?: Array<{ type?: string }>
            usage?: ResponsesApiUsage
          } | undefined

          // Trust the stream: if a function_call item was emitted, the stop reason is tool_use.
          // This guards against edge cases where response.completed.output omits the function_call type.
          const hasToolCallsInOutput = resp?.output?.some(item => item.type === 'function_call') ?? false
          const hasToolCallsInStream = activeFunctionCalls.size > 0
          const hasToolCalls = hasToolCallsInOutput || hasToolCallsInStream
          const usage = extractResponsesApiUsage(resp?.usage)

          yield {
            type: 'message_end',
            stopReason: hasToolCalls ? 'tool_use' : 'end_turn',
            ...(usage ? { usage } : {}),
          }
          break
        }

        case 'response.incomplete': {
          sawTerminalEvent = true
          // 终态事件，响应被截断但 stream 正常结束。不处理这条会让 stopReason 落到
          // null，被上游 query-loop 误判为 silent end_turn，触发反向放大的重试链。
          const resp = parsed.response as {
            usage?: ResponsesApiUsage
            incomplete_details?: { reason?: string }
          } | undefined
          const reason = resp?.incomplete_details?.reason
          const usage = extractResponsesApiUsage(resp?.usage)

          // content_filter 不可恢复（同输入必再被拦）；status=400 走 non-retryable。
          if (reason === 'content_filter') {
            throw new HttpResponseError(
              400,
              JSON.stringify({ code: 'content_filter', incomplete_details: resp?.incomplete_details ?? {} }),
              'openai-responses-adapter',
            )
          }

          // max_output_tokens：暴露 stopReason='max_tokens' 让 query-loop 走 compact 而非追问。
          yield {
            type: 'message_end',
            stopReason: 'max_tokens',
            ...(usage ? { usage } : {}),
          }
          break
        }

        case 'response.failed': {
          sawTerminalEvent = true
          // 终态事件，error.code 映射到 HTTP status 复用 isRetryableError 的状态码分类。
          const resp = parsed.response as {
            error?: { code?: string; message?: string }
          } | undefined
          const errorCode = resp?.error?.code ?? 'unknown'
          const errorMessage = resp?.error?.message ?? 'response.failed without error details'
          const status = STATUS_BY_FAILED_CODE[errorCode] ?? 400
          throw new HttpResponseError(
            status,
            JSON.stringify({ code: errorCode, message: errorMessage }),
            'openai-responses-adapter',
          )
        }

        default:
          break
      }
    }
    } finally {
      try { await sseBody.cancel() } catch { /* already drained / errored */ }
    }
    if (messageStarted && !sawTerminalEvent) {
      throw new StreamProtocolError('openai-responses-adapter stream ended without terminal event')
    }
  }
}

interface ResponsesApiUsage {
  input_tokens?: number
  output_tokens?: number
  /** 新版 Responses API 暴露的缓存命中字段 */
  input_tokens_details?: { cached_tokens?: number }
}

/**
 * Responses API 与 Chat Completions 同语义：input_tokens 含 cached。
 * 拍成统一语义（Anthropic 风格）：inputTokens 仅记未命中部分。
 */
function extractResponsesApiUsage(raw: ResponsesApiUsage | undefined): LLMTokenUsage | undefined {
  if (!raw) return undefined
  const total = raw.input_tokens ?? 0
  const cached = raw.input_tokens_details?.cached_tokens ?? 0
  const uncached = Math.max(0, total - cached)
  return {
    inputTokens: uncached,
    outputTokens: raw.output_tokens ?? 0,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  }
}
