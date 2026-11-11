import path from 'node:path'
import { mountChannel, parseMarkdownFormat, type ChannelPluginContext } from 'crabot-shared'
import { DingtalkChannel, type DingtalkChannelInitConfig } from './dingtalk-channel.js'

export const name = 'crabot-channel-dingtalk'
export const inject = ['crabotChannels']
export async function apply(ctx: ChannelPluginContext, config: DingtalkChannelInitConfig): Promise<void> {
  return mountChannel(ctx, new DingtalkChannel(config))
}
export function createConfig(env: NodeJS.ProcessEnv = process.env): DingtalkChannelInitConfig {
  const id = env.Crabot_MODULE_ID ?? env.CRABOT_MODULE_ID
  const port = Number(env.Crabot_PORT ?? env.CRABOT_PORT)
  if (!id || !Number.isInteger(port) || port < 1) throw new Error('Managed channel identity is required')
  if (!env.DINGTALK_APP_KEY || !env.DINGTALK_APP_SECRET || !env.DINGTALK_ROBOT_CODE) throw new Error('DingTalk credentials are required')
  return { module_id: id, module_type: 'channel', version: '0.1.3', protocol_version: '0.1.0',
    port, data_dir: env.DATA_DIR ?? path.join(process.cwd(), 'data'),
    dingtalk: { app_key: env.DINGTALK_APP_KEY, app_secret: env.DINGTALK_APP_SECRET, robot_code: env.DINGTALK_ROBOT_CODE,
      owner_staff_id: env.DINGTALK_OWNER_STAFF_ID, only_respond_to_mentions: (env.DINGTALK_ONLY_RESPOND_TO_MENTIONS ?? 'true').toLowerCase() !== 'false',
      markdown_format: parseMarkdownFormat(env.DINGTALK_MARKDOWN_FORMAT) },
  }
}
