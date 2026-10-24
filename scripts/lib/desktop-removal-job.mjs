// Initial private-GUI transaction only. No program deletion, service stop,
// executable loading or recovery from an existing removal job occurs here.
import path from 'node:path'
import physicalFs from './physical-fs.cjs'
import identity from './process-identity.cjs'
import installation from './desktop-installation.cjs'
import management from './desktop-management.cjs'
import { captureInitialRemovalGuiHost } from './desktop-removal-frame.mjs'
import { acquireExistingCliLock, releaseCliLock, cliLockToken } from './cli-lock.mjs'
import { readDesktopRemoval } from './desktop-removal-record.cjs'
import { readDesktopRemovalProof } from './desktop-removal-proof.mjs'
import { readOriginalDesktopPayload } from './desktop-program-proof.mjs'
import { privateJson } from './desktop-preparation-files.mjs'
import { verifyDesktopPrograms } from './desktop-payload.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { workspaceMaintenancePending } from './workspace-maintenance.cjs'
const { promises: fs } = physicalFs
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const directoryIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
const fail = () => { throw Object.assign(new Error('卸载作业或停止结果无法核验，原程序、用户数据和保护已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
function absent(file) {
  try { physicalFs.lstatSync(file); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}
export async function beginInitialDesktopRemoval({ installRoot, operationId, signal }) {
  const own = installation.readDesktopSelection(installRoot)
  const rootLock = await acquireExistingCliLock(own.root, 'desktop-removal'), rootToken = cliLockToken(rootLock)
  let dataLock, dataToken, job, closed = false, busy = false, cancelIssued = false
  const close = () => {
    if (busy) fail()
    if (dataToken && cliLockToken(dataLock) === dataToken) releaseCliLock(dataLock)
    if (rootToken && cliLockToken(rootLock) === rootToken) releaseCliLock(rootLock)
    closed = true
  }
  try {
    dataLock = await acquireExistingCliLock(own.dataDir, 'desktop-removal'); dataToken = cliLockToken(dataLock)
    const dataIdentity = directoryIdentity(await fs.lstat(own.dataDir, { bigint: true }))
    const captured = await captureInitialRemovalGuiHost({ installRoot: own.root, operationId, signal })
    const { proof, facts } = captured
    const record = { schema_version: 1, installation_id: own.record.installation_id, operation_id: operationId,
      source_selection: proof.source_selection, phase: 'preparing', proof_sha256: facts.proof_sha256 }
    const fence = path.join(own.root, '.desktop-removal.json')
    const current = async (published = true) => {
      if (published && !same((await readDesktopRemovalProof(own.root)).record, record)) fail()
      const actualDataIdentity = directoryIdentity(await fs.lstat(own.dataDir, { bigint: true }))
      if (job) for (const [directory, original] of job) {
        if (management.requirePrivateDataRoot(directory) !== directory || directoryIdentity(physicalFs.lstatSync(directory, { bigint: true })) !== original) fail()
      }
      if (closed || !rootToken || !dataToken || cliLockToken(rootLock) !== rootToken || cliLockToken(dataLock) !== dataToken
        || actualDataIdentity !== dataIdentity || !same(installation.readDesktopInstallation(own.root).record, own.record)
        || !same(installation.readDesktopPairReference(own.root).selection, record.source_selection)
        || !identity.sameProcess(facts.host_gui, identity.inspectProcess(process.pid))
        || !absent(path.join(own.dataDir, 'desktop-maintenance.json')) || workspaceMaintenancePending(own.dataDir)
        || !absent(path.join(own.root, '.desktop-installing.json'))
        || (published ? !same(readDesktopRemoval(own.root), record) : !absent(fence))) fail()
      return structuredClone(record)
    }
    await current(false); signal?.throwIfAborted()
    // Establish a fresh fixed job directory exclusively; never adopt old material.
    const parent = management.ensurePrivateDataRoot(path.join(own.root, 'app/removals'))
    const directory = path.join(parent, operationId)
    if (process.platform === 'win32') identity.createPrivateDirectory(directory)
    else await fs.mkdir(directory, { mode: 0o700 })
    if (management.requirePrivateDataRoot(directory) !== directory) fail()
    job = [parent, directory].map(directory => [directory, directoryIdentity(physicalFs.lstatSync(directory, { bigint: true }))])
    await current(false); signal?.throwIfAborted()
    await privateJson(path.join(directory, 'proof.json'), proof)
    await current(false); signal?.throwIfAborted()
    // A lost publication reply preserves both proof and fence. Releasing locks
    // is never interpreted as cancellation, even before any service was stopped.
    await privateJson(fence, record)
    await current()
    return {
      record: structuredClone(record),
      current: () => current(),
      async cancel() {
        if (busy) fail()
        busy = true
        try {
          const checkCancellation = () => current(!cancelIssued || !absent(fence))
          await checkCancellation()
          await verifyDesktopPrograms(own.coreRoot, own.guiRoot, proof.payload)
          const source = await readOriginalDesktopPayload(own.root, record.source_selection)
          if (!same(source.record, proof.payload)) fail()
          const records = path.join(own.dataDir, 'module-runtime-registry/records')
          let names
          try { names = await fs.readdir(records) } catch (error) { if (error.code !== 'ENOENT') throw error; names = [] }
          if (names.some(name => name.endsWith('.json')) || inspectInstance(own.dataDir).state !== 'stopped') fail()
          await checkCancellation()
          // Final synchronous stop/record checks directly precede the unlink.
          if (inspectInstance(own.dataDir).state !== 'stopped'
            || !absent(records) && physicalFs.readdirSync(records).some(name => name.endsWith('.json'))) fail()
          if (!absent(fence)) { cancelIssued = true; await fs.unlink(fence) }
          if (process.platform !== 'win32') {
            const root = await fs.open(own.root, 'r'); try { await root.sync() } finally { await root.close() }
          }
          await current(false)
        } catch { fail() } finally { busy = false }
      },
      close,
    }
  } catch (error) { close(); throw error }
}
