import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import net, { type Socket } from 'node:net'
import type { VoiceTls } from './voice-tls.js'

/** HTTP and TLS share the Admin port and the existing Web/API/upgrade handlers. */
export function adminWebTransport(
  tls: VoiceTls | undefined,
  request: (req: IncomingMessage, res: ServerResponse) => void,
  upgrade: (req: IncomingMessage, socket: Socket, head: Buffer) => void,
): { server: net.Server; close(): void } {
  const sockets = new Set<Socket>()
  const plain = http.createServer(request)
  const secure = tls ? https.createServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' }, request) : undefined
  plain.on('upgrade', upgrade)
  secure?.on('upgrade', upgrade)
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    socket.setTimeout(5000, () => socket.destroy())
    socket.once('data', first => {
      socket.pause(); socket.setTimeout(0); socket.unshift(first)
      if (first[0] === 0x16) { if (secure) secure.emit('connection', socket); else socket.destroy() }
      else { plain.emit('connection', socket); socket.resume() }
    })
  })
  return { server, close() { for (const socket of sockets) socket.destroy(); plain.close(); secure?.close() } }
}
