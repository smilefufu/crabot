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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-drive-'))
  channel = new FeishuChannel({ module_id: 'channel-feishu-test', module_type: 'channel', version: '0', protocol_version: '0', port: 0, data_dir: dir, feishu: { app_id: 'cli_x', app_secret: 's', domain: 'feishu', only_respond_to_mentions: true, markdown_format: 'auto' } })
  await channel.mediaHandleStore.init()
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

it('handleReadDocument 对 file 链接返回 handle 并可 fetch', async () => {
  channel.client.downloadDriveFile = vi.fn(async () => ({ buffer: Buffer.from('PPTX'), filename: 'plan.pptx' }))
  const res = await channel.handleReadDocument({ url: 'https://x.feishu.cn/file/boxT' })
  expect(res.type).toBe('file'); expect(res.handle).toMatch(/^fm_/)
  const r = await channel.mediaFetch.fetch(res.handle)
  expect(r.status).toBe('ready')
  expect(fs.readFileSync(r.file_path).toString()).toBe('PPTX')
})

it('drive credential 走 downloadDriveFile 落盘', async () => {
  channel.client.downloadDriveFile = vi.fn(async () => ({ buffer: Buffer.from('PPTX'), filename: 'plan.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }))
  const handle = await channel.mediaHandleStore.put({ kind: 'file', filename: 'plan.pptx', credential: { file_token: 'boxT' } })
  const r = await channel.mediaFetch.fetch(handle)
  expect(r.status).toBe('ready')
  expect(fs.readFileSync(r.file_path).toString()).toBe('PPTX')
  expect(r.file_path).toMatch(/\.pptx$/)
  expect(channel.client.downloadDriveFile).toHaveBeenCalledWith('boxT')
})

it('权限不足时返回带 remediation 的对象，scope 按 ref.kind 选', async () => {
  ;(channel as any).docReader.read = vi.fn(async () => { throw Object.assign(new Error('no perm'), { code: 'PERMISSION_DENIED' }) })
  const res = await channel.handleReadDocument({ url: 'https://x.feishu.cn/wiki/W' })
  expect(res.error_code).toBe('PERMISSION_DENIED')
  expect(res.remediation.grant_url).toContain('cli_x')
  expect(decodeURIComponent(res.remediation.grant_url)).toContain('wiki:wiki:readonly')
  expect(res.remediation.grant_url).not.toContain('im%3Amessage')
})

it('drive 下载失败（403）时返回 failed 且 error 为可读的权限原因，而非通用失败', async () => {
  channel.client.downloadDriveFile = vi.fn(async () => { throw new Error('request failed with HTTP status 403 Forbidden') })
  const handle = await channel.mediaHandleStore.put({ kind: 'file', filename: 'a.pptx', credential: { file_token: 'boxT' } })
  // 同步下载路径的异常由 MediaFetchManager 捕获为 {status:'failed', error}，经 fetch_media 透给 agent
  const res = await channel.mediaFetch.fetch(handle)
  expect(res.status).toBe('failed')
  expect(res.error).toMatch(/权限|分享|drive:drive:readonly/)
})
it('drive 下载非权限错误 failed，error 带原始原因', async () => {
  channel.client.downloadDriveFile = vi.fn(async () => { throw new Error('socket hang up') })
  const handle = await channel.mediaHandleStore.put({ kind: 'file', filename: 'a.pptx', credential: { file_token: 'boxT' } })
  const res = await channel.mediaFetch.fetch(handle)
  expect(res.status).toBe('failed')
  expect(res.error).toMatch(/socket hang up/)
})
