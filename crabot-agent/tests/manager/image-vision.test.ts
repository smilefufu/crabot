import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import {
  collectInboundImages,
  injectInboundImages,
  pruneImageRefs,
} from '../../src/manager/image-vision.js'
import { createUserMessage, createAssistantMessage } from '../../src/engine/index.js'
import type { ChannelMessage } from '../../src/types'

let mediaDir: string

beforeAll(async () => {
  mediaDir = join(tmpdir(), `crabot-image-vision-${randomUUID().slice(0, 8)}`)
  await fs.mkdir(mediaDir, { recursive: true })
})

afterAll(async () => {
  await fs.rm(mediaDir, { recursive: true, force: true })
})

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function writePng(name: string): Promise<string> {
  const p = join(mediaDir, name)
  await fs.writeFile(p, PNG_BYTES)
  return p
}

function channelMsg(content: Partial<ChannelMessage['content']>): ChannelMessage {
  return {
    platform_message_id: 'om_x',
    session: { session_id: 's' as never, channel_id: 'feishu-1' as never, type: 'private' },
    sender: { platform_user_id: 'ou_1', platform_display_name: '张三' },
    content: { type: 'image', text: '看图', ...content },
    features: { is_mention_crab: false },
    platform_timestamp: '2026-08-30T08:00:00.000Z',
  } as never
}

describe('collectInboundImages', () => {
  it('media[] 形态（feishu 富文本多图）：收集 path + label', () => {
    const refs = collectInboundImages(channelMsg({
      media: [
        { media_url: '/data/media/a.jpg', mime_type: 'image/jpeg', filename: 'a.jpg' },
        { media_url: '/data/media/b.png', mime_type: 'image/png', filename: 'b.png' },
      ],
    }))
    expect(refs).toEqual([
      { path: '/data/media/a.jpg', label: 'a.jpg' },
      { path: '/data/media/b.png', label: 'b.png' },
    ])
  })

  it('遗留单图 file_path 形态（feishu 普通单图，无 media[]）：读盘 path=file_path，label 与 formatMediaRef 同源', () => {
    const refs = collectInboundImages(channelMsg({
      file_path: '/data/media/om_x-1.jpg',
      status: 'ready',
      mime_type: 'image/jpeg',
    }))
    // formatMediaRef 单图分支渲染 media_url ?? filename ?? file_path——三者仅 file_path 时 label=完整路径
    expect(refs).toEqual([{ path: '/data/media/om_x-1.jpg', label: '/data/media/om_x-1.jpg' }])
  })

  it('遗留单图 media_url 形态（telegram/wechat）', () => {
    const refs = collectInboundImages(channelMsg({
      media_url: '/data/media/om_y-1.jpg',
      status: 'ready',
    }))
    expect(refs).toEqual([{ path: '/data/media/om_y-1.jpg', label: '/data/media/om_y-1.jpg' }])
  })

  it('混合形态：media_url 远程 + file_path 本地 → 读本地文件，label 与渲染同源（URL）；纯远程无法读 → 过滤', () => {
    expect(collectInboundImages(channelMsg({
      media_url: 'https://example.com/a.jpg',
      file_path: '/data/media/a.jpg',
      status: 'ready',
    }))).toEqual([{ path: '/data/media/a.jpg', label: 'https://example.com/a.jpg' }])
    expect(collectInboundImages(channelMsg({
      media_url: 'https://example.com/a.jpg',
      status: 'ready',
    }))).toEqual([])
    expect(collectInboundImages(channelMsg({
      media: [{ media_url: '/data/media/doc.pdf', mime_type: 'application/pdf', filename: 'doc.pdf' }],
    }))).toEqual([])
  })

  it('纯文本消息 → 空数组', () => {
    expect(collectInboundImages(channelMsg({ type: 'text', text: '你好' }))).toEqual([])
  })
})

describe('injectInboundImages', () => {
  it('文件存在 → content 变 [text(剔除标记), ...ImageBlock]，base64 与文件一致，originals 保留原文', async () => {
    const p1 = await writePng('inject-ok-1.png')
    const p2 = await writePng('inject-ok-2.png')
    const msg = createUserMessage(`你自己看\n[图片: inject-ok-1.png]\n[图片: inject-ok-2.png]\n`)
    const { messages: [out], originals } = await injectInboundImages([msg], {
      supportsVision: true,
      imageRefs: [{ message_id: msg.id, images: [{ path: p1, label: 'inject-ok-1.png' }, { path: p2, label: 'inject-ok-2.png' }] }],
    })
    expect(out.role).toBe('user')
    const content = out.content as Array<{ type: string; text?: string; source?: { data: string } }>
    expect(content).toHaveLength(3)
    expect(content[0].type).toBe('text')
    expect(content[0].text).not.toContain('[图片:')
    expect(content[1].type).toBe('image')
    const raw1 = await fs.readFile(p1)
    expect(content[1].source?.data).toBe(raw1.toString('base64'))
    expect(content[2].type).toBe('image')
    // 收尾持久化靠 originals 还原
    expect(originals.get(msg.id)).toBe(msg)
  })

  it('遗留单图形态：label 为完整路径也能正确剔除标记', async () => {
    const p = await writePng('full-path.png')
    const msg = createUserMessage(`你自己看正常不正常？！\n[图片: ${p}]\n`)
    const { messages: [out] } = await injectInboundImages([msg], {
      supportsVision: true,
      imageRefs: [{ message_id: msg.id, images: [{ path: p, label: p }] }],
    })
    const content = out.content as Array<{ type: string; text?: string }>
    expect(content).toHaveLength(2)
    expect(content[0].text).not.toContain('[图片:')
  })

  it('文件不可读（GC/超限/IO）→ 不注入，标记改写为中性提示（content 仍是 string）', async () => {
    const msg = createUserMessage(`看这张\n[图片: gone.png]\n`)
    const { messages: [out], originals } = await injectInboundImages([msg], {
      supportsVision: true,
      imageRefs: [{ message_id: msg.id, images: [{ path: join(mediaDir, 'gone.png'), label: 'gone.png' }] }],
    })
    expect(typeof out.content).toBe('string')
    expect(out.content as string).toContain('gone.png')
    expect(out.content as string).toContain('文件不可用，无法查看')
    expect(originals.get(msg.id)).toBe(msg)
  })

  it('部分成功 → 成功的注入剔除、失败的改写保留', async () => {
    const ok = await writePng('mix-ok.png')
    const msg = createUserMessage(`两张图\n[图片: mix-ok.png]\n[图片: mix-missing.png]\n`)
    const { messages: [out] } = await injectInboundImages([msg], {
      supportsVision: true,
      imageRefs: [{
        message_id: msg.id,
        images: [{ path: ok, label: 'mix-ok.png' }, { path: join(mediaDir, 'mix-missing.png'), label: 'mix-missing.png' }],
      }],
    })
    const content = out.content as Array<{ type: string; text?: string }>
    expect(content).toHaveLength(2) // text + 1 image
    expect(content[0].text).not.toContain('mix-ok.png')
    expect(content[0].text).toContain('mix-missing.png（文件不可用，无法查看）')
  })

  it('supportsVision=false → 原样返回（现状纯文本行为，originals 为空）', async () => {
    const ok = await writePng('novision.png')
    const msg = createUserMessage(`[图片: novision.png]`)
    const { messages: [out], originals } = await injectInboundImages([msg], {
      supportsVision: false,
      imageRefs: [{ message_id: msg.id, images: [{ path: ok, label: 'novision.png' }] }],
    })
    expect(out.content).toBe(msg.content)
    expect(originals.size).toBe(0)
  })

  it('未命中 imageRefs 的消息原样返回；assistant 消息不参与', async () => {
    const ok = await writePng('hit.png')
    const hit = createUserMessage('命中')
    const miss = createUserMessage('未命中')
    const assistant = createAssistantMessage(
      [{ type: 'text', text: '回复' }],
      'end_turn',
    )
    const { messages: out } = await injectInboundImages([hit, miss, assistant], {
      supportsVision: true,
      imageRefs: [{ message_id: hit.id, images: [{ path: ok, label: 'hit.png' }] }],
    })
    expect((out[0].content as Array<{ type: string }>)).toHaveLength(2)
    expect(out[1].content).toBe('未命中')
    expect(out[2]).toBe(assistant)
  })
})

describe('pruneImageRefs', () => {
  it('清除 recent 里不存在的引用', () => {
    const live = createUserMessage('活')
    const refs = [
      { message_id: live.id, images: [{ path: '/a.png', label: 'a.png' }] },
      { message_id: 'dead-id', images: [{ path: '/b.png', label: 'b.png' }] },
    ]
    const out = pruneImageRefs(refs, [live])
    expect(out).toEqual([{ message_id: live.id, images: [{ path: '/a.png', label: 'a.png' }] }])
  })

  it('undefined / 无变化时原样返回', () => {
    expect(pruneImageRefs(undefined, [])).toBeUndefined()
    const refs = [{ message_id: 'x', images: [{ path: '/a.png', label: 'a.png' }] }]
    expect(pruneImageRefs(refs, [])).not.toBe(refs) // 有死条目 → 新数组
    expect(pruneImageRefs(refs, [createUserMessage('m')].map((m) => ({ ...m, id: 'x' })))).toBe(refs)
  })
})
