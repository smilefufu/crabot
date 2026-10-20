// Private fixed-job records only; submission receipts never prove exit or authorize moving/releasing maintenance.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import native from './process-identity.cjs'
import management from './desktop-management.cjs'
import knownProcessExit from './known-process-exit.cjs'
import { cliLockToken } from './cli-lock.mjs'
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
function readPrivateText(file, limit) {
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
    const value = fs.readFileSync(fd, 'utf8')
    const after = fs.lstatSync(file, { bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) fail()
    return value
  } catch { fail() } finally { if (fd !== undefined) fs.closeSync(fd) }
}
function readPrivateJson(file, limit) {
  const text = readPrivateText(file, limit)
  try { return text === undefined ? undefined : JSON.parse(text) } catch { fail() }
}
function read(ctx) {
  if (!privateControl(ctx.control)) return null
  const value = readPrivateJson(ctx.file, 65536)
  if (value === undefined) {
    for (const file of ['relocation-workers.json', 'relocation-worker-processes.json', 'relocation-stop-attempt.json', 'relocation-stop-submission.json', 'relocation-modules.json', 'relocation-module-stop-attempt.json', 'relocation-module-processes', 'relocation-module-stop-submission.json', 'relocation-coordinator.json', 'relocation-coordinator-ready.json', 'relocation-process-stop.jsonl', 'relocation-execution-exit.json']) {
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
  const ctx = context(options.dataDir, true), operationToken = cliLockToken(path.join(ctx.dataRoot, 'cli.lock'))
  const dataIdentity = identity(ctx.dataRoot)
  if (!uuid(options.id) || !absolute(options.target) || !Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1
    || !Array.isArray(options.protectedRoots) || options.protectedRoots.some(root => !absolute(root))) fail()
  const { readVersionMaintenance } = await import('./version-maintenance.mjs')
  if (!operationToken || cliLockToken(path.join(ctx.dataRoot, 'cli.lock')) !== operationToken || !same(dataIdentity, identity(ctx.dataRoot))) fail()
  if (readVersionMaintenance(ctx.dataRoot)) fail('WORKSPACE_RELOCATION_CONFLICT')
  const requestedTarget = path.resolve(options.target)
  const current = read(ctx)
  if (current) {
    if (current.id !== options.id || current.requested_target !== requestedTarget || current.catalog_revision !== options.expectedRevision) fail('WORKSPACE_RELOCATION_CONFLICT')
    syncIntent(ctx)
    return current
  }
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
    if (cliLockToken(path.join(ctx.dataRoot, 'cli.lock')) !== operationToken
      || !same(dataIdentity, identity(ctx.dataRoot)) || !same(controlIdentity, identity(ctx.control)) || !privateControl(ctx.control)) fail()
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
    absent(ctx, ['relocation-worker-processes.json', 'relocation-stop-attempt.json', 'relocation-stop-submission.json', ...moduleFiles, processStopFile, executionExitFile])
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
    absent(ctx, ['relocation-worker-processes.json', 'relocation-stop-attempt.json', 'relocation-stop-submission.json', ...moduleFiles])
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
    absent(ctx, ['relocation-stop-submission.json', executionExitFile])
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

const moduleFiles = ['relocation-modules.json', 'relocation-module-stop-attempt.json', 'relocation-module-processes', 'relocation-module-stop-submission.json']
const processKey = item => JSON.stringify([item.pid, item.started, item.owner])
function validProcesses(processes) {
  if (!Array.isArray(processes) || processes.length > 32768) return false
  const owner = native.inspectProcess(process.pid).owner, seen = new Set()
  let previous
  for (const item of processes) {
    if (!fields(item, ['pid', 'parent', 'started', 'owner', 'executable'])
      || !Number.isInteger(item.pid) || item.pid < 1 || item.pid > 2147483647 || item.pid === process.pid
      || !Number.isInteger(item.parent) || item.parent < 0 || item.parent > 2147483647
      || !nonempty(item.started) || item.owner !== owner || !nonempty(item.executable) || seen.has(processKey(item))
      || previous && (item.pid < previous.pid || item.pid === previous.pid && item.started <= previous.started)) return false
    seen.add(processKey(item)); previous = item
  }
  return true
}
/** First pre-stop observation only; this never proves global ownership or execution exit. */
export function readWorkspaceRelocationProcesses(dataDir, id) {
  const { ctx, intent, scope } = stoppingContext(dataDir, id)
  const value = readPrivateJson(path.join(ctx.control, 'relocation-worker-processes.json'), scopeLimit)
  if (value === undefined) { absent(ctx, [processStopFile, executionExitFile]); return null }
  if (!fields(value, ['schema_version', 'intent_id', 'intent_sha256', 'workers_sha256', 'processes', 'created_at'])
    || value.schema_version !== 1 || value.intent_id !== id || value.intent_sha256 !== sha256CanonicalJson(intent)
    || value.workers_sha256 !== sha256CanonicalJson(scope) || !validProcesses(value.processes) || !validDate(value.created_at)
    || sha256CanonicalJson(readWorkspaceRelocationWorkers(dataDir, id)) !== value.workers_sha256) fail()
  return value
}
export function commitWorkspaceRelocationProcesses({ dataDir, id, processes }) {
  const { ctx, intent, scope } = stoppingContext(dataDir, id, true)
  if (!validProcesses(processes)) fail()
  const previous = readWorkspaceRelocationProcesses(dataDir, id)
  if (previous) {
    if (sha256CanonicalJson(previous.processes) !== sha256CanonicalJson(processes)) fail('WORKSPACE_RELOCATION_CONFLICT')
    syncIntent(ctx); return previous
  }
  const record = { schema_version: 1, intent_id: id, intent_sha256: sha256CanonicalJson(intent),
    workers_sha256: sha256CanonicalJson(scope), processes, created_at: new Date().toISOString() }
  const verify = () => {
    if (!same(intent.source, identity(intent.source.path)) || sha256CanonicalJson(readWorkspaceRelocationWorkers(dataDir, id)) !== record.workers_sha256) fail()
    absent(ctx, ['relocation-stop-attempt.json', 'relocation-stop-submission.json',
      'relocation-module-stop-attempt.json', 'relocation-module-processes', 'relocation-module-stop-submission.json'])
  }
  verify()
  publishPrivateJson(ctx, path.join(ctx.control, 'relocation-worker-processes.json'), record, scopeLimit, verify)
  const accepted = readWorkspaceRelocationProcesses(dataDir, id)
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return accepted
}

function validModules(modules) {
  if (!Array.isArray(modules)) return false
  let previous, instance
  const pids = new Set(), runtimes = new Set()
  for (const item of modules) {
    if (!fields(item, ['instance_id', 'module_id', 'module_port', 'processes'], ['runtime_id'])
      || !nonempty(item.instance_id) || instance !== undefined && instance !== item.instance_id
      || !nonempty(item.module_id) || item.module_id === 'admin-web' || previous !== undefined && item.module_id <= previous
      || !Number.isInteger(item.module_port) || item.module_port < 1 || item.module_port > 65535 || !validProcesses(item.processes)
      || Object.hasOwn(item, 'runtime_id') && (!nonempty(item.runtime_id) || runtimes.has(item.runtime_id))
      || Boolean(item.runtime_id) !== Boolean(item.processes.length)) return false
    for (const process of item.processes) { if (pids.has(process.pid)) return false; pids.add(process.pid) }
    if (item.runtime_id) runtimes.add(item.runtime_id)
    previous = item.module_id; instance = item.instance_id
  }
  return true
}
function absent(ctx, names) {
  for (const name of names) {
    try { fs.lstatSync(path.join(ctx.control, name)); fail() }
    catch (error) { if (error.code !== 'ENOENT') fail() }
  }
}
function readModules(ctx, intent, workers) {
  const value = readPrivateJson(path.join(ctx.control, moduleFiles[0]), scopeLimit)
  if (value === undefined) { absent(ctx, [...moduleFiles.slice(1), processStopFile, executionExitFile]); return null }
  if (!fields(value, ['schema_version', 'intent_id', 'intent_sha256', 'workers_sha256', 'modules', 'created_at']) || value.schema_version !== 1
    || value.intent_id !== intent.id || value.intent_sha256 !== sha256CanonicalJson(intent) || value.workers_sha256 !== sha256CanonicalJson(workers)
    || !validModules(value.modules) || !validDate(value.created_at)) fail()
  return value
}
export function readWorkspaceRelocationModules(dataDir, id) {
  const { ctx, intent, scope } = stoppingContext(dataDir, id)
  return readModules(ctx, intent, scope)
}
export function commitWorkspaceRelocationModules({ dataDir, id, modules }) {
  const { ctx, intent, scope } = stoppingContext(dataDir, id, true)
  if (!validModules(modules)) fail()
  const previous = readModules(ctx, intent, scope)
  if (previous) {
    if (sha256CanonicalJson(previous.modules) !== sha256CanonicalJson(modules)) fail('WORKSPACE_RELOCATION_CONFLICT')
    syncIntent(ctx); return previous
  }
  const record = { schema_version: 1, intent_id: id, intent_sha256: sha256CanonicalJson(intent), workers_sha256: sha256CanonicalJson(scope), modules, created_at: new Date().toISOString() }
  publishPrivateJson(ctx, path.join(ctx.control, moduleFiles[0]), record, scopeLimit, () => {
    if (!same(intent.source, identity(intent.source.path)) || sha256CanonicalJson(readScope(ctx, read(ctx))) !== record.workers_sha256
      || readModules(ctx, intent, scope)) fail()
  })
  const accepted = readWorkspaceRelocationModules(dataDir, id)
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return accepted
}
function moduleStoppingContext(dataDir, id, locked = false) {
  const result = stoppingContext(dataDir, id, locked), modules = readModules(result.ctx, result.intent, result.scope)
  if (!modules) fail()
  return { ...result, modules }
}
function readModuleAttempt(ctx, modules) {
  const value = readPrivateJson(path.join(ctx.control, moduleFiles[1]), 65536)
  if (value === undefined) { absent(ctx, [...moduleFiles.slice(2), executionExitFile]); return null }
  if (!fields(value, ['schema_version', 'intent_id', 'modules_sha256', 'processes_root', 'created_at']) || value.schema_version !== 1
    || value.intent_id !== modules.intent_id || value.modules_sha256 !== sha256CanonicalJson(modules) || !validDate(value.created_at)
    || !validIdentity(value.processes_root) || value.processes_root.path !== path.join(ctx.control, moduleFiles[2])
    || !privateControl(value.processes_root.path) || !same(value.processes_root, identity(value.processes_root.path))) fail()
  return value
}
function extendsProcesses(previous, current) {
  const keys = new Set(current.map(item => sha256CanonicalJson(item)))
  return previous.every(item => keys.has(sha256CanonicalJson(item)))
}
function readModuleObservations(ctx, attempt, modules) {
  if (!attempt) return []
  const directory = attempt.processes_root.path, entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  if (entries.length > 32768) fail()
  const observations = [], latest = new Map(modules.modules.map(item => [item.module_id, item.processes]))
  const owners = new Map(modules.modules.flatMap(item => item.processes.map(process => [processKey(process), item.module_id])))
  let size = 0, previous = null
  for (const [index, entry] of entries.entries()) {
    if (!entry.isFile() || entry.name !== String(index).padStart(8, '0') + '.json') fail()
    const file = path.join(directory, entry.name)
    size += fs.lstatSync(file).size
    if (size > scopeLimit) fail()
    const value = readPrivateJson(file, scopeLimit)
    if (!value || !fields(value, ['schema_version', 'intent_id', 'attempt_sha256', 'sequence', 'module_id', 'previous_sha256', 'processes', 'created_at'])
      || value.schema_version !== 1 || value.intent_id !== attempt.intent_id || value.attempt_sha256 !== sha256CanonicalJson(attempt)
      || value.sequence !== index || value.previous_sha256 !== previous || !validDate(value.created_at) || !validProcesses(value.processes)
      || !modules.modules.some(item => item.module_id === value.module_id && item.runtime_id)
      || !extendsProcesses(latest.get(value.module_id), value.processes)) fail()
    for (const process of value.processes) {
      const owner = owners.get(processKey(process))
      if (owner !== undefined && owner !== value.module_id) fail()
      owners.set(processKey(process), value.module_id)
    }
    latest.set(value.module_id, value.processes); observations.push(value); previous = sha256CanonicalJson(value)
  }
  if (!same(attempt.processes_root, identity(directory)) || !privateControl(directory)) fail()
  return observations
}
function moduleStopResults(modules, results, observations) {
  if (!Array.isArray(results) || results.length !== modules.modules.length) fail()
  const sorted = Array.from(results).sort((a, b) => a.module_id < b.module_id ? -1 : a.module_id > b.module_id ? 1 : 0)
  for (const [index, item] of sorted.entries()) {
    const target = modules.modules[index]
    if (!fields(item, ['module_id', 'shutdown', 'status'], ['runtime_id']) || item.module_id !== target.module_id || item.runtime_id !== target.runtime_id
      || !['not_submitted', 'submitted', 'unknown'].includes(item.shutdown) || !['inactive', 'known_scope_exited', 'unknown'].includes(item.status)
      || !target.runtime_id && item.shutdown !== 'not_submitted'
      || item.status === 'inactive' && (target.runtime_id || target.processes.length)
      || item.status === 'known_scope_exited' && (!target.runtime_id || !observations.some(value => value.module_id === item.module_id))) fail()
  }
  return sorted
}
function readModuleSubmission(ctx, attempt, modules, observations) {
  const value = readPrivateJson(path.join(ctx.control, moduleFiles[3]), scopeLimit)
  if (value === undefined) return null
  if (!attempt || !fields(value, ['schema_version', 'intent_id', 'attempt_sha256', 'observations_sha256', 'results', 'created_at'])
    || value.schema_version !== 1 || value.intent_id !== attempt.intent_id || value.attempt_sha256 !== sha256CanonicalJson(attempt) || !validDate(value.created_at)) fail()
  const prefix = value.observations_sha256 === null ? [] : observations.slice(0, observations.findIndex(item => sha256CanonicalJson(item) === value.observations_sha256) + 1)
  if (value.observations_sha256 !== null && !prefix.length
    || sha256CanonicalJson(value.results) !== sha256CanonicalJson(moduleStopResults(modules, value.results, prefix))) fail()
  return value
}
export function readWorkspaceRelocationModuleStops(dataDir, id) {
  const { ctx, modules } = moduleStoppingContext(dataDir, id), attempt = readModuleAttempt(ctx, modules)
  const observations = readModuleObservations(ctx, attempt, modules), submission = readModuleSubmission(ctx, attempt, modules, observations)
  if (sha256CanonicalJson(readWorkspaceRelocationModules(dataDir, id)) !== sha256CanonicalJson(modules)) fail()
  return { attempt, observations, submission }
}
export function prepareWorkspaceRelocationModuleStops({ dataDir, id, modules: expected }) {
  const { ctx, intent, modules } = moduleStoppingContext(dataDir, id, true)
  if (sha256CanonicalJson(expected) !== sha256CanonicalJson(modules.modules)) fail()
  const previous = readWorkspaceRelocationModuleStops(dataDir, id)
  if (previous.attempt) { syncDirectory(previous.attempt.processes_root.path); syncIntent(ctx); return { dispatch: 'observe', attempt: previous.attempt } }
  const directory = path.join(ctx.control, moduleFiles[2])
  if (process.platform === 'win32') native.createPrivateDirectory(directory)
  else fs.mkdirSync(directory, { mode: 0o700 })
  syncDirectory(directory)
  const record = { schema_version: 1, intent_id: id, modules_sha256: sha256CanonicalJson(modules), processes_root: identity(directory), created_at: new Date().toISOString() }
  publishPrivateJson(ctx, path.join(ctx.control, moduleFiles[1]), record, 65536, () => {
    if (!same(intent.source, identity(intent.source.path)) || !same(record.processes_root, identity(directory)) || !privateControl(directory)
      || sha256CanonicalJson(readWorkspaceRelocationModules(dataDir, id)) !== record.modules_sha256
      || readPrivateJson(path.join(ctx.control, moduleFiles[1]), 65536) !== undefined) fail()
  })
  const accepted = readWorkspaceRelocationModuleStops(dataDir, id)
  if (sha256CanonicalJson(accepted.attempt) !== sha256CanonicalJson(record)) fail()
  return { dispatch: 'dispatch', attempt: accepted.attempt }
}
export function observeWorkspaceRelocationModuleProcesses({ dataDir, id, moduleId, processes }) {
  const { ctx, intent, modules } = moduleStoppingContext(dataDir, id, true), previous = readWorkspaceRelocationModuleStops(dataDir, id)
  const target = modules.modules.find(item => item.module_id === moduleId)
  if (!previous.attempt || !target?.runtime_id || !validProcesses(processes)) fail()
  const latest = previous.observations.filter(item => item.module_id === moduleId).at(-1)
  if (!extendsProcesses(latest?.processes ?? target.processes, processes)) fail()
  if (latest && sha256CanonicalJson(latest.processes) === sha256CanonicalJson(processes)) {
    syncDirectory(previous.attempt.processes_root.path); syncIntent(ctx); return latest
  }
  const otherProcesses = [
    ...modules.modules.filter(item => item.module_id !== moduleId).flatMap(item => item.processes),
    ...previous.observations.filter(item => item.module_id !== moduleId).flatMap(item => item.processes),
  ]
  const otherKeys = new Set(otherProcesses.map(processKey))
  if (processes.some(item => otherKeys.has(processKey(item))) || previous.observations.length >= 32768) fail()
  const record = { schema_version: 1, intent_id: id, attempt_sha256: sha256CanonicalJson(previous.attempt), sequence: previous.observations.length,
    module_id: moduleId, previous_sha256: previous.observations.length ? sha256CanonicalJson(previous.observations.at(-1)) : null,
    processes, created_at: new Date().toISOString() }
  const directory = previous.attempt.processes_root.path
  const bytes = fs.readdirSync(directory).reduce((sum, name) => sum + fs.lstatSync(path.join(directory, name)).size, 0)
  if (bytes + Buffer.byteLength(JSON.stringify(record) + '\n') > scopeLimit) fail()
  const file = path.join(previous.attempt.processes_root.path, String(record.sequence).padStart(8, '0') + '.json')
  publishPrivateJson(ctx, file, record, scopeLimit, () => {
    const current = readWorkspaceRelocationModuleStops(dataDir, id)
    if (!same(intent.source, identity(intent.source.path)) || sha256CanonicalJson(current) !== sha256CanonicalJson(previous)) fail()
  })
  syncDirectory(previous.attempt.processes_root.path); syncIntent(ctx)
  const accepted = readWorkspaceRelocationModuleStops(dataDir, id).observations.at(-1)
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return accepted
}
export function completeWorkspaceRelocationModuleStops({ dataDir, id, results }) {
  const { ctx, intent, modules } = moduleStoppingContext(dataDir, id, true), previous = readWorkspaceRelocationModuleStops(dataDir, id)
  if (!previous.attempt) fail()
  const canonical = moduleStopResults(modules, results, previous.observations)
  if (previous.submission) {
    if (sha256CanonicalJson(previous.submission.results) !== sha256CanonicalJson(canonical)) fail('WORKSPACE_RELOCATION_CONFLICT')
    syncIntent(ctx); return previous.submission
  }
  const record = { schema_version: 1, intent_id: id, attempt_sha256: sha256CanonicalJson(previous.attempt),
    observations_sha256: previous.observations.length ? sha256CanonicalJson(previous.observations.at(-1)) : null, results: canonical, created_at: new Date().toISOString() }
  publishPrivateJson(ctx, path.join(ctx.control, moduleFiles[3]), record, scopeLimit, () => {
    if (!same(intent.source, identity(intent.source.path)) || sha256CanonicalJson(readWorkspaceRelocationModuleStops(dataDir, id)) !== sha256CanonicalJson(previous)) fail()
  })
  const accepted = readWorkspaceRelocationModuleStops(dataDir, id).submission
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return accepted
}


const coordinatorFile = 'relocation-coordinator.json', coordinatorReadyFile = 'relocation-coordinator-ready.json'
function validCoordinatorProcess(value) {
  return fields(value, ['pid', 'parent', 'owner', 'started', 'executable'])
    && Number.isInteger(value.pid) && value.pid > 0 && value.pid <= 2147483647
    && Number.isInteger(value.parent) && value.parent >= 0 && value.parent <= 2147483647
    && value.owner === native.inspectProcess(process.pid).owner && nonempty(value.started) && nonempty(value.executable)
}
const isoTime = value => typeof value === 'string' && new Date(value).toISOString() === value
function coordinatorContext(dataDir, id, locked = false) {
  const ctx = context(dataDir, locked), intent = read(ctx)
  if (!intent || intent.id !== id) fail()
  return { ctx, intent }
}
export function readWorkspaceRelocationCoordinator(dataDir, id) {
  const { ctx, intent } = coordinatorContext(dataDir, id)
  const launch = readPrivateJson(path.join(ctx.control, coordinatorFile), 65536)
  const ready = readPrivateJson(path.join(ctx.control, coordinatorReadyFile), 65536)
  try {
    if (launch === undefined) {
      if (ready !== undefined || sha256CanonicalJson(read(ctx)) !== sha256CanonicalJson(intent)) fail()
      absent(ctx, [executionExitFile])
      return { launch: null, ready: null }
    }
    if (!fields(launch, ['schema_version', 'intent_id', 'intent_sha256', 'launch_id', 'parent', 'process', 'created_at'])
      || launch.schema_version !== 1 || launch.intent_id !== id || launch.intent_sha256 !== sha256CanonicalJson(intent)
      || !uuid(launch.launch_id) || !validCoordinatorProcess(launch.parent) || !validCoordinatorProcess(launch.process)
      || launch.process.pid === launch.parent.pid || launch.process.parent !== launch.parent.pid || !isoTime(launch.created_at)) fail()
    if (ready !== undefined && (!fields(ready, ['schema_version', 'launch_sha256', 'acquired_at']) || ready.schema_version !== 1
      || ready.launch_sha256 !== sha256CanonicalJson(launch) || !isoTime(ready.acquired_at))) fail()
    if (sha256CanonicalJson(read(ctx)) !== sha256CanonicalJson(intent)) fail()
    return { launch, ready: ready ?? null }
  } catch { fail() }
}
export function commitWorkspaceRelocationCoordinator({ dataDir, id, launchId, coordinator }) {
  const { ctx, intent } = coordinatorContext(dataDir, id, true), operationToken = cliLockToken(path.join(ctx.dataRoot, 'cli.lock'))
  const parent = native.inspectProcess(process.pid), child = { ...coordinator }
  const verify = () => {
    if (!uuid(launchId) || !validCoordinatorProcess(child) || child.pid === parent.pid || child.parent !== parent.pid) fail()
    let current
    try { current = native.inspectProcess(child.pid) } catch { fail() }
    if (!native.sameProcess(child, current) || current.parent !== parent.pid || !native.sameProcess(parent, native.inspectProcess(parent.pid))
      || !operationToken || cliLockToken(path.join(ctx.dataRoot, 'cli.lock')) !== operationToken
      || sha256CanonicalJson(read(ctx)) !== sha256CanonicalJson(intent)) fail()
  }
  verify()
  const previous = readWorkspaceRelocationCoordinator(dataDir, id)
  if (previous.launch) {
    if (previous.launch.launch_id !== launchId || sha256CanonicalJson(previous.launch.parent) !== sha256CanonicalJson(parent)
      || sha256CanonicalJson(previous.launch.process) !== sha256CanonicalJson(child)) fail('WORKSPACE_RELOCATION_CONFLICT')
    syncIntent(ctx); return previous.launch
  }
  const record = { schema_version: 1, intent_id: id, intent_sha256: sha256CanonicalJson(intent), launch_id: launchId,
    parent, process: child, created_at: new Date().toISOString() }
  publishPrivateJson(ctx, path.join(ctx.control, coordinatorFile), record, 65536, () => {
    verify(); if (readWorkspaceRelocationCoordinator(dataDir, id).launch) fail('WORKSPACE_RELOCATION_CONFLICT')
  })
  const accepted = readWorkspaceRelocationCoordinator(dataDir, id).launch
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return accepted
}
export function commitWorkspaceRelocationCoordinatorReady({ dataDir, id }) {
  const { ctx, intent } = coordinatorContext(dataDir, id, true), previous = readWorkspaceRelocationCoordinator(dataDir, id)
  const operationToken = cliLockToken(path.join(ctx.dataRoot, 'cli.lock')), launch = previous.launch
  if (!launch) fail()
  const verify = () => {
    const self = native.inspectProcess(process.pid)
    if (!native.sameProcess(launch.process, self) || self.parent !== launch.parent.pid
      || !native.sameProcess(launch.parent, native.inspectProcess(launch.parent.pid))
      || !operationToken || cliLockToken(path.join(ctx.dataRoot, 'cli.lock')) !== operationToken
      || sha256CanonicalJson(read(ctx)) !== sha256CanonicalJson(intent)
      || sha256CanonicalJson(readWorkspaceRelocationCoordinator(dataDir, id).launch) !== sha256CanonicalJson(launch)) fail()
  }
  verify()
  if (previous.ready) { syncIntent(ctx); return previous.ready }
  const record = { schema_version: 1, launch_sha256: sha256CanonicalJson(launch), acquired_at: new Date().toISOString() }
  publishPrivateJson(ctx, path.join(ctx.control, coordinatorReadyFile), record, 65536, () => {
    verify(); if (readWorkspaceRelocationCoordinator(dataDir, id).ready) fail('WORKSPACE_RELOCATION_CONFLICT')
  })
  const accepted = readWorkspaceRelocationCoordinator(dataDir, id).ready
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return accepted
}


// One append-only, private known-scope journal. It is not a global exit or file-move permit.
const processStopFile = 'relocation-process-stop.jsonl'
function syncProcessStopFile(ctx) {
  const file = path.join(ctx.control, processStopFile), selected = fs.lstatSync(file, { bigint: true })
  const fd = fs.openSync(file, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const current = fs.fstatSync(fd, { bigint: true })
    if (current.dev !== selected.dev || current.ino !== selected.ino || current.nlink !== 1n) fail()
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  syncIntent(ctx)
}
function processStoppingContext(dataDir, id, locked = false) {
  const result = moduleStoppingContext(dataDir, id, locked), processes = readWorkspaceRelocationProcesses(dataDir, id)
  if (!processes) fail()
  return { ...result, processes }
}
export function readWorkspaceRelocationProcessStops(dataDir, id) {
  const { ctx, modules, processes } = processStoppingContext(dataDir, id)
  const text = readPrivateText(path.join(ctx.control, processStopFile), scopeLimit)
  if (text === undefined) { absent(ctx, [executionExitFile]); return { attempt: null, observations: [], completion: null } }
  try {
    if (!text.endsWith('\n')) fail()
    const lines = text.slice(0, -1).split('\n')
    if (!lines.length || lines.length > 32768) fail()
    const [attempt, ...rows] = lines.map(line => JSON.parse(line))
    if (!fields(attempt, ['type', 'schema_version', 'intent_id', 'processes_sha256', 'modules_sha256', 'created_at'])
      || attempt.type !== 'attempt' || attempt.schema_version !== 1 || attempt.intent_id !== id
      || attempt.processes_sha256 !== sha256CanonicalJson(processes) || attempt.modules_sha256 !== sha256CanonicalJson(modules)
      || !validDate(attempt.created_at)) fail()
    const observations = []
    let completion = null, previous = attempt, latest = processes.processes
    for (const row of rows) {
      if (completion || !validDate(row?.created_at) || row.previous_sha256 !== sha256CanonicalJson(previous)) fail()
      if (row.type === 'observation') {
        if (!fields(row, ['type', 'previous_sha256', 'processes', 'created_at']) || !validProcesses(row.processes)
          || !extendsProcesses(latest, row.processes)) fail()
        observations.push(row); latest = row.processes
      } else if (row.type === 'known_scope_exited') {
        if (!fields(row, ['type', 'previous_sha256', 'created_at']) || !observations.length) fail()
        completion = row
      } else fail()
      previous = row
    }
    return { attempt, observations, completion }
  } catch { fail() }
}
export function prepareWorkspaceRelocationProcessStops({ dataDir, id }) {
  const { ctx, intent, processes, modules } = processStoppingContext(dataDir, id, true)
  const previous = readWorkspaceRelocationProcessStops(dataDir, id)
  if (previous.attempt) { syncProcessStopFile(ctx); return { dispatch: 'observe', attempt: previous.attempt } }
  if (readWorkspaceRelocationStops(dataDir, id).attempt || readWorkspaceRelocationModuleStops(dataDir, id).attempt) fail()
  const record = { type: 'attempt', schema_version: 1, intent_id: id, processes_sha256: sha256CanonicalJson(processes),
    modules_sha256: sha256CanonicalJson(modules), created_at: new Date().toISOString() }
  publishPrivateJson(ctx, path.join(ctx.control, processStopFile), record, scopeLimit, () => {
    if (!same(intent.source, identity(intent.source.path)) || readWorkspaceRelocationProcessStops(dataDir, id).attempt) fail()
  })
  const accepted = readWorkspaceRelocationProcessStops(dataDir, id).attempt
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return { dispatch: 'dispatch', attempt: accepted }
}
function appendProcessStopRecord(dataDir, id, previous, record) {
  const { ctx, intent } = processStoppingContext(dataDir, id, true), token = cliLockToken(path.join(ctx.dataRoot, 'cli.lock'))
  const file = path.join(ctx.control, processStopFile), content = JSON.stringify(record) + '\n'
  const selected = fs.lstatSync(file, { bigint: true })
  if (previous.observations.length >= 32767 || selected.size + BigInt(Buffer.byteLength(content)) > BigInt(scopeLimit)) fail()
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const current = fs.fstatSync(fd, { bigint: true })
    if (current.dev !== selected.dev || current.ino !== selected.ino || current.size !== selected.size
      || current.mtimeNs !== selected.mtimeNs || current.ctimeNs !== selected.ctimeNs || current.nlink !== 1n
      || !token || cliLockToken(path.join(ctx.dataRoot, 'cli.lock')) !== token
      || !same(intent.source, identity(intent.source.path))
      || sha256CanonicalJson(readWorkspaceRelocationProcessStops(dataDir, id)) !== sha256CanonicalJson(previous)) fail()
    const bytes = Buffer.from(content)
    for (let offset = 0; offset < bytes.length;) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset)
      if (!written) fail()
      offset += written
    }
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  syncIntent(ctx)
  const accepted = readWorkspaceRelocationProcessStops(dataDir, id)
  if (sha256CanonicalJson(record) !== sha256CanonicalJson(accepted.completion ?? accepted.observations.at(-1))) fail()
  return accepted
}
export function observeWorkspaceRelocationProcesses({ dataDir, id, processes }) {
  const context = processStoppingContext(dataDir, id, true), previous = readWorkspaceRelocationProcessStops(dataDir, id)
  const latest = previous.observations.at(-1)
  if (!previous.attempt || !validProcesses(processes) || !extendsProcesses(latest?.processes ?? context.processes.processes, processes)) fail()
  if (latest && sha256CanonicalJson(latest.processes) === sha256CanonicalJson(processes)) { syncProcessStopFile(context.ctx); return latest }
  if (previous.completion) fail()
  const record = { type: 'observation', previous_sha256: sha256CanonicalJson(latest ?? previous.attempt), processes, created_at: new Date().toISOString() }
  return appendProcessStopRecord(dataDir, id, previous, record).observations.at(-1)
}
export function completeWorkspaceRelocationProcessStops({ dataDir, id }) {
  const { ctx } = processStoppingContext(dataDir, id, true), previous = readWorkspaceRelocationProcessStops(dataDir, id)
  const latest = previous.observations.at(-1)
  if (!previous.attempt || !latest) fail()
  const { probeKnownProcessExit } = knownProcessExit
  if (probeKnownProcessExit(latest.processes).state !== 'stopped') fail()
  if (previous.completion) { syncProcessStopFile(ctx); return previous.completion }
  const record = { type: 'known_scope_exited', previous_sha256: sha256CanonicalJson(latest), created_at: new Date().toISOString() }
  return appendProcessStopRecord(dataDir, id, previous, record).completion
}


const executionExitFile = 'relocation-execution-exit.json'
function workspaceExecutionExitMaterial(dataDir, id) {
  const coordinator = readWorkspaceRelocationCoordinator(dataDir, id), workers = readWorkspaceRelocationStops(dataDir, id)
  const modules = readWorkspaceRelocationModuleStops(dataDir, id), processes = readWorkspaceRelocationProcessStops(dataDir, id)
  if (!coordinator.launch || !coordinator.ready || !workers.attempt || !workers.submission || !modules.attempt || !modules.submission
    || !processes.completion || modules.submission.results.some(item => item.status === 'unknown')) fail()
  const known = new Map()
  for (const item of [...processes.observations.at(-1).processes,
    ...readWorkspaceRelocationModules(dataDir, id).modules.flatMap(item => item.processes),
    ...modules.observations.flatMap(item => item.processes)]) known.set(processKey(item), item)
  return { coordinator, processes: [...known.values()], hashes: { coordinator_sha256: sha256CanonicalJson(coordinator),
    worker_stops_sha256: sha256CanonicalJson(workers), module_stops_sha256: sha256CanonicalJson(modules), process_stops_sha256: sha256CanonicalJson(processes) } }
}
/** Historical fixed-scope fact only; neither fresh execution authority nor file permission. */
export function readWorkspaceRelocationExecutionExit(dataDir, id) {
  const { ctx, intent } = coordinatorContext(dataDir, id)
  const record = readPrivateJson(path.join(ctx.control, executionExitFile), 65536)
  if (record === undefined) return null
  const { hashes } = workspaceExecutionExitMaterial(dataDir, id)
  if (!fields(record, ['schema_version', 'intent_id', 'intent_sha256', ...Object.keys(hashes), 'created_at'])
    || record.schema_version !== 1 || record.intent_id !== id || record.intent_sha256 !== sha256CanonicalJson(intent)
    || !validDate(record.created_at) || Object.entries(hashes).some(([key, hash]) => record[key] !== hash)) fail()
  return record
}
export function commitWorkspaceRelocationExecutionExit({ dataDir, id }) {
  const { ctx, intent } = coordinatorContext(dataDir, id, true), token = cliLockToken(path.join(ctx.dataRoot, 'cli.lock'))
  const material = workspaceExecutionExitMaterial(dataDir, id)
  const verify = () => {
    const current = workspaceExecutionExitMaterial(dataDir, id), launch = material.coordinator.launch, self = native.inspectProcess(process.pid)
    if (!token || cliLockToken(path.join(ctx.dataRoot, 'cli.lock')) !== token || !native.sameProcess(launch.process, self)
      || self.parent !== launch.parent.pid || !native.sameProcess(launch.parent, native.inspectProcess(launch.parent.pid))
      || sha256CanonicalJson(current.hashes) !== sha256CanonicalJson(material.hashes)
      || knownProcessExit.probeKnownProcessExit(current.processes).state !== 'stopped') fail()
  }
  verify()
  const previous = readWorkspaceRelocationExecutionExit(dataDir, id)
  if (previous) { syncIntent(ctx); return previous }
  const record = { schema_version: 1, intent_id: id, intent_sha256: sha256CanonicalJson(intent), ...material.hashes, created_at: new Date().toISOString() }
  publishPrivateJson(ctx, path.join(ctx.control, executionExitFile), record, 65536, () => {
    verify()
    if (!same(intent.source, identity(intent.source.path)) || readWorkspaceRelocationExecutionExit(dataDir, id)) fail()
  })
  const accepted = readWorkspaceRelocationExecutionExit(dataDir, id)
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return accepted
}
