import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { DesktopSessionRequestSchema, DesktopErrorCodeSchema, LoopbackAdminOriginSchema, type DesktopSessionResponse } from 'crabot-client'

const identity = require('../../scripts/lib/process-identity.cjs')
const transport = require('../../scripts/lib/local-auth-transport.cjs')
const entry = require('../../scripts/lib/desktop-entry.cjs')
const { DesktopFrames } = require('../../scripts/lib/desktop-frames.cjs')
const { inspectInstance } = require('../../scripts/lib/instance-runtime.mjs')

interface ProcessIdentity { pid: number; parent: number; owner: string; started: string; executable: string }
export interface DesktopClaims { session_id: string; instance_id: string; generation: string }
interface Runtime { instance_id: string; generation: string; install_root: string; mm: ProcessIdentity }
interface Session { peer: ProcessIdentity; exp: number }

// Admin owns issuance and the in-memory live-session registry. A password JWT or an
// internal/Agent bearer cannot manufacture a registered desktop session.
export class DesktopSessions {
  private listener?: { close(): Promise<void> }
  private readonly sessions = new Map<string, Session>()
  private readonly nonces = new Map<string, number>()
  private runtime?: Runtime
  private server?: ProcessIdentity
  private discovery?: string
  private policy: unknown
  private stopped = false
  private readonly connections = new Set<Duplex>()

  constructor(private readonly options: {
    root: string
    dataRoot: string
    adminUrl: string
    issue(claims: DesktopClaims, exp: number): Promise<string>
    // Constructor dependency for process fixtures; never read from a public config/env/request.
    entryPolicy?: unknown
  }) {}

  get ready(): boolean { return !this.stopped && !!this.listener }

  private current(): Runtime {
    const instance = inspectInstance(this.options.dataRoot)
    if (instance.state !== 'running' || !instance.record?.mm
      || !identity.sameProcess(instance.record.mm, identity.inspectProcess(instance.record.mm.pid))
      || instance.record.install_root !== realpathSync(this.options.root)) throw new Error('DESKTOP_STALE_INSTANCE')
    const record = instance.record as Runtime
    if (this.runtime && (record.instance_id !== this.runtime.instance_id || record.generation !== this.runtime.generation)) throw new Error('DESKTOP_STALE_INSTANCE')
    return record
  }

  async start(): Promise<boolean> {
    this.policy = this.options.entryPolicy ?? entry.loadDesktopEntry(this.options.root)
    if (!this.policy) return false // CLI-only packages retain browser/CLI authentication.
    const runtime = this.current(), server: ProcessIdentity = identity.inspectProcess(process.pid)
    if (server.parent !== runtime.mm.pid || server.owner !== runtime.mm.owner) throw new Error('DESKTOP_UNAVAILABLE')
    this.runtime = runtime; this.server = server
    LoopbackAdminOriginSchema.parse(this.options.adminUrl)
    const address = transport.authAddress(this.options.dataRoot, server)
    this.listener = await transport.listenLocalAuth(address, (socket: Duplex, peer: ProcessIdentity) => {
      this.connections.add(socket); socket.once('close', () => this.connections.delete(socket))
      void this.handshake(socket, peer)
    }, () => { void this.close().catch(() => {}) })
    const discovery = path.join(this.options.dataRoot, 'desktop-session.json')
    const temporary = discovery + '.tmp-' + randomUUID()
    try {
      await fs.writeFile(temporary, JSON.stringify({ schema_version: 1, instance_id: runtime.instance_id,
        generation: runtime.generation, server, socket_address: address, admin_url: this.options.adminUrl }) + '\n', { flag: 'wx', mode: 0o600 })
      await fs.rename(temporary, discovery)
      this.discovery = discovery
    } catch (error) { await this.close(); throw error }
    finally { await fs.rm(temporary, { force: true }) }
    return true
  }

  private async handshake(socket: Duplex, peer: ProcessIdentity): Promise<void> {
    const deadline = Date.now() + 5000
    const frames = new DesktopFrames(socket)
    const timer = setTimeout(() => frames.fail(new Error('DESKTOP_CHALLENGE_EXPIRED')), 5000)
    try {
      if (this.stopped || !entry.verifyDesktopEntry(peer, this.policy)) throw new Error('DESKTOP_UNAUTHORIZED')
      const runtime = this.current(), challenge = randomBytes(32).toString('base64url')
      frames.write({ type: 'challenge', protocol_version: 1, instance_id: runtime.instance_id,
        generation: runtime.generation, challenge, expires_at: new Date(deadline).toISOString() })
      const parsed = DesktopSessionRequestSchema.safeParse(await frames.read())
      if (!parsed.success) throw new Error('DESKTOP_PROTOCOL_ERROR')
      const request = parsed.data
      if (Date.now() >= deadline) throw new Error('DESKTOP_CHALLENGE_EXPIRED')
      if (request.instance_id !== runtime.instance_id || request.generation !== runtime.generation) throw new Error('DESKTOP_STALE_INSTANCE')
      if (request.challenge !== challenge) throw new Error('DESKTOP_REPLAY')
      const now = Date.now()
      for (const [nonce, expires] of this.nonces) if (expires <= now) this.nonces.delete(nonce)
      for (const [id, session] of this.sessions) if (session.exp * 1000 <= now) this.sessions.delete(id)
      if (this.nonces.has(request.client_nonce)) throw new Error('DESKTOP_REPLAY')
      if (this.nonces.size >= 512 || this.sessions.size >= 128) throw new Error('DESKTOP_UNAVAILABLE')
      // One request per connection; consume its nonce before asynchronous credential IO/signing.
      this.nonces.set(request.client_nonce, now + 15 * 60_000)
      const exp = Math.floor(now / 1000) + 15 * 60
      const claims = { session_id: randomUUID(), instance_id: runtime.instance_id, generation: runtime.generation }
      const token = await this.options.issue(claims, exp)
      this.current()
      if (this.stopped || socket.destroyed || Date.now() >= deadline || !entry.verifyDesktopEntry(peer, this.policy)) throw new Error('DESKTOP_UNAVAILABLE')
      this.sessions.set(claims.session_id, { peer, exp })
      const response: DesktopSessionResponse = { type: 'session', protocol_version: 1, instance_id: runtime.instance_id,
        generation: runtime.generation, admin_url: this.options.adminUrl, token, expires_at: new Date(exp * 1000).toISOString() }
      frames.write(response)
      // Flush the one final frame before closing, including native Windows async IO.
      await new Promise<void>(resolve => socket.end(resolve))
    } catch (error) {
      const parsed = DesktopErrorCodeSchema.safeParse(error instanceof Error ? error.message : undefined)
      const code = parsed.success ? parsed.data : 'DESKTOP_PROTOCOL_ERROR'
      if (!socket.destroyed) {
        try { frames.write({ type: 'error', code, message: '本机桌面会话未能建立，请重新检查实例状态。' }); await new Promise<void>(resolve => socket.end(resolve)) } catch {}
      }
    } finally { clearTimeout(timer); frames.close() }
  }

  validate(claims: unknown, exp: number): boolean {
    if (this.stopped || !claims || typeof claims !== 'object') return false
    const value = claims as DesktopClaims, session = this.sessions.get(value.session_id)
    if (!session || session.exp !== exp || exp * 1000 <= Date.now()) return false
    try {
      const runtime = this.current()
      return value.instance_id === runtime.instance_id && value.generation === runtime.generation
        && identity.sameProcess(session.peer, identity.inspectProcess(session.peer.pid))
    } catch { return false }
  }

  async close(): Promise<void> {
    this.stopped = true; this.sessions.clear(); this.nonces.clear()
    this.connections.forEach(socket => socket.destroy())
    const listener = this.listener; this.listener = undefined; await listener?.close()
    if (this.discovery) {
      try {
        const record = JSON.parse(await fs.readFile(this.discovery, 'utf8'))
        if (identity.sameProcess(record.server, this.server)) await fs.unlink(this.discovery)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      this.discovery = undefined
    }
  }
}
