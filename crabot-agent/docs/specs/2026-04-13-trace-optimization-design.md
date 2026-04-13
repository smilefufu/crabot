# Trace 系统优化设计

> 日期：2026-04-13
> 状态：设计完成，待实现

## 1. 目标

1. **Sub-agent 可观测性**：Sub-agent 生成独立 trace，完整记录每轮 LLM 调用和工具调用
2. **Trace 关联**：Front / Worker / Sub-agent 的 trace 通过 `related_task_id` 关联，形成完整的任务执行树
3. **Trace 可检索**：支持按 task_id、时间范围、关键词检索历史 trace
4. **Agent 自查能力**：Agent 通过 `search_traces` LLM 工具查询历史执行记录，支持日常对话和反思任务
5. **定期清理**：按天数自动清理过期 JSONL 文件

## 2. 数据模型变更

### 2.1 AgentTrace 新增字段

```typescript
interface AgentTrace {
  // ... 现有字段不变 ...

  /** 关联的任务 ID（Front/Worker/Sub-agent 通过此字段关联） */
  related_task_id?: string

  /** 父 trace ID（仅 Sub-agent trace，指向 Worker trace） */
  parent_trace_id?: string

  /** 父 span ID（Sub-agent 在 Worker trace 中对应的 tool_call span） */
  parent_span_id?: string
}
```

### 2.2 ToolCallDetails 新增字段

```typescript
interface ToolCallDetails {
  tool_name: string
  input_summary: string
  output_summary?: string
  error?: string
  /** 指向 sub-agent 的独立 trace */
  child_trace_id?: string   // 新增
}
```

### 2.3 关联模型

```
Front trace (trigger.type: 'message')
  related_task_id: "task-123"        ← create_task 决策后回填

Front trace (trigger.type: 'message')
  related_task_id: "task-123"        ← supplement_task 纠偏，task_id 已知

Worker trace (trigger.type: 'task')
  related_task_id: "task-123"        ← 从 dispatch 链路传入

Sub-agent trace (trigger.type: 'sub_agent_call')
  related_task_id: "task-123"        ← 继承自 Worker
  parent_trace_id: "<worker-trace>"  ← 指向 Worker trace
  parent_span_id: "<tool-call-span>" ← Worker 中 delegate_task 的 span
```

关键规则：
- `related_task_id` 是可选的（direct_reply 的 Front trace 没有 task_id）
- Front ↔ Worker 之间通过 `related_task_id` 关联，**不用** `parent_trace_id`
- `parent_trace_id` 只在 Sub-agent trace 中使用

## 3. Sub-agent 独立 Trace

### 3.1 当前问题

Sub-agent 的执行通过 `makeSubAgentTraceCallback` 记录为 Worker trace 中的 `llm_call` span，混在一起无法区分 Worker 自身的 LLM 调用和 Sub-agent 的。Sub-agent 内部的 tool_call 也没有记录。

### 3.2 改进方案

Sub-agent 执行时创建独立的 AgentTrace，复用现有 trace 结构：

```
Worker trace
├─ Span: llm_call (Worker 自己的第 1 轮)
├─ Span: tool_call (delegate_task)  ← child_trace_id 指向下方
│
└─ [独立] Sub-agent trace
    ├─ parent_trace_id: "<worker-trace-id>"
    ├─ parent_span_id: "<tool_call span_id>"
    ├─ related_task_id: 继承自 Worker
    ├─ trigger: { type: 'sub_agent_call', summary: '子任务描述' }
    │
    ├─ Span: llm_call (Sub-agent 第 1 轮)
    ├─ Span: tool_call (Sub-agent 工具调用)
    ├─ Span: llm_call (Sub-agent 第 2 轮)
    └─ outcome: { summary: '执行结果' }
```

### 3.3 实现要点

**SubAgentTraceConfig**：

```typescript
interface SubAgentTraceConfig {
  traceStore: TraceStore
  parentTraceId: string
  parentSpanId: string
  relatedTaskId?: string
}
```

加入 `SubAgentToolConfig`，`createSubAgentTool` 内部管理 sub-agent trace 的完整生命周期：
1. `forkEngine` 调用前，创建新的 AgentTrace
2. 构造独立的 traceCallback 绑定到新 trace
3. `forkEngine` 的 `onTurn` 回调写入新 trace 的 span（与 Worker/Front 粒度一致：`llm_call` + `tool_call`）
4. `forkEngine` 结束后，关闭 trace，写入 outcome

Worker 的 `tool_call` span 通过 `child_trace_id` 指向 sub-agent trace。

## 4. TraceStore 升级

### 4.1 内存索引结构

启动时从 JSONL 文件重建，只索引元数据：

```typescript
interface TraceIndexEntry {
  trace_id: string
  related_task_id?: string
  parent_trace_id?: string
  trigger_type: string
  trigger_summary: string
  started_at: string
  ended_at?: string
  status: 'running' | 'completed' | 'failed'
  outcome_summary?: string
  span_count: number        // span 总数
  file: string              // 所在 JSONL 文件名
  file_offset: number       // 字节偏移，快速定位
}
```

### 4.2 索引维护

```
TraceStore
├─ traces: Map<string, AgentTrace>       // 现有 ring buffer（最近 100 条完整 trace）
├─ traceIndex: TraceIndexEntry[]         // 所有未清理 trace 的元数据索引
├─ taskIndex: Map<string, string[]>      // task_id → trace_id[]
└─ 启动时: scanJsonlFiles() → 重建 traceIndex + taskIndex
```

- 新 trace 完成持久化时，同步更新索引
- Ring buffer 淘汰时只移出内存完整数据，索引保留
- 需要完整 trace 时，按 `file` + `file_offset` 从 JSONL 按需读取

### 4.3 统一查询接口

```typescript
interface TraceSearchParams {
  /** 按任务 ID 查关联的所有 trace */
  task_id?: string
  /** 时间范围 */
  time_range?: { start: string; end: string }
  /** 全文搜索（匹配 trigger_summary 和 outcome_summary） */
  keyword?: string
  /** 状态过滤 */
  status?: 'running' | 'completed' | 'failed'
  /** 分页 */
  limit?: number
  offset?: number
}

interface TraceSearchResult {
  traces: TraceIndexEntry[]
  total: number
}
```

### 4.4 完整 Trace 获取（含层级导航）

```typescript
// 获取完整 trace，支持 span 层级控制
interface GetFullTraceParams {
  trace_id: string
  /** 返回到第几层 span（默认 1，只返回顶层） */
  span_depth?: number
  /** 只返回某个 span 的子 span */
  parent_span_id?: string
}

// 返回的每个 span 附带 children_count
interface AgentSpanWithMeta extends AgentSpan {
  children_count: number
}
```

### 4.5 Trace 树查询

```typescript
// 按 task_id 获取完整执行树
interface TraceTree {
  task_id: string
  tree: {
    fronts: TraceIndexEntry[]           // 触发/纠偏的 Front trace
    worker: TraceIndexEntry | null      // Worker 执行 trace
    subagents: TraceIndexEntry[]        // Sub-agent trace
  }
}

getTraceTree(taskId: string): TraceTree
```

### 4.6 updateTrace 接口

Front trace 的 `related_task_id` 需要在决策执行后回填：

```typescript
updateTrace(traceId: string, updates: {
  related_task_id?: string
}): void
```

只允许更新 `related_task_id`，更新时同步刷新内存索引（traceIndex + taskIndex）。

## 5. Trace 关联传递链路修复

### 5.1 断裂点 1：Front → Worker

当前 `decision-dispatcher.ts` 的 `handleCreateTask` 没有传递 trace 信息给 `executeTaskInBackground`。

修复：
1. `handleCreateTask` 拿到 task_id 后，调用 `traceStore.updateTrace()` 回填 Front trace 的 `related_task_id`
2. `executeTaskInBackground` 接收并传递 `related_task_id` 给 `workerHandler.executeTask`
3. Worker trace 创建时写入 `related_task_id`

### 5.2 断裂点 2：supplement_task

当前 `handleSupplementTask` 中 Front trace 没有记录 `related_task_id`。

修复：
1. `handleSupplementTask` 中，调用 `traceStore.updateTrace()` 回填 Front trace 的 `related_task_id`（task_id 来自决策参数，已知）

### 5.3 断裂点 3：Sub-agent

由 §3 的独立 trace 方案解决：
- `createSubAgentTool` 创建 sub-agent trace 时，继承 Worker 的 `related_task_id`
- Worker 的 tool_call span 记录 `child_trace_id`

### 5.4 完整传递链路（修复后）

```
Front trace ← related_task_id 回填
  │
  ├─ create_task: task_id 产生 → 回填 front trace → 传递给 Worker
  │                                                      │
  └─ supplement_task: task_id 已知 → 回填 front trace     │
                                                          ↓
                                                   Worker trace (related_task_id)
                                                          │
                                                          ├─ delegate_task
                                                          │   → Sub-agent trace (继承 related_task_id)
                                                          │     parent_trace_id → Worker trace
                                                          │
                                                          └─ delegate_to_vision_expert
                                                              → Sub-agent trace (同上)
```

## 6. Agent LLM 工具：search_traces

### 6.1 工具定义

```typescript
{
  name: 'search_traces',
  description: '搜索历史执行记录。可按任务ID、时间范围、关键词检索。用于回顾历史任务的执行过程、回答用户关于"之前做过什么"的问题。',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: '按任务 ID 查找关联的所有执行记录'
      },
      keyword: {
        type: 'string',
        description: '关键词搜索（匹配任务摘要和执行结果）'
      },
      time_range: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'ISO 8601 开始时间' },
          end: { type: 'string', description: 'ISO 8601 结束时间' }
        }
      },
      status: {
        type: 'string',
        enum: ['running', 'completed', 'failed'],
        description: '状态过滤'
      },
      include_spans: {
        type: 'boolean',
        description: '是否返回 span 详情（默认 false）'
      },
      span_depth: {
        type: 'number',
        description: '返回到第几层 span（默认 1，仅 include_spans=true 时有效）'
      },
      parent_span_id: {
        type: 'string',
        description: '只返回某个 span 的子 span（用于逐层钻取）'
      },
      limit: { type: 'number', description: '返回条数（默认 20）' },
      offset: { type: 'number', description: '分页偏移（默认 0）' }
    }
  }
}
```

### 6.2 返回格式

**不含 spans（默认）**：

```typescript
{
  traces: Array<{
    trace_id: string
    related_task_id?: string
    trigger: { type: string, summary: string }
    status: string
    started_at: string
    duration_ms?: number
    outcome_summary?: string
    span_count: number         // span 总数，供 Agent 判断量级
    sub_trace_count: number    // 关联的子 trace 数量
  }>,
  total: number
}
```

**含 spans（include_spans=true）**：

```typescript
{
  trace: AgentTrace,           // spans 按 span_depth/parent_span_id 过滤
  spans: AgentSpanWithMeta[],  // 每个 span 附带 children_count
  span_total: number           // 当前层级的 span 总数
}
```

**按 task_id 查询时**：返回 TraceTree 结构。

### 6.3 注册位置

在 `unified-agent.ts` 中注册为内部工具，Front 和 Worker 都可用。工具内部直接调 TraceStore，不走 RPC。

### 6.4 使用场景

**日常对话**：
```
用户: "上次那个翻译任务做得怎么样？"
→ search_traces({ keyword: "翻译" })
→ 返回匹配的 trace 摘要
→ Agent 回答
```

**深入分析（大 trace 场景）**：
```
→ search_traces({ task_id: "task-123" }) → 看到 Worker trace span_count: 87
→ search_traces({ task_id: "task-123", include_spans: true, span_depth: 1 })
→ 顶层 span 列表，每个有 children_count
→ 对感兴趣的分支: search_traces({ ..., parent_span_id: "span-xxx" })
→ 或派 sub-agent 并行钻取不同分支
```

**反思任务**：
```
→ search_traces({ time_range: { start: watermark, end: now } })
→ 结合短期记忆的 refs.task_id 交叉分析
→ 提炼长期记忆
```

## 7. JSONL 清理策略

### 7.1 配置

```
TRACE_RETENTION_DAYS=30   // 默认 30 天，通过环境变量或 Agent 配置调整
```

### 7.2 清理时机

- Agent 启动时
- 运行中每天一次定时清理

### 7.3 清理逻辑

```
扫描 {DATA_DIR}/agent/traces/ 目录
  → 文件名 traces-YYYY-MM-DD.jsonl
  → 解析日期，与当前日期比较
  → 超过 TRACE_RETENTION_DAYS 的文件删除
  → 同步清理内存中对应的 traceIndex 和 taskIndex 条目
```

### 7.4 启动索引重建

```
1. 扫描 traces/ 目录，过滤掉过期文件
2. 逐文件逐行读取 JSONL
3. 每行 JSON.parse 提取元数据（trace_id, related_task_id, trigger, status, outcome, spans.length）
4. 丢弃 spans 内容，只保留索引
5. 写入 traceIndex + taskIndex
```

性能预估：30 天 × 200 条/天 = 6000 条索引，内存约 3MB，解析毫秒级。

## 8. 短期记忆 refs 写入

### 8.1 改动

Agent 写短期记忆（`write_short_term` RPC）时，将执行上下文写入 `refs`：

```typescript
refs: {
  task_id: "task-123",         // Worker 执行任务时
  trace_id: "trace-abc-..."    // 当前 trace 的 ID
}
```

### 8.2 写入时机

- Worker：`task_id` 在 `executeTask` 入口已知，直接传入
- Front：create_task 决策产生 task_id 后传入；direct_reply 场景只写 `trace_id`

### 8.3 反思数据流

```
反思任务启动
  → get_reflection_watermark() → 上次反思时间
  → search_short_term({ time_range: { start: watermark, end: now } })
  → 拿到短期记忆列表，每条有 refs.task_id
  → 对感兴趣的条目: search_traces({ task_id: refs.task_id })
  → 拿到完整 trace 树，深入分析执行过程
  → batch_write_long_term() 提炼经验
  → update_reflection_watermark()
```

不改协议结构（`refs` 字段已存在），只是让 Agent 在写入时填充。
