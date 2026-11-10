// Local runtime control uses OS-verified peers; it does not issue desktop/Admin credentials.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const identity = require('./process-identity.cjs')
const transport = require('./local-auth-transport.cjs')
const { readInstanceRuntime } = require('./instance-runtime-record.cjs')
const { RuntimeRpcPeer, RuntimeRpcError } = require('../../crabot-shared/dist/runtime-rpc.js')
const { RuntimeStreamChannel } = require('../../crabot-core/dist/runtime-stream.js')
const filename = 'runtime-control.json'
const failure = () => new RuntimeRpcError('SERVICE_UNAVAILABLE', 'Verified local runtime control is unavailable')

function readDescription(dataDir) {
  const file = path.join(dataDir, filename), stat = fs.lstatSync(file)
  const self = identity.inspectProcess(process.pid)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536
    || process.platform !== 'win32' && (String(stat.uid) !== self.owner || (stat.mode & 0o077))) throw failure()
  const bytes = fs.readFileSync(file)
  if (bytes.length > 65536) throw failure()
  const value = JSON.parse(bytes.toString('utf8'))
  if (value.schema_version !== 1 || value.data_dir !== fs.realpathSync(dataDir)
    || typeof value.root !== 'string' || !Number.isInteger(value.target) || value.target < 1
    || !value.server || value.server.owner !== self.owner
    || !identity.sameProcess(value.server, identity.inspectProcess(value.server.pid))
    || value.socket_address !== transport.authAddress(dataDir, value.server, 'runtime')) throw failure()
  const record = readInstanceRuntime(dataDir)
  if (record && (!record.mm || !identity.sameProcess(record.mm, value.server)
    || record.generation !== value.generation || record.install_root !== value.root || record.mm_port !== value.target)) throw failure()
  return { value, bytes }
}

function hasRuntimeControl(dataDir) {
  if (fs.existsSync(path.join(dataDir, filename))) return true
  return readInstanceRuntime(dataDir)?.control_transport === 'pipe'
}

async function openRuntimeControl(dataDir, { expectedServer, expectedGeneration } = {}) {
  let socket, peer
  try {
    const description = readDescription(dataDir)
    if (expectedGeneration !== undefined && description.value.generation !== expectedGeneration) throw failure()
    if (expectedServer && !identity.sameProcess(expectedServer, description.value.server)) throw failure()
    const connection = await transport.connectLocalAuth(description.value.socket_address)
    socket = connection.socket
    socket.setTimeout?.(0)
    if (!identity.sameProcess(description.value.server, connection.peer)) throw failure()
    peer = new RuntimeRpcPeer(new RuntimeStreamChannel(socket, socket))
    let closed = false
    const verify = () => {
      if (closed || socket.destroyed) throw failure()
      const current = readDescription(dataDir)
      if (!current.bytes.equals(description.bytes)) throw new RuntimeRpcError('STALE_INSTANCE', 'Runtime changed during the call')
    }
    const close = () => { closed = true; peer.close(); socket.destroy() }
    return { server: description.value.server, target: description.value.target, verify, close,
      async call(call, { timeoutMs, verifyAfter = true } = {}) {
        verify()
        const result = await peer.call(call, timeoutMs)
        if (verifyAfter) verify()
        return result
      },
    }
  } catch (error) {
    peer?.close(); socket?.destroy()
    if (error instanceof RuntimeRpcError) throw error
    throw failure()
  }
}

async function callRuntimeControl(dataDir, call, { timeoutMs, expectedGeneration } = {}) {
  const connection = await openRuntimeControl(dataDir, { expectedGeneration })
  try { return await connection.call(call, { timeoutMs }) }
  finally { connection.close() }
}

async function startRuntimeControl({ dataDir, root, target, dispatch, onError = () => {} }) {
  dataDir = fs.realpathSync(dataDir); root = fs.realpathSync(root)
  const server = identity.inspectProcess(process.pid)
  const file = path.join(dataDir, filename)
  if (fs.existsSync(file)) {
    const previous = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (identity.sameProcess(previous.server, identity.inspectProcess(previous.server?.pid))) {
      throw new RuntimeRpcError('SERVICE_UNAVAILABLE', 'A local runtime controller is already active')
    }
  }
  const record = readInstanceRuntime(dataDir)
  if (record && (!record.mm || !identity.sameProcess(record.mm, server))) throw failure()
  const address = transport.authAddress(dataDir, server, 'runtime')
  const value = { schema_version: 1, data_dir: dataDir, root, target, server, socket_address: address,
    ...(record ? { generation: record.generation } : {}) }
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  const clients = new Map()
  let closing = false
  const listener = await transport.listenLocalAuth(address, (socket, origin) => {
    if (closing || origin.owner !== server.owner || !identity.sameProcess(origin, identity.inspectProcess(origin.pid))) {
      socket.destroy(); return
    }
    const channel = new RuntimeStreamChannel(socket, socket)
    const peer = new RuntimeRpcPeer(channel)
    const bindings = new Map()
    clients.set(socket, peer)
    socket.once('close', () => { peer.close(); clients.delete(socket) })
    peer.handle(call => {
      if (closing || !identity.sameProcess(origin, identity.inspectProcess(origin.pid))) throw failure()
      const current = readDescription(dataDir)
      if (!current.bytes.equals(bytes)) throw new RuntimeRpcError('STALE_INSTANCE', 'Runtime controller is no longer current')
      return dispatch(call, origin, bindings)
    })
  }, onError)
  const temporary = file + '.tmp-' + crypto.randomUUID()
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, file)
  } catch (error) { await listener.close(); throw error }
  finally { try { fs.unlinkSync(temporary) } catch {} }
  return { async close() {
    closing = true
    for (const [socket, peer] of clients) {
      peer.close()
      if (!socket.destroyed && socket.writable) await new Promise(resolve => socket.end(resolve))
      socket.destroy()
    }
    await listener.close()
    try { if (fs.readFileSync(file).equals(bytes)) fs.unlinkSync(file) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  } }
}

module.exports = { startRuntimeControl, openRuntimeControl, callRuntimeControl, hasRuntimeControl }
