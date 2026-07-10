/**
 * 备份导入时把引用 channel 的记录里的 channel_id 归一化为 NFC。
 *
 * upsertInstanceById 会把 channel 主记录 id 归一化为 canonical NFC；引用该 channel 的
 * Friend/Task/Schedule 若保留 NFD channel_id，会与主记录断链（身份匹配 / 任务过滤 /
 * 定时投递）。这里在导入各引用记录时同步归一化，保持引用与 canonical 主记录一致。
 * 仅处理跨记录会用于匹配的三处引用；ASCII id 归一化是恒等，无副作用。
 */
import type { Friend, Task, Schedule } from './types.js'

const nfc = (s: string): string => s.normalize('NFC')

export function normalizeFriendChannelRefs(friend: Friend): Friend {
  if (!friend.channel_identities?.length) return friend
  return {
    ...friend,
    channel_identities: friend.channel_identities.map((ci) =>
      ci.channel_id ? { ...ci, channel_id: nfc(ci.channel_id) } : ci,
    ),
  }
}

export function normalizeTaskChannelRefs(task: Task): Task {
  if (!task.source?.channel_id) return task
  return { ...task, source: { ...task.source, channel_id: nfc(task.source.channel_id) } }
}

export function normalizeScheduleChannelRefs(schedule: Schedule): Schedule {
  if (!schedule.target_session?.channel_id) return schedule
  return {
    ...schedule,
    target_session: { ...schedule.target_session, channel_id: nfc(schedule.target_session.channel_id) },
  }
}
