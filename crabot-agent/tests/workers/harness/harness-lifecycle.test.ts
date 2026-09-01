import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { INPUT_DELIVERY_TIMEOUT_MS, WorkerHarness, WorkerNotFoundError, TaskCancelledError, type HarnessDeps, type SpawnWorkerParams } from '../../../src/workers/harness/harness'
import { LedgerStore } from '../../../src/workers/harness/ledger-store'
import { WorkspaceManager } from '../../../src/workers/harness/workspace-manager'
import { NativeActivityStore } from '../../../src/workers/harness/native-activity-store'
import { } from '../../../src/workers/harness/ledger-types'
import {
  WorkerEventLog,
  type ActivityContextAdmissionReceipt,
  type HarnessEvent,
} from '../../../src/workers/harness/worker-events'
import { QueryReceiptStore } from '../../../src/workers/harness/query-receipt-store'
import { CliInputStallError, QueryEstablishmentError } from '../../../src/workers/errors'
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
  CapabilityBundle,
  AdapterCapabilities,
  InitialInputResult,
  ForkOptions,
  NormalizedTraceEvent,
  SendInputOptions,
  WorkerUiResponse,
} from '../../../src/workers/types'

// ---- FakeAdapter:实现 WorkerAdapter 契约的可编程桩,不碰 tmux/LLM ----

function handleKey(h: IncarnationHandle): string {
  return `${h.worker_id}#${h.seq}`
}

function terminal(text: string) {
  return { kind: 'live_terminal' as const, text, captured_at: '2026-08-19T00:00:00.000Z' }
}

const UI_ACTIONS = [
  { action_id: 'confirm', kind: 'keys' as const, keys: ['Enter'] as const },
  { action_id: 'cancel', kind: 'keys' as const, keys: ['Escape'] as const },
]

interface FakeAdapterOpts {
  readonly implId?: WorkerImplId
  readonly caps?: Partial<AdapterCapabilities>
  readonly onStateChange?: (h: IncarnationHandle, state: WorkerContractState, report?: StateChangeReport) => void
  readonly spawnShouldFail?: Error
  readonly forkShouldFail?: Error
  readonly interruptShouldFail?: Error
  readonly sendInputBehavior?: (h: IncarnationHandle, text: string, opts?: SendInputOptions) => Promise<void> | void
  readonly sendInputState?: WorkerContractState
  readonly acceptedExitReport?: StateChangeReport
  readonly updatedSessionRef?: string
  readonly spawnInitialInput?: InitialInputResult
  readonly nativeTrace?: ReadonlyArray<NormalizedTraceEvent>
  /** P4 Task 4 第四轮:严格复刻 ClaudeCodeAdapter.fork()(adapter.ts:452-460)的调用顺序——
   * 在 `return handle` 之前就把化身转到 exited 并**同步**调用 onStateChange。用于回归
   * "fork 落地即已终态"这条竞态(见下面 describe 块)。 */
  readonly forkSyncExitBeforeReturn?: boolean
}

class FakeAdapter implements WorkerAdapter {
  readonly implId: WorkerImplId
  readonly provisionCalls: Array<{ ws: Workspace; caps: CapabilityBundle }> = []
  readonly spawnCalls: SpawnSpec[] = []
  readonly sendInputCalls: Array<{ h: IncarnationHandle; text: string; opts?: SendInputOptions }> = []
  readonly killCalls: IncarnationHandle[] = []
  readonly interruptCalls: IncarnationHandle[] = []
  readonly forkCalls: Array<{ prev: IncarnationRef; forkInput: string; opts: ForkOptions }> = []
  readonly readTerminalCalls: IncarnationHandle[] = []
  readonly uiResponses: Array<{ h: IncarnationHandle; response: WorkerUiResponse }> = []
  private readonly states = new Map<string, WorkerContractState>()
  private acceptedExitReport?: StateChangeReport
  private updatedSessionRef?: string
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
    const handle: IncarnationHandle = {
      worker_id: spec.worker_id,
      seq: 1,
      impl: this.implId,
      session_ref: `ref-${spec.worker_id}#1`,
      ...(this.opts.spawnInitialInput ? { initial_input: this.opts.spawnInitialInput } : {}),
    }
    this.states.set(handleKey(handle), 'running')
    return handle
  }

  async resume(_prev: IncarnationRef, _wakeInput: string): Promise<IncarnationHandle> {
    throw new Error('FakeAdapter.resume: not exercised by Task 7 tests')
  }

  async fork(prev: IncarnationRef, forkInput: string, opts: ForkOptions): Promise<IncarnationHandle> {
    this.forkCalls.push({ prev, forkInput, opts })
    if (this.opts.forkShouldFail) throw this.opts.forkShouldFail
    const seq = this.nextForkSeq++
    // fork 自己的 session_ref，刻意与 prev.session_ref(父化身/主线的引用)不同，好让
    // 回归测试能验证 harness 没有把父化身的引用错抄给 fork 化身(protocol-agent-v3 §6.1)。
    const handle: IncarnationHandle = {
      worker_id: prev.worker_id,
      seq,
      impl: this.implId,
      session_ref: `fork-ref-${prev.worker_id}#${seq}`,
      query_id: opts.query_id,
    }
    if (this.opts.forkSyncExitBeforeReturn) {
      // 严格复刻 cc adapter 的 fork():在这个同步语句执行到 `return handle` 之前，就已经
      // 把化身状态转到 exited 并调用 onStateChange——AsyncMutex.run 的入队是同步的
      // (harness.ts withLock 注释)，所以 harness.handleStateChange 派生的 processStateChange
      // 对这个 worker_id 的锁请求，必然排在 queryWorker 落账段(第二次 withLock)前面。
      // report.endReason 对齐 cc adapter 的 fork():它的 transitionExited 拿到的是
      // `execFileAsync` 成功时的 'completed'(失败走 'crashed'),不是"没有值"。
      this.states.set(handleKey(handle), 'exited')
      this.opts.onStateChange?.(handle, 'exited', { endReason: 'completed' })
      return handle
    }
    this.states.set(handleKey(handle), 'running')
    return handle
  }

  async sendInput(h: IncarnationHandle, text: string, opts?: SendInputOptions): Promise<void> {
    this.sendInputCalls.push({ h, text, opts })
    if (this.opts.sendInputBehavior) await this.opts.sendInputBehavior(h, text, opts)
    if (this.opts.updatedSessionRef) this.updatedSessionRef = this.opts.updatedSessionRef
    if (this.opts.acceptedExitReport) {
      this.states.set(handleKey(h), 'exited')
      this.acceptedExitReport = this.opts.acceptedExitReport
    }
    if (this.opts.sendInputState) {
      this.states.set(handleKey(h), this.opts.sendInputState)
      this.opts.onStateChange?.(h, this.opts.sendInputState)
    }
  }

  async respondToUi(h: IncarnationHandle, response: WorkerUiResponse): Promise<void> {
    this.uiResponses.push({ h, response })
  }

  takeUpdatedSessionRef(): string | undefined {
    const sessionRef = this.updatedSessionRef
    this.updatedSessionRef = undefined
    return sessionRef
  }

  takeAcceptedInputExit(): StateChangeReport | undefined {
    const report = this.acceptedExitReport
    this.acceptedExitReport = undefined
    return report
  }

  async readTerminal(h: IncarnationHandle) {
    this.readTerminalCalls.push(h)
    return { kind: 'unavailable' as const, unavailable_reason: 'headless_without_text' }
  }

  async state(h: IncarnationHandle): Promise<WorkerContractState> {
    return this.states.get(handleKey(h)) ?? 'exited'
  }

  async inspectSupervisionActivity(_h: IncarnationHandle, cursor?: { offset: number }) {
    return { kind: 'unknown' as const, next_cursor: cursor ?? { offset: 0 } }
  }

  async readTrace(_h: IncarnationHandle, cursor?: { offset: number }) {
    const start = cursor?.offset ?? 0
    const trace = this.opts.nativeTrace ?? []
    return {
      events: trace.slice(start).map((event, index) => ({ ...event, source_offset: start + index })),
      nextCursor: { offset: trace.length },
    }
  }

  async kill(h: IncarnationHandle): Promise<void> {
    this.killCalls.push(h)
    this.states.set(handleKey(h), 'exited')
  }

  async interrupt(h: IncarnationHandle): Promise<void> {
    this.interruptCalls.push(h)
    if (this.opts.interruptShouldFail) throw this.opts.interruptShouldFail
    this.states.set(handleKey(h), 'idle')
  }

  async stop(h: IncarnationHandle): Promise<void> {
    await this.kill(h)
  }

  capabilities(): AdapterCapabilities {
    return { fork: false, revive: false, goalMode: false, subagent: false, structuredTrace: false, ...this.opts.caps }
  }

  /** 测试专用:模拟 adapter 自己触发一次状态回调(镜像真实 adapter 内部调用 deps.onStateChange)。
   * `lastText` 对齐真实 adapter 的 `report.lastText`(轮次边界上 worker 最后说的那段话)。
   *
   * `endReason` 对齐真实 adapter 的 `report.endReason`。三个真实 adapter 的 `transitionExited`
   * 形参本就是**必填**的 `ended_reason`,不存在"退出了却说不出原因"的情况——所以这个桩在
   * `state==='exited'` 时也必须给出一个具体值,缺省取 `'completed'`(化身自然结束、非 kill,
   * 即本文件绝大多数用例的剧本)。需要复现 failed/crashed/killed 的用例显式传 endReason 形参。
   * 非 exited 态一律不报:endReason 只在 exited 时有意义(harness 会对此断言)。 */
  emitStateChange(
    h: IncarnationHandle,
    state: WorkerContractState,
    lastText?: string,
    endReason?: IncarnationEndReason,
  ): void {
    this.states.set(handleKey(h), state)
    this.opts.onStateChange?.(h, state, {
      ...(lastText !== undefined ? { lastText } : {}),
      ...(state === 'exited' ? { endReason: endReason ?? 'completed' } : {}),
      ...(state === 'idle'
        ? { completionSource: this.implId === 'claude-code' ? 'claude_stop' as const : this.implId === 'codex' ? 'codex_turn_complete' as const : 'builtin_end_turn' as const }
        : state === 'exited' && (endReason ?? 'completed') === 'completed'
          ? { completionSource: this.implId === 'claude-code' ? 'claude_stop' as const : this.implId === 'codex' ? 'codex_turn_complete' as const : 'builtin_end_turn' as const }
          : {}),
    })
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

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function makeHarness(
  fakeOpts: FakeAdapterOpts = {},
  depsOverrides: Partial<Pick<
    HarnessDeps,
    'hasRunningBg' | 'capabilityBundle' | 'onEvent' | 'onOperationNotification' | 'onNativeActivityCollected' | 'admitWorkerConnection' | 'redactFailureReason' | 'mintActivityCursor'
  >> = {},
): Promise<{
  harness: WorkerHarness
  fake: FakeAdapter
  adaptersMap: Map<WorkerImplId, WorkerAdapter>
  ledger: LedgerStore
  workersDir: string
}> {
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
    mintActivityCursor: async ({ offset }) => `opaque-activity-${['start', 'one', 'two', 'three'][offset] ?? 'later'}`,
    ...depsOverrides,
  }
  const harness = new WorkerHarness(deps)
  const fake = new FakeAdapter({ ...fakeOpts, onStateChange: harness.handleStateChange })
  adaptersMap.set(fake.implId, fake)

  return { harness, fake, adaptersMap, ledger, workersDir }
}

function spawnParams(overrides: Partial<SpawnWorkerParams> = {}): SpawnWorkerParams {
  return {
    managerKey: `test::friend-1` as ManagerKey,
    title: '测试任务',
    prompt: '把活干完',
    origin: {
      trigger_type: 'message' },
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
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
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

    const spawnedEvents = events.filter((e) => e.kind === 'lifecycle_changed')
    expect(spawnedEvents).toHaveLength(1)
    expect(spawnedEvents[0].detail).toMatchObject({ change: 'spawned' })
    expect(spawnedEvents[0].worker_id).toBe(worker.worker_id)
    expect(spawnedEvents[0].seq).toBe(1)

    // 台账已落盘且可查
    const listed = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(listed.map((w) => w.worker_id)).toContain(worker.worker_id)
  })

  it('为新化身分配 Harness-owned identity，并只读快照 workspace 的 AGENTS.md', async () => {
    const workspace = join(dataDir, 'user-workspace')
    const agents = '# Workspace rules\nDo not create HANDOFF.md.\n'
    await fs.mkdir(workspace, { recursive: true })
    await fs.writeFile(join(workspace, 'AGENTS.md'), agents)
    const { harness, workersDir } = await makeHarness()

    const worker = await harness.spawnWorker(spawnParams({ workspace }))
    const incarnation = worker.incarnations[0]

    expect(incarnation.incarnation_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(incarnation.workspace_instructions).toMatchObject({
      source: 'agents_md',
      artifact_id: `workspace-instructions/${worker.worker_id}/${incarnation.incarnation_id}`,
    })
    expect(await fs.readFile(join(workersDir, worker.worker_id, 'workspace-instructions', `${incarnation.incarnation_id}.md`), 'utf-8')).toBe(agents)
    expect(await fs.readFile(join(workspace, 'AGENTS.md'), 'utf-8')).toBe(agents)
  })

  it('把同一 AGENTS.md 快照交给 builtin 和有用户自有 CLAUDE.md 的 Claude worker', async () => {
    const agents = '# Workspace rules\nDo not create HANDOFF.md.\n'
    const builtinWorkspace = join(dataDir, 'builtin-workspace')
    await fs.mkdir(builtinWorkspace, { recursive: true })
    await fs.writeFile(join(builtinWorkspace, 'AGENTS.md'), agents)
    const { harness: builtinHarness, fake: builtin } = await makeHarness({ implId: 'builtin' })

    await builtinHarness.spawnWorker(spawnParams({ workspace: builtinWorkspace }))
    expect(builtin.spawnCalls[0].workspace_instructions).toMatchObject({
      snapshot: { source: 'agents_md' },
      text: agents,
    })

    const claudeWorkspace = join(dataDir, 'claude-user-owned-workspace')
    const userClaude = '# User maintained Claude instructions\n'
    await fs.mkdir(claudeWorkspace, { recursive: true })
    await fs.writeFile(join(claudeWorkspace, 'AGENTS.md'), agents)
    await fs.writeFile(join(claudeWorkspace, 'CLAUDE.md'), userClaude)
    const { harness: claudeHarness, fake: claude } = await makeHarness({ implId: 'claude-code' })

    await claudeHarness.spawnWorker(spawnParams({ impl: 'claude-code', workspace: claudeWorkspace }))
    expect(claude.spawnCalls[0].workspace_instructions).toMatchObject({
      snapshot: { source: 'agents_md' },
      text: agents,
    })
    expect(await fs.readFile(join(claudeWorkspace, 'CLAUDE.md'), 'utf-8')).toBe(userClaude)
  })

  it('首次 provision 前落 harness context，并把同一固定权限快照交给 capability provider', async () => {
    const principalPermissions = {
      tool_access: { memory: true, messaging: false, task: false, mcp_skill: false, file_io: true, browser: true, shell: true, remote_exec: false, desktop: false },
      cli_access: { provider: 'none', agent: 'none', mcp: 'none', skill: 'none', schedule: 'none', channel: 'none', friend: 'none', permission: 'none', config: 'none', undo: 'none' },
      storage: null,
      memory_scopes: ['friend-1'],
    } as const
    const capabilityBundle = vi.fn(async () => ({ skills: [], mcp_servers: [] }))
    const { harness, fake, workersDir } = await makeHarness({}, { capabilityBundle })

    const worker = await harness.spawnWorker(spawnParams({ principal_permissions: principalPermissions }))

    expect(capabilityBundle).toHaveBeenCalledWith({
      worker_id: worker.worker_id,
      impl: 'builtin',
      principal_permissions: principalPermissions,
    })
    expect(fake.provisionCalls).toHaveLength(1)
    expect(JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'context.json'), 'utf-8'))).toEqual({
      principal_permissions: principalPermissions,
    })
  })

  it('部分历史权限先按 fail-closed 默认规范化，再交给 capability provider 与 adapter', async () => {
    const partialPermissions = {
      tool_access: { mcp_skill: true },
      cli_access: { mcp: 'read' },
      storage: null,
      memory_scopes: ['legacy'],
    } as unknown as NonNullable<SpawnWorkerParams['principal_permissions']>
    const capabilityBundle = vi.fn(async () => ({ skills: [], mcp_servers: [] }))
    const { harness, fake } = await makeHarness({}, { capabilityBundle })

    await harness.spawnWorker(spawnParams({ principal_permissions: partialPermissions }))

    const normalized = capabilityBundle.mock.calls[0][0].principal_permissions
    expect(normalized).toMatchObject({
      tool_access: { mcp_skill: true, desktop: false, shell: false },
      cli_access: { mcp: 'read', undo: 'none', provider: 'none' },
    })
    expect(fake.spawnCalls[0].principal_permissions).toEqual(normalized)
  })

  it('无 principal 的新 worker 仍在 provision 前落空 context，而非误作 legacy ENOENT', async () => {
    const { harness, workersDir } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    expect(JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'context.json'), 'utf-8'))).toEqual({})
  })

  it('context 原子写失败时不调用 provision，并按既有 spawn_failed 语义落账', async () => {
    const { harness, fake } = await makeHarness()
    const contextStore = (harness as unknown as {
      contextStore: { write(workerId: string, context: unknown): Promise<void> }
    }).contextStore
    vi.spyOn(contextStore, 'write').mockRejectedValueOnce(new Error('context disk error'))

    await expect(harness.spawnWorker(spawnParams())).rejects.toThrow('context disk error')
    expect(fake.provisionCalls).toEqual([])
    expect(fake.spawnCalls).toEqual([])
    const [failed] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(failed.task).toMatchObject({ status: 'halted', halt: { halt_reason: 'crashed', detail: 'context disk error' } })
    expect(failed.incarnations[0]).toMatchObject({ state: 'exited', ended_reason: 'failed' })
    expect(events.find((event) => event.kind === 'exited')?.detail).toMatchObject({
      reason: 'spawn_failed',
      message: 'context disk error',
    })
  })

  it('CLI首投accepted后同步completed：task与化身按endReason落completed而非failed', async () => {
    const { harness } = await makeHarness({
      implId: 'claude-code',
      spawnInitialInput: {
        control_state: 'exited',
        disposition: 'accepted',
        report: { endReason: 'completed' },
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    expect(worker.task.status).toBe('halted')
    expect(worker.incarnations[0]).toMatchObject({ state: 'exited', ended_reason: 'completed' })
    expect(events.find((event) => event.kind === 'state_changed')?.detail).toEqual({
      to: 'exited',
      kind: 'initial_input_settled',
      reason: 'completed',
    })
  })

  it('CLI首投窗口内完成时创建待交付回合，不误报投递停摆', async () => {
    const { harness } = await makeHarness({
      implId: 'claude-code',
      nativeTrace: [{ ts: '2026-08-21T00:00:00.000Z', kind: 'message', role: 'assistant', summary: '首轮已经完成' }],
      spawnInitialInput: {
        control_state: 'waiting_text',
        disposition: 'accepted',
        report: { completionSource: 'claude_stop' },
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })

    expect(worker.task.status).toBe('halted')
    const turn = await harness.getWorkerTurn(worker.worker_id)
    expect(turn).toMatchObject({
      disposition: { status: 'pending' },
      activity_from: '0',
      activity_through: '1',
    })
    if (!turn) throw new Error('expected initial completed turn')
    await expect(harness.getWorkerTurnActivities(turn)).resolves.toEqual({
      events: [expect.objectContaining({ role: 'assistant', summary: '首轮已经完成', source_offset: 0 })],
    })
    expect(events.find((event) => event.kind === 'state_changed')?.detail).toMatchObject({
      to: 'idle',
      kind: 'initial_input_settled',
      turn_id: expect.any(String),
      turn_pending: true,
    })
  })

  it('CLI首投遇到未知界面时创建短期快照，只允许 Manager 应答一次', async () => {
    const { harness, fake, workersDir } = await makeHarness({
      implId: 'claude-code',
      spawnInitialInput: {
        control_state: 'waiting_action',
        disposition: 'not_pasted',
        report: {
          waitReason: 'interaction_required',
          terminal: terminal('Choose a login method'),
          ui: { fingerprint: 'login-method:1', actions: UI_ACTIONS },
          notification: { type: 'terminal_interaction', title: 'Login required' },
        },
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    const detail = events.find((event) => event.worker_id === worker.worker_id && event.kind === 'interaction_required')?.detail
    const snapshotId = detail?.snapshot_id

    expect(detail).toMatchObject({
      snapshot_id: expect.any(String),
      snapshot_expires_at: expect.any(String),
      actions: UI_ACTIONS,
      text: 'Choose a login method',
    })

    await expect(harness.respondToWorkerUi(worker.worker_id, snapshotId as string, 'unknown')).rejects.toThrow(
      'worker UI action is not available for this snapshot',
    )
    await expect(harness.respondToWorkerUi(worker.worker_id, snapshotId as string, 'confirm')).resolves.toMatchObject({
      status: 'submitted',
      snapshot_id: snapshotId,
      operation: { kind: 'ui_response', status: 'succeeded' },
    })
    expect(fake.uiResponses).toEqual([{
      h: expect.objectContaining({ worker_id: worker.worker_id, impl: 'claude-code' }),
      response: { kind: 'keys', keys: ['Enter'] },
    }])
    expect(JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'control-operations.json'), 'utf8'))).toMatchObject({
      operations: [expect.objectContaining({ kind: 'ui_response', status: 'succeeded' })],
    })
    await expect(harness.respondToWorkerUi(worker.worker_id, snapshotId as string, 'confirm')).rejects.toThrow(
      'worker UI snapshot is consumed',
    )
  })

  it('过期 UI 快照被拒绝，且不会发送任何按键', async () => {
    const { harness, fake, workersDir } = await makeHarness({
      implId: 'claude-code',
      spawnInitialInput: {
        control_state: 'waiting_action',
        disposition: 'not_pasted',
        report: {
          waitReason: 'interaction_required',
          ui: { fingerprint: 'expired:1', actions: UI_ACTIONS },
          notification: { type: 'terminal_interaction' },
        },
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    const detail = events.find((event) => event.worker_id === worker.worker_id && event.kind === 'interaction_required')?.detail

    nowValue += 11 * 60_000
    await expect(harness.respondToWorkerUi(worker.worker_id, detail?.snapshot_id as string, 'confirm')).rejects.toThrow(
      'worker UI snapshot is stale',
    )
    expect(fake.uiResponses).toEqual([])
  })

  it('UI fingerprint 改变或普通生命周期恢复时使旧 snapshot 失效', async () => {
    const initialActions = [{ action_id: 'confirm', kind: 'keys' as const, keys: ['Enter'] as const }]
    const nextActions = [{ action_id: 'cancel', kind: 'keys' as const, keys: ['Escape'] as const }]
    const { harness, fake, workersDir } = await makeHarness({
      implId: 'claude-code',
      spawnInitialInput: {
        control_state: 'waiting_action',
        disposition: 'not_pasted',
        report: {
          waitReason: 'interaction_required',
          ui: { fingerprint: 'dialog:one', actions: initialActions },
          notification: { type: 'terminal_interaction' },
        },
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    const incarnation = worker.incarnations[0]
    const firstSnapshotId = events.find((event) => event.worker_id === worker.worker_id && event.kind === 'interaction_required')
      ?.detail?.snapshot_id as string
    const handle: IncarnationHandle = {
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: 'claude-code',
      session_ref: incarnation.session_ref,
    }

    harness.handleStateChange(handle, 'idle', {
      waitReason: 'interaction_required',
      ui: { fingerprint: 'dialog:two', actions: nextActions },
      notification: { type: 'terminal_interaction' },
    })
    await waitUntil(async () => {
      const snapshots = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'ui-snapshots.json'), 'utf8')).snapshots
      return snapshots.some((snapshot: { fingerprint: string; status: string }) => snapshot.fingerprint === 'dialog:two' && snapshot.status === 'active')
    })

    let snapshots = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'ui-snapshots.json'), 'utf8')).snapshots
    const secondSnapshot = snapshots.find((snapshot: { fingerprint: string }) => snapshot.fingerprint === 'dialog:two')
    expect(snapshots.find((snapshot: { snapshot_id: string }) => snapshot.snapshot_id === firstSnapshotId)).toMatchObject({ status: 'stale' })
    await expect(harness.respondToWorkerUi(worker.worker_id, firstSnapshotId, 'confirm')).rejects.toThrow('worker UI snapshot is stale')
    expect(fake.uiResponses).toEqual([])

    harness.handleStateChange(handle, 'idle', { waitReason: 'input_surface_unavailable' })
    await waitUntil(async () => {
      const state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'ui-snapshots.json'), 'utf8'))
      return state.snapshots.find((snapshot: { snapshot_id: string }) => snapshot.snapshot_id === secondSnapshot.snapshot_id)?.status === 'stale'
    })
    snapshots = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'ui-snapshots.json'), 'utf8')).snapshots
    expect(snapshots.find((snapshot: { snapshot_id: string }) => snapshot.snapshot_id === secondSnapshot.snapshot_id)).toMatchObject({ status: 'stale' })
  })

  it('CLI首投not_pasted先落waiting_action，再由raw解除hold并按FIFO只补投一次原prompt', async () => {
    const { harness, fake, workersDir } = await makeHarness({
      implId: 'claude-code',
      spawnInitialInput: {
        control_state: 'waiting_action',
        disposition: 'not_pasted',
        report: { waitReason: 'input_surface_unavailable', terminal: terminal('modal') },
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code', prompt: 'original' })
    expect(worker.task.status).toBe('halted')
    expect(worker.incarnations[0].state).toBe('idle')

    await harness.sendToWorker(worker.worker_id, 'later')
    expect(fake.sendInputCalls).toHaveLength(0)

    await harness.sendToWorker(worker.worker_id, 'Enter', { raw: true })
    expect(fake.sendInputCalls.map((call) => [call.text, call.opts?.raw ?? false])).toEqual([
      ['Enter', true],
      ['original', false],
      ['later', false],
    ])
    expect(events.find((event) => event.kind === 'state_changed')?.detail).toMatchObject({
      to: 'idle',
      kind: 'input_delivery_stalled',
      wait_mode: 'action',
      wait_reason: 'input_surface_unavailable',
    })
  })

  it('CLI首投pending_in_ui不回队首、不重贴；raw处理后仅投递后续普通文本', async () => {
    const { harness, fake } = await makeHarness({
      implId: 'claude-code',
      spawnInitialInput: {
        control_state: 'waiting_action',
        disposition: 'pending_in_ui',
        report: { waitReason: 'input_pending', terminal: terminal('❯ original') },
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code', prompt: 'original' })
    await harness.sendToWorker(worker.worker_id, 'later')
    expect(fake.sendInputCalls).toHaveLength(0)

    await harness.sendToWorker(worker.worker_id, 'Enter', { raw: true })
    expect(fake.sendInputCalls.map((call) => [call.text, call.opts?.raw ?? false])).toEqual([
      ['Enter', true],
      ['later', false],
    ])
  })

  it('durable receipt pasted into CLI composer settles only after raw submission', async () => {
    const { harness } = await makeHarness({
      implId: 'claude-code',
      sendInputBehavior: async (_h, text, opts) => {
        if (!opts?.raw && text === 'bg') {
          throw new CliInputStallError('pending_in_ui', 'running', {
            waitReason: 'input_pending',
            terminal: terminal('❯ bg'),
          })
        }
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    const settlements: string[] = []

    await harness.sendToWorker(worker.worker_id, 'bg', {
      dedupeKey: 'bg-shell:1',
      onSettled: async (settlement) => { settlements.push(settlement) },
    })
    expect(settlements).toEqual([])

    await harness.sendToWorker(worker.worker_id, 'Enter', { raw: true })
    expect(settlements).toEqual(['delivered'])
  })

  it('kill dead-letters a durable receipt already pasted into a CLI composer', async () => {
    const { harness } = await makeHarness({
      implId: 'claude-code',
      sendInputBehavior: async (_h, text, opts) => {
        if (!opts?.raw && text === 'bg') {
          throw new CliInputStallError('pending_in_ui', 'running', {
            waitReason: 'input_pending',
            terminal: terminal('❯ bg'),
          })
        }
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    const settlements: string[] = []

    await harness.sendToWorker(worker.worker_id, 'bg', {
      dedupeKey: 'bg-shell:1',
      onSettled: async (settlement) => { settlements.push(settlement) },
    })
    await harness.killWorker(worker.worker_id, 'test')

    expect(settlements).toEqual(['dead_letter'])
  })

  it('adapter.spawn 失败 → 台账落 failed(经 queued→running→failed)、化身 exited(failed)、事件外发,错误抛给调用方', async () => {
    const boom = new Error('spawn 炸了')
    const { harness } = await makeHarness({ spawnShouldFail: boom })

    await expect(harness.spawnWorker(spawnParams())).rejects.toThrow('spawn 炸了')

    const listed = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(listed).toHaveLength(1)
    const worker = listed[0]
    expect(worker.task.status).toBe('halted')
    expect(worker.task.halt?.detail).toBe('spawn 炸了')
    expect(worker.incarnations[0].state).toBe('exited')
    expect(worker.incarnations[0].ended_reason).toBe('failed')

    const exitedEvents = events.filter((e) => e.kind === 'exited')
    expect(exitedEvents).toHaveLength(1)
    expect(exitedEvents[0].detail?.reason).toBe('spawn_failed')
  })
})

describe('WorkerHarness.handleStateChange', () => {
  it('原生 activity 落盘后才通知 child trace 收割回调', async () => {
    let workersDir!: string
    let observed: Promise<unknown> | undefined
    const onNativeActivityCollected = vi.fn((handle: IncarnationHandle) => {
      observed = fs.readFile(join(workersDir, handle.worker_id, 'native-activity.json'), 'utf8')
        .then((raw) => JSON.parse(raw))
    })
    const assembled = await makeHarness({
      nativeTrace: [
        { ts: '2026-08-20T00:00:00.000Z', kind: 'message', role: 'assistant', summary: '已完成子步骤' },
      ],
    }, { onNativeActivityCollected })
    const { harness, workersDir: actualWorkersDir } = assembled
    workersDir = actualWorkersDir
    const worker = await harness.spawnWorker(spawnParams())
    const incarnation = worker.incarnations[0]
    const handle = {
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: 'builtin' as const,
      session_ref: incarnation.session_ref,
    }

    harness.handleNativeActivity(handle)
    await waitUntil(() => onNativeActivityCollected.mock.calls.length === 1)

    await expect(observed).resolves.toMatchObject({
      cursors: [{ incarnation_id: incarnation.incarnation_id, offset: 1 }],
    })
  })

  it('assistant 原生 trace 只创建一条可重放 activity_available', async () => {
    const route = vi.fn(async () => ({ consumed: true }))
    const { harness, workersDir } = await makeHarness({
      nativeTrace: [
        { ts: '2026-08-20T00:00:00.000Z', kind: 'tool_call', role: 'assistant', summary: 'read file' },
        { ts: '2026-08-20T00:00:01.000Z', kind: 'message', role: 'assistant', summary: '已读取配置' },
      ],
    }, { onOperationNotification: route })
    const worker = await harness.spawnWorker(spawnParams())
    const incarnation = worker.incarnations[0]
    const handle = {
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: 'builtin' as const,
      session_ref: incarnation.session_ref,
    }

    harness.handleNativeActivity(handle)
    await waitUntil(async () => route.mock.calls.length === 1)
    harness.handleNativeActivity(handle)
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(route).toHaveBeenCalledTimes(1)
    expect(route.mock.calls[0][1]).toMatchObject({
      kind: 'activity_available',
      detail: { from_cursor: 'opaque-activity-start', through_cursor: 'opaque-activity-two', has_error: false },
    })
    expect(route.mock.calls[0][1].detail?.from_cursor).not.toBe('0')
    expect(route.mock.calls[0][1].detail?.through_cursor).not.toBe('2')
    expect(JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))).toMatchObject({
      cursors: [{ incarnation_id: incarnation.incarnation_id, offset: 2 }],
      notifications: [{ consumed_at: expect.any(String) }],
    })
  })

  it('activity receipt 注册后保持 pending 且进程内去重，admit 回调才结算', async () => {
    let receipt: ActivityContextAdmissionReceipt | undefined
    const route = vi.fn(async (_managerKey, _event, incomingReceipt?: ActivityContextAdmissionReceipt) => {
      receipt = incomingReceipt
      return { consumed: false, registered: true }
    })
    const { harness, workersDir } = await makeHarness({
      nativeTrace: [{ ts: '2026-08-20T00:00:00.000Z', kind: 'error', summary: 'automatic compaction failed' }],
    }, { onOperationNotification: route })
    const worker = await harness.spawnWorker(spawnParams())
    const incarnation = worker.incarnations[0]
    const handle = {
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: 'builtin' as const,
      session_ref: incarnation.session_ref,
    }
    const internals = harness as unknown as {
      deliverNativeActivityNotifications(workerId: string): Promise<void>
    }

    harness.handleNativeActivity(handle)
    await waitUntil(() => route.mock.calls.length === 1)
    await internals.deliverNativeActivityNotifications(worker.worker_id)

    expect(route).toHaveBeenCalledTimes(1)
    expect(receipt).toBeDefined()
    let state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))
    expect(state.notifications[0]).toMatchObject({ attempts: 0, has_error: true })
    expect(state.notifications[0]).not.toHaveProperty('consumed_at')

    await receipt!.admit()

    state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))
    expect(state.notifications[0]).toMatchObject({ consumed_at: expect.any(String) })
  })

  it('并发投递同一 activity 通知只追加一次审计事件', async () => {
    const route = vi.fn(async () => ({ consumed: true }))
    const { harness, workersDir } = await makeHarness({
      nativeTrace: [{ ts: '2026-08-20T00:00:00.000Z', kind: 'message', role: 'assistant', summary: '完成了当前步骤' }],
    }, { onOperationNotification: route })
    const worker = await harness.spawnWorker(spawnParams())
    const incarnation = worker.incarnations[0]
    const handle = {
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: 'builtin' as const,
      session_ref: incarnation.session_ref,
    }
    const internals = harness as unknown as {
      collectNativeActivity(handle: IncarnationHandle): Promise<void>
      deliverNativeActivityNotifications(workerId: string): Promise<void>
      getEventLog(workerId: string): WorkerEventLog
      nativeActivityStore: NativeActivityStore
    }
    await internals.collectNativeActivity(handle)
    const notification = (await internals.nativeActivityStore.pending(worker.worker_id))[0]
    if (!notification) throw new Error('expected pending native activity notification')

    let releaseFirstAppend!: () => void
    const firstAppend = new Promise<void>((resolve) => { releaseFirstAppend = resolve })
    let enteredFirstAppend!: () => void
    const appendStarted = new Promise<void>((resolve) => { enteredFirstAppend = resolve })
    const eventLog = internals.getEventLog(worker.worker_id)
    const append = eventLog.append.bind(eventLog)
    let holdFirstAppend = true
    vi.spyOn(eventLog, 'append').mockImplementation(async (event) => {
      if (holdFirstAppend && event.kind === 'activity_available') {
        holdFirstAppend = false
        enteredFirstAppend()
        await firstAppend
      }
      await append(event)
    })
    const due = vi.spyOn(internals.nativeActivityStore, 'due')

    const firstDelivery = internals.deliverNativeActivityNotifications(worker.worker_id)
    await appendStarted
    const secondDelivery = internals.deliverNativeActivityNotifications(worker.worker_id)
    const dueCallsWhileFirstAppendWaits = due.mock.calls.length
    releaseFirstAppend()
    await Promise.all([firstDelivery, secondDelivery])

    const storedEvents = (await fs.readFile(join(workersDir, worker.worker_id, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as HarnessEvent)
      .filter((event) => event.kind === 'activity_available')
    expect(dueCallsWhileFirstAppendWaits).toBe(1)
    expect(storedEvents).toHaveLength(1)
    expect(route).toHaveBeenCalledTimes(1)
  })

  it('连续 assistant activity 在 Manager 未消费时合并为一个 high-water notification', async () => {
    const nativeTrace: NormalizedTraceEvent[] = [
      { ts: '2026-08-20T00:00:00.000Z', kind: 'message', role: 'assistant', summary: '先完成第一步' },
    ]
    const route = vi.fn(async () => ({ consumed: false }))
    const { harness, workersDir } = await makeHarness({ nativeTrace }, { onOperationNotification: route })
    const worker = await harness.spawnWorker(spawnParams())
    const incarnation = worker.incarnations[0]
    const handle = {
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: 'builtin' as const,
      session_ref: incarnation.session_ref,
    }

    harness.handleNativeActivity(handle)
    await waitUntil(async () => route.mock.calls.length === 1)
    nativeTrace.push({ ts: '2026-08-20T00:00:01.000Z', kind: 'message', role: 'assistant', summary: '再完成第二步' })
    harness.handleNativeActivity(handle)
    await waitUntil(async () => {
      const state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))
      return state.cursors[0]?.offset === 2
    })

    const state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))
    expect(state.notifications).toHaveLength(1)
    expect(state.notifications[0]).toMatchObject({
      activity_from: 'opaque-activity-start',
      activity_through: 'opaque-activity-two',
      attempts: 1,
      event: {
        kind: 'activity_available',
        detail: {
          from_cursor: 'opaque-activity-start',
          through_cursor: 'opaque-activity-two',
          preview: '再完成第二步',
          has_error: false,
        },
      },
    })
  })

  it('assistant/error 无论到达顺序如何，合并通知都保留 error 标记和最早起点', async () => {
    const orders: NormalizedTraceEvent[][] = [
      [
        { ts: '2026-08-20T00:00:00.000Z', kind: 'message', role: 'assistant', summary: '先有普通进展' },
        { ts: '2026-08-20T00:00:01.000Z', kind: 'error', summary: '随后失败' },
      ],
      [
        { ts: '2026-08-20T00:00:00.000Z', kind: 'error', summary: '先发生失败' },
        { ts: '2026-08-20T00:00:01.000Z', kind: 'message', role: 'assistant', summary: '随后补充说明' },
      ],
    ]

    for (const order of orders) {
      const nativeTrace = [order[0]]
      const route = vi.fn(async () => ({ consumed: false }))
      const { harness, workersDir } = await makeHarness({ nativeTrace }, { onOperationNotification: route })
      const worker = await harness.spawnWorker(spawnParams())
      const incarnation = worker.incarnations[0]
      const handle = {
        worker_id: worker.worker_id,
        incarnation_id: incarnation.incarnation_id,
        seq: incarnation.seq,
        impl: 'builtin' as const,
        session_ref: incarnation.session_ref,
      }

      harness.handleNativeActivity(handle)
      await waitUntil(() => route.mock.calls.length === 1)
      nativeTrace.push(order[1])
      harness.handleNativeActivity(handle)
      await waitUntil(async () => {
        const state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))
        return state.cursors[0]?.offset === 2
      })

      const state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))
      expect(state.notifications).toHaveLength(1)
      expect(state.notifications[0]).toMatchObject({
        activity_from: 'opaque-activity-start',
        activity_through: 'opaque-activity-two',
        has_error: true,
        event: { kind: 'activity_available', detail: { has_error: true } },
      })
    }
  })

  it('error activity 在持久化和通知预览前使用既有脱敏器', async () => {
    const route = vi.fn(async () => ({ consumed: false }))
    const { harness, workersDir } = await makeHarness({
      nativeTrace: [{
        ts: '2026-08-20T00:00:00.000Z',
        kind: 'error',
        summary: 'upstream rejected secret-marker',
        detail: { message: 'upstream rejected secret-marker' },
      }],
    }, {
      onOperationNotification: route,
      redactFailureReason: (text) => text.replaceAll('secret-marker', '[redacted]'),
    })
    const worker = await harness.spawnWorker(spawnParams())
    const incarnation = worker.incarnations[0]

    harness.handleNativeActivity({
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: 'builtin',
      session_ref: incarnation.session_ref,
    })
    await waitUntil(() => route.mock.calls.length === 1)

    const raw = await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8')
    expect(raw).not.toContain('secret-marker')
    expect(JSON.parse(raw)).toMatchObject({
      activities: [{ kind: 'error', summary: 'upstream rejected [redacted]' }],
      notifications: [{
        has_error: true,
        preview: 'upstream rejected [redacted]',
        event: { detail: { has_error: true, preview: 'upstream rejected [redacted]' } },
      }],
    })
  })

  it('投递旧 activity 时出现新片段，会继续投递新的 high-water 而不错误消费', async () => {
    const nativeTrace: NormalizedTraceEvent[] = [
      { ts: '2026-08-20T00:00:00.000Z', kind: 'message', role: 'assistant', summary: 'first activity' },
    ]
    let releaseFirst!: () => void
    const firstDelivery = new Promise<void>((resolve) => { releaseFirst = resolve })
    const route = vi.fn(async () => {
      if (route.mock.calls.length === 1) await firstDelivery
      return { consumed: true }
    })
    const { harness, workersDir } = await makeHarness({ nativeTrace }, { onOperationNotification: route })
    const worker = await harness.spawnWorker(spawnParams())
    const incarnation = worker.incarnations[0]
    const handle = {
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: 'builtin' as const,
      session_ref: incarnation.session_ref,
    }

    harness.handleNativeActivity(handle)
    await waitUntil(() => route.mock.calls.length === 1)
    nativeTrace.push({ ts: '2026-08-20T00:00:01.000Z', kind: 'message', role: 'assistant', summary: 'second activity' })
    harness.handleNativeActivity(handle)
    await waitUntil(async () => JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8')).cursors[0]?.offset === 2)
    releaseFirst()
    await waitUntil(() => route.mock.calls.length === 2)
    await waitUntil(async () => {
      const state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))
      return typeof state.notifications[0]?.consumed_at === 'string'
    })

    expect(route.mock.calls[1][1]).toMatchObject({
      detail: { from_cursor: 'opaque-activity-start', through_cursor: 'opaque-activity-two' },
    })
    const state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))
    expect(state.notifications[0]).toMatchObject({ activity_through: 'opaque-activity-two', consumed_at: expect.any(String) })
  })

  it('未消费通知按持久指数退避重投，合并 activity 不重置其节奏', async () => {
    const nativeTrace: NormalizedTraceEvent[] = [
      { ts: '2026-08-20T00:00:00.000Z', kind: 'message', role: 'assistant', summary: 'first activity' },
    ]
    const route = vi.fn(async () => ({ consumed: false }))
    const { harness, workersDir } = await makeHarness({ nativeTrace }, { onOperationNotification: route })
    const worker = await harness.spawnWorker(spawnParams())
    const incarnation = worker.incarnations[0]
    const handle = {
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: 'builtin' as const,
      session_ref: incarnation.session_ref,
    }
    const internals = harness as unknown as {
      deliverNativeActivityNotifications(workerId: string): Promise<void>
    }

    harness.handleNativeActivity(handle)
    await waitUntil(() => route.mock.calls.length === 1)
    await waitUntil(async () => {
      const state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))
      return state.notifications[0]?.attempts === 1
    })
    let state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))
    expect(state.notifications[0]).toMatchObject({ attempts: 1, retry_after_at: expect.any(String) })
    const firstRetryAt = state.notifications[0].retry_after_at
    expect(Date.parse(firstRetryAt) - nowValue).toBe(30_000)

    nativeTrace.push({ ts: '2026-08-20T00:00:01.000Z', kind: 'message', role: 'assistant', summary: 'merged activity' })
    harness.handleNativeActivity(handle)
    await waitUntil(async () => JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8')).cursors[0]?.offset === 2)
    state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))
    expect(route).toHaveBeenCalledTimes(1)
    expect(state.notifications[0]).toMatchObject({
      attempts: 1,
      retry_after_at: firstRetryAt,
      activity_through: 'opaque-activity-two',
    })

    const delays = [60_000, 120_000, 300_000, 300_000]
    for (let attempt = 2; attempt <= 5; attempt++) {
      const previousRetryAt = Date.parse(state.notifications[0].retry_after_at)
      nowValue = previousRetryAt - 1_000
      await internals.deliverNativeActivityNotifications(worker.worker_id)
      state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))
      expect(state.notifications[0].attempts).toBe(attempt)
      expect(Date.parse(state.notifications[0].retry_after_at) - previousRetryAt).toBe(delays[attempt - 2] + 1_000)
    }
    expect(route).toHaveBeenCalledTimes(5)
  })

  it('tool-only 原生 trace 只推进 high-water，不唤醒 Manager', async () => {
    const route = vi.fn(async () => ({ consumed: true }))
    const { harness, workersDir } = await makeHarness({
      nativeTrace: [{ ts: '2026-08-20T00:00:00.000Z', kind: 'tool_call', role: 'assistant', summary: 'read file' }],
    }, { onOperationNotification: route })
    const worker = await harness.spawnWorker(spawnParams())
    const incarnation = worker.incarnations[0]

    harness.handleNativeActivity({
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: 'builtin',
      session_ref: incarnation.session_ref,
    })
    await waitUntil(async () => {
      try {
        const state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))
        return state.cursors[0]?.offset === 1
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    })

    expect(route).not.toHaveBeenCalled()
  })

  it('五分钟活性巡检会无 TUI 对账 CLI 原生 session，作为文件监听的漏事件兜底', async () => {
    const route = vi.fn(async () => ({ consumed: true }))
    const { harness, fake } = await makeHarness({
      implId: 'claude-code',
      nativeTrace: [{ ts: '2026-08-20T00:00:00.000Z', kind: 'message', role: 'assistant', summary: 'missed file watch activity' }],
    }, { onOperationNotification: route })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })

    await harness.sweepLiveness()

    expect(route).toHaveBeenCalledWith(
      `test::friend-1`,
      expect.objectContaining({ worker_id: worker.worker_id, kind: 'activity_available' }),
      expect.objectContaining({ notification_id: expect.any(String), activity_through: 'opaque-activity-one' }),
    )
    expect(fake.readTerminalCalls).toEqual([])
  })

  it('未消费的 activity 和 completed turn 通知会从持久记录重放', async () => {
    let consume = false
    const route = vi.fn(async () => ({ consumed: consume }))
    const { harness } = await makeHarness({
      nativeTrace: [{ ts: '2026-08-20T00:00:00.000Z', kind: 'message', role: 'assistant', summary: '待交付' }],
    }, { onOperationNotification: route })
    const worker = await harness.spawnWorker(spawnParams())
    const incarnation = worker.incarnations[0]
    const handle = {
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: 'builtin' as const,
      session_ref: incarnation.session_ref,
    }

    harness.handleNativeActivity(handle)
    await waitUntil(async () => route.mock.calls.length === 1)
    harness.handleStateChange(handle, 'idle', { completionSource: 'builtin_end_turn' })
    await waitUntil(async () => (await harness.getWorkerTurn(worker.worker_id)) !== undefined)
    consume = true
    nowValue += 5 * 60_000
    await harness.reconcileNativeActivityOnStartup()

    expect(route.mock.calls.map((call) => call[1].kind)).toContain('activity_available')
    expect(route.mock.calls.map((call) => call[1].kind)).toContain('turn_completed')
    expect((await harness.getWorkerTurn(worker.worker_id))?.disposition).toEqual({ status: 'pending' })
  })

  it('启动重放旧版数字 offset activity 前原子升级为 durable opaque cursor', async () => {
    const route = vi.fn(async (
      _managerKey: ManagerKey,
      _event: HarnessEvent,
      receipt?: ActivityContextAdmissionReceipt,
    ) => {
      await receipt?.admit()
      return { consumed: false, registered: true }
    })
    const { harness, workersDir } = await makeHarness({}, { onOperationNotification: route })
    const worker = await harness.spawnWorker(spawnParams())
    const incarnation = worker.incarnations[0]
    const activityStore = new NativeActivityStore(workersDir)
    await activityStore.record({
      worker_id: worker.worker_id,
      manager_key: `test::friend-1` as ManagerKey,
      incarnation_id: incarnation.incarnation_id,
      impl: incarnation.impl,
      seq: incarnation.seq,
      activity_from: '0',
      activity_through: '1',
      preview: 'legacy pending activity',
      has_error: true,
      event: {
        ts: '2026-08-20T00:00:00.000Z',
        kind: 'activity_available',
        worker_id: worker.worker_id,
        seq: incarnation.seq,
        detail: {
          incarnation_id: incarnation.incarnation_id,
          from_cursor: '0',
          through_cursor: '1',
          preview: 'legacy pending activity',
          has_error: true,
        },
      },
    })

    await harness.reconcileNativeActivityOnStartup()

    expect(route).toHaveBeenCalledWith(
      `test::friend-1`,
      expect.objectContaining({
        kind: 'activity_available',
        detail: expect.objectContaining({
          from_cursor: 'opaque-activity-start',
          through_cursor: 'opaque-activity-one',
        }),
      }),
      expect.objectContaining({ activity_through: 'opaque-activity-one' }),
    )
    const state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))
    expect(state.notifications[0]).toMatchObject({
      activity_from: 'opaque-activity-start',
      activity_through: 'opaque-activity-one',
      consumed_at: expect.any(String),
      event: {
        detail: {
          from_cursor: 'opaque-activity-start',
          through_cursor: 'opaque-activity-one',
        },
      },
    })
  })

  it('旧版 activity cursor 升级失败时保留通知并按既有退避记账', async () => {
    const route = vi.fn(async () => ({ consumed: true }))
    const { harness, workersDir } = await makeHarness({}, {
      onOperationNotification: route,
      mintActivityCursor: async () => { throw new Error('cursor store unavailable') },
    })
    const worker = await harness.spawnWorker(spawnParams())
    const incarnation = worker.incarnations[0]
    const activityStore = new NativeActivityStore(workersDir)
    await activityStore.record({
      worker_id: worker.worker_id,
      manager_key: `test::friend-1` as ManagerKey,
      incarnation_id: incarnation.incarnation_id,
      impl: incarnation.impl,
      seq: incarnation.seq,
      activity_from: '0',
      activity_through: '1',
      preview: 'legacy pending activity',
      event: {
        ts: '2026-08-20T00:00:00.000Z',
        kind: 'activity_available',
        worker_id: worker.worker_id,
        seq: incarnation.seq,
        detail: { from_cursor: '0', through_cursor: '1', preview: 'legacy pending activity' },
      },
    })
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await harness.reconcileNativeActivityOnStartup()

    expect(route).not.toHaveBeenCalled()
    const state = JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))
    expect(state.notifications[0]).toMatchObject({
      activity_from: '0',
      activity_through: '1',
      attempts: 1,
      retry_after_at: expect.any(String),
    })
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('native activity notification failed'),
      expect.any(Error),
    )
  })

  it('启动只为未观察过的活跃会话建立高水位，不把已有文本当作新 activity', async () => {
    const route = vi.fn(async () => ({ consumed: true }))
    const nativeTrace = [{ ts: '2026-08-20T00:00:00.000Z', kind: 'message' as const, role: 'assistant' as const, summary: '升级前的历史文本' }]
    const { harness, workersDir } = await makeHarness({ nativeTrace }, { onOperationNotification: route })
    const worker = await harness.spawnWorker(spawnParams())
    const incarnation = worker.incarnations[0]
    const handle = {
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: 'builtin' as const,
      session_ref: incarnation.session_ref,
    }

    await harness.reconcileNativeActivityOnStartup()

    expect(route).not.toHaveBeenCalled()
    expect(JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8'))).toMatchObject({
      cursors: [expect.objectContaining({ incarnation_id: incarnation.incarnation_id, offset: 1 })],
      activities: [],
      notifications: [],
    })

    nativeTrace.push({ ts: '2026-08-20T00:00:01.000Z', kind: 'message', role: 'assistant', summary: '重启后的新文本' })
    harness.handleNativeActivity(handle)
    await waitUntil(() => route.mock.calls.length === 1)
    expect(route).toHaveBeenCalledWith(
      `test::friend-1`,
      expect.objectContaining({
        kind: 'activity_available',
        detail: expect.objectContaining({ from_cursor: 'opaque-activity-one', through_cursor: 'opaque-activity-two' }),
      }),
      expect.objectContaining({ notification_id: expect.any(String), activity_through: 'opaque-activity-two' }),
    )
  })

  it('终态化身不再重读原生会话或制造 activity 通知', async () => {
    const route = vi.fn(async () => ({ consumed: true }))
    const { harness, fake, workersDir } = await makeHarness({
      nativeTrace: [{ ts: '2026-08-20T00:00:00.000Z', kind: 'message', role: 'assistant', summary: '历史结论' }],
    }, { onOperationNotification: route })
    const worker = await harness.spawnWorker(spawnParams())
    const handle = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }
    fake.emitStateChange(handle, 'exited', undefined, 'completed')
    await waitUntil(async () => (await harness.listWorkers(`test::friend-1` as ManagerKey))[0]?.task.status === 'halted')
    await waitUntil(async () => JSON.parse(await fs.readFile(join(workersDir, worker.worker_id, 'native-activity.json'), 'utf8')).cursors[0]?.offset === 1)
    await waitUntil(() => route.mock.calls.some(([, event]) => event.kind === 'activity_available'))
    route.mockClear()
    const readTrace = vi.spyOn(fake, 'readTrace')
    const internals = harness as unknown as { collectNativeActivity(handle: typeof handle): Promise<void> }

    await internals.collectNativeActivity(handle)
    await harness.reconcileNativeActivityOnStartup()

    expect(readTrace).not.toHaveBeenCalled()
    expect(route.mock.calls.filter(([, event]) => event.kind === 'activity_available')).toEqual([])
  })

  it('单个原生会话读取失败不阻断其它 worker 的 activity 基线对账', async () => {
    const route = vi.fn(async () => ({ consumed: true }))
    const { harness, fake, workersDir } = await makeHarness({}, { onOperationNotification: route })
    const unreadable = await harness.spawnWorker(spawnParams({ title: '不可读会话' }))
    const readable = await harness.spawnWorker(spawnParams({ title: '可读会话' }))
    vi.spyOn(fake, 'readTrace').mockImplementation(async (handle) => {
      if (handle.worker_id === unreadable.worker_id) throw new Error('session unavailable')
      return {
        events: [{ ts: '2026-08-20T00:00:00.000Z', kind: 'message', role: 'assistant', summary: '后续 worker 的进展' }],
        nextCursor: { offset: 1 },
      }
    })
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(harness.reconcileNativeActivityOnStartup()).resolves.toBeUndefined()

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(`native activity reconciliation failed for ${unreadable.worker_id}#1`),
      expect.any(Error),
    )
    const readableState = JSON.parse(await fs.readFile(join(workersDir, readable.worker_id, 'native-activity.json'), 'utf8'))
    expect(readableState.cursors).toEqual([expect.objectContaining({ incarnation_id: readable.incarnations[0].incarnation_id, offset: 1 })])
    expect(route).not.toHaveBeenCalled()
  })

  it('单个 control operation store 读取失败不阻断其它 worker 的对账', async () => {
    const { harness } = await makeHarness()
    const unavailable = await harness.spawnWorker(spawnParams({ title: '不可读 control store' }))
    const later = await harness.spawnWorker(spawnParams({ title: '后续 control store' }))
    const controlOperationStore = (harness as unknown as {
      controlOperationStore: { active(workerId: string): Promise<unknown[]> }
    }).controlOperationStore
    const active = vi.spyOn(controlOperationStore, 'active').mockImplementation(async (workerId) => {
      if (workerId === unavailable.worker_id) throw new Error('control store unavailable')
      return []
    })
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(harness.reconcileControlOperationsOnStartup()).resolves.toBeUndefined()

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(`control operation reconciliation failed for ${unavailable.worker_id}`),
      expect.any(Error),
    )
    expect(active).toHaveBeenCalledWith(later.worker_id)
  })

  it('activity 通知落盘失败不阻断已确认的回合和状态事件', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    const activityStore = (harness as unknown as { nativeActivityStore: NativeActivityStore }).nativeActivityStore
    const persistError = vi.spyOn(activityStore, 'record').mockRejectedValueOnce(new Error('activity disk unavailable'))
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    events.length = 0

    fake.emitStateChange(
      { worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` },
      'idle',
    )
    await waitUntil(() => events.some((event) => event.kind === 'state_changed'))

    expect((await harness.getWorkerTurn(worker.worker_id))?.disposition).toEqual({ status: 'pending' })
    expect(events.find((event) => event.kind === 'state_changed')?.detail).toMatchObject({
      to: 'idle',
      turn_id: expect.any(String),
      turn_pending: true,
    })
    expect(persistError).toHaveBeenCalledOnce()
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('failed to persist completed-turn notification'),
      expect.any(Error),
    )
  })

  it('Manager 路由下的游离通知失败只记录，不形成未处理拒绝', async () => {
    const { harness, fake } = await makeHarness({}, { onOperationNotification: async () => ({ consumed: false }) })
    const worker = await harness.spawnWorker(spawnParams())
    const internals = harness as unknown as {
      createPendingTurn(
        managerKey: ManagerKey,
        handle: IncarnationHandle,
        report: StateChangeReport,
        completedAt: string,
      ): Promise<unknown>
      deliverNativeActivityNotifications(workerId: string): Promise<void>
      deliverControlOperationNotifications(workerId: string): Promise<void>
    }
    const activityError = new Error('native activity store unavailable')
    const controlError = new Error('control operation store unavailable')
    const activityDelivery = vi.spyOn(internals, 'deliverNativeActivityNotifications').mockRejectedValueOnce(activityError)
    const controlDelivery = vi.spyOn(internals, 'deliverControlOperationNotifications').mockRejectedValueOnce(controlError)
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const incarnation = worker.incarnations[0]
    await internals.createPendingTurn(
      `test::friend-1` as ManagerKey,
      {
        worker_id: worker.worker_id,
        incarnation_id: incarnation.incarnation_id,
        seq: incarnation.seq,
        impl: 'builtin',
        session_ref: incarnation.session_ref,
      },
      { completionSource: 'builtin_end_turn' },
      '2026-01-01T00:00:00.000Z',
    )
    await waitUntil(async () => activityDelivery.mock.calls.length === 1)
    await expect(harness.requestWorkerStop(worker.worker_id)).resolves.toMatchObject({ status: 'succeeded' })
    await waitUntil(async () => controlDelivery.mock.calls.length === 1)

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(`native activity notification delivery failed for ${worker.worker_id}`),
      activityError,
    )
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining(`control operation notification delivery failed for ${worker.worker_id}`),
      controlError,
    )
  })

  it('状态回调驱动台账 task.status 与化身 state,并经 onEvent 外发', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    fake.emitStateChange({ worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` }, 'idle')

    // handleStateChange 签名对齐 adapter 的同步回调(h, state) => void,内部是 fire-and-forget
    // 的异步台账更新——用轮询等待收敛(与 tests/workers/contract-suite.ts 的 waitForState
    // 同一套路,不是"睡一下猜时序",是"有界轮询直到可观察结果达到预期,超时即失败")。
    await waitUntil(() => events.some((event) => event.kind === 'state_changed'))

    const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(w.task.status).toBe('halted')
    expect(w.incarnations[0].state).toBe('idle')

    const stateEvents = events.filter((e) => e.kind === 'state_changed')
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0].detail).toMatchObject({ to: 'idle', turn_pending: true, turn_id: expect.any(String) })

    // 化身自然结束(非 kill)→ exited;task 已在 idle 拍落 halted,不再二次迁移
    fake.emitStateChange({ worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` }, 'exited')
    await waitUntil(async () => {
      const [w2] = await harness.listWorkers(`test::friend-1` as ManagerKey)
      return w2.incarnations[0].state === 'exited'
    })
    const [w2] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(w2.task.status).toBe('halted')
    expect(w2.incarnations[0].ended_reason).toBe('completed')
  })

  it('异步 stop 在 exited 状态回调后才结算并取消任务', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    const incarnation = worker.incarnations[0]
    const handle: IncarnationHandle = {
      worker_id: worker.worker_id,
      incarnation_id: incarnation.incarnation_id,
      seq: incarnation.seq,
      impl: 'builtin',
      session_ref: incarnation.session_ref,
    }
    vi.spyOn(fake, 'kill').mockImplementation(async (h) => {
      fake.killCalls.push(h)
    })

    await expect(harness.requestWorkerStop(worker.worker_id)).resolves.toMatchObject({ status: 'verifying' })
    expect((await harness.listWorkers(`test::friend-1` as ManagerKey))[0].task.status).toBe('running')

    fake.emitStateChange(handle, 'exited', undefined, 'killed')
    await waitUntil(async () => (await harness.listWorkers(`test::friend-1` as ManagerKey))[0].task.status === 'closed')
    expect(await harness.getWorkerControlOperations(worker.worker_id)).toEqual([])
  })

  it('已停止主线后的 fork stop 抛错由核验收口，不把整次 stop 判为 failed', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    await harness.queryWorker(worker.worker_id, '侧问一下')
    const originalState = fake.state.bind(fake)
    const logWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    vi.spyOn(fake, 'stop').mockImplementation(async (handle) => {
      if (handle.seq === 2) throw new Error('fork is no longer resident')
      await fake.kill(handle)
    })
    vi.spyOn(fake, 'state').mockImplementation(async (handle) => {
      // The adapter's process-local fork is gone, while its durable native state confirms exit.
      if (handle.seq === 2) return 'exited'
      return originalState(handle)
    })

    await expect(harness.requestWorkerStop(worker.worker_id)).resolves.toMatchObject({ status: 'succeeded' })

    const [stored] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(stored.task.status).toBe('closed')
    expect(stored.incarnations).toEqual(expect.arrayContaining([
      expect.objectContaining({ seq: 1, state: 'exited', ended_reason: 'killed' }),
      expect.objectContaining({ seq: 2, state: 'exited', ended_reason: 'killed' }),
    ]))
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining(`failed to stop registered fork ${worker.worker_id}#2`),
      expect.any(Error),
    )
  })

  it('停止核验的 bg 查询异常结算 unknown，不遗留 verifying operation', async () => {
    const { harness } = await makeHarness({}, {
      hasRunningBg: async () => { throw new Error('bg registry unavailable') },
    })
    const worker = await harness.spawnWorker(spawnParams())

    await expect(harness.requestWorkerStop(worker.worker_id)).resolves.toMatchObject({
      status: 'unknown',
      detail: 'bg registry unavailable',
    })

    expect(await harness.getWorkerControlOperations(worker.worker_id)).toEqual([])
    expect((await harness.listWorkers(`test::friend-1` as ManagerKey))[0].task.status).toBe('running')
  })

  it('stop 核验 unknown 且无 bg → task 落 halted(stop_unverified)，operation_settled 携带 halted(现网缺口修复)', async () => {
    const opEvents: HarnessEvent[] = []
    const { harness, fake } = await makeHarness({}, {
      hasRunningBg: async () => false,
      onOperationNotification: async (_managerKey, e) => { opEvents.push(e); return { consumed: true } },
    })
    const worker = await harness.spawnWorker(spawnParams())
    // 核验阶段 adapter.state 不可用 → 结算 unknown
    vi.spyOn(fake, 'state').mockRejectedValue(new Error('tmux session gone'))

    await expect(harness.requestWorkerStop(worker.worker_id)).resolves.toMatchObject({ status: 'unknown' })

    const [stored] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(stored.task.status).toBe('halted')
    expect(stored.task.halt?.stop_unverified).toBe(true)
    // 修复前：这次 halted 迁移没有任何事件携带，Admin 收不到推送；现在由唯一回执承载。
    await waitUntil(() => opEvents.some((e) => e.kind === 'operation_settled'))
    const settled = opEvents.find((e) => e.kind === 'operation_settled')!
    expect(settled.detail?.status).toBe('unknown')
    expect(settled.task_status).toBe('halted')
  })

  it('同步 stop 退出在核验 unknown 后仍保留 task 状态，重启对账也不改写成 cancelled 或 failed', async () => {
    const { harness, fake } = await makeHarness({}, { hasRunningBg: async () => true })
    const worker = await harness.spawnWorker(spawnParams())
    const incarnation = worker.incarnations[0]
    vi.spyOn(fake, 'kill').mockImplementation(async (handle) => {
      fake.killCalls.push(handle)
      fake.emitStateChange(handle, 'exited', undefined, 'killed')
    })

    await expect(harness.requestWorkerStop(worker.worker_id)).resolves.toMatchObject({
      status: 'unknown',
      detail: 'worker-owned background execution remains active',
    })
    await waitUntil(async () => {
      const [stored] = await harness.listWorkers(`test::friend-1` as ManagerKey)
      return stored.task.status === 'running' && stored.incarnations[0].state === 'exited'
    })

    await expect(harness.reconcileOnStartup()).resolves.toMatchObject({ unchanged: [worker.worker_id] })
    const [stored] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(stored.task.status).toBe('running')
    expect(stored.incarnations[0]).toMatchObject({
      incarnation_id: incarnation.incarnation_id,
      state: 'exited',
      ended_reason: 'killed',
    })
  })

  it('idle 且名下仍有运行中的 bg shell 时保持 running，而不是 waiting_input', async () => {
    const { harness, fake } = await makeHarness({}, { hasRunningBg: async () => true })
    const worker = await harness.spawnWorker(spawnParams())
    fake.emitStateChange(
      { worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` },
      'idle',
    )

    await waitUntil(async () => (await harness.listWorkers(`test::friend-1` as ManagerKey))[0]?.incarnations[0]?.state === 'idle')
    const [stored] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(stored.task.status).toBe('running')
  })

  it('idle 且 bg 退出通知尚未入 inbox 时保持 running，通知完成后无 bg 才能 waiting_input', async () => {
    const { harness, fake } = await makeHarness({}, { hasRunningBg: async () => false })
    const worker = await harness.spawnWorker(spawnParams())
    const complete = harness.beginBgNotification(worker.worker_id)
    const handle = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }

    fake.emitStateChange(handle, 'idle')
    await waitUntil(async () => (await harness.listWorkers(`test::friend-1` as ManagerKey))[0]?.incarnations[0]?.state === 'idle')
    expect((await harness.listWorkers(`test::friend-1` as ManagerKey))[0].task.status).toBe('running')

    complete()
    fake.emitStateChange(handle, 'idle')
    await waitUntil(async () => (await harness.listWorkers(`test::friend-1` as ManagerKey))[0]?.task.status === 'halted')
  })

  it('CLI交互Notification映射为固定manager-facing detail，不泄漏内部notification对象', async () => {
    const { harness } = await makeHarness({ implId: 'claude-code' })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    events.length = 0
    const h: IncarnationHandle = {
      worker_id: worker.worker_id,
      seq: 1,
      impl: 'claude-code',
      session_ref: `ref-${worker.worker_id}#1`,
    }

    harness.handleStateChange(h, 'idle', {
      waitReason: 'interaction_required',
      terminal: terminal('AskUserQuestion\n  Yes\n  No'),
      ui: { fingerprint: 'question:yes-no', actions: UI_ACTIONS },
      notification: { type: 'permission_prompt', message: 'Choose', title: 'Question' },
    })
    await waitUntil(() => events.some((event) => event.kind === 'interaction_required'))

    const detail = events.find((event) => event.kind === 'interaction_required')?.detail
    expect(detail).toMatchObject({
      to: 'idle',
      wait_mode: 'action',
      wait_reason: 'interaction_required',
      notification_type: 'permission_prompt',
      message: 'Choose',
      title: 'Question',
    })
    expect(detail).toMatchObject({ snapshot_id: expect.any(String), actions: UI_ACTIONS })
    expect(detail).not.toHaveProperty('notification')
  })

  it('自动处理失败也把同一受限 UI snapshot 和 actions 直接交给 Manager', async () => {
    const { harness } = await makeHarness({ implId: 'claude-code' })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    events.length = 0
    const h: IncarnationHandle = {
      worker_id: worker.worker_id,
      seq: 1,
      impl: 'claude-code',
      session_ref: `ref-${worker.worker_id}#1`,
    }

    harness.handleStateChange(h, 'idle', {
      waitReason: 'interaction_required',
      terminal: terminal('Exit plan mode?'),
      ui: { fingerprint: 'claude_exit_plan:1-2', actions: UI_ACTIONS },
      notification: { type: 'automatic_interaction_failed' },
    })
    await waitUntil(() => events.some((event) => event.kind === 'interaction_required'))

    expect(events.find((event) => event.kind === 'interaction_required')?.detail).toMatchObject({
      notification_type: 'automatic_interaction_failed',
      text: 'Exit plan mode?',
      snapshot_id: expect.any(String),
      snapshot_expires_at: expect.any(String),
      actions: UI_ACTIONS,
    })
  })

  it('主线 idle/exited 各创建一个待处置回合，重复状态和 notification-only 不重复创建', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    const handle = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }

    fake.emitStateChange(handle, 'idle', '第一轮结束')
    await waitUntil(async () => (await harness.getWorkerTurn(worker.worker_id))?.completion_source === 'builtin_end_turn')
    const idleTurn = await harness.getWorkerTurn(worker.worker_id)

    harness.handleStateChange(handle, 'idle')
    await harness.sendToWorker(worker.worker_id, '作为同锁屏障')
    expect((await harness.getWorkerTurn(worker.worker_id))?.turn_id).toBe(idleTurn?.turn_id)

    fake.emitStateChange(handle, 'exited', undefined, 'completed')
    await waitUntil(async () => (await harness.getWorkerTurn(worker.worker_id))?.turn_id !== idleTurn?.turn_id)
    const exitedTurn = await harness.getWorkerTurn(worker.worker_id)
    expect(exitedTurn?.turn_id).not.toBe(idleTurn?.turn_id)

    const notificationWorker = await harness.spawnWorker(spawnParams())
    const notificationHandle = { worker_id: notificationWorker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${notificationWorker.worker_id}#1` }
    harness.handleStateChange(notificationHandle, 'idle', {
      waitReason: 'interaction_required',
      notification: { type: 'permission_prompt', message: '请选择' },
    })
    await waitUntil(() => events.some((event) => event.worker_id === notificationWorker.worker_id && event.kind === 'interaction_required'))
    expect(await harness.getWorkerTurn(notificationWorker.worker_id)).toBeUndefined()
  })

  it('CLI 从等待交互回到普通输入态时，即使契约态仍为 idle 也创建完成回合', async () => {
    const { harness, fake } = await makeHarness({ implId: 'claude-code' })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    const handle = { worker_id: worker.worker_id, seq: 1, impl: 'claude-code' as const, session_ref: `ref-${worker.worker_id}#1` }

    harness.handleStateChange(handle, 'idle', {
      waitReason: 'interaction_required',
      notification: { type: 'permission_prompt', message: '请选择' },
    })
    await waitUntil(() => events.some((event) => event.worker_id === worker.worker_id && event.kind === 'interaction_required'))
    expect(await harness.getWorkerTurn(worker.worker_id)).toBeUndefined()

    fake.emitStateChange(handle, 'idle', '交互完成后的本轮结果')
    await waitUntil(async () => (await harness.getWorkerTurn(worker.worker_id))?.completion_source === 'claude_stop')
    await waitUntil(() => events.some((event) =>
      event.worker_id === worker.worker_id &&
      event.kind === 'state_changed' &&
      typeof event.detail?.turn_id === 'string',
    ))

    const detail = events.filter((event) => event.worker_id === worker.worker_id && event.kind === 'state_changed').at(-1)?.detail
    expect(detail).toMatchObject({ to: 'idle', turn_id: expect.any(String), turn_pending: true })
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
      const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
      return w.task.status === 'halted'
    })
    const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(w.task.status).toBe('halted')
    expect(w.incarnations[0].ended_reason).toBe('failed')

    // 对外事件带的是提交后的 task.status——manager 的台账块、admin 侧读端点看的都是这一份。
    const stateEvents = events.filter((e) => e.kind === 'state_changed')
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0].task_status).toBe('halted')
  })

  it('adapter 上报 endReason=crashed → 台账落 crashed,task.status=failed', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())

    const h = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }
    fake.emitStateChange(h, 'exited', undefined, 'crashed')

    await waitUntil(async () => {
      const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
      return w.task.status === 'halted'
    })
    const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
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
      const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
      return w.incarnations[0].state === 'exited'
    })
    const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(w.task.status).toBe('halted')
    expect(w.incarnations[0].ended_reason).toBeUndefined() // 不编造原因
  })

  it('契约断言:state 非 exited 却带了 endReason → handleStateChange 同步抛错,不写台账', async () => {
    // endReason 只在 exited 时有意义。running/idle 带着终止原因进来说明调用方的状态机接错
    // 了线,静默忽略会让台账落进说不清的中间态。抛给 adapter,由它自己的 try/catch 记
    // console.error(观察者异常不中断状态机推进,三个 adapter 都是这么包的)。
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    const h = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }

    expect(() => harness.handleStateChange(h, 'idle', { endReason: 'failed' })).toThrow(/only meaningful for state 'exited'/)
    expect(() => harness.handleStateChange(h, 'running', { endReason: 'completed' })).toThrow(/only meaningful for state 'exited'/)

    // 台账没有被这次非法回调改动过。
    const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
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
    expect(ev.detail).toMatchObject({
      to: 'idle',
      text: '调研完成,结论是 X 方案可行。',
      turn_id: expect.any(String),
      turn_pending: true,
    })
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
    // 保留头部 2000 字符；完整文本可由结构化活动流提供，不伪造终端历史入口。
    expect(text.startsWith('啊'.repeat(2000))).toBe(true)
    expect(text).toContain('已截断')
    expect(text).toContain('2600')
    expect(text).not.toContain('get_worker_terminal')
    expect(text.length).toBeLessThan(2000 + 100)
  })

  it('finish_task 的 summary 单独成字段进 detail,与 text 并列(两者互不替代)', async () => {
    // 直接调 harness.handleStateChange 而不经 FakeAdapter:这里要验的是 harness 对
    // report.summary 的处理,桩多包一层只会挡住被测面(与本文件"防守分支"那条同款做法)。
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const h = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }
    harness.handleStateChange(h, 'exited', {
      endReason: 'completed',
      completionSource: 'builtin_end_turn',
      lastText: '  已经全部跑完了。  ',
      summary: '  盘点完成:三处配置漂移已修正,另有一处需人工确认。  ',
    })

    await waitUntil(() => events.some((e) => e.kind === 'state_changed'))
    const [ev] = events.filter((e) => e.kind === 'state_changed')
    expect(ev.detail).toMatchObject({
      to: 'exited',
      text: '已经全部跑完了。',
      summary: '盘点完成:三处配置漂移已修正,另有一处需人工确认。',
      turn_id: expect.any(String),
      turn_pending: true,
    })
  })

  it('CLI 终端画面不随状态事件自动转发，manager 需要时再显式读取', async () => {
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const terminalText = '[crabot] claude-code 启动后 60s 内未就绪\n---\nNew MCP server found in this project: arXivPaper'
    const h = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }
    harness.handleStateChange(h, 'idle', { terminal: terminal(terminalText), waitReason: 'interaction_required' })

    await waitUntil(() => events.some((e) => e.kind === 'state_changed'))
    const [ev] = events.filter((e) => e.kind === 'state_changed')
    expect(ev.detail).toMatchObject({ to: 'idle', wait_reason: 'interaction_required' })
    expect(ev.detail).not.toHaveProperty('text')
    expect(JSON.stringify(ev.detail)).not.toContain(terminalText)
  })

  it('lastText 与 summary 仍然保**头部**——发言开门见山给结论,截断方向不能跟终端画面混成一个', async () => {
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const h = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }
    harness.handleStateChange(h, 'exited', {
      endReason: 'completed',
      lastText: '结论在开头:' + '啊'.repeat(2600),
      summary: '总结在开头:' + '哦'.repeat(4600),
    })

    await waitUntil(() => events.some((e) => e.kind === 'state_changed'))
    const [ev] = events.filter((e) => e.kind === 'state_changed')
    const detail = ev.detail as { text: string; summary: string }
    expect(detail.text.startsWith('结论在开头:')).toBe(true)
    expect(detail.summary.startsWith('总结在开头:')).toBe(true)
  })

  it('adapter 没给 summary 时 detail 里不出现空 summary 字段(cc/codex 与非 finish_task 的终止路径)', async () => {
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const h = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }
    harness.handleStateChange(h, 'exited', { endReason: 'crashed' })

    // crashed 退出已降审计（唤醒由 worker_recovery_required 承载）：读 events.jsonl 验证
    // detail 形状——审计与唤醒共用同一个 detail 构造函数。
    await waitUntil(async () => (await harness.readWorkerEvents(worker.worker_id)).some((e) => e.kind === 'state_changed'))
    const [ev] = (await harness.readWorkerEvents(worker.worker_id)).filter((e) => e.kind === 'state_changed')
    expect(ev.detail).toMatchObject({ to: 'exited' })
  })

  it('过长的 summary 按更宽的一次性上限截断，且不指向已移除的输出读取接口', async () => {
    // summary 是一次性成本(只在化身落终态那一次产生一条),上限比每轮都付一遍的 text 宽
    // 一倍。没有可读回全文的终端输出接口，截断标记不能指向不存在的入口。
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const long = '啊'.repeat(4600)
    const h = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }
    harness.handleStateChange(h, 'exited', { endReason: 'completed', summary: long })

    await waitUntil(() => events.some((e) => e.kind === 'state_changed'))
    const [ev] = events.filter((e) => e.kind === 'state_changed')
    const summary = (ev.detail as { summary: string }).summary
    expect(summary.startsWith('啊'.repeat(4096))).toBe(true)
    expect(summary).toContain('已截断')
    expect(summary).toContain('4600')
    expect(summary).not.toContain('get_worker_terminal')
    expect(summary.length).toBeLessThan(4096 + 100)
  })

  it('adapter 不带 text(cc/codex 的 TUI 字节流刻意不带)时 detail 形状不变,不出现空 text 字段', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const h = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as const, session_ref: `ref-${worker.worker_id}#1` }
    fake.emitStateChange(h, 'idle')
    await waitUntil(() => events.some((e) => e.kind === 'state_changed'))
    expect(events.filter((e) => e.kind === 'state_changed')[0].detail).toMatchObject({ to: 'idle', turn_pending: true })

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

    const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(w.task.status).toBe('closed')
  })
})

describe('WorkerHarness.sendToWorker', () => {
  it('Manager 输入先落 receipt，再以同一 delivery_id 结算 delivered 和写事件', async () => {
    const { harness, fake, workersDir } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0
    const input = '  可靠\n投递  '.repeat(50)
    const preview = input.replace(/\s+/g, ' ').trim().slice(0, 200)

    const result = await harness.sendToWorker(worker.worker_id, input, {
      managerKey: `test::friend-1` as ManagerKey,
    })

    expect(result).toMatchObject({
      status: 'delivered',
      worker_id: worker.worker_id,
    })
    expect(result.delivery_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(fake.sendInputCalls[0].opts).toMatchObject({ delivery_id: result.delivery_id })

    const persisted = JSON.parse(
      await fs.readFile(join(workersDir, worker.worker_id, 'input-deliveries.json'), 'utf8'),
    ) as { receipts: Array<Record<string, unknown>> }
    expect(persisted.receipts[0]).toMatchObject({
      delivery_id: result.delivery_id,
      manager_key: 'test::friend-1',
      state: 'delivered',
    })
    expect((await harness.readWorkerEvents(worker.worker_id)).filter((event) => event.kind === 'input_sent')).toEqual([
      expect.objectContaining({
        worker_id: worker.worker_id,
        detail: expect.objectContaining({ delivery_id: result.delivery_id, text_preview: preview }),
      }),
    ])
  })

  it('输入面暂不可用时同步返回 failed，而不是留下 pending', async () => {
    const { harness, workersDir } = await makeHarness({
      implId: 'claude-code',
      sendInputBehavior: () => {
        throw new CliInputStallError('not_pasted', 'running', { waitReason: 'waiting_action' })
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })

    const result = await harness.sendToWorker(worker.worker_id, '稍后提交', {
      managerKey: `test::friend-1` as ManagerKey,
    })

    expect(result).toMatchObject({
      status: 'failed',
      worker_id: worker.worker_id,
      reason_code: 'input_surface_timeout',
      certainty: 'not_delivered',
    })
    const persisted = JSON.parse(
      await fs.readFile(join(workersDir, worker.worker_id, 'input-deliveries.json'), 'utf8'),
    ) as { receipts: Array<Record<string, unknown>> }
    expect(persisted.receipts[0]).toMatchObject({
      delivery_id: result.delivery_id,
      state: 'failed',
      phase: 'waiting_for_safe_input',
      manager_notification: { status: 'consumed' },
    })
    expect(events.some((event) => event.kind === 'input_sent')).toBe(false)
  })

  it('adapter 已接手后 phase 写失败时仍同步返回 submission_unconfirmed', async () => {
    const { harness } = await makeHarness({
      implId: 'claude-code',
      sendInputBehavior: () => {
        throw new CliInputStallError('pending_in_ui', 'running', { waitReason: 'input_pending' })
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    const receiptStore = (harness as unknown as {
      inputDeliveryStore: {
        updatePendingPhase(workerId: string, deliveryId: string, phase: string, updatedAt: string): Promise<unknown>
      }
    }).inputDeliveryStore
    const updatePendingPhase = receiptStore.updatePendingPhase.bind(receiptStore)
    vi.spyOn(receiptStore, 'updatePendingPhase').mockImplementation(
      (workerId, deliveryId, phase, updatedAt) => phase === 'pending_in_ui'
        ? Promise.reject(new Error('phase disk unavailable'))
        : updatePendingPhase(workerId, deliveryId, phase, updatedAt),
    )

    const result = await harness.sendToWorker(worker.worker_id, '可能已经在输入框', {
      managerKey: `test::friend-1` as ManagerKey,
    })

    expect(result).toMatchObject({
      status: 'failed',
      reason_code: 'submission_unconfirmed_timeout',
      certainty: 'unknown',
    })
  })

  it('pending 通知责任写失败时中止后续投递并结算 failed', async () => {
    const { harness, fake } = await makeHarness({
      implId: 'claude-code',
      sendInputBehavior: () => {
        throw new CliInputStallError('not_pasted', 'running', { waitReason: 'waiting_action' })
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    const receiptStore = (harness as unknown as {
      inputDeliveryStore: {
        readForToolResult(workerId: string, deliveryId: string, updatedAt: string): Promise<unknown>
      }
    }).inputDeliveryStore
    vi.spyOn(receiptStore, 'readForToolResult').mockRejectedValueOnce(new Error('notification arm disk unavailable'))

    const result = await harness.sendToWorker(worker.worker_id, '不能在通知责任丢失后继续', {
      managerKey: `test::friend-1` as ManagerKey,
    })

    expect(result).toMatchObject({
      status: 'failed',
      reason_code: 'delivery_attempt_failed',
      reason: 'notification arm disk unavailable',
      certainty: 'not_delivered',
    })
    expect(fake.sendInputCalls).toHaveLength(1)
    expect((harness as unknown as { getInbox(id: string): { pending: number } })
      .getInbox(worker.worker_id).pending).toBe(0)
  })

  it('adapter 已开始投递后抛普通错误时保守结算 unknown', async () => {
    const { harness, fake, workersDir } = await makeHarness({
      sendInputBehavior: () => {
        throw new Error('input transport failed')
      },
    })
    const worker = await harness.spawnWorker(spawnParams())

    const result = await harness.sendToWorker(worker.worker_id, '可能已进入输入面', {
      managerKey: `test::friend-1` as ManagerKey,
    })

    expect(fake.sendInputCalls).toHaveLength(1)
    expect(result).toMatchObject({
      status: 'failed',
      reason_code: 'delivery_attempt_failed',
      reason: 'input transport failed',
      certainty: 'unknown',
    })
    const persisted = JSON.parse(
      await fs.readFile(join(workersDir, worker.worker_id, 'input-deliveries.json'), 'utf8'),
    ) as { receipts: Array<Record<string, unknown>> }
    expect(persisted.receipts[0]).toMatchObject({
      state: 'failed',
      manager_notification: { status: 'consumed' },
    })
  })

  it('持久失败原因会移除正文、凭证和本地路径', async () => {
    const text = '不要把这段完整正文写进 receipt'
    const { harness } = await makeHarness(
      {
        sendInputBehavior: () => {
          throw new Error(`transport failed for ${text} with provider-secret at /Users/test/private.sock and sk-testcredential`)
        },
      },
      { redactFailureReason: (value) => value.replace('provider-secret', '[REDACTED]') },
    )
    const worker = await harness.spawnWorker(spawnParams())

    const result = await harness.sendToWorker(worker.worker_id, text, {
      managerKey: `test::friend-1` as ManagerKey,
    })

    expect(result).toMatchObject({ status: 'failed', reason_code: 'delivery_attempt_failed' })
    if (result.status !== 'failed') throw new Error('expected failed delivery')
    expect(result.reason).toContain('<message>')
    expect(result.reason).toContain('[REDACTED]')
    expect(result.reason).toContain('<path>')
    expect(result.reason).toContain('<redacted>')
    expect(result.reason).not.toContain(text)
    expect(result.reason).not.toContain('/Users/test/private.sock')
    expect(result.reason).not.toContain('sk-testcredential')
  })

  it('不安全的 held inbox 输入在本次调用内失败，不等待 kill_worker 清理', async () => {
    const { harness, workersDir } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    const inbox = (harness as unknown as {
      getInbox(id: string): { hold(reason: string): void }
    }).getInbox(worker.worker_id)
    inbox.hold('handoff')

    const result = await harness.sendToWorker(worker.worker_id, '尚未进入输入面', {
      managerKey: `test::friend-1` as ManagerKey,
    })
    expect(result).toMatchObject({
      status: 'failed',
      reason_code: 'input_surface_timeout',
      certainty: 'not_delivered',
    })

    await harness.killWorker(worker.worker_id, '用户取消')

    const persisted = JSON.parse(
      await fs.readFile(join(workersDir, worker.worker_id, 'input-deliveries.json'), 'utf8'),
    ) as { receipts: Array<Record<string, unknown>> }
    expect(persisted.receipts[0]).toMatchObject({
      delivery_id: result.delivery_id,
      state: 'failed',
      failure: {
        reason_code: 'input_surface_timeout',
        certainty: 'not_delivered',
      },
      manager_notification: { status: 'consumed' },
    })
  })

  it('receipt 创建失败时不入 inbox，也不调用 adapter', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    const receiptStore = (harness as unknown as {
      inputDeliveryStore: { create(receipt: unknown): Promise<unknown> }
    }).inputDeliveryStore
    vi.spyOn(receiptStore, 'create').mockRejectedValueOnce(new Error('receipt disk unavailable'))

    await expect(harness.sendToWorker(worker.worker_id, '不能碰输入面', {
      managerKey: `test::friend-1` as ManagerKey,
    })).rejects.toThrow('delivery receipt unavailable')

    expect(fake.sendInputCalls).toHaveLength(0)
    expect((harness as unknown as { getInbox(id: string): { pending: number } })
      .getInbox(worker.worker_id).pending).toBe(0)
  })

  it('输入面 stall 在同步调用内结算失败，不依赖后续 sweep 通知', async () => {
    const deliveries: HarnessEvent[] = []
    const { harness, fake, workersDir } = await makeHarness(
      {
        implId: 'claude-code',
        sendInputBehavior: () => {
          throw new CliInputStallError('not_pasted', 'running', { waitReason: 'waiting_action' })
        },
      },
      {
        onOperationNotification: async (_managerKey, event) => {
          deliveries.push(event)
          return { consumed: true }
        },
      },
    )
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    const result = await harness.sendToWorker(worker.worker_id, '会超时的输入', {
      managerKey: `test::friend-1` as ManagerKey,
    })
    expect(result).toMatchObject({
      status: 'failed',
      reason_code: 'input_surface_timeout',
      certainty: 'not_delivered',
    })

    const persisted = JSON.parse(
      await fs.readFile(join(workersDir, worker.worker_id, 'input-deliveries.json'), 'utf8'),
    ) as { receipts: Array<Record<string, any>> }
    expect(persisted.receipts[0]).toMatchObject({
      state: 'failed',
      failure: { reason_code: 'input_surface_timeout', certainty: 'not_delivered' },
      manager_notification: { status: 'consumed' },
    })
    expect(deliveries).toHaveLength(0)
    expect(fake.sendInputCalls).toHaveLength(1)
  })

  it('adapter 永久挂起时仍按 deadline 结算并通知 Manager', async () => {
    const notifications: HarnessEvent[] = []
    let markAttempting!: () => void
    const attempting = new Promise<void>((resolve) => { markAttempting = resolve })
    let releaseAdapter!: () => void
    const adapterGate = new Promise<void>((resolve) => { releaseAdapter = resolve })
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowValue)
    try {
      const { harness, workersDir } = await makeHarness(
        {
          sendInputBehavior: async () => {
            markAttempting()
            await adapterGate
          },
        },
        {
          onOperationNotification: async (_managerKey, event) => {
            notifications.push(event)
            return { consumed: true }
          },
        },
      )
      const worker = await harness.spawnWorker(spawnParams())
      const send = harness.sendToWorker(worker.worker_id, 'adapter 卡住的输入', {
        managerKey: `test::friend-1` as ManagerKey,
      })
      await attempting

      nowValue += 5 * 60_000
      const sweepResult = await Promise.race([
        harness.sweepLiveness().then(() => 'completed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timed_out'), 100)),
      ])
      expect(sweepResult).toBe('completed')

      const persisted = JSON.parse(
        await fs.readFile(join(workersDir, worker.worker_id, 'input-deliveries.json'), 'utf8'),
      ) as { receipts: Array<Record<string, any>> }
      expect(persisted.receipts[0]).toMatchObject({
        state: 'failed',
        failure: { reason_code: 'submission_unconfirmed_timeout', certainty: 'unknown' },
        manager_notification: { status: 'consumed' },
      })
      expect(notifications).toHaveLength(1)
      expect(notifications[0]).toMatchObject({
        kind: 'input_delivery_failed',
        detail: { reason_code: 'submission_unconfirmed_timeout', certainty: 'unknown' },
      })

      releaseAdapter()
      await expect(send).resolves.toMatchObject({
        status: 'failed',
        reason_code: 'submission_unconfirmed_timeout',
        certainty: 'unknown',
      })
      expect((await harness.readWorkerEvents(worker.worker_id)).filter((event) => event.kind === 'input_sent')).toEqual([])
      expect(JSON.parse(
        await fs.readFile(join(workersDir, worker.worker_id, 'input-deliveries.json'), 'utf8'),
      )).toMatchObject({
        receipts: [expect.objectContaining({
          state: 'failed',
          failure: expect.objectContaining({ reason_code: 'submission_unconfirmed_timeout' }),
        })],
      })
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('同步投递确认不确定时立即返回 unknown，且不自动重发', async () => {
    const notifications: HarnessEvent[] = []
    const { harness, fake, workersDir } = await makeHarness(
      {
        implId: 'claude-code',
        sendInputBehavior: () => {
          throw new CliInputStallError('pending_in_ui', 'running', { waitReason: 'input_pending' })
        },
      },
      {
        onOperationNotification: async (_managerKey, event) => {
          notifications.push(event)
          return { consumed: true }
        },
      },
    )
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    const result = await harness.sendToWorker(worker.worker_id, '可能已经 paste', {
      managerKey: `test::friend-1` as ManagerKey,
    })
    expect(result).toMatchObject({
      status: 'failed',
      reason_code: 'submission_unconfirmed_timeout',
      certainty: 'unknown',
    })
    expect(fake.sendInputCalls).toHaveLength(1)

    await harness.reconcileInputDeliveriesOnStartup()

    expect(fake.sendInputCalls).toHaveLength(1)
    const persisted = JSON.parse(
      await fs.readFile(join(workersDir, worker.worker_id, 'input-deliveries.json'), 'utf8'),
    ) as { receipts: Array<Record<string, any>> }
    expect(persisted.receipts[0]).toMatchObject({
      state: 'failed',
      failure: { reason_code: 'submission_unconfirmed_timeout', certainty: 'unknown' },
      manager_notification: { status: 'consumed' },
    })
    expect(notifications).toHaveLength(0)
  })

  it('adapter 不响应取消时，Harness wall-clock deadline 仍结算同步投递', async () => {
    try {
      const { harness } = await makeHarness()
      const worker = await harness.spawnWorker(spawnParams())
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const flush = vi.spyOn(harness as unknown as { flushInbox: () => Promise<void> }, 'flushInbox')
        .mockImplementation(() => new Promise<void>(() => {}))
      const send = harness.sendToWorker(worker.worker_id, '永不返回的输入', {
        managerKey: `test::friend-1` as ManagerKey,
      })
      await new Promise<void>((resolve) => {
        const check = () => flush.mock.calls.length > 0 ? resolve() : setImmediate(check)
        check()
      })
      await vi.advanceTimersByTimeAsync(INPUT_DELIVERY_TIMEOUT_MS)

      await expect(send).resolves.toMatchObject({
        status: 'failed',
        reason_code: 'input_surface_timeout',
        certainty: 'not_delivered',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('receipt 结果读取永久挂起时仍受同一同步 deadline 约束', async () => {
    const { harness } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    const receiptStore = (harness as unknown as {
      inputDeliveryStore: {
        readForToolResult(workerId: string, deliveryId: string, updatedAt: string): Promise<unknown>
      }
    }).inputDeliveryStore
    const readEntered = deferred()
    const readForToolResult = vi.spyOn(receiptStore, 'readForToolResult')
      .mockImplementation(() => {
        readEntered.resolve()
        return new Promise<never>(() => {})
      })

    const send = harness.sendToWorker(worker.worker_id, '结果读取卡住的输入', {
      managerKey: `test::friend-1` as ManagerKey,
      deadline_at: new Date(Date.now() + 1_000).toISOString(),
    })
    await readEntered.promise
    expect(readForToolResult).toHaveBeenCalledTimes(1)

    await expect(send).resolves.toMatchObject({
      status: 'failed',
      reason_code: 'submission_unconfirmed_timeout',
      certainty: 'unknown',
    })
  })

  it('state hook 持有 worker 锁时，waitForStateChanges 仍受同一同步 deadline 约束', async () => {
    const stateEventEntered = deferred()
    const releaseStateEvent = deferred()
    const onEvent = vi.fn((event: HarnessEvent) => {
      events.push(event)
      if (event.kind !== 'state_changed') return undefined
      stateEventEntered.resolve()
      return releaseStateEvent.promise
    })
    const { harness, fake } = await makeHarness({}, { onEvent })
    const worker = await harness.spawnWorker(spawnParams())
    onEvent.mockClear()
    vi.spyOn(fake, 'sendInput').mockImplementation(async (handle) => {
      harness.handleStateChange(handle, 'idle')
    })

    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      vi.setSystemTime(new Date(nowValue))
      const send = harness.sendToWorker(worker.worker_id, 'state hook 卡住的输入', {
        managerKey: `test::friend-1` as ManagerKey,
      })
      await stateEventEntered.promise

      await vi.advanceTimersByTimeAsync(INPUT_DELIVERY_TIMEOUT_MS)
      await expect(send).resolves.toMatchObject({
        status: 'failed',
        reason_code: 'submission_unconfirmed_timeout',
        certainty: 'unknown',
      })
    } finally {
      releaseStateEvent.resolve()
      for (let step = 0; step < 5; step++) await Promise.resolve()
      vi.useRealTimers()
    }
  })

  it('跨 Manager 投递不等待永不返回的状态事件路由', async () => {
    const stateEventEntered = deferred()
    const releaseStateEvent = deferred()
    const onEvent = vi.fn((event: HarnessEvent) => {
      if (event.kind !== 'state_changed') return undefined
      stateEventEntered.resolve()
      return releaseStateEvent.promise
    })
    const { harness, fake } = await makeHarness({}, { onEvent })
    const worker = await harness.spawnWorker(spawnParams())
    onEvent.mockClear()
    vi.spyOn(fake, 'sendInput').mockImplementation(async (handle) => {
      harness.handleStateChange(handle, 'idle')
    })

    try {
      const send = harness.sendToWorker(worker.worker_id, '跨 manager 的输入', {
        managerKey: `test::friend-2` as ManagerKey,
      })
      await stateEventEntered.promise
      await expect(send).resolves.toMatchObject({ status: 'delivered' })

      expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'state_changed' }))
    } finally {
      releaseStateEvent.resolve()
    }
  })

  it('terminal revive 准备跨 deadline 后不再调用 adapter.resume', async () => {
    const { harness, fake } = await makeHarness({ caps: { revive: true } })
    const worker = await harness.spawnWorker(spawnParams())
    fake.emitStateChange({
      worker_id: worker.worker_id,
      seq: 1,
      impl: 'builtin',
      session_ref: `ref-${worker.worker_id}#1`,
    }, 'exited', undefined, 'completed')
    await waitUntil(async () => (await harness.listWorkers(`test::friend-1` as ManagerKey))[0].task.status === 'halted')
    const reviveHarness = harness as unknown as {
      establishCliResumeActivityBaseline(workerId: string, source: unknown, adapter: unknown): Promise<number | undefined>
      settlePendingInputFailure(...args: unknown[]): Promise<unknown>
    }
    const baselineEntered = deferred()
    const releaseBaseline = deferred()
    const timeoutSettlementDone = deferred()
    vi.spyOn(reviveHarness, 'establishCliResumeActivityBaseline').mockImplementation(async () => {
      baselineEntered.resolve()
      await releaseBaseline.promise
      return undefined
    })
    const settlePendingInputFailure = reviveHarness.settlePendingInputFailure.bind(reviveHarness)
    vi.spyOn(reviveHarness, 'settlePendingInputFailure').mockImplementation(async (...args) => {
      const settled = await settlePendingInputFailure(...args)
      timeoutSettlementDone.resolve()
      return settled
    })
    const resume = vi.spyOn(fake, 'resume').mockImplementation(() => new Promise<never>(() => {}))

    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      vi.setSystemTime(new Date(nowValue))
      const send = harness.sendToWorker(worker.worker_id, '终态后继续，但不能晚到 revive', {
        managerKey: `test::friend-1` as ManagerKey,
      })
      await baselineEntered.promise

      await vi.advanceTimersByTimeAsync(INPUT_DELIVERY_TIMEOUT_MS)
      const result = await send
      expect(result).toMatchObject({
        status: 'failed',
        reason_code: 'submission_unconfirmed_timeout',
        certainty: 'unknown',
      })
      await timeoutSettlementDone.promise

      releaseBaseline.resolve()
      for (let step = 0; step < 5; step++) await Promise.resolve()
      expect(resume).not.toHaveBeenCalled()
    } finally {
      releaseBaseline.resolve()
      vi.useRealTimers()
    }
  })

  it('terminal handoff 准备跨 deadline 后不写 handoff_started 或启动目标 adapter', async () => {
    const { harness, fake, adaptersMap } = await makeHarness({ caps: { revive: false } })
    const target = new FakeAdapter({
      implId: 'claude-code',
      onStateChange: harness.handleStateChange,
    })
    adaptersMap.set(target.implId, target)
    const worker = await harness.spawnWorker(spawnParams())
    fake.emitStateChange({
      worker_id: worker.worker_id,
      seq: 1,
      impl: 'builtin',
      session_ref: `ref-${worker.worker_id}#1`,
    }, 'exited', undefined, 'completed')
    await waitUntil(async () => (await harness.listWorkers(`test::friend-1` as ManagerKey))[0].task.status === 'halted')

    const handoffHarness = harness as unknown as {
      captureHandoffPackage(...args: unknown[]): Promise<unknown>
      settlePendingInputFailure(...args: unknown[]): Promise<unknown>
    }
    const captureEntered = deferred()
    const releaseCapture = deferred()
    const captureFinished = deferred()
    const timeoutSettlementDone = deferred()
    const captureHandoffPackage = handoffHarness.captureHandoffPackage.bind(handoffHarness)
    vi.spyOn(handoffHarness, 'captureHandoffPackage').mockImplementation(async (...args) => {
      captureEntered.resolve()
      await releaseCapture.promise
      const handoff = await captureHandoffPackage(...args)
      captureFinished.resolve()
      return handoff
    })
    const settlePendingInputFailure = handoffHarness.settlePendingInputFailure.bind(handoffHarness)
    vi.spyOn(handoffHarness, 'settlePendingInputFailure').mockImplementation(async (...args) => {
      const settled = await settlePendingInputFailure(...args)
      timeoutSettlementDone.resolve()
      return settled
    })

    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      vi.setSystemTime(new Date(nowValue))
      const send = harness.sendToWorker(worker.worker_id, '终态后继续，但不能晚到 handoff', {
        managerKey: `test::friend-1` as ManagerKey,
      })
      await captureEntered.promise

      await vi.advanceTimersByTimeAsync(INPUT_DELIVERY_TIMEOUT_MS)
      await expect(send).resolves.toMatchObject({
        status: 'failed',
        reason_code: 'submission_unconfirmed_timeout',
        certainty: 'unknown',
      })
      await timeoutSettlementDone.promise

      releaseCapture.resolve()
      await captureFinished.promise
      for (let step = 0; step < 5; step++) await Promise.resolve()

      expect((await harness.readWorkerEvents(worker.worker_id))
        .filter((event) => event.kind === 'lifecycle_changed'
          && (event.detail as { change?: string } | undefined)?.change === 'handoff_started')).toEqual([])
      expect(target.spawnCalls).toEqual([])
    } finally {
      releaseCapture.resolve()
      vi.useRealTimers()
    }
  })

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
    expect(inputEvents[0].detail?.text_preview).toBe('继续干活')
  })

  it('raw 选项透传给 adapter.sendInput', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())

    await harness.sendToWorker(worker.worker_id, '/exit', { raw: true })

    expect(fake.sendInputCalls[0].opts).toEqual({ raw: true })
  })

  it('immediate_redirect 对非 builtin 先 interrupt 再投递，并透传标志', async () => {
    const { harness, fake } = await makeHarness({ implId: 'claude-code' })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })

    await harness.sendToWorker(worker.worker_id, '立即改做这件事', {
      managerKey: `test::friend-1` as ManagerKey,
      immediate_redirect: true,
    })

    expect(fake.interruptCalls).toHaveLength(1)
    expect(fake.sendInputCalls).toHaveLength(1)
    expect(fake.sendInputCalls[0].opts).toMatchObject({ immediate_redirect: true })
  })

  it('immediate_redirect 等待 worker 锁越过 deadline 时不补发 interrupt', async () => {
    const { harness, fake } = await makeHarness({ implId: 'claude-code' })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    const receiptStore = (harness as unknown as {
      inputDeliveryStore: { create(receipt: unknown): Promise<unknown> }
    }).inputDeliveryStore
    const createReceipt = receiptStore.create.bind(receiptStore)
    const createEntered = deferred()
    const releaseCreate = deferred()
    vi.spyOn(receiptStore, 'create').mockImplementation(async (receipt) => {
      createEntered.resolve()
      await releaseCreate.promise
      return createReceipt(receipt)
    })
    const blockerEntered = deferred()
    const releaseBlocker = deferred()
    const lockedHarness = harness as unknown as {
      withLock<T>(workerId: string, fn: () => Promise<T>): Promise<T>
    }

    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      vi.setSystemTime(new Date(nowValue))
      const send = harness.sendToWorker(worker.worker_id, 'deadline 后不可打断旧任务', {
        managerKey: `test::friend-1` as ManagerKey,
        immediate_redirect: true,
      })
      await createEntered.promise
      const blocker = lockedHarness.withLock(worker.worker_id, async () => {
        blockerEntered.resolve()
        await releaseBlocker.promise
      })
      releaseCreate.resolve()
      await blockerEntered.promise

      await vi.advanceTimersByTimeAsync(INPUT_DELIVERY_TIMEOUT_MS)
      await expect(send).resolves.toMatchObject({
        status: 'failed',
        reason_code: 'input_surface_timeout',
        certainty: 'not_delivered',
      })
      expect(fake.interruptCalls).toEqual([])

      releaseBlocker.resolve()
      await blocker
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(fake.interruptCalls).toEqual([])
    } finally {
      releaseCreate.resolve()
      releaseBlocker.resolve()
      vi.useRealTimers()
    }
  })

  it('builtin immediate_redirect 不调用 interrupt', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())

    await harness.sendToWorker(worker.worker_id, '下一轮优先改向', {
      managerKey: `test::friend-1` as ManagerKey,
      immediate_redirect: true,
    })

    expect(fake.interruptCalls).toHaveLength(0)
    expect(fake.sendInputCalls[0].opts).toMatchObject({ immediate_redirect: true })
  })

  it('immediate_redirect 中断失败时不投递新文本', async () => {
    const { harness, fake } = await makeHarness({
      implId: 'claude-code',
      interruptShouldFail: new Error('interrupt not accepted'),
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })

    const result = await harness.sendToWorker(worker.worker_id, '不能越过旧任务发送', {
      managerKey: `test::friend-1` as ManagerKey,
      immediate_redirect: true,
    })

    expect(result).toMatchObject({ status: 'failed', certainty: 'not_delivered' })
    expect(fake.sendInputCalls).toHaveLength(0)
    expect((harness as any).getInbox(worker.worker_id).pending).toBe(0)
  })

  it('sendToActiveWorker 不复活 terminal task', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    await expect(harness.sendToActiveWorker(worker.worker_id, '反馈')).resolves.toBe(true)
    expect(fake.sendInputCalls.at(-1)?.text).toBe('反馈')

    await harness.killWorker(worker.worker_id)
    fake.sendInputCalls.length = 0
    await expect(harness.sendToActiveWorker(worker.worker_id, '迟到反馈')).resolves.toBe(false)
    expect(fake.sendInputCalls).toHaveLength(0)
  })

  it('CLI化身exited时清除旧pane的transport hold', async () => {
    const { harness, fake } = await makeHarness({ implId: 'claude-code' })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    const inbox = (harness as any).getInbox(worker.worker_id)
    inbox.hold('input_pending')
    expect(inbox.held).toBe(true)

    fake.emitStateChange({
      worker_id: worker.worker_id,
      seq: 1,
      impl: 'claude-code',
      session_ref: `ref-${worker.worker_id}#1`,
    }, 'exited', undefined, 'completed')
    await waitUntil(() => inbox.held === false)

    expect(inbox.held).toBe(false)
  })

  it('普通CLI投递后的running结算不覆盖并发Stop回调落下的waiting_input', async () => {
    const { harness } = await makeHarness({ implId: 'claude-code', sendInputState: 'idle' })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })

    await harness.sendToWorker(worker.worker_id, '很快完成的输入')
    await waitUntil(async () => {
      const [current] = await harness.listWorkers(`test::friend-1` as ManagerKey)
      return current.task.status === 'halted'
    })

    const [settled] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(settled.incarnations[0].state).toBe('idle')
  })

  it('pending_in_ui hold保留，但其running状态写不覆盖并发Stop落下的waiting_input', async () => {
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { harness, fake } = await makeHarness({
      implId: 'claude-code',
      sendInputBehavior: async () => {
        markEntered()
        await gate
        throw new CliInputStallError('pending_in_ui', 'running', {
          waitReason: 'input_pending',
          terminal: terminal('queued text not visibly acknowledged'),
        })
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    const send = harness.sendToWorker(worker.worker_id, 'steering text')
    await entered

    fake.emitStateChange({
      worker_id: worker.worker_id,
      seq: 1,
      impl: 'claude-code',
      session_ref: `ref-${worker.worker_id}#1`,
    }, 'idle')
    await waitUntil(async () => {
      const [current] = await harness.listWorkers(`test::friend-1` as ManagerKey)
      return current.task.status === 'halted'
    })

    release()
    await send

    const [settled] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(settled.task.status).toBe('halted')
    expect(settled.incarnations[0].state).toBe('idle')
    expect(fake.sendInputCalls).toHaveLength(1)
    expect((harness as any).getInbox(worker.worker_id).held).toBe(true)
  })

  it('主线CLI投递不因并发fork状态回调而丢失running结算', async () => {
    let fakeRef!: FakeAdapter
    let currentWorkerId = ''
    const made = await makeHarness({
      implId: 'claude-code',
      caps: { fork: true },
      sendInputBehavior: () => {
        fakeRef.emitStateChange({
          worker_id: currentWorkerId,
          seq: 2,
          impl: 'claude-code',
          session_ref: `fork-ref-${currentWorkerId}#2`,
        }, 'idle')
      },
    })
    const { harness, fake } = made
    fakeRef = fake
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    currentWorkerId = worker.worker_id
    fake.emitStateChange({
      worker_id: worker.worker_id,
      seq: 1,
      impl: 'claude-code',
      session_ref: `ref-${worker.worker_id}#1`,
    }, 'idle')
    await waitUntil(async () => (await harness.listWorkers(`test::friend-1` as ManagerKey))[0].task.status === 'halted')
    await harness.queryWorker(worker.worker_id, '侧问一下')

    await harness.sendToWorker(worker.worker_id, '主线继续')
    await waitUntil(async () => {
      const [current] = await harness.listWorkers(`test::friend-1` as ManagerKey)
      return current.incarnations.find((incarnation) => incarnation.seq === 2)?.state === 'idle'
    })

    const [settled] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(settled.task.status).toBe('running')
    expect(settled.incarnations.find((incarnation) => incarnation.seq === 1)?.state).toBe('running')
  })

  it('fork或旧化身的exited回调不清除当前pane的transport hold', async () => {
    const { harness, fake, workersDir } = await makeHarness({ implId: 'claude-code', caps: { fork: true } })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    await harness.queryWorker(worker.worker_id, '侧问一下')
    const inbox = (harness as any).getInbox(worker.worker_id)
    inbox.hold('input_pending')

    fake.emitStateChange({
      worker_id: worker.worker_id,
      seq: 2,
      impl: 'claude-code',
      session_ref: `fork-ref-${worker.worker_id}#2`,
    }, 'exited', undefined, 'completed')
    await waitUntil(async () => {
      const [current] = await harness.listWorkers(`test::friend-1` as ManagerKey)
      return current.incarnations.find((incarnation) => incarnation.seq === 2)?.state === 'exited'
    })
    await waitUntil(async () => (await new WorkerEventLog(join(workersDir, worker.worker_id)).readAll())
      .some((event) => event.kind === 'query_completed' && event.seq === 2))

    expect(inbox.held).toBe(true)
  })

  it('CLI raw成功后的adapter idle重判落waiting_input，不被harness硬覆盖为running', async () => {
    const { harness } = await makeHarness({ implId: 'claude-code', sendInputState: 'idle' })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })

    await harness.sendToWorker(worker.worker_id, 'Escape', { raw: true })
    await waitUntil(async () => {
      const [current] = await harness.listWorkers(`test::friend-1` as ManagerKey)
      return current.task.status === 'halted'
    })
    const [settled] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(settled.task.status).toBe('halted')
    expect(settled.incarnations[0].state).toBe('idle')
  })

  it('steering pre-paste stall期间收到Stop时不安装过期hold，并立即按新状态重试队首', async () => {
    let first = true
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { harness, fake } = await makeHarness({
      implId: 'claude-code',
      sendInputBehavior: async () => {
        if (!first) return
        first = false
        markEntered()
        await gate
        throw new CliInputStallError('not_pasted', 'running', {
          waitReason: 'input_surface_unavailable',
          terminal: terminal('esc to interrupt'),
        })
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    const send = harness.sendToWorker(worker.worker_id, 'queued after Stop')
    await entered

    fake.emitStateChange({
      worker_id: worker.worker_id,
      seq: 1,
      impl: 'claude-code',
      session_ref: `ref-${worker.worker_id}#1`,
    }, 'idle')
    release()
    await send

    expect(fake.sendInputCalls.map((call) => call.text)).toEqual([
      'queued after Stop',
      'queued after Stop',
    ])
    expect((harness as any).getInbox(worker.worker_id).held).toBe(false)
  })

  it('普通输入接受后同步发现的session_ref由harness写回台账', async () => {
    const sessionRef = '019fe15f-cbd9-76c1-9a18-e6c2e1d2b2d7'
    const { harness } = await makeHarness({ implId: 'codex', updatedSessionRef: sessionRef })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'codex' })

    await harness.sendToWorker(worker.worker_id, '首条任务')

    const [settled] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(settled.incarnations[0].session_ref).toBe(sessionRef)
  })

  it('并发状态回调使running结算过期时仍保留新发现的session_ref', async () => {
    const sessionRef = '019fe15f-cbd9-76c1-9a18-e6c2e1d2b2d8'
    const { harness } = await makeHarness({
      implId: 'codex',
      updatedSessionRef: sessionRef,
      sendInputState: 'idle',
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'codex' })

    await harness.sendToWorker(worker.worker_id, '首条任务')
    await waitUntil(async () => {
      const [current] = await harness.listWorkers(`test::friend-1` as ManagerKey)
      return current.task.status === 'halted'
    })

    const [settled] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(settled.incarnations[0].session_ref).toBe(sessionRef)
    expect(settled.incarnations[0].state).toBe('idle')
  })

  it('accepted input后同步退出由harness在sendToWorker返回前单次结算', async () => {
    const report: StateChangeReport = { endReason: 'completed' }
    const { harness } = await makeHarness({ implId: 'claude-code', acceptedExitReport: report })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    events.length = 0

    await harness.sendToWorker(worker.worker_id, '最后一步')

    const [settled] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(settled.task.status).toBe('halted')
    expect(settled.incarnations[0]).toMatchObject({ state: 'exited', ended_reason: 'completed' })
    const stateEvents = events.filter((event) => event.kind === 'state_changed')
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0].detail).toMatchObject({ to: 'exited', reason: 'completed' })
  })

  it('raw键已送达后同步退出由harness结算为终态，不把raw文本留给后续透明接续', async () => {
    const report: StateChangeReport = { endReason: 'completed' }
    const { harness, fake } = await makeHarness({ implId: 'claude-code', acceptedExitReport: report })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    events.length = 0

    await harness.sendToWorker(worker.worker_id, 'C-d', { raw: true })

    expect(fake.sendInputCalls).toHaveLength(1)
    expect(fake.sendInputCalls[0]).toMatchObject({ text: 'C-d', opts: { raw: true } })
    const [settled] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(settled.task.status).toBe('halted')
    expect(settled.incarnations).toHaveLength(1)
    expect(settled.incarnations[0]).toMatchObject({ state: 'exited', ended_reason: 'completed' })
    const stateEvents = events.filter((event) => event.kind === 'state_changed')
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0].detail).toMatchObject({ to: 'exited', reason: 'completed' })
  })

  it('raw提交已在composer持有的文本并同步退出时，先结算原receipt再落终态，不重放旧文本', async () => {
    let stalled = false
    const report: StateChangeReport = { endReason: 'completed' }
    const { harness, fake } = await makeHarness({
      implId: 'claude-code',
      caps: { revive: true },
      acceptedExitReport: report,
      sendInputBehavior: (_h, _text, opts) => {
        if (!opts?.raw && !stalled) {
          stalled = true
          throw new CliInputStallError('pending_in_ui', 'running', {
            waitReason: 'input_pending',
            terminal: terminal('❯ held prompt'),
          })
        }
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })

    await harness.sendToWorker(worker.worker_id, 'held prompt')
    await expect(harness.sendToWorker(worker.worker_id, '1 Enter', { raw: true })).resolves.toBeUndefined()

    expect(fake.sendInputCalls.map((call) => [call.text, call.opts?.raw ?? false])).toEqual([
      ['held prompt', false],
      ['1 Enter', true],
    ])
    const [settled] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(settled.task.status).toBe('halted')
    expect(settled.incarnations).toHaveLength(1)
    expect(settled.incarnations[0]).toMatchObject({ state: 'exited', ended_reason: 'completed' })
  })

  it('同步not_pasted stall由harness单次结算：原item回队首，raw旁路后按FIFO补投且不重复paste', async () => {
    let stalled = false
    const { harness, fake } = await makeHarness({
      implId: 'claude-code',
      sendInputBehavior: (_h, _text, opts) => {
        if (!opts?.raw && !stalled) {
          stalled = true
          throw new CliInputStallError('not_pasted', 'running', {
            waitReason: 'input_surface_unavailable',
            terminal: terminal('Working'),
          })
        }
      },
    })
    const worker = await harness.spawnWorker({ ...spawnParams(), impl: 'claude-code' })
    events.length = 0

    await harness.sendToWorker(worker.worker_id, 'blocked')
    await harness.sendToWorker(worker.worker_id, 'later')
    expect(fake.sendInputCalls.map((call) => call.text)).toEqual(['blocked'])

    await harness.sendToWorker(worker.worker_id, 'Escape', { raw: true })
    expect(fake.sendInputCalls.map((call) => [call.text, call.opts?.raw ?? false])).toEqual([
      ['blocked', false],
      ['Escape', true],
      ['blocked', false],
      ['later', false],
    ])
    expect(events.filter((event) => event.kind === 'state_changed')).toHaveLength(1)
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
    const opEvents: HarnessEvent[] = []
    const { harness, fake } = await makeHarness({}, {
      onOperationNotification: async (_managerKey, e) => { opEvents.push(e); return { consumed: true } },
    })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await harness.killWorker(worker.worker_id, '用户要求终止')

    expect(fake.killCalls).toHaveLength(1)
    expect(fake.killCalls[0]).toMatchObject({ worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1`, incarnation_id: expect.any(String) })

    const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(w.task.status).toBe('closed')
    expect(w.incarnations[0].state).toBe('exited')
    expect(w.incarnations[0].ended_reason).toBe('killed')

    // 一次停止一张回执：operation_settled 是对 manager 的唯一唤醒，自带落账后 closed。
    // （operation 通知是异步投递，等它到达）
    await waitUntil(() => opEvents.filter((e) => e.kind === 'operation_settled').length === 1)
    const settled = opEvents.filter((e) => e.kind === 'operation_settled')
    expect(settled[0].task_status).toBe('closed')
    // stop_verified 已降审计：不进唤醒面，events.jsonl 里仍可查（同样带 closed）。
    expect(events.filter((e) => e.detail?.reason === 'stop_verified')).toHaveLength(0)
    const auditStopped = (await harness.readWorkerEvents(worker.worker_id))
      .filter((e) => e.kind === 'state_changed' && e.detail?.reason === 'stop_verified')
    expect(auditStopped).toHaveLength(1)
    expect(auditStopped[0].task_status).toBe('closed')
  })

  it('幂等:对已 cancelled 的 worker 再次 kill 不报错、不重复调用 adapter.kill、不重复发事件', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    await harness.killWorker(worker.worker_id)
    expect(fake.killCalls).toHaveLength(1)
    events.length = 0

    await expect(harness.killWorker(worker.worker_id)).resolves.toBeUndefined()
    expect(fake.killCalls).toHaveLength(1) // 未被再次调用
    expect(events).toHaveLength(0) // 不再发任何事件(killed kind 已随事件面收敛删除)
  })

  it('不存在的 worker_id → WorkerNotFoundError', async () => {
    const { harness } = await makeHarness()
    await expect(harness.killWorker('w-does-not-exist')).rejects.toThrow(WorkerNotFoundError)
  })
})

describe('WorkerHarness.queryWorker', () => {
  it('stale admission rejects before fork, ledger incarnation, inbox, or event side effects', async () => {
    const { harness, fake, workersDir } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    const before = await new WorkerEventLog(join(workersDir, worker.worker_id)).readAll()
    ;(harness as any).deps.assertExecutionAdmission = () => { throw new Error('AGENT_RUNTIME_CONFIG_STALE') }

    await expect(harness.queryWorker(worker.worker_id, 'side question')).rejects.toThrow('AGENT_RUNTIME_CONFIG_STALE')
    expect(fake.forkCalls).toHaveLength(0)
    expect((await harness.listWorkers(`test::friend-1` as ManagerKey))[0].incarnations).toHaveLength(1)
    expect(await new WorkerEventLog(join(workersDir, worker.worker_id)).readAll()).toEqual(before)
  })

  it('capabilities().fork 为 false → 同步返回带 query_id 的建立失败，adapter 零调用', async () => {
    const { harness, fake, workersDir } = await makeHarness({ caps: { fork: false } })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await expect(harness.queryWorker(worker.worker_id, '侧问一下')).rejects.toMatchObject({
      reason_code: 'fork_capability_unavailable',
      certainty: 'not_started',
      query_id: expect.any(String),
    })
    expect(fake.forkCalls).toHaveLength(0)

    const log = new WorkerEventLog(join(workersDir, worker.worker_id))
    const onDisk = await log.readAll()
    const failedOnDisk = onDisk.filter((e) => e.kind === 'query_failed')
    expect(failedOnDisk).toHaveLength(1)
    expect(failedOnDisk[0]).toMatchObject({
      seq: 0,
      detail: {
        query_id: expect.any(String),
        reason_code: 'fork_capability_unavailable',
        phase: 'establishment',
      },
    })

    expect(events.filter((e) => e.kind === 'query_failed')).toHaveLength(0)
  })

  it('建立失败通知不走普通事件口，直到 owning Manager consumed 才确认', async () => {
    const notifications: HarnessEvent[] = []
    const { harness, workersDir } = await makeHarness(
      { caps: { fork: false } },
      {
        onOperationNotification: async (_managerKey, event) => {
          notifications.push(event)
          return { consumed: true }
        },
      },
    )
    const worker = await harness.spawnWorker(spawnParams())

    await expect(harness.queryWorker(worker.worker_id, '无法建立的侧问', {
      managerKey: `test::friend-1` as ManagerKey,
    })).rejects.toBeInstanceOf(QueryEstablishmentError)
    expect(notifications).toHaveLength(0)

    await harness.sweepLiveness()
    expect(notifications).toEqual([
      expect.objectContaining({
        kind: 'query_failed',
        worker_id: worker.worker_id,
        seq: 0,
        detail: expect.objectContaining({
          query_id: expect.any(String),
          reason_code: 'fork_capability_unavailable',
        }),
      }),
    ])
    expect(notifications[0].detail).not.toHaveProperty('fork_seq')

    const persisted = JSON.parse(
      await fs.readFile(join(workersDir, worker.worker_id, 'query-receipts.json'), 'utf8'),
    ) as { receipts: Array<Record<string, unknown>> }
    expect(persisted.receipts[0]).toMatchObject({
      state: 'failed',
      manager_notification: { status: 'consumed' },
    })
  })

  it('目标 impl 未注册 adapter → 结算 fork_capability_unavailable', async () => {
    const { harness, fake, adaptersMap, workersDir } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    adaptersMap.delete(fake.implId)
    events.length = 0

    await expect(harness.queryWorker(worker.worker_id, '侧问一下')).rejects.toMatchObject({
      reason_code: 'fork_capability_unavailable',
      certainty: 'not_started',
    })

    const onDisk = await new WorkerEventLog(join(workersDir, worker.worker_id)).readAll()
    expect(onDisk.filter((e) => e.kind === 'query_failed')).toHaveLength(1)
  })

  it('worker_id 不存在 → 操作未被接受，不创建 receipt 或 query 事件', async () => {
    const { harness, workersDir } = await makeHarness({ caps: { fork: true } })
    events.length = 0

    await expect(harness.queryWorker('w-does-not-exist', '侧问一下')).rejects.toThrow(WorkerNotFoundError)

    expect(events.filter((e) => e.kind === 'query_failed')).toHaveLength(0)
    await expect(fs.access(join(workersDir, 'w-does-not-exist', 'query-receipts.json'))).rejects.toThrow()
  })

  it('adapter.fork 抛错 → 同一次调用返回 fork_create_failed 并持久留痕', async () => {
    const boom = new Error('fork 侧的 claude -p 炸了')
    const { harness, workersDir } = await makeHarness({ caps: { fork: true }, forkShouldFail: boom })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await expect(harness.queryWorker(worker.worker_id, '侧问一下')).rejects.toMatchObject({
      reason_code: 'fork_create_failed',
      reason: 'fork 侧的 claude -p 炸了',
      certainty: 'unknown',
    })

    const onDisk = await new WorkerEventLog(join(workersDir, worker.worker_id)).readAll()
    expect(onDisk.filter((e) => e.kind === 'query_failed')).toHaveLength(1)

    // 主线台账完全不受 fork 失败影响(fork 从未落账,不该有半成品化身)。
    const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(w.incarnations).toHaveLength(1)
    expect(w.task.status).toBe('running')
  })

  it('侧问准备 workspace 快照失败 → receipt 不会永久停在 starting', async () => {
    const { harness, fake, workersDir } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    const workspace = worker.incarnations[0].workspace
    await fs.mkdir(join(workspace, 'AGENTS.md'))

    await expect(harness.queryWorker(worker.worker_id, '读取当前进度')).rejects.toMatchObject({
      reason_code: 'fork_create_failed',
      certainty: 'unknown',
      query_id: expect.any(String),
    })
    expect(fake.forkCalls).toHaveLength(0)

    const queryStore = (harness as unknown as { queryReceiptStore: QueryReceiptStore }).queryReceiptStore
    expect(await queryStore.list(worker.worker_id)).toMatchObject([{
      state: 'failed',
      failure: { reason_code: 'fork_create_failed', phase: 'establishment' },
      manager_notification: { status: 'pending' },
    }])
    expect((await new WorkerEventLog(join(workersDir, worker.worker_id)).readAll())
      .filter((event) => event.kind === 'query_failed')).toHaveLength(1)
  })

  it('建立失败 receipt 写暂时失败时仍返回 query_id，并由 deadline 巡检收口', async () => {
    const { harness, workersDir } = await makeHarness({
      caps: { fork: true },
      forkShouldFail: new Error('fork process failed'),
    })
    const worker = await harness.spawnWorker(spawnParams())
    const queryStore = (harness as unknown as { queryReceiptStore: QueryReceiptStore }).queryReceiptStore
    vi.spyOn(queryStore, 'settleFailed').mockRejectedValueOnce(new Error('query receipt disk unavailable'))

    await expect(harness.queryWorker(worker.worker_id, '侧问一下')).rejects.toMatchObject({
      query_id: expect.any(String),
      reason_code: 'fork_create_failed',
      reason: 'fork process failed',
    })
    expect((await queryStore.list(worker.worker_id))[0]).toMatchObject({ state: 'starting' })

    nowValue += 30_000
    await harness.sweepLiveness()

    expect((await queryStore.list(worker.worker_id))[0]).toMatchObject({
      state: 'failed',
      failure: {
        reason_code: 'fork_establishment_timeout',
        certainty: 'unknown',
      },
      manager_notification: { status: 'pending' },
    })
    expect((await new WorkerEventLog(join(workersDir, worker.worker_id)).readAll())
      .filter((event) => event.kind === 'query_failed')).toHaveLength(1)
  })

  it('侧问建立失败原因会移除问题正文、凭证和本地路径', async () => {
    const question = '这是不能写进失败原因的完整侧问'
    const failure = new Error(`fork failed for ${question}: provider-secret /Users/test/query.json sk-querycredential`)
    const { harness } = await makeHarness(
      { caps: { fork: true }, forkShouldFail: failure },
      { redactFailureReason: (value) => value.replace('provider-secret', '[REDACTED]') },
    )
    const worker = await harness.spawnWorker(spawnParams())

    let caught: QueryEstablishmentError | undefined
    try {
      await harness.queryWorker(worker.worker_id, question)
    } catch (error) {
      caught = error as QueryEstablishmentError
    }

    expect(caught).toBeInstanceOf(QueryEstablishmentError)
    expect(caught?.reason).toContain('<message>')
    expect(caught?.reason).toContain('[REDACTED]')
    expect(caught?.reason).toContain('<path>')
    expect(caught?.reason).toContain('<redacted>')
    expect(caught?.reason).not.toContain(question)
    expect(caught?.reason).not.toContain('/Users/test/query.json')
    expect(caught?.reason).not.toContain('sk-querycredential')
  })

  it('连接准入耗时计入 30 秒建立期限，harness 只等待 receipt 的剩余时间', async () => {
    vi.useFakeTimers()
    let resolveFork!: (handle: IncarnationHandle) => void
    let queryId = ''
    let signalForkStarted!: () => void
    const forkStarted = new Promise<void>((resolve) => { signalForkStarted = resolve })
    try {
      const { harness, fake } = await makeHarness(
        { caps: { fork: true } },
        {
          admitWorkerConnection: async () => {
            nowValue += 27_000
            return { env: {}, dispose: async () => {} }
          },
        },
      )
      const worker = await harness.spawnWorker(spawnParams())
      vi.spyOn(fake, 'fork').mockImplementationOnce((prev, _forkInput, opts) => {
        queryId = opts.query_id
        signalForkStarted()
        return new Promise<IncarnationHandle>((resolve) => {
          resolveFork = resolve
        })
      })

      let rejection: unknown
      let signalRejected!: () => void
      const rejected = new Promise<void>((resolve) => { signalRejected = resolve })
      const query = harness.queryWorker(worker.worker_id, '慢准入后的侧问').catch((error) => {
        rejection = error
        signalRejected()
      })
      await forkStarted
      await vi.advanceTimersByTimeAsync(2_100)
      await rejected

      expect(rejection).toMatchObject({
        reason_code: 'fork_establishment_timeout',
        certainty: 'unknown',
      })

      resolveFork({
        worker_id: worker.worker_id,
        seq: 2,
        impl: 'builtin',
        session_ref: 'late-fork-after-timeout',
        query_id: queryId,
      })
      await query
      await vi.waitFor(() => expect(fake.killCalls).toHaveLength(1))
    } finally {
      vi.useRealTimers()
    }
  })

  it('建立失败后的迟到 fork callback 不会重新暂存或生成完成事件', async () => {
    const { harness, fake, workersDir } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    let rejectedHandle: IncarnationHandle | undefined
    vi.spyOn(fake, 'fork').mockImplementationOnce(async (prev, _forkInput, opts) => {
      rejectedHandle = {
        worker_id: prev.worker_id,
        seq: 2,
        impl: 'builtin',
        session_ref: 'late-fork-ref',
        query_id: opts.query_id,
      }
      throw new Error('fork failed before ledger commit')
    })

    await expect(harness.queryWorker(worker.worker_id, '侧问一下')).rejects.toMatchObject({
      reason_code: 'fork_create_failed',
      query_id: expect.any(String),
    })
    expect(rejectedHandle).toBeDefined()

    const queryStore = (harness as unknown as { queryReceiptStore: QueryReceiptStore }).queryReceiptStore
    const pendingStateChanges = (harness as unknown as {
      pendingQueryStateChanges: Map<string, unknown>
    }).pendingQueryStateChanges
    const getSpy = vi.spyOn(queryStore, 'get')
    harness.handleStateChange(rejectedHandle!, 'exited', { endReason: 'completed' })
    await waitUntil(() => getSpy.mock.calls.some(([, queryId]) => queryId === rejectedHandle!.query_id))
    await Promise.resolve()

    expect(pendingStateChanges.has(rejectedHandle!.query_id!)).toBe(false)
    const [persisted] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(persisted.incarnations).toHaveLength(1)
    const onDisk = await new WorkerEventLog(join(workersDir, worker.worker_id)).readAll()
    expect(onDisk.some((event) =>
      event.kind === 'query_completed' && event.detail?.query_id === rejectedHandle!.query_id,
    )).toBe(false)
  })

  it('fork 失败后的 admission dispose 错误不覆盖原失败或遗失 receipt', async () => {
    const dispose = vi.fn().mockRejectedValue(new Error('dispose failed'))
    const { harness, workersDir } = await makeHarness(
      { caps: { fork: true }, forkShouldFail: new Error('fork failed') },
      {
        admitWorkerConnection: async () => ({ env: {}, dispose }),
      },
    )
    const worker = await harness.spawnWorker(spawnParams())

    await expect(harness.queryWorker(worker.worker_id, '侧问一下')).rejects.toMatchObject({
      reason_code: 'fork_create_failed',
      reason: 'fork failed',
    })
    expect(dispose).toHaveBeenCalledTimes(1)

    const persisted = JSON.parse(
      await fs.readFile(join(workersDir, worker.worker_id, 'query-receipts.json'), 'utf8'),
    ) as { receipts: Array<Record<string, unknown>> }
    expect(persisted.receipts[0]).toMatchObject({
      state: 'failed',
      failure: { reason_code: 'fork_create_failed' },
      manager_notification: { status: 'pending' },
    })
  })

  it('adapter 返回错误 query_id 时拒绝落账并尽力停止已建立分支', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    vi.spyOn(fake, 'fork').mockResolvedValueOnce({
      worker_id: worker.worker_id,
      seq: 2,
      impl: 'builtin',
      session_ref: 'fork-ref-mismatch',
      query_id: 'wrong-query-id',
    })

    await expect(harness.queryWorker(worker.worker_id, '侧问一下')).rejects.toMatchObject({
      reason_code: 'fork_create_failed',
      reason: 'adapter returned a fork handle with a mismatched query_id',
      certainty: 'unknown',
    })
    expect(fake.killCalls).toEqual([
      expect.objectContaining({ seq: 2, query_id: 'wrong-query-id' }),
    ])
    const [persisted] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(persisted.incarnations).toHaveLength(1)
  })

  it('operation 审计写失败不推翻已经提交的 query started 结果', async () => {
    const { harness, workersDir } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    const eventLog = new WorkerEventLog(join(workersDir, worker.worker_id))
    ;(harness as unknown as { eventLogs: Map<string, WorkerEventLog> }).eventLogs.set(worker.worker_id, eventLog)
    vi.spyOn(eventLog, 'append').mockRejectedValueOnce(new Error('audit disk unavailable'))

    await expect(harness.queryWorker(worker.worker_id, '侧问一下')).resolves.toMatchObject({
      status: 'started',
      query_id: expect.any(String),
      fork_seq: 2,
    })
    const [persisted] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(persisted.incarnations).toHaveLength(2)
    expect(persisted.incarnations[1]).toMatchObject({ state: 'running', forked_from: persisted.incarnations[0].incarnation_id })
  })

  it('fork 已建立但 ledger 提交失败时尽力 kill，并以 unknown 返回 fork_record_failed', async () => {
    const { harness, fake, ledger } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    vi.spyOn(ledger, 'upsertWorker').mockRejectedValueOnce(new Error('ledger unavailable'))

    await expect(harness.queryWorker(worker.worker_id, '侧问一下', {
      managerKey: `test::friend-1` as ManagerKey,
    })).rejects.toMatchObject({
      reason_code: 'fork_record_failed',
      reason: 'ledger unavailable',
      certainty: 'unknown',
    })

    expect(fake.killCalls).toEqual([
      expect.objectContaining({ worker_id: worker.worker_id, seq: 2 }),
    ])
    const [persisted] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(persisted.incarnations).toHaveLength(1)
    expect(persisted.task.status).toBe('running')
  })

  it('ledger 已提交但 running receipt 写失败时，kill 并收口半提交 fork 化身', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    const queryStore = (harness as unknown as { queryReceiptStore: QueryReceiptStore }).queryReceiptStore
    vi.spyOn(queryStore, 'markRunning').mockRejectedValueOnce(new Error('query receipt unavailable'))

    await expect(harness.queryWorker(worker.worker_id, '侧问一下')).rejects.toMatchObject({
      reason_code: 'fork_record_failed',
      reason: 'query receipt unavailable',
      certainty: 'unknown',
    })

    expect(fake.killCalls).toEqual([
      expect.objectContaining({ worker_id: worker.worker_id, seq: 2 }),
    ])
    const [persisted] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(persisted.task.status).toBe('running')
    expect(persisted.incarnations[1]).toMatchObject({
      seq: 2,
      query_id: expect.any(String),
      state: 'exited',
      ended_reason: 'killed',
    })
  })

  it('capabilities().fork 为 true → 返回 started 并以同一 query_id 落 handle/ledger/receipt', async () => {
    const { harness, fake, workersDir } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const result = await harness.queryWorker(worker.worker_id, '侧问一下')

    expect(result).toMatchObject({ status: 'started', fork_seq: 2, query_id: expect.any(String) })
    expect(fake.forkCalls).toHaveLength(1)
    expect(fake.forkCalls[0].forkInput).toBe('侧问一下')

    const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(w.incarnations).toHaveLength(2)
    expect(w.incarnations[1]).toMatchObject({
      seq: 2,
      impl: 'builtin',
      state: 'running',
      query_id: result.query_id,
    })
    expect(w.task.status).toBe('running') // fork 不影响主线状态

    // forked_from 标记它不在主线化身链上(protocol-agent-v3 §3);session_ref 取
    // adapter.fork 返回的 handle 自己的引用,不是从主线(seq=1)照抄的(§6.1)。
    expect(w.incarnations[1].forked_from).toBe(w.incarnations[0].incarnation_id)
    expect(w.incarnations[1].session_ref).not.toBe(w.incarnations[0].session_ref)

    const onDisk = await new WorkerEventLog(join(workersDir, worker.worker_id)).readAll()
    expect(onDisk.filter((e) => e.detail?.query_id === result.query_id)).toHaveLength(1)
  })

  it('回答终态通知可在终态回调后立即投递，deferred/route throw 时保持 pending，consumed 后停止重报', async () => {
    const notifications: HarnessEvent[] = []
    let attempt = 0
    const { harness, fake, workersDir } = await makeHarness(
      { caps: { fork: true } },
      {
        onOperationNotification: async (_managerKey, event) => {
          notifications.push(event)
          attempt++
          if (attempt === 1) return { consumed: false }
          if (attempt === 2) throw new Error('manager route unavailable')
          return { consumed: true }
        },
      },
    )
    const worker = await harness.spawnWorker(spawnParams())
    const result = await harness.queryWorker(worker.worker_id, '可靠通知侧问', {
      managerKey: `test::friend-1` as ManagerKey,
    })
    fake.emitStateChange({
      worker_id: worker.worker_id,
      seq: result.fork_seq,
      impl: 'builtin',
      session_ref: `fork-ref-${worker.worker_id}#${result.fork_seq}`,
      query_id: result.query_id,
    }, 'exited', '侧问答案', 'completed')

    const queryStore = (harness as unknown as { queryReceiptStore: QueryReceiptStore }).queryReceiptStore
    await waitUntil(async () => (await queryStore.get(worker.worker_id, result.query_id))?.state === 'completed')

    await harness.sweepLiveness()
    expect((await queryStore.get(worker.worker_id, result.query_id))?.manager_notification.status).toBe('pending')
    await harness.sweepLiveness()
    expect((await queryStore.get(worker.worker_id, result.query_id))?.manager_notification.status).toBe('consumed')
    await harness.sweepLiveness()

    expect(notifications).toHaveLength(3)
    for (const event of notifications) {
      expect(event).toMatchObject({
        kind: 'query_completed',
        worker_id: worker.worker_id,
        seq: result.fork_seq,
        detail: {
          query_id: result.query_id,
          fork_seq: result.fork_seq,
        },
      })
    }
    const persisted = JSON.parse(
      await fs.readFile(join(workersDir, worker.worker_id, 'query-receipts.json'), 'utf8'),
    ) as { receipts: Array<Record<string, unknown>> }
    expect(persisted.receipts[0]).toMatchObject({ state: 'completed' })
  })

  it('重启对账不重跑 running query，结算 unknown 并尽力终止原 fork', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    const result = await harness.queryWorker(worker.worker_id, '重启中的侧问', {
      managerKey: `test::friend-1` as ManagerKey,
    })
    expect(fake.forkCalls).toHaveLength(1)

    await harness.reconcileQueryReceiptsOnStartup()

    expect(fake.forkCalls).toHaveLength(1)
    expect(fake.killCalls).toEqual([
      expect.objectContaining({
        worker_id: worker.worker_id,
        seq: result.fork_seq,
        query_id: result.query_id,
      }),
    ])
    const queryStore = (harness as unknown as { queryReceiptStore: QueryReceiptStore }).queryReceiptStore
    expect(await queryStore.get(worker.worker_id, result.query_id)).toMatchObject({
      state: 'failed',
      failure: {
        reason_code: 'query_execution_lost_after_restart',
        phase: 'execution',
        certainty: 'unknown',
      },
      manager_notification: { status: 'pending' },
    })
  })

  it('重启对账遇到 ledger 已明确完成但 receipt 仍 starting 时，据实结算 completed 且不建第二个 fork', async () => {
    const { harness, fake, ledger } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    const queryStore = (harness as unknown as { queryReceiptStore: QueryReceiptStore }).queryReceiptStore
    const queryId = 'query-crash-window-completed'
    const createdAt = now()
    await queryStore.create({
      query_id: queryId,
      worker_id: worker.worker_id,
      manager_key: `test::friend-1` as ManagerKey,
      question_preview: '已完成但 receipt 尚未提交',
      created_at: createdAt,
      updated_at: createdAt,
      establishment_deadline_at: new Date(Date.parse(createdAt) + 30_000).toISOString(),
      state: 'starting',
      manager_notification: { status: 'not_required' },
    })
    await ledger.upsertWorker(`test::friend-1` as ManagerKey, worker.worker_id, (prev) => prev && ({
      ...prev,
      incarnations: [
        ...prev.incarnations,
        {
          seq: 2,
          impl: 'builtin',
          state: 'exited',
          workspace: prev.incarnations[0].workspace,
          session_ref: 'fork-ref-completed',
          started_at: createdAt,
          ended_at: now(),
          ended_reason: 'completed',
          forked_from: 1,
          query_id: queryId,
        },
      ],
      updated_at: now(),
    }))

    await harness.reconcileQueryReceiptsOnStartup()

    expect(fake.forkCalls).toHaveLength(0)
    expect(fake.killCalls).toHaveLength(0)
    expect(await queryStore.get(worker.worker_id, queryId)).toMatchObject({
      state: 'completed',
      fork_seq: 2,
      manager_notification: { status: 'pending' },
    })
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
    expect(result.fork_seq).toBe(2)

    const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
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
    expect(forkSeqEvents.filter((e) => e.kind === 'query_completed')).toHaveLength(1)

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
    fake.fork = async (prev, forkInput, opts) => {
      resolveEntered()
      await forkGate
      return originalFork(prev, forkInput, opts)
    }
    return { forkEnteredPromise, release }
  }

  it('adapter.fork 卡住未落地期间,同一 worker 上的 send_to_worker 毫秒级完成,不排队等待 fork', async () => {
    const { harness, fake, workersDir } = await makeHarness({ caps: { fork: true } })
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
    const { harness, fake, workersDir } = await makeHarness({ caps: { fork: true } })
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
    expect(result.fork_seq).toBe(2)

    const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    // 主线(seq=1)保持 killWorker 落定的记录,完全不被这次迟到的 fork 落账污染。
    expect(w.task.status).toBe('closed')
    const mainEntry = w.incarnations.find((i) => i.seq === 1)!
    expect(mainEntry.state).toBe('exited')
    expect(mainEntry.ended_reason).toBe('killed')

    // fork 化身仍然被追加进化身链,forked_from 指向发起侧问那一刻的源 seq(1),不受主线
    // 后续变化影响。
    const forkEntry = w.incarnations.find((i) => i.seq === 2)!
    expect(forkEntry.forked_from).toBe(mainEntry.incarnation_id)
    expect(forkEntry.state).toBe('running')

    const stateEvents = (await new WorkerEventLog(join(workersDir, worker.worker_id)).readAll())
      .filter((e) => e.kind === 'state_changed' && e.detail?.query_id === result.query_id)
    expect(stateEvents).toHaveLength(1)
    expect(stateEvents[0].seq).toBe(2)
    expect(stateEvents[0].detail).toMatchObject({ kind: 'fork', from_seq: 1, query_id: result.query_id })
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
      const list = await harness.listWorkers(`test::friend-1` as ManagerKey)
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
  it('queryWorker fork 之后,sendToWorker/getWorkerTerminal/killWorker 仍作用于主线化身(seq=1),不被 fork(seq=2)顶替', async () => {
    const { harness, fake, workersDir } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const { fork_seq: forkSeq, query_id: queryId } = await harness.queryWorker(worker.worker_id, '侧问一下')
    expect(forkSeq).toBe(2)

    // 修复前:lastIncarnation() 取数组最后一个,fork 之后就是 seq=2 的侧问分支——
    // sendToWorker/killWorker/getWorkerTerminal 全部会错误地 target 到它,主线失联。
    await harness.sendToWorker(worker.worker_id, '继续干活')
    expect(fake.sendInputCalls).toHaveLength(1)
    expect(fake.sendInputCalls[0].h.seq).toBe(1)

    await harness.getWorkerTerminal(worker.worker_id)
    expect(fake.readTerminalCalls).toHaveLength(1)
    expect(fake.readTerminalCalls[0].seq).toBe(1)

    await harness.killWorker(worker.worker_id, '测试终止')
    expect(fake.killCalls).toHaveLength(2)
    expect(fake.killCalls.map((call) => call.seq).sort()).toEqual([1, 2])

    const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    expect(w.task.status).toBe('closed') // 主线被正确终结,不是台账显示 fork 被 kill 而主线孤儿
    const mainEntry = w.incarnations.find((i) => i.seq === 1)!
    expect(mainEntry.state).toBe('exited')
    expect(mainEntry.ended_reason).toBe('killed')
    // stop 也会停掉登记的 fork，避免留下与已取消主任务脱节的执行分支。
    const forkEntry = w.incarnations.find((i) => i.seq === 2)!
    expect(forkEntry.state).toBe('exited')
  })

  it('processStateChange:fork 化身(seq=2)自己的状态变化只更新它自己的化身条目,不推进主线 task.status', async () => {
    const { harness, fake, workersDir } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    await harness.queryWorker(worker.worker_id, '侧问一下')
    events.length = 0

    // fork 化身自然结束(如 builtin 的 runForkBurst 跑完侧问),不是 harness.killWorker 触发。
    fake.emitStateChange({ worker_id: worker.worker_id, seq: 2, impl: 'builtin', session_ref: 'fork-ref' }, 'exited')

    await waitUntil(async () => {
      const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
      return w.incarnations.find((i) => i.seq === 2)?.state === 'exited'
    })

    const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
    // 主线(seq=1)完全不受 fork 结束的影响——修复前 lastIncarnation() 会把这次回调当成
    // "当前化身"的回调,错误地把 task.status 推进到 completed。
    expect(w.task.status).toBe('running')
    const mainEntry = w.incarnations.find((i) => i.seq === 1)!
    expect(mainEntry.state).toBe('running')

    const forkEntry = w.incarnations.find((i) => i.seq === 2)!
    expect(forkEntry.state).toBe('exited')
    expect(forkEntry.ended_reason).toBe('completed')

    await waitUntil(async () => (await new WorkerEventLog(join(workersDir, worker.worker_id)).readAll())
      .some((event) => event.kind === 'query_completed' && event.seq === 2))
    const terminalEvents = (await new WorkerEventLog(join(workersDir, worker.worker_id)).readAll())
      .filter((event) => event.kind === 'query_completed' && event.seq === 2)
    expect(terminalEvents).toHaveLength(1)
  })
})

describe('WorkerHarness.getWorkerTerminal', () => {
  it('正常路径:透传 adapter.readTerminal 的结果', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())

    const result = await harness.getWorkerTerminal(worker.worker_id)

    expect(result).toEqual({ kind: 'unavailable', unavailable_reason: 'headless_without_text' })
    expect(fake.readTerminalCalls).toHaveLength(1)
    expect(fake.readTerminalCalls[0]).toEqual({ worker_id: worker.worker_id, seq: 1, impl: 'builtin', session_ref: `ref-${worker.worker_id}#1` })
  })

  it('不存在的 worker_id → WorkerNotFoundError', async () => {
    const { harness } = await makeHarness()
    await expect(harness.getWorkerTerminal('w-does-not-exist')).rejects.toThrow(WorkerNotFoundError)
  })

  it('化身实现没有注册对应 adapter → 抛错,不静默返回空结果', async () => {
    const { harness, fake, adaptersMap } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    adaptersMap.delete(fake.implId)

    await expect(harness.getWorkerTerminal(worker.worker_id)).rejects.toThrow(/no adapter registered/)
  })

  // ---- P4 Task 4:opts.seq 读指定化身(query_worker fork 分支的答案) ----

  it('给 opts.seq → 读取该 seq 对应化身(如 fork 分支)的输出,不是主线', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    const { fork_seq: forkSeq, query_id: queryId } = await harness.queryWorker(worker.worker_id, '侧问一下')

    const result = await harness.getWorkerTerminal(worker.worker_id, { seq: forkSeq })

    expect(result).toEqual({ kind: 'unavailable', unavailable_reason: 'headless_without_text' })
    expect(fake.readTerminalCalls).toHaveLength(1)
    expect(fake.readTerminalCalls[0]).toEqual({
      worker_id: worker.worker_id,
      seq: forkSeq,
      impl: 'builtin',
      session_ref: `fork-ref-${worker.worker_id}#${forkSeq}`,
      query_id: queryId,
    })
  })

  it('省略 opts(或不传 seq)→ 逐字沿用既有行为,读主线化身,fork 之后也不被顶替', async () => {
    const { harness, fake } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    await harness.queryWorker(worker.worker_id, '侧问一下')

    await harness.getWorkerTerminal(worker.worker_id)

    expect(fake.readTerminalCalls).toHaveLength(1)
    expect(fake.readTerminalCalls[0].seq).toBe(1)
  })

  it('opts.seq 在台账中不存在 → 抛出明确错误,不静默返回空 chunk', async () => {
    const { harness } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())

    await expect(harness.getWorkerTerminal(worker.worker_id, { seq: 99 })).rejects.toThrow(/seq/)
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

    const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
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

    const spawned = events.filter((e) => e.kind === 'lifecycle_changed')
    expect(spawned).toHaveLength(1)
    expect(spawned[0].detail).toMatchObject({ change: 'spawned' })
    expect(spawned[0].task_status).toBe('running')
    expect(spawned[0].task_status).toBe(worker.task.status)
  })

  it('迁移点:spawn 失败 → exited 带 failed(端点正确;中间的 running 无事件,仍折叠)', async () => {
    const { harness } = await makeHarness({ spawnShouldFail: new Error('spawn 炸了') })
    await expect(harness.spawnWorker(spawnParams())).rejects.toThrow('spawn 炸了')

    const exited = events.filter((e) => e.kind === 'exited')
    expect(exited).toHaveLength(1)
    expect(exited[0].task_status).toBe('halted')
  })

  it('迁移点:主线状态回调 → state_changed 带落账后的 waiting_input / completed', async () => {
    const { harness, fake } = await makeHarness()
    const worker = await harness.spawnWorker(spawnParams())
    const handle = { worker_id: worker.worker_id, seq: 1, impl: 'builtin' as WorkerImplId, session_ref: `ref-${worker.worker_id}#1` }
    events.length = 0

    fake.emitStateChange(handle, 'idle')
    await waitUntil(async () => events.some((e) => e.kind === 'state_changed'))
    expect(events.filter((e) => e.kind === 'state_changed')[0].task_status).toBe('halted')

    fake.emitStateChange(handle, 'exited')
    await waitUntil(async () => events.filter((e) => e.kind === 'state_changed').length >= 2)
    expect(events.filter((e) => e.kind === 'state_changed')[1].task_status).toBe('halted')
  })

  it('迁移点:verified stop → operation_settled 带 closed(stop_verified 已降审计)', async () => {
    const opEvents: HarnessEvent[] = []
    const { harness } = await makeHarness({}, {
      onOperationNotification: async (_managerKey, e) => { opEvents.push(e); return { consumed: true } },
    })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await harness.killWorker(worker.worker_id, '用户要求终止')

    await waitUntil(() => opEvents.filter((e) => e.kind === 'operation_settled').length === 1)
    const settled = opEvents.filter((e) => e.kind === 'operation_settled')
    expect(settled[0].task_status).toBe('closed')
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

  it('非迁移点:stop 后 drain 出的 dead_letter 不带 task_status(迁移由 operation_settled 承载)', async () => {
    const opEvents: HarnessEvent[] = []
    const { harness } = await makeHarness({
      // 让第一条卡在投递里,第二条就会留在队列上等 killWorker 去 drain
      sendInputBehavior: () => new Promise((resolve) => setTimeout(resolve, 30)),
    }, {
      onOperationNotification: async (_managerKey, e) => { opEvents.push(e); return { consumed: true } },
    })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    const inFlight = harness.sendToWorker(worker.worker_id, '第一条')
    const queued = harness.sendToWorker(worker.worker_id, '第二条').catch(() => undefined)
    await harness.killWorker(worker.worker_id)
    await inFlight.catch(() => undefined)
    await queued

    // 死信已降审计：读 events.jsonl 而非唤醒面
    const deadLetters = (await harness.readWorkerEvents(worker.worker_id))
      .filter((e) => e.kind === 'state_changed' && e.detail?.kind === 'dead_letter')
    expect(deadLetters.length).toBeGreaterThan(0)
    for (const e of deadLetters) expect(e.task_status).toBeUndefined()
    // 同一次 verified stop 的迁移载体是 operation_settled（唯一唤醒，自带 closed）
    await waitUntil(() => opEvents.some((e) => e.kind === 'operation_settled'))
    expect(opEvents.find((e) => e.kind === 'operation_settled')?.task_status).toBe('closed')
  })

  it('非迁移点:query_failed 不带 task_status', async () => {
    const { harness, workersDir } = await makeHarness({ caps: { fork: false } })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await expect(harness.queryWorker(worker.worker_id, '侧问')).rejects.toThrow(QueryEstablishmentError)

    const queryFailed = (await new WorkerEventLog(join(workersDir, worker.worker_id)).readAll())
      .filter((e) => e.kind === 'query_failed')
    expect(queryFailed).toHaveLength(1)
    expect(queryFailed[0].task_status).toBeUndefined()
  })

  it('非迁移点:fork 化身的落账事件不带 task_status(§5.3 fork 不影响主线)', async () => {
    const { harness, workersDir } = await makeHarness({ caps: { fork: true } })
    const worker = await harness.spawnWorker(spawnParams())
    events.length = 0

    await harness.queryWorker(worker.worker_id, '侧问')

    const forkEvents = (await new WorkerEventLog(join(workersDir, worker.worker_id)).readAll())
      .filter((e) => e.seq === 2)
    expect(forkEvents.length).toBeGreaterThan(0)
    for (const e of forkEvents) expect(e.task_status).toBeUndefined()
    // 台账确实没动主线 task.status——事件不带这个字段与台账事实一致
    const [w] = await harness.listWorkers(`test::friend-1` as ManagerKey)
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
