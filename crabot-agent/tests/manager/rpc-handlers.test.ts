/**
 * agent 侧五个 v3 RPC handler(P5 Task 4)—— protocol-agent-v3.md §8.2 / §8.3。
 *
 * 手法使用 `Object.create(UnifiedAgent.prototype)` 绕过构造函数，只塞 handler 真正会用到的
 * 字段（这里是 `managerStack`），直接调私有 handler。
 * 需要断言"语义不变量而不只是参数透传"的两条(trigger_schedule 的路由归属、权限身份落到
 * `origin.creator_friend_id`)另外走**真实** `buildManagerStack` + mock LLM 的端到端路径。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'

import { UnifiedAgent } from '../../src/unified-agent.js'
import type { PrincipalResolverDeps } from '../../src/manager/principal.js'
import { buildManagerStack, type BootstrapDeps, type ManagerStack } from '../../src/manager/bootstrap.js'
import { SYSTEM_TASKS_MANAGER_KEY } from '../../src/manager/registry.js'
import { WorkerHasNoIncarnationError } from '../../src/workers/harness/harness.js'
import { type ManagerKey, type LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import type { HarnessEvent } from '../../src/workers/harness/worker-events.js'
import type { LLMAdapter } from '../../src/engine/index.js'
import { createCrabMemoryServer } from '../../src/mcp/crab-memory.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
import type {
  ListWorkersAdminParams,
  ListWorkersAdminResult,
  GetWorkerDetailParams,
  GetWorkerDetailResult,
  GetWorkerTerminalParams,
  GetWorkerTerminalResult,
  GetWorkerTraceParams,
  GetWorkerTraceResult,
  ListWorkerSubagentsParams,
  ListWorkerSubagentsResult,
  GetWorkerSubagentDetailParams,
  GetWorkerSubagentDetailResult,
  GetWorkerSubagentTraceParams,
  GetWorkerSubagentTraceResult,
} from '../../src/manager/read-model.js'
import type { TriggerScheduleParams, TriggerScheduleResult } from '../../src/unified-agent.js'

// ============================================================================
// helpers
// ============================================================================

/** 被测的五个私有 handler 的公开视图(TS 私有性只在编译期,运行时照常可调)。 */
interface AgentUnderTest {
  agentConfig: { model_config: Record<string, { apikey: string; model_id: string }> }
  managerStack?: unknown
  handleTriggerSchedule(p: TriggerScheduleParams): Promise<TriggerScheduleResult>
  handleListWorkersAdmin(p: ListWorkersAdminParams): Promise<ListWorkersAdminResult>
  handleGetWorkerDetail(p: GetWorkerDetailParams): Promise<GetWorkerDetailResult>
  handleGetWorkerTerminal(p: GetWorkerTerminalParams): Promise<GetWorkerTerminalResult>
  handleGetWorkerTrace(p: GetWorkerTraceParams): Promise<GetWorkerTraceResult>
  handleListWorkerSubagents(p: ListWorkerSubagentsParams): Promise<ListWorkerSubagentsResult>
  handleGetWorkerSubagentDetail(p: GetWorkerSubagentDetailParams): Promise<GetWorkerSubagentDetailResult>
  handleGetWorkerSubagentTrace(p: GetWorkerSubagentTraceParams): Promise<GetWorkerSubagentTraceResult>
}

function buildAgent(managerStack?: unknown): AgentUnderTest {
  const agent = Object.create(UnifiedAgent.prototype) as Record<string, unknown>
  agent.agentConfig = { model_config: { powerful: { apikey: 'test-key', model_id: 'test-model' } } }
  agent.config = { moduleId: 'test-agent' }
  agent.knownSecrets = []
  // 直接 test fixture：构造函数默认 runtime_config_authenticated=true；Object.create 绕过构造函数，这里补齐。
  agent.configAuthenticated = true
  agent.configStale = false
  if (managerStack !== undefined) {
    // composite reader 需要 adapters Map；mock 栈缺省时补空表（native 走 source-scoped reason）。
    if (typeof managerStack === 'object' && managerStack !== null && !('adapters' in managerStack)) {
      ;(managerStack as Record<string, unknown>).adapters = new Map()
    }
    agent.managerStack = managerStack
  }
  return agent as unknown as AgentUnderTest
}

/** `routeSchedule` 的成功返回形状(handler 的 fail-loud 收尾要读 `outcome`)。 */
function completedEpisode(outcome: 'completed' | 'failed' | 'aborted' = 'completed'): {
  episodeId: string
  outcome: string
  turns: number
  consumedEvents: boolean
  repliedToHuman: boolean
} {
  return { episodeId: 'ep-1', outcome, turns: 1, consumedEvents: true, repliedToHuman: false }
}

function makeLedgerWorker(p: {
  workerId: string
  status?: LedgerWorker['task']['status']
  createdAt?: string
  updatedAt?: string
}): LedgerWorker {
  return {
    worker_id: p.workerId,
    task: {
      id: p.workerId,
      title: `任务 ${p.workerId}`,
      status: p.status ?? 'running',
      created_at: p.createdAt ?? '2026-01-01T00:00:00.000Z',
    },
    origin: {
      trigger_type: 'message' },
    report_to: { channel_id: 'wechat', session_id: 'sess-1' },
    incarnations: [],
    updated_at: p.updatedAt ?? '2026-01-01T00:00:00.000Z',
  }
}

/** 最小 crab-memory server(照抄 tests/manager/bootstrap.test.ts)。 */
function makeMemoryServer() {
  return createCrabMemoryServer(
    { rpcClient: { call: vi.fn() } as never, moduleId: 'rpc-handlers-test', getMemoryPort: async () => 19100 },
    { visibility: 'internal', scopes: [], isMasterPrivate: false },
  )
}

/** 身份解析原料的最小桩:一律"解析不出来",即 manager 退回未接线时的既有行为。 */
function makePrincipalResolver(): PrincipalResolverDeps {
  return {
    resolvePermissions: async () => null,
    sessionMemoryScopes: async (sessionId) => [sessionId],
    sceneProfile: async () => null,
    crabSelfHandle: () => undefined,
    masterFriendId: async () => undefined,
  }
}

/** 最小 crab-messaging 依赖桩(照抄 tests/manager/bootstrap.test.ts)。 */
function makeMessagingDeps() {
  return {
    rpcClient: { call: vi.fn() } as never,
    moduleId: 'rpc-handlers-test',
    getAdminPort: async () => 19001,
    resolveChannelPort: async () => 19009,
  }
}

/** 脚本化 manager LLM(照抄 tests/manager/manager-integration.test.ts 的 makeWorkerLLM 约定)。 */
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

async function waitUntil(cond: () => boolean, timeoutMs = 6000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitUntil timed out')
}

// ============================================================================
// §8.2 trigger_schedule
// ============================================================================

describe('trigger_schedule(§8.2)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('受理即返回 {accepted:true}——routeSchedule 永不 resolve 也不阻塞 handler', async () => {
    let routeCalls = 0
    const stack = {
      registry: {
        routeSchedule: () => {
          routeCalls++
          return new Promise<never>(() => {
            /* 永不 resolve:handler 若 await 它就永远回不来 */
          })
        },
      },
    }
    const agent = buildAgent(stack)

    // handler 是同步返回的:拿到返回值这件事本身就证明它没有等待路由完成
    const result = await agent.handleTriggerSchedule({ schedule_id: 'sc-1', title: '巡检', description: '每日巡检' })

    expect(result).toEqual({ accepted: true })
    expect(routeCalls).toBe(1)
  })

  it('routeSchedule 抛错不产生 unhandledRejection(游离 promise 必须 .catch)', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const stack = {
        registry: { routeSchedule: () => Promise.reject(new Error('路由炸了')) },
      }
      const agent = buildAgent(stack)

      await expect(agent.handleTriggerSchedule({ schedule_id: 'sc-1', title: 't', description: 'd' })).resolves.toEqual({
        accepted: true,
      })

      // 给 node 若干次事件循环回合去判定 unhandledRejection
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(unhandled).toEqual([])
      // 失败仍要留痕(诊断日志)
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('参数按 §8.2 原样透传给 registry.routeSchedule(含 target_session / 权限身份)', async () => {
    const calls: unknown[] = []
    // resolve 一个**成功**的 episode:handler 的收尾要读 `outcome`(fail-loud 判据双管),
    // 裸 `Promise.resolve()` 已经不是 `routeSchedule` 的真实契约形状。
    const agent = buildAgent({
      registry: { routeSchedule: (p: unknown) => { calls.push(p); return Promise.resolve(completedEpisode()) } },
    })

    await agent.handleTriggerSchedule({
      schedule_id: 'sc-9',
      title: '标题',
      description: '描述',
      task_type: 'daily_reflection',
      target_session: { channel_id: 'wechat', session_id: 'sess-1' },
      creator_friend_id: 'friend-42',
      is_builtin: false,
    })

    expect(calls[0]).toEqual({
      scheduleId: 'sc-9',
      title: '标题',
      description: '描述',
      taskType: 'daily_reflection',
      targetSession: { channel_id: 'wechat', session_id: 'sess-1' },
      creatorFriendId: 'friend-42',
      isBuiltin: false,
    })
  })

  it('manager 栈未装配时抛明确错误(P5 阶段启动路径尚未接线)', async () => {
    const agent = buildAgent()
    await expect(agent.handleTriggerSchedule({ schedule_id: 'sc', title: 't', description: 'd' })).rejects.toThrow(
      /Manager stack not initialized/,
    )
  })
})

// ============================================================================
// §8.2 fail-loud:定时任务失败不再静默
//
// 事前形态:游离 promise 只 `.catch(console.error)`,**从不看 outcome**——最常见的失败
// (F1:LLM 挂 / key 过期 / 限流耗尽,不抛错、只把 outcome 写成 failed)因此完全静默,
// 人类那边的表现就是"早报没发、反思没生成",而且没有任何提示。
//
// 这里只替身 `registry.routeSchedule` 与出站 `rpcClient`:判据、文案、冷却、目标解析
// 全部走生产代码。
// ============================================================================

describe('trigger_schedule 的 fail-loud 兜底', () => {
  const ADMIN_PORT = 18000
  const WECHAT_PORT = 18001

  interface RpcCall {
    port: number
    method: string
    params: Record<string, unknown>
  }

  interface FailLoudAgent extends AgentUnderTest {
    failLoudSentAt: Map<string, number>
  }

  function buildOutboundAgent(routeSchedule: () => Promise<unknown>): {
    agent: FailLoudAgent
    rpcCalls: RpcCall[]
    failSend: { value: boolean }
  } {
    const rpcCalls: RpcCall[] = []
    const failSend = { value: false }
    const agent = buildAgent({ registry: { routeSchedule } }) as unknown as Record<string, unknown>
    agent.failLoudSentAt = new Map<string, number>()
    agent.silentEpisodeStreak = new Map<string, number>()
    // 端口预置:出站不走 rpcClient.resolve(那是另一条链路的事)
    agent.channelPorts = new Map([['wechat', WECHAT_PORT]])
    agent.adminPort = ADMIN_PORT
    agent.rpcClient = {
      call: async (port: number, method: string, params: Record<string, unknown>) => {
        rpcCalls.push({ port, method, params })
        if (failSend.value) throw new Error('channel 也挂了')
        return {}
      },
      resolve: async () => [],
    }
    return { agent: agent as unknown as FailLoudAgent, rpcCalls, failSend }
  }

  function sentText(rpcCalls: RpcCall[]): string | undefined {
    const sent = rpcCalls.find((c) => c.method === 'send_message')
    return (sent?.params.content as { text: string } | undefined)?.text
  }

  /** 游离 promise 的收尾跑在微任务里,handler 同步返回后要给它几个回合。 */
  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('F1(outcome=failed,不抛错)→ 目标会话收到兜底消息', async () => {
    const { agent, rpcCalls } = buildOutboundAgent(async () => completedEpisode('failed'))

    await agent.handleTriggerSchedule({
      schedule_id: 'sc-morning',
      title: '每日早报',
      description: '每天 8 点发早报',
      target_session: { channel_id: 'wechat', session_id: 'sess-1' },
    })
    await settle()

    const sent = rpcCalls.find((c) => c.method === 'send_message')
    expect(sent, '只 catch 不看 outcome 时这里必然是 undefined —— 正是事前的静默形态').toBeDefined()
    expect(sent!.port).toBe(WECHAT_PORT)
    expect(sent!.params.session_id).toBe('sess-1')
  })

  it('文案是"非人类触发"变体:点名哪个定时任务,且不出现第二人称的"回不了你"', async () => {
    const { agent, rpcCalls } = buildOutboundAgent(async () => completedEpisode('failed'))

    await agent.handleTriggerSchedule({
      schedule_id: 'sc-morning',
      title: '每日早报',
      description: 'd',
      target_session: { channel_id: 'wechat', session_id: 'sess-1' },
    })
    await settle()

    const text = sentText(rpcCalls)
    expect(text).toContain('定时任务「每日早报」')
    expect(text).toContain('没跑成')
    expect(text).toContain('failed')
    expect(text).toContain('管理员')
    // 人类消息那份文案照搬过来是错的:定时任务触发时没人刚说话
    expect(text).not.toContain('回不了你')
    expect(text).not.toContain('再发一次')
  })

  it('F2(episode 抛错)→ 兜底文案带上原始错误信息', async () => {
    const { agent, rpcCalls } = buildOutboundAgent(async () => {
      throw new Error('adapter thunk 炸了')
    })

    await agent.handleTriggerSchedule({
      schedule_id: 'sc-x',
      title: '晚间反思',
      description: 'd',
      target_session: { channel_id: 'wechat', session_id: 'sess-1' },
    })
    await settle()

    const text = sentText(rpcCalls)
    expect(text).toContain('定时任务「晚间反思」')
    expect(text).toContain('adapter thunk 炸了')
  })

  it('outcome=completed → 不发兜底(误报比漏报更伤)', async () => {
    const { agent, rpcCalls } = buildOutboundAgent(async () => completedEpisode('completed'))

    await agent.handleTriggerSchedule({
      schedule_id: 'sc-ok',
      title: '正常任务',
      description: 'd',
      target_session: { channel_id: 'wechat', session_id: 'sess-1' },
    })
    await settle()

    expect(rpcCalls).toEqual([])
  })

  it('无 target_session → 投系统任务线程(与 routeSchedule 的路由归属同一判据)', async () => {
    const { agent, rpcCalls } = buildOutboundAgent(async () => completedEpisode('failed'))

    await agent.handleTriggerSchedule({ schedule_id: 'sc-sys', title: '系统巡检', description: 'd' })
    await settle()

    const sent = rpcCalls.find((c) => c.method === 'send_message')
    expect(sent!.port).toBe(ADMIN_PORT)
    expect(sent!.params.session_id).toBe('system-tasks')
  })

  it('target_session 指向 Master Chat 时改投 system-tasks —— 不认领人类那条在飞的占位气泡', async () => {
    const { agent, rpcCalls } = buildOutboundAgent(async () => completedEpisode('failed'))

    await agent.handleTriggerSchedule({
      schedule_id: 'sc-master',
      title: '主人专属早报',
      description: 'd',
      target_session: { channel_id: 'admin-web', session_id: 'admin-chat' },
    })
    await settle()

    const sent = rpcCalls.find((c) => c.method === 'send_message')
    expect(sent!.port).toBe(ADMIN_PORT)
    // admin 的 storeAssistantMessage 只在 session_id==='admin-chat' 时 claimPendingRequestId():
    // 投 admin-chat 会把当时在飞的那条人类提问的气泡顶掉(它自己的答案就永远转圈了)。
    // 两个 session 落的是同一个 store / 同一条 chat_push,人类照样看得到。
    expect(sent!.params.session_id).toBe('system-tasks')
  })

  it('按 key 冷却仍然生效:连续失败只发一条', async () => {
    const { agent, rpcCalls } = buildOutboundAgent(async () => completedEpisode('failed'))

    for (let i = 0; i < 3; i++) {
      await agent.handleTriggerSchedule({
        schedule_id: 'sc-loop',
        title: '高频任务',
        description: 'd',
        target_session: { channel_id: 'wechat', session_id: 'sess-1' },
      })
      await settle()
    }

    expect(rpcCalls.filter((c) => c.method === 'send_message')).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('送不出去(channel 也挂了)只落日志,不抛、不产生 unhandledRejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const { agent, failSend } = buildOutboundAgent(async () => completedEpisode('failed'))
      failSend.value = true

      expect(
        await agent.handleTriggerSchedule({
          schedule_id: 'sc-dead',
          title: '任务',
          description: 'd',
          target_session: { channel_id: 'wechat', session_id: 'sess-1' },
        }),
      ).toEqual({ accepted: true })
      await settle()
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(unhandled).toEqual([])
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

// ============================================================================
// §8.2 端到端:双路由 + 权限身份真的落到 origin.creator_friend_id
// ============================================================================

describe('trigger_schedule 端到端(真实 manager 栈 + mock LLM)', () => {
  let tmpRoot: string
  const managerKeyFor = (key: ManagerKey): ManagerKey => `test::friend-of-${key}` as ManagerKey

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(join(tmpdir(), 'rpc-handlers-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  function makeStack(llm: LLMAdapter): ManagerStack {
    const deps: BootstrapDeps = {
      dataRoot: join(tmpRoot, 'data'),
      now: () => new Date().toISOString(),
      managerAdapter: () => llm,
      managerModel: () => 'test-manager-model',
      messagingDeps: makeMessagingDeps(),
      memoryServerFor: () => makeMemoryServer(),
      callAdmin: async () => ({}) as never,
      principalResolver: makePrincipalResolver(),
    }
    return buildManagerStack(deps)
  }

  /** 第一轮调 spawn_worker、第二轮收工的 manager 脚本。 */
  function spawnScript(): LLMAdapter {
    return makeManagerLLM([
      {
        toolCalls: [{ name: 'spawn_worker', id: 'tc-1', input: { title: '巡检子任务', prompt: '去巡检' } }],
        stopReason: 'tool_use',
      },
      { text: '已派发', stopReason: 'end_turn' },
    ])
  }

  it('无 target_session → 系统线程 manager;creator_friend_id 落到 origin.creator_friend_id,trigger_type=scheduled', async () => {
    const stack = makeStack(spawnScript())
    const spawnSpy = vi
      .spyOn(stack.harness, 'spawnWorker')
      .mockResolvedValue(makeLedgerWorker({ workerId: 'w-spawned' }))
    const routeSpy = vi.spyOn(stack.registry, 'routeSchedule')
    const agent = buildAgent(stack)

    const result = await agent.handleTriggerSchedule({
      schedule_id: 'sc-sys',
      title: '系统巡检',
      description: '无目标会话',
      creator_friend_id: 'friend-42',
    })

    expect(result).toEqual({ accepted: true })
    // fire-and-forget 的另一面自证:受理返回那一刻 episode 还没跑到派发 worker
    expect(spawnSpy).not.toHaveBeenCalled()

    await waitUntil(() => spawnSpy.mock.calls.length > 0)
    const params = spawnSpy.mock.calls[0][0]
    expect(params.managerKey).toBe(SYSTEM_TASKS_MANAGER_KEY)
    expect(params.origin.creator_friend_id).toBe('friend-42')
    expect(params.origin.trigger_type).toBe('scheduled')

    await Promise.allSettled(routeSpy.mock.results.map((r) => r.value as Promise<unknown>))
  })

  it('有 target_session → 该会话的 manager', async () => {
    const stack = makeStack(spawnScript())
    const spawnSpy = vi
      .spyOn(stack.harness, 'spawnWorker')
      .mockResolvedValue(makeLedgerWorker({ workerId: 'w-spawned' }))
    const routeSpy = vi.spyOn(stack.registry, 'routeSchedule')
    const agent = buildAgent(stack)

    await agent.handleTriggerSchedule({
      schedule_id: 'sc-sess',
      title: '会话内巡检',
      description: '有目标会话',
      target_session: { channel_id: 'wechat', session_id: 'sess-1' },
      creator_friend_id: 'friend-7',
    })

    await waitUntil(() => spawnSpy.mock.calls.length > 0)
    const params = spawnSpy.mock.calls[0][0]
    expect(params.managerKey).toBe('wechat::sess-1')
    expect(params.origin.creator_friend_id).toBe('friend-7')
    expect(params.origin.trigger_type).toBe('scheduled')

    await Promise.allSettled(routeSpy.mock.results.map((r) => r.value as Promise<unknown>))
  })

  it('is_builtin=true → 不以任何 friend 身份执行(creator_friend_id 留空,按 §4.4「master 等价」的既有空值规则)', async () => {
    const stack = makeStack(spawnScript())
    const spawnSpy = vi
      .spyOn(stack.harness, 'spawnWorker')
      .mockResolvedValue(makeLedgerWorker({ workerId: 'w-spawned' }))
    const routeSpy = vi.spyOn(stack.registry, 'routeSchedule')
    const agent = buildAgent(stack)

    await agent.handleTriggerSchedule({
      schedule_id: 'sc-builtin',
      title: '内置巡检',
      description: '系统内置',
      is_builtin: true,
      creator_friend_id: 'friend-should-be-ignored',
    })

    await waitUntil(() => spawnSpy.mock.calls.length > 0)
    expect(spawnSpy.mock.calls[0][0].origin.creator_friend_id).toBeUndefined()

    await Promise.allSettled(routeSpy.mock.results.map((r) => r.value as Promise<unknown>))
  })

  it('非 schedule 唤醒(人类消息)不受影响:trigger_type 仍是 message,不带 creator_friend_id', async () => {
    const stack = makeStack(spawnScript())
    const spawnSpy = vi
      .spyOn(stack.harness, 'spawnWorker')
      .mockResolvedValue(makeLedgerWorker({ workerId: 'w-spawned' }))

    await stack.registry.routeHumanMessages('wechat', 'sess-1', [
      {
        platform_message_id: 'pm-1',
        session: { session_id: 'sess-1', channel_id: 'wechat', type: 'private' },
        sender: { platform_user_id: 'u1', platform_display_name: '测试用户' },
        content: { type: 'text', text: '帮我跑个活' },
        features: { is_mention_crab: false },
        platform_timestamp: new Date().toISOString(),
      },
    ])

    await waitUntil(() => spawnSpy.mock.calls.length > 0)
    const params = spawnSpy.mock.calls[0][0]
    expect(params.origin.trigger_type).toBe('message')
    expect(params.origin.creator_friend_id).toBeUndefined()
  })

  // --- PR #59 review：scheduled 的权限档位按 Schedule.creator_friend_id 解析，
  //     不借"该会话最近说话的人"（§4.4）---

  /** 按 friend id 分档的解析桩：记录每次解析请求。 */
  function permsByFriend(): { deps: PrincipalResolverDeps; calls: Array<{ senderFriendId?: string }> } {
    const calls: Array<{ senderFriendId?: string }> = []
    const deps: PrincipalResolverDeps = {
      resolvePermissions: async (p) => {
        calls.push({ ...(p.senderFriendId ? { senderFriendId: p.senderFriendId } : {}) })
        return {
          tool_access: {
            memory: true, messaging: true, task: true, mcp_skill: true,
            file_io: true, browser: true, shell: true, remote_exec: false, desktop: false,
          },
          cli_access: {} as never,
          storage: null,
          memory_scopes: [`scope-of-${p.senderFriendId ?? 'session'}`],
        }
      },
      sessionMemoryScopes: async (sessionId) => [sessionId],
      sceneProfile: async () => null,
      crabSelfHandle: () => undefined,
      masterFriendId: async () => undefined,
    }
    return { deps, calls }
  }

  function makeStackWith(llm: LLMAdapter, principalResolver: PrincipalResolverDeps): ManagerStack {
    return buildManagerStack({
      dataRoot: join(tmpRoot, 'data'),
      now: () => new Date().toISOString(),
      managerAdapter: () => llm,
      managerModel: () => 'test-manager-model',
      messagingDeps: makeMessagingDeps(),
      memoryServerFor: () => makeMemoryServer(),
      callAdmin: async () => ({}) as never,
      principalResolver,
    })
  }

  it('打进人类会话的 scheduled：档位按 Schedule.creator_friend_id 解析，不是该会话最近的发言人', async () => {
    const { deps, calls } = permsByFriend()
    const stack = makeStackWith(spawnScript(), deps)
    const spawnSpy = vi
      .spyOn(stack.harness, 'spawnWorker')
      .mockResolvedValue(makeLedgerWorker({ workerId: 'w-spawned' }))
    const agent = buildAgent(stack)

    // 该会话最近说话的是 f-lastspeaker（唤醒边界解析过一次，写进了会话级缓存）
    await stack.principals.resolve('wechat::sess-1' as ManagerKey, {
      friend: {
        id: 'f-lastspeaker',
        display_name: '刚说过话的人',
        permission: 'normal',
        channel_identities: [],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      sessionType: 'private',
    })

    await agent.handleTriggerSchedule({
      schedule_id: 'sc-sess',
      title: '会话内巡检',
      description: '有目标会话',
      target_session: { channel_id: 'wechat', session_id: 'sess-1' },
      creator_friend_id: 'friend-7',
    })

    await waitUntil(() => spawnSpy.mock.calls.length > 0)
    const params = spawnSpy.mock.calls[0][0]
    expect(params.origin.creator_friend_id).toBe('friend-7')
    // 解析是以调度的 creator 名义发起的，档位也是那一份
    expect(calls.map((c) => c.senderFriendId)).toEqual(['f-lastspeaker', 'friend-7'])
    expect(params.principal_permissions?.memory_scopes).toEqual(['scope-of-friend-7'])
  })

  it('is_builtin 的 scheduled：不以任何 friend 名义执行，档位留空（master 等价，worker 退回固定档位）', async () => {
    const { deps, calls } = permsByFriend()
    const stack = makeStackWith(spawnScript(), deps)
    const spawnSpy = vi
      .spyOn(stack.harness, 'spawnWorker')
      .mockResolvedValue(makeLedgerWorker({ workerId: 'w-spawned' }))
    const agent = buildAgent(stack)

    await stack.principals.resolve('wechat::sess-1' as ManagerKey, {
      friend: {
        id: 'f-lastspeaker',
        display_name: '刚说过话的人',
        permission: 'normal',
        channel_identities: [],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      sessionType: 'private',
    })

    await agent.handleTriggerSchedule({
      schedule_id: 'sc-builtin',
      title: '内置巡检',
      description: '系统内置',
      target_session: { channel_id: 'wechat', session_id: 'sess-1' },
      is_builtin: true,
    })

    await waitUntil(() => spawnSpy.mock.calls.length > 0)
    const params = spawnSpy.mock.calls[0][0]
    expect(params.origin.creator_friend_id).toBeUndefined()
    expect(params.principal_permissions).toBeUndefined()
    // 内置调度不触发第二次解析（只有那条人类消息那次）
    expect(calls).toHaveLength(1)
  })
})

// ============================================================================
// §8.3 读模型四件套
// ============================================================================

describe('list_workers_admin(§8.3)', () => {
  it('取全量台账 → filterAndPageWorkers(status 过滤 + 分页回显)', async () => {
    const entries = [
      { managerKey: `test::f1` as ManagerKey, worker: makeLedgerWorker({ workerId: 'w-1', status: 'running', updatedAt: '2026-01-03T00:00:00.000Z' }) },
      { managerKey: `test::f1` as ManagerKey, worker: makeLedgerWorker({ workerId: 'w-2', status: 'completed', updatedAt: '2026-01-02T00:00:00.000Z' }) },
      { managerKey: `test::f2` as ManagerKey, worker: makeLedgerWorker({ workerId: 'w-3', status: 'running', updatedAt: '2026-01-01T00:00:00.000Z' }) },
    ]
    const agent = buildAgent({ ledger: { listAllWorkers: async () => entries } })

    const current = await agent.handleListWorkersAdmin({})
    expect(current.items.map((w) => w.worker_id)).toEqual(['w-1', 'w-3'])
    expect(current.pagination).toEqual({ page: 1, page_size: 20, total_items: 2, total_pages: 1 })
    expect(current).toMatchObject({ total_active: 2, total_terminal: 1 })

    const all = await agent.handleListWorkersAdmin({ include_terminal: true })
    expect(all.items.map((w) => w.worker_id)).toEqual(['w-1', 'w-2', 'w-3'])

    const running = await agent.handleListWorkersAdmin({ status: 'running' })
    expect(running.items.map((w) => w.worker_id)).toEqual(['w-1', 'w-3'])

    const scoped = await agent.handleListWorkersAdmin({ manager_key: `test::f2` as ManagerKey })
    expect(scoped.items.map((w) => w.worker_id)).toEqual(['w-3'])
  })

  it('params 缺省(admin 不带任何查询参数)也能工作', async () => {
    const agent = buildAgent({ ledger: { listAllWorkers: async () => [] } })
    const result = await agent.handleListWorkersAdmin(undefined as unknown as ListWorkersAdminParams)
    expect(result.items).toEqual([])
    expect(result.pagination.total_items).toBe(0)
  })
})

describe('get_worker_detail(§8.3)', () => {
  it('存在 → 返回台账条目本身(剥掉 managerKey 包装)', async () => {
    const worker = makeLedgerWorker({ workerId: 'w-1' })
    const agent = buildAgent({
      ledger: { findWorker: async () => ({ managerKey: `test::f1` as ManagerKey, worker }) },
    })
    await expect(agent.handleGetWorkerDetail({ worker_id: 'w-1' })).resolves.toEqual({ worker })
  })

  it('不存在 → 抛带 worker_id 的明确错误', async () => {
    const agent = buildAgent({ ledger: { findWorker: async () => undefined } })
    await expect(agent.handleGetWorkerDetail({ worker_id: 'w-missing' })).rejects.toThrow(/w-missing/)
  })
})

describe('get_worker_terminal(§8.3)', () => {
  it('seq 原样下传，返回完整终端视图', async () => {
    const calls: unknown[][] = []
    const agent = buildAgent({
      harness: {
        getWorkerTerminal: async (...args: unknown[]) => {
          calls.push(args)
          return { kind: 'live_terminal', text: 'hello', captured_at: '2026-08-19T00:00:00.000Z' }
        },
      },
    })

    const result = await agent.handleGetWorkerTerminal({ worker_id: 'w-1', seq: 2 })

    expect(calls[0]).toEqual(['w-1', { seq: 2 }])
    expect(result).toEqual({ kind: 'live_terminal', text: 'hello', captured_at: '2026-08-19T00:00:00.000Z' })
  })

  it('无 seq 时不下发 opts，保留 agent 侧主线化身选择', async () => {
    const calls: unknown[][] = []
    const agent = buildAgent({
      harness: {
        getWorkerTerminal: async (...args: unknown[]) => {
          calls.push(args)
          return { kind: 'unavailable', unavailable_reason: 'legacy_without_terminal_snapshot' }
        },
      },
    })

    const result = await agent.handleGetWorkerTerminal({ worker_id: 'w-1' })

    expect(calls[0]).toEqual(['w-1', undefined])
    expect(result).toEqual({ kind: 'unavailable', unavailable_reason: 'legacy_without_terminal_snapshot' })
  })

  it('unavailable 原因原样保留给 Admin 调用方', async () => {
    const agent = buildAgent({
      harness: {
        getWorkerTerminal: async () => ({ kind: 'unavailable', unavailable_reason: 'legacy_without_terminal_snapshot' }),
      },
    })

    await expect(agent.handleGetWorkerTerminal({ worker_id: 'w-legacy' })).resolves.toEqual({
      kind: 'unavailable',
      unavailable_reason: 'legacy_without_terminal_snapshot',
    })
  })

  it('harness 抛错(worker/化身不存在)原样冒泡,不吞成空 chunk', async () => {
    const agent = buildAgent({
      harness: {
        getWorkerTerminal: async () => {
          throw new Error('no incarnation with seq=9')
        },
      },
    })
    await expect(agent.handleGetWorkerTerminal({ worker_id: 'w-1', seq: 9 })).rejects.toThrow(/seq=9/)
  })
})

describe('get_worker_trace(§8.3 + §10.2，P6-A composite)', () => {
  const events: HarnessEvent[] = [
    { ts: '2026-01-01T00:00:00.000Z', kind: 'spawned', worker_id: 'w-1', seq: 1, detail: { impl: 'builtin' } },
    { ts: '2026-01-01T00:00:01.000Z', kind: 'input_sent', worker_id: 'w-1', seq: 1 },
    { ts: '2026-01-01T00:00:02.000Z', kind: 'spawned', worker_id: 'w-1', seq: 2 },
  ]

  const incarnation = (seq: number) => ({
    seq,
    impl: 'builtin' as const,
    state: 'exited' as const,
    workspace: '/tmp/ws-not-used',
    session_ref: `ref-${seq}`,
    started_at: '2026-01-01T00:00:00.000Z',
  })

  async function agentWithEvents() {
    const root = await fs.mkdtemp(join(tmpdir(), 'rpc-trace-'))
    const agent = buildAgent({
      ledger: {
        findWorker: async () => ({
          managerKey: `test::f1` as ManagerKey,
          worker: { ...makeLedgerWorker({ workerId: 'w-1' }), incarnations: [incarnation(1), incarnation(2)] },
        }),
      },
      harness: { readWorkerEvents: async () => events },
    }) as unknown as Record<string, unknown>
    // composite reader 依赖的私有 store：测试用真实临时目录实例
    const { TraceCursorStore } = await import('../../src/workers/trace/cursor-store.js')
    const { NativeTraceCopyStore } = await import('../../src/workers/trace/native-copy.js')
    const cursorStore = new TraceCursorStore(join(root, 'cursors'))
    const copyStore = new NativeTraceCopyStore(join(root, 'copies'))
    agent.traceCursorStoreInstance = cursorStore
    agent.nativeTraceCopyStoreInstance = copyStore
    const flush = async () => { await cursorStore.flush(); await copyStore.flush() }
    return { agent: agent as never as { handleGetWorkerTrace(p: unknown): Promise<{ events: Array<{ ts: string; kind: string; summary: string; detail?: unknown; source?: string }>; next_cursor?: string; unavailable_reason?: string }> }, root, flush }
  }

  it('harness 事件按 seq 过滤并归一化；builtin adapter 未注册时 native 给 source-scoped reason', async () => {
    const { agent, root, flush } = await agentWithEvents()
    try {
      const result = await agent.handleGetWorkerTrace({ worker_id: 'w-1', seq: 1 })
      expect(result.events.map((e) => e.ts)).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'])
      expect(result.events.every((e) => e.kind === 'lifecycle')).toBe(true)
      expect(result.events[0].summary).toContain('spawned')
      expect(result.events[0].detail).toEqual({ impl: 'builtin' })
      expect(result.events.every((e) => e.source === 'harness')).toBe(true)
      // 未注册 adapter：不再返回泛化 layer2 unavailable，是 source-scoped reason
      expect(result.unavailable_reason).toContain('no adapter registered')
      // 成功解析后 next_cursor 恒在
      expect(result.next_cursor).toBeTruthy()
    } finally {
      await flush()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('opaque cursor 增量读：token 续读只拿增量、读完为空；非法 token INVALID_PARAMS', async () => {
    const { agent, root, flush } = await agentWithEvents()
    try {
      const first = await agent.handleGetWorkerTrace({ worker_id: 'w-1', seq: 1 })
      expect(first.events).toHaveLength(2)
      const second = await agent.handleGetWorkerTrace({ worker_id: 'w-1', seq: 1, cursor: first.next_cursor })
      expect(second.events).toEqual([])
      expect(second.next_cursor).toBeTruthy()
      // 裸 offset token 不再是合法 cursor
      await expect(agent.handleGetWorkerTrace({ worker_id: 'w-1', seq: 1, cursor: '1' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    } finally {
      await flush()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('legacy 化身：trace_ids 时间线 + harness 事件合并，顺序稳定', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'legacy-trace-rpc-'))
    const previousAgentDir = process.env.CRABOT_AGENT_DATA_DIR
    let cursorStore: { flush(): Promise<void> } | undefined
    let copyStore: { flush(): Promise<void> } | undefined
    try {
      const agentDir = join(root, 'agent')
      const traceDir = join(agentDir, 'traces')
      await fs.mkdir(traceDir, { recursive: true })
      process.env.CRABOT_AGENT_DATA_DIR = agentDir
      const started = '2026-01-01T00:00:00.000Z'
      await fs.writeFile(join(traceDir, 'traces-2026-01-01.jsonl'), [
        JSON.stringify({ trace_id: 'end-first', related_task_id: 'old', started_at: started, ended_at: '2026-01-01T00:00:01.000Z', outcome: { summary: 'z end first' } }),
        JSON.stringify({ trace_id: 'a', related_task_id: 'old', started_at: started, ended_at: '2026-01-01T00:00:02.000Z', outcome: { summary: 'z id a' } }),
        JSON.stringify({ trace_id: 'b', related_task_id: 'old', started_at: started, ended_at: '2026-01-01T00:00:02.000Z', outcome: { summary: 'a id b' } }),
      ].join('\n'))
      const worker: LedgerWorker = {
        ...makeLedgerWorker({ workerId: 'w-legacy' }),
        manager_key: 'test::f1' as ManagerKey,
        task: { ...makeLedgerWorker({ workerId: 'w-legacy' }).task, status: 'completed' },
        incarnations: [{
          seq: 1,
          impl: 'legacy',
          state: 'exited',
          workspace: root,
          started_at: started,
          ended_at: '2026-01-01T00:00:03.000Z',
          ended_reason: 'completed',
        }],
        legacy_source: {
          kind: 'v2_admin_task',
          admin_task_id: 'old',
          trace_ids: ['b', 'end-first', 'a'],
          imported_at: '2026-01-01T00:10:00.000Z',
        },
      }
      const imported: HarnessEvent = {
        ts: '2026-01-01T00:10:00.000Z',
        kind: 'legacy_imported',
        worker_id: 'w-legacy',
        seq: 1,
      }
      const agent = buildAgent({
        ledger: { findWorker: async () => ({ managerKey: 'test::f1' as ManagerKey, worker }) },
        harness: { readWorkerEvents: async () => [imported] },
      }) as unknown as Record<string, unknown>
      const { TraceCursorStore } = await import('../../src/workers/trace/cursor-store.js')
      const { NativeTraceCopyStore } = await import('../../src/workers/trace/native-copy.js')
      cursorStore = new TraceCursorStore(join(root, 'cursors'))
      copyStore = new NativeTraceCopyStore(join(root, 'copies'))
      agent.traceCursorStoreInstance = cursorStore
      agent.nativeTraceCopyStoreInstance = copyStore
      const handler = agent as never as { handleGetWorkerTrace(p: unknown): Promise<{ events: Array<{ summary: string }>; next_cursor?: string }> }

      const full = await handler.handleGetWorkerTrace({ worker_id: 'w-legacy', seq: 1 })
      expect(full.events.map((event) => event.summary)).toEqual([
        'z end first',
        'z id a',
        'a id b',
        'legacy_imported',
      ])
      expect(full.next_cursor).toBeTruthy()

      const continued = await handler.handleGetWorkerTrace({ worker_id: 'w-legacy', seq: 1, cursor: full.next_cursor })
      expect(continued.events).toEqual([])
    } finally {
      if (previousAgentDir === undefined) delete process.env.CRABOT_AGENT_DATA_DIR
      else process.env.CRABOT_AGENT_DATA_DIR = previousAgentDir
      await cursorStore?.flush()
      await copyStore?.flush()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('显式 seq 在化身链里不存在 → 抛错,而不是静默返回空 events', async () => {
    const { agent, root, flush } = await agentWithEvents()
    try {
      await expect(agent.handleGetWorkerTrace({ worker_id: 'w-1', seq: 9 })).rejects.toThrow(/seq=9/)
    } finally {
      await flush()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('zero-incarnation system task returns the stable domain error for default and explicit seq', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'rpc-trace-zero-'))
    try {
      const agent = buildAgent({
        ledger: {
          findWorker: async () => ({
            managerKey: `test::f1` as ManagerKey,
            worker: { ...makeLedgerWorker({ workerId: 'w-system' }), incarnations: [] },
          }),
        },
        harness: { readWorkerEvents: async () => [] },
      }) as unknown as Record<string, unknown>
      const { TraceCursorStore } = await import('../../src/workers/trace/cursor-store.js')
      const { NativeTraceCopyStore } = await import('../../src/workers/trace/native-copy.js')
      agent.traceCursorStoreInstance = new TraceCursorStore(join(root, 'cursors'))
      agent.nativeTraceCopyStoreInstance = new NativeTraceCopyStore(join(root, 'copies'))
      const handler = agent as never as { handleGetWorkerTrace(p: unknown): Promise<unknown> }
      await expect(handler.handleGetWorkerTrace({ worker_id: 'w-system' }))
        .rejects.toBeInstanceOf(WorkerHasNoIncarnationError)
      await expect(handler.handleGetWorkerTrace({ worker_id: 'w-system', seq: 1 }))
        .rejects.toBeInstanceOf(WorkerHasNoIncarnationError)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('worker 不存在 → 抛明确错误,而不是返回空时间线', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'rpc-trace-missing-'))
    try {
      const agent = buildAgent({
        ledger: { findWorker: async () => undefined },
        harness: { readWorkerEvents: async () => [] },
      }) as unknown as Record<string, unknown>
      const { TraceCursorStore } = await import('../../src/workers/trace/cursor-store.js')
      const { NativeTraceCopyStore } = await import('../../src/workers/trace/native-copy.js')
      agent.traceCursorStoreInstance = new TraceCursorStore(join(root, 'cursors'))
      agent.nativeTraceCopyStoreInstance = new NativeTraceCopyStore(join(root, 'copies'))
      await expect((agent as never as { handleGetWorkerTrace(p: unknown): Promise<unknown> }).handleGetWorkerTrace({ worker_id: 'w-missing', seq: 1 })).rejects.toThrow(/w-missing/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('worker 直接 subagent 读模型（§10.3）', () => {
  const child = {
    subagent_id: 'child-1',
    worker_id: 'w-1',
    executor_impl: 'builtin' as const,
    type: 'code_writer',
    name: '代码助手',
    task: '实现观察接口',
    status: 'completed' as const,
    started_at: '2026-08-22T00:00:00.000Z',
    ended_at: '2026-08-22T00:01:00.000Z',
  }

  const subagentFingerprint = (subagent: { executor_impl: string; subagent_id: string; started_at?: string }): string => createHash('sha256')
    .update(JSON.stringify({
      executor_impl: subagent.executor_impl,
      subagent_id: subagent.subagent_id,
      started_at: subagent.started_at ?? '',
    }))
    .digest('hex')
    .slice(0, 32)

  async function agentWithChild(childSummary = child) {
    const root = await fs.mkdtemp(join(tmpdir(), 'rpc-subagent-'))
    const traceEvents = [
      { ts: '2026-08-22T00:00:01.000Z', kind: 'message' as const, role: 'assistant' as const, summary: '第一条记录', source_offset: 0 },
    ]
    const traceCalls: Array<{ workerId: string; subagentId: string; offset: number }> = []
    let liveAvailable = true
    const agent = buildAgent({
      harness: {
        listWorkerSubagents: async (workerId: string) => workerId === 'w-1' && liveAvailable ? [childSummary] : [],
        getWorkerSubagent: async (workerId: string, subagentId: string) => workerId === 'w-1' && liveAvailable && subagentId === childSummary.subagent_id ? childSummary : undefined,
        getWorkerSubagentTrace: async (workerId: string, subagentId: string, cursor?: { offset: number }) => {
          if (!liveAvailable) throw new Error('CLI child source gone')
          traceCalls.push({ workerId, subagentId, offset: cursor?.offset ?? 0 })
          const start = cursor?.offset ?? 0
          return { events: traceEvents.slice(start), nextCursor: { offset: traceEvents.length } }
        },
      },
    }) as unknown as Record<string, unknown>
    const { TraceCursorStore } = await import('../../src/workers/trace/cursor-store.js')
    const { NativeTraceCopyStore } = await import('../../src/workers/trace/native-copy.js')
    const cursorStore = new TraceCursorStore(join(root, 'cursors'))
    const copyStore = new NativeTraceCopyStore(join(root, 'copies'))
    agent.traceCursorStoreInstance = cursorStore
    agent.nativeTraceCopyStoreInstance = copyStore
    return {
      agent: agent as unknown as AgentUnderTest,
      traceEvents,
      traceCalls,
      copyStore,
      setLiveAvailable: (value: boolean) => { liveAvailable = value },
      cleanup: async () => {
        await cursorStore.flush()
        await copyStore.flush()
        await fs.rm(root, { recursive: true, force: true })
      },
    }
  }

  it('列出、读取详情，并拒绝把别的 Worker 的 child 当作自己的 child', async () => {
    const { agent, cleanup } = await agentWithChild()
    try {
      await expect(agent.handleListWorkerSubagents({ worker_id: 'w-1' })).resolves.toEqual({ subagents: [child] })
      await expect(agent.handleGetWorkerSubagentDetail({ worker_id: 'w-1', subagent_id: 'child-1' })).resolves.toEqual({ subagent: child })
      await expect(agent.handleGetWorkerSubagentDetail({ worker_id: 'w-other', subagent_id: 'child-1' })).rejects.toThrow(
        'Worker subagent not found: child-1',
      )
      await expect(agent.handleGetWorkerSubagentTrace({ worker_id: 'w-other', subagent_id: 'child-1' })).rejects.toThrow(
        'Worker subagent not found: child-1',
      )
    } finally {
      await cleanup()
    }
  })

  it('opaque cursor 重放固定同一 child trace 窗口，后续追加不混进旧页', async () => {
    const { agent, traceEvents, traceCalls, cleanup } = await agentWithChild()
    try {
      const first = await agent.handleGetWorkerSubagentTrace({ worker_id: 'w-1', subagent_id: 'child-1' })
      expect(first.events.map((event) => event.summary)).toEqual(['第一条记录'])
      expect(first.events[0]).not.toHaveProperty('source_offset')
      expect(first.events[0]?.source).toBe('native')

      traceEvents.push({ ts: '2026-08-22T00:00:02.000Z', kind: 'message', role: 'assistant', summary: '第二条记录', source_offset: 1 })
      const second = await agent.handleGetWorkerSubagentTrace({ worker_id: 'w-1', subagent_id: 'child-1', cursor: first.next_cursor })
      expect(second.events.map((event) => event.summary)).toEqual(['第二条记录'])

      traceEvents.push({ ts: '2026-08-22T00:00:03.000Z', kind: 'message', role: 'assistant', summary: '第三条记录', source_offset: 2 })
      const replay = await agent.handleGetWorkerSubagentTrace({ worker_id: 'w-1', subagent_id: 'child-1', cursor: first.next_cursor })
      expect(replay.events.map((event) => event.summary)).toEqual(['第二条记录'])
      expect(replay.next_cursor).toBe(second.next_cursor)
      expect(traceCalls.map((call) => call.offset)).toEqual([0, 1, 1])
    } finally {
      await cleanup()
    }
  })

  it('CLI 原生记录轮转后，仍从同一 Worker 的脱敏副本列出 child、读取详情和分页 trace', async () => {
    const { agent, copyStore, setLiveAvailable, cleanup } = await agentWithChild()
    try {
      const fingerprint = subagentFingerprint(child)
      await copyStore.completeSubagentCapture(
        'w-1',
        'inc-1',
        child,
        fingerprint,
        [{
          ts: '2026-08-22T00:00:01.000Z', kind: 'message', role: 'assistant',
          summary: 'secret-result', detail: { content: 'secret-result' }, source_offset: 0,
        }],
        1,
        (text) => text.replaceAll('secret', '[redacted]'),
      )
      setLiveAvailable(false)

      await expect(agent.handleListWorkerSubagents({ worker_id: 'w-1' })).resolves.toEqual({ subagents: [child] })
      await expect(agent.handleGetWorkerSubagentDetail({ worker_id: 'w-1', subagent_id: 'child-1' })).resolves.toEqual({ subagent: child })
      const trace = await agent.handleGetWorkerSubagentTrace({ worker_id: 'w-1', subagent_id: 'child-1' })
      expect(trace.events).toMatchObject([{ summary: '[redacted]-result', detail: { content: '[redacted]-result' }, source: 'native' }])
      expect(trace.events[0]).not.toHaveProperty('source_offset')
      expect(trace.unavailable_reason).toContain('agent-owned child copy')
    } finally {
      await cleanup()
    }
  })

  it('终态 child 的副本尚未完成时保留详情，并如实报告 trace 不可用', async () => {
    const { agent, copyStore, setLiveAvailable, cleanup } = await agentWithChild()
    try {
      await copyStore.beginSubagentCapture('w-1', 'inc-1', child, subagentFingerprint(child), (text) => text)
      setLiveAvailable(false)

      await expect(agent.handleGetWorkerSubagentDetail({ worker_id: 'w-1', subagent_id: 'child-1' })).resolves.toEqual({ subagent: child })
      await expect(agent.handleGetWorkerSubagentTrace({ worker_id: 'w-1', subagent_id: 'child-1' })).resolves.toMatchObject({
        events: [], unavailable_reason: expect.stringContaining('before terminal child trace capture'),
      })
    } finally {
      await cleanup()
    }
  })

  it('读取到已恢复的 CLI 原生记录时补齐 pending child 副本，之后可从副本回退', async () => {
    const cliChild = { ...child, executor_impl: 'codex' as const }
    const { agent, copyStore, setLiveAvailable, cleanup } = await agentWithChild(cliChild)
    try {
      const fingerprint = subagentFingerprint(cliChild)
      await copyStore.beginSubagentCapture('w-1', 'inc-1', cliChild, fingerprint, (text) => text)

      await expect(agent.handleGetWorkerSubagentTrace({ worker_id: 'w-1', subagent_id: 'child-1' })).resolves.toMatchObject({
        events: [{ summary: '第一条记录' }],
      })
      await expect(copyStore.readSubagent('w-1', 'child-1', fingerprint)).resolves.toMatchObject({
        parent_incarnation_id: 'inc-1', capture_status: 'complete', events: [{ summary: '第一条记录' }],
      })

      setLiveAvailable(false)
      await expect(agent.handleGetWorkerSubagentTrace({ worker_id: 'w-1', subagent_id: 'child-1' })).resolves.toMatchObject({
        events: [{ summary: '第一条记录', source: 'native' }],
        unavailable_reason: expect.stringContaining('agent-owned child copy'),
      })
    } finally {
      await cleanup()
    }
  })

  it('child 副本读取失败不影响实时 CLI trace', async () => {
    const cliChild = { ...child, executor_impl: 'claude-code' as const }
    const { agent, copyStore, cleanup } = await agentWithChild(cliChild)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      vi.spyOn(copyStore, 'readSubagent').mockRejectedValueOnce(new Error('copy directory unavailable'))

      await expect(agent.handleGetWorkerSubagentTrace({ worker_id: 'w-1', subagent_id: 'child-1' })).resolves.toMatchObject({
        events: [{ summary: '第一条记录', source: 'native' }],
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('child native trace read retry failed'), 'copy directory unavailable')
    } finally {
      warn.mockRestore()
      await cleanup()
    }
  })

  it('原生和 child 副本均不可读时只返回脱敏的不可用原因', async () => {
    const cliChild = { ...child, executor_impl: 'claude-code' as const }
    const { agent, copyStore, setLiveAvailable, cleanup } = await agentWithChild(cliChild)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await copyStore.completeSubagentCapture('w-1', 'inc-1', cliChild, subagentFingerprint(cliChild), [], 0, (text) => text)
      setLiveAvailable(false)
      vi.spyOn(copyStore, 'readSubagent').mockRejectedValueOnce(new Error('/private/host/secret child source failure'))

      await expect(agent.handleGetWorkerSubagentTrace({ worker_id: 'w-1', subagent_id: 'child-1' })).resolves.toMatchObject({
        events: [], unavailable_reason: 'native unavailable; retained child trace copy is unavailable',
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('child native trace read failed'), 'CLI child source gone')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('child trace copy read failed'), '/private/host/secret child source failure')
    } finally {
      warn.mockRestore()
      await cleanup()
    }
  })

  it('父化身终态时保存 CLI child 的脱敏副本', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'terminal-child-copy-'))
    const cliChild = { ...child, executor_impl: 'claude-code' as const, task: 'secret-task' }
    const incarnation = {
      incarnation_id: 'inc-1', seq: 1, impl: 'claude-code' as const, state: 'exited' as const,
      workspace: root, session_ref: 'parent-session', started_at: '2026-08-22T00:00:00.000Z',
    }
    const adapter = {
      listSubagents: async () => [cliChild],
      readSubagentTrace: async () => ({
        events: [{
          ts: '2026-08-22T00:00:01.000Z', kind: 'message' as const, role: 'assistant' as const,
          summary: 'secret-result', detail: { content: 'secret-result' }, source_offset: 0,
        }],
        nextCursor: { offset: 2 },
      }),
    }
    const agent = buildAgent({
      ledger: { findWorker: async () => ({ managerKey: 'test::f1' as ManagerKey, worker: { ...makeLedgerWorker({ workerId: 'w-1' }), incarnations: [incarnation] } }) },
      adapters: new Map([['claude-code', adapter]]),
    }) as unknown as Record<string, unknown>
    const { NativeTraceCopyStore } = await import('../../src/workers/trace/native-copy.js')
    const copyStore = new NativeTraceCopyStore(join(root, 'copies'))
    agent.nativeTraceCopyStoreInstance = copyStore
    agent.knownSecrets = ['secret']
    try {
      await (agent as unknown as { harvestIncarnationNativeTrace(handle: unknown): Promise<void> }).harvestIncarnationNativeTrace({
        worker_id: 'w-1', incarnation_id: 'inc-1', seq: 1, impl: 'claude-code', session_ref: 'parent-session',
      })
      const stored = await copyStore.readSubagent('w-1', cliChild.subagent_id, subagentFingerprint(cliChild))
      expect(stored).toMatchObject({ capture_status: 'complete', next_cursor_offset: 2 })
      expect(JSON.stringify(stored)).not.toContain('secret')
      expect(stored?.events).toMatchObject([{ source_offset: 0 }])
    } finally {
      await copyStore.flush()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('启动恢复会补齐仍在运行的父 Worker 下、已留 pending 标记的终态 CLI child 副本', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'restart-child-copy-'))
    const cliChild = { ...child, executor_impl: 'codex' as const }
    const incarnation = {
      incarnation_id: 'inc-1', seq: 1, impl: 'codex' as const, state: 'running' as const,
      workspace: root, session_ref: 'parent-thread', started_at: '2026-08-22T00:00:00.000Z',
    }
    const adapter = {
      listSubagents: async () => [cliChild],
      readSubagentTrace: async () => ({
        events: [{ ts: '2026-08-22T00:00:01.000Z', kind: 'message' as const, role: 'assistant' as const, summary: 'finished', source_offset: 0 }],
        nextCursor: { offset: 1 },
      }),
    }
    const worker = { ...makeLedgerWorker({ workerId: 'w-1', status: 'running' }), incarnations: [incarnation] }
    const agent = buildAgent({
      ledger: { listAllWorkers: async () => [{ managerKey: 'test::f1' as ManagerKey, worker }] },
      adapters: new Map([['codex', adapter]]),
    }) as unknown as Record<string, unknown>
    const { NativeTraceCopyStore } = await import('../../src/workers/trace/native-copy.js')
    const copyStore = new NativeTraceCopyStore(join(root, 'copies'))
    agent.nativeTraceCopyStoreInstance = copyStore
    agent.knownSecrets = []
    try {
      await copyStore.beginSubagentCapture('w-1', 'inc-1', cliChild, subagentFingerprint(cliChild), (text) => text)
      await (agent as unknown as { recoverTerminalCliSubagentTraces(): Promise<void> }).recoverTerminalCliSubagentTraces()
      await expect(copyStore.readSubagent('w-1', cliChild.subagent_id, subagentFingerprint(cliChild))).resolves.toMatchObject({
        capture_status: 'complete', events: [{ summary: 'finished' }],
      })
    } finally {
      await copyStore.flush()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('启动恢复中一个 Worker 的 child 列表读取失败，不阻断后续 Worker 的补齐', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'restart-child-copy-isolation-'))
    const cliChild = { ...child, worker_id: 'w-2', executor_impl: 'codex' as const }
    const firstIncarnation = {
      incarnation_id: 'inc-1', seq: 1, impl: 'codex' as const, state: 'running' as const,
      workspace: root, session_ref: 'first-thread', started_at: '2026-08-22T00:00:00.000Z',
    }
    const secondIncarnation = {
      incarnation_id: 'inc-2', seq: 1, impl: 'codex' as const, state: 'running' as const,
      workspace: root, session_ref: 'second-thread', started_at: '2026-08-22T00:00:00.000Z',
    }
    const adapter = {
      listSubagents: async (handle: { worker_id: string }) => {
        if (handle.worker_id === 'w-1') throw new Error('app-server unavailable')
        return [cliChild]
      },
      readSubagentTrace: async () => ({
        events: [{ ts: '2026-08-22T00:00:01.000Z', kind: 'message' as const, role: 'assistant' as const, summary: 'finished', source_offset: 0 }],
        nextCursor: { offset: 1 },
      }),
    }
    const agent = buildAgent({
      ledger: {
        listAllWorkers: async () => [
          { managerKey: 'test::f1' as ManagerKey, worker: { ...makeLedgerWorker({ workerId: 'w-1', status: 'running' }), incarnations: [firstIncarnation] } },
          { managerKey: 'test::f2' as ManagerKey, worker: { ...makeLedgerWorker({ workerId: 'w-2', status: 'running' }), incarnations: [secondIncarnation] } },
        ],
      },
      adapters: new Map([['codex', adapter]]),
    }) as unknown as Record<string, unknown>
    const { NativeTraceCopyStore } = await import('../../src/workers/trace/native-copy.js')
    const copyStore = new NativeTraceCopyStore(join(root, 'copies'))
    agent.nativeTraceCopyStoreInstance = copyStore
    agent.knownSecrets = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await (agent as unknown as { recoverTerminalCliSubagentTraces(): Promise<void> }).recoverTerminalCliSubagentTraces()
      await expect(copyStore.readSubagent('w-2', cliChild.subagent_id, subagentFingerprint(cliChild))).resolves.toMatchObject({
        capture_status: 'complete', events: [{ summary: 'finished' }],
      })
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('terminal CLI child trace recovery failed for w-1#1'),
        'app-server unavailable',
      )
    } finally {
      warn.mockRestore()
      await copyStore.flush()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('读模型 handler 的 manager 栈前置门', () => {
  it('未装配 manager 栈时四个读端点都抛明确错误', async () => {
    const agent = buildAgent()
    await expect(agent.handleListWorkersAdmin({})).rejects.toThrow(/Manager stack not initialized/)
    await expect(agent.handleGetWorkerDetail({ worker_id: 'w' })).rejects.toThrow(/Manager stack not initialized/)
    await expect(agent.handleGetWorkerTerminal({ worker_id: 'w', seq: 1 })).rejects.toThrow(
      /Manager stack not initialized/,
    )
    await expect(agent.handleGetWorkerTrace({ worker_id: 'w', seq: 1 })).rejects.toThrow(/Manager stack not initialized/)
    await expect(agent.handleListWorkerSubagents({ worker_id: 'w' })).rejects.toThrow(/Manager stack not initialized/)
    await expect(agent.handleGetWorkerSubagentDetail({ worker_id: 'w', subagent_id: 'child' })).rejects.toThrow(/Manager stack not initialized/)
    await expect(agent.handleGetWorkerSubagentTrace({ worker_id: 'w', subagent_id: 'child' })).rejects.toThrow(/Manager stack not initialized/)
  })
})

describe('manager 读模型 RPC（P6-A §7/§8.4）', () => {
  function buildAgentWithTraceStack(options: {
    traceStore?: Partial<import('../../src/core/trace-store.js').TraceStore>
    stackStoreKeys?: string[]
    running?: Array<{ key: string; lastActiveAtMs?: number }>
    workers?: Array<{ managerKey: string; worker?: ReturnType<typeof makeLedgerWorker> }>
    noStack?: boolean
  }) {
    const agent = Object.create(UnifiedAgent.prototype) as Record<string, unknown>
    agent.agentConfig = { model_config: { powerful: { apikey: 'k', model_id: 'm' } } }
    agent.config = { moduleId: 'test-agent' }
    agent.configAuthenticated = true
    agent.configStale = false
    if (!options.noStack) {
      agent.managerStack = {
        store: { listManagerKeys: async () => options.stackStoreKeys ?? [] },
        ledger: {
          listAllWorkers: async () => (options.workers ?? []).map((w) => ({ managerKey: w.managerKey, worker: w.worker ?? makeLedgerWorker({ workerId: 'w-mock' }) })),
          listWorkers: async (key: string) => (options.workers ?? [])
            .filter((w) => w.managerKey === key)
            .map((w) => w.worker ?? makeLedgerWorker({ workerId: 'w-mock' })),
        },
        registry: { listActiveManagers: () => options.running ?? [] },
      }
    }
    agent.traceStore = options.traceStore ?? {
      listTraceManagerKeys: () => [],
      countManagerEpisodes: () => 0,
      listManagerEpisodes: () => ({ items: [], pagination: { page: 1, page_size: 20, total_items: 0, total_pages: 0 } }),
    }
    return agent as unknown as {
      handleListManagersAdmin(p: unknown): Promise<unknown>
      handleListManagerEpisodesAdmin(p: unknown): Promise<unknown>
    }
  }

  it('list_managers_admin 聚合三源并排序', async () => {
    const agent = buildAgentWithTraceStack({
      stackStoreKeys: ['wechat::sess-a'],
      traceStore: {
        listTraceManagerKeys: () => ['wechat::sess-b'],
        countManagerEpisodes: (key: string) => (key === 'wechat::sess-b' ? 2 : 0),
        listManagerEpisodes: () => ({ items: [{ started_at: '2026-08-01T00:00:00.000Z' }], pagination: { page: 1, page_size: 20, total_items: 1, total_pages: 1 } }),
      },
      running: [{ key: 'wechat::sess-a', lastActiveAtMs: Date.parse('2026-08-03T00:00:00.000Z') }],
      workers: [{ managerKey: 'wechat::sess-a', worker: makeLedgerWorker({ workerId: 'w-a', status: 'running' }) }],
    })
    const result = await agent.handleListManagersAdmin({ pagination: { page: 1, page_size: 20 } }) as { items: Array<{ manager_key: string; active_worker_count: number; recent_activity_summary?: string }> }
    expect(result.items.map((item) => item.manager_key)).toEqual(['wechat::sess-a', 'wechat::sess-b'])
    expect(result.items[0]).toMatchObject({ active_worker_count: 1 })
    expect(result.items[1]).toMatchObject({ active_worker_count: 0 })
  })

  it('manager stack 未装配时返回结构化失败而非空列表', async () => {
    const agent = buildAgentWithTraceStack({ noStack: true })
    await expect(agent.handleListManagersAdmin({})).rejects.toThrow('Manager stack not initialized')
    await expect(agent.handleListManagerEpisodesAdmin({ manager_key: 'wechat::sess-a' })).rejects.toThrow('Manager stack not initialized')
  })

  it('list_manager_episodes_admin 按 exact key 透传 TraceStore 分页', async () => {
    const seen: unknown[] = []
    const agent = buildAgentWithTraceStack({
      traceStore: {
        listTraceManagerKeys: () => [],
        countManagerEpisodes: () => 0,
        listManagerEpisodes: (key: string, pagination: unknown) => {
          seen.push([key, pagination])
          return { items: [{ trace_id: 'ep-1', manager_key: key }], pagination: { page: 2, page_size: 5, total_items: 6, total_pages: 2 } }
        },
      } as never,
    })
    const result = await agent.handleListManagerEpisodesAdmin({ manager_key: 'wechat::sess-a', pagination: { page: 2, page_size: 5 } }) as { items: Array<{ trace_id: string }>; pagination: { page: number } }
    expect(result.items[0].trace_id).toBe('ep-1')
    expect(result.pagination.page).toBe(2)
    expect(seen).toEqual([['wechat::sess-a', { page: 2, page_size: 5 }]])
    await expect(agent.handleListManagerEpisodesAdmin({ manager_key: '' })).rejects.toThrow('manager_key')
  })

  it('worker_event 的 spawn 父 episode 跨分页时返回 causal_parent', async () => {
    const worker = makeLedgerWorker({ workerId: 'w-1', status: 'running' })
    worker.origin.spawned_by_episode = 'ep-parent'
    const child = {
      trace_id: 'ep-child', manager_key: 'wechat::sess-a', started_at: '2026-08-02T00:00:00.000Z', status: 'completed',
      trigger: { type: 'worker_event', summary: 'state', source: 'worker:w-1' }, spans: [], spawned_worker_ids: [],
    }
    const parent = {
      trace_id: 'ep-parent', manager_key: 'wechat::sess-a', started_at: '2026-07-01T00:00:00.000Z', status: 'completed',
      trigger: { type: 'human_message', summary: '人类消息 x1：开始任务' }, spans: [], spawned_worker_ids: ['w-1'],
    }
    const agent = buildAgentWithTraceStack({
      workers: [{ managerKey: 'wechat::sess-a', worker }],
      traceStore: {
        listTraceManagerKeys: () => [], countManagerEpisodes: () => 0,
        listManagerEpisodes: () => ({ items: [child], pagination: { page: 1, page_size: 20, total_items: 21, total_pages: 2 } }),
        getManagerEpisode: (id: string) => id === 'ep-parent' ? parent : undefined,
      } as never,
    })
    const result = await agent.handleListManagerEpisodesAdmin({ manager_key: 'wechat::sess-a' }) as {
      items: Array<{ causal_parent?: { trace_id: string; trigger: { summary: string } } }>
    }
    expect(result.items[0].causal_parent).toMatchObject({ trace_id: 'ep-parent', trigger: { summary: '人类消息 x1：开始任务' } })
  })
})
