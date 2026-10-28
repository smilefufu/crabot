// Bind a module service to one currently owned carrier tree; no lifecycle or business authority.
const { ChildProcess } = require('node:child_process')
const native = require('./process-identity.cjs')
const { captureSpawnedProcessTree } = require('./spawned-process-tree.cjs')
const { probeKnownProcessExit } = require('./known-process-exit.cjs')
const { openModuleRuntimeRpc } = require('./module-runtime-rpc.cjs')
const fail = cause => { throw Object.assign(new Error('模块实际载体或唯一监听进程无法核验，未重连请求。'), { code: 'CRABOT_MODULE_CARRIER_UNVERIFIED', ...(cause ? { cause } : {}) }) }

async function openSpawnedModuleRuntimeRpc(child, root, port, expected, options) {
  root = Object.freeze({ ...root })
  let rpc
  const locate = () => {
    if (!(child instanceof ChildProcess) || child.pid !== root.pid || !native.sameProcess(root, native.inspectProcess(child.pid))) fail()
    const listeners = []
    for (const observed of captureSpawnedProcessTree(child)) {
      try {
        if (!native.sameProcess(observed, native.inspectProcess(observed.pid))) fail()
        if (!native.listListeningTcpPorts(observed.pid).includes(port)) continue
        if (!native.sameProcess(observed, native.inspectProcess(observed.pid))) fail()
        listeners.push(observed)
      } catch (error) {
        if (probeKnownProcessExit([observed]).state !== 'stopped') throw error
      }
    }
    if (listeners.length !== 1 || !native.sameProcess(root, native.inspectProcess(child.pid))) fail()
    return listeners[0]
  }
  try {
    const listener = locate()
    rpc = await openModuleRuntimeRpc(listener, port, expected, options)
    const verify = () => { if (!native.sameProcess(listener, locate())) fail() }
    verify()
    return {
      async call(...args) {
        try {
          verify()
          const result = await rpc.call(...args)
          verify()
          return result
        } catch (error) { rpc.close(); fail(error) }
      },
      close: rpc.close,
    }
  } catch (error) { rpc?.close(); fail(error) }
}
module.exports = { openSpawnedModuleRuntimeRpc }
