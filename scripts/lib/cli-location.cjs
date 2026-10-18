// Read-only path discovery used before CLI dependency/native bootstrap. This
// grants no lifecycle/authentication authority; mutation adapters verify owners.
const { existsSync, lstatSync, readFileSync, realpathSync } = require('node:fs')
const path = require('node:path')
const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_CLI_INSTALLATION' }) }
const identifier = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function json(file) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.size > 65_536) throw new Error('Invalid installation record')
  return JSON.parse(readFileSync(file, 'utf8'))
}
// Metadata-only display lookup; installation/startup own full inventory checks.
function readCoreVersion(root) {
  const file = path.join(root, 'core-release.json')
  if (!existsSync(file) && !existsSync(path.join(root, 'core-files.json'))) return null
  try {
    const value = json(file)
    if (value.schema_version !== 1 || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.version)) throw new Error()
    return value.version
  } catch { throw new Error('Invalid sealed release version') }
}
function readCliMetadata(root) {
  try {
    const value = json(path.join(root, 'cli-installation.json'))
    if (value.schema_version !== 1 || !['user', 'system'].includes(value.scope) || !identifier(value.launcher_sha256)
      || Object.keys(value).some(key => !['schema_version', 'scope', 'launcher_sha256'].includes(key))) throw new Error()
    return value
  } catch { fail('CLI 安装记录无法校验，请保留当前目录并重新安装。') }
}
function readCliSelection(root) {
  readCliMetadata(root)
  try {
    const file = path.join(root, 'current-core'), stat = lstatSync(file)
    if (!stat.isFile() || stat.size > 65) throw new Error()
    const text = readFileSync(file, 'utf8')
    if (!identifier(text.trim()) || text !== text.trim() + '\n') throw new Error()
    return text.trim()
  } catch (error) { if (error.code === 'ENOENT') return null; fail('CLI 版本选择记录损坏，请保留数据并重新安装。') }
}
function locateCliInstallation(coreRoot) {
  coreRoot = realpathSync(coreRoot)
  const releases = path.dirname(coreRoot), root = path.dirname(releases)
  if (path.basename(releases) !== 'releases' || !existsSync(path.join(root, 'cli-installation.json'))) return null
  try {
    const record = readCliMetadata(root), id = path.basename(coreRoot), release = json(path.join(coreRoot, 'core-release.json'))
    if (!identifier(id) || release.inventory_sha256 !== id) throw new Error()
    return { root, coreRoot, id, scope: record.scope, selected: readCliSelection(root) === id }
  } catch { fail('CLI 核心与安装记录不一致，请使用当前安装的管理命令。') }
}
function assertSelectedCli(coreRoot) {
  const installation = locateCliInstallation(coreRoot)
  if (installation && !installation.selected) fail('此核心已不是当前版本，请使用已安装的 crabot 命令；未运行旧版。')
  return installation
}
module.exports = { readCoreVersion, readCliMetadata, readCliSelection, locateCliInstallation, assertSelectedCli }
