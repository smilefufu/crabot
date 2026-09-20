import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
import { defineTool } from '../../src/engine/tool-framework.js'
import { HookRegistry } from '../../src/hooks/hook-registry.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import type { EngineOptions, EngineToolLifecycleEvent, ToolUseBlock, EngineMessage } from '../../src/engine/types.js'
import type { LLMAdapter, LLMStreamParams } from '../../src/engine/llm-adapter.js'
import { chunksFromContent } from './helpers/mock-stream.js'

const input = { content: '已完成', session_id: 'session', post_send_action: 'none' }
const error = '禁止重复发送消息。如无其他事，则立即结束本回合。'
const send = (id: string, args: Record<string, unknown> = input): ToolUseBlock => ({ type: 'tool_use', id, name: 'send_message', input: args })

function fixture(rounds: (ToolUseBlock[] | null)[], overrides: Partial<EngineOptions> = {}, failed = false) {
  const call = vi.fn(async () => ({ output: failed ? 'delivery failed' : '{"sent_at":"now"}', isError: failed }))
  const requests: EngineMessage[][] = []
  const events: EngineToolLifecycleEvent[] = []
  let index = 0
  const adapter: LLMAdapter = {
    async *stream(params: LLMStreamParams) {
      requests.push(structuredClone(params.messages) as EngineMessage[])
      const blocks = rounds[index++]
      yield* chunksFromContent(blocks ?? [{ type: 'text', text: 'done' }], blocks ? 'tool_use' : 'end_turn')
    },
    updateConfig() {},
  }
  const tool = defineTool({ name: 'send_message', description: '', inputSchema: {}, call })
  const options: EngineOptions = { model: 'test', systemPrompt: '', tools: [tool], maxTurns: 10, onToolLifecycle: event => events.push(event), ...overrides }
  return { call, requests, events, tool, run: () => runEngine({ prompt: 'test', adapter, options }) }
}
const results = (messages: EngineMessage[]) => messages.flatMap(m => 'toolResults' in m ? m.toolResults : [])

describe('consecutive send_message protection', () => {
  it('rejects repeated calls across turns with paired errors and lifecycle', async () => {
    const f = fixture([[send('one')], [send('two')], [send('three')]])
    const result = await f.run()
    expect(f.call).toHaveBeenCalledOnce()
    expect(results(f.requests[3]).slice(-2)).toEqual([
      expect.objectContaining({ tool_use_id: 'two', is_error: true, content: expect.stringContaining(error) }),
      expect.objectContaining({ tool_use_id: 'three', is_error: true, content: expect.stringContaining(error) }),
    ])
    expect(f.events.filter(e => e.type === 'tool_finished').map(e => e.isError)).toEqual([false, true, true])
    expect(f.events.filter(e => e.type === 'tool_started')).toHaveLength(3)
    expect(result.outcome).toBe('completed')
  })
  it('rejects duplicates in one response, ignoring nested object key order', async () => {
    const f = fixture([[send('one', { ...input, data: { a: 1, b: 2 } }), send('two', { data: { b: 2, a: 1 }, post_send_action: 'none', session_id: 'session', content: '已完成' })]])
    await f.run()
    expect(f.call).toHaveBeenCalledOnce()
    expect(results(f.requests[1])[1].is_error).toBe(true)
  })
  it('rejects identical retries even after a delivery error', async () => {
    const f = fixture([[send('one')], [send('two')]], {}, true)
    await f.run()
    expect(f.call).toHaveBeenCalledOnce()
    expect(results(f.requests[2])[1].content).toContain(error)
  })
  it.each([
    { ...input, content: '已完成 ' }, { ...input, session_id: 'other' },
    { ...input, reference: null }, { ...input, post_send_action: 'spawn_worker' },
  ])('allows changed raw parameters: %j', async changed => {
    const f = fixture([[send('one')], [send('two', changed)]])
    await f.run()
    expect(f.call).toHaveBeenCalledTimes(2)
  })
  it('another tool, even unavailable, interrupts adjacency', async () => {
    const other: ToolUseBlock = { type: 'tool_use', id: 'other', name: 'unavailable', input: {} }
    const f = fixture([[send('one'), other, send('two')]])
    await f.run()
    expect(f.call).toHaveBeenCalledTimes(2)
  })
  it.each(['human', 'external'])('new %s input allows resending', async source => {
    const queue = new HumanMessageQueue()
    let drained = false
    const f = fixture([[send('one')], [send('two')]], source === 'human'
      ? { humanMessageQueue: queue }
      : { drainExternalInputs: async () => { if (drained) return []; drained = true; return ['请再发一次'] } })
    if (source === 'human') f.call.mockImplementationOnce(async () => { queue.push('请再发一次'); return { output: 'sent', isError: false } })
    await f.run()
    expect(f.call).toHaveBeenCalledTimes(2)
  })
  it('new Engine executions do not share state', async () => {
    const a = fixture([[send('one')]]), b = fixture([[send('two')]])
    await Promise.all([a.run(), b.run()])
    expect(a.call).toHaveBeenCalledOnce()
    expect(b.call).toHaveBeenCalledOnce()
  })
  it('permission rejection takes precedence over duplicate rejection', async () => {
    let checks = 0
    const f = fixture([[send('one')], [send('two')]], { permissionConfig: { mode: 'bypass', checkPermission: async () => ({ allowed: ++checks === 1, reason: 'revoked' }) } })
    await f.run()
    expect(f.call).toHaveBeenCalledOnce()
    expect(results(f.requests[2])[1].content).toContain('Permission denied: revoked')
  })
  it('compares raw input before repair and skips repair on duplicates', async () => {
    const f = fixture([[send('one')], [send('two')]])
    const repair = vi.fn(async (args: Record<string, unknown>) => ({ ...args, channel_id: 'channel' }))
    Object.assign(f.tool, { repairInput: repair })
    await f.run()
    expect(repair).toHaveBeenCalledOnce()
    expect(f.call).toHaveBeenCalledWith(expect.objectContaining({ channel_id: 'channel' }), expect.anything())
  })
  it('internal end-turn reminder does not reset protection', async () => {
    let reminders = 0
    const f = fixture([[send('one')], null, [send('two')]], {
      endTurnGate: async () => ++reminders === 1 ? '内部检查：继续核实' : undefined,
    })
    await f.run()
    expect(f.call).toHaveBeenCalledOnce()
    expect(results(f.requests[3]).at(-1)?.content).toContain(error)
  })

  it('does not run pre/post tool hooks again for a rejected send', async () => {
    const registry = new HookRegistry()
    const matching = vi.spyOn(registry, 'getMatching')
    const f = fixture([[send('one')], [send('two')]], { hookRegistry: registry })
    await f.run()
    expect(matching.mock.calls.filter(([event]) => event === 'PreToolUse')).toHaveLength(1)
    expect(matching.mock.calls.filter(([event]) => event === 'PostToolUse')).toHaveLength(1)
  })

  it('different raw parameters stay distinct even when repair makes them equal', async () => {
    const f = fixture([[send('one')], [send('two', { ...input, channel_id: 'channel' })]])
    Object.assign(f.tool, { repairInput: async (args: Record<string, unknown>) => ({ ...args, channel_id: 'channel' }) })
    await f.run()
    expect(f.call).toHaveBeenCalledTimes(2)
  })

  it('preserves array order and JSON value types', async () => {
    const f = fixture([[send('one', { ...input, values: [1, 2] }), send('two', { ...input, values: [2, 1] }), send('three', { ...input, values: ['2', 1] })]])
    await f.run()
    expect(f.call).toHaveBeenCalledTimes(3)
  })

  it('compaction between sends does not clear protection', async () => {
    const call = vi.fn(async () => ({ output: 'sent', isError: false }))
    const tool = defineTool({ name: 'send_message', description: '', inputSchema: {}, call })
    let mainTurns = 0
    const onCompactionStart = vi.fn()
    const adapter: LLMAdapter = {
      async *stream(params) {
        if (!params.tools.length) { yield* chunksFromContent([{ type: 'text', text: 'Earlier history summarized.' }], 'end_turn'); return }
        mainTurns++
        const blocks = mainTurns <= 6 ? [send(String(mainTurns), mainTurns < 5 ? { ...input, content: String(mainTurns) } : input)] : [{ type: 'text', text: 'done' }]
        yield* chunksFromContent(blocks, mainTurns <= 6 ? 'tool_use' : 'end_turn', { inputTokens: mainTurns === 5 ? 9000 : 10, outputTokens: 10 })
      },
      updateConfig() {},
    }
    const result = await runEngine({ prompt: 'test', adapter, options: { model: 'test', systemPrompt: '', tools: [tool], contextWindowTokens: 10000, onCompactionStart } })
    expect(onCompactionStart).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledTimes(5)
    expect(results([...result.finalMessages]).at(-1)?.content).toContain(error)
  })

})
