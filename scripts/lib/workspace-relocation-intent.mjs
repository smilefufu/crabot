import { validateWorkspaceRecoverySnapshot, verifyWorkspaceRecoverySnapshot } from './workspace-recovery-plan.mjs'
// Private fixed-job records only; submission receipts never prove exit or authorize moving/releasing maintenance.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import native from './process-identity.cjs'
import management from './desktop-management.cjs'
import knownProcessExit from './known-process-exit.cjs'
import { cliLockToken } from './cli-lock.mjs'
import { sha256CanonicalJson } from '../../crabot-shared/dist/canonical-json.js'
import { validateWorkspaceRootPublicationPlan } from './workspace-root-publish.mjs'
import { WorkspaceCatalog, projectWorkspaceCatalogRelocation } from '../../crabot-shared/dist/workspace-catalog.js'
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
    for (const file of ['relocation-workers.json', 'relocation-worker-processes.json', 'relocation-stop-attempt.json', 'relocation-stop-submission.json', 'relocation-modules.json', 'relocation-module-stop-attempt.json', 'relocation-module-processes', 'relocation-module-stop-submission.json', 'relocation-coordinator.json', 'relocation-coordinator-ready.json', 'relocation-process-stop.jsonl', 'relocation-execution-exit.json', 'relocation-files.json', 'relocation-file-actors.jsonl', 'relocation-worker-closure.json', 'relocation-worker-commits', 'relocation-manager-closure.json', 'relocation-manager-complete.json', 'relocation-root-plan.json']) {
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
  if (preview.mode === 'copy') {
    const { inspectWorkspaceCopySource } = await import('./workspace-copy.mjs')
    if ((await inspectWorkspaceCopySource(preview.source)).tree_fingerprint !== preview.inspection.fingerprint) fail()
  }
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
    absent(ctx, ['relocation-worker-processes.json', 'relocation-stop-attempt.json', 'relocation-stop-submission.json', ...moduleFiles, processStopFile, executionExitFile, filePlanFile, fileActorsFile])
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
    absent(ctx, ['relocation-stop-submission.json', executionExitFile, filePlanFile, fileActorsFile])
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
  if (value === undefined) { absent(ctx, [processStopFile, executionExitFile, filePlanFile, fileActorsFile]); return null }
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
  for (const name of [...names, closurePlanFile, closureCommitsDirectory, recoveryPlanFile, recoveryCommitFile, rootPlanFile]) {
    try { fs.lstatSync(path.join(ctx.control, name)); fail() }
    catch (error) { if (error.code !== 'ENOENT') fail() }
  }
}
function readModules(ctx, intent, workers) {
  const value = readPrivateJson(path.join(ctx.control, moduleFiles[0]), scopeLimit)
  if (value === undefined) { absent(ctx, [...moduleFiles.slice(1), processStopFile, executionExitFile, filePlanFile, fileActorsFile]); return null }
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
  if (ready === undefined) absent(ctx, [executionExitFile, filePlanFile, fileActorsFile])
  try {
    if (launch === undefined) {
      if (ready !== undefined || sha256CanonicalJson(read(ctx)) !== sha256CanonicalJson(intent)) fail()
      absent(ctx, [executionExitFile, filePlanFile, fileActorsFile])
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
  if (text === undefined) { absent(ctx, [executionExitFile, filePlanFile, fileActorsFile]); return { attempt: null, observations: [], completion: null } }
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


const executionExitFile = 'relocation-execution-exit.json', filePlanFile = 'relocation-files.json', fileActorsFile = 'relocation-file-actors.jsonl', closurePlanFile = 'relocation-worker-closure.json', closureCommitsDirectory = 'relocation-worker-commits'
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
  if (record === undefined) { absent(ctx, [filePlanFile, fileActorsFile]); return null }
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


const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function validFileObservation(value, intent) {
  if (!fields(value, ['source_identity', 'tree_fingerprint', 'metadata_fingerprint', 'entries'])
    || !fields(value.source_identity, ['dev', 'ino'], process.platform === 'win32' ? ['native_id'] : [])
    || value.source_identity.dev !== intent.source.dev || value.source_identity.ino !== intent.source.ino
    || process.platform === 'win32' && (typeof value.source_identity.native_id !== 'string' || !/^[0-9]+:[a-f0-9]{32}$/i.test(value.source_identity.native_id))
    || !digest(value.tree_fingerprint) || !digest(value.metadata_fingerprint) || !integer(value.entries) || value.entries < 1) fail()
}
/** Historical preparation plan only; first dispatch still requires the original live coordinator. */
export function readWorkspaceRelocationFilePlan(dataDir, id) {
  const { ctx, intent } = coordinatorContext(dataDir, id), record = readPrivateJson(path.join(ctx.control, filePlanFile), 65536)
  if (record === undefined) { absent(ctx, [fileActorsFile]); return null }
  const exit = readWorkspaceRelocationExecutionExit(dataDir, id)
  if (!exit || !fields(record, ['schema_version', 'intent_id', 'intent_sha256', 'execution_exit_sha256', 'catalog_sha256',
    'mode', 'source_observation', 'source_content_sha256', 'staging_parent', 'staging_parent_native_id', 'staging_path', 'created_at'])
    || record.schema_version !== 1 || record.intent_id !== id || record.intent_sha256 !== sha256CanonicalJson(intent)
    || record.execution_exit_sha256 !== sha256CanonicalJson(exit) || !digest(record.catalog_sha256) || !digest(record.source_content_sha256)
    || record.mode !== (intent.source.dev === intent.target_ancestor.dev ? 'rename' : 'copy') || !validIdentity(record.staging_parent)
    || record.staging_parent.path !== (intent.target_identity ? path.dirname(intent.target) : intent.target_ancestor.path)
    || record.staging_parent.dev !== intent.target_ancestor.dev
    || record.staging_path !== path.join(record.staging_parent.path, '.crabot-workspace-' + id)
    || (process.platform === 'win32' ? typeof record.staging_parent_native_id !== 'string' || !/^[0-9]+:[a-f0-9]{32}$/i.test(record.staging_parent_native_id) : record.staging_parent_native_id !== null)
    || !validDate(record.created_at)) fail()
  validFileObservation(record.source_observation, intent)
  return record
}
function workspaceFileCoordinatorContext(dataDir, id, signal) {
  const { ctx, intent } = coordinatorContext(dataDir, id, true), token = cliLockToken(path.join(ctx.dataRoot, 'cli.lock'))
  const material = workspaceExecutionExitMaterial(dataDir, id), exit = readWorkspaceRelocationExecutionExit(dataDir, id)
  const verify = () => {
    const current = workspaceExecutionExitMaterial(dataDir, id), launch = material.coordinator.launch, self = native.inspectProcess(process.pid)
    if (signal?.aborted || !exit || !process.connected || !token || cliLockToken(path.join(ctx.dataRoot, 'cli.lock')) !== token
      || !native.sameProcess(launch.process, self) || self.parent !== launch.parent.pid
      || !native.sameProcess(launch.parent, native.inspectProcess(launch.parent.pid))
      || sha256CanonicalJson(read(ctx)) !== sha256CanonicalJson(intent)
      || sha256CanonicalJson(current.hashes) !== sha256CanonicalJson(material.hashes)
      || sha256CanonicalJson(readWorkspaceRelocationExecutionExit(dataDir, id)) !== sha256CanonicalJson(exit)
      || knownProcessExit.probeKnownProcessExit(current.processes).state !== 'stopped') fail()
  }
  return { ctx, intent, exit, verify }
}
export async function prepareWorkspaceRelocationFilePlan({ dataDir, id, signal }) {
  const { ctx, intent, exit, verify } = workspaceFileCoordinatorContext(dataDir, id, signal)
  verify()
  const previous = readWorkspaceRelocationFilePlan(dataDir, id)
  if (previous) { syncIntent(ctx); return { dispatch: 'observe', plan: previous } }
  const catalog = new WorkspaceCatalog({ dataRoot: ctx.dataRoot, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native })
  const snapshot = await catalog.snapshot()
  if (snapshot.revision !== intent.catalog_revision || snapshot.storage_root !== intent.source.path
    || !same(intent.source, identity(intent.source.path))) fail()
  const preview = await inspectWorkspaceRelocationTarget(intent.source.path, intent.target, { protectedRoots: [ctx.control], signal })
  if (preview.mode === 'unchanged' || preview.inspection.issues.length || preview.usage.status !== 'complete'
    || !same(preview.source_identity, intent.source) || !same(preview.target_ancestor, intent.target_ancestor)
    || sha256CanonicalJson(preview.target_identity) !== sha256CanonicalJson(intent.target_identity)
    || preview.mode === 'copy' && (preview.usage.logical_bytes === undefined || BigInt(preview.usage.logical_bytes) > preview.available_bytes)) fail()
  const stagingParent = identity(preview.target_identity ? path.dirname(intent.target) : intent.target_ancestor.path)
  if (stagingParent.dev !== preview.target_ancestor.dev) fail()
  const stagingPath = path.join(stagingParent.path, '.crabot-workspace-' + id)
  const nativeId = process.platform === 'win32' ? native.inspectDirectoryFileId(stagingParent.path) : null
  try { fs.lstatSync(stagingPath); fail() } catch (error) { if (error.code !== 'ENOENT') throw error }
  const { inspectWorkspaceFileSource } = await import('./workspace-copy.mjs')
  const observation = await inspectWorkspaceFileSource(intent.source.path, preview.mode, { signal })
  const { inspectWorkspaceRelocationContent } = await import('../../crabot-shared/dist/workspace-relocation-content.js')
  const content = await inspectWorkspaceRelocationContent(intent.source.path, preview.mode, { signal })
  if (observation.tree_fingerprint !== preview.inspection.fingerprint || content.tree_fingerprint !== observation.tree_fingerprint
    || sha256CanonicalJson(await catalog.snapshot()) !== sha256CanonicalJson(snapshot)) fail()
  const record = { schema_version: 1, intent_id: id, intent_sha256: sha256CanonicalJson(intent), execution_exit_sha256: sha256CanonicalJson(exit),
    catalog_sha256: sha256CanonicalJson(snapshot), mode: preview.mode, source_observation: observation, source_content_sha256: content.fingerprint, staging_parent: stagingParent,
    staging_parent_native_id: nativeId, staging_path: stagingPath, created_at: new Date().toISOString() }
  publishPrivateJson(ctx, path.join(ctx.control, filePlanFile), record, 65536, () => {
    verify()
    if (!same(intent.source, identity(intent.source.path))
      || process.platform === 'win32' && native.inspectDirectoryFileId(intent.source.path) !== observation.source_identity.native_id
      || !same(stagingParent, identity(stagingParent.path))
      || nativeId !== null && native.inspectDirectoryFileId(stagingParent.path) !== nativeId
      || readWorkspaceRelocationFilePlan(dataDir, id)) fail()
    try { fs.lstatSync(stagingPath); fail() } catch (error) { if (error.code !== 'ENOENT') throw error }
  })
  const accepted = readWorkspaceRelocationFilePlan(dataDir, id)
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return { dispatch: 'dispatch', plan: accepted }
}


function validCopyTools(tools, host) {
  const roles = process.platform === 'win32' ? ['copy'] : ['pack', 'unpack']
  return ['darwin', 'linux', 'win32'].includes(process.platform) && Array.isArray(tools) && tools.length === roles.length && new Set(tools.map(item => item?.process?.pid)).size === roles.length
    && tools.every((item, index) => fields(item, ['role', 'process']) && item.role === roles[index] && validCoordinatorProcess(item.process)
      && item.process.parent === host.pid && item.process.pid !== host.pid && item.process.owner === host.owner)
}

function validPreparedStaging(row, plan) {
  const nativeId = value => process.platform === 'win32' ? typeof value === 'string' && /^[0-9]+:[a-f0-9]{32}$/i.test(value) : value === null
  if (!fields(row, ['type', 'previous_sha256', 'container', 'container_native_id', 'container_metadata_sha256', 'tree', 'tree_native_id', 'created_at'])
    || !digest(row.container_metadata_sha256) || !validIdentity(row.container) || row.container.path !== plan.staging_path
    || row.container.dev !== plan.staging_parent.dev || !nativeId(row.container_native_id)) return false
  if (plan.mode === 'rename') return row.tree === null && row.tree_native_id === null
  return validIdentity(row.tree) && row.tree.path === path.join(plan.staging_path, 'tree') && row.tree.dev === row.container.dev
    && row.tree.ino !== row.container.ino && nativeId(row.tree_native_id)
}

/** File actor facts are separate from the earlier business execution-exit fact. */
export function readWorkspaceRelocationFileActors(dataDir, id) {
  const { ctx } = coordinatorContext(dataDir, id), plan = readWorkspaceRelocationFilePlan(dataDir, id)
  if (!plan) fail()
  const empty = { attempt: null, host: null, permission: null, staging_attempt: null, staging: null, file_attempt: null, tools: null, tool_permission: null, tool_exit: null, file_ready: null }
  const text = readPrivateText(path.join(ctx.control, fileActorsFile), 65536)
  if (text === undefined) { absent(ctx, [closurePlanFile]); return empty }
  const coordinator = readWorkspaceRelocationCoordinator(dataDir, id)
  try {
    if (!text.endsWith('\n')) fail()
    const rows = text.slice(0, -1).split('\n').map(JSON.parse), [attempt, host, permission] = rows
    if (rows.length < 1 || rows.length > 10 || rows.some(row => !row) || !coordinator.ready
      || !fields(attempt, ['type', 'schema_version', 'intent_id', 'plan_sha256', 'coordinator_sha256', 'created_at'])
      || attempt.type !== 'attempt' || attempt.schema_version !== 1 || attempt.intent_id !== id
      || attempt.plan_sha256 !== sha256CanonicalJson(plan) || attempt.coordinator_sha256 !== sha256CanonicalJson(coordinator)
      || !validDate(attempt.created_at)) fail()
    if (host && (!fields(host, ['type', 'previous_sha256', 'process', 'created_at']) || host.type !== 'host'
      || host.previous_sha256 !== sha256CanonicalJson(attempt) || !validCoordinatorProcess(host.process)
      || host.process.pid === coordinator.launch.process.pid || host.process.parent !== coordinator.launch.process.pid
      || path.normalize(host.process.executable) !== path.normalize(coordinator.launch.process.executable) || !validDate(host.created_at))) fail()
    if (permission && (!fields(permission, ['type', 'previous_sha256', 'created_at']) || permission.type !== 'host_permitted'
      || permission.previous_sha256 !== sha256CanonicalJson(host) || !validDate(permission.created_at))) fail()
    let staging_attempt = null, staging = null, file_attempt = null, tools = null, tool_permission = null, tool_exit = null, file_ready = null, previous = permission
    for (const row of rows.slice(3)) {
      if (row.previous_sha256 !== sha256CanonicalJson(previous) || !validDate(row.created_at)) fail()
      if (row.type === 'staging_attempt' && !staging_attempt && !tools) {
        if (!fields(row, ['type', 'previous_sha256', 'created_at'])) fail()
        staging_attempt = row
      } else if (row.type === 'staging_prepared' && staging_attempt && !staging && !tools) {
        if (!validPreparedStaging(row, plan)) fail()
        staging = row
      } else if (row.type === 'file_attempt' && staging && !file_attempt && !tools && !file_ready) {
        if (!fields(row, ['type', 'previous_sha256', 'created_at'])) fail()
        file_attempt = row
      } else if (row.type === 'copy_tools' && file_attempt && !tools && !file_ready && plan.mode === 'copy') {
        if (!fields(row, ['type', 'previous_sha256', 'platform', 'tools', 'created_at']) || row.platform !== process.platform || !validCopyTools(row.tools, host.process)) fail()
        tools = row
      } else if (row.type === 'copy_tools_permitted' && tools && !tool_permission && !tool_exit) {
        if (!fields(row, ['type', 'previous_sha256', 'created_at'])) fail()
        tool_permission = row
      } else if (row.type === 'copy_tools_exited' && tools && !tool_exit) {
        if (!fields(row, ['type', 'previous_sha256', 'created_at'])) fail()
        tool_exit = row
      } else if (row.type === 'file_ready' && file_attempt && !file_ready && (plan.mode === 'rename' ? !tools : tool_exit)) {
        const expected = plan.mode === 'copy' ? staging.tree : { ...readWorkspaceRelocationIntent(dataDir).source, path: path.join(plan.staging_path, 'tree') }
        const nativeId = process.platform === 'win32' ? plan.mode === 'copy' ? staging.tree_native_id : plan.source_observation.source_identity.native_id : null
        if (!fields(row, ['type', 'previous_sha256', 'tree', 'tree_native_id', 'content_sha256', 'metadata_sha256', 'created_at'])
          || !validIdentity(row.tree) || !same(row.tree, expected) || row.tree_native_id !== nativeId
          || row.content_sha256 !== plan.source_content_sha256 || row.metadata_sha256 !== plan.source_observation.metadata_fingerprint) fail()
        file_ready = row
      } else fail()
      previous = row
    }
    return { attempt, host: host ?? null, permission: permission ?? null, staging_attempt, staging, file_attempt, tools, tool_permission, tool_exit, file_ready }
  } catch { fail() }
}

function syncFileActors(ctx) {
  const file = path.join(ctx.control, fileActorsFile), before = fs.lstatSync(file, { bigint: true })
  const fd = fs.openSync(file, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n) fail()
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  syncIntent(ctx)
}
export function prepareWorkspaceRelocationFileActors({ dataDir, id }) {
  const { ctx, verify } = workspaceFileCoordinatorContext(dataDir, id); verify()
  const previous = readWorkspaceRelocationFileActors(dataDir, id)
  if (previous.attempt) { syncFileActors(ctx); return { dispatch: 'observe', attempt: previous.attempt } }
  const record = { type: 'attempt', schema_version: 1, intent_id: id, plan_sha256: sha256CanonicalJson(readWorkspaceRelocationFilePlan(dataDir, id)),
    coordinator_sha256: sha256CanonicalJson(readWorkspaceRelocationCoordinator(dataDir, id)), created_at: new Date().toISOString() }
  publishPrivateJson(ctx, path.join(ctx.control, fileActorsFile), record, 65536, () => { verify(); if (readWorkspaceRelocationFileActors(dataDir, id).attempt) fail() })
  const accepted = readWorkspaceRelocationFileActors(dataDir, id).attempt
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return { dispatch: 'dispatch', attempt: accepted }
}
function appendFileActor(dataDir, id, previous, record) {
  const { ctx, verify } = workspaceFileCoordinatorContext(dataDir, id), file = path.join(ctx.control, fileActorsFile)
  verify()
  if (sha256CanonicalJson(readWorkspaceRelocationFileActors(dataDir, id)) !== sha256CanonicalJson(previous)) fail()
  const before = fs.lstatSync(file, { bigint: true }), bytes = Buffer.from(JSON.stringify(record) + '\n')
  if (before.size + BigInt(bytes.length) > 65536n) fail()
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1n
      || opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) fail()
    verify()
    for (let offset = 0; offset < bytes.length;) { const written = fs.writeSync(fd, bytes, offset, bytes.length - offset); if (!written) fail(); offset += written }
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  syncIntent(ctx)
  const result = readWorkspaceRelocationFileActors(dataDir, id)
  if (sha256CanonicalJson(result.file_ready ?? result.tool_exit ?? result.tool_permission ?? result.tools ?? result.file_attempt ?? result.staging ?? result.staging_attempt ?? result.permission ?? result.host) !== sha256CanonicalJson(record)) fail()
  return result
}
export function registerWorkspaceRelocationFileHost({ dataDir, id, process: host }) {
  const { ctx, verify } = workspaceFileCoordinatorContext(dataDir, id); verify()
  const previous = readWorkspaceRelocationFileActors(dataDir, id)
  if (!previous.attempt || !validCoordinatorProcess(host)) fail()
  if (previous.host) {
    if (sha256CanonicalJson(previous.host.process) !== sha256CanonicalJson(host)) fail()
    syncFileActors(ctx); return { dispatch: 'observe', host: previous.host }
  }
  const self = native.inspectProcess(process.pid)
  if (host.pid === self.pid || host.parent !== self.pid || path.normalize(host.executable) !== path.normalize(self.executable)
    || !native.sameProcess(host, native.inspectProcess(host.pid))) fail()
  const record = { type: 'host', previous_sha256: sha256CanonicalJson(previous.attempt), process: host, created_at: new Date().toISOString() }
  return { dispatch: 'dispatch', host: appendFileActor(dataDir, id, previous, record).host }
}
export function permitWorkspaceRelocationFileHost({ dataDir, id }) {
  const { ctx, verify } = workspaceFileCoordinatorContext(dataDir, id); verify()
  const previous = readWorkspaceRelocationFileActors(dataDir, id)
  if (!previous.host) fail()
  if (previous.permission) { syncFileActors(ctx); return { dispatch: 'observe', permission: previous.permission } }
  const host = previous.host.process, current = native.inspectProcess(host.pid)
  if (!native.sameProcess(host, current) || current.parent !== process.pid) fail()
  const record = { type: 'host_permitted', previous_sha256: sha256CanonicalJson(previous.host), created_at: new Date().toISOString() }
  return { dispatch: 'dispatch', permission: appendFileActor(dataDir, id, previous, record).permission }
}


function stagingMetadata(directory) {
  const metadata = native.inspectFileMetadata(directory).metadata
  if (!Buffer.isBuffer(metadata)) fail()
  return createHash('sha256').update(metadata).digest('hex')
}
function verifyStagingContainer(staging, names) {
  const stat = fs.lstatSync(staging.container.path)
  if (!same(staging.container, identity(staging.container.path)) || stagingMetadata(staging.container.path) !== staging.container_metadata_sha256
    || (process.platform === 'win32' ? !native.isPrivateDirectory(staging.container.path)
      || native.inspectDirectoryFileId(staging.container.path) !== staging.container_native_id
      : stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)
    || JSON.stringify(fs.readdirSync(staging.container.path)) !== JSON.stringify(names)) fail()
}
function verifyCopyStaging(staging) {
  verifyStagingContainer(staging, ['tree'])
  if (!staging.tree || !same(staging.tree, identity(staging.tree.path)) || fs.readdirSync(staging.tree.path).length
    || process.platform === 'win32' && native.inspectDirectoryFileId(staging.tree.path) !== staging.tree_native_id) fail()
}

export function registerWorkspaceRelocationCopyTools({ dataDir, id, tools }) {
  const { ctx, verify } = workspaceFileCoordinatorContext(dataDir, id); verify()
  const previous = readWorkspaceRelocationFileActors(dataDir, id)
  if (!previous.file_attempt || readWorkspaceRelocationFilePlan(dataDir, id).mode !== 'copy' || !validCopyTools(tools, previous.host.process)) fail()
  if (previous.tools) {
    if (sha256CanonicalJson(previous.tools.tools) !== sha256CanonicalJson(tools)) fail()
    syncFileActors(ctx); return { dispatch: 'observe', tools: previous.tools }
  }
  verifyCopyStaging(previous.staging)
  if (!native.sameProcess(previous.host.process, native.inspectProcess(previous.host.process.pid))) fail()
  for (const item of tools) if (!native.sameProcess(item.process, native.inspectProcess(item.process.pid))) fail()
  const record = { type: 'copy_tools', previous_sha256: sha256CanonicalJson(previous.file_attempt), platform: process.platform, tools, created_at: new Date().toISOString() }
  return { dispatch: 'dispatch', tools: appendFileActor(dataDir, id, previous, record).tools }
}
export function permitWorkspaceRelocationCopyTools({ dataDir, id }) {
  const { ctx, verify } = workspaceFileCoordinatorContext(dataDir, id); verify()
  const previous = readWorkspaceRelocationFileActors(dataDir, id)
  if (!previous.tools || previous.tool_exit) fail()
  if (previous.tool_permission) { syncFileActors(ctx); return { dispatch: 'observe', permission: previous.tool_permission } }
  verifyCopyStaging(previous.staging)
  if (!native.sameProcess(previous.host.process, native.inspectProcess(previous.host.process.pid))) fail()
  for (const item of previous.tools.tools) if (!native.sameProcess(item.process, native.inspectProcess(item.process.pid))) fail()
  const record = { type: 'copy_tools_permitted', previous_sha256: sha256CanonicalJson(previous.tools), created_at: new Date().toISOString() }
  return { dispatch: 'dispatch', permission: appendFileActor(dataDir, id, previous, record).tool_permission }
}
export function completeWorkspaceRelocationCopyTools({ dataDir, id }) {
  const { ctx, verify } = workspaceFileCoordinatorContext(dataDir, id); verify()
  const previous = readWorkspaceRelocationFileActors(dataDir, id)
  if (!previous.tools) fail()
  if (previous.tool_exit) { syncFileActors(ctx); return { dispatch: 'observe', completion: previous.tool_exit } }
  if (knownProcessExit.probeKnownProcessExit(previous.tools.tools.map(item => item.process)).state !== 'stopped') fail()
  const record = { type: 'copy_tools_exited', previous_sha256: sha256CanonicalJson(previous.tool_permission ?? previous.tools), created_at: new Date().toISOString() }
  return { dispatch: 'dispatch', completion: appendFileActor(dataDir, id, previous, record).tool_exit }
}


export function prepareWorkspaceRelocationStaging({ dataDir, id }) {
  const { ctx, intent, verify } = workspaceFileCoordinatorContext(dataDir, id); verify()
  const plan = readWorkspaceRelocationFilePlan(dataDir, id)
  let previous = readWorkspaceRelocationFileActors(dataDir, id)
  if (!previous.permission) fail()
  if (previous.staging) { syncFileActors(ctx); return { dispatch: 'observe', staging: previous.staging } }
  if (previous.staging_attempt || previous.tools) fail()
  const verifyPreparation = () => {
    verify()
    if (!native.sameProcess(previous.host.process, native.inspectProcess(previous.host.process.pid))
      || !same(intent.source, identity(intent.source.path)) || !same(plan.staging_parent, identity(plan.staging_parent.path))
      || process.platform === 'win32' && (native.inspectDirectoryFileId(plan.staging_parent.path) !== plan.staging_parent_native_id
        || native.inspectDirectoryFileId(intent.source.path) !== plan.source_observation.source_identity.native_id)) fail()
  }
  verifyPreparation()
  try { fs.lstatSync(plan.staging_path); fail() } catch (error) { if (error.code !== 'ENOENT') throw error }
  const attempt = { type: 'staging_attempt', previous_sha256: sha256CanonicalJson(previous.permission), created_at: new Date().toISOString() }
  previous = appendFileActor(dataDir, id, previous, attempt)
  const pins = []
  try {
    verifyPreparation()
    if (process.platform === 'win32') { native.createPrivateDirectory(plan.staging_path); pins.push(native.pinDirectory(plan.staging_path)) }
    else native.createPrivateStagingDirectory(plan.staging_path)
    const container = identity(plan.staging_path), containerNative = process.platform === 'win32' ? native.inspectDirectoryFileId(plan.staging_path) : null
    let tree = null, treeNative = null
    if (plan.mode === 'copy') {
      const target = path.join(plan.staging_path, 'tree')
      if (process.platform === 'win32') { native.createPrivateDirectory(target); pins.push(native.pinDirectory(target)) }
      else native.createPrivateStagingDirectory(target)
      tree = identity(target); treeNative = process.platform === 'win32' ? native.inspectDirectoryFileId(target) : null
      syncDirectory(target)
    }
    syncDirectory(plan.staging_path); syncDirectory(plan.staging_parent.path)
    verifyPreparation()
    if (!same(container, identity(plan.staging_path)) || tree && !same(tree, identity(tree.path))
      || JSON.stringify(fs.readdirSync(plan.staging_path)) !== JSON.stringify(tree ? ['tree'] : [])
      || tree && fs.readdirSync(tree.path).length) fail()
    const record = { type: 'staging_prepared', previous_sha256: sha256CanonicalJson(attempt), container, container_native_id: containerNative, container_metadata_sha256: stagingMetadata(plan.staging_path),
      tree, tree_native_id: treeNative, created_at: new Date().toISOString() }
    return { dispatch: 'dispatch', staging: appendFileActor(dataDir, id, previous, record).staging }
  } finally { for (const pin of pins.reverse()) native.releaseDirectoryPin(pin) }
}


export async function beginWorkspaceRelocationFiles({ dataDir, id, signal }) {
  const { ctx, intent, verify } = workspaceFileCoordinatorContext(dataDir, id, signal); verify()
  const plan = readWorkspaceRelocationFilePlan(dataDir, id), previous = readWorkspaceRelocationFileActors(dataDir, id)
  if (!previous.staging) fail()
  if (previous.file_attempt) { syncFileActors(ctx); return { dispatch: 'observe', attempt: previous.file_attempt } }
  if (!native.sameProcess(previous.host.process, native.inspectProcess(previous.host.process.pid)) || !same(intent.source, identity(intent.source.path))) fail()
  if (plan.mode === 'copy') verifyCopyStaging(previous.staging)
  else verifyStagingContainer(previous.staging, [])
  const catalog = new WorkspaceCatalog({ dataRoot: ctx.dataRoot, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native })
  if (sha256CanonicalJson(await catalog.snapshot()) !== plan.catalog_sha256) fail()
  verify()
  const record = { type: 'file_attempt', previous_sha256: sha256CanonicalJson(previous.staging), created_at: new Date().toISOString() }
  return { dispatch: 'dispatch', attempt: appendFileActor(dataDir, id, previous, record).file_attempt }
}

/** The fixed parent also requires its actual Host completion frame and normal ChildProcess exit before calling this verifier. */
export async function commitWorkspaceRelocationFileReady({ dataDir, id, signal }) {
  const { ctx, intent, verify } = workspaceFileCoordinatorContext(dataDir, id, signal); verify()
  const plan = readWorkspaceRelocationFilePlan(dataDir, id), previous = readWorkspaceRelocationFileActors(dataDir, id)
  if (!previous.file_attempt) fail()
  if (previous.file_ready) { syncFileActors(ctx); return { dispatch: 'observe', ready: previous.file_ready } }
  if (plan.mode === 'copy' && !previous.tool_exit) fail()
  const scope = [previous.host.process, ...(previous.tools?.tools ?? []).map(item => item.process)]
  if (knownProcessExit.probeKnownProcessExit(scope).state !== 'stopped') fail()
  verifyStagingContainer(previous.staging, ['tree'])
  const target = path.join(plan.staging_path, 'tree'), tree = identity(target)
  const expected = plan.mode === 'copy' ? previous.staging.tree : { ...intent.source, path: target }
  const nativeId = process.platform === 'win32' ? native.inspectDirectoryFileId(target) : null
  if (!same(tree, expected) || nativeId !== (process.platform === 'win32' ? plan.mode === 'copy' ? previous.staging.tree_native_id : plan.source_observation.source_identity.native_id : null)) fail()
  const { inspectWorkspaceRelocationContent } = await import('../../crabot-shared/dist/workspace-relocation-content.js')
  const { inspectWorkspaceFileSource } = await import('./workspace-copy.mjs')
  const { verifyWorkspaceRelocationCopy } = await import('./workspace-file-metadata.mjs')
  let metadata
  if (plan.mode === 'copy') {
    if (!same(intent.source, identity(intent.source.path))) fail()
    const proof = await verifyWorkspaceRelocationCopy(intent.source.path, target, { signal })
    if (proof.source_fingerprint !== plan.source_observation.tree_fingerprint) fail()
    metadata = proof.metadata_fingerprint
  } else {
    try { fs.lstatSync(intent.source.path); fail() } catch (error) { if (error.code !== 'ENOENT') throw error }
    metadata = (await inspectWorkspaceFileSource(target, 'rename', { signal })).metadata_fingerprint
  }
  const content = await inspectWorkspaceRelocationContent(target, plan.mode, { signal })
  const catalog = new WorkspaceCatalog({ dataRoot: ctx.dataRoot, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native })
  if (metadata !== plan.source_observation.metadata_fingerprint || content.fingerprint !== plan.source_content_sha256
    || sha256CanonicalJson(await catalog.snapshot()) !== plan.catalog_sha256) fail()
  verify(); verifyStagingContainer(previous.staging, ['tree'])
  if (!same(tree, identity(target)) || knownProcessExit.probeKnownProcessExit(scope).state !== 'stopped') fail()
  const record = { type: 'file_ready', previous_sha256: sha256CanonicalJson(previous.tool_exit ?? previous.file_attempt), tree,
    tree_native_id: nativeId, content_sha256: content.fingerprint, metadata_sha256: metadata, created_at: new Date().toISOString() }
  return { dispatch: 'dispatch', ready: appendFileActor(dataDir, id, previous, record).file_ready }
}


/** Historical bindings only; these digest values are not transferable write authorization. */
export function readWorkspaceRelocationClosureBindings(dataDir, id) {
  const intent = readWorkspaceRelocationIntent(dataDir), coordinator = readWorkspaceRelocationCoordinator(dataDir, id)
  const workers = readWorkspaceRelocationWorkers(dataDir, id), exit = readWorkspaceRelocationExecutionExit(dataDir, id)
  const plan = readWorkspaceRelocationFilePlan(dataDir, id), actors = readWorkspaceRelocationFileActors(dataDir, id)
  if (!intent || !coordinator.launch || !coordinator.ready || !workers || !exit || !plan || !actors.file_ready) fail()
  return Object.freeze({ intent_id: id, intent_sha256: sha256CanonicalJson(intent), coordinator_sha256: sha256CanonicalJson(coordinator),
    worker_scope_sha256: sha256CanonicalJson(workers), execution_exit_sha256: sha256CanonicalJson(exit),
    file_plan_sha256: sha256CanonicalJson(plan), file_ready_sha256: sha256CanonicalJson(actors.file_ready), catalog_sha256: plan.catalog_sha256 })
}

/** Only the original live, locked coordinator can establish current offline-close prerequisites. No writes. */
export async function verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal }) {
  const { ctx, intent, verify } = workspaceFileCoordinatorContext(dataDir, id, signal)
  verify()
  const bindings = readWorkspaceRelocationClosureBindings(dataDir, id), plan = readWorkspaceRelocationFilePlan(dataDir, id)
  const actors = readWorkspaceRelocationFileActors(dataDir, id), ready = actors.file_ready
  const scope = [actors.host.process, ...(actors.tools?.tools ?? []).map(item => item.process)]
  const current = () => {
    verify()
    if (sha256CanonicalJson(readWorkspaceRelocationClosureBindings(dataDir, id)) !== sha256CanonicalJson(bindings)
      || knownProcessExit.probeKnownProcessExit(scope).state !== 'stopped') fail()
    verifyStagingContainer(actors.staging, ['tree'])
    if (!same(ready.tree, identity(ready.tree.path))
      || process.platform === 'win32' && native.inspectDirectoryFileId(ready.tree.path) !== ready.tree_native_id) fail()
    if (plan.mode === 'copy') { if (!same(intent.source, identity(intent.source.path))) fail() }
    else { try { fs.lstatSync(intent.source.path); fail() } catch (error) { if (error.code !== 'ENOENT') throw error } }
  }
  current()
  const catalog = new WorkspaceCatalog({ dataRoot: ctx.dataRoot, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native })
  if (sha256CanonicalJson(await catalog.snapshot()) !== bindings.catalog_sha256) fail()
  current()
  return Object.freeze({ verified: true, ...bindings })
}


const ledgerVersion = value => typeof value === 'string' && /^-?[0-9]+(?::-?[0-9]+){8}$/.test(value)
const ledgerKeyName = key => encodeURIComponent(key).replace(/[.!~*'()]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')) + '.json'
function validClosurePlan(record, ctx, id) {
  if (!fields(record, ['schema_version', 'intent_id', 'bindings', 'closed_at', 'directories', 'names', 'ledgers'])
    || record.schema_version !== 1 || record.intent_id !== id || !validDate(record.closed_at)
    || sha256CanonicalJson(record.bindings) !== sha256CanonicalJson(readWorkspaceRelocationClosureBindings(ctx.dataRoot, id))
    || !Array.isArray(record.directories) || record.directories.length !== 3 || !Array.isArray(record.names) || !Array.isArray(record.ledgers)) fail()
  const paths = [ctx.dataRoot, path.join(ctx.dataRoot, 'agent'), path.join(ctx.dataRoot, 'agent/worker-ledgers')]
  for (const [index, item] of record.directories.entries()) {
    if (!fields(item, ['path', 'version', 'native_id']) || item.path !== paths[index] || !ledgerVersion(item.version)
      || (process.platform === 'win32' ? typeof item.native_id !== 'string' || !/^[0-9]+:[a-f0-9]{32}$/i.test(item.native_id) : item.native_id !== null)) fail()
  }
  if (record.names.some((name, index) => !nonempty(name) || path.basename(name) !== name || name === '.' || name === '..'
    || index > 0 && name <= record.names[index - 1])) fail()
  const scope = readWorkspaceRelocationWorkers(ctx.dataRoot, id), managers = new Set(), closed = new Set(), names = new Set(record.names), accounted = new Set()
  const owners = new Map(scope.workers.map(worker => [worker.worker_id, worker.manager_key]))
  let previous
  for (const item of record.ledgers) {
    const separator = typeof item?.manager_key === 'string' ? item.manager_key.indexOf('::') : -1
    if (!fields(item, ['name', 'manager_key', 'before_version', 'before_sha256', 'after_sha256', 'closed_worker_ids'])
      || separator < 1 || separator + 2 >= item.manager_key.length || item.name !== ledgerKeyName(item.manager_key) || !names.has(item.name)
      || previous !== undefined && item.name <= previous || managers.has(item.manager_key) || !ledgerVersion(item.before_version)
      || !digest(item.before_sha256) || !digest(item.after_sha256) || !Array.isArray(item.closed_worker_ids)
      || (item.closed_worker_ids.length === 0) !== (item.before_sha256 === item.after_sha256)) fail()
    managers.add(item.manager_key); accounted.add(item.name); previous = item.name
    for (const worker of item.closed_worker_ids) {
      if (!nonempty(worker) || owners.get(worker) !== item.manager_key || closed.has(worker)) fail()
      closed.add(worker)
    }
  }
  if (scope.workers.some(worker => !managers.has(worker.manager_key)) || record.names.some(name => name.endsWith('.json')
    && !/^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(name) && !accounted.has(name))) fail()
}
export function readWorkspaceRelocationClosurePlan(dataDir, id) {
  const { ctx } = coordinatorContext(dataDir, id), record = readPrivateJson(path.join(ctx.control, closurePlanFile), scopeLimit)
  if (record === undefined) return null
  try { validClosurePlan(record, ctx, id) } catch { fail() }
  return record
}

/** Technical closure plan only. Agent retains ledger contents; this never changes business state. */
export async function prepareWorkspaceRelocationClosurePlan({ dataDir, id, manifest, signal }) {
  const copy = structuredClone(manifest)
  await verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal })
  const { ctx, verify } = workspaceFileCoordinatorContext(dataDir, id, signal)
  const record = { schema_version: 1, intent_id: id, ...copy }
  validClosurePlan(record, ctx, id)
  const previous = readWorkspaceRelocationClosurePlan(dataDir, id)
  if (previous) {
    if (sha256CanonicalJson(previous) !== sha256CanonicalJson(record)) fail()
    syncIntent(ctx); return { dispatch: 'observe', plan: previous }
  }
  const version = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(':')
  const verifyInput = () => {
    verify()
    if (sha256CanonicalJson(record.bindings) !== sha256CanonicalJson(readWorkspaceRelocationClosureBindings(dataDir, id))) fail()
    for (const item of record.directories) {
      const stat = fs.lstatSync(item.path, { bigint: true })
      if (!stat.isDirectory() || stat.isSymbolicLink() || version(stat) !== item.version || fs.realpathSync(item.path) !== item.path
        || process.platform === 'win32' && native.inspectDirectoryFileId(item.path) !== item.native_id) fail()
    }
    const directory = record.directories[2].path
    if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(record.names)) fail()
    for (const item of record.ledgers) {
      const stat = fs.lstatSync(path.join(directory, item.name), { bigint: true })
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || version(stat) !== item.before_version) fail()
    }
  }
  verifyInput()
  publishPrivateJson(ctx, path.join(ctx.control, closurePlanFile), record, scopeLimit, () => {
    verifyInput(); if (readWorkspaceRelocationClosurePlan(dataDir, id)) fail()
  })
  await verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal })
  verifyInput()
  const accepted = readWorkspaceRelocationClosurePlan(dataDir, id)
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return { dispatch: 'dispatch', plan: accepted }
}


/** Historical completion digest only; Agent alone verifies and writes business ledgers. */
export function readWorkspaceRelocationClosureCommit(dataDir, id) {
  const { ctx } = coordinatorContext(dataDir, id), plan = readWorkspaceRelocationClosurePlan(dataDir, id)
  const directory = path.join(ctx.control, closureCommitsDirectory)
  if (!privateControl(directory)) return null
  if (!plan) fail()
  const header = readPrivateJson(path.join(directory, 'header.json'), 65536), stat = fs.lstatSync(directory, { bigint: true })
  const current = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(':').split(':')
  if (!fields(header, ['schema_version', 'intent_id', 'plan_sha256', 'directory_version', 'native_id'])
    || header.schema_version !== 1 || header.intent_id !== id || header.plan_sha256 !== sha256CanonicalJson(plan)
    || !ledgerVersion(header.directory_version) || [0, 1, 5, 6, 7].some(index => header.directory_version.split(':')[index] !== current[index])
    || (process.platform === 'win32' ? native.inspectDirectoryFileId(directory) !== header.native_id : header.native_id !== null)) fail()
  const complete = readPrivateJson(path.join(directory, 'complete.json'), scopeLimit)
  if (complete === undefined) return null
  const changed = plan.ledgers.map((item, index) => item.before_sha256 !== item.after_sha256 ? index : null).filter(index => index !== null)
  if (!fields(complete, ['schema_version', 'plan_sha256', 'receipts']) || complete.schema_version !== 1
    || complete.plan_sha256 !== header.plan_sha256 || !Array.isArray(complete.receipts) || complete.receipts.length !== changed.length) fail()
  for (const [position, row] of complete.receipts.entries()) {
    if (!fields(row, ['index', 'closed_sha256']) || row.index !== changed[position] || !digest(row.closed_sha256)) fail()
    const closed = readPrivateJson(path.join(directory, row.index + '.closed.json'), 65536)
    if (!fields(closed, ['version']) || !ledgerVersion(closed.version) || sha256CanonicalJson(closed) !== row.closed_sha256) fail()
  }
  return complete
}

const recoveryPlanFile = 'relocation-manager-closure.json'
function validRecoveryPlan(record, ctx, id) {
  const complete = readWorkspaceRelocationClosureCommit(ctx.dataRoot, id)
  if (!fields(record, ['schema_version', 'intent_id', 'bindings', 'worker_closure_sha256', 'snapshot_sha256', 'snapshot'])
    || record.schema_version !== 1 || record.intent_id !== id || !complete
    || sha256CanonicalJson(record.bindings) !== sha256CanonicalJson(readWorkspaceRelocationClosureBindings(ctx.dataRoot, id))
    || record.worker_closure_sha256 !== sha256CanonicalJson(complete) || record.snapshot_sha256 !== sha256CanonicalJson(record.snapshot)) fail()
  validateWorkspaceRecoverySnapshot(record.snapshot, ctx.dataRoot)
}
export function readWorkspaceRelocationRecoveryPlan(dataDir, id) {
  const { ctx } = coordinatorContext(dataDir, id), record = readPrivateJson(path.join(ctx.control, recoveryPlanFile), scopeLimit)
  if (record === undefined) return null
  try { validRecoveryPlan(record, ctx, id) } catch { fail() }
  return record
}
/** Technical Agent plan only; this never archives a checkpoint or settles business responsibility. */
export async function prepareWorkspaceRelocationRecoveryPlan({ dataDir, id, manifest, signal }) {
  const record = { schema_version: 1, intent_id: id, ...structuredClone(manifest) }
  await verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal })
  const { ctx, verify } = workspaceFileCoordinatorContext(dataDir, id, signal)
  validRecoveryPlan(record, ctx, id)
  const previous = readWorkspaceRelocationRecoveryPlan(dataDir, id)
  if (previous) {
    if (sha256CanonicalJson(previous) !== sha256CanonicalJson(record)) fail()
    syncIntent(ctx); return { dispatch: 'observe', plan: previous }
  }
  const verifyInput = () => { verify(); validRecoveryPlan(record, ctx, id); verifyWorkspaceRecoverySnapshot(record.snapshot, ctx.dataRoot) }
  verifyInput()
  publishPrivateJson(ctx, path.join(ctx.control, recoveryPlanFile), record, scopeLimit, () => {
    verifyInput(); if (readWorkspaceRelocationRecoveryPlan(dataDir, id)) fail()
  })
  await verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal })
  verifyInput()
  const accepted = readWorkspaceRelocationRecoveryPlan(dataDir, id)
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return { dispatch: 'dispatch', plan: accepted }
}

const recoveryCommitFile = 'relocation-manager-complete.json'
function validRecoveryCommit(record, plan, id) {
  const retirement = { schema_version: 1, intent_id: id, file_ready_sha256: plan.bindings.file_ready_sha256,
    worker_closure_sha256: plan.worker_closure_sha256, records: plan.snapshot.records }
  if (!fields(record, ['schema_version', 'intent_id', 'plan_sha256', 'retirement_sha256', 'checkpoints'])
    || record.schema_version !== 1 || record.intent_id !== id || record.plan_sha256 !== sha256CanonicalJson(plan)
    || record.retirement_sha256 !== sha256CanonicalJson(retirement) || !Array.isArray(record.checkpoints)
    || record.checkpoints.length !== plan.snapshot.checkpoints.length) fail()
  for (const [index, row] of record.checkpoints.entries()) if (!fields(row, ['index', 'manifest_sha256', 'complete_sha256'])
    || row.index !== index || !digest(row.manifest_sha256) || !digest(row.complete_sha256)) fail()
}
/** Historical completion digest only; the finite Agent role owns actual retirement/checkpoint validation. */
export function readWorkspaceRelocationRecoveryCommit(dataDir, id) {
  const { ctx } = coordinatorContext(dataDir, id), record = readPrivateJson(path.join(ctx.control, recoveryCommitFile), scopeLimit)
  if (record === undefined) return null
  const plan = readWorkspaceRelocationRecoveryPlan(dataDir, id)
  if (!plan) fail()
  validRecoveryCommit(record, plan, id)
  return record
}
export async function completeWorkspaceRelocationRecovery({ dataDir, id, manifest, signal, verifyEffects }) {
  const record = { schema_version: 1, intent_id: id, ...structuredClone(manifest) }
  await verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal })
  const { ctx, verify } = workspaceFileCoordinatorContext(dataDir, id, signal), plan = readWorkspaceRelocationRecoveryPlan(dataDir, id)
  if (!plan || typeof verifyEffects !== 'function') fail()
  validRecoveryCommit(record, plan, id)
  const verifyInput = () => {
    verify(); verifyEffects()
    if (sha256CanonicalJson(readWorkspaceRelocationRecoveryPlan(dataDir, id)) !== record.plan_sha256) fail()
  }
  verifyInput()
  const previous = readWorkspaceRelocationRecoveryCommit(dataDir, id)
  if (previous) {
    if (sha256CanonicalJson(previous) !== sha256CanonicalJson(record)) fail()
    syncIntent(ctx); return { dispatch: 'observe', commit_sha256: sha256CanonicalJson(previous) }
  }
  publishPrivateJson(ctx, path.join(ctx.control, recoveryCommitFile), record, scopeLimit, () => {
    verifyInput(); if (readWorkspaceRelocationRecoveryCommit(dataDir, id)) fail()
  })
  await verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal })
  verifyInput()
  if (sha256CanonicalJson(readWorkspaceRelocationRecoveryCommit(dataDir, id)) !== sha256CanonicalJson(record)) fail()
  return { dispatch: 'dispatch', commit_sha256: sha256CanonicalJson(record) }
}

const rootPlanFile = 'relocation-root-plan.json'
const rootFrame = (directory, nativeId = process.platform === 'win32' ? native.inspectDirectoryFileId(directory) : null) => ({ ...identity(directory), native_id: nativeId })
function validRootPlan(record, dataDir, id) {
  const intent = readWorkspaceRelocationIntent(dataDir), actors = readWorkspaceRelocationFileActors(dataDir, id)
  const worker = readWorkspaceRelocationClosureCommit(dataDir, id), recovery = readWorkspaceRelocationRecoveryCommit(dataDir, id)
  if (!fields(record, ['schema_version', 'intent_id', 'bindings', 'worker_commit_sha256', 'recovery_commit_sha256', 'publication', 'catalog_after_sha256', 'catalog_mappings'])
    || record.schema_version !== 1 || record.intent_id !== id || !worker || !recovery || !actors.file_ready
    || sha256CanonicalJson(record.bindings) !== sha256CanonicalJson(readWorkspaceRelocationClosureBindings(dataDir, id))
    || record.worker_commit_sha256 !== sha256CanonicalJson(worker) || record.recovery_commit_sha256 !== sha256CanonicalJson(recovery)
    || !digest(record.catalog_after_sha256) || !Array.isArray(record.catalog_mappings)) fail()
  const publication = record.publication
  validateWorkspaceRootPublicationPlan(publication)
  if (publication.intent_id !== id || publication.target !== intent.target
    || sha256CanonicalJson(publication.container) !== sha256CanonicalJson({ ...actors.staging.container, native_id: actors.staging.container_native_id })
    || sha256CanonicalJson(publication.tree) !== sha256CanonicalJson({ ...actors.file_ready.tree, native_id: actors.file_ready.tree_native_id })
    || (intent.target_identity === null ? publication.empty_target !== null : !publication.empty_target || !same(publication.empty_target, intent.target_identity))) fail()
  let previous, hasDefault = false
  for (const row of record.catalog_mappings) {
    if (!fields(row, ['workspace_id', 'before_root', 'after_root']) || typeof row.workspace_id !== 'string'
      || row.workspace_id !== 'default' && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(row.workspace_id)
      || previous !== undefined && row.workspace_id <= previous || !absolute(row.before_root) || !absolute(row.after_root)
      || path.normalize(row.before_root) !== row.before_root || path.normalize(row.after_root) !== row.after_root) fail()
    const relative = path.relative(intent.source.path, row.before_root)
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || row.after_root !== path.join(intent.target, relative)) fail()
    if (row.workspace_id === 'default') { if (relative !== 'default') fail(); hasDefault = true }
    previous = row.workspace_id
  }
  if (!hasDefault) fail()
}
/** Immutable historical plan; observing it cannot grant an execution or recovery role. */
export function readWorkspaceRelocationRootPlan(dataDir, id) {
  const { ctx } = coordinatorContext(dataDir, id), record = readPrivateJson(path.join(ctx.control, rootPlanFile), scopeLimit)
  if (record === undefined) return null
  validRootPlan(record, dataDir, id)
  return record
}
export async function prepareWorkspaceRelocationRootPlan({ dataDir, id, signal }) {
  const { ctx, intent, verify } = workspaceFileCoordinatorContext(dataDir, id, signal)
  verify()
  const previous = readWorkspaceRelocationRootPlan(dataDir, id)
  if (previous) { syncIntent(ctx); return { dispatch: 'observe', plan: previous } }
  await verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal })
  const agent = await import('../../crabot-agent/dist/core/workspace-relocation-closed-evidence.js')
  const evidence = await agent.inspectWorkspaceRelocationClosures({ dataDir, id, signal, verify: () => verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal }) })
  const actors = readWorkspaceRelocationFileActors(dataDir, id), catalog = new WorkspaceCatalog({ dataRoot: ctx.dataRoot, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native })
  const before = await catalog.snapshot(), bindings = readWorkspaceRelocationClosureBindings(dataDir, id)
  if (sha256CanonicalJson(before) !== bindings.catalog_sha256 || before.revision !== intent.catalog_revision || before.storage_root !== intent.source.path) fail()
  const after = projectWorkspaceCatalogRelocation(before, intent.target), parent = rootFrame(path.dirname(intent.target))
  const empty = intent.target_identity ? rootFrame(intent.target) : null
  const publication = { intent_id: id, container: { ...actors.staging.container, native_id: actors.staging.container_native_id },
    tree: { ...actors.file_ready.tree, native_id: actors.file_ready.tree_native_id }, target: intent.target, target_parent: parent, empty_target: empty }
  const record = { schema_version: 1, intent_id: id, bindings, worker_commit_sha256: evidence.worker_commit_sha256, recovery_commit_sha256: evidence.recovery_commit_sha256,
    publication, catalog_after_sha256: sha256CanonicalJson(after), catalog_mappings: before.workspaces.flatMap((item, index) => item.root === after.workspaces[index].root ? []
      : [{ workspace_id: item.workspace_id, before_root: item.root, after_root: after.workspaces[index].root }]).sort((a, b) => a.workspace_id < b.workspace_id ? -1 : 1) }
  validRootPlan(record, dataDir, id)
  const verifyInput = () => {
    verify(); evidence.verify(); validRootPlan(record, dataDir, id)
    verifyStagingContainer(actors.staging, ['tree'])
    if (sha256CanonicalJson(rootFrame(parent.path)) !== sha256CanonicalJson(parent)
      || sha256CanonicalJson(rootFrame(publication.tree.path)) !== sha256CanonicalJson(publication.tree)) fail()
    if (empty) { if (sha256CanonicalJson(rootFrame(intent.target)) !== sha256CanonicalJson(empty) || fs.readdirSync(intent.target).length) fail() }
    else { try { fs.lstatSync(intent.target); fail() } catch (error) { if (error.code !== 'ENOENT') throw error } }
  }
  verifyInput()
  if (sha256CanonicalJson(await catalog.snapshot()) !== bindings.catalog_sha256) fail()
  publishPrivateJson(ctx, path.join(ctx.control, rootPlanFile), record, scopeLimit, () => {
    verifyInput(); if (readWorkspaceRelocationRootPlan(dataDir, id)) fail()
  })
  await verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal }); verifyInput()
  const accepted = readWorkspaceRelocationRootPlan(dataDir, id)
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return { dispatch: 'dispatch', plan: accepted }
}
