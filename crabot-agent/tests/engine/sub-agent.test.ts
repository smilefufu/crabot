import { describe, it, expect, vi } from 'vitest'
import { forkEngine, createSubAgentTool } from '../../src/engine/sub-agent'
import type { LLMAdapter } from '../../src/engine/llm-adapter'
import type { StreamChunk, ToolDefinition } from '../../src/engine/types'
import { defineTool } from '../../src/engine/tool-framework'
import { HumanMessageQueue } from '../../src/engine/human-message-queue'

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
    const { runEngine } = await import('../../src/engine/query-loop')
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
})

describe('createSubAgentTool', () => {
  it('creates a valid ToolDefinition', () => {
    const tool = createSubAgentTool({
      name: 'research_agent',
      description: 'A research sub-agent',
      adapter: mockAdapter([]),
      model: 'test-model',
      systemPrompt: 'You are a researcher.',
      subTools: [],
    })

    expect(tool.name).toBe('research_agent')
    expect(tool.description).toBe('A research sub-agent')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task description for the sub-agent' },
        context: { type: 'string', description: 'Optional parent context to share with the sub-agent' },
      },
      required: ['task'],
    })
    expect(typeof tool.call).toBe('function')
  })

  it('tool call executes forkEngine and returns output', async () => {
    const adapter = mockAdapter([textResponse('Research complete: found 3 results')])

    const tool = createSubAgentTool({
      name: 'research_agent',
      description: 'A research sub-agent',
      adapter,
      model: 'test-model',
      systemPrompt: 'You are a researcher.',
      subTools: [],
    })

    const result = await tool.call(
      { task: 'Find info about TypeScript generics' },
      {}
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('Research complete: found 3 results')
  })

  it('input schema includes image_paths parameter', () => {
    const tool = createSubAgentTool({
      name: 'vision_expert',
      description: 'Vision agent',
      adapter: mockAdapter([]),
      model: 'test-model',
      systemPrompt: 'You are a vision expert.',
      subTools: [],
      supportsVision: true,
    })

    const props = (tool.inputSchema as any).properties
    expect(props).toHaveProperty('image_paths')
    expect(props.image_paths.type).toBe('array')
  })

  it('input schema omits image_paths when supportsVision is false', () => {
    const tool = createSubAgentTool({
      name: 'coding_expert',
      description: 'Coding agent',
      adapter: mockAdapter([]),
      model: 'test-model',
      systemPrompt: 'You are a coder.',
      subTools: [],
    })

    const props = (tool.inputSchema as any).properties
    expect(props).not.toHaveProperty('image_paths')
  })
})

describe('createSubAgentTool with parentHumanQueue', () => {
  it('creates child queue and propagates supplements to sub-agent', async () => {
    const capturedMessages: unknown[][] = []
    let subAgentCallIndex = 0

    const subAdapter: LLMAdapter = {
      async *stream(params) {
        capturedMessages.push([...params.messages])
        if (subAgentCallIndex === 0) {
          for (const chunk of toolUseResponse('tu-1', 'sub_dummy', {})) yield chunk
        } else {
          for (const chunk of textResponse('Adjusted by sub-agent')) yield chunk
        }
        subAgentCallIndex++
      },
      updateConfig() {},
    }

    const subDummy = defineTool({
      name: 'sub_dummy',
      description: 'Sub dummy',
      inputSchema: {},
      isReadOnly: true,
      call: async () => ({ output: 'ok', isError: false }),
    })

    const parentQueue = new HumanMessageQueue()

    const origCall = subDummy.call
    const toolWithSupplement = defineTool({
      ...subDummy,
      call: async (input, ctx) => {
        parentQueue.push('用户补充：换个方向')
        return origCall(input, ctx)
      },
    })

    const tool = createSubAgentTool({
      name: 'test_delegate',
      description: 'Test delegate',
      adapter: subAdapter,
      model: 'test-model',
      systemPrompt: 'You are a test sub-agent.',
      subTools: [toolWithSupplement],
      parentHumanQueue: parentQueue,
    })

    const result = await tool.call({ task: 'Do something' }, {})

    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.output)
    expect(parsed.output).toBe('Adjusted by sub-agent')

    expect(capturedMessages.length).toBe(2)
    const secondCallMsgs = capturedMessages[1]
    const allContent = secondCallMsgs.map((m: any) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ).join(' ')
    expect(allContent).toContain('用户补充：换个方向')
  })

  it('removes child queue after sub-agent completes', async () => {
    const adapter = mockAdapter([textResponse('Done')])
    const parentQueue = new HumanMessageQueue()

    const tool = createSubAgentTool({
      name: 'test_delegate',
      description: 'Test',
      adapter,
      model: 'test-model',
      systemPrompt: 'Test.',
      subTools: [],
      parentHumanQueue: parentQueue,
    })

    await tool.call({ task: 'Quick task' }, {})

    parentQueue.push('after completion')
    expect(parentQueue.drainPending()).toEqual(['after completion'])
  })

  it('removes child queue even if sub-agent fails', async () => {
    const failAdapter: LLMAdapter = {
      async *stream() {
        throw new Error('LLM crashed')
      },
      updateConfig() {},
    }
    const parentQueue = new HumanMessageQueue()

    const tool = createSubAgentTool({
      name: 'test_delegate',
      description: 'Test',
      adapter: failAdapter,
      model: 'test-model',
      systemPrompt: 'Test.',
      subTools: [],
      parentHumanQueue: parentQueue,
    })

    const result = await tool.call({ task: 'Fail task' }, {})
    expect(result.isError).toBe(true)

    parentQueue.push('after failure')
    expect(parentQueue.drainPending()).toEqual(['after failure'])
  })
})
