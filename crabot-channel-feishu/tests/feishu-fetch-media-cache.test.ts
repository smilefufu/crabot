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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-cache-'))
  channel = new FeishuChannel({
    module_id: 'channel-feishu-test', module_type: 'channel', version: '0', protocol_version: '0',
    data_dir: dir,
    feishu: { app_id: 'cli_x', app_secret: 's', domain: 'feishu', only_respond_to_mentions: true, markdown_format: 'auto' },
  }, { publishEvent: async () => {} })
  await (channel as any).mediaHandleStore.init()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('fetch_media 幂等缓存', () => {
  it('第二次 fetch 命中缓存，不再下载，返回同一路径', async () => {
    const download = vi.fn(async () => Buffer.from('hello'))
    ;(channel as any).client.downloadResource = download
    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file', filename: 'a.pdf', credential: { platform_message_id: 'om_c', file_key: 'fk' },
    })
    const first = await (channel as any).handleFetchMedia({ handle })
    const second = await (channel as any).handleFetchMedia({ handle })
    expect(first.status).toBe('ready')
    expect(second.status).toBe('ready')
    expect(second.file_path).toBe(first.file_path)
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('缓存文件被删（GC）后再 fetch → 重新下载', async () => {
    const download = vi.fn(async () => Buffer.from('hello'))
    ;(channel as any).client.downloadResource = download
    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file', filename: 'a.pdf', credential: { platform_message_id: 'om_d', file_key: 'fk' },
    })
    const first = await (channel as any).handleFetchMedia({ handle })
    fs.rmSync(first.file_path)
    const second = await (channel as any).handleFetchMedia({ handle })
    expect(second.status).toBe('ready')
    expect(download).toHaveBeenCalledTimes(2)
  })
})
