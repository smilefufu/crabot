# Admin 调度引擎 + 每日反思 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补全 Admin 的调度执行引擎（Cron/Interval/Once），让 Schedule 能自动触发任务；改造 Agent 的调度任务执行路径；设计每日反思的 prompt 模板。

**Architecture:** Admin 新增 ScheduleEngine 类管理 timer 生命周期（croner + setInterval + setTimeout），到点 RPC 调 Agent 的 `create_task_from_schedule`。Agent 端补全执行链路：跳过 Front 分诊，直接组装精简上下文交 Worker。协议文档同步删除 ThresholdTrigger、扩展 write_long_term 接口支持调用方提供 L0/L1。

**Tech Stack:** TypeScript, croner (npm), crabot-shared RPC

**设计文档:** `crabot-agent/docs/specs/2026-04-14-schedule-engine-and-daily-reflection-design.md`

---

## File Structure

### crabot-admin

| 文件 | 职责 |
| ---- | ---- |
| `src/schedule-engine.ts` | **新建** — 调度引擎核心，管理 timer 生命周期 |
| `src/types.ts` | 删除 ThresholdTrigger，清理 ScheduleTriggerType |
| `src/index.ts` | Schedule CRUD 接入引擎；onStart/onStop 挂载引擎 |
| `src/schedule-engine.test.ts` | **新建** — ScheduleEngine 单元测试 |
| `package.json` | 新增 croner 依赖 |

### crabot-agent

| 文件 | 职责 |
| ---- | ---- |
| `src/types.ts` | 删除 ThresholdTrigger 相关类型 |
| `src/unified-agent.ts` | handleCreateTaskFromSchedule 补全执行链路 |
| `src/orchestration/context-assembler.ts` | 新增 assembleScheduledTaskContext |
| `src/orchestration/decision-dispatcher.ts` | 新增 executeScheduledTaskInBackground |
| `src/mcp/crab-memory.ts` | store_memory 支持 abstract/overview 参数，source.type 动态化 |

### crabot-docs

| 文件 | 职责 |
| ---- | ---- |
| `protocols/protocol-admin.md` | 删除 ThresholdTrigger、threshold_check_interval；更新调度链路 |
| `protocols/protocol-memory.md` | write_long_term 新增 abstract/overview 可选参数 |
| `protocols/protocol-flow.md` | create_task_from_schedule 标注已迁移至 Agent |

---

## Task 1: 协议文档变更 — 删除 ThresholdTrigger

**Files:**

- Modify: `crabot-docs/protocols/protocol-admin.md:2119,2143-2161,2163,4445`
- Modify: `crabot-admin/src/types.ts:521,547-553,556`
- Modify: `crabot-agent/src/types.ts`（如有 ThresholdTrigger 引用）

- [ ] **Step 1: 修改 protocol-admin.md — 删除 ThresholdTrigger**

在 `protocol-admin.md` 中执行以下变更：

1. Line 2119: `ScheduleTrigger` 联合类型移除 `ThresholdTrigger`

```typescript
// 修改前
type ScheduleTrigger = CronTrigger | IntervalTrigger | OnceTrigger | ThresholdTrigger

// 修改后
type ScheduleTrigger = CronTrigger | IntervalTrigger | OnceTrigger
```

2. Lines 2143-2161: 删除整个 `ThresholdTrigger` 接口定义

3. Line 2163: `TriggerType` 移除 `"threshold"`

```typescript
// 修改前
type TriggerType = "cron" | "interval" | "once" | "threshold"

// 修改后
type TriggerType = "cron" | "interval" | "once"
```

4. Line 4445: 删除 `threshold_check_interval` 配置项

- [ ] **Step 2: 修改 crabot-admin/src/types.ts — 同步删除**

1. Line 521: 从 `ScheduleTriggerType` 中移除 `'threshold'`

```typescript
// 修改前
export type ScheduleTriggerType = 'cron' | 'interval' | 'once' | 'threshold'

// 修改后
export type ScheduleTriggerType = 'cron' | 'interval' | 'once'
```

2. Lines 547-553: 删除 `ThresholdTrigger` 接口

3. Line 556: 从 `ScheduleTrigger` 联合类型中移除 `ThresholdTrigger`

```typescript
// 修改前
export type ScheduleTrigger = CronTrigger | IntervalTrigger | OnceTrigger | ThresholdTrigger

// 修改后
export type ScheduleTrigger = CronTrigger | IntervalTrigger | OnceTrigger
```

- [ ] **Step 3: 清理 crabot-admin/src/index.ts 中的 threshold 引用**

1. `calculateNextTriggerTime` 方法（line ~2965-2985）中删除 `case 'threshold'` 分支
2. 全文搜索 `threshold` 确保无其他引用

- [ ] **Step 4: 清理 crabot-agent/src/types.ts 中的 threshold 引用**

搜索 `threshold` 关键字，如有引用则删除。

- [ ] **Step 5: 构建验证**

```bash
cd crabot-admin && npm run build
cd crabot-agent && npm run build
```

Expected: 无编译错误

- [ ] **Step 6: 运行现有测试确保无回归**

```bash
cd crabot-admin && npm test
```

Expected: 所有测试通过（schedule 相关测试中如有 threshold 用例需一并删除）

- [ ] **Step 7: Commit**

```bash
git add crabot-docs/protocols/protocol-admin.md crabot-admin/src/types.ts crabot-admin/src/index.ts crabot-agent/src/types.ts
git commit -m "refactor: remove ThresholdTrigger from protocol and code"
```

---

## Task 2: 协议文档变更 — write_long_term 接口扩展

**Files:**

- Modify: `crabot-docs/protocols/protocol-memory.md:166-187`

- [ ] **Step 1: 修改 protocol-memory.md — WriteLongTermParams 新增 abstract/overview**

在 `WriteLongTermParams` 接口（line ~166-187）中，`content` 字段后面新增两个可选字段：

```typescript
interface WriteLongTermParams {
  /** 完整内容（L2） */
  content: string
  /** L0 摘要（可选，不提供则由 Memory 自动生成） */
  abstract?: string
  /** L1 概览（可选，不提供则由 Memory 自动生成） */
  overview?: string
  /** 来源信息 */
  source: MemorySource
  // ... 其他字段不变
}
```

同时在去重/合并流程说明（line ~210 附近）中补充：

> 当调用方提供了 `abstract` / `overview` 时，Memory 直接使用，不再自动生成 L0/L1。适用于反思等场景，调用方比通用摘要器更了解经验的召回场景。

- [ ] **Step 2: Commit**

```bash
git add crabot-docs/protocols/protocol-memory.md
git commit -m "docs: extend write_long_term with optional abstract/overview params"
```

---

## Task 3: 协议文档变更 — 调度链路更新

**Files:**

- Modify: `crabot-docs/protocols/protocol-admin.md`
- Modify: `crabot-docs/protocols/protocol-flow.md:310-341`

- [ ] **Step 1: 修改 protocol-admin.md — 调度执行链路描述**

在 Schedule 管理章节（§3.8 附近）中，将调度触发的执行流程描述从"调用 Flow 的 create_task_from_schedule"更新为"调用 Agent 的 create_task_from_schedule"。搜索 `flow` 或 `Flow` 关键词定位所有引用。

- [ ] **Step 2: 修改 protocol-flow.md — 标注迁移**

在 `create_task_from_schedule` 章节（line ~310）添加迁移说明：

```markdown
> **已迁移**：此接口已迁移至 Agent 模块（原 Flow 合并入 Agent）。参见 protocol-agent-v2.md。
```

- [ ] **Step 3: Commit**

```bash
git add crabot-docs/protocols/protocol-admin.md crabot-docs/protocols/protocol-flow.md
git commit -m "docs: update schedule trigger chain — Admin calls Agent instead of Flow"
```

---

## Task 4: Admin — 安装 croner 依赖

**Files:**

- Modify: `crabot-admin/package.json`

- [ ] **Step 1: 安装 croner**

```bash
cd crabot-admin && npm install croner
```

- [ ] **Step 2: 验证安装**

```bash
cd crabot-admin && node -e "const { Cron } = require('croner'); const c = new Cron('0 2 * * *'); console.log('next:', c.nextRun()); c.stop();"
```

Expected: 打印出下次凌晨 2 点的时间

- [ ] **Step 3: Commit**

```bash
git add crabot-admin/package.json crabot-admin/package-lock.json
git commit -m "chore(admin): add croner dependency for cron scheduling"
```

---

## Task 5: Admin — 实现 ScheduleEngine

**Files:**

- Create: `crabot-admin/src/schedule-engine.ts`
- Test: `crabot-admin/src/schedule-engine.test.ts`

- [ ] **Step 1: 编写 ScheduleEngine 测试**

创建 `crabot-admin/src/schedule-engine.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ScheduleEngine } from './schedule-engine.js'
import type { Schedule, ScheduleTrigger } from './types.js'

function makeSchedule(overrides: Partial<Schedule> & { trigger: ScheduleTrigger }): Schedule {
  return {
    id: 'sched-001',
    name: 'Test Schedule',
    enabled: true,
    trigger: overrides.trigger,
    task_template: {
      type: 'scheduled_reminder',
      title: 'Test Task',
      priority: 'low',
      tags: [],
    },
    execution_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('ScheduleEngine', () => {
  let engine: ScheduleEngine
  let onTrigger: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onTrigger = vi.fn().mockResolvedValue({ task_id: 'task-001' })
    engine = new ScheduleEngine({ onTrigger })
  })

  afterEach(() => {
    engine.stop()
  })

  it('should trigger interval schedule', async () => {
    vi.useFakeTimers()
    const schedule = makeSchedule({
      trigger: { type: 'interval', seconds: 5 },
    })

    engine.add(schedule)
    vi.advanceTimersByTime(5000)

    expect(onTrigger).toHaveBeenCalledWith(schedule)
    vi.useRealTimers()
  })

  it('should trigger once schedule', async () => {
    vi.useFakeTimers()
    const futureTime = new Date(Date.now() + 3000).toISOString()
    const schedule = makeSchedule({
      trigger: { type: 'once', execute_at: futureTime },
    })

    engine.add(schedule)
    vi.advanceTimersByTime(3000)

    expect(onTrigger).toHaveBeenCalledWith(schedule)
    vi.useRealTimers()
  })

  it('should not trigger disabled schedule', () => {
    vi.useFakeTimers()
    const schedule = makeSchedule({
      enabled: false,
      trigger: { type: 'interval', seconds: 1 },
    })

    engine.add(schedule)
    vi.advanceTimersByTime(5000)

    expect(onTrigger).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('should remove schedule timer', () => {
    vi.useFakeTimers()
    const schedule = makeSchedule({
      trigger: { type: 'interval', seconds: 1 },
    })

    engine.add(schedule)
    engine.remove(schedule.id)
    vi.advanceTimersByTime(5000)

    expect(onTrigger).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('should disable and enable schedule', () => {
    vi.useFakeTimers()
    const schedule = makeSchedule({
      trigger: { type: 'interval', seconds: 1 },
    })

    engine.add(schedule)
    engine.disable(schedule.id)
    vi.advanceTimersByTime(3000)
    expect(onTrigger).not.toHaveBeenCalled()

    engine.enable(schedule.id, schedule)
    vi.advanceTimersByTime(1000)
    expect(onTrigger).toHaveBeenCalled()

    vi.useRealTimers()
  })

  it('should update schedule — destroy old timer and create new', () => {
    vi.useFakeTimers()
    const schedule = makeSchedule({
      trigger: { type: 'interval', seconds: 10 },
    })

    engine.add(schedule)

    const updated = { ...schedule, trigger: { type: 'interval' as const, seconds: 2 } }
    engine.update(schedule.id, updated)

    vi.advanceTimersByTime(2000)
    expect(onTrigger).toHaveBeenCalledWith(updated)
    vi.useRealTimers()
  })

  it('should trigger immediately for expired once schedule', () => {
    vi.useFakeTimers()
    const pastTime = new Date(Date.now() - 60000).toISOString()
    const schedule = makeSchedule({
      trigger: { type: 'once', execute_at: pastTime },
    })

    engine.add(schedule)

    // 过期的 Once 应立即触发（setTimeout(0)）
    vi.advanceTimersByTime(0)
    expect(onTrigger).toHaveBeenCalledWith(schedule)
    vi.useRealTimers()
  })

  it('should stop all timers', () => {
    vi.useFakeTimers()
    engine.add(makeSchedule({ id: 's1', trigger: { type: 'interval', seconds: 1 } }))
    engine.add(makeSchedule({ id: 's2', trigger: { type: 'interval', seconds: 2 } }))

    engine.stop()
    vi.advanceTimersByTime(10000)

    expect(onTrigger).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('triggerNow should fire callback without affecting timer', () => {
    vi.useFakeTimers()
    const schedule = makeSchedule({
      trigger: { type: 'interval', seconds: 100 },
    })

    engine.add(schedule)
    engine.triggerNow(schedule.id, schedule)

    expect(onTrigger).toHaveBeenCalledTimes(1)

    // 正常 timer 不受影响
    vi.advanceTimersByTime(100000)
    expect(onTrigger).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: 运行测试确认全部失败**

```bash
cd crabot-admin && npx vitest run src/schedule-engine.test.ts
```

Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 ScheduleEngine**

创建 `crabot-admin/src/schedule-engine.ts`：

```typescript
import { Cron } from 'croner'
import type { Schedule, ScheduleId, ScheduleTrigger } from './types.js'

// Timer 实例：croner 的 Cron 实例或 Node.js 的 Timeout/Interval ID
type TimerHandle = { type: 'cron'; cron: Cron } | { type: 'native'; id: ReturnType<typeof setInterval> }

export interface ScheduleEngineOptions {
  onTrigger: (schedule: Schedule) => Promise<{ task_id: string } | void>
}

export class ScheduleEngine {
  private readonly timers = new Map<ScheduleId, TimerHandle>()
  private readonly onTrigger: ScheduleEngineOptions['onTrigger']

  constructor(options: ScheduleEngineOptions) {
    this.onTrigger = options.onTrigger
  }

  /**
   * 批量加载 — Admin 启动时调用
   */
  startAll(schedules: Schedule[]): void {
    for (const schedule of schedules) {
      if (schedule.enabled) {
        this.createTimer(schedule)
      }
    }
  }

  /**
   * 停止所有 timer
   */
  stop(): void {
    for (const [id, handle] of this.timers) {
      this.destroyTimer(handle)
    }
    this.timers.clear()
  }

  add(schedule: Schedule): void {
    if (schedule.enabled) {
      this.createTimer(schedule)
    }
  }

  remove(id: ScheduleId): void {
    const handle = this.timers.get(id)
    if (handle) {
      this.destroyTimer(handle)
      this.timers.delete(id)
    }
  }

  update(id: ScheduleId, schedule: Schedule): void {
    this.remove(id)
    this.add(schedule)
  }

  enable(id: ScheduleId, schedule: Schedule): void {
    this.remove(id)
    this.createTimer(schedule)
  }

  disable(id: ScheduleId): void {
    this.remove(id)
  }

  triggerNow(id: ScheduleId, schedule: Schedule): void {
    this.fireTrigger(schedule)
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private createTimer(schedule: Schedule): void {
    const { trigger } = schedule

    switch (trigger.type) {
      case 'cron': {
        const cron = new Cron(trigger.expression, { timezone: trigger.timezone }, () => {
          this.fireTrigger(schedule)
        })
        this.timers.set(schedule.id, { type: 'cron', cron })
        break
      }
      case 'interval': {
        const id = setInterval(() => {
          this.fireTrigger(schedule)
        }, trigger.seconds * 1000)
        this.timers.set(schedule.id, { type: 'native', id })
        break
      }
      case 'once': {
        const delay = Math.max(0, new Date(trigger.execute_at).getTime() - Date.now())
        const id = setTimeout(() => {
          this.fireTrigger(schedule)
        }, delay)
        this.timers.set(schedule.id, { type: 'native', id })
        break
      }
    }
  }

  private destroyTimer(handle: TimerHandle): void {
    if (handle.type === 'cron') {
      handle.cron.stop()
    } else {
      clearInterval(handle.id)
      clearTimeout(handle.id)
    }
  }

  private fireTrigger(schedule: Schedule): void {
    this.onTrigger(schedule).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[ScheduleEngine] Failed to trigger schedule ${schedule.id} (${schedule.name}): ${msg}`)
    })
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd crabot-admin && npx vitest run src/schedule-engine.test.ts
```

Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add crabot-admin/src/schedule-engine.ts crabot-admin/src/schedule-engine.test.ts
git commit -m "feat(admin): add ScheduleEngine with cron/interval/once support"
```

---

## Task 6: Admin — 接入 ScheduleEngine 到主模块

**Files:**

- Modify: `crabot-admin/src/index.ts`

- [ ] **Step 1: 导入 ScheduleEngine 并初始化**

在 `index.ts` 顶部添加导入：

```typescript
import { ScheduleEngine } from './schedule-engine.js'
```

在 AdminModule 类中添加属性：

```typescript
private scheduleEngine: ScheduleEngine
```

在构造函数中初始化：

```typescript
this.scheduleEngine = new ScheduleEngine({
  onTrigger: async (schedule) => {
    await this.handleScheduleTrigger(schedule)
  },
})
```

- [ ] **Step 2: 实现 handleScheduleTrigger**

在 AdminModule 类中新增方法。此方法负责：触发时 RPC 调 Agent、更新 Schedule 状态、模板变量替换。

```typescript
private async handleScheduleTrigger(schedule: Schedule): Promise<void> {
  const now = new Date()
  const templateVars: Record<string, string> = {
    '{{date}}': now.toISOString().slice(0, 10),
    '{{time}}': now.toTimeString().slice(0, 8),
    '{{datetime}}': now.toISOString(),
    '{{schedule_name}}': schedule.name,
  }

  const replaceVars = (str: string): string => {
    let result = str
    for (const [key, value] of Object.entries(templateVars)) {
      result = result.replaceAll(key, value)
    }
    return result
  }

  const title = replaceVars(schedule.task_template.title)
  const description = replaceVars(schedule.task_template.description ?? '')

  // RPC 调 Agent 的 create_task_from_schedule
  const agentModuleId = this.findAgentModuleId()
  if (!agentModuleId) {
    console.error(`[ScheduleEngine] No agent module found, skipping trigger for ${schedule.id}`)
    return
  }

  const agentPort = this.getModulePort(agentModuleId)
  const result = await this.rpcClient.call<
    { schedule_id: string; task_type: string; title: string; description: string },
    { task_id: string; assigned_worker: string }
  >(
    agentPort,
    'create_task_from_schedule',
    {
      schedule_id: schedule.id,
      task_type: schedule.task_template.type,
      title,
      description,
    },
    this.moduleId
  )

  // 更新 Schedule 状态（不可变模式）
  const updated: Schedule = {
    ...schedule,
    last_triggered_at: now.toISOString(),
    execution_count: schedule.execution_count + 1,
    next_trigger_at: this.calculateNextTriggerTime(schedule.trigger),
    last_task_id: result.task_id,
    updated_at: now.toISOString(),
  }
  this.schedules.set(schedule.id, updated)

  // Once 类型触发后自动 disable
  if (schedule.trigger.type === 'once') {
    const disabled: Schedule = { ...updated, enabled: false }
    this.schedules.set(schedule.id, disabled)
    this.scheduleEngine.disable(schedule.id)
  }

  this.publishAdminEvent('admin.schedule_triggered', { schedule: updated, task_id: result.task_id })
}
```

> 注：`findAgentModuleId()` 和 `getModulePort()` 需要根据 Admin 现有的模块发现机制实现。如果已有类似方法，直接复用。

- [ ] **Step 3: onStart 中启动引擎**

在 `onStart()` 方法末尾（line ~464 之前），添加：

```typescript
// 启动调度引擎
const allSchedules = Array.from(this.schedules.values())
this.scheduleEngine.startAll(allSchedules)
console.log(`[Admin] ScheduleEngine started with ${allSchedules.filter(s => s.enabled).length} active schedules`)
```

- [ ] **Step 4: onStop 中停止引擎**

在 `onStop()` 方法开头（`await this.saveData()` 之前），添加：

```typescript
this.scheduleEngine.stop()
```

- [ ] **Step 5: Schedule CRUD 接入引擎**

修改现有的 Schedule 处理方法，在数据操作后同步通知引擎：

**handleCreateSchedule**（line ~2752）— 末尾添加：
```typescript
this.scheduleEngine.add(schedule)
```

**handleUpdateSchedule**（line ~2835）— 末尾添加：
```typescript
this.scheduleEngine.update(schedule.id, schedule)
```

**handleDeleteSchedule**（line ~2871）— `this.schedules.delete()` 前添加：
```typescript
this.scheduleEngine.remove(params.schedule_id)
```

**handleUpdateSchedule** 中处理 `enabled` 变更时：
```typescript
if (params.enabled !== undefined) {
  schedule.enabled = params.enabled
  if (params.enabled) {
    this.scheduleEngine.enable(schedule.id, schedule)
  } else {
    this.scheduleEngine.disable(schedule.id)
  }
}
```

**handleTriggerNow**（line ~2885）— 替换为委托引擎：
现有 `handleTriggerNow` 直接创建 Task，但不走 Agent 执行链路。改为调用 `handleScheduleTrigger`，保持 trigger_now 和自动触发走同一条路径。

- [ ] **Step 6: 修改 calculateNextTriggerTime — 使用 croner**

替换 `calculateNextTriggerTime` 方法（line ~2965）：

```typescript
private calculateNextTriggerTime(trigger: ScheduleTrigger): string | undefined {
  switch (trigger.type) {
    case 'cron': {
      const cron = new Cron(trigger.expression, { timezone: trigger.timezone })
      const next = cron.nextRun()
      cron.stop()
      return next?.toISOString()
    }
    case 'interval': {
      return new Date(Date.now() + trigger.seconds * 1000).toISOString()
    }
    case 'once': {
      return trigger.execute_at
    }
    default:
      return undefined
  }
}
```

- [ ] **Step 7: 构建验证**

```bash
cd crabot-admin && npm run build
```

Expected: 无编译错误

- [ ] **Step 8: 运行全部测试**

```bash
cd crabot-admin && npm test
```

Expected: 全部 PASS（包括 schedule-engine.test.ts 和 task-schedule.test.ts）

- [ ] **Step 9: Commit**

```bash
git add crabot-admin/src/index.ts
git commit -m "feat(admin): integrate ScheduleEngine into AdminModule lifecycle"
```

---

## Task 7: Agent — assembleScheduledTaskContext

**Files:**

- Modify: `crabot-agent/src/orchestration/context-assembler.ts:106`

- [ ] **Step 1: 新增 assembleScheduledTaskContext 方法**

在 `ContextAssembler` 类中（`assembleWorkerContext` 方法之后），添加：

```typescript
/**
 * 组装调度任务上下文 — 不依赖 channel/session/friend
 * 用于定时任务、每日反思等系统触发的任务
 */
async assembleScheduledTaskContext(): Promise<WorkerAgentContext> {
  const [adminEndpoint, memoryEndpoint, channelEndpoints] = await Promise.all([
    this.resolveModule('admin'),
    this.resolveModule('memory'),
    this.resolveModules('channel'),
  ])

  return {
    short_term_memories: [],
    long_term_memories: [],
    available_tools: [],
    admin_endpoint: adminEndpoint,
    memory_endpoint: memoryEndpoint,
    channel_endpoints: channelEndpoints,
    memory_permissions: {
      write_visibility: 'internal',
      write_scopes: [],
    },
  }
}
```

- [ ] **Step 2: 构建验证**

```bash
cd crabot-agent && npm run build
```

Expected: 无编译错误（WorkerAgentContext.task_origin 已是可选字段）

- [ ] **Step 3: Commit**

```bash
git add crabot-agent/src/orchestration/context-assembler.ts
git commit -m "feat(agent): add assembleScheduledTaskContext for non-chat tasks"
```

---

## Task 8: Agent — 补全 handleCreateTaskFromSchedule 执行链路

**Files:**

- Modify: `crabot-agent/src/unified-agent.ts:1664-1722`
- Modify: `crabot-agent/src/orchestration/decision-dispatcher.ts`

- [ ] **Step 1: 在 DecisionDispatcher 中新增 executeScheduledTaskInBackground**

在 `decision-dispatcher.ts` 中，`executeTaskInBackground` 方法（line ~273）之后添加：

```typescript
/**
 * 后台执行调度任务 — 无聊天上下文版本
 * 不发即时回复，不回复到 channel，只更新 Admin 任务状态
 */
executeScheduledTaskInBackground(
  task: AdminTask,
  workerContext: import('../types.js').WorkerAgentContext,
  relatedTaskId: string,
): void {
  const run = async () => {
    const adminPort = await this.getAdminPort()

    // 推进任务状态
    try {
      await this.rpcClient.call(
        adminPort, 'update_task_status',
        { task_id: task.id, status: 'planning' },
        this.moduleId
      )
      await this.rpcClient.call(
        adminPort, 'update_task_status',
        { task_id: task.id, status: 'executing' },
        this.moduleId
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[DecisionDispatcher] Failed to transition scheduled task ${task.id}: ${msg}`)
    }

    try {
      const taskPayload: ExecuteTaskParams = {
        task: {
          task_id: task.id,
          task_title: task.title,
          task_description: task.description ?? '',
          task_type: task.type,
          priority: task.priority,
          plan: task.plan,
        },
        context: workerContext,
      }

      const result: ExecuteTaskResult & { trace_id?: string } = this.executeTaskFn
        ? await this.executeTaskFn({ ...taskPayload, related_task_id: relatedTaskId })
        : await this.workerHandler!.executeTask(taskPayload)

      // 更新 Admin 任务状态
      const finalStatus = result.outcome === 'completed' ? 'completed' : 'failed'
      await this.rpcClient.call(
        adminPort,
        'update_task_status',
        {
          task_id: task.id,
          status: finalStatus,
          result: {
            outcome: result.outcome,
            summary: result.summary,
            final_reply: result.final_reply,
            finished_at: new Date().toISOString(),
          },
          ...(finalStatus === 'failed' && { error: result.summary }),
        },
        this.moduleId
      ).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[DecisionDispatcher] Failed to update scheduled task status: ${msg}`)
      })

      // 写入短期记忆（系统级）
      this.memoryWriter.writeTaskFinished({
        task_id: task.id,
        task_title: task.title,
        outcome: result.outcome,
        summary: result.summary,
        friend_name: 'system',
        friend_id: '',
        channel_id: '',
        session_id: '',
        visibility: 'internal',
        scopes: [],
        trace_id: result.trace_id,
      }).catch(() => {})

      // 不向 channel 回复 — 调度任务无来源会话
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[DecisionDispatcher] Scheduled task ${task.id} failed: ${msg}`)

      try {
        await this.rpcClient.call(
          adminPort,
          'update_task_status',
          { task_id: task.id, status: 'failed', error: msg },
          this.moduleId
        )
      } catch { /* best effort */ }
    }
  }

  run().catch((err) => {
    console.error(`[DecisionDispatcher] Unexpected error in scheduled task: ${err}`)
  })
}
```

- [ ] **Step 2: 修改 handleCreateTaskFromSchedule — 补全执行**

在 `unified-agent.ts` 的 `handleCreateTaskFromSchedule` 方法（line ~1664）中，在 `return` 之前插入执行逻辑：

```typescript
// 原有代码到 taskResult 之后，return 之前插入：

// 组装调度任务上下文
const context = await this.contextAssembler.assembleScheduledTaskContext()

// 后台执行（fire-and-forget）
this.decisionDispatcher.executeScheduledTaskInBackground(
  { id: taskResult.task_id, title, description, type: task_type, priority: 'low', plan: undefined } as AdminTask,
  context,
  taskResult.task_id,
)
```

> 注：AdminTask 的构造需要与 Admin 的 Task 类型对齐。具体字段以 `create_task` RPC 返回的为准。如果 `create_task` 返回完整 Task 对象，直接使用即可。

- [ ] **Step 3: 构建验证**

```bash
cd crabot-agent && npm run build
```

Expected: 无编译错误

- [ ] **Step 4: Commit**

```bash
git add crabot-agent/src/unified-agent.ts crabot-agent/src/orchestration/decision-dispatcher.ts
git commit -m "feat(agent): complete scheduled task execution pipeline"
```

---

## Task 9: Agent — store_memory 支持 abstract/overview 和动态 source.type

**Files:**

- Modify: `crabot-agent/src/mcp/crab-memory.ts:46-76`

- [ ] **Step 1: 扩展 MemoryTaskContext**

在 `crab-memory.ts` 的 `MemoryTaskContext` 接口（line ~26）中新增：

```typescript
export interface MemoryTaskContext {
  taskId: string
  channelId?: string
  sessionId?: string
  visibility: 'private' | 'internal' | 'public'
  scopes: string[]
  /** 记忆来源类型，默认 'conversation'。反思任务使用 'reflection' */
  sourceType?: 'conversation' | 'reflection' | 'system'
}
```

- [ ] **Step 2: 扩展 store_memory 工具 schema 和调用**

修改 `store_memory` 工具定义（line ~46），在 schema 中新增 `abstract` 和 `overview` 可选参数：

```typescript
server.tool(
  'store_memory',
  '将信息写入长期记忆。用户要求记住时必须使用；发现有价值的偏好、案例、模式等信息时也应主动使用。反思场景下应提供 abstract（面向召回的 L0 摘要）和 overview（结构化 L1 概览）。',
  {
    content: z.string().describe('要记住的完整信息（L2），应包含足够上下文'),
    abstract: z.string().optional()
      .describe('L0 摘要（可选）。面向召回场景写，包含关键场景词和结论。不提供则由 Memory 自动生成'),
    overview: z.string().optional()
      .describe('L1 概览（可选）。结构化经验描述：场景、问题、方案、适用范围。不提供则由 Memory 自动生成'),
    importance: z.number().min(1).max(10).optional()
      .describe('重要性 1-10，日常偏好 3-5，重要决策 6-8，关键信息 9-10'),
    tags: z.array(z.string()).optional()
      .describe('分类标签'),
  },
  async (args) => {
    try {
      const memoryPort = await getMemoryPort()
      const result = await rpcClient.call(
        memoryPort,
        'write_long_term',
        {
          content: args.content,
          ...(args.abstract && { abstract: args.abstract }),
          ...(args.overview && { overview: args.overview }),
          source: {
            type: ctx.sourceType ?? 'conversation',
            task_id: ctx.taskId,
            channel_id: ctx.channelId,
            session_id: ctx.sessionId,
          },
          importance: args.importance ?? 5,
          tags: args.tags,
          visibility: ctx.visibility,
          scopes: ctx.scopes,
        },
        moduleId
      ) as { action: string; memory: { id: string; abstract: string } }
      // ... 返回逻辑不变
```

- [ ] **Step 3: 在 WorkerHandler 中传递 sourceType**

在创建 `MemoryTaskContext` 的地方（`worker-handler.ts` 中 `executeTask` 方法里），根据 `task_type` 设置 `sourceType`：

```typescript
const memoryCtx: MemoryTaskContext = {
  taskId: task.task_id,
  channelId: context.task_origin?.channel_id,
  sessionId: context.task_origin?.session_id,
  visibility: context.memory_permissions?.write_visibility ?? 'internal',
  scopes: context.memory_permissions?.write_scopes ?? [],
  sourceType: task.task_type === 'daily_reflection' ? 'reflection' : context.task_origin ? 'conversation' : 'system',
}
```

- [ ] **Step 4: 构建验证**

```bash
cd crabot-agent && npm run build
```

Expected: 无编译错误

- [ ] **Step 5: Commit**

```bash
git add crabot-agent/src/mcp/crab-memory.ts crabot-agent/src/agent/worker-handler.ts
git commit -m "feat(agent): extend store_memory with abstract/overview and dynamic source.type"
```

---

## Task 10: 端到端验证

**Files:** 无新文件

- [ ] **Step 1: 启动开发环境**

```bash
./dev.sh
```

Expected: Admin (port 3000), Module Manager (port 19000) 正常启动

- [ ] **Step 2: 通过 Admin API 创建测试 Schedule**

```bash
curl -X POST http://localhost:19001/create_schedule \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Test Interval",
    "enabled": true,
    "trigger": { "type": "interval", "seconds": 30 },
    "task_template": {
      "type": "scheduled_reminder",
      "title": "Test Reminder — {{date}}",
      "description": "这是一个测试提醒",
      "priority": "low",
      "tags": ["test"]
    }
  }'
```

Expected: 返回 schedule 对象，`next_trigger_at` 有值

- [ ] **Step 3: 等待触发并验证**

等待 30 秒后检查：

```bash
# 查看 Schedule 状态
curl -X POST http://localhost:19001/get_schedule \
  -H 'Content-Type: application/json' \
  -d '{"schedule_id": "<上一步返回的 id>"}'

# 查看 Admin 任务列表
curl -X POST http://localhost:19001/list_tasks \
  -H 'Content-Type: application/json' \
  -d '{"page": 1, "page_size": 5}'
```

Expected:
- Schedule 的 `execution_count` >= 1，`last_triggered_at` 有值
- 任务列表中出现对应的 Task

- [ ] **Step 4: 测试 Cron 调度（可选，用 trigger_now 模拟）**

```bash
# 创建 Cron Schedule
curl -X POST http://localhost:19001/create_schedule \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Daily Reflection Test",
    "enabled": true,
    "trigger": { "type": "cron", "expression": "0 2 * * *", "timezone": "Asia/Shanghai" },
    "task_template": {
      "type": "daily_reflection",
      "title": "每日反思 — {{date}}",
      "description": "执行每日反思。标准流程：1）获取今日任务概览；2）筛选值得深入分析的任务（排除 daily_reflection 类型任务）；3）查 trace 和对话历史深入分析选中任务；4）提炼经验写入长期记忆（L0 面向召回场景写，L1 结构化描述，L2 完整分析）；5）重大发现向 master 汇报。",
      "priority": "low",
      "tags": ["reflection"]
    }
  }'

# 手动触发测试
curl -X POST http://localhost:19001/trigger_now \
  -H 'Content-Type: application/json' \
  -d '{"schedule_id": "<返回的 id>"}'
```

Expected: 触发成功，Agent 收到任务并开始执行

- [ ] **Step 5: 清理测试数据，停止环境**

```bash
./dev.sh stop
```

- [ ] **Step 6: Final commit（如有修复）**

```bash
git add -A
git commit -m "fix: address issues found in e2e testing"
```

---

## 注意事项

1. **反思 prompt 的质量**：Task 10 Step 4 中的 `description` 是反思的核心指令。如果 Worker 表现不佳，优先调整这段 prompt。
2. **handleTriggerNow 重构**：Task 6 Step 5 中，现有 `handleTriggerNow` 直接在 Admin 内创建 Task（不走 Agent），需要改为调用 `handleScheduleTrigger` 走统一链路。这是一个破坏性变更，原有测试需要适配。
3. **Agent 模块发现**：Task 6 Step 2 中 `findAgentModuleId()` 需要根据 Admin 现有的模块注册表来实现。查看 Admin 如何存储已注册模块信息。
4. **croner 与 fake timers 兼容性**：Task 5 的 Cron 测试可能与 `vi.useFakeTimers()` 不兼容（croner 内部可能用了 Date.now 之外的时间源）。如果 Cron 测试不稳定，单独用真实 timer 测试，设短间隔（如 `* * * * *` 每分钟触发）。
