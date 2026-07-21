import { describe, it, expect, vi } from 'vitest'
import { forkEngine } from '../../src/engine/sub-agent'
import type { LLMAdapter } from '../../src/engine/llm-adapter'
import type { StreamChunk } from '../../src/engine/types'
import { defineTool } from '../../src/engine/tool-framework'

// --- Test Helpers (same pattern as query-loop tests) ---

function mockAdapter(responses: ReadonlyArray<ReadonlyArray<StreamChunk>>): LLMAdapter {
  let callIndex = 0
  return {
    async *stream() {
      const chunks = responses[callIndex] ?? []
      callIndex++
      for (const chunk of chunks) {
        yield chunk
      }
    },
    updateConfig() {},
  }
}

function textResponse(text: string): ReadonlyArray<StreamChunk> {
  return [
    { type: 'message_start', messageId: 'msg-1' },
    { type: 'text_delta', text },
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
  ]
}

function toolUseResponse(
  toolId: string,
  toolName: string,
  input: Record<string, unknown>
): ReadonlyArray<StreamChunk> {
  return [
    { type: 'message_start', messageId: 'msg-1' },
    { type: 'tool_use_start', id: toolId, name: toolName },
    { type: 'tool_use_delta', id: toolId, inputJson: JSON.stringify(input) },
    { type: 'tool_use_end', id: toolId },
    { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 20, outputTokens: 10 } },
  ]
}

// --- Tests ---

describe('forkEngine', () => {
  it('returns output from sub-agent', async () => {
    const adapter = mockAdapter([textResponse('Sub-agent result')])

    const result = await forkEngine({
      prompt: 'Do the task',
      adapter,
      model: 'test-model',
      systemPrompt: 'You are a sub-agent.',
      tools: [],
    })

    expect(result.output).toBe('Sub-agent result')
    expect(result.outcome).toBe('completed')
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(5)
    expect(result.totalTurns).toBe(1)
  })

  it('includes parentContext in prompt when provided', async () => {
    const capturedMessages: unknown[] = []
    const adapter: LLMAdapter = {
      async *stream(params) {
        capturedMessages.push(params.messages)
        for (const chunk of textResponse('Done')) {
          yield chunk
        }
      },
      updateConfig() {},
    }

    await forkEngine({
      prompt: 'Summarize the data',
      adapter,
      model: 'test-model',
      systemPrompt: 'You are a sub-agent.',
      tools: [],
      parentContext: 'The user is working on a report about Q4 sales.',
    })

    // The first message should contain both parent context and task
    const messages = capturedMessages[0] as Array<{ content: string }>
    const firstContent = messages[0].content as string
    expect(firstContent).toContain('Parent Context')
    expect(firstContent).toContain('The user is working on a report about Q4 sales.')
    expect(firstContent).toContain('Your Task')
    expect(firstContent).toContain('Summarize the data')
  })

  it('respects maxTurns limit', async () => {
    const dummyTool = defineTool({
      name: 'dummy',
      description: 'Dummy tool',
      inputSchema: {},
      isReadOnly: false,
      call: async () => ({ output: 'ok', isError: false }),
    })

    const adapter = mockAdapter([
      toolUseResponse('tu-1', 'dummy', {}),
      toolUseResponse('tu-2', 'dummy', {}),
      toolUseResponse('tu-3', 'dummy', {}),
    ])

    const result = await forkEngine({
      prompt: 'Loop',
      adapter,
      model: 'test-model',
      systemPrompt: 'You are a sub-agent.',
      tools: [dummyTool],
      maxTurns: 2,
    })

    expect(result.outcome).toBe('max_turns')
    expect(result.totalTurns).toBe(2)
  })

  it('propagates abort signal', async () => {
    const controller = new AbortController()
    controller.abort()

    const adapter = mockAdapter([textResponse('Hello')])

    const result = await forkEngine({
      prompt: 'Hi',
      adapter,
      model: 'test-model',
      systemPrompt: 'You are a sub-agent.',
      tools: [],
      abortSignal: controller.signal,
    })

    expect(result.outcome).toBe('aborted')
  })

  it('passes supportsVision to engine options', async () => {
    // Mock runEngine to capture params
    const runEngineSpy = vi.spyOn(
      await import('../../src/engine/query-loop'),
      'runEngine'
    )
    runEngineSpy.mockResolvedValueOnce({
      outcome: 'completed',
      finalText: 'done',
      totalTurns: 1,
      usage: { inputTokens: 10, outputTokens: 5 },
    })

    const adapter = mockAdapter([])

    await forkEngine({
      prompt: 'Analyze image',
      adapter,
      model: 'test-model',
      systemPrompt: 'Vision expert.',
      tools: [],
      supportsVision: true,
    })

    expect(runEngineSpy).toHaveBeenCalledOnce()
    const calledParams = runEngineSpy.mock.calls[0][0]
    expect(calledParams.options.supportsVision).toBe(true)

    runEngineSpy.mockRestore()
  })

  it('passes contextWindowTokens to engine options when provided', async () => {
    const runEngineSpy = vi.spyOn(
      await import('../../src/engine/query-loop'),
      'runEngine'
    )
    runEngineSpy.mockResolvedValue({
      outcome: 'completed',
      finalText: 'done',
      totalTurns: 1,
      usage: { inputTokens: 10, outputTokens: 5 },
    })

    const adapter = mockAdapter([])

    // 传了 context_window → 透传到 engine options
    await forkEngine({
      prompt: 'Hi',
      adapter,
      model: 'test-model',
      systemPrompt: 'You are a sub-agent.',
      tools: [],
      contextWindowTokens: 131072,
    })
    expect(runEngineSpy.mock.calls[0][0].options.contextWindowTokens).toBe(131072)

    // 未传 → options 不带该字段（engine 走 200000 内置回退）
    await forkEngine({
      prompt: 'Hi',
      adapter,
      model: 'test-model',
      systemPrompt: 'You are a sub-agent.',
      tools: [],
    })
    expect(runEngineSpy.mock.calls[1][0].options.contextWindowTokens).toBeUndefined()

    runEngineSpy.mockRestore()
  })
})
