import { describe, expect, it, vi } from 'vitest'
import { ContextManager, createManagerCompactionProfile } from '../../src/engine/context-manager.js'
import { runEngine } from '../../src/engine/query-loop.js'
import { defineTool } from '../../src/engine/tool-framework.js'
import { createAssistantMessage, createToolResultMessage, createUserMessage, type EngineOptions, type StreamChunk } from '../../src/engine/types.js'
import type { LLMAdapter, LLMStreamParams } from '../../src/engine/llm-adapter.js'
import { StreamTimeoutError } from '../../src/engine/retry-utils.js'

describe('compaction capacity accounting', () => {
  it('retains observed underestimation, counts fixed costs and calibrates appended messages', () => {
    const cm = new ContextManager({ maxContextTokens: 100 })
    const input = createUserMessage('x'.repeat(20))
    const appended = createUserMessage('x'.repeat(100))
    const state = { protectedHead: [], protectedTail: [], history: [input] }
    const profile = createManagerCompactionProfile({ mainRequestFixedTokens: 40 })
    const baseline = cm.estimateCompactionStateTokens(state, profile)
    cm.observeContextTokens(200, 100)
    cm.observeContextTokens(100, 100)
    expect(cm.estimateCompactionStateTokens(state, profile)).toBe(2 * baseline)
    expect(cm.shouldCompact([input, appended], {
      lastObservedContextTokens: 30, messageCountAtObservation: 1,
    })).toBe(true)
    expect(cm.shouldCompact([input], { systemPrompt: 'x'.repeat(160) })).toBe(true)
    cm.resetTokenEstimate()
    expect(cm.estimateCompactionStateTokens(state, profile)).toBe(baseline)
    expect(cm.shouldCompact([input, appended], {
      lastObservedContextTokens: 30, messageCountAtObservation: 1,
    })).toBe(false)
  })

  it.each([[NaN, 100], [Infinity, 100], [0, 100], [-1, 100], [100, 0], [100, NaN], [100, Infinity], [100, -1]])(
    'ignores invalid usage samples (%s / %s)', (observed, estimated) => {
      const cm = new ContextManager({ maxContextTokens: 100 })
      const state = { protectedHead: [], protectedTail: [], history: [createUserMessage('text')] }
      const profile = createManagerCompactionProfile()
      const baseline = cm.estimateCompactionStateTokens(state, profile)
      cm.observeContextTokens(200, 100)
      cm.observeContextTokens(observed, estimated)
      expect(cm.estimateCompactionStateTokens(state, profile)).toBe(2 * baseline)
    },
  )

  it.each(['adapter', 'model'])('drops stale calibration after a retry swaps the %s', async (swap) => {
    let generation = 0
    let oldCalls = 0
    let newCalls = 0
    const summaries = vi.fn()
    const read = vi.fn(async () => ({ output: newCalls ? 'x'.repeat(13_000) : 'ok', isError: false }))
    const readTool = defineTool({ name: 'Read', description: 'Read', inputSchema: {}, isReadOnly: true, call: read })
    async function* respond(params: LLMStreamParams, isNew: boolean): AsyncGenerator<StreamChunk> {
      if (!params.tools.length) {
        summaries()
        throw new Error('stale calibration caused unnecessary compaction')
      }
      if (!isNew && ++oldCalls === 2) {
        generation++
        throw new StreamTimeoutError('ttfb', 90_000)
      }
      if (isNew) newCalls++
      yield { type: 'message_start', messageId: 'response' }
      if (newCalls > 1) {
        yield { type: 'text_delta', text: 'done' }
        yield { type: 'message_end', stopReason: 'end_turn' }
        return
      }
      yield { type: 'tool_use_start', id: `read-${oldCalls}-${newCalls}`, name: 'Read' }
      yield { type: 'tool_use_delta', id: `read-${oldCalls}-${newCalls}`, inputJson: '{}' }
      yield { type: 'tool_use_end', id: `read-${oldCalls}-${newCalls}` }
      yield { type: 'message_end', stopReason: 'tool_use', usage: {
        inputTokens: isNew ? 1100 : 3300, outputTokens: 10,
      } }
    }
    const adapter: LLMAdapter = {
      updateConfig() {},
      stream: params => respond(params, params.model === 'new'),
    }
    const replacement: LLMAdapter = {
      updateConfig() {},
      stream: params => respond(params, true),
    }
    const result = await runEngine({ prompt: 'x'.repeat(4000), adapter,
      options: { systemPrompt: 'test', tools: [readTool], model: 'old', contextWindowTokens: 10_000,
        configGeneration: () => generation,
        onConfigChanged: async () => swap === 'model' ? { model: 'new' } : { adapter: replacement },
      },
    })
    expect(result.outcome).toBe('completed')
    expect(summaries).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it.each([
    { kind: 'manager', groups: 10, chars: 80_000 },
    { kind: 'builtin', groups: 3, chars: 266_667 },
  ])('fits oversized recent tool groups using observed usage in $kind', async ({ kind, groups, chars }) => {
    const estimator = new ContextManager({ maxContextTokens: 400_000 })
    const originalInput = createUserMessage('Preserve the original task and its delivery target.')
    const history = [originalInput, ...Array.from({ length: groups }, (_, index) => [
      createAssistantMessage([{ type: 'tool_use', id: `old-${index}`, name: 'Read', input: {} }], 'tool_use'),
      createToolResultMessage(`old-${index}`, 'x'.repeat(chars), false),
    ]).flat()]
    const read = vi.fn(async () => ({ output: 'x'.repeat(chars), isError: false }))
    const readTool = defineTool({ name: 'Read', description: 'Read', inputSchema: {}, isReadOnly: true, call: read })
    const promptTokens = (params: LLMStreamParams) => Math.ceil(1.7 * (
      estimator.estimateStaticPromptTokens(params.systemPrompt, params.tools)
      + estimator.estimateTotalTokens(params.messages)
    ))
    const requests: number[] = []
    let summaries = 0
    const adapter: LLMAdapter = {
      updateConfig() {},
      async *stream(params) {
        yield { type: 'message_start', messageId: 'response' }
        if (params.tools.length === 0) {
          summaries++
          yield { type: 'text_delta', text: 'Earlier tools completed; continue the original task.' }
          yield { type: 'message_end', stopReason: 'end_turn' }
          return
        }
        const tokens = promptTokens(params)
        requests.push(tokens)
        if (requests.length === 1) {
          yield { type: 'text_delta', text: 'Analysis '.repeat(Math.ceil(chars / 9)) }
          yield { type: 'tool_use_start', id: 'new-read', name: 'Read' }
          yield { type: 'tool_use_delta', id: 'new-read', inputJson: '{}' }
          yield { type: 'tool_use_end', id: 'new-read' }
          yield { type: 'message_end', stopReason: 'tool_use', usage: {
            inputTokens: 1000, cacheReadTokens: tokens - 2000, cacheCreationTokens: 1000, outputTokens: 10,
          } }
        } else {
          yield { type: 'text_delta', text: 'done' }
          yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: tokens, outputTokens: 10 } }
        }
      },
    }
    const onCompactionEnd = vi.fn()
    const options: EngineOptions = {
      systemPrompt: 'Complete the task.', tools: [readTool], model: 'fixture',
      contextWindowTokens: 400_000, maxTurns: 2, onCompactionEnd,
      ...(kind === 'manager' ? { prepareCompaction: (messages, fixedTokens) => ({
        state: { protectedHead: [], protectedTail: [], history: messages },
        profile: createManagerCompactionProfile({ mainRequestFixedTokens: fixedTokens,
          protectedMessageIds: new Set([originalInput.id]) }),
      }) } : {}),
    }
    const result = await runEngine({ prompt: '', initialMessages: history, adapter, options })
    expect(result.outcome).toBe('completed')
    expect(requests).toHaveLength(2)
    expect(requests[0]).toBeGreaterThan(320_000)
    expect(requests[1]).toBeLessThanOrEqual(320_000)
    expect(summaries).toBeGreaterThan(1)
    expect(onCompactionEnd).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect(result.finalMessages).toContainEqual(originalInput)
    for (const message of result.finalMessages) {
      if (!('toolResults' in message)) continue
      for (const tool of message.toolResults) {
        expect(result.finalMessages.some(candidate => candidate.role === 'assistant'
          && candidate.content.some(block => block.type === 'tool_use' && block.id === tool.tool_use_id))).toBe(true)
      }
    }
  })
})
