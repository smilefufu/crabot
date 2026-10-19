// Initial private intent only. It never authorizes a stop, move, closure or release of maintenance.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import native from './process-identity.cjs'
import management from './desktop-management.cjs'
import { cliLockToken } from './cli-lock.mjs'
import { readVersionMaintenance } from './version-maintenance.mjs'
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
function read(ctx) {
  if (!privateControl(ctx.control)) return null
  let before
  try { before = fs.lstatSync(ctx.file, { bigint: true }) } catch (error) { if (error.code === 'ENOENT') return null; fail() }
  const owner = process.platform === 'win32' ? native.isPrivateFile(ctx.file)
    : before.uid === BigInt(process.getuid()) && (before.mode & 0o777n) === 0o600n
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 65536n || !owner) fail()
  let fd
  try {
    fd = fs.openSync(ctx.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const stat = fs.fstatSync(fd, { bigint: true })
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) fail()
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'))
    const after = fs.lstatSync(ctx.file, { bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) fail()
    if (value?.schema_version !== 1 || Object.keys(value).length !== 12 || !uuid(value.id) || value.phase !== 'freezing'
      || !Number.isSafeInteger(value.catalog_revision) || value.catalog_revision < 1
      || !validIdentity(value.data_root) || !same(value.data_root, identity(ctx.dataRoot))
      || !validIdentity(value.control_root) || !same(value.control_root, identity(ctx.control)) || !validIdentity(value.source)
      || !absolute(value.target) || !absolute(value.requested_target) || !validIdentity(value.target_ancestor)
      || value.target_identity !== null && (!validIdentity(value.target_identity) || value.target_identity.path !== value.target)
      || typeof value.created_at !== 'string' || new Date(value.created_at).toISOString() !== value.created_at) fail()
    return value
  } catch { fail() } finally { if (fd !== undefined) fs.closeSync(fd) }
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
  const temporary = path.join(ctx.control, '.relocation-' + randomUUID())
  try {
    const content = JSON.stringify(record) + '\n'
    if (Buffer.byteLength(content) > 65536) fail()
    if (process.platform === 'win32') { native.writePrivateFile(temporary, ''); fs.writeFileSync(temporary, content, { flag: 'r+', flush: true }) }
    else fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600, flush: true })
    if (!same(dataIdentity, identity(ctx.dataRoot)) || !same(controlIdentity, identity(ctx.control)) || !privateControl(ctx.control)) fail()
    if (read(ctx)) fail('WORKSPACE_RELOCATION_CONFLICT')
    // No replacement: even an unexpected entry appearing under the held lock is preserved.
    try { fs.linkSync(temporary, ctx.file) } catch (error) { if (error.code === 'EEXIST') fail('WORKSPACE_RELOCATION_CONFLICT'); throw error }
  } finally { fs.rmSync(temporary, { force: true }) }
  syncIntent(ctx)
  return read(ctx)
}
