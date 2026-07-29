import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WorkerHarness, WorkerNotFoundError, type HarnessDeps, type SpawnWorkerParams } from '../../../src/workers/harness/harness'
import { LedgerStore } from '../../../src/workers/harness/ledger-store'
import { WorkspaceManager } from '../../../src/workers/harness/workspace-manager'
import { dialogObjectIdForPrivate } from '../../../src/workers/harness/ledger-types'
import type { HarnessEvent } from '../../../src/workers/harness/worker-events'
import { WorkerExitedError } from '../../../src/workers/errors'
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

// ---- FakeAdapter：与 Task 7 harness-lifecycle.test.ts 同款可编程桩，本文件独立一份
// （resume/kill/readOutput 需要按接续场景编程，不复用别的测试文件的实现）。----

function handleKey(h: IncarnationHandle): string {
  return `${h.worker_id}#${h.seq}`
}

interface FakeAdapterOpts {
  readonly implId?: WorkerImplId
  readonly caps?: Partial<AdapterCapabilities>
  readonly onStateChange?: (h: IncarnationHandle, state: WorkerContractState) => void
  readonly sendInputBehavior?: (h: IncarnationHandle, text: string, opts?: { raw?: boolean }) => Promise<void> | void
  readonly resumeBehavior?: (prev: IncarnationRef, wakeInput: string) => Promise<IncarnationHandle> | IncarnationHandle
  readonly spawnBehavior?: (spec: SpawnSpec) => Promise<IncarnationHandle> | IncarnationHandle
  readonly outputChunk?: string
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

  /** 测试专用：模拟 adapter 自己触发一次状态回调（镜像真实 adapter 内部调用 deps.onStateChange）。 */
  emitStateChange(h: IncarnationHandle, state: WorkerContractState): void {
    this.states.set(handleKey(h), state)
    this.opts.onStateChange?.(h, state)
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

    const worker = await harness.spawnWorker(spawnParams())
    const workspaceRoot = worker.incarnations[0].workspace
    events.length = 0

    await expect(harness.sendToWorker(worker.worker_id, '接着把剩下的做完')).resolves.toBeUndefined()

    // resume 完全没被调用（revive:false 分支）；handoff 走的是 spawn。
    expect(fake.resumeCalls).toHaveLength(0)
    expect(fake.spawnCalls.length).toBeGreaterThanOrEqual(1)
    const handoffSpawn = fake.spawnCalls[fake.spawnCalls.length - 1]
    expect(handoffSpawn.prompt).toContain('HANDOFF.md')
    expect(handoffSpawn.prompt).toContain('接着把剩下的做完')

    // HANDOFF.md 写入 workspace，含标题、输出尾、上次 outcome 标签。
    const handoffPath = join(workspaceRoot, 'HANDOFF.md')
    const handoffContent = await fs.readFile(handoffPath, 'utf-8')
    expect(handoffContent).toContain('测试任务') // task.title
    expect(handoffContent).toContain('这是执行到一半的输出') // 输出尾
    expect(handoffContent).toMatch(/Previous outcome:/)

    // 旧化身（seq=1）标 superseded：源化身在台账里还非终态时，先 kill 再落 exited(superseded)。
    expect(fake.killCalls).toHaveLength(1)
    expect(fake.killCalls[0].seq).toBe(1)
    const [w] = await harness.listWorkers(dialogObjectIdForPrivate('friend-1'))
    const oldEntry = w.incarnations.find((i) => i.seq === 1)!
    expect(oldEntry.state).toBe('exited')
    expect(oldEntry.ended_reason).toBe('superseded')

    // 新化身入主线链。
    const newEntry = w.incarnations[w.incarnations.length - 1]
    expect(newEntry.forked_from).toBeUndefined()
    expect(newEntry.state).toBe('running')
    expect(w.task.status).toBe('running')

    const handoffEvents = events.filter((e) => e.kind === 'handoff_started')
    expect(handoffEvents).toHaveLength(1)
    expect(handoffEvents[0].seq).toBe(1)
    const supersededEvents = events.filter((e) => e.kind === 'superseded')
    expect(supersededEvents).toHaveLength(1)
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
