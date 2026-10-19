// Offline payload integrity and fresh installation only. Existing deployments
// use takeover/version maintenance; this entry never starts or migrates a Core.
import physicalFs from './physical-fs.cjs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'
import installation from './desktop-installation.cjs'
import { verifyCoreRelease } from './core-release.mjs'
import { acquireCliLock, releaseCliLock } from './cli-lock.mjs'
import { inspectInstance } from './instance-runtime.mjs'
const { promises: fs, createReadStream, constants } = physicalFs
const fail = (message, code = 'CRABOT_DESKTOP_INSTALLATION') => { throw Object.assign(new Error(message), { code }) }
const pendingName = '.desktop-installing.json', payloadName = '.desktop-install-payload.json'
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function hash(file) { const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex') }
function resources(root) { return path.join(root, process.platform === 'darwin' ? 'Crabot.app/Contents/Resources' : 'resources') }
async function guiInventory(root, signal) {
  const directory = await fs.lstat(root)
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail('GUI 载荷根被重定向。')
  const executable = path.join(root, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : process.platform === 'win32' ? 'Crabot.exe' : 'crabot-desktop')
  for (const file of [executable, path.join(resources(root), 'app.asar'), path.join(resources(root), 'app.asar.unpacked/dist/bootstrap/crabot-native/build/Release/crabot-native.node')]) {
    const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) fail('GUI 载荷缺少固定入口或本地安装核验器。')
  }
  const entries = [], files = Object.create(null)
  async function walk(directory) {
    signal?.throwIfAborted()
    for (const child of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, child), stat = await fs.lstat(file), name = path.relative(root, file).split(path.sep).join('/')
      if (stat.isDirectory()) await walk(file)
      else if (stat.isFile()) entries.push({ name, file, stat })
      else if (stat.isSymbolicLink()) {
        const target = await fs.readlink(file)
        if (path.isAbsolute(target) || !inside(root, await fs.realpath(file))) fail('GUI 载荷包含根外链接。')
        files[name] = { type: 'link', target }
      } else fail('GUI 载荷包含不支持的文件。')
    }
  }
  await walk(root)
  let cursor = 0
  const results = await Promise.allSettled(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (cursor < entries.length) {
      signal?.throwIfAborted()
      const { name, file, stat } = entries[cursor++]
      files[name] = { type: 'file', size: stat.size, sha256: await hash(file), ...(process.platform === 'win32' ? {} : { mode: stat.mode & 0o777 }) }
    }
  }))
  const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason
  return Object.fromEntries(Object.keys(files).sort().map(key => [key, files[key]]))
}
async function privateJson(file, value, replace = false) {
  const temporary = file + '.tmp-' + randomUUID(), text = JSON.stringify(value) + '\n'
  try {
    if (process.platform === 'win32') identity.writePrivateFile(temporary, text)
    else await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600, flush: true })
    if (replace) await fs.rename(temporary, file); else await fs.link(temporary, file)
    if (process.platform !== 'win32') { const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync() } finally { await directory.close() } }
  } finally { await fs.rm(temporary, { force: true }) }
}
async function readPending(root) {
  const file = path.join(root, pendingName), stat = await present(file)
  if (!stat) return null
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096
    || (process.platform === 'win32' ? !identity.isPrivateFile(file) : stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600)) fail('安装准备记录无法核验，原目录已保留。')
  const state = JSON.parse(await fs.readFile(file, 'utf8'))
  if (state.schema_version !== 1 || !['preparing', 'prepared'].includes(state.phase)
    || typeof state.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(state.id) || typeof state.installation_id !== 'string'
    || !/^[a-f0-9]{64}$/.test(state.payload_sha256)
    || Object.keys(state).some(key => !['schema_version', 'id', 'installation_id', 'selection', 'phase', 'payload_sha256'].includes(key))) fail('安装准备记录损坏，原目录已保留。')
  return state
}
async function verifyPairedCore(root) {
  const stat = await fs.lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('离线 Core 根被重定向。')
  const core = await verifyCoreRelease(root)
  const host = JSON.parse(await fs.readFile(path.join(root, 'desktop-host.json'), 'utf8'))
  if (host.schema_version !== 2 || host.platform !== process.platform || host.arch !== process.arch
    || Object.keys(host).join(',') !== 'schema_version,platform,arch') fail('离线 Core 不是桌面配对载荷。')
  return core
}
export async function sealDesktopPayload(directory) {
  directory = await fs.realpath(directory)
  const core = await verifyPairedCore(path.join(directory, 'core'))
  const selection = JSON.parse(await fs.readFile(path.join(resources(path.join(directory, 'gui')), 'desktop-release.json'), 'utf8'))
  if (selection.schema_version !== 1 || selection.version !== core.version || selection.core_id !== core.inventory_sha256
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(selection.gui_id)
    || Object.keys(selection).join(',') !== 'schema_version,version,gui_id,core_id') fail('GUI 与 Core 载荷未成对。')
  const gui = await guiInventory(path.join(directory, 'gui'))
  const record = { schema_version: 1, platform: process.platform, arch: process.arch, selection, gui }
  await fs.writeFile(path.join(directory, 'desktop-payload.json'), JSON.stringify(record) + '\n', { flag: 'wx' })
  return record
}
export async function verifyDesktopPayload(directory, { signal } = {}) {
  directory = await fs.realpath(directory)
  const file = path.join(directory, 'desktop-payload.json'), stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) fail('离线安装清单无法核验。')
  const record = JSON.parse(await fs.readFile(file, 'utf8'))
  if (record.schema_version !== 1 || record.platform !== process.platform || record.arch !== process.arch
    || Object.keys(record).join(',') !== 'schema_version,platform,arch,selection,gui') fail('此离线安装包不适用于当前系统。')
  const coreRoot = path.join(directory, 'core'), guiRoot = path.join(directory, 'gui')
  for (const root of [coreRoot, guiRoot]) { const stat = await fs.lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('离线载荷根被重定向。') }
  const core = await verifyPairedCore(coreRoot)
  const pinned = JSON.parse(await fs.readFile(path.join(resources(guiRoot), 'desktop-release.json'), 'utf8'))
  if (!same(record.selection, pinned) || pinned.schema_version !== 1 || pinned.version !== core.version || pinned.core_id !== core.inventory_sha256
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(pinned.gui_id)
    || Object.keys(pinned).join(',') !== 'schema_version,version,gui_id,core_id'
    || !same(await guiInventory(guiRoot, signal), record.gui)) fail('离线安装载荷不完整或已改变。', 'CRABOT_CORE_INTEGRITY')
  const coreFiles = JSON.parse(await fs.readFile(path.join(coreRoot, 'core-files.json'), 'utf8')).files
  const bytes = [...Object.values(coreFiles), ...Object.values(record.gui)].reduce((sum, file) => sum + BigInt(file.size ?? 0), 0n)
  signal?.throwIfAborted()
  return { directory, record, coreRoot, guiRoot, bytes }
}
async function targetRoot(target, bytes) {
  target = path.resolve(target)
  let stat = await present(target), parent = stat ? target : path.dirname(target)
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || !identity.isOwnedDirectory(target))) fail('请选择当前账号可管理的本机安装目录。')
  if (!identity.inspectInstallFilesystem(parent).supported) fail('此位置不支持完整桌面安装；请选择支持私有文件权限的本机持久卷。', 'CRABOT_INSTALL_FILESYSTEM')
  await fs.access(parent, constants.W_OK)
  const space = await fs.statfs(parent, { bigint: true })
  if (space.bavail * space.bsize < bytes + 512n * 1024n * 1024n) fail('安装空间不足；尚未修改现有安装。', 'CRABOT_UPDATE_SPACE')
  const metadata = stat && await present(path.join(target, 'desktop-installation.json'))
  if (!metadata) {
    if (stat) {
      if ((await fs.readdir(target)).length) fail('所选目录不是空目录，也不是可识别的 Crabot 安装，已有文件已保留。')
      // Empty, explicitly selected and owned only. Recreate with the same private
      // factory on Windows/POSIX, never relax or rewrite an existing data ACL.
      await fs.rmdir(target)
    }
    management.ensurePrivateDataRoot(target)
  }
  return fs.realpath(target)
}
// Only an unselected, fenced fresh installation reaches this publication.
// Keep damaged immutable program bytes; never repair data or dependency trees.
async function publishPreparedProgram(source, target, signal, verify) {
  if (!await present(target)) { await fs.rename(source, target); return }
  const stat = await fs.lstat(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('准备版本目录已被重定向。')
  try { await verify(); return }
  catch { signal?.throwIfAborted() }
  const retained = path.join(path.dirname(target), '.damaged-' + path.basename(target) + '-' + randomUUID())
  await fs.rename(target, retained)
  try { await fs.rename(source, target) }
  catch (publishError) {
    try {
      if (await present(target)) throw publishError
      await fs.rename(retained, target)
    } catch (restoreError) { throw new AggregateError([publishError, restoreError], '安装准备与原位恢复未完成；原程序已保留。') }
    throw publishError
  }
}
export async function prepareDesktopInstallation({ payload, installRoot, signal, progress = () => {} }) {
  progress('verifying')
  const source = await verifyDesktopPayload(payload, { signal })
  const requested = path.join(await fs.realpath(path.dirname(path.resolve(installRoot))), path.basename(path.resolve(installRoot)))
  if (inside(source.directory, requested) || inside(requested, source.directory)) fail('安装目录不能覆盖离线安装包。')
  signal?.throwIfAborted()
  installRoot = await targetRoot(requested, source.bytes)
  const lock = await acquireCliLock(installRoot, 'prepare-desktop-installation')
  let staging, preparationError
  try {
    const metadata = path.join(installRoot, 'desktop-installation.json')
    if (!await present(metadata)) {
      if ((await fs.readdir(installRoot)).some(name => name !== 'cli.lock')) fail('安装目录在准备期间发生变化，未覆盖。')
      for (const name of ['app/releases', 'releases', 'bin']) await fs.mkdir(path.join(installRoot, name), { recursive: true, mode: 0o700 })
      management.ensurePrivateDataRoot(path.join(installRoot, 'data'))
      const stat = await fs.lstat(installRoot, { bigint: true })
      await privateJson(metadata, { schema_version: 1, installation_id: randomUUID(), owner: identity.inspectProcess(process.pid).owner,
        install_root: installRoot, root_identity: { dev: String(stat.dev), ino: String(stat.ino) }, paths: { app: 'app/releases', core: 'releases', data: 'data', bin: 'bin' } })
    }
    const own = installation.readDesktopInstallation(installRoot), previous = await readPending(installRoot)
    const selected = await present(path.join(installRoot, 'current-release.json'))
    if (selected && previous?.phase !== 'prepared') fail('此目录已有已安装版本，请使用应用内更新或显式修复，未切换版本。')
    if (previous && (previous.installation_id !== own.record.installation_id || !same(previous.selection, source.record.selection))) fail('另一版本的安装尚未完成；请使用原离线包继续或检查保留目录。')
    if ((await fs.readdir(own.dataDir)).some(name => name !== 'cli.lock') || inspectInstance(own.dataDir).state !== 'stopped') fail('发现既有业务数据，需要旧安装接管，未按新安装覆盖。')
    const payloadText = JSON.stringify(source.record) + '\n', payloadSha = createHash('sha256').update(payloadText).digest('hex')
    const retained = path.join(installRoot, payloadName)
    const retainedStat = await present(retained)
    if (retainedStat) {
      if (!retainedStat.isFile() || retainedStat.isSymbolicLink() || retainedStat.nlink !== 1 || await hash(retained) !== payloadSha) fail('准备载荷与原安装记录不一致。')
    } else {
      const temporary = retained + '.tmp-' + randomUUID()
      try {
        await fs.writeFile(temporary, payloadText, { flag: 'wx', mode: 0o600, flush: true })
        await fs.link(temporary, retained)
      } finally { await fs.rm(temporary, { force: true }) }
    }
    const pending = previous ?? { schema_version: 1, id: randomUUID(), installation_id: own.record.installation_id, selection: source.record.selection, phase: 'preparing', payload_sha256: payloadSha }
    if (pending.payload_sha256 !== payloadSha) fail('准备载荷摘要已改变。')
    if (!previous) await privateJson(path.join(installRoot, pendingName), pending)
    progress('copying'); signal?.throwIfAborted()
    staging = await fs.mkdtemp(path.join(installRoot, '.preparing-'))
    const copied = await Promise.allSettled(['gui', 'core'].map(name => fs.cp(path.join(source.directory, name), path.join(staging, name),
      { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, filter: () => { signal?.throwIfAborted(); return true } })))
    const error = copied.find(result => result.status === 'rejected'); if (error) throw error.reason
    await fs.copyFile(path.join(source.directory, 'desktop-payload.json'), path.join(staging, 'desktop-payload.json'))
    const staged = await verifyDesktopPayload(staging, { signal }), selection = staged.record.selection
    if (!same(staged.record, source.record)) fail('离线载荷在准备期间发生变化。')
    const guiRoot = path.join(installRoot, 'app/releases', selection.gui_id), coreRoot = path.join(installRoot, 'releases', selection.core_id)
    for (const [name, target] of [['gui', guiRoot], ['core', coreRoot]]) {
      await publishPreparedProgram(path.join(staging, name), target, signal, async () => {
        if (name === 'core') {
          if ((await verifyPairedCore(target)).inventory_sha256 !== selection.core_id) fail('保留的准备 Core 已改变。')
        } else if (!same(await guiInventory(target, signal), source.record.gui)) fail('保留的准备 GUI 已改变。')
      })
    }
    const launcherName = process.platform === 'win32' ? 'crabot.exe' : 'crabot', launcher = path.join(installRoot, 'bin', launcherName), original = path.join(coreRoot, 'bin', launcherName)
    if (await present(launcher)) { if (await hash(launcher) !== await hash(original)) fail('保留的命令入口已改变。') }
    else { await fs.copyFile(original, launcher, constants.COPYFILE_EXCL); if (process.platform !== 'win32') await fs.chmod(launcher, 0o755) }
    await privateJson(path.join(installRoot, pendingName), { ...pending, phase: 'prepared' }, true)
    progress('prepared'); signal?.throwIfAborted()
    return { installRoot, installation_id: own.record.installation_id, selection, coreRoot, guiRoot }
  } catch (error) { preparationError = error; throw error }
  finally {
    try { if (staging) await fs.rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
    catch (error) { if (preparationError) throw new AggregateError([preparationError, error], '安装准备失败，部分暂存清理未完成；原安装与错误已保留。'); throw error }
    finally { releaseCliLock(lock) }
  }
}
export async function commitDesktopInstallation(prepared) {
  const { installRoot, selection } = prepared, own = installation.readDesktopInstallation(installRoot)
  const rootLock = await acquireCliLock(installRoot, 'commit-desktop-installation')
  let lock
  try {
    const current = installation.readDesktopInstallation(installRoot)
    if (!same(current.record, own.record)) fail('安装绑定在操作期间发生变化。')
    lock = await acquireCliLock(own.dataDir, 'commit-desktop-installation')
    const state = await readPending(installRoot)
    if (!state || state.phase !== 'prepared' || state.installation_id !== own.record.installation_id || prepared.installation_id !== state.installation_id
      || !same(state.selection, selection) || inspectInstance(own.dataDir).state !== 'stopped') fail('安装准备状态已改变，未提交版本。')
    if (prepared.coreRoot !== path.join(installRoot, 'releases', selection.core_id) || prepared.guiRoot !== path.join(installRoot, 'app/releases', selection.gui_id)
      || (await verifyPairedCore(prepared.coreRoot)).inventory_sha256 !== selection.core_id) fail('准备版本无法核验。')
    const proof = path.join(installRoot, payloadName), proofStat = await fs.lstat(proof)
    if (!proofStat.isFile() || proofStat.isSymbolicLink() || proofStat.nlink !== 1 || proofStat.size > 64 * 1024 * 1024 || await hash(proof) !== state.payload_sha256) fail('GUI 准备清单无法核验。')
    const payload = JSON.parse(await fs.readFile(proof, 'utf8'))
    if (!same(payload.selection, selection) || !same(await guiInventory(prepared.guiRoot), payload.gui)) fail('准备 GUI 在提交前发生变化。')
    const launcherName = process.platform === 'win32' ? 'crabot.exe' : 'crabot', launcher = path.join(installRoot, 'bin', launcherName), launcherStat = await fs.lstat(launcher)
    if (!launcherStat.isFile() || launcherStat.isSymbolicLink() || await hash(launcher) !== await hash(path.join(prepared.coreRoot, 'bin', launcherName))) fail('准备命令入口已改变。')
    // OS registration is completed by the installer before this final selector.
    const selector = path.join(installRoot, 'current-release.json')
    if (await present(selector)) {
      const stat = await fs.lstat(selector)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.platform === 'win32' ? !identity.isPrivateFile(selector) : stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600)
        || await fs.readFile(selector, 'utf8') !== JSON.stringify(selection) + '\n') fail('未完成安装的版本选择不一致。')
    } else await privateJson(selector, selection)
    await fs.unlink(path.join(installRoot, pendingName))
    return installation.readDesktopSelection(installRoot)
  } finally { if (lock) releaseCliLock(lock); releaseCliLock(rootLock) }
}
