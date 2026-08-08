/**
 * query-loop: endTurnGate 返回 { kind: 'wait' } 的直接挂起路径。
 *
 * Phase 4（spec 2026-06-10-audit-anchor-human-request §4.7）：
 * gate 派出 audit 后返回 wait 信号，engine 直接 setBarrier 挂起等 humanQueue push，
 * 取代旧的「注入 [audit_pending] 文本 → LLM 调 end_turn」往返。
 * 核心断言：等待期间不发生额外 LLM 调用（totalTurns 不为等待 +1）。
 */

import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop'
import { HumanMessageQueue } from '../../src/engine/human-message-queue'
import { buildAuditResultMarker } from '../../src/agent/audit-result-marker'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types'
import { chunksFromContent } from './helpers/mock-stream'

type AdapterStep = { kind: 'end_turn'; text: string }

function makeAdapter(steps: ReadonlyArray<AdapterStep>): LLMAdapter {
  let i = 0
  return {
    stream: vi.fn(async function* () {
      const s = steps[i++] ?? steps[steps.length - 1]
      yield* chunksFromContent(
        [{ type: 'text' as const, text: s.text }],
        'end_turn',
        { inputTokens: 10, outputTokens: 5 },
      )
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

describe('query-loop: endTurnGate wait 直接挂起', () => {
  it('wait → audit pass push 唤醒 → flush + 退出；全程仅 1 次 LLM 调用（不再为 wait 烧轮次）', async () => {
    const queue = new HumanMessageQueue()
    const flushSpy = vi.fn(async () => {})
    const clearAuditSpy = vi.fn()
    const gate = vi.fn(async () => ({ kind: 'wait' as const }))

    setTimeout(() => {
      queue.push(
        buildAuditResultMarker({
          auditId: 'audit-w1',
          pass: true,
          failedCriteria: [],
          detailedReport: '',
        }),
      )
    }, 30)

    const result = await runEngine({
      prompt: 'go',
      adapter: makeAdapter([{ kind: 'end_turn', text: '完工' }]),
      options: {
        humanMessageQueue: queue,
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate: gate,
        flushOutboundBuffer: flushSpy,
        clearActiveAuditId: clearAuditSpy,
      },
    })

    expect(result.outcome).toBe('completed')
    expect(gate).toHaveBeenCalledTimes(1)
    expect(flushSpy).toHaveBeenCalledTimes(1)
    expect(clearAuditSpy).toHaveBeenCalledTimes(1)
    // 关键：挂起等待不经过 LLM——只有 turn 1 那一次调用
    expect(result.totalTurns).toBe(1)
  })

  it('wait → audit fail push 唤醒 → drop buffer + 注入差距报告续 turn', async () => {
    const queue = new HumanMessageQueue()
    const dropSpy = vi.fn()
    const clearAuditSpy = vi.fn()
    const injections: Array<{ type: string; text: string }> = []
    // 第一次 end_turn → wait；续作后第二次 end_turn → 放行
    const gate = vi
      .fn<[], Promise<{ kind: 'wait' } | null>>()
      .mockResolvedValueOnce({ kind: 'wait' })
      .mockResolvedValue(null)

    setTimeout(() => {
      queue.push(
        buildAuditResultMarker({
          auditId: 'audit-w2',
          pass: false,
          failedCriteria: ['req-自由缩放'],
          detailedReport: '缩放配置未生效',
        }),
      )
    }, 30)

    const result = await runEngine({
      prompt: 'go',
      adapter: makeAdapter([
        { kind: 'end_turn', text: '完工' },
        { kind: 'end_turn', text: '已补缺口' },
      ]),
      options: {
        humanMessageQueue: queue,
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate: gate,
        dropOutboundBuffer: dropSpy,
        clearActiveAuditId: clearAuditSpy,
        onSystemInjection: (e) => injections.push({ type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')
    expect(dropSpy).toHaveBeenCalledTimes(1)
    expect(clearAuditSpy).toHaveBeenCalledTimes(1)
    // 差距报告作为 user message 注入，续了 turn
    const failReport = injections.find((e) => e.text.includes('人类要求里还没满足的'))
    expect(failReport).toBeDefined()
    expect(failReport?.text).toContain('req-自由缩放')
    expect(result.totalTurns).toBe(2)
  })

  it('wait 期间用户 supplement 先到 → 注入 supplement 续 turn（audit 结果稍后照常处理）', async () => {
    const queue = new HumanMessageQueue()
    const injections: Array<{ type: string; text: string }> = []
    const gate = vi
      .fn<[], Promise<{ kind: 'wait' } | null>>()
      .mockResolvedValueOnce({ kind: 'wait' })
      .mockResolvedValue(null)

    setTimeout(() => {
      queue.push('用户补充：顺便把颜色也改了')
    }, 30)

    const result = await runEngine({
      prompt: 'go',
      adapter: makeAdapter([
        { kind: 'end_turn', text: '完工' },
        { kind: 'end_turn', text: '好的处理补充' },
      ]),
      options: {
        humanMessageQueue: queue,
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate: gate,
        onSystemInjection: (e) => injections.push({ type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')
    const supp = injections.find((e) => e.text.includes('用户补充'))
    expect(supp).toBeDefined()
    expect(result.totalTurns).toBe(2)
  })
})
