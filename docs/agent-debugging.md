# Agent 模块调试指南

本文档总结了调试 Crabot Agent 模块的经验和工具。适用于所有 Agent 模块实现（Unified Agent 及未来扩展的其他 Agent）。

## 快速上手

```bash
# 检查所有模块是否正常运行
./scripts/debug-agent.sh health

# 查看最近发生了什么
./scripts/debug-agent.sh traces

# 查看最新一次 trace 的完整过程
./scripts/debug-agent.sh trace

# 实时监控
./scripts/debug-agent.sh watch
```

---

## 调试脚本命令参考

脚本位置：`scripts/debug-agent.sh`

| 命令 | 参数 | 说明 |
|------|------|------|
| `traces` | `[limit] [status]` | 列出最近的 Trace，默认 10 条 |
| `trace` | `[trace_id]` | 显示单个 Trace 的 Span 树，默认最新一条 |
| `tasks` | `[status]` | 列出 Admin 任务状态 |
| `health` | - | 检查 MM/Admin/Agent 健康状态 |
| `logs` | `[lines]` | 查看 SDK Runner 调试日志 |
| `modules` | - | 列出 MM 注册的模块 |
| `watch` | - | 实时监控（3 秒刷新） |

### 覆盖端口

如果 Agent 不在默认端口，用环境变量覆盖：

```bash
CRABOT_AGENT_PORT=19006 ./scripts/debug-agent.sh traces
```

---

## Trace 系统说明

每次 Agent 处理消息/任务，都会生成一个 `AgentTrace`，内含多个 `AgentSpan`。

### Trace 生命周期

```
message_received → startTrace(trigger=message)
  └── context_assembly span
  └── agent_loop span
      └── llm_call span (iteration=1)
      └── tool_call span (tool_name=xxx)
      └── llm_call span (iteration=2)
  └── decision span (decision_type=create_task)
  └── rpc_call span (target=admin, method=create_task)
→ endTrace(status=completed)
```

### Span 类型

| 类型 | 说明 | 关键字段 |
|------|------|---------|
| `context_assembly` | 组装上下文（记忆、历史消息） | context_type, session_id |
| `agent_loop` | SDK Agent 完整执行轮次 | model, tools, iteration_count |
| `llm_call` | 单次 LLM API 调用 | iteration, input_summary, stop_reason |
| `tool_call` | 单次工具调用 | tool_name, input/output summary |
| `decision` | Front Agent 路由决策 | decision_type, summary |
| `rpc_call` | 跨模块 RPC 调用 | target_module, method, status_code |
| `memory_write` | 写入短期记忆 | friend_id, channel_id |

---

## 常见问题排查

### 问题 1：消息没有反应

**排查步骤：**

```bash
# 1. 确认模块都在运行
./scripts/debug-agent.sh health

# 2. 查看是否有 trace 产生
./scripts/debug-agent.sh traces 5

# 如果没有 trace → 消息没到达 Agent（检查 channel-host）
# 如果有 failed trace → 看详情
./scripts/debug-agent.sh trace
```

**没有 Trace 产生**的可能原因：
- Agent 收到消息但 Permission 检查拒绝了（不会产生 trace）
- channel-host 没有正确路由到 Agent（检查 channel-host 日志）
- `is_mention_crab` 为 false 且是群聊 → 走了 Debounce，还没触发

### 问题 2：任务创建了但没有回复

```bash
# 查看任务状态
./scripts/debug-agent.sh tasks

# 查看 trace 中的 rpc_call span
./scripts/debug-agent.sh trace <trace_id>
```

**常见根因：**
- 任务状态卡在 `pending` → Worker 没有收到任务或状态机转换失败
- 任务 `completed` 但没有回复 → `sendReplyToUser` 失败（channel-host `pendingDispatches` 过期）
- `rpc_call` span 失败 → 目标模块不可达

### 问题 3：LLM 没有调用工具

```bash
# 查看 llm_call span 的 stop_reason
./scripts/debug-agent.sh trace
```

- `stop_reason=end_turn` 且没有工具调用 → 模型返回了纯文本，没有触发工具
- `stop_reason=tool_use` → 工具被调用了，继续看 `tool_call` span
- 没有 `llm_call` span → SDK 在 `agent_loop` 之前就失败了

**检查 SDK 日志：**

```bash
./scripts/debug-agent.sh logs 100
# 搜索 "error" 或 "failed" 的行
```

### 问题 4：模型响应为空（thinking 模型）

thinking 模型（StepFun、QwQ 等）可能将所有 token 预算用于推理，导致 `content` 为空。

`front-handler.ts` 有 3 次重试机制，看 `llm_call` span 中 `attempt` 字段：
- `attempt=2` 出现说明发生了重试
- 如果全部失败，Trace 状态为 `failed`，`outcome.error` 有说明

---

## 调试 RPC 调用

### 手动调用 Agent RPC

```bash
# 获取最近 5 条 trace（直接 curl）
curl -s -X POST http://localhost:19005/get_traces \
  -H "Content-Type: application/json" \
  -d '{"id":"1","source":"debug","method":"get_traces","params":{"limit":5},"timestamp":"2026-01-01T00:00:00Z"}' | jq .

# 获取 Agent 状态
curl -s -X POST http://localhost:19005/get_status \
  -H "Content-Type: application/json" \
  -d '{"id":"1","source":"debug","method":"get_status","params":{},"timestamp":"2026-01-01T00:00:00Z"}' | jq .

# 获取 Agent 当前配置
curl -s -X POST http://localhost:19005/get_config \
  -H "Content-Type: application/json" \
  -d '{"id":"1","source":"debug","method":"get_config","params":{},"timestamp":"2026-01-01T00:00:00Z"}' | jq .
```

### 手动调用 Admin RPC

```bash
# 查询任务列表
curl -s -X POST http://localhost:19001/get_tasks \
  -H "Content-Type: application/json" \
  -d '{"id":"1","source":"debug","method":"get_tasks","params":{"limit":10},"timestamp":"2026-01-01T00:00:00Z"}' | jq .
```

---

## Trace 的局限性

当前 Trace 系统仅覆盖 Agent 内部逻辑，**不包含跨模块 RPC 调用**（如 Admin、channel-host）的耗时和结果。

`rpc_call` Span 已在 `RpcClient` 中实现自动记录（见 `crabot-agent/src/core/module-base.ts`），能捕获：
- 目标模块和方法
- 请求/响应摘要
- 调用耗时
- 错误信息

如果 Trace 系统在 Agent 看来正常，但用户没有收到消息，需要在 channel-host 侧查看日志（`pendingDispatches` 生命周期、`deliver` 是否被调用）。

---

## 推荐调试流程

```
用户反馈问题
  ↓
./scripts/debug-agent.sh health    ← 确认模块都活着
  ↓
./scripts/debug-agent.sh traces    ← 确认是否有 trace 产生
  ↓
./scripts/debug-agent.sh trace     ← 看具体哪个 span 失败了
  ↓
./scripts/debug-agent.sh logs      ← 看 SDK 层面的详细日志
  ↓
./scripts/debug-agent.sh tasks     ← 如果是任务类问题，看任务状态
```

---

## 端口参考

| 模块 | 默认端口 | 说明 |
|------|---------|------|
| Module Manager | 19000 | 核心进程管理 |
| Admin (RPC) | 19001 | 模块间通信 |
| Admin (Web) | 3000 | REST API + 静态文件 |
| Agent | 19005 | 由 MM 分配 |
| LiteLLM | 4000 | LLM 代理 |
