// A completed data/configuration phase needs only ordinary target observation
// and unissued startup, after the UID verifies its original data and backup.
// No migration, backup creation or source-start permit is minted.
import { validateSystemConversionPlan } from './system-conversion.mjs'
import { systemError } from './system-registry.mjs'
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const fail = () => { throw systemError('旧转换尚无完整的数据迁移、注册与服务配置回执，需专用阶段核对；未重放未知动作。', 'CRABOT_SYSTEM_CONVERSION_RECOVERY_REQUIRED') }
function receipt(value, plan) {
  return value && Object.keys(value).length === 4 && uuid(value.id) && value.system_operation_id === plan.id && value.target_id === plan.target.id
    && value.backup && Object.keys(value.backup).length === 2 && uuid(value.backup.id) && /^[a-f0-9]{64}$/.test(value.backup.sha256)
}
export function systemConversionRecoveryOptions(plan, prior) {
  validateSystemConversionPlan(plan)
  if (prior?.schema_version !== 1 || prior.kind !== 'conversion' || prior.id !== plan.id || !uuid(prior.source_fence_id)
    || !['running', 'interrupted', 'completed'].includes(prior.phase) || !Array.isArray(prior.results) || prior.results.length !== plan.instances.length) fail()
  for (let index = 0; index < plan.instances.length; index++) {
    const { entry, observation } = plan.instances[index], row = prior.results[index]
    if (row.uid !== entry.uid || row.user !== entry.user || row.originally_running !== (observation.runtime_state === 'running')
      || typeof row.resume_required !== 'boolean' || row.resume_required && !row.originally_running
      || row.originally_running && row.stop_dispatched !== true
      || row.stopped !== true || row.snapshot_dispatched !== true || !receipt(row.snapshot, plan)
      || row.migration_dispatched !== true || row.migrated !== true || row.registration_dispatched !== true || row.registered !== true || row.configured !== true
      || row.start_dispatched !== undefined && typeof row.start_dispatched !== 'boolean' || row.started !== undefined && typeof row.started !== 'boolean'
      || row.started === true && row.start_dispatched !== true
      || !['pending', 'unknown', 'healthy', 'kept_stopped', 'observed_running', 'observed_stopped'].includes(row.state)) fail()
  }
  return { continue: true, cancel: true }
}
function targetObservation(plan, value) {
  if (!value || value.maintenance || !(value.state === 'stopped' && value.generation === null
    || value.state === 'running' && value.ready === true && value.core_id === plan.target.id && value.core_version === plan.target.version
      && typeof value.generation === 'string' && value.generation.length > 0 && value.generation.length < 256)) {
    throw systemError('目标实例、版本或数据维护状态尚未核实，未重发启动。', 'CRABOT_SYSTEM_RECOVERY_UNKNOWN')
  }
  return value
}
export async function executeSystemConversionRecovery(plan, prior, { mode, operations }) {
  systemConversionRecoveryOptions(plan, prior)
  if (!['continue', 'cancel'].includes(mode) || typeof operations.verify !== 'function'
    || typeof operations.verifyTargetData !== 'function' || typeof operations.observeTarget !== 'function' || typeof operations.startTarget !== 'function' || typeof operations.save !== 'function') fail()
  const result = { ...structuredClone(prior), phase: 'running', recovery_mode: mode, stage: 'target_recovery_observing',
    results: prior.results.map(row => ({ ...structuredClone(row), state: 'pending' })) }
  delete result.allow_start; delete result.current_uid; delete result.error; delete result.exit_code
  const save = async () => {
    try { await operations.save(structuredClone(result)) }
    catch { throw systemError('恢复进度无法写入，未继续派发，保护和原记录已保留。', 'CRABOT_SYSTEM_JOURNAL_FAILED') }
  }
  const stage = async (name, uid) => { result.stage = name; result.current_uid = uid; delete result.allow_start; await save() }
  await save()
  for (let index = 0; index < plan.instances.length; index++) {
    const { entry } = plan.instances[index], row = result.results[index], previous = prior.results[index]
    delete row.error; delete row.message; delete row.cancelled; delete row.original_action_unknown
    try {
      await stage('target_recovery_observing', entry.uid)
      await operations.verify()
      const data = await operations.verifyTargetData(entry)
      if (!data || Object.keys(data).length !== 2 || data.verified !== true || data.service_started !== false) {
        throw systemError('目标实例的数据和备份尚未核实，未派发启动。', 'CRABOT_SYSTEM_RECOVERY_UNKNOWN')
      }
      const current = targetObservation(plan, await operations.observeTarget(entry))
      if (previous.start_dispatched && !previous.started) {
        row.original_action_unknown = true
        row.message = '已核对当前状态，原启动回执未知；未重放。'
      }
      const unissued = previous.resume_required && !previous.start_dispatched && !previous.started
      if (mode === 'continue' && unissued && current.state === 'stopped') {
        row.start_dispatched = true; await stage('target_start_dispatched', entry.uid)
        result.allow_start = { uid: entry.uid, core_id: plan.target.id }; await save()
        await operations.verify()
        const started = await operations.startTarget(entry, current)
        const observed = targetObservation(plan, await operations.observeTarget(entry))
        if (started?.state !== 'started' || observed.state !== 'running' || observed.generation !== started.generation) {
          throw systemError('本次目标启动及健康回执尚未一致，未重试。', 'CRABOT_SYSTEM_RECOVERY_UNKNOWN')
        }
        row.state = 'healthy'; row.started = true; row.generation = started.generation
      } else {
        row.state = 'observed_' + current.state; row.generation = current.generation
        if (mode === 'cancel' && unissued && current.state === 'stopped') { row.cancelled = true; row.message = '已取消尚未派发的启动，保留已完成迁移和停止状态。' }
      }
    } catch (error) {
      if (error.code === 'CRABOT_SYSTEM_JOURNAL_FAILED') throw error
      row.state = 'unknown'; row.error = { code: error.code ?? 'CRABOT_SYSTEM_RECOVERY_UNKNOWN', message: error.message }
    }
    delete result.allow_start; await save()
  }
  delete result.current_uid
  try { await operations.verify(); result.phase = 'completed' }
  catch (error) { result.phase = 'interrupted'; result.error = { code: error.code ?? 'CRABOT_SYSTEM_RECOVERY_UNKNOWN', message: error.message } }
  result.exit_code = result.phase === 'interrupted' || result.results.some(row => row.state === 'unknown' || row.original_action_unknown || row.cancelled) ? 1 : 0
  await save(); return result
}
