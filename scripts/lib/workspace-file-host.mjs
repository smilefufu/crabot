// One fixed file-host role. IPC accepts only the original private job, never an entrypoint or command.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { serveWorkspaceFileToolJournal } from './workspace-file-tool-journal.mjs'
import native from './process-identity.cjs'
import knownExit from './known-process-exit.cjs'
import { journalFields as fields } from './workspace-coordinator-journal.mjs'
import { readWorkspaceRelocationFilePlan, readWorkspaceRelocationFileActors, readWorkspaceRelocationCoordinator,
  prepareWorkspaceRelocationFileActors, registerWorkspaceRelocationFileHost, permitWorkspaceRelocationFileHost, beginWorkspaceRelocationFiles, commitWorkspaceRelocationFileReady } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'

const failure = stage => Object.assign(new Error('固定文件准备子进程无法核验，原文件与维护记录已保留。'), { code: 'CRABOT_WORKSPACE_FILE_HOST', ...(typeof stage === 'string' ? { stage } : {}) })
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
  let child, stage = 'attempt'
  try {
    const attempt = prepareWorkspaceRelocationFileActors(options)
    if (attempt.dispatch !== 'dispatch') return { dispatch: 'observe', host: readWorkspaceRelocationFileActors(options.dataDir, options.id).host?.process ?? null }
    const entry = fileURLToPath(new URL('../workspace-file-host.mjs', import.meta.url))
    const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP'])
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())))
    stage = 'spawn'
    child = spawn(process.execPath, [entry], { cwd: path.dirname(entry), env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
    child.on('error', () => {}) // The owned handoff/journal reports errors; late IPC errors must not crash the coordinator.
    await once(child, 'spawn')
    stage = 'capture-host'
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
    stage = 'host-ready'
    const readyPromise = receive(child, 10000)
    const [, ready] = await Promise.all([send(child, { kind: 'workspace_file_host_start', data_dir: options.dataDir, ...bound }), readyPromise])
    verify()
    if (!fields(ready, ['kind', ...Object.keys(bound)]) || ready.kind !== 'workspace_file_host_ready'
      || Object.entries(bound).some(([key, value]) => ready[key] !== value)) throw failure()
    stage = 'host-permission'
    const permitted = permitWorkspaceRelocationFileHost(options)
    if (permitted.dispatch !== 'dispatch') throw failure()
    const permissionHash = hash(permitted.permission), enteredPromise = receive(child, 10000)
    const [, entered] = await Promise.all([send(child, { kind: 'workspace_file_host_permit', ...bound, permission_sha256: permissionHash }), enteredPromise])
    if (hash(verify().permission) !== permissionHash || !fields(entered, ['kind', ...Object.keys(bound), 'permission_sha256'])
      || entered.kind !== 'workspace_file_host_entered' || entered.permission_sha256 !== permissionHash
      || Object.entries(bound).some(([key, value]) => entered[key] !== value)) throw failure()
    stage = 'tool-journal'
    serveWorkspaceFileToolJournal(child, options)
    return { dispatch: 'dispatch', child, host: host.host.process }
  } catch (cause) { await close(child); const error = failure(); error.cause = cause; error.stage = stage; throw error }
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
  const complete = async attemptHash => {
    const before = verify()
    if (!before.file_attempt || hash(before.file_attempt) !== attemptHash) throw failure()
    const expected = { intent_id: input.intent_id, attempt_sha256: attemptHash }
    const receiptPromise = receive(process, 20 * 60_000)
    const [, receipt] = await Promise.all([send(process, { kind: 'workspace_file_prepared', ...expected }), receiptPromise])
    if (hash(verify().file_attempt) !== attemptHash || !fields(receipt, ['kind', ...Object.keys(expected)])
      || receipt.kind !== 'workspace_file_completion_verified' || Object.entries(expected).some(([key, value]) => receipt[key] !== value)) throw failure()
  }
  return Object.freeze({ dataDir: input.data_dir, id: input.intent_id, plan: readWorkspaceRelocationFilePlan(input.data_dir, input.intent_id), complete,
    entered: { kind: 'workspace_file_host_entered', ...bound, permission_sha256: hash(current.permission) } })
}


export async function prepareWorkspaceFilesWithHost(child, { dataDir, id, signal }) {
  let clear = () => {}, stage = 'file-actors'
  try {
    const original = readWorkspaceRelocationFileActors(dataDir, id)
    if (original.file_ready) return { dispatch: 'observe', ready: original.file_ready }
    stage = 'file-attempt'
    const started = await beginWorkspaceRelocationFiles({ dataDir, id, signal })
    stage = 'file-carrier'
    if (started.dispatch !== 'dispatch' || !child?.connected || !native.sameProcess(original.host.process, native.inspectProcess(child.pid))) throw failure()
    if (signal?.aborted) throw failure()
    const attemptHash = hash(started.attempt)
    const ended = new Promise((resolve, reject) => {
      let completed = false, acknowledgement
      const failed = (cause, stage) => { const error = failure(stage); if (cause) error.cause = cause; reject(error) }
      const message = value => {
        if (value?.kind !== 'workspace_file_prepared' && value?.kind !== 'workspace_file_preparation_failed') return
        let messageStage = 'completion-fields'
        try {
          if (!fields(value, ['kind', 'intent_id', 'attempt_sha256', ...(value.kind === 'workspace_file_preparation_failed' ? ['error_code'] : [])])
            || value.intent_id !== id || value.attempt_sha256 !== attemptHash || completed
            || child.pid !== original.host.process.pid) throw failure()
          messageStage = 'completion-inspect'
          const current = native.inspectProcess(child.pid)
          messageStage = 'completion-binding'
          if (!native.sameProcess(original.host.process, current) && knownExit.probeKnownProcessExit([original.host.process]).state !== 'stopped') throw failure()
          if (value.kind === 'workspace_file_preparation_failed') return failed({ code: value.error_code }, 'host-reported-failure')
          completed = true
          acknowledgement = send(child, { kind: 'workspace_file_completion_verified', intent_id: id, attempt_sha256: attemptHash })
          void acknowledgement.catch(cause => failed(cause, 'completion-acknowledgement'))
        } catch (error) { failed(error, messageStage) }
      }
      const exited = (code, exitSignal) => completed && code === 0 && exitSignal === null ? acknowledgement.then(resolve, cause => failed(cause, 'completion-acknowledgement'))
        : failed(undefined, !completed ? 'exit-before-completion' : code !== 0 ? 'host-exit-code' : 'host-exit-signal')
      const disconnected = () => { if (!completed) failed(undefined, 'disconnect-before-completion') }
      const aborted = () => failed(undefined, 'host-aborted')
      const timer = setTimeout(aborted, 20 * 60_000)
      clear = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exited); child.off('disconnect', disconnected); child.off('error', aborted); signal?.removeEventListener('abort', aborted) }
      child.on('message', message); child.once('exit', exited); child.once('disconnect', disconnected); child.once('error', aborted); signal?.addEventListener('abort', aborted)
      if (signal?.aborted) aborted()
    })
    void ended.catch(() => {})
    if (signal?.aborted) throw failure()
    stage = 'host-completion'
    await Promise.all([send(child, { kind: 'workspace_file_prepare', intent_id: id, attempt_sha256: attemptHash }), ended])
    clear()
    stage = 'host-kernel-exit'
    const { probeKnownProcessExit } = knownExit
    const deadline = Date.now() + 2000
    while (probeKnownProcessExit([original.host.process]).state !== 'stopped' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    stage = 'file-ready'
    return await commitWorkspaceRelocationFileReady({ dataDir, id, signal })
  } catch (cause) { clear(); await close(child); const error = failure(stage); error.cause = cause; throw error }
}
