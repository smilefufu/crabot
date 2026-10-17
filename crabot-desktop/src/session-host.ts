import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { DesktopHostStateSchema, DesktopSessionResponseSchema, HttpClient, MeResponseSchema, type DesktopDiagnostics, type DesktopHostState, type DesktopSessionResponse } from 'crabot-client'

export interface HostCredential {
  token: string
  instance_id: string
  generation: string
  admin_url: string
  connection_epoch: number
}
export type HostContext = Omit<HostCredential, 'token'>
export function sameHostContext(a: HostContext, b: HostContext): boolean {
  return a.instance_id === b.instance_id && a.generation === b.generation && a.admin_url === b.admin_url && a.connection_epoch === b.connection_epoch
}

// Main-process state only. A renderer receives a validated state, never HostCredential.
export class SessionHost {
  private session?: DesktopSessionResponse
  private pending?: Promise<void>
  private pendingEpoch = 0
  private timer?: ReturnType<typeof setTimeout>
  private epoch = 0
  private closed = false
  private listeners = new Set<(state: DesktopHostState) => void>()
  private state: DesktopHostState
  private history: DesktopDiagnostics['recent'] = []
  constructor(private readonly options: {
    coreRoot: string
    dataRoot: string
    appVersion: string
    platform: 'darwin' | 'win32' | 'linux'
  }) {
    this.state = { phase: 'discovering', app_version: options.appVersion, platform: options.platform }
  }
  snapshot(): DesktopHostState { return this.state }
  recent(): DesktopDiagnostics['recent'] { return this.history.map(item => ({ ...item })) }
  subscribe(callback: (state: DesktopHostState) => void): () => void {
    this.listeners.add(callback); return () => { this.listeners.delete(callback) }
  }
  private publish(value: DesktopHostState) {
    this.state = DesktopHostStateSchema.parse(value)
    this.history.push({ at: new Date().toISOString(), phase: value.phase, ...('code' in value && value.code ? { code: value.code } : {}) })
    if (this.history.length > 40) this.history.shift()
    this.listeners.forEach(callback => callback(this.state))
  }
  status(phase: Exclude<DesktopHostState['phase'], 'ready'>, message?: string, code?: string) {
    this.epoch++; this.session = undefined; clearTimeout(this.timer)
    this.publish({ phase, app_version: this.options.appVersion, platform: this.options.platform, message, code })
  }
  async reconnect(): Promise<void> {
    if (this.closed) return
    if (this.pending) {
      const pendingEpoch = this.pendingEpoch
      await this.pending
      if (pendingEpoch !== this.epoch && !this.closed) await this.reconnect()
      return
    }
    const epoch = this.epoch
    this.pendingEpoch = epoch
    this.pending = this.establish(epoch).finally(() => { this.pending = undefined })
    return this.pending
  }
  private async establish(epoch: number) {
    if (!this.session) this.publish({ phase: 'authenticating', app_version: this.options.appVersion, platform: this.options.platform })
    try {
      const bootstrap = await import(pathToFileURL(path.join(this.options.coreRoot, 'scripts/lib/desktop-session-client.mjs')).href)
      const session = DesktopSessionResponseSchema.parse(await bootstrap.openDesktopSession(this.options.dataRoot))
      if (this.closed || epoch !== this.epoch) return
      this.session = session
      this.publish({ phase: 'ready', app_version: this.options.appVersion, platform: this.options.platform,
        instance_id: session.instance_id, generation: session.generation, admin_url: session.admin_url })
      clearTimeout(this.timer)
      this.timer = setTimeout(() => { void this.reconnect() }, Math.max(1000, Date.parse(session.expires_at) - Date.now() - 60_000))
    } catch (error) {
      if (this.closed || epoch !== this.epoch) return
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        && /^DESKTOP_[A-Z_]+$/.test(error.code) ? error.code : 'DESKTOP_UNAVAILABLE'
      this.status('disconnected', '本机连接暂时不可用。可重新检查或查看诊断。', code)
    }
  }
  context(): HostContext | null {
    const current = this.session
    return current ? { instance_id: current.instance_id, generation: current.generation, admin_url: current.admin_url, connection_epoch: this.epoch } : null
  }
  async credential(): Promise<HostCredential | null> {
    if (!this.session || this.closed) return null
    if (Date.parse(this.session.expires_at) <= Date.now() + 30_000) await this.reconnect()
    const context = this.context()
    return this.session && context && !this.closed ? { ...context, token: this.session.token } : null
  }
  async check(): Promise<boolean> {
    const session = this.session, epoch = this.epoch
    if (!session || this.closed) return false
    try {
      // Authentication-plane health only. Main does not proxy business requests.
      await new HttpClient({ endpoint: new URL('/api', session.admin_url).href, token: () => session.token })
        .request('/auth/me', MeResponseSchema, { timeoutMs: 2000 })
      return !this.closed && epoch === this.epoch
    } catch {
      if (!this.closed && epoch === this.epoch) this.status('disconnected', '本机连接暂时不可用，正在检查恢复。', 'DESKTOP_UNAVAILABLE')
      return false
    }
  }
  close() { this.closed = true; this.epoch++; this.session = undefined; clearTimeout(this.timer); this.listeners.clear() }
}
