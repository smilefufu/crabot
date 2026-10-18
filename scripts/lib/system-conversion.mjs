// Legacy conversion coordination only. The root adapter owns code/UID/source
// verification and all employee I/O goes through its dedicated dropped-UID role.
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { validLegacySystemDirectoryIdentity } from './legacy-system-directory.mjs'
import { validateSystemEntries, systemError } from './system-registry.mjs'
const versions = JSON.parse(readFileSync(new URL('../desktop/legacy-releases.json', import.meta.url), 'utf8')).versions
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const absolute = value => typeof value === 'string' && path.posix.isAbsolute(value) && path.posix.normalize(value) === value && value !== '/' && !/[\0\r\n]/.test(value)
const fail = message => { throw systemError(message, 'CRABOT_SYSTEM_CONVERSION_UNVERIFIED') }
const errorOf = error => ({ code: error.code ?? 'CRABOT_SYSTEM_CONVERSION_FAILED', message: error.message })
const observationFields = ['user', 'uid', 'port_offset', 'install_root', 'code_fingerprint', 'manifest_fingerprint',
  'data_dir', 'data_directory', 'data_binding', 'runtime_state', 'controller', 'mm', 'mm_port', 'launch_kind']
function processRecord(value, uid) {
  return value && Number.isSafeInteger(value.pid) && value.pid > 0 && value.owner === String(uid)
    && typeof value.started === 'string' && value.started.length > 0 && value.started.length < 256 && absolute(value.executable)
    && Number.isSafeInteger(value.parent) && value.parent >= 0
    && Object.keys(value).every(key => ['pid', 'owner', 'started', 'executable', 'parent'].includes(key))
}
export function planSystemConversion({ installRoot, source, target, instances }) {
  return validateSystemConversionPlan({ schema_version: 1, kind: 'conversion', id: randomUUID(), install_root: installRoot,
    source: structuredClone(source), target: structuredClone(target), instances: structuredClone(instances) })
}
export function validateSystemConversionPlan(plan) {
  const fields = ['schema_version', 'kind', 'id', 'install_root', 'source', 'target', 'instances']
  if (!plan || plan.schema_version !== 1 || plan.kind !== 'conversion' || !uuid(plan.id)
    || Object.keys(plan).length !== fields.length || fields.some(key => !Object.hasOwn(plan, key))) fail('旧共享转换计划格式不兼容。')
  const { install_root: installRoot, source, target, instances } = plan
  if (!absolute(installRoot) || !source || Object.keys(source).length !== 3 || !versions.includes(source.version)
    || !absolute(source.installRoot) || source.installRoot === installRoot || !hash(source.code_fingerprint)
    || !target || Object.keys(target).length !== 2 || !hash(target.id)
    || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(target.version ?? '') || !Array.isArray(instances)) fail('旧共享来源、目标或转换集合无法核验。')
  validateSystemEntries(instances.map(item => item?.entry))
  for (const item of instances) validateSystemConversionInstance(item, source)
  return plan
}
export function validateSystemConversionInstance(item, source) {
  validateSystemEntries([item?.entry])
  if (!source || Object.keys(source).length !== 3 || !versions.includes(source.version)
    || !absolute(source.installRoot) || !hash(source.code_fingerprint)) fail('旧共享来源无法核验。')
  if (!item || Object.keys(item).length !== 2 || !Object.hasOwn(item, 'entry') || !Object.hasOwn(item, 'observation')) fail('转换计划只能包含运维绑定和观察。')
  const { entry, observation: value } = item
  if (!entry.enabled || !value || Object.keys(value).some(key => !observationFields.includes(key))
    || value.uid !== entry.uid || value.user !== entry.user || value.port_offset !== entry.port_offset || value.data_dir !== entry.data_dir
    || !validLegacySystemDirectoryIdentity(value.data_directory) || value.install_root !== source.installRoot || value.code_fingerprint !== source.code_fingerprint || !hash(value.manifest_fingerprint)
    || !['running', 'stopped'].includes(value.runtime_state)
    || value.data_binding !== (value.runtime_state === 'running' ? 'observed_running' : 'verified_stopped')
    || value.runtime_state === 'running' && (!processRecord(value.controller, entry.uid) || !processRecord(value.mm, entry.uid)
      || value.mm_port !== 19000 + entry.port_offset || value.mm.pid === value.controller.pid
      || value.mm.parent !== value.controller.pid || value.mm.executable !== value.controller.executable || !['daemon', 'foreground'].includes(value.launch_kind))) fail('存在未核实的数据绑定或旧启动来源，未创建转换计划。')
  return item
}

export async function executeSystemConversion(plan, operations) {
  validateSystemConversionPlan(plan)
  const result = { schema_version: 1, kind: 'conversion', id: plan.id, phase: 'running', stage: 'preparing',
    results: plan.instances.map(({ entry, observation }) => ({ uid: entry.uid, user: entry.user,
      originally_running: observation.runtime_state === 'running', resume_required: observation.runtime_state === 'running',
      stopped: observation.runtime_state === 'stopped', state: 'pending' })) }
  const items = new Map(plan.instances.map(item => [item.entry.uid, item]))
  const save = async () => {
    try { await operations.save(structuredClone(result)) }
    catch { throw systemError('转换进度无法写入，已停止派发；保留原记录与保护。', 'CRABOT_SYSTEM_JOURNAL_FAILED') }
  }
  const stage = async (name, uid) => {
    result.stage = name; result.current_uid = uid; delete result.allow_start; await save()
  }
  const interrupted = async error => {
    result.error = errorOf(error); result.phase = 'interrupted'; result.exit_code = 1
    delete result.current_uid; delete result.allow_start; await save(); return result
  }
  const finish = async () => {
    result.phase = 'completed'; delete result.current_uid; delete result.allow_start
    result.exit_code = result.error || result.results.some(row => !['healthy', 'kept_stopped'].includes(row.state)) ? 1 : 0
    await save(); return result
  }
  await save()
  try {
    await stage('source_fence_dispatched')
    const fenced = await operations.fence(plan.source, plan.id)
    if (!uuid(fenced?.id) || fenced.operation_id !== plan.id || fenced.phase !== 'fenced'
      || ['version', 'installRoot', 'code_fingerprint'].some(key => fenced.installation?.[key] !== plan.source[key])) fail('旧共享入口隔离结果无法核验。')
    result.source_fence_id = fenced.id; await stage('source_fenced')
    for (const row of result.results.filter(row => row.originally_running)) {
      row.stop_dispatched = true; await stage('stop_dispatched', row.uid)
      const item = items.get(row.uid), stopped = await operations.stop(item.entry, item.observation)
      if (stopped?.state !== 'stopped') fail('旧实例尚未确认停止，未切换软件。')
      row.stopped = true
      if (stopped.request_acknowledged === null) row.resume_required = false
      await save()
    }
  } catch (error) {
    if (error.code === 'CRABOT_SYSTEM_JOURNAL_FAILED') throw error
    // An incomplete fence or still-unknown shutdown cannot safely reopen old
    // launchers. Explicit recovery first observes the exact original processes.
    return interrupted(error)
  }
  let preparationError
  try {
    for (const row of result.results) {
      row.snapshot_dispatched = true; await stage('snapshot_dispatched', row.uid)
      const snapshot = await operations.snapshot(items.get(row.uid).entry, plan.id)
      if (!snapshot || Object.keys(snapshot).length !== 4 || !uuid(snapshot.id) || snapshot.system_operation_id !== plan.id
        || snapshot.target_id !== plan.target.id || !uuid(snapshot.backup?.id) || !hash(snapshot.backup.sha256)
        || Object.keys(snapshot.backup).length !== 2) fail('旧实例备份回执不属于本次转换。')
      row.snapshot = snapshot; await stage('snapshot_ready', row.uid)
    }
    await stage('command_switch_dispatched')
    await operations.selectTarget()
    await stage('target_command_selected')
  } catch (error) {
    if (error.code === 'CRABOT_SYSTEM_JOURNAL_FAILED') throw error
    preparationError = error
  }
  if (preparationError) {
    result.error = errorOf(preparationError)
    let stillLegacy = false
    try { stillLegacy = await operations.selected() === 'legacy' } catch {}
    if (!stillLegacy) return interrupted(preparationError)
    // All UIDs were stopped. Remove every dispatched pre-data preparation
    // before restoring the shared old entry files; unknown cancellation fences all.
    try {
      for (const row of result.results.filter(row => row.snapshot_dispatched)) {
        await stage('source_preparation_cancel_dispatched', row.uid)
        await operations.cancelSnapshot(items.get(row.uid).entry, plan.id)
      }
      await stage('source_restore_dispatched')
      await operations.restoreSource(result.source_fence_id, plan.id)
      await stage('source_restored')
    } catch (error) {
      if (error.code === 'CRABOT_SYSTEM_JOURNAL_FAILED') throw error
      return interrupted(error)
    }
    for (const row of result.results) {
      row.state = 'kept_stopped'
      if (row.resume_required) {
        try {
          row.start_dispatched = true; await stage('source_start_dispatched', row.uid)
          const started = await operations.startSource(items.get(row.uid).entry)
          if (started?.state !== 'started') fail('旧实例尚未恢复健康。')
          row.state = 'healthy'; row.started = true; row.version = plan.source.version
        } catch (error) {
          if (error.code === 'CRABOT_SYSTEM_JOURNAL_FAILED') throw error
          row.state = 'unknown'; row.error = errorOf(error)
        }
      }
      await save()
    }
    return finish()
  }
  try {
    await stage('source_seal_dispatched')
    await operations.sealSource(result.source_fence_id, plan.id)
    await stage('source_sealed')
  } catch (error) {
    if (error.code === 'CRABOT_SYSTEM_JOURNAL_FAILED') throw error
    return interrupted(error)
  }
  for (const row of result.results) {
    const item = items.get(row.uid)
    try {
      row.migration_dispatched = true; await stage('migration_dispatched', row.uid)
      const migrated = await operations.migrate(item.entry, row.snapshot)
      if (migrated?.migrated !== true || migrated.service_started !== false) fail('本人迁移完成结果尚未确认。')
      row.migrated = true; await stage('migration_completed', row.uid)
      row.registration_dispatched = true; await stage('registration_dispatched', row.uid)
      await operations.register(item.entry); row.registered = true; await save()
      await stage('service_configure_dispatched', row.uid)
      await operations.configure(item.entry); row.configured = true; await save()
      if (row.resume_required) {
        row.start_dispatched = true; await stage('target_start_dispatched', row.uid)
        result.allow_start = { uid: row.uid, core_id: plan.target.id }; await save()
        const started = await operations.startTarget(item.entry)
        if (started?.state !== 'started') fail('目标实例尚未恢复健康。')
        row.state = 'healthy'; row.started = true; row.generation = started.generation
      } else {
        if ((await operations.observeTarget(item.entry)).state !== 'stopped') fail('原停止用户出现非预期运行，未终止新实例。')
        row.state = 'kept_stopped'
      }
    } catch (error) {
      if (error.code === 'CRABOT_SYSTEM_JOURNAL_FAILED') throw error
      row.state = 'unknown'; row.error = errorOf(error)
    }
    await save()
  }
  return finish()
}
