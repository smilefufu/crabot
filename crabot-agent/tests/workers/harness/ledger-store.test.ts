import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  LedgerStore,
  dialogObjectIdToFilename,
  filenameToDialogObjectId,
} from '../../../src/workers/harness/ledger-store'
import {
  dialogObjectIdForPrivate,
  dialogObjectIdForGroup,
  type DialogObjectId,
  type LedgerWorker,
} from '../../../src/workers/harness/ledger-types'

function makeWorker(workerId: string, overrides: Partial<LedgerWorker> = {}): LedgerWorker {
  const now = new Date().toISOString()
  return {
    worker_id: workerId,
    task: {
      id: `task-${workerId}`,
      title: 'test task',
      status: 'running',
      created_at: now,
    },
    origin: {
      spawned_by_session: 'wechat::sess-1',
      trigger_type: 'message',
    },
    report_to: { channel_id: 'wechat', session_id: 'sess-1' },
    incarnations: [],
    updated_at: now,
    ...overrides,
  }
}

describe('LedgerStore', () => {
  let dir: string
  let store: LedgerStore

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'ledger-store-test-'))
    store = new LedgerStore(dir)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('upsert 新建 worker 后 getLedger 可见且文件落盘', async () => {
    const id = dialogObjectIdForPrivate('friend-1')
    const result = await store.upsertWorker(id, 'worker-1', (prev) => {
      expect(prev).toBeUndefined()
      return makeWorker('worker-1')
    })
    expect(result?.worker_id).toBe('worker-1')

    const ledger = await store.getLedger(id)
    expect(ledger.dialog_object_id).toBe(id)
    expect(ledger.workers).toHaveLength(1)
    expect(ledger.workers[0].worker_id).toBe('worker-1')

    const filePath = join(dir, dialogObjectIdToFilename(id))
    const raw = await fs.readFile(filePath, 'utf-8')
    const onDisk = JSON.parse(raw)
    expect(onDisk.workers).toHaveLength(1)
    expect(onDisk.workers[0].worker_id).toBe('worker-1')
  })

  it('同一对话对象并发 10 次 upsert 不丢', async () => {
    const id = dialogObjectIdForGroup('wechat', 'group-1')
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.upsertWorker(id, `worker-${i}`, (prev) => {
          expect(prev).toBeUndefined()
          return makeWorker(`worker-${i}`)
        })
      )
    )
    const workers = await store.listWorkers(id)
    expect(workers).toHaveLength(10)
    const ids = new Set(workers.map((w) => w.worker_id))
    expect(ids.size).toBe(10)
  })

  it('findWorker 跨文件命中', async () => {
    const idA = dialogObjectIdForPrivate('friend-a')
    const idB = dialogObjectIdForPrivate('friend-b')
    await store.upsertWorker(idA, 'worker-a', () => makeWorker('worker-a'))
    await store.upsertWorker(idB, 'worker-b', () => makeWorker('worker-b'))

    const foundA = await store.findWorker('worker-a')
    expect(foundA?.dialogObjectId).toBe(idA)
    expect(foundA?.worker.worker_id).toBe('worker-a')

    const foundB = await store.findWorker('worker-b')
    expect(foundB?.dialogObjectId).toBe(idB)
    expect(foundB?.worker.worker_id).toBe('worker-b')
  })

  it('索引未命中时重扫目录再判(外部进程写入的场景)', async () => {
    await store.init()

    // 手工往目录塞一个文件,不经过 store 的写入路径(模拟外部进程写入)
    const externalId = dialogObjectIdForPrivate('friend-external')
    const filename = dialogObjectIdToFilename(externalId)
    const worker = makeWorker('worker-external')
    await fs.writeFile(
      join(dir, filename),
      JSON.stringify({ dialog_object_id: externalId, workers: [worker] }),
      'utf-8'
    )

    const found = await store.findWorker('worker-external')
    expect(found?.dialogObjectId).toBe(externalId)
    expect(found?.worker.worker_id).toBe('worker-external')
  })

  it('文件名编码对含 : 与 / 的 id 双向可逆', () => {
    const idWithSlash = dialogObjectIdForPrivate('user/with:colon') as DialogObjectId
    const idGroup = dialogObjectIdForGroup('chan/nel', 'sess:ion/x')
    for (const id of [idWithSlash, idGroup]) {
      const filename = dialogObjectIdToFilename(id)
      expect(filename.endsWith('.json')).toBe(true)
      const decoded = filenameToDialogObjectId(filename)
      expect(decoded).toBe(id)
    }
  })

  it('mutator 返回 undefined 时不写盘', async () => {
    const id = dialogObjectIdForPrivate('friend-none')
    const result = await store.upsertWorker(id, 'worker-none', () => undefined)
    expect(result).toBeUndefined()

    const filePath = join(dir, dialogObjectIdToFilename(id))
    await expect(fs.access(filePath)).rejects.toThrow()

    const ledger = await store.getLedger(id)
    expect(ledger.workers).toHaveLength(0)
  })

  it('init 扫描遇到坏 JSON 文件时跳过并 warn,不影响其它文件索引', async () => {
    const goodId = dialogObjectIdForPrivate('friend-good')
    await fs.writeFile(join(dir, dialogObjectIdToFilename(goodId)), 'not json', 'utf-8')

    const okId = dialogObjectIdForPrivate('friend-ok')
    await store.upsertWorker(okId, 'worker-ok', () => makeWorker('worker-ok'))

    const otherStore = new LedgerStore(dir)
    const warnSpy = (await import('vitest')).vi.spyOn(console, 'warn').mockImplementation(() => {})
    await otherStore.init()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()

    const found = await otherStore.findWorker('worker-ok')
    expect(found?.worker.worker_id).toBe('worker-ok')
  })

  it('getLedger 读到坏 JSON 文件应抛明确错误,不静默当空', async () => {
    const id = dialogObjectIdForPrivate('friend-corrupt')
    await fs.writeFile(join(dir, dialogObjectIdToFilename(id)), 'not json', 'utf-8')

    await expect(store.getLedger(id)).rejects.toThrow()
  })
})
