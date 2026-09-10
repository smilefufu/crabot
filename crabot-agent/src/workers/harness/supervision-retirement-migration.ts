import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ATOMIC_TEMP_FILE } from './ledger-store.js'

const MIGRATION_NAME = 'worker-supervision-retirement-v1'

interface LegacyWorker extends Record<string, unknown> {
  worker_id?: unknown
  manager_key?: unknown
  task?: unknown
  supervision?: unknown
}

interface LegacyLedger extends Record<string, unknown> {
  manager_key?: unknown
  workers?: unknown
}

export interface LegacyPeriodicReportCandidate {
  worker_id: string
  manager_key: string
  interval_ms: number
  expires_at?: string
  report_to: unknown
  requires_recreation: true
}

export interface SupervisionRetirementReport {
  schema_version: 1
  candidates: LegacyPeriodicReportCandidate[]
}

function parseLedger(raw: string, file: string): LegacyLedger {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`[supervision-retirement] invalid ledger JSON: ${file}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !Array.isArray((parsed as LegacyLedger).workers)) {
    throw new Error(`[supervision-retirement] invalid ledger shape: ${file}`)
  }
  return parsed as LegacyLedger
}

function hasSupervision(ledger: LegacyLedger): boolean {
  return (ledger.workers as LegacyWorker[]).some((worker) =>
    !!worker && typeof worker === 'object' && Object.prototype.hasOwnProperty.call(worker, 'supervision'))
}

function candidateFor(worker: LegacyWorker, ledger: LegacyLedger, nowMs: number): LegacyPeriodicReportCandidate | undefined {
  const supervision = worker.supervision
  if (!supervision || typeof supervision !== 'object' || Array.isArray(supervision)) return undefined
  const record = supervision as Record<string, unknown>
  const periodic = record.periodic_report
  if (record.mode !== 'periodic_report' || !periodic || typeof periodic !== 'object' || Array.isArray(periodic)) {
    return undefined
  }
  const task = worker.task
  const status = task && typeof task === 'object' && !Array.isArray(task)
    ? (task as Record<string, unknown>).status
    : undefined
  if (status === 'closed' || status === 'completed' || status === 'failed' || status === 'cancelled') return undefined
  const rule = periodic as Record<string, unknown>
  if (typeof rule.interval_ms !== 'number' || !Number.isFinite(rule.interval_ms) || rule.interval_ms <= 0
    || !rule.report_to || typeof rule.report_to !== 'object' || Array.isArray(rule.report_to)) return undefined
  if (rule.expires_at !== undefined
    && (typeof rule.expires_at !== 'string' || !Number.isFinite(Date.parse(rule.expires_at))
      || Date.parse(rule.expires_at) <= nowMs)) return undefined
  const workerId = worker.worker_id
  const managerKey = worker.manager_key ?? ledger.manager_key
  if (typeof workerId !== 'string' || typeof managerKey !== 'string') return undefined
  return {
    worker_id: workerId,
    manager_key: managerKey,
    interval_ms: rule.interval_ms,
    ...(typeof rule.expires_at === 'string' ? { expires_at: rule.expires_at } : {}),
    report_to: rule.report_to,
    requires_recreation: true,
  }
}

function withoutSupervision(ledger: LegacyLedger): LegacyLedger {
  return {
    ...ledger,
    workers: (ledger.workers as LegacyWorker[]).map((worker) => {
      if (!worker || typeof worker !== 'object') return worker
      const { supervision: _retired, ...rest } = worker
      return rest
    }),
  }
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try {
    await fs.rename(temporary, file)
    await fs.chmod(file, 0o600)
  } catch (error) {
    await fs.unlink(temporary).catch(() => {})
    throw error
  }
}

async function writeOnceOrVerify(file: string, contents: string): Promise<void> {
  try {
    await fs.writeFile(file, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (await fs.readFile(file, 'utf8') !== contents) {
      throw new Error(`[supervision-retirement] existing migration artifact differs: ${file}`)
    }
  }
  await fs.chmod(file, 0o600)
}

export async function retireWorkerSupervision(
  agentDataDir: string,
  now: () => Date = () => new Date(),
): Promise<SupervisionRetirementReport> {
  const ledgersDir = path.join(agentDataDir, 'worker-ledgers')
  const migrationDir = path.join(agentDataDir, 'migrations', MIGRATION_NAME)
  const backupDir = path.join(migrationDir, 'backup')
  const reportPath = path.join(migrationDir, 'legacy-periodic-report-candidates.json')
  const markerPath = path.join(migrationDir, 'completed.json')
  await fs.mkdir(ledgersDir, { recursive: true })
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 })

  try {
    const completed = JSON.parse(await fs.readFile(markerPath, 'utf8')) as { completed?: unknown }
    if (completed.completed === true) {
      return JSON.parse(await fs.readFile(reportPath, 'utf8')) as SupervisionRetirementReport
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const sourceFiles = (await fs.readdir(ledgersDir))
    .filter((file) => file.endsWith('.json') && !ATOMIC_TEMP_FILE.test(file))
    .sort()
  const backupFiles = (await fs.readdir(backupDir)).filter((file) => file.endsWith('.json')).sort()
  const files = [...new Set([...sourceFiles, ...backupFiles])].sort()
  const originals = new Map<string, LegacyLedger>()

  for (const file of files) {
    const sourcePath = path.join(ledgersDir, file)
    const backupPath = path.join(backupDir, file)
    let originalRaw: string
    try {
      originalRaw = await fs.readFile(backupPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      originalRaw = await fs.readFile(sourcePath, 'utf8')
      const original = parseLedger(originalRaw, file)
      if (!hasSupervision(original)) continue
      await writeOnceOrVerify(backupPath, originalRaw)
    }
    const original = parseLedger(originalRaw, file)
    if (hasSupervision(original)) originals.set(file, original)
  }

  const candidates = [...originals.values()]
    .flatMap((ledger) => (ledger.workers as LegacyWorker[])
      .map((worker) => candidateFor(worker, ledger, now().getTime()))
      .filter((candidate): candidate is LegacyPeriodicReportCandidate => candidate !== undefined))
    .sort((a, b) => a.manager_key.localeCompare(b.manager_key) || a.worker_id.localeCompare(b.worker_id))
  const report: SupervisionRetirementReport = { schema_version: 1, candidates }
  await writeOnceOrVerify(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  for (const file of originals.keys()) {
    const sourcePath = path.join(ledgersDir, file)
    const current = parseLedger(await fs.readFile(sourcePath, 'utf8'), file)
    if (hasSupervision(current)) {
      await writeAtomic(sourcePath, `${JSON.stringify(withoutSupervision(current), null, 2)}\n`)
    }
  }

  await writeOnceOrVerify(markerPath, `${JSON.stringify({
    schema_version: 1,
    completed: true,
    affected_ledgers: originals.size,
    candidate_count: candidates.length,
  }, null, 2)}\n`)
  return report
}
