# Crabot CLI 命令参考

> 此文件由 `scripts/gen-skill-ref.mjs` 自动生成（基于 `crabot --schema` 输出）。请勿手动编辑。

生成时间：2026-04-27T00:09:22.120Z  CLI 版本：1.0.0

## 命令清单

| 命令 | 说明 | 权限 | 需 confirm |
|---|---|---|---|
| `crabot provider list` | List all providers | read | ❌ |
| `crabot provider show` | Show a provider | read | ❌ |
| `crabot provider add` | Add a provider | write | ❌ |
| `crabot provider test` | Test a provider connection | write | ❌ |
| `crabot provider refresh` | Refresh provider models | write | ❌ |
| `crabot provider delete` | Delete a provider | write | ✅ |
| `crabot agent list` | List all agent instances | read | ❌ |
| `crabot agent show` | Show an agent instance | read | ❌ |
| `crabot agent config` | Get or set agent instance config | write | ❌ |
| `crabot agent restart` | Restart an agent instance | write | ❌ |
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

## 通用选项

| 选项 | 说明 |
|---|---|
| `--human` | 人类可读输出（表格 + 彩色错误） |
| `--json` | JSON 输出（默认；AI 模式 alias） |
| `-e, --endpoint <url>` | 指定 Admin 地址（覆盖 CRABOT_ENDPOINT） |
| `-t, --token <token>` | 指定认证 token（覆盖 CRABOT_TOKEN） |
| `--schema` | 输出机器可读的命令 schema 并退出 |
