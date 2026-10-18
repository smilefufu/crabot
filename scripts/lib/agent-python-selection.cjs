'use strict'
// Private instance references only. No environment is created or repaired while
// resolving a selection, and no missing/damaged selection falls back implicitly.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const identity = require('./process-identity.cjs')
const management = require('./desktop-management.cjs')
const selectionName = 'agent-python.json'
const invalid = () => { throw Object.assign(new Error('已选择的Python环境或完成凭据无法核验；原环境已保留，请从接管诊断恢复。'), { code: 'CRABOT_PYTHON_ENV_SELECTION_INVALID' }) }
function privateDocument(file) {
  let fd
  try {
    const before = fs.lstatSync(file)
    if (!before.isFile() || before.isSymbolicLink() || before.size > 65536) invalid()
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const stat = fs.fstatSync(fd)
    const owned = process.platform === 'win32' ? identity.isPrivateFile(file)
      : String(stat.uid) === identity.inspectProcess(process.pid).owner && (stat.mode & 0o777) === 0o600
    if (!stat.isFile() || !owned || stat.nlink !== 1 || before.ino !== stat.ino || before.dev !== stat.dev || stat.size > 65536) invalid()
    const buffer = Buffer.alloc(65537)
    let size = 0
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, size)
      if (!count) break
      size += count
    }
    if (size > 65536) invalid()
    const bytes = buffer.subarray(0, size)
    return { value: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') }
  } catch { invalid() }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}
function verifyAgentEnvironmentReference(record) {
  if (!record || record.schema_version !== 1 || Object.keys(record).length !== 5
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(record.id ?? '') || record.directory !== 'agent-environments/' + record.id
    || !/^[a-f0-9]{64}$/.test(record.receipt_sha256 ?? '') || !/^[a-f0-9]{64}$/.test(record.source_fingerprint ?? '')) invalid()
  return record
}
function verifyAgentEnvironmentCandidate(dataDir, record) {
  try {
    verifyAgentEnvironmentReference(record)
    dataDir = management.requirePrivateDataRoot(dataDir)
    const container = path.join(dataDir, 'agent-environments')
    if (management.requirePrivateDataRoot(container) !== container) invalid()
    const directory = path.join(container, record.id)
    if (management.requirePrivateDataRoot(directory) !== directory) invalid()
    const receipt = privateDocument(path.join(directory, 'legacy-rebuild.json'))
    if (receipt.sha256 !== record.receipt_sha256 || receipt.value.schema_version !== 1 || receipt.value.kind !== 'legacy-python-rebuild'
      || receipt.value.id !== record.id || receipt.value.source_fingerprint !== record.source_fingerprint || !Array.isArray(receipt.value.pins)
      || !/^\d+\.\d+\.\d+$/.test(receipt.value.python_version ?? '')) invalid()
    const ready = privateDocument(path.join(directory, '.crabot-runtime.json')).value
    if (ready.schema_version !== 1 || !/^[a-f0-9]{24}$/.test(ready.base_id ?? '') || ready.python_version !== receipt.value.python_version) invalid()
    return { record, directory, receipt: receipt.value }
  } catch { invalid() }
}
function readAgentEnvironmentReference(dataDir) {
  const file = path.join(dataDir, selectionName)
  try { fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; invalid() }
  dataDir = management.requirePrivateDataRoot(dataDir)
  return verifyAgentEnvironmentReference(privateDocument(path.join(dataDir, selectionName)).value)
}
function readAgentEnvironmentSelection(dataDir) {
  const record = readAgentEnvironmentReference(dataDir)
  return record ? verifyAgentEnvironmentCandidate(dataDir, record) : null
}
module.exports = { selectionName, readAgentEnvironmentReference, readAgentEnvironmentSelection, verifyAgentEnvironmentCandidate, verifyAgentEnvironmentReference }
