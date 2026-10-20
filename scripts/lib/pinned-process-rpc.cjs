// One verified local process, one established TCP connection, no reconnect or retry.
const { Agent, request } = require('node:http')
const { connect } = require('node:net')
const { once } = require('node:events')
const { randomUUID } = require('node:crypto')
const identity = require('./process-identity.cjs')
const unavailable = () => Object.assign(new Error('固定进程连接无法继续核验，未重试请求。'), { code: 'CRABOT_PROCESS_RPC' })

async function openPinnedProcessRpc(expected, port, { signal, timeoutMs = 5000 } = {}) {
  expected = Object.freeze({ ...expected })
  let socket, closed = false, used = false, pending = false
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 })
  const deadline = () => AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
  function verify() {
    if (closed || !Number.isInteger(port) || port < 1 || port > 65535
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647
      || expected.owner !== identity.inspectProcess(process.pid).owner
      || !identity.sameProcess(expected, identity.inspectProcess(expected.pid))
      || !identity.listListeningTcpPorts(expected.pid).includes(port)) throw unavailable()
  }
  function close() { closed = true; agent.destroy(); socket?.destroy() }
  try {
    verify()
    socket = connect({ host: '127.0.0.1', port })
    socket.on('error', () => {}) // The next call rejects an idle disconnect.
    await once(socket, 'connect', { signal: deadline() })
    verify()
    agent.createConnection = () => {
      if (used || closed || socket.destroyed) throw unavailable()
      used = true
      return socket
    }
  } catch { close(); throw unavailable() }

  async function call(method, params, { verifyAfter = true, authorizationBearer } = {}) {
    try {
      verify()
      if (pending || socket.destroyed || typeof method !== 'string' || !/^[a-z][a-z0-9_]*$/.test(method)) throw unavailable()
      if (authorizationBearer !== undefined && (typeof authorizationBearer !== 'string' || !authorizationBearer || /[\r\n]/.test(authorizationBearer))) throw unavailable()
      pending = true
      const id = randomUUID(), text = JSON.stringify({ id, source: 'module-manager', method, params, timestamp: new Date().toISOString() })
      const result = await new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/' + method, method: 'POST', agent,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text),
            ...(authorizationBearer === undefined ? {} : { Authorization: 'Bearer ' + authorizationBearer }),
          }, signal: deadline(),
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
      if (verifyAfter) verify()
      return result
    } catch { close(); throw unavailable() }
    finally { pending = false }
  }
  return { call, close }
}
module.exports = { openPinnedProcessRpc }
