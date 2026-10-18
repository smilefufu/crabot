import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const READY = 'shared-request-upgrade.json'
const TX = 'shared-request-upgrade-v1'
async function optional(filename) {
  try { return await fs.readFile(filename) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function writeAtomic(filename, bytes) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    const file = await fs.open(temporary, 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
    await fs.rename(temporary, filename)
  } finally { await fs.rm(temporary, { force: true }) }
}
async function manifest(directory, prefix = '') {
  const result = []
  let entries
  try { entries = await fs.readdir(path.join(directory, prefix), { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT' && !prefix) return []; throw error }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(prefix, entry.name), filename = path.join(directory, name)
    if (entry.isDirectory()) result.push(...await manifest(directory, name))
    else if (entry.isSymbolicLink()) result.push({ name, link: await fs.readlink(filename) })
    else if (entry.isFile()) result.push({ name, sha256: hash(await fs.readFile(filename)) })
    else throw new Error(`Unsupported backup entry: ${name}`)
  }
  return result
}
async function dataManifest(root) {
  const files = []
  for (const name of ['admin', 'agent']) {
    files.push(...(await manifest(path.join(root, name))).map(entry => ({ ...entry, name: path.join(name, entry.name) })))
  }
  return files
}
export function wrappedLedgerBytes(original, filename) {
  return Buffer.from(JSON.stringify({ schema_version: 1, ledger: ledgerValue(original, filename).value }, null, 2))
}
async function assertStopped(dataRoot) {
  for (const name of ['mm.pid', 'agent/agent.pid', 'admin/admin.pid']) {
    const bytes = await optional(path.join(dataRoot, name))
    if (!bytes) continue
    const pid = Number(bytes.toString().trim())
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid runtime PID; cannot prepare request upgrade')
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') continue; throw error }
    throw new Error('Stop Crabot before preparing request upgrade')
  }
}
export function ledgerValue(raw, filename) {
  const physical = JSON.parse(raw)
  const wrapped = physical && Object.hasOwn(physical, 'schema_version')
  if (wrapped && (physical.schema_version !== 1 || Object.keys(physical).length !== 2 || !Object.hasOwn(physical, 'ledger'))) throw new Error('Unsupported ledger envelope')
  const value = wrapped ? physical.ledger : physical
  const key = decodeURIComponent(path.basename(filename, '.json'))
  if (!value || value.manager_key !== key || !Array.isArray(value.workers)) throw new Error('Invalid Worker ledger')
  for (const worker of value.workers) {
    if (worker.manager_key !== key || !worker.origin || !Array.isArray(worker.incarnations)) throw new Error('Invalid Worker identity')
    if (worker.origin.request && (!wrapped || worker.origin.request.schema_version !== 1)) throw new Error('Invalid request-bound Worker ledger')
  }
  return { wrapped, value }
}
export async function validateRequestVersions(agent, entries = null) {
  // Existing state is preserved byte-for-byte; readers retain their own full semantic checks.
  for (const entry of entries ?? await manifest(agent)) {
    if (!entry.sha256 || !entry.name.endsWith('.json')) continue
    const filename = path.join(agent, entry.name), name = path.basename(filename)
    let expected, field = 'schema_version'
    if (name === 'requests.json' || name === 'request-sources.json') { expected = 1; field = 'version' }
    else if (entry.name.startsWith(`conversation-requests${path.sep}`) && ['owner.json', 'admission.json', 'event.json', 'delivery-pending.json'].includes(name)) expected = 1
    else if (entry.name.startsWith(`conversation-requests${path.sep}`) && entry.name.includes(`${path.sep}deliveries${path.sep}`)) expected = 1
    else if (name === 'context.json' && entry.name.startsWith(`workers${path.sep}`)) {
      const value = JSON.parse(await fs.readFile(filename, 'utf8'))
      if (value.request && value.schema_version !== 2 || value.schema_version !== undefined && value.schema_version !== 2) throw new Error('Unsupported Worker context')
      continue
    }
    if (expected !== undefined && !(entries && name === 'event.json' ? [1, 2, 3] : [expected]).includes(JSON.parse(await fs.readFile(filename, 'utf8'))?.[field])) throw new Error(`Unsupported request state: ${entry.name}`)
  }
}
export async function validateBindings(crabotHome, backup, entries = null) {
  const load = file => import(pathToFileURL(path.join(crabotHome, 'crabot-agent', 'dist', file)).href)
  const [{ WorkerContextStore }, { TrustedHumanInputStore }, { ConversationRequestStore }, { WorkerRequestGuard }] = await Promise.all([
    load('workers/harness/context-store.js'), load('manager/trusted-human-input-store.js'),
    load('manager/conversation-request-store.js'), load('workers/harness/request-guard.js'),
  ])
  const agent = path.join(backup, 'agent'), managers = path.join(agent, 'managers')
  const unavailable = async () => { throw new Error('Upgrade validation cannot resolve or execute live authority') }
  const sources = new TrustedHumanInputStore(managers, { resolveSender: unavailable, now: unavailable })
  const requests = new ConversationRequestStore(managers, sources, { resolveSources: unavailable, now: unavailable })
  const contexts = new WorkerContextStore(path.join(agent, 'workers')), workers = new Map(), originalRequests = new Map()
  for (const entry of entries ?? await manifest(agent)) {
    if (!entry.sha256) continue
    const segments = entry.name.split(path.sep), name = path.basename(entry.name)
    if (segments[0] === 'worker-ledgers' && name.endsWith('.json') && !name.startsWith('.tmp-')) {
      const { value } = ledgerValue(await fs.readFile(path.join(agent, entry.name)), name)
      for (const worker of value.workers) {
        if (workers.has(worker.worker_id)) throw new Error('Duplicate Worker identity during upgrade')
        workers.set(worker.worker_id, { managerKey: value.manager_key, worker })
      }
    }
    if (segments[0] === 'managers' && segments.length === 3 && ['request-sources.json', 'requests.json'].includes(name)) {
      const key = decodeURIComponent(segments[1])
      await sources.list(key)
      if (name === 'requests.json') {
        const data = JSON.parse(await fs.readFile(path.join(agent, entry.name), 'utf8'))
        for (const request of data.requests) {
          const original = await requests.get(key, request.request_id)
          if (!original) throw new Error('Missing original request')
          if (entries) {
            if (originalRequests.has(request.request_id)) throw new Error('Duplicate original request')
            originalRequests.set(request.request_id, original)
          }
        }
      }
    }
    if (segments[0] === 'workers' && segments.length === 3 && name === 'context.json') await contexts.read(segments[1])
  }
  const guard = new WorkerRequestGuard({ findWorker: async id => workers.get(id) }, contexts, requests, unavailable)
  for (const { worker } of workers.values()) await guard.load(worker.worker_id)
  return originalRequests
}
async function verifyPlan(dataRoot, transaction, plan, completed = false) {
  if (plan.schema_version !== 1 || !Array.isArray(plan.files) || !Array.isArray(plan.backup_manifest)) throw new Error('Unsupported request upgrade plan')
  const backup = path.join(transaction, 'backup')
  if (JSON.stringify(await manifest(backup)) !== JSON.stringify(plan.backup_manifest)) throw new Error('Request backup verification failed')
  if (hash(await fs.readFile(path.join(transaction, 'impact.json'))) !== plan.impact_sha256) throw new Error('Impact report verification failed')
  const currentFiles = await dataManifest(dataRoot)
  if (currentFiles.length !== plan.backup_manifest.length) throw new Error('Data changed since request backup')
  const converted = new Map(plan.files.map(file => [file.name, file]))
  for (let i = 0; i < currentFiles.length; i++) {
    const current = currentFiles[i], original = plan.backup_manifest[i], conversion = converted.get(current.name)
    if (conversion) {
      if (current.name !== original.name || !(completed ? [conversion.target_sha256] : [conversion.original_sha256, conversion.target_sha256]).includes(current.sha256)) throw new Error('Migration data hash mismatch')
    } else if (JSON.stringify(current) !== JSON.stringify(original)) throw new Error('Data changed since request backup')
  }
  for (const file of plan.files) {
    if (typeof file.name !== 'string' || path.dirname(file.name) !== path.join('agent', 'worker-ledgers') || !file.name.endsWith('.json')) throw new Error('Invalid migration target')
    const original = await fs.readFile(path.join(backup, file.name))
    if (hash(original) !== file.original_sha256 || hash(wrappedLedgerBytes(original, file.name)) !== file.target_sha256) throw new Error('Invalid migration hashes')
    const current = await optional(path.join(dataRoot, file.name))
    if (!current || !(completed ? [file.target_sha256] : [file.original_sha256, file.target_sha256]).includes(hash(current))) throw new Error('Request upgrade data changed; manual recovery required')
  }
}

/** One offline preparation path for upgrade, CLI start and direct MM startup. Never runs Agent work. */
export async function prepareSharedRequests(crabotHome, dataRoot, logger = console, options = {}) {
  const code = await optional(path.join(crabotHome, 'crabot-agent', 'shared_request_version'))
  if (!code) return { status: 'not_applicable' }
  if (code.toString().trim() !== '1') throw new Error('Unsupported request code version')
  const transaction = path.join(dataRoot, TX), readyFile = path.join(dataRoot, 'agent', READY)
  const ready = await optional(readyFile)
  if (ready) {
    const value = JSON.parse(ready)
    if (value.schema_version !== 1 || value.status !== 'ready' || value.transaction !== TX) throw new Error('Unsupported request upgrade marker')
    if (hash(await fs.readFile(path.join(transaction, 'plan.json'))) !== value.plan_sha256) throw new Error('Request upgrade plan changed')
    const plan = JSON.parse(await fs.readFile(path.join(transaction, 'plan.json')))
    if (hash(await fs.readFile(path.join(transaction, 'impact.json'))) !== plan.impact_sha256) throw new Error('Impact report changed')
    return { status: 'ready', report: path.join(transaction, 'impact.json') }
  }
  await assertStopped(dataRoot)
  await fs.mkdir(dataRoot, { recursive: true })
  const lock = path.join(dataRoot, '.shared-request-upgrade.lock')
  let handle
  try { handle = await fs.open(lock, 'wx', 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const pid = Number((await fs.readFile(lock, 'utf8')).trim())
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid request upgrade lock')
    try { process.kill(pid, 0); throw new Error('Request upgrade already running') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
    await fs.unlink(lock)
    return prepareSharedRequests(crabotHome, dataRoot, logger, options)
  }
  try {
    await handle.writeFile(String(process.pid)); await handle.sync()
    await fs.mkdir(transaction, { recursive: true, mode: 0o700 })
    let plan = await optional(path.join(transaction, 'plan.json'))
    if (!plan) {
      const backup = path.join(transaction, 'backup')
      // An interrupted backup has no authority. Keep it as evidence rather than overwrite it.
      try { await fs.mkdir(backup, { mode: 0o700 }) }
      catch (error) { if (error.code === 'EEXIST') throw new Error('Incomplete request backup; preserve and inspect before retry'); throw error }
      const before = await dataManifest(dataRoot)
      for (const name of ['admin', 'agent']) {
        const source = path.join(dataRoot, name), destination = path.join(backup, name)
        try { await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false }) }
        catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      const copied = await manifest(backup)
      for (const entry of copied.filter(entry => entry.link !== undefined)) {
        const name = entry.name.split(path.sep).join('/')
        if (/^admin\/(friends|templates|friend-permission-configs|session-configs)\.json$/.test(name)
          || /^agent\/(manager-principal-bindings\.json|worker-ledgers(?:\/|$))/.test(name)
          || /^agent\/(managers|workers)(?:\/[^/]+)?$/.test(name)
          || /^agent\/managers\/[^/]+\/(request-sources|requests)\.json$/.test(name)
          || /^agent\/workers\/[^/]+\/context\.json$/.test(name)) throw new Error('Authority data symlink cannot be verified in backup')
      }
      if (JSON.stringify(copied) !== JSON.stringify(before)) throw new Error('Request backup verification failed')
      const after = await dataManifest(dataRoot)
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Data changed during request backup')
      await validateRequestVersions(path.join(backup, 'agent'))
      await validateBindings(crabotHome, backup)
      const { buildSharedRequestImpact } = await import(pathToFileURL(path.join(crabotHome, 'crabot-admin', 'dist', 'shared-request-impact.js')).href)
      const report = await buildSharedRequestImpact(backup)
      const impact = Buffer.from(JSON.stringify(report, null, 2))
      await writeAtomic(path.join(transaction, 'impact.json'), impact)
      const files = []
      for (const entry of copied.filter(entry => entry.name.startsWith(`agent${path.sep}worker-ledgers${path.sep}`) && entry.name.endsWith('.json') && !/^\.tmp-[0-9a-f-]+\.json$/i.test(path.basename(entry.name)))) {
        if (!entry.sha256) throw new Error('Ledger symlinks cannot be upgraded')
        const bytes = await fs.readFile(path.join(backup, entry.name)), parsed = ledgerValue(bytes, entry.name)
        if (!parsed.wrapped) files.push({ name: entry.name, original_sha256: hash(bytes), target_sha256: hash(wrappedLedgerBytes(bytes, entry.name)) })
      }
      plan = Buffer.from(JSON.stringify({ schema_version: 1, backup_manifest: copied, impact_sha256: hash(impact), files }, null, 2))
      await writeAtomic(path.join(transaction, 'plan.json'), plan)
    }
    const parsed = JSON.parse(plan)
    await verifyPlan(dataRoot, transaction, parsed)
    try {
      for (const file of parsed.files) {
        const original = await fs.readFile(path.join(transaction, 'backup', file.name))
        await writeAtomic(path.join(dataRoot, file.name), wrappedLedgerBytes(original, file.name))
        await options.afterConvert?.(file.name)
      }
      await verifyPlan(dataRoot, transaction, parsed, true)
      await writeAtomic(readyFile, JSON.stringify({ schema_version: 1, status: 'ready', transaction: TX, plan_sha256: hash(plan), completed_at: new Date().toISOString() }))
    } catch (error) {
      // Roll back only exact files from this transaction, never business execution or identities.
      for (const file of parsed.files) {
        const current = await fs.readFile(path.join(dataRoot, file.name))
        if (hash(current) === file.target_sha256) await writeAtomic(path.join(dataRoot, file.name), await fs.readFile(path.join(transaction, 'backup', file.name)))
        else if (hash(current) !== file.original_sha256) throw new Error('Migration rollback cannot verify original data; startup blocked', { cause: error })
      }
      throw error
    }
    logger.info(`[shared-requests] verified backup and impact report: ${path.join(transaction, 'impact.json')}`)
    return { status: 'prepared', report: path.join(transaction, 'impact.json') }
  } finally { await handle.close(); await fs.unlink(lock) }
}
