// One consumed current-human admission starts this fixed idle generation once.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import native from './process-identity.cjs'
import { captureSpawnedProcessTree } from './spawned-process-tree.cjs'
import { commitWorkspaceInterruptedRecoveryLaunch, readWorkspaceInterruptedRecoveryRole, parseWorkspaceInterruptedRecoveryRequest } from './workspace-interrupted-role.mjs'
import { readWorkspaceSourceRecoveryScope } from './workspace-interrupted-source-records.mjs'
import { readWorkspaceRelocationIntent, readWorkspaceInterruptedRelocationCheckpoint } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
const entry = fileURLToPath(new URL('../workspace-interrupted-coordinator.mjs', import.meta.url))
const failure = () => Object.assign(new Error('本次迁移恢复交接尚未确认，维护保护已保留；未重新启动协调器。'), { code: 'CRABOT_WORKSPACE_RECOVERY_COORDINATOR' })
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
export async function launchWorkspaceInterruptedRecoveryCoordinator(options) {
  let child, closed = false, pending = false, launch, ready
  const close = () => { closed = true; if (child?.connected) child.disconnect() }
  try {
    if (!exact(options, ['dataDir', 'request', 'verify', 'releaseParentLock']) || typeof options.verify !== 'function'
      || typeof options.releaseParentLock !== 'function' || process.versions.electron) throw failure()
    const request = parseWorkspaceInterruptedRecoveryRequest(options.request)
    await options.verify()
    const original = readWorkspaceRelocationIntent(options.dataDir) ? readWorkspaceInterruptedRelocationCheckpoint(options.dataDir, request.intent_id)
      : readWorkspaceSourceRecoveryScope(options.dataDir, request.intent_id).checkpoint
    if (readWorkspaceInterruptedRecoveryRole(options.dataDir, request.recovery_id).launch) throw failure()
    const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'])
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())))
    child = spawn(process.execPath, [entry], { cwd: path.dirname(entry), env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true })
    child.on('error', close); child.once('exit', close)
    child.on('message', () => { if (!pending) close() })
    const identity = captureSpawnedProcessTree(child).find(value => value.pid === child.pid)
    if (!identity) throw failure()
    function exchange(message, expected, timeout = 15000) {
      if (closed || pending || !child.connected) return Promise.reject(failure())
      return new Promise((resolve, reject) => {
        const clear = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', failed); child.off('error', failed); child.off('disconnect', failed); pending = false }
        const failed = () => { clear(); close(); reject(failure()) }
        const receive = reply => { try { if (!expected(reply)) throw failure(); clear(); resolve(reply) } catch { failed() } }
        const timer = setTimeout(failed, timeout)
        pending = true; child.on('message', receive); child.once('exit', failed); child.once('error', failed); child.once('disconnect', failed)
        if (message) child.send(message, error => { if (error) failed() })
      })
    }
    launch = await commitWorkspaceInterruptedRecoveryLaunch({ dataDir: options.dataDir, request, coordinator: identity, verify: options.verify })
    // Readiness is published by the child after it acquires the actual mutex.
    const waiting = exchange(null, reply => {
      ready = readWorkspaceInterruptedRecoveryRole(options.dataDir, request.recovery_id).ready
      return !!ready && hash(reply) === hash({ kind: 'workspace_interrupted_ready', recovery_id: request.recovery_id, launch_sha256: hash(launch), ready_sha256: hash(ready) })
    })
    void waiting.catch(() => {})
    await options.verify(); options.releaseParentLock()
    child.send({ kind: 'workspace_interrupted_initialize', data_dir: options.dataDir, recovery_id: request.recovery_id, launch_sha256: hash(launch) }, error => { if (error) close() })
    await waiting
    let verification = Promise.resolve()
    const verify = () => {
      verification = verification.then(async () => {
        const stored = readWorkspaceInterruptedRecoveryRole(options.dataDir, request.recovery_id)
        if (closed || !child.connected || !native.sameProcess(identity, native.inspectProcess(child.pid)) || hash(stored.launch) !== hash(launch) || hash(stored.ready) !== hash(ready)) throw failure()
        const message = { kind: 'workspace_interrupted_verify', recovery_id: request.recovery_id, launch_sha256: hash(launch), ready_sha256: hash(ready), nonce: randomUUID() }
        await exchange(message, reply => hash(reply) === hash({ ...message, kind: 'workspace_interrupted_verified' }))
      }).catch(cause => { close(); throw Object.assign(failure(), { cause }) })
      return verification
    }
    let restoration
    const restoreSource = () => {
      if (restoration) return restoration
      restoration = verification.then(async () => {
        const message = { kind: 'workspace_interrupted_restore_source', recovery_id: request.recovery_id, launch_sha256: hash(launch), ready_sha256: hash(ready), nonce: randomUUID() }
        let result
        await exchange(message, reply => {
          if (!exact(reply, ['kind', 'recovery_id', 'launch_sha256', 'ready_sha256', 'nonce', 'result']) || reply.kind !== 'workspace_interrupted_source_restored'
            || ['recovery_id', 'launch_sha256', 'ready_sha256', 'nonce'].some(key => reply[key] !== message[key])
            || !exact(reply.result, ['source_restored', 'source', 'retained_staging']) || reply.result.source_restored !== true
            || reply.result.source !== original.intent.source.path
            || reply.result.retained_staging !== (original.file_plan?.staging_path ?? null)) return false
          result = Object.freeze({ ...reply.result }); return true
        }, 240000)
        return result
      }).catch(cause => { close(); throw Object.assign(failure(), { cause }) })
      verification = restoration
      return restoration
    }
    let archive
    const archiveSource = () => {
      if (archive) return archive
      archive = verification.then(async () => {
        const message = { kind: 'workspace_interrupted_archive_source', recovery_id: request.recovery_id, launch_sha256: hash(launch), ready_sha256: hash(ready), nonce: randomUUID() }
        await exchange(message, reply => hash(reply) === hash({ ...message, kind: 'workspace_interrupted_source_archived', result: { source_restored: true, service_restored: false } }), 240000)
        return Object.freeze({ source_restored: true, service_restored: false })
      }).catch(cause => { close(); throw Object.assign(failure(), { cause }) })
      verification = archive
      return archive
    }
    let business
    const prepareSourceBusiness = () => {
      if (business) return business
      business = verification.then(async () => {
        const message = { kind: 'workspace_interrupted_prepare_source_business', recovery_id: request.recovery_id, launch_sha256: hash(launch), ready_sha256: hash(ready), nonce: randomUUID() }
        await exchange(message, reply => hash(reply) === hash({ ...message, kind: 'workspace_interrupted_source_business_prepared', result: { prepared: true } }), 240000)
        return Object.freeze({ prepared: true })
      }).catch(cause => { close(); throw Object.assign(failure(), { cause }) })
      verification = business
      return business
    }
    let release, releaseFingerprint
    const releaseSource = ({ job, credential, moduleManagerPort }) => {
      const fingerprint = hash(job)
      if (release) return releaseFingerprint === fingerprint ? release : Promise.reject(failure())
      releaseFingerprint = fingerprint
      release = verification.then(async () => {
        const message = { kind: 'workspace_interrupted_release_source', recovery_id: request.recovery_id, launch_sha256: hash(launch), ready_sha256: hash(ready), nonce: randomUUID() }
        const result = Object.freeze({ released: true, ...structuredClone(job) })
        await exchange({ ...message, job, credential, module_manager_port: moduleManagerPort }, reply => hash(reply) === hash({ ...message, kind: 'workspace_interrupted_source_released', result }), 240000)
        return result
      }).catch(cause => { close(); throw Object.assign(failure(), { cause }) })
      verification = release
      return release
    }
    await verify()
    let closures
    const finishClosures = () => {
      if (closures) return closures
      closures = verification.then(async () => {
        const message = { kind: 'workspace_interrupted_finish_closures', recovery_id: request.recovery_id, launch_sha256: hash(launch), ready_sha256: hash(ready), nonce: randomUUID() }
        let result
        await exchange(message, reply => {
          if (!exact(reply, ['kind', 'recovery_id', 'launch_sha256', 'ready_sha256', 'nonce', 'result']) || reply.kind !== 'workspace_interrupted_closures_finished'
            || ['recovery_id', 'launch_sha256', 'ready_sha256', 'nonce'].some(key => reply[key] !== message[key])
            || !exact(reply.result, ['dispatch', 'closed_ledgers', 'commit_sha256']) || !['dispatch', 'observe'].includes(reply.result.dispatch)
            || !Number.isSafeInteger(reply.result.closed_ledgers) || reply.result.closed_ledgers < 0
            || reply.result.commit_sha256 !== hash(readWorkspaceInterruptedRelocationCheckpoint(options.dataDir, request.intent_id).closure_commit)) return false
          result = Object.freeze({ ...reply.result }); return true
        }, 240000)
        return result
      }).catch(cause => { close(); throw Object.assign(failure(), { cause }) })
      verification = closures
      return closures
    }
    let managerRecovery
    const finishManagerRecovery = () => {
      if (managerRecovery) return managerRecovery
      managerRecovery = verification.then(async () => {
        const message = { kind: 'workspace_interrupted_finish_manager_recovery', recovery_id: request.recovery_id, launch_sha256: hash(launch), ready_sha256: hash(ready), nonce: randomUUID() }
        let result
        await exchange(message, reply => {
          if (!exact(reply, ['kind', 'recovery_id', 'launch_sha256', 'ready_sha256', 'nonce', 'result']) || reply.kind !== 'workspace_interrupted_manager_recovery_finished'
            || ['recovery_id', 'launch_sha256', 'ready_sha256', 'nonce'].some(key => reply[key] !== message[key])
            || !exact(reply.result, ['dispatch', 'commit_sha256']) || !['dispatch', 'observe'].includes(reply.result.dispatch)
            || reply.result.commit_sha256 !== hash(readWorkspaceInterruptedRelocationCheckpoint(options.dataDir, request.intent_id).recovery_commit)) return false
          result = Object.freeze({ ...reply.result }); return true
        }, 240000)
        return result
      }).catch(cause => { close(); throw Object.assign(failure(), { cause }) })
      verification = managerRecovery
      return managerRecovery
    }
    return Object.freeze({ child, launch, ready, verify, restoreSource, archiveSource, prepareSourceBusiness, releaseSource, finishClosures, finishManagerRecovery, close })
  } catch (cause) { close(); throw Object.assign(failure(), { cause }) }
}
