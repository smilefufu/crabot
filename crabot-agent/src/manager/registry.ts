/**
 * ManagerRegistry —— manager 实例台账与唤醒路由(protocol-agent-v3.md §4.4)。
 *
 * `ManagerLoop`(Task 7)按 `ManagerKey` 逻辑长驻:session 状态全在盘上
 * (`ManagerSessionStore`),但 loop 实例本身要有人持有、有人按 key 复用、有人在合适的时机
 * 回收。`ManagerRegistry` 就是这个持有者,同时是三类唤醒来源(人类消息 / worker 事件 /
 * scheduled 触发)到具体 `ManagerLoop` 实例的路由入口——调用方不需要自己判断"这次事件该
 * 唤醒哪个 manager",只管调 `routeXxx`。
 *
 * ## 惰性 + 常驻 + 可回收
 *
 * `getOrCreate` 惰性建实例、同 key 幂等;`evictIdle` 按内存压力回收空闲实例——回收只影响
 * 内存,不碰盘上状态(`ManagerSessionStore`),所以回收后同一 key 再次 `wakeUp` 会经
 * `getOrCreate` 重新建一个新的 `ManagerLoop` 实例,而它构造时 `ManagerLoop.runEpisodeBody`
 * 顶部的 `store.load(key)` 会原样读回历史——对调用方完全透明。
 *
 * ## 系统线程(§4.4)
 *
 * `SYSTEM_TASKS_MANAGER_KEY` 是协议保留的"系统任务"线程:未指定目标 session 的 scheduled
 * 触发、以及台账查不到监护 session 的 worker 事件,都落在这个固定 key 上。`getOrCreate`
 * 内部按 `key === SYSTEM_TASKS_MANAGER_KEY` 判定 `ManagerLoopDeps.isSystemThread`,不需要
 * 调用方在路由时额外传一个"是不是系统线程"的标志——key 本身就是唯一判据。
 *
 * ## `onAsyncError` 出口(Task 4 遗留接线点)
 *
 * `worker-tools.ts` 的 `query_worker` 是字面 fire-and-forget:发起 `adapter.fork` 后不
 * `await`,失败时唯一的"通知调用方"手段是 `WorkerToolsDeps.onAsyncError` 这个可选回调
 * (Task 4 只留出口、不接线)。`getOrCreate` 为每个 key 构造一个绑定该 key 的
 * `OnAsyncError` 实现并通过 `deps.toolFace(key, isSystemThread, onAsyncError)` 交给调用方
 * ——调用方(真正装配 `buildManagerToolFace`/`buildWorkerTools` 的那一层,不在本任务范围)
 * 负责把它接进 `WorkerToolsDeps.onAsyncError`。本文件只负责这个回调"接住错误之后做什么":
 * 按"当前这个 manager 是否正有 episode 在跑"(`activeEpisodes`)二选一——
 *   - 有 episode 在跑:`enqueueDuringEpisode`,错误作为 mid-episode 注入随下一轮 turn 一起
 *     喂给 LLM,不用等这个 episode 结束再唤醒一次;
 *   - 没有 episode 在跑(该 episode 已经结束/loop 甚至被 evictIdle 回收过):`getOrCreate`
 *     惰性重建后直接 `wakeUp`,开一个新 episode 处理这条错误。
 * 错误信息包成 `WakeEvent`:复用既有 `worker_event` kind(不新增 `WakeEvent` 变体,因为
 * `loop.ts` 是 Task 7 的既有产物,本任务的"零现网影响"约束不允许改动),用既有的
 * `HarnessEventKind.query_failed`(worker-events.ts 已经为 `query_worker` 失败预留了这个
 * kind)承载,`seq` 填 `0` 作 sentinel——真实 seq 从 1 起分配(与 harness.ts `queryWorker`
 * 对"worker 不存在"场景同一套 sentinel 约定),`0` 标记"这不对应任何真实化身事件,只是一次
 * 唤醒信号"(真正的失败留痕已经由 `harness.queryWorker` 自己 `appendEvent('query_failed')`
 * 完成,这里不重复写事件流,只借用同一个 kind 语义)。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §4.4
 */

import { ManagerLoop, type WakeEvent, type EpisodeResult, type ManagerLoopDeps } from './loop.js'
import type { ManagerSessionStore } from './session-store.js'
import type { CompactionPolicy } from './compaction.js'
import type { ManagerKey } from './types.js'
import type { EngineMessage, LLMAdapter, ToolDefinition } from '../engine/index.js'
import type { WorkerHarness } from '../workers/harness/harness'
import type { LedgerStore } from '../workers/harness/ledger-store'
import type { DialogObjectId } from '../workers/harness/ledger-types'
import type { HarnessEvent, HarnessEventKind } from '../workers/harness/worker-events'
import type { ChannelMessage } from '../types'

/** §4.4 保留线程:未配置目标 session 的 scheduled 触发 / 台账查不到监护 session 的 worker 事件落此。 */
export const SYSTEM_TASKS_MANAGER_KEY = 'admin-web::system-tasks' as ManagerKey

/** `query_worker` 异步失败(Task 4 `WorkerToolsDeps.onAsyncError`)的信息形状,逐字对齐该接口。 */
export interface AsyncToolErrorInfo {
  readonly tool: string
  readonly worker_id: string
  readonly error: string
}

export type OnAsyncError = (info: AsyncToolErrorInfo) => void

export interface ManagerRegistryDeps {
  readonly store: ManagerSessionStore
  readonly policy: CompactionPolicy
  readonly estimateTokens: (msgs: ReadonlyArray<EngineMessage>) => number
  readonly harness: WorkerHarness
  /** routeWorkerEvent 的 origin 归属查找用(harness 未公开 findWorker,直接持有台账存储)。 */
  readonly ledger: LedgerStore
  readonly adapter: LLMAdapter
  readonly model: string
  readonly maxTurns?: number
  readonly contextWindowTokens?: number
  readonly now: () => Date
  /**
   * `ManagerKey` → 台账渲染用的 `DialogObjectId`(`ManagerLoopDeps.dialogObjectId`)。
   * 两者粒度不同(manager 按 channel::session,worker 台账按 friend 跨 channel 聚合/单群),
   * 这层映射依赖 friend 解析等本模块无法自行完成的信息,由调用方按 protocol §3 解析好注入。
   */
  readonly dialogObjectIdFor: (key: ManagerKey) => DialogObjectId
  /**
   * 工具面工厂:调用方据 key/isSystemThread 装配 `buildManagerToolFace` 的完整依赖并返回
   * 工具面数组;`onAsyncError` 由本 registry 按 key 绑定好传入,调用方负责把它接进
   * `WorkerToolsDeps.onAsyncError`(见文件头说明)。
   */
  readonly toolFace: (key: ManagerKey, isSystemThread: boolean, onAsyncError: OnAsyncError) => ReadonlyArray<ToolDefinition>
  /** system prompt 动态段素材(档案/待处理通知),每轮重算,由调用方决定要不要按最新状态重建。 */
  readonly promptInputs: (key: ManagerKey) => { readonly dialogProfile?: string; readonly pendingNotes?: ReadonlyArray<string> }
}

export class ManagerRegistry {
  private readonly loops = new Map<ManagerKey, ManagerLoop>()
  /**
   * 每个 key 当前"在途" episode 的引用计数——决定 evictIdle 是否可回收、onAsyncError 走
   * wakeUp 还是 enqueueDuringEpisode。**必须是计数,不能是布尔/Set 的有无标记**:同一 key 可能
   * 有多个并发唤醒同时在途(人类消息与该 session 监护的 worker 事件几乎必然撞上)——第二个
   * 已经进了 `runWake`,可能仍在 `ManagerLoop` 内部 mutex 排队或执行,第一个却先 resolve。
   * 若只用 Set,第一个 resolve 时 `finally` 会直接 `delete(key)`,把仍在途的第二个也一并
   * 抹掉("有 episode 在跑"的标记被错误清空)——`evictIdle` 会在这个窗口误判该 key 空闲、
   * 回收 `this.loops` 的引用;之后任何新事件经 `getOrCreate` 会在仍有旧 episode 运行的情况
   * 下新建一个持有独立 mutex 的 `ManagerLoop`,与旧实例并发读写同一份 `ManagerSessionStore`
   * 记录,造成 split-brain 覆盖/丢写。引用计数(进入 runWake +1、episode 结束 -1、归零才删)
   * 能正确表达"还有几个在途",避免这个问题。
   */
  private readonly activeEpisodes = new Map<ManagerKey, number>()
  /** 每个 key 最近一次"活跃"的时间戳(创建时 / 每次 episode 结束时刷新),evictIdle 的判据。 */
  private readonly lastActiveAtMs = new Map<ManagerKey, number>()

  constructor(private readonly deps: ManagerRegistryDeps) {}

  /** 惰性拉起:key 无实例则建;同 key 幂等返回同一实例。实例常驻内存,session 状态在盘上。 */
  getOrCreate(key: ManagerKey): ManagerLoop {
    const existing = this.loops.get(key)
    if (existing) return existing

    const isSystemThread = key === SYSTEM_TASKS_MANAGER_KEY
    const onAsyncError: OnAsyncError = (info) => this.handleAsyncToolError(key, info)

    const loopDeps: ManagerLoopDeps = {
      key,
      isSystemThread,
      dialogObjectId: this.deps.dialogObjectIdFor(key),
      store: this.deps.store,
      policy: this.deps.policy,
      estimateTokens: this.deps.estimateTokens,
      adapter: this.deps.adapter,
      model: this.deps.model,
      maxTurns: this.deps.maxTurns,
      contextWindowTokens: this.deps.contextWindowTokens,
      toolFace: () => this.deps.toolFace(key, isSystemThread, onAsyncError),
      promptInputs: () => this.deps.promptInputs(key),
      harness: this.deps.harness,
      now: this.deps.now,
      onEpisodeEnd: () => this.lastActiveAtMs.set(key, this.deps.now().getTime()),
    }

    const loop = new ManagerLoop(loopDeps)
    this.loops.set(key, loop)
    this.lastActiveAtMs.set(key, this.deps.now().getTime())
    return loop
  }

  /** 人类消息 → 对应 session 的 manager。 */
  async routeHumanMessages(
    channelId: string,
    sessionId: string,
    messages: ReadonlyArray<ChannelMessage>
  ): Promise<EpisodeResult> {
    const key = `${channelId}::${sessionId}` as ManagerKey
    return this.runWake(key, { kind: 'human_messages', messages })
  }

  /**
   * harness 事件 → 该 worker 的监护 manager(台账 `origin.spawned_by_session`);查不到则落
   * 系统线程。注意:这里解出的 manager 与该 worker 台账所属的 `DialogObjectId` 可以是两个
   * 不同的对话对象(同一 friend 跨 channel 共享台账)——这是设计意图,不是需要修正的不一致。
   */
  async routeWorkerEvent(event: HarnessEvent): Promise<EpisodeResult | undefined> {
    const found = await this.deps.ledger.findWorker(event.worker_id)
    const key = found?.worker.origin.spawned_by_session ?? SYSTEM_TASKS_MANAGER_KEY
    return this.runWake(key, { kind: 'worker_event', event })
  }

  /** scheduled 触发(§4.4):有 target_session → 该 manager;无 → 系统线程 manager。 */
  async routeSchedule(p: {
    scheduleId: string
    title: string
    description: string
    targetSession?: { channel_id: string; session_id: string }
  }): Promise<EpisodeResult> {
    const key = p.targetSession
      ? (`${p.targetSession.channel_id}::${p.targetSession.session_id}` as ManagerKey)
      : SYSTEM_TASKS_MANAGER_KEY
    return this.runWake(key, { kind: 'schedule', scheduleId: p.scheduleId, title: p.title, description: p.description })
  }

  /**
   * 空闲实例回收:回收 `nowMs - 最后活跃时间 > idleMs` 且当前无 episode 在跑的实例。
   * 只删内存里的 `ManagerLoop` 引用,不碰 `ManagerSessionStore` 的盘上状态——回收后同一 key
   * 再次唤醒会经 `getOrCreate` 重建实例并从盘上恢复历史(见文件头说明)。返回本次回收数量。
   */
  evictIdle(idleMs: number, nowMs: number): number {
    let evicted = 0
    for (const key of this.loops.keys()) {
      if (this.isEpisodeActive(key)) continue
      const lastActive = this.lastActiveAtMs.get(key) ?? 0
      if (nowMs - lastActive <= idleMs) continue
      this.loops.delete(key)
      this.lastActiveAtMs.delete(key)
      evicted++
    }
    return evicted
  }

  /** query_worker 异步失败 → 唤醒信号(见文件头"onAsyncError 出口"一节)。 */
  private handleAsyncToolError(key: ManagerKey, info: AsyncToolErrorInfo): void {
    const event = buildAsyncErrorWakeEvent(info, this.deps.now())
    if (this.isEpisodeActive(key)) {
      this.getOrCreate(key).enqueueDuringEpisode(event)
      return
    }
    void this.runWake(key, event).catch((err) => {
      console.error(`[ManagerRegistry] onAsyncError 唤醒 manager '${key}' 失败:`, err)
    })
  }

  /** 该 key 是否还有至少一个在途 episode(引用计数 > 0)。 */
  private isEpisodeActive(key: ManagerKey): boolean {
    return (this.activeEpisodes.get(key) ?? 0) > 0
  }

  /** getOrCreate + 维护 activeEpisodes 引用计数的公共路径,所有 routeXxx / onAsyncError 都走这里。 */
  private async runWake(key: ManagerKey, event: WakeEvent): Promise<EpisodeResult> {
    const loop = this.getOrCreate(key)
    this.activeEpisodes.set(key, (this.activeEpisodes.get(key) ?? 0) + 1)
    try {
      return await loop.wakeUp(event)
    } finally {
      const remaining = (this.activeEpisodes.get(key) ?? 1) - 1
      if (remaining <= 0) this.activeEpisodes.delete(key)
      else this.activeEpisodes.set(key, remaining)
    }
  }
}

/** query_worker 异步失败 → 借用既有 `worker_event`/`query_failed` kind 包装成 WakeEvent(见文件头)。 */
function buildAsyncErrorWakeEvent(info: AsyncToolErrorInfo, now: Date): WakeEvent {
  const kind: HarnessEventKind = 'query_failed'
  const event: HarnessEvent = {
    ts: now.toISOString(),
    kind,
    worker_id: info.worker_id,
    seq: 0, // sentinel:不对应任何真实化身事件,只是一次唤醒信号(见文件头)
    detail: { tool: info.tool, error: info.error, synthetic: true },
  }
  return { kind: 'worker_event', event }
}
