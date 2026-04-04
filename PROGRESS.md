# Crabot 项目进度

> 最后更新：2026-04-04 — Engine V2 Phase 4 开始（核心内置工具）

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

### Engine V2 重构完成 ✅
**总计**: 6 Phases, 29 Tasks, 311 tests, ~3000 LOC engine + tools
**分支**: `feat/engine-v2` (ready for PR)

---

## 系统架构

```
Module Manager (port 19000)
├── Admin (RPC 19001, Web 3000)
│   ├── Friend / Permission 管理
│   ├── LLM Provider 管理（→ LiteLLM 同步）
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
├── LiteLLM Proxy (port 4000)
│   └── API 格式转换（Anthropic ↔ OpenAI）
└── Channel(s)
    ├── 飞书 Channel（crabot-channel-feishu/）
    └── OpenClaw Host Shim（crabot-channel-host/）
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
| LiteLLM | 4000 |
| Vite Dev | 5173 |

---

## 已完成

- [x] Module Manager — 生命周期、端口分配、事件总线
- [x] Admin 模块 — Friend 管理、Task/Schedule、LLM Provider、Agent 配置、Master Chat、PTY 终端
- [x] Agent 模块 — 编排层 + Front/Worker Handler，LiteLLM 接入
- [x] Memory 模块 — 短期记忆读写、向量检索、管理界面
- [x] LiteLLM 集成 — Provider CRUD 自动同步，Anthropic format 统一
- [x] Channel 飞书 — 完整 protocol-channel.md 实现
- [x] Channel OpenClaw Shim — 插件兼容层，jiti 加载 TS 插件
- [x] 消息鉴权网关重构 — Channel 只发布原始消息，Admin 做 Friend 解析和鉴权，Agent 订阅 channel.message_authorized
- [x] dev.sh 修复 — LiteLLM 进程清理、LITELLM_USE_CHAT_COMPLETIONS_URL_FOR_ANTHROPIC_MESSAGES 环境变量
- [x] MCP Server + Skill 系统 Phase 1 — 全局注册表（protocol-admin.md §3.16/3.17 扩充），Admin 后端 Manager（MCPServerManager/SkillManager/EssentialToolsManager），Admin 前端 CRUD 页面，Agent 配置 ID 引用解析
- [x] Agent Loop 可观测性 — 通用 Trace 规范（protocol-agent-v2.md §8），Ring Buffer TraceStore，前后端可视化 Trace/Span 树
- [x] Front Handler 工具调用改进 — 保留默认工具集，maxTurns 1→3，结果路由（JSON 决策/纯文本/工具失败自动升级），简单任务直接执行、复杂任务创建 task 派 Worker
- [x] Agent 模块 Skills/MCP/聊天历史/crab-messaging 修复 — Skills UI 简化，消息预加载量优化（Front 10 条 / Worker 20 条），crab-messaging MCP Server 5 工具实现，对齐 protocol-crab-messaging.md，路径安全验证，TypeScript 编译零错误
- [x] 全局配置热更新 + 模型配置统一管控 — Memory 模块 reconfigure() 热更新、update_config RPC，Admin 推送配置无需重启；Agent/Memory 配置根因修复（全局配置唯一真相来源，模块不缓存 LLM 连接信息），反转 merge 顺序确保全局优先
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
./dev.sh stop     # 停止所有进程（含 LiteLLM）
./dev.sh build    # 只构建不启动
./dev.sh vite     # 只启动 Vite
```
