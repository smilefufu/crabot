const { realpathSync } = require('node:fs')
const { readInstanceRuntime } = require('./instance-runtime-record.cjs')
const identity = require('./process-identity.cjs')

// Standalone MM only, before data initialization. The parent publishes mm.pid's
// exact OS identity after spawn. This bounded wait does not block the GUI.
function verifyManagedMmStartup({ root, dataDir, generation }) {
  const deadline = Date.now() + 5000, waiting = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    const record = readInstanceRuntime(dataDir), self = identity.inspectProcess(process.pid)
    if (!record || record.generation !== generation || record.install_root !== realpathSync(root)
      || !self || record.controller.owner !== self.owner) break
    if (record.mm) {
      if (identity.sameProcess(record.mm, self)) return
      break
    }
    if (self.parent !== record.controller.pid || !identity.sameProcess(record.controller, identity.inspectProcess(record.controller.pid))
      || Date.now() >= deadline) break
    Atomics.wait(waiting, 0, 0, 10)
  }
  throw Object.assign(new Error('MM 启动归属尚未登记或已改变；未初始化数据。'), { code: 'CRABOT_MM_STARTUP_UNVERIFIED' })
}

module.exports = { verifyManagedMmStartup }
