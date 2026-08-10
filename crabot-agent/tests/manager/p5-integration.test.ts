/**
 * P5 集成（Task 6）—— manager 栈的**启动接线**。
 *
 * 与 `rpc-handlers.test.ts`（Task 4）的分工：那里用 `Object.create(prototype)` 造壳、直接调私有
 * handler，验的是 handler 自身的语义；本文件反过来——**走真实构造函数把栈装配出来，再经真实的
 * RPC 分发路径**（`ModuleBase.methodHandlers`，即 HTTP 入口 `handleRequest` 用的那张表）打进去，
 * 验的是"接线到底通没通"：
 *
 * ① 五个 §8.2/§8.3 方法都注册了，且调用不再抛 `Manager stack not initialized`；
 * ② `trigger_schedule` 真的唤醒了系统线程 manager（mock LLM）；
 * ③ 三个读端点对**真实台账 / 真实输出日志**返回正确数据；
 * ④ 真实状态迁移会发出 `agent.task_status_changed`，载荷逐字对齐 §9.2；
 * ⑤ §11 的 manager slot 解析与"没配 manager slot 也必须能启动"的降级路径；
 * ⑥ 启动对账真的跑了（发起点在 register 之后，见对应用例）。
 *
 * **唯一被替换的生产件是 manager 的 LLM**：`BootstrapDeps.managerAdapter` 那个 thunk 会经
 * `adapterFromSdkEnv` 建出真会发 HTTP 的 adapter，测试里换成脚本化的 mock（换法见
 * `overrideManagerLLM`）。其余（栈装配、事件出口、台账、harness、工具面、RPC 注册与分发）
 * 全部是生产代码装出来的真件。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { UnifiedAgent } from '../../src/unified-agent.js'
import { SYSTEM_TASKS_MANAGER_KEY } from '../../src/manager/registry.js'
import type { ManagerKey, LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { ManagerStack } from '../../src/manager/bootstrap.js'
import type { LLMAdapter, ToolDefinition } from '../../src/engine/index.js'
import type {
  UnifiedAgentConfig,
  OrchestrationConfig,
  LLMConnectionInfo,
  ModuleId,
} from '../../src/types.js'
import type { IncarnationHandle, StateChangeReport, WorkerAdapter, WorkerContractState } from '../../src/workers/types.js'
import type { Event } from 'crabot-shared'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

// ============================================================================
// helpers
// ============================================================================

const ORCHESTRATION: OrchestrationConfig = {
  front_context_recent_messages_window_hours: 24,
  front_context_recent_messages_max_cap: 50,
  front_context_short_term_memory_window_hours: 24,
  front_context_short_term_memory_max_cap: 20,
  worker_recent_messages_window_hours: 24,
  worker_recent_messages_max_cap: 50,
  worker_short_term_memory_window_hours: 24,
  worker_short_term_memory_max_cap: 20,
  worker_long_term_memory_limit: 10,
  front_agent_timeout: 60,
  session_state_ttl: 3600,
  worker_config_refresh_interval: 300,
  front_agent_queue_max_length: 10,
  front_agent_queue_timeout: 60,
}

function connInfo(modelId: string): LLMConnectionInfo {
  return { endpoint: 'https://example.invalid', apikey: 'k', model_id: modelId, format: 'anthropic' }
}

/**
 * `roles: []` 是刻意的：带 'worker' 角色会让 `initializeAgentLayer` 建 AgentHandler 并
 * `lspManager.start()`（起 LSP 子进程），与本文件要验的接线无关。manager 栈的装配**不看**
 * roles，正是本文件要钉住的性质之一。
 */
function makeConfig(modelConfig: Record<string, LLMConnectionInfo>): UnifiedAgentConfig {
  return {
    module_id: 'p5-integration-agent' as ModuleId,
    module_type: 'agent',
    version: '0.0.0-test',
    protocol_version: '1.0',
    port: 19999,
    orchestration: ORCHESTRATION,
    agent_config: {
      instance_id: 'p5-int',
      roles: [],
      system_prompt: '你是测试用 Crabot',
      model_config: modelConfig,
    },
  }
}

/** 脚本化 manager LLM（照 `tests/manager/rpc-handlers.test.ts` 的 makeManagerLLM）。 */
function makeManagerLLM(
  scripts: ReadonlyArray<{
    text?: string
    toolCalls?: ReadonlyArray<{ name: string; id: string; input: Record<string, unknown> }>
    stopReason: 'end_turn' | 'tool_use'
  }>,
): LLMAdapter {
  let i = 0
  return {
    async *stream() {
      const r = scripts[i++] ?? { text: '(收工)', stopReason: 'end_turn' as const }
      const content: unknown[] = []
      if (r.text) content.push({ type: 'text', text: r.text })
      for (const tc of r.toolCalls ?? []) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      yield* chunksFromContent(content, r.stopReason, { inputTokens: 10, outputTokens: 5 })
    },
    updateConfig: () => {},
  }
}

/**
 * 换掉 manager 的 LLM 来源。`BootstrapDeps.managerAdapter` 被 bootstrap 原样交给
 * `ManagerRegistryDeps.adapter`，registry 只在 `getOrCreate` 首次建 loop 时读它——所以在第一次
 * 唤醒之前改这一个字段，就等于换掉整条链路上唯一的 LLM 入口，其余全是生产装配的真件。
 * （穿透私有字段的手法与 `bootstrap.test.ts` 的 `capturedOnStateChange` 同源：没有别的注入口。）
 */
function overrideManagerLLM(stack: ManagerStack, llm: LLMAdapter): void {
  ;(stack.registry as unknown as { deps: { adapter: () => LLMAdapter } }).deps.adapter = () => llm
}

/**
 * 三个 adapter 的 `onStateChange` 构造 deps 的完整签名。`report.endReason` 是 adapter 在
 * `transitionExited` 时持有的 `ended_reason` 真值——它必填,所以直接调这个回调模拟 adapter
 * 上报时,`exited` 必须一并带上它,否则模拟出的是真实 adapter 不会产生的"退出但无原因"。
 */
type AdapterStateCallback = (h: IncarnationHandle, s: WorkerContractState, report?: StateChangeReport) => void

/** 读出 adapter 构造时收到的 `onStateChange`（同 bootstrap.test.ts）。 */
function capturedOnStateChange(
  adapter: WorkerAdapter | undefined,
): AdapterStateCallback | undefined {
  return (adapter as unknown as { deps?: { onStateChange?: AdapterStateCallback } })?.deps?.onStateChange
}

function makeLedgerWorker(p: {
  managerKey: ManagerKey
  status?: LedgerWorker['task']['status']
  updatedAt?: string
  incarnationState?: WorkerContractState
}): LedgerWorker {
  return {
    worker_id: p.workerId,
    manager_key: p.managerKey,
    task: {
      id: p.workerId,
      title: `任务 ${p.workerId}`,
      status: p.status ?? 'running',
      created_at: '2026-01-01T00:00:00.000Z',
    },
    origin: { trigger_type: 'message' },
    report_to: { channel_id: 'wechat' as ModuleId, session_id: 'sess-1' },
    incarnations: [
      {
        seq: 1,
        impl: 'builtin',
        state: p.incarnationState ?? 'running',
        workspace: '/tmp/ws-not-used',
        session_ref: `${p.workerId}-ref`,
        started_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    updated_at: p.updatedAt ?? '2026-01-01T00:00:00.000Z',
  }
}

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 6000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitUntil timed out')
}

/** UnifiedAgent 的私有件在测试里的视图（TS 私有性只在编译期）。 */
interface AgentInternals {
  methodHandlers: Map<string, (params: unknown) => unknown>
  managerStack?: ManagerStack
  rpcClient: { publishEvent: (e: Event, source: ModuleId) => Promise<number> }
  adminPort?: number
  feishuChannelAvailable: boolean
  onStart(): Promise<void>
  onStop(): Promise<void>
}

// ============================================================================

describe('P5 集成：manager 栈启动接线（Task 6）', () => {
  let tmpRoot: string
  let prevDataDir: string | undefined
  let prevAgentDataDir: string | undefined
  let agent: UnifiedAgent
  let internals: AgentInternals

  /** 经真实 RPC 分发表调用——不是直接调私有 handler。 */
  async function rpc<R>(method: string, params: unknown): Promise<R> {
    const handler = internals.methodHandlers.get(method)
    if (!handler) throw new Error(`RPC 方法未注册: ${method}`)
    return (await handler(params)) as R
  }

  function boot(modelConfig: Record<string, LLMConnectionInfo> = { manager: connInfo('manager-model-x') }): void {
    agent = new UnifiedAgent(makeConfig(modelConfig))
    internals = agent as unknown as AgentInternals
    // 端口解析预置：避免 onStart 里的 detectFeishuChannel 去 resolve 一个不存在的 MM。
    internals.adminPort = 1
  }

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(join(tmpdir(), 'p5-integration-'))
    prevDataDir = process.env.DATA_DIR
    prevAgentDataDir = process.env.CRABOT_AGENT_DATA_DIR
    delete process.env.CRABOT_AGENT_DATA_DIR
    process.env.DATA_DIR = join(tmpRoot, 'data')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (prevDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = prevDataDir
    if (prevAgentDataDir === undefined) delete process.env.CRABOT_AGENT_DATA_DIR
    else process.env.CRABOT_AGENT_DATA_DIR = prevAgentDataDir
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  // --- ① 接线自证 ---

  it('构造函数装配 manager 栈：五个 v3 RPC 经真实分发表调用不再抛 "Manager stack not initialized"', async () => {
    boot()

    for (const m of [
      'trigger_schedule',
      'list_workers_admin',
      'get_worker_detail',
      'read_worker_output_admin',
      'get_worker_trace',
    ]) {
      expect(internals.methodHandlers.has(m), `${m} 应已注册`).toBe(true)
    }

    // 这条是本 task 的变异靶：去掉 initializeManagerStack() 的调用，它就会抛
    // 'Manager stack not initialized'。
    const result = await rpc<{ items: unknown[]; pagination: { total_items: number } }>('list_workers_admin', {})
    expect(result.items).toEqual([])
    expect(result.pagination.total_items).toBe(0)

    // 台账根按 §7 从 $DATA_DIR 派生（不是从别处推的）
    const stack = internals.managerStack
    expect(stack).toBeDefined()
    expect(stack!.builtinDataDir).toBe(join(tmpRoot, 'data', 'agent', 'worker-adapters', 'builtin'))
  })

  it('装配是 O(1) 纯构造：构造函数不探测任何 adapter，$DATA_DIR/agent/ledgers 在启动对账之前不存在', async () => {
    const detectSpy = vi.spyOn(
      await import('../../src/workers/builtin/adapter.js').then((m) => m.BuiltinWorkerAdapter.prototype),
      'detect',
    )

    boot()

    expect(detectSpy).not.toHaveBeenCalled()
    await expect(fs.access(join(tmpRoot, 'data', 'agent', 'ledgers'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  /**
   * `enableFeishuDocTool` 的接线自证（PR C 第 2 步）。
   *
   * 只断言"白名单里有这三个名字"证明不了任何事——manager 的 `messagingDeps` 一度**根本没传**
   * 这个开关，工具压根不会被构造。这里走真实构造函数装出来的真工具面：探测前后各取一次，
   * 只有开关真的接到 `feishuChannelAvailable` 上，第二次才会多出那三个。
   *
   * 顺带钉住两条：① 它必须是 getter——本对象在构造函数里就建好了，而探测跑在 `onStart()` 里，
   * 写成定值就永远是探测前的 false；② "仅当存在飞书 channel 实例时可见"（protocol-crab-messaging
   * §2.10）的实现方式就是这个开关，没有实例时三件套不出现。
   */
  it('manager 工具面接 enableFeishuDocTool：无飞书实例时三件套不出现，探测到实例后出现，feishu_write 始终不出现', () => {
    boot()
    const registryDeps = (internals.managerStack as unknown as {
      registry: { deps: { toolFace: (k: ManagerKey, sys: boolean, onErr: () => void) => ReadonlyArray<ToolDefinition> } }
    }).registry.deps
    const namesNow = (): string[] =>
      registryDeps.toolFace('wechat::sess-1' as ManagerKey, false, () => {}).map((t) => t.name)

    const feishuReadOnly = ['read_feishu_document', 'feishu_raw_get', 'feishu_download_file']

    // detectFeishuChannel 还没跑（构造函数阶段）→ 一个都不该有
    const before = namesNow()
    for (const name of [...feishuReadOnly, 'feishu_write']) {
      expect(before, `探测前不应出现 ${name}`).not.toContain(name)
    }

    // 模拟 detectFeishuChannel 命中 channel-feishu 实例
    internals.feishuChannelAvailable = true

    const after = namesNow()
    for (const name of feishuReadOnly) {
      expect(after, `探测到飞书实例后应出现 ${name}`).toContain(name)
    }
    expect(after, 'feishu_write 绝不进 manager 工具面').not.toContain('feishu_write')
    // 投递类补齐同样走真实装配路径
    expect(after).toContain('send_private_message')
    expect(after).not.toContain('send_master_private')
  })

  // --- ⑤ §11 manager slot 与降级路径 ---

  it('§11 manager slot：manager 优先，缺失回退 powerful', () => {
    boot({ manager: connInfo('manager-model-x'), powerful: connInfo('powerful-model-y') })
    const withManager = internals.managerStack as unknown as { registry: { deps: { model: () => string } } }
    expect(withManager.registry.deps.model()).toBe('manager-model-x')

    boot({ powerful: connInfo('powerful-model-y') })
    const fallback = internals.managerStack as unknown as { registry: { deps: { model: () => string } } }
    expect(fallback.registry.deps.model()).toBe('powerful-model-y')
  })

  it('降级：两个 slot 都没配（现网此刻的状态）时 agent 照常构造，读模型四件套照常可用，只有 LLM 解析在被用到时才抛', async () => {
    boot({})

    expect(internals.managerStack).toBeDefined()
    await expect(rpc('list_workers_admin', {})).resolves.toBeDefined()

    const deps = (internals.managerStack as unknown as { registry: { deps: { model: () => string } } }).registry.deps
    expect(() => deps.model()).toThrow(/model_config 缺少 'manager' 与 'powerful'/)
  })

  // --- ② trigger_schedule → 系统线程 manager ---

  it('trigger_schedule 经真实分发表 → 唤醒系统线程 manager，派出的 worker 记在 admin-web::system-tasks 名下', async () => {
    boot()
    const stack = internals.managerStack!
    overrideManagerLLM(
      stack,
      makeManagerLLM([
        { toolCalls: [{ name: 'spawn_worker', id: 'tc-1', input: { title: '巡检子任务', prompt: '去巡检' } }], stopReason: 'tool_use' },
        { text: '已派发', stopReason: 'end_turn' },
      ]),
    )
    const spawnSpy = vi.spyOn(stack.harness, 'spawnWorker').mockResolvedValue(makeLedgerWorker({ workerId: 'w-spawned', managerKey: SYSTEM_TASKS_MANAGER_KEY }))
    const routeSpy = vi.spyOn(stack.registry, 'routeSchedule')

    const accepted = await rpc('trigger_schedule', {
      schedule_id: 'sc-sys',
      title: '系统巡检',
      description: '无目标会话',
      creator_friend_id: 'friend-42',
    })

    expect(accepted).toEqual({ accepted: true })
    // 受理即返回：这一刻 episode 还没跑到派发
    expect(spawnSpy).not.toHaveBeenCalled()

    await waitUntil(() => spawnSpy.mock.calls.length > 0)
    const params = spawnSpy.mock.calls[0][0]
    expect(params.managerKey).toBe(SYSTEM_TASKS_MANAGER_KEY)
    expect(params.origin.trigger_type).toBe('scheduled')
    expect(params.origin.creator_friend_id).toBe('friend-42')

    await Promise.allSettled(routeSpy.mock.results.map((r) => r.value as Promise<unknown>))
  })

  // --- ③ 三个读端点对真实台账 ---

  it('list_workers_admin / get_worker_detail / read_worker_output_admin 对真实台账与真实输出日志返回正确数据', async () => {
    boot()
    const stack = internals.managerStack!
    const alice = (`test::${'alice'}` as ManagerKey)
    const bob = (`test::${'bob'}` as ManagerKey)

    await stack.ledger.upsertWorker(alice, 'w-a1', () =>
      makeLedgerWorker({ workerId: 'w-a1', managerKey: alice, status: 'running', updatedAt: '2026-02-02T00:00:00.000Z' }),
    )
    await stack.ledger.upsertWorker(alice, 'w-a2', () =>
      makeLedgerWorker({ workerId: 'w-a2', managerKey: alice, status: 'completed', updatedAt: '2026-02-03T00:00:00.000Z' }),
    )
    await stack.ledger.upsertWorker(bob, 'w-b1', () =>
      makeLedgerWorker({ workerId: 'w-b1', managerKey: bob, status: 'running', updatedAt: '2026-02-01T00:00:00.000Z' }),
    )

    // 全量：updated_at desc
    const all = await rpc<{ items: Array<{ worker_id: string }>; pagination: { total_items: number } }>(
      'list_workers_admin',
      {},
    )
    expect(all.items.map((w) => w.worker_id)).toEqual(['w-a2', 'w-a1', 'w-b1'])
    expect(all.pagination.total_items).toBe(3)

    // 按 manager_key + status 过滤
    const scoped = await rpc<{ items: Array<{ worker_id: string }> }>('list_workers_admin', {
      manager_key: alice,
      status: 'running',
    })
    expect(scoped.items.map((w) => w.worker_id)).toEqual(['w-a1'])

    // 详情（§8.3 的返回只有 worker 本体，不带 manager_key）
    const detail = await rpc<{ worker: LedgerWorker }>('get_worker_detail', { worker_id: 'w-b1' })
    expect(detail.worker.worker_id).toBe('w-b1')
    expect(detail.worker.task.status).toBe('running')
    expect(detail.worker.incarnations).toHaveLength(1)

    await expect(rpc('get_worker_detail', { worker_id: 'w-nope' })).rejects.toThrow(/Worker not found: w-nope/)

    // 输出：真实 builtin adapter 的 output-<seq>.log
    const outDir = join(stack.builtinDataDir, 'w-a1')
    await fs.mkdir(outDir, { recursive: true })
    await fs.writeFile(join(outDir, 'output-1.log'), '第一段输出\n第二段输出\n', 'utf-8')

    const head = await rpc<{ chunk: string; next_cursor: string; eof: boolean }>('read_worker_output_admin', {
      worker_id: 'w-a1',
      seq: 1,
    })
    expect(head.chunk).toBe('第一段输出\n第二段输出\n')
    expect(head.eof).toBe(false)

    const tail = await rpc<{ chunk: string; eof: boolean }>('read_worker_output_admin', {
      worker_id: 'w-a1',
      seq: 1,
      cursor: head.next_cursor,
    })
    expect(tail.chunk).toBe('')
    expect(tail.eof).toBe(true)
  })

  /**
   * P5 review 修复的端到端回归：admin 的 `/output`、`/trace` 在 `?seq=` 缺省时**不下发 seq**
   * （载荷形状由 crabot-admin `admin-web-api.test.ts` 钉住），本用例把**那个载荷原样**打进真实
   * RPC + 真实台账，验它确实落在主线化身上。
   *
   * 为什么非得端到端验一遍：原实现两端各自"看着对"——admin 填了个 seq、agent 按 seq 过滤，
   * 只断言参数透传的测试全绿，但缺省值 0 在台账里恒不存在，output 抛错落 500、trace 静默返回
   * 空 events。缺省语义的正确性只在"真实台账 + 真实化身链"上才可判定。
   *
   * 台账形状取自真实演化路径：builtin#1 自然结束 → send_to_worker 触发 revive 产出 builtin#2
   * 入主线链（`reviveIncarnation` 不填 forked_from）；期间 query_worker 从主线 fork 出 #3
   * （forked_from=2）。于是三个候选缺省互不相同：主线=#2、"第一个化身"=#1、"数组最后一条"=#3。
   */
  it('admin 缺 seq 的转发载荷经真实 RPC → output/trace 都落在主线化身（不是 #1、不是 fork）', async () => {
    boot()
    const stack = internals.managerStack!
    // appendEvent 的 onEvent 支路会去唤醒监护 manager（要跑 LLM）并发事件，与本用例无关，挡掉。
    vi.spyOn(stack.registry, 'routeWorkerEvent').mockResolvedValue(undefined)
    vi.spyOn(internals.rpcClient, 'publishEvent').mockResolvedValue(1)

    const managerKey = (`test::${'friend-mainline'}` as ManagerKey)
    const base = makeLedgerWorker({ workerId: 'w-main', managerKey })
    await stack.ledger.upsertWorker(managerKey, 'w-main', () => ({
      ...base,
      incarnations: [
        {
          seq: 1,
          impl: 'builtin',
          state: 'exited',
          workspace: '/tmp/ws-not-used',
          session_ref: 'ref-1',
          started_at: '2026-03-01T00:00:00.000Z',
          ended_at: '2026-03-01T00:01:00.000Z',
          ended_reason: 'completed',
        },
        {
          seq: 2,
          impl: 'builtin',
          state: 'running',
          workspace: '/tmp/ws-not-used',
          session_ref: 'ref-2',
          started_at: '2026-03-01T00:02:00.000Z',
        },
        {
          seq: 3,
          impl: 'builtin',
          state: 'exited',
          workspace: '/tmp/ws-not-used',
          session_ref: 'ref-3',
          started_at: '2026-03-01T00:03:00.000Z',
          forked_from: 2,
        },
      ],
    }))

    // 真实 builtin adapter 的 output-<seq>.log，三个化身各一份
    const outDir = join(stack.builtinDataDir, 'w-main')
    await fs.mkdir(outDir, { recursive: true })
    await fs.writeFile(join(outDir, 'output-1.log'), '旧主线 #1 的输出\n', 'utf-8')
    await fs.writeFile(join(outDir, 'output-2.log'), '当前主线 #2 的输出\n', 'utf-8')
    await fs.writeFile(join(outDir, 'output-3.log'), '侧问 fork #3 的输出\n', 'utf-8')

    // ① output：不带 seq == 主线 #2
    const defaultOut = await rpc<{ chunk: string }>('read_worker_output_admin', { worker_id: 'w-main' })
    expect(defaultOut.chunk).toBe('当前主线 #2 的输出\n')
    // 显式 seq 仍按 seq 走（也证明缺省确实不等于 1、不等于"最后一条"）
    expect((await rpc<{ chunk: string }>('read_worker_output_admin', { worker_id: 'w-main', seq: 1 })).chunk).toBe(
      '旧主线 #1 的输出\n',
    )
    expect((await rpc<{ chunk: string }>('read_worker_output_admin', { worker_id: 'w-main', seq: 3 })).chunk).toBe(
      '侧问 fork #3 的输出\n',
    )
    // 修复前 admin 下发的就是 seq=0：台账里恒不存在 → 抛错 → proxyAgentRpc 落 500
    await expect(rpc('read_worker_output_admin', { worker_id: 'w-main', seq: 0 })).rejects.toThrow(
      /no incarnation with seq=0/,
    )

    // ② trace：经 harness 自己的事件写入口落真实 events.jsonl（private，穿透手法同本文件其它用例）
    const appendEvent = (
      stack.harness as unknown as {
        appendEvent: (w: string, seq: number, kind: string, detail?: Record<string, unknown>) => Promise<void>
      }
    ).appendEvent.bind(stack.harness)
    await appendEvent('w-main', 1, 'spawned', { impl: 'builtin' })
    await appendEvent('w-main', 2, 'resumed', { from_seq: 1 })
    await appendEvent('w-main', 2, 'input_sent')
    await appendEvent('w-main', 3, 'state_changed', { to: 'exited' })

    const defaultTrace = await rpc<{ events: Array<{ detail?: unknown }>; next_cursor?: string }>('get_worker_trace', {
      worker_id: 'w-main',
    })
    const mainlineTrace = await rpc<{ events: Array<{ detail?: unknown }> }>('get_worker_trace', {
      worker_id: 'w-main',
      seq: 2,
    })
    expect(defaultTrace.events).toEqual(mainlineTrace.events)
    expect(defaultTrace.events).toHaveLength(2)
    expect(defaultTrace.events[0].detail).toEqual({ from_seq: 1 })
    expect(defaultTrace.next_cursor).toBe('2')
    // 不是 #1 的那条、也不是 fork #3 的那条
    expect((await rpc<{ events: unknown[] }>('get_worker_trace', { worker_id: 'w-main', seq: 1 })).events).toHaveLength(1)
    // 修复前 admin 下发的 seq=0：静默返回空 events，与"该化身还没有事件"无法区分；
    // 现在与 output 路径同形状抛错（见下一条用例）。
    await expect(rpc('get_worker_trace', { worker_id: 'w-main', seq: 0 })).rejects.toThrow(
      /no incarnation with seq=0/,
    )
  })

  /**
   * get_worker_trace 显式给了 seq 时的两种"空"必须可区分（P5 review 修复第二轮）：
   *
   * - 化身**不存在** → 抛错（文案与 `read_worker_output_admin` 同形状，admin 侧统一映射 500）；
   * - 化身**存在但还没产生事件** → 照常 200 + 空 events，**不能**误判成错误。
   *
   * 前者修复前是静默返回空 events，与后者在返回值上完全一样——正是上一轮已修的
   * "静默返空"同一形状的第二个入口。
   */
  it('get_worker_trace 显式 seq：化身不存在 → 抛错；化身存在但无事件 → 200 空 events', async () => {
    boot()
    const stack = internals.managerStack!
    vi.spyOn(stack.registry, 'routeWorkerEvent').mockResolvedValue(undefined)
    vi.spyOn(internals.rpcClient, 'publishEvent').mockResolvedValue(1)

    const managerKey = (`test::${'friend-seq-probe'}` as ManagerKey)
    const base = makeLedgerWorker({ workerId: 'w-seq', managerKey })
    await stack.ledger.upsertWorker(managerKey, 'w-seq', () => ({
      ...base,
      incarnations: [
        {
          seq: 1,
          impl: 'builtin',
          state: 'exited',
          workspace: '/tmp/ws-not-used',
          session_ref: 'ref-1',
          started_at: '2026-03-01T00:00:00.000Z',
          ended_at: '2026-03-01T00:01:00.000Z',
          ended_reason: 'completed',
        },
        // 主线的当前化身：确实存在于台账，但一条事件都还没落盘
        {
          seq: 2,
          impl: 'builtin',
          state: 'running',
          workspace: '/tmp/ws-not-used',
          session_ref: 'ref-2',
          started_at: '2026-03-01T00:02:00.000Z',
        },
      ],
    }))

    const appendEvent = (
      stack.harness as unknown as {
        appendEvent: (w: string, seq: number, kind: string, detail?: Record<string, unknown>) => Promise<void>
      }
    ).appendEvent.bind(stack.harness)
    await appendEvent('w-seq', 1, 'spawned', { impl: 'builtin' })

    // ① 化身存在但无事件：200 + 空 events（显式 seq 与缺省取主线两条路都要成立）
    const explicitEmpty = await rpc<{ events: unknown[]; next_cursor?: string }>('get_worker_trace', {
      worker_id: 'w-seq',
      seq: 2,
    })
    expect(explicitEmpty.events).toEqual([])
    expect(explicitEmpty.next_cursor).toBe('0')
    expect((await rpc<{ events: unknown[] }>('get_worker_trace', { worker_id: 'w-seq' })).events).toEqual([])

    // ② 化身不存在：抛错，不再与①的返回值混同
    await expect(rpc('get_worker_trace', { worker_id: 'w-seq', seq: 99 })).rejects.toThrow(
      /no incarnation with seq=99 found for worker w-seq/,
    )

    // ③ 有事件的化身照常返回（防止校验写成"一律抛错"）
    expect((await rpc<{ events: unknown[] }>('get_worker_trace', { worker_id: 'w-seq', seq: 1 })).events).toHaveLength(1)
  })

  // --- ④ agent.task_status_changed ---

  it('真实状态迁移 → 经生产事件出口发出 agent.task_status_changed，载荷逐字对齐 §9.2', async () => {
    boot()
    const stack = internals.managerStack!
    // 事件出口的终点是 agent 自己那个 RpcClient 实例——spy 在实例上即可拦到生产链路。
    const publishSpy = vi.spyOn(internals.rpcClient, 'publishEvent').mockResolvedValue(1)
    // 同一个 onEvent 的另一条支路（唤醒监护 manager）挡掉：它要跑 LLM，不是本用例的对象；
    // 顺带断言它确实接着（两条支路互不干扰）。
    const routeSpy = vi.spyOn(stack.registry, 'routeWorkerEvent').mockResolvedValue(undefined)

    const managerKey = (`test::${'friend-evt'}` as ManagerKey)
    await stack.ledger.upsertWorker(managerKey, 'w-evt', () => makeLedgerWorker({ workerId: 'w-evt', managerKey }))

    // 用 adapter 手里那份回调触发真实迁移：handleStateChange → processStateChange →
    // upsertWorker（落 completed）→ appendEvent（带 task_status）→ onEvent → 事件出口
    const onStateChange = capturedOnStateChange(stack.adapters.get('builtin'))
    expect(onStateChange).toBeDefined()
    onStateChange!({ worker_id: 'w-evt', seq: 1, impl: 'builtin', session_ref: 'w-evt-ref' }, 'exited', { endReason: 'completed' })

    await waitUntil(() => publishSpy.mock.calls.length > 0)

    const [event, source] = publishSpy.mock.calls[0]
    expect(source).toBe('p5-integration-agent')
    expect(event.type).toBe('agent.task_status_changed')
    expect(event.source).toBe('p5-integration-agent')
    expect(typeof event.id).toBe('string')
    expect(typeof event.timestamp).toBe('string')
    expect(event.payload).toEqual({
      worker_id: 'w-evt',
      task_id: 'w-evt',
      // 首次观测的兜底（events.ts 文件头三条边界之一）
      old_status: 'queued',
      // 台账落账值；P7 阻塞项 #1 未修前，"退出即 completed" 是 harness 的既有行为，
      // 本断言只钉"事件值 == 台账值"，不对语义正确性背书。
      new_status: (await stack.ledger.findWorker('w-evt'))!.worker.task.status,
      manager_key: managerKey,
    })
    expect(routeSpy).toHaveBeenCalled()
  })

  // --- ⑥ onStart 的启动对账 ---

  /**
   * 对账的**发起点在 register 之后**（`main.ts`：start → register → startManagerStackReconciliation），
   * 不再挂在 `onStart()` 里：它的 fs 扫描 + tmux 子进程会和 `register()` 的 getaddrinfo 抢同一个
   * libuv 线程池，并发跑会把注册拖慢、放大冷启动竞态窗口。这里按 main.ts 的真实顺序调用，
   * 钉住的语义不变：启动时异步跑一次、且不阻塞启动返回。
   */
  it('启动对账失败也释放 recovered bg exits 并启动活性巡检', async () => {
    boot()
    const stack = internals.managerStack!
    vi.spyOn(stack.harness, 'reconcileOnStartup').mockRejectedValue(new Error('reconcile failed'))
    const release = vi.fn().mockResolvedValue(undefined)
    internals.agentHandler = { releaseRecoveredWorkerShellExits: release } as any
    const sweep = vi.spyOn(stack.harness, 'startLivenessSweep').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    agent.startManagerStackReconciliation()
    await waitUntil(async () => release.mock.calls.length === 1)

    expect(sweep).toHaveBeenCalledOnce()
  })

  it('启动对账已结束后由配置 push 晚建 handler，会立即打开 recovered-exit gate', async () => {
    boot()
    internals.managerReconciliationSettled = true
    const setDispatcher = vi.fn()
    const release = vi.fn().mockResolvedValue(undefined)
    const lateHandler = {
      setBuiltinShellExitDispatcher: setDispatcher,
      releaseRecoveredWorkerShellExits: release,
    }

    ;(agent as any).attachBuiltinShellExitDispatcher(lateHandler)
    await waitUntil(async () => release.mock.calls.length === 1)

    expect(setDispatcher).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it('启动时异步跑一次启动对账（register 之后发起）：台账里残留的 running 化身被对账掉，且不阻塞启动', async () => {
    boot()
    const stack = internals.managerStack!
    // 对账把化身判死会落 `exited` 事件，onEvent 的另一条支路会去唤醒监护 manager（要跑 LLM）。
    // 那条路由本身由 bootstrap.test.ts 覆盖，这里挡掉，免得用例结束后还留着一个在重试的 LLM 请求。
    const routeSpy = vi.spyOn(stack.registry, 'routeWorkerEvent').mockResolvedValue(undefined)
    // 对账判死同样会发 §9.2 事件（下一条用例专门验它）；这里挡住投递，免得没有 MM 的测试环境
    // 刷一屏 ECONNREFUSED——注意 publisher 本身把失败吃掉了，不挡也不会让用例失败。
    vi.spyOn(internals.rpcClient, 'publishEvent').mockResolvedValue(1)
    const managerKey = (`test::${'friend-recon'}` as ManagerKey)
    await stack.ledger.upsertWorker(managerKey, 'w-stale', () =>
      makeLedgerWorker({ workerId: 'w-stale', managerKey, status: 'running', incarnationState: 'running' }),
    )

    await internals.onStart()
    // main.ts 里这一句跑在 `await agent.register()` 之后
    agent.startManagerStackReconciliation()
    try {
      // 进程里没有这个化身的任何痕迹（builtin adapter 的 dataDir 下无 meta）→ 对账判定它已死
      await waitUntil(async () => {
        const found = await stack.ledger.findWorker('w-stale')
        return found?.worker.incarnations[0].state === 'exited'
      })
      const after = await stack.ledger.findWorker('w-stale')
      expect(after!.worker.task.status).toBe('failed')
      expect(routeSpy).toHaveBeenCalled()
    } finally {
      await internals.onStop()
    }
  })
})
