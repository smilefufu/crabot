# Hook 框架 + LSP 诊断管理器实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 crabot-agent 引擎添加通用 Hook 框架（PreToolUse/PostToolUse/Stop）和 LSP 诊断管理器（TS/Python/Rust/Go），第一版仅 coding_expert sub-agent 配置 hooks。

**Architecture:** Hook 框架是引擎层的可选扩展，通过 `HookRegistry` 在工具执行前后和引擎停止时触发用户定义的 hooks。LSP 管理器是独立模块，挂在 UnifiedAgent 上，通过 PostToolUse hook 为 coding_expert 提供实时诊断反馈。两个模块正交，可独立测试。

**Tech Stack:** TypeScript, vitest, vscode-jsonrpc (已在 package.json), vscode-languageserver-protocol (已在 package.json)

**Spec:** `crabot-agent/docs/specs/2026-04-14-hook-framework-and-lsp-design.md`

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/hooks/types.ts` | HookEvent, HookDefinition, HookInput, HookResult 类型定义 |
| `src/hooks/hook-registry.ts` | HookRegistry 类 — 注册、匹配、emit |
| `src/hooks/hook-executor.ts` | 并行执行多个 hooks 并合并结果 |
| `src/hooks/command-hook.ts` | command 类型执行器（shell + 内置处理器） |
| `src/hooks/prompt-hook.ts` | prompt 类型执行器（单轮 LLM 调用） |
| `src/hooks/internal-handlers.ts` | 内置处理器注册表（lsp-diagnostics, compile-check） |
| `src/hooks/defaults.ts` | coding_expert 默认 hook 集合 |
| `src/lsp/lsp-client.ts` | 通用 LSP 客户端（vscode-jsonrpc 封装） |
| `src/lsp/lsp-manager.ts` | 多语言 LSP 生命周期管理 |
| `src/lsp/diagnostic-store.ts` | 诊断收集、去重、格式化 |
| `src/lsp/configs.ts` | 四种语言的 LSP server 配置 |
| `tests/engine/hooks/hook-registry.test.ts` | HookRegistry 单元测试 |
| `tests/engine/hooks/hook-executor.test.ts` | 并行执行和结果合并测试 |
| `tests/engine/hooks/command-hook.test.ts` | command hook 执行测试 |
| `tests/engine/hooks/prompt-hook.test.ts` | prompt hook 执行测试 |
| `tests/engine/hooks/tool-orchestration-hooks.test.ts` | 引擎集成测试 |
| `tests/lsp/diagnostic-store.test.ts` | DiagnosticStore 单元测试 |
| `tests/lsp/lsp-client.test.ts` | LSPClient 单元测试 |
| `tests/lsp/lsp-manager.test.ts` | LSPManager 单元测试 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/engine/types.ts:135-147` | EngineOptions 新增 `hookRegistry` 字段 |
| `src/engine/tool-orchestration.ts:14-42` | executeSingleTool 插入 PreToolUse/PostToolUse |
| `src/engine/tool-orchestration.ts:81-101` | executeToolBatches 透传 hookRegistry |
| `src/engine/query-loop.ts:131-134` | Stop hook 插入（natural completion） |
| `src/engine/query-loop.ts:247-248` | Stop hook 插入（max_turns） |
| `src/engine/sub-agent.ts:12-34` | ForkEngineParams 新增 `hookRegistry` |
| `src/engine/sub-agent.ts:66-78` | forkEngine 透传 hookRegistry 到 runEngine |
| `src/engine/sub-agent.ts:101-114` | SubAgentToolConfig 新增 `hookRegistry` |
| `src/engine/sub-agent.ts:213-225` | createSubAgentTool 透传 hookRegistry |
| `src/agent/subagent-prompts.ts:8-25` | SubAgentDefinition 新增 `hooks` 字段 |
| `src/agent/subagent-prompts.ts:47-65` | coding_expert 定义添加 `hooks: 'coding_expert'` |
| `src/agent/worker-handler.ts:351-364` | 创建 sub-agent 时传入 hookRegistry |
| `src/unified-agent.ts` | 初始化 LSPManager，传递给 worker-handler |

---

## Task 1: Hook 类型定义

**Files:**
- Create: `src/hooks/types.ts`
- Test: `tests/engine/hooks/hook-registry.test.ts` (类型测试部分)

- [ ] **Step 1: 创建 `src/hooks/types.ts`**

```typescript
import type { LLMAdapter } from '../engine/llm-adapter'

// --- Hook Events ---

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop'

// --- Hook Definition ---

export interface HookDefinition {
  /** Which event this hook listens to */
  readonly event: HookEvent
  /** Regex pattern to match tool names (e.g. "Write|Edit"). null = match all. Only for PreToolUse/PostToolUse. */
  readonly matcher?: string
  /** Condition expression for file extension filtering (e.g. "Write(*.ts)"). Only for PreToolUse/PostToolUse. */
  readonly if?: string
  /** Hook execution type */
  readonly type: 'command' | 'prompt'
  /** Shell command to execute, or __internal:<handler-name> for built-in handlers. Required for type='command'. */
  readonly command?: string
  /** Timeout in seconds. Default: 30 */
  readonly timeout?: number
  /** LLM prompt template. $INPUT is replaced with JSON input. Required for type='prompt'. */
  readonly prompt?: string
  /** Model to use for prompt hooks. Default: agent's fast slot. */
  readonly model?: string
}

// --- Hook Input (context passed to hooks) ---

export interface HookInput {
  readonly event: HookEvent
  readonly toolName?: string
  readonly toolInput?: Record<string, unknown>
  readonly toolOutput?: string
  readonly workingDirectory?: string
  readonly filePaths?: string[]
}

// --- Hook Result ---

export interface HookResult {
  readonly action: 'continue' | 'block'
  readonly message?: string
  readonly modifiedInput?: Record<string, unknown>
}

// --- Internal Handler ---

export type InternalHandler = (input: HookInput, context: InternalHandlerContext) => Promise<HookResult>

export interface InternalHandlerContext {
  readonly workingDirectory: string
  readonly lspManager?: LspManagerLike
}

/** Minimal interface for LSP manager dependency (avoids circular imports) */
export interface LspManagerLike {
  notifyFileChanged(filePath: string, content: string): void
  getDiagnostics(filePath: string): Promise<ReadonlyArray<FormattedDiagnostic>>
  isLanguageAvailable(lang: string): boolean
}

export interface FormattedDiagnostic {
  readonly filePath: string
  readonly line: number
  readonly column: number
  readonly severity: 'error' | 'warning' | 'info'
  readonly message: string
  readonly source: string
}

// --- Hook Executor Context ---

export interface HookExecutorContext {
  readonly adapter?: LLMAdapter
  readonly model?: string
  readonly workingDirectory: string
  readonly lspManager?: LspManagerLike
}
```

- [ ] **Step 2: 验证类型编译通过**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx tsc --noEmit src/hooks/types.ts`
Expected: 无错误输出

- [ ] **Step 3: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-agent
git add src/hooks/types.ts
git commit -m "feat(hooks): add hook framework type definitions"
```

---

## Task 2: HookRegistry — 注册与匹配

**Files:**
- Create: `src/hooks/hook-registry.ts`
- Test: `tests/engine/hooks/hook-registry.test.ts`

- [ ] **Step 1: 编写 HookRegistry 测试**

```typescript
import { describe, it, expect } from 'vitest'
import { HookRegistry } from '../../../src/hooks/hook-registry'
import type { HookDefinition, HookResult } from '../../../src/hooks/types'

describe('HookRegistry', () => {
  describe('register and getMatching', () => {
    it('returns hooks matching event type', () => {
      const registry = new HookRegistry()
      const hook: HookDefinition = {
        event: 'PreToolUse',
        type: 'command',
        command: 'echo test',
      }
      registry.register(hook)

      const matches = registry.getMatching('PreToolUse', { event: 'PreToolUse', toolName: 'Write' })
      expect(matches).toHaveLength(1)
      expect(matches[0]).toBe(hook)
    })

    it('returns empty for non-matching event', () => {
      const registry = new HookRegistry()
      registry.register({ event: 'PreToolUse', type: 'command', command: 'echo' })

      const matches = registry.getMatching('PostToolUse', { event: 'PostToolUse', toolName: 'Write' })
      expect(matches).toHaveLength(0)
    })

    it('filters by matcher regex', () => {
      const registry = new HookRegistry()
      registry.register({ event: 'PostToolUse', matcher: 'Write|Edit', type: 'command', command: 'echo' })

      expect(registry.getMatching('PostToolUse', { event: 'PostToolUse', toolName: 'Write' })).toHaveLength(1)
      expect(registry.getMatching('PostToolUse', { event: 'PostToolUse', toolName: 'Edit' })).toHaveLength(1)
      expect(registry.getMatching('PostToolUse', { event: 'PostToolUse', toolName: 'Bash' })).toHaveLength(0)
    })

    it('null matcher matches all tools', () => {
      const registry = new HookRegistry()
      registry.register({ event: 'PreToolUse', type: 'command', command: 'echo' })

      expect(registry.getMatching('PreToolUse', { event: 'PreToolUse', toolName: 'AnyTool' })).toHaveLength(1)
    })

    it('filters by if condition (file extension)', () => {
      const registry = new HookRegistry()
      registry.register({ event: 'PostToolUse', matcher: 'Write', if: 'Write(*.ts)', type: 'command', command: 'echo' })

      expect(registry.getMatching('PostToolUse', {
        event: 'PostToolUse', toolName: 'Write', filePaths: ['/src/foo.ts'],
      })).toHaveLength(1)

      expect(registry.getMatching('PostToolUse', {
        event: 'PostToolUse', toolName: 'Write', filePaths: ['/src/foo.py'],
      })).toHaveLength(0)
    })

    it('Stop hooks ignore matcher and if', () => {
      const registry = new HookRegistry()
      registry.register({ event: 'Stop', type: 'command', command: 'npm test' })

      expect(registry.getMatching('Stop', { event: 'Stop' })).toHaveLength(1)
    })
  })

  describe('isEmpty', () => {
    it('returns true when no hooks registered', () => {
      expect(new HookRegistry().isEmpty()).toBe(true)
    })

    it('returns false after registering a hook', () => {
      const registry = new HookRegistry()
      registry.register({ event: 'Stop', type: 'command', command: 'echo' })
      expect(registry.isEmpty()).toBe(false)
    })
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/hooks/hook-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 `src/hooks/hook-registry.ts`**

```typescript
import type { HookDefinition, HookEvent, HookInput } from './types'

export class HookRegistry {
  private readonly hooks: HookDefinition[] = []

  register(hook: HookDefinition): void {
    this.hooks.push(hook)
  }

  registerAll(hooks: ReadonlyArray<HookDefinition>): void {
    for (const hook of hooks) {
      this.hooks.push(hook)
    }
  }

  isEmpty(): boolean {
    return this.hooks.length === 0
  }

  getMatching(event: HookEvent, input: HookInput): ReadonlyArray<HookDefinition> {
    return this.hooks.filter((hook) => {
      // 1. Event must match
      if (hook.event !== event) return false

      // 2. Stop hooks skip matcher/if filtering
      if (event === 'Stop') return true

      // 3. Matcher: regex against toolName
      if (hook.matcher !== undefined && input.toolName !== undefined) {
        const regex = new RegExp(`^(?:${hook.matcher})$`)
        if (!regex.test(input.toolName)) return false
      }

      // 4. If condition: file extension matching
      if (hook.if !== undefined && input.filePaths !== undefined) {
        if (!matchIfCondition(hook.if, input.filePaths)) return false
      }

      return true
    })
  }
}

/**
 * Parse if condition like "Write(*.ts)" and match against file paths.
 * Extracts the glob pattern from parens and tests file extensions.
 */
function matchIfCondition(condition: string, filePaths: ReadonlyArray<string>): boolean {
  const match = condition.match(/\(([^)]+)\)/)
  if (!match) return true // No pattern means match all

  const pattern = match[1]
  // Convert glob pattern to regex: *.ts -> \.ts$
  const extMatch = pattern.match(/^\*(\.\w+)$/)
  if (!extMatch) return true // Unsupported pattern, pass through

  const extension = extMatch[1]
  return filePaths.some((fp) => fp.endsWith(extension))
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/hooks/hook-registry.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-agent
git add src/hooks/hook-registry.ts tests/engine/hooks/hook-registry.test.ts
git commit -m "feat(hooks): implement HookRegistry with matching logic"
```

---

## Task 3: Command Hook 执行器

**Files:**
- Create: `src/hooks/command-hook.ts`
- Create: `src/hooks/internal-handlers.ts`
- Test: `tests/engine/hooks/command-hook.test.ts`

- [ ] **Step 1: 编写 command hook 测试**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { executeCommandHook } from '../../../src/hooks/command-hook'
import type { HookDefinition, HookInput } from '../../../src/hooks/types'

const baseInput: HookInput = {
  event: 'PostToolUse',
  toolName: 'Write',
  toolInput: { file_path: '/tmp/test.ts', content: 'const x = 1' },
  workingDirectory: '/tmp',
}

describe('executeCommandHook', () => {
  it('exit 0 returns continue with stdout as message', async () => {
    const hook: HookDefinition = { event: 'PostToolUse', type: 'command', command: 'echo "all good"' }
    const result = await executeCommandHook(hook, baseInput, { workingDirectory: '/tmp' })

    expect(result.action).toBe('continue')
    expect(result.message).toContain('all good')
  })

  it('exit 2 returns block with stderr as message', async () => {
    const hook: HookDefinition = { event: 'PostToolUse', type: 'command', command: 'echo "error found" >&2; exit 2' }
    const result = await executeCommandHook(hook, baseInput, { workingDirectory: '/tmp' })

    expect(result.action).toBe('block')
    expect(result.message).toContain('error found')
  })

  it('other exit codes return continue with stderr as message', async () => {
    const hook: HookDefinition = { event: 'PostToolUse', type: 'command', command: 'echo "warning" >&2; exit 1' }
    const result = await executeCommandHook(hook, baseInput, { workingDirectory: '/tmp' })

    expect(result.action).toBe('continue')
    expect(result.message).toContain('warning')
  })

  it('parses JSON stdout with action/message fields', async () => {
    const hook: HookDefinition = {
      event: 'PostToolUse', type: 'command',
      command: `echo '{"action":"block","message":"type error on line 5"}'`,
    }
    const result = await executeCommandHook(hook, baseInput, { workingDirectory: '/tmp' })

    expect(result.action).toBe('block')
    expect(result.message).toBe('type error on line 5')
  })

  it('respects timeout and returns continue on timeout', async () => {
    const hook: HookDefinition = { event: 'PostToolUse', type: 'command', command: 'sleep 10', timeout: 1 }
    const result = await executeCommandHook(hook, baseInput, { workingDirectory: '/tmp' })

    expect(result.action).toBe('continue')
    expect(result.message).toContain('timeout')
  }, 5000)

  it('passes HookInput as JSON via stdin', async () => {
    const hook: HookDefinition = {
      event: 'PostToolUse', type: 'command',
      // Read stdin and echo the toolName field
      command: 'cat | node -e "process.stdin.on(\'data\',d=>{const j=JSON.parse(d);console.log(j.toolName)})"',
    }
    const result = await executeCommandHook(hook, baseInput, { workingDirectory: '/tmp' })

    expect(result.action).toBe('continue')
    expect(result.message).toContain('Write')
  })

  it('routes __internal: prefix to internal handler', async () => {
    const hook: HookDefinition = {
      event: 'PostToolUse', type: 'command',
      command: '__internal:lsp-diagnostics',
    }
    // Without lspManager, should return continue with no diagnostics
    const result = await executeCommandHook(hook, baseInput, { workingDirectory: '/tmp' })

    expect(result.action).toBe('continue')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/hooks/command-hook.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 `src/hooks/internal-handlers.ts`**

```typescript
import type { HookInput, HookResult, InternalHandler, InternalHandlerContext, FormattedDiagnostic } from './types'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const handlers = new Map<string, InternalHandler>()

export function registerInternalHandler(name: string, handler: InternalHandler): void {
  handlers.set(name, handler)
}

export function getInternalHandler(name: string): InternalHandler | undefined {
  return handlers.get(name)
}

// --- Built-in: lsp-diagnostics ---

registerInternalHandler('lsp-diagnostics', async (input, context) => {
  if (!context.lspManager) {
    return { action: 'continue' }
  }

  const filePath = extractFilePath(input.toolInput)
  if (!filePath) {
    return { action: 'continue' }
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    context.lspManager.notifyFileChanged(filePath, content)
    const diagnostics = await context.lspManager.getDiagnostics(filePath)

    if (diagnostics.length === 0) {
      return { action: 'continue' }
    }

    const message = formatDiagnosticsMessage(diagnostics)
    const hasErrors = diagnostics.some((d) => d.severity === 'error')

    return {
      action: hasErrors ? 'block' : 'continue',
      message,
    }
  } catch {
    return { action: 'continue' }
  }
})

// --- Built-in: compile-check ---

registerInternalHandler('compile-check', async (_input, context) => {
  const cwd = context.workingDirectory
  const detected = detectProjectType(cwd)

  if (!detected) {
    return { action: 'continue' }
  }

  try {
    execSync(detected.command, { cwd, timeout: 55_000, stdio: 'pipe' })
    return { action: 'continue' }
  } catch (error: unknown) {
    const stderr = error instanceof Error && 'stderr' in error
      ? String((error as { stderr: unknown }).stderr)
      : String(error)
    return {
      action: 'block',
      message: `Compile check failed (${detected.type}):\n${stderr.slice(0, 2000)}`,
    }
  }
})

// --- Helpers ---

function extractFilePath(toolInput?: Record<string, unknown>): string | undefined {
  if (!toolInput) return undefined
  // Write tool uses file_path, Edit tool uses file_path
  const fp = toolInput.file_path ?? toolInput.filePath ?? toolInput.path
  return typeof fp === 'string' ? fp : undefined
}

function formatDiagnosticsMessage(diagnostics: ReadonlyArray<FormattedDiagnostic>): string {
  const lines = diagnostics.map((d) =>
    `${d.filePath}:${d.line}:${d.column} [${d.severity.toUpperCase()}] ${d.message} (${d.source})`
  )
  return `LSP Diagnostics:\n${lines.join('\n')}`
}

interface ProjectType {
  readonly type: string
  readonly command: string
}

function detectProjectType(cwd: string): ProjectType | undefined {
  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    return { type: 'node', command: 'npm run build --if-present 2>&1' }
  }
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    return { type: 'rust', command: 'cargo check 2>&1' }
  }
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return { type: 'go', command: 'go build ./... 2>&1' }
  }
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'setup.py'))) {
    return { type: 'python', command: 'python -m py_compile $(find . -name "*.py" -not -path "*/venv/*" | head -20) 2>&1' }
  }
  return undefined
}
```

- [ ] **Step 4: 实现 `src/hooks/command-hook.ts`**

```typescript
import { spawn } from 'child_process'
import type { HookDefinition, HookInput, HookResult, InternalHandlerContext } from './types'
import { getInternalHandler } from './internal-handlers'

const DEFAULT_TIMEOUT_SECONDS = 30

export async function executeCommandHook(
  hook: HookDefinition,
  input: HookInput,
  context: InternalHandlerContext,
): Promise<HookResult> {
  const command = hook.command
  if (!command) {
    return { action: 'continue' }
  }

  // Route __internal: prefix to built-in handlers
  if (command.startsWith('__internal:')) {
    const handlerName = command.slice('__internal:'.length)
    const handler = getInternalHandler(handlerName)
    if (!handler) {
      return { action: 'continue', message: `Unknown internal handler: ${handlerName}` }
    }
    return handler(input, context)
  }

  // Execute shell command
  const timeoutMs = (hook.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000
  const inputJson = JSON.stringify(input)

  return new Promise<HookResult>((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd: context.workingDirectory,
      env: {
        ...process.env,
        HOOK_EVENT: input.event,
        TOOL_NAME: input.toolName ?? '',
        WORKING_DIR: context.workingDirectory,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })

    // Write input JSON to stdin
    child.stdin.write(inputJson)
    child.stdin.end()

    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || error.message.includes('timeout')) {
        resolve({ action: 'continue', message: `Hook timeout after ${hook.timeout ?? DEFAULT_TIMEOUT_SECONDS}s` })
      } else {
        resolve({ action: 'continue', message: `Hook error: ${error.message}` })
      }
    })

    child.on('close', (code) => {
      if (code === null) {
        resolve({ action: 'continue', message: `Hook timeout after ${hook.timeout ?? DEFAULT_TIMEOUT_SECONDS}s` })
        return
      }

      // Try to parse stdout as structured JSON
      const trimmedStdout = stdout.trim()
      if (trimmedStdout.length > 0) {
        try {
          const parsed = JSON.parse(trimmedStdout)
          if (typeof parsed === 'object' && parsed !== null && 'action' in parsed) {
            resolve({
              action: parsed.action === 'block' ? 'block' : 'continue',
              message: typeof parsed.message === 'string' ? parsed.message : undefined,
              modifiedInput: typeof parsed.modifiedInput === 'object' ? parsed.modifiedInput : undefined,
            })
            return
          }
        } catch {
          // Not valid JSON, fall through to exit code handling
        }
      }

      // Exit code convention
      if (code === 0) {
        resolve({
          action: 'continue',
          message: trimmedStdout.length > 0 ? trimmedStdout : undefined,
        })
      } else if (code === 2) {
        resolve({
          action: 'block',
          message: stderr.trim() || trimmedStdout || 'Hook blocked execution',
        })
      } else {
        resolve({
          action: 'continue',
          message: stderr.trim() || undefined,
        })
      }
    })
  })
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/hooks/command-hook.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-agent
git add src/hooks/command-hook.ts src/hooks/internal-handlers.ts tests/engine/hooks/command-hook.test.ts
git commit -m "feat(hooks): implement command hook executor with internal handlers"
```

---

## Task 4: Prompt Hook 执行器

**Files:**
- Create: `src/hooks/prompt-hook.ts`
- Test: `tests/engine/hooks/prompt-hook.test.ts`

- [ ] **Step 1: 编写 prompt hook 测试**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { executePromptHook } from '../../../src/hooks/prompt-hook'
import type { HookDefinition, HookInput } from '../../../src/hooks/types'
import type { LLMAdapter } from '../../../src/engine/llm-adapter'
import type { StreamChunk } from '../../../src/engine/types'

function mockAdapter(responseText: string): LLMAdapter {
  return {
    async *stream() {
      yield { type: 'message_start' as const, messageId: 'msg-1' }
      yield { type: 'text_delta' as const, text: responseText }
      yield { type: 'message_end' as const, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }
    },
    updateConfig() {},
  }
}

const baseInput: HookInput = {
  event: 'Stop',
  workingDirectory: '/tmp',
}

describe('executePromptHook', () => {
  it('parses JSON response with action and message', async () => {
    const adapter = mockAdapter('{"action":"block","message":"tests are failing"}')
    const hook: HookDefinition = {
      event: 'Stop', type: 'prompt',
      prompt: 'Check if tests pass. Context: $INPUT',
    }

    const result = await executePromptHook(hook, baseInput, adapter, 'test-model')
    expect(result.action).toBe('block')
    expect(result.message).toBe('tests are failing')
  })

  it('returns continue when LLM says continue', async () => {
    const adapter = mockAdapter('{"action":"continue","message":"all looks good"}')
    const hook: HookDefinition = { event: 'Stop', type: 'prompt', prompt: 'Check: $INPUT' }

    const result = await executePromptHook(hook, baseInput, adapter, 'test-model')
    expect(result.action).toBe('continue')
  })

  it('returns continue on unparseable response', async () => {
    const adapter = mockAdapter('I think everything is fine')
    const hook: HookDefinition = { event: 'Stop', type: 'prompt', prompt: 'Check: $INPUT' }

    const result = await executePromptHook(hook, baseInput, adapter, 'test-model')
    expect(result.action).toBe('continue')
    expect(result.message).toContain('everything is fine')
  })

  it('substitutes $INPUT in prompt template', async () => {
    let capturedMessages: unknown
    const adapter: LLMAdapter = {
      async *stream(params) {
        capturedMessages = params.messages
        yield { type: 'message_start' as const, messageId: 'msg-1' }
        yield { type: 'text_delta' as const, text: '{"action":"continue"}' }
        yield { type: 'message_end' as const, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }
      },
      updateConfig() {},
    }
    const hook: HookDefinition = { event: 'Stop', type: 'prompt', prompt: 'Analyze: $INPUT' }
    const input: HookInput = { event: 'Stop', workingDirectory: '/project' }

    await executePromptHook(hook, input, adapter, 'test-model')

    // Verify $INPUT was replaced with JSON
    const msgs = capturedMessages as Array<{ content: string }>
    expect(msgs[0].content).toContain('/project')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/hooks/prompt-hook.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 `src/hooks/prompt-hook.ts`**

```typescript
import type { LLMAdapter } from '../engine/llm-adapter'
import type { HookDefinition, HookInput, HookResult } from './types'
import { StreamProcessor } from '../engine/stream-processor'

const SYSTEM_PROMPT = [
  '你是一个代码质量检查器。根据输入判断是否存在问题。',
  '你必须返回 JSON 格式的结果：{"action": "continue" | "block", "message": "可选的说明"}',
  '- "continue" 表示没有问题或问题不严重',
  '- "block" 表示有严重问题需要修复',
].join('\n')

export async function executePromptHook(
  hook: HookDefinition,
  input: HookInput,
  adapter: LLMAdapter,
  model: string,
): Promise<HookResult> {
  const template = hook.prompt ?? ''
  const prompt = template.replace(/\$INPUT/g, JSON.stringify(input))

  try {
    const processor = new StreamProcessor()
    const stream = adapter.stream({
      messages: [{ id: 'hook-msg', role: 'user' as const, content: prompt, timestamp: Date.now() }],
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      model: hook.model ?? model,
    })

    for await (const chunk of stream) {
      if (chunk.type === 'error') break
      processor.process(chunk)
    }

    const processed = processor.finalize()
    const text = processed.text.trim()

    // Try to parse as JSON
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && 'action' in parsed) {
        return {
          action: parsed.action === 'block' ? 'block' : 'continue',
          message: typeof parsed.message === 'string' ? parsed.message : undefined,
        }
      }
    } catch {
      // Not JSON — treat the whole text as a message, action=continue
    }

    return {
      action: 'continue',
      message: text.length > 0 ? text : undefined,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { action: 'continue', message: `Prompt hook error: ${message}` }
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/hooks/prompt-hook.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-agent
git add src/hooks/prompt-hook.ts tests/engine/hooks/prompt-hook.test.ts
git commit -m "feat(hooks): implement prompt hook executor with LLM evaluation"
```

---

## Task 5: Hook Executor — 并行执行与结果合并

**Files:**
- Create: `src/hooks/hook-executor.ts`
- Test: `tests/engine/hooks/hook-executor.test.ts`

- [ ] **Step 1: 编写 hook-executor 测试**

```typescript
import { describe, it, expect } from 'vitest'
import { executeHooks } from '../../../src/hooks/hook-executor'
import type { HookDefinition, HookInput, HookExecutorContext } from '../../../src/hooks/types'

const baseInput: HookInput = { event: 'PostToolUse', toolName: 'Write', workingDirectory: '/tmp' }
const baseContext: HookExecutorContext = { workingDirectory: '/tmp' }

describe('executeHooks', () => {
  it('returns continue with no message when no hooks', async () => {
    const result = await executeHooks([], baseInput, baseContext)
    expect(result.action).toBe('continue')
    expect(result.message).toBeUndefined()
  })

  it('merges multiple continue results', async () => {
    const hooks: HookDefinition[] = [
      { event: 'PostToolUse', type: 'command', command: 'echo "check 1 ok"' },
      { event: 'PostToolUse', type: 'command', command: 'echo "check 2 ok"' },
    ]
    const result = await executeHooks(hooks, baseInput, baseContext)
    expect(result.action).toBe('continue')
    expect(result.message).toContain('check 1 ok')
    expect(result.message).toContain('check 2 ok')
  })

  it('any block makes final result block', async () => {
    const hooks: HookDefinition[] = [
      { event: 'PostToolUse', type: 'command', command: 'echo "ok"' },
      { event: 'PostToolUse', type: 'command', command: 'echo "error" >&2; exit 2' },
    ]
    const result = await executeHooks(hooks, baseInput, baseContext)
    expect(result.action).toBe('block')
  })

  it('concatenates messages with separator', async () => {
    const hooks: HookDefinition[] = [
      { event: 'PostToolUse', type: 'command', command: 'echo "msg1"' },
      { event: 'PostToolUse', type: 'command', command: 'echo "msg2"' },
    ]
    const result = await executeHooks(hooks, baseInput, baseContext)
    expect(result.message).toContain('msg1')
    expect(result.message).toContain('msg2')
    expect(result.message).toContain('---')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/hooks/hook-executor.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/hooks/hook-executor.ts`**

```typescript
import type { HookDefinition, HookInput, HookResult, HookExecutorContext } from './types'
import { executeCommandHook } from './command-hook'
import { executePromptHook } from './prompt-hook'

const EMPTY_RESULT: HookResult = { action: 'continue' }
const MESSAGE_SEPARATOR = '\n---\n'

export async function executeHooks(
  hooks: ReadonlyArray<HookDefinition>,
  input: HookInput,
  context: HookExecutorContext,
): Promise<HookResult> {
  if (hooks.length === 0) return EMPTY_RESULT

  const results = await Promise.all(
    hooks.map((hook) => executeSingleHook(hook, input, context))
  )

  return mergeResults(results)
}

async function executeSingleHook(
  hook: HookDefinition,
  input: HookInput,
  context: HookExecutorContext,
): Promise<HookResult> {
  try {
    if (hook.type === 'command') {
      return await executeCommandHook(hook, input, {
        workingDirectory: context.workingDirectory,
        lspManager: context.lspManager,
      })
    }

    if (hook.type === 'prompt' && context.adapter) {
      return await executePromptHook(
        hook, input, context.adapter, hook.model ?? context.model ?? ''
      )
    }

    return EMPTY_RESULT
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { action: 'continue', message: `Hook execution error: ${message}` }
  }
}

function mergeResults(results: ReadonlyArray<HookResult>): HookResult {
  let action: 'continue' | 'block' = 'continue'
  const messages: string[] = []
  let modifiedInput: Record<string, unknown> | undefined

  for (const result of results) {
    if (result.action === 'block') {
      action = 'block'
    }
    if (result.message !== undefined) {
      messages.push(result.message)
    }
    if (result.modifiedInput !== undefined) {
      modifiedInput = { ...modifiedInput, ...result.modifiedInput }
    }
  }

  return {
    action,
    message: messages.length > 0 ? messages.join(MESSAGE_SEPARATOR) : undefined,
    modifiedInput,
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/hooks/hook-executor.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-agent
git add src/hooks/hook-executor.ts tests/engine/hooks/hook-executor.test.ts
git commit -m "feat(hooks): implement parallel hook execution with result merging"
```

---

## Task 6: 引擎层集成 — PreToolUse, PostToolUse, Stop

**Files:**
- Modify: `src/engine/types.ts:135-147`
- Modify: `src/engine/tool-orchestration.ts:14-42, 81-101`
- Modify: `src/engine/query-loop.ts:131-134, 247-248`
- Test: `tests/engine/hooks/tool-orchestration-hooks.test.ts`

- [ ] **Step 1: 编写引擎集成测试**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { executeToolBatches } from '../../../src/engine/tool-orchestration'
import { defineTool } from '../../../src/engine/tool-framework'
import { HookRegistry } from '../../../src/hooks/hook-registry'
import type { ToolDefinition } from '../../../src/engine/types'

describe('tool-orchestration with hooks', () => {
  const writeTool = defineTool({
    name: 'Write',
    description: 'write file',
    inputSchema: {},
    isReadOnly: false,
    call: async (input) => ({ output: `wrote:${String(input.file_path ?? '')}`, isError: false }),
  })

  const tools: ReadonlyArray<ToolDefinition> = [writeTool]

  it('PreToolUse block prevents tool execution', async () => {
    const registry = new HookRegistry()
    registry.register({
      event: 'PreToolUse', matcher: 'Write', type: 'command',
      command: 'echo "blocked" >&2; exit 2',
    })

    const batches = [{ parallel: false, blocks: [{ id: '1', name: 'Write', input: { file_path: '/tmp/x.ts' } }] }]
    const results = await executeToolBatches(batches, tools, {}, undefined, registry)

    expect(results[0].is_error).toBe(true)
    expect(results[0].content).toContain('blocked')
  })

  it('PostToolUse message appended to output', async () => {
    const registry = new HookRegistry()
    registry.register({
      event: 'PostToolUse', matcher: 'Write', type: 'command',
      command: 'echo "lint warning: unused var"',
    })

    const batches = [{ parallel: false, blocks: [{ id: '1', name: 'Write', input: { file_path: '/tmp/x.ts' } }] }]
    const results = await executeToolBatches(batches, tools, {}, undefined, registry)

    expect(results[0].is_error).toBe(false)
    expect(results[0].content).toContain('wrote:')
    expect(results[0].content).toContain('lint warning')
  })

  it('no hooks means normal execution', async () => {
    const batches = [{ parallel: false, blocks: [{ id: '1', name: 'Write', input: { file_path: '/tmp/x.ts' } }] }]
    const results = await executeToolBatches(batches, tools, {})

    expect(results[0].is_error).toBe(false)
    expect(results[0].content).toBe('wrote:/tmp/x.ts')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/hooks/tool-orchestration-hooks.test.ts`
Expected: FAIL — executeToolBatches 签名不匹配

- [ ] **Step 3: 修改 `src/engine/types.ts` — 添加 hookRegistry 到 EngineOptions**

在 `EngineOptions` 接口（第 135-147 行）中添加 `hookRegistry` 字段：

在 `readonly humanMessageQueue?: HumanMessageQueueLike` 之后添加：

```typescript
  readonly hookRegistry?: import('../hooks/hook-registry').HookRegistry
```

- [ ] **Step 4: 修改 `src/engine/tool-orchestration.ts` — 插入 PreToolUse/PostToolUse**

将 `executeSingleTool` 函数修改为接受可选的 `hookRegistry` 和 `hookContext` 参数，在 `tool.call` 前后触发 hooks。同时修改 `executeToolBatches` 签名透传这些参数。

文件顶部添加 import：

```typescript
import type { HookRegistry } from '../hooks/hook-registry'
import type { HookInput, HookExecutorContext } from '../hooks/types'
import { executeHooks } from '../hooks/hook-executor'
```

修改 `executeSingleTool`（第 14-42 行）为：

```typescript
async function executeSingleTool(
  block: { readonly id: string; readonly name: string; readonly input: Record<string, unknown> },
  tools: ReadonlyArray<ToolDefinition>,
  context: ToolCallContext,
  permissionConfig?: ToolPermissionConfig,
  hookRegistry?: HookRegistry,
  hookContext?: HookExecutorContext,
): Promise<ToolResultEntry> {
  const tool = findTool(tools, block.name)
  if (tool === undefined) {
    return { tool_use_id: block.id, content: `Tool not found: ${block.name}`, is_error: true }
  }

  const permission = await checkToolPermission(block.name, block.input, tool, permissionConfig)
  if (!permission.allowed) {
    return { tool_use_id: block.id, content: `Permission denied: ${permission.reason}`, is_error: true }
  }

  // --- PreToolUse hook ---
  let effectiveInput = block.input
  if (hookRegistry && hookContext) {
    const filePaths = extractFilePaths(block.input)
    const preInput: HookInput = {
      event: 'PreToolUse', toolName: block.name, toolInput: block.input,
      workingDirectory: hookContext.workingDirectory, filePaths,
    }
    const matching = hookRegistry.getMatching('PreToolUse', preInput)
    if (matching.length > 0) {
      const preResult = await executeHooks(matching, preInput, hookContext)
      if (preResult.action === 'block') {
        return { tool_use_id: block.id, content: preResult.message ?? 'Blocked by hook', is_error: true }
      }
      if (preResult.modifiedInput) {
        effectiveInput = { ...effectiveInput, ...preResult.modifiedInput }
      }
    }
  }

  try {
    const result = await tool.call(effectiveInput, context)

    // --- PostToolUse hook ---
    let finalContent = result.output
    if (hookRegistry && hookContext) {
      const filePaths = extractFilePaths(effectiveInput)
      const postInput: HookInput = {
        event: 'PostToolUse', toolName: block.name, toolInput: effectiveInput,
        toolOutput: result.output, workingDirectory: hookContext.workingDirectory, filePaths,
      }
      const matching = hookRegistry.getMatching('PostToolUse', postInput)
      if (matching.length > 0) {
        const postResult = await executeHooks(matching, postInput, hookContext)
        if (postResult.message) {
          const suffix = postResult.action === 'block'
            ? `\n\n${postResult.message}\n\n请修复以上问题后继续。`
            : `\n\n${postResult.message}`
          finalContent = finalContent + suffix
        }
      }
    }

    return {
      tool_use_id: block.id,
      content: finalContent,
      ...(result.images !== undefined ? { images: result.images } : {}),
      is_error: result.isError,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { tool_use_id: block.id, content: `Tool execution error: ${message}`, is_error: true }
  }
}
```

添加辅助函数（文件末尾）：

```typescript
function extractFilePaths(input: Record<string, unknown>): string[] {
  const paths: string[] = []
  const fp = input.file_path ?? input.filePath ?? input.path
  if (typeof fp === 'string') paths.push(fp)
  return paths
}
```

修改 `executeParallelBatch`、`executeSerialBatch`、`executeToolBatches` 签名，透传 `hookRegistry` 和 `hookContext` 参数。

`executeToolBatches` 签名变为：

```typescript
export async function executeToolBatches(
  batches: ReadonlyArray<ToolBatch>,
  tools: ReadonlyArray<ToolDefinition>,
  context?: ToolCallContext,
  permissionConfig?: ToolPermissionConfig,
  hookRegistry?: HookRegistry,
  hookContext?: HookExecutorContext,
): Promise<ToolResultEntry[]>
```

所有内部调用 `executeSingleTool` 的地方添加透传。

- [ ] **Step 5: 修改 `src/engine/query-loop.ts` — 插入 Stop hook + 透传 hookRegistry**

在 `executeToolBatches` 调用处（第 185-187 行），传入 `hookRegistry` 和 `hookContext`：

```typescript
    const hookRegistry = options.hookRegistry
    const hookContext = hookRegistry ? {
      workingDirectory: process.cwd(),
      adapter: undefined,  // Stop hook 的 prompt 需要 adapter，在 Stop 阶段单独处理
      model: options.model,
    } : undefined

    const toolResults = await executeToolBatches(batches, options.tools, {
      abortSignal,
    }, options.permissionConfig, hookRegistry, hookContext)
```

在自然结束位置（第 132 行 `if (stopReason !== 'tool_use')`）前插入 Stop hook：

```typescript
    if (stopReason !== 'tool_use') {
      // --- Stop hook ---
      if (hookRegistry) {
        const stopInput: HookInput = { event: 'Stop', workingDirectory: process.cwd() }
        const matching = hookRegistry.getMatching('Stop', stopInput)
        if (matching.length > 0) {
          const stopContext: HookExecutorContext = {
            workingDirectory: process.cwd(),
            adapter,
            model: options.model,
          }
          const stopResult = await executeHooks(matching, stopInput, stopContext)
          if (stopResult.action === 'block' && stopResult.message) {
            // Inject message as user message and continue the loop
            messages.push(createUserMessage(stopResult.message))
            continue
          }
        }
      }
      return buildResult('completed', finalText, totalTurns, contextManager)
    }
```

添加必要的 import。

- [ ] **Step 6: 运行测试**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/hooks/tool-orchestration-hooks.test.ts`
Expected: 全部 PASS

- [ ] **Step 7: 运行现有测试确认无回归**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/engine/tool-orchestration.test.ts tests/engine/query-loop.test.ts`
Expected: 全部 PASS（原有测试不受影响，因为 hookRegistry 是可选参数）

- [ ] **Step 8: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-agent
git add src/engine/types.ts src/engine/tool-orchestration.ts src/engine/query-loop.ts tests/engine/hooks/tool-orchestration-hooks.test.ts
git commit -m "feat(hooks): integrate hook framework into engine tool-orchestration and query-loop"
```

---

## Task 7: DiagnosticStore

**Files:**
- Create: `src/lsp/diagnostic-store.ts`
- Test: `tests/lsp/diagnostic-store.test.ts`

- [ ] **Step 1: 编写 DiagnosticStore 测试**

```typescript
import { describe, it, expect } from 'vitest'
import { DiagnosticStore } from '../../../src/lsp/diagnostic-store'
import type { FormattedDiagnostic } from '../../../src/hooks/types'

function makeDiag(
  filePath: string,
  severity: 'error' | 'warning' | 'info',
  line: number,
  message: string,
): FormattedDiagnostic {
  return { filePath, line, column: 1, severity, message, source: 'typescript' }
}

describe('DiagnosticStore', () => {
  it('stores and retrieves diagnostics by file', () => {
    const store = new DiagnosticStore()
    const diags = [makeDiag('/src/a.ts', 'error', 1, 'type error')]
    store.update('/src/a.ts', diags)

    expect(store.get('/src/a.ts')).toEqual(diags)
  })

  it('returns empty array for unknown file', () => {
    const store = new DiagnosticStore()
    expect(store.get('/unknown.ts')).toEqual([])
  })

  it('limits to MAX_PER_FILE diagnostics', () => {
    const store = new DiagnosticStore()
    const diags = Array.from({ length: 20 }, (_, i) =>
      makeDiag('/src/a.ts', 'error', i + 1, `error ${i}`)
    )
    store.update('/src/a.ts', diags)

    expect(store.get('/src/a.ts')).toHaveLength(10)
  })

  it('filters out info and hint, keeps only error and warning', () => {
    const store = new DiagnosticStore()
    store.update('/src/a.ts', [
      makeDiag('/src/a.ts', 'error', 1, 'err'),
      makeDiag('/src/a.ts', 'warning', 2, 'warn'),
      makeDiag('/src/a.ts', 'info', 3, 'info'),
    ])

    const result = store.get('/src/a.ts')
    expect(result).toHaveLength(2)
    expect(result.map(d => d.severity)).toEqual(['error', 'warning'])
  })

  it('clears diagnostics for a file', () => {
    const store = new DiagnosticStore()
    store.update('/src/a.ts', [makeDiag('/src/a.ts', 'error', 1, 'err')])
    store.clear('/src/a.ts')

    expect(store.get('/src/a.ts')).toEqual([])
  })

  it('replaces diagnostics on update', () => {
    const store = new DiagnosticStore()
    store.update('/src/a.ts', [makeDiag('/src/a.ts', 'error', 1, 'old')])
    store.update('/src/a.ts', [makeDiag('/src/a.ts', 'warning', 2, 'new')])

    const result = store.get('/src/a.ts')
    expect(result).toHaveLength(1)
    expect(result[0].message).toBe('new')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/lsp/diagnostic-store.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/lsp/diagnostic-store.ts`**

```typescript
import type { FormattedDiagnostic } from '../hooks/types'

const MAX_PER_FILE = 10

export class DiagnosticStore {
  private readonly store = new Map<string, ReadonlyArray<FormattedDiagnostic>>()

  update(filePath: string, diagnostics: ReadonlyArray<FormattedDiagnostic>): void {
    const filtered = diagnostics
      .filter((d) => d.severity === 'error' || d.severity === 'warning')
      .slice(0, MAX_PER_FILE)
    this.store.set(filePath, filtered)
  }

  get(filePath: string): ReadonlyArray<FormattedDiagnostic> {
    return this.store.get(filePath) ?? []
  }

  clear(filePath: string): void {
    this.store.delete(filePath)
  }

  clearAll(): void {
    this.store.clear()
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/lsp/diagnostic-store.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-agent
git add src/lsp/diagnostic-store.ts tests/lsp/diagnostic-store.test.ts
git commit -m "feat(lsp): implement DiagnosticStore with filtering and limits"
```

---

## Task 8: LSP Client

**Files:**
- Create: `src/lsp/configs.ts`
- Create: `src/lsp/lsp-client.ts`
- Test: `tests/lsp/lsp-client.test.ts`

- [ ] **Step 1: 创建 `src/lsp/configs.ts`**

```typescript
export type Language = 'typescript' | 'python' | 'rust' | 'go'

export interface LSPServerConfig {
  readonly command: string
  readonly args: readonly string[]
  /** npm package name (null = must be pre-installed by user) */
  readonly npmPackage: string | null
  readonly fileExtensions: readonly string[]
}

export const LSP_CONFIGS: Record<Language, LSPServerConfig> = {
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
    npmPackage: null,
    fileExtensions: ['.rs'],
  },
  go: {
    command: 'gopls',
    args: ['serve'],
    npmPackage: null,
    fileExtensions: ['.go'],
  },
}

export function detectLanguage(filePath: string): Language | undefined {
  const ext = filePath.slice(filePath.lastIndexOf('.'))
  for (const [lang, config] of Object.entries(LSP_CONFIGS)) {
    if (config.fileExtensions.includes(ext)) return lang as Language
  }
  return undefined
}
```

- [ ] **Step 2: 编写 LSPClient 测试**

LSPClient 依赖真实的 LSP server 进程，不适合纯单元测试。编写针对可测试部分的测试（连接建立、消息发送格式），用 mock child process。

```typescript
import { describe, it, expect, vi } from 'vitest'
import { detectLanguage } from '../../../src/lsp/configs'

describe('detectLanguage', () => {
  it('detects TypeScript', () => {
    expect(detectLanguage('/src/foo.ts')).toBe('typescript')
    expect(detectLanguage('/src/foo.tsx')).toBe('typescript')
    expect(detectLanguage('/src/foo.js')).toBe('typescript')
  })

  it('detects Python', () => {
    expect(detectLanguage('/src/foo.py')).toBe('python')
  })

  it('detects Rust', () => {
    expect(detectLanguage('/src/foo.rs')).toBe('rust')
  })

  it('detects Go', () => {
    expect(detectLanguage('/src/foo.go')).toBe('go')
  })

  it('returns undefined for unknown extension', () => {
    expect(detectLanguage('/src/foo.rb')).toBeUndefined()
    expect(detectLanguage('/src/foo.md')).toBeUndefined()
  })
})
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/lsp/lsp-client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: 实现 `src/lsp/lsp-client.ts`**

```typescript
import { spawn, type ChildProcess } from 'child_process'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node'
import {
  InitializeRequest,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidSaveTextDocumentNotification,
  PublishDiagnosticsNotification,
  type InitializeParams,
  type Diagnostic,
  DiagnosticSeverity,
} from 'vscode-languageserver-protocol'
import type { FormattedDiagnostic } from '../hooks/types'
import type { Language, LSPServerConfig } from './configs'
import * as path from 'path'
import * as fs from 'fs'

const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 3_000

export interface LSPClient {
  readonly language: Language
  initialize(rootUri: string): Promise<void>
  didOpen(filePath: string, content: string): void
  didChange(filePath: string, content: string): void
  didSave(filePath: string): void
  waitForDiagnostics(filePath: string, timeoutMs?: number): Promise<ReadonlyArray<FormattedDiagnostic>>
  shutdown(): Promise<void>
}

export function createLSPClient(language: Language, config: LSPServerConfig): LSPClient {
  let process: ChildProcess | undefined
  let connection: MessageConnection | undefined
  let initialized = false
  const fileVersions = new Map<string, number>()
  const pendingDiagnostics = new Map<string, { diagnostics: Diagnostic[]; resolvers: Array<(diags: Diagnostic[]) => void> }>()

  function toUri(filePath: string): string {
    return `file://${filePath}`
  }

  function convertSeverity(severity?: DiagnosticSeverity): 'error' | 'warning' | 'info' {
    switch (severity) {
      case DiagnosticSeverity.Error: return 'error'
      case DiagnosticSeverity.Warning: return 'warning'
      default: return 'info'
    }
  }

  function formatDiagnostics(filePath: string, diagnostics: Diagnostic[]): ReadonlyArray<FormattedDiagnostic> {
    return diagnostics.map((d) => ({
      filePath,
      line: d.range.start.line + 1,
      column: d.range.start.character + 1,
      severity: convertSeverity(d.severity),
      message: d.message,
      source: d.source ?? language,
    }))
  }

  return {
    language,

    async initialize(rootUri: string): Promise<void> {
      if (initialized) return

      process = spawn(config.command, [...config.args], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      if (!process.stdout || !process.stdin) {
        throw new Error(`Failed to spawn LSP server: ${config.command}`)
      }

      connection = createMessageConnection(
        new StreamMessageReader(process.stdout),
        new StreamMessageWriter(process.stdin),
      )

      // Listen for diagnostics
      connection.onNotification(PublishDiagnosticsNotification.type, (params) => {
        const filePath = params.uri.replace('file://', '')
        const entry = pendingDiagnostics.get(filePath)
        if (entry) {
          entry.diagnostics = params.diagnostics
          for (const resolver of entry.resolvers) {
            resolver(params.diagnostics)
          }
          entry.resolvers = []
        } else {
          pendingDiagnostics.set(filePath, { diagnostics: params.diagnostics, resolvers: [] })
        }
      })

      connection.listen()

      const initParams: InitializeParams = {
        processId: null,
        rootUri: toUri(rootUri),
        capabilities: {
          textDocument: {
            publishDiagnostics: {
              relatedInformation: false,
            },
          },
        },
        workspaceFolders: [{ uri: toUri(rootUri), name: path.basename(rootUri) }],
      }

      await connection.sendRequest(InitializeRequest.type, initParams)
      connection.sendNotification('initialized', {})
      initialized = true
    },

    didOpen(filePath: string, content: string): void {
      if (!connection || !initialized) return
      fileVersions.set(filePath, 1)
      connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: {
          uri: toUri(filePath),
          languageId: language === 'typescript' ? 'typescript' : language,
          version: 1,
          text: content,
        },
      })
    },

    didChange(filePath: string, content: string): void {
      if (!connection || !initialized) return
      const version = (fileVersions.get(filePath) ?? 0) + 1
      fileVersions.set(filePath, version)

      // Check if file was opened; if not, open it first
      if (version === 1) {
        this.didOpen(filePath, content)
        return
      }

      connection.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri: toUri(filePath), version },
        contentChanges: [{ text: content }],
      })
    },

    didSave(filePath: string): void {
      if (!connection || !initialized) return
      connection.sendNotification(DidSaveTextDocumentNotification.type, {
        textDocument: { uri: toUri(filePath) },
      })
    },

    async waitForDiagnostics(filePath: string, timeoutMs = DEFAULT_DIAGNOSTICS_TIMEOUT_MS): Promise<ReadonlyArray<FormattedDiagnostic>> {
      // Check if we already have diagnostics
      const existing = pendingDiagnostics.get(filePath)
      if (existing && existing.diagnostics.length > 0) {
        const diags = formatDiagnostics(filePath, existing.diagnostics)
        return diags
      }

      // Wait for diagnostics notification
      return new Promise<ReadonlyArray<FormattedDiagnostic>>((resolve) => {
        const timer = setTimeout(() => {
          const entry = pendingDiagnostics.get(filePath)
          if (entry) {
            entry.resolvers = entry.resolvers.filter(r => r !== onDiag)
          }
          resolve([])
        }, timeoutMs)

        const onDiag = (diagnostics: Diagnostic[]) => {
          clearTimeout(timer)
          resolve(formatDiagnostics(filePath, diagnostics))
        }

        if (!pendingDiagnostics.has(filePath)) {
          pendingDiagnostics.set(filePath, { diagnostics: [], resolvers: [] })
        }
        pendingDiagnostics.get(filePath)!.resolvers.push(onDiag)
      })
    },

    async shutdown(): Promise<void> {
      if (connection && initialized) {
        try {
          await connection.sendRequest('shutdown')
          connection.sendNotification('exit')
        } catch {
          // Server may have already exited
        }
        connection.dispose()
      }
      if (process) {
        process.kill()
      }
      initialized = false
      fileVersions.clear()
      pendingDiagnostics.clear()
    },
  }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/lsp/lsp-client.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-agent
git add src/lsp/configs.ts src/lsp/lsp-client.ts tests/lsp/lsp-client.test.ts
git commit -m "feat(lsp): implement generic LSP client with vscode-jsonrpc"
```

---

## Task 9: LSP Manager

**Files:**
- Create: `src/lsp/lsp-manager.ts`
- Test: `tests/lsp/lsp-manager.test.ts`

- [ ] **Step 1: 编写 LSPManager 测试**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createLSPManager } from '../../../src/lsp/lsp-manager'

describe('LSPManager', () => {
  it('creates without error', () => {
    const manager = createLSPManager()
    expect(manager).toBeDefined()
  })

  it('isLanguageAvailable returns false before start', () => {
    const manager = createLSPManager()
    expect(manager.isLanguageAvailable('typescript')).toBe(false)
  })

  it('getDiagnostics returns empty for unstarted language', async () => {
    const manager = createLSPManager()
    const diags = await manager.getDiagnostics('/src/foo.ts')
    expect(diags).toEqual([])
  })

  it('notifyFileChanged does not throw for unstarted language', () => {
    const manager = createLSPManager()
    expect(() => manager.notifyFileChanged('/src/foo.ts', 'const x = 1')).not.toThrow()
  })

  it('stop does not throw when nothing started', async () => {
    const manager = createLSPManager()
    await expect(manager.stop()).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/lsp/lsp-manager.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/lsp/lsp-manager.ts`**

```typescript
import type { FormattedDiagnostic, LspManagerLike } from '../hooks/types'
import type { Language } from './configs'
import { LSP_CONFIGS, detectLanguage } from './configs'
import { createLSPClient, type LSPClient } from './lsp-client'
import { DiagnosticStore } from './diagnostic-store'
import { execSync } from 'child_process'

export interface LSPManager extends LspManagerLike {
  start(rootUri: string, languages?: Language[]): Promise<void>
  stop(): Promise<void>
  notifyFileChanged(filePath: string, content: string): void
  getDiagnostics(filePath: string): Promise<ReadonlyArray<FormattedDiagnostic>>
  isLanguageAvailable(lang: string): boolean
}

export function createLSPManager(): LSPManager {
  const clients = new Map<Language, LSPClient>()
  const diagnosticStore = new DiagnosticStore()
  let rootUri: string | undefined
  const startingLanguages = new Set<Language>()

  function isServerInstalled(command: string): boolean {
    try {
      execSync(`which ${command}`, { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }

  async function ensureClient(language: Language): Promise<LSPClient | undefined> {
    if (clients.has(language)) return clients.get(language)
    if (!rootUri) return undefined
    if (startingLanguages.has(language)) return undefined

    const config = LSP_CONFIGS[language]
    if (!isServerInstalled(config.command)) return undefined

    startingLanguages.add(language)
    try {
      const client = createLSPClient(language, config)
      await client.initialize(rootUri)
      clients.set(language, client)
      return client
    } catch (error) {
      console.error(`Failed to start LSP server for ${language}:`, error)
      return undefined
    } finally {
      startingLanguages.delete(language)
    }
  }

  return {
    async start(uri: string, languages?: Language[]): Promise<void> {
      rootUri = uri
      if (languages) {
        await Promise.all(languages.map((lang) => ensureClient(lang)))
      }
    },

    async stop(): Promise<void> {
      const shutdowns = [...clients.values()].map((client) => client.shutdown())
      await Promise.all(shutdowns)
      clients.clear()
      diagnosticStore.clearAll()
    },

    notifyFileChanged(filePath: string, content: string): void {
      const language = detectLanguage(filePath)
      if (!language) return

      // Lazy start: trigger client initialization in background
      void ensureClient(language).then((client) => {
        if (!client) return
        client.didChange(filePath, content)
      })
    },

    async getDiagnostics(filePath: string): Promise<ReadonlyArray<FormattedDiagnostic>> {
      const language = detectLanguage(filePath)
      if (!language) return []

      const client = await ensureClient(language)
      if (!client) return []

      const diagnostics = await client.waitForDiagnostics(filePath)
      diagnosticStore.update(filePath, [...diagnostics])
      return diagnosticStore.get(filePath)
    },

    isLanguageAvailable(lang: string): boolean {
      return clients.has(lang as Language)
    },
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run tests/lsp/lsp-manager.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-agent
git add src/lsp/lsp-manager.ts tests/lsp/lsp-manager.test.ts
git commit -m "feat(lsp): implement LSPManager with lazy startup and multi-language support"
```

---

## Task 10: coding_expert 默认 Hooks + Sub-agent 集成

**Files:**
- Create: `src/hooks/defaults.ts`
- Modify: `src/agent/subagent-prompts.ts:8-25, 47-65`
- Modify: `src/engine/sub-agent.ts:12-34, 66-78, 101-114, 213-225`
- Modify: `src/agent/worker-handler.ts:351-364`

- [ ] **Step 1: 创建 `src/hooks/defaults.ts`**

```typescript
import type { HookDefinition } from './types'
import type { LSPManager } from '../lsp/lsp-manager'
import { HookRegistry } from './hook-registry'

export function createCodingExpertHookRegistry(lspManager?: LSPManager): HookRegistry {
  const registry = new HookRegistry()
  registry.registerAll(getCodingExpertHooks())
  return registry
}

function getCodingExpertHooks(): ReadonlyArray<HookDefinition> {
  return [
    // 1. LSP diagnostics — type/syntax errors after file edits
    {
      event: 'PostToolUse',
      matcher: 'Write|Edit',
      type: 'command',
      command: '__internal:lsp-diagnostics',
    },
    // 2. Compile check — verify build before sub-agent finishes
    {
      event: 'Stop',
      type: 'command',
      command: '__internal:compile-check',
      timeout: 60,
    },
    // 3. Test evaluation — LLM judges if tests need running
    {
      event: 'Stop',
      type: 'prompt',
      prompt: [
        '分析以下代码变更上下文，判断是否需要运行测试。',
        '如果需要，返回 {"action":"block","message":"建议运行以下测试：<具体测试文件或命令>"}',
        '如果不需要，返回 {"action":"continue"}',
        '',
        '上下文：$INPUT',
      ].join('\n'),
    },
  ]
}
```

- [ ] **Step 2: 修改 `src/agent/subagent-prompts.ts` — SubAgentDefinition 添加 hooks 字段**

在 `SubAgentDefinition` 接口（第 8-25 行）中，在 `readonly maxTurns: number` 后添加：

```typescript
  /** Hook preset name. If set, hooks will be registered when creating the sub-agent. */
  readonly hooks?: string
```

在 `coding_expert` 定义（第 47-65 行）中，在 `maxTurns: 30,` 后添加：

```typescript
    hooks: 'coding_expert',
```

- [ ] **Step 3: 修改 `src/engine/sub-agent.ts` — 透传 hookRegistry**

在 `ForkEngineParams`（第 12-34 行）中添加：

```typescript
  readonly hookRegistry?: import('../hooks/hook-registry').HookRegistry
```

在 `forkEngine`（第 66-78 行）的 options 对象中添加：

```typescript
      hookRegistry: params.hookRegistry,
```

在 `SubAgentToolConfig`（第 101-114 行）中添加：

```typescript
  readonly hookRegistry?: import('../hooks/hook-registry').HookRegistry
```

在 `createSubAgentTool` 中 `forkEngine` 调用处（第 213-225 行）添加：

```typescript
          hookRegistry: config.hookRegistry,
```

- [ ] **Step 4: 修改 `src/agent/worker-handler.ts` — 创建 sub-agent 时注入 hookRegistry**

在 worker-handler.ts 中 sub-agent 创建循环（第 351-364 行），对有 hooks 的定义创建 HookRegistry：

在文件顶部添加 import：
```typescript
import { createCodingExpertHookRegistry } from '../hooks/defaults'
import type { LSPManager } from '../lsp/lsp-manager'
```

在 WorkerHandler 类中添加 `lspManager` 参数（构造函数中接收），并在 sub-agent 循环中：

```typescript
      for (const { definition, sdkEnv: subSdkEnv } of this.subAgentConfigs) {
        const hookRegistry = definition.hooks === 'coding_expert'
          ? createCodingExpertHookRegistry(this.lspManager)
          : undefined

        tools.push(createSubAgentTool({
          name: definition.toolName,
          description: definition.toolDescription,
          adapter: adapterFromSdkEnv(subSdkEnv),
          model: subSdkEnv.modelId,
          systemPrompt: definition.systemPrompt,
          subTools: baseTools,
          maxTurns: definition.maxTurns,
          supportsVision: subSdkEnv.supportsVision,
          parentHumanQueue: humanQueue,
          traceConfig: subAgentTraceConfig,
          hookRegistry,
        }))
      }
```

- [ ] **Step 5: 运行全量测试**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-agent
git add src/hooks/defaults.ts src/agent/subagent-prompts.ts src/engine/sub-agent.ts src/agent/worker-handler.ts
git commit -m "feat(hooks): wire coding_expert hooks through sub-agent creation pipeline"
```

---

## Task 11: UnifiedAgent 初始化 LSPManager

**Files:**
- Modify: `src/unified-agent.ts`

- [ ] **Step 1: 在 UnifiedAgent 中初始化 LSPManager**

在 `unified-agent.ts` 中：

1. 添加 import：
```typescript
import { createLSPManager, type LSPManager } from './lsp/lsp-manager'
```

2. 在类属性中添加：
```typescript
private lspManager: LSPManager
```

3. 在构造函数中初始化（在 `this.traceStore` 初始化之后）：
```typescript
this.lspManager = createLSPManager()
```

4. 在 `initializeAgentLayer` 或 `createWorkerHandler` 中，将 `this.lspManager` 传递给 WorkerHandler。

5. 在模块停止/销毁逻辑中添加 `await this.lspManager.stop()`。

6. 在 agent 启动时（收到配置后），调用 `this.lspManager.start(process.cwd())` 初始化 LSP 根目录。

- [ ] **Step 2: 运行全量测试**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run`
Expected: 全部 PASS

- [ ] **Step 3: 运行 TypeScript 编译检查**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-agent
git add src/unified-agent.ts
git commit -m "feat(lsp): initialize LSPManager in UnifiedAgent and pass to workers"
```

---

## Task 12: 导出模块索引

**Files:**
- Create: `src/hooks/index.ts`
- Create: `src/lsp/index.ts`

- [ ] **Step 1: 创建 `src/hooks/index.ts`**

```typescript
export type { HookEvent, HookDefinition, HookInput, HookResult, HookExecutorContext, FormattedDiagnostic, LspManagerLike } from './types'
export { HookRegistry } from './hook-registry'
export { executeHooks } from './hook-executor'
export { executeCommandHook } from './command-hook'
export { executePromptHook } from './prompt-hook'
export { createCodingExpertHookRegistry } from './defaults'
```

- [ ] **Step 2: 创建 `src/lsp/index.ts`**

```typescript
export type { Language, LSPServerConfig } from './configs'
export { LSP_CONFIGS, detectLanguage } from './configs'
export type { LSPClient } from './lsp-client'
export { createLSPClient } from './lsp-client'
export type { LSPManager } from './lsp-manager'
export { createLSPManager } from './lsp-manager'
export { DiagnosticStore } from './diagnostic-store'
```

- [ ] **Step 3: 运行编译检查**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 运行全量测试**

Run: `cd /Users/fufu/codes/playground/crabot/crabot-agent && npx vitest run`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/fufu/codes/playground/crabot/crabot-agent
git add src/hooks/index.ts src/lsp/index.ts
git commit -m "chore: add module index files for hooks and lsp"
```

---

## 依赖关系

```
Task 1 (types) ──────────┬───> Task 2 (registry)
                         ├───> Task 3 (command-hook) ──┐
                         ├───> Task 4 (prompt-hook) ───┤
                         │                             v
                         └──────────────> Task 5 (executor) ──> Task 6 (engine integration)
                                                                        │
Task 7 (diagnostic-store) ──> Task 8 (lsp-client) ──> Task 9 (lsp-manager)
                                                                        │
                                                                        v
                              Task 10 (defaults + sub-agent wiring) <───┘
                                           │
                                           v
                              Task 11 (UnifiedAgent init)
                                           │
                                           v
                              Task 12 (module index + final check)
```

Task 1-5 (hooks) 和 Task 7-9 (lsp) 可以并行开发。Task 6 依赖 Task 2-5。Task 10 依赖 Task 6 和 Task 9。
