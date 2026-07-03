/**
 * end-turn-gate.ts — createAsyncAuditEndTurnGate 闭包行为单测。
 *
 * 不跑完整 runWorkerLoop，只测闭包：
 *  - empty outboundBuffer + everSentMessage=true → null（讨论型放行，§4.13.4）
 *  - goalSetCache=false → null（worker 没 set_task_goal）
 *  - 非空 buffer + goal 存在 → spawn audit + 设 activeAuditId + 返回 [audit_pending] marker
 *  - get_task RPC 抛错 → null（fail-open）
 *  - task.goal 缺失 → null
 *  - spawn 抛错 → null（fail-open，console.warn）
 *  - **§4.13.9 新增**：
 *    - buffer 空 + has goal + !everSentMessage + retries<3 → GOAL_MODE_NO_DELIVERY_PROMPT + retries++
 *    - 3 次兜底耗尽 → 强制 spawn audit（buffer 空也派）
 *    - 讨论型不误伤：buffer 空 + has goal + everSentMessage=true → null
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.3 + §4.13
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createAsyncAuditEndTurnGate,
  GOAL_MODE_NO_DELIVERY_PROMPT,
  GOAL_MODE_INTERCEPTED_DELIVERY_PROMPT,
  type AsyncAuditEndTurnGateDeps,
} from '../../src/agent/end-turn-gate'
import { parseSystemMarker } from '../../src/agent/audit-result-marker'
import type { WorkerTaskState } from '../../src/types'
import type { GoalAuditTaskGoal } from '../../src/agent/goal-audit'
import type { OutboundBufferEntry } from '../../src/agent/outbound-flush'
import type { SpawnAuditSubagentDeps } from '../../src/agent/audit-spawn'
import { TodoStore } from '../../src/agent/worker-todo-store'

function makeGoal(): GoalAuditTaskGoal {
  return {
    objective: '把 audit 异步化',
    acceptance_criteria: [
      { id: 'c-1', kind: 'semantic', spec: 'main loop 不阻塞', rationale: 'audit 不卡 LLM 续作' },
    ],
  }
}

function makeBufferEntry(): OutboundBufferEntry {
  return {
    channel_id: 'wechat:bot:1',
    session_id: 's-1',
    content: 'final delivery',
    intent: 'info',
    sent_at_attempt_ms: Date.now(),
  }
}

function makeTaskState(overrides: Partial<WorkerTaskState> = {}): WorkerTaskState {
  return {
    taskId: 'task-1',
    status: 'executing',
    startedAt: new Date().toISOString(),
    abortController: { signal: { aborted: false }, abort: () => {} },
    pendingHumanMessages: [],
    todoStore: new TodoStore(),
    outboundBuffer: [],
    activeAuditId: undefined,
    activeAsyncSubagentIds: new Set<string>(),
    // §4.13 默认：未发过、零计数。具体测试按需 override 模拟"讨论型 / 已塞过 N 次 prompt"等场景。
    everSentMessage: false,
    humanInputEpoch: 0,
    everBufferedMessage: false,
    silentNoDeliveryRetries: 0,
    ...overrides,
  }
}

interface Harness {
  readonly deps: AsyncAuditEndTurnGateDeps
  readonly taskState: WorkerTaskState
  readonly rpcCall: ReturnType<typeof vi.fn>
  readonly spawnFn: ReturnType<typeof vi.fn>
  readonly buildSpawnDeps: ReturnType<typeof vi.fn>
}

function makeHarness(opts: {
  goalSetCache?: boolean
  /** 不传 → 默认有 goal；显式传 null → 模拟 task.goal 缺失 */
  goal?: GoalAuditTaskGoal | null
  bufferEntries?: ReadonlyArray<OutboundBufferEntry>
  rpcCallOverride?: ReturnType<typeof vi.fn>
  spawnReturn?: string | Promise<string>
  spawnThrows?: Error
  /** §4.13 — 显式控制初始 everSentMessage / silentNoDeliveryRetries */
  everSentMessage?: boolean
  humanInputEpoch?: number
  lastDeliveredInfoEpoch?: number
  silentNoDeliveryRetries?: number
} = {}): Harness {
  const goal: GoalAuditTaskGoal | undefined =
    opts.goal === null ? undefined : opts.goal ?? makeGoal()
  const rpcCall = opts.rpcCallOverride ?? vi.fn(async () => {
    return { task: { id: 'task-1', goal } }
  })

  const taskState = makeTaskState({
    outboundBuffer: [...(opts.bufferEntries ?? [makeBufferEntry()])],
    ...(opts.everSentMessage !== undefined ? { everSentMessage: opts.everSentMessage } : {}),
    ...(opts.humanInputEpoch !== undefined ? { humanInputEpoch: opts.humanInputEpoch } : {}),
    ...(opts.lastDeliveredInfoEpoch !== undefined ? { lastDeliveredInfoEpoch: opts.lastDeliveredInfoEpoch } : {}),
    ...(opts.silentNoDeliveryRetries !== undefined ? { silentNoDeliveryRetries: opts.silentNoDeliveryRetries } : {}),
  })

  const spawnFn = vi.fn(async () => {
    if (opts.spawnThrows) throw opts.spawnThrows
    return opts.spawnReturn ?? 'audit-test-xyz'
  })

  const buildSpawnDeps = vi.fn((g: GoalAuditTaskGoal): SpawnAuditSubagentDeps => ({
    goal: g,
    conversationLog: [],
    cwd: '/tmp/workspace',
    parentTaskId: 'task-1',
    auditor: {} as never,
    parentTools: [],
    adapter: {} as never,
    owner: { friend_id: 'f1' },
    registry: {} as never,
    abortControllers: new Map(),
    humanQueue: {} as never,
  }))

  return {
    deps: {
      taskId: 'task-1',
      taskState,
      goalSetCacheGetter: () => opts.goalSetCache ?? true,
      rpcClient: { call: rpcCall } as never,
      moduleId: 'agent-test',
      getAdminPort: async () => 19000,
      buildSpawnDeps,
      spawnAuditSubagentFn: spawnFn as never,
    },
    taskState,
    rpcCall,
    spawnFn,
    buildSpawnDeps,
  }
}

describe('createAsyncAuditEndTurnGate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('empty outboundBuffer + everSentMessage=true → returns null (讨论型放行；§4.13.4)', async () => {
    const h = makeHarness({
      bufferEntries: [],
      everSentMessage: true,
      humanInputEpoch: 1,
      lastDeliveredInfoEpoch: 1,
    })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBeNull()
    expect(h.rpcCall).not.toHaveBeenCalled()
    expect(h.spawnFn).not.toHaveBeenCalled()
    expect(h.taskState.activeAuditId).toBeUndefined()
  })

  it('goalSetCache=false（worker 尚未 set_task_goal）→ returns null; 不 RPC、不 spawn', async () => {
    const h = makeHarness({ goalSetCache: false })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBeNull()
    expect(h.rpcCall).not.toHaveBeenCalled()
    expect(h.spawnFn).not.toHaveBeenCalled()
  })

  it('非空 buffer + goal 存在 → spawn audit + 设 activeAuditId + 返回 [audit_pending] marker', async () => {
    const h = makeHarness({ spawnReturn: 'audit-test-xyz' })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    // RPC + spawn 都被调用
    expect(h.rpcCall).toHaveBeenCalledOnce()
    expect(h.rpcCall.mock.calls[0][1]).toBe('get_task')
    expect(h.spawnFn).toHaveBeenCalledOnce()

    // activeAuditId 落位
    expect(h.taskState.activeAuditId).toBe('audit-test-xyz')

    // 返回 wait 信号——engine 直接挂起，不再注入 audit_pending 文本（spec 2026-06-10 §4.7）
    expect(result).toEqual({ kind: 'wait' })

    // buildSpawnDeps 收到 RPC 拿回的 goal
    expect(h.buildSpawnDeps).toHaveBeenCalledOnce()
    expect(h.buildSpawnDeps.mock.calls[0][0].objective).toBe('把 audit 异步化')
  })

  it('get_task RPC 抛错 → returns null (fail-open)，spawn 不调，activeAuditId 不变', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rpcCall = vi.fn(async () => { throw new Error('rpc network down') })
    const h = makeHarness({ rpcCallOverride: rpcCall })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBeNull()
    expect(h.spawnFn).not.toHaveBeenCalled()
    expect(h.taskState.activeAuditId).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('task.goal 缺失 → returns null, spawn 不调用', async () => {
    const h = makeHarness({ goal: null })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBeNull()
    expect(h.rpcCall).toHaveBeenCalledOnce()
    expect(h.spawnFn).not.toHaveBeenCalled()
    expect(h.taskState.activeAuditId).toBeUndefined()
  })

  it('spawn 抛错 → returns null (fail-open)，activeAuditId 不变，console.warn 被调', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = makeHarness({ spawnThrows: new Error('spawn failed: registry full') })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBeNull()
    expect(h.spawnFn).toHaveBeenCalledOnce()
    expect(h.taskState.activeAuditId).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('builtin-goal-auditor 缺失场景（buildSpawnDeps 抛错）→ returns null (fail-open)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = makeHarness()
    // 真实路径下 buildSpawnDeps 在没 auditor 时 throw —— 这里直接 mock 抛错验证 fail-open
    h.buildSpawnDeps.mockImplementation(() => {
      throw new Error('builtin-goal-auditor subagent not configured')
    })
    // 这种情况 spawn 会被调（spawnFn 接收 buildSpawnDeps 的返回值；抛错时整个 spawn 路径都挂）
    // —— 闭包应该把这个错也归到 spawn 抛错分支
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBeNull()
    expect(h.taskState.activeAuditId).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})

// ============================================================================
// §4.13 Revision 2026-06-09 第 2 段：everSentMessage 二级分支 + 3 次兜底
// ============================================================================

describe('createAsyncAuditEndTurnGate § 4.13 二级分支', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('trace cd1aaa5b 重现：buffer 空 + has goal + !everSentMessage + retries=0 → 返回 GOAL_MODE_NO_DELIVERY_PROMPT、retries++、不 RPC 不 spawn', async () => {
    const h = makeHarness({
      bufferEntries: [],
      everSentMessage: false,
      silentNoDeliveryRetries: 0,
    })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBe(GOAL_MODE_NO_DELIVERY_PROMPT)
    expect(h.taskState.silentNoDeliveryRetries).toBe(1)
    expect(h.rpcCall).not.toHaveBeenCalled()
    expect(h.spawnFn).not.toHaveBeenCalled()
    expect(h.taskState.activeAuditId).toBeUndefined()
  })

  it('trace e1c9663f 重现：buffer 空 + !everSentMessage + everBufferedMessage=true → 返回"交付被拦"变体文案（不再误导"从未交付"）', async () => {
    const h = makeHarness({
      bufferEntries: [],
      everSentMessage: false,
      silentNoDeliveryRetries: 0,
    })
    h.taskState.everBufferedMessage = true
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBe(GOAL_MODE_INTERCEPTED_DELIVERY_PROMPT)
    expect(result).not.toBe(GOAL_MODE_NO_DELIVERY_PROMPT)
    expect(h.taskState.silentNoDeliveryRetries).toBe(1)
    expect(h.spawnFn).not.toHaveBeenCalled()
  })

  it('retries=1, 2 时仍塞 prompt + 计数 +1', async () => {
    for (const startRetries of [1, 2]) {
      const h = makeHarness({
        bufferEntries: [],
        everSentMessage: false,
        silentNoDeliveryRetries: startRetries,
      })
      const gate = createAsyncAuditEndTurnGate(h.deps)

      const result = await gate()

      expect(result).toBe(GOAL_MODE_NO_DELIVERY_PROMPT)
      expect(h.taskState.silentNoDeliveryRetries).toBe(startRetries + 1)
      expect(h.spawnFn).not.toHaveBeenCalled()
    }
  })

  it('retries=3 → 强制派 audit（buffer 空也派；走完整 RPC+spawn 路径，设 activeAuditId）', async () => {
    const h = makeHarness({
      bufferEntries: [],
      everSentMessage: false,
      silentNoDeliveryRetries: 3,
      spawnReturn: 'forced-audit-zzz',
    })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    // 不再塞 prompt，直接走 audit 路径
    expect(result).not.toBe(GOAL_MODE_NO_DELIVERY_PROMPT)
    expect(h.rpcCall).toHaveBeenCalledOnce()
    expect(h.spawnFn).toHaveBeenCalledOnce()
    expect(h.taskState.activeAuditId).toBe('forced-audit-zzz')
    // 强制路径不再 ++ 计数器（计数器本就 ≥3）
    expect(h.taskState.silentNoDeliveryRetries).toBe(3)

    // 返回 wait 信号（spec 2026-06-10 §4.7）
    expect(result).toEqual({ kind: 'wait' })
  })

  it('讨论型不误伤：buffer 空 + has goal + everSentMessage=true + retries=0 → null', async () => {
    const h = makeHarness({
      bufferEntries: [],
      everSentMessage: true,
      humanInputEpoch: 1,
      lastDeliveredInfoEpoch: 1,
      silentNoDeliveryRetries: 0,
    })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBeNull()
    expect(h.rpcCall).not.toHaveBeenCalled()
    expect(h.spawnFn).not.toHaveBeenCalled()
    expect(h.taskState.activeAuditId).toBeUndefined()
    // 不动计数器
    expect(h.taskState.silentNoDeliveryRetries).toBe(0)
  })

  it('terminal supplement 后仅有历史送达不算本轮已汇报：current epoch 未送达 → 注入 NO_DELIVERY prompt', async () => {
    const h = makeHarness({
      bufferEntries: [],
      everSentMessage: true,
      humanInputEpoch: 2,
      lastDeliveredInfoEpoch: 1,
      silentNoDeliveryRetries: 0,
    })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(result).toBe(GOAL_MODE_NO_DELIVERY_PROMPT)
    expect(h.taskState.silentNoDeliveryRetries).toBe(1)
    expect(h.rpcCall).not.toHaveBeenCalled()
    expect(h.spawnFn).not.toHaveBeenCalled()
    expect(h.taskState.activeAuditId).toBeUndefined()
  })

  it('讨论型也不受 retries 影响：everSentMessage=true 在 retries=5 时仍 null', async () => {
    const h = makeHarness({
      bufferEntries: [],
      everSentMessage: true,
      humanInputEpoch: 1,
      lastDeliveredInfoEpoch: 1,
      silentNoDeliveryRetries: 5,
    })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    expect(await gate()).toBeNull()
    expect(h.spawnFn).not.toHaveBeenCalled()
  })

  it('non-goal 路径独立：!goalSetCache + buffer 空 + !everSentMessage → null (不命中 §4.13)', async () => {
    const h = makeHarness({
      bufferEntries: [],
      goalSetCache: false,
      everSentMessage: false,
    })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    expect(await gate()).toBeNull()
    expect(h.taskState.silentNoDeliveryRetries).toBe(0)
    expect(h.spawnFn).not.toHaveBeenCalled()
  })

  it('trace 7470b21d 回归：buffer 非空 + has goal + everSentMessage=false → 仍走 audit 路径（§4.13 不影响 buffer 非空分支）', async () => {
    const h = makeHarness({
      everSentMessage: false,
      silentNoDeliveryRetries: 0,
      spawnReturn: 'audit-from-buffered',
    })
    const gate = createAsyncAuditEndTurnGate(h.deps)

    const result = await gate()

    expect(h.spawnFn).toHaveBeenCalledOnce()
    expect(h.taskState.activeAuditId).toBe('audit-from-buffered')
    expect(h.taskState.silentNoDeliveryRetries).toBe(0)

    expect(result).toEqual({ kind: 'wait' })
  })
})
