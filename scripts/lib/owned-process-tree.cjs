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
    const read = (expected, phase = 'refresh') => {
      stage = (rootIds.has(expected.pid) ? 'root-' : 'descendant-') + phase
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
    if (typeof api.captureProcessTreeGeneration === 'function') {
      stage = 'pinned-tree'
      for (const root of roots) {
        read(root)
        stage = 'pinned-tree'
        const items = api.captureProcessTreeGeneration(root.pid, root.started, root.owner)
        if (!Array.isArray(items) || !items.length || items.length > 32768) fail('pinned-tree-shape')
        const byPid = new Map(), children = new Map()
        for (const item of items) {
          if (!valid(item) || item.owner !== self.owner || item.pid === process.pid || byPid.has(item.pid)) fail('pinned-tree-member')
          byPid.set(item.pid, item)
          const siblings = children.get(item.parent) ?? []
          siblings.push(item); children.set(item.parent, siblings)
        }
        const actualRoot = byPid.get(root.pid)
        if (!actualRoot || actualRoot.started !== root.started || actualRoot.owner !== root.owner) fail('pinned-tree-root')
        const visited = new Set([root.pid]), queue = [actualRoot]
        for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i].pid) ?? []) {
          if (visited.has(child.pid) || !atLeast(child.started, queue[i].started)) fail('pinned-tree-ancestry')
          visited.add(child.pid); queue.push(child)
        }
        if (visited.size !== items.length) fail('pinned-tree-disconnected')
        for (const item of items) remember(item)
      }
      for (const root of roots) read(root)
      return Object.freeze([...observed.values()].map(({ pid, parent, started, owner, executable }) =>
        Object.freeze({ pid, parent, started, owner, executable })).sort((a, b) => a.pid - b.pid))
    }
    for (const root of roots) remember(read(root))
    for (let offset = 0; offset < pending.length; offset++) {
      const parent = read(pending[offset], 'before-list')
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
        if (!valid(child)) fail('child-identity')
        if (child.pid !== pid) fail('child-pid-binding')
        if (child.owner !== self.owner) fail('child-owner')
        if (child.parent !== parent.pid) fail(child.parent === 0 ? 'child-parent-missing' : 'child-parent')
        if (!atLeast(child.started, parent.started)) fail('child-birth-order')
        let ancestor = parent.pid
        while (parents.has(ancestor)) { if (ancestor === pid) fail('ancestry-cycle'); ancestor = parents.get(ancestor) }
        if (ancestor === pid) fail('ancestry-cycle')
        parents.set(pid, parent.pid)
        remember(child)
      }
      read(parent, 'after-list') // A reused/disappeared parent cannot vouch for its former child list.
    }
    const result = []
    for (const expected of observed.values()) {
      const current = read(expected, 'final')
      if (parents.has(current.pid) && current.parent !== parents.get(current.pid)) fail('final-parent')
      const { pid, parent, started, owner, executable } = current
      result.push(Object.freeze({ pid, parent, started, owner, executable }))
    }
    return Object.freeze(result.sort((a, b) => a.pid - b.pid))
  } catch (error) { fail(typeof error?.stage === 'string' ? error.stage : stage) }
}
// Re-observe already verified snapshots. A departed member remains a fact, not a new live root.
function recaptureObservedProcessScope(items, api = native) {
  try {
    const self = api.inspectProcess(process.pid), observed = new Map()
    if (!valid(self) || !Array.isArray(items) || items.length > 32768) fail('observed-scope-input')
    const remember = item => {
      if (!valid(item) || item.owner !== self.owner || item.pid === process.pid) fail('observed-scope-member')
      const previous = observed.get(item.pid)
      if (previous && (previous.started !== item.started || previous.owner !== item.owner)) fail('observed-scope-conflict')
      if (!previous) observed.set(item.pid, item)
      if (observed.size > 32768) fail('observed-scope-size')
    }
    for (const item of items) remember(item)
    const snapshot = [...observed.values()]
    const report = require('./known-process-exit.cjs').probeKnownProcessExit(snapshot, api)
    if (report.state === 'unknown') fail('observed-scope-exit')
    const running = new Set(report.running_pids), active = snapshot.filter(item => running.has(item.pid))
    if (active.length) for (const item of captureOwnedProcessTree(active, api)) remember(item)
    return Object.freeze([...observed.values()].map(({ pid, parent, started, owner, executable }) =>
      Object.freeze({ pid, parent, started, owner, executable })).sort((a, b) => a.pid - b.pid))
  } catch (error) { fail(typeof error?.stage === 'string' ? error.stage : 'observed-scope') }
}
// Pure kernel timestamp comparison; this alone grants no ancestry or signal authority.
module.exports = { captureOwnedProcessTree, recaptureObservedProcessScope, processBirthAtLeast: atLeast }
