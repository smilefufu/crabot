// Stops only an observed scope. This is not proof of complete Worker/module ownership.
const native = require('./process-identity.cjs')
const { captureOwnedProcessTree } = require('./owned-process-tree.cjs')
const { probeKnownProcessExit } = require('./known-process-exit.cjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const fail = () => { throw Object.assign(new Error('已知进程停止尚不能核实，保留维护保护。'), { code: 'CRABOT_PROCESS_SCOPE_STOP' }) }
const key = item => JSON.stringify([item.pid, item.started, item.owner])
async function stopKnownProcessScope(initial, { timeoutMs, onObserved, graceful }, api = native) {
  if (!Array.isArray(initial) || !initial.length || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647
    || typeof onObserved !== 'function') fail()
  const observationEnd = Date.now() + timeoutMs + 5000
  const known = new Map(), signalled = new Set()
  let dirty = true
  function remember(item) {
    if (known.has(key(item))) return
    if (known.size >= 32768) fail()
    const { pid, parent, started, owner, executable } = item
    known.set(key(item), Object.freeze({ pid, parent, started, owner, executable })); dirty = true
  }
  for (const item of initial) remember(item)
  const snapshot = () => Object.freeze([...known.values()].sort((a, b) => a.pid - b.pid || (a.started < b.started ? -1 : a.started > b.started ? 1 : 0)))
  function running() {
    const report = probeKnownProcessExit(snapshot(), api)
    if (report.state === 'unknown') fail()
    return snapshot().filter(item => {
      if (!report.running_pids.includes(item.pid)) return false
      const current = api.inspectProcess(item.pid)
      if (!current || current.pid !== item.pid || typeof current.started !== 'string' || !current.started
        || typeof current.owner !== 'string' || !current.owner || typeof current.executable !== 'string' || !current.executable) fail()
      if (current.started !== item.started) return false
      if (current.owner !== item.owner) fail()
      return true
    })
  }
  async function observe() {
    for (;;) {
      let active
      try {
        active = running()
        if (active.length) for (const item of captureOwnedProcessTree(active, api)) remember(item)
      } catch {
        if (Date.now() >= observationEnd) fail()
        await delay(25)
        continue // Read-only uncertainty is bounded; no stop is submitted until it resolves.
      }
      if (!dirty) return active
      await onObserved(snapshot())
      dirty = false // Reobserve after acknowledgement, before any signal or shutdown request.
    }
  }
  if (!(await observe()).length) return snapshot()
  const gracefulEnd = Date.now() + timeoutMs
  try { await graceful?.() } catch { /* A lost shutdown reply is never retried; observe its known scope. */ }
  for (;;) {
    if (!(await observe()).length) return snapshot()
    if (Date.now() >= gracefulEnd) break
    await delay(Math.min(25, Math.max(1, gracefulEnd - Date.now())))
  }
  const forceEnd = Math.min(observationEnd, Date.now() + 5000)
  for (;;) {
    const active = await observe()
    if (!active.length) return snapshot()
    if (Date.now() >= forceEnd) fail()
    const candidate = active.find(item => !signalled.has(key(item)) && !active.some(parent => parent.pid === item.parent))
      ?? active.find(item => !signalled.has(key(item)))
    if (candidate) { signalled.add(key(candidate)); api.terminateKnownProcess(candidate) }
    await delay(25)
  }
}
module.exports = { stopKnownProcessScope }
