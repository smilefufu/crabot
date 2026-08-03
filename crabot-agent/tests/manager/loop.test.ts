import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ManagerLoop, type WakeEvent, type ManagerLoopDeps } from '../../src/manager/loop.js'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import type { CompactionPolicy } from '../../src/manager/compaction.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { ChannelMessage, Friend } from '../../src/types.js'
import { dialogObjectIdForPrivate } from '../../src/workers/harness/ledger-types.js'
import type { WorkerHarness } from '../../src/workers/harness/harness.js'
import type { LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import { createUserMessage, defineTool } from '../../src/engine/index.js'
import type { LLMAdapter, LLMStreamParams, EngineMessage, ToolDefinition } from '../../src/engine/index.js'
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
  /** raw_reasoning 块(不算 text,验证 isContextOverflow 提取文本时不被它干扰)。 */
  readonly reasoning?: Record<string, unknown>
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
      if (r.reasoning) content.push({ type: 'raw_reasoning', data: r.reasoning })
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

/** adapter/model 的测试入参既接受字面量（绝大多数用例）也接受 thunk（专测热更语义的用例）。 */
function baseDeps(
  overrides: Partial<Omit<ManagerLoopDeps, 'adapter' | 'model'>> & {
    readonly store: ManagerSessionStore
    readonly adapter: LLMAdapter | (() => LLMAdapter)
    readonly model?: string | (() => string)
  }
): ManagerLoopDeps {
  let nowMs = Date.parse('2026-01-01T00:00:00.000Z')
  const policy: CompactionPolicy = { keepRecent: 3, cacheTtlMs: 1000, foldTokenThreshold: 1_000_000, hardCapTokens: 1_000_000 }
  const { adapter, model, ...rest } = overrides
  return {
    key: KEY,
    isSystemThread: false,
    dialogObjectId: () => DIALOG_OBJECT_ID,
    policy,
    estimateTokens,
    toolFace: () => [],
    promptInputs: () => ({}),
    harness: FAKE_HARNESS,
    now: () => new Date(nowMs),
    adapter: typeof adapter === 'function' ? adapter : () => adapter,
    model: typeof model === 'function' ? model : () => model ?? 'test-model',
    ...rest,
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

  it('model 热更于下一个 episode 生效:adapter/model 解析器每个 episode 只调用一次，不在 episode 内重复读取', async () => {
    const { adapter, queue } = makeAdapter()
    queue.push({ text: '回复1', stopReason: 'end_turn' })
    queue.push({ text: '回复2', stopReason: 'end_turn' })

    let adapterResolveCalls = 0
    let modelResolveCalls = 0
    const deps = baseDeps({
      store,
      adapter: () => {
        adapterResolveCalls++
        return adapter
      },
      model: () => {
        modelResolveCalls++
        return 'test-model'
      },
    })
    const loop = new ManagerLoop(deps)

    await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('第一条')] })
    expect(adapterResolveCalls).toBe(1)
    expect(modelResolveCalls).toBe(1)

    // 模拟"config 热更"发生在两次唤醒之间：deps.adapter/model 这两个 thunk 本身不变
    // （生产环境由调用方在 thunk 内部读取最新 admin config），但 loop 只应在 episode 边界
    // （每次 wakeUp）重新调用一次——同一 episode 内（包括其内部可能的重试）绝不重复调用。
    await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('第二条')] })
    expect(adapterResolveCalls).toBe(2)
    expect(modelResolveCalls).toBe(2)
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

  it('runEpisodeBody 直接 throw(不是内部按 outcome 判定的失败分支)时,已 drain 的邮箱内容不丢失,下次唤醒仍能拿到', async () => {
    const { adapter, queue } = makeAdapter()
    // turn1:调用工具(期间 enqueueDuringEpisode 注入内容);turn2 触发 max_tokens(上下文超限)
    // → 触发 force_hot 强制折叠 → 折叠 LLM 调用直接抛出不可重试错误(模拟 callNonStreaming
    // 重试耗尽后抛出),异常从 applyFold 直接冒出 runEpisodeBody,不经过内部 outcome 判定。
    queue.push({ toolCalls: [{ name: 'noop_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' })
    queue.push({ stopReason: 'max_tokens' })

    let loop!: ManagerLoop
    const throwOnFold: LLMAdapter = {
      async *stream(params) {
        if (params.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER)) {
          throw new Error('boom: fold llm exhausted retries')
        }
        yield* adapter.stream(params)
      },
      updateConfig: () => {},
    }

    const policy: CompactionPolicy = { keepRecent: 2, cacheTtlMs: 1000, foldTokenThreshold: 1_000_000, hardCapTokens: 1_000_000 }
    const deps = baseDeps({
      store,
      adapter: throwOnFold,
      policy,
      toolFace: () => [
        {
          name: 'noop_tool',
          description: 'noop',
          inputSchema: { type: 'object', properties: {} },
          isReadOnly: false,
          call: async () => {
            loop.enqueueDuringEpisode({ kind: 'schedule', scheduleId: 'sched-throw', title: '巡检', description: '直接抛错前注入的事件' })
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    // 预置 3 条历史,让 force_hot 真正折掉点东西(否则 forceHotFold 直接返回 none,走不到
    // foldIntoSummary,测不到这条抛错路径)。
    const seedMessages: EngineMessage[] = [
      createUserMessage('旧消息1'),
      createUserMessage('旧消息2'),
      createUserMessage('旧消息3'),
    ]
    await store.save({ key: KEY, recent: seedMessages, foldedCount: 0 })

    // 唤醒前先在邮箱里塞一条"上一次遗留"的内容(episode 未在跑,直接进 mailbox.pending,
    // 是本次唤醒 carriedTexts 的来源)
    loop.enqueueDuringEpisode({ kind: 'schedule', scheduleId: 'sched-carried', title: '巡检', description: '唤醒前已经在邮箱里的内容' })

    await expect(
      loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('触发超限并在折叠时抛错')] })
    ).rejects.toThrow('boom: fold llm exhausted retries')

    // 落盘不应发生(异常发生在 store.save 之前)
    const stateAfterThrow = await store.load(KEY)
    expect(stateAfterThrow.recent).toEqual(seedMessages)

    // 下次唤醒:carriedTexts(唤醒前邮箱里的内容)、eventText(本次唤醒事件)、
    // currentEpisodeInjected(mid-episode 注入)应该都被重投,一个不丢
    queue.push({ text: '正常处理', stopReason: 'end_turn' })
    const second = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('新的话')] })
    expect(second.outcome).toBe('completed')
    expect(second.consumedEvents).toBe(true)

    const finalState = await store.load(KEY)
    const serialized = JSON.stringify(finalState.recent)
    expect(serialized).toContain('sched-carried') // 唤醒前已在邮箱的内容(carriedTexts)
    expect(serialized).toContain('sched-throw') // mid-episode 注入(currentEpisodeInjected)
    expect(serialized).toContain('触发超限并在折叠时抛错') // 本次唤醒事件(eventText)
    expect(serialized).toContain('新的话') // 第二次唤醒的新事件
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

  it('max_tokens 但非静默(text 非空,只是被截断)——不误判为上下文超限,不触发强制折叠与重试', async () => {
    const { adapter, queue, calls, foldCalls } = makeAdapter()
    // 输出被 max output tokens 截断,但已经写出了实际文字——这与"上下文超限"无关。
    // query-loop.ts 的 isSilentText 只看 text 是否为空,不看 stopReason 是否是 max_tokens,
    // 这种情形走的是"有文字的 end_turn"分支,outcome='completed'、finalText 非空,
    // 末条 assistant 消息的 stopReason 仍留着 'max_tokens' 这个痕迹。isContextOverflow
    // 若只看 stopReason 会误判为超限,对已经正常收场的 episode 强制折叠 + 重试一遍,
    // 重复触发首次尝试里已执行的副作用(如已发送的 send_message、已拉起的 spawn_worker)。
    queue.push({ text: '这是一段被截断的长回复,但确实已经写出了实际内容', stopReason: 'max_tokens' })

    const policy: CompactionPolicy = { keepRecent: 2, cacheTtlMs: 1000, foldTokenThreshold: 1_000_000, hardCapTokens: 1_000_000 }
    const loop = new ManagerLoop(baseDeps({ store, adapter, policy }))

    // 预置 3 条历史(同上一个 max_tokens 用例),让 force_hot 若被误触发也真能折出东西——
    // 避免"误判但恰好 forceDecision=none 侥幸不重试"的假阳性掩盖 bug。
    const seedMessages: EngineMessage[] = [
      createUserMessage('旧消息1'),
      createUserMessage('旧消息2'),
      createUserMessage('旧消息3'),
    ]
    await store.save({ key: KEY, recent: seedMessages, foldedCount: 0 })

    const result = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('会被截断的长问题')] })

    expect(foldCalls.length).toBe(0) // 未触发强制折叠
    expect(calls.length).toBe(1) // 只跑了一次 runEngine,没有重试
    expect(result.outcome).toBe('completed')
    expect(result.turns).toBe(1)
    expect(result.consumedEvents).toBe(true)
  })

  it('max_tokens 且末条消息只有 raw_reasoning 块、text 为空——仍判定为静默超限,照常强制折叠重试', async () => {
    const { adapter, queue, foldCalls } = makeAdapter()
    // engine 的 isSilentText(query-loop.ts partitionResponseContent)只统计 text 块,
    // raw_reasoning 块不计入"是否有可见文字"。这里模拟"只有推理块、没有实际文字"+
    // max_tokens 的组合,确认 isContextOverflow 提取文本时同样只看 text 块,
    // 不会因为 content 数组非空(混了 reasoning 块)而误判为"非静默"从而漏掉真正的超限。
    queue.push({ reasoning: { summary: '在思考要不要超限' }, stopReason: 'max_tokens' })
    queue.push({ text: '折叠后重试成功', stopReason: 'end_turn' })

    const policy: CompactionPolicy = { keepRecent: 2, cacheTtlMs: 1000, foldTokenThreshold: 1_000_000, hardCapTokens: 1_000_000 }
    const loop = new ManagerLoop(baseDeps({ store, adapter, policy }))

    const seedMessages: EngineMessage[] = [
      createUserMessage('旧消息1'),
      createUserMessage('旧消息2'),
      createUserMessage('旧消息3'),
    ]
    await store.save({ key: KEY, recent: seedMessages, foldedCount: 0 })

    const result = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('触发超限的一句话(仅推理块)')] })

    expect(foldCalls.length).toBe(1) // 强制折叠恰好发生一次
    expect(result.outcome).toBe('completed')
    expect(result.turns).toBe(2) // 首次尝试 1 turn(max_tokens)+ 重试 1 turn
    expect(result.consumedEvents).toBe(true)
  })

  it('max_tokens 重试时 mid-episode 注入内容被追进 initialMessages,重试成功后不重复投递', async () => {
    const { adapter, queue, calls } = makeAdapter()
    // turn1:调用工具(期间 enqueueDuringEpisode 注入内容,被 drain 消费);turn2 触发 max_tokens
    queue.push({ toolCalls: [{ name: 'noop_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' })
    // 首次尝试的 turn2:静默 max_tokens(text='' + stopReason='max_tokens')
    queue.push({ stopReason: 'max_tokens' })
    // 强制折叠后的重试:正常结束
    queue.push({ text: '强制折叠并重试成功', stopReason: 'end_turn' })
    // 第二次唤醒:确认 mid-episode 内容不被重复投递
    queue.push({ text: '第二次唤醒回复', stopReason: 'end_turn' })

    let loop!: ManagerLoop
    const policy: CompactionPolicy = { keepRecent: 2, cacheTtlMs: 1000, foldTokenThreshold: 1_000_000, hardCapTokens: 1_000_000 }
    const deps = baseDeps({
      store,
      adapter,
      policy,
      toolFace: () => [
        {
          name: 'noop_tool',
          description: 'noop',
          inputSchema: { type: 'object', properties: {} },
          isReadOnly: false,
          call: async () => {
            // turn1 与 turn2 之间注入内容,保证被 turn2 的 drainPending() 消费
            loop.enqueueDuringEpisode({ kind: 'schedule', scheduleId: 'sched-max-tokens', title: '巡检', description: '首次尝试期间注入' })
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    // 预置 3 条历史(同 'max_tokens 收场' 测试),让 force_hot 真正折掉点东西
    const seedMessages: EngineMessage[] = [
      createUserMessage('旧消息1'),
      createUserMessage('旧消息2'),
      createUserMessage('旧消息3'),
    ]
    await store.save({ key: KEY, recent: seedMessages, foldedCount: 0 })

    // 首次唤醒:首次尝试 turn1 成功 + turn2 max_tokens → 强制折叠 + 重试成功
    const first = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('触发 max_tokens 的一句话')] })
    expect(first.outcome).toBe('completed')
    expect(first.turns).toBe(3) // turn1 + turn2(max_tokens) + 重试的 turn1
    expect(first.consumedEvents).toBe(true)

    // 重试(第三次 LLM 调用)的 messages 里应该含有 mid-episode 注入内容
    const nonFoldCalls = calls.filter((c) => !c.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER))
    expect(nonFoldCalls.length).toBe(3) // turn1 + turn2(max_tokens) + 重试
    const retryCallMessages = JSON.stringify(nonFoldCalls[2].messages)
    expect(retryCallMessages).toContain('sched-max-tokens')
    expect(retryCallMessages).toContain('首次尝试期间注入')

    // 第二次唤醒:验证 mid-episode 内容已被首次 episode 的重试消费进 state.recent,不会重复投递
    const second = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('新话题')] })
    expect(second.outcome).toBe('completed')

    const nonFoldCalls2 = calls.filter((c) => !c.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER))
    const secondWakeCall = nonFoldCalls2[nonFoldCalls2.length - 1]
    const midEpisodeOccurrences = (JSON.stringify(secondWakeCall.messages).match(/sched-max-tokens/g) ?? []).length
    // 确认 sched-max-tokens 只出现一次(作为历史的一部分),不是两次(不被重复投递)
    expect(midEpisodeOccurrences).toBe(1)
  })

  it('max_tokens 重试:折叠 LLM 调用期间到达的内容(必然未被 engine drain 消费)不会在 retry 里重复投递', async () => {
    const { adapter, queue } = makeAdapter()
    queue.push({ stopReason: 'max_tokens' }) // 首次尝试:静默 max_tokens
    queue.push({ text: '折叠后重试成功', stopReason: 'end_turn' }) // 强制折叠后的重试

    let loop!: ManagerLoop
    // 在折叠 LLM 调用期间(applyFold → foldIntoSummary 调 adapter.stream 时)注入一条
    // mid-episode 事件,模拟"事件恰好在两次尝试之间(折叠调用期间)到达"——此时它必然还没被
    // 任何 engine drainPending() 消费过,原样躺在 mailbox.pending 里,同时也被
    // currentEpisodeInjected 记录(两份来源同时存在,正是 review 指出的重复投递触发条件)。
    const injectDuringFold: LLMAdapter = {
      async *stream(params) {
        if (params.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER)) {
          loop.enqueueDuringEpisode({ kind: 'schedule', scheduleId: 'sched-during-fold', title: '巡检', description: '折叠调用期间到达' })
        }
        yield* adapter.stream(params)
      },
      updateConfig: () => {},
    }

    const policy: CompactionPolicy = { keepRecent: 2, cacheTtlMs: 1000, foldTokenThreshold: 1_000_000, hardCapTokens: 1_000_000 }
    const deps = baseDeps({ store, adapter: injectDuringFold, policy })
    loop = new ManagerLoop(deps)

    // 预置 3 条历史,让 force_hot 真正折掉点东西
    const seedMessages: EngineMessage[] = [
      createUserMessage('旧消息1'),
      createUserMessage('旧消息2'),
      createUserMessage('旧消息3'),
    ]
    await store.save({ key: KEY, recent: seedMessages, foldedCount: 0 })

    const result = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('触发超限')] })

    expect(result.outcome).toBe('completed')
    expect(result.consumedEvents).toBe(true)
    // retry 只应该是"折叠后重试成功"这一个 turn——若重复触发了 drain→continue,会多烧一轮
    // LLM 调用(默认回复)才收尾,turns 会变成 3。
    expect(result.turns).toBe(2) // 首次尝试 1 turn(max_tokens)+ 重试 1 turn

    const finalState = await store.load(KEY)
    const occurrences = (JSON.stringify(finalState.recent).match(/sched-during-fold/g) ?? []).length
    expect(occurrences).toBe(1) // 折叠期间到达的内容只应出现一次,不应因 retry 的 turn 边界
    // drain 与显式追加的 currentEpisodeInjected 重复计入
  })

  it('force_hot 因 history.length===keepRecent(无可折叠内容)返回 none 时不产生零进展的折叠 LLM 调用', async () => {
    const { adapter, queue, foldCalls } = makeAdapter()
    queue.push({ text: '正常处理', stopReason: 'end_turn' })

    // hardCapTokens 故意压得极低,确保 wakeDecision 会走进 force_hot 的 token 超限判断——
    // 唯一能拦住它的只有本次要验证的"foldMessages 为空则 none"这条修复。
    const policy: CompactionPolicy = { keepRecent: 3, cacheTtlMs: 1000, foldTokenThreshold: 1_000_000, hardCapTokens: 1 }
    const loop = new ManagerLoop(baseDeps({ store, adapter, policy }))

    // 预置恰好 keepRecent(3)条历史:splitAt=0,没有可折叠的内容
    const seedMessages: EngineMessage[] = [
      createUserMessage('旧消息1'),
      createUserMessage('旧消息2'),
      createUserMessage('旧消息3'),
    ]
    await store.save({ key: KEY, recent: seedMessages, foldedCount: 0 })

    const result = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('触发')] })

    expect(foldCalls.length).toBe(0) // 没有可折叠内容(splitAt=0),不该调折叠 LLM
    expect(result.outcome).toBe('completed')
    expect(result.turns).toBe(1) // 未经过任何强制折叠重试

    const state = await store.load(KEY)
    expect(state.rollingSummary).toBeUndefined() // 没发生过折叠
  })

  // --- drainMailbox(自唤醒入口,P7 阻塞项 #5) ---

  it('drainMailbox: mailbox 为空时是 no-op——不调 LLM、不写盘(否则会拿没有新内容的上下文凭空多问一次)', async () => {
    const { adapter, calls } = makeAdapter()
    const loop = new ManagerLoop(baseDeps({ store, adapter }))

    expect(loop.hasPendingMailbox).toBe(false)
    const result = await loop.drainMailbox()

    expect(result.turns).toBe(0)
    expect(result.consumedEvents).toBe(true)
    expect(calls.length).toBe(0)
    const state = await store.load(KEY)
    expect(state.recent.length).toBe(0)
  })

  it('drainMailbox: 只投递 mailbox 残留,不额外渲染唤醒事件;投递后 mailbox 清空、内容进历史(至少一次且不重复)', async () => {
    const { adapter, queue, calls } = makeAdapter()
    queue.push({ text: '处理完残留', stopReason: 'end_turn' })
    queue.push({ text: '下一次唤醒的回复', stopReason: 'end_turn' })

    const loop = new ManagerLoop(baseDeps({ store, adapter }))
    loop.enqueueDuringEpisode({ kind: 'schedule', scheduleId: 'sched-residue', title: '巡检', description: '收口后才到达的残留' })
    expect(loop.hasPendingMailbox).toBe(true)

    const result = await loop.drainMailbox()
    expect(result.outcome).toBe('completed')
    expect(result.consumedEvents).toBe(true)
    expect(loop.hasPendingMailbox).toBe(false)

    // 喂给 LLM 的只有残留本身,没有为"自唤醒"这件事凭空造出一条唤醒事件文本。
    const firstCallMessages = JSON.stringify(calls[0].messages)
    expect(firstCallMessages).toContain('收口后才到达的残留')
    expect(firstCallMessages).not.toContain('[人类消息]')

    // 已消费进持久历史,下次真实唤醒不会重复投递。
    const afterDrain = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('新的话')] })
    expect(afterDrain.outcome).toBe('completed')
    const state = await store.load(KEY)
    const occurrences = (JSON.stringify(state.recent).match(/sched-residue/g) ?? []).length
    expect(occurrences).toBe(1)
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

  it('manager 静默 end_turn(本轮没调任何发送工具)不触发 engine 的 forced_summary 追问,也不多烧 LLM 轮次', async () => {
    const { adapter, calls, queue } = makeAdapter()
    // 只脚本化一轮:静默 end_turn(无 text、无工具调用)。若 forced_summary gate 生效,
    // engine 会注入追问并续 loop —— 队列已空,mock 会用默认回复应答,calls 变成 2 次以上。
    queue.push({ stopReason: 'end_turn' })

    const loop = new ManagerLoop(baseDeps({ store, adapter }))
    const result = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('你好')] })

    expect(result.outcome).toBe('completed')
    // 语义不变量①:没有任何一轮的上下文里出现过 forced_summary 的文案。
    const allMessages = JSON.stringify(calls.map((c) => c.messages))
    expect(allMessages).not.toContain('你刚才以 end_turn 结束但还没有向人类发送任何内容')
    // 语义不变量②:静默 end_turn 直接被接受为正常完成态,只跑了一轮 LLM。
    expect(calls).toHaveLength(1)
    expect(result.turns).toBe(1)
  })

  // --- EpisodeResult.repliedToHuman(P7 J Task 3.1:群聊注意力退避的 `replied` 信号) ---

  describe('EpisodeResult.repliedToHuman', () => {
    /** 让 engine 有真工具可执行,避免 tool_use 落到"工具不存在"的错误分支上。 */
    function replyToolFace(): ReadonlyArray<ToolDefinition> {
      return ['send_message', 'send_private_message', 'send_master_private', 'spawn_worker', 'get_history'].map((name) =>
        defineTool({
          name,
          description: `stub ${name}`,
          inputSchema: { type: 'object', properties: {} },
          call: async () => ({ output: 'ok' }),
        })
      )
    }

    it('manager 沉默(一个字都没跟人说)→ repliedToHuman === false,即使 episode 正常完成', async () => {
      const { adapter, queue } = makeAdapter()
      queue.push({ text: '(内部判断:这条不需要我回)', stopReason: 'end_turn' })

      const loop = new ManagerLoop(baseDeps({ store, adapter, toolFace: replyToolFace }))
      const result = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('群里有人闲聊')] })

      // outcome 答不了这个问题——沉默和回话都是 completed,这正是需要单独一个字段的理由。
      expect(result.outcome).toBe('completed')
      expect(result.repliedToHuman).toBe(false)
    })

    it('manager 说话(调 send_message)→ repliedToHuman === true', async () => {
      const { adapter, queue } = makeAdapter()
      queue.push({ toolCalls: [{ name: 'send_message', id: 't1', input: { content: '好的' } }], stopReason: 'tool_use' })
      queue.push({ text: '已回复', stopReason: 'end_turn' })

      const loop = new ManagerLoop(baseDeps({ store, adapter, toolFace: replyToolFace }))
      const result = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('在吗')] })

      expect(result.outcome).toBe('completed')
      expect(result.repliedToHuman).toBe(true)
    })

    it('send_private_message / send_master_private 同样算"跟人说话"(投递到人 = 有人被打扰)', async () => {
      for (const toolName of ['send_private_message', 'send_master_private']) {
        const { adapter, queue } = makeAdapter()
        queue.push({ toolCalls: [{ name: toolName, id: 't1', input: {} }], stopReason: 'tool_use' })
        queue.push({ text: '已私下回复', stopReason: 'end_turn' })

        const isolatedStore = new ManagerSessionStore(join(dataDir, `store-${toolName}`))
        const loop = new ManagerLoop(baseDeps({ store: isolatedStore, adapter, toolFace: replyToolFace }))
        const result = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('私下问一句')] })

        expect(result.repliedToHuman).toBe(true)
      }
    })

    it('只派活不说话(spawn_worker)→ repliedToHuman === false(worker 不直接跟人类说话)', async () => {
      const { adapter, queue } = makeAdapter()
      queue.push({ toolCalls: [{ name: 'spawn_worker', id: 't1', input: {} }], stopReason: 'tool_use' })
      queue.push({ text: '已派活', stopReason: 'end_turn' })

      const loop = new ManagerLoop(baseDeps({ store, adapter, toolFace: replyToolFace }))
      const result = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('帮我查个东西')] })

      expect(result.repliedToHuman).toBe(false)
    })

    it('只读工具(get_history)不算说话', async () => {
      const { adapter, queue } = makeAdapter()
      queue.push({ toolCalls: [{ name: 'get_history', id: 't1', input: {} }], stopReason: 'tool_use' })
      queue.push({ text: '看完了,不回', stopReason: 'end_turn' })

      const loop = new ManagerLoop(baseDeps({ store, adapter, toolFace: replyToolFace }))
      const result = await loop.wakeUp({ kind: 'human_messages', messages: [makeChannelMessage('之前说到哪了')] })

      expect(result.repliedToHuman).toBe(false)
    })

    it('drainMailbox 的空转返回也带 repliedToHuman(=false),不是 undefined', async () => {
      const { adapter } = makeAdapter()
      const loop = new ManagerLoop(baseDeps({ store, adapter }))

      const result = await loop.drainMailbox()
      expect(result.turns).toBe(0)
      expect(result.repliedToHuman).toBe(false)
    })
  })

  // --- 消息渲染器(P7 J Task 4:@、引用、媒体、时间戳、message_id) ---

  describe('renderChannelMessages', () => {
    const MASTER: Friend = {
      id: 'f-master',
      name: '老板',
      permission: 'master',
      channel_identities: [{ channel_id: 'wechat', platform_user_id: 'u9' }],
    } as Friend

    /** 把 ChannelMessage 的结构化字段一次全填满,逐项验证渲染没有丢字段。 */
    function richMessage(): ChannelMessage {
      return {
        platform_message_id: 'pm-rich',
        session: { session_id: 'sess-loop', channel_id: 'wechat', type: 'group' },
        sender: { friend_id: 'f-master', platform_user_id: 'u9', platform_display_name: '小王' },
        content: {
          type: 'image',
          text: '看看这张图',
          media_url: 'https://cdn.example.com/a.png',
          filename: 'a.png',
        },
        features: {
          is_mention_crab: true,
          mentions: [{ user_id: 'u3', display_name: '张三' }],
          reply_to_message_id: 'pm-parent',
          quote_message_id: 'pm-quoted',
          thread_id: 'th-1',
        },
        platform_timestamp: '2026-01-01T03:04:00.000Z',
      }
    }

    /** 跑一个 episode,把喂给 LLM 的 messages 序列化出来。 */
    async function renderedPrompt(event: WakeEvent): Promise<string> {
      const { adapter, queue, calls } = makeAdapter()
      queue.push({ text: 'ok', stopReason: 'end_turn' })
      const loop = new ManagerLoop(baseDeps({ store, adapter, timezone: () => 'UTC' }))
      await loop.wakeUp(event)
      return JSON.stringify(calls[0].messages)
    }

    it('逐项渲染出 message_id / 时间戳 / @ / 提及名单 / 引用 / 媒体 / 发送者,一项都不丢', async () => {
      const prompt = await renderedPrompt({ kind: 'human_messages', messages: [richMessage()], friend: MASTER })

      // message_id —— manager 要靠它调 get_message 拉引用原文/详情
      expect(prompt).toContain('id=\\"pm-rich\\"')
      // 时间戳(UTC,同日 → HH:MM)
      expect(prompt).toContain('ts=\\"03:04\\"')
      // @ 了自己 + 提及名单
      expect(prompt).toContain('mention=\\"@you\\"')
      expect(prompt).toContain('mentions=\\"@张三\\"')
      // 引用/回复(放弃预取 → 属性必须在,否则 manager 连"该去拉什么"都不知道)
      expect(prompt).toContain('reply_to=\\"pm-parent\\"')
      expect(prompt).toContain('quote=\\"pm-quoted\\"')
      expect(prompt).toContain('thread=\\"th-1\\"')
      // 媒体
      expect(prompt).toContain('media=\\"image\\"')
      expect(prompt).toContain('media_url=\\"https://cdn.example.com/a.png\\"')
      expect(prompt).toContain('filename=\\"a.png\\"')
      expect(prompt).toContain('[图片: https://cdn.example.com/a.png]')
      // 发送者与身份(friend 随唤醒事件而来 → master 身份解析得出)
      expect(prompt).toContain('from=\\"小王\\"')
      expect(prompt).toContain('from_id=\\"u9\\"')
      expect(prompt).toContain('identity=\\"master\\"')
      // 正文仍在
      expect(prompt).toContain('看看这张图')
    })

    it('不带 friend 时不炸:身份退回 stranger,其余字段照常渲染', async () => {
      const prompt = await renderedPrompt({ kind: 'human_messages', messages: [richMessage()] })
      expect(prompt).toContain('identity=\\"stranger\\"')
      expect(prompt).toContain('id=\\"pm-rich\\"')
    })

    it('attention_flush 走同一个渲染器(标签不同、消息渲染完全一致)', async () => {
      const prompt = await renderedPrompt({ kind: 'attention_flush', messages: [richMessage()], friend: MASTER })
      expect(prompt).toContain('[补齐:群聊注意力放行期间累积的人类消息]')
      expect(prompt).toContain('id=\\"pm-rich\\"')
      expect(prompt).toContain('mention=\\"@you\\"')
      expect(prompt).toContain('identity=\\"master\\"')
    })

    it('渲染稳定:同样的输入(同一批消息 + 同一时钟)两次渲染逐字节相同——否则破坏前缀缓存', async () => {
      const msgs = [richMessage()]
      const first = await renderedPrompt({ kind: 'human_messages', messages: msgs, friend: MASTER })
      const second = await renderedPrompt({ kind: 'human_messages', messages: msgs, friend: MASTER })
      const extract = (s: string): string => s.slice(s.indexOf('<message'), s.indexOf('</message>'))
      expect(extract(second)).toBe(extract(first))
    })

    it('空批仍走既有的 `(空)` 短路,不渲染任何 <message> 标签', async () => {
      const prompt = await renderedPrompt({ kind: 'human_messages', messages: [] })
      expect(prompt).toContain('[人类消息](空)')
      expect(prompt).not.toContain('<message')
    })
  })
})
