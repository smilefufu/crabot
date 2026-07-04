// crabot-agent/tests/engine/query-loop-exit-tools.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import type { ToolDefinition } from '../../src/engine/types.js'
import { chunksFromContent } from './helpers/mock-stream.js'

function makeAdapter(
  responses: Array<{
    text?: string
    toolCalls?: Array<{ name: string; id: string; input: Record<string, unknown> }>
    stopReason: 'end_turn' | 'tool_use'
  }>,
): LLMAdapter {
  let i = 0
  return {
    stream: vi.fn(async function* () {
      const r = responses[i++] ?? responses[responses.length - 1]
      const content: unknown[] = []
      if (r.text) content.push({ type: 'text', text: r.text })
      for (const tc of r.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      }
      yield* chunksFromContent(content, r.stopReason, { inputTokens: 100, outputTokens: 50 })
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

const dummyExitTool: ToolDefinition = {
  name: 'do_exit',
  description: 'exit tool',
  inputSchema: { type: 'object' as const, properties: { reason: { type: 'string' } }, required: [] },
  isReadOnly: true,
  turnZeroOnly: true,
  exitsLoop: true,
  call: async () => ({ output: '', isError: false }),
}

const dummyTurnZeroTool: ToolDefinition = {
  name: 'turn_zero_only',
  description: 'turn 0 only',
  inputSchema: { type: 'object' as const, properties: {}, required: [] },
  isReadOnly: true,
  turnZeroOnly: true,
  call: async () => ({ output: 'should not execute', isError: false }),
}

const harmlessTool: ToolDefinition = {
  name: 'harmless',
  description: 'no-op',
  inputSchema: { type: 'object' as const, properties: {}, required: [] },
  isReadOnly: true,
  call: async () => ({ output: 'done', isError: false }),
}

const sendMessageTool: ToolDefinition = {
  name: 'send_message',
  description: 'send message',
  inputSchema: { type: 'object' as const, properties: {}, required: [] },
  isReadOnly: false,
  call: async () => ({ output: 'sent', isError: false }),
}

describe('query-loop: exitsLoop 工具退出', () => {
  it('turn 0 调用 exitsLoop 工具 → engine 立刻退出，exitToolCall 暴露 name + input', async () => {
    const adapter = makeAdapter([
      {
        toolCalls: [{ name: 'do_exit', id: 'call_1', input: { reason: 'turn 0 决定退出' } }],
        stopReason: 'tool_use',
      },
    ])
    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [dummyExitTool],
        systemPrompt: '',
        model: 'test',
      },
    })

    expect(result.outcome).toBe('completed')
    expect(result.exitToolCall).toEqual({
      name: 'do_exit',
      input: { reason: 'turn 0 决定退出' },
    })
    expect(result.finalMessages).toEqual([
      expect.objectContaining({ role: 'user', content: 'test' }),
      expect.objectContaining({
        role: 'assistant',
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'tool_use', id: 'call_1', name: 'do_exit' }),
        ]),
      }),
      expect.objectContaining({
        role: 'user',
        toolResults: [
          expect.objectContaining({ tool_use_id: 'call_1', content: '[exit_tool]', is_error: false }),
        ],
      }),
    ])
    expect(result.totalTurns).toBe(1)
    expect((adapter.stream as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('同轮存在其他 tool_use 时，exitsLoop 早退仍补齐所有 tool_result', async () => {
    const turns: Array<{ name: string; isError: boolean }> = []
    const adapter = makeAdapter([
      {
        toolCalls: [
          { name: 'do_exit', id: 'exit_1', input: { reason: 'done' } },
          { name: 'harmless', id: 'h1', input: {} },
        ],
        stopReason: 'tool_use',
      },
    ])
    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [dummyExitTool, harmlessTool],
        systemPrompt: '',
        model: 'test',
        onTurn: (event) => {
          turns.push(...event.toolCalls.map(tc => ({ name: tc.name, isError: tc.isError })))
        },
      },
    })

    expect(result.outcome).toBe('completed')
    expect(result.finalMessages).toEqual([
      expect.objectContaining({ role: 'user', content: 'test' }),
      expect.objectContaining({
        role: 'assistant',
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'tool_use', id: 'exit_1', name: 'do_exit' }),
          expect.objectContaining({ type: 'tool_use', id: 'h1', name: 'harmless' }),
        ]),
      }),
      expect.objectContaining({
        role: 'user',
        toolResults: [
          expect.objectContaining({ tool_use_id: 'exit_1', content: '[exit_tool]', is_error: false }),
          expect.objectContaining({ tool_use_id: 'h1', content: '[skipped: exitsLoop tool selected]', is_error: true }),
        ],
      }),
    ])
    expect(turns).toEqual([
      { name: 'do_exit', isError: false },
      { name: 'harmless', isError: true },
    ])
  })

  it('submit_audit_result 同轮跳过 send_message 时，send_message 不算成功交付', async () => {
    let delivered = false
    const adapter = makeAdapter([
      {
        toolCalls: [
          { name: 'do_exit', id: 'exit_1', input: { pass: true } },
          { name: 'send_message', id: 'msg_1', input: { intent: 'info', text: 'done' } },
        ],
        stopReason: 'tool_use',
      },
    ])
    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [dummyExitTool, sendMessageTool],
        systemPrompt: '',
        model: 'test',
        onTurn: (event) => {
          for (const tc of event.toolCalls) {
            if (tc.name === 'send_message' && !tc.isError) delivered = true
          }
        },
      },
    })

    expect(result.outcome).toBe('completed')
    expect(delivered).toBe(false)
    expect(result.finalMessages).toEqual([
      expect.objectContaining({ role: 'user', content: 'test' }),
      expect.objectContaining({
        role: 'assistant',
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'tool_use', id: 'exit_1', name: 'do_exit' }),
          expect.objectContaining({ type: 'tool_use', id: 'msg_1', name: 'send_message' }),
        ]),
      }),
      expect.objectContaining({
        role: 'user',
        toolResults: [
          expect.objectContaining({ tool_use_id: 'exit_1', content: '[exit_tool]', is_error: false }),
          expect.objectContaining({ tool_use_id: 'msg_1', content: '[skipped: exitsLoop tool selected]', is_error: true }),
        ],
      }),
    ])
  })

  it('未触发 exit 工具时 exitToolCall undefined', async () => {
    const adapter = makeAdapter([{ text: '正常结束', stopReason: 'end_turn' }])
    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [dummyExitTool],
        systemPrompt: '',
        model: 'test',
      },
    })

    expect(result.exitToolCall).toBeUndefined()
  })
})

describe('query-loop: turnZeroOnly 拒绝', () => {
  it('turn ≥ 1 调用 turnZeroOnly 工具 → 返回 error tool_result，下一轮继续', async () => {
    const adapter = makeAdapter([
      // turn 0: 调一个普通工具 → tool_use 进入 turn 1
      { toolCalls: [{ name: 'harmless', id: 'h1', input: {} }], stopReason: 'tool_use' },
      // turn 1: 试图调 turn_zero_only → 被拒绝，下一轮 LLM 看到 error
      { toolCalls: [{ name: 'turn_zero_only', id: 'tz1', input: {} }], stopReason: 'tool_use' },
      // turn 2: LLM 看到错误，end_turn
      { text: '收到拒绝，结束', stopReason: 'end_turn' },
    ])
    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [harmlessTool, dummyTurnZeroTool],
        systemPrompt: '',
        model: 'test',
      },
    })

    expect(result.outcome).toBe('completed')
    expect(result.totalTurns).toBe(3)
    expect(result.finalText).toBe('收到拒绝，结束')
  })

  it('turn ≥ 1 同轮含普通工具和 turnZeroOnly 违规工具时，补齐所有 tool_result', async () => {
    const turnToolCalls: Array<Array<{ name: string; isError: boolean }>> = []
    const adapter = makeAdapter([
      // turn 0: 调一个普通工具 → tool_use 进入 turn 1
      { toolCalls: [{ name: 'harmless', id: 'h1', input: {} }], stopReason: 'tool_use' },
      // turn 1: 同轮普通工具 + turnZeroOnly 违规工具
      {
        toolCalls: [
          { name: 'harmless', id: 'h2', input: {} },
          { name: 'turn_zero_only', id: 'tz1', input: {} },
        ],
        stopReason: 'tool_use',
      },
      { text: '收到拒绝，结束', stopReason: 'end_turn' },
    ])
    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [harmlessTool, dummyTurnZeroTool],
        systemPrompt: '',
        model: 'test',
        onTurn: (event) => {
          turnToolCalls.push(event.toolCalls.map(tc => ({ name: tc.name, isError: tc.isError })))
        },
      },
    })

    expect(result.outcome).toBe('completed')
    expect(result.finalMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          toolResults: [
            expect.objectContaining({ tool_use_id: 'h2', content: '[skipped: turnZeroOnly violation in same turn]', is_error: false }),
            expect.objectContaining({ tool_use_id: 'tz1', is_error: true }),
          ],
        }),
      ]),
    )
    expect(turnToolCalls[1]).toEqual([
      { name: 'harmless', isError: false },
      { name: 'turn_zero_only', isError: true },
    ])
  })

  it('turn 0 调用 turnZeroOnly 工具 → 正常执行（边界条件）', async () => {
    const adapter = makeAdapter([
      // turn 0: 调 turn_zero_only（非 exitsLoop 的 turnZeroOnly 工具）→ 应被正常执行
      { toolCalls: [{ name: 'turn_zero_only', id: 't1', input: {} }], stopReason: 'tool_use' },
      // turn 1: LLM 看到 tool result 后 end_turn
      { text: '完成', stopReason: 'end_turn' },
    ])
    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [dummyTurnZeroTool],
        systemPrompt: '',
        model: 'test',
      },
    })

    expect(result.outcome).toBe('completed')
    expect(result.totalTurns).toBe(2)
  })
})
