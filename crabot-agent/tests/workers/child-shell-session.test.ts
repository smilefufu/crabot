import { describe, it, expect, vi } from 'vitest'
import { ChildShellSession } from '../../src/workers/builtin/child-shell-session.js'
import type { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'
function setup() {
  const records = ['one', 'two', 'sibling'].map((id, i) => ({ entity_id: id, type: 'shell', status: 'completed', exit_code: i ? 1 : 0,
    owner: { subagent_id: i === 2 ? 'other' : 'child' }, exit_notification: { status: 'pending' } }))
  let fail = false
  const settle = vi.fn(async (id: string, status: string) => { if (fail) throw new Error('write failed'); records.find(r => r.entity_id === id)!.exit_notification.status = status })
  const registry = { list: async () => records, get: async (id: string) => records.find(r => r.entity_id === id), settleExitNotification: settle } as unknown as BgEntityRegistry
  const controller = new AbortController(); const session = new ChildShellSession(registry, 'child', controller.signal)
  return { records, settle, session, controller, setFailure: (v: boolean) => { fail = v } }
}
describe('child shell input lifecycle', () => {
  it('does not acknowledge enqueue; consumes both own inputs and no sibling', async () => {
    const f = setup(); f.session.notify()
    expect(f.session.hasPending()).toBe(true)
    const inputs = await f.session.drain(); expect(inputs).toHaveLength(2); expect(f.settle).not.toHaveBeenCalled()
    expect(await f.session.continueAfterTurn()).toBe(true)
    for (const text of inputs) f.session.onInjection({ type: 'external_input', text, turnNumber: 1, injectedAtMs: 0 })
    expect(await f.session.continueAfterTurn()).toBe(false)
    expect(f.records.map(r => r.exit_notification.status)).toEqual(['delivered', 'delivered', 'pending'])
    expect(await f.session.drain()).toEqual([])
  })
  it('receipt failure retains consumed identity and does not reinject or lose pending', async () => {
    const f = setup(); f.setFailure(true)
    const inputs = await f.session.drain()
    for (const text of inputs) f.session.onInjection({ type: 'external_input', text, turnNumber: 1, injectedAtMs: 0 })
    await Promise.resolve(); expect(await f.session.drain()).toEqual([])
    expect(f.records[0].exit_notification.status).toBe('pending')
    f.setFailure(false); expect(await f.session.continueAfterTurn()).toBe(false)
    expect(f.records[0].exit_notification.status).toBe('delivered')
  })
  it('cancelled child settles remaining inputs without waking its parent', async () => {
    const f = setup(); f.controller.abort(); await f.session.close()
    expect(f.records.map(r => r.exit_notification.status)).toEqual(['dead_letter', 'dead_letter', 'pending'])
  })
})
