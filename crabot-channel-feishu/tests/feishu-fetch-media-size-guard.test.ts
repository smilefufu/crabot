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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-guard-'))
  channel = new FeishuChannel({
    module_id: 'channel-feishu-test', module_type: 'channel', version: '0', protocol_version: '0',
    data_dir: dir,
    feishu: { app_id: 'cli_x', app_secret: 's', domain: 'feishu', only_respond_to_mentions: true, markdown_format: 'auto' },
  }, { publishEvent: async () => {} })
  await (channel as any).mediaHandleStore.init()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('fetch_media 入站大小上限保护', () => {
  it('size 超过上限 → status=failed，且不触发下载', async () => {
    const download = vi.fn(async () => Buffer.from('x'))
    ;(channel as any).client.downloadResource = download
    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file', filename: 'big.zip', size: 200 * 1024 * 1024,
      credential: { platform_message_id: 'om_big', file_key: 'fk' },
    })
    const res = await (channel as any).handleFetchMedia({ handle })
    expect(res.status).toBe('failed')
    expect(res.error).toMatch(/too large|过大|exceeds/i)
    expect(download).not.toHaveBeenCalled()
  })

  it('size 在上限内 → 正常下载返回 ready', async () => {
    ;(channel as any).client.downloadResource = vi.fn(async () => Buffer.from('hello'))
    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file', filename: 'a.pdf', size: 5, credential: { platform_message_id: 'om_ok', file_key: 'fk' },
    })
    const res = await (channel as any).handleFetchMedia({ handle })
    expect(res.status).toBe('ready')
  })

  it('size 未知（undefined）→ 不拦截，照常下载', async () => {
    ;(channel as any).client.downloadResource = vi.fn(async () => Buffer.from('hello'))
    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file', filename: 'a.pdf', credential: { platform_message_id: 'om_unk', file_key: 'fk' },
    })
    const res = await (channel as any).handleFetchMedia({ handle })
    expect(res.status).toBe('ready')
  })
})
