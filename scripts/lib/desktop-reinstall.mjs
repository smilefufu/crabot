// Program restoration only, inside an existing removal fence. The trusted
// installer owns source authenticity and actual program-exit proof. No Core,
// data migration, version selection, business startup or completion runs here.
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import physical from './physical-fs.cjs'
import identity from './process-identity.cjs'
import installation from './desktop-installation.cjs'
import management from './desktop-management.cjs'
import { acquireExistingCliLock, releaseCliLock, cliLockToken, hasInheritedCliLock } from './cli-lock.mjs'
import { readDesktopRemoval } from './desktop-removal-record.cjs'
import { readDesktopRemovalProof } from './desktop-removal-proof.mjs'
import { matchesDesktopRemovalProgram } from './desktop-removal-programs.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { verifyDesktopPayload, verifyDesktopPrograms, verifyDesktopGui } from './desktop-payload.mjs'
import { privateJson, readPending, pendingName, publishPreparedProgram } from './desktop-preparation-files.mjs'
const { promises: fs, constants } = physical
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const fileIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
const directoryIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
const digest = text => createHash('sha256').update(text).digest('hex')
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const fail = () => { throw Object.assign(new Error('原安装、卸载作业或程序恢复条件无法核验，数据和维护保护已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
async function present(file) { try { return await fs.lstat(file, { bigint: true }) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
export async function prepareDesktopRemovalReinstall({ payload, installRoot, operationId, verifyStopped, signal, progress = () => {} }) {
  if (typeof verifyStopped !== 'function') fail()
  progress('verifying')
  const source = await verifyDesktopPayload(payload, { signal }), own = installation.readDesktopInstallation(installRoot)
  if (inside(source.directory, own.root) || inside(own.root, source.directory)) fail()
  const rootLock = await acquireExistingCliLock(own.root, 'desktop-removal-reinstall'), rootToken = cliLockToken(rootLock)
  let dataLock, dataToken, staging, preparationError
  try {
    dataLock = await acquireExistingCliLock(own.dataDir, 'desktop-removal-reinstall'); dataToken = cliLockToken(dataLock)
    const initial = await readDesktopRemovalProof(own.root), { proof, record } = initial
    if (record.operation_id !== operationId || record.installation_id !== own.record.installation_id
      || !same(installation.readDesktopPairReference(own.root).selection, record.source_selection)
      || !same(source.record, proof.payload)) fail()
    const proofDirectory = path.join(own.root, 'app/removals', operationId), proofFile = path.join(proofDirectory, 'proof.json')
    const proofIdentity = fileIdentity(physical.lstatSync(proofFile, { bigint: true }))
    const roots = [path.dirname(proofDirectory), proofDirectory, own.root, ...['app', 'app/releases', 'releases', 'bin', 'data'].map(name => path.join(own.root, name))]
    const directories = roots.map(directory => [directory, directoryIdentity(physical.lstatSync(directory, { bigint: true }))])
    const owned = (file, stat) => process.platform === 'win32' ? identity.isOwnedFile(file) : stat.uid === BigInt(process.getuid())
    const match = async (file, expected, requireOwner = true) => {
      const stat = await present(file)
      return stat && await matchesDesktopRemovalProgram(file, expected, stat, { owned: requireOwner ? owned : () => true })
    }
    // Compare the historical metadata too, with bounded streaming reads. The
    // Core inventory digest alone does not cover all three metadata files.
    const verifyMetadata = async (root, requireOwner) => {
      for (const [key, name] of [['release', 'core-release.json'], ['inventory', 'core-files.json'], ['host', 'desktop-host.json']]) {
        const text = proof.core[key]
        if (!await match(path.join(root, name), { type: 'file', size: Buffer.byteLength(text), sha256: digest(text) }, requireOwner)) fail()
      }
    }
    await verifyMetadata(path.join(source.directory, 'core'), false)
    const commandName = process.platform === 'win32' ? 'crabot.exe' : 'crabot'
    const commandProof = JSON.parse(proof.core.inventory).files['bin/' + commandName]
    if (commandProof?.type !== 'file') fail()
    const checkCommand = async () => { if (await present(own.command) && !await match(own.command, commandProof)) fail() }
    const payloadText = JSON.stringify(source.record) + '\n', payloadSha = digest(payloadText)
    let pending = await readPending(own.root)
    if (pending && (pending.installation_id !== own.record.installation_id || !same(pending.selection, record.source_selection) || pending.payload_sha256 !== payloadSha)) fail()
    const prepared = { installRoot: own.root, installation_id: own.record.installation_id, selection: record.source_selection,
      coreRoot: path.join(own.root, 'releases', record.source_selection.core_id), guiRoot: path.join(own.root, 'app/releases', record.source_selection.gui_id) }
    const assertCurrent = () => {
      if (!same(readDesktopRemoval(own.root), record) || fileIdentity(physical.lstatSync(proofFile, { bigint: true })) !== proofIdentity
        || !same(installation.readDesktopInstallation(own.root).record, own.record)
        || !same(installation.readDesktopPairReference(own.root).selection, record.source_selection)
        || directories.some(([directory, expected]) => directoryIdentity(physical.lstatSync(directory, { bigint: true })) !== expected)
        || !rootToken || !dataToken || cliLockToken(rootLock) !== rootToken || cliLockToken(dataLock) !== dataToken
        || !hasInheritedCliLock(own.root, rootToken) || !hasInheritedCliLock(own.dataDir, dataToken)
        || inspectInstance(own.dataDir).state !== 'stopped') fail()
      try { if (physical.readdirSync(path.join(own.dataDir, 'module-runtime-registry/records')).some(name => name.endsWith('.json'))) fail() }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      for (const directory of [prepared.coreRoot, prepared.guiRoot]) {
        let stat
        try { stat = physical.lstatSync(directory) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
        if (!stat.isDirectory() || stat.isSymbolicLink() || !identity.isOwnedDirectory(directory)) fail()
      }
    }
    const current = async () => {
      assertCurrent()
      if (!same(await readDesktopRemovalProof(own.root), initial) || !same(await readPending(own.root), pending)) fail()
      assertCurrent()
    }
    const stopped = async () => { await current(); await verifyStopped(); await current() }
    await stopped(); await checkCommand(); await current()
    const verified = async check => { try { await check(); return true } catch { signal?.throwIfAborted(); return false } }
    const coreCached = await verified(async () => {
      await verifyDesktopPrograms(prepared.coreRoot, path.join(source.directory, 'gui'), proof.payload, { signal })
      await verifyMetadata(prepared.coreRoot, true)
    })
    const guiCached = await verified(() => verifyDesktopGui(prepared.guiRoot, proof.payload, { signal }))
    await stopped(); await checkCommand(); await current()
    const guiBytes = Object.values(proof.payload.gui).reduce((sum, entry) => sum + BigInt(entry.size ?? 0), 0n)
    const needed = (coreCached ? 0n : source.bytes - guiBytes) + (guiCached ? 0n : guiBytes)
    const space = await fs.statfs(own.root, { bigint: true })
    if (space.bavail * space.bsize < needed + 512n * 1024n * 1024n) throw Object.assign(new Error('修复空间不足，原数据和保护已保留。'), { code: 'CRABOT_UPDATE_SPACE' })
    signal?.throwIfAborted()
    const programs = []
    if (!coreCached) programs.push(['core', prepared.coreRoot])
    if (!guiCached) programs.push(['gui', prepared.guiRoot])
    progress('copying'); signal?.throwIfAborted()
    if (programs.length) {
      staging = await fs.mkdtemp(path.join(own.root, '.preparing-reinstall-'))
      const copies = await Promise.allSettled(programs.map(([name]) => fs.cp(path.join(source.directory, name), path.join(staging, name),
        { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, filter: () => { signal?.throwIfAborted(); return true } })))
      const failed = copies.find(result => result.status === 'rejected'); if (failed) throw failed.reason
    }
    await verifyDesktopPrograms(coreCached ? prepared.coreRoot : path.join(staging, 'core'),
      guiCached ? prepared.guiRoot : path.join(staging, 'gui'), proof.payload, { signal })
    await stopped(); await checkCommand(); await current(); signal?.throwIfAborted()
    progress('restoring'); signal?.throwIfAborted(); await current()
    if (!pending) {
      pending = { schema_version: 1, id: randomUUID(), installation_id: own.record.installation_id,
        selection: record.source_selection, phase: 'preparing', payload_sha256: payloadSha }
      await privateJson(path.join(own.root, pendingName), pending)
    }
    // The removal fence stays throughout. From this boundary cancellation cannot
    // undo restored program publications; the same package can reverify them.
    for (const [name, target] of programs) {
      await stopped()
      await publishPreparedProgram(path.join(staging, name), target, undefined, async () => {
        await verifyDesktopPrograms(prepared.coreRoot, name === 'gui' || guiCached ? prepared.guiRoot : path.join(staging, 'gui'), proof.payload)
        await verifyMetadata(prepared.coreRoot, true)
      })
    }
    await stopped(); await checkCommand(); await current()
    if (!await present(own.command)) {
      await fs.copyFile(path.join(prepared.coreRoot, 'bin', commandName), own.command, constants.COPYFILE_EXCL)
      if (process.platform !== 'win32') await fs.chmod(own.command, 0o755)
    }
    await stopped(); await checkCommand()
    await verifyDesktopPrograms(prepared.coreRoot, prepared.guiRoot, proof.payload); await verifyMetadata(prepared.coreRoot, true); await stopped()
    const cache = management.ensurePrivateDataRoot(path.join(own.root, 'app/payloads')), file = path.join(cache, record.source_selection.gui_id + '.json')
    const stat = await present(file)
    if (stat) {
      if ((process.platform === 'win32' ? !identity.isPrivateFile(file) : (stat.mode & 0o777n) !== 0o600n)
        || !await match(file, { type: 'file', size: Buffer.byteLength(payloadText), sha256: payloadSha, ...(process.platform === 'win32' ? {} : { mode: 0o600 }) })
        || process.platform === 'win32' && !identity.isPrivateFile(file)) fail()
    } else { await current(); await privateJson(file, source.record) }
    await stopped()
    pending = { ...pending, phase: 'prepared' }
    await privateJson(path.join(own.root, pendingName), pending, true)
    await current(); progress('prepared')
    return prepared
  } catch (error) { preparationError = error; throw error }
  finally {
    try { if (staging) await fs.rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
    catch (error) { if (preparationError) throw new AggregateError([preparationError, error], '程序恢复和暂存清理未完成，数据及保护已保留。'); throw error }
    finally {
      if (dataToken && cliLockToken(dataLock) === dataToken) releaseCliLock(dataLock)
      if (rootToken && cliLockToken(rootLock) === rootToken) releaseCliLock(rootLock)
    }
  }
}
