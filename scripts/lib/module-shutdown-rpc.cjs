// Runtime policy stays here; the transport only pins a verified process connection.
const { openModuleRuntimeRpc } = require('./module-runtime-rpc.cjs')
const unavailable = cause => Object.assign(new Error('模块停机身份或响应无法核验，保留维护保护；未重试停机。'), { code: 'CRABOT_MODULE_SHUTDOWN_UNVERIFIED', ...(cause ? { cause } : {}) })
async function openModuleShutdownRpc(process, port, expected, options) {
  let rpc, submitted = false
  try { rpc = await openModuleRuntimeRpc(process, port, expected, options) }
  catch (cause) { throw unavailable(cause) }

  return {
    async shutdown() {
      try {
        if (submitted) throw unavailable()
        submitted = true
        await rpc.call('shutdown', {}, { verifyAfter: false })
      } catch (cause) { throw unavailable(cause) }
      finally { rpc.close() }
    },
    close: rpc.close,
  }
}
module.exports = { openModuleShutdownRpc }
