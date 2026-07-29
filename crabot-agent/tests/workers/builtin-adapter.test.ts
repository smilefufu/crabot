import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { BuiltinWorkerAdapter, WorkerExitedError } from '../../src/workers/builtin/adapter.js'
import { SessionTree } from '../../src/workers/session-tree.js'
import type { SpawnSpec, IncarnationHandle, IncarnationRef, WorkerContractState } from '../../src/workers/types.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import * as engineModule from '../../src/engine/query-loop.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

function makeAdapter(
  responses: Array<{
    text?: string
    toolCalls?: Array<{ name: string; id: string; input: Record<string, unknown> }>
    stopReason: 'end_turn' | 'tool_use'
  }>,
): LLMAdapter {
  let i = 0
  return {
    stream: vi.fn(async function* () {
      const r = responses[i++] ?? responses[responses.length - 1]
      const content: unknown[] = []
      if (r.text) content.push({ type: 'text', text: r.text })
      for (const tc of r.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      }
      yield* chunksFromContent(content, r.stopReason, { inputTokens: 100, outputTokens: 50 })
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

function throwingAdapter(): LLMAdapter {
  return {
    stream: vi.fn(async function* () {
      throw new Error('boom')
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * 第一个 stream 调用返回给定响应，第二个及后续调用先 await gate 再抛错——用于测试续 burst
 * 崩溃场景。gate 让调用方能精确控制"第二个 burst 已经进入 running、但还没抛错"这个窗口，
 * 便于在其间 sendInput 制造待处理消息。
 */
function makeAdapterWithSecondBurstError(
  gate: Promise<void>,
  firstBurstResponse: {
    text?: string
    toolCalls?: Array<{ name: string; id: string; input: Record<string, unknown> }>
    stopReason: 'end_turn' | 'tool_use'
  },
): LLMAdapter {
  let callCount = 0
  return {
    stream: vi.fn(async function* () {
      if (callCount > 0) {
        await gate
        throw new Error('second burst error')
      }
      callCount++
      const r = firstBurstResponse
      const content: unknown[] = []
      if (r.text) content.push({ type: 'text', text: r.text })
      for (const tc of r.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      }
      yield* chunksFromContent(content, r.stopReason, { inputTokens: 100, outputTokens: 50 })
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

/** 像 makeAdapter，但每次 stream() 先 await gate——用于制造"burst 仍在跑"的可控窗口。 */
function makeGatedAdapter(
  gate: Promise<void>,
  responses: Array<{
    text?: string
    toolCalls?: Array<{ name: string; id: string; input: Record<string, unknown> }>
    stopReason: 'end_turn' | 'tool_use'
  }>,
): LLMAdapter {
  let i = 0
  return {
    stream: vi.fn(async function* () {
      await gate
      const r = responses[i++] ?? responses[responses.length - 1]
      const content: unknown[] = []
      if (r.text) content.push({ type: 'text', text: r.text })
      for (const tc of r.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      }
      yield* chunksFromContent(content, r.stopReason, { inputTokens: 100, outputTokens: 50 })
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

function spec(opts: { adapter: LLMAdapter; worker_id?: string }): SpawnSpec {
  return {
    worker_id: opts.worker_id ?? randomUUID(),
    prompt: '测试任务',
    workspace: { root: '/tmp/ws' },
    builtin: {
      adapter: opts.adapter,
      model: 'test',
      systemPrompt: '',
      tools: [],
    },
  }
}

async function waitState(
  adapter: BuiltinWorkerAdapter,
  h: IncarnationHandle,
  target: WorkerContractState,
): Promise<void> {
  const deadline = Date.now() + 2000
  let last: WorkerContractState | undefined
  while (Date.now() < deadline) {
    last = await adapter.state(h)
    if (last === target) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`waitState timeout: expected '${target}', last seen '${last}'`)
}

describe('BuiltinWorkerAdapter', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), 'builtin-adapter-'))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('spawn → burst end_turn → idle，输出可增量读', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([{ text: '想了想，先问你：A 还是 B？', stopReason: 'end_turn' }]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    const { chunk } = await adapter.readOutput(h, { offset: 0 })
    expect(chunk).toContain('A 还是 B')
  })

  it('finish_task → exited(completed)', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([
        {
          toolCalls: [{ name: 'finish_task', id: 'call_1', input: { outcome: 'completed', summary: '搞定了' } }],
          stopReason: 'tool_use',
        },
      ]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'exited')

    const metaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')
    const meta = JSON.parse(metaRaw)
    expect(meta.state).toBe('exited')
    expect(meta.ended_reason).toBe('completed')
    expect(meta.outcome).toBe('completed')
  })

  it('engine 抛错 → exited(crashed)', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({ adapter: throwingAdapter() })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'exited')

    const metaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')
    const meta = JSON.parse(metaRaw)
    expect(meta.state).toBe('exited')
    expect(meta.ended_reason).toBe('crashed')
  })

  it('runBurst 传递 disableCompaction: true 到 runEngine', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([{ text: '测试输出', stopReason: 'end_turn' }]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    expect(runEngineSpy).toHaveBeenCalled()
    const callArgs = runEngineSpy.mock.calls[0]?.[0]
    expect(callArgs?.options?.disableCompaction).toBe(true)
  })

  it('sendInput(idle) → 追加新一轮用户消息并起新 burst，新 burst 可见旧上下文', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([
        { text: '第一轮回复', stopReason: 'end_turn' },
        { text: '第二轮回复', stopReason: 'end_turn' },
      ]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    await adapter.sendInput(h, '追加的问题')
    expect(await adapter.state(h)).toBe('running')
    await waitState(adapter, h, 'idle')

    expect(runEngineSpy).toHaveBeenCalledTimes(2)
    const secondCallArgs = runEngineSpy.mock.calls[1]?.[0]
    const serialized = JSON.stringify(secondCallArgs?.initialMessages ?? [])
    expect(serialized).toContain('测试任务') // 首轮 prompt 仍在上下文里
    expect(serialized).toContain('第一轮回复') // 首轮 assistant 回复仍在上下文里
    expect(serialized).toContain('追加的问题') // 新注入的用户消息

    const { chunk } = await adapter.readOutput(h, { offset: 0 })
    expect(chunk).toContain('第二轮回复')
  })

  it('sendInput(running) → 进入待注入队列，burst 间隙自动续 burst，消息不丢', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const gate = deferred<void>()
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeGatedAdapter(gate.promise, [
        { text: '第一轮回复', stopReason: 'end_turn' },
        { text: '处理完排队消息', stopReason: 'end_turn' },
      ]),
    })

    const h = await adapter.spawn(s)
    expect(await adapter.state(h)).toBe('running')

    await adapter.sendInput(h, '排队消息1')
    await adapter.sendInput(h, '排队消息2')
    // 仍在同一个 burst 内，两条注入都进了队列，没有触发新 burst。
    expect(await adapter.state(h)).toBe('running')

    gate.resolve()
    await waitState(adapter, h, 'idle')

    // 第一个 burst 结束发现队列非空 → 原地续了第二个 burst。
    expect(runEngineSpy).toHaveBeenCalledTimes(2)

    const tree = await SessionTree.load(join(tmp, s.worker_id, 'session.jsonl'))
    const tip = tree.latestTip()
    expect(tip).not.toBeNull()
    const serialized = tree.pathTo(tip!).map((m) => JSON.stringify(m))
    const idxQ1 = serialized.findIndex((c) => c.includes('排队消息1'))
    const idxQ2 = serialized.findIndex((c) => c.includes('排队消息2'))
    const idxFinal = serialized.findIndex((c) => c.includes('处理完排队消息'))
    expect(idxQ1).toBeGreaterThan(-1)
    expect(idxQ2).toBeGreaterThan(idxQ1)
    expect(idxFinal).toBeGreaterThan(idxQ2)
  })

  it('sendInput(exited) → 抛 WorkerExitedError', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([
        { toolCalls: [{ name: 'finish_task', id: 'call_1', input: { outcome: 'completed', summary: '搞定了' } }], stopReason: 'tool_use' },
      ]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'exited')

    await expect(adapter.sendInput(h, '还有件事')).rejects.toThrow(WorkerExitedError)
    try {
      await adapter.sendInput(h, '还有件事')
      expect.unreachable('sendInput 应该在 exited 态抛出 WorkerExitedError')
    } catch (err) {
      expect(err).toBeInstanceOf(WorkerExitedError)
      expect((err as WorkerExitedError).worker_id).toBe(s.worker_id)
      expect((err as WorkerExitedError).seq).toBe(1)
    }
  })

  it('resume(prev, wakeInput) → 派生 seq+1 新化身，pathTo 连续含 wakeInput', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([
        { toolCalls: [{ name: 'finish_task', id: 'call_1', input: { outcome: 'completed', summary: '第一段完成' } }], stopReason: 'tool_use' },
        { text: '欢迎回来', stopReason: 'end_turn' },
      ]),
    })

    const h1 = await adapter.spawn(s)
    await waitState(adapter, h1, 'exited')

    const metaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')
    const meta = JSON.parse(metaRaw) as { tip_node_id: string }
    const prevRef: IncarnationRef = { worker_id: s.worker_id, seq: 1, session_ref: meta.tip_node_id }

    const h2 = await adapter.resume(prevRef, '我回来了')
    expect(h2.seq).toBe(2)
    await waitState(adapter, h2, 'idle')

    const tree = await SessionTree.load(join(tmp, s.worker_id, 'session.jsonl'))
    const tip = tree.latestTip()
    expect(tip).not.toBeNull()
    const serialized = tree.pathTo(tip!).map((m) => JSON.stringify(m))
    const idxPrompt = serialized.findIndex((c) => c.includes('测试任务'))
    const idxWake = serialized.findIndex((c) => c.includes('我回来了'))
    const idxReply = serialized.findIndex((c) => c.includes('欢迎回来'))
    expect(idxPrompt).toBe(0)
    expect(idxWake).toBeGreaterThan(idxPrompt)
    expect(idxReply).toBeGreaterThan(idxWake)

    // resume 之后新化身独立落盘，读老 seq 的 meta 不受影响。
    const meta2Raw = await fs.readFile(join(tmp, s.worker_id, 'meta-2.json'), 'utf-8')
    const meta2 = JSON.parse(meta2Raw)
    expect(meta2.state).toBe('idle')
  })

  // --- 并发竞态回归（per-worker 互斥）---

  /** 从 session.jsonl 读出全部节点，用于检测树是否分叉（同一 parent_id 出现多个孩子）。 */
  async function loadRawNodes(worker_id: string): Promise<Array<{ node_id: string; parent_id: string | null; message: unknown }>> {
    const raw = await fs.readFile(join(tmp, worker_id, 'session.jsonl'), 'utf-8')
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
  }

  function assertNoFork(nodes: Array<{ node_id: string; parent_id: string | null }>): void {
    const childCount = new Map<string, number>()
    for (const n of nodes) {
      if (n.parent_id === null) continue
      childCount.set(n.parent_id, (childCount.get(n.parent_id) ?? 0) + 1)
    }
    for (const [parent, count] of childCount) {
      expect(count, `node ${parent} 有 ${count} 个孩子——树分叉了`).toBe(1)
    }
  }

  it('sendInput(idle) 背靠背并发不 await：两条消息都不丢且树无分叉', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([
        { text: '首轮回复', stopReason: 'end_turn' },
        { text: '第二轮回复', stopReason: 'end_turn' },
        { text: '第三轮回复', stopReason: 'end_turn' },
      ]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    // 关键：两次调用之间不 await——复现"都读到 idle、拿同一 tip"的竞态场景。
    const p1 = adapter.sendInput(h, '并发消息A')
    const p2 = adapter.sendInput(h, '并发消息B')
    await Promise.all([p1, p2])

    await waitState(adapter, h, 'idle')

    const nodes = await loadRawNodes(s.worker_id)
    assertNoFork(nodes)

    const serialized = nodes.map((n) => JSON.stringify(n.message))
    expect(serialized.some((c) => c.includes('并发消息A'))).toBe(true)
    expect(serialized.some((c) => c.includes('并发消息B'))).toBe(true)
  })

  it('burst 收尾"判定队列为空→落 idle"窗口期注入的 sendInput 不丢', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const gate = deferred<void>()
    const s = spec({
      adapter: makeGatedAdapter(gate.promise, [
        { text: '首轮回复', stopReason: 'end_turn' },
        { text: '窗口期消息的回复', stopReason: 'end_turn' },
      ]),
    })

    const h = await adapter.spawn(s)
    expect(await adapter.state(h)).toBe('running')

    // burst 被 gate 卡住时装好拦截：一旦收尾段判定要落 idle，就在"判定完成、状态还没
    // 真正落定"这个当口抢发 sendInput，复现窗口期竞态（transitionState 是私有方法，
    // 用实例属性覆盖原型方法来精确命中这个窗口——比纯靠时序凑巧命中更可靠）。
    // 用 deferred 而非轮询 state() 等收敛：instance.state 在 transitionState 内部落 idle
    // 后、mutex 真正释放前就已可见，轮询可能逮到这个转瞬即逝的中间态就提前判定"已收敛"，
    // 而注入的续 burst 其实还没跑完——那样断言会读到写了一半的树，是测试自身的假竞态，
    // 不是被测代码的问题；等第二次 transitionState('idle') 真正落盘完成才是可靠的收敛信号。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapterAny = adapter as any
    const originalTransitionState = adapterAny.transitionState.bind(adapter)
    let idleCount = 0
    const secondIdle = deferred<void>()
    adapterAny.transitionState = async (instanceArg: unknown, handleArg: unknown, state: string) => {
      const result = await originalTransitionState(instanceArg, handleArg, state)
      if (state === 'idle') {
        idleCount++
        if (idleCount === 1) {
          void adapter.sendInput(h, '窗口期消息')
        } else {
          secondIdle.resolve()
        }
      }
      return result
    }

    gate.resolve()
    await secondIdle.promise

    const nodes = await loadRawNodes(s.worker_id)
    assertNoFork(nodes)
    const serialized = nodes.map((n) => JSON.stringify(n.message))
    expect(serialized.some((c) => c.includes('窗口期消息'))).toBe(true)
  })

  it('续 burst 途中崩溃且 pendingInputs 非空 → readOutput 能读到 dead-letter 消息（真实调用链）', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const gate = deferred<void>()
    const s = spec({
      adapter: makeAdapterWithSecondBurstError(gate.promise, { text: '首轮回复', stopReason: 'end_turn' }),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    // sendInput(idle) 起第二个 burst：mutex.run 内先把消息 append 进树、转 running，
    // 返回时 state 已经是 running——第二个 burst 的 stream() 此刻正卡在 gate 里。
    await adapter.sendInput(h, '触发续 burst')
    expect(await adapter.state(h)).toBe('running')

    // 第二个 burst 仍在跑（未抛错），此刻 sendInput 走的是 running 分支：入队而不起新 burst。
    await adapter.sendInput(h, '待处理消息1')
    await adapter.sendInput(h, '待处理消息2')
    expect(await adapter.state(h)).toBe('running')

    // 放行 gate：第二个 burst 的 stream() 抛错 → runEngine 内部 catch 收敛为
    // outcome='failed'（finalMessages 未变短，不会误触发压缩防御）→ runBurst 收尾段
    // 判定 failed → transitionExited('crashed')，此时 pendingInputs 仍是那两条排队消息。
    gate.resolve()
    await waitState(adapter, h, 'exited')

    const { chunk } = await adapter.readOutput(h, { offset: 0 })
    expect(chunk).toContain('[dead-letter]')
    expect(chunk).toContain('2 unsent message(s)')
    expect(chunk).toContain('待处理消息1')
    expect(chunk).toContain('待处理消息2')
  })

  it('并发 resume 同一 prev：仅一次成功，无树分叉', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([
        { toolCalls: [{ name: 'finish_task', id: 'call_1', input: { outcome: 'completed', summary: '第一段完成' } }], stopReason: 'tool_use' },
        { text: '欢迎回来A', stopReason: 'end_turn' },
        { text: '欢迎回来B', stopReason: 'end_turn' },
      ]),
    })

    const h1 = await adapter.spawn(s)
    await waitState(adapter, h1, 'exited')

    const metaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')
    const meta = JSON.parse(metaRaw) as { tip_node_id: string }
    const prevRef: IncarnationRef = { worker_id: s.worker_id, seq: 1, session_ref: meta.tip_node_id }

    const results = await Promise.allSettled([
      adapter.resume(prevRef, '我回来了-A'),
      adapter.resume(prevRef, '我回来了-B'),
    ])

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<IncarnationHandle> => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)

    const nodes = await loadRawNodes(s.worker_id)
    assertNoFork(nodes)
    const childrenOfPrevTip = nodes.filter((n) => n.parent_id === prevRef.session_ref)
    expect(childrenOfPrevTip.length).toBe(1)

    const winner = fulfilled[0]!.value
    expect(winner.seq).toBe(2)
    await waitState(adapter, winner, 'idle')
  })
})
