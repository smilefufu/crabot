import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { BuiltinWorkerAdapter, WorkerExitedError } from '../../src/workers/builtin/adapter.js'
import { SessionTree } from '../../src/workers/session-tree.js'
import type { SpawnSpec, IncarnationHandle, IncarnationRef, StateChangeReport, WorkerContractState } from '../../src/workers/types.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import { defineTool } from '../../src/engine/index.js'
import type { EngineMessage, ToolDefinition } from '../../src/engine/index.js'
import * as engineModule from '../../src/engine/query-loop.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

/** engine 的 FORCED_SUMMARY_PROMPT 首句(query-loop.ts)。worker 不跟人类说话、也没有
 *  send_message 工具，这段文案一旦出现在它的上下文里就是 bug。 */
const FORCED_SUMMARY_MARKER = '你刚才以 end_turn 结束但还没有向人类发送任何内容'

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

/**
 * 像 makeAdapter，但从第二次 stream() 调用起先 await gate——用于制造"主线 burst 已经
 * idle 落定、fork 的 burst 还卡着没跑完"这个可控窗口，同一个 mock adapter 被主线和
 * fork 共用（贴合 builtinConfigs 按 worker_id 缓存、fork 复用同一 builtin.adapter 的实现）。
 */
function makeAdapterGatedFromSecondCall(
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
      if (i > 0) await gate
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

/** 一个无副作用的工具，用来在测试里造出 assistant(tool_use) + toolResults 的成对消息。 */
const ECHO_TOOL: ToolDefinition = defineTool({
  name: 'echo',
  description: '回显',
  isReadOnly: true,
  inputSchema: { type: 'object', properties: { s: { type: 'string' } } },
  call: async () => ({ output: 'ok', isError: false }),
})

interface TurnScript {
  text?: string
  toolCalls?: Array<{ name: string; id: string; input: Record<string, unknown> }>
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
  usage?: { inputTokens: number; outputTokens: number }
}

/**
 * 会区分"worker 的 turn 调用"与"压缩摘要调用"的 mock。
 *
 * 判据是 `systemPrompt`：ContextManager.compactWithLLM 用自己的 DEFAULT_COMPACT_SYSTEM_PROMPT
 * 调 callNonStreaming，而测试里 worker 的 systemPrompt 恒为 ''。（不能用 `tools` 判——
 * runForkBurst 的工具集不含 finish_task，工具为空时与摘要调用无从区分。）
 * 摘要调用不消费 turn 脚本。
 */
function isCompactionCall(params: { systemPrompt?: string }): boolean {
  return (params.systemPrompt ?? '').length > 0
}

function makeCompactionAwareAdapter(turns: TurnScript[]): LLMAdapter & { compactionCalls: number } {
  let i = 0
  const self = {
    compactionCalls: 0,
    stream: vi.fn(async function* (params: { systemPrompt?: string }) {
      if (isCompactionCall(params)) {
        self.compactionCalls++
        yield* chunksFromContent([{ type: 'text', text: '这是被折叠段的摘要。' }], 'end_turn', {
          inputTokens: 50,
          outputTokens: 20,
        })
        return
      }
      const r = turns[i++] ?? turns[turns.length - 1]
      const content: unknown[] = []
      if (r.text) content.push({ type: 'text', text: r.text })
      for (const tc of r.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      }
      yield* chunksFromContent(content, r.stopReason, r.usage ?? { inputTokens: 100, outputTokens: 50 })
    }),
    updateConfig: () => {},
  }
  return self as unknown as LLMAdapter & { compactionCalls: number }
}

/**
 * "起跑 N 条 → burst 内压缩 → 继续跑到 L>N" 的复现脚本（配 contextWindowTokens: 2000，
 * 阈值 = 2000×0.8 = 1600）：
 *
 * - burst 1（spawn）：5 轮 echo + 1 轮收口 → 树里 12 条消息；
 * - sendInput 追加 1 条 → burst 2 起跑 N = 13；
 * - burst 2 turn 1（b1）汇报 inputTokens=1900 > 1600 → turn 2 开头 shouldCompact 命中，
 *   15 条被整体重写成 8 条 [首条, 摘要, 最近 6 条]；
 * - 其后 b2/b3/b4 + 收口共 7 条 → L = 15。L(15) >= N(13)，旧 length 断言不触发；
 *   `slice(13)` 取到的是压缩后数组的 index 13（toolResults b4，**孤儿**）与 14。
 */
function compactionScript(): TurnScript[] {
  const echo = (id: string, usage?: { inputTokens: number; outputTokens: number }): TurnScript => ({
    toolCalls: [{ name: 'echo', id, input: { s: id } }],
    stopReason: 'tool_use',
    ...(usage ? { usage } : {}),
  })
  return [
    echo('a1'), echo('a2'), echo('a3'), echo('a4'), echo('a5'),
    { text: '第一段结束', stopReason: 'end_turn' },
    // burst 2：第一轮汇报满窗口 usage，逼出下一轮开头的压缩。
    echo('b1', { inputTokens: 1900, outputTokens: 50 }),
    echo('b2'), echo('b3'), echo('b4'),
    { text: '第二段结束', stopReason: 'end_turn' },
  ]
}

/** 每轮都返回 text='' + stop_reason='max_tokens'（engine 眼里的"静默 max_tokens"）。 */
function makeSilentMaxTokensAdapter(gate?: Promise<void>): LLMAdapter {
  return {
    stream: vi.fn(async function* (params: { systemPrompt?: string }) {
      if (gate) await gate
      if (isCompactionCall(params)) {
        // 压缩摘要调用（消息太少时 ContextManager 直接返回原样，这里也照常给一段文本）
        yield* chunksFromContent([{ type: 'text', text: '摘要' }], 'end_turn')
        return
      }
      yield* chunksFromContent([], 'max_tokens', { inputTokens: 199_000, outputTokens: 0 })
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

/**
 * 返回路径里所有"孤儿 tool_result"的 tool_use_id：一条 toolResults 消息，其紧邻的前一条
 * 不是携带同名 tool_use 的 assistant 消息。孤儿 tool_result 会让 LLM API 直接 400，
 * 且 400 文案不匹配任何自愈判定——落在 session 树里就是永久卡死。
 */
function orphanToolResultIds(path: ReadonlyArray<EngineMessage>): string[] {
  const orphans: string[] = []
  path.forEach((msg, idx) => {
    if (!('toolResults' in msg)) return
    const prev = idx > 0 ? path[idx - 1] : undefined
    const available = new Set<string>(
      prev?.role === 'assistant'
        ? prev.content.filter((b) => b.type === 'tool_use').map((b) => (b as { id: string }).id)
        : [],
    )
    for (const r of msg.toolResults) {
      if (!available.has(r.tool_use_id)) orphans.push(r.tool_use_id)
    }
  })
  return orphans
}

function spec(opts: {
  adapter: LLMAdapter
  worker_id?: string
  tools?: ReadonlyArray<ToolDefinition>
  contextWindowTokens?: number
}): SpawnSpec {
  return {
    worker_id: opts.worker_id ?? randomUUID(),
    prompt: '测试任务',
    workspace: { root: '/tmp/ws' },
    builtin: {
      adapter: opts.adapter,
      model: 'test',
      systemPrompt: '',
      tools: opts.tools ?? [],
      ...(opts.contextWindowTokens !== undefined ? { contextWindowTokens: opts.contextWindowTokens } : {}),
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

    // IncarnationHandle.session_ref 由 adapter 在 spawn 返回前即填入真值(protocol-agent-v3
    // §6.1),builtin 的真值是本化身创建那一刻的 tip node_id——与彼时磁盘 meta 记录一致。
    // 必须在 burst(fire-and-forget)推进 tip 之前读,burst 结束后 tip 会前进到会话末尾,
    // 不再等于 handle 创建时刻的快照(这本身是符合预期的:handle.session_ref 是创建时的
    // 引用,不是持续跟随的实时游标)。
    expect(h.session_ref).toBeTruthy()
    const metaAtSpawn = JSON.parse(await fs.readFile(join(tmp, h.worker_id, 'meta-1.json'), 'utf-8'))
    expect(h.session_ref).toBe(metaAtSpawn.tip_node_id)

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

  it('finish_task 的 summary 经 onStateChange 上报(worker 全程只调工具时,这是它唯一的交付物)', async () => {
    // 生产故障:定时反思 worker 全程只调工具,一次 assistant text 都没产出 ——
    // outputLog 的写入条件 `if (event.assistantText)` 一次都不触发,output.log 根本
    // 不会被创建,report.lastText 也是空。结论只在 finish_task 的 summary 参数里。
    const seen: Array<{ state: WorkerContractState; report?: StateChangeReport }> = []
    const adapter = new BuiltinWorkerAdapter({
      dataDir: tmp,
      onStateChange: (_h, state, report) => {
        seen.push({ state, ...(report ? { report } : {}) })
      },
    })
    const SUMMARY = '今日反思完成:三次任务都拖到截止前一天才开工,建议把开工日也排进日程。'
    const s = spec({
      adapter: makeAdapter([
        // content 里没有 text 块,只有 tool_use —— 复刻生产上那个 worker 的形态。
        {
          toolCalls: [{ name: 'finish_task', id: 'call_1', input: { outcome: 'completed', summary: SUMMARY } }],
          stopReason: 'tool_use',
        },
      ]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'exited')

    const exited = seen.find((e) => e.state === 'exited')
    expect(exited).toBeDefined()
    expect(exited!.report?.summary).toBe(SUMMARY)
    expect(exited!.report?.endReason).toBe('completed')
    // 前提如实成立:这条 worker 没有任何 assistant text,output 通道整个是空的。
    expect(exited!.report?.lastText ?? '').toBe('')
    const { chunk } = await adapter.readOutput(h, { offset: 0 })
    expect(chunk).toBe('')
  })

  it('finish_task 的 summary 不是字符串(LLM 乱填)→ 不上报,不把非文本当作 worker 的结论', async () => {
    const seen: Array<{ state: WorkerContractState; report?: StateChangeReport }> = []
    const adapter = new BuiltinWorkerAdapter({
      dataDir: tmp,
      onStateChange: (_h, state, report) => {
        seen.push({ state, ...(report ? { report } : {}) })
      },
    })
    const s = spec({
      adapter: makeAdapter([
        {
          toolCalls: [{ name: 'finish_task', id: 'call_1', input: { outcome: 'completed', summary: { a: 1 } } }],
          stopReason: 'tool_use',
        },
      ]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'exited')

    const exited = seen.find((e) => e.state === 'exited')
    expect(exited!.report?.summary).toBeUndefined()
    // 终态本身照常落定,不因为 summary 不合规就改判。
    expect(exited!.report?.endReason).toBe('completed')
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

  it('runBurst 传递 disableCompaction: false 到 runEngine', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([{ text: '测试输出', stopReason: 'end_turn' }]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    expect(runEngineSpy).toHaveBeenCalled()
    const callArgs = runEngineSpy.mock.calls[0]?.[0]
    expect(callArgs?.options?.disableCompaction).toBe(false)
  })

  it('runBurst 静默 end_turn 不触发 engine 的 forced_summary 追问,也不多烧 LLM 轮次', async () => {
    const llm = makeAdapter([{ stopReason: 'end_turn' }]) // 无 text、无工具调用 = 静默 end_turn
    const workerAdapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const h = await workerAdapter.spawn(spec({ adapter: llm }))
    await waitState(workerAdapter, h, 'idle')

    const streamMock = llm.stream as unknown as { mock: { calls: Array<[{ messages: unknown }]> } }
    // 语义不变量①:worker 的上下文里从未出现过 forced_summary 的文案(它连 send_message
    // 工具都没有,被催也无从执行)。messages 数组是 engine 跨轮原地 push 的同一个引用,
    // 事后 stringify 即可看到本次 burst 注入过的全部内容。
    expect(JSON.stringify(streamMock.mock.calls)).not.toContain(FORCED_SUMMARY_MARKER)
    // 语义不变量②:静默 end_turn 直接被接受,只跑了一轮 LLM(gate 生效时会变成 1+3 轮)。
    expect(streamMock.mock.calls).toHaveLength(1)
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

    // h2.session_ref 是 resume 返回时刻新化身自己的引用，与彼时磁盘 meta-2.json 记录一致，
    // 且不是 prevRef 那个已经结束的旧化身的引用（protocol-agent-v3 §6.1）。必须在续 burst
    // （fire-and-forget）推进 tip 之前读，理由同 spawn 测试里的同款断言。
    expect(h2.session_ref).toBeTruthy()
    const meta2AtResume = JSON.parse(await fs.readFile(join(tmp, s.worker_id, 'meta-2.json'), 'utf-8'))
    expect(h2.session_ref).toBe(meta2AtResume.tip_node_id)
    expect(h2.session_ref).not.toBe(prevRef.session_ref)

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

  // --- fork（侧问分支）---

  it('fork(prev, forkInput) → 主线 idle 状态和 tip 不受影响，fork 有独立输出，fork 能看到主线历史', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const gate = deferred<void>()
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapterGatedFromSecondCall(gate.promise, [
        { text: '首轮回复', stopReason: 'end_turn' },
        { text: '侧问回复', stopReason: 'end_turn' },
      ]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    const treeBeforeFork = await SessionTree.load(join(tmp, s.worker_id, 'session.jsonl'))
    const mainTip = treeBeforeFork.latestTip()
    expect(mainTip).not.toBeNull()

    const prevRef: IncarnationRef = { worker_id: s.worker_id, seq: 1, session_ref: mainTip! }
    const forkHandle = await adapter.fork(prevRef, '侧问问题')
    expect(forkHandle.seq).toBe(2)

    // forkHandle.session_ref 是 fork 自己的引用(fork 分支节点自己的 tip node_id)，不是主线
    // mainTip 的照抄(protocol-agent-v3 §6.1:"fork 化身填 fork 自己的引用，不是父化身的")。
    // 必须在 gate.resolve() 放行 fork 的 burst、推进 fork 自己的 tip 之前读，理由同
    // spawn/resume 测试里的同款断言。
    expect(forkHandle.session_ref).toBeTruthy()
    expect(forkHandle.session_ref).not.toBe(mainTip)
    const forkMetaAtFork = JSON.parse(await fs.readFile(join(tmp, s.worker_id, 'meta-2.json'), 'utf-8'))
    expect(forkHandle.session_ref).toBe(forkMetaAtFork.tip_node_id)

    // fork 的 burst 还卡在 gate 里没跑完：此时主线状态/tip 必须完全不受影响。注意：不能
    // 用 SessionTree.load(...).latestTip() 判断——那是整个共享文件"最后一次 append"的
    // 全局游标，fork 往 prev.session_ref 上分支追加后，这个全局游标必然指向 fork 的新
    // 节点。真正代表"主线自己的续接点"的是主线化身自己维护的 tip（落在 meta-1.json 的
    // tip_node_id 里），必须仍然等于 fork 之前的 mainTip。
    expect(await adapter.state(h)).toBe('idle')
    let mainMeta = JSON.parse(await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')) as { tip_node_id: string }
    expect(mainMeta.tip_node_id).toBe(mainTip)

    gate.resolve()
    await waitState(adapter, forkHandle, 'exited')

    // fork 结束后主线依旧不受影响。
    expect(await adapter.state(h)).toBe('idle')
    mainMeta = JSON.parse(await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')) as { tip_node_id: string }
    expect(mainMeta.tip_node_id).toBe(mainTip)

    // fork 化身独立 meta：exited(completed)。
    const forkMetaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-2.json'), 'utf-8')
    const forkMeta = JSON.parse(forkMetaRaw)
    expect(forkMeta.state).toBe('exited')
    expect(forkMeta.ended_reason).toBe('completed')
    expect(forkMeta.outcome).toBe('completed')

    // fork 输出独立可读，且与主线输出互不串。
    const forkOutput = await adapter.readOutput(forkHandle, { offset: 0 })
    expect(forkOutput.chunk).toContain('侧问回复')
    const mainOutput = await adapter.readOutput(h, { offset: 0 })
    expect(mainOutput.chunk).toContain('首轮回复')
    expect(mainOutput.chunk).not.toContain('侧问回复')

    // fork 看得到主线历史：第二次 runEngine 调用（fork 的 burst）的 initialMessages 里
    // 含首轮 prompt、首轮 assistant 回复、以及 forkInput 本身。
    expect(runEngineSpy).toHaveBeenCalledTimes(2)
    const forkCallArgs = runEngineSpy.mock.calls[1]?.[0]
    const serialized = JSON.stringify(forkCallArgs?.initialMessages ?? [])
    expect(serialized).toContain('测试任务')
    expect(serialized).toContain('首轮回复')
    expect(serialized).toContain('侧问问题')

    // session 树分叉：mainTip 现在有且仅有一个孩子（fork 的分支节点），主线没有继续。
    const raw = await fs.readFile(join(tmp, s.worker_id, 'session.jsonl'), 'utf-8')
    const rawNodes = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { node_id: string; parent_id: string | null })
    const childrenOfMainTip = rawNodes.filter((n) => n.parent_id === mainTip)
    expect(childrenOfMainTip.length).toBe(1)
  })

  it('runForkBurst 静默 end_turn 同样不触发 forced_summary 追问,也不多烧 LLM 轮次', async () => {
    const llm = makeAdapter([
      { text: '首轮回复', stopReason: 'end_turn' }, // 主线 burst
      { stopReason: 'end_turn' }, // fork 的 burst:静默 end_turn(此后重复该条)
    ])
    const workerAdapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({ adapter: llm })
    const h = await workerAdapter.spawn(s)
    await waitState(workerAdapter, h, 'idle')

    const tree = await SessionTree.load(join(tmp, s.worker_id, 'session.jsonl'))
    const prevRef: IncarnationRef = { worker_id: s.worker_id, seq: 1, session_ref: tree.latestTip()! }
    const forkHandle = await workerAdapter.fork(prevRef, '侧问问题')
    await waitState(workerAdapter, forkHandle, 'exited')

    const streamMock = llm.stream as unknown as { mock: { calls: Array<[{ messages: unknown }]> } }
    expect(JSON.stringify(streamMock.mock.calls)).not.toContain(FORCED_SUMMARY_MARKER)
    // 主线 1 轮 + fork 1 轮 = 2 轮;gate 生效时 fork 会多烧 3 轮。
    expect(streamMock.mock.calls).toHaveLength(2)

    const forkMeta = JSON.parse(await fs.readFile(join(tmp, s.worker_id, 'meta-2.json'), 'utf-8'))
    expect(forkMeta.ended_reason).toBe('completed')
  })

  it('fork 不要求 prev 处于任何特定状态：主线仍 running 时也能 fork', async () => {
    const gate = deferred<void>()
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeGatedAdapter(gate.promise, [
        { text: '主线回复', stopReason: 'end_turn' },
        { text: '侧问回复', stopReason: 'end_turn' },
      ]),
    })

    const h = await adapter.spawn(s)
    expect(await adapter.state(h)).toBe('running')

    // 主线首个 burst 还没跑完（卡在 gate），此时 fork：session_ref 用根节点（prompt 节点）。
    const tree = await SessionTree.load(join(tmp, s.worker_id, 'session.jsonl'))
    const rootTip = tree.latestTip()
    expect(rootTip).not.toBeNull()
    const prevRef: IncarnationRef = { worker_id: s.worker_id, seq: 1, session_ref: rootTip! }

    const forkHandle = await adapter.fork(prevRef, '侧问问题')
    expect(forkHandle.seq).toBe(2)

    gate.resolve()
    await waitState(adapter, h, 'idle')
    await waitState(adapter, forkHandle, 'exited')

    expect(await adapter.state(h)).toBe('idle')
    const forkMetaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-2.json'), 'utf-8')
    const forkMeta = JSON.parse(forkMetaRaw)
    expect(forkMeta.state).toBe('exited')
    expect(forkMeta.outcome).toBe('completed')
  })

  it('fork 之后 resume 主线：seq 分配不与 fork 撞号（fork 消耗 seq 2，resume 应得 seq 3）', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([
        { text: '首轮回复', stopReason: 'end_turn' },
        { text: '侧问回复', stopReason: 'end_turn' },
        { toolCalls: [{ name: 'finish_task', id: 'call_1', input: { outcome: 'completed', summary: '主线完成' } }], stopReason: 'tool_use' },
        { text: '欢迎回来', stopReason: 'end_turn' },
      ]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    const tree1 = await SessionTree.load(join(tmp, s.worker_id, 'session.jsonl'))
    const mainTip = tree1.latestTip()!
    const forkRef: IncarnationRef = { worker_id: s.worker_id, seq: 1, session_ref: mainTip }
    const forkHandle = await adapter.fork(forkRef, '侧问问题')
    expect(forkHandle.seq).toBe(2)
    await waitState(adapter, forkHandle, 'exited')

    // 主线继续跑到 finish_task → exited。
    await adapter.sendInput(h, '继续')
    await waitState(adapter, h, 'exited')

    const mainMetaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')
    const mainMeta = JSON.parse(mainMetaRaw) as { tip_node_id: string }
    const resumeRef: IncarnationRef = { worker_id: s.worker_id, seq: 1, session_ref: mainMeta.tip_node_id }

    const resumedHandle = await adapter.resume(resumeRef, '我回来了')
    expect(resumedHandle.seq).toBe(3)
    await waitState(adapter, resumedHandle, 'idle')
  })

  it('五轮 review PoC：resume 时 nextSeq 必须磁盘感知，不能只看内存 instances（重建/常驻不全时会与磁盘上未重建的化身撞号，覆盖其 meta/output）', async () => {
    // builtin 的 resume/fork 目前要求 worker_id 在 builtinConfigs 里“本进程 spawn 过”
    // （见 resume()/fork() 顶部的 fail-fast 守卫），跨进程重启后这个守卫本身就会先于
    // nextSeq 拒绝调用——不像 cc/codex 那样能在重启后经 ensureRuntime 走到 nextSeq。
    // 但 nextSeq 只扫 this.instances（内存）这件事本身就是 bug：只要该 worker 有一个化身
    // 不在 instances 里（不管是因为跨进程重启、还是内存表未完整重建），nextSeq 就会漏看
    // 磁盘上它的号位。这里不模拟完整重启，而是直接删掉 fork 化身（#2）在内存 instances
    // 里的条目——精确复现"内存不知道 #2 存在，但磁盘上 meta-2.json/output-2.log 都在"
    // 这个 nextSeq 唯一关心的前提条件，同时保留 builtinConfigs/#1 条目以满足与本次修复
    // 无关的既有守卫。
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([
        { text: '首轮回复', stopReason: 'end_turn' },
        { text: '侧问回复', stopReason: 'end_turn' },
        { toolCalls: [{ name: 'finish_task', id: 'call_1', input: { outcome: 'completed', summary: '主线完成' } }], stopReason: 'tool_use' },
        { text: '重启后继续', stopReason: 'end_turn' },
      ]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    const tree1 = await SessionTree.load(join(tmp, s.worker_id, 'session.jsonl'))
    const mainTip = tree1.latestTip()!
    const forkRef: IncarnationRef = { worker_id: s.worker_id, seq: 1, session_ref: mainTip }
    const forkHandle = await adapter.fork(forkRef, '侧问问题')
    expect(forkHandle.seq).toBe(2)
    await waitState(adapter, forkHandle, 'exited')

    // 主线继续跑到 finish_task → exited，满足 resume 的前置条件。
    await adapter.sendInput(h, '继续')
    await waitState(adapter, h, 'exited')

    const meta2Before = await fs.readFile(join(tmp, s.worker_id, 'meta-2.json'), 'utf-8')
    const output2Before = await fs.readFile(join(tmp, s.worker_id, 'output-2.log'), 'utf-8')

    const mainMetaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')
    const mainMeta = JSON.parse(mainMetaRaw) as { tip_node_id: string }
    const resumeRef: IncarnationRef = { worker_id: s.worker_id, seq: 1, session_ref: mainMeta.tip_node_id }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapterAny = adapter as any
    expect((adapterAny.instances as Map<string, unknown>).has(`${s.worker_id}#2`)).toBe(true)
    ;(adapterAny.instances as Map<string, unknown>).delete(`${s.worker_id}#2`)

    // 旧版 nextSeq 只扫内存 instances：此时只剩 #1，算出 2——与磁盘上 #2 的号位撞上，
    // resume 会用 writeMeta(dir, 2, ...) 覆盖 meta-2.json，新化身的 outputLog 也指向
    // 复用中的 output-2.log。
    const resumedHandle = await adapter.resume(resumeRef, '我回来了')
    await waitState(adapter, resumedHandle, 'idle')

    // 磁盘感知修复后：新化身分配到 3（不是 2），不撞上 #2 的号位。
    expect(resumedHandle.seq).toBe(3)

    // #2 的 meta/output 原封不动，没有被 resume 静默覆盖/复用。
    const meta2After = await fs.readFile(join(tmp, s.worker_id, 'meta-2.json'), 'utf-8')
    const output2After = await fs.readFile(join(tmp, s.worker_id, 'output-2.log'), 'utf-8')
    expect(meta2After).toBe(meta2Before.toString())
    expect(output2After).toBe(output2Before.toString())
  })

  it('kill running fork 化身：fork burst 的 abortSignal 被触发，终态 exited(killed) 而不是 crashed', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const gate = deferred<void>()
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapterGatedFromSecondCall(gate.promise, [
        { text: '首轮回复', stopReason: 'end_turn' },
        { text: '侧问回复', stopReason: 'end_turn' },
      ]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    const tree = await SessionTree.load(join(tmp, s.worker_id, 'session.jsonl'))
    const mainTip = tree.latestTip()!
    const prevRef: IncarnationRef = { worker_id: s.worker_id, seq: 1, session_ref: mainTip }

    // fork 调用会触发 fork burst，其中会卡在 gate（因为是第二次调用）
    const forkHandle = await adapter.fork(prevRef, '侧问问题')
    expect(forkHandle.seq).toBe(2)

    // 等待足够长的时间让 fork burst 进入卡在 gate 的状态
    await new Promise((r) => setTimeout(r, 100))

    // 确认 fork burst 的 abortSignal 已被创建（第二次 runEngine 调用是 fork 的）
    expect(runEngineSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    const forkCallArgs = runEngineSpy.mock.calls[1]?.[0]
    expect(forkCallArgs?.options?.abortSignal).toBeDefined()
    expect(forkCallArgs?.options?.abortSignal?.aborted).toBe(false) // 还没被 abort

    // kill fork 化身
    await adapter.kill(forkHandle)

    // 确认 kill 后 abortSignal 被触发
    expect(forkCallArgs?.options?.abortSignal?.aborted).toBe(true)

    // 放行 gate 让 fork burst 继续，会检测到 abortSignal 被触发
    gate.resolve()
    await waitState(adapter, forkHandle, 'exited')

    // 验证 fork 化身的终态：应该是 exited(killed)，不能是 crashed
    const forkMetaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-2.json'), 'utf-8')
    const forkMeta = JSON.parse(forkMetaRaw)
    expect(forkMeta.state).toBe('exited')
    expect(forkMeta.ended_reason).toBe('killed') // 这是关键断言，当前代码会返回 'crashed'
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

  it('resume 失败后可重试：append 抛错不阻断后续重试（幂等性）', async () => {
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

    // 首次 resume 时 sessionTree.append 会抛错，模拟磁盘瞬时故障。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapterAny = adapter as any
    let appendCallCount = 0
    // 找到 worker 的 sessionTree（从任意 instance 中取出）
    let sessionTreeInstance: SessionTree | undefined
    for (const inst of (adapterAny.instances as Map<string, any>).values()) {
      if (inst.worker_id === s.worker_id) {
        sessionTreeInstance = inst.sessionTree
        break
      }
    }
    expect(sessionTreeInstance).toBeDefined()

    const originalAppend = sessionTreeInstance!.append.bind(sessionTreeInstance)
    sessionTreeInstance!.append = vi.fn(async (...args) => {
      appendCallCount++
      if (appendCallCount === 1) {
        throw new Error('simulated transient disk error')
      }
      return originalAppend(...args)
    })

    // 第一次 resume 失败
    const firstResumeResult = await Promise.allSettled([adapter.resume(prevRef, '尝试1')])
    expect(firstResumeResult[0]!.status).toBe('rejected')
    const firstError = (firstResumeResult[0] as PromiseRejectedResult).reason
    expect(firstError instanceof Error ? firstError.message : String(firstError)).toMatch(/transient disk error/)

    // 第二次 resume 应该成功（不被"重复 resume"拒绝）
    const secondResumeResult = await Promise.allSettled([adapter.resume(prevRef, '尝试2')])
    expect(secondResumeResult[0]!.status).toBe('fulfilled')
    const successfulHandle = (secondResumeResult[0] as PromiseFulfilledResult<IncarnationHandle>).value
    expect(successfulHandle.seq).toBe(2)
    await waitState(adapter, successfulHandle, 'idle')

    // 第三次 resume 才应该被拒（真正的重复 resume）
    const thirdResumeResult = await Promise.allSettled([adapter.resume(prevRef, '尝试3')])
    expect(thirdResumeResult[0]!.status).toBe('rejected')
    const thirdError = (thirdResumeResult[0] as PromiseRejectedResult).reason
    expect(thirdError instanceof Error ? thirdError.message : String(thirdError)).toMatch(/already resumed/)
  })

  it('resume 失败后可重试：writeMeta 抛错后重试成功（不留孤儿实例）', async () => {
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

    // 首次 resume 时 writeMeta 会抛错，模拟磁盘写入瞬时故障。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapterAny = adapter as any
    let writeMetaCallCount = 0
    const originalWriteMeta = adapterAny.writeMeta.bind(adapter)
    adapterAny.writeMeta = vi.fn(async (...args) => {
      writeMetaCallCount++
      if (writeMetaCallCount === 1) {
        throw new Error('simulated writeMeta disk error')
      }
      return originalWriteMeta(...args)
    })

    // 第一次 resume 失败（writeMeta 抛错）
    const firstResumeResult = await Promise.allSettled([adapter.resume(prevRef, '尝试1')])
    expect(firstResumeResult[0]!.status).toBe('rejected')
    const firstError = (firstResumeResult[0] as PromiseRejectedResult).reason
    expect(firstError instanceof Error ? firstError.message : String(firstError)).toMatch(/writeMeta disk error/)

    // 验证没有留下孤儿实例：instances 里不应该有 seq=2 的条目
    // （因为 writeMeta 失败了，instances.set 还没执行）
    const key2Before = `${s.worker_id}#2`
    expect((adapterAny.instances as Map<string, any>).has(key2Before)).toBe(false)

    // 第二次 resume 应该成功（不被"重复 resume"拒绝）
    const secondResumeResult = await Promise.allSettled([adapter.resume(prevRef, '尝试2')])
    expect(secondResumeResult[0]!.status).toBe('fulfilled')
    const successfulHandle = (secondResumeResult[0] as PromiseFulfilledResult<IncarnationHandle>).value
    expect(successfulHandle.seq).toBe(2)
    await waitState(adapter, successfulHandle, 'idle')

    // 验证元数据确实被写入磁盘
    const meta2Raw = await fs.readFile(join(tmp, s.worker_id, 'meta-2.json'), 'utf-8')
    const meta2 = JSON.parse(meta2Raw)
    expect(meta2.state).toBe('idle')

    // 第三次 resume 才应该被拒（真正的重复 resume）
    const thirdResumeResult = await Promise.allSettled([adapter.resume(prevRef, '尝试3')])
    expect(thirdResumeResult[0]!.status).toBe('rejected')
    const thirdError = (thirdResumeResult[0] as PromiseRejectedResult).reason
    expect(thirdError instanceof Error ? thirdError.message : String(thirdError)).toMatch(/already resumed/)
  })

  // --- kill / 崩溃恢复扫描 ---

  it('kill running 化身：burst 的 abortSignal 被触发，终态 exited(killed)', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const gate = deferred<void>()
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeGatedAdapter(gate.promise, [{ text: '不会被看到的回复', stopReason: 'end_turn' }]),
    })

    const h = await adapter.spawn(s)
    expect(await adapter.state(h)).toBe('running')

    await adapter.kill(h)

    // abortSignal 已经被触发——burst 还卡在 gate 里，尚未来得及跑完。
    const callArgs = runEngineSpy.mock.calls[0]?.[0]
    const abortSignal = callArgs?.options?.abortSignal
    expect(abortSignal).toBeDefined()
    expect(abortSignal?.aborted).toBe(true)
    expect(await adapter.state(h)).toBe('running') // burst 还没真正收尾

    // 放行 gate：stream 恢复，query-loop 在检测到 abortSignal.aborted 后以 outcome='aborted' 收尾。
    gate.resolve()
    await waitState(adapter, h, 'exited')

    const metaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')
    const meta = JSON.parse(metaRaw)
    expect(meta.state).toBe('exited')
    expect(meta.ended_reason).toBe('killed')
  })

  it('kill 打在 sendInput(idle→running) 转态后、续 burst 安装新 controller 前的窗口 → 终态 exited(killed)，不起新 burst（P1 全分支终审回归）', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([
        { text: '第一轮回复', stopReason: 'end_turn' },
        { text: '不应该被看到的第二轮回复', stopReason: 'end_turn' },
      ]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')
    expect(runEngineSpy).toHaveBeenCalledTimes(1)

    // 精确命中窗口①：覆写 transitionState，在 sendInput 的 idle→running 转态落定后（仍在
    // sendInput 那次 mutex.run 的临界区内、锁释放前）插入一次 kill 调用——kill 因此在锁
    // 队列里排在"续 burst 安装新 controller"的 continuation 之前获锁，复现终审描述的
    // "kill abort 了旧 controller、新 burst 照跑"竞态。覆写手法与既有窗口②测试一致。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapterAny = adapter as any
    const originalTransitionState = adapterAny.transitionState.bind(adapter)
    let killPromise: Promise<void> | undefined
    adapterAny.transitionState = async (instanceArg: unknown, handleArg: unknown, state: string) => {
      const result = await originalTransitionState(instanceArg, handleArg, state)
      if (state === 'running' && !killPromise) {
        killPromise = adapter.kill(h)
      }
      return result
    }

    await adapter.sendInput(h, '追加的问题')
    await killPromise
    await waitState(adapter, h, 'exited')

    const metaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')
    const meta = JSON.parse(metaRaw)
    expect(meta.state).toBe('exited')
    expect(meta.ended_reason).toBe('killed')

    // 续 burst 没有真正起来：runEngine 调用次数仍停在 spawn 那一次，第二轮回复没被消费。
    expect(runEngineSpy).toHaveBeenCalledTimes(1)
    const { chunk } = await adapter.readOutput(h, { offset: 0 })
    expect(chunk).not.toContain('不应该被看到的第二轮回复')
  })

  it('kill idle 化身 → 直接 exited(killed)，不经过 burst', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([{ text: '首轮回复', stopReason: 'end_turn' }]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    await adapter.kill(h)
    expect(await adapter.state(h)).toBe('exited')

    const metaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')
    const meta = JSON.parse(metaRaw)
    expect(meta.state).toBe('exited')
    expect(meta.ended_reason).toBe('killed')
  })

  it('kill 已 exited 的化身 → 幂等返回，不抛错、不覆盖原 ended_reason', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([
        { toolCalls: [{ name: 'finish_task', id: 'call_1', input: { outcome: 'completed', summary: '搞定了' } }], stopReason: 'tool_use' },
      ]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'exited')

    await expect(adapter.kill(h)).resolves.toBeUndefined()
    await expect(adapter.kill(h)).resolves.toBeUndefined()

    const metaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')
    const meta = JSON.parse(metaRaw)
    expect(meta.state).toBe('exited')
    expect(meta.ended_reason).toBe('completed') // kill 没有覆盖掉原本的终态原因
  })

  // --- scanOrphans（崩溃恢复扫描）---

  describe('BuiltinWorkerAdapter.scanOrphans', () => {
    it('把 state=running 的 meta 原子改写为 exited(crashed) 并返回；坏 JSON 文件跳过', async () => {
      const runningDir = join(tmp, 'worker-running')
      await fs.mkdir(runningDir, { recursive: true })
      await fs.writeFile(
        join(runningDir, 'meta-1.json'),
        JSON.stringify({ seq: 1, state: 'running', tip_node_id: 'node-1' }),
        'utf-8',
      )

      const idleDir = join(tmp, 'worker-idle')
      await fs.mkdir(idleDir, { recursive: true })
      await fs.writeFile(
        join(idleDir, 'meta-1.json'),
        JSON.stringify({ seq: 1, state: 'idle', tip_node_id: 'node-2' }),
        'utf-8',
      )

      const corruptDir = join(tmp, 'worker-corrupt')
      await fs.mkdir(corruptDir, { recursive: true })
      await fs.writeFile(join(corruptDir, 'meta-1.json'), '{ not valid json', 'utf-8')

      const orphans = await BuiltinWorkerAdapter.scanOrphans(tmp)

      expect(orphans).toEqual([{ worker_id: 'worker-running', seq: 1, impl: 'builtin', session_ref: 'node-1' }])

      const runningMeta = JSON.parse(await fs.readFile(join(runningDir, 'meta-1.json'), 'utf-8'))
      expect(runningMeta.state).toBe('exited')
      expect(runningMeta.ended_reason).toBe('crashed')
      expect(runningMeta.tip_node_id).toBe('node-1') // 其余字段保留

      const idleMeta = JSON.parse(await fs.readFile(join(idleDir, 'meta-1.json'), 'utf-8'))
      expect(idleMeta.state).toBe('idle') // 未被扫描器改动

      const corruptRaw = await fs.readFile(join(corruptDir, 'meta-1.json'), 'utf-8')
      expect(corruptRaw).toBe('{ not valid json') // 坏文件原样保留，未被改写
    })

    it('空 dataDir 或不存在时返回空数组', async () => {
      const emptyDir = join(tmp, 'does-not-exist')
      const orphans = await BuiltinWorkerAdapter.scanOrphans(emptyDir)
      expect(orphans).toEqual([])
    })
  })

  // --- runBurst/runForkBurst: outputLog.append 失败不触发 unhandledRejection ---

  /** 临时挂一个 unhandledRejection 监听，收集 reason，测试结束时摘掉。 */
  function captureUnhandledRejections(): { reasons: unknown[]; restore: () => void } {
    const reasons: unknown[] = []
    const listener = (reason: unknown) => {
      reasons.push(reason)
    }
    process.on('unhandledRejection', listener)
    return { reasons, restore: () => process.removeListener('unhandledRejection', listener) }
  }

  /**
   * 第一轮受 gate 控制（放行前装好 outputLog.append 的 reject mock）；第二轮起插入一段
   * *真实*的宏任务延迟（setTimeout，不是受测试代码控制的 deferred）——复现"burst 跨越
   * 多个真实事件循环 tick"的场景，让第一轮 onTurn 里 push 的 rejecting promise 在真正被
   * Promise.all 接住之前，有机会先被 Node 判定为 unhandledRejection（这正是线上"burst
   * 跑几分钟"场景的加速版：用一次真实 setTimeout 制造出同等性质的事件循环间隔，而不是
   * 单纯堆微任务——否则 Promise.all 的 .then 几乎在同一轮微任务里就把 handler 接上，
   * 复现不出 bug）。第一轮工具调一个不存在的工具名，让 engine 走"tool not found”错误
   * 结果分支后继续下一轮，而不是直接 end_turn 收尾。
   */
  function makeAdapterGatedThenRealDelay(
    gate: Promise<void>,
    delayMs: number,
    responses: Array<{
      text?: string
      toolCalls?: Array<{ name: string; id: string; input: Record<string, unknown> }>
      stopReason: 'end_turn' | 'tool_use'
    }>,
  ): LLMAdapter {
    let i = 0
    return {
      stream: vi.fn(async function* () {
        if (i === 0) {
          await gate
        } else {
          await new Promise((r) => setTimeout(r, delayMs))
        }
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

  it('runBurst: onTurn 里 outputLog.append reject 不触发 unhandledRejection，化身按 crashed 收尾', async () => {
    const capture = captureUnhandledRejections()
    try {
      const gate = deferred<void>()
      const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
      const s = spec({
        adapter: makeAdapterGatedThenRealDelay(gate.promise, 50, [
          { text: '第一轮输出(落盘会失败)', toolCalls: [{ name: 'no_such_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' },
          { text: '第二轮输出', stopReason: 'end_turn' },
        ]),
      })

      const h = await adapter.spawn(s)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapterAny = adapter as any
      const instance = (adapterAny.instances as Map<string, { outputLog: { append: (t: string) => Promise<void> } }>).get(
        `${s.worker_id}#1`,
      )
      expect(instance).toBeDefined()
      // 顶替掉 outputLog.append，让 onTurn 里的落盘调用 reject——模拟磁盘写失败。
      instance!.outputLog.append = vi.fn(async () => {
        throw new Error('simulated output-log disk error')
      })

      gate.resolve()
      await waitState(adapter, h, 'exited')

      expect(capture.reasons).toEqual([])

      const metaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')
      const meta = JSON.parse(metaRaw)
      expect(meta.state).toBe('exited')
      expect(meta.ended_reason).toBe('crashed')
    } finally {
      capture.restore()
    }
  })

  it('runForkBurst: onTurn 里 outputLog.append reject 不触发 unhandledRejection，fork 化身按 crashed 收尾', async () => {
    const capture = captureUnhandledRejections()
    try {
      const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
      const s = spec({
        adapter: makeAdapter([{ text: '主线首轮', stopReason: 'end_turn' }]),
      })

      const h = await adapter.spawn(s)
      await waitState(adapter, h, 'idle')

      const metaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')
      const meta = JSON.parse(metaRaw) as { tip_node_id: string }
      const prevRef: IncarnationRef = { worker_id: s.worker_id, seq: 1, session_ref: meta.tip_node_id }

      const forkGate = deferred<void>()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapterAny = adapter as any
      const builtinConfig = (adapterAny.builtinConfigs as Map<string, { adapter: unknown }>).get(s.worker_id)!
      builtinConfig.adapter = makeAdapterGatedThenRealDelay(forkGate.promise, 50, [
        { text: '侧问第一轮(落盘会失败)', toolCalls: [{ name: 'no_such_tool', id: 'call_1', input: {} }], stopReason: 'tool_use' },
        { text: '侧问第二轮', stopReason: 'end_turn' },
      ])

      const forkHandle = await adapter.fork(prevRef, '侧问一下')
      const forkInstance = (adapterAny.instances as Map<string, { outputLog: { append: (t: string) => Promise<void> } }>).get(
        `${s.worker_id}#${forkHandle.seq}`,
      )
      expect(forkInstance).toBeDefined()
      forkInstance!.outputLog.append = vi.fn(async () => {
        throw new Error('simulated output-log disk error (fork)')
      })

      forkGate.resolve()
      await waitState(adapter, forkHandle, 'exited')

      expect(capture.reasons).toEqual([])

      const forkMetaRaw = await fs.readFile(join(tmp, s.worker_id, `meta-${forkHandle.seq}.json`), 'utf-8')
      const forkMeta = JSON.parse(forkMetaRaw)
      expect(forkMeta.state).toBe('exited')
      expect(forkMeta.ended_reason).toBe('crashed')
    } finally {
      capture.restore()
    }
  })

  // --- 安全网自身兜底：transitionExited 二次抛错不触发 unhandledRejection ---

  it('safetyNetExit: runBurst 意外抛错后，安全网自己的 transitionExited(writeMeta) 再抛错也不触发 unhandledRejection、不崩进程', async () => {
    const capture = captureUnhandledRejections()
    try {
      const gate = deferred<void>()
      const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
      const s = spec({
        adapter: makeGatedAdapter(gate.promise, [{ text: '首轮输出(落盘会失败)', stopReason: 'end_turn' }]),
      })

      const h = await adapter.spawn(s)
      expect(await adapter.state(h)).toBe('running')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapterAny = adapter as any
      const instance = (adapterAny.instances as Map<string, { outputLog: { append: (t: string) => Promise<void> } }>).get(
        `${s.worker_id}#1`,
      )
      expect(instance).toBeDefined()
      // onTurn 里的落盘失败 → runBurst 走 writeErrors 分支，向外抛错，命中 spawn() 里
      // this.runBurst(...).catch(...) 这层安全网。
      instance!.outputLog.append = vi.fn(async () => {
        throw new Error('simulated output-log disk error')
      })

      // 安全网内部会调 transitionExited → writeMeta：这里让它也抛错，模拟 ENOSPC/EIO 之类
      // "安全网自己也救不回来"的场景——修复前这个 rejection 没人接，会成为 unhandledRejection。
      let writeMetaCalled: () => void = () => {}
      const writeMetaCalledPromise = new Promise<void>((resolve) => {
        writeMetaCalled = resolve
      })
      const originalWriteMeta = adapterAny.writeMeta.bind(adapter)
      adapterAny.writeMeta = vi.fn(async (...args: unknown[]) => {
        writeMetaCalled()
        throw new Error('simulated writeMeta disk error (safety net)')
      })

      gate.resolve()
      await writeMetaCalledPromise
      // writeMeta 抛错发生在微任务链路更深处，给事件循环留出真实的宏任务间隔，让
      // Node 有机会把"没人接住的 rejection"判定为 unhandledRejection（修复前会命中）。
      await new Promise((r) => setTimeout(r, 50))
      await new Promise((r) => setTimeout(r, 50))

      expect(capture.reasons).toEqual([])

      // 化身状态不可靠是预期的（writeMeta 一直失败，磁盘/内存都没能落到 exited），
      // 这里只关心"没有崩进程"，不对 instance.state 做强断言。
      adapterAny.writeMeta = originalWriteMeta
    } finally {
      capture.restore()
    }
  })

  // --- spawn: 重复 worker_id fail-fast ---

  it('spawn 同一 worker_id 两次(本进程内存已有化身) → 第二次 fail-fast 抛错，不影响第一个化身', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const workerId = randomUUID()
    const s1 = spec({ adapter: makeAdapter([{ text: '第一次', stopReason: 'end_turn' }]), worker_id: workerId })
    const h1 = await adapter.spawn(s1)
    await waitState(adapter, h1, 'idle')

    const s2 = spec({ adapter: makeAdapter([{ text: '第二次', stopReason: 'end_turn' }]), worker_id: workerId })
    await expect(adapter.spawn(s2)).rejects.toThrow(/already spawned/)

    // 第一个化身状态未被破坏。
    expect(await adapter.state(h1)).toBe('idle')
  })

  it('spawn 跨进程重复:磁盘已有 meta-1.json 但新 adapter 实例内存为空 → fail-fast 抛错', async () => {
    const workerId = randomUUID()
    const adapter1 = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s1 = spec({ adapter: makeAdapter([{ text: '第一次', stopReason: 'end_turn' }]), worker_id: workerId })
    const h1 = await adapter1.spawn(s1)
    await waitState(adapter1, h1, 'idle')

    // 模拟新进程重启：全新 adapter 实例，instances/builtinConfigs 都是空的，只有磁盘留着旧化身。
    const adapter2 = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s2 = spec({ adapter: makeAdapter([{ text: '第二次', stopReason: 'end_turn' }]), worker_id: workerId })
    await expect(adapter2.spawn(s2)).rejects.toThrow(/already has meta-1\.json on disk/)
  })

  it('spawn 背靠背并发不 await 同一 worker_id：恰一个成功一个被拒，session.jsonl 单根，仅一个 burst 起跑', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const workerId = randomUUID()
    const s1 = spec({ adapter: makeAdapter([{ text: '第一个 spawn 的回复', stopReason: 'end_turn' }]), worker_id: workerId })
    const s2 = spec({ adapter: makeAdapter([{ text: '第二个 spawn 的回复', stopReason: 'end_turn' }]), worker_id: workerId })

    // 关键：两次调用之间不 await——复现"两次并发 spawn 同一 worker_id 都穿过三重守卫"的
    // 竞态场景（守卫检查与提交之间隔着多个 await，不加锁的话两次调用都会读到守卫落空）。
    const results = await Promise.allSettled([adapter.spawn(s1), adapter.spawn(s2)])

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<IncarnationHandle> => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason
    expect(rejectedReason instanceof Error ? rejectedReason.message : String(rejectedReason)).toMatch(/already spawned/)

    const winner = fulfilled[0]!.value
    await waitState(adapter, winner, 'idle')

    // session.jsonl 单根：被拒的那次从未建根节点/写 meta，不会跟赢家的根节点混进同一棵树。
    const nodes = await loadRawNodes(workerId)
    const roots = nodes.filter((n) => n.parent_id === null)
    expect(roots.length).toBe(1)

    // 仅一个 burst 起跑：被拒的那次从未提交，自然也不会 fire-and-forget 起 runBurst。
    expect(runEngineSpy).toHaveBeenCalledTimes(1)
  })

  // --- onStateChange 异常隔离：观察者永不阻断状态机 ---

  it('onStateChange 回调同步抛错 → 状态机继续运行，终态正确，错误仅 console.error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onStateChangeErrors: Error[] = []

    const adapter = new BuiltinWorkerAdapter({
      dataDir: tmp,
      onStateChange: () => {
        const err = new Error('onStateChange observer error')
        onStateChangeErrors.push(err)
        throw err
      },
    })

    const s = spec({
      adapter: makeAdapter([
        { text: '首轮回复', stopReason: 'end_turn' },
        { text: '第二轮回复', stopReason: 'end_turn' },
      ]),
    })

    // spawn 触发 transitionState(running→idle)，其中 onStateChange 会抛错。
    // 状态机应该继续运转，不被回调错误打断。
    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    // 第一次 transitionState 调用（spawn→idle）抛错被捕获
    expect(onStateChangeErrors.length).toBeGreaterThan(0)
    expect(consoleErrorSpy).toHaveBeenCalled()

    // sendInput(idle→running)：状态机从 idle 正常转到 running，再回 idle，
    // 第二次和第三次 onStateChange 调用都会抛错。
    const errorCountBefore = onStateChangeErrors.length
    await adapter.sendInput(h, '后续问题')
    await waitState(adapter, h, 'idle')

    // 状态机应该跑到底，终态正确，onStateChange 又被调用多次且每次都抛错
    expect(await adapter.state(h)).toBe('idle')
    expect(onStateChangeErrors.length).toBeGreaterThan(errorCountBefore)

    // console.error 应该被多次调用（每次 onStateChange 抛错一次）
    expect(consoleErrorSpy.mock.calls.length).toBeGreaterThan(1)

    // 验证 meta 文件的最终状态正确（不被 onStateChange 抛错覆盖）
    const metaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')
    const meta = JSON.parse(metaRaw)
    expect(meta.state).toBe('idle')

    consoleErrorSpy.mockRestore()
  })

  // --- fork: 提交次序对齐 resume(writeMeta 成功后才 instances.set) ---

  it('fork: writeMeta 抛错 → instances 无残留(提交次序与 resume 对齐)', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({ adapter: makeAdapter([{ text: '主线首轮', stopReason: 'end_turn' }]) })
    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    const metaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')
    const meta = JSON.parse(metaRaw) as { tip_node_id: string }
    const prevRef: IncarnationRef = { worker_id: s.worker_id, seq: 1, session_ref: meta.tip_node_id }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapterAny = adapter as any
    const originalWriteMeta = adapterAny.writeMeta.bind(adapter)
    let writeMetaCallCount = 0
    adapterAny.writeMeta = vi.fn(async (...args: unknown[]) => {
      writeMetaCallCount++
      if (writeMetaCallCount === 1) {
        throw new Error('simulated writeMeta disk error (fork)')
      }
      return originalWriteMeta(...args)
    })

    await expect(adapter.fork(prevRef, '侧问')).rejects.toThrow(/simulated writeMeta disk error \(fork\)/)

    // writeMeta 失败了，instances 里不应该有 seq=2 的孤儿条目。
    const key2 = `${s.worker_id}#2`
    expect((adapterAny.instances as Map<string, unknown>).has(key2)).toBe(false)

    // 重试应该能成功（fork 没有像 resume 那样的"重复"标记，重试是无副作用的）。
    const retryHandle = await adapter.fork(prevRef, '侧问-重试')
    expect(retryHandle.seq).toBe(2)
    await waitState(adapter, retryHandle, 'exited')
  })

  // --- 上下文压缩（F2） ---

  it('burst 内发生压缩 → 不得把错位后缀嫁接到老链（数据损坏复现）', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const llm = makeCompactionAwareAdapter(compactionScript())
    const s = spec({ adapter: llm, tools: [ECHO_TOOL], contextWindowTokens: 2000 })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    // 第一段 burst 建出 13 条消息的老链（1 prompt + 5×(assistant tool_use + toolResults) + 1 收口
    // assistant = 12，再加下面 sendInput 的 1 条 user）。
    const treeAfterBurst1 = await SessionTree.load(join(tmp, s.worker_id, 'session.jsonl'))
    const tipAfterBurst1 = treeAfterBurst1.latestTip()!
    const oldChainLen = treeAfterBurst1.pathTo(tipAfterBurst1).length
    expect(oldChainLen).toBe(12)

    await adapter.sendInput(h, '继续干活')
    await waitState(adapter, h, 'idle')

    // 第二段 burst：turn 1 汇报 1900 tokens（阈值 2000×0.8=1600）→ turn 2 开头触发压缩，
    // 压缩把 15 条重写成 8 条，随后又跑到 15 条收口。L(15) >= N(13) —— 旧的 length 防御断言
    // 不会触发，静默放行。
    expect(llm.compactionCalls).toBeGreaterThan(0)

    const tree = await SessionTree.load(join(tmp, s.worker_id, 'session.jsonl'))
    const meta = JSON.parse(await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')) as { tip_node_id: string }
    const path = tree.pathTo(meta.tip_node_id)
    const serialized = JSON.stringify(path)

    // ① 摘要节点必须在路径里（后缀 slice 会把它掐掉）。
    expect(serialized).toContain('[Earlier conversation summary]')
    // ② 压缩后新生成的消息一条都不能丢（后缀 slice 会掐掉 b1/b2/b3）。
    for (const id of ['b1', 'b2', 'b3', 'b4']) {
      expect(serialized).toContain(id)
    }
    // ③ 路径里不得出现孤儿 tool_result —— 它会让后续任何 resume/fork 永久 API 400。
    expect(orphanToolResultIds(path)).toEqual([])
  })

  it('压缩后老链一个节点不删：从压缩点之前的节点仍能 fork，拿到的是未压缩全量', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const llm = makeCompactionAwareAdapter([
      ...compactionScript(),
      // fork 侧问：第一轮汇报满窗口 usage，逼出第二轮开头的压缩——从压缩点之前的老节点
      // fork 拿到的是未压缩全量，本来就可能超窗口，fork burst 必须自己也能压。
      { toolCalls: [{ name: 'echo', id: 'f1', input: {} }], stopReason: 'tool_use', usage: { inputTokens: 1900, outputTokens: 50 } },
      { text: 'fork 侧问回复', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 10 } },
    ])
    const s = spec({ adapter: llm, tools: [ECHO_TOOL], contextWindowTokens: 2000 })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')
    const treeAfterBurst1 = await SessionTree.load(join(tmp, s.worker_id, 'session.jsonl'))
    const oldTip = treeAfterBurst1.latestTip()!

    await adapter.sendInput(h, '继续干活')
    await waitState(adapter, h, 'idle')

    // 老链仍然完整可回溯（压缩点之前的节点）。
    const tree = await SessionTree.load(join(tmp, s.worker_id, 'session.jsonl'))
    const oldPath = tree.pathTo(oldTip)
    expect(oldPath.length).toBe(12)
    expect(JSON.stringify(oldPath)).not.toContain('[Earlier conversation summary]')
    expect(orphanToolResultIds(oldPath)).toEqual([])

    // 从这个未压缩的老节点 fork：能跑通，且 fork burst 自己也开着压缩（否则老链 fork 必撞窗口）。
    const compactionCallsBeforeFork = llm.compactionCalls
    const forkH = await adapter.fork({ worker_id: s.worker_id, seq: 1, session_ref: oldTip }, '侧问一句')
    await waitState(adapter, forkH, 'exited')
    const forkMeta = JSON.parse(await fs.readFile(join(tmp, s.worker_id, 'meta-2.json'), 'utf-8')) as {
      ended_reason: string
      tip_node_id: string
    }
    expect(forkMeta.ended_reason).toBe('completed')
    // fork burst 内部确实压过一次（disableCompaction 若为 true，这里恒为 0）。
    expect(llm.compactionCalls).toBeGreaterThan(compactionCallsBeforeFork)

    const treeAfterFork = await SessionTree.load(join(tmp, s.worker_id, 'session.jsonl'))
    const forkPath = treeAfterFork.pathTo(forkMeta.tip_node_id)
    expect(orphanToolResultIds(forkPath)).toEqual([])
    expect(JSON.stringify(forkPath)).toContain('[Earlier conversation summary]')
    expect(JSON.stringify(forkPath)).toContain('fork 侧问回复')

    // 主线 tip 不受 fork 影响。
    const mainMeta = JSON.parse(await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')) as { tip_node_id: string }
    expect(mainMeta.tip_node_id).not.toBe(forkMeta.tip_node_id)
    expect(orphanToolResultIds(treeAfterFork.pathTo(mainMeta.tip_node_id))).toEqual([])
  })

  it('压缩后 resume：新化身从压缩链续跑，路径无孤儿 tool_result', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const llm = makeCompactionAwareAdapter([
      ...compactionScript(),
      { text: 'resume 后第一轮', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 10 } },
    ])
    const s = spec({ adapter: llm, tools: [ECHO_TOOL], contextWindowTokens: 2000 })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')
    await adapter.sendInput(h, '继续干活')
    await waitState(adapter, h, 'idle')

    await adapter.kill(h)
    const meta1 = JSON.parse(await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')) as { tip_node_id: string }
    const h2 = await adapter.resume({ worker_id: s.worker_id, seq: 1, session_ref: meta1.tip_node_id }, '醒醒')
    await waitState(adapter, h2, 'idle')

    const tree = await SessionTree.load(join(tmp, s.worker_id, 'session.jsonl'))
    const meta2 = JSON.parse(await fs.readFile(join(tmp, s.worker_id, 'meta-2.json'), 'utf-8')) as { tip_node_id: string }
    const path = tree.pathTo(meta2.tip_node_id)
    expect(orphanToolResultIds(path)).toEqual([])
    const serialized = JSON.stringify(path)
    expect(serialized).toContain('[Earlier conversation summary]')
    expect(serialized).toContain('醒醒')
    expect(serialized).toContain('resume 后第一轮')
  })

  it('未发生压缩时 write-back 仍是"后缀挂在 tip 下"：不另起新链', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({ adapter: makeAdapter([{ text: '一轮就收工', stopReason: 'end_turn' }]) })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    // 单根：prompt 根节点 + 一条 assistant，没有第二条根。
    const raw = await fs.readFile(join(tmp, s.worker_id, 'session.jsonl'), 'utf-8')
    const nodes = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { parent_id: string | null })
    expect(nodes.length).toBe(2)
    expect(nodes.filter((n) => n.parent_id === null).length).toBe(1)
  })

  it('runBurst / runForkBurst 都开压缩（disableCompaction: false）', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([
        { text: '主线首轮', stopReason: 'end_turn' },
        { text: 'fork 回复', stopReason: 'end_turn' },
      ]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')
    const meta = JSON.parse(await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')) as { tip_node_id: string }
    const forkH = await adapter.fork({ worker_id: s.worker_id, seq: 1, session_ref: meta.tip_node_id }, '侧问')
    await waitState(adapter, forkH, 'exited')

    expect(runEngineSpy.mock.calls[0]?.[0]?.options?.disableCompaction).toBe(false)
    expect(runEngineSpy.mock.calls[1]?.[0]?.options?.disableCompaction).toBe(false)
  })

  it('静默 max_tokens（engine 压缩配额耗尽）→ exited(failed)，不是 idle', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    // 每轮都返回 text='' + stop_reason='max_tokens'：engine 压两次仍不行 → finishTask()
    // 收场（outcome='completed'、finalText=''），adapter 必须把它落成真实终态。
    const s = spec({ adapter: makeSilentMaxTokensAdapter() })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'exited')

    const meta = JSON.parse(await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')) as {
      state: string
      ended_reason: string
      outcome: string
    }
    expect(meta.state).toBe('exited')
    expect(meta.ended_reason).toBe('failed')
    expect(meta.outcome).toBe('failed')

    // manager 侧看得见原因：output 里有一条明确的错误信号，不再是"零输出零错误信号"。
    const { chunk } = await adapter.readOutput(h, { offset: 0 })
    expect(chunk).toContain('上下文超限')
  })

  it('静默 max_tokens 命中时不再续 burst：pendingInputs 直接进 dead-letter', async () => {
    const gate = deferred<void>()
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({ adapter: makeSilentMaxTokensAdapter(gate.promise) })

    const h = await adapter.spawn(s)
    expect(await adapter.state(h)).toBe('running')
    await adapter.sendInput(h, '再推一把')
    gate.resolve()
    await waitState(adapter, h, 'exited')

    const meta = JSON.parse(await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')) as { ended_reason: string }
    expect(meta.ended_reason).toBe('failed')
    const { chunk } = await adapter.readOutput(h, { offset: 0 })
    expect(chunk).toContain('[dead-letter]')
    expect(chunk).toContain('再推一把')
  })

  it('fork burst 静默 max_tokens → exited(failed)，不是 completed', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({ adapter: makeSilentMaxTokensAdapter() })
    // 主线用普通 adapter 先跑出一个 tip，fork 再用静默 adapter —— 这里图省事：主线也会
    // 落 exited(failed)，但 tip 已经落定，fork 仍可从它分叉。
    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'exited')
    const meta = JSON.parse(await fs.readFile(join(tmp, s.worker_id, 'meta-1.json'), 'utf-8')) as { tip_node_id: string }

    const forkH = await adapter.fork({ worker_id: s.worker_id, seq: 1, session_ref: meta.tip_node_id }, '侧问')
    await waitState(adapter, forkH, 'exited')
    const forkMeta = JSON.parse(await fs.readFile(join(tmp, s.worker_id, 'meta-2.json'), 'utf-8')) as {
      ended_reason: string
      outcome: string
    }
    expect(forkMeta.ended_reason).toBe('failed')
    expect(forkMeta.outcome).toBe('failed')
  })
})
