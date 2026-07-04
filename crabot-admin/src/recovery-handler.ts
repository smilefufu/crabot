/**
 * Self-healing recovery 任务生成器
 *
 * Agent 模块意外重启后，把所有 status=executing 的非 recovery 任务标 failed，
 * 然后生成一条新的 recovery worker 任务，让 agent 自己用 find_task / get_task_progress
 * 工具调研每条中断任务的实际进度，决定继续 / 记录 / 放弃。
 *
 * @see crabot-docs/protocols/protocol-admin.md "Recovery Task 约定"
 */

import type { CreateTaskParams, Task, TaskStatus } from './types.js'

/**
 * 判断某 task 状态是否「曾进入 worker loop、可能落过 resume checkpoint、重启后需尝试 resume」。
 *
 * 任何重启（完整 stop/start、agent 崩溃自动重启、admin 单独重启）后，内存里的 worker loop
 * 都已销毁或可能已销毁。这些状态的任务都可能存在 per-turn 落盘的 resume checkpoint，应由
 * resume sweep 逐条尝试 `resume_task`——agent 侧据 checkpoint 有无（及 worker 是否仍活）决定
 * 续跑还是回绝；回绝的才标 failed + 走 recovery 兜底。
 *
 * - executing：主 loop 正在跑
 * - planning：已进入 worker loop 的规划阶段（也会落 checkpoint）
 * - waiting：parked 等 async 子 agent
 * - waiting_human：parked 等人类回复
 * **不含 pending**：还没被 worker 接走、无 checkpoint，原样留待 dispatcher 重新调度。
 *
 * 历史：旧实现把「admin 单独重启」（cleanupStaleInflightTasks，即时标 failed）与「agent 重启」
 * （isAgentRestartStale）拆成两条非对称路径，结果「完整重启」(restart_count=0) 从缝里整个漏掉。
 * 现统一为「agent 一就绪就对所有 in-flight 态尝试 resume」，不再即时标 failed。
 */
export function isResumableInflightStatus(status: TaskStatus): boolean {
  return (
    status === 'executing' ||
    status === 'planning' ||
    status === 'waiting' ||
    status === 'waiting_human'
  )
}

/**
 * 把 resume_task RPC 的结果按「成功 resume / 需要走 recovery 兜底」分流。
 *
 * 纯函数，方便单元测试。由 sweepInterruptedTasksForResume 调用。
 */
export function partitionResumeResults(
  results: ReadonlyArray<{ task: Task; resumed: boolean; reason?: string }>,
  options: { deferNotConfigured?: boolean } = {},
): { resumed: Task[]; needRecovery: Task[]; retryLater: Task[] } {
  const deferNotConfigured = options.deferNotConfigured ?? true
  const resumed: Task[] = []
  const needRecovery: Task[] = []
  const retryLater: Task[] = []
  for (const r of results) {
    if (r.resumed) {
      resumed.push(r.task)
    } else if (deferNotConfigured && r.reason === 'not_configured') {
      retryLater.push(r.task)
    } else {
      needRecovery.push(r.task)
    }
  }
  return { resumed, needRecovery, retryLater }
}

/**
 * 构造 recovery 任务参数（resume 失败的兜底）。
 *
 * @param executingTasks 需要兜底的中断任务（含 recovery 标签的，内部会过滤掉）
 * @param nowISO 当前时间 ISO 串，用于 recovery 任务的标题/描述
 *
 * @returns null 表示不需要 recovery（没有非 recovery 的中断任务）；
 *          否则返回 CreateTaskParams 直接传给 handleCreateTask。
 */
export function buildRecoveryTask(
  executingTasks: ReadonlyArray<Task>,
  nowISO: string
): CreateTaskParams | null {
  // 防雪崩：自带 'recovery' tag 的任务不再为之派生新 recovery
  const interrupted = executingTasks.filter((t) => !t.tags.includes('recovery'))
  if (interrupted.length === 0) return null

  const lines = interrupted.map((t) => {
    const startedAt = t.started_at ?? t.created_at
    return `- ${t.id}: ${t.title} (started ${startedAt})`
  })

  const initialMessageContent = [
    `[重启时间：${nowISO}]`,
    '',
    `你刚刚因故重启了。重启前有以下 ${interrupted.length} 条任务正在执行但被强制中断：`,
    '',
    ...lines,
    '',
    '请对每条任务：',
    '1. 用 find_task / get_task_progress 工具查实际进度',
    '2. 判断进度：「基本完成、只缺收尾」/「做到一半」/「刚开始」三类',
    '3. 如果有 master 在等结果（看 task source.session_id 是否还活着），先在该会话发一条状态消息',
    '4. 决定：继续推进 / 记录到 memory / 直接放弃，每条要有结论',
    '',
    '完成后给 master 一条汇总：哪些已恢复继续、哪些放弃、原因。',
  ].join('\n')

  return {
    title: `处理 agent 重启遗留的中断任务（${interrupted.length} 条）`,
    initial_message: { content: initialMessageContent },
    priority: 'high',
    source: {
      origin: 'system',
      trigger_type: 'auto',
    },
    tags: ['recovery'],
  }
}
