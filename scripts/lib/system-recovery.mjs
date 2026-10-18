// Recovery consumes root intent and fresh UID observations. It never interprets
// a missing reply as permission to replay a migration or an issued restart.
import { executeSystemUpgrade } from './system-upgrade.mjs'
import { systemError } from './system-registry.mjs'

const unknown = (row, error) => {
  row.state = 'unknown'; row.error = { code: error.code ?? 'CRABOT_SYSTEM_RECOVERY_UNKNOWN', message: error.message }
}
const issued = (prior, previous, uid) => {
  if (previous?.dispatched || (prior?.dispatched ?? []).includes(uid) || prior?.current_uid === uid) return true
  return !prior?.recovery_mode && !Array.isArray(prior?.dispatched) && Boolean(previous)
}
const safe = observation => observation && !observation.maintenance
  && (observation.state === 'stopped' || observation.state === 'running' && observation.ready === true)

export function systemRecoveryOptions(plan, prior, selected) {
  if (plan.kind === 'conversion') throw systemError('旧共享转换必须由专用恢复器核对来源、隔离与本人回执；未按批量或普通升级重放。', 'CRABOT_SYSTEM_CONVERSION_RECOVERY_REQUIRED')
  if (plan.kind !== 'upgrade') return { continue: true, cancel: true }
  if (selected === plan.source.id) {
    const rows = prior?.results ?? []
    if (rows.some(row => ['stop_dispatched', 'snapshot_dispatched', 'migration_dispatched', 'start_dispatched'].some(key => typeof row[key] !== 'boolean'))) throw systemError('根派发记录不兼容，不能猜测恢复阶段。', 'CRABOT_SYSTEM_RECOVERY_UNKNOWN')
    if (rows.some(row => row.migration_dispatched || row.migrated)) throw systemError('根记录已派发迁移但当前选择为原版；不能自动恢复或降级。', 'CRABOT_SYSTEM_RECOVERY_UNKNOWN')
    return { cancel: true, continue: !rows.some(row => row.stop_dispatched || row.snapshot_dispatched || row.start_dispatched) }
  }
  if (selected === plan.target.id) return { continue: true, cancel: false }
  throw systemError('共享核心不属于原作业，未恢复。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
}

export async function executeSystemRecovery(plan, prior, { mode, operations }) {
  if (!['continue', 'cancel'].includes(mode)) throw systemError('请选择继续或取消本次恢复。')
  const selected = plan.kind === 'upgrade' ? await operations.selected() : undefined
  const options = systemRecoveryOptions(plan, prior, selected)
  if (!options[mode]) throw systemError(mode === 'cancel' ? '共享核心已切换；取消不授权自动降级，请选择受保护的继续。' : '原版准备已有派发，请先取消准备并恢复原运行集合，再重新升级。')
  if (plan.kind === 'upgrade' && mode === 'continue' && selected === plan.source.id) return executeSystemUpgrade(plan, operations)
  const items = plan.instances ?? plan.items, original = new Map((prior?.results ?? []).map(row => [row.uid, row]))
  const result = { schema_version: 1, id: plan.id, kind: plan.kind, action: plan.action, phase: 'running', recovery_mode: mode,
    results: items.map(item => ({ ...(plan.kind === 'upgrade' ? { originally_running: item.observation.state === 'running',
      stopped: item.observation.state === 'stopped', stop_dispatched: false, start_dispatched: false,
      snapshot_dispatched: false, migration_dispatched: false, migrated: false, started: false } : {}),
      ...structuredClone(original.get(item.entry.uid) ?? {}), uid: item.entry.uid,
      user: item.entry.user, state: 'pending', ...(plan.kind === 'upgrade' ? {} : { dispatched: issued(prior, original.get(item.entry.uid), item.entry.uid) }) })) }
  const save = async () => {
    try { await operations.save(structuredClone(result)) }
    catch { throw systemError('恢复进度未能完整保存；未继续执行，保护和原记录保留。', 'CRABOT_SYSTEM_JOURNAL_FAILED') }
  }
  const stage = async (name, uid) => {
    result.stage = name; result.current_uid = uid; delete result.allow_start; await save()
  }
  const startVersion = async (entry, row, version) => {
    row.start_dispatched = true; await stage(version + '_start_dispatched', row.uid)
    result.allow_start = { uid: row.uid, core_id: plan[version].id }; await save()
    const start = version === 'source' ? operations.startSource : operations.startTarget
    const started = await start(entry)
    if (started.state !== 'started' && !(started.state === 'skipped' && started.observed_state === 'running')) throw systemError(version === 'source' ? '原版尚未恢复健康。' : '目标实例尚未恢复健康。')
    row.state = 'healthy'; row.started = true; row.generation = started.generation
  }
  await save()
  for (const item of items) {
    const row = result.results.find(value => value.uid === item.entry.uid), previous = original.get(item.entry.uid)
    delete row.error; delete row.code; delete row.message
    if (plan.kind !== 'upgrade' && !row.dispatched && item.observation.state === 'failed') {
      row.state = 'failed'; row.message = item.observation.message; await save(); continue
    }
    try {
      let current = await operations.observe(item.entry)
      if (plan.kind !== 'upgrade') {
        const dispatched = row.dispatched
        if (!dispatched && mode === 'continue') {
          if (['failed', 'unknown'].includes(item.observation.state)) throw systemError('原预检未通过，未扩展本次动作；请处理原因后重新发起批量操作。')
          row.dispatched = true
          result.dispatched ??= []; result.dispatched.push(item.entry.uid)
          await stage('batch_dispatched', item.entry.uid)
          const outcome = await operations.apply(item.entry, plan.action, item.observation)
          if (!['started', 'stopped', 'restarted', 'skipped', 'failed', 'unknown'].includes(outcome?.state)
            || outcome.state === 'skipped' && !['running', 'stopped'].includes(outcome.observed_state)) throw systemError('本人动作没有返回可核实结果。')
          Object.assign(row, outcome)
        } else if (!safe(current)) throw systemError('本人运行或数据状态尚未核验，未重放启停。')
        else {
          row.state = current.state === 'running' ? 'observed_running' : 'observed_stopped'
          row.original_action_unknown = Boolean(dispatched && (!previous || previous.state === 'unknown'))
          row.cancelled = !dispatched && mode === 'cancel'
          row.message = row.original_action_unknown ? '已核对当前状态，原启停结果未知；未重放。' : '已核对当前状态。'
        }
      } else if (selected === plan.source.id) {
        if (current.state === 'stopped') {
          if (previous?.snapshot_dispatched) {
            await stage('source_preparation_cancel_dispatched', row.uid)
            await operations.cancelSnapshot(item.entry, plan.id)
          } else if (current.maintenance) throw systemError('本人存在未归属此次作业的数据维护。')
          if (item.observation.state === 'running' && previous?.stop_dispatched && !previous.start_dispatched && !previous.started) {
            await startVersion(item.entry, row, 'source')
          } else {
            row.state = 'kept_stopped'
            row.original_action_unknown = Boolean(previous?.start_dispatched && !previous.started)
          }
        } else {
          const expected = previous?.started ? previous.generation : item.observation.generation
          if (!safe(current) || current.core_id !== plan.source.id) throw systemError('本人实例尚未健康或原版身份不符，未操作。')
          row.state = expected && current.generation === expected ? 'healthy' : 'observed_running'
          if (row.state === 'observed_running') {
            row.original_action_unknown = true; row.message = '运行代际已变化；当前原版健康，未操作替换实例。'
          }
        }
      } else {
        if (!previous?.snapshot || previous.snapshot.system_operation_id !== plan.id) throw systemError('没有本作业已确认的备份回执，未派发迁移。')
        if (previous.migration_dispatched && !previous.migrated) throw systemError('迁移已派发但完成结果未知；保留维护保护，不自动重跑。', 'CRABOT_SYSTEM_MIGRATION_UNKNOWN')
        if (!previous.migrated) {
          if (current.state !== 'stopped') throw systemError('待迁移用户出现运行实例，未继续。')
          row.migration_dispatched = true; await stage('migration_dispatched', row.uid)
          await operations.migrate(item.entry, previous.snapshot)
          row.migrated = true; await stage('migration_completed', row.uid)
          current = await operations.observe(item.entry)
        }
        if (current.state === 'running') {
          if (!safe(current) || current.core_id !== plan.target.id) throw systemError('目标实例尚未健康或版本不符。')
          row.state = 'healthy'
        } else if (current.state === 'stopped') {
          await operations.checkMigration(item.entry, previous.snapshot)
          if (item.observation.state === 'running' && !previous.start_dispatched && !previous.started) {
            await startVersion(item.entry, row, 'target')
          } else {
            row.state = 'kept_stopped'
            row.original_action_unknown = Boolean(previous.start_dispatched && !previous.started)
          }
        } else throw systemError('本人启动/停止尚未收口，未继续。')
      }
    } catch (error) {
      if (error.code === 'CRABOT_SYSTEM_JOURNAL_FAILED') throw error
      unknown(row, error)
    }
    await save()
  }
  delete result.current_uid; delete result.allow_start
  result.phase = 'completed'
  result.exit_code = mode === 'cancel' || result.results.some(row => ['failed', 'unknown'].includes(row.state) || row.original_action_unknown) ? 1 : 0
  await save(); return result
}
