/**
 * agent 对外事件(P5 Task 2)—— `src/manager/events.ts` + bootstrap 的 onEvent 接线。
 *
 * 五条不变量:
 * ① `agent.task_status_changed` 载荷与 protocol-agent-v3 §9.2 逐字一致(字段名/字段集);
 * ② 事件信封形状与既有模块(admin `publishAdminEvent`)一致:id/type/source/payload/timestamp;
 * ③ 发布失败(reject 与同步抛)都被 catch,不抛给调用方、不产生 unhandledRejection;
 * ④ 化身级事件(task.status 没动)不触发 task 级事件;
 * ⑤ 同状态重复事件静默;并发事件按 worker 串行,old/new 不会错位。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  makeAgentEventPublisher,
  makeTaskStatusEventBridge,
  type AgentTaskStatusChangedPayload,
} from '../../src/manager/events.js'
import { buildManagerStack, type BootstrapDeps } from '../../src/manager/bootstrap.js'
import {
  dialogObjectIdForPrivate,
  type DialogObjectId,
  type LedgerWorker,
  type TaskStatus,
} from '../../src/workers/harness/ledger-types.js'
import type { HarnessEvent } from '../../src/workers/harness/harness.js'
import type { LedgerStore } from '../../src/workers/harness/ledger-store.js'
import type { WorkerAdapter, WorkerImplId, IncarnationHandle, IncarnationEndReason, WorkerContractState } from '../../src/workers/types.js'
import type { ManagerKey } from '../../src/manager/types.js'
import type { LLMAdapter } from '../../src/engine/index.js'
import type { Event, ModuleId, RpcClient } from 'crabot-shared'
import { createCrabMemoryServer } from '../../src/mcp/crab-memory.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

// ============================================================================
// helpers
// ============================================================================

const DIALOG_OBJECT_ID = dialogObjectIdForPrivate('friend-evt')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function makeLedgerWorker(p: {
  workerId: string
  status: TaskStatus
  taskId?: string
  impl?: WorkerImplId
}): LedgerWorker {
  return {
    worker_id: p.workerId,
    task: { id: p.taskId ?? `task-of-${p.workerId}`, title: 't', status: p.status, created_at: '2026-01-01T00:00:00.000Z' },
    origin: { spawned_by_session: 'wechat::sess-evt' as ManagerKey, trigger_type: 'message' },
    report_to: { channel_id: 'wechat', session_id: 'sess-evt' },
    incarnations: [
      {
        seq: 1,
        impl: p.impl ?? 'builtin',
        state: 'running',
        workspace: '/tmp/ws-not-used',
        session_ref: `${p.workerId}-ref`,
        started_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

/** 台账桩:按调用序返回状态(模拟 harness 落账后的真实读)。 */
function makeLedgerStub(
  script: Array<{ status: TaskStatus; delayMs?: number } | undefined>,
  opts: { taskId?: string; workerId?: string } = {},
): { ledger: Pick<LedgerStore, 'findWorker'>; calls: () => number } {
  let n = 0
  const ledger = {
    findWorker: async (workerId: string) => {
      const step = script[Math.min(n, script.length - 1)]
      n += 1
      if (!step) return undefined
      if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs))
      return {
        dialogObjectId: DIALOG_OBJECT_ID,
        worker: makeLedgerWorker({ workerId: opts.workerId ?? workerId, status: step.status, taskId: opts.taskId }),
      }
    },
  } as Pick<LedgerStore, 'findWorker'>
  return { ledger, calls: () => n }
}

function harnessEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
  return {
    ts: '2026-07-31T00:00:00.000Z',
    kind: 'state_changed',
    worker_id: 'w-1',
    seq: 1,
    ...overrides,
  }
}

/** 等待 bridge 内部的 fire-and-forget 链跑完(宏任务窗口足够,链上只有内存桩)。 */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

async function waitUntil(cond: () => Promise<boolean> | boolean, timeoutMs = 4000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitUntil timed out')
}

// --- bootstrap 接线用(最小依赖桩,与 tests/manager/bootstrap.test.ts 同款) ---

function makeMemoryServer() {
  return createCrabMemoryServer(
    { rpcClient: { call: vi.fn() } as never, moduleId: 'manager-events-test', getMemoryPort: async () => 19100 },
    { visibility: 'internal', scopes: [], isMasterPrivate: false },
  )
}

function makeMessagingDeps() {
  return {
    rpcClient: { call: vi.fn() } as never,
    moduleId: 'manager-events-test',
    getAdminPort: async () => 19001,
    resolveChannelPort: async () => 19009,
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
 * 三个 adapter 的 `onStateChange` 构造 deps 的完整形参表。第四参 `endReason` 是 adapter 在
 * `transitionExited` 时持有的 `ended_reason` 真值——它必填,所以直接调这个回调模拟 adapter
 * 上报时,`exited` 必须一并带上它,否则模拟出的是真实 adapter 不会产生的"退出但无原因"。
 */
type AdapterStateCallback = (
  h: IncarnationHandle,
  s: WorkerContractState,
  lastText?: string,
  endReason?: IncarnationEndReason,
) => void

function capturedOnStateChange(
  adapter: WorkerAdapter | undefined,
): AdapterStateCallback | undefined {
  return (adapter as unknown as { deps?: { onStateChange?: AdapterStateCallback } })?.deps?.onStateChange
}

// ============================================================================

describe('agent 对外事件（P5 Task 2）', () => {
  let unhandled: unknown[]
  const onUnhandled = (err: unknown): void => {
    unhandled.push(err)
  }

  beforeEach(() => {
    unhandled = []
    process.on('unhandledRejection', onUnhandled)
  })

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
    vi.restoreAllMocks()
  })

  // --- ② 事件信封 ---

  describe('makeAgentEventPublisher', () => {
    it('信封形状与既有模块一致：自动补 id(uuid) / source / timestamp，payload 原样透传', () => {
      const publishEvent = vi.fn(async () => 1)
      const publish = makeAgentEventPublisher({
        rpcClient: { publishEvent } as Pick<RpcClient, 'publishEvent'>,
        moduleId: 'agent-1' as ModuleId,
        now: () => '2026-07-31T12:00:00.000Z',
      })

      const payload: AgentTaskStatusChangedPayload = {
        worker_id: 'w-1',
        task_id: 'task-1',
        old_status: 'running',
        new_status: 'completed',
        dialog_object_id: DIALOG_OBJECT_ID,
      }
      publish('agent.task_status_changed', payload)

      expect(publishEvent).toHaveBeenCalledTimes(1)
      const [event, source] = publishEvent.mock.calls[0] as unknown as [Event, ModuleId]
      expect(source).toBe('agent-1')
      expect(Object.keys(event).sort()).toEqual(['id', 'payload', 'source', 'timestamp', 'type'])
      expect(event.type).toBe('agent.task_status_changed')
      expect(event.source).toBe('agent-1')
      expect(event.timestamp).toBe('2026-07-31T12:00:00.000Z')
      expect(event.id).toMatch(UUID_RE)
      expect(event.payload).toEqual(payload)
    })

    // --- ③ 发布失败不反噬调用方 ---

    it('rpcClient reject 被 catch：调用方不抛、无 unhandledRejection', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const publish = makeAgentEventPublisher({
        rpcClient: { publishEvent: async () => Promise.reject(new Error('module manager 不可达')) } as Pick<
          RpcClient,
          'publishEvent'
        >,
        moduleId: 'agent-1' as ModuleId,
        now: () => '2026-07-31T12:00:00.000Z',
      })

      expect(() =>
        publish('agent.task_status_changed', {
          worker_id: 'w-1',
          task_id: 'task-1',
          old_status: 'running',
          new_status: 'failed',
          dialog_object_id: DIALOG_OBJECT_ID,
        }),
      ).not.toThrow()

      await flush()
      expect(unhandled).toEqual([])
      expect(consoleSpy).toHaveBeenCalled()
    })

    it('rpcClient 同步抛错也被 catch：调用方不抛', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const publish = makeAgentEventPublisher({
        rpcClient: {
          publishEvent: () => {
            throw new Error('rpcClient 未初始化')
          },
        } as unknown as Pick<RpcClient, 'publishEvent'>,
        moduleId: 'agent-1' as ModuleId,
        now: () => '2026-07-31T12:00:00.000Z',
      })

      expect(() =>
        publish('agent.task_status_changed', {
          worker_id: 'w-1',
          task_id: 'task-1',
          old_status: 'queued',
          new_status: 'running',
          dialog_object_id: DIALOG_OBJECT_ID,
        }),
      ).not.toThrow()
      expect(consoleSpy).toHaveBeenCalled()
    })
  })

  // --- ①④⑤ harness 事件 → task 状态事件的翻译与去重 ---

  describe('makeTaskStatusEventBridge', () => {
    it('①载荷与 §9.2 逐字：worker_id / task_id / old_status / new_status / dialog_object_id，无多余字段', async () => {
      const publish = vi.fn()
      const { ledger } = makeLedgerStub([{ status: 'running' }], { taskId: 'task-42' })
      const bridge = makeTaskStatusEventBridge({ ledger, publish })

      bridge(harnessEvent({ kind: 'spawned', worker_id: 'w-42' }))
      await flush()

      expect(publish).toHaveBeenCalledTimes(1)
      const [type, payload] = publish.mock.calls[0] as [string, AgentTaskStatusChangedPayload]
      expect(type).toBe('agent.task_status_changed')
      expect(Object.keys(payload).sort()).toEqual([
        'dialog_object_id',
        'new_status',
        'old_status',
        'task_id',
        'worker_id',
      ])
      expect(payload).toEqual({
        worker_id: 'w-42',
        task_id: 'task-42',
        // 台账里的 task 初始状态是 queued（harness.spawnWorker 先建 queued 再迁 running）
        old_status: 'queued',
        new_status: 'running',
        dialog_object_id: DIALOG_OBJECT_ID,
      })
    })

    it('④化身级事件不触发 task 事件：task.status 一直是 running 时，state_changed / input_sent 一条都不发', async () => {
      const publish = vi.fn()
      const { ledger } = makeLedgerStub([{ status: 'running' }])
      const bridge = makeTaskStatusEventBridge({ ledger, publish })

      // 第一条把 task 从初始 queued 带到 running（这是真实迁移，应发）
      bridge(harnessEvent({ kind: 'spawned' }))
      await flush()
      expect(publish).toHaveBeenCalledTimes(1)

      // 后续全是化身级跳动：input_sent / state_changed(fork) / state_changed(dead_letter)
      bridge(harnessEvent({ kind: 'input_sent', detail: { text_len: 3 } }))
      bridge(harnessEvent({ kind: 'state_changed', seq: 2, detail: { kind: 'fork', from_seq: 1 } }))
      bridge(harnessEvent({ kind: 'state_changed', detail: { kind: 'dead_letter', reason: 'task_cancelled' } }))
      bridge(harnessEvent({ kind: 'query_failed', detail: { reason: 'capability_not_supported' } }))
      await flush()

      expect(publish).toHaveBeenCalledTimes(1)
    })

    it('⑤同状态重复事件静默；状态真的变了才发，且 old_status 取上一次已知值', async () => {
      const publish = vi.fn()
      const { ledger } = makeLedgerStub([
        { status: 'running' },
        { status: 'running' },
        { status: 'waiting_input' },
        { status: 'waiting_input' },
        { status: 'completed' },
      ])
      const bridge = makeTaskStatusEventBridge({ ledger, publish })

      for (let i = 0; i < 5; i += 1) {
        bridge(harnessEvent({ kind: 'state_changed' }))
        await flush(2)
      }
      await flush()

      expect(publish.mock.calls.map(([, p]) => [p.old_status, p.new_status])).toEqual([
        ['queued', 'running'],
        ['running', 'waiting_input'],
        ['waiting_input', 'completed'],
      ])
    })

    it('同一 worker 的并发事件按序处理：先到的台账读慢一拍也不会让 old/new 错位', async () => {
      const publish = vi.fn()
      const { ledger } = makeLedgerStub([
        { status: 'running', delayMs: 40 }, // 第一条读得慢
        { status: 'completed' }, // 第二条读得快
      ])
      const bridge = makeTaskStatusEventBridge({ ledger, publish })

      bridge(harnessEvent({ kind: 'spawned' }))
      bridge(harnessEvent({ kind: 'exited' }))
      await flush(20)

      expect(publish.mock.calls.map(([, p]) => [p.old_status, p.new_status])).toEqual([
        ['queued', 'running'],
        ['running', 'completed'],
      ])
    })

    // --- ⑥ 终态不得被"读晚一步"吞掉（评审 PoC (B) 的复现 + 修复）---

    it('⑥读晚于下一次落账时，终态 completed 仍必须发出（事件自带 task_status）', async () => {
      const publish = vi.fn()
      // 真实 LedgerStore.findWorker 的语义：不进互斥锁、读到的永远是**最新已提交**的那份。
      // 这里用一个可变量模拟"盘上现状"，在事件之间推进它，就能精确制造"bridge 的台账读
      // 晚于下一次落账"的时序——评审 PoC (B) 的构造手法。
      let onDisk: TaskStatus = 'running'
      const ledger = {
        findWorker: async (workerId: string) => ({
          dialogObjectId: DIALOG_OBJECT_ID,
          worker: makeLedgerWorker({ workerId, status: onDisk, taskId: 'task-swallow' }),
        }),
      } as unknown as Pick<LedgerStore, 'findWorker'>
      const bridge = makeTaskStatusEventBridge({ ledger, publish })

      // ① spawn：台账落 running，事件带 running
      bridge(harnessEvent({ kind: 'spawned', worker_id: 'w-swallow', task_status: 'running' }))
      await flush()

      // ② 化身自然结束：台账落 completed、harness 发 exited……
      onDisk = 'completed'
      const exited = harnessEvent({ kind: 'exited', worker_id: 'w-swallow', task_status: 'completed' })
      // ……但在 bridge 真正去读台账之前，§5.3 透明接续已经把 task 拉回 running 并落了账。
      // 修复前：bridge 现读台账只看得到 running，old===new，completed 被整条吞掉，一次都不发。
      onDisk = 'running'
      bridge(exited)
      await flush()

      // ③ 接续产出新化身
      bridge(harnessEvent({ kind: 'resumed', worker_id: 'w-swallow', task_status: 'running' }))
      await flush()

      expect(publish.mock.calls.map(([, p]) => [p.old_status, p.new_status])).toEqual([
        ['queued', 'running'],
        ['running', 'completed'],
        ['completed', 'running'],
      ])
      // 身份字段仍取自台账（它们在 worker 生命周期内不变，读晚了也读不出别的值）
      expect(publish.mock.calls[1][1]).toMatchObject({ worker_id: 'w-swallow', task_id: 'task-swallow', dialog_object_id: DIALOG_OBJECT_ID })
    })

    it('⑥事件带 task_status 时，new_status 一律以事件为准，不再受台账现状影响', async () => {
      const publish = vi.fn()
      // 台账故意一直报 running（模拟读永远晚一步）
      const { ledger } = makeLedgerStub([{ status: 'running' }])
      const bridge = makeTaskStatusEventBridge({ ledger, publish })

      bridge(harnessEvent({ kind: 'killed', worker_id: 'w-evt', task_status: 'cancelled' }))
      await flush()

      expect(publish.mock.calls.map(([, p]) => [p.old_status, p.new_status])).toEqual([['queued', 'cancelled']])
    })

    it('⑥向后兼容：事件没带 task_status（老事件日志 / 化身级事件点）时退回现读台账，不静默丢弃', async () => {
      const publish = vi.fn()
      const { ledger, calls } = makeLedgerStub([{ status: 'running' }, { status: 'completed' }])
      const bridge = makeTaskStatusEventBridge({ ledger, publish })

      // 两条都不带 task_status —— 必须仍能翻译出迁移（这正是修复前的行为，缺字段不得变成
      // 一条新的静默丢事件路径）。
      bridge(harnessEvent({ kind: 'state_changed', worker_id: 'w-legacy' }))
      await flush(2)
      bridge(harnessEvent({ kind: 'state_changed', worker_id: 'w-legacy' }))
      await flush()

      expect(publish.mock.calls.map(([, p]) => [p.old_status, p.new_status])).toEqual([
        ['queued', 'running'],
        ['running', 'completed'],
      ])
      expect(calls()).toBe(2) // 确实是靠现读台账兜底的
    })

    it('worker 不在台账（如 query_failed:worker_not_found）→ 不发事件、不抛', async () => {
      const publish = vi.fn()
      const { ledger } = makeLedgerStub([undefined])
      const bridge = makeTaskStatusEventBridge({ ledger, publish })

      expect(() => bridge(harnessEvent({ kind: 'query_failed', detail: { reason: 'worker_not_found' } }))).not.toThrow()
      await flush()

      expect(publish).not.toHaveBeenCalled()
      expect(unhandled).toEqual([])
    })

    it('台账读失败 → 记日志、不发事件、不抛、无 unhandledRejection', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const publish = vi.fn()
      const ledger = {
        findWorker: async () => {
          throw new Error('台账文件损坏')
        },
      } as unknown as Pick<LedgerStore, 'findWorker'>
      const bridge = makeTaskStatusEventBridge({ ledger, publish })

      expect(() => bridge(harnessEvent())).not.toThrow()
      await flush()

      expect(publish).not.toHaveBeenCalled()
      expect(unhandled).toEqual([])
      expect(consoleSpy).toHaveBeenCalled()
    })
  })

  // --- 接线:bootstrap 的 onEvent 出口 ---

  describe('bootstrap onEvent 接线', () => {
    let tmpRoot: string

    beforeEach(async () => {
      tmpRoot = await fs.mkdtemp(join(tmpdir(), 'manager-events-'))
    })

    afterEach(async () => {
      await fs.rm(tmpRoot, { recursive: true, force: true })
    })

    function makeDeps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
      return {
        dataRoot: join(tmpRoot, 'data'),
        now: () => new Date().toISOString(),
        managerAdapter: () => silentAdapter(),
        managerModel: () => 'test-manager-model',
        messagingDeps: makeMessagingDeps(),
        memoryServer: makeMemoryServer(),
        callAdmin: async () => ({}) as never,
        dialogObjectIdFor: (): DialogObjectId => DIALOG_OBJECT_ID,
        ...overrides,
      }
    }

    it('真实 harness 状态迁移（adapter 回调 → 落账 → onEvent）会发出 agent.task_status_changed', async () => {
      const published: Array<[string, AgentTaskStatusChangedPayload]> = []
      const stack = buildManagerStack(
        makeDeps({
          publishEvent: (type, payload) => {
            published.push([type, payload])
          },
        }),
      )

      await stack.ledger.upsertWorker(DIALOG_OBJECT_ID, 'w-wired', () =>
        makeLedgerWorker({ workerId: 'w-wired', status: 'running', taskId: 'task-wired' }),
      )

      const onStateChange = capturedOnStateChange(stack.adapters.get('builtin'))
      expect(onStateChange).toBeDefined()
      // 第四参 'completed' 复刻真实 adapter：transitionExited 的 ended_reason 是必填形参，
      // 化身自然结束（非 kill）时三个实现给的都是 'completed'。本用例只验证"事件发得出来"。
      onStateChange!({ worker_id: 'w-wired', seq: 1, impl: 'builtin', session_ref: 'w-wired-ref' }, 'exited', undefined, 'completed')

      await waitUntil(() => published.length >= 1)
      expect(published[0][0]).toBe('agent.task_status_changed')
      expect(published[0][1]).toEqual({
        worker_id: 'w-wired',
        task_id: 'task-wired',
        old_status: 'queued',
        new_status: 'completed',
        dialog_object_id: DIALOG_OBJECT_ID,
      })
    })

    it('对外事件不受 manager 唤醒过滤（shouldWakeOnHarnessEvent）与 registry 就绪与否影响：input_sent 也要能翻译出状态迁移', async () => {
      const published: Array<[string, AgentTaskStatusChangedPayload]> = []
      const stack = buildManagerStack(
        makeDeps({
          publishEvent: (type, payload) => {
            published.push([type, payload])
          },
        }),
      )

      await stack.ledger.upsertWorker(DIALOG_OBJECT_ID, 'w-filtered', () =>
        makeLedgerWorker({ workerId: 'w-filtered', status: 'running', taskId: 'task-filtered' }),
      )

      // 直取 harness 拿到的那个 onEvent：这是 bootstrap 开的唯一出口，也是本用例要验证的对象
      // （input_sent 在 NO_WAKE_KINDS 里，真实 harness 只有在活 worker 上投递才会落，
      // 这里用同一个回调直接喂，验证的是接线顺序本身）。
      const onEvent = (stack.harness as unknown as { deps: { onEvent?: (e: HarnessEvent) => void } }).deps.onEvent
      expect(onEvent).toBeDefined()
      onEvent!(harnessEvent({ kind: 'input_sent', worker_id: 'w-filtered', detail: { text_len: 3 } }))

      await waitUntil(() => published.length >= 1)
      expect(published[0][1].new_status).toBe('running')
      expect(published[0][1].worker_id).toBe('w-filtered')
    })

    it('未注入 publishEvent 时装配照常工作（P5 阶段无生产调用方）', async () => {
      const stack = buildManagerStack(makeDeps())
      await stack.ledger.upsertWorker(DIALOG_OBJECT_ID, 'w-nopub', () =>
        makeLedgerWorker({ workerId: 'w-nopub', status: 'running' }),
      )
      const onStateChange = capturedOnStateChange(stack.adapters.get('builtin'))
      onStateChange!({ worker_id: 'w-nopub', seq: 1, impl: 'builtin', session_ref: 'w-nopub-ref' }, 'exited', undefined, 'completed')
      await waitUntil(async () => (await stack.ledger.findWorker('w-nopub'))?.worker.task.status === 'completed')
      expect(unhandled).toEqual([])
    })
  })
})
