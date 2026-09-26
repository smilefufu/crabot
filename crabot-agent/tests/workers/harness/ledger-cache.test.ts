import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LedgerStore, managerKeyToFilename } from '../../../src/workers/harness/ledger-store'
import type { LedgerWorker, ManagerKey } from '../../../src/workers/harness/ledger-types'
const key = 'test::cache' as ManagerKey
const worker = (id: string): LedgerWorker => ({
  worker_id: id, manager_key: key,
  task: { id, title: id, status: 'running', created_at: '2026-09-01T00:00:00Z' },
  origin: { trigger_type: 'message' }, report_to: { channel_id: 'test', session_id: 'cache' },
  incarnations: [], updated_at: '2026-09-01T00:00:00Z',
})
describe('LedgerStore validated read cache', () => {
  let dir: string
  let path: string
  let store: LedgerStore
  const write = (workers: LedgerWorker[]) => fs.writeFile(path, JSON.stringify({ manager_key: key, workers }))
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'ledger-cache-'))
    path = join(dir, managerKeyToFilename(key)); store = new LedgerStore(dir)
  })
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }) })
  it.each([100, 500, 1000])('validates an unchanged %i-worker ledger once for repeated indexed lookups', async (count) => {
    await write(Array.from({ length: count }, (_, i) => worker(`w-${i}`)))
    await store.init()
    const validate = vi.spyOn(store as any, 'assertLedger')
    for (let i = 0; i < count; i++) expect((await store.findWorker(`w-${i}`))?.worker.worker_id).toBe(`w-${i}`)
    expect(validate).toHaveBeenCalledTimes(1)
  })
  it('isolates returned workers and ledgers, and invalidates after upsert', async () => {
    await write([worker('w')])
    ;(await store.findWorker('w'))!.worker.task.title = 'caller mutation'
    ;(await store.getLedger(key)).workers[0].task.title = 'another mutation'
    ;(await store.listAllWorkers())[0].worker.task.title = 'list mutation'
    expect((await store.findWorker('w'))?.worker.task.title).toBe('w')
    await store.upsertWorker(key, 'w', previous => ({ ...previous!, task: { ...previous!.task, title: 'updated' } }))
    expect((await store.findWorker('w'))?.worker.task.title).toBe('updated')
  })
  it('observes external replacement and same-size writes even with restored mtime', async () => {
    await write([worker('w')]); await store.findWorker('w')
    const oldStat = await fs.stat(path)
    const changed = worker('w'); changed.task.title = 'x'
    await write([changed]); await fs.utimes(path, oldStat.atime, oldStat.mtime)
    expect((await store.findWorker('w'))?.worker.task.title).toBe('x')
    changed.task.title = 'y'
    await fs.writeFile(`${path}.new`, JSON.stringify({ manager_key: key, workers: [changed] }))
    await fs.rename(`${path}.new`, path)
    expect((await store.findWorker('w'))?.worker.task.title).toBe('y')
  })
  it('does not fall back after corruption, owner mismatch, or deletion', async () => {
    await write([worker('w')]); await store.findWorker('w')
    await fs.writeFile(path, '{')
    await expect(store.findWorker('w')).rejects.toThrow('invalid ledger')
    await write([worker('w')]); await store.findWorker('w')
    await write([{ ...worker('w'), manager_key: 'test::other' as ManagerKey }])
    await expect(store.findWorker('w')).rejects.toThrow('manager_key mismatch')
    await write([worker('w')]); await store.findWorker('w')
    await fs.unlink(path)
    await expect(store.findWorker('w')).rejects.toThrow('index inconsistent')
  })
  it('does not cache bytes read while the path is replaced', async () => {
    await write([worker('w')]); await store.init()
    const open = fs.open.bind(fs)
    const changed = worker('w'); changed.task.title = 'replacement'
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args)
      const read = handle.readFile.bind(handle)
      vi.spyOn(handle, 'readFile').mockImplementationOnce(async (...readArgs: any[]) => {
        const raw = await (read as any)(...readArgs)
        await fs.writeFile(`${path}.new`, JSON.stringify({ manager_key: key, workers: [changed] }))
        await fs.rename(`${path}.new`, path)
        return raw
      })
      return handle
    })
    expect((await store.findWorker('w'))?.worker.task.title).toBe('w')
    expect((await store.findWorker('w'))?.worker.task.title).toBe('replacement')
  })

  it('fails on metadata errors and invalidates before failed writes', async () => {
    await write([worker('w')]); await store.findWorker('w')
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await expect(store.findWorker('w')).rejects.toThrow('denied')
    vi.restoreAllMocks()
    await store.findWorker('w')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('write failed'))
    await expect(store.upsertWorker(key, 'w', previous => {
      previous!.task.title = 'not committed'; return previous
    })).rejects.toThrow('write failed')
    expect((await store.findWorker('w'))?.worker.task.title).toBe('w')
  })

  it('does not bind a migration write to its old version', async () => {
    await write([worker('w')]); await store.init()
    const old = worker('w'); (old.task as any).status = 'completed'
    await write([old])
    expect((await store.findWorker('w'))?.worker.task.status).toBe('closed')
    const persisted = JSON.parse(await fs.readFile(path, 'utf-8'))
    expect(persisted.workers[0].task.status).toBe('closed')
    const validate = vi.spyOn(store as any, 'assertLedger')
    await store.findWorker('w'); await store.findWorker('w')
    expect(validate).toHaveBeenCalledTimes(1)
  })

  it('evicts least recently used ledgers when their combined raw bytes exceed the budget', async () => {
    const otherKey = 'test::other' as ManagerKey
    const other = { ...worker('other'), manager_key: otherKey }
    const padding = ' '.repeat(33 * 1024 * 1024)
    await fs.writeFile(path, JSON.stringify({ manager_key: key, workers: [worker('w')] }) + padding)
    await fs.writeFile(join(dir, managerKeyToFilename(otherKey)), JSON.stringify({ manager_key: otherKey, workers: [other] }) + padding)
    await store.init()
    const validate = vi.spyOn(store as any, 'assertLedger')
    await store.findWorker('w'); await store.findWorker('other'); await store.findWorker('other'); await store.findWorker('w')
    expect(validate).toHaveBeenCalledTimes(3)
  })

  it('reads oversized ledgers correctly without retaining them', async () => {
    await fs.writeFile(path, JSON.stringify({ manager_key: key, workers: [worker('w')] }) + ' '.repeat(65 * 1024 * 1024))
    await store.init()
    const validate = vi.spyOn(store as any, 'assertLedger')
    await store.findWorker('w'); await store.findWorker('w')
    expect(validate).toHaveBeenCalledTimes(2)
  })

})
