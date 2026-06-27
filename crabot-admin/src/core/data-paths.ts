import path from 'node:path'

/**
 * Admin 模块唯一的数据目录解析入口。
 * DATA_DIR 全局语义 = 顶层；admin 自己的模块级目录走 CRABOT_ADMIN_DATA_DIR
 * （MM 注入，与 CRABOT_AGENT_DATA_DIR / CRABOT_MEMORY_DATA_DIR 对称）。
 * 禁止在 admin 其它地方裸读 process.env.DATA_DIR。
 */
export function getAdminDataDir(): string {
  if (process.env.CRABOT_ADMIN_DATA_DIR) {
    return path.resolve(process.env.CRABOT_ADMIN_DATA_DIR)
  }
  if (process.env.DATA_DIR) {
    return path.resolve(process.env.DATA_DIR, 'admin')
  }
  return path.resolve('./data/admin')
}

/** 顶层 logs 目录（admin 数据目录的兄弟）。模块运行日志落在这里。 */
export function getAdminLogsDir(): string {
  return path.resolve(getAdminDataDir(), '..', 'logs')
}
