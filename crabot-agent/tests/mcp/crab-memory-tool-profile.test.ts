import { describe, expect, it, vi } from 'vitest'
import {
  CRAB_MEMORY_MANAGER_TOOL_NAMES,
  createCrabMemoryServer,
  type MemoryTaskContext,
} from '../../src/mcp/crab-memory.js'
import { mcpServerToToolDefinitions } from '../../src/agent/mcp-tool-bridge.js'
import { ConfigLoader } from '../../src/core/config-loader.js'

function makeMemoryTools(
  rpcCall = vi.fn().mockResolvedValue({}),
  context: Partial<MemoryTaskContext> = {},
) {
  const server = createCrabMemoryServer({
    rpcClient: { callSensitive: rpcCall } as never,
    moduleId: 'agent-test',
    getMemoryPort: async () => 3002,
  }, {
    accessContext: { actor_kind: 'conversation', memory_enabled: true },
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
  it('uses fresh host identity and write markers; memory=false stops already loaded tools', async () => {
    const bearer = vi.spyOn(ConfigLoader, 'getRuntimeBearer').mockReturnValue('runtime-header-only')
    const rpc = vi.fn().mockResolvedValue({ id: 'created', results: [] })
    let enabled = true
    const tools = makeMemoryTools(rpc, {
      accessContext: { actor_kind: 'master_private', memory_enabled: true },
      resolveContext: async () => ({ visibility: 'internal', scopes: ['current-source'], isMasterPrivate: false,
        accessContext: { actor_kind: 'conversation', memory_enabled: enabled, scene: { type: 'friend', friend_id: 'current-friend' } } }),
    })
    try {
      const capture = tools.find(tool => tool.name.endsWith('__quick_capture'))!
      await capture.call({ type: 'fact', brief: 'b', content: 'c' }, {} as never)
      expect(rpc).toHaveBeenCalledWith(3002, 'quick_capture', expect.objectContaining({
        visibility: 'internal', scopes: ['current-source'],
        access_context: { actor_kind: 'conversation', memory_enabled: true, scene: { type: 'friend', friend_id: 'current-friend' } },
      }), 'agent-test', { authorizationBearer: 'runtime-header-only' })
      expect(JSON.stringify(rpc.mock.calls[0][2])).not.toContain('runtime-header-only')
      enabled = false
      const result = await capture.call({ type: 'fact', brief: 'b', content: 'c' }, {} as never)
      expect(result.output).toContain('Memory is disabled')
      expect(rpc).toHaveBeenCalledTimes(1)
    } finally { bearer.mockRestore() }
  })

  it('native long-term search keeps shared knowledge across scopes', async () => {
    const rpc = vi.fn().mockResolvedValue({ results: [] })
    const search = makeMemoryTools(rpc, { scopes: ['current-scene'] }).find(tool => tool.name.endsWith('__search_long_term'))!
    await search.call({ query: 'other project' }, {} as never)
    expect(rpc.mock.calls[0][2]).not.toHaveProperty('accessible_scopes')
    expect(rpc.mock.calls[0][2]).toHaveProperty('access_context.actor_kind', 'conversation')
  })
  it('普通与 master-private context 均精确注册协议规定的 18 项', () => {
    const expected = [...CRAB_MEMORY_MANAGER_TOOL_NAMES].sort()
    expect(unprefixedNames().sort()).toEqual(expected)
    expect(unprefixedNames({ isMasterPrivate: true }).sort()).toEqual(expected)
  })

  it('run_maintenance 不属于 LLM 工具面', () => {
    expect(unprefixedNames()).not.toContain('run_maintenance')
  })

  it('list_entries 对模型公开既有排序选项，并将最早优先透传给 Memory', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ items: [], total: 0 })
    const tool = makeMemoryTools(rpcCall)
      .find((candidate) => candidate.name === 'mcp__crab-memory__list_entries')!

    expect(tool.inputSchema).toMatchObject({
      properties: {
        sort: { enum: ['ingestion_time_desc', 'ingestion_time_asc', 'event_time_desc'] },
      },
    })
    const result = await tool.call(
      { status: 'inbox', sort: 'ingestion_time_asc', limit: 20, offset: 0 },
      {} as never,
    )

    expect(result.isError).toBe(false)
    expect(rpcCall).toHaveBeenCalledWith(3002, 'list_entries', {
      status: 'inbox', sort: 'ingestion_time_asc', limit: 20, offset: 0,
      access_context: { actor_kind: 'conversation', memory_enabled: true },
    }, 'agent-test', expect.any(Object))
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
      expect.any(Object),
    )
  })
})
