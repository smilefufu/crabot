// Observe a carrier held by the actual spawning Node process; never recover a root from a stale PID file.
const native = require('./process-identity.cjs')
const { captureOwnedProcessTree } = require('./owned-process-tree.cjs')
const fail = () => { throw Object.assign(new Error('原生子进程载体无法核验，已保留维护保护。'), { code: 'CRABOT_PROCESS_SCOPE' }) }
const active = child => child && Number.isInteger(child.pid) && child.pid > 0 && child.exitCode === null && child.signalCode === null
function captureSpawnedProcessTree(child, api = native) {
  try {
    if (!active(child)) fail()
    const root = api.inspectProcess(child.pid)
    if (!root || root.pid !== child.pid || root.parent !== process.pid) fail()
    const result = captureOwnedProcessTree([root], api)
    if (!active(child)) fail()
    return result
  } catch { fail() }
}
module.exports = { captureSpawnedProcessTree }
