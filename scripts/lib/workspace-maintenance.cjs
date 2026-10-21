// Bootstrap cannot depend on code inside an unverified/absent Core package.
// Keep this fixed-location read in parity with the Shared execution guard.
const { lstatSync } = require('node:fs')
const path = require('node:path')
function workspaceMaintenancePending(dataRoot) {
  const control = path.join(dataRoot, 'workspace-control')
  try {
    const parent = lstatSync(control)
    if (!parent.isDirectory() || parent.isSymbolicLink()) return true
  } catch (error) { return error.code !== 'ENOENT' }
  for (const file of [
    'relocation.json', 'relocation-workers.json', 'relocation-worker-processes.json',
    'relocation-stop-attempt.json', 'relocation-stop-submission.json',
    'relocation-modules.json', 'relocation-module-stop-attempt.json',
    'relocation-module-processes', 'relocation-module-stop-submission.json',
    'relocation-coordinator.json', 'relocation-coordinator-ready.json', 'relocation-process-stop.jsonl', 'relocation-execution-exit.json', 'relocation-files.json', 'relocation-file-actors.jsonl', 'relocation-worker-closure.json', 'relocation-worker-commits', 'relocation-manager-closure.json', 'relocation-manager-complete.json', 'relocation-root-plan.json', 'relocation-root-published.json', 'relocation-root-selected.json',
  ]) {
    try { lstatSync(path.join(control, file)); return true }
    catch (error) { if (error.code !== 'ENOENT') return true }
  }
  return false
}
const failure = () => Object.assign(new Error('工作目录正在迁移或维护状态无法核实，暂不接受新执行；请在管理页面查看进度和恢复提示。'), { code: 'WORKSPACE_MAINTENANCE' })
function assertWorkspaceExecutionAllowed(dataRoot) {
  if (workspaceMaintenancePending(dataRoot)) throw failure()
}
module.exports = { workspaceMaintenancePending, assertWorkspaceExecutionAllowed, failure }
