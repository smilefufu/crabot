# Crabot CLI 命令参考

## Model Provider

| 命令 | 说明 |
|------|------|
| `crabot provider list` | 列出所有 Provider |
| `crabot provider show <id>` | 查看 Provider 详情（含模型列表） |
| `crabot provider add --name <n> --type <t> --endpoint <url> --apikey <key>` | 创建 Provider |
| `crabot provider test <id>` | 测试 Provider 连接 |
| `crabot provider refresh <id>` | 刷新模型列表 |
| `crabot provider delete <id>` | 删除 Provider |

> 安全提示：`--apikey` 会出现在 shell history 中，可用 `--apikey-stdin` 从 stdin 读取。

## Agent 实例

| 命令 | 说明 |
|------|------|
| `crabot agent list` | 列出 Agent 实例 |
| `crabot agent show <id>` | 查看实例详情 |
| `crabot agent config <id>` | 查看实例配置 |
| `crabot agent config <id> --set k=v [k=v...]` | 更新配置（支持点号路径） |
| `crabot agent restart <id>` | 重启 Agent |

`--set` 点号路径示例：`--set models.default.provider_id=xxx models.default.model_id=yyy`

## MCP Server

| 命令 | 说明 |
|------|------|
| `crabot mcp list` | 列出 MCP 服务 |
| `crabot mcp show <id>` | 查看详情 |
| `crabot mcp add --name <n> --command <cmd> --args <a1,a2>` | 创建 MCP 服务 |
| `crabot mcp import <file>` | 从 JSON 文件批量导入 |
| `crabot mcp delete <id>` | 删除 MCP 服务 |

## Skill

| 命令 | 说明 |
|------|------|
| `crabot skill list` | 列出技能 |
| `crabot skill show <id>` | 查看详情 |
| `crabot skill add --git <url>` | 从 Git 仓库导入技能 |
| `crabot skill add --path <dir>` | 从本地目录导入技能 |
| `crabot skill delete <id>` | 删除技能 |

## Schedule

| 命令 | 说明 |
|------|------|
| `crabot schedule list` | 列出定时任务 |
| `crabot schedule show <id>` | 查看详情 |
| `crabot schedule add --title <t> --cron "expr" --action <a>` | 创建 cron 任务 |
| `crabot schedule add --title <t> --trigger-at "ISO时间" --action <a>` | 创建一次性任务 |
| `crabot schedule trigger <id>` | 立即触发 |
| `crabot schedule delete <id>` | 删除定时任务 |

## Channel 实例

| 命令 | 说明 |
|------|------|
| `crabot channel list` | 列出 Channel 实例 |
| `crabot channel show <id>` | 查看详情 |
| `crabot channel config <id>` | 查看 Channel 配置 |
| `crabot channel config <id> --set k=v` | 更新配置 |
| `crabot channel start <id>` | 启动 Channel |
| `crabot channel stop <id>` | 停止 Channel |
| `crabot channel restart <id>` | 重启 Channel |

## Friend

| 命令 | 说明 |
|------|------|
| `crabot friend list [--search <keyword>]` | 列出/搜索好友 |
| `crabot friend show <id>` | 查看好友详情 |
| `crabot friend add --name <n> --permission <template_id>` | 添加好友 |
| `crabot friend update <id> --name <n> --permission <template_id>` | 更新好友 |
| `crabot friend delete <id>` | 删除好友 |

## 全局配置

| 命令 | 说明 |
|------|------|
| `crabot config show` | 查看全局模型配置 + 代理配置 |
| `crabot config set k=v [k=v...]` | 更新全局模型配置 |
| `crabot config proxy show` | 查看代理（proxy）配置 |
| `crabot config proxy set k=v [k=v...]` | 更新代理配置 |

## 权限模板

| 命令 | 说明 |
|------|------|
| `crabot permission list` | 列出权限模板 |
| `crabot permission show <id>` | 查看模板详情 |
| `crabot permission add --name <n> --file <template.json>` | 创建权限模板 |
| `crabot permission update <id> --name <n> --file <template.json>` | 更新权限模板 |
| `crabot permission delete <id>` | 删除权限模板 |

## 通用选项

| 选项 | 说明 |
|------|------|
| `--json` | 输出 JSON 格式（Agent 必用） |
| `-e, --endpoint <url>` | 指定 Admin 端点（覆盖 CRABOT_ENDPOINT） |
| `-t, --token <token>` | 指定认证 Token（覆盖 CRABOT_TOKEN） |
