// Private fixed-job records only; submission receipts never prove exit or authorize moving/releasing maintenance.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import native from './process-identity.cjs'
import management from './desktop-management.cjs'
import { cliLockToken } from './cli-lock.mjs'
import { readVersionMaintenance } from './version-maintenance.mjs'
import { sha256CanonicalJson } from '../../crabot-shared/dist/canonical-json.js'
import { WorkspaceCatalog } from '../../crabot-shared/dist/workspace-catalog.js'
import { inspectWorkspaceRelocationTarget } from '../../crabot-shared/dist/workspace-relocation-target.js'
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')
const fail = (code = 'WORKSPACE_RELOCATION_INVALID') => { throw Object.assign(new Error('工作目录迁移记录无法核验或操作冲突，原目录和维护保护已保留。'), { code }) }
const identity = directory => {
  try {
    const stat = fs.lstatSync(directory, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || !stat.ino || fs.realpathSync(directory) !== directory) fail()
    return { path: directory, dev: stat.dev.toString(), ino: stat.ino.toString() }
  } catch { fail() }
}
const same = (a, b) => a.path === b.path && a.dev === b.dev && a.ino === b.ino
const validIdentity = value => value && Object.keys(value).length === 3 && absolute(value.path)
  && typeof value.dev === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value.dev) && typeof value.ino === 'string' && /^[1-9][0-9]*$/.test(value.ino)
function context(dataDir, locked = false) {
  const dataRoot = management.requirePrivateDataRoot(dataDir)
  if (locked && !cliLockToken(path.join(dataRoot, 'cli.lock'))) fail()
  return { dataRoot, control: path.join(dataRoot, 'workspace-control'), file: path.join(dataRoot, 'workspace-control/relocation.json') }
}
function privateControl(control) {
  let stat
  try { stat = fs.lstatSync(control) } catch (error) { if (error.code === 'ENOENT') return false; fail() }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform === 'win32' ? !native.isPrivateDirectory(control)
    : stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)) fail()
  return true
}
function readPrivateJson(file, limit) {
  let before
  try { before = fs.lstatSync(file, { bigint: true }) } catch (error) { if (error.code === 'ENOENT') return undefined; fail() }
  let fd
  try {
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)) fail()
    const owner = process.platform === 'win32' ? native.isPrivateFile(file)
      : before.uid === BigInt(process.getuid()) && (before.mode & 0o777n) === 0o600n
    if (!owner) fail()
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const stat = fs.fstatSync(fd, { bigint: true })
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) fail()
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'))
    const after = fs.lstatSync(file, { bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) fail()
    return value
  } catch { fail() } finally { if (fd !== undefined) fs.closeSync(fd) }
}
function read(ctx) {
  if (!privateControl(ctx.control)) return null
  const value = readPrivateJson(ctx.file, 65536)
  if (value === undefined) {
    for (const file of ['relocation-workers.json', 'relocation-stop-attempt.json', 'relocation-stop-submission.json']) {
      try { fs.lstatSync(path.join(ctx.control, file)); fail() }
      catch (error) { if (error.code !== 'ENOENT') fail() }
    }
    return null
  }
  try {
    if (value?.schema_version !== 1 || Object.keys(value).length !== 12 || !uuid(value.id) || value.phase !== 'freezing'
      || !Number.isSafeInteger(value.catalog_revision) || value.catalog_revision < 1
      || !validIdentity(value.data_root) || !same(value.data_root, identity(ctx.dataRoot))
      || !validIdentity(value.control_root) || !same(value.control_root, identity(ctx.control)) || !validIdentity(value.source)
      || !absolute(value.target) || !absolute(value.requested_target) || !validIdentity(value.target_ancestor)
      || value.target_identity !== null && (!validIdentity(value.target_identity) || value.target_identity.path !== value.target)
      || typeof value.created_at !== 'string' || new Date(value.created_at).toISOString() !== value.created_at) fail()
    return value
  } catch { fail() }
}
function syncDirectory(directory) {
  if (process.platform === 'win32') return
  const fd = fs.openSync(directory, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function syncIntent(ctx) { syncDirectory(ctx.control); syncDirectory(ctx.dataRoot) }
export function readWorkspaceRelocationIntent(dataDir) { return read(context(dataDir)) }

export async function beginWorkspaceRelocationIntent(options) {
  const ctx = context(options.dataDir, true)
  if (!uuid(options.id) || !absolute(options.target) || !Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1
    || !Array.isArray(options.protectedRoots) || options.protectedRoots.some(root => !absolute(root))) fail()
  if (readVersionMaintenance(ctx.dataRoot)) fail('WORKSPACE_RELOCATION_CONFLICT')
  const requestedTarget = path.resolve(options.target)
  const current = read(ctx)
  if (current) {
    if (current.id !== options.id || current.requested_target !== requestedTarget || current.catalog_revision !== options.expectedRevision) fail('WORKSPACE_RELOCATION_CONFLICT')
    syncIntent(ctx)
    return current
  }
  const dataIdentity = identity(ctx.dataRoot)
  const catalog = new WorkspaceCatalog({ dataRoot: ctx.dataRoot, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native })
  const snapshot = await catalog.snapshot()
  if (snapshot.revision !== options.expectedRevision) fail('WORKSPACE_REVISION_CONFLICT')
  const controlIdentity = identity(ctx.control)
  const preview = await inspectWorkspaceRelocationTarget(snapshot.storage_root, requestedTarget,
    { protectedRoots: [...options.protectedRoots, ctx.control] })
  if (preview.mode === 'unchanged') return { unchanged: true, source: preview.source }
  if (preview.inspection.issues.length || preview.usage.status !== 'complete') fail('WORKSPACE_RELOCATION_BLOCKED')
  if (preview.mode === 'copy' && (preview.usage.logical_bytes === undefined || BigInt(preview.usage.logical_bytes) > preview.available_bytes)) fail('WORKSPACE_RELOCATION_BLOCKED')
  if ((await catalog.snapshot()).revision !== snapshot.revision) fail('WORKSPACE_REVISION_CONFLICT')
  if (!same(dataIdentity, identity(ctx.dataRoot)) || !same(preview.source_identity, identity(preview.source))
    || !same(preview.target_ancestor, identity(preview.target_ancestor.path))) fail()
  if (preview.target_identity) { if (!same(preview.target_identity, identity(preview.target))) fail() }
  else { try { fs.lstatSync(preview.target); fail() } catch (error) { if (error.code !== 'ENOENT') throw error } }
  const record = { schema_version: 1, id: options.id, phase: 'freezing', catalog_revision: snapshot.revision,
    data_root: dataIdentity, control_root: controlIdentity, source: preview.source_identity, target: preview.target, requested_target: requestedTarget,
    target_identity: preview.target_identity, target_ancestor: preview.target_ancestor, created_at: new Date().toISOString() }
  if (!same(controlIdentity, identity(ctx.control)) || !privateControl(ctx.control)) fail()
  if (read(ctx)) fail('WORKSPACE_RELOCATION_CONFLICT')
  publishPrivateJson(ctx, ctx.file, record, 65536, () => {
    if (!same(dataIdentity, identity(ctx.dataRoot)) || !same(controlIdentity, identity(ctx.control)) || !privateControl(ctx.control)) fail()
    if (read(ctx)) fail('WORKSPACE_RELOCATION_CONFLICT')
  })
  const accepted = read(ctx)
  if (!accepted || sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return accepted
}

function publishPrivateJson(ctx, file, value, limit, verify) {
  const temporary = path.join(ctx.control, '.relocation-' + randomUUID())
  try {
    const content = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(content) > limit) fail()
    if (process.platform === 'win32') { native.writePrivateFile(temporary, ''); fs.writeFileSync(temporary, content, { flag: 'r+', flush: true }) }
    else fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600, flush: true })
    verify()
    // No replacement: preserve even an unexpected entry appearing under the held lock.
    try { fs.linkSync(temporary, file) } catch (error) { if (error.code === 'EEXIST') fail('WORKSPACE_RELOCATION_CONFLICT'); throw error }
  } finally { fs.rmSync(temporary, { force: true }) }
  syncIntent(ctx)
}

const scopeLimit = 32 * 1024 * 1024
const nonempty = value => typeof value === 'string' && value.length > 0 && !value.includes('\0')
const integer = value => Number.isSafeInteger(value) && value >= 0
const fields = (value, required, optional = []) => value && typeof value === 'object' && !Array.isArray(value)
  && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
function validWorkers(workers) {
  if (!Array.isArray(workers)) return false
  let previousWorker
  for (const worker of workers) {
    if (!fields(worker, ['worker_id', 'manager_key', 'task_id', 'incarnations'], ['workspace_id'])
      || !nonempty(worker.worker_id) || previousWorker !== undefined && worker.worker_id <= previousWorker
      || !nonempty(worker.manager_key) || !nonempty(worker.task_id)
      || Object.hasOwn(worker, 'workspace_id') && !nonempty(worker.workspace_id) || !Array.isArray(worker.incarnations)) return false
    previousWorker = worker.worker_id
    let previousIncarnation
    for (const item of worker.incarnations) {
      if (!fields(item, ['incarnation_id', 'impl', 'seq', 'workspace', 'started_at'], ['forked_from', 'query_id'])
        || !nonempty(item.incarnation_id) || previousIncarnation !== undefined && item.incarnation_id <= previousIncarnation
        || !['builtin', 'claude-code', 'codex', 'legacy'].includes(item.impl) || !integer(item.seq)
        || typeof item.workspace !== 'string' || item.workspace.includes('\0') || !nonempty(item.started_at)
        || Object.hasOwn(item, 'forked_from') && !nonempty(item.forked_from) && !integer(item.forked_from)
        || Object.hasOwn(item, 'query_id') && !nonempty(item.query_id)) return false
      previousIncarnation = item.incarnation_id
    }
  }
  return true
}
function readScope(ctx, intent) {
  if (!intent) fail()
  const value = readPrivateJson(path.join(ctx.control, 'relocation-workers.json'), scopeLimit)
  if (value === undefined) {
    if (sha256CanonicalJson(read(ctx)) !== sha256CanonicalJson(intent)) fail()
    return null
  }
  try {
    if (!fields(value, ['schema_version', 'intent_id', 'intent_sha256', 'workers', 'created_at']) || value.schema_version !== 1
      || value.intent_id !== intent.id || value.intent_sha256 !== sha256CanonicalJson(intent) || !validWorkers(value.workers)
      || typeof value.created_at !== 'string' || new Date(value.created_at).toISOString() !== value.created_at
      || sha256CanonicalJson(read(ctx)) !== sha256CanonicalJson(intent)) fail()
    return value
  } catch { fail() }
}
export function readWorkspaceRelocationWorkers(dataDir, id) {
  const ctx = context(dataDir), intent = read(ctx)
  if (!intent || intent.id !== id) fail()
  return readScope(ctx, intent)
}
export function commitWorkspaceRelocationWorkers({ dataDir, id, workers }) {
  const ctx = context(dataDir, true), intent = read(ctx)
  if (!intent || intent.id !== id || !validWorkers(workers)) fail()
  const previous = readScope(ctx, intent)
  if (previous) {
    if (sha256CanonicalJson(previous.workers) !== sha256CanonicalJson(workers)) fail('WORKSPACE_RELOCATION_CONFLICT')
    syncIntent(ctx)
    return previous
  }
  const record = { schema_version: 1, intent_id: id, intent_sha256: sha256CanonicalJson(intent), workers, created_at: new Date().toISOString() }
  const verify = () => {
    if (!same(intent.source, identity(intent.source.path)) || sha256CanonicalJson(read(ctx)) !== record.intent_sha256) fail()
  }
  verify()
  publishPrivateJson(ctx, path.join(ctx.control, 'relocation-workers.json'), record, scopeLimit, verify)
  const accepted = readScope(ctx, intent)
  if (!accepted || sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return accepted
}


function stoppingContext(dataDir, id, locked = false) {
  const ctx = context(dataDir, locked), intent = read(ctx)
  if (!intent || intent.id !== id) fail()
  const scope = readScope(ctx, intent)
  if (!scope) fail()
  return { ctx, intent, scope }
}
function readStopAttempt(ctx, intent, scope) {
  const value = readPrivateJson(path.join(ctx.control, 'relocation-stop-attempt.json'), 65536)
  if (value === undefined) {
    if (readPrivateJson(path.join(ctx.control, 'relocation-stop-submission.json'), scopeLimit) !== undefined) fail()
    return null
  }
  if (!fields(value, ['schema_version', 'intent_id', 'intent_sha256', 'workers_sha256', 'created_at']) || value.schema_version !== 1
    || value.intent_id !== intent.id || value.intent_sha256 !== sha256CanonicalJson(intent)
    || value.workers_sha256 !== sha256CanonicalJson(scope) || !validDate(value.created_at)) fail()
  return value
}
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
function stopResults(scope, results) {
  if (!Array.isArray(results)) fail()
  const sorted = Array.from(results, item => {
    if (!fields(item, ['worker_id', 'incarnation_id', 'status']) || !nonempty(item.worker_id) || !nonempty(item.incarnation_id)
      || !['submitted', 'unknown', 'unavailable'].includes(item.status)) fail()
    return { worker_id: item.worker_id, incarnation_id: item.incarnation_id, status: item.status }
  }).sort((a, b) => {
    if (a.worker_id !== b.worker_id) return a.worker_id < b.worker_id ? -1 : 1
    if (a.incarnation_id !== b.incarnation_id) return a.incarnation_id < b.incarnation_id ? -1 : 1
    return 0
  })
  const expected = scope.workers.flatMap(worker => worker.incarnations.map(item => ({ worker_id: worker.worker_id, incarnation_id: item.incarnation_id })))
  if (sha256CanonicalJson(sorted.map(({ worker_id, incarnation_id }) => ({ worker_id, incarnation_id }))) !== sha256CanonicalJson(expected)) fail()
  return sorted
}
function readStopSubmission(ctx, attempt, scope) {
  const value = readPrivateJson(path.join(ctx.control, 'relocation-stop-submission.json'), scopeLimit)
  if (value === undefined) return null
  if (!attempt || !fields(value, ['schema_version', 'intent_id', 'attempt_sha256', 'results', 'created_at']) || value.schema_version !== 1
    || value.intent_id !== attempt.intent_id || value.attempt_sha256 !== sha256CanonicalJson(attempt) || !validDate(value.created_at)
    || sha256CanonicalJson(value.results) !== sha256CanonicalJson(stopResults(scope, value.results))) fail()
  return value
}
export function readWorkspaceRelocationStops(dataDir, id) {
  const { ctx, intent, scope } = stoppingContext(dataDir, id), attempt = readStopAttempt(ctx, intent, scope)
  const submission = readStopSubmission(ctx, attempt, scope)
  if (sha256CanonicalJson(readScope(ctx, read(ctx))) !== sha256CanonicalJson(scope)) fail()
  return { attempt, submission }
}
export function prepareWorkspaceRelocationStops({ dataDir, id, workers }) {
  const { ctx, intent, scope } = stoppingContext(dataDir, id, true)
  if (sha256CanonicalJson(workers) !== sha256CanonicalJson(scope.workers)) fail()
  const previous = readWorkspaceRelocationStops(dataDir, id)
  if (previous.attempt) { syncIntent(ctx); return { dispatch: 'observe', attempt: previous.attempt } }
  const record = { schema_version: 1, intent_id: id, intent_sha256: sha256CanonicalJson(intent), workers_sha256: sha256CanonicalJson(scope), created_at: new Date().toISOString() }
  publishPrivateJson(ctx, path.join(ctx.control, 'relocation-stop-attempt.json'), record, 65536, () => {
    if (!same(intent.source, identity(intent.source.path)) || sha256CanonicalJson(readScope(ctx, read(ctx))) !== record.workers_sha256) fail()
    if (readWorkspaceRelocationStops(dataDir, id).attempt) fail('WORKSPACE_RELOCATION_CONFLICT')
  })
  const accepted = readWorkspaceRelocationStops(dataDir, id)
  if (sha256CanonicalJson(accepted.attempt) !== sha256CanonicalJson(record)) fail()
  return { dispatch: 'dispatch', attempt: accepted.attempt }
}
export function completeWorkspaceRelocationStops({ dataDir, id, results }) {
  const { ctx, intent, scope } = stoppingContext(dataDir, id, true), previous = readWorkspaceRelocationStops(dataDir, id)
  if (!previous.attempt) fail()
  const canonical = stopResults(scope, results)
  if (previous.submission) {
    if (sha256CanonicalJson(previous.submission.results) !== sha256CanonicalJson(canonical)) fail('WORKSPACE_RELOCATION_CONFLICT')
    syncIntent(ctx); return previous.submission
  }
  const record = { schema_version: 1, intent_id: id, attempt_sha256: sha256CanonicalJson(previous.attempt), results: canonical, created_at: new Date().toISOString() }
  publishPrivateJson(ctx, path.join(ctx.control, 'relocation-stop-submission.json'), record, scopeLimit, () => {
    if (!same(intent.source, identity(intent.source.path))) fail()
    const current = readWorkspaceRelocationStops(dataDir, id)
    if (sha256CanonicalJson(current.attempt) !== record.attempt_sha256 || current.submission) fail()
  })
  const accepted = readWorkspaceRelocationStops(dataDir, id).submission
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return accepted
}
