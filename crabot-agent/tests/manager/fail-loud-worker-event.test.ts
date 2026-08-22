/**
 * worker 事件路径的 fail-loud 兜底 —— `bootstrap.ts` 的 `onEvent` + `BootstrapDeps.reportEpisodeFailure`。
 *
 * ## 事前形态
 *
 * `onEvent` 是 fire-and-forget,原本只 `.catch(console.error)`,且**从不看 outcome**。而
 * `ManagerLoop` 最常见的失败(F1:LLM 挂 / key 过期 / 限流耗尽重试)不抛错,只把
 * `EpisodeResult.outcome` 写成 `failed`。于是"worker 干完了/挂了,但再也没人来汇报"这件事
 * 对人类**完全静默**——agent 还活着、health 还是绿的。
 *
 * ## 手法
 *
 * 真装配(`buildManagerStack`)+ 真 harness 事件(走 adapter 上报口 `harness.handleStateChange`)
 * + 真 `ManagerLoop`;**唯一被替身的是 LLM 和出站 rpcClient**。`reportEpisodeFailure` 接的是
 * 生产同款实现(`UnifiedAgent.prototype.sendBackgroundFailLoud`),所以文案、目标改写、冷却
 * 全都是生产代码在跑,不是测试里另写一份。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { UnifiedAgent } from '../../src/unified-agent.js'
import { buildManagerStack, type BootstrapDeps, type ManagerStack } from '../../src/manager/bootstrap.js'
import type { PrincipalResolverDeps } from '../../src/manager/principal.js'
import type { ManagerKey } from '../../src/manager/types.js'
import { type LedgerWorker } from '../../src/workers/harness/ledger-types.js'
import type { LLMAdapter } from '../../src/engine/index.js'
import { createCrabMemoryServer } from '../../src/mcp/crab-memory.js'

const ADMIN_PORT = 18000
const WECHAT_PORT = 18001

interface RpcCall {
  port: number
  method: string
  params: Record<string, unknown>
}

/** 最小 crab-memory server(照抄 tests/manager/bootstrap.test.ts)。 */
function makeMemoryServer() {
  return createCrabMemoryServer(
    { rpcClient: { call: vi.fn() } as never, moduleId: 'fail-loud-test', getMemoryPort: async () => 19100 },
    { visibility: 'internal', scopes: [], isMasterPrivate: false },
  )
}

/** 身份解析原料的最小桩:一律"解析不出来"。 */
function makePrincipalResolver(): PrincipalResolverDeps {
  return {
    resolvePermissions: async () => null,
    sessionMemoryScopes: async (sessionId) => [sessionId],
    sceneProfile: async () => null,
    crabSelfHandle: () => undefined,
    masterFriendId: async () => undefined,
  }
}

function makeMessagingDeps() {
  return {
    rpcClient: { call: vi.fn() } as never,
    moduleId: 'fail-loud-test',
    getAdminPort: async () => ADMIN_PORT,
    resolveChannelPort: async () => WECHAT_PORT,
  }
}

/** 一调就挂的 manager LLM —— F1 的真实来路(端点抖动 / key 过期 / 限流耗尽)。 */
function brokenLLM(): LLMAdapter {
  return {
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('LLM boom')
    },
    updateConfig: () => {},
  }
}

function makeLedgerWorker(p: { workerId: string; title: string; managerKey: ManagerKey }): LedgerWorker {
  return {
    worker_id: p.workerId,
    manager_key: p.managerKey,
    task: { id: p.workerId, title: p.title, status: 'running', created_at: '2026-01-01T00:00:00.000Z' },
    origin: {
      trigger_type: 'message' },
    report_to: { channel_id: 'wechat', session_id: 'sess-1' },
    incarnations: [
      {
        seq: 1,
        impl: 'builtin',
        state: 'running',
        workspace: '/tmp/ws-not-used',
        session_ref: `${p.workerId}-ref`,
        started_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    updated_at: '2026-01-01T00:00:00.000Z',
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

describe('worker 事件路径的 fail-loud（bootstrap.onEvent → reportEpisodeFailure）', () => {
  let tmpRoot: string
  let rpcCalls: RpcCall[]
  let sendFails: boolean
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(join(tmpdir(), 'fail-loud-worker-'))
    rpcCalls = []
    sendFails = false
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  /**
   * 生产同款的兜底出口:`UnifiedAgent.prototype.sendBackgroundFailLoud` 挂在一个只塞了出站
   * 三件套的实例上(`Object.create` 绕过构造函数,与 tests/manager/rpc-handlers.test.ts 同法)。
   * 文案 / 目标改写 / 冷却因此全是生产代码在跑。
   */
  function makeReporter(): NonNullable<BootstrapDeps['reportEpisodeFailure']> {
    const agent = Object.create(UnifiedAgent.prototype) as Record<string, unknown>
    agent.config = { moduleId: 'fail-loud-test' }
    agent.failLoudSentAt = new Map<string, number>()
    agent.channelPorts = new Map([['wechat', WECHAT_PORT]])
    agent.adminPort = ADMIN_PORT
    agent.rpcClient = {
      call: async (port: number, method: string, params: Record<string, unknown>) => {
        rpcCalls.push({ port, method, params })
        if (sendFails) throw new Error('channel 也挂了')
        return {}
      },
      resolve: async () => [],
    }
    const typed = agent as unknown as {
      sendBackgroundFailLoud(
        target: { channel_id: string; session_id: string },
        subject: string,
        failure: unknown,
      ): Promise<void>
    }
    return (report) => {
      void typed.sendBackgroundFailLoud(report.target, report.subject, report.failure)
    }
  }

  function makeStack(overrides: Partial<BootstrapDeps> = {}): ManagerStack {
    const deps: BootstrapDeps = {
      dataRoot: join(tmpRoot, 'data'),
      now: () => new Date().toISOString(),
      managerAdapter: () => brokenLLM(),
      managerModel: () => 'test-manager-model',
      messagingDeps: makeMessagingDeps(),
      memoryServerFor: () => makeMemoryServer(),
      callAdmin: async () => ({}) as never,
      principalResolver: makePrincipalResolver(),
      reportEpisodeFailure: makeReporter(),
      ...overrides,
    }
    return buildManagerStack(deps)
  }

  /** 台账里种一条 worker,再从 adapter 上报口推一个 exited —— 走的是生产的 onEvent 接线。 */
  async function seedAndFireEvent(stack: ManagerStack, p: { workerId: string; title: string }): Promise<void> {
    await stack.ledger.upsertWorker('wechat::sess-1' as ManagerKey, p.workerId, () =>
      makeLedgerWorker({ workerId: p.workerId, title: p.title, managerKey: 'wechat::sess-1' as ManagerKey }),
    )
    stack.harness.handleStateChange(
      { worker_id: p.workerId, seq: 1, impl: 'builtin', session_ref: `${p.workerId}-ref` },
      'exited',
      { endReason: 'completed' },
    )
  }

  function sentText(): string | undefined {
    const sent = rpcCalls.find((c) => c.method === 'send_message')
    return (sent?.params.content as { text: string } | undefined)?.text
  }

  it('LLM 挂掉（F1：episode 正常 resolve、outcome=failed）→ 监护会话收到兜底消息，文案是非人类触发变体', async () => {
    const stack = makeStack()
    await seedAndFireEvent(stack, { workerId: 'w-1', title: '整理会议纪要' })

    await waitUntil(() => rpcCalls.some((c) => c.method === 'send_message'))

    const sent = rpcCalls.find((c) => c.method === 'send_message')!
    // 目标 = 该 worker 的监护 manager（origin.manager_key），不是 report_to、不是系统线程
    expect(sent.port).toBe(WECHAT_PORT)
    expect(sent.params.session_id).toBe('sess-1')

    const text = sentText()
    expect(text).toContain('worker「整理会议纪要」的状态更新')
    expect(text).toContain('没跑成')
    // worker 事件不是人在说话：人类那份第二人称文案照搬过来是错的
    expect(text).not.toContain('回不了你')
    expect(text).not.toContain('再发一次')
  })

  it('按 key 冷却仍然生效：同一会话连着两个失败 episode 只发一条', async () => {
    const stack = makeStack()
    await seedAndFireEvent(stack, { workerId: 'w-1', title: '任务甲' })
    await waitUntil(() => rpcCalls.some((c) => c.method === 'send_message'))
    await seedAndFireEvent(stack, { workerId: 'w-2', title: '任务乙' })

    // 第二条事件的 episode 也要跑完，再看有没有多发
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(rpcCalls.filter((c) => c.method === 'send_message')).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('送不出去（目标会话所在 channel 也挂了）只落日志，不抛、不产生 unhandledRejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      sendFails = true
      const stack = makeStack()
      await seedAndFireEvent(stack, { workerId: 'w-1', title: '任务' })

      await waitUntil(() => rpcCalls.some((c) => c.method === 'send_message'))
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(unhandled).toEqual([])
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  /**
   * **两个特性在 `onEvent` 上的交汇点**（只各测各的不够）：
   *
   * - #74 要的是**副作用**：episode 失败 → `reportEpisodeFailure` 通知人类；
   * - 活性巡检要的是**返回值**：把"这次唤醒没被消费"交回 harness，好让它**按退避重试投递**。
   *
   * 失败时两件事必须同时发生。这里用真装配 + 真 `ClaudeCodeAdapter.lastActivityAt`
   * （对 meta 与原生 session 记录做 mtime 探测，不读取 pane）把整条链跑通：
   * 巡检发事件 → 真 `ManagerLoop` 撞上挂掉的 LLM → 落 `outcome='failed'`。
   *
  * 重试带退避且不重复首报，重试只是再触发一次投递（mailbox 自己没有投递者）。
  */
  it('交汇点：巡检发事件 → episode 失败 → 人类收到兜底，且首报不读终端', async () => {
    let clockMs = Date.now()
    const stack = makeStack({ now: () => new Date(clockMs).toISOString() })
    const workerId = 'w-stalled'
    const dataRoot = join(tmpRoot, 'data')

    // 台账：主线化身 running、impl=claude-code。
    // builtin 也有自己的 progress 信号；这里选择 CLI 是为了覆盖原生 meta 基线。
    await stack.ledger.upsertWorker('wechat::sess-1' as ManagerKey, workerId, () => {
      const worker = makeLedgerWorker({ workerId, title: '卡住的活', managerKey: 'wechat::sess-1' as ManagerKey })
      return { ...worker, incarnations: [{ ...worker.incarnations[0], impl: 'claude-code' }] }
    })

    // 停摆基线取同化身的 meta mtime,不能让 TUI output 重绘决定活性。
    const logDir = join(dataRoot, 'agent', 'worker-adapters', 'claude-code', workerId)
    await fs.mkdir(logDir, { recursive: true })
    const stalledAt = new Date(clockMs - 2 * 60 * 60 * 1000)
    const metaPath = join(logDir, 'meta-1.json')
    await fs.writeFile(metaPath, JSON.stringify({
      seq: 1,
      state: 'running',
      session_id: 'stalled-session',
      workspace_root: join(tmpRoot, 'workspace'),
    }), 'utf-8')
    await fs.utimes(metaPath, stalledAt, stalledAt)

    const wakeTexts = async (): Promise<string[]> =>
      (await stack.harness.readWorkerEvents(workerId))
        .filter((e) => e.kind === 'state_changed' && typeof e.detail?.text === 'string')
        .map((e) => e.detail!.text as string)

    await stack.harness.sweepLiveness()

    // ① #74 的行为：episode 失败 → 人类收到兜底（真 sendBackgroundFailLoud，真文案）
    await waitUntil(() => rpcCalls.some((c) => c.method === 'send_message'))
    const text = sentText()
    expect(text).toContain('worker「卡住的活」的状态更新')
    expect(text).toContain('没跑成')

    // 首报只带结构化停摆事实，终端必须由 Manager 显式读取。
    expect(await wakeTexts()).toHaveLength(1)
    expect((await wakeTexts())[0]).toContain('活性巡检')
    expect((await wakeTexts())[0]).not.toContain('⏺ 正在读取文件…')

    // 退避与重试的时序由 harness-liveness.test.ts 的可控 adapter 覆盖；这里刻意不依赖
    // 真实 tmux 重连，只验证 manager 失败时的人类兜底与唤醒正文边界。
  })

  it('不注入 reportEpisodeFailure 时保持既有行为：只记日志、不炸（可选钩子）', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const stack = makeStack({ reportEpisodeFailure: undefined })
      await seedAndFireEvent(stack, { workerId: 'w-1', title: '任务' })

      await waitUntil(() => errorSpy.mock.calls.length > 0)
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(rpcCalls.filter((c) => c.method === 'send_message')).toEqual([])
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
