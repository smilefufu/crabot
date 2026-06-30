/**
 * EngineOptions.flushOutboundBuffer 钩子触发时机.
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 8
 *
 * Engine 在两个时机调 flushOutboundBuffer：
 *   1) stop_reason='tool_use' 续 turn 之前（agent 还在干活，上一轮缓冲的 info 是"过程信息"）
 *   2) endTurnGate 返回 null 之后、buildResult 之前（audit pass / 无 audit / 同步路径完成）
 *
 * 不传 flushOutboundBuffer 时 engine 跳过 flush 不抛错（向后兼容）。
 */

import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
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

const noopTool = {
  name: 'noop',
  description: 'noop',
  inputSchema: { type: 'object' as const, properties: {} },
  isReadOnly: true,
  call: async () => ({ output: 'ok', isError: false }),
}

describe('engine: flushOutboundBuffer hook', () => {
  it('flushes on stop_reason=tool_use continuation (between turn 1 and turn 2)', async () => {
    const flushFn = vi.fn(async () => { /* noop, just track invocation */ })

    // turn 1 = noop tool (tool_use) → 续 turn；turn 2 = end_turn
    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu1', toolName: 'noop' },
      { kind: 'end_turn', text: '完毕' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [noopTool],
        systemPrompt: '',
        model: 'test-model',
        flushOutboundBuffer: flushFn,
      },
    })

    expect(result.outcome).toBe('completed')
    // turn 1 tool_use 续 turn 路径调用一次 flush；turn 2 end_turn（无 endTurnGate）再调一次
    expect(flushFn).toHaveBeenCalled()
    // 至少 2 次（tool_use 续 turn + end_turn 之后），具体 2 还是更多取决于实现细节
    expect(flushFn.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('flushes on stop_reason=end_turn after endTurnGate returns null (gate pass path)', async () => {
    const flushFn = vi.fn(async () => { /* noop */ })
    const gateFn = vi.fn(async () => null)  // gate pass

    // turn 1 = end_turn 直接退（无 tool_use）
    const adapter = makeAdapter([
      { kind: 'end_turn', text: '完毕' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate: gateFn,
        flushOutboundBuffer: flushFn,
      },
    })

    expect(result.outcome).toBe('completed')
    expect(gateFn).toHaveBeenCalledTimes(1)
    // gate 返回 null 后必须 flush 一次再 buildResult
    expect(flushFn).toHaveBeenCalled()
  })

  it('flushes on stop_reason=end_turn when no endTurnGate provided', async () => {
    const flushFn = vi.fn(async () => { /* noop */ })

    const adapter = makeAdapter([
      { kind: 'end_turn', text: '完毕' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        // 无 endTurnGate → 走 fallthrough flush 分支
        flushOutboundBuffer: flushFn,
      },
    })

    expect(result.outcome).toBe('completed')
    expect(flushFn).toHaveBeenCalled()
  })

  it('does NOT flush when endTurnGate returns a string (gate intercepted, loop continues)', async () => {
    // gate 第一次返回 string 拦截，第二次返回 null 放行
    let gateCall = 0
    const gateFn = vi.fn(async () => {
      gateCall++
      return gateCall === 1 ? '再想想' : null
    })
    const flushFn = vi.fn(async () => { /* noop */ })

    // turn 1 = end_turn (gate 拦截，注入续 loop) → turn 2 = end_turn (gate 放行)
    const adapter = makeAdapter([
      { kind: 'end_turn', text: '完毕 1' },
      { kind: 'end_turn', text: '完毕 2' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate: gateFn,
        flushOutboundBuffer: flushFn,
      },
    })

    expect(result.outcome).toBe('completed')
    expect(gateFn).toHaveBeenCalledTimes(2)
    // gate 拦截路径不应 flush（loop 还在继续，缓冲属于"还没决定好的"内容）；
    // 只有 gate=null 放行那一次后才 flush。
    // 由于 turn 1 是 end_turn 没有 tool_use 续 turn 路径，flush 应只在 gate pass 后被调。
    expect(flushFn).toHaveBeenCalledTimes(1)
  })

  it('does NOT throw when flushOutboundBuffer not provided (backward compat)', async () => {
    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu1', toolName: 'noop' },
      { kind: 'end_turn', text: '完毕' },
    ])

    // options.flushOutboundBuffer === undefined：engine 应该跳过 flush 分支
    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [noopTool],
        systemPrompt: '',
        model: 'test-model',
        // 不传 flushOutboundBuffer
      },
    })

    expect(result.outcome).toBe('completed')
  })

  it('flush errors propagate from flush callback (caller responsibility to handle internally)', async () => {
    // engine 把 flush error 直接抛出来（caller 在 callback 内部已 try/catch；
    // 若意外抛出，engine 不吞——让上层看到）。
    const flushFn = vi.fn(async () => {
      throw new Error('flush exploded')
    })

    const adapter = makeAdapter([
      { kind: 'end_turn', text: '完毕' },
    ])

    await expect(
      runEngine({
        prompt: 'go',
        adapter,
        options: {
          tools: [],
          systemPrompt: '',
          model: 'test-model',
          flushOutboundBuffer: flushFn,
        },
      }),
    ).rejects.toThrow('flush exploded')
  })

  // ==========================================================================
  // §4.2 Revision 第 1 段：L816 守门加 !bufferedSendMessageInTurn
  // 本 turn 含 send_message 且进了 outboundBuffer → post-tool 阶段 skip flush
  // ==========================================================================

  it('§4.13 L816 守门：tool_use=send_message + tool_result 含 buffered:true → 本 turn 之后不 flush (trace 7470b21d 回归)', async () => {
    // 模拟 send_message handler 缓冲分支返回 buffered:true 后立刻 end_turn 的组合
    const flushFn = vi.fn(async () => { /* noop */ })
    const sendMsgBufferedTool = {
      name: 'send_message',
      description: 'send',
      inputSchema: { type: 'object' as const, properties: {} },
      isReadOnly: false,
      call: async () => ({
        output: '{"buffered":true,"sent_at":null,"note":"消息已待发"}',
        isError: false,
      }),
    }
    // turn 1 = send_message buffered → turn 2 = end_turn
    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu-send', toolName: 'send_message' },
      { kind: 'end_turn', text: '' },
    ])
    // endTurnGate=null → 走 fallthrough flush 分支
    const gateFn = vi.fn(async () => null)

    await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [sendMsgBufferedTool],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate: gateFn,
        flushOutboundBuffer: flushFn,
      },
    })

    // turn 1（send_message buffered）之后 L816 守门挡掉 flush（关键 fix）；
    // turn 2（end_turn + gate=null）后 fallthrough flush 调用 1 次（这道闸不受守门影响）。
    // 总计应等于 1 —— 修复前等于 2（turn 1 后多调一次提前把 buffer flush 出去）。
    expect(flushFn.mock.calls.length).toBe(1)
  })

  it('§4.13 L816 守门：本 turn 调非 send_message 工具（如 noop）不受守门影响，仍 flush', async () => {
    // 回归保证：守门只挡"本 turn 缓冲了新 send_message"那种 turn，普通工具续 turn 路径不动
    const flushFn = vi.fn(async () => { /* noop */ })
    // turn 1 = noop（非 send_message）→ turn 2 = end_turn
    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu1', toolName: 'noop' },
      { kind: 'end_turn', text: '' },
    ])
    const gateFn = vi.fn(async () => null)

    await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [noopTool],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate: gateFn,
        flushOutboundBuffer: flushFn,
      },
    })

    // turn 1 后 flush（普通 tool_use 续 turn 路径）+ turn 2 后 flush（end_turn gate=null）= 2 次
    expect(flushFn.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('§4.13 L816 守门：tool_use=send_message 但 result 不含 buffered:true（immediate-send 路径，未走缓冲）→ 守门不挡，照常 flush', async () => {
    // 边界 case：send_message 在 immediate-send 路径下（无 goal 或等审态）返回 platform_message_id
    // 而不是 buffered:true，bufferedSendMessageInTurn 判定应为 false，flush 照常
    const flushFn = vi.fn(async () => { /* noop */ })
    const sendMsgImmediateTool = {
      name: 'send_message',
      description: 'send',
      inputSchema: { type: 'object' as const, properties: {} },
      isReadOnly: false,
      call: async () => ({
        output: '{"platform_message_id":"pmid","sent_at":"2026-06-09T00:00:00Z"}',
        isError: false,
      }),
    }
    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu-send', toolName: 'send_message' },
      { kind: 'end_turn', text: '' },
    ])
    const gateFn = vi.fn(async () => null)

    await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [sendMsgImmediateTool],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate: gateFn,
        flushOutboundBuffer: flushFn,
      },
    })

    // turn 1 后 flush 调用（守门不挡 immediate-send 路径）+ turn 2 后 fallthrough flush = 2 次
    expect(flushFn.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('flush is called AFTER post-tool drain on tool_use turn (ordering check)', async () => {
    // 验证 flush 在 post-tool drain 之后调（spec: drain 已发的 supplement，再 flush 缓冲）
    const events: string[] = []
    const flushFn = vi.fn(async () => {
      events.push('flush')
    })

    // 工具自身把 'tool_done' push 到 events——模拟"post-tool 阶段"
    const trackingTool = {
      name: 'tracking',
      description: 'tracks order',
      inputSchema: { type: 'object' as const, properties: {} },
      isReadOnly: true,
      call: async () => {
        events.push('tool_call')
        return { output: 'ok', isError: false }
      },
    }

    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu1', toolName: 'tracking' },
      { kind: 'end_turn', text: '完毕' },
    ])

    await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [trackingTool],
        systemPrompt: '',
        model: 'test-model',
        flushOutboundBuffer: flushFn,
      },
    })

    // 期望顺序：tool_call → flush (in turn 1) → flush (in turn 2 end_turn)
    expect(events[0]).toBe('tool_call')
    // tool_call 之后必有 flush（不必判定具体次数，只判定相对顺序）
    expect(events.indexOf('flush')).toBeGreaterThan(events.indexOf('tool_call'))
  })

  it('end_turn flush 失败 → 续轮注入失败提示、不静默标完成（A: 发送失败回传，trace a72623ec）', async () => {
    let flushCall = 0
    // 第一次发送失败（返回 failures），第二次成功（[]）
    const flushFn = vi.fn(async () => {
      flushCall++
      return flushCall === 1
        ? [{ summary: 'HTML 交付', error: '相对路径需要路径映射配置，请使用绝对路径' }]
        : []
    })
    const gateFn = vi.fn(async () => null) // gate pass
    const injections: string[] = []

    // 两轮都 end_turn（无 tool_use）：第一轮 flush 失败 → 续轮；第二轮 flush 成功 → completed
    const adapter = makeAdapter([
      { kind: 'end_turn', text: '完毕1' },
      { kind: 'end_turn', text: '完毕2' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate: gateFn,
        flushOutboundBuffer: flushFn,
        onSystemInjection: (e) => injections.push(e.text),
      },
    })

    expect(result.outcome).toBe('completed')
    // 第一轮 flush 失败 → 没有立即 completed，而是续了一轮（gate/flush 各被调 2 次）
    expect(flushFn).toHaveBeenCalledTimes(2)
    expect(gateFn).toHaveBeenCalledTimes(2)
    // 失败详情（原因 + 摘要）被注入回 worker，而不是静默吞掉
    const injected = injections.join('\n')
    expect(injected).toContain('没有成功发出')
    expect(injected).toContain('相对路径需要路径映射配置')
    expect(injected).toContain('HTML 交付')
  })

  it('end_turn flush 一直失败 → 重试耗尽后标 failed、error 写清原因（不静默标完成）', async () => {
    // flush 每次都失败
    const flushFn = vi.fn(async () => [
      { summary: '回测结果.html', error: 'channel down: telegram-001 不可用' },
    ])
    const gateFn = vi.fn(async () => null) // gate pass

    // 一直 end_turn：每轮 flush 失败续轮，直到重试耗尽
    const adapter = makeAdapter([{ kind: 'end_turn', text: '完毕' }])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate: gateFn,
        flushOutboundBuffer: flushFn,
      },
    })

    // 超限 → 任务标失败，而不是静默 completed
    expect(result.outcome).toBe('failed')
    // 失败原因写清了：哪条没送达、为什么
    expect(result.error).toBeDefined()
    expect(result.error).toContain('回测结果.html')
    expect(result.error).toContain('channel down')
    expect(result.error).toContain('始终无法送达用户')
  })
})
