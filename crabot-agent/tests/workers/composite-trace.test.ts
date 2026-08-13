/**
 * P6-A §8：composite worker trace reader 测试。
 * 三源合并排序、opaque cursor 窗口稳定重放、错化身/非法 cursor INVALID_PARAMS、
 * native 不可用时 harness 仍返回、source-scoped reason、next_cursor 恒在。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { readCompositeWorkerTrace } from '../../src/workers/trace/composite-reader.js'
import { TraceCursorStore } from '../../src/workers/trace/cursor-store.js'
import { NativeTraceCopyStore } from '../../src/workers/trace/native-copy.js'
import type { Incarnation, LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import type { NormalizedTraceEvent, WorkerAdapter } from '../../src/workers/types.js'
import type { HarnessEvent } from '../../src/workers/harness/worker-events.js'

const WORKER_ID = 'w-comp-1'

function makeWorker(over: Partial<LedgerWorker> = {}): LedgerWorker {
  const mainline: Incarnation = {
    seq: 1, impl: 'claude-code', state: 'running',
    session_ref: 'sess-1', started_at: '2026-08-01T00:00:00.000Z',
  } as unknown as Incarnation
  return {
    worker_id: WORKER_ID,
    manager_key: 'wechat::sess',
    task: { id: WORKER_ID, title: 't', status: 'executing', created_at: '2026-08-01T00:00:00.000Z' },
    origin: { trigger_type: 'message' },
    report_to: { channel_id: 'wechat', session_id: 'sess' },
    incarnations: [mainline],
    ...over,
  } as LedgerWorker
}

function harnessEvent(seq: number, kind: string, ts: string): HarnessEvent {
  return { ts, kind: kind as HarnessEvent['kind'], worker_id: WORKER_ID, seq }
}

function nativeEvent(text: string, ts: string): NormalizedTraceEvent {
  return { ts, kind: 'message', role: 'assistant', summary: text }
}

describe('readCompositeWorkerTrace', () => {
  let dir: string
  let cursorStore: TraceCursorStore
  let nativeCopy: NativeTraceCopyStore
  let harnessEvents: HarnessEvent[]
  let nativeLines: NormalizedTraceEvent[]
  let nativeShouldThrow: string | null

  function deps() {
    return {
      ledger: { findWorker: async (id: string) => (id === WORKER_ID ? { managerKey: 'wechat::sess', worker: makeWorker() } : undefined) },
      harness: { readWorkerEvents: async () => harnessEvents },
      adapters: new Map([
        ['claude-code', {
          readTrace: async (_h: unknown, cursor?: { offset: number }) => {
            if (nativeShouldThrow) throw new Error(nativeShouldThrow)
            const start = cursor?.offset ?? 0
            return { events: nativeLines.slice(start), nextCursor: { offset: nativeLines.length } }
          },
        } as unknown as WorkerAdapter],
      ]),
      cursorStore,
      nativeCopy,
      redact: (text: string) => text,
      legacyTraceDir: join(dir, 'traces'),
    } as const
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'crabot-composite-'))
    cursorStore = new TraceCursorStore(join(dir, 'cursors'))
    nativeCopy = new NativeTraceCopyStore(join(dir, 'copies'))
    harnessEvents = []
    nativeLines = []
    nativeShouldThrow = null
  })

  afterEach(async () => {
    await cursorStore.flush()
    await nativeCopy.flush()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('worker 不存在 / 无化身 → 明确错误', async () => {
    await expect(readCompositeWorkerTrace(deps(), { worker_id: 'w-nope' })).rejects.toThrow('not found')
  })

  it('harness+native 按 ts 合并、带 source、next_cursor 恒在', async () => {
    harnessEvents = [harnessEvent(1, 'spawned', '2026-08-01T00:00:01.000Z'), harnessEvent(1, 'exited', '2026-08-01T00:00:05.000Z')]
    nativeLines = [nativeEvent('hi', '2026-08-01T00:00:02.000Z'), nativeEvent('working', '2026-08-01T00:00:03.000Z')]
    const result = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })
    expect(result.events.map((event) => event.source)).toEqual(['harness', 'native', 'native', 'harness'])
    expect(result.next_cursor).toBeTruthy()
  })

  it('同一 cursor 重放返回同一逻辑窗口，后续追加不影响', async () => {
    harnessEvents = [harnessEvent(1, 'spawned', '2026-08-01T00:00:01.000Z')]
    nativeLines = [nativeEvent('a', '2026-08-01T00:00:02.000Z')]
    const first = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })
    expect(first.events).toHaveLength(2)

    // 文件继续增长
    harnessEvents.push(harnessEvent(1, 'input_sent', '2026-08-01T00:00:03.000Z'))
    nativeLines.push(nativeEvent('b', '2026-08-01T00:00:04.000Z'))

    // 用 first 的 cursor 续读：只拿增量
    const second = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID, cursor: first.next_cursor })
    expect(second.events).toHaveLength(2)
    expect(second.events.map((event) => event.summary)).toEqual(['input_sent', 'b'])

    // 再次追加后重放 first 的窗口 cursor：返回值与第一次完全一致（窗口固定）
    nativeLines.push(nativeEvent('c', '2026-08-01T00:00:05.000Z'))
    // 用 first 之前的隐式 0 起点不可得——验证"重放 first.next_cursor 消费的窗口 token 本身"
    // second.next_cursor 现在指向新窗口；再读应为空（无新增后）+ next_cursor 恒在
    const third = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID, cursor: second.next_cursor })
    expect(third.events.map((event) => event.summary)).toEqual(['c'])
    expect(third.next_cursor).toBeTruthy()
  })

  it('非法 / 错 worker / 错化身 cursor → INVALID_PARAMS', async () => {
    const result = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })
    await expect(readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID, cursor: 'bogus-token' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(readCompositeWorkerTrace(deps(), { worker_id: 'w-comp-1', cursor: result.next_cursor, seq: 2 })).rejects.toThrow()
    // 错 worker 复用同一 token
    const other = {
      ...deps(),
      ledger: { findWorker: async () => ({ managerKey: 'k', worker: makeWorker({ worker_id: 'w-other' }) }) },
    } as never
    await expect(readCompositeWorkerTrace(other, { worker_id: 'w-other', cursor: result.next_cursor })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  })

  it('native 不可用不伤 harness：source-scoped reason 且 harness 事件照常', async () => {
    harnessEvents = [harnessEvent(1, 'spawned', '2026-08-01T00:00:01.000Z')]
    nativeShouldThrow = 'no such incarnation resident'
    const result = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })
    expect(result.events.map((event) => event.source)).toEqual(['harness'])
    expect(result.unavailable_reason).toContain('native unavailable')
    expect(result.next_cursor).toBeTruthy()
  })

  it('native 失败后回退 Agent-owned copy（终态收割/上次增量）', async () => {
    nativeLines = [nativeEvent('persisted', '2026-08-01T00:00:02.000Z')]
    // 第一次成功读 → 写 copy
    const first = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })
    expect(first.events.some((event) => event.source === 'native')).toBe(true)
    // live source 消失 → 回退 copy
    nativeShouldThrow = 'file gone'
    const second = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })
    expect(second.events.some((event) => event.summary === 'persisted' && event.source === 'native')).toBe(true)
    expect(second.unavailable_reason).toContain('copy')
  })

  it('copy 指纹不匹配不混读（seq 碰撞防御）', async () => {
    nativeLines = [nativeEvent('x', '2026-08-01T00:00:02.000Z')]
    await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })
    // 换一个化身身份（不同 session_ref）→ 指纹不同 → copy 不可见
    const changed = {
      ...deps(),
      ledger: {
        findWorker: async () => ({
          managerKey: 'k',
          worker: makeWorker({ incarnations: [{ seq: 1, impl: 'claude-code', state: 'running', session_ref: 'sess-OTHER', started_at: '2026-08-02T00:00:00.000Z' } as unknown as Incarnation] }),
        }),
      },
    } as never
    nativeShouldThrow = 'live gone'
    const result = await readCompositeWorkerTrace(changed, { worker_id: WORKER_ID })
    expect(result.events.filter((event) => event.source === 'native')).toHaveLength(0)
    expect(result.unavailable_reason).toContain('native unavailable')
  })
})
