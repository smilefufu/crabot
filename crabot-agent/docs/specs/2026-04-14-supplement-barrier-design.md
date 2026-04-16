# Supplement Barrier: 纠偏消息及时性优化

## 问题

当用户在 Worker 执行任务期间发送纠偏消息时，Front LLM 需要 ~4s 做出 `supplement_task` 决策。在这 4s 内，Worker 可能已经执行了不可逆操作（如 `send_message` 发送消息到群聊）。

**根因**：当前 supplement 只能在两个 turn 之间注入（`query-loop.ts` 的 `drainPending` 点），无法阻止当前 turn 正在执行或即将执行的工具调用。

**目标**：让 Worker 在"可能有纠偏消息到来"时主动等待，给 Front 足够时间完成决策，从而在工具执行前拦截。

## 设计

### 核心概念: Barrier

在 `HumanMessageQueue` 上增加 barrier（屏障）语义：

- **setBarrier(timeoutMs)** — 设置一个等待屏障，表示"可能有纠偏消息即将到来"
- **push()** — 自动清除 barrier（supplement 到达 = 等待结束）
- **clearBarrier()** — 显式清除（Front 判定不是 supplement，或 Front 出错）
- **超时自动清除** — 防止 Front 卡死导致 Worker 永久阻塞

### 触发条件

| 消息场景 | 是否触发 barrier | 原因 |
|---------|-----------------|------|
| 私聊消息 + 存在匹配的活跃 task | 是 | 私聊必回，高概率纠偏 |
| 群聊 @bot + 存在匹配的活跃 task | 是 | 被 @必回，高概率纠偏 |
| 群聊未 @bot | 否 | 大概率 silent，暂停代价过高 |

### Task 匹配规则

通过 `(channel_id, session_id)` 匹配活跃 task 的 `task_origin`：

- Channel A 的私聊消息只暂停 Channel A 私聊触发的 task
- Channel B 的消息不影响 Channel A 的 task
- 同一 session 有多个活跃 task 时，全部暂停，等 Front 决策出具体 task_id 后：
  - 被纠偏的 task：收到 supplement（barrier 自动清除）
  - 其他 task：显式 clearBarrier

### 参数

| 参数 | 值 | 理由 |
|------|-----|------|
| barrier 超时 | 8000ms | Front LLM 通常 3-5s，留够余量 |

## 数据流

### 正常纠偏流程（supplement 在 barrier 超时前到达）

```
时间线：
──────────────────────────────────────────────

1. 用户发送纠偏消息
2. unified-agent 收到消息
   ├── 查找匹配的活跃 task → 找到 task_A, task_B
   ├── 对 task_A, task_B 的 humanQueue 设置 barrier(8000ms)
   └── 开始 Front LLM 调用（~4s）
3. Worker task_A 当前 turn 的 LLM 调用完成，准备执行工具
   ├── 检测到 barrier → 等待...
   │       ... Front LLM 处理中 ...
   ├── supplement 到达 task_A 的 queue → barrier 自动清除
   ├── 取消本轮工具，注入 supplement
   └── 下一轮 LLM 看到纠偏内容 → 调整行为
4. Front 完成，对 task_B 调用 clearBarrier()
   └── task_B 继续正常执行
```

### Front 出错流程

```
1. 用户发送纠偏消息
2. unified-agent 设置 barrier → 开始 Front LLM
3. Front LLM 抛异常
4. catch/finally 中对所有已设置 barrier 的 task 调用 clearBarrier()
5. Worker 立即恢复执行（行为等同于无 barrier）
```

### 超时流程（Front 卡死）

```
1. 用户发送纠偏消息
2. unified-agent 设置 barrier(8000ms) → 开始 Front LLM
3. Front LLM 卡住超过 8s
4. barrier 超时自动清除
5. Worker 恢复执行（降级到现有行为）
```

## 实现细节

### 1. HumanMessageQueue 改动

```typescript
export class HumanMessageQueue {
  private pending: QueueContent[] = []
  private waitResolve: ((value: QueueContent) => void) | null = null
  private children: Set<...> = new Set()

  // ── 新增 barrier 相关 ──
  private barrierResolve: (() => void) | null = null
  private barrierTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 设置等待屏障。调用 waitBarrier() 会阻塞直到：
   * - push() 被调用（supplement 到达）
   * - clearBarrier() 被调用（非 supplement / 错误）
   * - 超时自动清除
   */
  setBarrier(timeoutMs: number): void {
    this.clearBarrier()  // 清除已有 barrier
    // barrier 的 resolve 由 push/clearBarrier/timeout 触发
    // 实际 Promise 在 waitBarrier() 中创建
    this.barrierTimer = setTimeout(() => {
      this.clearBarrier()
    }, timeoutMs)
  }

  clearBarrier(): void {
    if (this.barrierTimer) {
      clearTimeout(this.barrierTimer)
      this.barrierTimer = null
    }
    if (this.barrierResolve) {
      const resolve = this.barrierResolve
      this.barrierResolve = null
      resolve()
    }
  }

  get hasBarrier(): boolean {
    return this.barrierTimer !== null || this.barrierResolve !== null
  }

  /**
   * 等待 barrier 解除。如果没有 barrier，立即返回。
   * 支持 AbortSignal：任务被取消时不会卡在 barrier 等待上。
   */
  async waitBarrier(signal?: AbortSignal): Promise<void> {
    if (!this.barrierTimer && !this.barrierResolve) return
    if (this.barrierResolve) {
      // 已有等待者（不应发生，但安全处理）
      return
    }
    return new Promise<void>((resolve) => {
      this.barrierResolve = resolve
      if (signal) {
        const onAbort = () => this.clearBarrier()
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  push(content: QueueContent): void {
    // 现有逻辑...

    // 新增：push 自动清除 barrier
    this.clearBarrier()
  }

  // 其余方法不变
}
```

### 2. query-loop.ts 改动

在工具执行前增加 barrier 检查：

```typescript
// (现有) If no tool use, we're done
if (stopReason !== 'tool_use') {
  return buildResult('completed', finalText, totalTurns, contextManager)
}

// ── 新增：barrier 检查（工具执行前） ──
if (options.humanMessageQueue?.hasBarrier) {
  await options.humanMessageQueue.waitBarrier(abortSignal)

  // barrier 解除后，检查是否有 supplement 到达
  if (options.humanMessageQueue.hasPending) {
    // 有 supplement → 取消本轮工具，注入 supplement
    const cancelledResults = processed.toolUseBlocks.map(block => ({
      tool_use_id: block.id,
      content: '[操作已取消：收到用户实时纠偏，请根据新指示重新决策]',
      is_error: false,
    }))
    messages.push(createBatchToolResultMessage(cancelledResults))

    const supplements = options.humanMessageQueue.drainPending()
    for (const content of supplements) {
      messages.push(createUserMessage(content))
    }

    // 跳过本轮工具执行，进入下一轮 LLM 调用
    // onTurn 回调仍需触发（记录被取消的工具）
    if (options.onTurn) {
      options.onTurn({
        turnNumber: totalTurns,
        assistantText: processed.text,
        toolCalls: processed.toolUseBlocks.map(b => ({
          id: b.id,
          name: b.name,
          input: b.input,
          output: '[cancelled by supplement]',
          isError: false,
        })),
        stopReason,
        toolExecutionMs: 0,
      })
    }

    continue  // 跳到下一轮 for 循环
  }
  // else: barrier 被 clearBarrier/timeout 清除，无 supplement → 正常执行工具
}

// (现有) Execute tools
const batches = partitionToolCalls(...)
```

### 3. unified-agent.ts 改动

#### 3a. WorkerHandler 新增接口

```typescript
// worker-handler.ts
setBarrierForTask(taskId: TaskId, timeoutMs: number): boolean {
  const queue = this.humanQueues.get(taskId)
  if (!queue) return false
  queue.setBarrier(timeoutMs)
  return true
}

clearBarrierForTask(taskId: TaskId): void {
  const queue = this.humanQueues.get(taskId)
  queue?.clearBarrier()
}

/**
 * 查找 task_origin 匹配 (channel_id, session_id) 的活跃 task ID 列表
 */
getActiveTasksByOrigin(channelId: string, sessionId: string): TaskId[] {
  // 需要在 activeTasks 中记录 task_origin
  // 或从 executeTask 的 context 参数中提取
}
```

注意：当前 `activeTasks` Map 只存了 `WorkerTaskState`，不含 `task_origin`。需要在 `executeTask` 时把 `context.task_origin` 存入 state。

#### 3b. processDirectMessage 改动

```typescript
private async processDirectMessage(message, friend): Promise<void> {
  // ... 现有代码到 Front 调用前 ...

  // ── 新增：设置 barrier ──
  const BARRIER_TIMEOUT = 8000
  const barrierTaskIds = this.workerHandler
    ? this.workerHandler.getActiveTasksByOrigin(
        session.channel_id,
        session.session_id,
      )
    : []

  for (const taskId of barrierTaskIds) {
    this.workerHandler!.setBarrierForTask(taskId, BARRIER_TIMEOUT)
  }

  try {
    // 调用 Front Agent（现有逻辑）
    const result = await this.frontHandler.handleMessage(...)

    // 分发决策（现有逻辑）
    for (const decision of result.decisions) {
      await this.decisionDispatcher.dispatch(...)
    }

    // ── 新增：清除未被 supplement 命中的 barrier ──
    const supplementedTaskId = result.decisions
      .filter(d => d.type === 'supplement_task')
      .map(d => d.task_id)
    for (const taskId of barrierTaskIds) {
      if (!supplementedTaskId.includes(taskId)) {
        this.workerHandler!.clearBarrierForTask(taskId)
      }
    }
  } catch (error) {
    // ── 新增：异常时清除所有 barrier ──
    for (const taskId of barrierTaskIds) {
      this.workerHandler?.clearBarrierForTask(taskId)
    }
    throw error
  }
}
```

#### 3c. processGroupBatch 改动

同 processDirectMessage，但只在 `hasMention = true` 时设置 barrier。

## 改动文件清单

| 文件 | 改动 |
|------|------|
| `engine/human-message-queue.ts` | 新增 barrier 机制（setBarrier/clearBarrier/waitBarrier/hasBarrier） |
| `engine/query-loop.ts` | 工具执行前检查 barrier，supplement 到达时取消工具并注入 |
| `agent/worker-handler.ts` | 新增 setBarrierForTask/clearBarrierForTask/getActiveTasksByOrigin，WorkerTaskState 增加 task_origin |
| `unified-agent.ts` | processDirectMessage/processGroupBatch 中设置和清除 barrier |

## 风险与降级

- **barrier 超时** → 降级到现有行为（无 barrier），Worker 不受影响
- **Front 出错** → catch/finally 清除 barrier，Worker 不受影响
- **无匹配 task** → 不设置 barrier，零开销
- **Worker 在 barrier 等待期间被取消** → `waitBarrier(signal)` 监听 AbortSignal，abort 时自动 clearBarrier，Worker 回到 for 循环顶部的 abort 检查后退出
