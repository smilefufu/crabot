// Administrator job journal. Plans contain instance metadata, never passwords or
// business configuration. Persistent intent prevents replay after coordinator loss.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { SystemRegistry, systemError, validateSystemEntries } from './system-registry.mjs'
import { acquireCliLock, releaseCliLock } from './cli-lock.mjs'
import { executeSystemUpgrade, validateSystemDeployment } from './system-upgrade.mjs'
import { readSystemBootId } from './system-context.mjs'
import { executeSystemRecovery, systemRecoveryOptions } from './system-recovery.mjs'
import { assertCoordinatorStopped } from './system-coordinator.mjs'
import { executeSystemBatch } from './system-batch.mjs'
import { executeSystemConversion, validateSystemConversionPlan } from './system-conversion.mjs'

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
    if (record && (record.schema_version !== 1 || !uuid(record.id) || !['prepared', 'running', 'completed', 'interrupted', 'recovery_prepared'].includes(record.phase)
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
      const upgrade = plan?.kind === 'upgrade', conversion = plan?.kind === 'conversion'
      if (!uuid(plan?.id) || plan.kind !== undefined && !upgrade && !conversion
        || !upgrade && !conversion && !['start', 'stop', 'restart'].includes(plan.action)) throw systemError('共享操作计划不兼容。')
      if (upgrade) validateSystemDeployment(plan)
      if (conversion) validateSystemConversionPlan(plan)
      const items = upgrade || conversion ? plan.instances : plan.items
      validateSystemEntries(items.map(item => item.entry))
      const entries = this.registry.read()
      if (conversion) {
        if (entries.length) throw systemError('已有受管用户，未将另一份旧部署混入注册表。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
        for (const item of items) this.registry.verifyAccount(item.entry)
      } else {
        if (upgrade && entries.filter(entry => entry.enabled).length !== items.length) throw systemError('确认期间已开通用户集合变化，请重新检查。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
        for (const item of items) if (!entries.some(entry => entry.enabled && JSON.stringify(entry) === JSON.stringify(item.entry))) {
          throw systemError('确认期间用户绑定发生变化，请重新检查。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
        }
      }
      const file = this.file(plan.id)
      if (fs.existsSync(file)) throw systemError('该作业已存在，未重复执行。')
      const record = { schema_version: 1, plan, phase: 'prepared', progress: null }
      this.write(file, record, 0o600)
      this.write(path.join(this.directory, 'maintenance.json'), { schema_version: 1, id: plan.id, operation: conversion ? 'conversion' : upgrade ? 'upgrade' : plan.action,
        phase: 'prepared', targets: items.map(item => item.entry.uid), unsettled: [] }, 0o644)
      return record
    } finally { releaseCliLock(lock) }
  }
  async run(id, { apply, upgrade, conversion, progress = () => {} }) {
    this.initialize()
    const lock = await acquireCliLock(this.directory, 'system-job')
    let record
    try {
      record = this.read(this.file(id), true)
      const maintenance = this.maintenance()
      if (!record || record.phase !== 'prepared' || maintenance?.id !== id || maintenance.phase !== 'prepared') throw systemError('该作业已开始或状态未知，未自动重放。', 'CRABOT_SYSTEM_OPERATION_INTERRUPTED')
      const isUpgrade = record.plan.kind === 'upgrade', isConversion = record.plan.kind === 'conversion'
      if (isConversion) {
        validateSystemConversionPlan(record.plan)
        if (!conversion || typeof conversion.fence !== 'function') throw systemError('旧共享转换要求专用协调适配器，未派发动作。')
        if (this.registry.read().length) throw systemError('受管注册表已变化，未开始旧部署转换。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
        for (const item of record.plan.instances) this.registry.verifyAccount(item.entry)
      } else if (record.plan.kind !== undefined && !isUpgrade) throw systemError('共享操作种类不兼容。')
      record.phase = 'running'
      record.boot_id = readSystemBootId()
      this.write(this.file(id), record, 0o600)
      const execute = isConversion ? executeSystemConversion : isUpgrade ? executeSystemUpgrade : executeSystemBatch
      const result = await execute(record.plan, { ...(isConversion ? conversion : isUpgrade ? upgrade : { apply, progress }),
        save: async value => this.persistProgress(record, value) })
      return result
    } finally { releaseCliLock(lock) }
  }
  persistProgress(record, value) {
    record.progress = value; record.phase = value.phase
    this.write(this.file(record.plan.id), record, 0o600)
    const upgrade = record.plan.kind === 'upgrade', conversion = record.plan.kind === 'conversion'
    this.write(path.join(this.directory, 'maintenance.json'), { schema_version: 1, id: record.plan.id,
      operation: conversion ? 'conversion' : upgrade ? 'upgrade' : record.plan.action, boot_id: record.boot_id, recovery_id: record.recovery?.id,
      phase: value.phase, targets: (upgrade || conversion ? record.plan.instances : record.plan.items).map(item => item.entry.uid),
      current_uid: value.current_uid, allow_start: value.allow_start, stage: value.stage,
      unsettled: value.results.filter(row => value.phase === 'interrupted' || row.state === 'unknown'
        || row.code === 'CRABOT_SYSTEM_USER_UNKNOWN').map(row => row.uid) }, 0o644)
  }
  async prepareRecovery(id, mode, { checkCoordinator = assertCoordinatorStopped } = {}) {
    if (!['continue', 'cancel'].includes(mode)) throw systemError('恢复方式不兼容。')
    this.initialize()
    const lock = await acquireCliLock(this.directory, 'system-prepare-recovery')
    try {
      const record = this.read(this.file(id), true), maintenance = this.maintenance()
      if (!record || maintenance?.id !== id) throw systemError('此作业不再持有当前维护保护，未修改其他作业。')
      if (record.plan.kind === 'conversion') systemRecoveryOptions(record.plan, record.progress)
      await checkCoordinator(record)
      const items = record.plan.instances ?? record.plan.items, entries = this.registry.read()
      for (const item of items) if (!entries.some(entry => entry.enabled && JSON.stringify(entry) === JSON.stringify(item.entry))) throw systemError('恢复期间用户绑定变化，未执行。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
      if (record.phase === 'completed' && maintenance.phase === 'completed' && !maintenance.unsettled.length) return null
      const attempt = randomUUID(), checkpoint = path.join(this.directory, 'jobs', attempt + '.checkpoint.json')
      this.write(checkpoint, { schema_version: 1, operation_id: id, attempt_id: attempt, previous: record }, 0o600)
      record.recovery = { id: attempt, mode, base_progress: record.progress,
        previous_attempt_id: record.recovery?.id ?? null }
      record.phase = 'recovery_prepared'; record.boot_id = readSystemBootId()
      this.write(this.file(id), record, 0o600)
      this.write(path.join(this.directory, 'maintenance.json'), { schema_version: 1, id,
        operation: record.plan.kind === 'upgrade' ? 'upgrade' : record.plan.action,
        phase: 'recovery_prepared', targets: items.map(item => item.entry.uid), unsettled: [], recovery_id: attempt }, 0o644)
      return record
    } finally { releaseCliLock(lock) }
  }
  async runRecovery(id, attempt, operations) {
    this.initialize()
    const lock = await acquireCliLock(this.directory, 'system-recovery-job')
    try {
      const record = this.read(this.file(id), true), maintenance = this.maintenance()
      if (!record || record.phase !== 'recovery_prepared' || record.recovery?.id !== attempt || maintenance?.id !== id
        || maintenance.phase !== 'recovery_prepared' || maintenance.recovery_id !== attempt) throw systemError('恢复已经开始或阶段未知，未重复执行。', 'CRABOT_SYSTEM_OPERATION_INTERRUPTED')
      if (record.plan.kind === 'conversion') systemRecoveryOptions(record.plan, record.recovery.base_progress)
      record.phase = 'running'; record.boot_id = readSystemBootId()
      this.write(this.file(id), record, 0o600)
      return await executeSystemRecovery(record.plan, record.recovery.base_progress, { mode: record.recovery.mode,
        operations: { ...operations, save: async value => this.persistProgress(record, value) } })
    } finally { releaseCliLock(lock) }
  }

}
