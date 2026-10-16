import http, { type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { TLSSocket } from 'node:tls'
import type { VoiceConnectionConfig } from 'crabot-shared'

interface VoiceGatewayDeps {
  connection(id: string): VoiceConnectionConfig | null
  resolve(id: string): Promise<{ port: number } | undefined>
}
function loopback(address?: string): boolean { return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' }

/** Byte relay only: authentication and terminal lifecycle remain in Voice. */
export class VoiceGateway {
  private readonly channels = new Map<string, Set<() => void>>()
  constructor(private readonly deps: VoiceGatewayDeps) {}
  close(channelId?: string): void {
    for (const [id, close] of this.channels) if (!channelId || id === channelId) for (const fn of [...close]) fn()
  }
  async upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<boolean> {
    const match = req.url?.match(/^\/ws\/voice\/([^/?#]+)$/)
    if (!match) return false
    let id: string
    try { id = decodeURIComponent(match[1]) } catch { socket.destroy(); return true }
    let connection: VoiceConnectionConfig | null
    try { connection = this.deps.connection(id) } catch { socket.destroy(); return true }
    if (!connection || (connection.transport === 'wss' && !(req.socket as TLSSocket).encrypted && !loopback(req.socket.remoteAddress))) { socket.destroy(); return true }
    let request: ReturnType<typeof http.request> | undefined
    let upstream: Socket | undefined
    const entries = this.channels.get(id) ?? new Set<() => void>()
    const close = () => { clearTimeout(timeout); request?.destroy(); socket.destroy(); upstream?.destroy(); entries.delete(close); if (!entries.size) this.channels.delete(id) }
    this.channels.set(id, entries); entries.add(close)
    const timeout = setTimeout(close, 5000)
    socket.once('error', close); socket.once('close', close)
    const module = await this.deps.resolve(id)
    if (socket.destroyed) { close(); return true }
    if (!module || !Number.isInteger(module.port) || module.port < 1 || module.port > 65535) { close(); return true }
    // Never forward Admin cookies, Authorization, forwarded headers or a client-provided upstream.
    const headers: Record<string, string> = { Connection: 'Upgrade', Upgrade: 'websocket' }
    for (const key of ['sec-websocket-key', 'sec-websocket-version']) {
      const value = req.headers[key]
      if (typeof value === 'string') headers[key] = value
    }
    request = http.request({ host: '127.0.0.1', port: module.port, path: '/voice', method: 'GET', headers })
    request.once('error', close); request.once('response', close)
    request.once('upgrade', (response, internal, internalHead) => {
      clearTimeout(timeout); upstream = internal
      if (socket.destroyed) { close(); return }
      internal.once('error', close); internal.once('close', close)
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n')
      if (internalHead.length) socket.write(internalHead)
      if (head.length) internal.write(head)
      internal.pipe(socket); socket.pipe(internal)
      // pipe supplies backpressure; queued output is additionally bounded in both directions.
      const bounded = () => { if (socket.writableLength > 128 * 1024 || internal.writableLength > 128 * 1024) close() }
      internal.on('data', bounded); socket.on('data', bounded)
    })
    request.end()
    return true
  }
}
