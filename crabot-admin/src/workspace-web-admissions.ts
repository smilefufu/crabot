import { assertWorkspaceExecutionAllowed, workspaceMaintenancePending } from 'crabot-shared/dist/workspace-maintenance.js'

/** Authentication and static/read-only management stay outside this file/execution fence. */
export function requiresWorkspaceWebAdmission(method: string | undefined, pathname: string): boolean {
  if (pathname.startsWith('/tmp-pages/')) return true
  if (!pathname.startsWith('/api/') || pathname.startsWith('/api/media/')) return false
  if (pathname === '/api/workspaces/relocation/start') return false // The control request awaits the file drain.
  if (['/api/auth/login', '/api/auth/me', '/api/auth/change-password'].includes(pathname)) return false
  return method !== 'GET' && method !== 'HEAD'
    || pathname === '/api/backup/export'
    || /^\/api\/legacy-agent-archive\/[^/]+\/export$/.test(pathname)
    || pathname.startsWith('/api/channels/onboard/')
    || /^\/api\/agent\/workers\/[^/]+\/(?:terminal|trace|subagents(?:\/[^/]+(?:\/trace)?)?)$/.test(pathname)
}

const failure = () => Object.assign(new Error('工作目录正在迁移或维护状态无法核实，请在管理页面查看进度；暂不接受文件访问或配置、执行操作。'), { code: 'WORKSPACE_MAINTENANCE' })

/** Tracks complete handlers, not HTTP finish/close events or background execution exit. */
export class WorkspaceWebAdmissions {
  private closed = false
  private readonly pending = new Set<Promise<void>>()
  constructor(private readonly dataRoot: string) {}

  isClosed(): boolean { return this.closed }

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) throw failure()
    assertWorkspaceExecutionAllowed(this.dataRoot)
    let finish!: () => void
    const settled = new Promise<void>(resolve => { finish = resolve })
    this.pending.add(settled)
    try { return await action() }
    finally { this.pending.delete(settled); finish() }
  }

  closeAndDrain(): Promise<void> {
    if (!workspaceMaintenancePending(this.dataRoot)) throw failure()
    this.closed = true
    return this.drain()
  }

  /** Only the owning prepared completion may reclose after its durable fence was released. */
  async closeAfterFailedResume(): Promise<void> {
    this.closed = true
    while (this.pending.size) await Promise.all([...this.pending])
  }

  /** Internal prepared-job completion only; the caller owns current fixed-job authorization. */
  reopen(): void {
    assertWorkspaceExecutionAllowed(this.dataRoot)
    if (this.pending.size) throw failure()
    this.closed = false
  }

  private async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending])
    if (!workspaceMaintenancePending(this.dataRoot)) throw failure()
  }
}
