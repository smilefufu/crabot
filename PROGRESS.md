# Crabot 项目进度

> 最后整理：2026-08-13
> 本文件只保留当前状态、明确 follow-up 和阶段性里程碑；详细实施流水、逐轮 review 与历史测试输出见 Git 历史。压缩前完整版本可用 `git show 49b9cb4:PROGRESS.md` 查看。

## 当前状态

### P6 进行中：Slice 0、P6-A 已合并；P6-B 已开 PR #94

- P6 总体设计：`crabot-docs/superpowers/specs/2026-08-11-p6-agent-observability-worker-management-design.md`；五份实施计划在 `crabot-docs/superpowers/plans/2026-08-12-p6-*.md`。顺序固定：**Slice 0 → P6-A → P6-B → P6-C → P6-D**。
- Slice 0 **已合并**（PR #90 → merge `377200e`，15 轮 review、28 条 finding 全部修复并 resolve）。核心交付：唯一核心 Agent + 动态/legacy Agent 只读归档、runtime bearer identity（per-child 绑定/撤销、启动即从 env 摘除）、authenticated config pull（单飞+退避自愈、降级启动 fail-closed 存活）、management-only cutover（幂等 marker + 宽容握手 + degraded-only health）、durable config revision（outbox 三态 + HMAC fingerprint + journal binding + seqlock 一致性读）、sensitive RPC 独立 transport、legacy get_config/update_config 无认证端点退役、noop-safe 全部配置写入路径、容错 MCP 热更 + 候选连接清理。协议同步：protocol-agent-v3 3.1.1 §8.5/§8.6/§11、protocol-admin §3.18/§3.19/§7.1、protocol-module-manager §3.18.1：
  - 唯一核心 Agent：动态/legacy Agent 的 create/update/delete/config-write 全部拒绝（`ADMIN_HOTPLUG_NOT_ALLOWED` / HTTP 410），live read surfaces 只暴露 builtin `default` / exact `crabot-agent`；存量记录只读归档（`unsupported_legacy`）。
  - Runtime identity + authenticated config pull：MM 只向 exact `crabot-agent` child 注入一次性 runtime bearer；Agent 启动最早期捕获并从 env 删除；secret-bearing RPC 走 method-closed `callSensitive()`；启动与热更都经 authenticated pull，失败即 fail closed 并断开 stale MCP。pull 有单飞去重 + 旧 revision no-op + 失败退避重试（不会永久 stale）。
  - Wire 契约：authenticated pull 返回正式 `CoreAgentRuntimeConfig`（protocol-agent-v3 §11，`protocol_version: '3.1.1'`）；实例配置为 slot 制（`powerful` 必填），legacy `roles` 不是 wire 字段。
  - **降级启动自愈**：全新安装未配置 LLM 时 Agent 不再退出，进程存活照常注册，所有执行入口 fail closed，靠退避 pull 自愈；首次安装补建 worker 层（roles/LSP），无需手动重启。
  - Management-only cutover + durable config revision（seqlock 一致性读、HMAC fingerprint、Skill journal binding、publish 失败退避 drain 自愈）。
- **部署约束**：pre-P6 存量生产不得部署 Slice 0/A/B 中间态；首次 rollout 至少包含 Slice 0 + P6-B grandfather bootstrap + P6-C 最终选择语义。

### 最近验证基线（2026-08-13，PR #90 最新 push）

- Shared 107、Core 138、**Admin 1152/1152**、Web build+269（web 此后未再改动）。
- Agent 全量 2683 passed / 4 failed / 2 skipped，4 个失败均为既有 macOS 环境基线（`/var` realpath 3、tmux 探测 1），文件不在分支 diff 内。
- 顺带修复的既有缺陷：`admin-chat-assertions` 签名篡改用例约 6% no-op flake（base64 末尾填充位）；Admin startup seeding 依赖 MM 事件扇出导致的全量 suite 崩溃；MM cutover 后对已运行 admin-web 重复 auto-start 的日志噪音。

### Manager / Worker v3（已生产运行，背景）

- PR #76～#89 完成 CLI worker 输入/活性/权限/ManagerKey、legacy loop 退役、bg-shell durable notification、worker-scoped MCP、Admin Chat assertion、会话隔离与 v2 只读导入；生产切换见里程碑归档（`git show 49b9cb4:PROGRESS.md` 有完整细节）。

## 当前 follow-up

### P6 主线（严格串行）

1. **Slice 0 收口**：已完成并合并（PR #90 → `377200e`）。
2. **P6-A 可观测性 / Admin Chat correlation**：**已合并**（PR #92 → `4fbbf96`，用户手动合并；8 轮 review、30+ 条 finding 全部修复并 resolve）。交付：Manager episode trace（TraceStore kind 判别 + admission fail-closed + 启动收口 + 内存有界驻留）、`/api/agent/managers*` + episodes RPC、worker composite trace reader（opaque cursor + native copy 终态收割 + builtin 结构化 trace）、v2 raw trace REST/RPC 退役、v3 Managers/Workers UI、Admin Chat delivery 事务（入站 fingerprint CAS + dispatch outbox + delivery journal + wire/staged payload 同源 + 双侧 journal GC + index 自愈），chat_callback 退役、FIFO 认领删除。另带出一个独立修复：模块代理配置持久化（main `43aeb5f`，修 telegram 启动竞态）。生产实测通过（E2E chat 全链路、幂等重放、重启持久化回归）。计划：`2026-08-12-p6-a-observability-admin-chat-correlation-plan.md`。
3. **P6-B Worker 安装/连接/验证/setup**：**已开 PR #94**（分支 `feat/p6-b-worker-onboarding`）。交付：desired store+CAS、activation registry（ready 唯一判定）、6 个版本化 translator、managed installer（固定 manifest+原子 active）、operation assertion、真实 verify、grandfather bootstrap 事务、Workers 管理页。**已确认修订**：取消 setup PTY（无 auth.json 上传/订阅迁移/TUI login），配置矩阵 = CC setup-token / CC·codex BASE_URL+KEY / existing_host。生产 E2E 全通（含真实 install/verify/spawn）。计划：`2026-08-12-p6-b-worker-onboarding-plan.md`（含 2026-08-14 修订）。 Review follow-up 池（P6-C/D 收口）：operation 占位前置防 TOCTOU 双跑、assertion tmp 随机后缀、created_at 终态不重置、403 改读 body.code、孤儿 provider 回收、worker 代理出口注入、spawn 初期输入竞态自恢复、WorkerOperationStore TTL。
4. **P6-C Worker 选择语义**：detect/activation/preference 真实接线，替换 Manager prompt 中的假承诺。计划：`2026-08-12-p6-c-worker-policy-selection-plan.md`。
5. **P6-D legacy backup/runtime retirement**：native backup preflight/archive-only/zero-partial-write（§3.18.1 完整语义）、legacy Agent metadata 清理、P7 遗留死码删除。计划：`2026-08-12-p6-d-legacy-agent-runtime-retirement-plan.md`。

### 技术债与既有 follow-up（P6 后或并行确认）

- **移除 Agent 内部 legacy `roles` seam**：`AgentLayerConfig.roles` 是 v2 前多 Agent 时代残留（正式协议从未包含），现仅作内部测试 seam/恒真分支；应替换为显式的 worker-layer 开关后删除。
- 失败 Manager episode 的通用带退避 mailbox retry；跨 session 代发目标 Manager 持久注记（§4.2）；Admin skill → worker capability 接线（skill 仍硬编码 `[]`）；Codex provision `auth.json` 错误吞没；P8 调试工具/内部文档重写。
- incarnation seq 碰撞（已接受边界，根治需协议变更）；Claude project-scope MCP 文件（已接受边界）；权限 schema 纪律（新增 schema 前先迁移历史 worker context）。
- Admin source manager 的完整两阶段回滚：当前 mutation 源写入失败且内存态已推进时，靠重启恢复 fail-loud 兜底；各 manager 的事务性回滚（磁盘为准）另行设计。
- claude-review workflow 的 attempt 步骤缺 `continue-on-error`：claude-code-action 自身崩溃（is_error）时重试阶梯被跳过。注意：workflow 文件不能在待审 PR 内修改（action 的反篡改校验会拒绝运行），需单独路径落地（直接推 main 并知会管理员）。
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
- 正式模块契约：`crabot-docs/protocols/`（base/module-manager/admin 0.2.1、agent-v3 3.1.1、crab-messaging 0.3.2、module-spec 0.2.0）。
- 设计决策与实施计划：`crabot-docs/superpowers/specs/` 与 `plans/`。
- 开发、部署、调试说明：`AGENTS.md` 与 `crabot-docs/guides/`。
