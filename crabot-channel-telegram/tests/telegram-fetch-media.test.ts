import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { TelegramChannel } from '../src/telegram-channel'

let tmpDir: string
let channel: TelegramChannel

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fetch-'))
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

describe('telegram fetch_media RPC', () => {
  it('capability 含 supports_media_fetch=true', () => {
    const caps = (channel as any).handleGetCapabilities()
    expect(caps.supports_media_fetch).toBe(true)
  })

  it('凭 handle 同步下载并返回 file_path（status=ready）', async () => {
    const mediaDir = path.join(tmpDir, 'media')
    fs.mkdirSync(mediaDir, { recursive: true })

    const fakeLocalPath = path.join(mediaDir, 'file_unique_abc.pdf')
    fs.writeFileSync(fakeLocalPath, 'hello pdf')

    ;(channel as any).client.downloadFileToLocal = vi.fn(async () => ({
      localPath: fakeLocalPath,
      filePath: 'some/file_path',
    }))

    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file',
      filename: 'a.pdf',
      credential: { file_id: 'file_abc123' },
    })

    const res = await (channel as any).handleFetchMedia({ handle })
    expect(res.status).toBe('ready')
    expect(res.file_path).toBe(fakeLocalPath)
    expect(fs.existsSync(res.file_path)).toBe(true)
  })

  it('未知 handle → status=failed', async () => {
    const res = await (channel as any).handleFetchMedia({ handle: 'fm_000000000000' })
    expect(res.status).toBe('failed')
    expect(res.error).toBeTruthy()
  })

  it('下载抛错 → status=failed', async () => {
    ;(channel as any).client.downloadFileToLocal = vi.fn(async () => {
      throw new Error('网络错误')
    })

    const handle = await (channel as any).mediaHandleStore.put({
      kind: 'file',
      filename: 'b.pdf',
      credential: { file_id: 'file_err' },
    })

    const res = await (channel as any).handleFetchMedia({ handle })
    expect(res.status).toBe('failed')
  })
})
