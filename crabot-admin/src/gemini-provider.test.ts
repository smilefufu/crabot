import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelProviderManager } from './model-provider-manager.js'
import { fetchGeminiModels, probeGeminiChat } from './gemini-provider.js'
import type { ModelProvider } from './types.js'

const model = { model_id: 'gemini-test', display_name: 'Test', type: 'llm' as const, context_window: 128000, max_tokens: 1000, supports_vision: true }
const provider: ModelProvider = { id: 'test', name: 'Gemini', type: 'manual', format: 'gemini', endpoint: 'https://gateway.example/prefix', api_key: 'secret-key', models: [model], status: 'inactive', created_at: '', updated_at: '' }
const page = (models: unknown[], nextPageToken?: unknown) => new Response(JSON.stringify({ models, ...(nextPageToken !== undefined ? { nextPageToken } : {}) }))
const entry = (id: string, extra = {}) => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent', 'streamGenerateContent'], ...extra })
let dir: string
let manager: ModelProviderManager
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'gemini-provider-')); manager = new ModelProviderManager(dir); await manager.initialize() })
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }) })

describe('Gemini native catalog', () => {
  it('reads all pages on the original host and excludes unsupported dedicated models', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(page([entry('gemini-test', { displayName: 'Native name', inputTokenLimit: 1048576, outputTokenLimit: 99999 }), entry('text-embedding', { supportedGenerationMethods: ['embedContent'] }), entry('gemini-image')], 'next/token'))
      .mockResolvedValueOnce(page([entry('gemini-other')]))
    const models = await fetchGeminiModels(provider, provider.api_key)
    expect(models.map(model => model.model_id)).toEqual(['gemini-test', 'gemini-other'])
    expect(models[0]).toMatchObject({ display_name: 'Native name', context_window: 1048576 })
    expect(models[0]).not.toHaveProperty('max_tokens')
    expect(models[0]).not.toHaveProperty('supports_vision')
    expect(fetchMock.mock.calls[1][0]).toBe('https://gateway.example/prefix/v1beta/models?pageToken=next%2Ftoken')
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(fetchMock.mock.calls[1][1]?.signal)
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('error')
  })
  it('allows manual Gemini refresh while preserving per-model overrides and global defaults', async () => {
    const saved = await manager.createProvider(provider)
    const before = manager.getGlobalConfig()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(page([entry('gemini-test', { inputTokenLimit: 999999 }), entry('gemini-new')]))
    const result = await manager.refreshModels(saved.id)
    expect(result.added).toEqual(['gemini-new'])
    expect(result.models[0]).toMatchObject({ context_window: 128000, max_tokens: 1000, supports_vision: true })
    expect(manager.getGlobalConfig()).toEqual(before)
    const restarted = new ModelProviderManager(dir)
    await restarted.initialize()
    expect(restarted.getProvider(saved.id)?.models).toEqual(result.models)
  })
  it.each(['empty', 'invalid', 'repeat', 'second page failure'])('retains the old catalog and disk data on %s', async kind => {
    const saved = await manager.createProvider(provider)
    const before = await readFile(join(dir, 'model_providers.json'), 'utf8')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    if (kind === 'empty') fetchMock.mockResolvedValue(page([]))
    if (kind === 'invalid') fetchMock.mockResolvedValue(new Response('{"data":[]}'))
    if (kind === 'repeat') fetchMock.mockResolvedValue(page([entry('gemini-test')], 'same'))
    if (kind === 'second page failure') fetchMock.mockResolvedValueOnce(page([entry('gemini-new')], 'next')).mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    await expect(manager.refreshModels(saved.id)).rejects.toThrow()
    expect(manager.getProvider(saved.id)?.models).toEqual(provider.models)
    expect(await readFile(join(dir, 'model_providers.json'), 'utf8')).toBe(before)
  })
})

describe('Gemini native TTFT probe', () => {
  it('waits through metadata/thoughts for visible output and cancels its reader', async () => {
    let cancelled = false
    const events = [{ usageMetadata: { promptTokenCount: 10 } }, { candidates: [{ content: { parts: [{ thought: true, text: 'private' }] } }] }, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }]
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(events.map(event => `data:${JSON.stringify(event)}\r\n\r\n`).join(''))) }, cancel() { cancelled = true } })))
    expect(await probeGeminiChat(provider, model, provider.api_key)).toMatchObject({ success: true })
    expect(cancelled).toBe(true)
  })
  it.each([{ error: { code: 400 } }, { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }, { candidates: [{ finishReason: 'SAFETY' }] }])('does not treat HTTP 200 error/empty/blocked SSE as success %#', async event => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify(event)}\n\n`))
    expect(await probeGeminiChat(provider, model, provider.api_key)).toMatchObject({ success: false })
  })
  it('redacts an echoed key before truncating the error body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(996) + provider.api_key, { status: 401 }))
    const result = await probeGeminiChat(provider, model, provider.api_key)
    expect(result.error).not.toContain('secr')
  })
  it('uses a bounded cancellation signal and returns an external abort as failure', async () => {
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      controller.abort()
      options?.signal?.throwIfAborted()
      throw new Error('should abort')
    })
    expect(await probeGeminiChat(provider, model, provider.api_key)).toMatchObject({ success: false })
    expect(timeout).toHaveBeenCalledWith(30000)
  })
})
