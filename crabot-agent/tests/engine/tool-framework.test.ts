import { describe, it, expect } from 'vitest'
import { defineTool, findTool, partitionToolCalls } from '../../src/engine/tool-framework'
import type { ToolDefinition, ToolUseBlock } from '../../src/engine/types'

describe('defineTool', () => {
  it('creates tool with default isReadOnly=false', () => {
    const tool = defineTool({
      name: 'write_file',
      description: 'Writes a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      call: async () => ({ output: 'ok', isError: false }),
    })

    expect(tool.name).toBe('write_file')
    expect(tool.description).toBe('Writes a file')
    expect(tool.isReadOnly).toBe(false)
    expect(tool.inputSchema).toEqual({ type: 'object', properties: { path: { type: 'string' } } })
    expect(typeof tool.call).toBe('function')
  })

  it('creates read-only tool when isReadOnly=true', () => {
    const tool = defineTool({
      name: 'read_file',
      description: 'Reads a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      isReadOnly: true,
      call: async () => ({ output: 'contents', isError: false }),
    })

    expect(tool.name).toBe('read_file')
    expect(tool.isReadOnly).toBe(true)
  })
})

describe('findTool', () => {
  const tools: ReadonlyArray<ToolDefinition> = [
    defineTool({
      name: 'read_file',
      description: 'Reads a file',
      inputSchema: {},
      isReadOnly: true,
      call: async () => ({ output: '', isError: false }),
    }),
    defineTool({
      name: 'write_file',
      description: 'Writes a file',
      inputSchema: {},
      call: async () => ({ output: '', isError: false }),
    }),
  ]

  it('finds tool by name', () => {
    const found = findTool(tools, 'read_file')
    expect(found).toBeDefined()
    expect(found!.name).toBe('read_file')
  })

  it('returns undefined for unknown tool name', () => {
    const found = findTool(tools, 'delete_file')
    expect(found).toBeUndefined()
  })
})

describe('partitionToolCalls', () => {
  const readTool = defineTool({
    name: 'read_file',
    description: 'Reads',
    inputSchema: {},
    isReadOnly: true,
    call: async () => ({ output: '', isError: false }),
  })

  const writeTool = defineTool({
    name: 'write_file',
    description: 'Writes',
    inputSchema: {},
    isReadOnly: false,
    call: async () => ({ output: '', isError: false }),
  })

  const tools: ReadonlyArray<ToolDefinition> = [readTool, writeTool]

  function makeBlock(name: string, id?: string): ToolUseBlock {
    return {
      type: 'tool_use',
      id: id ?? `id-${name}`,
      name,
      input: {},
    }
  }

  it('groups consecutive read-only tools into one parallel batch', () => {
    const blocks = [makeBlock('read_file', 'r1'), makeBlock('read_file', 'r2')]
    const batches = partitionToolCalls(blocks, tools)

    expect(batches).toHaveLength(1)
    expect(batches[0].parallel).toBe(true)
    expect(batches[0].blocks).toHaveLength(2)
  })

  it('isolates write tool into serial batch', () => {
    const blocks = [makeBlock('write_file')]
    const batches = partitionToolCalls(blocks, tools)

    expect(batches).toHaveLength(1)
    expect(batches[0].parallel).toBe(false)
    expect(batches[0].blocks).toHaveLength(1)
  })

  it('splits mixed sequence [Read, Write, Read] into 3 batches', () => {
    const blocks = [
      makeBlock('read_file', 'r1'),
      makeBlock('write_file', 'w1'),
      makeBlock('read_file', 'r2'),
    ]
    const batches = partitionToolCalls(blocks, tools)

    expect(batches).toHaveLength(3)
    expect(batches[0].parallel).toBe(true)
    expect(batches[0].blocks).toHaveLength(1)
    expect(batches[1].parallel).toBe(false)
    expect(batches[1].blocks).toHaveLength(1)
    expect(batches[2].parallel).toBe(true)
    expect(batches[2].blocks).toHaveLength(1)
  })

  it('treats unknown tool as non-read-only (serial batch)', () => {
    const blocks = [makeBlock('unknown_tool')]
    const batches = partitionToolCalls(blocks, tools)

    expect(batches).toHaveLength(1)
    expect(batches[0].parallel).toBe(false)
    expect(batches[0].blocks).toHaveLength(1)
  })

  it('handles mixed sequence [Read, Read, Write, Read] as 3 batches', () => {
    const blocks = [
      makeBlock('read_file', 'r1'),
      makeBlock('read_file', 'r2'),
      makeBlock('write_file', 'w1'),
      makeBlock('read_file', 'r3'),
    ]
    const batches = partitionToolCalls(blocks, tools)

    expect(batches).toHaveLength(3)
    expect(batches[0].parallel).toBe(true)
    expect(batches[0].blocks).toHaveLength(2)
    expect(batches[1].parallel).toBe(false)
    expect(batches[1].blocks).toHaveLength(1)
    expect(batches[2].parallel).toBe(true)
    expect(batches[2].blocks).toHaveLength(1)
  })

  it('returns empty array for empty input', () => {
    const batches = partitionToolCalls([], tools)
    expect(batches).toHaveLength(0)
  })
})
