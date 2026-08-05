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
import { dialogObjectIdForPrivate, type LedgerWorker } from '../../src/workers/harness/ledger-types.js'
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

function makeLedgerWorker(p: { workerId: string; title: string; spawnedBySession: ManagerKey }): LedgerWorker {
  return {
    worker_id: p.workerId,
    task: { id: p.workerId, title: p.title, status: 'running', created_at: '2026-01-01T00:00:00.000Z' },
    origin: { spawned_by_session: p.spawnedBySession, trigger_type: 'message' },
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
    await stack.ledger.upsertWorker(dialogObjectIdForPrivate('friend-1'), p.workerId, () =>
      makeLedgerWorker({ workerId: p.workerId, title: p.title, spawnedBySession: 'wechat::sess-1' as ManagerKey }),
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
    // 目标 = 该 worker 的监护 manager（origin.spawned_by_session），不是 report_to、不是系统线程
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
