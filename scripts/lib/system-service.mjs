import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { systemError } from './system-registry.mjs'

const execute = promisify(execFile)
export function systemdAvailable() { return process.platform === 'linux' && fs.existsSync('/run/systemd/system') }
const quoted = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"'
export function renderSystemUserService(installRoot) {
  if (!path.posix.isAbsolute(installRoot) || /[\0\r\n]/.test(installRoot)) throw systemError('共享安装路径不兼容。')
  const command = quoted(path.posix.join(installRoot, 'bin/crabot'))
  return `# Managed by Crabot: per-user launcher; no business credentials.\n[Unit]\nDescription=Crabot shared-server instance\n\n[Service]\nType=exec\nExecStart=${command} _system-service\nRestart=on-failure\nRestartForceExitStatus=42\nRestartPreventExitStatus=64\nRestartSec=2\nKillMode=mixed\nSendSIGKILL=no\nTimeoutStopSec=90\nUMask=0077\nTasksAccounting=yes\n\n[Install]\nWantedBy=default.target\n`
}

export function installSystemUserService(installRoot, directory = '/etc/systemd/user') {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw systemError('服务模板仅Linux管理员可安装。')
  const parent = fs.lstatSync(directory)
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || parent.mode & 0o022) throw systemError('systemd用户服务目录无法核验。')
  const file = path.join(directory, 'crabot.service'), text = renderSystemUserService(installRoot)
  let existing
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022 || stat.size > 65536) throw systemError('已有crabot.service归属无法核验，未覆盖。')
    existing = fs.readFileSync(file, 'utf8')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (existing !== undefined) {
    if (existing !== text) throw systemError('已有自定义crabot.service与受管模板冲突，未覆盖。')
    return
  }
  const temporary = file + '.tmp-' + randomUUID()
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o644, flush: true })
    fs.chmodSync(temporary, 0o644)
    fs.linkSync(temporary, file)
  } finally { fs.rmSync(temporary, { force: true }) }
}

export async function ensureSystemUserManager(entry, run = execute) {
  if (!systemdAvailable() || process.getuid?.() !== 0) throw systemError('此环境没有可用的管理员systemd，请保留既有CLI运行方式。', 'CRABOT_SYSTEMD_UNAVAILABLE')
  const options = { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, cwd: '/', timeout: 30_000, maxBuffer: 65536 }
  try {
    await run('/usr/bin/loginctl', ['enable-linger', entry.user], options)
    await run('/usr/bin/systemctl', ['start', 'user@' + entry.uid + '.service'], options)
  } catch { throw systemError('本人systemd管理器尚未就绪，请管理员检查user@服务及用户总线；业务尚未启动。', 'CRABOT_SYSTEMD_UNAVAILABLE') }
}
