import { describe, expect, it, vi } from 'vitest'
import { callNonStreaming, type LLMAdapter, type LLMStreamParams } from '../../src/engine/llm-adapter-types.js'
import type { LLMRequestEvent } from '../../src/engine/types.js'
import { chunksFromContent } from './helpers/mock-stream.js'

const params: LLMStreamParams = { model: 'model-a', messages: [], systemPrompt: 'private prompt', tools: [] }
const usage = { inputTokens: 20, outputTokens: 4, cacheReadTokens: 0 }

function adapter(events: LLMRequestEvent[], providerId = 'provider-a'): LLMAdapter {
  return {
    traceIdentity: { providerId, format: 'openai' },
    onRequestLifecycle: event => events.push(event),
    async *stream() { yield* chunksFromContent([], 'end_turn', usage) },
    updateConfig() {},
  }
}

describe('buffered request observation', () => {
  it('records one safe start/finish pair and links the successful response', async () => {
    const events: LLMRequestEvent[] = []
    const result = await callNonStreaming(adapter(events), params)
    expect(events.map(event => event.status)).toEqual(['running', 'completed'])
    expect(events[0]).toMatchObject({ providerId: 'provider-a', model: 'model-a', format: 'openai', attempt: 1 })
    expect(events[1]).toMatchObject({ requestId: events[0].requestId, usage, chunkCount: expect.any(Number) })
    expect(result.diagnostics?.request).toEqual(events[1])
    expect(JSON.stringify(events)).not.toMatch(/private prompt|systemPrompt|messages|endpoint|apikey/)
  })

  it('counts real attempts across an immediate config swap without attributing old cost to the new provider', async () => {
    const events: LLMRequestEvent[] = []
    const first = adapter(events)
    let generation = 0
    first.stream = async function* () {
      generation++
      throw Object.assign(new Error('temporary private error'), { status: 503 })
    }
    const result = await callNonStreaming(first, {
      ...params, configGeneration: () => generation,
      onConfigChanged: async () => ({ adapter: adapter(events, 'provider-b'), model: 'model-b' }),
    })
    expect(events.map(event => event.status)).toEqual(['running', 'failed', 'running', 'completed'])
    expect(events[1]).not.toHaveProperty('usage')
    expect(events[1]).toMatchObject({ providerId: 'provider-a', model: 'model-a', attempt: 1 })
    expect(events[3]).toMatchObject({ providerId: 'provider-b', model: 'model-b', attempt: 2 })
    expect(new Set(events.map(event => event.callId)).size).toBe(1)
    expect(events[0].requestId).not.toBe(events[2].requestId)
    expect(result.diagnostics?.request).toEqual(events[3])
    expect(JSON.stringify(events)).not.toContain('private error')
  })

  it('keeps failed and missing usage unknown, including cancellation', async () => {
    for (const abort of [false, true]) {
      const events: LLMRequestEvent[] = []
      const observed = adapter(events)
      const controller = new AbortController()
      observed.stream = async function* () {
        if (abort) controller.abort()
        throw new Error('terminal failure')
      }
      await expect(callNonStreaming(observed, { ...params, signal: controller.signal })).rejects.toThrow('terminal failure')
      expect(events[1]).toMatchObject({ status: 'failed', failureKind: abort ? 'aborted' : 'request_failed' })
      expect(events[1]).not.toHaveProperty('usage')
    }
    const events: LLMRequestEvent[] = []
    const observed = adapter(events)
    observed.stream = async function* () { yield* chunksFromContent([], 'end_turn') }
    await callNonStreaming(observed, params)
    expect(events[1]).not.toHaveProperty('usage')
  })

  it('observer failures cannot alter responses or retry a request', async () => {
    const observed = adapter([])
    const stream = vi.fn(observed.stream)
    observed.stream = stream
    observed.onRequestLifecycle = () => { throw new Error('observer unavailable') }
    const result = await callNonStreaming(observed, params)
    expect(result.usage).toEqual(usage)
    expect(stream).toHaveBeenCalledOnce()
  })

  it('does not add request metadata for unobserved callers', async () => {
    const observed = adapter([])
    delete observed.onRequestLifecycle
    expect((await callNonStreaming(observed, params)).diagnostics).not.toHaveProperty('request')
  })
})
