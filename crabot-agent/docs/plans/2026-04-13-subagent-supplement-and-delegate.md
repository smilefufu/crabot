# Sub-agent 纠偏广播 + 通用委派工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken supplement injection in the engine loop, add broadcast to sub-agents, and add a generic `delegate_task` tool.

**Architecture:** `HumanMessageQueue` is extracted to its own file with parent→child broadcast. `runEngine()` drains the queue between turns and injects as user messages. Sub-agent tools create child queues that auto-receive broadcasts. A new `delegate_task` tool reuses the Worker's own model for generic sub-task delegation.

**Tech Stack:** TypeScript, vitest, existing engine framework (`runEngine`, `createSubAgentTool`, `forkEngine`)

**Design Spec:** `crabot-agent/docs/specs/2026-04-13-subagent-supplement-and-delegate-design.md`

---

### Task 1: Extract HumanMessageQueue with broadcast support

**Files:**
- Create: `crabot-agent/src/engine/human-message-queue.ts`
- Test: `crabot-agent/tests/engine/human-message-queue.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
// crabot-agent/tests/engine/human-message-queue.test.ts
import { describe, it, expect } from 'vitest'
import { HumanMessageQueue } from '../../src/engine/human-message-queue'

describe('HumanMessageQueue', () => {
  describe('basic push/drain', () => {
    it('drainPending returns empty array when no messages', () => {
      const queue = new HumanMessageQueue()
      expect(queue.drainPending()).toEqual([])
    })

    it('drainPending returns all pushed messages and clears queue', () => {
      const queue = new HumanMessageQueue()
      queue.push('msg1')
      queue.push('msg2')
      expect(queue.drainPending()).toEqual(['msg1', 'msg2'])
      expect(queue.drainPending()).toEqual([])
    })

    it('hasPending reflects queue state', () => {
      const queue = new HumanMessageQueue()
      expect(queue.hasPending).toBe(false)
      queue.push('msg')
      expect(queue.hasPending).toBe(true)
      queue.drainPending()
      expect(queue.hasPending).toBe(false)
    })
  })

  describe('dequeue (async)', () => {
    it('dequeue resolves immediately when messages are pending', async () => {
      const queue = new HumanMessageQueue()
      queue.push('msg1')
      const result = await queue.dequeue()
      expect(result).toBe('msg1')
    })

    it('dequeue waits until push is called', async () => {
      const queue = new HumanMessageQueue()
      const promise = queue.dequeue()

      // Push after a tick
      setTimeout(() => queue.push('delayed'), 10)
      const result = await promise
      expect(result).toBe('delayed')
    })
  })

  describe('broadcast to children', () => {
    it('push broadcasts to child queues', () => {
      const parent = new HumanMessageQueue()
      const child = parent.createChild()

      parent.push('broadcast msg')

      expect(child.drainPending()).toEqual(['broadcast msg'])
      // Parent also has the message
      expect(parent.drainPending()).toEqual(['broadcast msg'])
    })

    it('push broadcasts to multiple children', () => {
      const parent = new HumanMessageQueue()
      const child1 = parent.createChild()
      const child2 = parent.createChild()

      parent.push('msg')

      expect(child1.drainPending()).toEqual(['msg'])
      expect(child2.drainPending()).toEqual(['msg'])
    })

    it('removeChild stops broadcast', () => {
      const parent = new HumanMessageQueue()
      const child = parent.createChild()

      parent.removeChild(child)
      parent.push('msg after remove')

      expect(child.drainPending()).toEqual([])
      expect(parent.drainPending()).toEqual(['msg after remove'])
    })

    it('child push does NOT broadcast back to parent', () => {
      const parent = new HumanMessageQueue()
      const child = parent.createChild()

      child.push('child only')

      expect(parent.drainPending()).toEqual([])
      expect(child.drainPending()).toEqual(['child only'])
    })
  })

  describe('createChild with transform', () => {
    it('applies transform function to broadcast messages', () => {
      const parent = new HumanMessageQueue()
      const child = parent.createChild((content) => {
        const text = typeof content === 'string' ? content : '[media]'
        return `[transformed] ${text}`
      })

      parent.push('original msg')

      expect(child.drainPending()).toEqual(['[transformed] original msg'])
      expect(parent.drainPending()).toEqual(['original msg'])
    })

    it('transform receives ContentBlock[] and can convert', () => {
      const parent = new HumanMessageQueue()
      const child = parent.createChild((content) => {
        if (typeof content === 'string') return content
        return '[多媒体纠偏消息]'
      })

      const blocks = [{ type: 'text' as const, text: 'hello' }]
      parent.push(blocks)

      expect(child.drainPending()).toEqual(['[多媒体纠偏消息]'])
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/human-message-queue.test.ts 2>&1 | tail -10`
Expected: FAIL — module not found

- [ ] **Step 3: Implement HumanMessageQueue**

```typescript
// crabot-agent/src/engine/human-message-queue.ts
import type { ContentBlock } from './types'

export type QueueContent = string | ContentBlock[]
export type QueueTransform = (content: QueueContent) => QueueContent

export class HumanMessageQueue {
  private pending: QueueContent[] = []
  private waitResolve: ((value: QueueContent) => void) | null = null
  private children: Set<{ queue: HumanMessageQueue; transform?: QueueTransform }> = new Set()

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
  }

  async dequeue(): Promise<QueueContent> {
    if (this.pending.length > 0) {
      const [first, ...rest] = this.pending
      this.pending = rest
      return first
    }
    return new Promise<QueueContent>((resolve) => {
      this.waitResolve = resolve
    })
  }

  drainPending(): QueueContent[] {
    const drained = this.pending
    this.pending = []
    return drained
  }

  get hasPending(): boolean {
    return this.pending.length > 0
  }

  createChild(transform?: QueueTransform): HumanMessageQueue {
    const child = new HumanMessageQueue()
    const entry = { queue: child, transform }
    this.children = new Set([...this.children, entry])
    return child
  }

  removeChild(child: HumanMessageQueue): void {
    const next = new Set<{ queue: HumanMessageQueue; transform?: QueueTransform }>()
    for (const entry of this.children) {
      if (entry.queue !== child) {
        next.add(entry)
      }
    }
    this.children = next
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/human-message-queue.test.ts 2>&1 | tail -15`
Expected: All tests PASS

- [ ] **Step 5: Export from engine/index.ts**

Add to `crabot-agent/src/engine/index.ts`:

```typescript
// --- Human Message Queue ---
export { HumanMessageQueue } from './human-message-queue'
export type { QueueContent, QueueTransform } from './human-message-queue'
```

- [ ] **Step 6: Commit**

```bash
cd /Users/fufu/codes/playground/crabot && git add crabot-agent/src/engine/human-message-queue.ts crabot-agent/tests/engine/human-message-queue.test.ts crabot-agent/src/engine/index.ts
git commit -m "feat(engine): extract HumanMessageQueue with parent→child broadcast"
```

---

### Task 2: Wire humanMessageQueue consumption into runEngine()

**Files:**
- Modify: `crabot-agent/src/engine/query-loop.ts:137-191`
- Modify: `crabot-agent/src/engine/types.ts:146-148`
- Test: `crabot-agent/tests/engine/query-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `crabot-agent/tests/engine/query-loop.test.ts`:

```typescript
import { HumanMessageQueue } from '../../src/engine/human-message-queue'

describe('runEngine humanMessageQueue integration', () => {
  it('injects supplement messages between turns', async () => {
    const capturedMessages: unknown[][] = []
    let callIndex = 0

    const adapter: LLMAdapter = {
      async *stream(params) {
        capturedMessages.push([...params.messages])

        if (callIndex === 0) {
          // First call: tool use
          for (const chunk of toolUseResponse('tu-1', 'dummy', {})) yield chunk
        } else {
          // Second call: text (should see supplement)
          for (const chunk of textResponse('Adjusted!')) yield chunk
        }
        callIndex++
      },
      updateConfig() {},
    }

    const dummyTool = defineTool({
      name: 'dummy',
      description: 'Dummy tool',
      inputSchema: {},
      isReadOnly: true,
      call: async () => ({ output: 'ok', isError: false }),
    })

    const queue = new HumanMessageQueue()

    // Push supplement BEFORE engine runs (simulates message arriving during tool execution)
    // We push after a small delay to simulate it arriving during tool execution
    const originalCall = dummyTool.call
    const toolWithSupplement = defineTool({
      ...dummyTool,
      call: async (input, ctx) => {
        // Simulate supplement arriving during tool execution
        queue.push('用户补充指示：改变方向')
        return originalCall(input, ctx)
      },
    })

    const result = await runEngine({
      prompt: 'Start task',
      adapter,
      options: baseOptions({
        tools: [toolWithSupplement],
        humanMessageQueue: queue,
      }),
    })

    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('Adjusted!')

    // Second LLM call should have the supplement message
    const secondCallMessages = capturedMessages[1]
    const lastMsg = secondCallMessages[secondCallMessages.length - 1] as { content: string }
    expect(lastMsg.content).toContain('用户补充指示：改变方向')
  })

  it('drains multiple pending supplements in one batch', async () => {
    const capturedMessages: unknown[][] = []
    let callIndex = 0

    const adapter: LLMAdapter = {
      async *stream(params) {
        capturedMessages.push([...params.messages])
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
      isReadOnly: true,
      call: async () => {
        queue.push('supplement 1')
        queue.push('supplement 2')
        return { output: 'ok', isError: false }
      },
    })

    await runEngine({
      prompt: 'Go',
      adapter,
      options: baseOptions({
        tools: [dummyTool],
        humanMessageQueue: queue,
      }),
    })

    // Both supplements should appear in second call's messages
    const secondCallMessages = capturedMessages[1]
    const msgContents = secondCallMessages.map((m: any) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ).join(' ')
    expect(msgContents).toContain('supplement 1')
    expect(msgContents).toContain('supplement 2')
  })

  it('does nothing when humanMessageQueue is undefined', async () => {
    const adapter = mockAdapter([
      toolUseResponse('tu-1', 'dummy', {}),
      textResponse('Done'),
    ])

    const dummyTool = defineTool({
      name: 'dummy',
      description: 'Dummy',
      inputSchema: {},
      isReadOnly: true,
      call: async () => ({ output: 'ok', isError: false }),
    })

    const result = await runEngine({
      prompt: 'Go',
      adapter,
      options: baseOptions({ tools: [dummyTool] }),
    })

    expect(result.outcome).toBe('completed')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/query-loop.test.ts -t "humanMessageQueue" 2>&1 | tail -15`
Expected: FAIL — supplement messages not found in LLM calls

- [ ] **Step 3: Update EngineOptions type**

In `crabot-agent/src/engine/types.ts`, replace lines 146-148:

```typescript
// Old:
  readonly humanMessageQueue?: {
    readonly dequeue: () => Promise<string | ContentBlock[]>
  }

// New:
  readonly humanMessageQueue?: {
    readonly drainPending: () => Array<string | ContentBlock[]>
    readonly hasPending: boolean
  }
```

- [ ] **Step 4: Add supplement injection to runEngine()**

In `crabot-agent/src/engine/query-loop.ts`, after the line `messages.push(createBatchToolResultMessage(processedResults))` (around line 185) and before the `pruneOldImages` call, add:

```typescript
    // Inject any pending human supplement messages
    if (options.humanMessageQueue) {
      const supplements = options.humanMessageQueue.drainPending()
      for (const content of supplements) {
        messages.push(createUserMessage(content))
      }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/query-loop.test.ts 2>&1 | tail -15`
Expected: All tests PASS (both new and existing)

- [ ] **Step 6: Commit**

```bash
cd /Users/fufu/codes/playground/crabot && git add crabot-agent/src/engine/query-loop.ts crabot-agent/src/engine/types.ts crabot-agent/tests/engine/query-loop.test.ts
git commit -m "fix(engine): consume humanMessageQueue between turns in runEngine"
```

---

### Task 3: Update worker-handler.ts to use extracted HumanMessageQueue

**Files:**
- Modify: `crabot-agent/src/agent/worker-handler.ts:170-207`

This task removes the inline `HumanMessageQueue` class from worker-handler.ts and replaces it with the imported one. No behavior change — pure refactor.

- [ ] **Step 1: Replace inline class with import**

In `crabot-agent/src/agent/worker-handler.ts`:

Delete the entire `HumanMessageQueue` class (lines 179-207) and the comment above it (lines 172-178).

Add import at top of file:

```typescript
import { HumanMessageQueue } from '../engine/human-message-queue.js'
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Run existing worker-handler tests**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/agent/worker-handler.test.ts 2>&1 | tail -15`
Expected: All existing tests PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/fufu/codes/playground/crabot && git add crabot-agent/src/agent/worker-handler.ts
git commit -m "refactor(worker): use extracted HumanMessageQueue from engine"
```

---

### Task 4: Add parentHumanQueue to sub-agent tools with child queue lifecycle

**Files:**
- Modify: `crabot-agent/src/engine/sub-agent.ts:83-163`
- Test: `crabot-agent/tests/engine/sub-agent.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `crabot-agent/tests/engine/sub-agent.test.ts`:

```typescript
import { HumanMessageQueue } from '../../src/engine/human-message-queue'

describe('createSubAgentTool with parentHumanQueue', () => {
  it('creates child queue and propagates supplements to sub-agent', async () => {
    const capturedMessages: unknown[][] = []
    let subAgentCallIndex = 0

    // Sub-agent adapter that captures messages
    const subAdapter: LLMAdapter = {
      async *stream(params) {
        capturedMessages.push([...params.messages])
        if (subAgentCallIndex === 0) {
          // First turn: tool use (to trigger a second turn)
          for (const chunk of toolUseResponse('tu-1', 'sub_dummy', {})) yield chunk
        } else {
          // Second turn: should see the supplement
          for (const chunk of textResponse('Adjusted by sub-agent')) yield chunk
        }
        subAgentCallIndex++
      },
      updateConfig() {},
    }

    const subDummy = defineTool({
      name: 'sub_dummy',
      description: 'Sub dummy',
      inputSchema: {},
      isReadOnly: true,
      call: async () => ({ output: 'ok', isError: false }),
    })

    const parentQueue = new HumanMessageQueue()

    const tool = createSubAgentTool({
      name: 'test_delegate',
      description: 'Test delegate',
      adapter: subAdapter,
      model: 'test-model',
      systemPrompt: 'You are a test sub-agent.',
      subTools: [subDummy],
      parentHumanQueue: parentQueue,
    })

    // Simulate: parent pushes supplement while sub-agent is running
    // We inject via the sub_dummy tool call
    const origCall = subDummy.call
    subDummy.call = async (input, ctx) => {
      parentQueue.push('用户补充：换个方向')
      return origCall(input, ctx)
    }

    const result = await tool.call({ task: 'Do something' }, {})

    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.output)
    expect(parsed.output).toBe('Adjusted by sub-agent')

    // Second LLM call should contain the supplement
    expect(capturedMessages.length).toBe(2)
    const secondCallMsgs = capturedMessages[1]
    const allContent = secondCallMsgs.map((m: any) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ).join(' ')
    expect(allContent).toContain('用户补充：换个方向')
  })

  it('removes child queue after sub-agent completes', async () => {
    const adapter = mockAdapter([textResponse('Done')])
    const parentQueue = new HumanMessageQueue()

    const tool = createSubAgentTool({
      name: 'test_delegate',
      description: 'Test',
      adapter,
      model: 'test-model',
      systemPrompt: 'Test.',
      subTools: [],
      parentHumanQueue: parentQueue,
    })

    await tool.call({ task: 'Quick task' }, {})

    // After completion, pushing to parent should NOT broadcast to removed child
    parentQueue.push('after completion')
    // No error, no lingering child — just verifying no throw
    expect(parentQueue.drainPending()).toEqual(['after completion'])
  })

  it('removes child queue even if sub-agent fails', async () => {
    const failAdapter: LLMAdapter = {
      async *stream() {
        throw new Error('LLM crashed')
      },
      updateConfig() {},
    }
    const parentQueue = new HumanMessageQueue()

    const tool = createSubAgentTool({
      name: 'test_delegate',
      description: 'Test',
      adapter: failAdapter,
      model: 'test-model',
      systemPrompt: 'Test.',
      subTools: [],
      parentHumanQueue: parentQueue,
    })

    const result = await tool.call({ task: 'Fail task' }, {})
    expect(result.isError).toBe(true)

    // Child should be cleaned up even after error
    parentQueue.push('after failure')
    expect(parentQueue.drainPending()).toEqual(['after failure'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/sub-agent.test.ts -t "parentHumanQueue" 2>&1 | tail -15`
Expected: FAIL — `parentHumanQueue` is not a known property

- [ ] **Step 3: Add parentHumanQueue to SubAgentToolConfig and ForkEngineParams**

In `crabot-agent/src/engine/sub-agent.ts`:

Add import:

```typescript
import { HumanMessageQueue } from './human-message-queue'
```

Add to `ForkEngineParams` interface (after `supportsVision`):

```typescript
  /** Human message queue for receiving supplements during execution */
  readonly humanMessageQueue?: { readonly drainPending: () => Array<string | ContentBlock[]>; readonly hasPending: boolean }
```

Pass through in `forkEngine()`, inside the `runEngine()` call options:

```typescript
      humanMessageQueue: params.humanMessageQueue,
```

Add to `SubAgentToolConfig` interface (after `supportsVision`):

```typescript
  /** Parent's human message queue — sub-agent will create a child queue */
  readonly parentHumanQueue?: HumanMessageQueue
```

- [ ] **Step 4: Update createSubAgentTool call function**

Replace the `call` function in `createSubAgentTool` (lines 119-161):

```typescript
    call: async (input, callContext) => {
      let childQueue: HumanMessageQueue | undefined
      if (config.parentHumanQueue) {
        childQueue = config.parentHumanQueue.createChild((content) => {
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
        let prompt: string | ReadonlyArray<ContentBlock> = String(input.task)
        const imagePaths = input.image_paths as string[] | undefined
        if (config.supportsVision && imagePaths?.length) {
          const imageBlocks = await resolveImageFromPaths(imagePaths)
          if (imageBlocks.length > 0) {
            prompt = [
              { type: 'text' as const, text: String(input.task) },
              ...imageBlocks,
            ]
          }
        }

        const result = await forkEngine({
          prompt,
          adapter: config.adapter,
          model: config.model,
          systemPrompt: config.systemPrompt,
          tools: config.subTools,
          maxTurns: config.maxTurns,
          parentContext: input.context !== undefined ? String(input.context) : undefined,
          abortSignal: callContext.abortSignal,
          onTurn: config.onSubAgentTurn,
          supportsVision: config.supportsVision,
          humanMessageQueue: childQueue,
        })

        return {
          output: JSON.stringify({
            output: result.output,
            outcome: result.outcome,
            totalTurns: result.totalTurns,
          }),
          isError: result.outcome === 'failed',
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: `Sub-agent error: ${message}`,
          isError: true,
        }
      } finally {
        if (childQueue && config.parentHumanQueue) {
          config.parentHumanQueue.removeChild(childQueue)
        }
      }
    },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/sub-agent.test.ts 2>&1 | tail -15`
Expected: All tests PASS (both new and existing)

- [ ] **Step 6: Commit**

```bash
cd /Users/fufu/codes/playground/crabot && git add crabot-agent/src/engine/sub-agent.ts crabot-agent/tests/engine/sub-agent.test.ts
git commit -m "feat(engine): sub-agent tools create child queue for supplement broadcast"
```

---

### Task 5: Pass parentHumanQueue when registering sub-agent tools in WorkerHandler

**Files:**
- Modify: `crabot-agent/src/agent/worker-handler.ts:363-394`

- [ ] **Step 1: Add parentHumanQueue to all createSubAgentTool calls**

In `crabot-agent/src/agent/worker-handler.ts`, find the sub-agent tool registration loop (around line 365):

```typescript
      // 3f. Sub-agent delegation tools
      const baseTools = [...tools]
      for (const { definition, sdkEnv: subSdkEnv } of this.subAgentConfigs) {
```

In each `createSubAgentTool()` call, add `parentHumanQueue: humanQueue`:

```typescript
        tools.push(createSubAgentTool({
          name: definition.toolName,
          description: definition.toolDescription,
          adapter: subAdapter,
          model: subSdkEnv.modelId,
          systemPrompt: definition.systemPrompt,
          subTools: baseTools,
          maxTurns: definition.maxTurns,
          supportsVision: subSdkEnv.supportsVision,
          parentHumanQueue: humanQueue,
          onSubAgentTurn: traceCallback ? (event) => {
            const spanId = traceCallback.onLlmCallStart(
              event.turnNumber,
              `[${definition.slotKey}] turn ${event.turnNumber}`,
            )
            if (spanId) {
              traceCallback.onLlmCallEnd(spanId, {
                stopReason: event.stopReason ?? undefined,
                outputSummary: event.assistantText.slice(0, 200) || undefined,
                toolCallsCount: event.toolCalls.length > 0 ? event.toolCalls.length : undefined,
              })
            }
          } : undefined,
        }))
```

- [ ] **Step 2: Verify compilation**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /Users/fufu/codes/playground/crabot && git add crabot-agent/src/agent/worker-handler.ts
git commit -m "feat(worker): pass parentHumanQueue to sub-agent tools"
```

---

### Task 6: Add delegate_task generic tool

**Files:**
- Modify: `crabot-agent/src/agent/subagent-prompts.ts`
- Modify: `crabot-agent/src/agent/worker-handler.ts`

- [ ] **Step 1: Add DELEGATE_TASK_SYSTEM_PROMPT to subagent-prompts.ts**

Append after the `SUBAGENT_DEFINITIONS` array:

```typescript
export const DELEGATE_TASK_SYSTEM_PROMPT = [
  '你是一个任务执行助手。你的职责是完成委派给你的子任务并返回清晰的结果。',
  '',
  '## 工作规则',
  '1. 专注于完成委派给你的任务，不要做超出范围的事情',
  '2. 如果任务需要使用工具，直接使用',
  '3. 完成后给出简洁明确的最终结果',
  '4. 如果无法完成任务，说明原因和已完成的部分',
].join('\n')
```

- [ ] **Step 2: Register delegate_task tool in worker-handler.ts**

In `crabot-agent/src/agent/worker-handler.ts`, add import:

```typescript
import { DELEGATE_TASK_SYSTEM_PROMPT } from './subagent-prompts.js'
```

After the sub-agent delegation tools loop (after the `}` closing the `for` loop around line 394), add:

```typescript
      // 3g. Generic delegate_task tool (uses Worker's own model)
      const delegateAdapter = createAdapter({
        endpoint: this.sdkEnv.env.LLM_BASE_URL ?? '',
        apikey: this.sdkEnv.env.LLM_API_KEY ?? '',
        format: this.sdkEnv.format,
      })
      tools.push(createSubAgentTool({
        name: 'delegate_task',
        description: '将子任务委派给一个独立的执行者。执行者在独立上下文中运行，使用与你相同的模型和工具，只返回最终结果。适合：(1) 子任务的中间过程会污染你的上下文 (2) 子任务可以独立完成，不需要你的持续关注',
        adapter: delegateAdapter,
        model: this.sdkEnv.modelId,
        systemPrompt: DELEGATE_TASK_SYSTEM_PROMPT,
        subTools: baseTools,
        maxTurns: 30,
        supportsVision: this.sdkEnv.supportsVision,
        parentHumanQueue: humanQueue,
        onSubAgentTurn: traceCallback ? (event) => {
          const spanId = traceCallback.onLlmCallStart(
            event.turnNumber,
            `[delegate_task] turn ${event.turnNumber}`,
          )
          if (spanId) {
            traceCallback.onLlmCallEnd(spanId, {
              stopReason: event.stopReason ?? undefined,
              outputSummary: event.assistantText.slice(0, 200) || undefined,
              toolCallsCount: event.toolCalls.length > 0 ? event.toolCalls.length : undefined,
            })
          }
        } : undefined,
      }))
```

- [ ] **Step 3: Verify compilation**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
cd /Users/fufu/codes/playground/crabot && git add crabot-agent/src/agent/subagent-prompts.ts crabot-agent/src/agent/worker-handler.ts
git commit -m "feat(worker): add delegate_task generic sub-agent tool"
```

---

### Task 7: Handle consecutive user messages in adapter layer

**Files:**
- Modify: `crabot-agent/src/engine/anthropic-adapter.ts:21-52`
- Test: `crabot-agent/tests/engine/llm-adapter.test.ts`

The Anthropic API requires alternating user/assistant messages. When supplements are injected after tool results, we get consecutive user messages. We need to merge them.

- [ ] **Step 1: Write the failing test**

Add to `crabot-agent/tests/engine/llm-adapter.test.ts`:

```typescript
import { normalizeMessagesForAnthropic } from '../../src/engine/anthropic-adapter'
import { createUserMessage, createBatchToolResultMessage, createAssistantMessage } from '../../src/engine/types'

describe('normalizeMessagesForAnthropic consecutive user merging', () => {
  it('merges consecutive user messages into one', () => {
    const messages = [
      createUserMessage('Hello'),
      createAssistantMessage(
        [{ type: 'tool_use', id: 'tu-1', name: 'dummy', input: {} }],
        'tool_use',
      ),
      createBatchToolResultMessage([{ tool_use_id: 'tu-1', content: 'ok', is_error: false }]),
      createUserMessage('Supplement: change direction'),
    ]

    const normalized = normalizeMessagesForAnthropic(messages)

    // Should be 3 messages: user, assistant, user (merged tool_result + supplement)
    expect(normalized).toHaveLength(3)
    expect(normalized[0].role).toBe('user')
    expect(normalized[1].role).toBe('assistant')
    expect(normalized[2].role).toBe('user')

    // The merged user message should contain both tool_result and text
    const lastMsg = normalized[2]
    const content = lastMsg.content as unknown[]
    expect(content.length).toBeGreaterThanOrEqual(2)
    // First block: tool_result
    expect((content[0] as any).type).toBe('tool_result')
    // Last block: text (the supplement)
    const textBlocks = content.filter((b: any) => b.type === 'text')
    expect(textBlocks.length).toBeGreaterThanOrEqual(1)
    expect((textBlocks[textBlocks.length - 1] as any).text).toContain('Supplement: change direction')
  })

  it('does not merge non-consecutive user messages', () => {
    const messages = [
      createUserMessage('Hello'),
      createAssistantMessage([{ type: 'text', text: 'Hi' }], 'end_turn'),
      createUserMessage('Goodbye'),
    ]

    const normalized = normalizeMessagesForAnthropic(messages)
    expect(normalized).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/llm-adapter.test.ts -t "consecutive" 2>&1 | tail -15`
Expected: FAIL — 4 messages instead of 3

- [ ] **Step 3: Add consecutive user message merging to normalizeMessagesForAnthropic**

In `crabot-agent/src/engine/anthropic-adapter.ts`, replace `normalizeMessagesForAnthropic`:

```typescript
export function normalizeMessagesForAnthropic(messages: ReadonlyArray<EngineMessage>): MessageParam[] {
  const raw = messages.map((msg): MessageParam => {
    if (isToolResultMessage(msg)) {
      return {
        role: 'user',
        content: msg.toolResults.map((tr) => {
          if (tr.images?.length) {
            return {
              type: 'tool_result' as const,
              tool_use_id: tr.tool_use_id,
              is_error: tr.is_error,
              content: [
                ...(tr.content ? [{ type: 'text' as const, text: tr.content }] : []),
                ...tr.images.map((img) => ({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: img.media_type as 'image/png',
                    data: img.data,
                  },
                })),
              ],
            }
          }
          return {
            type: 'tool_result' as const,
            tool_use_id: tr.tool_use_id,
            content: tr.content,
            is_error: tr.is_error,
          }
        }),
      }
    }

    if (msg.role === 'assistant') {
      return {
        role: 'assistant',
        content: msg.content.map((block) => {
          switch (block.type) {
            case 'text':
              return { type: 'text' as const, text: block.text }
            case 'tool_use':
              return {
                type: 'tool_use' as const,
                id: block.id,
                name: block.name,
                input: block.input,
              }
            default:
              return { type: 'text' as const, text: '' }
          }
        }),
      }
    }

    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content }
    }

    const content: Array<TextBlockParam | ImageBlockParam | ToolUseBlockParam | ToolResultBlockParam> =
      msg.content.map((block) => {
        switch (block.type) {
          case 'text':
            return { type: 'text' as const, text: block.text }
          case 'image':
            return {
              type: 'image' as const,
              source: block.source as ImageBlockParam['source'],
            }
          default:
            return { type: 'text' as const, text: '' }
        }
      })
    return { role: 'user', content }
  })

  // Merge consecutive user messages (required by Anthropic API)
  const merged: MessageParam[] = []
  for (const msg of raw) {
    const prev = merged.length > 0 ? merged[merged.length - 1] : undefined
    if (prev && prev.role === 'user' && msg.role === 'user') {
      // Merge: convert both to content arrays and concatenate
      const prevContent = Array.isArray(prev.content)
        ? prev.content
        : [{ type: 'text' as const, text: prev.content }]
      const curContent = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text' as const, text: msg.content }]
      merged[merged.length - 1] = {
        role: 'user',
        content: [...prevContent, ...curContent],
      }
    } else {
      merged.push(msg)
    }
  }
  return merged
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/llm-adapter.test.ts 2>&1 | tail -15`
Expected: All tests PASS

- [ ] **Step 5: Add same merging to OpenAI adapter**

In `crabot-agent/src/engine/openai-adapter.ts`, add the same consecutive-user-merge logic at the end of `normalizeMessagesForOpenAI`. The OpenAI format uses `{ role: 'user', content: string | array }` — merge by concatenating content arrays or joining strings.

- [ ] **Step 6: Run full test suite**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run 2>&1 | tail -20`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/fufu/codes/playground/crabot && git add crabot-agent/src/engine/anthropic-adapter.ts crabot-agent/src/engine/openai-adapter.ts crabot-agent/tests/engine/llm-adapter.test.ts
git commit -m "fix(adapter): merge consecutive user messages for API compatibility"
```

---

### Task 8: Full build verification

**Files:** None (verification only)

- [ ] **Step 1: TypeScript compilation**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 2: Full test suite**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run 2>&1 | tail -30`
Expected: All tests PASS

- [ ] **Step 3: Build**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npm run build 2>&1 | tail -10`
Expected: Build succeeds
