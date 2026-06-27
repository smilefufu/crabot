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
  front_context_recent_messages_window_hours: 6,
  front_context_recent_messages_max_cap: 50,
  front_context_short_term_memory_window_hours: 12,
  front_context_short_term_memory_max_cap: 30,
  worker_recent_messages_window_hours: 4,
  worker_recent_messages_max_cap: 50,
  worker_short_term_memory_window_hours: 12,
  worker_short_term_memory_max_cap: 30,
  worker_long_term_memory_limit: 20,
  front_agent_timeout: 30,
  session_state_ttl: 300,
  worker_config_refresh_interval: 60,
  front_agent_queue_max_length: 10,
  front_agent_queue_timeout: 60,
}

// 时窗内的时间戳（早于 now 1 秒），保证测试 fixture 不被 since-filter 排除。
// 单独抽出来是因为 fetchRecentMessages 用 Date.now() 算 since，固定 ISO（如 '2026-01-01'）会被裁掉。
const recentTs = () => new Date(Date.now() - 1000).toISOString()

describe('ContextAssembler', () => {
  let assembler: ContextAssembler
  let mockRpc: ReturnType<typeof createMockRpcClient>

  beforeEach(() => {
    mockRpc = createMockRpcClient()
    assembler = new ContextAssembler({
      rpcClient: mockRpc as any,
      moduleId: 'flow-default',
      config: defaultConfig,
      getAdminPort: () => 19100,
      getMemoryPort: () => 19200,
    })
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
        platform_timestamp: recentTs(),
      },
    ]
    const shortMem = [{ memory_id: 'mem1', content: 'fact', timestamp: '2026-01-01T00:00:00Z' }]

    // worker context 不再预 fetch long_term：长期记忆改由 worker 用 search_long_term tool 按需查。
    // Call order: get_chat_history, search_short_term
    mockRpc.call
      .mockResolvedValueOnce({ messages })
      .mockResolvedValueOnce({ results: shortMem })

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
    expect(ctx.long_term_memories).toEqual([])  // 不再预 fetch，永远空数组
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
        platform_timestamp: recentTs(),
      },
    ]
    // Raw admin API format (id, type — before mapping by fetchActiveTasks)
    const rawActiveTasks = [{ id: 't1', title: 'test', status: 'pending', priority: 'normal', source: {} }]
    const mappedActiveTasks = [{ task_id: 't1', title: 'test', status: 'pending', priority: 'normal', plan_summary: undefined, source_channel_id: undefined, source_session_id: undefined, latest_progress: undefined }]

    // 2026-05-14：Front 短期记忆改按需查，assembleFrontContext 不再调 search_short_term。调用顺序剩 2 个：get_chat_history, list_tasks
    mockRpc.call
      .mockResolvedValueOnce({ messages })
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
    // 2026-05-14：Front 短期记忆改按需查，assembleFrontContext 不再 fetch；始终返回空数组
    expect(ctx.short_term_memories).toEqual([])
    expect(ctx.active_tasks).toEqual(mappedActiveTasks)
    expect(ctx.available_tools).toEqual([])
  })

  it('loads only the current group scene profile for worker context', async () => {
    const groupProfile = {
      scene: { type: 'group_session', channel_id: 'admin-web', session_id: 'session-1' },
      label: '开发群',
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
      content: '这里是当前私聊必须遵守的上下文。',
      source: {
        scene: { type: 'friend', friend_id: 'friend-1' },
      },
    })

    const getSceneCalls = mockRpc.call.mock.calls.filter(([, method]) => method === 'get_scene_profile')
    expect(getSceneCalls).toHaveLength(1)
  })

  it('inbound slash 原文透传，老裸 hint 加前缀，普通文本不变', async () => {
    // 新方案（spec 2026-05-25 §7.1）：
    // - inbound slash（/认主）字面原文透传，靠 SLASH_AWARENESS_GUIDANCE prompt 教化不模仿
    // - 老版裸 outbound hint 由 compatLegacyClaimHint 读时兜底加 [系统响应 /认主] 前缀
    // - 普通文本原样
    const LEGACY_HINT = '渠道未认主，请输入"/认主"，然后到 crabot 后台 对话对象->申请队列 中进行审批创建 Master 后方可正常对话。'
    const messages = [
      {
        platform_message_id: 'm1',
        session: { session_id: 'session-1', channel_id: 'admin-web', type: 'private' },
        sender: { friend_id: 'friend-1', platform_user_id: 'u1', platform_display_name: 'Stranger' },
        content: { type: 'text', text: '/认主' },
        features: { is_mention_crab: false },
        platform_timestamp: new Date(Date.now() - 3000).toISOString(),
      },
      {
        platform_message_id: 'm2',
        session: { session_id: 'session-1', channel_id: 'admin-web', type: 'private' },
        sender: { platform_user_id: 'self', platform_display_name: 'Crabot' },
        content: {
          type: 'text',
          text: LEGACY_HINT,
        },
        features: { is_mention_crab: false },
        platform_timestamp: new Date(Date.now() - 2000).toISOString(),
      },
      {
        platform_message_id: 'm3',
        session: { session_id: 'session-1', channel_id: 'admin-web', type: 'private' },
        sender: { friend_id: 'friend-1', platform_user_id: 'u1', platform_display_name: 'Stranger' },
        content: { type: 'text', text: 'hi' },
        features: { is_mention_crab: false },
        platform_timestamp: new Date(Date.now() - 1000).toISOString(),
      },
    ]

    mockRpc.call.mockImplementation((_port, method) => {
      if (method === 'get_chat_history') return Promise.resolve({ messages })
      if (method === 'search_short_term') return Promise.resolve({ results: [] })
      if (method === 'list_tasks') return Promise.resolve({ items: [] })
      if (method === 'get_scene_profile') return Promise.resolve({ profile: null })
      throw new Error(`unexpected call: ${String(method)}`)
    })

    const friend = {
      id: 'friend-1',
      display_name: 'Stranger',
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
        message: 'hi',
        friend_id: 'friend-1',
        session_type: 'private',
      },
      friend,
      defaultMemoryPermissions,
    )

    // 三条消息全部透传（不再硬 drop）
    expect(ctx.recent_messages).toHaveLength(3)
    // m1: inbound /认主 原文透传
    expect(ctx.recent_messages[0].platform_message_id).toBe('m1')
    if (ctx.recent_messages[0].content.type === 'text') {
      expect(ctx.recent_messages[0].content.text).toBe('/认主')
    }
    // m2: 老裸 hint → 加前缀
    expect(ctx.recent_messages[1].platform_message_id).toBe('m2')
    if (ctx.recent_messages[1].content.type === 'text') {
      expect(ctx.recent_messages[1].content.text!.startsWith('[系统响应 /认主]\n')).toBe(true)
      expect(ctx.recent_messages[1].content.text!.includes(LEGACY_HINT)).toBe(true)
    }
    // m3: 普通文本原样
    expect(ctx.recent_messages[2].platform_message_id).toBe('m3')
  })

  describe('fetchShortTermMemory — channel+session 排除（B.1）', () => {
    it('Front 上下文中过滤掉 source.channel_id + session_id 与当前一致的短期记忆条目', async () => {
      const memoryResults = [
        {
          id: 'm1',
          content: 'cur-session-event',
          event_time: '2026-05-10T00:00:00Z',
          keywords: [],
          persons: [],
          entities: [],
          compressed: false,
          visibility: 'public',
          scopes: [],
          created_at: '2026-05-10T00:00:00Z',
          source: { type: 'triage', channel_id: 'tg-001', session_id: 'sess-A' },
        },
        {
          id: 'm2',
          content: 'other-session-event',
          event_time: '2026-05-10T00:00:00Z',
          keywords: [],
          persons: [],
          entities: [],
          compressed: false,
          visibility: 'public',
          scopes: [],
          created_at: '2026-05-10T00:00:00Z',
          source: { type: 'triage', channel_id: 'tg-001', session_id: 'sess-B' },
        },
        {
          id: 'm3',
          content: 'other-channel-event',
          event_time: '2026-05-10T00:00:00Z',
          keywords: [],
          persons: [],
          entities: [],
          compressed: false,
          visibility: 'public',
          scopes: [],
          created_at: '2026-05-10T00:00:00Z',
          source: { type: 'triage', channel_id: 'wx-001', session_id: 'sess-A' },
        },
      ]

      const friend = {
        id: 'friend-1',
        display_name: 'Test User',
        permission: 'master' as const,
        channel_identities: [],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }

      mockRpc.call.mockImplementation((_port, method) => {
        if (method === 'get_chat_history') return Promise.resolve({ messages: [] })
        if (method === 'search_short_term') return Promise.resolve({ results: memoryResults })
        if (method === 'list_tasks') return Promise.resolve({ items: [] })
        if (method === 'get_scene_profile') return Promise.resolve({ profile: null })
        throw new Error(`unexpected call: ${String(method)}`)
      })

      const ctx = await assembler.assembleFrontContext(
        {
          channel_id: 'tg-001',
          session_id: 'sess-A',
          sender_id: 'user-1',
          message: 'hello',
          friend_id: 'friend-1',
          session_type: 'private',
        },
        friend,
        defaultMemoryPermissions,
      )

      // 2026-05-14：Front 短期记忆改按需查，assembleFrontContext 不再 fetch；始终为空
      // 此 case 原本验证 channel+session 排除逻辑——现在该逻辑挪到 search_short_term 工具内的 ctx，由 worker/Front 调工具时按当前 channel/session 过滤
      expect(ctx.short_term_memories).toEqual([])
    })

    it('Worker 上下文不应用 channel+session 排除', async () => {
      const memoryResults = [
        {
          id: 'm1',
          content: 'cur-session-event',
          event_time: '2026-05-10T00:00:00Z',
          keywords: [],
          persons: [],
          entities: [],
          compressed: false,
          visibility: 'public',
          scopes: [],
          created_at: '2026-05-10T00:00:00Z',
          source: { type: 'triage', channel_id: 'tg-001', session_id: 'sess-A' },
        },
        {
          id: 'm2',
          content: 'other-session-event',
          event_time: '2026-05-10T00:00:00Z',
          keywords: [],
          persons: [],
          entities: [],
          compressed: false,
          visibility: 'public',
          scopes: [],
          created_at: '2026-05-10T00:00:00Z',
          source: { type: 'triage', channel_id: 'tg-001', session_id: 'sess-B' },
        },
      ]

      mockRpc.call.mockImplementation((_port, method) => {
        if (method === 'get_chat_history') return Promise.resolve({ messages: [] })
        if (method === 'search_short_term') return Promise.resolve({ results: memoryResults })
        if (method === 'get_scene_profile') return Promise.resolve({ profile: null })
        throw new Error(`unexpected call: ${String(method)}`)
      })

      mockRpc.resolve
        .mockResolvedValueOnce([{ module_id: 'admin', port: 19100 }])
        .mockResolvedValueOnce([{ module_id: 'memory', port: 19200 }])
        .mockResolvedValueOnce([])

      const ctx = await assembler.assembleWorkerContext(
        {
          channel_id: 'tg-001',
          session_id: 'sess-A',
          sender_id: 'user-1',
          message: 'hello',
          friend_id: 'friend-1',
          session_type: 'private',
        },
        defaultMemoryPermissions,
      )

      // Worker 不应过滤，两条都应保留
      expect(ctx.short_term_memories.map((m) => m.id)).toEqual(['m1', 'm2'])
    })
  })
})
