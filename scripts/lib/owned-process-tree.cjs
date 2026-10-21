// A read-only ancestry observation rooted in already verified launch identities.
// It does not send signals or prove that a whole shutdown window is complete.
const native = require('./process-identity.cjs')
const fail = stage => { throw Object.assign(new Error('执行进程范围无法完整核验，已保留文件与维护保护。'), { code: 'CRABOT_PROCESS_SCOPE', stage }) }
const validPid = pid => Number.isInteger(pid) && pid > 0 && pid <= 2147483647
const linuxBirth = /^([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\n?:([0-9]+)$/
const valid = item => item && validPid(item.pid) && (item.parent === 0 || validPid(item.parent))
  && typeof item.owner === 'string' && item.owner && typeof item.executable === 'string' && item.executable
  && typeof item.started === 'string' && (/^\d+(?::\d+)?$/.test(item.started) || linuxBirth.test(item.started))
function atLeast(child, parent) {
  const parts = value => {
    const linux = linuxBirth.exec(value)
    return linux ? { boot: linux[1], time: [BigInt(linux[2])] } : { boot: '', time: value.split(':').map(BigInt) }
  }
  const a = parts(child), b = parts(parent)
  if (a.boot !== b.boot || a.time.length !== b.time.length) fail('birth-format')
  for (let i = 0; i < a.time.length; i++) { if (a.time[i] !== b.time[i]) return a.time[i] > b.time[i] }
  return true
}
function captureOwnedProcessTree(roots, api = native) {
  let stage = 'inspect-self'
  try {
    const self = api.inspectProcess(process.pid)
    if (!valid(self) || !Array.isArray(roots) || roots.length > 32768) fail('scope-input')
    for (const root of roots) if (!valid(root) || root.owner !== self.owner || root.pid === process.pid) fail('root-binding')
    const rootIds = new Set(roots.map(root => root.pid))
    const observed = new Map(), parents = new Map(), pending = []
    const read = expected => {
      stage = rootIds.has(expected.pid) ? 'root-refresh' : 'descendant-refresh'
      const current = api.inspectProcess(expected.pid)
      if (!valid(current) || current.pid !== expected.pid || current.owner !== self.owner || current.started !== expected.started) fail(stage)
      return current
    }
    const remember = current => {
      const previous = observed.get(current.pid)
      if (previous) { if (previous.started !== current.started || previous.owner !== current.owner) fail('observed-generation'); return }
      if (observed.size >= 32768) fail('scope-size')
      observed.set(current.pid, current); pending.push(current)
    }
    for (const root of roots) remember(read(root))
    for (let offset = 0; offset < pending.length; offset++) {
      const parent = read(pending[offset])
      stage = 'child-list'
      const children = api.listChildProcessIds(parent.pid)
      if (!Array.isArray(children) || children.length > 32768 || new Set(children).size !== children.length) fail(stage)
      for (const pid of children) {
        if (!validPid(pid) || pid === process.pid) fail('child-pid')
        let child
        stage = 'inspect-child'
        try { child = api.inspectProcess(pid) } catch { /* An independent kernel exit check is still required below. */ }
        if (child == null) {
          if (api.isProcessExited?.(pid) === true) continue
          fail('child-exit-unverified')
        }
        if (!valid(child) || child.pid !== pid || child.owner !== self.owner || child.parent !== parent.pid) fail('child-binding')
        if (!atLeast(child.started, parent.started)) fail('child-birth-order')
        let ancestor = parent.pid
        while (parents.has(ancestor)) { if (ancestor === pid) fail('ancestry-cycle'); ancestor = parents.get(ancestor) }
        if (ancestor === pid) fail('ancestry-cycle')
        parents.set(pid, parent.pid)
        remember(child)
      }
      read(parent) // A reused/disappeared parent cannot vouch for its former child list.
    }
    const result = []
    for (const expected of observed.values()) {
      const current = read(expected)
      if (parents.has(current.pid) && current.parent !== parents.get(current.pid)) fail('final-parent')
      const { pid, parent, started, owner, executable } = current
      result.push(Object.freeze({ pid, parent, started, owner, executable }))
    }
    return Object.freeze(result.sort((a, b) => a.pid - b.pid))
  } catch (error) { fail(typeof error?.stage === 'string' ? error.stage : stage) }
}
module.exports = { captureOwnedProcessTree }
