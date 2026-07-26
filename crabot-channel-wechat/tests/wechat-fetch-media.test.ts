import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { WechatChannel } from '../src/wechat-channel.js'

let tmpDir: string
let channel: WechatChannel

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-fetch-'))
  channel = new WechatChannel({
    module_id: 'wechat-test-fetch',
    module_type: 'channel',
    version: '0.0.1',
    protocol_version: '0.1.0',
    port: 0,
    data_dir: tmpDir,
    wechat: {
      connector_url: 'http://localhost:0',
      api_key: 'wct_test',
      mode: 'socketio',
    },
  })
  await (channel as any).mediaHandleStore.init()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('wechat fetch_media RPC', () => {
  it('capability 含 supports_media_fetch=true', () => {
    const caps = (channel as any).handleGetCapabilities()
    expect(caps.supports_media_fetch).toBe(true)
  })

  it('凭 handle 同步下载并返回 file_path（status=ready）', async () => {
    const mediaDir = path.join(tmpDir, 'media')
    fs.mkdirSync(mediaDir, { recursive: true })

    const fileContent = Buffer.from('fake pdf content')
    // mock global fetch 返回 200
    const originalFetch = global.fetch
    global.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => fileContent.buffer,
    })) as unknown as typeof fetch

    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file',
      filename: 'test.pdf',
      mime_type: 'application/pdf',
      session_id: 'sess_1',
      credential: { url: 'http://cdn.example.com/test.pdf' },
    })

    const res = await (channel as any).handleFetchMedia({ handle })
    expect(res.status).toBe('ready')
    expect(res.file_path).toBeTruthy()
    expect(fs.existsSync(res.file_path)).toBe(true)

    global.fetch = originalFetch
  })

  it('未知 handle → status=failed', async () => {
    const res = await (channel as any).handleFetchMedia({ handle: 'fm_000000000000' })
    expect(res.status).toBe('failed')
    expect(res.error).toBeTruthy()
  })

  it('credential 无 url：重查 connector 拿迟到 file_url → ready，credential 写回 url 并补 size', async () => {
    const fileContent = Buffer.from('late docx content')
    const originalFetch = global.fetch
    global.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => fileContent.buffer,
    })) as unknown as typeof fetch
    const getMessageById = vi.fn(async () => ({
      id: 'msg_conn_9',
      content: { type: 9, file_url: 'http://cdn.example.com/late.docx', file_name: 'video1.docx', file_size: 2048 },
    }))
    ;(channel as any).client.getMessageById = getMessageById

    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file',
      filename: 'video1.docx',
      session_id: 'sess_1',
      credential: { message_id: 'msg_conn_9' },
    })

    const res = await (channel as any).handleFetchMedia({ handle })
    expect(res.status).toBe('ready')
    expect(fs.existsSync(res.file_path)).toBe(true)
    expect(getMessageById).toHaveBeenCalledWith('msg_conn_9')

    const rec = (channel as any).mediaHandleStore.get(handle)
    expect(rec.credential.url).toBe('http://cdn.example.com/late.docx')
    expect(rec.credential.message_id).toBe('msg_conn_9')
    expect(rec.size).toBe(2048)

    global.fetch = originalFetch
  })

  it('重查后仍无 file_url → failed，error 含可行动指引', async () => {
    ;(channel as any).client.getMessageById = vi.fn(async () => ({
      id: 'msg_conn_10',
      content: { type: 9, file_name: 'video1.docx', file_size: 52428800 },
    }))

    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file',
      filename: 'video1.docx',
      credential: { message_id: 'msg_conn_10' },
    })

    const res = await (channel as any).handleFetchMedia({ handle })
    expect(res.status).toBe('failed')
    expect(res.error).toContain('尚未下载完成')
    expect(res.error).toContain('fetch_media')
  })

  it('重查请求失败（getMessageById 返回 null）→ failed', async () => {
    ;(channel as any).client.getMessageById = vi.fn(async () => null)

    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file',
      filename: 'x.pdf',
      credential: { message_id: 'msg_conn_11' },
    })

    const res = await (channel as any).handleFetchMedia({ handle })
    expect(res.status).toBe('failed')
    expect(res.error).toBeTruthy()
  })

  it('HTTP 下载失败 → status=failed', async () => {
    const originalFetch = global.fetch
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
    })) as unknown as typeof fetch

    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file',
      filename: 'b.pdf',
      credential: { url: 'http://cdn.example.com/secret.pdf' },
    })

    const res = await (channel as any).handleFetchMedia({ handle })
    expect(res.status).toBe('failed')

    global.fetch = originalFetch
  })
})
