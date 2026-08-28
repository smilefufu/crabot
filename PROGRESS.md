# Crabot 项目进度

> 最后整理：2026-08-28
> 本文件只保留当前状态、明确 follow-up 和阶段性里程碑；详细实施流水、逐轮 review 与历史测试输出见 Git 历史。压缩前完整版本可用 `git show 49b9cb4:PROGRESS.md` 查看。

## 当前状态

### wechat 群聊门控（@ + 引用放行）：已合并（PR #124 → `ffd32e55`）

- 已确认 spec 与计划发布到 `crabot-docs` main（`2631a13` / `d4d9560`）：`protocol-channel.md` 0.1.2
  §4.2 把 only_respond_to_mentions 字面扩展为「定向」语义（定向 = @ Crabot，Channel 可选扩展引用放行；
  feishu 仅 @，wechat @ + 引用）。
- 引用判定走 connector 反查补齐的 `quoted_sender_wxid === puppet.wxid` 精确对照（BOT_INTEGRATION.md
  §type=18 字段契约）；反查失败（字段缺失）直接丢弃，不做名字模糊降级。
- `feat/wechat-group-mention-gate`（PR #124）：module.yaml 开关（default false=行为不变）+ main.ts
  env 链路 + handleWechatEvent 门控（丢弃不建 session 不发布）+ 补齐协议 §6.1 MUST 的
  get_config/update_config。新增 16 用例 + 既有 62 全绿。
- @claude 四轮 review 共 7 条真实风险全部闭环、复审④ approve 后自动合并（squash `ffd32e55`）：
  ①update_config 字符串开关静默 no-op（`ce3f1feb`）②
  x-runtime-path 部分标注致 running 实例配置面板退化——用户确认撤回 spec §4.4 排除项，config RPC
  对齐 feishu 完整模式（`61c93baa`，spec 修订 docs `4c9f724`）③引用消息 agent 侧延迟巡检——
  follow-up（见技术债段）④占位文件漏删；三审 ⑤webhook_port 数字字符串（`edde5577`）⑥运行时
  配置不落盘——follow-up ⑦webhook_secret 请求回调实时读取（启动时快照修复 `72ff8a82`）。
- **人工验证待做**：真实群 ① 普通发言不触发 ② @ 触发 ③ 引用 Crabot 触发（预期延迟一个巡检周期）
  ④ 重启后开关回退 false（已知限制，见技术债③）。需重建重启 wechat channel 生效。

### 群聊响应纪律 prompt：已合并（main `d8ad16c3`）

- v3 拆分退役 Pre-Front Dispatcher 时，群聊静默判断语义（收件人判定优先 / 必须沉默 / 禁止沉默）
  未迁移到 manager prompt，生产实测群成员互聊时 agent 连发多条附和消息（插话正反馈：每次发言把
  群聊巡检间隔重置回 min）。
- 已把判据迁回：`isGroup=true` 的 manager system prompt 追加 `GROUP_CHAT_DISCIPLINE` 段
  （`manager/prompt.ts`），判据逐条来自 2026-05-19 / 2026-05-15 spec 的 dispatcher 群聊 triage，
  信号形态对齐 `formatChannelMessageLine` 渲染；另补 v3 新形态语义「刚发过言后不接话茬」。
- `isGroup` 走 `promptInputs` 通道（principal 缓存的 sessionType）；私聊 / 系统线程 / 每日反思
  装配结果与改动前逐字节一致（测试钉住）。改的是 agent 源码，需重建重启 agent 生效。

### P6 已完成；Manager -> Worker 同步输入投递待 PR review

### Manager / Worker 内置能力归属：实现完成，待非 Draft PR review

- 已确认设计、实施计划和正式协议已发布到 `crabot-docs` main（`f27661e`）：`protocol-agent-v3`
  3.6.13、`protocol-memory` 0.3.5。builtin、Claude Code、Codex 共用主线 Skill 策略；CLI Worker
  通过绑定 `worker_id` 的 task-scoped stdio MCP 获得五个 tmp-page operation，Crabot 生图保持
  builtin-only。
- Manager 精确保留 18 项 Memory LLM 工具，所有主线 Worker 和 builtin direct child 均不再装配
  Memory；`run_maintenance` 只保留既有非 LLM RPC 路径。direct child 的 Skill loader 按
  `allowed_skill_ids` 重建，CLI reprovision 会清理已撤销的 Crabot 受管 Skill。
- 能力归属相关 Agent 定向用例均通过；真实 stdio bridge `2/2`、builtin 生产装配 `20/20`、Admin
  `58/58`、Admin Web `14/14` 通过，Agent/Admin/Admin Web `tsc --noEmit` 通过。Agent 综合批次仅余一条
  `Goal 模式深度说明` 旧断言失败，已在未改动的 `origin/main` 同样复现。

### Manager -> Worker 同步输入投递：实现完成

- `send_to_worker` 在一次有界同步尝试内只返回 `delivered | failed`，不再把 `pending` 暴露给 Manager；输入面不安全、提交确认不确定和超时分别返回稳定原因码与确定性。
- Manager 活跃 episode 期间到达的 Worker hook/状态通知直接进入当前 mailbox，下一次 LLM 调用批量读取；同一 Worker 的同步投递计数按引用计数维护，避免并发调用提前关闭通知等待。
- 投递 deadline 收紧为 120 秒；Harness 增加 wall-clock 兜底并隔离迟到 adapter 结果，tmux `execFile`、`load-buffer` 与版本探测均有 15 秒命令上限。
- 相关协议与设计记录已同步到 `crabot-docs`（main `12f52b6`）；待主仓非 Draft PR review。

### Worker activity 错误证据及时投递：实现完成，待非 Draft PR review

- 已确认并发布 `crabot-docs/superpowers/specs/2026-08-27-worker-activity-notification-delivery-design.md`、实施计划和 `protocol-agent-v3` 3.6.12：Claude Code/Codex 的已确认原生错误进入既有 activity 证据流，不新增 Worker/task 错误状态，也不新增 activity resolve 操作。
- `activity_available` 只有实际进入 Manager 的 LLM 输入后才确认投递；准入前失败继续保留，准入后 Provider 失败不重复注入。Manager 收到 `has_error=true` 时必须读取对应 cursor 范围的完整 activity，不能用 `idle` 否定错误证据。
- 最终定向回归覆盖 adapter、activity projection、composite reader、Harness、Manager、query loop 与人类消息 reaction 时序：12 个测试文件 `552 passed / 84 skipped`；`tsc --noEmit` 与 `git diff --check` 通过。
- Agent 全量测试在非沙箱环境为 `2812 passed / 18 failed`，剩余文件单线程复跑收敛为 9 个失败；其中 5 个已在 `origin/main` 基线复现（runtime-config 重试时序 1、陈旧 Goal prompt 断言 1、macOS `/var` 路径断言 3）。真实 tmux 组因基线当轮探测失败而跳过，无法做严格同条件对照，保留为 PR 残余验证说明。

### 运行态立即改向：实现完成

- `send_to_worker` 已增加可选 `immediate_redirect`。非 builtin 由 Harness 先执行并核验既有 interrupt operation，再投递改向文本；builtin 不 abort，下一轮 LLM 调用前优先消费该输入；普通排队文本不得越过 redirect。
- Claude/Codex interrupt 使用 Escape；每次按键后等待并 capture，只有画面仍明确显示执行态且发生可观察变化才允许再按，禁止 100ms 连按或预排队。相关协议/已有设计文档已同步，临时 spec 已删除。
- Manager prompt 已统一使用“执行器”表述：新任务按有效实现、部署偏好与短任务 builtin 偏好选择；复用旧上下文时按等待投递、运行中补充/纠偏或 fork 侧问分流。

### 本地宿主工具大文件安全与进程隔离：实施完成，待非 Draft PR review

- 已确认设计与计划：`crabot-docs/superpowers/specs/2026-08-25-tool-process-isolation-design.md`、
  `crabot-docs/superpowers/plans/2026-08-25-local-tool-execution-safety.md`。`Read`、`Write`、`Edit`、
  `Glob`、`Grep`、`Skill` 均改为一调用一 Node helper；Bash 保持现有后台实体所有权，但统一受控启动、
  有界输出、取消/超时和进程树回收。
- `Read` 对超长单行只保留前缀并做固定上限的行长探测；`Edit` 为两遍流式匹配和同目录原子替换，保留
  现有文件 mode 与最终 symlink 语义；`Write` 同样原子替换。父 Agent 仍独占权限、hooks、trace、cwd、
  read dedup 与 BgEntity 台账，写入 helper 失联后统一报告“执行结果未知”。
- 分支 `feat/local-tool-process-isolation` 已完成真实 Node helper / shell / `rg` 回归；实机 1.65 GiB
  单行文件读取返回 51 KB 有界结果（helper 91 ms，无 `RangeError`），待创建非 Draft PR，不自行合并。

### 统一 Worker Runtime（v3.6.0）：实现完成，待设计型 PR review

- 已确认 `crabot-docs/superpowers/specs/2026-08-20-unified-worker-runtime-design.md`，并同步
  `protocol-agent-v3` 3.6.0。Harness 统一 builtin、Claude Code、Codex 的化身、workspace 指令快照、
  原生会话 activity、UI 与 control operation；`AGENTS.md` 仍由人类/Worker 管理。
- Manager 被动接收 assistant activity、完成回合、未知 UI 和 control settlement，并可主动读
  `assistant | all` 原生会话投影；hook 只触发会话收集，不代表任务成功或已经向人类交付。terminal
  capture 只供 Manager 主动诊断，巡检不再后台 capture。
- `incarnation_id`、turn disposition、snapshot 绑定的 UI action descriptor、可核验 interrupt/stop 与
  Harness 生成的私有 `HandoffPackage` 已落地。`kill_worker → cancelled`、Manager 可自由 raw 按键和
  Worker 写/读取 workspace `HANDOFF.md` 均已退役；`request_worker_stop` 已公开给 Manager，只有完整
  核验成功才取消 task。分支 `feat/unified-worker-runtime` 已完成定向验证，待创建非 Draft PR，不自行合并。

### 模块关闭与孤儿模块回收：已合并（PR #99 → `bf989ec`）

- 已确认设计：`crabot-docs/superpowers/specs/2026-08-16-module-shutdown-orphan-fencing-design.md`；实施计划：`crabot-docs/superpowers/plans/2026-08-17-module-shutdown-orphan-fencing.md`。
- Agent shutdown 统一释放 builtin/Claude Code/Codex adapter 资源，关闭后不重建 CLI watcher，也不终止独立 tmux Worker。
- MM 通过实例级 runtime registry 在启动和 replacement 前回收已识别的历史模块树；Windows 身份不明、拒绝、`-d` 或无 TTY 均在任何受管模块启动前失败退出。supervisor 为 MM 保留 60 秒关闭窗口加 10 秒余量。

- P6 总体设计：`crabot-docs/superpowers/specs/2026-08-11-p6-agent-observability-worker-management-design.md`；五份实施计划在 `crabot-docs/superpowers/plans/2026-08-12-p6-*.md`。顺序固定：**Slice 0 → P6-A → P6-B → P6-C → P6-D**。
- Slice 0 **已合并**（PR #90 → merge `377200e`，15 轮 review、28 条 finding 全部修复并 resolve）。核心交付：唯一核心 Agent + 动态/legacy Agent 只读归档、runtime bearer identity（per-child 绑定/撤销、启动即从 env 摘除）、authenticated config pull（单飞+退避自愈、降级启动 fail-closed 存活）、management-only cutover（幂等 marker + 宽容握手 + degraded-only health）、durable config revision（outbox 三态 + HMAC fingerprint + journal binding + seqlock 一致性读）、sensitive RPC 独立 transport、legacy get_config/update_config 无认证端点退役、noop-safe 全部配置写入路径、容错 MCP 热更 + 候选连接清理。协议同步：protocol-agent-v3 3.1.1 §8.5/§8.6/§11、protocol-admin §3.18/§3.19/§7.1、protocol-module-manager §3.18.1：
  - 唯一核心 Agent：动态/legacy Agent 的 create/update/delete/config-write 全部拒绝（`ADMIN_HOTPLUG_NOT_ALLOWED` / HTTP 410），live read surfaces 只暴露 builtin `default` / exact `crabot-agent`；存量记录只读归档（`unsupported_legacy`）。
  - Runtime identity + authenticated config pull：MM 只向 exact `crabot-agent` child 注入一次性 runtime bearer；Agent 启动最早期捕获并从 env 删除；secret-bearing RPC 走 method-closed `callSensitive()`；启动与热更都经 authenticated pull，失败即 fail closed 并断开 stale MCP。pull 有单飞去重 + 旧 revision no-op + 失败退避重试（不会永久 stale）。
  - Wire 契约：authenticated pull 返回正式 `CoreAgentRuntimeConfig`（当时 `protocol_version: '3.4.0'`，后续版本见 Agent 协议）；实例配置为 slot 制（`powerful` 必填），legacy `roles` 不是 wire 字段。
  - **降级启动自愈**：全新安装未配置 LLM 时 Agent 不再退出，进程存活照常注册，所有执行入口 fail closed，靠退避 pull 自愈；首次安装补建 worker 层（roles/LSP），无需手动重启。
  - Management-only cutover + durable config revision（seqlock 一致性读、HMAC fingerprint、Skill journal binding、publish 失败退避 drain 自愈）。
- **部署约束**：pre-P6 存量生产不得部署 Slice 0/A/B 中间态；首次 rollout 至少包含 Slice 0 + P6-B grandfather bootstrap + P6-C 最终选择语义。

### Manager -> Worker 输入与侧问可靠交付（历史基线）

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

- **启动对账轻量探测（PR #125，review APPROVED 待合并）**：重启后对账从 ~3 分钟降到秒级（实测 88 worker 820ms）。
  spec：`crabot-docs/superpowers/specs/2026-08-28-startup-reconcile-fast-probe-design.md`（含 review 修订记录 §10）。
  Review 遗留 follow-up：① `realignAliveIncarnation` 矛盾修复硬写 `running`（理论风险：矛盾+idle 场景会被 sweep 误报一次停摆，触发面窄）；② `ensureInteractionInspected` 先清标记后执行，探测抛错时该次重检丢失（与 main 旧行为一致，非新引入）。
- **测试基建 `detectTmux()` 缺陷（PR#125 调查中发现，需单独立任务）**：probe session `exit 0` 立即退出使 tmux server 消亡，`kill-server` 失败被 catch 后恒返回 false → `skipIf(!tmuxAvailable)` 的真实 tmux 测试（codex/claude-code 的四轮/五轮 review PoC 组）在部分环境从不执行；强制启用后 PoC②（rollout 内容 id 校验）、PoC③（重启后 resume 撞号）实测为主仓同样挂的预存失败。这使相关回归长期静默跳过，PR#125 首轮验证的"codex 全绿"即由此产生假阴性。

### P6 后 Traces / Worker 生命周期（当前主线）

- **Worker 用户级 CLI 安装闭环（已确认，待 PR review）**：默认由 Admin 显式安装官方 npm `latest`；
  Claude Code 与 Codex 均可在页面重装 latest 或切换固定已验证 fallback。CLI 版本号不再是
  translator、配置、verify、ready 或派发的本地门禁；真实上游不兼容由 verify/执行的失败导向状态报告。
  安装仍只写当前用户标准目录，不创建 Crabot 私有 CLI runtime，也不改写 `~/.claude`/`~/.codex` 登录配置。

- **Worker 直接 subagent 可观测性（v3.6.7，`feat/worker-subagent-observability`）**：按已确认的
  `crabot-docs` 设计与协议增补，builtin Worker 恢复 configured `delegate_task`；builtin、Claude Code、
  Codex 统一列出 Worker 直接启动的 child，Worker 详情读取分页 trace，child 详情读取自己的分页 trace。
  Admin 不按执行器拆 tab；CLI child trace 运行时优先读取原生 child 会话/记录，终态 child 保存 Agent-owned 脱敏副本，后续统一 Worker retention（PR B）按同一 Worker 清理单元删除；副本待补齐或原生先丢失时保留详情并显示脱敏原因。
  定向测试、页面验收和构建已通过，待非 Draft PR review。
- **CLI child Trace 收割节奏（已确认并实现）**：按 `crabot-docs/superpowers/specs/2026-08-23-cli-subagent-trace-harvest-scheduling-design.md`，activity 触发采用按 Worker 固定 30 秒合并窗口，同一 Worker 收割不并发；父 Worker 终态立即收割；启动恢复只读取已持久标记为 pending 的 child，并按 Worker 隔离失败。收割只影响显示副本，不持续捕获运行中 child 输出。
- **builtin 子 Agent 身份留存（已确认并实现）**：按 `crabot-docs/superpowers/specs/2026-08-23-builtin-subagent-record-retention-design.md`，Worker `delegate_task` 创建的 builtin child 身份记录不参与普通后台实体 7 天 GC，跟随所属 Worker retention 事务清理；普通后台 Agent、未归属 Worker 的 Agent 和 shell 保持原有规则。

- **Traces 人话视图 + 有界决策视野**：**已合并**（PR #100 → `f7e3aaf`，@claude approve 后自动合并）。Managers 用 `渠道·会话标题`、active worker 数和最近活动替代裸 ManagerKey/Episodes/历史总数；Manager detail 上浮消息摘录/回复/动作并按 worker 因果链折叠；Workers 默认只显示非终态。恢复 v2 dispatcher 不变量：`list_workers` 默认只看 `queued/running/waiting_input`，终态续办需显式分页 `include_terminal=true`；Manager 页面计数与工具视野同源。生产实测 system-tasks 2389 历史→6 active，工具实际 12 active/53 terminal。协议：agent v3.2.0、admin v0.2.2。
- **统一 Worker Runtime（v3.6.0，待 PR review）**：本次统一替代原 v3.4/v3.5 的分离待审状态；CLI 的 pane 只用于 bracketed-paste 控制和 Manager 按需诊断，不再作为正常进度或 handoff 来源。Claude `Notification`、Codex `PermissionRequest` 与重连检查识别到的未知 UI 以一次性 snapshot + adapter 固定 action descriptor 交给 Manager，不能形成自由 tmux 按键入口；原生 session activity、完成回合、可核验 stop 与私有 handoff package 同属该 PR。
- **Worker 重启恢复通知（已实现，待 PR review）**：主线执行载体确认消失时，Harness 与 `crashed` 原子写入持久 `recovery_notices`，在既有对账完成后只唤醒 owning Manager；首次立即尝试、未消费按 `30 秒 -> 1 分钟 -> 2 分钟 -> 5 分钟` 持久退避。仅重启 Agent 而 tmux 仍存活时重连；builtin `idle` 在下一条输入按同一会话按需重建。Harness 不自动续跑、重启、handoff 或向人类汇报。
- **统一 observability retention（PR B，已确认 spec/协议/计划，待实施）**：自动回收终态 Worker 的 adapter output/session、events/context、ledger、过期 Manager episode/TraceStore；孤儿 adapter/events 24h grace；output log 10MB cap；删除失真的 Trace 清理 UI/API/cron。**所有 workspace 零自动删除**——`$DATA_DIR/workspaces/<taskId>` 是用户项目/任务产物，不是 cache；当前 nomi-ai-companion 的 1GB Flutter workspace 必须保留。workspace 管理/显式删除以后独立设计。

### P6 主线（严格串行）

1. **Slice 0 收口**：已完成并合并（PR #90 → `377200e`）。
2. **P6-A 可观测性 / Admin Chat correlation**：**已合并**（PR #92 → `4fbbf96`，用户手动合并；8 轮 review、30+ 条 finding 全部修复并 resolve）。交付：Manager episode trace（TraceStore kind 判别 + admission fail-closed + 启动收口 + 内存有界驻留）、`/api/agent/managers*` + episodes RPC、worker composite trace reader（opaque cursor + native copy 终态收割 + builtin 结构化 trace）、v2 raw trace REST/RPC 退役、v3 Managers/Workers UI、Admin Chat delivery 事务（入站 fingerprint CAS + dispatch outbox + delivery journal + wire/staged payload 同源 + 双侧 journal GC + index 自愈），chat_callback 退役、FIFO 认领删除。另带出一个独立修复：模块代理配置持久化（main `43aeb5f`，修 telegram 启动竞态）。生产实测通过（E2E chat 全链路、幂等重放、重启持久化回归）。计划：`2026-08-12-p6-a-observability-admin-chat-correlation-plan.md`。
3. **P6-B Worker 安装/连接/验证/setup**：**已合并**（PR #94 → `0d6e91a`，15 轮 review 收敛；用户手动合并）。运行实例已切到 main 部署并实测健康（三 impl 全 ready）。**2026-08-16 追加修订已合并（PR #95 → `56cf974`）**：移除 managed install（用户级 binary only + 全局安装检测提示），修复 codex 代际自杀 bug（`ce45316`）。交付：desired store+CAS、activation registry（ready 唯一判定）、6 个版本化 translator、managed installer（固定 manifest+原子 active）、operation assertion、真实 verify、grandfather bootstrap 事务、Workers 管理页。**已确认修订**：取消 setup PTY（无 auth.json 上传/订阅迁移/TUI login），配置矩阵 = CC setup-token / CC·codex BASE_URL+KEY / existing_host。生产 E2E 全通（含真实 install/verify/spawn）。计划：`2026-08-12-p6-b-worker-onboarding-plan.md`（含 2026-08-14 修订）。 Review follow-up 池（P6-C/D 收口）：degraded 触发面扩展——当前只有 binary 缺失抛 WorkerImplUnavailableError，pane 内真实失效（登录过期/权限/版本阻塞）以化身终态呈现、不做 impl 级归因，需从终态 report 归因的独立立项；verification binding 的 policy_revision 粒度——现为整份 worker config 的 revision，任何一个 impl 的配置变更都会让**所有** impl 的验证失效（用户实测：验证 CC 后 codex 变未验证）。疑似用户先改了 CC 配置（PUT 导致 revision+1）再验证 CC，codex 的 binding 随之 stale。考虑改 per-impl policy_revision 或在 UI 提示「改配置会使其它 impl 需重新验证」；operation 占位前置防 TOCTOU 双跑、assertion tmp 随机后缀、created_at 终态不重置、403 改读 body.code、孤儿 provider 回收、worker 代理出口注入、WorkerOperationStore TTL。
4. **P6-C Worker 选择语义**：**已合并**（PR #97 → `e3b5b4f`，review approve 后自动合并）。纯选择器（显式不 fallback/省略 default→固定序）、registry snapshot + 轻量 fence、Manager `list_worker_implementations`、default/preference 全量编辑、Workers 页完善。fence 的 revision 绑定/barrier 测试列为 follow-up。
5. **P6-D legacy runtime retirement**：**已合并**（PR #98 → `feac341`，3 轮 review 9 条 finding 全修后手动合并）。LegacyAgentArchiveStore（summary/export/显式 delete + tombstone + journal）、AgentManager 收窄 core-config-only、dynamic 写面全删、backup import 两阶段 preflight、crabot-info 去 legacy、Modules UI archive 化。P6 正式收口。

### 技术债与既有 follow-up（P6 后或并行确认）

- **核心配置 revision 启动自检 fail-open：已合并**（PR #126 → `edab960a`）。PR #122 投影变更
  撞上一次性 rebaseline 申报通道锁死生产后，按 spec（crabot-docs
  `2026-08-28-config-revision-startup-fail-open-design.md`、protocol-admin 0.2.5）把启动漂移
  改为警告 + 重记账继续，marker 申报机制全链路退役；outbox 恢复/两阶段提交/seqlock/cutover
  gate 未动。部署约束：实例需重建重启后生效，升级不再需要任何申报动作。
- **wechat 群聊门控 PR #124 review follow-up（2026-08-28）**：① agent 侧注意力调度只对
  `is_mention_crab` 做即时唤醒（`attention-scheduler.ts:62` flushNow），引用放行消息要等一个巡检
  周期（2-30min）——「@ 与引用同等即时唤醒」是 protocol-agent-v3 §4.5 调度语义变更，需单独 spec
  （含引用放行是否算 replied/重置间隔）；落地前人工验收项 ③ 预期为触达但延迟一个周期。② feishu
  channel 存量问题：module.yaml 声明 `type: string` 而 `handleUpdateConfig` 只认 boolean，Admin
  热改开关静默 no-op（SchemaField enum 分支回传 string，全链路无类型还原），与本 PR 修复同款。
  ③ **channel 运行时配置不持久化**（feishu/wechat 同款存量，wechat 侧随 PR #124 打开此路径）：
  Admin `update_config` 只 RPC 落模块内存不写实例配置，模块任何重启即回退 env（wechat 门控开关
  缺省 false 回退方向不安全；feishu 默认 true 回退安全）。收口方向：update_config 成功后按
  `x-runtime-path` 反向映射回写 local-config + 明确配置真相来源，feishu/wechat 一起收口，需独立
  spec（持久化模型变更）。spec `2026-08-28-wechat-group-mention-gate-design.md` §9 已明示该限制。
  同源收口项（PR #124 三审补充）：`get_health` 读可变 config，未重启时健康视图显示未生效值，
  收口时改读启动快照；`webhook_port` 校验补 65535 上限；门控 drop 日志在大群的量评估。
- **telegram 群聊门控**：`group.only_respond_to_mentions` 协议已有契约，feishu / dingtalk 已实现，
  telegram 缺失（wechat 已随 PR #124 实现）。
- **内置能力归属完成后的后续设计**：当前能力归属 spec 实现并验收完成后，再依次处理三项独立设计：Schedule 支持受控的无 LLM operation，并用其承载 `Memory.run_maintenance("all")`；Manager 获得按 domain 枚举、复用既有权限/确认/undo/审核/脱敏语义的结构化 Crabot 管理工具面；清理活跃代码中会被误解为第三种 Agent 的遗留模块容器命名。三项均不得并入当前能力归属实现。
- **Worker/subagent trace 写点的同类硬截断**：`agent-handler.ts`（`.slice(0, 200/500)`）与 `unified-agent.ts`（`.slice(0, 300)`）对工具 span 摘要仍用整段硬截，与已修复的 manager episode span 同模式；目前无消费方受害（episode 投影不读这些 trace），若未来对其启用结构化提取应先改造为 `span-summary.ts` 的字段级截断（2026-08-27，`7cd86abf`）。
- **Worker 巡检调度收口**：启动对账与周期巡检应共享 due 投递排他；避免单个 Worker 的长锁阻塞全局活性巡检；默认巡检在全局 LLM 故障时需要有界的失败告警去重/退避。三项均需独立设计，不纳入当前任务巡检 PR。
- **移除 Agent 内部 legacy `roles` seam**：`AgentLayerConfig.roles` 是 v2 前多 Agent 时代残留（正式协议从未包含），现仅作内部测试 seam/恒真分支；应替换为显式的 worker-layer 开关后删除。
- **普通 Channel 未消费人类 wake 的跨重启恢复**：2026-08-19 实测，飞书私聊消息已落 Channel journal、reaction 已发且同 session Manager episode 已创建，但 Agent 在首次 LLM 调用前 OOM 重启；启动恢复只将遗留 episode 标为 `interrupted`，未将该 wake 重放，后续 worker 事件遂基于旧上下文回复。需独立设计普通 Channel 的持久化入站 wake、成功消费后结算、重启按原始顺序幂等重放；不得用扩大 Manager recent、滚动摘要或 prompt 约束替代。
- 失败 Manager episode 的通用带退避 mailbox retry；跨 session 代发目标 Manager 持久注记（§4.2）；Codex provision `auth.json` 错误吞没；P8 调试工具/内部文档重写。
- Claude project-scope MCP 文件（已接受边界）；权限 schema 纪律（新增 schema 前先迁移历史 worker context）。
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
- 正式模块契约：`crabot-docs/protocols/`（base 0.2.2、module-manager 0.2.3、admin 0.2.3、agent-v3 3.6.13、memory 0.3.5、crab-messaging 0.3.2、module-spec 0.2.0）。
- 设计决策与实施计划：`crabot-docs/superpowers/specs/` 与 `plans/`。
- 开发、部署、调试说明：`AGENTS.md` 与 `crabot-docs/guides/`。
