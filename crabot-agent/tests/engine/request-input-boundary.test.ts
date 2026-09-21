import { afterEach, expect, it, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
import { callNonStreaming, type LLMAdapter, type LLMStreamParams } from '../../src/engine/llm-adapter-types.js'
import { chunksFromContent } from './helpers/mock-stream.js'
import { defineTool } from '../../src/engine/tool-framework.js'
import { createUserMessage, createAssistantMessage, type LLMRequestEvent } from '../../src/engine/types.js'

afterEach(() => vi.useRealTimers())

it('admits queued priority/FIFO input before an internal retry, without another successful turn', async () => {
  vi.useFakeTimers()
  const normal: string[] = []
  const priority: string[] = []
  const requests: string[] = []
  const injections: string[] = []
  const adapter: LLMAdapter = {
    async *stream(params) {
      requests.push(JSON.stringify(params.messages))
      if (requests.length === 1) {
        normal.push('normal-one', 'normal-two')
        priority.push('priority-three')
        throw Object.assign(new Error('upstream failed'), { status: 502 })
      }
      yield* chunksFromContent([{ type: 'text', text: 'done' }], 'end_turn')
    },
    updateConfig() {},
  }
  const running = runEngine({ prompt: 'task', adapter, options: {
    model: 'test', tools: [], systemPrompt: '', maxTurns: 1,
    drainExternalInputs: () => [...priority.splice(0), ...normal.splice(0)],
    onSystemInjection: (event) => { if (event.type === 'external_input') injections.push(event.text) },
  } })
  await vi.runAllTimersAsync()
  expect((await running).outcome).toBe('completed')
  expect(requests).toHaveLength(2)
  expect(requests[0]).not.toContain('normal-one')
  expect(requests[1]).toContain('normal-one')
  expect(injections).toEqual(['priority-three', 'normal-one', 'normal-two'])
  expect(requests[1].indexOf('priority-three')).toBeLessThan(requests[1].indexOf('normal-one'))
})

it('request preparation failure does not send or retry a provider request', async () => {
  const stream = vi.fn(async function* () { yield* chunksFromContent([{ type: 'text', text: 'done' }], 'end_turn') })
  const onRequestLifecycle = vi.fn()
  await expect(callNonStreaming({ stream, updateConfig() {} }, {
    messages: [], tools: [], model: 'test', systemPrompt: '',
    beforeAttempt: () => { throw new Error('input preparation failed') }, onRequestLifecycle,
  } as LLMStreamParams)).rejects.toThrow('input preparation failed')
  expect(stream).not.toHaveBeenCalled()
  expect(onRequestLifecycle).not.toHaveBeenCalled()
})

it('admits input on the last allowed attempt and preserves failures when no request succeeds', async () => {
  vi.useFakeTimers()
  const pending: string[] = []
  const requests: string[] = []
  const events: LLMRequestEvent[] = []
  const adapter: LLMAdapter = { updateConfig() {}, async *stream(params) {
    requests.push(JSON.stringify(params.messages))
    if (requests.length === 5) pending.push('LAST-ATTEMPT-INPUT')
    throw Object.assign(new Error('HTTP 502 upstream_http2_stream_error'), { status: 502 })
  } }
  const running = runEngine({ prompt: 'task', adapter, options: {
    model: 'test', tools: [], systemPrompt: '', drainExternalInputs: () => pending.splice(0),
    onRequestLifecycle: event => events.push(event),
  } })
  await vi.runAllTimersAsync()
  const result = await running
  expect(result).toMatchObject({ outcome: 'failed', totalTurns: 0, error: expect.stringContaining('upstream_http2_stream_error') })
  expect(requests).toHaveLength(6)
  expect(requests[4]).not.toContain('LAST-ATTEMPT-INPUT')
  expect(requests[5]).toContain('LAST-ATTEMPT-INPUT')
  expect(events.filter(event => event.status === 'failed' && !event.phase)).toHaveLength(6)
  expect(events.filter(event => event.status === 'completed')).toHaveLength(0)
  expect(events.at(-1)).toMatchObject({ status: 'failed', attempt: 6, error: 'HTTP 502 upstream_http2_stream_error' })
})

it('does not replay a completed tool when the following model request retries', async () => {
  vi.useFakeTimers()
  const call = vi.fn(async () => ({ output: 'saved', isError: false }))
  const pending: string[] = []
  const requests: LLMStreamParams[] = []
  const adapter: LLMAdapter = { updateConfig() {}, async *stream(params) {
    requests.push(params)
    if (requests.length === 1) {
      yield* chunksFromContent([{ type: 'tool_use', id: 'tool-1', name: 'save', input: {} }], 'tool_use')
    } else if (requests.length === 2) {
      pending.push('new instruction')
      throw Object.assign(new Error('502'), { status: 502 })
    } else yield* chunksFromContent([{ type: 'text', text: 'done' }], 'end_turn')
  } }
  const running = runEngine({ prompt: 'task', adapter, options: { model: 'test', systemPrompt: '',
    tools: [defineTool({ name: 'save', description: 'save', inputSchema: {}, isReadOnly: true, call })],
    drainExternalInputs: () => pending.splice(0),
  } })
  await vi.runAllTimersAsync()
  expect((await running).outcome).toBe('completed')
  expect(call).toHaveBeenCalledOnce()
  expect(JSON.stringify(requests[1].messages)).not.toContain('new instruction')
  expect(JSON.stringify(requests[2].messages)).toContain('new instruction')
  expect(requests[2].messages.filter(message => 'toolResults' in message)).toHaveLength(1)
})

it('protects newly admitted text while compacting and admits arrivals during compaction', async () => {
  const initialMessages = [createUserMessage('task'), ...Array.from({ length: 20 }, (_, i) => createAssistantMessage([{ type: 'text', text: `old-${i} ${'x'.repeat(300)}` }], 'end_turn'))]
  const firstInput = `KEEP-ORIGINAL ${'new '.repeat(200)}`
  const pending = [firstInput]
  const purposes: string[] = []
  const requests: LLMStreamParams[] = []
  let summaries = 0
  const adapter: LLMAdapter = { updateConfig() {}, async *stream(params) {
    // Main request uses the literal system prompt; compaction uses its own profile.
    if (params.systemPrompt !== 'MAIN') {
      summaries++
      pending.push('ARRIVED-DURING-COMPACTION')
      expect(JSON.stringify(params.messages)).not.toContain('KEEP-ORIGINAL')
      yield* chunksFromContent([{ type: 'text', text: 'old work summary' }], 'end_turn')
    } else {
      requests.push(params)
      yield* chunksFromContent([{ type: 'text', text: 'done' }], 'end_turn')
    }
  } }
  const result = await runEngine({ prompt: '', initialMessages, adapter, options: {
    model: 'test', tools: [], systemPrompt: 'MAIN', contextWindowTokens: 2200,
    drainExternalInputs: () => pending.splice(0), onRequestLifecycle: (_event, purpose) => purposes.push(purpose),
  } })
  expect(result.outcome).toBe('completed')
  expect(summaries).toBeGreaterThan(0)
  expect(JSON.stringify(requests[0].messages)).toContain(firstInput)
  expect(JSON.stringify(requests[0].messages)).toContain('ARRIVED-DURING-COMPACTION')
  expect(purposes).toContain('compaction')
  expect(purposes).toContain('inference')
})

it('observes start before first data, keeps observation across config swap and records abort', async () => {
  vi.useFakeTimers()
  const events: LLMRequestEvent[] = []
  let generation = 0
  const controller = new AbortController()
  const next: LLMAdapter = { updateConfig() {}, async *stream(params) {
    expect(events.at(-1)).toMatchObject({ status: 'running', model: 'new-model', attempt: 2 })
    yield { type: 'message_start', messageId: 'm' }
    controller.abort()
    yield { type: 'text_delta', text: 'discarded' }
  } }
  const initial: LLMAdapter = { updateConfig() {}, async *stream() {
    generation++
    throw Object.assign(new Error('502'), { status: 502 })
  } }
  await expect(callNonStreaming(initial, { messages: [], systemPrompt: '', tools: [], model: 'old',
    signal: controller.signal, configGeneration: () => generation, onConfigChanged: async () => ({ adapter: next, model: 'new-model' }),
    onRequestLifecycle: event => events.push(event),
  })).rejects.toThrow()
  expect(events.filter(event => event.phase === 'first_response')).toHaveLength(1)
  expect(events.at(-1)).toMatchObject({ failureKind: 'aborted', status: 'failed', attempt: 2 })
  expect(new Set(events.map(event => event.callId)).size).toBe(1)
  expect(new Set(events.map(event => event.requestId)).size).toBe(2)
})
