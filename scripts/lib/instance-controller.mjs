// Common process control only: no TTY prompts, GUI state, passwords or business RPCs.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { inspectInstance, clearInstanceRuntime, identity } from './instance-runtime.mjs'
import { SUPERVISOR_FORCE_TIMEOUT_MS } from './supervisor-shutdown.mjs'

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
  const modules = []
  for (const item of await moduleProcesses(dataDir, record.controller.owner)) {
    if (await probeProcessStartIdentity(item.process.pid) === item.record.process_start_identity
      && identity.sameProcess(item.process, identity.inspectProcess(item.process.pid))) modules.push(item.process)
  }
  // Capture descendants before their parent exits; never adopt processes just because they own a port.
  const processes = []
  for (const pid of identity.listProcessIds()) {
    try {
      const process = identity.inspectProcess(pid)
      if (process?.owner === record.controller.owner) processes.push(process)
    } catch { /* unrelated inaccessible or already-exited process */ }
  }
  const owned = new Map([record.controller, record.mm, ...modules].filter(Boolean).map(item => [item.pid, item]))
  for (let changed = true; changed;) {
    changed = false
    for (const process of processes) {
      const parent = owned.get(process.parent)
      if (!owned.has(process.pid) && parent && alive(parent) && alive(process)) {
        owned.set(process.pid, process); changed = true
      }
    }
  }
  return [...owned.values()]
}

function alive(process) { return identity.sameProcess(process, identity.inspectProcess(process.pid)) }

async function shutdownRpc(record) {
  if (!record.mm || !alive(record.mm)) return
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
  if (!current.record) { log('Stopped.'); return }
  const record = current.record
  const owned = await collectOwned(record, dataDir)
  log(`Stopping generation ${record.generation}...`)
  if (process.platform === 'win32') await shutdownRpc(record)
  else if (alive(record.controller)) process.kill(record.controller.pid, 'SIGTERM')
  else if (record.mm && alive(record.mm)) process.kill(record.mm.pid, 'SIGTERM')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && owned.some(alive)) await sleep(pollMs)
  const remaining = owned.filter(alive)
  if (remaining.length) {
    log('Graceful shutdown window elapsed; terminating only confirmed processes.')
    // Each target is rechecked immediately before signalling; no name/port/global tree fallback.
    for (const target of remaining.reverse()) {
      if (!alive(target)) continue
      try { process.kill(target.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const forceDeadline = Date.now() + 5000
    while (Date.now() < forceDeadline && owned.some(alive)) await sleep(pollMs)
  }
  if (owned.some(alive)) throw Object.assign(new Error('仍有确认归属的进程未退出；保留运行记录，请打开诊断。'), { code: 'CRABOT_STOP_INCOMPLETE' })
  // MM removes module records only after full tree settlement. A dead root alone proves less.
  try {
    if ((await fs.readdir(join(dataDir, 'module-runtime-registry', 'records'))).some(file => file.endsWith('.json'))) {
      throw Object.assign(new Error('MM 已退出，但仍有未收口的模块运行记录；停止结果未知，请执行定向恢复。'), { code: 'CRABOT_STOP_UNKNOWN' })
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  clearInstanceRuntime(dataDir, record.generation)
  log('Stopped.')
}
