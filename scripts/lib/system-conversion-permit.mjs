// Conversion role policy only. Root intent/fence readers and the UID transport
// supply authority; an employee observation alone can never produce a permit.
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { validateSystemConversionPlan, validateSystemConversionInstance } from './system-conversion.mjs'
import { systemConversionRecoveryOptions } from './system-conversion-recovery.mjs'
import { systemError } from './system-registry.mjs'
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const fail = () => { throw systemError('旧共享转换委托与当前根作业阶段不符，未派发本次动作。', 'CRABOT_SYSTEM_CONVERSION_PERMIT') }
const stages = { 'check-migration': 'target_recovery_observing', 'stop-legacy': 'stop_dispatched', 'start-legacy': 'source_start_dispatched', snapshot: 'snapshot_dispatched', migrate: 'migration_dispatched', 'cancel-preparation': 'source_preparation_cancel_dispatched' }
function receipt(value, operationId, targetId) {
  return value && Object.keys(value).length === 4 && uuid(value.id) && value.system_operation_id === operationId && value.target_id === targetId
    && value.backup && Object.keys(value.backup).length === 2 && uuid(value.backup.id) && digest(value.backup.sha256)
}
export function conversionMaintenanceMatches(permit, maintenance, bootId) {
  return Boolean(uuid(bootId) && permit.boot_id === bootId && Object.hasOwn(stages, permit.action) && maintenance?.schema_version === 1
    && maintenance.id === permit.operation_id && maintenance.operation === 'conversion' && maintenance.phase === 'running'
    && maintenance.boot_id === bootId && maintenance.stage === stages[permit.action] && maintenance.current_uid === permit.entry.uid
    && maintenance.allow_start === undefined && Array.isArray(maintenance.targets) && maintenance.targets.includes(permit.entry.uid)
    && (permit.action === 'check-migration' ? uuid(maintenance.recovery_id) : !maintenance.recovery_id))
}
export function conversionStopMaintenanceMatches(permit, maintenance, bootId) {
  return permit.action === 'stop-legacy' && conversionMaintenanceMatches(permit, maintenance, bootId)
}
export function validateLegacySystemConversionPermit(permit) {
  const data = ['snapshot', 'migrate', 'cancel-preparation', 'check-migration'].includes(permit?.action)
  const fields = ['schema_version', 'id', 'kind', 'action', 'operation_id', 'boot_id', 'source_fence_id', 'entry', 'source', 'observation',
    ...(data ? ['install_root', 'target', 'snapshot'] : [])]
  if (!permit || Object.keys(permit).length !== fields.length || fields.some(key => !Object.hasOwn(permit, key))
    || permit.schema_version !== 1 || permit.kind !== 'legacy-system-conversion' || !Object.hasOwn(stages, permit.action)
    || !uuid(permit.id) || !uuid(permit.operation_id) || !uuid(permit.boot_id) || !uuid(permit.source_fence_id)
    || !data && (permit.observation?.runtime_state !== 'running' || permit.observation.data_binding !== 'observed_running')) fail()
  validateSystemConversionInstance({ entry: permit.entry, observation: permit.observation }, permit.source)
  if (data) {
    validateSystemConversionPlan({ schema_version: 1, kind: 'conversion', id: permit.operation_id, install_root: permit.install_root,
      source: permit.source, target: permit.target, instances: [{ entry: permit.entry, observation: permit.observation }] })
    if (['migrate', 'check-migration'].includes(permit.action) ? !receipt(permit.snapshot, permit.operation_id, permit.target.id) : permit.snapshot !== null) fail()
  }
  return permit
}
export function createLegacySystemConversionPermit({ record, maintenance, entry, sourceFence, bootId, action = 'stop-legacy' }) {
  const plan = validateSystemConversionPlan(record?.plan), progress = record.progress
  if (!Object.hasOwn(stages, action) || record.schema_version !== 1 || record.phase !== 'running' || record.boot_id !== bootId || action !== 'check-migration' && record.recovery
    || progress?.schema_version !== 1 || progress.kind !== 'conversion' || progress.id !== plan.id || progress.phase !== 'running'
    || progress.stage !== stages[action] || progress.current_uid !== entry.uid || progress.allow_start !== undefined
    || !Array.isArray(progress.results) || !uuid(progress.source_fence_id)
    || !isDeepStrictEqual(progress.results.map(row => row.uid), plan.instances.map(item => item.entry.uid))) fail()
  const item = plan.instances.find(item => item.entry.uid === entry.uid), row = progress.results.find(row => row.uid === entry.uid)
  const data = ['snapshot', 'migrate', 'cancel-preparation', 'check-migration'].includes(action)
  let fencePhase = 'fenced'
  if (['migrate', 'check-migration'].includes(action)) fencePhase = 'data_changing'
  else if (action === 'start-legacy') fencePhase = 'restored'
  if (!item || !isDeepStrictEqual(item.entry, entry) || row?.state !== (action === 'start-legacy' ? 'kept_stopped' : 'pending') || row.user !== entry.user
    || sourceFence?.id !== progress.source_fence_id || sourceFence.operation_id !== plan.id
    || sourceFence.phase !== fencePhase
    || sourceFence.entries_fenced !== (action !== 'start-legacy')
    || !isDeepStrictEqual(sourceFence.installation, plan.source)
    || !isDeepStrictEqual(maintenance?.targets, plan.instances.map(item => item.entry.uid))) fail()
  if (!data) {
    if (row.originally_running !== true) fail()
    if (action === 'stop-legacy') {
      if (row.stop_dispatched !== true || row.stopped !== false) fail()
    } else if (row.resume_required !== true || row.start_dispatched !== true || row.stopped !== true
      || progress.results.some(current => current.stopped !== true || current.migration_dispatched || current.migrated)) fail()
  } else {
    if (progress.results.some(current => current.stopped !== true)) fail()
    if (action === 'check-migration') {
      const recovery = record.recovery
      if (!uuid(recovery?.id) || recovery.id !== maintenance.recovery_id || !['continue', 'cancel'].includes(recovery.mode)
        || recovery.mode !== progress.recovery_mode) fail()
      systemConversionRecoveryOptions(plan, recovery.base_progress)
      const original = recovery.base_progress.results.find(current => current.uid === entry.uid)
      if (row.migrated !== true || row.registered !== true || row.configured !== true
        || !isDeepStrictEqual(row.snapshot, original.snapshot)) fail()
    } else if (action === 'migrate') {
      if (row.migration_dispatched !== true || row.migrated === true
        || progress.results.some(current => !receipt(current.snapshot, plan.id, plan.target.id))) fail()
    } else if (progress.results.some(current => current.migration_dispatched || current.migrated)
      || row.snapshot_dispatched !== true || action === 'snapshot' && row.snapshot !== undefined) fail()
  }
  const permit = validateLegacySystemConversionPermit({ schema_version: 1, id: randomUUID(), kind: 'legacy-system-conversion', action,
    operation_id: plan.id, boot_id: bootId, source_fence_id: progress.source_fence_id,
    entry: structuredClone(entry), source: structuredClone(plan.source), observation: structuredClone(item.observation),
    ...(data ? { install_root: plan.install_root, target: structuredClone(plan.target), snapshot: ['migrate', 'check-migration'].includes(action) ? structuredClone(row.snapshot) : null } : {}) })
  if (!conversionMaintenanceMatches(permit, maintenance, bootId)) fail()
  return permit
}
