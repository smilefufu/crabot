<!--
Source: Crabot builtin skill — workspace context maintenance v1
Snapshot date: 2026-07-05
本文件由 Crabot 内置，用于在进入文件工作区后温和引导 agent 维护 AGENTS.md / CURRENT_CONTEXT.md 等上下文文档。
-->

---
name: workspace-context-maintenance
description: Use after set_cwd when workspace context docs are missing or stale; before durable file changes, reports, scripts, data artifacts, or when the user asks Crabot to remember workspace rules
---

# Workspace Context Maintenance

## 何时使用

在以下任一情况，先使用本 skill：

- `set_cwd` 返回提示显示未发现 `AGENTS.md`。
- 本任务会修改多个文件、创建脚本、生成报告、生成数据产物、改配置，或产生后续 agent 需要理解的长期结果。
- 本任务依赖项目历史上下文、实验口径、契约、权威产物或废弃口径。
- 用户说“记住”“以后按这个来”“维护文档”“沉淀上下文”。

如果任务只是一次性查看、简单问答、读取单个文件，且不修改或生成长期文件，可以不创建文档，但最终说明无需维护的原因。

## 工作流程

1. 先检查 `AGENTS.md`。
   - 如果存在，读取并遵守。
   - 如果不存在，继续第 2 步。

2. 读取已发现的上下文候选。
   - 优先读 `README.md`。
   - 若存在，再读 `CURRENT_CONTEXT.md`、`docs/CURRENT_CONTEXT.md`、`PROGRESS.md`、`HANDOFF.md`、`docs/CONTRACT_INDEX.md`、`docs/ARTIFACT_REGISTRY.md`。
   - 不要把旧报告、历史计划或 `latest_*` 文件直接当成当前权威；必须先确认口径。

3. 判断是否需要初始化 `AGENTS.md`。
   - 如果任务会修改文件或生成长期产物，应创建最小 `AGENTS.md`。
   - 如果不创建，必须有明确理由，例如“本任务只读单个文件，不产生长期状态”。

4. 创建最小 `AGENTS.md` 时只写保守规则。
   - 可以写 Crabot 默认工作规则。
   - 可以写已读 `README.md` 明确确认的事实。
   - 不要写未验证推断，不要总结整个项目历史，不要把历史报告结论写成当前事实。

5. 任务结束前做文档维护检查。
   - 如果本次改变了长期事实、工作流、契约、权威产物、废弃口径或后续注意事项，更新 `AGENTS.md` 或当前上下文文档。
   - 若没有更新，最终回复中说明无需更新的原因。

## 最小 AGENTS.md 模板

当没有项目特定约定时，使用下面模板。可以删除不适用项，但不要扩写未确认事实。

```markdown
# Agent Instructions

This file was bootstrapped by Crabot because no existing `AGENTS.md` was found.

## Workspace Context

- Read `README.md` first when it exists.
- Treat `docs/`, `reports/`, generated data, and `latest_*` files as potentially historical unless a current context or contract document marks them authoritative.
- Do not infer current project state from old reports without checking current files.

## Documentation Maintenance

- If a task changes long-lived project facts, workflows, contracts, artifact authority, or creates durable research outputs, update or create the relevant context document.
- Prefer `docs/CURRENT_CONTEXT.md` for current status when no project-specific convention exists.
- Record confirmed facts, current task context, decisions, and unknowns. Do not record unverified guesses as facts.

## Task Discipline

- Before broad search or edits, identify the current source of truth.
- Before reporting completion, run relevant verification commands and cite produced files.
```

## 写入边界

- 不要为了“看起来完整”编造项目规则。
- 不要把用户没有确认的偏好写成长期规则。
- 不要替代已有项目说明；如果已有 `AGENTS.md`，只按需做最小更新。
- 不要因为创建了 `AGENTS.md` 就跳过读取真实上下文文件。
