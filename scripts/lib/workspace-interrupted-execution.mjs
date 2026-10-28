// Current precommit execution settlement only. Original coordinator records stay unchanged.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
import exits from './known-process-exit.cjs'
import { readWorkspaceInterruptedRecoveryRole, assertWorkspaceInterruptedActorsExited } from './workspace-interrupted-role.mjs'
import { assertWorkspaceExecutionScopeShape } from './workspace-relocation-intent.mjs'
import { createWorkspaceMaintenanceFileAccess } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'
import { sha256CanonicalJson as hash } from '../../crabot-shared/dist/canonical-json.js'
const failure = () => Object.assign(new Error('原执行停止尚未核实，原文件与维护保护已保留；未重发未知停止。'), { code: 'WORKSPACE_RELOCATION_INVALID' })
const { owned, readJson, publish } = createWorkspaceMaintenanceFileAccess(failure)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const kinds = ['workers', 'modules', 'processes']
const processKey = item => item.pid + ':' + item.started
const sortedProcesses = values => [...new Map(values.map(item => [processKey(item), item])).values()].sort((a, b) => a.pid - b.pid || a.started.localeCompare(b.started))
export function workspaceOriginalExecutionNeedsSettlement(checkpoint) {
  const workersSettled = !checkpoint.stops?.attempt || checkpoint.stops.submission && !checkpoint.stops.submission.results.some(item => item.status === 'unknown')
  return checkpoint.action === 'restore_source' && workersSettled && !checkpoint.module_stops?.attempt
    && !checkpoint.execution_exit && !checkpoint.file_plan && !checkpoint.file_actors && !checkpoint.closure_plan
}
function context(dataDir, recoveryId, checkpoint) {
  const role = readWorkspaceInterruptedRecoveryRole(dataDir, recoveryId)
  if (!role.launch || !role.ready || role.launch.action !== 'restore_source' || role.launch.request.intent_id !== checkpoint.intent.id
    || role.launch.request.checkpoint_sha256 !== checkpoint.checkpoint_sha256 || !workspaceOriginalExecutionNeedsSettlement(checkpoint)) throw failure()
  const directory = role.launch.control_root.path, signature = hash(role)
  const base = { schema_version: 2, recovery_id: recoveryId, launch_sha256: hash(role.launch), checkpoint_sha256: checkpoint.checkpoint_sha256 }
  const verify = () => { if (hash(readWorkspaceInterruptedRecoveryRole(dataDir, recoveryId)) !== signature) throw failure() }
  return { role, directory, base, verify, checkpoint }
}
function planValue(value, ctx, checkpoint) {
  if (!exact(value, [...Object.keys(ctx.base), 'scope']) || Object.keys(ctx.base).some(key => value[key] !== ctx.base[key])) throw failure()
  assertWorkspaceExecutionScopeShape(value.scope)
  if (checkpoint.workers && hash(value.scope.workers) !== hash(checkpoint.workers.workers)) throw failure()
  if (checkpoint.modules && hash(value.scope.modules) !== hash(checkpoint.modules.modules)) throw failure()
  if (checkpoint.processes && checkpoint.processes.processes.some(item => !value.scope.processes.some(actual => hash(item) === hash(actual)))) throw failure()
  return value
}
function readPlan(ctx, checkpoint) {
  const value = readJson(path.join(ctx.directory, 'execution-plan.json'), 32 * 1024 * 1024)
  return value ? planValue(value, ctx, checkpoint) : null
}
function record(ctx, plan, kind, name) {
  const value = readJson(path.join(ctx.directory, kind + '-' + name + '.json'), 32 * 1024 * 1024) ?? null
  if (value && (value.schema_version !== 2 || value.recovery_id !== ctx.base.recovery_id || value.plan_sha256 !== hash(plan) || value.kind !== kind)) throw failure()
  return value
}
function resultsCurrent(kind, results, scope) {
  if (kind === 'processes') return exact(results, [])
  if (!Array.isArray(results)) return false
  if (kind === 'workers') {
    const expected = scope.workers.flatMap(worker => worker.incarnations.map(item => ({ worker_id: worker.worker_id, incarnation_id: item.incarnation_id })))
    return results.length === expected.length && results.every((item, index) => exact(item, ['worker_id', 'incarnation_id', 'status'])
      && item.worker_id === expected[index].worker_id && item.incarnation_id === expected[index].incarnation_id && ['submitted', 'unknown', 'unavailable'].includes(item.status))
  }
  return results.length === scope.modules.length && results.every((item, index) => {
    const module = scope.modules[index]
    return exact(item, ['module_id', ...(module.runtime_id ? ['runtime_id'] : []), 'shutdown', 'status'])
      && item.module_id === module.module_id && item.runtime_id === module.runtime_id
      && ['not_submitted', 'submitted', 'unknown'].includes(item.shutdown) && ['inactive', 'known_scope_exited', 'unknown'].includes(item.status)
  })
}
function readState(ctx, plan) {
  const attempts = {}, completions = {}
  for (const kind of kinds) {
    const attempt = record(ctx, plan, kind, 'attempt'), complete = record(ctx, plan, kind, 'complete')
    const keys = ['schema_version', 'recovery_id', 'plan_sha256', 'kind']
    if (attempt && !exact(attempt, keys) || complete && (!attempt || !exact(complete, [...keys, 'results']) || !resultsCurrent(kind, complete.results, plan.scope))) throw failure()
    attempts[kind] = attempt; completions[kind] = complete
  }
  if (ctx.checkpoint.stops?.submission) {
    if (attempts.workers || completions.workers) throw failure()
    completions.workers = { original_sha256: hash(ctx.checkpoint.stops.submission), results: ctx.checkpoint.stops.submission.results }
  }
  const observations = [], folder = path.join(ctx.directory, 'execution-observations')
  if (fs.existsSync(folder)) {
    owned(folder, true, true)
    const names = fs.readdirSync(folder)
    for (let index = 0; index < names.length; index++) {
      const value = readJson(path.join(folder, index + '.json'), 32 * 1024 * 1024)
      if (!value || !exact(value, ['schema_version', 'recovery_id', 'plan_sha256', 'sequence', 'previous_sha256', 'module_id', 'processes'])
        || value.schema_version !== 2 || value.recovery_id !== ctx.base.recovery_id || value.plan_sha256 !== hash(plan)
        || value.sequence !== index || value.previous_sha256 !== hash(observations.at(-1) ?? plan)
        || value.module_id !== null && !plan.scope.modules.some(item => item.module_id === value.module_id)) throw failure()
      assertWorkspaceExecutionScopeShape({ workers: [], modules: [], processes: value.processes })
      observations.push(value)
    }
    if (hash(fs.readdirSync(folder).sort()) !== hash(names.sort())) throw failure()
  }
  const processes = sortedProcesses([...plan.scope.processes, ...plan.scope.modules.flatMap(item => item.processes), ...observations.flatMap(item => item.processes)])
  return { attempts, completions, observations, processes }
}
function knownCompletions(state) {
  return state && state.attempts.processes && state.observations.some(item => item.module_id === null)
    && state.completions.workers && state.completions.modules && !state.completions.workers.results.some(item => item.status === 'unknown')
    && !state.completions.modules.results.some(item => item.status === 'unknown')
}
function completed(ctx, plan) {
  const state = readState(ctx, plan), proof = readJson(path.join(ctx.directory, 'early-execution-exit.json'))
  if (!proof) return { ...state, proof: null }
  if (!knownCompletions(state) || !exact(proof, ['schema_version', 'recovery_id', 'plan_sha256', 'state_sha256']) || proof.schema_version !== 2
    || proof.recovery_id !== ctx.base.recovery_id || proof.plan_sha256 !== hash(plan) || proof.state_sha256 !== hash(state)) throw failure()
  return { ...state, proof }
}
/** Historical fixed scope only. An incomplete prior submission is never a new dispatch permit. */
export function readWorkspaceInterruptedEarlyExecution(dataDir, checkpoint) {
  if (!workspaceOriginalExecutionNeedsSettlement(checkpoint)) return null
  const parent = path.join(dataDir, 'workspace-control/relocation-recovery')
  if (!fs.existsSync(parent)) return null
  owned(parent, true, true)
  let found = null
  for (const id of fs.readdirSync(parent).sort()) {
    const entry = readJson(path.join(parent, id, 'launch.json'))
    if (entry?.schema_version !== 2 || entry.request?.intent_id !== checkpoint.intent.id) continue
    const role = readWorkspaceInterruptedRecoveryRole(dataDir, id)
    if (role.launch?.schema_version !== 2 || hash(role.launch.request) !== hash({ intent_id: checkpoint.intent.id, recovery_id: id, checkpoint_sha256: checkpoint.checkpoint_sha256 })) continue
    if (!fs.existsSync(path.join(parent, id, 'execution-plan.json'))) continue
    const ctx = context(dataDir, id, checkpoint), plan = readPlan(ctx, checkpoint)
    if (!plan) continue
    const state = completed(ctx, plan)
    if (found && (hash(found.plan.scope) !== hash(plan.scope) || kinds.some(kind => found.attempts[kind]) && kinds.some(kind => state.attempts[kind]))) throw failure()
    if (!found || kinds.some(kind => state.attempts[kind])) found = { plan, ...state }
  }
  return found
}
/** Missing final summary never re-dispatches settled stops; verify the actual known exits now. */
export function assertWorkspaceInterruptedEarlyExecutionExited(early) {
  if (!knownCompletions(early) || exits.probeKnownProcessExit(early.processes).state !== 'stopped') throw failure()
  return hash(early)
}
/** Worker scope is read in the original Agent; Core independently validates the complete plan. */
export function readWorkspaceInterruptedExecutionWorkers(dataDir, recoveryId, scopeHash) {
  const role = readWorkspaceInterruptedRecoveryRole(dataDir, recoveryId)
  if (!role.launch || !role.ready || role.launch.action !== 'restore_source') throw failure()
  const plan = readJson(path.join(role.launch.control_root.path, 'execution-plan.json'), 32 * 1024 * 1024)
  if (!plan || plan.launch_sha256 !== hash(role.launch) || plan.recovery_id !== recoveryId || hash(plan.scope) !== scopeHash) throw failure()
  assertWorkspaceExecutionScopeShape({ workers: plan.scope.workers, modules: [], processes: [] })
  return Object.freeze(structuredClone(plan.scope.workers))
}
/** Original technical module scope, or the current recovery's own completed early scope. */
export function readWorkspaceInterruptedOriginalModules(dataDir, checkpoint) {
  if (checkpoint.modules) return checkpoint.modules.modules
  const early = readWorkspaceInterruptedEarlyExecution(dataDir, checkpoint)
  if (!knownCompletions(early)) throw failure()
  return early.plan.scope.modules
}
/** Effects belong to the current Core and actual new Node lock holder, never the old role. */
export async function createWorkspaceInterruptedExecutionJournal({ dataDir, recoveryId, checkpoint, scope, verify }) {
  if (typeof verify !== 'function' || process.versions.electron) throw failure()
  assertWorkspaceInterruptedActorsExited(checkpoint)
  const fixed = { ...scope, processes: sortedProcesses([...(checkpoint.processes?.processes ?? []), ...scope.processes]) }
  const previous = readWorkspaceInterruptedEarlyExecution(dataDir, checkpoint)
  if (previous && (kinds.some(kind => previous.attempts[kind]) || hash(previous.plan.scope) !== hash(fixed))) throw failure()
  const ctx = context(dataDir, recoveryId, checkpoint), self = native.inspectProcess(process.pid)
  const current = () => {
    ctx.verify()
    if (!native.sameProcess(ctx.role.launch.parent, self) || !native.sameProcess(self, native.inspectProcess(process.pid))
      || !native.sameProcess(ctx.role.launch.process, native.inspectProcess(ctx.role.launch.process.pid))) throw failure()
  }
  const check = async () => { await verify(); current() }
  await check()
  const plan = planValue({ ...ctx.base, scope: structuredClone(fixed) }, ctx, checkpoint)
  publish(ctx.directory, 'execution-plan.json', plan, current, 32 * 1024 * 1024)
  const header = kind => ({ schema_version: 2, recovery_id: recoveryId, plan_sha256: hash(plan), kind })
  const prepare = async kind => {
    await check()
    if (!kinds.includes(kind) || kind === 'workers' && checkpoint.stops?.submission) throw failure()
    if (record(ctx, plan, kind, 'attempt')) return 'observe'
    publish(ctx.directory, kind + '-attempt.json', header(kind), current)
    await check(); return 'dispatch'
  }
  const complete = async (kind, results) => {
    await check()
    if (!kinds.includes(kind)) throw failure()
    if (!record(ctx, plan, kind, 'attempt') || !resultsCurrent(kind, results, plan.scope)) throw failure()
    const value = { ...header(kind), results: structuredClone(results) }, prior = record(ctx, plan, kind, 'complete')
    if (prior && hash(prior) !== hash(value)) throw failure()
    if (!prior) publish(ctx.directory, kind + '-complete.json', value, current, 32 * 1024 * 1024)
    await check()
  }
  let observationQueue = Promise.resolve()
  const observe = (moduleId, processes) => {
    observationQueue = observationQueue.then(async () => {
      await check()
      const state = readState(ctx, plan), folder = path.join(ctx.directory, 'execution-observations')
      assertWorkspaceExecutionScopeShape({ workers: [], modules: [], processes })
      if (moduleId !== null && !plan.scope.modules.some(item => item.module_id === moduleId)) throw failure()
      const kind = moduleId === null ? 'processes' : 'modules'
      if (!state.attempts[kind]) throw failure()
      if (!fs.existsSync(folder)) {
        if (process.platform === 'win32') native.createPrivateDirectory(folder)
        else fs.mkdirSync(folder, { mode: 0o700 })
      }
      publish(folder, state.observations.length + '.json', { schema_version: 2, recovery_id: recoveryId, plan_sha256: hash(plan), sequence: state.observations.length,
        previous_sha256: hash(state.observations.at(-1) ?? plan), module_id: moduleId, processes: structuredClone(processes) }, current, 32 * 1024 * 1024)
      await check()
    })
    return observationQueue
  }
  return Object.freeze({ plan, prepare, complete, observe, async finish() {
    await observationQueue; await check()
    const state = readState(ctx, plan)
    if (!knownCompletions(state) || !state.completions.processes || exits.probeKnownProcessExit(state.processes).state !== 'stopped') throw failure()
    publish(ctx.directory, 'early-execution-exit.json', { schema_version: 2, recovery_id: recoveryId, plan_sha256: hash(plan), state_sha256: hash(state) }, current)
    await check()
    return readWorkspaceInterruptedEarlyExecution(dataDir, checkpoint)
  } })
}
