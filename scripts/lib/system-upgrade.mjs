// Shared software replacement. Unlike a batch restart, every instance must be
// stopped and backed up before selection. UID adapters own all employee data I/O.
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateSystemEntries, systemError } from './system-registry.mjs'

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export function validateSystemDeployment({ install_root: installRoot, source, target } = {}) {
  if (typeof installRoot !== 'string' || !path.posix.isAbsolute(installRoot) || path.posix.normalize(installRoot) !== installRoot || /[\0\r\n]/.test(installRoot) || !hash(source?.id) || !hash(target?.id) || source.id === target.id
    || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(source.version ?? '') || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(target.version ?? '')) {
    throw systemError('共享升级来源或目标不兼容。')
  }
}
export function planSystemUpgrade({ installRoot, source, target, instances }) {
  validateSystemDeployment({ install_root: installRoot, source, target })
  validateSystemEntries(instances.map(item => item.entry))
  for (const item of instances) {
    if (!['running', 'stopped'].includes(item.observation?.state)
      || item.observation.state === 'running' && !item.observation.generation
      || item.observation.maintenance) throw systemError('存在启动中、身份未知或数据维护未完成的用户；未停止任何实例。', 'CRABOT_SYSTEM_UPGRADE_NOT_READY')
  }
  return { schema_version: 1, kind: 'upgrade', id: randomUUID(), install_root: installRoot,
    source: structuredClone(source), target: structuredClone(target), instances: structuredClone(instances) }
}

export async function executeSystemUpgrade(plan, operations) {
  const result = { schema_version: 1, id: plan.id, kind: 'upgrade', phase: 'running', stage: 'stopping',
    results: plan.instances.map(({ entry, observation }) => ({ uid: entry.uid, user: entry.user,
      originally_running: observation.state === 'running', stopped: observation.state === 'stopped', stop_dispatched: false, start_dispatched: false, snapshot_dispatched: false,
      migration_dispatched: false, migrated: false, started: false, state: 'pending' })) }
  const save = async () => {
    try { await operations.save(structuredClone(result)) }
    catch (error) { throw systemError('共享维护进度无法写入，未继续执行；保留原记录及保护。', 'CRABOT_SYSTEM_JOURNAL_FAILED') }
  }
  const stage = async (name, uid) => {
    result.stage = name; result.current_uid = uid
    delete result.allow_start
    await save()
  }
  const finish = async () => {
    delete result.current_uid; delete result.allow_start
    result.phase = 'completed'
    result.exit_code = result.results.some(row => row.state !== 'healthy' && row.state !== 'kept_stopped') ? 1 : 0
    await save(); return result
  }
  const entries = new Map(plan.instances.map(item => [item.entry.uid, item]))
  await save()
  let preparationError
  try {
    for (const row of result.results.filter(row => row.originally_running)) {
      row.stop_dispatched = true
      await stage('stop_dispatched', row.uid)
      const item = entries.get(row.uid)
      const stopped = await operations.stop(item.entry, item.observation)
      if (stopped.state !== 'stopped' && !(stopped.state === 'skipped' && stopped.observed_state === 'stopped')) throw systemError('没有确认用户停止。', 'CRABOT_SYSTEM_STOP_UNKNOWN')
      row.stopped = true
      await save()
    }
    for (const row of result.results) {
      row.snapshot_dispatched = true
      await stage('snapshot_dispatched', row.uid)
      row.snapshot = await operations.snapshot(entries.get(row.uid).entry, plan.id)
      if (!row.snapshot || row.snapshot.system_operation_id !== plan.id) throw systemError('备份不属于本次共享维护。')
      await stage('snapshot_ready', row.uid)
    }
    await stage('selection_dispatched')
    await operations.select(plan.source.id, plan.target.id)
    await stage('target_selected')
  } catch (error) {
    if (error.code === 'CRABOT_SYSTEM_JOURNAL_FAILED') throw error
    preparationError = error
  }
  if (preparationError) {
    result.error = { code: preparationError.code ?? 'CRABOT_SYSTEM_UPGRADE_FAILED', message: preparationError.message }
    // A selector rename may have succeeded before its caller failed. Never
    // infer source selection from the thrown error or automatically roll it back.
    if (await operations.selected() !== plan.source.id) {
      result.phase = 'interrupted'; result.stage = 'selection_unsettled'
      delete result.current_uid; delete result.allow_start
      await save(); return { ...result, exit_code: 1 }
    }
    for (const row of result.results) {
      const item = entries.get(row.uid)
      row.state = 'kept_stopped'
      try {
        if (row.snapshot_dispatched) {
          await stage('source_preparation_cancel_dispatched', row.uid)
          await operations.cancelSnapshot(item.entry, plan.id)
        }
        if (row.originally_running && row.stopped) {
          row.start_dispatched = true
          await stage('source_start_dispatched', row.uid)
          result.allow_start = { uid: row.uid, core_id: plan.source.id }; await save()
          const started = await operations.startSource(item.entry)
          if (started.state !== 'started' && !(started.state === 'skipped' && started.observed_state === 'running')) throw systemError('原实例尚未恢复健康。')
          row.state = 'healthy'; row.started = true; row.generation = started.generation
        } else if (row.originally_running || (await operations.observe(item.entry)).state !== 'stopped') row.state = 'unknown'
      } catch (error) {
        if (error.code === 'CRABOT_SYSTEM_JOURNAL_FAILED') throw error
        row.state = 'unknown'; row.error = { code: error.code ?? 'CRABOT_SYSTEM_RESTORE_UNKNOWN', message: error.message }
      }
      await save()
    }
    result.phase = 'completed'; delete result.current_uid; delete result.allow_start
    result.exit_code = 1; await save(); return result
  }
  for (const row of result.results) {
    const item = entries.get(row.uid)
    try {
      row.migration_dispatched = true
      await stage('migration_dispatched', row.uid)
      await operations.migrate(item.entry, row.snapshot)
      row.migrated = true
      await stage('migration_completed', row.uid)
      if (row.originally_running) {
        row.start_dispatched = true
        await stage('target_start_dispatched', row.uid)
        result.allow_start = { uid: row.uid, core_id: plan.target.id }; await save()
        const started = await operations.startTarget(item.entry)
        if (started.state !== 'started' && !(started.state === 'skipped' && started.observed_state === 'running')) throw systemError('目标实例尚未恢复健康。')
        row.state = 'healthy'; row.started = true; row.generation = started.generation
      } else {
        if ((await operations.observe(item.entry)).state !== 'stopped') throw systemError('原停止用户出现非预期运行，未停止新实例。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
        row.state = 'kept_stopped'
      }
    } catch (error) {
      if (error.code === 'CRABOT_SYSTEM_JOURNAL_FAILED') throw error
      row.state = 'unknown'; row.error = { code: error.code ?? 'CRABOT_SYSTEM_MIGRATION_UNKNOWN', message: error.message }
    }
    await save()
  }
  return finish()
}
