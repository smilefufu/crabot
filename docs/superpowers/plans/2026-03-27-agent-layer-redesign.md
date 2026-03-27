# Agent Layer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Front Handler's CLI-based SDK with direct Anthropic API calls for fast response, and improve Worker Handler with cwd isolation, progress streaming, and correction injection.

**Architecture:** Front Handler v2 uses `@anthropic-ai/sdk` directly (zero cold-start, ~10 controlled tools, structured tool_use decisions). Worker Handler v2 keeps Claude Agent SDK but adds cwd isolation, tool allowlist, progress push, and human message injection. New `supplement_task` decision type enables mid-task corrections.

**Tech Stack:** TypeScript, `@anthropic-ai/sdk` (already in package.json v0.30.1), `@anthropic-ai/claude-agent-sdk` (Worker only), LiteLLM proxy

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `crabot-agent/src/agent/llm-client.ts` | Anthropic SDK wrapper pointing at LiteLLM, used by Front only |
| `crabot-agent/src/agent/front-tools.ts` | Anthropic-format tool definitions for Front (make_decision, query_tasks, create_schedule, crab-messaging tools) |
| `crabot-agent/src/agent/front-loop.ts` | Mini agent loop (<=5 rounds): call LLM, execute tools, return decision |
| `crabot-agent/src/agent/tool-executor.ts` | Execute Front tools by name (dispatches to RPC calls for crab-messaging, local logic for query_tasks/create_schedule) |

### Modified Files

| File | Changes |
|------|---------|
| `crabot-agent/src/types.ts` | Add SupplementTaskDecision, ToolHistoryEntry, FrontLoopResult; extend MessageDecision union; add front_context to CreateTaskDecision |
| `crabot-agent/src/agent/front-handler.ts` | Complete rewrite: remove SDK dependency, use front-loop + llm-client |
| `crabot-agent/src/agent/worker-handler.ts` | Add cwd isolation, allowedTools, settingSources, skills file writing, progress streaming, cleanup |
| `crabot-agent/src/agent/sdk-runner.ts` | Add cwd option, progress callback interface for Worker |
| `crabot-agent/src/orchestration/decision-dispatcher.ts` | Add supplement_task case, confidence-based routing |
| `crabot-agent/src/orchestration/context-assembler.ts` | Enhance active task info (source session, progress summary) |
| `crabot-agent/src/unified-agent.ts` | Update FrontHandler construction (no SDK env needed), wire supplement_task |
| `crabot-agent/prompts.md` | New Front prompt with make_decision instructions, group rules, correction guide |
| `crabot-agent/prompts-worker.md` | New Worker prompt with cwd info, progress instructions |

---

## Phase 1: Front Handler v2

### Task 1: Extend Type System

**Files:**
- Modify: `crabot-agent/src/types.ts`

- [ ] **Step 1: Add SupplementTaskDecision and related types**

Add after `SilentDecision` (line ~532):

```typescript
export interface SupplementTaskDecision {
  type: 'supplement_task'
  task_id: TaskId
  supplement_content: string
  confidence: 'high' | 'low'
  immediate_reply: MessageContent
}
```

- [ ] **Step 2: Add ToolHistoryEntry and FrontLoopResult**

Add in the "Agent 决策类型" section:

```typescript
export interface ToolHistoryEntry {
  tool_name: string
  input_summary: string
  output_summary: string
}

export interface FrontLoopResult {
  decision: MessageDecision
  /** Only set on forced termination (max rounds exceeded) */
  toolHistory?: ToolHistoryEntry[]
}
```

- [ ] **Step 3: Add front_context to CreateTaskDecision**

Change `CreateTaskDecision`:

```typescript
export interface CreateTaskDecision {
  type: 'create_task'
  task_title: string
  task_description: string
  task_type: string
  priority?: string
  preferred_worker_specialization?: string
  immediate_reply: MessageContent
  /** Front loop context, only set on forced termination (max rounds exceeded) */
  front_context?: ToolHistoryEntry[]
}
```

- [ ] **Step 4: Update MessageDecision union**

```typescript
export type MessageDecision =
  | DirectReplyDecision
  | CreateTaskDecision
  | ForwardToWorkerDecision
  | SilentDecision
  | SupplementTaskDecision
```

- [ ] **Step 5: Build and verify**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: No errors (new types are additive, no breakage)

- [ ] **Step 6: Commit**

```bash
git add crabot-agent/src/types.ts
git commit -m "feat(agent): add SupplementTaskDecision, ToolHistoryEntry, FrontLoopResult types"
```

---

### Task 2: Create LLM Client

**Files:**
- Create: `crabot-agent/src/agent/llm-client.ts`

- [ ] **Step 1: Create LLM client wrapper**

```typescript
/**
 * LLM Client - @anthropic-ai/sdk wrapper pointing at LiteLLM
 *
 * Used by Front Handler v2 for direct API calls (no CLI subprocess).
 */

import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool, ContentBlock } from '@anthropic-ai/sdk/resources/messages'

export interface LLMClientConfig {
  endpoint: string   // LiteLLM base URL (without /v1)
  apikey: string
  model: string
  maxTokens?: number
}

export interface LLMCallResult {
  content: ContentBlock[]
  stopReason: string | null
  model: string
  inputTokens: number
  outputTokens: number
}

export class LLMClient {
  private client: Anthropic
  private model: string
  private maxTokens: number

  constructor(config: LLMClientConfig) {
    this.client = new Anthropic({
      baseURL: config.endpoint,
      apiKey: config.apikey || 'dummy-key',
    })
    this.model = config.model
    this.maxTokens = config.maxTokens ?? 16384
  }

  async callMessages(params: {
    system: string
    messages: MessageParam[]
    tools?: Tool[]
  }): Promise<LLMCallResult> {
    const response = await this.client.messages.create({
      model: this.model,
      system: params.system,
      messages: params.messages,
      max_tokens: this.maxTokens,
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
    })

    return {
      content: response.content,
      stopReason: response.stop_reason,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }
  }

  updateConfig(config: Partial<LLMClientConfig>): void {
    if (config.endpoint || config.apikey) {
      this.client = new Anthropic({
        baseURL: config.endpoint ?? this.client.baseURL,
        apiKey: config.apikey ?? this.client.apiKey,
      })
    }
    if (config.model) this.model = config.model
    if (config.maxTokens) this.maxTokens = config.maxTokens
  }
}
```

- [ ] **Step 2: Build and verify**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add crabot-agent/src/agent/llm-client.ts
git commit -m "feat(agent): add LLMClient wrapper for direct Anthropic API calls"
```

---

### Task 3: Create Front Tool Definitions

**Files:**
- Create: `crabot-agent/src/agent/front-tools.ts`

- [ ] **Step 1: Create tool definitions in Anthropic format**

```typescript
/**
 * Front Tools - Anthropic-format tool definitions for Front Handler v2
 *
 * Includes: make_decision, query_tasks, create_schedule,
 * and crab-messaging tools (lookup_friend, list_friends, list_sessions,
 * open_private_session, send_message, get_history)
 */

import type { Tool } from '@anthropic-ai/sdk/resources/messages'

export const MAKE_DECISION_TOOL: Tool = {
  name: 'make_decision',
  description: '做出最终决策。分析完消息后必须调用此工具输出决策。',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['direct_reply', 'create_task', 'supplement_task', 'silent'],
        description: 'direct_reply=直接回复, create_task=创建新任务, supplement_task=补充/纠偏已有任务, silent=静默',
      },
      reply_text: {
        type: 'string',
        description: '回复文本（type=direct_reply 时必填）',
      },
      task_title: { type: 'string', description: '任务标题（type=create_task 时必填）' },
      task_description: { type: 'string', description: '任务详细描述（type=create_task 时必填）' },
      task_type: {
        type: 'string',
        enum: ['general', 'code', 'analysis', 'command'],
        description: '任务类型，默认 general',
      },
      task_id: {
        type: 'string',
        description: '目标任务 ID（type=supplement_task 时必填）',
      },
      supplement_content: {
        type: 'string',
        description: '提炼后的补充/纠偏内容（type=supplement_task 时必填）',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'low'],
        description: 'high=确定是纠偏直接注入, low=不确定需用户确认',
      },
      immediate_reply_text: {
        type: 'string',
        description: '即时回复文本（create_task/supplement_task 时可选）',
      },
    },
    required: ['type'],
  },
}

export const QUERY_TASKS_TOOL: Tool = {
  name: 'query_tasks',
  description: '查询当前活跃的任务列表和状态。用于回答用户关于任务进度的提问。',
  input_schema: {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string',
        description: '按状态过滤：executing, waiting_human, planning, completed, failed',
      },
      channel_id: {
        type: 'string',
        description: '按 Channel 过滤',
      },
    },
    required: [],
  },
}

export const CREATE_SCHEDULE_TOOL: Tool = {
  name: 'create_schedule',
  description: '创建定时任务或提醒。支持一次性和周期性。',
  input_schema: {
    type: 'object' as const,
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

export const LOOKUP_FRIEND_TOOL: Tool = {
  name: 'lookup_friend',
  description: '搜索熟人信息，包括该熟人在哪些 Channel 上有身份。可按名称模糊搜索或按 friend_id 精确查找。',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: '按名称模糊搜索' },
      friend_id: { type: 'string', description: '按 friend_id 精确查找' },
    },
    required: [],
  },
}

export const LIST_FRIENDS_TOOL: Tool = {
  name: 'list_friends',
  description: '列出所有好友，支持分页、搜索和权限过滤。',
  input_schema: {
    type: 'object' as const,
    properties: {
      page: { type: 'number', description: '页码，默认 1' },
      page_size: { type: 'number', description: '每页条数，默认 20' },
      search: { type: 'string', description: '按名称模糊搜索' },
      permission: { type: 'string', enum: ['master', 'normal'], description: '按权限过滤' },
    },
    required: [],
  },
}

export const LIST_SESSIONS_TOOL: Tool = {
  name: 'list_sessions',
  description: '查看指定 Channel 上的会话列表。',
  input_schema: {
    type: 'object' as const,
    properties: {
      channel_id: { type: 'string', description: 'Channel 模块实例 ID' },
      type: { type: 'string', enum: ['private', 'group'], description: '按类型过滤' },
    },
    required: ['channel_id'],
  },
}

export const OPEN_PRIVATE_SESSION_TOOL: Tool = {
  name: 'open_private_session',
  description: '在指定 Channel 上查找或创建与某个熟人的私聊 Session。',
  input_schema: {
    type: 'object' as const,
    properties: {
      channel_id: { type: 'string', description: 'Channel 模块实例 ID' },
      friend_id: { type: 'string', description: '目标熟人 ID' },
    },
    required: ['channel_id', 'friend_id'],
  },
}

export const SEND_MESSAGE_TOOL: Tool = {
  name: 'send_message',
  description: '在指定 Channel 的指定 Session 中发送消息。',
  input_schema: {
    type: 'object' as const,
    properties: {
      channel_id: { type: 'string', description: 'Channel 模块实例 ID' },
      session_id: { type: 'string', description: '目标 Session ID' },
      content: { type: 'string', description: '消息内容' },
      content_type: { type: 'string', enum: ['text', 'image', 'file'], description: '消息类型，默认 text' },
    },
    required: ['channel_id', 'session_id', 'content'],
  },
}

export const GET_HISTORY_TOOL: Tool = {
  name: 'get_history',
  description: '查看指定 Channel 上某个 Session 的历史消息。',
  input_schema: {
    type: 'object' as const,
    properties: {
      channel_id: { type: 'string', description: 'Channel 模块实例 ID' },
      session_id: { type: 'string', description: 'Session ID' },
      keyword: { type: 'string', description: '关键词过滤' },
      limit: { type: 'number', description: '返回条数上限，默认 20' },
      before: { type: 'string', description: '查询此时间之前的消息（ISO 8601）' },
      after: { type: 'string', description: '查询此时间之后的消息（ISO 8601）' },
    },
    required: ['channel_id', 'session_id'],
  },
}

/** All Front tools in order */
export function getAllFrontTools(): Tool[] {
  return [
    MAKE_DECISION_TOOL,
    QUERY_TASKS_TOOL,
    CREATE_SCHEDULE_TOOL,
    LOOKUP_FRIEND_TOOL,
    LIST_FRIENDS_TOOL,
    LIST_SESSIONS_TOOL,
    OPEN_PRIVATE_SESSION_TOOL,
    SEND_MESSAGE_TOOL,
    GET_HISTORY_TOOL,
  ]
}
```

- [ ] **Step 2: Build and verify**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add crabot-agent/src/agent/front-tools.ts
git commit -m "feat(agent): add Anthropic-format tool definitions for Front Handler v2"
```

---

### Task 4: Create Tool Executor

**Files:**
- Create: `crabot-agent/src/agent/tool-executor.ts`

This file dispatches Front tool calls to the correct backend (RPC for crab-messaging, local for query_tasks/create_schedule). It reuses the same RPC logic from `crab-messaging.ts` but returns plain strings instead of MCP content blocks.

- [ ] **Step 1: Create tool executor**

```typescript
/**
 * Tool Executor - Dispatches Front tool calls to backend services
 *
 * crab-messaging tools -> RPC calls to Admin/Channel modules
 * query_tasks -> local activeTasks + Admin RPC
 * create_schedule -> Admin RPC
 */

import type { RpcClient } from '../core/module-base.js'
import type { FriendId, ModuleId } from '../core/base-protocol.js'

export interface ToolExecutorDeps {
  rpcClient: RpcClient
  moduleId: string
  getAdminPort: () => Promise<number>
  resolveChannelPort: (channelId: string) => Promise<number>
  getActiveTasks: () => Array<{
    task_id: string
    status: string
    started_at: string
    title?: string
  }>
}

export interface ToolResult {
  output: string
  isError: boolean
}

interface Friend {
  id: FriendId
  display_name: string
  permission: 'master' | 'normal'
  channel_identities: Array<{
    channel_id: ModuleId
    platform_user_id: string
    platform_display_name?: string
  }>
}

export class ToolExecutor {
  constructor(private deps: ToolExecutorDeps) {}

  async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (toolName) {
        case 'lookup_friend': return await this.lookupFriend(input)
        case 'list_friends': return await this.listFriends(input)
        case 'list_sessions': return await this.listSessions(input)
        case 'open_private_session': return await this.openPrivateSession(input)
        case 'send_message': return await this.sendMessage(input)
        case 'get_history': return await this.getHistory(input)
        case 'query_tasks': return await this.queryTasks(input)
        case 'create_schedule': return await this.createSchedule(input)
        default:
          return { output: JSON.stringify({ error: `Unknown tool: ${toolName}` }), isError: true }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: JSON.stringify({ error: msg }), isError: true }
    }
  }

  private async lookupFriend(input: Record<string, unknown>): Promise<ToolResult> {
    const adminPort = await this.deps.getAdminPort()
    const { rpcClient, moduleId } = this.deps

    if (input.friend_id) {
      const result = await rpcClient.call<{ friend_id: string }, { friend: Friend }>(
        adminPort, 'get_friend', { friend_id: input.friend_id as string }, moduleId,
      )
      return { output: JSON.stringify({ friends: [this.formatFriend(result.friend)] }), isError: false }
    }

    if (input.name) {
      const result = await rpcClient.call<
        { search?: string; pagination?: { page: number; page_size: number } },
        { items: Friend[]; pagination: { total_items: number } }
      >(adminPort, 'list_friends', { search: input.name as string, pagination: { page: 1, page_size: 20 } }, moduleId)
      return { output: JSON.stringify({ friends: result.items.map(f => this.formatFriend(f)) }), isError: false }
    }

    return { output: JSON.stringify({ error: '必须提供 name 或 friend_id' }), isError: true }
  }

  private async listFriends(input: Record<string, unknown>): Promise<ToolResult> {
    const adminPort = await this.deps.getAdminPort()
    const result = await this.deps.rpcClient.call<
      { search?: string; permission?: string; pagination?: { page: number; page_size: number } },
      { items: Friend[]; pagination: { page: number; page_size: number; total_items: number; total_pages: number } }
    >(adminPort, 'list_friends', {
      ...(input.search ? { search: input.search as string } : {}),
      ...(input.permission ? { permission: input.permission as string } : {}),
      pagination: { page: (input.page as number) ?? 1, page_size: (input.page_size as number) ?? 20 },
    }, this.deps.moduleId)
    return {
      output: JSON.stringify({ friends: result.items.map(f => this.formatFriend(f)), pagination: result.pagination }),
      isError: false,
    }
  }

  private async listSessions(input: Record<string, unknown>): Promise<ToolResult> {
    const channelPort = await this.deps.resolveChannelPort(input.channel_id as string)
    const result = await this.deps.rpcClient.call<
      { type?: string },
      { sessions: Array<{ session_id: string; type: string; title: string; participant_count: number }> }
    >(channelPort, 'get_sessions', { type: input.type as string | undefined }, this.deps.moduleId)
    return { output: JSON.stringify(result), isError: false }
  }

  private async openPrivateSession(input: Record<string, unknown>): Promise<ToolResult> {
    const adminPort = await this.deps.getAdminPort()
    const friendResult = await this.deps.rpcClient.call<{ friend_id: string }, { friend: Friend }>(
      adminPort, 'get_friend', { friend_id: input.friend_id as string }, this.deps.moduleId,
    )
    const identity = friendResult.friend.channel_identities.find(ci => ci.channel_id === input.channel_id)
    if (!identity) {
      return {
        output: JSON.stringify({
          error: `熟人在 Channel ${input.channel_id} 上没有身份`,
          available_channels: friendResult.friend.channel_identities.map(ci => ci.channel_id),
        }),
        isError: true,
      }
    }
    const channelPort = await this.deps.resolveChannelPort(input.channel_id as string)
    const result = await this.deps.rpcClient.call<
      { platform_user_id: string }, { session_id: string; created: boolean }
    >(channelPort, 'find_or_create_private_session', { platform_user_id: identity.platform_user_id }, this.deps.moduleId)
    return { output: JSON.stringify(result), isError: false }
  }

  private async sendMessage(input: Record<string, unknown>): Promise<ToolResult> {
    const channelPort = await this.deps.resolveChannelPort(input.channel_id as string)
    const result = await this.deps.rpcClient.call<
      { session_id: string; content: { type: string; text?: string } },
      { platform_message_id: string; sent_at: string }
    >(channelPort, 'send_message', {
      session_id: input.session_id as string,
      content: { type: (input.content_type as string) ?? 'text', text: input.content as string },
    }, this.deps.moduleId)
    return { output: JSON.stringify(result), isError: false }
  }

  private async getHistory(input: Record<string, unknown>): Promise<ToolResult> {
    const channelPort = await this.deps.resolveChannelPort(input.channel_id as string)
    const timeRange = (input.before || input.after)
      ? { before: input.before as string | undefined, after: input.after as string | undefined }
      : undefined
    const result = await this.deps.rpcClient.call<
      { session_id: string; time_range?: { before?: string; after?: string }; keyword?: string; limit?: number },
      { items: Array<{ platform_message_id: string; sender_name: string; content: string; content_type: string; timestamp: string }> }
    >(channelPort, 'get_history', {
      session_id: input.session_id as string,
      ...(timeRange ? { time_range: timeRange } : {}),
      ...(input.keyword ? { keyword: input.keyword as string } : {}),
      limit: (input.limit as number) ?? 20,
    }, this.deps.moduleId)
    return { output: JSON.stringify({ messages: result.items ?? [] }), isError: false }
  }

  private async queryTasks(input: Record<string, unknown>): Promise<ToolResult> {
    const localTasks = this.deps.getActiveTasks()
    const adminPort = await this.deps.getAdminPort()
    const adminResult = await this.deps.rpcClient.call<
      { status?: string[]; channel_id?: string },
      { tasks: Array<{ task_id: string; title: string; status: string; task_type: string }> }
    >(adminPort, 'query_tasks', {
      status: input.status ? [input.status as string] : ['executing', 'waiting_human', 'planning'],
      ...(input.channel_id ? { channel_id: input.channel_id as string } : {}),
    }, this.deps.moduleId)
    return {
      output: JSON.stringify({ local_active: localTasks, admin_tasks: adminResult.tasks }),
      isError: false,
    }
  }

  private async createSchedule(input: Record<string, unknown>): Promise<ToolResult> {
    const adminPort = await this.deps.getAdminPort()
    const result = await this.deps.rpcClient.call(adminPort, 'create_schedule', {
      title: input.title,
      description: input.description,
      trigger_at: input.trigger_at,
      cron: input.cron,
      action: input.action,
      target_channel_id: input.target_channel_id,
      target_session_id: input.target_session_id,
    }, this.deps.moduleId)
    return { output: JSON.stringify(result), isError: false }
  }

  private formatFriend(f: Friend) {
    return {
      friend_id: f.id,
      display_name: f.display_name,
      permission: f.permission,
      channels: f.channel_identities.map(ci => ({
        channel_id: ci.channel_id,
        platform_user_id: ci.platform_user_id,
        platform_display_name: ci.platform_display_name ?? ci.platform_user_id,
      })),
    }
  }
}
```

- [ ] **Step 2: Build and verify**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add crabot-agent/src/agent/tool-executor.ts
git commit -m "feat(agent): add ToolExecutor for Front Handler v2 tool dispatch"
```

---

### Task 5: Create Front Loop

**Files:**
- Create: `crabot-agent/src/agent/front-loop.ts`

- [ ] **Step 1: Create the mini agent loop**

```typescript
/**
 * Front Loop - Mini agent loop for Front Handler v2
 *
 * <=5 rounds: call LLM -> if tool_use, execute -> loop
 * make_decision tool -> structured decision, return immediately
 * end_turn -> wrap as direct_reply
 * max rounds exceeded -> forced create_task with tool history
 */

import type { MessageParam, ContentBlock, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages'
import type { LLMClient } from './llm-client.js'
import type { ToolExecutor, ToolResult } from './tool-executor.js'
import type {
  MessageDecision,
  ToolHistoryEntry,
  FrontLoopResult,
  MessageContent,
  TraceCallback,
} from '../types.js'
import { getAllFrontTools } from './front-tools.js'

const FRONT_MAX_ROUNDS = 5

export async function runFrontLoop(params: {
  systemPrompt: string
  userMessage: string
  llmClient: LLMClient
  toolExecutor: ToolExecutor
  traceCallback?: TraceCallback
}): Promise<FrontLoopResult> {
  const { systemPrompt, userMessage, llmClient, toolExecutor, traceCallback } = params
  const tools = getAllFrontTools()
  const messages: MessageParam[] = [{ role: 'user', content: userMessage }]
  const toolHistory: ToolHistoryEntry[] = []

  const loopSpanId = traceCallback?.onLoopStart('front', {
    system_prompt: systemPrompt,
    model: undefined,
    tools: tools.map(t => t.name),
  })

  try {
    for (let round = 0; round < FRONT_MAX_ROUNDS; round++) {
      const inputSummary = round === 0 ? userMessage.slice(0, 150) : `(round ${round + 1})`
      const llmSpanId = traceCallback?.onLlmCallStart(round + 1, inputSummary)

      const response = await llmClient.callMessages({ system: systemPrompt, messages, tools })

      // Trace: record LLM response
      let textOutput = ''
      let toolUseCount = 0
      for (const block of response.content) {
        if (block.type === 'text') textOutput += block.text
        if (block.type === 'tool_use') toolUseCount++
      }
      if (llmSpanId) {
        traceCallback?.onLlmCallEnd(llmSpanId, {
          stopReason: response.stopReason ?? undefined,
          outputSummary: textOutput.slice(0, 200) || undefined,
          toolCallsCount: toolUseCount > 0 ? toolUseCount : undefined,
        })
      }

      // Case 1: end_turn -> wrap text as direct_reply
      if (response.stopReason === 'end_turn') {
        const text = response.content
          .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
          .map(b => b.text)
          .join('')
          .trim()

        const decision: MessageDecision = text
          ? { type: 'direct_reply', reply: { type: 'text', text } }
          : { type: 'silent' }

        if (loopSpanId) traceCallback?.onLoopEnd(loopSpanId, 'completed', round + 1)
        return { decision }
      }

      // Case 2: tool_use
      if (response.stopReason === 'tool_use') {
        messages.push({ role: 'assistant', content: response.content as MessageParam['content'] })

        const toolResults: ToolResultBlockParam[] = []

        for (const block of response.content) {
          if (block.type !== 'tool_use') continue

          // make_decision -> return structured decision immediately
          if (block.name === 'make_decision') {
            const decision = parseMakeDecision(block.input as Record<string, unknown>)

            const toolSpanId = traceCallback?.onToolCallStart('make_decision', JSON.stringify(block.input).slice(0, 200))
            if (toolSpanId) traceCallback?.onToolCallEnd(toolSpanId, `decision: ${decision.type}`)

            if (loopSpanId) traceCallback?.onLoopEnd(loopSpanId, 'completed', round + 1)
            return { decision }
          }

          // Other tools -> execute
          const toolSpanId = traceCallback?.onToolCallStart(block.name, JSON.stringify(block.input).slice(0, 200))
          const result = await toolExecutor.execute(block.name, block.input as Record<string, unknown>)

          if (toolSpanId) {
            traceCallback?.onToolCallEnd(toolSpanId, result.output.slice(0, 200), result.isError ? result.output : undefined)
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.output,
            is_error: result.isError,
          })

          if (!result.isError) {
            toolHistory.push({
              tool_name: block.name,
              input_summary: JSON.stringify(block.input).slice(0, 200),
              output_summary: result.output.slice(0, 500),
            })
          }
        }

        messages.push({ role: 'user', content: toolResults })
      }
    }

    // Max rounds exceeded -> forced create_task with tool history
    const taskTitle = extractTaskTitle(messages)
    const taskDescription = extractTaskDescription(messages)

    if (loopSpanId) traceCallback?.onLoopEnd(loopSpanId, 'completed', FRONT_MAX_ROUNDS)

    return {
      decision: {
        type: 'create_task',
        task_title: taskTitle,
        task_description: taskDescription,
        task_type: 'general',
        immediate_reply: { type: 'text', text: '问题比较复杂，我安排深度处理，请稍等...' },
        front_context: toolHistory.length > 0 ? toolHistory : undefined,
      },
      toolHistory: toolHistory.length > 0 ? toolHistory : undefined,
    }
  } catch (error) {
    if (loopSpanId) traceCallback?.onLoopEnd(loopSpanId, 'failed', 0)
    throw error
  }
}

function parseMakeDecision(input: Record<string, unknown>): MessageDecision {
  const type = input.type as string

  switch (type) {
    case 'direct_reply':
      return {
        type: 'direct_reply',
        reply: { type: 'text', text: (input.reply_text as string) ?? '' },
      }

    case 'create_task':
      return {
        type: 'create_task',
        task_title: (input.task_title as string) ?? '未命名任务',
        task_description: (input.task_description as string) ?? '',
        task_type: (input.task_type as string) ?? 'general',
        immediate_reply: {
          type: 'text',
          text: (input.immediate_reply_text as string) ?? '好的，我来处理这个任务，请稍等...',
        },
      }

    case 'supplement_task':
      return {
        type: 'supplement_task',
        task_id: (input.task_id as string) ?? '',
        supplement_content: (input.supplement_content as string) ?? '',
        confidence: (input.confidence as 'high' | 'low') ?? 'low',
        immediate_reply: {
          type: 'text',
          text: (input.immediate_reply_text as string) ?? '好的，我已将您的补充发送给正在执行的任务。',
        },
      }

    case 'silent':
      return { type: 'silent' }

    default:
      return { type: 'direct_reply', reply: { type: 'text', text: '未知的决策类型' } }
  }
}

function extractTaskTitle(messages: MessageParam[]): string {
  const firstUser = messages.find(m => m.role === 'user')
  if (!firstUser || typeof firstUser.content !== 'string') return '用户请求'
  const text = firstUser.content.trim()
  return text.length > 80 ? text.slice(0, 80) + '...' : text
}

function extractTaskDescription(messages: MessageParam[]): string {
  const firstUser = messages.find(m => m.role === 'user')
  if (!firstUser || typeof firstUser.content !== 'string') return ''
  return firstUser.content
}
```

- [ ] **Step 2: Build and verify**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add crabot-agent/src/agent/front-loop.ts
git commit -m "feat(agent): add mini agent loop for Front Handler v2"
```

---

### Task 6: Rewrite Front Handler

**Files:**
- Modify: `crabot-agent/src/agent/front-handler.ts`

- [ ] **Step 1: Replace entire front-handler.ts**

```typescript
/**
 * Front Handler v2 - Fast triage using direct Anthropic API
 *
 * Replaces SDK-based implementation. Zero cold-start, ~10 controlled tools,
 * structured tool_use decisions via make_decision.
 */

import { LLMClient, type LLMClientConfig } from './llm-client.js'
import { ToolExecutor, type ToolExecutorDeps } from './tool-executor.js'
import { runFrontLoop } from './front-loop.js'
import type {
  ChannelMessage,
  FrontAgentContext,
  HandleMessageParams,
  HandleMessageResult,
  TraceCallback,
} from '../types.js'
import * as fs from 'fs'
import * as path from 'path'

const PROMPTS_FILE = path.join(process.cwd(), 'prompts.md')

const DEFAULT_SYSTEM_PROMPT = `你是 Crabot 的分诊员，负责快速分析消息并做出决策。

## 决策输出

你必须调用 make_decision 工具输出决策。四种类型：

1. direct_reply — 直接回复（简单问答、问候、任务状态查询）
2. create_task — 创建新任务（复杂操作、代码编写、数据分析）
3. supplement_task — 补充/纠偏已有任务（用户对正在执行的任务有新指示）
4. silent — 静默（群聊中与自己无关的消息）

## 群聊规则

在群聊中，默认 silent。只有以下情况才回复：
1. 消息标注了 [@你]
2. 结合上下文，消息明显是向你提问
3. 你正在跟进一个活跃任务，用户在追问进展

不满足以上任何条件 -> silent。

## 纠偏判断指南

当用户消息可能是对活跃任务的纠偏时：
- 检查活跃任务列表，优先匹配同 session 发起的任务
- 如果只有一个匹配任务且语义明确 -> confidence: high
- 如果有多个匹配任务或语义模糊 -> confidence: low
- 如果没有活跃任务或消息明显是新请求 -> create_task

## 判断标准

- 能在 1-2 步工具调用内完成 -> direct_reply
- 需要多步骤或复杂推理 -> create_task
- 不确定时 -> create_task（宁可派给 Worker）`

function loadPrompts(): string {
  try {
    if (fs.existsSync(PROMPTS_FILE)) {
      return fs.readFileSync(PROMPTS_FILE, 'utf-8')
    }
  } catch { /* ignore */ }
  return DEFAULT_SYSTEM_PROMPT
}

export interface FrontHandlerConfig {
  personalityPrompt?: string
}

export class FrontHandler {
  private llmClient: LLMClient
  private toolExecutor: ToolExecutor
  private systemPrompt: string

  constructor(
    llmConfig: LLMClientConfig,
    toolExecutorDeps: ToolExecutorDeps,
    config?: FrontHandlerConfig,
  ) {
    this.llmClient = new LLMClient(llmConfig)
    this.toolExecutor = new ToolExecutor(toolExecutorDeps)

    const routingInstructions = loadPrompts()
    this.systemPrompt = config?.personalityPrompt
      ? `${config.personalityPrompt}\n\n${routingInstructions}`
      : routingInstructions
  }

  async handleMessage(
    params: HandleMessageParams,
    traceCallback?: TraceCallback,
  ): Promise<HandleMessageResult> {
    const { messages, context } = params
    const userMessage = this.buildUserMessage(messages, context)

    try {
      const result = await runFrontLoop({
        systemPrompt: this.systemPrompt,
        userMessage,
        llmClient: this.llmClient,
        toolExecutor: this.toolExecutor,
        traceCallback,
      })

      return { decisions: [result.decision] }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const isGroup = messages[0]?.session?.type === 'group'
      if (isGroup) {
        return { decisions: [{ type: 'silent' }] }
      }
      return {
        decisions: [{ type: 'direct_reply', reply: { type: 'text', text: `AI 服务异常：${msg}` } }],
      }
    }
  }

  updateLlmConfig(config: Partial<LLMClientConfig>): void {
    this.llmClient.updateConfig(config)
  }

  private buildUserMessage(messages: ChannelMessage[], context: FrontAgentContext): string {
    const parts: string[] = []
    parts.push('## 上下文信息')
    parts.push(`- 用户: ${context.sender_friend.display_name}`)
    parts.push(`- 活跃任务数: ${context.active_tasks.length}`)

    if (context.active_tasks.length > 0) {
      parts.push('\n## 活跃任务列表')
      for (const task of context.active_tasks) {
        parts.push(`- [${task.task_id}] "${task.title}" (status: ${task.status}, 类型: ${task.task_type}, 优先级: ${task.priority})`)
        if (task.plan_summary) {
          parts.push(`  计划摘要: ${task.plan_summary}`)
        }
      }
      parts.push('\n当用户询问任务进度时，请根据上述任务列表回答。')
      parts.push('当用户消息可能是对某个任务的纠偏/补充时，使用 supplement_task 决策。')
    }

    if (messages.length > 0) {
      const session = messages[0].session
      parts.push(`- 当前 Channel ID: ${session.channel_id}`)
      parts.push(`- 当前 Session ID: ${session.session_id}`)
      parts.push(`- 会话类型: ${session.type}`)
    }

    if (context.short_term_memories.length > 0) {
      parts.push('\n## 短期记忆（近期对话片段）')
      for (const memory of context.short_term_memories.slice(-3)) {
        const content = memory.content.length > 200 ? memory.content.slice(0, 200) + '...' : memory.content
        parts.push(content)
        parts.push('---')
      }
    }

    if (context.recent_messages.length > 0) {
      parts.push(`\n## 最近消息（共 ${context.recent_messages.length} 条）`)
      for (const msg of context.recent_messages.slice(-10)) {
        const sender = msg.sender.platform_display_name
        const fullText = msg.content.text ?? '[非文本消息]'
        const text = fullText.length > 300 ? fullText.slice(0, 300) + '...[内容截断]' : fullText
        parts.push(`- ${sender}: ${text}`)
      }
    }

    const isGroup = messages[0]?.session?.type === 'group'
    const hasMention = messages.some(m => m.features.is_mention_crab)

    if (isGroup) {
      parts.push(`\n## 当前群聊消息批次（共 ${messages.length} 条）`)
      parts.push(`- 是否 @你: ${hasMention ? '是' : '否'}`)
      for (const msg of messages) {
        const mention = msg.features.is_mention_crab ? ' [@你]' : ''
        parts.push(`- [${msg.sender.platform_display_name}]${mention}: ${msg.content.text ?? '[非文本消息]'}`)
      }
    } else {
      parts.push('\n## 当前消息')
      for (const msg of messages) {
        parts.push(`- ${msg.sender.platform_display_name}: ${msg.content.text ?? '[非文本消息]'}`)
      }
    }

    parts.push('\n## 指令')
    parts.push('请分析上述消息并调用 make_decision 工具输出决策。')
    return parts.join('\n')
  }
}
```

- [ ] **Step 2: Build and verify**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: Errors in `unified-agent.ts` due to changed FrontHandler constructor — will fix in Task 7.

- [ ] **Step 3: Commit**

```bash
git add crabot-agent/src/agent/front-handler.ts
git commit -m "feat(agent): rewrite FrontHandler v2 with direct API calls"
```

---

### Task 7: Update unified-agent.ts for Front Handler v2

**Files:**
- Modify: `crabot-agent/src/unified-agent.ts`

- [ ] **Step 1: Update imports**

Replace `SdkEnvConfig` import from front-handler with new types:

```typescript
// Remove this import:
import { FrontHandler, type SdkEnvConfig } from './agent/front-handler.js'

// Add this import:
import { FrontHandler } from './agent/front-handler.js'
import type { LLMClientConfig } from './agent/llm-client.js'
import type { ToolExecutorDeps } from './agent/tool-executor.js'
```

- [ ] **Step 2: Update initializeAgentLayer — Front section**

Replace the Front handler initialization block (around line 196-205):

```typescript
    // 初始化 Front Handler（如果有 front 角色）
    if (this.roles.has('front')) {
      const frontModelConfig = config.model_config?.fast ?? config.model_config?.default
      if (frontModelConfig) {
        const llmConfig: LLMClientConfig = {
          endpoint: frontModelConfig.endpoint,
          apikey: frontModelConfig.apikey,
          model: frontModelConfig.model_id,
        }
        const toolExecutorDeps: ToolExecutorDeps = {
          rpcClient: this.rpcClient,
          moduleId: this.config.moduleId,
          getAdminPort: () => this.getAdminPort(),
          resolveChannelPort: (channelId) => this.getChannelPort(channelId),
          getActiveTasks: () => this.getActiveTasksList(),
        }
        this.frontHandler = new FrontHandler(llmConfig, toolExecutorDeps, {
          personalityPrompt: personalityPrompt || undefined,
        })
      }
    }
```

- [ ] **Step 3: Add getActiveTasksList helper**

Add near the port resolution methods:

```typescript
  /** Get active tasks list for Front's query_tasks tool */
  private getActiveTasksList(): Array<{ task_id: string; status: string; started_at: string; title?: string }> {
    if (!this.workerHandler) return []
    // WorkerHandler needs to expose active tasks — will be added in Phase 2
    return []
  }
```

- [ ] **Step 4: Update updateLlmClients — Front section**

Replace the Front update block in `updateLlmClients`:

```typescript
    // 更新 Front Agent
    if (this.roles.has('front') && this.frontHandler) {
      const frontConfig = modelConfig.fast ?? modelConfig.default
      if (frontConfig) {
        this.frontHandler.updateLlmConfig({
          endpoint: frontConfig.endpoint,
          apikey: frontConfig.apikey,
          model: frontConfig.model_id,
        })
        console.log(`[${this.config.moduleId}] Front Agent LLM config updated`)
      }
    }
```

- [ ] **Step 5: Remove unused sdkEnvFront field and buildSdkEnv for Front**

Remove `private sdkEnvFront?: SdkEnvConfig` field declaration (keep `sdkEnvWorker`). Remove references to `sdkEnvFront` in the class. Keep `buildSdkEnv` for Worker usage.

- [ ] **Step 6: Build and verify**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: No errors. If there are minor type mismatches, fix them.

- [ ] **Step 7: Commit**

```bash
git add crabot-agent/src/unified-agent.ts
git commit -m "feat(agent): wire FrontHandler v2 into UnifiedAgent"
```

---

### Task 8: Update Front System Prompt

**Files:**
- Modify: `crabot-agent/prompts.md`

- [ ] **Step 1: Replace prompts.md content**

```markdown
# Crabot Front Agent 提示词

此文件为 Front Handler 的可编辑提示词模板。**修改后重启 Agent 生效。**

---

你是 Crabot 的分诊员，负责快速分析消息并做出决策。

## 决策输出

你必须调用 make_decision 工具输出决策。四种类型：

1. **direct_reply** — 直接回复（简单问答、问候、任务状态查询）
2. **create_task** — 创建新任务（复杂操作、代码编写、数据分析、多步骤任务）
3. **supplement_task** — 补充/纠偏已有任务（用户对正在执行的任务有新指示）
4. **silent** — 静默（群聊中与自己无关的消息）

## 你已知道的上下文（无需工具获取）

每次收到消息时，以下信息已经注入到上下文中：
- **最近消息**：当前会话最近消息
- **短期记忆**：与该用户的近期对话摘要
- **活跃任务**：当前正在处理的任务列表

**不要用工具重复获取这些已有的信息。**

## 你可以使用的工具

- **lookup_friend**：搜索熟人信息
- **list_friends**：列出好友列表
- **list_sessions**：查看 Channel 上的会话列表
- **get_history**：查询更早的聊天历史
- **send_message**：发送消息
- **open_private_session**：打开与某人的私聊
- **query_tasks**：查询任务状态
- **create_schedule**：创建定时提醒或周期任务

## 群聊规则（重要）

在群聊（session type: group）中，**默认静默**。只有以下情况才回复：

1. 消息标注了 `[@你]`（is_mention: true）
2. 结合上下文，消息明显是向你（Crabot）提问
3. 你正在跟进一个活跃任务，用户在追问进展

**不满足以上任何条件 -> 输出 silent 决策。**

群聊中的闲聊、成员间讨论、与你无关的对话——全部 silent，不插嘴。

## 纠偏判断指南

当用户消息可能是对活跃任务的补充/纠偏时：
- 检查活跃任务列表，优先匹配同 session 发起的任务
- 如果只有一个匹配任务且语义明确（如"不对，换成 Python"）-> confidence: high
- 如果有多个匹配任务或语义模糊（如"换个方案"）-> confidence: low
- 如果没有活跃任务或消息明显是新请求 -> create_task

## 判断标准

- 能在 1-2 步工具调用内完成 -> direct_reply
- 需要多步骤或复杂推理 -> create_task
- 不确定时 -> create_task（宁可派给 Worker，不要让用户等待）
- 任务进度查询 -> 从活跃任务列表直接回复，或用 query_tasks 工具
- 定时提醒 -> 用 create_schedule 工具
```

- [ ] **Step 2: Commit**

```bash
git add crabot-agent/prompts.md
git commit -m "feat(agent): update Front prompt for v2 make_decision workflow"
```

---

## Phase 2: Worker Handler v2

### Task 9: Update SDK Runner for cwd and Progress

**Files:**
- Modify: `crabot-agent/src/agent/sdk-runner.ts`

- [ ] **Step 1: Add cwd to SdkRunOptions**

In the `SdkRunOptions` interface, add:

```typescript
  /** Working directory for the SDK process */
  cwd?: string
  /** Callback for progress reporting */
  progressCallback?: (summary: string) => Promise<void>
```

- [ ] **Step 2: Pass cwd and settingSources to SDK options**

In the `runSdk` function, update `sdkOptions`:

```typescript
  const sdkOptions: SdkOptions = {
    systemPrompt,
    model,
    env: cleanEnv,
    maxTurns,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    // Only load project settings (Admin-managed skills), not user settings
    settingSources: ['project'],
    thinking: { type: 'disabled' },
    ...(claudePath && { pathToClaudeCodeExecutable: claudePath }),
    ...(cwd && { cwd }),
    ...(mcpServers && { mcpServers }),
    ...(allowedTools && { allowedTools }),
    ...(outputFormat && { outputFormat }),
    ...(abortController && { abortController }),
    stderr: (data: string) => {
      if (data.trim()) log(`stderr: ${data.trim().slice(0, 500)}`)
    },
  }
```

- [ ] **Step 3: Add progress reporting in event loop**

In the `for await (const message of stream)` loop, after the `assistant` case:

```typescript
        case 'assistant': {
          // ... existing code ...
          turnCount++

          // Progress reporting
          if (progressCallback && turnCount > 0) {
            const shouldReport =
              turnCount === 1 || // First turn
              turnCount % 3 === 0 || // Every 3 turns
              (Date.now() - lastProgressTime) > 30_000 // 30s timeout

            if (shouldReport) {
              const summary = turnText.slice(0, 200) || `执行中 (第 ${turnCount} 轮)`
              try { await progressCallback(summary) } catch { /* ignore */ }
              lastProgressTime = Date.now()
            }
          }
          break
        }
```

Add `let lastProgressTime = Date.now()` before the try block, and destructure `progressCallback` from options.

- [ ] **Step 4: Build and verify**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add crabot-agent/src/agent/sdk-runner.ts
git commit -m "feat(agent): add cwd, settingSources, and progress callback to SDK runner"
```

---

### Task 10: Rewrite Worker Handler

**Files:**
- Modify: `crabot-agent/src/agent/worker-handler.ts`

- [ ] **Step 1: Add cwd isolation, allowedTools, skills, progress, cleanup**

Key changes to `executeTask`:

```typescript
  private static readonly WORKER_ALLOWED_TOOLS = [
    'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'Skill',
    'mcp__crab-messaging__lookup_friend',
    'mcp__crab-messaging__list_friends',
    'mcp__crab-messaging__list_sessions',
    'mcp__crab-messaging__open_private_session',
    'mcp__crab-messaging__send_message',
    'mcp__crab-messaging__get_history',
    'mcp__crabot-worker__ask_human',
  ]

  async executeTask(
    params: ExecuteTaskParams & { skills?: Array<{ id: string; name: string; content: string }> },
    traceCallback?: TraceCallback,
  ): Promise<ExecuteTaskResult> {
    const { task, context } = params
    const taskDir = `/tmp/crabot-task-${task.task_id}`
    const abortController = new AbortController()

    // Create isolated working directory
    await fs.promises.mkdir(taskDir, { recursive: true })

    // Write Admin-managed skills to task directory
    if (params.skills && params.skills.length > 0) {
      const skillsDir = path.join(taskDir, '.claude', 'skills')
      await fs.promises.mkdir(skillsDir, { recursive: true })
      for (const skill of params.skills) {
        const skillDir = path.join(skillsDir, skill.id)
        await fs.promises.mkdir(skillDir, { recursive: true })
        await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), skill.content)
      }
    }

    const taskState: WorkerTaskState = {
      taskId: task.task_id,
      status: 'executing',
      startedAt: new Date().toISOString(),
      abortController,
      pendingHumanMessages: [],
      title: task.task_title,
    }
    this.activeTasks.set(task.task_id, taskState)

    try {
      const taskMessage = this.buildTaskMessage(task, context)

      // Build progress callback
      const progressCallback = context.task_origin
        ? async (summary: string) => {
            await this.sendProgress(context.task_origin!, task.task_title, summary)
          }
        : undefined

      // ... (rest of SDK setup with mcpServers)

      const sdkOpts: SdkRunOptions = {
        prompt: taskMessage,
        systemPrompt: this.buildSystemPrompt(context),
        model: this.sdkEnv.modelId,
        env: this.sdkEnv.env,
        cwd: taskDir,
        ...(this.config.maxIterations !== undefined && { maxTurns: this.config.maxIterations }),
        loopLabel: 'worker',
        mcpServers,
        allowedTools: [
          ...WorkerHandler.WORKER_ALLOWED_TOOLS,
          ...this.getExternalMcpToolNames(),
        ],
        abortController,
        traceCallback,
        progressCallback,
      }

      const result = await runSdk(sdkOpts)

      // ... (result handling unchanged)
    } finally {
      this.activeTasks.delete(task.task_id)
      await this.cleanupTaskDir(taskDir)
    }
  }
```

- [ ] **Step 2: Add progress sending method**

```typescript
  private async sendProgress(
    taskOrigin: import('../types.js').TaskOrigin,
    taskTitle: string,
    summary: string,
  ): Promise<void> {
    try {
      const channelPort = await this.resolveChannelPort?.(taskOrigin.channel_id)
      if (!channelPort) return

      await this.rpcClient.call(channelPort, 'send_message', {
        session_id: taskOrigin.session_id,
        content: {
          type: 'text',
          text: `[任务进度] ${taskTitle}\n${summary}`,
        },
      }, this.moduleId)
    } catch { /* ignore progress send failures */ }
  }
```

- [ ] **Step 3: Add cleanup method**

```typescript
  private async cleanupTaskDir(taskDir: string): Promise<void> {
    try {
      const maxRetained = 5
      const { globSync } = await import('glob')
      const tmpDirs = globSync('/tmp/crabot-task-*/')
      if (tmpDirs.length > maxRetained) {
        const sorted = tmpDirs
          .map(d => ({ path: d, mtime: fs.statSync(d).mtimeMs }))
          .sort((a, b) => a.mtime - b.mtime)
        for (const dir of sorted.slice(0, tmpDirs.length - maxRetained)) {
          await fs.promises.rm(dir.path, { recursive: true, force: true })
        }
      }
    } catch { /* ignore cleanup errors */ }
  }
```

- [ ] **Step 4: Add getActiveTasksForQuery method**

```typescript
  getActiveTasksForQuery(): Array<{ task_id: string; status: string; started_at: string; title?: string }> {
    return Array.from(this.activeTasks.values()).map(t => ({
      task_id: t.taskId,
      status: t.status,
      started_at: t.startedAt,
      title: t.title,
    }))
  }
```

- [ ] **Step 5: Update WorkerHandler constructor to accept RPC deps for progress**

Add `rpcClient`, `moduleId`, and `resolveChannelPort` to constructor params so progress sending can call Channel RPC.

- [ ] **Step 6: Update buildTaskMessage for front_context**

In `buildTaskMessage`, add handling for `front_context`:

```typescript
    if (task.front_context && task.front_context.length > 0) {
      parts.push('\n## Front Agent 已完成的工作')
      parts.push('（以下是 Front 在分诊阶段已获取的信息，请直接使用，不要重复查询）')
      for (const entry of task.front_context) {
        parts.push(`- ${entry.tool_name}: ${entry.output_summary}`)
      }
    }
```

- [ ] **Step 7: Build and verify**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: May have errors in unified-agent.ts due to changed constructor — fix in next step.

- [ ] **Step 8: Update unified-agent.ts Worker initialization**

Update `initializeAgentLayer` Worker section and `updateLlmClients` Worker section to pass new constructor deps. Also update `getActiveTasksList` to delegate to `workerHandler.getActiveTasksForQuery()`.

- [ ] **Step 9: Build and verify**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 10: Commit**

```bash
git add crabot-agent/src/agent/worker-handler.ts crabot-agent/src/agent/sdk-runner.ts crabot-agent/src/unified-agent.ts
git commit -m "feat(agent): WorkerHandler v2 with cwd isolation, allowedTools, progress, cleanup"
```

---

### Task 11: Update Worker System Prompt

**Files:**
- Modify: `crabot-agent/prompts-worker.md`

- [ ] **Step 1: Replace prompts-worker.md**

```markdown
# Crabot Worker Agent 提示词

此文件为 Worker Handler 的可编辑提示词模板。**修改后重启 Agent 生效。**

---

你是 Crabot Worker，负责执行复杂任务。

## 工作目录

你的默认工作目录是临时目录（/tmp/crabot-task-{task_id}/），用于存放任务产生的临时文件。
如果任务涉及特定项目，项目路径会在下方"文件访问路径"段落中列出，请在对应路径下操作。

**重要：不要修改 Crabot 自身的代码目录，除非任务明确要求你操作 Crabot 项目本身。**

## 执行流程

1. 深度分析任务需求，理解用户真实意图
2. 制定清晰的执行计划，按步骤执行
3. 执行过程中如需向用户发送进度更新，使用 send_message 工具
4. 如需用户确认或反馈，调用 ask_human 工具
5. 遇到问题及时调整方案；无法完成时说明原因并给出建议
6. 完成后输出最终结果

## 你已知道的上下文（无需工具获取）

上下文中已预加载（见下方各段落）：
- **最近相关消息**：当前会话最近消息
- **短期记忆**：与该用户的近期对话摘要
- **长期记忆**：通过语义搜索检索到的相关记忆

**不要用工具重复获取这些已有的信息。**

## 通讯工具

- **get_history**：查询当前会话更早的历史
- **send_message**：在任意 Channel/Session 中发送消息
- **lookup_friend**：查找联系人信息
- **list_friends**：列出好友列表
- **list_sessions**：查看 Channel 上的会话列表
- **open_private_session**：打开与某人的私聊

## 注意事项

- 完成任务后直接输出最终结果；结果会自动回复给用户，**不需要额外调用 send_message**
- 如需在执行过程中向用户发送进度更新，可以使用 send_message
- 如果有 Front Agent 已完成的工作（"## Front Agent 已完成的工作"段落），请直接使用那些信息
```

- [ ] **Step 2: Commit**

```bash
git add crabot-agent/prompts-worker.md
git commit -m "feat(agent): update Worker prompt for v2 with cwd and progress guidance"
```

---

## Phase 3: Supplement Decision Chain

### Task 12: Update DecisionDispatcher for supplement_task

**Files:**
- Modify: `crabot-agent/src/orchestration/decision-dispatcher.ts`

- [ ] **Step 1: Add SupplementTaskDecision import**

```typescript
import type {
  MessageDecision,
  DirectReplyDecision,
  CreateTaskDecision,
  ForwardToWorkerDecision,
  SupplementTaskDecision,
  ChannelMessage,
  MemoryPermissions,
} from '../types.js'
```

- [ ] **Step 2: Add supplement_task case to dispatch switch**

```typescript
      case 'supplement_task':
        return this.handleSupplementTask(decision, params, traceCtx)
```

- [ ] **Step 3: Implement handleSupplementTask**

```typescript
  private async handleSupplementTask(
    decision: SupplementTaskDecision,
    params: {
      channel_id: ModuleId
      session_id: string
      admin_chat_callback?: { source_module_id: string; request_id: string }
    },
    traceCtx?: RpcTraceContext,
  ): Promise<{ task_id?: string }> {
    const adminPort = await this.getAdminPort()

    if (decision.confidence === 'low') {
      // Low confidence: ask user to confirm
      const confirmText = await this.buildConfirmationMessage(decision.task_id, adminPort)
      if (params.admin_chat_callback) {
        await this.rpcClient.call(adminPort, 'chat_callback', {
          request_id: params.admin_chat_callback.request_id,
          reply_type: 'direct_reply',
          content: confirmText,
        }, this.moduleId)
      } else {
        const channelPort = await this.getChannelPort(params.channel_id)
        await this.rpcClient.call(channelPort, 'send_message', {
          session_id: params.session_id,
          content: { type: 'text', text: confirmText },
        }, this.moduleId)
      }
      return {}
    }

    // High confidence: inject directly into worker
    // Send immediate reply
    if (decision.immediate_reply?.text) {
      if (params.admin_chat_callback) {
        await this.rpcClient.call(adminPort, 'chat_callback', {
          request_id: params.admin_chat_callback.request_id,
          reply_type: 'direct_reply',
          content: decision.immediate_reply.text,
        }, this.moduleId)
      } else {
        const channelPort = await this.getChannelPort(params.channel_id)
        await this.rpcClient.call(channelPort, 'send_message', {
          session_id: params.session_id,
          content: { type: 'text', text: decision.immediate_reply.text },
        }, this.moduleId)
      }
    }

    // Find the worker handling this task and deliver the supplement
    try {
      const taskInfo = await this.rpcClient.call<
        { task_id: string },
        { task_id: string; status: string; assigned_worker?: string }
      >(adminPort, 'get_task', { task_id: decision.task_id }, this.moduleId)

      if (taskInfo.assigned_worker && ['executing', 'planning'].includes(taskInfo.status)) {
        const workers = await this.rpcClient.resolve(
          { module_id: taskInfo.assigned_worker }, this.moduleId,
        )
        if (workers.length > 0) {
          await this.rpcClient.call(workers[0].port, 'deliver_human_response', {
            task_id: decision.task_id,
            messages: [{
              platform_message_id: `supplement-${Date.now()}`,
              session: { channel_id: params.channel_id, session_id: params.session_id, type: 'private' },
              sender: { friend_id: 'system', platform_user_id: 'system', platform_display_name: 'System' },
              content: { type: 'text', text: `用户补充指示：${decision.supplement_content}` },
              features: { is_mention_crab: false },
              platform_timestamp: new Date().toISOString(),
            }],
          }, this.moduleId)
        }
      }
    } catch (error) {
      console.error(`Failed to deliver supplement to task ${decision.task_id}:`, error instanceof Error ? error.message : error)
    }

    return { task_id: decision.task_id }
  }

  private async buildConfirmationMessage(taskId: string, adminPort: number): Promise<string> {
    try {
      // Query active tasks to build confirmation options
      const result = await this.rpcClient.call<
        { status: string[] },
        { tasks: Array<{ task_id: string; title: string; status: string }> }
      >(adminPort, 'query_tasks', { status: ['executing', 'planning', 'waiting_human'] }, this.moduleId)

      if (result.tasks.length <= 1) {
        return `您是想调整当前正在执行的任务吗？请确认。`
      }

      const options = result.tasks
        .map((t, i) => `${i + 1}. 「${t.title}」(${t.status})`)
        .join('\n')
      return `您想调整哪个任务？\n${options}`
    } catch {
      return `您是想调整任务 ${taskId} 吗？请确认。`
    }
  }
```

- [ ] **Step 4: Build and verify**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add crabot-agent/src/orchestration/decision-dispatcher.ts
git commit -m "feat(agent): add supplement_task handling in DecisionDispatcher"
```

---

### Task 13: Final Integration and Build Verification

**Files:**
- Modify: `crabot-agent/src/unified-agent.ts` (if any remaining wiring needed)

- [ ] **Step 1: Verify supplement_task is handled in unified-agent processDirectMessage and processGroupBatch**

The `processDirectMessage` method iterates `result.decisions` and calls `decisionDispatcher.dispatch()` for each. Since `supplement_task` is now in the `MessageDecision` union and `DecisionDispatcher.dispatch()` handles it, no changes needed in unified-agent.ts for the dispatch path.

Verify by reading the dispatch loop — it should already work.

- [ ] **Step 2: Full build verification**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: Zero errors

- [ ] **Step 3: Full commit**

```bash
git add -A
git commit -m "feat(agent): complete agent layer v2 - Front direct API, Worker isolation, supplement_task"
```

---

## Post-Implementation Verification

After all tasks are complete, manually verify:

1. **Front Handler cold start**: Send a message, measure time from receipt to first LLM call (should be <100ms, no CLI subprocess)
2. **Front tool_use flow**: Send "查一下张三的信息" → should see lookup_friend tool call → make_decision(direct_reply)
3. **Worker cwd**: Create a task, verify `ls /tmp/crabot-task-*` shows the task directory
4. **Worker allowedTools**: Check SDK init log for tool list (should be ~12 tools, not 28)
5. **Worker progress**: Start a multi-step task, verify progress messages arrive in channel
6. **supplement_task**: While Worker is executing, send "换个思路" → verify supplement_task decision
7. **Group chat silent**: Send non-@mention message in group → should be silent (1-3s, not 17-55s)
