import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TraceStore } from '../../src/core/trace-store.js'

describe('builtin writable trace snapshots', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'builtin-trace-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const make = (dir: string) => new TraceStore(1, dir, 'running.jsonl', 'trace-', ['trace-'], true)

  it('does not append another full snapshot when an active writer is acquired again', async () => {
    const store = make(dir)
    const trace = store.startTrace({ module_id: 'crabot-agent', trigger: { type: 'task', summary: 'worker' } })
    const archive = join(dir, `trace-${trace.started_at.slice(0, 10)}.jsonl`)
    await store.acquireBuiltinTraceWriter(trace.trace_id)
    const initial = readFileSync(archive, 'utf8')
    store.startSpan(trace.trace_id, { type: 'llm_call', details: { assistant_text: 'new span' } })
    await store.acquireBuiltinTraceWriter(trace.trace_id, 1)
    await store.acquireBuiltinTraceWriter(trace.trace_id, 1)
    expect(readFileSync(archive, 'utf8')).toBe(initial)
    store.releaseBuiltinTraceWriter(trace.trace_id)
    const snapshots = readFileSync(archive, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(snapshots).toHaveLength(2)
    expect(snapshots[1].spans).toEqual(trace.spans)
    expect((await make(dir).getFullTrace(trace.trace_id))?.spans).toEqual(trace.spans)
  })

  it('pins an active writer over capacity, evicts idle history, and reloads the exact prefix twice', async () => {
    let store = make(dir)
    const trace = store.startTrace({ module_id: 'crabot-agent', trigger: { type: 'task', summary: 'worker' } })
    await store.acquireBuiltinTraceWriter(trace.trace_id)
    store.startSpan(trace.trace_id, { type: 'llm_call', details: { assistant_text: 'first' } })
    const prefix = structuredClone(trace.spans)
    store.startTrace({ module_id: 'sub-agent', trigger: { type: 'sub_agent_call', summary: 'other' } })
    expect(store.getTrace(trace.trace_id)).toBe(trace)
    store.releaseBuiltinTraceWriter(trace.trace_id)
    expect(store.getTrace(trace.trace_id)).toBeUndefined()
    for (let restart = 0; restart < 2; restart++) {
      store = make(dir)
      await store.acquireBuiltinTraceWriter(trace.trace_id)
      store.reconcileDeferredBuiltinTraces()
      store.startSpan(trace.trace_id, { type: 'tool_result', details: { output_summary: `result-${restart}` } })
      store.releaseBuiltinTraceWriter(trace.trace_id)
      const saved = await store.getFullTrace(trace.trace_id)
      expect(saved?.spans.slice(0, prefix.length)).toEqual(prefix)
      expect(saved?.spans).toHaveLength(2 + restart)
      expect(saved?.status).toBe('running')
    }
  })

  it('holds the latest running snapshot until eligibility is decided, and interrupts rejected traces', async () => {
    const first = make(dir)
    const trace = first.startTrace({ module_id: 'crabot-agent', trigger: { type: 'task', summary: 'worker' } })
    await first.acquireBuiltinTraceWriter(trace.trace_id)
    first.startSpan(trace.trace_id, { type: 'tool_call', details: { call_id: 'pending-call' } })
    ;(first as unknown as { flushInFlightTraces(): void }).flushInFlightTraces()
    const second = make(dir)
    expect((await second.getFullTrace(trace.trace_id))?.status).toBe('running')
    second.reconcileDeferredBuiltinTraces()
    expect(await second.getFullTrace(trace.trace_id)).toMatchObject({ status: 'failed', spans: [expect.anything(), expect.objectContaining({ type: 'tool_result' })] })
  })

  it('fails writer acquisition for a missing persistent source', async () => {
    await expect(make(dir).acquireBuiltinTraceWriter('missing')).rejects.toThrow('unavailable')
  })

  it('appends one interrupted request after restart without rewriting the published prefix', async () => {
    const first = make(dir)
    const trace = first.startTrace({ module_id: 'crabot-agent', trigger: { type: 'task', summary: 'worker' } })
    await first.acquireBuiltinTraceWriter(trace.trace_id)
    first.startSpan(trace.trace_id, { type: 'decision', details: {
      kind: 'worker_runtime', version: 1, event: 'request_started', runtime: {
        incarnation_id: 'inc', as_of: '2026-09-21T00:00:00Z', phase: 'llm_request',
        request: { request_id: 'req', call_id: 'call', attempt: 1, purpose: 'inference', model_id: 'test', started_at: '2026-09-21T00:00:00Z' },
      },
    } })
    const prefix = structuredClone(trace.spans)
    ;(first as unknown as { flushInFlightTraces(): void }).flushInFlightTraces()
    const second = make(dir)
    second.reconcileDeferredBuiltinTraces()
    second.reconcileDeferredBuiltinTraces()
    const restored = await second.getFullTrace(trace.trace_id)
    expect(restored?.spans.slice(0, 1)).toEqual(prefix)
    expect(restored?.spans.slice(1)).toEqual([expect.objectContaining({ details: expect.objectContaining({ event: 'interrupted', runtime: expect.objectContaining({ phase: 'ended' }) }) })])
  })

  it('can finalize an idle trace already evicted from memory', async () => {
    const store = make(dir)
    const trace = store.startTrace({ module_id: 'crabot-agent', trigger: { type: 'task', summary: 'idle' } })
    await store.acquireBuiltinTraceWriter(trace.trace_id)
    store.releaseBuiltinTraceWriter(trace.trace_id)
    expect(store.getTrace(trace.trace_id)).toBeUndefined()
    store.endTrace(trace.trace_id, 'failed', { summary: '[killed]' })
    expect(await store.getFullTrace(trace.trace_id)).toMatchObject({ status: 'failed', outcome: { summary: '[killed]' } })
  })

  it('fills an incident-sized gap with markers and appends after the published cursor', async () => {
    const store = make(dir)
    const trace = store.startTrace({ module_id: 'crabot-agent', trigger: { type: 'task', summary: 'damaged' } })
    for (let i = 0; i < 270; i++) store.startSpan(trace.trace_id, { type: 'llm_call', details: {} })
    const prefix = structuredClone(trace.spans)
    await store.acquireBuiltinTraceWriter(trace.trace_id, 787)
    expect(trace.spans.slice(0, 270)).toEqual(prefix)
    const gap = trace.spans.slice(270)
    expect(gap).toHaveLength(517)
    expect(gap.every(span => span.type === 'decision'
      && (span.details as { decision_type?: string }).decision_type === 'trace_gap')).toBe(true)
    const appended = store.startSpan(trace.trace_id, { type: 'tool_result', details: { output_summary: 'after-restart' } })
    expect(trace.spans.indexOf(appended)).toBe(787)
  })

  it('still rejects an implausible cursor gap', async () => {
    const store = make(dir)
    const trace = store.startTrace({ module_id: 'crabot-agent', trigger: { type: 'task', summary: 'corrupt' } })
    store.startSpan(trace.trace_id, { type: 'llm_call', details: {} })
    await expect(store.acquireBuiltinTraceWriter(trace.trace_id, 100_002)).rejects.toThrow('implausible')
    expect(trace.spans).toHaveLength(1)
  })
})
