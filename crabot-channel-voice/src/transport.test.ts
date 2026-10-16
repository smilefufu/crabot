import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { TerminalStore } from './terminal-store.js'
import { voiceTransport } from './transport.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const finish of cleanup.splice(0).reverse()) await finish() })
function request(url: string, secure = false): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = ''; res.on('data', data => { body += data }); res.on('end', () => resolve({ status: res.statusCode!, body }))
    }); req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('timeout')))
  })
}
describe('paired terminal transport boundary', () => {
  it('persists only credential verification material without a certificate with private permissions', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-tls-')); cleanup.push(() => fs.rm(dir, { recursive: true, force: true }))
    const a = new TerminalStore(dir); await a.load(); const credential = await a.pair()
    expect(a.matches(credential)).toBe(true); expect(a.matches('another-terminal')).toBe(false)
    const persisted = await fs.readFile(path.join(dir, 'terminal.json'), 'utf8')
    expect(persisted).not.toContain(credential); expect((await fs.stat(path.join(dir, 'terminal.json'))).mode & 0o777).toBe(0o600)
    const restored = new TerminalStore(dir); await restored.load()
    expect(persisted).not.toContain('PRIVATE KEY'); expect(restored.matches(credential)).toBe(true)
    await restored.revoke(); expect(restored.matches(credential)).toBe(false)
  })
  it('binds internal RPC and WS to loopback without exposing another LAN port', async () => {
    const transport = voiceTransport((_req, res) => { res.end('internal-rpc') }, socket => socket.send('terminal-only'))
    await new Promise<void>(resolve => transport.server.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => { transport.close(); await new Promise<void>(resolve => transport.server.close(() => resolve())) })
    const port = (transport.server.address() as AddressInfo).port
    expect(await request(`http://127.0.0.1:${port}/health`)).toEqual({ status: 200, body: 'internal-rpc' })
    const terminal = new WebSocket(`ws://127.0.0.1:${port}/voice`)
    cleanup.push(async () => { terminal.terminate() })
    expect(await new Promise<string>((resolve, reject) => { terminal.once('message', raw => resolve(raw.toString())); terminal.once('error', reject) })).toBe('terminal-only')
    const address = Object.values(os.networkInterfaces()).flat().find(a => a && !a.internal && a.family === 'IPv4')?.address
    if (address) await expect(request(`http://${address}:${port}/health`)).rejects.toThrow()
  })
})
