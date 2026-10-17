// Legacy MM has no generation-bound shutdown. Keep its read-only proof and any
// subsequent shutdown on one established socket; never reconnect a mutation.
import { Agent, request } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import identity from './process-identity.cjs'

const unavailable = () => Object.assign(new Error('旧实例连接或进程归属无法继续核验；未重试停机，保留原安装。'), { code: 'CRABOT_LEGACY_RUNTIME_UNVERIFIED' })

export async function openLegacyMmRpc(expected, port, { signal } = {}) {
  let socket
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 })
  let closed = false, used = false, read = false
  function verify() {
    if (closed || !Number.isInteger(port) || port < 1 || port > 65535
      || expected.owner !== identity.inspectProcess(process.pid).owner
      || !identity.sameProcess(expected, identity.inspectProcess(expected.pid))
      || !identity.listListeningTcpPorts(expected.pid).includes(port)) throw unavailable()
  }
  function close() { closed = true; agent.destroy(); socket?.destroy() }
  try {
    verify()
    socket = connect({ host: '127.0.0.1', port })
    socket.on('error', () => {}) // Idle disconnects are handled by the next call.
    await once(socket, 'connect', { signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]) })
    verify()
    agent.createConnection = () => {
      if (used || closed || socket.destroyed) throw unavailable()
      used = true
      return socket
    }
  } catch { close(); throw unavailable() }

  async function call(method, params, mutation = false) {
    try {
      verify()
      if (socket.destroyed || mutation && !read) throw unavailable()
      const id = randomUUID(), text = JSON.stringify({ id, params })
      const result = await new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/' + method, method: 'POST', agent,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) },
          signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
        }, async response => {
          try {
            const chunks = []; let size = 0
            for await (const chunk of response) {
              size += chunk.length
              if (size > 256 * 1024) { response.destroy(); throw unavailable() }
              chunks.push(chunk)
            }
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (response.statusCode !== 200 || value.success !== true || value.id !== id
              || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw unavailable()
            resolve(value.data)
          } catch { reject(unavailable()) }
        })
        req.on('error', () => reject(unavailable()))
        req.end(text)
      })
      if (!mutation) verify()
      return result
    } catch { close(); throw unavailable() }
  }
  return {
    async getDefinition(moduleId) {
      if (!['crabot-agent', 'admin-web', 'memory-default'].includes(moduleId)) throw unavailable()
      const result = await call('get_module_definition', { module_id: moduleId })
      if (!result.definition || result.definition.module_id !== moduleId) { close(); throw unavailable() }
      read = true
      return result.definition
    },
    async shutdown() { await call('shutdown', {}, true) },
    close,
  }
}
