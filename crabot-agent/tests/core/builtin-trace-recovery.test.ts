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

  it('does not append a full snapshot when an active writer is acquired again', async () => {
    const store = make(dir)
    const trace = store.startTrace({ module_id: 'crabot-agent', trigger: { type: 'task', summary: 'worker' } })
    const archive = join(dir, 'traces-v4', trace.started_at.slice(0, 10), trace.trace_id + '.jsonl')
    await store.acquireBuiltinTraceWriter(trace.trace_id)
    store.startSpan(trace.trace_id, { type: 'llm_call', details: { assistant_text: 'new span' } })
    await store.acquireBuiltinTraceWriter(trace.trace_id)
    await store.acquireBuiltinTraceWriter(trace.trace_id)
    store.releaseBuiltinTraceWriter(trace.trace_id)
    const records = readFileSync(archive, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(records.filter(record => record.type === 'snapshot')).toHaveLength(0)
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

  it('keeps every persisted span without cursor padding after restart', async () => {
    const store = make(dir)
    const trace = store.startTrace({ module_id: 'crabot-agent', trigger: { type: 'task', summary: 'damaged' } })
    for (let i = 0; i < 270; i++) store.startSpan(trace.trace_id, { type: 'llm_call', details: {} })
    const prefix = structuredClone(trace.spans)
    await store.acquireBuiltinTraceWriter(trace.trace_id)
    expect(trace.spans).toEqual(prefix)
    store.startSpan(trace.trace_id, { type: 'tool_result', details: { output_summary: 'after-restart' } })
    expect(store.readSpansAfterSeq(trace.trace_id, 0)?.spans).toHaveLength(271)
    expect(store.readSpansAfterSeq(trace.trace_id, 2)?.spans).toHaveLength(270)
    expect(store.readSpansAfterSeq(trace.trace_id, 2)?.spans.every(item => item.seq >= 2)).toBe(true)
  })
})
