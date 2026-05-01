import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { forkEngine, createSubAgentTool } from '../../src/engine/sub-agent'
import type { SubAgentBgContext } from '../../src/engine/sub-agent'
import type { LLMAdapter } from '../../src/engine/llm-adapter'
import type { StreamChunk } from '../../src/engine/types'
import { defineTool } from '../../src/engine/tool-framework'
import { HumanMessageQueue } from '../../src/engine/human-message-queue'
import { TraceStore } from '../../src/core/trace-store'
import { BgEntityRegistry } from '../../src/engine/bg-entities/registry'
import type { WorkerAgentContext } from '../../src/types'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'

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

describe('createSubAgentTool with trace', () => {
  it('creates independent trace for sub-agent execution', async () => {
    const store = new TraceStore(10)
    const parentTrace = store.startTrace({
      module_id: 'agent-1',
      trigger: { type: 'task', summary: 'parent task' },
      related_task_id: 'task-999',
    })
    const parentSpan = store.startSpan(parentTrace.trace_id, {
      type: 'tool_call',
      details: { tool_name: 'delegate_task', input_summary: 'do something' },
    })

    const subDummy = defineTool({
      name: 'sub_dummy',
      description: 'Dummy',
      inputSchema: {},
      isReadOnly: true,
      call: async () => ({ output: 'ok', isError: false }),
    })

    // Use tool_use + text response so onTurn fires (onTurn only fires on tool_use turns)
    const adapter = mockAdapter([
      toolUseResponse('tu-1', 'sub_dummy', {}),
      textResponse('Sub result'),
    ])
    const tool = createSubAgentTool({
      name: 'delegate_task',
      description: 'delegate',
      adapter,
      model: 'test',
      systemPrompt: 'You are a sub-agent.',
      subTools: [subDummy],
      traceConfig: {
        traceStore: store,
        parentTraceId: parentTrace.trace_id,
        parentSpanId: parentSpan.span_id,
        relatedTaskId: 'task-999',
      },
    })

    const result = await tool.call!({ task: 'do something' }, { abortSignal: new AbortController().signal })
    expect(result.isError).toBe(false)

    // Verify sub-agent created independent trace
    const allTraces = store.getTraces(10, 0)
    expect(allTraces.traces).toHaveLength(2)  // parent + sub-agent

    const subTrace = allTraces.traces.find(t => t.trigger.type === 'sub_agent_call')
    expect(subTrace).toBeDefined()
    expect(subTrace!.parent_trace_id).toBe(parentTrace.trace_id)
    expect(subTrace!.parent_span_id).toBe(parentSpan.span_id)
    expect(subTrace!.related_task_id).toBe('task-999')
    expect(subTrace!.status).toBe('completed')
    // onTurn fires once for the tool_use turn, creating llm_call + tool_call spans
    expect(subTrace!.spans.length).toBeGreaterThanOrEqual(1)
  })

  it('marks trace as failed when sub-agent errors', async () => {
    const store = new TraceStore(10)
    const parentTrace = store.startTrace({
      module_id: 'agent-1',
      trigger: { type: 'task', summary: 'parent task' },
    })
    const parentSpan = store.startSpan(parentTrace.trace_id, {
      type: 'tool_call',
      details: { tool_name: 'delegate_task', input_summary: 'fail' },
    })

    const failAdapter: LLMAdapter = {
      async *stream() { throw new Error('LLM crashed') },
      updateConfig() {},
    }

    const tool = createSubAgentTool({
      name: 'delegate_task',
      description: 'delegate',
      adapter: failAdapter,
      model: 'test',
      systemPrompt: 'You are a sub-agent.',
      subTools: [],
      traceConfig: {
        traceStore: store,
        parentTraceId: parentTrace.trace_id,
        parentSpanId: parentSpan.span_id,
      },
    })

    const result = await tool.call!({ task: 'fail' }, { abortSignal: new AbortController().signal })
    expect(result.isError).toBe(true)

    const allTraces = store.getTraces(10, 0)
    const subTrace = allTraces.traces.find(t => t.trigger.type === 'sub_agent_call')
    expect(subTrace).toBeDefined()
    expect(subTrace!.status).toBe('failed')
    expect(subTrace!.outcome?.error).toContain('LLM crashed')
  })

  it('includes child_trace_id in output JSON', async () => {
    const store = new TraceStore(10)
    const parentTrace = store.startTrace({
      module_id: 'agent-1',
      trigger: { type: 'task', summary: 'parent task' },
    })
    const parentSpan = store.startSpan(parentTrace.trace_id, {
      type: 'tool_call',
      details: { tool_name: 'delegate_task', input_summary: 'test' },
    })

    const adapter = mockAdapter([textResponse('Done')])
    const tool = createSubAgentTool({
      name: 'delegate_task',
      description: 'delegate',
      adapter,
      model: 'test',
      systemPrompt: 'Sub.',
      subTools: [],
      traceConfig: {
        traceStore: store,
        parentTraceId: parentTrace.trace_id,
        parentSpanId: parentSpan.span_id,
      },
    })

    const result = await tool.call!({ task: 'test' }, { abortSignal: new AbortController().signal })
    const parsed = JSON.parse(result.output)
    expect(parsed.child_trace_id).toBeDefined()
    expect(typeof parsed.child_trace_id).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Helpers for bg-context tests
// ---------------------------------------------------------------------------

function makeMasterPrivateCtx(): WorkerAgentContext {
  return {
    task_origin: {
      channel_id: 'channel-test',
      session_id: 'session-test',
      friend_id: 'friend-master',
      session_type: 'private',
    },
    sender_friend: {
      id: 'friend-master',
      display_name: 'Master',
      permission: 'master',
      channel_identities: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    short_term_memories: [],
    long_term_memories: [],
    available_tools: [],
    admin_endpoint: { module_id: 'admin', port: 3001 },
    memory_endpoint: { module_id: 'memory', port: 3002 },
    channel_endpoints: [],
  }
}

function makeGroupCtx(): WorkerAgentContext {
  return {
    task_origin: {
      channel_id: 'channel-test',
      session_id: 'session-group',
      friend_id: 'friend-normal',
      session_type: 'group',
    },
    sender_friend: {
      id: 'friend-normal',
      display_name: 'Normal',
      permission: 'normal',
      channel_identities: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    short_term_memories: [],
    long_term_memories: [],
    available_tools: [],
    admin_endpoint: { module_id: 'admin', port: 3001 },
    memory_endpoint: { module_id: 'memory', port: 3002 },
    channel_endpoints: [],
  }
}

// ---------------------------------------------------------------------------
// describe block: createSubAgentTool with bgContext (run_in_background)
// ---------------------------------------------------------------------------

describe('createSubAgentTool with bgContext (run_in_background)', () => {
  let tmpDataDir: string
  let registry: BgEntityRegistry

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-agent-bg-test-'))
    const registryPath = path.join(tmpDataDir, 'registry.json')
    registry = new BgEntityRegistry(registryPath)
  })

  afterEach(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
  })

  it('case 1: bgContext undefined → run_in_background not in schema', () => {
    const tool = createSubAgentTool({
      name: 'delegate_task',
      description: 'Delegate',
      adapter: mockAdapter([]),
      model: 'test-model',
      systemPrompt: 'You are a sub-agent.',
      subTools: [],
    })

    const props = (tool.inputSchema as any).properties
    expect(props).not.toHaveProperty('run_in_background')
  })

  it('case 2: bgContext provided + master private + run_in_background=true → spawnPersistentAgent, registry has agent entry', async () => {
    const workerContext = makeMasterPrivateCtx()
    const abortControllers = new Map<string, AbortController>()
    const bgContext: SubAgentBgContext = {
      registry,
      workerContext,
      owner: { friend_id: 'friend-master' },
      spawned_by_task_id: 'task-001',
      abortControllers,
    }

    const tool = createSubAgentTool({
      name: 'delegate_task',
      description: 'Delegate',
      adapter: mockAdapter([]),
      model: 'test-model',
      systemPrompt: 'You are a sub-agent.',
      subTools: [],
      bgContext,
    })

    // schema should include run_in_background
    const props = (tool.inputSchema as any).properties
    expect(props).toHaveProperty('run_in_background')

    const result = await tool.call({ task: 'Do research', run_in_background: true }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toMatch(/Sub-agent spawned \(persistent\): agent_/)
    expect(result.output).toContain('Output(')
    expect(result.output).toContain('Kill(')

    const match = result.output.match(/agent_[0-9a-f]+/)
    expect(match).not.toBeNull()
    const entityId = match![0]

    const entity = await registry.get(entityId)
    expect(entity).not.toBeNull()
    expect(entity?.type).toBe('agent')

    // cleanup: abort all spawned agents
    for (const [, ctrl] of abortControllers) {
      ctrl.abort()
    }
  })

  it('case 3: bgContext provided + group ctx + run_in_background=true → silent fallback to sync', async () => {
    const workerContext = makeGroupCtx()
    const abortControllers = new Map<string, AbortController>()
    const bgContext: SubAgentBgContext = {
      registry,
      workerContext,
      owner: { friend_id: 'friend-normal' },
      spawned_by_task_id: 'task-002',
      abortControllers,
    }

    const adapter = mockAdapter([textResponse('Sync result')])
    const tool = createSubAgentTool({
      name: 'delegate_task',
      description: 'Delegate',
      adapter,
      model: 'test-model',
      systemPrompt: 'You are a sub-agent.',
      subTools: [],
      bgContext,
    })

    // run_in_background=true but non-persistent scene → silent fallback to sync
    const result = await tool.call({ task: 'Do research', run_in_background: true }, {})
    expect(result.isError).toBe(false)
    // Sync path returns JSON with output field
    const parsed = JSON.parse(result.output)
    expect(parsed.output).toBe('Sync result')

    // Registry should NOT have a new agent entry
    const all = await registry.list({ status: ['running'] })
    expect(all).toHaveLength(0)
  })

  it('case 4: bgContext provided + 20 entity limit → returns isError with limit message', async () => {
    const friendId = 'friend-limit-test'
    const workerContext: WorkerAgentContext = {
      ...makeMasterPrivateCtx(),
      sender_friend: {
        ...makeMasterPrivateCtx().sender_friend!,
        id: friendId,
      },
      task_origin: {
        ...makeMasterPrivateCtx().task_origin!,
        friend_id: friendId,
      },
    }
    const abortControllers = new Map<string, AbortController>()
    const bgContext: SubAgentBgContext = {
      registry,
      workerContext,
      owner: { friend_id: friendId },
      spawned_by_task_id: 'task-limit',
      abortControllers,
    }

    // Pre-register 20 running agent entities
    for (let i = 0; i < 20; i++) {
      await registry.register({
        entity_id: `agent_fake${i.toString().padStart(4, '0')}`,
        type: 'agent',
        status: 'running',
        task_description: 'fake task',
        messages_log_file: '/tmp/fake.jsonl',
        result_file: null,
        owner: { friend_id: friendId },
        spawned_by_task_id: 'task-limit',
        spawned_at: new Date().toISOString(),
        exit_code: null,
        ended_at: null,
        last_activity_at: new Date().toISOString(),
      })
    }

    const tool = createSubAgentTool({
      name: 'delegate_task',
      description: 'Delegate',
      adapter: mockAdapter([]),
      model: 'test-model',
      systemPrompt: 'You are a sub-agent.',
      subTools: [],
      bgContext,
    })

    const result = await tool.call({ task: 'overflow task', run_in_background: true }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('20 个 bg entity 上限')
  })

  it('case 5: bgContext provided + run_in_background not passed → sync path', async () => {
    const workerContext = makeMasterPrivateCtx()
    const abortControllers = new Map<string, AbortController>()
    const bgContext: SubAgentBgContext = {
      registry,
      workerContext,
      owner: { friend_id: 'friend-master' },
      spawned_by_task_id: 'task-003',
      abortControllers,
    }

    const adapter = mockAdapter([textResponse('Sync output')])
    const tool = createSubAgentTool({
      name: 'delegate_task',
      description: 'Delegate',
      adapter,
      model: 'test-model',
      systemPrompt: 'You are a sub-agent.',
      subTools: [],
      bgContext,
    })

    // No run_in_background → sync execution
    const result = await tool.call({ task: 'Analyze data' }, {})
    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.output)
    expect(parsed.output).toBe('Sync output')

    // Registry should NOT have any new entries
    const all = await registry.list({ status: ['running'] })
    expect(all).toHaveLength(0)
  })
})
