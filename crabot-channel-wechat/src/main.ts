/**
 * crabot-channel-wechat 模块入口
 *
 * 环境变量：
 * - Crabot_MODULE_ID: 模块实例 ID（必须）
 * - Crabot_PORT: RPC 监听端口（必须）
 * - DATA_DIR: 数据目录
 * - WECHAT_CONNECTOR_URL: wechat-connector 服务器地址（必须）
 * - WECHAT_API_KEY: Bot API Key（必须）
 * - WECHAT_MODE: 推送模式 socketio | webhook（默认 socketio）
 * - WECHAT_WEBHOOK_SECRET: Webhook 签名密钥（webhook 模式需要）
 * - WECHAT_WEBHOOK_PORT: Webhook 监听端口（webhook 模式需要）
 */

import fs from 'node:fs'
import path from 'node:path'
import { WechatChannel } from './wechat-channel.js'

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

  const connectorUrl = process.env.WECHAT_CONNECTOR_URL
  if (!connectorUrl) {
    console.error('WECHAT_CONNECTOR_URL is required')
    process.exit(1)
  }

  const apiKey = process.env.WECHAT_API_KEY
  if (!apiKey) {
    console.error('WECHAT_API_KEY is required')
    process.exit(1)
  }

  const mode = (process.env.WECHAT_MODE ?? 'socketio') as 'socketio' | 'webhook'
  const webhookSecret = process.env.WECHAT_WEBHOOK_SECRET
  const webhookPort = process.env.WECHAT_WEBHOOK_PORT
    ? parseInt(process.env.WECHAT_WEBHOOK_PORT, 10)
    : undefined

  if (mode === 'webhook' && !webhookPort) {
    console.error('WECHAT_WEBHOOK_PORT is required for webhook mode')
    process.exit(1)
  }

  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  const channel = new WechatChannel({
    module_id: moduleId,
    module_type: 'channel',
    version: '0.1.0',
    protocol_version: '0.1.0',
    port,
    data_dir: dataDir,
    wechat: {
      connector_url: connectorUrl,
      api_key: apiKey,
      mode,
      webhook_secret: webhookSecret,
      webhook_port: webhookPort,
    },
  })

  process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, shutting down...')
    channel.stop().then(() => process.exit(0)).catch(() => process.exit(1))
  })

  process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down...')
    channel.stop().then(() => process.exit(0)).catch(() => process.exit(1))
  })

  try {
    await channel.start()
    await channel.register()
    console.log('WeChat Channel module started successfully')
    console.log(`- Module ID: ${moduleId}`)
    console.log(`- Port: ${port}`)
    console.log(`- Mode: ${mode}`)
    console.log(`- Connector: ${connectorUrl}`)
    console.log(`- Data Dir: ${dataDir}`)
  } catch (error) {
    console.error('Failed to start WeChat Channel module:', error)
    process.exit(1)
  }
}

main().catch(console.error)
