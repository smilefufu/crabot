/**
 * WorkerInbox —— 每 worker 一个信箱(protocol-agent-v3 §5.5)。
 *
 * 语义:`send_to_worker` 投递永不因状态失败(唯一硬拒绝是 task 已 cancelled,由调用方在
 * 投递前把关,不属于本类职责);安全态(running / idle)即投,不安全态(provision 中、
 * 模态弹窗、化身交接间隙、僵尸态)暂扣,恢复后按序补投。
 *
 * hold 使用理由集合：`waiting_action` / `input_pending` 只允许显式 raw 控制键旁路；
 * provision / handoff 等其它理由属于 exclusive hold，连 raw 也阻断。理由可独立置位和释放，
 * 运输层 hold 不作为 CLI control state 的第二维持久化。
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
import type { LegacyContinuationAuth } from './legacy-continuation-auth.js'

export type InboxSettlement = 'delivered' | 'dead_letter'

export interface InboxSettlementDetail {
  readonly seq?: number
  readonly reason?: string
  readonly certainty?: 'not_delivered' | 'unknown'
}

export interface InboxSettledResult {
  readonly action: 'settled'
  readonly settlement: InboxSettlement
  readonly detail?: InboxSettlementDetail
}

export interface InboxItem {
  readonly text: string
  readonly raw: boolean
  /** Prioritize this item ahead of ordinary queued text without reordering redirects. */
  readonly immediate_redirect?: boolean
  readonly enqueued_at: string
  /** Stable identity for Manager-originated input. */
  readonly delivery_id?: string
  /** False for untrusted wakeups that must never revive a terminal task. */
  readonly allow_terminal_continuation?: boolean
  /** Process-local receipt; durable truth remains with the producer. */
  readonly onSettled?: (settlement: InboxSettlement, detail?: InboxSettlementDetail) => void | Promise<void>
  /** Pending is diagnostic only and never settles the producer receipt. */
  readonly onPending?: (reason: InboxDeliveryResult['reason']) => void | Promise<void>
  /** Recheck durable receipt state immediately before any adapter side effect. */
  readonly shouldDeliver?: () => boolean | Promise<boolean>
  /** Prevent a producer retry from enqueueing the same durable item twice in one process. */
  readonly dedupe_key?: string
  /** Opaque, in-process-only authorization for one legacy continuation. */
  readonly legacy_continuation_auth?: LegacyContinuationAuth
}

export interface InboxDeliveryResult {
  readonly action: 'hold_requeue' | 'hold_consumed'
  readonly reason: 'waiting_action' | 'input_pending'
  /** Synchronous ownership/state check evaluated immediately before committing the hold. */
  readonly isCurrent?: () => boolean
  /** Keep older consumed receipts ahead of the current requeued item. */
  readonly requeueAfter?: number
  /** Handoff may paste a full generated prompt while preserving the original durable receipt. */
  readonly replacement?: { readonly text: string; readonly raw: boolean }
}

export class WorkerInbox {
  private queue: InboxItem[] = []
  private readonly holds = new Set<string>()
  /** drain 当刻正在投递的 in-flight 条目;该条目投递失败时仅告警丢弃,post-drain 的条目失败走正常语义。 */
  private drainedInFlight: InboxItem | null = null
  /** flush 正在投递、已从 queue 取出但尚未结算成败的条目;drain 不把它计入结果。 */
  private inFlight: InboxItem | null = null
  /** Items pasted into a CLI composer: UI owns the text, but durable receipts still need settlement. */
  private consumedPending: InboxItem[] = []
  /** Serializes queue state transitions shared by flush and cancellation. */
  private readonly mutex = new AsyncMutex()
  /** Prevents two flush drivers from delivering concurrently without holding the state mutex across adapter IO. */
  private readonly flushMutex = new AsyncMutex()

  constructor(private readonly workerId: string) {}

  /** 入队;返回本次入队后的待投条数 */
  enqueue(item: InboxItem): number {
    this.queue.push(item)
    return this.queue.length
  }

  /** Insert a redirect after existing redirects and before ordinary queued text. */
  enqueuePriority(item: InboxItem): number {
    const index = this.queue.findIndex((candidate) => candidate.immediate_redirect !== true)
    if (index < 0) this.queue.push(item)
    else this.queue.splice(index, 0, item)
    return this.queue.length
  }

  /** Enqueue once per process while an item with the same stable key is queued or in flight. */
  enqueueUnique(item: InboxItem): boolean {
    if (item.dedupe_key === undefined) throw new Error('enqueueUnique requires dedupe_key')
    if (
      this.inFlight?.dedupe_key === item.dedupe_key ||
      this.consumedPending.some((consumed) => consumed.dedupe_key === item.dedupe_key) ||
      this.queue.some((queued) => queued.dedupe_key === item.dedupe_key)
    ) {
      return false
    }
    this.queue.push(item)
    return true
  }

  /** 入队首;仅用于首投not_pasted等已经明确未进入pane的所有权恢复。 */
  enqueueFront(item: InboxItem): number {
    this.queue.unshift(item)
    return this.queue.length
  }

  /** Mark delivery unsafe. waiting_action/input_pending permit an explicit raw control key. */
  hold(reason: string): void {
    this.holds.add(reason)
  }

  release(reason?: string): void {
    if (reason) this.holds.delete(reason)
    else this.holds.clear()
  }

  get held(): boolean {
    return this.holds.size > 0
  }

  private get rawBypassOnly(): boolean {
    return this.holds.size > 0 && [...this.holds].every((reason) => reason === 'waiting_action' || reason === 'input_pending')
  }

  get pending(): number {
    return this.queue.length + this.consumedPending.length
  }

  /** Settle durable receipts whose text was pasted and later submitted/abandoned via raw input. */
  async settleConsumed(settlement: InboxSettlement, detail?: InboxSettlementDetail): Promise<number> {
    const items = this.consumedPending.splice(0)
    for (const item of items) await this.settle(item, settlement, detail)
    return items.length
  }

  /** Remove a delivery that has not entered the adapter. In-flight/composer-owned input is unsafe. */
  async cancelDelivery(deliveryId: string): Promise<'cancelled' | 'unsafe' | 'not_found'> {
    return this.mutex.run(async () => {
      if (
        this.inFlight?.delivery_id === deliveryId ||
        this.consumedPending.some((item) => item.delivery_id === deliveryId)
      ) {
        return 'unsafe'
      }
      const index = this.queue.findIndex((item) => item.delivery_id === deliveryId)
      if (index < 0) return 'not_found'
      this.queue.splice(index, 1)
      return 'cancelled'
    })
  }

  /** Remove an undelivered non-durable item by identity (used by control preflight failure). */
  async cancelItem(item: InboxItem): Promise<'cancelled' | 'unsafe' | 'not_found'> {
    return this.mutex.run(async () => {
      if (this.inFlight === item || this.consumedPending.includes(item)) return 'unsafe'
      const index = this.queue.indexOf(item)
      if (index < 0) return 'not_found'
      this.queue.splice(index, 1)
      return 'cancelled'
    })
  }

  /** A pane incarnation ended; replay consumed durable items in the next incarnation. */
  requeueConsumed(): number {
    const items = this.consumedPending.splice(0)
    if (items.length > 0) this.queue.unshift(...items)
    return items.length
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
  async flush(
    deliver: (item: InboxItem) => Promise<InboxSettlement | InboxDeliveryResult | InboxSettledResult | void>,
  ): Promise<number> {
    return this.flushMutex.run(async () => {
      let delivered = 0
      while (true) {
        const item = await this.mutex.run(async () => {
          if (this.queue.length === 0 || (this.held && !this.rawBypassOnly)) return undefined
          const index = this.held ? this.queue.findIndex((candidate) => candidate.raw) : 0
          if (index < 0) return undefined
          const [next] = this.queue.splice(index, 1)
          this.inFlight = next
          return next
        })
        if (!item) break
        try {
          if (item.shouldDeliver && !await item.shouldDeliver()) {
            await this.mutex.run(async () => { this.inFlight = null })
            continue
          }
          const result = await deliver(item)
          const keepFlushing = await this.mutex.run(async () => {
            this.inFlight = null
            if (typeof result !== 'object') {
              delivered++
              await this.settle(item, typeof result === 'string' ? result : 'delivered')
              return true
            }
            if (result.action === 'settled') {
              delivered++
              await this.settle(item, result.settlement, result.detail)
              return true
            }
            const retainedItem = result.replacement
              ? { ...item, text: result.replacement.text, raw: result.replacement.raw }
              : item
            if (result.isCurrent && !result.isCurrent()) {
              if (this.drainedInFlight === item || item.raw) {
                await this.settle(item, 'dead_letter')
                delivered++
              } else {
                this.queue.unshift(retainedItem)
              }
              return true
            }
            this.hold(result.reason)
            if (result.action === 'hold_requeue') {
              if (this.drainedInFlight === item) await this.settle(item, 'dead_letter')
              else this.queue.splice(Math.min(result.requeueAfter ?? 0, this.queue.length), 0, retainedItem)
            } else if (this.drainedInFlight === item) {
              await this.settle(item, 'dead_letter')
            } else {
              if (retainedItem.onSettled) this.consumedPending.push(retainedItem)
              delivered++
            }
            await this.markPending(item, result.reason)
            return false
          })
          if (!keepFlushing) break
        } catch (err) {
          const dropAfterDrain = await this.mutex.run(async () => {
            this.inFlight = null
            if (this.drainedInFlight !== item) {
              // post-drain enqueue 的条目或其他情况:走正常语义(放回、抛出)
              this.queue.unshift(item)
              return false
            }
            // 该条正好是 drain 当刻的 in-flight:化身已终结,drain 早已把 queue 清空并
            // 作为 dead-letter 交给调用方。这条已经没有队列可放回、也没有人再等这次
            // flush 的结果——放回会造成"凭空复活"的幽灵条目,原样向上抛则可能砸向已不再
            // 等待的调用方,变成未处理的 promise rejection。因此仅告警丢弃。
            console.warn(
              `[WorkerInbox:${this.workerId}] deliver failed after drain, dropping in-flight item: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
            await this.settle(item, 'dead_letter')
            return true
          })
          if (dropAfterDrain) return delivered
          throw err
        }
      }
      return delivered
    })
  }

  private async settle(item: InboxItem, settlement: InboxSettlement, detail?: InboxSettlementDetail): Promise<void> {
    if (!item.onSettled) return
    try {
      if (detail) await item.onSettled(settlement, detail)
      else await item.onSettled(settlement)
    } catch (error) {
      // Delivery already happened (or was durably dead-lettered). Requeueing here
      // would duplicate input; the producer keeps its durable pending receipt and
      // reconciles it without automatically replaying the input.
      console.warn(`[WorkerInbox:${this.workerId}] settlement callback failed:`, error)
    }
  }

  private async markPending(item: InboxItem, reason: InboxDeliveryResult['reason']): Promise<void> {
    if (!item.onPending) return
    try {
      await item.onPending(reason)
    } catch (error) {
      console.warn(`[WorkerInbox:${this.workerId}] pending callback failed:`, error)
    }
  }

  /**
   * 取出全部并清空(化身终结时 dead-letter 用)。同步执行、不走 mutex——化身终结时
   * 可能正有一轮 flush 卡在 deliver 上(如 tmux 命令挂起、长时间不返回),drain 不能
   * 无限等锁卡住终结流程。返回结果包含已经 paste、仍等待 raw 决议的 durable receipt，
   * 但不含当前 in-flight 条目:它的成败由 flush 自己结算
   * (成功计入投递、失败见 flush 的 catch 分支),避免同一条目既投递又进 dead-letter。
   */
  drain(): InboxItem[] {
    // 记录 drain 当刻的 in-flight 条目,以便 flush 的 catch 分支判断是否需要吞掉错误
    this.drainedInFlight = this.inFlight
    const items = [...this.consumedPending, ...this.queue]
    this.consumedPending = []
    this.queue = []
    return items
  }
}
