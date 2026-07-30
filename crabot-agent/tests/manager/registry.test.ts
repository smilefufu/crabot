import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  ManagerRegistry,
  SYSTEM_TASKS_MANAGER_KEY,
  type ManagerRegistryDeps,
  type OnAsyncError,
} from '../../src/manager/registry.js'
import {
  laneBatchToWakeEvent,
  attentionFlushToWakeEvent,
  shouldWakeOnHarnessEvent,
} from '../../src/manager/inbound-adapters.js'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import type { CompactionPolicy } from '../../src/manager/compaction.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { ChannelMessage } from '../../src/types.js'
import { dialogObjectIdForPrivate } from '../../src/workers/harness/ledger-types.js'
import type { LedgerStore } from '../../src/workers/harness/ledger-store.js'
import type { LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import type { WorkerHarness } from '../../src/workers/harness/harness.js'
import type { HarnessEvent, HarnessEventKind } from '../../src/workers/harness/worker-events.js'
import type { LLMAdapter, LLMStreamParams, EngineMessage } from '../../src/engine/index.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

// --- Fixtures / helpers（与 tests/manager/loop.test.ts 同一套约定） ---

interface TurnScript {
  readonly text?: string
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
}

function makeAdapter(): { readonly adapter: LLMAdapter; readonly queue: TurnScript[]; readonly calls: LLMStreamParams[] } {
  const queue: TurnScript[] = []
  const calls: LLMStreamParams[] = []
  const adapter: LLMAdapter = {
    async *stream(params: LLMStreamParams) {
      calls.push({ ...params, messages: [...params.messages] })
      const r = queue.shift() ?? { text: '(默认回复)', stopReason: 'end_turn' as const }
      const content: unknown[] = r.text ? [{ type: 'text', text: r.text }] : []
      yield* chunksFromContent(content, r.stopReason, { inputTokens: 10, outputTokens: 5 })
    },
    updateConfig: () => {},
  }
  return { adapter, queue, calls }
}

function makeChannelMessage(text: string): ChannelMessage {
  return {
    platform_message_id: `pm-${Math.random().toString(36).slice(2)}`,
    session: { session_id: 'sess', channel_id: 'wechat', type: 'private' },
    sender: { platform_user_id: 'u1', platform_display_name: '测试用户' },
    content: { type: 'text', text },
    features: { is_mention_crab: false },
    platform_timestamp: new Date().toISOString(),
  }
}

const estimateTokens = (msgs: ReadonlyArray<EngineMessage>): number => msgs.length * 10

const FAKE_HARNESS = { listWorkers: async (): Promise<LedgerWorker[]> => [] } as unknown as WorkerHarness

function makeLedgerWorker(workerId: string, spawnedBySession: ManagerKey): LedgerWorker {
  return {
    worker_id: workerId,
    task: { id: workerId, title: 't', status: 'running', created_at: '2026-01-01T00:00:00.000Z' },
    origin: { spawned_by_session: spawnedBySession, trigger_type: 'message' },
    report_to: { channel_id: 'wechat', session_id: 'sess' },
    incarnations: [],
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

/** 只实现 registry 需要的 findWorker;其余字段用不到,cast 成 LedgerStore。 */
function fakeLedger(workers: Record<string, LedgerWorker>): LedgerStore {
  return {
    findWorker: async (workerId: string) => {
      const worker = workers[workerId]
      if (!worker) return undefined
      return { dialogObjectId: dialogObjectIdForPrivate('friend-x'), worker }
    },
  } as unknown as LedgerStore
}

describe('ManagerRegistry', () => {
  let dataDir: string
  let store: ManagerSessionStore

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'manager-registry-'))
    store = new ManagerSessionStore(join(dataDir, 'manager-sessions'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  function baseRegistryDeps(
    overrides: Partial<ManagerRegistryDeps> & { readonly adapter: LLMAdapter }
  ): ManagerRegistryDeps {
    const policy: CompactionPolicy = { keepRecent: 100, cacheTtlMs: 1_000_000, foldTokenThreshold: 1_000_000, hardCapTokens: 1_000_000 }
    return {
      store,
      policy,
      estimateTokens,
      harness: FAKE_HARNESS,
      ledger: fakeLedger({}),
      model: 'test-model',
      now: () => new Date(Date.parse('2026-01-01T00:00:00.000Z')),
      dialogObjectIdFor: () => dialogObjectIdForPrivate('friend-x'),
      toolFace: () => [],
      promptInputs: () => ({}),
      ...overrides,
    }
  }

  // --- getOrCreate ---

  it('getOrCreate: 同 key 幂等返回同一实例，不同 key 返回不同实例', () => {
    const { adapter } = makeAdapter()
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))

    const a1 = registry.getOrCreate('wechat::s1' as ManagerKey)
    const a2 = registry.getOrCreate('wechat::s1' as ManagerKey)
    const b = registry.getOrCreate('wechat::s2' as ManagerKey)

    expect(a2).toBe(a1)
    expect(b).not.toBe(a1)
  })

  it('getOrCreate: 惰性——构造 registry 本身不解析任何 key 的 dialogObjectId，仅在 getOrCreate 时才解析', () => {
    const { adapter } = makeAdapter()
    const dialogObjectIdFor = vi.fn(() => dialogObjectIdForPrivate('friend-x'))
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter, dialogObjectIdFor }))

    expect(dialogObjectIdFor).not.toHaveBeenCalled()
    registry.getOrCreate('wechat::s1' as ManagerKey)
    expect(dialogObjectIdFor).toHaveBeenCalledTimes(1)
    expect(dialogObjectIdFor).toHaveBeenCalledWith('wechat::s1')
  })

  it('getOrCreate: isSystemThread 按 key 是否等于保留名判定（体现在 system prompt 的系统线程纪律段）', async () => {
    const { adapter, queue, calls } = makeAdapter()
    queue.push({ text: '系统线程回复', stopReason: 'end_turn' })
    queue.push({ text: '普通线程回复', stopReason: 'end_turn' })
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))

    await registry.routeSchedule({ scheduleId: 'sc', title: 't', description: 'd' }) // 无 targetSession → 落系统线程
    await registry.routeHumanMessages('wechat', 'sess-normal', [makeChannelMessage('hi')])

    expect(calls[0].systemPrompt).toContain('系统线程纪律')
    expect(calls[1].systemPrompt).not.toContain('系统线程纪律')
  })

  // --- routeHumanMessages ---

  it('routeHumanMessages: 打到 `${channelId}::${sessionId}` 对应的 manager', async () => {
    const { adapter, queue } = makeAdapter()
    queue.push({ text: '收到', stopReason: 'end_turn' })
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))

    const result = await registry.routeHumanMessages('wechat', 'sess-a', [makeChannelMessage('你好')])

    expect(result.outcome).toBe('completed')
    const state = await store.load('wechat::sess-a' as ManagerKey)
    expect(JSON.stringify(state.recent)).toContain('你好')
    const otherState = await store.load('wechat::sess-b' as ManagerKey)
    expect(otherState.recent.length).toBe(0)
  })

  // --- routeWorkerEvent ---

  it('routeWorkerEvent: 经台账 origin.spawned_by_session 找到监护 manager', async () => {
    const { adapter, queue } = makeAdapter()
    queue.push({ text: '收到 worker 事件', stopReason: 'end_turn' })
    const owningKey = 'wechat::owner-sess' as ManagerKey
    const ledger = fakeLedger({ 'w-1': makeLedgerWorker('w-1', owningKey) })
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter, ledger }))

    const event: HarnessEvent = { ts: '2026-01-01T00:00:00.000Z', kind: 'exited', worker_id: 'w-1', seq: 1 }
    const result = await registry.routeWorkerEvent(event)

    expect(result?.outcome).toBe('completed')
    const state = await store.load(owningKey)
    expect(state.recent.length).toBeGreaterThan(0)
  })

  it('routeWorkerEvent: 台账查不到该 worker 时落系统线程', async () => {
    const { adapter, queue } = makeAdapter()
    queue.push({ text: '未知 worker 的事件', stopReason: 'end_turn' })
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter, ledger: fakeLedger({}) }))

    const event: HarnessEvent = { ts: '2026-01-01T00:00:00.000Z', kind: 'exited', worker_id: 'ghost', seq: 1 }
    await registry.routeWorkerEvent(event)

    const state = await store.load(SYSTEM_TASKS_MANAGER_KEY)
    expect(state.recent.length).toBeGreaterThan(0)
  })

  // --- routeSchedule ---

  it('routeSchedule: 有 targetSession → 该 session 的 manager', async () => {
    const { adapter, queue } = makeAdapter()
    queue.push({ text: '定时任务已处理', stopReason: 'end_turn' })
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))

    await registry.routeSchedule({
      scheduleId: 'sc-1',
      title: '标题',
      description: '描述',
      targetSession: { channel_id: 'wechat', session_id: 'sess-target' },
    })

    const state = await store.load('wechat::sess-target' as ManagerKey)
    expect(state.recent.length).toBeGreaterThan(0)
    const systemState = await store.load(SYSTEM_TASKS_MANAGER_KEY)
    expect(systemState.recent.length).toBe(0)
  })

  it('routeSchedule: 无 targetSession → 系统线程 manager', async () => {
    const { adapter, queue } = makeAdapter()
    queue.push({ text: '系统任务已处理', stopReason: 'end_turn' })
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))

    await registry.routeSchedule({ scheduleId: 'sc-2', title: '标题', description: '描述' })

    const state = await store.load(SYSTEM_TASKS_MANAGER_KEY)
    expect(state.recent.length).toBeGreaterThan(0)
  })

  // --- evictIdle ---

  it('evictIdle: 回收超过 idleMs 且无 episode 在跑的实例；不动盘上状态，回收后再 wakeUp 能恢复历史', async () => {
    const { adapter, queue } = makeAdapter()
    queue.push({ text: '第一次回复', stopReason: 'end_turn' })
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z')
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter, now: () => new Date(nowMs) }))
    const key = 'wechat::sess-evict' as ManagerKey

    await registry.routeHumanMessages('wechat', 'sess-evict', [makeChannelMessage('你好')])
    const loopBefore = registry.getOrCreate(key)

    nowMs += 10 * 60 * 1000 // 10 分钟后
    const evicted = registry.evictIdle(5 * 60 * 1000, nowMs) // 5 分钟阈值
    expect(evicted).toBe(1)

    queue.push({ text: '回收后再次回复', stopReason: 'end_turn' })
    const result = await registry.routeHumanMessages('wechat', 'sess-evict', [makeChannelMessage('还在吗')])
    expect(result.outcome).toBe('completed')

    // 回收后再次唤醒重建了新的 ManagerLoop 实例
    expect(registry.getOrCreate(key)).not.toBe(loopBefore)

    // 但盘上历史连续，两次唤醒的内容都还在
    const state = await store.load(key)
    const serialized = JSON.stringify(state.recent)
    expect(serialized).toContain('你好')
    expect(serialized).toContain('还在吗')
  })

  it('evictIdle: 不回收当前正有 episode 在跑的实例', async () => {
    const key = 'wechat::sess-busy' as ManagerKey
    let registry!: ManagerRegistry
    let evictedDuringEpisode: number | undefined
    const adapter: LLMAdapter = {
      async *stream(params: LLMStreamParams) {
        // episode 正在跑（mutex 被 wakeUp 持有）：即使 idleMs 给到负数（任何非负时间差都判
        // "已超时"），仍不应该被回收——唯一能阻止的只有 activeEpisodes 这道判据。
        evictedDuringEpisode = registry.evictIdle(-1, Date.parse('2026-01-01T00:00:00.000Z'))
        yield* chunksFromContent([{ type: 'text', text: '仍在忙' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
      },
      updateConfig: () => {},
    }
    registry = new ManagerRegistry(baseRegistryDeps({ adapter, now: () => new Date(Date.parse('2026-01-01T00:00:00.000Z')) }))
    registry.getOrCreate(key)

    await registry.routeHumanMessages('wechat', 'sess-busy', [makeChannelMessage('忙碌中')])

    expect(evictedDuringEpisode).toBe(0)
  })

  // --- onAsyncError 接线（Task 4 遗留出口） ---

  it('onAsyncError: episode 运行中收到异步错误 → enqueueDuringEpisode，不额外开新 episode', async () => {
    const key = 'wechat::sess-async' as ManagerKey
    let capturedOnAsyncError: OnAsyncError | undefined
    let triggered = false
    const adapter: LLMAdapter = {
      async *stream(params: LLMStreamParams) {
        // tools() 在 callNonStreaming 之前同步求值（query-loop.ts），此刻 capturedOnAsyncError
        // 必然已经就绪；只在第一轮 turn 触发一次模拟 query_worker 的异步失败，此时 episode
        // 仍在跑（registry.runWake 已经把 key 标进 activeEpisodes，wakeUp 尚未 resolve）。
        // enqueueDuringEpisode 把它推进 mailbox 后，query-loop 在本轮 end_turn 收口前会
        // drainPending 发现新内容，注入一条 supplement 消息并继续跑下一轮（而不是结束当前
        // episode）——这正是"mid-episode 注入"要验证的行为，第二轮不再触发，让它正常收口。
        if (!triggered) {
          triggered = true
          capturedOnAsyncError?.({ tool: 'query_worker', worker_id: 'w-1', error: 'fork failed' })
        }
        yield* chunksFromContent([{ type: 'text', text: '收到' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
      },
      updateConfig: () => {},
    }
    const registry = new ManagerRegistry(
      baseRegistryDeps({
        adapter,
        toolFace: (_key, _isSystemThread, onAsyncError) => {
          capturedOnAsyncError = onAsyncError
          return []
        },
      })
    )
    const loop = registry.getOrCreate(key)
    const enqueueSpy = vi.spyOn(loop, 'enqueueDuringEpisode')
    const wakeUpSpy = vi.spyOn(loop, 'wakeUp')

    await registry.routeHumanMessages('wechat', 'sess-async', [makeChannelMessage('你好')])

    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    // wakeUp 只被 routeHumanMessages 自己调用了一次；onAsyncError 没有额外触发第二次 wakeUp
    expect(wakeUpSpy).toHaveBeenCalledTimes(1)
  })

  it('onAsyncError: 无 episode 在跑时收到异步错误 → wakeUp 开一个新 episode', async () => {
    const key = 'wechat::sess-async-idle' as ManagerKey
    let capturedOnAsyncError: OnAsyncError | undefined
    const { adapter, queue } = makeAdapter()
    queue.push({ text: '初次回复', stopReason: 'end_turn' })
    const registry = new ManagerRegistry(
      baseRegistryDeps({
        adapter,
        toolFace: (_key, _isSystemThread, onAsyncError) => {
          capturedOnAsyncError = onAsyncError
          return []
        },
      })
    )

    // 先跑一次正常 episode，让 toolFace 工厂被求值一次，拿到 capturedOnAsyncError；
    // 此时该 episode 已经结束（wakeUp 已 resolve），activeEpisodes 里已经没有这个 key。
    await registry.routeHumanMessages('wechat', 'sess-async-idle', [makeChannelMessage('你好')])
    const loop = registry.getOrCreate(key)
    const enqueueSpy = vi.spyOn(loop, 'enqueueDuringEpisode')
    const wakeUpSpy = vi.spyOn(loop, 'wakeUp')

    queue.push({ text: '处理异步错误', stopReason: 'end_turn' })
    capturedOnAsyncError?.({ tool: 'query_worker', worker_id: 'w-2', error: 'fork failed' })
    // handleAsyncToolError 内部 `void this.runWake(...)` 是字面 fire-and-forget，但
    // `runWake` 对 `loop.wakeUp(event)` 的调用本身（不是它的 await）在上面这行同步完成——
    // 拿到 spy 记录的 promise 显式 await 它，而不是猜测需要多少个事件循环 tick。
    expect(wakeUpSpy).toHaveBeenCalledTimes(1)
    await wakeUpSpy.mock.results[0].value

    expect(enqueueSpy).not.toHaveBeenCalled()
    const state = await store.load(key)
    // 两次唤醒（人类消息 + 异步错误）都在历史里
    expect(JSON.stringify(state.recent)).toContain('query_failed')
  })
})

describe('inbound-adapters', () => {
  it('laneBatchToWakeEvent: 私聊 lane 批 → human_messages WakeEvent', () => {
    const m1 = makeChannelMessage('a')
    const m2 = makeChannelMessage('b')
    const event = laneBatchToWakeEvent([{ message: m1 }, { message: m2 }])
    expect(event).toEqual({ kind: 'human_messages', messages: [m1, m2] })
  })

  it('attentionFlushToWakeEvent: 群聊注意力 flush → attention_flush WakeEvent', () => {
    const m1 = makeChannelMessage('a')
    const event = attentionFlushToWakeEvent([m1])
    expect(event).toEqual({ kind: 'attention_flush', messages: [m1] })
  })

  it('shouldWakeOnHarnessEvent: 过滤 input_sent，其余 kind 一律唤醒', () => {
    const base = { ts: '2026-01-01T00:00:00.000Z', worker_id: 'w-1', seq: 1 }
    expect(shouldWakeOnHarnessEvent({ ...base, kind: 'input_sent' })).toBe(false)

    const otherKinds: HarnessEventKind[] = [
      'spawned',
      'input_held',
      'state_changed',
      'exited',
      'killed',
      'superseded',
      'handoff_started',
      'resumed',
      'query_failed',
    ]
    for (const kind of otherKinds) {
      expect(shouldWakeOnHarnessEvent({ ...base, kind })).toBe(true)
    }
  })
})
