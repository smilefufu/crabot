import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { LedgerStore } from '../workers/harness/ledger-store'
import type { LedgerWorker } from '../workers/harness/ledger-types'
import type { ManagerSessionStore } from '../manager/session-store'
import type { TraceStore } from './trace-store'
import { retentionPath, retentionLocation, pathsOverlap } from './retention-files'
import { readReceiptFile } from '../workers/harness/receipt-store-io'
import type { WorkerInputDeliveryReceipt } from '../workers/harness/input-delivery-store'
import type { WorkerQueryReceipt } from '../workers/harness/query-receipt-store'

const DAY = 86_400_000
const workerId = (id: string) => /^w-[a-zA-Z0-9-]{1,120}$/.test(id)
type Phase = 'prepared' | 'artifacts_deleted' | 'ledger_committed'
interface Journal { worker_id: string; updated_at: string; phase: Phase }
interface Deps {
  agentDir: string
  ledger: LedgerStore
  sessions: ManagerSessionStore
  traces: TraceStore
  removeNativeCopies?: (id: string) => Promise<void>
  cleanupReflectedEpisodes?: () => Promise<number>
  retentionDays: () => number
  protectedPaths: () => Promise<string[]>
  retireWorker: (id: string, cutoff: number, remove: (worker: LedgerWorker) => Promise<boolean>) => Promise<boolean>
}

/** Owns only observability artifacts. Workspace paths are never candidates. */
export class ObservabilityRetention {
  private pending?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private closing = false
  private lastResult: { ran_at?: string; removed_workers: number; removed_episodes: number; errors: string[] } = {
    removed_workers: 0, removed_episodes: 0, errors: [],
  }
  constructor(private readonly deps: Deps) {}
  status() { return { running: Boolean(this.pending), ...this.lastResult, errors: [...this.lastResult.errors] } }
  start(): void {
    if (this.timer || this.closing) return
    void this.run()
    this.timer = setInterval(() => { void this.run() }, DAY)
    this.timer.unref?.()
  }
  stop(): void {
    this.closing = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
  run(): Promise<void> {
    if (this.closing) return Promise.resolve()
    return this.pending ??= (async () => {
      let reflectedEpisodes = 0
      try { reflectedEpisodes = await this.deps.cleanupReflectedEpisodes?.() ?? 0 }
      catch (error) { console.warn('[ObservabilityRetention] reflection cleanup deferred:', error) }
      if (!this.closing) await this.deps.sessions.withRetentionSweep(() => this.sweep(reflectedEpisodes))
    })().finally(() => { this.pending = undefined })
  }
  private async journal(id: string, value?: Journal): Promise<void> {
    const directory = path.join(this.deps.agentDir, 'observability-cleanup')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await retentionPath(this.deps.agentDir, ['observability-cleanup'])
    const file = path.join(directory, `${id}.json`)
    if (!value) { await fs.rm(file, { force: true }); return }
    const temporary = `${file}.tmp`
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync() }
    finally { await handle.close() }
    await fs.rename(temporary, file)
  }
  private async treeSafe(directory: string, protectedPaths: string[], before = Infinity): Promise<boolean> {
    if ((await fs.lstat(directory)).mtimeMs >= before) return false
    if (protectedPaths.some(file => pathsOverlap(directory, file))) return false
    for (const child of await fs.readdir(directory, { withFileTypes: true })) {
      if (child.isSymbolicLink() || !child.isDirectory() && !child.isFile()) return false
      if (child.isFile() && (await fs.lstat(path.join(directory, child.name))).mtimeMs >= before) return false
      if (child.isDirectory() && !await this.treeSafe(path.join(directory, child.name), protectedPaths, before)) return false
    }
    return true
  }
  private async artifacts(id: string, protectedPaths: string[]): Promise<string[]> {
    const result: string[] = []
    for (const segments of [['workers', id], ['native-trace-copies', id], ...['builtin', 'claude-code', 'codex'].map(impl => ['worker-adapters', impl, id])]) {
      const directory = await retentionPath(this.deps.agentDir, segments)
      if (!directory) continue
      if (!(await fs.lstat(directory)).isDirectory() || !await this.treeSafe(directory, protectedPaths)) throw new Error(`Protected Worker artifacts: ${id}`)
      result.push(directory)
    }
    return result
  }
  private async receiptsSettled(id: string): Promise<boolean> {
    for (const name of ['input-deliveries.json', 'query-receipts.json']) {
      const file = await retentionPath(this.deps.agentDir, ['workers', id, name])
      if (!file) continue
      const receipts = await readReceiptFile<WorkerInputDeliveryReceipt | WorkerQueryReceipt>(file)
      if (receipts.some(receipt => !['delivered', 'failed', 'completed'].includes(receipt.state)
        || !['not_required', 'consumed'].includes(receipt.manager_notification?.status))) return false
    }
    return true
  }
  private async sweep(reflectedEpisodes = 0): Promise<void> {
    this.lastResult = { ran_at: new Date().toISOString(), removed_workers: 0, removed_episodes: reflectedEpisodes, errors: [] }
    const recordError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (this.lastResult.errors.length < 50) this.lastResult.errors.push(message.slice(0, 300))
      console.warn('[ObservabilityRetention]', message)
    }
    try {
      const days = this.deps.retentionDays()
      if (!Number.isFinite(days) || days < 1) throw new Error('Invalid observability retention days')
      if (await this.deps.sessions.hasPendingReflection()) {
        this.lastResult.errors.push('Cleanup deferred: unfinished daily reflection still references evidence')
        return
      }
      const cutoff = Date.now() - days * DAY
      const workers = await this.deps.ledger.listAllWorkers()
      const protectedPaths = await Promise.all([...await this.deps.protectedPaths(),
        ...workers.flatMap(({ worker }) => worker.incarnations.map(item => item.workspace))].map(retentionLocation))
      const journalDir = await retentionPath(this.deps.agentDir, ['observability-cleanup'])
      const journals = new Map<string, Journal>()
      if (journalDir) for (const name of await fs.readdir(journalDir)) {
        if (name.endsWith('.json.tmp') && workerId(name.slice(0, -9))) { await fs.rm(path.join(journalDir, name), { force: true }); continue }
        const id = name.slice(0, -5)
        if (!name.endsWith('.json') || !workerId(id)) continue
        const file = await retentionPath(this.deps.agentDir, ['observability-cleanup', name])
        const value = JSON.parse(await fs.readFile(file!, 'utf8')) as Journal
        if (value.worker_id !== id || !['prepared', 'artifacts_deleted', 'ledger_committed'].includes(value.phase) || !Number.isFinite(Date.parse(value.updated_at))) throw new Error('Invalid retention journal')
        journals.set(id, value)
      }
      for (const [id, journal] of journals) if (!workers.some(item => item.worker.worker_id === id)) {
        if (journal.phase !== 'prepared') await this.journal(id)
      }
      for (const { worker } of workers) {
        if (this.closing) return
        if (!workerId(worker.worker_id)) continue
        try {
          const removed = await this.deps.retireWorker(worker.worker_id, cutoff, async current => {
            if (this.closing) return false
            if (!await this.receiptsSettled(current.worker_id)) return false
            const previous = journals.get(current.worker_id)
            if (previous && previous.updated_at !== current.updated_at) return false
            const directories = await this.artifacts(current.worker_id, protectedPaths)
            const journal: Journal = { worker_id: current.worker_id, updated_at: current.updated_at, phase: 'prepared' }
            await this.journal(current.worker_id, journal)
            for (const directory of directories) {
              if (this.closing) return false
              if (path.basename(path.dirname(directory)) === 'native-trace-copies' && this.deps.removeNativeCopies) await this.deps.removeNativeCopies(current.worker_id)
              else await fs.rm(directory, { recursive: true })
            }
            if (this.closing) return false
            await this.journal(current.worker_id, { ...journal, phase: 'artifacts_deleted' })
            return true
          })
          if (removed) {
            await this.journal(worker.worker_id, { worker_id: worker.worker_id, updated_at: worker.updated_at, phase: 'ledger_committed' })
            await this.journal(worker.worker_id)
            this.lastResult.removed_workers++
          }
        } catch (error) { recordError(error) }
      }
      if (this.closing) return
      // Unindexed runtime artifacts have a 24h crash grace; never sweep workspace roots.
      const indexed = new Set(workers.map(item => item.worker.worker_id))
      for (const parent of [['workers'], ...['builtin', 'claude-code', 'codex'].map(impl => ['worker-adapters', impl])]) {
        const directory = await retentionPath(this.deps.agentDir, parent)
        if (!directory) continue
        for (const name of await fs.readdir(directory)) {
          if (this.closing) return
          if (!workerId(name) || indexed.has(name) || journals.has(name) || !await this.receiptsSettled(name)) continue
          const orphan = await retentionPath(this.deps.agentDir, [...parent, name])
          if (!orphan) continue
          const stat = await fs.lstat(orphan)
          if (stat.isDirectory() && stat.mtimeMs < Date.now() - DAY && await this.treeSafe(orphan, protectedPaths, Date.now() - DAY)) {
            await fs.rm(orphan, { recursive: true })
          }
        }
      }
      if (this.closing) return
      this.lastResult.removed_episodes += await this.deps.sessions.cleanupEpisodeLogs(cutoff, this.deps.traces.activeManagerEpisodeIds())
      if (!this.closing) {
        await this.deps.traces.whenIndexed()
        if (!this.closing) this.deps.traces.cleanupOldTraces(days, false)
      }
    } catch (error) { recordError(error) }
  }
}
