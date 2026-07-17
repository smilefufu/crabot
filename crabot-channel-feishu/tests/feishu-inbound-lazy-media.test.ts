import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 'feishu', Lark: 'lark' },
  Client: class {
    request = vi.fn(async () => ({ code: 0 }))
    im = {
      message: { create: vi.fn(), reply: vi.fn(), get: vi.fn(), list: vi.fn() },
      messageResource: { get: vi.fn() },
      chat: { list: vi.fn(async () => ({ data: { items: [], has_more: false } })) },
      chatMembers: { get: vi.fn() }, image: { create: vi.fn() }, file: { create: vi.fn() },
    }
    contact = { v3: { user: { get: vi.fn(), list: vi.fn() } } }
  },
  WSClient: class { start() { return Promise.resolve() } close() { return Promise.resolve() } },
  EventDispatcher: class { register() { return this } },
}))

import { FeishuChannel } from '../src/feishu-channel'
import { mapMessageContent } from '../src/event-mapper'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1])
let dir: string
let channel: FeishuChannel

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-lazy-'))
  channel = new FeishuChannel({
    module_id: 'channel-feishu-test', module_type: 'channel', version: '0', protocol_version: '0',
    port: 0, data_dir: dir,
    feishu: { app_id: 'cli_x', app_secret: 's', domain: 'feishu', only_respond_to_mentions: true, markdown_format: 'auto' },
  })
  await (channel as any).mediaHandleStore.init()
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('飞书入站惰性媒体', () => {
  it('图片：急切下载，写 file_path + status=ready', async () => {
    ;(channel as any).client.downloadResource = vi.fn(async () => PNG)
    const mapped = mapMessageContent('image', JSON.stringify({ image_key: 'img_x' }), [])
    const content = await (channel as any).applyMediaContent(mapped, 'om_img')
    expect(content.type).toBe('image')
    expect(content.status).toBe('ready')
    expect(content.file_path).toMatch(/[/\\]media[/\\]om_img\.png$/)
    expect(fs.existsSync(content.file_path)).toBe(true)
  })

  it('富文本图文：保留文字并把全部图片写入 media[]', async () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1])
    const download = vi.fn(async (_messageId: string, imageKey: string) =>
      imageKey === 'img_a' ? PNG : jpg
    )
    ;(channel as any).client.downloadResource = download
    const mapped = mapMessageContent('post', JSON.stringify({
      content: [
        [{ tag: 'img', image_key: 'img_a' }],
        [{ tag: 'text', text: '帮我比较这两张图' }],
        [{ tag: 'img', image_key: 'img_b' }],
      ],
    }), [])

    const content = await (channel as any).applyMediaContent(mapped, 'om_post')

    expect(content.type).toBe('image')
    expect(content.text).toBe('帮我比较这两张图')
    expect(content.status).toBe('ready')
    expect(content.media).toHaveLength(2)
    expect(content.media[0]).toMatchObject({ mime_type: 'image/png' })
    expect(content.media[1]).toMatchObject({ mime_type: 'image/jpeg' })
    expect(content.media_url).toBe(content.media[0].media_url)
    expect(content.media[0].media_url).not.toBe(content.media[1].media_url)
    expect(fs.existsSync(content.media[0].media_url)).toBe(true)
    expect(fs.existsSync(content.media[1].media_url)).toBe(true)
    expect(download.mock.calls).toEqual([
      ['om_post', 'img_a', 'image'],
      ['om_post', 'img_b', 'image'],
    ])
  })

  it('富文本多图：部分下载失败时仍保留成功图片', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    ;(channel as any).client.downloadResource = vi.fn(async (_messageId: string, imageKey: string) => {
      if (imageKey === 'img_b') throw new Error('download failed')
      return PNG
    })
    const mapped = mapMessageContent('post', JSON.stringify({
      content: [[
        { tag: 'text', text: '比较图片' },
        { tag: 'img', image_key: 'img_a' },
        { tag: 'img', image_key: 'img_b' },
      ]],
    }), [])

    const content = await (channel as any).applyMediaContent(mapped, 'om_partial')

    expect(content.type).toBe('image')
    expect(content.media).toHaveLength(1)
    expect(content.text).toBe('比较图片\n[1 张图片下载失败]')
  })

  it('富文本图文：全部下载失败时保留文字并降级为 text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    ;(channel as any).client.downloadResource = vi.fn(async () => { throw new Error('download failed') })
    const mapped = mapMessageContent('post', JSON.stringify({
      content: [[
        { tag: 'text', text: '看看图片' },
        { tag: 'img', image_key: 'img_a' },
      ]],
    }), [])

    const content = await (channel as any).applyMediaContent(mapped, 'om_failed')

    expect(content).toEqual({ type: 'text', text: '看看图片\n[图片下载失败]' })
  })

  it('图文内容中的飞书链接仍补充文档标题', async () => {
    ;(channel as any).docReader.readMeta = vi.fn(async () => ({ title: '项目说明' }))
    const url = 'https://example.feishu.cn/docx/DOC123'

    const content = await (channel as any).enrichContentWithDocTitles({
      type: 'image',
      text: `看图并参考 ${url}`,
      media_url: '/tmp/image.png',
    })

    expect(content.text).toBe(`看图并参考 [飞书文档·项目说明] ${url}`)
  })

  it('富文本图文的 message_received 事件携带真实媒体', async () => {
    ;(channel as any).client.getUser = vi.fn(async () => ({ name: '用户' }))
    ;(channel as any).client.downloadResource = vi.fn(async () => PNG)
    const publishEvent = vi.spyOn((channel as any).rpcClient, 'publishEvent').mockResolvedValue(undefined)

    await (channel as any).handleMessageReceive({
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: {
        message_id: 'om_event',
        chat_id: 'oc_private',
        chat_type: 'p2p',
        message_type: 'post',
        content: JSON.stringify({ content: [[
          { tag: 'text', text: '识别这张图' },
          { tag: 'img', image_key: 'img_event' },
        ]] }),
        create_time: '1760000000000',
      },
    })

    const event = publishEvent.mock.calls[0][0] as any
    expect(event.type).toBe('channel.message_received')
    expect(event.payload.message.content).toMatchObject({
      type: 'image',
      text: '识别这张图',
      status: 'ready',
    })
    expect(event.payload.message.content.media).toHaveLength(1)
    expect(event.payload.message.content.media_url).toBe(
      event.payload.message.content.media[0].media_url,
    )
  })

  it('文件：不下载，只产 handle + status=not_fetched + 元信息', async () => {
    const download = vi.fn(async () => Buffer.from('x'))
    ;(channel as any).client.downloadResource = download
    const mapped = mapMessageContent('file', JSON.stringify({ file_key: 'file_x', file_name: 'a.pdf', file_size: 5 }), [])
    const content = await (channel as any).applyMediaContent(mapped, 'om_file')
    expect(content.type).toBe('file')
    expect(content.status).toBe('not_fetched')
    expect(content.handle).toMatch(/^fm_[0-9a-f]{12}$/)
    expect(content.filename).toBe('a.pdf')
    expect(content.size).toBe(5)
    expect(content.file_path).toBeUndefined()
    expect(download).not.toHaveBeenCalled()
    expect((channel as any).mediaHandleStore.get(content.handle)?.credential?.file_key).toBe('file_x')
  })
})
