import { describe, expect, it, vi, afterEach } from 'vitest'
import { formatMessageContent, resolveImageBlocks } from '../../src/agent/media-resolver.js'
import type { ChannelMessage } from '../../src/types.js'

afterEach(() => vi.unstubAllGlobals())
describe('微信只呈现图片引用', () => {
  it.each(['private', 'group'] as const)('会话 %s 的图片不下载、不提供缩略图视觉内容', async type => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const msg: ChannelMessage = {
      platform_message_id: 'img', session: { channel_id: 'wx-custom', session_id: 's', type },
      sender: { platform_user_id: 'u', platform_display_name: 'user' },
      features: { is_mention_crab: false }, platform_timestamp: '2026-09-25T00:00:00Z',
      content: { type: 'image', media_url: 'https://cdn/thumb', image_quality: 'thumbnail' },
    }
    expect(formatMessageContent(msg)).toContain('当前为缩略图，高清尚未就绪')
    expect(formatMessageContent(msg)).toContain('platform_message_id=img')
    expect(formatMessageContent(msg)).toContain('fetch_image')
    expect(await resolveImageBlocks([msg])).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })
})


it('微信入站和嵌套引用的模型投影不暴露旧版本 URL', async () => {
  const { formatChannelMessageLine } = await import('../../src/prompt-manager.js')
  const image = {
    platform_message_id: 'original', session: { channel_id: 'wechat', session_id: 's', type: 'group' },
    sender: { platform_user_id: 'u', platform_display_name: 'user' },
    features: { is_mention_crab: false }, platform_timestamp: '2026-10-10T12:31:47Z',
    content: { type: 'image', media_url: 'https://cdn/old-thumbnail', image_quality: 'thumbnail' },
  } as ChannelMessage
  const reply = { ...image, platform_message_id: 'reply', content: { type: 'text', text: '识别引用图片' },
    features: { is_mention_crab: true, quote_message_id: 'original' } } as ChannelMessage
  for (const msg of [image, reply]) {
    const text = formatChannelMessageLine(msg, { timezone: 'UTC', identity: 'friend',
      quotedMessages: new Map([['original', { msg: image, identity: 'friend' }]]) })
    expect(text).toContain('fetch_image')
    expect(text).not.toContain('https://cdn/old-thumbnail')
  }
})
