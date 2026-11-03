// Per-user data locator for the system-owned DEB. It never selects a program version.
const fs = require('node:fs')
const path = require('node:path')
const { homedir } = require('node:os')
const { randomUUID } = require('node:crypto')
const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_UBUNTU_APP_BINDING' }) }
const xdg = (env, key, fallback) => env[key] && path.isAbsolute(env[key]) ? env[key] : fallback
const bindingFile = ({ home = homedir(), env = process.env } = {}) => path.join(xdg(env, 'XDG_CONFIG_HOME', path.join(home, '.config')), 'crabot/desktop-binding.json')
const defaultDataDir = ({ home = homedir(), env = process.env } = {}) => path.join(xdg(env, 'XDG_DATA_HOME', path.join(home, '.local/share')), 'crabot/data')
function ubuntuAppForCore(coreRoot) {
  const resources = path.resolve(coreRoot, '..'), type = path.join(resources, 'package-type')
  let stat
  try { stat = fs.lstatSync(type) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!stat.isFile() || stat.size > 64 || fs.readFileSync(type, 'utf8').trim() !== 'deb') fail('桌面安装类型损坏，请重新安装完整包。')
  const hostFile = path.join(coreRoot, 'desktop-host.json'), hostStat = fs.lstatSync(hostFile)
  if (!hostStat.isFile() || hostStat.size > 4096) fail('DEB内置核心位置不兼容，请重新安装完整包。')
  const host = JSON.parse(fs.readFileSync(hostFile, 'utf8'))
  if (host.schema_version !== 1 || host.platform !== 'linux' || host.arch !== 'x64'
    || Object.keys(host).sort().join(',') !== 'arch,platform,schema_version'
    || path.basename(coreRoot) !== 'core' || path.basename(resources) !== 'resources') fail('DEB内置核心位置不兼容，请重新安装完整包。')
  return fs.realpathSync(path.dirname(resources))
}
function readUbuntuAppBinding(options = {}) {
  const file = bindingFile(options)
  let stat
  try { stat = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384
    || stat.uid !== process.getuid() || stat.mode & 0o077) fail('数据位置记录无法核验，原数据保留。')
  let value
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail('数据位置记录损坏，未创建空实例。') }
  const fields = ['schema_version', 'owner', 'core_root', 'data_dir', 'source_root']
  if (value?.schema_version !== 1 || value.owner !== String(process.getuid()) || Object.keys(value).some(key => !fields.includes(key))
    || ['core_root', 'data_dir', ...(value.source_root === undefined ? [] : ['source_root'])]
      .some(key => typeof value[key] !== 'string' || !path.isAbsolute(value[key]) || /[\r\n\0]/.test(value[key]))) fail('数据位置记录不兼容，原数据保留。')
  return value
}
function requireUbuntuAppBinding(options) {
  const management = require('./desktop-management.cjs')
  const value = readUbuntuAppBinding(options)
  if (!value || value.core_root !== fs.realpathSync(options.coreRoot)) fail('请先打开 Crabot 确认数据位置，未创建另一实例。')
  management.requireExistingDataRoot(value.data_dir)
  return value
}
function writeUbuntuAppBinding({ coreRoot, dataDir, sourceRoot, ...options }) {
  const management = require('./desktop-management.cjs')
  const program = ubuntuAppForCore(coreRoot)
  if (!program) fail('当前核心不属于DEB桌面安装。')
  coreRoot = fs.realpathSync(coreRoot); dataDir = management.requireExistingDataRoot(dataDir)
  if (/[\r\n\0]/.test(coreRoot + dataDir + (sourceRoot ?? ''))) fail('数据位置不能包含换行或空字符，未保存绑定。')
  const relative = path.relative(program, dataDir)
  if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) fail('请选择系统程序目录之外的数据位置。')
  const file = bindingFile(options), parent = path.dirname(file)
  if (fs.existsSync(parent)) management.requireExistingDataRoot(parent); else management.ensurePrivateDataRoot(parent)
  readUbuntuAppBinding(options)
  const value = { schema_version: 1, owner: String(process.getuid()), core_root: coreRoot, data_dir: dataDir,
    ...(sourceRoot ? { source_root: fs.realpathSync(sourceRoot) } : {}) }
  const temporary = file + '.tmp-' + randomUUID()
  try { fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file) }
  finally { try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  return value
}
function applyUbuntuAppEnvironment(coreRoot, options = {}) {
  if (process.platform !== 'linux' || !ubuntuAppForCore(coreRoot)) return null
  const management = require('./desktop-management.cjs')
  const value = requireUbuntuAppBinding({ ...options, coreRoot }), env = options.env ?? process.env
  if (env.DATA_DIR && fs.realpathSync(env.DATA_DIR) !== value.data_dir || env.CRABOT_DEV === 'true' || Number(env.CRABOT_PORT_OFFSET || 0) !== 0) fail('命令环境与桌面数据位置冲突，未创建另一实例。')
  if (!management.readDesktopManagement(value.data_dir)) fail('数据准备尚未完成，请先打开GUI继续；未启动半成品副本。')
  env.DATA_DIR = value.data_dir; env.CRABOT_HOME = value.core_root
  env.CRABOT_PORT_OFFSET = '0'; env.CRABOT_PRODUCT_REQUIRED = '1'
  return value
}
module.exports = { bindingFile, defaultDataDir, ubuntuAppForCore, readUbuntuAppBinding, requireUbuntuAppBinding, writeUbuntuAppBinding, applyUbuntuAppEnvironment }
