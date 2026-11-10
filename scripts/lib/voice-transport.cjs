// The public phone entry stays in Admin; internal bytes use an OS-verified private pipe.
const identity = require('./process-identity.cjs')
const { authAddress, listenLocalAuth, connectLocalAuth } = require('./local-auth-transport.cjs')

async function listenVoiceTransport(dataDir, httpServer) {
  const server = identity.inspectProcess(process.pid)
  const socket_address = authAddress(dataDir, server, 'voice')
  const listener = await listenLocalAuth(socket_address, (socket, origin) => {
    if (origin.owner !== server.owner || !identity.sameProcess(origin, identity.inspectProcess(origin.pid))) {
      socket.destroy(); return
    }
    httpServer.emit('connection', socket)
  })
  return { description: { server, socket_address }, close: () => listener.close() }
}

async function connectVoiceTransport(dataDir, description) {
  const self = identity.inspectProcess(process.pid)
  if (!description?.server || description.server.owner !== self.owner
    || !identity.sameProcess(description.server, identity.inspectProcess(description.server.pid))
    || description.socket_address !== authAddress(dataDir, description.server, 'voice')) {
    throw new Error('Verified Voice transport is unavailable')
  }
  const { socket, peer } = await connectLocalAuth(description.socket_address)
  if (!identity.sameProcess(description.server, peer)) { socket.destroy(); throw new Error('Voice process changed') }
  socket.setTimeout?.(0)
  return socket
}
module.exports = { listenVoiceTransport, connectVoiceTransport }
