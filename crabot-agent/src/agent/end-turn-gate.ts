/**
 * createAsyncAuditEndTurnGate — engine endTurnGate 闭包工厂（异步派 audit 路径）。
 *
 * 与旧的 runGoalAudit-同步阻塞 版本的区别：
 *  - 旧：闭包 await runGoalAudit → 10-30s 阻塞 main loop
 *  - 新：闭包 spawnAuditSubagent → 立即返回 audit_id，注入 [audit_pending] marker → 续 turn 不真 end_turn
 *
 * 闭包行为（spec 2026-06-07-goal-audit-async-buffered-info-design.md §4.3 + Revision 2026-06-09 第 2 段 §4.13）：
 *  1. goalSetCache=false（worker 尚未 set_task_goal）→ null（透明放行）
 *  2. buffer 空：
 *     2a. everSentMessage=true → null（讨论型场景：之前 flush 过 info，这次没事干 end_turn）
 *     2b. !everSentMessage + retries < 3 → 塞 GOAL_MODE_NO_DELIVERY_PROMPT、retries++
 *     2c. !everSentMessage + retries ≥ 3 → 直接 failed，不派空 buffer audit
 *  3. buffer 非空 → 走"派 audit"路径
 *  4. "派 audit"共享路径：拿 goal（admin get_task RPC）；缺失/RPC 挂 → null（fail-open）
 *  5. spawnAuditSubagent → 设 taskState.activeAuditId → 返回 [audit_pending] marker
 *  6. spawn 抛错 → null（fail-open，console.warn 记录）
 *
 * runGoalAudit 保留不动，未来如需 sync fallback / 兼容旧路径仍可用。
 */

import { spawnAuditSubagent, type SpawnAuditSubagentDeps } from './audit-spawn.js'
import { shouldArmGoalGate, type GoalAuditTaskGoal } from './goal-audit.js'
import type { RpcClient } from 'crabot-shared'
import type { WorkerTaskState } from '../types.js'
import type { EndTurnGateResult } from '../engine/types.js'

/**
 * "buffer 空 + has goal + !everSentMessage" 路径前 3 次注入的提示文案。
 * 第 4 次起直接失败，不派空 buffer audit。
 */
export const GOAL_MODE_NO_DELIVERY_PROMPT =
  '你设了 task goal 但从未通过 send_message 交付任何内容给人类。\n'
  + 'audit 在这种情况下默认判 incomplete。请选一条路径继续：\n'
  + '  ① 继续工作（调你需要的工具完成 acceptance_criteria）\n'
  + '  ② 如果遇到实际阻塞或需要人类决策，调 send_message(intent=\'ask_human\') 提问\n'
  + '不要再次直接 end_turn——它会再次注入本提示，反复 3 次后系统会终止本任务并标记为未交付。'

/**
 * 同一路径但 everBufferedMessage=true 时的变体：worker 调过 send_message，消息进过
 * buffer 但被 audit fail 丢弃、从未送达人类。此时再说"你从未交付任何内容"对 worker
 * 是误导——它会以为消息没发出去而原样重发同一条，触发"重发→再审→再 fail"死循环
 * （trace e1c9663f 成因之三）。spec 2026-06-10-audit-anchor-human-request §3.5
 */
export const GOAL_MODE_INTERCEPTED_DELIVERY_PROMPT =
  '你之前的交付未通过自检，消息没有送达人类（被系统拦下丢弃了）。\n'
  + '不要原样重发同一条消息——内容不变，自检结果也不会变。请选一条路径继续：\n'
  + '  ① 对照上一轮自检报告指出的差距，把缺口补完后重新 send_message 交付，系统会自动再审\n'
  + '  ② 客观做不到 / 你认为自检理解错了需求 → 调 send_message(intent=\'ask_human\') 向人类'
  + '说明情况（用人话描述你想做什么、卡在哪，不要提自检机制）\n'
  + '不要再次直接 end_turn——它会再次注入本提示，反复 3 次后系统会终止本任务并标记为未交付。'

export const GOAL_MODE_NO_DELIVERY_FAILURE_REASON =
  '任务设定了 goal，但 worker 多次直接 end_turn，始终没有通过 send_message(intent=info) 交付，也没有通过 send_message(intent=ask_human) 求助；为避免空 buffer audit 反复消耗，系统终止本任务。'

const MAX_SILENT_NO_DELIVERY_RETRIES = 3

export interface AsyncAuditEndTurnGateDeps {
  /** 任务 ID — admin RPC 查 goal 用 + 透传给 spawnAuditSubagent。 */
  readonly taskId: string
  /** 任务状态对象 — 读 outboundBuffer 判定 passthrough，写 activeAuditId 标等审态。 */
  readonly taskState: WorkerTaskState

  /** worker 是否已 set_task_goal —— set_task_goal 工具路径会同步更新外部 cache。 */
  readonly goalSetCacheGetter: () => boolean

  /** admin get_task RPC 三件套（取当前 goal）。 */
  readonly rpcClient: Pick<RpcClient, 'call'>
  readonly moduleId: string
  readonly getAdminPort: () => Promise<number>

  /** 透传给 spawnAuditSubagent 的所有非闭包内可解析的依赖。
   *  audit subagent 的 goal 字段在闭包内 RPC 取得后覆盖，这里不用传。 */
  readonly buildSpawnDeps: (goal: GoalAuditTaskGoal) => SpawnAuditSubagentDeps

  /**
   * 测试 hook：注入 mock spawnAuditSubagent 控制 audit_id 返回 / 抛错时序。
   * 默认走真 spawnAuditSubagent。
   */
  readonly spawnAuditSubagentFn?: typeof spawnAuditSubagent
}

/**
 * 构造 engine endTurnGate 闭包 — 异步派 audit + 返回 wait 信号让 engine 直接挂起。
 *
 * 闭包签名：`() => Promise<EndTurnGateResult>`
 *  - 返回 string：engine 把这段文本作为 user message 注入下一轮（worker 不真 end_turn）
 *  - 返回 { kind: 'wait' }：audit 已派出，engine 直接 setBarrier 挂起等结果——
 *    取代旧的「注入 [audit_pending] 文本 → LLM 调 wait_for_signal」往返，
 *    每轮 audit 省一次全量 context 的 LLM 调用（spec 2026-06-10 §4.7）
 *  - 返回 null：engine 放行 end_turn（含 flush outboundBuffer）
 */
export function createAsyncAuditEndTurnGate(
  deps: AsyncAuditEndTurnGateDeps,
): () => Promise<EndTurnGateResult> {
  const spawn = deps.spawnAuditSubagentFn ?? spawnAuditSubagent

  return async () => {
    // 0. 已有 audit 在跑 → 绝不派第二个，交给 engine 的 hasActiveAudit 挂起路径接管。
    //    防御性不变量：正常时序下 engine 在调 gate 前已按 hasActiveAudit 挂起，到不了这里；
    //    显式挡住是防未来时序改动引入双 audit 并发（spec 2026-07-16 §4.2）。
    if (deps.taskState.activeAuditId !== undefined) return null

    // 1. 工作态门控：worker 尚未 set_task_goal → 没东西要审 → 透明放行
    if (!deps.goalSetCacheGetter()) return null

    // 2. buffer 空分支（spec §4.13.4 二级决策）
    //    has goal + buffer 空 命中以下三种情形之一：
    //    - 从未 audit（agent 全程没 send_message 触发过 audit）
    //    - 上一轮 audit fail，agent 看完 detailedReport 又直接 end_turn（buffer 在 fail 时已 drop）
    //    - 上一轮 audit aborted（改 goal 触发），agent 看完 abort marker 又直接 end_turn
    //    按当前 human input epoch 是否已送达区分讨论型 vs 从未交付。
    if (deps.taskState.outboundBuffer.length === 0) {
      if (deps.taskState.lastDeliveredInfoEpoch === deps.taskState.humanInputEpoch) {
        // 讨论型放行：之前 flush 过 info，这次没事干 end_turn 是预期行为
        return null
      }
      // !everSentMessage：goal 设了但从未送达——按"交付被拦"vs"从未交付"分文案
      if (deps.taskState.silentNoDeliveryRetries < MAX_SILENT_NO_DELIVERY_RETRIES) {
        deps.taskState.silentNoDeliveryRetries++
        return deps.taskState.everBufferedMessage
          ? GOAL_MODE_INTERCEPTED_DELIVERY_PROMPT
          : GOAL_MODE_NO_DELIVERY_PROMPT
      }
      return {
        kind: 'fail' as const,
        reason: GOAL_MODE_NO_DELIVERY_FAILURE_REASON,
      }
    }

    // 3. 拿 goal（闭包触发时 RPC，保证拿到最新值；set_task_goal 改 goal 后立刻生效）
    //    buffer 非空 / 强制 audit 两条路径共享。
    let goal: GoalAuditTaskGoal
    try {
      const adminPort = await deps.getAdminPort()
      const taskResp = await deps.rpcClient.call<
        { task_id: string },
        { task: { id: string; goal?: GoalAuditTaskGoal } }
      >(adminPort, 'get_task', { task_id: deps.taskId }, deps.moduleId)
      if (!shouldArmGoalGate(taskResp.task.goal)) {
        // 缺失 → fail-open（goalModeEnabled + goalSetCache=true 才进得了这条 gate，理论上不该没 goal）。
        // 终态（complete/cleared/…）→ 同样放行：承诺已兑现/已清除，不对终态 goal 派 audit
        // （spec 2026-07-16 §2.2-2；防 set_task_goal 与 end_turn 并发竞态的第二道防线）。
        return null
      }
      goal = taskResp.task.goal!
    } catch (err) {
      console.warn(
        '[endTurnGate] get_task RPC failed open:',
        err instanceof Error ? err.message : String(err),
      )
      return null
    }

    // 4. 异步派 audit subagent — 立即拿 audit_id（不等 audit 完成）
    let auditId: string
    try {
      auditId = await spawn(deps.buildSpawnDeps(goal))
    } catch (err) {
      console.warn(
        '[endTurnGate] spawn audit failed open:',
        err instanceof Error ? err.message : String(err),
      )
      return null
    }

    // 5. 标记等审态 — send_message handler / drain / wait_for_signal 用这个判
    deps.taskState.activeAuditId = auditId

    // 6. 返回 wait 信号 — engine 直接挂起等 audit 结果 push，不再经过 LLM
    return { kind: 'wait' }
  }
}
