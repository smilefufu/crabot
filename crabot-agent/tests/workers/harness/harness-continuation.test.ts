import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  WorkerHarness,
  WorkerNotFoundError,
  TaskCancelledError,
  ImplAlreadyUsedError,
  type HarnessDeps,
  type SpawnWorkerParams,
} from '../../../src/workers/harness/harness'
import { LedgerStore } from '../../../src/workers/harness/ledger-store'
import { WorkspaceManager } from '../../../src/workers/harness/workspace-manager'
import { dialogObjectIdForPrivate } from '../../../src/workers/harness/ledger-types'
import type { HarnessEvent } from '../../../src/workers/harness/worker-events'
import { CliInputStallError, WorkerExitedError } from '../../../src/workers/errors'
import { BuiltinWorkerAdapter } from '../../../src/workers/builtin/adapter'
import type { BuiltinRuntimeContext } from '../../../src/workers/builtin/runtime'
import type { LLMAdapter } from '../../../src/engine/llm-adapter-types.js'
import { chunksFromContent } from '../../engine/helpers/mock-stream'
import type {
  WorkerAdapter,
  WorkerImplId,
  WorkerContractState,
  IncarnationHandle,
  IncarnationRef,
  IncarnationEndReason,
  StateChangeReport,
  SpawnSpec,
  Workspace,
  OutputCursor,
  CapabilityBundle,
  AdapterCapabilities,
  DetectResult,
} from '../../../src/workers/types'

// ---- FakeAdapter：与 Task 7 harness-lifecycle.test.ts 同款可编程桩，本文件独立一份
// （resume/kill/readOutput 需要按接续场景编程，不复用别的测试文件的实现）。----

function handleKey(h: IncarnationHandle): string {
  return `${h.worker_id}#${h.seq}`
}

interface FakeAdapterOpts {
  readonly implId?: WorkerImplId
  readonly caps?: Partial<AdapterCapabilities>
  readonly onStateChange?: (h: IncarnationHandle, state: WorkerContractState, report?: StateChangeReport) => void
  readonly sendInputBehavior?: (h: IncarnationHandle, text: string, opts?: { raw?: boolean }) => Promise<void> | void
  readonly resumeBehavior?: (prev: IncarnationRef, wakeInput: string) => Promise<IncarnationHandle> | IncarnationHandle
  readonly spawnBehavior?: (spec: SpawnSpec) => Promise<IncarnationHandle> | IncarnationHandle
  readonly outputChunk?: string
  readonly acceptedExitReport?: StateChangeReport
  readonly updatedSessionRef?: string
}

class FakeAdapter implements WorkerAdapter {
  readonly implId: WorkerImplId
  readonly provisionCalls: Array<{ ws: Workspace; caps: CapabilityBundle }> = []
  readonly spawnCalls: SpawnSpec[] = []
  readonly resumeCalls: Array<{ prev: IncarnationRef; wakeInput: string }> = []
  readonly sendInputCalls: Array<{ h: IncarnationHandle; text: string; opts?: { raw?: boolean } }> = []
  readonly killCalls: IncarnationHandle[] = []
  readonly readOutputCalls: IncarnationHandle[] = []
  private readonly states = new Map<string, WorkerContractState>()
  private acceptedExitReport?: StateChangeReport
  private updatedSessionRef?: string
  private nextSeq = 1

  constructor(private readonly opts: FakeAdapterOpts = {}) {
    this.implId = opts.implId ?? 'builtin'
  }

  async detect(): Promise<DetectResult> {
    return { installed: true, activated: true }
  }

  async provision(ws: Workspace, caps: CapabilityBundle): Promise<void> {
    this.provisionCalls.push({ ws, caps })
  }

  async spawn(spec: SpawnSpec): Promise<IncarnationHandle> {
    this.spawnCalls.push(spec)
    if (this.opts.spawnBehavior) {
      const handle = await this.opts.spawnBehavior(spec)
      this.states.set(handleKey(handle), 'running')
      return handle
    }
    const seq = this.nextSeq++
    const handle: IncarnationHandle = { worker_id: spec.worker_id, seq, impl: this.implId, session_ref: `ref-${spec.worker_id}#${seq}` }
    this.states.set(handleKey(handle), 'running')
    return handle
  }

  async resume(prev: IncarnationRef, wakeInput: string): Promise<IncarnationHandle> {
    this.resumeCalls.push({ prev, wakeInput })
    if (this.opts.resumeBehavior) {
      const handle = await this.opts.resumeBehavior(prev, wakeInput)
      this.states.set(handleKey(handle), 'running')
      return handle
    }
    const seq = Math.max(this.nextSeq, prev.seq + 1)
    this.nextSeq = seq + 1
    const handle: IncarnationHandle = { worker_id: prev.worker_id, seq, impl: this.implId, session_ref: `resumed-ref-${prev.worker_id}#${seq}` }
    this.states.set(handleKey(handle), 'running')
    return handle
  }

  async fork(_prev: IncarnationRef, _forkInput: string): Promise<IncarnationHandle> {
    throw new Error('FakeAdapter.fork: not exercised by Task 8 continuation tests')
  }

  async sendInput(h: IncarnationHandle, text: string, opts?: { raw?: boolean }): Promise<void> {
    this.sendInputCalls.push({ h, text, opts })
    if (this.opts.sendInputBehavior) await this.opts.sendInputBehavior(h, text, opts)
    if (this.opts.updatedSessionRef) this.updatedSessionRef = this.opts.updatedSessionRef
    if (this.opts.acceptedExitReport) this.acceptedExitReport = this.opts.acceptedExitReport
  }

  takeUpdatedSessionRef(): string | undefined {
    const value = this.updatedSessionRef
    this.updatedSessionRef = undefined
    return value
  }

  takeAcceptedInputExit(): StateChangeReport | undefined {
    const value = this.acceptedExitReport
    this.acceptedExitReport = undefined
    return value
  }

  async readOutput(h: IncarnationHandle, cursor: OutputCursor): Promise<{ chunk: string; nextCursor: OutputCursor }> {
    this.readOutputCalls.push(h)
    return { chunk: this.opts.outputChunk ?? '', nextCursor: cursor }
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

  /** 测试专用：模拟 adapter 自己触发一次状态回调（镜像真实 adapter 内部调用 deps.onStateChange）。
   *
   * `endReason` 对齐真实 adapter 的 `report.endReason`。三个真实 adapter 的 `transitionExited`
   * 形参本就是**必填**的 `ended_reason`，不存在"退出了却说不出原因"的情况——所以这个桩在
   * `state==='exited'` 时也必须给出一个具体值，缺省取 `'completed'`（化身自然结束、非 kill，
   * 即本文件绝大多数接续用例的剧本：worker 自己干完一轮退出，manager 再投递新消息触发接续）。
   * 需要复现 failed/crashed/killed 的用例显式传 endReason 形参。`report.lastText` 这个桩不模拟
   * （对齐 cc/codex：它们刻意不报）。 */
  emitStateChange(h: IncarnationHandle, state: WorkerContractState, endReason?: IncarnationEndReason): void {
    this.states.set(handleKey(h), state)
    this.opts.onStateChange?.(h, state, state === 'exited' ? { endReason: endReason ?? 'completed' } : undefined)
  }
}

// ---- 测试夹具（与 harness-lifecycle.test.ts 同款：FakeAdapter 桩场景）----

let dataDir: string
let nowValue: number
const events: HarnessEvent[] = []

function now(): string {
  nowValue += 1000
  return new Date(nowValue).toISOString()
}

async function makeHarness(): Promise<{
  harness: WorkerHarness
  ledger: LedgerStore
  adaptersMap: Map<WorkerImplId, WorkerAdapter>
  defaultImpl: WorkerImplId
}> {
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
    // 本文件里 FakeAdapter 缺省 implId 就是 'builtin'（多数测试拿它当泛化的"随便一个实现"
    // 桩用，不关心真实 LLM 注入）；handoffIncarnation 的 pre-flight（裁决 B 修复）对目标
    // impl==='builtin' 硬性要求 HarnessDeps.builtinSpawnDefaults，这里给个无害的桩值，
    // 让不专门测这条 pre-flight 的既有用例不受影响。专门测 pre-flight 行为的用例会自建
    // 不含这个字段的 deps（见下面两个 describe 块）。
    builtinSpawnDefaults: () => ({ adapter: {} as LLMAdapter, model: 'test-model', systemPrompt: '', tools: [] }),
  }
  const harness = new WorkerHarness(deps)
  return { harness, ledger, adaptersMap, defaultImpl: 'builtin' }
}

function spawnParams(overrides: Partial<SpawnWorkerParams> = {}): SpawnWorkerParams {
  return {
    dialogObjectId: dialogObjectIdForPrivate('friend-1'),
    title: '测试任务',
    goal: '把活干完',
    prompt: '把活干完',
    origin: { spawned_by_session: 'wechat::sess-1', trigger_type: 'message' },
    report_to: { channel_id: 'wechat', session_id: 'sess-1' },
    ...overrides,
  }
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(join(tmpdir(), 'harness-continuation-test-'))
  nowValue = Date.parse('2026-01-01T00:00:00.000Z')
  events.length = 0
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

async function waitUntil(cond: () => Promise<boolean>, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitUntil timed out')
}

describe('WorkerHarness — 透明接续：revive (capabilities().revive === true)', () => {
  it('台账主线化身已 exited → adapter.resume 被调用（prevRef 用主线化身的 handle）→ 新化身入主线链 → sendToWorker 无感返回 → 事件 resumed', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter({ caps: { revive: true }, onStateChange: harness.handleStateChange })
    adaptersMap.set('builtin', fake)

    const worker = await harness.spawnWorker(spawnParams())
    const mainlineHandle: IncarnationHandle = { worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` }

    // 化身自然结束（非 kill）→ processStateChange 把台账主线化身落 exited(completed)。
    fake.emitStateChange(mainlineHandle, 'exited')
    await waitUntil(async () => {
      const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      return w.incarnations[0].state === 'exited'
    })
    events.length = 0
    fake.sendInputCalls.length = 0

    // sendToWorker 命中终态化身：deliver() 在调用 adapter.sendInput 之前就发现台账已
    // exited，直接走透明接续，resume 被调用、adapter.sendInput 完全不会被触碰。
    await expect(harness.sendToWorker(worker.worker_id, '还有件事要办')).resolves.toBeUndefined()

    expect(fake.sendInputCalls).toHaveLength(0)
    expect(fake.resumeCalls).toHaveLength(1)
    expect(fake.resumeCalls[0].prev).toEqual({ worker_id: worker.worker_id, seq: 1, session_ref: mainlineHandle.session_ref })
    expect(fake.resumeCalls[0].wakeInput).toBe('还有件事要办')

    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.incarnations).toHaveLength(2)
    expect(w.incarnations[1].forked_from).toBeUndefined() // 入主线链，不是侧问分支
    expect(w.incarnations[1].state).toBe('running')
    expect(w.incarnations[1].impl).toBe('builtin')
    expect(w.task.status).toBe('running') // 终态化身之上接续，task 重新回到 running

    const resumedEvents = events.filter((e) => e.kind === 'resumed')
    expect(resumedEvents).toHaveLength(1)
    expect(resumedEvents[0].seq).toBe(w.incarnations[1].seq)
  })

  it('resume首投accepted后同步completed：新化身与task按endReason落completed', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter({
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      resumeBehavior: (prev) => ({
        worker_id: prev.worker_id,
        seq: 2,
        impl: 'builtin',
        session_ref: `resumed-${prev.worker_id}`,
        initial_input: {
          control_state: 'exited',
          disposition: 'accepted',
          report: { endReason: 'completed' },
        },
      }),
    })
    adaptersMap.set('builtin', fake)
    const worker = await harness.spawnWorker(spawnParams())
    const h: IncarnationHandle = { worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` }
    fake.emitStateChange(h, 'exited')
    await waitUntil(async () => (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0].task.status === 'completed')

    await harness.sendToWorker(worker.worker_id, 'continue')
    const [settled] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(settled.task.status).toBe('completed')
    expect(settled.incarnations[1]).toMatchObject({ state: 'exited', ended_reason: 'completed' })
  })

  it('adapter.sendInput 抛 WorkerExitedError（台账还没追上）→ 同样透明接续，事件 resumed', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter({
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: (h) => {
        throw new WorkerExitedError(h.worker_id, h.seq)
      },
    })
    adaptersMap.set('builtin', fake)

    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await expect(harness.sendToWorker(worker.worker_id, '继续')).resolves.toBeUndefined()

    expect(fake.sendInputCalls).toHaveLength(1) // 确实尝试过一次正常投递，才捕获到 WorkerExitedError
    expect(fake.resumeCalls).toHaveLength(1)
    const resumedEvents = events.filter((e) => e.kind === 'resumed')
    expect(resumedEvents).toHaveLength(1)
  })

  it('adapter.sendInput 抛 WorkerExitedError 时台账主线化身仍是 running（迟到状态回调没追上）→ revive 前先把旧化身回填终态，不再永久卡在 running（评审 PoC 实证的修复）', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter({
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: (h) => {
        throw new WorkerExitedError(h.worker_id, h.seq)
      },
    })
    adaptersMap.set('builtin', fake)

    const worker = await harness.spawnWorker(spawnParams())
    // 没有触发过任何 fake.emitStateChange —— 台账里 incarnations[0].state 此刻仍是
    // 'running'（spawnWorker 落定后就是 running），模拟"adapter 内部已经退出，但迟到的
    // 状态回调还没追上"的竞态：这正是评审 PoC 复现的场景。
    const before = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    expect(before.incarnations[0].state).toBe('running')
    expect(before.incarnations[0].ended_at).toBeUndefined()
    events.length = 0

    await expect(harness.sendToWorker(worker.worker_id, '继续')).resolves.toBeUndefined()

    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.incarnations).toHaveLength(2)
    // 修复点：旧化身（seq=1）不再永久卡在 running —— revive 之前已经被回填了终态。
    const oldEntry = w.incarnations[0]
    expect(oldEntry.state).toBe('exited')
    expect(oldEntry.ended_at).toBeTruthy()
    // 这里的 'completed' 是**兜底缺省**：本用例的桩抛的 WorkerExitedError 不带 ended_reason，
    // 对应真实场景是"重启后 adapter 常驻 runtime 表为空、连落盘 meta 都读不回来"，此时
    // adapter 确实无原因可给。带得出原因的场景见下一条用例。
    expect(oldEntry.ended_reason).toBe('completed')

    // 之后即便迟到的状态回调才追上来，也不应该覆盖已经回填的终态记录 —— 此时台账主线
    // 已经换成 revive 产出的新化身（mainline.seq 已前进），processStateChange 的既有短路
    // 规则（mainline.seq !== h.seq）会把这条迟到回调当成"非当前主线化身的迟到回调"忽略，
    // 但这不是本测试要验证的点：本测试要证明的是旧化身在 revive 时已经同步回填，不依赖
    // 这条本就可能永远不会到达的迟到回调。
    const staleHandle: IncarnationHandle = {
      worker_id: worker.worker_id,
      seq: 1,
      impl: 'builtin',
      session_ref: oldEntry.session_ref,
    }
    fake.emitStateChange(staleHandle, 'exited')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const [w2] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w2.incarnations[0].ended_reason).toBe('completed')
  })

  it('WorkerExitedError 带着 adapter 侧的 ended_reason=failed 时，revive 前的回填记 failed，不再记成 completed', async () => {
    // 上一条用例的兜底缺省（'completed'）曾经是**唯一**行为：WorkerExitedError 不携带原因，
    // reviveIncarnation 只能硬编码。真实场景里 adapter 是知道的——builtin 的 sendInput 在
    // `instance.state === 'exited'` 时手上就有 `instance.ended_reason`（finish_task 写进去
    // 的结构化真值），cc/codex 同理有 `runtime.ended_reason`。现在这个真值随错误上抛。
    const { harness, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter({
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: (h) => {
        throw new WorkerExitedError(h.worker_id, h.seq, 'failed')
      },
    })
    adaptersMap.set('builtin', fake)

    const worker = await harness.spawnWorker(spawnParams())
    // 同上一条：台账主线此刻仍是 running（迟到的状态回调没追上），所以 revive 的回填段
    // 会真正触发——这正是原来把失败记成成功的那一处。
    const before = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    expect(before.incarnations[0].state).toBe('running')

    await expect(harness.sendToWorker(worker.worker_id, '继续')).resolves.toBeUndefined()

    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.incarnations).toHaveLength(2)
    expect(w.incarnations[0].state).toBe('exited')
    expect(w.incarnations[0].ended_reason).toBe('failed')
    // 接续本身照常发生：回填的是"上一棒怎么结束的"，不是"这次接续要不要做"。
    expect(fake.resumeCalls).toHaveLength(1)
    expect(w.incarnations[1].state).toBe('running')
  })

  it('台账已经记着 failed 的化身触发 revive → 回填段不动它，终态记录不被 completed 覆盖', async () => {
    // 另一条到达 revive 的路径：状态回调已经追上（台账里就是 exited/failed），此时
    // reviveIncarnation 的回填段按既有规则整段跳过。钉住"接续不会把已确证的失败洗成成功"。
    const { harness, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter({ caps: { revive: true }, onStateChange: harness.handleStateChange })
    adaptersMap.set('builtin', fake)

    const worker = await harness.spawnWorker(spawnParams())
    const h: IncarnationHandle = { worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` }
    fake.emitStateChange(h, 'exited', 'failed')
    await waitUntil(async () => {
      const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      return w.task.status === 'failed'
    })

    await expect(harness.sendToWorker(worker.worker_id, '再试一次')).resolves.toBeUndefined()

    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.incarnations).toHaveLength(2)
    expect(w.incarnations[0].ended_reason).toBe('failed') // 没被洗成 completed
    expect(fake.resumeCalls).toHaveLength(1)
  })
})

describe('WorkerHarness — 透明接续：handoff (capabilities().revive === false)', () => {
  it('HANDOFF.md 含标题/输出尾/上次 outcome，新化身 prompt 含交接引用与本次输入，旧化身标 superseded，事件 handoff_started', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter({
      caps: { revive: false },
      onStateChange: harness.handleStateChange,
      outputChunk: '这是执行到一半的输出\n还差一步',
      sendInputBehavior: (h) => {
        throw new WorkerExitedError(h.worker_id, h.seq)
      },
    })
    adaptersMap.set('builtin', fake)
    // 三轮 review 修复后，revive:false 的自动 handoff 不再"原 impl 沿用"（mainline.impl 在
    // worker.incarnations 里必然已经用过，沿用会被 ImplAlreadyUsedError pre-flight 拒绝），
    // 而是改选一个该 worker 尚未用过的实现（pickUnusedImpl）——必须再注册一个未用过的
    // adapter，否则 handoff 会因为"全都用过"而抛 ImplAlreadyUsedError，无法测到 handoff 本体
    // 逻辑（HANDOFF.md 内容/superseded/spawned 事件）。
    const target = new FakeAdapter({ implId: 'claude-code', onStateChange: harness.handleStateChange })
    adaptersMap.set('claude-code', target)

    const worker = await harness.spawnWorker(spawnParams())
    const workspaceRoot = worker.incarnations[0].workspace
    events.length = 0

    await expect(harness.sendToWorker(worker.worker_id, '接着把剩下的做完')).resolves.toBeUndefined()

    // resume 完全没被调用（revive:false 分支）；handoff 走的是 spawn，且目标是未用过的
    // 'claude-code'（不是原 impl 'builtin'）。
    expect(fake.resumeCalls).toHaveLength(0)
    expect(target.resumeCalls).toHaveLength(0)
    expect(target.spawnCalls).toHaveLength(1)
    const handoffSpawn = target.spawnCalls[0]
    expect(handoffSpawn.prompt).toContain('HANDOFF.md')
    expect(handoffSpawn.prompt).toContain('接着把剩下的做完')

    // HANDOFF.md 写入 workspace，含标题、输出尾、上次 outcome 标签。
    const handoffPath = join(workspaceRoot, 'HANDOFF.md')
    const handoffContent = await fs.readFile(handoffPath, 'utf-8')
    expect(handoffContent).toContain('测试任务') // task.title
    expect(handoffContent).toContain('这是执行到一半的输出') // 输出尾
    expect(handoffContent).toMatch(/Previous outcome:/)

    // 旧化身（seq=1，impl='builtin'）标 superseded：源化身在台账里还非终态时，先 kill 再落
    // exited(superseded)。
    expect(fake.killCalls).toHaveLength(1)
    expect(fake.killCalls[0].seq).toBe(1)
    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    const oldEntry = w.incarnations.find((i) => i.seq === 1)!
    expect(oldEntry.state).toBe('exited')
    expect(oldEntry.ended_reason).toBe('superseded')

    // 新化身入主线链，impl 是改选出来的 'claude-code'。
    const newEntry = w.incarnations[w.incarnations.length - 1]
    expect(newEntry.impl).toBe('claude-code')
    expect(newEntry.forked_from).toBeUndefined()
    expect(newEntry.state).toBe('running')
    expect(w.task.status).toBe('running')

    const handoffEvents = events.filter((e) => e.kind === 'handoff_started')
    expect(handoffEvents).toHaveLength(1)
    expect(handoffEvents[0].seq).toBe(1)
    const supersededEvents = events.filter((e) => e.kind === 'superseded')
    expect(supersededEvents).toHaveLength(1)
  })

  it('handoff目标首投accepted后同步completed：新化身与task按endReason落completed', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const source = new FakeAdapter({
      caps: { revive: false },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: (h) => { throw new WorkerExitedError(h.worker_id, h.seq) },
    })
    const target = new FakeAdapter({
      implId: 'claude-code',
      onStateChange: harness.handleStateChange,
      spawnBehavior: (spec) => ({
        worker_id: spec.worker_id,
        seq: 1,
        impl: 'claude-code',
        session_ref: `target-${spec.worker_id}`,
        initial_input: {
          control_state: 'exited',
          disposition: 'accepted',
          report: { endReason: 'completed' },
        },
      }),
    })
    adaptersMap.set('builtin', source)
    adaptersMap.set('claude-code', target)
    const worker = await harness.spawnWorker(spawnParams())

    await harness.sendToWorker(worker.worker_id, 'continue')
    const [settled] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(settled.task.status).toBe('completed')
    expect(settled.incarnations[settled.incarnations.length - 1]).toMatchObject({
      impl: 'claude-code',
      state: 'exited',
      ended_reason: 'completed',
    })
  })

  it('源化身台账已记 failed 时，HANDOFF.md 的 Previous outcome 写 failed —— 接手化身不会以为上一棒干成了', async () => {
    // 第四个消费方（台账 / task.status / 对外事件之外）：HANDOFF.md 的 `Previous outcome:` 取
    // `worker.task.outcome ?? source.ended_reason ?? 'unknown'`，而 task.outcome 在生产链路上
    // 恒 undefined，所以实际总是取 ended_reason。它被硬编码成 completed 时，跨实现交接的新
    // 化身会读到"上一化身 outcome: completed"，据此认为任务已经完成。
    const { harness, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter({
      caps: { revive: false },
      onStateChange: harness.handleStateChange,
      outputChunk: '跑到一半就失败了',
    })
    adaptersMap.set('builtin', fake)
    const target = new FakeAdapter({ implId: 'claude-code', onStateChange: harness.handleStateChange })
    adaptersMap.set('claude-code', target)

    const worker = await harness.spawnWorker(spawnParams())
    const workspaceRoot = worker.incarnations[0].workspace

    // 状态回调已经追上：台账里源化身就是 exited/failed（builtin 的 finish_task(outcome:'failed')）。
    const h: IncarnationHandle = { worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` }
    fake.emitStateChange(h, 'exited', 'failed')
    await waitUntil(async () => {
      const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      return w.task.status === 'failed'
    })

    await expect(harness.sendToWorker(worker.worker_id, '接着把剩下的做完')).resolves.toBeUndefined()

    const handoffContent = await fs.readFile(join(workspaceRoot, 'HANDOFF.md'), 'utf-8')
    expect(handoffContent).toContain('Previous outcome: failed')
    expect(handoffContent).not.toContain('Previous outcome: completed')
  })

  it('HANDOFF.md 已存在时追加带时间戳的新段，旧内容仍在（不覆盖）', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter({
      caps: { revive: false },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: (h) => {
        throw new WorkerExitedError(h.worker_id, h.seq)
      },
    })
    adaptersMap.set('builtin', fake)
    // 同上：需要一个未用过的目标 impl，否则 pickUnusedImpl 找不到可用目标，handoff 会被
    // ImplAlreadyUsedError pre-flight 拒绝。
    adaptersMap.set('claude-code', new FakeAdapter({ implId: 'claude-code', onStateChange: harness.handleStateChange }))

    const worker = await harness.spawnWorker(spawnParams())
    const workspaceRoot = worker.incarnations[0].workspace
    const handoffPath = join(workspaceRoot, 'HANDOFF.md')
    await fs.mkdir(workspaceRoot, { recursive: true })
    await fs.writeFile(handoffPath, '# 手工写入的既有交接记录\n旧内容不能丢\n', 'utf-8')

    await harness.sendToWorker(worker.worker_id, '第二次交接')

    const content = await fs.readFile(handoffPath, 'utf-8')
    expect(content).toContain('# 手工写入的既有交接记录')
    expect(content).toContain('旧内容不能丢')
    expect(content).toMatch(/## Handoff \d{4}-\d{2}-\d{2}T/) // 新段带时间戳标题
    expect(content).toContain('第二次交接')
  })
})

describe('WorkerHarness.switchWorkerImpl — 跨实现切换', () => {
  it('走同一条 handoff 路径，目标 adapter 由参数指定，源化身仍存活时先 kill 再标 superseded', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const source = new FakeAdapter({ implId: 'claude-code', caps: { revive: true }, onStateChange: harness.handleStateChange, outputChunk: '侧问一半的输出' })
    const target = new FakeAdapter({ implId: 'codex', caps: { revive: true }, onStateChange: harness.handleStateChange })
    adaptersMap.set('claude-code', source)
    adaptersMap.set('codex', target)

    const worker = await harness.spawnWorker(spawnParams({ impl: 'claude-code' }))
    events.length = 0

    await harness.switchWorkerImpl(worker.worker_id, 'codex', '手工切换到 codex')

    // 源化身仍是 running（没有触发过任何自然退出），走"仍非终态"分支：先 kill 再标 superseded。
    expect(source.killCalls).toHaveLength(1)
    expect(source.killCalls[0].seq).toBe(1)
    // 目标 adapter 正确：codex 的 spawn 被调用一次；claude-code 只有最初 spawnWorker
    // 那一次调用，没有因为这次切换被再 spawn 第二次。
    expect(target.spawnCalls).toHaveLength(1)
    expect(source.spawnCalls).toHaveLength(1)
    expect(target.spawnCalls[0].prompt).toContain('手工切换到 codex')

    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    const oldEntry = w.incarnations.find((i) => i.seq === 1)!
    expect(oldEntry.ended_reason).toBe('superseded')
    const newEntry = w.incarnations[w.incarnations.length - 1]
    expect(newEntry.impl).toBe('codex')
    expect(newEntry.forked_from).toBeUndefined()

    expect(events.filter((e) => e.kind === 'handoff_started')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'superseded')).toHaveLength(1)
  })

  it('replays and settles a consumed durable receipt on the target incarnation', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const source = new FakeAdapter({
      implId: 'claude-code',
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: async (_h, text, opts) => {
        if (!opts?.raw && text === 'bg') {
          throw new CliInputStallError('pending_in_ui', 'running', {
            waitReason: 'input_pending',
            outputTail: '❯ bg',
          })
        }
      },
    })
    const target = new FakeAdapter({ implId: 'codex', caps: { revive: true }, onStateChange: harness.handleStateChange })
    adaptersMap.set('claude-code', source)
    adaptersMap.set('codex', target)
    const worker = await harness.spawnWorker(spawnParams({ impl: 'claude-code' }))
    const settlements: string[] = []

    await harness.sendToWorker(worker.worker_id, 'bg', {
      dedupeKey: 'bg-shell:1',
      onSettled: async (settlement) => { settlements.push(settlement) },
    })
    expect(settlements).toEqual([])

    await harness.switchWorkerImpl(worker.worker_id, 'codex', 'move durable notification')

    expect(target.sendInputCalls.filter((call) => call.text === 'bg')).toHaveLength(1)
    expect(settlements).toEqual(['delivered'])
  })

  it('replays an in-flight durable stall that resolves after the explicit switch', async () => {
    const { harness, adaptersMap } = await makeHarness()
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const source = new FakeAdapter({
      implId: 'claude-code',
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: async (_h, text, opts) => {
        if (!opts?.raw && text === 'bg') {
          markEntered()
          await gate
          throw new CliInputStallError('pending_in_ui', 'running', {
            waitReason: 'input_pending',
            outputTail: '❯ bg',
          })
        }
      },
    })
    const target = new FakeAdapter({ implId: 'codex', caps: { revive: true }, onStateChange: harness.handleStateChange })
    adaptersMap.set('claude-code', source)
    adaptersMap.set('codex', target)
    const worker = await harness.spawnWorker(spawnParams({ impl: 'claude-code' }))
    const settlements: string[] = []

    const send = harness.sendToWorker(worker.worker_id, 'bg', {
      dedupeKey: 'bg-shell:1',
      onSettled: async (settlement) => { settlements.push(settlement) },
    })
    await entered
    await harness.switchWorkerImpl(worker.worker_id, 'codex', 'switch while old send is in flight')
    release()
    await send

    expect(target.sendInputCalls.filter((call) => call.text === 'bg')).toHaveLength(1)
    expect(settlements).toEqual(['delivered'])
  })
})

describe('WorkerHarness — 接续过程中的并发', () => {
  it('接续进行中来的 sendToWorker 不与之交错（在同一把 per-worker 锁内排队）', async () => {
    const { harness, adaptersMap } = await makeHarness()
    let releaseResume!: () => void
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve
    })
    const fake = new FakeAdapter({
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      resumeBehavior: async (prev) => {
        await resumeGate
        return { worker_id: prev.worker_id, seq: prev.seq + 1, impl: 'builtin', session_ref: `resumed-${prev.worker_id}` }
      },
    })
    adaptersMap.set('builtin', fake)

    const worker = await harness.spawnWorker(spawnParams())
    const mainlineHandle: IncarnationHandle = { worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` }
    fake.emitStateChange(mainlineHandle, 'exited')
    await waitUntil(async () => {
      const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      return w.incarnations[0].state === 'exited'
    })

    // 第一次 sendToWorker 触发接续，卡在 resumeGate 上（resume 还没返回，per-worker 锁被占着）。
    const firstSend = harness.sendToWorker(worker.worker_id, '第一条')

    // 第二次 sendToWorker 此时应该排队等锁：它的 deliver() 也会经 inbox 尝试投递，但由于
    // inbox.flush 内部同样串行、且第一条的接续持有 per-worker 锁，第二条不会在接续完成前
    // 观察到"半接续"的中间态（比如两条化身同时挂进主线链）。
    let secondResolved = false
    const secondSend = harness.sendToWorker(worker.worker_id, '第二条').then(() => {
      secondResolved = true
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(secondResolved).toBe(false)
    expect(fake.resumeCalls).toHaveLength(1) // 第二次没有并发触发第二次 resume

    releaseResume()
    await firstSend
    await secondSend

    expect(secondResolved).toBe(true)
    // 接续完成后台账只多了一个新主线化身（不是两个并发接续各自产出一个）。
    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.incarnations).toHaveLength(2)
    expect(fake.resumeCalls).toHaveLength(1)
    // 第二条消息通过"mainline.seq !== sourceSeq"分支，作为普通投递补送到了新主线。
    expect(fake.sendInputCalls.some((c) => c.text === '第二条')).toBe(true)
  })
})

describe('WorkerHarness.handoffIncarnation — handoff 目标是 builtin 时的 pre-flight（裁决 B 修复）', () => {
  it('目标是 builtin 且未配置 HarnessDeps.builtinSpawnDefaults → pre-flight 直接抛错，旧化身状态与 HANDOFF.md 均未被改动（可重试）', async () => {
    // 不用共享的 makeHarness() —— 它为了不影响其它不专门测这条 pre-flight 的既有用例，
    // 默认给 builtinSpawnDefaults 配了桩值；这里要专门测"没配置"的场景，必须自建 deps。
    const ledgersDir = join(dataDir, 'ledgers')
    const workspacesRoot = join(dataDir, 'workspaces')
    const workersDir = join(dataDir, 'workers')
    await fs.mkdir(workspacesRoot, { recursive: true })
    const ledger = new LedgerStore(ledgersDir)
    const workspaces = new WorkspaceManager(workspacesRoot)
    const adaptersMap = new Map<WorkerImplId, WorkerAdapter>()
    const deps: HarnessDeps = {
      adapters: adaptersMap,
      defaultImpl: 'claude-code',
      ledger,
      workspaces,
      workersDir,
      now,
      onEvent: (e) => events.push(e),
      // 关键：没有 builtinSpawnDefaults。
    }
    const harness = new WorkerHarness(deps)
    const source = new FakeAdapter({
      implId: 'claude-code',
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      outputChunk: '还没做完的工作',
    })
    const builtinTarget = new FakeAdapter({ implId: 'builtin', onStateChange: harness.handleStateChange })
    adaptersMap.set('claude-code', source)
    adaptersMap.set('builtin', builtinTarget)

    const worker = await harness.spawnWorker(spawnParams({ impl: 'claude-code' }))
    const workspaceRoot = worker.incarnations[0].workspace
    events.length = 0

    await expect(harness.switchWorkerImpl(worker.worker_id, 'builtin', '切到 builtin')).rejects.toThrow(
      /builtinSpawnDefaults/
    )

    // pre-flight 失败必须发生在"碰旧化身"之前：不能 kill、不能改台账、不能写 HANDOFF.md，
    // 否则下次重试会重复整套 handoff（重复追加 HANDOFF.md），且 worker 卡在"旧的没了、
    // 新的没建成"的死结里。
    expect(source.killCalls).toHaveLength(0)
    expect(builtinTarget.spawnCalls).toHaveLength(0)
    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.incarnations).toHaveLength(1)
    expect(w.incarnations[0].state).toBe('running') // 源化身原样存活，未被标 superseded
    expect(w.incarnations[0].ended_reason).toBeUndefined()

    await expect(fs.readFile(join(workspaceRoot, 'HANDOFF.md'), 'utf-8')).rejects.toThrow() // 文件未被创建

    expect(events.filter((e) => e.kind === 'handoff_started')).toHaveLength(0)
    expect(events.filter((e) => e.kind === 'superseded')).toHaveLength(0)
  })

  it('目标是 builtin 且配置了 HarnessDeps.builtinSpawnDefaults → handoff 正常完成，新化身 spawn 时带上了注入的 builtin 配置', async () => {
    const ledgersDir = join(dataDir, 'ledgers')
    const workspacesRoot = join(dataDir, 'workspaces')
    const workersDir = join(dataDir, 'workers')
    await fs.mkdir(workspacesRoot, { recursive: true })
    const ledger = new LedgerStore(ledgersDir)
    const workspaces = new WorkspaceManager(workspacesRoot)
    const builtinDefaults: NonNullable<SpawnSpec['builtin']> = {
      adapter: {} as LLMAdapter,
      model: 'test-model',
      systemPrompt: '',
      tools: [],
    }
    const factoryCtxs: BuiltinRuntimeContext[] = []

    // 见 harness.ts 文件头"onStateChange 接线契约":先建空壳 Map、建 harness，再建各 adapter
    // （构造时把 harness.handleStateChange 传进去），最后把 adapter 塞进 Map。
    const adaptersMap = new Map<WorkerImplId, WorkerAdapter>()
    const deps: HarnessDeps = {
      adapters: adaptersMap,
      defaultImpl: 'claude-code',
      ledger,
      workspaces,
      workersDir,
      now,
      onEvent: (e) => events.push(e),
      builtinSpawnDefaults: (ctx) => {
        factoryCtxs.push(ctx)
        return builtinDefaults
      },
    }
    const harness = new WorkerHarness(deps)
    const source = new FakeAdapter({
      implId: 'claude-code',
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      outputChunk: '还没做完的工作',
    })
    const builtinTarget = new FakeAdapter({ implId: 'builtin', onStateChange: harness.handleStateChange })
    adaptersMap.set('claude-code', source)
    adaptersMap.set('builtin', builtinTarget)

    const worker = await harness.spawnWorker(spawnParams({ impl: 'claude-code' }))
    events.length = 0

    await harness.switchWorkerImpl(worker.worker_id, 'builtin', '切到 builtin')

    expect(builtinTarget.spawnCalls).toHaveLength(1)
    expect(builtinTarget.spawnCalls[0].builtin).toBe(builtinDefaults)
    // 工厂带 per-worker 上下文（PR F）：交接沿用源化身的 workspace（§5.3 同 workspace 交接），
    // origin 取台账上这条 worker 自己的——不是随便给一份缺省值。
    expect(factoryCtxs).toHaveLength(1)
    expect(factoryCtxs[0].worker_id).toBe(worker.worker_id)
    expect(factoryCtxs[0].workspace.root).toBe(worker.incarnations[0].workspace)
    expect(factoryCtxs[0].origin).toEqual(worker.origin)

    const [w] = await ledger.listWorkers(dialogObjectIdForPrivate('friend-1'))
    const newEntry = w.incarnations[w.incarnations.length - 1]
    expect(newEntry.impl).toBe('builtin')
    expect(newEntry.state).toBe('running')
  })
})

describe('WorkerHarness — 化身 seq 跨实例撞号（protocol-agent-v3 §6.1 已知限制）', () => {
  it('接续产出的新化身与已归档的旧化身 seq 相同（跨 adapter 实例重新从 1 计数）→ 状态回调只改最后一条，不篡改已归档记录', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter({
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: (h) => {
        throw new WorkerExitedError(h.worker_id, h.seq)
      },
      // 模拟"跨 adapter 实例"场景：resume 产出的新化身复用 seq=1，与已经在台账里的旧化身
      // （同样 seq=1，同 impl='builtin'）撞号——真实场景下这是"新的 adapter 实例内部
      // nextSeq 从头计数"（进程重启 / 跨实现切换回同一实现）。
      resumeBehavior: (prev) => ({
        worker_id: prev.worker_id,
        seq: 1,
        impl: 'builtin',
        session_ref: `resumed-collision-ref-${prev.worker_id}`,
      }),
    })
    adaptersMap.set('builtin', fake)

    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    // 触发接续：旧化身（seq=1）台账态仍是 running，WorkerExitedError 触发 revive；revive
    // 前会先把旧化身回填终态（Task 8 修复 1），resume 产出的新化身同样是 seq=1（撞号）。
    await harness.sendToWorker(worker.worker_id, '继续')

    const [afterRevive] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(afterRevive.incarnations).toHaveLength(2)
    const archived = afterRevive.incarnations[0]
    const active = afterRevive.incarnations[1]
    expect(archived.seq).toBe(1)
    expect(active.seq).toBe(1) // 撞号：两条记录 seq 相同
    expect(archived.state).toBe('exited') // 已归档（revive 前回填的终态）
    expect(active.state).toBe('running')
    const archivedSessionRefBefore = archived.session_ref
    const archivedEndedReasonBefore = archived.ended_reason

    // 新化身（active，seq=1）自然结束（非 kill）→ processStateChange 状态回调命中 seq=1。
    // 撞号意味着"按 seq 匹配"会同时命中 archived 和 active 两条记录——修复前
    // patchIncarnationBySeq 用 .map 逐条匹配 seq，会把 archived 也一起改写；修复后按
    // (impl, seq) 只改最后一条（active），archived 保持原样。
    const activeHandle: IncarnationHandle = {
      worker_id: worker.worker_id,
      seq: 1,
      impl: 'builtin',
      session_ref: active.session_ref,
    }
    fake.emitStateChange(activeHandle, 'exited')
    await waitUntil(async () => {
      const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      return w.incarnations[1].state === 'exited'
    })

    const [afterStateChange] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    const archivedAfter = afterStateChange.incarnations[0]
    const activeAfter = afterStateChange.incarnations[1]

    // active（最后一条同 (impl,seq) 记录）被正确更新。
    expect(activeAfter.state).toBe('exited')
    expect(activeAfter.ended_reason).toBe('completed')

    // archived（已归档的同 (impl,seq) 旧记录）必须完全不受这次状态回调影响。
    expect(archivedAfter.state).toBe('exited')
    expect(archivedAfter.ended_reason).toBe(archivedEndedReasonBefore)
    expect(archivedAfter.session_ref).toBe(archivedSessionRefBefore)
  })
})

// ---- session_ref 时效性修复：用真实 BuiltinWorkerAdapter（mock LLM），跑两轮 burst，
// 断言台账里的 session_ref 已经推进到新 tip，而不是 spawn 时的初值。----

function makeMockLLMAdapter(
  responses: Array<{ text?: string; stopReason: 'end_turn' | 'tool_use' }>,
): LLMAdapter {
  let i = 0
  return {
    stream: async function* () {
      const r = responses[i++] ?? responses[responses.length - 1]
      const content: unknown[] = []
      if (r.text) content.push({ type: 'text', text: r.text })
      yield* chunksFromContent(content, r.stopReason, { inputTokens: 100, outputTokens: 50 })
    },
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

describe('BuiltinWorkerAdapter → WorkerHarness — session_ref 时效性修复', () => {
  it('两轮 burst 后，台账里的 session_ref 已推进到新 tip（不是 spawn 时的初值）', async () => {
    const builtinDataDir = join(dataDir, 'builtin-runtime')
    await fs.mkdir(builtinDataDir, { recursive: true })

    const { harness, adaptersMap } = await makeHarness()
    const builtinAdapter = new BuiltinWorkerAdapter({ dataDir: builtinDataDir, onStateChange: harness.handleStateChange })
    adaptersMap.set('builtin', builtinAdapter)

    const llmAdapter = makeMockLLMAdapter([
      { text: '第一轮回复', stopReason: 'end_turn' },
      { text: '第二轮回复', stopReason: 'end_turn' },
    ])

    const worker = await harness.spawnWorker(
      spawnParams({ builtin: { adapter: llmAdapter, model: 'test', systemPrompt: '', tools: [] } })
    )
    const spawnTimeSessionRef = worker.incarnations[0].session_ref
    expect(spawnTimeSessionRef).toBeTruthy()

    await waitUntil(async () => {
      const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      return w.incarnations[0].state === 'idle'
    })
    const [afterFirstBurst] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    // 第一轮 burst 结束后，台账的 session_ref 已经从 spawn 时的根节点前进到新 tip——
    // 不再是创建时刻的快照，而是"最近一次完成的状态转换点"。
    expect(afterFirstBurst.incarnations[0].session_ref).not.toBe(spawnTimeSessionRef)
    const afterFirstBurstRef = afterFirstBurst.incarnations[0].session_ref

    await harness.sendToWorker(worker.worker_id, '第二轮输入')
    await waitUntil(async () => {
      const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      return w.incarnations[0].state === 'idle' && w.incarnations[0].session_ref !== afterFirstBurstRef
    })

    const [afterSecondBurst] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(afterSecondBurst.incarnations[0].session_ref).not.toBe(afterFirstBurstRef)
    expect(afterSecondBurst.incarnations[0].session_ref).not.toBe(spawnTimeSessionRef)
  })
})

describe('WorkerHarness.processStateChange — 化身查找: 同 (impl, seq) 撞号场景下按最后一条处理', () => {
  it('同 impl 同 seq 的两条记录（旧的已 exited、新的 running）→ 新的状态回调应该被处理而非被旧条目短路吞掉 (PoC 修复验证)', async () => {
    const { harness, ledger, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter({ caps: { revive: true }, onStateChange: harness.handleStateChange })
    adaptersMap.set('builtin', fake)

    // 1. spawn 初始化身
    const worker = await harness.spawnWorker(spawnParams())
    const workerId = worker.worker_id
    const dialogId = dialogObjectIdForPrivate('friend-1')

    // 2. 让初始化身进入 exited 状态（旧的已归档化身）
    const handle: IncarnationHandle = { worker_id: workerId, seq: 1, impl: 'builtin', session_ref: worker.incarnations[0].session_ref }
    fake.emitStateChange(handle, 'exited')
    await waitUntil(async () => {
      const [w] = await harness.listWorkers(dialogId)
      return w.incarnations[0].state === 'exited'
    })

    const afterFirstExit = (await harness.listWorkers(dialogId))[0]
    expect(afterFirstExit.incarnations).toHaveLength(1)
    expect(afterFirstExit.incarnations[0].state).toBe('exited')

    // 3. 人工插入一条新的同 (impl, seq=1) 记录到 incarnations（模拟撞号场景）
    // —— 新记录仍然是 running，代表真正的活跃化身。这模拟"进程重启后 adapter 又分配了 seq=1"的场景
    // 同时把 task.status 恢复到 running（模拟新化身入链后的状态）
    await ledger.upsertWorker(dialogId, workerId, (prev) => {
      if (!prev) return undefined
      const newIncarnation = {
        seq: 1,
        impl: 'builtin' as const,
        state: 'running' as const,
        workspace: prev.incarnations[0].workspace,
        session_ref: `ref-${workerId}#1-new`,
        started_at: prev.incarnations[0].started_at,
      }
      return {
        ...prev,
        incarnations: [...prev.incarnations, newIncarnation],
        task: { ...prev.task, status: 'running' as const },
        updated_at: prev.updated_at,
      }
    })

    const beforeStateChange = (await harness.listWorkers(dialogId))[0]
    expect(beforeStateChange.incarnations).toHaveLength(2)
    expect(beforeStateChange.incarnations[0].state).toBe('exited') // 旧的
    expect(beforeStateChange.incarnations[1].state).toBe('running') // 新的，真正的活跃化身

    events.length = 0

    // 4. 新化身自然退出，发送状态回调。注意这里用的是新化身的 session_ref
    const newHandle: IncarnationHandle = { worker_id: workerId, seq: 1, impl: 'builtin', session_ref: `ref-${workerId}#1-new` }
    fake.emitStateChange(newHandle, 'exited')
    await new Promise((resolve) => setTimeout(resolve, 50))

    // 修复前会失败：
    // - processStateChange 用 find(seq===1) 找到第一条（旧的 exited）
    // - 被"if (target.state==='exited') return"短路，事件丢失、台账不更新
    // - incarnations[1]（新的 running 化身）永远保持 running 状态，无人驾驶
    //
    // 修复后应该正确处理：
    // - processStateChange 用 findIncarnation(impl, seq) 按最后一条处理，命中新的（incarnations[1]）
    // - 新的被更新为 exited(completed)，台账更新 + 事件发出

    const afterStateChange = (await harness.listWorkers(dialogId))[0]
    // 关键断言：新化身（数组最后一条）被正确更新为 exited
    expect(afterStateChange.incarnations[1].state).toBe('exited')
    expect(afterStateChange.incarnations[1].ended_reason).toBe('completed')
    // 旧化身保持不变（已经是 completed，不被新状态回调覆盖）
    expect(afterStateChange.incarnations[0].state).toBe('exited')
    expect(afterStateChange.incarnations[0].ended_reason).toBe('completed') // 旧的没被改动，保持原值

    // 确保事件被正确记录（如果被短路吞掉就不会有事件）
    const stateChangedEvents = events.filter((e) => e.kind === 'state_changed')
    expect(stateChangedEvents.length).toBeGreaterThan(0)
    expect(stateChangedEvents[0].seq).toBe(1)
  })

  it('同 seq 同 impl 两条 fork 分支化身（旧的已 exited、新的 running）→ 状态更新只影响新的那条，mainline task 不受影响', async () => {
    const { harness, ledger, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter({ caps: { fork: false, revive: true }, onStateChange: harness.handleStateChange })
    adaptersMap.set('builtin', fake)

    // 1. spawn 主线化身 seq=1
    const worker = await harness.spawnWorker(spawnParams())
    const workerId = worker.worker_id
    const dialogId = dialogObjectIdForPrivate('friend-1')
    const mainlineHandle: IncarnationHandle = {
      worker_id: workerId,
      seq: 1,
      impl: 'builtin',
      session_ref: worker.incarnations[0].session_ref,
    }

    // 2. 模拟一个 fork 化身（手动插入，因为 FakeAdapter 不支持 fork）
    const forkSeq = 2
    await ledger.upsertWorker(dialogId, workerId, (prev) => {
      if (!prev) return undefined
      const forkIncarnation = {
        seq: forkSeq,
        impl: 'builtin' as const,
        state: 'running' as const,
        workspace: prev.incarnations[0].workspace,
        session_ref: `fork-${forkSeq}`,
        started_at: prev.incarnations[0].started_at,
        forked_from: 1,
      }
      return { ...prev, incarnations: [...prev.incarnations, forkIncarnation], updated_at: prev.updated_at }
    })

    let current = (await harness.listWorkers(dialogId))[0]
    expect(current.incarnations).toHaveLength(2)
    expect(current.incarnations[1].forked_from).toBe(1)
    expect(current.task.status).toBe('running')

    // 3. fork 化身终态（旧的记录）
    const oldForkHandle: IncarnationHandle = { worker_id: workerId, seq: forkSeq, impl: 'builtin', session_ref: `fork-${forkSeq}` }
    fake.emitStateChange(oldForkHandle, 'exited')
    await new Promise((resolve) => setTimeout(resolve, 50))

    current = (await harness.listWorkers(dialogId))[0]
    expect(current.incarnations[1].state).toBe('exited') // fork 化身已终态
    expect(current.task.status).toBe('running') // mainline task 不受影响

    // 4. 人工插入第二个同 seq 的 fork 化身（模拟撞号）
    await ledger.upsertWorker(dialogId, workerId, (prev) => {
      if (!prev) return undefined
      const newForkIncarnation = {
        seq: forkSeq,
        impl: 'builtin' as const,
        state: 'running' as const,
        workspace: prev.incarnations[0].workspace,
        session_ref: `fork-${forkSeq}-new`,
        started_at: prev.incarnations[1].started_at,
        forked_from: 1,
      }
      return {
        ...prev,
        incarnations: [...prev.incarnations, newForkIncarnation],
        task: { ...prev.task, status: 'running' as const },
        updated_at: prev.updated_at,
      }
    })

    current = (await harness.listWorkers(dialogId))[0]
    expect(current.incarnations).toHaveLength(3)
    expect(current.incarnations[1].state).toBe('exited') // 旧的 fork
    expect(current.incarnations[2].state).toBe('running') // 新的 fork

    events.length = 0

    // 5. 新 fork 化身退出
    const newForkHandle: IncarnationHandle = { worker_id: workerId, seq: forkSeq, impl: 'builtin', session_ref: `fork-${forkSeq}-new` }
    fake.emitStateChange(newForkHandle, 'exited')
    await new Promise((resolve) => setTimeout(resolve, 50))

    // 修复后应该正确更新新 fork 化身，不影响 mainline task
    current = (await harness.listWorkers(dialogId))[0]
    expect(current.incarnations[2].state).toBe('exited') // 新的 fork 被更新
    expect(current.incarnations[2].ended_reason).toBe('completed')
    expect(current.incarnations[2].forked_from).toBe(1) // 仍然是 fork
    expect(current.task.status).toBe('running') // mainline task 不受影响
  })
})

describe('WorkerHarness — 终审 PoC 回归：M1 主线守卫按 (impl,seq) 收口', () => {
  it('switchWorkerImpl 到新实现后（seq 撞号），旧实现的迟到 exited 回调不得误杀新主线，也不得覆盖旧化身的 superseded', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const source = new FakeAdapter({ implId: 'claude-code', caps: { revive: true }, onStateChange: harness.handleStateChange })
    const target = new FakeAdapter({ implId: 'codex', caps: { revive: true }, onStateChange: harness.handleStateChange })
    adaptersMap.set('claude-code', source)
    adaptersMap.set('codex', target)

    const worker = await harness.spawnWorker(spawnParams({ impl: 'claude-code' }))
    // handoff 里 kill 旧化身触发的 exited 回调本该走这个 handle；这里手动重放，模拟它比
    // handoff 收尾还慢的时序（真实 adapter 内部是异步触发 onStateChange，此处同型直调）。
    const oldHandle: IncarnationHandle = { worker_id: worker.worker_id, seq: 1, impl: 'claude-code', session_ref: `ref-${worker.worker_id}#1` }
    events.length = 0

    await harness.switchWorkerImpl(worker.worker_id, 'codex', '手工切换到 codex')

    // handoff 后新主线是 codex#1 —— target 是全新 FakeAdapter 实例，nextSeq 从 1 开始，
    // 与被 kill 的旧化身 claude-code#1 在 seq 上撞号，这正是终审 PoC 复现的前提。
    const afterHandoff = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    const newMainline = afterHandoff.incarnations[afterHandoff.incarnations.length - 1]
    expect(newMainline.impl).toBe('codex')
    expect(newMainline.seq).toBe(1)
    expect(afterHandoff.task.status).toBe('running')

    // 顺带修复：handoff 产出的新化身也发了 spawned 事件（与 revive 路径的 resumed 对称）。
    expect(events.filter((e) => e.kind === 'spawned')).toHaveLength(1)

    // 旧 adapter（claude-code）的迟到 exited 回调打到 handoff 之前的 handle 上，seq 与新
    // 主线 codex#1 相同——只比 seq 不比 impl 的守卫会把它误判成"当前主线化身的回调"。
    source.emitStateChange(oldHandle, 'exited')
    await new Promise((resolve) => setTimeout(resolve, 20))

    const after = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    // 新主线（codex#1）未被这条属于旧实现的迟到回调误杀。
    expect(after.task.status).toBe('running')
    const stillMainline = after.incarnations[after.incarnations.length - 1]
    expect(stillMainline.impl).toBe('codex')
    expect(stillMainline.state).toBe('running')

    // 旧化身（claude-code#1）的终态记录不被这条迟到回调覆盖——仍是 handoff 时记录的
    // superseded，不是被误判成 completed。
    const oldEntry = after.incarnations.find((i) => i.impl === 'claude-code' && i.seq === 1)!
    expect(oldEntry.ended_reason).toBe('superseded')
  })
})

describe('WorkerHarness — 终审 PoC 回归：M2 kill 与 in-flight flush 竞态', () => {
  it('send 卡在投递期间 kill：残留队列条目被 drain 并记 dead-letter，task 保持 cancelled，不触发 resume 复活', async () => {
    const { harness, adaptersMap } = await makeHarness()
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const fake = new FakeAdapter({
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: async (_h, text) => {
        if (text === '第一条(卡住)') await firstGate
      },
    })
    adaptersMap.set('builtin', fake)

    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    // 第一条投递卡在 adapter.sendInput（模拟 tmux 命令挂起），占住 inbox 自己的 flush 锁。
    const firstSend = harness.sendToWorker(worker.worker_id, '第一条(卡住)')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.sendInputCalls).toHaveLength(1) // 确认已经卡在 sendInput 里面

    // 第二条这时候只能排进 inbox 队列，还没被 deliver 摸到（flush 的 mutex 被第一条占着）。
    const secondSend = harness.sendToWorker(worker.worker_id, '第二条(残留队列)')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.sendInputCalls).toHaveLength(1) // 第二条还没被投递

    // kill 走 harness 自己的 per-worker 锁，不被卡住的 sendInput 阻塞，立即完成。
    await harness.killWorker(worker.worker_id, 'M2 PoC')

    const afterKill = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    expect(afterKill.task.status).toBe('cancelled')

    // 放行第一条，让它的 sendInput 正常返回，flush 的 while 循环继续处理队列里的第二条。
    releaseFirst()
    await firstSend
    await secondSend

    const after = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    // 核心断言：task 没有被第二条残留消息的透明接续复活成 running。
    expect(after.task.status).toBe('cancelled')
    expect(fake.resumeCalls).toHaveLength(0)

    // 残留条目没有静默消失：有 dead-letter 记录。
    const deadLetterEvents = events.filter((e) => e.kind === 'state_changed' && (e.detail as Record<string, unknown> | undefined)?.kind === 'dead_letter')
    expect(deadLetterEvents.length).toBeGreaterThan(0)
  })

  it('send 卡住期间被 kill，之后 adapter.sendInput 才抛 WorkerExitedError 走透明接续：in-flight 条目不经过 drain，cancelled task 仍不被 continueTerminalWorker 复活', async () => {
    const { harness, adaptersMap } = await makeHarness()
    let releaseGate!: (err: Error) => void
    const gate = new Promise<void>((_resolve, reject) => {
      releaseGate = (err) => reject(err)
    })
    const fake = new FakeAdapter({
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: async () => {
        await gate
      },
    })
    adaptersMap.set('builtin', fake)

    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const send = harness.sendToWorker(worker.worker_id, '卡住的一条')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fake.sendInputCalls).toHaveLength(1) // 确认已经卡在 sendInput 里面，是 in-flight 条目

    await harness.killWorker(worker.worker_id, 'M2 PoC 2')
    const afterKill = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    expect(afterKill.task.status).toBe('cancelled')

    // 放行卡住的 sendInput，让它抛出 WorkerExitedError（模拟 adapter 发现化身已经真的没了）
    // —— deliver() 的 catch 分支会把它转入 continueTerminalWorker。这条条目在 kill 发生时
    // 正处于 in-flight（已从 inbox 队列取出），drain() 明确不清空 in-flight 条目，所以这条
    // 用例验证的是 continueTerminalWorker 自己的 cancelled 检查，而不是 killWorker 的 drain。
    releaseGate(new WorkerExitedError(worker.worker_id, 1))
    await send

    const after = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    expect(after.task.status).toBe('cancelled') // 核心断言：没有被复活成 running
    expect(fake.resumeCalls).toHaveLength(0)

    const deadLetterEvents = events.filter((e) => e.kind === 'state_changed' && (e.detail as Record<string, unknown> | undefined)?.kind === 'dead_letter')
    expect(deadLetterEvents.length).toBeGreaterThan(0)
  })
})

describe('WorkerHarness — 终审 PoC 回归：M3 continueTerminalWorker 守卫按 (impl,seq) 收口 + raw 透传', () => {
  async function sendAcrossConcurrentSwitch(targetOpts: FakeAdapterOpts, text: string) {
    const { harness, adaptersMap } = await makeHarness()
    let releaseGate!: (err: Error) => void
    const gate = new Promise<void>((_resolve, reject) => { releaseGate = reject })
    const source = new FakeAdapter({
      implId: 'claude-code',
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: async () => { await gate },
    })
    const target = new FakeAdapter({
      implId: 'codex',
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      ...targetOpts,
    })
    adaptersMap.set('claude-code', source)
    adaptersMap.set('codex', target)
    const worker = await harness.spawnWorker(spawnParams({ impl: 'claude-code' }))
    const send = harness.sendToWorker(worker.worker_id, text)
    await waitUntil(async () => source.sendInputCalls.length === 1)
    await harness.switchWorkerImpl(worker.worker_id, 'codex', '并发切换')
    releaseGate(new WorkerExitedError(worker.worker_id, 1))
    return { harness, target, send }
  }

  it('deliver 卡在 sendInput 期间发生跨实现 switchWorkerImpl（seq 撞号）：不误把存活新主线当终态接续，补送到新主线且保留 raw', async () => {
    const { harness, adaptersMap } = await makeHarness()
    let releaseGate!: (err: Error) => void
    const gate = new Promise<void>((_resolve, reject) => {
      releaseGate = (err) => reject(err)
    })
    const source = new FakeAdapter({
      implId: 'claude-code',
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: async () => {
        await gate
      },
    })
    // target 的 resume 复刻真实 adapter（claude-code/codex）对"未终态就 resume"的拒绝
    // 语义（"has not exited yet"）——修复前的 bug 正是把这个存活化身误当终态源去 resume。
    let target!: FakeAdapter
    target = new FakeAdapter({
      implId: 'codex',
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      resumeBehavior: async (prev) => {
        const st = await target.state({ worker_id: prev.worker_id, seq: prev.seq, impl: 'codex', session_ref: prev.session_ref })
        if (st !== 'exited') {
          throw new Error(`FakeAdapter(codex).resume: incarnation ${prev.worker_id}#${prev.seq} has not exited yet (state=${st})`)
        }
        return { worker_id: prev.worker_id, seq: prev.seq + 1, impl: 'codex', session_ref: `resumed-${prev.worker_id}` }
      },
    })
    adaptersMap.set('claude-code', source)
    adaptersMap.set('codex', target)

    const worker = await harness.spawnWorker(spawnParams({ impl: 'claude-code' }))
    events.length = 0

    // 第一条投递卡在 claude-code 的 sendInput 里（模拟"读到还未终态、真正在投递中"）——
    // adapter.sendInput 不占用 harness 的 per-worker 锁（见文件头锁纪律注释），此刻锁空闲。
    const send = harness.sendToWorker(worker.worker_id, '带 raw 的敲键', { raw: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(source.sendInputCalls).toHaveLength(1)

    // 等投递期间发生跨实现切换：codex#1 顶替 claude-code#1——两个 FakeAdapter 各自 nextSeq
    // 从 1 计数，与旧主线（claude-code#1）seq 撞号，这正是本条 PoC 的复现前提（M1 回归
    // 测试已确认这种撞号是跨实现切换的常态）。
    await harness.switchWorkerImpl(worker.worker_id, 'codex', '并发切换')
    const afterSwitch = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    const newMainline = afterSwitch.incarnations[afterSwitch.incarnations.length - 1]
    expect(newMainline.impl).toBe('codex')
    expect(newMainline.seq).toBe(1) // 撞号
    expect(newMainline.state).toBe('running') // 存活

    // 放行卡住的 sendInput，抛出 WorkerExitedError——deliver 的 catch 分支据此转入
    // continueTerminalWorker(sourceImpl='claude-code', sourceSeq=1)，此时它已经不再是主线。
    releaseGate(new WorkerExitedError(worker.worker_id, 1))

    // 核心断言：只比 seq 不比 impl 会把撞号的存活新主线（codex#1）误当终态源，对它调用
    // adapter.resume（其状态仍 running，会抛 "has not exited yet"），该错误穿透 inbox.flush
    // 一路砸给 sendToWorker 的调用方——修复前这里应当 reject。
    await expect(send).resolves.toBeUndefined()

    // 没有把存活的 codex#1 误当终态化身去 revive。
    expect(target.resumeCalls).toHaveLength(0)

    // 消息按"普通投递"语义补送到当前（存活）新主线 codex#1，且原样保留 raw 标志。
    expect(target.sendInputCalls).toHaveLength(1)
    expect(target.sendInputCalls[0].text).toBe('带 raw 的敲键')
    expect(target.sendInputCalls[0].opts).toEqual({ raw: true })

    // 没有产生第三个化身（没有误触发一次多余的 revive/handoff）。
    const after = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    expect(after.incarnations).toHaveLength(2)
  })

  it('补送到并发新主线时把CLI stall收敛为hold而不向调用方抛错', async () => {
    const { send, target } = await sendAcrossConcurrentSwitch({
      sendInputBehavior: () => {
        throw new CliInputStallError('pending_in_ui', 'running', {
          waitReason: 'input_pending',
          outputTail: '❯ queued text',
        })
      },
    }, '并发补送 stall')

    await expect(send).resolves.toBeUndefined()
    expect(target.sendInputCalls.filter((call) => call.text === '并发补送 stall')).toHaveLength(1)
  })

  it('补送到并发新主线时消费accepted exit和延后发现的session_ref', async () => {
    const realSessionRef = '019fe15f-cbd9-76c1-9a18-e6c2e1d2b2d9'
    const { harness, send } = await sendAcrossConcurrentSwitch({
      acceptedExitReport: { endReason: 'completed' },
      updatedSessionRef: realSessionRef,
    }, '并发补送 accepted exit')

    await expect(send).resolves.toBeUndefined()
    const [settled] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    const mainline = settled.incarnations[settled.incarnations.length - 1]
    expect(mainline).toMatchObject({
      impl: 'codex',
      session_ref: realSessionRef,
      state: 'exited',
      ended_reason: 'completed',
    })
    expect(settled.task.status).toBe('completed')
  })
})

describe('WorkerHarness — 二轮 review PoC 回归：continueTerminalWorker 补送分支的终态竞态收口（锁内可重入求值）', () => {
  it('deliver 卡在旧主线投递期间发生跨实现切换，且新主线在本调用拿锁前也已自然终态（台账已落 exited）：不误对已终态化身调 sendInput，径直转接续，调用方无感', async () => {
    const { harness, adaptersMap } = await makeHarness()
    let releaseGate!: (err: Error) => void
    const gate = new Promise<void>((_resolve, reject) => {
      releaseGate = (err) => reject(err)
    })
    const source = new FakeAdapter({
      implId: 'claude-code',
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: async () => {
        await gate
      },
    })
    const target = new FakeAdapter({
      implId: 'codex',
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      // 修复前：continueTerminalWorker 的"补送"分支无条件对当前主线调 sendInput，即使
      // 台账已经把它记为 exited——真实 adapter 对已退出化身的 sendInput 权威地抛
      // WorkerExitedError，这里如实模拟。修复后这条分支应当在读到 mainline.state==='exited'
      // 后直接跳过 sendInput、转入接续，这个桩函数根本不会被调用（用 sendInputCalls 断言）。
      sendInputBehavior: (h) => {
        throw new WorkerExitedError(h.worker_id, h.seq)
      },
    })
    adaptersMap.set('claude-code', source)
    adaptersMap.set('codex', target)

    const worker = await harness.spawnWorker(spawnParams({ impl: 'claude-code' }))
    events.length = 0

    // 第一条投递卡在 claude-code 的 sendInput 里，此刻 per-worker 锁空闲。
    const send = harness.sendToWorker(worker.worker_id, '并发终态竞态', { raw: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(source.sendInputCalls).toHaveLength(1)

    // 投递期间发生跨实现切换：codex#1 顶替 claude-code#1。
    await harness.switchWorkerImpl(worker.worker_id, 'codex', '并发切换')
    const afterSwitch = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    const newMainline = afterSwitch.incarnations[afterSwitch.incarnations.length - 1]
    expect(newMainline.impl).toBe('codex')
    expect(newMainline.seq).toBe(1)
    expect(newMainline.state).toBe('running')

    // 关键并发窗口：在 continueTerminalWorker 真正拿到 per-worker 锁之前，新主线
    // （codex#1）自己也已经自然退出——processStateChange 抢先拿锁，把它落定为 exited。
    const newMainlineHandle: IncarnationHandle = {
      worker_id: worker.worker_id,
      seq: 1,
      impl: 'codex',
      session_ref: newMainline.session_ref,
    }
    target.emitStateChange(newMainlineHandle, 'exited')
    await waitUntil(async () => {
      const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      const ml = w.incarnations[w.incarnations.length - 1]
      return ml.impl === 'codex' && ml.state === 'exited'
    })

    // 放行卡住的 sendInput，抛出 WorkerExitedError——deliver 的 catch 分支据此转入
    // continueTerminalWorker(sourceImpl='claude-code', sourceSeq=1)，此时主线早已换成
    // 已终态的 codex#1。
    releaseGate(new WorkerExitedError(worker.worker_id, 1))

    // 核心断言：修复前，补送分支对已终态的新主线仍无条件调 sendInput，抛出的
    // WorkerExitedError 穿透 inbox.flush、条目 unshift 回队首，砸给 sendToWorker 的
    // 调用方——这里会 reject。修复后应当无感 resolve。
    await expect(send).resolves.toBeUndefined()

    // 已终态的新主线不该被无谓地 sendInput 一次（对失败必然发生的调用做了跳过判断）。
    expect(target.sendInputCalls).toHaveLength(0)
    // 而是被当作接续的新源头，走 revive。
    expect(target.resumeCalls).toHaveLength(1)
    expect(target.resumeCalls[0].prev).toEqual({
      worker_id: worker.worker_id,
      seq: 1,
      session_ref: newMainline.session_ref,
    })
    expect(target.resumeCalls[0].wakeInput).toBe('并发终态竞态')

    const after = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    expect(after.incarnations).toHaveLength(3)
    const finalMainline = after.incarnations[after.incarnations.length - 1]
    expect(finalMainline.impl).toBe('codex')
    expect(finalMainline.state).toBe('running')

    // 消息没有滞留：没有产生 dead-letter。
    const deadLetterEvents = events.filter(
      (e) => e.kind === 'state_changed' && (e.detail as Record<string, unknown> | undefined)?.kind === 'dead_letter'
    )
    expect(deadLetterEvents).toHaveLength(0)
  })

  it('新主线仍存活（台账未落终态）但 adapter.sendInput 权威地抛 WorkerExitedError：同样转入接续，不砸向调用方', async () => {
    const { harness, adaptersMap } = await makeHarness()
    let releaseGate!: (err: Error) => void
    const gate = new Promise<void>((_resolve, reject) => {
      releaseGate = (err) => reject(err)
    })
    const source = new FakeAdapter({
      implId: 'claude-code',
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: async () => {
        await gate
      },
    })
    const target = new FakeAdapter({
      implId: 'codex',
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      // 台账里新主线仍是 running（没有触发过任何状态回调），但 adapter 自己权威地判定
      // 化身已经不在了——修复前，补送分支对这次 sendInput 抛出的 WorkerExitedError 不做
      // 任何捕获，原样穿透。
      sendInputBehavior: (h) => {
        throw new WorkerExitedError(h.worker_id, h.seq)
      },
    })
    adaptersMap.set('claude-code', source)
    adaptersMap.set('codex', target)

    const worker = await harness.spawnWorker(spawnParams({ impl: 'claude-code' }))
    events.length = 0

    const send = harness.sendToWorker(worker.worker_id, '权威抛错场景', { raw: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(source.sendInputCalls).toHaveLength(1)

    await harness.switchWorkerImpl(worker.worker_id, 'codex', '并发切换')
    const afterSwitch = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    const newMainline = afterSwitch.incarnations[afterSwitch.incarnations.length - 1]
    expect(newMainline.impl).toBe('codex')
    expect(newMainline.seq).toBe(1)
    expect(newMainline.state).toBe('running') // 台账未落终态，与上一条用例的区别所在

    releaseGate(new WorkerExitedError(worker.worker_id, 1))

    // 核心断言：修复前会 reject（补送分支的 sendInput 抛错未被捕获）。
    await expect(send).resolves.toBeUndefined()

    // 确实尝试过一次对新主线的正常投递，才发现它已经不在了。
    expect(target.sendInputCalls).toHaveLength(1)
    // 随后转入接续，以这个新主线为源头 revive。
    expect(target.resumeCalls).toHaveLength(1)
    expect(target.resumeCalls[0].prev).toEqual({
      worker_id: worker.worker_id,
      seq: 1,
      session_ref: newMainline.session_ref,
    })
    expect(target.resumeCalls[0].wakeInput).toBe('权威抛错场景')

    const after = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    expect(after.incarnations).toHaveLength(3)
    // codex#1 被 revive 之前的补写收尾成终态（reviveIncarnation 既有逻辑：台账态未追上
    // adapter 真实状态时先回填）。这里的 'completed' 是**兜底缺省**：上面 releaseGate 抛的
    // WorkerExitedError 不带 ended_reason，回填拿不到真值。带得出真值的场景另有专门用例。
    const codexFirst = after.incarnations.find((i) => i.impl === 'codex' && i.state === 'exited')!
    expect(codexFirst.ended_reason).toBe('completed')
    const finalMainline = after.incarnations[after.incarnations.length - 1]
    expect(finalMainline.impl).toBe('codex')
    expect(finalMainline.state).toBe('running')

    const deadLetterEvents = events.filter(
      (e) => e.kind === 'state_changed' && (e.detail as Record<string, unknown> | undefined)?.kind === 'dead_letter'
    )
    expect(deadLetterEvents).toHaveLength(0)
  })
})

describe('WorkerHarness.switchWorkerImpl — 终审 PoC 回归：M3 cancelled 是唯一硬拒绝，不得复活', () => {
  it('对已 cancelled 的 worker 调 switchWorkerImpl → 抛 TaskCancelledError，不 provision/不 spawn，task 仍是 cancelled', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const source = new FakeAdapter({ implId: 'claude-code', caps: { revive: false } })
    const target = new FakeAdapter({ implId: 'codex', caps: { revive: false } })
    adaptersMap.set('claude-code', source)
    adaptersMap.set('codex', target)

    const worker = await harness.spawnWorker(spawnParams({ impl: 'claude-code' }))
    await harness.killWorker(worker.worker_id, '用户明确终止')

    const beforeSwitch = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    expect(beforeSwitch.task.status).toBe('cancelled')
    events.length = 0

    // 主线化身已 exited（killed）→ handoffIncarnation 会跳过 kill 段，直接 provision+spawn
    // 新化身，reopenTaskForContinuation 命中终态走 reviveTask——task 会被无声复活成
    // running。这与 sendToWorker/continueTerminalWorker 已有的 cancelled 短路（§5.5"唯一
    // 硬拒绝"）不一致：用户明确要求终止的任务不应该被跨实现切换复活。
    await expect(harness.switchWorkerImpl(worker.worker_id, 'codex', '试图复活')).rejects.toThrow(TaskCancelledError)

    // 没有触碰目标实现：不 provision、不 spawn。
    expect(target.provisionCalls).toHaveLength(0)
    expect(target.spawnCalls).toHaveLength(0)

    // 台账原样：task 仍 cancelled，没有多出新化身。
    const after = (await harness.listWorkers(dialogObjectIdForPrivate('friend-1')))[0]
    expect(after.task.status).toBe('cancelled')
    expect(after.incarnations).toHaveLength(1)

    // 没有产生 handoff_started / superseded / spawned 事件——pre-flight 在写 HANDOFF.md 和
    // kill 旧化身之前就已经拒绝。
    expect(events.filter((e) => e.kind === 'handoff_started')).toHaveLength(0)
    expect(events.filter((e) => e.kind === 'spawned')).toHaveLength(0)
  })
})

// ---- 三轮 review PoC 回归：handoff 目标是该 worker 已用过的 impl（含切回原实现、同实现
// 切换）必然在真实 adapter 上撞上"already spawned"守卫（三个 adapter 的 spawn 都硬编码
// seq=1，kill 不清除这道守卫记忆），重蹈 pre-flight 本该防住的"旧的没了、新的没建成"死结。
// FakeAdapter 默认没有这道守卫（spawnCalls 可以无限次成功），必须显式配 spawnBehavior 复刻
// 真实 adapter 的行为，测试才能真实复现死结，而不是被 FakeAdapter 的宽松行为掩盖。----

/**
 * 复刻真实 adapter（cc/codex/builtin）spawn 硬编码 seq=1 + "already spawned" 守卫的
 * spawnBehavior：同一 (impl, worker_id) 第二次调用 spawn 必然抛错，且 kill 不会清除这道
 * 记忆（`spawnedOnce` 是模块外部传入、跨越 kill 持续存在的状态，对齐真实 adapter 里
 * runtimes/builtinConfigs 不因 kill 被删除条目的事实）。
 */
function guardedSpawnBehavior(implLabel: string, spawnedOnce: Set<string>, impl: WorkerImplId) {
  return (spec: SpawnSpec): IncarnationHandle => {
    const key = `${impl}:${spec.worker_id}`
    if (spawnedOnce.has(key)) {
      throw new Error(`FakeAdapter(${implLabel}).spawn: worker_id ${spec.worker_id} already spawned in this process`)
    }
    spawnedOnce.add(key)
    return { worker_id: spec.worker_id, seq: 1, impl, session_ref: `ref-${spec.worker_id}#1` }
  }
}

describe('WorkerHarness — 三轮 review PoC 回归：handoff 目标是该 worker 已用过的 impl（含切回原实现、同实现切换）', () => {
  it('switchWorkerImpl 切回曾经用过的实现（cc → codex → cc）→ 抛 ImplAlreadyUsedError；源化身（当前主线 codex#1）状态未变、HANDOFF.md 未被再次追加、目标（cc）adapter 无新增 provision/spawn 调用', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const spawnedOnce = new Set<string>()
    const cc = new FakeAdapter({
      implId: 'claude-code',
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      spawnBehavior: guardedSpawnBehavior('claude-code', spawnedOnce, 'claude-code'),
    })
    const codex = new FakeAdapter({
      implId: 'codex',
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      spawnBehavior: guardedSpawnBehavior('codex', spawnedOnce, 'codex'),
    })
    adaptersMap.set('claude-code', cc)
    adaptersMap.set('codex', codex)

    const worker = await harness.spawnWorker(spawnParams({ impl: 'claude-code' }))
    const workspaceRoot = worker.incarnations[0].workspace

    // 第一次切换：cc → codex，单向切换不撞上这个守卫，正常完成。
    await harness.switchWorkerImpl(worker.worker_id, 'codex', '切到 codex')
    expect(codex.spawnCalls).toHaveLength(1)
    expect(cc.spawnCalls).toHaveLength(1) // 只有最初 spawnWorker 那一次

    const handoffBefore = await fs.readFile(join(workspaceRoot, 'HANDOFF.md'), 'utf-8')
    events.length = 0

    // 第二次切换：切回 claude-code（曾经用过的实现）。修复前会走到 handoffIncarnation
    // step 2（kill 当前主线 codex#1、标 superseded）之后，step 3 的 cc.spawn 撞上
    // guardedSpawnBehavior 的"already spawned"守卫抛错——此时 codex#1 已经被 kill，
    // 新化身建不成，worker 卡进死结。修复后 pre-flight 在 kill 之前就已经拒绝。
    await expect(harness.switchWorkerImpl(worker.worker_id, 'claude-code', '切回 cc')).rejects.toThrow(
      ImplAlreadyUsedError
    )

    // 目标（claude-code）没有新增 provision/spawn 调用——仍然只有最初 spawnWorker 那一次。
    expect(cc.spawnCalls).toHaveLength(1)
    expect(cc.provisionCalls).toHaveLength(1)

    // 源化身（当前主线 codex#1）状态未变：没有被 kill，没有被标 superseded——这正是死结
    // 场景里会被破坏的不变量。
    expect(codex.killCalls).toHaveLength(0)
    const [after] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    const mainlineAfter = after.incarnations[after.incarnations.length - 1]
    expect(mainlineAfter.impl).toBe('codex')
    expect(mainlineAfter.seq).toBe(1)
    expect(mainlineAfter.state).toBe('running')
    expect(mainlineAfter.ended_reason).toBeUndefined()
    expect(after.incarnations).toHaveLength(2) // 没有多出第三条化身

    // HANDOFF.md 未被再次追加。
    const handoffAfter = await fs.readFile(join(workspaceRoot, 'HANDOFF.md'), 'utf-8')
    expect(handoffAfter).toBe(handoffBefore)

    // 没有产生新的 handoff_started / superseded 事件——pre-flight 在写 HANDOFF.md 和 kill
    // 源化身之前就已经拒绝。
    expect(events.filter((e) => e.kind === 'handoff_started')).toHaveLength(0)
    expect(events.filter((e) => e.kind === 'superseded')).toHaveLength(0)
  })

  it('switchWorkerImpl 切到当前正在用的同一个 impl（未曾切换过）→ 同样被 ImplAlreadyUsedError 拒绝，源化身原样存活', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const spawnedOnce = new Set<string>()
    const cc = new FakeAdapter({
      implId: 'claude-code',
      caps: { revive: true },
      onStateChange: harness.handleStateChange,
      spawnBehavior: guardedSpawnBehavior('claude-code', spawnedOnce, 'claude-code'),
    })
    adaptersMap.set('claude-code', cc)

    const worker = await harness.spawnWorker(spawnParams({ impl: 'claude-code' }))
    const workspaceRoot = worker.incarnations[0].workspace
    events.length = 0

    await expect(harness.switchWorkerImpl(worker.worker_id, 'claude-code', '切到同一个 impl')).rejects.toThrow(
      ImplAlreadyUsedError
    )

    expect(cc.killCalls).toHaveLength(0)
    expect(cc.spawnCalls).toHaveLength(1) // 仍然只有最初 spawnWorker 那一次

    const [after] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(after.incarnations).toHaveLength(1)
    expect(after.incarnations[0].state).toBe('running')
    expect(after.incarnations[0].ended_reason).toBeUndefined()

    await expect(fs.readFile(join(workspaceRoot, 'HANDOFF.md'), 'utf-8')).rejects.toThrow() // 文件未被创建
    expect(events.filter((e) => e.kind === 'handoff_started')).toHaveLength(0)
  })

  it('sendToWorker 触发的自动 handoff（revive:false）在"原 impl 已用过"时改选一个未用过的 impl 并成功', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const spawnedOnce = new Set<string>()
    // mainline 用的实现（revive:false，触发自动 handoff）——它本身就是"已用过"的那个 impl，
    // handoffIncarnation 若沿用它会必然撞上 spawn 守卫。
    const mainlineAdapter = new FakeAdapter({
      implId: 'claude-code',
      caps: { revive: false },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: (h) => {
        throw new WorkerExitedError(h.worker_id, h.seq)
      },
      spawnBehavior: guardedSpawnBehavior('claude-code', spawnedOnce, 'claude-code'),
    })
    // 未用过的目标：defaultImpl（'builtin'，见 makeHarness）本身就还没被这个 worker 用过，
    // pickUnusedImpl 应该直接选中它。
    const builtinTarget = new FakeAdapter({
      implId: 'builtin',
      onStateChange: harness.handleStateChange,
      spawnBehavior: guardedSpawnBehavior('builtin', spawnedOnce, 'builtin'),
    })
    adaptersMap.set('claude-code', mainlineAdapter)
    adaptersMap.set('builtin', builtinTarget)

    const worker = await harness.spawnWorker(spawnParams({ impl: 'claude-code' }))
    events.length = 0

    await expect(harness.sendToWorker(worker.worker_id, '接着做完')).resolves.toBeUndefined()

    // 改选到了未用过的 'builtin'，不是原 impl 'claude-code'。
    expect(builtinTarget.spawnCalls).toHaveLength(1)
    expect(mainlineAdapter.killCalls).toHaveLength(1) // 源化身（claude-code#1）被 kill 标 superseded

    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    const newEntry = w.incarnations[w.incarnations.length - 1]
    expect(newEntry.impl).toBe('builtin')
    expect(newEntry.state).toBe('running')
    expect(w.task.status).toBe('running')
    expect(events.filter((e) => e.kind === 'handoff_started')).toHaveLength(1)
  })

  it('sendToWorker 触发的自动 handoff（revive:false）在所有已注册 impl 都用过时 → 抛 ImplAlreadyUsedError，不动源化身', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const spawnedOnce = new Set<string>()
    // 只注册一个实现（'builtin'，恰好也是 makeHarness 的 defaultImpl），且它就是 mainline
    // 正在用的 impl——除它之外没有任何"未用过"的可选目标，pickUnusedImpl 只能落回
    // defaultImpl（同样已用过），handoffIncarnation 的 pre-flight 统一抛错。
    const mainlineAdapter = new FakeAdapter({
      implId: 'builtin',
      caps: { revive: false },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: (h) => {
        throw new WorkerExitedError(h.worker_id, h.seq)
      },
      spawnBehavior: guardedSpawnBehavior('builtin', spawnedOnce, 'builtin'),
    })
    adaptersMap.set('builtin', mainlineAdapter)

    const worker = await harness.spawnWorker(spawnParams())
    const workspaceRoot = worker.incarnations[0].workspace
    events.length = 0

    // sendToWorker 的契约是"投递永不因状态失败"——continueTerminalWorker 的 cancelled 短路
    // 走 dead-letter 不重新抛出，但 ImplAlreadyUsedError 不是那种"消息可以留到下次重试"的
    // 场景（不是并发窗口、也不是 cancelled），是配置/能力层面的硬失败，原样向上抛给调用方。
    await expect(harness.sendToWorker(worker.worker_id, '接着做完')).rejects.toThrow(ImplAlreadyUsedError)

    // 源化身没有被 kill、没有被标 superseded——pre-flight 在 kill 之前就已经拒绝。
    expect(mainlineAdapter.killCalls).toHaveLength(0)
    const [after] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(after.incarnations).toHaveLength(1)
    expect(after.incarnations[0].state).toBe('running')
    expect(after.incarnations[0].ended_reason).toBeUndefined()

    await expect(fs.readFile(join(workspaceRoot, 'HANDOFF.md'), 'utf-8')).rejects.toThrow() // 文件未被创建
    expect(events.filter((e) => e.kind === 'handoff_started')).toHaveLength(0)
  })
})

/**
 * P5 修复:`HarnessEvent.task_status` —— §5.3 接续路径上的两个 task 级迁移点
 * (reviveIncarnation 的 `resumed`、handoffIncarnation 第 4 步的 `spawned`)。这两处是把
 * **终态 task 拉回 running** 的唯一合法出边(§5.2 接续例外),也正是评审 PoC 里让"读晚一步"
 * 吞掉终态 `completed` 的那次落账;事件自带状态之后,终态与这次复活各发各的,不再互相覆盖。
 * 同一条路径上的纯记录事件(handoff_started / superseded)不动 task.status,一律不带。
 */
describe('HarnessEvent.task_status —— 透明接续的迁移点', () => {
  it('revive:终态化身之上接续 → resumed 带 running(与台账落账值一致)', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter({ caps: { revive: true }, onStateChange: harness.handleStateChange })
    adaptersMap.set('builtin', fake)

    const worker = await harness.spawnWorker(spawnParams())
    fake.emitStateChange({ worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` }, 'exited')
    await waitUntil(async () => {
      const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      return w.task.status === 'completed'
    })
    // 终态那一跳自己也带了状态(processStateChange 主线分支)
    const exitedStateEvent = events.filter((e) => e.kind === 'state_changed').pop()!
    expect(exitedStateEvent.task_status).toBe('completed')
    events.length = 0

    await harness.sendToWorker(worker.worker_id, '还有件事要办')

    const resumed = events.filter((e) => e.kind === 'resumed')
    expect(resumed).toHaveLength(1)
    expect(resumed[0].task_status).toBe('running')
    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.task.status).toBe('running')
  })

  it('handoff:交接产出新化身 → spawned 带 running;handoff_started / superseded 不带', async () => {
    const { harness, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter({
      caps: { revive: false },
      onStateChange: harness.handleStateChange,
      sendInputBehavior: (h) => {
        throw new WorkerExitedError(h.worker_id, h.seq)
      },
    })
    adaptersMap.set('builtin', fake)
    adaptersMap.set('claude-code', new FakeAdapter({ implId: 'claude-code', onStateChange: harness.handleStateChange }))

    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await harness.sendToWorker(worker.worker_id, '接着把剩下的做完')

    const spawned = events.filter((e) => e.kind === 'spawned')
    expect(spawned).toHaveLength(1)
    expect(spawned[0].task_status).toBe('running')

    expect(events.filter((e) => e.kind === 'handoff_started')[0].task_status).toBeUndefined()
    expect(events.filter((e) => e.kind === 'superseded')[0].task_status).toBeUndefined()
  })
})
