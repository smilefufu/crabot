// Fixed current generation only. No old coordinator, Worker or model runner is entered.
import path from 'node:path'
import { acquireWorkspaceInterruptedRecoveryLock, cliLockToken, releaseCliLock } from './lib/cli-lock.mjs'
import { readWorkspaceInterruptedRecoveryRole, verifyWorkspaceInterruptedRecoveryRole, commitWorkspaceInterruptedRecoveryReady } from './lib/workspace-interrupted-role.mjs'
import { sha256CanonicalJson as hash } from '../crabot-shared/dist/canonical-json.js'
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
let input, lock, token, ready, sourceRestoration, sourceArchive, sourceBusiness, sourceRelease, closures, managerRecovery, root, forwardPreparation, busy = false, closed = false
function close() {
  if (closed) return
  closed = true; clearTimeout(timer)
  if (lock && token && cliLockToken(lock) === token) releaseCliLock(lock)
  if (process.connected) process.disconnect()
}
const timer = setTimeout(close, 5000)
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()))
function finishClosures() {
  return closures ??= Promise.resolve().then(async () => {
    const { finishWorkspaceInterruptedClosures } = await import('./lib/workspace-interrupted-closure.mjs')
    return finishWorkspaceInterruptedClosures({ dataDir: input.data_dir, recoveryId: input.recovery_id, launchHash: input.launch_sha256 })
  })
}
function finishManagerRecovery() {
  return managerRecovery ??= Promise.resolve().then(async () => {
    await finishClosures()
    const { finishWorkspaceInterruptedManagerRecovery } = await import('./lib/workspace-interrupted-manager.mjs')
    return finishWorkspaceInterruptedManagerRecovery({ dataDir: input.data_dir, recoveryId: input.recovery_id, launchHash: input.launch_sha256 })
  })
}
function finishRoot() {
  return root ??= Promise.resolve().then(async () => {
    await finishManagerRecovery()
    const { finishWorkspaceInterruptedRoot } = await import('./lib/workspace-interrupted-root.mjs')
    return finishWorkspaceInterruptedRoot({ dataDir: input.data_dir, recoveryId: input.recovery_id, launchHash: input.launch_sha256 })
  })
}
process.once('disconnect', close); process.once('error', close)
process.on('message', async message => {
  try {
    if (closed || busy) throw new Error('Recovery role is unavailable')
    busy = true
    if (!input) {
      if (!exact(message, ['kind', 'data_dir', 'recovery_id', 'launch_sha256']) || message.kind !== 'workspace_interrupted_initialize'
        || typeof message.data_dir !== 'string' || !path.isAbsolute(message.data_dir) || message.data_dir.includes('\0')
        || !uuid(message.recovery_id) || typeof message.launch_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(message.launch_sha256)) throw new Error('Invalid initialization')
      input = Object.freeze({ ...message })
      const launch = readWorkspaceInterruptedRecoveryRole(input.data_dir, input.recovery_id).launch
      if (!launch || hash(launch) !== input.launch_sha256) throw new Error('Missing original launch')
      lock = await acquireWorkspaceInterruptedRecoveryLock(input.data_dir, launch.request.intent_id); token = cliLockToken(lock)
      if (closed || !token) throw new Error('Recovery mutex unavailable')
      ready = commitWorkspaceInterruptedRecoveryReady({ dataDir: input.data_dir, recoveryId: input.recovery_id, launchHash: input.launch_sha256 })
      clearTimeout(timer)
      await send({ kind: 'workspace_interrupted_ready', recovery_id: input.recovery_id, launch_sha256: input.launch_sha256, ready_sha256: hash(ready) })
    } else {
      const fields = ['kind', 'recovery_id', 'launch_sha256', 'ready_sha256', 'nonce']
      if (message.kind === 'workspace_interrupted_release_source') fields.push('job', 'credential', 'module_manager_port')
      if (!ready || !exact(message, fields) || !['workspace_interrupted_verify', 'workspace_interrupted_restore_source', 'workspace_interrupted_archive_source', 'workspace_interrupted_prepare_source_business', 'workspace_interrupted_release_source', 'workspace_interrupted_finish_closures', 'workspace_interrupted_finish_manager_recovery', 'workspace_interrupted_finish_root', 'workspace_interrupted_prepare_forward_service'].includes(message.kind)
        || message.recovery_id !== input.recovery_id || message.launch_sha256 !== input.launch_sha256 || message.ready_sha256 !== hash(ready) || !uuid(message.nonce)) throw new Error('Invalid role request')
      verifyWorkspaceInterruptedRecoveryRole({ dataDir: input.data_dir, recoveryId: input.recovery_id, launchHash: input.launch_sha256 })
      if (message.kind === 'workspace_interrupted_prepare_forward_service') {
        forwardPreparation ??= Promise.resolve().then(async () => {
          await finishRoot()
          const { prepareWorkspaceInterruptedForwardService } = await import('./lib/workspace-interrupted-forward-records.mjs')
          return prepareWorkspaceInterruptedForwardService({ dataDir: input.data_dir, recoveryId: input.recovery_id, launchHash: input.launch_sha256 })
        })
        await send({ ...message, kind: 'workspace_interrupted_forward_prepared', result: await forwardPreparation })
      } else if (message.kind === 'workspace_interrupted_finish_root') {
        await send({ ...message, kind: 'workspace_interrupted_root_finished', result: await finishRoot() })
      } else if (message.kind === 'workspace_interrupted_finish_manager_recovery') {
        await send({ ...message, kind: 'workspace_interrupted_manager_recovery_finished', result: await finishManagerRecovery() })
      } else if (message.kind === 'workspace_interrupted_finish_closures') {
        await send({ ...message, kind: 'workspace_interrupted_closures_finished', result: await finishClosures() })
      } else if (message.kind === 'workspace_interrupted_restore_source') {
        sourceRestoration ??= Promise.resolve().then(async () => {
          const { restoreWorkspaceInterruptedSource } = await import('./lib/workspace-interrupted-source-restore.mjs')
          return restoreWorkspaceInterruptedSource({ dataDir: input.data_dir, recoveryId: input.recovery_id, launchHash: input.launch_sha256 })
        })
        const result = await sourceRestoration
        await send({ ...message, kind: 'workspace_interrupted_source_restored', result })
      } else if (message.kind === 'workspace_interrupted_archive_source') {
        if (!sourceRestoration) throw new Error('No verified source restoration')
        await sourceRestoration
        sourceArchive ??= Promise.resolve().then(async () => {
          const { archiveWorkspaceInterruptedSource } = await import('./lib/workspace-interrupted-source-archive.mjs')
          return archiveWorkspaceInterruptedSource({ dataDir: input.data_dir, recoveryId: input.recovery_id, launchHash: input.launch_sha256 })
        })
        await send({ ...message, kind: 'workspace_interrupted_source_archived', result: await sourceArchive })
      } else if (message.kind === 'workspace_interrupted_prepare_source_business') {
        sourceBusiness ??= Promise.resolve().then(async () => {
          const { prepareWorkspaceInterruptedSourceBusiness } = await import('./lib/workspace-interrupted-source-business.mjs')
          return prepareWorkspaceInterruptedSourceBusiness({ dataDir: input.data_dir, recoveryId: input.recovery_id, launchHash: input.launch_sha256 })
        })
        await send({ ...message, kind: 'workspace_interrupted_source_business_prepared', result: await sourceBusiness })
      } else if (message.kind === 'workspace_interrupted_release_source') {
        sourceRelease ??= Promise.resolve().then(async () => {
          const { releaseWorkspaceInterruptedSource } = await import('./lib/workspace-interrupted-source-release.mjs')
          return releaseWorkspaceInterruptedSource({ dataDir: input.data_dir, recoveryId: input.recovery_id, launchHash: input.launch_sha256,
            job: message.job, credential: message.credential, moduleManagerPort: message.module_manager_port })
        })
        // Credentials are never copied into acknowledgement frames or diagnostics.
        const { job: _, credential: secret, module_manager_port: port, ...reply } = message
        await send({ ...reply, kind: 'workspace_interrupted_source_released', result: await sourceRelease })
      } else await send({ ...message, kind: 'workspace_interrupted_verified' })
    }
  } catch (error) {
    const operations = ['workspace_interrupted_initialize', 'workspace_interrupted_verify', 'workspace_interrupted_restore_source', 'workspace_interrupted_archive_source',
      'workspace_interrupted_prepare_source_business', 'workspace_interrupted_release_source', 'workspace_interrupted_finish_closures', 'workspace_interrupted_finish_manager_recovery', 'workspace_interrupted_finish_root', 'workspace_interrupted_prepare_forward_service']
    const codes = ['WORKSPACE_RELOCATION_INVALID', 'CRABOT_WORKSPACE_RECOVERY_COORDINATOR', 'EACCES', 'EBUSY', 'EPERM', 'ENOENT', 'EEXIST', 'EIO']
    // Fixed technical labels only; never a request, credential, path or error body.
    process.stderr.write(JSON.stringify({ component: 'workspace-interrupted-recovery', operation: operations.includes(message?.kind) ? message.kind : 'invalid-request',
      code: codes.includes(error?.code) ? error.code : 'RECOVERY_ROLE_FAILED' }) + '\n')
    close()
  } finally { busy = false }
})

if (!process.connected) close()
