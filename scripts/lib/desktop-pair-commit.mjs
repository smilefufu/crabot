// Only the final stopped pair selection. The surrounding desktop coordinator owns data
// migration, source GUI handoff and verified target startup/health.
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import physicalFs from './physical-fs.cjs'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'
import installation from './desktop-installation.cjs'
import { verifyDesktopPrograms } from './desktop-payload.mjs'
import { readVersionMaintenance } from './version-maintenance.mjs'
import { acquireCliLock, releaseCliLock, cliLockToken } from './cli-lock.mjs'
import { assertStopped } from '../upgrade-lib/scoped-data.mjs'
const { promises: fs } = physicalFs
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = () => { throw Object.assign(new Error('版本对提交无法核验，原程序、数据与维护记录已保留。'), { code: 'CRABOT_DESKTOP_INSTALLATION' }) }
function pair(value) {
  if (value?.schema_version !== 1 || Object.keys(value).join(',') !== 'schema_version,version,gui_id,core_id'
    || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.version)
    || typeof value.gui_id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.gui_id)
    || typeof value.core_id !== 'string' || !/^[a-f0-9]{64}$/.test(value.core_id)) fail()
}
async function privateText(file) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024
    || (process.platform === 'win32' ? !identity.isPrivateFile(file) : stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600)) fail()
  return fs.readFile(file, 'utf8')
}
async function syncDirectory(directory) {
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function publish(file, text, replace = false) {
  const temporary = file + '.tmp-' + randomUUID()
  try {
    if (process.platform === 'win32') identity.writePrivateFile(temporary, text)
    else await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600, flush: true })
    if (replace) await fs.rename(temporary, file); else await fs.link(temporary, file)
    await syncDirectory(path.dirname(file))
  } finally { await fs.rm(temporary, { force: true }) }
}
export async function commitPreparedDesktopPair(prepared, { maintenanceId, verifyData, replaceEntries }) {
  pair(prepared?.source); pair(prepared?.selection)
  const own = installation.readDesktopSelection(prepared.installRoot)
  if (prepared.installRoot !== own.root || prepared.installation_id !== own.record.installation_id
    || same(prepared.source, prepared.selection) || prepared.coreRoot !== path.join(own.root, 'releases', prepared.selection.core_id)
    || prepared.guiRoot !== path.join(own.root, 'app/releases', prepared.selection.gui_id)
    || prepared.proof?.file !== path.join(own.root, 'app/payloads', prepared.selection.gui_id + '.json')
    || !/^[a-f0-9]{64}$/.test(prepared.proof?.sha256 ?? '')
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(maintenanceId ?? '')
    || typeof verifyData !== 'function' || typeof replaceEntries !== 'function') fail()
  const rootLock = await acquireCliLock(own.root, 'commit-desktop-pair')
  let lock
  try {
    lock = await acquireCliLock(own.dataDir, 'commit-desktop-pair')
    const selectedState = () => {
      if (!cliLockToken(rootLock) || !cliLockToken(lock)) fail()
      const current = installation.readDesktopSelection(own.root), maintenance = readVersionMaintenance(own.dataDir)
      if (!same(current.record, own.record) || ![prepared.source, prepared.selection].some(value => same(current.selection, value))
        || maintenance?.schema_version !== 3 || maintenance.id !== maintenanceId || maintenance.phase !== 'verifying'
        || maintenance.system_operation_id !== undefined || maintenance.install_root !== path.join(own.root, 'releases', prepared.source.core_id)
        || maintenance.source_version !== prepared.source.version || maintenance.source_inventory_sha256 !== prepared.source.core_id
        || maintenance.target_version !== prepared.selection.version || maintenance.target_core?.root !== prepared.coreRoot
        || maintenance.target_core.inventory_sha256 !== prepared.selection.core_id) fail()
      return current
    }
    const verify = async () => {
      selectedState()
      await assertStopped(own.dataDir)
      management.requirePrivateDataRoot(path.dirname(prepared.proof.file))
      const proof = await privateText(prepared.proof.file)
      if (digest(proof) !== prepared.proof.sha256) fail()
      const record = JSON.parse(proof)
      if (!same(record.selection, prepared.selection)) fail()
      await verifyDesktopPrograms(prepared.coreRoot, prepared.guiRoot, record)
      if (await verifyData() !== true) fail()
      await assertStopped(own.dataDir)
      return selectedState()
    }
    const current = await verify()
    const parent = management.ensurePrivateDataRoot(path.join(own.root, 'app/updates'))
    const directory = management.ensurePrivateDataRoot(path.join(parent, maintenanceId))
    const journal = path.join(directory, 'selection.json'), text = JSON.stringify({ schema_version: 1, installation_id: prepared.installation_id,
      maintenance_id: maintenanceId, source: prepared.source, target: prepared.selection, payload_sha256: prepared.proof.sha256 }) + '\n'
    const existing = await fs.lstat(journal).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (existing) { if (await privateText(journal) !== text) fail() }
    else {
      if (!same(current.selection, prepared.source)) fail()
      await publish(journal, text)
    }
    await syncDirectory(parent); await syncDirectory(path.dirname(parent))
    const source = { installRoot: own.root, installation_id: prepared.installation_id, selection: prepared.source,
      coreRoot: path.join(own.root, 'releases', prepared.source.core_id), guiRoot: path.join(own.root, 'app/releases', prepared.source.gui_id) }
    await replaceEntries(source, prepared)
    const before = await verify()
    if (await privateText(journal) !== text) fail()
    if (!same(before.selection, prepared.selection)) await publish(path.join(own.root, 'current-release.json'), JSON.stringify(prepared.selection) + '\n', true)
    const selected = selectedState()
    await assertStopped(own.dataDir)
    if (!same(selected.selection, prepared.selection)) fail()
    return selected
  } finally { if (lock) releaseCliLock(lock); releaseCliLock(rootLock) }
}
