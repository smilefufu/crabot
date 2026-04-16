# 媒体视觉管线设计

> 日期: 2026-04-10
> 状态: approved

## 问题概述

图片消息从 Channel 到 Agent 的全链路中存在多处数据丢失和能力缺失：

1. **`formatMessageContent` bug**: 消息同时有 text 和 image 时，只返回 text，图片引用完全丢失
2. **Worker 不解析图片**: `buildTaskMessage` 返回纯字符串，不调用 `resolveImageBlocks`，Worker LLM 永远看不到图片
3. **Sub-agent 不传 `supportsVision`**: `forkEngine` 调用 `runEngine` 时未传此标志，视觉专家即使用 VLM 也按非 VLM 处理
4. **Sub-agent 不支持图片 prompt**: `forkEngine.prompt` 是 `string`，无法传入图片数据
5. **Read 工具无图片识别能力**: 检测到二进制文件直接返回 `Binary file, cannot display`，无法像 Claude Code 的 Read 工具那样返回 ImageBlock
6. **Vision expert 无能力校验**: 配了非 VLM 模型到 vision_expert slot 时不会被过滤

## 设计方案

### 1. 修复 `formatMessageContent`

**文件**: `crabot-agent/src/agent/media-resolver.ts`

当消息同时有 text 和 media_url 时，保留两者：

```typescript
function formatMessageContent(msg: ChannelMessage): string {
  const text = msg.content.text ?? ''
  const mediaRef = formatMediaRef(msg)

  if (text && mediaRef) return `${text}\n${mediaRef}`
  if (text) return text
  if (mediaRef) return mediaRef
  return '[非文本消息]'
}

function formatMediaRef(msg: ChannelMessage): string {
  if (!msg.content.media_url) return ''
  switch (msg.content.type) {
    case 'image': return `[图片: ${msg.content.media_url}]`
    case 'file': return `[文件: ${msg.content.filename ?? msg.content.media_url}]`
    default: return ''
  }
}
```

同时提取通用函数 `resolveImageFromPaths(paths: string[]): Promise<ImageBlock[]>`，供 Worker 和 Sub-agent 复用。

### 2. Worker `buildTaskMessage` 支持图片直通

**文件**: `crabot-agent/src/agent/worker-handler.ts`

根据 Worker 模型能力返回不同格式：

- **Worker 支持 vision（`supportsVision === true`）**: 调用 `resolveImageBlocks(context.trigger_messages)` 解析图片为 base64 ImageBlock，返回 `ContentBlock[]`（TextBlock + ImageBlock）。Worker 主 LLM 第一轮就能看到图片。
- **Worker 不支持 vision**: 保持返回 `string`。文本中保留 `[图片: /path/to/file]` 引用（靠 `formatMessageContent` 修复保证）。Worker 看到路径后可 delegate 给 vision expert。

### 3. `RunEngineParams.prompt` 类型扩展

**文件**: `crabot-agent/src/engine/query-loop.ts`

`RunEngineParams.prompt` 从 `string` 改为 `string | ContentBlock[]`。底层 `createUserMessage` 已支持此类型，无需额外改动。

### 4. Sub-agent `forkEngine` 补全

**文件**: `crabot-agent/src/engine/sub-agent.ts`

**4a. 传递 `supportsVision`**

`ForkEngineParams` 新增 `supportsVision?: boolean`，透传给 `runEngine` 的 `options`。

**4b. 支持图片 prompt**

`ForkEngineParams.prompt` 改为 `string | ContentBlock[]`。

`createSubAgentTool` 的 input schema 新增可选参数 `image_paths: string[]`。调用 `forkEngine` 前，如果有 `image_paths`，用 `resolveImageFromPaths` 读取文件转 base64，构造 `ContentBlock[]`（TextBlock + ImageBlock）。

**4c. Worker 调用处传入 `supportsVision`**

`worker-handler.ts` 中 `createSubAgentTool` 调用时从 `subSdkEnv.supportsVision` 取值传入。

### 5. Read 工具多模态化

**文件**: `crabot-agent/src/engine/tools/read-tool.ts`

图片文件识别逻辑：

1. 用扩展名判断是否为已知图片格式（jpg/jpeg/png/gif/webp）
2. 如果是图片：读取文件 → 用 `compressImage`（来自 `image-utils.ts`）压缩（resize 1024px + JPEG 70%）→ 通过 `ToolCallResult.images` 返回，`output` 设为 `[Image: /path/to/file, ${size} bytes]`
3. sharp 不可用时 `compressImage` 自动 fallback 到原图
4. 压缩后仍超过 20MB → 降级为文字描述
5. 非图片二进制文件 → 保持现有 `Binary file, cannot display`

引擎层已有的 `supportsVision` 分支自动生效：VLM 模型看到图片，非 VLM 模型得到文字描述 + /tmp 文件路径。

### 6. Sub-agent 能力校验 + vision 降级

**文件**: `crabot-agent/src/unified-agent.ts`

`buildSubAgentConfigs` 中，对 `recommendedCapabilities` 包含 `'vision'` 的 definition：

```
vision_expert 解析优先级：
  1. 显式配置的 vision_expert slot（且 supports_vision=true）
  2. 任意已配 slot 中 supports_vision=true 的模型（降级）
  3. 都没有 → 不创建 vision expert tool，prompt 中不提及
```

降级时 log 提示：`[SubAgent] vision_expert slot missing/invalid, falling back to <slot_key> model`。

## 改动文件清单

| 文件 | 改动概述 |
|------|---------|
| `src/agent/media-resolver.ts` | 修 `formatMessageContent`；提取 `resolveImageFromPaths` |
| `src/agent/worker-handler.ts` | `buildTaskMessage` 返回 `string \| ContentBlock[]`；`createSubAgentTool` 传 `supportsVision` |
| `src/engine/query-loop.ts` | `RunEngineParams.prompt` 类型改为 `string \| ContentBlock[]` |
| `src/engine/sub-agent.ts` | `ForkEngineParams` 加 `supportsVision`、`prompt` 支持 `ContentBlock[]`；input schema 加 `image_paths` |
| `src/engine/tools/read-tool.ts` | 图片文件识别 → 压缩 → `images` 字段返回 |
| `src/unified-agent.ts` | `buildSubAgentConfigs` 加 vision 能力校验 + 降级 |

## 不改动的部分

- `engine/types.ts` — `ToolCallResult.images`、`ContentBlock`、`createUserMessage` 已支持
- `engine/image-utils.ts` — `compressImage` 直接复用
- `engine/tool-orchestration.ts` — 已透传 `images`
- `front-handler.ts` — 已正确解析图片
- `subagent-prompts.ts` — 定义不变
- `prompt-manager.ts` — sub-agent hint 注入机制已正确
