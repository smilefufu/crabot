/** Cordis-only Feishu entry. Importing this module does not start a connection. */
import type { Context } from 'cordis'
import type { Event } from 'crabot-shared'
import { FeishuChannel, type FeishuChannelInitConfig } from './feishu-channel.js'

export const name = 'crabot-channel-feishu'
export const inject = ['crabotChannels']
export type Config = FeishuChannelInitConfig

// The experiment host owns routing; channel instances retain separate identities and data.
declare module 'cordis' {
  interface Context {
    crabotChannels: Map<string, FeishuChannel>
  }
  interface Events {
    'crabot/channel-event'(event: Event): Promise<void> | void
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const id = config.module_id
  const channels = ctx.crabotChannels
  if (channels.has(id)) throw new Error(`Duplicate channel: ${id}`)
  const channel = new FeishuChannel(config, {
    publishEvent: event => ctx.parallel('crabot/channel-event', structuredClone(event)),
  })
  await ctx.effect(async () => {
    try {
      await channel.start()
      if (channels.has(id)) throw new Error(`Duplicate channel: ${id}`)
      channels.set(id, channel)
    } catch (error) {
      await channel.stop()
      throw error
    }
    return async () => {
      if (channels.get(id) === channel) channels.delete(id)
      await channel.stop()
    }
  })
}
