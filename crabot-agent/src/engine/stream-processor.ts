import { jsonrepair } from 'jsonrepair'
import type { StreamChunk, ToolUseBlock, RawReasoningBlock, LLMTokenUsage, GeminiProviderState } from './types'

/**
 * 判断 chunk 是否对消费者可见。message_start 仅携带 messageId，
 * 与 heartbeat 都不生成可见内容，重试可安全丢弃这两类传输元事件。
 * 此谓词与 process() 中 noop 分支的判定保持单点同步。
 */
export function isMaterialChunk(chunk: StreamChunk): boolean {
  return chunk.type !== 'message_start' && chunk.type !== 'heartbeat'
}

export interface ProcessedResponse {
  readonly providerState?: GeminiProviderState
  readonly text: string
  readonly toolUseBlocks: ReadonlyArray<ToolUseBlock>
  readonly reasoningBlocks: ReadonlyArray<RawReasoningBlock>
  readonly stopReason: string | null
  readonly usage?: LLMTokenUsage
}

interface ToolUseBuffer {
  readonly id: string
  readonly name: string
  inputJsonParts: string[]
}

export class StreamProcessor {
  private providerState?: GeminiProviderState
  private textParts: string[] = []
  private toolUseBlocks: ToolUseBlock[] = []
  private reasoningBlocks: RawReasoningBlock[] = []
  private activeToolBuffers: Map<string, ToolUseBuffer> = new Map()
  private stopReason: string | null = null
  private usage: LLMTokenUsage | undefined = undefined

  process(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'text_delta':
        this.textParts.push(chunk.text)
        break

      case 'tool_use_start':
        this.activeToolBuffers.set(chunk.id, {
          id: chunk.id,
          name: chunk.name,
          inputJsonParts: [],
        })
        break

      case 'tool_use_delta': {
        const buffer = this.activeToolBuffers.get(chunk.id)
        if (buffer) {
          buffer.inputJsonParts.push(chunk.inputJson)
        }
        break
      }

      case 'tool_use_end': {
        const buffer = this.activeToolBuffers.get(chunk.id)
        if (buffer) {
          const input = parseToolInput(buffer.inputJsonParts.join(''))
          this.toolUseBlocks.push({
            type: 'tool_use',
            id: buffer.id,
            name: buffer.name,
            input,
          })
          this.activeToolBuffers.delete(chunk.id)
        }
        break
      }

      case 'raw_reasoning':
        this.reasoningBlocks.push({ type: 'raw_reasoning', data: chunk.data })
        break

      case 'message_end':
        this.stopReason = chunk.stopReason
        if (chunk.usage) {
          this.usage = { ...chunk.usage }
        }
        break

      case 'provider_state':
        this.providerState = chunk.state
        break

      case 'heartbeat':
      case 'message_start':
      case 'error':
        // Not tracked by StreamProcessor
        break
    }
  }

  finalize(): ProcessedResponse {
    return {
      ...(this.providerState ? { providerState: this.providerState } : {}),
      text: this.textParts.join(''),
      toolUseBlocks: [...this.toolUseBlocks],
      reasoningBlocks: [...this.reasoningBlocks],
      stopReason: this.stopReason,
      ...(this.usage !== undefined ? { usage: { ...this.usage } } : {}),
    }
  }

  reset(): void {
    this.providerState = undefined
    this.textParts = []
    this.toolUseBlocks = []
    this.reasoningBlocks = []
    this.activeToolBuffers = new Map()
    this.stopReason = null
    this.usage = undefined
  }
}

export function parseToolInput(raw: string): Record<string, unknown> {
  if (raw.trim() === '') {
    return {}
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    // Try jsonrepair for slightly malformed JSON
  }

  try {
    const repaired = jsonrepair(raw)
    const parsed: unknown = JSON.parse(repaired)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Completely unparseable
  }

  return { _raw: raw }
}
