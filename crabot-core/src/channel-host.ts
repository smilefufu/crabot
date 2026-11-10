import path from 'node:path'
import { Context } from 'cordis'
import { ModuleBase, getProcessRpcPeer, type Event } from 'crabot-shared'

interface ChannelService {
  methods: Record<string, (params: unknown) => Promise<unknown>>
  getHealthDetails(): Promise<Record<string, unknown>>
}
interface ChannelConfig {
  module_id: string
  module_type: 'channel'
  version: string
  protocol_version: string
}
interface ChannelPlugin {
  apply(ctx: Context, config: ChannelConfig): Promise<void>
  createConfig(env: NodeJS.ProcessEnv): ChannelConfig
}
declare module 'cordis' {
  interface Context { crabotChannels: Map<string, ChannelService> }
  interface Events { 'crabot/channel-event'(event: Event): Promise<void> | void }
}

/** The managed process provides transport; the plugin owns platform business and resources. */
export class CordisChannelHost extends ModuleBase {
  private readonly context = new Context()
  private channel?: ChannelService

  constructor(private readonly plugin: ChannelPlugin, private readonly pluginConfig: ChannelConfig, port: number) {
    super({ moduleId: pluginConfig.module_id, moduleType: pluginConfig.module_type,
      version: pluginConfig.version, protocolVersion: pluginConfig.protocol_version, port })
  }

  protected async onStart(): Promise<void> {
    if (!getProcessRpcPeer()) throw new Error('Cordis Channel requires managed IPC')
    this.context.provide('crabotChannels', new Map())
    this.context.on('crabot/channel-event', event => this.rpcClient.publishEvent(event, this.config.moduleId).then(() => {}))
    try {
      await this.context.plugin(this.plugin, this.pluginConfig)
      this.channel = this.context.crabotChannels.get(this.config.moduleId)
      if (!this.channel) throw new Error('Cordis plugin did not provide its channel instance')
      for (const [method, handler] of Object.entries(this.channel.methods)) {
        this.registerMethod(method, handler)
      }
    } catch (error) {
      await this.context.fiber.dispose()
      throw error
    }
  }

  protected async onStop(): Promise<void> { await this.context.fiber.dispose() }
  protected async getHealthDetails(): Promise<Record<string, unknown>> {
    if (!this.channel) throw new Error('Cordis channel has not started')
    return this.channel.getHealthDetails()
  }
}

export async function startCordisChannel(): Promise<CordisChannelHost> {
  const pluginPath = process.env.CRABOT_CHANNEL_PLUGIN_PATH
  const port = Number(process.env.Crabot_PORT)
  if (!pluginPath || !path.isAbsolute(pluginPath)) throw new Error('Managed plugin path is required')
  if (!Number.isInteger(port) || port < 1) throw new Error('Managed runtime address is required')
  const plugin = require(pluginPath) as ChannelPlugin
  const host = new CordisChannelHost(plugin, plugin.createConfig(process.env), port)
  const shutdown = (): void => { host.stop().catch(error => { console.error(error); process.exitCode = 1 }) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  try {
    await host.start()
    await host.register()
    return host
  } catch (error) {
    process.removeListener('SIGINT', shutdown)
    process.removeListener('SIGTERM', shutdown)
    await host.stop()
    throw error
  }
}

if (require.main === module) {
  startCordisChannel().catch(error => { console.error('Cordis Channel startup failed:', error); process.exitCode = 1 })
}
