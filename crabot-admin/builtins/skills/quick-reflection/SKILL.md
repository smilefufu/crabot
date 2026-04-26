---
name: quick-reflection
description: "在任务描述包含'轻反思'或 trigger=quick_reflection 时使用 — 扫近期 inbox，多因子打分，高分高置信晋升 confirmed"
version: "1.0.0"
---

# 周期轻反思 Skill

## Overview

每小时（默认）跑一次：扫近期 inbox 中的 fact/lesson 候选，做去重 + 多因子打分。
高分 + 高置信 → `update_long_term` 升级到 confirmed；
低分 / 模糊 → 留给 daily-reflection 深加工。
**不调贵 LLM**：仅做去重 hash 比对、IDF / entity_priority / 高 proximity 阈值过滤。

## 流程

### Step 1：拉 inbox 候选

```
mcp__crab-memory__search_long_term({
  query: "*",
  filters: { status: "inbox" },
  k: 50,
  include: "brief"
})
```

> 现实现需要查询字符串；可用 `"recent"` 占位 + filters 过滤。如不够，用 `mcp__crab-memory__list_recent({ window_days: 1 })` 拉最近 24 小时新增的全部条目。

### Step 2：去重

按 `(type, brief 前 40 字 hash)` 分组：
- 同组 ≥ 2 条且 author 一致 → 保留最新一条，其余 `delete_memory`（进 trash）
- 不同 author 同 hash → 不动，留 daily 处理

### Step 3：多因子打分

对每条 inbox 候选，计算分数：

```
score = 0.4 * importance_factors.proximity
      + 0.3 * importance_factors.surprisal
      + 0.2 * importance_factors.entity_priority
      + 0.1 * importance_factors.unambiguity
```

### Step 4：晋升决策（无 LLM）

| 条件 | 动作 |
|---|---|
| `score >= 0.75 AND content_confidence >= 4` | `update_long_term({ id, patch: { maturity: "confirmed" } })` |
| `score < 0.3` | `delete_memory({ id })`（进 trash） |
| 其他 | 留给 daily-reflection |

晋升到 confirmed 时同时设置观察期：

```
update_long_term({
  id,
  patch: {
    maturity: "confirmed",
    observation: { started_at: <现在>, window_days: 7, outcome: "pending" },
  },
})
```

### Step 5：报告

输出本次：处理候选数、晋升数、丢弃数、留待 daily 数。
**不汇报 master**（频率高、信号弱）。
