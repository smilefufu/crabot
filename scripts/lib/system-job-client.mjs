// CLI attachment is optional; the administrator job runs in its own system unit.
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { verifyRootExecutable } from './system-user.mjs'
import { systemError } from './system-registry.mjs'
const execute = promisify(execFile)
const options = { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, cwd: '/', timeout: 15_000, maxBuffer: 65536 }
export function systemOperationStage(stage) {
  const labels = { batch_dispatched: '按原计划处理实例', stopping: '核对停止集合', stop_dispatched: '停止实例', snapshot_dispatched: '备份配置和数据库',
    snapshot_ready: '备份已验证', selection_dispatched: '切换共享核心', target_selected: '共享核心已切换',
    migration_dispatched: '迁移本人数据', migration_completed: '本人数据迁移完成', target_start_dispatched: '恢复原运行实例',
    source_preparation_cancel_dispatched: '撤销未改数据的准备', source_start_dispatched: '恢复原版本实例', selection_unsettled: '共享切换结果待核对' }
  return labels[stage] ?? '核验实例状态'
}
export async function submitSystemOperation(plan, { root, store, recoveryId, log = console.log, run = execute }) {
  if (!recoveryId) await store.prepare(plan)
  const node = verifyRootExecutable(path.join(root, '.product-runtime/node/bin/node'))
  const job = verifyRootExecutable(path.join(root, 'scripts/system-job.mjs'))
  const unit = recoveryId ? 'crabot-recovery-' + recoveryId : 'crabot-operation-' + plan.id
  await run('/usr/bin/systemd-run', ['--quiet', '--unit=' + unit, '--service-type=exec',
    '--property=WorkingDirectory=/', '--property=Restart=no', '--property=TasksAccounting=yes', node, job, plan.id, ...(recoveryId ? [recoveryId] : [])], options)
  log('已提交作业 ' + plan.id + '；SSH断开后继续，可运行sudo crabot system status查看。')
  const displayed = new Map()
  let lastStage
  for (;;) {
    const current = store.read(store.file(plan.id), true), progress = current.progress
    const stage = progress && String(progress.current_uid ?? '') + ':' + String(progress.stage ?? '')
    if (progress?.current_uid && stage !== lastStage) {
      const user = (plan.instances ?? plan.items).find(item => item.entry.uid === progress.current_uid)?.entry.user
      log('正在处理 ' + user + '：' + systemOperationStage(progress.stage))
    }
    lastStage = stage
    for (const row of progress?.results ?? []) {
      if (row.state === 'pending') continue
      const summary = row.state + (row.message || row.error?.message ? '：' + (row.message ?? row.error.message) : '')
      if (displayed.get(row.uid) !== summary) { log(row.user + '\t' + summary); displayed.set(row.uid, summary) }
    }
    if (current.phase === 'completed' || current.phase === 'interrupted') {
      const completed = store.completion(plan.id)
      log('作业' + (current.phase === 'completed' ? '结束' : '中断，保留维护保护') + '：' + progress.results.length + '个实例。')
      if (progress.error) log(progress.error.message)
      return completed.exit_code ?? 1
    }
    const state = await run('/usr/bin/systemctl', ['show', unit, '--property=ActiveState', '--value'], options)
    if (['failed', 'inactive'].includes(state.stdout.trim())) throw systemError('协调作业已停止，结果需要核对；维护记录保留，请运行system status，不自动重试。', 'CRABOT_SYSTEM_OPERATION_INTERRUPTED')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}
