/**
 * Schedule 启动迁移：legacy `task_template.input.target_channel_id` +
 * `task_template.input.target_session_id` → `Schedule.target_session` 一等字段。
 *
 * Task 10 已为 `Schedule` 引入 `target_session` 字段（详见 types.ts）。本模块在 admin
 * 启动加载 schedules.json 之后做一次性、幂等迁移：把历史半结构化字段提升为顶层，
 * 删掉迁移后的 input.target_* 两个 key（其余 input 保留）。
 *
 * 设计要点：
 * - 幂等：已存在 target_session 的 schedule 原样返回（不创建新对象）。
 * - 安全：session.type 查不到（channel 还未启动 / session 失效）就跳过，保留 input.target_*
 *   作为兜底；不丢失目标。
 * - 不动 ScheduledTaskRunner / Schedule type 定义本身。
 */

import type { ModuleId, SessionId } from 'crabot-shared'
import type { Schedule } from './types.js'

/**
 * Channel/session 类型探测器：通过 channel RPC 反查 session.type。
 *
 * 实现者应：
 * - session 存在 → 返回 'private' | 'group'
 * - channel 模块未注册 / session 不存在 / 任何错误 → 返回 undefined（或抛出，调用方都会兜底）
 */
export type SessionTypeLookup = (
  channelId: string,
  sessionId: string,
) => Promise<'private' | 'group' | undefined>

export type TargetSessionRepairLookup = (
  channelId: string,
  sessionId: string,
  platformSessionId?: string,
  schedule?: Schedule,
) => Promise<{ session_id: string; platform_session_id?: string; type: 'private' | 'group' } | undefined>

/**
 * 迁移单个 schedule：把 task_template.input.target_channel_id + target_session_id
 * 提升为顶层 target_session 字段。
 *
 * 行为契约：
 * - schedule.target_session 已存在 → 跳过（返回原 schedule，identity 相等）
 * - input.target_channel_id 或 input.target_session_id 缺失 / 非 string → 返回原 schedule
 * - sessionType 查不到（lookup 返回 undefined 或抛错）→ 返回原 schedule，保留 input.target_*
 * - 迁移成功：返回新 schedule，target_session 填好，input 删 target_* 两个 key（其余 key 保留）；
 *   input 为空对象时设为 undefined；updated_at 推进
 */
export async function migrateScheduleTargetSession(
  schedule: Schedule,
  lookupSessionType: SessionTypeLookup,
): Promise<Schedule> {
  if (schedule.target_session) return schedule

  const input = schedule.task_template?.input
  if (!input) return schedule

  const legacyChannelId = input.target_channel_id
  const legacySessionId = input.target_session_id

  if (typeof legacyChannelId !== 'string' || typeof legacySessionId !== 'string') {
    return schedule
  }

  let sessionType: 'private' | 'group' | undefined
  try {
    sessionType = await lookupSessionType(legacyChannelId, legacySessionId)
  } catch {
    sessionType = undefined
  }
  if (!sessionType) return schedule

  const restInputEntries = Object.entries(input).filter(
    ([key]) => key !== 'target_channel_id' && key !== 'target_session_id',
  )

  const newInput =
    restInputEntries.length > 0 ? Object.fromEntries(restInputEntries) : undefined

  return {
    ...schedule,
    target_session: {
      channel_id: legacyChannelId as ModuleId,
      session_id: legacySessionId as SessionId,
      type: sessionType,
    },
    task_template: {
      ...schedule.task_template,
      input: newInput,
    },
    updated_at: new Date().toISOString(),
  }
}

export async function repairScheduleTargetSession(
  schedule: Schedule,
  lookupTargetSession: TargetSessionRepairLookup,
): Promise<Schedule> {
  const target = schedule.target_session
  if (!target) return schedule

  let resolved: Awaited<ReturnType<TargetSessionRepairLookup>>
  try {
    resolved = await lookupTargetSession(
      target.channel_id,
      target.session_id,
      target.platform_session_id,
      schedule,
    )
  } catch {
    resolved = undefined
  }

  if (!resolved) return schedule
  if (resolved.type !== target.type) return schedule
  if (
    target.platform_session_id
    && resolved.platform_session_id
    && resolved.platform_session_id !== target.platform_session_id
  ) {
    return schedule
  }
  const platformSessionId = resolved.platform_session_id ?? target.platform_session_id
  const same =
    resolved.session_id === target.session_id
    && resolved.type === target.type
    && platformSessionId === target.platform_session_id
  if (same) return schedule

  return {
    ...schedule,
    target_session: {
      channel_id: target.channel_id,
      session_id: resolved.session_id,
      ...(platformSessionId ? { platform_session_id: platformSessionId } : {}),
      type: resolved.type,
    },
    updated_at: new Date().toISOString(),
  }
}
