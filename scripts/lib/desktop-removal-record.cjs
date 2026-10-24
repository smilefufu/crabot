// Private uninstall facts only. Neither this reader nor its digest grants
// program execution, deletion, version selection or data-recovery authority.
const fs = require('node:fs')
const path = require('node:path')
const installation = require('./desktop-installation.cjs')
const native = require('./process-identity.cjs')
const fail = () => { throw Object.assign(new Error('卸载记录无法核验，原程序、用户数据和保护已保留。请核对原安装后继续卸载或修复。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
const version = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
function readDesktopRemoval(root) {
  const own = installation.readDesktopInstallation(root), file = path.join(own.root, '.desktop-removal.json')
  let before
  try { before = fs.lstatSync(file, { bigint: true }) }
  catch (error) { if (error.code === 'ENOENT') return null; fail() }
  let fd
  try {
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4096n
      || (process.platform === 'win32' ? !native.isPrivateFile(file) : String(before.uid) !== own.record.owner || (before.mode & 0o777n) !== 0o600n)) fail()
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    if (version(fs.fstatSync(fd, { bigint: true })) !== version(before)) fail()
    const text = fs.readFileSync(fd, 'utf8'), record = JSON.parse(text), selected = record?.source_selection
    if (!fields(record, ['schema_version', 'installation_id', 'operation_id', 'source_selection', 'phase', 'proof_sha256'])
      || record.schema_version !== 1 || record.installation_id !== own.record.installation_id || !uuid(record.operation_id)
      || !fields(selected, ['schema_version', 'version', 'gui_id', 'core_id']) || selected.schema_version !== 1
      || typeof selected.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(selected.version)
      || !uuid(selected.gui_id) || typeof selected.core_id !== 'string' || !/^[a-f0-9]{64}$/.test(selected.core_id)
      || !['preparing', 'stopping', 'removing', 'completed'].includes(record.phase)
      || typeof record.proof_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.proof_sha256)) fail()
    const canonical = { schema_version: 1, installation_id: record.installation_id, operation_id: record.operation_id,
      source_selection: { schema_version: 1, version: selected.version, gui_id: selected.gui_id, core_id: selected.core_id },
      phase: record.phase, proof_sha256: record.proof_sha256 }
    if (text !== JSON.stringify(canonical) + '\n' || version(fs.fstatSync(fd, { bigint: true })) !== version(before)
      || version(fs.lstatSync(file, { bigint: true })) !== version(before)
      || JSON.stringify(installation.readDesktopInstallation(own.root).record) !== JSON.stringify(own.record)) fail()
    return canonical
  } catch { fail() } finally { if (fd !== undefined) fs.closeSync(fd) }
}
module.exports = { readDesktopRemoval }
