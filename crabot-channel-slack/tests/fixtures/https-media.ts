import 'reflect-metadata'
import { BasicConstraintsExtension, SubjectAlternativeNameExtension, X509CertificateGenerator, cryptoProvider } from '@peculiar/x509'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { createPrivateKey, webcrypto } from 'node:crypto'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { vi } from 'vitest'
import { proxyManager, ProxyManager } from 'crabot-shared'

export async function mediaServer(mode: 'custom' | 'system' | 'none', handler: http.RequestListener) {
  cryptoProvider.set(webcrypto as never)
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
  const cert = await X509CertificateGenerator.createSelfSigned({ serialNumber: '1234', name: 'CN=media test', keys: keys as never, signingAlgorithm: algorithm,
    notBefore: new Date(Date.now() - 60000), notAfter: new Date(Date.now() + 3600000), extensions: [new BasicConstraintsExtension(true), new SubjectAlternativeNameExtension([{ type: 'dns', value: 'files.slack.com' }])] })
  const ca = tls.getCACertificates('default'), global = getGlobalDispatcher()
  tls.setDefaultCACertificates([...ca, cert.toString('pem')])
  const key = createPrivateKey({ key: Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)), format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' })
  const backend = https.createServer({ key, cert: cert.toString('pem') }, handler), proxy = http.createServer()
  const sockets = new Set<net.Socket>(), connects: string[] = []
  const track = (socket: net.Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}) }
  backend.on('connection', track); proxy.on('connection', track)
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const port = (backend.address() as net.AddressInfo).port
  proxy.on('connect', (request, socket, head) => {
    connects.push(request.url!)
    const upstream = net.connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    track(upstream); upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy())
  })
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`
  const detector = vi.spyOn(ProxyManager, 'resolveSystemProxyUrl').mockReturnValue(proxyUrl)
  proxyManager.updateConfig(mode === 'custom' ? { mode, custom_url: proxyUrl } : { mode })
  // Only DNS is substituted in direct mode: TLS still verifies the real requested hostname.
  const direct = new Agent({ connect: { lookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]) } })
  const dispatch = mode === 'none' ? vi.spyOn(proxyManager, 'getDispatcher').mockReturnValue(direct as never) : undefined
  if (mode === 'none') setGlobalDispatcher(direct)
  return { origin: `https://files.slack.com:${port}`, connects, async close() {
    dispatch?.mockRestore(); detector.mockRestore(); proxyManager.updateConfig({ mode: 'none' }); setGlobalDispatcher(global)
    for (const socket of sockets) socket.destroy()
    await Promise.all([backend, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    await direct.close(); tls.setDefaultCACertificates(ca)
  } }
}
