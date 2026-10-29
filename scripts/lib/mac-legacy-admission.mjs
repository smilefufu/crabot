// Self-contained Mac App adapter. The common converter owns stopped data;
// this adapter commits only the App binding, management marker and known CLI link.
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import binding from './mac-app-binding.cjs'
import management from './desktop-management.cjs'
import { verifyCoreRelease } from './core-release.mjs'
import { discoverLegacyDesktopTakeover } from './legacy-desktop-discovery.mjs'
import { convertLegacyUserData } from './legacy-user-data-conversion.mjs'
import { acquireExistingCliLock, releaseCliLock } from './cli-lock.mjs'
import { readVersionMaintenance } from './version-maintenance.mjs'
import { inspectLegacyEntryFence } from './legacy-entry-fence.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { privateJson } from './desktop-preparation-files.mjs'

const fail = () => { throw Object.assign(new Error('旧数据接入尚未核验完成，原目录和保护记录保留；请重新打开同一Crabot继续检查。'), { code: 'CRABOT_MAINTENANCE_PENDING' }) }
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function legacyListenHost(root) {
  let raw
  try { raw = await fs.readFile(path.join(root, '.env'), 'utf8') } catch (error) { if (error.code === 'ENOENT') return '127.0.0.1'; throw error }
  const line = raw.split('\n').map(value => value.replace(/#.*$/, '').trim()).find(value => value.startsWith('CRABOT_ADMIN_WEB_HOST='))
  const host = line?.slice('CRABOT_ADMIN_WEB_HOST='.length) || '127.0.0.1'
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host)) throw new Error('原监听地址需要人工核对，尚未停止旧实例。')
  return host
}
export async function adoptKnownMacCli(sourceRoot, coreRoot, home) {
  const prefix = path.join(home, '.local/bin'), directory = await present(prefix)
  if (!directory?.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || directory.mode & 0o022) return false
  const entry = path.join(prefix, 'crabot'), current = await present(entry)
  if (!current?.isSymbolicLink() || current.uid !== process.getuid()) return false
  const original = await fs.readlink(entry)
  const metadata = path.join(prefix, '.crabot-desktop-cli.json'), desired = path.join(coreRoot, 'bin/crabot')
  const existingMetadata = await present(metadata)
  if (path.resolve(prefix, original) === desired) {
    if (!existingMetadata) await privateJson(metadata, { schema_version: 1, core_root: coreRoot })
    return true // Resumes the narrow interruption after publishing the known link.
  }
  if (path.resolve(prefix, original) !== path.join(sourceRoot, 'cli.mjs') || existingMetadata) return false
  const temporary = path.join(prefix, '.crabot-mac-cli-' + randomUUID())
  try {
    await fs.symlink(path.join(coreRoot, 'bin/crabot'), temporary)
    const latest = await fs.lstat(entry)
    if (latest.dev !== current.dev || latest.ino !== current.ino || await fs.readlink(entry) !== original) fail()
    await fs.rename(temporary, entry)
    await privateJson(metadata, { schema_version: 1, core_root: coreRoot })
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  return true
}
export async function admitLegacyMacData({ sourceRoot, home = homedir(), signal, progress = () => {}, inspectEnvironment }) {
  const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)))
  if (process.platform !== 'darwin' || !binding.macAppForCore(root)) fail()
  const own = binding.applyMacAppEnvironment(root, { home, env: {} })
  const source = await discoverLegacyDesktopTakeover({ root: sourceRoot, source: {} })
  if (!source || source.installation.dataRoot !== own.data_dir) fail()
  const release = await verifyCoreRelease(root), target = { root, version: release.version, core_id: release.inventory_sha256 }
  const listenHost = await legacyListenHost(source.installation.installRoot)
  const verifyPrograms = async () => {
    const current = await discoverLegacyDesktopTakeover({ root: source.installation.installRoot, source: {} })
    const verified = await verifyCoreRelease(root, { version: target.version })
    if (!current || await legacyListenHost(source.installation.installRoot) !== listenHost
      || JSON.stringify(current.installation) !== JSON.stringify(source.installation) || verified.inventory_sha256 !== target.core_id
      || binding.applyMacAppEnvironment(root, { home, env: {} }).data_dir !== own.data_dir) fail()
  }
  const converted = await convertLegacyUserData({ installation: source.installation, target, verifyPrograms, signal, progress, inspectEnvironment })
  const rootLock = await acquireExistingCliLock(source.installation.installRoot, 'mac-legacy-commit')
  let dataLock
  try {
    dataLock = await acquireExistingCliLock(own.data_dir, 'mac-legacy-commit')
    await verifyPrograms()
    const record = readVersionMaintenance(own.data_dir), entry = await inspectLegacyEntryFence(source.installation.installRoot)
    if (record?.id !== converted.maintenance_id || record.phase !== 'verifying' || record.schema_version !== 4
      || record.legacy_source.entry_fence_id !== entry.id || entry.phase !== 'data_changing'
      || record.target_core.root !== root || record.target_core.inventory_sha256 !== target.core_id
      || inspectInstance(own.data_dir).state !== 'stopped') fail()
    const marker = management.readDesktopManagement(own.data_dir)
    if (marker && marker.admin_listen_host !== listenHost) fail()
    const cli_registered = await adoptKnownMacCli(source.installation.installRoot, root, home)
    // Marker is the last admission commit: a retry before it resumes conversion/CLI, never ordinary startup.
    if (!marker) await privateJson(path.join(own.data_dir, 'desktop-managed.json'), { schema_version: 1, install_kind: 'desktop', admin_listen_host: listenHost })
    return { dataDir: own.data_dir, maintenance_id: record.id, verification_pending: true, cli_registered }
  } finally { if (dataLock) releaseCliLock(dataLock); releaseCliLock(rootLock) }
}
