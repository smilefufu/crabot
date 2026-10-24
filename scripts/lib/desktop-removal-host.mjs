// Copy the verified macOS/Windows GUI only. This prepares no removal job and
// executes nothing; the independent lifecycle host still owns stop and deletion.
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import physicalFs from './physical-fs.cjs'
import management from './desktop-management.cjs'
import installation from './desktop-installation.cjs'
import { captureDesktopRemovalProof, readDesktopRemovalProof } from './desktop-removal-proof.mjs'
import { readOriginalDesktopPayload } from './desktop-program-proof.mjs'
import { verifyDesktopGui } from './desktop-payload.mjs'
import { acquireExistingCliLock, releaseCliLock, cliLockToken } from './cli-lock.mjs'
import { workspaceMaintenancePending } from './workspace-maintenance.cjs'
const { promises: fs, constants } = physicalFs
const fail = () => { throw Object.assign(new Error('卸载维护程序尚未准备完成，原应用与用户数据已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const directoryIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
async function versionMaintenancePending(dataDir) {
  try { await fs.lstat(path.join(dataDir, 'desktop-maintenance.json')); return true }
  catch (error) { return error.code !== 'ENOENT' }
}
export async function prepareDesktopRemovalGui({ installRoot, operationId, signal, progress = () => {} }) {
  if (process.platform !== 'darwin' && process.platform !== 'win32') fail()
  const own = installation.readDesktopSelection(installRoot), lock = await acquireExistingCliLock(own.root, 'prepare-removal-host'), token = cliLockToken(lock)
  try {
    const proof = await captureDesktopRemovalProof(own.root, operationId, { signal })
    const original = await readOriginalDesktopPayload(own.root, own.selection)
    const dataIdentity = directoryIdentity(await fs.lstat(own.dataDir, { bigint: true }))
    const current = async () => {
      if (!token || cliLockToken(lock) !== token) fail()
      const actual = installation.readDesktopSelection(own.root), source = await readOriginalDesktopPayload(own.root, own.selection)
      if (!same(actual.record, own.record) || !same(actual.selection, proof.source_selection) || !same(own.selection, proof.source_selection)
        || source.file !== original.file || source.text !== original.text || !same(source.record, proof.payload)
        || directoryIdentity(await fs.lstat(own.dataDir, { bigint: true })) !== dataIdentity
        || await versionMaintenancePending(own.dataDir) || workspaceMaintenancePending(own.dataDir) || cliLockToken(lock) !== token) fail()
    }
    await current(); signal?.throwIfAborted()
    return await copyRemovalGui(own, proof, current, signal, progress)
  } finally { if (token && cliLockToken(lock) === token) releaseCliLock(lock) }
}

// Same neutral byte-copy operation for independently verified role contexts.
async function copyRemovalGui(own, proof, current, signal, progress) {
  let directory, createdIdentity
  try {
    const bytes = Object.values(proof.payload.gui).reduce((sum, file) => sum + BigInt(file.size ?? 0), 0n)
    const parent = await fs.realpath(tmpdir()), space = await fs.statfs(parent, { bigint: true })
    if (space.bavail * space.bsize < bytes + 512n * 1024n * 1024n) throw Object.assign(new Error('临时维护程序空间不足，原应用和数据已保留。'), { code: 'CRABOT_UPDATE_SPACE' })
    directory = management.ensurePrivateDataRoot(path.join(parent, 'crabot-removal-host-' + randomUUID()))
    createdIdentity = directoryIdentity(await fs.lstat(directory, { bigint: true }))
    const guiRoot = path.join(directory, 'gui')
    progress('copying'); signal?.throwIfAborted(); await current()
    await fs.cp(own.guiRoot, guiRoot, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
      filter: () => { signal?.throwIfAborted(); return true } })
    await current(); progress('prepared'); signal?.throwIfAborted()
    await verifyDesktopGui(guiRoot, proof.payload, { signal }); await current()
    if (management.requirePrivateDataRoot(directory) !== directory || directoryIdentity(await fs.lstat(directory, { bigint: true })) !== createdIdentity) fail()
    signal?.throwIfAborted()
    return { directory, guiRoot, executable: path.join(guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : 'Crabot.exe'), proof }
  } catch (error) {
    if (directory) {
      try {
        if (!createdIdentity || management.requirePrivateDataRoot(directory) !== directory || directoryIdentity(await fs.lstat(directory, { bigint: true })) !== createdIdentity) fail()
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch (cleanup) { throw new AggregateError([error, cleanup], '维护副本准备与清理未完成，保留原应用、数据和诊断。') }
    }
    throw error
  }
}

// Continue only an already published job. Its proof describes old bytes; this
// prepares a GUI copy and never loads the missing/partially removed Core.
export async function prepareExistingDesktopRemovalGui({ installRoot, operationId, signal, progress = () => {} }) {
  if (!['darwin', 'win32'].includes(process.platform)) fail()
  const installationRoot = installation.readDesktopInstallation(installRoot)
  const own = { ...installationRoot, guiRoot: path.join(installationRoot.root, 'app/releases', installation.readDesktopPairReference(installRoot).selection.gui_id) }
  const lock = await acquireExistingCliLock(own.root, 'prepare-existing-removal-host'), token = cliLockToken(lock)
  try {
    const original = await readDesktopRemovalProof(own.root), { record, proof } = original
    if (record.operation_id !== operationId || !same(installation.readDesktopPairReference(own.root).selection, record.source_selection)) fail()
    const dataIdentity = directoryIdentity(await fs.lstat(own.dataDir, { bigint: true }))
    const current = async () => {
      if (!token || cliLockToken(lock) !== token) fail()
      const actual = await readDesktopRemovalProof(own.root)
      if (!same(actual.record, record) || !same(actual.proof, proof)
        || !same(installation.readDesktopInstallation(own.root).record, own.record)
        || !same(installation.readDesktopPairReference(own.root).selection, record.source_selection)
        || directoryIdentity(await fs.lstat(own.dataDir, { bigint: true })) !== dataIdentity
        || await versionMaintenancePending(own.dataDir) || workspaceMaintenancePending(own.dataDir)
        || cliLockToken(lock) !== token) fail()
    }
    await current(); signal?.throwIfAborted()
    await verifyDesktopGui(own.guiRoot, proof.payload, { signal }); await current()
    return { ...await copyRemovalGui(own, proof, current, signal, progress), record }
  } finally { if (token && cliLockToken(lock) === token) releaseCliLock(lock) }
}
