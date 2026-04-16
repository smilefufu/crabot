import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { formatMessageContent, resolveImageFromPaths } from '../../src/agent/media-resolver'
import type { ChannelMessage } from '../../src/types'

function makeMsg(overrides: Partial<ChannelMessage['content']>): ChannelMessage {
  return {
    platform_message_id: 'msg-1',
    session: { session_id: 's1', channel_id: 'ch1', type: 'private' },
    sender: { platform_user_id: 'u1', platform_display_name: 'User' },
    content: { type: 'text', text: '', ...overrides },
    features: { is_mention_crab: false },
    platform_timestamp: new Date().toISOString(),
  }
}

describe('formatMessageContent', () => {
  it('returns text for text-only messages', () => {
    const msg = makeMsg({ type: 'text', text: 'hello' })
    expect(formatMessageContent(msg)).toBe('hello')
  })

  it('returns image placeholder for image-only messages', () => {
    const msg = makeMsg({ type: 'image', text: '', media_url: '/tmp/img.jpg' })
    expect(formatMessageContent(msg)).toBe('[图片: /tmp/img.jpg]')
  })

  it('returns both text and image ref when message has both', () => {
    const msg = makeMsg({ type: 'image', text: '帮我分析', media_url: '/tmp/img.jpg' })
    const result = formatMessageContent(msg)
    expect(result).toContain('帮我分析')
    expect(result).toContain('[图片: /tmp/img.jpg]')
  })

  it('returns file placeholder for file messages', () => {
    const msg = makeMsg({ type: 'file', text: '', media_url: '/tmp/doc.pdf', filename: 'report.pdf' })
    expect(formatMessageContent(msg)).toBe('[文件: report.pdf]')
  })

  it('returns text + file ref when file message has text', () => {
    const msg = makeMsg({ type: 'file', text: '看看这个', media_url: '/tmp/doc.pdf', filename: 'report.pdf' })
    const result = formatMessageContent(msg)
    expect(result).toContain('看看这个')
    expect(result).toContain('[文件: report.pdf]')
  })

  it('returns fallback for unknown type with no text', () => {
    const msg = makeMsg({ type: 'text', text: '' })
    expect(formatMessageContent(msg)).toBe('[非文本消息]')
  })
})

describe('resolveImageFromPaths', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-resolver-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('resolves a valid image file to ImageBlock', async () => {
    const imgPath = path.join(tmpDir, 'test.png')
    const pngData = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    )
    await fs.writeFile(imgPath, pngData)

    const blocks = await resolveImageFromPaths([imgPath])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('image')
    expect(blocks[0].source.media_type).toBe('image/png')
    expect(blocks[0].source.type).toBe('base64')
  })

  it('skips non-existent files', async () => {
    const blocks = await resolveImageFromPaths(['/tmp/does-not-exist-12345.png'])
    expect(blocks).toHaveLength(0)
  })

  it('handles multiple paths', async () => {
    const img1 = path.join(tmpDir, 'a.jpg')
    const img2 = path.join(tmpDir, 'b.png')
    await fs.writeFile(img1, Buffer.alloc(10))
    await fs.writeFile(img2, Buffer.alloc(10))

    const blocks = await resolveImageFromPaths([img1, img2])
    expect(blocks).toHaveLength(2)
    expect(blocks[0].source.media_type).toBe('image/jpeg')
    expect(blocks[1].source.media_type).toBe('image/png')
  })
})
