// One verified local process, one established TCP connection, no reconnect or retry.
const { Agent, request } = require('node:http')
const { connect } = require('node:net')
const { once } = require('node:events')
const { randomUUID } = require('node:crypto')
const identity = require('./process-identity.cjs')
const unavailable = (stage, details = {}) => Object.assign(new Error('固定进程连接无法继续核验，未重试请求。'), { code: 'CRABOT_PROCESS_RPC', ...(stage ? { stage } : {}), ...details })
// Diagnostics copy only fixed stages and known protocol codes, never response text or credentials.
const remoteCodes = new Set(['INVALID_REQUEST', 'PERMISSION_DENIED', 'METHOD_NOT_FOUND', 'INVALID_PARAMS', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE', 'TIMEOUT'])
const diagnose = (error, stage) => error?.code === 'CRABOT_PROCESS_RPC' && typeof error.stage === 'string' ? error
  : unavailable(stage, typeof error?.code === 'string' && error.code.length <= 128 && /^(?:ERR_[A-Z_]+|E[A-Z]+|ABORT_ERR)$/.test(error.code) ? { transport_code: error.code } : {})

async function openPinnedProcessRpc(expected, port, { signal, timeoutMs = 5000, source = 'module-manager', maxResponseBytes = 256 * 1024 } = {}) {
  expected = Object.freeze({ ...expected })
  let socket, closed = false, used = false, pending = false, openingStage = 'binding-before-connect'
  const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 })
  const deadline = () => AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
  function verify() {
    if (closed || typeof source !== 'string' || !source || source.includes('\0') || !Number.isInteger(port) || port < 1 || port > 65535
      || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 32 * 1024 * 1024
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647
      || expected.owner !== identity.inspectProcess(process.pid).owner
      || !identity.sameProcess(expected, identity.inspectProcess(expected.pid))
      || !identity.listListeningTcpPorts(expected.pid).includes(port)) throw unavailable()
  }
  function close() { closed = true; agent.destroy(); socket?.destroy() }
  try {
    verify()
    openingStage = 'connect'
    socket = connect({ host: '127.0.0.1', port })
    socket.on('error', () => {}) // The next call rejects an idle disconnect.
    await once(socket, 'connect', { signal: deadline() })
    openingStage = 'binding-after-connect'
    verify()
    agent.createConnection = () => {
      if (used || closed || socket.destroyed) throw unavailable('connection-reuse')
      used = true
      return socket
    }
  } catch (error) { close(); throw diagnose(error, openingStage) }

  async function call(method, params, { verifyAfter = true, authorizationBearer } = {}) {
    let stage = 'binding-before-request'
    try {
      verify()
      stage = 'request-input'
      if (pending || socket.destroyed || typeof method !== 'string' || !/^[a-z][a-z0-9_]*$/.test(method)) throw unavailable()
      if (authorizationBearer !== undefined && (typeof authorizationBearer !== 'string' || !authorizationBearer || /[\r\n]/.test(authorizationBearer))) throw unavailable()
      pending = true
      const id = randomUUID(), text = JSON.stringify({ id, source, method, params, timestamp: new Date().toISOString() })
      stage = 'request'
      const result = await new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/' + method, method: 'POST', agent,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text),
            ...(authorizationBearer === undefined ? {} : { Authorization: 'Bearer ' + authorizationBearer }),
          }, signal: deadline(),
        }, async response => {
          let responseStage = 'response-read'
          try {
            const chunks = []; let size = 0
            for await (const chunk of response) {
              size += chunk.length
              if (size > maxResponseBytes) { response.destroy(); throw unavailable('response-budget') }
              chunks.push(chunk)
            }
            responseStage = 'response-json'
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (response.statusCode !== 200) throw unavailable('response-status',
              value?.id === id && value?.success === false && remoteCodes.has(value.error?.code) ? { remote_code: value.error.code } : {})
            if (!value || value.id !== id) throw unavailable('response-identity')
            if (value.success !== true) throw unavailable('response-rejected', remoteCodes.has(value.error?.code) ? { remote_code: value.error.code } : {})
            if (!value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw unavailable('response-shape')
            resolve(value.data)
          } catch (error) { reject(diagnose(error, responseStage)) }
        })
        req.on('error', error => reject(diagnose(error, 'request-error')))
        req.end(text)
      })
      stage = 'binding-after-response'
      if (verifyAfter) verify()
      return result
    } catch (error) { close(); throw diagnose(error, stage) }
    finally { pending = false }
  }
  return { call, close }
}
module.exports = { openPinnedProcessRpc }
