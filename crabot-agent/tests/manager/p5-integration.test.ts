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
 * ⑥ `onStart()` 里的启动对账真的跑了。
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
import { dialogObjectIdForPrivate, type DialogObjectId, type LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { ManagerStack } from '../../src/manager/bootstrap.js'
import type { LLMAdapter } from '../../src/engine/index.js'
import type {
  UnifiedAgentConfig,
  OrchestrationConfig,
  LLMConnectionInfo,
  ModuleId,
} from '../../src/types.js'
import type { IncarnationHandle, WorkerAdapter, WorkerContractState } from '../../src/workers/types.js'
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

/** 读出 adapter 构造时收到的 `onStateChange`（同 bootstrap.test.ts）。 */
function capturedOnStateChange(
  adapter: WorkerAdapter | undefined,
): ((h: IncarnationHandle, s: WorkerContractState) => void) | undefined {
  return (adapter as unknown as { deps?: { onStateChange?: (h: IncarnationHandle, s: WorkerContractState) => void } })
    ?.deps?.onStateChange
}

function makeLedgerWorker(p: {
  workerId: string
  status?: LedgerWorker['task']['status']
  updatedAt?: string
  incarnationState?: WorkerContractState
}): LedgerWorker {
  return {
    worker_id: p.workerId,
    task: {
      id: p.workerId,
      title: `任务 ${p.workerId}`,
      status: p.status ?? 'running',
      created_at: '2026-01-01T00:00:00.000Z',
    },
    origin: { spawned_by_session: 'wechat::sess-1' as ManagerKey, trigger_type: 'message' },
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
    const spawnSpy = vi.spyOn(stack.harness, 'spawnWorker').mockResolvedValue(makeLedgerWorker({ workerId: 'w-spawned' }))
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
    expect(params.origin.spawned_by_session).toBe(SYSTEM_TASKS_MANAGER_KEY)
    expect(params.origin.trigger_type).toBe('scheduled')
    expect(params.origin.creator_friend_id).toBe('friend-42')

    await Promise.allSettled(routeSpy.mock.results.map((r) => r.value as Promise<unknown>))
  })

  // --- ③ 三个读端点对真实台账 ---

  it('list_workers_admin / get_worker_detail / read_worker_output_admin 对真实台账与真实输出日志返回正确数据', async () => {
    boot()
    const stack = internals.managerStack!
    const alice = dialogObjectIdForPrivate('alice')
    const bob = dialogObjectIdForPrivate('bob')

    await stack.ledger.upsertWorker(alice, 'w-a1', () =>
      makeLedgerWorker({ workerId: 'w-a1', status: 'running', updatedAt: '2026-02-02T00:00:00.000Z' }),
    )
    await stack.ledger.upsertWorker(alice, 'w-a2', () =>
      makeLedgerWorker({ workerId: 'w-a2', status: 'completed', updatedAt: '2026-02-03T00:00:00.000Z' }),
    )
    await stack.ledger.upsertWorker(bob, 'w-b1', () =>
      makeLedgerWorker({ workerId: 'w-b1', status: 'running', updatedAt: '2026-02-01T00:00:00.000Z' }),
    )

    // 全量：updated_at desc
    const all = await rpc<{ items: Array<{ worker_id: string }>; pagination: { total_items: number } }>(
      'list_workers_admin',
      {},
    )
    expect(all.items.map((w) => w.worker_id)).toEqual(['w-a2', 'w-a1', 'w-b1'])
    expect(all.pagination.total_items).toBe(3)

    // 按 dialog_object_id + status 过滤
    const scoped = await rpc<{ items: Array<{ worker_id: string }> }>('list_workers_admin', {
      dialog_object_id: alice,
      status: 'running',
    })
    expect(scoped.items.map((w) => w.worker_id)).toEqual(['w-a1'])

    // 详情（§8.3 的返回只有 worker 本体，不带 dialog_object_id）
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

  // --- ④ agent.task_status_changed ---

  it('真实状态迁移 → 经生产事件出口发出 agent.task_status_changed，载荷逐字对齐 §9.2', async () => {
    boot()
    const stack = internals.managerStack!
    // 事件出口的终点是 agent 自己那个 RpcClient 实例——spy 在实例上即可拦到生产链路。
    const publishSpy = vi.spyOn(internals.rpcClient, 'publishEvent').mockResolvedValue(1)
    // 同一个 onEvent 的另一条支路（唤醒监护 manager）挡掉：它要跑 LLM，不是本用例的对象；
    // 顺带断言它确实接着（两条支路互不干扰）。
    const routeSpy = vi.spyOn(stack.registry, 'routeWorkerEvent').mockResolvedValue(undefined)

    const dialogObjectId = dialogObjectIdForPrivate('friend-evt')
    await stack.ledger.upsertWorker(dialogObjectId, 'w-evt', () => makeLedgerWorker({ workerId: 'w-evt' }))

    // 用 adapter 手里那份回调触发真实迁移：handleStateChange → processStateChange →
    // upsertWorker（落 completed）→ appendEvent（带 task_status）→ onEvent → 事件出口
    const onStateChange = capturedOnStateChange(stack.adapters.get('builtin'))
    expect(onStateChange).toBeDefined()
    onStateChange!({ worker_id: 'w-evt', seq: 1, impl: 'builtin', session_ref: 'w-evt-ref' }, 'exited')

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
      dialog_object_id: dialogObjectId,
    })
    expect(routeSpy).toHaveBeenCalled()
  })

  // --- ⑥ onStart 的启动对账 ---

  it('onStart() 异步跑一次启动对账：台账里残留的 running 化身被对账掉，且不阻塞 onStart 返回', async () => {
    boot()
    const stack = internals.managerStack!
    // 对账把化身判死会落 `exited` 事件，onEvent 的另一条支路会去唤醒监护 manager（要跑 LLM）。
    // 那条路由本身由 bootstrap.test.ts 覆盖，这里挡掉，免得用例结束后还留着一个在重试的 LLM 请求。
    const routeSpy = vi.spyOn(stack.registry, 'routeWorkerEvent').mockResolvedValue(undefined)
    // 对账判死同样会发 §9.2 事件（下一条用例专门验它）；这里挡住投递，免得没有 MM 的测试环境
    // 刷一屏 ECONNREFUSED——注意 publisher 本身把失败吃掉了，不挡也不会让用例失败。
    vi.spyOn(internals.rpcClient, 'publishEvent').mockResolvedValue(1)
    const dialogObjectId = dialogObjectIdForPrivate('friend-recon')
    await stack.ledger.upsertWorker(dialogObjectId, 'w-stale', () =>
      makeLedgerWorker({ workerId: 'w-stale', status: 'running', incarnationState: 'running' }),
    )

    await internals.onStart()
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
