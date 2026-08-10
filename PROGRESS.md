# Crabot 项目进度

> 最后整理：2026-08-10
> 本文件只保留当前状态、明确 follow-up 和阶段性里程碑；详细实施流水、逐轮 review 与历史测试输出见 Git 历史。压缩前完整版本可用 `git show 49b9cb4:PROGRESS.md` 查看。

## 当前状态

### Manager / Worker v3 已完成生产切换

- PR #80（merge `331fee7`）完成 legacy loop 退役：`wait_for_signal`、legacy task/recovery/resume/cancel/abort RPC 与 Admin 恢复控制链已退出生产；memory graph rebuild 保持 manager-native `trigger_schedule` 路径。
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

### 最近验证基线

- review-fix 定向：6 files / 168 passed。
- Claude/Codex/物化安全套件：3 files / 174 passed。
- handoff continuation：42 passed。
- workers/harness + manager + provision + MCP 回归：31 files / 605 passed。
- Agent 全量基线：2623 passed / 1 failed / 2 skipped；唯一失败为既有 macOS/tmux foreground-command 环境差异（期待 `sleep`，实际 `bash`）。
- Agent TypeScript build 与 `git diff --check` 通过；未生成 `crabot-agent/package-lock.json`。

### 最近运行态检查

- PR #83（merge `21dfb1c`）修复 source user mode 下 builtin MCP tools 路径；部署后 Agent 成功连接 `computer-use`、`git`、`lsp`、`tmux-mcp`、`chrome-devtools`。
- MM、Admin、Agent、Memory、Telegram、Feishu、WeChat 在最近一次只读检查中均为 healthy。
- `market-quotes` 是独立历史自定义 MCP 配置，入口文件缺失；需恢复对应服务或在 Admin 中禁用/删除。

## 当前 follow-up

### 已确认

1. **PR #84 部署后真实验收**：创建实际 Claude Code / Codex worker，核对 task-scoped MCP、`desktop / mcp_skill` 过滤、handoff 权限快照、disabled server 清理及 credential 文件权限。
2. **Claude MCP 配置外置**：当前 project-scope 根 `.mcp.json` 与根 `.gitignore` 副作用是 v3.0.8 明确接受的边界。迁移到 Crabot-owned per-worker 外部路径需调整 provision/启动寻址，并重新验证 Claude trust flow。
3. **权限 schema 迁移纪律**：新增 `ToolAccessConfig` 或 `CliDomain` 类目前，必须先为历史 worker context 做显式 migration；不得依赖 persisted read 静默补齐。
4. **既有 tmux 测试基线**：`tmux-driver.test.ts` 在当前 macOS 环境把 foreground command 识别为 `bash` 而非 `sleep`，需单独校准测试或驱动探针。
5. **PROGRESS 维护**：只记录稳定事实和可执行 follow-up，不再写“待 review / 待 merge”等瞬时状态，也不为回填 merge 元信息单独改文档。

### 需重新确认后再立项

以下来自旧进度表，可能已被后续架构替代；开始实施前必须先核对现有代码、协议和 issue：

- 备份/迁移 Plan 2（导入）旧 worktree 是否仍有未合并价值。
- Memory 短期压缩、长期去重/合并、混合检索，以及 MemoryBrowser 测试 OOM。
- Windows 原生进程树终止验证。
- Admin 配置 push 是否仍缺 `system_prompt / mcp_servers`，以及旧 resume-sweep retry 问题是否已随 legacy retirement 消失。
- internal-maintenance task 是否需要协议级、可执行的 `external_output: forbidden` 出站边界，避免仅依赖 prompt 约束。
- required skill 缺失时是否应统一 fail-closed，而不是只返回普通 tool error 后允许流程继续。
- 是否为 `crabot-agent/tests` 增加独立 TypeScript type-check；当前主 tsconfig 只覆盖 `src/**/*`。
- Claude Code 在 `bypassPermissions` 下可执行任意 Bash，是否需要容器化或等价沙箱硬化。
- Agent Trace 自清理的职责归属与重复清理问题；builtin context compaction 已完成，不再列为未实现项。
- 历史浏览器/live E2E 验收项是否仍未覆盖。

## 里程碑归档

### 2026-08 — Manager/Worker 生产硬化与 legacy cutover

| 日期 | 里程碑 |
|---|---|
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
| Manager/Worker P1～P7 | 完成 WorkerAdapter、多实现探测、ledger/harness、manager loop、read model、scheduler 路由、Admin 只读代理、入站测试网与 builtin 注入；主要 PR 包括 #47/#48。 |
| Task 生命周期 | 修复 terminal/revive/new_task 判定、checkpoint 续写、supplement/resume 权限热刷新、goal 生命周期和状态对账；这些 legacy 入口随后在 8 月 cutover 中退役。 |
| CLI worker | Codex adapter 在 m2 真机校准；Claude/Codex tmux、resume/fork、trace 与交互状态成为 v3 worker 实现。 |
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
