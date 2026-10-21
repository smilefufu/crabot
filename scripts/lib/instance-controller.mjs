// Common process control only: no TTY prompts, GUI state, passwords or business RPCs.
import { promises as fs } from 'node:fs'
import { join, isAbsolute, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'
import { inspectInstance, clearInstanceRuntime, identity } from './instance-runtime.mjs'
import { SUPERVISOR_FORCE_TIMEOUT_MS } from './supervisor-shutdown.mjs'
import { processBirthAtLeast } from './owned-process-tree.cjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function moduleProcesses(dataDir, owner) {
  const directory = join(dataDir, 'module-runtime-registry')
  let instanceId, files
  try {
    instanceId = (await fs.readFile(join(directory, 'instance-id'), 'utf8')).trim()
    files = await fs.readdir(join(directory, 'records'))
  } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const result = []
  for (const file of files.filter(file => file.endsWith('.json'))) {
    const record = JSON.parse(await fs.readFile(join(directory, 'records', file), 'utf8'))
    if (record.instance_id !== instanceId || !Number.isInteger(record.root_pid) || record.root_pid <= 0) continue
    const process = identity.inspectProcess(record.root_pid)
    // Module runtime records additionally carry the MM's original start identity.
    // The caller validates this with the same producer before adopting a tree.
    if (process?.owner === owner) result.push({ record, process })
  }
  return result
}

async function collectOwned(record, dataDir) {
  const { probeProcessStartIdentity } = await import(new URL('../../crabot-core/dist/module-runtime-registry.js', import.meta.url))
  const modules = [], admins = []
  for (const item of await moduleProcesses(dataDir, record.controller.owner)) {
    if (await probeProcessStartIdentity(item.process.pid) === item.record.process_start_identity
      && identity.sameProcess(item.process, identity.inspectProcess(item.process.pid))) {
      modules.push(item.process)
      if (item.record.module_id === 'admin-web' && item.process.parent === record.mm?.pid) admins.push(item.process)
    }
  }
  // Capture descendants before their parent exits; never adopt processes just because they own a port.
  const processes = []
  for (const pid of identity.listProcessIds()) {
    try {
      const process = identity.inspectProcess(pid)
      if (process?.owner === record.controller.owner) processes.push(process)
    } catch { /* unrelated inaccessible or already-exited process */ }
  }
  // The existing UI upgrader is an independent maintenance process. It and
  // its stop CLI must survive Core shutdown; arbitrary detached children do not
  // gain this exemption. Only the registered Admin's exact native entry does.
  const independent = new Set()
  const updater = normalize(join(record.install_root, 'scripts/ui-upgrade.mjs'))
  for (const process of processes) {
    const admin = admins.find(admin => process.parent === admin.pid && process.executable === admin.executable)
    if (!admin || !alive(admin) || !alive(process)) continue
    let args
    try { args = identity.inspectProcessArguments(process.pid) }
    catch (error) {
      if (alive(process)) throw Object.assign(new Error('Admin 子进程入口暂时无法核验；未停止实例。'), { code: 'CRABOT_STOP_UNKNOWN' })
      continue
    }
    if (args.length === 2 && isAbsolute(args[1]) && normalize(args[1]) === updater && alive(process)) independent.add(process.pid)
  }
  const owned = new Map([record.controller, record.mm, ...modules].filter(Boolean).map(item => [item.pid, item]))
  for (let changed = true; changed;) {
    changed = false
    for (const process of processes) {
      const parent = owned.get(process.parent)
      if (!independent.has(process.pid) && !owned.has(process.pid) && parent && alive(parent) && alive(process)) {
        let notOlderThanParent
        try { notOlderThanParent = processBirthAtLeast(process.started, parent.started) }
        catch { throw Object.assign(new Error('进程创建代际无法比较；未停止实例，保留运行记录。'), { code: 'CRABOT_STOP_UNKNOWN' }) }
        // Windows retains the creator PID after exit. Its reuse is not a new parent relationship.
        if (!notOlderThanParent) continue
        owned.set(process.pid, process); changed = true
      }
    }
  }
  return [...owned.values()]
}

function processState(process) {
  try { return identity.sameProcess(process, identity.inspectProcess(process.pid)) ? 'alive' : 'gone' }
  catch (error) { if (error.code === 'CRABOT_PROCESS_IDENTITY') return 'unknown'; throw error }
}
function alive(process) { return processState(process) === 'alive' }
const unsettled = process => processState(process) !== 'gone'

async function shutdownRpc(record) {
  if (!record.mm || processState(record.mm) === 'gone') return
  if (!alive(record.mm)) throw Object.assign(new Error('MM 身份暂时无法核验；未发送停机请求，保留运行记录。'), { code: 'CRABOT_STOP_UNKNOWN' })
  const response = await fetch(`http://127.0.0.1:${record.mm_port}/shutdown`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: randomUUID(), params: { expected_generation: record.generation } }),
    signal: AbortSignal.timeout(5000),
  })
  const result = await response.json()
  if (!response.ok || result.success !== true) throw new Error('MM 未接受当前代际的停机请求；保留运行记录。')
}

export async function stopInstance(dataDir, { timeoutMs = SUPERVISOR_FORCE_TIMEOUT_MS, pollMs = 100, log = () => {} } = {}) {
  if (timeoutMs < SUPERVISOR_FORCE_TIMEOUT_MS) throw new Error('Cannot shorten the MM graceful shutdown window')
  const current = inspectInstance(dataDir)
  if (current.state === 'legacy') throw Object.assign(new Error('旧实例缺少可验证的启动记录，请使用原版本停止或通过桌面接管流程升级。'), { code: 'CRABOT_LEGACY_INSTANCE' })
  if (current.state === 'starting') throw Object.assign(new Error('服务正在启动，进程登记尚未完成；请稍候重新检查后再停止。'), { code: 'CRABOT_INSTANCE_STARTING' })
  if (!current.record) { log('Stopped.'); return }
  const record = current.record
  const owned = await collectOwned(record, dataDir)
  log(`Stopping generation ${record.generation}...`)
  if (process.platform === 'win32') await shutdownRpc(record)
  else if (alive(record.controller)) process.kill(record.controller.pid, 'SIGTERM')
  else if (record.mm && alive(record.mm)) process.kill(record.mm.pid, 'SIGTERM')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && owned.some(unsettled)) await sleep(pollMs)
  const remaining = owned.filter(alive)
  if (remaining.length) {
    log('Graceful shutdown window elapsed; terminating only confirmed processes.')
    // Each target is rechecked immediately before signalling; no name/port/global tree fallback.
    for (const target of remaining.reverse()) {
      if (!alive(target)) continue
      try { process.kill(target.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const forceDeadline = Date.now() + 5000
    while (Date.now() < forceDeadline && owned.some(unsettled)) await sleep(pollMs)
  }
  if (owned.some(alive)) throw Object.assign(new Error('仍有确认归属的进程未退出；保留运行记录，请打开诊断。'), { code: 'CRABOT_STOP_INCOMPLETE' })
  if (owned.some(unsettled)) throw Object.assign(new Error('进程身份仍未知；未向未知进程发信号，保留运行记录。'), { code: 'CRABOT_STOP_UNKNOWN' })
  // MM removes module records only after full tree settlement. A dead root alone proves less.
  try {
    if ((await fs.readdir(join(dataDir, 'module-runtime-registry', 'records'))).some(file => file.endsWith('.json'))) {
      throw Object.assign(new Error('MM 已退出，但仍有未收口的模块运行记录；停止结果未知，请执行定向恢复。'), { code: 'CRABOT_STOP_UNKNOWN' })
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  clearInstanceRuntime(dataDir, record.generation)
  log('Stopped.')
}
