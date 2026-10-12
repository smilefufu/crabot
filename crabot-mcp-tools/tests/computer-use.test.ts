import { describe, it, expect } from 'vitest'
import { ComputerUseCoordinator } from '../src/computer-use/coordinator'
import { NATIVE_TOOLS, type NativeDriver } from '../src/computer-use/types'

function fixture() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let handler = async () => ({ content: [], structuredContent: { effect: 'unverifiable' } })
  let closed = false
  const driver: NativeDriver = {
    async tools() { return NATIVE_TOOLS.map(name => ({ name, inputSchema: { type: 'object', properties: {
      session: { type: 'string' }, text: { type: 'string' }, element_token: { type: 'string' },
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
})
