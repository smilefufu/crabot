# Crabot 项目进度

> 最后更新：2026-04-29 — Agent 时间感知（Time Awareness）

## 最新里程碑（2026-04-29 — Time Awareness）

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
**计划文档**：`crabot-agent/docs/plans/2026-04-03-engine-v2.md`  
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
│   ├── 消息鉴权网关（channel.message_received → channel.message_authorized）
│   └── PTY 会话管理 + Web 终端 (/ws/pty/*)
├── Agent (port 由 MM 分配)
│   ├── Front Handler（快速分诊，默认 10 轮，3 次重试）
│   └── Worker Handler（深度执行）
├── Memory (Python, port 19002)
│   └── 短期/长期记忆（LanceDB 向量检索）
└── Channel(s)
    ├── 微信 / Telegram 原生模块
    └── OpenClaw Host Shim（crabot-channel-host/，跑 OpenClaw 生态插件）
```

## 端口分配

| 服务 | 端口 |
|------|------|
| Module Manager | 19000 |
| Admin RPC | 19001 |
| Admin Web | 3000 |
| Memory | 19002 |
| OpenClaw Host | 19003 |
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
- [x] 记忆管理界面重构 — `/memory/entries` 条目页模式拆分（browse/search/context）、长期记忆 browse API、SceneProfile 详情强化（L0/L2 校验 + 来源记忆链接）、SceneProfile 治理视图、记忆→画像反向链接、`/memory` 路由精简为直接跳转条目页；前端/后端定向测试与浏览器自测已通过
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
