// Only a consumed, current human admission may call this fixed idle initializer.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import native from './process-identity.cjs'
import { captureSpawnedProcessTree } from './spawned-process-tree.cjs'
import { readWorkspaceRecoveryCompletionScope } from './workspace-recovery-admission.mjs'
import { commitWorkspaceRecoveryCoordinatorLaunch, readWorkspaceRecoveryCoordinator } from './workspace-recovery-records.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
const entry = fileURLToPath(new URL('../workspace-recovery-coordinator.mjs', import.meta.url))
const failure = () => Object.assign(new Error('新恢复协调器交接尚未确认，维护保护已保留；未重试启动。'), { code: 'CRABOT_WORKSPACE_RECOVERY_COORDINATOR' })
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
export async function launchWorkspaceRecoveryCoordinator(options) {
  let child, closed = false, launch, ready, identity, pending
  const terminalReplies = new Map(), diagnostics = []
  let diagnosticBuffer = ''
  const terminalReply = reply => terminalReplies.has(reply?.nonce) && terminalReplies.get(reply.nonce) === reply.kind
  const close = () => { closed = true; if (child?.connected) child.disconnect() }
  try {
    if (!exact(options, ['dataDir', 'request', 'admission', 'verify', 'releaseParentLock']) || typeof options.verify !== 'function'
      || typeof options.releaseParentLock !== 'function' || process.versions.electron) throw failure()
    await options.verify()
    if (readWorkspaceRecoveryCoordinator(options.dataDir, options.request.recovery_id).launch) throw failure()
    const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'])
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())))
    child = spawn(process.execPath, [entry], { cwd: path.dirname(entry), env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
    child.stderr.on('data', chunk => {
      diagnosticBuffer += chunk.toString()
      if (Buffer.byteLength(diagnosticBuffer) > 8192) { diagnosticBuffer = ''; return }
      const lines = diagnosticBuffer.split('\n'); diagnosticBuffer = lines.pop()
      for (const line of lines) {
        try {
          const value = JSON.parse(line)
          if (diagnostics.length < 4 && exact(value, ['event', 'code', 'stage']) && value.event === 'workspace_recovery_release_unconfirmed'
            && (value.code === null || typeof value.code === 'string' && /^(?:CRABOT_|WORKSPACE_)[A-Z_]{1,96}$/.test(value.code))
            && (value.stage === null || typeof value.stage === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value.stage))) diagnostics.push(Object.freeze(value))
        } catch { /* Raw stderr, paths, messages and credentials are never copied. */ }
      }
    })
    child.on('error', close); child.once('exit', close)
    child.on('message', reply => { if (!pending && !terminalReply(reply)) close() })
    identity = captureSpawnedProcessTree(child).find(value => value.pid === child.pid)
    if (!identity) throw failure()
    function exchange(message, expected) {
      if (closed || pending || !child.connected) return Promise.reject(failure())
      return new Promise((resolve, reject) => {
        const clear = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', failed); child.off('error', failed); child.off('disconnect', failed); pending = undefined }
        const failed = () => { clear(); close(); reject(failure()) }
        const receive = reply => { if (terminalReply(reply)) return; try { if (!expected(reply)) throw failure(); clear(); resolve(reply) } catch { failed() } }
        const timer = setTimeout(failed, 15000)
        pending = true
        child.on('message', receive); child.once('exit', failed); child.once('error', failed); child.once('disconnect', failed)
        if (message) child.send(message, error => { if (error) failed() })
      })
    }
    launch = await commitWorkspaceRecoveryCoordinatorLaunch({ dataDir: options.dataDir, request: options.request, admission: options.admission, coordinator: identity, verify: options.verify })
    const launchHash = hash(launch)
    // Listen before handing off the parent handle. The child cannot get the mutex before this release.
    const waiting = exchange(null, reply => {
      const stored = readWorkspaceRecoveryCoordinator(options.dataDir, options.request.recovery_id)
      if (!stored.ready || hash(stored.launch) !== launchHash || hash(reply) !== hash({ kind: 'workspace_recovery_ready', recovery_id: options.request.recovery_id, launch_sha256: launchHash, ready_sha256: hash(stored.ready) })) return false
      ready = stored.ready
      return true
    })
    void waiting.catch(() => {})
    await options.verify(); options.releaseParentLock()
    child.send({ kind: 'workspace_recovery_initialize', data_dir: options.dataDir, recovery_id: options.request.recovery_id, launch_sha256: launchHash }, error => { if (error) close() })
    await waiting
    let verification = Promise.resolve()
    const verifyOnce = async () => {
      try {
        await options.verify()
        const stored = readWorkspaceRecoveryCoordinator(options.dataDir, options.request.recovery_id)
        if (closed || !child.connected || !native.sameProcess(identity, native.inspectProcess(child.pid)) || hash(stored.launch) !== launchHash || hash(stored.ready) !== hash(ready)) throw failure()
        const message = { kind: 'workspace_recovery_verify', recovery_id: options.request.recovery_id, launch_sha256: launchHash, ready_sha256: hash(ready), nonce: randomUUID() }
        await exchange(message, reply => hash(reply) === hash({ ...message, kind: 'workspace_recovery_verified' }))
        await options.verify()
      } catch (cause) { close(); throw Object.assign(failure(), { cause }) }
    }
    const verify = () => { verification = verification.then(verifyOnce); return verification }
    let completionObservation
    const beginCompletionObservation = () => {
      if (completionObservation) return completionObservation
      completionObservation = verification = verification.then(async () => {
        try {
          await verifyOnce()
          const message = { kind: 'workspace_recovery_completion_observe', recovery_id: options.request.recovery_id, launch_sha256: launchHash, ready_sha256: hash(ready), nonce: randomUUID() }
          await exchange(message, reply => hash(reply) === hash({ ...message, kind: 'workspace_recovery_completion_observing' }))
          await options.verify()
        } catch (cause) { close(); throw Object.assign(failure(), { cause }) }
      })
      return completionObservation
    }
    let releasePromise, observationPromise, preparedFingerprint
    const terminalExchange = async (message, replyKind, expected) => {
      await options.verify()
      if (closed || !completionObservation || !child.connected || !native.sameProcess(identity, native.inspectProcess(child.pid))) throw failure()
      terminalReplies.set(message.nonce, replyKind)
      return new Promise((resolve, reject) => {
        let received = false
        const clear = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', failed); child.off('error', failed); child.off('disconnect', failed) }
        const failed = () => { clear(); reject(Object.assign(failure(), { diagnostics: diagnostics.slice() })) }
        const receive = async reply => {
          if (received || reply?.kind !== replyKind || reply?.nonce !== message.nonce) return
          received = true
          try {
            if (!exact(reply, ['kind', 'recovery_id', 'launch_sha256', 'ready_sha256', 'nonce', 'ok', 'result']) || reply.ok !== true
              || reply.recovery_id !== message.recovery_id || reply.launch_sha256 !== message.launch_sha256 || reply.ready_sha256 !== message.ready_sha256
              || hash(reply.result) !== hash(expected) || !readWorkspaceRecoveryCompletionScope(options.dataDir, options.request).released) throw failure()
            await options.verify()
            if (closed || !child.connected || !native.sameProcess(identity, native.inspectProcess(child.pid))) throw failure()
            clear(); resolve(Object.freeze(reply.result))
          } catch { failed() }
        }
        const timer = setTimeout(failed, 20 * 60_000)
        child.on('message', receive); child.once('exit', failed); child.once('error', failed); child.once('disconnect', failed)
        child.send(message, error => { if (error) failed() })
      })
    }
    const terminalMessage = kind => ({ kind, recovery_id: options.request.recovery_id, launch_sha256: launchHash, ready_sha256: hash(ready), nonce: randomUUID() })
    const releasedResult = prepared => { const { prepared: confirmed, ...job } = prepared; if (confirmed !== true) throw failure(); return { released: true, ...job } }
    const releaseCompletion = (prepared, credential, moduleManagerPort) => {
      const fingerprint = hash(prepared)
      if (releasePromise) return fingerprint === preparedFingerprint ? releasePromise : Promise.reject(failure())
      preparedFingerprint = fingerprint
      releasePromise = Promise.resolve().then(() => terminalExchange({ ...terminalMessage('workspace_recovery_release'),
        module_manager_port: moduleManagerPort, prepared, credential }, 'workspace_recovery_released', releasedResult(prepared)))
      return releasePromise
    }
    const observeRelease = prepared => {
      if (!releasePromise || hash(prepared) !== preparedFingerprint) return Promise.reject(failure())
      return observationPromise ??= terminalExchange(terminalMessage('workspace_recovery_release_observe'), 'workspace_recovery_release_observed', releasedResult(prepared))
    }
    await verify()
    return Object.freeze({ child, launch, ready, verify, close, beginCompletionObservation, releaseCompletion, observeRelease })
  } catch (cause) { close(); throw Object.assign(failure(), { cause }) }
}
