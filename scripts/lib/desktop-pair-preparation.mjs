// Online program preparation only. This never switches a pair, touches business
// data, executes migration scripts, changes OS entries, stops or starts Core.
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import physicalFs from './physical-fs.cjs'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'
import installation from './desktop-installation.cjs'
import { verifyDesktopPayload, verifyDesktopPrograms } from './desktop-payload.mjs'
import { acquireCliLock, releaseCliLock } from './cli-lock.mjs'
import { readVersionMaintenance } from './version-maintenance.mjs'
import { previewMigrations } from '../upgrade-lib/migrate.mjs'
const { promises: fs, constants } = physicalFs
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_DESKTOP_INSTALLATION' }) }
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
function unchanged(own) {
  const current = installation.readDesktopSelection(own.root)
  if (!same(current.record, own.record) || !same(current.selection, own.selection)) fail('当前安装或版本对发生变化，请重新检查更新。')
}
async function storeProof(root, record) {
  const directory = management.ensurePrivateDataRoot(path.join(root, 'app/payloads'))
  const file = path.join(directory, record.selection.gui_id + '.json'), text = JSON.stringify(record) + '\n'
  const existing = await present(file)
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.size > 64 * 1024 * 1024
      || (process.platform === 'win32' ? !identity.isPrivateFile(file) : existing.uid !== process.getuid() || (existing.mode & 0o777) !== 0o600)
      || await fs.readFile(file, 'utf8') !== text) fail('已准备版本的完整清单无法核验，原材料保留。')
  } else {
    const temporary = file + '.tmp-' + randomUUID()
    try {
      if (process.platform === 'win32') identity.writePrivateFile(temporary, text)
      else await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600, flush: true })
      await fs.link(temporary, file)
    } finally { await fs.rm(temporary, { force: true }) }
  }
  if (process.platform !== 'win32') {
    for (const parent of [directory, path.dirname(directory)]) {
      const handle = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await handle.sync() } finally { await handle.close() }
    }
  }
  return { file, sha256: createHash('sha256').update(text).digest('hex') }
}
// Read-only proof for both the stopping coordinator and final pair commit.
// It grants no migration, selection or lifecycle authority.
export async function verifyPreparedDesktopPair(prepared) {
  const own = installation.readDesktopSelection(prepared?.installRoot), selection = prepared?.selection
  if (prepared.installRoot !== own.root || prepared.installation_id !== own.record.installation_id
    || selection?.schema_version !== 1 || typeof selection.gui_id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(selection.gui_id)
    || typeof selection.core_id !== 'string' || !/^[a-f0-9]{64}$/.test(selection.core_id)
    || prepared.coreRoot !== path.join(own.root, 'releases', selection.core_id)
    || prepared.guiRoot !== path.join(own.root, 'app/releases', selection.gui_id)
    || prepared.proof?.file !== path.join(own.root, 'app/payloads', selection.gui_id + '.json')
    || !/^[a-f0-9]{64}$/.test(prepared.proof?.sha256 ?? '')) fail('已准备版本的安装绑定无法核验。')
  management.requirePrivateDataRoot(path.dirname(prepared.proof.file))
  const file = prepared.proof.file, stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024
    || (process.platform === 'win32' ? !identity.isPrivateFile(file) : stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600)) fail('已准备版本的完整清单无法核验。')
  const text = await fs.readFile(file, 'utf8')
  if (createHash('sha256').update(text).digest('hex') !== prepared.proof.sha256) fail('已准备版本的完整清单发生变化。')
  const record = JSON.parse(text)
  if (!same(record.selection, selection)) fail('已准备版本对与清单不一致。')
  await verifyDesktopPrograms(prepared.coreRoot, prepared.guiRoot, record)
  return own
}
export async function prepareDesktopPair({ payload, installRoot, signal, progress = () => {} }) {
  progress('verifying')
  const source = await verifyDesktopPayload(payload, { signal }), own = installation.readDesktopSelection(installRoot)
  const relative = path.relative(source.directory, own.root)
  if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) fail('更新载荷不能包含当前安装根。')
  const lock = await acquireCliLock(own.root, 'prepare-desktop-pair')
  let staging, preparationError
  try {
    unchanged(own)
    if (readVersionMaintenance(own.dataDir)) fail('当前数据维护尚未完成，请先检查恢复。')
    if (same(own.selection, source.record.selection)) fail('当前已选择这个版本对。')
    const selection = source.record.selection, coreRoot = path.join(own.root, 'releases', selection.core_id)
    const guiRoot = path.join(own.root, 'app/releases', selection.gui_id)
    const coreCached = Boolean(await present(coreRoot)), guiCached = Boolean(await present(guiRoot))
    // Reuse only exact immutable bytes, including any identity shared with the
    // current pair. Online preparation never repairs or overwrites a program.
    if (coreCached || guiCached) await verifyDesktopPrograms(coreCached ? coreRoot : source.coreRoot, guiCached ? guiRoot : source.guiRoot, source.record, { signal })
    const guiBytes = Object.values(source.record.gui).reduce((sum, file) => sum + BigInt(file.size ?? 0), 0n)
    const needed = (coreCached ? 0n : source.bytes - guiBytes) + (guiCached ? 0n : guiBytes)
    const space = await fs.statfs(own.root, { bigint: true })
    if (space.bavail * space.bsize < needed + 512n * 1024n * 1024n) throw Object.assign(new Error('更新准备空间不足，当前实例保持。'), { code: 'CRABOT_UPDATE_SPACE' })
    signal?.throwIfAborted(); progress('copying')
    if (!coreCached || !guiCached) {
      staging = await fs.mkdtemp(path.join(own.root, '.preparing-pair-'))
      const programs = []
      if (!coreCached) programs.push({ name: 'core', target: coreRoot })
      if (!guiCached) programs.push({ name: 'gui', target: guiRoot })
      const copied = await Promise.allSettled(programs.map(({ name }) => fs.cp(path.join(source.directory, name), path.join(staging, name),
        { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, filter: () => { signal?.throwIfAborted(); return true } })))
      const failed = copied.find(result => result.status === 'rejected'); if (failed) throw failed.reason
      await verifyDesktopPrograms(coreCached ? coreRoot : path.join(staging, 'core'), guiCached ? guiRoot : path.join(staging, 'gui'), source.record, { signal })
      unchanged(own)
      for (const { name, target } of programs) {
        signal?.throwIfAborted()
        if (await present(target)) fail('未选程序在准备期间出现，原目录保留。')
        await fs.rename(path.join(staging, name), target)
      }
    }
    await verifyDesktopPrograms(coreRoot, guiRoot, source.record, { signal })
    const proof = await storeProof(own.root, source.record)
    // The target is already at its final path. A preview cannot bind temporary
    // script paths, create a backup, execute a script or prove offline state.
    progress('previewing')
    const preview = await previewMigrations(coreRoot, own.dataDir)
    await verifyDesktopPrograms(coreRoot, guiRoot, source.record, { signal })
    unchanged(own); progress('prepared'); signal?.throwIfAborted(); unchanged(own)
    return { installRoot: own.root, installation_id: own.record.installation_id, source: own.selection, selection,
      coreRoot, guiRoot, proof, preview }
  } catch (error) { preparationError = error; throw error }
  finally {
    try { if (staging) await fs.rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
    catch (error) { if (preparationError) throw new AggregateError([preparationError, error], '更新准备与暂存清理未完成，原版本和错误已保留。'); throw error }
    finally { releaseCliLock(lock) }
  }
}
