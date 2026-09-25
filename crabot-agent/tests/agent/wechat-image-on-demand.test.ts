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
