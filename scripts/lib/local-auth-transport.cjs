const { createServer, connect } = require('node:net')
const { Duplex } = require('node:stream')
const { mkdirSync, lstatSync, realpathSync, unlinkSync, chmodSync } = require('node:fs')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const { once } = require('node:events')
const identity = require('./process-identity.cjs')

class PipeSocket extends Duplex {
  constructor(handle, stream = false) {
    super({ allowHalfOpen: false }); this.handle = handle; this.reading = false; this.stream = stream
    this.exit = () => this.destroy()
    process.once('exit', this.exit)
  }
  setTimeout() { return this }
  setNoDelay() { return this }
  setKeepAlive() { return this }
  _read() {
    if (this.reading) return
    this.reading = true
    const read = this.stream ? identity.readPipeStream : identity.readPipe
    read(this.handle).then(bytes => {
      this.reading = false
      if (!this.destroyed) this.push(bytes)
    }, error => this.destroy(error))
  }
  _write(bytes, _encoding, callback) {
    const write = async () => {
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        await (this.stream ? identity.writePipeStream : identity.writePipe)(this.handle, bytes.subarray(offset, offset + 65536))
      }
    }
    write().then(() => callback(), callback)
  }
  _destroy(error, callback) { process.removeListener('exit', this.exit); identity.closePipe(this.handle); callback(error) }
}

function authAddress(dataDir, server = identity.inspectProcess(process.pid), namespace = 'desktop') {
  if (!['desktop', 'runtime', 'voice'].includes(namespace)) throw new Error('Unknown private transport namespace')
  const hash = createHash('sha256').update(server.owner + '\0' + realpathSync(dataDir) + (namespace === 'desktop' ? '' : '\0' + namespace)).digest('hex')
  if (process.platform === 'win32') return '\\\\.\\pipe\\crabot-desktop-' + hash
  // macOS sockaddr_un is short; a private, checked directory avoids DATA_DIR length limits.
  const directory = join('/tmp', (namespace === 'desktop' ? 'crabot-auth-' : 'crabot-' + namespace + '-') + hash.slice(0, 24))
  try { mkdirSync(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.uid) !== server.owner || (stat.mode & 0o777) !== 0o700) {
    throw new Error('Local authentication directory is not private to the current user')
  }
  const generation = createHash('sha256').update(server.started).digest('hex').slice(0, 16)
  return join(directory, `${server.pid}-${generation}.sock`)
}

async function listenLocalAuth(address, handler, onError = () => {}, { stream = false } = {}) {
  const sockets = new Set()
  let closed = false
  const accept = (socket, fd = socket._handle.fd) => {
    socket.on('error', () => {}) // secrets and raw frames never enter transport logs
    // Two short handshakes leave async-worker capacity for IO and credential reads.
    if (closed || sockets.size >= 2) { socket.destroy(); return }
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    try { handler(socket, identity.inspectPeer(fd)) } catch { socket.destroy() }
  }
  if (process.platform !== 'win32') {
    const server = createServer(accept)
    server.listen(address); await once(server, 'listening')
    try { chmodSync(address, 0o600) } catch (error) { server.close(); throw error }
    server.on('error', onError)
    return { close: async () => {
      closed = true; sockets.forEach(socket => socket.destroy())
      await new Promise(resolve => server.close(resolve))
      try { unlinkSync(address) } catch (error) { if (error.code !== 'ENOENT') throw error }
    } }
  }
  const server = identity.createPipeServer(address)
  // Node-API IO workers must be cancelled synchronously before environment teardown.
  const dispose = () => { closed = true; identity.closePipeServer(server); sockets.forEach(socket => socket.destroy()) }
  process.once('exit', dispose)
  let accepting
  const loop = async () => {
    try {
      while (!closed) {
        const handle = await identity.acceptPipe(server)
        let socket
        try { socket = new PipeSocket(handle, stream); accept(socket, handle) }
        catch (error) { if (socket) socket.destroy(); else identity.closePipe(handle); throw error }
      }
    } catch { if (!closed) { closed = true; identity.closePipeServer(server); onError(new Error('Private authentication listener unavailable')) } }
  }
  accepting = loop()
  return { close: async () => {
    process.removeListener('exit', dispose); dispose(); await accepting
  } }
}

async function connectLocalAuth(address, { stream = false } = {}) {
  let socket, descriptor
  if (process.platform === 'win32') {
    const handle = await identity.connectPipe(address)
    descriptor = handle
    try { socket = new PipeSocket(handle, stream) }
    catch (error) { identity.closePipe(handle); throw error }
  } else {
    socket = connect(address)
    socket.setTimeout(5000, () => socket.destroy(new Error('Local authentication connection timed out')))
    try { await once(socket, 'connect') } catch (error) { socket.destroy(); throw error }
  }
  socket.on('error', () => {})
  try {
    const peer = (identity.inspectServerPeer ?? identity.inspectPeer)(descriptor ?? socket._handle.fd)
    return { socket, peer }
  } catch (error) { socket.destroy(); throw error }
}

module.exports = { authAddress, listenLocalAuth, connectLocalAuth }
