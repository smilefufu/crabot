// Loaded by Node before the fixed orphan-preflight entry can touch its registry.
import { setTimeout as delay } from 'node:timers/promises'
import state from './preflight-state.cjs'
import identity from './process-identity.cjs'
import { hasInheritedCliLock } from './cli-lock.mjs'

const dataDir = process.env.CRABOT_PREFLIGHT_DATA_DIR, id = process.env.CRABOT_PREFLIGHT_ID
delete process.env.CRABOT_PREFLIGHT_DATA_DIR
delete process.env.CRABOT_PREFLIGHT_ID
if (!dataDir || !id) throw state.failure()
const self = identity.inspectProcess(process.pid), deadline = Date.now() + 5000
for (;;) {
  const record = state.read(dataDir)
  if (record?.id !== id || !identity.sameProcess(record.owner, identity.inspectProcess(record.owner.pid))
    || self.parent !== record.owner.pid) throw state.failure()
  if (record.child) {
    if (!identity.sameProcess(record.child, self) || !hasInheritedCliLock(dataDir, record.lock_token)) throw state.failure()
    break
  }
  if (Date.now() >= deadline) throw state.failure()
  await delay(20)
}
