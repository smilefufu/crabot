import type { HealthResult } from './base-protocol.js'
import type { ModuleBase, RpcHandlerContext } from './module-base.js'

export interface ChannelService {
  methods: Record<string, (params: any, context?: RpcHandlerContext) => unknown>
  getHealthDetails(): Promise<Record<string, unknown>>
  getHealthStatus?(details: Record<string, unknown>): Promise<HealthResult['status']>
}
export interface ChannelPluginContext {
  crabotChannels: Map<string, ChannelService>
  effect(callback: () => Promise<() => Promise<void>>): unknown
}

/** Keep platform lifecycle separate from the managed host's transport lifecycle. */
export async function mountChannel(ctx: ChannelPluginContext, channel: ModuleBase): Promise<void> {
  const id = channel.getMetadata().module_id
  const channels = ctx.crabotChannels
  if (channels.has(id)) throw new Error(`Duplicate channel: ${id}`)
  const service = channel.channelService()
  await ctx.effect(async () => {
    try {
      await service.start()
      if (channels.has(id)) throw new Error(`Duplicate channel: ${id}`)
      channels.set(id, service)
    } catch (error) { await service.stop(); throw error }
    return async () => {
      if (channels.get(id) === service) channels.delete(id)
      await service.stop()
    }
  })
}
