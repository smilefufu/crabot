// Only the fixed root caller delegates this entry with a private descriptor.
// All imports that can read employee data happen after setpriv has dropped UID/groups.
import fs from 'node:fs'
import path from 'node:path'
import { userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readSystemUserPermit } from './lib/system-user.mjs'
import { applySystemUserBinding } from './lib/system-context.mjs'
import { controlSystemUser, inspectSystemUser, systemctlForUser } from './lib/system-control.mjs'
import { systemError } from './lib/system-registry.mjs'
import management from './lib/desktop-management.cjs'
import { acquireCliLock, releaseCliLock } from './lib/cli-lock.mjs'
import { systemdAvailable } from './lib/system-service.mjs'
import { stopInstance } from './lib/instance-controller.mjs'
import { inspectInstance } from './lib/instance-runtime.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
console.log = (...args) => console.error(...args)
let lock
try {
  const permit = readSystemUserPermit(), entry = permit.entry, account = userInfo()
  if (process.platform !== 'linux' || account.uid !== entry.uid || account.gid !== entry.gid || account.username !== entry.user
    || account.homedir !== entry.home || process.argv[2] !== permit.action) throw systemError('UID助手与管理员委托身份不一致。')
  applySystemUserBinding(entry)
  process.stdin.setEncoding('utf8')
  let input = '', bytes = 0
  for await (const chunk of process.stdin) { bytes += Buffer.byteLength(chunk); if (bytes > 65536) throw systemError('UID助手输入过大。'); input += chunk }
  input = JSON.parse(input).input
  let result
  if (permit.action === 'prepare') {
    const home = management.ensurePrivateDataRoot(path.join(entry.home, '.crabot'))
    const manifest = path.join(home, 'instance.json')
    if (fs.existsSync(manifest)) {
      const previous = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      if (previous.mode !== 'system' || previous.port_offset !== entry.port_offset || previous.crabot_home !== root) throw systemError('发现旧实例绑定，请先完成兼容转换，未覆盖。')
    }
    const dataDir = management.ensurePrivateDataRoot(entry.data_dir)
    lock = await acquireCliLock(dataDir, 'system-provision')
    if (inspectInstance(dataDir).state !== 'stopped') throw systemError('现有实例尚未停止，未修改开通配置。')
    const { readCredentials, writeCredentials, newCredentialsFromPassword } = await import(new URL('../crabot-admin/dist/credentials.js', import.meta.url))
    const credentials = await readCredentials(path.join(dataDir, 'admin'))
    if (!credentials) {
      if (typeof input?.password !== 'string' || input.password.length < 4 || input.password.length > 4096) throw systemError('请在管理员本地设置至少4字符的浏览器初始密码。')
      await writeCredentials(path.join(dataDir, 'admin'), await newCredentialsFromPassword(input.password, { is_temp: true, changed_via: 'start' }))
    }
    if (!fs.existsSync(manifest)) fs.writeFileSync(manifest, JSON.stringify({ mode: 'system', port_offset: entry.port_offset,
      applied_cluster_version: null, applied_at: new Date().toISOString(), data_dir: dataDir, crabot_home: root }) + '\n', { flag: 'wx', mode: 0o600, flush: true })
    result = { prepared: true, credential_preserved: Boolean(credentials) }
  } else if (permit.action === 'inspect') result = await inspectSystemUser(entry)
  else if (['start', 'stop', 'restart'].includes(permit.action)) result = await controlSystemUser(entry, permit.action, permit.previous, { permit })
  else if (permit.action === 'configure-service') {
    await systemctlForUser(entry, ['daemon-reload'])
    if (entry.autostart) await systemctlForUser(entry, ['enable', 'crabot.service'])
    else await systemctlForUser(entry, ['disable', 'crabot.service'])
    result = { configured: true, autostart: entry.autostart }
  } else if (permit.action === 'disable') {
    if (systemdAvailable()) {
      await controlSystemUser(entry, 'stop', permit.previous, { permit })
      await systemctlForUser(entry, ['disable', 'crabot.service'])
    } else {
      lock = await acquireCliLock(entry.data_dir, 'system-disable-cli')
      await stopInstance(entry.data_dir)
    }
    result = { disabled: true }
  } else throw systemError('UID助手动作不兼容。')
  process.stdout.write(JSON.stringify({ ok: true, result }) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? 'CRABOT_SYSTEM_USER_FAILED', message: error.message }) + '\n')
  process.exitCode = 1
} finally { releaseCliLock(lock) }
