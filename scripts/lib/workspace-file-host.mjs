// One fixed file-host role. IPC accepts only the original private job, never an entrypoint or command.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import native from './process-identity.cjs'
import { journalFields as fields } from './workspace-coordinator-journal.mjs'
import { readWorkspaceRelocationFilePlan, readWorkspaceRelocationFileActors, readWorkspaceRelocationCoordinator,
  prepareWorkspaceRelocationFileActors, registerWorkspaceRelocationFileHost, permitWorkspaceRelocationFileHost } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'

const failure = () => Object.assign(new Error('固定文件准备子进程无法核验，原文件与维护记录已保留。'), { code: 'CRABOT_WORKSPACE_FILE_HOST' })
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
function receive(channel, timeout) {
  return new Promise((resolve, reject) => {
    const clear = () => { clearTimeout(timer); channel.off('message', message); channel.off('disconnect', closed); channel.off('error', closed); channel.off('exit', closed) }
    const message = value => { clear(); resolve(value) }
    const closed = () => { clear(); reject(failure()) }
    const timer = setTimeout(closed, timeout)
    channel.once('message', message); channel.once('disconnect', closed); channel.once('error', closed); channel.once('exit', closed)
    if (!channel.connected) closed()
  })
}
const send = (channel, message) => new Promise((resolve, reject) => {
  try { channel.send(message, error => error ? reject(failure()) : resolve()) } catch { reject(failure()) }
})
async function close(child) {
  try { if (child?.connected) child.disconnect() } catch {}
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolve => {
    const done = () => { clearTimeout(timer); child.off('exit', done); resolve() }
    const timer = setTimeout(done, 2000); child.once('exit', done)
    if (child.exitCode !== null || child.signalCode !== null) done()
  })
}

export async function launchWorkspaceFileHost(options) {
  if (!fields(options, ['dataDir', 'id']) || typeof options.dataDir !== 'string' || !path.isAbsolute(options.dataDir)
    || options.dataDir.includes('\0') || !uuid(options.id)) throw failure()
  let child
  try {
    const attempt = prepareWorkspaceRelocationFileActors(options)
    if (attempt.dispatch !== 'dispatch') return { dispatch: 'observe', host: readWorkspaceRelocationFileActors(options.dataDir, options.id).host?.process ?? null }
    const entry = fileURLToPath(new URL('../workspace-file-host.mjs', import.meta.url))
    const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP'])
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())))
    child = spawn(process.execPath, [entry], { cwd: path.dirname(entry), env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    await once(child, 'spawn')
    const host = registerWorkspaceRelocationFileHost({ ...options, process: native.inspectProcess(child.pid) })
    if (host.dispatch !== 'dispatch') throw failure()
    const bound = { intent_id: options.id, attempt_sha256: hash(attempt.attempt), host_sha256: hash(host.host) }
    const verify = () => {
      const current = readWorkspaceRelocationFileActors(options.dataDir, options.id), coordinator = readWorkspaceRelocationCoordinator(options.dataDir, options.id)
      if (!child.connected || child.exitCode !== null || child.signalCode !== null || hash(current.attempt) !== bound.attempt_sha256
        || hash(current.host) !== bound.host_sha256 || !native.sameProcess(coordinator.launch.process, native.inspectProcess(process.pid))
        || !native.sameProcess(current.host.process, native.inspectProcess(child.pid))) throw failure()
      return current
    }
    const readyPromise = receive(child, 10000)
    const [, ready] = await Promise.all([send(child, { kind: 'workspace_file_host_start', data_dir: options.dataDir, ...bound }), readyPromise])
    verify()
    if (!fields(ready, ['kind', ...Object.keys(bound)]) || ready.kind !== 'workspace_file_host_ready'
      || Object.entries(bound).some(([key, value]) => ready[key] !== value)) throw failure()
    const permitted = permitWorkspaceRelocationFileHost(options)
    if (permitted.dispatch !== 'dispatch') throw failure()
    const permissionHash = hash(permitted.permission), enteredPromise = receive(child, 10000)
    const [, entered] = await Promise.all([send(child, { kind: 'workspace_file_host_permit', ...bound, permission_sha256: permissionHash }), enteredPromise])
    if (hash(verify().permission) !== permissionHash || !fields(entered, ['kind', ...Object.keys(bound), 'permission_sha256'])
      || entered.kind !== 'workspace_file_host_entered' || entered.permission_sha256 !== permissionHash
      || Object.entries(bound).some(([key, value]) => entered[key] !== value)) throw failure()
    return { dispatch: 'dispatch', child, host: host.host.process }
  } catch { await close(child); throw failure() }
}

let entered = false
export async function enterWorkspaceFileHost() {
  if (entered || !process.send || !process.connected || process.argv.length !== 2) throw failure()
  entered = true
  const input = await receive(process, 5000)
  if (!fields(input, ['kind', 'data_dir', 'intent_id', 'attempt_sha256', 'host_sha256']) || input.kind !== 'workspace_file_host_start'
    || typeof input.data_dir !== 'string' || !path.isAbsolute(input.data_dir) || input.data_dir.includes('\0') || !uuid(input.intent_id)) throw failure()
  const bound = { intent_id: input.intent_id, attempt_sha256: input.attempt_sha256, host_sha256: input.host_sha256 }
  const verify = () => {
    const current = readWorkspaceRelocationFileActors(input.data_dir, input.intent_id), coordinator = readWorkspaceRelocationCoordinator(input.data_dir, input.intent_id)
    const self = native.inspectProcess(process.pid)
    if (!process.connected || !current.host || hash(current.attempt) !== bound.attempt_sha256 || hash(current.host) !== bound.host_sha256
      || !native.sameProcess(current.host.process, self) || self.parent !== coordinator.launch.process.pid
      || !native.sameProcess(coordinator.launch.process, native.inspectProcess(self.parent))
      || !native.sameProcess(coordinator.launch.parent, native.inspectProcess(coordinator.launch.parent.pid))) throw failure()
    return current
  }
  if (verify().permission) throw failure()
  const permissionPromise = receive(process, 5000)
  const [, permit] = await Promise.all([send(process, { kind: 'workspace_file_host_ready', ...bound }), permissionPromise])
  const current = verify()
  if (!current.permission || !fields(permit, ['kind', ...Object.keys(bound), 'permission_sha256']) || permit.kind !== 'workspace_file_host_permit'
    || permit.permission_sha256 !== hash(current.permission) || Object.entries(bound).some(([key, value]) => permit[key] !== value)) throw failure()
  return Object.freeze({ dataDir: input.data_dir, id: input.intent_id, plan: readWorkspaceRelocationFilePlan(input.data_dir, input.intent_id),
    entered: { kind: 'workspace_file_host_entered', ...bound, permission_sha256: hash(current.permission) } })
}
