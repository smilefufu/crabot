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
  try { lstatSync(path.join(control, 'relocation.json')); return true }
  catch (error) { return error.code !== 'ENOENT' }
}
const failure = () => Object.assign(new Error('工作目录正在迁移或维护状态无法核实，暂不接受新执行；请在管理页面查看进度和恢复提示。'), { code: 'WORKSPACE_MAINTENANCE' })
function assertWorkspaceExecutionAllowed(dataRoot) {
  if (workspaceMaintenancePending(dataRoot)) throw failure()
}
module.exports = { workspaceMaintenancePending, assertWorkspaceExecutionAllowed, failure }
