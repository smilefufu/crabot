import { describe, expect, it, vi } from 'vitest'
import {
  CRAB_MEMORY_MANAGER_TOOL_NAMES,
  createCrabMemoryServer,
  type MemoryTaskContext,
} from '../../src/mcp/crab-memory.js'
import { mcpServerToToolDefinitions } from '../../src/agent/mcp-tool-bridge.js'

function makeMemoryTools(
  rpcCall = vi.fn().mockResolvedValue({}),
  context: Partial<MemoryTaskContext> = {},
) {
  const server = createCrabMemoryServer({
    rpcClient: { call: rpcCall } as never,
    moduleId: 'agent-test',
    getMemoryPort: async () => 3002,
  }, {
    visibility: 'internal',
    scopes: [],
    isMasterPrivate: false,
    ...context,
  })
  return mcpServerToToolDefinitions(server, 'crab-memory')
}

function unprefixedNames(context: Partial<MemoryTaskContext> = {}): string[] {
  return makeMemoryTools(undefined, context)
    .map((tool) => tool.name.replace('mcp__crab-memory__', ''))
}

describe('crab-memory Manager 固定工具面', () => {
  it('普通与 master-private context 均精确注册协议规定的 18 项', () => {
    const expected = [...CRAB_MEMORY_MANAGER_TOOL_NAMES].sort()
    expect(unprefixedNames().sort()).toEqual(expected)
    expect(unprefixedNames({ isMasterPrivate: true }).sort()).toEqual(expected)
  })

  it('run_maintenance 不属于 LLM 工具面', () => {
    expect(unprefixedNames()).not.toContain('run_maintenance')
  })

  it('quick_capture 仍按既有契约透传 Memory RPC', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ id: 'mem_1', status: 'inbox' })
    const tool = makeMemoryTools(rpcCall)
      .find((candidate) => candidate.name === 'mcp__crab-memory__quick_capture')!

    const result = await tool.call(
      { type: 'lesson', brief: 'b', content: 'c' },
      {} as never,
    )

    expect(result.isError).toBe(false)
    expect(rpcCall).toHaveBeenCalledWith(
      3002,
      'quick_capture',
      expect.objectContaining({ type: 'lesson', brief: 'b', content: 'c' }),
      'agent-test',
    )
  })
})
