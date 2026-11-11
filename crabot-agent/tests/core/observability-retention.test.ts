import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LedgerStore } from '../../src/workers/harness/ledger-store'
import { ManagerSessionStore } from '../../src/manager/session-store'
import { TraceStore } from '../../src/core/trace-store'
import { ObservabilityRetention } from '../../src/core/observability-retention'
import type { LedgerWorker, ManagerKey } from '../../src/workers/harness/ledger-types'
const KEY: ManagerKey = 'fixture::retention'
const old = '2020-01-01T00:00:00.000Z'
let root: string, ledger: LedgerStore, retention: ObservabilityRetention
let protectedPaths: string[]
async function save(id: string, status: LedgerWorker['task']['status'] = 'closed') {
  const worker: LedgerWorker = { worker_id: id, manager_key: KEY, task: { id, title: id, status, created_at: old },
    incarnations: [], origin: { trigger_type: 'message' }, report_to: { channel_id: 'fixture', session_id: 'retention' }, updated_at: old }
  await ledger.upsertWorker(KEY, id, () => worker)
  await fs.mkdir(join(root, 'workers', id), { recursive: true })
  await fs.writeFile(join(root, 'workers', id, 'events.jsonl'), 'original')
}
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'observability-retention-'))
  ledger = new LedgerStore(join(root, 'worker-ledgers')); protectedPaths = [join(root, 'workspaces')]
  retention = new ObservabilityRetention({ agentDir: root, ledger, sessions: new ManagerSessionStore(join(root, 'managers')),
    traces: new TraceStore(100, join(root, 'traces')), retentionDays: () => 30, protectedPaths: async () => protectedPaths,
    retireWorker: (id, cutoff, remove) => ledger.removeClosedWorker(id, cutoff, remove) })
})
afterEach(async () => { await retention.stop(); await fs.rm(root, { recursive: true, force: true }) })
describe('unified observability retention', () => {
  it('removes obsolete closed artifacts and ledger, preserving workspace bytes', async () => {
    await save('w-old'); await fs.mkdir(join(root, 'workspaces'), { recursive: true })
    await fs.writeFile(join(root, 'workspaces', 'project.txt'), 'irreplaceable'); await retention.run()
    expect(await ledger.findWorker('w-old')).toBeUndefined()
    expect(await fs.readFile(join(root, 'workspaces', 'project.txt'), 'utf8')).toBe('irreplaceable')
    await expect(fs.stat(join(root, 'workers', 'w-old'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['queued', 'running', 'halted'] as const)('protects all %s workers regardless of age', async status => {
    await save('w-live', status); await retention.run()
    expect((await ledger.findWorker('w-live'))?.worker.task.status).toBe(status)
    expect(await fs.readFile(join(root, 'workers', 'w-live', 'events.jsonl'), 'utf8')).toBe('original')
  })
  it.each(['input-deliveries.json', 'query-receipts.json'])('protects unsettled %s and pending notifications', async name => {
    await save('w-pending'); const file = join(root, 'workers', 'w-pending', name)
    for (const [state, notification] of [[name.startsWith('input') ? 'pending' : 'running', 'not_required'], ['failed', 'pending']]) {
      await fs.writeFile(file, JSON.stringify({ version: 1, receipts: [{ state, manager_notification: { status: notification } }] }))
      await retention.run(); expect(await ledger.findWorker('w-pending')).toBeDefined()
    }
    await fs.writeFile(file, JSON.stringify({ version: 1, receipts: [{ state: 'failed', manager_notification: { status: 'consumed' } }] }))
    await retention.run(); expect(await ledger.findWorker('w-pending')).toBeUndefined()
  })
  it('preserves a workspace nested inside artifacts and a redirected artifact', async () => {
    await save('w-project'); protectedPaths.push(join(root, 'workers', 'w-project', 'project'))
    await fs.mkdir(protectedPaths[1]); await retention.run(); expect(await ledger.findWorker('w-project')).toBeDefined()
    await save('w-link'); const outside = join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(join(outside, 'data'), 'original')
    await fs.symlink(outside, join(root, 'workers', 'w-link', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await retention.run(); expect(await ledger.findWorker('w-link')).toBeDefined()
    expect(await fs.readFile(join(outside, 'data'), 'utf8')).toBe('original')
  })
  it('retries a prepared cleanup after ledger commit fails, using a fresh store', async () => {
    await save('w-retry')
    const rename = fs.rename.bind(fs)
    const fail = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes('worker-ledgers')) throw new Error('ledger write failed')
      return rename(from, to)
    })
    try { await retention.run() } finally { fail.mockRestore() }
    expect(await ledger.findWorker('w-retry')).toBeDefined()
    expect(JSON.parse(await fs.readFile(join(root, 'observability-cleanup', 'w-retry.json'), 'utf8')).phase).toBe('artifacts_deleted')
    await retention.stop()
    ledger = new LedgerStore(join(root, 'worker-ledgers'))
    retention = new ObservabilityRetention({ agentDir: root, ledger, sessions: new ManagerSessionStore(join(root, 'managers')),
      traces: new TraceStore(100, join(root, 'traces')), retentionDays: () => 30, protectedPaths: async () => protectedPaths,
      retireWorker: (id, cutoff, remove) => ledger.removeClosedWorker(id, cutoff, remove) })
    await retention.run(); expect(await ledger.findWorker('w-retry')).toBeUndefined()
    expect(await fs.readdir(join(root, 'observability-cleanup'))).toEqual([])
  })
  it('keeps new orphan writes despite an old parent timestamp, and cleans only expired runtime artifacts', async () => {
    const directory = join(root, 'workers', 'w-orphan'); await fs.mkdir(directory, { recursive: true })
    const file = join(directory, 'events.jsonl'); await fs.writeFile(file, 'recent')
    await fs.utimes(directory, new Date(0), new Date(0)); await retention.run()
    expect(await fs.readFile(file, 'utf8')).toBe('recent')
    await fs.utimes(file, new Date(0), new Date(0)); await retention.run()
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('protects recently updated closed workers, live incarnations and pending recovery notices', async () => {
    for (const id of ['w-new', 'w-carrier', 'w-recovery']) await save(id)
    await ledger.upsertWorker(KEY, 'w-new', worker => ({ ...worker!, updated_at: new Date().toISOString() }))
    await ledger.upsertWorker(KEY, 'w-carrier', worker => ({ ...worker!, incarnations: [{ seq: 0, impl: 'builtin', session_ref: 'test', state: 'running', workspace: join(root, 'workspace'), started_at: old }] }))
    await ledger.upsertWorker(KEY, 'w-recovery', worker => ({ ...worker!, incarnations: [{ seq: 0, incarnation_id: 'inc', impl: 'builtin', session_ref: 'test', state: 'exited', workspace: join(root, 'workspace'), started_at: old }], recovery_notices: [{ notice_id: 'keep', incarnation_id: 'inc', status: 'pending', created_at: old, attempts: 0 }] }))
    await retention.run()
    expect((await ledger.listAllWorkers()).map(item => item.worker.worker_id)).toHaveLength(3)
  })
  it('preserves evidence while an unfinished daily reflection still references it', async () => {
    await save('w-evidence')
    const directory = join(root, 'managers', 'fixture%3A%3Aretention')
    await fs.mkdir(directory, { recursive: true })
    const file = join(directory, 'state.json')
    const state = { key: KEY, recent: [], foldedCount: 0, dailyReflection: { run_id: 'pending' } }
    await fs.writeFile(file, JSON.stringify(state)); await retention.run()
    expect(await ledger.findWorker('w-evidence')).toBeDefined()
    expect(retention.status().errors[0]).toContain('unfinished daily reflection')
    await fs.writeFile(file, JSON.stringify({ ...state, dailyReflection: { ...state.dailyReflection, result: { outcome: 'partial' } } }))
    await retention.run(); expect(await ledger.findWorker('w-evidence')).toBeDefined()
    await fs.writeFile(file, JSON.stringify({ ...state, dailyReflection: { ...state.dailyReflection, result: { outcome: 'completed' } } }))
    await retention.run(); expect(await ledger.findWorker('w-evidence')).toBeUndefined()
  })
  it('retains evidence when a Manager state cannot prove that reflection is finished', async () => {
    await save('w-evidence')
    const directory = join(root, 'managers', 'fixture%3A%3Aretention')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(join(directory, 'state.json'), '{broken')
    await retention.run()
    expect(await ledger.findWorker('w-evidence')).toBeDefined()
    expect(retention.status().errors).toHaveLength(1)
  })
  it('serializes reflection admission with a running sweep before freezing evidence', async () => {
    const sessions = new ManagerSessionStore(join(root, 'managers'))
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    await save('w-before-reflection')
    retention = new ObservabilityRetention({ agentDir: root, ledger, sessions,
      traces: new TraceStore(100, join(root, 'traces')), retentionDays: () => 30, protectedPaths: async () => protectedPaths,
      retireWorker: async (id, cutoff, remove) => {
        entered(); await gate
        return ledger.removeClosedWorker(id, cutoff, remove)
      } })
    const sweep = retention.run(); await ready
    let admitted = false
    const admission = sessions.updateDailyReflection(KEY, () => {
      admitted = true
      return { run_id: 'new-run' } as never
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(admitted).toBe(false)
    release(); await sweep; await admission
    expect(admitted).toBe(true)
    expect(await sessions.hasPendingReflection()).toBe(true)
  })
  it('does not delay service shutdown behind a queued cleanup or admit new deletions after stop', async () => {
    await save('w-stop')
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    const remove = vi.spyOn(ledger, 'removeClosedWorker').mockImplementationOnce(async (id, cutoff, callback) => {
      entered(); await gate
      return LedgerStore.prototype.removeClosedWorker.call(ledger, id, cutoff, callback)
    })
    const running = retention.run(); await ready
    retention.stop(); release(); await running
    remove.mockRestore()
    expect(await ledger.findWorker('w-stop')).toBeDefined()
    expect(await fs.readFile(join(root, 'workers', 'w-stop', 'events.jsonl'), 'utf8')).toBe('original')
    await retention.run(); expect(await ledger.findWorker('w-stop')).toBeDefined()
  })
  it('retries confirmed reflection cleanup on startup outside the evidence lock, without blocking ordinary retention on failure', async () => {
    await save('w-old')
    const sessions = new ManagerSessionStore(join(root, 'managers'))
    let visits = 0
    retention = new ObservabilityRetention({ agentDir: root, ledger, sessions,
      traces: new TraceStore(100, join(root, 'traces')), retentionDays: () => 30, protectedPaths: async () => protectedPaths,
      cleanupReflectedEpisodes: () => sessions.withRetentionSweep(async () => { visits++; throw new Error('busy evidence') }),
      retireWorker: (id, cutoff, remove) => ledger.removeClosedWorker(id, cutoff, remove) })
    retention.start(); await retention.run()
    expect(visits).toBe(1)
    expect(await ledger.findWorker('w-old')).toBeUndefined()
  })
  it('cleans obsolete diagnostic episodes but preserves checkpoint and state', async () => {
    const dir = join(root, 'managers', 'fixture%3A%3Aretention'); await fs.mkdir(join(dir, 'episodes'), { recursive: true })
    const state = JSON.stringify({ key: KEY, recent: [], foldedCount: 0, rollingSummary: 'memory' })
    await fs.writeFile(join(dir, 'state.json'), state); await fs.writeFile(join(dir, 'running.json'), JSON.stringify({ episodeId: 'protected' }))
    for (const id of ['obsolete', 'protected']) { const file = join(dir, 'episodes', `${id}.jsonl`); await fs.writeFile(file, '{}\n'); await fs.utimes(file, new Date(0), new Date(0)) }
    await retention.run(); expect(await fs.readFile(join(dir, 'state.json'), 'utf8')).toBe(state)
    expect(await fs.readFile(join(dir, 'episodes', 'protected.jsonl'), 'utf8')).toBe('{}\n')
    await expect(fs.stat(join(dir, 'episodes', 'obsolete.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
