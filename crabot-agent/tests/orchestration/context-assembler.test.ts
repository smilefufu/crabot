import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ContextAssembler } from '../../src/orchestration/context-assembler.js'
import type { FlowConfig } from '../../src/types.js'

function createMockRpcClient() {
  return {
    call: vi.fn(),
    resolve: vi.fn(),
    publishEvent: vi.fn().mockResolvedValue(0),
    registerModuleDefinition: vi.fn().mockResolvedValue({}),
    startModule: vi.fn().mockResolvedValue({}),
  }
}

const defaultConfig: FlowConfig = {
  admin_config_path: '',
  front_context_recent_messages_limit: 20,
  front_context_memory_limit: 10,
  worker_recent_messages_limit: 50,
  worker_short_term_memory_limit: 20,
  worker_long_term_memory_limit: 20,
  front_agent_timeout: 30,
  session_state_ttl: 300,
  worker_config_refresh_interval: 60,
  front_agent_queue_max_length: 10,
  front_agent_queue_timeout: 60,
}

describe('ContextAssembler', () => {
  let assembler: ContextAssembler
  let mockRpc: ReturnType<typeof createMockRpcClient>

  beforeEach(() => {
    mockRpc = createMockRpcClient()
    assembler = new ContextAssembler(
      mockRpc as any,
      'flow-default',
      defaultConfig,
      () => 19100,
      () => 19200
    )
  })

  it('should assemble worker context with all data', async () => {
    const messages = [{ message_id: 'm1', sender_id: 'u1', content: 'hi', timestamp: '2026-01-01T00:00:00Z' }]
    const shortMem = [{ memory_id: 'mem1', content: 'fact', timestamp: '2026-01-01T00:00:00Z' }]
    const longMem = [{ memory_id: 'mem2', content: 'old fact', timestamp: '2025-01-01T00:00:00Z' }]

    mockRpc.call
      .mockResolvedValueOnce({ messages })
      .mockResolvedValueOnce({ items: shortMem })
      .mockResolvedValueOnce({ items: longMem })

    mockRpc.resolve
      .mockResolvedValueOnce([{ module_id: 'admin', port: 19100 }])
      .mockResolvedValueOnce([{ module_id: 'memory', port: 19200 }])
      .mockResolvedValueOnce([{ module_id: 'channel-web', port: 19500 }])

    const ctx = await assembler.assembleWorkerContext({
      channel_id: 'ch-1',
      session_id: 'session-1',
      sender_id: 'user-1',
      message: 'hello',
      friend_id: 'friend-1',
    })

    expect(ctx.task_origin?.channel_id).toBe('ch-1')
    expect(ctx.task_origin?.session_id).toBe('session-1')
    expect(ctx.task_origin?.friend_id).toBe('friend-1')
    expect(ctx.recent_messages).toEqual(messages)
    expect(ctx.short_term_memories).toEqual(shortMem)
    expect(ctx.long_term_memories).toEqual(longMem)
    expect(ctx.admin_endpoint).toEqual({ module_id: 'admin', port: 19100 })
    expect(ctx.memory_endpoint).toEqual({ module_id: 'memory', port: 19200 })
    expect(ctx.channel_endpoints).toEqual([{ module_id: 'channel-web', port: 19500 }])
  })

  it('should return empty arrays on failure', async () => {
    mockRpc.call.mockRejectedValue(new Error('timeout'))
    mockRpc.resolve.mockRejectedValue(new Error('timeout'))

    const ctx = await assembler.assembleWorkerContext({
      channel_id: 'ch-1',
      session_id: 'session-1',
      sender_id: 'user-1',
      message: 'hello',
    })

    expect(ctx.recent_messages).toEqual([])
    expect(ctx.short_term_memories).toEqual([])
    expect(ctx.long_term_memories).toEqual([])
  })

  it('should skip memory fetch if no friend_id', async () => {
    mockRpc.call.mockResolvedValueOnce({ messages: [] })
    mockRpc.resolve
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    const ctx = await assembler.assembleWorkerContext({
      channel_id: 'ch-1',
      session_id: 'session-1',
      sender_id: 'user-1',
      message: 'hello',
    })

    expect(ctx.short_term_memories).toEqual([])
    expect(ctx.long_term_memories).toEqual([])
    // 只调用了 get_chat_history，没有调用 query_memory
    expect(mockRpc.call).toHaveBeenCalledTimes(1)
  })

  it('should assemble front context with sender friend', async () => {
    const messages = [{ message_id: 'm1', sender_id: 'u1', content: 'hi', timestamp: '2026-01-01T00:00:00Z' }]
    const shortMem = [{ memory_id: 'mem1', content: 'fact', timestamp: '2026-01-01T00:00:00Z' }]
    const activeTasks = [{ task_id: 't1', title: 'test', status: 'pending', task_type: 'user_request', priority: 'normal' }]

    mockRpc.call
      .mockResolvedValueOnce({ messages })
      .mockResolvedValueOnce({ items: shortMem })
      .mockResolvedValueOnce({ items: activeTasks })

    const friend = {
      id: 'friend-1',
      display_name: 'Test User',
      permission: 'master' as const,
      channel_identities: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }

    const ctx = await assembler.assembleFrontContext(
      {
        channel_id: 'ch-1',
        session_id: 'session-1',
        sender_id: 'user-1',
        message: 'hello',
        friend_id: 'friend-1',
      },
      friend
    )

    expect(ctx.sender_friend).toEqual(friend)
    expect(ctx.recent_messages).toEqual(messages)
    expect(ctx.short_term_memories).toEqual(shortMem)
    expect(ctx.active_tasks).toEqual(activeTasks)
    expect(ctx.available_tools).toEqual([])
  })
})