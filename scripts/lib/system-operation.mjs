// Administrator job journal. Plans contain instance metadata, never passwords or
// business configuration. Persistent intent prevents replay after coordinator loss.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { SystemRegistry, systemError, validateSystemEntries } from './system-registry.mjs'
import { acquireCliLock, releaseCliLock } from './cli-lock.mjs'
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
  assertIdle() {
    const record = this.maintenance()
    if (record && (record.phase !== 'completed' || record.unsettled.length)) throw systemError('共享作业尚未安全结束：' + record.id + '；请用system status检查。', 'CRABOT_SYSTEM_BUSY')
  }
  async prepare(plan) {
    this.initialize()
    const lock = await acquireCliLock(this.directory, 'system-prepare-job')
    try {
      this.assertIdle()
      if (!uuid(plan?.id) || !['start', 'stop', 'restart'].includes(plan.action)) throw systemError('共享操作计划不兼容。')
      validateSystemEntries(plan.items.map(item => item.entry))
      const entries = this.registry.read()
      for (const item of plan.items) if (!entries.some(entry => entry.enabled && JSON.stringify(entry) === JSON.stringify(item.entry))) {
        throw systemError('确认期间用户绑定发生变化，请重新检查。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
      }
      const file = this.file(plan.id)
      if (fs.existsSync(file)) throw systemError('该作业已存在，未重复执行。')
      const record = { schema_version: 1, plan, phase: 'prepared', progress: null }
      this.write(file, record, 0o600)
      this.write(path.join(this.directory, 'maintenance.json'), { schema_version: 1, id: plan.id, operation: plan.action,
        phase: 'prepared', targets: plan.items.map(item => item.entry.uid), unsettled: [] }, 0o644)
      return record
    } finally { releaseCliLock(lock) }
  }
  async run(id, { apply, progress = () => {} }) {
    this.initialize()
    const lock = await acquireCliLock(this.directory, 'system-job')
    let record
    try {
      record = this.read(this.file(id), true)
      const maintenance = this.maintenance()
      if (!record || record.phase !== 'prepared' || maintenance?.id !== id || maintenance.phase !== 'prepared') throw systemError('该作业已开始或状态未知，未自动重放。', 'CRABOT_SYSTEM_OPERATION_INTERRUPTED')
      record.phase = 'running'
      this.write(this.file(id), record, 0o600)
      const result = await executeSystemBatch(record.plan, { apply, progress, save: async value => {
        record.progress = value
        record.phase = value.phase
        this.write(this.file(id), record, 0o600)
        this.write(path.join(this.directory, 'maintenance.json'), { schema_version: 1, id, operation: record.plan.action,
          phase: value.phase, targets: record.plan.items.map(item => item.entry.uid), current_uid: value.current_uid,
          unsettled: value.results.filter(row => row.state === 'unknown' || row.code === 'CRABOT_SYSTEM_USER_UNKNOWN').map(row => row.uid) }, 0o644)
      } })
      return result
    } finally { releaseCliLock(lock) }
  }
}
