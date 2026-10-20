import { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { WorkerProcessObservation } from './types.js'

/** Actual carrier only; the caller owns the fixed-job and current runtime checks. */
export function captureHeadlessNativeProcesses(child: ChildProcess, allowObservedExit?: true): WorkerProcessObservation {
  if (allowObservedExit === true && child instanceof ChildProcess && typeof child.pid === 'number' && child.pid > 0
    && (Number.isInteger(child.exitCode) || typeof child.signalCode === 'string' && child.signalCode.length > 0)) {
    return Object.freeze({ carrier_exited: true })
  }
  const { captureSpawnedProcessTree } = require(join(__dirname, '../../../scripts/lib/spawned-process-tree.cjs'))
  return captureSpawnedProcessTree(child)
}
