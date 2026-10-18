// Only the fixed root caller delegates this entry with a private descriptor.
// All imports that can read employee data happen after setpriv has dropped UID/groups.
import fs from 'node:fs'
import path from 'node:path'
import { userInfo } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readSystemUserPermit, systemUserEnvironment } from './lib/system-user.mjs'
import { applySystemUserBinding, assertSystemControlAvailable } from './lib/system-context.mjs'
import { controlSystemUser, inspectSystemUser, systemctlForUser } from './lib/system-control.mjs'
import { systemError } from './lib/system-registry.mjs'
import management from './lib/desktop-management.cjs'
import { acquireCliLock, releaseCliLock } from './lib/cli-lock.mjs'
import { systemdAvailable } from './lib/system-service.mjs'
import { stopInstance } from './lib/instance-controller.mjs'
import { inspectInstance } from './lib/instance-runtime.mjs'
import { openSystemUserMaintenanceLog } from './lib/system-user-diagnostics.mjs'
import { maintainSystemUser } from './lib/system-user-upgrade.mjs'
import cliLocation from './lib/cli-location.cjs'
import { validateSystemDeployment } from './lib/system-upgrade.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const reply = frame => fs.writeFileSync(4, JSON.stringify(frame) + '\n')
let lock, diagnosticEntry, outputFd
try {
  const permit = readSystemUserPermit(), entry = permit.entry, account = userInfo()
  if (process.platform !== 'linux' || account.uid !== entry.uid || account.gid !== entry.gid || account.username !== entry.user
    || account.homedir !== entry.home || process.argv[2] !== permit.action) throw systemError('UID助手与管理员委托身份不一致。')
  applySystemUserBinding(entry)
  diagnosticEntry = entry
  process.stdin.setEncoding('utf8')
  let input = '', bytes = 0
  for await (const chunk of process.stdin) { bytes += Buffer.byteLength(chunk); if (bytes > 65536) throw systemError('UID助手输入过大。'); input += chunk }
  input = JSON.parse(input).input
  if (!['prepare', 'verify-provision', 'configure-service'].includes(permit.action)) management.requirePrivateDataRoot(entry.data_dir)
  let result
  if (permit.action === 'prepare' || permit.action === 'verify-provision') {
    const homePath = path.join(entry.home, '.crabot')
    let home
    if (fs.existsSync(homePath)) {
      const parent = fs.lstatSync(homePath)
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== entry.uid || parent.mode & 0o7022
        || (parent.mode & 0o700) !== 0o700 || fs.realpathSync(homePath) !== homePath) throw systemError('本人Crabot清单父目录无法核验，未修改。')
      home = homePath
    } else {
      if (permit.action === 'verify-provision') throw systemError('原开通清单目录缺失，未重新初始化；请检查本人保留数据。')
      home = management.ensurePrivateDataRoot(homePath)
    }
    const manifest = path.join(home, 'instance.json'), existing = fs.existsSync(manifest)
    if (existing) {
      const previous = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      const installation = cliLocation.locateCliInstallation(root)
      const previousInstallation = typeof previous.crabot_home === 'string' ? cliLocation.locateCliInstallation(previous.crabot_home) : null
      if (previous.mode !== 'system' || previous.port_offset !== entry.port_offset || !installation || previousInstallation?.root !== installation.root) throw systemError('发现旧实例绑定，请先完成兼容转换，未覆盖。')
    } else if (permit.action === 'verify-provision') throw systemError('原开通绑定缺失，未重新初始化；请检查本人保留数据。')
    const dataDir = existing || permit.action === 'verify-provision' ? management.requirePrivateDataRoot(entry.data_dir) : management.ensurePrivateDataRoot(entry.data_dir)
    lock = await acquireCliLock(dataDir, 'system-provision')
    if (inspectInstance(dataDir).state !== 'stopped') throw systemError('现有实例尚未停止，未修改开通配置。')
    const { readCredentials, writeCredentials, newCredentialsFromPassword } = await import(new URL('../crabot-admin/dist/credentials.js', import.meta.url))
    const credentials = await readCredentials(path.join(dataDir, 'admin'))
    if (!credentials) {
      if (existing || permit.action === 'verify-provision') throw systemError('原浏览器凭据缺失，未重置；请检查本人诊断和备份。')
      if (typeof input?.password !== 'string' || input.password.length < 4 || input.password.length > 4096) throw systemError('请在管理员本地设置至少4字符的浏览器初始密码。')
      await writeCredentials(path.join(dataDir, 'admin'), await newCredentialsFromPassword(input.password, { is_temp: true, changed_via: 'start' }))
    }
    if (!existing) fs.writeFileSync(manifest, JSON.stringify({ mode: 'system', port_offset: entry.port_offset,
      applied_cluster_version: null, applied_at: new Date().toISOString(), data_dir: dataDir, crabot_home: root }) + '\n', { flag: 'wx', mode: 0o600, flush: true })
    result = { prepared: true, credential_preserved: Boolean(credentials) }
  } else if (['snapshot', 'migrate', 'cancel-preparation', 'check-migration'].includes(permit.action)) {
    validateSystemDeployment(permit.deployment)
    assertSystemControlAvailable(entry, { permit })
    if (permit.action === 'migrate') {
      outputFd = openSystemUserMaintenanceLog(entry)
    }
    result = await maintainSystemUser(entry, { action: permit.action, deployment: permit.deployment,
      operationId: permit.operation_id, snapshot: permit.snapshot, env: systemUserEnvironment(entry), outputFd })
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
      const dataDir = management.requirePrivateDataRoot(entry.data_dir)
      lock = await acquireCliLock(dataDir, 'system-disable-cli')
      await stopInstance(dataDir)
    }
    result = { disabled: true }
  } else throw systemError('UID助手动作不兼容。')
  reply({ ok: true, result })
} catch (error) {
  let diagnostic = false
  if (diagnosticEntry) {
    let fd
    try {
      fd = openSystemUserMaintenanceLog(diagnosticEntry)
      const stat = fs.fstatSync(fd)
      if (stat.uid === diagnosticEntry.uid && stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600) {
        fs.writeSync(fd, new Date().toISOString() + ' ' + (error.stack ?? 'Unknown system operation failure') + '\n'); diagnostic = true
      }
    } catch {} finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  const controlled = typeof error.code === 'string' && error.code.startsWith('CRABOT_')
  reply({ ok: false, code: controlled ? error.code : 'CRABOT_SYSTEM_USER_FAILED',
    message: controlled ? error.message : '员工实例操作未完成，请检查本人诊断日志。', diagnostic_available: diagnostic })
  process.exitCode = 1
} finally { if (outputFd !== undefined) fs.closeSync(outputFd); releaseCliLock(lock) }
