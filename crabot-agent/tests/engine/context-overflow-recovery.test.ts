import { describe, expect, it, vi } from 'vitest'
import { ContextManager, createManagerCompactionProfile, type CompactionState } from '../../src/engine/context-manager.js'
import type { LLMAdapter, LLMStreamParams } from '../../src/engine/llm-adapter.js'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '../../src/engine/types.js'
import { checkToolMessageIntegrity } from '../../src/engine/tool-message-integrity.js'
import { runEngine } from '../../src/engine/query-loop.js'
import { defineTool } from '../../src/engine/tool-framework.js'
import { chunksFromContent } from './helpers/mock-stream.js'

const windowTokens = 12_000
const hardCapTokens = 9_600
const stateOf = (history: CompactionState['history']): CompactionState => ({ protectedHead: [], history, protectedTail: [] })

function fixture(mode: 'valid' | 'empty' | 'truncated' | 'inflated' | 'overflow' = 'valid') {
  const requests: LLMStreamParams[] = []
  const adapter: LLMAdapter = {
    updateConfig() {},
    async *stream(params) {
      requests.push(params)
      if (mode === 'overflow') throw new Error('context length exceeded')
      yield { type: 'message_start', messageId: 'summary' }
      const text = mode === 'empty' ? '' : mode === 'inflated' ? 'unhelpful '.repeat(10_000) : 'Tools completed. Continue the task.'
      yield { type: 'text_delta', text }
      yield { type: 'message_end', stopReason: mode === 'truncated' ? 'max_tokens' : 'end_turn' }
    },
  }
  const manager = new ContextManager({ maxContextTokens: windowTokens })
  const profile = createManagerCompactionProfile({ summarySystemPrompt: 'Summarize.', mainRequestFixedTokens: 100 })
  const compact = (state: CompactionState, extra: Partial<Parameters<ContextManager['compactIncrementally']>[0]> = {}) =>
    manager.compactIncrementally({ state, profile, adapter, model: 'test',
      target: { kind: 'fit_hard_cap', hardCapTokens }, ...extra })
  return { requests, adapter, manager, profile, compact }
}

describe('context overflow recovery', () => {
  it('keeps shrinking on repeated Provider overflow without repeating a completed tool', async () => {
    const f = fixture()
    const write = vi.fn(async () => ({ output: 'written '.repeat(1000), isError: false }))
    const tool = defineTool({ name: 'write', description: 'write', inputSchema: {}, isReadOnly: false, call: write })
    const requests: number[] = []
    const adapter: LLMAdapter = {
      updateConfig() {},
      async *stream(params) {
        if (params.tools.length === 0) { yield* f.adapter.stream(params); return }
        requests.push(f.manager.estimateTotalTokens(params.messages))
        if (requests.length === 1) {
          yield* chunksFromContent([{ type: 'tool_use', id: 'written-once', name: 'write', input: {} }], 'tool_use')
        } else if (requests.length < 4) {
          throw new Error('context length exceeded')
        } else yield* chunksFromContent([{ type: 'text', text: 'done' }], 'end_turn')
      },
    }
    const result = await runEngine({ prompt: 'task '.repeat(1000), adapter,
      options: { systemPrompt: 'Execute.', tools: [tool], model: 'test', contextWindowTokens: windowTokens, maxTurns: 3 } })
    expect(result.outcome).toBe('completed')
    expect(write).toHaveBeenCalledTimes(1)
    expect(requests).toHaveLength(4)
    expect(requests[2]).toBeLessThan(requests[1])
    expect(requests[3]).toBeLessThan(requests[2])
  })

  it('can consume the last complete tool group without replaying tools', async () => {
    const f = fixture()
    const group = [createAssistantMessage([{ type: 'tool_use', id: 'written', name: 'write', input: {} }], 'tool_use'),
      createToolResultMessage('written', 'done '.repeat(10_000), false)]
    const result = await f.compact(stateOf(group))
    expect(result.failedReason).toBeUndefined()
    expect(result.state.history).toHaveLength(0)
    expect(result.consumedMessages).toBe(2)
    expect(checkToolMessageIntegrity(result.messages)).toEqual({ ok: true })
  })

  it('splits an oversized single message into bounded summary requests covering its tail', async () => {
    const f = fixture()
    const source = 'begin-source:' + 'large evidence '.repeat(12_000) + ':end-source'
    const result = await f.compact(stateOf([createUserMessage(source)]))
    expect(result.failedReason).toBeUndefined()
    expect(f.requests.length).toBeGreaterThan(1)
    expect(f.requests.map(p => JSON.stringify(p.messages)).join('')).toContain(':end-source')
    for (const request of f.requests) {
      const input = f.manager.estimateStaticPromptTokens(request.systemPrompt, request.tools)
        + f.manager.estimateTotalTokens(request.messages)
      expect(input).toBeLessThanOrEqual(hardCapTokens)
      expect(request.maxTokens).toBeGreaterThan(0)
    }
    expect(f.manager.estimateCompactionStateTokens(result.state, f.profile)).toBeLessThanOrEqual(hardCapTokens)
  })

  it('reduces an oversized existing summary with no history left', async () => {
    const f = fixture()
    const result = await f.compact({ ...stateOf([]), previousSummary: 'old '.repeat(30_000) })
    expect(result.failedReason).toBeUndefined()
    expect(result.consumedMessages).toBe(0)
    expect(f.manager.estimateCompactionStateTokens(result.state, f.profile)).toBeLessThanOrEqual(hardCapTokens)
  })

  it.each(['empty', 'truncated', 'inflated', 'overflow'] as const)('uses explicit bounded omission after %s summaries', async mode => {
    const f = fixture(mode)
    const input = createUserMessage('evidence '.repeat(15_000))
    const result = await f.compact(stateOf([input]))
    expect(result.failedReason).toBeUndefined()
    expect(JSON.stringify(result.messages)).toContain('内容已省略')
    expect(f.requests.length).toBeLessThanOrEqual(12)
    expect(f.manager.estimateCompactionStateTokens(result.state, f.profile)).toBeLessThanOrEqual(hardCapTokens)
    expect(input.content).toBe('evidence '.repeat(15_000))
  })

  it('fits oversized protected input while retaining source role, identity and order', async () => {
    const f = fixture('empty')
    const head = createUserMessage('original task '.repeat(8_000))
    const current = createUserMessage('latest request '.repeat(8_000))
    const result = await f.compact({ protectedHead: [head], history: [], protectedTail: [current] })
    expect(result.failedReason).toBeUndefined()
    expect(result.state.protectedHead[0]).toMatchObject({ id: head.id, role: head.role })
    expect(result.state.protectedTail[0]).toMatchObject({ id: current.id, role: current.role })
    expect(JSON.stringify(result.messages)).toContain('内容已省略')
    expect(f.manager.estimateCompactionStateTokens(result.state, f.profile)).toBeLessThanOrEqual(hardCapTokens)
  })

  it('does not consume an unfinished tool call', async () => {
    const f = fixture()
    const call = createAssistantMessage([{ type: 'tool_use', id: 'pending', name: 'write', input: { text: 'x'.repeat(60_000) } }], 'tool_use')
    const result = await f.compact(stateOf([call]))
    expect(result.failedReason).toBeDefined()
    expect(result.messages).toEqual([call])
    expect(f.requests).toHaveLength(0)
  })

  it('counts large native reasoning and folds it only with its complete message group', async () => {
    const f = fixture()
    const message = createAssistantMessage([{ type: 'raw_reasoning', data: { encrypted_content: 'x'.repeat(80_000) } },
      { type: 'tool_use', id: 'done', name: 'read', input: {} }], 'tool_use')
    expect(f.manager.estimateMessageTokens(message)).toBeGreaterThan(20_000)
    const result = await f.compact(stateOf([message, createUserMessage('interleaved context'), createToolResultMessage('done', 'read result', false)]))
    expect(result.failedReason).toBeUndefined()
    expect(result.consumedMessages).toBe(3)
    expect(checkToolMessageIntegrity(result.messages)).toEqual({ ok: true })
  })

  it('does not crop system cost or pretend impossible configuration fits', async () => {
    const f = fixture()
    const result = await f.compact(stateOf([createUserMessage('task')]), {
      profile: { ...f.profile, mainRequestFixedTokens: hardCapTokens + 1 },
    })
    expect(result.failedReason).toBeDefined()
    expect(f.requests).toHaveLength(0)
  })

  it('does not crop host control instructions carried in the message list', async () => {
    const f = fixture('empty')
    const control = createUserMessage('host permission rules '.repeat(3000))
    const result = await f.compact(stateOf([control]), { profile: { ...f.profile,
      immutableMessageIds: new Set([control.id]) } })
    expect(result.failedReason).toBeDefined()
    expect(result.messages).toEqual([control])
    expect(f.requests).toHaveLength(0)
  })

  it('does not commit a crop after cancellation or persistence failure', async () => {
    const f = fixture('empty')
    const state = stateOf([createUserMessage('x'.repeat(70_000))])
    const applied = vi.fn(() => { throw new Error('disk unavailable') })
    const result = await f.compact(state, { profile: { ...f.profile, onBatchApplied: applied } })
    expect(result.failedReason).toContain('disk unavailable')
    expect(result.batchesApplied).toBe(0)
    expect(result.state).toEqual(state)
    const controller = new AbortController()
    controller.abort()
    const aborted = await f.compact(state, { signal: controller.signal })
    expect(aborted.aborted).toBe(true)
    expect(aborted.state).toEqual(state)
  })
})
