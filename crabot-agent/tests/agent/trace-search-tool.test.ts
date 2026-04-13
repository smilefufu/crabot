import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createSearchTracesTool } from '../../src/agent/trace-search-tool'
import { TraceStore } from '../../src/core/trace-store'

describe('search_traces tool', () => {
  it('searches by keyword and returns summaries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-tool-'))
    try {
      const traces = [
        { trace_id: 't1', module_id: 'a', started_at: '2026-04-13T10:00:00Z', ended_at: '2026-04-13T10:01:00Z', duration_ms: 60000, status: 'completed', trigger: { type: 'task', summary: '翻译文档' }, outcome: { summary: '翻译完成' }, spans: [{ span_id: 's1', trace_id: 't1', type: 'llm_call', started_at: '2026-04-13T10:00:00Z', status: 'completed', details: {} }] },
        { trace_id: 't2', module_id: 'a', started_at: '2026-04-13T11:00:00Z', status: 'completed', trigger: { type: 'task', summary: '代码审查' }, outcome: { summary: '审查完毕' }, spans: [] },
      ]
      fs.writeFileSync(path.join(dir, 'traces-2026-04-13.jsonl'), traces.map(t => JSON.stringify(t)).join('\n') + '\n')

      const store = new TraceStore(10, dir)
      const tool = createSearchTracesTool(store)

      const result = await tool.call({ keyword: '翻译' }, { abortSignal: new AbortController().signal })
      const parsed = JSON.parse(result.output)

      expect(parsed.traces).toHaveLength(1)
      expect(parsed.traces[0].trace_id).toBe('t1')
      expect(parsed.traces[0].span_count).toBe(1)
      expect(result.isError).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('drills into spans when include_spans is true', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-tool-drill-'))
    try {
      const store = new TraceStore(10, dir)
      const trace = store.startTrace({
        module_id: 'a',
        trigger: { type: 'task', summary: 'work' },
        related_task_id: 'task-drill',
      })
      const loopSpan = store.startSpan(trace.trace_id, { type: 'agent_loop', details: { loop_label: 'worker' } })
      store.startSpan(trace.trace_id, {
        type: 'llm_call',
        parent_span_id: loopSpan.span_id,
        details: { iteration: 1, input_summary: 'hi' },
      })
      store.endTrace(trace.trace_id, 'completed', { summary: 'done' })

      const tool = createSearchTracesTool(store)

      // Top-level spans
      const result = await tool.call({ task_id: 'task-drill', include_spans: true }, { abortSignal: new AbortController().signal })
      const parsed = JSON.parse(result.output)
      expect(parsed.spans).toHaveLength(1)
      expect(parsed.spans[0].type).toBe('agent_loop')
      expect(parsed.spans[0].children_count).toBe(1)

      // Drill into loop span children
      const drill = await tool.call({
        task_id: 'task-drill',
        include_spans: true,
        parent_span_id: loopSpan.span_id,
      }, { abortSignal: new AbortController().signal })
      const drillParsed = JSON.parse(drill.output)
      expect(drillParsed.spans).toHaveLength(1)
      expect(drillParsed.spans[0].type).toBe('llm_call')
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('handles errors gracefully', async () => {
    const brokenStore = {
      searchTraces: () => { throw new Error('db connection failed') },
      getTraceTree: () => { throw new Error('db connection failed') },
      getSpansAtDepth: () => { throw new Error('db connection failed') },
    } as unknown as TraceStore

    const tool = createSearchTracesTool(brokenStore)
    const result = await tool.call({ keyword: 'test' }, { abortSignal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('db connection failed')
  })

  it('returns trace tree when searching by task_id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-tool-'))
    try {
      const traces = [
        { trace_id: 'f1', module_id: 'a', related_task_id: 'task-1', started_at: '2026-04-13T10:00:00Z', status: 'completed', trigger: { type: 'message', summary: 'create' }, spans: [] },
        { trace_id: 'w1', module_id: 'a', related_task_id: 'task-1', started_at: '2026-04-13T10:01:00Z', status: 'completed', trigger: { type: 'task', summary: 'work' }, spans: [] },
      ]
      fs.writeFileSync(path.join(dir, 'traces-2026-04-13.jsonl'), traces.map(t => JSON.stringify(t)).join('\n') + '\n')

      const store = new TraceStore(10, dir)
      const tool = createSearchTracesTool(store)

      const result = await tool.call({ task_id: 'task-1' }, { abortSignal: new AbortController().signal })
      const parsed = JSON.parse(result.output)

      expect(parsed.tree).toBeDefined()
      expect(parsed.tree.fronts).toHaveLength(1)
      expect(parsed.tree.worker.trace_id).toBe('w1')
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })
})
