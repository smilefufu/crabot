import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildWorkerTools, type WorkerToolsContext } from '../../src/manager/tools/worker-tools'
import { WorkerHarness, type HarnessDeps, type SpawnWorkerParams } from '../../src/workers/harness/harness'
import { LedgerStore } from '../../src/workers/harness/ledger-store'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager'
import { NativeActivityStore } from '../../src/workers/harness/native-activity-store'
import type { ManagerKey } from '../../src/workers/harness/ledger-types'
import type { HarnessEvent } from '../../src/workers/harness/worker-events'
import { WorkerExitedError } from '../../src/workers/errors'
import type {
  WorkerAdapter,
  WorkerImplId,
  WorkerContractState,
  IncarnationHandle,
  IncarnationRef,
  SpawnSpec,
  Workspace,
  CapabilityBundle,
  AdapterCapabilities,
  DetectResult,
  ForkOptions,
  SendInputOptions,
} from '../../src/workers/types'

// ---- FakeAdapter：实现 WorkerAdapter 契约的可编程桩，不碰 tmux/LLM（照抄
// tests/workers/harness/harness-lifecycle.test.ts 的桩写法，裁剪出本文件需要的选项）----

function handleKey(h: IncarnationHandle): string {
  return `${h.worker_id}#${h.seq}`
}

interface FakeAdapterOpts {
  readonly implId?: WorkerImplId
  readonly caps?: Partial<AdapterCapabilities>
  readonly onStateChange?: (h: IncarnationHandle, state: WorkerContractState) => void
  readonly sendInputBehavior?: (h: IncarnationHandle, text: string, opts?: SendInputOptions) => void
  readonly outputChunk?: string
}

class FakeAdapter implements WorkerAdapter {
  readonly implId: WorkerImplId
  readonly spawnCalls: SpawnSpec[] = []
  readonly sendInputCalls: Array<{ h: IncarnationHandle; text: string; opts?: SendInputOptions }> = []
  readonly killCalls: IncarnationHandle[] = []
  readonly interruptCalls: IncarnationHandle[] = []
  readonly readTerminalCalls: IncarnationHandle[] = []
  private readonly states = new Map<string, WorkerContractState>()
  private nextForkSeq = 2

  constructor(private readonly opts: FakeAdapterOpts = {}) {
    this.implId = opts.implId ?? 'builtin'
  }

  async detect(): Promise<DetectResult> {
    return { installed: true, activated: true }
  }

  async provision(_ws: Workspace, _caps: CapabilityBundle): Promise<void> {}

  async spawn(spec: SpawnSpec): Promise<IncarnationHandle> {
    this.spawnCalls.push(spec)
    const handle: IncarnationHandle = { worker_id: spec.worker_id, seq: 1, impl: this.implId, session_ref: `ref-${spec.worker_id}#1` }
    this.states.set(handleKey(handle), 'running')
    return handle
  }

  async resume(_prev: IncarnationRef, _wakeInput: string): Promise<IncarnationHandle> {
    throw new Error('FakeAdapter.resume: not exercised by worker-tools tests')
  }

  async fork(prev: IncarnationRef, _forkInput: string, opts: ForkOptions): Promise<IncarnationHandle> {
    const seq = this.nextForkSeq++
    const handle: IncarnationHandle = {
      worker_id: prev.worker_id,
      seq,
      impl: this.implId,
      session_ref: `fork-ref-${prev.worker_id}#${seq}`,
      query_id: opts.query_id,
    }
    this.states.set(handleKey(handle), 'running')
    return handle
  }

  async sendInput(h: IncarnationHandle, text: string, opts?: SendInputOptions): Promise<void> {
    this.sendInputCalls.push({ h, text, opts })
    if (this.opts.sendInputBehavior) this.opts.sendInputBehavior(h, text, opts)
  }

  async readTerminal(h: IncarnationHandle) {
    this.readTerminalCalls.push(h)
    const text = this.opts.outputChunk ?? ''
    return text ? { kind: 'headless_text' as const, text } : { kind: 'unavailable' as const, unavailable_reason: 'headless_without_text' }
  }

  async state(h: IncarnationHandle): Promise<WorkerContractState> {
    return this.states.get(handleKey(h)) ?? 'exited'
  }

  async inspectSupervisionActivity(_h: IncarnationHandle, cursor?: { offset: number }) {
    return { kind: 'unknown' as const, next_cursor: cursor ?? { offset: 0 } }
  }

  async kill(h: IncarnationHandle): Promise<void> {
    this.killCalls.push(h)
    this.states.set(handleKey(h), 'exited')
  }

  async interrupt(h: IncarnationHandle): Promise<void> {
    this.interruptCalls.push(h)
    this.states.set(handleKey(h), 'idle')
  }

  capabilities(): AdapterCapabilities {
    return { fork: false, revive: false, goalMode: false, subagent: false, structuredTrace: false, ...this.opts.caps }
  }
}

// ---- 测试夹具 ----

let dataDir: string
let nowValue: number
const events: HarnessEvent[] = []

function now(): string {
  nowValue += 1000
  return new Date(nowValue).toISOString()
}

async function makeHarness(
  fakeOpts: FakeAdapterOpts = {}
): Promise<{ harness: WorkerHarness; fake: FakeAdapter; adaptersMap: Map<WorkerImplId, WorkerAdapter> }> {
  const ledgersDir = join(dataDir, 'ledgers')
  const workspacesRoot = join(dataDir, 'workspaces')
  const workersDir = join(dataDir, 'workers')
  await fs.mkdir(workspacesRoot, { recursive: true })

  const ledger = new LedgerStore(ledgersDir)
  const workspaces = new WorkspaceManager(workspacesRoot)

  const adaptersMap = new Map<WorkerImplId, WorkerAdapter>()
  const deps: HarnessDeps = {
    adapters: adaptersMap,
    defaultImpl: 'builtin',
    ledger,
    workspaces,
    workersDir,
    now,
    onEvent: (e) => events.push(e),
  }
  const harness = new WorkerHarness(deps)
  const fake = new FakeAdapter({ ...fakeOpts, onStateChange: harness.handleStateChange })
  adaptersMap.set(fake.implId, fake)

  return { harness, fake, adaptersMap }
}

// 本套件下 manager 的固定归属：所有 spawn_worker 透传断言都对照这份 context。
const CTX: WorkerToolsContext = {
  managerKey: 'wechat::sess-1' as ManagerKey,
  episodeId: 'episode-42',
  creatorFriendId: 'friend-1',
  reportTo: { channel_id: 'wechat', session_id: 'sess-1' },
}

function directSpawnParams(overrides: Partial<SpawnWorkerParams> = {}): SpawnWorkerParams {
  return {
    managerKey: CTX.managerKey,
    title: '直接调 harness 预置的任务',
    prompt: '把活干完',
    origin: { spawned_by_episode: CTX.managerKey, trigger_type: 'message' },
    report_to: CTX.reportTo,
    ...overrides,
  }
}

function parseOutput(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>
}

/** 有界轮询：等待游离 promise（fire-and-forget）在后台落地，而不是猜测完成时机。 */
async function waitUntil(cond: () => Promise<boolean>, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`)
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(join(tmpdir(), 'worker-tools-test-'))
  nowValue = Date.parse('2026-01-01T00:00:00.000Z')
  events.length = 0
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

// ---- 工具面形状 ----

describe('buildWorkerTools — 工具面形状', () => {
  it('普通 Manager 有十六项 worker 工具；状态、活动与回合查询均为只读', async () => {
    const { harness } = await makeHarness()
    const tools = buildWorkerTools({ harness, context: () => CTX })

    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'clear_worker_periodic_report',
        'get_worker_activity',
        'get_worker_detail',
        'get_worker_state',
        'get_worker_turn',
        'list_worker_implementations',
        'list_workers',
        'query_worker',
        'get_worker_terminal',
        'send_to_worker',
        'set_worker_periodic_report',
        'spawn_worker',
        'resolve_worker_turn',
        'request_worker_interrupt',
        'request_worker_stop',
        'respond_to_worker_ui',
      ].sort()
    )

    const readOnlyNames = tools.filter((t) => t.isReadOnly).map((t) => t.name).sort()
    expect(readOnlyNames).toEqual([
      'get_worker_activity',
      'get_worker_detail',
      'get_worker_state',
      'get_worker_terminal',
      'get_worker_turn',
      'list_worker_implementations',
      'list_workers',
    ])
  })
})

describe('worker observation and turn closure', () => {
  it('活动读取缺省只请求 assistant view，显式 all 才请求工具活动', async () => {
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    const incarnationId = worker.incarnations[0].incarnation_id
    const readWorkerActivity = vi.fn(async () => ({
      incarnation_id: incarnationId,
      activities: [{
        activity_id: 'activity-1',
        worker_id: worker.worker_id,
        incarnation_id: incarnationId,
        kind: 'assistant_text' as const,
        occurred_at: '2026-01-01T00:00:00.000Z',
        summary: '已完成分析',
        text: '已完成分析',
      }],
      next_cursor: 'opaque-cursor',
    }))
    const tools = buildWorkerTools({ harness, context: () => CTX, readWorkerActivity })
    const getWorkerActivity = tools.find((tool) => tool.name === 'get_worker_activity')!

    const assistant = await getWorkerActivity.call({ worker_id: worker.worker_id }, {})
    expect(assistant.isError).toBe(false)
    expect(readWorkerActivity).toHaveBeenLastCalledWith({ worker_id: worker.worker_id, view: 'assistant' })
    expect(parseOutput(assistant.output)).toMatchObject({ worker_id: worker.worker_id, view: 'assistant', next_cursor: 'opaque-cursor' })

    const all = await getWorkerActivity.call({ worker_id: worker.worker_id, incarnation_id: incarnationId, after: 'opaque-cursor', view: 'all' }, {})
    expect(all.isError).toBe(false)
    expect(readWorkerActivity).toHaveBeenLastCalledWith({ worker_id: worker.worker_id, incarnation_id: incarnationId, after: 'opaque-cursor', view: 'all' })
  })

  it('get_worker_state 严格投影协议定义的主线、最新活动和回合字段', async () => {
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    const incarnation = worker.incarnations[0]
    const activityStore = (harness as unknown as { nativeActivityStore: NativeActivityStore }).nativeActivityStore
    await activityStore.commitObservation({
      worker_id: worker.worker_id,
      cursor: { incarnation_id: incarnation.incarnation_id, impl: incarnation.impl, seq: incarnation.seq, offset: 1 },
      activity: [{
        ts: '2026-01-01T00:01:00.000Z',
        kind: 'message',
        role: 'assistant',
        summary: '已完成分析',
        source_offset: 0,
      }],
    })
    harness.handleStateChange({
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: incarnation.impl,
      session_ref: incarnation.session_ref,
    }, 'idle', { completionSource: 'builtin_end_turn' })
    await waitUntil(async () => (await harness.getWorkerTurn(worker.worker_id)) !== undefined)

    const getWorkerState = buildWorkerTools({ harness, context: () => CTX })
      .find((tool) => tool.name === 'get_worker_state')!
    const result = await getWorkerState.call({ worker_id: worker.worker_id }, {})

    expect(result.isError).toBe(false)
    const state = parseOutput(result.output)
    expect(state).toMatchObject({
      worker_id: worker.worker_id,
      mainline: { incarnation_id: incarnation.incarnation_id, impl: 'builtin', state: 'idle' },
      forks: [],
      latest_activity: {
        activity_id: expect.any(String),
        kind: 'assistant_text',
        occurred_at: '2026-01-01T00:01:00.000Z',
      },
      latest_turn: { turn_id: expect.any(String), disposition: { status: 'pending' } },
      active_operations: [],
    })
    expect(state).not.toHaveProperty('incarnation')
    expect(state).not.toHaveProperty('task_status')
    expect(state).not.toHaveProperty('updated_at')
    expect(state.latest_turn).toEqual({
      turn_id: expect.any(String),
      disposition: { status: 'pending' },
    })
  })

  it('get_worker_state 的 fork 只暴露协议定义的字段', async () => {
    const { harness } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(directSpawnParams())
    const fork = await harness.queryWorker(worker.worker_id, '检查侧问状态')
    const getWorkerState = buildWorkerTools({ harness, context: () => CTX })
      .find((tool) => tool.name === 'get_worker_state')!

    const result = await getWorkerState.call({ worker_id: worker.worker_id }, {})

    expect(result.isError).toBe(false)
    expect(parseOutput(result.output).forks).toEqual([{
      incarnation_id: expect.any(String),
      query_id: fork.query_id,
      state: 'running',
    }])
  })

  it('get_worker_turn 在原生 trace 空读时回落到本化身已持久化的活动', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    const incarnation = worker.incarnations[0]
    const activityStore = (harness as unknown as { nativeActivityStore: NativeActivityStore }).nativeActivityStore
    await activityStore.commitObservation({
      worker_id: worker.worker_id,
      cursor: { incarnation_id: incarnation.incarnation_id, impl: incarnation.impl, seq: incarnation.seq, offset: 1 },
      activity: [{
        ts: '2026-01-01T00:01:00.000Z',
        kind: 'message',
        role: 'assistant',
        summary: '已持久化的回合结果',
        source_offset: 0,
      }],
    })
    harness.handleStateChange({
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: incarnation.impl,
      session_ref: incarnation.session_ref,
    }, 'idle', { completionSource: 'builtin_end_turn' })
    await waitUntil(async () => (await harness.getWorkerTurn(worker.worker_id)) !== undefined)
    Object.assign(fake, {
      readTrace: async () => ({ events: [], nextCursor: { offset: 0 } }),
    })

    const getWorkerTurn = buildWorkerTools({ harness, context: () => CTX })
      .find((tool) => tool.name === 'get_worker_turn')!
    const result = await getWorkerTurn.call({ worker_id: worker.worker_id }, {})

    expect(result.isError).toBe(false)
    expect(parseOutput(result.output)).toMatchObject({
      activities: [{
        kind: 'assistant_text',
        text: '已持久化的回合结果',
      }],
    })
    expect(parseOutput(result.output)).not.toHaveProperty('unavailable_reason')
  })

  it('get_worker_turn 无法取得原生或持久活动时显式标记 unavailable', async () => {
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    const incarnation = worker.incarnations[0]
    const activityStore = (harness as unknown as { nativeActivityStore: NativeActivityStore }).nativeActivityStore
    await activityStore.commitObservation({
      worker_id: worker.worker_id,
      cursor: { incarnation_id: incarnation.incarnation_id, impl: incarnation.impl, seq: incarnation.seq, offset: 1 },
    })
    harness.handleStateChange({
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: incarnation.impl,
      session_ref: incarnation.session_ref,
    }, 'idle', { completionSource: 'builtin_end_turn' })
    await waitUntil(async () => (await harness.getWorkerTurn(worker.worker_id)) !== undefined)

    const getWorkerTurn = buildWorkerTools({ harness, context: () => CTX })
      .find((tool) => tool.name === 'get_worker_turn')!
    const result = await getWorkerTurn.call({ worker_id: worker.worker_id }, {})

    expect(result.isError).toBe(false)
    expect(parseOutput(result.output)).toMatchObject({
      activities: [],
      unavailable_reason: 'worker adapter does not support structured trace reads',
    })
  })

  it('idle/exited 回合必须在当前 manager episode 成功 send_message 后才能标记已交付', async () => {
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    const handle = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }
    harness.handleStateChange(handle, 'idle', { lastText: '本轮完成', completionSource: 'builtin_end_turn' })
    await waitUntil(async () => (await harness.getWorkerTurn(worker.worker_id)) !== undefined)

    const turn = await harness.getWorkerTurn(worker.worker_id)
    expect(turn).toMatchObject({ worker_id: worker.worker_id, completion_source: 'builtin_end_turn', disposition: { status: 'pending' } })

    let sent = false
    const tools = buildWorkerTools({
      harness,
      context: () => CTX,
      hasSuccessfulSendMessageTo: (target) => sent && target.channel_id === 'wechat' && target.session_id === 'sess-1',
    })
    const getWorkerTurn = tools.find((tool) => tool.name === 'get_worker_turn')!
    const resolveWorkerTurn = tools.find((tool) => tool.name === 'resolve_worker_turn')!

    const read = await getWorkerTurn.call({ worker_id: worker.worker_id, turn_id: turn!.turn_id }, {})
    expect(read.isError).toBe(false)
    expect(parseOutput(read.output)).toMatchObject({ worker_id: worker.worker_id, turn: { turn_id: turn!.turn_id } })

    const blocked = await resolveWorkerTurn.call({ worker_id: worker.worker_id, turn_id: turn!.turn_id, resolution: 'reported' }, {})
    expect(blocked.isError).toBe(true)
    expect(blocked.output).toContain('尚未向该 worker 的 report_to 成功调用 send_message')

    sent = true
    const resolved = await resolveWorkerTurn.call({ worker_id: worker.worker_id, turn_id: turn!.turn_id, resolution: 'reported' }, {})
    expect(resolved.isError).toBe(false)
    expect(parseOutput(resolved.output)).toMatchObject({
      worker_id: worker.worker_id,
      turn: { disposition: { resolution: 'reported', resolved_at: expect.any(String) } },
    })
  })
})

// ---- spawn_worker ----

describe('spawn_worker', () => {
  it('透传 managerKey/origin/report_to 到台账，异步返回简短确认（非完整 worker 记录）', async () => {
    const { harness } = await makeHarness()
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const spawnWorker = tools.find((t) => t.name === 'spawn_worker')!

    const result = await spawnWorker.call({ title: '调查报表异常', prompt: '查一下昨天的报表为什么少了一行' }, {})
    expect(result.isError).toBe(false)

    // 异步语义体现在返回内容上：只回一份简短确认（status + worker_id [+ impl]），不是完整
    // LedgerWorker 记录——task/incarnations 等"执行结果"细节留给日后事件唤醒，见
    // src/manager/tools/worker-tools.ts 文件头"同步性语义的实现取舍"。
    const parsed = parseOutput(result.output)
    expect(parsed.status).toBe('spawned')
    expect(typeof parsed.worker_id).toBe('string')
    expect(Object.keys(parsed).sort()).toEqual(['impl', 'status', 'worker_id'])

    // 真正落盘的台账记录：origin/report_to/managerKey 与 context() 提供的完全一致。
    const listed = await harness.listWorkers(CTX.managerKey)
    const worker = listed.find((w) => w.worker_id === parsed.worker_id)
    expect(worker).toBeDefined()
    expect(worker!.origin).toEqual({
      spawned_by_episode: CTX.episodeId,
      creator_friend_id: CTX.creatorFriendId,
      trigger_type: 'message',
    })
    expect(worker!.report_to).toEqual(CTX.reportTo)
  })

  it('context() 提供 triggerType 时透传到 origin.trigger_type，缺省仍是 message', async () => {
    const { harness } = await makeHarness()
    const scheduledCtx: WorkerToolsContext = { ...CTX, triggerType: 'scheduled' }
    const tools = buildWorkerTools({ harness, context: () => scheduledCtx })
    const spawnWorker = tools.find((t) => t.name === 'spawn_worker')!

    const result = await spawnWorker.call({ title: '定时任务', prompt: '按计划执行' }, {})
    const parsed = parseOutput(result.output)
    const listed = await harness.listWorkers(CTX.managerKey)
    const worker = listed.find((w) => w.worker_id === parsed.worker_id)
    expect(worker!.origin.trigger_type).toBe('scheduled')
  })

  it('title/prompt 缺失或 impl 非法 → isError:true，且不触碰 harness', async () => {
    const { harness, fake } = await makeHarness()
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const spawnWorker = tools.find((t) => t.name === 'spawn_worker')!

    const noTitle = await spawnWorker.call({ prompt: '缺标题' }, {})
    expect(noTitle.isError).toBe(true)

    const badImpl = await spawnWorker.call({ title: 't', prompt: 'p', impl: 'not-a-real-impl' }, {})
    expect(badImpl.isError).toBe(true)

    expect(fake.spawnCalls).toHaveLength(0)
  })
})

// ---- send_to_worker ----

describe('send_to_worker', () => {
  it('普通文本入口不暴露 raw 终端旁路', async () => {
    const { harness } = await makeHarness()
    const sendToWorker = buildWorkerTools({ harness, context: () => CTX }).find((tool) => tool.name === 'send_to_worker')!
    const schema = sendToWorker.inputSchema as { properties?: Record<string, unknown> }

    expect(schema.properties).toBeDefined()
    expect(schema.properties).not.toHaveProperty('raw')
  })

  it('返回真实 delivered 回执，普通文本与 delivery_id 透传给 adapter.sendInput', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const sendToWorker = tools.find((t) => t.name === 'send_to_worker')!

    const result = await sendToWorker.call({ worker_id: worker.worker_id, text: '继续' }, {})
    expect(result.isError).toBe(false)
    const parsed = parseOutput(result.output)
    expect(parsed).toMatchObject({ status: 'delivered', worker_id: worker.worker_id })
    expect(parsed.delivery_id).toMatch(/^[0-9a-f-]{36}$/)

    expect(fake.sendInputCalls).toHaveLength(1)
    expect(fake.sendInputCalls[0].text).toBe('继续')
    expect(fake.sendInputCalls[0].opts).toMatchObject({ raw: false, delivery_id: parsed.delivery_id })
  })

  it('worker 不存在 → WorkerNotFoundError 转成可读 tool_result（isError:true，不抛出）', async () => {
    const { harness } = await makeHarness()
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const sendToWorker = tools.find((t) => t.name === 'send_to_worker')!

    const result = await sendToWorker.call({ worker_id: 'w-does-not-exist', text: '你好' }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('不存在或当前会话无权访问')
  })

  it('task 已 cancelled → TaskCancelledError 转成可读 tool_result（isError:true，不抛出）', async () => {
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    await harness.killWorker(worker.worker_id)
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const sendToWorker = tools.find((t) => t.name === 'send_to_worker')!

    const result = await sendToWorker.call({ worker_id: worker.worker_id, text: '还能收到吗' }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/cancelled/)
  })

  it('receipt 创建后的自动 handoff 失败 → 返回 failed 回执和明确原因', async () => {
    // 照抄 tests/workers/harness/harness-continuation.test.ts 里触发 ImplAlreadyUsedError 的
    // 最小配方：只注册一个（已被用过的）impl，sendInput 权威判定化身已终态，revive:false
    // 逼 continueTerminalWorker 走自动 handoff，pickUnusedImpl 无处可选，pre-flight 抛错。
    const { harness } = await makeHarness({
      caps: { revive: false },
      sendInputBehavior: (h) => {
        throw new WorkerExitedError(h.worker_id, h.seq)
      },
    })
    const worker = await harness.spawnWorker(directSpawnParams())
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const sendToWorker = tools.find((t) => t.name === 'send_to_worker')!

    const result = await sendToWorker.call({ worker_id: worker.worker_id, text: '接着做完' }, {})
    expect(result.isError).toBe(false)
    expect(parseOutput(result.output)).toMatchObject({
      status: 'failed',
      worker_id: worker.worker_id,
      reason_code: 'continuation_failed',
      certainty: 'not_delivered',
      reason: expect.stringMatching(/already has an incarnation/),
    })
  })
})

describe('query_worker', () => {
  it('等待 fork 建立后返回 started + query_id + fork_seq，但不等待回答完成', async () => {
    let releaseFork!: () => void
    const forkGate = new Promise<void>((resolve) => {
      releaseFork = resolve
    })
    const { harness, fake } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(directSpawnParams())
    const originalFork = fake.fork.bind(fake)
    fake.fork = async (prev, forkInput, opts) => {
      await forkGate
      return originalFork(prev, forkInput, opts)
    }
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const queryWorker = tools.find((t) => t.name === 'query_worker')!

    let settled = false
    const resultPromise = queryWorker.call({ worker_id: worker.worker_id, question: '现在进展如何？' }, {})
      .then((result) => { settled = true; return result })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    releaseFork()
    const result = await resultPromise
    expect(result.isError).toBe(false)
    expect(parseOutput(result.output)).toMatchObject({
      status: 'started',
      worker_id: worker.worker_id,
      fork_seq: 2,
      query_id: expect.any(String),
    })
    const [w] = await harness.listWorkers(CTX.managerKey)
    expect(w.incarnations[1]).toMatchObject({
      seq: 2,
      forked_from: w.incarnations[0].incarnation_id,
      query_id: expect.any(String),
      state: 'running',
    })
  })

  it('unknown worker is rejected before creating a query receipt', async () => {
    const { harness } = await makeHarness({ caps: { fork: true } })
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const queryWorker = tools.find((t) => t.name === 'query_worker')!
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await queryWorker.call({ worker_id: 'w-nope', question: '？' }, {})
      expect(result.isError).toBe(true)
      expect(result.output).toContain('不存在或当前会话无权访问')
      await expect(fs.access(join(dataDir, 'workers', 'w-nope', 'query-receipts.json'))).rejects.toThrow()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('fork 能力不可用时在同一次调用返回带 query_id 的结构化 tool error', async () => {
    const { harness } = await makeHarness({ caps: { fork: false } })
    const worker = await harness.spawnWorker(directSpawnParams())
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const queryWorker = tools.find((t) => t.name === 'query_worker')!
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await queryWorker.call({ worker_id: worker.worker_id, question: '？' }, {})
      expect(result.isError).toBe(true)
      expect(parseOutput(result.output)).toMatchObject({
        query_id: expect.any(String),
        reason_code: 'fork_capability_unavailable',
        reason: expect.any(String),
        certainty: 'not_started',
      })
      const receiptFile = JSON.parse(
        await fs.readFile(join(dataDir, 'workers', worker.worker_id, 'query-receipts.json'), 'utf-8'),
      ) as { receipts: Array<Record<string, unknown>> }
      const receipts = receiptFile.receipts
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        query_id: expect.any(String),
        state: 'failed',
        manager_notification: { status: 'pending' },
      })
    } finally {
      errorSpy.mockRestore()
    }
  })
})

// ---- get_worker_terminal（同步，完整终端视图） ----

describe('get_worker_terminal', () => {
  it('同步返回完整终端视图', async () => {
    const { harness } = await makeHarness({ outputChunk: '这是输出内容' })
    const worker = await harness.spawnWorker(directSpawnParams())
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const getWorkerTerminal = tools.find((t) => t.name === 'get_worker_terminal')!

    const result = await getWorkerTerminal.call({ worker_id: worker.worker_id }, {})
    expect(result.isError).toBe(false)
    const parsed = parseOutput(result.output)
    expect(parsed).toEqual({ worker_id: worker.worker_id, terminal: { kind: 'headless_text', text: '这是输出内容' } })
  })

  it('worker 不存在 → WorkerNotFoundError 转成可读 tool_result', async () => {
    const { harness } = await makeHarness()
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const getWorkerTerminal = tools.find((t) => t.name === 'get_worker_terminal')!

    const result = await getWorkerTerminal.call({ worker_id: 'w-nope' }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('不存在或当前会话无权访问')
  })

  it('传 seq → 透传给 harness.getWorkerTerminal，读到 query_worker 侧问化身的输出（不是主线）', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: true }, outputChunk: '侧问答案' })
    const worker = await harness.spawnWorker(directSpawnParams())
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const queryWorker = tools.find((t) => t.name === 'query_worker')!
    const getWorkerTerminal = tools.find((t) => t.name === 'get_worker_terminal')!

    await queryWorker.call({ worker_id: worker.worker_id, question: '现在进展如何？' }, {})
    await waitUntil(async () => {
      const [w] = await harness.listWorkers(CTX.managerKey)
      return w.incarnations.length === 2
    })

    const result = await getWorkerTerminal.call({ worker_id: worker.worker_id, seq: 2 }, {})
    expect(result.isError).toBe(false)
    const parsed = parseOutput(result.output)
    expect(parsed).toMatchObject({ terminal: { kind: 'headless_text', text: '侧问答案' } })
    expect(fake.readTerminalCalls.at(-1)?.seq).toBe(2)
  })
})

// ---- 定期汇报规则（stable worker 属性） ----

describe('worker periodic report tools', () => {
  it('把规则固定到当前 Manager 会话，覆盖旧状态并在清除后恢复默认巡检', async () => {
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const setRule = tools.find((tool) => tool.name === 'set_worker_periodic_report')!
    const clearRule = tools.find((tool) => tool.name === 'clear_worker_periodic_report')!

    const setResult = await setRule.call({
      worker_id: worker.worker_id,
      interval_minutes: 10,
      expires_at: '2026-01-01T01:00:00.000Z',
    }, {})

    expect(setResult.isError).toBe(false)
    expect(parseOutput(setResult.output)).toMatchObject({
      worker_id: worker.worker_id,
      mode: 'periodic_report',
      interval_minutes: 10,
      expires_at: '2026-01-01T01:00:00.000Z',
    })
    expect((await harness.findWorker(worker.worker_id))!.worker.supervision).toMatchObject({
      mode: 'periodic_report',
      periodic_report: {
        interval_ms: 10 * 60_000,
        expires_at: '2026-01-01T01:00:00.000Z',
        report_to: CTX.reportTo,
      },
    })

    const clearResult = await clearRule.call({ worker_id: worker.worker_id }, {})
    expect(clearResult.isError).toBe(false)
    expect(parseOutput(clearResult.output)).toMatchObject({ worker_id: worker.worker_id, mode: 'default', next_due_at: expect.any(String) })
    expect((await harness.findWorker(worker.worker_id))!.worker.supervision).toMatchObject({
      mode: 'default',
      next_due_at: expect.any(String),
    })
  })

  it('拒绝非法频率、已到期时间以及其他 Manager 的 worker，且不会写入规则', async () => {
    const { harness } = await makeHarness()
    const foreign = await harness.spawnWorker(directSpawnParams({ managerKey: 'feishu::other' as ManagerKey }))
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const setRule = tools.find((tool) => tool.name === 'set_worker_periodic_report')!
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      expect((await setRule.call({ worker_id: foreign.worker_id, interval_minutes: 0 }, {})).isError).toBe(true)
      expect((await setRule.call({ worker_id: foreign.worker_id, interval_minutes: 10, expires_at: 'not-a-date' }, {})).isError).toBe(true)
      expect((await setRule.call({ worker_id: foreign.worker_id, interval_minutes: 10 }, {})).isError).toBe(true)
    } finally {
      errorSpy.mockRestore()
    }
    expect((await harness.findWorker(foreign.worker_id))!.worker.supervision).toMatchObject({ mode: 'default' })
    expect((await harness.findWorker(foreign.worker_id))!.worker.supervision?.periodic_report).toBeUndefined()
  })
})

// ---- list_workers（同步，默认只返回决策视野） ----

describe('list_workers', () => {
  it('默认只返回非终态；历史显式 include_terminal + 分页，计数准确', async () => {
    const { harness } = await makeHarness()
    const active = await harness.spawnWorker(directSpawnParams({ title: '活跃任务' }))
    const terminal = await harness.spawnWorker(directSpawnParams({ title: '历史任务' }))
    await harness.killWorker(terminal.worker_id, '测试终态')
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const listWorkers = tools.find((t) => t.name === 'list_workers')!

    const current = await listWorkers.call({}, {})
    expect(current.isError).toBe(false)
    expect(parseOutput(current.output)).toMatchObject({
      workers: [{ worker_id: active.worker_id, supervision_mode: 'default', next_due_at: expect.any(String) }],
      total_active: 1,
      total_terminal: 1,
      pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 },
    })

    const history = await listWorkers.call({ include_terminal: true, page: 2, page_size: 1 }, {})
    expect(history.isError).toBe(false)
    const parsed = parseOutput(history.output) as {
      workers: Array<{ worker_id: string }>
      total_active: number
      total_terminal: number
      pagination: { total_items: number; total_pages: number }
    }
    expect(parsed.total_active).toBe(1)
    expect(parsed.total_terminal).toBe(1)
    expect(parsed.pagination).toMatchObject({ total_items: 2, total_pages: 2 })
    expect(parsed.workers).toHaveLength(1)
  })
})

// ---- request_worker_interrupt / request_worker_stop ----

describe('worker control operations', () => {
  it('stop 进入 native 调用时，get_worker_state 暴露持久的 executing operation', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    let entered!: () => void
    const enteredStop = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const releaseStop = new Promise<void>((resolve) => { release = resolve })
    const originalKill = fake.kill.bind(fake)
    vi.spyOn(fake, 'kill').mockImplementation(async (handle) => {
      entered()
      await releaseStop
      await originalKill(handle)
    })
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const getWorkerState = tools.find((tool) => tool.name === 'get_worker_state')!

    const stop = harness.requestWorkerStop(worker.worker_id)
    await enteredStop
    const state = await getWorkerState.call({ worker_id: worker.worker_id }, {})
    expect(state.isError).toBe(false)
    expect(parseOutput(state.output)).toMatchObject({
      mainline: { state: 'running' },
      active_operations: [{ kind: 'stop', status: 'executing' }],
    })

    release()
    await expect(stop).resolves.toMatchObject({ kind: 'stop', status: 'succeeded' })
  })

  it('native stop 后仍在运行时保持 verifying，直到后续状态回调完成核验', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    vi.spyOn(fake, 'kill').mockImplementation(async (handle) => {
      fake.killCalls.push(handle)
    })

    await expect(harness.requestWorkerStop(worker.worker_id)).resolves.toMatchObject({
      kind: 'stop',
      status: 'verifying',
    })
    expect(fake.killCalls).toHaveLength(1)
    const current = await harness.findWorker(worker.worker_id)
    expect(current?.worker.task.status).toBe('running')
  })

  it('stop 经持久 operation 核验后才把 task 转 cancelled', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const stopWorker = tools.find((t) => t.name === 'request_worker_stop')!
    const interruptWorker = tools.find((t) => t.name === 'request_worker_interrupt')!

    const interrupted = await interruptWorker.call({ worker_id: worker.worker_id }, {})
    expect(interrupted.isError).toBe(false)
    expect(parseOutput(interrupted.output)).toMatchObject({ operation: { worker_id: worker.worker_id, kind: 'interrupt', status: 'succeeded' } })
    expect(fake.interruptCalls).toHaveLength(1)
    const [afterInterrupt] = await harness.listWorkers(CTX.managerKey)
    expect(afterInterrupt.task.status).not.toBe('cancelled')

    const first = await stopWorker.call({ worker_id: worker.worker_id }, {})
    expect(first.isError).toBe(false)
    expect(parseOutput(first.output)).toMatchObject({ operation: { worker_id: worker.worker_id, kind: 'stop', status: 'succeeded' } })
    expect(fake.killCalls).toHaveLength(1)

    const [afterFirst] = await harness.listWorkers(CTX.managerKey)
    expect(afterFirst.task.status).toBe('cancelled')

  })

  it('worker 不存在 → WorkerNotFoundError 转成可读 tool_result', async () => {
    const { harness } = await makeHarness()
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const stopWorker = tools.find((t) => t.name === 'request_worker_stop')!

    const result = await stopWorker.call({ worker_id: 'w-nope' }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('不存在或当前会话无权访问')
  })
})
