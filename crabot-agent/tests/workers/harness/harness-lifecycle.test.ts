import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WorkerHarness, WorkerNotFoundError, TaskCancelledError, type HarnessDeps, type SpawnWorkerParams } from '../../../src/workers/harness/harness'
import { LedgerStore } from '../../../src/workers/harness/ledger-store'
import { WorkspaceManager } from '../../../src/workers/harness/workspace-manager'
import { dialogObjectIdForPrivate } from '../../../src/workers/harness/ledger-types'
import type { HarnessEvent } from '../../../src/workers/harness/worker-events'
import { CapabilityNotSupportedError } from '../../../src/workers/errors'
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
} from '../../../src/workers/types'

// ---- FakeAdapter:实现 WorkerAdapter 契约的可编程桩,不碰 tmux/LLM ----

function handleKey(h: IncarnationHandle): string {
  return `${h.worker_id}#${h.seq}`
}

interface FakeAdapterOpts {
  readonly implId?: WorkerImplId
  readonly caps?: Partial<AdapterCapabilities>
  readonly onStateChange?: (h: IncarnationHandle, state: WorkerContractState) => void
  readonly spawnShouldFail?: Error
  readonly forkShouldFail?: Error
  readonly sendInputBehavior?: (h: IncarnationHandle, text: string, opts?: { raw?: boolean }) => Promise<void> | void
}

class FakeAdapter implements WorkerAdapter {
  readonly implId: WorkerImplId
  readonly provisionCalls: Array<{ ws: Workspace; caps: CapabilityBundle }> = []
  readonly spawnCalls: SpawnSpec[] = []
  readonly sendInputCalls: Array<{ h: IncarnationHandle; text: string; opts?: { raw?: boolean } }> = []
  readonly killCalls: IncarnationHandle[] = []
  readonly forkCalls: Array<{ prev: IncarnationRef; forkInput: string }> = []
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
    const handle: IncarnationHandle = { worker_id: spec.worker_id, seq: 1, impl: this.implId }
    this.states.set(handleKey(handle), 'running')
    return handle
  }

  async resume(_prev: IncarnationRef, _wakeInput: string): Promise<IncarnationHandle> {
    throw new Error('FakeAdapter.resume: not exercised by Task 7 tests')
  }

  async fork(prev: IncarnationRef, forkInput: string): Promise<IncarnationHandle> {
    this.forkCalls.push({ prev, forkInput })
    if (this.opts.forkShouldFail) throw this.opts.forkShouldFail
    const handle: IncarnationHandle = { worker_id: prev.worker_id, seq: this.nextForkSeq++, impl: this.implId }
    this.states.set(handleKey(handle), 'running')
    return handle
  }

  async sendInput(h: IncarnationHandle, text: string, opts?: { raw?: boolean }): Promise<void> {
    this.sendInputCalls.push({ h, text, opts })
    if (this.opts.sendInputBehavior) await this.opts.sendInputBehavior(h, text, opts)
  }

  async readOutput(_h: IncarnationHandle, cursor: OutputCursor): Promise<{ chunk: string; nextCursor: OutputCursor }> {
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

  /** 测试专用:模拟 adapter 自己触发一次状态回调(镜像真实 adapter 内部调用 deps.onStateChange)。 */
  emitStateChange(h: IncarnationHandle, state: WorkerContractState): void {
    this.states.set(handleKey(h), state)
    this.opts.onStateChange?.(h, state)
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

async function makeHarness(fakeOpts: FakeAdapterOpts = {}): Promise<{ harness: WorkerHarness; fake: FakeAdapter; adaptersMap: Map<WorkerImplId, WorkerAdapter> }> {
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

  return { harness, fake, adaptersMap }
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

    fake.emitStateChange({ worker_id: worker.worker_id, seq: 1, impl: 'builtin' }, 'idle')

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
    fake.emitStateChange({ worker_id: worker.worker_id, seq: 1, impl: 'builtin' }, 'exited')
    await waitUntil(async () => {
      const [w2] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
      return w2.task.status === 'completed'
    })
    const [w2] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    expect(w2.task.status).toBe('completed')
    expect(w2.incarnations[0].ended_reason).toBe('completed')
  })

  it('已终态 worker 的迟到状态回调被忽略,不覆盖已有终局', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    await harness.killWorker(worker.worker_id)

    fake.emitStateChange({ worker_id: worker.worker_id, seq: 1, impl: 'builtin' }, 'idle')

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
    expect(fake.sendInputCalls[0].h).toEqual({ worker_id: worker.worker_id, seq: 1, impl: 'builtin' })
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
    expect(fake.killCalls[0]).toEqual({ worker_id: worker.worker_id, seq: 1, impl: 'builtin' })

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
  it('capabilities().fork 为 false → 抛 CapabilityNotSupportedError,不调用 adapter.fork', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: false } })
    const worker = await harness.spawnWorker(spawnParams())

    await expect(harness.queryWorker(worker.worker_id, '侧问一下')).rejects.toThrow(CapabilityNotSupportedError)
    expect(fake.forkCalls).toHaveLength(0)
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

async function waitUntil(cond: () => Promise<boolean>, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitUntil timed out')
}
