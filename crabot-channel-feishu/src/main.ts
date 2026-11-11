/** Cordis-only Feishu entry. Importing this module does not start a connection. */
import path from 'node:path'
import { parseMarkdownFormat } from 'crabot-shared'
import type { Context } from 'cordis'
import type { Event } from 'crabot-shared'
import { FeishuChannel, type FeishuChannelInitConfig } from './feishu-channel.js'

export const name = 'crabot-channel-feishu'
export const inject = ['crabotChannels']
export type Config = FeishuChannelInitConfig

// The host owns routing; channel instances retain separate identities and data.
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

/** Preserve the existing stored environment configuration at the host boundary. */
export function createConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const moduleId = env.Crabot_MODULE_ID ?? env.CRABOT_MODULE_ID
  if (!moduleId) throw new Error('Crabot_MODULE_ID is required')
  if (!env.FEISHU_APP_ID) throw new Error('FEISHU_APP_ID is required')
  if (!env.FEISHU_APP_SECRET) throw new Error('FEISHU_APP_SECRET is required')
  return {
    module_id: moduleId,
    module_type: 'channel',
    version: '0.1.1',
    protocol_version: '0.1.0',
    data_dir: env.DATA_DIR ?? path.join(process.cwd(), 'data'),
    feishu: {
      app_id: env.FEISHU_APP_ID,
      app_secret: env.FEISHU_APP_SECRET,
      domain: env.FEISHU_DOMAIN === 'lark' ? 'lark' : 'feishu',
      owner_open_id: env.FEISHU_OWNER_OPEN_ID,
      only_respond_to_mentions: (env.FEISHU_ONLY_RESPOND_TO_MENTIONS ?? 'true').toLowerCase() !== 'false',
      markdown_format: parseMarkdownFormat(env.FEISHU_MARKDOWN_FORMAT),
    },
  }
}
