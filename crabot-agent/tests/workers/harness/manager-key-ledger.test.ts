import { describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { LedgerStore, managerKeyToFilename, isManagerKey } from '../../../src/workers/harness/ledger-store.js'
import type { LedgerWorker, ManagerKey } from '../../../src/workers/harness/ledger-types.js'

const KEY_A = 'wechat::session-a' as ManagerKey
const KEY_B = 'telegram::session-b' as ManagerKey

function worker(workerId: string, managerKey: ManagerKey = KEY_A): LedgerWorker {
  const now = '2026-08-10T00:00:00.000Z'
  return {
    worker_id: workerId,
    manager_key: managerKey,
    task: { id: workerId, title: workerId, status: 'running', created_at: now },
    origin: { trigger_type: 'message' },
    report_to: { channel_id: 'wechat', session_id: 'session-a' },
    incarnations: [],
    updated_at: now,
  }
}

describe('ManagerKey ledger contract', () => {
  it('stores separate ledgers by manager key and ignores a sibling legacy ledgers directory', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'manager-ledger-red-'))
    try {
      const dir = join(root, 'worker-ledgers')
      await fs.mkdir(join(root, 'ledgers'), { recursive: true })
      await fs.writeFile(join(root, 'ledgers', 'friend%3Alegacy.json'), JSON.stringify({ workers: [worker('legacy')] }))
      const store = new LedgerStore(dir)
      await store.upsertWorker(KEY_A, 'a', () => worker('a'))
      await store.upsertWorker(KEY_B, 'b', () => worker('b', KEY_B))
      expect((await store.listWorkers(KEY_A)).map(w => w.worker_id)).toEqual(['a'])
      expect((await store.listWorkers(KEY_B)).map(w => w.worker_id)).toEqual(['b'])
      expect((await store.listAllWorkers()).map(entry => entry.worker.worker_id).sort()).toEqual(['a', 'b'])
      expect(managerKeyToFilename(KEY_A)).toContain('wechat%3A%3Asession-a')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('rejects file/worker owner mismatch, immutable-owner mutation, and duplicate IDs across files', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'manager-ledger-red-'))
    try {
      const store = new LedgerStore(dir)
      await expect(store.upsertWorker(KEY_A, 'wrong', () => worker('wrong', KEY_B))).rejects.toThrow(/manager_key/)
      await store.upsertWorker(KEY_A, 'same', () => worker('same'))
      await expect(store.upsertWorker(KEY_A, 'same', () => worker('same', KEY_B))).rejects.toThrow(/manager_key/)
      await fs.writeFile(join(dir, managerKeyToFilename(KEY_B)), JSON.stringify({ manager_key: KEY_B, workers: [worker('same', KEY_B)] }))
      await expect(new LedgerStore(dir).init()).rejects.toThrow(/duplicate worker_id/i)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
  it('serializes concurrent same-worker upserts across ManagerKeys and validates the returned worker id', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'manager-ledger-race-'))
    try {
      const store = new LedgerStore(dir)
      const results = await Promise.allSettled([
        store.upsertWorker(KEY_A, 'shared', () => worker('shared')),
        store.upsertWorker(KEY_B, 'shared', () => worker('shared', KEY_B)),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      expect((await store.listAllWorkers()).filter(entry => entry.worker.worker_id === 'shared')).toHaveLength(1)
      await expect(store.upsertWorker(KEY_A, 'requested', () => worker('returned'))).rejects.toThrow(/worker_id mismatch/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('fails loud for malformed manager keys and non-canonical ledger filenames', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'manager-ledger-filenames-'))
    try {
      expect(isManagerKey('channel::session::nested')).toBe(true)
      expect(isManagerKey('::session')).toBe(false)
      expect(isManagerKey('channel::')).toBe(false)

      const store = new LedgerStore(dir)
      await expect(
        store.upsertWorker('bad' as ManagerKey, 'bad-worker', () => worker('bad-worker', 'bad' as ManagerKey)),
      ).rejects.toThrow(/invalid manager_key/)
      expect(await fs.readdir(dir)).toEqual([])

      await fs.writeFile(join(dir, 'channel::session.json'), '{}')
      await expect(new LedgerStore(dir).init()).rejects.toThrow(/non-canonical ledger filename/)
      await fs.rm(join(dir, 'channel::session.json'))
      await fs.writeFile(join(dir, 'channel%3A%3A.json'), '{}')
      await expect(new LedgerStore(dir).init()).rejects.toThrow(/invalid.*ledger filename/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
