# Supplement Barrier 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Worker 在收到"可能有纠偏消息"的信号时主动暂停工具执行，等待 Front LLM 完成决策，防止在纠偏消息到达前执行不可逆操作。

**Architecture:** 在 HumanMessageQueue 上增加 barrier（屏障）语义。Front 收到可能是纠偏的消息时，立即通知 Worker 设置 barrier。Worker 在执行工具前检查 barrier，等待 supplement 到达或 barrier 被清除。改动集中在 4 个文件：human-message-queue.ts、query-loop.ts、worker-handler.ts、unified-agent.ts。

**Tech Stack:** TypeScript, Vitest

**Spec:** `crabot-agent/docs/specs/2026-04-14-supplement-barrier-design.md`

---

### Task 1: HumanMessageQueue barrier 机制

**Files:**
- Modify: `src/engine/human-message-queue.ts`
- Test: `tests/engine/human-message-queue.test.ts`

- [ ] **Step 1: 写 barrier 基础测试**

在 `tests/engine/human-message-queue.test.ts` 末尾添加新的 describe block：

```typescript
describe('barrier', () => {
  it('hasBarrier is false by default', () => {
    const queue = new HumanMessageQueue()
    expect(queue.hasBarrier).toBe(false)
  })

  it('setBarrier makes hasBarrier true', () => {
    const queue = new HumanMessageQueue()
    queue.setBarrier(5000)
    expect(queue.hasBarrier).toBe(true)
  })

  it('clearBarrier makes hasBarrier false', () => {
    const queue = new HumanMessageQueue()
    queue.setBarrier(5000)
    queue.clearBarrier()
    expect(queue.hasBarrier).toBe(false)
  })

  it('waitBarrier resolves immediately when no barrier', async () => {
    const queue = new HumanMessageQueue()
    await queue.waitBarrier()  // should not hang
  })

  it('waitBarrier blocks until clearBarrier is called', async () => {
    const queue = new HumanMessageQueue()
    queue.setBarrier(5000)
    let resolved = false
    const promise = queue.waitBarrier().then(() => { resolved = true })
    // Should not resolve synchronously
    await Promise.resolve()
    expect(resolved).toBe(false)
    queue.clearBarrier()
    await promise
    expect(resolved).toBe(true)
  })

  it('push auto-clears barrier', async () => {
    const queue = new HumanMessageQueue()
    queue.setBarrier(5000)
    let resolved = false
    const promise = queue.waitBarrier().then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(false)
    queue.push('supplement msg')
    await promise
    expect(resolved).toBe(true)
    expect(queue.hasBarrier).toBe(false)
    expect(queue.hasPending).toBe(true)
  })

  it('barrier auto-clears on timeout', async () => {
    vi.useFakeTimers()
    const queue = new HumanMessageQueue()
    queue.setBarrier(100)
    let resolved = false
    const promise = queue.waitBarrier().then(() => { resolved = true })
    expect(resolved).toBe(false)
    vi.advanceTimersByTime(100)
    await promise
    expect(resolved).toBe(true)
    expect(queue.hasBarrier).toBe(false)
    vi.useRealTimers()
  })

  it('setBarrier clears previous barrier before setting new one', () => {
    const queue = new HumanMessageQueue()
    queue.setBarrier(5000)
    queue.setBarrier(3000)
    expect(queue.hasBarrier).toBe(true)
    queue.clearBarrier()
    expect(queue.hasBarrier).toBe(false)
  })

  it('waitBarrier responds to AbortSignal', async () => {
    const queue = new HumanMessageQueue()
    queue.setBarrier(5000)
    const controller = new AbortController()
    let resolved = false
    const promise = queue.waitBarrier(controller.signal).then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(false)
    controller.abort()
    await promise
    expect(resolved).toBe(true)
    expect(queue.hasBarrier).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认全部失败**

Run: `cd crabot-agent && npx vitest run tests/engine/human-message-queue.test.ts`
Expected: 新增的 8 个 barrier 测试全部 FAIL（setBarrier/clearBarrier/waitBarrier/hasBarrier 不存在）

- [ ] **Step 3: 实现 barrier 机制**

修改 `src/engine/human-message-queue.ts`，在 class 中新增以下成员和方法：

```typescript
export class HumanMessageQueue {
  private pending: QueueContent[] = []
  private waitResolve: ((value: QueueContent) => void) | null = null
  private children: Set<{ queue: HumanMessageQueue; transform?: QueueTransform }> = new Set()

  // ── 新增 ──
  private barrierResolve: (() => void) | null = null
  private barrierTimer: ReturnType<typeof setTimeout> | null = null

  setBarrier(timeoutMs: number): void {
    this.clearBarrier()
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

  async waitBarrier(signal?: AbortSignal): Promise<void> {
    if (!this.barrierTimer && !this.barrierResolve) return
    if (this.barrierResolve) return
    return new Promise<void>((resolve) => {
      this.barrierResolve = resolve
      if (signal) {
        const onAbort = () => this.clearBarrier()
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  push(content: QueueContent): void {
    if (this.waitResolve) {
      const resolve = this.waitResolve
      this.waitResolve = null
      resolve(content)
    } else {
      this.pending = [...this.pending, content]
    }
    for (const child of this.children) {
      const transformed = child.transform ? child.transform(content) : content
      child.queue.push(transformed)
    }
    // 新增：push 自动清除 barrier
    this.clearBarrier()
  }

  // ... 其余方法不变 ...
}
```

- [ ] **Step 4: 运行测试确认全部通过**

Run: `cd crabot-agent && npx vitest run tests/engine/human-message-queue.test.ts`
Expected: 所有测试 PASS（原有 + 新增）

- [ ] **Step 5: 提交**

```bash
cd crabot-agent
git add src/engine/human-message-queue.ts tests/engine/human-message-queue.test.ts
git commit -m "feat(engine): add barrier mechanism to HumanMessageQueue for supplement timing"
```

---

### Task 2: query-loop 工具执行前 barrier 检查

**Files:**
- Modify: `src/engine/query-loop.ts`
- Test: `tests/engine/query-loop.test.ts`

- [ ] **Step 1: 写 barrier 集成测试**

在 `tests/engine/query-loop.test.ts` 末尾新增 describe block：

```typescript
describe('runEngine barrier integration', () => {
  it('waits for barrier before executing tools, cancels tools when supplement arrives', async () => {
    const capturedMessages: unknown[][] = []
    let callIndex = 0

    const adapter: LLMAdapter = {
      async *stream(params) {
        capturedMessages.push([...params.messages])
        if (callIndex === 0) {
          // Turn 1: LLM wants to call send_message
          for (const chunk of toolUseResponse('tu-1', 'send_message', { text: 'hello group' })) yield chunk
        } else {
          // Turn 2: LLM sees supplement and adjusts
          for (const chunk of textResponse('Adjusted per user request')) yield chunk
        }
        callIndex++
      },
      updateConfig() {},
    }

    const queue = new HumanMessageQueue()
    const toolCallLog: string[] = []

    const sendTool = defineTool({
      name: 'send_message',
      description: 'Send a message',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      isReadOnly: false,
      call: async (input) => {
        toolCallLog.push(`sent: ${(input as { text: string }).text}`)
        return { output: 'ok', isError: false }
      },
    })

    // Set barrier BEFORE runEngine starts — simulates Front signaling pause
    queue.setBarrier(5000)

    // After a tick, push supplement (simulates Front completing after ~small delay)
    setTimeout(() => {
      queue.push('[实时纠偏 - 来自用户]\n用户补充指示：不要发群，发给我')
    }, 10)

    const result = await runEngine({
      prompt: 'Send report',
      adapter,
      options: baseOptions({
        tools: [sendTool],
        humanMessageQueue: queue,
      }),
    })

    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('Adjusted per user request')
    // Tool should NOT have been called — barrier intercepted it
    expect(toolCallLog).toHaveLength(0)
    // Second LLM call should see cancelled tool result + supplement
    const secondCallMessages = capturedMessages[1]
    const allContent = secondCallMessages.map((m: any) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ).join(' ')
    expect(allContent).toContain('操作已取消')
    expect(allContent).toContain('不要发群')
  })

  it('proceeds normally when barrier is cleared without supplement', async () => {
    const toolCallLog: string[] = []

    const adapter = mockAdapter([
      toolUseResponse('tu-1', 'dummy', {}),
      textResponse('Done'),
    ])

    const queue = new HumanMessageQueue()

    const dummyTool = defineTool({
      name: 'dummy',
      description: 'Dummy',
      inputSchema: {},
      isReadOnly: false,
      call: async () => {
        toolCallLog.push('called')
        return { output: 'ok', isError: false }
      },
    })

    // Set barrier then immediately clear (simulates Front deciding non-supplement)
    queue.setBarrier(5000)
    setTimeout(() => queue.clearBarrier(), 10)

    const result = await runEngine({
      prompt: 'Go',
      adapter,
      options: baseOptions({
        tools: [dummyTool],
        humanMessageQueue: queue,
      }),
    })

    expect(result.outcome).toBe('completed')
    // Tool SHOULD have been called — no supplement
    expect(toolCallLog).toHaveLength(1)
  })

  it('proceeds normally when barrier times out', async () => {
    vi.useFakeTimers()
    const toolCallLog: string[] = []

    let callIndex = 0
    const adapter: LLMAdapter = {
      async *stream() {
        if (callIndex === 0) {
          for (const chunk of toolUseResponse('tu-1', 'dummy', {})) yield chunk
        } else {
          for (const chunk of textResponse('Done')) yield chunk
        }
        callIndex++
      },
      updateConfig() {},
    }

    const queue = new HumanMessageQueue()

    const dummyTool = defineTool({
      name: 'dummy',
      description: 'Dummy',
      inputSchema: {},
      isReadOnly: false,
      call: async () => {
        toolCallLog.push('called')
        return { output: 'ok', isError: false }
      },
    })

    queue.setBarrier(100)

    const enginePromise = runEngine({
      prompt: 'Go',
      adapter,
      options: baseOptions({
        tools: [dummyTool],
        humanMessageQueue: queue,
      }),
    })

    // Advance past barrier timeout
    vi.advanceTimersByTime(100)
    await vi.runAllTimersAsync()

    const result = await enginePromise

    expect(result.outcome).toBe('completed')
    expect(toolCallLog).toHaveLength(1)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: 运行测试确认新测试失败（barrier 无效果）**

Run: `cd crabot-agent && npx vitest run tests/engine/query-loop.test.ts`
Expected: 第一个 barrier 测试 FAIL（send_message 被正常执行了，toolCallLog 长度为 1 而非 0）

- [ ] **Step 3: 在 query-loop.ts 中实现 barrier 检查**

修改 `src/engine/query-loop.ts`，在 `stopReason !== 'tool_use'` 检查之后、`partitionToolCalls` 之前，插入 barrier 检查逻辑：

```typescript
    // If no tool use, we're done
    if (stopReason !== 'tool_use') {
      return buildResult('completed', finalText, totalTurns, contextManager)
    }

    // ── Barrier check: wait for potential supplement before executing tools ──
    if (options.humanMessageQueue?.hasBarrier) {
      await options.humanMessageQueue.waitBarrier(abortSignal)

      // Check abort after waiting
      if (abortSignal?.aborted) {
        return buildResult('aborted', finalText, totalTurns, contextManager)
      }

      // If supplement arrived during wait, cancel tools and inject
      if (options.humanMessageQueue.hasPending) {
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

        // Fire onTurn with cancelled tools for trace recording
        if (options.onTurn) {
          const turnEvent: EngineTurnEvent = {
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
          }
          options.onTurn(turnEvent)
        }

        continue  // Skip tool execution, go to next LLM turn
      }
      // else: barrier cleared without supplement → proceed normally
    }

    // Execute tools (existing code)
    const batches = partitionToolCalls(processed.toolUseBlocks, options.tools)
```

注意：这段代码插入位置在现有 `stopReason !== 'tool_use'` 判断之后、`partitionToolCalls` 之前。

- [ ] **Step 4: 运行测试确认全部通过**

Run: `cd crabot-agent && npx vitest run tests/engine/query-loop.test.ts`
Expected: 所有测试 PASS（原有 + 新增）

- [ ] **Step 5: 提交**

```bash
cd crabot-agent
git add src/engine/query-loop.ts tests/engine/query-loop.test.ts
git commit -m "feat(engine): check barrier before tool execution in query-loop"
```

---

### Task 3: WorkerHandler barrier 接口 + task origin 追踪

**Files:**
- Modify: `src/agent/worker-handler.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: 在 WorkerTaskState 中增加 task_origin**

修改 `src/types.ts` 中的 `WorkerTaskState` interface：

```typescript
export interface WorkerTaskState {
  taskId: TaskId
  status: string
  startedAt: string
  title?: string
  abortController: {
    signal: { aborted: boolean }
    abort: () => void
  }
  pendingHumanMessages: ChannelMessage[]
  taskOrigin?: TaskOrigin  // 新增
}
```

- [ ] **Step 2: 在 executeTask 中记录 task_origin**

修改 `src/agent/worker-handler.ts` 中 `executeTask` 方法，在创建 `taskState` 时加入 `taskOrigin`：

```typescript
    const taskState: WorkerTaskState = {
      taskId: task.task_id,
      status: 'executing',
      startedAt: new Date().toISOString(),
      title: task.task_title,
      abortController: new AbortController(),
      pendingHumanMessages: [],
      taskOrigin: context.task_origin,  // 新增
    }
```

- [ ] **Step 3: 新增 barrier 接口和 origin 查询方法**

在 `src/agent/worker-handler.ts` 的 `WorkerHandler` class 中，在 `hasActiveTask` 方法之后添加：

```typescript
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

  getActiveTasksByOrigin(channelId: string, sessionId: string): TaskId[] {
    const result: TaskId[] = []
    for (const [taskId, state] of this.activeTasks) {
      if (
        state.taskOrigin?.channel_id === channelId &&
        state.taskOrigin?.session_id === sessionId
      ) {
        result.push(taskId)
      }
    }
    return result
  }
```

- [ ] **Step 4: 运行现有测试确认无回归**

Run: `cd crabot-agent && npx vitest run tests/agent/worker-handler.test.ts tests/agent/worker-handler-v2.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
cd crabot-agent
git add src/types.ts src/agent/worker-handler.ts
git commit -m "feat(worker): add barrier interface and task origin tracking to WorkerHandler"
```

---

### Task 4: unified-agent 集成 — 私聊 barrier 设置与清除

**Files:**
- Modify: `src/unified-agent.ts`

- [ ] **Step 1: 在 processDirectMessage 的 Front 调用前设置 barrier**

修改 `src/unified-agent.ts` 的 `processDirectMessage` 方法。在 `this.currentMemPerms = memPerms` 之前（步骤 8 的 Front 调用之前），插入 barrier 设置逻辑：

```typescript
      // 7.5 新增：设置 barrier（可能的纠偏消息等待）
      const BARRIER_TIMEOUT_MS = 8000
      const barrierTaskIds = this.workerHandler
        ? this.workerHandler.getActiveTasksByOrigin(
            session.channel_id,
            session.session_id,
          )
        : []

      for (const taskId of barrierTaskIds) {
        this.workerHandler!.setBarrierForTask(taskId, BARRIER_TIMEOUT_MS)
      }
```

- [ ] **Step 2: 在 Front 完成后清除未命中的 barrier**

在 `processDirectMessage` 中，在 步骤 11（写入短期记忆）之前，插入 barrier 清除逻辑：

```typescript
      // 10.5 新增：清除未被 supplement 命中的 barrier
      if (barrierTaskIds.length > 0) {
        const supplementedTaskIds = new Set(
          result.decisions
            .filter((d): d is import('./types.js').SupplementTaskDecision => d.type === 'supplement_task')
            .map(d => d.task_id)
        )
        for (const taskId of barrierTaskIds) {
          if (!supplementedTaskIds.has(taskId)) {
            this.workerHandler?.clearBarrierForTask(taskId)
          }
        }
      }
```

- [ ] **Step 3: 在 catch 中清除所有 barrier**

在 `processDirectMessage` 的 catch block 中（`this.traceStore.endTrace(trace.trace_id, 'failed', ...)` 之前），添加：

```typescript
      // 新增：异常时清除所有 barrier
      for (const taskId of barrierTaskIds) {
        this.workerHandler?.clearBarrierForTask(taskId)
      }
```

注意：`barrierTaskIds` 变量需要在 try 块之前声明并赋值（或提升到 try 块外层）。当前 `processDirectMessage` 的 try 块覆盖了步骤 4-11 的所有代码，所以 `barrierTaskIds` 需要在 try 块内、步骤 7.5 处声明。catch 块访问它需要把声明提到 try 块外：

```typescript
    // 在 try 块外声明
    let barrierTaskIds: string[] = []

    try {
      // ... 步骤 4-7 ...

      // 7.5 设置 barrier
      const BARRIER_TIMEOUT_MS = 8000
      barrierTaskIds = this.workerHandler
        ? this.workerHandler.getActiveTasksByOrigin(session.channel_id, session.session_id)
        : []
      for (const taskId of barrierTaskIds) {
        this.workerHandler!.setBarrierForTask(taskId, BARRIER_TIMEOUT_MS)
      }

      // ... 步骤 8-11 ...

    } catch (error) {
      for (const taskId of barrierTaskIds) {
        this.workerHandler?.clearBarrierForTask(taskId)
      }
      // ... 现有 catch 逻辑 ...
    }
```

- [ ] **Step 4: TypeScript 编译检查**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: 无编译错误

- [ ] **Step 5: 提交**

```bash
cd crabot-agent
git add src/unified-agent.ts
git commit -m "feat(agent): set barrier on matching tasks before Front LLM in private chat"
```

---

### Task 5: unified-agent 集成 — 群聊 @bot barrier 设置与清除

**Files:**
- Modify: `src/unified-agent.ts`

- [ ] **Step 1: 在 processGroupBatch 中添加 barrier 逻辑**

修改 `src/unified-agent.ts` 的 `processGroupBatch` 方法。只在有 @mention 时设置 barrier。

在 try 块外声明：

```typescript
    let barrierTaskIds: string[] = []
```

在 `this.currentMemPerms = memPerms` 之前，判断 hasMention 后设置 barrier：

```typescript
      // 新增：群聊 @bot 场景的 barrier
      const hasMention = buffered.some(b => b.message.features.is_mention_crab)
      if (hasMention && this.workerHandler) {
        const BARRIER_TIMEOUT_MS = 8000
        barrierTaskIds = this.workerHandler.getActiveTasksByOrigin(
          session.channel_id,
          sessionId,
        )
        for (const taskId of barrierTaskIds) {
          this.workerHandler.setBarrierForTask(taskId, BARRIER_TIMEOUT_MS)
        }
      }
```

在决策分发完成后（`this.attentionScheduler.reportResult(sessionId, hasReply)` 之前），清除未命中 barrier：

```typescript
      // 新增：清除未被 supplement 命中的 barrier
      if (barrierTaskIds.length > 0) {
        const supplementedTaskIds = new Set(
          result.decisions
            .filter((d): d is import('./types.js').SupplementTaskDecision => d.type === 'supplement_task')
            .map(d => d.task_id)
        )
        for (const taskId of barrierTaskIds) {
          if (!supplementedTaskIds.has(taskId)) {
            this.workerHandler?.clearBarrierForTask(taskId)
          }
        }
      }
```

在 catch 块中清除所有 barrier：

```typescript
    } catch (error) {
      for (const taskId of barrierTaskIds) {
        this.workerHandler?.clearBarrierForTask(taskId)
      }
      // ... 现有 catch 逻辑 ...
    }
```

- [ ] **Step 2: TypeScript 编译检查**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: 无编译错误

- [ ] **Step 3: 提交**

```bash
cd crabot-agent
git add src/unified-agent.ts
git commit -m "feat(agent): set barrier on matching tasks for group @bot messages"
```

---

### Task 6: 全量测试 + 构建验证

**Files:** 无新增

- [ ] **Step 1: 运行全量测试**

Run: `cd crabot-agent && npx vitest run`
Expected: 所有测试 PASS

- [ ] **Step 2: 构建验证**

Run: `cd crabot-agent && npm run build`
Expected: 构建成功，无错误

- [ ] **Step 3: 提交设计文档和实现计划**

```bash
cd crabot-agent
git add docs/specs/2026-04-14-supplement-barrier-design.md docs/plans/2026-04-14-supplement-barrier.md
git commit -m "docs: supplement barrier design spec and implementation plan"
```
