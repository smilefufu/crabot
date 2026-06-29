import { describe, it, expect } from 'vitest'
import { ReadoptReaper, type ReadoptedExitInfo } from '../../../src/engine/bg-entities/reaper'
import type { BgEntityRegistry } from '../../../src/engine/bg-entities/registry'
import type { BgShellRegistryRecord } from '../../../src/engine/bg-entities/types'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function makeShellRecord(overrides: Partial<BgShellRegistryRecord> = {}): BgShellRegistryRecord {
  return {
    entity_id: 'shell-readopt-1',
    type: 'shell',
    status: 'running',
    owner: { friend_id: 'friend-X', session_id: 'sess-X' },
    spawned_by_task_id: 'task-readopt',
    spawned_at: new Date().toISOString(),
    exit_code: null,
    ended_at: null,
    last_activity_at: new Date().toISOString(),
    command: 'sleep 999',
    log_file: '/tmp/shell-readopt-1.log',
    pid: 999999,
    pgid: 999999,
    process_started_at: new Date().toISOString(),
    ...overrides,
  }
}

/** 构造一个只实现 reapShellIfDead 的 stub registry。 */
function stubRegistry(
  reap: (rec: BgShellRegistryRecord) => Promise<{ status: 'completed' | 'failed'; exit_code: number } | null>,
): BgEntityRegistry {
  return { reapShellIfDead: reap } as unknown as BgEntityRegistry
}

describe('ReadoptReaper', () => {
  it('探到退出 → 回调一次 + 从监视集移除 + 监视清空后自停', async () => {
    let aliveLeft = 2 // 前两轮仍存活，第三轮退出
    const reg = stubRegistry(async () => {
      if (aliveLeft > 0) {
        aliveLeft--
        return null
      }
      return { status: 'completed', exit_code: 0 }
    })
    const calls: ReadoptedExitInfo[] = []
    const reaper = new ReadoptReaper(reg, (info) => calls.push(info), 20)

    reaper.watch([makeShellRecord()])
    expect(reaper.size()).toBe(1)

    await sleep(120) // 足够跑过 3+ 轮

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      entity_id: 'shell-readopt-1',
      status: 'completed',
      exit_code: 0,
      spawned_by_task_id: 'task-readopt',
      owner_friend_id: 'friend-X',
    })
    expect(reaper.size()).toBe(0)
    reaper.stop()
  })

  it('仍存活 → 不回调，保留在监视集', async () => {
    const reg = stubRegistry(async () => null)
    const calls: ReadoptedExitInfo[] = []
    const reaper = new ReadoptReaper(reg, (info) => calls.push(info), 20)

    reaper.watch([makeShellRecord()])
    await sleep(80)

    expect(calls).toHaveLength(0)
    expect(reaper.size()).toBe(1)
    reaper.stop()
  })

  it('reapShellIfDead 抛错 → 跳过本轮，不崩、不移除', async () => {
    let throwLeft = 1
    const reg = stubRegistry(async () => {
      if (throwLeft > 0) {
        throwLeft--
        throw new Error('transient ps failure')
      }
      return { status: 'failed', exit_code: 1 }
    })
    const calls: ReadoptedExitInfo[] = []
    const reaper = new ReadoptReaper(reg, (info) => calls.push(info), 20)

    reaper.watch([makeShellRecord()])
    await sleep(120)

    // 第一轮抛错被吞、保留；后续轮探到 failed → 回调一次
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('failed')
    reaper.stop()
  })
})
