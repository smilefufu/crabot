import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ContextAssembler } from '../../src/orchestration/context-assembler.js'
import type { OrchestrationConfig, MemoryPermissions } from '../../src/types.js'

function createMockRpcClient() {
  return {
    call: vi.fn(),
    resolve: vi.fn(),
    publishEvent: vi.fn().mockResolvedValue(0),
    registerModuleDefinition: vi.fn().mockResolvedValue({}),
    startModule: vi.fn().mockResolvedValue({}),
  }
}

const defaultMemoryPermissions: MemoryPermissions = {
  write_visibility: 'private',
  write_scopes: [],
  read_min_visibility: 'private',
  read_accessible_scopes: undefined,
}

const defaultConfig: OrchestrationConfig = {
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
    // Use 'admin-web' channel so fetchRecentMessages goes through the admin RPC path
    // (call get_chat_history directly) instead of the channel resolve path.
    const messages = [
      {
        platform_message_id: 'm1',
        session: { session_id: 'session-1', channel_id: 'admin-web', type: 'private' },
        sender: { friend_id: 'friend-1', platform_user_id: 'u1', platform_display_name: 'Test User' },
        content: { type: 'text', text: 'hi' },
        features: { is_mention_crab: false },
        platform_timestamp: '2026-01-01T00:00:00Z',
      },
    ]
    const shortMem = [{ memory_id: 'mem1', content: 'fact', timestamp: '2026-01-01T00:00:00Z' }]
    const longMem = [{ memory_id: 'mem2', content: 'old fact', timestamp: '2025-01-01T00:00:00Z' }]

    // Call order: get_chat_history, search_short_term, search_long_term
    mockRpc.call
      .mockResolvedValueOnce({ messages })
      .mockResolvedValueOnce({ results: shortMem })
      .mockResolvedValueOnce({ results: longMem.map(m => ({ memory: m, relevance: 1.0 })) })

    // Resolve order: admin (module_type), memory (module_type), channel (module_type)
    mockRpc.resolve
      .mockResolvedValueOnce([{ module_id: 'admin', port: 19100 }])
      .mockResolvedValueOnce([{ module_id: 'memory', port: 19200 }])
      .mockResolvedValueOnce([{ module_id: 'channel-web', port: 19500 }])

    const ctx = await assembler.assembleWorkerContext({
      channel_id: 'admin-web',
      session_id: 'session-1',
      sender_id: 'user-1',
      message: 'hello',
      friend_id: 'friend-1',
    }, defaultMemoryPermissions)

    expect(ctx.task_origin?.channel_id).toBe('admin-web')
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
    }, defaultMemoryPermissions)

    expect(ctx.recent_messages).toEqual([])
    expect(ctx.short_term_memories).toEqual([])
    expect(ctx.long_term_memories).toEqual([])
  })

  it('should skip memory fetch if no friend_id', async () => {
    // Use admin-web so fetchRecentMessages uses rpcClient.call (get_chat_history)
    mockRpc.call.mockResolvedValueOnce({ messages: [] })
    mockRpc.resolve
      .mockResolvedValueOnce([{ module_id: 'admin', port: 19100 }])
      .mockResolvedValueOnce([{ module_id: 'memory', port: 19200 }])
      .mockResolvedValueOnce([])

    const ctx = await assembler.assembleWorkerContext({
      channel_id: 'admin-web',
      session_id: 'session-1',
      sender_id: 'user-1',
      message: 'hello',
    }, defaultMemoryPermissions)

    expect(ctx.short_term_memories).toEqual([])
    expect(ctx.long_term_memories).toEqual([])
    // 只调用了 get_chat_history，没有调用 query_memory（因为没有 friend_id）
    expect(mockRpc.call).toHaveBeenCalledTimes(1)
  })

  it('should assemble front context with sender friend', async () => {
    // Use admin-web so fetchRecentMessages uses the direct call path
    const messages = [
      {
        platform_message_id: 'm1',
        session: { session_id: 'session-1', channel_id: 'admin-web', type: 'private' },
        sender: { friend_id: 'friend-1', platform_user_id: 'u1', platform_display_name: 'Test User' },
        content: { type: 'text', text: 'hi' },
        features: { is_mention_crab: false },
        platform_timestamp: '2026-01-01T00:00:00Z',
      },
    ]
    const shortMem = [{ memory_id: 'mem1', content: 'fact', timestamp: '2026-01-01T00:00:00Z' }]
    // Raw admin API format (id, type — before mapping by fetchActiveTasks)
    const rawActiveTasks = [{ id: 't1', title: 'test', status: 'pending', priority: 'normal', source: {} }]
    const mappedActiveTasks = [{ task_id: 't1', title: 'test', status: 'pending', priority: 'normal', plan_summary: undefined, source_channel_id: undefined, source_session_id: undefined, latest_progress: undefined }]

    // Call order: get_chat_history, search_short_term, list_tasks
    mockRpc.call
      .mockResolvedValueOnce({ messages })
      .mockResolvedValueOnce({ results: shortMem })
      .mockResolvedValueOnce({ items: rawActiveTasks })

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
        channel_id: 'admin-web',
        session_id: 'session-1',
        sender_id: 'user-1',
        message: 'hello',
        friend_id: 'friend-1',
      },
      friend,
      defaultMemoryPermissions
    )

    expect(ctx.sender_friend).toEqual(friend)
    expect(ctx.recent_messages).toEqual(messages)
    expect(ctx.short_term_memories).toEqual(shortMem)
    expect(ctx.active_tasks).toEqual(mappedActiveTasks)
    expect(ctx.available_tools).toEqual([])
  })
})