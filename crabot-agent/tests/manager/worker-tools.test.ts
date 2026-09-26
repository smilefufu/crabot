import { ManagerToolCatalog, createManagerToolFaceState, NORMAL_MANAGER_CORE_NAMES, DAILY_REFLECTION_CORE_NAMES } from '../../src/manager/tools/tool-catalog.js'
import { executeToolBatches } from '../../src/engine/tool-orchestration.js'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildWorkerTools, type WorkerToolsContext } from '../../src/manager/tools/worker-tools'
import { INPUT_DELIVERY_TIMEOUT_MS, WorkerHarness, type HarnessDeps, type SpawnWorkerParams } from '../../src/workers/harness/harness'
import { LedgerStore } from '../../src/workers/harness/ledger-store'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager'
import { NativeActivityStore } from '../../src/workers/harness/native-activity-store'
import type { ManagerKey } from '../../src/workers/harness/ledger-types'
import type { HarnessEvent } from '../../src/workers/harness/worker-events'
import { WorkerExitedError } from '../../src/workers/errors'
import { BUILTIN_WORKER_PERMISSIONS } from '../../src/workers/builtin/runtime'
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
  fakeOpts: FakeAdapterOpts = {},
  extraDeps: Partial<HarnessDeps> = {},
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
    ...extraDeps,
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
  it('普通 Manager 有十八项 worker 工具；状态、活动、Git 与回合查询均为只读', async () => {
    const { harness } = await makeHarness()
    const tools = buildWorkerTools({ harness, context: () => CTX })

    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'get_worker_activity',
        'get_worker_detail',
        'get_worker_state',
        'get_worker_subagent_detail',
        'get_worker_subagent_trace',
        'list_worker_subagents',
        'get_worker_turn',
        'inspect_workspace_git',
        'list_worker_implementations',
        'list_workers',
        'query_worker',
        'get_worker_terminal',
        'send_to_worker',
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
      'get_worker_subagent_detail',
      'get_worker_subagent_trace',
      'get_worker_terminal',
      'get_worker_turn',
      'inspect_workspace_git',
      'list_worker_implementations',
      'list_worker_subagents',
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
    expect(getWorkerActivity.description).toContain('脱敏 error evidence')
    expect(getWorkerActivity.inputSchema.properties?.view.description).toContain('错误证据')

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

  it('get_worker_turn 的首屏在 400 KB 工具历史后仍返回真实收尾正文，并在重读时保留', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    const incarnation = worker.incarnations[0]
    const activityStore = (harness as unknown as { nativeActivityStore: NativeActivityStore }).nativeActivityStore
    await activityStore.commitObservation({ worker_id: worker.worker_id,
      cursor: { incarnation_id: incarnation.incarnation_id, impl: incarnation.impl, seq: incarnation.seq, offset: 2 } })
    const conclusion = '真实收尾：结果为 42；没有遗失尾部结论。'
    harness.handleStateChange({ worker_id: worker.worker_id, incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq, impl: incarnation.impl, session_ref: incarnation.session_ref,
    }, 'idle', { completionSource: 'builtin_end_turn', summary: conclusion })
    await waitUntil(async () => (await harness.getWorkerTurn(worker.worker_id)) !== undefined)
    Object.assign(fake, { readTrace: async () => ({ events: [
      { ts: '2026-01-01T00:01:00Z', kind: 'tool_result', summary: '大型工具结果', detail: { output: '过程'.repeat(100_000) }, source_offset: 0 },
      { ts: '2026-01-01T00:01:01Z', kind: 'message', role: 'assistant', summary: conclusion, detail: { content: conclusion }, source_offset: 1 },
    ], nextCursor: { offset: 2 } }) })
    const tool = buildWorkerTools({ harness, context: () => CTX }).find((t) => t.name === 'get_worker_turn')!
    const first = await tool.call({ worker_id: worker.worker_id }, {})
    expect(first.isError).toBe(false)
    expect(Buffer.byteLength(first.output)).toBeLessThanOrEqual(64 * 1024)
    expect(parseOutput(first.output)).toMatchObject({ view: 'result', content_source: 'completion_summary', content: conclusion, next_cursor: null })
    const [engineResult] = await executeToolBatches([{ parallel: false, blocks: [{ type: 'tool_use', name: tool.name, id: 'turn-result', input: { worker_id: worker.worker_id } }] }], [tool])
    expect(JSON.parse(engineResult.content.slice(engineResult.content.indexOf('\n') + 1)).content).toBe(conclusion)
    Object.assign(fake, { readTrace: async () => { throw new Error('native source lost') } })
    const reread = await tool.call({ worker_id: worker.worker_id }, {})
    expect(parseOutput(reread.output).content).toBe(conclusion)
    await Promise.all([...(harness as any).stateChangeTails.values()])
  })

  it('正文证据读取失败仍保存完成回合，收尾 summary 在写盘前脱敏', async () => {
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    const incarnation = worker.incarnations[0]
    const handle = { worker_id: worker.worker_id, incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq, impl: incarnation.impl, session_ref: incarnation.session_ref }
    ;(harness as any).getWorkerTurnActivities = async () => { throw new Error('source failed') }
    harness.handleStateChange(handle, 'idle', { completionSource: 'builtin_end_turn' })
    await waitUntil(async () => (await harness.getWorkerTurn(worker.worker_id)) !== undefined)
    await Promise.all([...(harness as any).stateChangeTails.values()])
    expect((await harness.getWorkerTurn(worker.worker_id))?.completion_result).toMatchObject({ source: 'unavailable' })
    ;(harness as any).deps.redactFailureReason = (text: string) => text.replaceAll('SYNTHETIC_SECRET', '[REDACTED]')
    harness.handleStateChange(handle, 'running')
    await Promise.all([...(harness as any).stateChangeTails.values()])
    harness.handleStateChange(handle, 'idle', { completionSource: 'builtin_end_turn', summary: '结果 SYNTHETIC_SECRET' })
    await Promise.all([...(harness as any).stateChangeTails.values()])
    expect((await harness.getWorkerTurn(worker.worker_id))?.completion_result).toMatchObject({ content: '结果 [REDACTED]' })
  })

  it('分页固定原回合、重新授权，过程严格使用冻结范围，正文不随新回合切换', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    const incarnation = worker.incarnations[0]
    const store = (harness as any).turnStore
    const content = '完整结果😀\n'.repeat(20_000)
    const fields = { worker_id: worker.worker_id, manager_key: CTX.managerKey, incarnation_id: incarnation.incarnation_id,
      impl: incarnation.impl, seq: incarnation.seq, session_ref: incarnation.session_ref, activity_from: '1', activity_through: '3',
      completed_at: '2026-09-15T01:00:00Z', completion_source: 'builtin_end_turn' }
    const oldTurn = await store.create({ ...fields, completion_result: { source: 'assistant_text', content } })
    const tool = buildWorkerTools({ harness, context: () => CTX }).find((t) => t.name === 'get_worker_turn')!
    const first = parseOutput((await tool.call({ worker_id: worker.worker_id }, {})).output)
    await store.create({ ...fields, activity_from: '3', activity_through: '4', completion_result: { source: 'assistant_text', content: '下一回合' } })
    let combined = first.content as string
    let cursor = first.next_cursor as string | null
    while (cursor) {
      const page = parseOutput((await tool.call({ worker_id: worker.worker_id, cursor }, {})).output)
      expect(page.turn).toMatchObject({ turn_id: oldTurn.turn_id })
      combined += page.content
      cursor = page.next_cursor as string | null
    }
    expect(combined).toBe(content)
    const denied = buildWorkerTools({ harness, context: () => ({ ...CTX, managerKey: 'wechat::other' }) }).find((t) => t.name === tool.name)!
    expect((await denied.call({ worker_id: worker.worker_id, cursor: first.next_cursor }, {})).isError).toBe(true)
    Object.assign(fake, { readTrace: async () => ({ events: [0, 1, 2, 3].map((offset) => ({
      ts: '', kind: 'message', role: 'assistant', summary: `turn-${offset}`, source_offset: offset, detail: { content: `完整 ${offset}` },
    })), nextCursor: { offset: 4 } }) })
    const activity = parseOutput((await tool.call({ worker_id: worker.worker_id, turn_id: oldTurn.turn_id, view: 'activity' }, {})).output)
    expect((activity.content as string).trim().split('\n').map((line) => JSON.parse(line).source_offset)).toEqual([1, 2])
    // 旧记录没有 completion_result 时同样只从冻结范围取最后一条真实正文。
    const legacy = await store.create(fields)
    const legacyPage = parseOutput((await tool.call({ worker_id: worker.worker_id, turn_id: legacy.turn_id }, {})).output)
    expect(legacyPage).toMatchObject({ content_source: 'assistant_text', content: '完整 2' })
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
      content_source: 'preview',
      content: '已持久化的回合结果',
      unavailable_reason: expect.any(String),
    })
    expect(parseOutput(result.output).unavailable_reason).toContain('preview')
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
      content_source: 'unavailable', content: '', next_cursor: null,
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
  it('派发权限关闭时拒绝调用，不创建台账或启动执行器', async () => {
    const { harness, fake } = await makeHarness()
    const context: WorkerToolsContext = {
      ...CTX,
      principalPermissions: {
        ...BUILTIN_WORKER_PERMISSIONS,
        tool_access: { ...BUILTIN_WORKER_PERMISSIONS.tool_access, task: false, file_io: true, shell: true },
      },
    }
    const tool = buildWorkerTools({ harness, context: () => context }).find((t) => t.name === 'spawn_worker')!
    const result = await tool.call({ title: '整理目录', prompt: '移动文本文件', impl: 'builtin' }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('当前会话没有任务派发权限')
    expect(fake.spawnCalls).toHaveLength(0)
    expect(await harness.listWorkers(CTX.managerKey)).toHaveLength(0)
  })

  it('title schema 要求任务主题与具体执行内容，并禁止对话指代', async () => {
    const { harness } = await makeHarness()
    const spawnWorker = buildWorkerTools({ harness, context: () => CTX }).find((t) => t.name === 'spawn_worker')!
    const schema = spawnWorker.inputSchema as {
      properties?: { title?: { description?: string } }
    }

    expect(schema.properties?.title?.description).toContain('所属任务主题')
    expect(schema.properties?.title?.description).toContain('具体执行内容')
    expect(schema.properties?.title?.description).toContain('继续处理')
  })

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
    expect(Object.keys(parsed).sort()).toEqual(['impl', 'status', 'worker_id', 'workspace_git'])

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

  it('immediate_redirect 出现在 schema 且透传到 Harness', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    const sendToWorker = buildWorkerTools({ harness, context: () => CTX }).find((tool) => tool.name === 'send_to_worker')!
    const schema = sendToWorker.inputSchema as { properties?: Record<string, unknown> }

    expect(schema.properties?.immediate_redirect).toMatchObject({ type: 'boolean' })
    const result = await sendToWorker.call({ worker_id: worker.worker_id, text: '立即转向', immediate_redirect: true }, {})

    expect(result.isError).toBe(false)
    expect(fake.sendInputCalls[0].opts).toMatchObject({ immediate_redirect: true })
  })

  it('worker 不存在 → WorkerNotFoundError 转成可读 tool_result（isError:true，不抛出）', async () => {
    const { harness } = await makeHarness()
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const sendToWorker = tools.find((t) => t.name === 'send_to_worker')!

    const result = await sendToWorker.call({ worker_id: 'w-does-not-exist', text: '你好' }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('不存在或当前会话无权访问')
  })

  it('授权查询永久挂起时仍在同步 deadline 内返回简要失败', async () => {
    const { harness } = await makeHarness()
    const findWorker = vi.spyOn(harness, 'findWorker').mockImplementation(() => new Promise<never>(() => {}))
    const sendWorker = vi.spyOn(harness, 'sendToWorker')
    const sendToWorker = buildWorkerTools({ harness, context: () => CTX }).find((t) => t.name === 'send_to_worker')!

    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const resultPromise = sendToWorker.call({ worker_id: 'w-authorization-stall', text: '继续' }, {})
      await Promise.resolve()
      expect(findWorker).toHaveBeenCalledWith('w-authorization-stall')

      await vi.advanceTimersByTimeAsync(INPUT_DELIVERY_TIMEOUT_MS)
      const result = await resultPromise
      expect(result).toMatchObject({ isError: true })
      expect(result.output).toContain('input delivery setup exceeded the 120 second synchronous deadline')
      expect(sendWorker).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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
  it('等待 fork 建立后返回稳定化身 ID 并保留终端 seq，但不等待回答完成', async () => {
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
      fork_incarnation_id: expect.any(String),
      fork_seq: 2,
      query_id: expect.any(String),
    })
    const [w] = await harness.listWorkers(CTX.managerKey)
    expect(parseOutput(result.output).fork_incarnation_id).toBe(w.incarnations[1].incarnation_id)
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
      workers: [{ worker_id: active.worker_id }],
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
    expect(afterInterrupt.task.status).not.toBe('closed')

    const first = await stopWorker.call({ worker_id: worker.worker_id }, {})
    expect(first.isError).toBe(false)
    expect(parseOutput(first.output)).toMatchObject({ operation: { worker_id: worker.worker_id, kind: 'stop', status: 'succeeded' } })
    expect(fake.killCalls).toHaveLength(1)

    const [afterFirst] = await harness.listWorkers(CTX.managerKey)
    expect(afterFirst.task.status).toBe('closed')

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


describe('主控整体执行观察', () => {
  it('父级 idle 不掩盖运行中的 child；查询与事件同源且不发送输入', async () => {
    const { harness, fake } = await makeHarness({}, {
      listWorkerBackground: async () => [],
      hasPendingWorkerNotification: async () => false,
      hasRunningBg: async () => true,
    })
    const worker = await harness.spawnWorker(directSpawnParams())
    Object.assign(fake, { listSubagents: async () => [{ subagent_id: 'agent_a', worker_id: worker.worker_id,
      executor_impl: 'builtin', name: 'research', task: '查证', status: 'running' }] })
    const tools = buildWorkerTools({ harness, context: () => CTX })
    harness.handleStateChange({ worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: 'test' }, 'idle')
    await waitUntil(async () => Boolean((await harness.findWorker(worker.worker_id))?.worker.incarnations[0].state === 'idle'))
    const result = await tools.find(t => t.name === 'get_worker_state')!.call({ worker_id: worker.worker_id }, {})
    const state = parseOutput(result.output)
    expect(state).toMatchObject({ mainline: { state: 'idle' }, execution: {
      state: 'running', reasons: ['subagent_running'], active_subagents: [{ subagent_id: 'agent_a' }], notification_pending: false,
    } })
    expect(state).toHaveProperty('task.status', 'running')
    expect(fake.sendInputCalls).toHaveLength(0)
    await waitUntil(async () => events.some(e => e.kind === 'state_changed'))
    const notice = [...events].reverse().find(e => e.kind === 'state_changed')
    expect(notice?.detail).toHaveProperty('execution.state', 'running')
  })

  it('多化身共享 Worker 级 builtin child 列表，保留活动 child，过滤终态并脱敏', async () => {
    const { harness, fake } = await makeHarness({}, {
      listWorkerBackground: async () => [{ entity_id: 'agent_live', status: 'running', ended_at: null }, { entity_id: 'shell_live', status: 'stalled', ended_at: null }],
      hasPendingWorkerNotification: async () => false,
      redactFailureReason: text => text.replaceAll('secret', '[redacted]'),
    })
    const worker = await harness.spawnWorker(directSpawnParams())
    const ledger = new LedgerStore(join(dataDir, 'ledgers'))
    const mainline = worker.incarnations[0]
    await ledger.upsertWorker(CTX.managerKey, worker.worker_id, current => ({ ...current!, incarnations: [
      { ...mainline, state: 'idle' },
      { ...mainline, incarnation_id: 'inc-fork', seq: 2, forked_from: 1, state: 'running' },
    ] }))
    const listSubagents = vi.fn(async () => [
      { subagent_id: 'agent_done', worker_id: worker.worker_id, executor_impl: 'builtin', name: 'done', status: 'completed' },
      { subagent_id: 'agent_live', worker_id: worker.worker_id, executor_impl: 'builtin', name: 'secret', task: 'secret task', status: 'running' },
      { subagent_id: 'agent_unknown', worker_id: worker.worker_id, executor_impl: 'builtin', name: 'unknown', status: 'unknown' },
    ])
    Object.assign(fake, { listSubagents })
    const observation = await harness.getWorkerExecutionObservation(worker.worker_id)
    expect(observation).toMatchObject({ state: 'running', active_subagents: [
      { subagent_id: 'agent_live', name: '[redacted]', task: '[redacted] task' }, { subagent_id: 'agent_unknown', status: 'unknown' },
    ], active_background: [{ entity_id: 'shell_live', status: 'stalled' }], unavailable_reasons: ['subagent_state_unknown'] })
    expect(observation.reasons).toEqual(expect.arrayContaining(['fork_running', 'subagent_running', 'background_running']))
    expect(listSubagents).toHaveBeenCalledTimes(1)
    expect(fake.sendInputCalls).toHaveLength(0)
  })

  it.each(['codex', 'claude-code'] as const)('自动快照不调用 %s 的慢 child 查询，回合事件仍正常投递', async (impl) => {
    const { harness, fake } = await makeHarness({ implId: impl, caps: { subagent: true } }, {
      listWorkerBackground: async () => [],
      hasPendingWorkerNotification: async () => false,
      onOperationNotification: async (_key, event) => { events.push(event) },
    })
    const worker = await harness.spawnWorker(directSpawnParams({ impl }))
    const listSubagents = vi.fn(() => new Promise<never>(() => {}))
    Object.assign(fake, { listSubagents })
    harness.handleStateChange({ worker_id: worker.worker_id, seq: 1, impl, session_ref: `ref-${worker.worker_id}#1` }, 'idle', {
      completionSource: impl === 'codex' ? 'codex_turn_complete' : 'claude_stop', lastText: 'done',
    })
    await waitUntil(async () => events.some(e => e.kind === 'turn_completed'))
    expect(listSubagents).not.toHaveBeenCalled()
    expect(events.find(e => e.kind === 'turn_completed')?.detail).toMatchObject({ execution: {
      state: 'unknown', active_subagents: [], unavailable_reasons: ['subagents_require_explicit_read'],
    } })
    expect(await harness.getWorkerExecutionObservation(worker.worker_id)).toMatchObject({ state: 'unknown' })
    expect(listSubagents).not.toHaveBeenCalled()
    expect(fake.sendInputCalls).toHaveLength(0)
  })

  it('持久 pending 通知在内存交付计数为零时仍保持运行；失败降级不泄漏错误', async () => {
    let pending = true
    const { harness, fake } = await makeHarness({}, {
      listWorkerBackground: async () => [],
      hasPendingWorkerNotification: async () => pending,
    })
    const worker = await harness.spawnWorker(directSpawnParams())
    Object.assign(fake, { listSubagents: async () => [] })
    await harness.handleStateChange({ worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: 'test' }, 'idle')
    await waitUntil(async () => (await harness.findWorker(worker.worker_id))?.worker.incarnations[0].state === 'idle')
    expect(harness.hasPendingBgNotification(worker.worker_id)).toBe(false)
    expect(await harness.getWorkerExecutionObservation(worker.worker_id)).toMatchObject({ state: 'running', notification_pending: true })
    pending = false
    expect(await harness.getWorkerExecutionObservation(worker.worker_id)).toMatchObject({ state: 'idle', notification_pending: false })
    Object.assign(fake, { listSubagents: async () => { throw new Error('secret token') } })
    const unknown = await harness.getWorkerExecutionObservation(worker.worker_id)
    expect(unknown.state).toBe('unknown')
    expect(unknown.unavailable_reasons.length).toBeGreaterThan(0)
    expect(JSON.stringify(unknown)).not.toContain('secret token')
    expect(fake.sendInputCalls).toHaveLength(0)
  })
})


describe('Manager direct child tools', () => {
  it('loaded on demand through worker family, excluded from daily reflection, and enforces worker/child ownership before trace access', async () => {
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    const child = { worker_id: worker.worker_id, subagent_id: 'agent_1', executor_impl: 'builtin' as const, name: 'research', status: 'running' as const }
    const readWorkerSubagents = vi.fn(async () => ({ subagents: [child] }))
    const readWorkerSubagentDetail = vi.fn(async () => ({ subagent: child }))
    const readWorkerSubagentTrace = vi.fn(async () => ({ events: [], next_cursor: 'opaque-next' }))
    const readers = { readWorkerSubagents, readWorkerSubagentDetail, readWorkerSubagentTrace }
    const tools = buildWorkerTools({ harness, context: () => CTX, ...readers })
    const names = ['list_worker_subagents', 'get_worker_subagent_detail', 'get_worker_subagent_trace']
    const allTools = [...tools, ...[...new Set([...NORMAL_MANAGER_CORE_NAMES, ...DAILY_REFLECTION_CORE_NAMES])].filter(name => !tools.some(t => t.name === name)).map(name => ({ name, description: name, inputSchema: { type: 'object' as const }, call: async () => ({ output: '', isError: false }) }))]
    const catalog = new ManagerToolCatalog(allTools, 'normal', {}, undefined, undefined, { worker: names })
    const state = createManagerToolFaceState()
    for (const name of names) expect(catalog.project(state, allTools.find(t => t.name === 'search_tools')).map(t => t.name)).not.toContain(name)
    expect(catalog.loadFamily(state, 'worker').loaded).toEqual(names)
    for (const name of names) {
      expect(catalog.project(state, allTools.find(t => t.name === 'search_tools')).map(t => t.name)).toContain(name)
      const restricted = new ManagerToolCatalog(allTools, 'daily_reflection', {}, undefined, undefined, { worker: names })
      expect(restricted.loadFamily(createManagerToolFaceState(), 'worker').loaded).not.toContain(name)
    }
    const trace = tools.find(t => t.name === names[2])!
    expect((await trace.call({ worker_id: worker.worker_id, subagent_id: 'agent_1', cursor: 'opaque-page' }, {})).isError).toBe(false)
    expect(readWorkerSubagentTrace).toHaveBeenLastCalledWith({ worker_id: worker.worker_id, subagent_id: 'agent_1', cursor: 'opaque-page' })
    readWorkerSubagentTrace.mockClear()
    expect((await trace.call({ worker_id: worker.worker_id, subagent_id: 'other-child' }, {})).isError).toBe(true)
    expect(readWorkerSubagentTrace).not.toHaveBeenCalled()
    readWorkerSubagentDetail.mockClear()
    const foreign = buildWorkerTools({ harness, context: () => ({ ...CTX, managerKey: 'wechat::other' }), ...readers })
    for (const name of names) {
      expect((await foreign.find(t => t.name === name)!.call({ worker_id: worker.worker_id, ...(name === names[0] ? {} : { subagent_id: 'agent_1' }) }, {})).isError).toBe(true)
    }
    expect(readWorkerSubagentDetail).not.toHaveBeenCalled()
    expect(readWorkerSubagents).not.toHaveBeenCalled()
    readWorkerSubagents.mockResolvedValueOnce({ subagents: [{ ...child, worker_id: 'other-worker' }] })
    expect((await tools.find(t => t.name === names[0])!.call({ worker_id: worker.worker_id }, {})).isError).toBe(true)
  })

  it('failed observation sources retain positive activity and never prevent turn delivery', async () => {
    let active = true
    const { harness, fake } = await makeHarness({}, {
      onOperationNotification: async (_key, event) => { events.push(event) },
      isExecutionReady: () => false,
      listWorkerBackground: async () => { throw new Error('secret registry failure') },
      hasPendingWorkerNotification: async () => { throw new Error('secret receipt failure') },
      hasRunningBg: async () => active,
    })
    const worker = await harness.spawnWorker(directSpawnParams())
    Object.assign(fake, { listSubagents: async () => active ? ['agent_a', 'agent_b'].map(subagent_id => ({
      subagent_id, worker_id: worker.worker_id, executor_impl: 'builtin', name: subagent_id, status: 'running',
    })) : [] })
    harness.handleStateChange({ worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: 'test' }, 'idle', { completionSource: 'builtin_end_turn', lastText: 'child dispatched' })
    await waitUntil(async () => events.some(e => e.kind === 'turn_completed'))
    const turns = events.filter(e => e.kind === 'turn_completed')
    expect(turns).toHaveLength(1)
    expect(turns[0].detail).toMatchObject({ execution: { state: 'running', notification_pending: null,
      active_subagents: [{ subagent_id: 'agent_a' }, { subagent_id: 'agent_b' }],
      unavailable_reasons: ['startup_reconciliation_pending', 'background_unavailable', 'notification_state_unavailable'],
    } })
    active = false
    expect(await harness.getWorkerExecutionObservation(worker.worker_id)).toMatchObject({ state: 'unknown', active_subagents: [] })
    expect(fake.sendInputCalls).toHaveLength(0)
    expect(events.filter(e => e.kind === 'turn_completed')).toHaveLength(1)
    expect(JSON.stringify(turns)).not.toContain('secret')
  })
})
