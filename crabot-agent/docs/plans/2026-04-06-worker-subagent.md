# Worker Sub-agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Worker to delegate sub-tasks to specialized Sub-agents (vision_expert, coding_expert) that use different models, with context isolation.

**Architecture:** Worker gains a `delegate_to_subagent` tool built on the existing `engine/sub-agent.ts` (`createSubAgentTool` + `forkEngine`). Specialized model slots are declared in `model_roles` with `fallback: "none"` so they're only available when explicitly configured. Admin resolves slots using `model_roles` metadata to apply correct fallback behavior.

**Tech Stack:** TypeScript, existing engine framework (`runEngine`, `createSubAgentTool`, `createAdapter`)

**Design Spec:** `crabot-agent/docs/specs/2026-04-06-worker-subagent-design.md`

---

### Task 1: Add `fallback` field to ModelRoleDefinition (Protocol + Admin types)

**Files:**
- Modify: `crabot-docs/protocols/base-protocol.md` — ModelRoleDefinition section (§5.16)
- Modify: `crabot-admin/src/types.ts:968-979` — `ModelRoleDefinition` interface

- [ ] **Step 1: Update protocol doc**

In `crabot-docs/protocols/base-protocol.md`, find the `ModelRoleDefinition` interface and add the `fallback` field:

```typescript
interface ModelRoleDefinition {
  key: string
  description: string
  required: boolean
  recommended_capabilities?: string[]
  /** 未配置时的回退行为 */
  fallback?: 'global_default' | 'none'  // 默认 'global_default'
}
```

Add a note after the interface:
> - `global_default`（默认）：未显式配置时使用全局默认模型
> - `none`：未显式配置时该 slot 不可用（适用于需要特定能力的专项模型）

- [ ] **Step 2: Update Admin types**

In `crabot-admin/src/types.ts`, add `fallback` to `ModelRoleDefinition`:

```typescript
export interface ModelRoleDefinition {
  /** 角色键 */
  key: string
  /** 角色描述 */
  description: string
  /** 是否必需 */
  required: boolean
  /** 推荐能力 */
  recommended_capabilities?: string[]
  /** 被哪些 Agent 角色使用 */
  used_by?: Array<'front' | 'worker'>
  /** 未配置时的回退行为，默认 'global_default' */
  fallback?: 'global_default' | 'none'
}
```

- [ ] **Step 3: Commit**

```bash
git add crabot-docs/protocols/base-protocol.md crabot-admin/src/types.ts
git commit -m "feat(protocol): add fallback field to ModelRoleDefinition"
```

---

### Task 2: Add new model slots to DEFAULT_IMPLEMENTATION (Admin)

**Files:**
- Modify: `crabot-admin/src/agent-manager.ts:36-58` — `DEFAULT_IMPLEMENTATION.model_roles`

- [ ] **Step 1: Add vision_expert and coding_expert slots**

In `crabot-admin/src/agent-manager.ts`, extend the `model_roles` array in `DEFAULT_IMPLEMENTATION`:

```typescript
const DEFAULT_IMPLEMENTATION: AgentImplementation = {
  // ... existing fields ...
  model_roles: [
    {
      key: 'triage',
      description: '分诊模型，用于 Front Agent 消息意图判断和快速决策',
      required: false,
      recommended_capabilities: ['tool_use', 'fast'],
      used_by: ['front'],
      fallback: 'global_default',
    },
    {
      key: 'worker',
      description: '执行模型，用于 Worker Agent 执行实际任务',
      required: false,
      recommended_capabilities: ['tool_use', 'long_context'],
      used_by: ['worker'],
      fallback: 'global_default',
    },
    {
      key: 'digest',
      description: '摘要模型，用于生成进度汇报摘要（推荐小型快速模型）',
      required: false,
      recommended_capabilities: ['fast'],
      used_by: ['worker'],
      fallback: 'global_default',
    },
    {
      key: 'vision_expert',
      description: '视觉专家 Sub-agent，用于截图分析、UI 识别、浏览器页面理解',
      required: false,
      recommended_capabilities: ['vision'],
      used_by: ['worker'],
      fallback: 'none',
    },
    {
      key: 'coding_expert',
      description: '编码专家 Sub-agent，用于代码编写、代码分析、bug 修复',
      required: false,
      recommended_capabilities: ['coding', 'tool_use'],
      used_by: ['worker'],
      fallback: 'none',
    },
  ],
  // ... rest of fields ...
}
```

- [ ] **Step 2: Commit**

```bash
git add crabot-admin/src/agent-manager.ts
git commit -m "feat(admin): add vision_expert and coding_expert model slots"
```

---

### Task 3: Update Admin config resolution to respect `fallback` field

**Files:**
- Modify: `crabot-admin/src/index.ts:3185-3260` — `handleGetAgentConfig`

- [ ] **Step 1: Modify handleGetAgentConfig to iterate model_roles with fallback logic**

Replace the current slot resolution loop in `handleGetAgentConfig` (lines 3204-3220) with logic that iterates `model_roles` from the implementation definition:

```typescript
private async handleGetAgentConfig(params: { instance_id: string }): Promise<{
  config: ResolvedAgentConfig
}> {
  const config = this.agentManager.getConfig(params.instance_id)
  if (!config) {
    throw new Error(`Config not found for instance: ${params.instance_id}`)
  }

  // 全局默认 LLM 配置（作为 fallback，未配置时为 null）
  let globalLLM: LLMConnectionInfo | null = null
  try {
    globalLLM = await this.modelProviderManager.resolveModelConfig({
      module_id: params.instance_id,
      role: 'llm',
    }) as LLMConnectionInfo
  } catch {
    // 首次安装时全局 LLM 未配置，允许返回空 model_config
  }

  // 获取实现定义的 model_roles（含 fallback 元数据）
  const impl = this.agentManager.getImplementation('default')
  const modelRoles = impl?.model_roles ?? []

  // 实时解析每个 slot 引用为连接信息，按 model_roles 遍历
  const resolvedModelConfig: Record<string, LLMConnectionInfo> = {}
  for (const role of modelRoles) {
    const ref = config.model_config[role.key]
    if (ref) {
      // 用户显式配置了此 slot
      try {
        resolvedModelConfig[role.key] = this.modelProviderManager.buildConnectionInfo(
          ref.provider_id, ref.model_id
        ) as LLMConnectionInfo
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        // 解析失败：通用 slot fallback 到全局默认，专项 slot 跳过
        const fallback = role.fallback ?? 'global_default'
        if (fallback === 'global_default' && globalLLM) {
          console.warn(`[Admin] Slot "${role.key}" ref resolve failed: ${msg}, using global default`)
          resolvedModelConfig[role.key] = globalLLM
        } else {
          console.warn(`[Admin] Slot "${role.key}" ref resolve failed: ${msg}, slot unavailable`)
        }
      }
    } else {
      // 用户未配置此 slot：根据 fallback 策略决定
      const fallback = role.fallback ?? 'global_default'
      if (fallback === 'global_default' && globalLLM) {
        resolvedModelConfig[role.key] = globalLLM
      }
      // fallback === 'none' → 不加入 resolvedModelConfig
    }
  }

  // ... rest unchanged (MCP servers, skills resolution) ...
```

Note: also handle any explicitly configured slots NOT in model_roles (forward compatibility):

```typescript
  // 处理用户配置了但不在 model_roles 中的 slot（向前兼容）
  for (const [key, ref] of Object.entries(config.model_config)) {
    if (resolvedModelConfig[key]) continue  // 已处理
    try {
      resolvedModelConfig[key] = this.modelProviderManager.buildConnectionInfo(
        ref.provider_id, ref.model_id
      ) as LLMConnectionInfo
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (globalLLM) {
        resolvedModelConfig[key] = globalLLM
      } else {
        console.warn(`[Admin] Unknown slot "${key}" resolve failed: ${msg}`)
      }
    }
  }
```

- [ ] **Step 2: Verify existing tests still pass**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-admin && npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All existing tests pass

- [ ] **Step 3: Commit**

```bash
git add crabot-admin/src/index.ts
git commit -m "feat(admin): resolve model slots using model_roles fallback strategy"
```

---

### Task 4: Extend Agent-side types and LLM requirements

**Files:**
- Modify: `crabot-agent/src/types.ts:432-441` — `LLMRoleRequirement` interface

- [ ] **Step 1: Widen the key type and add fallback**

In `crabot-agent/src/types.ts`, change `LLMRoleRequirement`:

```typescript
/**
 * LLM 模型角色配置需求
 */
export interface LLMRoleRequirement {
  /** 配置 key */
  key: string
  /** 描述说明 */
  description: string
  /** 是否必须 */
  required: boolean
  /** 使用该模型的角色 */
  used_by: Array<'front' | 'worker'>
  /** 推荐能力 */
  recommended_capabilities?: string[]
  /** 未配置时的回退行为，默认 'global_default' */
  fallback?: 'global_default' | 'none'
}
```

Key change: `key` type widened from `'triage' | 'worker' | 'digest'` to `string`.

- [ ] **Step 2: Commit**

```bash
git add crabot-agent/src/types.ts
git commit -m "feat(agent): extend LLMRoleRequirement for sub-agent slots"
```

---

### Task 5: Update handleGetLLMRequirements to declare new slots

**Files:**
- Modify: `crabot-agent/src/unified-agent.ts:1461-1491` — `handleGetLLMRequirements`

- [ ] **Step 1: Add vision_expert and coding_expert to requirements**

```typescript
private handleGetLLMRequirements(): {
  model_format: string
  requirements: LLMRoleRequirement[]
} {
  return {
    model_format: 'anthropic',
    requirements: [
      {
        key: 'triage',
        description: '分诊模型，用于 Front Agent 消息意图判断和快速决策（可选）',
        required: false,
        used_by: ['front'],
        fallback: 'global_default',
      },
      {
        key: 'worker',
        description: '执行模型，用于 Worker Agent 执行实际任务（可选）',
        required: false,
        used_by: ['worker'],
        fallback: 'global_default',
      },
      {
        key: 'digest',
        description: '摘要模型，用于生成进度汇报摘要（可选，推荐小型快速模型）',
        required: false,
        used_by: ['worker'],
        fallback: 'global_default',
      },
      {
        key: 'vision_expert',
        description: '视觉专家 Sub-agent，用于截图分析、UI 识别、浏览器页面理解（可选）',
        required: false,
        used_by: ['worker'],
        recommended_capabilities: ['vision'],
        fallback: 'none',
      },
      {
        key: 'coding_expert',
        description: '编码专家 Sub-agent，用于代码编写、代码分析、bug 修复（可选）',
        required: false,
        used_by: ['worker'],
        recommended_capabilities: ['coding', 'tool_use'],
        fallback: 'none',
      },
    ],
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add crabot-agent/src/unified-agent.ts
git commit -m "feat(agent): declare vision_expert and coding_expert model slots"
```

---

### Task 6: Create Sub-agent prompt templates

**Files:**
- Create: `crabot-agent/src/agent/subagent-prompts.ts`

- [ ] **Step 1: Create the prompts file**

```typescript
/**
 * Sub-agent system prompt templates.
 *
 * Each key corresponds to a model slot key (e.g. 'vision_expert').
 * Worker uses these when building delegate_to_subagent tools.
 */

export interface SubAgentDefinition {
  /** Model slot key (must match a key in model_config) */
  readonly slotKey: string
  /** Tool name exposed to Worker (prefixed with delegate_to_) */
  readonly toolName: string
  /** Tool description for Worker's LLM */
  readonly toolDescription: string
  /** System prompt for the sub-agent */
  readonly systemPrompt: string
  /** Description shown in Worker's system prompt */
  readonly workerHint: string
  /** Max turns for the sub-agent engine loop */
  readonly maxTurns: number
}

export const SUBAGENT_DEFINITIONS: readonly SubAgentDefinition[] = [
  {
    slotKey: 'vision_expert',
    toolName: 'delegate_to_vision_expert',
    toolDescription: '将视觉分析任务委派给视觉专家 Sub-agent。Sub-agent 在独立上下文中运行，擅长截图分析、UI 识别、浏览器页面理解。只返回最终分析结果。',
    systemPrompt: [
      '你是一个视觉分析专家。你擅长分析图片、截图和 UI 界面。',
      '',
      '## 工作规则',
      '1. 专注于完成委派给你的任务，给出清晰准确的分析结果',
      '2. 描述你看到的内容时要具体和结构化',
      '3. 不要做超出任务范围的事情',
      '4. 如果任务需要使用工具（如截图、点击等），直接使用',
      '5. 完成后给出简洁的最终结论',
    ].join('\n'),
    workerHint: '视觉分析专家，擅长截图分析、UI 识别、浏览器页面理解',
    maxTurns: 20,
  },
  {
    slotKey: 'coding_expert',
    toolName: 'delegate_to_coding_expert',
    toolDescription: '将编码任务委派给编码专家 Sub-agent。Sub-agent 在独立上下文中运行，擅长代码编写、代码分析、bug 修复。只返回最终结果。',
    systemPrompt: [
      '你是一个编码专家。你擅长编写高质量代码、分析代码问题和修复 bug。',
      '',
      '## 工作规则',
      '1. 专注于完成委派给你的任务',
      '2. 给出可直接使用的代码或明确的分析结论',
      '3. 如果需要读取文件或执行命令，直接使用工具',
      '4. 不要做超出任务范围的事情',
      '5. 完成后给出简洁的最终结论和代码',
    ].join('\n'),
    workerHint: '编码专家，擅长代码编写、代码分析、bug 修复',
    maxTurns: 30,
  },
] as const
```

- [ ] **Step 2: Commit**

```bash
git add crabot-agent/src/agent/subagent-prompts.ts
git commit -m "feat(agent): add sub-agent prompt templates"
```

---

### Task 7: Register Sub-agent tools in WorkerHandler

**Files:**
- Modify: `crabot-agent/src/agent/worker-handler.ts` — constructor, executeTask tool registration

This is the core task. WorkerHandler needs to:
1. Accept sub-agent model configs in constructor
2. Build `delegate_to_*` tools using `createSubAgentTool` from `engine/sub-agent.ts`
3. Register them in the tools list during `executeTask`

- [ ] **Step 1: Add subAgentConfigs to constructor**

Add a new constructor parameter after `digestSdkEnv`:

```typescript
constructor(
  sdkEnv: SdkEnvConfig,
  config: WorkerHandlerConfig,
  mcpConfigFactory?: () => Record<string, McpServer>,
  deps?: WorkerDeps,
  builtinToolConfig?: BuiltinToolConfig,
  mcpConnector?: McpConnector,
  digestSdkEnv?: SdkEnvConfig,
  subAgentConfigs?: ReadonlyArray<{ readonly definition: SubAgentDefinition; readonly sdkEnv: SdkEnvConfig }>,
)
```

Store it as an instance field:

```typescript
private readonly subAgentConfigs: ReadonlyArray<{ readonly definition: SubAgentDefinition; readonly sdkEnv: SdkEnvConfig }>

// In constructor body:
this.subAgentConfigs = subAgentConfigs ?? []
```

Add imports at the top of the file:

```typescript
import { createSubAgentTool } from '../engine/sub-agent'
import { createAdapter } from '../engine/llm-adapter'
import type { SubAgentDefinition } from './subagent-prompts'
```

- [ ] **Step 2: Register sub-agent tools in executeTask**

After step 3e (built-in tools) in `executeTask`, add step 3f:

```typescript
    // 3f. Sub-agent delegation tools
    for (const { definition, sdkEnv: subSdkEnv } of this.subAgentConfigs) {
      const subAdapter = createAdapter({
        endpoint: subSdkEnv.env.ANTHROPIC_BASE_URL ?? subSdkEnv.env.ANTHROPIC_API_BASE ?? '',
        apikey: subSdkEnv.env.ANTHROPIC_API_KEY ?? '',
        format: subSdkEnv.format,
      })
      // Sub-agent inherits Worker's tools except delegation tools (prevent recursion)
      const subTools = tools.filter((t) => !t.name.startsWith('delegate_to_'))
      tools.push(createSubAgentTool({
        name: definition.toolName,
        description: definition.toolDescription,
        adapter: subAdapter,
        model: subSdkEnv.modelId,
        systemPrompt: definition.systemPrompt,
        subTools,
        maxTurns: definition.maxTurns,
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
    }
```

- [ ] **Step 3: Verify the file compiles**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors related to worker-handler.ts

- [ ] **Step 4: Commit**

```bash
git add crabot-agent/src/agent/worker-handler.ts
git commit -m "feat(agent): register sub-agent delegation tools in WorkerHandler"
```

---

### Task 8: Wire up sub-agent configs in UnifiedAgent

**Files:**
- Modify: `crabot-agent/src/unified-agent.ts` — `initializeAgentLayer`, `updateLlmClients`, imports

This task connects the model_config slots to the WorkerHandler's sub-agent configs.

- [ ] **Step 1: Add import**

At the top of `unified-agent.ts`, add:

```typescript
import { SUBAGENT_DEFINITIONS } from './agent/subagent-prompts'
```

- [ ] **Step 2: Add helper to build sub-agent configs from model_config**

Add a private method:

```typescript
private buildSubAgentConfigs(
  modelConfig: Record<string, LLMConnectionInfo>
): ReadonlyArray<{ readonly definition: SubAgentDefinition; readonly sdkEnv: SdkEnvConfig }> {
  return SUBAGENT_DEFINITIONS
    .filter((def) => modelConfig[def.slotKey] !== undefined)
    .map((def) => ({
      definition: def,
      sdkEnv: this.buildSdkEnv(modelConfig[def.slotKey]),
    }))
}
```

- [ ] **Step 3: Pass sub-agent configs in initializeAgentLayer**

In `initializeAgentLayer`, where WorkerHandler is constructed, add the `subAgentConfigs` parameter:

```typescript
// After: this.mcpConnector, this.digestSdkEnv
// Add: this.buildSubAgentConfigs(config.model_config)

this.workerHandler = new WorkerHandler(workerSdkEnv, {
  systemPrompt: this.promptManager.assembleWorkerPrompt(adminPersonality || undefined),
  longTermPreloadLimit: this.orchestrationConfig.worker_long_term_memory_limit,
  extra: this.extra,
}, createMcpConfigs, {
  rpcClient: this.rpcClient,
  moduleId: this.config.moduleId,
  resolveChannelPort: (channelId) => this.getChannelPort(channelId),
  getMemoryPort: () => this.getMemoryPort(),
}, config.builtin_tool_config, this.mcpConnector, this.digestSdkEnv,
  this.buildSubAgentConfigs(config.model_config))
```

- [ ] **Step 4: Same change in updateLlmClients**

In `updateLlmClients`, where WorkerHandler is re-created, add the same parameter:

```typescript
this.workerHandler = new WorkerHandler(updatedWorkerSdkEnv, {
  systemPrompt: this.promptManager.assembleWorkerPrompt(adminPersonality || undefined),
  longTermPreloadLimit: this.orchestrationConfig.worker_long_term_memory_limit,
  extra: this.extra,
}, createMcpConfigs, {
  rpcClient: this.rpcClient,
  moduleId: this.config.moduleId,
  resolveChannelPort: (channelId) => this.getChannelPort(channelId),
  getMemoryPort: () => this.getMemoryPort(),
}, this.agentConfig?.builtin_tool_config, this.mcpConnector, this.digestSdkEnv,
  this.buildSubAgentConfigs(modelConfig))
```

- [ ] **Step 5: Verify compilation**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add crabot-agent/src/unified-agent.ts
git commit -m "feat(agent): wire sub-agent model configs into WorkerHandler"
```

---

### Task 9: Inject sub-agent info into Worker system prompt

**Files:**
- Modify: `crabot-agent/src/prompt-manager.ts` — `assembleWorkerPrompt`
- Modify: `crabot-agent/src/unified-agent.ts` — caller of `assembleWorkerPrompt`

- [ ] **Step 1: Extend assembleWorkerPrompt signature**

In `prompt-manager.ts`, add a parameter for available sub-agents:

```typescript
assembleWorkerPrompt(
  adminPersonality?: string,
  availableSubAgents?: ReadonlyArray<{ readonly toolName: string; readonly workerHint: string }>,
): string {
  const parts: string[] = []

  if (adminPersonality) {
    parts.push(adminPersonality)
  }
  const filePersonality = this.readUserFile('personality.md')
  if (filePersonality) {
    parts.push(filePersonality)
  }

  parts.push(this.readRulesFile('worker-rules.md', WORKER_RULES_TEMPLATE))

  // Inject sub-agent awareness
  if (availableSubAgents && availableSubAgents.length > 0) {
    const agentList = availableSubAgents
      .map((a) => `- ${a.toolName}：${a.workerHint}`)
      .join('\n')
    parts.push(
      `## 可用的专项 Sub-agent\n\n` +
      `你可以将子任务委派给以下专项 Sub-agent，它们在独立上下文中执行，只返回最终结果：\n${agentList}\n\n` +
      `适合委派的场景：\n` +
      `1. 你的能力不足以完成某个子任务（如你没有视觉能力但需要分析图片）\n` +
      `2. 子任务的中间过程你不关心，只需要最终结果（避免污染你的上下文）`
    )
  }

  const additions = this.readUserFile('worker-additions.md')
  if (additions) {
    parts.push(additions)
  }

  return parts.join('\n\n')
}
```

- [ ] **Step 2: Update callers in unified-agent.ts**

In `initializeAgentLayer`, where `assembleWorkerPrompt` is called:

```typescript
const subAgentConfigs = this.buildSubAgentConfigs(config.model_config)
const subAgentHints = subAgentConfigs.map(({ definition }) => ({
  toolName: definition.toolName,
  workerHint: definition.workerHint,
}))

this.workerHandler = new WorkerHandler(workerSdkEnv, {
  systemPrompt: this.promptManager.assembleWorkerPrompt(adminPersonality || undefined, subAgentHints),
  // ...
}, /* ... */, subAgentConfigs)
```

Same in `updateLlmClients`:

```typescript
const subAgentConfigs = this.buildSubAgentConfigs(modelConfig)
const subAgentHints = subAgentConfigs.map(({ definition }) => ({
  toolName: definition.toolName,
  workerHint: definition.workerHint,
}))

this.workerHandler = new WorkerHandler(updatedWorkerSdkEnv, {
  systemPrompt: this.promptManager.assembleWorkerPrompt(adminPersonality || undefined, subAgentHints),
  // ...
}, /* ... */, subAgentConfigs)
```

- [ ] **Step 3: Verify compilation**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add crabot-agent/src/prompt-manager.ts crabot-agent/src/unified-agent.ts
git commit -m "feat(agent): inject sub-agent availability into Worker system prompt"
```

---

### Task 10: Update protocol-agent-v2.md with Sub-agent section

**Files:**
- Modify: `crabot-docs/protocols/protocol-agent-v2.md`

- [ ] **Step 1: Add Sub-agent section**

Add a new section to protocol-agent-v2.md (after the Worker execution section):

```markdown
## N. Worker Sub-agent 机制

### N.1 概述

Worker 可以将子任务委派给专项 Sub-agent。每种 Sub-agent 类型对应一个 model slot（声明时 `fallback: "none"`），仅在 Admin 显式配置了对应模型时可用。

Sub-agent 在独立上下文中执行，使用独立的对话历史，只将最终结果返回给 Worker。

### N.2 委派工具

每个可用的 Sub-agent 注册为一个 Worker 工具：

```typescript
// 以 vision_expert 为例
{
  name: "delegate_to_vision_expert",
  description: "将视觉分析任务委派给视觉专家 Sub-agent...",
  input_schema: {
    type: "object",
    properties: {
      task: { type: "string", description: "子任务描述" },
      context: { type: "string", description: "可选的父级上下文" }
    },
    required: ["task"]
  }
}
```

### N.3 执行流程

1. Worker LLM 返回 `tool_use: delegate_to_<type>`
2. Engine 创建独立的 Sub-agent（adapter + 对话历史 + system prompt）
3. Sub-agent 继承 Worker 的工具集（排除 `delegate_to_*` 工具，防止递归）
4. Sub-agent 执行独立的 engine loop
5. 最终文本结果作为 `tool_result` 返回给 Worker

### N.4 可用性规则

- Sub-agent 对应的 model slot 使用 `fallback: "none"`
- 未配置时：工具不注册，Worker 的 system prompt 中不提及
- 已配置时：工具注册，Worker 可自主决定何时委派

### N.5 委派决策

Worker 基于两个维度决定是否委派：
1. **能力维度**：Worker 自身模型不具备某能力（如无视觉），委派给专项 Sub-agent
2. **上下文维度**：子任务中间过程会污染主上下文，委派以保持上下文干净
```

- [ ] **Step 2: Commit**

```bash
git add crabot-docs/protocols/protocol-agent-v2.md
git commit -m "docs(protocol): add Worker Sub-agent mechanism section"
```

---

### Task 11: End-to-end verification

**Files:** None (verification only)

- [ ] **Step 1: Build crabot-admin**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-admin && npm run build 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 2: Build crabot-agent**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npm run build 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 3: Run existing tests**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-admin && npx vitest run 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 4: Verify model_roles appear in Admin UI**

Start dev environment:
```bash
cd /Users/fufu/codes/playground/crabot && ./dev.sh
```

Open Admin UI, go to Agent config page. Verify:
- vision_expert and coding_expert slots appear in the model configuration form
- They show "vision" / "coding" capability hints
- When not configured, they don't have a default model selected

- [ ] **Step 5: Verify Sub-agent tools register when configured**

In Admin UI, configure `vision_expert` slot with a vision-capable model. Then check agent logs:
```bash
node scripts/debug-agent.mjs logs | grep -i subagent
```

Expected: Log entries showing sub-agent tools registered

- [ ] **Step 6: Verify Sub-agent tools NOT registered when unconfigured**

Remove the `vision_expert` slot configuration. Restart agent. Check:
```bash
node scripts/debug-agent.mjs logs | grep -i delegate
```

Expected: No delegation tools registered

---

### Task 12: Admin UI — Sub-agent execution visualization (follow-up)

> **Note:** This task depends on the trace data format emitted by Task 7. It can be implemented as a follow-up after the core mechanism is verified working.

**Files:**
- Modify: `crabot-admin/web/src/` — task detail page components

- [ ] **Step 1: Identify current task detail trace rendering**

Find the component that renders the task execution timeline (trace spans). The sub-agent turns emitted in Task 7 will appear as child spans under the Worker's current span with prefix `[vision_expert]` or `[coding_expert]`.

- [ ] **Step 2: Add collapsible sub-agent group**

In the trace timeline, detect consecutive spans with the same sub-agent prefix and group them into a collapsible node:
- **Collapsed:** Sub-agent type icon + task summary + total turns + total tokens + duration
- **Expanded:** Full span list (each LLM call + tool calls within the sub-agent)

- [ ] **Step 3: Verify in browser**

Configure a vision_expert model, trigger a task that requires visual analysis, then check the task detail page to see the nested sub-agent trace.

- [ ] **Step 4: Commit**

```bash
git add crabot-admin/web/src/
git commit -m "feat(ui): add sub-agent execution visualization in task detail"
```
