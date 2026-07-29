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
import { applyStatusTransition, isTerminalStatus, reviveTask, taskStatusFromIncarnation } from './task-status'
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
        await this.continueTerminalWorker(workerId, item.text, incarnation.seq)
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
          await this.continueTerminalWorker(workerId, item.text, incarnation.seq)
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
   * sourceSeq 是调用方在锁外观察到的"疑似已终态"的化身 seq(来自台账 incarnation.state
   * ==='exited' 的读,或 adapter.sendInput 抛出的 WorkerExitedError 所对应的化身)。拿到
   * 锁之后必须用 sourceSeq(而非再次读到的台账 state 字段)判断"这次接续还要不要做"——
   * 台账的 state 字段可能滞后于 adapter 的真实状态(handleStateChange 是 fire-and-forget
   * 异步写台账,sendInput 抛错时台账不一定已经写完),但 sourceSeq 对应的化身"已经不是
   * 当前主线"这件事(mainline.seq !== sourceSeq)只有在真的发生过一次接续之后才可能为真
   * ——这是判断"是否已被并发接续抢先完成"唯一可靠的信号,不能用可能滞后的 state 字段替代。
   */
  private async continueTerminalWorker(workerId: string, text: string, sourceSeq: number): Promise<void> {
    await this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) throw new WorkerNotFoundError(workerId)
      const { worker, dialogObjectId } = found
      const mainline = mainlineIncarnation(worker)

      if (mainline.seq !== sourceSeq) {
        // 并发窗口:拿锁之前,该 worker 已经被另一次并发触发的接续抢先完成——主线已经
        // 前进到更新的化身。按普通投递语义把这条消息补送到当前(存活)主线,不重复接续。
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
        await adapter.sendInput(handle, text)
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

      const target = worker.incarnations.find((inc) => inc.seq === h.seq)
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
      if (mainline.seq !== h.seq) return // 非当前主线化身的迟到回调,忽略
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
