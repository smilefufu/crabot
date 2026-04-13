import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { TraceStore } from '../../src/core/trace-store'

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
