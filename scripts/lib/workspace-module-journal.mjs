// Fixed module-journal acknowledgements on the actual coordinator IPC channel.
// MM owns its module lifecycle; only the coordinator owns the private write lock.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import native from './process-identity.cjs'
import { cliLockToken } from './cli-lock.mjs'
import { readWorkspaceRelocationCoordinator, readWorkspaceRelocationModules, readWorkspaceRelocationModuleStops, commitWorkspaceRelocationModules, prepareWorkspaceRelocationModuleStops,
  observeWorkspaceRelocationModuleProcesses, completeWorkspaceRelocationModuleStops } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson } from '../../crabot-shared/dist/canonical-json.js'

const requestKind = 'workspace_module_journal_request', replyKind = 'workspace_module_journal_reply'
const operations = ['prepare', 'observe', 'complete']
const failure = () => Object.assign(new Error('迁移模块材料确认不可用，维护保护已保留；未重发操作。'), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
function binding(context) {
  return { dataDir: context.dataDir, id: context.id, launchId: context.launch.launch_id, launchHash: sha256CanonicalJson(context.launch) }
}
function state(bound) {
  const current = readWorkspaceRelocationCoordinator(bound.dataDir, bound.id)
  if (!current.launch || !current.ready || current.launch.launch_id !== bound.launchId
    || sha256CanonicalJson(current.launch) !== bound.launchHash) throw failure()
  return current
}

export function createWorkspaceModuleJournal(coordinator, context) {
  const bound = binding(context), original = state(bound), readyHash = sha256CanonicalJson(original.ready)
  let pending, closed = false
  const verify = () => {
    const current = state(bound), self = native.inspectProcess(process.pid), child = native.inspectProcess(coordinator.pid)
    if (sha256CanonicalJson(current.ready) !== readyHash || coordinator.pid !== current.launch.process.pid
      || coordinator.exitCode !== null || coordinator.signalCode !== null || !coordinator.connected
      || !native.sameProcess(current.launch.parent, self) || !native.sameProcess(current.launch.process, child)
      || child.parent !== self.pid) throw failure()
  }
  const close = () => {
    if (closed) return
    closed = true
    coordinator.off('message', receive); coordinator.off('exit', close); coordinator.off('error', close)
    if (pending) { const current = pending; pending = undefined; clearTimeout(current.timer); current.reject(failure()) }
  }
  const receive = message => {
    if (!pending || message?.kind !== replyKind || message.request_id !== pending.id) return
    try {
      if (!fields(message, ['kind', 'request_id', 'launch_id', 'operation', 'ok', 'result'])
        || message.launch_id !== bound.launchId || message.operation !== pending.operation || message.ok !== true) throw failure()
      verify()
      const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve(message.result)
    } catch { close() }
  }
  const call = (operation, payload) => {
    try { if (closed || pending) throw failure(); verify() }
    catch { close(); return Promise.reject(failure()) }
    return new Promise((resolve, reject) => {
      const id = randomUUID(), timer = setTimeout(close, 10000)
      pending = { id, operation, resolve, reject, timer }
      try { coordinator.send({ kind: requestKind, request_id: id, launch_id: bound.launchId, operation, payload }, error => { if (error) close() }) }
      catch { close() }
    })
  }
  verify()
  coordinator.on('message', receive); coordinator.once('exit', close); coordinator.once('error', close)
  const acknowledged = async (operation, payload) => {
    try {
      let material = payload
      if (operation === 'complete') material = { results: [...payload.results].sort((a, b) => a.module_id < b.module_id ? -1 : a.module_id > b.module_id ? 1 : 0) }
      const expected = sha256CanonicalJson(material), moduleId = payload.module_id
      const hadAttempt = operation === 'prepare' && readWorkspaceRelocationModules(bound.dataDir, bound.id)
        ? Boolean(readWorkspaceRelocationModuleStops(bound.dataDir, bound.id).attempt) : false
      const result = await call(operation, payload)
      const validResult = operation === 'prepare' ? result === 'dispatch' || result === 'observe' : result === true
      if (!validResult) throw failure()
      const actual = readWorkspaceRelocationModuleStops(bound.dataDir, bound.id)
      if (operation === 'prepare') {
        if (!actual.attempt || hadAttempt && result === 'dispatch'
          || sha256CanonicalJson({ modules: readWorkspaceRelocationModules(bound.dataDir, bound.id).modules }) !== expected) throw failure()
      } else if (operation === 'observe') {
        const latest = actual.observations.filter(item => item.module_id === moduleId).at(-1)
        if (!latest || sha256CanonicalJson({ module_id: moduleId, processes: latest.processes }) !== expected) throw failure()
      } else if (!actual.submission || sha256CanonicalJson({ results: actual.submission.results }) !== expected) throw failure()
      verify()
      return result
    } catch { close(); throw failure() }
  }
  return Object.freeze({
    prepare: modules => acknowledged('prepare', { modules }),
    observe: async (moduleId, processes) => { await acknowledged('observe', { module_id: moduleId, processes }) },
    complete: async results => { await acknowledged('complete', { results }) },
    close,
  })
}

export function serveWorkspaceModuleJournal(context) {
  const bound = binding(context), ownLock = path.resolve(bound.dataDir, 'cli.lock'), token = cliLockToken(ownLock)
  const original = state(bound), readyHash = sha256CanonicalJson(original.ready), seen = new Set()
  let closed = false
  const verify = () => {
    const current = state(bound), self = native.inspectProcess(process.pid)
    if (closed || !token || cliLockToken(ownLock) !== token || sha256CanonicalJson(current.ready) !== readyHash
      || !native.sameProcess(current.launch.process, self) || self.parent !== current.launch.parent.pid
      || !native.sameProcess(current.launch.parent, native.inspectProcess(current.launch.parent.pid)) || !process.connected) throw failure()
  }
  const receive = message => {
    if (message?.kind !== requestKind) return
    const reply = { kind: replyKind, request_id: message.request_id, launch_id: bound.launchId, operation: message.operation, ok: false, result: null }
    try {
      verify()
      if (!fields(message, ['kind', 'request_id', 'launch_id', 'operation', 'payload']) || message.launch_id !== bound.launchId
        || typeof message.request_id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(message.request_id)
        || seen.has(message.request_id) || seen.size >= 32768 || !operations.includes(message.operation)) throw failure()
      seen.add(message.request_id)
      const payload = message.payload, args = { dataDir: bound.dataDir, id: bound.id }
      if (message.operation === 'prepare') {
        if (!fields(payload, ['modules'])) throw failure()
        commitWorkspaceRelocationModules({ ...args, modules: payload.modules })
        reply.result = prepareWorkspaceRelocationModuleStops({ ...args, modules: payload.modules }).dispatch
      } else if (message.operation === 'observe') {
        if (!fields(payload, ['module_id', 'processes'])) throw failure()
        observeWorkspaceRelocationModuleProcesses({ ...args, moduleId: payload.module_id, processes: payload.processes })
        reply.result = true
      } else {
        if (!fields(payload, ['results'])) throw failure()
        completeWorkspaceRelocationModuleStops({ ...args, results: payload.results })
        reply.result = true
      }
      verify(); reply.ok = true
    } catch { reply.result = null }
    if (process.connected) process.send(reply, () => {})
  }
  verify()
  process.on('message', receive)
  return Object.freeze({ close() { closed = true; process.off('message', receive) } })
}
