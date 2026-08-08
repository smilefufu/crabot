/**
 * E2E 集成测试：goal-audit 异步流的端到端行为。
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md
 *
 * 这里的"E2E"指 engine query-loop + outboundBuffer + endTurnGate + abortAudit closure
 * 几个子系统的组合行为，不真起 admin RPC / bg-agent / channel。Mock 控制点：
 *   - audit verdict（通过手动 push <audit_result> marker 模拟 audit subagent 完成）
 *   - channel sendMessage（通过 channelSendSpy 替代真正的 channel）
 *   - supplement 时机（通过手动 humanQueue.push 控制）
 *   - flushOutboundBuffer 行为（真 splice + dispatch，跟 createOutboundFlush 等价）
 *
 * 4 个核心场景：
 *   A. iter 52 假交付 — buffer 非空 + end_turn → audit fail → buffer drop → channel 不收到
 *   B. audit pass + 无 pending → flush buffer + buildResult completed
 *   C. supplement 改 goal mid-audit → abortAudit 调 controller.abort + drop buffer + 注入 aborted 提示
 *   D. 审计 barrier yield → audit complete pass → drain pass 完整链路（含事件顺序）
 *
 * 关键模拟：endTurnGate 闭包模拟 `createAsyncAuditEndTurnGate` 行为——
 *   buffer 空 → null；buffer 非空 → 设 activeAuditId + 返回 [audit_pending] marker。
 *   audit 完成由测试手动 push <audit_result> marker 触发。
 *
 * 注意：query-loop 在 stop_reason='tool_use' 续 turn 时会调 flushOutboundBuffer（Task 8）。
 * 测试通过预先把 entry 推入 outboundBuffer + 直接让 LLM 走 end_turn 路径，避免被 tool_use 续 turn flush
 * 提前清空——这模拟"agent 调 send_message(info) 在本 turn 内但与 end_turn 同 LLM 响应"的边界条件。
 * 这样能聚焦 endTurnGate audit 触发 → drain 分流 的核心路径。
 */

import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import {
  buildAuditPendingMarker,
  buildAuditResultMarker,
  buildAuditAbortedMarker,
} from '../../src/agent/audit-result-marker.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
import type { OutboundBufferEntry } from '../../src/agent/outbound-flush.js'
import type { ToolDefinition } from '../../src/engine/types.js'

// ============================================================================
// Test helpers
// ============================================================================

type AdapterStep =
  | { kind: 'tool'; toolId: string; toolName: string; input?: Record<string, unknown> }
  | { kind: 'audit_barrier'; text: string }

function makeAdapter(steps: ReadonlyArray<AdapterStep>): LLMAdapter {
  let i = 0
  return {
    stream: vi.fn(async function* () {
      const s = steps[i++] ?? steps[steps.length - 1]
      if (s.kind === 'tool') {
        yield* chunksFromContent(
          [{ type: 'tool_use' as const, id: s.toolId, name: s.toolName, input: s.input ?? {} }],
          'tool_use',
          { inputTokens: 20, outputTokens: 10 },
        )
        return
      }
      yield* chunksFromContent(
        [{ type: 'text' as const, text: s.text }],
        'end_turn',
        { inputTokens: 10, outputTokens: 5 },
      )
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

/** 构造 end_turn 工具——挂起 main loop 直到 queue.push 唤醒。 */
function makeWaitTool(queue: HumanMessageQueue, onCall?: () => void): ToolDefinition {
  return {
    name: 'audit_barrier',
    description: 'wait for audit or supplement',
    inputSchema: { type: 'object' as const, properties: {} },
    isReadOnly: true,
    call: async () => {
      onCall?.()
      queue.setBarrier(60_000)
      return { output: 'waiting', isError: false }
    },
  }
}

/** 构造 set_task_goal 工具——成功后调 abortAudit（模拟 agent-handler 内 callAdminRpc 包装层）。 */
function makeSetTaskGoalTool(deps: {
  abortAudit: (reason: string) => void
}): ToolDefinition {
  return {
    name: 'set_task_goal',
    description: 'set or revise task goal',
    inputSchema: {
      type: 'object' as const,
      properties: { goal: { type: 'string' } },
    },
    isReadOnly: false,
    call: async () => {
      // 模拟 admin RPC 成功后的回调：abortAudit
      deps.abortAudit('set_task_goal 改了目标')
      return { output: JSON.stringify({ ok: true }), isError: false }
    },
  }
}

function makeBufferEntry(content: string): OutboundBufferEntry {
  return {
    channel_id: 'ch-test',
    session_id: 'sess-test',
    content,
    intent: 'info',
    sent_at_attempt_ms: Date.now(),
  }
}

/**
 * 装配一套与 agent-handler 等价的最小 callback 集合。
 * outboundBuffer / activeAuditId / channelSendSpy / abortControllers / abortAudit closure
 * 都拼在一起，让 runEngine 跑出的行为反映真实数据流。
 */
function makeWiring() {
  const outboundBuffer: Array<OutboundBufferEntry> = []
  let activeAuditId: string | undefined
  const abortControllers = new Map<string, AbortController>()
  const channelSendSpy = vi.fn(async (entry: OutboundBufferEntry) => ({
    platform_message_id: `m-${entry.content.slice(0, 8)}`,
    sent_at: new Date().toISOString(),
  }))

  // flushOutboundBuffer：splice + dispatch + continue on error（与 createOutboundFlush 一致）。
  const flushOutboundBuffer = async (): Promise<void> => {
    if (outboundBuffer.length === 0) return
    const entries = outboundBuffer.splice(0)
    for (const entry of entries) {
      try {
        await channelSendSpy(entry)
      } catch (err) {
        console.warn('[test wiring] flush entry failed:', err)
      }
    }
  }

  const dropOutboundBuffer = (): void => {
    outboundBuffer.length = 0
  }

  const clearActiveAuditId = (): void => {
    activeAuditId = undefined
  }

  const hasActiveAudit = (): boolean => activeAuditId !== undefined

  // abortAudit closure：复刻 agent-handler.ts:848 内同名 helper。
  // 1. controller.abort  2. 清 outboundBuffer + activeAuditId  3. push <audit_aborted> marker
  const makeAbortAudit = (humanQueue: HumanMessageQueue) => (reason: string): void => {
    const id = activeAuditId
    if (!id) return
    const controller = abortControllers.get(id)
    if (controller) {
      try { controller.abort() } catch { /* ignore */ }
    }
    outboundBuffer.length = 0
    activeAuditId = undefined
    try {
      humanQueue.push(buildAuditAbortedMarker({ auditId: id, reason }))
    } catch { /* ignore */ }
  }

  return {
    outboundBuffer,
    abortControllers,
    channelSendSpy,
    flushOutboundBuffer,
    dropOutboundBuffer,
    clearActiveAuditId,
    hasActiveAudit,
    makeAbortAudit,
    getActiveAuditId: () => activeAuditId,
    setActiveAuditId: (id: string | undefined): void => { activeAuditId = id },
  }
}

/**
 * 构造 endTurnGate 闭包——模拟 createAsyncAuditEndTurnGate 行为：
 *  - buffer 空 → null（透明放行）
 *  - buffer 非空 + 未派 audit → 设 activeAuditId + 返回 [audit_pending] marker；
 *    onSpawn 回调让测试控制 audit 完成时机
 *  - audit 已派出（hasSpawned=true）→ null（drain 路径完成后 audit 清掉，gate 直接放行）
 */
function makeEndTurnGate(deps: {
  outboundBuffer: ReadonlyArray<OutboundBufferEntry>
  setActiveAuditId: (id: string) => void
  auditId: string
  onSpawn?: (auditId: string) => void
}): () => Promise<string | null> {
  let spawned = false
  return async () => {
    if (spawned) return null
    if (deps.outboundBuffer.length === 0) return null
    spawned = true
    deps.setActiveAuditId(deps.auditId)
    deps.onSpawn?.(deps.auditId)
    return buildAuditPendingMarker({ auditId: deps.auditId })
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('E2E: goal-audit async flow', () => {
  // -------------------------------------------------------------------------
  // Case A: iter 52 scenario — 假交付不到达用户
  // -------------------------------------------------------------------------
  it('Case A: buffered info + audit fail → 消息 NOT 到 channel + detailedReport 注入续 turn', async () => {
    const wiring = makeWiring()
    const queue = new HumanMessageQueue()
    const injections: Array<{ type: string; text: string }> = []

    // 测试前置：buffer 已含一条 "已完成" 消息（模拟 agent 已调 send_message 缓冲）
    wiring.outboundBuffer.push(makeBufferEntry('已完成'))

    // endTurnGate 模拟：第一次 end_turn 派 audit + 设 activeAuditId，
    // 然后异步推 fail marker 模拟 audit subagent 跑完后 onExit
    const endTurnGate = makeEndTurnGate({
      outboundBuffer: wiring.outboundBuffer,
      setActiveAuditId: wiring.setActiveAuditId,
      auditId: 'audit-A',
      onSpawn: (auditId) => {
        setTimeout(() => {
          queue.push(
            buildAuditResultMarker({
              auditId,
              pass: false,
              failedCriteria: ['未发送最终成绩单'],
              detailedReport: '你说"我搞定了"但 send_message 还在缓冲里没发出。',
            }),
          )
        }, 30)
      },
    })

    // worker flow:
    //  turn 1: end_turn → endTurnGate 派 audit + 注入 [audit_pending]
    //  turn 2: 审计 barrier → wait → audit fail marker → drain fail → drop buffer + 注入 detailedReport
    //  turn 3: end_turn → endTurnGate (buffer 空)→ null → completed
    const adapter = makeAdapter([
      { kind: 'audit_barrier', text: '搞定' },
      { kind: 'tool', toolId: 't1', toolName: 'audit_barrier' },
      { kind: 'audit_barrier', text: '改完了' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [makeWaitTool(queue)],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate,
        flushOutboundBuffer: wiring.flushOutboundBuffer,
        dropOutboundBuffer: wiring.dropOutboundBuffer,
        clearActiveAuditId: wiring.clearActiveAuditId,
        hasActiveAudit: wiring.hasActiveAudit,
        abortActiveAudit: wiring.makeAbortAudit(queue),
        onSystemInjection: (e) =>
          injections.push({ type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')
    // 核心断言: channel 从未被调用 with "已完成"（buffer drop 而不是 flush）
    expect(wiring.channelSendSpy).not.toHaveBeenCalled()
    // detailedReport 应被注入续 turn
    const failReport = injections.find((e) => e.text.includes('未发送最终成绩单'))
    expect(failReport).toBeDefined()
    expect(failReport?.text).toContain('你说"我搞定了"')
    // outboundBuffer 已被清空（drop）
    expect(wiring.outboundBuffer.length).toBe(0)
    // activeAuditId 已被清掉（drain fail 路径调 clearActiveAuditId）
    expect(wiring.getActiveAuditId()).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Case B: audit pass → buffer flush → 直接 buildResult completed
  // -------------------------------------------------------------------------
  it('Case B: buffered info + audit pass + 无 pending → flush 到 channel + buildResult completed', async () => {
    const wiring = makeWiring()
    const queue = new HumanMessageQueue()

    wiring.outboundBuffer.push(makeBufferEntry('任务完成报告'))

    const endTurnGate = makeEndTurnGate({
      outboundBuffer: wiring.outboundBuffer,
      setActiveAuditId: wiring.setActiveAuditId,
      auditId: 'audit-B',
      onSpawn: (auditId) => {
        setTimeout(() => {
          queue.push(
            buildAuditResultMarker({
              auditId,
              pass: true,
              failedCriteria: [],
              detailedReport: '',
            }),
          )
        }, 30)
      },
    })

    // worker flow:
    //  turn 1: end_turn → endTurnGate 派 audit + 注入 [audit_pending]
    //  turn 2: 审计 barrier → → audit pass → drain pass + flush + buildResult completed（无后续 LLM）
    const adapter = makeAdapter([
      { kind: 'audit_barrier', text: '搞定' },
      { kind: 'tool', toolId: 't1', toolName: 'audit_barrier' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [makeWaitTool(queue)],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate,
        flushOutboundBuffer: wiring.flushOutboundBuffer,
        dropOutboundBuffer: wiring.dropOutboundBuffer,
        clearActiveAuditId: wiring.clearActiveAuditId,
        hasActiveAudit: wiring.hasActiveAudit,
        abortActiveAudit: wiring.makeAbortAudit(queue),
      },
    })

    expect(result.outcome).toBe('completed')
    // 核心断言: channel 被调用一次发出缓冲的最终交付
    expect(wiring.channelSendSpy).toHaveBeenCalledTimes(1)
    expect(wiring.channelSendSpy.mock.calls[0][0].content).toBe('任务完成报告')
    // buffer flush 后为空
    expect(wiring.outboundBuffer.length).toBe(0)
    // activeAuditId 已清
    expect(wiring.getActiveAuditId()).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Case C: supplement 改 goal mid-audit → abort audit + drop buffer
  // -------------------------------------------------------------------------
  it('Case C: supplement 改 goal mid-audit → abort audit subagent + drop outboundBuffer + 注入 aborted 提示', async () => {
    const wiring = makeWiring()
    const queue = new HumanMessageQueue()
    const injections: Array<{ type: string; text: string }> = []

    wiring.outboundBuffer.push(makeBufferEntry('我搞定了原目标'))

    // 模拟 audit subagent 的 abort controller（abortAudit 会调它）
    const auditId = 'audit-C'
    const auditAbortController = new AbortController()
    const auditAbortSpy = vi.fn(() => auditAbortController.abort())
    wiring.abortControllers.set(auditId, {
      abort: auditAbortSpy,
      signal: auditAbortController.signal,
    } as unknown as AbortController)

    // endTurnGate：派 audit 但 audit 不自然完成（被 abort 中断），
    // onSpawn 推 supplement 模拟用户改 goal 的指令
    const endTurnGate = makeEndTurnGate({
      outboundBuffer: wiring.outboundBuffer,
      setActiveAuditId: wiring.setActiveAuditId,
      auditId,
      onSpawn: () => {
        setTimeout(() => {
          queue.push('用户：换个目标，改成讨论今天的天气')
        }, 30)
      },
    })

    // 跟踪 abortAudit 被调时 buffer 是否真有内容——验证 abort drop 不是空操作。
    let bufferLenAtAbort = -1
    const trackingAbortAudit = wiring.makeAbortAudit(queue)
    const setGoalTool = makeSetTaskGoalTool({
      abortAudit: (reason: string) => {
        bufferLenAtAbort = wiring.outboundBuffer.length
        trackingAbortAudit(reason)
      },
    })

    // worker flow:
    //  turn 1: end_turn → spawn audit-C → [audit_pending]
    //  turn 2: 审计 barrier → → supplement push 唤醒 → drain supplement → 续 turn
    //  turn 3: set_task_goal → abortAudit → controller.abort + drop buffer + push aborted marker
    //  turn 4: 触发 post-tool drain → 看到 aborted marker → 注入"audit 已废"提示 + 续 turn
    //  turn 5: end_turn → buffer 空 + audit 已清 → completed
    const adapter = makeAdapter([
      { kind: 'audit_barrier', text: '完毕' },
      { kind: 'tool', toolId: 't1', toolName: 'audit_barrier' },
      { kind: 'tool', toolId: 't2', toolName: 'set_task_goal', input: { goal: '讨论今天的天气' } },
      { kind: 'audit_barrier', text: '收到新目标' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [makeWaitTool(queue), setGoalTool],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate,
        flushOutboundBuffer: wiring.flushOutboundBuffer,
        dropOutboundBuffer: wiring.dropOutboundBuffer,
        clearActiveAuditId: wiring.clearActiveAuditId,
        hasActiveAudit: wiring.hasActiveAudit,
        abortActiveAudit: wiring.makeAbortAudit(queue),
        onSystemInjection: (e) =>
          injections.push({ type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')
    // 核心断言 1: audit subagent abortController 被调用（set_task_goal 触发 abortAudit）
    expect(auditAbortSpy).toHaveBeenCalledTimes(1)
    // 核心断言 2: outboundBuffer 在 abortAudit 之后为空（abortAudit 内的 drop 实际清掉了内容）
    expect(wiring.outboundBuffer.length).toBe(0)
    // 核心断言 3: pre-audit buffered 消息绝不到 channel——
    // 等审态下 tool_use 续 turn 不得 flush（spec §4.1 "未审消息不到达用户"）
    expect(wiring.channelSendSpy).not.toHaveBeenCalled()
    // 核心断言 4: abortAudit 触发时 buffer 非空——证明 abort drop 不是空操作，
    // 真的丢弃了 pre-audit 候选交付（"我搞定了原目标"）
    expect(bufferLenAtAbort).toBeGreaterThan(0)
    // 核心断言 5: audit_aborted marker 走 drain → 注入"已被取消"提示
    const abortNotice = injections.find((e) =>
      e.text.includes(auditId) && e.text.includes('已被取消'),
    )
    expect(abortNotice).toBeDefined()
    expect(abortNotice?.text).toContain('set_task_goal 改了目标')
    // 核心断言 6: activeAuditId 已被清掉
    expect(wiring.getActiveAuditId()).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Case E: 等审态 + tool_use 续 turn 不 flush buffer
  // -------------------------------------------------------------------------
  it('Case E: 等审态 tool_use 续 turn 不 flush + end_turn 直接挂起等 audit（spec 2026-07-16 §3.2）', async () => {
    // 验证 query-loop 的等审态 guard + 新挂起路径:
    // - outboundBuffer 含 1 个 pre-audit final 候选，activeAuditId 已设（等审态）
    // - turn 1: Bash tool_use → 续 turn 时等审态 guard 拦截 flush（pre-audit 内容不泄漏）
    // - turn 2: end_turn → engine 直接挂起（不注入拦截文案、不烧额外 LLM 轮）
    // - audit pass marker 到达 → drain pass → clear + flush → completed
    // 关键断言：pass 之前 channel 绝不收到 pre-audit 内容；pass 后恰好 flush 一次
    const wiring = makeWiring()
    const queue = new HumanMessageQueue()
    const injections: Array<{ type: string; text: string }> = []

    wiring.outboundBuffer.push(makeBufferEntry('pre-audit 候选交付'))
    wiring.setActiveAuditId('audit-E')

    // 简单的 Bash 工具——立即返回，不设 barrier
    const bashTool: ToolDefinition = {
      name: 'Bash',
      description: 'run shell command',
      inputSchema: { type: 'object' as const, properties: {} },
      isReadOnly: true,
      call: async () => ({ output: 'ok', isError: false }),
    }

    // adapter:
    //  turn 1: Bash tool_use → 续 turn 前 flush 被等审态 guard 拦截
    //  turn 2: end_turn → 等审态 → 直接挂起等 audit 结果
    const adapter = makeAdapter([
      { kind: 'tool', toolId: 't1', toolName: 'Bash' },
      { kind: 'audit_barrier', text: '完毕' },
    ])

    // 挂起后 audit pass 到达；push 前采样 channel 调用数——验证 pass 前零泄漏
    let sendCountBeforePass = -1
    setTimeout(() => {
      sendCountBeforePass = wiring.channelSendSpy.mock.calls.length
      queue.push(
        buildAuditResultMarker({
          auditId: 'audit-E',
          pass: true,
          failedCriteria: [],
          detailedReport: '',
        }),
      )
    }, 50)

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [bashTool],
        systemPrompt: '',
        model: 'test-model',
        // 不传 endTurnGate——聚焦 hasActiveAudit 挂起路径本身
        flushOutboundBuffer: wiring.flushOutboundBuffer,
        dropOutboundBuffer: wiring.dropOutboundBuffer,
        clearActiveAuditId: wiring.clearActiveAuditId,
        hasActiveAudit: wiring.hasActiveAudit,
        onSystemInjection: (e) =>
          injections.push({ type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')
    // 核心断言 1: audit pass 之前 channel 零调用——tool_use 续 turn 的 flush 被 guard 拦截
    expect(sendCountBeforePass).toBe(0)
    // 核心断言 2: pass 后 flush 恰好一次、buffer 清空
    expect(wiring.channelSendSpy).toHaveBeenCalledTimes(1)
    expect(wiring.outboundBuffer.length).toBe(0)
    // 核心断言 3: 全程零拦截文案注入、零额外 LLM 轮（挂起不经过 LLM）
    expect(injections.filter((e) => e.type === 'audit_pending_intercept')).toHaveLength(0)
    expect(result.totalTurns).toBe(2)
    // 核心断言 4: activeAuditId 已被 drain pass 路径清掉
    expect(wiring.getActiveAuditId()).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Case D: 审计 barrier yield → audit complete → drain pass 完整链路
  // -------------------------------------------------------------------------
  it('Case D: 审计 barrier yields + audit completes pass → drain pass + flush + complete (顺序验证)', async () => {
    // 这个 case 细化验证 审计 barrier → → marker push → drain pass 的完整链路。
    // 与 Case B 的区别：明确验证事件顺序（spawn → wait → push → send）。
    const wiring = makeWiring()
    const queue = new HumanMessageQueue()
    const events: string[] = []

    wiring.outboundBuffer.push(makeBufferEntry('已完成最终交付'))

    // wait tool 记录被调用
    const waitTool = makeWaitTool(queue, () => {
      events.push('audit_barrier_called')
    })

    const auditId = 'audit-D'
    const endTurnGate = makeEndTurnGate({
      outboundBuffer: wiring.outboundBuffer,
      setActiveAuditId: wiring.setActiveAuditId,
      auditId,
      onSpawn: (id) => {
        events.push(`audit_spawn:${id}`)
        // 模拟 audit subagent 跑 50ms 后 onExit push 结果
        setTimeout(() => {
          events.push('audit_push_pass')
          queue.push(
            buildAuditResultMarker({
              auditId: id,
              pass: true,
              failedCriteria: [],
              detailedReport: '',
            }),
          )
        }, 50)
      },
    })

    // 自定义 flushFn 跟踪 send 顺序
    const channelSpy = vi.fn(async (entry: OutboundBufferEntry) => {
      events.push(`channel_send:${entry.content}`)
      return { platform_message_id: 'm-D', sent_at: '2026-06-08T00:00:00Z' }
    })
    const flushWithSpy = async (): Promise<void> => {
      if (wiring.outboundBuffer.length === 0) return
      const entries = wiring.outboundBuffer.splice(0)
      for (const entry of entries) {
        try {
          await channelSpy(entry)
        } catch { /* ignore */ }
      }
    }

    const adapter = makeAdapter([
      { kind: 'audit_barrier', text: '完毕' },
      { kind: 'tool', toolId: 't1', toolName: 'audit_barrier' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [waitTool],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate,
        flushOutboundBuffer: flushWithSpy,
        dropOutboundBuffer: wiring.dropOutboundBuffer,
        clearActiveAuditId: wiring.clearActiveAuditId,
        hasActiveAudit: wiring.hasActiveAudit,
        abortActiveAudit: wiring.makeAbortAudit(queue),
      },
    })

    expect(result.outcome).toBe('completed')
    // 核心断言: channel send 被调一次发出最终交付
    expect(channelSpy).toHaveBeenCalledTimes(1)
    expect(channelSpy.mock.calls[0][0].content).toBe('已完成最终交付')

    // 顺序验证：audit_spawn → audit_barrier_called → audit_push_pass → channel_send
    const idxSpawn = events.findIndex((e) => e.startsWith('audit_spawn'))
    const idxWait = events.indexOf('audit_barrier_called')
    const idxPush = events.indexOf('audit_push_pass')
    const idxSend = events.findIndex((e) => e === 'channel_send:已完成最终交付')
    expect(idxSpawn).toBeGreaterThanOrEqual(0)
    expect(idxWait).toBeGreaterThan(idxSpawn)
    expect(idxPush).toBeGreaterThan(idxWait)
    expect(idxSend).toBeGreaterThan(idxPush)

    // activeAuditId 已清，buffer 已清
    expect(wiring.getActiveAuditId()).toBeUndefined()
    expect(wiring.outboundBuffer.length).toBe(0)
  })
})
