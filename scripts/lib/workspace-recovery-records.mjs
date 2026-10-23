// Immutable recovery metadata only; no command or normal-job authority.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import management from './desktop-management.cjs'
import { cliLockToken } from './cli-lock.mjs'
import owned from './owned-process-tree.cjs'
import { parseWorkspaceRecoveryAdmissionRequest, readWorkspaceRecoveryAdmissionScope, readWorkspaceRecoveryCompletionScope } from './workspace-recovery-admission.mjs'
import { observeWorkspaceRelocationRecords, readWorkspaceRelocationArchivedState } from './workspace-relocation-intent.mjs'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
const fail = () => { throw Object.assign(new Error('新恢复协调器的初始化材料无法核实，原维护保护已保留。'), { code: 'CRABOT_WORKSPACE_RECOVERY_COORDINATOR' }) }
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const date = value => typeof value === 'string' && new Date(value).toISOString() === value
const version = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(':')
const processIdentity = value => exact(value, ['pid', 'parent', 'started', 'owner', 'executable']) && Number.isInteger(value.pid) && value.pid > 0 && value.pid <= 2147483647
  && Number.isInteger(value.parent) && value.parent >= 0 && value.parent <= 2147483647 && ['started', 'owner', 'executable'].every(key => typeof value[key] === 'string' && value[key] && !value[key].includes('\0'))
function exists(file) { try { fs.lstatSync(file); return true } catch (error) { if (error.code !== 'ENOENT') fail(); return false } }
function frame(directory, privateEntry = true) {
  const stat = fs.lstatSync(directory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || !stat.ino || fs.realpathSync(directory) !== directory
    || (process.platform === 'win32' ? !(privateEntry ? native.isPrivateDirectory(directory) : native.isOwnerOnlyDirectory(directory)) : stat.uid !== BigInt(process.getuid()) || privateEntry && (stat.mode & 0o777n) !== 0o700n)) fail()
  return { path: directory, dev: String(stat.dev), ino: String(stat.ino), native_id: process.platform === 'win32' ? native.inspectDirectoryFileId(directory) : null }
}
function context(dataDir, id) {
  if (!uuid(id)) fail()
  const data = management.requirePrivateDataRoot(dataDir), control = path.join(data, 'workspace-control'), parent = path.join(control, 'relocation-recovery'), directory = path.join(parent, id)
  const dataFrame = frame(data), controlFrame = frame(control)
  const verify = () => { if (hash(frame(data)) !== hash(dataFrame) || hash(frame(control)) !== hash(controlFrame)) fail() }
  return { data, control, parent, directory, dataFrame, verify }
}
function read(directory, name, privateEntry = true, flush = false, parse = JSON.parse) {
  const beforeDirectory = frame(directory, privateEntry), file = path.join(directory, name)
  if (!exists(file)) return null
  const stat = fs.lstatSync(file, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 65536n
    || (process.platform === 'win32' ? !(privateEntry ? native.isPrivateFile(file) : native.isOwnerOnlyFile(file)) : stat.uid !== BigInt(process.getuid()) || privateEntry && (stat.mode & 0o777n) !== 0o600n)) fail()
  const fd = fs.openSync(file, (flush && process.platform === 'win32' ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    if (version(fs.fstatSync(fd, { bigint: true })) !== version(stat)) fail()
    const value = fs.readFileSync(fd, 'utf8')
    if (flush) fs.fsyncSync(fd)
    if (version(fs.fstatSync(fd, { bigint: true })) !== version(stat) || version(fs.lstatSync(file, { bigint: true })) !== version(stat)
      || hash(frame(directory, privateEntry)) !== hash(beforeDirectory)) fail()
    return parse(value)
  } finally { fs.closeSync(fd) }
}
function sync(directory) {
  if (process.platform === 'win32') return
  const fd = fs.openSync(directory, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function publish(ctx, name, value, verify) {
  const content = JSON.stringify(value) + '\n', file = path.join(ctx.directory, name)
  if (Buffer.byteLength(content) > 65536) fail()
  verify()
  if (process.platform === 'win32') {
    native.writePrivateFile(file, '')
    const before = fs.lstatSync(file, { bigint: true }), fd = fs.openSync(file, 'r+')
    try {
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !native.isPrivateFile(file) || version(fs.fstatSync(fd, { bigint: true })) !== version(before)) fail()
      fs.writeFileSync(fd, content); fs.fsyncSync(fd)
      const after = fs.lstatSync(file, { bigint: true })
      if (before.dev !== after.dev || before.ino !== after.ino || after.nlink !== 1n || after.isSymbolicLink()) fail()
    } finally { fs.closeSync(fd) }
  } else fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600, flush: true })
  verify(); sync(ctx.directory); sync(ctx.parent); sync(ctx.control); sync(ctx.data); verify()
  if (hash(read(ctx.directory, name)) !== hash(value)) fail()
}
/** Historical facts; no live role or command is reconstructed. */
export function readWorkspaceRecoveryCoordinator(dataDir, id) {
  try {
    const ctx = context(dataDir, id)
    if (!exists(ctx.parent)) return { launch: null, ready: null }
    const parent = frame(ctx.parent)
    if (!exists(ctx.directory)) return { launch: null, ready: null }
    const directory = frame(ctx.directory), launch = read(ctx.directory, 'launch.json'), ready = read(ctx.directory, 'ready.json')
    if (exists(path.join(ctx.directory, 'ready.json')) && !ready) fail()
    if (!launch || !exact(launch, ['schema_version', 'request', 'admission_sha256', 'parent', 'process', 'data_root', 'control_root', 'created_at'])
      || launch.schema_version !== 1 || launch.request?.recovery_id !== id || !digest(launch.admission_sha256) || !date(launch.created_at)
      || hash(launch.data_root) !== hash(ctx.dataFrame) || hash(launch.control_root) !== hash(directory)
      || !processIdentity(launch.parent) || !processIdentity(launch.process) || launch.parent.pid === launch.process.pid
      || launch.parent.owner !== launch.process.owner || launch.process.parent !== launch.parent.pid
      || !owned.processBirthAtLeast(launch.process.started, launch.parent.started)) fail()
    // Parse only: old launch metadata is never a new recovery admission.
    parseWorkspaceRecoveryAdmissionRequest(launch.request)
    if (ready && (!exact(ready, ['schema_version', 'recovery_id', 'launch_sha256', 'created_at']) || ready.schema_version !== 1
      || ready.recovery_id !== id || ready.launch_sha256 !== hash(launch) || !date(ready.created_at))) fail()
    ctx.verify()
    if (hash(frame(ctx.parent)) !== hash(parent) || hash(frame(ctx.directory)) !== hash(directory)) fail()
    return { launch, ready }
  } catch { fail() }
}

export async function commitWorkspaceRecoveryCoordinatorLaunch(options) {
  try {
    if (!exact(options, ['dataDir', 'request', 'admission', 'coordinator', 'verify']) || typeof options.verify !== 'function' || process.versions.electron) fail()
    const scope = readWorkspaceRecoveryAdmissionScope(options.dataDir, options.request), ctx = context(options.dataDir, scope.request.recovery_id)
    const self = native.inspectProcess(process.pid), admission = options.admission, token = cliLockToken(path.join(ctx.data, 'cli.lock'))
    if (!token || !processIdentity(self) || !processIdentity(options.coordinator) || !exact(admission, ['verified', 'intent_id', 'recovery_id', 'completion_sha256', 'finalizing_sha256', 'instance_id', 'admin_runtime_id', 'mm_sha256'])
      || admission.verified !== true || !uuid(admission.admin_runtime_id) || admission.instance_id !== scope.state.health.root_proof.instance_id
      || admission.mm_sha256 !== hash(self) || Object.keys(scope.request).some(key => admission[key] !== scope.request[key])
      || options.coordinator.parent !== self.pid || options.coordinator.owner !== self.owner || !native.sameProcess(options.coordinator, native.inspectProcess(options.coordinator.pid))) fail()
    const check = () => {
      ctx.verify()
      if (cliLockToken(path.join(ctx.data, 'cli.lock')) !== token || !native.sameProcess(self, native.inspectProcess(process.pid))
        || !native.sameProcess(options.coordinator, native.inspectProcess(options.coordinator.pid))
        || readWorkspaceRecoveryAdmissionScope(ctx.data, scope.request).fingerprint !== scope.fingerprint) fail()
    }
    await options.verify(); check()
    if (!exists(ctx.parent)) {
      if (process.platform === 'win32') native.createPrivateDirectory(ctx.parent)
      else fs.mkdirSync(ctx.parent, { mode: 0o700 })
    }
    const parent = frame(ctx.parent)
    if (exists(ctx.directory)) fail()
    check()
    if (process.platform === 'win32') native.createPrivateDirectory(ctx.directory)
    else fs.mkdirSync(ctx.directory, { mode: 0o700 })
    const directory = frame(ctx.directory)
    const verify = () => { check(); if (hash(frame(ctx.parent)) !== hash(parent) || hash(frame(ctx.directory)) !== hash(directory)) fail() }
    const record = { schema_version: 1, request: scope.request, admission_sha256: hash(admission), parent: self, process: { ...options.coordinator },
      data_root: ctx.dataFrame, control_root: directory, created_at: new Date().toISOString() }
    await options.verify(); verify()
    publish(ctx, 'launch.json', record, verify)
    await options.verify(); verify()
    const stored = readWorkspaceRecoveryCoordinator(ctx.data, scope.request.recovery_id)
    if (hash(stored.launch) !== hash(record) || stored.ready) fail()
    return stored.launch
  } catch { fail() }
}
export async function commitWorkspaceRecoveryCoordinatorReady(options) {
  try {
    if (!exact(options, ['dataDir', 'recoveryId', 'launchHash']) || !digest(options.launchHash)) fail()
    const ctx = context(options.dataDir, options.recoveryId), current = readWorkspaceRecoveryCoordinator(ctx.data, options.recoveryId), launch = current.launch
    const token = cliLockToken(path.join(ctx.data, 'cli.lock')), self = native.inspectProcess(process.pid)
    if (!launch || current.ready || hash(launch) !== options.launchHash || !token || !native.sameProcess(launch.process, self)) fail()
    const scope = readWorkspaceRecoveryAdmissionScope(ctx.data, launch.request), directory = frame(ctx.directory)
    const verify = () => {
      ctx.verify()
      if (cliLockToken(path.join(ctx.data, 'cli.lock')) !== token || !native.sameProcess(self, native.inspectProcess(process.pid))
        || !native.sameProcess(launch.parent, native.inspectProcess(launch.parent.pid)) || hash(frame(ctx.directory)) !== hash(directory)
        || readWorkspaceRecoveryAdmissionScope(ctx.data, launch.request).fingerprint !== scope.fingerprint
        || hash(read(ctx.directory, 'launch.json')) !== options.launchHash) fail()
    }
    const record = { schema_version: 1, recovery_id: options.recoveryId, launch_sha256: options.launchHash, created_at: new Date().toISOString() }
    publish(ctx, 'ready.json', record, verify)
    const stored = readWorkspaceRecoveryCoordinator(ctx.data, options.recoveryId)
    if (hash(stored.ready) !== hash(record)) fail()
    return stored.ready
  } catch { fail() }
}

function runtimePlan(launch, state, record) {
  const targets = state.health.modules.map(module => module.module_id).sort()
  const old = new Set([...state.health.modules, ...state.modules.modules].map(module => module.runtime_id).filter(Boolean))
  if (!exact(record, ['schema_version', 'recovery_id', 'launch_sha256', 'root_selected_sha256', 'modules', 'created_at']) || record.schema_version !== 1
    || record.recovery_id !== launch.request.recovery_id || record.launch_sha256 !== hash(launch) || record.root_selected_sha256 !== hash(state.selected)
    || !date(record.created_at) || !Array.isArray(record.modules) || record.modules.length !== targets.length) fail()
  const ids = new Set()
  for (const [index, module] of record.modules.entries()) {
    if (!exact(module, ['module_id', 'runtime_id']) || !['crabot-agent', 'memory-default'].includes(module.module_id)
      || module.module_id !== targets[index] || !uuid(module.runtime_id) || old.has(module.runtime_id) || ids.has(module.runtime_id)) fail()
    ids.add(module.runtime_id)
  }
  return record
}
/** Historical ownership hint only, never a startup permit or proof that a runtime exists. */
export function readWorkspaceRecoveryRuntimePlan(dataDir, recoveryId) {
  try { return observeWorkspaceRelocationRecords(() => {
    const ctx = context(dataDir, recoveryId), coordinator = readWorkspaceRecoveryCoordinator(dataDir, recoveryId)
    if (!coordinator.launch || !coordinator.ready) return null
    const directory = frame(ctx.directory), parent = frame(ctx.parent)
    if (!exists(path.join(ctx.directory, 'runtime-plan.json'))) return null
    const record = read(ctx.directory, 'runtime-plan.json')
    const state = readWorkspaceRelocationArchivedState(dataDir, coordinator.launch.request.intent_id)
    runtimePlan(coordinator.launch, state, record)
    ctx.verify()
    if (hash(frame(ctx.directory)) !== hash(directory) || hash(frame(ctx.parent)) !== hash(parent)) fail()
    return record
  }) } catch { fail() }
}
export async function commitWorkspaceRecoveryRuntimePlan(options) {
  try {
    if (!exact(options, ['dataDir', 'recoveryId', 'modules', 'verify']) || typeof options.verify !== 'function' || process.versions.electron) fail()
    const ctx = context(options.dataDir, options.recoveryId), coordinator = readWorkspaceRecoveryCoordinator(ctx.data, options.recoveryId)
    const launch = coordinator.launch, self = native.inspectProcess(process.pid)
    if (!launch || !coordinator.ready || !native.sameProcess(launch.parent, self)) fail()
    const scope = readWorkspaceRecoveryAdmissionScope(ctx.data, launch.request), directory = frame(ctx.directory), parent = frame(ctx.parent)
    const record = runtimePlan(launch, scope.state, { schema_version: 1, recovery_id: options.recoveryId, launch_sha256: hash(launch),
      root_selected_sha256: hash(scope.state.selected), modules: structuredClone(options.modules), created_at: new Date().toISOString() })
    const check = () => {
      ctx.verify()
      if (!native.sameProcess(self, native.inspectProcess(process.pid)) || !native.sameProcess(launch.process, native.inspectProcess(launch.process.pid))
        || hash(frame(ctx.directory)) !== hash(directory) || hash(frame(ctx.parent)) !== hash(parent)
        || hash(readWorkspaceRecoveryCoordinator(ctx.data, options.recoveryId)) !== hash(coordinator)
        || readWorkspaceRecoveryAdmissionScope(ctx.data, launch.request).fingerprint !== scope.fingerprint) fail()
    }
    await options.verify(); check()
    publish(ctx, 'runtime-plan.json', record, check)
    await options.verify(); check()
    const stored = readWorkspaceRecoveryRuntimePlan(ctx.data, options.recoveryId)
    if (hash(stored) !== hash(record)) fail()
    return stored
  } catch { fail() }
}


const coreModule = value => ['crabot-agent', 'memory-default'].includes(value)
function runtimeStart(coordinator, plan, state, moduleId, record) {
  const target = plan?.modules.find(module => module.module_id === moduleId), runtime = record?.runtime
  const scope = state.modules.modules.find(module => module.module_id === moduleId)
  if (!target || !scope || !exact(record, ['schema_version', 'recovery_id', 'plan_sha256', 'definition_sha256', 'parent', 'process', 'runtime', 'created_at'])
    || record.schema_version !== 1 || record.recovery_id !== coordinator.launch.request.recovery_id || record.plan_sha256 !== hash(plan)
    || !digest(record.definition_sha256) || !date(record.created_at) || !processIdentity(record.parent) || !processIdentity(record.process)
    || hash(record.parent) !== hash(coordinator.launch.parent) || record.process.parent !== record.parent.pid || record.process.owner !== record.parent.owner
    || record.process.executable !== record.parent.executable || record.process.pid === record.parent.pid || !owned.processBirthAtLeast(record.process.started, record.parent.started)
    || !exact(runtime, ['schema_version', 'instance_id', 'runtime_id', 'module_id', 'root_pid', 'process_start_identity', 'module_port', 'created_at'])
    || runtime.schema_version !== 1 || runtime.instance_id !== state.health.root_proof.instance_id || runtime.runtime_id !== target.runtime_id || runtime.module_id !== moduleId
    || runtime.root_pid !== record.process.pid || runtime.module_port !== scope.module_port || typeof runtime.process_start_identity !== 'string'
    || !runtime.process_start_identity || runtime.process_start_identity.includes('\0') || !date(runtime.created_at)) fail()
  return record
}
function registration(ctx, runtimeId, flush = false) {
  const directory = path.join(ctx.data, 'module-runtime-registry'), entries = path.join(directory, 'records')
  const before = [frame(directory, false), frame(entries, false)], record = read(entries, runtimeId + '.json', false, flush)
  const instanceId = read(directory, 'instance-id', false, flush, value => value.trim())
  if (flush) { sync(entries); sync(directory); sync(ctx.data) }
  ctx.verify()
  if (!record || instanceId !== record.instance_id || hash(before) !== hash([frame(directory, false), frame(entries, false)])) fail()
  return record
}
/** Immutable technical facts, not a live process or startup authorization. */
export function readWorkspaceRecoveryRuntimeStart(dataDir, recoveryId, moduleId) {
  try { return observeWorkspaceRelocationRecords(() => {
    if (!coreModule(moduleId)) fail()
    const ctx = context(dataDir, recoveryId), coordinator = readWorkspaceRecoveryCoordinator(dataDir, recoveryId), plan = readWorkspaceRecoveryRuntimePlan(dataDir, recoveryId)
    if (!coordinator.launch || !coordinator.ready || !plan) fail()
    const starts = path.join(ctx.directory, 'runtime-starts')
    if (!exists(starts)) return null
    const before = frame(starts), record = read(starts, moduleId + '.json')
    if (!exists(path.join(starts, moduleId + '.json'))) return null
    const state = readWorkspaceRelocationArchivedState(dataDir, coordinator.launch.request.intent_id)
    runtimeStart(coordinator, plan, state, moduleId, record)
    ctx.verify()
    if (hash(before) !== hash(frame(starts))) fail()
    return record
  }) } catch { fail() }
}
/** Current facts only; callers retain their own private live permit. */
export function verifyWorkspaceRecoveryRuntimeStart({ dataDir, recoveryId, moduleId, recordHash, definitionHash }) {
  try { return observeWorkspaceRelocationRecords(() => {
    if (!digest(recordHash) || !digest(definitionHash)) fail()
    const ctx = context(dataDir, recoveryId), coordinator = readWorkspaceRecoveryCoordinator(dataDir, recoveryId)
    const record = readWorkspaceRecoveryRuntimeStart(dataDir, recoveryId, moduleId)
    if (!record || hash(record) !== recordHash || record.definition_sha256 !== definitionHash
      || !native.sameProcess(record.parent, native.inspectProcess(record.parent.pid)) || !native.sameProcess(record.process, native.inspectProcess(record.process.pid))
      || !native.sameProcess(coordinator.launch.process, native.inspectProcess(coordinator.launch.process.pid))
      || hash(registration(ctx, record.runtime.runtime_id)) !== hash(record.runtime)) fail()
    readWorkspaceRecoveryCompletionScope(dataDir, coordinator.launch.request)
    return record
  }) } catch { fail() }
}
export async function commitWorkspaceRecoveryRuntimeStart(options) {
  try {
    if (!exact(options, ['dataDir', 'recoveryId', 'moduleId', 'process', 'runtime', 'definitionHash', 'verify']) || !coreModule(options.moduleId)
      || typeof options.verify !== 'function' || !digest(options.definitionHash) || process.versions.electron) fail()
    const ctx = context(options.dataDir, options.recoveryId), coordinator = readWorkspaceRecoveryCoordinator(ctx.data, options.recoveryId)
    const plan = readWorkspaceRecoveryRuntimePlan(ctx.data, options.recoveryId), self = native.inspectProcess(process.pid)
    if (!coordinator.launch || !coordinator.ready || !plan || !native.sameProcess(coordinator.launch.parent, self)) fail()
    const scope = readWorkspaceRecoveryAdmissionScope(ctx.data, coordinator.launch.request)
    const record = runtimeStart(coordinator, plan, scope.state, options.moduleId, { schema_version: 1, recovery_id: options.recoveryId,
      plan_sha256: hash(plan), definition_sha256: options.definitionHash, parent: self, process: structuredClone(options.process), runtime: structuredClone(options.runtime), created_at: new Date().toISOString() })
    const originalDirectory = frame(ctx.directory), starts = path.join(ctx.directory, 'runtime-starts')
    const check = () => {
      ctx.verify()
      if (hash(frame(ctx.directory)) !== hash(originalDirectory) || !native.sameProcess(self, native.inspectProcess(process.pid))
        || !native.sameProcess(record.process, native.inspectProcess(record.process.pid)) || !native.sameProcess(coordinator.launch.process, native.inspectProcess(coordinator.launch.process.pid))
        || hash(readWorkspaceRecoveryCoordinator(ctx.data, options.recoveryId)) !== hash(coordinator) || hash(readWorkspaceRecoveryRuntimePlan(ctx.data, options.recoveryId)) !== hash(plan)
        || hash(registration(ctx, record.runtime.runtime_id)) !== hash(record.runtime) || readWorkspaceRecoveryAdmissionScope(ctx.data, coordinator.launch.request).fingerprint !== scope.fingerprint) fail()
    }
    await options.verify(); check()
    if (hash(registration(ctx, record.runtime.runtime_id, true)) !== hash(record.runtime)) fail()
    if (!exists(starts)) {
      if (process.platform === 'win32') native.createPrivateDirectory(starts)
      else fs.mkdirSync(starts, { mode: 0o700 })
    }
    const startsFrame = frame(starts)
    const verify = () => { check(); if (hash(frame(starts)) !== hash(startsFrame)) fail() }
    await options.verify(); verify()
    publish({ ...ctx, directory: starts, parent: ctx.directory }, options.moduleId + '.json', record, verify)
    await options.verify(); verify()
    if (hash(readWorkspaceRecoveryRuntimeStart(ctx.data, options.recoveryId, options.moduleId)) !== hash(record)) fail()
    return record
  } catch { fail() }
}

/** Existing ownership facts only; neither a live role nor a complete-exit proof. */
export function readWorkspaceRecoveryRuntimeHistory(dataDir, input) {
  try {
    const scope = readWorkspaceRecoveryAdmissionScope(dataDir, input), request = scope.request, ctx = context(dataDir, request.recovery_id)
    if (!exists(ctx.parent)) return Object.freeze([])
    const parent = frame(ctx.parent), entries = fs.readdirSync(ctx.parent).sort(), history = []
    for (const id of entries) {
      if (!uuid(id)) fail()
      if (id === request.recovery_id) continue
      const directory = path.join(ctx.parent, id), before = frame(directory), startsDirectory = path.join(directory, 'runtime-starts')
      if (!exists(path.join(directory, 'runtime-plan.json'))) {
        // Initialization without a plan cannot contribute any module runtime scope.
        if (exists(startsDirectory) || hash(frame(directory)) !== hash(before)) fail()
        continue
      }
      const coordinator = readWorkspaceRecoveryCoordinator(ctx.data, id), previous = coordinator.launch?.request
      if (!previous || !coordinator.ready) fail()
      if (previous.intent_id !== request.intent_id) {
        if (hash(frame(directory)) !== hash(before)) fail()
        continue
      }
      if (previous.completion_sha256 !== request.completion_sha256 || previous.finalizing_sha256 !== request.finalizing_sha256) fail()
      const plan = readWorkspaceRecoveryRuntimePlan(ctx.data, id), starts = []
      if (!plan || plan.launch_sha256 !== hash(coordinator.launch)) fail()
      if (exists(startsDirectory)) {
        const startsFrame = frame(startsDirectory), names = fs.readdirSync(startsDirectory).sort()
        if (names.some(name => !plan.modules.some(module => name === module.module_id + '.json'))) fail()
        for (const module of plan.modules) {
          const record = readWorkspaceRecoveryRuntimeStart(ctx.data, id, module.module_id)
          if (record) {
            if (record.plan_sha256 !== hash(plan)) fail()
            starts.push(record)
          }
        }
        if (hash(frame(startsDirectory)) !== hash(startsFrame) || hash(fs.readdirSync(startsDirectory).sort()) !== hash(names)) fail()
      }
      if (hash(frame(directory)) !== hash(before) || hash(readWorkspaceRecoveryCoordinator(ctx.data, id)) !== hash(coordinator)
        || hash(readWorkspaceRecoveryRuntimePlan(ctx.data, id)) !== hash(plan)
        || starts.some(record => hash(readWorkspaceRecoveryRuntimeStart(ctx.data, id, record.runtime.module_id)) !== hash(record))) fail()
      history.push({ recovery_id: id, coordinator, plan, starts })
    }
    ctx.verify()
    if (hash(frame(ctx.parent)) !== hash(parent) || hash(fs.readdirSync(ctx.parent).sort()) !== hash(entries)
      || readWorkspaceRecoveryAdmissionScope(ctx.data, request).fingerprint !== scope.fingerprint) fail()
    return Object.freeze(history)
  } catch { fail() }
}
