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
  try {
    // Any entry blocks: never trust a claimed completed phase, or follow a dangling link.
    lstatSync(path.join(control, 'relocation.json'))
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

export function assertWorkspaceExecutionAllowed(dataRoot: string): void {
  if (workspaceMaintenancePending(dataRoot)) throw Object.assign(
    new Error('工作目录正在迁移或维护状态无法核实，暂不接受新执行；请在管理页面查看进度和恢复提示。'),
    { code: 'WORKSPACE_MAINTENANCE' },
  )
}
