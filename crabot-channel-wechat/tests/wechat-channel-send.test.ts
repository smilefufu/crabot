import { describe, it, expect, vi } from 'vitest'
import { WechatChannel } from '../src/wechat-channel.js'

function makeChannel(): WechatChannel {
  return new WechatChannel({
    module_id: 'wechat-test-send',
    module_type: 'channel',
    version: '0.0.1',
    protocol_version: '0.1.0',
    port: 0,
    data_dir: `/tmp/wechat-test-send-${Date.now()}`,
    wechat: {
      connector_url: 'http://localhost:0',
      api_key: 'wct_test',
    },
  })
}

interface SessionLite {
  session_id: string
  platform_session_id: string
  type: 'private' | 'group'
  created_at: string
  channel_id: string
}

function stubSession(channel: WechatChannel, session: SessionLite): void {
  (channel as unknown as { sessionManager: { findById: (id: string) => SessionLite | undefined } })
    .sessionManager = { findById: (id) => (id === session.session_id ? session : undefined) }
}

describe('WechatChannel handleSendMessage 文本分段', () => {
  it('短文本只调用一次 sendText', async () => {
    const channel = makeChannel()
    const sendText = vi.fn().mockResolvedValue({ taskId: 't' })
    ;(channel as unknown as { client: { sendText: typeof sendText } }).client = { sendText } as never

    stubSession(channel, {
      session_id: 's1',
      platform_session_id: 'wxid_user_a',
      type: 'private',
      created_at: '2026-01-01T00:00:00Z',
      channel_id: 'wechat-test-send',
    })

    await (channel as unknown as {
      handleSendMessage(p: unknown): Promise<unknown>
    }).handleSendMessage({
      session_id: 's1',
      content: { type: 'text', text: '你好世界' },
    })

    expect(sendText).toHaveBeenCalledTimes(1)
    expect(sendText).toHaveBeenCalledWith('wxid_user_a', '你好世界')
  })

  it('超长文本按顺序串行调用多次 sendText，且段间有间隔', async () => {
    const channel = makeChannel()
    const callLog: Array<{ text: string; at: number }> = []
    const sendText = vi.fn().mockImplementation(async (_wxid: string, text: string) => {
      callLog.push({ text, at: Date.now() })
      return { taskId: `t-${callLog.length}` }
    })
    ;(channel as unknown as { client: { sendText: typeof sendText } }).client = { sendText } as never

    stubSession(channel, {
      session_id: 's2',
      platform_session_id: 'wxid_user_b',
      type: 'private',
      created_at: '2026-01-01T00:00:00Z',
      channel_id: 'wechat-test-send',
    })

    // 构造一段超过 1500 字符的文本：3 个 700 字段落
    const para = (n: number) => `段落${n}：` + '内'.repeat(700 - 4)
    const longText = [para(1), para(2), para(3)].join('\n\n')

    await (channel as unknown as {
      handleSendMessage(p: unknown): Promise<unknown>
    }).handleSendMessage({
      session_id: 's2',
      content: { type: 'text', text: longText },
    })

    // 至少拆成 2 段
    expect(callLog.length).toBeGreaterThanOrEqual(2)

    // 顺序：第 n 段的首字符是「段」（来自"段落 N"前缀）— 至少验证 sendText 的入参顺序是原文顺序
    for (let i = 1; i < callLog.length; i++) {
      const prevIdx = longText.indexOf(callLog[i - 1].text)
      const curIdx = longText.indexOf(callLog[i].text)
      expect(prevIdx).toBeGreaterThanOrEqual(0)
      expect(curIdx).toBeGreaterThan(prevIdx)
    }

    // 段间有 ≥ 300ms 间隔（实际配置 400ms，给点抖动容差）
    for (let i = 1; i < callLog.length; i++) {
      expect(callLog[i].at - callLog[i - 1].at).toBeGreaterThanOrEqual(300)
    }
  }, 10_000)

  it('多段发送过程中第二段失败时抛错，第三段不再发出', async () => {
    const channel = makeChannel()
    const sendText = vi.fn()
      .mockResolvedValueOnce({ taskId: 't1' })
      .mockRejectedValueOnce(new Error('connector-down'))
    ;(channel as unknown as { client: { sendText: typeof sendText } }).client = { sendText } as never

    stubSession(channel, {
      session_id: 's3',
      platform_session_id: 'wxid_user_c',
      type: 'private',
      created_at: '2026-01-01T00:00:00Z',
      channel_id: 'wechat-test-send',
    })

    const para = (n: number) => `段${n}：` + '内'.repeat(700 - 3)
    const longText = [para(1), para(2), para(3)].join('\n\n')

    await expect(
      (channel as unknown as {
        handleSendMessage(p: unknown): Promise<unknown>
      }).handleSendMessage({
        session_id: 's3',
        content: { type: 'text', text: longText },
      }),
    ).rejects.toThrow('connector-down')

    // 只发到第二段就失败，第三段不会执行
    expect(sendText).toHaveBeenCalledTimes(2)
  }, 10_000)
})
