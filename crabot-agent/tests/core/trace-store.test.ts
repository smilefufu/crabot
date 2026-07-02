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

  describe('in-flight trace flush + reload (survives SIGKILL)', () => {
    function makeTempDir(): string {
      return fs.mkdtempSync(path.join(os.tmpdir(), 'trace-store-flush-'))
    }

    it('flushed in-flight trace is visible after store recreation (simulates SIGKILL + restart)', () => {
      const dir = makeTempDir()
      try {
        const store1 = new TraceStore(10, dir)
        const trace = store1.startTrace({
          module_id: 'agent-1',
          trigger: { type: 'task', summary: 'long-running task' },
          related_task_id: 'task-victim',
        })
        // 模拟一个跑了几轮 turn 的 trace（in-flight，未 endTrace）
        store1.startSpan(trace.trace_id, { type: 'llm_call', details: { iteration: 1 } })
        // 触发 flush（私有方法用 any 绕过）
        ;(store1 as unknown as { flushInFlightTraces: () => void }).flushInFlightTraces()

        // 不调 endTrace —— 模拟 SIGKILL
        // 新进程启动，新 store 从同一 dir 加载
        const store2 = new TraceStore(10, dir)
        const result = store2.searchTraces({ task_id: 'task-victim' })
        expect(result.traces.length).toBe(1)
        expect(result.traces[0].trace_id).toBe(trace.trace_id)
        // 重启后 in-flight trace 被标为 failed (interrupted)，不保持 running
        expect(result.traces[0].status).toBe('failed')

        // getTrace 也应该能拿到完整数据（spans 等）
        const full = store2.getTrace(trace.trace_id)
        expect(full).toBeDefined()
        expect(full?.spans?.length ?? 0).toBeGreaterThan(0)
        expect(full?.outcome?.summary).toContain('interrupted')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('endTrace + next flush clears the trace from running file', () => {
      const dir = makeTempDir()
      try {
        const store = new TraceStore(10, dir)
        const trace = store.startTrace({
          module_id: 'agent-1',
          trigger: { type: 'task', summary: 'done task' },
        })
        ;(store as unknown as { flushInFlightTraces: () => void }).flushInFlightTraces()

        // 完成 trace → 走 append 到 traces-{date}.jsonl
        store.endTrace(trace.trace_id, 'completed', { summary: 'ok' })
        // 再触发 flush：running 文件应该清掉这条
        ;(store as unknown as { flushInFlightTraces: () => void }).flushInFlightTraces()

        const runningPath = path.join(dir, 'traces-running.jsonl')
        const content = fs.existsSync(runningPath) ? fs.readFileSync(runningPath, 'utf-8') : ''
        expect(content).toBe('')

        // 新 store 加载时不会再误把已完成的 trace 当 running 加进去
        const store2 = new TraceStore(10, dir)
        const completed = store2.searchTraces({})
        expect(completed.traces.filter(t => t.trace_id === trace.trace_id && t.status === 'running').length).toBe(0)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('startFlushTimer triggers periodic flush', async () => {
      const dir = makeTempDir()
      try {
        const store = new TraceStore(10, dir)
        const trace = store.startTrace({
          module_id: 'agent-1',
          trigger: { type: 'task', summary: 'timer test' },
        })
        store.startFlushTimer(50)
        await new Promise(resolve => setTimeout(resolve, 120))
        store.stopFlushTimer()

        const runningPath = path.join(dir, 'traces-running.jsonl')
        expect(fs.existsSync(runningPath)).toBe(true)
        const content = fs.readFileSync(runningPath, 'utf-8')
        expect(content).toContain(trace.trace_id)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})

describe('TraceStore index', () => {
  it('finds the latest resume checkpoint for a completed worker trace by related task id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'))
    try {
      const older = {
        trace_id: 'trace-old',
        related_task_id: 'task-done',
        module_id: 'agent-1',
        started_at: '2026-04-13T10:00:00.000Z',
        ended_at: '2026-04-13T10:01:00.000Z',
        status: 'completed',
        trigger: { type: 'task', summary: 'older worker' },
        spans: [],
        resume_checkpoint: {
          agent_version: '1.0.0',
          system_prompt: 'SP-old',
          messages: [{ id: 'old', role: 'user', content: 'old', timestamp: 1 }],
          worker_state: { todo_items: [] },
        },
      }
      const newer = {
        trace_id: 'trace-new',
        related_task_id: 'task-done',
        module_id: 'agent-1',
        started_at: '2026-04-13T11:00:00.000Z',
        ended_at: '2026-04-13T11:01:00.000Z',
        status: 'completed',
        trigger: { type: 'task', summary: 'newer worker' },
        spans: [],
        resume_checkpoint: {
          agent_version: '1.0.0',
          system_prompt: 'SP-new',
          messages: [{ id: 'new', role: 'user', content: 'new', timestamp: 2 }],
          worker_state: { todo_items: [] },
        },
      }
      const dispatcher = {
        trace_id: 'trace-dispatcher',
        related_task_id: 'task-done',
        module_id: 'agent-1',
        started_at: '2026-04-13T12:00:00.000Z',
        ended_at: '2026-04-13T12:01:00.000Z',
        status: 'completed',
        trigger: { type: 'message', summary: 'supplement dispatch' },
        spans: [],
      }
      fs.writeFileSync(
        path.join(dir, 'traces-2026-04-13.jsonl'),
        [older, newer, dispatcher].map(t => JSON.stringify(t)).join('\n') + '\n',
      )

      const store = new TraceStore(10, dir)
      const result = store.findLatestResumeCheckpointByTaskId('task-done')

      expect(result?.traceId).toBe('trace-new')
      expect(result?.checkpoint.system_prompt).toBe('SP-new')
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

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

  it('allows internal callers to request up to 1000 trace index entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'))
    try {
      const traces = Array.from({ length: 150 }, (_, i) => ({
        trace_id: `trace-${String(i).padStart(3, '0')}`,
        related_task_id: `task-${i}`,
        module_id: 'a',
        started_at: `2026-04-13T10:${String(i % 60).padStart(2, '0')}:${String(Math.floor(i / 60)).padStart(2, '0')}Z`,
        status: 'completed',
        trigger: { type: 'message', summary: `补充 ${i}` },
        spans: [],
      }))
      fs.writeFileSync(path.join(dir, 'traces-2026-04-13.jsonl'), traces.map(t => JSON.stringify(t)).join('\n') + '\n')

      const store = new TraceStore(10, dir)
      const result = store.searchTraces({ limit: 1000 })

      expect(result.total).toBe(150)
      expect(result.traces).toHaveLength(150)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
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
      expect(tree.tree.workers).toHaveLength(1)
      expect(tree.tree.workers[0]?.trace_id).toBe('worker-1')
      expect(tree.tree.subagents).toHaveLength(1)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('返回一个 task 的全部 worker run（resume 续起的多条 trace 不被合并丢弃），按时间升序', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-tree-multi-'))
    try {
      const traces = [
        { trace_id: 'front-1', module_id: 'a', related_task_id: 'task-1', started_at: '2026-04-13T10:00:00Z', status: 'completed', trigger: { type: 'message', summary: 'create' }, spans: [] },
        // 重启后那条 run（时间更晚）写在前面，验证返回时被按时间升序排
        { trace_id: 'worker-post', module_id: 'a', related_task_id: 'task-1', started_at: '2026-04-13T10:05:00Z', status: 'completed', trigger: { type: 'task', summary: 'resumed' }, spans: [] },
        { trace_id: 'worker-pre', module_id: 'a', related_task_id: 'task-1', started_at: '2026-04-13T10:01:00Z', status: 'completed', trigger: { type: 'task', summary: 'pre-restart' }, spans: [] },
      ]
      fs.writeFileSync(path.join(dir, 'traces-2026-04-13.jsonl'), traces.map(t => JSON.stringify(t)).join('\n') + '\n')

      const store = new TraceStore(10, dir)
      const tree = store.getTraceTree('task-1')

      expect(tree.tree.workers).toHaveLength(2)                       // 两条 worker run 都在
      expect(tree.tree.workers.map(w => w.trace_id)).toEqual(['worker-pre', 'worker-post']) // 时间升序
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('returns empty tree for unknown task_id', () => {
    const store = new TraceStore(10)
    const tree = store.getTraceTree('nonexistent')
    expect(tree.tree.fronts).toHaveLength(0)
    expect(tree.tree.workers).toHaveLength(0)
    expect(tree.tree.subagents).toHaveLength(0)
  })
})

describe('TraceStore cleanupOldFiles', () => {
  it('removes JSONL files older than retention days', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-cleanup-'))
    try {
      const oldDateStr = new Date(Date.now() - 86400_000 * 60).toISOString().slice(0, 10)
      const newDateStr = new Date(Date.now() - 86400_000 * 5).toISOString().slice(0, 10)
      fs.writeFileSync(path.join(dir, `traces-${oldDateStr}.jsonl`), JSON.stringify({ trace_id: 'old', module_id: 'a', started_at: `${oldDateStr}T00:00:00Z`, status: 'completed', trigger: { type: 'message', summary: 'old' }, spans: [] }) + '\n')
      fs.writeFileSync(path.join(dir, `traces-${newDateStr}.jsonl`), JSON.stringify({ trace_id: 'new', module_id: 'a', started_at: `${newDateStr}T00:00:00Z`, status: 'completed', trigger: { type: 'message', summary: 'new' }, spans: [] }) + '\n')

      const store = new TraceStore(10, dir)
      // Both should be in index
      expect(store.searchTraces({}).total).toBe(2)

      const removed = store.cleanupOldFiles(30)
      expect(removed).toBe(1)
      expect(fs.existsSync(path.join(dir, `traces-${oldDateStr}.jsonl`))).toBe(false)
      expect(fs.existsSync(path.join(dir, `traces-${newDateStr}.jsonl`))).toBe(true)

      // Index should be updated
      expect(store.searchTraces({}).total).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('returns 0 when no files are expired', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-cleanup-'))
    try {
      const newDateStr = new Date(Date.now() - 86400_000 * 5).toISOString().slice(0, 10)
      fs.writeFileSync(path.join(dir, `traces-${newDateStr}.jsonl`), JSON.stringify({ trace_id: 'new', module_id: 'a', started_at: `${newDateStr}T00:00:00Z`, status: 'completed', trigger: { type: 'message', summary: 'new' }, spans: [] }) + '\n')

      const store = new TraceStore(10, dir)
      const removed = store.cleanupOldFiles(30)
      expect(removed).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })
})

describe('TraceStore.getDiskUsage', () => {
  it('returns total bytes + trace count + mtime range', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-disk-'))
    try {
      const store = new TraceStore(10, dir)
      const t1 = store.startTrace({ module_id: 'a', trigger: { type: 'message', summary: 'msg2' } })
      store.endTrace(t1.trace_id, 'completed')

      const usage = store.getDiskUsage()
      expect(usage.total_bytes).toBeGreaterThan(0)
      expect(usage.trace_count).toBeGreaterThanOrEqual(1)
      expect(usage.oldest_iso).toBeTruthy()
      expect(usage.newest_iso).toBeTruthy()
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('returns zero stats when directory empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-disk-empty-'))
    try {
      const store = new TraceStore(10, dir)
      const usage = store.getDiskUsage()
      expect(usage.total_bytes).toBe(0)
      expect(usage.trace_count).toBe(0)
      expect(usage.oldest_iso).toBeUndefined()
      expect(usage.newest_iso).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

})

describe('TraceStore.cleanupOldTraces', () => {
  it('dryRun=true returns stats without deleting', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-clean-dry-'))
    try {
      const oldDate = new Date(Date.now() - 86400_000 * 60)
      const oldDateStr = oldDate.toISOString().slice(0, 10)
      const fname = `traces-${oldDateStr}.jsonl`
      fs.writeFileSync(path.join(dir, fname), JSON.stringify({
        trace_id: 'old1', module_id: 'a', started_at: oldDate.toISOString(),
        status: 'completed', trigger: { type: 'message', summary: 'old' }, spans: []
      }) + '\n')

      const store = new TraceStore(10, dir)
      const result = store.cleanupOldTraces(30, true)
      expect(result.affected_count).toBe(1)
      expect(result.affected_bytes).toBeGreaterThan(0)
      expect(result.deleted_trace_ids).toEqual([]) // dryRun 不删

      // 文件仍在
      expect(fs.existsSync(path.join(dir, fname))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('dryRun=false actually deletes + returns trace ids', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-clean-real-'))
    try {
      const oldDate = new Date(Date.now() - 86400_000 * 60)
      const oldDateStr = oldDate.toISOString().slice(0, 10)
      const fname = `traces-${oldDateStr}.jsonl`
      fs.writeFileSync(path.join(dir, fname), JSON.stringify({
        trace_id: 'old1', module_id: 'a', started_at: oldDate.toISOString(),
        status: 'completed', trigger: { type: 'message', summary: 'old' }, spans: []
      }) + '\n' + JSON.stringify({
        trace_id: 'old2', module_id: 'a', started_at: oldDate.toISOString(),
        status: 'completed', trigger: { type: 'message', summary: 'old' }, spans: []
      }) + '\n')

      const store = new TraceStore(10, dir)
      const result = store.cleanupOldTraces(30, false)
      expect(result.affected_count).toBe(2) // 一文件含 2 trace
      expect(result.deleted_trace_ids).toEqual(expect.arrayContaining(['old1', 'old2']))
      expect(fs.existsSync(path.join(dir, fname))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('returns zero when no file older than days', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-clean-none-'))
    try {
      const todayStr = new Date().toISOString().slice(0, 10)
      const fname = `traces-${todayStr}.jsonl`
      fs.writeFileSync(path.join(dir, fname), JSON.stringify({
        trace_id: 'new1', module_id: 'a', started_at: new Date().toISOString(),
        status: 'completed', trigger: { type: 'message', summary: 'new' }, spans: []
      }) + '\n')

      const store = new TraceStore(10, dir)
      const result = store.cleanupOldTraces(30, false)
      expect(result.affected_count).toBe(0)
      expect(result.deleted_trace_ids).toEqual([])
      expect(fs.existsSync(path.join(dir, fname))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('returns zero when retentionDays <= 0', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-clean-zero-'))
    try {
      const store = new TraceStore(10, dir)
      const result = store.cleanupOldTraces(0, false)
      expect(result.affected_count).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

})

describe('TraceStore.cleanupOldTracesByCount', () => {
  // 给 traces-* 文件准备指定 trace_id 列表的 helper
  const writeTracesFile = (dir: string, dateStr: string, traceIds: string[]) => {
    const fname = `traces-${dateStr}.jsonl`
    const lines = traceIds.map(id => JSON.stringify({
      trace_id: id, module_id: 'a', started_at: `${dateStr}T00:00:00.000Z`,
      status: 'completed', trigger: { type: 'message', summary: id }, spans: [],
    }))
    fs.writeFileSync(path.join(dir, fname), lines.join('\n') + '\n')
    return fname
  }

  it('returns zero when total <= maxCount', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-clean-count-le-'))
    try {
      writeTracesFile(dir, '2026-06-01', ['a', 'b'])
      const store = new TraceStore(10, dir)
      const result = store.cleanupOldTracesByCount(5, false)
      expect(result.affected_count).toBe(0)
      expect(result.deleted_trace_ids).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('deletes whole older files when total > maxCount', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-clean-count-trim-'))
    try {
      writeTracesFile(dir, '2026-05-01', ['old1', 'old2'])
      writeTracesFile(dir, '2026-05-15', ['mid1'])
      writeTracesFile(dir, '2026-06-01', ['new1', 'new2'])

      const store = new TraceStore(10, dir)
      // total=5，保留最近 3 条：边界条在 2026-05-15（按 started_at 倒序第 3 条）
      // 比 2026-05-15 老的整文件删 → 删 2026-05-01（含 old1/old2）
      const result = store.cleanupOldTracesByCount(3, false)
      expect(result.affected_count).toBe(2)
      expect(result.deleted_trace_ids.sort()).toEqual(['old1', 'old2'])
      expect(fs.existsSync(path.join(dir, 'traces-2026-05-01.jsonl'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'traces-2026-05-15.jsonl'))).toBe(true)
      expect(fs.existsSync(path.join(dir, 'traces-2026-06-01.jsonl'))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('dryRun=true returns stats without deleting', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-clean-count-dry-'))
    try {
      writeTracesFile(dir, '2026-05-01', ['old1'])
      writeTracesFile(dir, '2026-06-01', ['new1', 'new2'])

      const store = new TraceStore(10, dir)
      const result = store.cleanupOldTracesByCount(2, true)
      expect(result.affected_count).toBe(1)
      expect(result.deleted_trace_ids).toEqual([])
      expect(fs.existsSync(path.join(dir, 'traces-2026-05-01.jsonl'))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('returns zero when maxCount <= 0', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-clean-count-zero-'))
    try {
      writeTracesFile(dir, '2026-05-01', ['old1'])
      const store = new TraceStore(10, dir)
      const result = store.cleanupOldTracesByCount(0, false)
      expect(result.affected_count).toBe(0)
      expect(fs.existsSync(path.join(dir, 'traces-2026-05-01.jsonl'))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('does not split same-day file (over-retention is OK)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-clean-count-sameday-'))
    try {
      // 一天 5 条；maxCount=2 不能切割文件，整天保留
      writeTracesFile(dir, '2026-06-01', ['a', 'b', 'c', 'd', 'e'])
      const store = new TraceStore(10, dir)
      const result = store.cleanupOldTracesByCount(2, false)
      expect(result.affected_count).toBe(0)
      expect(fs.existsSync(path.join(dir, 'traces-2026-06-01.jsonl'))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })
})

describe('flushWorkerCheckpoint', () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tracestore-'))
  }

  it('原子写 per-task 文件，含 messages + worker_state', () => {
    const dir = tmpDir()
    const store = new TraceStore(100, dir)
    const trace = store.startTrace({
      module_id: 'agent-1',
      trigger: { type: 'task', summary: 't' },
      related_task_id: 'task-1',
    })
    store.flushWorkerCheckpoint('task-1', trace.trace_id, {
      agent_version: '1.0.0',
      system_prompt: 'SP',
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
      worker_state: { todo_items: [] },
    })
    const file = path.join(dir, 'traces-running-task-1.jsonl')
    expect(fs.existsSync(file)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8').trim())
    expect(parsed.trace_id).toBe(trace.trace_id)
    expect(parsed.resume_checkpoint.messages).toHaveLength(1)
    expect(parsed.resume_checkpoint.system_prompt).toBe('SP')
    expect(fs.existsSync(file + '.tmp')).toBe(false)
  })
})

describe('loadResumableCheckpoints', () => {
  it('启动时把 per-task running 文件读进可 resume 集合，不写日期文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracestore-'))
    const trace = {
      trace_id: 'tr-1', module_id: 'agent-1', started_at: new Date(0).toISOString(),
      status: 'running', trigger: { type: 'task', summary: 't' }, related_task_id: 'task-9',
      spans: [],
      resume_checkpoint: { agent_version: '1.0.0', system_prompt: 'SP',
        messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }], worker_state: { todo_items: [] } },
    }
    fs.writeFileSync(path.join(dir, 'traces-running-task-9.jsonl'), JSON.stringify(trace) + '\n')

    const store = new TraceStore(100, dir)
    const cp = store.getResumableCheckpoint('task-9')
    expect(cp).toBeDefined()
    expect(cp!.checkpoint.messages).toHaveLength(1)
    const today = new Date().toISOString().slice(0, 10)
    expect(fs.existsSync(path.join(dir, `traces-${today}.jsonl`))).toBe(false)

    fs.rmSync(dir, { recursive: true, force: true })
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

describe('prompts 退役', () => {
  it('TraceStore 不再暴露 appendPromptDump', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-prompts-retire-'))
    try {
      const store = new TraceStore(100, dir)
      expect((store as unknown as Record<string, unknown>).appendPromptDump).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('TraceStore reactivateResumableTrace（resume 续写复用旧 trace）', () => {
  function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'trace-store-reactivate-'))
  }

  it('复用重启前的 trace：保留旧 span、status 仍 running、从 resumableCheckpoints 摘除', () => {
    const dir = makeTempDir()
    try {
      const store1 = new TraceStore(10, dir)
      const trace = store1.startTrace({
        module_id: 'agent-1',
        trigger: { type: 'task', summary: '重启一下整个 crabot 实例' },
        related_task_id: 'task-restart',
      })
      // 重启前那条 run 调了 request_restart（一个 span）
      const span = store1.startSpan(trace.trace_id, { type: 'llm_call', details: { iteration: 1 } })
      store1.endSpan(trace.trace_id, span.span_id, 'completed')
      // 写 per-task checkpoint → traces-running-<taskId>.jsonl（含 resume_checkpoint）
      store1.flushWorkerCheckpoint('task-restart', trace.trace_id, {
        agent_version: 'v1',
        system_prompt: 'sys',
        messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }] as never,
        worker_state: { todo_items: [], goal_revision_unlocked: false },
      })

      // 模拟重启：新 store 从同一 dir 加载（loadResumableCheckpoints 连 spans 载入 this.traces）
      const store2 = new TraceStore(10, dir)
      expect(store2.getResumableCheckpoint('task-restart')).toBeDefined()

      const reactivated = store2.reactivateResumableTrace('task-restart')
      expect(reactivated).not.toBeNull()
      expect(reactivated!.trace_id).toBe(trace.trace_id)            // 同一条 trace，非新建
      expect(reactivated!.status).toBe('running')                   // 没被 finalize
      expect(reactivated!.spans?.length ?? 0).toBeGreaterThan(0)    // 旧 span 还在
      expect(store2.getResumableCheckpoint('task-restart')).toBeUndefined() // 已摘除

      // 续写：新 run 的 span 追加到同一条 trace
      const span2 = store2.startSpan(reactivated!.trace_id, { type: 'llm_call', details: { iteration: 2 } })
      store2.endSpan(reactivated!.trace_id, span2.span_id, 'completed')
      const full = store2.getTrace(trace.trace_id)
      expect(full!.spans?.length ?? 0).toBeGreaterThanOrEqual(2)    // 旧+新 span 在同一条 trace
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无 resumable entry 时返回 null（调用方回退到新建）', () => {
    const store = new TraceStore(10)
    expect(store.reactivateResumableTrace('nope')).toBeNull()
  })

  it('按历史 trace_id 复用已完成 worker trace，供 terminal supplement 续写', () => {
    const dir = makeTempDir()
    try {
      const store1 = new TraceStore(10, dir)
      const trace = store1.startTrace({
        module_id: 'agent-1',
        trigger: { type: 'task', summary: '历史已完成任务' },
        related_task_id: 'task-terminal',
      })
      const span = store1.startSpan(trace.trace_id, { type: 'llm_call', details: { iteration: 1 } })
      store1.endSpan(trace.trace_id, span.span_id, 'completed')
      store1.flushWorkerCheckpoint('task-terminal', trace.trace_id, {
        agent_version: 'v1',
        system_prompt: 'sys',
        messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }] as never,
        worker_state: { todo_items: [], goal_revision_unlocked: false },
      })
      store1.endTrace(trace.trace_id, 'completed', { summary: 'done' })
      store1.clearCheckpointFile('task-terminal')

      const store2 = new TraceStore(10, dir)
      const reactivated = store2.reactivateTraceById(trace.trace_id)
      expect(reactivated).not.toBeNull()
      expect(reactivated!.trace_id).toBe(trace.trace_id)
      expect(reactivated!.status).toBe('running')
      expect(reactivated!.outcome).toBeUndefined()
      expect(store2.searchTraces({ task_id: 'task-terminal' }).traces[0]!.status).toBe('running')
      expect(store2.searchTraces({ task_id: 'task-terminal', status: 'completed' }).traces).toHaveLength(0)

      const span2 = store2.startSpan(trace.trace_id, { type: 'llm_call', details: { iteration: 2 } })
      store2.endSpan(trace.trace_id, span2.span_id, 'completed')
      expect(store2.getTrace(trace.trace_id)!.spans).toHaveLength(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
