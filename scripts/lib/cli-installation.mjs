// Standalone CLI installation mechanics only. The calling installer/upgrader
// owns user confirmation, instance shutdown, scoped backup and migrations.
// Payloads are immutable; neither selection nor data lives inside their tree.
import { promises as fs, constants, realpathSync, existsSync, readFileSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'
import { acquireCliLock, releaseCliLock, cliLockToken } from './cli-lock.mjs'
import { verifyCoreRelease } from './core-release.mjs'
import { inspectInstance } from './instance-runtime.mjs'

const metadataName = 'cli-installation.json', selectorName = 'current-core'
const launcherName = process.platform === 'win32' ? 'crabot.exe' : 'crabot'
const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_CLI_INSTALLATION' }) }
const identifier = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function digest(file) { return createHash('sha256').update(await fs.readFile(file)).digest('hex') }
function metadata(root) {
  try {
    const file = path.join(root, metadataName), stat = lstatSync(file)
    if (!stat.isFile() || stat.size > 65_536) throw new Error()
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (value.schema_version !== 1 || !['user', 'system'].includes(value.scope) || !identifier(value.launcher_sha256)
      || Object.keys(value).some(key => !['schema_version', 'scope', 'launcher_sha256'].includes(key))) throw new Error()
    return value
  } catch { fail('CLI 安装记录无法校验，请保留当前目录并重新安装。') }
}
export function readCliSelection(root) {
  try {
    const file = path.join(root, selectorName), stat = identity.isOwnedDirectory(root)
    // Shared system code is root-owned and intentionally readable by employees.
    const record = metadata(root)
    if (record.scope === 'user' && !stat) throw new Error()
    const selected = lstatSync(file)
    if (!selected.isFile() || selected.size > 65) throw new Error()
    const text = readFileSync(file, 'utf8')
    if (!identifier(text.trim()) || text !== text.trim() + '\n') throw new Error()
    return text.trim()
  } catch (error) { if (error.code === 'ENOENT') return null; fail('CLI 版本选择记录损坏，请保留数据并重新安装。') }
}
export function locateCliInstallation(coreRoot) {
  coreRoot = realpathSync(coreRoot)
  const releases = path.dirname(coreRoot), root = path.dirname(releases)
  if (path.basename(releases) !== 'releases' || !existsSync(path.join(root, metadataName))) return null
  const record = metadata(root), id = path.basename(coreRoot)
  if (!identifier(id)) fail('CLI 核心目录无法核验。')
  return { root, coreRoot, id, scope: record.scope, selected: readCliSelection(root) === id }
}
async function publish(root, name, text, scope, previous) {
  const file = path.join(root, name), temporary = file + '.tmp-' + randomUUID()
  const current = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (current !== previous) fail('CLI 安装在操作期间发生变化，请重新检查后重试。')
  try {
    if (process.platform === 'win32') identity.writePrivateFile(temporary, text)
    else await fs.writeFile(temporary, text, { flag: 'wx', mode: scope === 'system' ? 0o644 : 0o600, flush: true })
    if (previous === null) await fs.link(temporary, file)
    else await fs.rename(temporary, file)
    if (process.platform !== 'win32') {
      const directory = await fs.open(root, 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally { await fs.rm(temporary, { force: true }) }
}
function authority(scope) {
  if (!['user', 'system'].includes(scope) || scope === 'system' && (process.platform !== 'linux' || process.getuid?.() !== 0)) {
    fail('共享 CLI 安装只能由 Linux 系统管理员更新。')
  }
}
async function rootDirectory(root, scope) {
  authority(scope)
  await fs.mkdir(root, { recursive: true, mode: scope === 'system' ? 0o755 : 0o700 })
  if (!identity.isOwnedDirectory(root) || (await fs.lstat(root)).isSymbolicLink()) fail('CLI 安装目录归属无法核验，未替换入口。')
  for (const name of ['.git', 'cli.mjs', 'core-release.json']) if (await present(path.join(root, name))) fail('发现原有代码安装，请通过已有升级或桌面接管流程迁移，未覆盖原安装。')
  if (scope === 'user') management.ensurePrivateDataRoot(root)
  return realpathSync(root)
}

export async function prepareCliPayload({ sourceRoot, installRoot, scope = 'user' }) {
  sourceRoot = await fs.realpath(sourceRoot)
  if (await present(path.join(sourceRoot, 'desktop-host.json'))) fail('桌面已包含完整核心，请从桌面安装管理命令，不复制另一套环境。')
  const release = await verifyCoreRelease(sourceRoot)
  installRoot = await rootDirectory(path.resolve(installRoot), scope)
  const relative = path.relative(sourceRoot, installRoot)
  if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) fail('CLI 安装目录不能位于待复制的核心中。')
  const lock = await acquireCliLock(installRoot, 'prepare-cli-payload')
  const id = release.inventory_sha256, target = path.join(installRoot, 'releases', id)
  let pending
  try {
    const file = path.join(installRoot, metadataName), prior = await present(file)
    if (!prior) {
      if (await present(path.join(installRoot, 'bin'))) fail('已有未识别的命令目录，未覆盖。')
      const launcher = path.join(sourceRoot, 'bin', launcherName)
      const record = { schema_version: 1, scope, launcher_sha256: await digest(launcher) }
      await publish(installRoot, metadataName, JSON.stringify(record) + '\n', scope, null)
    }
    const record = metadata(installRoot)
    if (record.scope !== scope) fail('不能在原有 CLI 安装上更改 user/system 管理范围。')
    const bin = path.join(installRoot, 'bin'), launcher = path.join(bin, launcherName)
    await fs.mkdir(bin, { mode: scope === 'system' ? 0o755 : 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    if (!identity.isOwnedDirectory(bin) || (await fs.lstat(bin)).isSymbolicLink()) fail('命令目录归属无法核验。')
    if (!await present(launcher)) {
      const original = path.join(sourceRoot, 'bin', launcherName)
      if (await digest(original) !== record.launcher_sha256) fail('初始启动器尚未安装完整，请用原安装包重试。')
      await fs.copyFile(original, launcher, constants.COPYFILE_EXCL)
      if (process.platform !== 'win32') await fs.chmod(launcher, 0o755)
    }
    if (!(await fs.lstat(launcher)).isFile() || await digest(launcher) !== record.launcher_sha256) fail('已有启动器已改变，未覆盖。')
    const releases = path.dirname(target)
    await fs.mkdir(releases, { mode: 0o755 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    if (!identity.isOwnedDirectory(releases) || (await fs.lstat(releases)).isSymbolicLink()) fail('版本目录归属无法核验。')
    if (!await present(target)) {
      pending = path.join(releases, '.preparing-' + randomUUID())
      await fs.cp(sourceRoot, pending, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, filter: () => true })
      await verifyCoreRelease(pending, { version: release.version })
      await fs.rename(pending, target); pending = undefined
    }
    const targetStat = await fs.lstat(target)
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) fail('核心版本目录被重定向，未切换。')
    await verifyCoreRelease(target, { version: release.version })
    return { installRoot, coreRoot: target, id, version: release.version, scope, command: launcher }
  } finally {
    if (pending) await fs.rm(pending, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    releaseCliLock(lock)
  }
}

export async function selectCliPayload(prepared, { expected = null, dataDir } = {}) {
  const { installRoot, coreRoot, id, scope } = prepared
  authority(scope)
  if (scope === 'user' && (!dataDir || !cliLockToken(path.resolve(dataDir, 'cli.lock')) || inspectInstance(dataDir).state !== 'stopped')) fail('CLI 版本切换前必须持有实例操作锁并确认停止。')
  const lock = await acquireCliLock(installRoot, 'select-cli-payload')
  try {
    const record = metadata(installRoot)
    if (record.scope !== scope || !identifier(id) || realpathSync(coreRoot) !== realpathSync(path.join(installRoot, 'releases', id))) fail('目标 CLI 版本不属于此安装。')
    const target = await fs.lstat(coreRoot)
    if (!target.isDirectory() || target.isSymbolicLink()) fail('核心版本目录被重定向，未切换。')
    const release = await verifyCoreRelease(coreRoot, { version: prepared.version })
    if (release.inventory_sha256 !== id || readCliSelection(installRoot) !== expected) fail('当前 CLI 版本已变化，未切换。')
    const launcher = path.join(installRoot, 'bin', launcherName)
    if (await digest(launcher) !== record.launcher_sha256) fail('CLI 启动器已变化，未切换。')
    await publish(installRoot, selectorName, id + '\n', scope, expected === null ? null : expected + '\n')
  } finally { releaseCliLock(lock) }
}
