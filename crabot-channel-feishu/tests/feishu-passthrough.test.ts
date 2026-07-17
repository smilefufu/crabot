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
import { FeishuChannel } from '../src/feishu-channel.js'
import { FeishuClientError } from '../src/feishu-client.js'

let dir: string; let channel: any
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-pt-'))
  channel = new FeishuChannel({ module_id: 'channel-feishu-test', module_type: 'channel', version: '0', protocol_version: '0', port: 0, data_dir: dir, feishu: { app_id: 'cli_x', app_secret: 's', domain: 'feishu', only_respond_to_mentions: true, markdown_format: 'auto' } })
  await channel.mediaHandleStore.init()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

it('feishu_get 拒绝非 /open-apis 路径', async () => {
  await expect(channel.handleFeishuGet({ path: '/evil/x' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})
it('feishu_get 拒绝含 .. 的路径', async () => {
  await expect(channel.handleFeishuGet({ path: '/open-apis/../admin/x' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})
it('feishu_get 透传 rawGet 结果', async () => {
  channel.client.rawGet = vi.fn(async () => ({ ok: 1 }))
  expect(await channel.handleFeishuGet({ path: '/open-apis/foo' })).toEqual({ data: { ok: 1 } })
})
it('feishu_download 登记 handle', async () => {
  const res = await channel.handleFeishuDownload({ file_token: 'boxT', filename: 'a.pptx' })
  expect(res.handle).toMatch(/^fm_/)
  expect(channel.mediaHandleStore.get(res.handle)?.credential?.file_token).toBe('boxT')
})

it('handleReadDocument 41050 权限错误返回诊断字段和 remediation', async () => {
  const err = new FeishuClientError({
    code: 'PERMISSION_DENIED',
    message: 'no user authority',
    feishu_code: 41050,
    feishu_message: 'no user authority',
  })
  channel.client.rawGet = vi.fn(async () => { throw err })
  const result = await channel.handleReadDocument({ url: 'https://xxx.feishu.cn/docx/DOCID' })
  expect(result.error_code).toBe('PERMISSION_DENIED')
  // 顶层诊断字段
  expect(result.feishu_code).toBe(41050)
  expect(result.feishu_message).toBe('no user authority')
  // remediation 对象
  expect(result.remediation).toBeDefined()
  expect(result.remediation.message).toContain('必要条件')
  expect(result.remediation.message).toContain('协作者')
  expect(result.remediation.message).toContain('外部租户')
  expect(result.remediation.feishu_code).toBe(41050)
  expect(result.remediation.feishu_message).toBe('no user authority')
  // scope 已推导
  expect(result.remediation.grant_url).toContain('cli_x')
  expect(decodeURIComponent(result.remediation.grant_url)).toContain('docx:document:readonly')
})

it('handleReadDocument docx scope 缺失返回 grant URL 且不含 41050 特定文案', async () => {
  const err = new FeishuClientError({
    code: 'PERMISSION_DENIED',
    message: 'permission denied',
    feishu_code: 99991663,
    feishu_message: 'permission denied',
  })
  channel.client.rawGet = vi.fn(async () => { throw err })
  const result = await channel.handleReadDocument({ url: 'https://xxx.feishu.cn/docx/DOCID' })
  expect(result.error_code).toBe('PERMISSION_DENIED')
  // remediation 含 grant URL
  expect(result.remediation.grant_url).toContain('cli_x')
  expect(decodeURIComponent(result.remediation.grant_url)).toContain('docx:document:readonly')
  // 非 41050 不声称"点击就解决"
  expect(result.remediation.message).not.toContain('就能解决')
  // 非 41050 不含外部租户步骤
  expect(result.remediation.steps.some((s: string) => s.includes('外部租户'))).toBe(false)
})
