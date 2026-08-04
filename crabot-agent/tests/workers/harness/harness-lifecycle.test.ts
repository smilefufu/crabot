import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WorkerHarness, WorkerNotFoundError, TaskCancelledError, type HarnessDeps, type SpawnWorkerParams } from '../../../src/workers/harness/harness'
import { LedgerStore } from '../../../src/workers/harness/ledger-store'
import { WorkspaceManager } from '../../../src/workers/harness/workspace-manager'
import { dialogObjectIdForPrivate } from '../../../src/workers/harness/ledger-types'
import { WorkerEventLog, type HarnessEvent } from '../../../src/workers/harness/worker-events'
import { CapabilityNotSupportedError } from '../../../src/workers/errors'
import type {
  WorkerAdapter,
  WorkerImplId,
  WorkerContractState,
  IncarnationHandle,
  IncarnationRef,
  IncarnationEndReason,
  SpawnSpec,
  Workspace,
  OutputCursor,
  CapabilityBundle,
  AdapterCapabilities,
  DetectResult,
} from '../../../src/workers/types'

// ---- FakeAdapter:实现 WorkerAdapter 契约的可编程桩,不碰 tmux/LLM ----

function handleKey(h: IncarnationHandle): string {
  return `${h.worker_id}#${h.seq}`
}

interface FakeAdapterOpts {
  readonly implId?: WorkerImplId
  readonly caps?: Partial<AdapterCapabilities>
  readonly onStateChange?: (
    h: IncarnationHandle,
    state: WorkerContractState,
    lastText?: string,
    endReason?: IncarnationEndReason,
  ) => void
  readonly spawnShouldFail?: Error
  readonly forkShouldFail?: Error
  readonly sendInputBehavior?: (h: IncarnationHandle, text: string, opts?: { raw?: boolean }) => Promise<void> | void
  /** P4 Task 4 第四轮:严格复刻 ClaudeCodeAdapter.fork()(adapter.ts:452-460)的调用顺序——
   * 在 `return handle` 之前就把化身转到 exited 并**同步**调用 onStateChange。用于回归
   * "fork 落地即已终态"这条竞态(见下面 describe 块)。 */
  readonly forkSyncExitBeforeReturn?: boolean
}

class FakeAdapter implements WorkerAdapter {
  readonly implId: WorkerImplId
  readonly provisionCalls: Array<{ ws: Workspace; caps: CapabilityBundle }> = []
  readonly spawnCalls: SpawnSpec[] = []
  readonly sendInputCalls: Array<{ h: IncarnationHandle; text: string; opts?: { raw?: boolean } }> = []
  readonly killCalls: IncarnationHandle[] = []
  readonly forkCalls: Array<{ prev: IncarnationRef; forkInput: string }> = []
  readonly readOutputCalls: IncarnationHandle[] = []
  private readonly states = new Map<string, WorkerContractState>()
  private nextForkSeq = 2

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
    if (this.opts.spawnShouldFail) throw this.opts.spawnShouldFail
    const handle: IncarnationHandle = { worker_id: spec.worker_id, seq: 1, impl: this.implId, session_ref: `ref-${spec.worker_id}#1` }
    this.states.set(handleKey(handle), 'running')
    return handle
  }

  async resume(_prev: IncarnationRef, _wakeInput: string): Promise<IncarnationHandle> {
    throw new Error('FakeAdapter.resume: not exercised by Task 7 tests')
  }

  async fork(prev: IncarnationRef, forkInput: string): Promise<IncarnationHandle> {
    this.forkCalls.push({ prev, forkInput })
    if (this.opts.forkShouldFail) throw this.opts.forkShouldFail
    const seq = this.nextForkSeq++
    // fork 自己的 session_ref，刻意与 prev.session_ref(父化身/主线的引用)不同，好让
    // 回归测试能验证 harness 没有把父化身的引用错抄给 fork 化身(protocol-agent-v3 §6.1)。
    const handle: IncarnationHandle = { worker_id: prev.worker_id, seq, impl: this.implId, session_ref: `fork-ref-${prev.worker_id}#${seq}` }
    if (this.opts.forkSyncExitBeforeReturn) {
      // 严格复刻 cc adapter 的 fork():在这个同步语句执行到 `return handle` 之前，就已经
      // 把化身状态转到 exited 并调用 onStateChange——AsyncMutex.run 的入队是同步的
      // (harness.ts withLock 注释)，所以 harness.handleStateChange 派生的 processStateChange
      // 对这个 worker_id 的锁请求，必然排在 queryWorker 落账段(第二次 withLock)前面。
      // 第四参对齐 cc adapter 的 fork():它的 transitionExited 拿到的是 `execFileAsync`
      // 成功时的 'completed'(失败走 'crashed'),不是"没有值"。
      this.states.set(handleKey(handle), 'exited')
      this.opts.onStateChange?.(handle, 'exited', undefined, 'completed')
      return handle
    }
    this.states.set(handleKey(handle), 'running')
    return handle
  }

  async sendInput(h: IncarnationHandle, text: string, opts?: { raw?: boolean }): Promise<void> {
    this.sendInputCalls.push({ h, text, opts })
    if (this.opts.sendInputBehavior) await this.opts.sendInputBehavior(h, text, opts)
  }

  async readOutput(h: IncarnationHandle, cursor: OutputCursor): Promise<{ chunk: string; nextCursor: OutputCursor }> {
    this.readOutputCalls.push(h)
    return { chunk: '', nextCursor: cursor }
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

  /** 测试专用:模拟 adapter 自己触发一次状态回调(镜像真实 adapter 内部调用 deps.onStateChange)。
   * `lastText` 对齐真实 adapter 的可选第三参(轮次边界上 worker 最后说的那段话)。
   *
   * `endReason` 对齐真实 adapter 的可选第四参。三个真实 adapter 的 `transitionExited` 形参
   * 本就是**必填**的 `ended_reason`,不存在"退出了却说不出原因"的情况——所以这个桩在
   * `state==='exited'` 时也必须给出一个具体值,缺省取 `'completed'`(化身自然结束、非 kill,
   * 即本文件绝大多数用例的剧本)。需要复现 failed/crashed/killed 的用例显式传第四参。
   * 非 exited 态一律不传:endReason 只在 exited 时有意义(harness 会对此断言)。 */
  emitStateChange(
    h: IncarnationHandle,
    state: WorkerContractState,
    lastText?: string,
    endReason?: IncarnationEndReason,
  ): void {
    this.states.set(handleKey(h), state)
    this.opts.onStateChange?.(h, state, lastText, state === 'exited' ? (endReason ?? 'completed') : undefined)
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

async function makeHarness(fakeOpts: FakeAdapterOpts = {}): Promise<{ harness: WorkerHarness; fake: FakeAdapter; adaptersMap: Map<WorkerImplId, WorkerAdapter>; workersDir: string }> {
  const ledgersDir = join(dataDir, 'ledgers')
  const workspacesRoot = join(dataDir, 'workspaces')
  const workersDir = join(dataDir, 'workers')
  await fs.mkdir(workspacesRoot, { recursive: true })

  const ledger = new LedgerStore(ledgersDir)
  const workspaces = new WorkspaceManager(workspacesRoot)

  // onStateChange 接线契约(见 harness.ts 文件头):先建空壳 Map 传给 harness,harness 构造
  // 完成后再构造 adapter(把 harness.handleStateChange 接进去),最后把 adapter 塞回同一个
  // Map 引用——harness 读取的是同一份底层数据,这一步之后立即可见。
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

  return { harness, fake, adaptersMap, workersDir }
}

function spawnParams(overrides: Partial<SpawnWorkerParams> = {}): SpawnWorkerParams {
  return {
    dialogObjectId: dialogObjectIdForPrivate('friend-1'),
    title: '测试任务',
    prompt: '把活干完',
    origin: { spawned_by_session: 'wechat::sess-1', trigger_type: 'message' },
    report_to: { channel_id: 'wechat', session_id: 'sess-1' },
    ...overrides,
  }
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(join(tmpdir(), 'harness-lifecycle-test-'))
  nowValue = Date.parse('2026-01-01T00:00:00.000Z')
  events.length = 0
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

describe('WorkerHarness.spawnWorker', () => {
  it('全链路成功:worker_id = task.id、台账终态 running、化身 seq=1 running、事件 spawned、onEvent 外发', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())

    expect(worker.worker_id).toMatch(/^w-/)
    expect(worker.task.id).toBe(worker.worker_id)
    expect(worker.task.status).toBe('running')
    expect(worker.incarnations).toHaveLength(1)
    expect(worker.incarnations[0]).toMatchObject({ seq: 1, impl: 'builtin', state: 'running' })
    // adapter.spawn 返回的 handle.session_ref 原子补写进初始化身条目，不再是占位空串
    // (protocol-agent-v3 §6.1，harness 从 handle 直接取真值存台账)。
    expect(worker.incarnations[0].session_ref).toBe(`ref-${worker.worker_id}#1`)

    // provision 在 spawn 之前被调用,且拿到了解析后的 workspace
    expect(fake.provisionCalls).toHaveLength(1)
    expect(fake.spawnCalls).toHaveLength(1)
    expect(fake.spawnCalls[0].worker_id).toBe(worker.worker_id)

    const spawnedEvents = events.filter((e) => e.kind === 'spawned')
    expect(spawnedEvents).toHaveLength(1)
    expect(spawnedEvents[0].worker_id).toBe(worker.worker_id)
    expect(spawnedEvents[0].seq).toBe(1)

    // 台账已落盘且可查
    const listed = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(listed.map((w) => w.worker_id)).toContain(worker.worker_id)
  })

  it('adapter.spawn 失败 → 台账落 failed(经 queued→running→failed)、化身 exited(failed)、事件外发,错误抛给调用方', async () => {
    const boom = new Error('spawn 炸了')
    const { harness } = await makeHarness({ spawnShouldFail: boom })

    await expect(harness.spawnWorker(spawnParams())).rejects.toThrow('spawn 炸了')

    const listed = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(listed).toHaveLength(1)
    const worker = listed[0]
    expect(worker.task.status).toBe('failed')
    expect(worker.task.error).toBe('spawn 炸了')
    expect(worker.incarnations[0].state).toBe('exited')
    expect(worker.incarnations[0].ended_reason).toBe('failed')

    const exitedEvents = events.filter((e) => e.kind === 'exited')
    expect(exitedEvents).toHaveLength(1)
    expect(exitedEvents[0].detail?.reason).toBe('spawn_failed')
  })
})

describe('WorkerHarness.handleStateChange', () => {
  it('状态回调驱动台账 task.status 与化身 state,并经 onEvent 外发', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    fake.emitStateChange({ worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` }, 'idle')

    // handleStateChange 签名对齐 adapter 的同步回调(h, state) => void,内部是 fire-and-forget
    // 的异步台账更新——用轮询等待收敛(与 tests/workers/contract-suite.ts 的 waitForState
    // 同一套路,不是"睡一下猜时序",是"有界轮询直到可观察结果达到预期,超时即失败")。
    await waitUntil(async () => {
      const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      return w.task.status === 'waiting_input'
    })

    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.task.status).toBe('waiting_input')
    expect(w.incarnations[0].state).toBe('idle')

    const stateEvents = events.filter((e) => e.kind === 'state_changed')
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0].detail).toEqual({ to: 'idle' })

    // 化身自然结束(非 kill)→ completed
    fake.emitStateChange({ worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` }, 'exited')
    await waitUntil(async () => {
      const [w2] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      return w2.task.status === 'completed'
    })
    const [w2] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w2.task.status).toBe('completed')
    expect(w2.incarnations[0].ended_reason).toBe('completed')
  })

  // ---- endReason:harness 不再自己猜,一律取 adapter 上报的真值 ----

  it('adapter 上报 endReason=failed → 台账 ended_reason 与 task.status 都落 failed(不再被记成成功)', async () => {
    // 修复前这里硬编码 `endReason = state === 'exited' ? 'completed' : undefined`,adapter
    // 明知的失败真值在 onStateChange 这一跳被整个丢掉。真实剧本:builtin worker 自己调
    // `finish_task(outcome:'failed')`(见 manager-integration.test.ts 的端到端用例)。
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const h = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }
    fake.emitStateChange(h, 'exited', undefined, 'failed')

    await waitUntil(async () => {
      const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      return w.task.status === 'failed'
    })
    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.task.status).toBe('failed')
    expect(w.incarnations[0].ended_reason).toBe('failed')

    // 对外事件带的是提交后的 task.status——manager 的台账块、admin 侧读端点看的都是这一份。
    const stateEvents = events.filter((e) => e.kind === 'state_changed')
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0].task_status).toBe('failed')
  })

  it('adapter 上报 endReason=crashed → 台账落 crashed,task.status=failed', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())

    const h = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }
    fake.emitStateChange(h, 'exited', undefined, 'crashed')

    await waitUntil(async () => {
      const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      return w.task.status === 'failed'
    })
    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.incarnations[0].ended_reason).toBe('crashed')
  })

  it('防守分支:adapter 没给 endReason 却报 exited → 落 failed,不谎报成功', async () => {
    // ⚠️ 这是**防守分支,不是常规路径**。三个真实 adapter 的 transitionExited 形参都是必填的
    // ended_reason,常规路径上 exited 必然带着一个具体值;走到这里只可能是未接线的第四个
    // 实现或测试替身。此时 harness 不替 adapter 编一个原因,原样把 undefined 交给
    // taskStatusFromIncarnation 的既有防守分支(exited + 无原因 ⇒ failed)——宁可记成失败,
    // 也不谎报成功。所以这里直接调 harness.handleStateChange(绕过已经把缺省钉死成
    // 'completed' 的 FakeAdapter),模拟的正是"adapter 什么都不说"。
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())

    harness.handleStateChange(
      { worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` },
      'exited'
    )

    await waitUntil(async () => {
      const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      return w.incarnations[0].state === 'exited'
    })
    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.task.status).toBe('failed')
    expect(w.incarnations[0].ended_reason).toBeUndefined() // 不编造原因
  })

  it('契约断言:state 非 exited 却带了 endReason → handleStateChange 同步抛错,不写台账', async () => {
    // endReason 只在 exited 时有意义。running/idle 带着终止原因进来说明调用方的状态机接错
    // 了线,静默忽略会让台账落进说不清的中间态。抛给 adapter,由它自己的 try/catch 记
    // console.error(观察者异常不中断状态机推进,三个 adapter 都是这么包的)。
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    const h = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }

    expect(() => harness.handleStateChange(h, 'idle', undefined, 'failed')).toThrow(/only meaningful for state 'exited'/)
    expect(() => harness.handleStateChange(h, 'running', undefined, 'completed')).toThrow(/only meaningful for state 'exited'/)

    // 台账没有被这次非法回调改动过。
    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.incarnations[0].state).toBe('running')
    expect(w.incarnations[0].ended_reason).toBeUndefined()
  })

  it('adapter 带上轮次末尾的 text 时,state_changed 事件的 detail 里带上它(manager 醒来即知 worker 说了什么)', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const h = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }
    fake.emitStateChange(h, 'idle', '  调研完成,结论是 X 方案可行。  ')

    await waitUntil(() => events.some((e) => e.kind === 'state_changed'))
    const [ev] = events.filter((e) => e.kind === 'state_changed')
    expect(ev.detail).toEqual({ to: 'idle', text: '调研完成,结论是 X 方案可行。' })
  })

  it('过长的 text 被截断并附标记(周期性进 manager 上下文,必须有上限)', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const long = '啊'.repeat(2600)
    const h = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }
    fake.emitStateChange(h, 'idle', long)

    await waitUntil(() => events.some((e) => e.kind === 'state_changed'))
    const [ev] = events.filter((e) => e.kind === 'state_changed')
    const text = (ev.detail as { text: string }).text
    // 保留头部 2000 字符 + 一段告诉 manager"要全文去 read_worker_output"的标记。
    expect(text.startsWith('啊'.repeat(2000))).toBe(true)
    expect(text).toContain('已截断')
    expect(text).toContain('2600')
    expect(text).toContain('read_worker_output')
    expect(text.length).toBeLessThan(2000 + 100)
  })

  it('adapter 不带 text(cc/codex 的 TUI 字节流刻意不带)时 detail 形状不变,不出现空 text 字段', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const h = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }
    fake.emitStateChange(h, 'idle')
    await waitUntil(() => events.some((e) => e.kind === 'state_changed'))
    expect(events.filter((e) => e.kind === 'state_changed')[0].detail).toEqual({ to: 'idle' })

    // 纯空白同样折成"没有正文",不塞空字段。
    events.length = 0
    fake.emitStateChange(h, 'running', '   \n  ')
    await waitUntil(() => events.some((e) => e.kind === 'state_changed'))
    expect(events.filter((e) => e.kind === 'state_changed')[0].detail).toEqual({ to: 'running' })
  })

  it('已终态 worker 的迟到状态回调被忽略,不覆盖已有终局', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    await harness.killWorker(worker.worker_id)

    fake.emitStateChange({ worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` }, 'idle')

    // 确定性同步屏障(不用 setTimeout 猜时序):emitStateChange 同步触发的
    // handleStateChange 在其调用栈内同步完成了对同一 worker_id 的 per-worker 锁排队
    // (AsyncMutex.run 在第一个 await 之前就把自己接进了队列),所以紧接着对同一
    // worker_id 再发起一次会拿同一把锁的调用,必定排在它之后才执行。这里复用
        // 复用 killWorker 的幂等短路(worker 已是终态,直接 no-op 不产生任何副作用,已由
    // 上面的"幂等"用例单独验证过)作为屏障:等它 resolve,前面排队的状态回调
    // 一定已经跑完。
    await harness.killWorker(worker.worker_id)

    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.task.status).toBe('cancelled')
  })
})

describe('WorkerHarness.sendToWorker', () => {
  it('正常投递:running worker 收到输入,adapter.sendInput 被正确调用,事件 input_sent 外发', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await harness.sendToWorker(worker.worker_id, '继续干活')

    expect(fake.sendInputCalls).toHaveLength(1)
    expect(fake.sendInputCalls[0].h).toEqual({ worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` })
    expect(fake.sendInputCalls[0].text).toBe('继续干活')

    const inputEvents = events.filter((e) => e.kind === 'input_sent')
    expect(inputEvents).toHaveLength(1)
    expect(inputEvents[0].detail?.text_len).toBe('继续干活'.length)
  })

  it('raw 选项透传给 adapter.sendInput', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())

    await harness.sendToWorker(worker.worker_id, '/exit', { raw: true })

    expect(fake.sendInputCalls[0].opts).toEqual({ raw: true })
  })

  it('不存在的 worker_id → WorkerNotFoundError', async () => {
    const { harness } = await makeHarness()
    await expect(harness.sendToWorker('w-does-not-exist', 'hi')).rejects.toThrow(WorkerNotFoundError)
  })

  it('task 已 cancelled → 硬拒绝 TaskCancelledError,不触碰 adapter', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    await harness.killWorker(worker.worker_id)
    fake.sendInputCalls.length = 0

    await expect(harness.sendToWorker(worker.worker_id, '还在吗')).rejects.toThrow(TaskCancelledError)
    expect(fake.sendInputCalls).toHaveLength(0)
  })
})

describe('WorkerHarness.killWorker', () => {
  it('adapter.kill 被调用,台账落 cancelled,化身 exited(killed),事件外发', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await harness.killWorker(worker.worker_id, '用户要求终止')

    expect(fake.killCalls).toHaveLength(1)
    expect(fake.killCalls[0]).toEqual({ worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` })

    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.task.status).toBe('cancelled')
    expect(w.incarnations[0].state).toBe('exited')
    expect(w.incarnations[0].ended_reason).toBe('killed')

    const killedEvents = events.filter((e) => e.kind === 'killed')
    expect(killedEvents).toHaveLength(1)
    expect(killedEvents[0].detail).toEqual({ reason: '用户要求终止' })
  })

  it('幂等:对已 cancelled 的 worker 再次 kill 不报错、不重复调用 adapter.kill、不重复发事件', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    await harness.killWorker(worker.worker_id)
    expect(fake.killCalls).toHaveLength(1)
    events.length = 0

    await expect(harness.killWorker(worker.worker_id)).resolves.toBeUndefined()
    expect(fake.killCalls).toHaveLength(1) // 未被再次调用
    expect(events.filter((e) => e.kind === 'killed')).toHaveLength(0)
  })

  it('不存在的 worker_id → WorkerNotFoundError', async () => {
    const { harness } = await makeHarness()
    await expect(harness.killWorker('w-does-not-exist')).rejects.toThrow(WorkerNotFoundError)
  })
})

describe('WorkerHarness.queryWorker', () => {
  it('capabilities().fork 为 false → 抛 CapabilityNotSupportedError,不调用 adapter.fork,失败落 query_failed 事件(读 events.jsonl 核实)', async () => {
    const { harness, fake, workersDir } = await makeHarness({ caps: { fork: false } })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await expect(harness.queryWorker(worker.worker_id, '侧问一下')).rejects.toThrow(CapabilityNotSupportedError)
    expect(fake.forkCalls).toHaveLength(0)

    // P4 Task 4:失败路径必须留痕(protocol-agent-v3 §10 可观测性),query_worker 是
    // fire-and-forget,appendEvent 是排查失败的唯一出口——直接读 events.jsonl(而不只是
    // 内存里的 onEvent 回调数组)核实真的落了盘。
    const log = new WorkerEventLog(join(workersDir, worker.worker_id))
    const onDisk = await log.readAll()
    const failedOnDisk = onDisk.filter((e) => e.kind === 'query_failed')
    expect(failedOnDisk).toHaveLength(1)
    expect(failedOnDisk[0]).toMatchObject({ seq: 1, detail: { reason: 'capability_not_supported', impl: 'builtin' } })

    const failedEvents = events.filter((e) => e.kind === 'query_failed')
    expect(failedEvents).toHaveLength(1)
    expect(failedEvents[0]).toMatchObject({ seq: 1, detail: { reason: 'capability_not_supported', impl: 'builtin' } })
  })

  it('目标 impl 未注册 adapter → 抛错,失败落 query_failed 事件(reason: no_adapter)', async () => {
    const { harness, fake, adaptersMap } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    adaptersMap.delete(fake.implId)
    events.length = 0

    await expect(harness.queryWorker(worker.worker_id, '侧问一下')).rejects.toThrow(/no adapter registered/)

    const failedEvents = events.filter((e) => e.kind === 'query_failed')
    expect(failedEvents).toHaveLength(1)
    expect(failedEvents[0]).toMatchObject({ seq: 1, detail: { reason: 'no_adapter', impl: 'builtin' } })
  })

  it('worker_id 不存在 → WorkerNotFoundError,失败落 query_failed 事件(没有已知 seq,用 sentinel 0)', async () => {
    const { harness } = await makeHarness({ caps: { fork: true } })
    events.length = 0

    await expect(harness.queryWorker('w-does-not-exist', '侧问一下')).rejects.toThrow(WorkerNotFoundError)

    const failedEvents = events.filter((e) => e.kind === 'query_failed')
    expect(failedEvents).toHaveLength(1)
    expect(failedEvents[0]).toMatchObject({ seq: 0, worker_id: 'w-does-not-exist', detail: { reason: 'worker_not_found' } })
  })

  it('adapter.fork 抛错 → 原样把错误抛给调用方,且失败落 query_failed 事件(reason: fork_failed,带 message)', async () => {
    const boom = new Error('fork 侧的 claude -p 炸了')
    const { harness } = await makeHarness({ caps: { fork: true }, forkShouldFail: boom })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await expect(harness.queryWorker(worker.worker_id, '侧问一下')).rejects.toThrow('fork 侧的 claude -p 炸了')

    const failedEvents = events.filter((e) => e.kind === 'query_failed')
    expect(failedEvents).toHaveLength(1)
    expect(failedEvents[0]).toMatchObject({ seq: 1, detail: { reason: 'fork_failed', message: 'fork 侧的 claude -p 炸了' } })

    // 主线台账完全不受 fork 失败影响(fork 从未落账,不该有半成品化身)。
    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.incarnations).toHaveLength(1)
    expect(w.task.status).toBe('running')
  })

  it('capabilities().fork 为 true → adapter.fork 被调用,新化身入化身链,事件外发,主线 task.status 不受影响', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const result = await harness.queryWorker(worker.worker_id, '侧问一下')

    expect(result.forkSeq).toBe(2)
    expect(fake.forkCalls).toHaveLength(1)
    expect(fake.forkCalls[0].forkInput).toBe('侧问一下')

    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.incarnations).toHaveLength(2)
    expect(w.incarnations[1]).toMatchObject({ seq: 2, impl: 'builtin', state: 'running' })
    expect(w.task.status).toBe('running') // fork 不影响主线状态

    // forked_from 标记它不在主线化身链上(protocol-agent-v3 §3);session_ref 取
    // adapter.fork 返回的 handle 自己的引用,不是从主线(seq=1)照抄的(§6.1)。
    expect(w.incarnations[1].forked_from).toBe(1)
    expect(w.incarnations[1].session_ref).not.toBe(w.incarnations[0].session_ref)

    const stateEvents = events.filter((e) => e.kind === 'state_changed')
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0].seq).toBe(2)
    expect(stateEvents[0].detail).toEqual({ kind: 'fork', from_seq: 1 })
  })

  // ---- P4 Task 4 第四轮:fork 落地即已终态的回调竞态(复审 PoC)----
  //
  // ClaudeCodeAdapter.fork()(adapter.ts:452-460)在 `return handle` 之前就
  // `await this.transitionExited(...)`，后者同步调用 `onStateChange` → harness.handleStateChange
  // → processStateChange → `await withLock(...)`。AsyncMutex.run 的入队在第一次 await 之前就
  // 同步完成(async-mutex.ts)，所以这次入队必然发生在 fork() 返回、queryWorker 才去拿"落账段"
  // 那把锁(lock2)之前——processStateChange 100% 先于 lock2 执行。此时台账里还没有这条 fork
  // 化身，`findIncarnation` 返回 undefined，命中 harness.ts `if (!target) return` 被永久丢弃：
  // ①fork 化身在台账里被硬编码成 'running'，永远等不到第二次回调来修正；②manager 收不到
  // "侧问答案就绪"的唤醒事件，query_worker 这个工具形同虚设(protocol-agent-v3 §4.1)。
  //
  // 用 forkSyncExitBeforeReturn 严格复刻这个调用顺序，断言修复后：①fork 化身落账即是
  // 'exited' 终态，不是卡死的 'running'；②有一条"侧问已结束"的事件被补发；③主线台账不受
  // 污染。
  it('fork 化身在 adapter.fork() 返回前就已经同步转 exited(cc 真机顺序)→ 落账即终态,且补发结束事件', async () => {
    const { harness, fake, workersDir } = await makeHarness({ caps: { fork: true }, forkSyncExitBeforeReturn: true })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const result = await harness.queryWorker(worker.worker_id, '侧问一下')
    expect(result.forkSeq).toBe(2)

    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    const forkEntry = w.incarnations.find((i) => i.seq === 2)!
    // 断言①:fork 化身不是硬编码的 'running'，而是 adapter 的真实状态(exited)。
    expect(forkEntry.state).toBe('exited')
    expect(forkEntry.ended_reason).toBeDefined()
    expect(forkEntry.ended_at).toBeDefined()

    // 断言②:processStateChange 因 `!target` 丢弃的那次回调，其"侧问已结束"的语义必须被
    // lock2 补发出来——不能因为落账段没有专门的唤醒事件就让 manager 永远收不到通知。读盘
    // 而不只读内存 onEvent 数组，与本文件其它"失败留痕"用例同一纪律。
    const log = new WorkerEventLog(join(workersDir, worker.worker_id))
    const onDisk = await log.readAll()
    const forkSeqEvents = onDisk.filter((e) => e.seq === 2)
    expect(forkSeqEvents.some((e) => e.kind === 'exited')).toBe(true)
    // 不能重复:processStateChange 正常路径本该发的是 kind:'state_changed'、detail:{to:'exited'}——
    // 那次回调已经被 `!target` 吞掉，不会再触发第二次 appendEvent，所以不应该出现这个形状的
    // 事件(与 lock2 无条件都会发的 `state_changed{kind:'fork', from_seq}` 落账事件是两码事，
    // 那条不受本次竞态影响，始终存在)。
    expect(forkSeqEvents.some((e) => e.kind === 'state_changed' && (e.detail as { to?: string } | undefined)?.to === 'exited')).toBe(false)

    // 断言③:主线(seq=1)台账完全不受这条竞态影响。
    const mainEntry = w.incarnations.find((i) => i.seq === 1)!
    expect(mainEntry.state).toBe('running')
    expect(w.task.status).toBe('running')
    expect(fake.forkCalls).toHaveLength(1)
  })
})

// ---- P4 Task 4:adapter.fork 挪出 per-worker 锁(review 实证 A)----
//
// 修复前:queryWorker 在 `await adapter.fork()` 期间一直持有该 worker 的 per-worker
// AsyncMutex(fork 落在锁内)。cc 的 fork() 是 `await execFileAsync` 整个无头 `claude -p`
// 子进程跑完(几十秒到数分钟),期间对同一 worker_id 的 kill_worker/send_to_worker/再次
// query_worker 全部在这把锁上排队——人类说"停下"要卡几分钟才生效,违反
// protocol-agent-v3 §4.1"manager 的 loop 内不存在阻塞等待原语"的精神。下面两个用例用一个
// fork 永不 resolve 的 FakeAdapter 复现并验证修复:发起 query_worker 后立即对同一 worker
// 调 kill_worker / send_to_worker,断言它们毫秒级完成(修复前会挂住,直到手动 releaseFork
// 或测试超时)。
describe('WorkerHarness.queryWorker — adapter.fork 挪出锁(P4 Task 4 review 实证 A)', () => {
  /** 用一个"进入后先报告、再等外部 gate 放行"的 fork 替身包住 fake.fork,保证断言发生在
   * adapter.fork 真正开始执行(即第一段判定锁已经释放)之后,不靠 setTimeout 猜时序。 */
  function gateFork(fake: FakeAdapter): { forkEnteredPromise: Promise<void>; release: () => void } {
    let resolveEntered!: () => void
    const forkEnteredPromise = new Promise<void>((resolve) => {
      resolveEntered = resolve
    })
    let release!: () => void
    const forkGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalFork = fake.fork.bind(fake)
    fake.fork = async (prev, forkInput) => {
      resolveEntered()
      await forkGate
      return originalFork(prev, forkInput)
    }
    return { forkEnteredPromise, release }
  }

  it('adapter.fork 卡住未落地期间,同一 worker 上的 send_to_worker 毫秒级完成,不排队等待 fork', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    const { forkEnteredPromise, release } = gateFork(fake)

    const queryPromise = harness.queryWorker(worker.worker_id, '侧问一下')
    await forkEnteredPromise // 确认已经进了 adapter.fork——第一段判定锁必然已经释放

    const start = Date.now()
    await harness.sendToWorker(worker.worker_id, '继续干活')
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(200)
    expect(fake.sendInputCalls).toHaveLength(1)
    expect(fake.sendInputCalls[0].h.seq).toBe(1) // 打在主线,不受进行中的 fork 影响

    release()
    await queryPromise
  })

  it('adapter.fork 卡住未落地期间,同一 worker 上的 kill_worker 毫秒级完成,不排队等待 fork', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    const { forkEnteredPromise, release } = gateFork(fake)

    const queryPromise = harness.queryWorker(worker.worker_id, '侧问一下')
    await forkEnteredPromise

    const start = Date.now()
    await harness.killWorker(worker.worker_id, '人类紧急叫停')
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(200)
    expect(fake.killCalls).toHaveLength(1)
    expect(fake.killCalls[0].seq).toBe(1)

    release()
    await queryPromise.catch(() => {}) // 见下一个 describe:worker 已终态后 fork 落地的语义
  })

  it('锁释放期间 worker 被 kill(task 已 cancelled)→ fork 落地后仍记录该 fork 化身(它确实跑过、有输出),但不改主线已终态的记录', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    const { forkEnteredPromise, release } = gateFork(fake)

    const queryPromise = harness.queryWorker(worker.worker_id, '侧问一下')
    await forkEnteredPromise

    await harness.killWorker(worker.worker_id, '在侧问落地前叫停')
    events.length = 0
    release()

    // 选定语义:worker 已终态时仍记录 fork 化身,queryWorker 本身正常 resolve(fork 是一次
    // 真实执行完的动作,不因主线在它进行期间被 kill 而凭空丢弃——见 harness.ts queryWorker
    // 方法注释"锁释放期间世界会变"一节)。
    const result = await queryPromise
    expect(result.forkSeq).toBe(2)

    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    // 主线(seq=1)保持 killWorker 落定的记录,完全不被这次迟到的 fork 落账污染。
    expect(w.task.status).toBe('cancelled')
    const mainEntry = w.incarnations.find((i) => i.seq === 1)!
    expect(mainEntry.state).toBe('exited')
    expect(mainEntry.ended_reason).toBe('killed')

    // fork 化身仍然被追加进化身链,forked_from 指向发起侧问那一刻的源 seq(1),不受主线
    // 后续变化影响。
    const forkEntry = w.incarnations.find((i) => i.seq === 2)!
    expect(forkEntry.forked_from).toBe(1)
    expect(forkEntry.state).toBe('running')

    const stateEvents = events.filter((e) => e.kind === 'state_changed')
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0].seq).toBe(2)
    expect(stateEvents[0].detail).toEqual({ kind: 'fork', from_seq: 1 })
  })
})

describe('WorkerHarness 锁纪律', () => {
  it('spawnWorker 持锁期间(adapter.spawn 卡住未返回),并发 sendToWorker 的"读台账+入信箱"临界区必须排队等待,不能在半注册态下抢跑', async () => {
    let releaseSpawn!: () => void
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })
    const { harness, fake } = await makeHarness()
    // 用 deferred 卡住 adapter.spawn,模拟"provision/spawn 慢调用占着锁"这个真实场景,
    // 不靠 setTimeout 猜时序——spawnGate 不 release,fake.spawn 就永远卡在这一行。
    const originalSpawn = fake.spawn.bind(fake)
    fake.spawn = async (spec: SpawnSpec) => {
      await spawnGate
      return originalSpawn(spec)
    }

    const spawnPromise = harness.spawnWorker(spawnParams())

    // 初始台账写入(status='queued')发生在 provision/spawn 之前、拿锁之后,所以能很快
    // 从台账里读到 worker_id——用有界轮询发现它(不是猜测完成时机,只是等这一次已知会
    // 发生的早期写入落盘)。
    let workerId: string | undefined
    await waitUntil(async () => {
      const list = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      if (list.length > 0) {
        workerId = list[0].worker_id
        return true
      }
      return false
    })

    let sendResolved = false
    const sendPromise = harness.sendToWorker(workerId!, '并发消息').then(() => {
      sendResolved = true
    })

    // spawnWorker 仍持有该 worker_id 的锁(卡在 adapter.spawn 里),sendToWorker 的
    // "读台账 → 判断 cancelled → 入信箱"临界区必须排在后面,不能抢先执行。
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sendResolved).toBe(false)
    expect(fake.sendInputCalls).toHaveLength(0)

    releaseSpawn()
    await spawnPromise
    await sendPromise

    expect(sendResolved).toBe(true)
    expect(fake.sendInputCalls).toHaveLength(1)
    expect(fake.sendInputCalls[0].text).toBe('并发消息')
  })
})

describe('WorkerHarness — fork 不劫持主线(protocol-agent-v3 §5.3 回归)', () => {
  it('queryWorker fork 之后,sendToWorker/readWorkerOutput/killWorker 仍作用于主线化身(seq=1),不被 fork(seq=2)顶替', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const { forkSeq } = await harness.queryWorker(worker.worker_id, '侧问一下')
    expect(forkSeq).toBe(2)

    // 修复前:lastIncarnation() 取数组最后一个,fork 之后就是 seq=2 的侧问分支——
    // sendToWorker/killWorker/readWorkerOutput 全部会错误地 target 到它,主线失联。
    await harness.sendToWorker(worker.worker_id, '继续干活')
    expect(fake.sendInputCalls).toHaveLength(1)
    expect(fake.sendInputCalls[0].h.seq).toBe(1)

    await harness.readWorkerOutput(worker.worker_id, { offset: 0 })
    expect(fake.readOutputCalls).toHaveLength(1)
    expect(fake.readOutputCalls[0].seq).toBe(1)

    await harness.killWorker(worker.worker_id, '测试终止')
    expect(fake.killCalls).toHaveLength(1)
    expect(fake.killCalls[0].seq).toBe(1)

    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.task.status).toBe('cancelled') // 主线被正确终结,不是台账显示 fork 被 kill 而主线孤儿
    const mainEntry = w.incarnations.find((i) => i.seq === 1)!
    expect(mainEntry.state).toBe('exited')
    expect(mainEntry.ended_reason).toBe('killed')
    // fork 化身条目不受主线 kill 动作影响(kill 只调用了 adapter.kill 一次,且 target 是 seq=1)。
    const forkEntry = w.incarnations.find((i) => i.seq === 2)!
    expect(forkEntry.state).toBe('running')
  })

  it('processStateChange:fork 化身(seq=2)自己的状态变化只更新它自己的化身条目,不推进主线 task.status', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    await harness.queryWorker(worker.worker_id, '侧问一下')
    events.length = 0

    // fork 化身自然结束(如 builtin 的 runForkBurst 跑完侧问),不是 harness.killWorker 触发。
    fake.emitStateChange({ worker_id: worker.worker_id, seq: 2, impl: 'builtin', session_ref: 'fork-ref' }, 'exited')

    await waitUntil(async () => {
      const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      return w.incarnations.find((i) => i.seq === 2)?.state === 'exited'
    })

    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    // 主线(seq=1)完全不受 fork 结束的影响——修复前 lastIncarnation() 会把这次回调当成
    // "当前化身"的回调,错误地把 task.status 推进到 completed。
    expect(w.task.status).toBe('running')
    const mainEntry = w.incarnations.find((i) => i.seq === 1)!
    expect(mainEntry.state).toBe('running')

    const forkEntry = w.incarnations.find((i) => i.seq === 2)!
    expect(forkEntry.state).toBe('exited')
    expect(forkEntry.ended_reason).toBe('completed')

    const stateEvents = events.filter((e) => e.kind === 'state_changed' && e.seq === 2)
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0].detail).toEqual({ to: 'exited' })
  })
})

describe('WorkerHarness.readWorkerOutput', () => {
  it('正常路径:透传 adapter.readOutput 的结果', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())

    const result = await harness.readWorkerOutput(worker.worker_id, { offset: 0 })

    expect(result).toEqual({ chunk: '', nextCursor: { offset: 0 } })
    expect(fake.readOutputCalls).toHaveLength(1)
    expect(fake.readOutputCalls[0]).toEqual({ worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` })
  })

  it('不存在的 worker_id → WorkerNotFoundError', async () => {
    const { harness } = await makeHarness()
    await expect(harness.readWorkerOutput('w-does-not-exist', { offset: 0 })).rejects.toThrow(WorkerNotFoundError)
  })

  it('化身实现没有注册对应 adapter → 抛错,不静默返回空结果', async () => {
    const { harness, fake, adaptersMap } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    adaptersMap.delete(fake.implId)

    await expect(harness.readWorkerOutput(worker.worker_id, { offset: 0 })).rejects.toThrow(/no adapter registered/)
  })

  // ---- P4 Task 4:opts.seq 读指定化身(query_worker fork 分支的答案) ----

  it('给 opts.seq → 读取该 seq 对应化身(如 fork 分支)的输出,不是主线', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    const { forkSeq } = await harness.queryWorker(worker.worker_id, '侧问一下')

    const result = await harness.readWorkerOutput(worker.worker_id, { offset: 0 }, { seq: forkSeq })

    expect(result).toEqual({ chunk: '', nextCursor: { offset: 0 } })
    expect(fake.readOutputCalls).toHaveLength(1)
    expect(fake.readOutputCalls[0]).toEqual({
      worker_id: worker.worker_id,
      seq: forkSeq,
      impl: 'builtin',
      session_ref: `fork-ref-${worker.worker_id}#${forkSeq}`,
    })
  })

  it('省略 opts(或不传 seq)→ 逐字沿用既有行为,读主线化身,fork 之后也不被顶替', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    await harness.queryWorker(worker.worker_id, '侧问一下')

    await harness.readWorkerOutput(worker.worker_id, { offset: 0 })

    expect(fake.readOutputCalls).toHaveLength(1)
    expect(fake.readOutputCalls[0].seq).toBe(1)
  })

  it('opts.seq 在台账中不存在 → 抛出明确错误,不静默返回空 chunk', async () => {
    const { harness } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())

    await expect(harness.readWorkerOutput(worker.worker_id, { offset: 0 }, { seq: 99 })).rejects.toThrow(/seq/)
  })
})

describe('WorkerHarness.handleStateChange — 同状态重复回调', () => {
  it('重复收到同一状态的回调不抛错、不丢事件、台账状态保持不变', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    // worker 已是 running;再收一次 'running' 回调——taskStatusFromIncarnation 算出的
    // nextStatus 与当前 task.status 相同,VALID_TRANSITIONS 里 running 没有到 running 的
    // 自环边,applyStatusTransition 会抛 InvalidTaskTransitionError。修复前这个错误在
    // handleStateChange 的 fire-and-forget catch 里被静默吞掉,appendEvent 也不会跑,
    // 这次回调的事件凭空丢失。
    fake.emitStateChange({ worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` }, 'running')

    // 用一次已知会走同一把 per-worker 锁的调用作确定性屏障(手法与本文件"已终态 worker
    // 的迟到状态回调被忽略"用例一致):等它 resolve,前面排队的状态回调必定已经跑完。
    await harness.sendToWorker(worker.worker_id, '还在干活')

    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.task.status).toBe('running') // 没有被非法转换破坏,也没有抛出未捕获错误

    const stateEvents = events.filter((e) => e.kind === 'state_changed')
    expect(stateEvents).toHaveLength(1) // 事件仍然被记录,没有跟着错误一起被吞掉
    expect(stateEvents[0].detail).toEqual({ to: 'running' })
  })
})

/**
 * P5 修复:`HarnessEvent.task_status` —— 事件自带"这次迁移落账后的 task 状态"。
 *
 * 分类不变量(见 harness.ts `appendEvent` 注释):**只有真正发生 task 状态迁移的事件点**带这
 * 个字段,化身级/纯记录事件一律不带。下面按分类逐点钉住;剩余的迁移点(resumed / handoff 的
 * spawned / markCrashed 的 exited / reconcile 的 state_changed)在 harness-continuation /
 * harness-recovery 两个文件里由各自的夹具覆盖。
 */
describe('HarnessEvent.task_status —— 事件自带落账后的 task 状态', () => {
  it('迁移点:spawn 成功 → spawned 带 running(与台账落账值一致)', async () => {
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())

    const spawned = events.filter((e) => e.kind === 'spawned')
    expect(spawned).toHaveLength(1)
    expect(spawned[0].task_status).toBe('running')
    expect(spawned[0].task_status).toBe(worker.task.status)
  })

  it('迁移点:spawn 失败 → exited 带 failed(端点正确;中间的 running 无事件,仍折叠)', async () => {
    const { harness } = await makeHarness({ spawnShouldFail: new Error('spawn 炸了') })
    await expect(harness.spawnWorker(spawnParams())).rejects.toThrow('spawn 炸了')

    const exited = events.filter((e) => e.kind === 'exited')
    expect(exited).toHaveLength(1)
    expect(exited[0].task_status).toBe('failed')
  })

  it('迁移点:主线状态回调 → state_changed 带落账后的 waiting_input / completed', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    const handle = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as WorkerImplId, session_ref: `ref-${worker.worker_id}#1` }
    events.length = 0

    fake.emitStateChange(handle, 'idle')
    await waitUntil(async () => events.some((e) => e.kind === 'state_changed'))
    expect(events.filter((e) => e.kind === 'state_changed')[0].task_status).toBe('waiting_input')

    fake.emitStateChange(handle, 'exited')
    await waitUntil(async () => events.filter((e) => e.kind === 'state_changed').length >= 2)
    expect(events.filter((e) => e.kind === 'state_changed')[1].task_status).toBe('completed')
  })

  it('迁移点:killWorker → killed 带 cancelled', async () => {
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await harness.killWorker(worker.worker_id, '用户要求终止')

    const killed = events.filter((e) => e.kind === 'killed')
    expect(killed).toHaveLength(1)
    expect(killed[0].task_status).toBe('cancelled')
  })

  it('非迁移点:input_sent 不带 task_status(投递不动 task 状态)', async () => {
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await harness.sendToWorker(worker.worker_id, '继续干活')

    const inputSent = events.filter((e) => e.kind === 'input_sent')
    expect(inputSent).toHaveLength(1)
    expect(inputSent[0].task_status).toBeUndefined()
  })

  it('非迁移点:kill 后 drain 出的 dead_letter 不带 task_status(kill 的迁移由 killed 事件承载)', async () => {
    const { harness } = await makeHarness({
      // 让第一条卡在投递里,第二条就会留在队列上等 killWorker 去 drain
      sendInputBehavior: () => new Promise((resolve) => setTimeout(resolve, 30)),
    })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const inFlight = harness.sendToWorker(worker.worker_id, '第一条')
    const queued = harness.sendToWorker(worker.worker_id, '第二条').catch(() => undefined)
    await harness.killWorker(worker.worker_id)
    await inFlight.catch(() => undefined)
    await queued

    const deadLetters = events.filter((e) => e.kind === 'state_changed' && e.detail?.kind === 'dead_letter')
    expect(deadLetters.length).toBeGreaterThan(0)
    for (const e of deadLetters) expect(e.task_status).toBeUndefined()
    // 同一次 kill 落的 killed 事件才是那次迁移的载体
    expect(events.filter((e) => e.kind === 'killed')[0].task_status).toBe('cancelled')
  })

  it('非迁移点:query_failed 不带 task_status', async () => {
    const { harness } = await makeHarness({ caps: { fork: false } })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await expect(harness.queryWorker(worker.worker_id, '侧问')).rejects.toThrow(CapabilityNotSupportedError)

    const queryFailed = events.filter((e) => e.kind === 'query_failed')
    expect(queryFailed).toHaveLength(1)
    expect(queryFailed[0].task_status).toBeUndefined()
  })

  it('非迁移点:fork 化身的落账事件不带 task_status(§5.3 fork 不影响主线)', async () => {
    const { harness } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await harness.queryWorker(worker.worker_id, '侧问')

    const forkEvents = events.filter((e) => e.seq === 2)
    expect(forkEvents.length).toBeGreaterThan(0)
    for (const e of forkEvents) expect(e.task_status).toBeUndefined()
    // 台账确实没动主线 task.status——事件不带这个字段与台账事实一致
    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w.task.status).toBe('running')
  })
})

async function waitUntil(cond: () => Promise<boolean>, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitUntil timed out')
}
