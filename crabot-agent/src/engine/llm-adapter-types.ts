/**
 * LLM Adapter 共享类型和工具函数
 */

import { StreamProcessor } from './stream-processor.js'
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  isRetryableError,
  sleep,
} from './retry-utils.js'
import type {
  EngineMessage,
  EngineToolResultMessage,
  ToolDefinition,
  StreamChunk,
  ContentBlock,
} from './types.js'

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
  /**
   * Optional non-streaming completion. Preferred over `stream()` when available —
   * avoids SSE parsing and makes mid-response network failures naturally retryable.
   * Adapters that can't express their full response via a single non-streaming call
   * (e.g. Codex with encrypted reasoning) may omit this; callers will fall back to
   * consuming `stream()`.
   */
  complete?(params: LLMStreamParams): Promise<LLMCallResponse>
  updateConfig(config: Partial<LLMAdapterConfig>): void
}

export interface LLMAdapterConfig {
  readonly endpoint: string
  readonly apikey: string
  readonly accountId?: string
}

export interface LLMCallResponse {
  readonly content: ContentBlock[]
  readonly stopReason: string | null
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number }
}

// --- Non-streaming convenience ---

export const DEFAULT_LLM_TIMEOUT_MS = 120_000

export async function callNonStreaming(
  adapter: LLMAdapter,
  params: LLMStreamParams,
): Promise<LLMCallResponse> {
  const effectiveParams = params.signal != null ? params : {
    ...params,
    signal: AbortSignal.timeout(DEFAULT_LLM_TIMEOUT_MS),
  }

  // Prefer native non-streaming endpoint when the adapter provides one.
  // This avoids SSE parsing and makes mid-response network failures naturally
  // retryable (vs. streaming, which can only retry before the first chunk).
  if (adapter.complete) {
    return adapter.complete(effectiveParams)
  }

  // Fallback: consume stream and aggregate. Some adapters（如 OpenAI Responses）
  // 不支持 stream:false——必须走 SSE。streamWithRetry 内部仅在首 chunk 前能 retry，
  // 一旦中途断流（mid-stream socket drop），它会向上抛错。
  //
  // 但 callNonStreaming 这一层是纯 buffer 消费——丢弃 partial processor 状态、
  // 重发整个请求是安全的（server 端会生成新 response，没有下游 streaming 消费者
  // 看得到重复 chunk）。所以这里加 iter-level retry：mid-stream 断了就重跑全流，
  // 直到拿到完整结果或耗尽 retry 配额。
  return await withStreamConsumptionRetry(adapter, effectiveParams)
}

async function withStreamConsumptionRetry(
  adapter: LLMAdapter,
  params: LLMStreamParams,
): Promise<LLMCallResponse> {
  const maxRetries = DEFAULT_MAX_RETRIES
  const delayMs = DEFAULT_RETRY_DELAY_MS

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const processor = new StreamProcessor()
      for await (const chunk of adapter.stream(params)) {
        if (params.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }
        if (chunk.type === 'error') {
          throw new Error(chunk.error)
        }
        processor.process(chunk)
      }
      const result = processor.finalize()
      return {
        content: [
          // Reasoning items come first so they precede text/tool_use when replayed to Codex
          ...result.reasoningBlocks,
          ...(result.text ? [{ type: 'text' as const, text: result.text }] : []),
          ...result.toolUseBlocks,
        ],
        stopReason: result.stopReason,
        usage: result.usage,
      }
    } catch (err) {
      if (params.signal?.aborted) throw err
      if (!isRetryableError(err)) throw err
      if (attempt >= maxRetries) throw err
      console.error(
        `[callNonStreaming] stream attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${delayMs}ms:`,
        err,
      )
      await sleep(delayMs, params.signal)
      // 下一轮 loop 会用全新 processor + 重新 call adapter.stream()，
      // 服务端生成新 response（partial 浪费，但 task 能完成）
    }
  }
  throw new Error('callNonStreaming: retry loop exited unexpectedly')
}

// --- Shared Helpers ---

export function isToolResultMessage(msg: EngineMessage): msg is EngineToolResultMessage {
  return msg.role === 'user' && 'toolResults' in msg
}

/** Extract concatenated text from content blocks */
export function extractText(blocks: ReadonlyArray<ContentBlock>): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('')
}

/** Build image URL from source (base64 data URI or external URL) */
export function buildImageUrl(source: { type: 'base64' | 'url'; media_type: string; data: string }): string {
  return source.type === 'base64'
    ? `data:${source.media_type};base64,${source.data}`
    : source.data
}

/**
 * Merge consecutive same-role messages by concatenating their content arrays.
 * Required by Anthropic API (alternating user/assistant) and defensive for OpenAI.
 */
export function mergeConsecutiveUserMessages<T extends { role: string; content: unknown }>(
  messages: T[],
  toArray: (content: unknown) => unknown[],
): T[] {
  const merged: T[] = []
  for (const msg of messages) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : undefined
    if (prev && prev.role === 'user' && msg.role === 'user') {
      merged[merged.length - 1] = {
        ...prev,
        content: [...toArray(prev.content), ...toArray(msg.content)],
      }
    } else {
      merged.push(msg)
    }
  }
  return merged
}

// --- SSE Reader ---

export async function* readSSEEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() ?? ''

      for (const block of blocks) {
        if (!block.trim()) continue
        let event = ''
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) {
            event = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            data = line.slice(6)
          }
        }
        if (data) {
          yield { event, data }
        }
      }
    }

    if (buffer.trim()) {
      let event = ''
      let data = ''
      for (const line of buffer.split('\n')) {
        if (line.startsWith('event: ')) {
          event = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          data = line.slice(6)
        }
      }
      if (data) {
        yield { event, data }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Convenience wrapper for Chat Completions SSE (ignores event field) */
export async function* readSSELines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const { data } of readSSEEvents(body)) {
    yield data
  }
}
