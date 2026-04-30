/**
 * crabot-channel-feishu 模块入口
 *
 * 环境变量：
 * - Crabot_MODULE_ID: 模块实例 ID（必须）
 * - Crabot_PORT: RPC 监听端口（必须）
 * - DATA_DIR: 数据目录（默认 ./data）
 * - FEISHU_APP_ID: 飞书 App ID（必须）
 * - FEISHU_APP_SECRET: 飞书 App Secret（必须）
 * - FEISHU_DOMAIN: feishu | lark（默认 feishu）
 * - FEISHU_OWNER_OPEN_ID: 拥有者 open_id（可选）
 * - FEISHU_ONLY_RESPOND_TO_MENTIONS: 'true' | 'false'（默认 'true'）
 */

import fs from 'node:fs'
import path from 'node:path'
import { FeishuChannel } from './feishu-channel.js'
import type { FeishuDomain } from './types.js'

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

  const appId = process.env.FEISHU_APP_ID
  if (!appId) {
    console.error('FEISHU_APP_ID is required')
    process.exit(1)
  }

  const appSecret = process.env.FEISHU_APP_SECRET
  if (!appSecret) {
    console.error('FEISHU_APP_SECRET is required')
    process.exit(1)
  }

  const domainEnv = (process.env.FEISHU_DOMAIN ?? 'feishu') as FeishuDomain
  const domain: FeishuDomain = domainEnv === 'lark' ? 'lark' : 'feishu'

  const onlyMentions = (process.env.FEISHU_ONLY_RESPOND_TO_MENTIONS ?? 'true').toLowerCase() !== 'false'

  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
  fs.mkdirSync(dataDir, { recursive: true })

  const channel = new FeishuChannel({
    module_id: moduleId,
    module_type: 'channel',
    version: '0.1.0',
    protocol_version: '0.1.0',
    port,
    data_dir: dataDir,
    feishu: {
      app_id: appId,
      app_secret: appSecret,
      domain,
      owner_open_id: process.env.FEISHU_OWNER_OPEN_ID,
      only_respond_to_mentions: onlyMentions,
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
    console.log('Feishu Channel module started successfully')
    console.log(`- Module ID: ${moduleId}`)
    console.log(`- Port: ${port}`)
    console.log(`- Domain: ${domain}`)
    console.log(`- Only @ Crabot in groups: ${onlyMentions}`)
    console.log(`- Data Dir: ${dataDir}`)
  } catch (error) {
    console.error('Failed to start Feishu Channel module:', error)
    process.exit(1)
  }
}

main().catch(console.error)
