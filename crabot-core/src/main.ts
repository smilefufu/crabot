/**
 * Module Manager 入口文件
 */

import ModuleManager from './index.js'
import type { ModuleDefinition } from './core/base-protocol.js'
import path from 'node:path'
import fs from 'node:fs'

// 获取模块路径
const CRABOT_ROOT = path.resolve(process.cwd(), '..')
const ADMIN_DIR = path.join(CRABOT_ROOT, 'crabot-admin')
const AGENT_DIR = path.join(CRABOT_ROOT, 'crabot-agent')
const DATA_DIR = process.env.DATA_DIR || path.join(CRABOT_ROOT,
  parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10) > 0
    ? `data-${process.env.CRABOT_PORT_OFFSET}`
    : 'data'
)

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
const PORT_RANGE_END = parseInt(process.env.PORT_RANGE_END || String(19099 + PORT_OFFSET), 10)
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
const CORE_MODULES: Array<ModuleDefinition & Record<string, unknown>> = [
  {
    module_id: 'admin-web',
    module_type: 'admin',
    version: '0.1.0',
    protocol_version: '0.1.0',
    entry: isDev ? 'npx tsx --watch src/main.ts' : 'node dist/main.js',
    cwd: ADMIN_DIR,
    auto_start: isDev || fs.existsSync(path.join(ADMIN_DIR, 'dist', 'main.js')),
    start_priority: 10,
    env: {
      CRABOT_ADMIN_PORT: ADMIN_RPC_PORT,
      CRABOT_ADMIN_WEB_PORT: ADMIN_WEB_PORT,
      CRABOT_MM_ENDPOINT: MM_ENDPOINT,
      CRABOT_MM_PORT: String(PORT),
      DATA_DIR: path.join(DATA_DIR, 'admin'),
    } as Record<string, string>,
  },
  {
    module_id: 'crabot-agent',
    module_type: 'agent',
    version: '0.2.0',
    protocol_version: '0.2.0',
    entry: 'node dist/main.js',
    cwd: AGENT_DIR,
    auto_start: fs.existsSync(path.join(AGENT_DIR, 'dist', 'main.js')),
    start_priority: 20,
    env: {
      CONFIG_PATH: path.join(AGENT_DIR, 'config.yaml'),
      DATA_DIR: path.join(DATA_DIR, 'agent'),
      // 传递 New API token 给 Agent 使用
      NEW_API_TOKEN: process.env.CRABOT_NEW_API_ADMIN_TOKEN || '',
      // 传递 Admin endpoint，用于从 Admin 获取配置
      CRABOT_ADMIN_ENDPOINT: ADMIN_ENDPOINT,
      CRABOT_MM_ENDPOINT: MM_ENDPOINT,
      CRABOT_MM_PORT: String(PORT),
      CRABOT_MODULE_ID: 'crabot-agent',
    } as Record<string, string>,
  },
  {
    module_id: 'memory-default',
    module_type: 'memory',
    version: '0.1.0',
    protocol_version: '0.1.0',
    entry: 'uv run python -m src.main',
    cwd: MEMORY_DIR,
    auto_start: fs.existsSync(path.join(MEMORY_DIR, 'src', 'main.py')),
    start_priority: 15,  // 在 admin(10) 之后启动，确保配置已就绪
    env: {
      CRABOT_MEMORY_DATA_DIR: path.join(DATA_DIR, 'memory'),
      CRABOT_MODULE_MANAGER_URL: MM_ENDPOINT,
      CRABOT_MM_PORT: String(PORT),
      // Admin endpoint，供 Memory 模块启动时 pull 初始配置
      CRABOT_ADMIN_ENDPOINT: ADMIN_ENDPOINT,
      // LLM/Embedding 配置由 Admin 通过 handleStartModuleAdmin 注入
      // 空字符串表示"未配置"，Memory 模块的 is_configured() 会检测到
      CRABOT_LLM_BASE_URL: process.env.LITELLM_BASE_URL || '',
      CRABOT_LLM_API_KEY: process.env.LITELLM_MASTER_KEY || '',
      CRABOT_LLM_MODEL: process.env.CRABOT_LLM_MODEL || '',
      CRABOT_EMBEDDING_BASE_URL: process.env.LITELLM_BASE_URL || '',
      CRABOT_EMBEDDING_API_KEY: process.env.LITELLM_MASTER_KEY || '',
      CRABOT_EMBEDDING_MODEL: process.env.CRABOT_EMBEDDING_MODEL || '',
      CRABOT_EMBEDDING_DIMENSION: process.env.CRABOT_EMBEDDING_DIMENSION || '',
    } as Record<string, string>,
  },
]

// CRABOT_DEV=true 时注册 Vite 前端开发服务器，由 MM 统一管理
if (process.env.CRABOT_DEV === 'true') {
  CORE_MODULES.push({
    module_id: 'vite-dev',
    module_type: 'devtool',
    entry: 'npx vite --port {PORT} --clearScreen false',
    cwd: path.join(ADMIN_DIR, 'web'),
    auto_start: true,
    start_priority: 30,  // Admin(10), Agent(20) 之后
    skip_health_check: true,
    env: {} as Record<string, string>,
  })
}

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
