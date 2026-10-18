// Conversion role policy only. Root intent/fence readers and the UID transport
// supply authority; an employee observation alone can never produce a permit.
import { randomUUID } from 'node:crypto'
import { validateSystemConversionPlan, validateSystemConversionInstance } from './system-conversion.mjs'
import { systemError } from './system-registry.mjs'
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const fail = () => { throw systemError('旧共享转换委托与当前根作业阶段不符，未停止实例。', 'CRABOT_SYSTEM_CONVERSION_PERMIT') }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export function conversionStopMaintenanceMatches(permit, maintenance, bootId) {
  return Boolean(uuid(bootId) && permit.boot_id === bootId && maintenance?.schema_version === 1
    && maintenance.id === permit.operation_id && maintenance.operation === 'conversion' && maintenance.phase === 'running'
    && maintenance.boot_id === bootId && maintenance.stage === 'stop_dispatched' && maintenance.current_uid === permit.entry.uid
    && maintenance.allow_start === undefined && Array.isArray(maintenance.targets) && maintenance.targets.includes(permit.entry.uid)
    && !maintenance.recovery_id)
}
export function validateLegacySystemConversionPermit(permit) {
  const fields = ['schema_version', 'id', 'kind', 'action', 'operation_id', 'boot_id', 'source_fence_id', 'entry', 'source', 'observation']
  if (!permit || Object.keys(permit).length !== fields.length || fields.some(key => !Object.hasOwn(permit, key))
    || permit.schema_version !== 1 || permit.kind !== 'legacy-system-conversion' || permit.action !== 'stop-legacy'
    || !uuid(permit.id) || !uuid(permit.operation_id) || !uuid(permit.boot_id) || !uuid(permit.source_fence_id)
    || permit.observation?.runtime_state !== 'running' || permit.observation.data_binding !== 'observed_running') fail()
  validateSystemConversionInstance({ entry: permit.entry, observation: permit.observation }, permit.source)
  return permit
}
export function createLegacySystemConversionPermit({ record, maintenance, entry, sourceFence, bootId }) {
  const plan = validateSystemConversionPlan(record?.plan), progress = record.progress
  if (record.schema_version !== 1 || record.phase !== 'running' || record.boot_id !== bootId || record.recovery
    || progress?.schema_version !== 1 || progress.kind !== 'conversion' || progress.id !== plan.id || progress.phase !== 'running'
    || progress.stage !== 'stop_dispatched' || progress.current_uid !== entry.uid || progress.allow_start !== undefined
    || !Array.isArray(progress.results) || !uuid(progress.source_fence_id)) fail()
  const item = plan.instances.find(item => item.entry.uid === entry.uid), row = progress.results.find(row => row.uid === entry.uid)
  if (!item || !same(item.entry, entry) || row?.originally_running !== true || row.stop_dispatched !== true || row.stopped !== false
    || sourceFence?.id !== progress.source_fence_id || sourceFence.operation_id !== plan.id || sourceFence.phase !== 'fenced'
    || sourceFence.entries_fenced !== true || !same(sourceFence.installation, plan.source)
    || !same(maintenance?.targets, plan.instances.map(item => item.entry.uid))) fail()
  const permit = validateLegacySystemConversionPermit({ schema_version: 1, id: randomUUID(), kind: 'legacy-system-conversion',
    action: 'stop-legacy', operation_id: plan.id, boot_id: bootId, source_fence_id: progress.source_fence_id,
    entry: structuredClone(entry), source: structuredClone(plan.source), observation: structuredClone(item.observation) })
  if (!conversionStopMaintenanceMatches(permit, maintenance, bootId)) fail()
  return permit
}
