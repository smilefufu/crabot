/** Tracks runtime establishment only; drainage never proves executions have stopped. */
export class WorkerExecutionAdmissions {
  private closed = false
  private cleanupFailed = false
  private readonly pending = new Set<Promise<void>>()

  assertOpen(): void {
    if (this.closed) throw this.failure('工作目录正在迁移，暂不创建或续办执行器。')
  }

  async run<T>(action: () => Promise<T>): Promise<T> {
    this.assertOpen()
    let finish!: () => void
    const settled = new Promise<void>(resolve => { finish = resolve })
    this.pending.add(settled)
    try { return await action() }
    finally { this.pending.delete(settled); finish() }
  }

  /** A timeout reply does not settle the native fork or its late cleanup. */
  trackCleanup(operation: Promise<unknown>): void {
    const settled = operation.then(() => {}, () => { if (this.closed) this.cleanupFailed = true })
    this.pending.add(settled)
    void settled.then(() => this.pending.delete(settled))
  }

  async closeAndDrain(): Promise<void> {
    this.closed = true
    while (this.pending.size) await Promise.all([...this.pending])
    if (this.cleanupFailed) throw this.failure('迟到执行的清理未能核实，已保留文件与维护保护，不能继续迁移。')
  }

  private failure(message: string): Error {
    return Object.assign(new Error(message), { code: 'WORKSPACE_MAINTENANCE' })
  }
}
