import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { systemError } from './system-registry.mjs'
const execute = promisify(execFile)
export function coordinatorUnit(record) {
  const id = record.recovery?.id ?? record.plan.id
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id ?? '')) throw systemError('协调作业编号不兼容。')
  return (record.recovery ? 'crabot-recovery-' : 'crabot-operation-') + id
}
function coordinatorFields(text) {
  const fields = Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]
  }))
  return fields
}
export function coordinatorStopped(text) {
  const fields = coordinatorFields(text)
  if (!['loaded', 'not-found'].includes(fields.LoadState) || !['inactive', 'failed'].includes(fields.ActiveState)
    || fields.MainPID !== '0' || !['0', '[not set]'].includes(fields.TasksCurrent)
    || fields.ControlGroup && fields.TasksCurrent !== '0') return false
  return fields.LoadState !== 'not-found' || !fields.ControlGroup
}
export async function assertCoordinatorStopped(record, run = execute) {
  let text
  try {
    const response = await run('/usr/bin/systemctl', ['show', coordinatorUnit(record), '--all', '--property=LoadState,ActiveState,MainPID,TasksCurrent,ControlGroup'],
      { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, cwd: '/', timeout: 5000, maxBuffer: 16384 })
    text = response.stdout
  } catch (error) {
    if (error.code !== 1 || typeof error.stdout !== 'string') throw systemError('协调服务状态无法核验，未进入恢复。')
    text = error.stdout
  }
  if (!coordinatorStopped(text)) throw systemError('协调作业或遗留子进程尚未确认退出，请等待并检查system status；未重放任何动作。', 'CRABOT_SYSTEM_OPERATION_ACTIVE')
}

export function coordinatorRunning(text) {
  const fields = coordinatorFields(text)
  return fields.LoadState === 'loaded' && fields.ActiveState === 'active'
    && /^[1-9][0-9]*$/.test(fields.MainPID ?? '') && /^[1-9][0-9]*$/.test(fields.TasksCurrent ?? '')
}
export async function coordinatorIsRunning(maintenance, run = execute) {
  const record = { plan: { id: maintenance.id }, ...(maintenance.recovery_id ? { recovery: { id: maintenance.recovery_id } } : {}) }
  try {
    const result = await run('/usr/bin/systemctl', ['show', coordinatorUnit(record), '--all', '--property=LoadState,ActiveState,MainPID,TasksCurrent'],
      { env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, cwd: '/', timeout: 5000, maxBuffer: 16384 })
    return coordinatorRunning(result.stdout)
  } catch { return false }
}
