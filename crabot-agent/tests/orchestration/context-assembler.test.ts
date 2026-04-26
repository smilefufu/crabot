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
    const longMem = [{ id: 'mem2', type: 'fact', status: 'confirmed', brief: 'old fact' }]

    // Call order: get_chat_history, search_short_term, search_long_term
    // v2 search_long_term returns { results: LongTermMemoryRef[] } directly (no { memory, relevance } wrapper)
    mockRpc.call
      .mockResolvedValueOnce({ messages })
      .mockResolvedValueOnce({ results: shortMem })
      .mockResolvedValueOnce({ results: longMem })

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
    // scene_profile 的 get_scene_profile 调用即便无 mock 也会被内部 try/catch 吞掉，不影响断言
    mockRpc.call.mockImplementation((_port, method) => {
      if (method === 'get_chat_history') return Promise.resolve({ messages: [] })
      if (method === 'get_scene_profile') return Promise.resolve({ profile: null })
      return Promise.reject(new Error(`unexpected call: ${method}`))
    })
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
    // 没有调用 search_short_term / search_long_term（因为没有 friend_id）
    const calledMethods = mockRpc.call.mock.calls.map((c) => c[1])
    expect(calledMethods).not.toContain('search_short_term')
    expect(calledMethods).not.toContain('search_long_term')
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

  it('loads only the current group scene profile for worker context', async () => {
    const groupProfile = {
      scene: { type: 'group_session', channel_id: 'admin-web', session_id: 'session-1' },
      label: '开发群',
      abstract: '群画像',
      overview: '只处理当前群上下文',
      content: '这里是当前群必须遵守的规则。',
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    }

    mockRpc.call.mockImplementation((_port, method, args) => {
      if (method === 'get_chat_history') return Promise.resolve({ messages: [] })
      if (method === 'search_short_term') return Promise.resolve({ results: [] })
      if (method === 'search_long_term') return Promise.resolve({ results: [] })
      if (method === 'get_scene_profile') {
        expect(args).toEqual({
          scene: { type: 'group_session', channel_id: 'admin-web', session_id: 'session-1' },
        })
        return Promise.resolve({ profile: groupProfile })
      }
      throw new Error(`unexpected call: ${String(method)}`)
    })

    mockRpc.resolve
      .mockResolvedValueOnce([{ module_id: 'admin', port: 19100 }])
      .mockResolvedValueOnce([{ module_id: 'memory', port: 19200 }])
      .mockResolvedValueOnce([])

    const ctx = await assembler.assembleWorkerContext({
      channel_id: 'admin-web',
      session_id: 'session-1',
      sender_id: 'user-1',
      message: 'hello',
      friend_id: 'friend-1',
      session_type: 'group',
    }, defaultMemoryPermissions)

    expect(ctx.scene_profile).toEqual({
      label: '开发群',
      abstract: '群画像',
      overview: '只处理当前群上下文',
      content: '这里是当前群必须遵守的规则。',
      source: {
        scene: { type: 'group_session', channel_id: 'admin-web', session_id: 'session-1' },
      },
    })

    const getSceneCalls = mockRpc.call.mock.calls.filter(([, method]) => method === 'get_scene_profile')
    expect(getSceneCalls).toHaveLength(1)
  })

  it('loads only the current private scene profile for front context', async () => {
    const friend = {
      id: 'friend-1',
      display_name: 'Test User',
      permission: 'master' as const,
      channel_identities: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
    const friendProfile = {
      scene: { type: 'friend', friend_id: 'friend-1' },
      label: 'Test User',
      abstract: '私聊画像',
      overview: '仅当前私聊可见',
      content: '这里是当前私聊必须遵守的上下文。',
      created_at: '2026-04-20T00:00:00Z',
      updated_at: '2026-04-20T00:00:00Z',
    }

    mockRpc.call.mockImplementation((_port, method, args) => {
      if (method === 'get_chat_history') return Promise.resolve({ messages: [] })
      if (method === 'search_short_term') return Promise.resolve({ results: [] })
      if (method === 'list_tasks') return Promise.resolve({ items: [] })
      if (method === 'get_scene_profile') {
        expect(args).toEqual({
          scene: { type: 'friend', friend_id: 'friend-1' },
        })
        return Promise.resolve({ profile: friendProfile })
      }
      throw new Error(`unexpected call: ${String(method)}`)
    })

    const ctx = await assembler.assembleFrontContext(
      {
        channel_id: 'admin-web',
        session_id: 'session-1',
        sender_id: 'user-1',
        message: 'hello',
        friend_id: 'friend-1',
        session_type: 'private',
      },
      friend,
      defaultMemoryPermissions,
    )

    expect(ctx.scene_profile).toEqual({
      label: 'Test User',
      abstract: '私聊画像',
      overview: '仅当前私聊可见',
      content: '这里是当前私聊必须遵守的上下文。',
      source: {
        scene: { type: 'friend', friend_id: 'friend-1' },
      },
    })

    const getSceneCalls = mockRpc.call.mock.calls.filter(([, method]) => method === 'get_scene_profile')
    expect(getSceneCalls).toHaveLength(1)
  })
})
