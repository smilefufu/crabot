import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MediaHandleStore } from './media-handle-store.js'
import { MediaFetchManager } from './media-fetch-manager.js'
import type { MediaHandleRecord, DownloadResult } from './types.js'
import type { Event } from '../base-protocol.js'

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mfm-test-'))
}

function makeStore(dir?: string): MediaHandleStore {
  return new MediaHandleStore(dir ?? mkdtemp())
}

function makePublisher(): { fn: (e: Event) => Promise<void>; events: Event[] } {
  const events: Event[] = []
  return {
    fn: async (e: Event) => { events.push(e) },
    events,
  }
}

test('未知 handle 返回 failed', async () => {
  const store = makeStore()
  const pub = makePublisher()
  const mgr = new MediaFetchManager({
    store,
    channelId: 'ch_test',
    download: async () => null,
    publishEvent: pub.fn,
  })
  const result = await mgr.fetch('fm_unknown')
  assert.equal(result.status, 'failed')
  assert.ok(result.error?.includes('unknown media handle'))
})

test('size > maxFileSize 返回 failed', async () => {
  const store = makeStore()
  const pub = makePublisher()
  const handle = await store.put({ kind: 'file', size: 200 * 1024 * 1024, credential: {} })
  const mgr = new MediaFetchManager({
    store,
    channelId: 'ch_test',
    download: async () => null,
    publishEvent: pub.fn,
    maxFileSizeBytes: 100 * 1024 * 1024,
  })
  const result = await mgr.fetch(handle)
  assert.equal(result.status, 'failed')
  assert.ok(result.error?.includes('file too large'))
})

test('缓存命中（downloaded_file_path 存在）返回 ready', async () => {
  const dir = mkdtemp()
  const store = makeStore(dir)
  const pub = makePublisher()

  // 创建真实文件
  const filePath = path.join(dir, 'cached.jpg')
  await fsp.writeFile(filePath, 'fake-image-data')

  const handle = await store.put({ kind: 'image', mime_type: 'image/jpeg', size: 100, credential: {} })
  await store.markDownloaded(handle, filePath)

  const mgr = new MediaFetchManager({
    store,
    channelId: 'ch_test',
    download: async () => { throw new Error('should not be called') },
    publishEvent: pub.fn,
  })

  const result = await mgr.fetch(handle)
  assert.equal(result.status, 'ready')
  assert.equal(result.file_path, filePath)
  assert.equal(result.mime_type, 'image/jpeg')
  assert.equal(result.size, 100)
})

test('小文件同步下载 → ready + markDownloaded 被调', async () => {
  const dir = mkdtemp()
  const store = makeStore(dir)
  const pub = makePublisher()

  // 真实文件
  const filePath = path.join(dir, 'small.pdf')
  await fsp.writeFile(filePath, 'pdf-content')

  let downloadCalled = 0
  const handle = await store.put({ kind: 'file', size: 1024, credential: { file_id: 'abc' } })

  const mgr = new MediaFetchManager({
    store,
    channelId: 'ch_test',
    download: async (_rec: MediaHandleRecord): Promise<DownloadResult> => {
      downloadCalled++
      return { filePath, mimeType: 'application/pdf', size: 1024 }
    },
    publishEvent: pub.fn,
  })

  const result = await mgr.fetch(handle)
  assert.equal(result.status, 'ready')
  assert.equal(result.file_path, filePath)
  assert.equal(result.mime_type, 'application/pdf')
  assert.equal(downloadCalled, 1)

  // markDownloaded 应已写回
  const rec = store.get(handle)
  assert.equal(rec?.downloaded_file_path, filePath)
})

test('大文件（size >= asyncThreshold）立即返回 fetching，后台下载后 publishEvent 触发一次 status=ready', async () => {
  const dir = mkdtemp()
  const store = makeStore(dir)
  const pub = makePublisher()

  const filePath = path.join(dir, 'big.zip')
  await fsp.writeFile(filePath, 'big-data')

  const tenMB = 10 * 1024 * 1024
  const handle = await store.put({ kind: 'file', size: tenMB, session_id: 'sess_abc', credential: {} })

  const mgr = new MediaFetchManager({
    store,
    channelId: 'ch_feishu',
    download: async (): Promise<DownloadResult> => {
      return { filePath, size: tenMB }
    },
    publishEvent: pub.fn,
    asyncThresholdBytes: tenMB,
  })

  const result = await mgr.fetch(handle)
  assert.equal(result.status, 'fetching')

  // 等待后台任务完成
  await new Promise<void>((r) => setTimeout(r, 30))

  assert.equal(pub.events.length, 1)
  const evt = pub.events[0]
  assert.ok(evt)
  assert.equal(evt.type, 'media.download_completed')
  const payload = evt.payload as Record<string, unknown>
  assert.equal(payload['status'], 'ready')
  assert.equal(payload['channel_id'], 'ch_feishu')
  assert.equal(payload['session_id'], 'sess_abc')
  assert.equal(payload['handle'], handle)
})

test('同步下载抛错 → 返回 failed，error 为异常 message，不向上抛', async () => {
  const store = makeStore()
  const pub = makePublisher()
  const handle = await store.put({ kind: 'file', size: 1024, credential: {} })

  const mgr = new MediaFetchManager({
    store,
    channelId: 'ch_test',
    download: async (): Promise<DownloadResult | null> => {
      throw new Error('文件在微信渠道侧尚未下载完成')
    },
    publishEvent: pub.fn,
  })

  const result = await mgr.fetch(handle)
  assert.equal(result.status, 'failed')
  assert.ok(result.error?.includes('文件在微信渠道侧尚未下载完成'))
})

test('后台下载抛错 → publishEvent 事件 status=failed', async () => {
  const dir = mkdtemp()
  const store = makeStore(dir)
  const pub = makePublisher()

  const tenMB = 10 * 1024 * 1024
  const handle = await store.put({ kind: 'file', size: tenMB, credential: {} })

  const mgr = new MediaFetchManager({
    store,
    channelId: 'ch_test',
    download: async (): Promise<DownloadResult | null> => {
      throw new Error('network failure')
    },
    publishEvent: pub.fn,
    asyncThresholdBytes: tenMB,
  })

  await mgr.fetch(handle)
  await new Promise<void>((r) => setTimeout(r, 30))

  assert.equal(pub.events.length, 1)
  const payload = pub.events[0]?.payload as Record<string, unknown>
  assert.equal(payload['status'], 'failed')
  assert.ok((payload['error'] as string).includes('network failure'))
})

test('后台下载返回 null → publishEvent 事件 status=failed', async () => {
  const dir = mkdtemp()
  const store = makeStore(dir)
  const pub = makePublisher()

  const tenMB = 10 * 1024 * 1024
  const handle = await store.put({ kind: 'file', size: tenMB, credential: {} })

  const mgr = new MediaFetchManager({
    store,
    channelId: 'ch_test',
    download: async (): Promise<null> => null,
    publishEvent: pub.fn,
    asyncThresholdBytes: tenMB,
  })

  await mgr.fetch(handle)
  await new Promise<void>((r) => setTimeout(r, 30))

  assert.equal(pub.events.length, 1)
  const payload = pub.events[0]?.payload as Record<string, unknown>
  assert.equal(payload['status'], 'failed')
  assert.ok((payload['error'] as string).includes('download failed'))
})
