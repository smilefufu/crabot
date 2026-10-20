// The fixed coordinator enters once, before importing its business execution graph.
import path from 'node:path'
import native from './process-identity.cjs'
import { acquireWorkspaceRelocationLock, cliLockToken, releaseCliLock } from './cli-lock.mjs'
import { readWorkspaceRelocationCoordinator, commitWorkspaceRelocationCoordinatorReady } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson } from '../../crabot-shared/dist/canonical-json.js'

let entered = false
const failure = () => Object.assign(new Error('迁移协调器交接无法核验，原记录及维护保护已保留。'), { code: 'CRABOT_WORKSPACE_COORDINATOR' })
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
function initialization() {
  return new Promise((resolve, reject) => {
    const clear = () => { clearTimeout(timer); process.off('message', receive); process.off('disconnect', rejectClosed); process.off('error', rejectClosed) }
    const rejectClosed = () => { clear(); reject(failure()) }
    const receive = message => { clear(); resolve(message) }
    const timer = setTimeout(rejectClosed, 5000)
    process.once('message', receive); process.once('disconnect', rejectClosed); process.once('error', rejectClosed)
    if (!process.connected) rejectClosed()
  })
}
export async function enterWorkspaceRelocationCoordinator() {
  if (entered || !process.send || !process.connected) throw failure()
  entered = true
  let lock, token, released = false
  const release = () => {
    if (released) return
    released = true
    if (lock && token && cliLockToken(lock) === token) releaseCliLock(lock)
  }
  try {
    const input = await initialization()
    const keys = ['kind', 'data_dir', 'intent_id', 'launch_id', 'launch_sha256']
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length
      || !Object.keys(input).every(key => keys.includes(key)) || input.kind !== 'workspace_relocation_start'
      || typeof input.data_dir !== 'string' || !path.isAbsolute(input.data_dir) || input.data_dir.includes('\0')
      || !uuid(input.intent_id) || !uuid(input.launch_id) || typeof input.launch_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.launch_sha256)) throw failure()
    const verify = () => {
      const current = readWorkspaceRelocationCoordinator(input.data_dir, input.intent_id), launch = current.launch
      const self = native.inspectProcess(process.pid)
      if (!launch || current.ready || launch.launch_id !== input.launch_id || sha256CanonicalJson(launch) !== input.launch_sha256
        || !native.sameProcess(launch.process, self) || self.parent !== launch.parent.pid
        || !native.sameProcess(launch.parent, native.inspectProcess(launch.parent.pid)) || !process.connected) throw failure()
      return launch
    }
    verify()
    lock = await acquireWorkspaceRelocationLock(input.data_dir, input.intent_id)
    token = cliLockToken(lock)
    const launch = verify()
    if (!token) throw failure()
    const ready = commitWorkspaceRelocationCoordinatorReady({ dataDir: input.data_dir, id: input.intent_id })
    await new Promise((resolve, reject) => process.send({ kind: 'workspace_relocation_ready', intent_id: input.intent_id,
      launch_id: input.launch_id, ready_sha256: sha256CanonicalJson(ready) }, error => error ? reject(failure()) : resolve()))
    if (cliLockToken(lock) !== token) throw failure()
    return Object.freeze({ dataDir: input.data_dir, id: input.intent_id, launch, release })
  } catch { release(); throw failure() }
}
