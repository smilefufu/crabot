/**
 * manager 栈装配(P5 Task 1)—— `src/manager/bootstrap.ts`。
 *
 * 四条不变量:
 * ① `buildManagerStack` 无 I/O 副作用(不探测子进程、不扫盘、不建目录)——证据强度与残留缺口
 *    见该用例内的注释;
 * ② harness.ts 文件头的四步接线契约成立(空 Map → harness → adapter 拿 handleStateChange →
 *    set 回同一 Map),且 adapter 的状态回调真的能被 harness 收到并落账;
 * ③ `onAsyncError` 经 registry 的 toolFace 工厂端到端接到 worker-tools 的 `query_worker`;
 * ④ `reconcileManagerStack` 对空台账快速返回空三桶。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { PrincipalResolverDeps } from '../../src/manager/principal.js'
import { buildManagerStack, reconcileManagerStack, type BootstrapDeps } from '../../src/manager/bootstrap.js'
import { LedgerStore } from '../../src/workers/harness/ledger-store.js'
import { BuiltinWorkerAdapter } from '../../src/workers/builtin/adapter.js'
import { ClaudeCodeAdapter } from '../../src/workers/claude-code/adapter.js'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter.js'
import { CapabilityNotSupportedError } from '../../src/workers/errors.js'
import { type ManagerKey, type LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import type { WorkerAdapter, WorkerImplId, IncarnationHandle, StateChangeReport, WorkerContractState } from '../../src/workers/types.js'
import type { LLMAdapter, LLMStreamParams } from '../../src/engine/index.js'
import type { ChannelMessage } from '../../src/types.js'
import { CLI_DOMAINS } from '../../src/types.js'
import { createCrabMemoryServer } from '../../src/mcp/crab-memory.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

// ============================================================================
// helpers
// ============================================================================

/** 最小 crab-memory server(照抄 tests/manager/registry.test.ts)。 */
function makeMemoryServer() {
  return createCrabMemoryServer(
    { rpcClient: { call: vi.fn() } as never, moduleId: 'manager-bootstrap-test', getMemoryPort: async () => 19100 },
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
  }
}

/** 最小 crab-messaging 依赖桩(照抄 tests/manager/registry.test.ts)。 */
function makeMessagingDeps() {
  return {
    rpcClient: { call: vi.fn() } as never,
    moduleId: 'manager-bootstrap-test',
    getAdminPort: async () => 19001,
    resolveChannelPort: async () => 19009,
  }
}

function makeChannelMessage(text: string): ChannelMessage {
  return {
    platform_message_id: `pm-${Math.random().toString(36).slice(2)}`,
    session: { session_id: 'sess-boot', channel_id: 'wechat', type: 'private' },
    sender: { platform_user_id: 'u1', platform_display_name: '测试用户' },
    content: { type: 'text', text },
    features: { is_mention_crab: false },
    platform_timestamp: new Date().toISOString(),
  }
}

/** 私聊里的发言者(P7 J:friend 从入站一路带到装配层)。 */
const FRIEND_A = {
  id: 'f-a',
  display_name: '好友 A',
  permission: 'normal' as const,
  channel_identities: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

function groupMessage(text: string): ChannelMessage {
  const m = makeChannelMessage(text)
  return { ...m, session: { ...m.session, type: 'group' } }
}

function silentAdapter(): LLMAdapter {
  return {
    async *stream() {
      yield* chunksFromContent([{ type: 'text', text: '(默认回复)' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
    },
    updateConfig: () => {},
  }
}

/**
 * 三个 adapter 的 `onStateChange` 构造 deps 的完整签名。`report.endReason` 是 adapter 在
 * `transitionExited` 时持有的 `ended_reason` 真值——它必填,所以直接调这个回调模拟 adapter
 * 上报时,`exited` 必须一并带上它,否则模拟出的是真实 adapter 不会产生的"退出但无原因"。
 */
type AdapterStateCallback = (h: IncarnationHandle, s: WorkerContractState, report?: StateChangeReport) => void

/**
 * 读出 adapter 构造时收到的 `onStateChange`——三个 adapter 都把构造 deps 存成私有字段
 * `deps`,这里刻意穿透私有性:本用例要验证的正是"构造时传进去的那个引用是不是 harness 的
 * handleStateChange",没有别的观测口。
 */
function capturedOnStateChange(
  adapter: WorkerAdapter | undefined,
): AdapterStateCallback | undefined {
  return (adapter as unknown as { deps?: { onStateChange?: AdapterStateCallback } })?.deps?.onStateChange
}

function makeLedgerWorker(p: {
  workerId: string
  impl: WorkerImplId
  spawnedBySession: ManagerKey
}): LedgerWorker {
  return {
    worker_id: p.workerId,
    manager_key: p.spawnedBySession,
    task: { id: p.workerId, title: 't', status: 'running', created_at: '2026-01-01T00:00:00.000Z' },
    origin: { trigger_type: 'message' },
    report_to: { channel_id: 'wechat', session_id: 'sess-boot' },
    incarnations: [
      {
        seq: 1,
        impl: p.impl,
        state: 'running',
        workspace: '/tmp/ws-not-used',
        session_ref: `${p.workerId}-ref`,
        started_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

async function waitUntil(cond: () => Promise<boolean> | boolean, timeoutMs = 4000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitUntil timed out')
}

describe('manager bootstrap（P5 Task 1）', () => {
  let tmpRoot: string
  /** 刻意指向一个不存在的子目录:任何"顺手建目录"的 I/O 都会在盘上留下痕迹被用例抓住。 */
  let dataRoot: string
  const managerKeyFor = (key: ManagerKey): ManagerKey => key

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(join(tmpdir(), 'manager-bootstrap-'))
    dataRoot = join(tmpRoot, 'data-root-not-created-yet')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  function makeDeps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
    return {
      dataRoot,
      now: () => new Date().toISOString(),
      managerAdapter: () => silentAdapter(),
      managerModel: () => 'test-manager-model',
      messagingDeps: makeMessagingDeps(),
      memoryServerFor: () => makeMemoryServer(),
      callAdmin: async () => ({}) as never,
      principalResolver: makePrincipalResolver(),
      ...overrides,
    }
  }

  // --- ① 无 I/O 副作用 ---

  it('buildManagerStack 不触发任何子进程探测 / 台账扫描 / 文件系统写读，盘上不留痕迹', async () => {
    const detectSpies = [
      vi.spyOn(BuiltinWorkerAdapter.prototype, 'detect'),
      vi.spyOn(ClaudeCodeAdapter.prototype, 'detect'),
      vi.spyOn(CodexWorkerAdapter.prototype, 'detect'),
    ]
    const scanOrphansSpy = vi.spyOn(BuiltinWorkerAdapter, 'scanOrphans')
    const ledgerSpies = [
      vi.spyOn(LedgerStore.prototype, 'init'),
      vi.spyOn(LedgerStore.prototype, 'listAllWorkers'),
      vi.spyOn(LedgerStore.prototype, 'findWorker'),
    ]
    // 这里曾经还有一组 `vi.spyOn(fs, 'mkdir' | 'readdir' | …)`(fs.promises 上的八个方法),
    // **已删**:它拦不住被测代码。生产侧一律 `import * as fs from 'node:fs/promises'`——ESM
    // 命名空间导入的绑定在模块求值时就固化了,事后 patch `require('fs').promises` 的属性对它
    // 无效;而且那组 spy 也没覆盖 `appendFile` / `fs.watch` / `child_process`,即使拦得住也不
    // 是"零 I/O"的充分条件。留着只会给人虚假安全感。
    //
    // **真正兜住"零 I/O"结论的是下面两条**:
    // (a) 行为口的 spy —— detect / scanOrphans / LedgerStore.{init,listAllWorkers,findWorker}
    //     是这套栈里所有子进程探测与扫盘的**入口**,零调用即没有从这几个口子出去过;
    // (b) 盘上自证 —— `dataRoot` 整棵子树在装配后仍是 ENOENT,任何一次顺手的建目录/写文件
    //     都会留下痕迹。
    // 残留缺口(如实记):对 `dataRoot` **之外**已存在文件的纯读取,这两条都看不见。评审
    // (review-p5-task12.md)按逐个通读 9 个构造函数补上了这一段。

    const stack = buildManagerStack(makeDeps())

    for (const spy of detectSpies) expect(spy).not.toHaveBeenCalled()
    expect(scanOrphansSpy).not.toHaveBeenCalled()
    for (const spy of ledgerSpies) expect(spy).not.toHaveBeenCalled()

    vi.restoreAllMocks()

    // 盘上自证:dataRoot 整棵子树都还不存在。
    await expect(fs.access(dataRoot)).rejects.toMatchObject({ code: 'ENOENT' })

    // 装配结果本身仍然是完整的
    expect(stack.adapters.size).toBe(3)
    expect([...stack.adapters.keys()].sort()).toEqual(['builtin', 'claude-code', 'codex'])
  })

  it('capabilityBundle 只在 harness 生命周期中调用，buildManagerStack 保持零 I/O 装配并透传工厂', async () => {
    const capabilityBundle = vi.fn(async () => ({ skills: [], mcp_servers: [] }))
    const stack = buildManagerStack(makeDeps({ capabilityBundle }))
    expect(capabilityBundle).not.toHaveBeenCalled()
    expect((stack.harness as unknown as { deps: HarnessDeps }).deps.capabilityBundle).toBe(capabilityBundle)
  })

  // --- ② 四步接线契约 ---

  it('四步接线契约成立：三个 adapter 都拿到同一个 harness.handleStateChange，回调能落账；harness 看得到构造后才 set 进 Map 的 adapter', async () => {
    const stack = buildManagerStack(makeDeps())

    // step 3：构造 adapter 时传的就是 harness 那个绑定好 this 的箭头函数字段本身
    for (const impl of ['builtin', 'claude-code', 'codex'] as const) {
      expect(capturedOnStateChange(stack.adapters.get(impl)), `${impl} 的 onStateChange`).toBe(
        stack.harness.handleStateChange,
      )
    }

    // step 1/2/4：走 adapter 手里那份回调引用，验证 harness 真的收到了并落账
    const managerKey = 'wechat::sess-boot' as ManagerKey
    await stack.ledger.upsertWorker(managerKey, 'w-builtin-1', () =>
      makeLedgerWorker({ workerId: 'w-builtin-1', impl: 'builtin', spawnedBySession: 'wechat::sess-boot' as ManagerKey }),
    )

    // onEvent 出口把 harness 事件路由给监护 manager，是 fire-and-forget：这里把返回的
    // promise 捞出来，既顺带验证接线，也保证用例收尾前把它们 await 干净（否则会漏进
    // afterEach 的清理，和 rm 打架）。
    const routeSpy = vi.spyOn(stack.registry, 'routeWorkerEvent')

    const onStateChange = capturedOnStateChange(stack.adapters.get('builtin'))
    expect(onStateChange).toBeDefined()
    // report.endReason='completed' 复刻真实 adapter:transitionExited 的 ended_reason 是必填形参,
    // 化身自然结束(非 kill)时三个实现给的都是 'completed'。
    onStateChange!({ worker_id: 'w-builtin-1', seq: 1, impl: 'builtin', session_ref: 'w-builtin-1-ref' }, 'exited', { endReason: 'completed' })

    await waitUntil(async () => (await stack.ledger.findWorker('w-builtin-1'))?.worker.task.status === 'completed')
    const after = await stack.ledger.findWorker('w-builtin-1')
    expect(after?.worker.incarnations[0].state).toBe('exited')

    // step 4 的另一面：harness 按需从同一个底层 Map 取 adapter——codex 是构造 harness 之后才
    // set 进去的，能命中它自己的 capabilities().fork===false 分支，就证明 Map 引用是共享的
    // （若没共享，抛的会是 "no adapter registered for impl 'codex'"）。
    await stack.ledger.upsertWorker(managerKey, 'w-codex-1', () =>
      makeLedgerWorker({ workerId: 'w-codex-1', impl: 'codex', spawnedBySession: 'wechat::sess-boot' as ManagerKey }),
    )
    await expect(stack.harness.queryWorker('w-codex-1', '进展如何？')).rejects.toBeInstanceOf(CapabilityNotSupportedError)

    // onEvent → registry.routeWorkerEvent 确实接上了（state_changed 与 query_failed 各一条）
    await waitUntil(() => routeSpy.mock.calls.length >= 2)
    expect(routeSpy.mock.calls.map(([e]) => e.kind)).toEqual(['state_changed', 'query_failed'])
    await Promise.allSettled(routeSpy.mock.results.map((r) => r.value as Promise<unknown>))
  })

  // --- ③ onAsyncError 端到端 ---

  it('known-ID authorization happens before query_worker fire-and-forget: an unknown worker returns an error and no async wake is injected', async () => {
    let triggered = false
    const managerLLM: LLMAdapter = {
      async *stream(params: LLMStreamParams) {
        if (!triggered) {
          triggered = true
          // 从真实 LLMStreamParams.tools 里取生产链路上真正会喂给 LLM 的那个 query_worker
          const queryWorkerTool = params.tools.find((t) => t.name === 'query_worker')
          expect(queryWorkerTool).toBeDefined()
          const result = await queryWorkerTool!.call({ worker_id: 'w-not-in-ledger', question: '进展如何？' }, {} as never)
          // Authorization completes before a fire-and-forget fork can begin.
          expect(result.isError).toBe(true)
        }
        yield* chunksFromContent([{ type: 'text', text: '收到' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
      },
      updateConfig: () => {},
    }

    const stack = buildManagerStack(makeDeps({ managerAdapter: () => managerLLM }))
    const key = 'wechat::sess-boot' as ManagerKey
    const loop = stack.registry.getOrCreate(key)
    const enqueueSpy = vi.spyOn(loop, 'enqueueDuringEpisode')

    const result = await stack.registry.routeHumanMessages('wechat', 'sess-boot', [makeChannelMessage('侧问一下 worker')])

    expect(result.outcome).toBe('completed')
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  // --- ④ 空台账对账 ---


  // --- ⑤ 发起人身份 → 记忆可见范围（P7 J Task 2） ---

  /**
   * 这一组钉的是**语义**，不是接线：让真实 manager 工具面上的 `search_memory` 真的跑一次，
   * 看落到 memory 模块的那次 RPC 里，可见范围到底是谁的。
   *
   * 变异验证（已实跑）：
   *   - `memoryContextFor` 忽略解析结果、恒返回 `{visibility:'public', scopes:[]}`
   *     → 两条用例都挂（`min_visibility` 变 public、`accessible_scopes` 消失）；
   *   - `applyGroupScopeFallback` 去掉群聊空 scopes 收敛 → 第二条挂（群聊读得到全部内容）。
   */
  /** 只调一次 search_memory 就收工的 manager 脚本。 */
  function searchMemoryScript(): LLMAdapter {
    let done = false
    return {
      async *stream(params: LLMStreamParams) {
        if (!done) {
          done = true
          const tool = params.tools.find((t) => t.name === 'mcp__crab-memory__search_memory')
          expect(tool, 'manager 工具面里应当有 crab-memory 的 search_memory').toBeDefined()
          await tool!.call({ query: '上次说的那件事', level: 'short_term', limit: 5 }, {} as never)
        }
        yield* chunksFromContent([{ type: 'text', text: '好的' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
      },
      updateConfig: () => {},
    }
  }

  function makeStackWithPrincipal(p: {
    memoryScopes: string[]
    sessionType: 'private' | 'group'
  }): { stack: ReturnType<typeof buildManagerStack>; memoryCalls: Array<{ method: string; params: Record<string, unknown> }> } {
    const memoryCalls: Array<{ method: string; params: Record<string, unknown> }> = []
    const stack = buildManagerStack(
      makeDeps({
        managerAdapter: () => searchMemoryScript(),
        principalResolver: {
          ...makePrincipalResolver(),
          resolvePermissions: async () => ({
            tool_access: {
              memory: true, messaging: true, task: true, mcp_skill: true,
              file_io: true, browser: true, shell: true, remote_exec: false, desktop: false,
            },
            cli_access: Object.fromEntries(CLI_DOMAINS.map((d) => [d, 'none'])) as never,
            storage: null,
            memory_scopes: p.memoryScopes,
          }),
        },
        memoryServerFor: (ctx) =>
          createCrabMemoryServer(
            {
              rpcClient: {
                call: async (_port: number, method: string, params: Record<string, unknown>) => {
                  memoryCalls.push({ method, params })
                  return { results: [] }
                },
              } as never,
              moduleId: 'manager-bootstrap-test',
              getMemoryPort: async () => 19100,
            },
            ctx,
          ),
      }),
    )
    return { stack, memoryCalls }
  }

  it('这个 friend 的 memory_scopes 真的决定了 manager 读记忆时看得到什么', async () => {
    const { stack, memoryCalls } = makeStackWithPrincipal({ memoryScopes: ['team-x'], sessionType: 'private' })

    await stack.registry.routeHumanMessages('wechat', 'sess-boot', [makeChannelMessage('查一下上次那件事')], FRIEND_A)

    const search = memoryCalls.find((c) => c.method === 'search_short_term')
    expect(search, '真实工具面上的 search_memory 应当打到 memory 模块').toBeDefined()
    // 可见范围就是这个 friend 的 scopes，不是"全公开"
    expect(search!.params.accessible_scopes).toEqual(['team-x'])
    expect(search!.params.min_visibility).toBe('internal')
  })

  it('群聊里 friend 没配 scopes → 可见范围收敛到本群，读不到别的群的内容', async () => {
    const { stack, memoryCalls } = makeStackWithPrincipal({ memoryScopes: [], sessionType: 'group' })

    await stack.registry.routeHumanMessages('wechat', 'sess-boot', [groupMessage('查一下')], FRIEND_A)

    const search = memoryCalls.find((c) => c.method === 'search_short_term')
    expect(search!.params.accessible_scopes).toEqual(['sess-boot'])
  })

  it('身份解析不出来时退回既有那一档（public / 无 scope 过滤），不静默收紧也不静默放宽', async () => {
    const memoryCalls: Array<{ method: string; params: Record<string, unknown> }> = []
    const stack = buildManagerStack(
      makeDeps({
        managerAdapter: () => searchMemoryScript(),
        memoryServerFor: (ctx) =>
          createCrabMemoryServer(
            {
              rpcClient: {
                call: async (_p: number, method: string, params: Record<string, unknown>) => {
                  memoryCalls.push({ method, params })
                  return { results: [] }
                },
              } as never,
              moduleId: 'manager-bootstrap-test',
              getMemoryPort: async () => 19100,
            },
            ctx,
          ),
      }),
    )

    // 没有人类消息 → 身份从未解析过（worker 事件唤醒同理）
    await stack.registry.routeHumanMessages('wechat', 'sess-boot', [makeChannelMessage('hi')])

    const search = memoryCalls.find((c) => c.method === 'search_short_term')
    // 解析不出 friend 时会退到 session 级 scopes（[sessionId]），仍然是 internal，
    // 不会退回 public——"未接线"与"解析失败"的兜底档在这里是同一档。
    expect(search!.params.min_visibility).toBe('internal')
    expect(search!.params.accessible_scopes).toEqual(['sess-boot'])
  })


  // --- ⑥ 发起人身份 → origin.creator_friend_id（P7 J Task 2） ---

  /** 只在第一次 stream 时调一次 spawn_worker，之后一律沉默（后续唤醒不会再派活）。 */
  function spawnOnce(): LLMAdapter {
    let done = false
    return {
      async *stream(params: LLMStreamParams) {
        if (!done) {
          done = true
          const tool = params.tools.find((t) => t.name === 'spawn_worker')
          expect(tool).toBeDefined()
          await tool!.call({ title: '去查一下', prompt: '查资料' }, {} as never)
        }
        yield* chunksFromContent([{ type: 'text', text: '好' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
      },
      updateConfig: () => {},
    }
  }

  function silentManager(): LLMAdapter {
    return {
      async *stream() {
        yield* chunksFromContent([{ type: 'text', text: '好' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
      },
      updateConfig: () => {},
    }
  }

  /** 让 spawn 失败后的 fire-and-forget 台账写入落定，避免与 afterEach 的 rm 抢。 */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 80))

  it('人类消息派出的 worker，origin.creator_friend_id 记的是**本批消息的发言者**', async () => {
    const script: LLMAdapter = spawnOnce()
    const stack = buildManagerStack(makeDeps({ managerAdapter: () => script }))

    await stack.registry.routeHumanMessages('wechat', 'sess-boot', [makeChannelMessage('帮我查个东西')], FRIEND_A)
    await settle()

    const all = await stack.ledger.listAllWorkers()
    expect(all).toHaveLength(1)
    // J 的硬验收：worker 以谁的名义执行，决定它的权限模板（§8.2）。
    expect(all[0].worker.origin.creator_friend_id).toBe('f-a')
    expect(all[0].worker.origin.trigger_type).toBe('message')
    expect(all[0].worker.manager_key).toBe('wechat::sess-boot')
    expect(all[0].managerKey).toBe('wechat::sess-boot')
  })

  it('worker 事件唤醒的 episode 里没人在说话 → 不拿缓存里上一次的发言者冒充', async () => {
    let script: LLMAdapter = silentManager()
    const stack = buildManagerStack(makeDeps({ managerAdapter: () => script }))
    const key = 'wechat::sess-boot' as ManagerKey

    // ① f-a 先说一句（manager 沉默，不派活）——缓存里因此留着 f-a 的身份
    await stack.registry.routeHumanMessages('wechat', 'sess-boot', [makeChannelMessage('只是聊聊')], FRIEND_A)
    expect(await stack.ledger.listAllWorkers()).toHaveLength(0)

    // ② 手工种一条 worker，模拟"更早派出去的活"
    await stack.ledger.upsertWorker(key, 'w-seeded', () =>
      makeLedgerWorker({ workerId: 'w-seeded', impl: 'builtin', spawnedBySession: key }),
    )

    // ③ 这条 worker 的事件唤醒同一个 manager，它在这一轮派了个新 worker
    script = spawnOnce()
    await stack.registry.routeWorkerEvent({ ts: '2026-01-01T00:00:00.000Z', kind: 'state_changed', worker_id: 'w-seeded', seq: 1 })
    await settle()

    const spawnedByEvent = (await stack.ledger.listAllWorkers()).filter((w) => w.worker.worker_id !== 'w-seeded')
    expect(spawnedByEvent).toHaveLength(1)
    // 缓存里还留着 f-a，但这一轮不是 f-a 在说话——记成 f-a 就是把 worker 挂到错的人名下。
    expect(spawnedByEvent[0].worker.origin.creator_friend_id).toBeUndefined()
    // worker 事件继续归原会话；没有新的 human wake 时也不继承 f-a 的权限身份。
    expect(spawnedByEvent[0].managerKey).toBe(key)
  })

  it('场景画像与该渠道的 @handle 真的出现在 manager 的 system prompt 里（5b + 5d）', async () => {
    const systemPrompts: string[] = []
    const stack = buildManagerStack(
      makeDeps({
        managerAdapter: () => ({
          async *stream(params: LLMStreamParams) {
            systemPrompts.push(params.systemPrompt)
            yield* chunksFromContent([{ type: 'text', text: '好' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
          },
          updateConfig: () => {},
        }),
        principalResolver: {
          ...makePrincipalResolver(),
          sceneProfile: async () => ({
            label: 'friend:f-a',
            content: '喜欢简短回答，讨厌寒暄',
            source: { scene: { type: 'friend', friend_id: 'f-a' } },
          }),
          crabSelfHandle: (channelId) => (channelId === 'wechat' ? '@crabot_wx' : undefined),
        },
      }),
    )

    await stack.registry.routeHumanMessages('wechat', 'sess-boot', [makeChannelMessage('在吗')], FRIEND_A)

    expect(systemPrompts).toHaveLength(1)
    // 档案段真的进了 prompt —— 不是"某个 thunk 返回了一个字符串"
    expect(systemPrompts[0]).toContain('## 对话对象档案')
    expect(systemPrompts[0]).toContain('喜欢简短回答，讨厌寒暄')
    expect(systemPrompts[0]).toContain('@crabot_wx')
  })

  it('reconcileManagerStack 对空台账快速返回空三桶，且不探测任何 adapter', async () => {
    const stack = buildManagerStack(makeDeps())

    const detectSpies = [
      vi.spyOn(BuiltinWorkerAdapter.prototype, 'detect'),
      vi.spyOn(ClaudeCodeAdapter.prototype, 'detect'),
      vi.spyOn(CodexWorkerAdapter.prototype, 'detect'),
    ]
    const stateSpies = [
      vi.spyOn(BuiltinWorkerAdapter.prototype, 'state'),
      vi.spyOn(ClaudeCodeAdapter.prototype, 'state'),
      vi.spyOn(CodexWorkerAdapter.prototype, 'state'),
    ]

    const startedAt = Date.now()
    const report = await reconcileManagerStack(stack)
    const elapsed = Date.now() - startedAt

    expect(report).toEqual({ revived: [], failed: [], unchanged: [] })
    expect(elapsed).toBeLessThan(1000)
    for (const spy of detectSpies) expect(spy).not.toHaveBeenCalled()
    for (const spy of stateSpies) expect(spy).not.toHaveBeenCalled()
  })
})
