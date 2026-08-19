/**
 * 活性巡检(protocol-agent-v3 §6.3 第 3 条 / spec 2026-08-05-worker-liveness-sweep-design.md)。
 *
 * 复现的是近三天四例真实停摆的共同形态:**进程活着、tmux 活着、台账写着 running、但不再产生
 * 任何事件**。三种 adapter 的 `state()` 返回 running 都是 else 兜底,在语义上分不开"卡住"与
 * "在干活",所以这里的判据是可选契约方法 `lastActivityAt` 有没有前进。
 *
 * **cc/codex 双实现对称覆盖**:整个 describe 用 `it.each` 跑两遍(不是只给 cc 写用例),
 * 否则删掉 codex 一侧的 `lastActivityAt` 实现能全绿。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WorkerHarness, type HarnessDeps, type SpawnWorkerParams } from '../../../src/workers/harness/harness'
import { LedgerStore } from '../../../src/workers/harness/ledger-store'
import { WorkspaceManager } from '../../../src/workers/harness/workspace-manager'
import type { HarnessEvent, HarnessEventDelivery } from '../../../src/workers/harness/worker-events'
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

const MINUTE = 60_000
/** 与 harness 的 LIVENESS_STALL_MS 同值;用例用它两侧取点,不重复写死一个魔数。 */
const STALL_MS = 30 * MINUTE

function handleKey(h: { worker_id: string; seq: number }): string {
  return `${h.worker_id}#${h.seq}`
}

/**
 * CLI 形态的 adapter 桩:实现可选契约方法 `lastActivityAt`(真实实现从 meta 与原生会话
 * 记录建立任务进展基线,这里直接由用例摆布返回值),`readOutput` 返回一段可断言的 pane 尾部。
 */
class CliLikeAdapter implements WorkerAdapter {
  readonly implId: WorkerImplId
  /** 每个化身"最近一次可观测活动"的 epoch ms;用例直接改这张表模拟停摆/恢复。 */
  readonly activity = new Map<string, number | undefined>()
  outputTail = '(pane 尾部)'
  lastActivityAtCalls: string[] = []
  readOutputCalls: string[] = []
  private readonly states = new Map<string, WorkerContractState>()

  constructor(implId: WorkerImplId) {
    this.implId = implId
  }

  async detect(): Promise<DetectResult> {
    return { installed: true, activated: true }
  }
  async provision(_ws: Workspace, _caps: CapabilityBundle): Promise<void> {}
  async spawn(spec: SpawnSpec): Promise<IncarnationHandle> {
    const handle: IncarnationHandle = { worker_id: spec.worker_id, seq: 1, impl: this.implId, session_ref: `ref-${spec.worker_id}#1` }
    this.states.set(handleKey(handle), 'running')
    return handle
  }
  async resume(_prev: IncarnationRef, _wakeInput: string): Promise<IncarnationHandle> {
    throw new Error('CliLikeAdapter.resume: 本文件不涉及')
  }
  async fork(_prev: IncarnationRef, _forkInput: string): Promise<IncarnationHandle> {
    throw new Error('CliLikeAdapter.fork: 本文件不涉及')
  }
  async sendInput(_h: IncarnationHandle, _text: string): Promise<void> {}
  async readOutput(h: IncarnationHandle, cursor: OutputCursor): Promise<{ chunk: string; nextCursor: OutputCursor }> {
    this.readOutputCalls.push(handleKey(h))
    return { chunk: this.outputTail, nextCursor: cursor }
  }
  /** 真实 adapter 的三源判定在这四例里全部落在 else 兜底 running——桩照此固定。 */
  async state(h: IncarnationHandle): Promise<WorkerContractState> {
    return this.states.get(handleKey(h)) ?? 'exited'
  }
  async inspectSupervisionActivity(_h: IncarnationHandle, cursor?: { offset: number }) {
    return { kind: 'unknown' as const, next_cursor: cursor ?? { offset: 0 } }
  }
  async lastActivityAt(h: IncarnationHandle): Promise<number | undefined> {
    this.lastActivityAtCalls.push(handleKey(h))
    return this.activity.get(handleKey(h))
  }
  async kill(h: IncarnationHandle): Promise<void> {
    this.states.set(handleKey(h), 'exited')
  }
  capabilities(): AdapterCapabilities {
    return { fork: false, revive: false, goalMode: false, subagent: false, structuredTrace: false }
  }
}

/** 任意未实现可选方法的第三方/未来 adapter 都应被巡检天然跳过,不靠实现 ID 特判。 */
class NoSignalAdapter extends CliLikeAdapter {
  // @ts-expect-error 故意把可选契约方法抹成 undefined,复刻"adapter 没实现这个方法"的形态
  lastActivityAt = undefined
  constructor() {
    super('builtin')
  }
}

// ---- 夹具 ----

let dataDir: string
let clockMs: number
let events: HarnessEvent[]
/** onEvent 的返回值:模拟 manager 侧 episode 是否成功消费了这次唤醒。 */
let deliverConsumed: boolean

function now(): string {
  return new Date(clockMs).toISOString()
}

async function makeHarness(adapter: WorkerAdapter): Promise<{ harness: WorkerHarness; ledger: LedgerStore }> {
  const ledger = new LedgerStore(join(dataDir, 'ledgers'))
  const workspacesRoot = join(dataDir, 'workspaces')
  await fs.mkdir(workspacesRoot, { recursive: true })
  const adaptersMap = new Map<WorkerImplId, WorkerAdapter>([[adapter.implId, adapter]])
  const deps: HarnessDeps = {
    adapters: adaptersMap,
    defaultImpl: adapter.implId,
    ledger,
    workspaces: new WorkspaceManager(workspacesRoot),
    workersDir: join(dataDir, 'workers'),
    now,
    onEvent: (e): HarnessEventDelivery => {
      events.push(e)
      return { consumed: deliverConsumed }
    },
  }
  return { harness: new WorkerHarness(deps), ledger }
}

function spawnParams(overrides: Partial<SpawnWorkerParams> = {}): SpawnWorkerParams {
  return {
    managerKey: (`test::${'friend-1'}` as ManagerKey),
    title: '测试任务',
    prompt: '把活干完',
    origin: { spawned_by_episode: 'wechat::sess-1', trigger_type: 'message' },
    report_to: { channel_id: 'wechat', session_id: 'sess-1' },
    ...overrides,
  }
}

/** 巡检发出的唤醒事件:state_changed + detail.text(#70 同款形状,零新 kind、零新状态)。 */
function wakeEvents(workerId: string): HarnessEvent[] {
  return events.filter(
    (e) => e.worker_id === workerId && e.kind === 'state_changed' && typeof e.detail?.text === 'string',
  )
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(join(tmpdir(), 'harness-liveness-test-'))
  clockMs = Date.parse('2026-08-05T00:00:00.000Z')
  events = []
  deliverConsumed = true
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

describe.each<WorkerImplId>(['claude-code', 'codex'])('WorkerHarness.sweepLiveness(%s)', (impl) => {
  /** spawn 一个 worker 并把它的主线化身活性设成"刚刚动过"。 */
  async function spawnRunning(): Promise<{ harness: WorkerHarness; ledger: LedgerStore; adapter: CliLikeAdapter; workerId: string }> {
    const adapter = new CliLikeAdapter(impl)
    const { harness, ledger } = await makeHarness(adapter)
    const worker = await harness.spawnWorker(spawnParams())
    adapter.activity.set(`${worker.worker_id}#1`, clockMs)
    events = [] // 丢掉 spawned 事件,后续断言只看巡检发的
    return { harness, ledger, adapter, workerId: worker.worker_id }
  }

  it('① 化身存活、state() 报 running、lastActivityAt 长时间不前进 → 发唤醒事件,detail 带 output 尾部', async () => {
    const { harness, adapter, workerId } = await spawnRunning()
    adapter.outputTail = '⏺ 正在读取文件…'

    // 阈值之内:一条事件都不该有(改动前的行为)
    clockMs += STALL_MS - MINUTE
    await harness.sweepLiveness()
    expect(wakeEvents(workerId)).toHaveLength(0)

    // 越过阈值:唤醒
    clockMs += 2 * MINUTE
    await harness.sweepLiveness()

    const woke = wakeEvents(workerId)
    expect(woke).toHaveLength(1)
    expect(woke[0].seq).toBe(1)
    expect(woke[0].detail?.to).toBe('running')
    const text = woke[0].detail?.text as string
    expect(text).toContain('⏺ 正在读取文件…')
    expect(text).toContain('活性巡检')
    expect(text).toContain('没有新的可观察任务活动')
    expect(text).toContain('非 raw 的 send_to_worker')
    expect(text).toContain('空 composer')
    // 合成指引排在 output 尾部**之后**——否则会被 truncateWakeText 的保尾截断吃掉(#70 教训)
    expect(text.indexOf('⏺ 正在读取文件…')).toBeLessThan(text.indexOf('活性巡检'))
    // 零新事件 kind、零新状态
    expect(woke[0].kind).toBe('state_changed')
  })

  it('② lastActivityAt 持续前进(真实任务进展)→ 零事件', async () => {
    const { harness, adapter, workerId } = await spawnRunning()

    // 每次巡检前 worker 都有真实进展;累计远超阈值也不该告警。
    for (let i = 0; i < 10; i++) {
      clockMs += 10 * MINUTE
      adapter.activity.set(`${workerId}#1`, clockMs - MINUTE)
      await harness.sweepLiveness()
    }

    expect(wakeEvents(workerId)).toHaveLength(0)
    // 确实每轮都探过活,不是因为压根没进候选集才没报
    expect(adapter.lastActivityAtCalls.length).toBe(10)
  })

  it('③ 不实现 lastActivityAt 的 adapter 被跳过:零事件、无异常', async () => {
    const adapter = new NoSignalAdapter()
    const { harness } = await makeHarness(adapter)
    const worker = await harness.spawnWorker(spawnParams())
    events = []

    clockMs += 10 * 60 * MINUTE
    await expect(harness.sweepLiveness()).resolves.toBeUndefined()
    expect(wakeEvents(worker.worker_id)).toHaveLength(0)
  })

  it('④ 去重:同一次停摆连跑多轮巡检 → 只唤醒一次', async () => {
    const { harness, workerId } = await spawnRunning()

    clockMs += STALL_MS + MINUTE
    await harness.sweepLiveness()
    for (let i = 0; i < 5; i++) {
      clockMs += 5 * MINUTE
      await harness.sweepLiveness()
    }

    expect(wakeEvents(workerId)).toHaveLength(1)
  })

  it('⑤-① 重报:lastActivityAt 前进后再次停摆 → 可以再报一次', async () => {
    const { harness, adapter, workerId } = await spawnRunning()

    clockMs += STALL_MS + MINUTE
    await harness.sweepLiveness()
    expect(wakeEvents(workerId)).toHaveLength(1)

    // worker 又动起来了 → 清标记
    adapter.activity.set(`${workerId}#1`, clockMs)
    await harness.sweepLiveness()
    expect(wakeEvents(workerId)).toHaveLength(1)

    // 然后再次停摆
    clockMs += STALL_MS + MINUTE
    await harness.sweepLiveness()
    expect(wakeEvents(workerId)).toHaveLength(2)
  })

  it('⑤-② 重试:manager 没消费(consumedEvents !== true)→ 按 1×T→2×T→4×T 退避重试,恢复后收敛', async () => {
    const { harness, workerId } = await spawnRunning()
    deliverConsumed = false // manager 不可用:episode 失败,整批输入被推回 mailbox

    clockMs += STALL_MS + MINUTE
    await harness.sweepLiveness()
    expect(wakeEvents(workerId)).toHaveLength(1)

    // 退避未到:巡检照跑,但**不重试** —— 这正是原来那个 5 分钟节奏的温循环被堵掉的地方
    for (let i = 0; i < 5; i++) {
      clockMs += 5 * MINUTE
      await harness.sweepLiveness()
    }
    expect(wakeEvents(workerId)).toHaveLength(1)

    // 第 1 次退避窗口 = 1×T
    clockMs += STALL_MS
    await harness.sweepLiveness()
    expect(wakeEvents(workerId)).toHaveLength(2)

    // 第 2 次退避窗口 = 2×T:1×T 之后还不到点
    clockMs += STALL_MS + MINUTE
    await harness.sweepLiveness()
    expect(wakeEvents(workerId)).toHaveLength(2)
    clockMs += STALL_MS
    await harness.sweepLiveness()
    expect(wakeEvents(workerId)).toHaveLength(3)

    // 第 3 次退避窗口 = 4×T(封顶):3×T 之后还不到点
    clockMs += 3 * STALL_MS
    await harness.sweepLiveness()
    expect(wakeEvents(workerId)).toHaveLength(3)
    clockMs += STALL_MS + MINUTE
    await harness.sweepLiveness()
    expect(wakeEvents(workerId)).toHaveLength(4)

    // manager 恢复 → 这一次被消费 → 之后再不打扰(封顶窗口过完也不再发)
    deliverConsumed = true
    clockMs += 4 * STALL_MS + MINUTE
    await harness.sweepLiveness()
    expect(wakeEvents(workerId)).toHaveLength(5)
    clockMs += 8 * STALL_MS
    await harness.sweepLiveness()
    expect(wakeEvents(workerId)).toHaveLength(5)
  })

  it('⑤-③ 重试不带正文:只有首报带 pane 现场,后续重试是一行,mailbox 不会堆同一份现场', async () => {
    const { harness, adapter, workerId } = await spawnRunning()
    adapter.outputTail = '⏺ 正在读取文件…'
    deliverConsumed = false

    clockMs += STALL_MS + MINUTE
    await harness.sweepLiveness()
    // 连吃三次退避窗口,拿到 3 次重试
    for (const wait of [STALL_MS, 2 * STALL_MS, 4 * STALL_MS]) {
      clockMs += wait
      await harness.sweepLiveness()
    }

    const woke = wakeEvents(workerId)
    expect(woke).toHaveLength(4)

    const first = woke[0].detail?.text as string
    expect(first).toContain('⏺ 正在读取文件…') // 首报:现场在

    for (const e of woke.slice(1)) {
      const text = e.detail?.text as string
      // 重试:不再重复现场(现场已压在 manager 的 mailbox 里),只有一行
      expect(text).not.toContain('⏺ 正在读取文件…')
      expect(text).toContain('重试投递')
      expect(text.length).toBeLessThan(120)
    }
    // 只在首报那一次读过 pane —— 重试连 readOutput 都不调
    expect(adapter.readOutputCalls).toHaveLength(1)
  })

  it('⑥ 活性巡检不改变 task.status 或主线化身 state', async () => {
    const { harness, ledger, workerId } = await spawnRunning()

    clockMs += STALL_MS + MINUTE
    const before = (await ledger.findWorker(workerId))!.worker
    await harness.sweepLiveness()
    await harness.sweepLiveness()
    const after = (await ledger.findWorker(workerId))!.worker

    expect(wakeEvents(workerId)).toHaveLength(1) // 确认这一轮真的报了(否则断言是空转)
    expect(after.task).toEqual(before.task)
    expect(after.incarnations).toEqual(before.incarnations)
  })

  it('⑦ 只看主线化身:fork 侧问分支零输出不算停摆', async () => {
    const { harness, ledger, adapter, workerId } = await spawnRunning()
    const found = (await ledger.findWorker(workerId))!
    // fork 化身(无头 `claude -p`,整个执行期可能零输出)追加进同一个 incarnations 数组
    await ledger.upsertWorker(found.managerKey, workerId, (prev) => ({
      ...prev!,
      incarnations: [
        ...prev!.incarnations,
        { ...prev!.incarnations[0], seq: 2, session_ref: `fork-ref-${workerId}#2`, forked_from: 1 },
      ],
    }))
    adapter.activity.set(`${workerId}#2`, clockMs) // fork 自己也很久没动(下面时钟一推就超阈值)

    clockMs += STALL_MS + MINUTE
    adapter.activity.set(`${workerId}#1`, clockMs) // 主线刚动过
    await harness.sweepLiveness()

    expect(wakeEvents(workerId)).toHaveLength(0)
    expect(adapter.lastActivityAtCalls).not.toContain(`${workerId}#2`)
  })

  it('停机竞态:stopLivenessSweep 之后再触发对账收尾的 startLivenessSweep → 巡检不启动', async () => {
    const adapter = new CliLikeAdapter(impl)
    const { harness } = await makeHarness(adapter)
    const worker = await harness.spawnWorker(spawnParams())
    adapter.activity.set(`${worker.worker_id}#1`, clockMs)
    events = []

    // 装配层的 `.finally(() => startLivenessSweep())` 挂在**不被 await** 的启动对账链上,
    // onStop 可能赶在它之前跑完 —— 停机之后再补一次 start,必须是 no-op。
    harness.stopLivenessSweep()
    harness.startLivenessSweep(1) // 1ms:真起来了的话下面这一等必然够它跑好几轮

    clockMs += STALL_MS + MINUTE
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(wakeEvents(worker.worker_id)).toHaveLength(0)
    expect(adapter.lastActivityAtCalls).toHaveLength(0)
    harness.stopLivenessSweep() // 兜底清理(此处应已无 timer)
  })

  it('没有任何化身的 system task(#72 的 memory_maintenance 形态)不进候选集,也不让整轮巡检抛错', async () => {
    const adapter = new CliLikeAdapter(impl)
    const { harness, ledger } = await makeHarness(adapter)
    // #72 的 maintenance system task:agent 自己跑,不派 worker,台账条目 `incarnations: []`,
    // 但 running 期间照样会被 listAllWorkers 枚举到。
    const managerKey = (`test::${'friend-1'}` as ManagerKey)
    const taskId = 'task-maintenance-1'
    await ledger.upsertWorker(managerKey, taskId, () => ({
      worker_id: taskId,
      manager_key: managerKey,
      task: { id: taskId, title: '记忆维护', status: 'running', created_at: now() },
      origin: { trigger_type: 'system' },
      report_to: { channel_id: 'system', session_id: 'tasks' },
      incarnations: [],
      updated_at: now(),
    }))
    events = []

    clockMs += STALL_MS + MINUTE
    await expect(harness.sweepLiveness()).resolves.toBeUndefined()
    expect(wakeEvents(taskId)).toHaveLength(0)
  })

  it('已终态的 task 不进候选集(巡检不去打扰已经收工的 worker)', async () => {
    const { harness, adapter, workerId } = await spawnRunning()
    await harness.killWorker(workerId, '收工')
    events = []

    clockMs += STALL_MS + MINUTE
    await harness.sweepLiveness()

    expect(wakeEvents(workerId)).toHaveLength(0)
    expect(adapter.lastActivityAtCalls).not.toContain(`${workerId}#1`)
  })
})
