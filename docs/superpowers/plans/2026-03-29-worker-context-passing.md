# Worker 上下文传递优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Worker 通过 `trigger_messages` 字段拿到 Front 做决策时的完整用户输入，解决上下文丢失问题。

**Architecture:** 在 `WorkerAgentContext` 中新增 `trigger_messages: ChannelMessage[]` 和 `sender_friend?: Friend`，Dispatcher 签名从单条 `message` 改为 `messages: ChannelMessage[]`，Worker 的 `buildTaskMessage` 优先展示 trigger_messages 作为用户请求。

**Tech Stack:** TypeScript, Vitest, Anthropic SDK

**Spec:** `docs/superpowers/specs/2026-03-29-worker-context-passing-design.md`

---

### Task 1: 扩展 WorkerAgentContext 类型

**Files:**
- Modify: `crabot-agent/src/types.ts:269-282`

- [ ] **Step 1: 添加 trigger_messages 和 sender_friend 字段**

在 `WorkerAgentContext` 接口中新增两个字段：

```typescript
export interface WorkerAgentContext {
  // 新增字段
  /** Front 做决策时的完整输入消息（create_task 场景必有） */
  trigger_messages?: ChannelMessage[]
  /** 发送者信息（Front 已查到，避免 Worker 重复查询） */
  sender_friend?: Friend

  // 现有字段不变
  task_origin?: TaskOrigin
  recent_messages?: ChannelMessage[]
  short_term_memories: ShortTermMemoryEntry[]
  long_term_memories: LongTermL0Entry[]
  available_tools: ToolDeclaration[]
  admin_endpoint: ResolvedModule
  memory_endpoint: ResolvedModule
  channel_endpoints: ResolvedModule[]
  sandbox_path_mappings?: Array<{
    sandbox_path: string
    host_path: string
    read_only: boolean
  }>
}
```

注意：`trigger_messages` 设为可选（`?`），因为 `create_task_from_schedule` 等非消息触发场景不会有此字段。

- [ ] **Step 2: 验证构建通过**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: 无新增错误（现有测试中 `available_tools: []` 的 mock 不受影响，新字段可选）

- [ ] **Step 3: Commit**

```bash
cd crabot-agent && git add src/types.ts
git commit -m "feat(agent): add trigger_messages and sender_friend to WorkerAgentContext"
```

---

### Task 2: Dispatcher 签名变更 — message → messages

**Files:**
- Modify: `crabot-agent/src/orchestration/decision-dispatcher.ts:44-56,129-247`

- [ ] **Step 1: 修改 dispatch 方法签名和所有 handler 签名**

`dispatch` 方法的 params 中 `message: ChannelMessage` 改为 `messages: ChannelMessage[]`：

```typescript
async dispatch(
  decision: MessageDecision,
  params: {
    channel_id: ModuleId
    session_id: string
    messages: ChannelMessage[]          // 改：单条 → 数组
    memoryPermissions: MemoryPermissions
    admin_chat_callback?: {
      source_module_id: string
      request_id: string
    }
  },
  traceCtx?: RpcTraceContext
): Promise<{ task_id?: string }> {
```

同步修改 `handleCreateTask`、`handleForwardToWorker`、`handleSupplementTask` 和 `executeTaskInBackground` 中所有引用 `params.message` 的位置改为 `params.messages`。

具体变更点：

**handleCreateTask** (约 line 129):
- 签名中 `message: ChannelMessage` → `messages: ChannelMessage[]`
- line 209: `friend_id: params.message.sender.friend_id` → `friend_id: params.messages[params.messages.length - 1].sender.friend_id`

**handleDirectReply** (约 line 82):
- 此方法不使用 `message`，签名无需包含它（已经没有）。无需改动。

**handleForwardToWorker** (约 line 396):
- 签名中 `message: ChannelMessage` → `messages: ChannelMessage[]`
- line 477: `messages: [params.message]` → `messages: params.messages`
- line 504: `task_description: params.message.content.text ?? ''` → `task_description: params.messages.map(m => m.content.text ?? '').join('\n')`

**handleSupplementTask** (约 line 518):
- 签名不含 `message`，无需改动。

**executeTaskInBackground** (约 line 253):
- 签名中 `message: ChannelMessage` → `messages: ChannelMessage[]`

- [ ] **Step 2: 在 handleCreateTask 中传递 trigger_messages 和 sender_friend**

在 `handleCreateTask` 中，`assembleWorkerContext` 调用后、构建 `execute_task` 参数时，把 `trigger_messages` 和 `sender_friend` 注入 context：

```typescript
// 4. 组装 Worker 上下文
const lastMsg = params.messages[params.messages.length - 1]
const workerContext = await this.contextAssembler.assembleWorkerContext({
  channel_id: params.channel_id,
  session_id: params.session_id,
  sender_id: lastMsg.sender.platform_user_id,
  message: params.messages.map(m => m.content.text ?? '').join('\n'),
  friend_id: lastMsg.sender.friend_id,
}, params.memoryPermissions)

// 注入 trigger_messages 和 sender_friend
const enrichedContext = {
  ...workerContext,
  trigger_messages: params.messages,
  sender_friend: params.senderFriend,
}
```

等等——`sender_friend` 数据从哪来？当前 dispatch 的 params 里没有 Friend 对象。需要在 dispatch params 中加 `senderFriend?: Friend`。

修改 dispatch 签名增加可选的 `senderFriend`：

```typescript
async dispatch(
  decision: MessageDecision,
  params: {
    channel_id: ModuleId
    session_id: string
    messages: ChannelMessage[]
    memoryPermissions: MemoryPermissions
    senderFriend?: Friend                  // 新增
    admin_chat_callback?: {
      source_module_id: string
      request_id: string
    }
  },
  traceCtx?: RpcTraceContext
): Promise<{ task_id?: string }> {
```

然后在 `handleCreateTask` 中：

```typescript
// 5. 异步调用 Worker（fire-and-forget）
this.executeTaskInBackground(
  workers[0].port,
  task,
  { ...workerContext, trigger_messages: params.messages, sender_friend: params.senderFriend },
  params
)
```

- [ ] **Step 3: 验证构建通过**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: unified-agent.ts 报错（dispatch 调用还未更新），其余无新增错误

- [ ] **Step 4: Commit**

```bash
cd crabot-agent && git add src/orchestration/decision-dispatcher.ts
git commit -m "refactor(agent): dispatcher accepts messages[] instead of single message"
```

---

### Task 3: 更新 unified-agent.ts 的 4 处 dispatch 调用

**Files:**
- Modify: `crabot-agent/src/unified-agent.ts` (4 处调用点)

- [ ] **Step 1: 更新 processDirectMessage 中的 dispatch 调用（约 line 499）**

```typescript
// 之前
message: lastMessage,

// 改为
messages: mergedMessages,
senderFriend: friend,
```

同时删除不再需要的 `const lastMessage = mergedMessages[mergedMessages.length - 1]`（line 478）。

- [ ] **Step 2: 更新 processGroupBatch 中的 dispatch 调用（约 line 652）**

```typescript
// 之前
message: lastMsg,

// 改为
messages: messages,
senderFriend: lastEntry.friend,
```

同时删除不再需要的 `const lastMsg = messages[messages.length - 1]`（line 606）。注意 `lastMsg` 在 context 组装时（line 611, 613）也有使用，需要内联替换为 `messages[messages.length - 1]`。

- [ ] **Step 3: 更新 handleProcessMessage 中的 dispatch 调用（约 line 1073）**

```typescript
// 之前
message: lastMessage,

// 改为
messages: mergedMessages,
```

此处没有 friend 对象（内部 RPC 调用），`senderFriend` 不传。删除 `const lastMessage = mergedMessages[mergedMessages.length - 1]`（line 1069）。

- [ ] **Step 4: 更新 processAdminChatMessage 中的 dispatch 调用（约 line 1235）**

```typescript
// 之前
message: lastMessage,

// 改为
messages: mergedMessages,
senderFriend: {
  id: 'master',
  display_name: 'Master',
  permission: 'master',
  channel_identities: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
},
```

删除 `const lastMessage = mergedMessages[mergedMessages.length - 1]`（line 1215）。

- [ ] **Step 5: 验证构建通过**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: PASS，无错误

- [ ] **Step 6: Commit**

```bash
cd crabot-agent && git add src/unified-agent.ts
git commit -m "refactor(agent): pass mergedMessages[] to dispatcher at all 4 call sites"
```

---

### Task 4: Worker buildTaskMessage 展示 trigger_messages

**Files:**
- Modify: `crabot-agent/src/agent/worker-handler.ts:502-541`
- Test: `crabot-agent/tests/agent/worker-handler.test.ts`

- [ ] **Step 1: 写测试 — buildTaskMessage 应优先展示 trigger_messages**

在 `crabot-agent/tests/agent/worker-handler.test.ts` 末尾添加：

```typescript
describe('buildTaskMessage', () => {
  it('should include trigger_messages as user request section', () => {
    // WorkerHandler.buildTaskMessage is private, test via executeTask input
    // 这里验证 buildTaskMessage 的输出结构
    const handler = new WorkerHandler(
      { modelId: 'test', env: {} },
      { systemPrompt: 'test', maxIterations: 1 },
    )

    // Access private method for unit testing
    const buildTaskMessage = (handler as any).buildTaskMessage.bind(handler)

    const task = {
      task_id: 'task_1',
      task_title: '挂靠功能实现方案规划',
      task_description: '分析挂靠功能需求并规划实现方案',
      task_type: 'analysis',
      priority: 'normal',
    }

    const context: WorkerAgentContext = {
      trigger_messages: [
        {
          platform_message_id: 'msg_1',
          session: { session_id: 's1', channel_id: 'ch1', type: 'private' as const },
          sender: { friend_id: 'f1', platform_user_id: 'u1', platform_display_name: 'FuFu' },
          content: { type: 'text' as const, text: '请帮我规划挂靠功能的实现方案，需求如下...' },
          features: { is_mention_crab: false },
          platform_timestamp: '2026-03-29T07:00:00Z',
        },
      ],
      task_origin: { channel_id: 'ch1', session_id: 's1' },
      short_term_memories: [],
      long_term_memories: [],
      available_tools: [],
      admin_endpoint: { module_id: 'admin', port: 19001 },
      memory_endpoint: { module_id: 'memory', port: 19002 },
      channel_endpoints: [],
    }

    const result = buildTaskMessage(task, context)

    // trigger_messages 内容应出现在输出中
    expect(result).toContain('请帮我规划挂靠功能的实现方案')
    expect(result).toContain('FuFu')
    // 应有"用户请求"段落
    expect(result).toContain('用户请求')
    // task_description 应作为"任务分类"出现
    expect(result).toContain('任务分类')
    expect(result).toContain('分析挂靠功能需求并规划实现方案')
  })

  it('should handle multiple trigger_messages (SwitchMap merge)', () => {
    const handler = new WorkerHandler(
      { modelId: 'test', env: {} },
      { systemPrompt: 'test', maxIterations: 1 },
    )
    const buildTaskMessage = (handler as any).buildTaskMessage.bind(handler)

    const task = {
      task_id: 'task_2',
      task_title: 'Test task',
      task_description: '测试分类',
      task_type: 'general',
      priority: 'normal',
    }

    const context: WorkerAgentContext = {
      trigger_messages: [
        {
          platform_message_id: 'msg_1',
          session: { session_id: 's1', channel_id: 'ch1', type: 'private' as const },
          sender: { friend_id: 'f1', platform_user_id: 'u1', platform_display_name: 'FuFu' },
          content: { type: 'text' as const, text: '帮我写个方案' },
          features: { is_mention_crab: false },
          platform_timestamp: '2026-03-29T07:00:00Z',
        },
        {
          platform_message_id: 'msg_2',
          session: { session_id: 's1', channel_id: 'ch1', type: 'private' as const },
          sender: { friend_id: 'f1', platform_user_id: 'u1', platform_display_name: 'FuFu' },
          content: { type: 'text' as const, text: '补充：要考虑解绑逻辑' },
          features: { is_mention_crab: false },
          platform_timestamp: '2026-03-29T07:00:05Z',
        },
      ],
      task_origin: { channel_id: 'ch1', session_id: 's1' },
      short_term_memories: [],
      long_term_memories: [],
      available_tools: [],
      admin_endpoint: { module_id: 'admin', port: 19001 },
      memory_endpoint: { module_id: 'memory', port: 19002 },
      channel_endpoints: [],
    }

    const result = buildTaskMessage(task, context)

    expect(result).toContain('帮我写个方案')
    expect(result).toContain('补充：要考虑解绑逻辑')
  })

  it('should gracefully handle missing trigger_messages', () => {
    const handler = new WorkerHandler(
      { modelId: 'test', env: {} },
      { systemPrompt: 'test', maxIterations: 1 },
    )
    const buildTaskMessage = (handler as any).buildTaskMessage.bind(handler)

    const task = {
      task_id: 'task_3',
      task_title: 'Schedule task',
      task_description: '定时任务描述',
      task_type: 'general',
      priority: 'normal',
    }

    const context: WorkerAgentContext = {
      task_origin: { channel_id: 'ch1', session_id: 's1' },
      short_term_memories: [],
      long_term_memories: [],
      available_tools: [],
      admin_endpoint: { module_id: 'admin', port: 19001 },
      memory_endpoint: { module_id: 'memory', port: 19002 },
      channel_endpoints: [],
    }

    const result = buildTaskMessage(task, context)

    // 无 trigger_messages 时回退到 task_description
    expect(result).toContain('定时任务描述')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd crabot-agent && npx vitest run tests/agent/worker-handler.test.ts --reporter=verbose`
Expected: 新增的 3 个测试 FAIL（buildTaskMessage 还没改）

- [ ] **Step 3: 修改 buildTaskMessage 实现**

替换 `worker-handler.ts` 中的 `buildTaskMessage` 方法（约 line 502-541）：

```typescript
private buildTaskMessage(task: ExecuteTaskParams['task'], context: WorkerAgentContext): string {
  const parts: string[] = []
  parts.push('## 任务信息')
  parts.push(`- 标题: ${task.task_title}`)
  parts.push(`- 类型: ${task.task_type}`)
  parts.push(`- 优先级: ${task.priority}`)
  if (task.plan) { parts.push(`- 计划: ${task.plan}`) }

  // trigger_messages: 用户的原始请求（核心内容）
  if (context.trigger_messages && context.trigger_messages.length > 0) {
    parts.push(`\n## 用户请求（共 ${context.trigger_messages.length} 条消息）`)
    for (const msg of context.trigger_messages) {
      const time = msg.platform_timestamp ? ` (${msg.platform_timestamp})` : ''
      parts.push(`\n### ${msg.sender.platform_display_name}${time}`)
      parts.push(msg.content.text ?? '[非文本消息]')
    }
    if (task.task_description) {
      parts.push(`\n## 任务分类\n${task.task_description}`)
    }
  } else {
    // 无 trigger_messages（如定时任务），回退到 task_description
    parts.push(`\n## 任务描述\n${task.task_description}`)
  }

  if (context.sender_friend) {
    parts.push(`\n## 发送者信息`)
    parts.push(`- 名称: ${context.sender_friend.display_name}`)
    parts.push(`- 权限: ${context.sender_friend.permission}`)
  }

  if (context.task_origin) {
    parts.push('\n## 任务来源（crab-messaging 工具请使用这些 ID）')
    parts.push(`- Channel ID: ${context.task_origin.channel_id}`)
    parts.push(`- Session ID: ${context.task_origin.session_id}`)
  }
  if (context.short_term_memories.length > 0) {
    parts.push('\n## 短期记忆')
    for (const m of context.short_term_memories.slice(-5)) { parts.push(`- ${m.content}`) }
  }
  if (context.long_term_memories.length > 0) {
    parts.push('\n## 长期记忆')
    for (const m of context.long_term_memories.slice(-5)) { parts.push(`- ${m.content}`) }
  }
  if (context.recent_messages && context.recent_messages.length > 0) {
    parts.push(`\n## 最近相关消息（共 ${context.recent_messages.length} 条）`)
    for (const m of context.recent_messages.slice(-20)) {
      parts.push(`- ${m.sender.platform_display_name}: ${m.content.text ?? '[非文本消息]'}`)
    }
  }

  // front_context from forced Front termination
  const taskWithContext = task as { front_context?: Array<{ tool_name: string; output_summary: string }> }
  if (taskWithContext.front_context && Array.isArray(taskWithContext.front_context)) {
    parts.push('\n## Front Agent 已完成的工作')
    parts.push('（以下信息已获取，请直接使用，不要重复查询）')
    for (const entry of taskWithContext.front_context) {
      parts.push(`- ${entry.tool_name}: ${entry.output_summary}`)
    }
  }

  return parts.join('\n')
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd crabot-agent && npx vitest run tests/agent/worker-handler.test.ts --reporter=verbose`
Expected: 所有测试 PASS

- [ ] **Step 5: Commit**

```bash
cd crabot-agent && git add src/agent/worker-handler.ts tests/agent/worker-handler.test.ts
git commit -m "feat(agent): buildTaskMessage displays trigger_messages as user request"
```

---

### Task 5: Front prompt — task_description 引导为一句话分类

**Files:**
- Modify: `crabot-agent/src/agent/front-tools.ts:27`
- Modify: `crabot-agent/src/prompt-manager.ts:20-21`

- [ ] **Step 1: 修改 make_decision tool 的 task_description 描述**

在 `front-tools.ts` line 27，修改 description：

```typescript
// 之前
task_description: { type: 'string', description: '任务详细描述（type=create_task 时必填）' },

// 改为
task_description: { type: 'string', description: '一句话分类标注，描述任务方向（type=create_task 时必填）。不要概括用户需求，原始消息会完整传给 Worker。例如："分析挂靠功能需求并规划实现方案"' },
```

- [ ] **Step 2: 在 Front rules 中补充 create_task 指引**

在 `prompt-manager.ts` 的 `FRONT_RULES_TEMPLATE` 中，`## 判断标准` 段落后追加：

```typescript
// 在 FRONT_RULES_TEMPLATE 的末尾、反引号之前追加：

\n\n## create_task 字段指引

- task_title：任务标题，简明扼要
- task_description：一句话分类标注，描述任务方向。不要概括用户的完整需求——用户的原始消息会完整传递给 Worker
- task_type：general / code / analysis / command`
```

- [ ] **Step 3: 验证构建通过**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd crabot-agent && git add src/agent/front-tools.ts src/prompt-manager.ts
git commit -m "feat(agent): guide Front LLM to write one-line task_description"
```

---

### Task 6: 更新已有测试中的 mock 数据

**Files:**
- Modify: `crabot-agent/tests/agent/worker-handler.test.ts` (现有用例的 context mock)
- Modify: `crabot-agent/tests/agent/front-handler.test.ts`
- Modify: `crabot-agent/tests/agent/build-user-message.test.ts`
- Modify: `crabot-agent/tests/orchestration/context-assembler.test.ts`

- [ ] **Step 1: 确认当前所有测试状态**

Run: `cd crabot-agent && npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: 查看哪些测试通过/失败。新字段可选，现有 mock 不必填 `trigger_messages`，应该不会因类型变更而失败。

- [ ] **Step 2: 如有失败，逐个修复 mock 数据**

如果有测试因 `message` → `messages` 签名变更而失败（主要在 dispatcher 相关测试），更新对应 mock：

```typescript
// 如有直接 mock dispatch 调用的测试，将 message: mockMessage 改为 messages: [mockMessage]
```

- [ ] **Step 3: 运行全部测试确认通过**

Run: `cd crabot-agent && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
cd crabot-agent && git add tests/
git commit -m "test(agent): update mock data for messages[] dispatcher signature"
```

---

### Task 7: 更新协议文档

**Files:**
- Modify: `crabot-docs/protocols/protocol-agent-v2.md:156-180`

- [ ] **Step 1: 在 ExecuteTaskParams.context 中添加新字段**

在 `protocol-agent-v2.md` 的 `ExecuteTaskParams` 定义中（约 line 160-178），在 `recent_messages` 之前添加：

```typescript
interface ExecuteTaskParams {
  task: Task
  context: {
    task_origin?: TaskOrigin
    /**
     * Front 做决策时的完整输入消息（create_task 场景必有）。
     * - 普通私聊：单条消息
     * - SwitchMap 合并：所有被中断合并的消息
     * - 群聊 debounce：整个缓冲窗口的消息
     */
    trigger_messages?: ChannelMessage[]
    /** 发送者的 Friend 信息（由 Front 预加载） */
    sender_friend?: Friend
    /**
     * 来源 Session 的近期聊天记录（正序，最旧在前）。
     * 语义为"触发消息之前的历史背景"，不含当前触发消息。
     */
    recent_messages?: ChannelMessage[]
    short_term_memories: ShortTermMemoryEntry[]
    long_term_memories: LongTermL0Entry[]
    available_tools: ToolDeclaration[]
    admin_endpoint: ResolvedModule
    memory_endpoint: ResolvedModule
    channel_endpoints: ResolvedModule[]
    sandbox_path_mappings?: Array<{
      sandbox_path: string
      host_path: string
      read_only: boolean
    }>
  }
}
```

- [ ] **Step 2: 更新版本历史**

在协议文档末尾的版本历史表中追加：

```markdown
| 0.3.1 | 2026-03-29 | ExecuteTaskParams.context 新增 trigger_messages 和 sender_friend 字段；收窄 recent_messages 语义 |
```

- [ ] **Step 3: Commit**

```bash
cd crabot-docs && git add protocols/protocol-agent-v2.md
git commit -m "docs(protocol): add trigger_messages and sender_friend to ExecuteTaskParams"
```

---

### Task 8: 端到端验证

- [ ] **Step 1: 构建项目**

Run: `cd crabot-agent && npm run build`
Expected: PASS

- [ ] **Step 2: 运行全部测试**

Run: `cd crabot-agent && npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 3: 启动开发环境并发送测试消息**

Run: `./dev.sh`

发送一条包含详细需求的长消息（类似"挂靠功能"场景），然后用调试脚本检查 trace：

Run: `node scripts/debug-agent.mjs traces`

验证：
1. Front trace 中 `create_task` 决策正常
2. Worker trace 中 `buildTaskMessage` 的 input_summary 包含用户原始请求内容
3. Worker 不再反问用户已经提供的信息

- [ ] **Step 4: 检查 Worker 日志确认 trigger_messages 传递**

Run: `node scripts/debug-agent.mjs trace`

在最新 trace 的 Worker span 中，iteration 1 的 input_summary 应包含用户原始消息的关键词，而非仅有 task_title。
