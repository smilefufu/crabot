/**
 * agent 侧五个 v3 RPC handler(P5 Task 4)—— protocol-agent-v3.md §8.2 / §8.3。
 *
 * 手法照 `tests/unified-agent-resume-task.test.ts`:`Object.create(UnifiedAgent.prototype)`
 * 绕过构造函数,只塞 handler 真正会用到的字段(这里是 `managerStack`),直接调私有 handler。
 * 需要断言"语义不变量而不只是参数透传"的两条(trigger_schedule 的路由归属、权限身份落到
 * `origin.creator_friend_id`)另外走**真实** `buildManagerStack` + mock LLM 的端到端路径。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { UnifiedAgent } from '../../src/unified-agent.js'
import type { PrincipalResolverDeps } from '../../src/manager/principal.js'
import { buildManagerStack, type BootstrapDeps, type ManagerStack } from '../../src/manager/bootstrap.js'
import { SYSTEM_TASKS_MANAGER_KEY } from '../../src/manager/registry.js'
import { dialogObjectIdForPrivate, type DialogObjectId, type LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { HarnessEvent } from '../../src/workers/harness/worker-events.js'
import type { LLMAdapter } from '../../src/engine/index.js'
import { createCrabMemoryServer } from '../../src/mcp/crab-memory.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
import type {
  ListWorkersAdminParams,
  ListWorkersAdminResult,
  GetWorkerDetailParams,
  GetWorkerDetailResult,
  ReadWorkerOutputAdminParams,
  ReadWorkerOutputAdminResult,
  GetWorkerTraceParams,
  GetWorkerTraceResult,
} from '../../src/manager/read-model.js'
import type { TriggerScheduleParams, TriggerScheduleResult } from '../../src/unified-agent.js'

// ============================================================================
// helpers
// ============================================================================

/** 被测的五个私有 handler 的公开视图(TS 私有性只在编译期,运行时照常可调)。 */
interface AgentUnderTest {
  managerStack?: unknown
  handleTriggerSchedule(p: TriggerScheduleParams): Promise<TriggerScheduleResult>
  handleListWorkersAdmin(p: ListWorkersAdminParams): Promise<ListWorkersAdminResult>
  handleGetWorkerDetail(p: GetWorkerDetailParams): Promise<GetWorkerDetailResult>
  handleReadWorkerOutputAdmin(p: ReadWorkerOutputAdminParams): Promise<ReadWorkerOutputAdminResult>
  handleGetWorkerTrace(p: GetWorkerTraceParams): Promise<GetWorkerTraceResult>
}

function buildAgent(managerStack?: unknown): AgentUnderTest {
  const agent = Object.create(UnifiedAgent.prototype) as Record<string, unknown>
  agent.config = { moduleId: 'test-agent' }
  if (managerStack !== undefined) agent.managerStack = managerStack
  return agent as unknown as AgentUnderTest
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
    origin: { spawned_by_session: 'wechat::sess-1' as ManagerKey, trigger_type: 'message' },
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
    const agent = buildAgent({ registry: { routeSchedule: (p: unknown) => { calls.push(p); return Promise.resolve() } } })

    await agent.handleTriggerSchedule({
      schedule_id: 'sc-9',
      title: '标题',
      description: '描述',
      target_session: { channel_id: 'wechat', session_id: 'sess-1' },
      creator_friend_id: 'friend-42',
      is_builtin: false,
    })

    expect(calls[0]).toEqual({
      scheduleId: 'sc-9',
      title: '标题',
      description: '描述',
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
// §8.2 端到端:双路由 + 权限身份真的落到 origin.creator_friend_id
// ============================================================================

describe('trigger_schedule 端到端(真实 manager 栈 + mock LLM)', () => {
  let tmpRoot: string
  const dialogObjectIdFor = (key: ManagerKey): DialogObjectId => dialogObjectIdForPrivate(`friend-of-${key}`)

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
    expect(params.origin.spawned_by_session).toBe(SYSTEM_TASKS_MANAGER_KEY)
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
    expect(params.origin.spawned_by_session).toBe('wechat::sess-1')
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
      { dialogObjectId: dialogObjectIdForPrivate('f1'), worker: makeLedgerWorker({ workerId: 'w-1', status: 'running', updatedAt: '2026-01-03T00:00:00.000Z' }) },
      { dialogObjectId: dialogObjectIdForPrivate('f1'), worker: makeLedgerWorker({ workerId: 'w-2', status: 'completed', updatedAt: '2026-01-02T00:00:00.000Z' }) },
      { dialogObjectId: dialogObjectIdForPrivate('f2'), worker: makeLedgerWorker({ workerId: 'w-3', status: 'running', updatedAt: '2026-01-01T00:00:00.000Z' }) },
    ]
    const agent = buildAgent({ ledger: { listAllWorkers: async () => entries } })

    const all = await agent.handleListWorkersAdmin({})
    expect(all.items.map((w) => w.worker_id)).toEqual(['w-1', 'w-2', 'w-3'])
    expect(all.pagination).toEqual({ page: 1, page_size: 20, total_items: 3, total_pages: 1 })

    const running = await agent.handleListWorkersAdmin({ status: 'running' })
    expect(running.items.map((w) => w.worker_id)).toEqual(['w-1', 'w-3'])

    const scoped = await agent.handleListWorkersAdmin({ dialog_object_id: dialogObjectIdForPrivate('f2') })
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
  it('存在 → 返回台账条目本身(剥掉 dialogObjectId 包装)', async () => {
    const worker = makeLedgerWorker({ workerId: 'w-1' })
    const agent = buildAgent({
      ledger: { findWorker: async () => ({ dialogObjectId: dialogObjectIdForPrivate('f1'), worker }) },
    })
    await expect(agent.handleGetWorkerDetail({ worker_id: 'w-1' })).resolves.toEqual({ worker })
  })

  it('不存在 → 抛带 worker_id 的明确错误', async () => {
    const agent = buildAgent({ ledger: { findWorker: async () => undefined } })
    await expect(agent.handleGetWorkerDetail({ worker_id: 'w-missing' })).rejects.toThrow(/w-missing/)
  })
})

describe('read_worker_output_admin(§8.3)', () => {
  it('cursor 字符串 ↔ harness 的 OutputCursor 互转,seq 原样下传', async () => {
    const calls: unknown[][] = []
    const agent = buildAgent({
      harness: {
        readWorkerOutput: async (...args: unknown[]) => {
          calls.push(args)
          return { chunk: 'hello', nextCursor: { offset: 105 } }
        },
      },
    })

    const result = await agent.handleReadWorkerOutputAdmin({ worker_id: 'w-1', seq: 2, cursor: '100' })

    expect(calls[0]).toEqual(['w-1', { offset: 100 }, { seq: 2 }])
    expect(result).toEqual({ chunk: 'hello', next_cursor: '105', eof: false })
  })

  it('无 cursor → 从 0 读起;空 chunk → eof=true(已读到当前末尾)', async () => {
    const calls: unknown[][] = []
    const agent = buildAgent({
      harness: {
        readWorkerOutput: async (...args: unknown[]) => {
          calls.push(args)
          return { chunk: '', nextCursor: { offset: 7 } }
        },
      },
    })

    const result = await agent.handleReadWorkerOutputAdmin({ worker_id: 'w-1', seq: 1 })

    expect(calls[0]).toEqual(['w-1', { offset: 0 }, { seq: 1 }])
    expect(result).toEqual({ chunk: '', next_cursor: '7', eof: true })
  })

  it('harness 抛错(worker/化身不存在)原样冒泡,不吞成空 chunk', async () => {
    const agent = buildAgent({
      harness: {
        readWorkerOutput: async () => {
          throw new Error('no incarnation with seq=9')
        },
      },
    })
    await expect(agent.handleReadWorkerOutputAdmin({ worker_id: 'w-1', seq: 9 })).rejects.toThrow(/seq=9/)
  })
})

describe('get_worker_trace(§8.3 + §10.2)', () => {
  const events: HarnessEvent[] = [
    { ts: '2026-01-01T00:00:00.000Z', kind: 'spawned', worker_id: 'w-1', seq: 1, detail: { impl: 'builtin' } },
    { ts: '2026-01-01T00:00:01.000Z', kind: 'input_sent', worker_id: 'w-1', seq: 1 },
    { ts: '2026-01-01T00:00:02.000Z', kind: 'spawned', worker_id: 'w-1', seq: 2 },
  ]

  /**
   * 台账里必须真有 seq=1/2 两个化身：handler 现在先按台账校验显式给的 seq 存不存在
   * （P5 review 修复第二轮），"化身不存在"与"化身没事件"要可区分。makeLedgerWorker 的
   * `incarnations: []` 缺省对本组用例不成立——有事件却没有对应化身的 worker 在真实台账里
   * 不存在（每个化身至少由 spawn 落一条）。
   */
  const incarnation = (seq: number) => ({
    seq,
    impl: 'builtin' as const,
    state: 'exited' as const,
    workspace: '/tmp/ws-not-used',
    session_ref: `ref-${seq}`,
    started_at: '2026-01-01T00:00:00.000Z',
  })

  function agentWithEvents() {
    return buildAgent({
      ledger: {
        findWorker: async () => ({
          dialogObjectId: dialogObjectIdForPrivate('f1'),
          worker: { ...makeLedgerWorker({ workerId: 'w-1' }), incarnations: [incarnation(1), incarnation(2)] },
        }),
      },
      harness: { readWorkerEvents: async () => events },
    })
  }

  it('第一层(harness 亲历事件流)按 seq 过滤并归一化为 NormalizedTraceEvent', async () => {
    const result = await agentWithEvents().handleGetWorkerTrace({ worker_id: 'w-1', seq: 1 })

    expect(result.events.map((e) => e.ts)).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'])
    expect(result.events.every((e) => e.kind === 'lifecycle')).toBe(true)
    expect(result.events[0].summary).toContain('spawned')
    expect(result.events[0].detail).toEqual({ impl: 'builtin' })
  })

  it('第二层(adapter readTrace 懒解析)本阶段未接线 → unavailable_reason 说明', async () => {
    const result = await agentWithEvents().handleGetWorkerTrace({ worker_id: 'w-1', seq: 1 })
    expect(result.unavailable_reason).toBeTruthy()
    expect(result.unavailable_reason).toContain('readTrace')
  })

  it('cursor 增量读:next_cursor 回位后再读拿到剩余事件,读完为空', async () => {
    const agent = agentWithEvents()
    const first = await agent.handleGetWorkerTrace({ worker_id: 'w-1', seq: 1, cursor: '1' })
    expect(first.events.map((e) => e.ts)).toEqual(['2026-01-01T00:00:01.000Z'])
    expect(first.next_cursor).toBe('2')

    const second = await agent.handleGetWorkerTrace({ worker_id: 'w-1', seq: 1, cursor: first.next_cursor })
    expect(second.events).toEqual([])
    expect(second.next_cursor).toBe('2')
  })

  /**
   * 与 read_worker_output_admin 的 `seq=9 → rejects(/seq=9/)` 对称（见上一个 describe）：
   * 显式给的化身不存在时报错，而不是与"该化身还没有事件"（seq=2 只有 1 条、cursor 读完
   * 返回空——上面两条用例）在返回值上混同。
   */
  it('显式 seq 在化身链里不存在 → 抛错,而不是静默返回空 events', async () => {
    await expect(agentWithEvents().handleGetWorkerTrace({ worker_id: 'w-1', seq: 9 })).rejects.toThrow(/seq=9/)
  })

  it('worker 不存在 → 抛明确错误,而不是返回空时间线', async () => {
    const agent = buildAgent({
      ledger: { findWorker: async () => undefined },
      harness: { readWorkerEvents: async () => [] },
    })
    await expect(agent.handleGetWorkerTrace({ worker_id: 'w-missing', seq: 1 })).rejects.toThrow(/w-missing/)
  })
})

describe('读模型 handler 的 manager 栈前置门', () => {
  it('未装配 manager 栈时四个读端点都抛明确错误', async () => {
    const agent = buildAgent()
    await expect(agent.handleListWorkersAdmin({})).rejects.toThrow(/Manager stack not initialized/)
    await expect(agent.handleGetWorkerDetail({ worker_id: 'w' })).rejects.toThrow(/Manager stack not initialized/)
    await expect(agent.handleReadWorkerOutputAdmin({ worker_id: 'w', seq: 1 })).rejects.toThrow(
      /Manager stack not initialized/,
    )
    await expect(agent.handleGetWorkerTrace({ worker_id: 'w', seq: 1 })).rejects.toThrow(/Manager stack not initialized/)
  })
})
