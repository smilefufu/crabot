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
  /** False for untrusted wakeups that must never revive a terminal task. */
  readonly allow_terminal_continuation?: boolean
}

export class WorkerInbox {
  private queue: InboxItem[] = []
  private _held = false
  /** drain 当刻正在投递的 in-flight 条目;该条目投递失败时仅告警丢弃,post-drain 的条目失败走正常语义。 */
  private drainedInFlight: InboxItem | null = null
  /** flush 正在投递、已从 queue 取出但尚未结算成败的条目;drain 不把它计入结果。 */
  private inFlight: InboxItem | null = null
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
   * deliver 抛错时该条放回队首、停止本轮、原样向上抛出——除非投递期间已被 drain
   * 且该条正好是 drain 当刻的 in-flight 条目(见下方 catch 分支)。
   *
   * 投递中的条目在 await deliver() 之前就从 queue 取出、记到 inFlight,而不是等
   * deliver 返回后再 shift:这样 drain() 才能在 deliver 卡住期间安全地把 queue
   * 视为"确定未投递"的快照,不会把正在投递、随后可能投递成功的条目也一并当作
   * dead-letter 带走,避免同一条目既真正投递、又混进 dead-letter 批次重复投递。
   *
   * pending:返回队列中的待投条数。注意:在 await deliver() 期间,该条已从 queue
   * 取出(shift),所以 pending 不计入 in-flight 条目。
   */
  async flush(deliver: (item: InboxItem) => Promise<void>): Promise<number> {
    return this.mutex.run(async () => {
      let delivered = 0
      while (this.queue.length > 0 && !this._held) {
        const item = this.queue.shift()!
        this.inFlight = item
        try {
          await deliver(item)
          this.inFlight = null
          delivered++
        } catch (err) {
          this.inFlight = null
          if (this.drainedInFlight === item) {
            // 该条正好是 drain 当刻的 in-flight:化身已终结,drain 早已把 queue 清空并
            // 作为 dead-letter 交给调用方。这条已经没有队列可放回、也没有人再等这次
            // flush 的结果——放回会造成"凭空复活"的幽灵条目,原样向上抛则可能砸向已不再
            // 等待的调用方,变成未处理的 promise rejection。因此仅告警丢弃。
            console.warn(
              `[WorkerInbox:${this.workerId}] deliver failed after drain, dropping in-flight item: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
            return delivered
          }
          // post-drain enqueue 的条目或其他情况:走正常语义(放回、抛出)
          this.queue.unshift(item)
          throw err
        }
      }
      return delivered
    })
  }

  /**
   * 取出全部并清空(化身终结时 dead-letter 用)。同步执行、不走 mutex——化身终结时
   * 可能正有一轮 flush 卡在 deliver 上(如 tmux 命令挂起、长时间不返回),drain 不能
   * 无限等锁卡住终结流程。返回结果不含 in-flight 条目:它的成败由 flush 自己结算
   * (成功计入投递、失败见 flush 的 catch 分支),避免同一条目既投递又进 dead-letter。
   */
  drain(): InboxItem[] {
    // 记录 drain 当刻的 in-flight 条目,以便 flush 的 catch 分支判断是否需要吞掉错误
    this.drainedInFlight = this.inFlight
    const items = this.queue
    this.queue = []
    return items
  }
}
