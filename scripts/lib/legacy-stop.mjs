// Explicit takeover only: entries must already be fenced. Shutdown is sent once
// on the OS-verified existing RPC socket; observation never retries a mutation.
import { withVerifiedLegacyRuntime, discoverLegacyRuntime } from './legacy-runtime.mjs'
import identity from './process-identity.cjs'

const unknown = () => Object.assign(new Error('旧实例停止结果尚未确认；入口隔离和原数据已保留，未继续接管。'), { code: 'CRABOT_LEGACY_STOP_UNKNOWN' })
export async function stopFencedLegacyInstance(installation, { entryFenceId, signal, timeoutMs = 80_000 } = {}) {
  if (!entryFenceId || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 80_000) throw unknown()
  return withVerifiedLegacyRuntime(installation, async (snapshot, rpc) => {
    if (signal?.aborted) throw unknown()
    if (snapshot.state === 'stopped') return { state: 'stopped', request_acknowledged: null }
    let acknowledged = false
    try { await rpc.shutdown(); acknowledged = true } catch { /* A lost reply does not prove the old processes survived. */ }
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (signal?.aborted) throw unknown()
      let alive
      try { alive = [snapshot.controller, snapshot.mm].some(expected => identity.sameProcess(expected, identity.inspectProcess(expected.pid))) }
      catch { throw unknown() }
      if (!alive) break
      if (Date.now() >= deadline) throw unknown()
      await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())))
    }
    // Recheck the fenced source, every recognized launcher and module records.
    // A replacement/unknown process is never killed or labelled stopped.
    const current = await discoverLegacyRuntime(installation, { entryFenceId, signal })
    if (current.state !== 'stopped') throw unknown()
    return { state: 'stopped', request_acknowledged: acknowledged }
  }, { entryFenceId, signal })
}
