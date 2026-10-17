const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const identity = require('./process-identity.cjs')

const markerName = 'desktop-managed.json'
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }

function ensurePrivateDataRoot(directory) {
  directory = path.resolve(directory)
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 })
    try {
      if (process.platform === 'win32') identity.createPrivateDirectory(directory)
      else fs.mkdirSync(directory, { mode: 0o700 })
    } catch (error) { if (!fs.existsSync(directory)) throw error }
  }
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CRABOT_DATA_NOT_PRIVATE', '数据目录不是可验证的本机目录。')
  const privateDirectory = process.platform === 'win32' ? identity.isPrivateDirectory(directory)
    : String(stat.uid) === identity.inspectProcess(process.pid).owner && (stat.mode & 0o777) === 0o700
  if (!privateDirectory) fail('CRABOT_DATA_NOT_PRIVATE', '数据目录的访问权限需要检查；未修改已有权限或数据。')
  return fs.realpathSync(directory)
}

function readDesktopManagement(dataDir) {
  const file = path.join(dataDir, markerName)
  if (!fs.existsSync(file)) return null
  const marker = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (marker.schema_version !== 1 || marker.install_kind !== 'desktop'
    || !['127.0.0.1', '::1', '0.0.0.0'].includes(marker.admin_listen_host)
    || Object.keys(marker).some(key => !['schema_version', 'install_kind', 'admin_listen_host'].includes(key))) {
    fail('CRABOT_DESKTOP_STATE_INVALID', '桌面管理记录不兼容，请查看诊断。')
  }
  return marker
}

// Caller holds the common lifecycle lock. Existing business data requires explicit P6 takeover.
function initializeDesktopManagement(dataDir) {
  const existing = readDesktopManagement(dataDir)
  if (existing) return existing
  const allowed = new Set(['cli.lock', '.DS_Store', 'desktop-profile'])
  if (fs.readdirSync(dataDir).some(name => !allowed.has(name))) fail('CRABOT_DESKTOP_TAKEOVER_REQUIRED', '发现已有 Crabot 数据，请先检查并确认接管。')
  const marker = { schema_version: 1, install_kind: 'desktop', admin_listen_host: '127.0.0.1' }
  const target = path.join(dataDir, markerName), temporary = target + '.tmp-' + randomUUID()
  let created = false
  try {
    const text = JSON.stringify(marker) + '\n'
    if (process.platform === 'win32') identity.writePrivateFile(temporary, text)
    else fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 })
    created = true
    fs.linkSync(temporary, target) // never replace another initializer's marker
  } finally { if (created) fs.rmSync(temporary, { force: true }) }
  return marker
}

module.exports = { ensurePrivateDataRoot, readDesktopManagement, initializeDesktopManagement }
