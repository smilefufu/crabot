# crabot-agent 智能体层重构设计

Date: 2026-03-27
Status: Draft

---

## 1. 背景与动机

当前 crabot-agent 的智能体层（FrontHandler + WorkerHandler）基于 Claude Agent SDK 的 `query()` 实现。`query()` 本质上 spawn 一个 Claude Code CLI 子进程，导致以下问题：

1. **Front 响应慢**：每次调用冷启动 2-12 秒（CLI 子进程初始化），Front 本应 2-5 秒完成分诊
2. **Worker 工具集失控**：SDK 自动注入 28 个 CLI 默认工具（Task, EnterPlanMode, Skill 等），业务 MCP 工具被淹没，Worker 优先用 Bash/Edit 改代码而非调用正确的 MCP 工具
3. **Worker 工作目录不隔离**：CLI 继承 `process.cwd()`（crabot-agent/），Worker 直接在项目源码里操作
4. **无中间进度报告**：CLI 子进程是黑箱，用户等几分钟才拿到最终结果（可能方向已偏）
5. **无法纠偏**：用户发现 Worker 方向不对时，无法中途注入补充指示

### 不改的部分

编排层完全保留不动：
- SessionManager, SwitchMapHandler, DebounceHandler
- PermissionChecker, WorkerSelector, ContextAssembler
- DecisionDispatcher, MemoryWriter
- TraceStore, unified-agent.ts 消息流程骨架

---

## 2. 架构概览

```
编排层（不变）
  SessionManager / SwitchMap / Debounce / ContextAssembler
  DecisionDispatcher / MemoryWriter / PermissionChecker
                    |
                    v
智能体层（重构）
  +----------------------------------------------------------+
  |  FrontHandler v2                                          |
  |  - 直接调 Anthropic Messages API（经 LiteLLM）             |
  |  - 自研 mini loop（<=5 轮）                                |
  |  - tool_use 结构化决策（make_decision 工具）               |
  |  - 工具集：crab-messaging + query_tasks + make_decision    |
  |  - 零冷启动，预期 1-5 秒响应                               |
  +----------------------------------------------------------+
                    | create_task / supplement_task 决策
                    v
  +----------------------------------------------------------+
  |  WorkerHandler v2                                         |
  |  - 保留 Claude Agent SDK                                  |
  |  - cwd 隔离：/tmp/crabot-task-{task_id}/                  |
  |  - 工具白名单：开发工具 + MCP 工具                         |
  |  - 进度流：监听事件 -> 摘要 -> send_message 推送           |
  |  - 纠偏注入：每轮检查 pendingHumanMessages                |
  |  - 任务完成后清理 cwd                                      |
  +----------------------------------------------------------+
```

---

## 3. Front Handler v2 详细设计

### 3.1 调用方式：直接 API

弃用 Claude Agent SDK 的 `query()`，改为使用 `@anthropic-ai/sdk`（官方 TypeScript SDK）直接调用 LiteLLM 的 Anthropic 兼容端点：

```typescript
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({
  baseURL: litellmBaseUrl,  // LiteLLM 代理地址（不含 /v1，SDK 自动追加）
  apiKey: litellmApiKey,
})

const response = await client.messages.create({
  model: modelId,
  system: systemPrompt,
  messages,
  tools,
  max_tokens: 16384,  // 给足空间，避免上下文不够用
})
```

> **关于 max_tokens**：Anthropic API 的 `max_tokens` 是 required 字段，不传会报错。该值为输出 token 上限，设大不会增加成本（按实际使用计费）。建议 16384 以上，确保 Front 在复杂上下文下有足够的输出空间。

对比：

| 项目 | 当前（Claude Agent SDK） | v2（@anthropic-ai/sdk） |
|------|------------------------|------------------------|
| 冷启动 | 2-12s（CLI 子进程） | 0s（HTTP 请求） |
| 工具集 | 28 个（不可控） | ~10 个（完全可控） |
| 输出解析 | 正则提取 JSON + jsonrepair | API response 直接解析 tool_use |
| 每轮开销 | CLI 内部多层调度 | 一次 HTTP 请求 |
| 依赖 | Claude Code CLI 安装 | npm 包，无外部依赖 |

### 3.2 Mini Agent Loop

```typescript
const FRONT_MAX_ROUNDS = 5

async function runFrontLoop(
  systemPrompt: string,
  userMessage: string,
  tools: Tool[],
  config: { model: string; endpoint: string; apikey: string },
): Promise<FrontLoopResult> {
  const messages: Message[] = [{ role: 'user', content: userMessage }]
  const toolHistory: ToolHistoryEntry[] = []  // 记录成功的工具调用

  for (let round = 0; round < FRONT_MAX_ROUNDS; round++) {
    const response = await callMessagesAPI(config, systemPrompt, messages, tools)

    // Case 1: 纯文本结束 -> 包装为 direct_reply
    if (response.stop_reason === 'end_turn') {
      const text = extractText(response.content)
      return { decision: { type: 'direct_reply', reply: { type: 'text', text } } }
    }

    // Case 2: 工具调用
    if (response.stop_reason === 'tool_use') {
      // 追加 assistant 消息
      messages.push({ role: 'assistant', content: response.content })

      const toolResults: ToolResultBlock[] = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue

        // make_decision 工具 -> 结构化决策，直接返回
        if (block.name === 'make_decision') {
          return { decision: parseDecision(block.input) }
        }

        // 其他工具 -> 执行并收集结果
        const result = await executeTool(block.name, block.input)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.output,
          is_error: result.isError,
        })

        // 记录成功的工具调用（供强制终止时传递给 Worker）
        if (!result.isError) {
          toolHistory.push({
            tool_name: block.name,
            input_summary: summarize(block.input),
            output_summary: summarize(result.output),
          })
        }
      }

      // 追加 tool_result 消息
      messages.push({ role: 'user', content: toolResults })
    }
  }

  // 超出 5 轮 -> 强制创建任务，携带成功的工具调用上下文
  return {
    decision: {
      type: 'create_task',
      task_title: extractTaskTitle(messages),
      task_description: extractTaskDescription(messages),
      task_type: 'general',
      immediate_reply: { type: 'text', text: '问题比较复杂，我安排深度处理，请稍等...' },
      front_context: toolHistory,  // 仅强制终止时携带
    },
  }
}
```

### 3.3 决策类型

在现有 `direct_reply / create_task / silent` 基础上，新增 `supplement_task`：

```typescript
type FrontDecision =
  | DirectReplyDecision
  | CreateTaskDecision
  | SupplementTaskDecision
  | SilentDecision

interface SupplementTaskDecision {
  type: 'supplement_task'
  task_id: TaskId              // Front 判断的目标任务
  supplement_content: string   // 提炼后的补充内容
  confidence: 'high' | 'low'  // Front 的信心程度
  immediate_reply: MessageContent
}
```

`confidence` 的处理逻辑（在 DecisionDispatcher 中）：
- `high`：直接调用 `deliver_human_response` 注入 Worker
- `low`：回复用户确认（"您是想调整「编写调研报告」还是「制作 PPT」？"），等待用户明确后再注入

### 3.4 make_decision 工具定义

```typescript
{
  name: 'make_decision',
  description: '做出最终决策。分析完消息后必须调用此工具输出决策。',
  input_schema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['direct_reply', 'create_task', 'supplement_task', 'silent'],
        description: 'direct_reply=直接回复, create_task=创建新任务, supplement_task=补充/纠偏已有任务, silent=静默',
      },
      // direct_reply 字段
      reply_text: {
        type: 'string',
        description: '回复文本（type=direct_reply 时必填）',
      },
      // create_task 字段
      task_title: { type: 'string' },
      task_description: { type: 'string' },
      task_type: {
        type: 'string',
        enum: ['general', 'code', 'analysis', 'command'],
        description: '默认 general',
      },
      // supplement_task 字段
      task_id: {
        type: 'string',
        description: '目标任务 ID（type=supplement_task 时必填）',
      },
      supplement_content: {
        type: 'string',
        description: '提炼后的补充/纠偏内容',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'low'],
        description: 'high=确定是纠偏直接注入, low=不确定需用户确认',
      },
      // 即时回复（create_task 和 supplement_task 时可选）
      immediate_reply_text: { type: 'string' },
    },
    required: ['type'],
  },
}
```

### 3.5 Front 工具集

| 工具 | 来源 | 用途 |
|------|------|------|
| `make_decision` | 内置 | 输出结构化决策 |
| `lookup_friend` | crab-messaging | 查找熟人 |
| `list_friends` | crab-messaging | 列出好友 |
| `list_sessions` | crab-messaging | 查看会话列表 |
| `get_history` | crab-messaging | 查看聊天记录 |
| `send_message` | crab-messaging | 发送消息 |
| `open_private_session` | crab-messaging | 打开私聊 |
| `query_tasks` | 内置 | 查询活跃任务状态 |
| `create_schedule` | 内置 | 创建定时提醒/周期任务 |

注意：Front 没有 Bash/Read/Write/Edit/Skill。Front 不使用 Claude Agent SDK，不支持 Skills 机制。简单命令执行和需要 Skills 的任务由 Front 创建 task 交给 Worker。

### 3.6 Front 上下文增强（纠偏辅助）

ContextAssembler 组装 Front 上下文时，活跃任务信息需要更丰富：

```
## 活跃任务（来自同一 channel 优先）
- [task_001] "用 Go 编写 API 服务器" (status: executing, 已执行 5 分钟)
  来源 session: {session_id}
  最近进度: "正在编写路由层..."
- [task_002] "制作 Q1 数据分析 PPT" (status: executing, 已执行 2 分钟)
  来源 session: {session_id}
  最近进度: "正在收集数据..."
```

纠偏判断的缩小范围规则：
1. 优先匹配同 session 发起的任务
2. 其次匹配同 channel 的任务
3. 跨 channel 任务只在用户明确提及时匹配

Front 的 system prompt 需要明确指导纠偏场景的判断逻辑和 confidence 赋值规则（见 Section 7）。

### 3.7 强制终止时的上下文传递

当 Front loop 达到 5 轮上限被强制终止时，`create_task` 决策携带 `front_context` 字段：

```typescript
interface CreateTaskDecision {
  type: 'create_task'
  task_title: string
  task_description: string
  task_type: string
  immediate_reply: MessageContent
  /** 仅强制终止时携带：Front 已完成的成功工具调用记录 */
  front_context?: ToolHistoryEntry[]
}

interface ToolHistoryEntry {
  tool_name: string
  input_summary: string   // 输入摘要（前 200 字符）
  output_summary: string  // 输出摘要（前 500 字符）
}
```

Worker 的 `buildTaskMessage` 检测到 `front_context` 时追加：

```
## Front Agent 已完成的工作
（以下是 Front 在分诊阶段已获取的信息，请直接使用，不要重复查询）
- lookup_friend("张三") -> friend_id: xxx, wechat channel identity: yyy
- list_sessions(wechat) -> 找到群"技术讨论组" session_id: zzz
```

正常 create_task 决策（Front 主动判断为复杂任务）不携带 `front_context`，因为 Front 已将必要信息提炼进 `task_title` 和 `task_description`。

---

## 4. Worker Handler v2 详细设计

### 4.1 保留 Claude Agent SDK，改造关键点

Worker 需要完整的 Agent Loop + 丰富工具集（Bash/Read/Write/Edit），Claude Agent SDK 适合此场景。改造集中在 4 个方面。

### 4.2 cwd 隔离

每个任务启动前创建独立工作目录：

```typescript
async executeTask(params: ExecuteTaskParams): Promise<ExecuteTaskResult> {
  const taskDir = `/tmp/crabot-task-${params.task.task_id}`
  await fs.mkdir(taskDir, { recursive: true })

  try {
    const sdkOpts: SdkRunOptions = {
      // ...
      cwd: taskDir,  // SDK 的 query() 需要支持 cwd 参数
    }
    // ...
  } finally {
    // 清理策略：立即清理，或延迟清理供调试
    await this.cleanupTaskDir(taskDir)
  }
}
```

如果 SDK 的 `query()` 不支持 `cwd` 参数，备选方案：
- 在 `sdkOpts.env` 中设置 `HOME={taskDir}`
- 或在 system prompt 中强制指定 `cd {taskDir}` 作为第一条指令
- 或 spawn SDK 前用 `process.chdir()` 临时切换（需注意并发安全，可能需要 worker_thread）

**sandbox_path_mappings 的作用**：声明 Worker 除 cwd 外可访问的目录。例如场景 1 中 master 指定了项目路径 `/home/dev/myproject`，该路径作为 mapping 传给 Worker，Worker 可以 `cd /home/dev/myproject` 操作代码。cwd（`/tmp/crabot-task-xxx/`）用于 Worker 自己的临时文件。

**清理策略**：

```typescript
private async cleanupTaskDir(taskDir: string): Promise<void> {
  // 可配置：保留最近 N 个任务目录供调试
  const maxRetained = this.config.retainedTaskDirs ?? 5
  const tmpDirs = await glob('/tmp/crabot-task-*/')
  if (tmpDirs.length > maxRetained) {
    // 按 mtime 排序，删除最旧的
    const sorted = tmpDirs.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    for (const dir of sorted.slice(0, tmpDirs.length - maxRetained)) {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
}
```

### 4.3 工具白名单

通过 SDK 的 `allowedTools` 参数限制工具集：

```typescript
const WORKER_ALLOWED_TOOLS = [
  // 开发工具
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  // Skills（SDK 原生机制，从任务目录的 .claude/skills/ 加载）
  'Skill',
  // MCP 工具（crab-messaging）
  'mcp__crab-messaging__lookup_friend',
  'mcp__crab-messaging__list_friends',
  'mcp__crab-messaging__list_sessions',
  'mcp__crab-messaging__open_private_session',
  'mcp__crab-messaging__send_message',
  'mcp__crab-messaging__get_history',
  // Worker 专属
  'mcp__crabot-worker__ask_human',
  // 外部 MCP 工具（按配置动态添加）
  ...externalMcpToolNames,
]
```

### 4.3.1 Skills 机制：Admin 管理 + SDK 原生加载

crabot 的 Skills 由 Admin 统一管理（单一来源），Worker 启动前将 Skills 写入任务目录，由 SDK 原生 Skill 机制发现和调用：

```typescript
async executeTask(params: ExecuteTaskParams): Promise<ExecuteTaskResult> {
  const taskDir = `/tmp/crabot-task-${params.task.task_id}`
  await fs.mkdir(taskDir, { recursive: true })

  // 将 Admin 管理的 Skills 写入任务目录的 .claude/skills/
  if (params.skills && params.skills.length > 0) {
    const skillsDir = path.join(taskDir, '.claude', 'skills')
    await fs.mkdir(skillsDir, { recursive: true })
    for (const skill of params.skills) {
      await fs.writeFile(
        path.join(skillsDir, `${skill.id}.md`),
        skill.content,
      )
    }
  }

  const sdkOpts = {
    cwd: taskDir,
    // 只加载 project（即 taskDir），不加载 user（~/.claude/）
    // 确保 Worker 只能使用 Admin 管理的 Skills，不会加载环境自带的
    settingSources: ['project'],
    allowedTools: WORKER_ALLOWED_TOOLS,
    // ...
  }
}
```

> **设计要点**：
> - Skills 来源唯一：Admin 管理，不加载环境自带的（`settingSources` 不含 `'user'`）
> - SDK 原生机制：Skill 工具正常工作，能解析引用、知道文件位置
> - 每个任务独立：不同任务可以有不同的 Skills 集合（Admin 按需分配）
>
> **当前过渡方案（Phase 1-3）**：Admin 目前存储 Skills 为单个 content 字段，暂时仍将 content 写为 `{taskDir}/.claude/skills/{id}/SKILL.md` 单文件。功能上可用，但不支持 Skill 引用同目录下的模板/脚本文件。
>
> **目标方案（Phase 4）**：Admin Skill 存储重构为完整目录结构后，Worker 改为整目录拷贝（`fs.cp(src, dst, { recursive: true })`），SDK 原生 Skill 机制完整生效。详见 Phase 4 说明。

排除的 CLI 默认工具：Task, TaskOutput, TaskStop, AskUserQuestion, EnterPlanMode, ExitPlanMode, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, RemoteTrigger, TodoWrite, NotebookEdit, WebFetch, WebSearch。

### 4.4 进度流推送

监听 SDK 的 `assistant` 事件，在关键节点向用户推送摘要：

```typescript
// 在 runSdk 的事件循环中
let roundsSinceLastReport = 0
let lastReportTime = Date.now()
const REPORT_INTERVAL_ROUNDS = 3
const REPORT_INTERVAL_MS = 30_000  // 30 秒

for await (const message of stream) {
  if (message.type === 'assistant') {
    roundsSinceLastReport++
    const elapsed = Date.now() - lastReportTime

    const shouldReport =
      roundsSinceLastReport >= REPORT_INTERVAL_ROUNDS ||
      elapsed >= REPORT_INTERVAL_MS ||
      isKeyMilestone(message)  // 首次工具调用、阶段切换等

    if (shouldReport && taskOrigin) {
      const summary = generateProgressSummary(message, roundsSinceLastReport)
      await sendProgressToUser(taskOrigin, summary)
      roundsSinceLastReport = 0
      lastReportTime = Date.now()
    }
  }
}
```

进度消息格式（通过 crab-messaging 的 send_message 发送）：

```
[任务进度] 用 Go 编写 API 服务器
正在编写路由层... (第 5 轮, 已执行 45 秒)
已完成: 项目初始化, go.mod 创建, 目录结构
当前: 编写 handler/user.go
```

**isKeyMilestone 判断**：
- 首次工具调用（从 thinking 阶段进入执行阶段）
- 文本输出中包含"完成"、"开始"、"接下来"等阶段切换词
- 工具调用类型切换（从 Read 切换到 Write，说明从分析进入实现）
- 超过 30 秒无进度报告

### 4.5 纠偏注入

用户新消息通过 `deliver_human_response` 投递到 Worker 的 `pendingHumanMessages` 队列。Worker 在每轮工具执行后检查队列：

```typescript
// 在 SDK 事件循环的工具执行后
if (taskState.pendingHumanMessages.length > 0) {
  const humanMessages = taskState.pendingHumanMessages.splice(0)
  const supplement = humanMessages
    .map(m => m.content.text ?? '')
    .filter(t => t.length > 0)
    .join('\n')

  if (supplement) {
    // 注入到 LLM context
    // 方案：通过 MCP ask_human 工具的响应通道注入
    // 或：利用 SDK 的 stdin 机制（如果支持）
    injectHumanMessage(supplement)
  }
}
```

注入方式取决于 SDK 能力。如果 SDK 不支持在循环中注入消息，备选方案：
- 将 supplement 写入共享文件，让 Worker 的 system prompt 指示每轮检查该文件
- 或通过 ask_human 工具的回调机制异步注入

**纠偏的完整流程**：

```
用户发消息 "不对，用 Python 重写"
  |
  v
Front Handler 收到消息
  |-- 上下文中有活跃任务 [task_001] "用 Go 编写 API"，来自同一 session
  |-- Front 调用 make_decision(supplement_task, task_id=task_001,
  |     supplement="用户要求改用 Python 而非 Go", confidence=high)
  v
DecisionDispatcher 处理 supplement_task
  |-- confidence=high -> 直接注入
  |-- 调用 deliver_human_response(task_001, "用户补充指示：改用 Python 而非 Go")
  |-- 回复用户："好的，已通知正在执行的任务切换到 Python。"
  v
Worker 下一轮工具执行后
  |-- 检查 pendingHumanMessages -> 有新消息
  |-- 注入 LLM context: "用户补充指示：改用 Python 而非 Go"
  |-- LLM 读到后自行调整方向
```

**confidence=low 的流程**：

```
用户发消息 "换个方案"（有 2 个活跃任务）
  |
  v
Front 调用 make_decision(supplement_task, task_id=task_001,
  supplement="换个方案", confidence=low)
  v
DecisionDispatcher 处理
  |-- confidence=low -> 回复用户确认
  |-- "您是想调整「用 Go 编写 API 服务器」还是「制作 Q1 数据分析 PPT」？"
  v
用户回复 "Go 那个"
  |
  v
Front 再次收到 -> 识别为对确认问题的回答
  -> make_decision(supplement_task, task_id=task_001,
     supplement="用户要求换个方案（编写 API 服务器）", confidence=high)
  -> 正常注入流程
```

---

## 5. 多任务并发

### 5.1 Front 是单例，Worker 按任务 spawn

- Front Handler：一个实例，处理所有 incoming 消息。直接 API 调用无状态，天然支持并发。
- Worker Handler：每个任务一个 SDK 进程。`activeTasks` Map 追踪所有活跃任务。

### 5.2 任务状态查询（场景 6）

Front 工具集包含 `query_tasks`，查询范围：

```typescript
// query_tasks 工具实现
async function queryTasks(args: { status?: string; channel_id?: string }) {
  // 本地活跃任务
  const localTasks = Array.from(activeTasks.entries()).map(([id, state]) => ({
    task_id: id,
    status: state.status,
    started_at: state.startedAt,
    // ...
  }))

  // Admin 任务列表（含已完成的）
  const adminTasks = await rpcClient.call(adminPort, 'query_tasks', {
    status: args.status ? [args.status] : ['executing', 'waiting_human', 'planning'],
    ...(args.channel_id ? { channel_id: args.channel_id } : {}),
  })

  return { local_active: localTasks, admin_tasks: adminTasks.tasks }
}
```

---

## 6. Debounce 策略（不变，此处记录供完整性）

群聊 Debounce 机制保持不变，核心行为：

1. 消息到达 -> `DebounceHandler.enqueue()` -> 进入缓冲队列
2. @提及消息 -> 重置窗口到 `group_debounce_min_ms`（5s），快速触发
3. 窗口到期 -> flush 整批给 Front Handler
4. Front 判断回复 -> `reportResult(replied=true)` -> 重置窗口到 min
5. Front 判断静默 -> `reportResult(replied=false)` -> 窗口 x5 退避，上限 max（300s）

退避序列：5s -> 25s -> 125s -> 300s -> 300s -> ...

**Front v2 对 Debounce 的影响**：Front 响应变快（1-5s vs 当前 17-55s），意味着 Debounce flush 后能更快得到结果，用户感知到的群聊响应速度大幅提升。

---

## 7. Prompt 设计要点

### 7.1 Front system prompt 关键段落

```markdown
你是 Crabot 的分诊员，负责快速分析消息并做出决策。

## 决策输出

你必须调用 make_decision 工具输出决策。四种类型：

1. direct_reply — 直接回复（简单问答、问候、任务状态查询）
2. create_task — 创建新任务（复杂操作、代码编写、数据分析）
3. supplement_task — 补充/纠偏已有任务（用户对正在执行的任务有新指示）
4. silent — 静默（群聊中与自己无关的消息）

## 纠偏判断指南

当用户消息可能是对活跃任务的纠偏时：
- 检查活跃任务列表，优先匹配同 session 发起的任务
- 如果只有一个匹配任务且语义明确 -> confidence: high
- 如果有多个匹配任务或语义模糊 -> confidence: low
- 如果没有活跃任务或消息明显是新请求 -> create_task

## 群聊规则

在群聊中，默认 silent。只有以下情况才回复：
1. 消息标注了 [@你]
2. 结合上下文，消息明显是向你提问
3. 你正在跟进一个活跃任务，用户在追问进展

不满足以上任何条件 -> silent。群聊中的闲聊、成员间讨论、与你无关的对话——全部 silent。
```

### 7.2 Worker system prompt 关键段落

```markdown
你是 Crabot Worker，负责执行复杂任务。

## 工作目录

你的默认工作目录是 /tmp/crabot-task-{task_id}/，用于存放任务产生的临时文件。
如果任务涉及特定项目，项目路径会在"文件访问路径"段落中列出。

## 通讯工具

完成任务后直接输出最终结果，结果会自动回复给用户。
执行过程中如需向用户发送进度更新，使用 send_message 工具。

## 重要：不要修改 Crabot 自身的代码

你的工作目录和项目目录是分开的。不要修改 /Users/.../crabot/ 下的任何文件，
除非任务明确要求你操作 Crabot 项目本身。
```

---

## 8. 定时提醒与条件触发

### 8.1 定时提醒 — "下午 3 点提醒我去机场"

利用 Admin 已有的 Schedule 系统。在 Front 工具集中新增 `create_schedule`：

```typescript
{
  name: 'create_schedule',
  description: '创建定时任务或提醒。支持一次性和周期性。',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '任务/提醒标题' },
      description: { type: 'string', description: '详细描述' },
      trigger_at: { type: 'string', description: '触发时间（ISO 8601），一次性提醒用此字段' },
      cron: { type: 'string', description: 'Cron 表达式，周期性任务用此字段' },
      action: {
        type: 'string',
        enum: ['send_reminder', 'create_task'],
        description: 'send_reminder=发送提醒消息, create_task=触发时创建 Worker 任务',
      },
      target_channel_id: { type: 'string', description: '提醒发送到的 channel' },
      target_session_id: { type: 'string', description: '提醒发送到的 session' },
    },
    required: ['title', 'action'],
  },
}
```

流程：

```
用户: "下午 3 点提醒我去机场接女朋友"
  -> Front 调用 create_schedule(title="去机场接女朋友",
       trigger_at="2026-03-27T15:00:00+08:00",
       action="send_reminder",
       target_channel_id=当前channel, target_session_id=当前session)
  -> Admin 创建 one-shot schedule
  -> 15:00 Admin 调度器触发
  -> Agent.create_task_from_schedule() 或 直接 send_message
  -> 用户收到提醒
```

### 8.2 条件触发 — "看到小张发言就提醒他写周报"

这是一个 watch rule：当某个条件满足时触发动作。

**Phase 1 方案（利用记忆）**：

```
用户: "看到小张在群里发言就提醒他写周报"
  -> Front 写入短期记忆: "监听规则: 当小张(friend_id:xxx)在群(session:yyy)发言时，提醒他写周报"
  -> direct_reply: "好的，我会留意的"

后续群消息到达 -> Debounce flush -> Front 处理
  -> 上下文中包含短期记忆（"监听规则: 当小张发言..."）
  -> Front 发现当前消息来自小张
  -> make_decision(direct_reply, "@小张 别忘了写周报哦")
```

局限：依赖记忆 TTL 和 LLM 的规则匹配可靠性。适合短时效的简单规则。

**Phase 2+ 方案（Watch Rule 系统，后续规划）**：

专门的 watch rule 存储 + 编排层规则匹配引擎，不依赖 LLM 判断。适合长期生效的复杂规则。此方案需要新增组件，不在本次重构范围内。

---

## 9. 实现计划概要

### Phase 1：Front Handler v2（核心改造）

1. 实现 `LLMClient` — 基于 `@anthropic-ai/sdk` 的封装，连接 LiteLLM
2. 实现 `FrontLoopRunner` — mini agent loop（<=5 轮）
3. 将 crab-messaging 工具从 MCP 格式转为 Anthropic tool 格式（Front 专用）
4. 实现 `make_decision` + `query_tasks` + `create_schedule` 内置工具
5. 更新 `unified-agent.ts` 中 FrontHandler 的构造和调用
6. 更新 Front system prompt（prompts.md）

### Phase 2：Worker Handler v2（改造）

1. cwd 隔离（`/tmp/crabot-task-{task_id}/`）+ 清理策略（保留最近 N 个）
2. 工具白名单（allowedTools），保留 Skill 工具 + settingSources 配置
3. 进度流推送（事件监听 + send_message）
4. 纠偏注入（pendingHumanMessages 检查 + context 注入）
5. front_context 传递（强制终止时的上下文接续）
6. 更新 Worker system prompt（prompts-worker.md）

### Phase 3：纠偏决策链

1. `SupplementTaskDecision` 类型 + DecisionDispatcher 处理
2. Front 上下文增强（活跃任务详情 + 进度摘要 + 来源 session）
3. confidence=low 时的用户确认流程
4. 端到端测试（私聊纠偏、群聊纠偏、多任务歧义）

### Phase 4（后续规划）

1. **Admin Skill 存储重构**：当前 Admin 将 Skill 存为 `{ id, name, content: string }`（单个文本字段），无法保留目录结构。需改为存储完整 Skill 目录（SKILL.md + 模板/脚本/示例等引用文件）。涉及：
   - 先审查 `crabot-docs/protocols/protocol-admin.md` 中 Skills 相关章节（§3.17 及相关类型定义），确认协议层面的调整
   - Admin 后端 SkillManager 存储格式迁移（`data/admin/skills/{id}/` 目录结构）
   - Admin 前端 Skill 管理 UI（支持目录上传/编辑，而非单个文本框）
   - `SkillConfig` 类型从 `{ id, name, content }` 改为 `{ id, name, path }` + 元数据
   - Worker 侧对应调整（从 Admin skills 目录整目录拷贝到 `{taskDir}/.claude/skills/`）
2. Watch Rule 系统（条件触发的可靠实现）
3. Admin 能力扩展 MCP 工具（master 权限操作）

---

## 10. 场景验证

| 场景 | Front v2 | Worker v2 | 预期效果 |
|------|----------|-----------|---------|
| 1. 群里技术员工 | @crabot + 项目路径 -> create_task (1-3s) | cwd=/tmp/..., mapping=[项目路径], settingSources 加载项目 Skills, 进度流推送 | 快速响应 + 过程可见 + 项目 Skills |
| 2. 跨 channel 指挥 | create_task (1-2s) | list_friends + send_message 批量发送, 进度: "已发送 10/42 条" | 跨渠道协作 |
| 3. 私聊+汇报+纠偏 | 快速响应 + supplement_task | 每 3 轮/30s 推进度, 纠偏注入后调整方向 | 全程可控 |
| 4. 群聊静默/插话 | 直接 API 快速判断 silent/reply (1-3s) | N/A | 自然的群聊参与 |
| 5. admin 能力扩展 | MCP 工具按需添加 | 同 | 渐进式扩展 |
| 6. 多任务查询 | query_tasks 工具直接回答 | activeTasks Map | 实时状态可查 |
| 7. 定时提醒 | create_schedule 工具 (1-2s) | Admin 调度器触发 -> send_message | 准时提醒 |
| 8. 条件触发（Phase 1） | 写入记忆 -> 后续消息匹配时触发 | N/A | 短时效规则 |

---

## 11. 风险与待定项

1. **SDK cwd 支持**：需确认 Claude Agent SDK 的 `query()` 是否支持 `cwd` 参数（文档中已见 `cwd` option）。如果不支持，备选方案见 4.2。
2. **纠偏注入机制**：需确认 SDK 是否支持在循环中注入用户消息。如果不支持，需要通过文件共享或 ask_human 回调通道实现。
3. **LiteLLM 兼容性**：`@anthropic-ai/sdk` 通过 `baseURL` 指向 LiteLLM，需确认 LiteLLM 对 Anthropic tool_use 格式的转换正确性（非 Anthropic 模型的 tool_use 支持程度）。
4. **Front 工具执行安全**：Front 的工具大部分是查询类（无副作用），但 `send_message` 和 `create_schedule` 有副作用。需要在 prompt 中限制 Front 不主动调用 `send_message`（由 DecisionDispatcher 统一发送），`create_schedule` 仅在用户明确要求时使用。
5. **非 Anthropic 模型的 tool_use 能力**：Front 的 make_decision 依赖模型正确输出 tool_use。部分模型（如 GLM、Qwen）通过 LiteLLM 转换后的 tool_use 支持程度不一，需要测试验证。必要时对特定模型保留 JSON 文本解析作为 fallback。
