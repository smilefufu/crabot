// Legacy policy: prove a known module definition before shutdown on the same connection.
import transport from './pinned-process-rpc.cjs'
const unavailable = () => Object.assign(new Error('旧实例连接或进程归属无法继续核验；未重试停机，保留原安装。'), { code: 'CRABOT_LEGACY_RUNTIME_UNVERIFIED' })

export async function openLegacyMmRpc(expected, port, options = {}) {
  let rpc, read = false
  try { rpc = await transport.openPinnedProcessRpc(expected, port, options) }
  catch { throw unavailable() }
  return {
    async getDefinition(moduleId) {
      try {
        if (!['crabot-agent', 'admin-web', 'memory-default'].includes(moduleId)) throw unavailable()
        const result = await rpc.call('get_module_definition', { module_id: moduleId })
        if (!result.definition || result.definition.module_id !== moduleId) throw unavailable()
        read = true
        return result.definition
      } catch { rpc.close(); throw unavailable() }
    },
    async shutdown() {
      try {
        if (!read) throw unavailable()
        await rpc.call('shutdown', {}, { verifyAfter: false })
      } catch { rpc.close(); throw unavailable() }
    },
    close: rpc.close,
  }
}
