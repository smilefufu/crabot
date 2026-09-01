import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  ManagerRegistry,
  SYSTEM_TASKS_MANAGER_KEY,
  MAX_SELF_WAKE_CHAIN,
  type ManagerRegistryDeps,
} from '../../src/manager/registry.js'
import {
  laneBatchToWakeEvent,
  attentionFlushToWakeEvent,
  shouldWakeOnHarnessEvent,
} from '../../src/manager/inbound-adapters.js'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import type { EpisodeResult } from '../../src/manager/loop.js'
import type { CompactionPolicy } from '../../src/manager/compaction.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { ChannelMessage, Friend } from '../../src/types.js'
import type { LedgerStore } from '../../src/workers/harness/ledger-store.js'
import type { LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import type { WorkerHarness } from '../../src/workers/harness/harness.js'
import type {
  ActivityContextAdmissionReceipt,
  HarnessEvent,
  HarnessEventKind,
} from '../../src/workers/harness/worker-events.js'
import type { LLMAdapter, LLMStreamParams, EngineMessage } from '../../src/engine/index.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
import { buildManagerToolFace } from '../../src/manager/tools/tool-face.js'
import { createCrabMemoryServer } from '../../src/mcp/crab-memory.js'
import { QueryEstablishmentError } from '../../src/workers/errors.js'

// --- Fixtures / helpers（与 tests/manager/loop.test.ts 同一套约定） ---

interface TurnScript {
  readonly text?: string
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
}

function isAssistantTextEndTurnReminder(params: LLMStreamParams): boolean {
  const last = params.messages[params.messages.length - 1]
  return typeof last?.content === 'string' && last.content.startsWith('[系统提醒] 你刚才直接输出了一段文字')
}

function makeAdapter(): { readonly adapter: LLMAdapter; readonly queue: TurnScript[]; readonly calls: LLMStreamParams[] } {
  const queue: TurnScript[] = []
  const calls: LLMStreamParams[] = []
  const adapter: LLMAdapter = {
    async *stream(params: LLMStreamParams) {
      calls.push({ ...params, messages: [...params.messages] })
      if (isAssistantTextEndTurnReminder(params)) {
        yield* chunksFromContent([], 'end_turn', { inputTokens: 10, outputTokens: 5 })
        return
      }
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

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const estimateTokens = (msgs: ReadonlyArray<EngineMessage>): number => msgs.length * 10

const FAKE_HARNESS = { listWorkers: async (): Promise<LedgerWorker[]> => [] } as unknown as WorkerHarness

function makeLedgerWorker(workerId: string, managerKey: ManagerKey): LedgerWorker {
  return {
    worker_id: workerId,
    manager_key: managerKey,
    task: { id: workerId, title: 't', status: 'running', created_at: '2026-01-01T00:00:00.000Z' },
    origin: { trigger_type: 'message' },
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
      return { managerKey: worker.manager_key, worker }
    },
  } as unknown as LedgerStore
}

/** 最小 crab-memory server，供 buildManagerToolFace 装配用（照抄 tests/manager/tool-face.test.ts）。 */
function makeMemoryServer() {
  return createCrabMemoryServer(
    {
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'manager-registry-test',
      getMemoryPort: async () => 19100,
    },
    { visibility: 'internal', scopes: [], isMasterPrivate: false },
  )
}

/** 最小 crab-messaging 依赖桩，供 buildManagerToolFace 装配用（照抄 tests/manager/tool-face.test.ts）。 */
function makeMessagingDeps() {
  return {
    rpcClient: { call: vi.fn() } as never,
    moduleId: 'manager-registry-test',
    getAdminPort: async () => 19001,
    resolveChannelPort: async () => 19009,
  }
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

  /** adapter/model 的测试入参既接受字面量（绝大多数用例）也接受 thunk（专测热更语义的用例）。 */
  function baseRegistryDeps(
    overrides: Partial<Omit<ManagerRegistryDeps, 'adapter' | 'model'>> & {
      readonly adapter: LLMAdapter | (() => LLMAdapter)
      readonly model?: string | (() => string)
    }
  ): ManagerRegistryDeps {
    const policy: CompactionPolicy = { keepRecent: 100, cacheTtlMs: 1_000_000, foldTokenThreshold: 1_000_000, hardCapTokens: 1_000_000 }
    const { adapter, model, ...rest } = overrides
    return {
      store,
      policy,
      estimateTokens,
      harness: FAKE_HARNESS,
      ledger: fakeLedger({}),
      now: () => new Date(Date.parse('2026-01-01T00:00:00.000Z')),
      managerKeyFor: (key) => key,
      toolFace: () => [],
      promptInputs: () => ({}),
      adapter: typeof adapter === 'function' ? adapter : () => adapter,
      model: typeof model === 'function' ? model : () => model ?? 'test-model',
      ...rest,
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

  it('managerKey 是**每次现算**的：先建的 loop 也会跟上后来才解析出的台账归档键，不把旧值钉死', async () => {
    const { adapter, queue } = makeAdapter()
    queue.push({ text: 'ok', stopReason: 'end_turn' })
    // 归档键一开始解析不出 friend（群形状），之后收敛成 friend 形状——模拟"loop 先被
    // worker 事件建出来、人类消息随后才带来 friend"这条真实时序。
    let resolvedFriend: string | undefined
    const managerKeyFor = vi.fn((key: ManagerKey) =>
      resolvedFriend ? (`test::${resolvedFriend}` as ManagerKey) : (`${'wechat'}::${key}` as ManagerKey)
    )
    const listWorkers = vi.fn(async () => [])
    const registry = new ManagerRegistry(
      baseRegistryDeps({ adapter, managerKeyFor, harness: { ...FAKE_HARNESS, listWorkers } as never })
    )
    const key = 'wechat::s1' as ManagerKey

    // loop 建出来时身份还没解析出来
    registry.getOrCreate(key)
    resolvedFriend = 'friend-late'

    await registry.routeHumanMessages('wechat', 's1', [makeChannelMessage('你好')])

    // Stable system prompts no longer perform automatic ledger I/O; worker state is queried explicitly.
    expect(listWorkers).not.toHaveBeenCalled()
  })

  it('getOrCreate: adapter/model 是 thunk，原样透传给 ManagerLoop，不在 registry 侧缓存解析结果（§11 热更链路）', async () => {
    const { adapter, queue } = makeAdapter()
    queue.push({ text: '第一次', stopReason: 'end_turn' })
    queue.push({ text: '第二次', stopReason: 'end_turn' })

    let resolveCalls = 0
    const registry = new ManagerRegistry(
      baseRegistryDeps({
        adapter: () => {
          resolveCalls++
          return adapter
        },
      })
    )

    expect(resolveCalls).toBe(0) // getOrCreate 本身不触发解析
    await registry.routeHumanMessages('wechat', 'sess-hot', [makeChannelMessage('你好')])
    expect(resolveCalls).toBe(1) // 第一个 episode 解析一次

    await registry.routeHumanMessages('wechat', 'sess-hot', [makeChannelMessage('再说一次')])
    expect(resolveCalls).toBe(2) // 同一 key 复用同一 ManagerLoop 实例，下一个 episode 重新解析一次
  })

  it('getOrCreate: isSystemThread 按 key 是否等于保留名判定（体现在 system prompt 的系统线程纪律段）', async () => {
    const { adapter, queue, calls } = makeAdapter()
    queue.push({ text: '系统线程回复', stopReason: 'end_turn' })
    queue.push({ text: '普通线程回复', stopReason: 'end_turn' })
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))

    await registry.routeSchedule({ scheduleId: 'sc', title: 't', description: 'd' }) // 无 targetSession → 落系统线程
    await registry.routeHumanMessages('wechat', 'sess-normal', [makeChannelMessage('hi')])

    expect(calls[0].systemPrompt).toContain('系统线程纪律')
    expect(calls[2].systemPrompt).not.toContain('系统线程纪律')
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

  it('human wake 持久化进 Manager history 后通知调用方', async () => {
    const { adapter, calls } = makeAdapter()
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))
    const message = makeChannelMessage('你好')
    let committedId: string | undefined
    let committedState = ''
    let resolveCommitted!: () => void
    const committed = new Promise<void>((resolve) => { resolveCommitted = resolve })

    const routed = registry.routeHumanMessages(
      'wechat',
      'sess-accepted',
      [message],
      undefined,
      undefined,
      async (lastCommittedMessageId) => {
        committedId = lastCommittedMessageId
        committedState = JSON.stringify(await store.load('wechat::sess-accepted' as ManagerKey))
        resolveCommitted()
      },
    )

    await committed
    expect(committedId).toBe(message.platform_message_id)
    expect(committedState).toContain('你好')
    await routed
    expect(calls.length).toBeGreaterThan(0)
  })

  it('human wake 在 Manager 接受前被拒绝时不通知调用方', async () => {
    const { adapter } = makeAdapter()
    const registry = new ManagerRegistry(baseRegistryDeps({
      adapter,
      beforeWake: async () => { throw new Error('agent is closing') },
    }))
    let accepted = false

    await expect(registry.routeHumanMessages(
      'wechat',
      'sess-rejected',
      [makeChannelMessage('你好')],
      undefined,
      undefined,
      async () => { accepted = true },
    )).rejects.toThrow('agent is closing')

    expect(accepted).toBe(false)
  })

  // --- routeAttentionFlush(P7 J Task 3.2:群聊注意力放行的公开入口) ---

  describe('routeAttentionFlush', () => {
    function groupMessage(text: string): ChannelMessage {
      const m = makeChannelMessage(text)
      return { ...m, session: { ...m.session, session_id: 'grp-1', type: 'group' } }
    }

    const FRIEND_G: Friend = {
      id: 'f-g',
      name: '群里的人',
      permission: 'friend',
      channel_identities: [{ channel_id: 'wechat', platform_user_id: 'u1' }],
    } as Friend

    it('打到 `${channelId}::${sessionId}` 对应的 manager,消息进入该 manager 的历史', async () => {
      const { adapter, queue } = makeAdapter()
      queue.push({ text: '收到', stopReason: 'end_turn' })
      const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))

      const result = await registry.routeAttentionFlush('wechat', 'grp-1', [groupMessage('攒了一会儿的话')])

      expect(result.outcome).toBe('completed')
      const state = await store.load('wechat::grp-1' as ManagerKey)
      expect(JSON.stringify(state.recent)).toContain('攒了一会儿的话')
    })

    it('两个 kind 的渲染文案不同:attention_flush 明确告诉 LLM 这批话是"放行期间累积的",不能与即时消息混用', async () => {
      const { adapter, queue, calls } = makeAdapter()
      queue.push({ text: 'ok', stopReason: 'end_turn' })
      queue.push({ text: 'ok', stopReason: 'end_turn' })
      const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))

      await registry.routeAttentionFlush('wechat', 'grp-flush', [groupMessage('补齐的这批')])
      await registry.routeHumanMessages('wechat', 'grp-live', [groupMessage('刚说的这句')])

      const flushPrompt = JSON.stringify(calls[0].messages)
      const livePrompt = JSON.stringify(calls[2].messages)

      expect(flushPrompt).toContain('[补齐:群聊注意力放行期间累积的人类消息]')
      expect(flushPrompt).not.toContain('[人类消息]')
      expect(livePrompt).toContain('[人类消息]')
      expect(livePrompt).not.toContain('[补齐:群聊注意力放行期间累积的人类消息]')
    })

    it('friend 在两个 kind 上都通到唤醒边界与工具面:onHumanWake 收到发起人、toolFace 拿到同一个 humanPrincipal', async () => {
      const { adapter, queue } = makeAdapter()
      queue.push({ text: 'ok', stopReason: 'end_turn' })
      queue.push({ text: 'ok', stopReason: 'end_turn' })

      const wakeCalls: Array<{ key: string; friendId?: string; sessionType: string }> = []
      const toolFaceCalls: Array<{ friendId?: string; sessionType?: string }> = []
      const registry = new ManagerRegistry(
        baseRegistryDeps({
          adapter,
          onHumanWake: async (key, principal) => {
            wakeCalls.push({ key, friendId: principal.friend?.id, sessionType: principal.sessionType })
          },
          toolFace: (_k, _s, _sched, humanPrincipal) => {
            toolFaceCalls.push({ friendId: humanPrincipal?.friend?.id, sessionType: humanPrincipal?.sessionType })
            return []
          },
        })
      )

      await registry.routeAttentionFlush('wechat', 'grp-1', [groupMessage('放行后补齐')], FRIEND_G)
      await registry.routeHumanMessages('wechat', 'grp-1', [groupMessage('即时消息')], FRIEND_G)

      // ① 唤醒边界:两条路都解析了发起人身份(漏了 = 群聊放行路径的权限/记忆档位退回未解析)
      expect(wakeCalls).toEqual([
        { key: 'wechat::grp-1', friendId: 'f-g', sessionType: 'group' },
        { key: 'wechat::grp-1', friendId: 'f-g', sessionType: 'group' },
      ])
      // ② 工具面:两条路的 episode 都拿到了发起人身份(漏了 = 派出去的 worker 记不到 creator)
      expect(toolFaceCalls.length).toBeGreaterThanOrEqual(2)
      for (const call of toolFaceCalls) {
        expect(call).toEqual({ friendId: 'f-g', sessionType: 'group' })
      }
    })

    it('不传 friend 时不阻断:仍然唤醒、仍然投递,只是身份为空', async () => {
      const { adapter, queue } = makeAdapter()
      queue.push({ text: 'ok', stopReason: 'end_turn' })
      const toolFaceCalls: Array<{ friendId?: string; sessionType?: string }> = []
      const registry = new ManagerRegistry(
        baseRegistryDeps({
          adapter,
          toolFace: (_k, _s, _sched, humanPrincipal) => {
            toolFaceCalls.push({ friendId: humanPrincipal?.friend?.id, sessionType: humanPrincipal?.sessionType })
            return []
          },
        })
      )

      const result = await registry.routeAttentionFlush('wechat', 'grp-anon', [groupMessage('陌生人说话')])

      expect(result.outcome).toBe('completed')
      expect(toolFaceCalls[0]).toEqual({ friendId: undefined, sessionType: 'group' })
    })
  })

  // --- routeWorkerEvent ---

  it('routeWorkerEvent: 经台账 origin.spawned_by_episode 找到监护 manager', async () => {
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

  it('routeWorkerEvent: 把稳定 task_id 与 trigger_type 写入 Manager 实际收到的事件', async () => {
    const { adapter, queue, calls } = makeAdapter()
    queue.push({ text: '记录完成事件', stopReason: 'end_turn' })
    const owningKey = 'wechat::memory-owner' as ManagerKey
    const baseWorker = makeLedgerWorker('w-memory', owningKey)
    const worker = { ...baseWorker, task: { ...baseWorker.task, id: 'task-memory' } }
    const registry = new ManagerRegistry(baseRegistryDeps({
      adapter,
      ledger: fakeLedger({ 'w-memory': worker }),
    }))

    await registry.routeWorkerEvent({
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'state_changed',
      worker_id: 'w-memory',
      seq: 7,
      task_status: 'completed',
      detail: { to: 'exited', summary: '明确结论' },
    })

    const rendered = calls[0].messages.map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    ).join('\n')
    expect(rendered).toContain('"trigger_type":"message"')
    expect(rendered).toContain('"task_id":"task-memory"')
    expect(rendered).toContain('"outcome":"completed"')
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

  it('routeSupervisionDue: 已被 clear 或替换的 due 不创建 Manager episode', async () => {
    const { adapter, calls } = makeAdapter()
    const isCurrent = vi.fn(async () => false)
    const registry = new ManagerRegistry(baseRegistryDeps({
      adapter,
      harness: { ...FAKE_HARNESS, isSupervisionDueCurrent: isCurrent } as unknown as WorkerHarness,
    }))
    const event: HarnessEvent = {
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'supervision_due',
      worker_id: 'w-stale',
      seq: 1,
      detail: { mode: 'periodic_report', due_id: 'old-due', mainline_seq: 1, observation: 'none' },
    }

    await expect(registry.routeSupervisionDue(event)).resolves.toBeUndefined()
    expect(isCurrent).toHaveBeenCalledWith(event)
    expect(calls).toHaveLength(0)
  })

  it('routeSupervisionDue: 路由准备期间 due 被 clear 后不创建 Manager episode', async () => {
    const { adapter, calls } = makeAdapter()
    const routePreparationEntered = deferred()
    const releaseRoutePreparation = deferred()
    const owner = 'wechat::periodic-owner' as ManagerKey
    let current = true
    const isCurrent = vi.fn(async () => current)
    const findWorker = vi.fn(async () => {
      routePreparationEntered.resolve()
      await releaseRoutePreparation.promise
      return { managerKey: owner, worker: makeLedgerWorker('w-periodic', owner) }
    })
    const registry = new ManagerRegistry(baseRegistryDeps({
      adapter,
      ledger: { findWorker } as unknown as LedgerStore,
      harness: { ...FAKE_HARNESS, isSupervisionDueCurrent: isCurrent } as unknown as WorkerHarness,
    }))
    const event: HarnessEvent = {
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'supervision_due',
      worker_id: 'w-periodic',
      seq: 1,
      detail: { mode: 'periodic_report', due_id: 'cleared-due', mainline_seq: 1, observation: 'none' },
    }

    const routed = registry.routeSupervisionDue(event)
    await routePreparationEntered.promise
    current = false
    releaseRoutePreparation.resolve()

    await expect(routed).resolves.toBeUndefined()
    expect(isCurrent).toHaveBeenCalledTimes(2)
    expect(isCurrent).toHaveBeenNthCalledWith(1, event)
    expect(isCurrent).toHaveBeenNthCalledWith(2, event)
    expect(calls).toHaveLength(0)
  })

  it('routeSupervisionDue: pre-wake 异步刷新期间 due 被 clear 后不创建 Manager episode', async () => {
    const { adapter, calls } = makeAdapter()
    const beforeWakeEntered = deferred()
    const releaseBeforeWake = deferred()
    const owner = 'wechat::periodic-owner' as ManagerKey
    let current = true
    const isCurrent = vi.fn(async () => current)
    const registry = new ManagerRegistry(baseRegistryDeps({
      adapter,
      ledger: fakeLedger({ 'w-periodic': makeLedgerWorker('w-periodic', owner) }),
      harness: { ...FAKE_HARNESS, isSupervisionDueCurrent: isCurrent } as unknown as WorkerHarness,
      beforeWake: async () => {
        beforeWakeEntered.resolve()
        await releaseBeforeWake.promise
      },
    }))
    const event: HarnessEvent = {
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'supervision_due',
      worker_id: 'w-periodic',
      seq: 1,
      detail: { mode: 'periodic_report', due_id: 'cleared-at-admission', mainline_seq: 1, observation: 'none' },
    }

    const routed = registry.routeSupervisionDue(event)
    await beforeWakeEntered.promise
    current = false
    releaseBeforeWake.resolve()

    await expect(routed).resolves.toBeUndefined()
    expect(isCurrent).toHaveBeenCalledTimes(3)
    expect(calls).toHaveLength(0)
  })

  it('routeSupervisionDue: owning Manager 正执行时保留 due，不伪造已消费结果', async () => {
    const calls: LLMStreamParams[] = []
    const entered = deferred()
    const release = deferred()
    let turn = 0
    const adapter: LLMAdapter = {
      async *stream(params) {
        calls.push({ ...params, messages: [...params.messages] })
        if (isAssistantTextEndTurnReminder(params)) {
          yield* chunksFromContent([], 'end_turn', { inputTokens: 1, outputTokens: 1 })
          return
        }
        turn++
        if (turn === 1) {
          entered.resolve()
          await release.promise
        }
        yield* chunksFromContent([{ type: 'text', text: '当前 episode 完成' }], 'end_turn', { inputTokens: 1, outputTokens: 1 })
      },
      updateConfig: () => {},
    }
    const owner = 'wechat::periodic-owner' as ManagerKey
    const event: HarnessEvent = {
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'supervision_due',
      worker_id: 'w-periodic',
      seq: 1,
      detail: { mode: 'periodic_report', due_id: 'due-active', mainline_seq: 1, observation: 'none' },
    }
    const isCurrent = vi.fn(async () => true)
    const registry = new ManagerRegistry(baseRegistryDeps({
      adapter,
      ledger: fakeLedger({ 'w-periodic': makeLedgerWorker('w-periodic', owner) }),
      harness: { ...FAKE_HARNESS, isSupervisionDueCurrent: isCurrent } as unknown as WorkerHarness,
    }))

    const active = registry.routeHumanMessages('wechat', 'periodic-owner', [makeChannelMessage('先完成这一轮')])
    await entered.promise
    await expect(registry.routeSupervisionDue(event)).resolves.toBeUndefined()
    expect(isCurrent).toHaveBeenCalledWith(event)
    expect(calls).toHaveLength(1)

    release.resolve()
    await active
    for (const call of calls) {
      expect(JSON.stringify(call.messages)).not.toContain('due-active')
    }
  })

  it('operation notification 在 owning Manager 正执行时进入当前 mailbox，下一轮 LLM 批量读取', async () => {
    const calls: LLMStreamParams[] = []
    const entered = deferred()
    const release = deferred()
    let turn = 0
    const adapter: LLMAdapter = {
      async *stream(params) {
        calls.push({ ...params, messages: [...params.messages] })
        if (isAssistantTextEndTurnReminder(params)) {
          yield* chunksFromContent([], 'end_turn', { inputTokens: 1, outputTokens: 1 })
          return
        }
        turn++
        if (turn === 1) {
          entered.resolve()
          await release.promise
        }
        yield* chunksFromContent([{ type: 'text', text: 'ok' }], 'end_turn', { inputTokens: 1, outputTokens: 1 })
      },
      updateConfig: () => {},
    }
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))
    const key = 'wechat::operation-owner' as ManagerKey
    const event: HarnessEvent = {
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'input_delivery_failed',
      worker_id: 'w-operation',
      seq: 1,
      detail: { delivery_id: 'delivery-1' },
    }
    const secondEvent: HarnessEvent = {
      ...event,
      detail: { delivery_id: 'delivery-2', reason_code: 'input_surface_timeout' },
    }

    const active = registry.routeHumanMessages('wechat', 'operation-owner', [makeChannelMessage('先处理这条')])
    await entered.promise
    await expect(registry.routeOperationNotification(key, event)).resolves.toEqual({ consumed: true })
    await expect(registry.routeOperationNotification(key, secondEvent)).resolves.toEqual({ consumed: true })
    expect(calls).toHaveLength(1)

    release.resolve()
    await active
    expect(calls.length).toBeGreaterThan(1)
    expect(JSON.stringify(calls[1].messages)).toContain('delivery-1')
    expect(JSON.stringify(calls[1].messages)).toContain('delivery-2')
  })

  it('activity notification 在活跃 episode 中只注册 receipt，下一次 LLM 输入才确认', async () => {
    const calls: LLMStreamParams[] = []
    const entered = deferred()
    const release = deferred()
    let turn = 0
    const adapter: LLMAdapter = {
      async *stream(params) {
        calls.push({ ...params, messages: [...params.messages] })
        turn += 1
        if (turn === 1) {
          entered.resolve()
          await release.promise
        }
        yield* chunksFromContent([], 'end_turn', { inputTokens: 1, outputTokens: 1 })
      },
      updateConfig: () => {},
    }
    const admit = vi.fn(async () => undefined)
    const reject = vi.fn(async () => undefined)
    const receipt: ActivityContextAdmissionReceipt = {
      notification_id: 'activity-notification-1',
      activity_through: 'opaque-through',
      admit,
      reject,
    }
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))
    const key = 'wechat::activity-owner' as ManagerKey
    const event: HarnessEvent = {
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'activity_available',
      worker_id: 'w-activity',
      seq: 1,
      detail: {
        from_cursor: 'opaque-from',
        through_cursor: 'opaque-through',
        preview: 'automatic compaction failed',
        has_error: true,
      },
    }

    const active = registry.routeHumanMessages('wechat', 'activity-owner', [makeChannelMessage('先处理这条')])
    await entered.promise
    await expect(registry.routeOperationNotification(key, event, receipt)).resolves.toEqual({
      consumed: false,
      registered: true,
    })
    expect(admit).not.toHaveBeenCalled()
    expect(reject).not.toHaveBeenCalled()

    release.resolve()
    await active

    expect(admit).toHaveBeenCalledOnce()
    expect(reject).not.toHaveBeenCalled()
    expect(calls.some((call) => JSON.stringify(call.messages).includes('activity_available'))).toBe(true)
  })

  it('failed episode 收口期间到达的 activity 会在最后一个活跃 episode 退出时 reject', async () => {
    const firstRejectEntered = deferred()
    const releaseFirstReject = deferred()
    const firstReject = vi.fn(async () => {
      firstRejectEntered.resolve()
      await releaseFirstReject.promise
    })
    const secondReject = vi.fn(async () => undefined)
    const registry = new ManagerRegistry(baseRegistryDeps({
      adapter: () => { throw new Error('manager model unavailable') },
    }))
    const key = 'wechat::activity-failure-race' as ManagerKey
    const event = (workerId: string, through: string): HarnessEvent => ({
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'activity_available',
      worker_id: workerId,
      seq: 1,
      detail: {
        incarnation_id: `inc-${workerId}`,
        from_cursor: `from-${through}`,
        through_cursor: through,
        preview: 'worker error',
        has_error: true,
      },
    })
    const receipt = (
      notificationId: string,
      through: string,
      reject: () => Promise<void>,
    ): ActivityContextAdmissionReceipt => ({
      notification_id: notificationId,
      activity_through: through,
      admit: vi.fn(async () => undefined),
      reject,
    })

    await expect(registry.routeOperationNotification(
      key,
      event('w-first', 'through-first'),
      receipt('notification-first', 'through-first', firstReject),
    )).resolves.toEqual({ consumed: false, registered: true })
    await firstRejectEntered.promise

    await expect(registry.routeOperationNotification(
      key,
      event('w-second', 'through-second'),
      receipt('notification-second', 'through-second', secondReject),
    )).resolves.toEqual({ consumed: false, registered: true })
    releaseFirstReject.resolve()

    await vi.waitFor(() => expect(secondReject).toHaveBeenCalledOnce())
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

  it('routeSchedule 将 taskType 作为未渲染 metadata 传给本次工具面', async () => {
    const { adapter, queue } = makeAdapter()
    queue.push({ text: '已处理', stopReason: 'end_turn' })
    const identities: Array<{ taskType?: string; isBuiltin?: boolean } | undefined> = []
    const registry = new ManagerRegistry(baseRegistryDeps({
      adapter,
      toolFace: (_key, _isSystemThread, scheduleIdentity) => {
        identities.push(scheduleIdentity)
        return []
      },
    }))

    await registry.routeSchedule({
      scheduleId: 'daily',
      title: '每日反思',
      description: 'reflect',
      taskType: 'daily_reflection',
      isBuiltin: true,
    })

    expect(identities.length).toBeGreaterThan(0)
    for (const identity of identities) {
      expect(identity).toMatchObject({ taskType: 'daily_reflection', isBuiltin: true })
    }
  })

  it('异步身份、worker 查找和 schedule 解析等待期间不改写入口时间', async () => {
    const { adapter, queue, calls } = makeAdapter()
    queue.push(
      { text: 'human ok', stopReason: 'end_turn' },
      { text: 'worker ok', stopReason: 'end_turn' },
      { text: 'schedule ok', stopReason: 'end_turn' },
    )
    let nowMs = Date.parse('2026-08-10T01:00:00.000Z')
    const humanEntered = deferred()
    const humanRelease = deferred()
    const workerEntered = deferred()
    const workerRelease = deferred()
    const scheduleEntered = deferred()
    const scheduleRelease = deferred()
    const owner = 'wechat::timed-owner' as ManagerKey
    const worker = makeLedgerWorker('w-timed', owner)
    const registry = new ManagerRegistry(baseRegistryDeps({
      adapter,
      now: () => new Date(nowMs),
      timezone: () => 'Asia/Shanghai',
      onHumanWake: async () => {
        humanEntered.resolve()
        await humanRelease.promise
      },
      ledger: {
        findWorker: async () => {
          workerEntered.resolve()
          await workerRelease.promise
          return { managerKey: owner, worker }
        },
      } as unknown as LedgerStore,
      onScheduleWake: async () => {
        scheduleEntered.resolve()
        await scheduleRelease.promise
      },
    }))

    const human = registry.routeHumanMessages('wechat', 'timed-human', [makeChannelMessage('human')])
    await humanEntered.promise
    nowMs = Date.parse('2026-08-10T01:01:00.000Z')
    humanRelease.resolve()
    await human
    expect(JSON.stringify(calls[0].messages)).toContain('received_at=\\"2026-08-10T09:00:00+08:00\\"')

    const workerWake = registry.routeWorkerEvent({
      ts: '2026-08-10T00:59:30.000Z',
      kind: 'state_changed',
      worker_id: 'w-timed',
      seq: 2,
    })
    await workerEntered.promise
    nowMs = Date.parse('2026-08-10T01:02:00.000Z')
    workerRelease.resolve()
    await workerWake
    const workerMessages = JSON.stringify(calls[2].messages)
    expect(workerMessages).toContain('received_at=\\"2026-08-10T09:01:00+08:00\\"')
    expect(workerMessages).toContain('occurred_at=\\"2026-08-10T00:59:30.000Z\\"')

    const schedule = registry.routeSchedule({ scheduleId: 'timed', title: 't', description: 'd' })
    await scheduleEntered.promise
    nowMs = Date.parse('2026-08-10T01:03:00.000Z')
    scheduleRelease.resolve()
    await schedule
    const scheduleMessages = JSON.stringify(calls[4].messages)
    expect(scheduleMessages).toContain('received_at=\\"2026-08-10T09:02:00+08:00\\"')
    expect(scheduleMessages).not.toContain('occurred_at=')
  })

  it('同一 ManagerKey episode 运行中到达的后到人类消息注入当前 episode,并保留各自入口时间', async () => {
    const calls: LLMStreamParams[] = []
    const firstTurnEntered = deferred()
    const releaseFirstTurn = deferred()
    let turn = 0
    const adapter: LLMAdapter = {
      async *stream(params) {
        calls.push({ ...params, messages: [...params.messages] })
        if (isAssistantTextEndTurnReminder(params)) {
          yield* chunksFromContent([], 'end_turn', { inputTokens: 10, outputTokens: 5 })
          return
        }
        turn++
        if (turn === 1) {
          firstTurnEntered.resolve()
          await releaseFirstTurn.promise
        }
        yield* chunksFromContent([{ type: 'text', text: 'ok' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
      },
      updateConfig: () => {},
    }
    let nowMs = Date.parse('2026-08-10T02:00:00.000Z')
    const registry = new ManagerRegistry(baseRegistryDeps({
      adapter,
      now: () => new Date(nowMs),
      timezone: () => 'Asia/Shanghai',
    }))

    const first = registry.routeHumanMessages('wechat', 'same-key', [makeChannelMessage('first')])
    await firstTurnEntered.promise
    nowMs = Date.parse('2026-08-10T02:00:30.000Z')
    // episode 在跑:后到消息注入当前 episode(turn 间隙),不再排队等独立 episode
    const second = await registry.routeHumanMessages('wechat', 'same-key', [makeChannelMessage('second')])
    expect(second).toMatchObject({ outcome: 'completed', episodeId: '' })
    nowMs = Date.parse('2026-08-10T02:05:00.000Z')
    releaseFirstTurn.resolve()
    await first

    // turn1 只见 first;turn2(注入后)见 second,且后到消息的入口时间原样保留
    expect(JSON.stringify(calls[0].messages)).toContain('received_at=\\"2026-08-10T10:00:00+08:00\\"')
    expect(JSON.stringify(calls[1].messages)).toContain('received_at=\\"2026-08-10T10:00:30+08:00\\"')
    expect(JSON.stringify(calls[1].messages)).toContain('second')
  })

  it('routeHumanMessages 注入在跑 episode 时 onEpisodeSettled 以真实收尾 result 触发(含失败),占位 result 不带真实值', async () => {
    const firstTurnEntered = deferred()
    const releaseFirstTurn = deferred()
    let turn = 0
    const adapter: LLMAdapter = {
      async *stream(params) {
        if (isAssistantTextEndTurnReminder(params)) {
          yield* chunksFromContent([], 'end_turn', { inputTokens: 10, outputTokens: 5 })
          return
        }
        turn++
        if (turn === 1) {
          firstTurnEntered.resolve()
          await releaseFirstTurn.promise
          yield* chunksFromContent([{ type: 'text', text: 'ok' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
          return
        }
        throw new Error('llm down')
      },
      updateConfig: () => {},
    }
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))

    const first = registry.routeHumanMessages('wechat', 'settle-key', [makeChannelMessage('first')])
    await firstTurnEntered.promise

    const settlements: EpisodeResult[] = []
    const second = await registry.routeHumanMessages(
      'wechat',
      'settle-key',
      [makeChannelMessage('second')],
      undefined,
      undefined,
      undefined,
      (settled) => { settlements.push(settled) },
    )
    // 占位:outcome 是编造的 completed,不带真实 episodeId
    expect(second).toMatchObject({ outcome: 'completed', episodeId: '' })
    expect(settlements).toHaveLength(0)

    releaseFirstTurn.resolve()
    const firstResult = await first
    // turn2 抛错 → episode failed;注入消息的 settle 回调以真实 result 触发,
    // 调用方(processDirectBatch/processAdminChatMessage)据此补发 fail-loud
    expect(firstResult.outcome).toBe('failed')
    expect(settlements).toHaveLength(1)
    expect(settlements[0].outcome).toBe('failed')
    expect(settlements[0].episodeId).not.toBe('')
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

  it('evictIdle: 同 key 两个并发 wakeUp 重叠在途——第一个 resolve 但第二个仍在 ManagerLoop 内跑时不得回收（activeEpisodes 必须是引用计数，不是布尔/Set 的有无标记）', async () => {
    const key = 'wechat::sess-concurrent' as ManagerKey
    let bEnteredResolve!: () => void
    const bEntered = new Promise<void>((resolve) => {
      bEnteredResolve = resolve
    })
    let releaseB!: () => void
    const bGate = new Promise<void>((resolve) => {
      releaseB = resolve
    })

    let callCount = 0
    // mutex 保证严格串行：第一次 adapter.stream 调用必然对应第一个唤醒（A），第二次对应
    // 第二个唤醒（B）——不依赖猜测的微任务计数，只依赖 ManagerLoop 内部 mutex 的既有语义。
    const adapter: LLMAdapter = {
      async *stream(params) {
        if (isAssistantTextEndTurnReminder(params)) {
          yield* chunksFromContent([], 'end_turn', { inputTokens: 10, outputTokens: 5 })
          return
        }
        callCount++
        if (callCount === 1) {
          yield* chunksFromContent([{ type: 'text', text: 'A 完成' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
          return
        }
        // B：先宣布"已经真正进入自己的 episode"，再卡住等测试放行——用真实 Promise 信号
        // 证明 B 在 A resolve 之后仍然处于"在跑"状态，不靠固定延时猜测时间窗口。
        bEnteredResolve()
        await bGate
        yield* chunksFromContent([{ type: 'text', text: 'B 完成' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
      },
      updateConfig: () => {},
    }

    const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))
    const loopBefore = registry.getOrCreate(key)

    // 同 key 连续发起两次唤醒、不等第一次完成——B 在 ManagerLoop 内部 mutex 上排队等 A。
    // routeHumanMessages 在 episode 运行中已改为 mailbox 注入并立即返回(不再排队),
    // 因此这里用 routeSchedule 触发两个真正排队的在途 episode,保留对 activeEpisodes
    // 引用计数的保护意图。
    // runWake 内部在第一个 await 之前就已经同步完成 activeEpisodes 计数 +1，
    // 因此这里不需要额外同步手段就能保证两次唤醒都已经"在途"。
    const pA = registry.routeSchedule({ scheduleId: 'concurrent-a', title: 'A', description: 'A', targetSession: { channel_id: 'wechat', session_id: 'sess-concurrent' } })
    const pB = registry.routeSchedule({ scheduleId: 'concurrent-b', title: 'B', description: 'B', targetSession: { channel_id: 'wechat', session_id: 'sess-concurrent' } })

    const resultA = await pA // A 的 episode 已经 resolve：引用计数应从 2 降到 1，而不是被误删到 0
    expect(resultA.outcome).toBe('completed')
    await bEntered // B 已经真正进入自己的 episode（轮到它拿到 mutex、adapter.stream 已被调用）

    // 复现点：A resolve 之后 B 仍在跑。旧实现（Set）在 A 的 finally 里无条件 delete(key)，
    // 会把 B 仍然占用的标记一起抹掉——evictIdle 会误判该 key 空闲并回收 this.loops 的引用，
    // 之后新事件经 getOrCreate 会新建一个持有独立 mutex 的 ManagerLoop，与仍在跑的 B 并发
    // 读写同一份 ManagerSessionStore 记录（split-brain）。
    const evictedWhileBRunning = registry.evictIdle(-1, Date.parse('2026-01-01T00:00:00.000Z'))
    expect(evictedWhileBRunning).toBe(0)
    expect(registry.getOrCreate(key)).toBe(loopBefore)

    releaseB()
    const resultB = await pB
    expect(resultB.outcome).toBe('completed')

    // 两个都结束后引用计数应归零——此时才真正允许回收。
    const evictedAfterBothDone = registry.evictIdle(-1, Date.parse('2026-01-01T00:00:00.000Z'))
    expect(evictedAfterBothDone).toBe(1)
  })

  // --- mailbox 停滞窗口 / 回收丢失窗口（P7 阻塞项 #5） ---

  it('shutdown 在异步唤醒准备期间开始时，不创建新的 Manager episode', async () => {
    const { adapter, calls } = makeAdapter()
    const entered = deferred()
    const release = deferred()
    let closing = false
    const registry = new ManagerRegistry(baseRegistryDeps({
      adapter,
      isClosing: () => closing,
      onScheduleWake: async () => {
        entered.resolve()
        await release.promise
      },
    }))

    const wake = registry.routeSchedule({ scheduleId: 'closing', title: 't', description: 'd' })
    await entered.promise
    closing = true
    release.resolve()

    await expect(wake).rejects.toThrow('AGENT_SHUTTING_DOWN')
    expect(calls).toHaveLength(0)
  })

  it('shutdown 开始后，episode 收口不再为残留 mailbox 自唤醒', async () => {
    const key = 'wechat::sess-closing-self-wake' as ManagerKey
    const { adapter, calls } = makeAdapter()
    let closing = false
    const registry = new ManagerRegistry(baseRegistryDeps({
      adapter,
      isClosing: () => closing,
    }))

    const origAppend = store.appendEpisodeLog.bind(store)
    vi.spyOn(store, 'appendEpisodeLog').mockImplementation(async (managerKey, episodeId, messages) => {
      await origAppend(managerKey, episodeId, messages)
      await registry.routeMediaNotification({
        channelId: 'wechat',
        sessionId: 'sess-closing-self-wake',
        text: 'late notification',
      })
      closing = true
    })

    await registry.routeHumanMessages('wechat', 'sess-closing-self-wake', [makeChannelMessage('开始')])
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(calls).toHaveLength(2)
    expect(registry.evictIdle(-1, Date.parse('2026-01-01T00:00:00.000Z'))).toBe(0)
    expect(registry.getOrCreate(key).hasPendingMailbox).toBe(true)
  })

  it('mailbox 停滞：注入落在 engine 最后一次 drain 之后（episode 仍在途）→ episode 收口时必须自唤醒把它处理掉，不得躺在 mailbox 无人问津', async () => {
    const key = 'wechat::sess-stall' as ManagerKey
    const { adapter, queue } = makeAdapter()
    queue.push({ text: '第一个 episode 收口', stopReason: 'end_turn' })
    queue.push({ text: '自唤醒 episode 的回复', stopReason: 'end_turn' })

    const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))

    // 复现窗口：query-loop 在 end_turn 收口前做**最后一次** drainPending（query-loop.ts:551），
    // 此后到达的注入没有任何消费者在等。这里用 store.appendEpisodeLog 作确定性锚点——它在
    // runEngine 已经返回之后、wakeUp 尚未 resolve 之前被调用（loop.ts runEpisodeBody），
    // 此刻 registry 仍把该 key 计为在途（activeEpisodes > 0），因此普通媒体通知走
    // enqueueDuringEpisode 分支。不靠定时器猜时间窗口。
    const origAppend = store.appendEpisodeLog.bind(store)
    let injected = false
    vi.spyOn(store, 'appendEpisodeLog').mockImplementation(async (k, episodeId, messages) => {
      await origAppend(k, episodeId, messages)
      if (!injected) {
        injected = true
        void registry.routeMediaNotification({
          channelId: 'wechat',
          sessionId: 'sess-stall',
          text: 'late notification',
        })
      }
    })

    await registry.routeHumanMessages('wechat', 'sess-stall', [makeChannelMessage('侧问一下 worker')])
    expect(injected).toBe(true)

    // 语义不变量（§4.1 至少一次投递）：这条注入必须最终被投递给 LLM 并落进持久历史，
    // 且只投递一次。旧实现里它永远停在 mailbox 里等一个不会到来的下次唤醒。
    await vi.waitFor(
      async () => {
        const state = await store.load(key)
        expect(JSON.stringify(state.recent)).toContain('late notification')
      },
      { timeout: 2000, interval: 10 }
    )
    const occurrences = (JSON.stringify((await store.load(key)).recent).match(/late notification/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('episode 失败后，已提交人类输入可随空 mailbox 一起回收，下一次从 history 继续', async () => {
    const key = 'wechat::sess-evict-loss' as ManagerKey
    let failNext = true
    const adapter: LLMAdapter = {
      async *stream() {
        if (failNext) throw new Error('boom: simulated non-retryable failure')
        yield* chunksFromContent([{ type: 'text', text: '收到' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
      },
      updateConfig: () => {},
    }
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z')
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter, now: () => new Date(nowMs) }))

    // episode 失败后，原输入已经在 durable history，不再依赖 ManagerLoop mailbox。
    const first = await registry.routeHumanMessages('wechat', 'sess-evict-loss', [makeChannelMessage('救命，这条不能丢')])
    expect(first.consumedEvents).toBe(false)
    const loopBefore = registry.getOrCreate(key)

    // 此时实例空闲且已超过 idleMs，可以安全回收。
    nowMs += 10 * 60 * 1000
    const evicted = registry.evictIdle(5 * 60 * 1000, nowMs)

    // 下次新 wake 从磁盘 history 同时看到旧输入与新输入。
    failNext = false
    const second = await registry.routeHumanMessages('wechat', 'sess-evict-loss', [makeChannelMessage('还在吗')])
    expect(second.consumedEvents).toBe(true)
    const serialized = JSON.stringify((await store.load(key)).recent)
    expect(serialized).toContain('救命，这条不能丢')
    expect(serialized).toContain('还在吗')

    expect(evicted).toBe(1)
    expect(registry.getOrCreate(key)).not.toBe(loopBefore)
  })

  it('自唤醒不覆盖失败路径：已提交人类输入失败后不得立即重开 episode', async () => {
    let streamCalls = 0
    const adapter: LLMAdapter = {
      async *stream() {
        streamCalls++
        if (streamCalls > 0) throw new Error('boom: LLM 持续故障') // 恒真;写成条件只为让它仍是合法 generator
        yield* chunksFromContent([{ type: 'text', text: '不可达' }], 'end_turn')
      },
      updateConfig: () => {},
    }
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))

    const result = await registry.routeHumanMessages('wechat', 'sess-no-hot-retry', [makeChannelMessage('你好')])
    expect(result.consumedEvents).toBe(false)

    // 给自唤醒足够的宏任务窗口去发生（如果它错误地覆盖了失败路径的话）。
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(streamCalls).toBe(1) // 只有那一次失败的 episode，没有自动重试

    expect(registry.evictIdle(-1, Date.parse('2026-01-01T00:00:00.000Z'))).toBe(1)
  })

  it('自唤醒有上限：每个 episode 都产生新残留时，连锁自唤醒最多 MAX_SELF_WAKE_CHAIN 次；到顶后残留不丢（不被回收 + 下次真实唤醒投递）', async () => {
    const key = 'wechat::sess-chain' as ManagerKey
    const { adapter, calls } = makeAdapter()

    const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))

    // 病态注入源：**每个** episode 收口后都再产生一条普通通知。没有上限的话这就是
    // 一条无限的 episode 链。
    let keepInjecting = true
    let injections = 0
    const origAppend = store.appendEpisodeLog.bind(store)
    vi.spyOn(store, 'appendEpisodeLog').mockImplementation(async (k, episodeId, messages) => {
      await origAppend(k, episodeId, messages)
      if (keepInjecting) {
        injections++
        void registry.routeMediaNotification({
          channelId: 'wechat',
          sessionId: 'sess-chain',
          text: `notification-${injections}`,
        })
      }
    })

    await registry.routeHumanMessages('wechat', 'sess-chain', [makeChannelMessage('开始')])

    // 1 次真实唤醒 + 至多 MAX_SELF_WAKE_CHAIN 次连锁自唤醒，然后必须停下。
    await vi.waitFor(() => expect(calls.length).toBe(2 * (1 + MAX_SELF_WAKE_CHAIN)), { timeout: 2000, interval: 10 })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(calls.length).toBe(2 * (1 + MAX_SELF_WAKE_CHAIN)) // 停住了，没有继续滚
    expect(injections).toBe(1 + MAX_SELF_WAKE_CHAIN)

    // 到顶时最后一条注入仍留在 mailbox：不丢、不被回收，由下一次真实唤醒顺带投递。
    const loopBefore = registry.getOrCreate(key)
    expect(registry.evictIdle(-1, Date.parse('2026-01-01T00:00:00.000Z'))).toBe(0)
    expect(registry.getOrCreate(key)).toBe(loopBefore)

    keepInjecting = false
    await registry.routeHumanMessages('wechat', 'sess-chain', [makeChannelMessage('还在吗')])
    const lastCall = calls[calls.length - 1]
    expect(JSON.stringify(lastCall.messages)).toContain(`notification-${1 + MAX_SELF_WAKE_CHAIN}`)
  })

  // --- media notification: 独立 manager 唤醒，不伪装 schedule/bg ---

  it('media notification: 空闲 manager 走独立 wake，事件文本不是 schedule 或 bg notification', async () => {
    const { adapter, queue } = makeAdapter()
    queue.push({ text: '媒体已处理', stopReason: 'end_turn' })
    const registry = new ManagerRegistry(baseRegistryDeps({ adapter }))
    const key = 'wechat::media-idle' as ManagerKey
    const loop = registry.getOrCreate(key)
    const wakeUpSpy = vi.spyOn(loop, 'wakeUp')

    await registry.routeMediaNotification({
      channelId: 'wechat',
      sessionId: 'media-idle',
      text: 'fm-1 ready',
      occurredAt: '2025-12-31T23:59:30.000Z',
    })

    expect(wakeUpSpy).toHaveBeenCalledWith(expect.objectContaining({
      wake: { kind: 'media_notification', text: 'fm-1 ready' },
      received_at: expect.any(String),
      timezone: expect.any(String),
      occurred_at: '2025-12-31T23:59:30.000Z',
    }))
    const state = await store.load(key)
    expect(JSON.stringify(state.recent)).toContain('[媒体下载完成]')
    expect(JSON.stringify(state.recent)).not.toContain('<bg-notification>')
    expect(JSON.stringify(state.recent)).not.toContain('[定时任务触发]')
  })

  it('media notification: episode 运行中只入 mailbox，不额外 route schedule/wake', async () => {
    const key = 'wechat::media-active' as ManagerKey
    let registry: ManagerRegistry
    let injected = false
    const adapter: LLMAdapter = {
      async *stream() {
        if (!injected) {
          injected = true
          await registry.routeMediaNotification({ channelId: 'wechat', sessionId: 'media-active', text: 'fm-2 ready' })
        }
        yield* chunksFromContent([{ type: 'text', text: '收到' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
      },
      updateConfig: () => {},
    }
    registry = new ManagerRegistry(baseRegistryDeps({ adapter }))
    const loop = registry.getOrCreate(key)
    const enqueueSpy = vi.spyOn(loop, 'enqueueDuringEpisode')
    const wakeUpSpy = vi.spyOn(loop, 'wakeUp')

    await registry.routeHumanMessages('wechat', 'media-active', [makeChannelMessage('开始')])

    expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({
      wake: { kind: 'media_notification', text: 'fm-2 ready' },
      received_at: expect.any(String),
      timezone: expect.any(String),
    }))
    expect(wakeUpSpy).toHaveBeenCalledTimes(1)
  })

  // --- query_worker 同步建立错误 ---

  it('真实工具面调用 query_worker 建立失败时，同一次调用返回结构化错误且不注入 synthetic wake', async () => {
    const key = 'wechat::sess-e2e-toolface' as ManagerKey
    const fakeHarness = {
      listWorkers: async (): Promise<LedgerWorker[]> => [],
      findWorker: async (): Promise<{ managerKey: ManagerKey; worker: LedgerWorker }> => ({
        managerKey: key,
        worker: {
          worker_id: 'w-codex-1', manager_key: key,
          task: { id: 'w-codex-1', title: 'codex', status: 'running', created_at: '2026-01-01T00:00:00.000Z' },
          origin: { trigger_type: 'message' }, report_to: { channel_id: 'wechat', session_id: 'sess-e2e-toolface' },
          incarnations: [], updated_at: '2026-01-01T00:00:00.000Z',
        },
      }),
      queryWorker: async (): Promise<never> => {
        throw new QueryEstablishmentError(
          'query-e2e',
          'fork_capability_unavailable',
          'codex does not support fork',
          'not_started',
        )
      },
    } as unknown as WorkerHarness

    let triggered = false
    let toolResult: Awaited<ReturnType<ToolDefinition['call']>> | undefined
    const adapter: LLMAdapter = {
      async *stream(params: LLMStreamParams) {
        if (!triggered) {
          triggered = true
          // 从真实 LLMStreamParams.tools 里取出 registry 装配出的 query_worker 工具本身
          // （而不是自己手搓一个），证明调用的是生产链路上真正会喂给 LLM 的那个工具定义。
          const queryWorkerTool = params.tools.find((t) => t.name === 'query_worker')
          expect(queryWorkerTool).toBeDefined()
          toolResult = await queryWorkerTool!.call(
            { worker_id: 'w-codex-1', question: '现在进展如何？' },
            {} as never,
          )
          expect(toolResult.isError).toBe(true)
        }
        yield* chunksFromContent([{ type: 'text', text: '收到' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
      },
      updateConfig: () => {},
    }

    const registry = new ManagerRegistry(
      baseRegistryDeps({
        adapter,
        harness: fakeHarness,
        toolFace: (k, isSystemThread) =>
          buildManagerToolFace({
            harness: fakeHarness,
            workerContext: () => ({
              managerKey: k,
              reportTo: { channel_id: 'wechat', session_id: 'sess-e2e-toolface' },
            }),
            messagingDeps: makeMessagingDeps(),
            memoryServer: makeMemoryServer(),
            callAdmin: async () => ({}),
            isSystemThread,
          }),
      })
    )
    const loop = registry.getOrCreate(key)
    const enqueueSpy = vi.spyOn(loop, 'enqueueDuringEpisode')

    const result = await registry.routeHumanMessages('wechat', 'sess-e2e-toolface', [makeChannelMessage('侧问一下 worker')])

    expect(result.outcome).toBe('completed')
    expect(toolResult).toMatchObject({ isError: true })
    expect(JSON.parse(toolResult!.output)).toEqual({
      query_id: 'query-e2e',
      reason_code: 'fork_capability_unavailable',
      reason: 'codex does not support fork',
      certainty: 'not_started',
    })
    expect(enqueueSpy).not.toHaveBeenCalled()
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

  it('shouldWakeOnHarnessEvent: 过滤 input_sent 与 legacy_imported，其余 kind 一律唤醒', () => {
    const base = { ts: '2026-01-01T00:00:00.000Z', worker_id: 'w-1', seq: 1 }
    expect(shouldWakeOnHarnessEvent({ ...base, kind: 'input_sent' })).toBe(false)
    expect(shouldWakeOnHarnessEvent({ ...base, kind: 'legacy_imported' })).toBe(false)

    const otherKinds: HarnessEventKind[] = [
      'lifecycle_changed',
      'state_changed',
      'exited',
      'interaction_required',
      'liveness_stall',
      'query_failed',
    ]
    for (const kind of otherKinds) {
      expect(shouldWakeOnHarnessEvent({ ...base, kind })).toBe(true)
    }
  })
})
