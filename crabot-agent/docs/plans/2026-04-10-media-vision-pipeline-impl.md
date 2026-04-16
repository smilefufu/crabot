# Media Vision Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让图片消息从 Channel 到 Worker/Sub-agent 全链路可用，VLM 模型直接看图，非 VLM 通过 vision expert 或 Read 工具获取图片。

**Architecture:** 六处改动：修 formatMessageContent bug → Read 工具多模态化 → RunEngineParams 类型扩展 → forkEngine 补全 → Worker buildTaskMessage 直通 → Sub-agent 能力校验+降级。每个 Task 独立可测。

**Tech Stack:** TypeScript, Vitest, sharp (optional, lazy-loaded)

**Design doc:** `crabot-agent/docs/plans/2026-04-10-media-vision-pipeline.md`

---

### Task 1: 修复 `formatMessageContent` + 提取 `resolveImageFromPaths`

**Files:**
- Modify: `src/agent/media-resolver.ts:57-107`
- Test: `tests/agent/media-resolver.test.ts` (create)

- [ ] **Step 1: 创建测试文件，写 formatMessageContent 的 failing tests**

```typescript
// tests/agent/media-resolver.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { formatMessageContent, resolveImageFromPaths } from '../../src/agent/media-resolver'
import type { ChannelMessage } from '../../src/types'

function makeMsg(overrides: Partial<ChannelMessage['content']>): ChannelMessage {
  return {
    platform_message_id: 'msg-1',
    session: { session_id: 's1', channel_id: 'ch1', type: 'private' },
    sender: { platform_user_id: 'u1', platform_display_name: 'User' },
    content: { type: 'text', text: '', ...overrides },
    features: { is_mention_crab: false },
    platform_timestamp: new Date().toISOString(),
  }
}

describe('formatMessageContent', () => {
  it('returns text for text-only messages', () => {
    const msg = makeMsg({ type: 'text', text: 'hello' })
    expect(formatMessageContent(msg)).toBe('hello')
  })

  it('returns image placeholder for image-only messages', () => {
    const msg = makeMsg({ type: 'image', text: '', media_url: '/tmp/img.jpg' })
    expect(formatMessageContent(msg)).toBe('[图片: /tmp/img.jpg]')
  })

  it('returns both text and image ref when message has both', () => {
    const msg = makeMsg({ type: 'image', text: '帮我分析', media_url: '/tmp/img.jpg' })
    const result = formatMessageContent(msg)
    expect(result).toContain('帮我分析')
    expect(result).toContain('[图片: /tmp/img.jpg]')
  })

  it('returns file placeholder for file messages', () => {
    const msg = makeMsg({ type: 'file', text: '', media_url: '/tmp/doc.pdf', filename: 'report.pdf' })
    expect(formatMessageContent(msg)).toBe('[文件: report.pdf]')
  })

  it('returns text + file ref when file message has text', () => {
    const msg = makeMsg({ type: 'file', text: '看看这个', media_url: '/tmp/doc.pdf', filename: 'report.pdf' })
    const result = formatMessageContent(msg)
    expect(result).toContain('看看这个')
    expect(result).toContain('[文件: report.pdf]')
  })

  it('returns fallback for unknown type with no text', () => {
    const msg = makeMsg({ type: 'text', text: '' })
    expect(formatMessageContent(msg)).toBe('[非文本消息]')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd crabot-agent && npx vitest run tests/agent/media-resolver.test.ts --reporter=verbose`
Expected: "returns both text and image ref" 和 "returns text + file ref" 两个 case FAIL

- [ ] **Step 3: 实现修复**

修改 `src/agent/media-resolver.ts:57-69`，替换 `formatMessageContent`：

```typescript
function formatMediaRef(msg: ChannelMessage): string {
  if (!msg.content.media_url) return ''
  switch (msg.content.type) {
    case 'image':
      return `[图片: ${msg.content.media_url}]`
    case 'file':
      return `[文件: ${msg.content.filename ?? msg.content.media_url}]`
    default:
      return ''
  }
}

export function formatMessageContent(msg: ChannelMessage): string {
  const text = msg.content.text ?? ''
  const mediaRef = formatMediaRef(msg)

  if (text && mediaRef) return `${text}\n${mediaRef}`
  if (text) return text
  if (mediaRef) return mediaRef
  return '[非文本消息]'
}
```

- [ ] **Step 4: 添加 `resolveImageFromPaths` 函数**

在 `src/agent/media-resolver.ts` 文件末尾添加（复用已有的 `readLocalFile` 和 `inferMediaType`）：

```typescript
/**
 * 从文件路径列表解析图片为 engine ImageBlock。
 * 供 Worker buildTaskMessage 和 Sub-agent image_paths 参数复用。
 */
export async function resolveImageFromPaths(
  paths: ReadonlyArray<string>
): Promise<ImageBlock[]> {
  const results = await Promise.all(
    paths.map(async (filePath): Promise<ImageBlock | null> => {
      const buffer = await readLocalFile(filePath)
      if (!buffer) return null

      const mediaType = inferMediaType(undefined, filePath)
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: buffer.toString('base64'),
        },
      }
    })
  )
  return results.filter((block): block is ImageBlock => block !== null)
}
```

- [ ] **Step 5: 添加 resolveImageFromPaths 测试**

在 `tests/agent/media-resolver.test.ts` 末尾追加：

```typescript
describe('resolveImageFromPaths', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-resolver-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('resolves a valid image file to ImageBlock', async () => {
    const imgPath = path.join(tmpDir, 'test.png')
    // 1x1 red PNG
    const pngData = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    )
    await fs.writeFile(imgPath, pngData)

    const blocks = await resolveImageFromPaths([imgPath])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('image')
    expect(blocks[0].source.media_type).toBe('image/png')
    expect(blocks[0].source.type).toBe('base64')
  })

  it('skips non-existent files', async () => {
    const blocks = await resolveImageFromPaths(['/tmp/does-not-exist-12345.png'])
    expect(blocks).toHaveLength(0)
  })

  it('handles multiple paths', async () => {
    const img1 = path.join(tmpDir, 'a.jpg')
    const img2 = path.join(tmpDir, 'b.png')
    await fs.writeFile(img1, Buffer.alloc(10))
    await fs.writeFile(img2, Buffer.alloc(10))

    const blocks = await resolveImageFromPaths([img1, img2])
    expect(blocks).toHaveLength(2)
    expect(blocks[0].source.media_type).toBe('image/jpeg')
    expect(blocks[1].source.media_type).toBe('image/png')
  })
})
```

- [ ] **Step 6: 运行全部测试确认通过**

Run: `cd crabot-agent && npx vitest run tests/agent/media-resolver.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
cd crabot-agent
git add src/agent/media-resolver.ts tests/agent/media-resolver.test.ts
git commit -m "fix(agent): formatMessageContent preserves media refs; add resolveImageFromPaths"
```

---

### Task 2: Read 工具多模态化

**Files:**
- Modify: `src/engine/tools/read-tool.ts`
- Test: `tests/engine/tools/read-tool.test.ts`

- [ ] **Step 1: 写 failing tests**

在 `tests/engine/tools/read-tool.test.ts` 末尾（`describe('createReadTool', ...)` 内部）追加：

```typescript
  it('returns image data for image files', async () => {
    const filePath = path.join(tmpDir, 'photo.png')
    // 1x1 red PNG
    const pngData = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    )
    await fs.writeFile(filePath, pngData)

    const result = await tool.call({ file_path: filePath }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('[Image:')
    expect(result.images).toBeDefined()
    expect(result.images!.length).toBe(1)
    expect(result.images![0].media_type).toBe('image/png')
    expect(result.images![0].data).toBeTruthy()
  })

  it('returns image data for jpg files', async () => {
    const filePath = path.join(tmpDir, 'photo.jpg')
    // Minimal JPEG (not valid image but has no null bytes in first 8K except JPEG markers)
    await fs.writeFile(filePath, Buffer.alloc(100, 0xFF))

    const result = await tool.call({ file_path: filePath }, {})
    expect(result.isError).toBe(false)
    expect(result.images).toBeDefined()
    expect(result.images![0].media_type).toBe('image/jpeg')
  })

  it('still rejects non-image binary files', async () => {
    const filePath = path.join(tmpDir, 'data.bin')
    const buf = Buffer.alloc(100)
    buf[50] = 0x00
    buf.fill(0x41, 0, 50)
    buf.fill(0x42, 51)
    await fs.writeFile(filePath, buf)

    const result = await tool.call({ file_path: filePath }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Binary file')
    expect(result.images).toBeUndefined()
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd crabot-agent && npx vitest run tests/engine/tools/read-tool.test.ts --reporter=verbose`
Expected: "returns image data for image files" FAIL

- [ ] **Step 3: 实现 Read 工具图片识别**

修改 `src/engine/tools/read-tool.ts`，在文件头部添加导入和常量：

```typescript
import { compressImage } from '../image-utils'

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
const MAX_IMAGE_SIZE = 20 * 1024 * 1024 // 20MB

function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTENSIONS.has(ext)
}
```

在 `call` 函数中，`containsNullBytes` 检查之前插入图片处理分支：

```typescript
      // 在 const fileHandle = await fs.open(filePath, 'r') 之前
      // Image file detection — before reading as text
      if (isImageFile(filePath)) {
        if (fileSize > MAX_IMAGE_SIZE) {
          return {
            output: `[Image too large: ${filePath}, ${fileSize} bytes]`,
            isError: false,
          }
        }
        const imageBuffer = await fs.readFile(filePath)
        const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png'
        const mediaTypeMap: Record<string, string> = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg',
          png: 'image/png', gif: 'image/gif', webp: 'image/webp',
        }
        const rawMediaType = mediaTypeMap[ext] ?? 'image/png'
        const rawImageData = {
          media_type: rawMediaType,
          data: imageBuffer.toString('base64'),
        }
        const compressed = await compressImage(rawImageData)
        return {
          output: `[Image: ${filePath}, ${fileSize} bytes]`,
          isError: false,
          images: [compressed],
        }
      }
```

注意：这段代码插入在 `const stat = await fs.stat(filePath)` 和 `fileSize === 0` 检查之后，`const truncated = ...` 之前。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd crabot-agent && npx vitest run tests/engine/tools/read-tool.test.ts --reporter=verbose`
Expected: All PASS（包括原有的 binary file test 仍通过）

- [ ] **Step 5: Commit**

```bash
cd crabot-agent
git add src/engine/tools/read-tool.ts tests/engine/tools/read-tool.test.ts
git commit -m "feat(engine): Read tool returns ImageBlock for image files"
```

---

### Task 3: `RunEngineParams.prompt` 类型扩展

**Files:**
- Modify: `src/engine/query-loop.ts:25`
- Test: `tests/engine/query-loop.test.ts`

- [ ] **Step 1: 写 failing test**

在 `tests/engine/query-loop.test.ts` 中找到现有 describe 块，追加：

```typescript
  it('accepts ContentBlock[] as prompt', async () => {
    const capturedMessages: unknown[] = []
    const adapter: LLMAdapter = {
      async *stream(params) {
        capturedMessages.push(params.messages)
        for (const chunk of textResponse('ok')) {
          yield chunk
        }
      },
      updateConfig() {},
    }

    const { ContentBlock } = await import('../../src/engine/types')

    await runEngine({
      prompt: [
        { type: 'text' as const, text: 'Analyze this image' },
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'abc123' } },
      ],
      adapter,
      options: {
        systemPrompt: 'You are helpful.',
        tools: [],
        model: 'test-model',
      },
    })

    const messages = capturedMessages[0] as Array<{ content: unknown }>
    const firstContent = messages[0].content
    expect(Array.isArray(firstContent)).toBe(true)
    expect(firstContent).toHaveLength(2)
    expect((firstContent as any)[0].type).toBe('text')
    expect((firstContent as any)[1].type).toBe('image')
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd crabot-agent && npx vitest run tests/engine/query-loop.test.ts -t "accepts ContentBlock" --reporter=verbose`
Expected: FAIL（TypeScript 编译错误，prompt 类型不匹配）

- [ ] **Step 3: 修改 RunEngineParams 类型**

修改 `src/engine/query-loop.ts:24-28`：

```typescript
export interface RunEngineParams {
  readonly prompt: string | ReadonlyArray<import('./types').ContentBlock>
  readonly adapter: LLMAdapter
  readonly options: EngineOptions
}
```

`createUserMessage` 已接受 `string | ContentBlock[]`，无需改 `runEngine` 函数体。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd crabot-agent && npx vitest run tests/engine/query-loop.test.ts -t "accepts ContentBlock" --reporter=verbose`
Expected: PASS

- [ ] **Step 5: 运行全量引擎测试确认无回归**

Run: `cd crabot-agent && npx vitest run tests/engine/ --reporter=verbose`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
cd crabot-agent
git add src/engine/query-loop.ts tests/engine/query-loop.test.ts
git commit -m "feat(engine): RunEngineParams.prompt accepts ContentBlock[]"
```

---

### Task 4: Sub-agent `forkEngine` 补全

**Files:**
- Modify: `src/engine/sub-agent.ts`
- Test: `tests/engine/sub-agent.test.ts`

- [ ] **Step 1: 写 failing tests**

在 `tests/engine/sub-agent.test.ts` 的 `describe('forkEngine', ...)` 内追加：

```typescript
  it('passes supportsVision to engine options', async () => {
    let capturedOptions: Record<string, unknown> = {}
    const adapter: LLMAdapter = {
      async *stream(params) {
        capturedOptions = params.options ?? {}
        for (const chunk of textResponse('done')) {
          yield chunk
        }
      },
      updateConfig() {},
    }

    await forkEngine({
      prompt: 'Analyze image',
      adapter,
      model: 'test-model',
      systemPrompt: 'Vision expert.',
      tools: [],
      supportsVision: true,
    })

    expect(capturedOptions).toHaveProperty('supportsVision', true)
  })
```

在 `describe('createSubAgentTool', ...)` 内追加：

```typescript
  it('input schema includes image_paths parameter', () => {
    const tool = createSubAgentTool({
      name: 'vision_expert',
      description: 'Vision agent',
      adapter: mockAdapter([]),
      model: 'test-model',
      systemPrompt: 'You are a vision expert.',
      subTools: [],
      supportsVision: true,
    })

    const props = (tool.inputSchema as any).properties
    expect(props).toHaveProperty('image_paths')
    expect(props.image_paths.type).toBe('array')
  })

  it('input schema omits image_paths when supportsVision is false', () => {
    const tool = createSubAgentTool({
      name: 'coding_expert',
      description: 'Coding agent',
      adapter: mockAdapter([]),
      model: 'test-model',
      systemPrompt: 'You are a coder.',
      subTools: [],
    })

    const props = (tool.inputSchema as any).properties
    expect(props).not.toHaveProperty('image_paths')
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd crabot-agent && npx vitest run tests/engine/sub-agent.test.ts --reporter=verbose`
Expected: FAIL（supportsVision 不存在于 ForkEngineParams）

- [ ] **Step 3: 修改 ForkEngineParams 和 forkEngine**

修改 `src/engine/sub-agent.ts`，在文件顶部增加导入：

```typescript
import type { LLMAdapter } from './llm-adapter'
import type { ToolDefinition, EngineTurnEvent, EngineResult, ContentBlock } from './types'
import { runEngine } from './query-loop'
import { resolveImageFromPaths } from '../agent/media-resolver'
```

修改 `ForkEngineParams`，增加字段：

```typescript
export interface ForkEngineParams {
  /** Task description for the sub-agent */
  readonly prompt: string | ReadonlyArray<ContentBlock>
  // ... existing fields unchanged ...
  /** Whether the sub-agent model supports vision */
  readonly supportsVision?: boolean
}
```

修改 `forkEngine` 函数体，把 `supportsVision` 传给 `runEngine`：

```typescript
export async function forkEngine(params: ForkEngineParams): Promise<ForkEngineResult> {
  let prompt: string | ReadonlyArray<ContentBlock>
  if (params.parentContext) {
    if (typeof params.prompt === 'string') {
      prompt = `## Parent Context\n${params.parentContext}\n\n## Your Task\n${params.prompt}`
    } else {
      // ContentBlock[] — prepend parent context as TextBlock
      prompt = [
        { type: 'text' as const, text: `## Parent Context\n${params.parentContext}\n\n## Your Task\n` },
        ...params.prompt,
      ]
    }
  } else {
    prompt = params.prompt
  }

  const result = await runEngine({
    prompt,
    adapter: params.adapter,
    options: {
      systemPrompt: params.systemPrompt,
      tools: [...params.tools],
      model: params.model,
      maxTurns: params.maxTurns ?? DEFAULT_SUB_AGENT_MAX_TURNS,
      abortSignal: params.abortSignal,
      onTurn: params.onTurn,
      supportsVision: params.supportsVision,
    },
  })

  return {
    output: result.finalText,
    outcome: result.outcome,
    usage: result.usage,
    totalTurns: result.totalTurns,
  }
}
```

- [ ] **Step 4: 修改 SubAgentToolConfig 和 createSubAgentTool**

修改 `SubAgentToolConfig`，增加字段：

```typescript
export interface SubAgentToolConfig {
  // ... existing fields ...
  /** Whether the sub-agent model supports vision */
  readonly supportsVision?: boolean
}
```

修改 `createSubAgentTool`，根据 `supportsVision` 动态构造 input schema 和调用逻辑：

```typescript
export function createSubAgentTool(config: SubAgentToolConfig): ToolDefinition {
  const properties: Record<string, unknown> = {
    task: { type: 'string', description: 'Task description for the sub-agent' },
    context: { type: 'string', description: 'Optional parent context to share with the sub-agent' },
  }
  if (config.supportsVision) {
    properties.image_paths = {
      type: 'array',
      items: { type: 'string' },
      description: 'Local file paths of images to pass to the sub-agent for visual analysis',
    }
  }

  return {
    name: config.name,
    description: config.description,
    isReadOnly: true,
    inputSchema: {
      type: 'object',
      properties,
      required: ['task'],
    },
    call: async (input, callContext) => {
      try {
        // Resolve image paths to ContentBlock[] if provided
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
      }
    },
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd crabot-agent && npx vitest run tests/engine/sub-agent.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
cd crabot-agent
git add src/engine/sub-agent.ts tests/engine/sub-agent.test.ts
git commit -m "feat(engine): forkEngine supports supportsVision and image_paths"
```

---

### Task 5: Worker `buildTaskMessage` 支持图片直通

**Files:**
- Modify: `src/agent/worker-handler.ts:345-389, 685-720`

- [ ] **Step 1: 修改 createSubAgentTool 调用，传入 supportsVision**

在 `src/agent/worker-handler.ts:355`，修改 `createSubAgentTool` 调用：

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
          onSubAgentTurn: traceCallback ? (event) => {
            // ... existing trace callback unchanged ...
          } : undefined,
        }))
```

- [ ] **Step 2: 修改 buildTaskMessage 返回类型和实现**

在 `src/agent/worker-handler.ts` 顶部增加导入：

```typescript
import { formatMessageContent, resolveImageBlocks, resolveImageFromPaths } from './media-resolver.js'
import type { ContentBlock } from '../engine/types.js'
```

修改 `buildTaskMessage` 签名和实现（`worker-handler.ts:685`）：

```typescript
  private async buildTaskMessage(
    task: ExecuteTaskParams['task'],
    context: WorkerAgentContext
  ): Promise<string | ReadonlyArray<ContentBlock>> {
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
        parts.push(formatMessageContent(msg))
      }
      if (task.task_description) {
        parts.push(`\n## 任务分类\n${task.task_description}`)
      }
    } else {
      parts.push(`\n## 任务描述\n${task.task_description}`)
    }

    // ... 后续 sender_friend / task_origin / memory 部分保持不变（从现有代码复制）...

    const textContent = parts.join('\n')

    // VLM Worker: 解析图片注入 ContentBlock[]
    if (this.sdkEnv.supportsVision && context.trigger_messages?.length) {
      const imageBlocks = await resolveImageBlocks(context.trigger_messages)
      if (imageBlocks.length > 0) {
        return [
          { type: 'text' as const, text: textContent },
          ...imageBlocks,
        ]
      }
    }

    return textContent
  }
```

注意：`buildTaskMessage` 从同步改为异步（`async`），因为 `resolveImageBlocks` 是异步的。

- [ ] **Step 3: 更新调用处**

修改 `worker-handler.ts:388`，调用处加 `await`：

```typescript
      const taskMessage = await this.buildTaskMessage(task, context)
```

- [ ] **Step 4: 运行现有 worker-handler 测试确认无回归**

Run: `cd crabot-agent && npx vitest run tests/agent/worker-handler.test.ts --reporter=verbose`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd crabot-agent
git add src/agent/worker-handler.ts
git commit -m "feat(agent): Worker buildTaskMessage injects images for VLM, passes supportsVision to sub-agents"
```

---

### Task 6: Sub-agent 能力校验 + vision 降级

**Files:**
- Modify: `src/unified-agent.ts:311-320`

- [ ] **Step 1: 修改 buildSubAgentConfigs 实现**

替换 `src/unified-agent.ts:311-320`：

```typescript
  private buildSubAgentConfigs(
    modelConfig: Record<string, LLMConnectionInfo>
  ): ReadonlyArray<{ readonly definition: SubAgentDefinition; readonly sdkEnv: SdkEnvConfig }> {
    return SUBAGENT_DEFINITIONS
      .map((def) => {
        const connInfo = this.resolveSubAgentSlot(def, modelConfig)
        if (!connInfo) return null
        return {
          definition: def,
          sdkEnv: this.buildSdkEnv(connInfo),
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
  }

  /**
   * 解析 sub-agent 的 model slot，支持 vision 降级。
   *
   * 优先级：
   *  1. 显式配置的 slot（且能力匹配）
   *  2. 对于需要 vision 的 slot，降级到任意已配且 supports_vision=true 的模型
   *  3. 都没有 → 返回 undefined（跳过该 sub-agent）
   */
  private resolveSubAgentSlot(
    def: SubAgentDefinition,
    modelConfig: Record<string, LLMConnectionInfo>
  ): LLMConnectionInfo | undefined {
    const needsVision = def.recommendedCapabilities.includes('vision')
    const explicit = modelConfig[def.slotKey]

    // 显式配置且能力匹配
    if (explicit) {
      if (!needsVision || explicit.supports_vision) {
        return explicit
      }
      log(`[SubAgent] Slot '${def.slotKey}' model lacks vision capability, trying fallback`)
    }

    // 需要 vision 能力：从其他 slot 中找一个 VLM
    if (needsVision) {
      for (const [key, connInfo] of Object.entries(modelConfig)) {
        if (key !== def.slotKey && connInfo.supports_vision) {
          log(`[SubAgent] Slot '${def.slotKey}' falling back to '${key}' model (${connInfo.model_id})`)
          return connInfo
        }
      }
      log(`[SubAgent] No VLM available for slot '${def.slotKey}', skipping`)
      return undefined
    }

    // 非 vision slot，未配置则跳过
    if (!explicit) {
      log(`[SubAgent] Slot '${def.slotKey}' not configured, skipping ${def.toolName}`)
    }
    return explicit
  }
```

- [ ] **Step 2: 运行全量测试确认无回归**

Run: `cd crabot-agent && npx vitest run --reporter=verbose`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
cd crabot-agent
git add src/unified-agent.ts
git commit -m "feat(agent): vision sub-agent capability check with fallback to any VLM slot"
```

---

### Task 7: 集成验证

- [ ] **Step 1: TypeScript 编译检查**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: 全量测试**

Run: `cd crabot-agent && npx vitest run --reporter=verbose`
Expected: All PASS

- [ ] **Step 3: 端到端手动验证**

1. `./dev.sh stop && ./dev.sh` 重启
2. 在飞书发一张图片 + 文字给 Crabot
3. 确认 trace 中：
   - Worker（如果是 VLM）第一轮就有 image content block
   - 或 Worker delegate 给 vision_expert，vision_expert 能看到图片（`totalTurns > 0`）
   - 不再出现 `[openclaw-stub] unknown export accessed: buildAgentMediaPayload`
4. 确认 Read 工具能读取图片文件并返回 ImageBlock

- [ ] **Step 4: Final commit**

```bash
cd crabot-agent
git add -A
git commit -m "feat(agent): complete media vision pipeline - images flow from channel to worker/sub-agent"
```
