import { ChildProcess } from 'node:child_process'
import type { BgEntityRegistry } from '../../../src/engine/bg-entities/registry.js'
import type { WorkerProcessIdentity } from '../../../src/workers/types.js'

export async function stopTrackedTestShells(registry: BgEntityRegistry): Promise<void> {
  const native = require('../../../../scripts/lib/process-identity.cjs')
  const { stopKnownProcessScope } = require('../../../../scripts/lib/known-process-stop.cjs')
  const bindings = (registry as unknown as { shellProcesses: Map<string, { child?: ChildProcess }> }).shellProcesses
  const roots: WorkerProcessIdentity[] = []
  for (const { child } of bindings.values()) {
    if (!child) continue
    if (!(child instanceof ChildProcess)) throw new Error('Fixture did not retain its actual child')
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue
    const root = native.inspectProcess(child.pid)
    if (!root || root.pid !== child.pid || root.parent !== process.pid) throw new Error('Fixture child identity is unavailable')
    roots.push(root)
  }
  if (roots.length) await stopKnownProcessScope(roots, { timeoutMs: 1, onObserved: async () => {} })
}
