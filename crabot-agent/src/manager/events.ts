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
 * ## new_status / old_status 从哪来
 *
 * **`new_status` 由事件自带**(`HarnessEvent.task_status`,harness 在 `appendEvent` 时把
 * `upsertWorker` 落账后的 `task.status` 钉在事件上)。
 *
 * 这里曾经是**现读台账**(`ledger.findWorker(worker_id).worker.task.status`),被独立评审的
 * PoC 证伪:`LedgerStore.findWorker` 不进互斥锁、读的永远是最新已提交文件,只要这次读发生
 * 在**下一次落账之后**,那个中间状态就被整条吞掉——PoC 里 `completed` 这个订阅方最关心的
 * 终态**一次都没发出去**(spawned/exited/resumed 三条事件,exited 的读晚于 §5.3 透明接续把
 * task 拉回 running 的那次落账)。把值钉在事件上,读取时刻与落账时刻就此解耦。
 *
 * **台账读没有全部消失**,但读的只剩 `task_id` 与 `dialog_object_id` 两个字段——它们在一个
 * worker 的整个生命周期内不变(`task.id` 建账即等于 `worker_id`,`dialog_object_id` 是台账的
 * 聚合键),读晚了也读不出别的值,不存在"被下一次落账折叠"的问题。会随时间变化的只有
 * `status`,而它已经不再现读。
 *
 * **`old_status`**:`HarnessEvent` 只描述"这次迁移之后",协议没有别的出口,所以仍由本模块
 * 维护一份 `worker_id → 上一次已见 task.status`。
 *
 * 这份 map 的三条边界(选择的代价,调用方需知情):
 * - **首次观测的兜底是 `'queued'`**(§5.2:task 建账即 queued)。worker 在本进程内 spawn 的
 *   主路径因此是准的(spawnWorker 建 queued → 迁 running → 落 `spawned` 事件,翻译出
 *   queued→running);但**agent 重启后**遗留的在途 worker,其第一条事件的 `old_status` 会退化
 *   成 `'queued'`(`new_status` 始终准确)。
 * - **两次迁移之间没有事件时,中间态被折叠**。已知的一例是 spawn 失败路径:台账上是
 *   queued→running→failed 两跳,但只落一条 `exited` 事件(带 `task_status:'failed'`),翻译出
 *   queued→failed。端点正确,中间的 running 丢失。这是"没有事件"造成的折叠,与上面修掉的
 *   "有事件但读晚了"是两回事,后者已经不存在。
 *   由此推论并明确记一句:**对外事件的 `old→new` 只保证端点正确,不保证是状态机合法边**
 *   (`VALID_TRANSITIONS['queued']` 只有 `['running','cancelled']`,不含 failed)。任何对
 *   订阅到的迁移做合法性校验的消费者都会被这条打挂,P7 接线时必须知情。
 * - **终态不清理条目**:§5.3 的透明接续(`reviveTask`)会把终态 task 拉回 running,清理掉就
 *   会让那次迁移的 old_status 退化成 'queued'。代价是每个进程生命周期内见过的 worker 各留
 *   一条 `worker_id → 状态字符串`(~百字节);worker 是重量级实体(一个 CLI/tmux 会话 + 一个
 *   workspace 目录),单进程内的实际数量在百量级,不值得为此引入淘汰策略再换回错误的
 *   old_status。
 *
 * ## 事件没带 task_status 怎么办 —— 退回现读台账
 *
 * `task_status` 是 additive 可选字段:化身级事件点不带它(它们本来就没有迁移),老事件日志
 * 文件里的事件也不带。缺席时**退回修复前的行为**(现读台账取状态),而不是当成"无迁移"跳过。
 * 理由:跳过会把"字段缺席"变成一条**新的静默丢事件路径**——只要 harness 将来新增一个迁移点
 * 忘了带这个参数,或者某处分类判断错了,那条迁移就永远发不出去且无声无息;而退回现读台账
 * 最差也只是退化成修复前那套(端点仍会被后续事件纠正),严格不劣于现状。
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
 * 每个 worker 一条 promise 链——`new_status` 改由事件自带之后这条链**仍然是必需的**,原因有二:
 * 1. 台账读还在(取 `task_id` / `dialog_object_id`,见文件头),`onEvent` 却是同步回调:不串行
 *    的话两条紧邻事件的读会交叉完成,发布顺序被打乱,订阅方最后落到的会是**较早**那个状态
 *    (对 admin 就是"任务永远显示 running");
 * 2. `lastKnownStatus` 的读与写跨了那个 await,不串行就会出现两条事件读到同一个 old_status、
 *    互相覆盖,倒着报一条根本不存在的迁移。
 * 链跑空即从 map 里摘掉,不留残条目。
 */
export function makeTaskStatusEventBridge(deps: {
  ledger: Pick<LedgerStore, 'findWorker'>
  publish: AgentEventPublisher
}): (event: HarnessEvent) => void {
  const lastKnownStatus = new Map<string, TaskStatus>()
  const chains = new Map<string, Promise<void>>()

  const translate = async (event: HarnessEvent): Promise<void> => {
    const workerId = event.worker_id
    // 只为拿两个**不随时间变化**的字段:task_id 与 dialog_object_id(见文件头)。状态不从这里取。
    const found = await deps.ledger.findWorker(workerId)
    // worker 不在台账(如 query_failed 的 worker_not_found 分支):没有 task,无从谈状态迁移。
    if (!found) return

    // 事件自带的落账后状态优先;缺席时退回现读台账(见文件头"事件没带 task_status 怎么办")。
    const newStatus = event.task_status ?? found.worker.task.status
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
      .then(() => translate(event))
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
