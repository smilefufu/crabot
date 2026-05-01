/**
 * Background entity 权限闸口。
 * Spec: crabot-docs/superpowers/specs/2026-05-01-long-running-agent-design.md §6.2
 *
 * 仅 master 私聊场景允许 entity 真持久化（detach + disk + survive worker 重启）；
 * 其他场景一律走 transient 路径（task-bound，task 结束自动 kill）。
 */

import type { WorkerAgentContext } from '../../types.js'

export function isPersistentMode(ctx: WorkerAgentContext): boolean {
  if (!ctx.task_origin) return false                              // autonomous schedule
  if (ctx.task_origin.session_type !== 'private') return false    // 群聊
  if (ctx.sender_friend?.permission !== 'master') return false    // 非 master friend
  return true
}
