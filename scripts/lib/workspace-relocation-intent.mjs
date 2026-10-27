import { validateWorkspaceRecoverySnapshot, verifyWorkspaceRecoverySnapshot } from './workspace-recovery-plan.mjs'
// Private fixed-job records only; submission receipts never prove exit or authorize moving/releasing maintenance.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import native from './process-identity.cjs'
import management from './desktop-management.cjs'
import workspaceMaintenance from './workspace-maintenance.cjs'
import knownProcessExit from './known-process-exit.cjs'
import ownedProcessTree from './owned-process-tree.cjs'
import { cliLockToken } from './cli-lock.mjs'
import { sha256CanonicalJson } from '../../crabot-shared/dist/canonical-json.js'
import { publishWorkspaceRoot, inspectPublishedWorkspaceRoot, validateWorkspaceRootPublicationPlan, publishWorkspaceParents, validateWorkspaceParentsPublicationPlan } from './workspace-root-publish.mjs'
import { WorkspaceCatalog, WorkspaceError, projectWorkspaceCatalogRelocation } from '../../crabot-shared/dist/workspace-catalog.js'
import { inspectWorkspaceRelocationTarget } from '../../crabot-shared/dist/workspace-relocation-target.js'
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')
const fail = (code = 'WORKSPACE_RELOCATION_INVALID', stage) => { throw Object.assign(new Error('工作目录迁移记录无法核验或操作冲突，原目录和维护保护已保留。'), { code, ...(stage ? { stage } : {}) }) }

// One synchronous historical graph only. No live role/exit check or asynchronous
// operation may reuse this frame; every returned graph rechecks its actual inputs.
let recordObservation = null
const observedVersion = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(':')
const observedRootIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
function observationVersion(file, kind, stat) {
  return kind === 'data' && recordObservation.roots.has(file) ? observedRootIdentity(stat) : observedVersion(stat)
}
function observeRecordPath(file, kind, stat) {
  if (!recordObservation) return
  if (!stat) kind = 'missing'
  if (stat && kind === 'data' && !recordObservation.roots.has(file)) {
    // Pin the actual directory generation. Its unrelated entries may change;
    // all private control directories and record files still use full versions.
    if (process.platform !== 'win32') {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
      recordObservation.roots.set(file, () => fs.closeSync(fd))
      if (observedRootIdentity(fs.fstatSync(fd, { bigint: true })) !== observedRootIdentity(stat)) fail()
    } else if (/^[a-z]:[\\/]/i.test(file) || /^\\\\\?\\[a-z]:\\/i.test(file)) {
      const pin = native.pinDirectory(file)
      recordObservation.roots.set(file, () => native.releaseDirectoryPin(pin))
      if (pin.identity !== native.inspectDirectoryFileId(file) || observedRootIdentity(fs.lstatSync(file, { bigint: true })) !== observedRootIdentity(stat)) fail()
    }
  }
  const version = stat ? observationVersion(file, kind, stat) : null, previous = recordObservation.paths.get(file)
  if (previous && (previous.kind !== kind || previous.version !== version)) fail(undefined, 'record-input-' + kind + '-changed')
  recordObservation.paths.set(file, { kind, version })
}
function verifyRecordObservation(frame) {
  for (const [file, observed] of frame.paths) {
    let stat
    try { stat = fs.lstatSync(file, { bigint: true }) }
    catch (error) { if (error.code !== 'ENOENT' || observed.version !== null) fail(); continue }
    if (observed.version === null || observationVersion(file, observed.kind, stat) !== observed.version || stat.isSymbolicLink()) fail(undefined, 'record-recheck-' + observed.kind)
    if (observed.kind === 'data') {
      if (management.requireExistingDataRoot(file) !== file) fail()
    } else {
      const directory = observed.kind === 'directory'
      if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) fail()
      let privatePath
      if (process.platform === 'win32') privatePath = directory ? native.isPrivateDirectory(file) : native.isPrivateFile(file)
      else privatePath = stat.uid === BigInt(process.getuid()) && (stat.mode & 0o777n) === (directory ? 0o700n : 0o600n)
      if (!privatePath) fail()
    }
    if (observationVersion(file, observed.kind, fs.lstatSync(file, { bigint: true })) !== observed.version) fail()
  }
}
function recordGraphReader(reader) {
  return function(dataDir, id) {
    const outer = recordObservation === null
    const frame = recordObservation ?? { values: new Map(), bytes: new Map(), paths: new Map(), roots: new Map(), dataRoots: new Map() }
    if (outer) recordObservation = frame
    try {
      let values = frame.values.get(reader)
      if (!values) { values = new Map(); frame.values.set(reader, values) }
      const key = JSON.stringify([dataDir, id])
      if (values.has(key)) return values.get(key)
      const result = reader(dataDir, id)
      values.set(key, result)
      if (outer) verifyRecordObservation(frame)
      return result
    } finally {
      if (outer) {
        recordObservation = null
        for (const release of frame.roots.values()) release()
      }
    }
  }
}
/** One trusted synchronous read only; no frame, handle or role survives an await. */
export function observeWorkspaceRelocationRecords(reader) {
  if (typeof reader !== 'function' || reader.constructor?.name === 'AsyncFunction') fail()
  return recordGraphReader(function observeSynchronousRecords() {
    const result = reader()
    if (result && typeof result.then === 'function') fail()
    return result
  })()
}
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
const legacyRelocationFiles = ['relocation.json', 'relocation-workers.json', 'relocation-worker-processes.json', 'relocation-stop-attempt.json', 'relocation-stop-submission.json', 'relocation-modules.json', 'relocation-module-stop-attempt.json', 'relocation-module-processes', 'relocation-module-stop-submission.json', 'relocation-coordinator.json', 'relocation-coordinator-ready.json', 'relocation-process-stop.jsonl', 'relocation-execution-exit.json', 'relocation-files.json', 'relocation-file-actors.jsonl', 'relocation-worker-closure.json', 'relocation-worker-commits', 'relocation-manager-closure.json', 'relocation-manager-complete.json', 'relocation-root-plan.json', 'relocation-root-published.json', 'relocation-root-selected.json', 'relocation-root-parents.json', 'relocation-root-parents-complete.json', 'relocation-health.json']
function context(dataDir, locked = false) {
  // Only the pure synchronous graph shares this pinned root. Mutating callers
  // still validate immediately; the outer reader rechecks actual root permissions.
  const cached = !locked && recordObservation?.dataRoots.get(dataDir)
  const dataRoot = cached || management.requireExistingDataRoot(dataDir)
  if (recordObservation && !cached) {
    observeRecordPath(dataRoot, 'data', fs.lstatSync(dataRoot, { bigint: true }))
    if (!locked) recordObservation.dataRoots.set(dataDir, dataRoot)
  }
  if (locked && !cliLockToken(path.join(dataRoot, 'cli.lock'))) fail()
  const baseControl = path.join(dataRoot, 'workspace-control'), control = path.join(baseControl, 'relocation-active')
  return { dataRoot, baseControl, control, file: path.join(control, 'relocation.json') }
}
function privateControl(control) {
  // Trusted synchronous reads share directory facts; the outer frame still
  // rechecks actual identity, permissions and versions before returning.
  const observed = recordObservation?.paths.get(control)
  if (observed?.kind === 'directory') return true
  if (observed?.kind === 'missing') return false
  let stat
  try { stat = fs.lstatSync(control) }
  catch (error) {
    if (error.code !== 'ENOENT') fail()
    observeRecordPath(control, 'directory')
    return false
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform === 'win32' ? !native.isPrivateDirectory(control)
    : stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)) fail()
  if (recordObservation) observeRecordPath(control, 'directory', fs.lstatSync(control, { bigint: true }))
  return true
}
function readPrivateBytes(file, limit) {
  let before
  try { before = fs.lstatSync(file, { bigint: true }) }
  catch (error) {
    if (error.code !== 'ENOENT') fail()
    observeRecordPath(file, 'file')
    return undefined
  }
  observeRecordPath(file, 'file', before)
  let fd
  try {
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)) fail()
    const owner = process.platform === 'win32' ? native.isPrivateFile(file)
      : before.uid === BigInt(process.getuid()) && (before.mode & 0o777n) === 0o600n
    if (!owner) fail()
    const cached = recordObservation?.bytes.get(file)
    if (cached) return Buffer.from(cached)
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const stat = fs.fstatSync(fd, { bigint: true })
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) fail()
    const value = fs.readFileSync(fd)
    const after = fs.lstatSync(file, { bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) fail()
    recordObservation?.bytes.set(file, Buffer.from(value))
    return value
  } catch { fail() } finally { if (fd !== undefined) fs.closeSync(fd) }
}
function readPrivateText(file, limit) { return readPrivateBytes(file, limit)?.toString('utf8') }
function readPrivateJson(file, limit) {
  const text = readPrivateText(file, limit)
  try { return text === undefined ? undefined : JSON.parse(text) } catch { fail() }
}
const assertNoLegacyRelocation = recordGraphReader(function assertNoLegacyRelocation(dataDir) {
  const control = path.join(dataDir, 'workspace-control')
  if (!privateControl(control)) return
  for (const name of legacyRelocationFiles) {
    const file = path.join(control, name)
    try { fs.lstatSync(file); fail() }
    catch (error) { if (error.code !== 'ENOENT') fail() }
    observeRecordPath(file, 'file')
  }
})
function read(ctx) {
  if (!privateControl(ctx.baseControl)) return null
  assertNoLegacyRelocation(ctx.dataRoot)
  if (!privateControl(ctx.control)) {
    if (readPrivateText(path.join(ctx.baseControl, 'relocation-finalizing.json'), 65536) !== undefined) fail()
    return null
  }
  const value = readPrivateJson(ctx.file, 65536)
  if (value === undefined) fail()
  try {
    if (![1, 2].includes(value?.schema_version) || Object.keys(value).length !== (value.schema_version === 1 ? 12 : 13)
      || value.schema_version === 2 && (!['exact', 'windows-owner-inheritance-v1'].includes(value.metadata_compatibility)
        || value.metadata_compatibility !== 'exact' && (process.platform !== 'win32' || value.source?.dev === value.target_ancestor?.dev))
      || value.schema_version === 1 && Object.hasOwn(value, 'metadata_compatibility') || !uuid(value.id) || value.phase !== 'freezing'
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
function syncIntent(ctx) { syncDirectory(ctx.control); syncDirectory(ctx.baseControl); syncDirectory(ctx.dataRoot) }
export const readWorkspaceRelocationIntent = recordGraphReader(function readWorkspaceRelocationIntent(dataDir) { return read(context(dataDir)) })

function assertArchiveUnused(ctx, id) {
  if (!privateControl(ctx.baseControl)) return
  const history = path.join(ctx.baseControl, 'relocation-history')
  if (!privateControl(history)) return
  for (const name of [id, id + '.released.json']) {
    try { fs.lstatSync(path.join(history, name)); fail('WORKSPACE_RELOCATION_CONFLICT') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
export async function beginWorkspaceRelocationIntent(options) {
  const ctx = context(options.dataDir, true), operationToken = cliLockToken(path.join(ctx.dataRoot, 'cli.lock'))
  const dataIdentity = identity(ctx.dataRoot)
  if (!uuid(options.id) || !absolute(options.target) || !Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1
    || !Array.isArray(options.protectedRoots) || options.protectedRoots.some(root => !absolute(root))
    || options.managedDefaultTarget !== undefined && !absolute(options.managedDefaultTarget)
    || options.protectedTargets !== undefined && (!Array.isArray(options.protectedTargets) || options.protectedTargets.some(root => !absolute(root)))) fail()
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
  assertArchiveUnused(ctx, options.id)
  const storageRoot = process.env.WORKER_WORKSPACES_DIR
  const catalog = new WorkspaceCatalog({ dataRoot: ctx.dataRoot, storageRoot, files: native })
  const snapshot = await catalog.snapshot()
  if (snapshot.revision !== options.expectedRevision) fail('WORKSPACE_REVISION_CONFLICT')
  const baseControlIdentity = identity(ctx.baseControl)
  const preview = await inspectWorkspaceRelocationTarget(snapshot.storage_root, requestedTarget,
    { protectedRoots: [...options.protectedRoots, ctx.baseControl], protectedTargets: options.protectedTargets, managedDefaultTarget: options.managedDefaultTarget, inspectTargetAccess: native.inspectDirectoryWriteAccess })
  if (process.env.WORKER_WORKSPACES_DIR !== storageRoot || storageRoot !== undefined && preview.mode !== 'unchanged') {
    throw new WorkspaceError('WORKSPACE_DIRECTORY_CONFLICT', '当前部署通过 WORKER_WORKSPACES_DIR 固定了工作区位置或预检期间环境发生变化；未停止任务或修改目录选择。')
  }
  if (preview.mode === 'unchanged') return { unchanged: true, source: preview.source }
  if (preview.inspection.issues.length || preview.usage.status !== 'complete') fail('WORKSPACE_RELOCATION_BLOCKED')
  if (preview.mode === 'copy' && (preview.usage.logical_bytes === undefined || BigInt(preview.usage.logical_bytes) > preview.available_bytes)) fail('WORKSPACE_RELOCATION_BLOCKED')
  const metadataCompatibility = process.platform === 'win32' && preview.mode === 'copy' ? 'windows-owner-inheritance-v1' : 'exact'
  if (preview.mode === 'copy') {
    const { inspectWorkspaceCopySource } = await import('./workspace-copy.mjs')
    if ((await inspectWorkspaceCopySource(preview.source, { metadataCompatibility })).tree_fingerprint !== preview.inspection.fingerprint) fail()
  }
  if ((await catalog.snapshot()).revision !== snapshot.revision) fail('WORKSPACE_REVISION_CONFLICT')
  if (!same(dataIdentity, identity(ctx.dataRoot)) || !same(preview.source_identity, identity(preview.source))
    || !same(preview.target_ancestor, identity(preview.target_ancestor.path))) fail()
  if (preview.target_identity) { if (!same(preview.target_identity, identity(preview.target))) fail() }
  else { try { fs.lstatSync(preview.target); fail() } catch (error) { if (error.code !== 'ENOENT') throw error } }
  const verifyAdmission = () => {
    if (process.env.WORKER_WORKSPACES_DIR !== storageRoot || cliLockToken(path.join(ctx.dataRoot, 'cli.lock')) !== operationToken
      || !same(dataIdentity, identity(ctx.dataRoot)) || !same(baseControlIdentity, identity(ctx.baseControl)) || !privateControl(ctx.baseControl)) fail()
    assertArchiveUnused(ctx, options.id)
  }
  verifyAdmission()
  if (read(ctx)) fail('WORKSPACE_RELOCATION_CONFLICT')
  const staging = path.join(ctx.baseControl, '.relocation-pending-' + randomUUID())
  if (process.platform === 'win32') native.createPrivateDirectory(staging)
  else fs.mkdirSync(staging, { mode: 0o700 })
  let stagedIdentity
  try {
    stagedIdentity = identity(staging)
    const controlIdentity = { ...stagedIdentity, path: ctx.control }
    const record = { schema_version: 2, metadata_compatibility: metadataCompatibility, id: options.id, phase: 'freezing', catalog_revision: snapshot.revision,
      data_root: dataIdentity, control_root: controlIdentity, source: preview.source_identity, target: preview.target, requested_target: requestedTarget,
      target_identity: preview.target_identity, target_ancestor: preview.target_ancestor, created_at: new Date().toISOString() }
    const prepared = { ...ctx, control: staging, file: path.join(staging, 'relocation.json') }
    const verifyPrepared = () => {
      verifyAdmission()
      if (!same(stagedIdentity, identity(staging)) || !privateControl(staging)) fail()
      if (read(ctx)) fail('WORKSPACE_RELOCATION_CONFLICT')
    }
    verifyPrepared()
    publishPrivateJson(prepared, prepared.file, record, 65536, verifyPrepared)
    verifyPrepared()
    native.renameDirectoryNoReplace(staging, ctx.control)
    syncIntent(ctx)
    verifyAdmission()
    const accepted = read(ctx)
    if (!accepted || sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
    return accepted
  } finally {
    // Only reclaim our still-empty unpublished directory; retain unknown contents or effects.
    try { if (stagedIdentity && same(stagedIdentity, identity(staging))) fs.rmdirSync(staging) } catch {}
  }
}

function publishPrivateJson(ctx, file, value, limit, verify, temporaryDirectory = ctx.control) {
  const temporary = path.join(temporaryDirectory, '.relocation-' + randomUUID())
  try {
    const content = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(content) > limit) fail()
    if (process.platform === 'win32') { native.writePrivateFile(temporary, ''); fs.writeFileSync(temporary, content, { flag: 'r+', flush: true }) }
    else fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600, flush: true })
    verify(temporary)
    // No replacement: preserve even an unexpected entry appearing under the held lock.
    try { fs.linkSync(temporary, file) } catch (error) { if (error.code === 'EEXIST') fail('WORKSPACE_RELOCATION_CONFLICT'); throw error }
  } finally { fs.rmSync(temporary, { force: true }) }
  syncIntent(ctx)
  if (temporaryDirectory !== ctx.control) syncDirectory(temporaryDirectory)
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
export const readWorkspaceRelocationWorkers = recordGraphReader(function readWorkspaceRelocationWorkers(dataDir, id) {
  const ctx = context(dataDir), intent = read(ctx)
  if (!intent || intent.id !== id) fail()
  return readScope(ctx, intent)
})
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
export const readWorkspaceRelocationStops = recordGraphReader(function readWorkspaceRelocationStops(dataDir, id) {
  const { ctx, intent, scope } = stoppingContext(dataDir, id), attempt = readStopAttempt(ctx, intent, scope)
  const submission = readStopSubmission(ctx, attempt, scope)
  if (sha256CanonicalJson(readScope(ctx, read(ctx))) !== sha256CanonicalJson(scope)) fail()
  return { attempt, submission }
})
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
// A historical reader may have reused an exited generation's PID; new observations never include self.
function validProcesses(processes, historical = false) {
  if (!Array.isArray(processes) || processes.length > 32768) return false
  const self = native.inspectProcess(process.pid), seen = new Set()
  let previous
  for (const item of processes) {
    if (!fields(item, ['pid', 'parent', 'started', 'owner', 'executable'])
      || !Number.isInteger(item.pid) || item.pid < 1 || item.pid > 2147483647
      || item.pid === process.pid && (!historical || item.started === self.started)
      || !Number.isInteger(item.parent) || item.parent < 0 || item.parent > 2147483647
      || !nonempty(item.started) || item.owner !== self.owner || !nonempty(item.executable) || seen.has(processKey(item))
      || previous && (item.pid < previous.pid || item.pid === previous.pid && item.started <= previous.started)) return false
    seen.add(processKey(item)); previous = item
  }
  return true
}
/** First pre-stop observation only; this never proves global ownership or execution exit. */
export const readWorkspaceRelocationProcesses = recordGraphReader(function readWorkspaceRelocationProcesses(dataDir, id) {
  const { ctx, intent, scope } = stoppingContext(dataDir, id)
  const value = readPrivateJson(path.join(ctx.control, 'relocation-worker-processes.json'), scopeLimit)
  if (value === undefined) { absent(ctx, [processStopFile, executionExitFile, filePlanFile, fileActorsFile]); return null }
  if (!fields(value, ['schema_version', 'intent_id', 'intent_sha256', 'workers_sha256', 'processes', 'created_at'])
    || value.schema_version !== 1 || value.intent_id !== id || value.intent_sha256 !== sha256CanonicalJson(intent)
    || value.workers_sha256 !== sha256CanonicalJson(scope) || !validProcesses(value.processes, true) || !validDate(value.created_at)
    || sha256CanonicalJson(readWorkspaceRelocationWorkers(dataDir, id)) !== value.workers_sha256) fail()
  return value
})
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

function validModules(modules, historical = false) {
  if (!Array.isArray(modules)) return false
  let previous, instance
  const pids = new Set(), runtimes = new Set()
  for (const item of modules) {
    if (!fields(item, ['instance_id', 'module_id', 'module_port', 'processes'], ['runtime_id'])
      || !nonempty(item.instance_id) || instance !== undefined && instance !== item.instance_id
      || !nonempty(item.module_id) || item.module_id === 'admin-web' || previous !== undefined && item.module_id <= previous
      || !Number.isInteger(item.module_port) || item.module_port < 1 || item.module_port > 65535 || !validProcesses(item.processes, historical)
      || Object.hasOwn(item, 'runtime_id') && (!nonempty(item.runtime_id) || runtimes.has(item.runtime_id))
      || Boolean(item.runtime_id) !== Boolean(item.processes.length)) return false
    for (const process of item.processes) { if (pids.has(process.pid)) return false; pids.add(process.pid) }
    if (item.runtime_id) runtimes.add(item.runtime_id)
    previous = item.module_id; instance = item.instance_id
  }
  return true
}
/** Shape only for current execution capture; no original job, stop or process authority. */
export function assertWorkspaceExecutionScopeShape(value) {
  if (!fields(value, ['workers', 'processes', 'modules']) || !validWorkers(value.workers)
    || !validProcesses(value.processes, true) || !validModules(value.modules, true)) fail()
}
function absent(ctx, names) {
  for (const name of [...names, closurePlanFile, closureCommitsDirectory, recoveryPlanFile, recoveryCommitFile, rootPlanFile, rootPublishedFile, rootSelectedFile, rootParentsFile, rootParentsCompleteFile]) {
    try { fs.lstatSync(path.join(ctx.control, name)); fail() }
    catch (error) { if (error.code !== 'ENOENT') fail(); observeRecordPath(path.join(ctx.control, name), 'missing') }
  }
}
function readModules(ctx, intent, workers) {
  const value = readPrivateJson(path.join(ctx.control, moduleFiles[0]), scopeLimit)
  if (value === undefined) { absent(ctx, [...moduleFiles.slice(1), processStopFile, executionExitFile, filePlanFile, fileActorsFile]); return null }
  if (!fields(value, ['schema_version', 'intent_id', 'intent_sha256', 'workers_sha256', 'modules', 'created_at']) || value.schema_version !== 1
    || value.intent_id !== intent.id || value.intent_sha256 !== sha256CanonicalJson(intent) || value.workers_sha256 !== sha256CanonicalJson(workers)
    || !validModules(value.modules, true) || !validDate(value.created_at)) fail()
  return value
}
export const readWorkspaceRelocationModules = recordGraphReader(function readWorkspaceRelocationModules(dataDir, id) {
  const { ctx, intent, scope } = stoppingContext(dataDir, id)
  return readModules(ctx, intent, scope)
})
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
      || value.sequence !== index || value.previous_sha256 !== previous || !validDate(value.created_at) || !validProcesses(value.processes, true)
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
export const readWorkspaceRelocationModuleStops = recordGraphReader(function readWorkspaceRelocationModuleStops(dataDir, id) {
  const { ctx, modules } = moduleStoppingContext(dataDir, id), attempt = readModuleAttempt(ctx, modules)
  const observations = readModuleObservations(ctx, attempt, modules), submission = readModuleSubmission(ctx, attempt, modules, observations)
  if (sha256CanonicalJson(readWorkspaceRelocationModules(dataDir, id)) !== sha256CanonicalJson(modules)) fail()
  return { attempt, observations, submission }
})
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
export const readWorkspaceRelocationCoordinator = recordGraphReader(function readWorkspaceRelocationCoordinator(dataDir, id) {
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
})
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
export const readWorkspaceRelocationProcessStops = recordGraphReader(function readWorkspaceRelocationProcessStops(dataDir, id) {
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
        if (!fields(row, ['type', 'previous_sha256', 'processes', 'created_at']) || !validProcesses(row.processes, true)
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
})
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
  if (previous.observations.length >= 32767 || selected.size + BigInt(Buffer.byteLength(content)) > BigInt(scopeLimit)) fail(undefined, 'process-stop-limit')
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const current = fs.fstatSync(fd, { bigint: true })
    if (current.dev !== selected.dev || current.ino !== selected.ino || current.size !== selected.size
      || current.mtimeNs !== selected.mtimeNs || current.ctimeNs !== selected.ctimeNs || current.nlink !== 1n
      || !token || cliLockToken(path.join(ctx.dataRoot, 'cli.lock')) !== token
      || !same(intent.source, identity(intent.source.path))
      || sha256CanonicalJson(readWorkspaceRelocationProcessStops(dataDir, id)) !== sha256CanonicalJson(previous)) fail(undefined, 'process-stop-append-preflight')
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
  if (sha256CanonicalJson(record) !== sha256CanonicalJson(accepted.completion ?? accepted.observations.at(-1))) fail(undefined, 'process-stop-append-readback')
  return accepted
}
export function observeWorkspaceRelocationProcesses({ dataDir, id, processes }) {
  const context = processStoppingContext(dataDir, id, true), previous = readWorkspaceRelocationProcessStops(dataDir, id)
  const latest = previous.observations.at(-1)
  if (!previous.attempt) fail(undefined, 'process-stop-attempt')
  if (!validProcesses(processes)) fail(undefined, 'process-stop-shape')
  if (!extendsProcesses(latest?.processes ?? context.processes.processes, processes)) fail(undefined, 'process-stop-monotonic')
  if (latest && sha256CanonicalJson(latest.processes) === sha256CanonicalJson(processes)) { syncProcessStopFile(context.ctx); return latest }
  if (previous.completion) fail(undefined, 'process-stop-completed')
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
const workspaceExecutionExitMaterial = recordGraphReader(function workspaceExecutionExitMaterial(dataDir, id) {
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
})
/** Historical fixed-scope fact only; neither fresh execution authority nor file permission. */
export const readWorkspaceRelocationExecutionExit = recordGraphReader(function readWorkspaceRelocationExecutionExit(dataDir, id) {
  const { ctx, intent } = coordinatorContext(dataDir, id)
  const record = readPrivateJson(path.join(ctx.control, executionExitFile), 65536)
  if (record === undefined) { absent(ctx, [filePlanFile, fileActorsFile]); return null }
  const { hashes } = workspaceExecutionExitMaterial(dataDir, id)
  if (!fields(record, ['schema_version', 'intent_id', 'intent_sha256', ...Object.keys(hashes), 'created_at'])
    || record.schema_version !== 1 || record.intent_id !== id || record.intent_sha256 !== sha256CanonicalJson(intent)
    || !validDate(record.created_at) || Object.entries(hashes).some(([key, hash]) => record[key] !== hash)) fail()
  return record
})
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
export const readWorkspaceRelocationFilePlan = recordGraphReader(function readWorkspaceRelocationFilePlan(dataDir, id) {
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
})
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
  const preview = await inspectWorkspaceRelocationTarget(intent.source.path, intent.target, { protectedRoots: [ctx.control], signal, inspectTargetAccess: native.inspectDirectoryWriteAccess })
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
  const observation = await inspectWorkspaceFileSource(intent.source.path, preview.mode, { signal, metadataCompatibility: intent.metadata_compatibility ?? 'exact' })
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
export const readWorkspaceRelocationFileActors = recordGraphReader(function readWorkspaceRelocationFileActors(dataDir, id) {
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
        const intent = readWorkspaceRelocationIntent(dataDir)
        const extra = intent.schema_version === 2 ? ['schema_version', 'metadata_fingerprint', 'target_metadata_fingerprint', 'metadata_compatibility', 'legacy_owner_inheritance_files'] : []
        if (!fields(row, ['type', 'previous_sha256', 'tree', 'tree_native_id', 'content_sha256', 'metadata_sha256', 'created_at', ...extra])
          || intent.schema_version === 2 && (row.schema_version !== 2 || row.metadata_fingerprint !== row.metadata_sha256
            || row.metadata_compatibility !== intent.metadata_compatibility || !digest(row.target_metadata_fingerprint)
            || !integer(row.legacy_owner_inheritance_files) || row.legacy_owner_inheritance_files < 0
            || row.legacy_owner_inheritance_files >= plan.source_observation.entries
            || row.metadata_compatibility === 'exact' && row.legacy_owner_inheritance_files !== 0
            || (row.legacy_owner_inheritance_files === 0) !== (row.metadata_sha256 === row.target_metadata_fingerprint))
          || !validIdentity(row.tree) || !same(row.tree, expected) || row.tree_native_id !== nativeId
          || row.content_sha256 !== plan.source_content_sha256 || row.metadata_sha256 !== plan.source_observation.metadata_fingerprint) fail()
        file_ready = row
      } else fail()
      previous = row
    }
    return { attempt, host: host ?? null, permission: permission ?? null, staging_attempt, staging, file_attempt, tools, tool_permission, tool_exit, file_ready }
  } catch { fail() }
})

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
  let metadata, targetMetadata, inherited = 0
  if (plan.mode === 'copy') {
    if (!same(intent.source, identity(intent.source.path))) fail()
    const proof = await verifyWorkspaceRelocationCopy(intent.source.path, target, { signal, metadataCompatibility: intent.metadata_compatibility ?? 'exact' })
    if (proof.source_fingerprint !== plan.source_observation.tree_fingerprint) fail()
    metadata = proof.metadata_fingerprint; targetMetadata = proof.target_metadata_fingerprint; inherited = proof.legacy_owner_inheritance_files
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
    tree_native_id: nativeId, content_sha256: content.fingerprint, metadata_sha256: metadata,
    ...(intent.schema_version === 2 ? { schema_version: 2, metadata_fingerprint: metadata, target_metadata_fingerprint: targetMetadata ?? metadata,
      metadata_compatibility: intent.metadata_compatibility, legacy_owner_inheritance_files: inherited } : {}), created_at: new Date().toISOString() }
  return { dispatch: 'dispatch', ready: appendFileActor(dataDir, id, previous, record).file_ready }
}


/** Historical bindings only; these digest values are not transferable write authorization. */
export const readWorkspaceRelocationClosureBindings = recordGraphReader(function readWorkspaceRelocationClosureBindings(dataDir, id) {
  const intent = readWorkspaceRelocationIntent(dataDir), coordinator = readWorkspaceRelocationCoordinator(dataDir, id)
  const workers = readWorkspaceRelocationWorkers(dataDir, id), exit = readWorkspaceRelocationExecutionExit(dataDir, id)
  const plan = readWorkspaceRelocationFilePlan(dataDir, id), actors = readWorkspaceRelocationFileActors(dataDir, id)
  if (!intent || !coordinator.launch || !coordinator.ready || !workers || !exit || !plan || !actors.file_ready) fail()
  return Object.freeze({ intent_id: id, intent_sha256: sha256CanonicalJson(intent), coordinator_sha256: sha256CanonicalJson(coordinator),
    worker_scope_sha256: sha256CanonicalJson(workers), execution_exit_sha256: sha256CanonicalJson(exit),
    file_plan_sha256: sha256CanonicalJson(plan), file_ready_sha256: sha256CanonicalJson(actors.file_ready), catalog_sha256: plan.catalog_sha256 })
})

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
export const readWorkspaceRelocationClosurePlan = recordGraphReader(function readWorkspaceRelocationClosurePlan(dataDir, id) {
  const { ctx } = coordinatorContext(dataDir, id), record = readPrivateJson(path.join(ctx.control, closurePlanFile), scopeLimit)
  if (record === undefined) return null
  try { validClosurePlan(record, ctx, id) } catch { fail() }
  return record
})

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
export const readWorkspaceRelocationClosureCommit = recordGraphReader(function readWorkspaceRelocationClosureCommit(dataDir, id) {
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
})

const recoveryPlanFile = 'relocation-manager-closure.json'
function validRecoveryPlan(record, ctx, id) {
  const complete = readWorkspaceRelocationClosureCommit(ctx.dataRoot, id)
  if (!fields(record, ['schema_version', 'intent_id', 'bindings', 'worker_closure_sha256', 'snapshot_sha256', 'snapshot'])
    || record.schema_version !== 1 || record.intent_id !== id || !complete
    || sha256CanonicalJson(record.bindings) !== sha256CanonicalJson(readWorkspaceRelocationClosureBindings(ctx.dataRoot, id))
    || record.worker_closure_sha256 !== sha256CanonicalJson(complete) || record.snapshot_sha256 !== sha256CanonicalJson(record.snapshot)) fail()
  validateWorkspaceRecoverySnapshot(record.snapshot, ctx.dataRoot)
}
export const readWorkspaceRelocationRecoveryPlan = recordGraphReader(function readWorkspaceRelocationRecoveryPlan(dataDir, id) {
  const { ctx } = coordinatorContext(dataDir, id), record = readPrivateJson(path.join(ctx.control, recoveryPlanFile), scopeLimit)
  if (record === undefined) return null
  try { validRecoveryPlan(record, ctx, id) } catch { fail() }
  return record
})
/** Technical Agent plan only; this never archives a checkpoint or settles business responsibility. */
export async function prepareWorkspaceRelocationRecoveryPlan({ dataDir, id, manifest, signal }) {
  const { verify } = workspaceFileCoordinatorContext(dataDir, id, signal)
  return publishWorkspaceRelocationRecoveryPlan({ dataDir, id, manifest,
    authorize: () => verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal }), assertCurrent: verify })
}
/** Fixed technical storage; each caller retains its own current effect authority. */
export async function publishWorkspaceRelocationRecoveryPlan({ dataDir, id, manifest, authorize, assertCurrent, temporaryDirectory }) {
  if (typeof authorize !== 'function' || typeof assertCurrent !== 'function') fail()
  const record = { schema_version: 1, intent_id: id, ...structuredClone(manifest) }
  await authorize(); assertCurrent()
  const { ctx } = coordinatorContext(dataDir, id)
  validRecoveryPlan(record, ctx, id)
  const previous = readWorkspaceRelocationRecoveryPlan(dataDir, id)
  if (previous) {
    if (sha256CanonicalJson(previous) !== sha256CanonicalJson(record)) fail()
    syncIntent(ctx); return { dispatch: 'observe', plan: previous }
  }
  const verifyInput = () => { assertCurrent(); validRecoveryPlan(record, ctx, id); verifyWorkspaceRecoverySnapshot(record.snapshot, ctx.dataRoot) }
  verifyInput()
  publishPrivateJson(ctx, path.join(ctx.control, recoveryPlanFile), record, scopeLimit, () => {
    verifyInput(); if (readWorkspaceRelocationRecoveryPlan(dataDir, id)) fail()
  }, temporaryDirectory)
  await authorize()
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
export const readWorkspaceRelocationRecoveryCommit = recordGraphReader(function readWorkspaceRelocationRecoveryCommit(dataDir, id) {
  const { ctx } = coordinatorContext(dataDir, id), record = readPrivateJson(path.join(ctx.control, recoveryCommitFile), scopeLimit)
  if (record === undefined) return null
  const plan = readWorkspaceRelocationRecoveryPlan(dataDir, id)
  if (!plan) fail()
  validRecoveryCommit(record, plan, id)
  return record
})
export async function completeWorkspaceRelocationRecovery({ dataDir, id, manifest, signal, verifyEffects }) {
  const { verify } = workspaceFileCoordinatorContext(dataDir, id, signal)
  return publishWorkspaceRelocationRecoveryCommit({ dataDir, id, manifest, verifyEffects,
    authorize: () => verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal }), assertCurrent: verify })
}
/** Receipt storage only; neither a plan nor an earlier actor grants current authority. */
export async function publishWorkspaceRelocationRecoveryCommit({ dataDir, id, manifest, verifyEffects, authorize, assertCurrent, temporaryDirectory }) {
  if (typeof authorize !== 'function' || typeof assertCurrent !== 'function') fail()
  const record = { schema_version: 1, intent_id: id, ...structuredClone(manifest) }
  await authorize(); assertCurrent()
  const { ctx } = coordinatorContext(dataDir, id), plan = readWorkspaceRelocationRecoveryPlan(dataDir, id)
  if (!plan || typeof verifyEffects !== 'function') fail()
  validRecoveryCommit(record, plan, id)
  const verifyInput = () => {
    assertCurrent(); verifyEffects()
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
  }, temporaryDirectory)
  await authorize()
  verifyInput()
  if (sha256CanonicalJson(readWorkspaceRelocationRecoveryCommit(dataDir, id)) !== sha256CanonicalJson(record)) fail()
  return { dispatch: 'dispatch', commit_sha256: sha256CanonicalJson(record) }
}

function verifyRootStagingParent(plan) {
  if (!same(plan.staging_parent, identity(plan.staging_parent.path))
    || process.platform === 'win32' && native.inspectDirectoryFileId(plan.staging_parent.path) !== plan.staging_parent_native_id) fail()
}
const rootPlanFile = 'relocation-root-plan.json'
const rootFrame = (directory, nativeId = process.platform === 'win32' ? native.inspectDirectoryFileId(directory) : null) => ({ ...identity(directory), native_id: nativeId })
function validRootPlan(record, dataDir, id) {
  const intent = readWorkspaceRelocationIntent(dataDir), actors = readWorkspaceRelocationFileActors(dataDir, id)
  const worker = readWorkspaceRelocationClosureCommit(dataDir, id), recovery = readWorkspaceRelocationRecoveryCommit(dataDir, id)
  if (!fields(record, ['schema_version', 'intent_id', 'bindings', 'worker_commit_sha256', 'recovery_commit_sha256', 'publication', 'catalog_after_sha256', 'catalog_mappings', 'parents_commit_sha256'])
    || record.schema_version !== 1 || record.intent_id !== id || !worker || !recovery || !actors.file_ready
    || sha256CanonicalJson(record.bindings) !== sha256CanonicalJson(readWorkspaceRelocationClosureBindings(dataDir, id))
    || record.worker_commit_sha256 !== sha256CanonicalJson(worker) || record.recovery_commit_sha256 !== sha256CanonicalJson(recovery)
    || !digest(record.catalog_after_sha256) || !Array.isArray(record.catalog_mappings)) fail()
  const parents = readWorkspaceRelocationRootParentsPlan(dataDir, id), complete = readRootParentsComplete(dataDir, id, parents)
  if (Boolean(parents) !== Boolean(complete) || record.parents_commit_sha256 !== (complete ? sha256CanonicalJson(complete) : null)
    || complete && sha256CanonicalJson(complete.target_parent) !== sha256CanonicalJson(record.publication.target_parent)) fail()
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
  return parents
}
/** Immutable historical plan; observing it cannot grant an execution or recovery role. */
const readRootPlanState = recordGraphReader(function readRootPlanState(dataDir, id) {
  const { ctx } = coordinatorContext(dataDir, id), record = readPrivateJson(path.join(ctx.control, rootPlanFile), scopeLimit)
  if (record === undefined) return null
  return { record, parents: validRootPlan(record, dataDir, id) }
})
export const readWorkspaceRelocationRootPlan = recordGraphReader(function readWorkspaceRelocationRootPlan(dataDir, id) { return readRootPlanState(dataDir, id)?.record ?? null })
export async function prepareWorkspaceRelocationRootPlan({ dataDir, id, signal }) {
  const { ctx, intent, verify } = workspaceFileCoordinatorContext(dataDir, id, signal)
  return prepareRootPlanForContext({ dataDir, id, signal, ctx, intent, verify,
    authorize: () => verifyWorkspaceRelocationClosureReadiness({ dataDir, id, signal }) })
}
/** Neutral fixed Root effects; the interrupted caller supplies its current role. */
export async function prepareWorkspaceRelocationRootPlanUnderAuthority({ dataDir, id, signal, authorize, assertCurrent, temporaryDirectory }) {
  if (typeof authorize !== 'function' || typeof assertCurrent !== 'function') fail()
  await authorize()
  const { ctx, intent } = coordinatorContext(dataDir, id)
  return prepareRootPlanForContext({ dataDir, id, signal, ctx, intent, verify: assertCurrent, authorize, temporaryDirectory })
}
async function prepareRootPlanForContext({ dataDir, id, signal, ctx, intent, verify, authorize, temporaryDirectory }) {
  verify()
  const previous = readWorkspaceRelocationRootPlan(dataDir, id)
  if (previous) { syncIntent(ctx); return { dispatch: 'observe', plan: previous } }
  await authorize()
  const agent = await import('../../crabot-agent/dist/core/workspace-relocation-closed-evidence.js')
  const evidence = await agent.inspectWorkspaceRelocationClosures({ dataDir, id, signal, verify: authorize })
  const actors = readWorkspaceRelocationFileActors(dataDir, id), catalog = new WorkspaceCatalog({ dataRoot: ctx.dataRoot, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native })
  const filePlan = readWorkspaceRelocationFilePlan(dataDir, id)
  const before = await catalog.snapshot(), bindings = readWorkspaceRelocationClosureBindings(dataDir, id)
  if (sha256CanonicalJson(before) !== bindings.catalog_sha256 || before.revision !== intent.catalog_revision || before.storage_root !== intent.source.path) fail()
  const after = projectWorkspaceCatalogRelocation(before, intent.target)
  const preparedParents = await prepareWorkspaceRelocationRootParents({ dataDir, id, signal, ctx, intent, filePlan, evidence, verify, authorize, temporaryDirectory })
  const parent = preparedParents.parent
  const empty = intent.target_identity ? rootFrame(intent.target) : null
  const publication = { intent_id: id, container: { ...actors.staging.container, native_id: actors.staging.container_native_id },
    tree: { ...actors.file_ready.tree, native_id: actors.file_ready.tree_native_id }, target: intent.target, target_parent: parent, empty_target: empty }
  const record = { schema_version: 1, intent_id: id, bindings, worker_commit_sha256: evidence.worker_commit_sha256, recovery_commit_sha256: evidence.recovery_commit_sha256,
    publication, parents_commit_sha256: preparedParents.commit_sha256, catalog_after_sha256: sha256CanonicalJson(after), catalog_mappings: before.workspaces.flatMap((item, index) => item.root === after.workspaces[index].root ? []
      : [{ workspace_id: item.workspace_id, before_root: item.root, after_root: after.workspaces[index].root }]).sort((a, b) => a.workspace_id < b.workspace_id ? -1 : 1) }
  validRootPlan(record, dataDir, id)
  const verifyInput = () => {
    verify(); evidence.verify(); validRootPlan(record, dataDir, id)
    verifyRootStagingParent(filePlan)
    if (preparedParents.plan) verifyRootParentsState(preparedParents.plan, intent)
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
  }, temporaryDirectory)
  await authorize(); verifyInput()
  const accepted = readWorkspaceRelocationRootPlan(dataDir, id)
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return { dispatch: 'dispatch', plan: accepted }
}


const rootPublishedFile = 'relocation-root-published.json', rootSelectedFile = 'relocation-root-selected.json'
/** Historical facts only. Current authority, files and catalog are independently verified before effects. */
export const readWorkspaceRelocationRootPublished = recordGraphReader(function readWorkspaceRelocationRootPublished(dataDir, id) {
  const { ctx } = coordinatorContext(dataDir, id), record = readPrivateJson(path.join(ctx.control, rootPublishedFile), 65536)
  if (record === undefined) return null
  const plan = readWorkspaceRelocationRootPlan(dataDir, id), ready = readWorkspaceRelocationFileActors(dataDir, id).file_ready
  if (!plan || !fields(record, ['schema_version', 'intent_id', 'plan_sha256', 'target', 'content_sha256', 'metadata_sha256'])
    || record.schema_version !== 1 || record.intent_id !== id || record.plan_sha256 !== sha256CanonicalJson(plan)
    || sha256CanonicalJson(record.target) !== sha256CanonicalJson({ ...plan.publication.tree, path: plan.publication.target })
    || record.content_sha256 !== ready.content_sha256 || record.metadata_sha256 !== (ready.target_metadata_fingerprint ?? ready.metadata_sha256)) fail()
  return record
})
export const readWorkspaceRelocationRootSelected = recordGraphReader(function readWorkspaceRelocationRootSelected(dataDir, id) {
  const { ctx, intent } = coordinatorContext(dataDir, id), record = readPrivateJson(path.join(ctx.control, rootSelectedFile), 65536)
  if (record === undefined) return null
  const plan = readWorkspaceRelocationRootPlan(dataDir, id), published = readWorkspaceRelocationRootPublished(dataDir, id)
  if (!plan || !published || !fields(record, ['schema_version', 'intent_id', 'plan_sha256', 'published_sha256', 'catalog_sha256', 'catalog_revision'])
    || record.schema_version !== 1 || record.intent_id !== id || record.plan_sha256 !== sha256CanonicalJson(plan)
    || record.published_sha256 !== sha256CanonicalJson(published) || record.catalog_sha256 !== plan.catalog_after_sha256
    || record.catalog_revision !== intent.catalog_revision + 1) fail()
  return record
})
function workspaceRootContext(dataDir, id, signal) {
  return rootContextForAuthority(workspaceFileCoordinatorContext(dataDir, id, signal), dataDir, id)
}
function rootContextForAuthority(base, dataDir, id) {
  const plan = readWorkspaceRelocationRootPlan(dataDir, id)
  if (!plan) fail()
  const planHash = sha256CanonicalJson(plan), actors = readWorkspaceRelocationFileActors(dataDir, id), actorsHash = sha256CanonicalJson(actors)
  const fileScope = [actors.host.process, ...(actors.tools?.tools ?? []).map(item => item.process)]
  const filePlan = readWorkspaceRelocationFilePlan(dataDir, id)
  const verify = () => {
    base.verify(); verifyRootStagingParent(filePlan)
    const current = readRootPlanState(dataDir, id)
    if (current?.parents) verifyRootParentsState(current.parents, base.intent, plan.publication.tree)
    if (sha256CanonicalJson(current?.record) !== planHash
      || sha256CanonicalJson(readWorkspaceRelocationFileActors(dataDir, id)) !== actorsHash
      || knownProcessExit.probeKnownProcessExit(fileScope).state !== 'stopped'
      || sha256CanonicalJson(rootFrame(plan.publication.target_parent.path)) !== sha256CanonicalJson(plan.publication.target_parent)) fail()
    const names = fs.readdirSync(actors.staging.container.path)
    if (names.length > 1 || names.length === 1 && names[0] !== 'tree') fail()
    verifyStagingContainer(actors.staging, names)
    if (filePlan.mode === 'copy') { if (!same(base.intent.source, identity(base.intent.source.path))) fail() }
    else { try { fs.lstatSync(base.intent.source.path); fail() } catch (error) { if (error.code !== 'ENOENT') throw error } }
  }
  verify()
  return { ...base, plan, planHash, filePlan, verify }
}
async function rootCatalogProjection(catalog, plan, intent) {
  const current = await catalog.snapshot(), before = structuredClone(current)
  if (current.storage_root === intent.target) {
    before.storage_root = intent.source.path; before.revision--
    before.workspaces = before.workspaces.map(item => {
      const mapping = plan.catalog_mappings.find(row => row.workspace_id === item.workspace_id)
      if (mapping && mapping.after_root !== item.root) fail()
      return mapping ? { ...item, root: mapping.before_root } : item
    })
  }
  if (sha256CanonicalJson(before) !== plan.bindings.catalog_sha256) fail()
  const after = projectWorkspaceCatalogRelocation(before, intent.target)
  const mappings = before.workspaces.flatMap((item, index) => item.root === after.workspaces[index].root ? []
    : [{ workspace_id: item.workspace_id, before_root: item.root, after_root: after.workspaces[index].root }]).sort((a, b) => a.workspace_id < b.workspace_id ? -1 : 1)
  if (sha256CanonicalJson(after) !== plan.catalog_after_sha256 || sha256CanonicalJson(mappings) !== sha256CanonicalJson(plan.catalog_mappings)
    || ![plan.bindings.catalog_sha256, plan.catalog_after_sha256].includes(sha256CanonicalJson(current))) fail()
  return { before, current }
}
function verifyPublishedRootPosition(root, published) {
  if (sha256CanonicalJson(rootFrame(root.plan.publication.target)) !== sha256CanonicalJson(published.target)
    || fs.readdirSync(root.plan.publication.container.path).length) fail()
}
async function inspectRootTarget(root, evidence, signal) {
  const { inspectWorkspaceRelocationContent } = await import('../../crabot-shared/dist/workspace-relocation-content.js')
  const { inspectWorkspaceFileSource } = await import('./workspace-copy.mjs')
  const { plan, filePlan, verify } = root, target = plan.publication.target
  const ready = readWorkspaceRelocationFileActors(root.ctx.dataRoot, plan.intent_id).file_ready
  const check = () => {
    verify(); evidence.verify()
    if (sha256CanonicalJson(rootFrame(target)) !== sha256CanonicalJson({ ...plan.publication.tree, path: target })
      || fs.readdirSync(plan.publication.container.path).length) fail()
  }
  check()
  const original = await inspectWorkspaceFileSource(target, filePlan.mode, { signal }); check()
  const content = await inspectWorkspaceRelocationContent(target, filePlan.mode, { signal }); check()
  if (content.fingerprint !== ready.content_sha256 || original.metadata_fingerprint !== (ready.target_metadata_fingerprint ?? ready.metadata_sha256)
    || content.tree_fingerprint !== original.tree_fingerprint) fail()
  const verifyTarget = async () => {
    check()
    const current = await inspectWorkspaceFileSource(target, filePlan.mode, { signal })
    check()
    if (current.tree_fingerprint !== original.tree_fingerprint || current.metadata_fingerprint !== original.metadata_fingerprint) fail()
  }
  await verifyTarget()
  return { verify: verifyTarget, content_sha256: content.fingerprint, metadata_sha256: original.metadata_fingerprint }
}
export async function publishWorkspaceRelocationRoot({ dataDir, id, signal }) {
  return publishRootForContext(workspaceRootContext(dataDir, id, signal), { dataDir, id, signal })
}
export async function publishWorkspaceRelocationRootUnderAuthority({ dataDir, id, signal, authorize, assertCurrent, temporaryDirectory }) {
  if (typeof authorize !== 'function' || typeof assertCurrent !== 'function') fail()
  await authorize()
  const base = { ...coordinatorContext(dataDir, id), verify: assertCurrent }
  return publishRootForContext(rootContextForAuthority(base, dataDir, id), { dataDir, id, signal, temporaryDirectory })
}
async function publishRootForContext(root, { dataDir, id, signal, temporaryDirectory }) {
  const { ctx, plan, planHash, verify } = root
  const previous = readWorkspaceRelocationRootPublished(dataDir, id)
  const catalog = new WorkspaceCatalog({ dataRoot: ctx.dataRoot, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native })
  const projection = await rootCatalogProjection(catalog, plan, root.intent)
  if (!previous && sha256CanonicalJson(projection.current) !== plan.bindings.catalog_sha256) fail()
  const agent = await import('../../crabot-agent/dist/core/workspace-relocation-closed-evidence.js')
  const evidence = await agent.inspectWorkspaceRelocationClosures({ dataDir, id, signal, verify })
  await publishWorkspaceRoot({ plan: plan.publication, signal, verify: async () => {
    verify(); evidence.verify()
    if (previous) verifyPublishedRootPosition(root, previous)
    const current = await rootCatalogProjection(catalog, plan, root.intent)
    if (!previous && sha256CanonicalJson(current.current) !== plan.bindings.catalog_sha256) fail()
    verify(); evidence.verify()
  } })
  const proof = await inspectRootTarget(root, evidence, signal)
  const record = { schema_version: 1, intent_id: id, plan_sha256: planHash, target: rootFrame(plan.publication.target),
    content_sha256: proof.content_sha256, metadata_sha256: proof.metadata_sha256 }
  await proof.verify()
  if (previous) {
    if (sha256CanonicalJson(previous) !== sha256CanonicalJson(record)) fail()
    syncIntent(ctx); return { dispatch: 'observe', published_sha256: sha256CanonicalJson(previous) }
  }
  publishPrivateJson(ctx, path.join(ctx.control, rootPublishedFile), record, 65536, () => {
    verify(); evidence.verify()
    if (readWorkspaceRelocationRootPublished(dataDir, id)) fail()
  }, temporaryDirectory)
  await proof.verify()
  if (sha256CanonicalJson(readWorkspaceRelocationRootPublished(dataDir, id)) !== sha256CanonicalJson(record)) fail()
  return { dispatch: 'dispatch', published_sha256: sha256CanonicalJson(record) }
}
export async function selectWorkspaceRelocationRoot({ dataDir, id, signal }) {
  return selectRootForContext(workspaceRootContext(dataDir, id, signal), { dataDir, id, signal })
}
export async function selectWorkspaceRelocationRootUnderAuthority({ dataDir, id, signal, authorize, assertCurrent, temporaryDirectory }) {
  if (typeof authorize !== 'function' || typeof assertCurrent !== 'function') fail()
  await authorize()
  const base = { ...coordinatorContext(dataDir, id), verify: assertCurrent }
  return selectRootForContext(rootContextForAuthority(base, dataDir, id), { dataDir, id, signal, temporaryDirectory })
}
async function selectRootForContext(root, { dataDir, id, signal, temporaryDirectory }) {
  const { ctx, plan, planHash, verify } = root
  const published = readWorkspaceRelocationRootPublished(dataDir, id), previous = readWorkspaceRelocationRootSelected(dataDir, id)
  if (!published) fail()
  const publishedHash = sha256CanonicalJson(published)
  const agent = await import('../../crabot-agent/dist/core/workspace-relocation-closed-evidence.js')
  const evidence = await agent.inspectWorkspaceRelocationClosures({ dataDir, id, signal, verify })
  // Independently observe the original empty-target hold as well as the actual published tree.
  const verifyPublished = () => {
    verify(); evidence.verify(); verifyPublishedRootPosition(root, published)
    if (sha256CanonicalJson(readWorkspaceRelocationRootPublished(dataDir, id)) !== publishedHash) fail()
  }
  await publishWorkspaceRoot({ plan: plan.publication, signal, verify: verifyPublished })
  const proof = await inspectRootTarget(root, evidence, signal)
  const catalog = new WorkspaceCatalog({ dataRoot: ctx.dataRoot, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native })
  const projection = await rootCatalogProjection(catalog, plan, root.intent)
  const selected = await catalog.commitRelocation(projection.before, root.intent.target, async () => { verifyPublished(); await proof.verify(); verifyPublished() })
  if (sha256CanonicalJson(selected.snapshot) !== plan.catalog_after_sha256) fail()
  const record = { schema_version: 1, intent_id: id, plan_sha256: planHash, published_sha256: publishedHash,
    catalog_sha256: plan.catalog_after_sha256, catalog_revision: selected.snapshot.revision }
  await proof.verify(); verifyPublished()
  if (previous) {
    if (sha256CanonicalJson(previous) !== sha256CanonicalJson(record)) fail()
    syncIntent(ctx); return { dispatch: 'observe', selected_sha256: sha256CanonicalJson(previous) }
  }
  publishPrivateJson(ctx, path.join(ctx.control, rootSelectedFile), record, 65536, () => {
    verifyPublished(); if (readWorkspaceRelocationRootSelected(dataDir, id)) fail()
  }, temporaryDirectory)
  await proof.verify(); verifyPublished()
  if (sha256CanonicalJson(await catalog.snapshot()) !== plan.catalog_after_sha256
    || sha256CanonicalJson(readWorkspaceRelocationRootSelected(dataDir, id)) !== sha256CanonicalJson(record)) fail()
  return { dispatch: 'dispatch', selected_sha256: sha256CanonicalJson(record) }
}


/** Fresh facts under the original coordinator lock; no execution or maintenance-release authority. */
export async function verifyWorkspaceRelocationSelectedRoot({ dataDir, id, signal }) {
  const root = workspaceRootContext(dataDir, id, signal)
  const selected = readWorkspaceRelocationRootSelected(dataDir, id), published = readWorkspaceRelocationRootPublished(dataDir, id)
  if (!selected || !published) fail()
  const selectedHash = sha256CanonicalJson(selected), publishedHash = sha256CanonicalJson(published)
  const verify = () => {
    root.verify()
    if (sha256CanonicalJson(readWorkspaceRelocationRootSelected(dataDir, id)) !== selectedHash
      || sha256CanonicalJson(readWorkspaceRelocationRootPublished(dataDir, id)) !== publishedHash
      || sha256CanonicalJson(inspectPublishedWorkspaceRoot({ plan: root.plan.publication })) !== sha256CanonicalJson(published.target)) fail()
  }
  verify()
  const agent = await import('../../crabot-agent/dist/core/workspace-relocation-closed-evidence.js')
  verify()
  const closures = await agent.inspectWorkspaceRelocationClosures({ dataDir, id, signal, verify: async () => verify() })
  verify(); closures.verify()
  const catalog = new WorkspaceCatalog({ dataRoot: root.ctx.dataRoot, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native })
  const snapshot = await catalog.snapshot()
  verify(); closures.verify()
  if (sha256CanonicalJson(snapshot) !== selected.catalog_sha256) fail()
  return { selected_sha256: selectedHash, worker_commit_sha256: closures.worker_commit_sha256, recovery_commit_sha256: closures.recovery_commit_sha256 }
}


const rootParentsFile = 'relocation-root-parents.json', rootParentsCompleteFile = 'relocation-root-parents-complete.json'
const rootInside = (root, value) => { const relative = path.relative(root, value); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
function rootParentParts(record, intent) {
  const relative = path.relative(record.publication.target_parent.path, path.dirname(intent.target))
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail()
  const parts = relative.split(path.sep)
  if (record.publication.target !== path.join(record.publication.target_parent.path, parts[0])) fail()
  return parts
}
export const readWorkspaceRelocationRootParentsPlan = recordGraphReader(function readWorkspaceRelocationRootParentsPlan(dataDir, id) {
  const { ctx, intent } = coordinatorContext(dataDir, id), record = readPrivateJson(path.join(ctx.control, rootParentsFile), scopeLimit)
  if (record === undefined) return null
  const filePlan = readWorkspaceRelocationFilePlan(dataDir, id), worker = readWorkspaceRelocationClosureCommit(dataDir, id), recovery = readWorkspaceRelocationRecoveryCommit(dataDir, id)
  if (!fields(record, ['schema_version', 'intent_id', 'bindings', 'worker_commit_sha256', 'recovery_commit_sha256', 'publication', 'container_metadata_sha256', 'chain'])
    || record.schema_version !== 1 || record.intent_id !== id || !worker || !recovery
    || sha256CanonicalJson(record.bindings) !== sha256CanonicalJson(readWorkspaceRelocationClosureBindings(dataDir, id))
    || record.worker_commit_sha256 !== sha256CanonicalJson(worker) || record.recovery_commit_sha256 !== sha256CanonicalJson(recovery)
    || !digest(record.container_metadata_sha256) || !Array.isArray(record.chain)) fail()
  validateWorkspaceParentsPublicationPlan(record.publication)
  if (record.publication.intent_id !== id || path.dirname(record.publication.container.path) !== filePlan.staging_parent.path
    || !rootInside(filePlan.staging_parent.path, record.publication.target_parent.path)) fail()
  const parts = rootParentParts(record, intent)
  if (record.chain.length !== parts.length) fail()
  for (const [index, item] of record.chain.entries()) {
    const relative = index ? path.join(...parts.slice(1, index + 1)) : ''
    if (!fields(item, ['relative', 'dev', 'ino', 'native_id']) || item.relative !== relative
      || !validIdentity({ path: path.join(record.publication.tree.path, relative), dev: item.dev, ino: item.ino })
      || item.dev !== record.publication.tree.dev
      || (process.platform === 'win32' ? typeof item.native_id !== 'string' || !/^[0-9]+:[a-f0-9]{32}$/i.test(item.native_id) : item.native_id !== null)) fail()
  }
  const first = record.chain[0], tree = record.publication.tree
  if (first.dev !== tree.dev || first.ino !== tree.ino || first.native_id !== tree.native_id) fail()
  return record
})
export const readWorkspaceRelocationRootParentsComplete = recordGraphReader(function readWorkspaceRelocationRootParentsComplete(dataDir, id) {
  return readRootParentsComplete(dataDir, id, readWorkspaceRelocationRootParentsPlan(dataDir, id))
})
function readRootParentsComplete(dataDir, id, plan) {
  const { ctx, intent } = coordinatorContext(dataDir, id), record = readPrivateJson(path.join(ctx.control, rootParentsCompleteFile), 65536)
  if (record === undefined) return null
  if (!plan || !fields(record, ['schema_version', 'intent_id', 'plan_sha256', 'target_parent']) || record.schema_version !== 1 || record.intent_id !== id
    || record.plan_sha256 !== sha256CanonicalJson(plan)
    || sha256CanonicalJson(record.target_parent) !== sha256CanonicalJson({ path: path.dirname(intent.target), dev: plan.chain.at(-1).dev,
      ino: plan.chain.at(-1).ino, native_id: plan.chain.at(-1).native_id })) fail()
  return record
}
function verifyRootParentsState(plan, intent, payload) {
  if (!plan) fail()
  const pub = plan.publication, names = fs.readdirSync(pub.container.path)
  const staged = names.length === 1 && names[0] === 'tree'
  if (!staged && names.length) fail()
  verifyStagingContainer({ container: { path: pub.container.path, dev: pub.container.dev, ino: pub.container.ino },
    container_native_id: pub.container.native_id, container_metadata_sha256: plan.container_metadata_sha256 }, staged ? ['tree'] : [])
  if (sha256CanonicalJson(rootFrame(pub.target_parent.path)) !== sha256CanonicalJson(pub.target_parent)) fail()
  if (staged) { try { fs.lstatSync(pub.target); fail() } catch (error) { if (error.code !== 'ENOENT') throw error } }
  const root = staged ? pub.tree.path : pub.target
  for (const [index, item] of plan.chain.entries()) {
    const directory = path.join(root, item.relative), frame = rootFrame(directory), stat = fs.lstatSync(directory)
    if (frame.dev !== item.dev || frame.ino !== item.ino || frame.native_id !== item.native_id
      || (process.platform === 'win32' ? !native.isPrivateDirectory(directory) : stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)) fail()
    const children = fs.readdirSync(directory)
    if (index + 1 < plan.chain.length) {
      if (JSON.stringify(children) !== JSON.stringify([path.basename(plan.chain[index + 1].relative)])) fail()
    } else if (children.length) {
      if (staged || !payload || JSON.stringify(children) !== JSON.stringify([path.basename(intent.target)])
        || sha256CanonicalJson(rootFrame(intent.target)) !== sha256CanonicalJson({ ...payload, path: intent.target })) fail()
    }
  }
  if (payload && staged) fail()
}
async function prepareWorkspaceRelocationRootParents({ dataDir, id, signal, ctx, intent, filePlan, evidence, verify, authorize, temporaryDirectory }) {
  const check = () => { verify(); verifyRootStagingParent(filePlan); evidence.verify() }
  const checkReady = async () => { check(); await authorize(); check() }
  await checkReady()
  let plan = readWorkspaceRelocationRootParentsPlan(dataDir, id)
  if (!plan) {
    if (readWorkspaceRelocationRootParentsComplete(dataDir, id)) fail()
    let parent = path.dirname(intent.target)
    for (;;) {
      try { fs.lstatSync(parent); break } catch (error) { if (error.code !== 'ENOENT') throw error }
      parent = path.dirname(parent)
    }
    const base = rootFrame(parent)
    if (!rootInside(filePlan.staging_parent.path, parent) || base.dev !== filePlan.staging_parent.dev) fail()
    if (parent === path.dirname(intent.target)) return { parent: base, commit_sha256: null, plan: null }
    const parts = path.relative(parent, path.dirname(intent.target)).split(path.sep)
    const container = path.join(filePlan.staging_parent.path, '.crabot-workspace-parents-' + id), tree = path.join(container, 'tree')
    const create = async directory => {
      check()
      if (sha256CanonicalJson(rootFrame(base.path)) !== sha256CanonicalJson(base)) fail()
      if (process.platform === 'win32') native.createPrivateDirectory(directory)
      else fs.mkdirSync(directory, { mode: 0o700 })
      const frame = rootFrame(directory)
      await new Promise(resolve => setImmediate(resolve)); check()
      if (sha256CanonicalJson(rootFrame(directory)) !== sha256CanonicalJson(frame)) fail()
      return frame
    }
    const containerFrame = await create(container), chain = []
    for (const [index] of parts.entries()) {
      const relative = index ? path.join(...parts.slice(1, index + 1)) : '', frame = await create(path.join(tree, relative))
      chain.push({ relative, dev: frame.dev, ino: frame.ino, native_id: frame.native_id })
    }
    plan = { schema_version: 1, intent_id: id, bindings: readWorkspaceRelocationClosureBindings(dataDir, id),
      worker_commit_sha256: evidence.worker_commit_sha256, recovery_commit_sha256: evidence.recovery_commit_sha256,
      publication: { intent_id: id, container: containerFrame, tree: { path: tree, dev: chain[0].dev, ino: chain[0].ino, native_id: chain[0].native_id },
        target: path.join(parent, parts[0]), target_parent: base, empty_target: null }, container_metadata_sha256: stagingMetadata(container), chain }
    verifyRootParentsState(plan, intent)
    for (const item of [...chain].reverse()) syncDirectory(path.join(tree, item.relative))
    syncDirectory(container); syncDirectory(filePlan.staging_parent.path)
    await checkReady(); verifyRootParentsState(plan, intent)
    publishPrivateJson(ctx, path.join(ctx.control, rootParentsFile), plan, scopeLimit, () => {
      check(); verifyRootParentsState(plan, intent)
      if (readWorkspaceRelocationRootParentsPlan(dataDir, id)) fail()
    }, temporaryDirectory)
  }
  const planHash = sha256CanonicalJson(plan)
  const verifyPlan = async () => {
    await checkReady()
    if (sha256CanonicalJson(readWorkspaceRelocationRootParentsPlan(dataDir, id)) !== planHash) fail()
    verifyRootParentsState(plan, intent)
  }
  await verifyPlan()
  await publishWorkspaceParents({ plan: plan.publication, signal, verify: verifyPlan })
  await verifyPlan()
  const record = { schema_version: 1, intent_id: id, plan_sha256: planHash, target_parent: rootFrame(path.dirname(intent.target)) }
  const previous = readWorkspaceRelocationRootParentsComplete(dataDir, id)
  if (previous) { if (sha256CanonicalJson(previous) !== sha256CanonicalJson(record)) fail(); syncIntent(ctx) }
  else publishPrivateJson(ctx, path.join(ctx.control, rootParentsCompleteFile), record, 65536, () => {
    check(); verifyRootParentsState(plan, intent)
    if (sha256CanonicalJson(readWorkspaceRelocationRootParentsPlan(dataDir, id)) !== planHash || readWorkspaceRelocationRootParentsComplete(dataDir, id)) fail()
  }, temporaryDirectory)
  await verifyPlan()
  if (sha256CanonicalJson(readWorkspaceRelocationRootParentsComplete(dataDir, id)) !== sha256CanonicalJson(record)) fail()
  return { parent: record.target_parent, commit_sha256: sha256CanonicalJson(record), plan }
}


// Runtime registry paths inherit owner-only access; protected per-entry ACLs/modes are not their contract.
function readHealthRuntimeText(dataRoot, runtimeId) {
  if (runtimeId !== undefined && !uuid(runtimeId)) fail()
  const directories = [path.join(dataRoot, 'module-runtime-registry')]
  if (runtimeId !== undefined) directories.push(path.join(directories[0], 'records'))
  const before = directories.map(directory => identity(directory))
  const owner = fs.lstatSync(dataRoot, { bigint: true }).uid
  const checkDirectories = () => {
    for (let index = 0; index < directories.length; index++) {
      const directory = directories[index], stat = fs.lstatSync(directory, { bigint: true })
      if (!same(before[index], identity(directory)) || (process.platform === 'win32' ? !native.isOwnerOnlyDirectory(directory) : stat.uid !== owner)) fail()
    }
  }
  checkDirectories()
  const file = path.join(directories.at(-1), runtimeId === undefined ? 'instance-id' : runtimeId + '.json')
  const stat = fs.lstatSync(file, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 65536n
    || (process.platform === 'win32' ? !native.isOwnerOnlyFile(file) : stat.uid !== owner)) fail()
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    if (observedVersion(fs.fstatSync(fd, { bigint: true })) !== observedVersion(stat)) fail()
    const text = fs.readFileSync(fd, 'utf8')
    if (observedVersion(fs.fstatSync(fd, { bigint: true })) !== observedVersion(stat)
      || observedVersion(fs.lstatSync(file, { bigint: true })) !== observedVersion(stat)) fail()
    checkDirectories()
    return text
  } finally { fs.closeSync(fd) }
}

const healthFile = 'relocation-health.json'
function workspaceHealthReport(dataDir, id, report) {
  try {
    const { ctx, intent } = coordinatorContext(dataDir, id)
    return workspaceHealthFrame({ ctx, intent, coordinator: readWorkspaceRelocationCoordinator(dataDir, id),
      selected: readWorkspaceRelocationRootSelected(dataDir, id), originalModules: readWorkspaceRelocationModules(dataDir, id).modules }, id, report)
  } catch { fail() }
}
function workspaceHealthFrame({ ctx, intent, coordinator, selected, originalModules }, id, report) {
  try {
    const oldRuntimeIds = new Set(originalModules.map(item => item.runtime_id).filter(Boolean))
    const scopes = originalModules.filter(item => item.runtime_id !== undefined && item.processes.length > 0 && ['crabot-agent', 'memory-default'].includes(item.module_id))
      .sort((a, b) => a.module_id.localeCompare(b.module_id))
    if (!coordinator.launch || !coordinator.ready || !selected || !fields(report, ['modules', 'root_proof'])
      || !Array.isArray(report.modules) || report.modules.length !== scopes.length) fail()
    const modules = [], pids = new Set(), runtimes = new Set(), { processBirthAtLeast } = ownedProcessTree
    for (const scope of scopes) {
      const input = report.modules.find(item => item?.module_id === scope.module_id), process = input?.process
      if (!fields(input, ['module_id', 'runtime_id', 'process']) || !uuid(input.runtime_id) || oldRuntimeIds.has(input.runtime_id) || runtimes.has(input.runtime_id)
        || !fields(process, ['pid', 'parent', 'started', 'owner', 'executable'])
        || !Number.isInteger(process.pid) || process.pid < 1 || process.pid > 2147483647 || pids.has(process.pid)
        || process.pid === coordinator.launch.parent.pid || process.pid === coordinator.launch.process.pid
        || process.parent !== coordinator.launch.parent.pid || process.owner !== coordinator.launch.parent.owner
        || !nonempty(process.started) || !nonempty(process.executable)
        || !processBirthAtLeast(process.started, coordinator.launch.parent.started)) fail()
      pids.add(process.pid); runtimes.add(input.runtime_id)
      modules.push({ module_id: scope.module_id, runtime_id: input.runtime_id, process: { ...process } })
    }
    const agent = modules.find(item => item.module_id === 'crabot-agent'), original = scopes.find(item => item.module_id === 'crabot-agent')
    if (!agent || !original) fail()
    const root_proof = { verified: true, intent_id: id, intent_sha256: sha256CanonicalJson(intent), launch_id: coordinator.launch.launch_id,
      launch_sha256: sha256CanonicalJson(coordinator.launch), root_selected_sha256: sha256CanonicalJson(selected),
      instance_id: original.instance_id, module_id: 'crabot-agent', runtime_id: agent.runtime_id }
    if (!fields(report.root_proof, Object.keys(root_proof)) || sha256CanonicalJson(report.root_proof) !== sha256CanonicalJson(root_proof)) fail()
    return { ctx, intent, modules, root_proof, scopes }
  } catch { fail() }
}
export const readWorkspaceRelocationHealth = recordGraphReader(function readWorkspaceRelocationHealth(dataDir, id) {
  const { ctx } = coordinatorContext(dataDir, id), record = readPrivateJson(path.join(ctx.control, healthFile), 65536)
  if (record === undefined) return null
  if (!fields(record, ['schema_version', 'intent_id', 'modules', 'root_proof', 'checked_at'])
    || record.schema_version !== 1 || record.intent_id !== id || !validDate(record.checked_at)) fail()
  const frame = workspaceHealthReport(dataDir, id, { modules: record.modules, root_proof: record.root_proof })
  if (sha256CanonicalJson(record.modules) !== sha256CanonicalJson(frame.modules)) fail()
  return record
})
function verifyWorkspaceHealthRuntime(dataDir, id, fixed) {
  const current = workspaceHealthReport(dataDir, id, { modules: fixed.modules, root_proof: fixed.root_proof })
  const published = readWorkspaceRelocationRootPublished(dataDir, id)
  if (!published || sha256CanonicalJson({ modules: current.modules, root_proof: current.root_proof }) !== sha256CanonicalJson({ modules: fixed.modules, root_proof: fixed.root_proof })) fail()
  verifyFixedWorkspaceRuntime(current, published.target)
}
function verifyFixedWorkspaceRuntime(fixed, directory) {
  if (sha256CanonicalJson(rootFrame(fixed.intent.target)) !== sha256CanonicalJson(directory)
    || readHealthRuntimeText(fixed.ctx.dataRoot)?.trim() !== fixed.root_proof.instance_id) fail()
  for (const module of fixed.modules) {
    const runtime = JSON.parse(readHealthRuntimeText(fixed.ctx.dataRoot, module.runtime_id))
    const scope = fixed.scopes.find(item => item.module_id === module.module_id)
    if (!native.sameProcess(module.process, native.inspectProcess(module.process.pid))
      || !fields(runtime, ['schema_version', 'instance_id', 'runtime_id', 'module_id', 'root_pid', 'process_start_identity', 'module_port', 'created_at'])
      || runtime.schema_version !== 1 || runtime.instance_id !== fixed.root_proof.instance_id || runtime.runtime_id !== module.runtime_id
      || runtime.module_id !== module.module_id || runtime.root_pid !== module.process.pid || runtime.module_port !== scope.module_port
      || !nonempty(runtime.process_start_identity) || !validDate(runtime.created_at)) fail()
  }
}
export async function recordWorkspaceRelocationHealth({ dataDir, id, report, signal }) {
  let stage = 'report'
  try {
    const fixed = workspaceHealthReport(dataDir, id, report)
    stage = 'role'
    const base = workspaceFileCoordinatorContext(dataDir, id, signal)
    const fingerprint = sha256CanonicalJson({ modules: fixed.modules, root_proof: fixed.root_proof })
    const verify = () => {
      base.verify()
      verifyWorkspaceHealthRuntime(dataDir, id, fixed)
    }
    stage = 'current-runtime'
    verify()
    stage = 'selected-root'
    await verifyWorkspaceRelocationSelectedRoot({ dataDir, id, signal })
    verify()
    stage = 'previous'
    const previous = readWorkspaceRelocationHealth(dataDir, id)
    if (previous) {
      if (sha256CanonicalJson({ modules: previous.modules, root_proof: previous.root_proof }) !== fingerprint) fail('WORKSPACE_RELOCATION_CONFLICT')
      syncIntent(fixed.ctx)
      verify()
      return { dispatch: 'observe', health_sha256: sha256CanonicalJson(previous) }
    }
    const record = { schema_version: 1, intent_id: id, modules: fixed.modules, root_proof: fixed.root_proof, checked_at: new Date().toISOString() }
    stage = 'publish'
    publishPrivateJson(fixed.ctx, path.join(fixed.ctx.control, healthFile), record, 65536, () => { verify(); if (readWorkspaceRelocationHealth(dataDir, id)) fail('WORKSPACE_RELOCATION_CONFLICT') })
    verify()
    stage = 'readback'
    const accepted = readWorkspaceRelocationHealth(dataDir, id)
    if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
    return { dispatch: 'dispatch', health_sha256: sha256CanonicalJson(accepted) }
  } catch (error) { if (error && typeof error === 'object' && typeof error.stage !== 'string') error.stage = stage; throw error }
}


const completionFile = 'relocation-complete.json'
const completionFields = ['schema_version', 'intent_id', 'intent_sha256', 'launch_sha256', 'ready_sha256', 'health_sha256', 'selected_sha256',
  'worker_commit_sha256', 'recovery_commit_sha256', 'materials', 'created_at']
// Technical records only. This inventory does not authorize execution or maintenance release.
function workspaceJobMaterials(ctx, temporary) {
  const materials = [], directories = [], root = identity(ctx.control)
  const names = fs.readdirSync(ctx.control).sort()
  const addFile = (name, file) => {
    const bytes = readPrivateBytes(file, scopeLimit)
    if (bytes === undefined) fail()
    const stat = fs.lstatSync(file, { bigint: true })
    materials.push({ name, type: 'file', dev: String(stat.dev), ino: String(stat.ino), size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  for (const name of names) {
    const file = path.join(ctx.control, name)
    if (file === temporary || name === completionFile) continue
    if (!legacyRelocationFiles.includes(name)) fail(undefined, 'completion-unknown-material')
    if (['relocation-module-processes', 'relocation-worker-commits'].includes(name)) {
      if (!privateControl(file)) fail()
      const directory = identity(file), children = fs.readdirSync(file).sort()
      if (children.length > 32768) fail()
      directories.push({ file, directory, children })
      materials.push({ name, type: 'directory', dev: directory.dev, ino: directory.ino })
      for (const child of children) {
        if (name === 'relocation-module-processes' ? !/^[0-9]{8}\.json$/.test(child) : !['header.json', 'complete.json'].includes(child) && !/^(?:0|[1-9][0-9]*)\.(?:prepared|closed)\.json$/.test(child)) fail()
        addFile(name + '/' + child, path.join(file, child))
      }
    } else addFile(name, file)
  }
  for (const row of directories) {
    if (!same(row.directory, identity(row.file)) || !privateControl(row.file)
      || JSON.stringify(fs.readdirSync(row.file).sort()) !== JSON.stringify(row.children)) fail()
  }
  if (!same(root, identity(ctx.control)) || !privateControl(ctx.control)
    || JSON.stringify(fs.readdirSync(ctx.control).sort()) !== JSON.stringify(names)) fail()
  return materials
}
export const readWorkspaceRelocationCompletion = recordGraphReader(function readWorkspaceRelocationCompletion(dataDir, id) {
  const ctx = context(dataDir), intent = read(ctx)
  if (!intent || intent.id !== id) fail()
  const record = readPrivateJson(path.join(ctx.control, completionFile), scopeLimit)
  if (record === undefined) return null
  const coordinator = readWorkspaceRelocationCoordinator(dataDir, id), health = readWorkspaceRelocationHealth(dataDir, id)
  const selected = readWorkspaceRelocationRootSelected(dataDir, id), worker = readWorkspaceRelocationClosureCommit(dataDir, id)
  const recovery = readWorkspaceRelocationRecoveryCommit(dataDir, id)
  if (!fields(record, completionFields) || record.schema_version !== 1 || record.intent_id !== id
    || !coordinator.launch || !coordinator.ready || !health || !selected || !worker || !recovery || !validDate(record.created_at)
    || record.intent_sha256 !== sha256CanonicalJson(intent) || record.launch_sha256 !== sha256CanonicalJson(coordinator.launch)
    || record.ready_sha256 !== sha256CanonicalJson(coordinator.ready) || record.health_sha256 !== sha256CanonicalJson(health)
    || record.selected_sha256 !== sha256CanonicalJson(selected) || record.worker_commit_sha256 !== sha256CanonicalJson(worker)
    || record.recovery_commit_sha256 !== sha256CanonicalJson(recovery)
    || sha256CanonicalJson(record.materials) !== sha256CanonicalJson(workspaceJobMaterials(ctx))) fail()
  return record
})
// Neutral capability checks; callers retain their own current role and fixed material guards.
async function verifyWorkspaceCapabilities(fixed, directory, verify, authorize, signal) {
  const revalidate = async () => { await authorize(); verify() }
  await revalidate()
  const { openModuleRuntimeRpc } = await import('./module-runtime-rpc.cjs')
  await revalidate()
  for (const module of fixed.modules) {
    const scope = fixed.scopes.find(item => item.module_id === module.module_id)
    const locate = () => {
      verify()
      const processes = ownedProcessTree.captureOwnedProcessTree([module.process])
      const listeners = processes.filter(item => native.sameProcess(item, native.inspectProcess(item.pid)) && native.listListeningTcpPorts(item.pid).includes(scope.module_port))
      verify()
      if (listeners.length !== 1) fail(undefined, 'completion-runtime-listener')
      return listeners[0]
    }
    const listener = locate(), rpc = await openModuleRuntimeRpc(listener, scope.module_port,
      { instance_id: fixed.root_proof.instance_id, module_id: module.module_id, runtime_id: module.runtime_id }, { signal })
    try {
      await revalidate()
      if (!native.sameProcess(listener, locate())) fail()
      const health = await rpc.call('health', {})
      await revalidate()
      if (health.status !== 'healthy' || !native.sameProcess(listener, locate())) fail(undefined, 'completion-runtime-health')
    } finally { rpc.close() }
  }
  const { probeWorkspaceDirectory } = await import('./workspace-root-probe.mjs')
  await revalidate()
  await probeWorkspaceDirectory({ directory, authorize: async () => { await revalidate(); return verify } })
  await revalidate()
}
export async function prepareWorkspaceRelocationCompletion({ dataDir, id, signal }) {
  const base = workspaceFileCoordinatorContext(dataDir, id, signal)
  base.verify()
  const health = readWorkspaceRelocationHealth(dataDir, id)
  if (!health) fail()
  const fixed = workspaceHealthReport(dataDir, id, { modules: health.modules, root_proof: health.root_proof })
  const coordinator = readWorkspaceRelocationCoordinator(dataDir, id)
  const verify = () => {
    base.verify(); verifyWorkspaceHealthRuntime(dataDir, id, fixed)
    if (sha256CanonicalJson(readWorkspaceRelocationHealth(dataDir, id)) !== sha256CanonicalJson(health)) fail()
  }
  verify()
  const selected = await verifyWorkspaceRelocationSelectedRoot({ dataDir, id, signal })
  verify()
  await verifyWorkspaceCapabilities(fixed, readWorkspaceRelocationRootPublished(dataDir, id).target, verify, async () => verify(), signal)
  verify()
  const previous = readWorkspaceRelocationCompletion(dataDir, id)
  if (previous) { syncIntent(base.ctx); verify(); return { dispatch: 'observe', completion_sha256: sha256CanonicalJson(previous) } }
  const record = { schema_version: 1, intent_id: id, intent_sha256: sha256CanonicalJson(base.intent),
    launch_sha256: sha256CanonicalJson(coordinator.launch), ready_sha256: sha256CanonicalJson(coordinator.ready),
    health_sha256: sha256CanonicalJson(health), selected_sha256: selected.selected_sha256,
    worker_commit_sha256: selected.worker_commit_sha256, recovery_commit_sha256: selected.recovery_commit_sha256,
    materials: workspaceJobMaterials(base.ctx), created_at: new Date().toISOString() }
  publishPrivateJson(base.ctx, path.join(base.ctx.control, completionFile), record, scopeLimit, temporary => {
    verify()
    if (readPrivateJson(path.join(base.ctx.control, completionFile), scopeLimit) !== undefined
      || sha256CanonicalJson(workspaceJobMaterials(base.ctx, temporary)) !== sha256CanonicalJson(record.materials)) fail()
  })
  verify()
  const accepted = readWorkspaceRelocationCompletion(dataDir, id)
  if (sha256CanonicalJson(accepted) !== sha256CanonicalJson(record)) fail()
  return { dispatch: 'dispatch', completion_sha256: sha256CanonicalJson(accepted) }
}

const finalizingFile = 'relocation-finalizing.json'
/** Historical facts only; this reader never falls back from an ordinary active journal. */
export const readWorkspaceRelocationArchivedCompletion = recordGraphReader(function readWorkspaceRelocationArchivedCompletion(dataDir, id) {
  if (!uuid(id)) fail()
  const ctx = context(dataDir), history = path.join(ctx.baseControl, 'relocation-history'), archive = path.join(history, id)
  if (!privateControl(ctx.baseControl) || !privateControl(history) || !privateControl(archive)) return null
  const archived = { ...ctx, control: archive }, intent = readPrivateJson(path.join(archive, 'relocation.json'), 65536)
  const record = readPrivateJson(path.join(archive, completionFile), scopeLimit)
  if (!intent || intent.id !== id || !validIdentity(intent.data_root) || !same(intent.data_root, identity(ctx.dataRoot))
    || !validIdentity(intent.control_root) || intent.control_root.path !== ctx.control
    || !same({ ...intent.control_root, path: archive }, identity(archive))
    || !fields(record, completionFields)
    || record.schema_version !== 1 || record.intent_id !== id || !validDate(record.created_at)
    || record.intent_sha256 !== sha256CanonicalJson(intent)
    || sha256CanonicalJson(record.materials) !== sha256CanonicalJson(workspaceJobMaterials(archived))) fail()
  for (const [key, name] of [['launch_sha256', coordinatorFile], ['ready_sha256', coordinatorReadyFile], ['health_sha256', healthFile],
    ['selected_sha256', rootSelectedFile], ['worker_commit_sha256', closureCommitsDirectory + '/complete.json'], ['recovery_commit_sha256', recoveryCommitFile]]) {
    const value = readPrivateJson(path.join(archive, name), scopeLimit)
    if (value === undefined || record[key] !== sha256CanonicalJson(value)) fail()
  }
  return record
})
/** Sealed facts only. This does not revive the original active role or any command. */
export const readWorkspaceRelocationArchivedState = recordGraphReader(function readWorkspaceRelocationArchivedState(dataDir, id) {
  const completion = readWorkspaceRelocationArchivedCompletion(dataDir, id)
  if (!completion) fail()
  const ctx = context(dataDir), archive = { ...ctx, control: path.join(ctx.baseControl, 'relocation-history', id) }
  const intent = readPrivateJson(path.join(archive.control, 'relocation.json'), 65536)
  const launch = readPrivateJson(path.join(archive.control, coordinatorFile), 65536), ready = readPrivateJson(path.join(archive.control, coordinatorReadyFile), 65536)
  const selected = readPrivateJson(path.join(archive.control, rootSelectedFile), 65536), published = readPrivateJson(path.join(archive.control, rootPublishedFile), 65536)
  const workers = readPrivateJson(path.join(archive.control, 'relocation-workers.json'), scopeLimit)
  if (!fields(workers, ['schema_version', 'intent_id', 'intent_sha256', 'workers', 'created_at']) || workers.schema_version !== 1
    || workers.intent_id !== id || workers.intent_sha256 !== sha256CanonicalJson(intent) || !validWorkers(workers.workers) || !validDate(workers.created_at)) fail()
  const health = readPrivateJson(path.join(archive.control, healthFile), 65536), modules = readModules(archive, intent, workers)
  if (!launch || !ready || !selected || !published || !modules || !fields(health, ['schema_version', 'intent_id', 'modules', 'root_proof', 'checked_at'])
    || health.schema_version !== 1 || health.intent_id !== id || !validDate(health.checked_at)) fail()
  const frame = workspaceHealthFrame({ ctx, intent, coordinator: { launch, ready }, selected, originalModules: modules.modules }, id,
    { modules: health.modules, root_proof: health.root_proof })
  if (sha256CanonicalJson(frame.modules) !== sha256CanonicalJson(health.modules)) fail()
  const files = readPrivateJson(path.join(archive.control, filePlanFile), 65536)
  if (!files || files.intent_id !== id || files.intent_sha256 !== sha256CanonicalJson(intent)) fail()
  validFileObservation(files.source_observation, intent)
  return { completion, intent, launch, ready, selected, published, health, modules, workers, files }
})
/** Sealed closure facts for read-only inspection; no active role or command is restored. */
export const readWorkspaceRelocationArchivedClosureFacts = recordGraphReader(function readWorkspaceRelocationArchivedClosureFacts(dataDir, id) {
  const completion = readWorkspaceRelocationArchivedCompletion(dataDir, id)
  if (!completion) fail()
  const archive = path.join(context(dataDir).baseControl, 'relocation-history', id)
  const workerPlan = readPrivateJson(path.join(archive, closurePlanFile), scopeLimit)
  const workerComplete = readPrivateJson(path.join(archive, closureCommitsDirectory, 'complete.json'), scopeLimit)
  const recoveryPlan = readPrivateJson(path.join(archive, recoveryPlanFile), scopeLimit)
  const recoveryComplete = readPrivateJson(path.join(archive, recoveryCommitFile), scopeLimit)
  if (!workerPlan || !workerComplete || !recoveryPlan || !recoveryComplete
    || sha256CanonicalJson(workerComplete) !== completion.worker_commit_sha256 || sha256CanonicalJson(recoveryComplete) !== completion.recovery_commit_sha256
    || workerComplete.plan_sha256 !== sha256CanonicalJson(workerPlan) || recoveryComplete.plan_sha256 !== sha256CanonicalJson(recoveryPlan)
    || recoveryPlan.worker_closure_sha256 !== completion.worker_commit_sha256) fail()
  return { workerPlan, workerComplete, recoveryPlan, recoveryComplete }
})
function workspaceFinalizingFrame(ctx, id, record) {
  const history = path.join(ctx.baseControl, 'relocation-history')
  if (!fields(record, ['schema_version', 'intent_id', 'intent_sha256', 'completion_sha256', 'launch_sha256', 'control_root', 'history_root', 'archive_path', 'created_at'])
    || record.schema_version !== 1 || record.intent_id !== id || !digest(record.intent_sha256) || !digest(record.completion_sha256) || !digest(record.launch_sha256)
    || !fields(record.control_root, ['path', 'dev', 'ino', 'native_id']) || !validIdentity({ path: record.control_root.path, dev: record.control_root.dev, ino: record.control_root.ino })
    || record.control_root.path !== ctx.control || !privateControl(history) || sha256CanonicalJson(record.history_root) !== sha256CanonicalJson(rootFrame(history))
    || record.archive_path !== path.join(history, id) || !validDate(record.created_at)
    || (process.platform === 'win32' ? typeof record.control_root.native_id !== 'string' || !/^[0-9]+:[a-f0-9]{32}$/i.test(record.control_root.native_id) : record.control_root.native_id !== null)) fail()
  return record
}
export const readWorkspaceRelocationFinalizing = recordGraphReader(function readWorkspaceRelocationFinalizing(dataDir, id) {
  if (!uuid(id)) fail()
  const ctx = context(dataDir)
  if (!privateControl(ctx.baseControl)) return null
  const record = readPrivateJson(path.join(ctx.baseControl, finalizingFile), 65536)
  if (record === undefined) return null
  workspaceFinalizingFrame(ctx, id, record)
  const locations = [ctx.control, record.archive_path].filter(directory => privateControl(directory))
  if (locations.length !== 1 || sha256CanonicalJson({ ...rootFrame(locations[0]), path: ctx.control }) !== sha256CanonicalJson(record.control_root)) fail()
  return record
})
/** The original fence's stored effect only; never permission to release or reopen. */
export const readWorkspaceRelocationReleased = recordGraphReader(function readWorkspaceRelocationReleased(dataDir, id) {
  if (!uuid(id)) fail()
  const ctx = context(dataDir)
  if (!privateControl(ctx.baseControl)) return null
  const history = path.join(ctx.baseControl, 'relocation-history')
  if (!privateControl(history)) return null
  const record = readPrivateJson(path.join(history, id + '.released.json'), 65536)
  if (record === undefined) return null
  workspaceFinalizingFrame(ctx, id, record)
  const completion = readWorkspaceRelocationArchivedCompletion(dataDir, id)
  if (!completion || record.completion_sha256 !== sha256CanonicalJson(completion) || record.intent_sha256 !== completion.intent_sha256
    || record.launch_sha256 !== completion.launch_sha256
    || sha256CanonicalJson({ ...rootFrame(record.archive_path), path: ctx.control }) !== sha256CanonicalJson(record.control_root)) fail()
  return record
})
export const readCurrentWorkspaceRelocationFinalizing = recordGraphReader(function readCurrentWorkspaceRelocationFinalizing(dataDir) {
  const ctx = context(dataDir)
  if (!privateControl(ctx.baseControl)) return null
  const record = readPrivateJson(path.join(ctx.baseControl, finalizingFile), 65536)
  if (record === undefined) return null
  if (!uuid(record?.intent_id)) fail()
  return readWorkspaceRelocationFinalizing(dataDir, record.intent_id)
})
// One synchronous material observation only. It never owns, resumes or completes a job.
const readWorkspaceJobStatusFrame = recordGraphReader(function readWorkspaceJobStatusFrame(dataDir, requestedId) {
  if (requestedId !== undefined && !uuid(requestedId)) fail()
  const ctx = context(dataDir)
  assertNoLegacyRelocation(dataDir)
  const finalizing = readCurrentWorkspaceRelocationFinalizing(dataDir)
  const active = privateControl(ctx.control) ? readWorkspaceRelocationIntent(dataDir) : null
  if (active && finalizing && (finalizing.intent_id !== active.id || finalizing.intent_sha256 !== sha256CanonicalJson(active)
    || finalizing.completion_sha256 !== sha256CanonicalJson(readWorkspaceRelocationCompletion(dataDir, active.id)))) fail()
  const id = requestedId ?? active?.id ?? finalizing?.intent_id
  if (!id) return { available: !workspaceMaintenance.workspaceMaintenancePending(dataDir), job: null }
  if (active?.id === id) return { available: true, job: { intent_id: id, state: 'needs_attention',
    stage: finalizing ? 'finalizing' : 'unknown', source: active.source.path, target: active.target } }
  const released = readWorkspaceRelocationReleased(dataDir, id)
  const archived = readWorkspaceRelocationArchivedCompletion(dataDir, id)
  if (!archived) {
    if (finalizing?.intent_id === id) fail()
    return { available: true, job: null }
  }
  const state = readWorkspaceRelocationArchivedState(dataDir, id)
  if (released && finalizing?.intent_id === id) fail()
  if (finalizing?.intent_id === id && finalizing.completion_sha256 !== sha256CanonicalJson(state.completion)) fail()
  return { available: true, job: { intent_id: id, state: released ? 'committed' : 'needs_attention',
    stage: released ? 'finished' : 'finalizing', source: state.intent.source.path, target: state.intent.target } }
})
export function readWorkspaceRelocationJobStatus(dataDir, requestedId) {
  try { return readWorkspaceJobStatusFrame(dataDir, requestedId) }
  catch { return { available: false, job: null } }
}

/** Before release only: facts and live capabilities, never authorization to reopen business. */
export async function verifyWorkspaceRelocationArchivedCapabilities({ dataDir, id, signal, verify: authorize }) {
  if (typeof authorize !== 'function') fail()
  await authorize()
  const state = readWorkspaceRelocationArchivedState(dataDir, id), stateHash = sha256CanonicalJson(state)
  const fixed = workspaceHealthFrame({ ctx: context(dataDir), intent: state.intent, coordinator: { launch: state.launch, ready: state.ready },
    selected: state.selected, originalModules: state.modules.modules }, id, { modules: state.health.modules, root_proof: state.health.root_proof })
  const verify = () => {
    if (signal?.aborted || sha256CanonicalJson(readWorkspaceRelocationArchivedState(dataDir, id)) !== stateHash) fail()
    const fence = readWorkspaceRelocationFinalizing(dataDir, id)
    if (!fence || fence.completion_sha256 !== sha256CanonicalJson(state.completion) || fence.intent_sha256 !== state.completion.intent_sha256
      || fence.launch_sha256 !== state.completion.launch_sha256
      || !native.sameProcess(state.launch.parent, native.inspectProcess(state.launch.parent.pid))
      || !native.sameProcess(state.launch.process, native.inspectProcess(state.launch.process.pid))) fail()
    verifyFixedWorkspaceRuntime(fixed, state.published.target)
  }
  const current = async () => { await authorize(); verify() }
  await current()
  const catalog = new WorkspaceCatalog({ dataRoot: fixed.ctx.dataRoot, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native })
  const snapshot = await catalog.snapshot()
  await current()
  if (sha256CanonicalJson(snapshot) !== state.selected.catalog_sha256) fail()
  const agent = await import('../../crabot-agent/dist/core/workspace-relocation-closed-evidence.js')
  await current()
  const closures = await agent.inspectArchivedWorkspaceRelocationClosures({ dataDir, id, signal, verify: current })
  await current(); closures.verify()
  if (closures.worker_commit_sha256 !== state.completion.worker_commit_sha256 || closures.recovery_commit_sha256 !== state.completion.recovery_commit_sha256) fail()
  await verifyWorkspaceCapabilities(fixed, state.published.target, verify, authorize, signal)
  await current(); closures.verify()
  return Object.freeze({ completion_sha256: sha256CanonicalJson(state.completion), selected_sha256: sha256CanonicalJson(state.selected), modules_sha256: sha256CanonicalJson(state.health.modules) })
}
/** One original coordinator's storage effect only. The fixed fence remains until current MM/Admin confirmation. */
export async function archiveWorkspaceRelocationJob({ dataDir, id, signal }) {
  await prepareWorkspaceRelocationCompletion({ dataDir, id, signal })
  const base = workspaceFileCoordinatorContext(dataDir, id, signal), completion = readWorkspaceRelocationCompletion(dataDir, id)
  const coordinator = readWorkspaceRelocationCoordinator(dataDir, id), health = readWorkspaceRelocationHealth(dataDir, id)
  const fixed = workspaceHealthReport(dataDir, id, { modules: health.modules, root_proof: health.root_proof })
  const completionHash = sha256CanonicalJson(completion), token = cliLockToken(path.join(base.ctx.dataRoot, 'cli.lock'))
  const dataRoot = identity(base.ctx.dataRoot), baseControl = identity(base.ctx.baseControl), active = rootFrame(base.ctx.control)
  const verify = () => {
    base.verify(); verifyWorkspaceHealthRuntime(dataDir, id, fixed)
    if (sha256CanonicalJson(readWorkspaceRelocationCompletion(dataDir, id)) !== completionHash) fail()
  }
  verify()
  const historyPath = path.join(base.ctx.baseControl, 'relocation-history')
  management.ensurePrivateDataRoot(historyPath)
  const history = rootFrame(historyPath), archive = path.join(historyPath, id)
  const absentArchive = () => { try { fs.lstatSync(archive); fail('WORKSPACE_RELOCATION_CONFLICT') } catch (error) { if (error.code !== 'ENOENT') throw error } }
  const verifyBeforeMove = () => {
    verify(); absentArchive()
    if (!same(dataRoot, identity(base.ctx.dataRoot)) || !same(baseControl, identity(base.ctx.baseControl))
      || sha256CanonicalJson(rootFrame(base.ctx.control)) !== sha256CanonicalJson(active)
      || sha256CanonicalJson(rootFrame(historyPath)) !== sha256CanonicalJson(history) || !privateControl(historyPath)) fail()
  }
  verifyBeforeMove()
  const previous = readWorkspaceRelocationFinalizing(dataDir, id)
  const fence = { schema_version: 1, intent_id: id, intent_sha256: sha256CanonicalJson(base.intent), completion_sha256: completionHash,
    launch_sha256: sha256CanonicalJson(coordinator.launch), control_root: active, history_root: history, archive_path: archive,
    created_at: previous?.created_at ?? new Date().toISOString() }
  syncDirectory(historyPath); syncDirectory(base.ctx.baseControl); syncDirectory(base.ctx.dataRoot)
  if (previous) {
    if (sha256CanonicalJson(previous) !== sha256CanonicalJson(fence)) fail()
  } else {
    const parent = { ...base.ctx, control: base.ctx.baseControl }
    publishPrivateJson(parent, path.join(parent.control, finalizingFile), fence, 65536, () => {
      verifyBeforeMove()
      if (readWorkspaceRelocationFinalizing(dataDir, id)) fail()
    })
  }
  await verifyWorkspaceRelocationSelectedRoot({ dataDir, id, signal })
  verifyBeforeMove()
  if (sha256CanonicalJson(readWorkspaceRelocationFinalizing(dataDir, id)) !== sha256CanonicalJson(fence)) fail()
  native.renameDirectoryNoReplace(base.ctx.control, archive)
  syncDirectory(archive); syncDirectory(historyPath); syncDirectory(base.ctx.baseControl); syncDirectory(base.ctx.dataRoot)
  // Only the fixed terminal handoff may inspect these facts after the active job moved.
  const launch = coordinator.launch
  const verifyArchived = () => {
    try { fs.lstatSync(base.ctx.control); fail() } catch (error) { if (error.code !== 'ENOENT') throw error }
    const self = native.inspectProcess(process.pid)
    if (signal?.aborted || !process.connected || !token || cliLockToken(path.join(base.ctx.dataRoot, 'cli.lock')) !== token
      || !native.sameProcess(launch.process, self) || self.parent !== launch.parent.pid || !native.sameProcess(launch.parent, native.inspectProcess(launch.parent.pid))
      || !same(dataRoot, identity(base.ctx.dataRoot)) || !same(baseControl, identity(base.ctx.baseControl))
      || sha256CanonicalJson({ ...rootFrame(archive), path: active.path }) !== sha256CanonicalJson(active)
      || sha256CanonicalJson(readWorkspaceRelocationFinalizing(dataDir, id)) !== sha256CanonicalJson(fence)
      || sha256CanonicalJson(readWorkspaceRelocationArchivedCompletion(dataDir, id)) !== completionHash) fail()
  }
  verifyArchived()
  const agent = await import('../../crabot-agent/dist/core/workspace-relocation-closed-evidence.js')
  verifyArchived()
  const closures = await agent.inspectArchivedWorkspaceRelocationClosures({ dataDir, id, signal, verify: async () => verifyArchived() })
  verifyArchived(); closures.verify()
  if (closures.worker_commit_sha256 !== completion.worker_commit_sha256 || closures.recovery_commit_sha256 !== completion.recovery_commit_sha256) fail()
  return { intent_id: id, completion_sha256: completionHash, finalizing_sha256: sha256CanonicalJson(fence) }
}

/** Fixed storage only; callers separately own their role and current capability checks. */
export async function commitWorkspaceRelocationFinalizing({ dataDir, id, signal, verify: authorize, assertCurrent, checkCapabilities }) {
  if (typeof authorize !== 'function' || typeof assertCurrent !== 'function' || typeof checkCapabilities !== 'function') fail()
  await authorize()
  const state = readWorkspaceRelocationArchivedState(dataDir, id), stateHash = sha256CanonicalJson(state)
  const ctx = context(dataDir), fence = readWorkspaceRelocationFinalizing(dataDir, id), fenceHash = sha256CanonicalJson(fence)
  if (!fence || fence.completion_sha256 !== sha256CanonicalJson(state.completion)) fail()
  const dataRoot = identity(ctx.dataRoot), base = identity(ctx.baseControl)
  const source = path.join(ctx.baseControl, finalizingFile), destination = path.join(ctx.baseControl, 'relocation-history', id + '.released.json')
  const bytes = readPrivateBytes(source, 65536), original = fs.lstatSync(source, { bigint: true })
  const absent = file => { try { fs.lstatSync(file); fail('WORKSPACE_RELOCATION_CONFLICT') } catch (error) { if (error.code !== 'ENOENT') throw error } }
  const checkStorage = () => {
    assertCurrent()
    if (signal?.aborted || !same(dataRoot, identity(ctx.dataRoot)) || !same(base, identity(ctx.baseControl))
      || sha256CanonicalJson(readWorkspaceRelocationArchivedState(dataDir, id)) !== stateHash) fail()
    for (const name of ['relocation-active', ...legacyRelocationFiles]) absent(path.join(ctx.baseControl, name))
  }
  const before = () => {
    checkStorage(); absent(destination)
    if (sha256CanonicalJson(readWorkspaceRelocationFinalizing(dataDir, id)) !== fenceHash
      || observedVersion(fs.lstatSync(source, { bigint: true })) !== observedVersion(original)) fail()
  }
  const verify = async () => { await authorize(); before() }
  await verify()
  await checkCapabilities(verify)
  await verify()
  syncDirectory(fence.archive_path); syncDirectory(path.dirname(destination)); syncDirectory(ctx.baseControl); syncDirectory(ctx.dataRoot)
  before()
  native.renameFileNoReplace(source, destination)
  // A thrown sync/readback leaves an unknown result, never a successful release receipt.
  syncDirectory(path.dirname(destination)); syncDirectory(ctx.baseControl); syncDirectory(ctx.dataRoot)
  checkStorage(); absent(source)
  const moved = fs.lstatSync(destination, { bigint: true })
  if (moved.dev !== original.dev || moved.ino !== original.ino || !readPrivateBytes(destination, 65536).equals(bytes)
    || sha256CanonicalJson(readWorkspaceRelocationReleased(dataDir, id)) !== fenceHash) fail()
  await authorize()
  checkStorage(); absent(source)
  return Object.freeze({ intent_id: id, completion_sha256: fence.completion_sha256, finalizing_sha256: fenceHash })
}

/** One original coordinator's commit effect. A new recovery cannot borrow this role. */
export async function releaseWorkspaceRelocationJob({ dataDir, id, signal, verify: authorize }) {
  if (typeof authorize !== 'function') fail()
  const state = readWorkspaceRelocationArchivedState(dataDir, id), stateHash = sha256CanonicalJson(state)
  const ctx = context(dataDir), token = cliLockToken(path.join(ctx.dataRoot, 'cli.lock')), dataRoot = identity(ctx.dataRoot), base = identity(ctx.baseControl)
  const assertCurrent = () => {
    const self = native.inspectProcess(process.pid)
    if (signal?.aborted || !token || cliLockToken(path.join(ctx.dataRoot, 'cli.lock')) !== token || !process.connected
      || !same(dataRoot, identity(ctx.dataRoot)) || !same(base, identity(ctx.baseControl))
      || !native.sameProcess(state.launch.process, self) || self.parent !== state.launch.parent.pid
      || !native.sameProcess(state.launch.parent, native.inspectProcess(state.launch.parent.pid))
      || sha256CanonicalJson(readWorkspaceRelocationArchivedState(dataDir, id)) !== stateHash) fail()
  }
  const verify = async () => { await authorize(); assertCurrent() }
  return commitWorkspaceRelocationFinalizing({ dataDir, id, signal, verify, assertCurrent,
    checkCapabilities: current => verifyWorkspaceRelocationArchivedCapabilities({ dataDir, id, signal, verify: current }) })
}

/** After the committed effect only; new business records may legitimately advance. */
export async function verifyWorkspaceRelocationReleasedCapabilities({ dataDir, id, signal, verify: authorize }) {
  if (typeof authorize !== 'function') fail()
  await authorize()
  const state = readWorkspaceRelocationArchivedState(dataDir, id), stateHash = sha256CanonicalJson(state)
  const released = readWorkspaceRelocationReleased(dataDir, id), releasedHash = sha256CanonicalJson(released)
  if (!released || released.completion_sha256 !== sha256CanonicalJson(state.completion)) fail()
  const fixed = workspaceHealthFrame({ ctx: context(dataDir), intent: state.intent, coordinator: { launch: state.launch, ready: state.ready },
    selected: state.selected, originalModules: state.modules.modules }, id, { modules: state.health.modules, root_proof: state.health.root_proof })
  const { assertWorkspaceExecutionAllowed } = await import('./workspace-maintenance.cjs')
  const verify = () => {
    if (signal?.aborted || sha256CanonicalJson(readWorkspaceRelocationArchivedState(dataDir, id)) !== stateHash
      || sha256CanonicalJson(readWorkspaceRelocationReleased(dataDir, id)) !== releasedHash) fail()
    assertWorkspaceExecutionAllowed(fixed.ctx.dataRoot)
    verifyFixedWorkspaceRuntime(fixed, state.published.target)
  }
  const current = async () => { await authorize(); verify() }
  await current()
  const catalog = new WorkspaceCatalog({ dataRoot: fixed.ctx.dataRoot, storageRoot: process.env.WORKER_WORKSPACES_DIR, files: native })
  const snapshot = await catalog.snapshot()
  await current()
  if (snapshot.storage_root !== state.intent.target || snapshot.revision < state.selected.catalog_revision) fail()
  // Do not re-demand pre-release ledger/catalog byte versions after lawful new writes.
  await verifyWorkspaceCapabilities(fixed, state.published.target, verify, authorize, signal)
  await current()
  return Object.freeze({ completion_sha256: sha256CanonicalJson(state.completion), finalizing_sha256: releasedHash })
}


/** Original active-job facts only. This does not establish exit, content integrity or an effect role. */
export const readWorkspaceInterruptedRelocationCheckpoint = recordGraphReader(function readWorkspaceInterruptedRelocationCheckpoint(dataDir, id) {
  const { ctx, intent } = coordinatorContext(dataDir, id)
  const materials = workspaceJobMaterials(ctx), present = new Set(materials.map(item => item.name))
  const readIf = (name, reader) => present.has(name) ? reader(dataDir, id) : null
  const workers = readWorkspaceRelocationWorkers(dataDir, id), coordinator = readWorkspaceRelocationCoordinator(dataDir, id)
  const facts = {
    intent, workers, coordinator,
    stops: workers ? readWorkspaceRelocationStops(dataDir, id) : null,
    processes: readIf('relocation-worker-processes.json', readWorkspaceRelocationProcesses),
    modules: workers ? readWorkspaceRelocationModules(dataDir, id) : null,
    module_stops: readIf('relocation-module-stop-attempt.json', readWorkspaceRelocationModuleStops),
    process_stops: readIf(processStopFile, readWorkspaceRelocationProcessStops),
    execution_exit: readWorkspaceRelocationExecutionExit(dataDir, id),
    file_plan: readWorkspaceRelocationFilePlan(dataDir, id),
    file_actors: readIf(fileActorsFile, readWorkspaceRelocationFileActors),
    closure_plan: readWorkspaceRelocationClosurePlan(dataDir, id),
    closure_commit: readWorkspaceRelocationClosureCommit(dataDir, id),
    recovery_plan: readWorkspaceRelocationRecoveryPlan(dataDir, id),
    recovery_commit: readWorkspaceRelocationRecoveryCommit(dataDir, id),
    root_plan: readWorkspaceRelocationRootPlan(dataDir, id),
    published: readWorkspaceRelocationRootPublished(dataDir, id),
    selected: readWorkspaceRelocationRootSelected(dataDir, id),
    parents_plan: readWorkspaceRelocationRootParentsPlan(dataDir, id),
    parents_complete: readWorkspaceRelocationRootParentsComplete(dataDir, id),
    health: readWorkspaceRelocationHealth(dataDir, id),
    completion: readWorkspaceRelocationCompletion(dataDir, id),
  }
  // A prepared closure journal already crosses the commit boundary, even when
  // complete.json or catalog selection has not yet been written.
  const action = present.has(closureCommitsDirectory) || facts.published || facts.selected ? 'finish_commit' : 'restore_source'
  return { ...facts, action, materials, checkpoint_sha256: sha256CanonicalJson({ facts, materials, action }) }
})


/** Technical inventory of atomically retained source-restored materials; no moved-root history or role. */
export const readWorkspaceCancelledRelocationMaterials = recordGraphReader(function readWorkspaceCancelledRelocationMaterials(dataDir, id) {
  if (!uuid(id)) fail()
  const ctx = context(dataDir), parent = path.join(ctx.baseControl, 'relocation-cancelled'), job = path.join(parent, id), control = path.join(job, 'original')
  for (const directory of [ctx.baseControl, parent, job, control]) if (!privateControl(directory)) fail()
  return workspaceJobMaterials({ ...ctx, control })
})

/** Original technical inventory retained by a version-2 forward recovery, never an old completion. */
export const readWorkspaceForwardRelocationMaterials = recordGraphReader(function readWorkspaceForwardRelocationMaterials(dataDir, id) {
  if (!uuid(id)) fail()
  const ctx = context(dataDir), parent = path.join(ctx.baseControl, 'relocation-history'), job = path.join(parent, id), control = path.join(job, 'original')
  for (const directory of [ctx.baseControl, parent, job, control]) if (!privateControl(directory)) fail()
  return workspaceJobMaterials({ ...ctx, control })
})
