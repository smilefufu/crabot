import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import {
  collectInboundImagePaths,
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

async function writePng(name: string): Promise<string> {
  // 最小 PNG 签名头（inferMediaType 按扩展名判定，内容只要可读即可）
  const p = join(mediaDir, name)
  await fs.writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return p
}

function channelMsg(media: Array<{ media_url: string; mime_type: string }>): ChannelMessage {
  return {
    platform_message_id: 'om_x',
    session: { session_id: 's' as never, channel_id: 'feishu-1' as never, type: 'private' },
    sender: { platform_user_id: 'ou_1', platform_display_name: '张三' },
    content: { type: 'image', text: '看图', media },
    features: { is_mention_crab: false },
    platform_timestamp: '2026-08-30T08:00:00.000Z',
  } as never
}

describe('collectInboundImagePaths', () => {
  it('收集 image/* 的本地路径', () => {
    const paths = collectInboundImagePaths(channelMsg([
      { media_url: '/data/media/a.jpg', mime_type: 'image/jpeg' },
      { media_url: '/data/media/b.png', mime_type: 'image/png' },
    ]))
    expect(paths).toEqual(['/data/media/a.jpg', '/data/media/b.png'])
  })

  it('过滤远程 URL 与非图片附件', () => {
    const paths = collectInboundImagePaths(channelMsg([
      { media_url: 'https://example.com/a.jpg', mime_type: 'image/jpeg' },
      { media_url: '/data/media/doc.pdf', mime_type: 'application/pdf' },
    ]))
    expect(paths).toEqual([])
  })

  it('无 media → 空数组', () => {
    expect(collectInboundImagePaths(channelMsg([])).map(String)).toEqual([])
  })
})

describe('injectInboundImages', () => {
  it('文件存在 → content 变 [text(剔除标记), ...ImageBlock]，base64 与文件一致', async () => {
    const p1 = await writePng('inject-ok-1.png')
    const p2 = await writePng('inject-ok-2.png')
    const msg = createUserMessage(`你自己看\n[图片: inject-ok-1.png]\n[图片: inject-ok-2.png]\n`)
    const [out] = await injectInboundImages([msg], {
      supportsVision: true,
      imageRefs: [{ message_id: msg.id, paths: [p1, p2] }],
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
  })

  it('文件已被 GC → 不注入，标记改写为过期提示（content 仍是 string）', async () => {
    const msg = createUserMessage(`看这张\n[图片: gone.png]\n`)
    const [out] = await injectInboundImages([msg], {
      supportsVision: true,
      imageRefs: [{ message_id: msg.id, paths: [join(mediaDir, 'gone.png')] }],
    })
    expect(typeof out.content).toBe('string')
    expect(out.content as string).toContain('gone.png')
    expect(out.content as string).toContain('文件已清理')
  })

  it('部分成功 → 成功的注入剔除、失败的改写保留', async () => {
    const ok = await writePng('mix-ok.png')
    const msg = createUserMessage(`两张图\n[图片: mix-ok.png]\n[图片: mix-missing.png]\n`)
    const [out] = await injectInboundImages([msg], {
      supportsVision: true,
      imageRefs: [{ message_id: msg.id, paths: [ok, join(mediaDir, 'mix-missing.png')] }],
    })
    const content = out.content as Array<{ type: string; text?: string }>
    expect(content).toHaveLength(2) // text + 1 image
    expect(content[0].text).not.toContain('mix-ok.png')
    expect(content[0].text).toContain('mix-missing.png（文件已清理，无法查看）')
  })

  it('supportsVision=false → 原样返回（现状纯文本行为）', async () => {
    const ok = await writePng('novision.png')
    const msg = createUserMessage(`[图片: novision.png]`)
    const [out] = await injectInboundImages([msg], {
      supportsVision: false,
      imageRefs: [{ message_id: msg.id, paths: [ok] }],
    })
    expect(out.content).toBe(msg.content)
  })

  it('未命中 imageRefs 的消息原样返回；assistant 消息不参与', async () => {
    const ok = await writePng('hit.png')
    const hit = createUserMessage('命中')
    const miss = createUserMessage('未命中')
    const assistant = createAssistantMessage(
      [{ type: 'text', text: '回复' }],
      'end_turn',
    )
    const out = await injectInboundImages([hit, miss, assistant], {
      supportsVision: true,
      imageRefs: [{ message_id: hit.id, paths: [ok] }],
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
      { message_id: live.id, paths: ['/a.png'] },
      { message_id: 'dead-id', paths: ['/b.png'] },
    ]
    const out = pruneImageRefs(refs, [live])
    expect(out).toEqual([{ message_id: live.id, paths: ['/a.png'] }])
  })

  it('undefined / 无变化时原样返回', () => {
    expect(pruneImageRefs(undefined, [])).toBeUndefined()
    const refs = [{ message_id: 'x', paths: ['/a.png'] }]
    expect(pruneImageRefs(refs, [])).not.toBe(refs) // 有死条目 → 新数组
    expect(pruneImageRefs(refs, [createUserMessage('m')].map((m) => ({ ...m, id: 'x' })))).toBe(refs)
  })
})
