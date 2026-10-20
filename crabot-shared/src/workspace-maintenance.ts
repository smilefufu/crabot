import { lstatSync } from 'node:fs'
import path from 'node:path'

/** Read-only admission fence, not authority to execute or proof that execution stopped. */
export function workspaceMaintenancePending(dataRoot: string): boolean {
  const control = path.join(dataRoot, 'workspace-control')
  try {
    const parent = lstatSync(control)
    if (!parent.isDirectory() || parent.isSymbolicLink()) return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
  // Any known activity entry blocks, including an orphaned fixed set or dangling link.
  for (const file of [
    'relocation.json', 'relocation-workers.json', 'relocation-worker-processes.json',
    'relocation-stop-attempt.json', 'relocation-stop-submission.json',
    'relocation-modules.json', 'relocation-module-stop-attempt.json',
    'relocation-module-processes', 'relocation-module-stop-submission.json',
    'relocation-coordinator.json', 'relocation-coordinator-ready.json',
  ]) {
    try { lstatSync(path.join(control, file)); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true }
  }
  return false
}

export function assertWorkspaceExecutionAllowed(dataRoot: string): void {
  if (workspaceMaintenancePending(dataRoot)) throw Object.assign(
    new Error('工作目录正在迁移或维护状态无法核实，暂不接受新执行；请在管理页面查看进度和恢复提示。'),
    { code: 'WORKSPACE_MAINTENANCE' },
  )
}
