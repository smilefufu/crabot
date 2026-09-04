import { describe, it, expect, vi } from 'vitest'
import { buildWorkerMessagingTools } from '../../src/mcp/crab-messaging.js'

function findTool(tools: ReturnType<typeof buildWorkerMessagingTools>, name: string) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

function parse(out: Awaited<ReturnType<ReturnType<typeof buildWorkerMessagingTools>[number]['handler']>>) {
  return JSON.parse((out as { content: Array<{ text: string }> }).content[0].text)
}

function makeDeps(call: ReturnType<typeof vi.fn>) {
  return {
    rpcClient: { call } as never,
    moduleId: 'agent-test',
    getAdminPort: async () => 19001,
    resolveChannelPort: async (id: string) => (id === 'feishu-1' ? 19010 : 0),
  } as never
}

// 回归守卫：get_message 曾把 channel 返回的 MessageContent 掐成 text+type，
// 丢掉 media[]/handle/status——LLM 拿不到图片本地路径后瞎猜 fetch_media handle
//（2026-08-30 feishu 看图失败根因之一）。channel 侧明明返回了完整 media 信息。
describe('get_message 媒体字段透出', () => {
  it('image 消息（channel 已下载）→ 透出 media[]/media_url/status', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({
        platform_message_id: 'om_img',
        sender: { platform_user_id: 'ou_1', platform_display_name: '张三' },
        content: {
          type: 'image',
          text: '看看',
          media: [
            {
              media_url: '/data/media/om_img-1.jpg',
              mime_type: 'image/jpeg',
              filename: 'om_img-1.jpg',
              size: 1024,
            },
          ],
          media_url: '/data/media/om_img-1.jpg',
          status: 'ready',
        },
        features: {},
        platform_timestamp: '2026-08-30T08:00:00.000Z',
      })
      .mockResolvedValue({ friend: null })
    const tools = buildWorkerMessagingTools(makeDeps(call))
    const out = await findTool(tools, 'get_message').handler({
      channel_id: 'feishu-1',
      session_id: 's1',
      platform_message_id: 'om_img',
    })
    const result = parse(out)
    expect(result.content_type).toBe('image')
    expect(result.media).toEqual([
      { media_url: '/data/media/om_img-1.jpg', mime_type: 'image/jpeg', filename: 'om_img-1.jpg', size: 1024 },
    ])
    expect(result.media_url).toBe('/data/media/om_img-1.jpg')
    expect(result.status).toBe('ready')
    expect(out.observedSessionTargets).toEqual([
      { channel_id: 'feishu-1', session_id: 's1' },
    ])
    expect(result).not.toHaveProperty('observedSessionTargets')
  })

  it('not_fetched 文件消息 → 透出 handle 供 fetch_media 使用', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({
        platform_message_id: 'om_file',
        sender: { platform_user_id: 'ou_1', platform_display_name: '张三' },
        content: { type: 'file', filename: 'a.pdf', handle: 'fm_abc', status: 'not_fetched', size: 2048 },
        features: {},
        platform_timestamp: '2026-08-30T08:00:00.000Z',
      })
      .mockResolvedValue({ friend: null })
    const tools = buildWorkerMessagingTools(makeDeps(call))
    const out = await findTool(tools, 'get_message').handler({
      channel_id: 'feishu-1',
      session_id: 's1',
      platform_message_id: 'om_file',
    })
    const result = parse(out)
    expect(result.handle).toBe('fm_abc')
    expect(result.status).toBe('not_fetched')
  })

  it('纯文本消息 → 不带媒体字段（按存在性透出）', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({
        platform_message_id: 'om_text',
        sender: { platform_user_id: 'ou_1', platform_display_name: '张三' },
        content: { type: 'text', text: '你好' },
        features: {},
        platform_timestamp: '2026-08-30T08:00:00.000Z',
      })
      .mockResolvedValue({ friend: null })
    const tools = buildWorkerMessagingTools(makeDeps(call))
    const out = await findTool(tools, 'get_message').handler({
      channel_id: 'feishu-1',
      session_id: 's1',
      platform_message_id: 'om_text',
    })
    const result = parse(out)
    expect(result.content).toBe('你好')
    expect(result.media).toBeUndefined()
    expect(result.media_url).toBeUndefined()
    expect(result.handle).toBeUndefined()
    expect(result.status).toBeUndefined()
  })
})
