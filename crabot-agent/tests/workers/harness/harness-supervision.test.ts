import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WorkerHarness, type HarnessDeps, type SpawnWorkerParams } from '../../../src/workers/harness/harness'
import { LedgerStore } from '../../../src/workers/harness/ledger-store'
import { WorkspaceManager } from '../../../src/workers/harness/workspace-manager'
import type { HarnessEvent, HarnessEventDelivery } from '../../../src/workers/harness/worker-events'
import type {
  AdapterCapabilities,
  CapabilityBundle,
  DetectResult,
  ForkOptions,
  IncarnationHandle,
  IncarnationRef,
  SpawnSpec,
  SupervisionObservation,
  WorkerAdapter,
  WorkerContractState,
  WorkerImplId,
  Workspace,
} from '../../../src/workers/types'
import type { ManagerKey } from '../../../src/workers/harness/ledger-types'

const MINUTE = 60_000

class SupervisionAdapter implements WorkerAdapter {
  readonly implId: WorkerImplId = 'builtin'
  observation: SupervisionObservation = { kind: 'none', next_cursor: { offset: 0 } }
  contractState: WorkerContractState = 'running'
  inspectCalls = 0
  stateCalls = 0
  sendInputCalls = 0
  resumeCalls = 0
  killCalls = 0

  async detect(): Promise<DetectResult> { return { installed: true, activated: true } }
  async provision(_ws: Workspace, _caps: CapabilityBundle): Promise<void> {}
  async spawn(spec: SpawnSpec): Promise<IncarnationHandle> {
    return { worker_id: spec.worker_id, seq: 1, impl: this.implId, session_ref: `session-${spec.worker_id}` }
  }
  async resume(_prev: IncarnationRef, _input: string): Promise<IncarnationHandle> {
    this.resumeCalls += 1
    throw new Error('not used by supervision')
  }
  async fork(_prev: IncarnationRef, _input: string, _opts: ForkOptions): Promise<IncarnationHandle> {
    throw new Error('not used by supervision')
  }
  async sendInput(): Promise<void> { this.sendInputCalls += 1 }
  async readTerminal() {
    return { kind: 'unavailable' as const, unavailable_reason: 'headless_without_text' }
  }
  async state(): Promise<WorkerContractState> { this.stateCalls += 1; return this.contractState }
  async inspectSupervisionActivity(): Promise<SupervisionObservation> {
    this.inspectCalls += 1
    return this.observation
  }
  async kill(): Promise<void> { this.killCalls += 1; this.contractState = 'exited' }
  async dispose(): Promise<void> {}
  capabilities(): AdapterCapabilities {
    return { fork: false, revive: true, goalMode: false, subagent: false, structuredTrace: true }
  }
}

let dataDir: string
let clockMs: number
let delivery: HarnessEventDelivery = { consumed: true }
let events: HarnessEvent[]
let onEventOverride: HarnessDeps['onEvent'] | undefined

function now(): string {
  return new Date(clockMs).toISOString()
}

function params(): SpawnWorkerParams {
  return {
    managerKey: 'feishu::session-1' as ManagerKey,
    title: '巡检测试',
    prompt: '执行任务',
    origin: { trigger_type: 'message' },
    report_to: { channel_id: 'feishu', session_id: 'session-1' },
  }
}

async function makeHarness(): Promise<{ harness: WorkerHarness; adapter: SupervisionAdapter; ledger: LedgerStore }> {
  const adapter = new SupervisionAdapter()
  const ledger = new LedgerStore(join(dataDir, 'ledgers'))
  const harness = new WorkerHarness({
    adapters: new Map([[adapter.implId, adapter]]),
    defaultImpl: adapter.implId,
    ledger,
    workspaces: new WorkspaceManager(join(dataDir, 'workspaces')),
    workersDir: join(dataDir, 'workers'),
    now,
    onEvent: (event) => {
      events.push(event)
      return onEventOverride?.(event) ?? delivery
    },
  } satisfies HarnessDeps)
  return { harness, adapter, ledger }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function spawnRunning(harness: WorkerHarness): Promise<string> {
  return (await harness.spawnWorker(params())).worker_id
}

function supervisionEvents(workerId: string): HarnessEvent[] {
  return events.filter((event) => event.worker_id === workerId && event.kind === 'supervision_due')
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(join(tmpdir(), 'harness-supervision-test-'))
  clockMs = Date.parse('2026-08-19T00:00:00.000Z')
  delivery = { consumed: true }
  events = []
  onEventOverride = undefined
})

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true })
})

describe('WorkerHarness task supervision', () => {
  it('does not re-read terminal or agent-native system tasks during a supervision sweep', async () => {
    const { harness, ledger } = await makeHarness()
    const activeWorkerId = await spawnRunning(harness)
    const terminalWorkerId = await spawnRunning(harness)
    await harness.killWorker(terminalWorkerId)

    const managerKey = 'admin-web::system-tasks' as ManagerKey
    for (let index = 0; index < 3; index++) {
      const taskId = `maintenance-${index}`
      await ledger.upsertWorker(managerKey, taskId, () => ({
        worker_id: taskId,
        manager_key: managerKey,
        task: { id: taskId, title: '记忆维护', status: 'running', created_at: now() },
        origin: { trigger_type: 'system' },
        report_to: { channel_id: 'admin-web', session_id: 'system-tasks' },
        incarnations: [],
        updated_at: now(),
      }))
    }

    const findWorker = vi.spyOn(ledger, 'findWorker')
    await harness.reconcileSupervisionOnStartup()

    expect(findWorker).toHaveBeenCalledTimes(1)
    expect(findWorker).toHaveBeenCalledWith(activeWorkerId)
  })

  it('bounds concurrent fresh ledger reads while preparing supervision', async () => {
    const { harness, ledger } = await makeHarness()
    for (let index = 0; index < 9; index++) await spawnRunning(harness)

    const originalFindWorker = ledger.findWorker.bind(ledger)
    const gate = deferred<void>()
    let inFlight = 0
    let peakInFlight = 0
    vi.spyOn(ledger, 'findWorker').mockImplementation(async (workerId) => {
      inFlight += 1
      peakInFlight = Math.max(peakInFlight, inFlight)
      try {
        await gate.promise
        return await originalFindWorker(workerId)
      } finally {
        inFlight -= 1
      }
    })

    const sweep = harness.reconcileSupervisionOnStartup()
    try {
      await waitUntil(() => inFlight >= 8)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(peakInFlight).toBeLessThanOrEqual(8)
    } finally {
      gate.resolve()
      await sweep
    }
  })

  it('bounds concurrent fresh ledger reads during startup reconciliation', async () => {
    const { harness, ledger } = await makeHarness()
    for (let index = 0; index < 9; index++) await spawnRunning(harness)

    const originalFindWorker = ledger.findWorker.bind(ledger)
    const gate = deferred<void>()
    let inFlight = 0
    let peakInFlight = 0
    vi.spyOn(ledger, 'findWorker').mockImplementation(async (workerId) => {
      inFlight += 1
      peakInFlight = Math.max(peakInFlight, inFlight)
      try {
        await gate.promise
        return await originalFindWorker(workerId)
      } finally {
        inFlight -= 1
      }
    })

    const reconciliation = harness.reconcileOnStartup()
    try {
      await waitUntil(() => inFlight >= 8)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(peakInFlight).toBeLessThanOrEqual(8)
    } finally {
      gate.resolve()
      await reconciliation
    }
  })

  it('bounds concurrent supervision event delivery', async () => {
    const { harness, adapter } = await makeHarness()
    for (let index = 0; index < 9; index++) await spawnRunning(harness)
    adapter.observation = { kind: 'text', next_cursor: { offset: 1 } }
    clockMs += 15 * MINUTE

    const gate = deferred<void>()
    let inFlight = 0
    let peakInFlight = 0
    onEventOverride = async (event) => {
      if (event.kind !== 'supervision_due') return delivery
      inFlight += 1
      peakInFlight = Math.max(peakInFlight, inFlight)
      try {
        await gate.promise
        return delivery
      } finally {
        inFlight -= 1
      }
    }

    const sweep = harness.sweepLiveness()
    try {
      await waitUntil(() => inFlight >= 8)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(peakInFlight).toBeLessThanOrEqual(8)
    } finally {
      gate.resolve()
      await sweep
    }
  })

  it('default tool-only activity advances the cursor and next due without waking Manager', async () => {
    const { harness, adapter } = await makeHarness()
    const workerId = await spawnRunning(harness)
    events = []
    adapter.observation = { kind: 'tool_only', next_cursor: { offset: 4 } }
    clockMs += 15 * MINUTE

    await harness.sweepLiveness()

    const worker = (await harness.findWorker(workerId))!.worker
    expect(supervisionEvents(workerId)).toHaveLength(0)
    expect(worker.supervision).toMatchObject({
      mode: 'default',
      observation: { mainline_seq: 1, cursor: { offset: 4 } },
      next_due_at: new Date(clockMs + 15 * MINUTE).toISOString(),
    })
    expect(adapter.stateCalls).toBe(0)
    expect(adapter.sendInputCalls).toBe(0)
    expect(adapter.resumeCalls).toBe(0)
    expect(adapter.killCalls).toBe(0)
  })

  it('default text activity creates one due and advances only after Manager consumes it', async () => {
    const { harness, adapter } = await makeHarness()
    const workerId = await spawnRunning(harness)
    events = []
    adapter.observation = { kind: 'text', next_cursor: { offset: 2 } }
    clockMs += 15 * MINUTE

    await harness.sweepLiveness()

    const event = supervisionEvents(workerId).at(-1)!
    const worker = (await harness.findWorker(workerId))!.worker
    expect(event.detail).toMatchObject({
      mode: 'default',
      observation: 'text',
      mainline_seq: 1,
      mainline_incarnation_id: worker.incarnations[0].incarnation_id,
    })
    expect(worker.supervision).toMatchObject({
      mode: 'default',
      last_effective_review_at: now(),
      next_due_at: new Date(clockMs + 15 * MINUTE).toISOString(),
    })
    expect(worker.supervision?.pending).toBeUndefined()
  })

  it('none first probes state; idle takes the existing lifecycle path instead of inventing a due', async () => {
    const { harness, adapter } = await makeHarness()
    const workerId = await spawnRunning(harness)
    events = []
    adapter.observation = { kind: 'none', next_cursor: { offset: 0 } }
    adapter.contractState = 'idle'
    clockMs += 15 * MINUTE

    await harness.sweepLiveness()

    const worker = (await harness.findWorker(workerId))!.worker
    expect(adapter.stateCalls).toBe(1)
    expect(supervisionEvents(workerId)).toHaveLength(0)
    expect(worker.task.status).toBe('waiting_input')
    expect(worker.supervision).toMatchObject({ version: 1, mode: 'default', last_observed_at: now() })
    expect(worker.supervision?.next_due_at).toBeUndefined()
    expect(worker.supervision?.pending).toBeUndefined()
  })

  it('periodic report never filters tool-only activity and retains the same pending due after failed delivery', async () => {
    const { harness, adapter } = await makeHarness()
    const workerId = await spawnRunning(harness)
    await harness.setWorkerPeriodicReport(workerId, { channel_id: 'feishu', session_id: 'session-1' }, 5 * MINUTE)
    events = []
    delivery = { consumed: false }
    adapter.observation = { kind: 'tool_only', next_cursor: { offset: 8 } }
    clockMs += 5 * MINUTE

    await harness.sweepLiveness()

    const first = supervisionEvents(workerId).at(-1)!
    let worker = (await harness.findWorker(workerId))!.worker
    expect(first.detail).toMatchObject({ mode: 'periodic_report', observation: 'tool_only' })
    expect(worker.supervision?.pending).toMatchObject({ due_id: first.detail?.due_id, attempts: 1 })

    delivery = { consumed: true }
    clockMs += 5 * MINUTE
    await harness.sweepLiveness()

    worker = (await harness.findWorker(workerId))!.worker
    expect(supervisionEvents(workerId).at(-1)?.detail?.due_id).toBe(first.detail?.due_id)
    expect(worker.supervision?.pending).toBeUndefined()
    expect(worker.supervision).toMatchObject({
      mode: 'periodic_report',
      last_effective_review_at: now(),
      next_due_at: new Date(clockMs + 5 * MINUTE).toISOString(),
    })
  })

  it('periodic report remains due when the mainline transitions to waiting_input', async () => {
    const { harness, adapter } = await makeHarness()
    const workerId = await spawnRunning(harness)
    await harness.setWorkerPeriodicReport(workerId, { channel_id: 'feishu', session_id: 'session-1' }, 5 * MINUTE)
    events = []
    adapter.observation = { kind: 'none', next_cursor: { offset: 0 } }
    adapter.contractState = 'idle'
    clockMs += 5 * MINUTE

    await harness.sweepLiveness()

    const worker = (await harness.findWorker(workerId))!.worker
    expect(supervisionEvents(workerId)).toHaveLength(1)
    expect(supervisionEvents(workerId)[0].detail).toMatchObject({
      mode: 'periodic_report',
      observation: 'none',
      probe: 'idle',
    })
    expect(worker.task.status).toBe('waiting_input')
    expect(worker.supervision).toMatchObject({
      mode: 'periodic_report',
      next_due_at: new Date(clockMs + 5 * MINUTE).toISOString(),
    })
    expect(worker.supervision?.pending).toBeUndefined()
  })

  it('clearing a rule invalidates a queued due and terminal cleanup removes periodic configuration', async () => {
    const { harness, adapter } = await makeHarness()
    const workerId = await spawnRunning(harness)
    await harness.setWorkerPeriodicReport(workerId, { channel_id: 'feishu', session_id: 'session-1' }, 5 * MINUTE)
    events = []
    delivery = { consumed: false }
    clockMs += 5 * MINUTE
    await harness.sweepLiveness()
    const stale = supervisionEvents(workerId).at(-1)!

    await harness.clearWorkerPeriodicReport(workerId)
    expect(await harness.isSupervisionDueCurrent(stale)).toBe(false)

    await harness.killWorker(workerId)
    const worker = (await harness.findWorker(workerId))!.worker
    expect(adapter.killCalls).toBe(1)
    expect(worker.supervision).toEqual({ version: 1, mode: 'default' })
  })
})
