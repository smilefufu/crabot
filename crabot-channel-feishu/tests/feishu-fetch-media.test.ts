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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-fetch-'))
  channel = new FeishuChannel({
    module_id: 'channel-feishu-test', module_type: 'channel', version: '0', protocol_version: '0',
    data_dir: dir,
    feishu: { app_id: 'cli_x', app_secret: 's', domain: 'feishu', only_respond_to_mentions: true, markdown_format: 'auto' },
  }, { publishEvent: async () => {} })
  await (channel as any).mediaHandleStore.init()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('feishu fetch_media RPC', () => {
  it('capability 含 supports_media_fetch=true', () => {
    const caps = (channel as any).handleGetCapabilities()
    expect(caps.supports_media_fetch).toBe(true)
  })

  it('凭 handle 同步下载并返回 file_path（status=ready）', async () => {
    ;(channel as any).client.downloadResource = vi.fn(async () => Buffer.from('hello'))
    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file', filename: 'a.pdf', credential: { platform_message_id: 'om_f', file_key: 'file_x' },
    })
    const res = await (channel as any).handleFetchMedia({ handle })
    expect(res.status).toBe('ready')
    expect(res.file_path).toMatch(/[/\\]media[/\\]om_f\.pdf$/)
    expect(fs.existsSync(res.file_path)).toBe(true)
  })

  it('未知 handle → status=failed', async () => {
    const res = await (channel as any).handleFetchMedia({ handle: 'fm_000000000000' })
    expect(res.status).toBe('failed')
    expect(res.error).toBeTruthy()
  })

  it('下载抛错 → status=failed 带原因', async () => {
    ;(channel as any).client.downloadResource = vi.fn(async () => { throw new Error('net') })
    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file', filename: 'b.pdf', credential: { platform_message_id: 'om_g', file_key: 'file_y' },
    })
    const res = await (channel as any).handleFetchMedia({ handle })
    expect(res.status).toBe('failed')
  })
})
