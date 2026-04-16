# CLI + 发行体系 + Agent 内置 Skill 设计

日期：2026-04-15
状态：Draft

---

## 1. 背景

当前 `./crabot` 是一个纯 bash 脚本，仅提供 `onboard/start/stop/check/help` 五个运维命令，无法覆盖 Admin 的管理能力。

目标：

1. 构建完整的 **CLI 管理工具**，覆盖 Admin Web UI 的主要能力（Provider、Agent、MCP、Skill、Schedule、Channel、Friend、权限模板、全局配置）
2. 建立 **发行体系**，支持源码安装和 Release 包两种方式，配合 GitHub Actions 自动发布
3. 提供 **Agent 内置 Skill**，让 Agent 在 master 私聊场景下通过 CLI 完成自我管理
4. 通过 **Hook 权限控制**，确保 CLI 管理命令仅在 master 私聊场景可用

## 2. 架构总览

```
┌─────────────────────────────────────────────────────┐
│                    cli.mjs                          │
│              (纯 JS，#!/usr/bin/env node)            │
│                                                     │
│  引导命令 (start/stop/check)    管理命令 (provider/  │
│  ─ 内联实现，无需编译             agent/mcp/...)     │
│  ─ 不依赖 Admin 在线            ─ import dist/cli/  │
│                                 ─ 调用 Admin REST   │
└────────────┬───────────────────────────┬────────────┘
             │                           │
             ▼                           ▼
   child_process 执行              Admin REST API
   构建/启停脚本                   (port 3000, JWT 认证)
```

### 2.1 CLI 代码位置

```
项目根目录/
├── cli.mjs                         # 入口（纯 JS，跨平台）
├── src/cli/                        # TypeScript 源码
│   ├── main.ts                     # commander program 定义 + 命令注册
│   ├── client.ts                   # Admin REST API 客户端
│   ├── auth.ts                     # JWT token 管理（login + 本地缓存）
│   ├── output.ts                   # 输出格式化（table/json 双模式）
│   └── commands/                   # 按领域分组
│       ├── start.ts
│       ├── stop.ts
│       ├── check.ts
│       ├── provider.ts
│       ├── agent.ts
│       ├── mcp.ts
│       ├── skill.ts
│       ├── schedule.ts
│       ├── channel.ts
│       ├── friend.ts
│       ├── config.ts
│       └── permission.ts
├── tsconfig.cli.json               # CLI 专用编译配置
└── dist/cli/                       # 编译产物
```

### 2.2 设计约束

- CLI 是 Admin REST API 的**薄客户端**，不直接访问数据文件
- 管理命令需要 Admin 在线；引导命令（start/stop/check）不依赖 Admin
- 通过 `crabot-shared` 引入接口类型定义，与 Admin API 保持一致
- `cli.mjs` 为纯 JavaScript，无需编译即可执行引导命令

## 3. cli.mjs 入口设计

```javascript
#!/usr/bin/env node

// cli.mjs — 纯 JS，不依赖任何 npm 包，跨平台（macOS/Linux/Windows）

import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const command = args[0] ?? 'help'

// 引导命令：纯 JS 实现（不依赖 bash 脚本），跨平台兼容
const bootstrapCommands = {
  start: () => import('./scripts/start.mjs'),
  stop: () => import('./scripts/stop.mjs'),
  check: () => import('./scripts/check.mjs'),
  help: () => printHelp(),
}

if (command in bootstrapCommands) {
  bootstrapCommands[command]()
} else {
  // 管理命令：委托给编译后的 TypeScript CLI
  const cliEntry = resolve(__dirname, 'dist/cli/main.js')
  if (!existsSync(cliEntry)) {
    console.error('CLI not built. Run "crabot start" first or build with "npm run build:cli".')
    process.exit(1)
  }
  const { run } = await import(cliEntry)
  run(process.argv)
}
```

**Windows 入口** — `crabot.cmd`：

```cmd
@echo off
node "%~dp0cli.mjs" %*
```

macOS/Linux 通过 shebang 直接 `./crabot`（cli.mjs 的 symlink），Windows 通过 `crabot.cmd` 或 `node cli.mjs`。

## 4. 认证机制

### 4.1 设计原则

CLI 是本地工具，不需要交互式登录。认证 token 自动从项目数据目录读取。

### 4.2 内部 Token

Admin 启动时生成一个长期有效的内部 token，写入 `<DATA_DIR>/admin/internal-token`。CLI 和 Agent 均通过读取此文件获取认证信息。

```
<DATA_DIR>/admin/internal-token    # 纯文本，内容为 JWT token
```

此 token 权限等同 master。安全措施：

- **文件权限**：macOS/Linux 创建时设置为 `0600`（仅 owner 可读写）；Windows 通过 `icacls` 限制为当前用户只读
- **自动轮转**：Admin 每次启动时重新生成 token，旧 token 立即失效。即使 token 泄漏，重启后自动恢复安全

### 4.3 Token 解析优先级

```
环境变量 CRABOT_TOKEN > 文件 <DATA_DIR>/admin/internal-token
```

- **人类使用 CLI**：自动读取 internal-token 文件，零交互
- **Agent 使用 CLI**：Worker Handler 通过 `CRABOT_TOKEN` 环境变量注入（同一个 internal-token）
- **远程/特殊场景**：通过 `--token` 参数或 `CRABOT_TOKEN` 环境变量手动指定

### 4.4 多实例部署支持

CLI 通过 `CRABOT_PORT_OFFSET` 环境变量识别目标实例，与 `dev.sh` / `crabot start` 行为一致：

```bash
# 默认实例（offset=0）
crabot provider list

# 实例 B（offset=100）
CRABOT_PORT_OFFSET=100 crabot provider list
```

**端点解析优先级：**

```
环境变量 CRABOT_ENDPOINT
  > CRABOT_PORT_OFFSET 推导：http://localhost:${3000 + offset}
  > 默认 http://localhost:3000
```

**Token 路径解析优先级：**

```
环境变量 CRABOT_TOKEN
  > 文件 ${DATA_DIR}/admin/internal-token
  > 文件 data-${CRABOT_PORT_OFFSET}/admin/internal-token（offset > 0 时）
  > 文件 data/admin/internal-token（offset = 0 或未设置时）
```

**引导命令同样支持：**

```bash
CRABOT_PORT_OFFSET=100 crabot start   # 启动实例 B（端口 +100，数据目录 data-100/）
CRABOT_PORT_OFFSET=100 crabot stop    # 停止实例 B
```

`DATA_DIR` 环境变量可显式覆盖数据目录，优先级高于 offset 推导。

## 5. 命令设计

### 5.1 全局选项

```
--json            JSON 输出（默认：人类可读表格）
--endpoint URL    指定 Admin 地址（覆盖自动解析）
--token TOKEN     指定 JWT token（覆盖 internal-token 文件）
```

### 5.2 引导命令（不需要 Admin 在线）

| 命令 | 说明 |
|------|------|
| `crabot start` | 构建所有模块 + 启动系统 |
| `crabot stop` | 停止所有进程 |
| `crabot check` | 检查环境依赖和项目状态 |
| `crabot help` | 显示帮助信息 |

引导命令用纯 JS 实现（`scripts/start.mjs`、`scripts/stop.mjs`、`scripts/check.mjs`），使用 `node:child_process`、`node:fs` 等内置模块，跨平台兼容。现有 bash 脚本（`start.sh` 等）保留作为参考，不再作为运行时依赖。

### 5.3 管理命令（需要 Admin 在线）

#### 5.3.1 Model Provider

| 命令 | API | 说明 |
|------|-----|------|
| `crabot provider list` | `GET /api/model-providers` | 列出所有 Provider |
| `crabot provider show <id>` | `GET /api/model-providers/:id` | 查看 Provider 详情 |
| `crabot provider add` | `POST /api/model-providers` | 创建 Provider |
| `crabot provider test <id>` | `POST /api/model-providers/:id/test` | 测试连接 |
| `crabot provider refresh <id>` | `POST /api/model-providers/:id/refresh-models` | 刷新模型列表 |
| `crabot provider delete <id>` | `DELETE /api/model-providers/:id` | 删除 Provider |

`provider add` 参数：`--name <name> --type <type> --endpoint <url> --apikey <key>`

> **安全提示**：`--apikey` 等敏感参数会出现在 shell history 和进程列表中。支持从 stdin 读取：`echo "sk-xxx" | crabot provider add --name foo --type openai --endpoint https://... --apikey-stdin`

#### 5.3.2 Agent 实例

| 命令 | API | 说明 |
|------|-----|------|
| `crabot agent list` | `GET /api/agent-instances` | 列出 Agent 实例 |
| `crabot agent show <id>` | `GET /api/agent-instances/:id` | 查看实例详情 |
| `crabot agent config <id>` | `GET /api/agent-instances/:id/config` | 查看实例配置 |
| `crabot agent config <id> --set k=v` | `PATCH /api/agent-instances/:id/config` | 更新配置 |
| `crabot agent restart <id>` | 复合操作 | 重启 Agent |

`--set` 支持点号路径：`--set models.default.provider_id=xxx --set models.default.model_id=yyy`

#### 5.3.3 MCP Server

| 命令 | API | 说明 |
|------|-----|------|
| `crabot mcp list` | `GET /api/mcp-servers` | 列出 MCP 服务 |
| `crabot mcp show <id>` | `GET /api/mcp-servers/:id` | 查看详情 |
| `crabot mcp add` | `POST /api/mcp-servers` | 创建 MCP 服务 |
| `crabot mcp import <file>` | `POST /api/mcp-servers/import-json` | 批量导入 |
| `crabot mcp delete <id>` | `DELETE /api/mcp-servers/:id` | 删除 MCP 服务 |

`mcp add` 参数：`--name <name> --command <cmd> --args <a1,a2>`

#### 5.3.4 Skill

| 命令 | API | 说明 |
|------|-----|------|
| `crabot skill list` | `GET /api/skills` | 列出技能 |
| `crabot skill show <id>` | `GET /api/skills/:id` | 查看详情 |
| `crabot skill add --git <url>` | `POST /api/skills/import-git/*` | 从 Git 导入 |
| `crabot skill add --path <dir>` | `POST /api/skills/import-local` | 从本地导入 |
| `crabot skill delete <id>` | `DELETE /api/skills/:id` | 删除技能 |

#### 5.3.5 Schedule

| 命令 | API | 说明 |
|------|-----|------|
| `crabot schedule list` | `GET /api/schedules` | 列出定时任务 |
| `crabot schedule show <id>` | `GET /api/schedules/:id` | 查看详情 |
| `crabot schedule add` | `POST /api/schedules` | 创建定时任务 |
| `crabot schedule trigger <id>` | `POST /api/schedules/:id/trigger` | 立即触发 |
| `crabot schedule delete <id>` | `DELETE /api/schedules/:id` | 删除定时任务 |

`schedule add` 参数：`--title <t> --cron "0 9 * * *" --action send_reminder`

#### 5.3.6 Channel 实例

| 命令 | API | 说明 |
|------|-----|------|
| `crabot channel list` | `GET /api/channel-instances` | 列出 Channel |
| `crabot channel show <id>` | `GET /api/channel-instances/:id` | 查看详情 |
| `crabot channel config <id>` | `GET /api/channel-instances/:id/config` | 查看配置 |
| `crabot channel config <id> --set k=v` | `PATCH /api/channel-instances/:id/config` | 更新配置 |
| `crabot channel start <id>` | `POST /api/channel-instances/:id/start` | 启动 |
| `crabot channel stop <id>` | `POST /api/channel-instances/:id/stop` | 停止 |
| `crabot channel restart <id>` | `POST /api/channel-instances/:id/restart` | 重启 |

#### 5.3.7 Friend

| 命令 | API | 说明 |
|------|-----|------|
| `crabot friend list` | `GET /api/friends` | 列出好友 |
| `crabot friend show <id>` | `GET /api/friends/:id` | 查看详情 |
| `crabot friend add` | `POST /api/friends` | 添加好友 |
| `crabot friend update <id>` | `PATCH /api/friends/:id` | 更新好友 |
| `crabot friend delete <id>` | `DELETE /api/friends/:id` | 删除好友 |

`friend list` 支持 `--search <keyword>` 搜索。
`friend add` 参数：`--name <name> --permission <template_id>`

#### 5.3.8 全局配置

| 命令 | API | 说明 |
|------|-----|------|
| `crabot config show` | `GET /api/model-config/global` + `GET /api/proxy-config` | 查看全局配置 |
| `crabot config set k=v [k=v...]` | `PATCH /api/model-config/global` | 更新模型配置 |
| `crabot config proxy show` | `GET /api/proxy-config` | 查看代理配置 |
| `crabot config proxy set k=v` | `PATCH /api/proxy-config` | 更新代理配置 |

#### 5.3.9 权限模板

| 命令 | API | 说明 |
|------|-----|------|
| `crabot permission list` | `GET /api/permission-templates` | 列出模板 |
| `crabot permission show <id>` | `GET /api/permission-templates/:id` | 查看详情 |
| `crabot permission add` | `POST /api/permission-templates` | 创建模板 |
| `crabot permission update <id>` | `PATCH /api/permission-templates/:id` | 更新模板 |
| `crabot permission delete <id>` | `DELETE /api/permission-templates/:id` | 删除模板 |

`permission add/update` 参数：`--name <name> --file <template.json>`

### 5.4 输出格式

**默认：人类可读表格**

```
$ crabot provider list
ID          NAME           TYPE     MODELS  STATUS
bdbf737d    Ollama Local   ollama   12      online
a3c1f9e2    OpenAI         openai   8       online
```

**`--json`：结构化 JSON**

```json
[
  {"id": "bdbf737d-...", "name": "Ollama Local", "type": "ollama", "model_count": 12},
  {"id": "a3c1f9e2-...", "name": "OpenAI", "type": "openai", "model_count": 8}
]
```

Agent 使用时始终加 `--json` 以便解析。

### 5.5 ID 短前缀匹配

所有接受 `<id>` 参数的命令支持 UUID 短前缀匹配（与现有 debug-agent.mjs 一致）：

```bash
crabot provider show bdbf     # 匹配 bdbf737d-...
crabot agent config a3c1      # 匹配 a3c1f9e2-...
```

匹配到多个结果时报错并列出候选。

## 6. 发行体系

### 6.1 Release 包内容

```
crabot-v2026.4.15-<platform>-<arch>.tar.gz  (linux/darwin)
crabot-v2026.4.15-windows-<arch>.zip

# 包内结构：
crabot/
├── cli.mjs
├── dist/                       # 预编译 JS（Admin, Agent, CLI 等）
├── crabot-admin/               # Admin 模块（含 builtins/、web 静态文件）
├── crabot-agent/               # Agent 模块
├── crabot-core/                # Module Manager
├── crabot-shared/              # 共享包
├── crabot-channel-host/        # Channel Host
├── crabot-channel-telegram/    # Telegram Channel
├── crabot-channel-wechat/      # WeChat Channel
├── crabot-memory/              # Memory 模块（Python 源码）
├── crabot-mcp-tools/           # MCP Tools
├── node_modules/               # 预装 npm 依赖
├── scripts/                    # 构建/启停脚本
└── package.json
```

平台区分主要是 native npm 依赖（如 sqlite 绑定）。纯 JS 部分跨平台通用。

### 6.2 安装方式

#### 方式一：远程一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/<org>/crabot/main/install.sh | bash
```

`install.sh` 执行流程：

1. 检测 OS（linux/darwin/windows-wsl）和 CPU 架构（x64/arm64）
2. 检查并安装 Node.js（通过 nvm 或系统包管理器），要求 >= 22.14.0
3. 检查并安装 uv（Python 包管理器）
4. 从 GitHub Releases 下载对应平台的 Release 包
5. 解压到安装目录（默认 `~/.crabot/`）
6. 用 `uv sync` 创建 venv 并安装 Memory 模块的 Python 依赖
7. 将 `crabot` 命令加入 PATH（macOS/Linux：symlink 到 `~/.local/bin/crabot`）
8. 提示用户运行 `crabot start`

Windows 对应 `install.ps1`：逻辑等价，PATH 设置通过修改用户环境变量实现，同时创建 `crabot.cmd` 入口。

#### 方式二：源码安装

```bash
git clone https://github.com/<org>/crabot.git
cd crabot
./install.sh --from-source
```

`--from-source` 模式：

1. 检查 Node.js、uv 环境
2. `npm install`（安装 npm 依赖）
3. `npm run build`（编译所有模块 + CLI）
4. `uv sync`（创建 Python venv + 安装依赖）
5. 设置 PATH

### 6.3 CI/CD 自动发布

```yaml
# .github/workflows/release.yml
# 触发：推送 v* tag（如 v2026.4.15）

name: Release

on:
  push:
    tags: ['v*']

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            platform: linux
            arch: x64
          - os: macos-latest
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
      - run: npm install
      - run: npm run build
      - name: Package
        run: |
          # 包含：cli.mjs, dist/, node_modules/, scripts/, package.json,
          #       crabot-*/（各模块，含 Python 源码、builtins）
          # 排除：.git/, **/src/（TypeScript 源码，已编译到 dist/）,
          #       **/test/, docs/, **/.env, **/node_modules/.cache/,
          #       crabot-memory/.venv/（由安装脚本重建）
      - name: Upload to Release
        uses: softprops/action-gh-release@v2
        with:
          files: crabot-*.tar.gz
```

### 6.4 Release 包完整性校验

CI 构建时为每个平台包生成 SHA-256 checksum 文件：

```
crabot-v2026.4.15-linux-x64.tar.gz
crabot-v2026.4.15-linux-x64.tar.gz.sha256
crabot-v2026.4.15-darwin-arm64.tar.gz
crabot-v2026.4.15-darwin-arm64.tar.gz.sha256
```

`install.sh` 下载后自动校验 checksum，不匹配则中止安装。

### 6.5 版本策略

采用日历版本号：`v2026.4.15`，与 OpenClaw 一致。

tag 命名规范：`v<year>.<month>.<day>`，同一天多次发布追加后缀：`v2026.4.15.1`。

## 7. Agent 内置 Skill

### 7.1 文件结构

```
crabot-admin/builtins/skills/crabot-cli/
├── SKILL.md                    # Skill 主文件
└── references/
    └── command-ref.md          # 完整命令参考
```

### 7.2 SKILL.md

```yaml
---
name: crabot-cli
description: "使用 Crabot CLI 管理系统配置：模型、Agent、MCP、Channel、技能、定时任务等"
version: "1.0.0"
metadata:
  openclaw:
    emoji: "⚙️"
    requires:
      bins:
        - node
---
```

正文内容：

1. **使用条件**：仅在 master 私聊场景可用
2. **使用方式**：通过 Bash tool 执行 `crabot <command> --json`，解析 JSON 输出
3. **认证**：使用环境变量 `CRABOT_ENDPOINT` 和 `CRABOT_TOKEN`（由运行时自动注入）
4. **常用操作模式**：
   - 查看系统状态：`crabot provider list --json` → `crabot agent list --json`
   - 切换模型：`crabot provider list --json` → 找到目标 → `crabot config set ...`
   - 管理 MCP：`crabot mcp list --json` → `crabot mcp add ...`
5. **详细命令参考**：指向 `references/command-ref.md`

### 7.3 注册方式

与 `scrapling-official` 一致：

- Admin 启动时 `SkillManager.registerBuiltins()` 自动扫描 `builtins/skills/crabot-cli/`
- `is_builtin: true`，`can_disable: true`
- 默认加入 Agent 实例的 `skill_ids`

### 7.4 Agent 环境变量注入

Worker Handler 在执行 task 时，自动将以下环境变量注入 task 执行环境：

```typescript
// worker-handler.ts — task 执行时注入
env.CRABOT_ENDPOINT = adminWebEndpoint   // e.g. http://localhost:3000
env.CRABOT_TOKEN = internalToken         // 读取自 <DATA_DIR>/admin/internal-token
```

使用与人类 CLI 相同的 internal-token，无需额外的 token 签发逻辑。

## 8. Hook 权限控制

### 8.1 设计原则

CLI 管理命令是高权限操作。权限判断在 orchestration 层（session 初始化时），不在 hook 内部。hook 只做无条件拦截。

### 8.2 实现方式

在 Worker Handler 组装 task 执行上下文时，根据 session 权限决定是否注入 CLI 拦截 hook：

```typescript
// worker-handler.ts — 组装 hook 列表
function buildTaskHooks(sessionContext: SessionContext): HookDefinition[] {
  const hooks = [...defaultHooks]

  const isMasterPrivate =
    sessionContext.friend?.permission === 'master' &&
    sessionContext.session_type === 'private'

  if (!isMasterPrivate) {
    hooks.push({
      event: 'PreToolUse',
      matcher: 'Bash',
      if: 'Bash(crabot *)',
      type: 'command',
      command: '__internal:block-cli',
    })
  }

  return hooks
}
```

### 8.3 内置 Handler

在 `crabot-agent/src/hooks/internal-handlers.ts` 注册：

```typescript
// __internal:block-cli
// 无条件阻止 crabot CLI 管理命令
registerInternalHandler('block-cli', async (input: HookInput): Promise<HookResult> => {
  return {
    action: 'block',
    message: 'CLI 管理命令仅在 master 私聊场景可用。',
  }
})
```

### 8.4 权限矩阵

| 场景 | CLI 拦截 hook | CLI 可用 |
|------|--------------|----------|
| Master 私聊 | 不注入 | 可用 |
| Master 群聊 | 注入 | 不可用 |
| Normal 用户私聊 | 注入 | 不可用 |
| Normal 用户群聊 | 注入 | 不可用 |

### 8.5 Skill 与 Hook 的协同

即使非 master 场景加载了 `crabot-cli` skill，hook 也会阻止实际执行。但从 Skill 注册层面，可以进一步优化：

- `buildSkillListing()` 在组装可用技能列表时，检查 session 权限
- 非 master 私聊场景不将 `crabot-cli` 列入可用技能
- 避免 Agent 浪费 token 去尝试不可用的 CLI 命令

这是**双重保险**：Skill 层过滤（避免浪费）+ Hook 层拦截（确保安全）。

## 9. 编译集成

### 9.1 tsconfig.cli.json

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist/cli",
    "rootDir": "./src/cli"
  },
  "include": ["src/cli/**/*"],
  "references": [
    { "path": "./crabot-shared" }
  ]
}
```

### 9.2 构建脚本

在根 `package.json` 中添加：

```json
{
  "scripts": {
    "build:cli": "tsc -p tsconfig.cli.json",
    "build": "npm run build:modules && npm run build:cli"
  }
}
```

`crabot start`（scripts/start.sh）的构建步骤中加入 CLI 编译。

### 9.3 依赖

CLI 编译时依赖：
- `commander`：命令行解析
- `crabot-shared`：类型定义（file: 引用）

运行时依赖（Node.js 内置）：
- `node:fs`、`node:path`、`node:child_process`
- `fetch`（Node.js 22+ 内置）

## 10. 未来扩展

以下能力在本次设计范围之外，但架构已预留扩展空间：

- **Docker 发行**：添加 Dockerfile + docker-release workflow
- **自动更新**：`crabot update` 命令，从 GitHub Releases 拉取最新版本
- **低价值 CLI 命令**：Browser CDP、OAuth、Traces 等可按需补充
- **CLI 插件机制**：允许 Channel 模块注册自己的 CLI 子命令
