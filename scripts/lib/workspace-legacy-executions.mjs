// Offline additive metadata preparation; caller must verify the target Core before loading it.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import native from './process-identity.cjs'
import records from './workspace-legacy-record.cjs'
import { acquireCliLock, cliLockToken, hasInheritedCliLock, releaseCliLock } from './cli-lock.mjs'
import { assertStopped } from '../upgrade-lib/scoped-data.mjs'
const require = createRequire(import.meta.url)
const fail = () => { throw Object.assign(new Error('旧执行兼容升级无法核验，原文件和维护保护已保留。'), { code: 'WORKSPACE_MAINTENANCE' }) }
const version = stat => [stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.gid, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':')
function optionalStat(file) { try { return fs.lstatSync(file, { bigint: true }) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
function capabilities(root) {
  const file = path.join(root, 'crabot-agent/workspace-legacy-execution-version'), stat = optionalStat(file)
  if (!stat) return null
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 64n || fs.readFileSync(file, 'utf8') !== '1\n') fail()
  return true
}
export async function previewWorkspaceLegacyExecutions(root, dataDir) {
  if (!capabilities(root)) return { status: 'not_applicable' }
  const record = optionalStat(dataDir) ? records.readWorkspaceLegacyExecutions(dataDir) : null
  if (record) return record
  return { status: 'pending' }
}
function captureInputs(root, dataDir) {
  const { filenameToManagerKey, ATOMIC_TEMP_FILE, normalizeLegacyWorkerMetadata } = require(path.join(root, 'crabot-agent/dist/workers/harness/ledger-store.js'))
  const directory = path.join(dataDir, 'agent/worker-ledgers'), entries = [], versions = [], parents = []
  for (const parent of [path.join(dataDir, 'agent'), directory]) {
    const stat = optionalStat(parent)
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(parent) !== parent
      || process.getuid && stat.uid !== BigInt(process.getuid()))) fail()
    parents.push([parent, stat ? version(stat) : null])
  }
  const names = optionalStat(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('.json') && !ATOMIC_TEMP_FILE.test(name)).sort() : []
  if (names.length > 32768) fail()
  let totalBytes = 0
  for (const name of names) {
    const managerKey = filenameToManagerKey(name), file = path.join(directory, name), before = optionalStat(file)
    if (!managerKey || !before?.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 64n * 1024n * 1024n
      || process.getuid && before.uid !== BigInt(process.getuid())) fail()
    totalBytes += Number(before.size)
    if (totalBytes > 256 * 1024 * 1024) fail()
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    let physical
    try {
      if (version(fs.fstatSync(fd, { bigint: true })) !== version(before)) fail()
      const bytes = Buffer.alloc(Number(before.size) + 1)
      let offset = 0
      while (offset < bytes.length) { const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!read) break; offset += read }
      if (offset !== Number(before.size) || version(fs.fstatSync(fd, { bigint: true })) !== version(before)) fail()
      physical = JSON.parse(bytes.subarray(0, offset))
    } finally { fs.closeSync(fd) }
    const wrapped = physical && Object.hasOwn(physical, 'schema_version')
    if (wrapped && (physical.schema_version !== 1 || Object.keys(physical).length !== 2 || !Object.hasOwn(physical, 'ledger'))) fail()
    const ledger = wrapped ? physical.ledger : physical
    if (!ledger || ledger.manager_key !== managerKey || !Array.isArray(ledger.workers)) fail()
    for (const worker of ledger.workers) {
      if (!worker || worker.manager_key !== managerKey || !worker.origin || !Array.isArray(worker.incarnations)
        || worker.origin.request && !wrapped) fail()
      entries.push({ managerKey, worker: normalizeLegacyWorkerMetadata(worker) })
      if (entries.length > 32768) fail()
    }
    versions.push([file, version(before)])
  }
  const assertCurrent = () => {
    for (const [file, previous] of [...parents, ...versions]) { const stat = optionalStat(file); if ((stat ? version(stat) : null) !== previous) fail() }
  }
  assertCurrent()
  return { entries, assertCurrent }
}
function sync(directory) {
  if (process.platform === 'win32') return
  const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
export async function prepareWorkspaceLegacyExecutions(root, dataDir, { lockHeld = false } = {}) {
  if (!capabilities(root)) return { status: 'not_applicable' }
  let lock
  try {
    const requestedDataRoot = path.resolve(dataDir), dataRoot = records.requireOwnedDataRoot(requestedDataRoot)
    const dataIdentity = fs.lstatSync(dataRoot, { bigint: true })
    const assertDataRoot = () => {
      if (records.requireOwnedDataRoot(requestedDataRoot) !== dataRoot) fail()
      const current = fs.lstatSync(dataRoot, { bigint: true })
      if (current.dev !== dataIdentity.dev || current.ino !== dataIdentity.ino) fail()
    }
    if (!lockHeld) lock = await acquireCliLock(dataRoot, 'legacy-execution-upgrade')
    const held = () => cliLockToken(path.join(requestedDataRoot, 'cli.lock')) || cliLockToken(path.join(dataRoot, 'cli.lock'))
      || (hasInheritedCliLock(dataRoot) ? process.env.CRABOT_CLI_LOCK_HELD : null)
    const token = held()
    if (!token) fail()
    const initial = await previewWorkspaceLegacyExecutions(root, dataRoot)
    assertDataRoot()
    if (held() !== token) fail()
    if (initial.status === 'ready') return initial
    await assertStopped(dataRoot)
    assertDataRoot()
    if (held() !== token) fail()
    const code = require(path.join(path.resolve(root), 'crabot-agent/dist/workers/harness/workspace-legacy-executions.js'))
    const control = path.join(dataRoot, 'workspace-control')
    if (!optionalStat(control)) {
      if (process.platform === 'win32') native.createPrivateDirectory(control)
      else fs.mkdirSync(control, { mode: 0o700 })
    }
    records.readWorkspaceLegacyExecutions(dataRoot) // Establish strict control-directory ownership before writing.
    const controlIdentity = fs.statSync(control, { bigint: true })
    const assertCurrent = () => {
      assertDataRoot()
      const data = fs.lstatSync(dataRoot, { bigint: true }), parent = fs.lstatSync(control, { bigint: true })
      if (held() !== token || !data.isDirectory() || data.isSymbolicLink() || data.dev !== dataIdentity.dev || data.ino !== dataIdentity.ino
        || !parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== controlIdentity.dev || parent.ino !== controlIdentity.ino) fail()
      records.readWorkspaceLegacyExecutions(dataRoot)
    }
    const publish = (name, value, validate) => {
      const temporary = path.join(control, '.legacy-executions-' + randomUUID()), bytes = JSON.stringify(value) + '\n'
      if (Buffer.byteLength(bytes) > 32 * 1024 * 1024) fail()
      try {
        if (process.platform === 'win32') { native.writePrivateFile(temporary, ''); fs.writeFileSync(temporary, bytes, { flag: 'r+', flush: true }) }
        else fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx', flush: true })
        assertCurrent(); validate()
        fs.linkSync(temporary, path.join(control, name)); fs.unlinkSync(temporary); sync(control); sync(dataRoot)
      } finally { fs.rmSync(temporary, { force: true }) }
    }
    if (initial.status === 'pending') {
      const inputs = captureInputs(root, dataRoot), value = code.captureLegacyWorkspaceExecutions(inputs.entries, new Date().toISOString())
      code.createLegacyWorkspaceExecutionMatcher(value)
      publish('legacy-executions.json', value, () => { inputs.assertCurrent(); if (records.readWorkspaceLegacyExecutions(dataRoot)) fail() })
    }
    const prepared = records.readWorkspaceLegacyExecutions(dataRoot)
    if (!prepared || prepared.status !== 'prepared' || initial.status === 'prepared' && initial.sha256 !== prepared.sha256) fail()
    code.createLegacyWorkspaceExecutionMatcher(prepared.value)
    publish('legacy-executions.ready', { schema_version: 1, sha256: prepared.sha256 }, () => {
      const current = records.readWorkspaceLegacyExecutions(dataRoot)
      if (current?.status !== 'prepared' || current.sha256 !== prepared.sha256) fail()
    })
    const result = await previewWorkspaceLegacyExecutions(root, dataRoot)
    assertCurrent()
    if (result.status !== 'ready' || result.sha256 !== prepared.sha256) fail()
    return result
  } catch { fail() } finally { if (lock) releaseCliLock(lock) }
}
