/**
 * audit 跑中 LLM 直接 end_turn → engine 直接挂起等 audit 结果（2026-07-16 重设计）.
 *
 * spec: 2026-07-16-wait-signal-targets-goal-lifecycle-design §3.2
 * （取代 2026-06-07 §4.6 的"注入拦截文案 → LLM 调 wait_for_signal"路径——
 *   那套文案会教坏 agent 主动 wait audit，见 trace ac9676e3 空转实证）
 *
 * 新行为：
 *   - end_turn + hasActiveAudit=true → engine setBarrier 挂起，零文案注入、零额外 LLM 轮
 *   - audit pass marker 到达 → drain 分流 → flush + 退出 completed
 *   - audit fail marker 到达 → drain 注入缺口报告 → 续 turn
 *   - 挂起幂等可重入：人类追问唤醒 → 处理 → 再 end_turn → 再挂起（B-追问重入）
 */

import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import { buildAuditResultMarker } from '../../src/agent/audit-result-marker.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import { chunksFromContent } from './helpers/mock-stream.js'

type AdapterStep =
  | { kind: 'tool'; toolId: string; toolName: string; input?: Record<string, unknown> }
  | { kind: 'end_turn'; text: string }

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

function passMarker(auditId: string): string {
  return buildAuditResultMarker({ auditId, pass: true, failedCriteria: [], detailedReport: '' })
}

function failMarker(auditId: string): string {
  return buildAuditResultMarker({
    auditId,
    pass: false,
    failedCriteria: ['c1'],
    detailedReport: '缺口：c1 未覆盖',
  })
}

describe('query-loop: audit 跑中 end_turn → engine 直接挂起（spec 2026-07-16 §3.2）', () => {
  it('end_turn + audit 在跑 → 挂起等 pass marker → 退出 completed；零拦截文案、零额外 LLM 轮', async () => {
    const queue = new HumanMessageQueue()
    const injections: Array<{ type: string }> = []
    let auditActive = true
    const clearActiveAuditId = vi.fn(() => { auditActive = false })
    const flushSpy = vi.fn(async () => {})

    const adapter = makeAdapter([{ kind: 'end_turn', text: '搞定' }])

    // 挂起后再推 pass marker（模拟 audit 异步完成）
    setTimeout(() => queue.push(passMarker('audit-1')), 30)

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        hasActiveAudit: () => auditActive,
        clearActiveAuditId,
        flushOutboundBuffer: flushSpy,
        dropOutboundBuffer: vi.fn(),
        onSystemInjection: (e) => injections.push({ type: e.type }),
      },
    })

    expect(result.outcome).toBe('completed')
    expect(result.totalTurns).toBe(1)
    expect(injections.filter((e) => e.type === 'audit_pending_intercept')).toHaveLength(0)
    expect(clearActiveAuditId).toHaveBeenCalled()
    expect(flushSpy).toHaveBeenCalled()
  })

  it('挂起等到 fail marker → 注入缺口报告续 turn，第二轮正常收尾', async () => {
    const queue = new HumanMessageQueue()
    const injections: Array<{ type: string; text: string }> = []
    let auditActive = true
    const clearActiveAuditId = vi.fn(() => { auditActive = false })
    const dropSpy = vi.fn()

    // turn 1 end_turn → 挂起 → fail → 续 turn 2 → audit 已清 → 正常 end_turn
    const adapter = makeAdapter([
      { kind: 'end_turn', text: '搞定' },
      { kind: 'end_turn', text: '补完了' },
    ])
    setTimeout(() => queue.push(failMarker('audit-2')), 30)

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        hasActiveAudit: () => auditActive,
        clearActiveAuditId,
        flushOutboundBuffer: vi.fn(async () => {}),
        dropOutboundBuffer: dropSpy,
        onSystemInjection: (e) => injections.push({ type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')
    expect(result.totalTurns).toBe(2)
    expect(injections.filter((e) => e.type === 'audit_pending_intercept')).toHaveLength(0)
    expect(dropSpy).toHaveBeenCalled()
    expect(clearActiveAuditId).toHaveBeenCalled()
  })

  it('B-追问重入：挂起中人类消息唤醒 → 处理后再 end_turn → 再次挂起 → pass 后退出', async () => {
    const queue = new HumanMessageQueue()
    const injections: Array<{ type: string; text: string }> = []
    let auditActive = true
    const clearActiveAuditId = vi.fn(() => { auditActive = false })

    // turn 1 end_turn → 挂起 → 人类追问唤醒续 turn 2 → end_turn → 再挂起 → pass → 退出
    const adapter = makeAdapter([
      { kind: 'end_turn', text: '搞定' },
      { kind: 'end_turn', text: '回答了追问' },
    ])
    setTimeout(() => queue.push('顺便问一下，昨天那个也是这个原因吗？'), 30)
    setTimeout(() => queue.push(passMarker('audit-3')), 120)

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        hasActiveAudit: () => auditActive,
        clearActiveAuditId,
        flushOutboundBuffer: vi.fn(async () => {}),
        dropOutboundBuffer: vi.fn(),
        onSystemInjection: (e) => injections.push({ type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')
    // 两轮 LLM：原始 end_turn + 追问处理轮；两次挂起都不烧额外轮次
    expect(result.totalTurns).toBe(2)
    expect(injections.filter((e) => e.type === 'audit_pending_intercept')).toHaveLength(0)
    // 追问以 supplement 注入
    expect(injections.some((e) => e.type === 'supplement' && e.text.includes('昨天那个'))).toBe(true)
  })

  it('hasActiveAudit=false 时不挂起，正常 end_turn', async () => {
    const injections: Array<{ type: string }> = []
    const adapter = makeAdapter([{ kind: 'end_turn', text: '搞定' }])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: new HumanMessageQueue(),
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        hasActiveAudit: () => false,
        onSystemInjection: (e) => injections.push({ type: e.type }),
      },
    })

    expect(result.outcome).toBe('completed')
    expect(result.totalTurns).toBe(1)
  })

  it('drain 期间 audit_result(pass) 到达 → hasActiveAudit 转 false → 不挂起', async () => {
    const queue = new HumanMessageQueue()
    const flushSpy = vi.fn(async () => {})
    let auditActive = true
    const clearActiveAuditId = vi.fn(() => { auditActive = false })

    // queue 预先 push pass marker —— end_turn 前的 drain 拿到并清 audit
    queue.push(passMarker('audit-mid-1'))

    const adapter = makeAdapter([{ kind: 'end_turn', text: '搞定' }])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        hasActiveAudit: () => auditActive,
        clearActiveAuditId,
        flushOutboundBuffer: flushSpy,
        dropOutboundBuffer: vi.fn(),
      },
    })

    expect(result.outcome).toBe('completed')
    expect(clearActiveAuditId).toHaveBeenCalled()
    expect(flushSpy).toHaveBeenCalled()
  })

  it('callbacks not provided → 不抛错（backward compat）', async () => {
    const adapter = makeAdapter([{ kind: 'end_turn', text: '搞定' }])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: new HumanMessageQueue(),
        tools: [],
        systemPrompt: '',
        model: 'test-model',
      },
    })

    expect(result.outcome).toBe('completed')
    expect(result.totalTurns).toBe(1)
  })
})
