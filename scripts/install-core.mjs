// Executed by this archive's bundled Node, never by a host package manager.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { installStandaloneCli } from './lib/standalone-cli-install.mjs'
import { resolveCliDataDir } from './lib/instance.mjs'
import identity from './lib/process-identity.cjs'
import { notifyCliPathChange } from './lib/cli-path-notification.mjs'
const options = new Map(process.argv.slice(2).map(value => { const split = value.indexOf('='); return [value.slice(0, split), value.slice(split + 1)] }))
if (!options.get('--install-root') || !['user', 'system'].includes(options.get('--scope'))) throw new Error('Expected --install-root=<directory> --scope=user|system')
try {
  const result = await installStandaloneCli({ sourceRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    installRoot: options.get('--install-root'), scope: options.get('--scope'),
    dataDir: options.get('--scope') === 'user' ? resolveCliDataDir({ homeDir: path.join(homedir(), '.crabot') }) : undefined })
  if (process.platform === 'win32') {
    const previous = identity.readUserPath()
    identity.appendUserPathDirectory(path.dirname(result.command), previous)
    if (!await notifyCliPathChange(result.coreRoot)) console.warn('环境通知尚未完成；新终端若仍未识别命令，请注销并重新登录。')
  }
  console.log('Crabot 内置核心已安装。服务尚未启动；使用 crabot start 完成实例初始化。')
  console.log('Core version: ' + result.version)
} catch (error) { console.error('[crabot] ' + error.message); process.exitCode = 1 }
