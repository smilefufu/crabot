import { afterEach, describe, expect, it, vi } from 'vitest'
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici'
import { fetchLlm } from '../../src/engine/llm-fetch'
import { OpenAIAdapter } from '../../src/engine/openai-adapter'
import { OpenAIResponsesAdapter } from '../../src/engine/openai-responses-adapter'

const originalDispatcher = getGlobalDispatcher()

// Exercise native fetch dispatch without opening a socket or sending credentials.
function installTransport() {
  const dispatch = vi.fn((options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) => {
    handler.onError!(new Error('offline transport probe'))
    return false
  })
  setGlobalDispatcher({ dispatch } as unknown as Dispatcher)
  return dispatch
}

afterEach(() => setGlobalDispatcher(originalDispatcher))

describe('LLM response-header budget', () => {
  it('overrides the native 5-minute deadline and follows current global routing', async () => {
    const first = installTransport()
    await expect(fetchLlm('https://example.invalid/first', {})).rejects.toThrow()
    expect(first).toHaveBeenCalledTimes(1)
    expect(first.mock.calls[0][0]).toMatchObject({ headersTimeout: 600_000, bodyTimeout: 600_000 })

    const replacement = installTransport()
    await expect(fetchLlm('https://example.invalid/second', {})).rejects.toThrow()
    expect(first).toHaveBeenCalledTimes(1)
    expect(replacement).toHaveBeenCalledTimes(1)
    expect(replacement.mock.calls[0][0].headersTimeout).toBe(600_000)
  })

  it.each([OpenAIAdapter, OpenAIResponsesAdapter])('%s uses the same budget at the real fetch boundary', async (Adapter) => {
    const dispatch = installTransport()
    const adapter = new Adapter({ endpoint: 'https://example.invalid', apikey: 'offline-test' })
    const stream = adapter.stream({ model: 'test', systemPrompt: '', messages: [], tools: [] })
    await expect(stream.next()).rejects.toThrow()
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0].headersTimeout).toBe(600_000)
  })
})
