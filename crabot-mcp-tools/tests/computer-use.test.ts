import { describe, it, expect, vi } from 'vitest'
import { ComputerUseCoordinator } from '../src/computer-use/coordinator'
import { NATIVE_TOOLS, type NativeDriver } from '../src/computer-use/types'

function fixture() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let handler = async () => ({ content: [], structuredContent: { effect: 'unverifiable' } })
  let closed = false
  const driver: NativeDriver = {
    async tools() { return NATIVE_TOOLS.map(name => ({ name, inputSchema: { type: 'object', properties: {
      session: { type: 'string' }, text: { type: 'string' }, element_token: { type: 'string' },
      capture_id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, max_image_dimension: { type: 'integer' },
      pid: { type: 'integer' }, window_id: { type: 'integer' },
    }, additionalProperties: false, ...(name === 'type_text' ? { required: ['text'] } : {}) } })) },
    async call(name, args) { calls.push({ name, args }); return name === 'start_session' ? { content: [], structuredContent: { session: args.session } } : handler() },
    async close() { closed = true },
  }
  const coordinator = new ComputerUseCoordinator(driver, async id => id !== 'denied')
  return { coordinator, calls, setHandler: (fn: typeof handler) => { handler = fn }, isClosed: () => closed }
}

describe('computer-use coordinator', () => {
  it('hides host-only session and lifecycle tools', async () => {
    const f = fixture()
    const tools = await f.coordinator.tools()
    expect(tools.map(t => t.name)).toEqual([...NATIVE_TOOLS, 'perform_actions'])
    expect(tools[0].inputSchema.properties).not.toHaveProperty('session')
    expect((await f.coordinator.call('a', 'click', { session: 'other' })).isError).toBe(true)
    expect(f.calls).toHaveLength(0)
  })
  it('validates every step before input; denied callers cannot execute', async () => {
    const f = fixture()
    const r = await f.coordinator.call('a', 'perform_actions', { steps: [
      { tool: 'type_text', args: { text: 'ok' } }, { tool: 'type_text', args: { text: 2 } },
    ] })
    expect(r.isError).toBe(true)
    expect(f.calls).toHaveLength(0)
    expect((await f.coordinator.call('denied', 'type_text', { text: 'no' })).isError).toBe(true)
    expect(f.calls).toHaveLength(0)
  })
  it('returns busy immediately without queuing either reads or writes', async () => {
    const f = fixture()
    let release!: () => void
    f.setHandler(() => new Promise(resolve => { release = () => resolve({ content: [], structuredContent: { effect: 'unverifiable' } }) }))
    const active = f.coordinator.call('a', 'type_text', { text: 'once' })
    while (!release) await new Promise(resolve => setTimeout(resolve, 0))
    expect((await f.coordinator.call('b', 'list_windows', {})).structuredContent).toEqual({ code: 'COMPUTER_USE_BUSY' })
    release()
    await active
    expect(f.calls.filter(c => c.name === 'type_text')).toHaveLength(1)
  })
  it('stops a partial batch and preserves all step outcomes', async () => {
    const f = fixture()
    let n = 0
    f.setHandler(async () => ({ content: [], structuredContent: { effect: ++n === 2 ? 'partial' : 'unverifiable' } }))
    const r = await f.coordinator.call('a', 'perform_actions', { steps: [1, 2, 3].map(i => ({ tool: 'type_text', args: { text: String(i) } })) })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toMatchObject({ status: 'partial', steps: [
      { status: 'completed' }, { status: 'failed', result: { effect: 'partial' } }, { status: 'not_executed' },
    ] })
    expect(f.calls.filter(c => c.name === 'type_text')).toHaveLength(2)
  })
  it('quarantines disconnected input, closes owned runtime, never replays', async () => {
    const f = fixture()
    f.setHandler(async () => { throw new Error('lost connection') })
    const result = await f.coordinator.call('a', 'type_text', { text: 'once' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ code: 'COMPUTER_USE_UNKNOWN' })
    expect(f.isClosed()).toBe(true)
    expect((await f.coordinator.call('a', 'type_text', { text: 'once' })).isError).toBe(true)
    expect(f.calls.filter(c => c.name === 'type_text')).toHaveLength(1)
  })
  it('enforces the 16-step limit before starting any session or action', async () => {
    const f = fixture()
    expect((await f.coordinator.call('a', 'perform_actions', { steps: Array.from({ length: 17 }, () => ({ tool: 'type_text', args: { text: 'x' } })) })).isError).toBe(true)
    expect(f.calls).toHaveLength(0)
  })
  it('owns capture and element references per caller and preserves capture metadata', async () => {
    const f = fixture()
    f.setHandler(async () => ({ content: [], structuredContent: { effect: 'unverifiable', pid: 10, window_id: 20, capture_id: 'capture-a',
      screenshot_width: 1024, screenshot_height: 640, screenshot_scale: 0.5, window_bounds: { x: 20, y: 10, width: 2048, height: 1280 },
      elements: [{ element_index: 0, role: 'AXTextField', depth: 0, element_token: 's12345678:0', value: '中文' }] } }))
    const read = await f.coordinator.call('a', 'get_window_state', { pid: 10, window_id: 20 })
    expect(read.structuredContent).toMatchObject({ screenshot_width: 1024, screenshot_scale: 0.5 })
    expect(f.calls.at(-1)?.args.max_image_dimension).toBe(1024)
    expect((await f.coordinator.call('b', 'click', { element_token: 's12345678:0' })).isError).toBe(true)
    expect((await f.coordinator.call('b', 'click', { x: 1, y: 2 })).isError).toBe(true)
    expect((await f.coordinator.call('a', 'click', { element_token: 's12345678:0' })).isError).toBe(false)
    expect(f.calls.filter(call => call.name === 'click')).toHaveLength(1)
  })
  it('keeps completed action receipts when final observation fails', async () => {
    const f = fixture()
    let n = 0
    f.setHandler(async () => ++n === 1 ? { content: [], structuredContent: { effect: 'unverifiable' } }
      : { content: [], structuredContent: { effect: 'refused' }, isError: true })
    const result = await f.coordinator.call('a', 'perform_actions', { steps: [{ tool: 'type_text', args: { text: 'one' } }], observe: { pid: 1, window_id: 2 } })
    expect(result.structuredContent).toMatchObject({ status: 'failed', steps: [{ status: 'completed' }], observation: { effect: 'refused' } })
    expect(result.isError).toBe(true)
  })
  it('cancellation after start is unknown and never dispatches the next step', async () => {
    const f = fixture()
    const abort = new AbortController()
    let started = false
    f.setHandler(async () => { started = true; return await new Promise(() => {}) })
    const task = f.coordinator.call('a', 'perform_actions', { steps: [1, 2].map(i => ({ tool: 'type_text', args: { text: String(i) } })) }, abort.signal)
    while (!started) await new Promise(done => setTimeout(done, 0))
    abort.abort()
    const result = await task
    expect(result.structuredContent).toMatchObject({ status: 'unknown', steps: [{ status: 'unknown' }, { status: 'not_executed' }] })
    expect(f.isClosed()).toBe(true)
    expect(f.calls.filter(call => call.name === 'type_text')).toHaveLength(1)
  })
  it('the whole batch has a single 60-second deadline', async () => {
    const f = fixture()
    vi.useFakeTimers()
    let started = false
    f.setHandler(async () => { started = true; return await new Promise(() => {}) })
    try {
      const task = f.coordinator.call('a', 'type_text', { text: 'once' })
      while (!started) await Promise.resolve()
      await vi.advanceTimersByTimeAsync(60_000)
      expect((await task).structuredContent).toMatchObject({ effect: 'unknown' })
      expect(f.isClosed()).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('preserves native diagnostic text and quarantines execution_state=unknown', async () => {
    const f = fixture()
    f.setHandler(async () => ({ content: [{ type: 'text', text: 'effect cannot be confirmed' }],
      structuredContent: { code: 'tool_output_invalid', execution_state: 'unknown' }, isError: true }))
    const result = await f.coordinator.call('a', 'type_text', { text: 'once' })
    expect(result.structuredContent).toMatchObject({ execution_state: 'unknown' })
    expect(result.content).toEqual([{ type: 'text', text: 'effect cannot be confirmed' }])
    expect((await f.coordinator.call('a', 'type_text', { text: 'twice' })).isError).toBe(true)
    expect(f.isClosed()).toBe(true)
  })
  it('revocation ends the owned session without touching another caller', async () => {
    const f = fixture()
    await f.coordinator.call('a', 'type_text', { text: 'a' })
    await f.coordinator.call('b', 'type_text', { text: 'b' })
    const session = f.calls.find(call => call.name === 'type_text' && call.args.text === 'a')!.args.session
    await f.coordinator.revoke('a')
    expect(f.calls.filter(call => call.name === 'end_session').map(call => call.args.session)).toEqual([session])
    expect(f.isClosed()).toBe(false)
  })

  it('prevalidates target/reference mismatch before the first batch input', async () => {
    const f = fixture()
    f.setHandler(async () => ({ content: [], structuredContent: { pid: 10, window_id: 20,
      elements: [{ element_token: 's12345678:0' }] } }))
    await f.coordinator.call('a', 'get_window_state', { pid: 10, window_id: 20 })
    const result = await f.coordinator.call('a', 'perform_actions', { steps: [
      { tool: 'type_text', args: { text: 'must not type' } },
      { tool: 'click', args: { element_token: 's12345678:0', pid: 999, window_id: 20 } },
    ] })
    expect(result.isError).toBe(true)
    expect(f.calls.filter(call => call.name === 'type_text')).toHaveLength(0)
  })
  it('bounds aggregate receipts without making an omitted capture actionable', async () => {
    const f = fixture()
    f.setHandler(async () => ({ content: [], structuredContent: { effect: 'unverifiable', detail: 'x'.repeat(60_000) } }))
    const result = await f.coordinator.call('a', 'perform_actions', { steps: [1, 2, 3].map(i => ({ tool: 'type_text', args: { text: String(i) } })) })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ status: 'partial', steps: [
      { status: 'completed' }, { result: { code: 'COMPUTER_USE_OUTPUT_LIMIT' } }, { status: 'not_executed' },
    ] })
    expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(100_000)
  })

})
