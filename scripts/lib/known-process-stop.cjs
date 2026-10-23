// Stops only an observed scope. This is not proof of complete Worker/module ownership.
const native = require('./process-identity.cjs')
const { captureOwnedProcessTree } = require('./owned-process-tree.cjs')
const { probeKnownProcessExit } = require('./known-process-exit.cjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const fail = (stage, cause) => {
  const fixed = (value, pattern) => typeof value === 'string' && value.length <= 128 && pattern.test(value) ? value : null
  throw Object.assign(new Error('已知进程停止尚不能核实，保留维护保护。'), { code: 'CRABOT_PROCESS_SCOPE_STOP', ...(stage ? {
    stage, observation_code: fixed(cause?.code, /^CRABOT_[A-Z_]+$/), observation_stage: fixed(cause?.stage, /^[a-z][a-z0-9-]*$/),
  } : {}) })
}
const key = item => JSON.stringify([item.pid, item.started, item.owner])
async function stopKnownProcessScope(initial, { timeoutMs, onObserved, graceful, submit }, api = native) {
  if (!Array.isArray(initial) || !initial.length && !submit || submit !== undefined && (typeof submit !== 'function' || graceful !== undefined) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647
    || typeof onObserved !== 'function') fail()
  let observationEnd = Date.now() + timeoutMs + 5000
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
  let observationStage = 'known-exit'
  function running() {
    observationStage = 'known-exit'
    const report = probeKnownProcessExit(snapshot(), api)
    if (report.state === 'unknown') fail()
    return snapshot().filter(item => {
      if (!report.running_pids.includes(item.pid)) return false
      observationStage = 'active-identity'
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
        observationStage = 'owned-tree'
        if (active.length) for (const item of captureOwnedProcessTree(active, api)) remember(item)
      } catch (error) {
        if (Date.now() >= observationEnd) fail(observationStage, error)
        await delay(25)
        continue // Read-only uncertainty is bounded; no stop is submitted until it resolves.
      }
      if (!dirty) return active
      await onObserved(snapshot())
      dirty = false // Reobserve after acknowledgement, before any signal or shutdown request.
    }
  }
  if (!(await observe()).length && !submit) return snapshot()
  let gracefulEnd = Date.now() + timeoutMs
  let gracefulSettled = false, submissionFailure
  const closing = Promise.resolve().then(() => submit ? submit() : graceful?.()).catch(error => {
    // Fixed submissions propagate failure; only ordinary shutdown RPC loss is observational.
    if (submit) submissionFailure = { error }
  }).finally(() => { gracefulSettled = true })
  while (!gracefulSettled) {
    await observe() // The original parent may create descendants before its shutdown reply settles.
    if (!gracefulSettled) await delay(25)
  }
  await closing
  if (submissionFailure) throw submissionFailure.error
  if (submit) { gracefulEnd = Date.now() + timeoutMs; observationEnd = gracefulEnd + 5000 }
  for (;;) {
    if (!(await observe()).length) return snapshot()
    if (Date.now() >= gracefulEnd) break
    await delay(Math.min(25, Math.max(1, gracefulEnd - Date.now())))
  }
  const forceEnd = Math.min(observationEnd, Date.now() + 5000)
  let signalFailure
  for (;;) {
    const active = await observe()
    if (!active.length) return snapshot()
    if (Date.now() >= forceEnd) {
      if (signalFailure) throw signalFailure.error
      fail()
    }
    if (signalFailure && active.some(item => key(item) === signalFailure.key)) {
      await delay(25)
      continue
    }
    signalFailure = undefined
    const candidate = active.find(item => !signalled.has(key(item)) && !active.some(parent => parent.pid === item.parent))
      ?? active.find(item => !signalled.has(key(item)))
    if (candidate) {
      signalled.add(key(candidate))
      try { api.terminateKnownProcess(candidate) }
      catch (error) { signalFailure = { key: key(candidate), error } }
    }
    await delay(25)
  }
}
module.exports = { stopKnownProcessScope }
