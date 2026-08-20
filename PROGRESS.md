# Crabot 项目进度

> 最后整理：2026-08-19
> 本文件只保留当前状态、明确 follow-up 和阶段性里程碑；详细实施流水、逐轮 review 与历史测试输出见 Git 历史。压缩前完整版本可用 `git show 49b9cb4:PROGRESS.md` 查看。

## 当前状态

### P6 已完成；Manager -> Worker 输入与侧问可靠交付待 PR review

### CLI 第三方 Worker 交互生命周期：已确认，实施中

- 已确认设计与 `protocol-agent-v3` 3.5.0 契约：Claude Code / Codex 的当前交互 TUI 由 Harness 以当前 pane 观察、一次性 fingerprint 分流；Claude 的“退出规划并开始执行”仅在后置状态可证明时直接处理，未知或失败界面一次性唤醒 Manager。启动基线改为 Claude `auto`、Codex `--approve-for-me --sandbox workspace-write`；实现按独立 worktree、定向测试和本地真实 E2E 后走非 Draft PR，不自行合并。

### 模块关闭与孤儿模块回收：已合并（PR #99 → `bf989ec`）

- 已确认设计：`crabot-docs/superpowers/specs/2026-08-16-module-shutdown-orphan-fencing-design.md`；实施计划：`crabot-docs/superpowers/plans/2026-08-17-module-shutdown-orphan-fencing.md`。
- Agent shutdown 统一释放 builtin/Claude Code/Codex adapter 资源，关闭后不重建 CLI watcher，也不终止独立 tmux Worker。
- MM 通过实例级 runtime registry 在启动和 replacement 前回收已识别的历史模块树；Windows 身份不明、拒绝、`-d` 或无 TTY 均在任何受管模块启动前失败退出。supervisor 为 MM 保留 60 秒关闭窗口加 10 秒余量。

- P6 总体设计：`crabot-docs/superpowers/specs/2026-08-11-p6-agent-observability-worker-management-design.md`；五份实施计划在 `crabot-docs/superpowers/plans/2026-08-12-p6-*.md`。顺序固定：**Slice 0 → P6-A → P6-B → P6-C → P6-D**。
- Slice 0 **已合并**（PR #90 → merge `377200e`，15 轮 review、28 条 finding 全部修复并 resolve）。核心交付：唯一核心 Agent + 动态/legacy Agent 只读归档、runtime bearer identity（per-child 绑定/撤销、启动即从 env 摘除）、authenticated config pull（单飞+退避自愈、降级启动 fail-closed 存活）、management-only cutover（幂等 marker + 宽容握手 + degraded-only health）、durable config revision（outbox 三态 + HMAC fingerprint + journal binding + seqlock 一致性读）、sensitive RPC 独立 transport、legacy get_config/update_config 无认证端点退役、noop-safe 全部配置写入路径、容错 MCP 热更 + 候选连接清理。协议同步：protocol-agent-v3 3.1.1 §8.5/§8.6/§11、protocol-admin §3.18/§3.19/§7.1、protocol-module-manager §3.18.1：
  - 唯一核心 Agent：动态/legacy Agent 的 create/update/delete/config-write 全部拒绝（`ADMIN_HOTPLUG_NOT_ALLOWED` / HTTP 410），live read surfaces 只暴露 builtin `default` / exact `crabot-agent`；存量记录只读归档（`unsupported_legacy`）。
  - Runtime identity + authenticated config pull：MM 只向 exact `crabot-agent` child 注入一次性 runtime bearer；Agent 启动最早期捕获并从 env 删除；secret-bearing RPC 走 method-closed `callSensitive()`；启动与热更都经 authenticated pull，失败即 fail closed 并断开 stale MCP。pull 有单飞去重 + 旧 revision no-op + 失败退避重试（不会永久 stale）。
  - Wire 契约：authenticated pull 返回正式 `CoreAgentRuntimeConfig`（protocol-agent-v3 §11，当前 `protocol_version: '3.4.0'`）；实例配置为 slot 制（`powerful` 必填），legacy `roles` 不是 wire 字段。
  - **降级启动自愈**：全新安装未配置 LLM 时 Agent 不再退出，进程存活照常注册，所有执行入口 fail closed，靠退避 pull 自愈；首次安装补建 worker 层（roles/LSP），无需手动重启。
  - Management-only cutover + durable config revision（seqlock 一致性读、HMAC fingerprint、Skill journal binding、publish 失败退避 drain 自愈）。
- **部署约束**：pre-P6 存量生产不得部署 Slice 0/A/B 中间态；首次 rollout 至少包含 Slice 0 + P6-B grandfather bootstrap + P6-C 最终选择语义。

### Manager -> Worker 输入与侧问可靠交付（实现完成，待 PR review）

- 已确认并发布设计、计划和 `protocol-agent-v3` 3.2.1 契约（crabot-docs `d4b4e50`）：`send_to_worker` 使用持久 receipt 返回 `delivered / pending / failed`，5 分钟内有限收口；失败及 pending 后终态只有被原 Manager episode 以 `consumedEvents=true` 消费后才确认完成，Agent 重启不自动重发输入。
- `query_worker` 改为同步建立 fork 和提交首问、异步生成回答，不进入主 TUI 排队；builtin、Claude Code、Codex 统一“fork + 首问接受后返回”契约，Codex 使用 app-server `thread/fork + turn/start`。
- 实现分支 `feat/manager-worker-operation-reliability` 已 rebase 到包含 #99/#100 的主线；adapter 关闭保护与可靠投递契约均保留，待 PR review。
- **2026-08-18 tmux 投递热修已发布**（main `9138713`，本机实例已重启验证健康）：tmux pane 不再继承 `TERM=dumb`；Manager 的 `raw: true` 仅接受 tmux 控制键并在投递前拒绝混入任务正文的 payload，普通任务文本仍走既有 WorkerInbox 生命周期。尚待自然新流量验证实际启动确认与后续正文投递。

### Worker 任务巡检与定期汇报：已合并（PR #106 → `552191d`）

- 已确认并发布设计和 `protocol-agent-v3` 3.2.2 契约（crabot-docs `bbcea9e`）：默认每 15 分钟例行巡检与人类明确的定期汇报是 stable `worker_id` 上互斥的监督规则；前者可在仅工具活动时由 Harness 静默过滤，后者必须由 Manager 向固定会话成功 `send_message` 才消费。
- 已合并实现：三种 adapter 以原生结构化 trace 分类 `text / tool_only / none / unknown`；Harness 持久化游标、到期责任与退避；Manager 提供设置/清除定期汇报工具、严格消费条件和默认只读巡检片段压缩。定向 Harness/Manager 295/295、adapter 212/212、TypeScript 检查均通过。
- **2026-08-19 规模修复已发布**（main `62f2b9e`）：启动恢复、巡检准备与到期投递统一限制为 8 个并发 ledger 读取；终态及无主线/不可执行化身的记录在枚举后直接跳过，避免同一大 ledger 被数千次并发解析而 OOM。

### 最近验证基线（2026-08-18，可靠交付实现分支）

- Agent 可靠交付核心定向测试 17 文件 `468/468`；Manager 定向 `113/113`；Harness 定向 `104/104`；Codex runtime 清理与 Claude streaming fork 精确回归均通过。
- Agent 全量 `2781 passed / 4 failed / 2 skipped`：其中 3 条是干净 main 同样复现的 macOS `/var` realpath 基线失败，1 条 tmux 探测超时单独重跑通过。
- Agent TypeScript build 与 `git diff --check` 通过。

### Manager / Worker v3（已生产运行，背景）

- PR #76～#89 完成 CLI worker 输入/活性/权限/ManagerKey、legacy loop 退役、bg-shell durable notification、worker-scoped MCP、Admin Chat assertion、会话隔离与 v2 只读导入；生产切换见里程碑归档（`git show 49b9cb4:PROGRESS.md` 有完整细节）。

## 当前 follow-up

### P6 后 Traces / Worker 生命周期（当前主线）

- **Traces 人话视图 + 有界决策视野**：**已合并**（PR #100 → `f7e3aaf`，@claude approve 后自动合并）。Managers 用 `渠道·会话标题`、active worker 数和最近活动替代裸 ManagerKey/Episodes/历史总数；Manager detail 上浮消息摘录/回复/动作并按 worker 因果链折叠；Workers 默认只显示非终态。恢复 v2 dispatcher 不变量：`list_workers` 默认只看 `queued/running/waiting_input`，终态续办需显式分页 `include_terminal=true`；Manager 页面计数与工具视野同源。生产实测 system-tasks 2389 历史→6 active，工具实际 12 active/53 terminal。协议：agent v3.2.0、admin v0.2.2。
- **CLI Worker 可读终端画面（v3.4.0，实施完成，待 PR review）**：cc/codex 的 `pipe-pane` 原始字节只驱动 bracketed-paste 状态机，不再落盘或解码；存活主线化身通过 `tmux capture-pane -p -J` 返回当前画面，终态只覆盖保存最后一个非空快照。`get_worker_terminal` / Admin `/terminal` 统一区分 live、final、headless 纯文本与明确 unavailable；headless fork 维持自身纯文本 artifact。已确认 spec：`crabot-docs/superpowers/specs/2026-08-19-cli-worker-readable-terminal-design.md`。
- **CLI 第三方 Worker 交互生命周期（v3.5.0，实施完成，待 PR review）**：只由 Claude `Notification`、Codex `PermissionRequest` 或 Agent 重连存活 pane 触发一次按需 capture；无输出观察器或后台 capture。Claude 固定 `auto`，计划完成的两种已验收界面由 Harness 固定 `1 Enter` 并校验仍为 auto；Codex 保持“帮我批准”隐含的 `workspace-write`，仅自动信任隔离 `CODEX_HOME` 内由 Harness 生成的 PermissionRequest hook。Codex 0.147 的 argv 为 `--approve-for-me -c sandbox_workspace_write.network_access=true --dangerously-bypass-hook-trust`（显式 `--sandbox workspace-write` 与前者互斥）。真实 adapter E2E 已验证 opening input accepted、隔离 config/auth 均为 `0600`、一次权限请求与一次 `stop`，且没有 Manager interaction_required。未知界面一次性唤醒 Manager。
- **统一 observability retention（PR B，已确认 spec/协议/计划，待实施）**：自动回收终态 Worker 的 adapter output/session、events/context、ledger、过期 Manager episode/TraceStore；孤儿 adapter/events 24h grace；output log 10MB cap；删除失真的 Trace 清理 UI/API/cron。**所有 workspace 零自动删除**——`$DATA_DIR/workspaces/<taskId>` 是用户项目/任务产物，不是 cache；当前 nomi-ai-companion 的 1GB Flutter workspace 必须保留。workspace 管理/显式删除以后独立设计。

### P6 主线（严格串行）

1. **Slice 0 收口**：已完成并合并（PR #90 → `377200e`）。
2. **P6-A 可观测性 / Admin Chat correlation**：**已合并**（PR #92 → `4fbbf96`，用户手动合并；8 轮 review、30+ 条 finding 全部修复并 resolve）。交付：Manager episode trace（TraceStore kind 判别 + admission fail-closed + 启动收口 + 内存有界驻留）、`/api/agent/managers*` + episodes RPC、worker composite trace reader（opaque cursor + native copy 终态收割 + builtin 结构化 trace）、v2 raw trace REST/RPC 退役、v3 Managers/Workers UI、Admin Chat delivery 事务（入站 fingerprint CAS + dispatch outbox + delivery journal + wire/staged payload 同源 + 双侧 journal GC + index 自愈），chat_callback 退役、FIFO 认领删除。另带出一个独立修复：模块代理配置持久化（main `43aeb5f`，修 telegram 启动竞态）。生产实测通过（E2E chat 全链路、幂等重放、重启持久化回归）。计划：`2026-08-12-p6-a-observability-admin-chat-correlation-plan.md`。
3. **P6-B Worker 安装/连接/验证/setup**：**已合并**（PR #94 → `0d6e91a`，15 轮 review 收敛；用户手动合并）。运行实例已切到 main 部署并实测健康（三 impl 全 ready）。**2026-08-16 追加修订已合并（PR #95 → `56cf974`）**：移除 managed install（用户级 binary only + 全局安装检测提示），修复 codex 代际自杀 bug（`ce45316`）。交付：desired store+CAS、activation registry（ready 唯一判定）、6 个版本化 translator、managed installer（固定 manifest+原子 active）、operation assertion、真实 verify、grandfather bootstrap 事务、Workers 管理页。**已确认修订**：取消 setup PTY（无 auth.json 上传/订阅迁移/TUI login），配置矩阵 = CC setup-token / CC·codex BASE_URL+KEY / existing_host。生产 E2E 全通（含真实 install/verify/spawn）。计划：`2026-08-12-p6-b-worker-onboarding-plan.md`（含 2026-08-14 修订）。 Review follow-up 池（P6-C/D 收口）：degraded 触发面扩展——当前只有 binary 缺失抛 WorkerImplUnavailableError，pane 内真实失效（登录过期/权限/版本阻塞）以化身终态呈现、不做 impl 级归因，需从终态 report 归因的独立立项；verification binding 的 policy_revision 粒度——现为整份 worker config 的 revision，任何一个 impl 的配置变更都会让**所有** impl 的验证失效（用户实测：验证 CC 后 codex 变未验证）。疑似用户先改了 CC 配置（PUT 导致 revision+1）再验证 CC，codex 的 binding 随之 stale。考虑改 per-impl policy_revision 或在 UI 提示「改配置会使其它 impl 需重新验证」；operation 占位前置防 TOCTOU 双跑、assertion tmp 随机后缀、created_at 终态不重置、403 改读 body.code、孤儿 provider 回收、worker 代理出口注入、spawn 初期输入竞态自恢复、WorkerOperationStore TTL。
4. **P6-C Worker 选择语义**：**已合并**（PR #97 → `e3b5b4f`，review approve 后自动合并）。纯选择器（显式不 fallback/省略 default→固定序）、registry snapshot + 轻量 fence、Manager `list_worker_implementations`、default/preference 全量编辑、Workers 页完善。fence 的 revision 绑定/barrier 测试列为 follow-up。
5. **P6-D legacy runtime retirement**：**已合并**（PR #98 → `feac341`，3 轮 review 9 条 finding 全修后手动合并）。LegacyAgentArchiveStore（summary/export/显式 delete + tombstone + journal）、AgentManager 收窄 core-config-only、dynamic 写面全删、backup import 两阶段 preflight、crabot-info 去 legacy、Modules UI archive 化。P6 正式收口。

### 技术债与既有 follow-up（P6 后或并行确认）

- **关闭窗口终态事件补投**：Worker 的终态事件已落盘但 Manager 正在关闭窗口时，现有启动对账会跳过终态记录，Manager 可能不知道 Worker 已异常结束。需独立设计持久化待消费终态事件的恢复与去重；任务巡检不替代此修复。
- **Worker 巡检调度收口**：启动对账与周期巡检应共享 due 投递排他；避免单个 Worker 的长锁阻塞全局活性巡检；默认巡检在全局 LLM 故障时需要有界的失败告警去重/退避。三项均需独立设计，不纳入当前任务巡检 PR。
- **移除 Agent 内部 legacy `roles` seam**：`AgentLayerConfig.roles` 是 v2 前多 Agent 时代残留（正式协议从未包含），现仅作内部测试 seam/恒真分支；应替换为显式的 worker-layer 开关后删除。
- **普通 Channel 未消费人类 wake 的跨重启恢复**：2026-08-19 实测，飞书私聊消息已落 Channel journal、reaction 已发且同 session Manager episode 已创建，但 Agent 在首次 LLM 调用前 OOM 重启；启动恢复只将遗留 episode 标为 `interrupted`，未将该 wake 重放，后续 worker 事件遂基于旧上下文回复。需独立设计普通 Channel 的持久化入站 wake、成功消费后结算、重启按原始顺序幂等重放；不得用扩大 Manager recent、滚动摘要或 prompt 约束替代。
- 失败 Manager episode 的通用带退避 mailbox retry；跨 session 代发目标 Manager 持久注记（§4.2）；Admin skill → worker capability 接线（skill 仍硬编码 `[]`）；Codex provision `auth.json` 错误吞没；P8 调试工具/内部文档重写。
- incarnation seq 碰撞（已接受边界，根治需协议变更）；Claude project-scope MCP 文件（已接受边界）；权限 schema 纪律（新增 schema 前先迁移历史 worker context）。
- Admin source manager 的完整两阶段回滚：当前 mutation 源写入失败且内存态已推进时，靠重启恢复 fail-loud 兜底；各 manager 的事务性回滚（磁盘为准）另行设计。
- claude-review workflow 已修 retry 阶梯（main `55f9f3a`）：Verify attempt 1/2 加 `continue-on-error`，否则首次未提交 review 直接跳过 attempt 2/3。
- reviewer bot 的 OAuth token 有 session 配额（约 10 轮高强度 review 后触发 "session limit"，按 UTC 时间窗口重置）；配额耗尽时 review run 会即死，等重置后重触发即可。
- `handleGetAgentConfig` 的 epoch 有界重试会整体重放 MM verify/get_module 往返（失败模式下最多 ~26 倍验证调用）；后续可把重试收缩到解析段内部。
- Admin Web SubagentEditor 的 `crab_messaging` 开关置灰（下发时被协议硬置 false，UI 与行为不一致）。
- tests 未进入 TypeScript type-check 的债务；Agent 4 个 macOS 基线失败的独立校准。

### 非主线历史候选

备份导入 Plan 2、Memory 压缩/去重/混合检索、Windows 进程树、Claude Code 容器化/沙箱等需分别重新确认，不是当前已批准计划。

## 里程碑归档

| 日期 | 里程碑 |
|---|---|
| 08-13 | P6 Slice 0 开 PR #90：核心 Agent singleton、runtime bearer identity、authenticated config pull、management-only cutover、durable config revision、降级启动自愈；两轮 @claude review 意见全部修复，全模块测试基线刷新（Admin 1139/1139 首次真正全绿）。 |
| 08-11 | PR #86（merge `9546bae`）生产 cutover：2696 条 v2 task 一次性只读导入，legacy continuation、Admin Chat assertion、会话隔离与 Claude/Codex 真机 E2E 通过。 |
| 08-09～10 | PR #84 worker-scoped MCP capability；PR #82 CLI 交互输入提交；ManagerKey 会话台账与 v2 legacy 只读导入完成。 |
| 08-01～09 | PR #80 legacy 执行/恢复控制面退役 + builtin bg-shell durable delivery；PR #77/#78 Claude Code 真机修复；worker 活性信号纠偏。 |
| 07 月 | Manager/Worker P1～P5+P7 主链完成（adapter、ledger/harness、manager loop、read model、scheduler 路由）；agent-venv、subagent 模型实时解析。 |
| 06 月及更早 | Engine V2 + Provider 直连（LiteLLM 移除）、Memory v2、原生飞书、Master Chat、备份导出、Admin UI 等；详见 `git show 49b9cb4:PROGRESS.md`。 |

## 当前架构真相源

为避免本文件复制并腐化架构说明，以下内容不再展开：

- 项目开发与流程规则：根目录 `AGENTS.md`。
- 正式模块契约：`crabot-docs/protocols/`（base/module-manager 0.2.2、admin 0.2.1、agent-v3 3.5.0、crab-messaging 0.3.2、module-spec 0.2.0）。
- 设计决策与实施计划：`crabot-docs/superpowers/specs/` 与 `plans/`。
- 开发、部署、调试说明：`AGENTS.md` 与 `crabot-docs/guides/`。
