import { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { WorkerProcessIdentity } from './types.js'

/** Actual carrier only; the caller owns the original legacy-boundary and runtime checks. */
export function captureHeadlessNativeProcesses(child: ChildProcess, legacyEnded?: true): ReadonlyArray<WorkerProcessIdentity> {
  if (legacyEnded === true && child instanceof ChildProcess && typeof child.pid === 'number' && child.pid > 0
    && (Number.isInteger(child.exitCode) || typeof child.signalCode === 'string' && child.signalCode.length > 0)) {
    return Object.freeze([])
  }
  const { captureSpawnedProcessTree } = require(join(__dirname, '../../../scripts/lib/spawned-process-tree.cjs'))
  return captureSpawnedProcessTree(child)
}
