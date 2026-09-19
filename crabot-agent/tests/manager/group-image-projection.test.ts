import { afterEach, describe, expect, it, vi } from 'vitest'
import { GroupInboundImageProjection, type ManagerImageRef } from '../../src/manager/image-vision.js'
import { createUserMessage, type EngineMessage } from '../../src/engine/index.js'
import * as media from '../../src/agent/media-resolver.js'

afterEach(() => vi.restoreAllMocks())

const images = (messages: EngineMessage[]) => messages.flatMap((message) =>
  'content' in message && Array.isArray(message.content) ? message.content.filter((block) => block.type === 'image') : [])

describe('group inbound image request projection', () => {
  it('reads only the last of 211 references, keeps URLs in place, and reuses it on retry', async () => {
    const read = vi.spyOn(media, 'fetchRemoteImage').mockResolvedValue(Buffer.from('last-image'))
    const messages = Array.from({ length: 211 }, (_, i) => createUserMessage(`message ${i}\n[图片: ${i}.png]`))
    const refs = messages.map((message, i) => ({ message_id: message.id,
      images: [{ label: `${i}.png`, path: `https://example.invalid/${i}.png` }] }))
    const original = JSON.stringify(messages)
    const projection = new GroupInboundImageProjection(true)
    const projected = await projection.project(messages, refs)
    expect(images(projected)).toHaveLength(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith('https://example.invalid/210.png', 8_000)
    expect(projected[0].content).toBe('message 0\n[图片: https://example.invalid/0.png（图片内容未附带）]')
    expect(JSON.stringify(messages)).toBe(original)
    expect(await projection.project(messages, refs)).toEqual(projected)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('selects the last attachment occurrence even when labels and URLs repeat', async () => {
    vi.spyOn(media, 'fetchRemoteImage').mockResolvedValue(Buffer.from('same-image'))
    const message = createUserMessage('[图片: a.png]\n文字\n[图片: a.png]')
    const ref = { path: 'https://example.invalid/a.png', label: 'a.png' }
    const result = await new GroupInboundImageProjection(true).project([message], [
      { message_id: message.id, images: [ref, ref] },
    ])
    expect(images(result)).toHaveLength(1)
    expect(result[0].content).toEqual([
      { type: 'text', text: '[图片: https://example.invalid/a.png（图片内容未附带）]\n文字\n[图片: https://example.invalid/a.png（图片内容已附带）]' },
      expect.objectContaining({ type: 'image' }),
    ])
  })

  it.each([true, false])('never falls back to an older image when latest cannot be attached, vision=%s', async (vision) => {
    const read = vi.spyOn(media, 'readImageFile').mockResolvedValue(null)
    const old = createUserMessage('[图片: old.png]')
    const last = createUserMessage('[图片: last.png]')
    const refs = [old, last].map((message, i) => ({ message_id: message.id,
      images: [{ label: i ? 'last.png' : 'old.png', path: i ? '/missing/last.png' : '/old.png' }] }))
    const projection = new GroupInboundImageProjection(vision)
    const result = await projection.project([old, last, createUserMessage('没有新图片')], refs)
    expect(images(result)).toHaveLength(0)
    expect(result[1].content).toBe('[图片: last.png（图片内容未附带）]')
    expect(read).toHaveBeenCalledTimes(vision ? 1 : 0)
    if (vision) expect(read).toHaveBeenCalledWith('/missing/last.png')
    await projection.project([old, last], refs)
    expect(read).toHaveBeenCalledTimes(vision ? 1 : 0)
  })

  it('replaces the old picture with a newer reference, even when the new download fails', async () => {
    const read = vi.spyOn(media, 'fetchRemoteImage')
      .mockResolvedValueOnce(Buffer.from('old')).mockResolvedValueOnce(null)
    const old = createUserMessage('[图片: old]')
    const last = createUserMessage('[图片: new]')
    const refs: ManagerImageRef[] = [{ message_id: old.id, images: [{ label: 'old', path: 'https://example.invalid/old' }] }]
    const projection = new GroupInboundImageProjection(true)
    expect(images(await projection.project([old], refs))).toHaveLength(1)
    refs.push({ message_id: last.id, images: [{ label: 'new', path: 'https://example.invalid/new' }] })
    const result = await projection.project([old, last], refs)
    expect(images(result)).toHaveLength(0)
    expect(result[0].content).toContain('图片内容未附带')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('ignores references outside the current context and preserves tool images', async () => {
    const read = vi.spyOn(media, 'readImageFile').mockResolvedValue(Buffer.from('inbound'))
    const message = createUserMessage('[图片: current]')
    const tool: EngineMessage = { id: 'tool-result', role: 'user', timestamp: 0,
      toolResults: [{ tool_use_id: 'screenshot', is_error: false, content: 'screenshot',
        images: [{ media_type: 'image/png', data: 'tool-image' }] }] }
    const result = await new GroupInboundImageProjection(true).project([message, tool], [
      { message_id: message.id, images: [{ label: 'current', path: '/current.png' }] },
      { message_id: 'compacted-away', images: [{ label: 'gone', path: '/gone.png' }] },
    ])
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith('/current.png')
    expect(result[1]).toBe(tool)
  })
})
