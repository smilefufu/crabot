import Anthropic from '@anthropic-ai/sdk'
import { SessionTree } from '../../src/workers/session-tree'
import { resumeManagerMessages } from '../../src/manager/resume-checkpoint'
import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AnthropicAdapter, normalizeMessagesForAnthropic } from '../../src/engine/anthropic-adapter'
import { normalizeMessagesForResponses } from '../../src/engine/openai-responses-adapter'
import { normalizeMessagesForOpenAI } from '../../src/engine/openai-adapter'
import { runEngine } from '../../src/engine/query-loop'
import { callNonStreaming } from '../../src/engine/llm-adapter'
import { ContextManager } from '../../src/engine/context-manager'
import { ManagerSessionStore } from '../../src/manager/session-store'
import { createAssistantMessage, createUserMessage, type ToolCallContext } from '../../src/engine/types'

const native = [
  { type: 'thinking', thinking: ' plan\n', signature: 'signed-value' },
  { type: 'text', text: 'checking' },
  { type: 'redacted_thinking', data: 'opaque' },
  { type: 'tool_use', id: 'send-1', name: 'send_message', input: { content: 'done' } },
  { type: 'thinking', thinking: '', signature: 'empty-signature' },
  { type: 'text', text: 'after tool' },
]
function fakeStream(blocks: any[], stop = 'tool_use', fail = false) {
  return {
    abort: vi.fn(),
    finalMessage: async () => ({ stop_reason: stop, usage: { input_tokens: 10, output_tokens: 10 } }),
    [Symbol.asyncIterator]: async function* () {
      yield { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'k3', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }
      for (const [index, block] of blocks.entries()) {
        const start = { ...block }
        const deltas: any[] = []
        if (block.type === 'thinking') {
          start.thinking = ''; start.signature = ''
          deltas.push({ type: 'thinking_delta', thinking: block.thinking.slice(0, 2) }, { type: 'thinking_delta', thinking: block.thinking.slice(2) })
          deltas.push({ type: 'signature_delta', signature: block.signature.slice(0, 3) }, { type: 'signature_delta', signature: block.signature.slice(3) })
        }
        if (block.type === 'text') { start.text = ''; deltas.push({ type: 'text_delta', text: block.text }) }
        if (block.type === 'tool_use') { start.input = {}; deltas.push({ type: 'input_json_delta', partial_json: JSON.stringify(block.input) }) }
        yield { type: 'content_block_start', index, content_block: start }
        for (const delta of deltas) yield { type: 'content_block_delta', index, delta }
        yield { type: 'content_block_stop', index }
      }
      if (fail) throw new Error('synthetic failure')
      yield { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 10 } }
      yield { type: 'message_stop' }
    },
  }
}
function adapterWith(...streams: ReturnType<typeof fakeStream>[]) {
  const adapter = new AnthropicAdapter({ endpoint: 'https://example.test', apikey: 'test' })
  const request = vi.spyOn((adapter as any).client.messages, 'stream')
  for (const stream of streams) request.mockReturnValueOnce(stream as any)
  return { adapter, request }
}
const tool = { name: 'send_message', description: 'test', inputSchema: { type: 'object' }, isReadOnly: true, call: vi.fn(async (_input: Record<string, unknown>, _context: ToolCallContext) => ({ output: '{"sent":true}', isError: false })) }
const options = { model: 'k3', systemPrompt: 'test', tools: [tool], maxTurns: 2, suppressForcedSummary: () => true }

describe('Anthropic thinking round trip', () => {
  it('retains reasoning through the installed SDK raw event iterator', async () => {
    const events: any[] = []
    for await (const event of fakeStream(native)) events.push(event)
    const wire = events.map(event => `event:${event.type}\ndata:${JSON.stringify(event)}\n\n`).join('')
    const adapter = new AnthropicAdapter({ endpoint: 'https://example.test', apikey: 'test' })
    ;(adapter as any).client = new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }) })
    const response = await callNonStreaming(adapter, { ...options, messages: [createUserMessage('test')] })
    expect(normalizeMessagesForAnthropic([createAssistantMessage([...response.content], 'tool_use')])[0].content).toEqual(native)
  })

  it('preserves the whole reasoning/tool tail when older history is compressed', async () => {
    const first = adapterWith(fakeStream(native))
    const response = await callNonStreaming(first.adapter, { ...options, messages: [createUserMessage('test')] })
    const assistant = createAssistantMessage([...response.content], 'tool_use')
    const tail = [assistant, { id: 'result', role: 'user' as const, timestamp: 1, toolResults: [{ tool_use_id: 'send-1', content: 'sent', is_error: false }] }]
    const context = new ContextManager({ maxContextTokens: 10000, keepRecentMessages: 2 })
    const summary = adapterWith(fakeStream([{ type: 'text', text: 'summary' }], 'end_turn'))
    const compacted = await context.compactWithLLM([createUserMessage('start'), createAssistantMessage([{ type: 'text', text: 'old '.repeat(2000) }], 'end_turn'), createUserMessage('more'), ...tail], summary.adapter, 'k3')
    expect(compacted.slice(-2)).toEqual(tail)
    expect(normalizeMessagesForAnthropic(compacted.slice(-2))[0].content).toEqual(native)
  })

  it('preserves complete native order through Engine, disk and the next request', async () => {
    tool.call.mockClear()
    const { adapter, request } = adapterWith(fakeStream(native), fakeStream([], 'end_turn'))
    const result = await runEngine({ prompt: 'test', adapter, options })
    expect(result.outcome).toBe('completed')
    expect(tool.call).toHaveBeenCalledTimes(1)
    expect(tool.call.mock.calls[0][0]).toEqual(native[3].input)
    const sent = (request.mock.calls[1][0] as any).messages.find((m: any) => m.role === 'assistant')
    expect(sent.content).toEqual(native)
    const dir = await mkdtemp(join(tmpdir(), 'thinking-roundtrip-'))
    try {
      const store = new ManagerSessionStore(dir)
      const key = 'test::roundtrip'
      await store.save({ key, recent: [...result.finalMessages], foldedCount: 0 })
      const loaded = await new ManagerSessionStore(dir).load(key)
      expect(loaded.recent).toEqual(result.finalMessages)
      store.saveCheckpoint({
        episodeId: 'episode', state: loaded, envelopes: [], wakeIndex: -1, pending: [],
        hasEngineMessages: true, turns: [], responses: [], tools: [], pendingToolCallIds: [],
        adminChatClaims: [], transientMessageIds: [], spawnedWorkerIds: [],
        execution: { needsSpawnRecheck: false, spawnRecheckInjected: false, spawnRecheckOutcomeRecorded: false, postSendRecheckSequence: 0, successfulSendMessageTargets: ['test::roundtrip'], continuedWorkers: [] },
      })
      const checkpoint = await new ManagerSessionStore(dir).loadCheckpoint(key)
      expect(resumeManagerMessages(checkpoint!)).toEqual(result.finalMessages)
      const treeFile = join(dir, 'builtin-session.jsonl')
      const tree = new SessionTree(treeFile)
      let tip: string | null = null
      for (const message of result.finalMessages) tip = await tree.append(tip, message)
      expect((await SessionTree.load(treeFile)).pathTo(tip!)).toEqual(result.finalMessages)
      const restored = normalizeMessagesForAnthropic(loaded.recent).find(m => m.role === 'assistant')
      expect(restored?.content).toEqual(native)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('does not send Anthropic reasoning to other formats or expose it as text', async () => {
    const { adapter } = adapterWith(fakeStream(native))
    const response = await callNonStreaming(adapter, { ...options, messages: [createUserMessage('test')] })
    const message = createAssistantMessage([...response.content], 'tool_use')
    expect(message.content.filter(b => b.type === 'raw_reasoning')).toHaveLength(3)
    expect(JSON.stringify(normalizeMessagesForResponses([message]))).not.toContain('signed-value')
    expect(JSON.stringify(normalizeMessagesForOpenAI([message]))).not.toContain('signed-value')
    expect(message.content.filter(b => b.type === 'text').map(b => b.text)).toEqual(['checking', 'after tool'])
  })

  it('counts thinking and signature in capacity estimates', () => {
    const context = new ContextManager({ maxContextTokens: 200000 })
    const plain = createAssistantMessage([{ type: 'text', text: 'ok' }], 'end_turn')
    const withThinking = createAssistantMessage([{ type: 'raw_reasoning', data: { type: 'thinking', thinking: 'x'.repeat(1000), signature: 's'.repeat(1000) } }, ...plain.content], 'end_turn')
    expect(context.estimateMessageTokens(withThinking)).toBeGreaterThan(context.estimateMessageTokens(plain) + 400)
  })

  it('keeps native reasoning for no-tool forks without caching a thinking block', async () => {
    const { adapter } = adapterWith(fakeStream([native[0]], 'end_turn'))
    const first = await callNonStreaming(adapter, { ...options, messages: [createUserMessage('test')] })
    const message = createAssistantMessage([...first.content], 'end_turn')
    const next = adapterWith(fakeStream([], 'end_turn'))
    await callNonStreaming(next.adapter, { ...options, tools: [], messages: [message] })
    expect((next.request.mock.calls[0][0] as any).messages).toEqual([{ role: 'assistant', content: [native[0]] }])
  })

  it('does not fabricate reasoning for legacy or plain text responses', async () => {
    const { adapter } = adapterWith(fakeStream([{ type: 'text', text: 'ok' }], 'end_turn'))
    const response = await callNonStreaming(adapter, { ...options, messages: [createUserMessage('test')] })
    expect(response.content).toEqual([{ type: 'text', text: 'ok' }])
    const legacy = createAssistantMessage([{ type: 'raw_reasoning', data: { type: 'reasoning', encrypted_content: 'legacy' } }, { type: 'text', text: 'old' }], 'end_turn')
    expect(JSON.stringify(normalizeMessagesForAnthropic([legacy]))).not.toContain('legacy')
    expect(JSON.stringify(normalizeMessagesForResponses([legacy]))).toContain('legacy')
  })

  it('does not publish successful ordered content after a failed stream', async () => {
    const { adapter } = adapterWith(fakeStream(native, 'tool_use', true))
    const chunks: any[] = []
    await expect((async () => { for await (const c of adapter.stream({ ...options, messages: [createUserMessage('test')] })) chunks.push(c) })()).rejects.toThrow('synthetic failure')
    expect(chunks.some(c => c.type === 'assistant_content' || c.type === 'message_end')).toBe(false)
  })
})
