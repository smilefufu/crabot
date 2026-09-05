import { describe, it, expect, vi } from 'vitest'
import { executeToolBatches } from '../../src/engine/tool-orchestration'
import { defineTool } from '../../src/engine/tool-framework'
import type { EngineToolLifecycleEvent, ToolCallResult, ToolDefinition, ToolUseBlock } from '../../src/engine/types'

function makeBlock(name: string, id: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('executeToolBatches', () => {
  const slowReadTool = defineTool({
    name: 'slow_read',
    description: 'Slow read-only tool',
    inputSchema: {},
    isReadOnly: true,
    call: async () => {
      await delay(50)
      return { output: 'slow_done', isError: false }
    },
  })

  const fastReadTool = defineTool({
    name: 'fast_read',
    description: 'Fast read-only tool',
    inputSchema: {},
    isReadOnly: true,
    call: async () => {
      await delay(10)
      return { output: 'fast_done', isError: false }
    },
  })

  const writeTool = defineTool({
    name: 'write_file',
    description: 'Writes a file',
    inputSchema: {},
    isReadOnly: false,
    call: async (input) => {
      return { output: `wrote:${String(input.path ?? '')}`, isError: false }
    },
  })

  const errorTool = defineTool({
    name: 'error_tool',
    description: 'Always fails',
    inputSchema: {},
    isReadOnly: false,
    call: async () => {
      throw new Error('Something broke')
    },
  })

  const tools: ReadonlyArray<ToolDefinition> = [slowReadTool, fastReadTool, writeTool, errorTool]

  it('emits start before a deferred tool settles and finish immediately when it does', async () => {
    const gate = deferred<ToolCallResult>()
    const events: EngineToolLifecycleEvent[] = []
    const block = makeBlock('deferred', 'provider-call', { value: 1 })
    const tool = defineTool({
      name: 'deferred', description: 'wait', inputSchema: {}, isReadOnly: true,
      call: async () => gate.promise,
    })
    const running = executeToolBatches(
      [{ parallel: true, blocks: [block] }],
      [tool],
      undefined,
      undefined,
      undefined,
      {
        turnNumber: 4,
        callIds: new Map([['provider-call', 'engine-call']]),
        onToolLifecycle: (event) => events.push(event),
      },
    )

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({
      type: 'tool_started', callId: 'engine-call', turnNumber: 4,
      toolUseId: 'provider-call', name: 'deferred', input: { value: 1 },
    })

    gate.resolve({ output: 'done', isError: false })
    await running
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      type: 'tool_finished', callId: 'engine-call', toolUseId: 'provider-call',
      output: expect.stringContaining('done'), isError: false,
    })
  })

  it('reports parallel completion order without changing result order', async () => {
    const slow = deferred<ToolCallResult>()
    const fast = deferred<ToolCallResult>()
    const events: EngineToolLifecycleEvent[] = []
    const blocks = [makeBlock('slow_gate', 'slow'), makeBlock('fast_gate', 'fast')]
    const lifecycle = {
      turnNumber: 1,
      callIds: new Map([['slow', 'call-slow'], ['fast', 'call-fast']]),
      onToolLifecycle: (event: EngineToolLifecycleEvent) => events.push(event),
    }
    const running = executeToolBatches(
      [{ parallel: true, blocks }],
      [
        defineTool({ name: 'slow_gate', description: '', inputSchema: {}, isReadOnly: true, call: async () => slow.promise }),
        defineTool({ name: 'fast_gate', description: '', inputSchema: {}, isReadOnly: true, call: async () => fast.promise }),
      ],
      undefined, undefined, undefined, lifecycle,
    )

    await vi.waitFor(() => expect(events.map((event) => event.type)).toEqual(['tool_started', 'tool_started']))
    fast.resolve({ output: 'fast', isError: false })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'tool_finished' && event.callId === 'call-fast')).toBe(true))
    expect(events.some((event) => event.type === 'tool_finished' && event.callId === 'call-slow')).toBe(false)
    slow.resolve({ output: 'slow', isError: false })

    const results = await running
    expect(events.map((event) => `${event.type}:${event.callId}`)).toEqual([
      'tool_started:call-slow', 'tool_started:call-fast',
      'tool_finished:call-fast', 'tool_finished:call-slow',
    ])
    expect(results.map((result) => result.tool_use_id)).toEqual(['slow', 'fast'])
  })

  it('does not report a serial call as started before the previous call finishes', async () => {
    const first = deferred<ToolCallResult>()
    const events: EngineToolLifecycleEvent[] = []
    const running = executeToolBatches(
      [
        { parallel: false, blocks: [makeBlock('first', 'one')] },
        { parallel: false, blocks: [makeBlock('second', 'two')] },
      ],
      [
        defineTool({ name: 'first', description: '', inputSchema: {}, call: async () => first.promise }),
        defineTool({ name: 'second', description: '', inputSchema: {}, call: async () => ({ output: 'two', isError: false }) }),
      ],
      undefined, undefined, undefined,
      {
        turnNumber: 1,
        callIds: new Map([['one', 'call-one'], ['two', 'call-two']]),
        onToolLifecycle: (event) => events.push(event),
      },
    )

    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({ type: 'tool_started', callId: 'call-one' })
    first.resolve({ output: 'one', isError: false })
    await running
    expect(events.map((event) => `${event.type}:${event.callId}`)).toEqual([
      'tool_started:call-one', 'tool_finished:call-one',
      'tool_started:call-two', 'tool_finished:call-two',
    ])
  })

  it('emits one failed finish when permission rejects a call', async () => {
    const events: EngineToolLifecycleEvent[] = []
    const results = await executeToolBatches(
      [{ parallel: false, blocks: [makeBlock('write_file', 'denied')] }],
      tools,
      undefined,
      { mode: 'denyList', toolNames: ['write_file'] },
      undefined,
      {
        turnNumber: 1,
        callIds: new Map([['denied', 'call-denied']]),
        onToolLifecycle: (event) => events.push(event),
      },
    )

    expect(results[0]).toMatchObject({ tool_use_id: 'denied', is_error: true })
    expect(events.map((event) => event.type)).toEqual(['tool_started', 'tool_finished'])
    expect(events[1]).toMatchObject({ callId: 'call-denied', isError: true })
  })

  it.each([
    ['permission callback', { permission: { mode: 'bypass' as const, checkPermission: async () => { throw new Error('permission failed') } } }],
    ['pre-hook matching', { hooks: { registry: { getMatching: () => { throw new Error('hook failed') } }, context: { workingDirectory: '/tmp' } } }],
  ])('emits one failed finish before a %s error is rethrown', async (_label, setup) => {
    const events: EngineToolLifecycleEvent[] = []
    const running = executeToolBatches(
      [{ parallel: false, blocks: [makeBlock('write_file', 'throws')] }],
      tools,
      undefined,
      setup.permission,
      setup.hooks as never,
      {
        turnNumber: 1,
        callIds: new Map([['throws', 'call-throws']]),
        onToolLifecycle: (event) => events.push(event),
      },
    )

    await expect(running).rejects.toThrow(/failed/)
    expect(events.map((event) => event.type)).toEqual(['tool_started', 'tool_finished'])
    expect(events[1]).toMatchObject({ callId: 'call-throws', isError: true })
  })

  it('observer failure does not change the tool result or repeat the side effect', async () => {
    const call = vi.fn(async () => ({ output: 'done', isError: false }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const results = await executeToolBatches(
        [{ parallel: false, blocks: [makeBlock('observed', 'provider-call')] }],
        [defineTool({ name: 'observed', description: '', inputSchema: {}, call })],
        undefined, undefined, undefined,
        {
          turnNumber: 1,
          callIds: new Map([['provider-call', 'engine-call']]),
          onToolLifecycle: () => { throw new Error('trace unavailable') },
        },
      )

      expect(call).toHaveBeenCalledOnce()
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({ tool_use_id: 'provider-call', is_error: false })
      expect(results[0].content).toContain('done')
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('parallel read-only tools execute concurrently (verified by timing)', async () => {
    const batches = [
      {
        parallel: true,
        blocks: [
          makeBlock('slow_read', 'a'),
          makeBlock('fast_read', 'b'),
        ],
      },
    ]

    const start = Date.now()
    const results = await executeToolBatches(batches, tools)
    const elapsed = Date.now() - start

    // If sequential, would take >=60ms. Parallel should be ~50ms.
    expect(elapsed).toBeLessThan(80)
    expect(results).toHaveLength(2)
    expect(results[0].content).toContain('slow_done')
    expect(results[1].content).toContain('fast_done')
  })

  it('results in original order regardless of completion order', async () => {
    const batches = [
      {
        parallel: true,
        blocks: [
          makeBlock('slow_read', 'first'),
          makeBlock('fast_read', 'second'),
        ],
      },
    ]

    const results = await executeToolBatches(batches, tools)

    // slow_read finishes after fast_read, but should be first in results
    expect(results[0].tool_use_id).toBe('first')
    expect(results[0].content).toContain('slow_done')
    expect(results[1].tool_use_id).toBe('second')
    expect(results[1].content).toContain('fast_done')
  })

  it('serial write tools execute sequentially', async () => {
    const order: string[] = []

    const seqToolA = defineTool({
      name: 'seq_a',
      description: 'A',
      inputSchema: {},
      isReadOnly: false,
      call: async () => {
        order.push('a_start')
        await delay(20)
        order.push('a_end')
        return { output: 'a', isError: false }
      },
    })

    const seqToolB = defineTool({
      name: 'seq_b',
      description: 'B',
      inputSchema: {},
      isReadOnly: false,
      call: async () => {
        order.push('b_start')
        await delay(10)
        order.push('b_end')
        return { output: 'b', isError: false }
      },
    })

    const seqTools = [seqToolA, seqToolB]

    // Two serial batches (each with parallel=false)
    const batches = [
      { parallel: false, blocks: [makeBlock('seq_a', 'id-a')] },
      { parallel: false, blocks: [makeBlock('seq_b', 'id-b')] },
    ]

    const results = await executeToolBatches(batches, seqTools)

    expect(order).toEqual(['a_start', 'a_end', 'b_start', 'b_end'])
    expect(results).toHaveLength(2)
    expect(results[0].tool_use_id).toBe('id-a')
    expect(results[1].tool_use_id).toBe('id-b')
  })

  it('tool error returns error result without aborting batch', async () => {
    const batches = [
      {
        parallel: true,
        blocks: [
          makeBlock('error_tool', 'err1'),
          makeBlock('fast_read', 'ok1'),
        ],
      },
    ]

    const results = await executeToolBatches(batches, tools)

    expect(results).toHaveLength(2)

    const errResult = results.find((r) => r.tool_use_id === 'err1')!
    expect(errResult.is_error).toBe(true)
    expect(errResult.content).toContain('Tool execution error:')
    expect(errResult.content).toContain('Something broke')

    const okResult = results.find((r) => r.tool_use_id === 'ok1')!
    expect(okResult.is_error).toBe(false)
    expect(okResult.content).toContain('fast_done')
  })

  it('unknown tool returns error result', async () => {
    const batches = [
      {
        parallel: false,
        blocks: [makeBlock('nonexistent_tool', 'unk1')],
      },
    ]

    const results = await executeToolBatches(batches, tools)

    expect(results).toHaveLength(1)
    expect(results[0].is_error).toBe(true)
    expect(results[0].content).toContain('Tool not found: nonexistent_tool')
  })

  it('caps oversized tool output at 100KB to protect LLM context', async () => {
    // 模拟一个忘记自截断的工具（如 MCP server 直接返回大文件）
    const hugeOutputTool = defineTool({
      name: 'huge_output',
      description: 'Returns a 1MB string',
      inputSchema: {},
      isReadOnly: true,
      call: async () => ({ output: 'x'.repeat(1_000_000), isError: false }),
    })

    const batches = [
      { parallel: false, blocks: [makeBlock('huge_output', 'big1')] },
    ]
    const results = await executeToolBatches(batches, [hugeOutputTool])

    expect(results).toHaveLength(1)
    // stamp 加了时间戳头部，留余量
    expect(Buffer.byteLength(results[0].content, 'utf8')).toBeLessThan(102_000)
    expect(results[0].content).toContain('orchestration: tool output truncated')
    expect(results[0].content).toContain('1000000 bytes') // 原始字节数
    // 截断标记提示用分页参数收窄
    expect(results[0].content).toContain('分页参数')
  })

  it('does not modify normal-sized tool output', async () => {
    const normalTool = defineTool({
      name: 'normal',
      description: 'Returns a small string',
      inputSchema: {},
      isReadOnly: true,
      call: async () => ({ output: 'small output', isError: false }),
    })

    const batches = [
      { parallel: false, blocks: [makeBlock('normal', 'small1')] },
    ]
    const results = await executeToolBatches(batches, [normalTool])

    expect(results[0].content).toContain('small output')
    expect(results[0].content).not.toContain('truncated')
  })
})
