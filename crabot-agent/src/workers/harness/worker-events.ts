/**
 * WorkerEventLog —— worker 化身事件流:每个 workerDir 一份 events.jsonl,append-only。
 * 读写纪律参照 src/workers/cli-events.ts:坏行跳过不抛,半行(尚无换行符终结,写入未完成)
 * 不消费,留到下次补全后再读。当前是每次全量读(P3 规模足够);若将来量大需要增量读,
 * 再加 cursor 支持。
 *
 * harvestNativeSession 是化身终结时的收尾动作:把 adapter 侧的原生 session 文件(如
 * claude code / codex 自己维护的会话文件)尽力复制进 <workerDir>/native-session/<seq>/,
 * 单个源文件缺失或读取失败只 warn,不影响其它源文件的收割,也不让收割动作本身抛出。
 */

import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { AsyncMutex } from '../async-mutex'
import type { TaskStatus } from './ledger-types'

export type HarnessEventKind =
  | 'spawned'
  | 'activity_available'
  | 'turn_completed'
  | 'operation_settled'
  | 'input_sent'
  | 'input_held'
  | 'state_changed'
  | 'exited'
  | 'killed'
  | 'superseded'
  | 'handoff_started'
  | 'resumed'
  | 'input_delivery_failed'
  /**
   * query 建立或执行失败的持久审计事件。建立失败同时在原工具调用返回结构化错误；执行失败
   * 通过 query receipt 的 operation notification 唤醒 owning Manager。稳定关联字段为
   * `detail.query_id`，已建立 fork 的终态另外带 `detail.fork_seq`。
   */
  | 'query_failed'
  | 'query_completed'
  | 'supervision_due'
  /** Durable wake for a mainline execution carrier that was confirmed crashed after restart. */
  | 'worker_recovery_required'
  /** v2 import history record: persisted only, never bridged to a Manager wake. */
  | 'legacy_imported'

export interface HarnessEvent {
  readonly ts: string
  readonly kind: HarnessEventKind
  readonly worker_id: string
  readonly seq: number
  readonly detail?: Record<string, unknown>
  /**
   * 本条事件**所伴随的那次 task 状态迁移落账后**的 task.status。
   *
   * 为什么必须由事件自带(P5 修复):`HarnessEvent` 本身是**化身级**的,订阅方(见
   * manager/events.ts 的 `makeTaskStatusEventBridge`)要把它翻译成任务级的
   * `agent.task_status_changed`,就得知道"这次迁移之后 task 是什么状态"。此前订阅方是拿
   * `worker_id` **现读台账**取这个值——而 `LedgerStore.findWorker` 不进互斥锁、读的永远是
   * 最新已提交文件,只要这次读发生在**下一次落账之后**,中间那个状态(含 `completed` 这类
   * 终态)就被整条吞掉,订阅方一次都收不到。把值钉在事件上,读取时刻就与落账时刻解耦。
   *
   * 取值来源:`LedgerStore.upsertWorker` 的返回值(即真正写进台账的那份 worker)的
   * `task.status`,不是 harness 自己另算一遍——保证事件里的值与盘上的值同源。
   *
   * **可选**,只有真正发生 task 状态迁移的事件点才带(见 harness.ts `appendEvent` 的调用点
   * 分类):化身级事件(`input_sent`、fork 分支的 `state_changed`、`query_failed`、
   * dead-letter 等)与纯记录事件不带。缺席时订阅方退回现读台账(即修复前的行为),
   * 不当作"无迁移"静默丢弃。
   */
  readonly task_status?: TaskStatus
}

/**
 * 订阅方(P4 装配层 → `ManagerRegistry.routeWorkerEvent`)对**一条** harness 事件的投递结果。
 *
 * 只有活性巡检需要它(见 harness.ts `sweepLiveness` 的去重规则):同一次停摆只该报一次,
 * 否则每轮巡检唤醒一次 manager 就是烧 token 的热循环;但 manager 侧 episode 失败时那次唤醒
 * 等于没发生过(`consumedEvents !== true` ⇒ 整批输入被推回 mailbox),必须允许下一轮重报——
 * 这正是"manager 死了就挂起来、恢复了再通知"的实现,不另造机制。
 *
 * 其余事件点一律 fire-and-forget,不看这个返回值。
 */
export interface HarnessEventDelivery {
  /** manager 是否真的消费了这次唤醒(episode 成功收口)。 */
  readonly consumed: boolean
}

function parseLine(line: string): HarnessEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.ts === 'string' &&
      typeof parsed.kind === 'string' &&
      typeof parsed.worker_id === 'string' &&
      typeof parsed.seq === 'number'
    ) {
      // task_status 是 P5 additive 字段:老日志文件里没有,读回来就是没有(与在线事件缺席
      // 时同一含义,见字段注释)。按字符串校验后原样带回,不让往返读丢字段。
      const base: HarnessEvent = {
        ts: parsed.ts,
        kind: parsed.kind,
        worker_id: parsed.worker_id,
        seq: parsed.seq,
      }
      const event: HarnessEvent =
        typeof parsed.task_status === 'string' ? { ...base, task_status: parsed.task_status } : base
      return 'detail' in parsed ? { ...event, detail: parsed.detail } : event
    }
    return null
  } catch {
    return null // 坏行:跳过,不中断
  }
}

export class WorkerEventLog {
  private readonly filePath: string
  private readonly mutex = new AsyncMutex()

  constructor(private readonly workerDir: string) {
    this.filePath = join(workerDir, 'events.jsonl')
  }

  /** 缺省 ts 由调用方注入的 now 提供;未提供时用当前时间兜底(仅作最后手段,优先由调用方注入以保证测试确定性) */
  async append(e: Omit<HarnessEvent, 'ts'> & { ts?: string }): Promise<void> {
    const event: HarnessEvent = { ...e, ts: e.ts ?? new Date().toISOString() }
    const line = JSON.stringify(event) + '\n'
    return this.mutex.run(async () => {
      await fs.mkdir(this.workerDir, { recursive: true })
      await fs.appendFile(this.filePath, line, 'utf-8')
    })
  }

  async readAll(): Promise<HarnessEvent[]> {
    let text: string
    try {
      text = await fs.readFile(this.filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const events: HarnessEvent[] = []
    for (const line of text.split('\n')) {
      const event = parseLine(line)
      if (event) events.push(event)
    }
    return events
  }
}

/** 化身终结时把 adapter 的原生 session 文件收割进 <workerDir>/native-session/<seq>/,失败仅记不抛 */
export async function harvestNativeSession(
  workerDir: string,
  seq: number,
  sourcePaths: readonly string[]
): Promise<void> {
  const targetDir = join(workerDir, 'native-session', String(seq))
  for (const sourcePath of sourcePaths) {
    try {
      await fs.mkdir(targetDir, { recursive: true })
      await fs.copyFile(sourcePath, join(targetDir, basename(sourcePath)))
    } catch (error) {
      console.warn(`[harvestNativeSession] 收割原生 session 文件失败,跳过: ${sourcePath}: ${(error as Error).message}`)
    }
  }
}
