/**
 * WorkerHarness —— 生命周期编排(protocol-agent-v3 §5.2/§5.5,plans/2026-07-29-mw-p3-ledger-harness.md Task 7)。
 *
 * 职责边界:harness 编排台账(LedgerStore)/信箱(WorkerInbox)/事件流(WorkerEventLog)/workspace
 * (WorkspaceManager)与三个 WorkerAdapter 实现,是 P4 manager 唯一的调用对象。harness 不感知任何
 * adapter 内部实现细节,只经 WorkerAdapter 契约方法(provision/spawn/sendInput/kill/fork/state/…)
 * 获取运行时事实——不读 adapter 的 meta-<seq>.json。
 *
 * 锁层级(必须遵守,避免 ABBA):
 *   外层:harness 自己维护的"每 worker 一把" AsyncMutex(this.mutexes,按 worker_id 取)。
 *   内层:LedgerStore 内部按 DialogObjectId 维护的另一把 AsyncMutex,完全不透明,只在单次
 *        `ledger.upsertWorker(...)` 调用内部短暂持有(mutator 是同步纯函数,写盘后立即释放)。
 * harness 从不显式持有 ledger 的锁,也从不在“持有 ledger 锁”的状态下反过来等待自己的
 * per-worker 锁——每次 upsertWorker 调用都是一次独立的、有限时长的原子读改写,不会在其
 * 内部触发对 harness per-worker 锁的等待。因此两把锁只可能是“外层→内层”单向嵌套,不存在
 * ABBA。同一 worker_id 的所有编排动作(spawnWorker 的注册段、handleStateChange、killWorker、
 * queryWorker 的判定+fork 段)都在同一把 per-worker 锁的临界区内完成“读台账 → 判断 → 写台账”,
 * 不允许 check-then-act 跨 await。
 *
 * 慢调用是否在锁内:
 *   - adapter.provision / adapter.spawn:在锁内。理由——这是"从无到有注册一个 worker"的
 *     唯一时机,必须与"台账已存在该 worker_id"这件事保持原子;锁内持有的时长等于一次
 *     spawn 编排,不是高频路径,换来的正确性(不会有第二个并发操作在半注册状态下观察到
 *     这个 worker)值得。
 *   - adapter.kill / adapter.fork:同样在锁内。二者都是"一次性、有限时长"的编排动作
 *     (不是像 sendInput 那样可能被连续高频调用的路径),放锁内换来"整个 kill/fork 序列
 *     原子完成,不会被并发的状态回调或另一次 kill/fork 打断"的简单正确性论证,没有值得
 *     牺牲这份简单性去换取的并发收益。
 *   - adapter.sendInput:不在 harness 的 per-worker 锁内。sendToWorker 只把"查台账 + 校验
 *     cancelled + 入信箱"这段放进锁的临界区(这段不含 slow adapter 调用),真正的投递
 *     经 `WorkerInbox.flush()` 在锁外进行——inbox 自己的内部 AsyncMutex 已经保证同一信箱
 *     的并发 flush 不会重复投递。这样长时间的 tmux/CLI 调用不会长期占住 harness 的
 *     per-worker 锁,不阻塞同一 worker 上的其它编排操作(如状态回调、kill)排队等待。
 *     deliver 内部对每个 item 都重新查一次台账取当前化身(而不是在入锁那次性 snapshot),
 *     避免投递期间化身已发生变化(如被 kill/交接)却仍拿着过期 handle 投递的问题;
 *     即便如此,`flush()` 与其它编排动作之间仍存在"投递到已失效化身"的极小窗口——
 *     这属于 §5.3 透明接续要处理的场景(Task 8 范围),Task 7 只保证 WorkerExitedError
 *     会原样从 sendInput → inbox.flush → sendToWorker 向上抛出,不做拦截或伪装。
 *
 * onStateChange 接线契约(P4 负责实际接线,P3 只提供出口):
 *   三个 adapter(builtin/claude-code/codex)都在各自构造函数的 deps 里接受一个可选的
 *   `onStateChange?: (h, state) => void`,但 HarnessDeps.adapters 要求把"已经构造好的
 *   adapter"塞进来——adapter 构造在先、harness 构造在后,没法在 adapter 构造时就拿到
 *   harness 实例的方法引用,形成先有鸡还是先有蛋的问题。
 *
 *   解法:harness 把 `handleStateChange` 做成一个公开的、构造时就绑定好 this 的箭头函数
 *   字段(调用方不需要再 .bind),接线方(P4)按以下顺序组装:
 *     1. const adapters = new Map<WorkerImplId, WorkerAdapter>()   // 先建一个空壳
 *     2. const harness = new WorkerHarness({ adapters, ... })      // 把空壳传给 harness
 *     3. 逐个构造 builtin/cc/codex adapter,构造时 onStateChange: harness.handleStateChange
 *     4. adapters.set('builtin', builtinAdapter) 等
 *   第 4 步之所以能生效:HarnessDeps.adapters 的类型是 ReadonlyMap,但底层对象仍是同一个
 *   可写 Map 引用——本实现全程只通过 `this.deps.adapters.get(impl)` 按需取值,从不在构造
 *   时把它拷贝成快照,所以第 4 步之后往里 set 的内容对 harness 立即可见。三个 adapter 的
 *   状态回调最终都指向同一个 harness 实例的 `handleStateChange`,不需要 HarnessDeps 再加字段。
 */

import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import type {
  WorkerAdapter,
  WorkerImplId,
  WorkerContractState,
  IncarnationHandle,
  IncarnationRef,
  IncarnationEndReason,
  SpawnSpec,
  OutputCursor,
  CapabilityBundle,
  Workspace,
} from '../types'
import { CapabilityNotSupportedError, WorkerExitedError } from '../errors'
import { AsyncMutex } from '../async-mutex'
import type { DialogObjectId, Incarnation, LedgerWorker, TaskStatus } from './ledger-types'
import type { LedgerStore } from './ledger-store'
import type { WorkspaceManager } from './workspace-manager'
import { WorkerInbox, type InboxItem } from './inbox'
import { WorkerEventLog, type HarnessEvent, type HarnessEventKind } from './worker-events'
import { applyStatusTransition, canTransition, isTerminalStatus, reviveTask, taskStatusFromIncarnation } from './task-status'
import { join } from 'path'

/** 交接材料里"最近输出尾部"的上限(字符数,近似 4KB,见 protocol-agent-v3 §5.3)。 */
const HANDOFF_TAIL_MAX_CHARS = 4096

/** 请求的 worker_id 在台账中不存在。 */
export class WorkerNotFoundError extends Error {
  constructor(readonly worker_id: string) {
    super(`worker not found: ${worker_id}`)
    this.name = 'WorkerNotFoundError'
  }
}

/** send_to_worker 命中已 cancelled 的 task(唯一硬拒绝场景,protocol-agent-v3 §5.5)。 */
export class TaskCancelledError extends Error {
  constructor(readonly worker_id: string) {
    super(`worker ${worker_id} task is cancelled`)
    this.name = 'TaskCancelledError'
  }
}

export interface HarnessDeps {
  /** 已 detect 过的可用实现。见文件头"onStateChange 接线契约"——底层 Map 引用可在构造后继续填充。 */
  readonly adapters: ReadonlyMap<WorkerImplId, WorkerAdapter>
  readonly defaultImpl: WorkerImplId
  readonly ledger: LedgerStore
  readonly workspaces: WorkspaceManager
  /** <dataRoot>/agent/workers */
  readonly workersDir: string
  /** ISO 时间注入,便于测试 */
  readonly now: () => string
  /** P4 manager 的唤醒入口(P3 是可插桩的出口) */
  readonly onEvent?: (e: HarnessEvent) => void
  /** provision 素材(P3 可返回空集) */
  readonly capabilityBundle?: () => Promise<CapabilityBundle>
  /**
   * handoff(§5.3 交接续办 / switchWorkerImpl)目标实现是 'builtin' 时所需的 LLM 注入
   * 默认值。`spawnWorker` 的 builtin 注入由调用方随每次调用显式传入(`SpawnWorkerParams.
   * builtin`),但 handoff 是 harness 内部触发的动作(可能由 sendToWorker 命中终态化身
   * 自动触发,调用方拿不到再传一次 builtin 注入的机会),因此在 HarnessDeps 这一级配置
   * 一份可复用的默认值。缺省时 handoffIncarnation 对 builtin 目标做 pre-flight 拒绝
   * (见该方法注释),不尝试传 `undefined` 让 `BuiltinWorkerAdapter.spawn` 自己再抛错。
   */
  readonly builtinSpawnDefaults?: () => SpawnSpec['builtin']
}

export interface SpawnWorkerParams {
  readonly dialogObjectId: DialogObjectId
  readonly title: string
  readonly prompt: string
  readonly origin: LedgerWorker['origin']
  readonly report_to: LedgerWorker['report_to']
  readonly impl?: WorkerImplId
  readonly workspace?: string
  readonly goal?: string
  /** builtin 实现所需的 LLM 注入(P4 提供) */
  readonly builtin?: SpawnSpec['builtin']
}

/**
 * reconcileOnStartup 的巡检结果(protocol-agent-v3 §12,替代 admin 的一刀切自愈)。三个
 * 桶各装 worker_id,供 P4 manager 决定唤醒哪些 monitor:
 * - revived:本轮确认化身仍活着(running/idle),台账非终态状态得到确认或对齐,需要
 *   P4 接管后续监护;
 * - failed:本轮判死(adapter 报 exited、adapter 未注册、或 adapter.state() 抛错三种
 *   "无法证明还活着"的情形之一),台账已落 failed(ended_reason='crashed');
 * - unchanged:进入本轮巡检前就已是终态(含上一轮已经判死/前一次调用已经处理过的),
 *   本轮不做任何动作。
 */
export interface ReconcileReport {
  readonly revived: string[]
  readonly failed: string[]
  readonly unchanged: string[]
}

const EMPTY_CAPABILITY_BUNDLE: CapabilityBundle = { skills: [], mcp_servers: [] }

export class WorkerHarness {
  private readonly mutexes = new Map<string, AsyncMutex>()
  private readonly inboxes = new Map<string, WorkerInbox>()
  private readonly eventLogs = new Map<string, WorkerEventLog>()

  constructor(private readonly deps: HarnessDeps) {}

  /**
   * 见文件头"onStateChange 接线契约"。箭头函数字段:构造时绑定 this,P4 可直接把它作为
   * 三个 adapter 构造 deps 里的 `onStateChange` 传入,不需要 .bind(harness)。
   * 签名对齐三个 adapter 的 `deps.onStateChange?: (h, state) => void`(同步、无返回值)——
   * 内部把实际的异步台账更新做成 fire-and-forget,任何失败只 console.error,不抛给 adapter
   * (adapter 侧本身也已经用 try/catch 包裹了对这个回调的调用,这里双重防御,理由一致:
   * 观察者的异常不能中断 adapter 自己的状态机推进)。
   */
  readonly handleStateChange = (h: IncarnationHandle, state: WorkerContractState): void => {
    this.processStateChange(h, state).catch((err) => {
      console.error(`[WorkerHarness] handleStateChange failed for ${h.worker_id}#${h.seq}:`, err)
    })
  }

  async spawnWorker(p: SpawnWorkerParams): Promise<LedgerWorker> {
    const workerId = `w-${randomUUID()}`
    const impl = p.impl ?? this.deps.defaultImpl
    const adapter = this.deps.adapters.get(impl)
    if (!adapter) {
      throw new Error(`WorkerHarness.spawnWorker: no adapter registered for impl '${impl}'`)
    }

    // workspace 解析可能失败(InvalidWorkspaceError),放在拿锁/写台账之前——失败时台账
    // 完全不会出现这条 worker,不留半成品。
    const workspace = await this.deps.workspaces.resolve(workerId, p.workspace)

    return this.withLock(workerId, async () => {
      const startedAt = this.deps.now()
      const initial: LedgerWorker = {
        worker_id: workerId,
        task: {
          id: workerId,
          title: p.title,
          status: 'queued',
          goal: p.goal,
          created_at: startedAt,
        },
        origin: p.origin,
        report_to: p.report_to,
        incarnations: [
          {
            seq: 1,
            impl,
            state: 'running',
            workspace: workspace.root,
            // adapter.spawn 尚未调用,真实 session_ref 此刻还不存在,先占位;spawn 成功后
            // 下面会用 adapter.spawn 返回的 IncarnationHandle.session_ref(protocol-agent-v3
            // §6.1,handle 自描述真值)原子补写,不依赖任何"从 handle 反查"的额外方法。
            session_ref: '',
            started_at: startedAt,
          },
        ],
        updated_at: startedAt,
      }
      await this.deps.ledger.upsertWorker(p.dialogObjectId, workerId, () => initial)

      let spawnedHandle: IncarnationHandle
      try {
        const caps = this.deps.capabilityBundle ? await this.deps.capabilityBundle() : EMPTY_CAPABILITY_BUNDLE
        await adapter.provision(workspace, caps)
        const spec: SpawnSpec = {
          worker_id: workerId,
          prompt: p.prompt,
          workspace,
          goal: p.goal,
          builtin: p.builtin,
        }
        spawnedHandle = await adapter.spawn(spec)
      } catch (err) {
        const now = this.deps.now()
        await this.deps.ledger.upsertWorker(p.dialogObjectId, workerId, (prev) => {
          if (!prev) return undefined
          // VALID_TRANSITIONS 里 queued 没有直达 failed 的边(只能到 running/cancelled)。
          // spawn 尝试确实发生过(我们已经调用了 provision/spawn),用 queued→running→failed
          // 两跳把这次失败尝试如实记录下来,而不是绕开状态机改成不符合协议语义的 cancelled。
          const running = applyStatusTransition(prev.task, 'running', { now })
          const nextTask = applyStatusTransition(running, 'failed', {
            error: err instanceof Error ? err.message : String(err),
            now,
          })
          const incarnations = patchIncarnationBySeq(prev.incarnations, impl, 1, {
            state: 'exited',
            ended_at: now,
            ended_reason: 'failed',
          })
          return { ...prev, task: nextTask, incarnations, updated_at: now }
        })
        await this.appendEvent(workerId, 1, 'exited', {
          reason: 'spawn_failed',
          message: err instanceof Error ? err.message : String(err),
        })
        throw err
      }

      const now = this.deps.now()
      // adapter.spawn 返回的 handle 自描述真实 session_ref(protocol-agent-v3 §6.1)——初始
      // 化身注册时(见上面 initial.incarnations[0])这个值还不存在,只能占位;spawn 成功后
      // 在这里补写真值,和 task 状态一起原子落盘。
      const spawned = await this.deps.ledger.upsertWorker(p.dialogObjectId, workerId, (prev) => {
        if (!prev) return undefined
        const nextTask = applyStatusTransition(prev.task, 'running', { now })
        const incarnations = patchIncarnationBySeq(prev.incarnations, impl, 1, { session_ref: spawnedHandle.session_ref })
        return { ...prev, task: nextTask, incarnations, updated_at: now }
      })
      await this.appendEvent(workerId, 1, 'spawned', { impl })
      return spawned as LedgerWorker
    })
  }

  async sendToWorker(workerId: string, text: string, opts?: { raw?: boolean }): Promise<void> {
    const inbox = this.getInbox(workerId)

    // "读台账状态 → 判断 cancelled → 入信箱"在同一临界区完成,不允许 check-then-act 跨 await。
    await this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) throw new WorkerNotFoundError(workerId)
      if (found.worker.task.status === 'cancelled') throw new TaskCancelledError(workerId)
      inbox.enqueue({ text, raw: opts?.raw ?? false, enqueued_at: this.deps.now() })
    })

    // 真正的投递不占用 harness 的 per-worker 锁(见文件头说明);inbox 自身的锁保证同一
    // 信箱的并发 flush 不重复投递。deliver 内部对每个 item 重新取一次当前化身,避免用
    // 入队时刻的过期 handle 投递。
    await inbox.flush(async (item) => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) throw new WorkerNotFoundError(workerId)
      // 主线化身,不能用"数组最后一个"——fork 之后数组末尾是侧问分支,投递必须仍然打到
      // 主线(protocol-agent-v3 §5.3:fork 不影响主线)。
      const incarnation = mainlineIncarnation(found.worker)

      // 台账已经把主线化身记为终态(如异步状态回调已经追上)——不必再尝试一次注定失败的
      // sendInput,直接进入 §5.3 透明接续。
      if (incarnation.state === 'exited') {
        await this.continueTerminalWorker(workerId, item.text, incarnation.impl as WorkerImplId, incarnation.seq, item.raw)
        return
      }

      const adapter = this.deps.adapters.get(incarnation.impl as WorkerImplId)
      if (!adapter) {
        throw new Error(`WorkerHarness.sendToWorker: no adapter registered for impl '${incarnation.impl}'`)
      }
      const handle: IncarnationHandle = {
        worker_id: workerId,
        seq: incarnation.seq,
        impl: incarnation.impl as WorkerImplId,
        session_ref: incarnation.session_ref,
      }
      try {
        await adapter.sendInput(handle, item.text, { raw: item.raw })
      } catch (err) {
        // adapter 侧权威地判定化身已终态,即使台账的异步状态回调还没追上(见
        // continueTerminalWorker 的 sourceSeq 核对注释)——同样转入透明接续,对
        // sendToWorker 的调用方完全无感(不重新抛出)。
        if (err instanceof WorkerExitedError) {
          await this.continueTerminalWorker(workerId, item.text, incarnation.impl as WorkerImplId, incarnation.seq, item.raw)
          return
        }
        throw err
      }
      await this.appendEvent(workerId, handle.seq, 'input_sent', { text_len: item.text.length })
    })
  }

  /**
   * 跨实现切换(manager 主导,protocol-agent-v3 §5.3"跨实现切换")。走与透明接续完全
   * 相同的交接路径(见 handoffIncarnation),区别只是:目标实现由调用方显式指定(不做
   * "原 impl 若仍可用则沿用"的自动选择),且源化身可能仍然存活(由 handoffIncarnation
   * 内部负责在这种情况下先 kill 再标 superseded)。
   */
  async switchWorkerImpl(workerId: string, impl: WorkerImplId, note?: string): Promise<void> {
    await this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) throw new WorkerNotFoundError(workerId)
      const { worker, dialogObjectId } = found
      // cancelled 是唯一硬拒绝(protocol-agent-v3 §5.5,与 sendToWorker/continueTerminalWorker
      // 的 cancelled 短路对齐)。若主线化身已因 killWorker 落 exited,不加这道校验会让
      // handoffIncarnation 跳过 kill 段直接 provision+spawn 新化身,reopenTaskForContinuation
      // 命中终态走 reviveTask——用户明确要求终止的任务被无声复活成 running。completed/failed
      // 允许切换(等价于"在办任务换实现"续办的合理场景,§5.3),只有 cancelled 硬拒绝。
      if (worker.task.status === 'cancelled') throw new TaskCancelledError(workerId)
      const mainline = mainlineIncarnation(worker)
      await this.handoffIncarnation(dialogObjectId, worker, mainline, impl, note ?? '')
    })
  }

  /**
   * §5.3 透明接续:sendToWorker 命中终态化身时的分流入口。全程在该 worker 的 per-worker
   * 锁临界区内完成(brief 要求:"接续全过程在该 worker 的临界区内完成,避免与并发
   * sendToWorker/kill 交错"),调用方(inbox.flush 的 deliver 回调)本身跑在锁外,这里
   * 重新拿锁。
   *
   * sourceImpl/sourceSeq 是调用方在锁外观察到的"疑似已终态"的化身 (impl, seq)(来自台账
   * incarnation.state==='exited' 的读,或 adapter.sendInput 抛出的 WorkerExitedError 所对应
   * 的化身)。拿到锁之后必须用这对 (sourceImpl, sourceSeq)(而非再次读到的台账 state 字段)
   * 判断"这次接续还要不要做"——台账的 state 字段可能滞后于 adapter 的真实状态
   * (handleStateChange 是 fire-and-forget 异步写台账,sendInput 抛错时台账不一定已经写完),
   * 但 (sourceImpl, sourceSeq) 对应的化身"已经不是当前主线"这件事(mainline.impl !== sourceImpl
   * || mainline.seq !== sourceSeq)只有在真的发生过一次接续/切换之后才可能为真——这是判断
   * "是否已被并发接续抢先完成"唯一可靠的信号,不能用可能滞后的 state 字段替代。
   *
   * 只比 seq 不比 impl 是不够的(与 processStateChange 约 942 行的 M1 收口同一原则):等锁
   * 期间若发生的是跨实现接续/切换(如 codex#1 顶替 claude-code#1,两个 adapter 实例各自
   * nextSeq 从 1 计数,撞号是常态),新旧化身可能撞上同一个 seq——只比 seq 会把这次已经
   * 发生过的接续误判成"没发生",转而把当前存活的新主线当成终态源再接续一次(对活着的化身
   * 调 adapter.resume,adapter 侧会因"未终态"拒绝并抛错,错误经 inbox.flush 穿透给
   * sendToWorker 的调用方,打破"透明接续对调用方无感"的契约)。
   *
   * raw 透传:"补送到当前主线"分支和 sendToWorker 正常路径(见上面的 adapter.sendInput 调用)
   * 必须保持同一投递语义——`raw: true` 的原始敲键消息若在补送时丢了这个标志,会被当成普通
   * 消息投递,行为对调用方不再透明。
   */
  private async continueTerminalWorker(
    workerId: string,
    text: string,
    sourceImpl: WorkerImplId,
    sourceSeq: number,
    raw: boolean
  ): Promise<void> {
    await this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) throw new WorkerNotFoundError(workerId)
      const { worker, dialogObjectId } = found

      // task 在锁外投递期间被 killWorker 打断(如 send 卡在 tmux 投递期间调 kill,这条
      // 消息在拿到这把锁之前就已经确定要走接续路径了):§5.5"唯一硬拒绝:cancelled"只
      // 约束 sendToWorker 入队前的把关(见该方法顶部),这里是入队之后才发现的迟到判定,
      // 不能再用同一处把关。cancelled 是终态,不能被下面的 reviveIncarnation/handoffIncarnation
      // 经 reopenTaskForContinuation → reviveTask 复活成 running——那样会让已经明确要求
      // 终止的 task 又"activate"出一个新化身。同时"send_to_worker 投递永不因状态失败"
      // 是调用方(inbox.flush)的既有契约,消息不能静默消失:丢弃这条并记 dead-letter 事件,
      // 不重新抛出(抛出会砸向早已异步返回的 sendToWorker 调用方,变成没人处理的 rejection)。
      if (worker.task.status === 'cancelled') {
        await this.appendEvent(workerId, sourceSeq, 'state_changed', {
          kind: 'dead_letter',
          reason: 'task_cancelled',
          text_len: text.length,
        })
        return
      }

      const mainline = mainlineIncarnation(worker)

      if (mainline.seq !== sourceSeq || mainline.impl !== sourceImpl) {
        // 并发窗口:拿锁之前,该 worker 已经被另一次并发触发的接续/切换抢先完成——主线已经
        // 前进到更新的化身(按 (impl, seq) 判定,不能只比 seq,见上面方法注释)。按普通投递
        // 语义把这条消息补送到当前(存活)主线,不重复接续,并保留原条目的 raw 标志。
        const adapter = this.deps.adapters.get(mainline.impl as WorkerImplId)
        if (!adapter) {
          throw new Error(`WorkerHarness.sendToWorker: no adapter registered for impl '${mainline.impl}'`)
        }
        const handle: IncarnationHandle = {
          worker_id: workerId,
          seq: mainline.seq,
          impl: mainline.impl as WorkerImplId,
          session_ref: mainline.session_ref,
        }
        await adapter.sendInput(handle, text, { raw })
        await this.appendEvent(workerId, handle.seq, 'input_sent', { text_len: text.length })
        return
      }

      const adapter = this.deps.adapters.get(mainline.impl as WorkerImplId)
      if (!adapter) {
        throw new Error(`WorkerHarness.sendToWorker: no adapter registered for impl '${mainline.impl}' (continuation)`)
      }

      if (adapter.capabilities().revive) {
        await this.reviveIncarnation(dialogObjectId, worker, mainline, adapter, text)
      } else {
        // "原 impl 若仍可用则沿用,否则 defaultImpl"(brief)。三个既有实现目前都是
        // revive:true,这条分支走不到真实 adapter;为将来的不可复活实现(如 legacy)保留。
        const targetImpl = this.deps.adapters.has(mainline.impl as WorkerImplId)
          ? (mainline.impl as WorkerImplId)
          : this.deps.defaultImpl
        await this.handoffIncarnation(dialogObjectId, worker, mainline, targetImpl, text)
      }
    })
  }

  /** capabilities().revive===true 分支:adapter.resume 拉起新化身,session 满保真接续。 */
  private async reviveIncarnation(
    dialogObjectId: DialogObjectId,
    worker: LedgerWorker,
    mainline: Incarnation,
    adapter: WorkerAdapter,
    text: string,
  ): Promise<void> {
    const prevRef: IncarnationRef = { worker_id: worker.worker_id, seq: mainline.seq, session_ref: mainline.session_ref }
    // resume 直接把 text 作为 wakeInput 传入——接续就是这次输入的投递方式,不需要在
    // resume 成功之后再补一次 adapter.sendInput。
    const newHandle = await adapter.resume(prevRef, text)

    const now = this.deps.now()
    await this.deps.ledger.upsertWorker(dialogObjectId, worker.worker_id, (prev) => {
      if (!prev) return undefined
      const newIncarnation: Incarnation = {
        seq: newHandle.seq,
        impl: newHandle.impl,
        state: 'running',
        workspace: mainline.workspace,
        session_ref: newHandle.session_ref,
        started_at: now,
        // forked_from 不填——resume 产出的新化身入主线链(protocol-agent-v3 §5.3)。
      }
      // 源化身(mainline)台账态若仍非 exited——sendToWorker 经 WorkerExitedError 走到这里时,
      // 台账的异步状态回调很可能还没追上 adapter 的真实状态(见 continueTerminalWorker 顶部
      // 注释)——必须在 revive 前把它收尾,否则新化身入链后主线就换成了新 seq,后续迟到的
      // processStateChange 会因 mainline.seq !== h.seq 被直接丢弃,旧化身永久卡在非终态、
      // 无终态记录。对齐 handoffIncarnation 对同一竞态的处理(§5.3):这里同样只在源化身
      // 台账态非 exited 时才回填,不覆盖已经真实记录过的终态。WorkerExitedError 不携带
      // end reason,拿不到 adapter 给出的精确失败原因时用 'completed' 记录——语境是"已经
      // 在准备接续续命",不是被 kill,'completed' 是这里能给出的最贴切近似值。
      const incarnations =
        mainline.state !== 'exited'
          ? patchIncarnationBySeq(prev.incarnations, mainline.impl, mainline.seq, {
              state: 'exited',
              ended_at: now,
              ended_reason: 'completed',
            })
          : prev.incarnations
      const nextTask = reopenTaskForContinuation(prev.task, now)
      return { ...prev, task: nextTask, incarnations: [...incarnations, newIncarnation], updated_at: now }
    })
    await this.appendEvent(worker.worker_id, newHandle.seq, 'resumed', { from_seq: mainline.seq })
  }

  /**
   * capabilities().revive===false 分支(交接续办),以及 switchWorkerImpl 复用的公共路径。
   * 顺序对齐 protocol-agent-v3 §5.3"跨实现切换":旧化身写交接文档收尾 → (若仍存活)
   * kill 标 superseded → 同 workspace provision+spawn 新实现 → 化身链 +1。
   */
  private async handoffIncarnation(
    dialogObjectId: DialogObjectId,
    worker: LedgerWorker,
    source: Incarnation,
    targetImpl: WorkerImplId,
    input: string,
  ): Promise<void> {
    const sourceAdapter = this.deps.adapters.get(source.impl as WorkerImplId)
    const sourceHandle: IncarnationHandle = {
      worker_id: worker.worker_id,
      seq: source.seq,
      impl: source.impl as WorkerImplId,
      session_ref: source.session_ref,
    }

    // 0. Pre-flight(裁决 B 修复):目标 adapter 必须存在;若目标是 'builtin',调用方必须
    // 通过 HarnessDeps.builtinSpawnDefaults 提供了 LLM 注入,否则 step 3 的 newAdapter.spawn
    // 必然因 spec.builtin 缺失而抛错(BuiltinWorkerAdapter.spawn 本就 fail-loud)。修复前这
    // 个抛错发生在 step 3——此时旧化身已经在 step 2 被 kill 并标 superseded,worker 卡进
    // "旧的没了、新的没建成"的死结,且下次投递会重复整套 handoff(重复追加 HANDOFF.md)。
    // 把这两项检查提到最前面、在写 HANDOFF.md 和 kill 旧化身之前做,失败时旧化身与
    // HANDOFF.md 都不动,保持可重试。
    const newAdapter = this.deps.adapters.get(targetImpl)
    if (!newAdapter) {
      throw new Error(`WorkerHarness.handoffIncarnation: no adapter registered for impl '${targetImpl}' (handoff target)`)
    }
    let builtinInjection: SpawnSpec['builtin']
    if (targetImpl === 'builtin') {
      builtinInjection = this.deps.builtinSpawnDefaults?.()
      if (!builtinInjection) {
        throw new Error(
          `WorkerHarness.handoffIncarnation: handoff target impl is 'builtin' but no builtinSpawnDefaults ` +
            `configured on HarnessDeps; refusing before touching the source incarnation (worker ${worker.worker_id}#${source.seq})`
        )
      }
    }

    // 1. 组装交接材料(task.title/goal + 最近输出尾部,上限 4KB + 上一化身 outcome)并写
    // workspace 下的 HANDOFF.md(已存在则追加带时间戳的新段,不覆盖)。
    let tail = ''
    if (sourceAdapter) {
      try {
        const { chunk } = await sourceAdapter.readOutput(sourceHandle, { offset: 0 })
        tail = chunk.length > HANDOFF_TAIL_MAX_CHARS ? chunk.slice(chunk.length - HANDOFF_TAIL_MAX_CHARS) : chunk
      } catch (err) {
        // 读取交接材料失败不阻断交接本身——没有尾部信息的 HANDOFF.md 好过完全不交接。
        console.error(`[WorkerHarness] handoff: readOutput failed for ${worker.worker_id}#${source.seq}, tail omitted:`, err)
      }
    }
    const outcome = worker.task.outcome ?? source.ended_reason ?? 'unknown'
    const handoffTs = this.deps.now()
    await appendHandoffFile(source.workspace, {
      ts: handoffTs,
      title: worker.task.title,
      goal: worker.task.goal,
      outcome,
      tail,
      input,
    })
    await this.appendEvent(worker.worker_id, source.seq, 'handoff_started', { target_impl: targetImpl })

    // 2. 旧化身若仍非终态(如 switchWorkerImpl 打在一个仍存活的化身上,或台账的终态回调
    // 还没追上 adapter 的真实状态),先 kill 再标 superseded——不覆盖已经真实记录过的
    // ended_reason(那种情况下旧化身已经是它自己的终局,不是被这次交接顶替的)。
    if (source.state !== 'exited') {
      if (sourceAdapter) {
        await sourceAdapter.kill(sourceHandle)
      }
      const killedAt = this.deps.now()
      await this.deps.ledger.upsertWorker(dialogObjectId, worker.worker_id, (prev) => {
        if (!prev) return undefined
        const incarnations = patchIncarnationBySeq(prev.incarnations, source.impl, source.seq, {
          state: 'exited',
          ended_at: killedAt,
          ended_reason: 'superseded',
        })
        return { ...prev, incarnations, updated_at: killedAt }
      })
      await this.appendEvent(worker.worker_id, source.seq, 'superseded')
    }

    // 3. 同 workspace provision + spawn 新实现,开工输入 = 原任务 + 交接引用 + 本次输入。
    // newAdapter / builtinInjection 已在上面的 pre-flight 里取好,这里不用再判一次。
    const workspace: Workspace = { root: source.workspace }
    const caps = this.deps.capabilityBundle ? await this.deps.capabilityBundle() : EMPTY_CAPABILITY_BUNDLE
    await newAdapter.provision(workspace, caps)
    const prompt = buildHandoffPrompt(worker.task, input)
    const newHandle = await newAdapter.spawn({
      worker_id: worker.worker_id,
      prompt,
      workspace,
      goal: worker.task.goal,
      builtin: builtinInjection,
    })

    // 4. 化身链 +1,task 重新回到 running(见 reopenTaskForContinuation 注释)。
    const now = this.deps.now()
    await this.deps.ledger.upsertWorker(dialogObjectId, worker.worker_id, (prev) => {
      if (!prev) return undefined
      const newIncarnation: Incarnation = {
        seq: newHandle.seq,
        impl: targetImpl,
        state: 'running',
        workspace: source.workspace,
        session_ref: newHandle.session_ref,
        started_at: now,
      }
      const nextTask = reopenTaskForContinuation(prev.task, now)
      return { ...prev, task: nextTask, incarnations: [...prev.incarnations, newIncarnation], updated_at: now }
    })
    // 与 reviveIncarnation 收尾时发 'resumed' 事件对称——交接产出的新化身同样是一次"开工",
    // 缺了这个事件会让事件流看不到 handoff 之后新主线是何时、以何种 impl 建起来的。
    await this.appendEvent(worker.worker_id, newHandle.seq, 'spawned', { impl: targetImpl, from_seq: source.seq })
  }

  async readWorkerOutput(
    workerId: string,
    cursor: OutputCursor
  ): Promise<{ chunk: string; nextCursor: OutputCursor }> {
    const found = await this.deps.ledger.findWorker(workerId)
    if (!found) throw new WorkerNotFoundError(workerId)
    // 主线化身,同 sendToWorker——读输出默认读主线,不被 fork 出的侧问分支顶替。
    const incarnation = mainlineIncarnation(found.worker)
    const adapter = this.deps.adapters.get(incarnation.impl as WorkerImplId)
    if (!adapter) {
      throw new Error(`WorkerHarness.readWorkerOutput: no adapter registered for impl '${incarnation.impl}'`)
    }
    const handle: IncarnationHandle = {
      worker_id: workerId,
      seq: incarnation.seq,
      impl: incarnation.impl as WorkerImplId,
      session_ref: incarnation.session_ref,
    }
    return adapter.readOutput(handle, cursor)
  }

  async listWorkers(dialogObjectId: DialogObjectId): Promise<LedgerWorker[]> {
    return this.deps.ledger.listWorkers(dialogObjectId)
  }

  /**
   * 崩溃恢复对账(protocol-agent-v3 §12,替代 admin 的一刀切自愈)。agent 进程重启后调用
   * 一次:巡检台账里所有非终态 worker 的主线化身,凭 adapter.state() 判定它到底是"进程
   * 没了、化身也没了"(判死)还是"化身独立于 agent 进程,可能还活着"(如 tmux worker),
   * 而不是像旧 admin 那样把所有非终态任务一律判死。
   *
   * 与 BuiltinWorkerAdapter.scanOrphans(P1)的关系——互补而非替代:scanOrphans 是
   * builtin 自己的 adapter 内部动作,修的是它自己 dataDir 下 meta-<seq>.json 这份"进程内
   * 存活状态由本进程独占计算"的私有真相(builtin 的执行就是本进程内的 runEngine burst,
   * 进程重启即等价于 burst 消失,重启前仍是 running 的 meta 就是孤儿,必须先纠正);本方法
   * 修的是台账(跨三种 impl 的公共真相源)。两者都要跑,顺序上 scanOrphans 必须先于本方法:
   * 本方法调用 adapter.state() 时,builtin 的 state() 在无常驻内存 instance 时直接回落读
   * meta-<seq>.json(见 BuiltinWorkerAdapter.state 实现),若 scanOrphans 没有先跑,孤儿
   * meta 仍标着 'running',本方法会把它误判进"revived"分支。scanOrphans 的调用时机是
   * "本进程任何 adapter 实例开始活动前"(其自身文档要求),比 harness 构造还早——harness
   * 拿不到、也不该拿到某个具体 adapter(如 builtin)的私有 dataDir(HarnessDeps 只有
   * workersDir,是 harness 自己的 events/output 目录,与各 adapter 的私有 dataDir 是两个
   * 目录),因此不在本方法内部调用 scanOrphans,调用顺序由 P4/bootstrap 层保证(先
   * `BuiltinWorkerAdapter.scanOrphans(dataDir)`,adapter 塞进 `adapters` Map 之后,再调
   * `harness.reconcileOnStartup()`)。claude-code/codex 目前没有等价的孤儿扫描——它们的
   * `state()` 在无常驻 runtime 时同样回落读 meta 文件而不做真实 tmux 存活探测,这是现有
   * adapter 实现的已知限制(§6.3 描述的"低频巡扫 tmux pane"兜底另有周期机制,不在本方法
   * 范围内),不是本方法引入的新问题。
   *
   * 判定规则(逐 worker 独立判定,整轮不持有任何全局锁——只在每个 worker 自己的
   * per-worker 临界区内完成"读台账→判adapter.state()→提交"):
   * - 台账已是终态:跳过,归 unchanged(幂等:重复调用不会把上一轮已经判死的 worker 再判一次)。
   * - 主线化身的 impl 没有对应 adapter 注册(实现被禁用/未安装):判死。
   * - `adapter.state(handle)` 抛错:视为不可判定,判死;错误信息记进事件 detail,不让
   *   这次异常中断整轮对账(逐 worker try/catch,配合 Promise.allSettled 兜底任何未预料
   *   到的同步/异步异常,一个 worker 出问题不影响其它 worker 被处理)。
   * - 返回 `exited`:台账仍非终态却已经不在跑了,判死,ended_reason='crashed'。
   * - 返回 `running`/`idle`:台账保持(不判死)——tmux worker 独立于 agent 进程,重启后
   *   往往仍活着;按这次实际观察到的 contractState 用 taskStatusFromIncarnation 把
   *   task.status 对齐到真实值(可能一步都不用走,也可能需要更新化身的 state 字段),
   *   发 state_changed 事件(detail.source='reconcile',与被动回调路径区分)通知 P4 manager
   *   接管这个 worker 的后续监护;归 revived。
   */
  async reconcileOnStartup(): Promise<ReconcileReport> {
    const revived: string[] = []
    const failed: string[] = []
    const unchanged: string[] = []

    const all = await this.deps.ledger.listAllWorkers()
    const targets = all.filter(({ worker }) => !isTerminalStatus(worker.task.status))
    // 报告的 unchanged 桶按 brief 定义包含"终态"(不只是"无需动作但仍被判定过的非终态
    // worker")——已终态的 worker 在这里直接归档,不进 Promise.allSettled 那批,不占用
    // per-worker 锁、不调用 adapter.state()(即使重复调用 reconcileOnStartup,已判死过的
    // worker 从第二次起也是在这一步就被截住,不会再走到 reconcileOneWorker)。
    unchanged.push(...all.filter(({ worker }) => isTerminalStatus(worker.task.status)).map(({ worker }) => worker.worker_id))

    const settled = await Promise.allSettled(
      targets.map(({ dialogObjectId, worker }) => this.reconcileOneWorker(dialogObjectId, worker.worker_id))
    )

    settled.forEach((result, i) => {
      const workerId = targets[i].worker.worker_id
      if (result.status === 'fulfilled') {
        ;(result.value === 'revived' ? revived : result.value === 'failed' ? failed : unchanged).push(workerId)
      } else {
        // reconcileOneWorker 内部已经把 adapter.state() 的异常兜底成 'failed' 分类并落盘,
        // 这里兜的是更意外的情形(如 ledger 写盘失败)——记日志,报告里仍归 failed,不让
        // 一个 worker 的意外异常掐断整轮 Promise.allSettled 之外的收尾逻辑。
        console.error(`[WorkerHarness] reconcileOnStartup: unexpected error reconciling ${workerId}:`, result.reason)
        failed.push(workerId)
      }
    })

    return { revived, failed, unchanged }
  }

  /** reconcileOnStartup 单个 worker 的判定+提交,整体在该 worker 的 per-worker 锁临界区内完成。 */
  private async reconcileOneWorker(
    dialogObjectId: DialogObjectId,
    workerId: string
  ): Promise<'revived' | 'failed' | 'unchanged'> {
    return this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) return 'unchanged' // 理论不该发生(枚举时刚读到过),防御性处理
      const { worker } = found
      // 幂等短路:进锁后重读仍可能已是终态(上一轮已判死,或本轮内已被并发触发的其它
      // harness 动作收尾)——不重复判定。
      if (isTerminalStatus(worker.task.status)) return 'unchanged'

      const mainline = mainlineIncarnation(worker)
      const adapter = this.deps.adapters.get(mainline.impl as WorkerImplId)
      if (!adapter) {
        await this.markCrashed(dialogObjectId, worker, mainline, `no adapter registered for impl '${mainline.impl}'`)
        return 'failed'
      }

      const handle: IncarnationHandle = {
        worker_id: worker.worker_id,
        seq: mainline.seq,
        impl: mainline.impl as WorkerImplId,
        session_ref: mainline.session_ref,
      }

      let observed: WorkerContractState
      try {
        observed = await adapter.state(handle)
      } catch (err) {
        await this.markCrashed(
          dialogObjectId,
          worker,
          mainline,
          `adapter.state() threw: ${err instanceof Error ? err.message : String(err)}`
        )
        return 'failed'
      }

      if (observed === 'exited') {
        await this.markCrashed(dialogObjectId, worker, mainline, 'adapter reports incarnation exited while ledger was non-terminal')
        return 'failed'
      }

      await this.realignAliveIncarnation(dialogObjectId, worker, mainline, observed)
      return 'revived'
    })
  }

  /**
   * reconcileOnStartup 判死分支:落 failed(ended_reason='crashed')+ exited 事件。三种判死
   * 场景(adapter 报 exited / adapter 未注册 / adapter.state() 抛错)共用同一段收尾——三者
   * 语义上都是"至此已经没有任何证据证明这个非终态 worker 还活着"。
   */
  private async markCrashed(
    dialogObjectId: DialogObjectId,
    worker: LedgerWorker,
    mainline: Incarnation,
    detailReason: string
  ): Promise<void> {
    const now = this.deps.now()
    await this.deps.ledger.upsertWorker(dialogObjectId, worker.worker_id, (prev) => {
      if (!prev) return undefined
      const nextTask = transitionTaskTo(prev.task, 'failed', { error: detailReason, now })
      const incarnations = patchIncarnationBySeq(prev.incarnations, mainline.impl, mainline.seq, {
        state: 'exited',
        ended_at: now,
        ended_reason: 'crashed',
      })
      return { ...prev, task: nextTask, incarnations, updated_at: now }
    })
    await this.appendEvent(worker.worker_id, mainline.seq, 'exited', { reason: 'crashed', message: detailReason })
  }

  /**
   * reconcileOnStartup 存活分支:台账不判死,只按这次实际观察到的 contractState 对齐
   * incarnation.state 与 task.status(taskStatusFromIncarnation 同一套映射,与
   * processStateChange 的被动回调路径共用规则)。若观察结果与台账现状完全一致(既没有
   * 化身 state 差异也没有 task 状态差异),不做任何写入、不发事件——避免每次巡检都产生
   * 噪声写盘/事件。
   */
  private async realignAliveIncarnation(
    dialogObjectId: DialogObjectId,
    worker: LedgerWorker,
    mainline: Incarnation,
    observed: WorkerContractState
  ): Promise<void> {
    // idle 是否算"等输入"本属 manager 判断职责(protocol-agent-v3 §5.2),这里与
    // processStateChange 保持同一条保守默认:P4 接线后可按需要覆盖。
    const waitingInput = observed === 'idle' ? true : undefined
    const nextStatus = taskStatusFromIncarnation(observed, undefined, waitingInput)
    const stateChanged = mainline.state !== observed
    const statusChanged = worker.task.status !== nextStatus
    if (!stateChanged && !statusChanged) return

    const now = this.deps.now()
    await this.deps.ledger.upsertWorker(dialogObjectId, worker.worker_id, (prev) => {
      if (!prev) return undefined
      const nextTask = statusChanged ? transitionTaskTo(prev.task, nextStatus, { now }) : prev.task
      const incarnations = stateChanged
        ? patchIncarnationBySeq(prev.incarnations, mainline.impl, mainline.seq, { state: observed })
        : prev.incarnations
      return { ...prev, task: nextTask, incarnations, updated_at: now }
    })
    await this.appendEvent(worker.worker_id, mainline.seq, 'state_changed', { to: observed, source: 'reconcile' })
  }

  async killWorker(workerId: string, reason?: string): Promise<void> {
    await this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) throw new WorkerNotFoundError(workerId)
      const { worker, dialogObjectId } = found

      // 幂等:已是终态(含此前已经 kill 过)直接返回,不重复调 adapter.kill、不重复写台账/事件。
      if (isTerminalStatus(worker.task.status)) return

      // 主线化身——kill 必须打在主线上,不能被 fork 出的侧问分支顶替(protocol-agent-v3 §5.3)。
      const incarnation = mainlineIncarnation(worker)
      const implId = incarnation.impl as WorkerImplId
      const adapter = this.deps.adapters.get(implId)
      if (adapter) {
        const handle: IncarnationHandle = {
          worker_id: workerId,
          seq: incarnation.seq,
          impl: implId,
          session_ref: incarnation.session_ref,
        }
        await adapter.kill(handle)
      }

      const now = this.deps.now()
      await this.deps.ledger.upsertWorker(dialogObjectId, workerId, (prev) => {
        if (!prev) return undefined
        const nextTask = applyStatusTransition(prev.task, 'cancelled', { now })
        // 按 (impl, seq) 精确定位主线化身条目,不假设它是数组最后一个(fork 之后数组末尾是
        // fork 化身;跨实例撞号时同 seq 可能有多条记录,见 patchIncarnationBySeq 注释)。
        const incarnations = patchIncarnationBySeq(prev.incarnations, incarnation.impl, incarnation.seq, {
          state: 'exited',
          ended_at: now,
          ended_reason: 'killed',
        })
        return { ...prev, task: nextTask, incarnations, updated_at: now }
      })
      await this.appendEvent(workerId, incarnation.seq, 'killed', reason ? { reason } : undefined)

      // 清空信箱残留:此刻队列里的条目是 kill 之前已入队、deliver 还没轮到的消息(kill 之后
      // 的 sendToWorker 会命中上面已落定的 cancelled 直接拒绝,不会再有新条目挤进来——入队
      // 段与这里同在这把 per-worker 锁的临界区内,互斥)。不清空的话,这些条目会在之后被
      // inbox.flush 摸到、读到台账已 exited,落进 continueTerminalWorker 的接续分支(即使
      // 加了上面的 cancelled 短路,也是"先接住再丢弃"而不是干脆不投递)。drain() 不等锁,
      // 不会因为同一信箱另有 flush 卡在 deliver 而卡住这里;逐条记 dead-letter 事件,保证
      // "消息不静默消失"的调用方契约。
      const drained = this.getInbox(workerId).drain()
      for (const item of drained) {
        await this.appendEvent(workerId, incarnation.seq, 'state_changed', {
          kind: 'dead_letter',
          reason: 'killed',
          text_len: item.text.length,
        })
      }
    })
  }

  async queryWorker(workerId: string, question: string): Promise<{ forkSeq: number }> {
    return this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) throw new WorkerNotFoundError(workerId)
      const { worker, dialogObjectId } = found
      // 侧问永远从当前主线化身分叉,不是"数组最后一个"——否则连续两次 query_worker 会让
      // 第二次 fork 挂在第一次 fork 的分支下面,而不是都从主线分叉(protocol-agent-v3 §5.3)。
      const incarnation = mainlineIncarnation(worker)
      const implId = incarnation.impl as WorkerImplId
      const adapter = this.deps.adapters.get(implId)
      if (!adapter) {
        throw new Error(`WorkerHarness.queryWorker: no adapter registered for impl '${implId}'`)
      }
      if (!adapter.capabilities().fork) {
        throw new CapabilityNotSupportedError(implId, 'fork')
      }

      const ref: IncarnationRef = { worker_id: workerId, seq: incarnation.seq, session_ref: incarnation.session_ref }
      const forkHandle = await adapter.fork(ref, question)

      const now = this.deps.now()
      await this.deps.ledger.upsertWorker(dialogObjectId, workerId, (prev) => {
        if (!prev) return undefined
        // fork 是一次性侧问,不影响主线 task.status(protocol-agent-v3 §5.3:"不影响主线")。
        // forked_from 标记它不在主线化身链上(§3);session_ref 取 forkHandle 自己的引用,
        // 不是父化身的(§6.1 IncarnationHandle 自描述,handle.session_ref 就是 fork 化身真值)。
        const forkIncarnation: Incarnation = {
          seq: forkHandle.seq,
          impl: implId,
          state: 'running',
          workspace: incarnation.workspace,
          session_ref: forkHandle.session_ref,
          started_at: now,
          forked_from: incarnation.seq,
        }
        return { ...prev, incarnations: [...prev.incarnations, forkIncarnation], updated_at: now }
      })
      // HarnessEventKind 没有专门的"fork/query"档位(worker-events.ts 是既定契约,Task 7
      // 不新增枚举值),用 state_changed 承载,detail 里标明是 fork 产生的新化身。
      await this.appendEvent(workerId, forkHandle.seq, 'state_changed', { kind: 'fork', from_seq: incarnation.seq })
      return { forkSeq: forkHandle.seq }
    })
  }

  // ---- 内部 ----

  private async processStateChange(h: IncarnationHandle, state: WorkerContractState): Promise<void> {
    await this.withLock(h.worker_id, async () => {
      const found = await this.deps.ledger.findWorker(h.worker_id)
      if (!found) return // 未知 worker,理论不该发生;防御性丢弃,不抛给 adapter 的回调
      const { worker, dialogObjectId } = found

      const target = findIncarnation(worker, h.impl, h.seq)
      if (!target) return // 未知化身(理论不该发生),防御性丢弃

      // WorkerAdapter.onStateChange 只携带 (handle, state) 三态,没有 endReason——kill 触发的
      // exited 已经由 killWorker 自己直接落定台账(见下面两处终态短路),能走到这里、还没被
      // 判定为终态的 exited,只可能是"化身自然结束"(非 kill),endReason 取 completed。
      // 真正的崩溃(crashed)辨别依赖主动巡检(protocol-agent-v3 §6.3/§12),不在这条被动
      // 回调路径的能力范围内,由 Task 9 的 reconcileOnStartup 补正。
      const endReason: IncarnationEndReason | undefined = state === 'exited' ? 'completed' : undefined
      const now = this.deps.now()

      if (target.forked_from !== undefined) {
        // fork 化身(一次性侧问分支)自己的生命周期只更新它自己的化身条目,不影响主线
        // task.status——protocol-agent-v3 §5.3"fork 不影响主线"在这里的具体体现:即使这是
        // fork 化身的终态回调,也绝不能像"当前化身"那样去推进 task 状态机。
        if (target.state === 'exited') return // 已终态,迟到回调忽略
        await this.deps.ledger.upsertWorker(dialogObjectId, h.worker_id, (prev) => {
          if (!prev) return undefined
          // session_ref 现读现取(h.session_ref,不是构造 handle 时闭包住的旧值)——
          // builtin 的 session_ref 随每轮 burst 前进,adapter 侧在每次 onStateChange 回调
          // 时都重新取 instance.tip 填入 handle(见 builtin/adapter.ts 的 transitionState/
          // transitionExited);台账因此在每次状态回调时顺带刷新到"最近一次完成的状态
          // 转换点"。cc/codex 的 session_ref 本就稳定,这里是等价 no-op。
          const incarnations = patchIncarnationBySeq(
            prev.incarnations,
            h.impl,
            h.seq,
            state === 'exited'
              ? { state, ended_at: now, ended_reason: endReason, session_ref: h.session_ref }
              : { state, session_ref: h.session_ref }
          )
          return { ...prev, incarnations, updated_at: now }
        })
        await this.appendEvent(h.worker_id, h.seq, 'state_changed', { to: state })
        return
      }

      // 主线分支:只有"当前主线化身"的回调才驱动 task.status——fork 之后数组末尾是侧问
      // 分支,不能再用"数组最后一个"判定"是不是当前化身"。
      const mainline = mainlineIncarnation(worker)
      // 按 (impl, seq) 判定,不能只比 seq——跨实现切换(switchWorkerImpl/handoff)后,新
      // 实现的 adapter 是全新实例,其 seq 计数从头开始,与被 kill 的旧实现化身撞号是常态
      // (如 codex#1 顶替 claude-code#1)。只比 seq 会把旧实现迟到的 exited 回调误判成
      // "当前主线化身的回调",错误地把新主线整个判死。这是 findIncarnation/patchIncarnationBySeq
      // 已经统一的 (impl,seq) 判定原则在这里的收口。
      if (mainline.seq !== h.seq || mainline.impl !== h.impl) return // 非当前主线化身的迟到回调,忽略
      if (target.state === 'exited') return // 目标化身已终态,迟到回调忽略(与上面 fork 分支的短路对称,避免对已终态化身再次施加迁移)
      if (isTerminalStatus(worker.task.status)) return // 已是终态(如已被 killWorker 落定),回调迟到,忽略

      // idle 是否算"等输入"本属 manager 判断职责(protocol-agent-v3 §5.2);P3 尚无 manager,
      // 保守默认 idle 一律记 waiting_input,P4 接线后可按需要覆盖这条映射。
      const waitingInput = state === 'idle' ? true : undefined
      const nextStatus: TaskStatus = taskStatusFromIncarnation(state, endReason, waitingInput)

      await this.deps.ledger.upsertWorker(dialogObjectId, h.worker_id, (prev) => {
        if (!prev) return undefined
        // 同状态重复回调(如 adapter 偶发对同一次转变重复通知)不是合法状态机边(VALID_TRANSITIONS
        // 没有自环),会被 applyStatusTransition 当非法转换抛错——那样 upsertWorker 直接
        // reject,连下面的 appendEvent 都不会跑,回调被 handleStateChange 的外层 catch 静默
        // 吞掉,事件跟着一起丢。提前短路成 no-op,让调用方仍能走到 appendEvent 记录这次回调。
        if (nextStatus === prev.task.status) return prev
        const nextTask = applyStatusTransition(prev.task, nextStatus, { now })
        // session_ref 现读现取,同上面 fork 分支的注释。
        const incarnations = patchIncarnationBySeq(
          prev.incarnations,
          h.impl,
          h.seq,
          state === 'exited'
            ? { state, ended_at: now, ended_reason: endReason, session_ref: h.session_ref }
            : { state, session_ref: h.session_ref }
        )
        return { ...prev, task: nextTask, incarnations, updated_at: now }
      })
      await this.appendEvent(h.worker_id, h.seq, 'state_changed', { to: state })
    })
  }

  private withLock<T>(workerId: string, fn: () => Promise<T>): Promise<T> {
    let mutex = this.mutexes.get(workerId)
    if (!mutex) {
      mutex = new AsyncMutex()
      this.mutexes.set(workerId, mutex)
    }
    return mutex.run(fn)
  }

  private getInbox(workerId: string): WorkerInbox {
    let inbox = this.inboxes.get(workerId)
    if (!inbox) {
      inbox = new WorkerInbox(workerId)
      this.inboxes.set(workerId, inbox)
    }
    return inbox
  }

  private getEventLog(workerId: string): WorkerEventLog {
    let log = this.eventLogs.get(workerId)
    if (!log) {
      log = new WorkerEventLog(join(this.deps.workersDir, workerId))
      this.eventLogs.set(workerId, log)
    }
    return log
  }

  private async appendEvent(
    workerId: string,
    seq: number,
    kind: HarnessEventKind,
    detail?: Record<string, unknown>
  ): Promise<void> {
    const ts = this.deps.now()
    const event: HarnessEvent = detail !== undefined ? { ts, kind, worker_id: workerId, seq, detail } : { ts, kind, worker_id: workerId, seq }
    await this.getEventLog(workerId).append(event)
    this.deps.onEvent?.(event)
  }
}

/**
 * 主线化身链上的最新化身:排除所有 forked_from 有值的一次性侧问分支(protocol-agent-v3
 * §3、§5.3)。fork 出的化身会被 push 进同一个 incarnations 数组,若继续取"数组最后一个"
 * 当作当前化身,fork 之后 send_to_worker / kill_worker / read_worker_output / 化身自然结束
 * 的状态回调全部会被错误地转发到侧问分支——主线因此失联(实测复现:spawn → queryWorker →
 * sendToWorker/killWorker 都 target 到 fork 的 seq,而不是主线 seq)。
 *
 * 前提:worker.incarnations 非空(每个已注册的 worker 至少有 spawn 落下的 seq=1 主线化身)。
 */
function mainlineIncarnation(worker: LedgerWorker): Incarnation {
  const mainline = worker.incarnations.filter((inc) => inc.forked_from === undefined)
  return mainline[mainline.length - 1]
}

/**
 * 按 (impl, seq) 精确定位一个活跃的化身条目(取最后一条匹配,代表当前活跃化身)。
 *
 * 只按 seq 匹配是不够的(protocol-agent-v3 §6.1"已知限制"):IncarnationHandle.seq 由各
 * adapter 自行分配,只保证同一个 adapter 实例内递增不重复,不保证跨 adapter 实例(跨实现
 * 切换、进程重启后新建的 adapter 实例)全局唯一——(impl, seq) 相同的记录可能因此在同一
 * 台账里出现不止一条(旧的已归档,新的是当前活跃化身)。化身按时间顺序追加进数组,所以
 * (impl, seq) 相同的多条记录里,数组下标最大的那条才是当前活跃的。
 *
 * processStateChange 的读路径和 patchIncarnationBySeq 的写路径都必须使用同一原则,
 * 确保定位的是同一条活跃化身,避免读写分离导致的语义错位。
 */
function findIncarnation(worker: LedgerWorker, impl: WorkerImplId, seq: number): Incarnation | undefined {
  let lastMatch: Incarnation | undefined
  for (const inc of worker.incarnations) {
    if (inc.impl === impl && inc.seq === seq) lastMatch = inc
  }
  return lastMatch
}

/**
 * 按 (impl, seq) 精确定位并 patch 一个化身条目,不假设它是数组的最后一个——fork 之后数组
 * 末尾是 fork 化身,继续用"改最后一个"的旧写法会把主线的落定动作(如 kill 后的 exited)
 * 误写进 fork 条目,或反过来让 fork 化身自己的状态变化误写进主线条目,两个方向都是错的。
 *
 * 只按 seq 匹配是不够的(protocol-agent-v3 §6.1"已知限制"):`IncarnationHandle.seq` 由各
 * adapter 自行分配,只保证同一个 adapter 实例内递增不重复,不保证跨 adapter 实例(跨实现
 * 切换、进程重启后新建的 adapter 实例)全局唯一——`(impl, seq)` 相同的记录可能因此在同一
 * 台账里出现不止一条(旧的已归档,新的是当前活跃化身)。化身按时间顺序追加进数组,所以
 * `(impl, seq)` 相同的多条记录里,数组下标最大的那条才是当前活跃的;用 `.map` 对所有匹配
 * 项一视同仁地改写,会连带篡改已经归档的旧记录。这里只精确定位并改写最后一条匹配记录,
 * 更早的同键记录原样保留。
 */
function patchIncarnationBySeq(
  incarnations: Incarnation[],
  impl: Incarnation['impl'],
  seq: number,
  patch: Partial<Incarnation>
): Incarnation[] {
  let lastMatchIndex = -1
  for (let i = 0; i < incarnations.length; i++) {
    if (incarnations[i].impl === impl && incarnations[i].seq === seq) lastMatchIndex = i
  }
  if (lastMatchIndex === -1) return incarnations
  return incarnations.map((inc, i) => (i === lastMatchIndex ? { ...inc, ...patch } : inc))
}

/**
 * §5.3 化身接续:把 task 的状态与派生字段重新置回 running,供接续产出的新化身使用。
 *
 * 终态化身之上继续开一个新化身是显式的"延续"动作,不是 task-status.ts 描述的线性状态机
 * 内的一次迁移——VALID_TRANSITIONS 里终态(completed/failed/cancelled)无出边是"同一次
 * 尝试内不允许原地复活"的不变量。task 已经终态时,不由 harness 自行拼接字段绕开状态机,
 * 而是走 task-status.ts 官方暴露的受控出口 `reviveTask`(protocol-agent-v3 §5.2"接续
 * 例外")——状态机模块自己承载这条例外,harness 只是调用方。
 *
 * task 尚未终态时分两种情况:已经是 running 的(如台账的终态回调还没追上 adapter 的真实
 * 状态,接续发生前 task.status 本就还是 running)不需要任何迁移,直接原样返回(此时按
 * task-status.ts 维护的不变量,completed_at/error 本就已经是未设置状态,无需重置);
 * 其余非终态(queued/waiting_input)走 applyStatusTransition 的正常校验路径迁到 running。
 */
function reopenTaskForContinuation(task: LedgerWorker['task'], now: string): LedgerWorker['task'] {
  if (task.status === 'running') return task
  if (isTerminalStatus(task.status)) return reviveTask(task, { now })
  return applyStatusTransition(task, 'running', { now })
}

/**
 * reconcileOnStartup 专用:把 task 状态迁移到目标状态,目标不可从当前状态一步直达时先跳一步
 * running。VALID_TRANSITIONS 里 `queued` 只有到 `running`/`cancelled` 的边,没有到
 * `waiting_input`/`failed` 的直达边——但巡检可能在极窄的竞态窗口里撞见"task.status 仍是
 * queued、主线化身却已经真实 running/idle/判死"的台账(spawnWorker 落初始记录与落
 * spawn 成功后的第二次提交之间若进程崩溃,见 harness.ts 顶部锁纪律注释),此时直接
 * applyStatusTransition 会抛 InvalidTaskTransitionError。这里镜像 spawnWorker 失败路径
 * 已经用过的"queued→running→失败/目标状态"两跳写法,不新增状态机边、不绕开 canTransition
 * 校验(仍然全程只用 applyStatusTransition,只是必要时多套一层)。
 */
function transitionTaskTo(
  task: LedgerWorker['task'],
  to: TaskStatus,
  opts: { error?: string; now: string }
): LedgerWorker['task'] {
  if (canTransition(task.status, to)) {
    return applyStatusTransition(task, to, opts)
  }
  const hopped = applyStatusTransition(task, 'running', { now: opts.now })
  return applyStatusTransition(hopped, to, opts)
}

/** 交接续办产出的新化身 prompt:原任务描述 + 交接引用(指向 HANDOFF.md)+ 本次输入。 */
function buildHandoffPrompt(task: LedgerWorker['task'], input: string): string {
  const goalLine = task.goal ? `\n目标:${task.goal}` : ''
  const inputBlock = input ? `\n\n${input}` : ''
  return `${task.title}${goalLine}\n\n(交接续办:详见 workspace 下的 HANDOFF.md,记录了前一化身的执行现场与交接说明)${inputBlock}`
}

interface HandoffSection {
  readonly ts: string
  readonly title: string
  readonly goal?: string
  readonly outcome: string
  readonly tail: string
  readonly input: string
}

function renderHandoffSection(s: HandoffSection): string {
  const lines = [
    `## Handoff ${s.ts}`,
    '',
    `Task: ${s.title}`,
    ...(s.goal ? [`Goal: ${s.goal}`] : []),
    `Previous outcome: ${s.outcome}`,
    ...(s.input ? [`This round input: ${s.input}`] : []),
    '',
    '### Recent output (tail)',
    '```',
    s.tail || '(no output)',
    '```',
  ]
  return lines.join('\n') + '\n'
}

/** 写 workspace 下的 HANDOFF.md;已存在则追加带时间戳的新段,不覆盖(protocol-agent-v3 §5.3)。 */
async function appendHandoffFile(workspaceRoot: string, section: HandoffSection): Promise<void> {
  const filePath = join(workspaceRoot, 'HANDOFF.md')
  const block = renderHandoffSection(section)
  let existing = ''
  try {
    existing = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const next = existing ? `${existing.replace(/\n+$/, '')}\n\n${block}` : block
  await fs.mkdir(workspaceRoot, { recursive: true })
  await fs.writeFile(filePath, next, 'utf-8')
}

// re-export for callers that only import from harness.ts
export type { HarnessEvent, HarnessEventKind } from './worker-events'
export type { InboxItem } from './inbox'
