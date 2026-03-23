/**
 * Unified Agent 模块入口
 */

import { UnifiedAgent } from './unified-agent.js'
import { ConfigLoader, RpcClient } from './core/index.js'
import type { UnifiedAgentConfig } from './types.js'

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
    console.error(`Failed to load config from Admin: ${message}`)
    process.exit(1)
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
