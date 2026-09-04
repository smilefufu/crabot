import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ManagerLoop, type WakeEvent, type TimedWakeEnvelope, type ManagerLoopDeps } from '../../src/manager/loop.js'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import type { CompactionPolicy } from '../../src/manager/compaction.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { ChannelMessage, Friend } from '../../src/types.js'
import type { WorkerHarness } from '../../src/workers/harness/harness.js'
import type { LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import type { ActivityContextAdmissionReceipt } from '../../src/workers/harness/worker-events.js'
import { createUserMessage, defineTool } from '../../src/engine/index.js'
import type { LLMAdapter, LLMStreamParams, EngineMessage, ToolDefinition } from '../../src/engine/index.js'
import { MANAGER_WORKBOARD_CONTEXT } from '../../src/manager/prompt.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

// --- Fixtures / helpers ---

const KEY: ManagerKey = 'wechat::sess-loop'
const FIXED_RECEIVED_AT = '2026-01-01T08:00:00+08:00'
function timed(wake: WakeEvent): TimedWakeEnvelope { return { wake, received_at: FIXED_RECEIVED_AT, timezone: 'Asia/Shanghai' } }
const DIALOG_OBJECT_ID = (`test::${'friend-loop'}` as ManagerKey)

function defaultSupervisionWake(workerId: string, dueId: string): TimedWakeEnvelope {
  return timed({
    kind: 'worker_event',
    event: {
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'supervision_due',
      worker_id: workerId,
      seq: 1,
      detail: { mode: 'default', due_id: dueId, mainline_seq: 1, observation: 'text' },
    },
  })
}

function activityWake(receipt: ActivityContextAdmissionReceipt, workerId = 'w-activity'): TimedWakeEnvelope {
  return {
    ...timed({
      kind: 'worker_event',
      event: {
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'activity_available',
        worker_id: workerId,
        seq: 1,
        detail: {
          incarnation_id: 'inc-1',
          from_cursor: 'opaque-from',
          through_cursor: receipt.activity_through,
          preview: 'automatic compaction failed',
          has_error: true,
        },
      },
    }),
    activity_context_receipt: receipt,
  }
}

function makeActivityReceipt(through = 'opaque-through') {
  const admit = vi.fn(async () => undefined)
  const reject = vi.fn(async () => undefined)
  const receipt: ActivityContextAdmissionReceipt = {
    notification_id: 'activity-notification-1',
    activity_through: through,
    admit,
    reject,
  }
  return { receipt, admit, reject }
}

/** Engine Manager profile 的 system prompt 常量特征串,用它区分"这是折叠 LLM 调用
 *  还是普通 engine turn 调用",不需要 vi.mock/vi.spyOn 侵入模块内部。 */
const FOLD_SYSTEM_PROMPT_MARKER = '对话历史压缩助手'

function isAssistantTextEndTurnReminder(params: LLMStreamParams): boolean {
  const last = params.messages[params.messages.length - 1]
  return typeof last?.content === 'string' && last.content.startsWith('[系统提醒] 你刚才直接输出了一段文字')
}

interface TurnScript {
  readonly text?: string
  readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly id: string; readonly input: Record<string, unknown> }>
  /** raw_reasoning 块(不算 text,验证 isContextOverflow 提取文本时不被它干扰)。 */
  readonly reasoning?: Record<string, unknown>
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
}

function makeAdapter(opts: { autoSettleAssistantTextReminder?: boolean } = {}): {
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
      if (opts.autoSettleAssistantTextReminder !== false && isAssistantTextEndTurnReminder(params)) {
        yield* chunksFromContent([], 'end_turn', { inputTokens: 10, outputTokens: 5 })
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

function compressibleHistoryMessage(label: string, chars = 800): EngineMessage {
  return createUserMessage(`${label}:${'x'.repeat(chars)}`)
}

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
    managerKey: () => DIALOG_OBJECT_ID,
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

  it('拒绝绕过 registry 直接提交裸 WakeEvent', async () => {
    const { adapter } = makeAdapter()
    const loop = new ManagerLoop(baseDeps({ store, adapter }))
    const bare = { kind: 'schedule', scheduleId: 'bare', title: 't', description: 'd' } as WakeEvent

    await expect(loop.wakeUp(bare as never)).rejects.toThrow('TimedWakeEnvelope')
    expect(() => loop.enqueueDuringEpisode(bare as never)).toThrow('TimedWakeEnvelope')
  })

  it('daily reflection 重投为 carried wake 时仍使用受限投递面', async () => {
    const calls: LLMStreamParams[] = []
    const toolFaceWakes: Array<WakeEvent | undefined> = []
    let streamCount = 0
    const adapter: LLMAdapter = {
      async *stream(params) {
        calls.push({ ...params, messages: [...params.messages] })
        streamCount += 1
        if (streamCount === 1) throw new Error('temporary provider failure')
        yield* chunksFromContent([], 'end_turn')
      },
      updateConfig: () => {},
    }
    const loop = new ManagerLoop(baseDeps({
      store,
      adapter,
      isSystemThread: true,
      toolFace: (wake) => {
        toolFaceWakes.push(wake)
        return []
      },
    }))
    const dailyReflection = timed({
      kind: 'schedule',
      scheduleId: 'daily-reflection',
      title: '每日反思',
      description: '整理记忆',
      isBuiltin: true,
      taskType: 'daily_reflection',
    })

    const failed = await loop.wakeUp(dailyReflection)
    expect(failed).toMatchObject({ outcome: 'failed', consumedEvents: false })
    await loop.wakeUp(defaultSupervisionWake('w-follow-up', 'after-daily-failure'))

    expect(calls.slice(1).every((call) => call.systemPrompt.includes('send_daily_reflection_summary'))).toBe(true)
    expect(toolFaceWakes.slice(1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'schedule', taskType: 'daily_reflection' }),
    ]))
    expect(toolFaceWakes.slice(1)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'worker_event' }),
    ]))
  })

  it('唤醒 → 跑一个 turn → 回睡的完整往返', async () => {
    const { adapter, queue } = makeAdapter()
    queue.push({ text: '收到,已了解情况', stopReason: 'end_turn' })

    const loop = new ManagerLoop(baseDeps({ store, adapter }))
    const event: WakeEvent = { kind: 'human_messages', messages: [makeChannelMessage('你好')] }

    const result = await loop.wakeUp(timed(event))

    expect(result.outcome).toBe('completed')
    expect(result.consumedEvents).toBe(true)
    expect(result.turns).toBe(2) // 直接文字 end_turn 后会有一次 send_message 纠偏提醒
    expect(typeof result.episodeId).toBe('string')

    const state = await store.load(KEY)
    expect(state.recent.length).toBe(4) // 事件 + 直接文字 + 纠偏提醒 + 纠偏后的静默收口
    expect(JSON.stringify(state.recent)).toContain('你好')
    expect(state.lastActiveAt).toBeTruthy()
  })

  it('任务板规则稳定装配，但动态任务状态不进入 system prompt，也不触发自动读取', async () => {
    const { adapter, queue, calls } = makeAdapter()
    queue.push(
      { toolCalls: [{ name: 'mutate_dynamic_state', id: 'mutate-1', input: {} }], stopReason: 'tool_use' },
      { text: 'done', stopReason: 'end_turn' },
    )
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z')
    let pendingNote = 'dynamic-note-before-sentinel'
    const listWorkers = vi.fn(async (): Promise<LedgerWorker[]> => [])
    const loop = new ManagerLoop(baseDeps({
      store,
      adapter,
      now: () => new Date(nowMs),
      harness: { ...FAKE_HARNESS, listWorkers } as unknown as WorkerHarness,
      promptInputs: () => (
        { dialogProfile: 'fixed profile', pendingNotes: [pendingNote] } as { readonly dialogProfile?: string }
      ),
      toolFace: () => [{
        name: 'mutate_dynamic_state',
        description: 'mutate test-only dynamic state',
        inputSchema: { type: 'object', properties: {} },
        isReadOnly: false,
        call: async () => {
          nowMs += 60_000
          pendingNote = 'dynamic-note-after-sentinel'
          return { output: 'ok', isError: false }
        },
      }],
    }))

    await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('start')] }))

    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.systemPrompt).toBe(calls[0].systemPrompt)
      expect(call.systemPrompt).toContain(MANAGER_WORKBOARD_CONTEXT)
      expect(call.systemPrompt).not.toContain('dynamic-note-before-sentinel')
      expect(call.systemPrompt).not.toContain('dynamic-note-after-sentinel')
    }
    expect(MANAGER_WORKBOARD_CONTEXT).toContain('任务板不会自动进入上下文')
    expect(MANAGER_WORKBOARD_CONTEXT).toContain('主动查阅任务板')
    expect(MANAGER_WORKBOARD_CONTEXT).not.toContain('重启')
    expect(MANAGER_WORKBOARD_CONTEXT).not.toContain('压缩后')
    expect(listWorkers).not.toHaveBeenCalled()
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

    await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('第一条')] }))
    expect(adapterResolveCalls).toBe(1)
    expect(modelResolveCalls).toBe(1)

    // 模拟"config 热更"发生在两次唤醒之间：deps.adapter/model 这两个 thunk 本身不变
    // （生产环境由调用方在 thunk 内部读取最新 admin config），但 loop 只应在 episode 边界
    // （每次 wakeUp）重新调用一次——同一 episode 内（包括其内部可能的重试）绝不重复调用。
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('第二条')] }))
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
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('msg1')] }))
    expect(foldCalls.length).toBe(0)

    // wakeUp #2 @ t=100ms(远小于 TTL=1000ms)——burst,不压缩
    nowMs += 100
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('msg2')] }))
    expect(foldCalls.length).toBe(0)

    // wakeUp #3 @ t=100+5000ms(远超 TTL),此时累计历史(4 条)已超 foldTokenThreshold
    nowMs += 5000
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('msg3')] }))
    expect(foldCalls.length).toBe(1)

    const state = await store.load(KEY)
    expect(state.rollingSummary).toBeTruthy()
  })

  it('500K 历史切到 256K 模型时逐批压缩并在每批后推进持久状态', async () => {
    const { adapter, queue, foldCalls } = makeAdapter()
    queue.push({ text: '降窗后继续处理', stopReason: 'end_turn' })
    const history = Array.from({ length: 40 }, (_, index) =>
      compressibleHistoryMessage(`HISTORY_${index}`, 50_000),
    )
    await store.save({
      key: KEY,
      recent: history,
      foldedCount: 0,
      lastActiveAt: '2025-12-31T23:00:00.000Z',
    })

    const foldedProgress: number[] = []
    const save = store.save.bind(store)
    vi.spyOn(store, 'save').mockImplementation(async (next) => {
      if (next.foldedCount > (foldedProgress.at(-1) ?? 0)) {
        foldedProgress.push(next.foldedCount)
      }
      await save(next)
    })
    const policy: CompactionPolicy = {
      keepRecent: 2,
      cacheTtlMs: 1_000,
      foldTokenThreshold: 1,
      hardCapTokens: 1_000_000,
    }
    const loop = new ManagerLoop(baseDeps({
      store,
      adapter,
      policy,
      contextWindowTokens: () => 256_000,
    }))

    const result = await loop.wakeUp(timed({
      kind: 'human_messages',
      messages: [makeChannelMessage('CURRENT_HUMAN_MUST_STAY_RAW')],
    }))

    expect(result.outcome).toBe('completed')
    expect(foldCalls.length).toBeGreaterThanOrEqual(2)
    expect(foldedProgress.length).toBe(foldCalls.length)
    expect(foldedProgress.every((value, index) => index === 0 || value > foldedProgress[index - 1])).toBe(true)
    expect(foldedProgress.at(-1)).toBeGreaterThan(0)
    expect(foldedProgress.at(-1)).toBeLessThan(38)
    for (const call of foldCalls) {
      expect(JSON.stringify(call.messages)).not.toContain('CURRENT_HUMAN_MUST_STAY_RAW')
    }

    const state = await store.load(KEY)
    expect(state.foldedCount).toBe(foldedProgress.at(-1))
    expect(state.rollingSummary).toBe('折叠后的摘要')
    const remainingHistory = state.recent.filter((message) =>
      JSON.stringify(message).includes('HISTORY_'),
    )
    expect(remainingHistory).toHaveLength(history.length - state.foldedCount)
    expect(JSON.stringify(state.recent)).toContain('CURRENT_HUMAN_MUST_STAY_RAW')
  })

  it('hard cap 计入本 episode 的非人类事件，但摘要只消费此前历史', async () => {
    const { adapter, queue, foldCalls } = makeAdapter()
    queue.push({ text: '事件已处理', stopReason: 'end_turn' })
    const history = Array.from({ length: 3 }, (_, index) =>
      compressibleHistoryMessage(`EVENT_BUDGET_HISTORY_${index}`, 80_000),
    )
    await store.save({ key: KEY, recent: history, foldedCount: 0 })

    const loop = new ManagerLoop(baseDeps({
      store,
      adapter,
      policy: {
        keepRecent: 3,
        cacheTtlMs: 1_000,
        foldTokenThreshold: 1_000_000,
        hardCapTokens: 1_000_000,
      },
      contextWindowTokens: () => 256_000,
    }))
    const eventMarker = `CURRENT_MEDIA_EVENT:${'e'.repeat(600_000)}`

    const result = await loop.wakeUp(timed({ kind: 'media_notification', text: eventMarker }))

    expect(result.outcome).toBe('completed')
    expect(foldCalls.length).toBeGreaterThan(0)
    for (const call of foldCalls) {
      expect(JSON.stringify(call.messages)).not.toContain('CURRENT_MEDIA_EVENT')
    }
    const state = await store.load(KEY)
    expect(state.foldedCount).toBeGreaterThan(0)
    expect(JSON.stringify(state.recent)).toContain('CURRENT_MEDIA_EVENT')
  })

  it('第二批摘要失败时保留第一批落盘结果，且当前人类输入始终不进入摘要', async () => {
    const base = makeAdapter()
    const foldAttempts: LLMStreamParams[] = []
    const failSecondBatch: LLMAdapter = {
      async *stream(params) {
        if (params.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER)) {
          foldAttempts.push({ ...params, messages: [...params.messages] })
          if (foldAttempts.length === 2) throw new Error('second compaction batch failed')
        }
        yield* base.adapter.stream(params)
      },
      updateConfig: () => {},
    }
    const history = Array.from({ length: 40 }, (_, index) =>
      compressibleHistoryMessage(`PARTIAL_HISTORY_${index}`, 50_000),
    )
    await store.save({
      key: KEY,
      recent: history,
      foldedCount: 0,
      lastActiveAt: '2025-12-31T23:00:00.000Z',
    })
    const policy: CompactionPolicy = {
      keepRecent: 2,
      cacheTtlMs: 1_000,
      foldTokenThreshold: 1,
      hardCapTokens: 1_000_000,
    }
    const loop = new ManagerLoop(baseDeps({
      store,
      adapter: failSecondBatch,
      policy,
      contextWindowTokens: () => 256_000,
    }))

    await expect(loop.wakeUp(timed({
      kind: 'human_messages',
      messages: [makeChannelMessage('PARTIAL_CURRENT_HUMAN')],
    }))).rejects.toThrow('second compaction batch failed')

    expect(foldAttempts).toHaveLength(2)
    for (const call of foldAttempts) {
      expect(JSON.stringify(call.messages)).not.toContain('PARTIAL_CURRENT_HUMAN')
    }
    const state = await store.load(KEY)
    expect(state.rollingSummary).toBe('折叠后的摘要')
    expect(state.foldedCount).toBeGreaterThan(0)
    expect(state.foldedCount).toBeLessThan(38)
    expect(JSON.stringify(state.recent)).toContain('PARTIAL_CURRENT_HUMAN')
    expect(state.recent.length).toBe(history.length - state.foldedCount + 1)
  })

  it('episode 失败(LLM 报错)后已提交人类输入留在 history，下一次新 wake 继续会话', async () => {
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
    const originalEnvelope: TimedWakeEnvelope = {
      wake: event,
      received_at: '2026-01-01T08:12:34+08:00',
      timezone: 'Asia/Shanghai',
    }

    const first = await loop.wakeUp(originalEnvelope)
    expect(first.outcome).toBe('failed')
    expect(first.consumedEvents).toBe(false)

    // 人类输入已在 LLM 前提交；失败不能把它退回 mailbox 重投。
    const stateAfterFailure = await store.load(KEY)
    expect(JSON.stringify(stateAfterFailure.recent)).toContain('重要的话只能说一次')
    expect(loop.hasPendingMailbox).toBe(false)

    // 下次新 wake 从 history 看到原输入，并追加本次输入。
    const second = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('新的话')] }))
    expect(second.outcome).toBe('completed')
    expect(second.consumedEvents).toBe(true)

    const finalState = await store.load(KEY)
    const serialized = JSON.stringify(finalState.recent)
    expect(serialized).toContain('重要的话只能说一次') // 来自已提交的历史
    expect(serialized).toContain('received_at=\\"2026-01-01T08:12:34+08:00\\"')
    expect(serialized).toContain('新的话') // 本次新事件
    expect(serialized.match(/重要的话只能说一次/g)).toHaveLength(1)
  })

  it('重复的已提交 Admin Chat wake 不调 LLM，并结算遗留 correlation', async () => {
    const message = makeChannelMessage('这条已经进入 history')
    const envelope: TimedWakeEnvelope = {
      ...timed({ kind: 'human_messages', messages: [message] }),
      correlation: { admin_chat_request_ids: ['admin-request-1'] },
    }
    const settled: string[][] = []
    const failingAdapter: LLMAdapter = {
      async *stream() {
        throw new Error('provider unavailable')
      },
      updateConfig: () => {},
    }
    const firstLoop = new ManagerLoop(baseDeps({
      store,
      adapter: failingAdapter,
      onAdminChatWakeConsumed: async (requestIds) => { settled.push([...requestIds]) },
    }))

    const first = await firstLoop.wakeUp(envelope)
    expect(first.outcome).toBe('failed')
    expect(settled).toEqual([])

    const { adapter, calls } = makeAdapter()
    const duplicateLoop = new ManagerLoop(baseDeps({
      store,
      adapter,
      onAdminChatWakeConsumed: async (requestIds) => { settled.push([...requestIds]) },
    }))
    const duplicate = await duplicateLoop.wakeUp(envelope)

    expect(duplicate.consumedEvents).toBe(true)
    expect(calls).toHaveLength(0)
    expect(settled).toEqual([['admin-request-1']])
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
            loop.enqueueDuringEpisode(timed({ kind: 'schedule', scheduleId: 'sched-fail', title: '巡检', description: '失败前注入的事件' }))
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    const first = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('开始任务')] }))
    expect(first.outcome).toBe('failed')
    expect(first.consumedEvents).toBe(false)

    // 证明确实被消费过(不是"从未被消费"这种平凡情形):turn2 的请求里能看到注入内容
    expect(turn2Messages).toBeDefined()
    expect(JSON.stringify(turn2Messages)).toContain('sched-fail')

    // 初始人类输入已提交；只有失败期间注入的非人类事件仍在 mailbox。
    const stateAfterFailure = await store.load(KEY)
    expect(JSON.stringify(stateAfterFailure.recent)).toContain('开始任务')
    expect(loop.hasPendingMailbox).toBe(true)

    // 下次唤醒(不同的新事件):mid-episode 注入的内容应随邮箱一起重投,被 LLM 看到并落盘
    queue.push({ text: '正常处理', stopReason: 'end_turn' })
    const second = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('新的话')] }))
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
            loop.enqueueDuringEpisode(timed({ kind: 'schedule', scheduleId: 'sched-throw', title: '巡检', description: '直接抛错前注入的事件' }))
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    // 预置 3 条可压缩历史，让 force_hot 真正应用批次，测到摘要调用抛错路径。
    const seedMessages: EngineMessage[] = [
      compressibleHistoryMessage('旧消息1'),
      compressibleHistoryMessage('旧消息2'),
      compressibleHistoryMessage('旧消息3'),
    ]
    await store.save({ key: KEY, recent: seedMessages, foldedCount: 0 })

    // 唤醒前先在邮箱里塞一条"上一次遗留"的内容(episode 未在跑,直接进 mailbox.pending,
    // 是本次唤醒 carriedTexts 的来源)
    loop.enqueueDuringEpisode(timed({ kind: 'schedule', scheduleId: 'sched-carried', title: '巡检', description: '唤醒前已经在邮箱里的内容' }))

    await expect(
      loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('触发超限并在折叠时抛错')] }))
    ).rejects.toThrow('boom: fold llm exhausted retries')

    // 人类输入在可能抛错的折叠前已落盘；非人类 carried/injected 事件仍留待重投。
    const stateAfterThrow = await store.load(KEY)
    expect(stateAfterThrow.recent).toHaveLength(seedMessages.length + 1)
    expect(JSON.stringify(stateAfterThrow.recent)).toContain('触发超限并在折叠时抛错')

    // 下次唤醒:carriedTexts(唤醒前邮箱里的内容)、eventText(本次唤醒事件)、
    // currentEpisodeInjected(mid-episode 注入)应该都被重投,一个不丢
    queue.push({ text: '正常处理', stopReason: 'end_turn' })
    const second = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('新的话')] }))
    expect(second.outcome).toBe('completed')
    expect(second.consumedEvents).toBe(true)

    const finalState = await store.load(KEY)
    const serialized = JSON.stringify(finalState.recent)
    expect(serialized).toContain('sched-carried') // 唤醒前已在邮箱的内容(carriedTexts)
    expect(serialized).toContain('sched-throw') // mid-episode 注入(currentEpisodeInjected)
    expect(serialized).toContain('触发超限并在折叠时抛错') // 本次唤醒事件(eventText)
    expect(serialized).toContain('新的话') // 第二次唤醒的新事件
  })

  it('runEpisodeBody 直接 throw 时,mid-episode 注入的人类消息由 catch 分支补提交进 recent,不丢不重复', async () => {
    const { adapter, queue } = makeAdapter()
    // 同上一用例的 throw 路径(force-hot 折叠抛错),但 mid-episode 注入的是**人类消息**——
    // 五审真实风险:catch 分支原来没有 commitPendingHumanInputs,注入消息不在 store、
    // mailbox 被 drain、requeue 又按主 wake(人类,已提交)跳过 → 永久丢失。
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
            await loop.enqueueHumanWakeDuringActiveEpisode(
              timed({ kind: 'human_messages', messages: [makeChannelMessage('抛错前注入的指令')] }),
            )
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    const seedMessages: EngineMessage[] = [
      compressibleHistoryMessage('旧消息1'),
      compressibleHistoryMessage('旧消息2'),
      compressibleHistoryMessage('旧消息3'),
    ]
    await store.save({ key: KEY, recent: seedMessages, foldedCount: 0 })

    await expect(
      loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('触发超限并在折叠时抛错')] }))
    ).rejects.toThrow('boom: fold llm exhausted retries')

    // catch 分支补提交:注入消息落 recent + 去重键(键与文本同进),mailbox 无残留
    const stateAfterThrow = await store.load(KEY)
    expect(JSON.stringify(stateAfterThrow.recent)).toContain('抛错前注入的指令')
    expect(stateAfterThrow.committedHumanMessageIds ?? []).toHaveLength(2) // 主 wake + 注入
    expect(loop.hasPendingMailbox).toBe(false)

    // 下次唤醒:注入消息经 tailMessages 可见,commitHumanInputs 按键去重不重复追加
    queue.push({ text: '正常处理', stopReason: 'end_turn' })
    const second = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('新的话')] }))
    expect(second.outcome).toBe('completed')

    const finalState = await store.load(KEY)
    const serialized = JSON.stringify(finalState.recent)
    expect(serialized).toContain('抛错前注入的指令')
    expect(serialized).toContain('新的话')
    // 「抛错前注入的指令」全历史只出现一次(tailMessages 引用同一份 recent,不重复追加)
    expect(serialized.split('抛错前注入的指令')).toHaveLength(2)
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
            loop.enqueueDuringEpisode(timed({ kind: 'schedule', scheduleId: 'sched-ok', title: '巡检', description: '成功路径注入' }))
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    const first = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('开始任务')] }))
    expect(first.outcome).toBe('completed')
    expect(first.consumedEvents).toBe(true)

    const second = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('新的话')] }))
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
            loop.enqueueDuringEpisode(timed({ kind: 'schedule', scheduleId: 'sched-1', title: '巡检', description: '期间到达的新事件' }))
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('开始任务')] }))

    expect(result.outcome).toBe('completed')
    expect(result.turns).toBe(3)

    const nonFoldCalls = calls.filter((c) => !c.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER))
    expect(nonFoldCalls.length).toBe(3)
    const turn2Messages = JSON.stringify(nonFoldCalls[1].messages)
    expect(turn2Messages).toContain('sched-1')
    expect(turn2Messages).toContain('期间到达的新事件')
    // turn1 请求里不应该已经看到它(证明确实是"turn 间隙"注入,不是从一开始就在 initialMessages 里)
    const turn1Messages = JSON.stringify(nonFoldCalls[0].messages)
    expect(turn1Messages).not.toContain('sched-1')
  })

  it('episode 运行中到达的人类消息:先提交(store recent+去重键+回调)再注入,当前 episode 下一轮可见', async () => {
    const { adapter, queue, calls } = makeAdapter()
    queue.push({ toolCalls: [{ name: 'noop_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' })
    queue.push({ text: '已处理完毕', stopReason: 'end_turn' })

    let loop!: ManagerLoop
    const committedIds: string[] = []
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
            // 模拟 episode 运行中人类消息到达(P7 cutover 遗留接线):提交+注入一步完成
            await loop.enqueueHumanWakeDuringActiveEpisode(
              timed({ kind: 'human_messages', messages: [makeChannelMessage('中途新指令')] }),
              async (id) => { committedIds.push(id) },
            )
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('开始任务')] }))
    expect(result.outcome).toBe('completed')

    // 注入可见:turn2 含人类新消息,turn1 不含(turn 间隙注入,不是 initialMessages)
    const nonFoldCalls = calls.filter((c) => !c.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER))
    expect(JSON.stringify(nonFoldCalls[1].messages)).toContain('中途新指令')
    expect(JSON.stringify(nonFoldCalls[0].messages)).not.toContain('中途新指令')

    // 提交落盘:store recent 含消息、去重键记录、commit 回调触发
    const state = await store.load(KEY)
    expect(JSON.stringify(state.recent)).toContain('中途新指令')
    expect(state.committedHumanMessageIds?.length).toBe(2) // 主 wake + mid-episode 注入
    expect(committedIds).toHaveLength(1)
  })

  it('episode 失败:被注入消费的人类消息补提交进 recent,下次唤醒经 tailMessages 重新可见且不重复', async () => {
    const { adapter, queue } = makeAdapter()
    queue.push({ toolCalls: [{ name: 'noop_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' })

    let loop!: ManagerLoop
    let nonFoldCallCount = 0
    let turn2Messages: EngineMessage[] | undefined
    const throwOnTurn2: LLMAdapter = {
      async *stream(params) {
        if (params.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER)) {
          yield* adapter.stream(params)
          return
        }
        nonFoldCallCount++
        if (nonFoldCallCount === 2) {
          turn2Messages = [...params.messages]
          throw new Error('boom: simulated failure after human injection drain')
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
            await loop.enqueueHumanWakeDuringActiveEpisode(
              timed({ kind: 'human_messages', messages: [makeChannelMessage('失败前的人类指令')] }),
            )
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    const first = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('开始任务')] }))
    expect(first.outcome).toBe('failed')

    // 证明确实被注入消费过:turn2 的请求里能看到人类指令
    expect(turn2Messages).toBeDefined()
    expect(JSON.stringify(turn2Messages)).toContain('失败前的人类指令')

    // 失败收尾把已消费的人类消息补提交进 recent——下一 episode 经 tailMessages 重新看到
    const stateAfterFailure = await store.load(KEY)
    expect(JSON.stringify(stateAfterFailure.recent)).toContain('失败前的人类指令')

    // 下次唤醒:recent 已含该指令(不重复渲染),新输入正常处理
    queue.push({ text: '正常处理', stopReason: 'end_turn' })
    const second = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('新的话')] }))
    expect(second.outcome).toBe('completed')

    const finalState = await store.load(KEY)
    const serialized = JSON.stringify(finalState.recent)
    expect(serialized).toContain('失败前的人类指令')
    expect(serialized).toContain('新的话')
    // 失败 episode 的重投不产生重复:该指令只出现一次
    expect(serialized.split('失败前的人类指令')).toHaveLength(2)
  })

  it('未提交的人类消息仍被 enqueueDuringEpisode 拒绝(提交前置守卫保留)', async () => {
    const { adapter } = makeAdapter()
    const deps = baseDeps({ store, adapter })
    const loop = new ManagerLoop(deps)

    expect(() => loop.enqueueDuringEpisode(timed({ kind: 'human_messages', messages: [makeChannelMessage('x')] })))
      .toThrow('human messages must be committed through wakeUp')
  })

  it('重复来源(整批已提交)注入在跑 episode 时不进 LLM(协议 §4.1 重复来源守卫)', async () => {
    const { adapter, queue, calls } = makeAdapter()
    queue.push({ toolCalls: [{ name: 'noop_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' })
    queue.push({ text: '已回复', stopReason: 'end_turn' })

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
            // 第一次:新消息,正常注入;第二次:同一 platform_message_id 重放(at-least-once),必须被挡
            const env = timed({ kind: 'human_messages', messages: [makeChannelMessage('重放攻击消息')] })
            await loop.enqueueHumanWakeDuringActiveEpisode(env)
            await loop.enqueueHumanWakeDuringActiveEpisode(env)
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('开始任务')] }))
    expect(result.outcome).toBe('completed')

    // 消息只被注入一次:最终上下文中恰好出现一次(messages 快照跨轮累积,看最后一轮)
    const nonFoldCalls = calls.filter((c) => !c.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER))
    const lastMessages = JSON.stringify(nonFoldCalls.at(-1)!.messages)
    expect(lastMessages.split('重放攻击消息')).toHaveLength(2) // 1 次出现
    // 去重键只记一条
    const state = await store.load(KEY)
    expect((state.committedHumanMessageIds ?? []).length).toBe(2) // 主 wake + 注入一次
  })

  it('部分重叠批次:已提交的旧消息不进 LLM,只注入新消息投影', async () => {
    const { adapter, queue, calls } = makeAdapter()
    queue.push({ toolCalls: [{ name: 'noop_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' })
    queue.push({ text: '已回复', stopReason: 'end_turn' })

    const oldMsg = makeChannelMessage('已经答复过的旧消息')
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
            // 第一批:旧消息单独到达并提交
            await loop.enqueueHumanWakeDuringActiveEpisode(timed({ kind: 'human_messages', messages: [oldMsg] }))
            // 第二批:同一旧消息 + 一条新消息(渠道合并重发场景)
            await loop.enqueueHumanWakeDuringActiveEpisode(
              timed({ kind: 'human_messages', messages: [oldMsg, makeChannelMessage('全新的消息')] }),
            )
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('开始任务')] }))

    // 旧消息只出现一次(第一次注入),第二次注入只带新消息投影——看最终上下文
    const nonFoldCalls = calls.filter((c) => !c.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER))
    const lastMessages = JSON.stringify(nonFoldCalls.at(-1)!.messages)
    expect(lastMessages.split('已经答复过的旧消息')).toHaveLength(2) // 1 次出现
    expect(lastMessages.split('全新的消息')).toHaveLength(2) // 1 次出现
  })

  it('注入委托的结算钩子在 episode 收尾以真实 result 触发(群聊注意力结算用)', async () => {
    const { adapter, queue, calls } = makeAdapter()
    queue.push({ toolCalls: [{ name: 'noop_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' })
    queue.push({ text: '已回复群消息', stopReason: 'end_turn' })

    let loop!: ManagerLoop
    const settlements: Array<{ outcome: string; repliedToHuman: boolean }> = []
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
            await loop.enqueueHumanWakeDuringActiveEpisode(
              timed({ kind: 'human_messages', messages: [makeChannelMessage('群里的后续消息')] }),
              undefined,
              (result) => settlements.push({ outcome: result.outcome, repliedToHuman: result.repliedToHuman }),
            )
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('开始任务')] }))
    expect(result.outcome).toBe('completed')

    // 结算钩子以被注入 episode 的真实收尾触发一次(不是注入瞬间的编造值):
    // 本回合以 end_turn 文本收尾(未调 send_message)→ repliedToHuman 如实为 false
    expect(settlements).toHaveLength(1)
    expect(settlements[0]).toEqual({ outcome: 'completed', repliedToHuman: false })
  })

  it('注入未被消费(最后一轮 drain 之后)时不提交不 discard,留 mailbox 由自唤醒按正常路径提交+投喂', async () => {
    const { adapter, queue, calls } = makeAdapter()
    // maxTurns=2:turn1 工具(注入未发生) → turn2 工具(此处注入,但其后 hasRemainingTurn=false 不 drain)
    // → 轮次耗尽 max_turns 收尾(consumedEvents=true)
    queue.push({ toolCalls: [{ name: 'noop_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' })
    queue.push({ toolCalls: [{ name: 'inject_tool', id: 'call_2', input: {} }], stopReason: 'tool_use' })

    let loop!: ManagerLoop
    const deps = baseDeps({
      store,
      adapter,
      maxTurns: 2,
      toolFace: () => [
        {
          name: 'noop_tool',
          description: 'noop',
          inputSchema: { type: 'object', properties: {} },
          isReadOnly: false,
          call: async () => ({ output: 'ok', isError: false }),
        },
        {
          name: 'inject_tool',
          description: 'inject',
          inputSchema: { type: 'object', properties: {} },
          isReadOnly: false,
          call: async () => {
            // 最后一轮的工具执行后 engine 不再 drain——注入滞留 mailbox
            await loop.enqueueHumanWakeDuringActiveEpisode(
              timed({ kind: 'human_messages', messages: [makeChannelMessage('滞留指令')] }),
            )
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    const first = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('开始任务')] }))
    expect(first.outcome).toBe('max_turns') // 轮次耗尽,按已消费收口(consumedEvents=true)

    // 五审语义:未被消费的注入在成功收尾**不提交、不 discard、不记键**,envelope 留在
    // mailbox——hasPendingMailbox 触发自唤醒,由下个 episode 按正常路径提交+投喂(提交
    // 了就没有 episode 回答它;先提交再留邮箱则自唤醒被去重键打成空转)
    const stateAfter = await store.load(KEY)
    expect(JSON.stringify(stateAfter.recent)).not.toContain('滞留指令')
    expect(stateAfter.committedHumanMessageIds ?? []).toHaveLength(1) // 仅主 wake
    expect(loop.hasPendingMailbox).toBe(true)

    // 自唤醒/下次唤醒:mailbox 残留经 carry 正常提交(键未记,不被去重跳过),LLM 看到
    queue.push({ text: '补看滞留消息', stopReason: 'end_turn' })
    const second = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('新的话')] }))
    expect(second.outcome).toBe('completed')

    const secondCall = calls[calls.length - 1]
    expect(JSON.stringify(secondCall.messages)).toContain('滞留指令')
    const finalState = await store.load(KEY)
    const finalText = JSON.stringify(finalState.recent)
    expect(finalText).toContain('滞留指令')
    expect(finalText).toContain('新的话')
    expect(finalState.committedHumanMessageIds?.length).toBe(3) // 主 wake + 滞留 + 新的话
  })

  it('activity 仅入 mailbox 时保持 pending，进入下一次 LLM 输入前才确认', async () => {
    const { adapter, queue, calls } = makeAdapter()
    queue.push({ toolCalls: [{ name: 'inject_activity', id: 'call-activity', input: {} }], stopReason: 'tool_use' })
    queue.push({ stopReason: 'end_turn' })
    const { receipt, admit, reject } = makeActivityReceipt()

    let loop!: ManagerLoop
    loop = new ManagerLoop(baseDeps({
      store,
      adapter,
      toolFace: () => [{
        name: 'inject_activity',
        description: 'inject activity',
        inputSchema: { type: 'object', properties: {} },
        isReadOnly: false,
        call: async () => {
          loop.enqueueDuringEpisode(activityWake(receipt))
          expect(admit).not.toHaveBeenCalled()
          return { output: 'ok', isError: false }
        },
      }],
    }))

    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('开始')] }))

    expect(result.outcome).toBe('completed')
    expect(admit).toHaveBeenCalledOnce()
    expect(reject).not.toHaveBeenCalled()
    expect(JSON.stringify(calls[0].messages)).not.toContain('activity_available')
    expect(JSON.stringify(calls[1].messages)).toContain('activity_available')
  })

  it('activity 在最后一个可用 turn 到达时留待下一次 episode，不在未准入时从 mailbox 消失', async () => {
    const { adapter, queue, calls } = makeAdapter()
    queue.push({ toolCalls: [{ name: 'inject_activity', id: 'call-activity-last-turn', input: {} }], stopReason: 'tool_use' })
    queue.push({ stopReason: 'end_turn' })
    const { receipt, admit, reject } = makeActivityReceipt()

    let loop!: ManagerLoop
    loop = new ManagerLoop(baseDeps({
      store,
      adapter,
      maxTurns: 1,
      toolFace: () => [{
        name: 'inject_activity',
        description: 'inject activity on the last available turn',
        inputSchema: { type: 'object', properties: {} },
        isReadOnly: false,
        call: async () => {
          loop.enqueueDuringEpisode(activityWake(receipt))
          return { output: 'ok', isError: false }
        },
      }],
    }))

    const first = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('开始')] }))

    expect(first.outcome).toBe('max_turns')
    expect(admit).not.toHaveBeenCalled()
    expect(reject).not.toHaveBeenCalled()
    expect(JSON.stringify(calls[0].messages)).not.toContain('activity_available')

    const second = await loop.drainMailbox()

    expect(second.outcome).toBe('completed')
    expect(admit).toHaveBeenCalledOnce()
    expect(reject).not.toHaveBeenCalled()
    expect(JSON.stringify(calls[1].messages)).toContain('activity_available')
  })

  it('activity 准入后即使 Provider 调用失败也不 reject 或留在 mailbox 重投', async () => {
    const calls: LLMStreamParams[] = []
    const adapter: LLMAdapter = {
      async *stream(params) {
        calls.push({ ...params, messages: [...params.messages] })
        throw new Error('provider unavailable after admission')
      },
      updateConfig: () => {},
    }
    const { receipt, admit, reject } = makeActivityReceipt()
    const loop = new ManagerLoop(baseDeps({ store, adapter }))

    const result = await loop.wakeUp(activityWake(receipt))
    const replay = await loop.drainMailbox()

    expect(result).toMatchObject({ outcome: 'failed', consumedEvents: false })
    expect(admit).toHaveBeenCalledOnce()
    expect(reject).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    expect(replay).toMatchObject({ turns: 0, consumedEvents: true })
  })

  it('同轮多条 activity 的后一条持久确认失败，不阻断已组装的 LLM 输入', async () => {
    const { adapter, queue, calls } = makeAdapter()
    queue.push({ stopReason: 'end_turn' })
    const first = makeActivityReceipt('opaque-through-first')
    const secondAdmit = vi.fn(async () => { throw new Error('activity store unavailable') })
    const secondReject = vi.fn(async () => undefined)
    const secondReceipt: ActivityContextAdmissionReceipt = {
      notification_id: 'activity-notification-admit-failure',
      activity_through: 'opaque-through-admit-failure',
      admit: secondAdmit,
      reject: secondReject,
    }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loop = new ManagerLoop(baseDeps({ store, adapter }))
    loop.enqueueDuringEpisode(activityWake(first.receipt, 'w-activity-first'))

    const result = await loop.wakeUp(activityWake(secondReceipt, 'w-activity-second'))

    await vi.waitFor(() => expect(secondReject).toHaveBeenCalledOnce())
    expect(result).toMatchObject({ outcome: 'completed', consumedEvents: true })
    expect(first.admit).toHaveBeenCalledOnce()
    expect(first.reject).not.toHaveBeenCalled()
    expect(secondAdmit).toHaveBeenCalledOnce()
    expect(JSON.stringify(calls[0].messages)).toContain('w-activity-first')
    expect(JSON.stringify(calls[0].messages)).toContain('w-activity-second')
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('activity admission acknowledgement failed'),
      expect.any(Error),
    )
    warning.mockRestore()
  })

  it('LLM 输入准入前直接失败会 reject activity，且不保留 mailbox 副本', async () => {
    const { receipt, admit, reject } = makeActivityReceipt()
    const loop = new ManagerLoop(baseDeps({
      store,
      adapter: () => { throw new Error('manager model unavailable') },
    }))

    await expect(loop.wakeUp(activityWake(receipt))).rejects.toThrow('manager model unavailable')
    const replay = await loop.drainMailbox()

    expect(admit).not.toHaveBeenCalled()
    expect(reject).toHaveBeenCalledOnce()
    expect(replay).toMatchObject({ turns: 0, consumedEvents: true })
  })

  it('max_tokens 强制折叠重试不再次注入已经准入的 activity', async () => {
    const { adapter, queue, calls } = makeAdapter()
    queue.push({ stopReason: 'max_tokens' })
    queue.push({ stopReason: 'end_turn' })
    const { receipt, admit, reject } = makeActivityReceipt()
    const policy: CompactionPolicy = {
      keepRecent: 2,
      cacheTtlMs: 1000,
      foldTokenThreshold: 1_000_000,
      hardCapTokens: 1_000_000,
    }
    await store.save({
      key: KEY,
      recent: [
        compressibleHistoryMessage('旧消息1'),
        compressibleHistoryMessage('旧消息2'),
        compressibleHistoryMessage('旧消息3'),
      ],
      foldedCount: 0,
    })
    const loop = new ManagerLoop(baseDeps({ store, adapter, policy }))

    const result = await loop.wakeUp(activityWake(receipt))

    const managerCalls = calls.filter((call) => !call.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER))
    expect(result.outcome).toBe('completed')
    expect(admit).toHaveBeenCalledOnce()
    expect(reject).not.toHaveBeenCalled()
    expect(JSON.stringify(managerCalls[0].messages)).toContain('activity_available')
    expect(JSON.stringify(managerCalls[1].messages)).not.toContain('activity_available')
  })

  it('max_tokens(上下文超限)收场时强制折叠一次并重试一次,成功后 outcome=completed', async () => {
    const { adapter, queue, calls, foldCalls } = makeAdapter()
    queue.push({ stopReason: 'max_tokens' })
    // 强制折叠后的重试:正常结束
    queue.push({ text: '折叠后重试成功', stopReason: 'end_turn' })

    const policy: CompactionPolicy = { keepRecent: 2, cacheTtlMs: 1000, foldTokenThreshold: 1_000_000, hardCapTokens: 1_000_000 }
    const loop = new ManagerLoop(baseDeps({ store, adapter, policy }))

    // 预置 3 条可压缩历史，让 force_hot 真正应用一个批次。
    const seedMessages: EngineMessage[] = [
      compressibleHistoryMessage('旧消息1'),
      compressibleHistoryMessage('旧消息2'),
      compressibleHistoryMessage('旧消息3'),
    ]
    await store.save({ key: KEY, recent: seedMessages, foldedCount: 0 })

    const initialEnvelope: TimedWakeEnvelope = {
      wake: { kind: 'human_messages', messages: [makeChannelMessage('触发超限的一句话')] },
      received_at: '2026-01-01T08:22:33+08:00',
      timezone: 'Asia/Shanghai',
    }
    const result = await loop.wakeUp(initialEnvelope)

    expect(foldCalls.length).toBe(1) // 强制折叠恰好发生一次
    expect(JSON.stringify(foldCalls[0].messages)).not.toContain('触发超限的一句话')
    const nonFoldCalls = calls.filter((call) => !call.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER))
    expect(nonFoldCalls).toHaveLength(3)
    for (const call of nonFoldCalls) {
      expect(JSON.stringify(call.messages)).toContain('received_at=\\"2026-01-01T08:22:33+08:00\\"')
    }
    expect(result.outcome).toBe('completed')
    expect(result.turns).toBe(3) // 首次尝试 + 重试文字 + 一次纠偏回合
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
      compressibleHistoryMessage('旧消息1'),
      compressibleHistoryMessage('旧消息2'),
      compressibleHistoryMessage('旧消息3'),
    ]
    await store.save({ key: KEY, recent: seedMessages, foldedCount: 0 })

    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('会被截断的长问题')] }))

    expect(foldCalls.length).toBe(0) // 未触发强制折叠
    expect(calls.length).toBe(1) // max_tokens 的部分文本不是 end_turn，不触发纠偏
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
      compressibleHistoryMessage('旧消息1'),
      compressibleHistoryMessage('旧消息2'),
      compressibleHistoryMessage('旧消息3'),
    ]
    await store.save({ key: KEY, recent: seedMessages, foldedCount: 0 })

    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('触发超限的一句话(仅推理块)')] }))

    expect(foldCalls.length).toBe(1) // 强制折叠恰好发生一次
    expect(result.outcome).toBe('completed')
    expect(result.turns).toBe(3) // 首次尝试 + 重试文字 + 一次纠偏回合
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
    // 纠偏提醒后确认该文字无需送人，静默收口。
    queue.push({ stopReason: 'end_turn' })
    // 第二次唤醒:确认 mid-episode 内容不被重复投递
    queue.push({ text: '第二次唤醒回复', stopReason: 'end_turn' })
    queue.push({ stopReason: 'end_turn' })

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
            loop.enqueueDuringEpisode(timed({ kind: 'schedule', scheduleId: 'sched-max-tokens', title: '巡检', description: '首次尝试期间注入' }))
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)

    // 预置 3 条历史(同 'max_tokens 收场' 测试),让 force_hot 真正折掉点东西
    const seedMessages: EngineMessage[] = [
      compressibleHistoryMessage('旧消息1'),
      compressibleHistoryMessage('旧消息2'),
      compressibleHistoryMessage('旧消息3'),
    ]
    await store.save({ key: KEY, recent: seedMessages, foldedCount: 0 })

    // 首次唤醒:首次尝试 turn1 成功 + turn2 max_tokens → 强制折叠 + 重试成功
    const first = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('触发 max_tokens 的一句话')] }))
    expect(first.outcome).toBe('completed')
    expect(first.turns).toBe(4) // turn1 + turn2(max_tokens) + 重试文字 + 一次纠偏回合
    expect(first.consumedEvents).toBe(true)

    // 重试(第三次 LLM 调用)的 messages 里应该含有 mid-episode 注入内容
    const nonFoldCalls = calls.filter((c) => !c.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER))
    expect(nonFoldCalls.length).toBe(4) // turn1 + turn2(max_tokens) + 重试文字 + 纠偏回合
    const retryCallMessages = JSON.stringify(nonFoldCalls[2].messages)
    expect(retryCallMessages).toContain('sched-max-tokens')
    expect(retryCallMessages).toContain('首次尝试期间注入')

    // 第二次唤醒:验证 mid-episode 内容已被首次 episode 的重试消费进 state.recent,不会重复投递
    const second = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('新话题')] }))
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
    queue.push({ stopReason: 'end_turn' }) // 纠偏提醒后静默收口

    let loop!: ManagerLoop
    // 在折叠 LLM 调用期间(共享压缩器调 adapter.stream 时)注入一条
    // mid-episode 事件,模拟"事件恰好在两次尝试之间(折叠调用期间)到达"——此时它必然还没被
    // 任何 engine drainPending() 消费过,原样躺在 mailbox.pending 里,同时也被
    // currentEpisodeInjected 记录(两份来源同时存在,正是 review 指出的重复投递触发条件)。
    const injectDuringFold: LLMAdapter = {
      async *stream(params) {
        if (params.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER)) {
          loop.enqueueDuringEpisode(timed({ kind: 'schedule', scheduleId: 'sched-during-fold', title: '巡检', description: '折叠调用期间到达' }))
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
      compressibleHistoryMessage('旧消息1'),
      compressibleHistoryMessage('旧消息2'),
      compressibleHistoryMessage('旧消息3'),
    ]
    await store.save({ key: KEY, recent: seedMessages, foldedCount: 0 })

    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('触发超限')] }))

    expect(result.outcome).toBe('completed')
    expect(result.consumedEvents).toBe(true)
    // retry 包含重试文字与一次纠偏回合；若重复触发了 drain→continue,会多烧第四轮。
    expect(result.turns).toBe(3) // 首次尝试 1 turn(max_tokens)+ 重试 2 turn

    const finalState = await store.load(KEY)
    const occurrences = (JSON.stringify(finalState.recent).match(/sched-during-fold/g) ?? []).length
    expect(occurrences).toBe(1) // 折叠期间到达的内容只应出现一次,不应因 retry 的 turn 边界
    // drain 与显式追加的 currentEpisodeInjected 重复计入
  })

  it('history.length===keepRecent 但完整请求超 hardCap 时继续压缩到更少保留条数', async () => {
    const { adapter, queue, foldCalls } = makeAdapter()
    queue.push({ text: '正常处理', stopReason: 'end_turn' })

    const policy: CompactionPolicy = {
      keepRecent: 3,
      cacheTtlMs: 1_000,
      foldTokenThreshold: 1_000_000,
      hardCapTokens: 1_000_000,
    }
    const loop = new ManagerLoop(baseDeps({
      store,
      adapter,
      policy,
      contextWindowTokens: () => 50_000,
    }))

    // 三条历史恰好等于 keepRecent，但完整请求超过 50K×0.8 hardCap。
    const seedMessages: EngineMessage[] = [
      compressibleHistoryMessage('OVERSIZED_0', 60_000),
      compressibleHistoryMessage('OVERSIZED_1', 60_000),
      compressibleHistoryMessage('OVERSIZED_2', 60_000),
    ]
    await store.save({ key: KEY, recent: seedMessages, foldedCount: 0 })

    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('触发')] }))

    expect(foldCalls).toHaveLength(1)
    expect(result.outcome).toBe('completed')

    const state = await store.load(KEY)
    expect(state.rollingSummary).toBe('折叠后的摘要')
    expect(state.foldedCount).toBe(2)
    expect(JSON.stringify(state.recent)).toContain('OVERSIZED_2')
    expect(JSON.stringify(state.recent)).not.toContain('OVERSIZED_0')
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
    loop.enqueueDuringEpisode(timed({ kind: 'schedule', scheduleId: 'sched-residue', title: '巡检', description: '收口后才到达的残留' }))
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
    const afterDrain = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('新的话')] }))
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
      const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage(`第${i}轮消息`)] }))
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
    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('你好')] }))

    expect(result.outcome).toBe('completed')
    // 语义不变量①:没有任何一轮的上下文里出现过 forced_summary 的文案。
    const allMessages = JSON.stringify(calls.map((c) => c.messages))
    expect(allMessages).not.toContain('你刚才以 end_turn 结束但还没有向人类发送任何内容')
    // 语义不变量②:静默 end_turn 直接被接受为正常完成态,只跑了一轮 LLM。
    expect(calls).toHaveLength(1)
    expect(result.turns).toBe(1)
  })

  it('manager 直接输出文字后注入一次提醒，模型可改用 send_message 发送', async () => {
    const { adapter, calls, queue } = makeAdapter({ autoSettleAssistantTextReminder: false })
    let sent = 0
    queue.push({ text: '需要让人类知道的进度', stopReason: 'end_turn' })
    queue.push({ toolCalls: [{ name: 'send_message', id: 'send-1', input: { content: '需要让人类知道的进度' } }], stopReason: 'tool_use' })
    queue.push({ stopReason: 'end_turn' })

    const loop = new ManagerLoop(baseDeps({
      store,
      adapter,
      toolFace: () => [defineTool({
        name: 'send_message',
        description: 'send a human-visible message',
        inputSchema: { type: 'object', properties: { content: { type: 'string' } } },
        call: async () => {
          sent++
          return { output: 'sent' }
        },
      })],
    }))

    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('进度怎么样')] }))

    expect(sent).toBe(1)
    expect(result.repliedToHuman).toBe(true)
    expect(calls).toHaveLength(3)
    expect(JSON.stringify(calls[1].messages)).toContain('[系统提醒]')
    expect(JSON.stringify(calls[1].messages)).toContain('只有 send_message 发送的内容才能送达人类')
  })

  it('manager 收到提醒后的下一次文字 end_turn 不再重复提醒', async () => {
    const { adapter, calls, queue } = makeAdapter({ autoSettleAssistantTextReminder: false })
    queue.push({ text: '第一次走错通道', stopReason: 'end_turn' })
    queue.push({ text: '第二次仍走错通道', stopReason: 'end_turn' })

    const loop = new ManagerLoop(baseDeps({ store, adapter }))
    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('给我一个答复')] }))

    expect(result.outcome).toBe('completed')
    expect(calls).toHaveLength(2)
    expect(JSON.stringify(calls).match(/\[系统提醒\]/g)).toHaveLength(1)
  })

  it('manager 收到提醒后的下一次静默 end_turn 直接收口，不再继续提醒', async () => {
    const { adapter, calls, queue } = makeAdapter()
    queue.push({ text: '第一次走错通道', stopReason: 'end_turn' })
    queue.push({ stopReason: 'end_turn' })

    const loop = new ManagerLoop(baseDeps({ store, adapter }))
    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('给我一个答复')] }))

    expect(result.outcome).toBe('completed')
    expect(calls).toHaveLength(2)
    expect(JSON.stringify(calls).match(/\[系统提醒\]/g)).toHaveLength(1)
  })

  describe('发送后 Worker 复核', () => {
    function traceRecorder() {
      const states: string[] = []
      return {
        states,
        traceWriter: {
          startEpisode: vi.fn(),
          appendSpan: vi.fn((_traceId, span) => {
            const details = span.details as { kind?: string; state?: string }
            if (details.kind === 'post_send_action' && details.state) states.push(details.state)
          }),
          finishSpan: vi.fn(),
          finishEpisode: vi.fn(),
          addSpawnedWorker: vi.fn(),
        },
      }
    }

    it('send -> end_turn -> recheck -> spawn_worker -> end_turn：仅复核一次，成功派发后清除标记', async () => {
      const { adapter, calls, queue } = makeAdapter()
      const { states, traceWriter } = traceRecorder()
      let loop!: ManagerLoop
      let spawned = 0
      queue.push(
        { toolCalls: [{ name: 'send_message', id: 'send-1', input: { post_send_action: 'spawn_worker' } }], stopReason: 'tool_use' },
        { stopReason: 'end_turn' },
        { toolCalls: [{ name: 'spawn_worker', id: 'spawn-1', input: {} }], stopReason: 'tool_use' },
        { stopReason: 'end_turn' },
      )
      const toolFace = (): ReadonlyArray<ToolDefinition> => [
        defineTool({
          name: 'send_message', description: 'deliver', inputSchema: { type: 'object', properties: {} },
          call: async () => {
            loop.recordPostSendAction()
            return { output: 'sent' }
          },
        }),
        defineTool({
          name: 'spawn_worker', description: 'spawn', inputSchema: { type: 'object', properties: {} },
          call: async () => {
            spawned++
            loop.recordSpawnedWorker('worker-1')
            return { output: 'spawned' }
          },
        }),
      ]
      loop = new ManagerLoop(baseDeps({ store, adapter, toolFace, traceWriter }))

      const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('开始重建')] }))

      expect(result.outcome).toBe('completed')
      expect(spawned).toBe(1)
      expect(calls).toHaveLength(4)
      expect(JSON.stringify(calls[2].messages)).toContain('[系统复核]')
      expect(calls.filter((call) => JSON.stringify(call.messages.at(-1)).includes('[系统复核]'))).toHaveLength(1)
      expect(states).toEqual(['marked', 'recheck_injected', 'cleared'])
    })

    it('send -> end_turn -> recheck -> end_turn：第二次正常终止放行，不重复复核', async () => {
      const { adapter, calls, queue } = makeAdapter()
      const { states, traceWriter } = traceRecorder()
      let loop!: ManagerLoop
      queue.push(
        { toolCalls: [{ name: 'send_message', id: 'send-1', input: { post_send_action: 'spawn_worker' } }], stopReason: 'tool_use' },
        { stopReason: 'end_turn' },
        { stopReason: 'end_turn' },
      )
      loop = new ManagerLoop(baseDeps({
        store,
        adapter,
        traceWriter,
        toolFace: () => [defineTool({
          name: 'send_message', description: 'deliver', inputSchema: { type: 'object', properties: {} },
          call: async () => {
            loop.recordPostSendAction()
            return { output: 'sent' }
          },
        })],
      }))

      const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('告诉我进度')] }))

      expect(result.outcome).toBe('completed')
      expect(calls).toHaveLength(3)
      expect(JSON.stringify(calls).match(/\[系统复核\]/g)).toHaveLength(1)
      expect(states).toEqual(['marked', 'recheck_injected', 'unresolved_accepted'])
    })

    it('maxTurns=1 时仍以带复核提示的 continuation 再调用一次模型', async () => {
      const { adapter, calls, queue } = makeAdapter()
      let loop!: ManagerLoop
      queue.push(
        { toolCalls: [{ name: 'send_message', id: 'send-1', input: { post_send_action: 'spawn_worker' } }], stopReason: 'tool_use' },
        { toolCalls: [{ name: 'spawn_worker', id: 'spawn-1', input: {} }], stopReason: 'tool_use' },
      )
      loop = new ManagerLoop(baseDeps({
        store,
        adapter,
        maxTurns: 1,
        toolFace: () => [
          defineTool({
            name: 'send_message', description: 'deliver', inputSchema: { type: 'object', properties: {} },
            call: async () => {
              loop.recordPostSendAction()
              return { output: 'sent' }
            },
          }),
          defineTool({
            name: 'spawn_worker', description: 'spawn', inputSchema: { type: 'object', properties: {} },
            call: async () => {
              loop.recordSpawnedWorker('worker-1')
              return { output: 'spawned' }
            },
          }),
        ],
      }))

      const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('请重建')] }))

      expect(result.outcome).toBe('max_turns')
      expect(calls).toHaveLength(2)
      expect(JSON.stringify(calls[1].messages)).toContain('[系统复核]')
    })

    it('maxTurns 后复核 continuation 失败时，已提交人类输入不重放', async () => {
      const calls: LLMStreamParams[] = []
      const { states, traceWriter } = traceRecorder()
      let streamCount = 0
      const adapter: LLMAdapter = {
        async *stream(params) {
          calls.push({ ...params, messages: [...params.messages] })
          streamCount++
          if (streamCount === 1) {
            yield* chunksFromContent([
              { type: 'tool_use', id: 'send-1', name: 'send_message', input: { post_send_action: 'spawn_worker' } },
            ], 'tool_use')
            return
          }
          if (streamCount === 2) throw new Error('recheck provider unavailable')
          yield* chunksFromContent([], 'end_turn')
        },
        updateConfig: () => {},
      }
      let loop!: ManagerLoop
      loop = new ManagerLoop(baseDeps({
        store,
        adapter,
        maxTurns: 1,
        traceWriter,
        toolFace: () => [defineTool({
          name: 'send_message', description: 'deliver', inputSchema: { type: 'object', properties: {} },
          call: async () => {
            loop.recordPostSendAction()
            return { output: 'sent' }
          },
        })],
      }))

      const failed = await loop.wakeUp(timed({
        kind: 'human_messages',
        messages: [makeChannelMessage('已经确认入站的人类输入')],
      }))

      expect(failed.outcome).toBe('max_turns')
      expect(failed.consumedEvents).toBe(true)
      expect(JSON.stringify(calls[1].messages)).toContain('[系统复核]')
      expect(states).toEqual(['marked', 'recheck_injected', 'recheck_failed_open', 'unresolved_accepted'])
      expect(JSON.stringify((await store.load(KEY)).recent)).toContain('已经确认入站的人类输入')
      expect(loop.hasPendingMailbox).toBe(false)

      const continued = await loop.wakeUp(timed({
        kind: 'human_messages',
        messages: [makeChannelMessage('下一条新消息')],
      }))

      expect(continued.outcome).toBe('completed')
      expect(JSON.stringify(calls[2].messages)).not.toContain('[系统复核]')
      expect(JSON.stringify(calls[2].messages).match(/已经确认入站的人类输入/g)).toHaveLength(1)
    })

    it('复核 continuation（max_turns 外层）失败时，期间被 drain 的注入人类消息还原回 mailbox 不丢失', async () => {
      // 十审真实风险：外层复核 continuation 的 finalMessages 仅在接管时保留，失败分支
      // 丢弃——期间被 engine drain 掉的注入人类消息文本随之丢失。若收尾只按「已被消费」
      // 补去重键，渠道重投被键挡掉、mailbox 又空（不触发自唤醒）→ 键在文本无=静默永久丢失。
      const { states, traceWriter } = traceRecorder()
      let streamCount = 0
      let loop!: ManagerLoop
      const injectedMsgs: ChannelMessage[] = [
        { ...makeChannelMessage('首次注入的指令'), platform_message_id: 'pm-injected-first' },
        { ...makeChannelMessage('复核期间注入的指令'), platform_message_id: 'pm-injected-recheck' },
      ]
      const adapter: LLMAdapter = {
        async *stream() {
          streamCount++
          if (streamCount === 1) {
            // 第一次尝试 turn1：send（记复核标记）+ noop（tool 内注入）
            yield* chunksFromContent([
              { type: 'tool_use', id: 'send-1', name: 'send_message', input: { post_send_action: 'spawn_worker' } },
              { type: 'tool_use', id: 'noop-1', name: 'noop_tool', input: {} },
            ], 'tool_use')
            return
          }
          if (streamCount === 2) {
            // 第一次尝试 turn2：继续 tool_use，让第一次尝试以 max_turns 收口（走外层复核）
            yield* chunksFromContent([
              { type: 'tool_use', id: 'noop-2', name: 'noop_tool', input: {} },
            ], 'tool_use')
            return
          }
          if (streamCount === 3) {
            // 复核 continuation turn1：noop tool 内注入——该注入在其 turn2 前被 drain 吃掉
            yield* chunksFromContent([
              { type: 'tool_use', id: 'noop-3', name: 'noop_tool', input: {} },
            ], 'tool_use')
            return
          }
          // 复核 continuation turn2：drain 已吃掉注入，此后 continuation 失败——
          // 其 finalMessages（含注入文本）被丢弃
          throw new Error('recheck provider unavailable')
        },
        updateConfig: () => {},
      }
      loop = new ManagerLoop(baseDeps({
        store,
        adapter,
        maxTurns: 2,
        traceWriter,
        toolFace: () => [
          defineTool({
            name: 'send_message', description: 'deliver', inputSchema: { type: 'object', properties: {} },
            call: async () => {
              loop.recordPostSendAction()
              return { output: 'sent' }
            },
          }),
          defineTool({
            name: 'noop_tool', description: 'noop', inputSchema: { type: 'object', properties: {} },
            call: async () => {
              const message = injectedMsgs.shift()
              if (message) {
                await loop.enqueueHumanWakeDuringActiveEpisode(
                  timed({ kind: 'human_messages', messages: [message] }),
                )
              }
              return { output: 'ok', isError: false }
            },
          }),
        ],
      }))

      const failed = await loop.wakeUp(timed({
        kind: 'human_messages',
        messages: [makeChannelMessage('原始请求')],
      }))

      expect(failed.outcome).toBe('max_turns')
      expect(failed.consumedEvents).toBe(true)
      expect(states).toEqual(['marked', 'recheck_injected', 'recheck_failed_open', 'unresolved_accepted'])
      // 修复判据：注入消息未被消费——还原回 mailbox 触发自唤醒，store 无键无文本（同进同出）
      expect(loop.hasPendingMailbox).toBe(true)
      const state = await store.load(KEY)
      expect(JSON.stringify(state.recent)).not.toContain('复核期间注入的指令')
      expect(state.committedHumanMessageIds ?? []).not.toContain('pm-injected-recheck')

      // 自唤醒补跑：注入消息正常提交+投喂
      await loop.drainMailbox()
      const after = await store.load(KEY)
      expect(JSON.stringify(after.recent)).toContain('复核期间注入的指令')
      expect(JSON.stringify(after.recent)).toContain('原始请求')
    })

    it('失败 episode 不保留标记：记录 unresolved_failed，重试时不再注入复核', async () => {
      const calls: LLMStreamParams[] = []
      let streamCount = 0
      const adapter: LLMAdapter = {
        async *stream(params) {
          calls.push({ ...params, messages: [...params.messages] })
          streamCount++
          if (streamCount === 1) {
            yield* chunksFromContent([
              { type: 'tool_use', id: 'send-1', name: 'send_message', input: { post_send_action: 'spawn_worker' } },
            ], 'tool_use')
            return
          }
          if (streamCount === 2) throw new Error('provider unavailable')
          yield* chunksFromContent([], 'end_turn')
        },
        updateConfig: () => {},
      }
      const { states, traceWriter } = traceRecorder()
      let loop!: ManagerLoop
      loop = new ManagerLoop(baseDeps({
        store,
        adapter,
        traceWriter,
        toolFace: () => [defineTool({
          name: 'send_message', description: 'deliver', inputSchema: { type: 'object', properties: {} },
          call: async () => {
            loop.recordPostSendAction()
            return { output: 'sent' }
          },
        })],
      }))

      const failed = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('先告知再重建')] }))
      const retried = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('继续处理')] }))

      expect(failed.outcome).toBe('failed')
      expect(failed.consumedEvents).toBe(false)
      expect(states).toContain('unresolved_failed')
      expect(retried.outcome).toBe('completed')
      expect(JSON.stringify(calls[2].messages)).not.toContain('[系统复核]')
    })
  })

  // --- EpisodeResult.repliedToHuman(P7 J Task 3.1:群聊注意力退避的 `replied` 信号) ---

  describe('EpisodeResult.repliedToHuman', () => {
    /** 让 engine 有真工具可执行,避免 tool_use 落到"工具不存在"的错误分支上。 */
    function replyToolFace(): ReadonlyArray<ToolDefinition> {
      return ['send_message', 'send_private_message', 'send_master_private', 'send_daily_reflection_summary', 'spawn_worker', 'get_history'].map((name) =>
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
      const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('群里有人闲聊')] }))

      // outcome 答不了这个问题——沉默和回话都是 completed,这正是需要单独一个字段的理由。
      expect(result.outcome).toBe('completed')
      expect(result.repliedToHuman).toBe(false)
    })

    it('manager 说话(调 send_message)→ repliedToHuman === true', async () => {
      const { adapter, queue } = makeAdapter()
      queue.push({ toolCalls: [{ name: 'send_message', id: 't1', input: { content: '好的' } }], stopReason: 'tool_use' })
      queue.push({ text: '已回复', stopReason: 'end_turn' })

      const loop = new ManagerLoop(baseDeps({ store, adapter, toolFace: replyToolFace }))
      const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('在吗')] }))

      expect(result.outcome).toBe('completed')
      expect(result.repliedToHuman).toBe(true)
    })

    it('私聊、reach_master 和每日反思摘要同样算"跟人说话"(投递到人 = 有人被打扰)', async () => {
      for (const toolName of ['send_private_message', 'send_master_private', 'send_daily_reflection_summary']) {
        const { adapter, queue } = makeAdapter()
        queue.push({ toolCalls: [{ name: toolName, id: 't1', input: {} }], stopReason: 'tool_use' })
        queue.push({ text: '已私下回复', stopReason: 'end_turn' })

        const isolatedStore = new ManagerSessionStore(join(dataDir, `store-${toolName}`))
        const loop = new ManagerLoop(baseDeps({ store: isolatedStore, adapter, toolFace: replyToolFace }))
        const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('私下问一句')] }))

        expect(result.repliedToHuman).toBe(true)
      }
    })

    it('只派活不说话(spawn_worker)→ repliedToHuman === false(worker 不直接跟人类说话)', async () => {
      const { adapter, queue } = makeAdapter()
      queue.push({ toolCalls: [{ name: 'spawn_worker', id: 't1', input: {} }], stopReason: 'tool_use' })
      queue.push({ text: '已派活', stopReason: 'end_turn' })

      const loop = new ManagerLoop(baseDeps({ store, adapter, toolFace: replyToolFace }))
      const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('帮我查个东西')] }))

      expect(result.repliedToHuman).toBe(false)
    })

    it('只读工具(get_history)不算说话', async () => {
      const { adapter, queue } = makeAdapter()
      queue.push({ toolCalls: [{ name: 'get_history', id: 't1', input: {} }], stopReason: 'tool_use' })
      queue.push({ text: '看完了,不回', stopReason: 'end_turn' })

      const loop = new ManagerLoop(baseDeps({ store, adapter, toolFace: replyToolFace }))
      const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('之前说到哪了')] }))

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

  describe('任务巡检 episode', () => {
    it('只读的默认巡检会在完整 trace 落账后压缩为本地历史摘要', async () => {
      const { adapter, queue } = makeAdapter()
      queue.push(
        { toolCalls: [{ name: 'get_worker_terminal', id: 'read-1', input: { worker_id: 'w-supervised' } }], stopReason: 'tool_use' },
        { stopReason: 'end_turn' },
      )
      const loop = new ManagerLoop(baseDeps({
        store,
        adapter,
        toolFace: () => [defineTool({
          name: 'get_worker_terminal',
          description: 'read only',
          inputSchema: { type: 'object', properties: { worker_id: { type: 'string' } } },
          isReadOnly: true,
          call: async () => ({ output: 'worker output', isError: false }),
        })],
      }))

      const result = await loop.wakeUp(defaultSupervisionWake('w-supervised', 'due-read-only'))

      expect(result.outcome).toBe('completed')
      const state = await store.load(KEY)
      expect(state.recent).toHaveLength(1)
      expect(JSON.stringify(state.recent)).toContain('[任务巡检摘要] worker_id=w-supervised')
      expect(JSON.stringify(state.recent)).not.toContain('due-read-only')
    })

    it('原生 worker 查询工具同样保留默认巡检的本地历史压缩', async () => {
      for (const toolName of ['get_worker_state', 'get_worker_activity', 'get_worker_turn']) {
        const { adapter, queue } = makeAdapter()
        queue.push(
          { toolCalls: [{ name: toolName, id: `read-${toolName}`, input: { worker_id: 'w-supervised' } }], stopReason: 'tool_use' },
          { stopReason: 'end_turn' },
        )
        const isolatedStore = new ManagerSessionStore(join(dataDir, `supervision-${toolName}`))
        const loop = new ManagerLoop(baseDeps({
          store: isolatedStore,
          adapter,
          toolFace: () => [defineTool({
            name: toolName,
            description: 'read only',
            inputSchema: { type: 'object', properties: { worker_id: { type: 'string' } } },
            isReadOnly: true,
            call: async () => ({ output: 'worker state', isError: false }),
          })],
        }))

        await loop.wakeUp(defaultSupervisionWake('w-supervised', `due-${toolName}`))

        const state = await isolatedStore.load(KEY)
        expect(state.recent).toHaveLength(1)
        expect(JSON.stringify(state.recent)).toContain('[任务巡检摘要] worker_id=w-supervised')
      }
    })

    it('默认巡检一旦发送消息或写记忆，就保留完整 episode 历史', async () => {
      for (const toolName of ['send_message', 'mcp__crab-memory__store_memory']) {
        const { adapter, queue } = makeAdapter()
        queue.push(
          { toolCalls: [{ name: toolName, id: `call-${toolName}`, input: {} }], stopReason: 'tool_use' },
          { stopReason: 'end_turn' },
        )
        const isolatedStore = new ManagerSessionStore(join(dataDir, `supervision-${toolName}`))
        const loop = new ManagerLoop(baseDeps({
          store: isolatedStore,
          adapter,
          toolFace: () => [defineTool({
            name: toolName,
            description: 'side effect',
            inputSchema: { type: 'object', properties: {} },
            call: async () => ({ output: 'ok', isError: false }),
          })],
        }))

        await loop.wakeUp(defaultSupervisionWake('w-supervised', `due-${toolName}`))

        const state = await isolatedStore.load(KEY)
        expect(JSON.stringify(state.recent)).toContain(`due-${toolName}`)
        expect(JSON.stringify(state.recent)).not.toContain('[任务巡检摘要]')
      }
    })
  })

  describe('EpisodeResult.successfulSendMessageTargets', () => {
    async function runSendMessageCase(input: Record<string, unknown>, isError = false) {
      const { adapter, queue } = makeAdapter()
      queue.push(
        { toolCalls: [{ name: 'send_message', id: 'send-1', input }], stopReason: 'tool_use' },
        { stopReason: 'end_turn' },
      )
      const loop = new ManagerLoop(baseDeps({
        store,
        adapter,
        toolFace: () => [defineTool({
          name: 'send_message',
          description: 'deliver',
          inputSchema: { type: 'object', properties: {} },
          call: async () => ({ output: 'delivery result', isError }),
        })],
      }))
      return loop.wakeUp(timed({
        kind: 'worker_event',
        event: {
          ts: '2026-01-01T00:00:00.000Z',
          kind: 'supervision_due',
          worker_id: 'w-periodic',
          seq: 1,
          detail: {
            mode: 'periodic_report',
            due_id: 'due-periodic',
            mainline_seq: 1,
            observation: 'tool_only',
            report_to: { channel_id: 'feishu', session_id: 'target-session' },
          },
        },
      }))
    }

    it('只记录成功 send_message 的精确目标', async () => {
      const success = await runSendMessageCase({ channel_id: 'feishu', session_id: 'target-session', content: '进度' })
      expect(success.successfulSendMessageTargets).toEqual([{ channel_id: 'feishu', session_id: 'target-session' }])

      const wrongTarget = await runSendMessageCase({ channel_id: 'feishu', session_id: 'another-session', content: '进度' })
      expect(wrongTarget.successfulSendMessageTargets).toEqual([{ channel_id: 'feishu', session_id: 'another-session' }])

      const failed = await runSendMessageCase({ channel_id: 'feishu', session_id: 'target-session', content: '进度' }, true)
      expect(failed.successfulSendMessageTargets).toEqual([])
    })

    it('repair 后的真实成功目标进入 EpisodeResult，并与 raw tool_use 证据去重', async () => {
      const { adapter, queue } = makeAdapter()
      queue.push(
        { toolCalls: [{ name: 'send_message', id: 'send-1', input: { session_id: 'target-session', content: '进度' } }], stopReason: 'tool_use' },
        { stopReason: 'end_turn' },
      )
      let loop: ManagerLoop
      loop = new ManagerLoop(baseDeps({
        store,
        adapter,
        toolFace: () => [defineTool({
          name: 'send_message',
          description: 'deliver',
          inputSchema: { type: 'object', properties: {} },
          repairInput: async (input) => ({ ...input, channel_id: 'feishu' }),
          call: async (input) => {
            loop.recordSuccessfulSendMessage({
              channel_id: input.channel_id as string,
              session_id: input.session_id as string,
            })
            return { output: 'delivery result', isError: false }
          },
        })],
      }))

      const result = await loop.wakeUp(timed({
        kind: 'worker_event',
        event: {
          ts: '2026-01-01T00:00:00.000Z',
          kind: 'supervision_due',
          worker_id: 'w-periodic',
          seq: 1,
          detail: {
            mode: 'periodic_report',
            due_id: 'due-periodic-repaired',
            mainline_seq: 1,
            observation: 'tool_only',
            report_to: { channel_id: 'feishu', session_id: 'target-session' },
          },
        },
      }))

      expect(result.successfulSendMessageTargets).toEqual([
        { channel_id: 'feishu', session_id: 'target-session' },
      ])
    })

    it('callback 与 raw tool_use 指向同一成功目标时只记录一次；失败发送不写 callback 证据', async () => {
      const { adapter, queue } = makeAdapter()
      queue.push(
        { toolCalls: [{ name: 'send_message', id: 'send-1', input: { channel_id: 'feishu', session_id: 'target-session' } }], stopReason: 'tool_use' },
        { stopReason: 'end_turn' },
      )
      let loop: ManagerLoop
      loop = new ManagerLoop(baseDeps({
        store,
        adapter,
        toolFace: () => [defineTool({
          name: 'send_message',
          description: 'deliver',
          inputSchema: { type: 'object', properties: {} },
          call: async (input) => {
            loop.recordSuccessfulSendMessage({
              channel_id: input.channel_id as string,
              session_id: input.session_id as string,
            })
            return { output: 'delivery result', isError: false }
          },
        })],
      }))

      const result = await loop.wakeUp(defaultSupervisionWake('w-periodic', 'due-periodic-dedupe'))
      expect(result.successfulSendMessageTargets).toEqual([
        { channel_id: 'feishu', session_id: 'target-session' },
      ])

      const failed = await runSendMessageCase({ session_id: 'target-session', content: '进度' }, true)
      expect(failed.successfulSendMessageTargets).toEqual([])
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
      const isolatedStore = new ManagerSessionStore(join(dataDir, `render-${Math.random().toString(36).slice(2)}`))
      const loop = new ManagerLoop(baseDeps({ store: isolatedStore, adapter, timezone: () => 'UTC' }))
      await loop.wakeUp({ wake: event, received_at: '2026-01-01T00:00:00+00:00', timezone: 'UTC' })
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

// --- 入站图片视觉注入(恢复 P7 拆分丢失的能力,见 manager/image-vision.ts) ---

describe('ManagerLoop 入站图片视觉注入', () => {
  let dataDir: string
  let store: ManagerSessionStore
  let mediaDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'manager-loop-vision-'))
    store = new ManagerSessionStore(join(dataDir, 'manager-sessions'))
    mediaDir = await fs.mkdtemp(join(tmpdir(), 'manager-loop-media-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(mediaDir, { recursive: true, force: true })
  })

  function imageMessage(filename: string, mediaUrl: string): ChannelMessage {
    return {
      platform_message_id: `pm-img-${Math.random().toString(36).slice(2)}`,
      session: { session_id: 'sess-loop', channel_id: 'wechat', type: 'private' },
      sender: { platform_user_id: 'u1', platform_display_name: '测试用户' },
      content: {
        type: 'image',
        text: '你自己看正常不正常？！',
        media: [{ media_url: mediaUrl, mime_type: 'image/png', filename, size: 8 }],
        media_url: mediaUrl,
        status: 'ready',
      },
      features: { is_mention_crab: false },
      platform_timestamp: new Date().toISOString(),
    }
  }

  function firstUserContent(call: LLMStreamParams): EngineMessage['content'] {
    return call.messages.find((m) => m.role === 'user')?.content as EngineMessage['content']
  }

  it('VLM + 图片在盘:episode 输入的 user message 变 [text(无标记), ...ImageBlock]', async () => {
    const png = join(mediaDir, 'vis-ok.png')
    await fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const { adapter, calls } = makeAdapter()
    const loop = new ManagerLoop(baseDeps({ store, adapter, supportsVision: () => true }))
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [imageMessage('vis-ok.png', png)] }))

    const content = firstUserContent(calls[0]) as Array<{ type: string; text?: string; source?: { data: string } }>
    expect(Array.isArray(content)).toBe(true)
    expect(content[0].type).toBe('text')
    expect(content[0].text).not.toContain('[图片:')
    const imageBlocks = content.filter((b) => b.type === 'image')
    expect(imageBlocks).toHaveLength(1)
    expect(imageBlocks[0].source?.data).toBe((await fs.readFile(png)).toString('base64'))
  })

  it('图片已被 GC:不注入 ImageBlock,标记改写为过期提示,不再原文残留', async () => {
    const missing = join(mediaDir, 'vis-gone.png')
    const { adapter, calls } = makeAdapter()
    const loop = new ManagerLoop(baseDeps({ store, adapter, supportsVision: () => true }))
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [imageMessage('vis-gone.png', missing)] }))

    const content = firstUserContent(calls[0])
    expect(typeof content).toBe('string')
    expect(content as string).toContain('vis-gone.png')
    expect(content as string).toContain('文件不可用，无法查看')
  })

  it('非 VLM(supportsVision 未注入/false):纯文本不变,标记保留', async () => {
    const png = join(mediaDir, 'vis-no.png')
    await fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const { adapter, calls } = makeAdapter()
    const loop = new ManagerLoop(baseDeps({ store, adapter }))
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [imageMessage('vis-no.png', png)] }))

    const content = firstUserContent(calls[0])
    expect(typeof content).toBe('string')
    expect(content as string).toContain('[图片: vis-no.png]')
  })

  it('review P1 回归守卫:注入只作 LLM 投影——state.json 与 episode log 落盘的是原始纯文本,无 base64', async () => {
    const png = join(mediaDir, 'persist-ok.png')
    await fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const { adapter } = makeAdapter()
    const loop = new ManagerLoop(baseDeps({ store, adapter, supportsVision: () => true }))
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [imageMessage('persist-ok.png', png)] }))

    // store 布局:<root>/<key目录>/state.json + episodes/<id>.jsonl——不猜 key 目录名,按后缀找
    const allFiles: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) await walk(p)
        else allFiles.push(p)
      }
    }
    await walk(dataDir)
    const stateFile = allFiles.find((f) => f.endsWith('state.json'))
    expect(stateFile).toBeTruthy()
    const raw = await fs.readFile(stateFile!, 'utf8')
    expect(raw).not.toContain('"data"')        // base64 数据块
    expect(raw).not.toContain('"source"')      // image source 结构
    expect(raw).toContain('[图片: persist-ok.png]')  // 原始渲染文本保留,下个 episode 幂等重注入
    // episode log 同样不落 base64
    const episodeLogs = allFiles.filter((f) => f.includes('episodes') && f.endsWith('.jsonl'))
    expect(episodeLogs.length).toBeGreaterThan(0)
    for (const f of episodeLogs) {
      const content = await fs.readFile(f, 'utf8')
      expect(content).not.toContain('"source"')
      expect(content).not.toContain('"data"')
    }
  })

  it('review P1 回归守卫:遗留单图形态(feishu 普通单图 file_path,标记为完整路径)也能注入', async () => {
    const png = join(mediaDir, 'single-feishu.png')
    await fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const { adapter, calls } = makeAdapter()
    const loop = new ManagerLoop(baseDeps({ store, adapter, supportsVision: () => true }))
    const message: ChannelMessage = {
      ...imageMessage('ignored.png', png),
      content: {
        type: 'image',
        text: '你自己看正常不正常？！',
        file_path: png,
        status: 'ready',
        mime_type: 'image/png',
      },
    }
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [message] }))

    const content = firstUserContent(calls[0]) as Array<{ type: string; text?: string; source?: { data: string } }>
    expect(Array.isArray(content)).toBe(true)
    expect(content[0].text).not.toContain('[图片:')
    expect(content.filter((b) => b.type === 'image')).toHaveLength(1)
  })

  it('插话带图(本地图):当轮 turn 边界以 ContentBlock[] 注入,落盘无 base64 且补记 imageRefs', async () => {
    const png = join(mediaDir, 'inject-live.png')
    await fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const { adapter, queue, calls } = makeAdapter()
    queue.push({ toolCalls: [{ name: 'noop_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' })
    queue.push({ stopReason: 'end_turn' })
    let loop!: ManagerLoop
    const deps = baseDeps({
      store,
      adapter,
      supportsVision: () => true,
      toolFace: () => [
        {
          name: 'noop_tool',
          description: 'noop',
          inputSchema: { type: 'object', properties: {} },
          isReadOnly: false,
          call: async () => {
            await loop.enqueueHumanWakeDuringActiveEpisode(
              timed({ kind: 'human_messages', messages: [imageMessage('inject-live.png', png)] }),
            )
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('开始干活')] }))

    // 当轮 turn2:supplement 以数组 content 注入(text + ImageBlock)
    const supplement = calls[1].messages.find(
      (m) => m.role === 'user' && 'content' in m && Array.isArray(m.content),
    ) as { content: Array<{ type: string; text?: string; source?: { data: string } }> } | undefined
    expect(supplement).toBeTruthy()
    expect(supplement!.content[0].text).toContain('inject-live.png')
    expect(supplement!.content.filter((b) => b.type === 'image')).toHaveLength(1)

    // 落盘守卫:state 无 base64,文本标记原样,imageRefs 已补记(下一 episode 幂等重注入)
    const stateAfter = await store.load(KEY)
    expect(JSON.stringify(stateAfter.recent)).not.toContain('"source"')
    expect(JSON.stringify(stateAfter.recent)).toContain('[图片: inject-live.png]')
    expect(stateAfter.imageRefs?.length).toBeGreaterThan(0)

    // 下一 episode:图从 imageRefs 重新注入
    queue.push({ text: '看到了', stopReason: 'end_turn' })
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('图怎么样')] }))
    const nextTurnUser = calls[2].messages.filter(
      (m) => m.role === 'user' && 'content' in m && Array.isArray(m.content),
    )
    expect(nextTurnUser.length).toBeGreaterThan(0)
  })

  it('插话带远程 URL 图(wechat CDN):enqueue 预取就绪 → 当轮 ImageBlock,标记原样无降级文案', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      { status: 200 },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const { adapter, queue, calls } = makeAdapter()
    queue.push({ toolCalls: [{ name: 'noop_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' })
    queue.push({ stopReason: 'end_turn' })
    let loop!: ManagerLoop
    const deps = baseDeps({
      store,
      adapter,
      supportsVision: () => true,
      toolFace: () => [
        {
          name: 'noop_tool',
          description: 'noop',
          inputSchema: { type: 'object', properties: {} },
          isReadOnly: false,
          call: async () => {
            await loop.enqueueHumanWakeDuringActiveEpisode(
              timed({ kind: 'human_messages', messages: [imageMessage('cdn.jpg', 'https://cdn.example.com/cdn.jpg')] }),
            )
            // 线上 enqueue→drain 隔着真实工具执行(宏任务级),预取必然就绪;
            // mock 立即 resolve 全在微任务级,补一拍让 then 回调 flush,等价线上时序
            await new Promise((resolve) => setTimeout(resolve, 0))
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('开始干活')] }))
    vi.unstubAllGlobals()

    // 当轮:supplement 为数组 content(text + ImageBlock),无任何「文件不可用」降级文案
    const supplement = calls[1].messages.find(
      (m) => m.role === 'user' && 'content' in m && Array.isArray(m.content),
    ) as { content: Array<{ type: string; text?: string; source?: { data: string } }> } | undefined
    expect(supplement).toBeTruthy()
    expect(supplement!.content[0].text).toContain('cdn.jpg')
    expect(supplement!.content[0].text).not.toContain('文件不可用')
    expect(supplement!.content.filter((b) => b.type === 'image')).toHaveLength(1)

    // 落盘守卫:无 base64、标记原样、imageRefs 已补记
    const stateAfter = await store.load(KEY)
    expect(JSON.stringify(stateAfter.recent)).not.toContain('"source"')
    expect(JSON.stringify(stateAfter.recent)).toContain('[图片: cdn.jpg]')
    expect(JSON.stringify(stateAfter.imageRefs)).toContain('https://cdn.example.com/cdn.jpg')
  })

  it('插话远程图预取未就绪:当轮保留标记原样(不臆断原因),imageRefs 补记供下一轮 fetch', async () => {
    // fetch 永不 resolve → drain 时预取未就绪 → 降级为纯文本且标记不改写
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}))
    const { adapter, queue, calls } = makeAdapter()
    queue.push({ toolCalls: [{ name: 'noop_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' })
    queue.push({ stopReason: 'end_turn' })
    let loop!: ManagerLoop
    const deps = baseDeps({
      store,
      adapter,
      supportsVision: () => true,
      toolFace: () => [
        {
          name: 'noop_tool',
          description: 'noop',
          inputSchema: { type: 'object', properties: {} },
          isReadOnly: false,
          call: async () => {
            await loop.enqueueHumanWakeDuringActiveEpisode(
              timed({ kind: 'human_messages', messages: [imageMessage('cdn.jpg', 'https://cdn.example.com/cdn.jpg')] }),
            )
            // 线上 enqueue→drain 隔着真实工具执行(宏任务级),预取必然就绪;
            // mock 立即 resolve 全在微任务级,补一拍让 then 回调 flush,等价线上时序
            await new Promise((resolve) => setTimeout(resolve, 0))
            return { output: 'ok', isError: false }
          },
        },
      ],
    })
    loop = new ManagerLoop(deps)
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeChannelMessage('开始干活')] }))
    vi.unstubAllGlobals()

    const supplements = calls[1].messages.filter((m) => m.role === 'user' && 'content' in m && typeof m.content === 'string')
    const supplementText = supplements.map((m) => (m as { content: string }).content).join('\n')
    expect(supplementText).toContain('[图片: cdn.jpg]')
    expect(supplementText).not.toContain('文件不可用')
    expect(calls[1].messages.some((m) => m.role === 'user' && 'content' in m && Array.isArray(m.content))).toBe(false)

    // imageRefs 已补记,下一 episode fetch 重试且 marker 可正常匹配
    const stateAfter = await store.load(KEY)
    expect(stateAfter.imageRefs?.length).toBeGreaterThan(0)
    expect(JSON.stringify(stateAfter.recent)).toContain('[图片: cdn.jpg]')
  })
})
