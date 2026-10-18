import fs from 'node:fs'
import path from 'node:path'
import { userInfo } from 'node:os'
import { SystemRegistry, systemError } from './system-registry.mjs'
import cliLocation from './cli-location.cjs'
import { systemUserEnvironment } from './system-user.mjs'

export function ownSystemEntry({ registry = new SystemRegistry(), account = userInfo() } = {}) {
  const entry = registry.read().find(value => value.uid === account.uid)
  if (!entry || !entry.enabled) throw systemError('此用户尚未开通或已停用，请联系管理员运行crabot system user add。', 'CRABOT_SYSTEM_USER_DISABLED')
  if (entry.user !== account.username || entry.gid !== account.gid || entry.home !== account.homedir) throw systemError('系统账号与受管实例绑定不一致，请联系管理员检查。')
  return entry
}

export function applySystemUserBinding(entry, env = process.env) {
  if (env.DATA_DIR && path.resolve(env.DATA_DIR) !== entry.data_dir
    || env.CRABOT_PORT_OFFSET && env.CRABOT_PORT_OFFSET !== String(entry.port_offset)) {
    throw systemError('当前DATA_DIR或端口偏移与管理员绑定冲突，请检查旧shell环境；未操作其他实例。', 'CRABOT_SYSTEM_BINDING_CONFLICT')
  }
  Object.assign(env, systemUserEnvironment(entry))
  return entry
}

export function assertSystemControlAvailable(entry, { directory = '/etc/crabot/system', permit } = {}) {
  const file = path.join(directory, 'maintenance.json')
  let stat
  try { stat = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022 || stat.size > 65536) throw systemError('共享维护状态无法核验，未执行启停。')
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (record.schema_version !== 1 || !Array.isArray(record.targets) || typeof record.id !== 'string') throw systemError('共享维护状态不兼容，未执行启停。')
  if (!record.targets.includes(entry.uid) || record.phase === 'completed' && !record.unsettled?.includes(entry.uid)) return
  if (permit?.operation_id === record.id && permit.entry?.uid === entry.uid && ['start', 'stop', 'restart', 'snapshot', 'migrate', 'cancel-preparation'].includes(permit.action)) return
  throw systemError('管理员维护或批量作业正在进行：' + record.id + '；请用system status查看。', 'CRABOT_SYSTEM_BUSY')
}

export function readSystemBootId() {
  return process.platform === 'linux' ? fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : null
}
export function systemMaintenanceAllowsServiceStart(record, { entry, coreId, bootId, cgroup }) {
  if (record?.schema_version !== 1 || record.phase !== 'running' || record.current_uid !== entry.uid
    || !bootId || record.boot_id !== bootId || !cgroup.split('\n').some(line => line.endsWith('/crabot.service'))) return false
  if (record.operation === 'upgrade') return record.allow_start?.uid === entry.uid && record.allow_start.core_id === coreId
  return ['start', 'restart'].includes(record.operation)
}
export function assertSystemServiceStartAllowed(entry, { root } = {}) {
  const file = '/etc/crabot/system/maintenance.json'
  let allowed = false
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file)
    if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022) && stat.size < 65536) {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'))
      const installation = root ? cliLocation.assertSelectedCli(root) : null
      allowed = systemMaintenanceAllowsServiceStart(record, { entry, coreId: installation?.id,
        bootId: readSystemBootId(), cgroup: fs.readFileSync('/proc/self/cgroup', 'utf8') })
    }
  }
  if (!allowed) assertSystemControlAvailable(entry)
}
