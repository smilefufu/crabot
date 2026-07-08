/**
 * crabot-channel-dingtalk 模块入口
 *
 * 环境变量：
 * - Crabot_MODULE_ID: 模块实例 ID（必须）
 * - Crabot_PORT: RPC 监听端口（必须）
 * - DATA_DIR: 数据目录（默认 ./data）
 * - DINGTALK_APP_KEY: 企业内部应用 AppKey（必须，= Stream clientId）
 * - DINGTALK_APP_SECRET: 企业内部应用 AppSecret（必须，= Stream clientSecret）
 * - DINGTALK_ROBOT_CODE: 机器人 robotCode（必须，出站发送用）
 * - DINGTALK_OWNER_STAFF_ID: 拥有者 staffId（可选）
 * - DINGTALK_ONLY_RESPOND_TO_MENTIONS: 'true' | 'false'（默认 'true'）
 * - DINGTALK_MARKDOWN_FORMAT: auto | on | off（默认 auto）
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseMarkdownFormat } from 'crabot-shared'
import { DingtalkChannel } from './dingtalk-channel.js'

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

  const appKey = process.env.DINGTALK_APP_KEY
  if (!appKey) {
    console.error('DINGTALK_APP_KEY is required')
    process.exit(1)
  }

  const appSecret = process.env.DINGTALK_APP_SECRET
  if (!appSecret) {
    console.error('DINGTALK_APP_SECRET is required')
    process.exit(1)
  }

  const robotCode = process.env.DINGTALK_ROBOT_CODE
  if (!robotCode) {
    console.error('DINGTALK_ROBOT_CODE is required')
    process.exit(1)
  }

  const onlyMentions =
    (process.env.DINGTALK_ONLY_RESPOND_TO_MENTIONS ?? 'true').toLowerCase() !== 'false'
  const markdownFormat = parseMarkdownFormat(process.env.DINGTALK_MARKDOWN_FORMAT)

  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
  fs.mkdirSync(dataDir, { recursive: true })

  const channel = new DingtalkChannel({
    module_id: moduleId,
    module_type: 'channel',
    version: '0.1.0',
    protocol_version: '0.1.0',
    port,
    data_dir: dataDir,
    dingtalk: {
      app_key: appKey,
      app_secret: appSecret,
      robot_code: robotCode,
      owner_staff_id: process.env.DINGTALK_OWNER_STAFF_ID,
      only_respond_to_mentions: onlyMentions,
      markdown_format: markdownFormat,
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
    console.log('DingTalk Channel module started successfully')
    console.log(`- Module ID: ${moduleId}`)
    console.log(`- Port: ${port}`)
    console.log(`- Only @ Crabot in groups: ${onlyMentions}`)
    console.log(`- Markdown format: ${markdownFormat}`)
    console.log(`- Data Dir: ${dataDir}`)
  } catch (error) {
    console.error('Failed to start DingTalk Channel module:', error)
    process.exit(1)
  }
}

main().catch(console.error)
