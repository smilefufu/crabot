/**
 * crabot-channel-telegram 模块入口
 *
 * 环境变量：
 * - Crabot_MODULE_ID: 模块实例 ID（必须）
 * - Crabot_PORT: RPC 监听端口（必须）
 * - DATA_DIR: 数据目录
 * - TELEGRAM_BOT_TOKEN: Bot Token（必须）
 * - TELEGRAM_MODE: 消息接收模式 polling | webhook（默认 polling）
 * - TELEGRAM_WEBHOOK_URL: Webhook 回调地址（webhook 模式需要）
 * - TELEGRAM_WEBHOOK_SECRET: Webhook 签名密钥（可选）
 */

import fs from 'node:fs'
import path from 'node:path'
import { TelegramChannel } from './telegram-channel.js'

async function main(): Promise<void> {
  const moduleId = process.env.Crabot_MODULE_ID
  if (!moduleId) {
    console.error('Crabot_MODULE_ID is required')
    process.exit(1)
  }

  const port = parseInt(process.env.Crabot_PORT ?? '0', 10)
  if (!port) {
    console.error('Crabot_PORT is required')
    process.exit(1)
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) {
    console.error('TELEGRAM_BOT_TOKEN is required')
    process.exit(1)
  }

  const mode = (process.env.TELEGRAM_MODE ?? 'polling') as 'polling' | 'webhook'
  const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET

  if (mode === 'webhook' && !webhookUrl) {
    console.error('TELEGRAM_WEBHOOK_URL is required for webhook mode')
    process.exit(1)
  }

  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
  fs.mkdirSync(dataDir, { recursive: true })

  const channel = new TelegramChannel({
    module_id: moduleId,
    module_type: 'channel',
    version: '0.1.0',
    protocol_version: '0.1.0',
    port,
    data_dir: dataDir,
    telegram: {
      bot_token: botToken,
      mode,
      webhook_url: webhookUrl,
      webhook_secret: webhookSecret,
    },
  })

  const shutdown = (signal: string) => () => {
    console.log(`\nReceived ${signal}, shutting down...`)
    channel.stop().then(() => process.exit(0)).catch(() => process.exit(1))
  }
  process.on('SIGINT', shutdown('SIGINT'))
  process.on('SIGTERM', shutdown('SIGTERM'))

  try {
    await channel.start()
    await channel.register()
    console.log('Telegram Channel module started successfully')
    console.log(`- Module ID: ${moduleId}`)
    console.log(`- Port: ${port}`)
    console.log(`- Mode: ${mode}`)
    console.log(`- Data Dir: ${dataDir}`)
  } catch (error) {
    console.error('Failed to start Telegram Channel module:', error)
    process.exit(1)
  }
}

main().catch(console.error)
