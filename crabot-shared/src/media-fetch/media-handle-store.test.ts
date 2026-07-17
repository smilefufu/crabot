import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MediaHandleStore } from './media-handle-store.js'

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mhs-test-'))
}

test('put 返回 fm_ 前缀的 12 位 hex handle', async () => {
  const store = new MediaHandleStore(mkdtemp())
  const handle = await store.put({ kind: 'image', credential: { url: 'https://example.com/img.png' } })
  assert.match(handle, /^fm_[0-9a-f]{12}$/)
})

test('get 取回与 credential 相符的 record', async () => {
  const store = new MediaHandleStore(mkdtemp())
  const credential = { platform_message_id: 'msg_001', file_key: 'fk_abc' }
  const handle = await store.put({ kind: 'file', filename: 'report.pdf', credential })
  const rec = store.get(handle)
  assert.ok(rec)
  assert.equal(rec.kind, 'file')
  assert.equal(rec.filename, 'report.pdf')
  assert.deepEqual(rec.credential, credential)
})

test('markDownloaded 写入 downloaded_file_path', async () => {
  const dir = mkdtemp()
  const store = new MediaHandleStore(dir)
  const handle = await store.put({ kind: 'image', credential: {} })
  const filePath = path.join(dir, 'img.jpg')
  await store.markDownloaded(handle, filePath)
  const rec = store.get(handle)
  assert.ok(rec)
  assert.equal(rec.downloaded_file_path, filePath)
})

test('setSessionId 写入 session_id', async () => {
  const store = new MediaHandleStore(mkdtemp())
  const handle = await store.put({ kind: 'file', credential: {} })
  await store.setSessionId(handle, 'sess_xyz')
  const rec = store.get(handle)
  assert.ok(rec)
  assert.equal(rec.session_id, 'sess_xyz')
})

test('init 从磁盘恢复 records', async () => {
  const dir = mkdtemp()
  const store1 = new MediaHandleStore(dir)
  const cred = { file_id: 'tg_12345' }
  const handle = await store1.put({ kind: 'file', credential: cred })

  const store2 = new MediaHandleStore(dir)
  await store2.init()
  const rec = store2.get(handle)
  assert.ok(rec)
  assert.deepEqual(rec.credential, cred)
})

test('未知 handle 的 get 返回 undefined', () => {
  const store = new MediaHandleStore(mkdtemp())
  assert.equal(store.get('fm_nonexistent'), undefined)
})

test('未知 handle 的 markDownloaded 静默 no-op', async () => {
  const store = new MediaHandleStore(mkdtemp())
  // 不应抛错
  await store.markDownloaded('fm_nonexistent', '/some/path')
})

test('未知 handle 的 setSessionId 静默 no-op', async () => {
  const store = new MediaHandleStore(mkdtemp())
  // 不应抛错
  await store.setSessionId('fm_nonexistent', 'sess_abc')
})

test('findByCredential 按 credential 找到已有 handle', async () => {
  const store = new MediaHandleStore(mkdtemp())
  const credA = { platform_message_id: 'msg_001', file_key: 'fk_abc' }
  const credB = { platform_message_id: 'msg_002', file_key: 'fk_xyz' }
  const handleA = await store.put({ kind: 'file', credential: credA })
  await store.put({ kind: 'file', credential: credB })

  const found = store.findByCredential({ platform_message_id: 'msg_001', file_key: 'fk_abc' })
  assert.equal(found, handleA)
})

test('findByCredential 不存在的 credential 返回 undefined', () => {
  const store = new MediaHandleStore(mkdtemp())
  assert.equal(store.findByCredential({ platform_message_id: 'msg_999', file_key: 'noexist' }), undefined)
})

test('findByCredential 空 store 返回 undefined', () => {
  const store = new MediaHandleStore(mkdtemp())
  assert.equal(store.findByCredential({ anything: 'x' }), undefined)
})

test('findByCredential 部分匹配不命中', async () => {
  const store = new MediaHandleStore(mkdtemp())
  await store.put({ kind: 'file', credential: { platform_message_id: 'msg_001', file_key: 'fk_abc' } })
  // 只提供 platform_message_id 不提供 file_key → 不匹配
  assert.equal(store.findByCredential({ platform_message_id: 'msg_001' }), undefined)
  // 多一个字段也不匹配
  assert.equal(store.findByCredential({ platform_message_id: 'msg_001', file_key: 'fk_abc', extra: 'x' }), undefined)
})

test('findByCredential 忽略顺序差异', async () => {
  const store = new MediaHandleStore(mkdtemp())
  const handle = await store.put({ kind: 'file', credential: { file_key: 'fk_abc', platform_message_id: 'msg_001' } })
  // 查询时顺序不同
  const found = store.findByCredential({ platform_message_id: 'msg_001', file_key: 'fk_abc' })
  assert.equal(found, handle)
})
