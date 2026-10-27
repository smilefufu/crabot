// Schema-2 recovery runtime facts. No old archived job or normal coordinator is impersonated.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import { readWorkspaceInterruptedRecoveryRole } from './workspace-interrupted-role.mjs'
import { readPendingWorkspaceSourceRestoration, readWorkspaceSourceCompletionScope } from './workspace-interrupted-source-records.mjs'
import { createWorkspaceMaintenanceFileAccess, version } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
const failure = () => Object.assign(new Error('中断恢复的模块登记或当前角色无法核实，维护保护已保留；未重复启动。'), { code: 'CRABOT_WORKSPACE_RUNTIME_GATE' })
const { owned, readJson, readBoundBytes, publish, syncDirectory } = createWorkspaceMaintenanceFileAccess(failure)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const moduleName = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(value) && !['.', '..', 'admin-web'].includes(value)
function context(dataDir, recoveryId) {
  const role = readWorkspaceInterruptedRecoveryRole(dataDir, recoveryId)
  if (!role.launch || !role.ready || role.launch.action !== 'restore_source') throw failure()
  const original = readWorkspaceSourceCompletionScope(dataDir, role.launch.request.intent_id)
  const observation = readJson(path.join(role.launch.control_root.path, 'runtime-observations.json'))
  if (observation) observationValue(observation, role, original)
  if (original.released && original.release.job.recovery_id !== recoveryId && !observation) throw failure()
  const business = readJson(path.join(path.dirname(original.original.path), 'business-prepared.json'), 32 * 1024 * 1024)
  if (!original.archived || !exact(business, ['schema_version', 'intent_id', 'scope_sha256', 'checkpoints']) || business.schema_version !== 2
    || business.intent_id !== role.launch.request.intent_id || business.scope_sha256 !== original.marker.scope_sha256 || !Array.isArray(business.checkpoints)
    || business.checkpoints.length !== original.scope.recovery_snapshot.checkpoints.length || business.checkpoints.some((item, index) =>
      !exact(item, ['index', 'manifest_sha256', 'complete_sha256']) || item.index !== index || !digest(item.manifest_sha256) || !digest(item.complete_sha256))) throw failure()
  const directory = role.launch.control_root.path, fingerprint = hash(role)
  const verify = (live = false) => {
    if (hash(readWorkspaceInterruptedRecoveryRole(dataDir, recoveryId)) !== fingerprint
      || hash(readWorkspaceSourceCompletionScope(dataDir, role.launch.request.intent_id).marker) !== hash(original.marker)
      || observation && hash(readJson(path.join(directory, 'runtime-observations.json'))) !== hash(observation)
      || live && (!native.sameProcess(role.launch.parent, native.inspectProcess(role.launch.parent.pid))
        || !native.sameProcess(role.launch.process, native.inspectProcess(role.launch.process.pid)))) throw failure()
  }
  verify()
  return { role, original, observation, directory, verify }
}
function planValue(value, role, original, observation) {
  const allowed = new Set(['crabot-agent', 'memory-default', ...(original.checkpoint.modules?.modules ?? []).map(item => item.module_id)])
  if (!exact(value, ['schema_version', 'recovery_id', 'launch_sha256', 'instance_id', 'admin_runtime_id', 'modules']) || value.schema_version !== 2
    || value.recovery_id !== role.launch.request.recovery_id || value.launch_sha256 !== hash(role.launch)
    || !uuid(value.instance_id) || !uuid(value.admin_runtime_id) || !Array.isArray(value.modules) || value.modules.length > 32768) throw failure()
  const modules = new Set(), runtimes = new Set([value.admin_runtime_id])
  for (const item of value.modules) {
    if (!exact(item, ['module_id', 'runtime_id', 'module_port']) || !moduleName(item.module_id) || !allowed.has(item.module_id) || !uuid(item.runtime_id)
      || !Number.isInteger(item.module_port) || item.module_port < 1 || item.module_port > 65535 || modules.has(item.module_id) || runtimes.has(item.runtime_id)) throw failure()
    modules.add(item.module_id); runtimes.add(item.runtime_id)
  }
  if (observation && (observation.observations.length !== value.modules.length || observation.observations.some(item =>
    item.runtime.instance_id !== value.instance_id || !value.modules.some(module => module.module_id === item.runtime.module_id
      && module.runtime_id === item.runtime.runtime_id && module.module_port === item.runtime.module_port)))) throw failure()
  return value
}
export function readWorkspaceInterruptedRuntimePlan(dataDir, recoveryId) {
  const ctx = context(dataDir, recoveryId), plan = readJson(path.join(ctx.directory, 'runtime-plan.json'))
  if (!plan) return null
  planValue(plan, ctx.role, ctx.original, ctx.observation); ctx.verify()
  return plan
}
export async function commitWorkspaceInterruptedRuntimePlan({ dataDir, recoveryId, instanceId, adminRuntimeId, modules, verify }) {
  if (typeof verify !== 'function' || process.versions.electron) throw failure()
  const ctx = context(dataDir, recoveryId)
  if (!native.sameProcess(ctx.role.launch.parent, native.inspectProcess(process.pid))) throw failure()
  const plan = planValue({ schema_version: 2, recovery_id: recoveryId, launch_sha256: hash(ctx.role.launch),
    instance_id: instanceId, admin_runtime_id: adminRuntimeId, modules: structuredClone(modules) }, ctx.role, ctx.original, ctx.observation)
  await verify(); ctx.verify(true)
  if (readJson(path.join(ctx.directory, 'runtime-plan.json'))) throw failure()
  publish(ctx.directory, 'runtime-plan.json', plan, () => ctx.verify(true))
  await verify(); ctx.verify(true)
  return plan
}
function registration(dataDir, runtimeId) {
  if (!uuid(runtimeId)) throw failure()
  const directory = path.join(dataDir, 'module-runtime-registry'), entries = path.join(directory, 'records')
  for (const file of [directory, entries]) { owned(file, true); if (fs.realpathSync(file) !== file) throw failure() }
  const file = path.join(entries, runtimeId + '.json')
  const record = JSON.parse(readBoundBytes(file, version(owned(file))).toString('utf8'))
  const instanceFile = path.join(directory, 'instance-id')
  if (readBoundBytes(instanceFile, version(owned(instanceFile))).toString('utf8').trim() !== record.instance_id) throw failure()
  return record
}
function observationValue(value, role, source) {
  if (!source.released || !exact(value, ['schema_version', 'recovery_id', 'launch_sha256', 'release_sha256', 'observations'])
    || value.schema_version !== 2 || value.recovery_id !== role.launch.request.recovery_id || value.launch_sha256 !== hash(role.launch)
    || value.release_sha256 !== hash(source.release) || !Array.isArray(value.observations) || value.observations.length > 32768) throw failure()
  const ids = new Set(), runtimes = new Set()
  for (const item of value.observations) {
    const runtime = item?.runtime, identity = item?.process
    if (!exact(item, ['process', 'runtime']) || !exact(identity, ['pid', 'parent', 'started', 'owner', 'executable'])
      || !Number.isInteger(identity.pid) || identity.pid <= 0 || identity.parent !== role.launch.parent.pid || identity.owner !== role.launch.parent.owner
      || ['started', 'owner', 'executable'].some(key => typeof identity[key] !== 'string' || !identity[key] || identity[key].includes('\0'))
      || !exact(runtime, ['schema_version', 'instance_id', 'runtime_id', 'module_id', 'root_pid', 'process_start_identity', 'module_port', 'created_at'])
      || runtime.schema_version !== 1 || !uuid(runtime.instance_id) || !uuid(runtime.runtime_id) || !moduleName(runtime.module_id)
      || runtime.root_pid !== identity.pid || !Number.isInteger(runtime.module_port) || runtime.module_port < 1 || runtime.module_port > 65535
      || typeof runtime.process_start_identity !== 'string' || !runtime.process_start_identity || typeof runtime.created_at !== 'string'
      || new Date(runtime.created_at).toISOString() !== runtime.created_at || ids.has(runtime.module_id) || runtimes.has(runtime.runtime_id)) throw failure()
    ids.add(runtime.module_id); runtimes.add(runtime.runtime_id)
  }
  return value
}
/** Existing current-Core children are observed, never represented as fresh starts. */
export async function commitWorkspaceInterruptedRuntimeObservations({ dataDir, recoveryId, instanceId, adminRuntimeId, observations, verify }) {
  if (typeof verify !== 'function' || process.versions.electron) throw failure()
  const role = readWorkspaceInterruptedRecoveryRole(dataDir, recoveryId)
  if (!role.launch || !role.ready || !native.sameProcess(role.launch.parent, native.inspectProcess(process.pid))) throw failure()
  const source = readWorkspaceSourceCompletionScope(dataDir, role.launch.request.intent_id)
  const record = observationValue({ schema_version: 2, recovery_id: recoveryId, launch_sha256: hash(role.launch),
    release_sha256: hash(source.release), observations: structuredClone(observations) }, role, source)
  const current = () => {
    if (hash(readWorkspaceInterruptedRecoveryRole(dataDir, recoveryId)) !== hash(role)
      || hash(readWorkspaceSourceCompletionScope(dataDir, role.launch.request.intent_id).release) !== hash(source.release)
      || !native.sameProcess(role.launch.parent, native.inspectProcess(process.pid)) || !native.sameProcess(role.launch.process, native.inspectProcess(role.launch.process.pid))) throw failure()
    for (const item of record.observations) if (!native.sameProcess(item.process, native.inspectProcess(item.process.pid))
      || hash(registration(dataDir, item.runtime.runtime_id)) !== hash(item.runtime)) throw failure()
  }
  await verify(); current()
  publish(role.launch.control_root.path, 'runtime-observations.json', record, current)
  return commitWorkspaceInterruptedRuntimePlan({ dataDir, recoveryId, instanceId, adminRuntimeId,
    modules: record.observations.map(item => ({ module_id: item.runtime.module_id, runtime_id: item.runtime.runtime_id, module_port: item.runtime.module_port })), verify })
}
export function readWorkspaceInterruptedRuntimeObservation(dataDir, recoveryId, moduleId) {
  const ctx = context(dataDir, recoveryId)
  if (!ctx.observation) return null
  const plan = readWorkspaceInterruptedRuntimePlan(dataDir, recoveryId)
  if (!plan) throw failure()
  ctx.verify()
  return ctx.observation.observations.find(item => item.runtime.module_id === moduleId) ?? null
}
export function verifyWorkspaceInterruptedRuntimeObservation(dataDir, recoveryId, moduleId) {
  const ctx = context(dataDir, recoveryId), item = readWorkspaceInterruptedRuntimeObservation(dataDir, recoveryId, moduleId)
  if (!item || !native.sameProcess(item.process, native.inspectProcess(item.process.pid))
    || hash(registration(dataDir, item.runtime.runtime_id)) !== hash(item.runtime)) throw failure()
  ctx.verify(true)
  return item
}
function runtimeValue(record, ctx, plan, moduleId) {
  const target = plan.modules.find(item => item.module_id === moduleId), runtime = record?.runtime
  if (!target || !exact(record, ['schema_version', 'recovery_id', 'plan_sha256', 'definition_sha256', 'parent', 'process', 'runtime'])
    || record.schema_version !== 2 || record.recovery_id !== plan.recovery_id || record.plan_sha256 !== hash(plan) || !digest(record.definition_sha256)
    || hash(record.parent) !== hash(ctx.role.launch.parent) || !record.process || record.process.parent !== record.parent.pid
    || record.process.owner !== record.parent.owner || record.process.pid === record.parent.pid || record.process.executable !== record.parent.executable
    || !exact(runtime, ['schema_version', 'instance_id', 'runtime_id', 'module_id', 'root_pid', 'process_start_identity', 'module_port', 'created_at'])
    || runtime.schema_version !== 1 || runtime.instance_id !== plan.instance_id || runtime.runtime_id !== target.runtime_id
    || runtime.module_id !== moduleId || runtime.module_port !== target.module_port || runtime.root_pid !== record.process.pid
    || typeof runtime.process_start_identity !== 'string' || !runtime.process_start_identity || typeof runtime.created_at !== 'string'
    || new Date(runtime.created_at).toISOString() !== runtime.created_at) throw failure()
  return record
}
export function readWorkspaceInterruptedRuntimeStart(dataDir, recoveryId, moduleId) {
  if (!moduleName(moduleId)) throw failure()
  const ctx = context(dataDir, recoveryId), plan = readWorkspaceInterruptedRuntimePlan(dataDir, recoveryId)
  if (!plan) throw failure()
  const directory = path.join(ctx.directory, 'runtime-starts')
  if (!fs.existsSync(directory)) return null
  owned(directory, true, true)
  if (fs.realpathSync(directory) !== directory) throw failure()
  const record = readJson(path.join(directory, moduleId + '.json'))
  if (!record) return null
  runtimeValue(record, ctx, plan, moduleId); ctx.verify()
  return record
}
export function verifyWorkspaceInterruptedRuntimeStart({ dataDir, recoveryId, moduleId, recordHash, definitionHash }) {
  const ctx = context(dataDir, recoveryId), record = readWorkspaceInterruptedRuntimeStart(dataDir, recoveryId, moduleId)
  if (!digest(recordHash) || !digest(definitionHash) || !record || hash(record) !== recordHash || record.definition_sha256 !== definitionHash
    || !native.sameProcess(record.process, native.inspectProcess(record.process.pid)) || hash(registration(dataDir, record.runtime.runtime_id)) !== hash(record.runtime)) throw failure()
  ctx.verify(true)
  return record
}
export async function commitWorkspaceInterruptedRuntimeStart(options) {
  if (!exact(options, ['dataDir', 'recoveryId', 'moduleId', 'process', 'runtime', 'definitionHash', 'verify'])
    || typeof options.verify !== 'function' || !moduleName(options.moduleId) || process.versions.electron) throw failure()
  const { dataDir, recoveryId, moduleId, verify } = options, ctx = context(dataDir, recoveryId), plan = readWorkspaceInterruptedRuntimePlan(dataDir, recoveryId)
  if (!plan || !native.sameProcess(ctx.role.launch.parent, native.inspectProcess(process.pid))) throw failure()
  const record = runtimeValue({ schema_version: 2, recovery_id: recoveryId, plan_sha256: hash(plan), definition_sha256: options.definitionHash,
    parent: native.inspectProcess(process.pid), process: structuredClone(options.process), runtime: structuredClone(options.runtime) }, ctx, plan, moduleId)
  const check = () => {
    ctx.verify(true)
    if (hash(readWorkspaceInterruptedRuntimePlan(dataDir, recoveryId)) !== hash(plan) || !native.sameProcess(record.process, native.inspectProcess(record.process.pid))
      || hash(registration(dataDir, record.runtime.runtime_id)) !== hash(record.runtime)) throw failure()
  }
  await verify(); check()
  const directory = path.join(ctx.directory, 'runtime-starts')
  if (!fs.existsSync(directory)) {
    if (process.platform === 'win32') native.createPrivateDirectory(directory)
    else fs.mkdirSync(directory, { mode: 0o700 })
    syncDirectory(ctx.directory)
  }
  owned(directory, true, true)
  publish(directory, moduleId + '.json', record, check)
  await verify(); check()
  return verifyWorkspaceInterruptedRuntimeStart({ dataDir, recoveryId, moduleId, recordHash: hash(record), definitionHash: options.definitionHash })
}

/** Prior ownership facts only. A fresh current driver still verifies/stops every actual runtime. */
export function readWorkspaceInterruptedRuntimeHistory(dataDir, intentId) {
  const pending = readPendingWorkspaceSourceRestoration(dataDir, intentId)
  const parent = path.dirname(pending.role.launch.control_root.path), names = fs.readdirSync(parent).sort(), rows = []
  owned(parent, true, true)
  for (const id of names) {
    if (!uuid(id)) throw failure()
    const directory = path.join(parent, id)
    owned(directory, true, true)
    const launch = readJson(path.join(directory, 'launch.json'))
    if (!launch || launch.schema_version !== 2 || launch.request?.intent_id !== intentId) continue
    const role = readWorkspaceInterruptedRecoveryRole(dataDir, id)
    if (role.launch.action !== 'restore_source' || role.launch.request.checkpoint_sha256 !== pending.checkpoint.checkpoint_sha256) throw failure()
    if (!role.ready) {
      if (fs.existsSync(path.join(directory, 'runtime-plan.json')) || fs.existsSync(path.join(directory, 'runtime-starts'))) throw failure()
      continue
    }
    const plan = readWorkspaceInterruptedRuntimePlan(dataDir, id)
    if (!plan) {
      if (fs.existsSync(path.join(directory, 'runtime-starts'))) throw failure()
      continue
    }
    rows.push({ role, plan, starts: plan.modules.map(item => readWorkspaceInterruptedRuntimeStart(dataDir, id, item.module_id)) })
  }
  if (hash(fs.readdirSync(parent).sort()) !== hash(names)) throw failure()
  return rows
}
