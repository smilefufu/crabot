# Admin 调度引擎 + 每日反思设计方案

> 日期：2026-04-14
> 状态：待实现

## 1. 背景与动机

Admin 模块已有完整的 Schedule 数据模型和 CRUD API，但缺少**调度执行引擎** — Schedule 创建后无法自动触发，只能手动调用 `trigger_now`。

本设计补全以下能力：
1. Admin 内部的调度执行引擎，支持 Cron / Interval / Once 三种触发器
2. Agent 模块的调度任务执行路径（跳过 Front 分诊，直接交 Worker）
3. 每日反思的完整流程设计（prompt 模板、经验产出、master 汇报）

## 2. 协议文档变更

### 2.1 删除 ThresholdTrigger

ThresholdTrigger 的唯一使用场景（短期记忆 token 超限）在 Memory 模块补全前用不上，先移除。

**base-protocol.md**：
- `ScheduleTrigger` 联合类型移除 `ThresholdTrigger`
- `TriggerType` 简化为 `"cron" | "interval" | "once"`

**protocol-admin.md**：
- 删除 `ThresholdTrigger` 接口定义
- 删除 `threshold_check_interval` 配置项

### 2.2 调度执行链路

原协议中调度触发后调用 Flow 模块的 `create_task_from_schedule`。Flow 已合并入 Agent 模块，链路调整为：

```
Admin ScheduleEngine 触发
  → RPC: Agent.create_task_from_schedule(schedule_id, task_type, title, description)
  → Agent 选择 Worker、创建任务、启动执行
  → 返回 { task_id, assigned_worker }
```

涉及 `protocol-admin.md` 和 `protocol-flow.md` 中的相关描述更新。

### 2.3 write_long_term 接口扩展

**protocol-memory.md** `write_long_term` 和 `batch_write_long_term`：

```typescript
interface WriteLongTermParams {
  content: string                // L2 完整内容
  abstract?: string              // L0 摘要（可选，不提供则自动生成）
  overview?: string              // L1 概览（可选，不提供则自动生成）
  source: MemorySource
  entities?: EntityRef[]
  importance?: number
  tags?: string[]
  visibility?: MemoryVisibility
  scopes?: string[]
}
```

当调用方提供 `abstract` / `overview` 时，Memory 直接使用，不再自动生成。

设计意图：反思场景下，Worker 已经做过深度分析，比 Memory 的通用摘要器更了解这条经验应该在什么场景下被召回。Worker 提供的 L0 可以面向召回场景优化，包含关键场景词和结论。

## 3. Admin 调度引擎

### 3.1 新增 ScheduleEngine 类

独立文件 `schedule-engine.ts`，职责：管理所有 Schedule 的 timer 生命周期，到点触发任务创建。

**核心数据结构**：

```typescript
// 活跃 timer 实例，key 为 ScheduleId
const activeTimers = new Map<ScheduleId, Cron | NodeJS.Timeout>()
```

**timer 创建策略**：

| 触发器类型 | 实现方式 |
|-----------|---------|
| Cron | `new Cron(expr, callback, { timezone })` — croner 自带调度 |
| Interval | `setInterval(callback, seconds * 1000)` |
| Once | `setTimeout(callback, triggerAt - now)` |

**生命周期管理**：

```
Admin.start()
  → ScheduleEngine.start()
    → 从 SQLite 加载所有 enabled 的 Schedule
    → 为每个创建对应 timer

Schedule CRUD 操作时同步引擎：
  create_schedule → engine.add(schedule)
  update_schedule → engine.update(id, schedule)  // 销毁旧 timer + 创建新 timer
  delete_schedule → engine.remove(id)
  enable/disable  → engine.enable(id) / engine.disable(id)
  trigger_now     → engine.triggerNow(id)  // 手动触发，不影响定时 timer

Admin.stop()
  → ScheduleEngine.stop()
    → 销毁所有 timer
```

### 3.2 触发时的动作

```
timer 回调触发
  → RPC 调用 Agent.create_task_from_schedule({
      schedule_id, task_type, title, description,
      preferred_worker_specialization
    })
  → 更新 Schedule:
      last_triggered_at = now
      execution_count += 1
      next_trigger_at = 计算下次时间（Cron 用 croner，Interval 用 now + interval）
      last_task_id = 返回的 task_id
  → Once 类型触发后自动 disable
```

### 3.3 容错

- **Agent 不在线**：触发失败记录错误日志，不 crash，Schedule 继续保持 enabled，下次触发时重试
- **Once 过期**：Admin 重启后发现 Once 类型的 `trigger_at` 已过 → 立即触发一次，然后 disable
- **重复触发防护**：触发前检查 `last_triggered_at`，如果距上次触发不足最小间隔（Cron 周期的 50%），跳过本次

### 3.4 依赖

新增 npm 依赖：`croner`

## 4. Agent 模块改造

### 4.1 补全调度任务执行路径

现有 `handleCreateTaskFromSchedule`（unified-agent.ts:1664-1722）只创建任务不执行。改造为：

```
handleCreateTaskFromSchedule(params)
  → workerSelector.selectWorker({ task_type })
  → Admin RPC: create_task(...)                    // 已有
  → assembleScheduledTaskContext(params)            // 新增
  → executeScheduledTaskInBackground(task, context) // 新增
  → 返回 { task_id, assigned_worker }
```

### 4.2 新增 assembleScheduledTaskContext

在 `ContextAssembler` 中新增，不依赖 channel/session/friend：

```typescript
async assembleScheduledTaskContext(): Promise<WorkerAgentContext> {
  const [adminEndpoint, memoryEndpoint, channelEndpoints] = await Promise.all([
    this.resolveModule('admin'),
    this.resolveModule('memory'),
    this.resolveModules('channel'),
  ])

  return {
    task_origin: null,              // 无聊天来源
    recent_messages: [],            // 无聊天历史
    short_term_memories: [],        // Worker 按需自己查
    long_term_memories: [],         // Worker 按需自己查
    available_tools: [],            // WorkerHandler 后续填充
    admin_endpoint: adminEndpoint,
    memory_endpoint: memoryEndpoint,
    channel_endpoints: channelEndpoints,
    memory_permissions: {
      write_visibility: 'internal',  // 系统级权限
      write_scopes: [],
    },
  }
}
```

### 4.3 executeScheduledTaskInBackground

与现有 `executeTaskInBackground` 类似，关键差异：

- 不发即时回复（无来源 channel）
- 不回复到 channel（任务完成后只更新 Admin 任务状态）
- Worker 如需通知 master，自己通过 channel 工具发送

### 4.4 store_memory source.type 扩展

`crab-memory.ts` 中 `store_memory` 工具的 `source.type`，现有只有 `'conversation'`。

对于调度任务场景，source.type 由任务类型决定：
- `daily_reflection` 任务 → source.type: `'reflection'`
- 其他调度任务 → source.type: `'system'`

### 4.5 types.ts 变更

- `WorkerAgentContext.task_origin` 改为可选（`| null`），支持无聊天来源
- 删除 `ThresholdTrigger` 相关类型

## 5. 每日反思 Prompt 模板

### 5.1 设计原则

反思不是简单记录"今天做了什么"，而是深入分析任务执行过程，提炼可复用的经验教训。重点关注：**哪里走了弯路、为什么走弯路、正确路径是什么、下次如何避免。**

### 5.2 标准流程

反思 Worker 收到任务后，按以下流程执行：

**第一步：获取今日任务概览**

通过 Admin RPC 查询今天完成/失败的任务列表，浏览每个任务的 summary 和 status，形成全局视图。

**第二步：筛选值得深入分析的任务**

不是每个任务都值得反思。

首先排除：
- **task_type 为 `daily_reflection` 的任务** — 避免"反思自己的反思"，防止无意义循环

然后优先关注：
- **失败的任务** — 直接说明有问题
- **执行轮数异常多的任务** — 通过 trace 数据判断，轮数多意味着反复尝试
- **人类情绪信号明显的任务** — 查 channel 对话历史，识别人类的不满、催促、重复要求、责骂等情绪。人类情绪越大，说明 Crabot 的表现越差

对于顺利完成且无异常信号的任务，简单跳过。

**第三步：深入分析选中的任务**

对每个选中的任务：
1. **查 trace 数据**：还原执行路径 — LLM 做了哪些决策、调用了哪些工具、哪里卡住、尝试了几次、最终怎么解决
2. **查 channel 对话历史**：分析人类反馈 — 人类的纠正指令、情绪变化、最终态度
3. **识别关键模式**：
   - 踩坑点：哪个步骤出错了、为什么
   - 弯路：尝试了哪些不可行的方案
   - 最终方案：怎么解决的
   - 反面模式：哪些做法应该避免
   - 最佳路径：如果重来一遍，最优的执行路径是什么

**第四步：提炼经验写入长期记忆**

对每条有价值的经验，按三级结构写入：

- **L0（abstract）**：面向召回写。站在"未来什么场景下需要想起这条经验"的角度，包含关键场景词和结论。目标是让未来的语义搜索能精准命中。
  - 好的 L0：`"macOS 终端输入中文/非ASCII字符时，键盘模拟不可行，必须使用剪贴板(pbcopy+Cmd+V)"`
  - 差的 L0：`"在飞书操作 Claude Code 时遇到了中文输入问题并解决了"`

- **L1（overview）**：结构化的经验描述。包含：场景、问题、解决方案、反面模式、适用范围。

- **L2（content）**：完整的分析推理过程。包含：任务背景、执行过程分析、踩坑细节、解决过程、经验总结。

写入参数：
- `source.type: 'reflection'`
- `tags: ["task_experience", ...场景标签]`
- `importance: 7-9`（任务经验权重较高）

**第五步：向 master 汇报（可选）**

如果本次反思发现了 importance >= 8 的重大经验：
1. 查询 master 最近通信的 channel-session（通过 Admin RPC 查询 master friend 的 channel_identities + 各 channel 的最近 session 活跃时间）
2. 如果找到，发送简要汇报：哪个任务、发现了什么问题、已总结什么经验
3. 如果找不到最近通信的 channel，随机选一个有 master 私聊 session 的 channel
4. 如果还是找不到，放弃汇报

> 注：查询 master 最近通信 channel 的具体接口可能需要在实现时新增或组合现有接口（get_friend + channel session 查询）。

### 5.3 Schedule 配置示例

```json
{
  "name": "每日反思",
  "enabled": true,
  "trigger": {
    "type": "cron",
    "cron": "0 2 * * *",
    "timezone": "Asia/Shanghai"
  },
  "task_template": {
    "task_type": "daily_reflection",
    "title": "每日反思 — {{date}}",
    "description": "执行每日反思。标准流程：1）获取今日任务概览；2）筛选值得深入分析的任务（失败的、轮数异常多的、人类情绪明显的）；3）查 trace 和对话历史深入分析选中任务；4）提炼经验写入长期记忆（L0 面向召回场景写，L1 结构化描述，L2 完整分析）；5）重大发现向 master 汇报。",
    "priority": "low"
  }
}
```

## 6. 变更范围总结

### crabot-docs（协议文档）

| 文件 | 变更 |
|------|------|
| base-protocol.md | 删除 ThresholdTrigger，TriggerType 改为三种 |
| protocol-admin.md | 删除 ThresholdTrigger 定义和 threshold_check_interval；调度链路改为 Admin → Agent |
| protocol-flow.md | create_task_from_schedule 相关描述标注已迁移至 Agent |
| protocol-memory.md | write_long_term / batch_write_long_term 新增可选 abstract、overview 参数 |

### crabot-admin（Admin 模块）

| 文件 | 变更 |
|------|------|
| package.json | 新增 croner 依赖 |
| src/types.ts | 删除 ThresholdTrigger，对齐协议 |
| src/schedule-engine.ts | **新增** — 调度引擎核心 |
| src/index.ts | Schedule CRUD 接入引擎；start() 时启动引擎 |

### crabot-agent（Agent 模块）

| 文件 | 变更 |
|------|------|
| src/types.ts | task_origin 改为可选；删除 ThresholdTrigger |
| src/unified-agent.ts | handleCreateTaskFromSchedule 补全执行链路 |
| src/orchestration/context-assembler.ts | 新增 assembleScheduledTaskContext |
| src/orchestration/decision-dispatcher.ts | 新增 executeScheduledTaskInBackground（或独立方法） |
| src/mcp/crab-memory.ts | store_memory source.type 支持 reflection / system |
