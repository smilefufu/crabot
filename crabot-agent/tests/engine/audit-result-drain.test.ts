/**
 * Query-loop drain 识别 audit_result / audit_aborted system marker 走 pass/fail/abort 分支.
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.5
 *
 * 三条主路径：
 *   - audit_result.pass=true  → flushOutboundBuffer + clearActiveAuditId
 *                              + 无后续 pending 时 buildResult('completed') 直接退
 *   - audit_result.pass=false → dropOutboundBuffer + clearActiveAuditId
 *                              + 注入 detailedReport 续 turn
 *   - audit_aborted          → clearActiveAuditId + 注入"原 audit 已废"提示续 turn
 *
 * Marker 主要从 end_turn setBarrier → audit subagent 完成 push → post-tool drain 路径进入；
 * 防御性也覆盖 end_turn pre-supplement drain 路径。
 */

import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import { buildAuditResultMarker, buildAuditAbortedMarker } from '../../src/agent/audit-result-marker.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import { chunksFromContent } from './helpers/mock-stream.js'

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
          [
            {
              type: 'tool_use' as const,
              id: s.toolId,
              name: s.toolName,
              input: s.input ?? {},
            },
          ],
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

// 审计 barrier 测试工具：调用时 setBarrier；audit_result push 进 queue 后会自动 clearBarrier。
function makeWaitTool(queue: HumanMessageQueue, name = 'audit_barrier'): {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown> }
  isReadOnly: true
  call: () => Promise<{ output: string; isError: false }>
} {
  return {
    name,
    description: 'wait for signal',
    inputSchema: { type: 'object' as const, properties: {} },
    isReadOnly: true,
    call: async () => {
      // setBarrier 让 post-tool 阶段进入 waitBarrier；push 之后自动 clearBarrier
      queue.setBarrier(60_000)
      return { output: 'waiting', isError: false }
    },
  }
}

describe('query-loop: audit_result marker drain dispatch', () => {
  it('pass + 无 pending → flush buffer + clearActiveAuditId + buildResult(completed)', async () => {
    const queue = new HumanMessageQueue()
    const flushSpy = vi.fn(async () => { /* noop */ })
    const dropSpy = vi.fn()
    const clearAuditSpy = vi.fn()

    // turn 1: end_turn (setBarrier)
    // post-tool barrier wait → audit pass push 唤醒 → drain dispatcher 看到 pass + 无剩余 → 退
    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu1', toolName: 'audit_barrier' },
    ])

    // 异步在 setBarrier 之后 push pass marker
    setTimeout(() => {
      queue.push(
        buildAuditResultMarker({
          auditId: 'audit-pass-1',
          pass: true,
          failedCriteria: [],
          detailedReport: '',
        }),
      )
    }, 30)

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [makeWaitTool(queue)],
        systemPrompt: '',
        model: 'test-model',
        flushOutboundBuffer: flushSpy,
        dropOutboundBuffer: dropSpy,
        clearActiveAuditId: clearAuditSpy,
      },
    })

    expect(result.outcome).toBe('completed')
    expect(flushSpy).toHaveBeenCalledTimes(1)
    expect(dropSpy).not.toHaveBeenCalled()
    expect(clearAuditSpy).toHaveBeenCalledTimes(1)
    // 仅一轮 LLM 调用——pass + 无剩余直接退，不续 turn
    expect(result.totalTurns).toBe(1)
  })

  it('pass + 有 supplement pending → flush + 注入 supplement + 续 turn', async () => {
    const queue = new HumanMessageQueue()
    const flushSpy = vi.fn(async () => {})
    const clearAuditSpy = vi.fn()
    const injections: Array<{ type: string; text: string; turnNumber: number }> = []

    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu1', toolName: 'audit_barrier' },
      { kind: 'audit_barrier', text: '回复完毕' }, // 续 turn 响应 supplement
    ])

    // pass marker + supplement 同时 push（supplement 排在 pass 之后）
    setTimeout(() => {
      queue.push(
        buildAuditResultMarker({
          auditId: 'audit-pass-2',
          pass: true,
          failedCriteria: [],
          detailedReport: '',
        }),
      )
      queue.push('用户补充：再说点别的')
    }, 30)

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [makeWaitTool(queue)],
        systemPrompt: '',
        model: 'test-model',
        flushOutboundBuffer: flushSpy,
        clearActiveAuditId: clearAuditSpy,
        onSystemInjection: (e) =>
          injections.push({ type: e.type, text: e.text, turnNumber: e.turnNumber }),
      },
    })

    expect(result.outcome).toBe('completed')
    // pass 触发 flush
    expect(flushSpy).toHaveBeenCalled()
    expect(clearAuditSpy).toHaveBeenCalled()
    // supplement 应被注入续 turn
    const supplements = injections.filter((e) => e.type === 'supplement' && e.text.includes('用户补充'))
    expect(supplements.length).toBeGreaterThanOrEqual(1)
    // 至少跑了 2 轮（wait + end_turn）
    expect(result.totalTurns).toBeGreaterThanOrEqual(2)
  })

  it('fail → dropOutboundBuffer + clearActiveAuditId + 注入 detailedReport 续 turn', async () => {
    const queue = new HumanMessageQueue()
    const flushSpy = vi.fn(async () => {})
    const dropSpy = vi.fn()
    const clearAuditSpy = vi.fn()
    const injections: Array<{ type: string; text: string }> = []

    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu1', toolName: 'audit_barrier' },
      { kind: 'audit_barrier', text: '改完了' },
    ])

    setTimeout(() => {
      queue.push(
        buildAuditResultMarker({
          auditId: 'audit-fail-1',
          pass: false,
          failedCriteria: ['未发送最终成绩单', '未告知人类调度结果'],
          detailedReport: '你说"我搞定了"但 send_message 还在缓冲里没发出。',
        }),
      )
    }, 30)

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [makeWaitTool(queue)],
        systemPrompt: '',
        model: 'test-model',
        flushOutboundBuffer: flushSpy,
        dropOutboundBuffer: dropSpy,
        clearActiveAuditId: clearAuditSpy,
        onSystemInjection: (e) =>
          injections.push({ type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')
    expect(dropSpy).toHaveBeenCalledTimes(1)
    expect(clearAuditSpy).toHaveBeenCalledTimes(1)
    // detailedReport 应被注入
    const failReport = injections.find((e) => e.text.includes('人类要求里还没满足的'))
    expect(failReport).toBeDefined()
    expect(failReport?.text).toContain('未发送最终成绩单')
    expect(failReport?.text).toContain('你说"我搞定了"')
    // 续了 turn 让 worker 看到 fail 报告并响应
    expect(result.totalTurns).toBeGreaterThanOrEqual(2)
    // 注：fail 在 marker dispatch 里只调 dropOutboundBuffer，不调 flushOutboundBuffer。
    // 但 marker dispatch 之后 loop 继续，下一 turn 的 stop_reason='tool_use' 续 turn 路径
    // (Task 8) 仍会调 flushOutboundBuffer——那是 buffer 被 drop 后的 no-op flush，跟 marker 分流无关。
  })

  it('aborted → clearActiveAuditId + 注入"audit 已废"提示 + 续 turn', async () => {
    const queue = new HumanMessageQueue()
    const flushSpy = vi.fn(async () => {})
    const dropSpy = vi.fn()
    const clearAuditSpy = vi.fn()
    const injections: Array<{ type: string; text: string }> = []

    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu1', toolName: 'audit_barrier' },
      { kind: 'audit_barrier', text: '收到，按新目标办' },
    ])

    setTimeout(() => {
      queue.push(
        buildAuditAbortedMarker({
          auditId: 'audit-abort-1',
          reason: 'set_task_goal 改了目标',
        }),
      )
    }, 30)

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [makeWaitTool(queue)],
        systemPrompt: '',
        model: 'test-model',
        flushOutboundBuffer: flushSpy,
        dropOutboundBuffer: dropSpy,
        clearActiveAuditId: clearAuditSpy,
        onSystemInjection: (e) =>
          injections.push({ type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')
    expect(clearAuditSpy).toHaveBeenCalledTimes(1)
    // aborted 在 marker dispatch 里不触发 dropOutboundBuffer（buffer 由 set_task_goal 路径自己处理）。
    // flushOutboundBuffer 可能在后续 turn 的 Task 8 路径（stop_reason='tool_use' 续 turn / end_turn 之后）
    // 被调到——但那是 marker dispatch 之外的事，跟 aborted 分流无关。
    expect(dropSpy).not.toHaveBeenCalled()
    // 提示应被注入
    const abortNotice = injections.find((e) =>
      e.text.includes('audit-abort-1') && e.text.includes('已被取消'),
    )
    expect(abortNotice).toBeDefined()
    expect(abortNotice?.text).toContain('set_task_goal 改了目标')
    // 续了 turn 让 worker 按新目标行动
    expect(result.totalTurns).toBeGreaterThanOrEqual(2)
  })

  it('普通 supplement（非 marker）按原 supplement 路径注入', async () => {
    const queue = new HumanMessageQueue()
    const clearAuditSpy = vi.fn()
    const injections: Array<{ type: string; text: string }> = []

    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu1', toolName: 'audit_barrier' },
      { kind: 'audit_barrier', text: '收到' },
    ])

    setTimeout(() => {
      queue.push('用户：辛苦了')
    }, 30)

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [makeWaitTool(queue)],
        systemPrompt: '',
        model: 'test-model',
        clearActiveAuditId: clearAuditSpy,
        onSystemInjection: (e) =>
          injections.push({ type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')
    // 非 marker 不触碰 clearActiveAuditId
    expect(clearAuditSpy).not.toHaveBeenCalled()
    // 普通 supplement 被注入
    const supplement = injections.find((e) => e.type === 'supplement' && e.text === '用户：辛苦了')
    expect(supplement).toBeDefined()
  })

  it('pass marker 通过 end_turn pre-supplement drain 路径也走分流（防御性）', async () => {
    // 场景：worker 直接 end_turn 不调审计 barrier，pass marker 在 end_turn 之后到达
    // L221 drain → 也应分流到 marker dispatcher
    const queue = new HumanMessageQueue()
    const flushSpy = vi.fn(async () => {})
    const clearAuditSpy = vi.fn()

    const adapter = makeAdapter([
      { kind: 'audit_barrier', text: '我做完了' },
    ])

    // 在 end_turn 处理前把 pass marker 塞进 queue
    queue.push(
      buildAuditResultMarker({
        auditId: 'audit-pass-3',
        pass: true,
        failedCriteria: [],
        detailedReport: '',
      }),
    )

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        flushOutboundBuffer: flushSpy,
        clearActiveAuditId: clearAuditSpy,
      },
    })

    expect(result.outcome).toBe('completed')
    expect(flushSpy).toHaveBeenCalledTimes(1)
    expect(clearAuditSpy).toHaveBeenCalledTimes(1)
  })

  it('fail marker 通过 end_turn pre-supplement drain 路径也走分流（防御性）', async () => {
    const queue = new HumanMessageQueue()
    const flushSpy = vi.fn(async () => {})
    const dropSpy = vi.fn()
    const clearAuditSpy = vi.fn()
    const injections: Array<{ type: string; text: string }> = []

    const adapter = makeAdapter([
      { kind: 'audit_barrier', text: '我做完了' },
      { kind: 'audit_barrier', text: '补做完了' },
    ])

    queue.push(
      buildAuditResultMarker({
        auditId: 'audit-fail-2',
        pass: false,
        failedCriteria: ['缺成绩单'],
        detailedReport: '差一项',
      }),
    )

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        flushOutboundBuffer: flushSpy,
        dropOutboundBuffer: dropSpy,
        clearActiveAuditId: clearAuditSpy,
        onSystemInjection: (e) =>
          injections.push({ type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')
    expect(dropSpy).toHaveBeenCalledTimes(1)
    expect(clearAuditSpy).toHaveBeenCalledTimes(1)
    // 注：marker dispatch 自身不调 flushOutboundBuffer；后续 turn 的 end_turn 之后 flush（Task 8）
    // 是独立路径——这里允许被调用。
    const failReport = injections.find((e) => e.text.includes('缺成绩单'))
    expect(failReport).toBeDefined()
  })

  it('callbacks not provided → 不抛错（backward compat）', async () => {
    const queue = new HumanMessageQueue()
    queue.push(
      buildAuditResultMarker({
        auditId: 'audit-pass-4',
        pass: true,
        failedCriteria: [],
        detailedReport: '',
      }),
    )

    const adapter = makeAdapter([
      { kind: 'audit_barrier', text: '完毕' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        // 三个 callback 都不传
      },
    })

    expect(result.outcome).toBe('completed')
  })
})
