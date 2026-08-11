# Crabot 项目进度

> 最后整理：2026-08-11
> 本文件只保留当前状态、明确 follow-up 和阶段性里程碑；详细实施流水、逐轮 review 与历史测试输出见 Git 历史。压缩前完整版本可用 `git show 49b9cb4:PROGRESS.md` 查看。

## 当前状态

### Manager / Worker v3 已完成生产切换

- PR #80（merge `331fee7`）完成 legacy loop **主执行/RPC 控制链**退役：`wait_for_signal`、legacy task/recovery/resume/cancel/abort RPC 已退出生产；memory graph rebuild 保持 manager-native `trigger_schedule` 路径。2026-08-11 审计另发现两个 event/recovery 旁路仍可达，列入下方必须收口项。
- builtin worker 已接入 durable bg-shell exit delivery：registry 以 `pending / delivered / dead_letter` 做 at-least-once 结算，owner 使用 `worker_id`，通知统一经 `WorkerInbox` 投递；pending 不被 terminal cleanup 或 7 日 GC 删除。
- agent-native、无 incarnation 的 system task 在重启后明确标记 `failed`；worker-only API 对此返回稳定 domain error。
- PR #82（commit `aa7042d`，已部署）完成 Claude Code / Codex 交互输入提交收口：单层控制状态、单次 paste、证据化 Enter、startup stall/raw 清障、session discovery 与 continuation 语义已统一。

### Worker-scoped MCP capability 已合并

- PR #84 经 Claude latest-head `APPROVED` 后由 GitHub Actions 自动 squash merge 为 `3836c49017d46ff142f700c6274916db79009c54`；协议为 `protocol-agent-v3.md` v3.0.8，关联文档仓收口 commit 为 `45364bf`。
- harness 在 `data/agent/workers/<worker_id>/context.json` 原子保存 spawn 时固定的 `principal_permissions`；write 对缺失的已知权限项按 `false / none` fail-closed 补齐，persisted read 保持严格 fail-loud。
- spawn / handoff / builtin injection / CLI provision 使用同一规范化权限快照；handoff 通过无副作用 `preflightProvision` 在写 `HANDOFF.md` 或 kill 源化身前检查目标 workspace，正式 provision 在 teardown 后重检。
- builtin、Claude Code、Codex 共用 task-scoped MCP server 过滤：`computer-use → desktop`，其他 server → `mcp_skill`；Manager 仍不加载普通外部 MCP，skill capability 仍为空。
- Claude Code 的 spawn/resume/fork 使用 `--mcp-config .mcp.json --strict-mcp-config`，不与宿主 user/local MCP 求并集；Codex 使用隔离 `CODEX_HOME` 并整体覆盖 `mcp_servers`。
- CLI MCP 物化保留 stdio `env`、远端 `headers/http_headers` 与 transport type。Claude/Codex credential target 均先检查 Git tracked 状态、以 `0600` 原子替换，并用 ignore 规则防止目标及 crash temp 被普通 `git add -A` 收录。
- `builtin_tool_config.disabled_tools` 的 MCP 逐工具黑名单只作用于 builtin；CLI worker 以整台 server 为最小 provision 单位，跨实现限制使用 `mcp_skill / desktop` 类别权限或禁用整台 server。

### Manager 会话隔离与 v2 历史兼容已实现

- worker 台账改为按不可变 `ManagerKey` 归属，普通 Manager 的发现和 known-ID 操作均限定当前会话；只有当前仍有效的 Master 私聊工具面可显式跨会话查询和操作。
- Admin Chat 的 WebSocket 与 HTTP 附件入口统一进入 `admin-web::admin-chat`，由 Admin 签发短时、一次性、持久防重放 assertion；Agent 只在官方 `admin-web` RPC 核销成功后建立 Master generation。
- Friend/Admin Chat 授权使用可撤销 generation；旧 tool call、降权/删除后的调用和无控制层跨会话访问均 fail closed。私聊主体绑定可持久，群聊最近发言人不持久。
- Manager system prompt 不再嵌入动态台账、当前时间或 pending notes；所有 wake 使用入口时固定的时间信封，mailbox、失败重投、overflow retry 和 mid-episode supplement 保持同一事件时间。
- v2 Admin task/TraceStore 通过一次性只读 importer 投影为 legacy worker；marker 严格按 `in_progress → completed`，旧 trace 源与 v3 `traces-running-v3.jsonl` / `traces-v3-<date>.jsonl` 写入命名空间隔离。legacy output/trace 可降级读取，受控续办只追加全新 v3 化身，不恢复旧 checkpoint、旧 RPC 或 fake legacy adapter。

### 最近验证基线

- legacy importer/read-model/authorization/continuation 定向：15 files / 285 passed；PR review-fix 扩展回归：17 files / 325 passed。两轮独立 security/correctness review 最终无 blocker/important。
- 隔离升级副本使用当前生产快照完成真实 v2 导入：2696 tasks → 2696 legacy workers / 2696 `legacy_imported` events；首次 marker `completed`，有源重跑和隐藏源后的 completed fast-path 均跳过，复制源 hash 不变。索引修复后同一快照全量导入耗时 32.96s。证据目录：`/tmp/crabot-v2-upgrade-e2e-uF3u3v`、`/tmp/crabot-v2-import-perf-7A2Wgz`。
- 全分支独立 review 覆盖授权/assertion、台账/importer 和 Manager/time；TraceStore 源隔离与精确 assertion ID 意见已修复并复审关闭，seq 碰撞按协议既有范围记录为 residual；**在 PR #86 diff/review 范围内**无 blocker/important。后续全架构审计发现的跨 PR 遗留见下方收敛清单。
- Shared 全量：100 passed；Shared build 通过。
- Agent 全量：2664 passed / 4 failed / 2 skipped。4 个失败均为既有 macOS 环境基线：tmux foreground command 识别差异 1 个，`/var` → `/private/var` realpath 差异 3 个。
- Admin 全量：1075 passed / 1 failed。唯一失败为既有 `v1-cleanup.test.ts` 扫到 `origin/main` 已存在的测试断言字符串；本分支未引入该引用。Admin focused 81 passed，`build:all` 通过。
- `CI=true ./dev.sh build`、Agent/Admin/Shared TypeScript build 与全分支 `git diff --check` 通过；禁止回归搜索未发现 worker `dialog_object_id`、`spawned_by_session`、fake legacy adapter 或已退役 resume RPC 注册。

### 最近运行态检查

- PR #86 已由 merge gate squash merge 为 `9546baeb50c769f57f0557ac169d2131984522f8`，并于 2026-08-11 完成生产切换。切换前备份在 `~/.crabot/backups/pr86-cutover-20260811T031437Z`；旧 8 份 `data/agent/ledgers/*.json` 保留原地但不再扫描。
- 生产首次导入完成：2696 个 v2 tasks → 2696 个 legacy workers / snapshots / `legacy_imported` events，分布于 18 个 ManagerKey；marker 为 `completed`。重启命中 completed fast-path，marker、旧 `tasks.json` 与 35 份 legacy trace 源 hash 均保持不变。
- Admin Chat WS、HTTP multipart、assertion 单次核销/防重放、legacy detail/output/trace、fresh-v3 continuation、Claude Code 与 Codex 真机 worker 均通过。普通群聊 Manager 对已知 Admin Chat worker ID 得到统一的“不存在或当前会话无权访问”；事件保留固定 `received_at / timezone / occurred_at`。
- Codex fresh spawn 在 MCP 启动期间安全停为 `input_pending`，没有重复粘贴；MCP 完成后以 raw key token `Enter` 提交同一 composer。补充的同 pane 普通 follow-up 成功回填真实 rollout 和非空 `session_ref`；所有测试 worker 均已通过 `kill_worker` 清理，无残留 tmux session。
- MM、Admin、Agent、Memory、Telegram、Feishu、WeChat 在切换、Agent fast-path 重启和 E2E 清理后均为 healthy/running。
- 被旧 owner 管理的 Alpha Breadth v2 长测试按部署授权终止；bg entity `shell_63d5714821b2` 最终为 `failed`，exit notification 为 `delivered`，无残留进程。现场脚本/日志已备份，需要结果时重新运行。
- PR #83（merge `21dfb1c`）修复 source user mode 下 builtin MCP tools 路径；部署后 Agent 成功连接 `computer-use`、`git`、`lsp`、`tmux-mcp`、`chrome-devtools`。

## 双 Agent 架构收敛审计（2026-08-11）

### 结论

- Manager/Worker v3 的**生产核心链路已经收敛**：人类消息只进入 Manager，worker 由不可变 `ManagerKey` 归属；builtin / Claude Code / Codex 三种实现、CLI 输入提交、活性巡检、bg-shell durable notification、Admin Chat assertion、legacy 一次性导入与 fresh-v3 continuation 均已通过真实运行验证。当前没有已知生产 blocker。
- 但不能表述为“原计划全部完成”。原路线图的 **P6（可观测性与 Admin UI）和 P8（调试工具/内部文档）没有实施**；P7 的主 cutover 已完成，但仍有 legacy Admin task 控制旁路和跨 session 代发注记缺口，尚未达到协议所写的完全退役/上下文一致状态。
- `2026-08-03-post-launch-followups.md` 只作为第一版上线现场归档，不再直接当当前 backlog；其中大量问题已被 #65～#82 修复，或被 #80/#86 的 legacy retirement、ManagerKey 与 fresh-v3 continuation 取代。

### 原路线图对账

| 阶段 | 当前结论 |
|---|---|
| P1 worker 契约 / builtin adapter / session 树 | 已完成并进入生产。 |
| P2 tmux / Claude Code / Codex adapter | 核心实现和真机输入闭环已完成；但 `detect()`/实现池/部署偏好没有生产接线，见当前 follow-up。 |
| P3 ledger / harness / inbox / continuation | 核心实现已完成；台账后来由 PR #86 收敛为每 `ManagerKey` 一份。Admin skill 向 CLI worker 的 capability 接线仍为空。 |
| P4 Manager loop / 工具面 / 压缩 | 已完成；动态 prompt 状态后来由 PR #86 改为事件尾部输入。 |
| P5 scheduler / Agent read model / Admin 代理 | `trigger_schedule` 和 worker 四个只读 RPC/REST 已完成；Manager read model 前端消费仍属于未完成的 P6。 |
| P6 Manager trace / worker 原生 trace / Admin Manager-Worker UI | **未完成。** `/api/agent/managers*` 不存在；Manager episode 未进入 TraceStore；`get_worker_trace` 对 fresh-v3 只返回 harness lifecycle，明确把 adapter `readTrace()` 留给 P6；Admin Web 未消费 `/api/agent/workers*`，旧 conversation-unit/trace UI 仍在。当前实现与 `protocol-agent-v3.md` §10.1/§10.3 存在缺口。 |
| P7 cutover / legacy import / 旧控制面退役 | 主 cutover、dispatcher 删除、legacy import/continuation 已完成；但 legacy Admin task event/recovery 旁路仍可达，跨 session 代发未写目标 Manager 持久注记，见当前 follow-up。 |
| P8 调试工具 / 内部架构文档 | **未完成。** `debug-agent.mjs` 没有 Manager/Worker 台账命令；`architecture/crabot-agent-internal.md` 与 `guides/agent-debugging.md` 仍描述 Dispatcher/Front/旧 Admin task/旧端口，甚至保留 LiteLLM 时代内容。 |

### 第一版上线问题的收敛情况

- **已修复**：workspace trust、真实 endReason、`finish_task` summary、Codex endpoint/config 继承、TUI 输出解码、spawn/readiness、Claude/Codex 权限、单次 paste/证据化 Enter、真实活性信号、worker bg-shell exit delivery、Admin Chat assertion 与会话级授权。
- **被新架构取代**：跨重启旧内存 incarnation、已消失 legacy session 的透明 resume、Admin recovery 误杀 idle worker、旧 Admin task/trace 停摆。这些旧问题不能继续按 8 月 3 日的路径修；现行语义是 v2 只读投影 + 新 v3 化身。
- **仍真实存在**：下面“必须收口”中的 legacy 旁路、跨 session 代发注记缺失、Manager 失败 mailbox 无通用 retry、P6/P8、Admin Chat 占位误认领、实现选择假配置、skill capability 空接线、handoff 真尾与 Codex auth 错误吞没。

## 当前 follow-up

### 双 Agent 主线必须收口

1. **移除仍可达的 legacy Admin task 控制旁路（协议违背）**
   - Agent 仍订阅 `admin.task_status_changed`，终态事件会查询旧 Admin task 并直接向 Admin Chat/channel 发送最终回复，绕过“Manager 是唯一人类出口”。
   - `module_manager.module_stopped` 的旧 handler 仍调用 `query_tasks` / `update_task_status` 改写 legacy Admin task，违背 Agent ledger 唯一真相源和 importer 源只读边界。
   - 应先补“订阅/handler/Admin task write 均不存在”的回归测试，再做最小退役删除。

2. **为失败 Manager episode 增加通用、带退避的 mailbox retry**
   - 当前成功 episode 收口后会自唤醒 drain；失败 episode 只把正文留在内存 mailbox，依赖下一次真实人类/worker/schedule 事件才能重投。
   - fail-loud 会告诉人类本次失败，但如果故障自行恢复且没有新事件，已收到的正文可以无限等待。需要独立设计低频、去重、带退避的通用 drain，避免故障热循环。

3. **补齐跨 session 代发的目标 Manager 持久注记**
   - `protocol-agent-v3.md` §4.2 要求任何组件向非所属 session 代发消息时，向目标 Manager 历史追加系统注记；当前系统线程已暴露 `send_master_private`，但没有对应 history append 路径。
   - 后果是目标会话能看到消息，却没有持久上下文解释消息来自哪个 Manager/系统任务；后续接办容易失去来龙去脉。

4. **完成 P6 可观测性与 Admin UI 闭环**
   - 接通 Manager episode trace 与 `/api/agent/managers*`；把 Claude/Codex 已实现的 `readTrace()` 接入 `get_worker_trace`，补 builtin structured trace 和 native-session 收割策略；让 Admin Web 真正切到 Manager/Worker 视图。
   - 修正 Admin Chat assistant push 的占位认领：当前任意 `admin-chat` assistant 消息都会 FIFO 消费最早 pending request；worker 事件触发的主动汇报撞上另一条 in-flight 请求时会关联错占位。消息不丢、刷新后可恢复，但实时 UI 语义错误。
   - 开工前先重新核对 §10 的 cursor、retention、legacy/fresh-v3 命名空间和 UI 范围，不能直接照 7 月侦察稿实现。

5. **实现 worker 类型可用池与选择语义**
   - 生产从不调用 adapter `detect()`；没有 `worker_impls.default_impl/preferences` 配置入口，实际缺省固定 builtin。
   - Manager prompt 和 `spawn_worker` 描述仍声称“按部署偏好选择”，属于假承诺。最小收口要么删除该说法并只承诺显式 impl + builtin 默认，要么正式实现检测、激活状态和偏好配置。

6. **补齐 Admin skill → worker capability 接线**
   - MCP 已在 PR #84 按固定权限快照接入三种 worker；skill 仍在生产 `CapabilityBundle` 中硬编码 `skills: []`，与原 provision 计划不完整。
   - 需先明确 task-scoped skill 权限/过滤语义，再接入 Claude/Codex 物化和 builtin 对齐。

7. **修复两处局部 adapter/handoff 正确性问题**
   - handoff 读取 `readOutput(offset=0)` 的首个 50KB，再取其中末 4096 字符；大输出时并非文件真尾，可能把最新交接现场漏掉。
   - Codex provision 复制 `auth.json` 时 catch 全部错误；除了 `ENOENT`，权限/IO 错误也被静默吞掉，worker 只会在后续启动时表现成鉴权失败。

8. **完成 P8 调试与文档收尾**
   - 给 `debug-agent.mjs` 增加 Manager/Worker/ledger/inbox/incarnation 视角；重写内部架构与调试指南，删除 Dispatcher、旧 task、LiteLLM 和错误端口说明。

### 待验证与测试债务

- **PR #84 生产黑盒**：真实 builtin / Claude Code / Codex 用户 MCP 调用已通过；仍需单独覆盖 `desktop / mcp_skill` 过滤、handoff 固定权限快照、禁用 server 清理及带 credential 配置文件权限。
- **测试基线**：Agent 全量仍有 4 个既有 macOS 环境失败（tmux foreground command 1、`/var` realpath 3），Admin 有 1 个 v1 cleanup 跨仓扫描误报；另有“tests 未进入 TypeScript type-check”债务。应独立校准，不与功能修复混改。

### 已接受边界与待评估增强

- **incarnation seq 碰撞**：协议 §5.6 已接受 adapter 自管 seq 的边界；根治需 harness 全局分配或扩展公开身份契约，属于需重新确认的协议变更。
- **Claude project-scope MCP 文件**：根 `.mcp.json` / `.gitignore` 副作用是 v3.0.8 已接受边界；迁到 Crabot-owned per-worker 外部路径需重新验证 Claude trust flow。
- **权限 schema 纪律**：新增 `ToolAccessConfig` / `CliDomain` 前必须先迁移历史 worker context，不能靠 persisted read 静默补齐。
- **待评估增强**：P7 压缩第 3 步（token 预算 + 文件台账）、turn 内 text 攒批、schedule TTL 等不属于“原架构尚不能正确工作”的 blocker。

### 非双 Agent 主线的历史候选

备份导入 Plan 2、Memory 压缩/去重/混合检索、Windows 进程树、required skill fail-closed、internal-maintenance 出站边界、Claude Code 容器化/沙箱和 Trace 清理职责仍需分别重新确认；它们不是当前已批准的实施计划。Alpha Breadth v2 长测试如仍需要结果，应从备份脚本创建新 owner 重新运行，不恢复旧 worker。

## 里程碑归档

### 2026-08 — Manager/Worker 生产硬化与 legacy cutover

| 日期 | 里程碑 |
|---|---|
| 08-11 | PR #86（merge `9546bae`）完成生产 cutover：旧 owner/bg 进程收口并备份，2696 条 v2 task 一次性只读导入，重启 fast-path、Admin assertion、会话隔离、legacy continuation 与 Claude/Codex 真机 E2E 通过。 |
| 08-10 | ManagerKey 会话台账、Master 显式全局视角、Admin Chat assertion、可撤授权 generation、稳定 prompt/事件时间信封和 v2 legacy 只读导入/新 v3 化身续办完成。 |
| 08-09 | PR #84：task-scoped MCP capability 接入 builtin / Claude Code / Codex；固定 principal 快照、credential 安全写入、handoff preflight 与协议 v3.0.8 落地。 |
| 08-09 | PR #82：CLI 交互输入提交安全化；Claude Code 2.1.226 / Codex 0.146.0 真机 tmux 路径完成校准。 |
| 08-09 | PR #80：legacy AgentHandler 生产执行/恢复控制面退役；builtin bg-shell durable exit delivery 上线。 |
| 08-06～08-07 | Claude Code 启动弹窗、bypass 首次警告、prompt 提交和运行期权限模式完成真机修复；PR #77/#78 部署。 |
| 08-05～08-06 | worker 活性信号由“进程/动画”纠偏为真实执行进展；builtin 补齐 activity signal，startup stall 不再伪装 running。 |
| 08-03～08-04 | Agent 冷启动配置读取增加退避重试；模块健康恢复、Memory graph rebuild 与 maintenance RPC 做最小修复。 |
| 08-01 | Manager/Worker P7 builtin 注入通道完成，manager 可以派出具备 LLM、工具、权限和 bg-shell 上下文的 builtin worker。 |

### 2026-07 — Manager/Worker 基础与运行时正确性

| 范围 | 里程碑 |
|---|---|
| Manager/Worker P1～P5 + P7 主链 | 完成 WorkerAdapter、多实现 adapter、ledger/harness、manager loop、read model、scheduler 路由、Admin 只读代理、入站测试网、builtin 注入与 dispatcher cutover；P6 可观测性/UI 和 P8 调试文档未完成，P7 仍有两个 legacy 旁路待删。 |
| Task 生命周期 | 修复 terminal/revive/new_task 判定、checkpoint 续写、supplement/resume 权限热刷新、goal 生命周期和状态对账；这些 legacy 主入口随后在 8 月 cutover 中退役，残留 event/recovery 旁路另列当前 follow-up。 |
| CLI worker | Codex adapter 在 m2 真机校准；Claude/Codex tmux、resume/fork、原生 trace 解析器与交互状态成为 v3 worker 实现；原生 trace 尚未接入 Admin read model/UI。 |
| Python / 模型配置 | Agent 专用 `agent-venv` 上线；subagent 模型在 delegate 时实时解析，Provider/OAuth 连接信息保持现取。 |
| Channel / 文件 | 修复飞书图文丢图与外部群 PRD 获取、WeChat 入站文件超时补取、Unicode channel instance id、出站路径白名单限制。 |
| Trace / tmp-pages | 完成大型 Trace 树与任务状态对账、terminal supplement trace、tmp-pages v2 工具化和页面 GC。 |
| 性能 | 优化 agent token 使用：按需读取、tool result 截断、历史压缩与大输出落盘策略。 |

### 2026-06 — Admin、迁移与稳定性

- Admin UI 增加升级提醒与一键升级；system/user mode 升级路径逐步收口。
- 备份/迁移完成导出主路径；导入方案曾在独立 worktree 实施，当前状态列入“需重新确认”。
- Master Chat 完成 Phase 1～3：独立 system session、WebSocket 流式 UI、工具审批与 trace 关联。
- 修复 Agent 长时间运行的 zod globalRegistry 泄漏及 OOM 自动重启问题。
- Skill filesystem-native、Admin 密码管理、schedule/target schema、goal 软约束与 trigger_messages 统一等能力完成。

### 2026-05 — Subagent、权限与可观测性

- subagent 从架构骨架推进到内置 worker、plan-and-execute、research collector、Admin UI 和 Trace 页面。
- CLI 权限统一进入 Friend / Session 模板；模块恢复与 self-healing 上线。
- 原生飞书 Channel、crab-messaging 路由、分页可见性和 Trace UI/保留策略持续完善。

### 2026-04 — Engine V2 与 Provider 直连基础

- Agent Engine V2 完成：多 LLM 格式适配、流式 tool loop、context compaction、builtin tools、MCP、LSP、trace 与协议对齐。
- LiteLLM 代理层完全移除；Agent 按 format 直连 Anthropic / OpenAI / Gemini / openai-responses，ChatGPT OAuth PKCE 与 token 自动刷新落地。
- Memory v2、原生飞书、Time Awareness、MCP/Skill 配置简化和自学习反馈信号闭环完成。

## 当前架构真相源

为避免本文件再次复制并腐化架构说明，以下内容不再在 `PROGRESS.md` 展开：

- 项目开发与流程规则：根目录 `AGENTS.md`（实际链接到 `CLAUDE.md`）。
- 正式模块契约：`crabot-docs/protocols/`。
- 设计决策：`crabot-docs/superpowers/specs/`。
- 已确认实施步骤：`crabot-docs/superpowers/plans/`。
- 开发、部署、调试和端口说明：根目录 `AGENTS.md` 与 `crabot-docs/guides/`。
