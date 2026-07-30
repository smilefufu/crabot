import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildWorkerTools, type WorkerToolsContext } from '../../src/manager/tools/worker-tools'
import { WorkerHarness, type HarnessDeps, type SpawnWorkerParams } from '../../src/workers/harness/harness'
import { LedgerStore } from '../../src/workers/harness/ledger-store'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager'
import { dialogObjectIdForPrivate } from '../../src/workers/harness/ledger-types'
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
  OutputCursor,
  CapabilityBundle,
  AdapterCapabilities,
  DetectResult,
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
  readonly sendInputBehavior?: (h: IncarnationHandle, text: string, opts?: { raw?: boolean }) => void
  readonly outputChunk?: string
}

class FakeAdapter implements WorkerAdapter {
  readonly implId: WorkerImplId
  readonly spawnCalls: SpawnSpec[] = []
  readonly sendInputCalls: Array<{ h: IncarnationHandle; text: string; opts?: { raw?: boolean } }> = []
  readonly killCalls: IncarnationHandle[] = []
  readonly readOutputCalls: Array<{ h: IncarnationHandle; cursor: OutputCursor }> = []
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

  async fork(prev: IncarnationRef, _forkInput: string): Promise<IncarnationHandle> {
    const seq = this.nextForkSeq++
    const handle: IncarnationHandle = { worker_id: prev.worker_id, seq, impl: this.implId, session_ref: `fork-ref-${prev.worker_id}#${seq}` }
    this.states.set(handleKey(handle), 'running')
    return handle
  }

  async sendInput(h: IncarnationHandle, text: string, opts?: { raw?: boolean }): Promise<void> {
    this.sendInputCalls.push({ h, text, opts })
    if (this.opts.sendInputBehavior) this.opts.sendInputBehavior(h, text, opts)
  }

  async readOutput(h: IncarnationHandle, cursor: OutputCursor): Promise<{ chunk: string; nextCursor: OutputCursor }> {
    this.readOutputCalls.push({ h, cursor })
    const chunk = this.opts.outputChunk ?? ''
    return { chunk, nextCursor: { offset: cursor.offset + chunk.length } }
  }

  async state(h: IncarnationHandle): Promise<WorkerContractState> {
    return this.states.get(handleKey(h)) ?? 'exited'
  }

  async kill(h: IncarnationHandle): Promise<void> {
    this.killCalls.push(h)
    this.states.set(handleKey(h), 'exited')
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
  dialogObjectId: dialogObjectIdForPrivate('friend-1'),
  managerKey: 'wechat::sess-1',
  episodeId: 'episode-42',
  creatorFriendId: 'friend-1',
  reportTo: { channel_id: 'wechat', session_id: 'sess-1' },
}

function directSpawnParams(overrides: Partial<SpawnWorkerParams> = {}): SpawnWorkerParams {
  return {
    dialogObjectId: CTX.dialogObjectId,
    title: '直接调 harness 预置的任务',
    prompt: '把活干完',
    origin: { spawned_by_session: CTX.managerKey, trigger_type: 'message' },
    report_to: CTX.reportTo,
    ...overrides,
  }
}

function parseOutput(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>
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
  it('工具名集合恰为六项，isReadOnly 仅 read_worker_output/list_workers 为 true', async () => {
    const { harness } = await makeHarness()
    const tools = buildWorkerTools({ harness, context: () => CTX })

    expect(tools.map((t) => t.name).sort()).toEqual(
      ['kill_worker', 'list_workers', 'query_worker', 'read_worker_output', 'send_to_worker', 'spawn_worker'].sort()
    )

    const readOnlyNames = tools.filter((t) => t.isReadOnly).map((t) => t.name).sort()
    expect(readOnlyNames).toEqual(['list_workers', 'read_worker_output'])
  })
})

// ---- spawn_worker ----

describe('spawn_worker', () => {
  it('透传 dialogObjectId/origin/report_to 到台账，异步返回简短确认（非完整 worker 记录）', async () => {
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

    // 真正落盘的台账记录：origin/report_to/dialogObjectId 与 context() 提供的完全一致。
    const listed = await harness.listWorkers(CTX.dialogObjectId)
    const worker = listed.find((w) => w.worker_id === parsed.worker_id)
    expect(worker).toBeDefined()
    expect(worker!.origin).toEqual({
      spawned_by_session: CTX.managerKey,
      spawned_by_episode: CTX.episodeId,
      creator_friend_id: CTX.creatorFriendId,
      trigger_type: 'message',
    })
    expect(worker!.report_to).toEqual(CTX.reportTo)
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
  it('异步返回简短确认，text/raw 原样透传给 adapter.sendInput', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const sendToWorker = tools.find((t) => t.name === 'send_to_worker')!

    const result = await sendToWorker.call({ worker_id: worker.worker_id, text: '继续', raw: true }, {})
    expect(result.isError).toBe(false)
    const parsed = parseOutput(result.output)
    expect(parsed).toEqual({ status: 'sent', worker_id: worker.worker_id })

    expect(fake.sendInputCalls).toHaveLength(1)
    expect(fake.sendInputCalls[0].text).toBe('继续')
    expect(fake.sendInputCalls[0].opts).toEqual({ raw: true })
  })

  it('worker 不存在 → WorkerNotFoundError 转成可读 tool_result（isError:true，不抛出）', async () => {
    const { harness } = await makeHarness()
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const sendToWorker = tools.find((t) => t.name === 'send_to_worker')!

    const result = await sendToWorker.call({ worker_id: 'w-does-not-exist', text: '你好' }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/worker not found/)
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

  it('自动 handoff 目标全部用过 → ImplAlreadyUsedError 转成可读 tool_result（isError:true，不抛出）', async () => {
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
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/already has an incarnation/)
  })
})

// ---- query_worker ----

describe('query_worker', () => {
  it('fork 能力开启时异步返回简短确认（status + fork_seq）', async () => {
    const { harness } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(directSpawnParams())
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const queryWorker = tools.find((t) => t.name === 'query_worker')!

    const result = await queryWorker.call({ worker_id: worker.worker_id, question: '现在进展如何？' }, {})
    expect(result.isError).toBe(false)
    const parsed = parseOutput(result.output)
    expect(parsed).toEqual({ status: 'queried', worker_id: worker.worker_id, fork_seq: 2 })
  })

  it('worker 不存在 → WorkerNotFoundError 转成可读 tool_result', async () => {
    const { harness } = await makeHarness({ caps: { fork: true } })
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const queryWorker = tools.find((t) => t.name === 'query_worker')!

    const result = await queryWorker.call({ worker_id: 'w-nope', question: '？' }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/worker not found/)
  })

  it('目标实现不支持 fork → CapabilityNotSupportedError 同样转成可读 tool_result（覆盖"其它异常"）', async () => {
    const { harness } = await makeHarness({ caps: { fork: false } })
    const worker = await harness.spawnWorker(directSpawnParams())
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const queryWorker = tools.find((t) => t.name === 'query_worker')!

    const result = await queryWorker.call({ worker_id: worker.worker_id, question: '？' }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/fork/)
  })
})

// ---- read_worker_output（同步，真实数据） ----

describe('read_worker_output', () => {
  it('同步返回真实 chunk 与 next_offset', async () => {
    const { harness } = await makeHarness({ outputChunk: '这是输出内容' })
    const worker = await harness.spawnWorker(directSpawnParams())
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const readWorkerOutput = tools.find((t) => t.name === 'read_worker_output')!

    const result = await readWorkerOutput.call({ worker_id: worker.worker_id }, {})
    expect(result.isError).toBe(false)
    const parsed = parseOutput(result.output)
    expect(parsed.chunk).toBe('这是输出内容')
    expect(parsed.next_offset).toBe('这是输出内容'.length)
  })

  it('worker 不存在 → WorkerNotFoundError 转成可读 tool_result', async () => {
    const { harness } = await makeHarness()
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const readWorkerOutput = tools.find((t) => t.name === 'read_worker_output')!

    const result = await readWorkerOutput.call({ worker_id: 'w-nope' }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/worker not found/)
  })
})

// ---- list_workers（同步，本对话对象全量） ----

describe('list_workers', () => {
  it('同步返回 context().dialogObjectId 名下全部 worker', async () => {
    const { harness } = await makeHarness()
    const w1 = await harness.spawnWorker(directSpawnParams({ title: '任务一' }))
    const w2 = await harness.spawnWorker(directSpawnParams({ title: '任务二' }))
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const listWorkers = tools.find((t) => t.name === 'list_workers')!

    const result = await listWorkers.call({}, {})
    expect(result.isError).toBe(false)
    const parsed = parseOutput(result.output) as { workers: Array<{ worker_id: string }> }
    expect(parsed.workers.map((w) => w.worker_id).sort()).toEqual([w1.worker_id, w2.worker_id].sort())
  })
})

// ---- kill_worker（同步，幂等） ----

describe('kill_worker', () => {
  it('终止主线化身，task 转 cancelled，重复调用幂等', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(directSpawnParams())
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const killWorker = tools.find((t) => t.name === 'kill_worker')!

    const first = await killWorker.call({ worker_id: worker.worker_id, reason: '不需要了' }, {})
    expect(first.isError).toBe(false)
    expect(parseOutput(first.output)).toEqual({ status: 'killed', worker_id: worker.worker_id })
    expect(fake.killCalls).toHaveLength(1)

    const [afterFirst] = await harness.listWorkers(CTX.dialogObjectId)
    expect(afterFirst.task.status).toBe('cancelled')

    // 幂等：再调一次不重复 adapter.kill、不报错。
    const second = await killWorker.call({ worker_id: worker.worker_id }, {})
    expect(second.isError).toBe(false)
    expect(fake.killCalls).toHaveLength(1)
  })

  it('worker 不存在 → WorkerNotFoundError 转成可读 tool_result', async () => {
    const { harness } = await makeHarness()
    const tools = buildWorkerTools({ harness, context: () => CTX })
    const killWorker = tools.find((t) => t.name === 'kill_worker')!

    const result = await killWorker.call({ worker_id: 'w-nope' }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/worker not found/)
  })
})
