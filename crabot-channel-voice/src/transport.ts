import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

export function loopback(address?: string): boolean {
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1'
}

/** The MM port is loopback-only; Admin owns the public terminal entry. */
export function voiceTransport(
  rpc: (req: IncomingMessage, res: ServerResponse) => void,
  connected: (socket: WebSocket) => void,
): { server: http.Server; close(): void } {
  const server = http.createServer(rpc)
  const ws = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    if (!loopback((socket as Socket).remoteAddress) || req.url !== '/voice') { socket.destroy(); return }
    ws.handleUpgrade(req, socket, head, terminal => ws.emit('connection', terminal, req))
  })
  ws.on('connection', connected)
  return { server, close() { for (const terminal of ws.clients) terminal.terminate(); ws.close(); server.closeAllConnections() } }
}
