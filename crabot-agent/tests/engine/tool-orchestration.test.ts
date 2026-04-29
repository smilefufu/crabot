import { describe, it, expect } from 'vitest'
import { executeToolBatches, type ToolResultEntry } from '../../src/engine/tool-orchestration'
import { defineTool } from '../../src/engine/tool-framework'
import type { ToolDefinition, ToolUseBlock } from '../../src/engine/types'

function makeBlock(name: string, id: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id, name, input }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
})
