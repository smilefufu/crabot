// Runtime policy stays here; the transport only pins a verified process connection.
const { openPinnedProcessRpc } = require('./pinned-process-rpc.cjs')
const unavailable = () => Object.assign(new Error('模块停机身份或响应无法核验，保留维护保护；未重试停机。'), { code: 'CRABOT_MODULE_SHUTDOWN_UNVERIFIED' })
async function openModuleShutdownRpc(process, port, expected, options) {
  expected = Object.freeze({ ...expected })
  let rpc, submitted = false
  try {
    if (!['instance_id', 'module_id', 'runtime_id'].every(key => typeof expected[key] === 'string' && expected[key])) throw unavailable()
    rpc = await openPinnedProcessRpc(process, port, options)
    const actual = await rpc.call('get_runtime_identity', {})
    if (!['instance_id', 'module_id', 'runtime_id'].every(key => expected[key] === actual[key])) throw unavailable()
  } catch { rpc?.close(); throw unavailable() }
  return {
    async shutdown() {
      try {
        if (submitted) throw unavailable()
        submitted = true
        await rpc.call('shutdown', {}, { verifyAfter: false })
      } catch { throw unavailable() }
      finally { rpc.close() }
    },
    close: rpc.close,
  }
}
module.exports = { openModuleShutdownRpc }
