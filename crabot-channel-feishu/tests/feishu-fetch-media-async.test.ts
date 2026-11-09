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

let dir: string
let channel: FeishuChannel

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-async-'))
  channel = new FeishuChannel({
    module_id: 'channel-feishu-test', module_type: 'channel', version: '0', protocol_version: '0',
    data_dir: dir,
    feishu: { app_id: 'cli_x', app_secret: 's', domain: 'feishu', only_respond_to_mentions: true, markdown_format: 'auto' },
  }, { publishEvent: async () => {} })
  await (channel as any).mediaHandleStore.init()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('fetch_media 大文件非阻塞 + 完成事件', () => {
  it('文件 ≥ 异步阈值 → 立即返回 fetching 不阻塞；后台下完发 media.download_completed 事件', async () => {
    const publishEvent = vi.fn(async (_event: any, _source?: string) => 1)
    ;(channel as any).events.publishEvent = publishEvent
    let resolveDownload!: (b: Buffer) => void
    ;(channel as any).client.downloadResource = vi.fn(() => new Promise<Buffer>((res) => { resolveDownload = res }))

    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file', filename: 'big.pdf', size: 20 * 1024 * 1024, session_id: 'sess_1',
      credential: { platform_message_id: 'om_big', file_key: 'fk' },
    })
    const res = await (channel as any).handleFetchMedia({ handle })
    expect(res.status).toBe('fetching')
    expect(publishEvent).not.toHaveBeenCalled()

    resolveDownload(Buffer.from('hello'))
    await new Promise((r) => setTimeout(r, 30))

    expect(publishEvent).toHaveBeenCalledTimes(1)
    const ev = publishEvent.mock.calls[0][0]
    expect(ev.type).toBe('media.download_completed')
    expect(ev.payload).toMatchObject({ channel_id: expect.any(String), session_id: 'sess_1', handle, status: 'ready' })
  })

  it('后台下载失败 → 发事件 status=failed', async () => {
    const publishEvent = vi.fn(async (_event: any, _source?: string) => 1)
    ;(channel as any).events.publishEvent = publishEvent
    ;(channel as any).client.downloadResource = vi.fn(async () => { throw new Error('net') })
    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file', filename: 'f.pdf', size: 20 * 1024 * 1024, session_id: 'sess_2',
      credential: { platform_message_id: 'om_f', file_key: 'fk' },
    })
    const res = await (channel as any).handleFetchMedia({ handle })
    expect(res.status).toBe('fetching')
    await new Promise((r) => setTimeout(r, 30))
    expect(publishEvent).toHaveBeenCalledTimes(1)
    expect(publishEvent.mock.calls[0][0].payload).toMatchObject({ handle, status: 'failed' })
  })

  it('小文件（< 阈值）仍同步返回 ready，不发事件', async () => {
    const publishEvent = vi.fn(async (_event: any, _source?: string) => 1)
    ;(channel as any).events.publishEvent = publishEvent
    ;(channel as any).client.downloadResource = vi.fn(async () => Buffer.from('hi'))
    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file', filename: 's.pdf', size: 100, session_id: 'sess_3',
      credential: { platform_message_id: 'om_small', file_key: 'fk' },
    })
    const res = await (channel as any).handleFetchMedia({ handle })
    expect(res.status).toBe('ready')
    expect(publishEvent).not.toHaveBeenCalled()
  })
})
