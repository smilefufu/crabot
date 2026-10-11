import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

export function loopback(address?: string): boolean {
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1'
}

/** TLS accepts only the terminal upgrade; plaintext RPC is accepted only from loopback. */
export function voiceTransport(
  tls: { cert: string; key: string },
  rpc: (req: IncomingMessage, res: ServerResponse) => void,
  connected: (socket: WebSocket) => void,
): { server: net.Server; close(): void } {
  const sockets = new Set<net.Socket>()
  const plain = http.createServer(rpc)
  const secure = https.createServer({ ...tls, minVersion: 'TLSv1.2' }, (_req, res) => { res.writeHead(404); res.end() })
  const ws = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false })
  secure.on('upgrade', (req, socket, head) => {
    if (req.url !== '/voice') { socket.destroy(); return }
    ws.handleUpgrade(req, socket, head, terminal => { ws.emit('connection', terminal, req) })
  })
  ws.on('connection', connected)
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    socket.setTimeout(5000, () => socket.destroy())
    socket.once('data', first => {
      socket.pause(); socket.setTimeout(0); socket.unshift(first)
      if (first[0] === 0x16) secure.emit('connection', socket)
      else if (loopback(socket.remoteAddress)) { plain.emit('connection', socket); socket.resume() }
      else { socket.destroy(); return }
    })
  })
  return { server, close() { for (const terminal of ws.clients) terminal.terminate(); for (const socket of sockets) socket.destroy(); ws.close(); secure.close(); plain.close() } }
}
