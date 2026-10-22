// Fixed terminal storage effects only. No generic journal verification bypass.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import native from './process-identity.cjs'
import { cliLockToken } from './cli-lock.mjs'
import maintenance from './workspace-maintenance.cjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { readWorkspaceRelocationCoordinator, readWorkspaceRelocationCompletion, readWorkspaceRelocationArchivedCompletion,
  readWorkspaceRelocationFinalizing, readWorkspaceRelocationReleased, archiveWorkspaceRelocationJob, releaseWorkspaceRelocationJob } from './workspace-relocation-intent.mjs'
import { journalFields as fields, workspaceJournalFailure as failure } from './workspace-coordinator-journal.mjs'

const requestKind = 'workspace_relocation_archive_request', replyKind = 'workspace_relocation_archive_reply'
const releaseRequest = 'workspace_relocation_release_request', releaseReply = 'workspace_relocation_release_reply'
const observeRequest = 'workspace_relocation_release_observe', observeReply = 'workspace_relocation_release_observed'
function binding(context) {
  const coordinator = readWorkspaceRelocationCoordinator(context.dataDir, context.id)
  if (!coordinator.launch || !coordinator.ready || hash(context.launch) !== hash(coordinator.launch)) throw failure()
  return { dataDir: context.dataDir, id: context.id, launch: coordinator.launch }
}
function stored(bound, completionHash, result, released = false) {
  const completion = readWorkspaceRelocationArchivedCompletion(bound.dataDir, bound.id)
  const fence = released ? readWorkspaceRelocationReleased(bound.dataDir, bound.id) : readWorkspaceRelocationFinalizing(bound.dataDir, bound.id)
  if (!completion || !fence || hash(completion) !== completionHash || fence.completion_sha256 !== completionHash || fence.intent_sha256 !== completion.intent_sha256
    || fence.launch_sha256 !== hash(bound.launch) || completion.launch_sha256 !== hash(bound.launch)
    || !fields(result, ['intent_id', 'completion_sha256', 'finalizing_sha256']) || result.intent_id !== bound.id
    || result.completion_sha256 !== completionHash || result.finalizing_sha256 !== hash(fence)) throw failure()
  if (released && maintenance.workspaceMaintenancePending(bound.dataDir)) throw failure()
  return result
}
function preparedResult(bound, completionHash, prepared) {
  const completion = readWorkspaceRelocationArchivedCompletion(bound.dataDir, bound.id)
  const expected = { prepared: true, intent_id: bound.id, intent_sha256: completion.intent_sha256, launch_id: bound.launch.launch_id,
    launch_sha256: hash(bound.launch), completion_sha256: completionHash }
  if (hash(prepared) !== hash(expected)) throw failure()
  return expected
}
// A new read-only query may observe an existing effect after its old reply channel failed.
function observeStoredRelease(child, bound, completionHash) {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const verify = () => {
      const self = native.inspectProcess(process.pid), actual = native.inspectProcess(child.pid)
      if (!child.connected || child.exitCode !== null || child.signalCode !== null
        || !native.sameProcess(bound.launch.parent, self) || !native.sameProcess(bound.launch.process, actual) || actual.parent !== self.pid) throw failure()
    }
    const cleanup = () => {
      clearTimeout(timer); child.off('message', receive); child.off('exit', failed); child.off('error', failed); child.off('disconnect', failed)
    }
    const failed = () => { cleanup(); reject(failure()) }
    const receive = message => {
      if (message?.kind !== observeReply || message.request_id !== id) return
      try {
        verify()
        if (!fields(message, ['kind', 'request_id', 'launch_id', 'ok', 'result']) || message.launch_id !== bound.launch.launch_id || message.ok !== true) throw failure()
        const result = stored(bound, completionHash, message.result, true)
        cleanup(); resolve(result)
      } catch { failed() }
    }
    const timer = setTimeout(failed, 20 * 60_000)
    child.on('message', receive); child.once('exit', failed); child.once('error', failed); child.once('disconnect', failed)
    try {
      verify()
      child.send({ kind: observeRequest, request_id: id, launch_id: bound.launch.launch_id, completion_sha256: completionHash }, error => { if (error) failed() })
    } catch { failed() }
  })
}
export function createWorkspaceFinalizationJournal(child, context) {
  const bound = binding(context), completion = readWorkspaceRelocationCompletion(bound.dataDir, bound.id)
  if (!completion) throw failure()
  const completionHash = hash(completion)
  let closed = false, pending, promise, releasePromise, releaseFingerprint, archiveResult, observation
  const verify = () => {
    const self = native.inspectProcess(process.pid), childIdentity = native.inspectProcess(child.pid)
    if (closed || !child.connected || child.exitCode !== null || child.signalCode !== null
      || !native.sameProcess(bound.launch.parent, self) || !native.sameProcess(bound.launch.process, childIdentity)
      || childIdentity.parent !== self.pid) throw failure()
  }
  const close = () => {
    if (closed) return
    closed = true; child.off('message', receive); child.off('exit', close); child.off('error', close)
    if (pending) { const current = pending; pending = undefined; clearTimeout(current.timer); current.reject(failure()) }
  }
  const receive = message => {
    if (!pending || message?.kind !== pending.replyKind || message.request_id !== pending.id) return
    try {
      verify()
      if (!fields(message, ['kind', 'request_id', 'launch_id', 'ok', 'result']) || message.launch_id !== bound.launch.launch_id || message.ok !== true) throw failure()
      const result = stored(bound, completionHash, message.result, pending.released), current = pending
      pending = undefined; clearTimeout(current.timer); current.resolve(result)
    } catch { close() }
  }
  child.on('message', receive); child.once('exit', close); child.once('error', close)
  return Object.freeze({
    archive() {
      if (promise) return promise
      promise = new Promise((resolve, reject) => {
        try {
          verify()
          if (hash(readWorkspaceRelocationCompletion(bound.dataDir, bound.id)) !== completionHash) throw failure()
          const id = randomUUID(), timer = setTimeout(close, 20 * 60_000)
          pending = { id, timer, resolve: result => { archiveResult = result; resolve(result) }, reject, replyKind, released: false }
          child.send({ kind: requestKind, request_id: id, launch_id: bound.launch.launch_id, completion_sha256: completionHash }, error => { if (error) close() })
        } catch { close(); reject(failure()) }
      })
      return promise
    },
    release(prepared) {
      try {
        verify()
        if (!archiveResult) throw failure()
        const expected = preparedResult(bound, completionHash, prepared), fingerprint = hash(expected)
        if (releasePromise) { if (releaseFingerprint !== fingerprint) throw failure(); return releasePromise }
        stored(bound, completionHash, archiveResult)
        releaseFingerprint = fingerprint
        releasePromise = new Promise((resolve, reject) => {
          try {
            const id = randomUUID(), timer = setTimeout(close, 20 * 60_000)
            pending = { id, timer, resolve, reject, replyKind: releaseReply, released: true }
            child.send({ kind: releaseRequest, request_id: id, launch_id: bound.launch.launch_id, completion_sha256: completionHash, prepared: expected }, error => { if (error) close() })
          } catch { close(); reject(failure()) }
        })
        return releasePromise
      } catch { return Promise.reject(failure()) }
    },
    observeRelease() {
      if (!releasePromise) return Promise.reject(failure())
      return observation ??= observeStoredRelease(child, bound, completionHash)
    }, close,
  })
}
export function serveWorkspaceFinalizationJournal(context) {
  const bound = binding(context), lock = path.join(bound.dataDir, 'cli.lock'), token = cliLockToken(lock), controller = new AbortController()
  let closed = false, effect, completionHash, releaseEffect, releaseFingerprint
  const verify = () => {
    const self = native.inspectProcess(process.pid)
    if (closed || !token || cliLockToken(lock) !== token || !process.connected || !native.sameProcess(bound.launch.process, self)
      || self.parent !== bound.launch.parent.pid || !native.sameProcess(bound.launch.parent, native.inspectProcess(bound.launch.parent.pid))) throw failure()
  }
  const receive = async message => {
    if (![requestKind, releaseRequest, observeRequest].includes(message?.kind)) return
    const releasing = message.kind === releaseRequest, observing = message.kind === observeRequest
    const reply = { kind: observing ? observeReply : releasing ? releaseReply : replyKind, request_id: message.request_id, launch_id: bound.launch.launch_id, ok: false, result: null }
    try {
      verify()
      if (!fields(message, ['kind', 'request_id', 'launch_id', 'completion_sha256', ...(releasing ? ['prepared'] : [])]) || message.launch_id !== bound.launch.launch_id
        || typeof message.request_id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(message.request_id)
        || typeof message.completion_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(message.completion_sha256)) throw failure()
      if (!effect) {
        if (releasing || observing) throw failure()
        const completion = readWorkspaceRelocationCompletion(bound.dataDir, bound.id)
        if (!completion || hash(completion) !== message.completion_sha256) throw failure()
        completionHash = message.completion_sha256
        effect = archiveWorkspaceRelocationJob({ dataDir: bound.dataDir, id: bound.id, signal: controller.signal })
      }
      if (message.completion_sha256 !== completionHash) throw failure()
      const archiveResult = await effect
      verify()
      if (observing) {
        if (!releaseEffect) throw failure()
        const result = await releaseEffect
        verify(); reply.result = stored(bound, completionHash, result, true)
      } else if (releasing) {
        const prepared = preparedResult(bound, completionHash, message.prepared), fingerprint = hash(prepared)
        if (!releaseEffect) {
          stored(bound, completionHash, archiveResult)
          releaseFingerprint = fingerprint
          releaseEffect = releaseWorkspaceRelocationJob({ dataDir: bound.dataDir, id: bound.id, signal: controller.signal, verify: async () => verify() })
        }
        if (fingerprint !== releaseFingerprint) throw failure()
        const result = await releaseEffect
        verify(); reply.result = stored(bound, completionHash, result, true)
      } else reply.result = stored(bound, completionHash, archiveResult)
      reply.ok = true
    } catch (error) {
      reply.result = null
      console.error(JSON.stringify({ event: observing ? 'workspace_release_observation_failed' : releasing ? 'workspace_release_failed' : 'workspace_archive_failed', code: typeof error?.code === 'string' ? error.code.slice(0, 128) : 'unverified',
        stage: typeof error?.stage === 'string' ? error.stage.slice(0, 64) : null }))
    }
    if (process.connected) process.send(reply, () => {})
  }
  verify(); process.on('message', receive)
  return Object.freeze({ close() { if (closed) return; closed = true; controller.abort(); process.off('message', receive) } })
}
