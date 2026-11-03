import 'reflect-metadata'
import { BasicConstraintsExtension, SubjectAlternativeNameExtension, X509CertificateGenerator, cryptoProvider } from '@peculiar/x509'
import { expect, it, vi } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { createHash, createPrivateKey, randomBytes, webcrypto } from 'node:crypto'
import { ProxyManager, proxyManager } from 'crabot-shared'
import { SlackClient } from '../src/slack-client.js'

it.each(['custom', 'system', 'none'] as const)('uses real HTTPS control requests and WSS with %s mode and certificate verification enabled', async mode => {
  cryptoProvider.set(webcrypto as never)
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
  const certificate = await X509CertificateGenerator.createSelfSigned({ serialNumber: randomBytes(16).toString('hex'), name: 'CN=Slack test fixture',
    notBefore: new Date(Date.now() - 60000), notAfter: new Date(Date.now() + 3600000), signingAlgorithm: algorithm, keys: keys as never,
    extensions: [new BasicConstraintsExtension(true), new SubjectAlternativeNameExtension([{ type: 'dns', value: 'slack-proxy-fixture.invalid' }, { type: 'ip', value: '127.0.0.1' }])] })
  const key = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
  const cert = certificate.toString('pem'), originalCa = tls.getCACertificates('default')
  const backend = https.createServer({ cert, key: createPrivateKey({ key, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' }) }), proxy = http.createServer()
  tls.setDefaultCACertificates([...originalCa, cert])
  const sockets = new Set<net.Socket>(), tunnels: string[] = [], requests: string[] = []
  let endpoint = '', failNextOpen = false
  let activeSocket: net.Socket | undefined
  backend.on('request', (request, response) => {
    requests.push(request.url!)
    if (failNextOpen && request.url?.endsWith('/apps.connections.open')) {
      failNextOpen = false
      request.socket.destroy()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(request.url?.endsWith('/apps.connections.open') ? { ok: true, url: endpoint.replace('https:', 'wss:') + 'socket' } : { ok: true }))
  })
  backend.on('upgrade', (request, socket) => {
    activeSocket = socket as net.Socket
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const hello = Buffer.from(JSON.stringify({ type: 'hello', num_connections: 1 }))
    socket.write(Buffer.concat([Buffer.from([0x81, hello.length]), hello]))
    socket.on('data', bytes => { if ((bytes[0] & 15) === 8) socket.end(Buffer.from([0x88, 0])) })
  })
  for (const server of [backend, proxy]) server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
  })
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const backendPort = (backend.address() as net.AddressInfo).port
  endpoint = mode === 'none' ? `https://127.0.0.1:${backendPort}/` : 'https://slack-proxy-fixture.invalid/'
  proxy.on('connect', (request, socket, head) => {
    tunnels.push(request.url!)
    const upstream = net.connect(backendPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream)); upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`
  const detect = vi.spyOn(ProxyManager, 'resolveSystemProxyUrl').mockReturnValue(proxyUrl)
  const client = new SlackClient('xoxb-fixture', 'xapp-fixture')
  // Configure the real clients' API base URLs; do not replace HTTP methods or fetch.
  ;(client as any).web.slackApiUrl = endpoint + 'api/'
  ;(client as any).socket.webClient.slackApiUrl = endpoint + 'api/'
  proxyManager.updateConfig(mode === 'custom' ? { mode, custom_url: proxyUrl } : { mode })
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await client.call('api.test')
    await Promise.race([client.start(async () => {}), new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('HTTPS/WSS fixture did not connect')), 3000) })])
    clearTimeout(deadline)
    expect(client.connected).toBe(true)
    expect(requests).toEqual(['/api/api.test', '/api/apps.connections.open'])
    if (mode === 'none') expect(tunnels).toEqual([])
    else {
      expect(tunnels.length).toBeGreaterThanOrEqual(2)
      expect(tunnels.every(target => target === 'slack-proxy-fixture.invalid:443')).toBe(true)
    }
    // Exercise the real close → HTTPS failure → delayed reconnect → WSS hello path.
    ;(client as any).socket.clientPingTimeoutMS = 100
    ;(client as any).socket.webClient.retryConfig = { retries: 0 }
    failNextOpen = true
    const errors: boolean[] = []
    ;(client as any).socket.on('error', () => errors.push(client.connected))
    const recovered = new Promise<void>(resolve => (client as any).socket.once('connected', resolve))
    activeSocket!.end(Buffer.from([0x88, 0]))
    await Promise.race([recovered, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('HTTPS/WSS fixture did not recover')), 3000) })])
    expect(errors).toEqual([false])
    expect(client.connected).toBe(true)
    expect(requests.slice(2)).toEqual(['/api/apps.connections.open', '/api/apps.connections.open'])
  } finally {
    if (deadline) clearTimeout(deadline)
    await client.stop()
    for (const socket of sockets) socket.destroy()
    await Promise.all([backend, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    proxyManager.updateConfig({ mode: 'none' }); detect.mockRestore(); tls.setDefaultCACertificates(originalCa); key.fill(0)
  }
}, 10000)
