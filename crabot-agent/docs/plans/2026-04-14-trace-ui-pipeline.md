# Trace UI 管道补齐实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 TraceStore 已有的检索/聚合能力（searchTraces、getTraceTree、getFullTrace）通过 RPC → Admin REST → 前端 完整打通，让前端能以任务为单位聚合展示关联 Trace，并支持 rpc_call 等新 span type。

**Architecture:** TraceStore 内部方法已完备，本计划只做"管道"工作：Agent RPC 注册新方法、Admin 新增 REST 路由转发、前端新增 service 调用和 UI 组件。不改 TraceStore 内部逻辑。

**Tech Stack:** TypeScript, React, Vite

**Protocol:** `crabot-docs/protocols/protocol-agent-v2.md` §8（已更新至含 search_traces / get_trace_tree / Admin REST API）

---

### Task 1: Agent RPC — 注册 search_traces 和 get_trace_tree，修复 get_trace

**Files:**
- Modify: `crabot-agent/src/unified-agent.ts:450-453`（RPC 注册）
- Modify: `crabot-agent/src/unified-agent.ts:2117-2132`（handler 方法）

- [ ] **Step 1: 新增 RPC 注册**

在 `unified-agent.ts` 第 453 行（`clear_traces` 注册之后）追加：

```typescript
    this.registerMethod('search_traces', this.handleSearchTraces.bind(this))
    this.registerMethod('get_trace_tree', this.handleGetTraceTree.bind(this))
```

- [ ] **Step 2: 修复 handleGetTrace — 使用 getFullTrace 替代 getTrace**

将 `unified-agent.ts:2121-2127` 从：

```typescript
  private handleGetTrace(params: { trace_id: string }): { trace: import('./types.js').AgentTrace } {
    const trace = this.traceStore.getTrace(params.trace_id)
    if (!trace) {
      throw new Error(`Trace not found: ${params.trace_id}`)
    }
    return { trace }
  }
```

改为：

```typescript
  private async handleGetTrace(params: { trace_id: string }): Promise<{ trace: import('./types.js').AgentTrace }> {
    const trace = await this.traceStore.getFullTrace(params.trace_id)
    if (!trace) {
      throw new Error(`Trace not found: ${params.trace_id}`)
    }
    return { trace }
  }
```

- [ ] **Step 3: 新增 handleSearchTraces 和 handleGetTraceTree**

在 `handleClearTraces` 方法之后追加：

```typescript
  private handleSearchTraces(params: {
    task_id?: string
    time_range?: { start: string; end: string }
    keyword?: string
    status?: string
    limit?: number
    offset?: number
  }): { traces: import('./core/trace-store.js').TraceIndexEntry[]; total: number } {
    return this.traceStore.searchTraces(params)
  }

  private handleGetTraceTree(params: { task_id: string }): import('./core/trace-store.js').TraceTree {
    return this.traceStore.getTraceTree(params.task_id)
  }
```

- [ ] **Step 4: 验证构建**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crabot-agent/src/unified-agent.ts
git commit -m "feat(trace): expose search_traces and get_trace_tree RPC, fix get_trace to load from JSONL"
```

---

### Task 2: Admin REST API — 新增 search 和 trace-tree 路由

**Files:**
- Modify: `crabot-admin/src/index.ts:1351-1365`（路由区域）
- Modify: `crabot-admin/src/index.ts:4997-5053`（handler 区域）

- [ ] **Step 1: 新增路由匹配**

在 `crabot-admin/src/index.ts` 第 1359 行（`DELETE /api/agent/traces` 之后、`agentTraceDetailMatch` 之前）插入：

```typescript
      // search_traces 必须在 :traceId 之前匹配，避免 "search" 被当作 traceId
      if (pathname === '/api/agent/traces/search' && req.method === 'GET') {
        await this.handleSearchAgentTracesApi(req, res, url)
        return
      }

      const traceTreeMatch = pathname.match(/^\/api\/agent\/trace-tree\/([^/]+)$/)
      if (traceTreeMatch && req.method === 'GET') {
        await this.handleGetAgentTraceTreeApi(req, res, traceTreeMatch[1])
        return
      }
```

- [ ] **Step 2: 新增 handleSearchAgentTracesApi**

在 `handleClearAgentTracesApi` 方法之后追加：

```typescript
  private async handleSearchAgentTracesApi(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> {
    try {
      const port = await this.ensureAgentPort()
      if (!port) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Agent not available' }))
        return
      }
      const params: Record<string, unknown> = {}
      const taskId = url.searchParams.get('task_id')
      if (taskId) params.task_id = taskId
      const keyword = url.searchParams.get('keyword')
      if (keyword) params.keyword = keyword
      const status = url.searchParams.get('status')
      if (status) params.status = status
      const start = url.searchParams.get('start')
      const end = url.searchParams.get('end')
      if (start && end) params.time_range = { start, end }
      params.limit = parseInt(url.searchParams.get('limit') ?? '20')
      params.offset = parseInt(url.searchParams.get('offset') ?? '0')

      const result = await this.rpcClient.call<
        Record<string, unknown>,
        { traces: unknown[]; total: number }
      >(port, 'search_traces', params, this.config.moduleId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: msg }))
    }
  }
```

- [ ] **Step 3: 新增 handleGetAgentTraceTreeApi**

```typescript
  private async handleGetAgentTraceTreeApi(
    _req: IncomingMessage,
    res: ServerResponse,
    taskId: string
  ): Promise<void> {
    try {
      const port = await this.ensureAgentPort()
      if (!port) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Agent not available' }))
        return
      }
      const result = await this.rpcClient.call<
        { task_id: string },
        unknown
      >(port, 'get_trace_tree', { task_id: taskId }, this.config.moduleId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: msg }))
    }
  }
```

- [ ] **Step 4: 验证构建**

Run: `cd crabot-admin && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crabot-admin/src/index.ts
git commit -m "feat(admin): add /api/agent/traces/search and /api/agent/trace-tree/:taskId routes"
```

---

### Task 3: 前端 service 层 — 新增类型和 API 调用

**Files:**
- Modify: `crabot-admin/web/src/services/trace.ts`

- [ ] **Step 1: 更新 AgentSpan type 和 AgentTrace interface**

将 `trace.ts` 中的 `AgentSpan.type` 联合类型和 `AgentTrace` interface 更新为：

```typescript
export interface AgentSpan {
  span_id: string
  parent_span_id?: string
  trace_id: string
  type: 'agent_loop' | 'llm_call' | 'tool_call' | 'sub_agent_call' | 'decision' | 'context_assembly' | 'memory_write' | 'rpc_call'
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  details: Record<string, unknown>
}

export interface AgentTrace {
  trace_id: string
  parent_trace_id?: string
  parent_span_id?: string
  related_task_id?: string
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

- [ ] **Step 2: 新增 TraceIndexEntry 和 TraceTree 类型**

在 `AgentTrace` 之后追加：

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
}

export interface TraceTree {
  task_id: string
  tree: {
    fronts: TraceIndexEntry[]
    worker: TraceIndexEntry | null
    subagents: TraceIndexEntry[]
  }
}

export interface SearchTracesResult {
  traces: TraceIndexEntry[]
  total: number
}
```

- [ ] **Step 3: 新增 service 方法**

在 `traceService` 对象中追加：

```typescript
  async searchTraces(params?: {
    task_id?: string
    keyword?: string
    status?: string
    start?: string
    end?: string
    limit?: number
    offset?: number
  }): Promise<SearchTracesResult> {
    const qs = new URLSearchParams()
    if (params?.task_id) qs.set('task_id', params.task_id)
    if (params?.keyword) qs.set('keyword', params.keyword)
    if (params?.status) qs.set('status', params.status)
    if (params?.start) qs.set('start', params.start)
    if (params?.end) qs.set('end', params.end)
    if (params?.limit) qs.set('limit', String(params.limit))
    if (params?.offset) qs.set('offset', String(params.offset))
    const query = qs.toString() ? `?${qs.toString()}` : ''
    return api.get<SearchTracesResult>(`/agent/traces/search${query}`)
  },

  async getTraceTree(taskId: string): Promise<TraceTree> {
    return api.get<TraceTree>(`/agent/trace-tree/${taskId}`)
  },
```

- [ ] **Step 4: Commit**

```bash
git add crabot-admin/web/src/services/trace.ts
git commit -m "feat(web): add search_traces, getTraceTree API and TraceIndexEntry/TraceTree types"
```

---

### Task 4: 前端 UI — rpc_call span type 支持

**Files:**
- Modify: `crabot-admin/web/src/pages/Traces/index.tsx:23-47`（spanTypeLabel, spanTypeBg）
- Modify: `crabot-admin/web/src/pages/Traces/index.tsx:63-158`（SpanDetailPanel）
- Modify: `crabot-admin/web/src/pages/Traces/index.tsx:249-276`（detailSummary）

- [ ] **Step 1: spanTypeLabel 和 spanTypeBg 补 rpc_call**

```typescript
// spanTypeLabel 的 map 中追加：
    rpc_call: 'rpc',

// spanTypeBg 的 map 中追加：
    rpc_call: '#6366f1',  // indigo
```

- [ ] **Step 2: SpanDetailPanel 补 rpc_call 详情渲染**

在 `memory_write` 详情块之后（第 149 行之前）追加：

```typescript
  // rpc_call 详情
  if (span.type === 'rpc_call') {
    if (d.target_module) rows.push({ label: 'Target', value: String(d.target_module) })
    if (d.method) rows.push({ label: 'Method', value: String(d.method) })
    if (d.target_port) rows.push({ label: 'Port', value: String(d.target_port) })
    if (d.request_summary) {
      rows.push({ label: 'Request', value: String(d.request_summary), monospace: true })
    }
    if (d.response_summary) {
      rows.push({ label: 'Response', value: String(d.response_summary), monospace: true })
    }
    if (d.status_code) rows.push({ label: 'Status Code', value: String(d.status_code) })
    if (d.error) {
      rows.push({ label: 'Error', value: String(d.error), monospace: true })
    }
  }
```

- [ ] **Step 3: detailSummary 补 rpc_call 摘要**

在 `memory_write` 分支之后追加：

```typescript
    if (span.type === 'rpc_call') {
      return `${details.target_module ?? ''}::${details.method ?? ''}`
    }
```

- [ ] **Step 4: Commit**

```bash
git add crabot-admin/web/src/pages/Traces/index.tsx
git commit -m "feat(web): add rpc_call span type rendering (label, color, detail panel, summary)"
```

---

### Task 5: 前端 UI — Trace 列表聚合视图

**Files:**
- Modify: `crabot-admin/web/src/pages/Traces/index.tsx`

这是最大的 UI 改动。核心思路：Trace 列表从纯平铺改为**按 related_task_id 分组**，有 task_id 的 trace 聚合展示，没有的（direct_reply）单独展示。

- [ ] **Step 1: 在 Traces 组件中新增 grouped 视图的状态和数据**

在 `Traces` 组件的状态区域追加：

```typescript
  // 聚合视图：按 task_id 分组
  type ViewMode = 'flat' | 'grouped'
  const [viewMode, setViewMode] = useState<ViewMode>('grouped')
```

- [ ] **Step 2: 实现 trace 分组逻辑**

在 `Traces` 组件内新增分组计算：

```typescript
  interface TraceGroup {
    taskId: string | null          // null 表示无 task_id 的独立 trace
    traces: AgentTrace[]
    latestTime: string
    hasRunning: boolean
  }

  const traceGroups = useMemo((): TraceGroup[] => {
    if (viewMode === 'flat') return []

    const grouped = new Map<string, AgentTrace[]>()
    const ungrouped: AgentTrace[] = []

    for (const trace of traces) {
      if (trace.related_task_id) {
        const existing = grouped.get(trace.related_task_id) ?? []
        grouped.set(trace.related_task_id, [...existing, trace])
      } else {
        ungrouped.push(trace)
      }
    }

    const groups: TraceGroup[] = []

    for (const [taskId, taskTraces] of grouped) {
      groups.push({
        taskId,
        traces: taskTraces,
        latestTime: taskTraces.reduce((latest, t) =>
          t.started_at > latest ? t.started_at : latest, ''),
        hasRunning: taskTraces.some(t => t.status === 'running'),
      })
    }

    for (const trace of ungrouped) {
      groups.push({
        taskId: null,
        traces: [trace],
        latestTime: trace.started_at,
        hasRunning: trace.status === 'running',
      })
    }

    groups.sort((a, b) => new Date(b.latestTime).getTime() - new Date(a.latestTime).getTime())
    return groups
  }, [traces, viewMode])
```

需要在文件顶部追加 `useMemo` import：

```typescript
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
```

- [ ] **Step 3: 新增 TraceGroupItem 组件**

在 `SpanTree` 组件之前新增：

```typescript
interface TraceGroupItemProps {
  group: TraceGroup
  isSelected: boolean
  selectedTraceId: string | null
  onSelectTrace: (trace: AgentTrace) => void
}

const TraceGroupItem: React.FC<TraceGroupItemProps> = ({ group, isSelected, selectedTraceId, onSelectTrace }) => {
  const [expanded, setExpanded] = useState(false)

  // 单条 trace 的 group（无 task_id）不需要折叠
  if (group.taskId === null) {
    const trace = group.traces[0]
    return (
      <TraceListItem
        trace={trace}
        isSelected={selectedTraceId === trace.trace_id}
        onClick={() => onSelectTrace(trace)}
      />
    )
  }

  // 按角色排序：front → worker → sub_agent_call
  const roleOrder: Record<string, number> = { message: 0, task: 1, sub_agent_call: 2, schedule: 3 }
  const sorted = [...group.traces].sort((a, b) =>
    (roleOrder[a.trigger.type] ?? 9) - (roleOrder[b.trigger.type] ?? 9)
  )
  const primary = sorted.find(t => t.trigger.type === 'task') ?? sorted[0]
  const fronts = sorted.filter(t => t.trigger.type === 'message')
  const subagents = sorted.filter(t => t.trigger.type === 'sub_agent_call')

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      {/* 组头 */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '10px 12px',
          cursor: 'pointer',
          background: isSelected ? 'var(--bg-highlight, rgba(59,130,246,0.08))' : undefined,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            {expanded ? '▼' : '▶'}
          </span>
          <span
            style={{
              width: 8, height: 8, borderRadius: '50%',
              background: group.hasRunning ? '#f59e0b' : sorted.some(t => t.status === 'failed') ? '#ef4444' : '#10b981',
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 11, color: '#6366f1', fontWeight: 500 }}>
            task
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            {fronts.length}F {subagents.length > 0 ? `${subagents.length}S ` : ''}
          </span>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>
            {formatDuration(primary.duration_ms)}
          </span>
        </div>
        <div style={{
          fontSize: 12, color: 'var(--text-primary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {primary.trigger.summary}
        </div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
          {formatTime(primary.started_at)}
          {' · '}
          {group.taskId!.slice(0, 8)}
        </div>
      </div>

      {/* 展开时显示组内所有 trace */}
      {expanded && sorted.map(trace => (
        <TraceListItem
          key={trace.trace_id}
          trace={trace}
          isSelected={selectedTraceId === trace.trace_id}
          onClick={() => onSelectTrace(trace)}
          indent
        />
      ))}
    </div>
  )
}
```

- [ ] **Step 4: 新增 TraceListItem 组件**

抽取当前 trace 列表中单条 trace 的渲染逻辑为独立组件：

```typescript
interface TraceListItemProps {
  trace: AgentTrace
  isSelected: boolean
  onClick: () => void
  indent?: boolean
}

const triggerTypeLabel: Record<string, string> = {
  message: 'front',
  task: 'worker',
  sub_agent_call: 'sub-agent',
  schedule: 'schedule',
}

const TraceListItem: React.FC<TraceListItemProps> = ({ trace, isSelected, onClick, indent }) => (
  <div
    onClick={onClick}
    style={{
      padding: '10px 12px',
      paddingLeft: indent ? 28 : 12,
      borderBottom: '1px solid var(--border)',
      cursor: 'pointer',
      background: isSelected ? 'var(--bg-highlight, rgba(59,130,246,0.08))' : undefined,
      transition: 'background 0.1s',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <span
        style={{
          width: 8, height: 8, borderRadius: '50%',
          background: statusColor(trace.status),
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 11, color: '#9ca3af' }}>
        {triggerTypeLabel[trace.trigger.type] ?? trace.trigger.type}
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 11, color: '#9ca3af' }}>
        {formatDuration(trace.duration_ms)}
      </span>
    </div>
    <div style={{
      fontSize: 12, color: 'var(--text-primary)',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }}>
      {trace.trigger.summary}
    </div>
    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
      {formatTime(trace.started_at)}
      {trace.trigger.source && ` · ${trace.trigger.source}`}
    </div>
  </div>
)
```

- [ ] **Step 5: 更新主页面左侧列表渲染**

将现有 `traces.map(...)` 渲染替换为根据 viewMode 切换：

```typescript
{/* 视图模式切换 */}
<div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, fontSize: 12 }}>
  <span style={{ color: '#9ca3af' }}>共 {total} 条</span>
  <span style={{ flex: 1 }} />
  <span
    style={{ cursor: 'pointer', color: viewMode === 'grouped' ? '#3b82f6' : '#9ca3af' }}
    onClick={() => setViewMode('grouped')}
  >
    聚合
  </span>
  <span
    style={{ cursor: 'pointer', color: viewMode === 'flat' ? '#3b82f6' : '#9ca3af' }}
    onClick={() => setViewMode('flat')}
  >
    平铺
  </span>
</div>

{viewMode === 'flat' ? (
  traces.map(trace => (
    <TraceListItem
      key={trace.trace_id}
      trace={trace}
      isSelected={selectedTraceId === trace.trace_id}
      onClick={() => handleSelectTrace(trace)}
    />
  ))
) : (
  traceGroups.map((group, i) => (
    <TraceGroupItem
      key={group.taskId ?? `ungrouped-${i}`}
      group={group}
      isSelected={group.traces.some(t => t.trace_id === selectedTraceId)}
      selectedTraceId={selectedTraceId}
      onSelectTrace={handleSelectTrace}
    />
  ))
)}
```

- [ ] **Step 6: 验证前端构建**

Run: `cd crabot-admin/web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add crabot-admin/web/src/pages/Traces/index.tsx
git commit -m "feat(web): add grouped trace view by related_task_id with flat/grouped toggle"
```

---

### Task 6: 前端 UI — TraceDetail 增强（child_trace_id 跳转 + related_task_id 显示）

**Files:**
- Modify: `crabot-admin/web/src/pages/Traces/index.tsx`

- [ ] **Step 1: TraceDetail 标题区显示 related_task_id**

在 `TraceDetail` 组件的标题区（`trace.parent_trace_id` 块之后），追加：

```typescript
        {trace.related_task_id && (
          <div style={{ fontSize: 12, color: '#6366f1', marginBottom: 6 }}>
            任务: {trace.related_task_id.slice(0, 8)}...
          </div>
        )}
```

- [ ] **Step 2: SpanDetailPanel 的 tool_call 详情中支持 child_trace_id 点击**

需要给 `SpanDetailPanel` 传入一个 `onNavigateTrace` 回调。修改 `SpanDetailPanelProps`：

```typescript
interface SpanDetailPanelProps {
  span: AgentSpan
  onNavigateTrace?: (traceId: string) => void
}
```

在 tool_call 详情块中，当有 `child_trace_id` 时渲染为可点击链接：

```typescript
  // tool_call 详情 — 在 error 之后追加
  if (span.type === 'tool_call') {
    // ... existing tool_name, input, output, error rows ...
    if (d.child_trace_id) {
      rows.push({
        label: 'Sub Trace',
        value: (
          <span
            style={{ color: '#3b82f6', cursor: 'pointer', textDecoration: 'underline' }}
            onClick={() => onNavigateTrace?.(String(d.child_trace_id))}
          >
            {String(d.child_trace_id).slice(0, 8)}... →
          </span>
        ),
      })
    }
  }

  // sub_agent_call 详情 — child_trace_id 同样可点击
  if (span.type === 'sub_agent_call') {
    // ... existing target, method, task_id rows ...
    if (d.child_trace_id) {
      rows.push({
        label: 'Child Trace',
        value: (
          <span
            style={{ color: '#3b82f6', cursor: 'pointer', textDecoration: 'underline' }}
            onClick={() => onNavigateTrace?.(String(d.child_trace_id))}
          >
            {String(d.child_trace_id).slice(0, 8)}... →
          </span>
        ),
      })
    }
  }
```

- [ ] **Step 3: 实现 onNavigateTrace 回调**

在 `Traces` 主组件中：

```typescript
  const handleNavigateTrace = useCallback(async (traceId: string) => {
    // 先从已加载的 traces 中查找
    const existing = traces.find(t => t.trace_id === traceId)
    if (existing) {
      handleSelectTrace(existing)
      return
    }
    // 不在列表中，单独请求
    try {
      const result = await traceService.getTrace(traceId)
      setSelectedTraceId(result.trace.trace_id)
      setSelectedTrace(result.trace)
      setExpandedDetails(new Set())
    } catch {
      toast.error('无法加载关联 Trace')
    }
  }, [traces, toast])
```

然后将 `onNavigateTrace` 通过 props 逐层传递到 `SpanDetailPanel`：

- `TraceDetail` 接收 `onNavigateTrace` prop
- `SpanTree` 接收并传递给 `SpanRow`
- `SpanRow` 传递给 `SpanDetailPanel`

- [ ] **Step 4: 更新 prop 传递链**

`TraceDetailProps`:
```typescript
interface TraceDetailProps {
  trace: AgentTrace
  expandedDetails: Set<string>
  toggleDetail: (spanId: string) => void
  onNavigateTrace?: (traceId: string) => void
}
```

`SpanTreeProps`:
```typescript
interface SpanTreeProps {
  spans: AgentSpan[]
  parentSpanId?: string
  depth?: number
  expandedDetails: Set<string>
  toggleDetail: (spanId: string) => void
  onNavigateTrace?: (traceId: string) => void
}
```

`SpanRowProps`:
```typescript
interface SpanRowProps {
  span: AgentSpan
  spans: AgentSpan[]
  depth: number
  expandedDetails: Set<string>
  toggleDetail: (spanId: string) => void
  onNavigateTrace?: (traceId: string) => void
}
```

各组件内传递 `onNavigateTrace={onNavigateTrace}`。

在 `Traces` 主组件的 `<TraceDetail>` 调用处传入：

```typescript
<TraceDetail
  trace={selectedTrace}
  expandedDetails={expandedDetails}
  toggleDetail={toggleDetail}
  onNavigateTrace={handleNavigateTrace}
/>
```

- [ ] **Step 5: 验证前端构建**

Run: `cd crabot-admin/web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crabot-admin/web/src/pages/Traces/index.tsx
git commit -m "feat(web): add related_task_id display and child_trace_id click-to-navigate"
```

---

### Task 7: 最终集成验证

**Files:** 所有修改过的文件

- [ ] **Step 1: Agent 构建**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 2: Agent 测试**

Run: `cd crabot-agent && npx vitest run`
Expected: 所有测试 PASS

- [ ] **Step 3: Admin 构建**

Run: `cd crabot-admin && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: 前端构建**

Run: `cd crabot-admin/web && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 前端 Vite 构建**

Run: `cd crabot-admin && npm run build:web`
Expected: 构建成功，无报错

- [ ] **Step 6: 端到端自测**

启动开发环境：`./dev.sh`

验证项：
1. 访问 http://localhost:5173 → Trace 页面 → 看到聚合视图
2. 触发一条消息 → 观察 front trace 出现
3. 触发 create_task 决策 → 观察 front 和 worker trace 聚合到同一 group
4. 如有 sub-agent → 观察 sub-agent trace 也在 group 内
5. 点击 delegate_task 的 tool_call span → 展开详情 → 点击 child_trace_id → 跳转到 sub-agent trace
6. 切换平铺/聚合视图 → 正常切换
7. rpc_call span 正常显示颜色、摘要、详情
