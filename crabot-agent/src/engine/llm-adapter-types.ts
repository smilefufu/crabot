/**
 * LLM Adapter 共享类型和工具函数
 */

import { StreamProcessor } from './stream-processor.js'
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  OVERLOADED_WITHOUT_RETRY_AFTER_MAX_RETRIES,
  computeRetryDelayMs,
  getRetryAfterMs,
  interruptibleSleep,
  isOverloadedWithoutRetryAfter,
  isRetryableError,
} from './retry-utils.js'
import { capWithMarker } from './byte-cap.js'
import type {
  EngineMessage,
  EngineToolResultMessage,
  ToolDefinition,
  StreamChunk,
  ContentBlock,
  LLMTokenUsage,
  LLMCallDiagnostics,
} from './types.js'

// --- Interfaces ---

export interface LLMRetryEvent {
  readonly attempt: number      // 1-indexed (第 N 次失败正在准备 retry)
  readonly maxAttempts: number  // 总配额
  readonly delayMs: number      // 即将 sleep 多久后 retry
  readonly error: Error         // 触发本次 retry 的错
  readonly source: 'stream'     // 重试统一在 callNonStreaming 层处理
}

/** 槽位思考强度（base-protocol §5.14 thinking_level/thinking_custom 的运行时形态）。 */
export interface LLMThinkingConfig {
  readonly level?: 'off' | 'low' | 'medium' | 'high'
  readonly custom?: string | number
}

/**
 * LLMConnectionInfo.thinking_level/custom → LLMThinkingConfig。
 * 两字段均缺省（跟随默认）时返回 undefined，调用方据此不下发任何思考参数。
 */
export function thinkingParam(
  level: LLMThinkingConfig['level'],
  custom: LLMThinkingConfig['custom'],
): LLMThinkingConfig | undefined {
  if (level === undefined && custom === undefined) return undefined
  return {
    ...(level !== undefined ? { level } : {}),
    ...(custom !== undefined ? { custom } : {}),
  }
}

/**
 * 思考强度 → 枚举型参数值（OpenAI `reasoning_effort` / Responses `reasoning.effort`；
 * Gemini 经 OpenAI 兼容层映射 thinking level）。
 * off → 'none'；low/medium/high 字面量透传；自定义字符串原样透传；
 * 自定义数字是 budget 型参数（仅 anthropic），此处返回 undefined 表示不适用。
 */
export function thinkingEffortValue(thinking: LLMThinkingConfig | undefined): string | undefined {
  if (!thinking) return undefined
  if (thinking.custom !== undefined) {
    return typeof thinking.custom === 'string' ? thinking.custom : undefined
  }
  return thinking.level === 'off' ? 'none' : thinking.level
}

export interface LLMStreamParams {
  readonly messages: EngineMessage[]
  readonly systemPrompt: string
  readonly tools: ToolDefinition[]
  readonly model: string
  readonly maxTokens?: number
  /** 思考强度；undefined = 跟随模型默认（请求中不出现任何思考参数） */
  readonly thinking?: LLMThinkingConfig
  readonly signal?: AbortSignal
  /**
   * 配置变更信号。重试 sleep 期间若该信号触发，会提前唤醒并调用 onConfigChanged，
   * 让下一次 attempt 有机会使用新的 adapter/model。
   */
  readonly configChangedSignal?: AbortSignal
  /**
   * 配置变更后的刷新回调。返回新的 adapter/model，callNonStreaming 会在下一次 attempt 使用它们。
   */
  readonly onConfigChanged?: () => Promise<{ adapter?: LLMAdapter; model?: string } | void>
  /** 可观测性回调：retry 发生时触发；用于 worker → admin web 实时显示"LLM 正在重试" */
  readonly onRetry?: (event: LLMRetryEvent) => void
}

export interface LLMAdapter {
  // 统一只暴露 stream()：所有 LLM 调用走流式消费 + 缓冲整流重试（见 callNonStreaming）。
  // 2026-06 起移除了非流式 complete()——静默连接易被链路网关掐断，详见 stream-timeout.ts。
  stream(params: LLMStreamParams): AsyncGenerator<StreamChunk>
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
  readonly usage?: LLMTokenUsage
  /** 流式消费诊断（仅成功路径填充），供 trace/span 观测。定义见 ./types.js */
  readonly diagnostics?: LLMCallDiagnostics
}

// --- Non-streaming convenience ---

export async function callNonStreaming(
  adapter: LLMAdapter,
  params: LLMStreamParams,
): Promise<LLMCallResponse> {
  // 统一走流式消费 + 缓冲整流重试（2026-06 起移除非流式 complete() 路径）：
  //   - 流式让字节持续流动，链路网关 / 反代不易把"静默连接"当死连接掐掉；
  //   - 本层是纯 buffer 消费——丢弃 partial、重发整请求是安全的（无下游看得到重复
  //     chunk），所以 mid-stream 断流也能整流重跑，直到成功或耗尽重试次数；
  //   - 单次 attempt 的 TTFB / 空闲超时由各 adapter stream() 内的 withStreamTimeout 负责，
  //     超时抛 StreamTimeoutError（可重试）→ 在这里换新连接重发。
  return await withStreamConsumptionRetry(adapter, params)
}

async function withStreamConsumptionRetry(
  adapter: LLMAdapter,
  params: LLMStreamParams,
): Promise<LLMCallResponse> {
  const maxRetries = DEFAULT_MAX_RETRIES
  const delayMs = DEFAULT_RETRY_DELAY_MS
  const startedAt = Date.now()

  // 重试期间配置可能热更新：currentAdapter / currentModel 允许被 onConfigChanged 替换。
  let currentAdapter = adapter
  let currentModel = params.model
  let generic429Count = 0

  const applyConfigChange = async (): Promise<void> => {
    const update = await params.onConfigChanged?.()
    if (update?.adapter) currentAdapter = update.adapter
    if (update?.model !== undefined) currentModel = update.model
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptStart = Date.now()
    let firstChunkMs: number | undefined
    let chunkCount = 0
    try {
      const processor = new StreamProcessor()
      for await (const chunk of currentAdapter.stream({ ...params, model: currentModel })) {
        if (params.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }
        if (firstChunkMs === undefined) firstChunkMs = Date.now() - attemptStart
        chunkCount++
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
        diagnostics: {
          retries: attempt,
          firstChunkMs,
          chunkCount,
        },
      }
    } catch (err) {
      if (params.signal?.aborted) throw err
      if (!isRetryableError(err)) throw err
      // 无 Retry-After 的通用 429 单独限制次数，避免额度耗尽类伪装成通用 429 时无限拖。
      if (isOverloadedWithoutRetryAfter(err)) {
        generic429Count++
        if (generic429Count > OVERLOADED_WITHOUT_RETRY_AFTER_MAX_RETRIES) {
          throw enrichGiveUp(err, attempt + 1, Date.now() - startedAt)
        }
      }
      // 放弃可重试错误时把"尝试次数/总耗时"写进错误，让失败 trace 可诊断
      // （否则 outcome 只剩一句裸 "fetch failed"，看不出是重试耗尽还是首次即挂）
      if (attempt >= maxRetries) throw enrichGiveUp(err, attempt + 1, Date.now() - startedAt)
      const actualDelay = computeRetryDelayMs(attempt, delayMs, true, getRetryAfterMs(err))
      console.error(
        `[callNonStreaming] stream attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${actualDelay}ms (backoff):`,
        err,
      )
      try {
        params.onRetry?.({
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          delayMs: actualDelay,
          error: err instanceof Error ? err : new Error(String(err)),
          source: 'stream',
        })
      } catch { /* observability callback must not break retry */ }
      await interruptibleSleep(actualDelay, {
        abortSignal: params.signal,
        configChangedSignal: params.configChangedSignal,
        onConfigChanged: applyConfigChange,
      })
      // 下一轮 loop 会用全新 processor + 重新 call adapter.stream()，
      // 服务端生成新 response（partial 浪费，但 task 能完成）
    }
  }
  throw new Error('callNonStreaming: retry loop exited unexpectedly')
}

/** 放弃重试时给错误补上"尝试次数/总耗时"上下文，原错误挂在 cause 上。 */
function enrichGiveUp(err: unknown, attempts: number, elapsedMs: number): Error {
  const base = err instanceof Error ? err : new Error(String(err))
  const elapsedS = Math.round(elapsedMs / 1000)
  const wrapped = new Error(`${base.message}（流式重试放弃：${attempts} 次尝试 / ${elapsedS}s）`)
  wrapped.name = base.name
  ;(wrapped as Error & { cause?: unknown }).cause = base
  return wrapped
}

// --- Shared Helpers ---

export function isToolResultMessage(msg: EngineMessage): msg is EngineToolResultMessage {
  return msg.role === 'user' && 'toolResults' in msg
}

// Adapter-side hard cap：留 1MB 给 stamp / 序列化 metadata，避开 OpenAI Responses API
// 单字符串 10MB 协议上限。正常路径下 tool-orchestration.ts 的 256KB 软截断会先生效；
// 此处只接住绕过编排层的代码路径（如 sub-agent 直接构造 EngineMessage）。
const TOOL_RESULT_HARD_CAP_BYTES = 9_000_000

export function capToolResultForLLM(content: string): string {
  return capWithMarker(content, TOOL_RESULT_HARD_CAP_BYTES, (originalBytes) =>
    `\n\n[adapter hard cap: ${originalBytes} → ${TOOL_RESULT_HARD_CAP_BYTES} bytes. ` +
    `若触发说明有路径绕过 orchestration 256KB 兜底。]`,
  ).content
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
