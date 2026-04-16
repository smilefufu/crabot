# CLI + 发行体系 + Agent 内置 Skill 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建覆盖 Admin 主要能力的 CLI 管理工具，建立源码 + Release 包发行体系，提供 Agent 内置 Skill 实现自我管理。

**Architecture:** CLI 是 Admin REST API 的薄客户端，放在项目根目录 `src/cli/`。认证通过 `<DATA_DIR>/admin/internal-token` 文件自动获取，Admin 每次启动时重新生成。Agent 通过内置 `crabot-cli` Skill 学会使用 CLI，Hook 框架在非 master 私聊场景下拦截 CLI 命令。

**Tech Stack:** Node.js, TypeScript, commander.js, node:fs, fetch (Node 22+)

**Spec:** `docs/superpowers/specs/2026-04-15-cli-release-and-agent-skill-design.md`

---

## Phase 1: CLI 基础设施

### Task 1: CLI 项目脚手架

**Files:**
- Create: `src/cli/main.ts`
- Create: `src/cli/client.ts`
- Create: `src/cli/auth.ts`
- Create: `src/cli/output.ts`
- Create: `tsconfig.cli.json`

**依赖安装：** 在项目根目录安装 `commander`（CLI 唯一外部依赖）。

- [ ] **Step 1: 创建 tsconfig.cli.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist/cli",
    "rootDir": "./src/cli",
    "declaration": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/cli/**/*.ts"],
  "exclude": ["src/cli/**/*.test.ts"]
}
```

- [ ] **Step 2: 创建 src/cli/auth.ts — token 解析模块**

```typescript
// src/cli/auth.ts
// 负责解析 internal-token 和 Admin 端点地址
// 优先级：环境变量 > 命令行参数 > 文件自动发现

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface AuthConfig {
  readonly endpoint: string
  readonly token: string
}

export function resolveAuth(opts: {
  endpoint?: string
  token?: string
  crabotHome?: string
}): AuthConfig {
  const token = resolveToken(opts)
  const endpoint = resolveEndpoint(opts)
  return { endpoint, token }
}

function resolveToken(opts: { token?: string; crabotHome?: string }): string {
  // 1. 命令行参数 / 环境变量
  if (opts.token) return opts.token
  if (process.env.CRABOT_TOKEN) return process.env.CRABOT_TOKEN

  // 2. 从 internal-token 文件读取
  const dataDir = resolveDataDir(opts.crabotHome)
  const tokenPath = resolve(dataDir, 'admin', 'internal-token')
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, 'utf-8').trim()
  }

  throw new Error(
    `无法获取认证 token。请确保 Crabot 已启动，或设置 CRABOT_TOKEN 环境变量。\n` +
    `Token 文件路径: ${tokenPath}`
  )
}

function resolveEndpoint(opts: { endpoint?: string }): string {
  if (opts.endpoint) return opts.endpoint
  if (process.env.CRABOT_ENDPOINT) return process.env.CRABOT_ENDPOINT

  const offset = parseInt(process.env.CRABOT_PORT_OFFSET ?? '0', 10)
  const port = 3000 + offset
  return `http://localhost:${port}`
}

function resolveDataDir(crabotHome?: string): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR

  const home = crabotHome ?? process.cwd()
  const offset = parseInt(process.env.CRABOT_PORT_OFFSET ?? '0', 10)

  return offset > 0
    ? resolve(home, `data-${offset}`)
    : resolve(home, 'data')
}
```

- [ ] **Step 3: 创建 src/cli/client.ts — Admin REST API 客户端**

```typescript
// src/cli/client.ts
// Admin REST API 薄客户端，封装认证、请求、错误处理

import type { AuthConfig } from './auth.js'

export class AdminClient {
  constructor(private readonly auth: AuthConfig) {}

  async get<T>(path: string): Promise<T> {
    return this.request('GET', path)
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request('POST', path, body)
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request('PATCH', path, body)
  }

  async delete<T>(path: string): Promise<T> {
    return this.request('DELETE', path)
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.auth.endpoint}${path}`
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.auth.token}`,
      'Content-Type': 'application/json',
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let errorMsg: string
      try {
        const parsed = JSON.parse(text)
        errorMsg = parsed.message ?? parsed.error ?? text
      } catch {
        errorMsg = text || `HTTP ${res.status}`
      }
      throw new Error(`${method} ${path} failed: ${errorMsg}`)
    }

    const text = await res.text()
    return text ? JSON.parse(text) : undefined
  }
}
```

- [ ] **Step 4: 创建 src/cli/output.ts — 输出格式化**

```typescript
// src/cli/output.ts
// 双模式输出：人类可读表格 / JSON

export interface Column {
  readonly key: string
  readonly header: string
  readonly width?: number
  readonly transform?: (value: unknown) => string
}

export function printTable(data: ReadonlyArray<Record<string, unknown>>, columns: Column[]): void {
  if (data.length === 0) {
    console.log('(empty)')
    return
  }

  // 计算列宽
  const widths = columns.map((col) => {
    const headerLen = col.header.length
    const maxDataLen = data.reduce((max, row) => {
      const val = formatCell(row[col.key], col.transform)
      return Math.max(max, val.length)
    }, 0)
    return col.width ?? Math.max(headerLen, Math.min(maxDataLen, 40))
  })

  // 打印表头
  const header = columns.map((col, i) => col.header.padEnd(widths[i])).join('  ')
  console.log(header)

  // 打印数据行
  for (const row of data) {
    const line = columns.map((col, i) => {
      const val = formatCell(row[col.key], col.transform)
      return val.slice(0, widths[i]).padEnd(widths[i])
    }).join('  ')
    console.log(line)
  }
}

function formatCell(value: unknown, transform?: (v: unknown) => string): string {
  if (transform) return transform(value)
  if (value === null || value === undefined) return '-'
  return String(value)
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

export function printResult(data: unknown, json: boolean, columns?: Column[]): void {
  if (json) {
    printJson(data)
  } else if (columns && Array.isArray(data)) {
    printTable(data, columns)
  } else {
    printJson(data)
  }
}

/** UUID 短前缀显示（前 8 位） */
export function shortId(id: string): string {
  return id.slice(0, 8)
}
```

- [ ] **Step 5: 创建 src/cli/main.ts — commander 程序入口**

```typescript
// src/cli/main.ts
// CLI 程序入口，注册所有命令

import { Command } from 'commander'
import { resolveAuth } from './auth.js'
import { AdminClient } from './client.js'

export function run(argv: string[]): void {
  const program = new Command()

  program
    .name('crabot')
    .description('Crabot CLI - AI 员工管理工具')
    .version('1.0.0')
    .option('--json', 'JSON 格式输出', false)
    .option('--endpoint <url>', '指定 Admin 地址')
    .option('--token <token>', '指定认证 token')

  // 注册管理命令（Phase 2 逐步添加）
  // registerProviderCommands(program)
  // registerAgentCommands(program)
  // ...

  program.parse(argv)
}

/** 从 program 选项创建 AdminClient（各命令共用） */
export function createClient(program: Command): { client: AdminClient; json: boolean } {
  const opts = program.opts()
  const auth = resolveAuth({
    endpoint: opts.endpoint,
    token: opts.token,
  })
  return {
    client: new AdminClient(auth),
    json: opts.json ?? false,
  }
}
```

- [ ] **Step 6: 安装 commander 依赖**

项目根目录当前无 package.json。需要创建：

```bash
cd /Users/fufu/codes/playground/crabot
npm init -y
npm install commander
```

然后编辑 `package.json`，添加构建脚本：

```json
{
  "scripts": {
    "build:cli": "tsc -p tsconfig.cli.json"
  },
  "dependencies": {
    "commander": "^13.0.0"
  }
}
```

- [ ] **Step 7: 编译并验证**

```bash
npm run build:cli
```

Expected: `dist/cli/` 目录生成 `main.js`, `client.js`, `auth.js`, `output.js`。

- [ ] **Step 8: Commit**

```bash
git add src/cli/ tsconfig.cli.json package.json package-lock.json
git commit -m "feat(cli): scaffold CLI project with auth, client, output modules"
```

---

### Task 2: cli.mjs 入口 + crabot.cmd

**Files:**
- Create: `cli.mjs`
- Create: `crabot.cmd`

- [ ] **Step 1: 创建 cli.mjs**

```javascript
#!/usr/bin/env node

// cli.mjs — Crabot CLI 入口
// 纯 JS，不依赖任何 npm 包，跨平台（macOS/Linux/Windows）

import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const command = args[0] ?? 'help'

const bootstrapCommands = new Set(['start', 'stop', 'check', 'help'])

if (bootstrapCommands.has(command)) {
  const scriptPath = resolve(__dirname, `scripts/${command}.mjs`)
  if (existsSync(scriptPath)) {
    await import(scriptPath)
  } else {
    // Fallback: 引导脚本尚未迁移到 mjs，提示使用旧入口
    console.error(`Bootstrap command "${command}" not yet available in cli.mjs.`)
    console.error('Use the legacy ./crabot bash script for now.')
    process.exit(1)
  }
} else {
  const cliEntry = resolve(__dirname, 'dist/cli/main.js')
  if (!existsSync(cliEntry)) {
    console.error('CLI not built. Run "crabot start" first or build with "npm run build:cli".')
    process.exit(1)
  }
  const { run } = await import(cliEntry)
  run(process.argv)
}
```

- [ ] **Step 2: 创建 crabot.cmd (Windows 入口)**

```cmd
@echo off
node "%~dp0cli.mjs" %*
```

- [ ] **Step 3: 设置 cli.mjs 为可执行**

```bash
chmod +x cli.mjs
```

- [ ] **Step 4: 验证入口可用**

```bash
node cli.mjs help
# Expected: 未实现的 bootstrap command 或 fallback 提示

node cli.mjs provider list
# Expected: "CLI not built" 错误（dist/ 不存在时），或 commander 帮助

npm run build:cli && node cli.mjs --help
# Expected: commander 帮助输出
```

- [ ] **Step 5: Commit**

```bash
git add cli.mjs crabot.cmd
git commit -m "feat(cli): add cross-platform entry points (cli.mjs + crabot.cmd)"
```

---

## Phase 2: CLI 管理命令

每个 Task 实现一组管理命令。所有命令遵循相同模式：从 `main.ts` 注册子命令 → 调用 `AdminClient` → 用 `output.ts` 格式化输出。

### Task 3: provider 命令

**Files:**
- Create: `src/cli/commands/provider.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 1: 创建 src/cli/commands/provider.ts**

```typescript
import type { Command } from 'commander'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'

const PROVIDER_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v)) },
  { key: 'name', header: 'NAME' },
  { key: 'type', header: 'TYPE' },
  { key: 'model_count', header: 'MODELS', transform: (v) => {
    const val = v as { models?: unknown[] } | number
    return String(typeof val === 'number' ? val : (val as any)?.models?.length ?? '-')
  }},
]

export function registerProviderCommands(parent: Command): void {
  const cmd = parent.command('provider').description('Model Provider 管理')

  cmd
    .command('list')
    .description('列出所有 Provider')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get('/api/model-providers')
      printResult(data, json, PROVIDER_COLUMNS)
    })

  cmd
    .command('show <id>')
    .description('查看 Provider 详情')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get(`/api/model-providers/${id}`)
      printResult(data, json)
    })

  cmd
    .command('add')
    .description('创建 Provider')
    .requiredOption('--name <name>', 'Provider 名称')
    .requiredOption('--type <type>', '类型 (openai/ollama/anthropic/...)')
    .requiredOption('--endpoint <url>', 'API 端点')
    .option('--apikey <key>', 'API Key')
    .option('--apikey-stdin', '从 stdin 读取 API Key')
    .action(async (opts: Record<string, string | boolean>) => {
      const { client, json } = createClient(parent)
      let apikey = opts.apikey as string | undefined
      if (opts['apikey-stdin']) {
        apikey = await readStdin()
      }
      const body = {
        name: opts.name,
        type: opts.type,
        endpoint: opts.endpoint,
        apikey,
      }
      const data = await client.post('/api/model-providers', body)
      printResult(data, json)
    })

  cmd
    .command('test <id>')
    .description('测试 Provider 连接')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.post(`/api/model-providers/${id}/test`)
      printResult(data, json)
    })

  cmd
    .command('refresh <id>')
    .description('刷新可用模型列表')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.post(`/api/model-providers/${id}/refresh-models`)
      printResult(data, json)
    })

  cmd
    .command('delete <id>')
    .description('删除 Provider')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.delete(`/api/model-providers/${id}`)
      if (!json) console.log(`Provider ${shortId(id)} deleted.`)
      else printResult({ deleted: true, id }, json)
    })
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf-8').trim()
}
```

- [ ] **Step 2: 在 main.ts 中注册 provider 命令**

在 `src/cli/main.ts` 的 `run()` 函数中，取消注释并添加 import：

```typescript
import { registerProviderCommands } from './commands/provider.js'

// run() 内部：
registerProviderCommands(program)
```

- [ ] **Step 3: 编译并手动验证**

```bash
npm run build:cli
node cli.mjs provider --help
# Expected: 显示 provider 子命令列表

node cli.mjs provider list --json
# Expected: 连接 Admin API，返回 JSON（需 Admin 在线）
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/provider.ts src/cli/main.ts
git commit -m "feat(cli): add provider commands (list/show/add/test/refresh/delete)"
```

---

### Task 4: agent 命令

**Files:**
- Create: `src/cli/commands/agent.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 1: 创建 src/cli/commands/agent.ts**

```typescript
import type { Command } from 'commander'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'

const AGENT_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v)) },
  { key: 'name', header: 'NAME' },
  { key: 'implementation_id', header: 'IMPL', transform: (v) => shortId(String(v ?? '')) },
  { key: 'status', header: 'STATUS' },
]

export function registerAgentCommands(parent: Command): void {
  const cmd = parent.command('agent').description('Agent 实例管理')

  cmd
    .command('list')
    .description('列出 Agent 实例')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get('/api/agent-instances')
      printResult(data, json, AGENT_COLUMNS)
    })

  cmd
    .command('show <id>')
    .description('查看 Agent 实例详情')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get(`/api/agent-instances/${id}`)
      printResult(data, json)
    })

  cmd
    .command('config <id>')
    .description('查看或更新 Agent 实例配置')
    .option('--set <pairs...>', '更新配置（key=value 格式，支持点号路径）')
    .action(async (id: string, opts: { set?: string[] }) => {
      const { client, json } = createClient(parent)
      if (opts.set && opts.set.length > 0) {
        const updates = parseKeyValuePairs(opts.set)
        const data = await client.patch(`/api/agent-instances/${id}/config`, updates)
        printResult(data, json)
      } else {
        const data = await client.get(`/api/agent-instances/${id}/config`)
        printResult(data, json)
      }
    })

  cmd
    .command('restart <id>')
    .description('重启 Agent 实例')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.post(`/api/agent-instances/${id}/restart`)
      if (!json) console.log(`Agent ${shortId(id)} restarted.`)
      else printResult({ restarted: true, id }, json)
    })
}

/**
 * 解析 key=value 键值对，支持点号路径展开为嵌套对象
 * 例如 "models.default.provider_id=xxx" → { models: { default: { provider_id: "xxx" } } }
 */
function parseKeyValuePairs(pairs: ReadonlyArray<string>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=')
    if (eqIndex === -1) {
      throw new Error(`Invalid key=value pair: ${pair}`)
    }
    const key = pair.slice(0, eqIndex)
    const value = pair.slice(eqIndex + 1)
    setNestedValue(result, key.split('.'), value)
  }
  return result
}

function setNestedValue(obj: Record<string, unknown>, keys: ReadonlyArray<string>, value: string): void {
  let current = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]
    if (!(k in current) || typeof current[k] !== 'object') {
      current[k] = {}
    }
    current = current[k] as Record<string, unknown>
  }
  current[keys[keys.length - 1]] = value
}
```

- [ ] **Step 2: 注册到 main.ts**

```typescript
import { registerAgentCommands } from './commands/agent.js'
// run() 内：
registerAgentCommands(program)
```

- [ ] **Step 3: 编译验证**

```bash
npm run build:cli && node cli.mjs agent --help
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/agent.ts src/cli/main.ts
git commit -m "feat(cli): add agent commands (list/show/config/restart)"
```

---

### Task 5: mcp 命令

**Files:**
- Create: `src/cli/commands/mcp.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 1: 创建 src/cli/commands/mcp.ts**

```typescript
import type { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'

const MCP_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v)) },
  { key: 'name', header: 'NAME' },
  { key: 'transport', header: 'TRANSPORT' },
  { key: 'enabled', header: 'ENABLED', transform: (v) => v ? 'yes' : 'no' },
  { key: 'is_builtin', header: 'BUILTIN', transform: (v) => v ? 'yes' : 'no' },
]

export function registerMcpCommands(parent: Command): void {
  const cmd = parent.command('mcp').description('MCP Server 管理')

  cmd
    .command('list')
    .description('列出 MCP 服务')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get('/api/mcp-servers')
      printResult(data, json, MCP_COLUMNS)
    })

  cmd
    .command('show <id>')
    .description('查看 MCP 服务详情')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get(`/api/mcp-servers/${id}`)
      printResult(data, json)
    })

  cmd
    .command('add')
    .description('创建 MCP 服务')
    .requiredOption('--name <name>', '服务名称')
    .requiredOption('--command <cmd>', '启动命令')
    .option('--args <args>', '命令参数（逗号分隔）')
    .action(async (opts: Record<string, string>) => {
      const { client, json } = createClient(parent)
      const body = {
        name: opts.name,
        transport: 'stdio',
        command: opts.command,
        args: opts.args ? opts.args.split(',') : [],
      }
      const data = await client.post('/api/mcp-servers', body)
      printResult(data, json)
    })

  cmd
    .command('import <file>')
    .description('从 JSON 文件批量导入 MCP 服务')
    .action(async (file: string) => {
      const { client, json } = createClient(parent)
      const content = readFileSync(file, 'utf-8')
      const servers = JSON.parse(content)
      const data = await client.post('/api/mcp-servers/import-json', { servers })
      printResult(data, json)
    })

  cmd
    .command('delete <id>')
    .description('删除 MCP 服务')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.delete(`/api/mcp-servers/${id}`)
      if (!json) console.log(`MCP server ${shortId(id)} deleted.`)
      else printResult({ deleted: true, id }, json)
    })
}
```

- [ ] **Step 2: 注册到 main.ts**

```typescript
import { registerMcpCommands } from './commands/mcp.js'
// run() 内：
registerMcpCommands(program)
```

- [ ] **Step 3: 编译验证**

```bash
npm run build:cli && node cli.mjs mcp --help
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/mcp.ts src/cli/main.ts
git commit -m "feat(cli): add mcp commands (list/show/add/import/delete)"
```

---

### Task 6: skill 命令

**Files:**
- Create: `src/cli/commands/skill.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 1: 创建 src/cli/commands/skill.ts**

```typescript
import type { Command } from 'commander'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'

const SKILL_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v)) },
  { key: 'name', header: 'NAME' },
  { key: 'version', header: 'VERSION' },
  { key: 'is_builtin', header: 'BUILTIN', transform: (v) => v ? 'yes' : 'no' },
  { key: 'enabled', header: 'ENABLED', transform: (v) => v ? 'yes' : 'no' },
]

export function registerSkillCommands(parent: Command): void {
  const cmd = parent.command('skill').description('Skill 管理')

  cmd
    .command('list')
    .description('列出技能')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get('/api/skills')
      printResult(data, json, SKILL_COLUMNS)
    })

  cmd
    .command('show <id>')
    .description('查看技能详情')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get(`/api/skills/${id}`)
      printResult(data, json)
    })

  cmd
    .command('add')
    .description('导入技能')
    .option('--git <url>', '从 Git URL 导入')
    .option('--path <dir>', '从本地目录导入')
    .action(async (opts: Record<string, string>) => {
      const { client, json } = createClient(parent)
      if (opts.git) {
        const scan = await client.post<{ skills: Array<{ path: string }> }>(
          '/api/skills/import-git/scan', { url: opts.git }
        )
        if (scan.skills.length === 0) {
          throw new Error('No skills found at the given URL')
        }
        const data = await client.post('/api/skills/import-git/install', {
          url: opts.git,
          skill_path: scan.skills[0].path,
        })
        printResult(data, json)
      } else if (opts.path) {
        const data = await client.post('/api/skills/import-local', { path: opts.path })
        printResult(data, json)
      } else {
        throw new Error('Please specify --git <url> or --path <dir>')
      }
    })

  cmd
    .command('delete <id>')
    .description('删除技能')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.delete(`/api/skills/${id}`)
      if (!json) console.log(`Skill ${shortId(id)} deleted.`)
      else printResult({ deleted: true, id }, json)
    })
}
```

- [ ] **Step 2: 注册到 main.ts，编译验证，commit**

与前几个 Task 相同的模式。

```bash
git commit -m "feat(cli): add skill commands (list/show/add/delete)"
```

---

### Task 7: schedule 命令

**Files:**
- Create: `src/cli/commands/schedule.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 1: 创建 src/cli/commands/schedule.ts**

```typescript
import type { Command } from 'commander'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'

const SCHEDULE_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v)) },
  { key: 'title', header: 'TITLE' },
  { key: 'trigger_type', header: 'TRIGGER' },
  { key: 'action', header: 'ACTION' },
  { key: 'enabled', header: 'ENABLED', transform: (v) => v ? 'yes' : 'no' },
]

export function registerScheduleCommands(parent: Command): void {
  const cmd = parent.command('schedule').description('定时任务管理')

  cmd
    .command('list')
    .description('列出定时任务')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get('/api/schedules')
      printResult(data, json, SCHEDULE_COLUMNS)
    })

  cmd
    .command('show <id>')
    .description('查看定时任务详情')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get(`/api/schedules/${id}`)
      printResult(data, json)
    })

  cmd
    .command('add')
    .description('创建定时任务')
    .requiredOption('--title <title>', '任务标题')
    .option('--description <desc>', '任务描述')
    .option('--cron <expr>', 'Cron 表达式')
    .option('--trigger-at <iso>', '单次触发时间 (ISO 8601)')
    .option('--action <action>', '动作类型 (send_reminder/create_task)', 'send_reminder')
    .option('--target-channel <id>', '目标 Channel ID')
    .option('--target-session <id>', '目标 Session ID')
    .action(async (opts: Record<string, string>) => {
      const { client, json } = createClient(parent)
      const body: Record<string, unknown> = {
        title: opts.title,
        description: opts.description,
        action: opts.action,
      }
      if (opts.cron) {
        body.trigger_type = 'cron'
        body.cron = opts.cron
      } else if (opts['trigger-at'] || opts.triggerAt) {
        body.trigger_type = 'once'
        body.trigger_at = opts['trigger-at'] || opts.triggerAt
      }
      if (opts['target-channel'] || opts.targetChannel) {
        body.target_channel_id = opts['target-channel'] || opts.targetChannel
      }
      if (opts['target-session'] || opts.targetSession) {
        body.target_session_id = opts['target-session'] || opts.targetSession
      }
      const data = await client.post('/api/schedules', body)
      printResult(data, json)
    })

  cmd
    .command('trigger <id>')
    .description('立即触发定时任务')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.post(`/api/schedules/${id}/trigger`)
      if (!json) console.log(`Schedule ${shortId(id)} triggered.`)
      else printResult(data, json)
    })

  cmd
    .command('delete <id>')
    .description('删除定时任务')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.delete(`/api/schedules/${id}`)
      if (!json) console.log(`Schedule ${shortId(id)} deleted.`)
      else printResult({ deleted: true, id }, json)
    })
}
```

- [ ] **Step 2: 注册到 main.ts，编译验证，commit**

```bash
git commit -m "feat(cli): add schedule commands (list/show/add/trigger/delete)"
```

---

### Task 8: channel 命令

**Files:**
- Create: `src/cli/commands/channel.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 1: 创建 src/cli/commands/channel.ts**

```typescript
import type { Command } from 'commander'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'

const CHANNEL_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v)) },
  { key: 'name', header: 'NAME' },
  { key: 'implementation_id', header: 'IMPL', transform: (v) => shortId(String(v ?? '')) },
  { key: 'status', header: 'STATUS' },
]

export function registerChannelCommands(parent: Command): void {
  const cmd = parent.command('channel').description('Channel 实例管理')

  cmd
    .command('list')
    .description('列出 Channel 实例')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get('/api/channel-instances')
      printResult(data, json, CHANNEL_COLUMNS)
    })

  cmd
    .command('show <id>')
    .description('查看 Channel 实例详情')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get(`/api/channel-instances/${id}`)
      printResult(data, json)
    })

  cmd
    .command('config <id>')
    .description('查看或更新 Channel 配置')
    .option('--set <pairs...>', '更新配置（key=value 格式）')
    .action(async (id: string, opts: { set?: string[] }) => {
      const { client, json } = createClient(parent)
      if (opts.set && opts.set.length > 0) {
        // 复用 agent 命令中的 parseKeyValuePairs 逻辑
        const updates: Record<string, unknown> = {}
        for (const pair of opts.set) {
          const eq = pair.indexOf('=')
          if (eq === -1) throw new Error(`Invalid key=value pair: ${pair}`)
          updates[pair.slice(0, eq)] = pair.slice(eq + 1)
        }
        const data = await client.patch(`/api/channel-instances/${id}/config`, updates)
        printResult(data, json)
      } else {
        const data = await client.get(`/api/channel-instances/${id}/config`)
        printResult(data, json)
      }
    })

  cmd
    .command('start <id>')
    .description('启动 Channel')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.post(`/api/channel-instances/${id}/start`)
      if (!json) console.log(`Channel ${shortId(id)} started.`)
      else printResult({ started: true, id }, json)
    })

  cmd
    .command('stop <id>')
    .description('停止 Channel')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.post(`/api/channel-instances/${id}/stop`)
      if (!json) console.log(`Channel ${shortId(id)} stopped.`)
      else printResult({ stopped: true, id }, json)
    })

  cmd
    .command('restart <id>')
    .description('重启 Channel')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.post(`/api/channel-instances/${id}/restart`)
      if (!json) console.log(`Channel ${shortId(id)} restarted.`)
      else printResult({ restarted: true, id }, json)
    })
}
```

- [ ] **Step 2: 注册到 main.ts，编译验证，commit**

```bash
git commit -m "feat(cli): add channel commands (list/show/config/start/stop/restart)"
```

---

### Task 9: friend 命令

**Files:**
- Create: `src/cli/commands/friend.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 1: 创建 src/cli/commands/friend.ts**

```typescript
import type { Command } from 'commander'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'

const FRIEND_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v)) },
  { key: 'name', header: 'NAME' },
  { key: 'permission', header: 'PERMISSION' },
]

export function registerFriendCommands(parent: Command): void {
  const cmd = parent.command('friend').description('好友管理')

  cmd
    .command('list')
    .description('列出好友')
    .option('--search <keyword>', '按名称搜索')
    .action(async (opts: { search?: string }) => {
      const { client, json } = createClient(parent)
      const query = opts.search ? `?search=${encodeURIComponent(opts.search)}` : ''
      const data = await client.get(`/api/friends${query}`)
      printResult(data, json, FRIEND_COLUMNS)
    })

  cmd
    .command('show <id>')
    .description('查看好友详情')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get(`/api/friends/${id}`)
      printResult(data, json)
    })

  cmd
    .command('add')
    .description('添加好友')
    .requiredOption('--name <name>', '好友名称')
    .option('--permission <templateId>', '权限模板 ID')
    .action(async (opts: Record<string, string>) => {
      const { client, json } = createClient(parent)
      const body: Record<string, unknown> = { name: opts.name }
      if (opts.permission) body.permission_template_id = opts.permission
      const data = await client.post('/api/friends', body)
      printResult(data, json)
    })

  cmd
    .command('update <id>')
    .description('更新好友')
    .option('--name <name>', '新名称')
    .option('--permission <templateId>', '新权限模板 ID')
    .action(async (id: string, opts: Record<string, string>) => {
      const { client, json } = createClient(parent)
      const body: Record<string, unknown> = {}
      if (opts.name) body.name = opts.name
      if (opts.permission) body.permission_template_id = opts.permission
      const data = await client.patch(`/api/friends/${id}`, body)
      printResult(data, json)
    })

  cmd
    .command('delete <id>')
    .description('删除好友')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.delete(`/api/friends/${id}`)
      if (!json) console.log(`Friend ${shortId(id)} deleted.`)
      else printResult({ deleted: true, id }, json)
    })
}
```

- [ ] **Step 2: 注册到 main.ts，编译验证，commit**

```bash
git commit -m "feat(cli): add friend commands (list/show/add/update/delete)"
```

---

### Task 10: config + permission 命令

**Files:**
- Create: `src/cli/commands/config.ts`
- Create: `src/cli/commands/permission.ts`
- Modify: `src/cli/main.ts`

- [ ] **Step 1: 创建 src/cli/commands/config.ts**

```typescript
import type { Command } from 'commander'
import { createClient } from '../main.js'
import { printResult } from '../output.js'

export function registerConfigCommands(parent: Command): void {
  const cmd = parent.command('config').description('全局配置管理')

  cmd
    .command('show')
    .description('查看全局配置')
    .action(async () => {
      const { client, json } = createClient(parent)
      const [modelConfig, proxyConfig] = await Promise.all([
        client.get('/api/model-config/global'),
        client.get('/api/proxy-config'),
      ])
      printResult({ model: modelConfig, proxy: proxyConfig }, json)
    })

  cmd
    .command('set <pairs...>')
    .description('更新全局模型配置 (key=value 格式)')
    .action(async (pairs: string[]) => {
      const { client, json } = createClient(parent)
      const updates: Record<string, unknown> = {}
      for (const pair of pairs) {
        const eq = pair.indexOf('=')
        if (eq === -1) throw new Error(`Invalid key=value pair: ${pair}`)
        updates[pair.slice(0, eq)] = pair.slice(eq + 1)
      }
      const data = await client.patch('/api/model-config/global', updates)
      printResult(data, json)
    })

  const proxy = cmd.command('proxy').description('代理配置')

  proxy
    .command('show')
    .description('查看代理配置')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get('/api/proxy-config')
      printResult(data, json)
    })

  proxy
    .command('set <pairs...>')
    .description('更新代理配置 (key=value 格式)')
    .action(async (pairs: string[]) => {
      const { client, json } = createClient(parent)
      const updates: Record<string, unknown> = {}
      for (const pair of pairs) {
        const eq = pair.indexOf('=')
        if (eq === -1) throw new Error(`Invalid key=value pair: ${pair}`)
        updates[pair.slice(0, eq)] = pair.slice(eq + 1)
      }
      const data = await client.patch('/api/proxy-config', updates)
      printResult(data, json)
    })
}
```

- [ ] **Step 2: 创建 src/cli/commands/permission.ts**

```typescript
import type { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { createClient } from '../main.js'
import { printResult, shortId, type Column } from '../output.js'

const PERMISSION_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', transform: (v) => shortId(String(v)) },
  { key: 'name', header: 'NAME' },
  { key: 'is_system', header: 'SYSTEM', transform: (v) => v ? 'yes' : 'no' },
]

export function registerPermissionCommands(parent: Command): void {
  const cmd = parent.command('permission').description('权限模板管理')

  cmd
    .command('list')
    .description('列出权限模板')
    .action(async () => {
      const { client, json } = createClient(parent)
      const data = await client.get('/api/permission-templates')
      printResult(data, json, PERMISSION_COLUMNS)
    })

  cmd
    .command('show <id>')
    .description('查看权限模板详情')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      const data = await client.get(`/api/permission-templates/${id}`)
      printResult(data, json)
    })

  cmd
    .command('add')
    .description('创建权限模板')
    .requiredOption('--name <name>', '模板名称')
    .requiredOption('--file <path>', '模板 JSON 文件')
    .action(async (opts: Record<string, string>) => {
      const { client, json } = createClient(parent)
      const template = JSON.parse(readFileSync(opts.file, 'utf-8'))
      const body = { name: opts.name, ...template }
      const data = await client.post('/api/permission-templates', body)
      printResult(data, json)
    })

  cmd
    .command('update <id>')
    .description('更新权限模板')
    .option('--name <name>', '新名称')
    .option('--file <path>', '更新内容 JSON 文件')
    .action(async (id: string, opts: Record<string, string>) => {
      const { client, json } = createClient(parent)
      const body: Record<string, unknown> = {}
      if (opts.name) body.name = opts.name
      if (opts.file) Object.assign(body, JSON.parse(readFileSync(opts.file, 'utf-8')))
      const data = await client.patch(`/api/permission-templates/${id}`, body)
      printResult(data, json)
    })

  cmd
    .command('delete <id>')
    .description('删除权限模板')
    .action(async (id: string) => {
      const { client, json } = createClient(parent)
      await client.delete(`/api/permission-templates/${id}`)
      if (!json) console.log(`Permission template ${shortId(id)} deleted.`)
      else printResult({ deleted: true, id }, json)
    })
}
```

- [ ] **Step 3: 注册到 main.ts，编译验证**

```typescript
import { registerConfigCommands } from './commands/config.js'
import { registerPermissionCommands } from './commands/permission.js'
// run() 内：
registerConfigCommands(program)
registerPermissionCommands(program)
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/config.ts src/cli/commands/permission.ts src/cli/main.ts
git commit -m "feat(cli): add config and permission commands"
```

---

## Phase 3: Admin Internal Token + Agent 集成

### Task 11: Admin 生成 internal-token

**Files:**
- Modify: `crabot-admin/src/index.ts` (AdminModule.onStart)

- [ ] **Step 1: 在 AdminModule.onStart 中生成 internal-token 文件**

在 `crabot-admin/src/index.ts` 的 `onStart()` 方法中，在 JWT secret 初始化之后添加：

```typescript
// 在 this.jwtSecret 初始化之后（约 line 393 后）添加：

// 生成 internal-token 供 CLI 和 Agent 使用
const internalTokenPayload: JwtPayload = {
  sub: 'internal',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600, // 1年有效期（每次启动重新生成）
}
const internalToken = signJwt(internalTokenPayload, this.jwtSecret)
const tokenPath = path.join(this.adminConfig.data_dir, 'internal-token')
await fs.writeFile(tokenPath, internalToken, { mode: 0o600 })
console.log(`[Admin] Internal token written to ${tokenPath}`)
```

- [ ] **Step 2: 验证**

```bash
cd crabot-admin && npm run build && cd ..
# 启动系统后检查：
cat data/admin/internal-token
# Expected: 一个 JWT token 字符串
ls -la data/admin/internal-token
# Expected: -rw------- (权限 600)
```

- [ ] **Step 3: Commit**

```bash
git add crabot-admin/src/index.ts
git commit -m "feat(admin): generate internal-token on startup for CLI auth"
```

---

### Task 12: Agent 内置 crabot-cli Skill

**Files:**
- Create: `crabot-admin/builtins/skills/crabot-cli/SKILL.md`
- Create: `crabot-admin/builtins/skills/crabot-cli/references/command-ref.md`

- [ ] **Step 1: 创建 SKILL.md**

```markdown
---
name: crabot-cli
description: "使用 Crabot CLI 管理系统配置：模型 Provider、Agent 实例、MCP Server、Channel、技能、定时任务、好友、权限模板等"
version: "1.0.0"
metadata:
  openclaw:
    emoji: "⚙️"
    requires:
      bins:
        - node
---

# Crabot CLI 管理技能

## 使用条件

此技能仅在 **master 私聊** 场景可用。在其他场景下 CLI 命令会被系统拦截。

## 使用方式

通过 Bash tool 执行 `crabot <command> --json`，解析 JSON 输出。环境变量 `CRABOT_ENDPOINT` 和 `CRABOT_TOKEN` 由运行时自动注入，无需手动设置。

## 常用操作模式

### 查看系统状态

```bash
crabot provider list --json    # 查看可用的模型 Provider
crabot agent list --json       # 查看 Agent 实例
crabot channel list --json     # 查看 Channel 实例
crabot mcp list --json         # 查看 MCP 服务
```

### 切换模型

```bash
# 1. 查看可用 Provider 和模型
crabot provider list --json

# 2. 查看某个 Provider 的可用模型
crabot provider show <provider_id> --json

# 3. 更新全局默认模型
crabot config set default_llm_provider_id=<pid> default_llm_model_id=<mid>
```

### 管理 MCP 服务

```bash
crabot mcp list --json                                    # 列出
crabot mcp add --name myserver --command uvx --args my-mcp  # 添加
crabot mcp delete <id>                                    # 删除
```

### 管理定时任务

```bash
crabot schedule list --json
crabot schedule add --title "日报提醒" --cron "0 9 * * *" --action send_reminder
crabot schedule trigger <id>    # 立即触发
```

## 注意事项

- 始终使用 `--json` 参数以获得结构化输出
- ID 参数支持短前缀匹配（如 `bdbf` 匹配 `bdbf737d-...`）
- 详细命令参考见 `references/command-ref.md`
```

- [ ] **Step 2: 创建 references/command-ref.md**

将 spec §5.3 中的完整命令表格复制为参考文档，Agent 需要时通过 Skill tool 的引用目录加载。

- [ ] **Step 3: 验证 Skill 注册**

启动系统后检查：

```bash
node scripts/debug-agent.mjs health
# 确认 Admin 存活

# 检查 skills.json 中是否出现 crabot-cli
cat data/admin/skills.json | grep crabot-cli
# Expected: 出现 crabot-cli 条目
```

- [ ] **Step 4: Commit**

```bash
git add crabot-admin/builtins/skills/crabot-cli/
git commit -m "feat(admin): add crabot-cli built-in skill for Agent self-management"
```

---

### Task 13: Hook 权限控制 — block-cli handler

**Files:**
- Modify: `crabot-agent/src/hooks/internal-handlers.ts`
- Modify: `crabot-agent/src/hooks/defaults.ts`
- Modify: `crabot-agent/src/agent/worker-handler.ts`

- [ ] **Step 1: 注册 block-cli 内置 handler**

在 `crabot-agent/src/hooks/internal-handlers.ts` 末尾添加：

```typescript
// --- Built-in: block-cli ---
// 无条件阻止 crabot CLI 管理命令
registerInternalHandler('block-cli', async (_input, _context) => {
  return {
    action: 'block',
    message: 'CLI 管理命令仅在 master 私聊场景可用。',
  }
})
```

- [ ] **Step 2: 在 defaults.ts 中添加创建函数**

```typescript
// defaults.ts — 新增
export function createCliBlockHook(): HookDefinition {
  return {
    event: 'PreToolUse',
    matcher: 'Bash',
    if: 'Bash(crabot *)',
    type: 'command',
    command: '__internal:block-cli',
  }
}
```

- [ ] **Step 3: 在 worker-handler.ts 中根据权限注入 hook**

找到 hook registry 创建的位置（约 line 357），在创建 hook registry 时根据 session context 决定是否添加 CLI 拦截 hook：

```typescript
// 在 hookRegistry 创建逻辑附近添加：
import { createCliBlockHook } from '../hooks/defaults.js'

// 判断是否为 master 私聊
const isMasterPrivate =
  taskContext.friend?.permission === 'master' &&
  taskContext.session_type === 'private'

// 非 master 私聊场景注入 CLI 拦截 hook
if (!isMasterPrivate && hookRegistry) {
  hookRegistry.register(createCliBlockHook())
}
```

注意：需要查看 `worker-handler.ts` 中 `taskContext` 的实际结构来确定字段名。

- [ ] **Step 4: Skill 层过滤（双重保险）**

在 `crabot-agent/src/unified-agent.ts` 的 `buildSkillListing()` 方法中，添加对 `crabot-cli` skill 的权限过滤。传入 session context，非 master 私聊时过滤掉 `crabot-cli`：

```typescript
private buildSkillListing(
  skills?: ReadonlyArray<{ id: string; name: string; description?: string }>,
  sessionContext?: { isMasterPrivate: boolean }
): string {
  if (!skills || skills.length === 0) return ''

  const filtered = sessionContext?.isMasterPrivate === false
    ? skills.filter(s => s.name !== 'crabot-cli')
    : skills

  if (filtered.length === 0) return ''
  // ... 原有逻辑用 filtered 替代 skills
}
```

- [ ] **Step 5: 编译验证**

```bash
cd crabot-agent && npm run build && cd ..
```

- [ ] **Step 6: Commit**

```bash
git add crabot-agent/src/hooks/internal-handlers.ts crabot-agent/src/hooks/defaults.ts crabot-agent/src/agent/worker-handler.ts crabot-agent/src/unified-agent.ts
git commit -m "feat(agent): add CLI permission control via hook + skill filtering"
```

---

### Task 14: Worker Handler 注入 CLI 环境变量

**Files:**
- Modify: `crabot-agent/src/agent/worker-handler.ts`

- [ ] **Step 1: 在 task 执行时注入 CRABOT_ENDPOINT 和 CRABOT_TOKEN**

在 worker-handler.ts 中组装 task 执行环境的位置，添加环境变量注入：

```typescript
// 在 task 执行环境组装时：
const adminEndpoint = this.resolveAdminEndpoint() // 从 module config 获取
const internalTokenPath = path.join(this.dataDir, 'admin', 'internal-token')

try {
  const internalToken = await fs.promises.readFile(internalTokenPath, 'utf-8')
  taskEnv.CRABOT_ENDPOINT = adminEndpoint
  taskEnv.CRABOT_TOKEN = internalToken.trim()
} catch {
  // internal-token 不存在时不注入，CLI 命令将报错
}
```

- [ ] **Step 2: 编译验证**

```bash
cd crabot-agent && npm run build && cd ..
```

- [ ] **Step 3: Commit**

```bash
git add crabot-agent/src/agent/worker-handler.ts
git commit -m "feat(agent): inject CRABOT_ENDPOINT and CRABOT_TOKEN into task environment"
```

---

## Phase 4: 发行体系

### Task 15: install.sh 安装脚本

**Files:**
- Create: `install.sh`

- [ ] **Step 1: 创建 install.sh**

```bash
#!/bin/bash
set -e

# Crabot 安装脚本
# 用法:
#   远程安装: curl -fsSL <url>/install.sh | bash
#   源码安装: ./install.sh --from-source

CRABOT_VERSION="${CRABOT_VERSION:-latest}"
INSTALL_DIR="${CRABOT_INSTALL_DIR:-$HOME/.crabot}"
REQUIRED_NODE_VERSION="22.14.0"
FROM_SOURCE=false

# 解析参数
for arg in "$@"; do
  case "$arg" in
    --from-source) FROM_SOURCE=true ;;
    --version=*) CRABOT_VERSION="${arg#*=}" ;;
    --install-dir=*) INSTALL_DIR="${arg#*=}" ;;
  esac
done

# --- 颜色 ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${GREEN}[crabot]${NC} $1"; }
warn()    { echo -e "${YELLOW}[crabot]${NC} $1"; }
error()   { echo -e "${RED}[crabot]${NC} $1"; }
section() { echo -e "\n${BOLD}${CYAN}── $1 ──${NC}\n"; }

# --- OS 检测 ---
detect_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *) error "Unsupported OS: $(uname -s)"; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) error "Unsupported architecture: $(uname -m)"; exit 1 ;;
  esac
  echo "${os}-${arch}"
}

# --- Node.js 检查/安装 ---
ensure_node() {
  if command -v node &>/dev/null; then
    local current
    current=$(node -v | tr -d 'v')
    if version_ge "$current" "$REQUIRED_NODE_VERSION"; then
      info "Node.js $current found (>= $REQUIRED_NODE_VERSION)"
      return
    fi
    warn "Node.js $current found, but >= $REQUIRED_NODE_VERSION required"
  fi

  section "Installing Node.js"
  if command -v nvm &>/dev/null; then
    nvm install 22
    nvm use 22
  elif command -v brew &>/dev/null; then
    brew install node@22
  else
    # 使用 NodeSource 安装脚本
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  info "Node.js $(node -v) installed"
}

# --- uv 检查/安装 ---
ensure_uv() {
  if command -v uv &>/dev/null; then
    info "uv $(uv --version) found"
    return
  fi
  section "Installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  info "uv $(uv --version) installed"
}

# --- 版本比较 ---
version_ge() {
  local IFS=.
  local i ver1=($1) ver2=($2)
  for ((i=0; i<${#ver2[@]}; i++)); do
    if ((10#${ver1[i]:-0} > 10#${ver2[i]:-0})); then return 0; fi
    if ((10#${ver1[i]:-0} < 10#${ver2[i]:-0})); then return 1; fi
  done
  return 0
}

# --- 主流程 ---
main() {
  section "Crabot Installer"
  local platform
  platform=$(detect_platform)
  info "Platform: $platform"

  ensure_node
  ensure_uv

  if [ "$FROM_SOURCE" = true ]; then
    section "Source Install"
    info "Installing npm dependencies..."
    npm install
    info "Building all modules..."
    npm run build 2>/dev/null || {
      # 尝试各模块单独构建
      for dir in crabot-shared crabot-admin crabot-core crabot-agent; do
        (cd "$dir" && npm install && npm run build)
      done
      npm run build:cli
    }
    info "Setting up Python environment..."
    (cd crabot-memory && uv sync)
    info "Source install complete."
  else
    section "Release Install"
    # 获取版本
    local version="$CRABOT_VERSION"
    if [ "$version" = "latest" ]; then
      version=$(curl -fsSL "https://api.github.com/repos/anthropics/crabot/releases/latest" \
        | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')
      info "Latest version: $version"
    fi

    # 下载
    local filename="crabot-${version}-${platform}.tar.gz"
    local url="https://github.com/anthropics/crabot/releases/download/${version}/${filename}"
    info "Downloading $filename..."
    mkdir -p "$INSTALL_DIR"
    curl -fsSL "$url" -o "/tmp/$filename"

    # Checksum 校验
    local checksum_url="${url}.sha256"
    if curl -fsSL "$checksum_url" -o "/tmp/${filename}.sha256" 2>/dev/null; then
      info "Verifying checksum..."
      (cd /tmp && sha256sum -c "${filename}.sha256") || {
        error "Checksum verification failed!"
        exit 1
      }
    fi

    # 解压
    info "Extracting to $INSTALL_DIR..."
    tar -xzf "/tmp/$filename" -C "$INSTALL_DIR" --strip-components=1
    rm -f "/tmp/$filename" "/tmp/${filename}.sha256"

    # Python 依赖
    info "Setting up Python environment..."
    (cd "$INSTALL_DIR/crabot-memory" && uv sync)
  fi

  # PATH 设置
  section "Setting up PATH"
  local bin_dir="$HOME/.local/bin"
  mkdir -p "$bin_dir"

  local crabot_path
  if [ "$FROM_SOURCE" = true ]; then
    crabot_path="$(pwd)/cli.mjs"
  else
    crabot_path="$INSTALL_DIR/cli.mjs"
  fi
  ln -sf "$crabot_path" "$bin_dir/crabot"
  chmod +x "$crabot_path"

  # 检查 PATH
  if ! echo "$PATH" | grep -q "$bin_dir"; then
    local shell_rc
    case "$SHELL" in
      */zsh)  shell_rc="$HOME/.zshrc" ;;
      */bash) shell_rc="$HOME/.bashrc" ;;
      *)      shell_rc="$HOME/.profile" ;;
    esac
    echo "export PATH=\"$bin_dir:\$PATH\"" >> "$shell_rc"
    warn "Added $bin_dir to PATH in $shell_rc. Restart your shell or run:"
    echo "  export PATH=\"$bin_dir:\$PATH\""
  fi

  section "Done!"
  info "Run 'crabot start' to start Crabot."
  info "Run 'crabot --help' for all commands."
}

main "$@"
```

- [ ] **Step 2: 设置可执行权限**

```bash
chmod +x install.sh
```

- [ ] **Step 3: 本地验证 --from-source 模式**

```bash
./install.sh --from-source
crabot --help
```

- [ ] **Step 4: Commit**

```bash
git add install.sh
git commit -m "feat: add cross-platform install script (remote + source modes)"
```

---

### Task 16: install.ps1 Windows 安装脚本

**Files:**
- Create: `install.ps1`

- [ ] **Step 1: 创建 install.ps1**

```powershell
# Crabot Windows Installer
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1

param(
    [switch]$FromSource,
    [string]$Version = "latest",
    [string]$InstallDir = "$env:USERPROFILE\.crabot"
)

$RequiredNodeVersion = "22.14.0"

function Write-Info($msg)  { Write-Host "[crabot] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[crabot] $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "[crabot] $msg" -ForegroundColor Red }

# --- Node.js ---
function Ensure-Node {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $ver = (node -v).TrimStart('v')
        Write-Info "Node.js $ver found"
        return
    }
    Write-Err "Node.js not found. Please install Node.js >= $RequiredNodeVersion from https://nodejs.org"
    exit 1
}

# --- uv ---
function Ensure-Uv {
    $uvCmd = Get-Command uv -ErrorAction SilentlyContinue
    if ($uvCmd) {
        Write-Info "uv found"
        return
    }
    Write-Info "Installing uv..."
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
}

# --- Main ---
Write-Host "`n== Crabot Installer ==`n" -ForegroundColor Cyan

Ensure-Node
Ensure-Uv

if ($FromSource) {
    Write-Info "Source install..."
    npm install
    npm run build
    Set-Location crabot-memory
    uv sync
    Set-Location ..
} else {
    Write-Info "Release install..."
    if ($Version -eq "latest") {
        $release = Invoke-RestMethod "https://api.github.com/repos/anthropics/crabot/releases/latest"
        $Version = $release.tag_name
    }
    $filename = "crabot-$Version-windows-x64.zip"
    $url = "https://github.com/anthropics/crabot/releases/download/$Version/$filename"

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Write-Info "Downloading $filename..."
    Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\$filename"

    Write-Info "Extracting..."
    Expand-Archive -Path "$env:TEMP\$filename" -DestinationPath $InstallDir -Force
    Remove-Item "$env:TEMP\$filename"

    Set-Location "$InstallDir\crabot-memory"
    uv sync
    Set-Location $InstallDir
}

# PATH
$crabotDir = if ($FromSource) { (Get-Location).Path } else { $InstallDir }
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$crabotDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$crabotDir;$currentPath", "User")
    Write-Info "Added $crabotDir to user PATH"
}

# 创建 crabot.cmd 如果不存在
$cmdPath = Join-Path $crabotDir "crabot.cmd"
if (-not (Test-Path $cmdPath)) {
    '@echo off`nnode "%~dp0cli.mjs" %*' | Out-File -FilePath $cmdPath -Encoding ASCII
}

Write-Host "`n== Done! ==`n" -ForegroundColor Cyan
Write-Info "Run 'crabot start' to start Crabot."
```

- [ ] **Step 2: Commit**

```bash
git add install.ps1
git commit -m "feat: add Windows install script (install.ps1)"
```

---

### Task 17: GitHub Actions Release Workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: 创建 .github/workflows/release.yml**

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            platform: linux
            arch: x64
          - os: macos-14
            platform: darwin
            arch: arm64
          - os: windows-latest
            platform: windows
            arch: x64
    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install dependencies
        run: |
          npm install
          cd crabot-shared && npm install && cd ..
          cd crabot-admin && npm install && cd ..
          cd crabot-core && npm install && cd ..
          cd crabot-agent && npm install && cd ..

      - name: Build
        run: |
          cd crabot-shared && npm run build && cd ..
          cd crabot-admin && npm run build && npm run build:web && cd ..
          cd crabot-core && npm run build && cd ..
          cd crabot-agent && npm run build && cd ..
          npm run build:cli

      - name: Package (Unix)
        if: matrix.platform != 'windows'
        run: |
          VERSION=${GITHUB_REF_NAME}
          DIRNAME="crabot-${VERSION}-${{ matrix.platform }}-${{ matrix.arch }}"
          mkdir -p "/tmp/${DIRNAME}"

          # 复制运行时文件
          cp cli.mjs crabot.cmd package.json install.sh install.ps1 "/tmp/${DIRNAME}/"
          cp -r dist scripts node_modules "/tmp/${DIRNAME}/"

          # 复制各模块（排除 src、test、.git）
          for mod in crabot-shared crabot-admin crabot-core crabot-agent \
                     crabot-channel-host crabot-channel-telegram crabot-channel-wechat \
                     crabot-memory crabot-mcp-tools; do
            if [ -d "$mod" ]; then
              rsync -a --exclude='src/' --exclude='test*/' --exclude='.git/' \
                    --exclude='node_modules/.cache/' --exclude='.venv/' \
                    --exclude='.env' "$mod/" "/tmp/${DIRNAME}/$mod/"
            fi
          done

          # 打包
          cd /tmp
          tar -czf "${DIRNAME}.tar.gz" "${DIRNAME}"
          shasum -a 256 "${DIRNAME}.tar.gz" > "${DIRNAME}.tar.gz.sha256"

          # 移回 workspace
          mv "${DIRNAME}.tar.gz" "${DIRNAME}.tar.gz.sha256" "$GITHUB_WORKSPACE/"

      - name: Package (Windows)
        if: matrix.platform == 'windows'
        shell: pwsh
        run: |
          $Version = $env:GITHUB_REF_NAME
          $DirName = "crabot-${Version}-windows-x64"
          $TempDir = "$env:TEMP\$DirName"
          New-Item -ItemType Directory -Force -Path $TempDir

          Copy-Item cli.mjs, crabot.cmd, package.json, install.sh, install.ps1 $TempDir
          Copy-Item -Recurse dist, scripts, node_modules $TempDir

          $modules = @('crabot-shared','crabot-admin','crabot-core','crabot-agent',
                       'crabot-channel-host','crabot-channel-telegram','crabot-channel-wechat',
                       'crabot-memory','crabot-mcp-tools')
          foreach ($mod in $modules) {
            if (Test-Path $mod) {
              $dest = Join-Path $TempDir $mod
              Copy-Item -Recurse $mod $dest
              # 清理不需要的目录
              Remove-Item -Recurse -Force "$dest\src" -ErrorAction SilentlyContinue
              Remove-Item -Recurse -Force "$dest\test*" -ErrorAction SilentlyContinue
              Remove-Item -Recurse -Force "$dest\.venv" -ErrorAction SilentlyContinue
            }
          }

          Compress-Archive -Path $TempDir -DestinationPath "$DirName.zip"
          (Get-FileHash "$DirName.zip" -Algorithm SHA256).Hash | Out-File "$DirName.zip.sha256"

      - name: Upload Release Assets
        uses: softprops/action-gh-release@v2
        with:
          files: |
            crabot-*.tar.gz
            crabot-*.tar.gz.sha256
            crabot-*.zip
            crabot-*.zip.sha256
```

- [ ] **Step 2: Commit**

```bash
mkdir -p .github/workflows
git add .github/workflows/release.yml
git commit -m "ci: add release workflow for multi-platform packaging"
```

---

## Phase 5: 集成验证

### Task 18: 端到端验证

- [ ] **Step 1: 编译全部**

```bash
cd crabot-shared && npm run build && cd ..
cd crabot-admin && npm run build && cd ..
cd crabot-agent && npm run build && cd ..
npm run build:cli
```

- [ ] **Step 2: 启动系统**

```bash
./dev.sh
```

- [ ] **Step 3: 验证 internal-token 生成**

```bash
cat data/admin/internal-token
# Expected: JWT token 字符串
ls -la data/admin/internal-token
# Expected: -rw------- (600 权限)
```

- [ ] **Step 4: 验证 CLI 管理命令**

```bash
node cli.mjs provider list
# Expected: 表格输出

node cli.mjs provider list --json
# Expected: JSON 输出

node cli.mjs agent list
node cli.mjs mcp list
node cli.mjs skill list
node cli.mjs schedule list
node cli.mjs channel list
node cli.mjs friend list
node cli.mjs config show
node cli.mjs permission list
# Expected: 所有命令正常返回数据
```

- [ ] **Step 5: 验证多实例**

```bash
CRABOT_PORT_OFFSET=100 ./dev.sh &
CRABOT_PORT_OFFSET=100 node cli.mjs provider list
# Expected: 连接到 port 3100 的 Admin 实例
```

- [ ] **Step 6: 验证 Skill 注册**

```bash
cat data/admin/skills.json | python3 -c "import sys,json; skills=json.load(sys.stdin); print([s['name'] for s in skills if s['name']=='crabot-cli'])"
# Expected: ['crabot-cli']
```

- [ ] **Step 7: Commit 最终调整（如有）**

```bash
git add -A
git commit -m "chore: integration fixes for CLI + release system"
```
