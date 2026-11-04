import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SlackChannel } from '../../../crabot-channel-slack/src/slack-channel.js'
import { buildWorkerMessagingTools } from '../../src/mcp/crab-messaging.js'

// Keep Agent tests independent of Slack SDK installation, as in the history integration fixture.
vi.mock('../../../crabot-channel-slack/src/slack-client.js', () => ({
  SlackClient: vi.fn(),
  platformError: () => { throw new Error('unexpected Slack platform error in mention fixture') },
}))

describe('Bot 发送工具 → Slack 群成员真实提及', () => {
  it.each(['platform_user_id', 'friend_id', 'missing identity'] as const)('%s 保留原群和 Bot 身份，无法提及时不报发送成功', async kind => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mentions-'))
    try {
      const ts = String(Date.now() / 1000)
      const api = { connected: true, start: vi.fn(), stop: vi.fn(),
        call: vi.fn(async () => ({ ok: true, ts })),
      }
      const channel = new SlackChannel({ module_id: 'slack-mentions', port: 0, data_dir: dir,
        env: { SLACK_BOT_TOKEN: 'xoxb-fixture', SLACK_APP_TOKEN: 'xapp-fixture' } }, api as never)
      ;(channel as any).identity = { team_id: 'T1', user_id: 'UBOT', app_id: 'A1' }
      const store = (channel as any).store
      const session = store.upsert({ id: 'CGROUP', is_member: true }, 'group').session
      const publish = vi.fn()
      ;(channel as any).rpcClient.publishEvent = publish
      const call = vi.fn(async (_port, method, params) => {
        if (method === 'get_friend') return { friend: { channel_identities: kind === 'missing identity' ? [] : [
          { channel_id: 'slack-mentions', platform_user_id: 'UFUFU' },
        ] } }
        return (channel as any).methodHandlers.get(method)(params)
      })
      const tool = buildWorkerMessagingTools({ rpcClient: { call } as never, moduleId: 'agent-test',
        getAdminPort: async () => 19001, resolveChannelPort: async () => 19009,
      }).find(tool => tool.name === 'send_message')!
      const result = await tool.handler({ channel_id: 'slack-mentions', session_id: session.id,
        content: '**请确认修复结果**',
        mentions: [kind === 'platform_user_id' ? { platform_user_id: 'UFUFU' } : { friend_id: 'friend-fufu' }],
      })
      const output = JSON.parse(result.content[0].text)
      if (kind === 'missing identity') {
        expect(output.error).toContain('mention 缺少本渠道平台身份')
        expect(api.call).not.toHaveBeenCalled()
        expect(store.history(session.id, (channel as any).settings.value.cache)).toEqual([])
      } else {
        expect(output.platform_message_id).toBe(ts)
        expect(api.call).toHaveBeenCalledOnce()
        expect(api.call).toHaveBeenCalledWith('chat.postMessage', {
          channel: 'CGROUP', text: '<@UFUFU> **请确认修复结果**',
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '<@UFUFU>' } },
            { type: 'markdown', text: '**请确认修复结果**' }],
          mrkdwn: true, unfurl_links: false, unfurl_media: false,
        })
        const history = store.history(session.id, (channel as any).settings.value.cache)
        expect(history).toHaveLength(1)
        expect(history[0].sender.platform_user_id).toBe('UBOT')
        expect(history[0].features.mentions.map((mention: { platform_user_id: string }) => mention.platform_user_id)).toEqual(['UFUFU'])
      }
      expect(publish).not.toHaveBeenCalled()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
