// Explicit takeover only: entries must already be fenced. Shutdown is sent once
// on the OS-verified existing RPC socket; observation never retries a mutation.
import { withVerifiedLegacyRuntime, discoverLegacyRuntime } from './legacy-runtime.mjs'
import { shutdownObservedLegacyRuntime, legacyStopUnknown as unknown } from './legacy-shutdown.mjs'

export async function stopFencedLegacyInstance(installation, { entryFenceId, signal, timeoutMs = 80_000 } = {}) {
  if (!entryFenceId || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 80_000) throw unknown()
  return withVerifiedLegacyRuntime(installation, (snapshot, rpc) => shutdownObservedLegacyRuntime(snapshot, rpc,
    () => discoverLegacyRuntime(installation, { entryFenceId, signal }), { signal, timeoutMs }), { entryFenceId, signal })
}
