import { geminiApiHeaders, geminiApiUrl, geminiModelId } from 'crabot-shared'
import type { ModelInfo, ModelProvider } from './types.js'

export const GEMINI_OPERATION_TIMEOUT_MS = 30_000

function safeError(error: unknown, key: string): string {
  const text = error instanceof Error ? error.message : String(error)
  return (key ? text.split(key).join('[REDACTED]') : text).replace(/"thoughtSignature"\s*:\s*"[^"]*"/g, '"thoughtSignature":"[REDACTED]"')
}

async function checked(response: Response, key: string): Promise<Response> {
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${safeError(await response.text(), key).slice(0, 1000)}`)
  return response
}

/** Read a complete native catalog; caller only replaces storage after full success. */
export async function fetchGeminiModels(provider: Pick<ModelProvider, 'endpoint'>, key: string, signal = AbortSignal.timeout(GEMINI_OPERATION_TIMEOUT_MS)): Promise<ModelInfo[]> {
  const models = new Map<string, ModelInfo>()
  const tokens = new Set<string>()
  let token: string | undefined
  try {
    do {
      const url = new URL(geminiApiUrl(provider.endpoint))
      if (token) url.searchParams.set('pageToken', token)
      const response = await checked(await fetch(url.toString(), { headers: geminiApiHeaders(provider.endpoint, key), redirect: 'error', signal }), key)
      const data = await response.json() as { models?: Array<Record<string, unknown>>; nextPageToken?: unknown }
      if (!data || !Array.isArray(data.models)) throw new Error('Invalid native Gemini model catalog')
      for (const item of data.models) {
        if (!item || typeof item.name !== 'string') throw new Error('Invalid native Gemini model entry')
        const id = geminiModelId(item.name)
        if (Array.isArray(item.supportedGenerationMethods)
          && !item.supportedGenerationMethods.some(method => method === 'generateContent' || method === 'streamGenerateContent')) continue
        if (/(?:image|audio|tts|embedding|embed-content)/i.test(id)) continue
        models.set(id, {
          model_id: id, display_name: typeof item.displayName === 'string' ? item.displayName : id, type: 'llm',
          ...(typeof item.description === 'string' ? { description: item.description } : {}),
          ...(typeof item.inputTokenLimit === 'number' && Number.isSafeInteger(item.inputTokenLimit) && item.inputTokenLimit > 0
            ? { context_window: item.inputTokenLimit } : {}),
        })
      }
      if (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string') throw new Error('Invalid Gemini page token')
      token = data.nextPageToken as string | undefined
      if (token) {
        if (tokens.has(token)) throw new Error('Repeated Gemini page token')
        tokens.add(token)
      }
    } while (token)
    if (models.size === 0) throw new Error('Gemini returned an empty chat model catalog')
    return [...models.values()]
  } catch (error) { throw new Error(safeError(error, key)) }
}

type ProbeResult = { success: boolean; latency_ms: number; error?: string }

export async function probeGeminiEndpoint(provider: ModelProvider, key: string, signal?: AbortSignal): Promise<ProbeResult> {
  const start = Date.now()
  try {
    await fetchGeminiModels(provider, key, signal)
    return { success: true, latency_ms: Date.now() - start }
  } catch (error) { return { success: false, latency_ms: Date.now() - start, error: safeError(error, key) } }
}

export function buildGeminiProbe(model: ModelInfo): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: 'You are a connectivity probe. Reply with the single word ok.' }] },
    contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
    tools: [{ functionDeclarations: [{ name: 'noop', description: 'Connectivity probe tool — do not call.', parametersJsonSchema: { type: 'object', properties: {} } }] }],
    ...(model.max_tokens !== undefined ? { generationConfig: { maxOutputTokens: model.max_tokens } } : {}),
  }
}

/** Native TTFT preflight, deliberately separate from Agent connection recovery. */
export async function probeGeminiChat(provider: ModelProvider, model: ModelInfo, key: string, signal = AbortSignal.timeout(GEMINI_OPERATION_TIMEOUT_MS)): Promise<ProbeResult> {
  const start = Date.now()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await checked(await fetch(geminiApiUrl(provider.endpoint, model.model_id), {
      method: 'POST', redirect: 'error', signal,
      headers: { ...geminiApiHeaders(provider.endpoint, key), 'Content-Type': 'application/json' },
      body: JSON.stringify(buildGeminiProbe(model)),
    }), key)
    if (!response.body) throw new Error('Gemini returned no response body')
    reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let data: string[] = []
    const inspect = (): boolean => {
      if (!data.length) return false
      const text = data.join('\n')
      data = []
      if (text === '[DONE]') return false
      const event = JSON.parse(text) as { error?: unknown; promptFeedback?: { blockReason?: string }; candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> }; finishReason?: string }> }
      if (!event || event.error || event.promptFeedback?.blockReason) throw new Error('Gemini returned an error or blocked the probe')
      if (event.candidates !== undefined && (!Array.isArray(event.candidates) || event.candidates.length > 1)) throw new Error('Invalid Gemini probe candidates')
      for (const candidate of event.candidates ?? []) {
        if (candidate.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) throw new Error(`Gemini stopped: ${candidate.finishReason}`)
        for (const part of candidate.content?.parts ?? []) {
          if (!part.thought && typeof part.text === 'string' && part.text.length > 0) return true
          const call = part.functionCall as { name?: unknown; args?: unknown } | undefined
          if (call && typeof call.name === 'string' && call.name && (call.args === undefined || (call.args !== null && typeof call.args === 'object' && !Array.isArray(call.args)))) return true
        }
      }
      return false
    }
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        if (!line) {
          if (inspect()) return { success: true, latency_ms: Date.now() - start }
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (done) {
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, '').replace(/\r$/, ''))
        if (inspect()) return { success: true, latency_ms: Date.now() - start }
        throw new Error('Gemini stream ended without usable output')
      }
    }
  } catch (error) {
    return { success: false, latency_ms: Date.now() - start, error: safeError(error, key) }
  } finally {
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
}
