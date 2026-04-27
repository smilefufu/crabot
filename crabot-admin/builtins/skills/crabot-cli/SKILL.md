---
name: crabot-cli
description: '管理 Crabot 系统自身的资源（Provider/Agent/MCP/Channel/Skill/Schedule/Friend/Permission）。Use when master 让你查看/列出/切换/启停/增删/诊断/撤销这些资源——例如"当前用什么模型"、"切到 GPT-5"、"列出所有 agent"、"启用 weather mcp"、"重启 telegram channel"、"暂停那个定时任务"、"删掉这个 provider"、"撤销刚才的改动"、"channel 是不是失联了"、"测一下这个 provider 通不通"。read 类命令在所有场景可用（敏感字段自动 mask），write 类（add/update/set/delete/restart/start/stop/toggle/trigger/pause/resume）仅 master 私聊场景执行，其他场景会被 hook 拦截。'
version: "2.1.0"
metadata:
  openclaw:
    emoji: "⚙️"
    requires:
      bins:
        - node
---

# Crabot CLI 管理技能

## Overview

通过 `crabot` CLI 管理 Crabot 系统。CLI 默认输出 JSON，专为 LLM 友好设计。

## 调用方式

通过 Bash tool 执行 `crabot <command>`（默认 JSON 输出，无需加 `--json`）。环境变量 `CRABOT_ENDPOINT` 和 `CRABOT_TOKEN` 由运行时自动注入。

## 关键协议

### read 命令（所有场景可用）

`list` / `show` / `config`（无 `--set`） / `doctor` 等只读命令在所有场景下都能用。**敏感字段（apikey、password、secret、token 等）永远 mask 成 `sk-x****-xxxx` 形式**——任何场景下 LLM 都拿不到原文。

### write 命令（仅 master 私聊）

非 master 私聊场景下，所有 write 命令会被 hook 拦截，返回权限错误。

写命令分两类响应路径：

#### A. 默认情况：直接执行 + 返回 undo

绝大多数写命令（add / update / set / restart / toggle / pause / resume 等）：

```json
{
  "ok": true,
  "action": "add",
  "result": { "id": "...", ... },
  "undo": {
    "id": "undo-...",
    "command": "crabot undo undo-...",
    "description": "delete provider openai (a3c1f9e2)",
    "expires_at": "2026-04-28T18:20:01Z"
  }
}
```

→ 操作完成。把 `undo.command` 简单告知 master（"已 X，如需撤销执行 Y"），**不需要** master 二次确认。

#### B. 必 confirm 类：返回 confirmation_required

仅删除类（provider/mcp/skill/schedule/friend/permission delete）和 `schedule trigger` 7 类命令：

```json
{
  "confirmation_required": true,
  "confirmation_token": "...",
  "expires_at": "2026-04-26T18:35:16Z",
  "preview": {
    "action": "delete",
    "side_effects": [...],
    "rollback_difficulty": "需重新粘贴 apikey 原文"
  },
  "command_to_confirm": "crabot ... --confirm <token>"
}
```

→ **必须停下**，把 `preview.side_effects` 和 `preview.rollback_difficulty` 翻译成自然语言告诉 master，明确询问是否继续。得到肯定答复后用 `command_to_confirm` 字段中的命令重新执行。**任何情况下都不要绕过这个流程。**

## 重要约束

- **不应主动 `crabot undo`**——除非 master 明确说"撤销刚才那个"。undo 是 master 的工具，不是 agent 自我修正的工具。
- **绝不尝试 `--reveal`**——查看 apikey 原文需走 Admin Web UI，agent 不应该有此能力。
- **错误响应是结构化 JSON**（在 stderr）：`{"error": {"code": "X", "message": "...", "details": {...}}}`。根据 `code` 决定下一步：
  - `NOT_FOUND` → 重新 list 一遍
  - `AMBIGUOUS_REFERENCE` → 看 `details.candidates`，向 master 确认指哪个
  - `CONFIRMATION_INVALID` → token 错或过期，重新发不带 --confirm 的命令拿新 preview
  - `UNDO_STALE` / `UNDO_EXPIRED` / `UNDO_EMPTY` → 告知 master 不能 undo
  - `PERMISSION_DENIED` → 当前场景没有该权限，告知 master 在 master 私聊重试

## 引用方式

所有需要 ID 参数的命令（`<ref>`）支持三种引用：

1. 完整 UUID：`a3c1f9e2-1111-...`
2. **name**：`openai`（推荐——LLM 友好）
3. **短前缀**（≥4 字符）：`a3c1`

## 常用操作

```bash
# 状态查看（所有场景可用）
crabot provider list
crabot agent list
crabot agent doctor                    # 综合诊断（连接性 + 模型配置）

# 切换模型（一条命令完成）
crabot agent set-model code-helper --slot fast --provider openai --model gpt-5
crabot config switch-default --provider openai --model gpt-4o

# 启用/禁用
crabot mcp toggle weather --on
crabot schedule pause daily-report
crabot schedule resume daily-report

# 撤销最近一次写操作（master 主动调用，agent 一般不调）
crabot undo
crabot undo list                       # 查看可撤销清单
```

## 详细命令参考

见 `references/command-ref.md`（由 `scripts/gen-skill-ref.mjs` 自动生成自 `crabot --schema`，与 CLI 实现保持同步）。
