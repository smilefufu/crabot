import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { loadVoiceTls } from './voice-tls.js'
import { adminWebTransport } from './admin-web-transport.js'
import { VoiceGateway } from './voice-gateway.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function get(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = (url.startsWith('https:') ? https : http).get(url, { rejectUnauthorized: false }, response => { let body = ''; response.on('data', b => body += b); response.on('end', () => resolve(body)) })
    request.on('error', reject)
  })
}
async function fixture(resolveModule?: () => Promise<{ port: number } | undefined>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-voice-gateway-'))
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }))
  const tls = await loadVoiceTls(dir)
  const internal = http.createServer(), terminals = new WebSocketServer({ server: internal, path: '/voice' })
  let receivedHeaders: http.IncomingHttpHeaders | undefined
  terminals.on('connection', (phone, request) => { receivedHeaders = request.headers; phone.on('message', (raw, binary) => phone.send(raw, { binary })) })
  await new Promise<void>(resolve => internal.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { for (const socket of terminals.clients) socket.terminate(); terminals.close(); await new Promise<void>(resolve => internal.close(() => resolve())) })
  const gateway = new VoiceGateway({ connection: id => id === '手机' ? { base_url: 'http://phone.test:3000', transport: 'wss' } : null, resolve: resolveModule ?? (async () => ({ port: (internal.address() as AddressInfo).port })) })
  const transport = adminWebTransport(tls, (_req, res) => res.end('existing-admin-web'), (req, socket, head) => { void gateway.upgrade(req, socket, head).then(handled => { if (!handled) socket.destroy() }).catch(() => socket.destroy()) })
  await new Promise<void>(resolve => transport.server.listen(0, resolve))
  cleanup.push(async () => { gateway.close(); transport.close(); await new Promise<void>(resolve => transport.server.close(() => resolve())) })
  return { dir, tls, gateway, port: (transport.server.address() as AddressInfo).port, headers: () => receivedHeaders }
}
describe('Admin port voice gateway', () => {
  it('closes a pending module lookup and never opens an upstream after the channel stops', async () => {
    let ready!: (module: { port: number }) => void
    let lookedUp!: () => void
    const lookup = new Promise<void>(resolve => { lookedUp = resolve })
    const f = await fixture(() => { lookedUp(); return new Promise(resolve => { ready = resolve }) })
    const phone = new WebSocket(`ws://127.0.0.1:${f.port}/ws/voice/${encodeURIComponent('手机')}`)
    cleanup.push(async () => phone.terminate())
    const rejected = new Promise<void>(resolve => phone.once('error', () => resolve()))
    await lookup
    f.gateway.close('手机')
    await rejected
    ready({ port: 1 })
    expect(f.headers()).toBeUndefined()
  })
  it('keeps a stable private Admin certificate and serves HTTP, HTTPS and WSS on one port', async () => {
    const f = await fixture()
    expect((await loadVoiceTls(f.dir)).fingerprint).toBe(f.tls.fingerprint)
    expect((await fs.stat(path.join(f.dir, 'voice-tls.json'))).mode & 0o777).toBe(0o600)
    expect(await get(`http://127.0.0.1:${f.port}/api/test`)).toBe('existing-admin-web')
    expect(await get(`https://127.0.0.1:${f.port}/api/test`)).toBe('existing-admin-web')
    const phone = new WebSocket(`wss://127.0.0.1:${f.port}/ws/voice/${encodeURIComponent('手机')}`, { rejectUnauthorized: false, headers: { Authorization: 'never-forward', Cookie: 'private-admin-cookie' } })
    cleanup.push(async () => phone.terminate())
    await new Promise<void>((resolve, reject) => { phone.once('open', resolve); phone.once('error', reject) })
    const pcm = Buffer.alloc(640, 9)
    const received = new Promise<Buffer>((resolve, reject) => { phone.once('message', (raw, binary) => { expect(binary).toBe(true); resolve(Buffer.from(raw as Buffer)) }); phone.once('error', reject) })
    phone.send(pcm); expect(await received).toEqual(pcm)
    expect(f.headers()?.authorization).toBeUndefined(); expect(f.headers()?.cookie).toBeUndefined()
    const closed = new Promise<void>(resolve => phone.once('close', () => resolve()))
    f.gateway.close('手机'); await closed
  })
  it('allows local reverse-proxy WS for a WSS entry but rejects public plaintext and unknown channels', async () => {
    const f = await fixture()
    const local = new WebSocket(`ws://127.0.0.1:${f.port}/ws/voice/${encodeURIComponent('手机')}`)
    cleanup.push(async () => local.terminate())
    await new Promise<void>((resolve, reject) => { local.once('open', resolve); local.once('error', reject) })
    const bad = new WebSocket(`ws://127.0.0.1:${f.port}/ws/voice/not-voice`)
    cleanup.push(async () => bad.terminate())
    await expect(new Promise((resolve, reject) => { bad.once('open', resolve); bad.once('error', reject) })).rejects.toThrow()
    const lan = Object.values(os.networkInterfaces()).flat().find(a => a && !a.internal && a.family === 'IPv4')?.address
    if (lan) {
      const publicPlain = new WebSocket(`ws://${lan}:${f.port}/ws/voice/${encodeURIComponent('手机')}`, { headers: { 'X-Forwarded-Proto': 'https' } })
      cleanup.push(async () => publicPlain.terminate())
      await expect(new Promise((resolve, reject) => { publicPlain.once('open', resolve); publicPlain.once('error', reject) })).rejects.toThrow()
    }
  })
})
