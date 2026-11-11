import path from 'node:path'
import { mountChannel, type ChannelPluginContext } from 'crabot-shared'
import { VoiceChannel } from './voice-channel.js'

export const name = 'crabot-channel-voice'
export const inject = ['crabotChannels']
export async function apply(ctx: ChannelPluginContext, config: ReturnType<typeof createConfig>): Promise<void> {
  const { module_id: id, port, runtime_bearer: bearer, data_dir: data } = config
  return mountChannel(ctx, new VoiceChannel({ moduleId: id, moduleType: 'channel', version: config.version,
    protocolVersion: config.protocol_version, port }, data, bearer))
}
export function createConfig(env: NodeJS.ProcessEnv = process.env) {
  const id = env.Crabot_MODULE_ID ?? env.CRABOT_MODULE_ID
  const port = Number(env.Crabot_PORT ?? env.CRABOT_PORT)
  const bearer = env.CRABOT_VOICE_RUNTIME_BEARER
  delete env.CRABOT_VOICE_RUNTIME_BEARER
  if (!id || !Number.isInteger(port) || port < 1 || !bearer) throw new Error('MM voice runtime identity is required')
  return { module_id: id, module_type: 'channel' as const, version: '0.1.3', protocol_version: '0.9.0', port,
    data_dir: path.join(env.DATA_DIR ?? './data', 'voice', id), runtime_bearer: bearer }
}
