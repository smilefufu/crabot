import { describe, it, expect } from 'vitest'
import {
  decideCompaction,
  foldIntoSummary,
  type CompactionPolicy,
} from '../../src/manager/compaction'
import type { ManagerSessionState, ManagerKey } from '../../src/manager/types'
import { createUserMessage, createAssistantMessage, createToolResultMessage } from '../../src/engine/index.js'
import type { EngineMessage, LLMAdapter, LLMStreamParams, StreamChunk } from '../../src/engine/index.js'

const KEY: ManagerKey = 'wechat::sess-compaction'

/** 简单确定性 policy:keepRecent=3,cacheTtl=1000ms,foldTokenThreshold=100,hardCapTokens=500 */
const POLICY: CompactionPolicy = {
  keepRecent: 3,
  cacheTtlMs: 1000,
  foldTokenThreshold: 100,
  hardCapTokens: 500,
}

/** 每条消息计 50 token,数量可控、无需真实分词 */
const estimateTokens = (msgs: ReadonlyArray<EngineMessage>): number => msgs.length * 50

function makeHistory(count: number): EngineMessage[] {
  return Array.from({ length: count }, (_, i) => createUserMessage(`msg-${i}`))
}

function baseState(overrides: Partial<ManagerSessionState>): ManagerSessionState {
  return { key: KEY, recent: [], foldedCount: 0, ...overrides }
}

describe('decideCompaction', () => {
  it('热(未超 TTL)且总 token 未超硬上限 → none', () => {
    const history = makeHistory(5) // > keepRecent(3),排除"不足 K 条"分支
    const nowMs = 10_000
    const state = baseState({ recent: history, lastActiveAt: new Date(nowMs - 500).toISOString() }) // 距上次活动 500ms < TTL 1000ms → 热

    const decision = decideCompaction({ state, nowMs, policy: POLICY, estimateTokens })

    expect(decision).toEqual({ kind: 'none' })
  })

  it('热(未超 TTL)但总 token 超硬上限 → force_hot', () => {
    const history = makeHistory(12) // 12*50=600 > hardCapTokens(500)
    const nowMs = 10_000
    const state = baseState({ recent: history, lastActiveAt: new Date(nowMs - 500).toISOString() }) // 仍热

    const decision = decideCompaction({ state, nowMs, policy: POLICY, estimateTokens })

    expect(decision.kind).toBe('force_hot')
    if (decision.kind !== 'force_hot') throw new Error('unreachable')
    expect(decision.keep).toEqual(history.slice(-3))
    expect(decision.foldMessages).toEqual(history.slice(0, -3))
  })

  it('冷(超 TTL)但待折叠历史 token 未超阈值 → none', () => {
    const history = makeHistory(5) // foldMessages = 前 2 条,2*50=100,不 > threshold(100)
    const nowMs = 10_000
    const state = baseState({ recent: history, lastActiveAt: new Date(nowMs - 2000).toISOString() }) // 距上次活动 2000ms > TTL 1000ms → 冷

    const decision = decideCompaction({ state, nowMs, policy: POLICY, estimateTokens })

    expect(decision).toEqual({ kind: 'none' })
  })

  it('冷(超 TTL)且待折叠历史 token 超阈值 → fold_at_wake', () => {
    const history = makeHistory(8) // foldMessages = 前 5 条,5*50=250 > threshold(100)
    const nowMs = 10_000
    const state = baseState({ recent: history, lastActiveAt: new Date(nowMs - 2000).toISOString() }) // 冷

    const decision = decideCompaction({ state, nowMs, policy: POLICY, estimateTokens })

    expect(decision.kind).toBe('fold_at_wake')
    if (decision.kind !== 'fold_at_wake') throw new Error('unreachable')
    expect(decision.keep).toEqual(history.slice(-3))
    expect(decision.foldMessages).toEqual(history.slice(0, -3))
  })

  it('历史条数不足 keepRecent 时一律 none(即便冷且 token 理论上会超阈值)', () => {
    const history = makeHistory(2) // < keepRecent(3)
    const nowMs = 10_000
    const state = baseState({ recent: history, lastActiveAt: new Date(nowMs - 5000).toISOString() }) // 很冷

    const decision = decideCompaction({ state, nowMs, policy: POLICY, estimateTokens })

    expect(decision).toEqual({ kind: 'none' })
  })

  it('keep 恰为最后 K 条、foldMessages 为其余部分,拼接后与原历史逐条一致且不重不漏', () => {
    const history = makeHistory(8)
    const nowMs = 10_000
    const state = baseState({ recent: history, lastActiveAt: new Date(nowMs - 2000).toISOString() })

    const decision = decideCompaction({ state, nowMs, policy: POLICY, estimateTokens })
    if (decision.kind === 'none') throw new Error('expected a compaction decision')

    expect(decision.keep.length).toBe(POLICY.keepRecent)
    expect(decision.foldMessages.length).toBe(history.length - POLICY.keepRecent)
    // 引用相同(未克隆/未重建消息对象)——slice 语义
    decision.foldMessages.forEach((m, i) => expect(m).toBe(history[i]))
    decision.keep.forEach((m, i) => expect(m).toBe(history[history.length - POLICY.keepRecent + i]))
    // 不重不漏:拼接回去与原历史相同
    expect([...decision.foldMessages, ...decision.keep]).toEqual(history)
  })

  it('lastActiveAt 缺失(首次)按"未冷"处理:历史充足但未超硬上限 → none', () => {
    const history = makeHistory(5) // 5*50=250,未超 hardCapTokens(500)
    const nowMs = 10_000
    const state = baseState({ recent: history }) // 无 lastActiveAt

    const decision = decideCompaction({ state, nowMs, policy: POLICY, estimateTokens })

    expect(decision).toEqual({ kind: 'none' })
  })

  it('lastActiveAt 缺失 + 历史异常超过硬上限(防御性场景) → 仍用 force_hot 兜底,不会因缺失活动时间而放任 token 失控', () => {
    const history = makeHistory(12) // 12*50=600 > hardCapTokens(500)
    const nowMs = 10_000
    const state = baseState({ recent: history }) // 无 lastActiveAt

    const decision = decideCompaction({ state, nowMs, policy: POLICY, estimateTokens })

    expect(decision.kind).toBe('force_hot')
  })

  it('history.length === keepRecent 且超 hardCap 时 force_hot 应返回 none(splitAt=0 无东西可折,避免零进展空折叠)', () => {
    const policy: CompactionPolicy = { keepRecent: 3, cacheTtlMs: 1000, foldTokenThreshold: 100, hardCapTokens: 100 }
    const history = makeHistory(3) // === keepRecent(3) → splitAt=0,foldMessages=[];3*50=150 > hardCapTokens(100)
    const nowMs = 10_000
    const state = baseState({ recent: history, lastActiveAt: new Date(nowMs - 500).toISOString() }) // 热,走 force_hot 分支

    const decision = decideCompaction({ state, nowMs, policy, estimateTokens })

    expect(decision).toEqual({ kind: 'none' })
  })

  it('前缀稳定性:同一 state 追加一条消息后,序列化的"静态段(摘要+历史)"前缀逐字节不变', () => {
    // 模拟真实用法:rollingSummary + recent 拼接成发给 LLM 的静态前缀。
    // 只要 decideCompaction 在同一 regime(此处均为 none)下不改写/不重建已有消息,
    // 追加新消息时前缀天然只在末尾增长,这正是 prompt cache 命中率的直接代理指标。
    const renderPrefix = (state: ManagerSessionState): string =>
      (state.rollingSummary ?? '') + '\n---\n' + state.recent.map((m) => JSON.stringify(m)).join('\n')

    const history = makeHistory(5) // 5*50=250,none 分支(热且未超硬上限)
    const nowMs = 10_000
    const state1 = baseState({
      recent: history,
      rollingSummary: '此前对话摘要文本',
      lastActiveAt: new Date(nowMs - 500).toISOString(),
    })
    const decision1 = decideCompaction({ state: state1, nowMs, policy: POLICY, estimateTokens })
    expect(decision1).toEqual({ kind: 'none' })
    const prefix1 = renderPrefix(state1)

    const state2: ManagerSessionState = {
      ...state1,
      recent: [...state1.recent, createUserMessage('msg-5-新追加')],
    }
    const decision2 = decideCompaction({ state: state2, nowMs, policy: POLICY, estimateTokens })
    expect(decision2).toEqual({ kind: 'none' })
    const prefix2 = renderPrefix(state2)

    expect(prefix2.startsWith(prefix1)).toBe(true)
    expect(prefix2.slice(0, prefix1.length)).toBe(prefix1)
  })

  it('裸下标切点恰好落在 assistant(tool_use)与其 toolResults 之间时,应回退切点避免孤儿 tool_result 进 keep 头部', () => {
    // keepRecent=2、history 长度 4 → 裸切点 splitAt = 4-2 = 2,history[2] 正是 toolResults——
    // 若不回退,keep=[toolResults2, user3] 会把孤儿 tool_result(其配对的 tool_use 已被折进
    // foldMessages)放在 keep[0],发给 LLM 会触发 API 400。
    const policy: CompactionPolicy = { keepRecent: 2, cacheTtlMs: 1000, foldTokenThreshold: 100, hardCapTokens: 100 }
    const history: EngineMessage[] = [
      createUserMessage('user-0'),
      createAssistantMessage([{ type: 'tool_use', id: 'tu_X', name: 'search', input: { q: 'foo' } }], 'tool_use'),
      createToolResultMessage('tu_X', 'Found something', false),
      createUserMessage('user-3'),
    ]
    const nowMs = 10_000
    // 热(未超 TTL)但 4*50=200 > hardCapTokens(100) → force_hot 分支,走同一份 findSafeSplitIndex
    const state = baseState({ recent: history, lastActiveAt: new Date(nowMs - 500).toISOString() })

    const decision = decideCompaction({ state, nowMs, policy, estimateTokens })

    expect(decision.kind).toBe('force_hot')
    if (decision.kind !== 'force_hot') throw new Error('unreachable')
    // keep[0] 不是孤儿 tool_result
    expect('toolResults' in decision.keep[0]).toBe(false)
    expect(decision.keep[0]).toBe(history[1]) // assistant(tool_use) 被拉回 keep
    expect(decision.keep[1]).toBe(history[2]) // 紧跟着它匹配的 toolResults
    expect(decision.keep.length).toBe(3) // 比 keepRecent(2) 多——有意的取舍(注释已说明)
    // 不重不漏
    expect([...decision.foldMessages, ...decision.keep]).toEqual(history)
  })

  it('多条连续 toolResults 消息时,切点应持续回退直到落在非 toolResults 消息(或 0),不留孤儿', () => {
    // 人为构造两条连续 toolResults(真实 episode 里不会自然出现,但 findSafeSplitIndex 的
    // while 循环需要正确处理这一防御性场景,与 context-manager.ts 的 findSafeSplitIndex 同款写法)。
    const policy: CompactionPolicy = { keepRecent: 2, cacheTtlMs: 1000, foldTokenThreshold: 100, hardCapTokens: 100 }
    const history: EngineMessage[] = [
      createUserMessage('user-0'),
      createAssistantMessage([{ type: 'tool_use', id: 'tu_A', name: 'search', input: {} }], 'tool_use'),
      createToolResultMessage('tu_A', 'result-A', false),
      createToolResultMessage('tu_A_extra', 'result-A-extra', false),
      createUserMessage('user-4'),
    ]
    const nowMs = 10_000
    // 裸切点 splitAt = 5-2 = 3 → history[3] 是 toolResults,回退到 2 仍是 toolResults,
    // 再回退到 1(assistant)才停下。
    const state = baseState({ recent: history, lastActiveAt: new Date(nowMs - 500).toISOString() })

    const decision = decideCompaction({ state, nowMs, policy, estimateTokens })

    expect(decision.kind).toBe('force_hot')
    if (decision.kind !== 'force_hot') throw new Error('unreachable')
    expect('toolResults' in decision.keep[0]).toBe(false)
    expect(decision.keep[0]).toBe(history[1])
    expect(decision.keep.length).toBe(4)
    expect([...decision.foldMessages, ...decision.keep]).toEqual(history)
  })
})

describe('foldIntoSummary', () => {
  function makeMockAdapter(responseText: string, captured: { params?: LLMStreamParams }): LLMAdapter {
    return {
      async *stream(params: LLMStreamParams): AsyncGenerator<StreamChunk> {
        captured.params = params
        yield { type: 'text_delta', text: responseText }
        yield { type: 'message_end', stopReason: 'end_turn' }
      },
      updateConfig() {},
    }
  }

  it('prompt 中同时包含 prevSummary 与 foldMessages 的内容,返回值即新摘要', async () => {
    const captured: { params?: LLMStreamParams } = {}
    const adapter = makeMockAdapter('合并后的新摘要', captured)
    const foldMessages: EngineMessage[] = [
      createUserMessage('用户消息A'),
      createAssistantMessage([{ type: 'text', text: '助手回复B' }], 'end_turn'),
    ]

    const result = await foldIntoSummary({
      adapter,
      model: 'test-model',
      prevSummary: '旧摘要内容C',
      foldMessages,
    })

    expect(result).toBe('合并后的新摘要')
    expect(captured.params?.model).toBe('test-model')
    const sentText = JSON.stringify(captured.params?.messages)
    expect(sentText).toContain('旧摘要内容C')
    expect(sentText).toContain('用户消息A')
    expect(sentText).toContain('助手回复B')
  })

  it('prevSummary 缺失(首次折叠)时不报错,仍能折叠 foldMessages', async () => {
    const captured: { params?: LLMStreamParams } = {}
    const adapter = makeMockAdapter('首次摘要', captured)
    const foldMessages: EngineMessage[] = [createUserMessage('第一批历史')]

    const result = await foldIntoSummary({
      adapter,
      model: 'test-model',
      prevSummary: undefined,
      foldMessages,
    })

    expect(result).toBe('首次摘要')
    const sentText = JSON.stringify(captured.params?.messages)
    expect(sentText).toContain('第一批历史')
  })
})
