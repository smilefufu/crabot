// Separate verified host roles share only the neutral job, mutex, normal stop
// and exit observation. Host admission and byte checks remain role-specific.
import path from 'node:path'
import physicalFs from './physical-fs.cjs'
import identity from './process-identity.cjs'
import installation from './desktop-installation.cjs'
import management from './desktop-management.cjs'
import { captureInitialRemovalGuiHost, captureExistingRemovalGuiHost, captureInitialRemovalNodeHost, captureExistingRemovalNodeHost } from './desktop-removal-frame.mjs'
import { verifyUbuntuRemovalNodeCopy } from './desktop-removal-host.mjs'
import { acquireExistingCliLock, releaseCliLock, cliLockToken } from './cli-lock.mjs'
import { readDesktopRemoval } from './desktop-removal-record.cjs'
import { readDesktopRemovalProof } from './desktop-removal-proof.mjs'
import { readOriginalDesktopPayload } from './desktop-program-proof.mjs'
import { privateJson } from './desktop-preparation-files.mjs'
import { verifyDesktopGui, verifyDesktopPrograms } from './desktop-payload.mjs'
import { inspectInstance } from './instance-runtime.mjs'
import { stopInstance } from './instance-controller.mjs'
import { probeKnownProcessExit } from './known-process-exit.cjs'
import { assertDesktopRemovalProgramsUnused, removeDesktopRemovalPrograms } from './desktop-removal-delete.mjs'
import { captureStoppedDesktopRemoval } from './desktop-removal-context.mjs'
import { inspectDesktopRemovalPrograms } from './desktop-removal-programs.mjs'
import { workspaceMaintenancePending } from './workspace-maintenance.cjs'
const { promises: fs } = physicalFs
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const directoryIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
const fail = () => { throw Object.assign(new Error('卸载作业或停止结果无法核验，剩余程序、用户数据和保护已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
function absent(file) {
  try { physicalFs.lstatSync(file); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}
async function openDesktopRemoval({ installRoot, operationId, signal, preparePlatformRemoval }, existing, role = 'gui') {
  if (preparePlatformRemoval !== undefined && (role !== 'node' || typeof preparePlatformRemoval !== 'function')) fail()
  const base = existing ? installation.readDesktopInstallation(installRoot) : installation.readDesktopSelection(installRoot)
  const selection = existing ? installation.readDesktopPairReference(base.root).selection : base.selection
  const own = { ...base, coreRoot: path.join(base.root, 'releases', selection.core_id), guiRoot: path.join(base.root, 'app/releases', selection.gui_id) }
  const rootLock = await acquireExistingCliLock(own.root, 'desktop-removal'), rootToken = cliLockToken(rootLock)
  let dataLock, dataToken, job, pendingStop, pendingPhase, stopFailed = false, pendingSourceExit, sourceExitFailed = false, closed = false, busy = false, cancelIssued = false
  let pendingRemoval, pendingRemovalPhase, removalFailed = false
  const close = () => {
    if (busy) fail()
    if (dataToken && cliLockToken(dataLock) === dataToken) releaseCliLock(dataLock)
    if (rootToken && cliLockToken(rootLock) === rootToken) releaseCliLock(rootLock)
    closed = true
  }
  try {
    dataLock = await acquireExistingCliLock(own.dataDir, 'desktop-removal'); dataToken = cliLockToken(dataLock)
    const dataIdentity = directoryIdentity(await fs.lstat(own.dataDir, { bigint: true }))
    let capture = captureInitialRemovalGuiHost
    if (role === 'node') capture = existing ? captureExistingRemovalNodeHost : captureInitialRemovalNodeHost
    else if (existing) capture = captureExistingRemovalGuiHost
    const captured = await capture({ installRoot: own.root, operationId, signal })
    const { proof, facts } = captured
    const executable = await fs.realpath(process.execPath)
    const hostGuiRoot = process.platform === 'darwin' ? path.resolve(path.dirname(executable), '../../..') : path.dirname(executable)
    const hostDirectory = role === 'node' ? path.dirname(executable) : path.dirname(hostGuiRoot)
    const hostProcess = role === 'node' ? facts.host_node : facts.host_gui
    const verifyHost = role === 'node' ? () => verifyUbuntuRemovalNodeCopy(hostDirectory, proof) : () => verifyDesktopGui(hostGuiRoot, proof.payload)
    const hostDirectories = (role === 'node' ? [hostDirectory] : [hostDirectory, hostGuiRoot]).map(directory => [directory, directoryIdentity(physicalFs.lstatSync(directory, { bigint: true }))])
    let record = existing ? captured.record : { schema_version: 1, installation_id: own.record.installation_id, operation_id: operationId,
      source_selection: proof.source_selection, phase: 'preparing', proof_sha256: facts.proof_sha256 }
    const fence = path.join(own.root, '.desktop-removal.json')
    const current = async (published = true) => {
      if (published && !same((await readDesktopRemovalProof(own.root)).record, record)) fail()
      const actualDataIdentity = directoryIdentity(await fs.lstat(own.dataDir, { bigint: true }))
      for (const [directory, original] of hostDirectories) {
        if (directoryIdentity(physicalFs.lstatSync(directory, { bigint: true })) !== original) fail()
      }
      if (management.requirePrivateDataRoot(hostDirectory) !== hostDirectory || physicalFs.realpathSync(process.cwd()) !== hostDirectory) fail()
      if (job) for (const [directory, original] of job) {
        if (management.requirePrivateDataRoot(directory) !== directory || directoryIdentity(physicalFs.lstatSync(directory, { bigint: true })) !== original) fail()
      }
      if (closed || !rootToken || !dataToken || cliLockToken(rootLock) !== rootToken || cliLockToken(dataLock) !== dataToken
        || actualDataIdentity !== dataIdentity || !same(installation.readDesktopInstallation(own.root).record, own.record)
        || !same(installation.readDesktopPairReference(own.root).selection, record.source_selection)
        || !identity.sameProcess(hostProcess, identity.inspectProcess(process.pid))
        || !absent(path.join(own.dataDir, 'desktop-maintenance.json')) || workspaceMaintenancePending(own.dataDir)
        || !absent(path.join(own.root, '.desktop-installing.json'))
        || (published ? !same(readDesktopRemoval(own.root), record) : !absent(fence))) fail()
      return structuredClone(record)
    }
    if (existing) {
      const parent = management.requirePrivateDataRoot(path.join(own.root, 'app/removals'))
      const directory = management.requirePrivateDataRoot(path.join(parent, operationId))
      job = [parent, directory].map(directory => [directory, directoryIdentity(physicalFs.lstatSync(directory, { bigint: true }))])
      await current(); signal?.throwIfAborted()
    } else {
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
    }
    const assertStopped = () => {
      if (inspectInstance(own.dataDir).state !== 'stopped') fail()
      const records = path.join(own.dataDir, 'module-runtime-registry/records')
      try { if (physicalFs.readdirSync(records).some(name => name.endsWith('.json'))) fail() }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const requestSourceExit = (retry = false) => {
      if (closed || cancelIssued) fail()
      if (pendingSourceExit && (!retry || !sourceExitFailed)) return pendingSourceExit
      if (retry && !sourceExitFailed) fail()
      if (busy || !pendingStop) fail()
      busy = true; sourceExitFailed = false
      pendingSourceExit = (async () => {
        try {
          await pendingStop; await current(); assertStopped()
          if (retry) {
            await verifyHost()
            await current(); assertStopped()
          }
          const deadline = performance.now() + 15000
          if (probeKnownProcessExit([facts.source_gui]).state === 'running') {
            const self = identity.inspectProcess(process.pid)
            if (!process.connected || typeof process.send !== 'function' || !self || self.parent !== facts.source_gui.pid
              || !identity.sameProcess(facts.source_gui, identity.inspectProcess(facts.source_gui.pid))) fail()
            await new Promise(resolve => {
              const timer = setTimeout(resolve, 5000)
              const sent = () => { clearTimeout(timer); resolve() }
              try { process.send({ kind: 'desktop_removal_source_exit', installation_id: record.installation_id,
                operation_id: record.operation_id, source_selection: record.source_selection }, sent) } catch { sent() }
            })
          }
          // IPC completion/disconnection is not an OS exit receipt. Never signal
          // this GUI, and do not treat its root exit as whole-program settlement.
          for (;;) {
            if (closed || cliLockToken(rootLock) !== rootToken || cliLockToken(dataLock) !== dataToken
              || !same(readDesktopRemoval(own.root), record)) fail()
            if (probeKnownProcessExit([facts.source_gui]).state === 'stopped') break
            if (performance.now() >= deadline) fail()
            await new Promise(resolve => setTimeout(resolve, 100))
          }
          await current(); assertStopped()
          return { source_exited: true }
        } catch (error) { sourceExitFailed = true; throw error } finally { busy = false }
      })()
      return pendingSourceExit
    }
    const requestStop = (retry = false) => {
      if (closed || cancelIssued) fail()
      if (pendingStop && (!retry || !stopFailed)) return pendingStop
      if (retry && !stopFailed) fail()
      if (busy) fail()
      busy = true; stopFailed = false
      pendingStop = (async () => {
        try {
          if (retry) {
            // Only this session's attempted write may explain a lost reply.
            if (pendingPhase) {
              const actual = readDesktopRemoval(own.root)
              if (same(actual, pendingPhase)) record = pendingPhase
              else if (!same(actual, record)) fail()
              pendingPhase = undefined
            }
            await current()
            await verifyHost()
          }
          await current()
          const original = inspectInstance(own.dataDir)
          if (!['running', 'stopped'].includes(original.state) || original.record && original.record.install_root !== own.coreRoot) fail()
          if (record.phase === 'preparing') {
            pendingPhase = { ...record, phase: 'stopping' }
            await privateJson(fence, pendingPhase, true); record = pendingPhase; pendingPhase = undefined
          }
          await current()
          const actual = inspectInstance(own.dataDir)
          if (actual.record && !same(actual.record, original.record)) fail()
          await stopInstance(own.dataDir)
          await current(); assertStopped()
          return { stopped: true }
        } catch (error) { stopFailed = true; throw error } finally { busy = false }
      })()
      return pendingStop
    }
    const requestProgramRemoval = (retry = false, attemptSignal = signal, beforeRemoving) => {
      if (closed || cancelIssued) fail()
      if (pendingRemoval && (!retry || !removalFailed)) return pendingRemoval
      if (retry && !removalFailed) fail()
      if (busy || !pendingStop || !pendingSourceExit || ['preparing', 'completed'].includes(record.phase)) fail()
      busy = true; removalFailed = false
      pendingRemoval = (async () => {
        let platformRemoval, failure
        try {
          await pendingStop; await pendingSourceExit
          if (pendingRemovalPhase) {
            // Only our own attempted removing write may explain a lost reply.
            const actual = readDesktopRemoval(own.root)
            if (same(actual, pendingRemovalPhase)) record = pendingRemovalPhase
            else if (!same(actual, record)) fail()
            pendingRemovalPhase = undefined
          }
          await current(); assertStopped()
          await verifyHost()
          await current(); assertStopped()
          if (probeKnownProcessExit([facts.source_gui]).state !== 'stopped') fail()
          await assertDesktopRemovalProgramsUnused({ installRoot: own.root, proof }, 'before-removing')
          await current(); assertStopped()
          if (probeKnownProcessExit([facts.source_gui]).state !== 'stopped') fail()
          // Authorization is prepared while cancellation still has its original
          // stopping semantics. The fixed host receives no deletion authority.
          if (preparePlatformRemoval) {
            platformRemoval = await preparePlatformRemoval()
            if (!platformRemoval || typeof platformRemoval.remove !== 'function' || typeof platformRemoval.close !== 'function') fail()
            await current(); assertStopped()
            if (probeKnownProcessExit([facts.source_gui]).state !== 'stopped') fail()
          }
          if (record.phase === 'stopping') {
            attemptSignal?.throwIfAborted()
            // The fixed host disables cancellation for this attempt immediately
            // before the existing destructive-phase write, without an await.
            beforeRemoving?.()
            pendingRemovalPhase = { ...record, phase: 'removing' }
            await privateJson(fence, pendingRemovalPhase, true); record = pendingRemovalPhase; pendingRemovalPhase = undefined
          }
          await current(); assertStopped()
          // Preparation cancellation cannot roll back a destructive phase.
          if (platformRemoval) {
            await platformRemoval.remove()
            await current(); assertStopped()
            if (probeKnownProcessExit([facts.source_gui]).state !== 'stopped') fail()
          }
          const result = await removeDesktopRemovalPrograms({ installRoot: own.root, operationId })
          await current(); assertStopped()
          removalFailed = result.retained.length > 0
          return result
        } catch (error) { failure = error; removalFailed = true; throw error }
        finally {
          try { await platformRemoval?.close() }
          catch (cleanup) { removalFailed = true; if (failure) throw new AggregateError([failure, cleanup], '卸载及系统授权进程收尾未完成，保护与数据已保留。'); throw cleanup }
          finally { busy = false }
        }
      })()
      return pendingRemoval
    }
    return {
      record: structuredClone(record),
      current: () => current(),
      stop: () => requestStop(),
      retryStop: () => requestStop(true),
      exitSource: () => requestSourceExit(),
      retrySourceExit: () => requestSourceExit(true),
      removePrograms: (attemptSignal, beforeRemoving) => requestProgramRemoval(false, attemptSignal, beforeRemoving),
      retryRemovePrograms: (attemptSignal, beforeRemoving) => requestProgramRemoval(true, attemptSignal, beforeRemoving),
      async cancel() {
        if (busy || ['removing', 'completed'].includes(record.phase)) fail()
        busy = true
        try {
          const checkCancellation = () => current(!cancelIssued || !absent(fence))
          await checkCancellation()
          await verifyDesktopPrograms(own.coreRoot, own.guiRoot, proof.payload)
          const source = await readOriginalDesktopPayload(own.root, record.source_selection)
          if (!same(source.record, proof.payload)) fail()
          assertStopped()
          await checkCancellation()
          // Final synchronous stop/record checks directly precede the unlink.
          assertStopped()
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

// Fixed role entrypoints. Existing records can never enter initial publication.
export function beginInitialDesktopRemoval(options) { return openDesktopRemoval(options, false) }
export function resumeDesktopRemoval(options) { return openDesktopRemoval(options, true) }

export async function beginInitialDesktopRemovalNode(options) {
  if (process.platform !== 'linux') fail()
  return openDesktopRemoval(options, false, 'node')
}
export async function resumeDesktopRemovalNode(options) {
  if (process.platform !== 'linux') fail()
  return openDesktopRemoval(options, true, 'node')
}

// The fixed host calls this only after its platform-entry cleanup succeeds.
// It settles the existing phase; it neither removes entries nor clears the fence.
export async function finishDesktopRemoval(options) {
  const context = await captureStoppedDesktopRemoval(options)
  const { own, record, proof, assertStopped, proofCurrent } = context
  const current = async () => {
    await proofCurrent(); assertStopped()
    if (!['removing', 'completed'].includes(record.phase) || !absent(path.join(own.root, '.desktop-installing.json'))) fail()
  }
  await current()
  const programs = await inspectDesktopRemovalPrograms(options)
  if (programs.matched.length || programs.retained.length) fail()
  await current()
  await assertDesktopRemovalProgramsUnused({ installRoot: own.root, proof }, 'before-completed')
  await current()
  const completed = { ...record, phase: 'completed' }
  if (record.phase !== 'completed') await privateJson(path.join(own.root, '.desktop-removal.json'), completed, true)
  // A lost reply is retried by reading the same completed record. No program,
  // service, entry or migration is replayed to infer that the write succeeded.
  const settled = await captureStoppedDesktopRemoval(options)
  await settled.proofCurrent(); settled.assertStopped()
  if (!same(settled.record, completed)) fail()
  return structuredClone(completed)
}
