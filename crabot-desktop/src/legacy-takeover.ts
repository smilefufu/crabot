// Explicit existing-user installation only. The target Node owns data changes;
// ordinary target Main still owns service and CLI health after this returns.
import type { PreparedInstallation } from './installation-entries.js'
const load = (name: string): Promise<any> => import(new URL('./bootstrap/scripts/lib/' + name, import.meta.url).href)
export type LegacyTakeoverSource = { installation: { version: string; installRoot: string; dataRoot: string; fingerprint: string }; entryFenceId?: string }
export async function discoverLegacyTakeover(root: string): Promise<LegacyTakeoverSource | null> {
  const { discoverLegacyDesktopTakeover } = await load('legacy-desktop-discovery.mjs')
  return discoverLegacyDesktopTakeover({ root, source: process.env })
}
export async function installLegacyTakeover(options: {
  payload: string; source: LegacyTakeoverSource; signal: AbortSignal
  registerEntries: (prepared: PreparedInstallation) => Promise<void>; progress: (phase: string) => void
}): Promise<{ executable: string; dataDir: string; verification_pending: true; health_verified: false }> {
  const { prepareLegacyDesktopPrograms } = await load('legacy-desktop-programs.mjs')
  const prepared = await prepareLegacyDesktopPrograms({ payload: options.payload, ...options.source, signal: options.signal, progress: options.progress })
  options.signal.throwIfAborted()
  const { runPreparedLegacyDesktopTakeover } = await load('legacy-desktop-handoff.mjs')
  return runPreparedLegacyDesktopTakeover({ prepared, entryFenceId: options.source.entryFenceId,
    signal: options.signal, registerEntries: options.registerEntries, progress: options.progress })
}
