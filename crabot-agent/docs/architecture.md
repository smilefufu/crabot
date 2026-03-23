# UnifiedAgent 内部架构

本文档描述 `crabot-agent` 模块的内部实现架构。这些细节对其他模块不可见，协议文档只暴露外部接口。

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        UnifiedAgent                              │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                     编排层 (Orchestration)                  │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │ │
│  │  │ Session     │  │ SwitchMap   │  │ Permission          │ │ │
│  │  │ Manager     │  │ Handler     │  │ Checker             │ │ │
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘ │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │ │
│  │  │ Worker      │  │ Context     │  │ Decision            │ │ │
│  │  │ Selector    │  │ Assembler   │  │ Dispatcher          │ │ │
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                     智能体层 (Agent)                        │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │ │
│  │  │ LLM         │  │ Tool        │  │ Agent               │ │ │
│  │  │ Client      │  │ Registry    │  │ Loop                │ │ │
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘ │ │
│  │  ┌─────────────────────┐  ┌─────────────────────────────┐  │ │
│  │  │ Front Handler       │  │ Worker Handler              │  │ │
│  │  │ (快速分诊, 2-3轮)   │  │ (任务执行, 无限轮)          │  │ │
│  │  └─────────────────────┘  └─────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 编排层 (Orchestration Layer)

编排层负责消息路由、权限检查、上下文组装和决策分发。这是智能体的"神经系统"。

### 2.1 SessionManager

**职责**：管理会话状态和生命周期

```typescript
class SessionManager {
  // 会话状态存储
  private sessions: Map<SessionId, SessionState>

  // 核心方法
  updateLastMessageTime(sessionId: SessionId): void
  getActiveSessionCount(): number
  getPendingSessionCount(): number
  startCleanup(): void    // 启动定期清理
  stopCleanup(): void     // 停止清理
}
```

**配置项**：
- `session_state_ttl`: 会话状态 TTL（秒），默认 300

### 2.2 SwitchMapHandler

**职责**：实现 RxJS switchMap 语义，取消过时请求

```typescript
class SwitchMapHandler {
  // 核心逻辑
  async handleNewMessage(sessionId: SessionId, requestId: string): Promise<void>
  completeRequest(sessionId: SessionId, requestId: string): void
}
```

**工作原理**：
1. 同一会话的新消息到达时，取消正在处理的旧请求
2. 确保每个会话只处理最新消息
3. 通过 `cancel_task` RPC 调用取消 Worker 任务

### 2.3 PermissionChecker

**职责**：权限决策树，决定是否响应消息

```typescript
class PermissionChecker {
  async checkPermission(params: {
    channel_id: string
    session_id: string
    sender_id: string
    message: string
    is_group: boolean
    is_at_bot: boolean
  }): Promise<PermissionResult>
}
```

**决策树**：
```
1. 私聊 (is_group = false)
   → 检查 Friend 表
   → 如果存在: allowed
   → 如果不存在: pending (待授权)

2. 群聊 (is_group = true)
   → 检查是否 @ 机器人
   → 如果 @: 检查 Friend 表
   → 如果未 @: ignored

3. 未知发信人
   → ignored
```

### 2.4 WorkerSelector

**职责**：Worker 负载均衡

```typescript
class WorkerSelector {
  async selectWorker(params: {
    task_type: TaskType
    preferred_specialization?: string
  }): Promise<WorkerRoutingInfo | null>
}
```

**选择策略**：
1. 优先选择指定专长的 Worker
2. 轮询 (Round-Robin) 选择有容量的 Worker
3. 如果没有可用 Worker，返回 null（Front Agent 自己处理）

### 2.5 ContextAssembler

**职责**：并行组装上下文数据

```typescript
class ContextAssembler {
  async assembleFrontContext(
    request: ContextRequest,
    friend: Friend
  ): Promise<FrontAgentContext>

  async assembleWorkerContext(
    task: Task,
    recentMessages: ChannelMessage[]
  ): Promise<WorkerAgentContext>
}
```

**数据获取**（并行）：
- Admin: Friend 信息、Task 信息
- Memory: 短期记忆、长期记忆
- Channel: 最近消息

### 2.6 DecisionDispatcher

**职责**：分发 Agent 决策

```typescript
class DecisionDispatcher {
  async dispatch(
    decision: MessageDecision,
    context: DispatchContext
  ): Promise<void>
}
```

**决策类型**：
1. `direct_reply`: 直接回复消息
2. `create_task`: 创建新任务
3. `forward_to_worker`: 转发给 Worker 执行

---

## 3. 智能体层 (Agent Layer)

智能体层负责 LLM 调用、工具执行和任务处理。这是智能体的"大脑"。

### 3.1 LlmClient

**职责**：封装 LLM API 调用

```typescript
class LlmClient {
  constructor(config: LLMConnectionInfo)

  async chat(params: {
    system: string
    messages: MessageParam[]
    tools?: Tool[]
    maxTokens?: number
  }): Promise<Message>
}
```

**支持的 API 格式**：
- Anthropic (主要)
- OpenAI (未来支持)
- Gemini (未来支持)

### 3.2 ToolRegistry

**职责**：工具注册与执行管理

```typescript
class ToolRegistry {
  registerTool(declaration: ToolDeclaration, handler: ToolHandler): void
  getToolDeclarations(): ToolDeclaration[]
  toAnthropicTools(): AnthropicTool[]
  async executeTool(name: string, input: unknown): Promise<unknown>
  get count(): number
}
```

**工具来源**：
- Builtin: 内置工具（通过代码注册）
- MCP: Model Context Protocol 工具（通过 MCP 服务器）

### 3.3 AgentLoop

**职责**：Agent 循环引擎（纯函数式）

```typescript
async function runAgentLoop(
  llm: LlmClient,
  options: AgentLoopOptions
): Promise<AgentLoopResult>
```

**循环逻辑**：
```
while (iteration < maxIterations) {
  1. 调用 LLM
  2. 如果 end_turn → 返回结果
  3. 如果 tool_use → 执行工具，添加结果，继续
  4. 如果其他 → 返回结果
}
```

### 3.4 Front Handler

**职责**：快速分诊，处理简单消息

**特点**：
- 最多 2-3 轮迭代
- 快速响应（超时 30 秒）
- 决策类型：直接回复 / 创建任务 / 转发 Worker

**系统提示词**：
```markdown
你是 Crabot 的 Front Agent，负责快速分诊用户消息。

你的任务：
1. 理解用户意图
2. 做出决策：
   - direct_reply: 简单问题直接回复
   - create_task: 复杂任务创建 Task
   - forward_to_worker: 需要 Worker 深度处理的任务

决策时考虑：
- 任务复杂度
- 是否需要多轮交互
- 是否需要访问外部工具
```

### 3.5 Worker Handler

**职责**：深度任务执行

**特点**：
- 无限迭代（受 max_iterations 配置限制）
- 完整工具访问
- 支持人类反馈循环

**系统提示词**：
```markdown
你是 Crabot 的 Worker Agent，负责执行复杂任务。

你的任务：
1. 深度分析任务需求
2. 使用工具完成任务
3. 如果需要人类反馈，调用 ask_human 工具
4. 完成后输出最终结果

可用工具：
- read_file: 读取文件
- write_file: 写入文件
- execute_command: 执行命令
- ask_human: 请求人类反馈
- ...
```

---

## 4. 运行模式

### 4.1 纯编排模式

只部署编排层，不配置智能体：

```yaml
orchestration:
  admin_config_path: "/path/to/admin.yaml"
  session_state_ttl: 300
  # ...

# 不配置 agent 块
```

此时模块只做消息路由，实际智能体调用外部 Agent 模块。

### 4.2 Front 模式

只配置 Front Agent：

```yaml
agent_config:
  roles: [front]
  system_prompt: "..."
  model_config:
    main:
      endpoint: "https://api.anthropic.com"
      model_id: "claude-sonnet-4"
```

此时模块可以处理简单消息，复杂任务转发给外部 Worker。

### 4.3 Worker 模式

只配置 Worker Agent：

```yaml
agent_config:
  roles: [worker]
  specialization: "code-expert"
  supported_task_types: ["code_generation", "code_review"]
  system_prompt: "..."
  model_config:
    main:
      endpoint: "https://api.anthropic.com"
      model_id: "claude-sonnet-4"
```

此时模块只接收来自其他 Front Agent 的任务。

### 4.4 混合模式

同时配置 Front + Worker：

```yaml
agent_config:
  roles: [front, worker]
  # ...
```

此时模块是完整的智能体系统，可以独立运行。

---

## 5. 消息处理流程

### 5.1 完整流程图

```
Channel.message_received 事件
          │
          ▼
┌─────────────────────────┐
│  PermissionChecker      │ ← 检查权限
└─────────────────────────┘
          │ allowed
          ▼
┌─────────────────────────┐
│  SessionManager         │ ← 更新会话时间
└─────────────────────────┘
          │
          ▼
┌─────────────────────────┐
│  SwitchMapHandler       │ ← 取消旧请求
└─────────────────────────┘
          │
          ▼
┌─────────────────────────┐
│  ContextAssembler       │ ← 并行获取上下文
│  - Admin: Friend, Task  │
│  - Memory: 记忆         │
│  - Channel: 最近消息    │
└─────────────────────────┘
          │
          ▼
┌─────────────────────────┐
│  Front Handler          │ ← 内部调用（无 RPC）
│  - LLM 调用             │
│  - 工具执行             │
│  - 决策解析             │
└─────────────────────────┘
          │
          ▼
┌─────────────────────────┐
│  DecisionDispatcher     │ ← 分发决策
└─────────────────────────┘
          │
    ┌─────┼─────┐
    │     │     │
    ▼     ▼     ▼
 direct  create forward
 reply   task  to_worker
```

### 5.2 直接回复流程

```
DecisionDispatcher.dispatch({ type: 'direct_reply', reply: ... })
          │
          ▼
    Channel.send_message({ channel_id, session_id, content: reply })
```

### 5.3 创建任务流程

```
DecisionDispatcher.dispatch({ type: 'create_task', task_type, title, description })
          │
          ▼
    Admin.create_task({ friend_id, task_type, title, description })
          │
          ▼
    WorkerSelector.selectWorker({ task_type })
          │
          ▼
    Worker.execute_task({ task, context })
          │
          ▼
    Admin.update_task_status({ task_id, status: 'completed', final_reply })
          │
          ▼
    Channel.send_message({ ... })
```

### 5.4 转发 Worker 流程

```
DecisionDispatcher.dispatch({ type: 'forward_to_worker', task_type, reason, preferred_worker })
          │
          ▼
    Admin.create_task({ ... })
          │
          ▼
    WorkerSelector.selectWorker({ task_type, preferred_specialization })
          │
          ▼
    Worker.execute_task({ task, context })
```

---

## 6. 配置详解

### 6.1 完整配置示例

```yaml
# crabot-module.yaml
module_id: crabot-agent
module_type: agent
version: "0.2.0"
protocol_version: "0.2.0"
port: 3001

# 编排层配置
orchestration:
  # Admin 配置文件路径
  admin_config_path: "/path/to/admin.yaml"

  # 会话状态 TTL（秒）
  session_state_ttl: 300

  # Front Agent 上下文限制
  front_context_recent_messages_limit: 20
  front_context_memory_limit: 10

  # Worker Agent 上下文限制
  worker_recent_messages_limit: 50
  worker_short_term_memory_limit: 20
  worker_long_term_memory_limit: 30

  # 超时配置
  front_agent_timeout: 30

  # Worker 配置刷新间隔
  worker_config_refresh_interval: 60

  # 队列配置
  front_agent_queue_max_length: 100
  front_agent_queue_timeout: 60

# 智能体层配置（可选）
agent_config:
  # 实例 ID
  instance_id: "main-agent"

  # 角色：front, worker, 或两者
  roles: [front, worker]

  # 系统提示词
  system_prompt: |
    你是 Crabot，一个 AI 员工助手...

  # 模型配置
  model_config:
    main:
      endpoint: "https://api.anthropic.com"
      apikey: "${ANTHROPIC_API_KEY}"
      model_id: "claude-sonnet-4"
      format: "anthropic"
      max_tokens: 4096

  # 最大迭代次数
  max_iterations: 10

  # 专长（Worker 角色）
  specialization: "general"

  # 支持的任务类型（Worker 角色）
  supported_task_types:
    - "general_qa"
    - "code_generation"
    - "data_analysis"

  # MCP 服务器配置
  mcp_servers:
    - name: "filesystem"
      command: "mcp-filesystem"
      args: ["--root", "/workspace"]

  # Skills 配置
  skills:
    - name: "code_review"
      enabled: true
```

---

## 7. 错误处理

### 7.1 编排层错误

| 场景 | 处理方式 |
|------|----------|
| 权限检查失败 | 记录日志，忽略消息 |
| Admin RPC 失败 | 重试 3 次，然后记录错误 |
| Memory RPC 失败 | 使用空上下文继续 |
| Channel RPC 失败 | 重试 3 次，记录错误 |

### 7.2 智能体层错误

| 场景 | 处理方式 |
|------|----------|
| LLM API 错误 | 返回错误回复 |
| 工具执行错误 | 将错误信息反馈给 Agent |
| 超过最大迭代 | 返回当前结果 |
| 超时 | 返回超时回复 |

---

## 8. 监控和日志

### 8.1 关键指标

- `processing_messages`: 正在处理的消息数
- `active_sessions`: 活跃会话数
- `current_task_count`: 当前任务数
- `available_capacity`: 可用容量
- `llm_status`: LLM 状态
- `tools_count`: 工具数量

### 8.2 日志级别

- `debug`: 详细流程日志
- `info`: 关键事件（消息接收、决策、任务完成）
- `warn`: 警告（权限待授权、Worker 不可用）
- `error`: 错误（RPC 失败、LLM 错误）
