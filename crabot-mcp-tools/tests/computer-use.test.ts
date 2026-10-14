import { describe, it, expect, vi } from 'vitest'
import { ComputerUseCoordinator } from '../src/computer-use/coordinator'
import { NATIVE_TOOLS, type NativeDriver } from '../src/computer-use/types'

function fixture(reconnect?: () => Promise<NativeDriver>, availabilityChanged?: (available: boolean) => void) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let handler = async () => ({ content: [], structuredContent: { effect: 'unverifiable' } })
  let closed = false
  const driver: NativeDriver = {
    async tools() { return NATIVE_TOOLS.map(name => ({ name, inputSchema: { type: 'object', properties: {
      session: { type: 'string' }, text: { type: 'string' }, element_token: { type: 'string' },
      capture_id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, max_image_dimension: { type: 'integer' },
      pid: { type: 'integer' }, window_id: { type: 'integer' }, display_only: { type: 'boolean' },
    }, additionalProperties: false, ...(name === 'type_text' ? { required: ['text'] } : {}) } })) },
    async call(name, args) { calls.push({ name, args }); return name === 'start_session' ? { content: [], structuredContent: { session: args.session } } : handler() },
    async close() { closed = true },
  }
  const coordinator = new ComputerUseCoordinator(driver, async id => id !== 'denied', reconnect, availabilityChanged)
  return { coordinator, driver, calls, setHandler: (fn: typeof handler) => { handler = fn }, isClosed: () => closed }
}

describe('computer-use coordinator', () => {
  it('host diagnostics perform only a read-only prerequisite check and omit raw native details', async () => {
    const f = fixture()
    f.setHandler((async () => ({ content: [{ type: 'text', text: 'private native detail' }], structuredContent: {
      schema_version: '1', checks: [{ name: 'ax_capability', status: 'pass', data: { executable: '/private/app' } },
        { name: 'screen_capture_capability', status: 'skip', hint: 'native detail' }, { name: 'unknown', status: 'invalid' }],
    } })) as never)
    expect(await f.coordinator.diagnostics()).toEqual([{ name: 'ax_capability', status: 'pass' }, { name: 'screen_capture_capability', status: 'skip' }])
    expect(f.calls).toEqual([{ name: 'health_report', args: { include: ['session_active', 'ax_capability', 'screen_capture_capability'] } }])
    expect((await f.coordinator.tools()).some(tool => tool.name === 'health_report')).toBe(false)
    await f.coordinator.close()
  })
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
    expect(await f.coordinator.diagnostics()).toEqual([])
    expect(f.calls.some(call => call.name === 'health_report')).toBe(false)
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

  it.each(['disconnect', 'native unknown', 'cancel', 'timeout'])('recovers after %s through a new observation without replay', async cause => {
    const fresh = fixture()
    fresh.setHandler(async () => ({ content: [], structuredContent: { pid: 10, window_id: 20,
      capture_id: 'new-capture', elements: [{ element_token: 'new-element' }] } }))
    const available: boolean[] = []
    const reconnect = vi.fn(async () => fresh.driver)
    const old = fixture(reconnect, value => available.push(value))
    old.setHandler(async () => ({ content: [], structuredContent: { capture_id: 'old-capture', elements: [{ element_token: 'old-element' }] } }))
    await old.coordinator.call('a', 'get_window_state', {})
    const oldSession = old.calls.at(-1)!.args.session
    let started = false
    old.setHandler(async () => {
      started = true
      if (cause === 'disconnect') throw new Error('lost connection')
      if (cause === 'native unknown') return { content: [], structuredContent: { execution_state: 'unknown' } }
      return await new Promise(() => {})
    })
    const abort = new AbortController()
    if (cause === 'timeout') vi.useFakeTimers()
    try {
      const task = old.coordinator.call('a', 'perform_actions', { steps: [1, 2].map(i => ({ tool: 'type_text', args: { text: String(i) } })) }, abort.signal)
      while (!started) await Promise.resolve()
      if (cause === 'cancel') abort.abort()
      if (cause === 'timeout') await vi.advanceTimersByTimeAsync(60_000)
      expect((await task).structuredContent).toMatchObject({ status: 'unknown', steps: [{ status: 'unknown' }, { status: 'not_executed' }] })
      expect(available).toEqual([false])
      expect((await old.coordinator.call('a', 'type_text', { text: 'must not replay' })).isError).toBe(true)
      expect(reconnect).not.toHaveBeenCalled()
      expect((await old.coordinator.call('a', 'list_windows', {})).isError).toBe(false)
      expect(reconnect).toHaveBeenCalledTimes(1)
      expect(old.isClosed()).toBe(true)
      expect(available).toEqual([false, true])
      expect(fresh.calls.at(-1)!.args.session).not.toBe(oldSession)
      expect((await old.coordinator.call('a', 'type_text', { text: 'before observation' })).structuredContent).toMatchObject({ code: 'COMPUTER_USE_OBSERVATION_REQUIRED' })
      expect((await old.coordinator.call('a', 'get_window_state', {})).isError).toBe(false)
      expect((await old.coordinator.call('a', 'click', { element_token: 'old-element' })).isError).toBe(true)
      expect((await old.coordinator.call('a', 'click', { capture_id: 'old-capture' })).isError).toBe(true)
      expect((await old.coordinator.call('b', 'type_text', { text: 'other caller' })).isError).toBe(true)
      expect((await old.coordinator.call('a', 'type_text', { text: 'new explicit action' })).isError).toBe(false)
      expect(old.calls.filter(call => call.name === 'type_text')).toHaveLength(1)
      expect(fresh.calls.filter(call => call.name === 'type_text')).toHaveLength(1)
    } finally { vi.useRealTimers(); await old.coordinator.close() }
  })
  it('does not create a second driver before confirmed exit and keeps cleanup failures isolated', async () => {
    const fresh = fixture()
    const reconnect = vi.fn(async () => fresh.driver)
    const old = fixture(reconnect)
    let confirmExit!: () => void
    old.driver.close = () => new Promise(resolve => { confirmExit = resolve })
    old.setHandler(async () => { throw new Error('disconnect') })
    await old.coordinator.call('a', 'type_text', { text: 'once' })
    const read = old.coordinator.call('a', 'get_window_state', {})
    await vi.waitFor(() => expect(confirmExit).toBeDefined())
    expect(reconnect).not.toHaveBeenCalled()
    expect((await old.coordinator.call('b', 'list_windows', {})).isError).toBe(true)
    confirmExit()
    expect((await read).isError).toBe(false)
    expect(reconnect).toHaveBeenCalledTimes(1)
    fresh.driver.close = async () => { throw new Error('STOP_UNCONFIRMED') }
    fresh.setHandler(async () => { throw new Error('second disconnect') })
    await old.coordinator.call('a', 'type_text', { text: 'explicit input' })
    expect((await old.coordinator.call('a', 'get_window_state', {})).isError).toBe(true)
    expect(reconnect).toHaveBeenCalledTimes(1)
    await expect(old.coordinator.close()).rejects.toThrow('STOP_UNCONFIRMED')
  })
  it('retries a failed connection only on a new read, without relaxing input or permissions', async () => {
    const fresh = fixture()
    const reconnect = vi.fn().mockRejectedValueOnce(new Error('permissions required')).mockResolvedValue(fresh.driver)
    const old = fixture(reconnect)
    old.setHandler(async () => { throw new Error('disconnect') })
    await old.coordinator.call('a', 'type_text', { text: 'once' })
    expect((await old.coordinator.call('a', 'get_window_state', {})).isError).toBe(true)
    expect((await old.coordinator.call('denied', 'get_window_state', {})).isError).toBe(true)
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect((await old.coordinator.call('a', 'launch_app', {})).isError).toBe(true)
    expect((await old.coordinator.call('a', 'get_window_state', {})).isError).toBe(false)
    expect(reconnect).toHaveBeenCalledTimes(2)
    await old.coordinator.close()
  })
  it.each(['cancel', 'shutdown'])('cleans a late connection after recovery %s without publishing ready', async cause => {
    const fresh = fixture()
    let finish!: (driver: NativeDriver) => void
    const available: boolean[] = []
    const reconnect = vi.fn(() => new Promise<NativeDriver>(resolve => { finish = resolve }))
    const old = fixture(reconnect, value => available.push(value))
    old.setHandler(async () => { throw new Error('disconnect') })
    await old.coordinator.call('a', 'type_text', { text: 'once' })
    const abort = new AbortController()
    const read = old.coordinator.call('a', 'get_window_state', {}, abort.signal)
    await vi.waitFor(() => expect(finish).toBeDefined())
    let stopped: Promise<void> | undefined
    if (cause === 'cancel') abort.abort()
    else stopped = old.coordinator.close()
    expect((await read).isError).toBe(true)
    finish(fresh.driver)
    if (stopped) await stopped
    else await vi.waitFor(() => expect(fresh.isClosed()).toBe(true))
    expect(fresh.isClosed()).toBe(true)
    expect(available).toEqual([false])
    expect(fresh.calls).toHaveLength(0)
    await old.coordinator.close()
  })

  it('failed or display-only observations never release the recovery input gate', async () => {
    const fresh = fixture()
    const old = fixture(async () => fresh.driver)
    old.setHandler(async () => { throw new Error('disconnect') })
    await old.coordinator.call('a', 'type_text', { text: 'once' })
    await old.coordinator.call('a', 'get_window_state', { display_only: true })
    expect((await old.coordinator.call('a', 'type_text', { text: 'before observation' })).isError).toBe(true)
    fresh.setHandler(async () => ({ content: [], structuredContent: { effect: 'refused' } }))
    expect((await old.coordinator.call('a', 'get_window_state', {})).isError).toBe(true)
    expect((await old.coordinator.call('a', 'launch_app', {})).isError).toBe(true)
    fresh.setHandler(async () => ({ content: [], structuredContent: {} }))
    await old.coordinator.call('a', 'verify_state', {})
    expect((await old.coordinator.call('a', 'type_text', { text: 'before observation' })).isError).toBe(true)
    await old.coordinator.call('a', 'get_desktop_state', {})
    expect((await old.coordinator.call('a', 'type_text', { text: 'explicit new action' })).isError).toBe(false)
    await old.coordinator.close()
  })
  it.each(['unknown', 'disconnect', 'cancel'])('isolates session initialization %s without starting input', async cause => {
    const fresh = fixture()
    const old = fixture(async () => fresh.driver)
    const abort = new AbortController()
    let started = false
    old.driver.call = async name => {
      expect(name).toBe('start_session')
      started = true
      if (cause === 'unknown') return { content: [], structuredContent: { execution_state: 'unknown' } }
      if (cause === 'disconnect') throw new Error('initialization disconnected')
      return await new Promise(() => {})
    }
    const task = old.coordinator.call('a', 'type_text', { text: 'must not execute' }, abort.signal)
    while (!started) await Promise.resolve()
    if (cause === 'cancel') abort.abort()
    expect((await task).isError).toBe(true)
    expect(old.isClosed()).toBe(true)
    expect((await old.coordinator.call('a', 'get_window_state', {})).isError).toBe(false)
    expect(fresh.calls.filter(call => call.name === 'type_text')).toHaveLength(0)
    await old.coordinator.close()
  })

  it('ends recovery at the 60-second deadline and closes a late driver before another attempt', async () => {
    const fresh = fixture()
    let finish!: (driver: NativeDriver) => void
    const reconnect = vi.fn(() => new Promise<NativeDriver>(resolve => { finish = resolve }))
    const old = fixture(reconnect)
    old.setHandler(async () => { throw new Error('disconnect') })
    await old.coordinator.call('a', 'type_text', { text: 'once' })
    vi.useFakeTimers()
    try {
      const read = old.coordinator.call('a', 'get_window_state', {})
      while (!finish) await Promise.resolve()
      await vi.advanceTimersByTimeAsync(60_000)
      expect((await read).isError).toBe(true)
      expect((await old.coordinator.call('a', 'get_window_state', {})).isError).toBe(true)
      expect(reconnect).toHaveBeenCalledTimes(1)
      finish(fresh.driver)
      await old.coordinator.close()
      expect(fresh.isClosed()).toBe(true)
      expect(fresh.calls).toHaveLength(0)
    } finally { vi.useRealTimers() }
  })

})
