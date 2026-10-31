// Online preparation for the explicitly confirmed legacy-user takeover. This
// stages only immutable programs; entry fencing, data conversion and health
// belong to the separate takeover coordinator.
import path from 'node:path'
import { createHash } from 'node:crypto'
import physicalFs from './physical-fs.cjs'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'
import installationState from './desktop-installation.cjs'
import { acquireExistingCliLock, releaseCliLock } from './cli-lock.mjs'
import { discoverLegacyUserInstall } from './legacy-desktop.mjs'
import { inspectLegacyEntryFence } from './legacy-entry-fence.mjs'
import { verifyDesktopPayload, verifyDesktopPrograms } from './desktop-payload.mjs'
import { privateJson, readPending } from './desktop-preparation-files.mjs'
import { previewMigrations } from '../upgrade-lib/migrate.mjs'
const { promises: fs, constants } = physicalFs
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = () => { throw Object.assign(new Error('原安装或接管程序发生变化，原数据已保留，请重新检查原安装位置。'), { code: 'CRABOT_DESKTOP_INSTALLATION' }) }
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function sourceCurrent(installation, entryFenceId) {
  if (!installation || installation.dataRoot !== path.join(installation.installRoot, 'data')) fail()
  management.requireExistingDataRoot(installation.installRoot); management.requireExistingDataRoot(installation.dataRoot)
  if (entryFenceId) {
    const entry = await inspectLegacyEntryFence(installation.installRoot)
    if (entry.id !== entryFenceId || !same(entry.installation, installation)) fail()
    if (entry.phase === 'fencing') {
      if (await present(path.join(installation.dataRoot, 'desktop-maintenance.json'))) fail()
    } else if (!entry.entries_fenced || !['fenced', 'data_changing'].includes(entry.phase)) fail()
  } else if (!same(await discoverLegacyUserInstall({ root: installation.installRoot, dataDir: installation.dataRoot }), installation)) fail()
}
async function proofText(file) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024
    || (process.platform === 'win32' ? !identity.isPrivateFile(file) : stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600)) fail()
  return fs.readFile(file, 'utf8')
}
// Byte/source verification only; neither this proof nor a prepared program is
// admission to start Core or to remove version-maintenance protection.
export async function verifyLegacyDesktopPrograms(prepared, { entryFenceId, signal } = {}) {
  const root = prepared?.installRoot ?? prepared?.installation?.installRoot, selection = prepared?.selection
  await sourceCurrent(prepared?.installation, entryFenceId)
  if (!selection || selection.schema_version !== 1 || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(selection.gui_id)
    || !/^[a-f0-9]{64}$/.test(selection.core_id) || prepared.coreRoot !== path.join(root, 'releases', selection.core_id)
    || prepared.guiRoot !== path.join(root, 'app/releases', selection.gui_id)
    || prepared.proof?.file !== path.join(root, 'app/payloads', selection.gui_id + '.json')) fail()
  for (const relative of ['app', 'app/releases', 'releases']) management.requireExistingDataRoot(path.join(root, relative))
  management.requirePrivateDataRoot(path.join(root, 'app/payloads'))
  const text = await proofText(prepared.proof.file), record = JSON.parse(text)
  if (digest(text) !== prepared.proof.sha256 || !same(record.selection, selection)) fail()
  await verifyDesktopPrograms(prepared.coreRoot, prepared.guiRoot, record, { signal })
  await sourceCurrent(prepared.installation, entryFenceId)
  return record
}
export async function prepareLegacyDesktopPrograms({ payload, installation, entryFenceId, signal, progress = () => {} }) {
  signal?.throwIfAborted(); progress('verifying')
  await sourceCurrent(installation, entryFenceId)
  const source = await verifyDesktopPayload(payload, { signal }), root = installation.installRoot
  const relative = path.relative(source.directory, root)
  if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) fail()
  const lock = await acquireExistingCliLock(root, 'prepare-legacy-desktop-programs')
  let staging, preparationError
  try {
    await sourceCurrent(installation, entryFenceId)
    const selection = source.record.selection, coreRoot = path.join(root, 'releases', selection.core_id), guiRoot = path.join(root, 'app/releases', selection.gui_id)
    if (entryFenceId) {
      const { readVersionMaintenance } = await import('./version-maintenance.mjs')
      const record = readVersionMaintenance(installation.dataRoot)
      const pending = await readPending(root)
      if (pending && !same(pending.selection, selection)) fail()
      if (record && (record.schema_version !== 4 || record.legacy_source.entry_fence_id !== entryFenceId
        || record.legacy_source.fingerprint !== installation.fingerprint || record.install_root !== root
        || record.target_core.root !== coreRoot || record.target_core.inventory_sha256 !== selection.core_id || record.target_version !== selection.version)) fail()
    }
    for (const relative of ['app', 'app/releases', 'releases']) {
      const directory = path.join(root, relative)
      if (await present(directory)) management.requireExistingDataRoot(directory)
      else management.ensurePrivateDataRoot(directory)
    }
    const coreCached = Boolean(await present(coreRoot)), guiCached = Boolean(await present(guiRoot))
    if (coreCached || guiCached) await verifyDesktopPrograms(coreCached ? coreRoot : source.coreRoot, guiCached ? guiRoot : source.guiRoot, source.record, { signal })
    const guiBytes = Object.values(source.record.gui).reduce((sum, file) => sum + BigInt(file.size ?? 0), 0n)
    const needed = (coreCached ? 0n : source.bytes - guiBytes) + (guiCached ? 0n : guiBytes), space = await fs.statfs(root, { bigint: true })
    if (space.bavail * space.bsize < needed + 512n * 1024n * 1024n) throw Object.assign(new Error('接管准备空间不足，原实例保持。'), { code: 'CRABOT_UPDATE_SPACE' })
    signal?.throwIfAborted(); progress('copying')
    if (!coreCached || !guiCached) {
      staging = await fs.mkdtemp(path.join(root, '.preparing-pair-'))
      const programs = []
      if (!coreCached) programs.push({ name: 'core', target: coreRoot })
      if (!guiCached) programs.push({ name: 'gui', target: guiRoot })
      const copied = await Promise.allSettled(programs.map(({ name }) => fs.cp(path.join(source.directory, name), path.join(staging, name),
        { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, filter: () => { signal?.throwIfAborted(); return true } })))
      const failed = copied.find(result => result.status === 'rejected'); if (failed) throw failed.reason
      await verifyDesktopPrograms(coreCached ? coreRoot : path.join(staging, 'core'), guiCached ? guiRoot : path.join(staging, 'gui'), source.record, { signal })
      await sourceCurrent(installation, entryFenceId)
      for (const { name, target } of programs) {
        signal?.throwIfAborted()
        if (await present(target)) fail()
        await fs.rename(path.join(staging, name), target)
      }
    }
    management.ensurePrivateDataRoot(path.join(root, 'app/payloads'))
    const file = path.join(root, 'app/payloads', selection.gui_id + '.json'), text = JSON.stringify(source.record) + '\n'
    if (await present(file)) { if (await proofText(file) !== text) fail() }
    else await privateJson(file, source.record)
    const prepared = { installation, selection, coreRoot, guiRoot, proof: { file, sha256: digest(text) } }
    progress('previewing')
    const preview = await previewMigrations(coreRoot, installation.dataRoot)
    progress('prepared'); signal?.throwIfAborted(); await sourceCurrent(installation, entryFenceId)
    return { ...prepared, preview }
  } catch (error) { preparationError = error; throw error }
  finally {
    try { if (staging) await fs.rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
    catch (error) { if (preparationError) throw new AggregateError([preparationError, error], '接管准备和暂存清理未完成，原数据与错误已保留。'); throw error }
    finally { releaseCliLock(lock) }
  }
}


// Read-only reconstruction of the already selected takeover pair. Source facts
// come from the original entry fence; this grants no startup or completion.
export async function readLegacyDesktopPrograms(root, programRoot = root) {
  const own = installationState.readDesktopSelection(programRoot), entry = await inspectLegacyEntryFence(root)
  management.requirePrivateDataRoot(path.join(own.root, 'app/payloads'))
  const file = path.join(own.root, 'app/payloads', own.selection.gui_id + '.json'), text = await proofText(file)
  const prepared = { ...(own.root !== root ? { installRoot: own.root } : {}), installation: entry.installation, selection: own.selection, coreRoot: own.coreRoot, guiRoot: own.guiRoot,
    proof: { file, sha256: digest(text) } }
  await verifyLegacyDesktopPrograms(prepared, { entryFenceId: entry.id })
  return prepared
}
