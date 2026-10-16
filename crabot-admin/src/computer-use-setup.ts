import { randomUUID } from 'node:crypto'
import type { ComputerUseRuntimeStatus, ComputerUseSetupRequest, ComputerUseSetupStatus } from 'crabot-shared'

interface SetupConfiguration { enabled: boolean; standard: boolean; root: string; key: string }
interface PermissionProbe { accessibility: boolean; screen_recording: boolean; capturable?: boolean }
interface SetupDependencies {
  configuration(): SetupConfiguration
  host(): Promise<ComputerUseSetupStatus['host']>
  runtime(): Promise<ComputerUseRuntimeStatus>
  permissions(root: string, signal: AbortSignal): Promise<PermissionProbe>
  request(root: string, capture: boolean, signal: AbortSignal): Promise<PermissionProbe>
  settings(root: string, permission: 'accessibility' | 'screen_recording', signal: AbortSignal): Promise<void>
  appPath(root: string): string | undefined
  reveal(root: string): Promise<void>
  invalidate(): Promise<void>
}

const activePhases = new Set(['permissions', 'capture', 'connecting'])
function code(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return /^COMPUTER_USE_[A-Z_]+$/.test(message) ? message : 'COMPUTER_USE_SETUP_FAILED'
}

/** Human setup only; no task, permission snapshot or configuration mutation. */
export class ComputerUseSetup {
  private operation?: { view: NonNullable<ComputerUseSetupStatus['setup']>; config: SetupConfiguration; controller: AbortController; promise: Promise<void> }
  private capture: ComputerUseSetupStatus['capture'] = { status: 'unverified' }
  private captureKey?: string
  private permissions?: { key: string; value: PermissionProbe; at: number }
  private permissionFlight?: Promise<PermissionProbe>
  private permissionController?: AbortController
  private closed = false

  constructor(private readonly deps: SetupDependencies) {}

  private blocked(config: SetupConfiguration, host: ComputerUseSetupStatus['host']): string | undefined {
    if (!config.standard) return 'COMPUTER_USE_CUSTOM_BACKEND'
    if (!config.enabled) return 'COMPUTER_USE_DISABLED'
    if (!['darwin', 'win32', 'linux'].includes(host.platform)) return 'COMPUTER_USE_PLATFORM_UNSUPPORTED'
    if (host.session !== 'active') return 'COMPUTER_USE_INTERACTIVE_SESSION_REQUIRED'
    if (this.closed) return 'COMPUTER_USE_SETUP_CLOSED'
  }

  private readPermissions(config: SetupConfiguration): Promise<PermissionProbe> {
    if (this.permissions?.key === config.key && Date.now() - this.permissions.at < 2000) return Promise.resolve(this.permissions.value)
    if (this.permissionFlight) return this.permissionFlight
    const controller = new AbortController()
    this.permissionController = controller
    this.permissionFlight = this.deps.permissions(config.root, controller.signal).then(value => {
      if (this.deps.configuration().key !== config.key) throw new Error('COMPUTER_USE_SETUP_CHANGED')
      if (!controller.signal.aborted && !this.closed && this.deps.configuration().key === config.key) this.permissions = { key: config.key, value, at: Date.now() }
      return value
    }).finally(() => { this.permissionFlight = undefined; this.permissionController = undefined })
    return this.permissionFlight
  }

  private current(operation: NonNullable<ComputerUseSetup['operation']>): boolean {
    const config = this.deps.configuration()
    return !this.closed && this.operation === operation && !operation.controller.signal.aborted
      && Date.now() < Date.parse(operation.view.expires_at) && config.key === operation.config.key
      && config.enabled && config.standard
  }

  /** Called only while constructing an authenticated current core config response. */
  requestForAgent(): ComputerUseSetupRequest | undefined {
    const op = this.operation
    if (!op || !this.current(op) || op.view.phase !== 'capture') return undefined
    return { setup_id: op.view.setup_id, expires_at: op.view.expires_at }
  }

  async status(): Promise<ComputerUseSetupStatus> {
    const config = this.deps.configuration()
    const host = await this.deps.host()
    const blocked = this.blocked(config, host)
    if (this.operation && activePhases.has(this.operation.view.phase) && (blocked || !this.current(this.operation))) this.operation.controller.abort()
    const runtime = await this.deps.runtime().catch(() => ({ state: 'uninitialized' as const, reason: 'COMPUTER_USE_AGENT_UNAVAILABLE' }))
    const status: ComputerUseSetupStatus = { enabled: config.enabled, standard: config.standard, host,
      permissions: { accessibility: host.platform === 'darwin' ? 'unknown' : 'not_applicable', screen_recording: host.platform === 'darwin' ? 'unknown' : 'not_applicable' },
      capture: this.captureKey === config.key ? this.capture : { status: 'unverified' }, runtime,
      ...(this.operation?.config.key === config.key ? { setup: { ...this.operation.view } } : {}), ...(blocked ? { reason: blocked } : {}) }
    if (blocked) return status
    try {
      status.app_path = this.deps.appPath(config.root)
      if (host.platform === 'darwin') {
        // A prompt helper owns this period; ordinary GET must not create another helper.
        const probe = this.operation && ['permissions', 'capture'].includes(this.operation.view.phase)
          ? this.permissions?.key === config.key ? this.permissions.value : undefined : await this.readPermissions(config)
        if (probe) {
          status.permissions = { accessibility: probe.accessibility ? 'granted' : 'missing', screen_recording: probe.screen_recording ? 'granted' : 'missing' }
          if (!probe.accessibility || !probe.screen_recording) status.capture = { status: 'unverified' }
        }
      }
    } catch (error) { status.reason = code(error) }
    return status
  }

  async start(): Promise<ComputerUseSetupStatus> {
    if (this.closed) throw new Error('COMPUTER_USE_SETUP_CLOSED')
    const config = this.deps.configuration()
    const host = await this.deps.host()
    const blocked = this.blocked(config, host)
    if (blocked) throw new Error(blocked)
    // Recheck after awaits: two simultaneous POSTs still share one operation.
    if (this.operation && activePhases.has(this.operation.view.phase)) {
      if (this.operation.config.key === config.key) return this.status()
      this.operation.controller.abort(); await this.operation.promise
      return this.start()
    }
    this.capture = { status: 'unverified' }
    this.captureKey = config.key
    const operation = { config, controller: new AbortController(),
      view: { setup_id: randomUUID(), phase: 'permissions' as const, expires_at: new Date(Date.now() + 180000).toISOString() } as NonNullable<ComputerUseSetupStatus['setup']>,
      promise: Promise.resolve() }
    this.operation = operation
    operation.promise = this.run(operation, host.platform)
    return this.status()
  }

  private async wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('COMPUTER_USE_SETUP_CANCELLED')
    await new Promise<void>(done => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); done() }
      const timer = setTimeout(finish, 2000)
      signal.addEventListener('abort', finish, { once: true })
    })
  }

  private async run(op: NonNullable<ComputerUseSetup['operation']>, platform: string): Promise<void> {
    const signal = op.controller.signal
    const timer = setTimeout(() => op.controller.abort(), Math.max(0, Date.parse(op.view.expires_at) - Date.now()))
    try {
      await this.permissionFlight
      if (!this.current(op)) throw new Error('COMPUTER_USE_SETUP_CANCELLED')
      if (platform === 'darwin') {
        let probe = this.permissions?.key === op.config.key && Date.now() - this.permissions.at < 2000
          ? this.permissions.value : await this.deps.permissions(op.config.root, signal)
        if (!this.current(op)) throw new Error('COMPUTER_USE_SETUP_CANCELLED')
        this.permissions = { key: op.config.key, value: probe, at: Date.now() }
        if (!probe.accessibility || !probe.screen_recording) {
          await this.deps.request(op.config.root, false, signal)
          if (!this.current(op)) throw new Error('COMPUTER_USE_SETUP_CANCELLED')
          let opened: 'accessibility' | 'screen_recording' = probe.accessibility ? 'screen_recording' : 'accessibility'
          await this.deps.settings(op.config.root, opened, signal)
          while (this.current(op)) {
            await this.wait(signal)
            probe = await this.deps.permissions(op.config.root, signal)
            if (!this.current(op)) break
            this.permissions = { key: op.config.key, value: probe, at: Date.now() }
            if (probe.accessibility && probe.screen_recording) break
            const missing = probe.accessibility ? 'screen_recording' : 'accessibility'
            if (missing !== opened) { await this.deps.settings(op.config.root, missing, signal); opened = missing }
          }
        }
        if (!this.current(op)) throw new Error('COMPUTER_USE_SETUP_CANCELLED')
        op.view.phase = 'capture'
        const capture = await this.deps.request(op.config.root, true, signal)
        if (!this.current(op)) throw new Error('COMPUTER_USE_SETUP_CANCELLED')
        if (!capture.capturable) throw new Error('COMPUTER_USE_CAPTURE_FAILED')
        this.capture = { status: 'verified', verified_at: new Date().toISOString() }
        op.view.phase = 'connecting'
      } else op.view.phase = 'capture'
      if (!this.current(op)) throw new Error('COMPUTER_USE_SETUP_CANCELLED')
      await this.deps.invalidate()
      while (this.current(op)) {
        const runtime = await this.deps.runtime()
        if (!this.current(op)) break
        if (runtime.state === 'quarantined') throw new Error('COMPUTER_USE_QUARANTINED')
        if (platform !== 'darwin' && runtime.capture?.setup_id === op.view.setup_id) {
          this.capture = { status: runtime.capture.status, verified_at: runtime.capture.verified_at, reason: runtime.capture.reason }
          if (this.capture.status === 'failed') throw new Error(this.capture.reason ?? 'COMPUTER_USE_CAPTURE_FAILED')
        }
        if (runtime.checks?.some(check => check.status === 'fail')) throw new Error('COMPUTER_USE_NATIVE_CAPABILITY_UNAVAILABLE')
        if (runtime.state === 'ready' && this.capture.status === 'verified') { op.view.phase = 'ready'; return }
        await this.wait(signal)
      }
      throw new Error('COMPUTER_USE_SETUP_CANCELLED')
    } catch (error) {
      op.view.phase = signal.aborted ? 'cancelled' : 'failed'
      op.view.reason = Date.now() >= Date.parse(op.view.expires_at) ? 'COMPUTER_USE_SETUP_TIMEOUT' : code(error)
      if (this.capture.status !== 'verified') this.capture = { status: 'failed', reason: op.view.reason }
    } finally { clearTimeout(timer) }
  }

  async cancel(id: string): Promise<ComputerUseSetupStatus> {
    if (this.operation?.view.setup_id !== id) throw new Error('COMPUTER_USE_SETUP_CHANGED')
    this.operation.controller.abort()
    await this.deps.invalidate().catch(() => {})
    await this.operation.promise
    return this.status()
  }
  async reveal(): Promise<ComputerUseSetupStatus> {
    const config = this.deps.configuration()
    const host = await this.deps.host()
    const blocked = this.blocked(config, host)
    if (blocked) throw new Error(blocked)
    if (host.platform !== 'darwin') throw new Error('COMPUTER_USE_PLATFORM_UNSUPPORTED')
    await this.deps.reveal(config.root)
    return this.status()
  }
  async close(): Promise<void> {
    this.closed = true
    this.permissionController?.abort()
    this.operation?.controller.abort()
    if (this.operation && activePhases.has(this.operation.view.phase)) await this.deps.invalidate().catch(() => {})
    await Promise.allSettled([this.permissionFlight, this.operation?.promise])
  }
}
