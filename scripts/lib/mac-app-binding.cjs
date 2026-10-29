// Local locator for the self-contained Mac App only. Source/system CLI never reads it.
const fs = require('node:fs')
const path = require('node:path')
const { homedir } = require('node:os')
const { randomUUID } = require('node:crypto')
const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_MAC_APP_BINDING' }) }
const bindingFile = home => path.join(home, 'Library/Application Support/Crabot/desktop-binding.json')
function macAppForCore(coreRoot) {
  const file = path.join(coreRoot, 'desktop-host.json')
  if (!fs.existsSync(file)) return null
  const host = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (host.schema_version !== 1 || host.platform !== 'darwin') return null
  const app = path.resolve(coreRoot, '../../..')
  if (!app.endsWith('.app') || path.join(app, 'Contents/Resources/core') !== path.resolve(coreRoot)) fail('App内核心位置不兼容，请重新获取完整App。')
  return fs.realpathSync(app)
}
function readMacAppBinding({ home = homedir() } = {}) {
  const file = bindingFile(home)
  let stat
  try { stat = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384
    || stat.uid !== process.getuid() || (stat.mode & 0o077)) fail('数据位置记录无法核验；原数据保留，请检查该记录。')
  let value
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail('数据位置记录已损坏；未创建空实例。') }
  if (value.schema_version !== 1 || value.owner !== String(process.getuid())
    || typeof value.app_path !== 'string' || typeof value.data_dir !== 'string'
    || !path.isAbsolute(value.app_path) || !path.isAbsolute(value.data_dir)
    || /[\r\n\0]/.test(value.app_path + value.data_dir)
    || Object.keys(value).some(key => !['schema_version', 'owner', 'app_path', 'data_dir'].includes(key))) fail('数据位置记录不兼容；原数据保留。')
  return value
}
function writeMacAppBinding({ appPath, dataDir, home = homedir() }) {
  const management = require('./desktop-management.cjs')
  appPath = fs.realpathSync(appPath); dataDir = management.requireExistingDataRoot(dataDir)
  if (!appPath.endsWith('.app') || dataDir === appPath || dataDir.startsWith(appPath + path.sep)) fail('数据目录必须位于App之外。')
  const file = bindingFile(home), parent = path.dirname(file)
  if (fs.existsSync(parent)) management.requireExistingDataRoot(parent)
  else management.ensurePrivateDataRoot(parent)
  readMacAppBinding({ home })
  const value = { schema_version: 1, owner: String(process.getuid()), app_path: appPath, data_dir: dataDir }
  const temporary = file + '.tmp-' + randomUUID()
  try {
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally { try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  return value
}
function applyMacAppEnvironment(coreRoot, { home = homedir(), env = process.env } = {}) {
  if (process.platform !== 'darwin') return null
  const app = macAppForCore(coreRoot)
  if (!app) return null
  const value = readMacAppBinding({ home })
  if (!value || value.app_path !== app) fail('请先打开Crabot App确认数据位置；App移动后也请先打开一次以修复入口。')
  const data = require('./desktop-management.cjs').requireExistingDataRoot(value.data_dir)
  if (env.DATA_DIR && fs.realpathSync(env.DATA_DIR) !== data || env.CRABOT_DEV === 'true' || Number(env.CRABOT_PORT_OFFSET || 0) !== 0) fail('命令环境与App数据位置冲突，未创建另一实例。')
  env.DATA_DIR = data; env.CRABOT_HOME = fs.realpathSync(coreRoot)
  env.CRABOT_PORT_OFFSET = '0'; env.CRABOT_PRODUCT_REQUIRED = '1'
  return value
}
module.exports = { bindingFile, macAppForCore, readMacAppBinding, writeMacAppBinding, applyMacAppEnvironment }
