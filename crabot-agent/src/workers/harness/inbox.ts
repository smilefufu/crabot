/**
 * WorkerInbox —— 每 worker 一个信箱(protocol-agent-v3 §5.5)。
 *
 * 语义:`send_to_worker` 投递永不因状态失败(唯一硬拒绝是 task 已 cancelled,由调用方在
 * 投递前把关,不属于本类职责);安全态(running / idle)即投,不安全态(provision 中、
 * 模态弹窗、化身交接间隙、僵尸态)暂扣,恢复后按序补投。
 *
 * hold 选择"布尔"而非计数:harness 侧的暂扣场景(provision / 化身交接)是互斥的单一状态,
 * 不存在"多个理由同时暂扣、需要逐个撤销"的嵌套需求;若未来出现需要嵌套暂扣的场景,再改
 * 计数并补测,不在此提前引入复杂度。
 *
 * flush 并发安全:用 AsyncMutex 串行化同一信箱的 flush 调用,避免两轮并发 flush 重复投递
 * 同一条(P1 builtin sendInput 双发竞态同型问题)。deliver 抛错时该条留在队首、停止本轮、
 * 原样向上抛出,不吞错也不丢消息。
 *
 * 纯内存态,无 IO:P3 范围内信箱不跨进程重启存活;后续如需持久化,由 harness 层在此类之上
 * 加落盘,不在本类内引入。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §5.5
 */

import { AsyncMutex } from '../async-mutex'

export interface InboxItem {
  readonly text: string
  readonly raw: boolean
  readonly enqueued_at: string
}

export class WorkerInbox {
  private queue: InboxItem[] = []
  private _held = false
  private readonly mutex = new AsyncMutex()

  constructor(private readonly workerId: string) {}

  /** 入队;返回本次入队后的待投条数 */
  enqueue(item: InboxItem): number {
    this.queue.push(item)
    return this.queue.length
  }

  /** 标记不安全(如 provision/交接中),期间 flush 不投递 */
  hold(_reason: string): void {
    this._held = true
  }

  release(): void {
    this._held = false
  }

  get held(): boolean {
    return this._held
  }

  get pending(): number {
    return this.queue.length
  }

  /**
   * 按序投递直到队空或再次被 hold。同一信箱上的并发 flush 调用经 mutex 串行化,
   * 保证同一时刻只有一轮在投递,不会重复投递同一 item。
   * deliver 抛错时该条留在队首(不 shift)、停止本轮、原样向上抛出。
   */
  async flush(deliver: (item: InboxItem) => Promise<void>): Promise<number> {
    return this.mutex.run(async () => {
      let delivered = 0
      while (this.queue.length > 0 && !this._held) {
        const item = this.queue[0]
        await deliver(item)
        this.queue.shift()
        delivered++
      }
      return delivered
    })
  }

  /** 取出全部并清空(化身终结时 dead-letter 用) */
  drain(): InboxItem[] {
    const items = this.queue
    this.queue = []
    return items
  }
}
