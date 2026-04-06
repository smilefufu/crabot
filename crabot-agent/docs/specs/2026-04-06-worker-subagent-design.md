# Worker Sub-agent 设计方案

> 日期：2026-04-06
> 状态：待实现

## 1. 背景与动机

当前 Worker 只能配置一个模型（worker slot），如果该模型擅长编码但没有视觉能力，在 computer-use 等需要视觉的任务中就无法正确执行；反之亦然。

用户可能配置了多个模型，各有所长（如 glm-5 擅长编码、qwen-3.5-plus 有视觉能力）。需要一种机制让 Worker 在执行任务时能利用不同模型的专项能力。

## 2. 核心概念

Worker 可以将子任务委派给 **专项 Sub-agent**。每种 Sub-agent 类型是静态预定义的，但是否可用取决于 Admin 是否为对应 model slot 配置了模型。

### 2.1 角色关系

```
Worker（主 Agent，使用 worker slot 的模型）
  ├─ 自己执行：大部分任务
  ├─ delegate_to_subagent("vision_expert", "分析截图...")
  │    → 视觉 Sub-agent（使用 vision_expert slot 的模型）
  │    → 独立上下文执行 → 返回结果
  └─ delegate_to_subagent("coding_expert", "实现这个函数...")
       → 编码 Sub-agent（使用 coding_expert slot 的模型）
       → 独立上下文执行 → 返回结果
```

### 2.2 委派决策的两个维度

Worker 决定是否委派基于两个独立维度：

1. **能力维度**：Worker 自己的模型不具备某能力（如无视觉），委派给专项 Sub-agent
2. **上下文维度**：即使 Worker 自己能做，但中间过程会污染主上下文，也可以选择委派

### 2.3 可用性规则

- 通用 slot（triage/worker/digest）：未配置 → fallback 到全局默认模型
- 专项 slot（vision_expert/coding_expert）：未配置 → 不可用，Worker 看不到该 Sub-agent 工具

## 3. 协议变更

### 3.1 ModelRoleDefinition 增加 fallback 字段

在 base-protocol.md §5.16 中扩展：

```typescript
interface ModelRoleDefinition {
  key: string
  description: string
  required: boolean
  recommended_capabilities?: string[]
  fallback: "global_default" | "none"  // 新增
}
```

- `"global_default"`：未配置时使用全局默认模型（现有行为）
- `"none"`：未配置时该 slot 不可用

### 3.2 Agent 声明的 model_roles 扩展

```typescript
model_roles: [
  // 现有通用 slot
  { key: "triage", description: "分诊模型", required: false, fallback: "global_default" },
  { key: "worker", description: "执行模型", required: false, fallback: "global_default" },
  { key: "digest", description: "摘要模型", required: false, fallback: "global_default" },
  // 新增专项 slot
  {
    key: "vision_expert",
    description: "视觉专家，用于截图分析和浏览器操作",
    required: false,
    fallback: "none",
    recommended_capabilities: ["vision"]
  },
  {
    key: "coding_expert",
    description: "编码专家，用于代码编写和分析",
    required: false,
    fallback: "none",
    recommended_capabilities: ["coding"]
  },
]
```

### 3.3 Admin 解析逻辑调整

```typescript
for (const role of definition.model_roles) {
  const slotRef = instanceConfig?.models[role.key]
  if (slotRef) {
    resolvedModels[role.key] = buildConnectionInfo(slotRef.provider_id, slotRef.model_id)
  } else if (role.fallback === "global_default") {
    resolvedModels[role.key] = buildConnectionInfo(globalDefault.provider_id, globalDefault.model_id)
  }
  // fallback === "none" 且未配置 → 不加入 resolvedModels
}
```

### 3.4 protocol-agent-v2.md 补充 Sub-agent 执行模型

在协议中新增一节描述 Worker Sub-agent 机制：

- `delegate_to_subagent` 工具的定义（name、input_schema、output_schema）
- Sub-agent 的生命周期：创建 → 执行 → 返回结果 → 销毁
- Sub-agent 继承 Worker 的工具集（排除 delegate_to_subagent 本身）
- Sub-agent 的上下文隔离保证

## 4. Engine 层实现

### 4.1 delegate_to_subagent 工具定义

```typescript
{
  name: "delegate_to_subagent",
  description: "将子任务委派给专项 Sub-agent 执行。Sub-agent 在独立上下文中运行，只返回最终结果。",
  input_schema: {
    type: "object",
    properties: {
      agent_type: {
        type: "string",
        enum: [],  // 动态生成，仅包含已配置的专项 slot
        description: "要委派给哪个专项 Sub-agent"
      },
      task: {
        type: "string",
        description: "子任务描述，Sub-agent 将基于此独立执行"
      }
    },
    required: ["agent_type", "task"]
  }
}
```

`enum` 列表在 Worker 初始化时根据 `model_config` 中实际存在的专项 slot 动态生成。如果没有任何专项 slot 被配置，这个工具不会出现在 Worker 的工具列表中。

### 4.2 Sub-agent 执行流程

```
Worker engine loop 正常运行
  → LLM 返回 tool_use: delegate_to_subagent({ agent_type: "vision_expert", task: "..." })
  → engine 拦截此工具调用
  → 创建 Sub-agent：
      1. 从 model_config 取 vision_expert slot 的 LLMConnectionInfo
      2. 创建独立的 adapter + 对话历史
      3. 注入 Sub-agent system prompt（含任务描述 + 可用工具）
      4. 继承 Worker 的工具集（排除 delegate_to_subagent，防止递归）
  → Sub-agent 独立执行 engine loop（可能多轮 tool_use）
  → 执行完毕，提取最终文本结果
  → 作为 tool_result 返回给 Worker
  → Worker 继续主任务
```

### 4.3 Sub-agent System Prompt

每种 Sub-agent 类型有独立的 system prompt 模板：

```typescript
const SUBAGENT_PROMPTS: Record<string, string> = {
  vision_expert: `你是一个视觉分析专家。你的任务是分析图片内容并给出准确的文字描述。
专注于完成委派给你的任务，给出清晰简洁的结果。不要做超出任务范围的事情。`,

  coding_expert: `你是一个编码专家。你的任务是编写高质量的代码或分析代码问题。
专注于完成委派给你的任务，给出可直接使用的代码或分析结论。`,
}
```

可扩展——未来增加新 Sub-agent 类型只需增加一个模板。

### 4.4 Worker System Prompt 注入

当有可用的专项 Sub-agent 时，Worker 的 system prompt 中注入：

```
你有以下专项 Sub-agent 可以使用：
- vision_expert：视觉分析专家，擅长截图分析、UI 识别、浏览器页面理解
- coding_expert：编码专家，擅长代码编写、代码分析、bug 修复

使用 delegate_to_subagent 工具委派子任务。适合委派的场景：
1. 你的能力不足（如你没有视觉能力但需要分析图片）
2. 子任务的中间过程你不关心，只需要最终结果
```

无可用专项 slot 时，这段提示不出现，工具也不注册。

## 5. 可视化与调试

### 5.1 日志

- Sub-agent 每轮 LLM 调用和 tool_use 作为子 span 挂在 Worker 当前 span 下
- 日志中标记 `subagent_type` 和 `subagent_task`，便于过滤
- 输入 prompt、输出结果、token 消耗、轮次数均记录

### 5.2 Admin UI

- 任务详情页的执行时间线中，Sub-agent 调用显示为可展开的节点
- 折叠态：显示 sub-agent 类型、任务摘要、耗时、token 消耗
- 展开态：显示完整的对话历史（每轮 LLM 输入/输出 + tool_use 调用链）
- 与 Worker 执行详情的展示模式一致，多一层嵌套

### 5.3 数据流

Sub-agent 执行器在每轮结束后通过现有的 trace 上报机制写入，不需要新的通信通道。

## 6. 边界情况

| 场景 | 行为 |
|------|------|
| 无任何专项 slot 配置 | `delegate_to_subagent` 工具不注册，Worker 完全自主执行，与当前行为一致 |
| Sub-agent 执行失败 | 返回错误信息作为 tool_result，Worker 自行决定重试或换策略 |
| Sub-agent 执行超时 | 设置最大轮次限制（如 20 轮），超出后强制返回已有结果 |
| Worker 尝试委派给未配置的 agent_type | 不会发生——enum 中只包含已配置的类型 |
| Sub-agent 尝试递归调用 delegate_to_subagent | 工具集中排除此工具，无法递归 |
| 运行中热更新模型配置 | 下次创建 Sub-agent 时使用新配置，已运行的不受影响 |

## 7. 代码改动位置

| 改动 | 文件 |
|------|------|
| Sub-agent 执行器 | 新建 `crabot-agent/src/agent/subagent-executor.ts` |
| Sub-agent prompt 模板 | 新建 `crabot-agent/src/agent/subagent-prompts.ts` |
| 工具注册 | `crabot-agent/src/agent/worker-handler.ts` — 初始化时根据可用 slot 注册工具 |
| Engine 拦截 | `crabot-agent/src/engine/` — 识别 delegate_to_subagent 并路由到执行器 |
| model_roles 声明 | `crabot-agent/src/unified-agent.ts` — handleGetLLMRequirements 增加新 slot |
| prompt 注入 | `crabot-agent/src/prompt-manager.ts` — 注入可用 Sub-agent 信息 |
| 协议文档 | `crabot-docs/protocols/base-protocol.md` — ModelRoleDefinition 增加 fallback |
| 协议文档 | `crabot-docs/protocols/protocol-agent-v2.md` — 新增 Sub-agent 章节 |
| Admin 解析 | `crabot-admin/` — resolveModelConfig 支持 fallback 字段 |
| Admin UI | `crabot-admin/web/` — 任务详情页展示 Sub-agent 执行过程 |

## 8. 不在本次范围

- Sub-agent 之间的协作/通信（当前各自独立）
- Sub-agent 工具白名单（当前继承全部，未来可限制）
- Sub-agent 的并行执行（当前串行，一次只运行一个）
