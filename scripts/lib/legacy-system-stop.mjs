// The dedicated conversion coordinator owns authorization and the root fence.
// This adapter runs after UID drop and never signals by PID/name/port.
import { withFencedLegacySystemRuntime } from './legacy-system-runtime.mjs'
import { shutdownObservedLegacyRuntime, legacyStopUnknown as unknown } from './legacy-shutdown.mjs'

// runtimeOptions are controlled test observers, never CLI/permit/env fields.
export async function stopFencedLegacySystemInstance(context, { expected, signal, timeoutMs = 80_000, runtimeOptions } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 80_000) throw unknown()
  const options = { ...runtimeOptions, signal }
  return withFencedLegacySystemRuntime(context, expected, (snapshot, rpc) => shutdownObservedLegacyRuntime(snapshot, rpc,
    () => withFencedLegacySystemRuntime(context, expected, observed => observed, options), { signal, timeoutMs }), options)
}
