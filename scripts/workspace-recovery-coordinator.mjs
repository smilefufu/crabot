// Fixed, idle recovery generation. This entry imports no business journal or runner.
import path from 'node:path'
import { sha256CanonicalJson as hash } from '../crabot-shared/dist/canonical-json.js'
import native from './lib/process-identity.cjs'
import { acquireWorkspaceRelocationRecoveryLock, cliLockToken, releaseCliLock } from './lib/cli-lock.mjs'
import { readWorkspaceRecoveryCoordinator, commitWorkspaceRecoveryCoordinatorReady } from './lib/workspace-recovery-records.mjs'
import { readWorkspaceRecoveryAdmissionScope, readWorkspaceRecoveryCompletionScope } from './lib/workspace-recovery-admission.mjs'

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
let closed = false, initializing = false, lock, token, input, launch, ready, fingerprint
let completionObservation = false, releasedObserved = false
const close = () => {
  if (closed) return
  closed = true; clearTimeout(timer)
  if (lock && token && cliLockToken(lock) === token) releaseCliLock(lock)
  if (process.connected) process.disconnect()
}
const timer = setTimeout(close, 5000)
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()))
function verify() {
  const records = readWorkspaceRecoveryCoordinator(input.data_dir, input.recovery_id), self = native.inspectProcess(process.pid)
  const scope = completionObservation ? readWorkspaceRecoveryCompletionScope(input.data_dir, launch.request) : readWorkspaceRecoveryAdmissionScope(input.data_dir, launch.request)
  if (releasedObserved && !scope.released) throw new Error('Released observation cannot regress')
  releasedObserved ||= !!scope.released
  if (closed || !process.connected || !native.sameProcess(launch.process, self) || self.parent !== launch.parent.pid
    || !native.sameProcess(launch.parent, native.inspectProcess(launch.parent.pid)) || hash(records.launch) !== input.launch_sha256
    || (ready ? hash(records.ready) !== hash(ready) : records.ready !== null)
    || scope.fingerprint !== fingerprint
    || (token && cliLockToken(lock) !== token)) throw new Error('Recovery generation cannot be verified')
}
process.once('disconnect', close); process.once('error', close)
process.on('message', async message => {
  try {
    if (closed) return
    if (!input) {
      if (initializing || !exact(message, ['kind', 'data_dir', 'recovery_id', 'launch_sha256']) || message.kind !== 'workspace_recovery_initialize'
        || typeof message.data_dir !== 'string' || !path.isAbsolute(message.data_dir) || message.data_dir.includes('\0')
        || !uuid(message.recovery_id) || !digest(message.launch_sha256)) throw new Error('Invalid initialization')
      initializing = true; input = Object.freeze({ ...message })
      launch = readWorkspaceRecoveryCoordinator(input.data_dir, input.recovery_id).launch
      if (!launch) throw new Error('Missing launch')
      fingerprint = readWorkspaceRecoveryAdmissionScope(input.data_dir, launch.request).fingerprint
      verify()
      lock = await acquireWorkspaceRelocationRecoveryLock(input.data_dir, launch.request.intent_id)
      token = cliLockToken(lock)
      if (!token || closed) throw new Error('Recovery lock not owned')
      verify()
      ready = await commitWorkspaceRecoveryCoordinatorReady({ dataDir: input.data_dir, recoveryId: input.recovery_id, launchHash: input.launch_sha256 })
      verify(); clearTimeout(timer)
      await send({ kind: 'workspace_recovery_ready', recovery_id: input.recovery_id, launch_sha256: input.launch_sha256, ready_sha256: hash(ready) })
      return
    }
    if (!ready || !exact(message, ['kind', 'recovery_id', 'launch_sha256', 'ready_sha256', 'nonce']) || !['workspace_recovery_verify', 'workspace_recovery_completion_observe'].includes(message.kind)
      || message.recovery_id !== input.recovery_id || message.launch_sha256 !== input.launch_sha256 || message.ready_sha256 !== hash(ready) || !uuid(message.nonce)) throw new Error('Invalid lock query')
    verify()
    if (message.kind === 'workspace_recovery_completion_observe') {
      if (completionObservation) throw new Error('Completion observation is already accepted')
      completionObservation = true
      verify()
    }
    await send({ ...message, kind: message.kind === 'workspace_recovery_completion_observe' ? 'workspace_recovery_completion_observing' : 'workspace_recovery_verified' })
  } catch {
    // A disconnect during acquisition may precede the handle being returned.
    if (lock && token && cliLockToken(lock) === token) releaseCliLock(lock)
    close(); process.exitCode = 1
  }
})
if (!process.send || !process.connected || process.versions.electron) close()
