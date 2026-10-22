// Neutral runtime proof on one OS-owned connection; it grants no business authority.
const { openPinnedProcessRpc } = require('./pinned-process-rpc.cjs')
const unavailable = cause => Object.assign(new Error('模块运行身份或固定连接无法核验，未继续请求。'), { code: 'CRABOT_MODULE_RPC_UNVERIFIED', ...(cause ? { cause } : {}) })
async function openModuleRuntimeRpc(process, port, expected, options) {
  expected = Object.freeze({ ...expected })
  let rpc
  try {
    if (!['instance_id', 'module_id', 'runtime_id'].every(key => typeof expected[key] === 'string' && expected[key])) throw unavailable()
    rpc = await openPinnedProcessRpc(process, port, options)
    const actual = await rpc.call('get_runtime_identity', {})
    if (!['instance_id', 'module_id', 'runtime_id'].every(key => expected[key] === actual[key])) throw unavailable()
    return rpc
  } catch (error) { rpc?.close(); throw unavailable(error) }
}
module.exports = { openModuleRuntimeRpc }
