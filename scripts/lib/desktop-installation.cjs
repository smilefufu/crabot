// Read-only desktop installation authority. No directory creation, migration or
// service lifecycle occurs here; installers and maintenance own those actions.
const fs = require('node:fs')
const path = require('node:path')
const identity = require('./process-identity.cjs')
const fail = () => { throw Object.assign(new Error('Crabot 安装定位或版本对无法核验；请保留原目录并修复安装，未创建空实例。'), { code: 'CRABOT_DESKTOP_INSTALLATION' }) }
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value)
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
function present(file) {
  try { fs.lstatSync(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
function directory(file, managedRoot = false) {
  const stat = fs.lstatSync(file)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !identity.isOwnedDirectory(file)) fail()
  // Existing roots can retain legacy read/traverse access. Private records and
  // sockets have their own checks; only creation requires an exact private mode.
  if (managedRoot && (process.platform === 'win32' ? !identity.isExistingDataDirectory(file)
    : (stat.mode & 0o700) !== 0o700 || (stat.mode & 0o022) !== 0)) fail()
  return stat
}
function json(file, privateFile = false) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65_536
    || (process.platform === 'win32' ? !identity.isOwnedFile(file) : String(stat.uid) !== identity.inspectProcess(process.pid).owner)
    || privateFile && (process.platform === 'win32' ? !identity.isPrivateFile(file) : (stat.mode & 0o777) !== 0o600)) fail()
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function readDesktopInstallation(root) {
  try {
    root = path.resolve(root)
    directory(root, true)
    const stat = fs.lstatSync(root, { bigint: true }), canonical = fs.realpathSync.native(root)
    const record = json(path.join(root, 'desktop-installation.json'), true)
    const external = record.schema_version === 2
    if (!keys(record, ['schema_version', 'installation_id', 'owner', 'install_root', 'root_identity', 'paths', ...(external ? ['data_dir', 'data_identity'] : [])])
      || ![1, 2].includes(record.schema_version) || !uuid(record.installation_id) || record.owner !== identity.inspectProcess(process.pid).owner
      || record.install_root !== canonical || !keys(record.root_identity, ['dev', 'ino'])
      || record.root_identity.dev !== String(stat.dev) || record.root_identity.ino !== String(stat.ino)
      || !keys(record.paths, external ? ['app', 'core', 'bin'] : ['app', 'core', 'data', 'bin']) || record.paths.app !== 'app/releases' || record.paths.core !== 'releases'
      || !external && record.paths.data !== 'data' || record.paths.bin !== 'bin'
      || present(path.join(root, 'current-core')) || present(path.join(root, 'cli-installation.json'))) fail()
    for (const name of ['app', 'app/releases', 'releases', 'bin']) directory(path.join(root, name))
    const dataDir = external ? record.data_dir : path.join(canonical, 'data')
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) fail()
    directory(dataDir, true)
    if (external) {
      const dataStat = fs.lstatSync(dataDir, { bigint: true })
      if (fs.realpathSync.native(dataDir) !== dataDir || !keys(record.data_identity, ['dev', 'ino'])
        || record.data_identity.dev !== String(dataStat.dev) || record.data_identity.ino !== String(dataStat.ino)) fail()
    }
    return { root: canonical, record, dataDir, command: path.join(canonical, 'bin', process.platform === 'win32' ? 'crabot.exe' : 'crabot') }
  } catch { fail() }
}
function readPairSelection(installation) {
  const selection = json(path.join(installation.root, 'current-release.json'), true)
  if (!keys(selection, ['schema_version', 'version', 'gui_id', 'core_id']) || selection.schema_version !== 1
    || !version(selection.version) || !uuid(selection.gui_id) || !digest(selection.core_id)) fail()
  const serialized = JSON.stringify({ schema_version: 1, version: selection.version, gui_id: selection.gui_id, core_id: selection.core_id }) + '\n'
  if (Buffer.byteLength(serialized) > 1024 || fs.readFileSync(path.join(installation.root, 'current-release.json'), 'utf8') !== serialized) fail()
  return selection
}
// Read-only maintenance reference. This has no executable or code-loading context.
function readDesktopPairReference(root) {
  try {
    const installation = readDesktopInstallation(root), selection = readPairSelection(installation)
    return { installation_id: installation.record.installation_id, install_root: installation.root, data_dir: installation.dataDir, selection }
  } catch { fail() }
}
function assertDesktopRemovalAllowsStart(root) {
  if (present(path.join(root, '.desktop-removal.json'))) throw Object.assign(new Error('Crabot 正在卸载或等待恢复；请继续卸载或使用离线安装器修复。用户数据已保留，未启动实例。'), { code: 'CRABOT_DESKTOP_REMOVAL_PENDING' })
}
function readDesktopSelection(root) {
  try {
    const installation = readDesktopInstallation(root)
    assertDesktopRemovalAllowsStart(installation.root)
    if (present(path.join(installation.root, '.desktop-installing.json'))) fail()
    const selection = readPairSelection(installation)
    const guiRoot = path.join(installation.root, 'app/releases', selection.gui_id)
    const coreRoot = path.join(installation.root, 'releases', selection.core_id)
    directory(guiRoot); directory(coreRoot)
    const resources = process.platform === 'darwin' ? path.join(guiRoot, 'Crabot.app/Contents/Resources') : path.join(guiRoot, 'resources')
    const executable = process.platform === 'darwin' ? path.join(guiRoot, 'Crabot.app/Contents/MacOS/Crabot')
      : path.join(guiRoot, process.platform === 'win32' ? 'Crabot.exe' : 'crabot-desktop')
    // Validate every ancestor before following either GUI resource or executable.
    for (const relative of process.platform === 'darwin' ? ['Crabot.app', 'Crabot.app/Contents', 'Crabot.app/Contents/Resources', 'Crabot.app/Contents/MacOS'] : ['resources']) directory(path.join(guiRoot, relative))
    const pinned = json(path.join(resources, 'desktop-release.json'))
    if (!keys(pinned, ['schema_version', 'version', 'gui_id', 'core_id']) || Object.keys(selection).some(key => pinned[key] !== selection[key])) fail()
    const release = json(path.join(coreRoot, 'core-release.json'))
    if (release.schema_version !== 1 || release.inventory_sha256 !== selection.core_id || release.version !== selection.version
      || release.platform !== process.platform || release.arch !== process.arch) fail()
    const entry = fs.lstatSync(executable)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1
      || (process.platform === 'win32' ? !identity.isOwnedFile(executable) : String(entry.uid) !== identity.inspectProcess(process.pid).owner)) fail()
    return { ...installation, selection, coreRoot, guiRoot, resources, executable: fs.realpathSync.native(executable) }
  } catch (error) { if (error.code === 'CRABOT_DESKTOP_REMOVAL_PENDING') throw error; fail() }
}
function locateDesktopCore(coreRoot) {
  coreRoot = fs.realpathSync.native(coreRoot)
  const releases = path.dirname(coreRoot), root = path.dirname(releases)
  if (path.basename(releases) !== 'releases') return null
  if (!present(path.join(root, 'desktop-installation.json')) && !present(path.join(root, 'current-release.json'))) {
    if (present(path.join(coreRoot, 'desktop-host.json')) && json(path.join(coreRoot, 'desktop-host.json')).schema_version === 2) fail()
    return null
  }
  const selected = readDesktopSelection(root)
  if (selected.coreRoot !== coreRoot) fail()
  return selected
}
function locateDesktopGui(resources) {
  resources = fs.realpathSync.native(resources)
  const guiRoot = path.resolve(resources, process.platform === 'darwin' ? '../../..' : '..')
  const root = path.resolve(guiRoot, '../../..')
  const registered = present(path.join(root, 'desktop-installation.json')) || present(path.join(root, 'current-release.json'))
  if (!present(path.join(resources, 'desktop-release.json')) && !registered) return null
  const selected = readDesktopSelection(root)
  if (fs.realpathSync.native(resources) !== selected.resources || guiRoot !== selected.guiRoot) fail()
  return selected
}
// Maintenance location only. No Core path, environment setup, startup admission
// or permission to ignore an existing job is returned by this reader.
function locateDesktopRemovalGui(resources, pinText) {
  try {
    resources = fs.realpathSync.native(resources)
    const guiRoot = path.resolve(resources, process.platform === 'darwin' ? '../../..' : '..')
    const own = readDesktopInstallation(path.resolve(guiRoot, '../../..')), reference = readDesktopPairReference(own.root)
    if (reference.installation_id !== own.record.installation_id || reference.data_dir !== own.dataDir
      || typeof pinText !== 'string' || pinText !== JSON.stringify(reference.selection) + '\n'
      || guiRoot !== path.join(own.root, 'app/releases', reference.selection.gui_id)) fail()
    directory(guiRoot)
    const expectedResources = path.join(guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources')
    if (resources !== expectedResources) fail()
    const declaration = json(path.join(resources, 'desktop-release.json'))
    if (!keys(declaration, ['schema_version', 'version', 'gui_id', 'core_id'])
      || JSON.stringify(declaration) + '\n' !== pinText) fail()
    const executable = path.join(guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : process.platform === 'win32' ? 'Crabot.exe' : 'crabot-desktop')
    const stat = fs.lstatSync(executable)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (process.platform === 'win32' ? !identity.isOwnedFile(executable) : String(stat.uid) !== own.record.owner)) fail()
    return { ...own, reference, guiRoot, resources, executable: fs.realpathSync.native(executable) }
  } catch { fail() }
}
// The caller reads this pin from its own protected ASAR before importing Core.
// Resources metadata remains a locator, never a replacement for that pin.
function locatePinnedDesktopGui(resources, pinText) {
  const selected = locateDesktopGui(resources)
  if (!selected || typeof pinText !== 'string' || pinText !== JSON.stringify(selected.selection) + '\n') fail()
  return selected
}
function applyDesktopEnvironment(installation, env = process.env) {
  try {
    if (!installation || typeof installation.root !== 'string' || !path.isAbsolute(installation.root)
      || installation.dataDir !== readDesktopInstallation(installation.root).dataDir || !digest(installation.selection?.core_id)
      || installation.coreRoot !== path.join(installation.root, 'releases', installation.selection.core_id)
      || typeof installation.executable !== 'string' || !path.isAbsolute(installation.executable)) fail()
    if (env.CRABOT_DEV === 'true' || Number(env.CRABOT_PORT_OFFSET || 0) !== 0
      || env.DATA_DIR && fs.realpathSync.native(path.resolve(env.DATA_DIR)) !== installation.dataDir) fail()
  } catch { fail() }
  env.DATA_DIR = installation.dataDir
  env.CRABOT_HOME = installation.coreRoot
  env.CRABOT_PORT_OFFSET = '0'
  env.CRABOT_DEV = 'false'
  env.CRABOT_PRODUCT_REQUIRED = '1'
}
module.exports = { assertDesktopRemovalAllowsStart, readDesktopInstallation, readDesktopPairReference, readDesktopSelection, locateDesktopCore, locateDesktopGui, locateDesktopRemovalGui, locatePinnedDesktopGui, applyDesktopEnvironment }
