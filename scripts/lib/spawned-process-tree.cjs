// Observe a carrier held by the actual spawning Node process; never recover a root from a stale PID file.
const native = require('./process-identity.cjs')
const { captureOwnedProcessTree } = require('./owned-process-tree.cjs')
const fail = (stage, cause) => { throw Object.assign(new Error('原生子进程载体无法核验，已保留维护保护。'), { code: 'CRABOT_PROCESS_SCOPE', stage, ...(cause ? { cause } : {}) }) }
const active = child => child && Number.isInteger(child.pid) && child.pid > 0 && child.exitCode === null && child.signalCode === null
function captureSpawnedProcessTree(child, api = native) {
  let stage = 'child-handle'
  try {
    if (!active(child)) fail(stage)
    stage = 'initial-child-identity'
    const root = api.inspectProcess(child.pid)
    if (!root || root.pid !== child.pid || root.parent !== process.pid) fail('initial-child-parent')
    stage = 'owned-tree'
    const result = captureOwnedProcessTree([root], api)
    stage = 'child-still-active'
    if (!active(child)) fail(stage)
    return result
  } catch (error) { fail(typeof error?.stage === 'string' ? error.stage : stage, error) }
}
module.exports = { captureSpawnedProcessTree }
