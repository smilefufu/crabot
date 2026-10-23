import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { geminiApiHeaders, geminiApiUrl, geminiModelId } from 'crabot-shared'
import type { LLMAdapter, LLMAdapterConfig, LLMStreamParams } from './llm-adapter-types.js'
import { capToolResultForLLM, isToolResultMessage } from './llm-adapter-types.js'
import type { EngineMessage, GeminiProviderState, LLMTokenUsage, StreamChunk, ToolUseBlock } from './types.js'
import { fetchLlm } from './llm-fetch.js'
import { HttpResponseError, StreamProtocolError, parseRetryAfterMs } from './retry-utils.js'
import { withStreamTimeout } from './stream-timeout.js'

type Part = Record<string, unknown>
type Content = { role: 'user' | 'model'; parts: Part[] }
type FunctionCall = { name: string; args?: Record<string, unknown>; id?: string }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function functionCall(part: Part): FunctionCall {
  const call = part.functionCall
  if (!object(call) || typeof call.name !== 'string' || !call.name
    || (call.args !== undefined && !object(call.args))
    || (call.id !== undefined && (typeof call.id !== 'string' || !call.id))) {
    throw new Error('Gemini returned an invalid functionCall')
  }
  return call as FunctionCall
}

function nativeState(message: Extract<EngineMessage, { role: 'assistant' }>): GeminiProviderState | undefined {
  const state = message.providerState
  if (!state) return undefined
  if (state.format !== 'gemini' || state.content?.role !== 'model' || !Array.isArray(state.content.parts) || !Array.isArray(state.toolCalls)) {
    throw new Error('Invalid Gemini provider state in assistant history')
  }
  const parts = state.content.parts
  if (!parts.every(object)) throw new Error('Invalid Gemini history parts')
  const text = parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('')
  const canonicalText = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
  const canonicalCalls = message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use')
  const indices = parts.flatMap((part, index) => part.functionCall !== undefined ? [index] : [])
  if (text !== canonicalText || canonicalCalls.length !== indices.length || state.toolCalls.length !== indices.length) {
    throw new Error('Gemini native history does not match assistant content')
  }
  for (let i = 0; i < indices.length; i++) {
    const call = functionCall(parts[indices[i]])
    const ref = state.toolCalls[i]
    const canonical = canonicalCalls[i]
    if (ref.partIndex !== indices[i] || ref.toolUseId !== canonical.id || call.name !== canonical.name
      || (call.id !== undefined && call.id !== canonical.id) || !isDeepStrictEqual(call.args ?? {}, canonical.input)) {
      throw new Error('Gemini native history does not match tool calls')
    }
  }
  return state
}

/** Project actual history, never execute tools or invent results/signatures. */
export function normalizeMessagesForGemini(messages: ReadonlyArray<EngineMessage>, flattenToolHistory = false): Content[] {
  const result: Content[] = []
  const pending = new Map<string, { name: string; id?: string }>()
  const seen = new Set<string>()
  const push = (role: Content['role'], parts: Part[]): void => {
    if (parts.length === 0) return
    const last = result[result.length - 1]
    if (role === 'user' && last?.role === 'user') last.parts.push(...parts)
    else result.push({ role, parts })
  }
  for (const message of messages) {
    if (isToolResultMessage(message)) {
      if (flattenToolHistory) {
        push('user', message.toolResults.map(tool => ({ text: `[Historical tool result ${tool.tool_use_id}${tool.is_error ? ' error' : ''}] ${capToolResultForLLM(tool.content)}` })))
        continue
      }
      const parts = message.toolResults.map(tool => {
        const call = pending.get(tool.tool_use_id)
        if (!call) throw new Error('Gemini history contains an unmatched tool result')
        pending.delete(tool.tool_use_id)
        return { functionResponse: {
          ...call,
          response: { [tool.is_error ? 'error' : 'result']: capToolResultForLLM(tool.content) },
          ...(tool.images?.length ? { parts: tool.images.map(image => ({ inlineData: { mimeType: image.media_type, data: image.data } })) } : {}),
        } }
      })
      push('user', parts)
    } else if (message.role === 'assistant') {
      if (pending.size) throw new Error('Gemini history is missing tool results')
      if (flattenToolHistory && message.content.some(block => block.type === 'tool_use')) {
        push('model', message.content.flatMap((block): Part[] => block.type === 'text' ? [{ text: block.text }]
          : block.type === 'tool_use' ? [{ text: `[Historical tool call ${block.id}: ${block.name}] ${JSON.stringify(block.input)}` }] : []))
        continue
      }
      const state = nativeState(message)
      const parts: Part[] = state ? [...state.content.parts] : message.content.flatMap((block): Part[] => {
        if (block.type === 'text') return [{ text: block.text }]
        if (block.type === 'tool_use') return [{ functionCall: { name: block.name, args: block.input, id: block.id } }]
        return []
      })
      const refs = state?.toolCalls ?? parts.flatMap((part, partIndex) => part.functionCall ? [{ partIndex, toolUseId: functionCall(part).id! }] : [])
      for (const ref of refs) {
        const call = functionCall(parts[ref.partIndex])
        if (seen.has(ref.toolUseId)) throw new Error('Gemini history contains duplicate tool call IDs')
        seen.add(ref.toolUseId)
        pending.set(ref.toolUseId, { name: call.name, ...(call.id ? { id: call.id } : {}) })
      }
      push('model', parts)
    } else {
      const parts: Part[] = typeof message.content === 'string' ? [{ text: message.content }] : message.content.flatMap((block): Part[] => {
        if (block.type === 'text') return [{ text: block.text }]
        if (block.type === 'image') {
          if (block.source.type !== 'base64') throw new Error('Gemini image input requires admitted base64 bytes')
          return [{ inlineData: { mimeType: block.source.media_type, data: block.source.data } }]
        }
        return []
      })
      push('user', parts)
    }
  }
  if (pending.size) throw new Error('Gemini history is missing tool results')
  return result
}

export function buildGeminiRequest(params: LLMStreamParams): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {}
  if (params.maxTokens !== undefined) generationConfig.maxOutputTokens = params.maxTokens
  if (params.thinking) {
    const value = params.thinking.custom ?? params.thinking.level
    if (typeof value === 'number') throw new Error('Numeric Gemini thinking configuration is not supported')
    if (value !== undefined) {
      const budget = { low: 1024, medium: 8192, high: 24576 }[value as 'low' | 'medium' | 'high']
      if (value === 'off' && params.thinking.custom === undefined) {
        generationConfig.thinkingConfig = { thinkingBudget: 0 }
      } else if (geminiModelId(params.model).startsWith('gemini-2.5-') && budget !== undefined) {
        generationConfig.thinkingConfig = { thinkingBudget: budget }
      } else {
        generationConfig.thinkingConfig = { thinkingLevel: value }
      }
    }
  }
  return {
    systemInstruction: { parts: [{ text: params.systemPrompt }] },
    contents: normalizeMessagesForGemini(params.messages, params.tools.length === 0),
    ...(params.tools.length ? { tools: [{ functionDeclarations: params.tools.map(tool => ({
      name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema,
    })) }] } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  }
}

function usageOf(value: unknown): LLMTokenUsage | undefined {
  if (!object(value)) throw new Error('Invalid Gemini usage metadata')
  const count = (field: string): number => {
    const n = value[field] ?? 0
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error('Invalid Gemini token count')
    return n
  }
  for (const field of ['promptTokenCount', 'candidatesTokenCount', 'cachedContentTokenCount', 'thoughtsTokenCount']) count(field)
  const cached = count('cachedContentTokenCount')
  if (value.promptTokenCount !== undefined && cached > count('promptTokenCount')) throw new Error('Gemini cached tokens exceed prompt tokens')
  if (value.promptTokenCount === undefined || value.candidatesTokenCount === undefined) return undefined
  const input = count('promptTokenCount') - cached
  return { inputTokens: input, outputTokens: count('candidatesTokenCount') + count('thoughtsTokenCount'), ...(value.cachedContentTokenCount !== undefined ? { cacheReadTokens: cached } : {}) }
}

/** Native SSE decoder. Its reader is always cancelled on early return or failure. */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        if (!line) {
          if (data.length) yield data.join('\n')
          data = []
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (done) break
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, '').replace(/\r$/, ''))
    if (data.length) yield data.join('\n')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export class GeminiAdapter implements LLMAdapter {
  constructor(private config: LLMAdapterConfig) {}

  updateConfig(config: Partial<LLMAdapterConfig>): void { this.config = { ...this.config, ...config } }

  async *stream(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
    yield* withStreamTimeout(signal => this.streamOnce({ ...params, signal }), params.signal)
  }

  private async *streamOnce(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
    const config = this.config
    if (!config.apikey) throw new Error('Gemini API key is required')
    const response = await fetchLlm(geminiApiUrl(config.endpoint, params.model), {
      method: 'POST', redirect: 'error', signal: params.signal,
      headers: { ...geminiApiHeaders(config.endpoint, config.apikey), 'Content-Type': 'application/json' },
      body: JSON.stringify(buildGeminiRequest(params)),
    })
    if (!response.ok) {
      const body = (await response.text()).split(config.apikey).join('[REDACTED]').replace(/"thoughtSignature"\s*:\s*"[^"]*"/g, '"thoughtSignature":"[REDACTED]"')
      if ([400, 401, 403, 404, 405, 422].includes(response.status) || /insufficient.*(?:balance|credit)|billing_not_active|balance_exhausted/i.test(body)) {
        throw new Error(`Gemini HTTP ${response.status}: ${body.slice(0, 300)}`)
      }
      throw new HttpResponseError(response.status, body, 'Gemini', parseRetryAfterMs(response.headers.get('retry-after')))
    }
    if (!response.body) throw new StreamProtocolError('Gemini returned no stream body')
    const parts: Part[] = []
    const toolCalls: Array<{ partIndex: number; toolUseId: string }> = []
    const ids = new Set<string>()
    let finish: string | undefined
    let usage: LLMTokenUsage | undefined
    let visible = false
    let started = false
    for await (const data of readEvents(response.body)) {
      if (params.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (data === '[DONE]') continue
      let event: Record<string, unknown>
      try { event = JSON.parse(data) } catch { throw new Error('Gemini returned invalid SSE JSON') }
      if (!object(event)) throw new Error('Gemini returned an invalid stream event')
      if (event.error) throw new Error('Gemini returned an error event')
      if (object(event.promptFeedback) && event.promptFeedback.blockReason) throw new Error('Gemini blocked the request')
      if (!started) { started = true; yield { type: 'message_start', messageId: randomUUID() } }
      yield { type: 'heartbeat' }
      if (event.usageMetadata !== undefined) usage = usageOf(event.usageMetadata) ?? usage
      const candidates = event.candidates
      if (candidates === undefined) continue
      if (!Array.isArray(candidates) || candidates.length > 1) throw new Error('Gemini returned multiple or invalid candidates')
      for (const candidate of candidates) {
        if (!object(candidate) || (candidate.index !== undefined && candidate.index !== 0)) throw new Error('Gemini returned an unexpected candidate')
        if (candidate.content !== undefined) {
          if (!object(candidate.content) || (candidate.content.role !== undefined && candidate.content.role !== 'model') || !Array.isArray(candidate.content.parts)) throw new Error('Gemini returned invalid content')
          for (const part of candidate.content.parts) {
            if (finish) throw new Error('Gemini returned content after its terminal event')
            if (!object(part) || (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== 'string')) throw new Error('Gemini returned an invalid part')
            const partIndex = parts.length
            parts.push(part)
            if (part.functionCall !== undefined) {
              const call = functionCall(part)
              if (!params.tools.some(tool => tool.name === call.name)) throw new Error('Gemini returned an undeclared function')
              const id = call.id ?? randomUUID()
              if (ids.has(id)) throw new Error('Gemini returned duplicate function call IDs')
              ids.add(id)
              toolCalls.push({ partIndex, toolUseId: id })
              yield { type: 'tool_use_start', id, name: call.name }
              yield { type: 'tool_use_delta', id, inputJson: JSON.stringify(call.args ?? {}) }
              yield { type: 'tool_use_end', id }
            } else if (typeof part.text === 'string') {
              if (!part.thought && part.text) { visible = true; yield { type: 'text_delta', text: part.text } }
            } else if (Object.keys(part).some(key => !['thought', 'thoughtSignature', 'partMetadata'].includes(key))) {
              throw new Error('Gemini returned an unsupported output part')
            }
          }
        }
        if (candidate.finishReason !== undefined) {
          if (finish && finish !== candidate.finishReason) throw new Error('Gemini returned conflicting terminal events')
          if (!['STOP', 'MAX_TOKENS'].includes(String(candidate.finishReason))) throw new Error(`Gemini stopped: ${String(candidate.finishReason).split(config.apikey).join('[REDACTED]').slice(0, 80)}`)
          finish = String(candidate.finishReason)
        }
      }
    }
    if (!finish) throw new StreamProtocolError('Gemini stream ended without finishReason')
    if (finish === 'STOP' && !visible && toolCalls.length === 0) throw new Error('Gemini returned an empty response')
    yield { type: 'provider_state', state: { format: 'gemini', content: { role: 'model', parts }, toolCalls } }
    yield { type: 'message_end', stopReason: finish === 'MAX_TOKENS' ? 'max_tokens' : toolCalls.length ? 'tool_use' : 'end_turn', ...(usage ? { usage } : {}) }
  }
}
