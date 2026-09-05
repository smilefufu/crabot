/**
 * Per-session coalescing mailbox（actor model 风格）。
 *
 * 同 key 的 enqueue 串行处理；handler 处理期间到达的 item 进入队列，
 * handler 返回后一次性 take 整批进入下一轮。空了自动从 registry 注销。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-20-session-lane-dispatcher-design.md §3.2
 */

export type BatchHandler<T> = (batch: ReadonlyArray<T>) => Promise<void>

export interface SessionLaneSnapshot<T> {
  current: T[]
  queued: T[]
}

export class SessionLane<T> {
  private queue: T[] = []
  private current: ReadonlyArray<T> = []
  private processing = false

  constructor(
    readonly key: string,
    private readonly handler: BatchHandler<T>,
    private readonly onDispose: (key: string) => void,
  ) {}

  enqueue(item: T): void {
    this.queue.push(item)
    void this.kick()
  }

  isIdle(): boolean {
    return !this.processing && this.queue.length === 0
  }

  /** 当前 handler batch 与后续 queue 的同步副本；读取不改变 lane 顺序。 */
  snapshot(): SessionLaneSnapshot<T> {
    return { current: [...this.current], queued: [...this.queue] }
  }

  private async kick(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0)
        this.current = batch
        try {
          await this.handler(batch)
        } catch (err) {
          // handler 内部应该自己 catch；这里只防御性兜底
          console.error(`[session-lane:${this.key}] handler threw:`, err instanceof Error ? err.message : String(err))
        } finally {
          this.current = []
        }
      }
    } finally {
      this.processing = false
      if (this.queue.length === 0) this.onDispose(this.key)
    }
  }
}

export class SessionLaneRegistry<T> {
  private lanes = new Map<string, SessionLane<T>>()

  constructor(private readonly handler: BatchHandler<T>) {}

  getOrCreate(key: string): SessionLane<T> {
    let lane = this.lanes.get(key)
    if (!lane) {
      lane = new SessionLane<T>(key, this.handler, (k) => this.dispose(k))
      this.lanes.set(key, lane)
    }
    return lane
  }

  snapshot(key: string): SessionLaneSnapshot<T> {
    return this.lanes.get(key)?.snapshot() ?? { current: [], queued: [] }
  }

  private dispose(key: string): void {
    const lane = this.lanes.get(key)
    if (lane && lane.isIdle()) this.lanes.delete(key)
  }

  /** 测试 / 调试用 */
  size(): number {
    return this.lanes.size
  }
}
