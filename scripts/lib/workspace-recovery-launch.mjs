// Only a consumed, current human admission may call this fixed idle initializer.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import native from './process-identity.cjs'
import { captureSpawnedProcessTree } from './spawned-process-tree.cjs'
import { commitWorkspaceRecoveryCoordinatorLaunch, readWorkspaceRecoveryCoordinator } from './workspace-recovery-records.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
const entry = fileURLToPath(new URL('../workspace-recovery-coordinator.mjs', import.meta.url))
const failure = () => Object.assign(new Error('新恢复协调器交接尚未确认，维护保护已保留；未重试启动。'), { code: 'CRABOT_WORKSPACE_RECOVERY_COORDINATOR' })
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
export async function launchWorkspaceRecoveryCoordinator(options) {
  let child, closed = false, launch, ready, identity, pending
  const close = () => { closed = true; if (child?.connected) child.disconnect() }
  try {
    if (!exact(options, ['dataDir', 'request', 'admission', 'verify', 'releaseParentLock']) || typeof options.verify !== 'function'
      || typeof options.releaseParentLock !== 'function' || process.versions.electron) throw failure()
    await options.verify()
    if (readWorkspaceRecoveryCoordinator(options.dataDir, options.request.recovery_id).launch) throw failure()
    const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'])
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())))
    child = spawn(process.execPath, [entry], { cwd: path.dirname(entry), env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
    child.on('error', close); child.once('exit', close)
    child.on('message', () => { if (!pending) close() })
    identity = captureSpawnedProcessTree(child).find(value => value.pid === child.pid)
    if (!identity) throw failure()
    function exchange(message, expected) {
      if (closed || pending || !child.connected) return Promise.reject(failure())
      return new Promise((resolve, reject) => {
        const clear = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', failed); child.off('error', failed); child.off('disconnect', failed); pending = undefined }
        const failed = () => { clear(); close(); reject(failure()) }
        const receive = reply => { try { if (!expected(reply)) throw failure(); clear(); resolve(reply) } catch { failed() } }
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
    await verify()
    return Object.freeze({ child, launch, ready, verify, close, beginCompletionObservation })
  } catch (cause) { close(); throw Object.assign(failure(), { cause }) }
}
