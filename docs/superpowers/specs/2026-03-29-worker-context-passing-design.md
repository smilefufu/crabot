# Worker 上下文传递优化设计

Date: 2026-03-29
Status: Approved

---

## 1. 问题

Front Handler 做出 `create_task` 决策后，Worker 拿不到用户的原始请求。

### 根因

1. **task_description 信息损耗**：Front LLM 把用户详细需求压缩为 ~100 字摘要，Worker 只看到摘要
2. **recent_messages 时序缺口**：`assembleWorkerContext` 拉历史消息时，当前消息可能还没入库，Worker 看不到触发任务的消息
3. **dispatch 丢弃合并消息**：SwitchMap 合并后的 `mergedMessages` 传给了 Front Handler，但 dispatch 时只传了 `lastMessage`（最后一条），前面的消息丢失

### 实际案例

用户发送 ~2000 字的"挂靠功能"详细需求 → Front 正确决策 `create_task` → Worker 只拿到标题"挂靠功能实现方案规划" → Worker 跑了 8 轮迭代后反问用户"请提供挂靠的具体业务场景是什么？"

---

## 2. 设计决策

### 2.1 Front 定位：纯分类器

Front 只做意图分类（direct_reply / create_task / supplement_task / silent），不对用户消息做加工。Worker 应该看到用户的原始消息。

### 2.2 上下文传递方案：trigger_messages

在 `WorkerAgentContext` 中新增 `trigger_messages: ChannelMessage[]`，携带 Front 做决策时的完整输入消息。

- 普通私聊 → `[msg]`
- SwitchMap 合并 → `[msg_a, msg_b, ...]`（所有被中断合并的消息）
- 群聊 debounce → `[msg1, msg2, ...]`（整个缓冲窗口的消息）

`trigger_messages` 与 `recent_messages` 职责分离：

| 字段 | 语义 | 时序风险 |
|------|------|---------|
| `trigger_messages` | "这次任务是因为什么而创建的" | 无（代码确定性传递） |
| `recent_messages` | "在这之前还聊了什么"（历史背景） | 有但无所谓，不承担传递当前请求的职责 |

### 2.3 task_description 重新定位

从"任务描述"降级为"一句话分类标注"。Front system prompt 明确：`task_description` 写一句话描述任务分类和方向，不要试图概括用户的完整需求。

### 2.4 Worker 阶段的补充消息（不在本次改动范围）

Worker 运行时的补充消息走现有的 `deliver_human_response` → `streamInput` 路径。SDK 自身维护完整对话历史，`streamInput` 追加新 user turn，无需重传之前的消息。此机制已正确实现，不需要改动。

---

## 3. 上下文包结构

### WorkerAgentContext 变更

```typescript
interface WorkerAgentContext {
  // 新增
  trigger_messages: ChannelMessage[]     // Front 做决策时的完整输入消息（必有，>=1条）
  sender_friend?: Friend                 // 发送者信息（Front 已查到，避免 Worker 重复查询）

  // 现有保留
  task_origin?: TaskOrigin
  recent_messages?: ChannelMessage[]     // 语义收窄为"触发消息之前的历史背景"
  short_term_memories: ShortTermMemoryEntry[]
  long_term_memories: LongTermL0Entry[]
  available_tools: ToolDeclaration[]     // 保留（协议定义，待 Admin 工具权限功能补齐）
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

### Worker buildTaskMessage 输出顺序

```
## 任务信息
- 标题: ...
- 类型: ...
- 优先级: ...

## 用户请求
（逐条展示 trigger_messages，保留发送者和时间）

## 任务分类
（Front 的一句话标注，原 task_description）

## 短期记忆
...

## 长期记忆
...

## 最近相关消息
（recent_messages，历史背景）
```

---

## 4. 数据流

### 创建任务流程

```
用户消息到达
  → SwitchMap/Debounce（可能合并多条消息）
  → Front Handler: messages=[msg1, msg2, ...] → make_decision(create_task)
  → DecisionDispatcher.dispatch(decision, { messages: mergedMessages })
    ├─ 1. 发送即时回复
    ├─ 2. create_task RPC → Admin（title + 一句话 description）
    ├─ 3. assembleWorkerContext（长期记忆检索 query = trigger_messages 合并文本）
    └─ 4. execute_task → Worker
           task: { title, description(一句话), type, priority }
           context: { trigger_messages: mergedMessages, sender_friend, recent_messages, memories, ... }
             → Worker.buildTaskMessage() 优先展示 trigger_messages 作为"用户请求"
```

### 长期记忆检索 query

协议规定 Worker 上下文预加载 L0 级别长期记忆（`默认预加载 L0 级别，Worker 可按需通过 Memory 接口加载更高级别`）。

检索 query 从当前的单条消息文本改为 trigger_messages 合并文本，确保多消息场景下语义检索的完整性。

---

## 5. 改动清单

| 文件 | 改动 |
|------|------|
| `types.ts` | `WorkerAgentContext` 加 `trigger_messages: ChannelMessage[]` 和 `sender_friend?: Friend` |
| `decision-dispatcher.ts` | `dispatch` 签名 `message: ChannelMessage` → `messages: ChannelMessage[]`；`handleCreateTask` 把 messages 作为 trigger_messages 传入 context |
| `context-assembler.ts` | `assembleWorkerContext` 的 message 参数改为接收合并文本（用于长期记忆检索 query） |
| `unified-agent.ts` | 3 处 dispatch 调用：`message: lastMessage` → `messages: mergedMessages` |
| `worker-handler.ts` | `buildTaskMessage` 新增"用户请求"段展示 trigger_messages；task_description 降为"任务分类" |
| Front system prompt | `task_description` 引导改为一句话分类标注 |
| `protocol-agent-v2.md` | `ExecuteTaskParams.context` 加 `trigger_messages` 和 `sender_friend` 字段说明 |
| 相关测试文件 | 更新 mock 数据和断言 |

---

## 6. SwitchMap 核实结论

SwitchMap 在 Front 阶段的实现已完全符合协议要求（取消旧请求 + 合并被中断消息 + 完整列表传给 Front Handler）。本次改动只需将合并后的完整消息列表延续传递到 Dispatcher 层，不需要修改 SwitchMap 本身。

---

## 7. 不在本次范围的事项

- `available_tools` 的实际填充（依赖 Admin 工具权限功能）
- 超长消息的预处理/压缩（当前不需要，未来可作为可选中间步骤）
- Worker 运行时消息注入机制（`deliver_human_response` + `streamInput`，已正确实现）
