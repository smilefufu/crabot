// Administrator job journal. Plans contain instance metadata, never passwords or
// business configuration. Persistent intent prevents replay after coordinator loss.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { SystemRegistry, systemError, validateSystemEntries } from './system-registry.mjs'
import { acquireCliLock, releaseCliLock } from './cli-lock.mjs'
import { executeSystemUpgrade, validateSystemDeployment } from './system-upgrade.mjs'
import { readSystemBootId } from './system-context.mjs'
import { executeSystemBatch } from './system-batch.mjs'

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
export class SystemOperationStore {
  constructor(registry = new SystemRegistry()) { this.registry = registry; this.directory = registry.directory }
  initialize() {
    this.registry.initialize()
    const jobs = path.join(this.directory, 'jobs')
    try { fs.mkdirSync(jobs, { mode: 0o700 }); fs.chmodSync(jobs, 0o700) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const stat = fs.lstatSync(jobs)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== this.registry.ownerUid || (stat.mode & 0o777) !== 0o700) throw systemError('管理员作业目录无法核验。')
  }
  file(id) {
    if (!uuid(id)) throw systemError('作业编号不兼容。')
    return path.join(this.directory, 'jobs', id + '.json')
  }
  read(file, privateFile = false) {
    let fd
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.uid !== this.registry.ownerUid || stat.mode & 0o022 || stat.nlink !== 1 || stat.size > 1024 * 1024
        || privateFile && (stat.mode & 0o777) !== 0o600) throw systemError('作业记录权限或格式无法核验。')
      return JSON.parse(fs.readFileSync(fd, 'utf8'))
    } catch (error) { if (error.code === 'ENOENT') return null; throw systemError('作业记录无法核验，未继续操作。') }
    finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  write(file, record, mode) {
    this.registry.authority()
    const temporary = file + '.tmp-' + randomUUID()
    try {
      fs.writeFileSync(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode, flush: true })
      fs.chmodSync(temporary, mode); fs.renameSync(temporary, file)
      const fd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY)
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    } finally { fs.rmSync(temporary, { force: true }) }
  }
  maintenance() {
    const record = this.read(path.join(this.directory, 'maintenance.json'))
    if (record && (record.schema_version !== 1 || !uuid(record.id) || !['prepared', 'running', 'completed', 'interrupted'].includes(record.phase)
      || !Array.isArray(record.targets) || !Array.isArray(record.unsettled))) throw systemError('共享维护记录不兼容，未继续操作。')
    return record
  }
  completion(id) {
    const record = this.read(this.file(id), true)
    if (!record || !['completed', 'interrupted'].includes(record.phase)) return null
    const maintenance = this.maintenance()
    if (maintenance?.id !== id || maintenance.phase !== record.phase) throw systemError('作业完成记录未能完整持久化；保留维护保护，请检查system status。', 'CRABOT_SYSTEM_JOURNAL_FAILED')
    return record.progress
  }
  assertIdle() {
    const record = this.maintenance()
    if (record && (record.phase !== 'completed' || record.unsettled.length)) throw systemError('共享作业尚未安全结束：' + record.id + '；请用system status检查。', 'CRABOT_SYSTEM_BUSY')
  }
  async prepare(plan) {
    this.initialize()
    const lock = await acquireCliLock(this.directory, 'system-prepare-job')
    try {
      this.assertIdle()
      const upgrade = plan?.kind === 'upgrade'
      if (!uuid(plan?.id) || !upgrade && !['start', 'stop', 'restart'].includes(plan.action)) throw systemError('共享操作计划不兼容。')
      if (upgrade) validateSystemDeployment(plan)
      const items = upgrade ? plan.instances : plan.items
      validateSystemEntries(items.map(item => item.entry))
      const entries = this.registry.read()
      if (upgrade && entries.filter(entry => entry.enabled).length !== items.length) throw systemError('确认期间已开通用户集合变化，请重新检查。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
      for (const item of items) if (!entries.some(entry => entry.enabled && JSON.stringify(entry) === JSON.stringify(item.entry))) {
        throw systemError('确认期间用户绑定发生变化，请重新检查。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
      }
      const file = this.file(plan.id)
      if (fs.existsSync(file)) throw systemError('该作业已存在，未重复执行。')
      const record = { schema_version: 1, plan, phase: 'prepared', progress: null }
      this.write(file, record, 0o600)
      this.write(path.join(this.directory, 'maintenance.json'), { schema_version: 1, id: plan.id, operation: upgrade ? 'upgrade' : plan.action,
        phase: 'prepared', targets: items.map(item => item.entry.uid), unsettled: [] }, 0o644)
      return record
    } finally { releaseCliLock(lock) }
  }
  async run(id, { apply, upgrade, progress = () => {} }) {
    this.initialize()
    const lock = await acquireCliLock(this.directory, 'system-job')
    let record
    try {
      record = this.read(this.file(id), true)
      const maintenance = this.maintenance()
      if (!record || record.phase !== 'prepared' || maintenance?.id !== id || maintenance.phase !== 'prepared') throw systemError('该作业已开始或状态未知，未自动重放。', 'CRABOT_SYSTEM_OPERATION_INTERRUPTED')
      record.phase = 'running'
      this.write(this.file(id), record, 0o600)
      const isUpgrade = record.plan.kind === 'upgrade'
      const execute = isUpgrade ? executeSystemUpgrade : executeSystemBatch
      const bootId = readSystemBootId()
      const result = await execute(record.plan, { ...(isUpgrade ? upgrade : { apply, progress }), save: async value => {
        record.progress = value
        record.phase = value.phase
        this.write(this.file(id), record, 0o600)
        this.write(path.join(this.directory, 'maintenance.json'), { schema_version: 1, id, operation: isUpgrade ? 'upgrade' : record.plan.action, boot_id: bootId,
          phase: value.phase, targets: (isUpgrade ? record.plan.instances : record.plan.items).map(item => item.entry.uid), current_uid: value.current_uid,
          allow_start: value.allow_start, stage: value.stage,
          unsettled: value.results.filter(row => value.phase === 'interrupted' || row.state === 'unknown' || row.code === 'CRABOT_SYSTEM_USER_UNKNOWN').map(row => row.uid) }, 0o644)
      } })
      return result
    } finally { releaseCliLock(lock) }
  }
}
