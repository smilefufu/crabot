# 后台实体重构设计：后台即 Persistent + 跨重启 re-adopt

> 状态：**草案 / 待评审**
> 整理时间：2026-06-26
> 信息源：当前代码仓库（crabot-agent / crabot-admin）
> 说明：crabot-docs（SSOT）当前未 checkout，本草案先落主仓 `docs/`，定稿后搬入
> `crabot-docs/superpowers/specs/`，并取代 bg-shell.ts 顶部引用的旧 spec。

---

## 0. 背景与动机

当前 Bash 工具有三套并存机制，概念重叠、且在重启场景下有洞：

1. **auto-bg**（`runForegroundWithGrace`，bash-tool.ts:201）：默认命令前台跑，超 10s 宽限期自动转后台。**永远落地为 transient**（内存 ring buffer，随 task 死，仪表盘不可见）。
2. **显式 `run_in_background:true`**（`runBg`，bash-tool.ts:136）：立即返回 handle。master 私聊 → persistent（磁盘日志，扛重启）；其他 → transient。
3. **`Output` 工具**（output-tool.ts）：读 shell/agent 增量或终态输出。

暴露的问题：

- **transient / persistent 的分裂没有产品意义**：用户真正关心的是"这条后台命令要不要被监管、要不要扛重启"，而当前由"在不在 master 私聊"和"走没走显式 flag"间接决定，耦合混乱。
- **auto-bg 的命令在 Admin「长跑实体」页隐形**：该页读落盘 registry（`listBgEntities → bgRegistry.list`，agent-handler.ts:3671），transient 不入账，所以后台跑的命令运营者看不见、kill 不了。
- **跨重启跟踪是断的**：persistent shell 进程 detached + unref，重启后**进程继续在跑**（这是对的），但 agent **接不回来**——`recoverPersistent` 的返回值被直接 `.catch` 丢弃（agent-handler.ts:528），活 shell 没有重新挂 exit 检测；它真正退出后不会通知、会以 `running` 滞留，直到下次重启被误标 `failed/-1`。
- **`Output` 每次必调**：bg 退出通知只带状态不带输出（agent-handler.ts:1096），agent 必须再调一次 `Output` 才能拿到输出，造成大量 Bash+Output 成对调用。

---

## 1. 决策摘要（已拍板）

| # | 决策 | 结论 |
|---|------|------|
| D1 | 取消 transient 作为**后台模式** | 凡是真正转入后台的命令，一律 persistent（落盘 + 入账 + 可见）。前台快命令仍用轻量内存缓冲，不入账。 |
| D2 | 是否进化为"可复用 shell 会话"（往同一 shell 发多条命令、cwd/env 延续）| **不做**。收益对当前 workload 有限（`set_cwd` 已解决 cwd 延续），代价大（PTY、命令边界判定、会话状态污染）。留待将来确有交互式需求再议。 |
| D3 | Admin「长跑实体」页 | **去掉独立顶层导航页**，把"当前还在跑的后台实体 + kill"折进对应 trace 视图。 |
| D4 | 跨重启 re-adopt | 顺着现有"拉式恢复"模型做，不硬接 push 唤醒。配套：退出码写盘 sentinel + reaper 轮询 + deadShells 补发通知。 |

---

## 2. 设计 D1：后台即 Persistent

### 2.1 生命周期切分

切分点从"transient vs persistent 存储"改为"命令有没有越过前台轮次"：

| 阶段 | 待遇 | 是否入账 |
|------|------|---------|
| 前台、宽限期（10s）内结束（绝大多数 `ls`/`grep`）| 轻量内存缓冲，跑完读输出即弃 | **否** |
| 越过宽限期（auto-bg）或显式后台 | **晋升为 persistent**：落盘日志 + 入 bgRegistry + 仪表盘可见 | 是 |

效果：后台实体只剩 persistent 一种；auto-bg 的命令不再隐形；`transient` 退化为"前台缓冲"的实现细节，`TransientShellRegistry` 可大幅简化或并入。

### 2.2 「晋升」机制

命令仍先以内存缓冲方式 spawn（避免给每个 30ms 的 `ls` 都建磁盘日志、写 registry，否则磁盘 I/O 暴增、registry 被噪音灌满）。在 10s 宽限定时器触发（`runForegroundWithGrace` 的 grace 分支，bash-tool.ts:265）那一刻做一次晋升：

1. 建磁盘日志文件，把已捕获的内存缓冲一次性 flush 进去；
2. 注册进 bgRegistry（owner / spawned_by_task_id / pid / pgid / process_started_at）；
3. 后续 stdout/stderr 改为转写磁盘日志（子进程 stdout 本就在 JS 手里，改写入目标即可）；
4. 返回 entity_id + 引导（保持现有"继续做别的 / wait_for_signal"话术）。

**日志产出路径与 persistent 完全一致（已定）**：所有 Bash 命令从 spawn 起就把 stdout/stderr 写到磁盘日志（同 `spawnPersistentShell` 的 `stdio:['ignore', logFd, logFd]`，路径 `getBgEntitiesLogsDir()/<entity>.log`）。区别只在"要不要入账 + 要不要保留"：

- **宽限期内结束**：从日志文件读尾部内联返回，删日志，**不入 bgRegistry**（不污染仪表盘）。
- **晋升（超 10s）/ 显式后台**：入 bgRegistry + 保留日志。晋升此时只剩一个动作——注册（日志文件已在写，无需 flush 内存缓冲）。

附带收益：**内存 ring buffer / `TransientShellRegistry` 整套可移除**，输出只有一条产出路径（磁盘日志），与 persistent 统一，代码显著简化。

> **为什么必须"spawn 即 OS 直写盘"，而非"内存管道、晋升时再刷盘"**：内存管道方式下子进程输出经父进程 JS handler 转写，agent 一重启父进程死、管道断裂→后续输出丢失（甚至 SIGPIPE 杀子进程）。只有 `stdio:['ignore', logFd, logFd]` + detached 的 OS 直写盘能让子进程在父死后继续写文件——这是 D4 re-adopt 的物理前提。而活进程 fd 改不了，没法中途从管道转直写盘。故"任何命令都可能转后台、转了就得扛重启"⇒ 必须从 spawn 起就直写盘。这是被 re-adopt 强制，不是简洁偏好。

### 2.3 唤醒语义统一（D1 的硬约束，不可遗漏）

> 这是 D1 落地最容易踩坑、且会直接打破已验证 happy path 的地方。

**现状（与 transient/persistent 焊死）**：

- transient shell 退出 → `onShellExit` push **humanQueue** → 清 barrier → 唤醒挂起的 `wait_for_signal`（agent-handler.ts:1095）。
- persistent shell 退出 → 只 `enqueueBgNotification`（friend 队列，下个 turn 边界才 drain，agent-handler.ts:1108）→ **不唤醒挂起的 worker**。
- `hasRunningBgEntity` **只数 transient**（agent-handler.ts:1271）；注释："persistent 可能永不退出，不算"。

**问题**：D1 把后台命令全变 persistent 后，trace 里验证过的 `auto-bg → wait_for_signal → 退出唤醒 → Output` 会断——worker 要么被拒绝裸挂起，要么挂起后等不到唤醒、挂到超时。

**要求（统一唤醒，不再依赖 transient/persistent 区分）**：

- **R1**：后台 shell 退出时，`onShellExit` 既要 **push 拥有它的 task 的 humanQueue**（in-process 唤醒挂起的 wait_for_signal），又要 **`enqueueBgNotification`(friend)**（跨 turn / 跨重启 / 下一个 task 的持久通知）。两条都发，去掉 transient/persistent 分支。
- **R2**：`hasRunningBgEntity` 改为统计**本 task 名下 running 的（持久）shell**，让"等它退出"重新成为合法裸挂起（恢复今天 transient 的语义）。仍保留"可能永不退出的进程（服务/监控）建议带 timeout_ms"的引导。
- **R3（跨重启）**：见 §3.4。

### 2.4 退出通知内联输出（消除尾随 Output）

bg 退出通知（`onShellExit`，agent-handler.ts:1091）当前只带 `status/exit_code/runtime/command`。改为**附带截断后的最终输出尾部**（如末 2–4KB）+ "更多用 `Output(entity_id, from_offset=...)`"。

效果：常见的"等命令结束 → 捞一次输出"场景不再需要单独调 `Output`，Bash+Output 成对调用大幅减少。`Output` 降级为"分页大输出 / 流式监控"的高级工具，保留不删。

---

## 3. 设计 D4：跨重启 re-adopt（重点，需与现有恢复机制对齐）

### 3.1 现有重启恢复链路（必须顺着它做，别重造）

> 完整链路见附录 A。要点：

- **检测**：agent 重启发 `module_started`(restart_count) → admin `sweepInterruptedTasksForResume`（index.ts:4698）。
- **两套恢复，对单个 task 互斥**：
  - (a) **checkpoint-resume**（无损优先）：admin 调 `resume_task` RPC → agent 从 per-task checkpoint 的消息重起 worker loop（unified-agent.ts:1894）。**同一 task_id 续跑。**
  - (b) **recovery task**（兜底）：resume 失败 → 原 task 标 `failed` + 派一条 `tags=['recovery']` 的**新** task，让 worker 用 `find_task`/`get_task_progress`/`ListEntities` **自查续办**（recovery-handler.ts）。
- **关键性质**：`waiting`/`waiting_human` 任务重启时被标 **failed**（挂起态无法原地恢复）；`pendingBgNotifications`、`humanQueues` 均为**内存、重启即丢**。

**结论**：现有模型本质是**拉式**（恢复出的 worker 主动查状态），不是 push 唤醒。re-adopt 应提供"可被查到的准确状态"，而非"跨重启 push 唤醒一个已不存在的挂起循环"。

### 3.2 硬限制：detached 进程的退出码无法跨重启 reap

只有父进程能拿到子进程退出码。persistent shell 是 detached 的，重启后新进程不是它父进程，`kill(pid,0)` 只能判活/死，**拿不到真实退出码**。当前 `recoverPersistent` 把重启后发现已死的 shell 一律标 `failed/-1`——**哪怕它其实成功退出**，这是错的。

**解法：退出码写盘 sentinel。** persistent shell 的命令包一层，把退出码落盘：

```
bash -c '<command>; ec=$?; echo "$ec" > <entity>.exitcode; exit $ec'
```

任何进程（含重启后的新 agent）都能读 `<entity>.exitcode` 拿到真实成败。无该文件 = "进程还在跑或被强杀"。

### 3.3 re-adopt 三处改动

1. **接住 `recoverPersistent` 的返回值**（agent-handler.ts:528 现在直接 `.catch` 丢弃）：
   - `alive` shell：交给 reaper（见下）继续跟踪，**保持 `running`、保持 ListEntities 可见**（拉式恢复的 worker 能查到）。
   - `deadShells`（宕机期间已退出）：读 `.exitcode` sentinel 定真实状态（completed/failed），**并按记录的 `owner.friend_id` 补发一条 bg-notification**（带日志尾部），而不是静默标 failed。

2. **新增 reaper 轮询**：周期对 re-adopt 回来的 alive shell 做 `kill(pid,0)`（+ 启动时间防 PID 复用，复用现有 `isShellAlive`，registry.ts:247）。探到退出 → 读 sentinel 定状态 → 更新 registry → 按 `owner.friend_id` `enqueueBgNotification`。
   - 复用现有 7d GC（`gcDeadEntities`）回收终态记录；考虑缩短保留期或加"task 完成即清该 task 名下终态实体"（见 §4）。

3. **投递对齐两种恢复路径**（都 robust，无需新增持久队列）：
   - **checkpoint-resume 的 in-place worker**：reaper 在**新进程**里 `enqueueBgNotification`，与 resumed worker 同进程，内存队列可达，下个 turn drain 即得。
   - **recovery task 的 worker**：本就靠 `ListEntities`/`Output` 自查——§3.3.1 保证了实体可见、状态准确，自然查得到。

### 3.4 跨重启唤醒（R3）+ 一个已定位的待补点

reaper 跑在**重启后的新进程**里，与 resumed worker 同进程，所以 §2.3 的 R1 自然适用：

- **退出在重启之后**：reaper 探到退出 → push 拥有该 shell 的 task 的 humanQueue（若该 task 已被 checkpoint-resume 在跑，则就地唤醒）+ enqueueBgNotification。
- **退出在宕机期间**（§3.3 deadShells 分支）：启动扫描时读 sentinel 定状态 + enqueueBgNotification（带日志尾部）。此时还没有活着的 worker 可 push，靠 friend 队列等 resumed/recovery worker 来取。

**已核实——是个潜在 bug，必须修**：resume 路径会 **drain-and-discard** friend 队列。

- 根因：`query-loop.ts:257` `const messages = initialMessages ? [...initialMessages] : [createUserMessage(prompt)]` —— resume 走 `initialMessages` 分支，**`prompt` 被完全忽略**。
- 而 resume 时 `opts.initialPrompt` 是 undefined，runWorkerLoop 仍走 else 分支执行了 `buildTaskMessage` + `drainBgNotifications`（agent-handler.ts:1302-1307），把结果塞进**被忽略的** `taskMessage`。→ **friend 队列被清空，内容丢弃。**
- 今天已是潜在 bug（resume 时刚好有 pending 持久通知就丢），只是窗口窄。D1 + re-adopt 后这条路径变热（每个宕机期间退出的 shell 都 enqueue 通知）。

**修复（精确）**：在 resume 装配处（agent-handler.ts:672 的 `params.resumeFrom` 块）drain friend 队列，把通知**拼进 `currentInitialMessages`**（与 `buildResumeWakeupMessage()` 同处注入），而非丢进被忽略的 prompt。

> 这条是整套设计里跨重启唯一可能"静默挂死/丢信号"的点。recovery-task 路径不受影响（worker 主动 `ListEntities`/`Output` 自查，不依赖 push）。

---

## 4. 设计：GC / 保留策略

现状已有 7 天 GC（`gcDeadEntities`，registry.ts:190 + 24h 定时 + 启动各跑一次）。D1 落地后 persistent 实体数量上升，需收紧：

- **task 完成即清**：task 走到终态时，清掉它名下所有已终态（completed/failed/killed）的 persistent 实体记录 + 日志文件 + sentinel。
- 7 天 GC 保留为兜底（跨 task / 孤儿）。
- 「仍 running」的实体永不被 GC（只能被 kill 或 reaper 标终态后再 GC）。

> 注意：今天的设计是让 agent 手动 `Kill` 清理（连已退出的也要清，agent-handler.ts:1107 提示语），别扭。改为自动清，手动 Kill 只用于"杀正在跑的"。

---

## 5. 设计 D3：Admin UI 折进 Traces

### 5.1 现状问题

「长跑实体」页（crabot-admin/web/src/pages/BgEntities/index.tsx）按**实体**组织：`shell_cd0165b374bc` 跑 `grep ...`，对人类是天书。它把 agent `ListEntities` 工具的原始视图直接搬给人看。人类来此只想知道：Crabot 在忙啥 / 有没有跑飞的进程要杀 / 我那个长任务还在不在跑。

### 5.2 方案

- **删掉顶层导航「长跑实体」**（Sidebar.tsx:41）。
- 在 **trace 视图**内嵌"该 trace 当前还在跑的后台实体"小区块，每个 running 实体挂 **kill** 按钮（kill 是唯一有价值的人类动作，必须保留）。trace 提供了独立页缺失的"为什么跑这条命令"的上下文。
- 实体→trace 的关联用记录里的 `spawned_by_task_id`（→ task → trace），重启后仍可 join。
- agent 的 `ListEntities` 工具不受影响（那是工具层，UI 不必镜像）。

> 边界：persistent 实体可能 outlive 其 trace（扛重启、跨 task）。这类"孤儿"通过其（已完结的）原 trace 视图仍可见，或靠 §4 的 GC 兜底；不为它单独保留一个顶层页。

---

## 6. 受影响代码清单

| 区域 | 文件 | 改动 |
|------|------|------|
| 统一产出路径 | bash-tool.ts、bg-shell.ts | 所有命令 spawn 即写磁盘日志；宽限期内结束→读尾部内联返回+删日志+不入账；超期→注册入账。**移除 ring buffer / TransientShellRegistry** |
| 晋升机制 | bash-tool.ts grace 分支（:265） | 由"转 transient"改为"注册进 bgRegistry"（日志已在写，无需 flush） |
| exitcode sentinel | bg-shell.ts spawn | 命令包 `…; ec=$?; echo $ec > <entity>.exitcode; exit $ec`，使退出码跨重启可 reap |
| **删 Bash run_in_background + 一致性清理** | 见 §6.1 | flag 删除，并同步清掉所有引用它的 prompt / 工具描述 / 注释 |
| **唤醒语义统一（R1/R2）** | agent-handler.ts:1091、:1271 | onShellExit 同时 push humanQueue + enqueueBgNotification（去 transient/persistent 分支）；hasRunningBgEntity 改数本 task 名下 running 持久 shell |
| 退出通知带输出 | agent-handler.ts:1091 | onShellExit 附带日志尾部 |
| re-adopt | agent-handler.ts:528 | 接住 recoverPersistent 返回值，挂 reaper |
| recoverPersistent | registry.ts:152 | deadShells 读 sentinel 定状态 + 补发通知；alive 交 reaper |
| reaper（新） | crabot-agent/src/engine/bg-entities/*（新文件）| 周期 isShellAlive + 读 sentinel + push humanQueue（task 活时）+ enqueueBgNotification |
| **resumed-worker drain（§3.4 待补点）** | unified-agent.ts:1961 / agent-handler.ts:1300 | 确认 resume 路径是否 drain friend 队列；缺则在 resume 装配时补一次 |
| GC 收紧 | registry.ts:190 + agent-handler | task 完成即清名下终态实体；7d 兜底保留 |
| Output 降级 | output-tool.ts | 文案调整（非必调）；移除与 get_subagent_output 重复的 agent_xxx 分支 |
| UI 折叠 | crabot-admin/web/src/pages/BgEntities/*、Sidebar.tsx:41、trace 视图 | 删页 + trace 内嵌 running 实体 + kill |

### 6.1 删除 Bash `run_in_background` 的一致性清理清单

> 目标：flag 删除后，**给 agent 的所有信息**（工具 schema / 描述 / system prompt 话术）都不得再提它，否则 agent 会调一个不存在的参数。

**删除/改逻辑**：
- bash-tool.ts:308（描述末句）、:313-318（inputSchema 的 run_in_background 属性）、:334+:344（bg 分支 + `runBg` 调用）、:136（`runBg` 函数）、:10+:137（`isPersistentMode` 引入与使用）、:20（注释）
- bg-entities/permission.ts:11（`isPersistentMode`）：D1 后"后台即 persistent"不再按 master-private 门控；确认无他用则删（见 §7 新增项）

**改话术（功能保留，仅去掉 flag 提法）**：
- agent-sections.ts:505（"优先直接用 `Bash(run_in_background=true)`"）→ "长命令跑满 10s 自动转后台，拿 entity_id 后靠 push / wait_for_signal"
- wait-for-signal.ts:7、:47（"你起了 bg shell（Bash run_in_background）"）→ "你起了会转后台的 bash（超 10s 自动转）"
- types.ts:74、engine/tools/index.ts:28（注释）

**不要动（另一个 feature，勿误删）**：
- agent-sections.ts:527、delegate-task-tool.ts:14 的 `delegate_task(run_in_background=true)` —— 异步 subagent，与 Bash 无关。
- 落地前 `grep -rn "run_in_background" crabot-agent/src crabot-agent/tests` 全量复核（含测试）。

---

## 7. 决策记录与实现时待确认项

### 7.1 已定决策

- **`run_in_background` flag → 删除**（不改名）。后台与否由 10s 宽限自动决定；已知长任务也吃 10s 宽限（可接受）。清理清单见 §6.1。
- **晋升后日志产出路径 → 与 persistent 完全一致**：所有命令 spawn 即写磁盘日志，单一产出路径，移除 ring buffer（见 §2.2）。
- **`wait_for_signal` 唤醒（原 §7.3）→ 已核实，升级为硬约束**：当前唤醒与 transient/persistent 焊死，D1 会打破已验证 happy path。解决方案为 §2.3 的 R1/R2 + §3.4 的 R3（唤醒语义统一）。
- **保留期 → task 完成即清名下终态实体 + 7d 兜底**（见 §4）。
- **sentinel 文件 → 随实体记录一起 GC**（见 §3.2 / §4）。
- **新增（删 run_in_background 的连带决策）**：D1 取消"persistent 仅 master 私聊"的门控（`isPersistentMode`）——**后台命令在任何 context 都 persistent**。非 master context 的 owner / 通知 key 沿用现有 `__system_<session>` 兜底（agent-handler.ts:1305-1306），`BG_ENTITY_LIMIT_PER_OWNER` 上限同样按该 key 计。

### 7.2 实现时待确认（不阻塞设计定稿）

1. **resumed-worker drain（§3.4）→ 已核实：确认是 drain-and-discard bug**（query-loop.ts:257 忽略 prompt）。修复点明确：resume 装配处（agent-handler.ts:672）drain friend 队列并拼进 `currentInitialMessages`。属本次必修项，非待定。
2. **非 master context 的 persistent 资源上限**：所有后台命令落 persistent 后，`__system_<session>` 作为 owner key 时 `BG_ENTITY_LIMIT_PER_OWNER` 是否需要分场景调参。
3. **磁盘日志增速**：高频后台命令 + "spawn 即写盘"下的磁盘占用评估（宽限期内结束即删，残留只有真后台的，理论可控，需实测）。
4. **晋升时 abort/信号竞态**：宽限定时器与子进程退出的 race（现有 `runForegroundWithGrace` 已处理 backgrounded 标志同步，晋升逻辑改写时勿引入回归）。

---

## 附录 A：重启恢复链路全景（现状，供对齐）

```
Agent 重启 → module_started(restart_count)
  │
  ├─ Admin: sweepInterruptedTasksForResume (index.ts:4698)
  │    1. 收集 in-flight 任务（executing/planning/waiting/waiting_human）
  │    2. 逐条调 resume_task RPC（非 recovery 标签）
  │         成功 → 保持 executing（agent 接管，同 task 续跑）
  │         失败 → 标 failed，进 needRecovery
  │    3. needRecovery + recovery 自身 → 标 failed
  │    4. buildRecoveryTask → 单条 recovery worker 任务（拉式自查）
  │    5. start_recovery_task RPC
  │    6. finalize_orphan_checkpoints RPC（清孤儿 checkpoint）
  │
  └─ Agent 启动:
       loadResumableCheckpoints（traces-running-<taskId>.jsonl → Map）
       loadRunningTraces（未被持有的 running trace 标 failed）
       startFlushTimer(15s)
       recoverPersistent()（bg 实体探活）  ← 本设计在此挂 reaper

内存（重启即丢）：HumanMessageQueue.pending、pendingBgNotifications、
                  async subagent 活跃态、transient shell 内存态
落盘（可恢复）：  tasks.json、per-task checkpoint、traces-running*.jsonl、
                  bgRegistry（persistent 实体）、persistent shell 磁盘日志
```

关键文件：
- Admin resume sweep：crabot-admin/src/index.ts:4698
- Recovery task 构造：crabot-admin/src/recovery-handler.ts:63
- Trace 对账兜底：crabot-admin/src/reconcile-tasks-against-traces.ts:65
- Agent resume：crabot-agent/src/unified-agent.ts:1894
- Checkpoint flush/consume：crabot-agent/src/core/trace-store.ts:123 / :159
- bg 实体恢复：crabot-agent/src/engine/bg-entities/registry.ts:152
- 唤醒队列：crabot-agent/src/agent/human-message-queue.ts、wait-for-signal.ts
