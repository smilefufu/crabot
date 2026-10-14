import { buildScrubbedChildEnv } from '../workers/connections/secret-env.js'
import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { isStandardComputerUse, type ComputerUseRuntimeStatus, type ComputerUseSetupRequest } from 'crabot-shared'
import type { MCPServerConfig } from '../types.js'
import type { ToolDefinition } from '../engine/types.js'

const managedConfigurations = new WeakSet<MCPServerConfig>()
export function isManagedComputerUse(config: MCPServerConfig): boolean { return managedConfigurations.has(config) }

export { isStandardComputerUse }

/** Agent-owned runtime credentials, independent of principal permission persistence. */
export class ComputerUseOwner {
  private child?: ChildProcess
  private endpoint?: string
  private preparation?: Promise<void>
  private ready = false
  private quarantined = false
  private reason?: string
  private generation = 0
  private capture?: ComputerUseRuntimeStatus['capture']
  private setupId?: string
  private setupAbort?: AbortController
  private readonly diagnosticsPending = new Map<string, (checks: NonNullable<ComputerUseRuntimeStatus['checks']>) => void>()
  private readonly grants = new Map<string, { token: string; check: (method: string, name?: string) => Promise<boolean> }>()
  private readonly tokens = new Map<string, (method: string, name?: string) => Promise<boolean>>()
  private config?: MCPServerConfig
  constructor(private readonly rememberSecret: (value: string) => void, private readonly stateDirectory: () => string, private readonly retireLegacy: () => Promise<void>) {}
  get connected(): boolean { return !!this.endpoint && !!this.child?.connected }
  get available(): boolean { return this.ready && this.connected }
  get status(): ComputerUseRuntimeStatus {
    return { state: this.quarantined ? 'quarantined' : this.available ? 'ready' : this.child ? 'connecting' : 'uninitialized',
      ...(this.reason ? { reason: this.reason } : {}), ...(this.capture ? { capture: { ...this.capture } } : {}) }
  }
  async diagnostics(): Promise<ComputerUseRuntimeStatus> {
    if (!this.available || !this.child?.connected) return this.status
    const child = this.child
    const id = randomUUID()
    const checks = await new Promise<NonNullable<ComputerUseRuntimeStatus['checks']>>(done => {
      const timer = setTimeout(() => { this.diagnosticsPending.delete(id); done([]) }, 3500)
      this.diagnosticsPending.set(id, value => { clearTimeout(timer); done(value) })
      child.send({ type: 'diagnostics', id }, error => { if (error) { this.diagnosticsPending.get(id)?.([]); this.diagnosticsPending.delete(id) } })
    })
    return { ...this.status, checks }
  }

  async verifySetup(request: ComputerUseSetupRequest, current: () => boolean): Promise<void> {
    if (this.setupId === request.setup_id || !this.available || !this.config || Date.parse(request.expires_at) <= Date.now()) return
    this.setupId = request.setup_id
    const generation = this.generation
    const key = `host-setup:${request.setup_id}`
    const controller = new AbortController()
    this.setupAbort = controller
    const timer = setTimeout(() => controller.abort(), Math.min(10000, Date.parse(request.expires_at) - Date.now()))
    const authorized = () => generation === this.generation && this.available && current() && !controller.signal.aborted && Date.now() < Date.parse(request.expires_at)
    const token = this.credential(key, async (method, name) => authorized() && method === 'call' && (!name || name === 'get_desktop_state'))
    try {
      const root = path.resolve(path.dirname(this.config.args![0]), '../../..')
      const { requestComputerUse } = require(path.join(root, 'crabot-mcp-tools/dist/computer-use/client.js'))
      const result = await requestComputerUse(this.endpoint!, { token, method: 'call', name: 'get_desktop_state', args: { max_image_dimension: 64 } }, controller.signal)
      if (!authorized()) return
      const verified = result?.isError !== true && Array.isArray(result?.content)
        && result.content.some((item: any) => {
          if (item.type !== 'image' || item.mimeType !== 'image/png' || typeof item.data !== 'string') return false
          const bytes = Buffer.from(item.data, 'base64')
          return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
        })
      this.capture = { setup_id: request.setup_id, status: verified ? 'verified' : 'failed',
        ...(verified ? { verified_at: new Date().toISOString() } : { reason: 'COMPUTER_USE_CAPTURE_FAILED' }) }
    } catch {
      if (generation === this.generation && current()) this.capture = { setup_id: request.setup_id, status: 'failed', reason: 'COMPUTER_USE_CAPTURE_FAILED' }
    } finally {
      clearTimeout(timer); this.revoke(key)
      if (this.setupAbort === controller) this.setupAbort = undefined
    }
  }
  cancelSetupVerification(): void { this.setupAbort?.abort() }
  revoke(key: string): void {
    const grant = this.grants.get(key)
    if (!grant) return
    this.grants.delete(key); this.tokens.delete(grant.token)
    if (this.child?.connected) this.child.send({ type: 'revoke', token: grant.token })
  }

  credential(key: string, check: (method: string, name?: string) => Promise<boolean>): string {
    const grant = this.grants.get(key)
    const token = grant?.token ?? randomUUID()
    this.grants.set(key, { token, check }); this.tokens.set(token, check); this.rememberSecret(token)
    return token
  }

  bindTools(tools: ReadonlyArray<ToolDefinition>, key: string, check: () => Promise<boolean>): ToolDefinition[] {
    const token = this.credential(key, async method => method === 'list' || check())
    return tools.map(tool => tool.traceMetadata?.computer_use_standard === true ? { ...tool,
      call: (input, context) => tool.call(input, { ...context, computerUseCredential: token }),
    } : tool)
  }

  workerConfig(key: string, check: (method: string) => Promise<boolean>): MCPServerConfig | undefined {
    if (!this.connected || !this.config) return undefined
    const config = { ...this.config, env: { CRABOT_COMPUTER_USE_ENDPOINT: this.endpoint!, CRABOT_COMPUTER_USE_TOKEN: this.credential(key, check) } }
    managedConfigurations.add(config)
    return config
  }

  async prepare(configs: ReadonlyArray<MCPServerConfig>): Promise<MCPServerConfig[]> {
    const standard = configs.find(isStandardComputerUse)
    if (!standard) { await this.close().catch(error => console.error('[computer-use] cleanup pending:', error.message)); return [...configs] }
    this.config = standard
    try {
      if (!this.connected) {
        if (this.child) await this.close()
        this.preparation ??= this.start(standard).finally(() => { this.preparation = undefined })
        await this.preparation
      }
      const catalog = this.workerConfig('catalog', async method => method === 'list')!
      return configs.map(config => config === standard ? catalog : config)
    } catch (error) {
      console.error('[computer-use] unavailable:', error instanceof Error ? error.message : String(error))
      await this.close().catch(error => console.error('[computer-use] cleanup pending:', error.message))
      this.reason = error instanceof Error && /^COMPUTER_USE_[A-Z_]+$/.test(error.message) ? error.message : 'COMPUTER_USE_RUNTIME_UNAVAILABLE'
      return configs.filter(config => config !== standard)
    }
  }

  private async start(config: MCPServerConfig): Promise<void> {
    const generation = this.generation
    await this.retireLegacy()
    if (generation !== this.generation) throw new Error('COMPUTER_USE_HOST_CLOSED')
    const root = path.resolve(path.dirname(config.args![0]), '../../..')
    const service = path.join(path.dirname(config.args![0]), 'service.js')
    const env = buildScrubbedChildEnv()
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'SESSIONNAME']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]!
    }
    env.CRABOT_COMPUTER_USE_ROOT = root
    env.CRABOT_COMPUTER_USE_STATE_DIR = this.stateDirectory()
    const child = fork(service, [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    this.child = child
    child.stderr?.on('data', () => {}) // Runtime errors cross IPC without process environment or credentials.
    child.on('message', (message: any) => {
      if (this.child !== child) return
      if (message?.type === 'availability') { this.ready = message.available === true; this.quarantined = !this.ready }
      if (message?.type === 'diagnostics' && Array.isArray(message.checks)) {
        this.diagnosticsPending.get(message.id)?.(message.checks.filter((check: any) => typeof check?.name === 'string' && ['pass', 'fail', 'skip'].includes(check.status)).map((check: any) => ({ name: check.name, status: check.status })))
        this.diagnosticsPending.delete(message.id)
      }
      if (message?.type !== 'authorize') return
      const check = this.tokens.get(message.token)
      void Promise.resolve(check?.(message.method, message.name) ?? false).catch(() => false).then(allowed => {
        if (child.connected) child.send({ type: 'authorized', id: message.id, allowed })
      })
    })
    child.on('exit', () => { if (this.child === child) { this.quarantined ||= this.ready; this.ready = false; this.endpoint = undefined; this.child = undefined; this.grants.clear(); this.tokens.clear(); this.setupAbort?.abort(); for (const done of this.diagnosticsPending.values()) done([]); this.diagnosticsPending.clear() } })
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('COMPUTER_USE_HOST_START_TIMEOUT')), 30_000)
      child.once('error', fail)
      child.once('exit', () => { clearTimeout(timer); fail(new Error('COMPUTER_USE_HOST_EXITED')) })
      child.on('message', (message: any) => {
        if (message?.type === 'ready') {
          clearTimeout(timer)
          if (this.child !== child || generation !== this.generation || !child.connected) { fail(new Error('COMPUTER_USE_HOST_CLOSED')); return }
          this.endpoint = message.endpoint; this.ready = true; this.quarantined = false; this.reason = undefined; done()
        }
        if (message?.type === 'unavailable') { clearTimeout(timer); fail(new Error(message.reason)) }
      })
    })
  }

  async close(): Promise<void> {
    this.generation += 1
    this.setupAbort?.abort()
    this.capture = undefined
    const child = this.child
    this.ready = false; this.endpoint = undefined; this.grants.clear(); this.tokens.clear()
    if (!child) return
    if (child.connected) child.disconnect()
    await new Promise<void>((done, fail) => {
      if (child.exitCode !== null || child.signalCode !== null) return done()
      const timer = setTimeout(() => fail(new Error('COMPUTER_USE_HOST_STOP_UNCONFIRMED')), 20_000)
      child.once('exit', () => { clearTimeout(timer); done() })
    })
    if (this.child === child) this.child = undefined
    this.quarantined = false
  }
}
