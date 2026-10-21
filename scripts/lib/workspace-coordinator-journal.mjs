// Native fixed-job IPC only; domain policies own their payloads and durable readback.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import native from './process-identity.cjs'
import { cliLockToken } from './cli-lock.mjs'
import { readWorkspaceRelocationCoordinator } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson } from '../../crabot-shared/dist/canonical-json.js'

function kinds(namespace) {
  if (namespace !== 'module' && namespace !== 'worker' && namespace !== 'process' && namespace !== 'file') throw workspaceJournalFailure()
  return { requestKind: `workspace_${namespace}_journal_request`, replyKind: `workspace_${namespace}_journal_reply`, timeout: namespace === 'file' ? 20 * 60_000 : 10_000 }
}
export const workspaceJournalFailure = () => Object.assign(new Error('迁移材料确认不可用，维护保护已保留；未重发操作。'), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
export const journalFields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
function binding(context) {
  return { dataDir: context.dataDir, id: context.id, launchId: context.launch.launch_id, launchHash: sha256CanonicalJson(context.launch) }
}
function state(bound) {
  const current = readWorkspaceRelocationCoordinator(bound.dataDir, bound.id)
  if (!current.launch || !current.ready || current.launch.launch_id !== bound.launchId
    || sha256CanonicalJson(current.launch) !== bound.launchHash) throw workspaceJournalFailure()
  return current
}

export function createWorkspaceJournalClient(coordinator, context, namespace) {
  const { requestKind, replyKind, timeout } = kinds(namespace)
  const bound = binding(context), original = state(bound), readyHash = sha256CanonicalJson(original.ready)
  let pending, closed = false
  const verify = () => {
    const current = state(bound), self = native.inspectProcess(process.pid), child = native.inspectProcess(coordinator.pid)
    if (sha256CanonicalJson(current.ready) !== readyHash || coordinator.pid !== current.launch.process.pid
      || coordinator.exitCode !== null || coordinator.signalCode !== null || !coordinator.connected
      || !native.sameProcess(current.launch.parent, self) || !native.sameProcess(current.launch.process, child)
      || child.parent !== self.pid) throw workspaceJournalFailure()
  }
  const close = () => {
    if (closed) return
    closed = true
    coordinator.off('message', receive); coordinator.off('exit', close); coordinator.off('error', close)
    if (pending) { const current = pending; pending = undefined; clearTimeout(current.timer); current.reject(workspaceJournalFailure()) }
  }
  const receive = message => {
    if (!pending || message?.kind !== replyKind || message.request_id !== pending.id) return
    try {
      if (!journalFields(message, ['kind', 'request_id', 'launch_id', 'operation', 'ok', 'result'])
        || message.launch_id !== bound.launchId || message.operation !== pending.operation || message.ok !== true) throw workspaceJournalFailure()
      verify()
      const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve(message.result)
    } catch { close() }
  }
  const call = (operation, payload) => {
    try { if (closed || pending) throw workspaceJournalFailure(); verify() }
    catch { close(); return Promise.reject(workspaceJournalFailure()) }
    return new Promise((resolve, reject) => {
      const id = randomUUID(), timer = setTimeout(close, timeout)
      pending = { id, operation, resolve, reject, timer }
      try { coordinator.send({ kind: requestKind, request_id: id, launch_id: bound.launchId, operation, payload }, error => { if (error) close() }) }
      catch { close() }
    })
  }
  verify()
  coordinator.on('message', receive); coordinator.once('exit', close); coordinator.once('error', close)
  return Object.freeze({ call, verify, close })
}

export function serveWorkspaceJournal(context, namespace, handlers) {
  const { requestKind, replyKind } = kinds(namespace)
  const bound = binding(context), ownLock = path.resolve(bound.dataDir, 'cli.lock'), token = cliLockToken(ownLock)
  const original = state(bound), readyHash = sha256CanonicalJson(original.ready), seen = new Set()
  let closed = false
  const verify = () => {
    const current = state(bound), self = native.inspectProcess(process.pid)
    if (closed || !token || cliLockToken(ownLock) !== token || sha256CanonicalJson(current.ready) !== readyHash
      || !native.sameProcess(current.launch.process, self) || self.parent !== current.launch.parent.pid
      || !native.sameProcess(current.launch.parent, native.inspectProcess(current.launch.parent.pid)) || !process.connected) throw workspaceJournalFailure()
  }
  const receive = async message => {
    if (message?.kind !== requestKind) return
    const reply = { kind: replyKind, request_id: message.request_id, launch_id: bound.launchId, operation: message.operation, ok: false, result: null }
    try {
      verify()
      if (!journalFields(message, ['kind', 'request_id', 'launch_id', 'operation', 'payload']) || message.launch_id !== bound.launchId
        || typeof message.request_id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(message.request_id)
        || seen.has(message.request_id) || seen.size >= 32768 || !Object.hasOwn(handlers, message.operation) || typeof handlers[message.operation] !== 'function') throw workspaceJournalFailure()
      seen.add(message.request_id)
      reply.result = await handlers[message.operation](message.payload)
      verify(); reply.ok = true
    } catch (error) {
      reply.result = null
      const causes = []
      for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) causes.push({ code: typeof current.code === 'string' ? current.code.slice(0, 128) : 'unverified', stage: typeof current.stage === 'string' ? current.stage.slice(0, 64) : null })
      console.error(JSON.stringify({ event: 'workspace_journal_failed', namespace, operation: typeof message.operation === 'string' ? message.operation.slice(0, 64) : 'invalid', causes }))
    }
    if (process.connected) process.send(reply, () => {})
  }
  verify()
  process.on('message', receive)
  return Object.freeze({ close() { closed = true; process.off('message', receive) } })
}
