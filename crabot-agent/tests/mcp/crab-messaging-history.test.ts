import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SlackChannel } from '../../../crabot-channel-slack/src/slack-channel.js'

// Agent CI installs Agent/shared only. Inject the platform API below without loading Slack's SDKs.
vi.mock('../../../crabot-channel-slack/src/slack-client.js', () => ({
  SlackClient: vi.fn(),
  platformError: () => { throw new Error('unexpected Slack platform error in integration fixture') },
}))

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

describe('Slack Agent → Channel 历史查询', () => {
  it('在 Channel 内转换日期参数并返回入群前远端消息，保持会话和入站事件不变', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-agent-history-'))
    try {
      const api = { connected: true, start: vi.fn(), stop: vi.fn(), call: vi.fn(async () => ({
        ok: true, messages: [{ type: 'message', user: 'U1', ts: '100.001001', text: 'pre-join target' }], has_more: false,
      })) }
      const channel = new SlackChannel({ module_id: 'slack-history', port: 0, data_dir: dir,
        env: { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' } }, api as never)
      const store = (channel as any).store
      const session = store.upsert({ id: 'CPRIVATE', is_member: true }, 'private').session
      const original = JSON.stringify(session), events = vi.fn()
      ;(channel as any).rpcClient.publishEvent = events
      const call = vi.fn(async (_port, method, params) => {
        if (method === 'resolve_friend') return { friend: null }
        return (channel as any).methodHandlers.get(method)(params)
      })
      const tool = getHistoryTool(call)
      const result = await tool.handler({ channel_id: 'slack-history', session_id: session.id, keyword: 'TARGET',
        after: '1970-01-01T00:01:40.001Z', before: '1970-01-01T00:01:40.002Z', limit: 20 })
      expect(JSON.parse(result.content[0].text).messages).toEqual([{
        platform_message_id: '100.001001', sender_name: 'U1', content: 'pre-join target', content_type: 'text', timestamp: '1970-01-01T00:01:40.001Z',
      }])
      expect(api.call).toHaveBeenCalledWith('conversations.history', expect.objectContaining({ channel: 'CPRIVATE', oldest: '100.001000', latest: '100.002000' }))
      expect(JSON.stringify(store.session(session.id))).toBe(original)
      expect(events).not.toHaveBeenCalled()
      expect(fs.readdirSync(path.join(dir, 'messages'))).toEqual([])
      expect(tool.description).toContain('主聊天')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
