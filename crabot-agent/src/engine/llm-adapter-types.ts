/**
 * LLM Adapter 共享类型和工具函数
 */

import { StreamProcessor } from './stream-processor.js'
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
  updateConfig(config: Partial<LLMAdapterConfig>): void
}

export interface LLMAdapterConfig {
  readonly endpoint: string
  readonly apikey: string
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
  const effectiveParams = params.signal ? params : {
    ...params,
    signal: AbortSignal.timeout(DEFAULT_LLM_TIMEOUT_MS),
  }
  const processor = new StreamProcessor()
  for await (const chunk of adapter.stream(effectiveParams)) {
    if (chunk.type === 'error') {
      throw new Error(chunk.error)
    }
    processor.process(chunk)
  }
  const result = processor.finalize()
  return {
    content: [
      ...(result.text ? [{ type: 'text' as const, text: result.text }] : []),
      ...result.toolUseBlocks,
    ],
    stopReason: result.stopReason,
    usage: result.usage,
  }
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
