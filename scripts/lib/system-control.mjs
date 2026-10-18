import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inspectInstance, identity } from './instance-runtime.mjs'
import { stopInstance } from './instance-controller.mjs'
import { acquireCliLock, releaseCliLock } from './cli-lock.mjs'
import { probeMmHealthy, probeMmModules } from './mm-probe.mjs'
import { systemUserEnvironment } from './system-user.mjs'
import { assertSystemControlAvailable } from './system-context.mjs'
import { selectSystemUserAction } from './system-batch.mjs'
import { systemError } from './system-registry.mjs'
import management from './desktop-management.cjs'
import cliLocation from './cli-location.cjs'
import { readVersionMaintenance } from './version-maintenance.mjs'
import { systemdAvailable } from './system-service.mjs'

const execute = promisify(execFile)
export function parseSystemServiceStatus(text) {
  const values = Object.fromEntries(text.trimEnd().split('\n').filter(Boolean).map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]
  }))
  if (!['active', 'activating', 'deactivating', 'inactive', 'failed', 'reloading'].includes(values.ActiveState)
    || !/^[0-9]+$/.test(values.MainPID ?? '') || !Number.isSafeInteger(Number(values.MainPID))
    || !/^(?:[0-9]+|\[not set\])$/.test(values.TasksCurrent ?? '')
    || !/^(?:[a-f0-9]{32})?$/.test(values.InvocationID ?? '')) throw systemError('本人服务状态无法核验。')
  return { state: values.ActiveState, pid: Number(values.MainPID), tasks: values.TasksCurrent === '[not set]' ? null : Number(values.TasksCurrent),
    group: values.ControlGroup, invocation: values.InvocationID }
}

export function reconcileSystemService(current, service, controller, uid) {
  if (service.pid && (!controller || controller.owner !== String(uid))) throw systemError('本人服务主进程身份未知。')
  if (current.state !== 'stopped' && service.pid && !identity.sameProcess(current.record.controller, controller)) {
    throw systemError('服务主进程与原实例记录不一致，未操作替换实例。', 'CRABOT_SYSTEM_INSTANCE_CHANGED')
  }
  if (service.pid) {
    if (!service.invocation) throw systemError('本人服务运行代际缺失。')
    return { state: current.state === 'stopped' ? 'starting' : current.state, generation: 'systemd:' + service.invocation, controller }
  }
  if (current.state !== 'stopped') return { state: current.state, generation: current.record.generation, controller: current.record.controller }
  if (service.tasks > 0 || service.group && service.tasks !== 0 || !['inactive', 'failed'].includes(service.state)) {
    throw systemError('本人服务仍有准备进程或未收口任务，不能报告已停止。', 'CRABOT_SYSTEM_SERVICE_UNSETTLED')
  }
  return { state: 'stopped', generation: null }
}

export async function inspectSystemUser(entry) {
  const current = inspectInstance(entry.data_dir)
  if (!['running', 'starting', 'stopped'].includes(current.state)) throw systemError('旧实例尚未完成可信转换，未执行受管启停。')
  const result = { state: current.state, generation: current.state === 'stopped' ? null : current.record.generation, ready: false, health: 'unhealthy',
    core_version: current.state === 'running' ? cliLocation.readCoreVersion(current.record.install_root) : null,
    core_id: current.state === 'running' ? cliLocation.locateCliInstallation(current.record.install_root)?.id ?? null : null }
  if (current.record && current.record.mm_port !== 19000 + entry.port_offset) throw systemError('实际MM端口与受管绑定不同，未执行控制。')
  if (systemdAvailable()) {
    const response = await systemctlForUser(entry, ['show', 'crabot.service', '--all', '--property=ActiveState,MainPID,TasksCurrent,ControlGroup,InvocationID'])
    const service = parseSystemServiceStatus(response.stdout)
    Object.assign(result, reconcileSystemService(current, service, service.pid ? identity.inspectProcess(service.pid) : null, entry.uid))
  }
  const maintenance = readVersionMaintenance(entry.data_dir)
  if (maintenance) result.maintenance = { id: maintenance.id, phase: maintenance.phase, target_version: maintenance.target_version }
  if (current.state === 'running') {
    const port = 19000 + entry.port_offset
    const modules = await probeMmModules(port)
    const required = ['admin-web', 'crabot-agent', 'memory-default'].map(id => modules?.find(module => module.module_id === id))
    result.ready = await probeMmHealthy(port) && required.every(module => module?.status === 'running' && ['healthy', 'degraded'].includes(module.last_health_status))
    if (result.ready) result.health = required.some(module => module.last_health_status === 'degraded') ? 'degraded' : 'healthy'
  }
  return result
}

export async function systemctlForUser(entry, args, run = execute) {
  try {
    return await run('/usr/bin/systemctl', ['--user', ...args], { env: systemUserEnvironment(entry), cwd: '/', encoding: 'utf8',
      timeout: 120_000, maxBuffer: 65536, killSignal: 'SIGTERM' })
  } catch { throw systemError('本人systemd服务操作未完成，请检查systemctl --user status crabot.service及本人日志。', 'CRABOT_SYSTEM_SERVICE_FAILED') }
}

export async function controlSystemUser(entry, action, previous, { permit, observe = inspectSystemUser, invoke = systemctlForUser,
  available = assertSystemControlAvailable, stop = stopInstance, waitMs = 90_000, signal } = {}) {
  available(entry, { permit })
  const directory = management.ensurePrivateDataRoot(path.join(entry.data_dir, 'system-control'))
  const lock = await acquireCliLock(directory, 'system-' + action)
  try {
    available(entry, { permit })
    const current = await observe(entry)
    const selected = selectSystemUserAction(action, previous ?? current, current)
    if (selected === 'skip') return { state: 'skipped', observed_state: current.state }
    if (selected === 'stop' || selected === 'restart') {
      const lifecycle = await acquireCliLock(entry.data_dir, 'system-stop-owned-instance')
      try {
        const checked = await observe(entry)
        selectSystemUserAction(action, previous ?? current, checked)
        await stop(entry.data_dir)
        // The unit has no ExecStop that would reacquire this lock. A replacement
        // launcher cannot create a new MM while this lock remains held.
        await invoke(entry, ['stop', 'crabot.service'])
        const stopped = await observe(entry)
        if (stopped.state !== 'stopped') throw systemError('未确认本人实例停止，未继续启动。', 'CRABOT_SYSTEM_STOP_UNKNOWN')
      } finally { releaseCliLock(lifecycle) }
      if (selected === 'stop') return { state: 'stopped' }
    }
    if (signal?.aborted) throw systemError('已请求取消前台启动，正在核对本人服务以完成停止。', 'CRABOT_SYSTEM_START_CANCELLED')
    await invoke(entry, ['start', 'crabot.service'])
    const deadline = Date.now() + waitMs
    do {
      if (signal?.aborted) throw systemError('已请求取消前台启动，正在核对本人服务以完成停止。', 'CRABOT_SYSTEM_START_CANCELLED')
      const started = await observe(entry)
      if (started.state === 'running' && started.ready === true) return { state: selected === 'restart' ? 'restarted' : 'started', generation: started.generation }
      if (Date.now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, 250))
    } while (true)
    throw systemError('服务尚未通过完整健康核验，运行状态已保留，请检查本人日志。', 'CRABOT_SYSTEM_START_UNHEALTHY')
  } finally { releaseCliLock(lock) }
}
