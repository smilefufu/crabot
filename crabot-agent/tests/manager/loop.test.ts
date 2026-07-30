import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ManagerLoop, type WakeEvent, type ManagerLoopDeps } from '../../src/manager/loop.js'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import type { CompactionPolicy } from '../../src/manager/compaction.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { ChannelMessage } from '../../src/types.js'
import { dialogObjectIdForPrivate } from '../../src/workers/harness/ledger-types.js'
import type { WorkerHarness } from '../../src/workers/harness/harness.js'
import type { LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import { createUserMessage } from '../../src/engine/index.js'
import type { LLMAdapter, LLMStreamParams, EngineMessage } from '../../src/engine/index.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

// --- Fixtures / helpers ---

const KEY: ManagerKey = 'wechat::sess-loop'
const DIALOG_OBJECT_ID = dialogObjectIdForPrivate('friend-loop')

/** compaction.ts foldIntoSummary 的 system prompt 常量特征串,用它区分"这是折叠 LLM 调用
 *  还是普通 engine turn 调用",不需要 vi.mock/vi.spyOn 侵入模块内部。 */
const FOLD_SYSTEM_PROMPT_MARKER = '对话历史压缩助手'

interface TurnScript {
  readonly text?: string
  readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly id: string; readonly input: Record<string, unknown> }>
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
}

function makeAdapter(): {
  readonly adapter: LLMAdapter
  readonly calls: LLMStreamParams[]
  readonly foldCalls: LLMStreamParams[]
  readonly queue: TurnScript[]
  readonly foldQueue: string[]
} {
  const calls: LLMStreamParams[] = []
  const foldCalls: LLMStreamParams[] = []
  const queue: TurnScript[] = []
  const foldQueue: string[] = []

  const adapter: LLMAdapter = {
    async *stream(params: LLMStreamParams) {
      // query-loop 内 messages 是同一个数组跨轮次原地 push——这里必须浅拷贝快照,
      // 否则事后读 calls[i].messages 会看到"未来轮次"的内容(引用同一底层数组)。
      const snapshot: LLMStreamParams = { ...params, messages: [...params.messages] }
      calls.push(snapshot)
      if (params.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER)) {
        foldCalls.push(snapshot)
        const text = foldQueue.shift() ?? '折叠后的摘要'
        yield* chunksFromContent([{ type: 'text', text }], 'end_turn')
        return
      }
      const r = queue.shift() ?? { text: '(默认回复)', stopReason: 'end_turn' as const }
      const content: unknown[] = []
      if (r.text) content.push({ type: 'text', text: r.text })
      for (const tc of r.toolCalls ?? []) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      yield* chunksFromContent(content, r.stopReason, { inputTokens: 10, outputTokens: 5 })
    },
    updateConfig: () => {},
  }

  return { adapter, calls, foldCalls, queue, foldQueue }
}

function makeChannelMessage(text: string): ChannelMessage {
  return {
    platform_message_id: `pm-${Math.random().toString(36).slice(2)}`,
    session: { session_id: 'sess-loop', channel_id: 'wechat', type: 'private' },
    sender: { platform_user_id: 'u1', platform_display_name: '测试用户' },
    content: { type: 'text', text },
    features: { is_mention_crab: false },
    platform_timestamp: new Date().toISOString(),
  }
}

/** 每条消息计 10 token,数量可控、无需真实分词(与 compaction.test.ts 的约定一致)。 */
const estimateTokens = (msgs: ReadonlyArray<EngineMessage>): number => msgs.length * 10

const FAKE_HARNESS = { listWorkers: async (): Promise<LedgerWorker[]> => [] } as unknown as WorkerHarness

function baseDeps(overrides: Partial<ManagerLoopDeps> & { readonly store: ManagerSessionStore; readonly adapter: LLMAdapter }): ManagerLoopDeps {
  let nowMs = Date.parse('2026-01-01T00:00:00.000Z')
  const policy: CompactionPolicy = { keepRecent: 3, cacheTtlMs: 1000, foldTokenThreshold: 1_000_000, hardCapTokens: 1_000_000 }
  return {
    key: KEY,
    isSystemThread: false,
    dialogObjectId: DIALOG_OBJECT_ID,
    policy,
    estimateTokens,
    model: 'test-model',
    toolFace: () => [],
    promptInputs: () => ({}),
    harness: FAKE_HARNESS,
    now: () => new Date(nowMs),
    ...overrides,
  }
}

describe('ManagerLoop', () => {
  let dataDir: string
  let store: ManagerSessionStore

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'manager-loop-'))
    store = new ManagerSessionStore(join(dataDir, 'manager-sessions'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('唤醒 → 跑一个 turn → 回睡的完整往返', async () => {
    const { adapter, queue } = makeAdapter()
    queue.push({ text: '收到,已了解情况', stopReason: 'end_turn' })

    const loop = new ManagerLoop(baseDeps({ store, adapter }))
    const event: WakeEvent = { kind: 'human_messages', messages: [makeChannelMessage('你好')] }

    const result = await loop.wakeUp(event)

    expect(result.outcome).toBe('completed')
    expect(result.consumedEvents).toBe(true)
    expect(result.turns).toBe(1)
    expect(typeof result.episodeId).toBe('string')

    const state = await store.load(KEY)
    expect(state.recent.length).toBe(2) // 渲染的事件 user msg + assistant 回复
    expect(JSON.stringify(state.recent)).toContain('你好')
    expect(state.lastActiveAt).toBeTruthy()
  })

  it('burst 内(未超 TTL)不压缩;跨 TTL 唤醒时折叠恰好一次', async () => {
    const { adapter, queue, foldCalls } = makeAdapter()
    // 3 次唤醒各消费一条脚本回复
    queue.push({ text: '回复1', stopReason: 'end_turn' })
    queue.push({ text: '回复2', stopReason: 'end_turn' })
    queue.push({ text: '回复3', stopReason: 'end_turn' })

    let nowMs = Date.parse('2026-01-01T00:00:00.000Z')
    const policy: CompactionPolicy = { keepRecent: 3, cacheTtlMs: 1000, foldTokenThreshold: 5, hardCapTokens: 1_000_000 }
    const loop = new ManagerLoop(baseDeps({ store, adapter, policy, now: () => new Date(nowMs) }))

    // wakeUp #1 @ t=0
    await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('msg1')] })
    expect(foldCalls.length).toBe(0)

    // wakeUp #2 @ t=100ms(远小于 TTL=1000ms)——burst,不压缩
    nowMs += 100
    await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('msg2')] })
    expect(foldCalls.length).toBe(0)

    // wakeUp #3 @ t=100+5000ms(远超 TTL),此时累计历史(4 条)已超 foldTokenThreshold
    nowMs += 5000
    await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('msg3')] })
    expect(foldCalls.length).toBe(1)

    const state = await store.load(KEY)
    expect(state.rollingSummary).toBeTruthy()
  })

  it('episode 失败(LLM 报错)时 consumedEvents===false,下次唤醒能重投同一事件', async () => {
    const { adapter, queue } = makeAdapter()
    // 第一次唤醒:LLM 直接抛出不可重试错误 → outcome='failed',不消费 queue。
    // 第二次唤醒(thrown 已置位)正常放行到底层 adapter,消费这里排的回复。
    queue.push({ text: '正常处理', stopReason: 'end_turn' })
    let thrown = false
    const adapterThatThrowsOnce: LLMAdapter = {
      async *stream(params) {
        if (!params.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER) && !thrown) {
          thrown = true
          throw new Error('boom: simulated non-retryable failure')
        }
        yield* adapter.stream(params)
      },
      updateConfig: () => {},
    }

    const loop = new ManagerLoop(baseDeps({ store, adapter: adapterThatThrowsOnce }))
    const event: WakeEvent = { kind: 'human_messages', messages: [makeChannelMessage('重要的话只能说一次')] }

    const first = await loop.wakeUp(event)
    expect(first.outcome).toBe('failed')
    expect(first.consumedEvents).toBe(false)

    // session 不应该把这次失败的内容当成"已处理"落盘
    const stateAfterFailure = await store.load(KEY)
    expect(stateAfterFailure.recent.length).toBe(0)

    // 下次唤醒(不同的新事件),原始失败事件应随邮箱一起重投,被 LLM 看到
    const second = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('新的话')] })
    expect(second.outcome).toBe('completed')
    expect(second.consumedEvents).toBe(true)

    const finalState = await store.load(KEY)
    const serialized = JSON.stringify(finalState.recent)
    expect(serialized).toContain('重要的话只能说一次') // 重投的原始事件
    expect(serialized).toContain('新的话') // 本次新事件
  })

  it('episode 失败:mid-episode 注入且已被 engine drain 消费的内容不丢失,下次唤醒仍被投递', async () => {
    const { adapter, queue } = makeAdapter()
    // turn1:调用工具(工具执行期间 enqueueDuringEpisode 注入一条新事件,强制进入第二轮)
    queue.push({ toolCalls: [{ name: 'noop_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' })

    let loop!: ManagerLoop
    let nonFoldCallCount = 0
    let turn2Messages: EngineMessage[] | undefined
    // turn2 起飞前 engine 已经把 mid-episode 注入的内容 drainPending() 进了 messages——
    // 这里先记录下 turn2 实际看到的 messages(证明"确实被消费过"),再让这次 LLM 调用抛错,
    // 模拟"消费之后才失败"这个组合场景(evidence:turn1 不抛错,turn2 抛错)。
    const throwOnTurn2: LLMAdapter = {
      async *stream(params) {
        if (params.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER)) {
          yield* adapter.stream(params)
          return
        }
        nonFoldCallCount++
        if (nonFoldCallCount === 2) {
          turn2Messages = [...params.messages]
          throw new Error('boom: simulated failure after drain')
        }
        yield* adapter.stream(params)
      },
      updateConfig: () => {},
    }

    const deps = baseDeps({
      store,
      adapter: throwOnTurn2,
      toolFace: () => [
        {
          name: 'noop_tool',
          description: 'noop',
          inputSchema: { type: 'object', properties: {} },
          isReadOnly: false,
          call: async () => {
            loop.enqueueDuringEpisode({ kind: 'schedule', scheduleId: 'sched-fail', title: '巡检', description: '失败前注入的事件' })
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    const first = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('开始任务')] })
    expect(first.outcome).toBe('failed')
    expect(first.consumedEvents).toBe(false)

    // 证明确实被消费过(不是"从未被消费"这种平凡情形):turn2 的请求里能看到注入内容
    expect(turn2Messages).toBeDefined()
    expect(JSON.stringify(turn2Messages)).toContain('sched-fail')

    // session 不应该把这次失败的内容当成"已处理"落盘
    const stateAfterFailure = await store.load(KEY)
    expect(stateAfterFailure.recent.length).toBe(0)

    // 下次唤醒(不同的新事件):mid-episode 注入的内容应随邮箱一起重投,被 LLM 看到并落盘
    queue.push({ text: '正常处理', stopReason: 'end_turn' })
    const second = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('新的话')] })
    expect(second.outcome).toBe('completed')
    expect(second.consumedEvents).toBe(true)

    const finalState = await store.load(KEY)
    const serialized = JSON.stringify(finalState.recent)
    expect(serialized).toContain('sched-fail')
    expect(serialized).toContain('失败前注入的事件')
    expect(serialized).toContain('新的话')
  })

  it('episode 成功:mid-episode 注入的内容已被消费进历史,下次唤醒不会重复投递', async () => {
    const { adapter, queue, calls } = makeAdapter()
    // turn1:调用工具(工具执行期间注入一条新事件,强制进入第二轮);turn2:正常结束
    queue.push({ toolCalls: [{ name: 'noop_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' })
    queue.push({ text: '已处理完毕', stopReason: 'end_turn' })
    queue.push({ text: '第二次唤醒的回复', stopReason: 'end_turn' })

    let loop!: ManagerLoop
    const deps = baseDeps({
      store,
      adapter,
      toolFace: () => [
        {
          name: 'noop_tool',
          description: 'noop',
          inputSchema: { type: 'object', properties: {} },
          isReadOnly: false,
          call: async () => {
            loop.enqueueDuringEpisode({ kind: 'schedule', scheduleId: 'sched-ok', title: '巡检', description: '成功路径注入' })
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    const first = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('开始任务')] })
    expect(first.outcome).toBe('completed')
    expect(first.consumedEvents).toBe(true)

    const second = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('新的话')] })
    expect(second.outcome).toBe('completed')

    // 第二次唤醒发给 LLM 的 messages 里,'sched-ok' 只应该出现一次(第一次 episode 成功时
    // 已经消费进 state.recent、作为历史的一部分带入;不应该被再重投一遍变成两次)。
    const nonFoldCalls = calls.filter((c) => !c.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER))
    const secondWakeCall = nonFoldCalls[nonFoldCalls.length - 1]
    const occurrences = (JSON.stringify(secondWakeCall.messages).match(/sched-ok/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('episode 进行中 enqueueDuringEpisode 的事件经 humanMessageQueue 在 turn 间隙注入,第二轮 LLM 可见', async () => {
    const { adapter, queue, calls } = makeAdapter()
    // turn1:调用一个工具(强制进入第二轮);turn2:正常结束
    queue.push({ toolCalls: [{ name: 'noop_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' })
    queue.push({ text: '已处理完毕', stopReason: 'end_turn' })

    let loop!: ManagerLoop
    const deps = baseDeps({
      store,
      adapter,
      toolFace: () => [
        {
          name: 'noop_tool',
          description: 'noop',
          inputSchema: { type: 'object', properties: {} },
          isReadOnly: false,
          call: async () => {
            // 模拟"episode 进行中收到新事件":在工具执行期间(turn1 与 turn2 之间)入队
            loop.enqueueDuringEpisode({ kind: 'schedule', scheduleId: 'sched-1', title: '巡检', description: '期间到达的新事件' })
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    const result = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('开始任务')] })

    expect(result.outcome).toBe('completed')
    expect(result.turns).toBe(2)

    const nonFoldCalls = calls.filter((c) => !c.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER))
    expect(nonFoldCalls.length).toBe(2)
    const turn2Messages = JSON.stringify(nonFoldCalls[1].messages)
    expect(turn2Messages).toContain('sched-1')
    expect(turn2Messages).toContain('期间到达的新事件')
    // turn1 请求里不应该已经看到它(证明确实是"turn 间隙"注入,不是从一开始就在 initialMessages 里)
    const turn1Messages = JSON.stringify(nonFoldCalls[0].messages)
    expect(turn1Messages).not.toContain('sched-1')
  })

  it('max_tokens(上下文超限)收场时强制折叠一次并重试一次,成功后 outcome=completed', async () => {
    const { adapter, queue, foldCalls } = makeAdapter()
    // 第一次尝试:静默 max_tokens(text='' + stopReason='max_tokens')
    queue.push({ stopReason: 'max_tokens' })
    // 强制折叠后的重试:正常结束
    queue.push({ text: '折叠后重试成功', stopReason: 'end_turn' })

    const policy: CompactionPolicy = { keepRecent: 2, cacheTtlMs: 1000, foldTokenThreshold: 1_000_000, hardCapTokens: 1_000_000 }
    const loop = new ManagerLoop(baseDeps({ store, adapter, policy }))

    // 预置 3 条历史,让 force_hot 的 slicing(history.length - keepRecent = 1)真正折掉点东西,
    // 而不是从空历史开始导致 forceHotFold 直接返回 'none'。
    const seedMessages: EngineMessage[] = [
      createUserMessage('旧消息1'),
      createUserMessage('旧消息2'),
      createUserMessage('旧消息3'),
    ]
    await store.save({ key: KEY, recent: seedMessages, foldedCount: 0 })

    const result = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('触发超限的一句话')] })

    expect(foldCalls.length).toBe(1) // 强制折叠恰好发生一次
    expect(result.outcome).toBe('completed')
    expect(result.turns).toBe(2) // 首次尝试 1 turn + 重试 1 turn
    expect(result.consumedEvents).toBe(true)

    const state = await store.load(KEY)
    expect(state.rollingSummary).toBeTruthy()
    expect(state.foldedCount).toBeGreaterThan(0)
  })

  it('session 永不 finalize:连续 5 次 wakeUp 后仍能正常继续工作', async () => {
    const { adapter, queue } = makeAdapter()
    for (let i = 0; i < 5; i++) queue.push({ text: `回复${i}`, stopReason: 'end_turn' })

    const loop = new ManagerLoop(baseDeps({ store, adapter }))

    for (let i = 0; i < 5; i++) {
      const result = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage(`第${i}轮消息`)] })
      expect(result.outcome).toBe('completed')
      expect(result.consumedEvents).toBe(true)
    }

    const state = await store.load(KEY)
    // ManagerSessionState 没有任何"终态"字段——不做断言即是断言;这里只确认状态仍可继续读写。
    expect(state.key).toBe(KEY)
    expect(state.recent.length).toBeGreaterThan(0)
  })
})
