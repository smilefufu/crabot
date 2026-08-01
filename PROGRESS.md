# Crabot 项目进度

> 最后更新：2026-08-01 — Manager/Worker 拆分 P7 / PR F：builtin worker 注入通道（分支 feat/mw-p7f-builtin-injection，未合并 main）

## 2026-08-01 — Manager/Worker 拆分 P7 / PR F：builtin worker 注入通道（manager 终于能派出一个能干活的 builtin worker）

- spec：`crabot-docs/superpowers/specs/2026-08-01-builtin-worker-injection-design.md`。补的是 P4/P5 两次记录里都点名的那条阻塞项——`spawn_worker` 不传 `SpawnSpec.builtin`，而 `defaultImpl='builtin'`，**cutover 后 manager 第一次派活必挂**。
- 第 1 步（管道 + adapter 侧）：`builtinSpawnDefaults` 从无参 thunk 改成带 per-worker 上下文的工厂 `(ctx:{worker_id,workspace,origin,goal}) => SpawnSpec['builtin']`（无参签名从根上装不下 workspace/权限身份这些 spawn 时才知道的维度）；`spawnWorker` 在缺 `builtin` 且目标是 builtin 时回退调它；adapter 每次起化身（spawn/resume/fork/idle→续 burst）**现取**运行配置，per-worker 上下文落 `context.json`——builtin worker 因此**跨进程重启也能 revive**，而 LLM 连接信息始终不落盘；runEngine 补齐 `hookRegistry`（CLI 权限闸 / skill 目录 fence / git 写 fence）+ 固定权限档位 `BUILTIN_WORKER_PERMISSIONS` + 模型参数；工具集守卫在每轮 resolve 时硬断言不得出现 `set_cwd` / `set_task_goal`。
- 第 2 步（生产装配，本次）：`unified-agent.ts` 实现真实工厂 `buildBuiltinWorkerRuntime`——LLM 走与现网 worker 同一个 `model_config.powerful` slot，工具 = 内置文件/shell + skills、crab-memory（A 组）、外部 MCP、tmp-page、生图，systemPrompt = `assembleAgentPrompt`（goal 模式关）+ 一段 v3 worker 契约尾巴（工作目录固定为 workspace / 没有任何直接联系人类的工具 / `finish_task` 是唯一终态信号）。**不装**：全部 messaging、`set_cwd`、goal 相关、`delegate_task`、`todo`、`find_task`、`wait_for_signal`。
- **"现取"是这次的核心不变量**：工厂以方法引用交给 bootstrap，配置（model slot / 人格 / skills / MCP / 生图 / 时区）一律在**被调用那一刻**读 `this`；`systemPrompt`/`tools` 再各包一层 thunk，engine 每轮 turn 重新 resolve。教训来自 PR C 的 `enableFeishuDocTool`：deps 对象被长期持有，任何在装配期就地求值的东西都会永久快照。变异实测：把 model 快照进闭包 → 验收 3 用例挂。
- 权限身份用**显式常量档位**（所有 worker 同权限，干活面开、messaging/task/remote_exec/desktop 关、CLI 全 `none`），因为 `origin.creator_friend_id` 现网恒空。**PR J 的验收必须包含"worker 权限随发起人身份解析"**，否则 cutover 当天群里任何人都能让 worker 干 master 才该能干的事。这条写死，不得遗忘。
- `tests/manager/manager-integration.test.ts` 的 `BuiltinAutoConfigAdapter` 垫片**退役**：它原本包一层 adapter 在 `spec.builtin` 缺失时补配置，现在改成给 `HarnessDeps.builtinSpawnDefaults` 一个按队列出配置的工厂——同样的语义，走的是生产回退路径本身（去掉该回退，这两个场景用例立刻挂）。
- 已知能力缺口（spec 明列，不在本 PR）：**无上下文压缩**（`disableCompaction:true` 写死，长活 worker 撞窗口即 burst 失败）→ **PR F2，必须在 J 之前**；权限身份接线 → J；subagent / todo / `wait_for_signal` / `delegate_task` → 后续独立加法；builtin `readTrace` → P6。
- 验证：`crabot-agent` 全量 `2357 passed | 2 skipped`（204 文件），基线 `2348 | 2`，差值 = 新增 9，**零回归**；`tsc --noEmit` 干净；4 类变异逐个植入实测（① 去掉工厂回退 → 9 挂，含 manager-integration 两个场景；② 去掉 `hookRegistry` → 3 挂；③ 配置改回 spawn 快照 → 4 挂；④ model 快照进闭包 → 验收 3 挂）。

## 2026-07-31 — Manager/Worker 拆分 P7 / PR A：入站链路测试网（只加测试，生产代码零改动）

- 计划：`crabot-docs/superpowers/plans/2026-07-31-mw-p7-a-inbound-test-net.md`（roadmap Phase 0 PR A，阻塞项 #8）。**它是所有 P7 后续的前置**：上一条 P5 记录里那句"对入站链路做变异，全量 2216 个用例一条都没抓到"就是本 PR 要还的债——cutover（PR J）要重写的正是这条人类消息的唯一通路。
- 交付 4 个测试文件 98 例（`crabot-agent/tests/inbound/`）：`handle-message-received`（14，分流/未配置早退/lane key）、`process-direct-batch`（22，侦察 §A.2 的 8 件事 + 顺序）、`process-group-lane-batch`（34，barrier + memory 两档 fallback + 退避反馈）、`process-admin-chat-message`（28，RPC 路由 + admin chat "三不"）。**生产代码零改动**（每次变异/改写后 `git status` 核空）。
- **12 处变异逐个植入实测，全部被抓**（M12 拆成误入 lane / 误入 attention / 注入 reaction 三变体）：M1(14 挂) M2(4) M3(2) M4(4) M5(2) M6(3) M7(1) M8(2) M9(6) M10(1) M11(6) M12a(4) M12b(4) M12c(3)。**旧网基线实测：除 M11 有一条执行器层单测外，其余全部 0 命中**——群聊入站链路此前完全裸奔（删掉整条退避反馈、把 batch 合并改成只取第一条、把入站改成同步等 worker，2256 个用例一条都察觉不到）。
- **反向验证同样做了**（防止测试写成"实现的镜像"）：三类等价改写——提取局部变量（`processDirectBatch` 的 sessionId/channelId/lastMessage）、抽出纯函数 helper（memory 档位派生，跨私聊+群聊两处、穿过 M5 变异锚点）、调换无依赖语句 + 上提纯计算（`handleMessageReceived` 的两个缓存写入互换、laneKey 提到分流之前、穿过 M1 变异锚点）——三次 `tests/inbound/` 98 例**全绿**且 `tsc` 干净。网够密，同时不是刺猬。
- 手法定调（Task 1 结论，后三个 task 沿用）：**用真实构造函数 `new UnifiedAgent(roles: [])` 而不是 `Object.create(prototype)`**——分流语义的一半在构造函数的 lane/attention 接线里，造壳等于把接线抄进测试，变异就只能靠参数透传断言去抓。唯一打破"纯真实装配"的地方是 `vi.mock` 模块级 `dispatch`（LLM 入口，无实例注入口），**`executeDispatchActions` 保留真件**——M8/M11/supplement 三分支的语义恰恰长在执行器里。全链路零 `setTimeout`、零 fake timer。
- 断言落在语义不变量而非参数透传：M4/M9 的落点分别是 `getToolPermissionConfig()` 的输出与 `AttentionScheduler.getCurrentIntervalMs()` 的退避档位毫秒值（×5 / 逐级累积 / 封顶 / 出声拉回 min），M10 用 promise 闸门断"本批已返回而 worker 还在跑"，M7 在 fake dispatch 里跑真实 `prefetchQuotedMessages` 断引用原文真的取得回来。
- **`handleProcessMessage` 的 `channel` 分支证实为死代码**，按 plan **不给它写测试**：① 全仓（含 4 个 channel 仓）grep RPC `process_message`，唯一生产调用方 `crabot-admin/src/chat-manager.ts:220` 固定传 `source_type:'admin_chat'`；② `setPendingRequest` 全仓无调用方 → `:1588` 取代检查恒真 → 该分支即使被调用也永远空转返回。已连同 `SessionManager.setPendingRequest/getPendingRequest`、`assembleFrontContext` 的死形参 `_memoryPermissions` 一起记入 **PR L 退役清单**（`.superpowers/sdd/progress.md`）。
- **发现但未修的生产问题 O1–O8**（本 PR 只加测试，不修；台账在 `.superpowers/sdd/progress.md`）：O1 群聊两条早退与 catch 都不调 `reportResult`（`!sdkEnvWorker` 早退还漏 `clearAllBarriers`）；O2 `setPendingRequest` 无调用方；O3 admin chat 的 `!sdkEnvWorker` 早退不发 `chat_callback`（Master Chat 界面静默卡住）；O4 `currentResolvedPerms` 并发 race（作者已自标）；O5 `tests/manager/events.test.ts` 是新发现的 flaky；O6 `assembleFrontContext` 第三参完全没用；O7 `AttentionScheduler.reportResult` 无条件 `scheduleCheck` 覆盖已有 timer → 泄漏的旧 timer 先触发、退避被绕过、`stopAll` 也清不掉；O8 群聊路径从不 `updateLastMessageTime` → `get_status` 的活跃会话数永不含群聊。
- 验证：`crabot-agent` 全量 `2318 passed | 2 skipped`（203 文件），基线（新文件移出实测）`2290 | 2`（202 文件），差值 = 新增 28，**零回归**；`tsc --noEmit` 干净；`tests/inbound/` 98 例连跑 3 次全绿。已知 flaky（判定变异命中前必须单跑复核）：`tests/engine/bg-entities/*`、`tests/manager/events.test.ts`、`harness-integration` 的 tmux 用例。

## 2026-07-31 — Manager/Worker 拆分 P5：scheduler 路由与 Admin 只读代理（生产链路仍未切换）

- 计划：`crabot-docs/superpowers/plans/2026-07-31-mw-p5-scheduler-readmodel.md`。交付 protocol-agent-v3 §8.2/§8.3/§9.2/§10.3：agent 侧 `trigger_schedule` + 读模型四件套 RPC、`agent.task_status_changed` 事件、manager 栈的**生产装配点**；admin 侧只**新增** `/api/agent/workers*` 四个只读 REST 端点。
- **与 roadmap 的一处有意偏离**：roadmap P5 原写"admin 侧改调用点"，本阶段**不改**——切过去会让 scheduled 任务走 manager 而人类消息仍走 dispatcher，构成 spec 明确排除的混合运行态，且 P7 两个阻塞项会在这条路上产生用户可见错误。调用点切换与 SYSTEM_SESSION 哨兵退役一并移入 P7 cutover。
- 六个 task：① `manager/bootstrap.ts` 栈装配（严格照 harness 四步接线契约，O(1) 纯构造、启动路径不探测子进程/不扫盘）；② `manager/events.ts` 对外事件（harness 化身级事件 → 任务级事件的翻译与去重）；③ `manager/read-model.ts` 读模型纯逻辑（过滤/排序/分页，`updated_at desc` + `worker_id asc` 兜底，越界返空不报错）；④ `unified-agent.ts` 五个 RPC handler（`trigger_schedule` 写成同步方法，"受理即返回"体现在签名上；权限身份经 WakeEvent 下传到 `origin.creator_friend_id`）；⑤ admin 先抽 `proxyAgentRpc` 样板再加四个端点（抽之前先写 11 条特征化用例钉住既有 4 个 `/api/agent/*`）；⑥ 启动接线 + 集成测试 + 零现网影响自证。
- **评审拦下并根治的一个缺陷**：事件发布方原来现读台账取 `new_status`，而 `LedgerStore.findWorker` 不进互斥锁——读晚于下一次落账就把中间状态整条吞掉，PoC 里终态 `completed` 一次都没发出去（cutover 后表现为"任务永远显示 running"）。根治 = `HarnessEvent` 自带落账后的 `task_status`（23 个调用点逐个分类：8 个 task 级迁移点带、15 个化身级/纯记录点不带），缺字段退回现读台账而不是跳过（跳过会把"缺字段"变成新的静默丢事件路径）。
- 启动接线的三个决定（Task 6）：装配放**构造函数**（RPC 一旦注册，取件口就必须就绪）；启动对账放 `onStart()` 里**不 await**、失败仅 warn（对账要逐个问 adapter 化身死活，会起子进程，启动不能挂在它上面；空台账开销 = 一次 ENOENT readdir + 一次 `mkdir -p ledgers` + 一次空 readdir）；LLM 解析放 thunk 里（§11 `manager ?? powerful`）——**现网此刻并没有配 manager slot，放装配期解析会让 agent 直接起不来**，放 thunk 最坏只是某次路由在 episode 内抛错被 catch，读模型四件套照常可用。
- **P7 cutover 前必须补的四项**（前两项 P4 已记，后两项 P5 新增）：① `processStateChange` 对自然结束硬编码 `endReason='completed'`，失败 worker 的 `task.status` 失真，读模型的 status 在修掉前不可信；② `spawn_worker` 不传 `SpawnSpec.builtin`，而 bootstrap 的 `defaultImpl='builtin'`，manager 第一次走缺省派工必挂；③ `dialogObjectIdFor` 目前一律派生成 `group:<channel>:<session>`——私聊按 `friend:<id>` 跨 channel 聚合需要 admin 的 friend 解析，而该依赖是同步签名、agent 侧唯一知情处是入站链路（P5 明令零改动）；④ admin 调用点切到 `trigger_schedule` 时，`last_task_id` 与 `admin.schedule_triggered` 载荷需改造（`{accepted:true}` 不回 task_id）。
- **零现网影响自证**（逐条实证，非"看起来干净"）：`unified-agent.ts` 相对 base 只有一行删除（`data-paths` 那行 import 加了个 `getDataRootDir`），`handleMessageReceived`/`processDirectBatch`/`processGroupLaneBatch`/`handleProcessMessage` 四个入站函数体与 base **逐字节相同**；`crab-messaging.ts`/`agent-handler.ts`/`engine/**`/`orchestration/**`/`dispatcher/**` 零改动；admin 的 `upsertTask`/`applyStatusTransition`/`runReconciliation`/`handleCancelTask` 函数体逐字节相同（只多了 JSDoc 弃用注记）；admin scheduler 调用点仍是 `create_task_from_schedule`，全仓无任何生产调用方引用 `trigger_schedule`。
- **一条不能回避的坦白**：对入站链路做的变异（改坏群聊分流、改坏 batch 合并）**全量测试一条都没抓到**——`unified-agent.ts` 的入站链路目前几乎没有直接单测（`tests/agent/unified-loop-private.test.ts` 只断言方法存在）。所以"入站链路未受影响"这个结论**只由 diff 证据支撑，不由测试支撑**；P7 cutover 真要改这条链路时，必须先补覆盖。
- 验证：`crabot-agent` 196 files / 2216 passed | 2 skipped（基线 2209 + 本次集成 8 - 1 已知 flaky `bg-entities/trace.test.ts`，单跑 50 全绿）；`crabot-admin` 122 files / 1068 tests 全绿；两侧 `tsc --noEmit` 干净；`tmux ls` 无新增会话、`/tmp` 无残留。

## 2026-07-30 — Manager/Worker 拆分 P4：manager loop（纯新增未激活）

- 背景：P1-P3（PR #47/#48/#49）交付 worker 侧契约/tmux 驱动/CLI adapter/台账与 harness。P4 在此之上补 manager 侧：`ManagerLoop` episode 生命周期、缓存感知增量压缩、封闭工具面、`ManagerRegistry` 唤醒路由——协议 protocol-agent-v3.md §4 全量落地，仍是纯新增未激活（`ManagerRegistry.routeXxx` 未接入任何真实入站链路，人类消息/群聊注意力/worker 事件/scheduled 触发目前仍全部流向 `unified-agent.ts` 既有路径；`inbound-adapters.ts` 三个纯函数已备好但故意不接线，接线是 P7 cutover 的工作）。
- 10 个 task 交付：① manager session 持久化（`ManagerSessionStore`，tmp+rename 原子落盘）；② 缓存感知增量压缩（`decideCompaction`/`foldIntoSummary`，唤醒边界折叠 + 热态强压兜底）；③ crabot-info 六件套只读方法（含递归掩码补 headers/env 容器）；④ worker 六件套工具集（`spawn_worker`/`send_to_worker`/`query_worker`/`read_worker_output`/`list_workers`/`kill_worker`，`query_worker` 定案字面 fire-and-forget + `onAsyncError` 留口）；⑤ 封闭工具面装配（messaging 白名单 + intent 去除、运行时护栏 `assertClosedToolFace`）；⑥ manager prompt 装配；⑦ `ManagerLoop` episode 生命周期（唤醒→跑一轮 runEngine→回睡，mid-episode 注入、episode 失败不消费邮箱、max_tokens 强制折叠兜底）；⑧ `ManagerRegistry` 与三类唤醒路由（人类消息/worker 事件/scheduled，`SYSTEM_TASKS_MANAGER_KEY` 系统线程）+ `onAsyncError` 接线（`activeEpisodes` 引用计数消除 split-brain）；⑨ manager model slot（`model_config.manager ?? powerful`，admin 侧 additive）；⑩ 本任务：端到端集成测试 + PROGRESS 记录。
- 评审沉淀的关键缺陷（均已修复，见对应 commit）：`query_worker` 从"await 到底"改字面 fire-and-forget 避免阻塞 manager turn；`adapter.fork` 挪出 per-worker 锁外，三段式锁（判定→慢调用→落账）应对"锁释放期间世界会变"；fork 落账取 adapter 真实状态并补发结束事件，修复三段式锁引入的回调丢弃；episode 失败时 mid-episode 注入的事件不再丢失、max_tokens 重试带上注入内容；`ManagerRegistry.activeEpisodes` 从布尔/Set 改引用计数，消除同 key 并发唤醒下的 split-brain（第一个 episode resolve 时错误抹掉第二个仍在跑的标记，导致 evictIdle 误回收、新建 loop 与旧实例并发读写同一份 session 记录）。
- **Task 10 端到端集成测试发现的真实缺口（非本次修复范围，记录供 P7/近期跟进）**：
  1. **`WorkerHarness.processStateChange`（P3 既有代码）无法区分 finish_task 的 completed/failed**：`WorkerAdapter.onStateChange` 回调接口只带 `(handle, state)` 三态，没有 endReason 通道；harness 在"化身自然结束"这条被动回调路径上硬编码 `endReason='completed'`，导致 worker 通过 `finish_task(outcome='failed')` 报告失败时，`task.status`/`incarnation.ended_reason` 仍落 `'completed'`（worker 自己的 meta.json 记的是对的，真值在 onStateChange 这一跳丢失）。经真实 `WorkerHarness.spawnWorker` + 真实 `BuiltinWorkerAdapter` 直接复现确认，harness-integration.test.ts（P3）早有一句注释提到"outcome 字段留空"但没意识到 task.status 本身也受影响。manager 目前只能靠读 worker 输出文本判断成败，结构化终态信号失真——修复需要扩展 `WorkerAdapter.onStateChange` 签名或另开一条回传通道，涉及 P3 既定契约，需要单独 spec。
  2. **`spawn_worker` 工具当前无法让 `impl='builtin'` 的化身真正跑起来**：`worker-tools.ts` 的 `spawn_worker` 调 `harness.spawnWorker(...)` 时不传 `SpawnSpec.builtin`（worker 的 LLM adapter/model/systemPrompt/tools 注入）；该字段目前只有 `harness.handoffIncarnation` 经 `HarnessDeps.builtinSpawnDefaults` 消费。manager 若让 LLM 选 `impl='builtin'` 派工，`BuiltinWorkerAdapter.spawn` 会直接抛 `spec.builtin missing`。P4 阶段 manager 侧还没有"builtin worker 该用哪个 LLM"的配置解析入口，大概率是 P7 cutover 要补的一块。集成测试用测试专用 `BuiltinAutoConfigAdapter`（不改生产代码）包一层兜底验证其余链路。
- P7 cutover 待办清单（本次未做，留给 cutover 任务）：`inbound-adapters.ts` 三个纯函数接入 `SessionLaneRegistry`/`AttentionScheduler`/`WorkerHarness.onEvent`；上面两条真实缺口的修复（onStateChange 回传真实 endReason、spawn_worker 的 builtin LLM 配置解析入口）；代发注记（§4.2 跨 manager 写）；trace/UI（P6 范围）；legacy import 与 `intent` schema 彻底清理；goal 模式（worker 侧，P3 已定，manager 侧未涉及）。
- 验证：`manager-integration.test.ts` 新增 4 场景（私聊派活全链路含两个 episode、系统任务线程成功留本线程/失败转 `send_master_private`、跨 TTL 折叠恰一次、`capabilities().fork===false` 经真实 `harness.queryWorker` 触发 `onAsyncError`）；`crabot-agent` 全量 192 files / 2118 tests 全绿（`tsc --noEmit` 干净，但 tests 目录仍不在 tsconfig `include` 内，P3 已知限制未变）；`crabot-admin` 全量 1041/1042（唯一失败 `v1-cleanup.test.ts` 是既有失败，与本次 diff 无关）；`tsc --noEmit` 两侧均干净；`tmux ls`/`/tmp` 均无残留。零现网影响自证：`unified-agent.ts`/`agent-handler.ts`/`mcp/crab-messaging.ts`/`engine/**` 相对 main 零改动；`workers/**` 只改 `harness.ts`（P4 Task 4/8 授权范围内）+ `ledger-store.ts`（两个函数改 export）+ `worker-events.ts`（新增 `query_failed` kind）；`crabot-admin/src/**` 只有两处 additive（`agent-manager.ts` manager model slot、`chat-manager.ts` 放开 `system-tasks` 白名单）+ `types.ts` 一行 `ModelRole` 扩展。

## 2026-07-30 — codex adapter 真机校准（部署机 m2，codex-cli 0.144.1）

- 背景：P2 的 codex adapter 是"照文档/源码实现"，8 项待真机校准。本次在部署机 m2 上用隔离 `CODEX_HOME` 探针实测（不动生产实例与用户 `~/.codex`，探针目录已清理）。
- 修复四项：① session 发现优先读 rollout 首行的 `session_meta.payload.session_id`（权威）而非文件名解析；② nvm 部署陷阱——codex 常是 nvm 装的 node 脚本，adapter 经 tmux 拉起时须把 codex 二进制所在目录前置进 PATH，否则必报 `env: node: No such file or directory`（实测踩到），`detect()` 也区分"没装"与"装了但 node 不可解析"；③ 交互态命令参数校正（见下）；④ `readTrace` 按真实 rollout 结构校准（统一信封 `{type,timestamp,payload}`，五类 type，消息在 `response_item` 按 `payload.role` 分、assistant 用 `output_text`）。
- **一次自我纠错**：中途误把 `codex exec` 路径的实测结论（`--skip-git-repo-check`、选项顺序）套用到 adapter 实际驱动的交互式顶层命令，给 spawn/resume 加了顶层不存在的 flag——那会让真机 100% usage 错误退出，比修之前更糟。评审拦下后回 m2 用 `--help` 确证顶层选项清单，改为不传该 flag、并用 config.toml 的 `[projects."<path>"] trust_level = "trusted"` 授信 workspace。
- 另一次纠错：曾据 `codex fork` 子命令存在而宣称"P2 判错了"，实测证明 `exec resume` 无论加不加 `--ephemeral` 都是续写原会话（rollout 持续增长、总数不变），codex 确无 headless fork——`capabilities().fork = false` 与协议表述原本就正确。
- 协议同步：§6.1 新增"codex 的 session 发现是限时轮询"已知限制（超时退化占位 id 会使该化身 resume/readTrace 不可用）。
- 验证：tests/workers 349 用例全绿、tsc 干净。

## 2026-07-29 — Manager/Worker 拆分 P3：台账与 harness

- P2（PR #48）当日两轮 review 后合并。P3 交付（纯新增未激活）：worker 台账（每对话对象一文件 + 互斥 + 跨文件 worker_id 索引）、v3 精简 task 状态机（从 admin 移植纯函数 + reviveTask 受控出口）、worker 事件流与原生 session 收割、workspace 管理（realpath 边界防串台）、信箱与安全态投递（in-flight 语义）、`WorkerHarness` 编排（spawn/send/read/list/kill/query + 状态回调路由）、透明接续（revive / handoff / switchWorkerImpl）、重启对账与监护移交。tests/workers 326 用例（P2 末 179 → P3 末 326）。
- 协议同步三次：`Incarnation.forked_from` + `IncarnationHandle.session_ref`（1f65202）、§5.2 接续例外 + §6.1 seq 已知限制（cb47a4f）。
- 评审沉淀（10 个 task + 全分支终审，多轮 PoC 实证）：fork 化身劫持主线、drain 与 in-flight 双投、workspace 软链绕过、revive 不回填旧化身终态、handoff 死结、主线守卫漏 impl、kill 与 in-flight 竞态复活 cancelled——均已修复并有回归测试；顺带修掉 cc/codex `state()` 无 runtime 时不探活（曾使"tmux worker 存活→重连接管"对 CLI worker 失效）。
- 已知限制（入协议或执行记录）：化身 seq 非跨实例全局唯一（(impl,seq) 末条匹配已缓解）、`isAlive=true` 时 state 精度限于 meta 快照、tsconfig 排除 tests 致测试从未被类型检查（另开小 PR）。

## 2026-07-29 — Manager/Worker 拆分 P1 + P2（均已合并，PR #47 / #48）

> 已被 P3–P5 覆盖，压缩保留；细节见 `crabot-docs/superpowers/plans/2026-07-28-manager-worker-split-roadmap.md` 与同目录执行记录。

- 立项背景：架构 spec `crabot-docs/superpowers/specs/2026-07-28-manager-worker-agent-split-design.md`；协议落地 protocol-agent-v3（v2 标记 Superseded，admin task 域退役为读模型，TaskStatus 精简，crab-messaging 收窄为 manager 持有）。
- P1（纯新增未激活，47 用例）：`crabot-agent/src/workers/` worker 契约类型、append-only session 树（取代 ResumeCheckpoint 方向）、OutputLog 游标增量读、builtin adapter burst 状态机、可复用契约一致性套件。评审沉淀：四轮并发竞态修复 + resume 幂等提交次序。
- P2（纯新增未激活，163 用例）：tmux 驱动层、CLI hook 事件文件通道（纯 POSIX printf + fs.watch，无 HTTP 端点）、provision 物化基建、claude-code adapter、codex adapter。评审沉淀：cc adapter 两处锁纪律回归、session_ref 注入（UUID 校验 + shQuote 双层）、codex auth.json 0600。codex adapter 的真机校准见 2026-07-30 条目。

## 2026-07-27 — 任务终态与 worker 生命周期对齐（issue #43 下半）

- 现象：任务被 admin 判 failed 后，worker 仍在发消息（"还在等你回复……"），随后 `failed → executing` / `failed → completed` 被状态机拒绝。
- 根因：**admin 是 task 状态的 SSOT，但 worker loop 活在 agent 进程里，改 tasks.json 不会让挂起的 loop 消失**。worker 调 ask_human 后 park 在自己的 24h barrier 上；barrier 到点**自己醒来**继续跑，而 admin 的 24h 超时 + 5min 扫描最多晚 5 分钟才判死——两个独立计时器互不通知，且顺序恰好反了。`crab-messaging.ts` 的常量注释证明作者预见了这个竞态（"barrier 先 timeout 但 admin 还没切 failed，worker 假醒空跑"），但把两个 24h 设成相等、漏算了扫描周期，导致"假醒"稳定发生而非偶发。
- 不变量（本次确立）：**task 非终态 ⟺ worker 活着**。本 bug 与 2026-06-05 orphan bug（worker 死了但 task 卡 waiting_human）是同一不变量的正反两个方向；当年选方案 C（24h 超时兜底）只堵反向，顺手制造了正向。
- 决策（与 master 逐条确认，未写独立 spec）：
  1. **abort 失败仍落 failed** + agent 侧自检兜底。理由：agent 不可达时不落终态 = orphan bug 复现，比窄窗口内多发一条消息更糟。
  2. **只做正向**，反向不动。反向已有 24h 超时兜底，且修好正向后这条兜底自己也会走 abort（worker 已不存在，no-op），语义闭合；期间人类回复走 pushSupplement 失败 → 降级 new_task，不丢消息。
  3. **三条判死路径统一入口**（超时扫描 / 重启 sweep / trace 对账），顺带接上人类 `cancel_task`——`handleCancelTask` 里"in-flight 取消应通知 worker"的旧 TODO 在此了结（agent 侧 `cancel_task` RPC 早就备好，admin 从来没调过，是半条链路）。
  4. **spec 2026-05-14 §3.6 的"超时推 system supplement 让 worker 收尾"作废**。它自相矛盾（failed 是无出边终态，收尾写不回状态），且"抢救 24h 上下文"的价值已被 revive 机制取代——`revive_task_for_supplement` + checkpoint resume 能原样恢复 messages + prompt cache 前缀（checkpoint 是 per-turn 落盘的，parked worker 的上下文已在盘上）。
  5. 复用审查：`cancelTask` 带取消语义，抽出无场景语义的 `abortWorker(taskId, reason)`，cancel / timeout / sweep / 对账各自组装状态语义后调它。
- 三道防线：① admin 判死前主动 `abort_worker`；② `ASK_HUMAN_BARRIER_TIMEOUT_MS` 24h → 24h+15min（> admin 24h + 5min 扫描周期），保证 admin 必然先判死；③ barrier 真超时自醒时 `abortIfTaskTerminal` 查一次状态，已终态则静默 abort（admin 不可达时 fail-open，不误杀）。
- 协议：protocol-agent-v2 新增 §3.6.1 `abort_worker`；protocol-admin 状态机段补「终态与 worker 生命周期」不变量；spec 2026-05-14 §3.6 加修订说明。
- 验证：新增 admin 4 条（cancel/超时各自 abort、abort 失败仍落 failed、worker 自报终态不 abort）+ agent 8 条（abortWorker 返回值与委托、终态兜底三态、barrier onTimeout 触发与不误触发）；admin 全量 1036 通过，agent 全量 1640/1641（唯一失败是并行满载下的 bg shell flake——两次跑失败的是不同文件，干净树同样复现过 2 条，单跑 25 条全绿）。

## 2026-07-27 — release 包漏打 builtins skill 载荷（issue #43 上半）

- 现象（用户 v2026.7.14 system mode）：内置每小时 memory_curate 日程报 `Skill not found: memory-curate`，Available skills 只剩 4 个 superpowers；模型自行降级后每轮调 `send_master_private` 私聊 Master。
- 根因：`release.yml` 打包 `--exclude='*.md'` 只给 `crabot-admin/builtin-skills/` 开了 include 白名单，`crabot-admin/builtins/skills/` 下 24 个 md（6 个 SKILL.md + crabot-cli/scrapling 的 references）全被剔掉——目录还在、内容没了，`SkillManager.registerBuiltins` 逐个 `continue` 且一条日志不打。Unix/Windows 两条打包路径同病。丢的不止 memory-curate：daily-reflection、memory-graph-linking、crabot-cli、tmp-page、scrapling 全缺（dev 跑源码永远复现不了）。
- 审计：按 release.yml 规则本地重放打包并与源码求差集，除上述 24 个 md 外无第二处运行时资源被误删（dist 产物、memory 的 schema_version/uv.lock/config、各模块 crabot-module.yaml、panic-monitor 的 py/sh 均在包内）；顺带发现根 LICENSE 没进包（Apache-2.0 分发合规），一并补上。
- 修复：① Unix rsync 加 `builtins/**` include，Windows 清理豁免改 `(builtin-skills|builtins)`；② 新增 `.github/scripts/verify-release-payload.mjs`，打包前比对源码 skill 载荷与 staging，缺任一文件即 fail（对旧规则重放确认能拦下这 24 个）；③ `registerBuiltins` 返回注册数并对"目录不可读 / 子目录缺 SKILL.md / 一个都没扫到"打 error，Admin 启动打印注册数量，不再静默。
- 验证：新增 `crabot-admin/tests/builtin-skills-registration.test.ts` 4 条（正常注册 / 目录缺失 / 空壳目录 / 仓库载荷全量可注册）；admin 全量 1032 通过；agent skill 契约 21 条通过。升级路径无需迁移——`extractRelease` 整目录替换，老实例升级后 registerBuiltins 自动补注册。
- issue #43 下半：worker 生命周期竞态已由上面那条（PR #46）修复。**仍未做**：内部维护任务的外发边界（`external_output: forbidden` 之类系统级约束，而非靠 prompt）、skill 缺失时 fail closed——两者都与已确认 spec 2026-07-11 的工具矩阵冲突，要动得先改协议；先观察本次打包修复上线后 memory_curate 是否还私聊 Master（skill 在位时其 SKILL.md 明写"不汇报 master"）。

> 最后更新：2026-07-26 — wechat 入站文件超时降级按需补取（PR #44）

## 2026-07-26 — wechat 入站文件超时降级按需补取（PR #44）

- 起因：wechat 大文件（如改名视频 video1.docx）触发 connector 60s down_file 超时降级，emit 仅含 file_name/file_size；crabot 不登记 handle，agent 无下载途径只能反复请用户重发（重发再超时死循环）。实际上迟到的 ack 已把 file_url 写进 connector 消息记录，bot 凭 `GET /api/v1/bot/messages/:id` 可查到。
- 方案（拉模型，connector 零改动）：降级文件消息也登记 handle（credential `{message_id}`），`fetch_media` 时重查 connector 拿迟到 file_url 并回写 credential+size；正常链路 credential 扩展为 `{url, message_id}`，旧存量 `{url}` 兼容无迁移。shared 层 `MediaFetchManager` 同步下载路径 try/catch（异常 message 变 failed.error 透达 LLM）+ `MediaHandleStore.update`。
- spec：`crabot-docs/superpowers/specs/2026-07-26-wechat-inbound-file-timeout-refetch-design.md`（含 §5.4 勘误：feishu drive 已用 throw 传错误，呈现从 RPC 异常变 failed 结果，测试断言同步对齐）。
- 验证：shared 96 / wechat 62 / feishu 239 / agent media-resolver 定向 7 全通过；telegram 唯一失败为既有 reaction emoji 断言漂移（与本次无关）。@claude review APPROVED 无行内意见，自动 squash 合并。
- 二期候选：connector 增加重触发 down_file 的 bot API，覆盖"puppet 下载真失败（ack 永不回）"场景；届时 crabot 重查无果后可主动触发重下。

## 2026-07-21 — crabot-agent token 使用效率优化（对标 Pi agent）

- 起因：对比开源 Pi agent（极简 prompt + 4 工具 + 输出硬截断 + prompt caching）后，发现 crabot-agent 五个差距：Anthropic 无 cache_control、工具输出截断宽松且不可恢复、compaction 用 chars/4 低估、工具盘臃肿、prompt 冗余。
- spec：`crabot-docs/superpowers/specs/2026-07-21-agent-token-efficiency-design.md`（含 §10 实施偏离记录）。
- 实现（5 项）：
  1. anthropic-adapter 注入 3 处 cache breakpoint（system 末块 / 末 tool / 末消息末块，5min ephemeral）；顺带清理空 text block 垃圾 token。
  2. bash 截断 100K→50K 改纯尾部 + 完整输出落盘 `data/tmp/tool-outputs/` 可恢复；read 解除 500KB 后不可读限制（流式分页全覆盖，单次 ≤50KB）；编排层兜底 256KB→100KB。
  3. compaction 触发改用 API 真实 usage（lastObservedContextTokens + 增量估算），usage 缺失回退估算且计入 system+tools；context_window 从 admin buildConnectionInfo → agent → EngineOptions 全链路接线。
  4. delegate_task 的 when_to_use 截断 300 字符；memory 工具按任务类型分组（普通任务 A 组 6 个 / daily_reflection 全量 18 个，对齐 protocol-memory §3.30）；disabled_tools 扩展到 MCP 工具（仅黑名单，enabled_tools 不套 MCP）。
  5. scene profile 去除 system prompt 侧的重复注入（保留 task message 单次注入）。
- 协议：protocol-admin §3.19.8（context_window）+ BuiltinToolConfig 小节（disabled_tools 覆盖 MCP）；protocol-memory §3.30（工具分组）；base-protocol §5.14 / protocol-agent-v2 补 context_window 字段。
- 验证：agent 全量 1590/1591（唯一失败为 7-17 已记录的 context-assembler 固定时间漂移，HEAD 复现确认与本次无关）；admin 全量 1013 通过（schedule-target-session 的 EADDRINUSE 为并行跑套件的环境 flake，单跑 6/6 通过）。
- 自审修复（2026-07-21 当天第二轮）：4 路并行 diff review 后修复 6 项——①memory 分组放宽为按任务用途（memory_curate + tags memory_rebuild，原条件会废掉内置每小时记忆整理和重建图谱端点；顺带打通 start_task RPC 的 tags/task_type 透传链路）；②bash 截断 char→byte 口径（CJK 输出下原实现会让编排层 100KB 兜底切掉尾部 hint）；③disabled_tools 覆盖 subagent/audit 继承路径；④anthropic adapter 丢弃空 content 消息；⑤补落盘失败回退测试 + read offset 归一化；⑥delegate_task 截断 surrogate 安全。修复后 agent 全量 1607/1608（仍只有那个既有时间漂移）。
- **待办**：部署对比（cache_read 比例、bash/read 大输出场景体积）待上线后进行；**reasoning effort 配置开放**（k3 支持 low/high/max，协议无对应字段）留作 follow-up 单开 spec。
- moonshot 实测后续（2026-07-21 当天完成）：401 根因是内置 kimi-coding preset 端点错误（`api.moonshot.cn/anthropic` 是平台 key 端点，Coding Plan key 走 `api.kimi.com/coding`），preset-vendors.ts 已修正。实测 `https://api.kimi.com/coding/v1/messages`：接受 `cache_control` 无 400；且该端点**自带自动前缀缓存**——不带 cache_control 的相同请求第二次也 100% cache_read，故改动1 对 kimi 端点是兼容增强、对官方 Anthropic 端点才是必需。注意：已部署实例 model_providers.json 里存的旧端点不会随 preset 自动更新，需在 Admin UI 手动改 provider endpoint。
- kimi-coding preset 模型改走接口（2026-07-21 follow-up）：`GET /v1/models` 实测可用（x-api-key / Bearer 均可，返回 kimi-for-coding / kimi-for-coding-highspeed / k3）；preset 加 `models_api: '/v1/models'` 并删除 KIMI_CODING_MODELS 内置列表（失败无兜底即清空，与 openai/deepseek 等 preset 一致）；`parseOpenAIModels` 新增 `supports_image_in` → supports_vision 映射（内置原写 false，实测三模型均支持视觉）。已知：`kimi-k2.7-code` 是可用别名但不在接口返回中，旧 provider 里引用它的 slot 在 refresh 后会变成未知模型，需要重新选择。

> 最后更新：2026-07-20 — 任务权限热刷新（supplement / resume 即时生效）

## 2026-07-20 — 任务权限热刷新（supplement / resume 即时生效）

- 起因：群任务内 agent 要求人类改 `cli_access.provider`，人类在 Admin 改完（落盘正确）并回复"改好了"，worker 仍持任务创建时的冻结快照报 `none`；重启也无效——resume 从 checkpoint `worker_context` 原样还原旧权限。只能开新任务才能拿到新权限。
- 方案（spec 方案 A）：在两个"人类刚做过事"的边界用任务**原发起人身份**重新解析——① supplement 送达任务前（私聊/群聊/admin-chat/RPC 四个 `deliverHumanResponse` 入口）；② 从 checkpoint resume 时。每轮轮询与 admin 事件推送两个方案均否决（成本/故障面 vs 边际收益）。
- 实现：`resolved_permissions` 从闭包冻结值改为 `taskState.resolvedPermissions` 活持有者（`agent-handler.ts`，同 `taskState.cwd` 模式）；engine/hook 链路新增 `getResolvedPermissions` getter（`engine/types.ts` → `query-loop.ts` → `hook-executor.ts` → cli-permission-gate），工具过滤与 CLI 闸每轮读活值；`updateTaskPermissions` 同步刷新 `resumeWorkerContext` 让 checkpoint 落"最近已知"。fail-soft：解析失败/admin 不可达保留任务当前权限，绝不降级 FAIL_CLOSED；放宽与收紧对称生效。
- 协议：protocol-admin §3.2.7 语义新增第 4 条（任务级刷新时机 + 必须用原 `sender_friend_id`，防止群成员中途注入自己的权限）。
- spec：`crabot-docs/superpowers/specs/2026-07-20-task-permission-hot-refresh-design.md`。
- 验证：新增 `task-permission-hot-refresh.test.ts` 10 条（持有者初始化/热替换/原身份/隔离/resume 覆盖与回退）+ cli-permission-gate getter 优先级 4 条；agent 全量 1558/1559（另 2 skipped），唯一失败为 7-17 已记录的 context-assembler 固定时间漂移（主仓库同样失败，与本次 diff 无关）。

## 2026-07-19 — Agent 专用 Python 环境（agent-venv）

- 背景：install.sh 装的 uv 只服务 memory 模块（`uv sync`），从未接入 agent shell 环境。trace 证实 agent 直接用系统 `python3` 并 `pip3 install` 污染系统 site-packages / user site；生产非登录 shell 下 uv 甚至不在 PATH。
- 方案（spec 方案 B）：MM 启动时懒创建 `$DATA_DIR/agent-venv`（`uv venv --seed`，缺失/损坏自愈），并把 `<venv>/bin` 前置进 `process.env.PATH`，经 spawn 的 `...process.env` 透传给全部子模块。单一代码路径覆盖 dev / user / system 三模式；install.sh 零改动；uv 不可用或创建失败仅 warn 降级，不阻塞启动。
- 实现：新增 `crabot-core/src/agent-venv.ts`（`ensureAgentVenv()`），`crabot-core/src/main.ts` 接入；`--seed` 必须带（uv venv 默认不装 pip）。
- spec：`crabot-docs/superpowers/specs/2026-07-19-agent-python-venv-design.md`；AGENTS.md「开发环境」与 deployment/installation.md 已同步。
- 验证：crabot-core 新增 5 个定向测试 + 全量 79 个通过；tsc build 通过；真实 uv 端到端验证（临时 DATA_DIR 建 venv、PATH 前置、venv 内 python3/pip3 可用）。生产/user mode 的完整验收（`which python3` 落到 venv）待实例下次重启后自然生效。

## 2026-07-19 — subagent 模型配置热生效（delegate 时实时解析）

- 起因：m2u 实例 cost_effective provider 余额耗尽（HTTP 402），Admin 改 slot 后"继续任务"仍用旧 provider，必须重启实例才生效。根因：worker loop 启动时固化 subAgentsSnapshot，delegate_task 闭包绑定快照里嵌入的 model 连接信息，热更只影响"下一个 loop"。
- spec：`crabot-docs/superpowers/specs/2026-07-19-subagent-model-hot-reload-design.md`。方案：subagent **列表**保持 loop 级快照（工具 enum / prompt 一致性不变），列表内各项的 model 等配置在每次派发时从 live `this.subAgents` 按 name 重查；live 中已删除则回退快照。
- 实现：`agent-handler.ts` 新增 `resolveLiveSubAgent`，接入 `makeRunSubAgent` 闭包（同步/异步 delegate 共用）与 goal_audit `buildSpawnDeps`；`runGoalAudit` 本就实时读 `this.subAgents` 无需改。主 adapter 与已 spawn 的持久 subagent 保持 loop/spawn 级快照（协议已写明，要立即生效则终止重派）。
- 协议：protocol-agent-v2 §6.1 热更表把 model_config 拆成三种粒度（worker 主 adapter / subagent 派发 / 已 spawn subagent）；protocol-admin §3.19.6 补上"保存后触发 pushConfigToAgentModules"约定。
- 验证：新增 `delegate-model-hot-reload.test.ts` 4 条（in-flight 派发用新 endpoint/apikey/model_id、enum 快照不变、删除回退、异步派发与 goal_audit 取 live）；agent 全量 1543/1544（另 2 skipped），唯一失败为 7-17 已记录的 context-assembler 固定时间漂移，stash 验证与本次 diff 无关。

## 2026-07-18 — 复活 vs new_task 决策优化（价值关 + 体积关）

- 背景：复活机制（06-29 上线）后出现"无限续杯"——续跑完成刷新 `completed_at`，24h 候选窗口滑动，候选资格永久续期。问题框定为"每条消息到来时该复活还是 new_task"的决策质量，而非候选出局规则；已排除次数上限、worker 自纠正、successor、复活时压缩等方案。
- 价值关（dispatcher）：supplement 判据从"消息形态像补充"改为"处理新消息是否需要旧 task 上下文/结果"；拿不准偏向 new_task；failed 候选"继续/再跑一次"仍判 supplement。新增 recent terminal 候选段渲染，但只含处置信息（task_id+status+completed_at+失败原因），不含标题/进度——任务身份交给 07-12 设计的消息归因（task="..."）。
- 上线后复盘追加（同日，经真实 LLM 重放验证）：归因优先规则（关联判断以 task= 归因消息内容为准，无归因词面重叠不构成依据）+ 活跃/terminal 两段列表降注（"只提供 id 与状态，不代表任务内容"）+ 旧工作指引（指代"很久以前"且可见 task 归因消息未涉及 → new_task）。复盘案例（alpha 词面冲突）经 6 次重放两轮规则均未改判，确认为可见信息下的边界案例；dispatcher 旧 task 检索留作后续方向。
- 体积关（executor）：`canResumeTask` 预检查在 terminal_supplement 模式下估算 checkpoint messages，≥ 200k×0.8（复用现有常量，无新配置）→ `checkpoint_too_large(est≈…)` fallback，admin 状态不被触碰，直接降级 new_task；二元判定，不存在"压缩后复活"。restart 模式不受门禁影响。
- trace：revive fallback span 新增 `fallback_reason`，体积降级可诊断。
- spec：`crabot-docs/superpowers/specs/2026-07-18-revive-vs-new-task-decision-design.md`；plan：`crabot-docs/superpowers/plans/2026-07-18-revive-vs-new-task-decision.md`；协议 `protocol-agent-v2.md` §5.1 已同步。
- Follow-up（暂缓）：context-overflow 韧性（错误不重试 + compaction 尾部治理 + 失败可诊断），spec 已写：`crabot-docs/superpowers/specs/2026-07-18-context-overflow-resilience-design.md`；候选"结果摘要"字段（若误判仍多再立项，涉及存储+协议）。
- 顺手修复：context-assembler 既有 recent-terminal 测试写死 2026-07-12 时间戳掉出 24h 窗口，改为相对当前时间。
- 验证：dispatcher/executor/resume 定向 89 个通过；crabot-agent 全量 1545 passed（2 skipped）；`tsc --noEmit` 通过。

## 2026-07-17 — 恢复飞书外部群 PRD 获取流程

- 历史 `get_history` / `get_message` / `backfill_history` 统一复用消息 mapper；Word 等 file 保留文件名、大小、reply/root 引用并登记可由 `fetch_media` 下载的惰性 handle。
- `rawGet` 可从 Axios HTTP 400 中提取飞书业务 payload；Wiki `41050 no user authority` 保留原始业务码/消息，并明确区分应用 scope、资源数据权限与跨租户授权。
- 所需核心 scope：`im:message`、`im:resource`、`wiki:wiki:readonly`、`docx:document:readonly`、`drive:drive:readonly`；详见 `crabot-docs/guides/feishu-external-group-prd.md`。
- 验证：Feishu 历史文件、rawGet、remediation、文档读取定向测试及全量测试/build 通过。

## 2026-07-17 — 修复飞书富文本图文消息丢图

- 根因：原生飞书 Channel 把 `post` 内嵌 `img` 固定拍平成 `[图片]`，丢弃 `image_key`；standalone `image` 链路不受影响。
- 修复：保留 post 文字并顺序下载全部图片，按协议写入 `media[]` + 首项 `media_url` 镜像；多图使用唯一落盘名，部分/全部失败保留可用内容。
- 配套：图文任务标题、Admin 斜杠命令继续取正文，图文中的飞书文档链接仍补标题；新增 mapper、单/多图、失败降级回归测试。
- 验证：Feishu 220/220 + build；Admin 图文斜杠命令 9/9 + build；Agent 图文标题/多图消费 16/16 + `tsc --noEmit`。Agent 全量 1539/1540（另 2 skipped），唯一失败是未改动的 recent-terminal 测试使用 2026-07-12 固定时间，已超当前 24h 窗口。

## 2026-07-16 — 移除 Channel 出站文件路径白名单

- 根因：`generate_image` 生成成功后返回 Agent 本地路径，但 Feishu Channel 额外维护静态路径白名单，导致后续 `send_message(file_path)` 被拒绝；Telegram、WeChat、DingTalk 的同名 capability 字段未参与运行时校验。
- 修复：四个 Channel 删除 `allowed_file_paths`；Feishu 同时删除实际拦截，保留文件读取、30 MB 限制与平台上传流程，并新增旧白名单外 `generated-images` 路径的发送回归测试。
- Follow-up：Admin 统一管理出站路径策略、Agent crab-messaging `send_message` 执行审核；本轮不修改 Agent 或 `generate_image` 存储位置。
- 验证：四个 Channel TypeScript build 通过；Feishu 214、WeChat 56、DingTalk 58 个测试通过；Telegram capability 定向测试通过，全量套件唯一失败为既有 reaction emoji 断言漂移（与本次 diff 无关）。

## 2026-07-16 — 挂起/唤醒语义收紧 + Goal 生命周期闭环（已实现，PR #31）

- 起因：m2u 生产 trace `ac9676e3` 复盘，暴露 4 个缺陷：A) 终态 goal 跨 epoch 重新武装 audit gate（幽灵 audit + 持久化报错丢结果，日志证实 ≥4 个任务命中）；B) Task-13 拦截文案教 agent 主动 wait audit → 空转 ≈14 分钟；C) set_task_goal 替换 goal 后新承诺从未被审计即完成任务；D) wait_for_signal 自由文本 + timeout_ms 旁路无准入校验。
- spec：`crabot-docs/superpowers/specs/2026-07-16-wait-signal-targets-goal-lifecycle-design.md`。C 简化为收尾清理（cleared + warn），事后 audit 暂缓（升级触发条件见 spec §4.3）。
- 实现（PR #31）：A/B/C/D 全部落地 + audit 等待兜底超时（10 分钟 → abort + fail-open，防 audit 卡死时 24h 挂起循环，review 发现补上）。resume 两条路径的 goal 语义交互见 spec §7，遗留脏数据（completed task + active goal）由收尾清理惰性消化，无需迁移。

## 2026-07-17 — 修复大型 Trace 执行树与 Task 状态对账

- `get_trace_tree` 不再只读取最新 100 条关联 trace；现在同步分页取回同一 task 的全部 trace 后再按 dispatcher / worker / sub-agent 分组。
- Admin reconciliation 改用完整 `get_trace_tree`，只按 `workers` 判定任务状态：任一 Worker 仍运行则不收口；全部终态时以后启动的 Worker 为准，front/sub-agent 失败不再直接把 task 判成 failed。
- 回归覆盖旧 Worker + 1000 条后续 Sub-agent 的跨页执行树，以及旧 Worker failed、后续 Worker completed 的状态收口。
- 验证：Admin reconciliation 定向测试、Agent TraceStore 跨页回归与两个模块 TypeScript build 通过。

## 2026-07-12 — 修复终态任务误入活跃列表与 WeChat 原始时间戳丢失

- ContextAssembler 将 dispatcher 可补充候选与协议里的 `active_tasks` 分开：recent terminal 仅在关联平台消息可见时供 dispatcher 判断，并通过 Channel `get_message` 有界补取缺失历史、回填 `task_id`；Worker 的“活跃任务”只保留真正活跃任务。
- recent terminal 的历史回溯锚点改用任务 `created_at`，避免任务完成时间晚于原始消息时漏掉关联聊天。
- WeChat 实时入站 `platform_timestamp` 改用 connector 的 `message.createTime`，兼容秒和毫秒 epoch；不再用 Crabot 接收时间覆盖平台发送时间。
- 验证：Agent 全量 1490 tests passed（2 skipped），WeChat Channel 全量 56 tests passed；两个包 TypeScript build 通过。

## 2026-07-11 — 私聊自动寻址捷径收紧为 scheduled-only

- 事故：human message task `b664e743` 获得并调用 `send_private_message`；消息实际送达，但绕过标准 outbound buffer / goal audit / delivery epoch，随后系统仍判定未通过 `send_message` 交付。
- 修复：新增 messaging tool profile；`send_private_message` / `send_master_private` 仅 scheduled 场景可见并有 handler 运行时防御，无 task context 与 human task 均拒绝。`daily_reflection` 保持只允许 `send_master_private` + 只读工具。
- 能力边界：human task 仍可查找任意真实会话并用 `send_message` 跨会话投递；未删除 Agent 主动使用 IM 的能力。
- 未来兼容：profile 读取当前 execution context；未来 scheduled 结果被人类追问时，只需切到 message profile。本期未修改 resume/source/checkpoint。

## 2026-07-10 — Follow-up：tmp-pages v2 专用工具化

- 背景：trace 复盘发现 agent 曾把 `$DATA_DIR/tmp-pages/<page_id>/page.html` 对应的 `.crabot/data/tmp-pages/...` 真实运行时路径写入项目脚本、summary 和 `docs/CURRENT_CONTEXT.md`，后续又误把 `.crabot` 当工作区数据根探索。
- 结论：tmp-page 原设计支持页面按钮/表单反馈（`data-choice` / `crabotSubmit` → `events.jsonl` → `deliver_page_feedback` 唤醒 owner task），不能只当静态 HTML 发布处理。后续应单独做 tmp-pages v2，不并入当前 agent loop/tool-result 优化。
- 建议方向：新增专用工具闭环，隐藏真实 `$DATA_DIR` 路径，仅向 agent 暴露 `page_id` / `url` / 结构化 events：`tmp_page_create`、`tmp_page_update`、`tmp_page_wait_feedback`、`tmp_page_read_events`、`tmp_page_delete`、`tmp_page_list`。工具内部负责 `owner_task_id`、TTL、HTML helper 注入、反馈唤醒与 events 读取。
- 边界：项目脚本、报告、summary、`CURRENT_CONTEXT.md` 不得记录 `.crabot/data/tmp-pages` 或其他 Crabot runtime 路径；如需持久可复现页面，先生成项目内 report，再由 tmp-page 工具发布临时 URL。

## 2026-07-10 — tmp-pages v2 专用工具化

- 背景：trace 复盘发现 agent 曾把 `.crabot/data/tmp-pages` 等 runtime 路径写入项目脚本、summary 和 `CURRENT_CONTEXT.md`。根因是 tmp-page v1 skill 直接指导 Worker 操作 runtime 文件。
- 修复：新增 Worker 内置 `tmp_page_create/update/read_events/delete/list` 工具，工具内部负责 `owner_task_id`、TTL、HTML/meta/events 文件和公开 URL，Worker 只接触 `page_id`、`url`、结构化 events；`read_events` 返回 `has_more`/`next_after_event_id` 以支持继续读取。
- 等待语义：不新增 `tmp_page_wait_feedback`。发页面后等待人类操作继续走 `send_message(intent='ask_human')` 或 `wait_for_signal`；页面提交仍由 `deliver_page_feedback{task_id,page_id}` 唤醒 owner task。
- 边界：工具结果、唤醒文案、skill 文档均不得暴露 `$DATA_DIR/tmp-pages`、`.crabot/data/tmp-pages`、`events.jsonl` 或内部端口；`tmp_page_update` 与 create 一样拒绝空 HTML。
- 验证：tmp-page tools / feedback wakeup / server source / skill doc focused tests，`crabot-agent` / `crabot-admin` `tsc --noEmit`。

## 2026-07-10 — 渠道实例 id 放开 Unicode 命名与路由 decode 修复

- 渠道实例 id 放开 Unicode 命名（白名单 + NFC）+ 修复 /api/modules/:id/* 路由 percent-decode 缺失（中文模块无法重启的事故根因）。spec: crabot-docs superpowers/specs/2026-07-10-unicode-instance-id-design.md

## 2026-07-08 — 修复 resume 执行入口语义污染

- 根因：`resume_task` / terminal supplement revive 复用了 `ScheduledTaskRunner.executeScheduledTaskInBackground`，该 runner 硬编码 `source.trigger_type='scheduled'`，导致 human message task 续跑后关闭 goal/end-turn delivery gate，空 `end_turn` 可直接完成。
- 修复：新增通用 Agent Loop Substrate，scheduled / human resume 通过显式 source/profile 进入同一个 worker loop；`ScheduledTaskRunner` 只保留真实 scheduled 任务组装职责；resume 后台执行失败会 best-effort 标 Admin task failed；失败任务只保留 Admin result / trace / log，不再写短期或长期记忆。
- 回归：human resume / terminal supplement revive 保留 `trigger_type='message'` 和 delivery epoch gate；scheduled resume 仍保持 scheduled silent policy；`send_master_private` 收紧为 scheduled/system 场景工具，human message task 不再暴露。
- 验证：`crabot-agent` resume/scheduled、memory-writer、agent-handler、messaging focused vitest 与 `tsc --noEmit`。

## 2026-07-06 — LLM 流缺终态改为可重试协议错误

- OpenAI Chat Completions / Responses stream 在已开始输出但缺少 `finish_reason` 或 terminal event 时，不再把 `stopReason=null` 传到 `query-loop`，而是在 adapter 层抛 `StreamProtocolError`，由 buffered LLM 调用重试整次请求。
- Chat Completions 明确拒绝旧版 `finish_reason='function_call'` 流式协议（当前 xinshu 实测为新版 `delta.tool_calls` + `finish_reason='tool_calls'`）；`content_filter` 明确抛非重试 provider 错误，避免落成 null stopReason。
- 验证：`llm-adapter.test.ts` 62 个通过；`retry-utils.test.ts` + `stream-timeout.test.ts` 24 个通过；`query-loop.test.ts` 35 个通过；`crabot-agent` `tsc --noEmit` 通过。

## 2026-07-05 — 移除 dispatcher action.text 上下文污染

- Dispatcher action schema 不再携带 supplement/new_task 正文；executor 对 active supplement 只路由 task_id，对 terminal revive/fallback 使用本轮真实 `ChannelMessage` 渲染内容，避免 completed task 拉起时把 `action.text` 当用户输入注入。
- terminal supplement wakeup 删除无用系统提示，只保留真实用户补充；引用消息渲染改短截断并保留 message id，降低大段引用原文造成的上下文漂移。
- Trace 页不再展示 `dispatch_action.text_summary`，协议 `protocol-agent-v2.md` 同步移除该字段与旧 `new_task(text)` / `supplement(target,text)` 语义。
- 验证：agent dispatcher/resume/prompt/register 定向测试 78 个通过；Admin Web trace utils 测试 19 个通过；`crabot-agent` / `crabot-admin/web` `tsc --noEmit` 通过。

## 2026-07-04 — 稳定 Channel Session ID 与无痛备份导入

- `Session.id` 明确为 Admin/Agent 使用的稳定对话指针，由 `channel_id + platform_session_id` 确定性派生；WeChat/Feishu/Telegram 加载旧 `sessions.json` 时把 legacy 随机 ID canonicalize 到 stable ID，legacy ID 仅作为兼容 lookup alias。
- `Schedule.target_session` 同时保存 `session_id` 和可选 `platform_session_id`：前者是运行时发送主指针，后者是迁移/修复锚点。Admin 只按 `channel_id + type + platform_session_id` 做确定性修复；缺证据的 legacy-only stale 引用保持无效，不做 fuzzy repair。
- 备份/导入不依赖 channel-local `sessions.json`。只要导入后 channel 实例和平台原生会话 ID 不变，重新发现会话即可得到同一 stable `Session.id`，导入的 schedule/config 能重新对上。
- Legacy-only `session-configs.json` 缺少 `channel_id/platform_session_id`，不安全自动迁移；这类旧配置保持无效，避免错误套用到另一个会话。
- 验证：三个 channel session-manager 测试与 build；Admin schedule repair / backup gather / target_session 测试与 build；Admin Web schedule 保存测试与 build。

## 2026-07-04 — 修复 resume checkpoint 悬空 tool_use 导致 OpenAI 400

- 根因：普通工具路径在 `toolResults` 入栈前触发 `onTurn`，worker checkpoint flush 把半截 `messages` 落盘；terminal supplement / restart resume 重放该 checkpoint 时，OpenAI 拒绝无 output 的 function call。
- 修复：`query-loop` 改为先写 tool result 再触发 `onTurn`；`exitsLoop` / `turnZeroOnly` 早退或拒绝路径对同轮所有 `tool_use` 补齐 tool result；新增 `tool-message-integrity` 共享校验，`isResumable` 拒绝历史坏 checkpoint。
- 验证：`resume-checkpoint.test.ts`、`query-loop.test.ts`、`query-loop-exit-tools.test.ts` 通过，并覆盖多 tool_use + exitsLoop / turnZeroOnly 混合场景。

## 2026-07-03 — 修复 async goal audit 结果未持久化与 no-delivery 空审计

- 根因：admin-chat 里用户看到的“收到...”来自 dispatcher `immediate_reply` / supplement ack，经 `chat_callback` 写入聊天消息；它不是 worker 的 `send_message` 工具调用。实际 worker trace 没有 `send_message`，所以 goal gate 判断“从未向人类交付”是成立的。
- no-delivery 路径不再在空 outboundBuffer 上强制派 audit；连续提醒 3 次仍直接 end_turn 时，engine 直接以 no-delivery failure 结束，要求 worker 在阈值前先 `send_message(intent=info)` 汇报或 `send_message(intent=ask_human)` 求助。
- async goal audit 路径只把 `<audit_result>` marker 推回 worker loop，没有像同步 `runGoalAudit()` 一样写 `append_task_goal_audit_entry` / trace verdict，导致 `audit_history` 为空、auto-block 失效、audit trace 顶层 outcome 空。已在 async audit on-exit 增加结构化 verdict 回调，由 `AgentHandler` 写 audit history，pass 时完成 goal，并 best-effort patch audit trace outcome。
- `scripts/debug-agent.mjs` 改为从 Module Manager 自动发现 Admin/Agent 端口，`tasks` 改用 `list_tasks` + 正确 filter/分页字段，trace 的 dispatcher action 显示 `dispatcher_ack=sent/none` 与 `supplement_ack=...`，避免把 dispatcher/admin ack 误读成 worker 交付。

## 2026-07-02 — 修复 Traces UI 活动排序、terminal supplement trace 续写与 null stopReason 误完成

- Traces 主列表的 task 行改按最后活动时间排序：`activity_at = max(task.updated_at, 最近关联 dispatcher started_at)`；标题/摘要优先显示最近 dispatcher 消息，避免旧 task 收到 supplement 后仍沉在创建时间位置、也避免只能看到原始长标题。
- `list_conversation_units` 搜索把关键词传给 `search_traces`，并在 Admin 侧对 orphan/related dispatcher 二次过滤，避免搜一个补充消息时混入大量无关孤儿对话。
- terminal supplement resume 才把历史 worker trace id 写入 `resumeFrom.resumeTraceId`，`handleExecuteTask` 通过 `TraceStore.reactivateTraceById()` 复用已完成 worker trace 继续追加 spans；普通 restart resume 不携带 `resumeTraceId`，仍走 `resumableCheckpoints` + `reactivateResumableTrace(task_id)`。修复同一 task 每次 terminal supplement 生成一条新 worker trace 的问题，同时避免把 restart 语义污染成历史 trace revive。旧历史数据里已产生的多 worker trace 不自动合并。
- `reactivateTraceById()` 同步刷新 `traceIndex` / `taskIndex`，避免详情页 full trace 已 running、列表 search/index 仍显示 completed 的状态漂移。
- 明确区分 `stopReason='end_turn'` 与 `stopReason=null`：任意已送达 `send_message(intent='info')` 仍允许作为“已有交付”收口；但 LLM stream 没有 terminal stopReason 时按失败处理，不能把空输出误标 completed（对应 trace `6646e158` 的事故形态）。
- 验证：Admin 定向回归 2 个通过；Agent resume/trace-store/query-loop 定向回归 14 个通过；query-loop 全量 33 个通过；`crabot-admin` / `crabot-agent` / `crabot-admin/web` `tsc --noEmit` 均通过。

## 2026-07-01 — 修复 recent terminal supplement 的 checkpoint 来源

- recent-terminal supplement 的 revive/resume 不再依赖 `resumableCheckpoints`（该 map 只负责 agent 重启后的 in-flight 任务恢复），改为按 `related_task_id` 查最近一条带 `resume_checkpoint` 的 worker trace。
- `TraceStore.findLatestResumeCheckpointByTaskId()` 先查内存 trace，再按 task index 读落盘 JSONL；只接受 `trigger.type='task'` 且有 checkpoint 的 trace，避免 dispatcher/message trace 干扰。
- 普通 `resume_task` / self-healing 重启恢复路径保持原语义，仍使用 `traces-running-<taskId>.jsonl` 加载的 `resumableCheckpoints`，并继续负责清理死 running checkpoint 文件。
- 回归：同进程刚完成的 task 即使不在 restart map 里，也能被 recent-terminal supplement 复活；历史 checkpoint 版本不匹配时只降级 new_task，不误清 running checkpoint。

## 2026-06-29 — Dispatcher 支持 recent terminal task 续聊

- dispatcher 的「可补充任务」清单从仅活跃任务扩展为：活跃任务 + 同 channel/session 最近 24h 内结束的 completed / recoverable failed 任务，recent terminal 按 `completed_at desc` 取最多 3 个；不限制 sender，排除 cancelled 和自恢复/人工取消类 failed。
- LLM 动作集合保持不变，仍然只暴露 `supplement / new_task / stay_silent`；recent terminal supplement 走内部 `revive_task_for_supplement` + `resume_task_with_supplement`，普通状态机仍禁止终态直接转回 executing。
- 失败兜底：revive 或本地 resume 失败时降级新建 task；若 admin revive 已成功但本地 resume 拒绝，会 best-effort 标 failed，避免留下假 executing。
- 协议已同步到 `crabot-docs`：`protocol-agent-v2.md` / `protocol-admin.md`。验证：agent dispatcher/orchestration/resume 测试 151 个通过，admin recent-task/state/self-healing 测试 45 个通过，agent/admin `tsc --noEmit` 通过。

## 2026-06-29 — Agent LLM 重试策略改为固定 10 次

- 按主人确认，取消 180s retry window；LLM 可重试错误改为固定最多 10 次重试，间隔 `1s → 2s → 4s → 8s`，之后封顶 `8s`。
- `retry-utils` 和 `callNonStreaming` 都走同一套 capped exponential backoff；保留流式缓冲整流重试，mid-stream 断流会重发整请求直到成功或 10 次耗尽。
- 回归：更新 `retry-utils.test.ts` 覆盖固定延迟序列；`tests/engine/call-non-streaming.test.ts` 覆盖“首个 attempt 超长仍继续重试”。验证：`pnpm --dir crabot-agent exec vitest run tests/engine/call-non-streaming.test.ts`、`pnpm --dir crabot-agent build`。
- 说明：`crabot-docs/superpowers/specs/2026-06-22-network-suspend-resume-design.md` 仍标记为草拟；正式协议/状态机尚无 `suspended`，本次未引入未定稿状态。

## 2026-06-26 — Admin UI 升级提醒与一键升级（已合 main + push origin `bf8b3f7`）

设计/计划：`crabot-docs/superpowers/specs/2026-06-25-admin-ui-upgrade-design.md` + `crabot-docs/superpowers/plans/2026-06-25-admin-ui-upgrade.md`。**source 模式一键升级端到端真实跑通（preparing→restarting→done），真空期仅 9 秒。**

- **三态安装形态适配**：`release`（无 `.git`，比 GitHub latest tag）/ `source`（有 `.git`，`git ls-remote origin main` + `merge-base --is-ancestor` 判远端是否领先本地，**不 fetch、不用 cat-file**）/ `system`（`/etc/crabot/cluster.version` 存在）。**deploy_mode（个人/团队）与 install_kind（源码/release）拆成独立维度做卡片标注**；system mode 改渲染只读卡片（版本+提示 `sudo crabot upgrade`，无升级按钮）。source 仅工作区干净且在 main 才启用一键升级。
- **后端**（`crabot-admin/src/version/`）：`VersionService`（capability + 6h 缓存 + release/source 检查，HTTP 走全局代理、git 注入 proxy env）；`UpgradeRunner`（canUpgrade 受理 + startUpgrade spawn detached + status 读写 + 10min stale 守卫）；3 接口 `/api/system/version{,/check}` + `/upgrade`。**`crabotHome` 用运行代码根（`CRABOT_HOME` env / 模块编译位置），不从 data_dir 反推**。
- **升级脚本 `scripts/ui-upgrade.mjs`（build 前置两阶段）**：① 准备阶段（实例照常运行）`git pull` + build/download，**失败不停服务、零影响**；② 切换阶段（停机秒级）`stop → migrate → start -d`。stdio 重定向到 `data/logs/upgrade.log`（失败可查死因）。脱离 admin 进程组，`crabot stop` pkill 不误杀。`release.mjs` 拆 `downloadRelease`（运行期）/`extractRelease`（停机期），`downloadAndExtract` 留兼容 CLI。
- **前端**：`services/version.ts` + `useSystemVersion`（共享缓存）+ Sidebar 红点 + `VersionUpgradeCard`（轮询状态机 preparing/restarting/done/failed，失联=重启中、5min 超时）。
- **前置根治**：memory `uv run/sync` 加 `--frozen`，禁启动改写 `uv.lock`（否则 source「工作区干净」判定被漂移打挂）。
- **端到端测试揪出并修复的真 bug**（多轮真实升级实证）：① crabotHome 从 data_dir 反推 → 误判 release + `current_version=null` + spawn 不存在脚本 → 改运行代码根；② `cat-file -e` 被任意 fetch 污染误判已含 → 改 `merge-base --is-ancestor`；③ 升级启动竞态（spawn 前同步写 status）；④ **build 在 stop 之后**（真空期=整个 rebuild）→ build 前置，真空期压到 9 秒；⑤ `stdio:ignore` 升级失败零日志 → 重定向 `upgrade.log`；⑥ **DATA_DIR 漂移**（ui-upgrade 继承模块级 DATA_DIR 当顶层 → status 写 `data/admin/admin/` 双层、`start -d` 误报「无密码」停机后起不来）→ startUpgrade 传顶层 DATA_DIR。终审另修 timer 卸载泄漏 / stale lock / CSS / ls-remote 空串守卫 + 清死代码。
- **遗留 minor**：source 模式 `last_upgrade.from/to_version` 显示 `null`（readVersion 读 VERSION 文件，source 用 git）——改读 `git rev-parse --short HEAD` 即可，纯显示不影响功能。

## 2026-06-19 — Crabot 备份/迁移 Plan 2：导入（worktree `crabot-backup-import`，未合 main）

设计/计划：`crabot-docs/superpowers/specs/2026-06-19-crabot-backup-import-design.md` + `crabot-docs/superpowers/plans/2026-06-19-crabot-backup-import.md`。

- **导入已实现**：归档按 id 记录级合并回运行中实例（skip/overwrite），保 id 不断交叉引用。统一「导入」向导（泛化原 OpenClaw 向导，按 manifest `product` 自动分流 crabot/openclaw）+ CLI `crabot import`（离线）。
- **Phase A 导出补强**：gather 改按记录过滤内置（`is_builtin`/`is_system`/`type==='builtin'`），移除 agent/channel implementations 类别条目——归档只含用户自建项。
- **Phase B 导入核心**：`mergeById` 纯函数 + `schedule-arm`（过期 once 置 disabled）+ `read-archive-category` + 各 manager `upsertById`（provider/channel/mcp/subagent/template）+ memory `import_long_term` RPC（写回 long_term + 同步索引）+ `runCrabotImport` 编排。
- **Phase C 入口**：Admin `/api/backup/import/{overview,execute}`（overview 按 product 分流，execute 接 ImportDeps）+ 向导泛化 + CLI `crabot import`。
- **验证**：单测全绿（backup 套件 44 + memory pytest 3 + 各 manager upsert）；**离线 CLI 全链路 round-trip 27 项不变量全 PASS**（id 保留 / 内置过滤 / 密钥 scrub / 过期 once 禁用 / 跨引用完好 / skip·overwrite / memory·skill 落盘）；round-trip 中发现并修复 CLI skill_dir 跨机器断链 bug。
- **待办**：Admin Web 在线导入 + memory RPC 在线路径 + scheduleEngine arm 的**浏览器端到端自测**（需 live 环境，被运行中实例挡住，未做）；C1 review 标注的两处跟进——导入引用非内置 agent-implementation 会孤儿（当前全内置不触发）、agent reload 用 `initialize()` 有幂等再入副作用。

## 2026-06-19 — Crabot 备份/迁移 Plan 1：导出（已合 main，merge 481e058）

设计/计划：`crabot-docs/superpowers/specs/2026-06-19-crabot-backup-migration-design.md` + `crabot-docs/superpowers/plans/2026-06-19-crabot-backup-export.md`。本质=泛化 OpenClaw 导入机器，备份/迁移走同一套在线 additive 导入。

- **导出已实现**：`crabot-admin/src/backup/`（types→categories→scrub-secrets→manifest→gather→pack→export-archive 七模块）+ Admin 端点 `GET /api/backup/{options,export}`（真流式下载）+ Admin Web `/backup` 页面 + CLI `crabot backup`（bootstrap，离线可用）
- 类别（粗粒度）：config / channels(+friends) / skills / memory / tasks；密钥默认 scrub，`--include-secrets`/勾选含入并强提示；归档 `crabot-backup-<ts>.tar.gz`（manifest.json + payload/）
- memory：长期记忆走 `long_term/` markdown 文件复制；短期记忆在线经 `export_memories` RPC、CLI 离线跳过
- 验证：19 单测（真文件 I/O + tar round-trip）全绿、CLI 端到端产出有效归档、前端 build 绿、整体终审通过
- **待办**：Task 10 浏览器端到端自测（需 live 环境，被运行中实例挡住，未做）；**Plan 2 = 导入**（在线 additive、skip/overwrite 冲突策略、跨版本门控、向导 UI）尚未开始

## 2026-06-11 — Master Chat 重构 Phase 2+3（已合并 main，merge 7be178d）

Phase 1 之后两期一并完成，整个三期重构收官。分支 `feat/master-chat-phase2`→`feat/master-chat-phase3`，33 commit 合入。spec：[`2026-06-10-master-chat-redesign-design.md`](crabot-docs/superpowers/specs/2026-06-10-master-chat-redesign-design.md)。

- **Phase 2 媒体双向**：base-protocol `MessageContent` 加 `media?: MediaItem[]` 多附件；Admin 内置 `MediaStore`（带 TTL 简易媒体存储，默认 30 天可在聊天设置弹窗配置 + 看占用，改 TTL 即时清扫，每日定时清扫）；入站走 `POST /api/chat/messages` multipart（Node 内建 `Request.formData()` 解析，无三方依赖，累计字节硬熔断）；出站 `send_message` 媒体收存进 store；media-resolver 多图注入同一 VLM turn；前端附件上传（粘贴/拖拽/选择）+ 图文卡 + lightbox + markdown 嵌图补 token
- **Phase 3 历史体验**：进页瞬时锚底（`useLayoutEffect` + `initialPositionedRef` 守门，修哨兵首屏连环加载）；**修了根因——消息容器 `flex:1` 缺 `minHeight:0` 导致整窗口滚动而非容器滚动**（[[feedback-frontend-verify-in-browser]]）；日期分隔符；ChatMessageItem 提取 + React.memo
- **消息级任务图标**（取代中途的"进行中任务条"设计）：任务状态挂到触发它的消息气泡旁（spinner/✓/✗ + tooltip + 点击跳 trace）；消息↔任务关联由 Admin 回填（chat_callback 回填 user 消息 / append_message 反向回填 worker 回复 + `chat_message_tagged` 推送）；30s 轮询兜底
- **交互**：消息引用（右键菜单引用/复制/删除 + 选中文本引用，markdown 引用块传递）；右键消息整行背景高亮；多行 textarea 输入框（双发送模式可切换并记忆）；整页粘贴附件；清空历史二次确认；删单条消息（`DELETE /api/chat/messages/:id` + `chat_message_deleted`）
- **测试隔离修复**：admin 测试经默认 MM 端口污染开发机 live 实例（写测试消息进真实聊天库 + 制造 recovery 噪音）——vitest.setup.ts 死端口隔离；存量污染用 `scripts/cleanup-test-pollution.mjs` 清理（309 消息 + 51 任务）
- 三端全绿：admin 739 / agent 1285 / web tsc+build。已知 flake：self-healing 跨文件并发偶发 1 失败，单跑必过

## 2026-06-11 — Master Chat 重构 Phase 1（已合并 main）

Admin Web 聊天界面从"几乎不可用"修到可用。spec：[`2026-06-10-master-chat-redesign-design.md`](crabot-docs/superpowers/specs/2026-06-10-master-chat-redesign-design.md)，三期分期，本次 Phase 1。

- **核心架构**：admin-web 成为伪 channel——Admin 注册标准 `send_message` RPC（协议 §3.20.3），worker 出站零特判直达聊天界面；`chat_callback` 保留给 dispatcher 同步路径
- **任务状态卡**：派 worker 时 `task_created`（携带 task_id）把占位转为状态卡；admin 状态机咽喉 `applyStatusTransition` + `handleUpdatePlan` 推 `chat_task_update` 驱动卡片实时更新；`GET /api/chat/tasks/:id` 供刷新 hydrate；点击跳 `/traces?task_id=`（顺手修掉 `/tasks/:id` 死链）
- **异步派发**：admin chat 派 worker 从 awaitWorker:true 改 false——旧同步等待会撑爆 process_message RPC 超时（"看不到输出"主因之一）
- **实测揪出的存量大坑**：chat-manager 合成身份 `friend_id='master'` 与真实 master friend UUID 不一致 → 权限解析落 minimal 模板 → **worker 工具全被滤光（tools=[]）**，模型只能把 send_message 写成 XML 正文，回复链路静默断裂数月。修复：`resolvePrincipalPermissions` 识别合成 master id（无记录时直接 master_private 模板）
- 其他修复：system_event 误降级为媒体占位、pushToClient WS 竞态抛错污染状态机、worker loop 异常时任务卡 executing 致状态卡永久转圈
- 新增测试 15 个（admin 713 全绿、agent 1281 全绿）；协议文档先行修订（protocol-admin §3.20）
- **Phase 2 待做**：MessageContent 加 `media[]` 多附件 + 图片/文件双向 + 上传 API（已知技术债：Phase 1 媒体占位文本有损落盘，见 spec）；**Phase 3**：历史滚动体验打磨

## 2026-06-11 — 修 agent ~13 小时 OOM 自动重启（zod globalRegistry 泄漏）

- 现象：home-m2u.local 上 agent 进程跑 ~13h 后堆 2.2GB OOM crash，MM auto_restart 拉起
- 根因（heap snapshot 实证）：worker 每轮 LLM turn 经 buildToolsDynamic 重建 crab-memory / crab-messaging in-process MCP server，zod v4 `.describe()` 把 schema clone 写入 globalRegistry（强引用 Map 永不清除）→ 每轮净增整棵 schema 树 ~2-3MB
- 修复：两个文件的工具 zod schema 全部提升为模块级常量（schema 与 task 上下文无关，ctx 都在 handler 闭包里）；registry 条目变成启动时固定有限集
- 回归测试：`tests/mcp/zod-registry-leak.test.ts`——重复构建 server 断言 globalRegistry 条目零增长

## 最新里程碑（2026-06-09 — Skill 改造 filesystem-native）

按 [Anthropic Agent Skills 业界标准](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) 重构 skill 存储模型：从"数据库 entry 嵌入 content 字段"改成"filesystem 目录是唯一真相源"。修了 zip 上传只取 SKILL.md 丢失 scripts/references/assets 的核心 bug。

- 起因：用户问"上传 skill 存哪"时发现 `importFromZip` 只读 SKILL.md，整个 zip 里的 scripts/references/assets 静默丢弃；git 导入同样残缺；importFromLocalPath 直接 reference 用户原目录用户 rm 就崩。深查后发现这不是单个 bug，是整套实现违反业界标准——业界规范要求"Skills exist as directories on a virtual machine"，而我们把"目录"压成了 JSON 的单个字符串字段
- 设计（spec：[`2026-06-09-skill-filesystem-native-design.md`](crabot-docs/superpowers/specs/2026-06-09-skill-filesystem-native-design.md)）：
  - skill 以标准 Anthropic 目录形态存储在 `<data_dir>/admin/skills/<skill-id>/`
  - 三条导入路径（zip / local / git）统一 unpack 到该目录
  - `registry.json` 只存元数据，不存 content（前端通过 REST 兼容 wrapper 即时附加 content 字段 → 零前端改动）
  - Agent 启动期只拿 Level 1 metadata（name + description）+ skill_dir 绝对路径；Skill 工具触发时才 fs.readFile（真正的 progressive disclosure）
  - previous_snapshot 改成 `.snapshots/<id>-<ts>/` 文件夹 swap，不再嵌进 JSON
  - 启动期自动迁移 legacy skills.json（含 .bak-<ts> 备份）
- 重要决策：
  - 前端零改动：REST `toRestEntry` wrapper 即时 readFile SKILL.md 拼回 content 字段
  - agent 子进程同主机，admin 传 skill_dir 绝对路径让 agent 直接 fs.read，不再"复制一份到 instance 私有目录"
  - 数据迁移幂等：legacy 字段已迁完的不重跑；scanned/builtin 不复制文件只清 content 字段
  - update/restore 改文件夹 swap 后 atomicity 经过 2 轮 review 加固：copy→tmp→rename + 三段 swap catch 分支区分 step A/B 失败
  - 三条导入路径全部走同一个 `installSkillFromDirectory(srcDir, sourceMeta, overwrite?)` 底层函数（DRY + 统一行为）

改动覆盖（14 个 commits + 1 个 polish）：
- `feat(admin/skills): 加 installSkillFromDirectory 底层函数（filesystem-native 三路径统一入口）`
- `fix(admin/skills): installSkillFromDirectory 加 rename 回滚 + 测试严格化（review I1+I2+I3）`
- `fix(admin/skills): importFromZip 完整 unpack zip 到磁盘（修 scripts/references/assets 丢失 bug）`
- `polish(admin/skills): importFromZip 补绝对路径 zip-slip + .extract 清理测试 + hoist path.resolve（review minor）`
- `fix(admin/skills): importFromLocalPath 改成复制到 data_dir（防用户原目录变动）`
- `fix(admin/skills): importFromGit 下载完整 archive 而非只取 SKILL.md`
- `refactor(admin/skills): 删除 handleDuplicateOnImport（已被 installSkillFromDirectory 取代）`
- `refactor(admin/skills): SkillRegistryEntry 删 content + update/restore 改文件夹 swap (filesystem-native)`
- `fix(admin/skills): update/restore atomicity 修复 + 测试守卫严格化（review I1+I2+I4+M3）`
- `feat(admin/skills): REST 序列化即时附加 content 字段（前端兼容过渡）`
- `feat(admin/skills): 加 GET /api/skills/:id/previous-content + diff modal 适配新接口`
- `refactor(agent/skills): SkillConfig 删 content 加 skill_dir + 删 writeSkillsToInstancePath/.skill_dir marker`
- `chore(agent/skills): 清理 Task 9-10 后的 unused imports`
- `feat(admin/skills): 启动期自动迁移 legacy entry 到 filesystem-native 布局（含 .bak 备份）`
- `docs(protocols): SkillConfig 协议改 filesystem-native（删 content 加 skill_dir）+ 加 previous-content endpoint 说明`（crabot-docs 子仓库）

涉及 8 个核心文件：
- `crabot-admin/src/mcp-skill-manager.ts` — SkillRegistryEntry / 三条导入路径 / update / restore / migrateLegacyEntries / toRestEntry / readPreviousContent
- `crabot-admin/src/index.ts` — 8 个 REST handler 走 toRestEntry + 新 `/previous-content` endpoint
- `crabot-admin/src/types.ts` — SkillConfig 删 content 加 skill_dir
- `crabot-admin/src/builtin-skills.ts` — 改 skill_dir 引用 + 3 个 builtin SKILL.md git mv 到目录结构
- `crabot-admin/web/src/pages/Skills/SkillDiffModal.tsx` — 改用 `/previous-content` endpoint + loading/error 状态
- `crabot-agent/src/types.ts` — SkillConfig 删 content 加 skill_dir required
- `crabot-agent/src/agent/agent-handler.ts` — 删 writeSkillsToInstancePath/getInstanceSkillsDir + computeSkillsHash 改 skill_dir
- `crabot-agent/src/engine/tools/skill-tool.ts` — 整个重写，从 skillDirByName 直接 fs.read，删 `.skill_dir` marker 解析

测试：13 个新测试 + 重写若干 + 删 3 个过时（覆盖 installSkillFromDirectory 4 用例 / importFromZip 5 用例 / importFromLocalPath 2 用例 / importFromGit 4 用例 / update+restore swap 5 用例 / toRestEntry 3 用例 / migrateLegacyEntries 5 用例 + agent-handler updateSkills 4 用例 + skill-tool 重写）。admin 全套 680/680 PASS，agent 端 skill-tool 12 PASS + agent-handler 46 PASS。

spec：[`crabot-docs/superpowers/specs/2026-06-09-skill-filesystem-native-design.md`](crabot-docs/superpowers/specs/2026-06-09-skill-filesystem-native-design.md)
plan：[`crabot-docs/superpowers/plans/2026-06-09-skill-filesystem-native.md`](crabot-docs/superpowers/plans/2026-06-09-skill-filesystem-native.md)

剩余手测（建议 ship 前完成）：
1. 准备一个标准 Anthropic skill（SKILL.md + scripts/ + references/）打成 zip → Web `/skills` 上传 → 检查 `data/admin/skills/<id>/` 含 scripts/references → 通过 agent 调 `Skill("xxx")` 验证 `<skill_resources>` 列出附属文件
2. 编辑 SKILL.md → 检查 `.snapshots/<id>-<ts>/` 完整保留旧目录 → 点"应用上一版"验证 restore swap
3. 启动 admin 让现网 10 个 legacy skill 走 migrate → 检查 `data/admin/skills.json.bak-<ts>` 备份 + `data/admin/skills/<id>/` 目录建立
4. 从 anthropics/skills GitHub repo 子目录导入 → 验证完整 archive 下载（不再只有 SKILL.md）

## 最新里程碑（2026-06-09 — Admin 密码管理重构）

把 admin 密码从 `data/admin/.env` 明文升级为 `data/admin/credentials.json`（scrypt hash），加首登强制改密 + JWT epoch 撤销老 token 机制 + Bash hook 拦截 agent 自改密码。

- 起因：明文存 .env 无首登强制改密机制，无运行时改密 API，无吊销老 token 手段；agent 可能自行修改密码而绕过审计
- 设计：
  - `data/admin/credentials.json`：算法 scrypt + salt + hash + params + is_temp（初始化密码标记）+ token_epoch（JWT 吊销计数器）+ 时间戳 + changed_via（start | cli | web）
  - readCredentials 内嵌 .env 兜底迁移（任何入口都走迁移逻辑；仅含密码键时自动删 .env，否则报错）
  - rotateCredentials 改密专用包装（验证旧密码 → epoch++ → hash 新密码）
  - JWT payload 增加 `e: token_epoch`；admin 改密后 epoch++，老 token 携带的 e 值不匹配，login 返回 TOKEN_REVOKED；internal-token（sub='internal'）豁免 epoch 检查
  - REST /api/auth/change-password 端点 + /api/auth/me 获取 isTemp 状态
  - chat-manager/pty-manager 同步切到 verifyJwtWithEpoch async 验证，避免 WebSocket 路径绕过 epoch 失效
  - Web 首登 PrivateRoute 守卫 isTemp=true → 强制跳 /setup-password 页；顶栏「修改密码」Dialog（旧密码 → 新密码二次确认）
  - Bash PreToolUse hook 拦截三类命令：`crabot password/reset-password` 子命令、`/api/auth/change-password` 端点、`data/admin/credentials.json` 直接文件修改
- 重要决策：
  - 临时密码沿用 crabot start 交互式输入（由用户决定初始密码），只多打一行日志 "This is a temporary password"
  - scrypt 使用 Node.js 原生 crypto 模块，无新依赖
  - admin 进程不缓存密码，每次 login 实时读 credentials.json，支持后台改密无需重启
  - .env 迁移后若仅含密码键自动删除；若含其他配置则拒绝迁移（保护用户手动维护的其他变量）

改动覆盖（17 个 commits）：
- `feat(admin): credentials.ts 加 scrypt hashPassword/verifyPassword 纯函数`
- `feat(admin): credentials.ts 加 read/write 原子落盘（0600）`
- `feat(admin): credentials 自动迁移旧 data/admin/.env 的 CRABOT_ADMIN_PASSWORD`
- `feat(admin): credentials.rotateCredentials 改密专用包装（epoch++/is_temp=false）`
- `feat(admin): types 加 ChangePassword/Me + 4 个错误码 + LoginResponse.is_temp`
- `feat(admin): verifyJwtWithEpoch async 包装（人类 token 受 epoch 失效，internal 豁免）`
- `feat(admin): handleLogin 改用 credentials.json + 返回 is_temp + JWT 带 epoch`
- `feat(admin): REST 拦截改用 verifyJwtWithEpoch async + 区分 TOKEN_REVOKED`
- `feat(admin): /api/auth/change-password + /api/auth/me + 首登免旧密语义`
- `feat(admin): chat-manager/pty-manager 切到 verifyJwtWithEpoch（改密同步失效 WS 老 token）`
- `feat(cli): crabot password 走 credentials 存储（hash + epoch++ + 撤销老 session）`
- `feat(cli): crabot start 切到 credentials.json（写 is_temp=true + 不再注入 env）`
- `chore(cli): start.mjs 清理不再使用的 writeFileSync 导入`
- `feat(admin-web): authService 加 getMe/changePassword + LoginResponse.is_temp`
- `feat(admin-web): AuthContext 加 isTemp + refreshMe + markPasswordChanged`
- `feat(admin-web): /setup-password 页 + PrivateRoute is_temp 路由守卫`
- `feat(admin-web): 顶栏加「修改密码」按钮 + ChangePasswordDialog`
- `feat(admin-web): 401 TOKEN_REVOKED 给出明确提示`

E2E（自动化）：
- ✅ start.mjs 新建 credentials.json is_temp=true
- ✅ crabot password 改密 epoch++、is_temp=false、changed_via=cli
- ✅ legacy .env 迁移 + 自动删 .env
- ✅ Bash hook deny：三种命令模式全部拦截，不误伤 crabot start

**待办（用户手动 e2e）**：
1. 启动 admin Web 用临时密码登录 → 强制跳 /setup-password
2. 新建密码 → logout 自动 → 用新密码重登成功
3. 顶栏「修改密码」走完整 flow（旧密码错误提示 / 成功改密后 → logout → 老 token 401 TOKEN_REVOKED）
4. CLI `crabot password` 改密时 admin 进程在跑 → UI 立即 401 → 用新密码重登
5. **手动 sync worktree .claude/settings.local.json 的 hook entry 到 main repo**（.claude/ gitignored，无法 commit；包含 deny-password-mutations PreToolUse hook）

**Follow-up（独立 spec / session）**：
- alert() 换 toast 方案（内在网络发散，留整个 session 处理）
- 登录失败 rate-limit（防暴力破解）
- 密码强度策略（必须含数字+字母，长度 8+ 字符）
- ChangePasswordDialog UI 接入项目通用 Modal 组件库
- AdminConfig.password_env 字段下个发布周期清理（预期无调用方）

spec: [crabot-docs/superpowers/specs/2026-06-08-admin-password-management-design.md](crabot-docs/superpowers/specs/2026-06-08-admin-password-management-design.md)
plan: [crabot-docs/superpowers/plans/2026-06-08-admin-password-management.md](crabot-docs/superpowers/plans/2026-06-08-admin-password-management.md)

---

## 上一里程碑（2026-06-07 — Skill 保留上一版 + Admin UI diff + 修 undo bug）

skill 加 N=1 上一版快照（嵌入式存进 skills.json），新增 restore swap 能力 + REST endpoint + CLI 命令；Admin Web 加角标 + diff modal + 应用上一版按钮；顺手修了 `crabot skill add --overwrite` 的 undo bug（旧 reverse 是 delete 等于删库）。

- 起因：master 想优化 skill 后能对比"改前 vs 改后"或一键回退；agent 自我反思后改自己的 skill 也需要回退能力。同时发现 `crabot skill add --overwrite` 的 undo 实际是 delete，是 silent data loss bug
- 设计：
  - SkillRegistryEntry 加 previous_snapshot 嵌入字段（N=1 覆盖式，含 content + skill_dir 附属文件；单文件 1MB / 总 5MB 阈值）
  - SkillManager.restore() swap 语义；磁盘 atomic rename 写回；失败 throw 不更新 json 保持一致
  - admin install 响应加 was_overwrite 标志；CLI 据此分支（true → restore reverse，false/undefined → delete reverse，旧 admin 兼容）
  - Admin Web 用 react-diff-viewer-continued 渲染 diff，左侧文件列表 + 右侧 split/unified diff
- 重要决策：builtin skill 不参与（update 路径已被拦死，restore 也拒）；附属文件 diff MVP 仅显示快照侧（当前侧需 admin 加 dir-files endpoint，留作 follow-up）；不支持任意历史（N=1 满足 80% 场景）

改动覆盖（9 个 commits）：
- `feat(admin): SkillRegistryEntry 加 previous_snapshot + update 打快照`
- `feat(admin): SkillManager 加 restore + writeSkillDirFiles`
- `feat(admin): POST /api/skills/:id/restore + install 响应加 was_overwrite`
- `feat(cli): 新增 crabot skill restore <ref> 命令`
- `fix(cli): skill add --overwrite 的 reverse 改成 restore（修 undo bug）`
- `feat(cli): undo executeReverse 加 skill restore <ref> 分支`
- `docs(skill): 重生成 crabot-cli 命令参考（含 skill restore）`
- `feat(admin-web): Skills 页加上一版角标 + 对比 modal + 应用上一版按钮`
- `docs(progress): skill 上一版 + Admin UI diff 完成`

spec：[`crabot-docs/superpowers/specs/2026-06-07-skill-previous-version-and-diff-design.md`](crabot-docs/superpowers/specs/2026-06-07-skill-previous-version-and-diff-design.md)
plan：[`crabot-docs/superpowers/plans/2026-06-07-skill-previous-version-and-diff.md`](crabot-docs/superpowers/plans/2026-06-07-skill-previous-version-and-diff.md)

测试：skill-snapshot.test.ts 全套（readSkillDirFiles / writeSkillDirFiles / update snapshot / restore swap）；skill.test.ts（buildSkillAddReverse 分支）；undo.test.ts（skill restore dispatch）。

**待办（用户手动 e2e）**：
1. 装一个 user skill → `crabot skill show <name>` 看 previous_snapshot 为 undefined
2. 改 SKILL.md 后 `crabot skill add --path X --overwrite` → previous_snapshot 有值，UI 角标显示 `v_prev → v_current`
3. UI 详情 "查看对比" → diff modal 显示 SKILL.md 红绿差异
4. UI "应用上一版" → 二次确认 → content 复位
5. `crabot skill restore <name>` 再切回去 → swap 工作
6. `crabot undo`（在 --overwrite 后跑）→ 走 skill restore 路径而不是 delete
7. builtin skill restore → 报错 "是内置的，不能 restore"
8. 在 skill 目录里加 references/foo.png → update → restore → png 被删

**Follow-up（独立 spec / session）**：
- admin 加 `GET /api/skills/:id/dir-files` endpoint 把当前附属文件传给前端，让 diff modal 完整显示双侧 references diff
- snapshot 多版本历史（N=3 或无限）作为下一阶段
- `skill add --overwrite` 加 LLM 内容审核（同 schedule add，agent 改 builtin/user skill 时双闸门）

---

## 上一里程碑（2026-06-06 — CLI schedule add target schema 修复 + schedule update 命令）

修 CLI `schedule add` 的 target schema bug（旧实现写 legacy `task_template.input.target_*`，新协议要求顶层 `target_session`），补 `--interval-seconds` 触发器对齐 admin UI，并新增 `schedule update <ref>` 命令字段覆盖范围对齐 admin UI 编辑器。

- 起因：2026-06-05 的 trigger_messages 统一改造把 `Schedule.target_session` 升级为顶层一等字段，admin POST handler 不再读 `task_template.input.target_*`；CLI 旧实现仍写 legacy 字段 → CLI 新建带 target 的 schedule 触发时 trigger_message.session 是 SYSTEM_SESSION 哨兵，send_message 硬拒绝 → schedule 触发了但 worker 发不出消息。同时 CLI 缺 update 命令，改任何字段只能 delete + add（违反 rollback-over-confirm 原则）。
- 设计：
  - **修 add target schema**：CLI 写顶层 `target_session: {channel_id, session_id, type}`，三个 target-* flag 共生共死（任一缺失抛 INVALID_ARGUMENT）；新增 `--target-type <private|group>` flag
  - **补 add --interval-seconds**：admin UI 已支持 interval 触发器，CLI 此前只有 cron + once；三种 trigger flag 互斥
  - **新增 schedule update**：字段覆盖范围对齐 admin UI 编辑器（name/description/enabled/trigger 字段级（同类型内）/task_template 字段级/target_session 三态）；纯函数 `buildUpdateScheduleBody(current, opts)` 集中字段映射 + 校验；GET snapshot → merge → PATCH，undo 走 `--restore-snapshot` 通用路径；TS 类型 `ScheduleSnapshot` 本地最小定义（CLI 不 import admin 类型）
  - **undo.ts 扩展**：`SNAPSHOT_RESTORE_PATH` 加 schedule + regex 加 schedule + executeReverse export 以便单测
- 重要决策：update 不进 LLM 内容审核（add 进，因为 add 是首次审；update 只改字段不扩展工具权限）；不引入 trigger 跨类型修改能力（cron → once 等需 delete + add 或 admin web）；不动 admin 协议 / agent 侧 runner / handleUpdateSchedule（已就位）

改动覆盖（9 个 commits）：
- `fix(cli): schedule add 写顶层 target_session 替代 legacy input.target_*`
- `feat(cli): schedule add 补 --interval-seconds 触发器`
- `feat(cli): 注册 schedule add 的 --interval-seconds 和 --target-type flag`
- `feat(cli): 加 buildUpdateScheduleBody 骨架 + 顶层标量字段`
- `feat(cli): buildUpdateScheduleBody 支持 trigger 字段级 merge`
- `feat(cli): buildUpdateScheduleBody 支持 task_template 字段级 merge`
- `feat(cli): buildUpdateScheduleBody 支持 target_session 三态`
- `feat(cli): 新增 schedule update <ref> 命令`
- `docs(skill): 重生成 crabot-cli 命令参考（schedule add/update 字段更新）`

spec：[`crabot-docs/superpowers/specs/2026-06-06-cli-schedule-update-and-target-fix-design.md`](crabot-docs/superpowers/specs/2026-06-06-cli-schedule-update-and-target-fix-design.md)
plan：[`crabot-docs/superpowers/plans/2026-06-06-cli-schedule-update-and-target-fix.md`](crabot-docs/superpowers/plans/2026-06-06-cli-schedule-update-and-target-fix.md)

测试：schedule.test.ts 65/65（29 add 既有 + 7+12+9+8=36 buildUpdateScheduleBody 全套），undo.test.ts 7/7（6 既有 + 1 新 executeReverse schedule restore-snapshot）。

**待办（用户手动 e2e）**：
1. `crabot schedule add --title test --priority normal --cron "*/5 * * * *" --target-channel <CH> --target-session <SESS> --target-type private --disabled` → GET 验证顶层 `target_session` 有值
2. `crabot schedule update <id> --description "改了"` + `crabot undo` 验证 snapshot 还原
3. 改 target_session 后跑 `crabot schedule trigger` 验证 trigger_message.session 切到新目标
4. 改内置 daily-reflection schedule description 验证 is_builtin 可编辑
5. 跨类型修改报错文案符合 spec §5（如 cron schedule 给 `--interval-seconds` 报"当前 schedule 是 cron 类型..."）
6. 三个 target-* 缺一报错文案

**Follow-up（独立 task / session）**：
- CLI `schedule update` 不进 LLM 内容审核的决策可能需要 revisit（如果用户实际 use case 揭示 update 也能造成 worker 越权）
- cmdParts 段历史性缺少 `--description` / `--task-description` / `--task-type` / `--tag` / `--timezone` / `--disabled` 的 push（pre-existing issue，影响 undo log 回溯完整性）
- 部分实施步骤里 TS LSP diagnostics 出现陈旧 cache（说 export 不存在但 tsc 实际通过），不阻塞，但若频繁出现可考虑研究 LSP cache 失效机制

---

## 上一里程碑（2026-06-05 — Goal 模式软约束化 + worker workflow 重组）

把 goal 模式从代码层硬门控改成 prompt 软约束；worker workflow 重组成 5 段方括号名字风格（[阅读理解]/[信息收集]/[意图澄清]/[目标承诺]/[规划与执行]）；删除 worker turn-0 supplement_task / stay_silent 早退工具（dispatcher 已吃掉决策）；GOAL_MODE_GUIDANCE 拆为流程图融入 WORKFLOW + 深度说明独立段 GOAL_MODE_DETAILS；supplement 注入文案常量化 + goal mode on/off 双 variant；删除 WORKFLOW_GROUP（群聊主流程跟私聊一致）。

- 起因：goal 模式当前两个落地决策过紧——(a) todo 工具被 hasGoal 硬门控，讨论场景也想用 todo 列分支被卡；(b) goal 判断段（GOAL_MODE_GUIDANCE）跟主工作流（WORKFLOW_PRIVATE）分裂，LLM 视角下流程跟决策点不在一起。同时 research_collector 在流程图里没显式位置（跟 code_planner 硬绑定不一致），实测 LLM 经常不派、context 撑大
- 设计：
  - **代码层**：取消 todo 工具的 hasGoal 硬门控（一行：`hasGoal: () => true`）；删除 worker 端 supplement_task / stay_silent 工具及相关代码（实际是 dead code，dispatcher 在 worker spawn 前已经做了相应决策）
  - **prompt 层**：WORKFLOW_PRIVATE 拆为 5 段方括号名字常量 + `buildWorkflow({ goalModeEnabled })` 函数化（goal mode 关时省略 [目标承诺] 段位）；GOAL_MODE_GUIDANCE → GOAL_MODE_DETAILS 用 agent 视角重写（没有 engine / hook / harness 等工程术语）；删 WORKFLOW_GROUP（dispatcher 已吃掉群独有 turn 0 triage）
  - **supplement 文案双 variant**：goal mode on/off 分别注入不同模板（GOAL 含 set_task_goal 三分支提示，BASIC 只含 "调整方向" 一句），由 deliverHumanResponse 按 taskState.triggerType 推算
  - **research_collector 流程位置**：when_to_use 首句加 "信息收集类工作的默认派遣对象——main 工作流 [信息收集] 段位优先派此 subagent"，跟 code_planner 在流程图硬绑定一致
- 重要决策：保留 dispatcher 端 supplement / stay_silent 决策（dispatcher 该有的能力不动）；保留 engine `turnZeroOnly` 框架作扩展点；保留 audit gate + endTurnGate 机制；scheduled 任务硬关 goal mode 保留（独立 follow-up 重新设计 audit 路径）

改动覆盖（7 个 commits）：
- `refactor(dispatcher): refine immediate_reply guidance`（pre-existing dirty diff cleanup）
- `feat(agent): remove todo hasGoal hard gating, todo always allowed`
- `refactor(agent): goal mode soft-control prompt redesign (WORKFLOW + GOAL_MODE_DETAILS + supplement template)`（Task 2-5 合并）
- `refactor(agent): remove worker-side supplement_task and stay_silent tools (dispatcher already covers these decisions)`
- `feat(admin): research_collector when_to_use first line emphasizes default for [信息收集] step`
- `docs(progress): mark goal soft-control workflow redesign as complete`

spec：[`crabot-docs/superpowers/specs/2026-06-05-goal-soft-control-workflow-redesign-design.md`](crabot-docs/superpowers/specs/2026-06-05-goal-soft-control-workflow-redesign-design.md)
plan：[`crabot-docs/superpowers/plans/2026-06-05-goal-soft-control-workflow-redesign.md`](crabot-docs/superpowers/plans/2026-06-05-goal-soft-control-workflow-redesign.md)

测试：crabot-agent 1174/1180（4 pre-existing engine 失败无关：trace-store SIGKILL / e2e permission / query-loop onTurn × 2）；crabot-admin tsc + build 全绿。

**待办（用户手动）**：
- Task 8 端到端 6 场景验证：讨论场景（无 goal + todo）/ 任务场景（有 goal + audit gate）/ supplement 注入文案 / scheduled task（goal mode 硬关）/ dispatcher 路径未损坏 / WORKFLOW_GROUP 删除后群聊行为一致

**Follow-up（独立 spec / session）**：
- scheduled 任务 audit 死锁问题——audit fail 时无法 ask_human 会永远循环。候选解法：A. audit fail N 次后 admin 代 agent 调 send_master_private 主动通知；B. scheduled audit 改"事后报告"不阻塞 worker；C. fail 一次即 task 标 failed。倾向 B+C 组合
- `createTodoTool` 接口的 `hasGoal` 参数本期保留向后兼容，可在确认无引用后彻底移除
- `agent-handle-trigger.test.ts` 等测试文件里残留的 `triggerArrivedAtMs` / `overdueInjected` 字段引用（pre-existing tech debt，2026-06-03 dispatcher-immediate-reply spec 删 overdue 时遗留）

---

## 上一里程碑（2026-06-05 — trigger_messages 统一 + Schedule.target_session 一等字段）

把 worker 接收任务输入的两条并行通道（`task.task_description` + `context.trigger_messages`）收敛为单通道，schedule 的目标会话从半结构化 input 字段升级为一等可选字段。

- 起因：`task_description` 字段在 dispatcher 触发路径只作"一句话分类标注"无实际价值，但在 scheduled 路径作为唯一输入兜底；同时 schedule 目标会话半埋在 `task_template.input.target_*`（部分 schedule 干脆把目标群 ID 直接埋在 description 文本里），口径不一致
- 设计：
  - `trigger_messages` 成为 worker 接收任务输入的**唯一通道**
  - `ExecuteTaskParams.task.task_description` 字段彻底删除（agent 协议 + 调用点）
  - Scheduled task 通过 `system_event` 子类型 `scheduled` 表达（sender=crabot 自身）
  - `Schedule.target_session?: { channel_id, session_id, type }` 升级一等可选字段，admin RPC + web UI 全套支持
  - 无 target_session 时用 `SYSTEM_SESSION` 哨兵（`crabot-shared`），`crab-messaging.send_message` 硬拒绝该哨兵
  - `buildTaskMessage` 重写为单段 `## 会话历史` 时间线，合并 trigger + recent 按 timestamp 排序

改动覆盖（10 个 commits）：
- **crabot-docs**：`protocol-agent-v2.md` §3.4 trigger_messages 注释补强；`base-protocol.md` `SystemEventType` 加 `'scheduled'` + system_event 双来源约束（Channel 平台事件 vs 系统内部触发）
- **crabot-shared**：新增 `SYSTEM_SESSION` 哨兵常量
- **crabot-agent**：`types.ts` SystemEventType 扩展；`ExecuteTaskParams.task.task_description` 删除；dispatcher schema/prompt 无需改动（已无该字段）；`buildTaskMessage` 重写单段时间线；`ScheduledTaskRunner` 构造 system_event trigger_message；`crab-messaging.send_message` 拒收 SYSTEM_SESSION；worker prompt 加 "系统触发任务说明" 段
- **crabot-admin**：`Schedule.target_session` 一等字段 + create/update/get/list RPC 支持 + `validateTargetSession` 校验；启动时一次性迁移 `task_template.input.target_*` → `target_session`（幂等，channel offline 兜底）
- **crabot-admin-web**：Schedule 编辑器加 channel + session 联动 dropdown，自动派生 session.type，支持"清除目标会话"

spec：[`crabot-docs/superpowers/specs/2026-06-04-trigger-messages-unified-design.md`](crabot-docs/superpowers/specs/2026-06-04-trigger-messages-unified-design.md)
plan：[`crabot-docs/superpowers/plans/2026-06-04-trigger-messages-unified.md`](crabot-docs/superpowers/plans/2026-06-04-trigger-messages-unified.md)

测试：crabot-agent 1175/1181（4 pre-existing engine 失败无关）；crabot-admin 561/561；admin-web tsc + build 全绿。subagent 路径 `BgAgentRegistryRecord.task_description` 等 13 处 task_description 引用按 spec 明确保留不动。

**待办（用户手动）**：
- Task 13 端到端 4 场景验证（每日反思无 target / github-ai-news 迁移后有 target / 普通消息触发无回归 / agi-a-share 文本埋藏未迁移）
- agi-a-share schedule 目标群 ID 当前仍埋在 description 文本里，可在 admin web 手动改成 target_session 配置

**已知 follow-up**：
- crabot-shared dist 传播到 channel-feishu pnpm cache 偶发延迟（dev.sh / Task 2 / Task 10 实施时遇到过），单独 follow-up
- `runScheduleMigration` 在 schedules-load try 块内，若 persist 失败 outer catch 会误打 "No existing schedules data" 日志（cosmetic）

---

## 上一里程碑（2026-06-03 — SceneProfile v0.3.0：删 global + scene 参数权限分级）

修一个被 trace c829e70b 暴露的产品语义错误 + agent 工具签名 bug：

- 起因：feishu-2 群一条 trace 死循环 22 轮调 `get_scene_profile({type:'global'})`——拿到的「global 画像」实际是另一个群的群规则，agent 反复重试 → 第 23 轮把本群规则又错写进 global slot
- 根因 1：`SceneIdentity` 的 `global` 分支在产品语义上不成立——跨场景共享应当走 agent 模块的「AI 性格提示词」，不该混进场景画像
- 根因 2：`scene` 参数在普通对话场景下不应暴露给 LLM——当前场景由 ctx 唯一确定，让 LLM 自己挑 = 给「猜错 scene」开门

改动：
- **protocol-memory.md**：v0.2.0 → v0.3.0；§"v0.3.0 协议变更" 子节 + §3.27.6 新 SceneProfile 章节（修原断链「详见 protocol-admin §SceneProfile」）
- **crabot-memory**：`SceneIdentity` 收 2 路；`scene_profile_store.py` 启动时 `DELETE WHERE scene_type='global'; DROP INDEX IF EXISTS ux_global;`；`_parse_scene` 接到 global 抛 ValueError；测试改写 8/8 PASS
- **crabot-agent**：`MemoryTaskContext` 加 `isMasterPrivate`；`crab-memory.ts` 三个 scene_profile 工具按 ctx 分叉——master 私聊 scene 必填可操作任意场景；其他 ctx scene 字段不暴露，强制 ctx 推断；删 `only_public` 字段；tsc 0 errors
- **crabot-admin**：URL key 解析去 global 分支；前端 `services/memory.ts` SceneIdentity 收 2 路、`SceneProfileList.tsx` 过滤器去掉「全局」选项；admin 34/34 + web 208/208 PASS
- **db 迁移**：`data/memory/metadata.db` 备份后 `DELETE FROM scene_profiles WHERE scene_type='global'`（1 行）+ `DROP INDEX ux_global`

spec：[`crabot-docs/superpowers/specs/2026-06-03-scene-profile-global-removal-and-permission.md`](crabot-docs/superpowers/specs/2026-06-03-scene-profile-global-removal-and-permission.md)

**Follow-up（未做）**：agent loop 检测「连续 N 轮同 tool + 同 input」guard，强制注入提示或 end_turn，避免类似死循环再次出现（独立小 spec，不在本里程碑范围）。

---

## 上一里程碑（2026-05-20 — Phase 5 阶段 3b：Trace 页面优化）

Trace 页面四块优化 + 文件拆分：
- dispatch_call / dispatch_action span 类型补全（agent union + admin web 渲染）
- sub_agent_call 内联嵌套展开（点击展开子 trace span 树，banner 显示 subagent name）
- 去 front/worker 二分 UI 文案（保留代码层兼容旧 trace 数据）
- 顶部 StatusBar（磁盘占用 + trace 数） + 手动清理 dialog + 自动清理 retention 设置 + daily cron
- 2002 行 pages/Traces/index.tsx 拆 9 个聚焦文件

spec：`crabot-docs/superpowers/specs/2026-05-19-trace-page-redesign-design.md`
plan：`crabot-docs/superpowers/plans/2026-05-19-trace-page-redesign.md`

主要改动：
- `crabot-agent/src/types.ts`：AgentSpanType union + DispatchCallDetails/ActionDetails
- `crabot-agent/src/core/trace-store.ts`：getDiskUsage + cleanupOldTraces(dryRun)
- `crabot-agent/src/unified-agent.ts`：注册 2 个新 RPC handler
- `crabot-admin/src/types.ts`：GlobalModelConfig.trace_retention_days
- `crabot-admin/src/index.ts`：/api/agent/traces/disk-usage GET + /api/agent/traces/old DELETE
- `crabot-admin/src/trace-cleanup-cron.ts`：daily cron + retention 检查 + parseCleanupParams
- `crabot-admin/web/src/pages/Traces/`：utils.ts + 8 个组件文件 + 多个测试文件
- `crabot-docs/protocols/`：§8.2 表 + §3.24 REST 表 + AdminGlobalModelConfig 字段

**已记录的 follow-up（不阻塞本里程碑）：**
- agent 端 `unified-agent.ts:2286-2304` 有独立每日清理（默认 30 天，用 `TRACE_RETENTION_DAYS` env 控制），与 admin cron 并行运行。后续应删除 agent 自清理，让 admin cron 是唯一入口。
- admin cron 实际是「启动后每 24h」一次，protocol §3.24 描述为「每天 03:00」——需要要么改 impl 算到下一个 03:00，要么把 protocol 改成「每 24h」。
- `cleanupOldFiles` 在 trace-store.ts:555 标 @deprecated 但暂未删除；上面项落地后可一起清。
- `SpanDetailPanel` 老 span type label 仍英文（Model/Iterations/Tool 等），新 dispatch 已中文化。下次顺手统一。
- web 端 `services/trace.ts` 与 agent 端 `types.ts` 双写 `AgentSpanType`/details union，存在 drift（如 web 有 llm_retry 但 agent 没有）。后续移到 `crabot-shared` 统一。

---

## 上一里程碑（2026-05-19 — Phase 5 阶段 3a：Subagent Admin UI 落地）

落地 Admin Web 的 Subagent 管理 UI：列表页 / 6-tab 编辑 dialog / Agent 配置页加 timeout_seconds + overdue_reminder_enabled。Backend REST `/api/subagents` 在阶段 1-2c 已成熟，本阶段只做 UI；可视化管理替代手动改 `data/admin/subagents.json`。

spec：`crabot-docs/superpowers/specs/2026-05-19-subagent-admin-ui-design.md`
plan：`crabot-docs/superpowers/plans/2026-05-19-subagent-admin-ui.md`

主要改动（4 个代码 commit，TDD 全程，subagent-driven-development 流程）：
- `crabot-admin/web/src/types/index.ts`：加 `ModelRole` / `BuiltinCapabilities` / `SubAgentBase` / `SubAgentRegistryEntry`（与后端 admin/src/types.ts 字段 100% 镜像）+ `AgentInstanceConfig` 加 `timeout_seconds?` / `overdue_reminder_enabled?`
- `crabot-admin/web/src/services/subagent.ts`：CRUD 5 个 method（list/get/create/update/remove，沿 skillService pattern）+ 5 测全过
- `crabot-admin/web/src/pages/Subagents/SubagentList.tsx`：列表 + enabled toggle + 删除（builtin 不可删，可禁用）+ 4 测全过
- `crabot-admin/web/src/pages/Subagents/SubagentEditor.tsx`：6-tab dialog（基本 / 触发条件 / 角色与工作流 / 模型 / 内置能力 / MCP + Skill 白名单）+ 7 测全过；研究角色 file_system 默认关在「内置能力」tab 直接展示
- `crabot-admin/web/src/pages/Agents/AgentConfig.tsx`：末尾追加「触发处理」section（2 字段）+ 7 测全过（含 2 新）
- `crabot-admin/web/src/App.tsx`：加 `/subagents` 路由
- `crabot-admin/web/src/components/Layout/Sidebar.tsx`：「模型与 Agent」section 加菜单「Subagent 管理」

验收：tsc 0 errors（admin + web） / 全 web 测试 162/162 PASS / 全 admin 测试 411/411 PASS / `./dev.sh build` 完整成功（Vite 31 modules / dist/web/assets/index-*.js 1.0MB gzip 284KB）。

待 master 跑端到端：
1. 浏览器打开 `/subagents` → 看到 3 个 builtin 行（code_planner / code_writer / research_collector）+ 「+ 新建」按钮 / 「编辑」「删除」按钮的禁用态
2. 编辑 research_collector → 6 tab 切换 + Tab 5 file_system 默认未勾 + Tab 6 勾上 scrapling → 保存 → `cat data/admin/subagents.json` 验证 allowed_mcp_server_ids 已更新
3. 新建一个自定义 subagent（如 test_helper），保存 → 列表显示「自定义」chip + 删除按钮可用
4. 切到 `/agents/config` → 看到「触发处理」section → 改 timeout_seconds=60 + 保存 → `data/admin/agent-instances.json` 验证

Follow-up（不阻塞，留待后续 commit）：
- SubagentList badge 颜色与 SkillList 不一致（灰 vs 紫）— 视觉一致性
- `subagentService.create` 类型签名（`Omit<...>`）与 `formToPayload` 返回（`Partial<...>`）不严格匹配，editor 用 `as never` 绕过；建议精确两者类型
- `SubagentEditor.WhitelistTab` provider/mcp/skill 加载失败无 toast，静默 fallback 空数组
- `SubagentEditor.ModelTab` 从 role 切到 specific 时 hardcode `model_role='cost_effective'`，round-trip 丢原值

## 上一里程碑（2026-05-19 — Phase 5 阶段 2c：research_collector 重构 + WORKFLOW 派发改造）

阶段 2b 落地后发现两个问题：① vision builtin 在多模态时代价值缩水（所有 vision-capable 模型已可直接读图）；② WORKFLOW [执行] 段预设 `[self]/[vision]/[code]` 派发标签把决策框死，自定义 subagent 没法自动接入。阶段 2c 一次性解决这两个：

- **vision → research_collector**：删 vision builtin，加 `research_collector`（model_role=vision 复用多模态能力 / max_turns=20 / `file_system: false` 干净边界——只调 mcp + crab-memory 不读写本地 / `allowed_mcp_server_ids: []` 默认空 → 用户启用时手动勾选 scrapling 等 web mcp / 5 段 prompt 强制 ≤2K tokens markdown summary 输出）
- **WORKFLOW 派发改造**：[规划] 段 todo content 不再标 `[self]/[vision]/[code]`；[执行] 段保留**唯一硬约束**（编码任务 code_planner → code_writer 串联）+ **main 自主决策**（看 `delegate_task` 工具 description 里的 `<available_subagents>` 选 when_to_use 最匹配的 subagent）+ **核心派发原则**（subagent 价值 = 消化大量 raw 输入并精炼输出，避免 main context 撑爆）。效果：用户自定义 subagent 自动出现在 `<available_subagents>` 段，main 看到就能用，无需改 prompt
- **新 lifecycle 操作 `pruneObsoleteBuiltins`**：admin 启动时把已经从 `getBuiltinSubAgents()` 列表中移除但 registry 还在的 builtin entry 删掉 + console.warn 告知"如曾通过 Admin UI 编辑过 prompt，自定义内容将丢失"。从 2b 升级 2c 时启动日志会看到 `[SubAgentManager] 删除已废弃的 builtin subagent: vision (id=builtin-vision)...`

spec：`crabot-docs/superpowers/specs/2026-05-19-subagent-phase2c-research-collector.md`
plan：`crabot-docs/superpowers/plans/2026-05-19-subagent-phase2c-research-collector.md`

主要改动（5 个代码 commit + 1 个协议文档 commit，TDD 全程）：

- `crabot-admin/src/builtin-subagents.ts` 删 5 个 VISION_* 常量 + 加 5 个 RESEARCH_COLLECTOR_*；entry 第 3 项整重写（`builtin-research-collector` / model_role=vision / file_system=false / allowed_mcp_server_ids=[]）
- `crabot-admin/src/subagent-manager.ts` `pruneObsoleteBuiltins(activeBuiltinIds)` 方法 + 5 个新单测（清理 / 保留自定义 / idempotent / 空 list / 多个废弃同清）
- `crabot-admin/src/index.ts` `initialize()` 在 `subAgentManager.initialize()` 后 `seedBuiltin()` 前接入 `pruneObsoleteBuiltins(getBuiltinSubAgents().map(s => s.id))`
- `crabot-admin/tests/builtin-seeding.test.ts` `vision` → `research_collector` 测试用例改写（验 model_role=vision + file_system=false + allowed_mcp_server_ids=[]）
- `crabot-agent/src/prompts/agent-sections.ts` `WORKFLOW_PRIVATE` [规划]/[执行] 段重写：删派发标签 / 加硬约束 + 例外条款 / 加 main 自主判断三层结构 / 加核心派发原则；snapshot 自动更新 12/12 PASS
- `crabot-docs/protocols/protocol-agent-v2.md` §11.8 表 vision → research_collector；§11.8.2 整段重写（删 `[self]/[vision]/[code]` 表 / 留硬约束 + main 自主决策 + 自定义自动可用说明）

启动验证（在 e2e 验收时观测到）：
- admin 启动日志含 `[SubAgentManager] 删除已废弃的 builtin subagent: vision (id=builtin-vision)...` + `[Admin] Seeded 3 builtin subagents`
- `cat data/admin/subagents.json` 看到 3 个 entry：code_planner / code_writer / research_collector（无 vision）
- `curl /api/subagents` 返回 3 个 entry，research_collector 的 model_role=vision、file_system=false
- `curl /get_config` agent 端拿到 3 个 subagent，model 已实时解析

待 master 跑端到端：
1. 发编码诉求消息 → trace 看 main 是否走硬约束（code_planner → code_writer 串联），不应自己用 Write 改用户代码
2. 发简单聊天消息 → trace 看 main 是否直接 send_message，不应误委派 research_collector
3. 配 vision-capable 全局默认 model（当前实例 `research_collector` model 解析时 fallback 到 cost_effective 的 `kimi-for-coding`，应配 vision role 让其用真正多模态模型）
4. 启用 scrapling 等 web mcp → 通过 admin UI 编辑 research_collector 的 `allowed_mcp_server_ids` 勾选

## 上一里程碑（2026-05-18 — Phase 5 阶段 2b：内置 subagent + plan-and-execute 落地）

阶段 2a 调研产物落地：admin 启动时 seed 3 个 builtin subagent（code_planner / code_writer / vision）+ 3 个 builtin skill（superpowers v5.0.7 MIT 的 writing-plans / systematic-debugging / verification-before-completion）+ main worker prompt 在 enabled subagents 含 code_planner 时自动注入 PLAN_AND_EXECUTE_GUIDE 引导段。

spec：`crabot-docs/superpowers/specs/2026-05-18-subagent-phase2b-builtin-design.md`
plan：`crabot-docs/superpowers/plans/2026-05-18-subagent-phase2b-builtin.md`
research：`crabot-docs/superpowers/research/2026-05-18-coding-skill-survey.md`

主要改动（6 个代码 commit + 1 个协议文档 commit + 1 个 progress commit，TDD 全程）：

- `crabot-admin/builtin-skills/*.md` 3 个 SKILL.md snapshot（superpowers v5.0.7 MIT，加 attribution header；项目根级，dev/prod 通过 `join(__dirname, '..', 'builtin-skills')` 均可访问）
- `crabot-admin/src/builtin-skills.ts` getBuiltinSkills() + BUILTIN_SKILL_IDS
- `crabot-admin/src/builtin-subagents.ts` getBuiltinSubAgents() + BUILTIN_SUBAGENT_IDS + 完整 5 段 prompt 文本（来自调研报告）
- `crabot-admin/src/mcp-skill-manager.ts` SkillManager.seedBuiltinSkills（idempotent）
- `crabot-admin/src/index.ts` AdminModule.initialize 接入两个 seedBuiltin + 启动日志
- `crabot-agent/src/prompts/agent-sections.ts` PLAN_AND_EXECUTE_GUIDE 常量
- `crabot-agent/src/prompts/assemble-agent.ts` hasCodePlanner option + 条件注入
- `crabot-agent/src/agent/agent-handler.ts` buildSystemPrompt 计算 hasCodePlanner = subAgents 含 code_planner
- `crabot-docs/protocols/protocol-agent-v2.md` §11.8 内置 subagent + §11.8.1 内置 skill + §11.8.2 plan-and-execute 引导段 + §11.8.3 writer 上报格式

build + dist smoke test 已通过：dist/builtin-skills.js + dist/builtin-subagents.js 编译后可加载 3 个 skill + 3 个 subagent（writing-plans content 6284 字节）。13 个新增 admin 测试 + 4 个新增 agent 测试全绿。

待 master 跑端到端：
1. `./dev.sh stop && ./dev.sh` 重启
2. `curl http://localhost:3000/api/skills` 看 3 个 is_builtin=true 的 builtin skill（writing-plans / systematic-debugging / verification-before-completion）
3. `curl http://localhost:3000/api/subagents` 看 3 个 builtin subagent
4. 发"帮我加个 X 功能"类编码消息 → trace 看 worker 先调 code_planner（拿 PLAN_PATH）再调 code_writer（按 plan 实施）

## 上一里程碑（2026-05-18 — Phase 5 阶段 1：subagent 架构骨架完成）

把 subagent 体系从 hardcoded `SUBAGENT_DEFINITIONS` 升级为 admin-managed 资源；worker 工具表注入单一 `delegate_task` 工具；agent role 整顿为 3 个 ModelRole；不预填任何内置 subagent（阶段 2b 才 seed code_planner/code_writer/vision）。

分支：`feature/subagent-phase1`（4 个 repo：root / crabot-admin / crabot-agent / crabot-docs）。12 个代码 commit + 2 个 docs commit，TDD 全程。

spec：`crabot-docs/superpowers/specs/2026-05-17-subagent-customization-and-admin-ui-design.md`
plan：`crabot-docs/superpowers/plans/2026-05-17-subagent-phase1-architecture.md`

**Admin 侧（Task 1-5）**：
- `crabot-admin/src/types.ts`：新增 `SubAgentRegistryEntry` / `SubAgentConfig` / `BuiltinCapabilities` / `ModelRole`；`AgentInstanceConfig` 加 `timeout_seconds` + `overdue_reminder_enabled`
- `crabot-admin/src/subagent-manager.ts`：`SubAgentManager` 类（CRUD + 原子写 + seed 内置 + validateModelSpec），12 个单测；新增 `resolveSubAgentModel`（specific 优先 / role 回退）
- `crabot-admin/src/index.ts`：`/api/subagents` 5 个 REST handler；mutating 触发 `triggerPushAfter`；`buildSubAgentConfigsForPush` 把 entry 转 SubAgentConfig（实时解析 LLMConnectionInfo），失败 skip + warn；`pushConfigToAgentModules` 把 subagents + timeout_seconds + overdue_reminder_enabled 加入 update_config payload
- `crabot-admin/src/agent-manager.ts`：`DEFAULT_IMPLEMENTATION.model_roles` 整顿为 `powerful` / `cost_effective` / `vision`；`migrateModelConfig` 启动 migration（default/worker/smart → powerful；triage/digest/fast → cost_effective；vision_expert → vision；coding_expert 丢弃），7 个单测

**Agent 侧（Task 6-12）**：
- `crabot-agent/src/types.ts`：新增 `SubAgentConfig` / `BuiltinCapabilities`；`AgentLayerConfig` 加 3 个新字段；`UpdateConfigParams` 同步
- `crabot-agent/src/agent/subagent-prompt-assembler.ts`：5 段拼装 + 头尾守则（不轮询 / 不持久化 / 不主动副作用 / 截断重读），6 个单测
- `crabot-agent/src/agent/subagent-tool-filter.ts`：`classifyTool`（9 group）+ `filterToolsForSubAgent`，24 个单测；`delegate_task` 永远从 subagent 工具集剔除（防嵌套）
- `crabot-agent/src/agent/delegate-task-tool.ts`：`buildDelegateTaskDescription`（`<available_subagents>` 装配）+ `createDelegateTaskTool`（单一工具入口 + dispatch by subagent_type），8 个单测
- `crabot-agent/src/agent/agent-handler.ts`：删 per-subagent 循环；注入单一 `delegate_task`；新增 `makeRunSubAgent`（filter → assemble → adapter → forkEngine + trace stitching + endTrace 双路径）
- `crabot-agent/src/unified-agent.ts`：buildSubAgentConfigs 改读 `config.subagents`；删 `buildSubAgentConfigs` / `resolveSubAgentSlot` 旧方法；`handleUpdateConfig` 加 subagents 变化检测（触发 worker 重建）+ timeout_seconds / overdue_reminder_enabled 软热更；新增 `resolveTimeoutSeconds` / `resolveOverdueReminder` 默认 30s/true，4 个 `handleTriggerMessage` 调用点接入
- `crabot-agent/src/agent/subagent-prompts.ts`：删 `SUBAGENT_DEFINITIONS` 常量 + `SubAgentDefinition` interface + `DELEGATE_TASK_SYSTEM_PROMPT`；保留 `formatSupplementForSubAgent`

**协议文档（Task 13）**：
- `crabot-docs/protocols/protocol-agent-v2.md`：新增 §11 "Subagent 配置"（7 子章节）；旧 §9 标注"已被 §11 替换"
- `crabot-docs/protocols/protocol-admin.md`：§3.19 加 Subagent 注册表 + ModelRole 重整两子章节

**端到端验证（待 master 自跑）**：

1. `./dev.sh stop && ./dev.sh` 重启加载新代码
2. `curl http://localhost:3000/api/subagents` → 期望返回 `[]`（阶段 1 不预填）
3. `curl -X POST http://localhost:3000/api/subagents -H 'Content-Type: application/json' -d '{...}'` 创建测试 subagent → 期望 201 + entry JSON
4. `node scripts/debug-agent.mjs traces` → 触发一条消息后看最新 trace，worker 工具表应有 `delegate_task` + description 含新 subagent
5. 检查 `data/admin/agent-instances/*.json`，原 model_config keys（如 `worker` / `triage`）应已迁移到 `powerful` / `cost_effective`
6. 删除测试 subagent + `./dev.sh stop`

阶段 2a / 2b / 3 留给后续 PR：
- 2a：coding skill 调研（hermes-agent superpowers + everything-claude-code）
- 2b：seed code_planner + code_writer + vision 内置 subagent，挂接 coding skill；main worker prompt 加 plan-and-execute 引导
- 3：Admin Web UI（SubagentList + SubagentEditor 6 tab）

## 上一里程碑（2026-05-08 — crab-messaging list_contacts/list_groups 路由修正 + 分页可见性）

修复 2026-05-08 早报 trace `f0f7d4bb` 暴露的"`list_groups` 必失败"bug：自 2026-04-04 commit `f48fbb9` 引入以来，`crab-messaging` MCP 的 `list_contacts` / `list_groups` 工具一直把 RPC 路由到 `adminPort.list_sessions`（admin 端从来没有这个 method），每次调用必返回 `Method "list_sessions" not found`，靠 LLM 改名重试到 `list_sessions` 兜底掩盖。

spec：`crabot-docs/superpowers/specs/2026-05-08-messaging-list-tools-alignment-design.md`
plan：`crabot-docs/superpowers/plans/2026-05-08-messaging-list-tools-alignment.md`

- **协议文档（crabot-docs 子 repo）**：`protocol-crab-messaging.md` §2.1 / §4 把笔误的 admin "list_contacts" 改回 `list_friends`（admin 管 Friend 表，channel 才有 Contact 概念）；§2.7 / §2.8 加错误码表。`protocol-channel.md` 新增 §3.13 list_contacts / §3.14 list_groups 接口定义（基于 PaginatedResult），§3.2 ChannelCapabilities 加 supports_list_contacts/groups 字段。`base-protocol.md` GlobalErrorCode 加 PERMISSION_DENIED。
- **crabot-shared**：`module-base.ts` 加 RpcError / RpcCallError / formatHandlerError，让 handler 抛 RpcError 时 code/details 透传到 response.error；让 RpcClient.call 收到 success=false 时 reject RpcCallError 携带原 code/details（之前只剩 message 的普通 Error）。`base-protocol.ts` GlobalErrorCode 加 PERMISSION_DENIED 常量避免下游用裸字符串。
- **crabot-channel-wechat**：types.ts 加 supports_list_contacts/groups（capability）+ 6 个 List* 协议类型。`wechat-client.ts` 加 listContacts() 调 `GET /api/v1/bot/contacts`（已有的 listGroups 复用）。`wechat-channel.ts` 注册 list_contacts / list_groups RPC handler，client 原生字段（username/nickname/chatroomName/name）映射到协议字段（platform_user_id/display_name/platform_session_id/group_name），分页 camelCase → snake_case 翻译。capability 上报 true。22 个测试。
- **crabot-channel-feishu**：同形扩展。`feishu-client.ts` 加 listContacts() 调 `contact.v3.user.list`；飞书错误码 99991672 / 99991663（通讯录读取权限缺失）翻译为 `RpcError('PERMISSION_DENIED', ..., { missing_scope: 'contact:user.base:readonly' })`，其他错误透传。`feishu-channel.ts` 注册 list_contacts / list_groups handler；handler 层 self-filter（飞书 contact API 不支持 keyword）+ case-insensitive；分页近似 has_more=true → total_pages=2（避免 N+1 误导下游）。86 个测试。
- **crabot-channel-telegram**：bot api 不支持列群/列联系人，capability 上报 false。crab-messaging 在路由前看 capability 直接返回 `CHANNEL_LIST_*_NOT_SUPPORTED` 错误码，agent 看到 hint 自然 fallback 到 list_sessions。
- **crabot-agent crab-messaging.ts**：抽出 `buildMessagingTools(deps, sandboxPathMappingsRef?)` 纯函数返回 8 个工具数组（lookup_friend / list_contacts / list_groups / list_sessions / send_private_message / send_message / get_history / get_message），让工具可单测。`createCrabMessagingServer` 改用循环 register。list_contacts / list_groups 改路由到 channelPort + 用新 list_contacts/list_groups RPC（不再调 admin.list_sessions）。三个 list 工具统一通过 `annotatePagination` 给返回叠加 has_more / is_truncated / default_page_size_applied / next_page 显式字段，避免 LLM 把单页结果当全集；通过 `translateChannelError` 把 RpcCallError 翻成结构化输出（`CHANNEL_LIST_*_NOT_SUPPORTED` 带 hint，`PERMISSION_DENIED` 透传 missing_scope）。新建 pagination-annotator / error-translator 两个独立模块。新增 6 个 crab-messaging-list 集成测试，全 agent 803 测试。
- **prompt-manager**：worker prompt 加"找群/找联系人优先顺序"段（lookup_friend → list_groups/list_contacts → list_sessions）+ 分页可见性提示（has_more=true 时不要把单页当全集）。
- **commits**：13 个 commit 全程 TDD（spec → plan → 4 个 phase 顺序推进 + 各 phase code review fix）。

**端到端验证（待 master 自跑）**：

1. `./dev.sh stop && ./dev.sh` 重启加载新代码
2. wechat：`@crabot 用 list_groups 在 wechat-棉花糖 上找包含 'Claude' 的群` → 看 trace 中只调一次 list_groups 直接命中、不再先失败再 fallback
3. wechat：`@crabot 用 list_contacts 在 wechat-棉花糖 列联系人` → 返回带 has_more / next_page / default_page_size_applied 的分页元信息
4. telegram：`@crabot 用 list_groups 在 telegram-fufu 找群` → 收到 `error_code: CHANNEL_LIST_GROUPS_NOT_SUPPORTED` + hint 引导改用 list_sessions
5. feishu：list_groups / list_contacts 看是否能正常返回；如果应用没拿通讯录 scope 应收到 `PERMISSION_DENIED` + missing_scope='contact:user.base:readonly'
6. 下一轮（2026-05-09 08:00）GitHub 早报调度：trace 应无 iter=fail+iter=retry 模式

## 上一里程碑（2026-05-07 — CLI 权限统一进 Friend + Session 模板）

把 crabot CLI 的权限闸从硬编码 `isMasterPrivate` 单 bit 升级为按发起人解析 effective permissions（friend ∪ session 并集）+ schedule add 内容 LLM 审核。master 在群聊享完整 CLI 权限；群友在被升级到 `group_scheduler` 模板的群里可创建受审核的简单定时任务。plan：`crabot-docs/superpowers/plans/2026-05-06-cli-permission-friend-session-union.md`。

- **types.ts（admin / agent / web）**：新增 `CliPerm`/`CliDomain`/`CLI_DOMAINS`/`CliAccessConfig`，扩 `PermissionTemplate`/`SessionPermissionConfig`/`FriendPermissionConfig`/`ResolvedPermissions` 各加 `cli_access` 字段。`crabot-shared` 是 `CliDomain` 的单一真相来源，admin/agent 各自重新定义 `CliPerm`/`CliAccessConfig` 但 union 字面量从 shared import 来防漂移。
- **PermissionTemplateManager**：5 个系统模板（master_private 全 write / group_default 全 none / minimal 全 none / standard 全 none / 新增 group_scheduler 仅 schedule=write 且 tool_access 含 messaging+memory+task）；normalize 自动给旧持久化数据补默认；resolvePermissions 合并 session.cli_access；旧 friendPermissionConfig 缺 cli_access 时由 normalizeFriendPermissionConfig 兜底全 'none'。
- **Admin RPC + REST**：新增 `resolve_principal_permissions`（friend ∪ session 并集；master 短路；都缺 → minimal 兜底）。helper 拆到 `permission-resolution.ts`：`unionCliPerm` rank 取大、`unionStorage` path 不一致时取受限侧（防提权）、`unionResolved` 单边返回也 deep clone（不暴露引用）。REST 路径 `POST /api/permissions/resolve-principal`。
- **Agent unified-agent**：原 `resolveSessionPermissions` / `resolveGroupPermissions` 双路径合并为 `resolvePrincipalPermissions(senderFriend?, sessionId, sessionType)` 调新 RPC；删除 4 个旧 method（净 -87/+38 行）。
- **crabot-shared cli-domains**：新增 `classifyCliSubcommand(subcommand) → {domain, kind} | null`（48 个映射含 provider test/refresh）+ `REQUIRES_CONTENT_REVIEW = new Set(['schedule add'])`。`CLI_WRITE_SUBCOMMANDS` 标 deprecated。
- **agent hook**：`block-cli-write` 升级为 `cli-permission-gate`（按 `cli_access[domain]` 判定 + schedule add LLM 审核）；worker-handler 无条件注册（不再分 master 私聊），把 `senderIsMaster` / `resolvedPermissions` / `contentReviewer` 通过 `EngineOptions → query-loop → HookExecutorContext` 透传到 hook 内部。`isMasterPrivate` 局部变量保留给 progress digest / bg entity persistence 独立语义。fail-closed 6 处：`--reveal` 永拦 / 未识别 subcommand / 缺 resolvedPermissions / cli_access 不够 / 缺 reviewer / reviewer deny。reviewer **抛错**也 fail-closed deny（hook 内显式 try/catch，防 hook-executor 把异常吞成 continue）。
- **cli-content-reviewer**：fast model 调 LLM judge schedule 描述工具是否落在 effective tool_access 范围内。fail-closed：throw / parse 失败 / 非法 verdict 全 deny。`parseVerdict` 用 bracket-balance 解析（避免 reason 字段含 `}` 提前截断）+ markdown 围栏剥离。复用 worker 自身 `sdkEnv` 的 adapter（schedule add 频率低，单独 review slot 留作 follow-up）。
- **Admin Web**：PermissionTemplate 编辑页加 cli_access 配置段（10 个 domain × none/read/write 下拉），types.ts + service 同步加 CliAccessConfig。
- **Prompt + Skill**：`crabot-cli` skill 重写到 v3.0.0；Worker prompt L264 / L401 去"仅 master 私聊"，引向"按发起人 cli_access"+ schedule 审核语义。
- **协议文档**：`crabot-docs/protocols/protocol-admin.md` §3.2 加 `cli_access` 字段 + §3.2.7 `resolve_principal_permissions` RPC 描述（**待 master 在 crabot-docs 仓库独立提交**——sibling repo 边界）。
- **测试**：crabot-shared 29/29 + crabot-admin 341/342（1 pre-existing model-provider flake）+ crabot-agent 776/776 + crabot-admin-web 145/145，4 个包 tsc 0 errors。新增覆盖：14 个 cli-permission-gate hook 单测（含 reviewer-throws fail-closed）+ 6 个 cli-content-reviewer 单测（含 bracket-balance 解析）+ 11 个 unionResolved/unionCliPerm/unionStorage 单测 + 12 个 PermissionTemplateManager.cli_access 单测 + 4 个 resolve_principal_permissions REST 集成 + 1 个 cli-domains shared 单测套（覆盖大小写敏感）。
- **端到端验证（待 master 自跑）**：4 条路径 — (a) master 群聊 `crabot mcp toggle` 全权 / (b) master 私聊回归 / (c) group_scheduler 模板群里普通群友 `@crabot 提醒张三 3 点开会` 通过审核 / (d) 同群普通群友 `@crabot 3 点跑 rm -rf` 被审核拒。

## 上一里程碑（2026-05-07 — 模块恢复 & Self-Healing）

补齐"模块意外退出后的自动/人工/agent 恢复"能力。spec/plan：`crabot-docs/superpowers/plans/2026-05-07-module-recovery-and-self-healing.md`。

- **MM 自动重启**：`ModuleDefinition.auto_restart` 字段实装；指数退避 1s/2s/4s/8s/10s + 5min 内 3 次窗口限流；超限置 status=error 并发 module.health_changed；admin/agent/memory 内置模块默认开启。
- **DiskWatcher**：MM 启动 60s 周期检查 dataDir 所在挂载点剩余空间，跌破 1GB 阈值发 system.disk_low 事件（注入式 statfsFn 便于单测，状态去抖避免重复广播）。修因 5/7 凌晨 agent 静默猝死的根因——磁盘满 ENOSPC + 没 fatal handler。
- **Admin 端口缓存失效**：onEvent 订阅 module_stopped / module_health_changed → 清 agentPort / memoryModules 相应缓存；新增 callAgentRpc helper 在 ECONNREFUSED 时清缓存重试一次；4 个 agent trace handler 切到 helper，把不可达错误返 503 而非 500（修因 5/7 admin 接口报 500 的根因）。
- **Admin REST + Web UI**：新增 `GET /api/modules`、`GET /api/modules/:id/log?tail=N`（读 data/logs/<id>.log）、`POST /api/modules/:id/restart`；admin web `/modules` 页加运行状态面板（5s 轮询 + 着色状态 + 查看日志弹窗 + 重启确认）。
- **Self-healing recovery 任务**：agent module_started(restart_count>0) 触发 admin runSelfHealingForAgentRestart：扫所有 status=executing 任务标 failed → 用 buildRecoveryTask 纯函数构造 recovery worker 任务（tags=['recovery'], priority=high, source.origin=system）→ handleCreateTask + saveData。防雪崩：跳过 tags 已含 'recovery' 的 in-flight，避免 recovery 任务自身崩了无限派生。
- **协议变更**：`protocol-module-manager.md` §6.0 加 auto_restart 字段定义 + §6.1 行为详细说明 + §4.3 system.disk_low 事件 schema + 内置模块示例 yaml；`protocol-admin.md` Task 类型尾追加 Recovery Task 约定（标识/来源/优先级/防雪崩/任务描述）。
- **测试**：crabot-core 69/69 + crabot-admin 316/317（pre-existing model-provider 失败跟本次无关）+ admin-web 145/145 + RestartPolicy/DiskWatcher/RecoveryHandler/agent-port-cache/module-rest-api 5 个新单测文件。
- **配套兜底（5/7 同期）**：crabot-agent main 入口加 process.on('uncaughtException'/'unhandledRejection') → 写 ${DATA_DIR}/fatal.log 后 exit(1)；MM 子进程 stdout/stderr 同步落到 ${DATA_DIR}/logs/<moduleId>.log（保留 console 转发用于 dev 体验）。

## 上一里程碑（2026-04-30 — 原生飞书 Channel）

新增 `crabot-channel-feishu` 模块，飞书接入脱离 OpenClaw shim，扫码 onboarding 完整 Web 流程。spec：`crabot-docs/superpowers/specs/2026-04-30-native-feishu-channel-design.md`，plan：`crabot-docs/superpowers/plans/2026-04-30-native-feishu-channel.md`。

- **新增模块 `crabot-channel-feishu`**：基于 `@larksuiteoapi/node-sdk` v1.62.1 长连接事件订阅。结构 = wechat 模块的飞书翻译版（types / SessionManager / MessageStore / event-mapper / FeishuClient / WsSubscriber / FeishuChannel / main）。支持 text/image/file 收发 + mention/quote 特性 + 6 类 IM 事件（im.message.receive_v1 + bot/user 群成员变更 + chat.updated）。WSClient onReady/onError/onReconnecting 状态对接 health。
- **协议化扫码 onboarding**（`base-protocol.md` §10 + `crabot-module-spec.md` §3.2）：新增 `onboarding_methods` 字段，模块声明交互式配置入口；`crabot-shared` 导出 `Onboarder` 接口（begin/poll/finish/cancel），handler 文件 export `createOnboarder()`。**onboarder 由 channel 模块自带**（不在 admin 内嵌平台知识），admin 仅做 UI 编排。
- **channel-feishu/src/onboard.ts**：实现 `Onboarder`，飞书设备码 OAuth（`POST /oauth/v1/app/registration` init/begin/poll）。
- **Admin OnboardingManager**：启动时扫 builtin yaml.onboarding_methods，require(handler) 加载 onboarder 缓存；通用 REST 路由 `/api/channels/onboard/(begin|poll|finish|cancel)`，body 带 `implementation_id` + `method_id`；admin 在 finish 收到 onboarder 返回的 env 后调 `channelManager.createInstance`。SSE 走 `?token=` query string 鉴权。
- **Admin Web UI**：`/channels/new` 数据驱动 picker（按每个 implementation × onboarding_methods 渲卡片 + 各 implementation 独立"手动填写"卡），`/channels/new/:implId/:methodId` 通用 onboarding 页（按 `ui_mode = qrcode/redirect/pending` 切换 widget）。
- **BUILTIN_MODULE_PATHS** 增加 `'../crabot-channel-feishu'`。
- **测试**：channel-feishu 52/52（含 11 个 onboard tests）+ admin 301/301 + admin-web 145/145，0 tsc 错误。

## 上一里程碑（2026-04-29 — Time Awareness）

让 Agent 拥有持续的时间感知能力。spec：`crabot-docs/superpowers/specs/2026-04-29-time-awareness-design.md`。

- **新增 `crabot-agent/src/utils/time.ts`**：`resolveTimezone`（含 IANA 校验 + env / Asia/Shanghai 三级 fallback）、`formatNow`（完整：日期+周+时分秒+offset+IANA）、`formatToolTimestamp`（紧凑：HH:MM:SS / 跨日 MM-DD HH:MM:SS）、`formatChannelMessageTime`（同日 HH:MM / 跨日 MM-DD HH:MM / 跨年 YYYY-MM-DD HH:MM）、`formatTaskCreatedAt`。
- **AgentInstanceConfig 加 `timezone?: string`**：admin types + agent-manager updateConfig 透传 + handleGetAgentConfig 通过 `...config` spread 自动透传给 Agent；web AgentInstanceConfig 镜像类型同步；Admin Web AgentConfig 页面加 timezone input（留空使用 Asia/Shanghai 默认）。
- **Tool result 时间戳前缀**：`tool-orchestration.ts:executeSingleTool` 所有返回路径（成功/Tool not found/Permission denied/Hook block/Tool execution error）统一在 content 前 prepend `[HH:MM:SS]\n`；`front-loop.ts` tool_result push 等价处理；`ToolCallContext` + `EngineOptions` 加 `timezone` 字段透传。
- **User message 顶部当前时间**：`buildUserMessage`（front-handler）和 `buildTaskMessage`（worker-handler）顶部拼 `当前时间: 2026-04-29 周三 18:30:00 +08:00 (Asia/Shanghai)`，作为日期/时区基准。
- **Channel 消息渲染统一**：抽 `prompt-manager.ts:formatChannelMessageLine`，Front recent_messages、Worker recent_messages、Worker trigger_messages 全部切到统一函数（之前 trigger 带 ISO、recent 不带的不一致已修复）。
- **任务字段调整**：Front handler 任务级别"执行已 X 秒"改"创建于 HH:MM"（绝对时间、cache 友好）；保留"第 N 轮"和工具级别"已 X 秒"。
- **System prompt 时间约定**：`FRONT_RULES_SHARED` 和 `WORKER_RULES` 各加"## 时间感知"段，约 80 tokens，被 cache，说明 user message / tool_result / 历史消息 / 任务字段的时间格式语义。
- **测试**：crabot-agent 573/573 + crabot-admin 298/298 + crabot-admin-web tsc 0 errors。手动验证：buildUserMessage 输出含 "[11:57] / [04-28 11:27]" 跨日切换；executeToolBatches 输出含 `[HH:MM:SS]\n<output>` 头部；invalid timezone 自动 fallback Asia/Shanghai。
- **已否决方案**：ephemeral marker（不写回历史无锚点）、每工具自己加（30+ 工具维护成本）、完整格式（p99 增量 1568 tokens 偏大）、按工具选择性（复杂度收益比不划算）、Hermes 式 system prompt 一次性注入（长任务跨小时失准）。

## 上一里程碑（2026-04-28 — Simplify Agent MCP/Skill Config）

砍掉 Agent 实例配置里的 `mcp_server_ids` / `skill_ids` 维度——这一层从来没被 Admin Web UI 暴露过（AgentConfig.tsx 是 unified 单页，没 instance/role 选择入口），数据模型表达 per-instance 灵活性但 UI 没对应入口暴露，是虚假能力。改成全局启用层：MCP/Skill 在各自管理页 enable/disable，所有 agent 实例共用。spec：`crabot-docs/superpowers/specs/2026-04-27-simplify-agent-mcp-skill-config-design.md`，plan：`crabot-docs/superpowers/plans/2026-04-27-simplify-agent-mcp-skill-config.md`。

- **types.ts**：`AgentInstanceConfig.mcp_server_ids/skill_ids` + `UpdateAgentConfigParams.mcp_server_ids/skill_ids` 标 `@deprecated`，软迁移保留兼容期，运行时忽略。
- **handleGetAgentConfig**：返回的 `mcp_servers` / `skills` 改为 `manager.list().filter(s => s.enabled)`（单一真相），不再做"用户绑定 + 内置"两路合并。
- **9 个 mcp/skill REST handler 加 push trigger**：`triggerPushAfter(reason)` 私有 helper + fire-and-forget，每次 mcp/skill 注册/更新/启用/禁用/删除/导入后通过 `pushConfigToAgentModules` 推到运行中的 Agent。新增 4 mcp + 5 skill push trigger 单元测试。
- **AgentConfig.tsx**：移除 MCP/Skill 勾选 section，改为 read-only 列表 + react-router Link 跳转到 `/mcp-servers` 和 `/skills` 管理页；`mcp_server_ids` / `skill_ids` 从 `AgentUnifiedConfig` interface 移除。新增 5 个组件渲染测试。
- **Skills 管理页补 toggle UI**：之前只有 MCP 管理页有启用/禁用按钮，Skills 没有；加 `handleToggle` + `StatusBadge` 启用/禁用 pill + toggle button（仿 MCPServerList pattern）。复用现成 `<StatusBadge status="active|inactive">` 替换内联 rgba。
- **测试**：admin 全套 + admin-web 145/145 + tsc 0 errors，e2e 手动验证通过。

## 上一里程碑（2026-04-25 — Phase A 自学习反馈信号闭环）

修复长期记忆 v2 Observation 观察期 pass/fail 信号链路。设计核心：Front Handler 在 reply / create_task / supplement_task 工具上携带 `user_attitude` 字段（4 档 strong_pass/pass/fail/strong_fail）；代码层根据工具语义自动锚定 task_id（reply/create_task→prev finished task 同 channel/sender 30 分钟内；supplement_task→payload task_id）；调 memory.report_task_feedback 累加 observation_pass_count / observation_fail_count；maintenance.observation_check 按净值判定 pass/fail/extend。spec：`crabot-docs/superpowers/specs/2026-04-25-self-learning-feedback-signal-design.md`，plan：`crabot-docs/superpowers/plans/2026-04-25-self-learning-feedback-signal.md`。

- **memory 侧 5 个 task**：lesson_task_usage 表 + observation_pass_count/fail_count 列；SqliteIndex 三个新方法（record/find/bump）；search_long_term 接 task_id 写表；report_task_feedback RPC + 三处分发表同步注册；maintenance.observation_check 按净值（pass-fail）判定。同步修了 stale_check_count >= 3 分支对 lesson/concept 写非法 maturity="stable" 的 pre-existing bug（按 type 分支：fact→stale / lesson→retired / concept→observation_stale tag）。
- **agent 侧 6 个 task**：types.ts 加 UserAttitude / UserAttitudeNegOnly 类型；front-tools.ts 给 3 个决策工具加 schema 字段；front-loop parseDecisionTool 解析 + 验证 enum；MemoryWriter.reportTaskFeedback fire-and-forget RPC；DecisionDispatcher dispatch 加 reportFeedbackIfPresent + findPrevFinishedTaskId 锚定钩子，删除旧 24h 时间窗 fail 路径；prompt-manager FRONT_RULES_SHARED 加 4 档判定引导（情绪用于判别不用于升级，fail 例子用"算了，就这样吧"避免"嗯，好吧"中性误判）。
- **协议文档**：protocol-agent-v2.md §5.4 加 user_attitude 字段表（含锚定对象映射 + 跳过条件）。同步发现 protocol-admin.md §3.22 误把 Front 决策工具列在 admin 协议里（架构分层错误），已拆分到 protocol-agent-v2.md §5.4 新增"Front Agent 决策工具实现"专节。
- **闭环真正收尾（Task 14）**：plan 当时把"Worker 召回时传 task_id"标了 Out of Scope，实际上不补这一环 lesson_task_usage 表永远不会被写入、整个反馈链路空跑。补 5 处：AssembleParams 加 task_id / FetchLongTermMemoryParams 加 taskId / assembleWorkerContext 透传 / fetchLongTermMemory 加守卫式 spread / decision-dispatcher.ts 创建 task 后传 task.id / mcp/crab-memory.ts MCP search_long_term 调 ctx.taskId。Front 端 tool-executor.ts 不动（Front 没 task_id）。
- **稳定 RPC ordering（I-1 fix）**：`find_lessons_used_in_task` SELECT 加 `ORDER BY lesson_id ASC`，避免 RPC report_task_feedback 返回值依赖 SQLite 隐式行序。
- **测试**：agent 477/477 pass + memory 233/233 pass（含 e2e dispatcher → memory RPC 链路 + 新增 context-assembler task_id 透传 2 测试），tsc 0 errors。
- **已知 follow-up**（不阻塞）：vote count 在 rollback/pass 后是否 reset（spec 未明示）；evolution mode 自动判定（spec §6.2 follow-up）；spec 文本说"maturity stable"应改为按 type 列举合法字面量；test fixture 重复（多个测试构造相同 store/idx/rpc 可提取）。

## 同期解决的前置 in-progress（2026-04-25）

- **N7 版本历史端到端**（spec §9.2）：数据/RPC/分发表/静态锁四层串通——store 旁路 `<id>.versions/v<n>.md`、`get_entry_version` RPC、move/purge 跟随 versions 目录迁移与清理；`tests/long_term_v2/test_rpc_spec_alignment.py` 静态扫 `module.py` 源码 `self._lt_v2_rpc.<name>` 引用集与 `LongTermV2Rpc` 公开方法集做差分，把"加了 RPC 忘了在分发表登记"这类盲区永久关掉。
- **N1-N10 测试覆盖第二轮**：spec §6/§7/§9/§10 细节口子 N1–N10 全部 ✅。修改既有 5 测试（test_maintenance/evolution/chain_of_note/rpc/rpc_update_phase3）+ 新增 6 测试文件（rule_promotion_e2e / pe_concurrent_write / pe_gated_recall_e2e / pe_gated_write_e2e / trash_cleanup_timezone / version_history_e2e）。同步 evolution.py spec §6.4 ≥3 case 晋升门槛硬约束。
- **Front prompt 防 XML mimicry**：原 worker capabilities 注入展开具体 tool 名（screenshot / mouse_click / git_status 等），某些模型（MiniMax-M2.5）看到后直接吐 `<invoke name="X">…</invoke>` 形式 XML 文本污染 reply。改为只列 category 名 + 加"工具调用硬性规则"段明示 Front 唯一可调用工具是 4 个决策工具。

## 上一里程碑（2026-04-24）

- **Memory v2 Phase 5 Admin UI 完成**：Admin Web 长期记忆管理页重做——一级 Tab（全部记忆/观察期）+ 类型/状态 Chips + 搜索 keyword/semantic + 批量操作 + 手动维护下拉 + 观察期面板替代 Proposals 审核（全自动路径）+ 详情 6 段 + 版本历史只读对比；MemoryEntriesPage 彻底清理；路由迁到 `/memory/long-term|short-term|scenes`。spec：`crabot-docs/superpowers/specs/2026-04-24-long-term-memory-admin-ui-design.md`，plan：`crabot-docs/superpowers/plans/2026-04-24-memory-v2-phase5-admin-ui.md`。24 task 全部完成，admin web 132 tests pass，tsc 无错。
- **Memory v2 全部 4 期落地**（2026-04-23）：Phase 1（数据模型 / 文件存储 / SQLite 索引 / v1→v2 迁移）+ Phase 2（6 步 hybrid 召回 + Eval harness）+ Phase 3（PE-Gated Write / Observation / Case→Rule / Frozen Snapshot / Evolution Mode）+ Phase 4（Admin UI 重做 + v1 路径清理 + 协议对齐）。Phase 4 共 22 task，1051 tests pass，验收记录见 `/tmp/memory-v2-acceptance.md`。

## 当前进行中：Agent Engine V2

**目标**：自研执行引擎，支持多 LLM 格式，内置工具，MCP 工具服务器  
**后续设计文档**：`crabot-docs/superpowers/specs/2026-05-15-agent-unified-loop-redesign-design.md`
**分支**：`feat/engine-v2`

### Phase 1 — 引擎核心 ✅ (2026-04-03)
10 个 engine 文件 ~1843 LOC, SDK 已移除, 93 tests

### Phase 2 — 多 LLM 格式 ✅ (2026-04-04)
OpenAI adapter, createAdapter factory, Front handler 迁移

### Phase 3 — 高级能力 ✅ (2026-04-04)
LLM auto-compact, sub-agent, permission system. 累计 200 tests

### Phase 4 — 核心内置工具 ✅ (2026-04-04)
Bash/Read/Write/Edit/Glob/Grep 6 个工具 + Worker 集成. 累计 203+49=252 tests
- [x] Task 17: Bash Tool (7 tests)
- [x] Task 18: Read Tool (8 tests)
- [x] Task 19: Write Tool (7 tests)
- [x] Task 20: Edit Tool (8 tests)
- [x] Task 21: Glob Tool (8 tests)
- [x] Task 22: Grep Tool (11 tests)
- [x] Task 23: Built-in Tools Index + Worker Integration (7 tests)

### Phase 5 — MCP 工具服务器 ✅ (2026-04-04)
Computer Use (12 tests), LSP (7 tests), Git (10 tests). 累计 285 tests
- [x] Task 24: Computer Use MCP (screenshot/mouse/keyboard)
- [x] Task 25: LSP MCP (TypeScript diagnostics, hover/definition stubs)
- [x] Task 26: Git MCP (status/diff/log/commit/branch/stash)

### Phase 6 — Admin 工具注册集成 ✅ (2026-04-04)
Built-in tool config, Skill tool, E2E integration. **全部 311 tests pass**
- [x] Task 27: Admin Built-in Tool Configuration (11 tests)
- [x] Task 28: Skill Execution Tool (5 tests)
- [x] Task 29: End-to-End Integration Test (10 tests)

### LSP 真实协议实现 ✅ (2026-04-04)
- [x] Task 30: LSP Client (JSON-RPC over stdio, 14 tests)
- [x] Task 31: LSP Server Manager (routing + file sync, 17 tests)
- [x] Task 32: LSP MCP Server rewrite (9 operations, 25 tests)

### 协议对齐 + 决策类型简化 ✅ (2026-04-04)
- [x] Task 33: Protocol docs alignment (7 处协议修改)
- [x] Task 34: Remove forward_to_worker → 4 种决策类型 (direct_reply, create_task, supplement_task, silent)
- [x] Task 35: Type alignment (ShortTermMemory, LongTerm, TaskSummary, Features, friend_id)
- [x] Task 36: Rename list_friends → list_contacts, add list_groups

### MCP 基础设施重构 ✅ (2026-04-04)
- [x] Task 37: crabot-mcp-tools 独立包 (Computer Use/LSP/Git stdio 入口)
- [x] Task 38: Admin MCP 注册表扩展 (stdio/streamable-http/sse + 内置注册)
- [x] Task 39: Agent McpConnector (多传输连接 + 工具转换)
- [x] Task 40: Skill 工具修复 (skillsDir 传递)

### Engine V2 重构完成 ✅
**总计**: 40+ Tasks, 298 tests (agent 298 + mcp-tools 2)
已合并到 main

---

## 已完成：去 LiteLLM 化 + ChatGPT 订阅 OAuth ✅ (~2026-04)

Agent V2 引擎直连 Provider 原生 API，LiteLLM 中间层完全移除（包括 dev.sh）。`createAdapter` 工厂按 `format` 路由到 Anthropic / OpenAI / Gemini / openai-responses。ChatGPT OAuth PKCE 落地，`buildConnectionInfo` 内部检测 token 过期并自动刷新。详见 [memory: project_remove_litellm.md](crabot-docs/memory)。

---

## 后续规划：权限系统打通

协议层完整定义，后端基础设施已有，但 Admin UI 和 Agent 工具权限未打通。

### 第一期 ✅ — 让当前能跑通（master 自用）
- [x] Worker 用 `bypass` 模式，所有工具可用
- [x] engine permission-checker 基础设施（allowList/denyList/bypass/callback）
- [x] deriveMemoryPermissions 已实现（master 无限制 / normal 按 session scope 过滤）
- [x] `ToolPermissionConfig.checkPermission` 回调接口支持路径级细粒度控制

### 第二期 — Admin UI 权限管理（让 master 能配置）
- [ ] 权限模板管理页面（CRUD 自定义模板，系统预设: master_private/group_default/minimal/standard）
- [ ] Friend 详情页增加权限模板选择器（permission_template_id）
- [ ] Session 配置页面（查看/编辑 permissions、memory_scopes、workspace_path）
- [ ] 内置工具管理页面（启用/禁用/权限级别覆盖，对应 BuiltinToolConfig）

### 第三期 — Agent 侧权限打通（让配置真正生效）
- [ ] 新增 `deriveToolPermissions(sessionPerms)` → `ToolPermissionConfig`
- [ ] Session.permissions.desktop → 控制 computer-use 工具
- [ ] Session.permissions.storage → 控制 Read/Write/Edit/Glob/Grep 路径
- [ ] Session.permissions.network → 控制 fetch/Bash 网络访问
- [ ] workspace_path → Worker task 沙箱根目录
- [ ] Worker 从硬编码 `bypass` 改为 `deriveToolPermissions` 动态计算

---

## 系统架构

```
Module Manager (port 19000)
├── Admin (RPC 19001, Web 3000)
│   ├── Friend / Permission 管理
│   ├── LLM Provider 管理（buildConnectionInfo 解析为 Provider 原生连接信息）
│   ├── MCP Server + Skill 注册表管理（全局管理 + Agent 配置引用）
│   ├── Agent 配置管理（含 MCP Server/Skill 关联）
│   ├── Web 管理界面 + Master Chat (WebSocket)
│   └── 消息鉴权网关（channel.message_received → channel.message_authorized）
├── Agent (port 由 MM 分配)
│   ├── Front Handler（快速分诊，默认 10 轮，3 次重试）
│   └── Worker Handler（深度执行）
├── Memory (Python, port 19002)
│   └── 短期/长期记忆（LanceDB 向量检索）
└── Channel(s)
    └── 微信 / Telegram / 飞书 原生模块
```

## 端口分配

| 服务 | 端口 |
|------|------|
| Module Manager | 19000 |
| Admin RPC | 19001 |
| Admin Web | 3000 |
| Memory | 19002 |
| Agent | 19005+ |
| Vite Dev | 5173 |

---

## 已完成

- [x] Module Manager — 生命周期、端口分配、事件总线
- [x] Admin 模块 — Friend 管理、Task/Schedule、LLM Provider、Agent 配置、Master Chat、PTY 终端
- [x] Agent 模块 — 编排层 + Front/Worker Handler，多格式 LLM 适配器（Anthropic/OpenAI/Gemini/openai-responses）
- [x] Memory 模块 — 短期记忆读写、向量检索、管理界面
- [x] Channel 飞书 — 完整 protocol-channel.md 实现
- [x] Channel OpenClaw Shim — 插件兼容层，jiti 加载 TS 插件
- [x] 消息鉴权网关重构 — Channel 只发布原始消息，Admin 做 Friend 解析和鉴权，Agent 订阅 channel.message_authorized
- [x] MCP Server + Skill 系统 Phase 1 — 全局注册表（protocol-admin.md §3.16/3.17 扩充），Admin 后端 Manager（MCPServerManager/SkillManager/EssentialToolsManager），Admin 前端 CRUD 页面，Agent 配置 ID 引用解析
- [x] Agent Loop 可观测性 — 通用 Trace 规范（protocol-agent-v2.md §8），Ring Buffer TraceStore，前后端可视化 Trace/Span 树
- [x] Front Handler 工具调用改进 — 保留默认工具集，maxTurns 1→3，结果路由（JSON 决策/纯文本/工具失败自动升级），简单任务直接执行、复杂任务创建 task 派 Worker
- [x] Agent 模块 Skills/MCP/聊天历史/crab-messaging 修复 — Skills UI 简化，消息预加载量优化（Front 10 条 / Worker 20 条），crab-messaging MCP Server 5 工具实现，对齐 protocol-crab-messaging.md，路径安全验证，TypeScript 编译零错误
- [x] 记忆管理界面重构 — `/memory/entries` 条目页模式拆分（browse/search/context）、长期记忆 browse API、SceneProfile 详情强化（描述非空校验 + 来源记忆链接）、SceneProfile 治理视图、记忆→画像反向链接、`/memory` 路由精简为直接跳转条目页；前端/后端定向测试与浏览器自测已通过
- [x] McpServer Protocol reuse bug 修复 — Claude Agent SDK 在 Front Handler 重试或并发消息时抛出 "Already connected to a transport" 错误；根因是 `createCrabMessagingServer()` 在 `initializeAgentLayer()` 中只调用一次，所有 `runSdk()` 共享同一个 McpServer 实例，SDK 的 `Protocol.connect()` 不允许重复连接；修复方案：将传入的 `SdkMcpServerConfig` 对象改为工厂函数 `() => Record<string, SdkMcpServerConfig>`，每次 `runSdk()` 调用时创建新的 McpServer 实例；涉及文件：`unified-agent.ts`、`front-handler.ts`、`worker-handler.ts`，TypeScript 编译零错误
- [x] SwitchMap 私聊消息合并 — 同 session 新消息到达时，被中断的消息 A 与新消息 B 合并为 `[A, B]` 一起传给 LLM（协议 §5.1）；`SwitchMapHandler` 新增 `pendingBatches` 追踪批次；`unified-agent.ts` 三处调用点（`processDirectMessage`/`handleProcessMessage`/`processAdminChatMessage`）均更新；dispatch 前增加 abort 检查防止并发双发 reply
- [x] 群聊 Debounce 消息合并 + 群聊行为改进 — 群聊已通过 DebounceHandler 合并批次传给 Front Agent；新增 `SilentDecision` 类型；Front Agent 群聊默认静默，仅 @提及或明确提问时回复；提示词外部化到 `prompts.md`（根目录），修改后重启生效
- [x] Front/Worker Handler 系统性修复 — 修复 `maxTurns` 硬编码为 3 的 bug（现在正确读取 `maxIterations` 配置）；Front 默认轮数 3→10；Worker 默认无限制轮数（不传 `maxTurns`）；提示词明确区分"已预注入的上下文"与"需工具查询的更多历史"；`prompts-worker.md` 外部化到根目录
- [x] supplement_task 纠偏机制 — Front Agent 识别用户对活跃任务的纠偏/补充消息，通过 interrupt() + streamInput() 直接注入运行中的 Worker，支持 confidence high/low 路由
- [x] Worker 进度报告改进 — 基于实际工具调用的自然进度报告，避免 generic "执行中"；content-type 判断；进度与最终结果去重
- [x] 群聊决策质量优化 — buildUserMessage 群聊 prompt 改进（参与者列表、Crabot 身份标识、sender role 标注、silent 引导）；system prompt 群聊规则强化（"你是旁听者"）；context-assembler session type 修复
- [x] Agent Trace 可观测性增强 — full LLM input/output 记录到 trace span；群聊消息批次快照；Trace 磁盘持久化（daily JSONL）
- [x] Admin guest authorization 修复 — 群聊 guest 鉴权路径缺失 return 导致消息重复处理
- [x] Channel Host 主动推送 — 通过插件 outbound adapter 主动发送消息（不依赖入站消息的 pendingDispatch），支持跨渠道发送场景
- [x] 微信 @Crabot 检测 — 通过 at_string 检测群聊 @提及，缓存群昵称
- [x] crab_display_name 管线 — Admin → Agent 传递 Crabot 在 channel 上的显示名
- [x] PromptManager 统一提示词管理 — 提示词分三层（personality / rules / additions），`data/agent/prompts/` 目录统一管理，Handler 不再自行加载提示词文件
- [x] 端到端集成测试 — 飞书/OpenClaw → Agent → 回复完整链路，验证群聊静默、私聊合并等新行为

---

## 待实现

### 🟡 中优先级

| 功能 | 说明 |
|------|------|
| AgentConfig `extra` 字段 | 支持热更新扩展配置，Admin UI key-value 编辑器 |
| 短期记忆压缩 | 保留窗口 + 语义无损压缩 |
| 长期记忆去重/合并 | CREATE/UPDATE/MERGE/SKIP 决策 |
| 混合检索 | 语义 + BM25 + 元数据多路召回 |
| MemoryBrowser 测试 OOM | `crabot-admin/web/src/pages/Memory/MemoryBrowser.test.tsx` 在当前 Vitest 环境下触发 worker out of memory，需后续拆分或瘦身测试 |
| Permission Template CRUD | 权限模板管理 |

### 🟢 低优先级

| 功能 | 说明 |
|------|------|
| Worker 多实现 | worker-code (claude-agent-sdk), worker-general (pydantic-ai) |
| Agent 自我进化 | 代码生成、自动测试 |
| Channel 微信 / Slack | 更多平台适配 |

---

## 运行命令

```bash
./dev.sh          # 构建 TS + 启动所有服务 + Vite HMR (5173)
./dev.sh stop     # 停止所有进程
./dev.sh build    # 只构建不启动
./dev.sh vite     # 只启动 Vite
```
