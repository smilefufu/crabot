import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 'feishu', Lark: 'lark' },
  Client: class {
    request = vi.fn(async () => ({ code: 0 }))
    im = { message: { create: vi.fn(), reply: vi.fn(), get: vi.fn(), list: vi.fn() }, messageResource: { get: vi.fn() }, chat: { list: vi.fn(async () => ({ data: { items: [], has_more: false } })) }, chatMembers: { get: vi.fn() }, image: { create: vi.fn() }, file: { create: vi.fn() } }
    contact = { v3: { user: { get: vi.fn(), list: vi.fn() } } }
  },
  WSClient: class { start() { return Promise.resolve() } close() { return Promise.resolve() } },
  EventDispatcher: class { register() { return this } },
}))
import { FeishuChannel } from '../src/feishu-channel'
let dir: string; let channel: any
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-aw-'))
  channel = new FeishuChannel({ module_id: 'channel-feishu-test', module_type: 'channel', version: '0', protocol_version: '0', data_dir: dir, feishu: { app_id: 'cli_x', app_secret: 's', domain: 'feishu', only_respond_to_mentions: true, markdown_format: 'auto' } }, { publishEvent: async () => {} })
  await channel.mediaHandleStore.init()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

it('缺省 allow_write 视为 true，handleGetConfig 反映 + schema 有该项', () => {
  const { config, schema } = channel.handleGetConfig()
  expect(config.group.allow_write).toBe(true)
  expect(schema['group.allow_write']).toBeTruthy()
  expect(schema['group.allow_write'].hot_reload).toBe(true)
})
it('handleUpdateConfig 可关 allow_write（hot reload，不需重启）', () => {
  const res = channel.handleUpdateConfig({ config: { group: { allow_write: false } } })
  expect(res.requires_restart).toBe(false)
  expect(channel.handleGetConfig().config.group.allow_write).toBe(false)
})
