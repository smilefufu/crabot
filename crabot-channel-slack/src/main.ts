import path from 'node:path'
import { RpcError } from 'crabot-shared'
import { SlackChannel } from './slack-channel.js'

async function main() {
  const moduleId = process.env.CRABOT_MODULE_ID || process.env.Crabot_MODULE_ID
  const port = Number(process.env.CRABOT_PORT || process.env.Crabot_PORT)
  if (!moduleId || !Number.isInteger(port) || port <= 0) throw new RpcError('INVALID_PARAMS', 'CRABOT_MODULE_ID / CRABOT_PORT required')
  const channel = new SlackChannel({ module_id: moduleId, port, data_dir: process.env.DATA_DIR || path.join(process.cwd(), 'data'), env: process.env })
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    try { await channel.stop(); process.exit(0) } catch { process.exit(1) }
  }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
  try { await channel.start(); await channel.register(); console.log('[Slack] channel started') }
  catch (error) {
    await channel.stop().catch(() => {})
    throw error
  }
}
main().catch(error => {
  console.error(error instanceof RpcError ? `[Slack] ${error.code}: ${error.message}` : '[Slack] startup failed; verify saved config, tokens, scopes and connectivity')
  process.exit(1)
})
