import { describe, it, expect } from 'vitest'
import {
  normalizeFriendChannelRefs,
  normalizeTaskChannelRefs,
  normalizeScheduleChannelRefs,
} from './import-channel-ref-normalize.js'
import type { Friend, Task, Schedule } from './types.js'

// #2(a): 备份导入把 channel 主记录归一化为 NFC（upsertInstanceById），但引用该 channel 的
// Friend/Task/Schedule 若原样保留 NFD channel_id，会与 canonical 化的主记录断链
//（身份匹配 / 任务过滤 / 定时投递）。这里在导入时把引用同步归一化。
const nfd = '微信café'.normalize('NFD')
const nfc = '微信café'.normalize('NFC')

describe('导入时归一化 channel_id 引用', () => {
  it('Friend.channel_identities[].channel_id → NFC', () => {
    const friend = {
      id: 'f1',
      display_name: 'x',
      permission: 'normal',
      channel_identities: [
        { channel_id: nfd, platform: 'feishu', platform_user_id: 'u1' },
        { channel_id: 'ascii-chan', platform: 'telegram', platform_user_id: 'u2' },
      ],
      created_at: '',
      updated_at: '',
    } as unknown as Friend

    const out = normalizeFriendChannelRefs(friend)
    expect(out.channel_identities[0].channel_id).toBe(nfc)
    expect(out.channel_identities[1].channel_id).toBe('ascii-chan')
  })

  it('Task.source.channel_id → NFC', () => {
    const task = {
      id: 't1',
      source: { channel_id: nfd, trigger_type: 'message' },
    } as unknown as Task

    expect(normalizeTaskChannelRefs(task).source.channel_id).toBe(nfc)
  })

  it('Schedule.target_session.channel_id → NFC', () => {
    const sched = {
      id: 's1',
      target_session: { channel_id: nfd, session_id: 'sess', type: 'private' },
    } as unknown as Schedule

    expect(normalizeScheduleChannelRefs(sched).target_session!.channel_id).toBe(nfc)
  })

  it('无 channel_id 引用时原样返回，不抛错', () => {
    const task = { id: 't2', source: { trigger_type: 'manual' } } as unknown as Task
    expect(normalizeTaskChannelRefs(task)).toBe(task)
    const sched = { id: 's2' } as unknown as Schedule
    expect(normalizeScheduleChannelRefs(sched)).toBe(sched)
    const friend = { id: 'f2', channel_identities: [] } as unknown as Friend
    expect(normalizeFriendChannelRefs(friend)).toBe(friend)
  })
})
