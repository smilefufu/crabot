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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-write-'))
  channel = new FeishuChannel({ module_id: 'channel-feishu-test', module_type: 'channel', version: '0', protocol_version: '0', data_dir: dir, feishu: { app_id: 'cli_x', app_secret: 's', domain: 'feishu', only_respond_to_mentions: true, markdown_format: 'auto' } }, { publishEvent: async () => {} })
  await channel.mediaHandleStore.init()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

it('allow_write 缺省(true) 时正常 POST 透传', async () => {
  channel.client.rawRequest = vi.fn(async () => ({ created: true }))
  const res = await channel.handleFeishuWrite({ method: 'POST', path: '/open-apis/sheets/v2/spreadsheets/x/values', body: { v: 1 } })
  expect(res).toEqual({ data: { created: true } })
  expect(channel.client.rawRequest).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/open-apis/sheets/v2/spreadsheets/x/values', body: { v: 1 } }))
})
it('allow_write=false 时拒绝且不调 client', async () => {
  channel.handleUpdateConfig({ config: { group: { allow_write: false } } })
  channel.client.rawRequest = vi.fn()
  const res = await channel.handleFeishuWrite({ method: 'POST', path: '/open-apis/docx/x', body: {} })
  expect(res.error_code).toBe('WRITE_DISABLED')
  expect(channel.client.rawRequest).not.toHaveBeenCalled()
})
it('method=GET / 非 /open-apis / 含 .. 被拒 INVALID_ARGUMENT', async () => {
  await expect(channel.handleFeishuWrite({ method: 'GET', path: '/open-apis/x' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await expect(channel.handleFeishuWrite({ method: 'POST', path: '/evil/x' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await expect(channel.handleFeishuWrite({ method: 'POST', path: '/open-apis/../admin' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})
it('403 时返回带写 scope 的 remediation', async () => {
  channel.client.rawRequest = vi.fn(async () => { throw Object.assign(new Error('no perm'), { code: 'PERMISSION_DENIED' }) })
  const res = await channel.handleFeishuWrite({ method: 'POST', path: '/open-apis/sheets/v2/spreadsheets/x/values', body: {} })
  expect(res.error_code).toBe('PERMISSION_DENIED')
  expect(decodeURIComponent(res.remediation.grant_url)).toContain('sheets:spreadsheet')
})
it('403 但 path 未映射写 scope 时返回通用文案、不带 remediation', async () => {
  channel.client.rawRequest = vi.fn(async () => { throw Object.assign(new Error('no perm'), { code: 'PERMISSION_DENIED' }) })
  const res = await channel.handleFeishuWrite({ method: 'POST', path: '/open-apis/im/v1/messages/x', body: {} })
  expect(res.error_code).toBe('PERMISSION_DENIED')
  expect(res.remediation).toBeUndefined()
  expect(res.message).toContain('写权限')
})
