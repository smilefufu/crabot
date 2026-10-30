import { expect, it, vi } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { ProxyManager, proxyManager } from 'crabot-shared'
import { WebClient } from '@slack/web-api'
import { SlackClient } from '../src/slack-client.js'

it('opens the real SDK WebSocket through the detected system proxy without resolving the public fixture host', async () => {
  const backend = http.createServer(), proxy = http.createServer()
  const sockets = new Set<net.Socket>(), tunnels: string[] = []
  for (const server of [backend, proxy]) server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  backend.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const hello = Buffer.from(JSON.stringify({ type: 'hello', num_connections: 1 }))
    socket.write(Buffer.concat([Buffer.from([0x81, hello.length]), hello]))
    socket.on('data', bytes => { if ((bytes[0] & 15) === 8) socket.end(Buffer.from([0x88, 0])) })
    socket.on('error', () => {})
  })
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  proxy.on('connect', (request, socket, head) => {
    tunnels.push(request.url!)
    const upstream = net.connect((backend.address() as net.AddressInfo).port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream))
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy())
  })
  const detect = vi.spyOn(ProxyManager, 'resolveSystemProxyUrl').mockReturnValue(`http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`)
  proxyManager.updateConfig({ mode: 'system' })
  // Only the credential-bearing control-plane API is replaced. WebSocket,
  // dispatcher, CONNECT tunnel and protocol greeting are all real local I/O.
  const api = vi.spyOn(WebClient.prototype, 'apiCall').mockResolvedValue({ ok: true, url: 'ws://slack-proxy-fixture.invalid/socket' })
  const client = new SlackClient('xoxb-fixture', 'xapp-fixture')
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([client.start(async () => {}), new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Fixture WebSocket did not connect through proxy')), 3000) })])
    expect(client.connected).toBe(true)
    expect(tunnels).toEqual(['slack-proxy-fixture.invalid:80'])
    expect(api).toHaveBeenCalled()
  } finally {
    if (deadline) clearTimeout(deadline)
    await client.stop()
    for (const socket of sockets) socket.destroy()
    await Promise.all([backend, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    proxyManager.updateConfig({ mode: 'none' }); detect.mockRestore(); api.mockRestore()
  }
}, 10000)
