import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop'
import { defineTool } from '../../src/engine/tool-framework'
import type { LLMAdapter } from '../../src/engine/llm-adapter'
import type { StreamChunk, EngineOptions } from '../../src/engine/types'
import { HumanMessageQueue } from '../../src/engine/human-message-queue'

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

function baseOptions(overrides: Partial<EngineOptions> = {}): EngineOptions {
  return {
    systemPrompt: 'You are a test assistant.',
    tools: [],
    model: 'test-model',
    maxTurns: 10,
    ...overrides,
  }
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

    const adapter = mockAdapter([
      toolUseResponse('tu-1', 'Read', { path: '/test' }),
      textResponse('Done'),
    ])

    await runEngine({
      prompt: 'Read it',
      adapter,
      options: baseOptions({ tools: [readTool], onTurn }),
    })

    // onTurn is called for tool-use turns (turn 1), not for the final text turn
    expect(onTurn).toHaveBeenCalledTimes(1)
    expect(onTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        turnNumber: 1,
        stopReason: 'tool_use',
        toolCalls: expect.arrayContaining([
          expect.objectContaining({ id: 'tu-1', name: 'Read' }),
        ]),
      })
    )
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
    expect(JSON.stringify(lastUserMsg)).toContain('end_turn 结束但没有输出任何文字')
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
    // 第 3 轮（end_turn 有 text）：早 return 路径不 fire onTurn — 已知留待后续
    expect(turns).toHaveLength(2)
    expect(turns[0].forcedSummaryAttempt).toBeUndefined()
    expect(turns[0].assistantText).toBe('')
    expect(turns[0].toolCount).toBe(0)
    expect(turns[1].forcedSummaryAttempt).toBe(1)
    expect(turns[1].toolCount).toBe(1)
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
    complete: vi.fn().mockImplementation(async () => {
      const r = responses[Math.min(i, responses.length - 1)]
      i++
      return r
    }),
    completeStreaming: vi.fn(),
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
    expect(adapter.complete).toHaveBeenCalledTimes(1)
    const call = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0]
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
    const call = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0][0]
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
