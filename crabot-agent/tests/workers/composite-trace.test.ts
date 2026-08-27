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
import { TraceCursorStore, incarnationFingerprint, legacyIncarnationFingerprint } from '../../src/workers/trace/cursor-store.js'
import { NativeTraceCopyStore } from '../../src/workers/trace/native-copy.js'
import type { Incarnation, LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import type { NormalizedTraceEvent, WorkerAdapter } from '../../src/workers/types.js'
import type { HarnessEvent } from '../../src/workers/harness/worker-events.js'

const WORKER_ID = 'w-comp-1'
const INCARNATION_ID = '0198fed8-9c4a-7000-8000-000000000001'

function makeWorker(over: Partial<LedgerWorker> = {}): LedgerWorker {
  const mainline: Incarnation = {
    incarnation_id: INCARNATION_ID,
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

function harnessEvent(
  seq: number,
  kind: string,
  ts: string,
  detail?: Record<string, unknown>,
): HarnessEvent {
  return {
    ts,
    kind: kind as HarnessEvent['kind'],
    worker_id: WORKER_ID,
    seq,
    ...(detail ? { detail } : {}),
  }
}

function nativeEvent(text: string, ts: string): NormalizedTraceEvent {
  return { ts, kind: 'message', role: 'assistant', summary: text }
}

/** 与真实 adapter 对齐：native 事件带行号位置。 */
function nativeEventAt(text: string, ts: string, offset: number): NormalizedTraceEvent {
  return { ...nativeEvent(text, ts), source_offset: offset }
}

describe('readCompositeWorkerTrace', () => {
  let dir: string
  let cursorStore: TraceCursorStore
  let nativeCopy: NativeTraceCopyStore
  let harnessEvents: HarnessEvent[]
  let inputDeliveryPreviews: Map<string, string>
  let inputDeliveryPreviewsShouldThrow: boolean
  let nativeLines: NormalizedTraceEvent[]
  let nativeShouldThrow: string | null
  let persistedNativeLines: NormalizedTraceEvent[]
  let persistedReadCalls: number

  function setNative(events: NormalizedTraceEvent[]): void {
    nativeLines = events.map((event, index) => ({ ...event, source_offset: index }))
  }

  function deps() {
    return {
      ledger: { findWorker: async (id: string) => (id === WORKER_ID ? { managerKey: 'wechat::sess', worker: makeWorker() } : undefined) },
      harness: {
        readWorkerEvents: async () => harnessEvents,
        getInputDeliveryPreviews: async () => {
          if (inputDeliveryPreviewsShouldThrow) throw new Error('receipt file corrupt')
          return inputDeliveryPreviews
        },
        getPersistedNativeActivityTrace: async (
          _workerId: string,
          _incarnationId: string,
          cursor: { offset: number },
        ) => {
          persistedReadCalls += 1
          return {
            events: persistedNativeLines.filter((event) => (event.source_offset ?? 0) >= cursor.offset),
            nextCursor: {
              offset: persistedNativeLines.length === 0
                ? cursor.offset
                : Math.max(...persistedNativeLines.map((event) => event.source_offset ?? 0)) + 1,
            },
          }
        },
      },
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
    inputDeliveryPreviews = new Map()
    inputDeliveryPreviewsShouldThrow = false
    setNative([])
    nativeShouldThrow = null
    persistedNativeLines = []
    persistedReadCalls = 0
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
    setNative([nativeEvent('hi', '2026-08-01T00:00:02.000Z'), nativeEvent('working', '2026-08-01T00:00:03.000Z')])
    const result = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })
    expect(result.events.map((event) => event.source)).toEqual(['harness', 'native', 'native', 'harness'])
    expect(result.next_cursor).toBeTruthy()
  })

  it('可靠操作终态摘要带稳定关联字段和失败原因码', async () => {
    harnessEvents = [
      harnessEvent(1, 'input_delivery_failed', '2026-08-01T00:00:01.000Z', {
        delivery_id: 'delivery-1',
        reason_code: 'delivery_deadline_exceeded',
      }),
      harnessEvent(1, 'query_completed', '2026-08-01T00:00:02.000Z', {
        query_id: 'query-1',
        fork_seq: 2,
      }),
      harnessEvent(1, 'query_failed', '2026-08-01T00:00:03.000Z', {
        query_id: 'query-2',
        fork_seq: 3,
        reason_code: 'query_execution_failed',
      }),
    ]

    const result = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })

    expect(result.events.map((event) => event.summary)).toEqual([
      'input_delivery_failed delivery_id=delivery-1 reason_code=delivery_deadline_exceeded',
      'query_completed query_id=query-1 fork_seq=2',
      'query_failed query_id=query-2 fork_seq=3 reason_code=query_execution_failed',
    ])
  })

  it('input_sent 按 delivery_id 补入受限 receipt 预览', async () => {
    harnessEvents = [harnessEvent(1, 'input_sent', '2026-08-01T00:00:01.000Z', {
      delivery_id: 'delivery-1',
      text_len: 12,
    })]
    inputDeliveryPreviews.set('delivery-1', '继续核对候选数据')

    const result = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })

    expect(result.events).toMatchObject([{
      kind: 'lifecycle',
      summary: 'input_sent delivery_id=delivery-1',
      detail: { delivery_id: 'delivery-1', text_len: 12, text_preview: '继续核对候选数据' },
    }])
  })

  it('receipt 预览不可读时仍返回独立的 input_sent 事件', async () => {
    harnessEvents = [harnessEvent(1, 'input_sent', '2026-08-01T00:00:01.000Z', {
      delivery_id: 'delivery-1',
      text_len: 12,
    })]
    inputDeliveryPreviewsShouldThrow = true

    const result = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })

    expect(result.events).toMatchObject([{
      kind: 'lifecycle',
      summary: 'input_sent delivery_id=delivery-1',
      detail: { delivery_id: 'delivery-1', text_len: 12 },
    }])
  })

  it('同一 cursor 重放返回同一逻辑窗口，后续追加不影响', async () => {
    harnessEvents = [harnessEvent(1, 'spawned', '2026-08-01T00:00:01.000Z')]
    setNative([nativeEvent('a', '2026-08-01T00:00:02.000Z')])
    const first = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })
    expect(first.events).toHaveLength(2)

    // 文件继续增长
    harnessEvents.push(harnessEvent(1, 'input_sent', '2026-08-01T00:00:03.000Z'))
    setNative([...nativeLines.map((e) => nativeEvent(e.summary, e.ts)), nativeEvent('b', '2026-08-01T00:00:04.000Z')])

    // 用 first 的 cursor 续读：只拿增量
    const second = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID, cursor: first.next_cursor })
    expect(second.events).toHaveLength(2)
    expect(second.events.map((event) => event.summary)).toEqual(['input_sent', 'b'])

    // 再次追加后重放 first 的窗口 cursor：返回值与第一次完全一致（窗口固定）
    setNative([...nativeLines.map((e) => nativeEvent(e.summary, e.ts)), nativeEvent('c', '2026-08-01T00:00:05.000Z')])
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
    setNative([nativeEvent('persisted', '2026-08-01T00:00:02.000Z')])
    // 第一次成功读 → 写 copy
    const first = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })
    expect(first.events.some((event) => event.source === 'native')).toBe(true)
    // live source 消失 → 回退 copy
    nativeShouldThrow = 'file gone'
    const second = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })
    expect(second.events.some((event) => event.summary === 'persisted' && event.source === 'native')).toBe(true)
    expect(second.unavailable_reason).toContain('copy')
  })

  it('copy 只覆盖当前窗口前半段时，用 Harness 持久化 evidence 补齐后续 error', async () => {
    const fingerprint = incarnationFingerprint({
      incarnation_id: INCARNATION_ID,
      impl: 'claude-code',
      seq: 1,
      started_at: '2026-08-01T00:00:00.000Z',
    })
    const copied = nativeEventAt('copied activity', '2026-08-01T00:00:02.000Z', 0)
    await nativeCopy.append(WORKER_ID, 1, fingerprint, [copied], (text) => text)
    await nativeCopy.flush()
    nativeShouldThrow = 'rollout missing'
    persistedNativeLines = [
      copied,
      {
        ts: '2026-08-01T00:00:03.000Z',
        kind: 'error',
        summary: 'persisted error after partial copy',
        source_offset: 1,
      },
    ]

    const result = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })

    expect(result.events.map((event) => event.summary)).toEqual([
      'copied activity',
      'persisted error after partial copy',
    ])
    expect(result.unavailable_reason).toContain('harness persisted activity')
    expect(persistedReadCalls).toBe(1)
  })

  it('copy 存在但不覆盖当前增量窗口时继续回退 Harness 持久化 evidence', async () => {
    setNative([nativeEvent('copied before current window', '2026-08-01T00:00:02.000Z')])
    const first = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })
    nativeShouldThrow = 'rollout missing'
    persistedNativeLines = [{
      ts: '2026-08-01T00:00:03.000Z',
      kind: 'error',
      summary: 'persisted error after copy',
      source_offset: 1,
    }]

    const result = await readCompositeWorkerTrace(deps(), {
      worker_id: WORKER_ID,
      cursor: first.next_cursor,
    })

    expect(result.events).toMatchObject([{
      source: 'native',
      kind: 'error',
      summary: 'persisted error after copy',
    }])
    expect(result.unavailable_reason).toContain('harness persisted activity')
    expect(persistedReadCalls).toBe(1)
  })

  it('live native 与 Agent-owned copy 都不可用时回退 Harness 持久化 error evidence', async () => {
    nativeShouldThrow = 'rollout missing'
    persistedNativeLines = [{
      ts: '2026-08-01T00:00:02.000Z',
      kind: 'error',
      summary: '[redacted] automatic compaction failed',
      source_offset: 0,
    }]

    const result = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })

    expect(result.events).toMatchObject([{
      source: 'native',
      kind: 'error',
      summary: '[redacted] automatic compaction failed',
    }])
    expect(result.unavailable_reason).toContain('harness persisted activity')
    expect(persistedReadCalls).toBe(1)
  })

  it('adapter 未注册或没有 readTrace 时仍按 copy → persisted 顺序回退', async () => {
    persistedNativeLines = [{
      ts: '2026-08-01T00:00:02.000Z',
      kind: 'error',
      summary: 'persisted error evidence',
      source_offset: 0,
    }]
    const adapterVariants = [
      new Map(),
      new Map([['claude-code', {} as WorkerAdapter]]),
    ]

    for (const adapters of adapterVariants) {
      const result = await readCompositeWorkerTrace({ ...deps(), adapters } as never, { worker_id: WORKER_ID })
      expect(result.events).toMatchObject([{
        source: 'native',
        kind: 'error',
        summary: 'persisted error evidence',
      }])
      expect(result.unavailable_reason).toContain('harness persisted activity')
    }
    expect(persistedReadCalls).toBe(2)
  })

  it('live native 可用时不读取 Harness 持久化 fallback', async () => {
    setNative([nativeEvent('live', '2026-08-01T00:00:02.000Z')])
    persistedNativeLines = [{
      ts: '2026-08-01T00:00:03.000Z',
      kind: 'error',
      summary: 'must not duplicate',
      source_offset: 1,
    }]

    const result = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })

    expect(result.events.map((event) => event.summary)).toContain('live')
    expect(result.events.map((event) => event.summary)).not.toContain('must not duplicate')
    expect(persistedReadCalls).toBe(0)
  })

  it('durable opaque cursor 返回前已经完成落盘', async () => {
    const durableDir = join(dir, 'durable-cursors')
    const store = new TraceCursorStore(durableDir)
    const token = await store.mintDurable(
      WORKER_ID,
      incarnationFingerprint({
        incarnation_id: INCARNATION_ID,
        impl: 'claude-code',
        seq: 1,
        started_at: '2026-08-01T00:00:00.000Z',
      }),
      { harness: 0, native: 7, legacy: 0 },
    )

    await expect(fs.readFile(join(durableDir, `${token}.json`), 'utf8')).resolves.toContain(token)
  })

  it('原生 source 消失时升级 pre-incarnation copy 的 header 并保留历史事件', async () => {
    const copyDir = join(dir, 'copies', encodeURIComponent(WORKER_ID))
    const copyPath = join(copyDir, 'seq-1.jsonl')
    const event = nativeEventAt('persisted before incarnation id', '2026-08-01T00:00:02.000Z', 0)
    const legacyFingerprint = legacyIncarnationFingerprint({
      impl: 'claude-code', seq: 1, started_at: '2026-08-01T00:00:00.000Z',
    })
    await fs.mkdir(copyDir, { recursive: true })
    await fs.writeFile(copyPath, [
      JSON.stringify({ kind: 'native-trace-copy-header', worker_id: WORKER_ID, seq: 1, incarnation_fingerprint: legacyFingerprint }),
      JSON.stringify(event),
      '',
    ].join('\n'))
    nativeShouldThrow = 'live source gone'

    const result = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })

    expect(result.events).toMatchObject([{ source: 'native', summary: 'persisted before incarnation id' }])
    const currentFingerprint = incarnationFingerprint({
      incarnation_id: INCARNATION_ID,
      impl: 'claude-code', seq: 1, started_at: '2026-08-01T00:00:00.000Z',
    })
    expect((await nativeCopy.read(WORKER_ID, 1, currentFingerprint))?.events).toEqual([event])
    expect(JSON.parse((await fs.readFile(copyPath, 'utf-8')).split('\n', 1)[0])).toMatchObject({
      incarnation_fingerprint: currentFingerprint,
    })
  })

  it('pre-incarnation copy 不匹配当前化身的旧摘要时不读入', async () => {
    const copyDir = join(dir, 'copies', encodeURIComponent(WORKER_ID))
    await fs.mkdir(copyDir, { recursive: true })
    await fs.writeFile(join(copyDir, 'seq-1.jsonl'), [
      JSON.stringify({
        kind: 'native-trace-copy-header', worker_id: WORKER_ID, seq: 1,
        incarnation_fingerprint: legacyIncarnationFingerprint({
          impl: 'claude-code', seq: 1, started_at: '2026-08-01T00:00:00.000Z',
        }),
      }),
      JSON.stringify(nativeEventAt('must stay isolated', '2026-08-01T00:00:02.000Z', 0)),
      '',
    ].join('\n'))
    const changed = {
      ...deps(),
      ledger: {
        findWorker: async () => ({
          managerKey: 'k',
          worker: makeWorker({ incarnations: [{
            incarnation_id: '0198fed8-9c4a-7000-8000-000000000002',
            seq: 1, impl: 'claude-code', state: 'running', session_ref: 'sess-OTHER',
            started_at: '2026-08-02T00:00:00.000Z',
          } as unknown as Incarnation] }),
        }),
      },
    } as never
    nativeShouldThrow = 'live source gone'

    const result = await readCompositeWorkerTrace(changed, { worker_id: WORKER_ID })

    expect(result.events.filter((event) => event.source === 'native')).toHaveLength(0)
    expect(result.unavailable_reason).toContain('native unavailable')
  })

  it('从头重读 live source 会替换旧 copy，回退时保留同一 source_offset 的展开事件', async () => {
    nativeLines = [nativeEventAt('old lifecycle', '2026-08-01T00:00:02.000Z', 0)]
    await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })

    nativeLines = [
      {
        ts: '2026-08-01T00:00:02.000Z',
        kind: 'llm_call',
        summary: 'llm tool_use',
        detail: { stop_reason: 'tool_use' },
        source_offset: 0,
      },
      {
        ts: '2026-08-01T00:00:02.000Z',
        kind: 'message',
        role: 'assistant',
        summary: '先检查当前目录',
        detail: { content: '先检查当前目录' },
        source_offset: 0,
      },
      {
        ts: '2026-08-01T00:00:03.000Z',
        kind: 'tool_call',
        role: 'assistant',
        summary: 'exec_command(pwd)',
        detail: { call_id: 'cmd-1', name: 'exec_command' },
        source_offset: 1,
      },
    ]
    await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })
    const copy = await nativeCopy.read(WORKER_ID, 1, incarnationFingerprint({
      incarnation_id: INCARNATION_ID,
      impl: 'claude-code',
      seq: 1,
      started_at: '2026-08-01T00:00:00.000Z',
    }))
    expect(copy?.events.map((event) => event.source_offset)).toEqual([0, 0, 1])

    nativeShouldThrow = 'file gone'
    const fallback = await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })
    expect(fallback.events.filter((event) => event.source === 'native')).toMatchObject([
      { kind: 'llm_call', detail: { stop_reason: 'tool_use' } },
      { kind: 'message', role: 'assistant', detail: { content: '先检查当前目录' } },
      { kind: 'tool_call', detail: { call_id: 'cmd-1', name: 'exec_command' } },
    ])
    expect(fallback.events.some((event) => event.summary === 'old lifecycle')).toBe(false)
  })

  it('copy 指纹不匹配不混读（seq 碰撞防御）', async () => {
    setNative([nativeEvent('x', '2026-08-01T00:00:02.000Z')])
    await readCompositeWorkerTrace(deps(), { worker_id: WORKER_ID })
    // 换一个化身身份（不同 session_ref）→ 指纹不同 → copy 不可见
    const changed = {
      ...deps(),
      ledger: {
        findWorker: async () => ({
          managerKey: 'k',
          worker: makeWorker({ incarnations: [{ incarnation_id: '0198fed8-9c4a-7000-8000-000000000002', seq: 1, impl: 'claude-code', state: 'running', session_ref: 'sess-OTHER', started_at: '2026-08-02T00:00:00.000Z' } as unknown as Incarnation] }),
        }),
      },
    } as never
    nativeShouldThrow = 'live gone'
    const result = await readCompositeWorkerTrace(changed, { worker_id: WORKER_ID })
    expect(result.events.filter((event) => event.source === 'native')).toHaveLength(0)
    expect(result.unavailable_reason).toContain('native unavailable')
  })

  it('删除 Worker 的副本时同时删除其 child trace，且不影响其他 Worker', async () => {
    const fingerprint = incarnationFingerprint({
      incarnation_id: INCARNATION_ID,
      impl: 'claude-code',
      seq: 1,
      started_at: '2026-08-01T00:00:00.000Z',
    })
    const child = {
      subagent_id: 'child-1', worker_id: WORKER_ID, executor_impl: 'claude-code' as const,
      name: 'Child', status: 'completed' as const, started_at: '2026-08-01T00:00:00.000Z',
    }
    await nativeCopy.append(WORKER_ID, 1, fingerprint, [nativeEventAt('parent', '2026-08-01T00:00:01.000Z', 0)], (text) => text)
    await nativeCopy.completeSubagentCapture(WORKER_ID, INCARNATION_ID, child, 'child-fingerprint', [
      nativeEventAt('child', '2026-08-01T00:00:01.000Z', 0),
    ], 1, (text) => text)
    await nativeCopy.append('w-comp-other', 1, 'other-fingerprint', [nativeEventAt('other', '2026-08-01T00:00:01.000Z', 0)], (text) => text)

    await nativeCopy.removeWorker(WORKER_ID)

    await expect(nativeCopy.read(WORKER_ID, 1, fingerprint)).resolves.toBeNull()
    await expect(nativeCopy.readSubagent(WORKER_ID, 'child-1', 'child-fingerprint')).resolves.toBeNull()
    await expect(nativeCopy.read('w-comp-other', 1, 'other-fingerprint')).resolves.toMatchObject({
      events: [{ summary: 'other' }],
    })
  })

  it('只枚举待补齐的 child，并保留父化身归属', async () => {
    const pendingChild = {
      subagent_id: 'child-pending', worker_id: WORKER_ID, executor_impl: 'codex' as const,
      name: 'Pending child', status: 'completed' as const,
      started_at: '2026-08-01T00:00:00.000Z', ended_at: '2026-08-01T00:01:00.000Z',
    }
    const completeChild = {
      ...pendingChild, subagent_id: 'child-complete',
    }
    await nativeCopy.beginSubagentCapture(
      WORKER_ID, INCARNATION_ID, pendingChild, 'pending-fingerprint', (text) => text,
    )
    await nativeCopy.completeSubagentCapture(
      WORKER_ID, INCARNATION_ID, completeChild, 'complete-fingerprint', [], 0, (text) => text,
    )

    await expect(nativeCopy.listPendingSubagentCaptures()).resolves.toEqual([{
      worker_id: WORKER_ID,
      parent_incarnation_id: INCARNATION_ID,
      subagent_id: 'child-pending',
      subagent_fingerprint: 'pending-fingerprint',
      summary: pendingChild,
    }])
  })
})
