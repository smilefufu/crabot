import path from 'node:path'
import { mountChannel, parseMarkdownFormat, type ChannelPluginContext } from 'crabot-shared'
import { TelegramChannel, type TelegramChannelInitConfig } from './telegram-channel.js'

export const name = 'crabot-channel-telegram'
export const inject = ['crabotChannels']
export function apply(ctx: ChannelPluginContext, config: TelegramChannelInitConfig): Promise<void> {
  return mountChannel(ctx, new TelegramChannel(config))
}
export function createConfig(env: NodeJS.ProcessEnv = process.env): TelegramChannelInitConfig {
  const id = env.Crabot_MODULE_ID ?? env.CRABOT_MODULE_ID
  const port = Number(env.Crabot_PORT ?? env.CRABOT_PORT)
  if (!id || !Number.isInteger(port) || port < 1) throw new Error('Managed channel identity is required')
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required')
  if (env.TELEGRAM_MODE && env.TELEGRAM_MODE !== 'polling') throw new Error('Telegram Webhook 已移除，请改用 polling')
  return { module_id: id, module_type: 'channel', version: '0.1.1', protocol_version: '0.1.0',
    port, data_dir: env.DATA_DIR ?? path.join(process.cwd(), 'data'),
    telegram: { bot_token: env.TELEGRAM_BOT_TOKEN, markdown_format: parseMarkdownFormat(env.TELEGRAM_MARKDOWN_FORMAT) },
  }
}
