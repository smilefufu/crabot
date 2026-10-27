// Read-only observation of a previously verified set. It neither proves completeness nor sends signals.
const native = require('./process-identity.cjs')
const fail = () => { throw Object.assign(new Error('已知进程集合或当前用户无法核验，保留维护保护。'), { code: 'CRABOT_PROCESS_IDENTITY' }) }
const validPid = pid => Number.isInteger(pid) && pid > 0 && pid <= 2147483647

function probeKnownProcessExit(expected, api = native) {
  const self = api.inspectProcess(process.pid)
  if (!self?.owner || !Array.isArray(expected)) fail()
  for (const item of expected) {
    if (!item || !validPid(item.pid) || item.owner !== self.owner || typeof item.started !== 'string' || !item.started
      || typeof item.executable !== 'string' || !item.executable) fail()
  }
  const running = new Set(), unknown = new Set()
  for (const target of expected) {
    let current
    try { current = api.inspectProcess(target.pid) }
    catch { /* An unavailable image requires the independent kernel exit observation below. */ }
    if (!current) {
      try { if (api.isProcessExited(target.pid) === true) continue } catch { /* Keep missing evidence unknown. */ }
      unknown.add(target.pid); continue
    }
    if (current.pid !== target.pid || typeof current.started !== 'string' || !current.started
      || typeof current.owner !== 'string' || !current.owner || typeof current.executable !== 'string' || !current.executable) {
      unknown.add(target.pid); continue
    }
    if (current.started !== target.started) continue // The old generation exited; never adopt the reused PID.
    if (current.owner !== target.owner) { unknown.add(target.pid); continue }
    // exec changes the image, not the kernel creation identity. The process can still write files.
    running.add(target.pid)
  }
  return { state: unknown.size ? 'unknown' : running.size ? 'running' : 'stopped',
    running_pids: [...running].sort((a, b) => a - b), unknown_pids: [...unknown].sort((a, b) => a - b) }
}
module.exports = { probeKnownProcessExit }
