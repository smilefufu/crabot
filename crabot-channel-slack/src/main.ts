import path from 'node:path'
import { mountChannel, type ChannelPluginContext } from 'crabot-shared'
import { SlackChannel } from './slack-channel.js'

export const name = 'crabot-channel-slack'
export const inject = ['crabotChannels']
export function apply(ctx: ChannelPluginContext, config: ReturnType<typeof createConfig>): Promise<void> {
  return mountChannel(ctx, new SlackChannel(config))
}
export function createConfig(env: NodeJS.ProcessEnv = process.env) {
  const id = env.CRABOT_MODULE_ID ?? env.Crabot_MODULE_ID
  const port = Number(env.CRABOT_PORT ?? env.Crabot_PORT)
  if (!id || !Number.isInteger(port) || port < 1) throw new Error('Managed channel identity is required')
  return { module_id: id, module_type: 'channel' as const, version: '0.1.1', protocol_version: '0.2.0',
    port, data_dir: env.DATA_DIR ?? path.join(process.cwd(), 'data'), env: { ...env } }
}
