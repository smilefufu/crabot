---
name: crabot-cli
description: "在 master 通过私聊要求查看或变更系统配置、切换模型、管理 MCP 服务器、频道、日程或好友时使用"
version: "1.0.0"
metadata:
  openclaw:
    emoji: "⚙️"
    requires:
      bins:
        - node
---

# Crabot CLI 管理技能

## Overview

通过 `crabot` CLI 命令管理 Crabot 系统配置。

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
