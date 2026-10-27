// Transport-neutral runtime registration dispatch. Each job version keeps its own verifier.
import path from 'node:path'
import management from './desktop-management.cjs'
import { createWorkspaceMaintenanceFileAccess } from '../../crabot-agent/dist/core/workspace-maintenance-files.js'
import { commitWorkspaceRecoveryRuntimeStart, verifyWorkspaceRecoveryRuntimeStart } from './workspace-recovery-records.mjs'
import { commitWorkspaceInterruptedRuntimeStart, verifyWorkspaceInterruptedRuntimeStart } from './workspace-interrupted-runtime.mjs'
const failure = () => Object.assign(new Error('恢复运行登记版本无法核实，未启动业务模块。'), { code: 'CRABOT_WORKSPACE_RUNTIME_GATE' })
const { owned, readJson } = createWorkspaceMaintenanceFileAccess(failure)
function interrupted(dataDir, recoveryId) {
  if (typeof recoveryId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(recoveryId)) throw failure()
  const data = management.requireExistingDataRoot(dataDir), control = path.join(data, 'workspace-control'), parent = path.join(control, 'relocation-recovery'), directory = path.join(parent, recoveryId)
  for (const file of [control, parent, directory]) owned(file, true, true)
  const launch = readJson(path.join(directory, 'launch.json'))
  if (!launch || ![1, 2].includes(launch.schema_version)) throw failure()
  return launch.schema_version === 2
}
export function verifyWorkspaceRuntimeStart(options) {
  return (interrupted(options.dataDir, options.recoveryId) ? verifyWorkspaceInterruptedRuntimeStart : verifyWorkspaceRecoveryRuntimeStart)(options)
}
export function commitWorkspaceRuntimeStart(options) {
  return (interrupted(options.dataDir, options.recoveryId) ? commitWorkspaceInterruptedRuntimeStart : commitWorkspaceRecoveryRuntimeStart)(options)
}
