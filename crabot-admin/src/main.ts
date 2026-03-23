/**
 * Admin 模块入口
 */

import path from 'node:path'
import AdminModule from './index.js'

// CommonJS 兼容的 __dirname
// 在编译后的 CommonJS 中，__dirname 是自动可用的
// 这里使用 process.cwd() 作为后备
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data')

async function main(): Promise<void> {
  // Admin 模块配置
  // 注意：port 应该由 Module Manager 分配，这里使用环境变量
  const port = parseInt(process.env.CRABOT_ADMIN_PORT ?? '19001', 10)
  const webPort = parseInt(process.env.CRABOT_ADMIN_WEB_PORT ?? '3000', 10)

  const admin = new AdminModule(
    {
      moduleId: 'admin-web',
      moduleType: 'admin',
      version: '0.1.0',
      protocolVersion: '0.1.0',
      port,
      subscriptions: [
        'module_manager.module_started',
        'module_manager.module_stopped',
        'module_manager.module_error',
        'module_manager.module_health_changed',
        'taskstore.task_created',
        'taskstore.task_status_changed',
        'taskstore.task_assigned',
        'taskstore.task_plan_updated',
        'memory.memory_written',
        'memory.memory_updated',
        'memory.memory_deleted',
        'scheduler.schedule_triggered',
        'scheduler.schedule_created',
        'scheduler.schedule_deleted',
        'channel.message_received',
      ],
    },
    {
      web_port: webPort,
      data_dir: dataDir,  // Module Manager 已经设置为 data/admin，不需要再加一层
    }
  )

  // 处理退出信号
  process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, shutting down...')
    admin.stop().then(() => process.exit(0))
  })

  process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down...')
    admin.stop().then(() => process.exit(0))
  })

  try {
    await admin.start()
    await admin.register()
    console.log('Admin module started successfully')
  } catch (error) {
    console.error('Failed to start Admin module:', error)
    process.exit(1)
  }
}

main().catch(console.error)
