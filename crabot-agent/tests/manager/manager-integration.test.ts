/**
 * Manager loop 端到端集成测试(P4 Task 10)——protocol-agent-v3.md §4。
 *
 * Task 1-9 的单元测试都用 fake harness / fake toolFace 证明各模块自身编排正确,但从未验证过
 * 真实装配路径:`ManagerRegistry` + 真实 `WorkerHarness` + 真实 `BuiltinWorkerAdapter`(mock
 * LLM)+ 真实 `buildManagerToolFace` 装配出的工具面,串起来是否真的按协议跑得通。本文件补上
 * 这一层,骨架照抄 `tests/workers/harness/harness-integration.test.ts`(P3 产出):真实
 * `WorkerHarness` + 真实 `BuiltinWorkerAdapter`(mock LLM)+ 按 harness.ts 文件头"onStateChange
 * 接线契约"的四步接线(空 Map → new WorkerHarness → 构造 adapter 时传入
 * `harness.handleStateChange` → set 回同一 Map)+ 注入 `now()` + `events[]` 收集 +
 * `waitUntil` 轮询。
 *
 * ## builtin worker 的运行配置从哪来
 *
 * `worker-tools.ts` 的 `spawn_worker` 调 `harness.spawnWorker(...)` 时**不传** `builtin` 字段
 * ——`SpawnSpec.builtin`(worker 的 LLM adapter/model/systemPrompt/tools)是装配层注入的,
 * 不可能来自 LLM 的工具入参。PR F 之前 `spawnWorker` 压根不读注入工厂(只有
 * `handoffIncarnation` 消费),本文件为此包过一个私有的 `BuiltinAutoConfigAdapter` 垫片;
 * PR F 第 1 步给 `spawnWorker` 补上了"缺 `builtin` 就回退调 `builtinSpawnDefaults(ctx)`"
 * 的生产路径,垫片随之退役。现在测试只需给 `HarnessDeps.builtinSpawnDefaults` 一个按队列
 * 出配置的工厂,spawn 走的就是生产回退路径本身。
 *
 * @see .superpowers/sdd/task-10-brief.md
 * @see crabot-docs/superpowers/specs/2026-08-01-builtin-worker-injection-design.md
 * @see crabot-docs/protocols/protocol-agent-v3.md §4
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'node:crypto'

import { WorkerHarness, type HarnessDeps } from '../../src/workers/harness/harness'
import { LedgerStore, encodeSegment } from '../../src/workers/harness/ledger-store'
import { WorkspaceManager } from '../../src/workers/harness/workspace-manager'
import { dialogObjectIdForPrivate, type DialogObjectId } from '../../src/workers/harness/ledger-types'
import type { HarnessEvent } from '../../src/workers/harness/worker-events'
import { BuiltinWorkerAdapter } from '../../src/workers/builtin/adapter.js'
import type {
  WorkerImplId,
  WorkerAdapter,
  IncarnationHandle,
  IncarnationRef,
  SpawnSpec,
  DetectResult,
  WorkerContractState,
  OutputCursor,
  AdapterCapabilities,
} from '../../src/workers/types'

import { ManagerRegistry, SYSTEM_TASKS_MANAGER_KEY, type ManagerRegistryDeps } from '../../src/manager/registry.js'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import type { CompactionPolicy } from '../../src/manager/compaction.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { ChannelMessage } from '../../src/types.js'
import { buildManagerToolFace } from '../../src/manager/tools/tool-face.js'
import { createCrabMemoryServer } from '../../src/mcp/crab-memory.js'
import { createUserMessage } from '../../src/engine/index.js'
import type { LLMAdapter, LLMStreamParams, ToolDefinition } from '../../src/engine/index.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

// ============================================================================
// 共用 helpers
// ============================================================================

async function waitUntil(cond: () => Promise<boolean> | boolean, timeoutMs = 8000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitUntil timed out')
}

function makeChannelMessage(text: string): ChannelMessage {
  return {
    platform_message_id: `pm-${Math.random().toString(36).slice(2)}`,
    session: { session_id: 'sess', channel_id: 'wechat', type: 'private' },
    sender: { platform_user_id: 'u1', platform_display_name: '测试用户' },
    content: { type: 'text', text },
    features: { is_mention_crab: false },
    platform_timestamp: new Date().toISOString(),
  }
}

/** worker 侧 mock LLM(照抄 harness-integration.test.ts 的 makeLLM):脚本耗尽后重放最后一条。 */
function makeWorkerLLM(
  responses: Array<{
    text?: string
    toolCalls?: Array<{ name: string; id: string; input: Record<string, unknown> }>
    stopReason: 'end_turn' | 'tool_use'
  }>,
): LLMAdapter {
  let i = 0
  return {
    stream: vi.fn(async function* () {
      const r = responses[i++] ?? responses[responses.length - 1]
      const content: unknown[] = []
      if (r.text) content.push({ type: 'text', text: r.text })
      for (const tc of r.toolCalls ?? []) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      yield* chunksFromContent(content, r.stopReason, { inputTokens: 100, outputTokens: 50 })
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

const FOLD_SYSTEM_PROMPT_MARKER = '对话历史压缩助手'

interface TurnScript {
  readonly text?: string
  readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly id: string; readonly input: Record<string, unknown> }>
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
}

/** manager 侧脚本化 mock LLM:队列驱动 turn,系统 prompt 含折叠标记时单独记入 foldCalls(照抄 loop.test.ts 约定)。 */
function makeManagerAdapter(): {
  readonly adapter: LLMAdapter
  readonly queue: TurnScript[]
  readonly calls: LLMStreamParams[]
  readonly foldCalls: LLMStreamParams[]
} {
  const queue: TurnScript[] = []
  const calls: LLMStreamParams[] = []
  const foldCalls: LLMStreamParams[] = []
  const adapter: LLMAdapter = {
    async *stream(params: LLMStreamParams) {
      const snapshot: LLMStreamParams = { ...params, messages: [...params.messages] }
      calls.push(snapshot)
      if (params.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER)) {
        foldCalls.push(snapshot)
        yield* chunksFromContent([{ type: 'text', text: '折叠后的摘要' }], 'end_turn')
        return
      }
      const r = queue.shift() ?? { text: '(默认回复)', stopReason: 'end_turn' as const }
      const content: unknown[] = []
      if (r.text) content.push({ type: 'text', text: r.text })
      for (const tc of r.toolCalls ?? []) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      yield* chunksFromContent(content, r.stopReason, { inputTokens: 10, outputTokens: 5 })
    },
    updateConfig: () => {},
  }
  return { adapter, queue, calls, foldCalls }
}

const GENEROUS_POLICY: CompactionPolicy = {
  keepRecent: 1000,
  cacheTtlMs: 10_000_000,
  foldTokenThreshold: 10_000_000,
  hardCapTokens: 10_000_000,
}

/** `ManagerKey`("channel::session")→{channel_id, session_id},纯字符串切分,测试专用。 */
function channelSessionFromKey(key: ManagerKey): { channel_id: string; session_id: string } {
  const [channel_id, session_id] = key.split('::')
  return { channel_id, session_id }
}

/**
 * worker 自然跑到终态(finish_task/burst 正常收尾)时,harness.processStateChange 落的事件
 * kind 恒为 'state_changed'、`detail.to==='exited'`——`'exited'` 这个 HarnessEventKind 只在
 * spawn 失败 / reconcileOnStartup 判崩 / fork 化身完成三条路径使用(读 harness.ts 的
 * `appendEvent(..., 'exited', ...)` 调用点确认,不是猜测),不对应本文件场景一/二里
 * worker 主线正常 finish_task 收尾这条路径。取最后一条匹配的事件(理论上只有一条:该 worker
 * 单轮 burst 内直接从 running 转 exited,不经过 idle 中间态)。
 */
function findWorkerExitedEvent(events: readonly HarnessEvent[], workerId: string): HarnessEvent | undefined {
  return [...events].reverse().find((e) => e.worker_id === workerId && e.kind === 'state_changed' && e.detail?.to === 'exited')
}

// ============================================================================
// ForklessStubAdapter —— 场景四专用:如实实现 capabilities().fork===false 的 worker 实现
// (照 codex adapter 的真实声明,不是伪造;不驱动任何真实 CLI,provision/spawn/state 均为
// 最小可用实现,唯一要紧的是 capabilities() 如实返回 fork:false,让 harness.queryWorker
// 的真实能力校验分支真正被命中)
// ============================================================================

class ForklessStubAdapter implements WorkerAdapter {
  readonly implId: WorkerImplId = 'codex'
  async detect(): Promise<DetectResult> {
    return { installed: true, activated: true }
  }
  async provision(): Promise<void> {}
  async spawn(spec: SpawnSpec): Promise<IncarnationHandle> {
    return { worker_id: spec.worker_id, seq: 1, impl: 'codex', session_ref: `stub-session-${spec.worker_id}` }
  }
  async resume(prev: IncarnationRef): Promise<IncarnationHandle> {
    return { worker_id: prev.worker_id, seq: prev.seq, impl: 'codex', session_ref: prev.session_ref }
  }
  async fork(): Promise<IncarnationHandle> {
    // 真实场景下这里永远不会被调用到——harness.queryWorker 在调用 adapter.fork 之前已经按
    // capabilities().fork===false 短路拒绝(见 harness.ts queryWorker 方法注释"锁内判定段")。
    throw new Error('ForklessStubAdapter.fork: unreachable, capabilities().fork is false')
  }
  async sendInput(): Promise<void> {}
  async readOutput(): Promise<{ chunk: string; nextCursor: OutputCursor }> {
    return { chunk: '', nextCursor: { offset: 0 } }
  }
  async state(): Promise<WorkerContractState> {
    return 'running'
  }
  async kill(): Promise<void> {}
  capabilities(): AdapterCapabilities {
    return { fork: false, revive: false, goalMode: false, subagent: false, structuredTrace: false }
  }
}

// ============================================================================
// 装配:真实 WorkerHarness + 真实 BuiltinWorkerAdapter + 真实 buildManagerToolFace + 真实 ManagerRegistry
// ============================================================================

interface AssemblyOptions {
  readonly dataDir: string
  readonly policy: CompactionPolicy
  readonly managerAdapter: LLMAdapter
  readonly managerNow: () => Date
  readonly extraAdapters?: ReadonlyArray<readonly [WorkerImplId, WorkerAdapter]>
}

interface ToolCallLogEntry {
  readonly key: ManagerKey
  readonly name: string
  readonly input: unknown
}

interface Assembly {
  readonly registry: ManagerRegistry
  readonly harness: WorkerHarness
  readonly ledger: LedgerStore
  readonly store: ManagerSessionStore
  readonly events: HarnessEvent[]
  readonly toolCallLog: ToolCallLogEntry[]
  readonly rpcCalls: Array<{ port: number; method: string; params: unknown }>
  readonly builtinConfigQueue: Array<NonNullable<SpawnSpec['builtin']>>
  readonly dialogObjectIdFor: (key: ManagerKey) => DialogObjectId
}

async function setupAssembly(opts: AssemblyOptions): Promise<Assembly> {
  const ledgersDir = join(opts.dataDir, 'ledgers')
  const workspacesRoot = join(opts.dataDir, 'workspaces')
  const workersDir = join(opts.dataDir, 'workers')
  const builtinDataDir = join(opts.dataDir, 'builtin-adapter')
  await fs.mkdir(workspacesRoot, { recursive: true })

  const ledger = new LedgerStore(ledgersDir)
  const workspaces = new WorkspaceManager(workspacesRoot)
  const adaptersMap = new Map<WorkerImplId, WorkerAdapter>()
  const events: HarnessEvent[] = []
  let harnessNowMs = Date.parse('2026-01-01T00:00:00.000Z')
  const harnessNow = (): string => {
    harnessNowMs += 1000
    return new Date(harnessNowMs).toISOString()
  }

  // 每次 builtin spawn 的运行配置由测试预置队列给出。PR F 之前这里包了一个私有的
  // `BuiltinAutoConfigAdapter` 垫片在 `spec.builtin` 缺失时补配置;现在生产的 harness 自己
  // 在缺失时回退到 `builtinSpawnDefaults`(spec 决策 1),垫片因此退役——语义完全一样
  //(spawn_worker 工具不传 builtin,配置由装配层现取),但走的是生产回退路径。
  const builtinConfigQueue: Array<NonNullable<SpawnSpec['builtin']>> = []
  const harnessDeps: HarnessDeps = {
    adapters: adaptersMap,
    defaultImpl: 'builtin',
    ledger,
    workspaces,
    workersDir,
    now: harnessNow,
    onEvent: (e) => events.push(e),
    builtinSpawnDefaults: () => {
      const cfg = builtinConfigQueue.shift()
      if (!cfg) throw new Error('测试装配缺口:没有为下一次 builtin spawn 预置 builtinConfigQueue 条目')
      return cfg
    },
  }
  // onStateChange 接线契约(harness.ts 文件头):先构造空 Map 传给 harness,harness 构造完成后
  // 把 handleStateChange 传给真实 adapter 的构造函数,再把 adapter 塞回同一个底层 Map——
  // 与 P4 真实接线顺序一致,不是手动模拟回调触发。
  const harness = new WorkerHarness(harnessDeps)

  const builtinAdapter = new BuiltinWorkerAdapter({ dataDir: builtinDataDir, onStateChange: harness.handleStateChange })
  adaptersMap.set('builtin', builtinAdapter)
  for (const [implId, adapter] of opts.extraAdapters ?? []) adaptersMap.set(implId, adapter)

  const store = new ManagerSessionStore(join(opts.dataDir, 'manager-sessions'))

  const rpcCalls: Array<{ port: number; method: string; params: unknown }> = []
  const rpcHandlers = new Map<string, (params: unknown) => unknown>()
  rpcHandlers.set('send_message', () => ({
    platform_message_id: `pm-${randomUUID().slice(0, 8)}`,
    sent_at: new Date().toISOString(),
  }))
  rpcHandlers.set('find_master_friend', () => ({
    friend: {
      id: 'friend-master',
      display_name: 'Master',
      permission: 'master',
      channel_identities: [{ channel_id: 'wechat', platform_user_id: 'master-uid' }],
    },
  }))
  rpcHandlers.set('find_or_create_private_session', () => ({ session: { id: 'sess-master-private' }, created: true }))
  const rpcClient = {
    call: vi.fn(async (port: number, method: string, params: unknown) => {
      rpcCalls.push({ port, method, params })
      const handler = rpcHandlers.get(method)
      return handler ? handler(params) : {}
    }),
  }

  const memoryServer = createCrabMemoryServer(
    { rpcClient: { call: vi.fn() } as never, moduleId: 'manager-integ-test', getMemoryPort: async () => 19100 },
    { visibility: 'internal', scopes: [], isMasterPrivate: false },
  )
  const messagingDeps = {
    rpcClient: rpcClient as never,
    moduleId: 'manager-integ-test',
    getAdminPort: async () => 1,
    resolveChannelPort: async () => 2,
  }

  const dialogObjectIdFor = (key: ManagerKey): DialogObjectId => dialogObjectIdForPrivate(`friend-of-${key}`)

  const toolCallLog: ToolCallLogEntry[] = []

  const registryDeps: ManagerRegistryDeps = {
    store,
    policy: opts.policy,
    estimateTokens: (msgs) => msgs.length * 10,
    harness,
    ledger,
    now: opts.managerNow,
    dialogObjectIdFor,
    adapter: () => opts.managerAdapter,
    model: () => 'test-manager-model',
    toolFace: (key, isSystemThread, onAsyncError) => {
      const tools = buildManagerToolFace({
        harness,
        workerContext: () => ({
          dialogObjectId: dialogObjectIdFor(key),
          managerKey: key,
          reportTo: channelSessionFromKey(key),
          triggerType: isSystemThread ? 'system' : 'message',
        }),
        messagingDeps,
        memoryServer,
        callAdmin: async () => ({}),
        isSystemThread,
        onAsyncError,
      })
      // 记录每次真实工具调用(名称+入参),供断言"工具调用序列符合预期" / "send_master_private
      // 是否被调用"——不干预调用本身,只是在真实 call 前后各插一条日志。
      return tools.map(
        (t): ToolDefinition => ({
          ...t,
          call: async (input, ctx) => {
            toolCallLog.push({ key, name: t.name, input })
            return t.call(input, ctx)
          },
        }),
      )
    },
    promptInputs: () => ({}),
  }

  const registry = new ManagerRegistry(registryDeps)

  return { registry, harness, ledger, store, events, toolCallLog, rpcCalls, builtinConfigQueue, dialogObjectIdFor }
}

// ============================================================================
// 场景
// ============================================================================

describe('manager-integration（P4 Task 10：真实 ManagerRegistry + 真实 WorkerHarness + 真实 builtin adapter + 真实工具面）', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(join(tmpdir(), 'manager-integ-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  // --- 场景一：私聊派活全链路 ---

  it(
    '场景一：routeHumanMessages(私聊)→ manager spawn_worker → 真实 builtin worker(mock LLM)finish_task ' +
      '→ harness 事件经 routeWorkerEvent 唤醒同一 manager → read_worker_output → send_message → end_turn',
    async () => {
      const managerScript = makeManagerAdapter()
      const managerNowMs = Date.parse('2026-01-01T00:00:00.000Z')
      const assembly = await setupAssembly({
        dataDir,
        policy: GENEROUS_POLICY,
        managerAdapter: managerScript.adapter,
        managerNow: () => new Date(managerNowMs),
      })

      const workerLLM = makeWorkerLLM([
        {
          text: '调研完成，结论是：X 方案可行，建议采用。',
          toolCalls: [{ name: 'finish_task', id: 'call_finish', input: { outcome: 'completed', summary: 'X 方案可行' } }],
          stopReason: 'tool_use',
        },
      ])
      assembly.builtinConfigQueue.push({ adapter: workerLLM, model: 'test-worker-model', systemPrompt: '', tools: [] })

      // episode 1：收到人类消息 → 决定 spawn_worker → 确认已安排（end_turn，等待事件唤醒）
      managerScript.queue.push({
        toolCalls: [{ name: 'spawn_worker', id: 'call_spawn', input: { title: '调研 X', prompt: '帮我调研一下 X 的情况' } }],
        stopReason: 'tool_use',
      })
      managerScript.queue.push({ text: '好的，已经安排 worker 去调研 X，完成后会向您汇报。', stopReason: 'end_turn' })

      const key = 'wechat::sess-1' as ManagerKey
      const episode1 = await assembly.registry.routeHumanMessages('wechat', 'sess-1', [makeChannelMessage('帮我调研一下 X')])
      expect(episode1.outcome).toBe('completed')
      expect(assembly.toolCallLog.some((c) => c.name === 'spawn_worker')).toBe(true)

      // 等真实 worker 后台把 finish_task 跑完——burst 是 fire-and-forget,不是靠猜时序。
      await waitUntil(async () => {
        const workers = await assembly.harness.listWorkers(assembly.dialogObjectIdFor(key))
        return workers.some((w) => w.task.status === 'completed')
      })
      const [worker] = await assembly.harness.listWorkers(assembly.dialogObjectIdFor(key))
      // 台账 task 终态正确
      expect(worker.task.status).toBe('completed')
      expect(worker.incarnations).toHaveLength(1)
      expect(worker.incarnations[0].state).toBe('exited')
      expect(worker.incarnations[0].ended_reason).toBe('completed')

      const exitedEvent = findWorkerExitedEvent(assembly.events, worker.worker_id)
      expect(exitedEvent).toBeDefined()

      // episode 2：harness 事件经 routeWorkerEvent 唤醒同一 manager → read_worker_output → send_message → end_turn
      managerScript.queue.push({
        toolCalls: [{ name: 'read_worker_output', id: 'call_read', input: { worker_id: worker.worker_id } }],
        stopReason: 'tool_use',
      })
      managerScript.queue.push({
        toolCalls: [
          {
            name: 'send_message',
            id: 'call_send',
            input: { channel_id: 'wechat', session_id: 'sess-1', content: '调研结论：X 方案可行，建议采用。' },
          },
        ],
        stopReason: 'tool_use',
      })
      managerScript.queue.push({ text: '已经答复用户。', stopReason: 'end_turn' })

      const episode2 = await assembly.registry.routeWorkerEvent(exitedEvent!)
      expect(episode2?.outcome).toBe('completed')
      expect(episode2!.episodeId).not.toBe(episode1.episodeId)

      // manager session 历史含两个 episode（两次唤醒各自的 episode 日志文件）
      const episodesDir = join(dataDir, 'manager-sessions', encodeSegment(key), 'episodes')
      const episodeFiles = await fs.readdir(episodesDir)
      expect(episodeFiles.sort()).toEqual([`${episode1.episodeId}.jsonl`, `${episode2!.episodeId}.jsonl`].sort())

      // 发出的消息内容含 worker 的结论
      const sendCall = assembly.rpcCalls.find((c) => c.method === 'send_message')
      expect(sendCall).toBeDefined()
      expect(JSON.stringify(sendCall!.params)).toContain('X 方案可行')

      // 工具调用序列符合预期
      expect(assembly.toolCallLog.filter((c) => c.key === key).map((c) => c.name)).toEqual([
        'spawn_worker',
        'read_worker_output',
        'send_message',
      ])
    },
    20000,
  )

  // --- 场景二：系统任务线程 ---

  it(
    '场景二：routeSchedule(无 targetSession)唤醒系统线程 manager；例行成功留在本线程（不调 send_master_private），' +
      '失败场景改走 send_master_private',
    async () => {
      const managerScript = makeManagerAdapter()
      const managerNowMs = Date.parse('2026-01-01T00:00:00.000Z')
      const assembly = await setupAssembly({
        dataDir,
        policy: GENEROUS_POLICY,
        managerAdapter: managerScript.adapter,
        managerNow: () => new Date(managerNowMs),
      })

      // --- 成功路径：worker A 顺利完成 ---
      const workerALLM = makeWorkerLLM([
        { toolCalls: [{ name: 'finish_task', id: 'c1', input: { outcome: 'completed', summary: '例行巡检无异常' } }], stopReason: 'tool_use' },
      ])
      assembly.builtinConfigQueue.push({ adapter: workerALLM, model: 'm', systemPrompt: '', tools: [] })

      managerScript.queue.push({
        toolCalls: [{ name: 'spawn_worker', id: 's1', input: { title: '例行巡检', prompt: '巡检一下系统状态' } }],
        stopReason: 'tool_use',
      })
      managerScript.queue.push({ text: '已安排巡检任务。', stopReason: 'end_turn' })

      const scheduleResult1 = await assembly.registry.routeSchedule({ scheduleId: 'sc-1', title: '例行巡检', description: '每日巡检' })
      expect(scheduleResult1.outcome).toBe('completed')

      await waitUntil(async () => {
        const workers = await assembly.harness.listWorkers(assembly.dialogObjectIdFor(SYSTEM_TASKS_MANAGER_KEY))
        return workers.some((w) => w.task.status === 'completed')
      })
      const [workerA] = await assembly.harness.listWorkers(assembly.dialogObjectIdFor(SYSTEM_TASKS_MANAGER_KEY))
      const exitedEventA = findWorkerExitedEvent(assembly.events, workerA.worker_id)!

      managerScript.queue.push({
        toolCalls: [{ name: 'read_worker_output', id: 'r1', input: { worker_id: workerA.worker_id } }],
        stopReason: 'tool_use',
      })
      managerScript.queue.push({ text: '巡检顺利完成，一切正常，例行事项，无需上报 master。', stopReason: 'end_turn' })

      const episodeSuccess = await assembly.registry.routeWorkerEvent(exitedEventA)
      expect(episodeSuccess?.outcome).toBe('completed')
      expect(assembly.toolCallLog.some((c) => c.name === 'send_master_private')).toBe(false)

      // --- 失败路径：worker B 报告失败，改走 send_master_private ---
      //
      // 发现的真实缺口(记入 task-10-report.md/PROGRESS.md,不在本任务修复范围):
      // `WorkerHarness.processStateChange`(harness.ts,P3 既有代码)硬编码
      // `endReason = state === 'exited' ? 'completed' : undefined`——`WorkerAdapter.onStateChange`
      // 回调接口本身只带 `(handle, state)` 三态,没有 endReason 通道,harness 因此在"化身自然
      // 结束"这条被动回调路径上**永远**把 task.status 判成 'completed',不论 worker 自己的
      // `finish_task(outcome='failed')` 说了什么(worker 自身 meta.json 是对的,真值在
      // onStateChange 这一跳丢失)。经真实 `harness.spawnWorker` + 真实 `BuiltinWorkerAdapter`
      // 直接复现确认(非本文件测试装配引入的偏差)。因此这里按**实际观察到的行为**推进:
      // worker B 的 task.status 最终仍是 'completed';manager 能感知到失败,靠的是读到
      // worker 在 finish_task 之前吐出的文本结论(assistantText 经 onTurn 写进 outputLog,
      // 不依赖 task.status/ended_reason)——这条路径本身没有缺陷,只是"结构化终态"这一路
      // 信号目前失真。
      const workerBLLM = makeWorkerLLM([
        {
          text: '巡检过程中遇到无法恢复的错误，任务未能完成，需要人工介入排查。',
          toolCalls: [{ name: 'finish_task', id: 'c2', input: { outcome: 'failed', summary: '巡检遇到不可恢复错误' } }],
          stopReason: 'tool_use',
        },
      ])
      assembly.builtinConfigQueue.push({ adapter: workerBLLM, model: 'm', systemPrompt: '', tools: [] })

      managerScript.queue.push({
        toolCalls: [{ name: 'spawn_worker', id: 's2', input: { title: '例行巡检2', prompt: '巡检一下系统状态' } }],
        stopReason: 'tool_use',
      })
      managerScript.queue.push({ text: '已安排巡检任务。', stopReason: 'end_turn' })

      const scheduleResult2 = await assembly.registry.routeSchedule({ scheduleId: 'sc-2', title: '例行巡检', description: '每日巡检' })
      expect(scheduleResult2.outcome).toBe('completed')

      await waitUntil(async () => {
        const workers = await assembly.harness.listWorkers(assembly.dialogObjectIdFor(SYSTEM_TASKS_MANAGER_KEY))
        return workers.filter((w) => w.task.status === 'completed').length >= 2
      })
      const workersAfterB = await assembly.harness.listWorkers(assembly.dialogObjectIdFor(SYSTEM_TASKS_MANAGER_KEY))
      const workerB = workersAfterB.find((w) => w.worker_id !== workerA.worker_id)!
      // 如实钉住上面注释描述的现状(已知缺口,不是期望行为)：
      expect(workerB.task.status).toBe('completed')
      expect(workerB.incarnations[0].ended_reason).toBe('completed')
      const exitedEventB = findWorkerExitedEvent(assembly.events, workerB.worker_id)!

      managerScript.queue.push({
        toolCalls: [{ name: 'read_worker_output', id: 'r2', input: { worker_id: workerB.worker_id } }],
        stopReason: 'tool_use',
      })
      managerScript.queue.push({
        toolCalls: [{ name: 'send_master_private', id: 'm1', input: { content: '巡检任务失败，需要人工介入排查。' } }],
        stopReason: 'tool_use',
      })
      managerScript.queue.push({ text: '已上报 master。', stopReason: 'end_turn' })

      const episodeFailure = await assembly.registry.routeWorkerEvent(exitedEventB)
      expect(episodeFailure?.outcome).toBe('completed')
      expect(assembly.toolCallLog.some((c) => c.name === 'send_master_private')).toBe(true)
      expect(assembly.rpcCalls.some((c) => c.method === 'find_master_friend')).toBe(true)
    },
    20000,
  )

  // --- 场景三：跨 TTL 折叠 ---

  it('场景三：连续两次唤醒，第二次 now 推进超过 cacheTtlMs 且历史超阈值 → 折叠恰好发生一次，摘要块进入第二轮 prompt，尾巴保留 K 条', async () => {
    const managerScript = makeManagerAdapter()
    const KEEP_RECENT = 2
    const policy: CompactionPolicy = { keepRecent: KEEP_RECENT, cacheTtlMs: 1000, foldTokenThreshold: 5, hardCapTokens: 10_000_000 }
    let managerNowMs = Date.parse('2026-01-01T00:00:00.000Z')
    const assembly = await setupAssembly({
      dataDir,
      policy,
      managerAdapter: managerScript.adapter,
      managerNow: () => new Date(managerNowMs),
    })

    const key = 'wechat::sess-fold' as ManagerKey
    // 预置 3 条历史（超过 keepRecent=2），lastActiveAt 钉在 t0，保证 wake#1 处于"未冷"状态。
    await assembly.store.save({
      key,
      recent: [createUserMessage('旧消息1'), createUserMessage('旧消息2'), createUserMessage('旧消息3')],
      foldedCount: 0,
      lastActiveAt: new Date(managerNowMs).toISOString(),
    })

    // wake#1 @ t0+10ms（远小于 cacheTtlMs=1000ms）——burst，不该折叠
    managerNowMs += 10
    managerScript.queue.push({ text: '收到，处理中', stopReason: 'end_turn' })
    const wake1 = await assembly.registry.routeHumanMessages('wechat', 'sess-fold', [makeChannelMessage('第一条')])
    expect(wake1.outcome).toBe('completed')
    expect(managerScript.foldCalls.length).toBe(0)

    // wake#2 @ t0+10+cacheTtlMs+500ms（远超 TTL），此时历史已超 keepRecent 且超 foldTokenThreshold
    managerNowMs += policy.cacheTtlMs + 500
    managerScript.queue.push({ text: '收到，继续处理', stopReason: 'end_turn' })
    const wake2 = await assembly.registry.routeHumanMessages('wechat', 'sess-fold', [makeChannelMessage('第二条')])
    expect(wake2.outcome).toBe('completed')

    // 折叠发生恰好一次
    expect(managerScript.foldCalls.length).toBe(1)

    const state = await assembly.store.load(key)
    expect(state.rollingSummary).toBeTruthy()

    const nonFoldCalls = managerScript.calls.filter((c) => !c.systemPrompt.includes(FOLD_SYSTEM_PROMPT_MARKER))
    const wake2Call = nonFoldCalls[nonFoldCalls.length - 1]
    // 摘要块进入了第二轮的 prompt/messages（第一条消息即摘要标记块）
    expect(JSON.stringify(wake2Call.messages[0])).toContain('滚动摘要')
    // 尾巴保留 K 条：messages = [摘要块(1)] + [尾巴(K 条)] + [本次唤醒事件(1 条)]
    expect(wake2Call.messages.length).toBe(1 + KEEP_RECENT + 1)
  })

  // --- 场景四：onAsyncError 真实装配路径接通（Task 8 复审遗留验证） ---

  it(
    '场景四：capabilities().fork===false 的 worker（如实实现,非桩造异常）上调 query_worker，' +
      '失败经真实 harness.queryWorker 的能力校验分支 + 真实 onAsyncError 转发链 → manager 最终被唤醒/事件入队',
    async () => {
      const key = 'wechat::sess-fork' as ManagerKey
      const managerNowMs = Date.parse('2026-01-01T00:00:00.000Z')

      let workerId = ''
      let turnIndex = 0
      const adapter: LLMAdapter = {
        async *stream() {
          turnIndex++
          if (turnIndex === 1) {
            yield* chunksFromContent(
              [{ type: 'tool_use', id: 'call_query', name: 'query_worker', input: { worker_id: workerId, question: '现在进展如何？' } }],
              'tool_use',
              { inputTokens: 10, outputTokens: 5 },
            )
            return
          }
          // turn 2：给 query_worker 的游离 promise 一个宏任务窗口 reject 并触发 onAsyncError——
          // harness.queryWorker 的 capability_not_supported 拒绝虽是纯逻辑判断（无真实 IO），
          // 仍经过 AsyncMutex 排队等若干 microtask，这里等一个宏任务窗口，与 registry.test.ts
          // 现有 e2e 用例同款做法。此刻 episode 仍在跑（activeEpisodes>0），预期走
          // enqueueDuringEpisode 分支。
          await new Promise((resolve) => setTimeout(resolve, 20))
          yield* chunksFromContent([{ type: 'text', text: '已发起侧问，等待结果。' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
        },
        updateConfig: () => {},
      }

      const assembly = await setupAssembly({
        dataDir,
        policy: GENEROUS_POLICY,
        managerAdapter: adapter,
        managerNow: () => new Date(managerNowMs),
        extraAdapters: [['codex', new ForklessStubAdapter()]],
      })

      const dialogObjectId = assembly.dialogObjectIdFor(key)
      const worker = await assembly.harness.spawnWorker({
        dialogObjectId,
        title: 'codex worker（fork 不支持）',
        prompt: '随便干点什么',
        origin: { spawned_by_session: key, trigger_type: 'message' },
        report_to: { channel_id: 'wechat', session_id: 'sess-fork' },
        impl: 'codex',
      })
      workerId = worker.worker_id

      const loop = assembly.registry.getOrCreate(key)
      const enqueueSpy = vi.spyOn(loop, 'enqueueDuringEpisode')

      const result = await assembly.registry.routeHumanMessages('wechat', 'sess-fork', [
        makeChannelMessage('帮我问问 codex worker 现在的进展'),
      ])
      expect(result.outcome).toBe('completed')

      // 真实工具面里确实调用过 query_worker（不是手工伪造的回调）
      expect(assembly.toolCallLog.some((c) => c.name === 'query_worker')).toBe(true)

      // manager 最终被唤醒/事件入队：episode 仍在跑，走 enqueueDuringEpisode 分支
      expect(enqueueSpy).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(enqueueSpy.mock.calls[0][0])).toContain('query_failed')

      // 真实失败留痕：harness.queryWorker 自己也把这次失败 appendEvent('query_failed', ...)
      const queryFailedEvent = assembly.events.find((e) => e.worker_id === workerId && e.kind === 'query_failed')
      expect(queryFailedEvent).toBeDefined()
      expect(queryFailedEvent?.detail?.reason).toBe('capability_not_supported')
    },
    15000,
  )

  // --- 场景五：唤醒事件自带 worker 的收尾发言 ---

  it(
    '场景五：worker end_turn 转 idle → 唤醒事件的 detail 带上它最后说的那段 text → ' +
      'manager 醒来不调 read_worker_output 就能据此向人类汇报',
    async () => {
      const managerScript = makeManagerAdapter()
      const managerNowMs = Date.parse('2026-01-01T00:00:00.000Z')
      const assembly = await setupAssembly({
        dataDir,
        policy: GENEROUS_POLICY,
        managerAdapter: managerScript.adapter,
        managerNow: () => new Date(managerNowMs),
      })

      const WORKER_SAY =
        '第一阶段跑完了：三个候选里 B 方案最稳，A 有兼容风险。要我接着做 B 的详细设计吗？'
      // 不调 finish_task —— 自然 end_turn 转 idle，正是"worker 中途停下来说话"这一档。
      const workerLLM = makeWorkerLLM([{ text: WORKER_SAY, stopReason: 'end_turn' }])
      assembly.builtinConfigQueue.push({ adapter: workerLLM, model: 'test-worker-model', systemPrompt: '', tools: [] })

      managerScript.queue.push({
        toolCalls: [{ name: 'spawn_worker', id: 'call_spawn', input: { title: '选型', prompt: '帮我做个方案选型' } }],
        stopReason: 'tool_use',
      })
      managerScript.queue.push({ text: '好的，已经安排下去了。', stopReason: 'end_turn' })

      const key = 'wechat::sess-say' as ManagerKey
      const episode1 = await assembly.registry.routeHumanMessages('wechat', 'sess-say', [makeChannelMessage('帮我做个方案选型')])
      expect(episode1.outcome).toBe('completed')

      const [worker] = await assembly.harness.listWorkers(assembly.dialogObjectIdFor(key))
      // 等**事件**本身出现，不是等台账转 idle——processStateChange 先 upsert 台账、再 appendEvent，
      // 盯台账会在这两步之间抢跑（实测在全量并发下偶发）。
      const findIdleEvent = () =>
        [...assembly.events]
          .reverse()
          .find((e) => e.worker_id === worker.worker_id && e.kind === 'state_changed' && e.detail?.to === 'idle')
      await waitUntil(() => findIdleEvent() !== undefined)

      // 1) harness 事件本身带上了正文（不是只有一个 {to:'idle'}）
      const idleEvent = findIdleEvent()
      expect(idleEvent).toBeDefined()
      expect(idleEvent!.detail).toEqual({ to: 'idle', text: WORKER_SAY })

      // 2) manager 被这条事件唤醒后，**不调 read_worker_output** 直接转述给人类
      managerScript.queue.push({
        toolCalls: [
          {
            name: 'send_message',
            id: 'call_send',
            input: { channel_id: 'wechat', session_id: 'sess-say', content: 'worker 说 B 方案最稳，要我让它继续做详细设计吗？' },
          },
        ],
        stopReason: 'tool_use',
      })
      managerScript.queue.push({ text: '已转述。', stopReason: 'end_turn' })

      const callsBefore = managerScript.calls.length
      const episode2 = await assembly.registry.routeWorkerEvent(idleEvent!)
      expect(episode2?.outcome).toBe('completed')

      // 3) 语义不变量：worker 的原话真的进了 manager 这一次唤醒的上下文
      const wakeCall = managerScript.calls[callsBefore]
      expect(wakeCall).toBeDefined()
      const wakeText = JSON.stringify(wakeCall.messages)
      expect(wakeText).toContain(WORKER_SAY)
      // 正文单独成段渲染，不是塞进 detail 的 JSON 里（否则换行会被转义成 \n 挤成一行）
      expect(wakeText).toContain('worker 最后说:')
      expect(wakeText).not.toContain('\\"text\\"')

      // 4) 全程没有 read_worker_output —— 省掉的正是那次往返
      expect(assembly.toolCallLog.filter((c) => c.key === key).map((c) => c.name)).toEqual(['spawn_worker', 'send_message'])

      const sendCall = assembly.rpcCalls.find((c) => c.method === 'send_message')
      expect(sendCall).toBeDefined()
      expect(JSON.stringify(sendCall!.params)).toContain('B 方案最稳')
    },
    15000,
  )
})
