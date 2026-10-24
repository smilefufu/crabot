// Exact selected program bytes only. The independent caller owns real GUI and
// program-exit proof; no source/target Core code, migration or MM is executed.
import physicalFs from './physical-fs.cjs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import identity from './process-identity.cjs'
import installation from './desktop-installation.cjs'
import { acquireCliLock, releaseCliLock, cliLockToken } from './cli-lock.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { verifyDesktopPayload, verifyDesktopPrograms } from './desktop-payload.mjs'
import { pendingName, payloadName, readPending, privateJson, publishPreparedProgram } from './desktop-preparation-files.mjs'
const { promises: fs, constants } = physicalFs
const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_DESKTOP_INSTALLATION' }) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const digest = text => createHash('sha256').update(text).digest('hex')
const version = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':')
const directoryIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function originalProof(root, selection) {
  let file = path.join(root, payloadName)
  const directory = path.join(root, 'app/payloads'), parent = await present(directory)
  if (parent) {
    if (!parent.isDirectory() || parent.isSymbolicLink() || (process.platform === 'win32'
      ? !identity.isPrivateDirectory(directory) : parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700)) fail('原程序清单目录无法核验，已保留安装。')
    const current = path.join(directory, selection.gui_id + '.json')
    if (await present(current)) file = current
  }
  let before
  try { before = await fs.lstat(file, { bigint: true }) }
  catch (error) { if (error.code === 'ENOENT') fail('原程序完整清单缺失，已保留原安装与数据。'); throw error }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 64n * 1024n * 1024n
    || (process.platform === 'win32' ? !identity.isPrivateFile(file) : before.uid !== BigInt(process.getuid()) || (before.mode & 0o777n) !== 0o600n)) fail('原程序完整清单无法核验，已保留安装。')
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let text
  try {
    if (version(await handle.stat({ bigint: true })) !== version(before)) fail('原程序清单已变化。')
    text = await handle.readFile('utf8')
    if (version(await handle.stat({ bigint: true })) !== version(before) || version(await fs.lstat(file, { bigint: true })) !== version(before)) fail('原程序清单已变化。')
  } finally { await handle.close() }
  let record
  try { record = JSON.parse(text) } catch { fail('原程序清单损坏，未按新安装覆盖。') }
  if (!record || !same(record.selection, selection) || text !== JSON.stringify(record) + '\n') fail('原程序清单与当前版本对不一致。')
  return { file, text, record, sha256: digest(text) }
}
async function context(root, verifyStopped) {
  if (typeof verifyStopped !== 'function') fail('修复前必须核实共享实例和应用程序已停止。')
  const own = installation.readDesktopInstallation(root), reference = installation.readDesktopPairReference(root)
  const dataIdentity = directoryIdentity(await fs.lstat(own.dataDir, { bigint: true })), proof = await originalProof(own.root, reference.selection)
  const current = async () => {
    if (!same(installation.readDesktopInstallation(own.root).record, own.record)
      || !same(installation.readDesktopPairReference(own.root), reference)
      || directoryIdentity(await fs.lstat(own.dataDir, { bigint: true })) !== dataIdentity) fail('安装或数据目录身份已变化，原文件已保留。')
    const actual = await originalProof(own.root, reference.selection)
    if (actual.file !== proof.file || actual.text !== proof.text) fail('原程序证明已变化，未继续修复。')
  }
  return { own, reference, proof, current, verifyStopped }
}
async function withStoppedRepair(ctx, operation) {
  const rootLock = await acquireCliLock(ctx.own.root, 'desktop-repair-programs'), rootToken = cliLockToken(rootLock)
  let dataLock, dataToken
  try {
    dataLock = await acquireCliLock(ctx.own.dataDir, 'desktop-repair-programs'); dataToken = cliLockToken(dataLock)
    const stopped = async () => {
      if (!rootToken || !dataToken || cliLockToken(rootLock) !== rootToken || cliLockToken(dataLock) !== dataToken) fail('修复操作锁已变化。')
      await ctx.current()
      if (inspectInstance(ctx.own.dataDir).state !== 'stopped') fail('共享实例尚未停止，请退出 Crabot 后重试修复。')
      await ctx.verifyStopped(); await ctx.current()
      if (cliLockToken(rootLock) !== rootToken || cliLockToken(dataLock) !== dataToken
        || inspectInstance(ctx.own.dataDir).state !== 'stopped') fail('修复停止证明已变化，原文件已保留。')
    }
    await stopped()
    return await operation(stopped)
  } finally { if (dataLock) releaseCliLock(dataLock); releaseCliLock(rootLock) }
}
function matchingPending(state, ctx) {
  if (state && (state.installation_id !== ctx.own.record.installation_id || !same(state.selection, ctx.reference.selection)
    || state.payload_sha256 !== ctx.proof.sha256)) fail('另一程序准备尚未完成，已保留原记录。')
}
function preparedFor(ctx) {
  return { installRoot: ctx.own.root, installation_id: ctx.own.record.installation_id, selection: ctx.reference.selection,
    coreRoot: path.join(ctx.own.root, 'releases', ctx.reference.selection.core_id), guiRoot: path.join(ctx.own.root, 'app/releases', ctx.reference.selection.gui_id) }
}
export async function prepareDesktopRepair({ payload, installRoot, verifyStopped, signal, progress = () => {} }) {
  progress('verifying')
  const source = await verifyDesktopPayload(payload, { signal }), ctx = await context(installRoot, verifyStopped)
  if (inside(source.directory, ctx.own.root) || inside(ctx.own.root, source.directory)
    || JSON.stringify(source.record) + '\n' !== ctx.proof.text) fail('此组件仅修复原完整清单完全相同的版本对，请使用对应离线包。')
  return withStoppedRepair(ctx, async stopped => {
    const previous = await readPending(ctx.own.root); matchingPending(previous, ctx)
    const space = await fs.statfs(ctx.own.root, { bigint: true })
    if (space.bavail * space.bsize < source.bytes + 512n * 1024n * 1024n) throw Object.assign(new Error('修复空间不足，原程序和数据已保留。'), { code: 'CRABOT_UPDATE_SPACE' })
    signal?.throwIfAborted()
    const staging = await fs.mkdtemp(path.join(ctx.own.root, '.preparing-repair-')), prepared = preparedFor(ctx)
    let preparationError
    try {
      progress('copying')
      const results = await Promise.allSettled(['gui', 'core'].map(name => fs.cp(path.join(source.directory, name), path.join(staging, name),
        { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, filter: () => { signal?.throwIfAborted(); return true } })))
      const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason
      await verifyDesktopPrograms(path.join(staging, 'core'), path.join(staging, 'gui'), ctx.proof.record, { signal })
      await stopped(); signal?.throwIfAborted(); progress('repairing'); signal?.throwIfAborted()
      const state = previous ?? { schema_version: 1, id: randomUUID(), installation_id: prepared.installation_id,
        selection: prepared.selection, phase: 'preparing', payload_sha256: ctx.proof.sha256 }
      if (!previous) await privateJson(path.join(ctx.own.root, pendingName), state)
      const publicationCurrent = async () => {
        await stopped()
        if (!same(await readPending(ctx.own.root), state)) fail('程序准备记录已变化，原程序和数据已保留。')
      }
      // Cancellation ends at the publication boundary; an interrupted process
      // retains the original fence and can reverify this exact pair on retry.
      for (const [name, target] of [['core', prepared.coreRoot], ['gui', prepared.guiRoot]]) {
        await publicationCurrent()
        await publishPreparedProgram(path.join(staging, name), target, undefined, () => verifyDesktopPrograms(
          name === 'core' ? target : prepared.coreRoot, name === 'gui' ? target : path.join(staging, 'gui'), ctx.proof.record))
      }
      await publicationCurrent(); await verifyDesktopPrograms(prepared.coreRoot, prepared.guiRoot, ctx.proof.record); await publicationCurrent()
      await privateJson(path.join(ctx.own.root, pendingName), { ...state, phase: 'prepared' }, true)
      progress('prepared'); return prepared
    } catch (error) { preparationError = error; throw error }
    finally {
      try { await fs.rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
      catch (error) { if (preparationError) throw new AggregateError([preparationError, error], '修复与临时文件清理未完成，原数据和保护已保留。'); throw error }
    }
  })
}
export async function commitDesktopRepair(prepared, { verifyStopped }) {
  const ctx = await context(prepared.installRoot, verifyStopped)
  const expected = preparedFor(ctx)
  if (Object.keys(prepared).length !== Object.keys(expected).length || Object.keys(expected).some(key => !same(prepared[key], expected[key]))) fail('修复目标与原版本对不一致。')
  return withStoppedRepair(ctx, async stopped => {
    const state = await readPending(ctx.own.root); matchingPending(state, ctx)
    if (!state || state.phase !== 'prepared') fail('运行文件修复尚未准备完成。')
    await verifyDesktopPrograms(prepared.coreRoot, prepared.guiRoot, ctx.proof.record); await stopped()
    if (!same(await readPending(ctx.own.root), state)) fail('修复准备记录已变化。')
    await fs.unlink(path.join(ctx.own.root, pendingName))
    if (process.platform !== 'win32') { const directory = await fs.open(ctx.own.root, 'r'); try { await directory.sync() } finally { await directory.close() } }
    return installation.readDesktopSelection(ctx.own.root)
  })
}
