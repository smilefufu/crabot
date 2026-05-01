# Crabot CLI 命令参考

> 此文件由 `scripts/gen-skill-ref.mjs` 自动生成（基于 `crabot --schema` 输出）。请勿手动编辑。

生成时间：2026-04-30T11:33:43.964Z  CLI 版本：1.0.0

## 命令清单

| 命令 | 说明 | 权限 | 需 confirm |
|---|---|---|---|
| `crabot provider list` | List all providers | read | ❌ |
| `crabot provider show` | Show a provider | read | ❌ |
| `crabot provider add` | Add a provider (创建后用 `provider refresh <id>` 拉取模型列表) | write | ❌ |
| `crabot provider test` | Test a provider connection | write | ❌ |
| `crabot provider refresh` | Refresh provider models | write | ❌ |
| `crabot provider delete` | Delete a provider | write | ✅ |
| `crabot agent list` | List all agent instances | read | ❌ |
| `crabot agent show` | Show an agent instance | read | ❌ |
| `crabot agent config` | Get or set agent instance config | write | ❌ |
| `crabot agent restart` | Restart the crabot-agent module（同时重启所有 agent instance，因为它们共用同一个进程） | write | ❌ |
| `crabot agent set-model` | Set the model for a specific slot in an agent (composite command) | write | ❌ |
| `crabot agent doctor` | Diagnose agent model slot configuration and provider connectivity (composite, read-only) | read | ❌ |
| `crabot mcp list` | List all MCP servers | read | ❌ |
| `crabot mcp show` | Show an MCP server | read | ❌ |
| `crabot mcp add` | Add an MCP server | write | ❌ |
| `crabot mcp import` | Import MCP servers from a JSON file | write | ❌ |
| `crabot mcp delete` | Delete an MCP server | write | ✅ |
| `crabot mcp toggle` | Enable or disable an MCP server (composite) | write | ❌ |
| `crabot skill list` | List all skills | read | ❌ |
| `crabot skill show` | Show a skill | read | ❌ |
| `crabot skill add` | Add a skill from git or local path | write | ❌ |
| `crabot skill delete` | Delete a skill | write | ✅ |
| `crabot schedule list` | List all schedules | read | ❌ |
| `crabot schedule show` | Show a schedule | read | ❌ |
| `crabot schedule add` | Add a schedule | write | ❌ |
| `crabot schedule trigger` | Manually trigger a schedule | write | ✅ |
| `crabot schedule delete` | Delete a schedule | write | ✅ |
| `crabot schedule pause` | Pause a schedule (composite) | write | ❌ |
| `crabot schedule resume` | Resume a schedule (composite) | write | ❌ |
| `crabot channel list` | List all channel instances | read | ❌ |
| `crabot channel show` | Show a channel instance | read | ❌ |
| `crabot channel config` | Get or set channel instance config | write | ❌ |
| `crabot channel start` | Start a channel instance | write | ❌ |
| `crabot channel stop` | Stop a channel instance | write | ❌ |
| `crabot channel restart` | Restart a channel instance | write | ❌ |
| `crabot friend list` | List all friends | read | ❌ |
| `crabot friend show` | Show a friend | read | ❌ |
| `crabot friend add` | Add a friend | write | ❌ |
| `crabot friend update` | Update a friend | write | ❌ |
| `crabot friend delete` | Delete a friend | write | ✅ |
| `crabot config show` | Show global model config and proxy config | read | ❌ |
| `crabot config set` | Set global model config values (key=value) | write | ❌ |
| `crabot config proxy show` | Show proxy config | read | ❌ |
| `crabot config proxy set` | Set a proxy config value (key=value) | write | ❌ |
| `crabot config switch-default` | Switch the global default LLM provider+model (composite) | write | ❌ |
| `crabot permission list` | List all permission templates | read | ❌ |
| `crabot permission show` | Show a permission template | read | ❌ |
| `crabot permission add` | Add a permission template | write | ❌ |
| `crabot permission update` | Update a permission template | write | ❌ |
| `crabot permission delete` | Delete a permission template | write | ✅ |
| `crabot undo list` | List undoable operations (newest first) | read | ❌ |

## Write 命令参数详情

> 仅列 write 命令的位置参数和 flag。read 命令一般是 `crabot xxx list` / `xxx show <ref>`，参数自明。

### `crabot provider add`

Add a provider (创建后用 `provider refresh <id>` 拉取模型列表)

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--name <name>` | Provider name | ✅ |
| `--format <format>` | API format (openai\|anthropic\|gemini\|openai-responses) | ✅ |
| `--endpoint <url>` | Provider endpoint URL | ✅ |
| `--type <type>` | Config type (manual\|preset, 默认 manual) |  |
| `--apikey <key>` | API key |  |
| `--apikey-stdin` | Read API key from stdin |  |
| `--preset-vendor <id>` | Preset vendor id（仅 type=preset 用） |  |

### `crabot provider test`

Test a provider connection

**位置参数**:

- `<ref>`（必填）

### `crabot provider refresh`

Refresh provider models

**位置参数**:

- `<ref>`（必填）

### `crabot provider delete`

Delete a provider

**位置参数**:

- `<ref>`（必填）

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--confirm <token>` | Confirmation token from preview response |  |

### `crabot agent config`

Get or set agent instance config

**位置参数**:

- `<ref>`（必填）

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--set <pairs...>` | Set config values (key=value, supports dot notation) |  |

### `crabot agent restart`

Restart the crabot-agent module（同时重启所有 agent instance，因为它们共用同一个进程）

### `crabot agent set-model`

Set the model for a specific slot in an agent (composite command)

**位置参数**:

- `<ref>`（必填）

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--slot <slot>` | Model slot (例如 default \| smart \| fast，由 agent 实现声明) | ✅ |
| `--provider <name>` | Provider name (or id, or short prefix) | ✅ |
| `--model <model>` | Model id (e.g. gpt-4o) | ✅ |

### `crabot mcp add`

Add an MCP server

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--name <name>` | Server name | ✅ |
| `--command <cmd>` | Command to run | ✅ |
| `--args <args>` | Comma-separated arguments |  |

### `crabot mcp import`

Import MCP servers from a JSON file

**位置参数**:

- `<file>`（必填）

### `crabot mcp delete`

Delete an MCP server

**位置参数**:

- `<ref>`（必填）

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--confirm <token>` | Confirmation token from preview response |  |

### `crabot mcp toggle`

Enable or disable an MCP server (composite)

**位置参数**:

- `<ref>`（必填）

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--on` | Enable |  |
| `--off` | Disable |  |

### `crabot skill add`

Add a skill from git or local path

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--git <url>` | Git repository URL（GitHub） |  |
| `--skill-md-url <url>` | GitHub raw SKILL.md URL（多 skill 仓库时显式指定要装的那个） |  |
| `--path <dir>` | Local directory path（包含 SKILL.md） |  |
| `--overwrite` | 同名 skill 已存在时覆盖 |  |

### `crabot skill delete`

Delete a skill

**位置参数**:

- `<ref>`（必填）

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--confirm <token>` | Confirmation token from preview response |  |

### `crabot schedule add`

Add a schedule

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--title <title>` | Task template title (会作为触发任务的标题，可含 {{date}}/{{datetime}} 占位符) | ✅ |
| `--priority <priority>` | Task priority (low\|normal\|high\|urgent) | ✅ |
| `--name <name>` | Schedule 名称（不传则 fallback 到 --title） |  |
| `--description <desc>` | Schedule 描述（人读层面，给 master 看） |  |
| `--task-description <desc>` | Task 描述（任务触发时给 LLM 的 prompt） |  |
| `--task-type <type>` | Task 类型，用于 trace 过滤（如 daily_reflection） |  |
| `--tag <tag>` | Task 标签（可重复 --tag a --tag b） |  |
| `--cron <expr>` | Cron 表达式（5 字段：分 时 日 月 周） |  |
| `--trigger-at <time>` | ISO 8601 触发时间（一次性触发器） |  |
| `--timezone <tz>` | Cron 时区（默认 Asia/Shanghai） |  |
| `--target-channel <id>` | 触发目标 channel instance id（写入 task_template.input.target_channel_id） |  |
| `--target-session <id>` | 触发目标 session id（写入 task_template.input.target_session_id） |  |
| `--disabled` | 创建时禁用（默认启用） |  |

### `crabot schedule trigger`

Manually trigger a schedule

**位置参数**:

- `<ref>`（必填）

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--confirm <token>` | Confirmation token from preview response |  |

### `crabot schedule delete`

Delete a schedule

**位置参数**:

- `<ref>`（必填）

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--confirm <token>` | Confirmation token from preview response |  |

### `crabot schedule pause`

Pause a schedule (composite)

**位置参数**:

- `<ref>`（必填）

### `crabot schedule resume`

Resume a schedule (composite)

**位置参数**:

- `<ref>`（必填）

### `crabot channel config`

Get or set channel instance config

**位置参数**:

- `<ref>`（必填）

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--set <pairs...>` | Set config values (key=value, supports dot notation) |  |

### `crabot channel start`

Start a channel instance

**位置参数**:

- `<ref>`（必填）

### `crabot channel stop`

Stop a channel instance

**位置参数**:

- `<ref>`（必填）

### `crabot channel restart`

Restart a channel instance

**位置参数**:

- `<ref>`（必填）

### `crabot friend add`

Add a friend

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--name <name>` | Friend display name | ✅ |
| `--permission <permission>` | Friend permission (master\|normal) | ✅ |
| `--permission-template <templateId>` | Permission template ID（normal 通常需要，缺省 fallback 到 standard） |  |

### `crabot friend update`

Update a friend

**位置参数**:

- `<ref>`（必填）

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--name <name>` | Friend display name |  |
| `--permission <permission>` | Friend permission (master\|normal) |  |
| `--permission-template <templateId>` | Permission template ID |  |
| `--confirm <token>` | Confirmation token from preview response |  |

### `crabot friend delete`

Delete a friend

**位置参数**:

- `<ref>`（必填）

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--confirm <token>` | Confirmation token from preview response |  |

### `crabot config set`

Set global model config values (key=value)

**位置参数**:

- `<pairs>`（必填）

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--confirm <token>` | Confirmation token from preview response |  |

### `crabot config proxy set`

Set a proxy config value (key=value)

**位置参数**:

- `<pair>`（必填）

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--confirm <token>` | Confirmation token from preview response |  |

### `crabot config switch-default`

Switch the global default LLM provider+model (composite)

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--provider <name>` | Provider name (or id, or short prefix) | ✅ |
| `--model <model>` | Model id (e.g. gpt-4o) | ✅ |

### `crabot permission add`

Add a permission template

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--name <name>` | Template name | ✅ |
| `--file <json>` | Path to JSON file with template definition | ✅ |

### `crabot permission update`

Update a permission template

**位置参数**:

- `<ref>`（必填）

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--name <name>` | Template name |  |
| `--file <json>` | Path to JSON file with template definition |  |
| `--confirm <token>` | Confirmation token from preview response |  |

### `crabot permission delete`

Delete a permission template

**位置参数**:

- `<ref>`（必填）

**Flag**:

| Flag | 说明 | 必填 |
|---|---|---|
| `--confirm <token>` | Confirmation token from preview response |  |

## 通用选项

| 选项 | 说明 |
|---|---|
| `--human` | 人类可读输出（表格 + 彩色错误） |
| `--json` | JSON 输出（默认；AI 模式 alias） |
| `-e, --endpoint <url>` | 指定 Admin 地址（覆盖 CRABOT_ENDPOINT） |
| `-t, --token <token>` | 指定认证 token（覆盖 CRABOT_TOKEN） |
| `--schema` | 输出机器可读的命令 schema 并退出 |
