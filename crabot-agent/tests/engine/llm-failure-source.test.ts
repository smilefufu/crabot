import { describe, expect, it } from 'vitest'
import { HttpResponseError } from '../../src/engine/retry-utils.js'
import { runEngine } from '../../src/engine/query-loop.js'
import type { EngineOptions } from '../../src/engine/types.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter.js'
import { chunksFromContent } from './helpers/mock-stream.js'

const options: EngineOptions = { model: 'fixture', systemPrompt: '', tools: [], disableCompaction: true }
const successful: LLMAdapter = { updateConfig() {}, async *stream() { yield* chunksFromContent([{ type: 'text', text: 'ok' }], 'end_turn') } }

describe('LLM failure provenance', () => {
  it('marks actual adapter failures, including error chunks', async () => {
    for (const chunk of [false, true]) {
      const adapter: LLMAdapter = { updateConfig() {}, async *stream() {
        if (chunk) yield { type: 'error', error: 'provider denied request' }
        else throw new Error('provider denied request')
      } }
      const result = await runEngine({ prompt: 'test', adapter, options })
      expect(result.outcome).toBe('failed')
      expect(result).toHaveProperty('llmFailure', true)
    }
  })

  it('does not mark request preparation or local text-consumer failures as LLM failures', async () => {
    for (const overrides of [
      { drainExternalInputs: () => { throw new Error('ENOENT: local input') } },
      { createTextConsumer: () => ({ externallyCommitted: false,
        async write() { throw new Error('ENOENT: local output') }, async finish() {}, async abort() {} }) },
    ]) {
      const result = await runEngine({ prompt: 'test', adapter: successful, options: { ...options, ...overrides } })
      expect(result.outcome).toBe('failed')
      expect(result).not.toHaveProperty('llmFailure')
    }
  })

  it('keeps provenance when a Provider failure is wrapped after retry give-up', async () => {
    const adapter: LLMAdapter = { updateConfig() {}, async *stream() {
      throw new HttpResponseError(429, 'rate limited', 'fixture', 600_000)
    } }
    const result = await runEngine({ prompt: 'test', adapter, options })
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('次尝试')
    expect(result).toHaveProperty('llmFailure', true)
  })

  it('does not inherit the previous Provider failure when config refresh itself fails', async () => {
    let generation = 0
    const adapter: LLMAdapter = { updateConfig() {}, async *stream() {
      generation++
      throw new HttpResponseError(429, 'rate limited', 'fixture', 600_000)
    } }
    const result = await runEngine({ prompt: 'test', adapter, options: { ...options,
      configGeneration: () => generation,
      onConfigChanged: async () => { throw new Error('ENOENT: configuration file') },
    } })
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('configuration file')
    expect(result).not.toHaveProperty('llmFailure')
  })

  it('does not mark cancellation as an LLM failure', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runEngine({ prompt: 'test', adapter: successful, options: { ...options, abortSignal: controller.signal } })
    expect(result.outcome).toBe('aborted')
    expect(result).not.toHaveProperty('llmFailure')
  })
})
