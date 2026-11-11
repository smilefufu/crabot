import { HttpResponseError } from '../../src/engine/retry-utils.js'
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDelegationReview, attachManagerHumanSources, parseDelegationReview } from '../../src/manager/delegation-review.js'
import { DELEGATION_REVIEW_PROMPT } from '../../src/manager/delegation-review-prompt.js'
import { createUserMessage, createAssistantMessage, createToolResultMessage, defineTool, runEngine } from '../../src/engine/index.js'
import type { ToolBatchContext, EngineMessage } from '../../src/engine/types.js'
import type { LLMAdapter, LLMStreamParams } from '../../src/engine/llm-adapter.js'
import type { ChannelMessage } from '../../src/types.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

const allow = JSON.stringify({ verdict: 'allow', issues: [] })
const issue = { call_ids: ['a'], source_quote: '先调查', handoff_quote: '直接改写', impact: '跳过调查' }
function fixture(replies: Array<string | Error> = [allow]) {
  const requests: LLMStreamParams[] = []
  const adapter: LLMAdapter = { updateConfig() {}, async *stream(params) {
    requests.push(params)
    const reply = replies.shift() ?? allow
    if (reply instanceof Error) throw reply
    yield* chunksFromContent([{ type: 'text', text: reply }], 'end_turn')
  } }
  const dispatch = vi.fn(async () => ({ output: 'dispatched' }))
  const read = defineTool({ name: 'Read', description: 'read', inputSchema: {}, isReadOnly: true, call: async () => ({ output: 'evidence' }) })
  const tools = [defineTool({ name: 'spawn_worker', description: 'spawn', inputSchema: {}, call: dispatch }), read]
  const calls = ['a', 'b'].map(id => ({ type: 'tool_use' as const, id, name: 'spawn_worker', input: { prompt: '先调查' } }))
  const context: ToolBatchContext = { systemPrompt: 'manager policy', messages: [createUserMessage('human')], tools, calls,
    callIds: new Map([['a', 'internal-a'], ['b', 'internal-b']]), adapter, model: 'configured-model', thinking: { level: 'high' } }
  const observe = vi.fn()
  const gate = createDelegationReview({ sources: () => [], inputRevision: () => 'stable', observe })
  return { requests, context, gate, dispatch, observe, adapter }
}

describe('production delegation review', () => {
  it('keeps the evaluated prompt byte-for-byte, using only the configured model without tools', async () => {
    const f = fixture()
    expect(DELEGATION_REVIEW_PROMPT).toBe('DELEGATION_FIDELITY_REVIEW\n' + readFileSync(resolve(__dirname, '../../eval/workbuddy/baselines/2026-11-10/reviewer.txt'), 'utf8'))
    expect(await f.gate(f.context)).toBe(f.context.tools)
    expect(f.requests[0]).toMatchObject({ tools: [], model: 'configured-model', thinking: { level: 'high' } })
    const snapshot = JSON.parse(String(f.requests[0].messages[0].content))
    expect(snapshot.proposedCalls.map((c: { id: string }) => c.id)).toEqual(['a', 'b'])
    expect(snapshot.managerMessages[0].content).toBe('human')
    expect(snapshot.managerSystem).toBe('manager policy')
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it('includes visible assistant and tool evidence without native reasoning metadata', async () => {
    const f = fixture()
    const assistant = { ...createAssistantMessage([{ type: 'text', text: 'visible decision' }, { type: 'tool_use', id: 'prior-read', name: 'Read', input: {} }, { type: 'raw_reasoning', data: { text: 'REASONING_FIXTURE' } }], 'tool_use'),
      providerState: { format: 'gemini' as const, content: { role: 'model' as const, parts: [{ thought: true, text: 'NATIVE_THOUGHT_FIXTURE' }] }, toolCalls: [] },
    }
    await f.gate({ ...f.context, messages: [...f.context.messages, assistant, createToolResultMessage('prior-read', 'visible tool evidence')] })
    const payload = String(f.requests[0].messages[0].content)
    expect(payload).toContain('visible decision'); expect(payload).toContain('visible tool evidence')
    expect(payload).not.toContain('REASONING_FIXTURE'); expect(payload).not.toContain('NATIVE_THOUGHT_FIXTURE')
  })

  it('rejects a verdict if the proposed input changed during the request', async () => {
    const f = fixture(); const stream = f.adapter.stream.bind(f.adapter)
    f.adapter.stream = async function* (params) { f.context.calls[0].input.prompt = 'changed'; yield* stream(params) }
    expect(await f.gate(f.context)).not.toBe(f.context.tools)
    expect(f.observe.mock.calls[0][0].technical_error).toContain('changed')
  })

  it('rejects the dispatch batch with exact attribution even for identical inputs, then reviews the revision', async () => {
    const f = fixture([JSON.stringify({ verdict: 'revise', issues: [issue] }), allow])
    const tools = await f.gate(f.context)
    const a = JSON.parse((await tools[0].call(f.context.calls[0].input, { toolCallId: 'internal-a' })).output)
    const b = JSON.parse((await tools[0].call(f.context.calls[1].input, { toolCallId: 'internal-b' })).output)
    expect(a.affected_call_ids).toEqual(['a']); expect(a.issues).toEqual([issue])
    expect(b.affected_call_ids).toEqual(['b']); expect(b.issues).toEqual([]); expect(b.other_call_issues).toEqual([issue])
    expect(tools[1]).toBe(f.context.tools[1]); expect(f.dispatch).not.toHaveBeenCalled()
    expect(await f.gate(f.context)).toBe(f.context.tools)
    expect(f.requests).toHaveLength(2)
  })

  it('retains genuine human sources with visible history but never promotes assistant/tool text into original input', () => {
    const source = { platform_message_id: 'original-id', content: { type: 'text', text: 'human' } } as ChannelMessage
    const messages: EngineMessage[] = [createUserMessage('rendered source'), createAssistantMessage([{ type: 'text', text: 'rendered source' }], 'end_turn')]
    const attached = attachManagerHumanSources(messages, [{ text: 'rendered source', messages: [source] }])
    expect(attached[0]).toMatchObject({ managerHumanSource: [source] })
    expect(attached[1]).toBe(messages[1]); expect(messages[0]).not.toHaveProperty('managerHumanSource')
    expect(attachManagerHumanSources(JSON.parse(JSON.stringify(attached)), [])[0]).toMatchObject({ managerHumanSource: [source] })
    source.content.text = 'changed outside snapshot'
    expect(attached[0]).toMatchObject({ managerHumanSource: [{ content: { text: 'human' } }] })
  })

  it('records invalid or incomplete verdicts as technical failure and dispatches nothing', async () => {
    for (const reply of ['not JSON', '{"verdict":"allow","issues":[{}]}', JSON.stringify({ verdict: 'revise', issues: [{ ...issue, call_ids: ['invented'] }] })]) {
      const f = fixture([reply]); const tools = await f.gate(f.context)
      expect(JSON.parse((await tools[0].call({}, { toolCallId: 'internal-a' })).output)).toMatchObject({ status: 'review_unavailable', dispatched: false })
      expect(f.observe.mock.calls[0][0].technical_error).toBeTruthy(); expect(f.dispatch).not.toHaveBeenCalled()
    }
    expect(() => parseDelegationReview('null', new Set())).toThrow()
  })

  it('keeps native transport failures and truncated verdicts separate from semantic rejection', async () => {
    const f = fixture([new HttpResponseError(401, 'unauthorized', 'fixture')])
    const rejected = await f.gate(f.context)
    expect(JSON.parse((await rejected[0].call({}, { toolCallId: 'internal-a' })).output).status).toBe('review_unavailable')
    expect(f.requests).toHaveLength(1)
    const truncated = fixture()
    truncated.adapter.stream = async function* () { yield* chunksFromContent([{ type: 'text', text: allow }], 'max_tokens') }
    await truncated.gate(truncated.context)
    expect(truncated.observe.mock.calls[0][0].technical_error).toContain('incomplete')
  })

  it('uses the existing native retry config refresh rather than staying on a failed old connection', async () => {
    const f = fixture(); const refreshed = fixture(); let generation = 0
    f.adapter.stream = async function* () { generation++; throw new HttpResponseError(503, 'overloaded', 'fixture') }
    const tools = await f.gate({ ...f.context, configGeneration: () => generation,
      onConfigChanged: async () => ({ adapter: refreshed.adapter, model: 'replacement-model', thinking: { level: 'low' } }),
    })
    expect(tools).toBe(f.context.tools)
    expect(refreshed.requests[0]).toMatchObject({ model: 'replacement-model', thinking: { level: 'low' }, tools: [] })
  })

  it('invalidates approval after a real new input or cancellation; gates in other sessions remain independent', async () => {
    const f = fixture(); let revision = 'first'
    const stream = f.adapter.stream.bind(f.adapter)
    f.adapter.stream = async function* (params) { revision = 'new-human-input'; yield* stream(params) }
    const gate = createDelegationReview({ sources: () => [], inputRevision: () => revision, observe: f.observe })
    expect(await gate(f.context)).not.toBe(f.context.tools)
    expect(f.observe.mock.calls[0][0].technical_error).toContain('changed')
    const other = fixture(); expect(await other.gate(other.context)).toBe(other.context.tools)
    const cancelled = fixture(); const controller = new AbortController(); controller.abort()
    expect(await cancelled.gate({ ...cancelled.context, signal: controller.signal })).not.toBe(cancelled.context.tools)
  })

  it('limits consecutive rejected revisions and ignores non-dispatch batches', async () => {
    const revise = JSON.stringify({ verdict: 'revise', issues: [issue] })
    const f = fixture([revise, revise])
    await f.gate(f.context); await f.gate(f.context)
    const tools = await f.gate(f.context)
    expect(f.requests).toHaveLength(2)
    expect(JSON.parse((await tools[0].call({}, { toolCallId: 'internal-a' })).output).status).toBe('uncertain')
    const other = fixture(); expect(await other.gate({ ...other.context, calls: [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }] })).toBe(other.context.tools)
    expect(other.requests).toHaveLength(0)
  })

  it('passes approved dispatch through the real engine permission pipeline', async () => {
    const f = fixture()
    let n = 0
    const adapter: LLMAdapter = { updateConfig() {}, async *stream(params) {
      if (params.systemPrompt === DELEGATION_REVIEW_PROMPT) { yield* f.adapter.stream(params); return }
      if (n++ === 0) yield* chunksFromContent(f.context.calls.slice(0, 1), 'tool_use')
      else yield* chunksFromContent([{ type: 'text', text: 'complete' }], 'end_turn')
    } }
    const result = await runEngine({ prompt: 'human', adapter, options: { model: 'configured-model', systemPrompt: 'manager policy',
      tools: f.context.tools, prepareToolBatch: f.gate, maxTurns: 2, suppressForcedSummary: () => true,
      permissionConfig: { mode: 'denyList', toolNames: ['spawn_worker'] },
    } })
    expect(result.finalMessages.flatMap(message => 'toolResults' in message ? message.toolResults : []).some(r => r.content.includes('Permission denied'))).toBe(true)
    expect(f.dispatch).not.toHaveBeenCalled(); expect(f.requests).toHaveLength(1)
  })
})
