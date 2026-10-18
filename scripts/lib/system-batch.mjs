// Cross-user orchestration only. The adapter owns UID transition, lifecycle
// locks and the atomic recheck/action; this layer never runs employee code.
import { randomUUID } from 'node:crypto'
import { systemError, validateSystemEntries } from './system-registry.mjs'

const actions = new Set(['start', 'stop', 'restart'])
const fail = message => { throw systemError(message, 'CRABOT_SYSTEM_BATCH_INVALID') }
const uncertain = new Set(['CRABOT_SYSTEM_USER_UNKNOWN', 'CRABOT_SYSTEM_STOP_UNKNOWN', 'CRABOT_SYSTEM_SERVICE_FAILED', 'CRABOT_STOP_UNKNOWN', 'CRABOT_STOP_INCOMPLETE'])
const errorResult = error => ({ state: uncertain.has(error.code) ? 'unknown' : 'failed', code: error.code ?? 'CRABOT_SYSTEM_USER_FAILED', message: error.message })

export async function planSystemBatch(action, entries, inspect) {
  if (!actions.has(action)) fail('批量动作不兼容。')
  validateSystemEntries(entries)
  const items = []
  for (const entry of entries.filter(value => value.enabled)) {
    let observation
    try {
      observation = await inspect(structuredClone(entry))
      if (!observation || !['running', 'starting', 'stopped'].includes(observation.state)
        || observation.state !== 'stopped' && (typeof observation.generation !== 'string' || !observation.generation)) fail('实例身份或运行状态无法核验。')
    } catch (error) { observation = errorResult(error) }
    let mutate = false
    if (!['failed', 'unknown'].includes(observation.state)) {
      if (action === 'start') mutate = observation.state === 'stopped'
      else if (action === 'stop') mutate = observation.state !== 'stopped'
      else mutate = observation.state === 'running'
    }
    items.push({ entry: structuredClone(entry), observation, mutate })
  }
  return { schema_version: 1, id: randomUUID(), action, items,
    confirmation_required: action !== 'start' && items.some(item => item.mutate) }
}

export function requireBatchConfirmation(plan, { yes = false, interactive = false } = {}) {
  if (plan.confirmation_required && !yes && !interactive) throw systemError('非交互批量停止/重启需要--yes；未执行任何动作。', 'CRABOT_SYSTEM_CONFIRMATION_REQUIRED')
  return plan.confirmation_required && !yes
}

export async function executeSystemBatch(plan, { apply, save = async () => {}, progress = () => {} }) {
  if (!plan || plan.schema_version !== 1 || !actions.has(plan.action) || !Array.isArray(plan.items)) fail('批量计划不兼容。')
  validateSystemEntries(plan.items.map(item => item.entry))
  const result = { schema_version: 1, id: plan.id, action: plan.action, phase: 'running', results: [] }
  await save(structuredClone(result))
  for (const item of plan.items) {
    let outcome
    if (['failed', 'unknown'].includes(item.observation.state)) outcome = item.observation
    else {
      // Persist intent before dispatch. If the coordinator disappears after this
      // point, this user remains unknown until inspected, never automatically replayed.
      result.current_uid = item.entry.uid
      await save(structuredClone(result))
      try {
        outcome = await apply(structuredClone(item.entry), plan.action, structuredClone(item.observation))
        if (!outcome || !['started', 'stopped', 'restarted', 'skipped', 'failed', 'unknown'].includes(outcome.state)
          || outcome.state === 'skipped' && !['running', 'stopped'].includes(outcome.observed_state)) fail('用户动作没有返回可核实结果。')
      } catch (error) { outcome = errorResult(error) }
    }
    const row = { uid: item.entry.uid, user: item.entry.user, ...outcome }
    result.results.push(row)
    delete result.current_uid
    await save(structuredClone(result))
    progress(structuredClone(row))
  }
  result.phase = 'completed'
  result.exit_code = result.results.some(row => ['failed', 'unknown'].includes(row.state)) ? 1 : 0
  await save(structuredClone(result))
  return result
}

// Called inside the user's lifecycle lock, immediately before the actual action.
// A plain snapshot comparison outside that lock is not permission to signal.
export function selectSystemUserAction(action, previous, current) {
  if (!actions.has(action) || !previous || !current) fail('实例动作无法核验。')
  if (!['running', 'starting', 'stopped'].includes(current.state)) fail('实例状态未知，未执行动作。')
  if (current.state !== 'stopped' && (typeof current.generation !== 'string' || !current.generation)) fail('实例代际无法核验。')
  if (action === 'restart' && (previous.state === 'stopped' || current.state === 'stopped')) return 'skip'
  if (action === 'restart' && previous.state !== 'running') throw systemError('预览时实例未运行，未发起重启。', 'CRABOT_SYSTEM_INSTANCE_BUSY')
  if (action === 'stop' && previous.state === 'stopped' && current.state !== 'stopped') throw systemError('预览后实例已启动，请重新核对停止影响。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
  if (previous.state !== 'stopped' && current.state !== 'stopped' && previous.generation !== current.generation) {
    throw systemError('预览后实例已替换，未操作新代际。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
  }
  if (action === 'stop') return current.state === 'stopped' ? 'skip' : 'stop'
  if (action === 'start') {
    if (current.state === 'stopped') return 'start'
    if (current.state === 'running' && current.ready === true) return 'skip'
    throw systemError('实例正在启动或尚未健康，未重复启动。', 'CRABOT_SYSTEM_INSTANCE_BUSY')
  }
  if (current.state !== 'running') throw systemError('实例正在启动，未重启。', 'CRABOT_SYSTEM_INSTANCE_BUSY')
  return 'restart'
}
