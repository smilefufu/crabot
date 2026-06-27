/**
 * Module Manager 入口文件
 */

import ModuleManager from './index.js'
import path from 'node:path'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { buildCoreModules } from './core-modules.js'

// 获取模块路径
const CRABOT_ROOT = path.resolve(process.cwd(), '..')
const ADMIN_DIR = path.join(CRABOT_ROOT, 'crabot-admin')
const AGENT_DIR = path.join(CRABOT_ROOT, 'crabot-agent')
const PORT_OFF = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)
const DATA_DIR = process.env.DATA_DIR
  || path.join(homedir(), '.crabot', PORT_OFF > 0 ? `data-${PORT_OFF}` : 'data')
// Agent worker tools 的工作目录（bash / read / write / edit / glob / grep 的 cwd）。
// 默认 = 用户家目录：agent 一上来就能直接看到用户真实文件（~/code/ 等），而不是
// Crabot 自身的安装根（既无用又混淆）。WORKSPACE_DIR env 显式设置则覆盖。
//
// 历史默认是 dirname(DATA_DIR)：dev mode 下碰巧等于 $REPO（合理），其他模式
// 都是 ~/.crabot（agent 只能看到 Crabot 自己的 cli.mjs/data/ 等内脏，对用户工作
// 毫无意义）。2026-06-08 改为统一 homedir()。
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || homedir()
// 写回 process.env 确保子进程通过 process.env spread 时能继承此值
process.env.WORKSPACE_DIR = WORKSPACE_DIR

// 加载环境变量文件（统一从根目录 .env 读取）
const envFiles = [
  path.join(CRABOT_ROOT, '.env'),
]
let envLoaded = false
for (const envFile of envFiles) {
  if (fs.existsSync(envFile)) {
    console.log(`[ModuleManager] Loading env from: ${envFile}`)
    const content = fs.readFileSync(envFile, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=')
        const value = valueParts.join('=')
        if (key && value !== undefined && !process.env[key]) {
          process.env[key] = value
          envLoaded = true
        }
      }
    }
  }
}
if (envLoaded) {
  console.log('[ModuleManager] Environment variables loaded')
}

// 端口偏移：多实例部署时，每个实例设置不同的 CRABOT_PORT_OFFSET（如 0, 100, 200）
const PORT_OFFSET = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)

const PORT = parseInt(process.env.PORT || String(19000 + PORT_OFFSET), 10)
const PORT_RANGE_START = parseInt(process.env.PORT_RANGE_START || String(19002 + PORT_OFFSET), 10)
// 子模块池尾部保留 19099+OFFSET 给 tmp-page server（见 scripts/start.mjs 的 TMP_PAGE_PORT）：
// 池缩到 19098，让 tmp 端口落在 19000 系列段内、跟 OFFSET 走，避免固定 21000+OFFSET 在多租户时撞本段。
const PORT_RANGE_END = parseInt(process.env.PORT_RANGE_END || String(19098 + PORT_OFFSET), 10)
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '30', 10)

// 派生端口（基于偏移自动计算，也可通过各自环境变量显式覆盖）
const ADMIN_RPC_PORT = process.env.CRABOT_ADMIN_PORT || String(19001 + PORT_OFFSET)
const ADMIN_WEB_PORT = process.env.CRABOT_ADMIN_WEB_PORT || String(3000 + PORT_OFFSET)
const MM_ENDPOINT = `http://localhost:${PORT}`
const ADMIN_ENDPOINT = `http://localhost:${ADMIN_RPC_PORT}`

const MEMORY_DIR = path.join(CRABOT_ROOT, 'crabot-memory')

const isDev = process.env.CRABOT_DEV === 'true'

if (PORT_OFFSET !== 0) {
  console.log(`[ModuleManager] Port offset: ${PORT_OFFSET} (MM=${PORT}, Admin RPC=${ADMIN_RPC_PORT}, Admin Web=${ADMIN_WEB_PORT})`)
}

// 核心模块定义（Admin 和 Agent 是核心层模块，需要预定义）
const CORE_MODULES = buildCoreModules({
  crabotRoot: CRABOT_ROOT,
  adminDir: ADMIN_DIR,
  agentDir: AGENT_DIR,
  memoryDir: MEMORY_DIR,
  dataDir: DATA_DIR,
  workspaceDir: WORKSPACE_DIR,
  isDev,
  port: PORT,
  adminRpcPort: ADMIN_RPC_PORT,
  adminWebPort: ADMIN_WEB_PORT,
  mmEndpoint: MM_ENDPOINT,
  adminEndpoint: ADMIN_ENDPOINT,
  newApiToken: process.env.CRABOT_NEW_API_ADMIN_TOKEN || '',
  enableFda: process.env.CRABOT_ENABLE_FDA || '',
})

const manager = new ModuleManager({
  port: PORT,
  port_range: {
    range_start: PORT_RANGE_START,
    range_end: PORT_RANGE_END,
  },
  health_check_interval: HEALTH_CHECK_INTERVAL,
  health_check_timeout: 5,
  health_check_failure_threshold: 3,
  shutdown_timeout: 30,
  hotplug_allowed_types: ['agent', 'channel', 'memory'],
  modules: CORE_MODULES,
}, DATA_DIR)

// 优雅关闭
async function shutdown() {
  console.log('Shutting down Module Manager...')
  try {
    await manager.stop()
    console.log('Module Manager stopped')
    process.exit(0)
  } catch (error) {
    console.error('Error during shutdown:', error)
    process.exit(1)
  }
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// 启动
manager.start().catch((error) => {
  console.error('Failed to start Module Manager:', error)
  process.exit(1)
})

console.log(`Module Manager starting on port ${PORT}...`)
