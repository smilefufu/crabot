# Crabot 项目进度

> 最后整理：2026-08-13
> 本文件只保留当前状态、明确 follow-up 和阶段性里程碑；详细实施流水、逐轮 review 与历史测试输出见 Git 历史。压缩前完整版本可用 `git show 49b9cb4:PROGRESS.md` 查看。

## 当前状态

### P6 进行中：Slice 0（核心 Agent singleton / runtime identity）实现完成，待 PR

- P6 总体设计：`crabot-docs/superpowers/specs/2026-08-11-p6-agent-observability-worker-management-design.md`；五份实施计划在 `crabot-docs/superpowers/plans/2026-08-12-p6-*.md`。顺序固定：**Slice 0 → P6-A → P6-B → P6-C → P6-D**。
- Slice 0 分支 `feat/p6-slice0-core-agent-runtime` 已实现完成并通过全量验证（尚未 push/开 PR）：
  - 唯一核心 Agent：动态/legacy Agent 的 create/update/delete/config-write 全部拒绝（`ADMIN_HOTPLUG_NOT_ALLOWED` / HTTP 410），live read surfaces 只暴露 builtin `default` / exact `crabot-agent`；存量记录只读归档（`unsupported_legacy`）。
  - Runtime identity + authenticated config pull：MM 只向 exact `crabot-agent` child 注入一次性 runtime bearer（stop/restart/replacement 撤销，duplicate start 不误撤）；Agent 启动最早期捕获并从 env 删除 bearer；`get_agent_config` 等 secret-bearing RPC 走 method-closed `callSensitive()`，普通 `call()` 在网络 I/O 前拒绝；Agent 启动与热更都经 authenticated pull，失败即 `configStale` fail closed（新执行、schedule、worker spawn、media wake 全挡）并断开 stale MCP。
  - Wire 契约：authenticated pull 返回正式 `CoreAgentRuntimeConfig`（protocol-agent-v3 §11，`protocol_version: '3.1.1'`）；实例配置为 slot 制（`powerful` 必填），legacy `roles` 不是 wire 字段，Agent 内部固定补齐（见 follow-up）。
  - Management-only cutover：每次启动用新 cutover bearer 重做 MM inventory/handshake；`complete_core_agent_cutover` 并发先占 bearer、response 丢失经 MM durable record reconcile；activation 前所有 Agent 依赖入口 fail closed（503/稳定错误），Agent-dependent maintenance/schedules 延后到 activation；readiness 失败时 Admin 同进程串行重试。
  - Durable config revision：coordinator prepared→source→commit→invalidation 全程 file fsync+rename+dir fsync，HMAC semantic fingerprint + Skill source-journal binding；启动期 seeding mutations 不依赖 MM 事件扇出（publication 延后到 activation），runtime mutations publish 失败 fail-loud 且 durable outbox 可重试；`handleGetAgentConfig` 用 seqlock epoch 做一致性读（有界重试后 fail closed）。
- **部署约束**：pre-P6 存量生产不得部署 Slice 0/A/B 中间态；首次 rollout 至少包含 Slice 0 + P6-B grandfather bootstrap + P6-C 最终选择语义。

### 最近验证基线（2026-08-13，Slice 0 工作树）

- Shared 107 passed、Core 138 passed、**Admin 全量 1137/1137 passed（131 files，首次真正全绿）**、Web build+269 tests 通过（web 代码此后未再改动）。
- Agent 全量 2681 passed / 4 failed / 2 skipped。4 个失败均为既有 macOS 环境基线且两文件不在分支 diff 内：`/var`→`/private/var` realpath 3 个、tmux 存活探测 1 个。
- 顺带修复的两个 main 遗留测试缺陷（与 Slice 0 无关，PR 中会注明）：`admin-chat-assertions.test.ts` 签名篡改用例约 6% 概率 no-op（base64 末尾填充位）；Admin 全量此前长期因 startup seeding 依赖 MM 事件扇出而 suite 级崩溃（17 个文件），现按"seeding 不依赖 MM、runtime publish fail-loud"修复。
- bearer/secret/trace 泄漏扫描、sensitive-ordinary-call 扫描、配置绝对路径扫描、双仓 `git diff --check` 均通过。

### Manager / Worker v3（已生产运行，背景）

- PR #76～#89 完成 CLI worker 输入/活性/权限/ManagerKey、legacy loop 退役、bg-shell durable notification、worker-scoped MCP、Admin Chat assertion、会话隔离与 v2 只读导入；生产切换见里程碑归档（`git show 49b9cb4:PROGRESS.md` 有完整细节）。

## 当前 follow-up

### P6 主线（严格串行）

1. **Slice 0 收口**：push 分支 → 开 PR → @claude latest-head review/自动 merge。PR 后按 review 意见迭代。
2. **P6-A 可观测性 / Admin Chat correlation**：Manager episode trace、`/api/agent/managers*`、CLI `readTrace()` 接入 `get_worker_trace`、Admin Chat 占位认领纠偏、Admin Web 切 Manager/Worker 视图。计划：`2026-08-12-p6-a-observability-admin-chat-correlation-plan.md`。
3. **P6-B Worker 安装/连接/验证/setup**：`native_account`/`admin_provider`/`existing_host` 连接模式、grandfather bootstrap（存量生产首次 rollout 的硬前提）、Admin intent 持久化 + Agent 侧 activation registry。计划：`2026-08-12-p6-b-worker-onboarding-plan.md`。
4. **P6-C Worker 选择语义**：detect/activation/preference 真实接线，替换 Manager prompt 中的假承诺。计划：`2026-08-12-p6-c-worker-policy-selection-plan.md`。
5. **P6-D legacy backup/runtime retirement**：native backup preflight/archive-only/zero-partial-write（§3.18.1 完整语义）、legacy Agent metadata 清理、P7 遗留死码删除。计划：`2026-08-12-p6-d-legacy-agent-runtime-retirement-plan.md`。

### 技术债与既有 follow-up（P6 后或并行确认）

- **移除 Agent 内部 legacy `roles` seam**：`AgentLayerConfig.roles` 是 v2 前多 Agent 时代残留（正式协议从未包含），现仅作内部测试 seam/恒真分支；应替换为显式的 worker-layer 开关后删除。
- 失败 Manager episode 的通用带退避 mailbox retry；跨 session 代发目标 Manager 持久注记（§4.2）；Admin skill → worker capability 接线（skill 仍硬编码 `[]`）；Codex provision `auth.json` 错误吞没；P8 调试工具/内部文档重写。
- incarnation seq 碰撞（已接受边界，根治需协议变更）；Claude project-scope MCP 文件（已接受边界）；权限 schema 纪律（新增 schema 前先迁移历史 worker context）。
- tests 未进入 TypeScript type-check 的债务；Agent 4 个 macOS 基线失败的独立校准。

### 非主线历史候选

备份导入 Plan 2、Memory 压缩/去重/混合检索、Windows 进程树、Claude Code 容器化/沙箱等需分别重新确认，不是当前已批准计划。

## 里程碑归档

| 日期 | 里程碑 |
|---|---|
| 08-12～13 | P6 Slice 0 实现完成：核心 Agent singleton、runtime bearer identity、authenticated config pull、management-only cutover、durable config revision；三路独立 review 的 blocker 全部修复，全模块测试基线刷新（Admin 首次全绿）。 |
| 08-11 | PR #86（merge `9546bae`）生产 cutover：2696 条 v2 task 一次性只读导入，legacy continuation、Admin Chat assertion、会话隔离与 Claude/Codex 真机 E2E 通过。 |
| 08-09～10 | PR #84 worker-scoped MCP capability；PR #82 CLI 交互输入提交；ManagerKey 会话台账与 v2 legacy 只读导入完成。 |
| 08-01～09 | PR #80 legacy 执行/恢复控制面退役 + builtin bg-shell durable delivery；PR #77/#78 Claude Code 真机修复；worker 活性信号纠偏。 |
| 07 月 | Manager/Worker P1～P5+P7 主链完成（adapter、ledger/harness、manager loop、read model、scheduler 路由）；agent-venv、subagent 模型实时解析。 |
| 06 月及更早 | Engine V2 + Provider 直连（LiteLLM 移除）、Memory v2、原生飞书、Master Chat、备份导出、Admin UI 等；详见 `git show 49b9cb4:PROGRESS.md`。 |

## 当前架构真相源

为避免本文件复制并腐化架构说明，以下内容不再展开：

- 项目开发与流程规则：根目录 `AGENTS.md`。
- 正式模块契约：`crabot-docs/protocols/`（base/module-manager/admin 0.2.1、agent-v3 3.1.1、crab-messaging 0.3.2、module-spec 0.2.0）。
- 设计决策与实施计划：`crabot-docs/superpowers/specs/` 与 `plans/`。
- 开发、部署、调试说明：`AGENTS.md` 与 `crabot-docs/guides/`。
