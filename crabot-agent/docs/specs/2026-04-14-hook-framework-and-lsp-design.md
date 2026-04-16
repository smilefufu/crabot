# Hook 框架 + LSP 诊断管理器设计方案

> 日期：2026-04-14
> 状态：待实现

## 1. 背景与动机

当前 coding_expert sub-agent 写完代码后没有任何自动质量检查（lint、type-check、test）。LLM 无法感知自己写的代码是否有类型错误或编译问题，只能靠运行时报错才发现。

目标：
1. 设计一个**通用 Hook 框架**，所有 agent 可用（第一版仅 coding_expert 配置）
2. 实现 **LSP 诊断管理器**，支持 TypeScript/Python/Rust/Go 四种语言
3. 通过 Hook 机制将 LSP 诊断、编译检查、测试运行集成到 sub-agent 执行流程中

## 2. 核心概念

### 2.1 Hook 框架

通用的事件 Hook 机制，在引擎执行的关键节点插入自定义逻辑。

```
Engine Loop:
  LLM 调用 → 工具执行 → 下一轮
                │
         ┌──────┼──────┐
    PreToolUse  │  PostToolUse
         │      │      │
      block?  执行   诊断反馈
         │      │      │
      跳过执行  │   追加到输出
                │
            循环结束
                │
              Stop
                │
          编译/测试验证
```

### 2.2 LSP 管理器

长驻的 LSP server 进程管理，挂在 UnifiedAgent 上，多个 sub-agent 共享。按需懒启动：第一次遇到对应语言的文件时才启动该语言的 LSP server。

### 2.3 Hook 与 Sub-agent 的关系

- Hooks 是 sub-agent **定义**的属性，在 `SUBAGENT_DEFINITIONS` 中声明
- 预定义类型（coding_expert）带 hooks，动态委派的 sub-agent 不带
- Worker 不感知也不干预 sub-agent 的 hooks
- Front Handler 不接入 hook 框架（简单 agent loop，不需要）

## 3. Hook 框架设计

### 3.1 事件类型

```typescript
type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop'
```

第一版三个事件，框架设计为 union type，后续扩展只需加类型。

### 3.2 Hook 定义

```typescript
interface HookDefinition {
  event: HookEvent
  matcher?: string            // 工具名匹配正则，如 "Write|Edit"，null = 匹配所有
  if?: string                 // 条件表达式，如 "Write(*.ts)" — 按文件后缀过滤
  type: 'command' | 'prompt'
  // command 类型
  command?: string            // shell 命令，或 __internal: 前缀标识内置处理器
  timeout?: number            // 秒，默认 30
  // prompt 类型
  prompt?: string             // LLM prompt 模板，$INPUT 替换为 JSON 输入
  model?: string              // 可选，默认用当前 agent 的 fast slot
}
```

### 3.3 Hook 输入/输出

```typescript
// 传给 hook 的上下文
interface HookInput {
  event: HookEvent
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string          // PostToolUse 时有值
  workingDirectory?: string
  filePaths?: string[]         // 从工具输入中提取的文件路径
}

// hook 返回
interface HookResult {
  action: 'continue' | 'block'
  message?: string             // 反馈给 LLM 的消息（诊断信息、阻止原因等）
  modifiedInput?: Record<string, unknown>  // 仅 PreToolUse 可修改工具输入
}
```

### 3.4 执行规则

| 事件 | block 行为 | message 行为 |
|------|-----------|-------------|
| PreToolUse | 工具不执行，message 作为工具错误返回给 LLM | 追加到工具输入的上下文 |
| PostToolUse | 追加 "请修复以上问题" 提示 | 追加到工具输出末尾 |
| Stop | 注入 message 作为 user 消息，引擎继续运行 | 注入为参考信息 |

### 3.5 注册与匹配

```typescript
class HookRegistry {
  register(hook: HookDefinition): void
  registerDefaults(agentType: string, context?: { lspManager?: LSPManager }): void

  // 引擎调用点
  async emit(event: HookEvent, input: HookInput): Promise<HookResult>
}
```

匹配逻辑（按顺序过滤）：
1. 按 `event` 过滤
2. 按 `matcher` 正则匹配 `toolName`（null = 全匹配）
3. 按 `if` 条件匹配文件路径后缀
4. 所有匹配的 hooks **并行执行**（`Promise.all`），收集结果

结果合并规则：
- 任一 hook 返回 `block` → 最终结果为 `block`
- 所有 `message` 用 `\n---\n` 拼接
- 多个 `modifiedInput` → 后面覆盖前面（按注册顺序）

## 4. Hook 执行器设计

### 4.1 Command Hook

```typescript
async function executeCommandHook(
  hook: HookDefinition,
  input: HookInput
): Promise<HookResult>
```

执行流程：
1. 检查 `__internal:` 前缀 → 走内置处理器（如 `__internal:lsp-diagnostics`）
2. 否则 spawn 子进程，`HookInput` JSON 通过 **stdin** 传入
3. 注入环境变量：`HOOK_EVENT`、`TOOL_NAME`、`WORKING_DIR`
4. 等待退出，超时则 kill

Exit code 约定：

| Code | 含义 | 行为 |
|------|------|------|
| 0 | 成功 | action: continue，stdout 作为 message（可选） |
| 2 | 阻塞 | action: block，stderr 作为 message |
| 其他 | 非阻塞警告 | action: continue，stderr 作为 message |

stdout 如果是合法 JSON 且包含 `action`/`message`/`modifiedInput` 字段，解析为结构化 `HookResult`；否则整体作为 `message` 字符串。

### 4.2 Prompt Hook

```typescript
async function executePromptHook(
  hook: HookDefinition,
  input: HookInput,
  adapter: LLMAdapter
): Promise<HookResult>
```

执行流程：
1. 将 `hook.prompt` 中的 `$INPUT` 替换为 `JSON.stringify(input)`
2. 单轮 LLM 调用（无工具），使用 agent 的 fast model slot
3. system prompt 固定："你是一个代码质量检查器。根据输入判断是否存在问题，返回 JSON 格式结果。"
4. 要求返回 `{ action: 'continue' | 'block', message?: string }`

### 4.3 并行执行与结果合并

```typescript
async function executeHooks(
  hooks: HookDefinition[],
  input: HookInput,
  context: { adapter: LLMAdapter, workingDir: string }
): Promise<HookResult>  // 合并后的单个结果
```

所有匹配的 hooks 通过 `Promise.all` 并行执行，按 §3.5 的合并规则产出单个结果。

## 5. LSP 管理器设计

### 5.1 架构

```
UnifiedAgent
  └── lspManager: LSPManager          （长驻，agent 级生命周期）
        ├── clients: Map<Language, LSPClient>
        └── diagnosticStore: DiagnosticStore

forkEngine (coding_expert)
  └── PostToolUse hook
        → lspManager.notifyFileChanged(filePath)
        → lspManager.getDiagnostics(filePath)
        → 诊断结果追加到工具输出
```

### 5.2 LSP 客户端（通用）

基于 `vscode-jsonrpc` + `vscode-languageserver-protocol` 库。

```typescript
interface LSPClient {
  initialize(rootUri: string): Promise<void>
  didOpen(filePath: string, content: string): void
  didChange(filePath: string, content: string): void
  didSave(filePath: string): void
  waitForDiagnostics(filePath: string, timeoutMs?: number): Promise<Diagnostic[]>
  shutdown(): Promise<void>
}
```

内部实现：
- `createMessageConnection(StreamMessageReader, StreamMessageWriter)` 建立 JSON-RPC 连接
- 监听 `textDocument/publishDiagnostics` 通知，写入 `DiagnosticStore`
- `waitForDiagnostics` 等待通知到达或超时（默认 3 秒）

### 5.3 四种语言配置

```typescript
type Language = 'typescript' | 'python' | 'rust' | 'go'

const LSP_CONFIGS: Record<Language, LSPServerConfig> = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    npmPackage: 'typescript-language-server',
    fileExtensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
  python: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    npmPackage: 'pyright',
    fileExtensions: ['.py'],
  },
  rust: {
    command: 'rust-analyzer',
    args: [],
    npmPackage: null,  // 需用户预装
    fileExtensions: ['.rs'],
  },
  go: {
    command: 'gopls',
    args: ['serve'],
    npmPackage: null,  // 需用户预装
    fileExtensions: ['.go'],
  },
}
```

### 5.4 LSP 管理器接口

```typescript
interface LSPManager {
  // 生命周期
  start(rootUri: string, languages?: Language[]): Promise<void>
  stop(): Promise<void>

  // 文件事件（由 hook 触发）
  notifyFileChanged(filePath: string, content: string): void

  // 诊断获取（PostToolUse hook 调用）
  getDiagnostics(filePath: string): Promise<FormattedDiagnostic[]>

  // 状态
  isLanguageAvailable(lang: Language): boolean
}
```

**懒启动策略**：不在 agent 启动时启动所有 4 个 LSP server。第一次遇到对应语言的文件时，检测文件后缀 → 查 `LSP_CONFIGS` → 启动对应 LSP server → 后续复用。

### 5.5 诊断存储

```typescript
interface DiagnosticStore {
  update(filePath: string, diagnostics: Diagnostic[]): void
  get(filePath: string): FormattedDiagnostic[]
  clear(filePath: string): void
}

interface FormattedDiagnostic {
  filePath: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'info'
  message: string
  source: string  // 'typescript' | 'pyright' | 'rust-analyzer' | 'gopls'
}
```

限制：
- 每个文件最多 10 条诊断
- 仅返回 error + warning（忽略 info/hint）
- 避免信息过载让 LLM 分心

## 6. 引擎层集成

### 6.1 接入点

在 `tool-orchestration.ts` 中 `executeToolBatches` 插入 PreToolUse 和 PostToolUse：

```
for each toolCall:
  【PreToolUse】hookRegistry.emit('PreToolUse', { toolName, toolInput })
    → block? 跳过执行，返回 hook message 作为工具错误
    → modifiedInput? 替换 toolInput

  tool.call(toolInput)  // 实际执行

  【PostToolUse】hookRegistry.emit('PostToolUse', { toolName, toolInput, toolOutput })
    → message? 追加到 toolOutput 末尾
    → block? 额外追加 "请修复以上问题后继续"
```

在 `query-loop.ts` 中 `runEngine` 结束前插入 Stop：

```
【Stop】hookRegistry.emit('Stop', { result })
  → block? 注入 message 作为 user 消息，继续循环
  → continue? 正常结束
```

### 6.2 EngineOptions 扩展

```typescript
interface EngineOptions {
  // ... 现有字段
  hookRegistry?: HookRegistry  // 新增，可选
}
```

### 6.3 改动范围

| 文件 | 改动量 | 说明 |
|------|--------|------|
| `tool-orchestration.ts` | ~30 行 | PreToolUse + PostToolUse 插入 |
| `query-loop.ts` | ~15 行 | Stop hook 插入 |
| `engine/types.ts` | ~5 行 | EngineOptions 新增 hookRegistry |

## 7. coding_expert 默认 Hooks

### 7.1 在 SUBAGENT_DEFINITIONS 中声明

```typescript
{
  slotKey: 'coding_expert',
  toolName: 'delegate_to_coding_expert',
  systemPrompt: '...',
  maxTurns: 30,
  hooks: 'coding_expert',  // 引用默认 hook 集合名
}
```

### 7.2 默认 Hook 集合

```typescript
function getCodingExpertHooks(lspManager: LSPManager): HookDefinition[] {
  return [
    // 1. LSP 诊断 — 文件编辑后获取类型/语法错误
    {
      event: 'PostToolUse',
      matcher: 'Write|Edit',
      type: 'command',
      command: '__internal:lsp-diagnostics',
    },

    // 2. 编译检查 — sub-agent 结束前验证构建（自动检测项目类型）
    {
      event: 'Stop',
      type: 'command',
      command: '__internal:compile-check',
      timeout: 60,
    },

    // 3. 测试评估 — 用 LLM 判断是否需要运行测试
    {
      event: 'Stop',
      type: 'prompt',
      prompt: '分析以下代码变更，判断是否需要运行测试。如果需要，指出应该运行哪些测试文件。变更内容：$INPUT',
      model: 'fast',
    },
  ]
}
```

`__internal:compile-check` 内置处理器逻辑：
1. 检测工作目录中的项目类型（package.json → npm, Cargo.toml → cargo, go.mod → go, pyproject.toml/setup.py → python）
2. 运行对应编译命令（`npm run build --if-present`、`cargo check`、`go build ./...`、`python -m py_compile`）
3. 编译失败 → `{ action: 'block', message: stderr }`
4. 编译成功 → `{ action: 'continue' }`

`__internal:lsp-diagnostics` 内置处理器逻辑：
1. 从 `toolInput` 提取文件路径
2. 调用 `lspManager.notifyFileChanged(filePath, content)`
3. 调用 `lspManager.getDiagnostics(filePath)` 等待诊断（超时 3 秒）
4. 有 error 级诊断 → `{ action: 'block', message: formatDiagnostics(...) }`
5. 仅 warning → `{ action: 'continue', message: formatDiagnostics(...) }`
6. 无诊断 → `{ action: 'continue' }`

### 7.3 Sub-agent 创建时注入

在 `sub-agent.ts` 的 `createSubAgentTool` 中：

```typescript
const hookRegistry = new HookRegistry()
if (config.hooks) {
  hookRegistry.registerDefaults(config.hooks, { lspManager })
}
forkEngine({ ..., hookRegistry })
```

## 8. 文件结构

```
src/
├── hooks/                        # 新增：Hook 框架
│   ├── types.ts                  # HookEvent, HookDefinition, HookInput, HookResult
│   ├── hook-registry.ts          # HookRegistry 类（注册、匹配、emit）
│   ├── hook-executor.ts          # executeHooks（并行执行、结果合并）
│   ├── command-hook.ts           # command 类型执行器
│   ├── prompt-hook.ts            # prompt 类型执行器
│   └── defaults.ts               # coding_expert 默认 hook 集合
├── lsp/                          # 新增：LSP 管理器
│   ├── lsp-client.ts             # 通用 LSP 客户端（vscode-jsonrpc 封装）
│   ├── lsp-manager.ts            # 多语言 LSP 生命周期管理
│   ├── diagnostic-store.ts       # 诊断收集、去重、格式化
│   └── configs.ts                # 四种语言的启动配置
├── engine/
│   ├── tool-orchestration.ts     # 修改：插入 PreToolUse / PostToolUse
│   ├── query-loop.ts             # 修改：插入 Stop hook
│   ├── types.ts                  # 修改：EngineOptions 新增 hookRegistry
│   └── sub-agent.ts              # 修改：创建时注入 hookRegistry
└── unified-agent.ts              # 修改：初始化 LSPManager
```

### 代码量估算

| 模块 | 估算行数 |
|------|---------|
| hooks/ | ~500 行 |
| lsp/ | ~600-800 行 |
| 引擎层改动 | ~50 行 |
| **总计** | **~1150-1350 行** |

### npm 依赖新增

| 包名 | 用途 |
|------|------|
| `vscode-jsonrpc` | LSP JSON-RPC 通信层 |
| `vscode-languageserver-protocol` | LSP 类型定义和方法 |

## 9. 不在第一版范围内

- Front Handler 接入 hook 框架
- Worker 配置 hooks
- 动态委派的 sub-agent 配置 hooks
- hook 类型扩展（agent/http/callback）
- Hook 配置化（Admin UI 管理 hooks）
- LSP 的 hover/definition/references 等非诊断功能
- LSP server 自动安装（rust-analyzer、gopls 需预装）
