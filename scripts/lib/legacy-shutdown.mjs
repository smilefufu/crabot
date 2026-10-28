// Neutral shutdown mechanism. Callers separately prove installation, UID,
// data binding and fencing before providing the verified socket and final view.
import identity from './process-identity.cjs'

export const legacyStopUnknown = () => Object.assign(new Error('旧实例停止结果尚未确认；入口隔离和原数据已保留，未继续接管。'), { code: 'CRABOT_LEGACY_STOP_UNKNOWN' })
function observedLegacyTree(snapshot) {
  const unknown = legacyStopUnknown, roots = [snapshot.controller, snapshot.mm]
  const owner = identity.inspectProcess(process.pid)?.owner
  if (!owner || roots.some(root => !root || root.owner !== owner || !identity.sameProcess(root, identity.inspectProcess(root.pid)))) throw unknown()
  const processes = []
  for (const pid of identity.listProcessIds()) {
    try { const current = identity.inspectProcess(pid); if (current) processes.push(current) }
    catch { /* Other users/inaccessible or already-exited processes are not adopted. */ }
  }
  const observed = new Map(roots.map(root => [root.pid, root]))
  for (let changed = true; changed;) {
    changed = false
    for (const current of processes) {
      if (observed.has(current.pid) || !observed.has(current.parent)) continue
      if (current.owner !== owner) throw unknown()
      if (!identity.sameProcess(current, identity.inspectProcess(current.pid))) continue
      observed.set(current.pid, current); changed = true
    }
  }
  if (roots.some(root => !identity.sameProcess(root, identity.inspectProcess(root.pid)))) throw unknown()
  return [...observed.values()]
}

export async function shutdownObservedLegacyRuntime(snapshot, rpc, observeStopped, { signal, timeoutMs = 80_000 } = {}) {
  const unknown = legacyStopUnknown
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 80_000) throw unknown()
  if (signal?.aborted) throw unknown()
  if (snapshot.state === 'stopped') return { state: 'stopped', request_acknowledged: null }
  let observed
  try { observed = observedLegacyTree(snapshot) } catch { throw unknown() }
  let acknowledged = false
  try { await rpc.shutdown(); acknowledged = true } catch { /* A lost reply does not prove the old processes survived. */ }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) throw unknown()
    let alive
    try { alive = observed.some(expected => identity.sameProcess(expected, identity.inspectProcess(expected.pid))) }
    catch { throw unknown() }
    if (!alive) break
    if (Date.now() >= deadline) throw unknown()
    await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())))
  }
  // Recheck the fenced source, every recognized launcher and module records.
  // A replacement/unknown process is never killed or labelled stopped.
  const current = await observeStopped()
  if (current.state !== 'stopped') throw unknown()
  return { state: 'stopped', request_acknowledged: acknowledged }
}
