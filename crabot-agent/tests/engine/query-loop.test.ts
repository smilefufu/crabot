import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
import { defineTool } from '../../src/engine/tool-framework.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter.js'
import type {
  StreamChunk,
  EngineLlmResponseEvent,
  EngineOptions,
  EngineMessage,
  EngineToolLifecycleEvent,
  EngineTurnEvent,
} from '../../src/engine/types.js'
import { createUserMessage } from '../../src/engine/types.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import { chunksFromContent } from './helpers/mock-stream.js'

// --- Test Helpers ---

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

function textAndToolUseResponse(
  text: string,
  toolId: string,
  toolName: string,
  input: Record<string, unknown>,
): ReadonlyArray<StreamChunk> {
  return [
    { type: 'message_start', messageId: 'msg-1' },
    { type: 'text_delta', text },
    { type: 'tool_use_start', id: toolId, name: toolName },
    { type: 'tool_use_delta', id: toolId, inputJson: JSON.stringify(input) },
    { type: 'tool_use_end', id: toolId },
    { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 20, outputTokens: 10 } },
  ]
}

function baseOptions(overrides: Partial<EngineOptions> = {}): EngineOptions {
  return {
    systemPrompt: 'You are a test assistant.',
    tools: [],
    model: 'test-model',
    maxTurns: 10,
    ...overrides,
  }
}

function silentEndTurnResponse(): ReadonlyArray<StreamChunk> {
  return [
    { type: 'message_start', messageId: 'msg-1' },
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 0 } },
  ]
}

function nullStopResponse(): ReadonlyArray<StreamChunk> {
  return [
    { type: 'message_start', messageId: 'msg-1' },
    { type: 'message_end', stopReason: null, usage: { inputTokens: 10, outputTokens: 0 } },
  ]
}

// --- Tests ---

describe('runEngine', () => {
  it('returns completed with text for a simple text response', async () => {
    const adapter = mockAdapter([textResponse('Hello!')])
    const result = await runEngine({
      prompt: 'Hi',
      adapter,
      options: baseOptions(),
    })

    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('Hello!')
    expect(result.totalTurns).toBe(1)
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(5)
  })

  it('handles tool use then final text (2 turns)', async () => {
    const readTool = defineTool({
      name: 'Read',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      isReadOnly: true,
      call: async (input) => ({
        output: `content of ${String(input.path)}`,
        isError: false,
      }),
    })

    const adapter = mockAdapter([
      toolUseResponse('tu-1', 'Read', { path: '/tmp/test.txt' }),
      textResponse('The file contains: content of /tmp/test.txt'),
    ])

    const result = await runEngine({
      prompt: 'Read the file',
      adapter,
      options: baseOptions({ tools: [readTool] }),
    })

    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('The file contains: content of /tmp/test.txt')
    expect(result.totalTurns).toBe(2)
    expect(result.usage.inputTokens).toBe(30) // 20 + 10
    expect(result.usage.outputTokens).toBe(15) // 10 + 5
  })

  it('returns max_turns when loop is exhausted', async () => {
    const dummyTool = defineTool({
      name: 'dummy',
      description: 'Dummy tool',
      inputSchema: {},
      isReadOnly: false,
      call: async () => ({ output: 'ok', isError: false }),
    })

    // Always returns tool_use, never end_turn
    const adapter = mockAdapter([
      toolUseResponse('tu-1', 'dummy', {}),
      toolUseResponse('tu-2', 'dummy', {}),
      toolUseResponse('tu-3', 'dummy', {}),
    ])

    const result = await runEngine({
      prompt: 'Loop forever',
      adapter,
      options: baseOptions({ tools: [dummyTool], maxTurns: 3 }),
    })

    expect(result.outcome).toBe('max_turns')
    expect(result.totalTurns).toBe(3)
  })

  it('calls onTurn callback with correct turn data', async () => {
    const readTool = defineTool({
      name: 'Read',
      description: 'Read a file',
      inputSchema: {},
      isReadOnly: true,
      call: async () => ({ output: 'file content', isError: false }),
    })

    const onTurn = vi.fn()
    const lifecycleEvents: EngineToolLifecycleEvent[] = []

    const adapter = mockAdapter([
      toolUseResponse('tu-1', 'Read', { path: '/test' }),
      textResponse('Done'),
    ])

    await runEngine({
      prompt: 'Read it',
      adapter,
      options: baseOptions({
        tools: [readTool],
        onTurn,
        onToolLifecycle: (event) => lifecycleEvents.push(event),
      }),
    })

    // 自 cdaa253 起，final text turn 也补 fire 一次让 trace 能记录最后一轮（早 return 路径之前漏记）。
    expect(onTurn).toHaveBeenCalledTimes(2)
    expect(onTurn).toHaveBeenNthCalledWith(1,
      expect.objectContaining({
        turnNumber: 1,
        stopReason: 'tool_use',
        toolCalls: expect.arrayContaining([
          expect.objectContaining({ id: 'tu-1', name: 'Read' }),
        ]),
      })
    )
    expect(onTurn).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        turnNumber: 2,
        stopReason: 'end_turn',
        assistantText: 'Done',
        toolCalls: [],
      })
    )
    const turnCall = onTurn.mock.calls[0][0].toolCalls[0]
    expect(turnCall.callId).toEqual(expect.any(String))
    expect(lifecycleEvents.map((event) => event.type)).toEqual(['tool_started', 'tool_finished'])
    expect(lifecycleEvents.every((event) => event.callId === turnCall.callId)).toBe(true)
  })

  it('emits the complete LLM response before a deferred tool lifecycle and reuses stable ids', async () => {
    let releaseTool!: () => void
    const toolGate = new Promise<void>((resolve) => { releaseTool = resolve })
    const waitTool = defineTool({
      name: 'wait_tool',
      description: 'Wait for release',
      inputSchema: {},
      isReadOnly: true,
      call: async () => {
        await toolGate
        return { output: 'done', isError: false }
      },
    })
    const sequence: string[] = []
    const responses: EngineLlmResponseEvent[] = []
    const lifecycle: EngineToolLifecycleEvent[] = []
    const turns: EngineTurnEvent[] = []

    const running = runEngine({
      prompt: 'Wait',
      adapter: mockAdapter([textAndToolUseResponse('I will wait.', 'provider-call', 'wait_tool', { value: 1 })]),
      options: baseOptions({
        tools: [waitTool],
        maxTurns: 1,
        onLlmResponse: (event) => {
          responses.push(event)
          sequence.push('llm_response')
        },
        onToolLifecycle: (event) => {
          lifecycle.push(event)
          sequence.push(event.type)
        },
        onTurn: (event) => {
          turns.push(event)
          sequence.push('turn')
        },
      }),
    })

    await vi.waitFor(() => expect(sequence).toEqual(['llm_response', 'tool_started']))
    expect(responses[0]).toMatchObject({
      responseId: expect.any(String),
      turnNumber: 1,
      assistantText: 'I will wait.',
      stopReason: 'tool_use',
      toolCallsCount: 1,
      llmCallMs: expect.any(Number),
      llmStartedAtMs: expect.any(Number),
      usage: { inputTokens: 20, outputTokens: 10 },
    })
    expect(lifecycle[0].responseId).toBe(responses[0].responseId)

    releaseTool()
    await running

    expect(sequence).toEqual(['llm_response', 'tool_started', 'tool_finished', 'turn'])
    expect(lifecycle[1].responseId).toBe(responses[0].responseId)
    expect(turns[0].responseId).toBe(responses[0].responseId)
    expect(turns[0].toolCalls[0].callId).toBe(lifecycle[0].callId)
  })

  it('isolates LLM response observer failures from execution', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onTurn = vi.fn()

    const result = await runEngine({
      prompt: 'Hi',
      adapter: mockAdapter([textResponse('Hello')]),
      options: baseOptions({
        onLlmResponse: () => { throw new Error('trace unavailable: secret-value') },
        onTurn,
      }),
    })

    expect(result).toMatchObject({ outcome: 'completed', finalText: 'Hello' })
    expect(onTurn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('[engine] LLM response observer failed')
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret-value')
    warn.mockRestore()
  })

  it('uses unique response ids across separate bursts even when turn numbers reset', async () => {
    const responses: EngineLlmResponseEvent[] = []
    const options = baseOptions({ onLlmResponse: (event) => responses.push(event) })

    await runEngine({ prompt: 'first', adapter: mockAdapter([textResponse('one')]), options })
    await runEngine({ prompt: 'second', adapter: mockAdapter([textResponse('two')]), options })

    expect(responses.map((event) => event.turnNumber)).toEqual([1, 1])
    expect(responses[0].responseId).not.toBe(responses[1].responseId)
  })

  it('refreshes messagesRef with tool results before onTurn observers run', async () => {
    const readTool = defineTool({
      name: 'Read',
      description: 'Read a file',
      inputSchema: {},
      isReadOnly: true,
      call: async () => ({ output: 'file content', isError: false }),
    })
    const messagesRef = { current: [] as EngineMessage[] }
    const snapshots: EngineMessage[][] = []

    const adapter = mockAdapter([
      toolUseResponse('tu-1', 'Read', { path: '/test' }),
      textResponse('Done'),
    ])

    await runEngine({
      prompt: 'Read it',
      adapter,
      options: baseOptions({
        tools: [readTool],
        messagesRef,
        onTurn: () => snapshots.push(messagesRef.current.slice()),
      }),
    })

    const firstTurnSnapshot = snapshots[0]
    expect(firstTurnSnapshot).toEqual([
      expect.objectContaining({ role: 'user', content: 'Read it' }),
      expect.objectContaining({
        role: 'assistant',
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'tool_use', id: 'tu-1', name: 'Read' }),
        ]),
      }),
      expect.objectContaining({
        role: 'user',
        toolResults: [
          expect.objectContaining({
            tool_use_id: 'tu-1',
            content: expect.stringContaining('file content'),
            is_error: false,
          }),
        ],
      }),
    ])
  })

  it('returns aborted when abort signal fires', async () => {
    const controller = new AbortController()

    const adapter: LLMAdapter = {
      async *stream() {
        yield { type: 'message_start', messageId: 'msg-1' } as StreamChunk
        yield { type: 'text_delta', text: 'partial' } as StreamChunk
        // Abort during streaming
        controller.abort()
        yield { type: 'text_delta', text: ' more' } as StreamChunk
        yield { type: 'message_end', stopReason: 'end_turn' } as StreamChunk
      },
      updateConfig() {},
    }

    const result = await runEngine({
      prompt: 'Hi',
      adapter,
      options: baseOptions({ abortSignal: controller.signal }),
    })

    expect(result.outcome).toBe('aborted')
  })

  it('returns aborted when signal is already aborted before stream starts', async () => {
    const controller = new AbortController()
    controller.abort()

    const adapter = mockAdapter([textResponse('Hello')])

    const result = await runEngine({
      prompt: 'Hi',
      adapter,
      options: baseOptions({ abortSignal: controller.signal }),
    })

    expect(result.outcome).toBe('aborted')
  })

  it('returns failed when adapter throws an error', async () => {
    const adapter: LLMAdapter = {
      async *stream() {
        throw new Error('Network timeout')
      },
      updateConfig() {},
    }

    const result = await runEngine({
      prompt: 'Hi',
      adapter,
      options: baseOptions(),
    })

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('Network timeout')
  })

  it('returns failed when LLM stream ends without a terminal stopReason', async () => {
    const adapter = mockAdapter([nullStopResponse()])
    const onLlmResponse = vi.fn()

    const result = await runEngine({
      prompt: 'Hi',
      adapter,
      options: baseOptions({ suppressForcedSummary: () => true, onLlmResponse }),
    })

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('missing terminal stopReason')
    expect(onLlmResponse).toHaveBeenCalledWith(expect.objectContaining({
      assistantText: '',
      stopReason: null,
      toolCallsCount: 0,
      responseId: expect.any(String),
    }))
  })

  it('returns failed when adapter yields error chunk', async () => {
    const adapter = mockAdapter([
      [
        { type: 'message_start', messageId: 'msg-1' } as StreamChunk,
        { type: 'error', error: 'Rate limited' } as StreamChunk,
      ],
    ])

    const result = await runEngine({
      prompt: 'Hi',
      adapter,
      options: baseOptions(),
    })

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('Rate limited')
  })

  it('accepts ContentBlock[] as prompt', async () => {
    const capturedMessages: unknown[] = []
    const adapter: LLMAdapter = {
      async *stream(params) {
        capturedMessages.push(params.messages)
        for (const chunk of textResponse('ok')) {
          yield chunk
        }
      },
      updateConfig() {},
    }

    await runEngine({
      prompt: [
        { type: 'text' as const, text: 'Analyze this image' },
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'abc123' } },
      ],
      adapter,
      options: {
        systemPrompt: 'You are helpful.',
        tools: [],
        model: 'test-model',
      },
    })

    const messages = capturedMessages[0] as Array<{ content: unknown }>
    const firstContent = messages[0].content
    expect(Array.isArray(firstContent)).toBe(true)
    expect(firstContent).toHaveLength(2)
    expect((firstContent as any)[0].type).toBe('text')
    expect((firstContent as any)[1].type).toBe('image')
  })

  describe('endTurnGate', () => {
    it('suppressForcedSummary=true + silent end_turn: gate 返回 string 时注入并继续 loop', async () => {
      let callCount = 0
      const gate = vi.fn(async (): Promise<string | null> => {
        callCount++
        return callCount === 1 ? '请先补充内容再退出' : null
      })

      const adapter = mockAdapter([
        silentEndTurnResponse(),  // turn 1: silent, gate injects
        textResponse('好的'),      // turn 2: after gate injection
      ])

      const result = await runEngine({
        prompt: 'test',
        adapter,
        options: baseOptions({
          suppressForcedSummary: () => true,
          endTurnGate: gate,
        }),
      })

      expect(gate).toHaveBeenCalledTimes(2)
      expect(result.outcome).toBe('completed')
    })

    it('suppressForcedSummary=true + silent end_turn: gate 返回 null 时正常退出', async () => {
      const gate = vi.fn(async (): Promise<string | null> => null)
      const adapter = mockAdapter([silentEndTurnResponse()])

      const result = await runEngine({
        prompt: 'test',
        adapter,
        options: baseOptions({
          suppressForcedSummary: () => true,
          endTurnGate: gate,
        }),
      })

      expect(gate).toHaveBeenCalledOnce()
      expect(result.outcome).toBe('completed')
    })

    it('suppressForcedSummary=true + silent end_turn: gate 返回 fail 时任务失败', async () => {
      const gate = vi.fn(async () => ({
        kind: 'fail' as const,
        reason: 'no delivery after repeated reminders',
      }))
      const adapter = mockAdapter([silentEndTurnResponse()])

      const result = await runEngine({
        prompt: 'test',
        adapter,
        options: baseOptions({
          suppressForcedSummary: () => true,
          endTurnGate: gate,
        }),
      })

      expect(gate).toHaveBeenCalledOnce()
      expect(result.outcome).toBe('failed')
      expect(result.error).toBe('no delivery after repeated reminders')
    })

    it('suppressForcedSummary=false + silent end_turn: forces a follow-up instead of completing empty', async () => {
      const adapter = mockAdapter([
        silentEndTurnResponse(),
        textResponse('补充后的最终交付'),
      ])

      const result = await runEngine({
        prompt: 'test',
        adapter,
        options: baseOptions({
          suppressForcedSummary: () => false,
        }),
      })

      expect(result.outcome).toBe('completed')
      expect(result.finalText).toBe('补充后的最终交付')
      expect(result.totalTurns).toBe(2)
    })

    it('text end_turn: endTurnGate 也会被调用', async () => {
      const gate = vi.fn(async (): Promise<string | null> => null)
      const adapter = mockAdapter([textResponse('done')])

      await runEngine({
        prompt: 'test',
        adapter,
        options: baseOptions({ endTurnGate: gate }),
      })

      expect(gate).toHaveBeenCalledOnce()
    })

    it('text end_turn: assistantTextEndTurnHandler 可接管并完成 loop', async () => {
      const handler = vi.fn(async () => ({ kind: 'complete' as const }))
      const adapter = mockAdapter([textResponse('要发给用户的内容')])

      const result = await runEngine({
        prompt: 'test',
        adapter,
        options: baseOptions({
          assistantTextEndTurnHandler: handler,
        }),
      })

      expect(handler).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledWith({
        assistantText: '要发给用户的内容',
        turnNumber: 1,
      })
      expect(result.outcome).toBe('completed')
      expect(result.finalText).toBe('要发给用户的内容')
    })

    it('text end_turn: assistantTextEndTurnHandler 返回 supplement 时注入一次并继续 loop', async () => {
      const injections: string[] = []
      const handler = vi
        .fn()
        .mockResolvedValueOnce({ kind: 'inject' as const, text: '请改用 send_message' })
        .mockResolvedValueOnce({ kind: 'complete' as const })
      const adapter = mockAdapter([
        textResponse('第一段 assistant text'),
        textResponse('第二段 assistant text'),
      ])

      const result = await runEngine({
        prompt: 'test',
        adapter,
        options: baseOptions({
          assistantTextEndTurnHandler: handler,
          onSystemInjection: (event) => injections.push(`${event.type}:${event.text}`),
        }),
      })

      expect(handler).toHaveBeenCalledTimes(2)
      expect(injections).toEqual(['assistant_text_end_turn:请改用 send_message'])
      expect(result.outcome).toBe('completed')
      expect(result.finalText).toBe('第二段 assistant text')
    })

    it('endTurnGate 不传时正常退出，无报错', async () => {
      const adapter = mockAdapter([silentEndTurnResponse()])
      const result = await runEngine({
        prompt: 'test',
        adapter,
        options: baseOptions({ suppressForcedSummary: () => true }),
      })
      expect(result.outcome).toBe('completed')
    })
  })

  it('defaults maxTurns to 200 when not specified', async () => {
    const dummyTool = defineTool({
      name: 'dummy',
      description: 'Dummy',
      inputSchema: {},
      isReadOnly: false,
      call: async () => ({ output: 'ok', isError: false }),
    })

    // Create 201 tool-use responses (one more than default max)
    const responses = Array.from({ length: 201 }, (_, i) =>
      toolUseResponse(`tu-${i}`, 'dummy', {})
    )

    const adapter = mockAdapter(responses)

    const result = await runEngine({
      prompt: 'Loop',
      adapter,
      options: {
        systemPrompt: 'test',
        tools: [dummyTool],
        model: 'test-model',
        // maxTurns intentionally omitted
      },
    })

    expect(result.outcome).toBe('max_turns')
    expect(result.totalTurns).toBe(200)
  })
})

describe('runEngine silent end_turn retry', () => {
  // 推理模型（如 OpenAI Responses gpt-5.5）有概率在 end_turn 时只发 reasoning
  // 不发 text。query-loop 的"沉默 end_turn 追问"机制应介入：注入强制汇报 user
  // msg、最多重试 3 次、超过仍空才老实返回 finalText=''。

  it('retries on silent end_turn and accepts subsequent text', async () => {
    const capturedMessages: unknown[][] = []
    let callIndex = 0
    const adapter: LLMAdapter = {
      async *stream(params) {
        capturedMessages.push([...params.messages])
        const chunks = callIndex === 0 ? textResponse('') : textResponse('真实汇报：跑通了 X')
        callIndex++
        for (const chunk of chunks) yield chunk
      },
      updateConfig() {},
    }

    const result = await runEngine({
      prompt: 'do work',
      adapter,
      options: baseOptions(),
    })

    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('真实汇报：跑通了 X')
    expect(result.totalTurns).toBe(2)
    // 第二轮的 messages 应包含追问 user msg
    const secondCall = capturedMessages[1] as Array<{ role: string; content: unknown }>
    const lastUserMsg = [...secondCall].reverse().find(m => m.role === 'user')
    expect(JSON.stringify(lastUserMsg)).toContain('end_turn 结束但还没有向人类发送任何内容')
  })

  it('gives up after 3 retries and returns empty finalText', async () => {
    let callIndex = 0
    const adapter: LLMAdapter = {
      async *stream() {
        callIndex++
        for (const chunk of textResponse('')) yield chunk
      },
      updateConfig() {},
    }

    const result = await runEngine({
      prompt: 'do work',
      adapter,
      options: baseOptions(),
    })

    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('')
    // 1 轮原始 + 3 轮追问 = 4 轮（不再追问第 4 次）
    expect(result.totalTurns).toBe(4)
    expect(callIndex).toBe(4)
  })

  it('forwards forcedSummaryAttempt on the post-retry turn via onTurn', async () => {
    // 用 tool_use → end_turn 序列覆盖"模型被追问后先用工具查资料、再汇报"的场景。
    // tool_use 轮一定 fire onTurn（不像 end_turn 早 return 路径），便于断言透传。
    const dummyTool = defineTool({
      name: 'dummy',
      description: 'dummy',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      call: async () => ({ output: 'ok', isError: false }),
    })

    let callIndex = 0
    const adapter: LLMAdapter = {
      async *stream() {
        let chunks: ReadonlyArray<StreamChunk>
        if (callIndex === 0) chunks = textResponse('')
        else if (callIndex === 1) chunks = toolUseResponse('tu-1', 'dummy', {})
        else chunks = textResponse('done after lookup')
        callIndex++
        for (const chunk of chunks) yield chunk
      },
      updateConfig() {},
    }

    const turns: Array<{ turnNumber: number; forcedSummaryAttempt?: number; assistantText: string; toolCount: number }> = []
    await runEngine({
      prompt: 'do work',
      adapter,
      options: baseOptions({
        tools: [dummyTool],
        onTurn: (e) => {
          turns.push({
            turnNumber: e.turnNumber,
            forcedSummaryAttempt: e.forcedSummaryAttempt,
            assistantText: e.assistantText,
            toolCount: e.toolCalls.length,
          })
        },
      }),
    })

    // 第 1 轮（silent end_turn 触发追问）：fire onTurn 但不带标记
    // 第 2 轮（追问后立即调工具）：fire onTurn 带 forcedSummaryAttempt=1
    // 第 3 轮（end_turn 有 text）：自 cdaa253 起也补 fire 让 trace 看到最后一轮
    expect(turns).toHaveLength(3)
    expect(turns[0].forcedSummaryAttempt).toBeUndefined()
    expect(turns[0].assistantText).toBe('')
    expect(turns[0].toolCount).toBe(0)
    expect(turns[1].forcedSummaryAttempt).toBe(1)
    expect(turns[1].toolCount).toBe(1)
    expect(turns[2].assistantText).toBe('done after lookup')
    expect(turns[2].toolCount).toBe(0)
  })
})

describe('runEngine max_tokens silent compact retry', () => {
  function maxTokensEmptyResponse(): ReadonlyArray<StreamChunk> {
    return [
      { type: 'message_start', messageId: 'msg-1' },
      { type: 'message_end', stopReason: 'max_tokens', usage: { inputTokens: 100, outputTokens: 4096 } },
    ]
  }

  it('on max_tokens empty: pops empty assistant, no FORCED_SUMMARY_PROMPT, accepts subsequent text', async () => {
    const capturedMessages: EngineMessage[][] = []
    let callIndex = 0
    const adapter: LLMAdapter = {
      async *stream(params) {
        capturedMessages.push([...params.messages])
        const chunks = callIndex === 0 ? maxTokensEmptyResponse() : textResponse('压缩后真实汇报：完成 X')
        callIndex++
        for (const chunk of chunks) yield chunk
      },
      updateConfig() {},
    }

    const initialMessages = [
      createUserMessage('do work task origin'),
      ...Array.from({ length: 7 }, (_, index) => createUserMessage(`old-${index}-${'x'.repeat(400)}`)),
    ]
    const result = await runEngine({
      prompt: 'unused',
      initialMessages,
      adapter,
      options: baseOptions(),
    })

    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('压缩后真实汇报：完成 X')
    expect(result.totalTurns).toBe(2)
    // 关键差异（vs 真静默 end_turn 路径）：空 assistant 已 pop、无 FORCED_SUMMARY_PROMPT 注入
    const retryMainCall = capturedMessages[2] as Array<{ role: string; content: unknown }>
    expect(retryMainCall.some((message) => JSON.stringify(message.content).includes('[Earlier conversation summary]'))).toBe(true)
    const lastUserContent = JSON.stringify(retryMainCall.at(-1)?.content)
    expect(lastUserContent).not.toContain('end_turn 结束但没有输出任何文字')
    expect(callIndex).toBe(3) // 主调用 + 摘要调用 + 压缩后主调用
  })

  it('returns partial text without retry when max_tokens has non-empty text', async () => {
    let callIndex = 0
    const handler = vi.fn(async () => ({ kind: 'complete' as const }))
    const adapter: LLMAdapter = {
      async *stream() {
        callIndex++
        yield { type: 'message_start', messageId: 'msg-1' }
        yield { type: 'text_delta', text: '部分汇报但被截断' }
        yield { type: 'message_end', stopReason: 'max_tokens', usage: { inputTokens: 100, outputTokens: 4096 } }
      },
      updateConfig() {},
    }

    const result = await runEngine({
      prompt: 'do work',
      adapter,
      options: baseOptions({ assistantTextEndTurnHandler: handler }),
    })

    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('部分汇报但被截断')
    expect(result.totalTurns).toBe(1)
    expect(callIndex).toBe(1)
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns immediately with empty finalText after compact retries exhausted', async () => {
    // 连续 max_tokens-empty：跑完 MAX_MAX_TOKENS_COMPACT_RETRIES=2 次重试后立即返回，
    // 不再走 FORCED_SUMMARY_PROMPT（input 已被压过两次，再加 user msg 只会更糟）。
    let callIndex = 0
    const adapter: LLMAdapter = {
      async *stream(params) {
        callIndex++
        const chunks = params.systemPrompt.includes('[任务连续性状态]')
          ? textResponse('S')
          : maxTokensEmptyResponse()
        for (const chunk of chunks) yield chunk
      },
      updateConfig() {},
    }

    const result = await runEngine({
      prompt: 'unused',
      initialMessages: [
        createUserMessage('do work task origin'),
        ...Array.from({ length: 10 }, (_, index) => createUserMessage(`old-${index}-${'x'.repeat(400)}`)),
      ],
      adapter,
      options: baseOptions(),
    })

    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('')
    // 1 次原始 + 2 次 compact 重试 = 3 轮（MAX_MAX_TOKENS_COMPACT_RETRIES=2）
    expect(result.totalTurns).toBe(3)
    expect(callIndex).toBe(5) // 3 次主调用 + 2 次摘要调用
  })
})

describe('runEngine humanMessageQueue integration', () => {
  it('injects supplement messages between turns', async () => {
    const capturedMessages: unknown[][] = []
    let callIndex = 0

    const adapter: LLMAdapter = {
      async *stream(params) {
        capturedMessages.push([...params.messages])
        if (callIndex === 0) {
          for (const chunk of toolUseResponse('tu-1', 'dummy', {})) yield chunk
        } else {
          for (const chunk of textResponse('Adjusted!')) yield chunk
        }
        callIndex++
      },
      updateConfig() {},
    }

    const queue = new HumanMessageQueue()

    const toolWithSupplement = defineTool({
      name: 'dummy',
      description: 'Dummy tool',
      inputSchema: {},
      isReadOnly: true,
      call: async () => {
        queue.push('用户补充指示：改变方向')
        return { output: 'ok', isError: false }
      },
    })

    const result = await runEngine({
      prompt: 'Start task',
      adapter,
      options: baseOptions({
        tools: [toolWithSupplement],
        humanMessageQueue: queue,
      }),
    })

    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('Adjusted!')

    // Second LLM call should have the supplement message
    const secondCallMessages = capturedMessages[1]
    const allContent = secondCallMessages.map((m: any) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ).join(' ')
    expect(allContent).toContain('用户补充指示：改变方向')
  })

  it('drains multiple pending supplements in one batch', async () => {
    const capturedMessages: unknown[][] = []
    let callIndex = 0

    const adapter: LLMAdapter = {
      async *stream(params) {
        capturedMessages.push([...params.messages])
        if (callIndex === 0) {
          for (const chunk of toolUseResponse('tu-1', 'dummy', {})) yield chunk
        } else {
          for (const chunk of textResponse('Done')) yield chunk
        }
        callIndex++
      },
      updateConfig() {},
    }

    const queue = new HumanMessageQueue()

    const dummyTool = defineTool({
      name: 'dummy',
      description: 'Dummy',
      inputSchema: {},
      isReadOnly: true,
      call: async () => {
        queue.push('supplement 1')
        queue.push('supplement 2')
        return { output: 'ok', isError: false }
      },
    })

    await runEngine({
      prompt: 'Go',
      adapter,
      options: baseOptions({
        tools: [dummyTool],
        humanMessageQueue: queue,
      }),
    })

    const secondCallMessages = capturedMessages[1]
    const msgContents = secondCallMessages.map((m: any) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ).join(' ')
    expect(msgContents).toContain('supplement 1')
    expect(msgContents).toContain('supplement 2')
  })

  it('does nothing when humanMessageQueue is undefined', async () => {
    const adapter = mockAdapter([
      toolUseResponse('tu-1', 'dummy', {}),
      textResponse('Done'),
    ])

    const dummyTool = defineTool({
      name: 'dummy',
      description: 'Dummy',
      inputSchema: {},
      isReadOnly: true,
      call: async () => ({ output: 'ok', isError: false }),
    })

    const result = await runEngine({
      prompt: 'Go',
      adapter,
      options: baseOptions({ tools: [dummyTool] }),
    })

    expect(result.outcome).toBe('completed')
  })
})

describe('runEngine barrier integration', () => {
  it('waits for barrier before executing tools, cancels tools when supplement arrives', async () => {
    const capturedMessages: unknown[][] = []
    let callIndex = 0

    const adapter: LLMAdapter = {
      async *stream(params) {
        capturedMessages.push([...params.messages])
        if (callIndex === 0) {
          for (const chunk of toolUseResponse('tu-1', 'send_message', { text: 'hello' })) yield chunk
        } else {
          for (const chunk of textResponse('Understood, adjusting.')) yield chunk
        }
        callIndex++
      },
      updateConfig() {},
    }

    const queue = new HumanMessageQueue()
    queue.setBarrier(5000)

    // After 10ms, push a supplement to clear the barrier
    setTimeout(() => {
      queue.push('不要发送消息，改为总结')
    }, 10)

    const toolCallLog: string[] = []
    const sendTool = defineTool({
      name: 'send_message',
      description: 'Send a message',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      isReadOnly: false,
      call: async (input) => {
        toolCallLog.push(String(input.text))
        return { output: 'sent', isError: false }
      },
    })

    const result = await runEngine({
      prompt: 'Send hello',
      adapter,
      options: baseOptions({
        tools: [sendTool],
        humanMessageQueue: queue,
      }),
    })

    expect(result.outcome).toBe('completed')
    // Tool was NOT called — barrier intercepted before execution
    expect(toolCallLog).toHaveLength(0)

    // Second LLM call should contain cancellation notice and supplement
    const secondCallMessages = capturedMessages[1]
    const allContent = secondCallMessages.map((m: any) => {
      if (typeof m.content === 'string') return m.content
      if (m.toolResults) return m.toolResults.map((r: any) => r.content).join(' ')
      return JSON.stringify(m.content)
    }).join(' ')
    expect(allContent).toContain('操作已取消')
    expect(allContent).toContain('不要发送消息，改为总结')
  })

  it('proceeds normally when barrier is cleared without supplement', async () => {
    const adapter = mockAdapter([
      toolUseResponse('tu-1', 'send_message', { text: 'hello' }),
      textResponse('Done'),
    ])

    const queue = new HumanMessageQueue()
    queue.setBarrier(5000)

    // Clear barrier after 10ms without pushing a supplement
    setTimeout(() => {
      queue.clearBarrier()
    }, 10)

    const toolCallLog: string[] = []
    const sendTool = defineTool({
      name: 'send_message',
      description: 'Send a message',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      isReadOnly: false,
      call: async (input) => {
        toolCallLog.push(String(input.text))
        return { output: 'sent', isError: false }
      },
    })

    const result = await runEngine({
      prompt: 'Send hello',
      adapter,
      options: baseOptions({
        tools: [sendTool],
        humanMessageQueue: queue,
      }),
    })

    expect(result.outcome).toBe('completed')
    // Tool WAS called — barrier cleared without supplement
    expect(toolCallLog).toHaveLength(1)
  })

  it('proceeds normally when barrier times out', async () => {
    vi.useFakeTimers()

    const adapter = mockAdapter([
      toolUseResponse('tu-1', 'send_message', { text: 'hello' }),
      textResponse('Done'),
    ])

    const queue = new HumanMessageQueue()
    queue.setBarrier(100)

    const toolCallLog: string[] = []
    const sendTool = defineTool({
      name: 'send_message',
      description: 'Send a message',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      isReadOnly: false,
      call: async (input) => {
        toolCallLog.push(String(input.text))
        return { output: 'sent', isError: false }
      },
    })

    const enginePromise = runEngine({
      prompt: 'Send hello',
      adapter,
      options: baseOptions({
        tools: [sendTool],
        humanMessageQueue: queue,
      }),
    })

    // Advance timers to trigger the barrier timeout
    await vi.advanceTimersByTimeAsync(100)

    const result = await enginePromise

    expect(result.outcome).toBe('completed')
    // Tool WAS called — barrier timed out
    expect(toolCallLog).toHaveLength(1)

    vi.useRealTimers()
  })
})

// --- HR Task 1: Resolvable callback for tools / systemPrompt ---

import type { LLMCallResponse } from '../../src/engine/llm-adapter'
import type { ToolDefinition } from '../../src/engine/types'

function makeAdapter(responses: LLMCallResponse[]): LLMAdapter {
  let i = 0
  return {
    stream: vi.fn(async function* () {
      const r = responses[Math.min(i, responses.length - 1)]
      i++
      yield* chunksFromContent(r.content, r.stopReason, r.usage)
    }),
    updateConfig: vi.fn(),
  } as unknown as LLMAdapter
}

function endResponse(text = 'done'): LLMCallResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
  }
}

const dummyTool: ToolDefinition = {
  name: 'dummy_tool',
  description: 'd',
  inputSchema: { type: 'object' as const, properties: {} },
  isReadOnly: true,
  call: async () => ({ output: '', isError: false as const }),
}

describe('runEngine — Resolvable callback', () => {
  it('tools 传静态数组（向后兼容）', async () => {
    const adapter = makeAdapter([endResponse()])
    const result = await runEngine({
      prompt: 'hi',
      adapter,
      options: {
        systemPrompt: 'sys',
        tools: [dummyTool],
        model: 'test',
      },
    })
    expect(result.outcome).toBe('completed')
    expect(adapter.stream).toHaveBeenCalledTimes(1)
    const call = (adapter.stream as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.tools).toEqual([dummyTool])
  })

  it('tools 传 callback（每轮 resolve）', async () => {
    const adapter = makeAdapter([endResponse()])
    const cb = vi.fn<[], readonly ToolDefinition[]>(() => [dummyTool])
    const options: EngineOptions = {
      systemPrompt: () => 'sys-dynamic',
      tools: cb,
      model: 'test',
    }
    await runEngine({ prompt: 'hi', adapter, options })
    expect(cb).toHaveBeenCalled()
    const call = (adapter.stream as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.tools).toEqual([dummyTool])
    expect(call.systemPrompt).toBe('sys-dynamic')
  })

  it('tools callback 在每轮被独立 resolve', async () => {
    const tool1 = { ...dummyTool, name: 'tool1' }
    const tool2 = { ...dummyTool, name: 'tool2' }
    let returnTool2 = false
    const adapter = makeAdapter([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'tool1', input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      endResponse(),
    ])
    const cb = vi.fn<[], readonly ToolDefinition[]>(() => returnTool2 ? [tool2] : [tool1])
    const switching = (async () => {
      await new Promise(r => setTimeout(r, 10))
      returnTool2 = true
    })()
    const options: EngineOptions = { systemPrompt: 'sys', tools: cb, model: 'test' }
    await runEngine({ prompt: 'hi', adapter, options })
    await switching
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('runEngine onAfterCompaction hook', () => {
  it('does not invoke onAfterCompaction when no compaction triggered', async () => {
    const adapter = mockAdapter([textResponse('done')])
    const fn = vi.fn((msgs: ReadonlyArray<EngineMessage>) => msgs)
    await runEngine({
      prompt: 'hi',
      adapter,
      options: baseOptions({ onAfterCompaction: fn }),
    })
    expect(fn).not.toHaveBeenCalled()
  })

  it('hook is wired to context-manager interface (compile-time check via type)', () => {
    // EngineOptions 接受 onAfterCompaction 字段不报 TS 错误即通过；
    // compaction 触发场景由 context-manager 测试覆盖，此处不重复构造。
    const fn = (m: ReadonlyArray<EngineMessage>) => m
    const opts: EngineOptions = {
      systemPrompt: 'test',
      tools: [],
      model: 'test',
      onAfterCompaction: fn,
    }
    expect(typeof opts.onAfterCompaction).toBe('function')
  })
})

describe('runEngine incremental compaction progress', () => {
  it('keeps the first successful batch when the second fails and skips onAfterCompaction', async () => {
    const initialMessages = [
      createUserMessage('task-origin'),
      ...Array.from({ length: 8 }, (_, index) =>
        createUserMessage(`PARTIAL_${index}:${'x'.repeat(700)}`),
      ),
    ]
    const messagesRef = { current: [] as ReadonlyArray<EngineMessage> }
    const onAfterCompaction = vi.fn((messages: ReadonlyArray<EngineMessage>) => messages)
    const onCompactionEnd = vi.fn()
    let compactionCalls = 0
    const adapter: LLMAdapter = {
      async *stream(params) {
        if (params.systemPrompt.includes('[任务连续性状态]')) {
          compactionCalls++
          if (compactionCalls === 1) {
            yield* chunksFromContent([{ type: 'text', text: 'first-summary' }], 'end_turn')
            return
          }
          throw new Error('invalid api key on second batch')
        }
        throw new Error('main LLM must not run after compaction failure')
      },
      updateConfig() {},
    }

    const result = await runEngine({
      prompt: 'unused',
      initialMessages,
      adapter,
      options: baseOptions({
        contextWindowTokens: 800,
        messagesRef,
        onAfterCompaction,
        onCompactionEnd,
      }),
    })

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('invalid api key on second batch')
    expect(onAfterCompaction).not.toHaveBeenCalled()
    expect(onCompactionEnd).toHaveBeenCalledOnce()
    expect(onCompactionEnd).toHaveBeenCalledWith(expect.objectContaining({
      batchesApplied: 1,
      consumedMessages: expect.any(Number),
      failedReason: expect.stringContaining('invalid api key on second batch'),
    }))
    expect(JSON.stringify(result.finalMessages)).toContain('[Earlier conversation summary]')
    expect(JSON.stringify(result.finalMessages)).toContain('first-summary')
    expect(JSON.stringify(result.finalMessages)).not.toContain('PARTIAL_0')
    expect(JSON.stringify(result.finalMessages)).toContain('PARTIAL_7')
    expect(messagesRef.current).toEqual(result.finalMessages)
  })
})

// spec 2026-07-21 改动 3：compaction 真实 usage 触发
describe('runEngine compaction triggered by real usage', () => {
  const readTool = defineTool({
    name: 'Read',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    isReadOnly: true,
    call: async () => ({ output: 'file content', isError: false }),
  })

  function toolUseResponseWithUsage(
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number },
  ): ReadonlyArray<StreamChunk> {
    return [
      { type: 'message_start', messageId: 'msg-1' },
      { type: 'tool_use_start', id: 'tu-1', name: 'Read' },
      { type: 'tool_use_delta', id: 'tu-1', inputJson: JSON.stringify({ path: '/tmp/a' }) },
      { type: 'tool_use_end', id: 'tu-1' },
      { type: 'message_end', stopReason: 'tool_use', usage },
    ]
  }

  function textResponseNoUsage(text: string): ReadonlyArray<StreamChunk> {
    return [
      { type: 'message_start', messageId: 'msg-1' },
      { type: 'text_delta', text },
      { type: 'message_end', stopReason: 'end_turn' },
    ]
  }

  // 构造 5 轮 tool_use 历史（消息数 11 > keepRecentMessages=6，compaction 会真正执行），
  // 前 4 轮小 usage、第 5 轮带指定 usage；之后接 compaction 摘要响应 + 主轮 end_turn 响应。
  function historyThenDone(
    lastUsage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number },
  ): ReadonlyArray<ReadonlyArray<StreamChunk>> {
    const small = { inputTokens: 10, outputTokens: 10 }
    return [
      toolUseResponseWithUsage(small),
      toolUseResponseWithUsage(small),
      toolUseResponseWithUsage(small),
      toolUseResponseWithUsage(small),
      toolUseResponseWithUsage(lastUsage),
      textResponse('S'),         // compaction 摘要 LLM 调用
      textResponse('done'),      // 主轮 6
    ]
  }

  it('triggers compaction when observed prompt tokens exceed threshold', async () => {
    // contextWindowTokens=10000 → 阈值 8000。第 5 轮 usage 观测 9000 → 第 6 轮前触发压缩。
    const adapter = mockAdapter(historyThenDone({ inputTokens: 9_000, outputTokens: 10 }))
    const onCompactionStart = vi.fn()
    const result = await runEngine({
      prompt: 'hi',
      adapter,
      options: baseOptions({
        tools: [readTool],
        contextWindowTokens: 10_000,
        onCompactionStart,
      }),
    })

    expect(onCompactionStart).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('done')
    // compaction 后 messages 被改写：首条钉住 + 摘要 + recent
    expect(
      result.finalMessages.some(
        (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[Earlier conversation summary]'),
      ),
    ).toBe(true)
  })

  it('counts cacheReadTokens and cacheCreationTokens into the observed prompt size', async () => {
    // inputTokens=1000 本身低于阈值 8000，但 1000+6000+2000=9000 → 触发
    const adapter = mockAdapter(historyThenDone({ inputTokens: 1_000, outputTokens: 10, cacheReadTokens: 6_000, cacheCreationTokens: 2_000 }))
    const onCompactionStart = vi.fn()
    const result = await runEngine({
      prompt: 'hi',
      adapter,
      options: baseOptions({
        tools: [readTool],
        contextWindowTokens: 10_000,
        onCompactionStart,
      }),
    })

    expect(onCompactionStart).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('done')
  })

  it('does not trigger compaction when observed tokens stay under threshold', async () => {
    const adapter = mockAdapter([
      toolUseResponseWithUsage({ inputTokens: 10, outputTokens: 10 }),
      textResponse('done'),
    ])
    const onCompactionStart = vi.fn()
    const result = await runEngine({
      prompt: 'hi',
      adapter,
      options: baseOptions({
        tools: [readTool],
        contextWindowTokens: 10_000,
        onCompactionStart,
      }),
    })

    expect(onCompactionStart).not.toHaveBeenCalled()
    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('done')
  })

  it('fails explicitly when an oversized system prompt leaves no compressible history', async () => {
    // usage 缺失 → 估算路径。固定开销本身超过 hardCap，且只有受保护的 task-origin，
    // 历史压缩无法解决时不得把 no-op 当成成功。
    const adapter = mockAdapter([textResponseNoUsage('done')])
    const onCompactionStart = vi.fn()
    const result = await runEngine({
      prompt: 'hi',
      adapter,
      options: baseOptions({
        systemPrompt: 's'.repeat(40_000),
        contextWindowTokens: 10_000,
        onCompactionStart,
      }),
    })

    expect(onCompactionStart).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('上下文压缩失败')
  })

  it('fails explicitly when an oversized tools schema leaves no compressible history', async () => {
    // 工具 schema 固定开销本身超过 hardCap，且没有可压缩历史。
    const bigTool = defineTool({
      name: 'BigTool',
      description: 'd'.repeat(32_000),
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      call: async () => ({ output: 'ok', isError: false }),
    })
    const adapter = mockAdapter([textResponseNoUsage('done')])
    const onCompactionStart = vi.fn()
    const result = await runEngine({
      prompt: 'hi',
      adapter,
      options: baseOptions({
        tools: [bigTool],
        contextWindowTokens: 10_000,
        onCompactionStart,
      }),
    })

    expect(onCompactionStart).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('上下文压缩失败')
  })

  it('does not trigger estimation fallback when system prompt and tools are small', async () => {
    const adapter = mockAdapter([textResponseNoUsage('done')])
    const onCompactionStart = vi.fn()
    const result = await runEngine({
      prompt: 'hi',
      adapter,
      options: baseOptions({
        tools: [readTool],
        contextWindowTokens: 10_000,
        onCompactionStart,
      }),
    })

    expect(onCompactionStart).not.toHaveBeenCalled()
    expect(result.outcome).toBe('completed')
  })
})
