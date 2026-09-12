/**
 * P6-A 阶段 2：ManagerLoop trace 接线测试。
 * admission 顺序（ensureSession → startEpisode → LLM）、trigger 映射、
 * onTurn span、usage 聚合、失败收口与 mailbox 重投、空自唤醒无 trace。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ManagerLoop, type WakeEvent, type TimedWakeEnvelope, type ManagerLoopDeps } from '../../src/manager/loop.js'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import { TraceStore } from '../../src/core/trace-store.js'
import type { ManagerTraceWriter } from '../../src/manager/trace-types.js'
import type { CompactionPolicy } from '../../src/manager/compaction.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { ChannelMessage } from '../../src/types.js'
import type { WorkerHarness } from '../../src/workers/harness/harness.js'
import type { LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import type { LLMAdapter, LLMStreamParams } from '../../src/engine/index.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
import { createUserMessage } from '../../src/engine/types.js'

const KEY: ManagerKey = 'wechat::sess-trace'
const FIXED_RECEIVED_AT = '2026-01-01T08:00:00+08:00'
function timed(wake: WakeEvent): TimedWakeEnvelope { return { wake, received_at: FIXED_RECEIVED_AT, timezone: 'Asia/Shanghai' } }

function isAssistantTextEndTurnReminder(params: LLMStreamParams): boolean {
  const last = params.messages[params.messages.length - 1]
  return typeof last?.content === 'string' && last.content.startsWith('[系统提醒] 你刚才直接输出了一段文字')
}

function makeAdapter(opts: { fail?: boolean } = {}): { adapter: LLMAdapter; calls: LLMStreamParams[] } {
  const calls: LLMStreamParams[] = []
  const adapter: LLMAdapter = {
    traceIdentity: { providerId: 'provider-a', format: 'openai' },
    async *stream(params: LLMStreamParams) {
      calls.push({ ...params, messages: [...params.messages] })
      if (isAssistantTextEndTurnReminder(params)) {
        yield* chunksFromContent([], 'end_turn', { inputTokens: 10, outputTokens: 5 })
        return
      }
      if (opts.fail) throw new Error('llm exploded')
      yield* chunksFromContent([{ type: 'text', text: '好的' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
    },
    updateConfig: () => {},
  }
  return { adapter, calls }
}

function makeMessage(text: string): ChannelMessage {
  return {
    platform_message_id: `pm-${Math.random().toString(36).slice(2)}`,
    session: { session_id: 'sess-trace', channel_id: 'wechat', type: 'private' },
    sender: { platform_user_id: 'u1', platform_display_name: 'u1' },
    content: { type: 'text', text },
    features: { is_mention_crab: false },
    platform_timestamp: new Date().toISOString(),
  }
}

const FAKE_HARNESS = { listWorkers: async (): Promise<LedgerWorker[]> => [] } as unknown as WorkerHarness

describe('ManagerLoop episode trace wiring', () => {
  let dataDir: string
  let store: ManagerSessionStore
  let traceStore: TraceStore
  let traceWriter: ManagerTraceWriter

  function deps(adapter: LLMAdapter, trace?: ManagerTraceWriter): ManagerLoopDeps {
    return {
      key: KEY,
      isSystemThread: false,
      managerKey: () => KEY,
      store,
      policy: { keepRecent: 3, hardCapTokens: 1_000_000 },
      toolFace: () => [],
      promptInputs: () => ({}),
      harness: FAKE_HARNESS,
      now: () => new Date(),
      markPendingReply: () => {},
      hasPendingReply: () => true,
      adapter: () => adapter,
      model: () => 'test-model',
      ...(trace ? { traceWriter: trace } : {}),
    }
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'manager-loop-trace-'))
    store = new ManagerSessionStore(join(dataDir, 'manager-sessions'))
    traceStore = new TraceStore(100, join(dataDir, 'traces'), 'traces-running.jsonl', 'traces-v3-')
    traceWriter = traceStore.managerTraceWriter((text) => text)
  })

  afterEach(async () => {
    traceStore.stopFlushTimer()
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('episode 先落最小 session identity + trace，再调用 LLM', async () => {
    const { adapter, calls } = makeAdapter()
    const loop = new ManagerLoop(deps(adapter, traceWriter))
    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeMessage('你好')] }))
    expect(result.outcome).toBe('completed')
    expect(calls.length).toBeGreaterThan(0)

    // session identity 与 trace 都已持久化
    const keys = await store.listManagerKeys()
    expect(keys).toContain(KEY)
    const episodes = traceStore.listManagerEpisodes(KEY, { page: 1, page_size: 20 })
    expect(episodes.items).toHaveLength(1)
    expect(episodes.items[0].trace_id).toBe(result.episodeId)
    expect(episodes.items[0].status).toBe('completed')
    expect(episodes.items[0].trigger.type).toBe('human_message')
    expect(episodes.items[0].trigger.summary).toBe('人类消息 x1：你好')
    // root span 随 episode 收口
    expect(episodes.items[0].spans.some((span) => span.type === 'agent_loop' && span.status === 'completed')).toBe(true)
    // llm_call span + usage 聚合
    expect(episodes.items[0].spans.some((span) => span.type === 'llm_call')).toBe(true)
    expect(episodes.items[0].total_usage).toMatchObject({ input_tokens: 20, output_tokens: 10 })
    expect(episodes.items[0].total_usage).not.toHaveProperty('cache_read_tokens')
    expect(episodes.items[0].total_usage).not.toHaveProperty('cache_creation_tokens')
  })

  it('trace start 失败：零 LLM 调用，但人类输入已提交且不重投', async () => {
    const failingWriter: ManagerTraceWriter = {
      ...traceWriter,
      startEpisode: () => { throw new Error('disk full') },
    }
    const { adapter, calls } = makeAdapter()
    const loop = new ManagerLoop(deps(adapter, failingWriter))
    await expect(loop.wakeUp(timed({ kind: 'human_messages', messages: [makeMessage('hello')] }))).rejects.toThrow('disk full')
    expect(calls).toHaveLength(0)
    expect(JSON.stringify((await store.load(KEY)).recent)).toContain('hello')
    expect(loop.hasPendingMailbox).toBe(false)

    // 修好 writer 后由新 wake 继续；原消息只从 history 出现，不作为新 wake 重放。
    const { adapter: adapter2, calls: calls2 } = makeAdapter()
    const loop2 = new ManagerLoop(deps(adapter2, traceWriter))
    const result = await loop2.wakeUp(timed({ kind: 'human_messages', messages: [makeMessage('new message')] }))
    expect(calls2.length).toBeGreaterThan(0)
    expect(result.consumedEvents).toBe(true)
  })

  it('空 mailbox 自唤醒不创建 trace、不调 LLM', async () => {
    const { adapter, calls } = makeAdapter()
    const loop = new ManagerLoop(deps(adapter, traceWriter))
    const result = await loop.drainMailbox()
    expect(result.turns).toBe(0)
    expect(calls).toHaveLength(0)
    expect(traceStore.listManagerEpisodes(KEY, {}).items).toHaveLength(0)
  })

  it('trigger 映射：schedule / worker_event / attention_flush / 任务板空闲自省', async () => {
    const { adapter } = makeAdapter()
    const loop = new ManagerLoop(deps(adapter, traceWriter))
    await loop.wakeUp(timed({ kind: 'schedule', scheduleId: 'sc-1', title: '日报', description: 'd' }))
    await loop.wakeUp(timed({ kind: 'worker_event', event: { kind: 'exited', worker_id: 'w-9', ts: new Date().toISOString() } as never }))
    await loop.wakeUp(timed({ kind: 'attention_flush', messages: [makeMessage('群消息')] }))
    await loop.wakeUp(timed({ kind: 'workboard_idle_review' }))
    const episodes = traceStore.listManagerEpisodes(KEY, { page: 1, page_size: 20 })
    expect(episodes.items.map((item) => item.trigger.type).sort()).toEqual(['attention_flush', 'schedule', 'system', 'worker_event'])
    expect(episodes.items.find((item) => item.trigger.type === 'system')?.trigger.summary).toBe('任务板空闲自省')
  })

  it('episode 失败：trace 收口 failed，但已提交人类输入不重投', async () => {
    const { adapter } = makeAdapter({ fail: true })
    const loop = new ManagerLoop(deps(adapter, traceWriter))
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeMessage('hi')] }))
    const episode = traceStore.listManagerEpisodes(KEY, {}).items[0]
    expect(episode.status).toBe('failed')
    expect(episode.outcome?.error).toBeDefined()
    expect(JSON.stringify((await store.load(KEY)).recent)).toContain('hi')
    expect(loop.hasPendingMailbox).toBe(false)
    const requests = episode.spans.filter(span => (span.details as any)?.kind === 'llm_request')
    expect(requests).toHaveLength(1)
    expect(requests[0].status).toBe('failed')
    expect(requests[0].details).not.toHaveProperty('usage')
    expect(episode.spans.filter(span => span.type === 'llm_call')).toHaveLength(0)
  })

  it('请求身份随真实重试切换，观察不额外确认人类输入', async () => {
    const { adapter } = makeAdapter()
    let generation = 0
    adapter.stream = async function* () {
      generation++
      throw Object.assign(new Error('temporary failure'), { status: 503 })
    }
    const replacement: LLMAdapter = {
      traceIdentity: { providerId: 'provider-b', format: 'anthropic' },
      async *stream() { yield* chunksFromContent([], 'end_turn', { inputTokens: 5, outputTokens: 1 }) },
      updateConfig() {},
    }
    const onHumanInputResponded = vi.fn(async () => {})
    const loop = new ManagerLoop({
      ...deps(adapter, traceWriter), adapter: () => generation ? replacement : adapter,
      model: () => generation ? 'model-b' : 'model-a', runtimeConfigAppliedGeneration: () => generation,
    })
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeMessage('private user text')] }), onHumanInputResponded)
    const episode = traceStore.listManagerEpisodes(KEY, {}).items[0]
    const requests = episode.spans.filter(span => (span.details as any)?.kind === 'llm_request')
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ status: 'failed', details: { provider_id: 'provider-a', model_id: 'model-a', attempt: 1 } })
    expect(requests[1]).toMatchObject({ status: 'completed', details: { provider_id: 'provider-b', model_id: 'model-b', attempt: 2 } })
    const responses = episode.spans.filter(span => span.type === 'llm_call')
    expect(responses).toHaveLength(1)
    expect(responses[0].details).toMatchObject({ provider_id: 'provider-b', model_id: 'model-b', request_id: (requests[1].details as any).request_id })
    expect(onHumanInputResponded).toHaveBeenCalledOnce()
    expect(JSON.stringify(requests)).not.toMatch(/private user text|temporary failure|endpoint|apikey/)
  })

  it('摘要压缩独立计量，不伪造 llm_call 或多算普通成功响应', async () => {
    const state = await store.load(KEY)
    await store.save({ ...state, recent: ['old one', 'old two', 'old three'].map(text => createUserMessage(text.repeat(100))) })
    let calls = 0
    const { adapter } = makeAdapter()
    adapter.stream = async function* () {
      calls++
      yield* chunksFromContent(calls === 2 ? [{ type: 'text', text: 'private summary' }] : [],
        calls === 1 ? 'max_tokens' : 'end_turn', { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 })
    }
    const loop = new ManagerLoop({ ...deps(adapter, traceWriter), policy: { keepRecent: 2, hardCapTokens: 1_000_000 } })
    await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeMessage('continue')] }))
    const episode = traceStore.listManagerEpisodes(KEY, {}).items[0]
    const requests = episode.spans.filter(span => (span.details as any)?.kind === 'llm_request')
    expect(requests).toHaveLength(3)
    expect(requests.map(span => (span.details as any).purpose)).toEqual(['inference', 'compaction', 'inference'])
    expect(requests[1].details).toMatchObject({ visible_tool_count: 0, usage: { inputTokens: 10, cacheReadTokens: 0 } })
    expect(episode.spans.filter(span => span.type === 'llm_call')).toHaveLength(2)
    expect(JSON.stringify(requests)).not.toContain('private summary')
  })

  it('重启后遗留 running episode 被收口 failed/interrupted 且 spans 保留', async () => {
    const { adapter } = makeAdapter({ fail: true })
    // 制造一个 running 态 episode（start 后永不 finish）：直接写底层 store
    traceStore.startManagerEpisode('ep-orphan', KEY, { type: 'human_message', summary: '遗留' })
    const restarted = new TraceStore(100, join(dataDir, 'traces'), 'traces-running.jsonl', 'traces-v3-')
    restarted.reconcileInterruptedManagerEpisodes()
    const episode = restarted.getManagerEpisode('ep-orphan')!
    expect(episode.status).toBe('failed')
    expect(episode.outcome?.summary).toContain('interrupted')
    restarted.stopFlushTimer()
  })

  it('无 traceWriter 时 episode 照常运行（降级静默）', async () => {
    const { adapter, calls } = makeAdapter()
    const loop = new ManagerLoop(deps(adapter))
    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeMessage('hi')] }))
    expect(result.outcome).toBe('completed')
    expect(calls.length).toBeGreaterThan(0)
  })

  it('请求 span 写入失败只留下计量缺口，不重试请求或改变 episode', async () => {
    const { adapter, calls } = makeAdapter()
    const writer: ManagerTraceWriter = { ...traceWriter, appendSpan: (id, span) => {
      if ((span.details as any)?.kind === 'llm_request') throw new Error('request write failed')
      traceWriter.appendSpan(id, span)
    } }
    const loop = new ManagerLoop(deps(adapter, writer))
    const result = await loop.wakeUp(timed({ kind: 'human_messages', messages: [makeMessage('hi')] }))
    expect(result.outcome).toBe('completed')
    expect(calls).toHaveLength(2)
    const episode = traceStore.listManagerEpisodes(KEY, {}).items[0]
    expect(episode.spans.find(span => (span.details as any)?.kind === 'llm_request_coverage')?.details)
      .toMatchObject({ request_count: 2 })
    expect(episode.spans.filter(span => (span.details as any)?.kind === 'llm_request')).toHaveLength(0)
  })
})
