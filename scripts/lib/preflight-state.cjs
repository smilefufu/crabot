// Private startup-control receipt, separate from business/module state.
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const identity = require('./process-identity.cjs')
const filename = 'startup-preflight.json'
const failure = (code = 'CRABOT_PREFLIGHT_INTERRUPTED') => Object.assign(new Error('启动检查尚未确认结束；已保留检查记录，未继续修改数据。'), { code })
const validProcess = value => value && Number.isSafeInteger(value.pid) && value.pid > 0
  && ['owner', 'started', 'executable'].every(key => typeof value[key] === 'string' && value[key])
function read(dataDir) {
  const file = path.join(dataDir, filename)
  let stat
  try { stat = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const privateFile = process.platform === 'win32' ? identity.isPrivateFile(file)
    : String(stat.uid) === identity.inspectProcess(process.pid).owner && (stat.mode & 0o777) === 0o600
  if (!stat.isFile() || stat.size > 8192 || stat.nlink > 1 || !privateFile || fs.realpathSync(file) !== path.join(fs.realpathSync(dataDir), filename)) throw failure()
  let record
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw failure() }
  if (record?.schema_version !== 1 || record.kind !== 'orphan_preflight' || !/^[a-f0-9-]{36}$/.test(record.id)
    || !/^[a-f0-9-]{36}$/.test(record.lock_token) || !validProcess(record.owner)
    || record.owner.owner !== identity.inspectProcess(process.pid).owner || record.child !== null && !validProcess(record.child)
    || record.child && record.child.owner !== record.owner.owner) throw failure()
  return record
}
function publish(dataDir, record, previousId = null) {
  const current = read(dataDir)
  if ((current?.id ?? null) !== previousId) throw failure()
  const target = path.join(dataDir, filename), temporary = target + '.' + randomUUID()
  try {
    const bytes = JSON.stringify(record) + '\n'
    if (process.platform === 'win32') { identity.writePrivateFile(temporary, ''); fs.writeFileSync(temporary, bytes, { flush: true }) }
    else fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true })
    if ((read(dataDir)?.id ?? null) !== previousId) throw failure()
    if (previousId === null) fs.linkSync(temporary, target)
    else fs.renameSync(temporary, target)
    if (process.platform !== 'win32') { const fd = fs.openSync(dataDir, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
  } finally { fs.rmSync(temporary, { force: true }) }
}
function acknowledge(dataDir, id) {
  const record = read(dataDir)
  if (record?.id !== id || !identity.sameProcess(record.owner, identity.inspectProcess(process.pid))
    || record.child && identity.sameProcess(record.child, identity.inspectProcess(record.child.pid))) throw failure()
  fs.unlinkSync(path.join(dataDir, filename))
}
function assertSettled(dataDir, recoveryId) {
  const record = read(dataDir)
  if (!record) return
  if (record.child && identity.sameProcess(record.child, identity.inspectProcess(record.child.pid))) throw failure('CRABOT_PREFLIGHT_BUSY')
  if (recoveryId === record.id) return // Startup will rerun the fixed orphan check under a fresh receipt.
  throw failure()
}
module.exports = { read, publish, acknowledge, assertSettled, failure }
