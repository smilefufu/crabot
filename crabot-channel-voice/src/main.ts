import path from 'node:path'
import { VoiceChannel } from './voice-channel.js'

async function main(): Promise<void> {
  const id = process.env.Crabot_MODULE_ID, port = Number(process.env.Crabot_PORT), bearer = process.env.CRABOT_VOICE_RUNTIME_BEARER
  delete process.env.CRABOT_VOICE_RUNTIME_BEARER
  if (!id || !Number.isInteger(port) || port <= 0 || port > 65535 || !bearer) throw new Error('MM voice runtime identity and assigned port are required')
  const data = path.join(process.env.DATA_DIR ?? './data', 'voice', id)
  const channel = new VoiceChannel({ moduleId: id, moduleType: 'channel', version: '0.1.0', protocolVersion: '0.2.0', port }, data, bearer)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void channel.stop().then(() => process.exit(0), () => process.exit(1)) })
  await channel.start(); await channel.register(bearer)
}
main().catch(() => { console.error('Voice Channel startup failed; check MM identity, Admin audio configuration and writable data directory'); process.exit(1) })
