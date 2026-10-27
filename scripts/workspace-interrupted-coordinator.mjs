// Fixed current generation only. No old coordinator, Worker or model runner is entered.
import path from 'node:path'
import { acquireWorkspaceRelocationLock, cliLockToken, releaseCliLock } from './lib/cli-lock.mjs'
import { readWorkspaceInterruptedRecoveryRole, verifyWorkspaceInterruptedRecoveryRole, commitWorkspaceInterruptedRecoveryReady } from './lib/workspace-interrupted-role.mjs'
import { sha256CanonicalJson as hash } from '../crabot-shared/dist/canonical-json.js'
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
let input, lock, token, ready, sourceRestoration, busy = false, closed = false
function close() {
  if (closed) return
  closed = true; clearTimeout(timer)
  if (lock && token && cliLockToken(lock) === token) releaseCliLock(lock)
  if (process.connected) process.disconnect()
}
const timer = setTimeout(close, 5000)
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()))
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
      lock = await acquireWorkspaceRelocationLock(input.data_dir, launch.request.intent_id); token = cliLockToken(lock)
      if (closed || !token) throw new Error('Recovery mutex unavailable')
      ready = commitWorkspaceInterruptedRecoveryReady({ dataDir: input.data_dir, recoveryId: input.recovery_id, launchHash: input.launch_sha256 })
      clearTimeout(timer)
      await send({ kind: 'workspace_interrupted_ready', recovery_id: input.recovery_id, launch_sha256: input.launch_sha256, ready_sha256: hash(ready) })
    } else {
      if (!ready || !exact(message, ['kind', 'recovery_id', 'launch_sha256', 'ready_sha256', 'nonce']) || !['workspace_interrupted_verify', 'workspace_interrupted_restore_source'].includes(message.kind)
        || message.recovery_id !== input.recovery_id || message.launch_sha256 !== input.launch_sha256 || message.ready_sha256 !== hash(ready) || !uuid(message.nonce)) throw new Error('Invalid role request')
      verifyWorkspaceInterruptedRecoveryRole({ dataDir: input.data_dir, recoveryId: input.recovery_id, launchHash: input.launch_sha256 })
      if (message.kind === 'workspace_interrupted_restore_source') {
        sourceRestoration ??= Promise.resolve().then(async () => {
          const { restoreWorkspaceInterruptedSource } = await import('./lib/workspace-interrupted-source-restore.mjs')
          return restoreWorkspaceInterruptedSource({ dataDir: input.data_dir, recoveryId: input.recovery_id, launchHash: input.launch_sha256 })
        })
        const result = await sourceRestoration
        await send({ ...message, kind: 'workspace_interrupted_source_restored', result })
      } else await send({ ...message, kind: 'workspace_interrupted_verified' })
    }
  } catch { close() } finally { busy = false }
})

if (!process.connected) close()
