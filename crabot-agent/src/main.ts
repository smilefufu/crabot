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
import { installStdioErrorGuard } from './core/stdio-guard.js'

// 必须是进程里的第一件事：它之后的任何一行日志（含下面的 heap sampler / FDA 提示）在
// stdout/stderr 管道断开时都会以 'error' 事件打到零监听器上 → uncaughtException（见该文件头）。
installStdioErrorGuard()

// The runtime bearer must leave process.env before any diagnostic/helper can spawn a child.
ConfigLoader.captureRuntimeBearer()

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

  // admin 比 agent 只早 spawn 约 1s，但要跑完整个 onStart() 才 listen —— 首次 pull 必然扑空。
  // 退避重试等 admin 就绪；耗尽预算（或全新安装未配置 LLM）后返回降级配置：进程存活、
  // 照常注册，所有执行入口 fail closed，由 UnifiedAgent 退避 pull 自愈（ConfigLoader.loadWithRetry）。
  const config: UnifiedAgentConfig = await ConfigLoader.loadWithRetry(rpcClient, adminEndpoint)

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
    await agent.register(ConfigLoader.getRuntimeBearer())
    // 启动对账放在 register 之后发：它的 fs 扫描 + tmux 子进程会占满 libuv 默认 4 线程池，
    // 而 register 的 getaddrinfo 排在同一个池上——并发跑会把注册拖慢。仍然不 await。
    agent.startManagerStackReconciliation()
    console.log('Unified Agent module started successfully')
    console.log(`- Module ID: ${config.module_id}`)
    console.log(`- Port: ${config.port}`)
    console.log(`- Configured: ${agent.isConfigured()}`)
  } catch (error) {
    console.error('Failed to start Unified Agent module:', error)
    process.exit(1)
  }
}

main().catch(console.error)
