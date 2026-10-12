import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MCPServerConfig } from '../types.js'
import type { ToolDefinition } from '../engine/types.js'

export function isStandardComputerUse(config: MCPServerConfig): boolean {
  return config.name === 'computer-use' && (config.transport ?? 'stdio') === 'stdio' && config.command === 'node'
    && config.args?.length === 2 && config.args[1] === '--crabot-standard'
    && config.args[0].replace(/\\/g, '/').endsWith('/crabot-mcp-tools/dist/computer-use/main.js')
    && Object.keys(config.env ?? {}).length === 0
}

/** Agent-owned runtime credentials, independent of principal permission persistence. */
export class ComputerUseOwner {
  private child?: ChildProcess
  private endpoint?: string
  private preparation?: Promise<void>
  private readonly grants = new Map<string, { token: string; check: (method: string) => Promise<boolean> }>()
  private readonly tokens = new Map<string, (method: string) => Promise<boolean>>()
  private config?: MCPServerConfig
  constructor(private readonly rememberSecret: (value: string) => void) {}
  get available(): boolean { return !!this.endpoint && !!this.child?.connected }

  credential(key: string, check: (method: string) => Promise<boolean>): string {
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
    if (!this.available || !this.config) return undefined
    return { ...this.config, env: { CRABOT_COMPUTER_USE_ENDPOINT: this.endpoint!, CRABOT_COMPUTER_USE_TOKEN: this.credential(key, check) } }
  }

  async prepare(configs: ReadonlyArray<MCPServerConfig>): Promise<MCPServerConfig[]> {
    const standard = configs.find(isStandardComputerUse)
    if (!standard) { await this.close(); return [...configs] }
    this.config = standard
    try {
      if (!this.available) {
        this.preparation ??= this.start(standard).finally(() => { this.preparation = undefined })
        await this.preparation
      }
      const catalog = this.workerConfig('catalog', async method => method === 'list')!
      return configs.map(config => config === standard ? catalog : config)
    } catch (error) {
      console.error('[computer-use] unavailable:', error instanceof Error ? error.message : String(error))
      await this.close()
      return configs.filter(config => config !== standard)
    }
  }

  private async start(config: MCPServerConfig): Promise<void> {
    const root = path.resolve(path.dirname(config.args![0]), '../../..')
    const service = path.join(path.dirname(config.args![0]), 'service.js')
    const child = fork(service, [], { env: { ...process.env, CRABOT_COMPUTER_USE_ROOT: root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    this.child = child
    child.stderr?.on('data', () => {}) // Runtime errors cross IPC without process environment or credentials.
    child.on('message', (message: any) => {
      if (message?.type !== 'authorize') return
      const check = this.tokens.get(message.token)
      void Promise.resolve(check?.(message.method) ?? false).catch(() => false).then(allowed => {
        if (child.connected) child.send({ type: 'authorized', id: message.id, allowed })
      })
    })
    child.on('exit', () => { if (this.child === child) { this.endpoint = undefined; this.child = undefined; this.grants.clear(); this.tokens.clear() } })
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error('COMPUTER_USE_HOST_START_TIMEOUT')), 30_000)
      child.once('error', fail)
      child.once('exit', () => { clearTimeout(timer); fail(new Error('COMPUTER_USE_HOST_EXITED')) })
      child.on('message', (message: any) => {
        if (message?.type === 'ready') { clearTimeout(timer); this.endpoint = message.endpoint; done() }
        if (message?.type === 'unavailable') { clearTimeout(timer); fail(new Error(message.reason)) }
      })
    })
  }

  async close(): Promise<void> {
    const child = this.child
    this.endpoint = undefined; this.grants.clear(); this.tokens.clear()
    if (!child) return
    if (child.connected) child.disconnect()
    await new Promise<void>((done, fail) => {
      if (child.exitCode !== null || child.signalCode !== null) return done()
      const timer = setTimeout(() => fail(new Error('COMPUTER_USE_HOST_STOP_UNCONFIRMED')), 20_000)
      child.once('exit', () => { clearTimeout(timer); done() })
    })
    if (this.child === child) this.child = undefined
  }
}
