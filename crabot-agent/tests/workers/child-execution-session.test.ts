import { describe, it, expect, vi, afterEach } from 'vitest'
import { ChildExecutionSession } from '../../src/workers/builtin/child-execution-session.js'
import type { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'

afterEach(() => vi.useRealTimers())

function setup() {
  const records: any[] = []
  const settle = vi.fn(async (id: string, status: string) => { records.find(r => r.entity_id === id).exit_notification.status = status })
  const list = vi.fn(async () => records)
  const registry = { list, get: async (id: string) => records.find(r => r.entity_id === id), settleExitNotification: settle } as unknown as BgEntityRegistry
  const controller = new AbortController()
  const session = new ChildExecutionSession(registry, 'agent_child', controller.signal)
  return { records, settle, list, session, controller }
}

describe('child parent-input admission and continuation', () => {
  it('drains parent input FIFO once and separates it from shell receipts', async () => {
    const f = setup()
    f.records.push({ entity_id: 'shell_child', type: 'shell', status: 'completed', owner: { subagent_id: 'agent_child' }, exit_notification: { status: 'pending' } })
    f.session.notifyShell()
    expect(f.session.enqueue('first')).toBe(true)
    expect(f.session.enqueue('second')).toBe(true)
    const inputs = await f.session.drain()
    expect(inputs.slice(1)).toEqual(['[parent input]\nfirst', '[parent input]\nsecond'])
    expect(f.settle).not.toHaveBeenCalled()
    for (const text of inputs.slice(1)) f.session.onInjection({ type: 'external_input', text, turnNumber: 1, injectedAtMs: 0 })
    expect(f.settle).not.toHaveBeenCalled()
    f.session.onInjection({ type: 'external_input', text: inputs[0], turnNumber: 1, injectedAtMs: 0 })
    expect(await f.session.continueAfterTurn()).toBe(false)
    expect(f.records[0].exit_notification.status).toBe('delivered')
    expect(await f.session.drain()).toEqual([])
    expect(f.session.enqueue('late')).toBe(false)
  })
  it('resumes a suspended child for parent input without ending its shell', async () => {
    vi.useFakeTimers()
    const f = setup()
    f.records.push({ entity_id: 'shell_child', type: 'shell', status: 'running', owner: { subagent_id: 'agent_child' } })
    const continuing = f.session.continueAfterTurn()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.session.enqueue('reuse completed work')).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await continuing).toBe(true)
    expect(f.records[0].status).toBe('running')
    expect(await f.session.drain()).toEqual(['[parent input]\nreuse completed work'])
  })
  it('admission during the final dependency read wins over closing', async () => {
    const f = setup()
    f.list.mockImplementationOnce(async () => {
      expect(f.session.enqueue('arrived at end_turn')).toBe(true)
      return []
    })
    expect(await f.session.continueAfterTurn()).toBe(true)
    expect(await f.session.drain()).toEqual(['[parent input]\narrived at end_turn'])
    expect(await f.session.continueAfterTurn()).toBe(false)
    expect(f.session.enqueue('after final decision')).toBe(false)
  })
  it('parent input arriving during shell drain is retained and abort rejects new input', async () => {
    const f = setup()
    f.list.mockImplementationOnce(async () => { f.session.enqueue('during I/O'); return [] })
    expect(await f.session.drain()).toEqual(['[parent input]\nduring I/O'])
    f.controller.abort()
    expect(f.session.enqueue('after abort')).toBe(false)
    expect(await f.session.continueAfterTurn()).toBe(false)
  })
})
