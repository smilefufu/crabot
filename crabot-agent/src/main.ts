/**
 * Unified Agent 模块入口
 */

import fs from 'node:fs'
import path from 'node:path'
import { UnifiedAgent } from './unified-agent.js'
import { RpcClient } from 'crabot-shared'
import { ConfigLoader } from './core/config-loader.js'
import { startHeapSampler } from './diagnostics/heap-sampler.js'
import { checkFdaIfEnabled } from './engine/tools/fda-check.js'
import type { UnifiedAgentConfig } from './types.js'
import { getAgentDataDir } from './core/data-paths.js'

startHeapSampler({ intervalMs: 30_000 })

// macOS：用户若开启 CRABOT_ENABLE_FDA 但未真正授予「完全磁盘访问权限」，
// 这里给出 CLI 提示并 best-effort 打开系统设置面板。非 darwin / 未开启时静默。
checkFdaIfEnabled((msg) => console.log(msg))

// 未捕获错误兜底：写到 fatal.log 并退出（让 MM 看到 code≠0 → status=error）
// 此前 agent 静默猝死无栈，是因为 process.on('unhandledRejection'/'uncaughtException') 缺失
const fatalLogPath = path.join(getAgentDataDir(), 'fatal.log')
function writeFatal(kind: string, err: unknown, extra?: Record<string, unknown>): void {
  const ts = new Date().toISOString()
  const stack = err instanceof Error ? (err.stack ?? err.message) : String(err)
  const meta = extra ? ` ${JSON.stringify(extra)}` : ''
  const line = `[${ts}] [${kind}]${meta}\n${stack}\n\n`
  try {
    fs.mkdirSync(path.dirname(fatalLogPath), { recursive: true })
    fs.appendFileSync(fatalLogPath, line, 'utf-8')
  } catch {
    // 写盘失败（如 ENOSPC）也别挡 stderr 输出
  }
  try { process.stderr.write(line) } catch { /* ignore */ }
}

process.on('uncaughtException', (err, origin) => {
  writeFatal('uncaughtException', err, { origin })
  // 异常已落盘，主动退出让 MM 把状态置 error
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  writeFatal('unhandledRejection', reason, { promise: String(promise) })
  process.exit(1)
})

async function main(): Promise<void> {
  // 初始化 RpcClient（用于从 Admin 获取配置）
  const mmEndpoint = process.env.CRABOT_MM_ENDPOINT || 'http://localhost:19000'
  const rpcClient = new RpcClient(parseInt(mmEndpoint.split(':').pop() || '19000', 10))

  // 从 Admin 加载配置（唯一来源）
  const adminEndpoint = process.env.CRABOT_ADMIN_ENDPOINT

  let config: UnifiedAgentConfig
  try {
    config = await ConfigLoader.load('', rpcClient, adminEndpoint)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Failed to load config from Admin: ${message}`)
    console.warn('Starting in unconfigured mode, waiting for config push from Admin...')
    config = ConfigLoader.createUnconfiguredConfig()
  }

  // Module Manager 会通过环境变量分配端口，覆盖配置文件中的端口
  if (process.env.Crabot_PORT) {
    config.port = parseInt(process.env.Crabot_PORT, 10)
  }

  // Module Manager 会通过环境变量传递模块 ID
  if (process.env.Crabot_MODULE_ID) {
    config.module_id = process.env.Crabot_MODULE_ID
  }

  // 移除启动时的 API Key 验证，允许启动但处于未就绪状态
  // const mainModelConfig = config.agent_config?.model_config?.default
  // if (!mainModelConfig || !mainModelConfig.apikey) {
  //   console.error('LLM API key is required. Check Admin global config.')
  //   process.exit(1)
  // }

  // 创建 UnifiedAgent 实例
  const agent = new UnifiedAgent(config)

  // 处理退出信号
  process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, shutting down...')
    agent.stop().then(() => process.exit(0))
  })

  process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down...')
    agent.stop().then(() => process.exit(0))
  })

  try {
    await agent.start()
    await agent.register()
    console.log('Unified Agent module started successfully')
    console.log(`- Module ID: ${config.module_id}`)
    console.log(`- Port: ${config.port}`)
    console.log(`- Roles: ${config.agent_config?.roles.join(', ') || 'orchestration only'}`)
    console.log(`- Configured: ${agent.isConfigured()}`)
  } catch (error) {
    console.error('Failed to start Unified Agent module:', error)
    process.exit(1)
  }
}

main().catch(console.error)
