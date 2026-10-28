// Immutable upgrade evidence only. This grants no authority to skip a current carrier.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const native = require('./process-identity.cjs')
const fail = () => { throw Object.assign(new Error('旧执行兼容材料无法核验，原记录和维护保护已保留。'), { code: 'WORKSPACE_MAINTENANCE' }) }
function requireOwnedDataRoot(directory) {
  directory = path.resolve(directory)
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform === 'win32' ? !native.isOwnedDirectory(directory) : stat.uid !== process.getuid())) fail()
  return fs.realpathSync.native(directory)
}
const version = stat => [stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.gid, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':')
const identity = directory => {
  const stat = fs.lstatSync(directory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(directory) !== directory) fail()
  return [stat.dev, stat.ino].join(':')
}
function optional(file, limit) {
  let before
  try { before = fs.lstatSync(file, { bigint: true }) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)
    || (process.platform === 'win32' ? !native.isPrivateFile(file) : before.uid !== BigInt(process.getuid()) || (before.mode & 0o777n) !== 0o600n)) fail()
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    if (version(fs.fstatSync(fd, { bigint: true })) !== version(before)) fail()
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let offset = 0
    while (offset < bytes.length) { const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!read) break; offset += read }
    if (offset !== Number(before.size) || version(fs.fstatSync(fd, { bigint: true })) !== version(before)
      || version(fs.lstatSync(file, { bigint: true })) !== version(before)) fail()
    const content = bytes.subarray(0, offset)
    return { value: JSON.parse(content), sha256: createHash('sha256').update(content).digest('hex') }
  } finally { fs.closeSync(fd) }
}
function validateBoundary(value) {
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
  const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
  if (!value || Object.keys(value).sort().join(',') !== 'captured_at,entries,schema_version' || value.schema_version !== 1
    || !time(value.captured_at) || !Array.isArray(value.entries) || value.entries.length > 32768) fail()
  const ids = new Set()
  for (const entry of value.entries) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'evidence_sha256,incarnation_id,worker_id'
      || !text(entry.worker_id) || !text(entry.incarnation_id) || typeof entry.evidence_sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.evidence_sha256)) fail()
    const id = JSON.stringify([entry.worker_id, entry.incarnation_id])
    if (ids.has(id)) fail()
    ids.add(id)
  }
}
function readWorkspaceLegacyExecutions(dataDir) {
  try {
    const root = requireOwnedDataRoot(dataDir), rootIdentity = identity(root), control = path.join(root, 'workspace-control')
    let stat
    try { stat = fs.lstatSync(control) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    const controlIdentity = identity(control)
    if (process.platform === 'win32' ? !native.isPrivateDirectory(control) : stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) fail()
    const body = optional(path.join(control, 'legacy-executions.json'), 32 * 1024 * 1024), ready = optional(path.join(control, 'legacy-executions.ready'), 1024)
    if (rootIdentity !== identity(root) || controlIdentity !== identity(control)) fail()
    if (!body) { if (ready) fail(); return null }
    validateBoundary(body.value)
    if (ready && (!ready.value || Object.keys(ready.value).sort().join(',') !== 'schema_version,sha256'
      || ready.value.schema_version !== 1 || ready.value.sha256 !== body.sha256)) fail()
    return { status: ready ? 'ready' : 'prepared', value: body.value, sha256: body.sha256 }
  } catch { fail() }
}
module.exports = { readWorkspaceLegacyExecutions, requireOwnedDataRoot }
