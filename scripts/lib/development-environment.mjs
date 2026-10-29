import { resolve, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

export const developmentPorts = Object.freeze({ mm: 29000, admin: 29001, web: 13000, temporary: 29099, vite: 5173 })

// Project commands never inherit the caller's production instance or credentials.
export function developmentEnvironment(root, source = process.env) {
  root = resolve(root)
  if (existsSync(join(root, 'core-release.json')) || existsSync(join(root, 'desktop-host.json'))) throw new Error('请在源码工作副本运行开发命令，不能修改已安装的发行程序。')
  const env = { ...source }
  for (const key of Object.keys(env)) {
    if (/^CRABOT_(?:ADMIN_|AGENT_|MEMORY_|MM_|DESKTOP_|PRODUCT_|RUNTIME_|INSTANCE_|SUPERVISOR_|CLI_LOCK_|SYSTEM_|JWT_)/.test(key)
      || ['DATA_DIR', 'WORKSPACE_DIR', 'WORKER_WORKSPACES_DIR', 'MEMORY_DIR', 'PORT', 'PORT_RANGE_START', 'PORT_RANGE_END', 'CONFIG_PATH'].includes(key)) delete env[key]
  }
  return { ...env, CRABOT_DEV: 'true', CRABOT_HOME: root, DATA_DIR: join(root, 'data'),
    CRABOT_PORT_OFFSET: '10000', PORT: '29000', PORT_RANGE_START: '29002', PORT_RANGE_END: '29098',
    CRABOT_MM_PORT: '29000', CRABOT_MM_ENDPOINT: 'http://127.0.0.1:29000',
    CRABOT_ADMIN_PORT: '29001', CRABOT_ADMIN_WEB_PORT: '13000', CRABOT_ADMIN_WEB_HOST: '127.0.0.1',
    CRABOT_TMP_PAGE_PORT: '29099', CRABOT_PRODUCT_REQUIRED: '0',
    CRABOT_ADMIN_PASSWORD: 'admin123', CRABOT_ORPHAN_RECOVERY_INTERACTIVE: '0' }
}

export function isDevelopmentTree(root, source = process.env) {
  if (source.CRABOT_DEV !== 'true' || source.CRABOT_PRODUCT_REQUIRED === '1'
    || existsSync(join(root, 'core-release.json')) || existsSync(join(root, 'desktop-host.json'))) return false
  try { return JSON.parse(readFileSync(join(root, 'crabot-desktop/package.json'), 'utf8')).crabotDesktopDevelopment === true }
  catch { return false }
}
