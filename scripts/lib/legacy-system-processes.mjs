// Root reads kernel process metadata only. Never resolve/open an argv path,
// read employee environment/configuration, persist argv, or signal a process.
import { readlinkSync } from 'node:fs'
import path from 'node:path'
import identity from './process-identity.cjs'
import { validateSystemConversionPlan } from './system-conversion.mjs'
import { systemError } from './system-registry.mjs'
const fail = () => { throw systemError('旧共享代码仍有未核实的进程或启动来源，未转换；请核对原部署。', 'CRABOT_LEGACY_SYSTEM_PROCESSES') }
const inside = (root, value) => typeof value === 'string' && (value === root || value.startsWith(root + '/'))
export function usesLegacySystemCode(root, current, args, cwd) {
  if (!path.posix.isAbsolute(root) || root === '/' || path.posix.normalize(root) !== root || /[\0\r\n]/.test(root)
    || !Array.isArray(args) || args.some(value => typeof value !== 'string') || typeof cwd !== 'string') fail()
  if (inside(root, current.executable) || args.some(value => value === root || value.includes(root + '/'))) return true
  const shell = /^(?:ba|da|z|k)?sh$|^fish$/.test(path.posix.basename(current.executable))
  const interactive = shell && args.slice(1).every(value => /^-[il]+$/.test(value))
  return inside(root, cwd) && !interactive
}
export function collectLegacySystemProcesses(root) {
  if (process.platform !== 'linux' || process.getuid() !== 0) fail()
  const rows = []
  for (const pid of identity.listProcessIds()) {
    // The dedicated new coordinator carries source metadata in its own argv;
    // it is not an old-code consumer. Its trusted entry is checked by its caller.
    if (pid === process.pid) continue
    let current
    try {
      current = identity.inspectProcess(pid)
      if (!current) continue
      const args = identity.inspectProcessArguments(pid), cwd = readlinkSync('/proc/' + pid + '/cwd')
      const after = identity.inspectProcess(pid)
      if (!after) continue
      if (!identity.sameProcess(current, after)) fail()
      rows.push({ process: after, uses_source: usesLegacySystemCode(root, after, args, cwd) })
    } catch {
      // Exit during observation is normal. An inaccessible live process is not
      // evidence that the old shared tree has no other users.
      if (identity.inspectProcess(pid)) throw systemError('无法核验仍存活进程PID ' + pid + '的旧共享代码来源，未转换；请管理员检查其启动方式。', 'CRABOT_LEGACY_SYSTEM_PROCESSES')
    }
  }
  return rows
}
export function assertLegacySystemProcessCoverage(plan, rows, { stopped = false } = {}) {
  validateSystemConversionPlan(plan)
  if (!Array.isArray(rows) || typeof stopped !== 'boolean') fail()
  const processes = new Map()
  for (const row of rows) {
    const current = row?.process
    if (!current || !Number.isSafeInteger(current.pid) || current.pid <= 0 || !Number.isSafeInteger(current.parent) || current.parent < 0
      || !/^[0-9]+$/.test(current.owner) || typeof current.started !== 'string' || !current.started
      || typeof current.executable !== 'string' || !path.posix.isAbsolute(current.executable)
      || typeof row.uses_source !== 'boolean' || processes.has(current.pid)) fail()
    processes.set(current.pid, row)
  }
  const allowed = new Map()
  for (const { entry, observation } of plan.instances) {
    if (observation.runtime_state !== 'running') continue
    for (const original of [observation.controller, observation.mm]) {
      const actual = processes.get(original.pid)
      if (stopped) { if (identity.sameProcess(original, actual?.process)) fail(); continue }
      if (!actual?.uses_source || !identity.sameProcess(original, actual.process)
        || original === observation.mm && actual.process.parent !== observation.controller.pid) fail()
      allowed.set(original.pid, String(entry.uid))
    }
  }
  for (let changed = true; changed;) {
    changed = false
    for (const { process: current } of rows) {
      if (!allowed.has(current.pid) && allowed.get(current.parent) === current.owner) {
        allowed.set(current.pid, current.owner); changed = true
      }
    }
  }
  if (rows.some(row => row.uses_source && !allowed.has(row.process.pid))) fail()
}
