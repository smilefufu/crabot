import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { TraceStore, SpanWithMeta } from '../../src/core/trace-store'

describe('TraceStore', () => {
  describe('startTrace with related_task_id', () => {
    it('accepts related_task_id in params', () => {
      const store = new TraceStore(10)
      const trace = store.startTrace({
        module_id: 'agent-1',
        trigger: { type: 'task', summary: 'execute task' },
        related_task_id: 'task-456',
      })
      expect(trace.related_task_id).toBe('task-456')
    })

    it('defaults related_task_id to undefined', () => {
      const store = new TraceStore(10)
      const trace = store.startTrace({
        module_id: 'agent-1',
        trigger: { type: 'message', summary: 'msg' },
      })
      expect(trace.related_task_id).toBeUndefined()
    })
  })

  describe('updateTrace', () => {
    it('updates related_task_id on an existing trace', () => {
      const store = new TraceStore(10)
      const trace = store.startTrace({
        module_id: 'agent-1',
        trigger: { type: 'message', summary: 'test msg' },
      })
      expect(trace.related_task_id).toBeUndefined()

      store.updateTrace(trace.trace_id, { related_task_id: 'task-123' })

      const updated = store.getTrace(trace.trace_id)
      expect(updated?.related_task_id).toBe('task-123')
    })

    it('does nothing for non-existent trace', () => {
      const store = new TraceStore(10)
      // Should not throw
      store.updateTrace('non-existent', { related_task_id: 'task-123' })
    })
  })
})

describe('TraceStore index', () => {
  it('rebuilds index from JSONL files on init', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'))
    try {
      const trace = {
        trace_id: 'trace-001',
        related_task_id: 'task-abc',
        module_id: 'agent-1',
        started_at: '2026-04-13T10:00:00.000Z',
        ended_at: '2026-04-13T10:01:00.000Z',
        duration_ms: 60000,
        status: 'completed',
        trigger: { type: 'task', summary: '翻译文档' },
        outcome: { summary: '翻译完成' },
        spans: [{ span_id: 's1', trace_id: 'trace-001', type: 'llm_call', started_at: '2026-04-13T10:00:01.000Z', status: 'completed', details: {} }],
      }
      fs.writeFileSync(path.join(dir, 'traces-2026-04-13.jsonl'), JSON.stringify(trace) + '\n')

      const store = new TraceStore(10, dir)
      const result = store.searchTraces({ task_id: 'task-abc' })
      expect(result.traces).toHaveLength(1)
      expect(result.traces[0].trace_id).toBe('trace-001')
      expect(result.traces[0].trigger_summary).toBe('翻译文档')
      expect(result.traces[0].span_count).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('searches by keyword in trigger_summary and outcome_summary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'))
    try {
      const traces = [
        { trace_id: 't1', module_id: 'a', started_at: '2026-04-13T10:00:00Z', status: 'completed', trigger: { type: 'task', summary: '翻译文档' }, outcome: { summary: '完成' }, spans: [] },
        { trace_id: 't2', module_id: 'a', started_at: '2026-04-13T11:00:00Z', status: 'completed', trigger: { type: 'task', summary: '代码审查' }, outcome: { summary: '发现3个问题' }, spans: [] },
      ]
      fs.writeFileSync(path.join(dir, 'traces-2026-04-13.jsonl'), traces.map(t => JSON.stringify(t)).join('\n') + '\n')

      const store = new TraceStore(10, dir)
      const result = store.searchTraces({ keyword: '翻译' })
      expect(result.traces).toHaveLength(1)
      expect(result.traces[0].trace_id).toBe('t1')
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('searches by time_range', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'))
    try {
      const traces = [
        { trace_id: 't1', module_id: 'a', started_at: '2026-04-12T10:00:00Z', status: 'completed', trigger: { type: 'message', summary: 'msg1' }, spans: [] },
        { trace_id: 't2', module_id: 'a', started_at: '2026-04-13T10:00:00Z', status: 'completed', trigger: { type: 'message', summary: 'msg2' }, spans: [] },
      ]
      fs.writeFileSync(path.join(dir, 'traces-2026-04-12.jsonl'), JSON.stringify(traces[0]) + '\n')
      fs.writeFileSync(path.join(dir, 'traces-2026-04-13.jsonl'), JSON.stringify(traces[1]) + '\n')

      const store = new TraceStore(10, dir)
      const result = store.searchTraces({ time_range: { start: '2026-04-13T00:00:00Z', end: '2026-04-14T00:00:00Z' } })
      expect(result.traces).toHaveLength(1)
      expect(result.traces[0].trace_id).toBe('t2')
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('indexes traces persisted at runtime', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'))
    try {
      const store = new TraceStore(10, dir)
      const trace = store.startTrace({
        module_id: 'a',
        trigger: { type: 'task', summary: '运行时任务' },
        related_task_id: 'task-rt',
      })
      store.endTrace(trace.trace_id, 'completed', { summary: '完成了' })

      const result = store.searchTraces({ task_id: 'task-rt' })
      expect(result.traces).toHaveLength(1)
      expect(result.traces[0].outcome_summary).toBe('完成了')
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('includes running traces from ring buffer in search results', () => {
    const store = new TraceStore(10)
    const trace = store.startTrace({
      module_id: 'a',
      trigger: { type: 'task', summary: '正在运行' },
    })
    // trace 还在 running 状态，没有 persistTrace
    void trace

    const result = store.searchTraces({ keyword: '运行' })
    expect(result.traces).toHaveLength(1)
    expect(result.traces[0].status).toBe('running')
  })
})

describe('TraceStore getFullTrace', () => {
  it('loads trace from ring buffer if available', async () => {
    const store = new TraceStore(10)
    const trace = store.startTrace({
      module_id: 'agent-1',
      trigger: { type: 'message', summary: 'test' },
    })
    store.startSpan(trace.trace_id, { type: 'llm_call', details: { iteration: 1, input_summary: 'hi' } })
    store.endTrace(trace.trace_id, 'completed', { summary: 'done' })

    const full = await store.getFullTrace(trace.trace_id)
    expect(full).toBeDefined()
    expect(full!.spans).toHaveLength(1)
  })

  it('loads trace from JSONL when evicted from ring buffer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-full-'))
    try {
      const store = new TraceStore(2, dir)

      const t1 = store.startTrace({ module_id: 'a', trigger: { type: 'message', summary: 't1' } })
      store.startSpan(t1.trace_id, { type: 'llm_call', details: { iteration: 1, input_summary: 'x' } })
      store.endTrace(t1.trace_id, 'completed', { summary: 'r1' })

      // Create 2 more traces to evict t1
      const t2 = store.startTrace({ module_id: 'a', trigger: { type: 'message', summary: 't2' } })
      store.endTrace(t2.trace_id, 'completed')
      const t3 = store.startTrace({ module_id: 'a', trigger: { type: 'message', summary: 't3' } })
      store.endTrace(t3.trace_id, 'completed')

      // t1 should be evicted from ring buffer
      expect(store.getTrace(t1.trace_id)).toBeUndefined()

      const full = await store.getFullTrace(t1.trace_id)
      expect(full).toBeDefined()
      expect(full!.trace_id).toBe(t1.trace_id)
      expect(full!.spans).toHaveLength(1)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })
})

describe('TraceStore getTraceTree', () => {
  it('groups traces by role (fronts/worker/subagents)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-tree-'))
    try {
      const traces = [
        { trace_id: 'front-1', module_id: 'a', related_task_id: 'task-1', started_at: '2026-04-13T10:00:00Z', status: 'completed', trigger: { type: 'message', summary: 'create task' }, spans: [] },
        { trace_id: 'worker-1', module_id: 'a', related_task_id: 'task-1', started_at: '2026-04-13T10:01:00Z', status: 'completed', trigger: { type: 'task', summary: 'do work' }, spans: [] },
        { trace_id: 'sub-1', module_id: 'a', related_task_id: 'task-1', parent_trace_id: 'worker-1', started_at: '2026-04-13T10:02:00Z', status: 'completed', trigger: { type: 'sub_agent_call', summary: 'delegate' }, spans: [] },
        { trace_id: 'front-2', module_id: 'a', related_task_id: 'task-1', started_at: '2026-04-13T10:03:00Z', status: 'completed', trigger: { type: 'message', summary: 'supplement' }, spans: [] },
      ]
      fs.writeFileSync(path.join(dir, 'traces-2026-04-13.jsonl'), traces.map(t => JSON.stringify(t)).join('\n') + '\n')

      const store = new TraceStore(10, dir)
      const tree = store.getTraceTree('task-1')

      expect(tree.task_id).toBe('task-1')
      expect(tree.tree.fronts).toHaveLength(2)
      expect(tree.tree.worker?.trace_id).toBe('worker-1')
      expect(tree.tree.subagents).toHaveLength(1)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('returns empty tree for unknown task_id', () => {
    const store = new TraceStore(10)
    const tree = store.getTraceTree('nonexistent')
    expect(tree.tree.fronts).toHaveLength(0)
    expect(tree.tree.worker).toBeNull()
    expect(tree.tree.subagents).toHaveLength(0)
  })
})

describe('TraceStore cleanupOldFiles', () => {
  it('removes JSONL files older than retention days', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-cleanup-'))
    try {
      fs.writeFileSync(path.join(dir, 'traces-2026-03-01.jsonl'), JSON.stringify({ trace_id: 'old', module_id: 'a', started_at: '2026-03-01T00:00:00Z', status: 'completed', trigger: { type: 'message', summary: 'old' }, spans: [] }) + '\n')
      fs.writeFileSync(path.join(dir, 'traces-2026-04-13.jsonl'), JSON.stringify({ trace_id: 'new', module_id: 'a', started_at: '2026-04-13T00:00:00Z', status: 'completed', trigger: { type: 'message', summary: 'new' }, spans: [] }) + '\n')

      const store = new TraceStore(10, dir)
      // Both should be in index
      expect(store.searchTraces({}).total).toBe(2)

      const removed = store.cleanupOldFiles(30)
      expect(removed).toBe(1)
      expect(fs.existsSync(path.join(dir, 'traces-2026-03-01.jsonl'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'traces-2026-04-13.jsonl'))).toBe(true)

      // Index should be updated
      expect(store.searchTraces({}).total).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('returns 0 when no files are expired', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-cleanup-'))
    try {
      fs.writeFileSync(path.join(dir, 'traces-2026-04-13.jsonl'), JSON.stringify({ trace_id: 'new', module_id: 'a', started_at: '2026-04-13T00:00:00Z', status: 'completed', trigger: { type: 'message', summary: 'new' }, spans: [] }) + '\n')

      const store = new TraceStore(10, dir)
      const removed = store.cleanupOldFiles(30)
      expect(removed).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })
})

describe('TraceStore getSpansAtDepth', () => {
  it('returns top-level spans with children_count', () => {
    const store = new TraceStore(10)
    const trace = store.startTrace({ module_id: 'a', trigger: { type: 'task', summary: 'test' } })

    const loopSpan = store.startSpan(trace.trace_id, { type: 'agent_loop', details: { loop_label: 'worker' } })
    const llmSpan = store.startSpan(trace.trace_id, {
      type: 'llm_call',
      parent_span_id: loopSpan.span_id,
      details: { iteration: 1, input_summary: 'x' },
    })
    store.startSpan(trace.trace_id, {
      type: 'tool_call',
      parent_span_id: llmSpan.span_id,
      details: { tool_name: 'search', input_summary: 'q' },
    })

    const result = store.getSpansAtDepth(trace.trace_id, {})
    expect(result.spans).toHaveLength(1)
    expect(result.spans[0].span_id).toBe(loopSpan.span_id)
    expect(result.spans[0].children_count).toBe(1)
    expect(result.span_total).toBe(1)
  })

  it('returns children of specific parent span', () => {
    const store = new TraceStore(10)
    const trace = store.startTrace({ module_id: 'a', trigger: { type: 'task', summary: 'test' } })

    const loopSpan = store.startSpan(trace.trace_id, { type: 'agent_loop', details: { loop_label: 'w' } })
    const llm1 = store.startSpan(trace.trace_id, {
      type: 'llm_call', parent_span_id: loopSpan.span_id, details: { iteration: 1, input_summary: 'a' },
    })
    const llm2 = store.startSpan(trace.trace_id, {
      type: 'llm_call', parent_span_id: loopSpan.span_id, details: { iteration: 2, input_summary: 'b' },
    })

    const result = store.getSpansAtDepth(trace.trace_id, { parent_span_id: loopSpan.span_id })
    expect(result.spans).toHaveLength(2)
    expect(result.spans.map(s => s.span_id)).toEqual([llm1.span_id, llm2.span_id])
  })
})
