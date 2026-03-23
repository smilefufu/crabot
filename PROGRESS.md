# Crabot 项目进度

> 最后更新：2026-03-23 — McpServer Protocol reuse bug 修复

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
│   ├── Front Handler（快速分诊，3 次重试）
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

---

## 待实现

### 🔴 高优先级

| 功能 | 说明 |
|------|------|
| 端到端集成测试 | 飞书/OpenClaw → Agent → 回复完整链路验证 |
| SwitchMap 合并重处理 | 被中断消息合并后重新处理（当前只取消不合并） |
| 群聊自适应 Debounce | GroupDebounceManager，退避算法 5s→25s→125s→300s（见 protocol-agent-v2.md §5.2） |

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
