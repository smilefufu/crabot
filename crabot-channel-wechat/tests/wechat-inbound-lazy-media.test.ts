import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { WechatChannel } from '../src/wechat-channel.js'

let tmpDir: string
let channel: WechatChannel

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-lazy-'))
  fs.mkdirSync(path.join(tmpDir, 'media'), { recursive: true })
  channel = new WechatChannel({
    module_id: 'wechat-test-lazy',
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

describe('wechat 入站惰性媒体', () => {
  it('file 类型：登记 handle，status=not_fetched，去掉 media_url', async () => {
    const content = await (channel as any).lazifyFileContent(
      { type: 'file', media_url: 'http://cdn.example.com/f.pdf', filename: 'f.pdf', size: 123 },
      'sess_abc',
    )

    expect(content.type).toBe('file')
    expect(content.status).toBe('not_fetched')
    expect(content.handle).toMatch(/^fm_[0-9a-f]{12}$/)
    expect(content.filename).toBe('f.pdf')
    expect(content.size).toBe(123)
    expect(content.media_url).toBeUndefined()
  })

  it('handle store 记录正确的 credential.url 和 session_id', async () => {
    const content = await (channel as any).lazifyFileContent(
      { type: 'file', media_url: 'http://cdn.example.com/doc.pdf', filename: 'doc.pdf', size: 456 },
      'sess_xyz',
    )

    const rec = (channel as any).mediaHandleStore.get(content.handle)
    expect(rec).toBeDefined()
    expect(rec.credential.url).toBe('http://cdn.example.com/doc.pdf')
    expect(rec.session_id).toBe('sess_xyz')
  })

  it('image 类型（无 file type）：保持不变，仍传 media_url', async () => {
    const input = { type: 'image' as const, media_url: 'http://cdn.example.com/photo.jpg' }
    const content = await (channel as any).lazifyFileContent(input, 'sess_1')

    expect(content.type).toBe('image')
    expect(content.media_url).toBe('http://cdn.example.com/photo.jpg')
    expect(content.handle).toBeUndefined()
    expect(content.status).toBeUndefined()
  })

  it('file 类型无 media_url：保持不变（无 handle 登记）', async () => {
    const input = { type: 'file' as const, file_path: '/tmp/local.pdf', filename: 'local.pdf' }
    const content = await (channel as any).lazifyFileContent(input, 'sess_1')

    expect(content.type).toBe('file')
    expect(content.file_path).toBe('/tmp/local.pdf')
    expect(content.handle).toBeUndefined()
  })

  it('有 media_url 且有 messageId：credential 同时存 url 与 message_id', async () => {
    const content = await (channel as any).lazifyFileContent(
      { type: 'file', media_url: 'http://cdn.example.com/doc.pdf', filename: 'doc.pdf', size: 456 },
      'sess_xyz',
      'msg_conn_001',
    )

    const rec = (channel as any).mediaHandleStore.get(content.handle)
    expect(rec.credential.url).toBe('http://cdn.example.com/doc.pdf')
    expect(rec.credential.message_id).toBe('msg_conn_001')
  })

  it('超时降级（无 media_url 有 messageId）：也登记 handle，credential 只存 message_id', async () => {
    const content = await (channel as any).lazifyFileContent(
      { type: 'file', text: 'video1.docx', filename: 'video1.docx', size: 52428800 },
      'sess_deg',
      'msg_conn_002',
    )

    expect(content.status).toBe('not_fetched')
    expect(content.handle).toMatch(/^fm_[0-9a-f]{12}$/)
    expect(content.media_url).toBeUndefined()

    const rec = (channel as any).mediaHandleStore.get(content.handle)
    expect(rec).toBeDefined()
    expect(rec.credential.message_id).toBe('msg_conn_002')
    expect(rec.credential.url).toBeUndefined()
    expect(rec.session_id).toBe('sess_deg')
    expect(rec.size).toBe(52428800)
  })

  it('无 media_url 也无 messageId：保持不变（无 handle 登记）', async () => {
    const input = { type: 'file' as const, filename: 'orphan.pdf' }
    const content = await (channel as any).lazifyFileContent(input, 'sess_1')

    expect(content.handle).toBeUndefined()
    expect(content.status).toBeUndefined()
  })

  it('video（type=file, mime_type=video/mp4）：登记 handle，status=not_fetched', async () => {
    const content = await (channel as any).lazifyFileContent(
      { type: 'file', text: '视频', media_url: 'http://cdn.example.com/v.mp4', mime_type: 'video/mp4' },
      'sess_v',
    )

    expect(content.status).toBe('not_fetched')
    expect(content.handle).toMatch(/^fm_[0-9a-f]{12}$/)
    expect(content.mime_type).toBe('video/mp4')
    expect(content.media_url).toBeUndefined()
  })
})
