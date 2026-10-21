import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { realpathSync, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { sha256CanonicalJson } from 'crabot-shared'
import { captureWorkspaceRelocationLedgers } from '../../src/core/workspace-relocation-ledgers.js'
import { commitWorkspaceRelocationLedgers } from '../../src/core/workspace-relocation-commit.js'
import { prepareWorkspaceRelocationWorkerClosure } from '../../src/workers/harness/workspace-relocation-close.js'
import { captureWorkspaceRelocationWorkers } from '../../src/workers/harness/workspace-relocation-scope.js'
import { managerKeyToFilename } from '../../src/workers/harness/ledger-store.js'
import type { LedgerWorker } from '../../src/workers/harness/ledger-types.js'
const native = require('../../../scripts/lib/process-identity.cjs')
const id = '12345678-1234-4123-8123-123456789abc', closedAt = '2026-10-21T01:00:00.000Z'
const fileVersion = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(':')
const digest = (body: string) => createHash('sha256').update(body).digest('hex')

describe('Agent-owned fixed-plan ledger commits (no business Agent startup)', () => {
  let root: string, data: string, directory: string, file: string, original: string, workers: ReturnType<typeof captureWorkspaceRelocationWorkers>, plan: any
  beforeEach(async () => {
    root = realpathSync(await fs.mkdtemp(path.join(tmpdir(), 'crabot-closure-commit-')))
    data = path.join(root, 'data')
    if (process.platform === 'win32') { native.createPrivateDirectory(data); native.createPrivateDirectory(path.join(data, 'workspace-control')) }
    else { await fs.mkdir(data, { mode: 0o700 }); await fs.mkdir(path.join(data, 'workspace-control'), { mode: 0o700 }) }
    directory = path.join(data, 'agent/worker-ledgers'); await fs.mkdir(directory, { recursive: true })
    file = path.join(directory, managerKeyToFilename('channel::original'))
    const worker: LedgerWorker = { worker_id: 'original-worker', manager_key: 'channel::original',
      task: { id: 'original-task', title: 'retain the original goal', status: 'halted', created_at: closedAt, halt: { halted_at: closedAt, halt_reason: 'turn_end' } },
      origin: { trigger_type: 'scheduled' }, report_to: { channel_id: 'channel', session_id: 'original' }, incarnations: [], updated_at: closedAt }
    original = JSON.stringify({ manager_key: worker.manager_key, workers: [worker] }, null, 4) + '\n'
    await fs.writeFile(file, original, { mode: 0o600 })
    workers = captureWorkspaceRelocationWorkers([{ managerKey: worker.manager_key, worker }])
    const snapshot = await captureWorkspaceRelocationLedgers(data), [prepared] = prepareWorkspaceRelocationWorkerClosure({ intentId: id, closedAt, workers, ledgers: snapshot.files })
    plan = { schema_version: 1, intent_id: id, closed_at: closedAt, directories: snapshot.directories, names: snapshot.names,
      ledgers: [{ name: snapshot.files[0].name, manager_key: prepared.manager_key, before_version: snapshot.files[0].version,
        before_sha256: prepared.before_sha256, after_sha256: prepared.after_sha256, closed_worker_ids: prepared.closed_worker_ids }] }
  })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
  const run = async (data: string, workers: ReturnType<typeof captureWorkspaceRelocationWorkers>, plan: any, verify = async () => {}) => {
    const snapshot = await captureWorkspaceRelocationLedgers(data)
    const prepared = prepareWorkspaceRelocationWorkerClosure({ intentId: id, closedAt, workers, ledgers: snapshot.files })
    return commitWorkspaceRelocationLedgers({ snapshot, plan, prepared, verify })
  }
  it('commits exact prepared bytes, keeps ownership/history and observes without rewriting after completion', async () => {
    const result = await run(data, workers, plan), body = await fs.readFile(file, 'utf8'), stat = await fs.stat(file, { bigint: true })
    expect(result.dispatch).toBe('dispatch'); expect(result.closed_ledgers).toBe(1)
    expect(digest(body)).toBe(plan.ledgers[0].after_sha256)
    expect(JSON.parse(body).workers[0]).toMatchObject({ origin: JSON.parse(original).workers[0].origin,
      report_to: JSON.parse(original).workers[0].report_to, task: { title: 'retain the original goal', status: 'closed', closed: { by: 'migration', at: closedAt } } })
    const again = await run(data, workers, plan)
    expect(again).toEqual({ ...result, dispatch: 'observe' })
    expect(fileVersion(await fs.stat(file, { bigint: true }))).toBe(fileVersion(stat))
    const journal = path.join(data, 'workspace-control/relocation-worker-commits')
    expect((await fs.readdir(journal)).sort()).toEqual(['0.closed.json', '0.prepared.json', 'complete.json', 'header.json'])
    expect((await Promise.all((await fs.readdir(journal)).map(name => fs.readFile(path.join(journal, name), 'utf8')))).join('')).not.toContain('retain the original goal')
  })
  it('denied current authority creates no journal and leaves the ledger unchanged', async () => {
    await expect(run(data, workers, plan, async () => { throw new Error('original role unavailable') })).rejects.toThrow()
    expect(await fs.readFile(file, 'utf8')).toBe(original)
    await expect(fs.lstat(path.join(data, 'workspace-control/relocation-worker-commits'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects a changed original ledger before any write', async () => {
    await fs.writeFile(file, original + ' ')
    await expect(run(data, workers, plan)).rejects.toThrow()
    expect(await fs.readFile(file, 'utf8')).toBe(original + ' ')
  })
  it('does not take over a pre-existing unbound journal directory', async () => {
    const journal = path.join(data, 'workspace-control/relocation-worker-commits'); await fs.mkdir(journal, { mode: 0o700 })
    await fs.writeFile(path.join(journal, 'unrelated'), 'preserve')
    await expect(run(data, workers, plan)).rejects.toThrow()
    expect(await fs.readFile(file, 'utf8')).toBe(original)
    expect(await fs.readFile(path.join(journal, 'unrelated'), 'utf8')).toBe('preserve')
  })
  for (const boundary of ['prepared', 'replaced', 'closed']) it('continues the same fixed commit after interruption at ' + boundary, async () => {
    const journal = path.join(data, 'workspace-control/relocation-worker-commits')
    let interrupted = false
    const verify = async () => {
      const has = async (name: string) => fs.lstat(path.join(journal, name)).then(() => true, () => false)
      const stop = boundary === 'prepared' ? await has('0.prepared.json') : boundary === 'closed' ? await has('0.closed.json')
        : digest(await fs.readFile(file, 'utf8')) === plan.ledgers[0].after_sha256
      if (stop && !interrupted) { interrupted = true; throw new Error('lost current original authorization') }
    }
    await expect(run(data, workers, plan, verify)).rejects.toThrow()
    expect(interrupted).toBe(true)
    const before = await fs.stat(file, { bigint: true }), body = await fs.readFile(file, 'utf8')
    if (boundary === 'prepared') expect(body).toBe(original)
    else expect(digest(body)).toBe(plan.ledgers[0].after_sha256)
    await run(data, workers, plan)
    expect(digest(await fs.readFile(file, 'utf8'))).toBe(plan.ledgers[0].after_sha256)
    if (boundary !== 'prepared') expect(fileVersion(await fs.stat(file, { bigint: true }))).toBe(fileVersion(before))
  })
  it('does not adopt a same-content replacement for a registered temporary file', async () => {
    const journal = path.join(data, 'workspace-control/relocation-worker-commits')
    await expect(run(data, workers, plan, async () => {
      if (await fs.lstat(path.join(journal, '0.prepared.json')).then(() => true, () => false)) throw new Error('stop before rename')
    })).rejects.toThrow()
    const fact = JSON.parse(await fs.readFile(path.join(journal, '0.prepared.json'), 'utf8')), temp = path.join(directory, fact.temporary)
    const body = await fs.readFile(temp), kept = path.join(root, 'retained-temp'); await fs.rename(temp, kept); await fs.writeFile(temp, body, { mode: 0o600 })
    await expect(run(data, workers, plan)).rejects.toThrow()
    expect(await fs.readFile(file, 'utf8')).toBe(original)
    expect(await fs.readFile(kept)).toEqual(body)
  })
  it('does not accept an unregistered already-closed target as an authorized effect', async () => {
    await run(data, workers, plan)
    const journal = path.join(data, 'workspace-control/relocation-worker-commits')
    await fs.unlink(path.join(journal, '0.prepared.json')); await fs.unlink(path.join(journal, '0.closed.json')); await fs.unlink(path.join(journal, 'complete.json'))
    const before = await fs.readFile(file)
    await expect(run(data, workers, plan)).rejects.toThrow()
    expect(await fs.readFile(file)).toEqual(before)
  })
  it.skipIf(process.platform === 'win32')('rejects a linked journal before reading any linked contents', async () => {
    const outside = path.join(root, 'outside'); await fs.mkdir(outside, { mode: 0o700 })
    await fs.writeFile(path.join(outside, 'header.json'), 'unrelated private contents', { mode: 0o600 })
    await fs.symlink(outside, path.join(data, 'workspace-control/relocation-worker-commits'))
    await expect(run(data, workers, plan)).rejects.toThrow()
    expect(await fs.readFile(file, 'utf8')).toBe(original)
    expect(await fs.readFile(path.join(outside, 'header.json'), 'utf8')).toBe('unrelated private contents')
  })
  const rebuildPlan = async (data: string, workers: ReturnType<typeof captureWorkspaceRelocationWorkers>) => {
    const snapshot = await captureWorkspaceRelocationLedgers(data)
    const prepared = prepareWorkspaceRelocationWorkerClosure({ intentId: id, closedAt, workers, ledgers: snapshot.files })
    const byManager = new Map(prepared.map(row => [row.manager_key, row]))
    return { schema_version: 1, intent_id: id, closed_at: closedAt, directories: snapshot.directories, names: snapshot.names,
      ledgers: snapshot.files.map(file => { const item = byManager.get(file.manager_key)!; return { name: file.name, manager_key: file.manager_key,
        before_version: file.version, before_sha256: item.before_sha256, after_sha256: item.after_sha256, closed_worker_ids: item.closed_worker_ids } }) }
  }
  it('retains an already-closed physical ledger byte for byte', async () => {
    const ledger = JSON.parse(original), worker = ledger.workers[0]
    worker.task.status = 'closed'; worker.task.closed = { at: closedAt, by: 'migration', note: 'older disposition' }; delete worker.task.halt
    const body = JSON.stringify(ledger, null, 4) + '\n'; await fs.writeFile(file, body)
    plan = await rebuildPlan(data, workers)
    const before = await fs.stat(file, { bigint: true }), result = await run(data, workers, plan)
    expect(result.closed_ledgers).toBe(0); expect(await fs.readFile(file, 'utf8')).toBe(body)
    expect(fileVersion(await fs.stat(file, { bigint: true }))).toBe(fileVersion(before))
  })
  it('finishes a partially committed multi-Manager scope without rewriting the first closed ledger', async () => {
    const first = JSON.parse(original).workers[0], second = structuredClone(first)
    second.worker_id = 'second-worker'; second.manager_key = 'channel::second'; second.task.id = 'second-task'
    const secondFile = path.join(directory, managerKeyToFilename(second.manager_key))
    const secondBody = JSON.stringify({ manager_key: second.manager_key, workers: [second] })
    await fs.writeFile(secondFile, secondBody, { mode: 0o600 })
    workers = captureWorkspaceRelocationWorkers([first, second].map(worker => ({ managerKey: worker.manager_key, worker })))
    plan = await rebuildPlan(data, workers)
    const firstReceipt = path.join(data, 'workspace-control/relocation-worker-commits/0.closed.json')
    await expect(run(data, workers, plan, async () => {
      if (await fs.lstat(firstReceipt).then(() => true, () => false)) throw new Error('interrupted before second Manager')
    })).rejects.toThrow()
    expect(digest(await fs.readFile(file, 'utf8'))).toBe(plan.ledgers[0].after_sha256)
    expect(await fs.readFile(secondFile, 'utf8')).toBe(secondBody)
    const before = await fs.stat(file, { bigint: true })
    const result = await run(data, workers, plan)
    expect(result.closed_ledgers).toBe(2)
    expect(fileVersion(await fs.stat(file, { bigint: true }))).toBe(fileVersion(before))
    expect(JSON.parse(await fs.readFile(secondFile, 'utf8')).workers[0].task.status).toBe('closed')
  })
  it.each(['{}', 'null', 'false', '0', '[]'])('rejects an unexpected completion record %s before closing any remaining work', async contents => {
    const journal = path.join(data, 'workspace-control/relocation-worker-commits')
    await expect(run(data, workers, plan, async () => {
      if (await fs.lstat(path.join(journal, '0.prepared.json')).then(() => true, () => false)) throw new Error('stop before rename')
    })).rejects.toThrow()
    if (process.platform === 'win32') native.writePrivateFile(path.join(journal, 'complete.json'), contents)
    else await fs.writeFile(path.join(journal, 'complete.json'), contents, { mode: 0o600 })
    await expect(run(data, workers, plan)).rejects.toThrow()
    expect(await fs.readFile(file, 'utf8')).toBe(original)
  })
  it('binds progress to the whole immutable plan', async () => {
    await run(data, workers, plan)
    await expect(run(data, workers, { ...plan, closed_at: '2026-10-21T02:00:00.000Z' })).rejects.toThrow()
    const header = JSON.parse(await fs.readFile(path.join(data, 'workspace-control/relocation-worker-commits/header.json'), 'utf8'))
    expect(header.plan_sha256).toBe(sha256CanonicalJson(plan))
  })
})
