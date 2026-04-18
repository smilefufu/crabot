---
name: daily-reflection
description: "在任务描述包含'反思'时使用 — 引导结构化的每日任务质量反思"
version: "1.2.0"
---

# 每日反思技能

## Overview

深入分析任务执行过程，提炼可复用经验写入长期记忆。重点：哪里走了弯路、为什么、正确路径是什么、下次如何避免。

**核心原则**：你（main worker）负责筛选、委派、去重、汇总。深入分析委派给 sub-agent，避免上下文膨胀。

## 流程

### 第一步：确定反思时间范围

从任务描述中解析反思时间范围（`{{watermark}}` 到 `{{datetime}}`）。如果无法解析，使用最近 24 小时。

### 第二步：获取任务概览

```
search_traces({
  time_range: {
    start: "<watermark 时间>",
    end: "<当前时间>"
  },
  limit: 50
})
```

浏览每条 trace 的 status、trigger_type、trigger_summary、trigger_task_type、span_count、duration。

### 第三步：筛选值得分析的任务

**排除**：`trigger_task_type` 为 `daily_reflection` 的 trace（避免反思自己的反思）。

**优先关注**（按优先级排序）：
1. status = `failed` 的任务
2. span_count > 30 或 duration > 5 分钟的任务（轮数异常 = 反复尝试）
3. 对话中人类情绪明显的任务（催促、不满、重复要求）

**快速退出**：筛选后无值得分析的任务 → 直接跳到第六步，输出"本周期无值得深入反思的任务"并结束。

### 第四步：委派 Sub-Agent 深入分析

对每个选中的任务，调用 `delegate_task` 委派一个独立的 sub-agent 分析：

```
delegate_task({
  task: "深入分析任务执行过程。

任务 trace_id: <trace_id>
任务 related_task_id: <task_id>（如有）

执行步骤：
1. 查 trace span 树：search_traces({ task_id: '<task_id>', include_spans: true })
   - 逐层钻取关键 span（特别是 llm_call 和 tool_call 类型）
   - 注意失败的 span 和重试模式

2. 如有对话历史，查询：mcp__crab-messaging__get_history({ session_id: '<session_id>', limit: 30 })
   - 分析人类反馈和情绪变化

3. 识别关键模式：
   - 踩坑点：哪个步骤出错、为什么
   - 弯路：尝试了哪些不可行方案
   - 最终方案：怎么解决的
   - 反面模式：哪些做法应该避免
   - 最佳路径：如果重来，最优执行路径是什么

4. 返回结构化分析结果（不要调用 store_memory，由 main worker 统一处理）：
   - summary: 一句话总结
   - experiences: 数组，每条包含 { abstract, overview, content, importance, tags }
     - abstract（L0）：面向召回写，包含关键场景词和结论
     - overview（L1）：结构化描述 — 场景、问题、方案、反面模式、适用范围
     - content（L2）：完整分析 — 背景、执行过程、踩坑细节、解决过程、总结
     - importance: 7=一般经验, 8=重要发现, 9=影响架构的经验
     - tags: ['task_experience', ...场景标签]
   - 如无有价值的经验，返回空 experiences 数组"
})
```

**重要**：每个 sub-agent 独立运行，trace span 数据只存在于 sub-agent 的上下文中，不会膨胀你的上下文。

### 第五步：综合去重，统一写入长期记忆

收集所有 sub-agent 返回的 experiences，综合去重：

1. 合并跨任务的重复经验（不同任务得出同一结论的，合并为一条更完整的）
2. 对去重后的每条经验，调用一次 `mcp__crab-memory__store_memory`：

```
mcp__crab-memory__store_memory({
  abstract: "<L0 — 面向召回的摘要>",
  overview: "<L1 — 结构化描述>",
  content: "<L2 — 完整分析>",
  importance: <7-9>,
  tags: ["task_experience", "...场景标签"]
})
```

**L0 写法示例**：
- 好：`"macOS 终端输入中文时键盘模拟不可行，必须使用剪贴板(pbcopy+Cmd+V)"`
- 差：`"在飞书操作时遇到了中文输入问题并解决了"`

### 第六步：生成报告并汇报

生成结构化报告作为任务输出，包含：
- 反思时间范围
- 分析的任务数量
- 提炼的经验数量
- 每条经验的 L0 摘要

如果本次反思有 importance >= 8 的发现：
1. `mcp__crab-messaging__lookup_friend({ name: "master" })` 获取 master 信息
2. `mcp__crab-messaging__list_sessions({ channel_id: "<channel_id>" })` 找到可用会话
3. `mcp__crab-messaging__send_message(...)` 发送简要汇报

如果无重大发现或找不到 master 会话，跳过汇报。

### 第七步：场景画像反思

**目标**：把近期反复出现的"场景核心稳定知识"从长期记忆/trace 中归纳到场景画像（`SceneProfile`），清理画像中已被推翻的旧条目，并对违反黑名单的新长期记忆做回收。

1. **列出活跃场景**：从最近 24h short-term 事件中抽取出现过的 `friend_id` 与 `{channel_id, session_id}` 对。
2. **逐场景归纳**：
   - `mcp__crab-memory__get_scene_profile({ scene })` 取现状
   - 扫描该场景相关的 long-term 条目与 trace
   - 识别"核心稳定知识"：反复出现但未被画像覆盖的规则 / 用户反复纠正的偏好 / 与画像已有 section 矛盾的新证据
   - 有新归纳 → `mcp__crab-memory__patch_scene_profile({ scene, section, merge: "replace_topic" })`，并在 `source_memory_ids` 记录来源
3. **清理过期**：画像中某 section 被新证据推翻 → `patch_scene_profile` 替换 / 删除；section 过期且无替代 → 在 `label` 备注或整条 `delete_scene_profile`。
4. **黑名单合规检查**：扫描近 24h 新增 long-term 条目，命中黑名单（一次性快照、时效新闻、细碎 tip、已解决 bug 细节、中间猜测、偶尔一次表述）的 → `delete_memory` 回收。

**不新增反思频次**：第七步与前六步同一 run 内执行。
