/**
 * manager 栈装配(P5 Task 1)—— `src/manager/bootstrap.ts`。
 *
 * 四条不变量:
 * ① `buildManagerStack` 无 I/O 副作用(不探测子进程、不扫盘、不建目录);
 * ② harness.ts 文件头的四步接线契约成立(空 Map → harness → adapter 拿 handleStateChange →
 *    set 回同一 Map),且 adapter 的状态回调真的能被 harness 收到并落账;
 * ③ `onAsyncError` 经 registry 的 toolFace 工厂端到端接到 worker-tools 的 `query_worker`;
 * ④ `reconcileManagerStack` 对空台账快速返回空三桶。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { buildManagerStack, reconcileManagerStack, type BootstrapDeps } from '../../src/manager/bootstrap.js'
import { LedgerStore } from '../../src/workers/harness/ledger-store.js'
import { BuiltinWorkerAdapter } from '../../src/workers/builtin/adapter.js'
import { ClaudeCodeAdapter } from '../../src/workers/claude-code/adapter.js'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter.js'
import { CapabilityNotSupportedError } from '../../src/workers/errors.js'
import { dialogObjectIdForPrivate, type DialogObjectId, type LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import type { WorkerAdapter, WorkerImplId, IncarnationHandle, WorkerContractState } from '../../src/workers/types.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { LLMAdapter, LLMStreamParams } from '../../src/engine/index.js'
import type { ChannelMessage } from '../../src/types.js'
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

function silentAdapter(): LLMAdapter {
  return {
    async *stream() {
      yield* chunksFromContent([{ type: 'text', text: '(默认回复)' }], 'end_turn', { inputTokens: 10, outputTokens: 5 })
    },
    updateConfig: () => {},
  }
}

/**
 * 读出 adapter 构造时收到的 `onStateChange`——三个 adapter 都把构造 deps 存成私有字段
 * `deps`,这里刻意穿透私有性:本用例要验证的正是"构造时传进去的那个引用是不是 harness 的
 * handleStateChange",没有别的观测口。
 */
function capturedOnStateChange(
  adapter: WorkerAdapter | undefined,
): ((h: IncarnationHandle, s: WorkerContractState) => void) | undefined {
  return (adapter as unknown as { deps?: { onStateChange?: (h: IncarnationHandle, s: WorkerContractState) => void } })
    ?.deps?.onStateChange
}

function makeLedgerWorker(p: {
  workerId: string
  impl: WorkerImplId
  spawnedBySession: ManagerKey
}): LedgerWorker {
  return {
    worker_id: p.workerId,
    task: { id: p.workerId, title: 't', status: 'running', created_at: '2026-01-01T00:00:00.000Z' },
    origin: { spawned_by_session: p.spawnedBySession, trigger_type: 'message' },
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

const FS_MUTATING_OR_SCANNING: ReadonlyArray<'mkdir' | 'readdir' | 'readFile' | 'writeFile' | 'access' | 'stat' | 'rename' | 'rm'> =
  ['mkdir', 'readdir', 'readFile', 'writeFile', 'access', 'stat', 'rename', 'rm']

describe('manager bootstrap（P5 Task 1）', () => {
  let tmpRoot: string
  /** 刻意指向一个不存在的子目录:任何"顺手建目录"的 I/O 都会在盘上留下痕迹被用例抓住。 */
  let dataRoot: string
  const dialogObjectIdFor = (key: ManagerKey): DialogObjectId => dialogObjectIdForPrivate(`friend-of-${key}`)

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
      memoryServer: makeMemoryServer(),
      callAdmin: async () => ({}) as never,
      dialogObjectIdFor,
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
    // 直接盯住 fs.promises 本身:比"没报错"强得多——任何一次真实的建目录/扫目录/读写都会被记到。
    const fsSpies = FS_MUTATING_OR_SCANNING.map((name) => vi.spyOn(fs, name))

    const stack = buildManagerStack(makeDeps())

    for (const spy of detectSpies) expect(spy).not.toHaveBeenCalled()
    expect(scanOrphansSpy).not.toHaveBeenCalled()
    for (const spy of ledgerSpies) expect(spy).not.toHaveBeenCalled()
    for (const spy of fsSpies) expect(spy, `fs.${spy.getMockName()} 不应在装配期被调用`).not.toHaveBeenCalled()

    vi.restoreAllMocks()

    // 盘上自证:dataRoot 整棵子树都还不存在。
    await expect(fs.access(dataRoot)).rejects.toMatchObject({ code: 'ENOENT' })

    // 装配结果本身仍然是完整的
    expect(stack.adapters.size).toBe(3)
    expect([...stack.adapters.keys()].sort()).toEqual(['builtin', 'claude-code', 'codex'])
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
    const dialogObjectId = dialogObjectIdForPrivate('friend-wiring')
    await stack.ledger.upsertWorker(dialogObjectId, 'w-builtin-1', () =>
      makeLedgerWorker({ workerId: 'w-builtin-1', impl: 'builtin', spawnedBySession: 'wechat::sess-boot' as ManagerKey }),
    )

    // onEvent 出口把 harness 事件路由给监护 manager，是 fire-and-forget：这里把返回的
    // promise 捞出来，既顺带验证接线，也保证用例收尾前把它们 await 干净（否则会漏进
    // afterEach 的清理，和 rm 打架）。
    const routeSpy = vi.spyOn(stack.registry, 'routeWorkerEvent')

    const onStateChange = capturedOnStateChange(stack.adapters.get('builtin'))
    expect(onStateChange).toBeDefined()
    onStateChange!({ worker_id: 'w-builtin-1', seq: 1, impl: 'builtin', session_ref: 'w-builtin-1-ref' }, 'exited')

    await waitUntil(async () => (await stack.ledger.findWorker('w-builtin-1'))?.worker.task.status === 'completed')
    const after = await stack.ledger.findWorker('w-builtin-1')
    expect(after?.worker.incarnations[0].state).toBe('exited')

    // step 4 的另一面：harness 按需从同一个底层 Map 取 adapter——codex 是构造 harness 之后才
    // set 进去的，能命中它自己的 capabilities().fork===false 分支，就证明 Map 引用是共享的
    // （若没共享，抛的会是 "no adapter registered for impl 'codex'"）。
    await stack.ledger.upsertWorker(dialogObjectId, 'w-codex-1', () =>
      makeLedgerWorker({ workerId: 'w-codex-1', impl: 'codex', spawnedBySession: 'wechat::sess-boot' as ManagerKey }),
    )
    await expect(stack.harness.queryWorker('w-codex-1', '进展如何？')).rejects.toBeInstanceOf(CapabilityNotSupportedError)

    // onEvent → registry.routeWorkerEvent 确实接上了（state_changed 与 query_failed 各一条）
    await waitUntil(() => routeSpy.mock.calls.length >= 2)
    expect(routeSpy.mock.calls.map(([e]) => e.kind)).toEqual(['state_changed', 'query_failed'])
    await Promise.allSettled(routeSpy.mock.results.map((r) => r.value as Promise<unknown>))
  })

  // --- ③ onAsyncError 端到端 ---

  it('onAsyncError 端到端：经 bootstrap 装配的真实工具面调用 query_worker（worker 不存在→游离 promise reject）→ registry 按 key 绑定的回调被触发 → episode 内 enqueueDuringEpisode', async () => {
    let triggered = false
    const managerLLM: LLMAdapter = {
      async *stream(params: LLMStreamParams) {
        if (!triggered) {
          triggered = true
          // 从真实 LLMStreamParams.tools 里取生产链路上真正会喂给 LLM 的那个 query_worker
          const queryWorkerTool = params.tools.find((t) => t.name === 'query_worker')
          expect(queryWorkerTool).toBeDefined()
          const result = await queryWorkerTool!.call({ worker_id: 'w-not-in-ledger', question: '进展如何？' }, {} as never)
          // fire-and-forget：调用本身不因后台失败而报错
          expect(result.isError).toBe(false)
          // 给游离 promise 一个宏任务窗口 reject → .catch() → onAsyncError（此刻 episode 仍在跑）
          await new Promise((resolve) => setTimeout(resolve, 40))
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
    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(enqueueSpy.mock.calls[0][0])).toContain('query_failed')
  })

  // --- ④ 空台账对账 ---

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
