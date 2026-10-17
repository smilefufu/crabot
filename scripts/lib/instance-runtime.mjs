import { writeFileSync, renameSync, unlinkSync, realpathSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import identity from './process-identity.cjs'
import { readPid, writePid, clearPid, isPidAlive } from './pid.mjs'
import runtimeRecord from './instance-runtime-record.cjs'

const filename = 'instance-runtime.json'
const fail = message => { throw Object.assign(new Error(message), { code: 'CRABOT_INSTANCE_UNVERIFIED' }) }

export const readInstanceRuntime = runtimeRecord.readInstanceRuntime

function save(dataDir, record) {
  const file = join(dataDir, filename), pending = file + '.tmp-' + randomUUID()
  try {
    writeFileSync(pending, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(pending, file)
  } finally { try { unlinkSync(pending) } catch {} }
}

export function createInstanceRuntime({ dataDir, root, controllerPid = process.pid, generation = randomUUID(), mmPort }) {
  mkdirSync(dataDir, { recursive: true })
  dataDir = realpathSync(dataDir)
  const controller = identity.inspectProcess(controllerPid)
  const self = identity.inspectProcess(process.pid)
  if (!controller || controller.owner !== self.owner) fail('无法确认启动进程属于当前用户。')
  const existing = inspectInstance(dataDir)
  if (existing.state !== 'stopped') fail('实例已运行；不能覆盖现有启动记录。')
  const record = {
    schema_version: 1,
    instance_id: createHash('sha256').update(controller.owner + '\0' + dataDir).digest('hex'),
    generation, data_dir: dataDir, install_root: realpathSync(root),
    controller, mm: null, mm_port: mmPort,
  }
  save(dataDir, record)
  writePid(dataDir, controller.pid)
  return record
}

export function recordMmProcess(dataDir, generation, pid) {
  const record = readInstanceRuntime(dataDir)
  if (record?.generation !== generation) fail('启动代际已改变。')
  const mm = identity.inspectProcess(pid)
  if (!mm || mm.owner !== record.controller.owner || mm.parent !== record.controller.pid) fail('无法确认 MM 子进程身份。')
  save(dataDir, { ...record, mm })
  return { ...record, mm }
}

export function readOwnStartingRuntime({ root, dataDir, generation, mmPort }) {
  const record = readInstanceRuntime(dataDir)
  if (!record || record.generation !== generation || record.mm !== null || record.mm_port !== mmPort
    || record.install_root !== realpathSync(root)
    || !identity.sameProcess(record.controller, identity.inspectProcess(process.pid))) {
    fail('后台启动登记不属于当前控制进程；未启动 MM。')
  }
  return record
}

export function clearInstanceRuntime(dataDir, generation) {
  const record = readInstanceRuntime(dataDir)
  if (record?.generation !== generation) return false
  // Caller holds the bounded lifecycle lock, or is the sole controller of this generation.
  if (readPid(dataDir) === record.controller.pid) clearPid(dataDir)
  unlinkSync(join(dataDir, filename))
  return true
}

export function inspectInstance(dataDir) {
  const record = readInstanceRuntime(dataDir)
  if (!record) {
    const pid = readPid(dataDir)
    return { state: pid !== null && isPidAlive(pid) ? 'legacy' : 'stopped', record: null }
  }
  const self = identity.inspectProcess(process.pid)
  if (self.owner !== record.controller.owner) fail('实例属于其他系统用户。')
  const controller = identity.inspectProcess(record.controller.pid)
  const mm = record.mm ? identity.inspectProcess(record.mm.pid) : null
  if ((controller && !identity.sameProcess(record.controller, controller)) || (mm && !identity.sameProcess(record.mm, mm))) {
    fail('PID 已被其他进程使用；未向该进程发送信号。')
  }
  return { state: controller || mm ? (record.mm ? 'running' : 'starting') : 'stopped', record }
}

export { identity }
