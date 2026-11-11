import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { TelegramChannel } from '../src/telegram-channel'
import type { TgMessage } from '../src/types'

let tmpDir: string
let channel: TelegramChannel

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lazy-'))
  fs.mkdirSync(path.join(tmpDir, 'media'), { recursive: true })
  channel = new TelegramChannel({
    module_id: 'channel-telegram-test',
    module_type: 'channel',
    version: '0.1.0',
    protocol_version: '0.1.0',
    port: 0,
    data_dir: tmpDir,
    telegram: {
      bot_token: 'token-secret',
      markdown_format: 'auto',
    },
  })
  await (channel as any).mediaHandleStore.init()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const makeDocMsg = (overrides: Partial<TgMessage> = {}): TgMessage => ({
  message_id: 1,
  chat: { id: 100, type: 'private' },
  date: Math.floor(Date.now() / 1000),
  document: {
    file_id: 'file_abc',
    file_unique_id: 'uniq_abc',
    file_name: 'report.pdf',
    mime_type: 'application/pdf',
    file_size: 12345,
  },
  ...overrides,
})

const makePhotoMsg = (overrides: Partial<TgMessage> = {}): TgMessage => ({
  message_id: 2,
  chat: { id: 100, type: 'private' },
  date: Math.floor(Date.now() / 1000),
  photo: [
    { file_id: 'ph_small', file_unique_id: 'ph_uniq_small', width: 100, height: 100 },
    { file_id: 'ph_large', file_unique_id: 'ph_uniq_large', width: 800, height: 600, file_size: 55000 },
  ],
  ...overrides,
})

describe('telegram 入站惰性媒体', () => {
  it('document：不下载，只登记 handle，返回 status=not_fetched', async () => {
    const downloadSpy = vi.fn(async () => ({ localPath: '/tmp/x.pdf', filePath: 'x' }))
    ;(channel as any).client.downloadFileToLocal = downloadSpy

    const msg = makeDocMsg()
    const content = await (channel as any).convertMessageContent(msg, 'sess_1')

    expect(content.type).toBe('file')
    expect(content.status).toBe('not_fetched')
    expect(content.handle).toMatch(/^fm_[0-9a-f]{12}$/)
    expect(content.filename).toBe('report.pdf')
    expect(content.mime_type).toBe('application/pdf')
    expect(content.size).toBe(12345)
    expect(content.media_url).toBeUndefined()
    expect(downloadSpy).not.toHaveBeenCalled()
  })

  it('document：handle store 记录了正确的 credential.file_id 和 session_id', async () => {
    ;(channel as any).client.downloadFileToLocal = vi.fn()

    const msg = makeDocMsg()
    const content = await (channel as any).convertMessageContent(msg, 'sess_abc')

    const rec = (channel as any).mediaHandleStore.get(content.handle)
    expect(rec).toBeDefined()
    expect(rec.credential.file_id).toBe('file_abc')
    expect(rec.session_id).toBe('sess_abc')
  })

  it('photo：仍急切下载，返回 media_url + type=image（不含 handle）', async () => {
    const localPath = path.join(tmpDir, 'media', 'ph_uniq_large.jpg')
    fs.writeFileSync(localPath, 'fake jpeg')

    ;(channel as any).client.downloadFileToLocal = vi.fn(async () => ({
      localPath,
      filePath: 'some/tg/file',
    }))

    const msg = makePhotoMsg()
    const content = await (channel as any).convertMessageContent(msg, 'sess_1')

    expect(content.type).toBe('image')
    expect(content.media_url).toBe(localPath)
    expect(content.handle).toBeUndefined()
    expect((channel as any).client.downloadFileToLocal).toHaveBeenCalledTimes(1)
  })
})
