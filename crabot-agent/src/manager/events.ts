/**
 * agent 对外事件 —— protocol-agent-v3.md §9.2(P5 Task 2)。
 *
 * v3 把 task 的真相源从 admin 迁到 agent,`admin.task_status_changed` 随之由
 * `agent.task_status_changed` 取代(发布方从 admin 变为 agent)。agent 侧此前**没有任何
 * 事件发布口**(全仓零 `publishEvent` 调用),本文件是第一个。
 *
 * ## 两件事,两个函数
 *
 * 1. `makeAgentEventPublisher`:信封 + 投递。形状照抄 admin 的 `publishAdminEvent`
 *    (`crabot-admin/src/index.ts:6151`):`{id: generateId(), type, source: moduleId,
 *    payload, timestamp}` → `rpcClient.publishEvent(event, moduleId)`,fire-and-forget
 *    且 `.catch()` 记日志。**唯一有意的偏离**:多包一层 try/catch,连 `publishEvent` 的
 *    同步抛错(如 rpcClient 尚未就绪)也吃掉——admin 的版本只 catch 了 rejection,而本模块
 *    的调用点在 harness 的状态机推进路径上(`appendEvent` 内),任何反噬都会污染 worker 主
 *    流程,不能只防一半。
 * 2. `makeTaskStatusEventBridge`:harness 事件 → task 状态事件的**翻译与去重**。
 *
 * ## 为什么必须去重(不能一对一映射)
 *
 * `HarnessEvent` 是**化身级**的(`{ts, kind, worker_id, seq, detail?}`,见 worker-events.ts):
 * 一次 `send_to_worker` 会落 `input_sent`,一次 fork 会落 `state_changed{kind:'fork'}`,
 * 投递到已取消 task 会落 `state_changed{kind:'dead_letter'}`——这些**都不改 task.status**。
 * 而 `agent.task_status_changed` 是**任务级**的,只在 task 真的迁移时才该发。
 *
 * ## old_status 从哪来
 *
 * `HarnessEvent` 不带 from/to(`state_changed` 的 detail 只有 `{to: <化身契约状态>}`),协议
 * 也没有别的出口,所以只能由本模块维护一份 `worker_id → 上一次已见 task.status`。新状态则
 * 现读台账:harness 的所有状态迁移都是"先 `upsertWorker` 落账、后 `appendEvent`"(见
 * harness.ts 的 spawnWorker / processStateChange / killWorker),事件到达时台账已是迁移后的
 * 真值。
 *
 * 这份 map 的三条边界(选择的代价,调用方需知情):
 * - **首次观测的兜底是 `'queued'`**(§5.2:task 建账即 queued)。worker 在本进程内 spawn 的
 *   主路径因此是准的(spawnWorker 建 queued → 迁 running → 落 `spawned` 事件,翻译出
 *   queued→running);但**agent 重启后**遗留的在途 worker,其第一条事件的 `old_status` 会退化
 *   成 `'queued'`(`new_status` 始终准确,取自台账)。
 * - **两次迁移之间没有事件时,中间态被折叠**。已知的一例是 spawn 失败路径:台账上是
 *   queued→running→failed 两跳,但只落一条 `exited` 事件,翻译出 queued→failed。端点正确,
 *   中间的 running 丢失。
 * - **终态不清理条目**:§5.3 的透明接续(`reviveTask`)会把终态 task 拉回 running,清理掉就
 *   会让那次迁移的 old_status 退化成 'queued'。代价是每个进程生命周期内见过的 worker 各留
 *   一条 `worker_id → 状态字符串`(~百字节);worker 是重量级实体(一个 CLI/tmux 会话 + 一个
 *   workspace 目录),单进程内的实际数量在百量级,不值得为此引入淘汰策略再换回错误的
 *   old_status。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §9.2、§5.2、§5.3
 * @see crabot-admin/src/index.ts 的 `publishAdminEvent`(信封与 fire-and-forget 的既有范式)
 */

import { generateId, type Event, type ModuleId, type RpcClient } from 'crabot-shared'

import type { LedgerStore } from '../workers/harness/ledger-store.js'
import type { DialogObjectId, TaskStatus } from '../workers/harness/ledger-types.js'
import type { HarnessEvent } from '../workers/harness/harness.js'
import type { TaskId } from '../types.js'

/** protocol-agent-v3 §9.2 `agent.task_status_changed` 载荷(字段逐字对齐,不增不减)。 */
export interface AgentTaskStatusChangedPayload {
  worker_id: string
  task_id: TaskId
  old_status: TaskStatus
  new_status: TaskStatus
  dialog_object_id: DialogObjectId
}

/** 对外事件发布口。同步返回(fire-and-forget),失败只记日志。 */
export type AgentEventPublisher = (
  type: 'agent.task_status_changed',
  payload: AgentTaskStatusChangedPayload,
) => void

/**
 * 信封 + 投递,照 admin `publishAdminEvent` 的做法(见文件头)。
 *
 * `rpcClient` 用 `Pick<RpcClient, 'publishEvent'>` 而不是整个 `RpcClient`:本模块只需要这一个
 * 方法,窄依赖同时让测试不必伪造整个 RpcClient。
 */
export function makeAgentEventPublisher(deps: {
  rpcClient: Pick<RpcClient, 'publishEvent'>
  moduleId: ModuleId
  now: () => string
}): AgentEventPublisher {
  return (type, payload) => {
    const event: Event = {
      id: generateId(),
      type,
      source: deps.moduleId,
      payload,
      timestamp: deps.now(),
    }
    // 事件发布绝不能反噬调用方(见文件头):rejection 与同步抛错都在这里终结。
    try {
      deps.rpcClient.publishEvent(event, deps.moduleId).catch((err: unknown) => {
        console.error(`[agent-events] 发布事件失败 ${type}:`, err)
      })
    } catch (err) {
      console.error(`[agent-events] 发布事件失败 ${type}:`, err)
    }
  }
}

/** 台账里 task 的建账初始状态(§5.2),即"没见过这个 worker"时 old_status 的兜底值。 */
const INITIAL_TASK_STATUS: TaskStatus = 'queued'

/**
 * harness 事件 → `agent.task_status_changed`。返回的函数直接挂在 `HarnessDeps.onEvent` 上
 * (由 bootstrap 接线),同步返回、内部 fire-and-forget。
 *
 * 每个 worker 一条 promise 链:`onEvent` 是同步回调,而翻译要异步读台账,不串行的话两条紧邻
 * 事件的台账读会交叉完成,先到的事件可能后发布,`old_status`/`new_status` 直接错位(甚至倒
 * 着报一条不存在的迁移)。链跑空即从 map 里摘掉,不留残条目。
 */
export function makeTaskStatusEventBridge(deps: {
  ledger: Pick<LedgerStore, 'findWorker'>
  publish: AgentEventPublisher
}): (event: HarnessEvent) => void {
  const lastKnownStatus = new Map<string, TaskStatus>()
  const chains = new Map<string, Promise<void>>()

  const translate = async (workerId: string): Promise<void> => {
    const found = await deps.ledger.findWorker(workerId)
    // worker 不在台账(如 query_failed 的 worker_not_found 分支):没有 task,无从谈状态迁移。
    if (!found) return

    const newStatus = found.worker.task.status
    const oldStatus = lastKnownStatus.get(workerId) ?? INITIAL_TASK_STATUS
    // 去重的落点:化身级事件与同状态重复回调都停在这里,一条对外事件都不发。
    if (oldStatus === newStatus) return

    lastKnownStatus.set(workerId, newStatus)
    deps.publish('agent.task_status_changed', {
      worker_id: workerId,
      task_id: found.worker.task.id,
      old_status: oldStatus,
      new_status: newStatus,
      dialog_object_id: found.dialogObjectId,
    })
  }

  return (event: HarnessEvent) => {
    const workerId = event.worker_id
    const prev = chains.get(workerId) ?? Promise.resolve()
    const next = prev
      .then(() => translate(workerId))
      .catch((err: unknown) => {
        console.error(
          `[agent-events] task 状态事件翻译失败 (worker=${workerId}, kind=${event.kind}):`,
          err,
        )
      })
      .finally(() => {
        if (chains.get(workerId) === next) chains.delete(workerId)
      })
    chains.set(workerId, next)
  }
}
