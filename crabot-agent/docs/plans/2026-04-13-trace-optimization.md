# Trace 系统优化实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化 Agent trace 系统：修复 Front↔Worker 关联、Sub-agent 独立 trace、TraceStore 索引+检索、Agent search_traces 工具、JSONL 清理、短期记忆写入 trace_id。

**Architecture:** TraceStore 从简单 ring buffer 升级为带内存索引的查询引擎。通过 `related_task_id` 关联 Front/Worker/Sub-agent trace，通过 `parent_trace_id` 链接 Sub-agent 到 Worker。JSONL 持久化不变，新增启动时索引重建和定期清理。

**Tech Stack:** TypeScript, vitest, JSONL (file-based), Node.js fs API

**Spec:** `crabot-agent/docs/specs/2026-04-13-trace-optimization-design.md`

---

### Task 1: AgentTrace 数据模型变更

**Files:**
- Modify: `crabot-agent/src/types.ts:669-674` (ToolCallDetails)
- Modify: `crabot-agent/src/types.ts:736-755` (AgentTrace)

- [ ] **Step 1: 在 AgentTrace 中新增 `related_task_id` 字段**

```typescript
// types.ts 第 736 行起，AgentTrace 接口
export interface AgentTrace {
  trace_id: string
  parent_trace_id?: string
  parent_span_id?: string
  /** 关联的任务 ID（Front/Worker/Sub-agent 通过此字段关联） */
  related_task_id?: string    // ← 新增
  module_id: string
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  trigger: {
    type: 'message' | 'task' | 'schedule' | 'sub_agent_call'
    summary: string
    source?: string
  }
  spans: AgentSpan[]
  outcome?: {
    summary: string
    error?: string
  }
}
```

- [ ] **Step 2: 在 ToolCallDetails 中新增 `child_trace_id` 字段**

```typescript
// types.ts 第 669 行起
export interface ToolCallDetails {
  tool_name: string
  input_summary: string
  output_summary?: string
  error?: string
  /** 指向 sub-agent 的独立 trace（delegate_task 等场景） */
  child_trace_id?: string    // ← 新增
}
```

- [ ] **Step 3: 验证构建通过**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: PASS，无类型错误（新增的都是可选字段）

- [ ] **Step 4: Commit**

```bash
git add crabot-agent/src/types.ts
git commit -m "feat(trace): add related_task_id to AgentTrace and child_trace_id to ToolCallDetails"
```

---

### Task 2: TraceStore — updateTrace 与 startTrace 增强

**Files:**
- Modify: `crabot-agent/src/core/trace-store.ts`
- Create: `crabot-agent/tests/core/trace-store.test.ts`

- [ ] **Step 1: 写 updateTrace 的测试**

```typescript
// tests/core/trace-store.test.ts
import { describe, it, expect } from 'vitest'
import { TraceStore } from '../../src/core/trace-store'

describe('TraceStore', () => {
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
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd crabot-agent && npx vitest run tests/core/trace-store.test.ts`
Expected: FAIL — `updateTrace` 不存在，`startTrace` 不接受 `related_task_id`

- [ ] **Step 3: 实现 updateTrace 并增强 startTrace**

在 `trace-store.ts` 中：

1. `startTrace` 的 params 中新增 `related_task_id?: string`，创建 trace 时赋值
2. 新增 `updateTrace` 方法：

```typescript
// trace-store.ts — startTrace params 新增 related_task_id
startTrace(params: {
  module_id: string
  trigger: AgentTrace['trigger']
  parent_trace_id?: string
  parent_span_id?: string
  related_task_id?: string   // ← 新增
}): AgentTrace {
  const trace: AgentTrace = {
    trace_id: crypto.randomUUID(),
    parent_trace_id: params.parent_trace_id,
    parent_span_id: params.parent_span_id,
    related_task_id: params.related_task_id,   // ← 新增
    module_id: params.module_id,
    // ... 其余不变
  }
  // ... 其余不变
}

// 新方法
updateTrace(traceId: string, updates: { related_task_id?: string }): void {
  const trace = this.traces.get(traceId)
  if (!trace) return
  if (updates.related_task_id !== undefined) {
    trace.related_task_id = updates.related_task_id
  }
}
```

注意：这里对 trace 对象做了 mutation。这是 TraceStore 作为内部可变状态管理器的既有模式（endSpan/endTrace 都是 mutation），保持一致。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd crabot-agent && npx vitest run tests/core/trace-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crabot-agent/src/core/trace-store.ts crabot-agent/tests/core/trace-store.test.ts
git commit -m "feat(trace): add updateTrace and related_task_id support to TraceStore"
```

---

### Task 3: TraceStore — 内存索引与启动重建

**Files:**
- Modify: `crabot-agent/src/core/trace-store.ts`
- Modify: `crabot-agent/tests/core/trace-store.test.ts`

- [ ] **Step 1: 写索引相关类型**

在 `trace-store.ts` 顶部新增：

```typescript
export interface TraceIndexEntry {
  trace_id: string
  related_task_id?: string
  parent_trace_id?: string
  trigger_type: string
  trigger_summary: string
  started_at: string
  ended_at?: string
  status: 'running' | 'completed' | 'failed'
  outcome_summary?: string
  span_count: number
  file: string
  file_offset: number
}
```

- [ ] **Step 2: 写索引重建和查询的测试**

在 `tests/core/trace-store.test.ts` 中追加：

```typescript
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('TraceStore index', () => {
  it('rebuilds index from JSONL files on init', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'))
    
    // 写一个 mock JSONL 文件
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

    // Cleanup
    fs.rmSync(dir, { recursive: true })
  })

  it('searches by keyword in trigger_summary and outcome_summary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'))
    const traces = [
      { trace_id: 't1', module_id: 'a', started_at: '2026-04-13T10:00:00Z', status: 'completed', trigger: { type: 'task', summary: '翻译文档' }, outcome: { summary: '完成' }, spans: [] },
      { trace_id: 't2', module_id: 'a', started_at: '2026-04-13T11:00:00Z', status: 'completed', trigger: { type: 'task', summary: '代码审查' }, outcome: { summary: '发现3个问题' }, spans: [] },
    ]
    fs.writeFileSync(path.join(dir, 'traces-2026-04-13.jsonl'), traces.map(t => JSON.stringify(t)).join('\n') + '\n')

    const store = new TraceStore(10, dir)

    const result = store.searchTraces({ keyword: '翻译' })
    expect(result.traces).toHaveLength(1)
    expect(result.traces[0].trace_id).toBe('t1')

    fs.rmSync(dir, { recursive: true })
  })

  it('searches by time_range', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'))
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

    fs.rmSync(dir, { recursive: true })
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd crabot-agent && npx vitest run tests/core/trace-store.test.ts`
Expected: FAIL — `searchTraces` 不存在

- [ ] **Step 4: 实现索引结构和 searchTraces**

在 `trace-store.ts` 中：

```typescript
export class TraceStore {
  private traces: Map<string, AgentTrace> = new Map()
  private order: string[] = []
  private maxSize: number
  private persistDir: string | undefined

  // ---- 新增：索引 ----
  private traceIndex: TraceIndexEntry[] = []
  private taskIndex: Map<string, string[]> = new Map()

  constructor(maxSize = 100, persistDir?: string) {
    this.maxSize = maxSize
    this.persistDir = persistDir
    if (persistDir) {
      fs.mkdirSync(persistDir, { recursive: true })
      this.rebuildIndex()
    }
  }

  // 启动时从 JSONL 重建索引
  private rebuildIndex(): void {
    if (!this.persistDir) return
    try {
      const files = fs.readdirSync(this.persistDir)
        .filter(f => f.startsWith('traces-') && f.endsWith('.jsonl'))
        .sort()

      for (const file of files) {
        const filePath = path.join(this.persistDir, file)
        const content = fs.readFileSync(filePath, 'utf-8')
        let offset = 0
        for (const line of content.split('\n')) {
          if (!line.trim()) { offset += Buffer.byteLength(line + '\n', 'utf-8'); continue }
          try {
            const trace = JSON.parse(line) as AgentTrace
            const entry: TraceIndexEntry = {
              trace_id: trace.trace_id,
              related_task_id: trace.related_task_id,
              parent_trace_id: trace.parent_trace_id,
              trigger_type: trace.trigger.type,
              trigger_summary: trace.trigger.summary,
              started_at: trace.started_at,
              ended_at: trace.ended_at,
              status: trace.status,
              outcome_summary: trace.outcome?.summary,
              span_count: trace.spans?.length ?? 0,
              file,
              file_offset: offset,
            }
            this.traceIndex.push(entry)
            if (trace.related_task_id) {
              const existing = this.taskIndex.get(trace.related_task_id) ?? []
              this.taskIndex.set(trace.related_task_id, [...existing, trace.trace_id])
            }
          } catch { /* skip malformed lines */ }
          offset += Buffer.byteLength(line + '\n', 'utf-8')
        }
      }
    } catch { /* persist dir read failure */ }
  }

  // 统一查询接口
  searchTraces(params: {
    task_id?: string
    time_range?: { start: string; end: string }
    keyword?: string
    status?: string
    limit?: number
    offset?: number
  }): { traces: TraceIndexEntry[]; total: number } {
    let results = [...this.traceIndex]

    // 合并 ring buffer 中尚未持久化的 running trace 到搜索结果
    for (const trace of this.traces.values()) {
      if (trace.status === 'running' && !results.some(e => e.trace_id === trace.trace_id)) {
        results.push({
          trace_id: trace.trace_id,
          related_task_id: trace.related_task_id,
          parent_trace_id: trace.parent_trace_id,
          trigger_type: trace.trigger.type,
          trigger_summary: trace.trigger.summary,
          started_at: trace.started_at,
          ended_at: trace.ended_at,
          status: trace.status,
          outcome_summary: trace.outcome?.summary,
          span_count: trace.spans.length,
          file: '',
          file_offset: 0,
        })
      }
    }

    if (params.task_id) {
      const traceIds = new Set(this.taskIndex.get(params.task_id) ?? [])
      // Also check running traces in ring buffer
      for (const trace of this.traces.values()) {
        if (trace.related_task_id === params.task_id) traceIds.add(trace.trace_id)
      }
      results = results.filter(e => traceIds.has(e.trace_id))
    }

    if (params.time_range) {
      const start = new Date(params.time_range.start).getTime()
      const end = new Date(params.time_range.end).getTime()
      results = results.filter(e => {
        const t = new Date(e.started_at).getTime()
        return t >= start && t < end
      })
    }

    if (params.keyword) {
      const kw = params.keyword.toLowerCase()
      results = results.filter(e =>
        (e.trigger_summary?.toLowerCase().includes(kw)) ||
        (e.outcome_summary?.toLowerCase().includes(kw))
      )
    }

    if (params.status) {
      results = results.filter(e => e.status === params.status)
    }

    // 按时间倒序
    results.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())

    const total = results.length
    const limit = Math.min(params.limit ?? 20, 100)
    const offset = params.offset ?? 0
    return { traces: results.slice(offset, offset + limit), total }
  }

  // ... 其余方法不变
}
```

- [ ] **Step 5: 更新 persistTrace 同步写入索引**

在 `persistTrace` 方法中，成功写入文件后更新索引：

```typescript
private persistTrace(trace: AgentTrace): void {
  if (!this.persistDir) return
  try {
    const date = trace.started_at.slice(0, 10)
    const file = `traces-${date}.jsonl`
    const filePath = path.join(this.persistDir, file)
    const line = JSON.stringify(trace) + '\n'

    // 获取写入前的文件大小作为 offset
    let fileOffset = 0
    try { fileOffset = fs.statSync(filePath).size } catch { /* new file */ }

    fs.appendFileSync(filePath, line, 'utf-8')

    // 同步更新索引
    const entry: TraceIndexEntry = {
      trace_id: trace.trace_id,
      related_task_id: trace.related_task_id,
      parent_trace_id: trace.parent_trace_id,
      trigger_type: trace.trigger.type,
      trigger_summary: trace.trigger.summary,
      started_at: trace.started_at,
      ended_at: trace.ended_at,
      status: trace.status,
      outcome_summary: trace.outcome?.summary,
      span_count: trace.spans.length,
      file,
      file_offset: fileOffset,
    }
    this.traceIndex.push(entry)
    if (trace.related_task_id) {
      const existing = this.taskIndex.get(trace.related_task_id) ?? []
      this.taskIndex.set(trace.related_task_id, [...existing, trace.trace_id])
    }
  } catch {
    // persist failure must not affect main flow
  }
}
```

- [ ] **Step 6: 同步更新 updateTrace 索引维护**

```typescript
updateTrace(traceId: string, updates: { related_task_id?: string }): void {
  const trace = this.traces.get(traceId)
  if (!trace) return

  if (updates.related_task_id !== undefined) {
    trace.related_task_id = updates.related_task_id

    // 更新索引
    if (updates.related_task_id) {
      const existing = this.taskIndex.get(updates.related_task_id) ?? []
      if (!existing.includes(traceId)) {
        this.taskIndex.set(updates.related_task_id, [...existing, traceId])
      }
    }
  }
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd crabot-agent && npx vitest run tests/core/trace-store.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add crabot-agent/src/core/trace-store.ts crabot-agent/tests/core/trace-store.test.ts
git commit -m "feat(trace): add memory index, rebuildIndex, and searchTraces to TraceStore"
```

---

### Task 4: TraceStore — getFullTrace 按需加载与层级导航

**Files:**
- Modify: `crabot-agent/src/core/trace-store.ts`
- Modify: `crabot-agent/tests/core/trace-store.test.ts`

- [ ] **Step 1: 写 getFullTrace 测试**

```typescript
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
    const store = new TraceStore(2, dir)  // maxSize=2, will evict quickly

    // Create 3 traces to force eviction of first one
    const t1 = store.startTrace({ module_id: 'a', trigger: { type: 'message', summary: 't1' } })
    store.startSpan(t1.trace_id, { type: 'llm_call', details: { iteration: 1, input_summary: 'x' } })
    store.endTrace(t1.trace_id, 'completed', { summary: 'r1' })

    store.startTrace({ module_id: 'a', trigger: { type: 'message', summary: 't2' } })
    store.startTrace({ module_id: 'a', trigger: { type: 'message', summary: 't3' } })

    // t1 should be evicted from ring buffer but still in JSONL
    expect(store.getTrace(t1.trace_id)).toBeUndefined()

    const full = await store.getFullTrace(t1.trace_id)
    expect(full).toBeDefined()
    expect(full!.trace_id).toBe(t1.trace_id)
    expect(full!.spans).toHaveLength(1)

    fs.rmSync(dir, { recursive: true })
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

    const result = store.getSpansAtDepth(trace.trace_id, { span_depth: 1 })
    expect(result.spans).toHaveLength(1)  // only agent_loop (top-level)
    expect(result.spans[0].span_id).toBe(loopSpan.span_id)
    expect(result.spans[0].children_count).toBe(1)  // llm_call is child
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd crabot-agent && npx vitest run tests/core/trace-store.test.ts`
Expected: FAIL — `getFullTrace` 和 `getSpansAtDepth` 不存在

- [ ] **Step 3: 实现 getFullTrace**

```typescript
async getFullTrace(traceId: string): Promise<AgentTrace | undefined> {
  // 1. 先查 ring buffer
  const cached = this.traces.get(traceId)
  if (cached) return cached

  // 2. 从索引找到文件位置
  const indexEntry = this.traceIndex.find(e => e.trace_id === traceId)
  if (!indexEntry || !this.persistDir || !indexEntry.file) return undefined

  // 3. 从 JSONL 按需读取
  try {
    const filePath = path.join(this.persistDir, indexEntry.file)
    const fd = fs.openSync(filePath, 'r')
    try {
      // 读取从 offset 开始的一行
      const bufSize = 1024 * 1024 // 1MB max per trace line
      const buf = Buffer.alloc(bufSize)
      const bytesRead = fs.readSync(fd, buf, 0, bufSize, indexEntry.file_offset)
      const content = buf.toString('utf-8', 0, bytesRead)
      const lineEnd = content.indexOf('\n')
      const line = lineEnd >= 0 ? content.slice(0, lineEnd) : content
      return JSON.parse(line) as AgentTrace
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return undefined
  }
}
```

- [ ] **Step 4: 实现 getSpansAtDepth**

```typescript
export interface SpanWithMeta {
  span_id: string
  parent_span_id?: string
  trace_id: string
  type: AgentSpanType
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  details: AgentSpanDetails
  children_count: number
}

getSpansAtDepth(
  traceId: string,
  params: { span_depth?: number; parent_span_id?: string }
): { spans: SpanWithMeta[]; span_total: number } {
  const trace = this.traces.get(traceId)
  if (!trace) return { spans: [], span_total: 0 }

  const allSpans = trace.spans

  // 确定目标 span 列表
  let targetSpans: AgentSpan[]
  if (params.parent_span_id) {
    // 返回指定 parent 的直接子 span
    targetSpans = allSpans.filter(s => s.parent_span_id === params.parent_span_id)
  } else {
    // 返回顶层 span（无 parent_span_id 的）
    targetSpans = allSpans.filter(s => !s.parent_span_id)
  }

  // 计算每个 span 的 children_count
  const result: SpanWithMeta[] = targetSpans.map(span => ({
    ...span,
    children_count: allSpans.filter(s => s.parent_span_id === span.span_id).length,
  }))

  return { spans: result, span_total: result.length }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd crabot-agent && npx vitest run tests/core/trace-store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crabot-agent/src/core/trace-store.ts crabot-agent/tests/core/trace-store.test.ts
git commit -m "feat(trace): add getFullTrace (JSONL load) and getSpansAtDepth (tree navigation)"
```

---

### Task 5: TraceStore — getTraceTree 与 JSONL 清理

**Files:**
- Modify: `crabot-agent/src/core/trace-store.ts`
- Modify: `crabot-agent/tests/core/trace-store.test.ts`

- [ ] **Step 1: 写 getTraceTree 和清理的测试**

```typescript
describe('TraceStore getTraceTree', () => {
  it('groups traces by role (fronts/worker/subagents)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-tree-'))
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

    fs.rmSync(dir, { recursive: true })
  })
})

describe('TraceStore cleanup', () => {
  it('removes JSONL files older than retention days', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-cleanup-'))
    // 创建两个文件：一个旧的，一个新的
    fs.writeFileSync(path.join(dir, 'traces-2026-03-01.jsonl'), '{"trace_id":"old"}\n')
    fs.writeFileSync(path.join(dir, 'traces-2026-04-13.jsonl'), '{"trace_id":"new"}\n')

    const store = new TraceStore(10, dir)
    const removed = store.cleanupOldFiles(30)  // 30 天保留

    expect(removed).toBe(1)
    expect(fs.existsSync(path.join(dir, 'traces-2026-03-01.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(dir, 'traces-2026-04-13.jsonl'))).toBe(true)

    fs.rmSync(dir, { recursive: true })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd crabot-agent && npx vitest run tests/core/trace-store.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 getTraceTree**

```typescript
export interface TraceTree {
  task_id: string
  tree: {
    fronts: TraceIndexEntry[]
    worker: TraceIndexEntry | null
    subagents: TraceIndexEntry[]
  }
}

getTraceTree(taskId: string): TraceTree {
  const { traces } = this.searchTraces({ task_id: taskId, limit: 100 })

  const fronts: TraceIndexEntry[] = []
  let worker: TraceIndexEntry | null = null
  const subagents: TraceIndexEntry[] = []

  for (const t of traces) {
    switch (t.trigger_type) {
      case 'message':
        fronts.push(t)
        break
      case 'task':
        worker = t
        break
      case 'sub_agent_call':
        subagents.push(t)
        break
      default:
        // schedule 等其他类型暂归 fronts
        fronts.push(t)
    }
  }

  return { task_id: taskId, tree: { fronts, worker, subagents } }
}
```

- [ ] **Step 4: 实现 cleanupOldFiles**

```typescript
cleanupOldFiles(retentionDays: number): number {
  if (!this.persistDir) return 0

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  const cutoffStr = cutoff.toISOString().slice(0, 10) // YYYY-MM-DD

  let removed = 0
  try {
    const files = fs.readdirSync(this.persistDir)
      .filter(f => f.startsWith('traces-') && f.endsWith('.jsonl'))

    for (const file of files) {
      const dateStr = file.slice('traces-'.length, 'traces-'.length + 10)
      if (dateStr < cutoffStr) {
        fs.unlinkSync(path.join(this.persistDir, file))
        // 从索引中移除对应条目
        this.traceIndex = this.traceIndex.filter(e => e.file !== file)
        // 重建 taskIndex
        this.rebuildTaskIndex()
        removed++
      }
    }
  } catch { /* best effort */ }

  return removed
}

private rebuildTaskIndex(): void {
  this.taskIndex.clear()
  for (const entry of this.traceIndex) {
    if (entry.related_task_id) {
      const existing = this.taskIndex.get(entry.related_task_id) ?? []
      this.taskIndex.set(entry.related_task_id, [...existing, entry.trace_id])
    }
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd crabot-agent && npx vitest run tests/core/trace-store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crabot-agent/src/core/trace-store.ts crabot-agent/tests/core/trace-store.test.ts
git commit -m "feat(trace): add getTraceTree and cleanupOldFiles to TraceStore"
```

---

### Task 6: Front → Worker trace 关联修复

**Files:**
- Modify: `crabot-agent/src/orchestration/decision-dispatcher.ts`
- Modify: `crabot-agent/src/unified-agent.ts`

这个 task 不写新测试，因为 DecisionDispatcher 的现有测试和集成测试覆盖了 dispatch 流程。改动是纯参数传递，类型安全保证正确性。

- [ ] **Step 1: DecisionDispatcher — handleCreateTask 回填 related_task_id**

在 `decision-dispatcher.ts` 的 `handleCreateTask` 中，拿到 `task.id` 后回填 Front trace：

```typescript
// decision-dispatcher.ts handleCreateTask 方法
// 在 "const task = taskResult.task" 之后（第 231 行后），添加：

// 回填 Front trace 的 related_task_id
if (traceCtx?.traceStore && traceCtx.traceId) {
  traceCtx.traceStore.updateTrace(traceCtx.traceId, { related_task_id: task.id })
}
```

- [ ] **Step 2: DecisionDispatcher — executeTaskInBackground 传递 related_task_id**

修改 `executeTaskInBackground` 签名和调用：

```typescript
// decision-dispatcher.ts

// 第 251 行，调用处增加 task.id 参数：
this.executeTaskInBackground(task, enrichedContext, params, task.id)

// 第 259 行，方法签名增加 relatedTaskId：
private executeTaskInBackground(
  task: AdminTask,
  workerContext: import('../types.js').WorkerAgentContext,
  params: { ... },
  relatedTaskId: string,   // ← 新增
): void {
```

- [ ] **Step 3: DecisionDispatcher — Worker 执行时传递 related_task_id**

在 `executeTaskInBackground` 的 `workerHandler.executeTask` 调用处增加参数。

但注意：`workerHandler.executeTask` 当前签名是 `(params, traceCallback?)`，不接受 `related_task_id`。我们不在 Worker 层面传递，而是在 `unified-agent.ts` 的 `handleExecuteTask` 中处理。

因此需要在 `executeTaskInBackground` 中直接调用 `handleExecuteTask`（通过回调）而不是 `workerHandler.executeTask`。

实际上，看代码结构：`executeTaskInBackground` 直接调用 `this.workerHandler!.executeTask()`，而 `handleExecuteTask` 在 `unified-agent.ts` 中才是创建 trace 的地方。

所以需要给 DecisionDispatcher 一个回调来触发 `handleExecuteTask`：

```typescript
// decision-dispatcher.ts — 构造函数新增 executeTask 回调
constructor(
  private rpcClient: RpcClient,
  private moduleId: string,
  private contextAssembler: ContextAssembler,
  private memoryWriter: MemoryWriter,
  private getAdminPort: () => number | Promise<number>,
  private getChannelPort: (channelId: ModuleId) => Promise<number>,
  private executeTaskFn?: (params: import('../types.js').ExecuteTaskParams & { related_task_id?: string }) => Promise<import('../types.js').ExecuteTaskResult>,
) {}
```

然后在 `executeTaskInBackground` 中用 `executeTaskFn` 替代 `workerHandler.executeTask`：

```typescript
// executeTaskInBackground 中替换直接的 workerHandler 调用
const result = this.executeTaskFn
  ? await this.executeTaskFn({
      task: { task_id: task.id, task_title: task.title, task_description: task.description ?? '', task_type: task.type, priority: task.priority, plan: task.plan },
      context: workerContext,
      related_task_id: relatedTaskId,
    })
  : await this.workerHandler!.executeTask({
      task: { task_id: task.id, task_title: task.title, task_description: task.description ?? '', task_type: task.type, priority: task.priority, plan: task.plan },
      context: workerContext,
    })
```

- [ ] **Step 4: unified-agent.ts — handleExecuteTask 接收 related_task_id**

`handleExecuteTask` 已经接收 `parent_trace_id`，只需新增 `related_task_id`：

```typescript
// unified-agent.ts handleExecuteTask
private async handleExecuteTask(params: ExecuteTaskParams & {
  parent_trace_id?: string
  parent_span_id?: string
  related_task_id?: string    // ← 新增
}): Promise<ExecuteTaskResult> {
  // ...
  const { parent_trace_id, parent_span_id, related_task_id, ...taskParams } = params

  const trace = this.traceStore.startTrace({
    module_id: this.config.moduleId,
    trigger: { ... },
    parent_trace_id,
    parent_span_id,
    related_task_id,    // ← 传入
  })
  // ...
}
```

- [ ] **Step 5: unified-agent.ts — 注入 executeTaskFn 给 DecisionDispatcher**

在 UnifiedAgent 初始化 DecisionDispatcher 时传入回调：

```typescript
// unified-agent.ts 中 DecisionDispatcher 构造
this.decisionDispatcher = new DecisionDispatcher(
  this.rpcClient,
  this.config.moduleId,
  this.contextAssembler,
  this.memoryWriter,
  () => this.getAdminPort(),
  (channelId) => this.getChannelPort(channelId),
  (params) => this.handleExecuteTask(params),   // ← 新增
)
```

- [ ] **Step 6: supplement_task 回填 related_task_id**

在 `handleSupplementTask` 中添加回填：

```typescript
// decision-dispatcher.ts handleSupplementTask 方法
// 在方法开头（验证 workerHandler 后）添加：
if (traceCtx?.traceStore && traceCtx.traceId) {
  traceCtx.traceStore.updateTrace(traceCtx.traceId, { related_task_id: decision.task_id })
}
```

- [ ] **Step 7: 验证构建通过**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: 运行全量测试确认无回归**

Run: `cd crabot-agent && npx vitest run`
Expected: 所有现有测试 PASS

- [ ] **Step 9: Commit**

```bash
git add crabot-agent/src/orchestration/decision-dispatcher.ts crabot-agent/src/unified-agent.ts
git commit -m "fix(trace): connect Front↔Worker trace via related_task_id through dispatch chain"
```

---

### Task 7: Sub-agent 独立 Trace

**Files:**
- Modify: `crabot-agent/src/engine/sub-agent.ts`
- Modify: `crabot-agent/src/agent/worker-handler.ts`
- Modify: `crabot-agent/tests/engine/sub-agent.test.ts`

- [ ] **Step 1: 写 sub-agent 独立 trace 的测试**

在 `tests/engine/sub-agent.test.ts` 中追加：

```typescript
import { TraceStore } from '../../src/core/trace-store'

describe('createSubAgentTool with trace', () => {
  it('creates independent trace for sub-agent execution', async () => {
    const store = new TraceStore(10)
    const parentTrace = store.startTrace({
      module_id: 'agent-1',
      trigger: { type: 'task', summary: 'parent task' },
      related_task_id: 'task-999',
    })
    const parentSpan = store.startSpan(parentTrace.trace_id, {
      type: 'tool_call',
      details: { tool_name: 'delegate_task', input_summary: 'do something' },
    })

    const adapter = mockAdapter([textResponse('Sub result')])
    const tool = createSubAgentTool({
      name: 'delegate_task',
      description: 'delegate',
      adapter,
      model: 'test',
      systemPrompt: 'You are a sub-agent.',
      subTools: [],
      traceConfig: {
        traceStore: store,
        parentTraceId: parentTrace.trace_id,
        parentSpanId: parentSpan.span_id,
        relatedTaskId: 'task-999',
      },
    })

    const result = await tool.call!({ task: 'do something' }, { abortSignal: new AbortController().signal })
    expect(result.isError).toBe(false)

    // 验证 sub-agent 创建了独立 trace
    const allTraces = store.getTraces(10, 0)
    expect(allTraces.traces).toHaveLength(2)  // parent + sub-agent

    const subTrace = allTraces.traces.find(t => t.trigger.type === 'sub_agent_call')
    expect(subTrace).toBeDefined()
    expect(subTrace!.parent_trace_id).toBe(parentTrace.trace_id)
    expect(subTrace!.parent_span_id).toBe(parentSpan.span_id)
    expect(subTrace!.related_task_id).toBe('task-999')
    expect(subTrace!.status).toBe('completed')
    expect(subTrace!.spans.length).toBeGreaterThanOrEqual(1)  // at least llm_call span
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd crabot-agent && npx vitest run tests/engine/sub-agent.test.ts`
Expected: FAIL — `traceConfig` 不在 SubAgentToolConfig 中

- [ ] **Step 3: 修改 SubAgentToolConfig 新增 traceConfig**

```typescript
// sub-agent.ts

export interface SubAgentTraceConfig {
  readonly traceStore: import('../core/trace-store').TraceStore
  readonly parentTraceId: string
  readonly parentSpanId: string
  readonly relatedTaskId?: string
}

export interface SubAgentToolConfig {
  readonly name: string
  readonly description: string
  readonly adapter: LLMAdapter
  readonly model: string
  readonly systemPrompt: string
  readonly subTools: ReadonlyArray<ToolDefinition>
  readonly maxTurns?: number
  readonly onSubAgentTurn?: (event: EngineTurnEvent) => void
  readonly supportsVision?: boolean
  readonly parentHumanQueue?: HumanMessageQueue
  readonly traceConfig?: SubAgentTraceConfig  // ← 新增
}
```

- [ ] **Step 4: 修改 createSubAgentTool — 创建独立 trace**

在 `call` 函数内部，创建和管理 sub-agent trace：

```typescript
// sub-agent.ts createSubAgentTool 的 call 函数
call: async (input, callContext) => {
  let childQueue: HumanMessageQueue | undefined
  if (config.parentHumanQueue) {
    childQueue = config.parentHumanQueue.createChild((content) => {
      const text = typeof content === 'string' ? content : '[多媒体纠偏消息]'
      return formatSupplementForSubAgent(text)
    })
  }

  // 创建 sub-agent 独立 trace
  const tc = config.traceConfig
  let subTrace: import('../types').AgentTrace | undefined
  let subTraceCallback: ((event: EngineTurnEvent) => void) | undefined

  if (tc) {
    subTrace = tc.traceStore.startTrace({
      module_id: 'sub-agent',
      trigger: {
        type: 'sub_agent_call',
        summary: String(input.task).slice(0, 200),
      },
      parent_trace_id: tc.parentTraceId,
      parent_span_id: tc.parentSpanId,
      related_task_id: tc.relatedTaskId,
    })

    // 构造 trace 回调，每轮写入 span
    let currentLlmSpanId: string | undefined
    subTraceCallback = (event: EngineTurnEvent) => {
      // llm_call span
      const llmSpan = tc.traceStore.startSpan(subTrace!.trace_id, {
        type: 'llm_call',
        details: {
          iteration: event.turnNumber,
          input_summary: `turn ${event.turnNumber}`,
        },
      })
      currentLlmSpanId = llmSpan.span_id

      // tool_call spans
      for (const toolCall of event.toolCalls) {
        const toolSpan = tc.traceStore.startSpan(subTrace!.trace_id, {
          type: 'tool_call',
          parent_span_id: currentLlmSpanId,
          details: {
            tool_name: toolCall.name,
            input_summary: JSON.stringify(toolCall.input ?? {}).slice(0, 200),
          },
        })
        tc.traceStore.endSpan(subTrace!.trace_id, toolSpan.span_id,
          toolCall.isError ? 'failed' : 'completed',
          {
            output_summary: String(toolCall.output).slice(0, 500),
            error: toolCall.isError ? String(toolCall.output) : undefined,
          })
      }

      tc.traceStore.endSpan(subTrace!.trace_id, llmSpan.span_id, 'completed', {
        stop_reason: event.stopReason ?? undefined,
        output_summary: event.assistantText.slice(0, 200) || undefined,
        tool_calls_count: event.toolCalls.length > 0 ? event.toolCalls.length : undefined,
      })
    }
  }

  try {
    let prompt: string | ReadonlyArray<ContentBlock> = String(input.task)
    // ... image handling 不变 ...

    const result = await forkEngine({
      prompt,
      adapter: config.adapter,
      model: config.model,
      systemPrompt: config.systemPrompt,
      tools: config.subTools,
      maxTurns: config.maxTurns,
      parentContext: input.context !== undefined ? String(input.context) : undefined,
      abortSignal: callContext.abortSignal,
      onTurn: subTraceCallback ?? config.onSubAgentTurn,  // 优先用 trace callback
      supportsVision: config.supportsVision,
      humanMessageQueue: childQueue,
    })

    // 关闭 sub-agent trace
    if (subTrace && tc) {
      tc.traceStore.endTrace(subTrace.trace_id, result.outcome === 'failed' ? 'failed' : 'completed', {
        summary: result.output.slice(0, 200),
        error: result.outcome === 'failed' ? result.output.slice(0, 200) : undefined,
      })
    }

    return {
      output: JSON.stringify({
        output: result.output,
        outcome: result.outcome,
        totalTurns: result.totalTurns,
        child_trace_id: subTrace?.trace_id,   // 返回给调用方
      }),
      isError: result.outcome === 'failed',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (subTrace && tc) {
      tc.traceStore.endTrace(subTrace.trace_id, 'failed', { summary: message, error: message })
    }
    return { output: `Sub-agent error: ${message}`, isError: true }
  } finally {
    if (childQueue && config.parentHumanQueue) {
      config.parentHumanQueue.removeChild(childQueue)
    }
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd crabot-agent && npx vitest run tests/engine/sub-agent.test.ts`
Expected: PASS

- [ ] **Step 6: 修改 worker-handler.ts — 传入 traceConfig**

在 `worker-handler.ts` 中，将 `makeSubAgentTraceCallback` 替换为 `traceConfig` 模式。需要让 `executeTask` 也接收 `TraceStore` 引用和当前 trace 信息。

修改 `executeTask` 签名，增加 `traceContext` 参数：

```typescript
// worker-handler.ts

export interface WorkerTraceContext {
  traceStore: import('../core/trace-store').TraceStore
  traceId: string
  relatedTaskId?: string
}

async executeTask(
  params: ExecuteTaskParams,
  traceCallback?: TraceCallback,
  traceContext?: WorkerTraceContext,   // ← 新增
): Promise<ExecuteTaskResult>
```

然后在注册 sub-agent 工具时，传入 `traceConfig`：

```typescript
// 第 356-385 行 sub-agent 工具注册区域

// 需要在 onTurn 回调中拿到当前 tool_call 的 span_id
// 但 span_id 在 Worker 层由 traceCallback 管理，sub-agent 需要一个新 span

// 对于预定义 sub-agent：
for (const { definition, sdkEnv: subSdkEnv } of this.subAgentConfigs) {
  const toolSpanHolder = { spanId: '' }  // 占位，Worker onTurn 会填充
  tools.push(createSubAgentTool({
    name: definition.toolName,
    description: definition.toolDescription,
    adapter: adapterFromSdkEnv(subSdkEnv),
    model: subSdkEnv.modelId,
    systemPrompt: definition.systemPrompt,
    subTools: baseTools,
    maxTurns: definition.maxTurns,
    supportsVision: subSdkEnv.supportsVision,
    parentHumanQueue: humanQueue,
    traceConfig: traceContext ? {
      traceStore: traceContext.traceStore,
      parentTraceId: traceContext.traceId,
      parentSpanId: '',  // 将在 tool call 时由 wrapper 填充
      relatedTaskId: traceContext.relatedTaskId,
    } : undefined,
  }))
}

// delegate_task 工具同理
tools.push(createSubAgentTool({
  name: 'delegate_task',
  description: '...',
  adapter,
  model: this.sdkEnv.modelId,
  systemPrompt: DELEGATE_TASK_SYSTEM_PROMPT,
  subTools: baseTools,
  maxTurns: 30,
  supportsVision: this.sdkEnv.supportsVision,
  parentHumanQueue: humanQueue,
  traceConfig: traceContext ? {
    traceStore: traceContext.traceStore,
    parentTraceId: traceContext.traceId,
    parentSpanId: '',
    relatedTaskId: traceContext.relatedTaskId,
  } : undefined,
}))
```

注意：`parentSpanId` 为空字符串是因为 sub-agent 工具被注册时还不知道哪个 tool_call span 会触发它。实际的 parent span 关联通过 `parent_trace_id` 已经足够——sub-agent trace 的 `parent_trace_id` 指向 Worker trace。精确的 `parentSpanId` 关联可以在后续迭代中通过 tool call wrapper 实现，当前版本不阻塞功能。

- [ ] **Step 7: unified-agent.ts — 传递 traceContext 给 Worker**

在 `handleExecuteTask` 中传递：

```typescript
// unified-agent.ts handleExecuteTask
const traceContext: import('./agent/worker-handler').WorkerTraceContext = {
  traceStore: this.traceStore,
  traceId: trace.trace_id,
  relatedTaskId: related_task_id,
}

const result = await this.workerHandler.executeTask(taskParams, traceCallback, traceContext)
```

- [ ] **Step 8: 移除 makeSubAgentTraceCallback**

`makeSubAgentTraceCallback` 函数不再需要（sub-agent trace 现在在 createSubAgentTool 内部管理），删除它和对它的引用。

- [ ] **Step 9: 验证构建通过**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 10: 运行全量测试**

Run: `cd crabot-agent && npx vitest run`
Expected: PASS（现有 worker-handler 测试不传 traceContext，兼容）

- [ ] **Step 11: Commit**

```bash
git add crabot-agent/src/engine/sub-agent.ts crabot-agent/src/agent/worker-handler.ts crabot-agent/src/unified-agent.ts crabot-agent/tests/engine/sub-agent.test.ts
git commit -m "feat(trace): sub-agent creates independent trace with full span recording"
```

---

### Task 8: Agent LLM 工具 — search_traces

**Files:**
- Create: `crabot-agent/src/agent/trace-search-tool.ts`
- Create: `crabot-agent/tests/agent/trace-search-tool.test.ts`
- Modify: `crabot-agent/src/agent/worker-handler.ts` (注册工具)
- Modify: `crabot-agent/src/unified-agent.ts` (Front 工具注册)

- [ ] **Step 1: 写 trace-search-tool 的测试**

```typescript
// tests/agent/trace-search-tool.test.ts
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createSearchTracesTool } from '../../src/agent/trace-search-tool'
import { TraceStore } from '../../src/core/trace-store'

describe('search_traces tool', () => {
  it('searches by keyword and returns summaries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-tool-'))
    const traces = [
      { trace_id: 't1', module_id: 'a', started_at: '2026-04-13T10:00:00Z', ended_at: '2026-04-13T10:01:00Z', duration_ms: 60000, status: 'completed', trigger: { type: 'task', summary: '翻译文档' }, outcome: { summary: '翻译完成' }, spans: [{ span_id: 's1', trace_id: 't1', type: 'llm_call', started_at: '2026-04-13T10:00:00Z', status: 'completed', details: {} }] },
      { trace_id: 't2', module_id: 'a', started_at: '2026-04-13T11:00:00Z', status: 'completed', trigger: { type: 'task', summary: '代码审查' }, outcome: { summary: '审查完毕' }, spans: [] },
    ]
    fs.writeFileSync(path.join(dir, 'traces-2026-04-13.jsonl'), traces.map(t => JSON.stringify(t)).join('\n') + '\n')

    const store = new TraceStore(10, dir)
    const tool = createSearchTracesTool(store)

    const result = await tool.call!({ keyword: '翻译' }, { abortSignal: new AbortController().signal })
    const parsed = JSON.parse(result.output)

    expect(parsed.traces).toHaveLength(1)
    expect(parsed.traces[0].trace_id).toBe('t1')
    expect(parsed.traces[0].span_count).toBe(1)
    expect(result.isError).toBe(false)

    fs.rmSync(dir, { recursive: true })
  })

  it('returns trace tree when searching by task_id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-tool-'))
    const traces = [
      { trace_id: 'f1', module_id: 'a', related_task_id: 'task-1', started_at: '2026-04-13T10:00:00Z', status: 'completed', trigger: { type: 'message', summary: 'create' }, spans: [] },
      { trace_id: 'w1', module_id: 'a', related_task_id: 'task-1', started_at: '2026-04-13T10:01:00Z', status: 'completed', trigger: { type: 'task', summary: 'work' }, spans: [] },
    ]
    fs.writeFileSync(path.join(dir, 'traces-2026-04-13.jsonl'), traces.map(t => JSON.stringify(t)).join('\n') + '\n')

    const store = new TraceStore(10, dir)
    const tool = createSearchTracesTool(store)

    const result = await tool.call!({ task_id: 'task-1' }, { abortSignal: new AbortController().signal })
    const parsed = JSON.parse(result.output)

    expect(parsed.tree).toBeDefined()
    expect(parsed.tree.fronts).toHaveLength(1)
    expect(parsed.tree.worker.trace_id).toBe('w1')

    fs.rmSync(dir, { recursive: true })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd crabot-agent && npx vitest run tests/agent/trace-search-tool.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 trace-search-tool.ts**

```typescript
// src/agent/trace-search-tool.ts
import type { ToolDefinition } from '../engine/types'
import { defineTool } from '../engine/tool-framework'
import type { TraceStore } from '../core/trace-store'

export function createSearchTracesTool(traceStore: TraceStore): ToolDefinition {
  return defineTool({
    name: 'search_traces',
    description: '搜索历史执行记录。可按任务ID、时间范围、关键词检索。用于回顾历史任务的执行过程、回答用户关于"之前做过什么"的问题。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '按任务 ID 查找关联的所有执行记录' },
        keyword: { type: 'string', description: '关键词搜索（匹配任务摘要和执行结果）' },
        time_range: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'ISO 8601 开始时间' },
            end: { type: 'string', description: 'ISO 8601 结束时间' },
          },
        },
        status: { type: 'string', enum: ['running', 'completed', 'failed'], description: '状态过滤' },
        include_spans: { type: 'boolean', description: '是否返回 span 详情（默认 false）' },
        span_depth: { type: 'number', description: '返回到第几层 span（默认 1，仅 include_spans=true 时有效）' },
        parent_span_id: { type: 'string', description: '只返回某个 span 的子 span（用于逐层钻取）' },
        limit: { type: 'number', description: '返回条数（默认 20）' },
        offset: { type: 'number', description: '分页偏移（默认 0）' },
      },
    },
    isReadOnly: true,
    call: async (input) => {
      try {
        const params = input as {
          task_id?: string
          keyword?: string
          time_range?: { start: string; end: string }
          status?: string
          include_spans?: boolean
          span_depth?: number
          parent_span_id?: string
          limit?: number
          offset?: number
        }

        // 按 task_id 查询时返回 trace tree
        if (params.task_id && !params.include_spans) {
          const tree = traceStore.getTraceTree(params.task_id)
          return { output: JSON.stringify(tree), isError: false }
        }

        // 查看指定 trace 的 span（层级导航）
        if (params.include_spans && params.task_id) {
          // 先拿 tree 找到 traces
          const tree = traceStore.getTraceTree(params.task_id)
          const allTraceIds = [
            ...tree.tree.fronts.map(t => t.trace_id),
            ...(tree.tree.worker ? [tree.tree.worker.trace_id] : []),
            ...tree.tree.subagents.map(t => t.trace_id),
          ]
          // 对第一个匹配的 trace 进行 span 钻取
          const targetTraceId = allTraceIds[0]
          if (targetTraceId) {
            const full = await traceStore.getFullTrace(targetTraceId)
            if (full) {
              const spanResult = traceStore.getSpansAtDepth(targetTraceId, {
                span_depth: params.span_depth,
                parent_span_id: params.parent_span_id,
              })
              return {
                output: JSON.stringify({
                  trace_id: targetTraceId,
                  ...spanResult,
                }),
                isError: false,
              }
            }
          }
          return { output: JSON.stringify({ traces: [], total: 0 }), isError: false }
        }

        // 通用搜索
        const result = traceStore.searchTraces({
          task_id: params.task_id,
          keyword: params.keyword,
          time_range: params.time_range,
          status: params.status,
          limit: params.limit,
          offset: params.offset,
        })

        // 为每个 trace 补充 sub_trace_count
        const enriched = result.traces.map(t => ({
          ...t,
          sub_trace_count: traceStore.searchTraces({ task_id: t.related_task_id }).traces
            .filter(st => st.parent_trace_id === t.trace_id).length,
        }))

        return { output: JSON.stringify({ traces: enriched, total: result.total }), isError: false }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { output: `search_traces error: ${msg}`, isError: true }
      }
    },
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd crabot-agent && npx vitest run tests/agent/trace-search-tool.test.ts`
Expected: PASS

- [ ] **Step 5: 在 Worker 和 Front 中注册工具**

Worker 注册（`worker-handler.ts`，在 tools 数组构建区域）：

```typescript
// worker-handler.ts executeTask 方法中，tools 构建区域
// 在 3g (delegate_task) 之后添加：

// 3h. Trace search tool
if (traceContext) {
  const { createSearchTracesTool } = await import('./trace-search-tool.js')
  tools.push(createSearchTracesTool(traceContext.traceStore))
}
```

Front 工具需要在 `unified-agent.ts` 中注册。查看 front-loop 的工具注册机制，在 front 工具列表中添加 search_traces：

```typescript
// unified-agent.ts — front agent 工具构建区域
// 添加 search_traces 到 front 的工具列表
import { createSearchTracesTool } from './agent/trace-search-tool.js'
// 在 front tools 数组中加入：
frontTools.push(createSearchTracesTool(this.traceStore))
```

具体插入位置需要根据 front-loop 的工具注入点确定。

- [ ] **Step 6: 验证构建通过**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add crabot-agent/src/agent/trace-search-tool.ts crabot-agent/tests/agent/trace-search-tool.test.ts crabot-agent/src/agent/worker-handler.ts crabot-agent/src/unified-agent.ts
git commit -m "feat(trace): add search_traces LLM tool for Agent trace retrieval"
```

---

### Task 9: JSONL 定期清理集成

**Files:**
- Modify: `crabot-agent/src/unified-agent.ts`

- [ ] **Step 1: 在 UnifiedAgent 启动时触发清理和设置定时器**

```typescript
// unified-agent.ts — 在模块 start() 或 constructor 中添加

// 启动时清理过期 JSONL
const retentionDays = parseInt(process.env.TRACE_RETENTION_DAYS ?? '30', 10)
const removed = this.traceStore.cleanupOldFiles(retentionDays)
if (removed > 0) {
  console.log(`[${this.config.moduleId}] Cleaned up ${removed} expired trace files (retention: ${retentionDays} days)`)
}

// 每天清理一次
this.traceCleanupInterval = setInterval(() => {
  const count = this.traceStore.cleanupOldFiles(retentionDays)
  if (count > 0) {
    console.log(`[${this.config.moduleId}] Daily cleanup: removed ${count} trace files`)
  }
}, 24 * 60 * 60 * 1000)
```

- [ ] **Step 2: 在模块关闭时清理 interval**

```typescript
// unified-agent.ts — stop() 或 destroy() 方法中
if (this.traceCleanupInterval) {
  clearInterval(this.traceCleanupInterval)
}
```

- [ ] **Step 3: 声明成员变量**

```typescript
// unified-agent.ts 类成员
private traceCleanupInterval?: ReturnType<typeof setInterval>
```

- [ ] **Step 4: 验证构建通过**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crabot-agent/src/unified-agent.ts
git commit -m "feat(trace): add startup and daily JSONL cleanup with configurable retention"
```

---

### Task 10: 短期记忆写入 trace_id

**Files:**
- Modify: `crabot-agent/src/orchestration/memory-writer.ts`
- Modify: `crabot-agent/src/orchestration/decision-dispatcher.ts`

- [ ] **Step 1: MemoryWriter 的 WriteTaskCreatedParams 和 WriteTaskFinishedParams 新增 trace_id**

```typescript
// memory-writer.ts
export interface WriteTaskCreatedParams extends MemoryWriteBase {
  task_id: string
  task_title: string
  friend_name: string
  friend_id: string
  channel_id: string
  session_id: string
  worker_id?: string
  trace_id?: string    // ← 新增
}

export interface WriteTaskFinishedParams extends MemoryWriteBase {
  task_id: string
  task_title: string
  outcome: 'completed' | 'failed'
  summary: string
  friend_name: string
  friend_id: string
  channel_id: string
  session_id: string
  trace_id?: string    // ← 新增
}
```

- [ ] **Step 2: 在 refs 中写入 trace_id**

```typescript
// memory-writer.ts writeTaskCreated
refs: {
  task_id: params.task_id,
  friend_id: params.friend_id,
  session_id: params.session_id,
  channel_id: params.channel_id,
  ...(params.trace_id ? { trace_id: params.trace_id } : {}),
},

// memory-writer.ts writeTaskFinished 同理
refs: {
  task_id: params.task_id,
  friend_id: params.friend_id,
  session_id: params.session_id,
  channel_id: params.channel_id,
  ...(params.trace_id ? { trace_id: params.trace_id } : {}),
},
```

- [ ] **Step 3: DecisionDispatcher 传递 trace_id**

在 `executeTaskInBackground` 中，把 Worker trace 的 ID 传给 memoryWriter。

问题：Worker trace ID 在 `handleExecuteTask` 中创建，DecisionDispatcher 拿不到。解决方案：让 `executeTaskFn` 返回 trace_id。

修改 `executeTaskFn` 的返回类型：

```typescript
// 在 ExecuteTaskResult 类型中添加 trace_id 字段（或通过额外返回值）
// 最简方案：在 handleExecuteTask 返回结果中增加 trace_id

// unified-agent.ts handleExecuteTask
const result = await this.workerHandler.executeTask(taskParams, traceCallback, traceContext)
return { ...result, trace_id: trace.trace_id }
```

然后在 `executeTaskInBackground` 中：

```typescript
// decision-dispatcher.ts executeTaskInBackground
const result = await this.executeTaskFn!(...)

// 写入短期记忆时传入 trace_id
this.memoryWriter.writeTaskFinished({
  ...existingParams,
  trace_id: (result as { trace_id?: string }).trace_id,
}).catch(() => {})
```

- [ ] **Step 4: 验证构建通过**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 运行全量测试**

Run: `cd crabot-agent && npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crabot-agent/src/orchestration/memory-writer.ts crabot-agent/src/orchestration/decision-dispatcher.ts crabot-agent/src/unified-agent.ts
git commit -m "feat(trace): write trace_id into short-term memory refs for reflection cross-reference"
```

---

### Task 11: 最终集成验证

**Files:**
- All modified files

- [ ] **Step 1: 运行完整测试套件**

Run: `cd crabot-agent && npx vitest run`
Expected: 所有测试 PASS

- [ ] **Step 2: 验证 TypeScript 编译**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 构建**

Run: `cd crabot-agent && npm run build`
Expected: 构建成功

- [ ] **Step 4: Commit 最终状态**（如有遗漏调整）

```bash
git add -A crabot-agent/
git commit -m "chore(trace): final integration fixes for trace optimization"
```
