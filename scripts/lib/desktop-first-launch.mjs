// First-use binding for programs already extracted to their final directory.
// No program copy, service start or legacy conversion occurs in this layer.
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import identity from './process-identity.cjs'
import installation from './desktop-installation.cjs'
import management from './desktop-management.cjs'
import { verifyDesktopPrograms } from './desktop-payload.mjs'
import { privateJson } from './desktop-preparation-files.mjs'
import { acquireExistingCliLock, releaseCliLock } from './cli-lock.mjs'
const fail = () => { throw Object.assign(new Error('程序位置或已有数据绑定无法核对，原文件已保留；请重新打开原应用。'), { code: 'CRABOT_DESKTOP_INSTALLATION' }) }
const hash = text => createHash('sha256').update(text).digest('hex')
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code !== 'ENOENT') throw error; return null } }
export async function readFirstLaunchPrograms({ resources, pinText }) {
  resources = await fs.realpath(resources)
  const guiRoot = path.resolve(resources, process.platform === 'darwin' ? '../../..' : '..')
  const installRoot = management.requireExistingDataRoot(path.resolve(guiRoot, '../../..'))
  let selection
  try { selection = JSON.parse(pinText) } catch { fail() }
  if (typeof pinText !== 'string' || pinText !== JSON.stringify(selection) + '\n'
    || selection.schema_version !== 1 || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(selection.gui_id)
    || !/^[a-f0-9]{64}$/.test(selection.core_id) || Object.keys(selection).join(',') !== 'schema_version,version,gui_id,core_id'
    || guiRoot !== path.join(installRoot, 'app/releases', selection.gui_id)) fail()
  // An existing selected installation stays on its normal startup/update path.
  // Missing or damaged selected programs cannot turn into fresh initialization.
  let source
  if (await present(path.join(installRoot, 'current-release.json'))) {
    const selected = installation.readDesktopSelection(installRoot)
    if (JSON.stringify(selected.selection) + '\n' === pinText) return { initialized: true, ...installation.locatePinnedDesktopGui(resources, pinText) }
    source = selected
  }
  if (await present(path.join(installRoot, '.desktop-removal.json')) || await present(path.join(installRoot, '.desktop-installing.json'))) fail()
  const incoming = path.join(installRoot, 'app/installers', selection.gui_id + '.json')
  const payload = await present(incoming) ? incoming : path.join(installRoot, '.desktop-install-payload.json'), stat = await fs.lstat(payload)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) fail()
  const text = await fs.readFile(payload, 'utf8'), record = JSON.parse(text)
  if (JSON.stringify(record.selection) + '\n' !== pinText) fail()
  const coreRoot = path.join(installRoot, 'releases', selection.core_id)
  await verifyDesktopPrograms(coreRoot, guiRoot, record)
  return { initialized: false, installRoot, selection, coreRoot, guiRoot, payload: record, payloadText: text, payloadFile: payload, source }
}
export async function bindFirstLaunchData(programs, dataDir) {
  const root = programs.installRoot
  dataDir = management.requireExistingDataRoot(dataDir)
  const lock = await acquireExistingCliLock(root, 'desktop-first-launch-binding')
  try {
    const bin = path.join(root, 'bin')
    if (!await present(bin)) management.ensurePrivateDataRoot(bin)
    else management.requireExistingDataRoot(bin)
    const name = process.platform === 'win32' ? 'crabot.exe' : 'crabot', command = path.join(bin, name)
    const expected = path.join(programs.source?.coreRoot ?? programs.coreRoot, 'bin', name)
    if (await present(command)) {
      const stat = await fs.lstat(command)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !(await fs.readFile(command)).equals(await fs.readFile(expected))) fail()
    } else {
      await fs.copyFile(expected, command, constants.COPYFILE_EXCL)
      if (process.platform !== 'win32') await fs.chmod(command, 0o755)
    }
    const metadata = path.join(root, 'desktop-installation.json')
    if (await present(metadata)) {
      if (installation.readDesktopInstallation(root).dataDir !== dataDir) fail()
    } else {
      const stat = await fs.lstat(root, { bigint: true }), data = await fs.lstat(dataDir, { bigint: true })
      const external = dataDir !== path.join(root, 'data')
      await privateJson(metadata, { schema_version: external ? 2 : 1, installation_id: randomUUID(), owner: identity.inspectProcess(process.pid).owner,
        install_root: root, root_identity: { dev: String(stat.dev), ino: String(stat.ino) },
        paths: { app: 'app/releases', core: 'releases', ...(external ? {} : { data: 'data' }), bin: 'bin' },
        ...(external ? { data_dir: dataDir, data_identity: { dev: String(data.dev), ino: String(data.ino) } } : {}) })
    }
    const own = installation.readDesktopInstallation(root)
    const directory = management.ensurePrivateDataRoot(path.join(root, 'app/payloads'))
    const file = path.join(directory, programs.selection.gui_id + '.json'), text = JSON.stringify(programs.payload) + '\n'
    if (await present(file)) { if (await fs.readFile(file, 'utf8') !== text) fail() }
    else await privateJson(file, programs.payload)
    // NSIS creates the inventory as an ordinary program file. Publish the same
    // already-verified bytes privately for existing repair/removal consumers.
    if (await fs.readFile(programs.payloadFile, 'utf8') !== programs.payloadText) fail()
    if (programs.payloadFile === path.join(root, '.desktop-install-payload.json')) await privateJson(programs.payloadFile, programs.payload, true)
    return { ...own, selection: programs.selection, coreRoot: programs.coreRoot, guiRoot: programs.guiRoot,
      proof: { file, sha256: hash(text) } }
  } finally { releaseCliLock(lock) }
}
export async function completeFreshFirstLaunch(bound, registerEntries) {
  const lock = await acquireExistingCliLock(bound.dataDir, 'desktop-first-launch')
  try {
    const current = installation.readDesktopInstallation(bound.root)
    if (current.dataDir !== bound.dataDir || current.record.installation_id !== bound.record.installation_id) fail()
    management.initializeDesktopManagement(bound.dataDir)
    await registerEntries({ installRoot: bound.root, installation_id: bound.record.installation_id,
      selection: bound.selection, coreRoot: bound.coreRoot, guiRoot: bound.guiRoot })
    await privateJson(path.join(bound.root, 'current-release.json'), bound.selection)
    return installation.readDesktopSelection(bound.root)
  } finally { releaseCliLock(lock) }
}
