# Sub-agent 纠偏广播 + 通用委派工具 设计文档

**日期**: 2026-04-13
**范围**: crabot-agent 引擎层 + Worker Handler
**前置依赖**: 2026-04-06-worker-subagent（已实现的 sub-agent 基础设施）

---

## 1. 背景与动机

### 1.1 现有问题

**纠偏机制未生效（Bug）**：`HumanMessageQueue` 的 `dequeue()` 接口已声明，Worker 也将 queue 传入 `runEngine()`，但 `runEngine()` 的主循环**从未调用 `dequeue()`**。纠偏消息被 push 进队列后无人消费，导致用户发出的 supplement_task 不会被注入到 Worker 的 LLM 对话中。

**Sub-agent 运行期间纠偏不可达**：当 Worker 委派任务给 sub-agent 后，Worker 阻塞在 `await executeToolBatches()`。即使修复了引擎层的 dequeue，纠偏消息也要等 sub-agent 全部执行完毕后才能被 Worker 消费。如果 sub-agent 陷入循环（如视觉专家反复截图点击），纠偏形同虚设。

**Sub-agent 工具过于刚性**：只有预定义的 `delegate_to_vision_expert` 和 `delegate_to_coding_expert`，Worker 无法灵活拆分通用子任务。

### 1.2 设计目标

1. 修复引擎层 `humanMessageQueue` 消费，让纠偏在 Worker 级别正常工作
2. 纠偏消息广播到正在运行的 sub-agent，sub-agent 在 turn 间隙自行处理
3. 新增 `delegate_task` 通用委派工具，与预定义专家共存
4. 确认 sub-agent 并发执行的正确性（已有基础设施）

---

## 2. 整体架构

### 2.1 纠偏消息流

```
用户发出 supplement_task
  ↓
Front → DecisionDispatcher → WorkerHandler.deliverHumanResponse()
  ↓
Worker 的 HumanMessageQueue.push()
  ↓ 自动广播
所有活跃 child queue 的 push()  （正在运行的 sub-agent）
  ↓
各层 runEngine() 在 turn 间隙检查自己的 queue
  ↓
注入为 user message → LLM 自行判断如何响应
```

### 2.2 引擎层改动位置

```
query-loop.ts  runEngine()
  ├─ [修复] 工具执行完毕后、下一次 LLM 调用前：检查 humanMessageQueue
  ├─ [修复] 如果有 pending 消息：dequeue 并注入为 user message
  └─ [不变] 继续正常的 LLM 调用

HumanMessageQueue（worker-handler.ts → 提取到独立文件）
  ├─ [新增] children: Set<HumanMessageQueue>
  ├─ [新增] createChild(): HumanMessageQueue  — 创建关联的子队列
  ├─ [新增] removeChild(): void — sub-agent 结束时解除关联
  └─ [修改] push(): 同时广播到所有 children
```

---

## 3. 详细设计

### 3.1 HumanMessageQueue 广播机制

从 `worker-handler.ts` 提取到 `engine/human-message-queue.ts`：

```typescript
export class HumanMessageQueue {
  private pending: Array<string | ContentBlock[]> = []
  private waitResolve: ((value: string | ContentBlock[]) => void) | null = null
  private children: Set<HumanMessageQueue> = new Set()

  push(content: string | ContentBlock[]): void {
    // 1. 自身入队
    if (this.waitResolve) {
      const resolve = this.waitResolve
      this.waitResolve = null
      resolve(content)
    } else {
      this.pending = [...this.pending, content]
    }
    // 2. 广播给所有 children
    for (const child of this.children) {
      child.push(content)
    }
  }

  async dequeue(): Promise<string | ContentBlock[]> {
    if (this.pending.length > 0) {
      const [first, ...rest] = this.pending
      this.pending = rest
      return first
    }
    return new Promise<string | ContentBlock[]>((resolve) => {
      this.waitResolve = resolve
    })
  }

  /** 非阻塞：取出所有 pending 消息，没有则返回空数组 */
  drainPending(): Array<string | ContentBlock[]> {
    const drained = this.pending
    this.pending = []
    // 如果有 waitResolve，说明没有 pending，返回空
    return drained
  }

  get hasPending(): boolean {
    return this.pending.length > 0
  }

  createChild(): HumanMessageQueue {
    const child = new HumanMessageQueue()
    this.children = new Set([...this.children, child])
    return child
  }

  removeChild(child: HumanMessageQueue): void {
    const next = new Set(this.children)
    next.delete(child)
    this.children = next
  }
}
```

**关键设计决策**：

- 使用 `drainPending()`（非阻塞批量取出）而非 `dequeue()`（阻塞等待）在引擎循环中消费。引擎不应该阻塞等待人类消息。
- `push()` 广播是同步的，不会丢消息。
- child queue 是独立实例，有自己的 pending 列表。parent push 时复制到 child，不是共享引用。

### 3.2 runEngine() 纠偏注入

在 `query-loop.ts` 的主循环中，工具结果收集后、下一次 LLM 调用前：

```typescript
// query-loop.ts  runEngine() 主循环内

// ... 工具执行完毕，toolResults 已收集 ...
messages.push(createBatchToolResultMessage(processedResults))

// [新增] 检查 humanMessageQueue，注入纠偏消息
if (options.humanMessageQueue) {
  const supplements = options.humanMessageQueue.drainPending()
  for (const content of supplements) {
    messages.push(createUserMessage(content))
  }
}

// 继续下一轮 LLM 调用 ...
```

**注入位置**：在 tool_result 之后、下一次 `adapter.stream()` 之前。这保证：
- LLM 先看到工具结果（包括 sub-agent 的返回），再看到纠偏消息
- 符合 Anthropic API 的消息交替规则（user → assistant → user）：tool_result 是 user role，supplement 也是 user role，它们会合并在同一个 user turn 中

**消息交替兼容性**：`createBatchToolResultMessage` 返回 `role: 'user'`，supplement 注入的 `createUserMessage` 也是 `role: 'user'`。需要确保 adapter 层正确处理连续的 user messages（合并或保持分开取决于 API 格式）。如果 adapter 不支持连续 user messages，需要将 supplement 合并到 tool result message 中。

### 3.3 纠偏消息格式

#### Worker 级别

```
[实时纠偏 - 来自用户]
用户在任务执行期间发来了补充指示：

"{supplement_content}"

请结合当前任务进展，调整你的执行方向。
```

#### Sub-agent 级别

```
[实时纠偏 - 来自用户]
用户在你执行任务期间发来了补充指示：

"{supplement_content}"

请判断：
- 如果此指示与你当前的工作直接相关，立即调整你的行为
- 如果此指示与你当前的工作无关（可能是针对整体任务的），忽略它继续工作
- 如果此指示表明你的整个子任务已不再需要，停止工作并返回当前已有的结果
```

#### 格式封装

在 `deliverHumanResponse()` 中封装 Worker 格式（现有逻辑）。在 `HumanMessageQueue.push()` 的广播路径中不做格式转换——广播的是同一条原始消息。

**但是** sub-agent 需要不同格式。解决方案：在 `createChild()` 时传入一个 `transformForChild` 函数，child queue 在接收广播时自动转换格式：

```typescript
createChild(transform?: (content: string | ContentBlock[]) => string | ContentBlock[]): HumanMessageQueue {
  const child = new HumanMessageQueue()
  child._parentTransform = transform
  this.children = new Set([...this.children, child])
  return child
}

// push 广播时：
for (const child of this.children) {
  const transformed = child._parentTransform ? child._parentTransform(content) : content
  child.push(transformed)
}
```

Worker 调用 `createChild()` 时传入转换函数，将 Worker 格式的纠偏消息转为 sub-agent 格式。

### 3.4 Sub-agent 工具与 child queue 的连接

在 `createSubAgentTool()` 中，`call` 函数需要：

1. 从 parent queue 创建 child queue
2. 传给 `forkEngine()` 的 options
3. forkEngine 完成后 removeChild

```typescript
// sub-agent.ts  createSubAgentTool 修改

export interface SubAgentToolConfig {
  // ... 现有字段 ...
  readonly parentHumanQueue?: HumanMessageQueue  // [新增]
}

export function createSubAgentTool(config: SubAgentToolConfig): ToolDefinition {
  return {
    // ...
    call: async (input, callContext) => {
      // 创建 child queue（带格式转换）
      let childQueue: HumanMessageQueue | undefined
      if (config.parentHumanQueue) {
        childQueue = config.parentHumanQueue.createChild((content) => {
          // 将 Worker 格式转为 sub-agent 格式
          const text = typeof content === 'string' ? content : '[多媒体纠偏消息]'
          return [
            '[实时纠偏 - 来自用户]\n',
            '用户在你执行任务期间发来了补充指示：\n\n',
            `"${text}"\n\n`,
            '请判断：\n',
            '- 如果此指示与你当前的工作直接相关，立即调整你的行为\n',
            '- 如果此指示与你当前的工作无关（可能是针对整体任务的），忽略它继续工作\n',
            '- 如果此指示表明你的整个子任务已不再需要，停止工作并返回当前已有的结果',
          ].join('')
        })
      }

      try {
        const result = await forkEngine({
          // ... 现有参数 ...
          humanMessageQueue: childQueue,  // [新增]
        })
        return { /* ... */ }
      } finally {
        // 清理 child queue
        if (childQueue && config.parentHumanQueue) {
          config.parentHumanQueue.removeChild(childQueue)
        }
      }
    },
  }
}
```

### 3.5 forkEngine 透传 humanMessageQueue

```typescript
// sub-agent.ts  ForkEngineParams

export interface ForkEngineParams {
  // ... 现有字段 ...
  readonly humanMessageQueue?: HumanMessageQueue  // [新增]
}

export async function forkEngine(params: ForkEngineParams): Promise<ForkEngineResult> {
  // ...
  const result = await runEngine({
    prompt,
    adapter: params.adapter,
    options: {
      // ... 现有字段 ...
      humanMessageQueue: params.humanMessageQueue,  // [新增] 透传到引擎
    },
  })
  // ...
}
```

不需要额外逻辑——`runEngine()` 已经统一处理 `humanMessageQueue`（§3.2 的改动）。

---

## 4. delegate_task 通用委派工具

### 4.1 定位

与预定义专家（`delegate_to_vision_expert`、`delegate_to_coding_expert`）共存：

| 工具 | 模型 | 定位 |
|------|------|------|
| `delegate_to_vision_expert` | 独立 VLM slot | 需要视觉能力的专项任务 |
| `delegate_to_coding_expert` | 独立 coding slot | 需要强代码能力的专项任务 |
| `delegate_task` | 复用 Worker 的模型 | 通用子任务拆分，减轻 Worker 上下文负担 |

### 4.2 工具定义

```typescript
{
  name: 'delegate_task',
  description: '将子任务委派给一个独立的执行者。执行者在独立上下文中运行，使用与你相同的模型和工具，只返回最终结果。适合：(1) 子任务的中间过程会污染你的上下文 (2) 子任务可以独立完成，不需要你的持续关注',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: '子任务的完整描述' },
      context: { type: 'string', description: '需要传递的背景信息（可选）' },
    },
    required: ['task'],
  },
  isReadOnly: true,  // 允许并行执行
}
```

### 4.3 实现

在 `worker-handler.ts` 的 `executeTask()` 中，在预定义专家工具之后注册：

```typescript
// 3g. Generic delegate_task tool (uses Worker's own model)
const delegateAdapter = createAdapter({
  endpoint: this.sdkEnv.env.LLM_BASE_URL ?? '',
  apikey: this.sdkEnv.env.LLM_API_KEY ?? '',
  format: this.sdkEnv.format,
})
tools.push(createSubAgentTool({
  name: 'delegate_task',
  description: '将子任务委派给一个独立的执行者...',  // 见 §4.2
  adapter: delegateAdapter,
  model: this.sdkEnv.modelId,
  systemPrompt: DELEGATE_TASK_SYSTEM_PROMPT,
  subTools: baseTools,  // Worker 的工具集（去掉委派工具）
  maxTurns: 30,
  supportsVision: this.sdkEnv.supportsVision,
  parentHumanQueue: humanQueue,
  onSubAgentTurn: traceCallback ? /* trace callback */ : undefined,
}))
```

### 4.4 delegate_task 的 system prompt

```typescript
const DELEGATE_TASK_SYSTEM_PROMPT = [
  '你是一个任务执行助手。你的职责是完成委派给你的子任务并返回清晰的结果。',
  '',
  '## 工作规则',
  '1. 专注于完成委派给你的任务，不要做超出范围的事情',
  '2. 如果任务需要使用工具，直接使用',
  '3. 完成后给出简洁明确的最终结果',
  '4. 如果无法完成任务，说明原因和已完成的部分',
].join('\n')
```

---

## 5. Sub-agent 并发确认

### 5.1 现有基础设施

引擎已支持工具并行执行：

- `partitionToolCalls()` 按 `isReadOnly` 将工具调用分为 parallel batch 和 serial batch
- `executeParallelBatch()` 使用 `Promise.all()` 并发执行同一 batch 内的工具
- 所有 sub-agent 工具（包括 `delegate_task`）标记为 `isReadOnly: true`

### 5.2 并发场景

当 Worker LLM 在一轮中同时调用多个 sub-agent 工具时：

```
Worker LLM turn N 返回:
  tool_use: delegate_to_vision_expert  (task: "分析截图")
  tool_use: delegate_task              (task: "查找相关文档")

partitionToolCalls() → 一个 parallel batch（两个都是 isReadOnly）
executeParallelBatch() → Promise.all([visionExpert, delegateTask])
→ 两个 sub-agent 并行执行
```

### 5.3 并发 + 纠偏的交互

当多个 sub-agent 并行运行时，纠偏消息通过 parent queue 广播到所有 child queue：

```
humanQueue.push("纠偏内容")
  → childQueue1.push(transformed)  // vision_expert 的队列
  → childQueue2.push(transformed)  // delegate_task 的队列

每个 sub-agent 的 runEngine() 在自己的 turn 间隙独立消费
```

不存在竞态问题：每个 child queue 是独立实例，有自己的 pending 列表。

### 5.4 无需额外改动

当前的 `partitionToolCalls()` + `executeParallelBatch()` 已经正确处理并发。本次设计不需要修改并发逻辑本身，只需确保：
- 所有 sub-agent 工具（包括新增的 `delegate_task`）的 `isReadOnly: true`
- child queue 的生命周期管理正确（`finally` 块中 `removeChild`）

---

## 6. 影响范围

### 6.1 修改的文件

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `engine/human-message-queue.ts` | **新建** | 从 worker-handler.ts 提取，添加广播机制 |
| `engine/query-loop.ts` | 修改 | 主循环中添加 humanMessageQueue 消费 |
| `engine/sub-agent.ts` | 修改 | SubAgentToolConfig 增加 parentHumanQueue，forkEngine 透传 |
| `engine/types.ts` | 修改 | humanMessageQueue 类型更新为具体类 |
| `agent/worker-handler.ts` | 修改 | 引用新的 HumanMessageQueue，注册 delegate_task |
| `agent/subagent-prompts.ts` | 修改 | 添加 DELEGATE_TASK_SYSTEM_PROMPT |

### 6.2 不修改的文件

| 文件 | 原因 |
|------|------|
| `unified-agent.ts` | sub-agent 注册逻辑不变，delegate_task 在 WorkerHandler 内部注册 |
| `orchestration/decision-dispatcher.ts` | supplement_task 分发逻辑不变 |
| `engine/tool-orchestration.ts` | 并发执行逻辑不变 |
| `engine/tool-framework.ts` | partitionToolCalls 逻辑不变 |

### 6.3 兼容性

- **supplement_task 纠偏**：修复后比以前更好——消息能被实际消费
- **cancel_task 取消**：不受影响，AbortController 路径独立
- **ProgressDigest**：`hasPending` 检查逻辑保持不变
- **ask_human 工具**：不受影响，status 设置逻辑独立
- **预定义专家工具**：不受影响，只是额外获得了纠偏能力

---

## 7. 消息交替兼容性（关键细节）

Anthropic API 要求 user/assistant 消息交替。tool_result 算 user role。纠偏消息也算 user role。

当 tool_result 后紧跟纠偏注入时，会出现连续两个 user messages。处理方式：

**方案**：将纠偏消息合并到 tool_result message 的末尾，作为同一个 user turn 的一部分。具体做法是在 `createBatchToolResultMessage` 之后、push 到 messages 之前，检查是否有 pending supplements，如果有则将其附加到同一个 user message 中。

实现上，在 `runEngine()` 中：

```typescript
// 合并 tool results + supplements 为一个 user message
const supplements = options.humanMessageQueue?.drainPending() ?? []
if (supplements.length > 0) {
  // 将 supplements 作为额外的 tool_result-like 内容追加
  // 或者创建一个包含 toolResults + text 的复合 user message
  messages.push(createBatchToolResultMessage(processedResults))
  messages.push(createUserMessage(supplements.map(s =>
    typeof s === 'string' ? s : '[多媒体消息]'
  ).join('\n')))
}
```

注意：连续 user messages 是否被 adapter 层合并取决于具体的 LLM adapter 实现。需要验证 AnthropicAdapter、OpenAIAdapter、GeminiAdapter 的行为。如果某个 adapter 不支持连续 user messages，需要在 adapter 层添加自动合并逻辑。

---

## 8. 不在本次范围

- **Sub-agent 进度汇报给用户**：当前 sub-agent 的 turn 事件只写 Trace，不汇报给用户。未来可以考虑将 sub-agent 的关键进展纳入 ProgressDigest。
- **Sub-agent 嵌套委派**：当前 sub-agent 的工具集排除了 `delegate_to_*`，不支持递归委派。
- **Prompt cache 共享优化**：Anthropic API 已自动处理相同 system prompt 的缓存，无需额外设计。
