// Fixed terminal storage handoff. No generic journal verification bypass or maintenance release.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import native from './process-identity.cjs'
import { cliLockToken } from './cli-lock.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
import { readWorkspaceRelocationCoordinator, readWorkspaceRelocationCompletion, readWorkspaceRelocationArchivedCompletion,
  readWorkspaceRelocationFinalizing, archiveWorkspaceRelocationJob } from './workspace-relocation-intent.mjs'
import { journalFields as fields, workspaceJournalFailure as failure } from './workspace-coordinator-journal.mjs'

const requestKind = 'workspace_relocation_archive_request', replyKind = 'workspace_relocation_archive_reply'
function binding(context) {
  const coordinator = readWorkspaceRelocationCoordinator(context.dataDir, context.id)
  if (!coordinator.launch || !coordinator.ready || hash(context.launch) !== hash(coordinator.launch)) throw failure()
  return { dataDir: context.dataDir, id: context.id, launch: coordinator.launch }
}
function archived(bound, completionHash, result) {
  const completion = readWorkspaceRelocationArchivedCompletion(bound.dataDir, bound.id)
  const fence = readWorkspaceRelocationFinalizing(bound.dataDir, bound.id)
  if (!completion || !fence || hash(completion) !== completionHash || fence.completion_sha256 !== completionHash || fence.intent_sha256 !== completion.intent_sha256
    || fence.launch_sha256 !== hash(bound.launch) || completion.launch_sha256 !== hash(bound.launch)
    || !fields(result, ['intent_id', 'completion_sha256', 'finalizing_sha256']) || result.intent_id !== bound.id
    || result.completion_sha256 !== completionHash || result.finalizing_sha256 !== hash(fence)) throw failure()
  return result
}
export function createWorkspaceFinalizationJournal(child, context) {
  const bound = binding(context), completion = readWorkspaceRelocationCompletion(bound.dataDir, bound.id)
  if (!completion) throw failure()
  const completionHash = hash(completion)
  let closed = false, pending, promise
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
    if (!pending || message?.kind !== replyKind || message.request_id !== pending.id) return
    try {
      verify()
      if (!fields(message, ['kind', 'request_id', 'launch_id', 'ok', 'result']) || message.launch_id !== bound.launch.launch_id || message.ok !== true) throw failure()
      const result = archived(bound, completionHash, message.result), current = pending
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
          pending = { id, timer, resolve, reject }
          child.send({ kind: requestKind, request_id: id, launch_id: bound.launch.launch_id, completion_sha256: completionHash }, error => { if (error) close() })
        } catch { close(); reject(failure()) }
      })
      return promise
    }, close,
  })
}
export function serveWorkspaceFinalizationJournal(context) {
  const bound = binding(context), lock = path.join(bound.dataDir, 'cli.lock'), token = cliLockToken(lock), controller = new AbortController()
  let closed = false, effect, completionHash
  const verify = () => {
    const self = native.inspectProcess(process.pid)
    if (closed || !token || cliLockToken(lock) !== token || !process.connected || !native.sameProcess(bound.launch.process, self)
      || self.parent !== bound.launch.parent.pid || !native.sameProcess(bound.launch.parent, native.inspectProcess(bound.launch.parent.pid))) throw failure()
  }
  const receive = async message => {
    if (message?.kind !== requestKind) return
    const reply = { kind: replyKind, request_id: message.request_id, launch_id: bound.launch.launch_id, ok: false, result: null }
    try {
      verify()
      if (!fields(message, ['kind', 'request_id', 'launch_id', 'completion_sha256']) || message.launch_id !== bound.launch.launch_id
        || typeof message.request_id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(message.request_id)
        || typeof message.completion_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(message.completion_sha256)) throw failure()
      if (!effect) {
        const completion = readWorkspaceRelocationCompletion(bound.dataDir, bound.id)
        if (!completion || hash(completion) !== message.completion_sha256) throw failure()
        completionHash = message.completion_sha256
        effect = archiveWorkspaceRelocationJob({ dataDir: bound.dataDir, id: bound.id, signal: controller.signal })
      }
      if (message.completion_sha256 !== completionHash) throw failure()
      const result = await effect
      verify(); reply.result = archived(bound, completionHash, result); reply.ok = true
    } catch (error) {
      reply.result = null
      console.error(JSON.stringify({ event: 'workspace_archive_failed', code: typeof error?.code === 'string' ? error.code.slice(0, 128) : 'unverified',
        stage: typeof error?.stage === 'string' ? error.stage.slice(0, 64) : null }))
    }
    if (process.connected) process.send(reply, () => {})
  }
  verify(); process.on('message', receive)
  return Object.freeze({ close() { if (closed) return; closed = true; controller.abort(); process.off('message', receive) } })
}
