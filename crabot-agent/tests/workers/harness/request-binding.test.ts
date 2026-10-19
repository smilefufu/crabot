import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkerContextStore } from '../../../src/workers/harness/context-store.js'
import { LedgerStore, managerKeyToFilename } from '../../../src/workers/harness/ledger-store.js'
import type { LedgerWorker } from '../../../src/workers/harness/ledger-types.js'

const key = 'voice::shared' as const
const binding = { schema_version: 1 as const, request_id: 'a'.repeat(64), source_sha256: 'b'.repeat(64), execution_scope: 'request' as const }
const context = () => ({ schema_version: 2 as const, manager_key: key, target_session: { channel_id: 'voice', session_id: 'shared', type: 'group' as const }, request: { ...binding } })
const worker = (id: string, request = false): LedgerWorker => ({ worker_id: id, manager_key: key, task: { id, title: id, status: 'queued', created_at: '2026-10-16T00:00:00.000Z' },
  origin: { trigger_type: 'message', ...(request ? { request: { ...binding } } : {}) }, report_to: { channel_id: 'voice', session_id: 'shared' }, incarnations: [], updated_at: '2026-10-16T00:00:00.000Z' })

describe('Versioned Worker request binding cannot silently become legacy authority', () => {
  let root: string
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-request-binding-')) })
  afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })
  it('round-trips an exact v2 context with real group target and immutable request identity', async () => {
    const store = new WorkerContextStore(root), value = context()
    expect(await store.write('w-1', value)).toEqual(value)
    expect(await new WorkerContextStore(root).read('w-1')).toEqual(value)
    await expect(store.write('w-1', { ...value, request: { ...binding, request_id: 'c'.repeat(64) } })).rejects.toThrow(/immutable/i)
    await expect(store.write('w-1', {})).rejects.toThrow(/immutable/i)
    expect(await store.read('w-1')).toEqual(value)
  })
  it('never backfills request authority into a historical context or accepts malformed/newer request context', async () => {
    const store = new WorkerContextStore(root); await store.write('legacy', {})
    await expect(store.write('legacy', context())).rejects.toThrow(/historical/i)
    expect(await store.read('legacy')).toEqual({})
    for (const change of [(v: any) => delete v.schema_version, (v: any) => v.schema_version = 3, (v: any) => delete v.request, (v: any) => v.target_session.type = 'private', (v: any) => v.manager_key = 'voice::other', (v: any) => v.request.source_sha256 = 'not-a-hash', (v: any) => v.request.execution_scope = 'self', (v: any) => v.request.extra = true]) {
      const value = context(); change(value)
      await expect(store.write('invalid', value)).rejects.toThrow()
    }
  })
  it('serializes same-Worker context writes so two request identities cannot overwrite each other', async () => {
    const store = new WorkerContextStore(root)
    const values = [context(), { ...context(), request: { ...binding, request_id: 'c'.repeat(64) } }]
    const result = await Promise.allSettled(values.map(value => store.write('w-1', value)))
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect((await store.read('w-1'))?.request).toEqual(binding)
  })
  it('leaves invalid or future existing context intact instead of overwriting evidence', async () => {
    const store = new WorkerContextStore(root); await fs.mkdir(path.join(root, 'w-1'))
    const target = path.join(root, 'w-1', 'context.json')
    for (const invalid of ['{', JSON.stringify({ ...context(), schema_version: 999 })]) {
      await fs.writeFile(target, invalid)
      await expect(store.write('w-1', context())).rejects.toThrow()
      expect(await fs.readFile(target, 'utf8')).toBe(invalid)
    }
  })
  it('preserves legacy ledger bytes in a verified backup before enabling an old-reader-rejecting envelope', async () => {
    const store = new LedgerStore(root), target = path.join(root, managerKeyToFilename(key))
    await store.upsertWorker(key, 'legacy', () => worker('legacy')); const old = await fs.readFile(target, 'utf8')
    await store.upsertWorker(key, 'new', () => worker('new', true))
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600)
    const physical = JSON.parse(await fs.readFile(target, 'utf8'))
    expect(physical.schema_version).toBe(1); expect(physical.manager_key).toBeUndefined(); expect(physical.workers).toBeUndefined()
    expect(physical.ledger.workers.map((item: LedgerWorker) => item.worker_id)).toEqual(['legacy', 'new'])
    const backups = (await fs.readdir(root)).filter(name => name.includes('.pre-request-'))
    expect(backups).toHaveLength(1); expect(await fs.readFile(path.join(root, backups[0]), 'utf8')).toBe(old)
    expect((await fs.stat(path.join(root, backups[0]))).mode & 0o777).toBe(0o600)
    const loaded = await new LedgerStore(root).getLedger(key)
    expect(loaded.workers[0].origin.request).toBeUndefined(); expect(loaded.workers[1].origin.request).toEqual(binding)
  })
  it('cannot attach, remove or replace a binding on an existing Worker and preserves the envelope across old-worker updates', async () => {
    const store = new LedgerStore(root), target = path.join(root, managerKeyToFilename(key))
    await store.upsertWorker(key, 'legacy', () => worker('legacy'))
    await expect(store.upsertWorker(key, 'legacy', () => worker('legacy', true))).rejects.toThrow(/immutable|historical/i)
    await store.upsertWorker(key, 'new', () => worker('new', true))
    await expect(store.upsertWorker(key, 'new', previous => ({ ...previous!, origin: { trigger_type: 'message' } }))).rejects.toThrow(/immutable/i)
    await expect(store.upsertWorker(key, 'new', previous => ({ ...previous!, origin: { trigger_type: 'message', request: { ...binding, execution_scope: 'group' } } }))).rejects.toThrow(/immutable/i)
    await store.upsertWorker(key, 'legacy', previous => ({ ...previous!, task: { ...previous!.task, title: 'updated old task' } }))
    expect(JSON.parse(await fs.readFile(target, 'utf8')).schema_version).toBe(1)
    expect((await store.findWorker('new'))?.worker.origin.request).toEqual(binding)
  })
  it('backup failures block migration without publishing the new Worker or replacing old bytes', async () => {
    const store = new LedgerStore(root), target = path.join(root, managerKeyToFilename(key))
    await store.upsertWorker(key, 'legacy', () => worker('legacy')); const old = await fs.readFile(target, 'utf8')
    const write = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: any[]) => {
      if (String(args[0]).includes('.pre-request-')) throw new Error('backup unavailable')
      return (write as any)(...args)
    })
    await expect(store.upsertWorker(key, 'new', () => worker('new', true))).rejects.toThrow('backup unavailable')
    expect(await fs.readFile(target, 'utf8')).toBe(old); expect(await store.findWorker('new')).toBeUndefined()
  })
  it('a failed migration commit preserves old state and backup, cleans temporary data, and can retry safely', async () => {
    const store = new LedgerStore(root), target = path.join(root, managerKeyToFilename(key))
    await store.upsertWorker(key, 'legacy', () => worker('legacy')); const old = await fs.readFile(target, 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('failed ledger commit'))
    await expect(store.upsertWorker(key, 'new', () => worker('new', true))).rejects.toThrow('failed ledger commit')
    expect(await fs.readFile(target, 'utf8')).toBe(old); expect((await fs.readdir(root)).filter(name => name.startsWith('.tmp-'))).toEqual([])
    const [backup] = (await fs.readdir(root)).filter(name => name.includes('.pre-request-'))
    expect(await fs.readFile(path.join(root, backup), 'utf8')).toBe(old)
    await store.upsertWorker(key, 'new', () => worker('new', true))
    expect((await store.findWorker('new'))?.worker.origin.request).toEqual(binding)
  })
  it('rejects future envelopes, malformed bindings and unwrapped request Workers, preserving the original file', async () => {
    const target = path.join(root, managerKeyToFilename(key))
    const variants = [{ schema_version: 2, ledger: { manager_key: key, workers: [] } }, { schema_version: 1, extra: true, ledger: { manager_key: key, workers: [] } },
      { manager_key: key, workers: [worker('new', true)] }, { schema_version: 1, ledger: { manager_key: key, workers: [{ ...worker('new', true), origin: { trigger_type: 'message', request: { ...binding, source_sha256: 'bad' } } }] } }]
    for (const value of variants) {
      const raw = JSON.stringify(value); await fs.writeFile(target, raw)
      await expect(new LedgerStore(root).getLedger(key)).rejects.toThrow()
      expect(await fs.readFile(target, 'utf8')).toBe(raw)
    }
  })
})
