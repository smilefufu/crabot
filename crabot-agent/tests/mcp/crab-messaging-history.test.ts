import { describe, expect, it, vi } from 'vitest'

import { buildWorkerMessagingTools } from '../../src/mcp/crab-messaging.js'

function getHistoryTool(call: ReturnType<typeof vi.fn>) {
  const tool = buildWorkerMessagingTools({
    rpcClient: { call } as never,
    moduleId: 'history-test',
    getAdminPort: async () => 19001,
    resolveChannelPort: async () => 19009,
    getTaskContext: () => null,
  }).find((candidate) => candidate.name === 'get_history')
  if (!tool) throw new Error('get_history tool not found')
  return tool
}

describe('crab-messaging get_history 协议映射', () => {
  it.each(['feishu', 'wechat', 'telegram', 'dingtalk'])('%s 的嵌套 Channel HistoryMessage 映射为既有扁平工具结果', async (channelId) => {
    const call = vi.fn(async (port: number, method: string, params: Record<string, unknown>) => {
      if (port === 19009 && method === 'get_history') {
        expect(params).toEqual({ session_id: 'session-1', limit: 3 })
        return {
          items: [
            {
              platform_message_id: 'message-1',
              sender: {
                friend_id: 'friend-direct',
                platform_user_id: 'platform-direct',
                platform_display_name: '直接好友',
              },
              content: { type: 'text', text: '第一条正文' },
              features: { is_mention_crab: false, quote_message_id: 'quoted-1' },
              platform_timestamp: '2026-09-07T01:02:03.000Z',
            },
            {
              platform_message_id: 'message-2',
              sender: {
                platform_user_id: 'platform-resolve',
                platform_display_name: '待映射用户',
              },
              content: { type: 'image', text: '[图片]', file_path: '/tmp/not-exposed.png' },
              features: { is_mention_crab: false },
              platform_timestamp: '2026-09-07T01:03:04.000Z',
            },
          ],
          pagination: { page: 1, page_size: 3, total_items: 2, total_pages: 1 },
        }
      }
      if (port === 19001 && method === 'resolve_friend') {
        expect(params).toEqual({ channel_id: channelId, platform_user_id: 'platform-resolve' })
        return { friend: { id: 'friend-resolved' } }
      }
      throw new Error(`unexpected RPC: ${port}/${method}`)
    })

    const result = await getHistoryTool(call).handler({
      channel_id: channelId,
      session_id: 'session-1',
      limit: 3,
    })

    expect(JSON.parse(result.content[0].text)).toEqual({
      messages: [
        {
          platform_message_id: 'message-1',
          sender_name: '直接好友',
          sender_friend_id: 'friend-direct',
          content: '第一条正文',
          content_type: 'text',
          timestamp: '2026-09-07T01:02:03.000Z',
          quote_message_id: 'quoted-1',
        },
        {
          platform_message_id: 'message-2',
          sender_name: '待映射用户',
          sender_friend_id: 'friend-resolved',
          content: '[图片]',
          content_type: 'image',
          timestamp: '2026-09-07T01:03:04.000Z',
        },
      ],
    })
    expect(call.mock.calls.filter(([, method]) => method === 'resolve_friend')).toHaveLength(1)
  })

  it('friend 映射失败时仍返回其余可读历史字段', async () => {
    const call = vi.fn(async (port: number, method: string) => {
      if (port === 19009 && method === 'get_history') {
        return {
          items: [{
            platform_message_id: 'message-1',
            sender: { platform_user_id: 'unknown', platform_display_name: '未知用户' },
            content: { type: 'text', text: '仍然可读' },
            features: { is_mention_crab: false },
            platform_timestamp: '2026-09-07T02:00:00.000Z',
          }],
        }
      }
      if (port === 19001 && method === 'resolve_friend') throw new Error('admin unavailable')
      throw new Error(`unexpected RPC: ${port}/${method}`)
    })

    const result = await getHistoryTool(call).handler({ channel_id: 'feishu', session_id: 'session-1' })

    expect(JSON.parse(result.content[0].text)).toEqual({
      messages: [{
        platform_message_id: 'message-1',
        sender_name: '未知用户',
        content: '仍然可读',
        content_type: 'text',
        timestamp: '2026-09-07T02:00:00.000Z',
      }],
    })
  })
})
