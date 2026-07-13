import { describe, it, expect, vi } from 'vitest'
import { buildMessagingTools } from '../../src/mcp/crab-messaging.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import type { Friend } from '../../src/types.js'

function makeMaster(channels: Array<{ channel_id: string; platform_user_id: string }>): Friend {
  return {
    id: 'master-friend',
    display_name: 'FuFu',
    permission: 'master',
    channel_identities: channels.map(c => ({
      channel_id: c.channel_id,
      platform_user_id: c.platform_user_id,
      platform_display_name: 'FuFu',
    })),
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

function findTool(tools: ReturnType<typeof buildMessagingTools>, name: string) {
  return tools.find(t => t.name === name)
}

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text)
}

describe('daily_reflection task messaging tool whitelist', () => {
  it('daily_reflection 任务只暴露 send_master_private + 只读分析工具', () => {
    const tools = buildMessagingTools({
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'worker',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: new HumanMessageQueue(),
        triggerType: 'scheduled',
        taskType: 'daily_reflection',
        hasGoal: () => false,
      }),
    })

    const names = tools.map(t => t.name).sort()
    expect(names).toEqual(['get_history', 'get_message', 'send_master_private'].sort())

    // 通用对外/查询类工具一律不暴露
    expect(findTool(tools, 'send_message')).toBeUndefined()
    expect(findTool(tools, 'send_private_message')).toBeUndefined()
    expect(findTool(tools, 'lookup_friend')).toBeUndefined()
    expect(findTool(tools, 'list_contacts')).toBeUndefined()
    expect(findTool(tools, 'list_groups')).toBeUndefined()
    expect(findTool(tools, 'list_sessions')).toBeUndefined()
  })

  it('其他 scheduled 任务（如 news_briefing 群推送）不受白名单影响，保留全部工具', () => {
    const tools = buildMessagingTools({
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'worker',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: new HumanMessageQueue(),
        triggerType: 'scheduled',
        taskType: 'news_briefing',
        hasGoal: () => false,
      }),
    })

    expect(findTool(tools, 'send_message')).toBeDefined()
    expect(findTool(tools, 'send_private_message')).toBeDefined()
    expect(findTool(tools, 'send_master_private')).toBeDefined()
    expect(findTool(tools, 'lookup_friend')).toBeDefined()
    expect(findTool(tools, 'list_groups')).toBeDefined()
    expect(findTool(tools, 'list_sessions')).toBeDefined()
  })

  it('无 task context 时不暴露 scheduled 私聊捷径', () => {
    const tools = buildMessagingTools({
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'front',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
    })

    expect(findTool(tools, 'send_message')).toBeDefined()
    expect(findTool(tools, 'send_private_message')).toBeUndefined()
    expect(findTool(tools, 'send_master_private')).toBeUndefined()
  })

  it('message task 只保留精确 send_message，不暴露 scheduled 私聊捷径', () => {
    const tools = buildMessagingTools({
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'worker',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: new HumanMessageQueue(),
        triggerType: 'message',
        taskType: 'daily_reflection',
        hasGoal: () => false,
      }),
    })

    expect(findTool(tools, 'send_message')).toBeDefined()
    expect(findTool(tools, 'send_private_message')).toBeUndefined()
    expect(findTool(tools, 'send_master_private')).toBeUndefined()
    expect(findTool(tools, 'lookup_friend')).toBeDefined()
    expect(findTool(tools, 'list_sessions')).toBeDefined()
  })
})

describe('scheduled-only shortcut runtime guard', () => {
  it.each(['send_private_message', 'send_master_private'] as const)(
    '%s 在构建后切到 message context 时拒绝且零 RPC',
    async (toolName) => {
      let triggerType: 'scheduled' | 'message' = 'scheduled'
      const rpcCall = vi.fn()
      const tools = buildMessagingTools({
        rpcClient: { call: rpcCall } as never,
        moduleId: 'worker',
        getAdminPort: async () => 19001,
        resolveChannelPort: async () => 19009,
        getTaskContext: () => ({
          taskId: 't1',
          humanQueue: new HumanMessageQueue(),
          triggerType,
          hasGoal: () => false,
        }),
      })
      const tool = findTool(tools, toolName)!

      triggerType = 'message'
      const result = await tool.handler(
        toolName === 'send_private_message'
          ? { friend_id: 'friend-1', content: 'hello' }
          : { content: 'hello' },
      )

      expect(result.isError).toBe(true)
      expect(parsePayload(result)).toMatchObject({
        error_code: 'SCHEDULED_ONLY_TOOL',
        error: `${toolName} is only available in scheduled tasks`,
      })
      expect(rpcCall).not.toHaveBeenCalled()
    },
  )
})

describe('send_master_private', () => {
  it('returns error when no master friend configured', async () => {
    const tools = buildMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port, method) => {
          if (method === 'find_master_friend') return { friend: null }
          throw new Error(`unexpected RPC: ${method}`)
        }),
      } as never,
      moduleId: 'worker',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: new HumanMessageQueue(),
        triggerType: 'scheduled',
        taskType: 'daily_reflection',
        hasGoal: () => false,
      }),
    })

    const tool = findTool(tools, 'send_master_private')!
    const result = await tool.handler({ content: '一行人话' })
    const payload = parsePayload(result)
    expect(payload.error).toMatch(/No master friend configured/)
  })

  it('sends via first available channel_identity when channel_id not specified', async () => {
    const master = makeMaster([
      { channel_id: 'feishu-001', platform_user_id: 'ou_x' },
      { channel_id: 'telegram-001', platform_user_id: 'tg_y' },
    ])
    const calls: Array<{ port: number; method: string; params: unknown }> = []

    const tools = buildMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (port, method, params) => {
          calls.push({ port, method, params })
          if (method === 'find_master_friend') return { friend: master }
          if (method === 'find_or_create_private_session') return { session: { id: 'sess-abc' }, created: true }
          if (method === 'send_message') return { platform_message_id: 'mid-1', sent_at: '2026-05-31T03:00:00Z' }
          throw new Error(`unexpected RPC: ${method}`)
        }),
      } as never,
      moduleId: 'worker',
      getAdminPort: async () => 19001,
      resolveChannelPort: async (channelId: string) => {
        if (channelId === 'feishu-001') return 19010
        if (channelId === 'telegram-001') return 19011
        throw new Error(`unknown channel ${channelId}`)
      },
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: new HumanMessageQueue(),
        triggerType: 'scheduled',
        taskType: 'daily_reflection',
        hasGoal: () => false,
      }),
    })

    const tool = findTool(tools, 'send_master_private')!
    const result = await tool.handler({ content: '一行人话摘要' })
    const payload = parsePayload(result)

    expect(payload).toMatchObject({
      platform_message_id: 'mid-1',
      channel_id: 'feishu-001',
      session_id: 'sess-abc',
      friend_id: 'master-friend',
    })

    // 用第一个 channel 的端口发送
    const sendCall = calls.find(c => c.method === 'send_message')
    expect(sendCall?.port).toBe(19010)
  })

  it('restricts to specified channel_id and errors when master has no identity there', async () => {
    const master = makeMaster([
      { channel_id: 'feishu-001', platform_user_id: 'ou_x' },
    ])

    const tools = buildMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port, method) => {
          if (method === 'find_master_friend') return { friend: master }
          throw new Error(`unexpected RPC: ${method}`)
        }),
      } as never,
      moduleId: 'worker',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19010,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: new HumanMessageQueue(),
        triggerType: 'scheduled',
        taskType: 'daily_reflection',
        hasGoal: () => false,
      }),
    })

    const tool = findTool(tools, 'send_master_private')!
    const result = await tool.handler({ content: '一行人话', channel_id: 'telegram-001' })
    const payload = parsePayload(result)

    expect(payload.error).toMatch(/no identity on channel telegram-001/)
    expect(payload.available_channels).toEqual(['feishu-001'])
  })

  // 回归：channel.find_or_create_private_session 协议返回 { session: Session, created },
  // 不是 { session_id, created }。早期实现按 session_id 读，恒为 undefined，
  // 导致 send_message 拿到 session_id=undefined → channel 抛 "Session not found: undefined"。
  it('uses session.id from channel response, not non-existent session_id field', async () => {
    const master = makeMaster([
      { channel_id: 'feishu-001', platform_user_id: 'ou_x' },
    ])
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []

    const tools = buildMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port, method, params) => {
          calls.push({ method, params: params as Record<string, unknown> })
          if (method === 'find_master_friend') return { friend: master }
          if (method === 'find_or_create_private_session') {
            return { session: { id: 'real-session-uuid' }, created: false }
          }
          if (method === 'send_message') return { platform_message_id: 'mid-2', sent_at: '2026-06-03T00:00:00Z' }
          throw new Error(`unexpected RPC: ${method}`)
        }),
      } as never,
      moduleId: 'worker',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19010,
      getTaskContext: () => ({
        taskId: 't1',
        humanQueue: new HumanMessageQueue(),
        triggerType: 'scheduled',
        taskType: 'daily_reflection',
        hasGoal: () => false,
      }),
    })

    const tool = findTool(tools, 'send_master_private')!
    const result = await tool.handler({ content: '一行人话' })
    const payload = parsePayload(result)

    const sendCall = calls.find(c => c.method === 'send_message')
    expect(sendCall?.params.session_id).toBe('real-session-uuid')
    expect(payload).toMatchObject({
      platform_message_id: 'mid-2',
      channel_id: 'feishu-001',
      session_id: 'real-session-uuid',
    })
    expect(payload.error).toBeUndefined()
  })
})
