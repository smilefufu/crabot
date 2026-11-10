import path from 'node:path'
import { mountChannel, type ChannelPluginContext } from 'crabot-shared'
import { WechatChannel, type WechatChannelInitConfig } from './wechat-channel.js'

export const name = 'crabot-channel-wechat'
export const inject = ['crabotChannels']
export function apply(ctx: ChannelPluginContext, config: WechatChannelInitConfig): Promise<void> {
  return mountChannel(ctx, new WechatChannel(config))
}
export function createConfig(env: NodeJS.ProcessEnv = process.env): WechatChannelInitConfig {
  const id = env.Crabot_MODULE_ID ?? env.CRABOT_MODULE_ID
  const port = Number(env.Crabot_PORT ?? env.CRABOT_PORT)
  if (!id || !Number.isInteger(port) || port < 1) throw new Error('Managed channel identity is required')
  if (!env.WECHAT_CONNECTOR_URL || !env.WECHAT_API_KEY) throw new Error('WECHAT_CONNECTOR_URL and WECHAT_API_KEY are required')
  if (env.WECHAT_MODE && env.WECHAT_MODE !== 'socketio') throw new Error('微信 Webhook 已移除，请改用 Socket.IO')
  return { module_id: id, module_type: 'channel', version: '0.1.1', protocol_version: '0.1.0',
    port, data_dir: env.DATA_DIR ?? path.join(process.cwd(), 'data'),
    wechat: { connector_url: env.WECHAT_CONNECTOR_URL, api_key: env.WECHAT_API_KEY,
      only_respond_to_mentions: env.WECHAT_ONLY_RESPOND_TO_MENTIONS === 'true' },
  }
}
