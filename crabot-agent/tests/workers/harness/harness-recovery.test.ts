import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  WorkerHarness,
  WorkerHasNoIncarnationError,
  type HarnessDeps,
  type ReconcileReport,
} from '../../../src/workers/harness/harness'
import { LedgerStore } from '../../../src/workers/harness/ledger-store'
import { WorkspaceManager } from '../../../src/workers/harness/workspace-manager'
import {
  dialogObjectIdForPrivate,
  dialogObjectIdForGroup,
  type DialogObjectId,
  type LedgerWorker,
} from '../../../src/workers/harness/ledger-types'
import type { HarnessEvent } from '../../../src/workers/harness/worker-events'
import type {
  WorkerAdapter,
  WorkerImplId,
  WorkerContractState,
  IncarnationHandle,
  IncarnationRef,
  SpawnSpec,
  OutputCursor,
  AdapterCapabilities,
  DetectResult,
} from '../../../src/workers/types'

// ---- FakeAdapter：Task 9 崩溃恢复对账专用桩——只关心 state()，spawn/resume/fork/sendInput
// 均不被 reconcileOnStartup 用到（本文件的台账记录都是直接经 LedgerStore.upsertWorker 手工
// 构造的"进程重启前的现场"，不经过 harness.spawnWorker，避免混入不相关的编排语义）。----

function handleKey(h: { worker_id: string; seq: number }): string {
  return `${h.worker_id}#${h.seq}`
}

class FakeAdapter implements WorkerAdapter {
  readonly implId: WorkerImplId
  readonly stateCalls: IncarnationHandle[] = []
  private readonly states = new Map<string, WorkerContractState>()
  private readonly throwers = new Map<string, Error>()

  constructor(implId: WorkerImplId = 'builtin') {
    this.implId = implId
  }

  /** 编程本次巡检 adapter.state(handle) 应该返回什么。 */
  setState(h: { worker_id: string; seq: number }, state: WorkerContractState): void {
    this.states.set(handleKey(h), state)
  }

  /** 编程本次巡检 adapter.state(handle) 应该抛什么错。 */
  setStateError(h: { worker_id: string; seq: number }, err: Error): void {
    this.throwers.set(handleKey(h), err)
  }

  async detect(): Promise<DetectResult> {
    return { installed: true, activated: true }
  }

  async provision(): Promise<void> {}

  async spawn(_spec: SpawnSpec): Promise<IncarnationHandle> {
    throw new Error('FakeAdapter.spawn: not exercised by harness-recovery tests')
  }

  async resume(_prev: IncarnationRef, _wakeInput: string): Promise<IncarnationHandle> {
    throw new Error('FakeAdapter.resume: not exercised by harness-recovery tests')
  }

  async fork(_prev: IncarnationRef, _forkInput: string): Promise<IncarnationHandle> {
    throw new Error('FakeAdapter.fork: not exercised by harness-recovery tests')
  }

  async sendInput(): Promise<void> {
    throw new Error('FakeAdapter.sendInput: not exercised by harness-recovery tests')
  }

  async readOutput(_h: IncarnationHandle, cursor: OutputCursor): Promise<{ chunk: string; nextCursor: OutputCursor }> {
    return { chunk: '', nextCursor: cursor }
  }

  async state(h: IncarnationHandle): Promise<WorkerContractState> {
    this.stateCalls.push(h)
    const err = this.throwers.get(handleKey(h))
    if (err) throw err
    return this.states.get(handleKey(h)) ?? 'exited'
  }

  async kill(_h: IncarnationHandle): Promise<void> {}

  capabilities(): AdapterCapabilities {
    return { fork: false, revive: false, goalMode: false, subagent: false, structuredTrace: false }
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

async function makeHarness(): Promise<{ harness: WorkerHarness; ledger: LedgerStore; adaptersMap: Map<WorkerImplId, WorkerAdapter> }> {
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
  return { harness, ledger, adaptersMap }
}

/** 直接构造一条"进程重启前留在台账里的现场"，不经过 harness.spawnWorker 的编排语义。 */
function makeWorker(workerId: string, overrides: Partial<LedgerWorker> = {}): LedgerWorker {
  const ts = new Date(nowValue).toISOString()
  return {
    worker_id: workerId,
    task: {
      id: `task-${workerId}`,
      title: '测试任务',
      status: 'running',
      created_at: ts,
    },
    origin: { spawned_by_session: 'wechat::sess-1', trigger_type: 'message' },
    report_to: { channel_id: 'wechat', session_id: 'sess-1' },
    incarnations: [
      { seq: 1, impl: 'builtin', state: 'running', workspace: '/tmp/ws', session_ref: `ref-${workerId}#1`, started_at: ts },
    ],
    updated_at: ts,
    ...overrides,
  }
}

async function seed(ledger: LedgerStore, dialogObjectId: DialogObjectId, worker: LedgerWorker): Promise<void> {
  await ledger.upsertWorker(dialogObjectId, worker.worker_id, () => worker)
}

async function getWorker(ledger: LedgerStore, workerId: string): Promise<LedgerWorker> {
  const found = await ledger.findWorker(workerId)
  if (!found) throw new Error(`worker not found in test: ${workerId}`)
  return found.worker
}

const DIALOG = dialogObjectIdForPrivate('friend-1')

beforeEach(async () => {
  dataDir = await fs.mkdtemp(join(tmpdir(), 'harness-recovery-test-'))
  nowValue = Date.parse('2026-01-01T00:00:00.000Z')
  events.length = 0
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

describe('WorkerHarness.reconcileOnStartup — 三态判定', () => {
  it('adapter 报 exited 而台账非终态 → 落 failed(ended_reason=crashed) + 事件，归 failed', async () => {
    const { harness, ledger, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter('builtin')
    adaptersMap.set('builtin', fake)
    const worker = makeWorker('w-exited', { task: { id: 'task-w-exited', title: '测试任务', status: 'running', created_at: now() } })
    await seed(ledger, DIALOG, worker)
    fake.setState({ worker_id: 'w-exited', seq: 1 }, 'exited')

    const report = await harness.reconcileOnStartup()

    expect(report).toEqual<ReconcileReport>({ revived: [], failed: ['w-exited'], unchanged: [] })
    const after = await getWorker(ledger, 'w-exited')
    expect(after.task.status).toBe('failed')
    expect(after.task.error).toBeTruthy()
    expect(after.incarnations[0].state).toBe('exited')
    expect(after.incarnations[0].ended_reason).toBe('crashed')
    expect(after.incarnations[0].ended_at).toBeTruthy()

    const exitedEvents = events.filter((e) => e.kind === 'exited' && e.worker_id === 'w-exited')
    expect(exitedEvents).toHaveLength(1)
    expect(exitedEvents[0].detail?.reason).toBe('crashed')
  })

  it('adapter 报 running 且与台账一致 → 台账保持不动、不发事件，归 revived', async () => {
    const { harness, ledger, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter('builtin')
    adaptersMap.set('builtin', fake)
    const worker = makeWorker('w-running')
    await seed(ledger, DIALOG, worker)
    fake.setState({ worker_id: 'w-running', seq: 1 }, 'running')

    const report = await harness.reconcileOnStartup()

    expect(report).toEqual<ReconcileReport>({ revived: ['w-running'], failed: [], unchanged: [] })
    const after = await getWorker(ledger, 'w-running')
    expect(after.task.status).toBe('running')
    expect(after.incarnations[0].state).toBe('running')
    expect(after.updated_at).toBe(worker.updated_at) // 完全没有写盘

    expect(events.filter((e) => e.worker_id === 'w-running')).toHaveLength(0)
  })

  it('无化身的 agent 自执行 system task → 不调用 adapter，重启后标 failed 并发事件', async () => {
    const { harness, ledger, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter('builtin')
    adaptersMap.set('builtin', fake)
    const worker = makeWorker('w-maintenance', {
      task: {
        id: 'task-w-maintenance',
        type: 'memory_maintenance',
        title: '记忆维护',
        status: 'running',
        created_at: now(),
      },
      origin: { spawned_by_session: 'admin-web::system-tasks', trigger_type: 'system' },
      incarnations: [],
    })
    await seed(ledger, DIALOG, worker)

    const report = await harness.reconcileOnStartup()

    expect(report).toEqual<ReconcileReport>({ revived: [], failed: ['w-maintenance'], unchanged: [] })
    expect(fake.stateCalls).toHaveLength(0)
    const after = await getWorker(ledger, 'w-maintenance')
    expect(after.task.status).toBe('failed')
    expect(after.task.error).toBe('agent restart: execution context lost for agent-native system task')
    expect(after.incarnations).toEqual([])
    const taskEvents = events.filter((e) => e.worker_id === 'w-maintenance')
    expect(taskEvents).toHaveLength(1)
    expect(taskEvents[0]).toMatchObject({
      seq: 0,
      kind: 'exited',
      task_status: 'failed',
      detail: { reason: 'crashed', message: 'agent restart: execution context lost for agent-native system task' },
    })
  })

  it('adapter 报 idle 且台账仍是 running → 对齐 incarnation.state=idle + task.status=waiting_input，发 state_changed(source=reconcile)，归 revived', async () => {
    const { harness, ledger, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter('builtin')
    adaptersMap.set('builtin', fake)
    const worker = makeWorker('w-idle')
    await seed(ledger, DIALOG, worker)
    fake.setState({ worker_id: 'w-idle', seq: 1 }, 'idle')

    const report = await harness.reconcileOnStartup()

    expect(report).toEqual<ReconcileReport>({ revived: ['w-idle'], failed: [], unchanged: [] })
    const after = await getWorker(ledger, 'w-idle')
    expect(after.task.status).toBe('waiting_input')
    expect(after.incarnations[0].state).toBe('idle')

    const stateEvents = events.filter((e) => e.kind === 'state_changed' && e.worker_id === 'w-idle')
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0].detail).toEqual({ to: 'idle', source: 'reconcile' })
  })

  it('主线化身的 impl 没有注册 adapter(已禁用/未安装) → 落 failed(crashed)，detail 记原因，不调用任何 adapter.state()', async () => {
    const { harness, ledger, adaptersMap } = await makeHarness()
    // 只注册 builtin，worker 的主线化身是 codex —— adapters.get('codex') 落空。
    const builtinFake = new FakeAdapter('builtin')
    adaptersMap.set('builtin', builtinFake)
    const worker = makeWorker('w-no-adapter', {
      incarnations: [{ seq: 1, impl: 'codex', state: 'running', workspace: '/tmp/ws', session_ref: 'ref-w-no-adapter#1', started_at: now() }],
    })
    await seed(ledger, DIALOG, worker)

    const report = await harness.reconcileOnStartup()

    expect(report).toEqual<ReconcileReport>({ revived: [], failed: ['w-no-adapter'], unchanged: [] })
    const after = await getWorker(ledger, 'w-no-adapter')
    expect(after.task.status).toBe('failed')
    expect(after.incarnations[0].ended_reason).toBe('crashed')
    const exitedEvents = events.filter((e) => e.kind === 'exited' && e.worker_id === 'w-no-adapter')
    expect(exitedEvents[0].detail?.message).toContain('codex')
    expect(builtinFake.stateCalls).toHaveLength(0) // 不存在的 impl，不该错调到别的 adapter 上
  })

  it('adapter.state() 抛错 → 视为不可判定，落 failed(crashed)，detail 记错误信息，不中断整轮对账（其余 worker 仍被正常处理）', async () => {
    const { harness, ledger, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter('builtin')
    adaptersMap.set('builtin', fake)
    const throwingWorker = makeWorker('w-throws')
    const okWorker = makeWorker('w-ok')
    await seed(ledger, DIALOG, throwingWorker)
    await seed(ledger, DIALOG, okWorker)
    fake.setStateError({ worker_id: 'w-throws', seq: 1 }, new Error('tmux pane 探测失败：session 不存在'))
    fake.setState({ worker_id: 'w-ok', seq: 1 }, 'running')

    const report = await harness.reconcileOnStartup()

    expect(report.failed).toEqual(['w-throws'])
    expect(report.revived).toEqual(['w-ok']) // 另一个 worker 没有被这次异常连累，正常判定

    const after = await getWorker(ledger, 'w-throws')
    expect(after.task.status).toBe('failed')
    expect(after.incarnations[0].ended_reason).toBe('crashed')
    const exitedEvents = events.filter((e) => e.kind === 'exited' && e.worker_id === 'w-throws')
    expect(exitedEvents[0].detail?.message).toContain('tmux pane 探测失败')
  })
})

describe('WorkerHarness empty-incarnation domain errors', () => {
  it('worker-only operations reject a system task with a stable domain error', async () => {
    const { harness, ledger } = await makeHarness()
    const worker = makeWorker('w-system-only', {
      task: {
        id: 'task-w-system-only',
        type: 'memory_maintenance',
        title: '记忆维护',
        status: 'running',
        created_at: now(),
      },
      origin: { spawned_by_session: 'admin-web::system-tasks', trigger_type: 'system' },
      incarnations: [],
    })
    await seed(ledger, DIALOG, worker)

    const operations = [
      () => harness.sendToWorker('w-system-only', 'input'),
      () => harness.readWorkerOutput('w-system-only', { offset: 0 }),
      () => harness.readWorkerOutput('w-system-only', { offset: 0 }, { seq: 1 }),
      () => harness.switchWorkerImpl('w-system-only', 'builtin'),
      () => harness.killWorker('w-system-only'),
      () => harness.queryWorker('w-system-only', 'status?'),
    ]

    for (const operation of operations) {
      await expect(operation()).rejects.toBeInstanceOf(WorkerHasNoIncarnationError)
    }
  })
})

describe('WorkerHarness.reconcileOnStartup — 终态 worker 不被触碰', () => {
  it('台账已是终态(completed/failed/cancelled) → 不调用 adapter.state()，不发事件，归 unchanged', async () => {
    const { harness, ledger, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter('builtin')
    adaptersMap.set('builtin', fake)

    const completed = makeWorker('w-completed', {
      task: { id: 'task-w-completed', title: '测试任务', status: 'completed', created_at: now(), completed_at: now() },
      incarnations: [{ seq: 1, impl: 'builtin', state: 'exited', workspace: '/tmp/ws', session_ref: 'ref#1', started_at: now(), ended_at: now(), ended_reason: 'completed' }],
    })
    const failedAlready = makeWorker('w-failed-already', {
      task: { id: 'task-w-failed-already', title: '测试任务', status: 'failed', created_at: now(), completed_at: now(), error: 'boom' },
      incarnations: [{ seq: 1, impl: 'builtin', state: 'exited', workspace: '/tmp/ws', session_ref: 'ref#1', started_at: now(), ended_at: now(), ended_reason: 'failed' }],
    })
    const cancelled = makeWorker('w-cancelled', {
      task: { id: 'task-w-cancelled', title: '测试任务', status: 'cancelled', created_at: now(), completed_at: now() },
      incarnations: [{ seq: 1, impl: 'builtin', state: 'exited', workspace: '/tmp/ws', session_ref: 'ref#1', started_at: now(), ended_at: now(), ended_reason: 'killed' }],
    })
    await seed(ledger, DIALOG, completed)
    await seed(ledger, DIALOG, failedAlready)
    await seed(ledger, DIALOG, cancelled)

    const report = await harness.reconcileOnStartup()

    expect(report.unchanged.sort()).toEqual(['w-cancelled', 'w-completed', 'w-failed-already'])
    expect(report.revived).toEqual([])
    expect(report.failed).toEqual([])
    expect(fake.stateCalls).toHaveLength(0)
    expect(events).toHaveLength(0)
  })
})

describe('WorkerHarness.reconcileOnStartup — 报告分类 + 跨对话对象', () => {
  it('私聊与群聊两个对话对象下的 worker 混合 revived/failed/unchanged，一次调用全部正确分类', async () => {
    const { harness, ledger, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter('builtin')
    adaptersMap.set('builtin', fake)

    const group = dialogObjectIdForGroup('wechat', 'group-1')
    await seed(ledger, DIALOG, makeWorker('priv-alive'))
    await seed(ledger, DIALOG, makeWorker('priv-dead'))
    await seed(
      ledger,
      group,
      makeWorker('group-done', {
        task: { id: 'task-group-done', title: '测试任务', status: 'completed', created_at: now(), completed_at: now() },
        incarnations: [{ seq: 1, impl: 'builtin', state: 'exited', workspace: '/tmp/ws', session_ref: 'ref#1', started_at: now(), ended_at: now(), ended_reason: 'completed' }],
      })
    )
    fake.setState({ worker_id: 'priv-alive', seq: 1 }, 'running')
    fake.setState({ worker_id: 'priv-dead', seq: 1 }, 'exited')

    const report = await harness.reconcileOnStartup()

    expect(report.revived).toEqual(['priv-alive'])
    expect(report.failed).toEqual(['priv-dead'])
    expect(report.unchanged).toEqual(['group-done'])
  })
})

describe('WorkerHarness.reconcileOnStartup — 幂等', () => {
  it('重复调用不重复判死、不重复发事件：第二次调用时前一轮判死的 worker 已是终态 → 归 unchanged', async () => {
    const { harness, ledger, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter('builtin')
    adaptersMap.set('builtin', fake)
    const worker = makeWorker('w-repeat')
    await seed(ledger, DIALOG, worker)
    fake.setState({ worker_id: 'w-repeat', seq: 1 }, 'exited')

    const first = await harness.reconcileOnStartup()
    expect(first).toEqual<ReconcileReport>({ revived: [], failed: ['w-repeat'], unchanged: [] })
    const afterFirst = await getWorker(ledger, 'w-repeat')
    expect(afterFirst.task.status).toBe('failed')
    const eventsAfterFirst = events.filter((e) => e.worker_id === 'w-repeat')
    expect(eventsAfterFirst).toHaveLength(1)

    const second = await harness.reconcileOnStartup()
    expect(second).toEqual<ReconcileReport>({ revived: [], failed: [], unchanged: ['w-repeat'] })
    // adapter.state() 完全不会再被这个已终态 worker 调用第二次。
    expect(fake.stateCalls.filter((h) => h.worker_id === 'w-repeat')).toHaveLength(1)
    // 没有产生第二条事件。
    expect(events.filter((e) => e.worker_id === 'w-repeat')).toHaveLength(1)
    const afterSecond = await getWorker(ledger, 'w-repeat')
    expect(afterSecond).toEqual(afterFirst) // 台账没有被第二次改写
  })
})

/**
 * P5 修复:`HarnessEvent.task_status` —— 对账路径上的两个 task 级迁移点
 * (markCrashed 的 `exited`、realignAliveIncarnation 的 `state_changed`)必须自带落账后的
 * 状态,订阅方不再现读台账。分类总表见 harness.ts `appendEvent` 注释。
 */
describe('HarnessEvent.task_status —— reconcileOnStartup 的迁移点', () => {
  it('判死(markCrashed)的 exited 事件带 failed', async () => {
    const { harness, ledger, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter('builtin')
    adaptersMap.set('builtin', fake)
    await seed(ledger, DIALOG, makeWorker('w-crash'))
    fake.setState({ worker_id: 'w-crash', seq: 1 }, 'exited')

    await harness.reconcileOnStartup()

    const exited = events.filter((e) => e.kind === 'exited' && e.worker_id === 'w-crash')
    expect(exited).toHaveLength(1)
    expect(exited[0].task_status).toBe('failed')
    expect(exited[0].task_status).toBe((await getWorker(ledger, 'w-crash')).task.status)
  })

  it('存活对齐(realignAliveIncarnation)的 state_changed 事件带 waiting_input', async () => {
    const { harness, ledger, adaptersMap } = await makeHarness()
    const fake = new FakeAdapter('builtin')
    adaptersMap.set('builtin', fake)
    await seed(ledger, DIALOG, makeWorker('w-realign'))
    fake.setState({ worker_id: 'w-realign', seq: 1 }, 'idle')

    await harness.reconcileOnStartup()

    const stateEvents = events.filter((e) => e.kind === 'state_changed' && e.worker_id === 'w-realign')
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0].task_status).toBe('waiting_input')
  })
})
