// Fixed file Host <-> original coordinator only; no MM, filesystem path or command dispatch.
import path from 'node:path'
import { cliLockToken } from './cli-lock.mjs'
import { randomUUID } from 'node:crypto'
import native from './process-identity.cjs'
import { journalFields as fields, workspaceJournalFailure as failure } from './workspace-coordinator-journal.mjs'
import { readWorkspaceRelocationCoordinator, readWorkspaceRelocationFileActors, registerWorkspaceRelocationCopyTools,
  permitWorkspaceRelocationCopyTools, completeWorkspaceRelocationCopyTools } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'

const requestKind = 'workspace_file_tool_request', replyKind = 'workspace_file_tool_reply'
const names = { register: 'tools', permit: 'tool_permission', complete: 'tool_exit' }
function binding(context) {
  const actors = readWorkspaceRelocationFileActors(context.dataDir, context.id)
  if (!actors.host || !actors.permission) throw failure()
  return { intent_id: context.id, host_sha256: hash(actors.host), permission_sha256: hash(actors.permission) }
}
function state(context, bound) {
  const actors = readWorkspaceRelocationFileActors(context.dataDir, context.id), coordinator = readWorkspaceRelocationCoordinator(context.dataDir, context.id)
  if (!coordinator.ready || !actors.host || !actors.permission || hash(actors.host) !== bound.host_sha256 || hash(actors.permission) !== bound.permission_sha256
    || !native.sameProcess(coordinator.launch.process, native.inspectProcess(coordinator.launch.process.pid))
    || !native.sameProcess(coordinator.launch.parent, native.inspectProcess(coordinator.launch.parent.pid))
    || !native.sameProcess(actors.host.process, native.inspectProcess(actors.host.process.pid))) throw failure()
  return { actors, coordinator }
}
const matches = (message, bound) => Object.entries(bound).every(([key, value]) => message[key] === value)

export function createWorkspaceFileToolJournal(context) {
  context = Object.freeze({ dataDir: context.dataDir, id: context.id })
  const bound = binding(context)
  let pending, closed = false
  const verify = () => {
    const current = state(context, bound), self = native.inspectProcess(process.pid)
    if (closed || !process.connected || !process.send || !native.sameProcess(current.actors.host.process, self)
      || self.parent !== current.coordinator.launch.process.pid) throw failure()
    return current.actors
  }
  const close = () => {
    if (closed) return
    closed = true; process.off('message', receive); process.off('disconnect', close); process.off('error', close)
    if (pending) { const current = pending; pending = undefined; clearTimeout(current.timer); current.reject(failure()) }
  }
  const receive = message => {
    if (!pending || message?.kind !== replyKind || message.request_id !== pending.id) return
    try {
      if (!fields(message, ['kind', 'request_id', ...Object.keys(bound), 'operation', 'ok', 'result']) || !matches(message, bound)
        || message.operation !== pending.operation || message.ok !== true) throw failure()
      const actors = verify(), record = actors[names[pending.operation]], result = message.result
      if (!record || !fields(result, ['dispatch', 'record_sha256']) || !['dispatch', 'observe'].includes(result.dispatch)
        || pending.previous && result.dispatch !== 'observe' || result.record_sha256 !== hash(record)
        || pending.operation === 'register' && hash(record.tools) !== pending.toolsHash) throw failure()
      const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve({ dispatch: result.dispatch, record })
    } catch { close() }
  }
  const call = (operation, payload) => {
    try {
      if (pending || !Object.hasOwn(names, operation)) throw failure()
      const previous = Boolean(verify()[names[operation]]), toolsHash = operation === 'register' ? hash(payload.tools) : undefined
      return new Promise((resolve, reject) => {
        const id = randomUUID(), timer = setTimeout(close, 10000)
        pending = { id, operation, previous, toolsHash, timer, resolve, reject }
        try { process.send({ kind: requestKind, request_id: id, ...bound, operation, payload }, error => { if (error) close() }) }
        catch { close() }
      })
    } catch { close(); return Promise.reject(failure()) }
  }
  verify(); process.on('message', receive); process.once('disconnect', close); process.once('error', close)
  return Object.freeze({ register: tools => call('register', { tools }), permit: () => call('permit', {}), complete: () => call('complete', {}), close })
}

export function serveWorkspaceFileToolJournal(child, context) {
  context = Object.freeze({ dataDir: context.dataDir, id: context.id })
  const lock = path.resolve(context.dataDir, 'cli.lock'), token = cliLockToken(lock)
  const bound = binding(context), seen = new Set()
  let closed = false
  const verify = () => {
    const current = state(context, bound), self = native.inspectProcess(process.pid)
    if (closed || !token || cliLockToken(lock) !== token || !child.connected || child.exitCode !== null || child.signalCode !== null
      || !native.sameProcess(current.coordinator.launch.process, self) || self.parent !== current.coordinator.launch.parent.pid
      || child.pid !== current.actors.host.process.pid || current.actors.host.process.parent !== self.pid) throw failure()
  }
  const close = () => {
    if (closed) return
    closed = true; child.off('message', receive); child.off('disconnect', close); child.off('exit', close); child.off('error', close)
  }
  const receive = message => {
    if (message?.kind !== requestKind) return
    const reply = { kind: replyKind, request_id: message.request_id, ...bound, operation: message.operation, ok: false, result: null }
    try {
      verify()
      if (!fields(message, ['kind', 'request_id', ...Object.keys(bound), 'operation', 'payload']) || !matches(message, bound)
        || typeof message.request_id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(message.request_id)
        || seen.has(message.request_id) || seen.size >= 32768 || !Object.hasOwn(names, message.operation)) throw failure()
      seen.add(message.request_id)
      const args = { dataDir: context.dataDir, id: context.id }, payload = message.payload
      let result, record
      if (message.operation === 'register') {
        if (!fields(payload, ['tools'])) throw failure()
        result = registerWorkspaceRelocationCopyTools({ ...args, tools: payload.tools }); record = result.tools
      } else {
        if (!fields(payload, [])) throw failure()
        result = message.operation === 'permit' ? permitWorkspaceRelocationCopyTools(args) : completeWorkspaceRelocationCopyTools(args)
        record = message.operation === 'permit' ? result.permission : result.completion
      }
      verify(); reply.ok = true; reply.result = { dispatch: result.dispatch, record_sha256: hash(record) }
    } catch { reply.result = null }
    if (child.connected) child.send(reply, () => {})
  }
  verify(); child.on('message', receive); child.once('disconnect', close); child.once('exit', close); child.once('error', close)
  return Object.freeze({ close })
}
