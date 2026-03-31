## 目录下放的每一个文件夹是一个 git 仓库，它们一起组成了完整的项目和项目的参考代码，项目名是 Crabot，是一个 AI 员工

## crabot-docs 目录下有设计文档和协议文档。Crabot 项目是一个文档驱动的项目

## PROGRESS.md 是当前的项目开发进度

## SimpleMem 和OpenViking 是两个值得参考的开源项目

## 文档驱动开发规范（必须遵守）

### 核心原则

代码必须严格对齐协议文档。协议文档是唯一的真相来源（Single Source of Truth）。

### 实现流程

1. **写代码前**：先完整阅读相关协议文档（protocol-*.md、base-protocol.md），确认类型定义、字段名、接口签名
2. **写代码时**：类型名、字段名、方法签名必须与协议文档一字不差。不得自行简化、重命名或合并字段
3. **写代码后**：对照协议文档逐项检查，确保没有偏差

### 常见错误模式（已踩过的坑）

以下是 Flow 模块实现中出现过的文档-代码不一致问题，必须避免：

- **字段名简化**：协议定义 `short_term_memories`，代码写成 `short_term_memory`；协议定义 `task_title`，代码写成 `title`
- **结构扁平化**：协议定义 `ChannelMessage.content` 是 `MessageContent` 对象（含 type/text/media_url），代码简化为 `string`
- **结构合并**：协议定义 `admin_endpoint`、`memory_endpoint`、`channel_endpoints` 是独立的 `ResolvedModule` 字段，代码合并为 `module_endpoints: { admin: string, channels: Record<string, string> }`
- **类型丢失**：协议定义了 `MessageDecision` 联合类型（DirectReplyDecision/CreateTaskDecision/ForwardToWorkerDecision），代码用内联对象类型 `{ type: string; content?: string; ... }` 替代
- **嵌套结构忽略**：协议定义 `ChannelMessage.sender` 是嵌套对象（含 friend_id/platform_user_id），代码扁平化为 `sender_id`

### 根因分析

这些问题的根因是：实现时凭记忆写代码，没有逐字段对照协议文档。尤其在类型定义（types.ts）阶段，如果类型就偏了，后续所有使用这些类型的代码都会跟着偏。

### 检查清单

每次实现新模块或修改现有模块时：
- [ ] 已阅读所有相关协议文档
- [ ] types.ts 中的每个 interface/type 与协议文档逐字段对齐
- [ ] 字段名完全一致（不简化、不重命名）
- [ ] 嵌套结构完全一致（不扁平化、不合并）
- [ ] 联合类型完全一致（不用内联对象替代）

## 配置文件规范（必须遵守）

### 核心原则

**配置文件必须是环境无关的，严禁硬编码任何本地特定路径。**

### 禁止的行为

- **绝对路径**：禁止在配置文件中写死任何绝对路径（如 `/Users/xxx/...`）
- **本地特定路径**：禁止写死开发环境的路径

### 正确做法

1. **使用环境变量**：路径通过环境变量传递
   ```yaml
   database_url: "sqlite:///${DATA_DIR}/litellm/litellm.db"
   ```

2. **使用相对路径**：相对于项目根目录或工作目录
   ```yaml
   database_url: "sqlite:///./data/litellm/litellm.db"
   ```

3. **使用 os.environ**：在配置中引用环境变量
   ```yaml
   database_url: os.environ/DATABASE_URL
   ```

### 检查清单

每次修改配置文件时：
- [ ] 配置文件中没有硬编码的绝对路径
- [ ] 路径通过环境变量或相对路径配置
- [ ] 配置在开发和生产环境都能正常工作

## LiteLLM 集成架构（必须理解）

### 核心原则

**Agent 永远不直连 Provider，必须通过 LiteLLM 代理。** LiteLLM 负责 API 格式转换（openai ↔ anthropic ↔ gemini）。

### 数据流

```
Agent (Anthropic SDK) → LiteLLM (port 4000) → Provider (Ollama/OpenAI/etc)
     format: anthropic      格式转换           format: openai
```

### 关键实现

- `ModelProviderManager.buildConnectionInfo(providerId, modelId)` 是唯一的连接信息解析入口
  - 将 Provider 原始信息（endpoint, apikey, format）转换为 LiteLLM 路由信息
  - 输出 `endpoint: http://localhost:4000`（不含 /v1，Anthropic SDK 自动追加 /v1/messages）
  - 输出 `format: 'anthropic'`
  - 输出 `model_id: 'provider-{id前缀}-{清理后的模型名}'`（LiteLLM 注册的模型名）

- `handleGetAgentConfig` 在返回配置给 Agent 前，通过 `buildConnectionInfo` 解析每个 model role

### 常见错误模式（已踩过的坑）

- **直传 Provider 原始信息给 Agent**：前端选择 Provider 后直接存 `endpoint/apikey/format`，Agent 收到 `format: 'openai'` 崩溃
- **endpoint 包含 /v1**：Anthropic SDK 的 baseURL 不应含 /v1，否则请求变成 `/v1/v1/messages` → 404
- **LiteLLM 模型名不匹配**：Agent 必须使用 LiteLLM 注册的模型名（如 `provider-bdbf737d-qwen35-cloud`），不是原始模型名（如 `qwen3.5:cloud`）

## 模块配置架构（必须理解，反复踩坑的重灾区）

### 核心原则（详见 protocol-admin.md §3.19）

**Admin Web 是唯一的配置入口。配置存储引用（provider_id + model_id），不存快照（endpoint, apikey）。Admin 实时解析引用为连接信息。**

### 配置层级

```
第一层：全局默认（Admin 全局设置页面）
  → default_llm_provider_id + default_llm_model_id
  → default_embedding_provider_id + default_embedding_model_id

第二层：Agent 实例 slot 配置（Admin Agent 配置页面）
  → models: { "default": { provider_id, model_id }, "smart": { ... }, "fast": { ... } }
  → 每个 slot 存储 provider_id + model_id（引用）
```

### 解析逻辑（handleGetAgentConfig）

```
对于 Agent 声明的每个 model slot：
  1. 如果 Agent 实例配置了此 slot → 用 buildConnectionInfo(provider_id, model_id) 实时解析
  2. 如果没配 → 用全局默认的 provider_id + model_id 实时解析
  3. 都没有 → 报错

buildConnectionInfo 的职责：
  provider_id + model_id → 查 Provider 列表 → 生成 LiteLLM 路由信息
  → 返回 { endpoint: litellm_url, apikey: litellm_key, model_id: litellm_name, format: 'anthropic' }
```

### 数据流

```
用户在 Admin UI 配置
  → 保存到磁盘（引用格式）
  → requestSync()（LiteLLM 模型同步）
  → pushConfigToAgentModules()（推送到运行中的 Agent）

Agent 启动 / 收到 push
  → RPC: get_agent_config
    → handleGetAgentConfig() 读取存储的引用 + 实时解析为连接信息
    → 返回给 Agent
```

### 已踩过的坑（严禁重犯）

- **存快照不存引用**：model_config 存了 endpoint/apikey 快照 → Provider 改了配置不生效
- **遍历空 model_config 的 keys**：首次创建时 `model_config: {}` → 解析后也是空 → "未配置"
- **populateModelConfig 静默失败**：首次启动时全局 LLM 未配，catch 吞掉错误
- **三级 fallback 回退到过期数据**：provider 解析失败时回退到旧快照，导致用旧配置运行
- **从代码反推架构**：应以 protocol-admin.md §3.19 为准，不以现有代码实现为准

## Agent 调试（快速参考）

遇到 Agent 相关问题时，先用调试脚本排查（Node.js 实现，支持短 ID 前缀匹配）：

```bash
node scripts/debug-agent.mjs health   # 确认各模块存活
node scripts/debug-agent.mjs traces   # 查看最近 trace
node scripts/debug-agent.mjs trace    # 查看最新 trace 详情（含 span 树，支持短 ID）
node scripts/debug-agent.mjs tasks    # 查看 Admin 任务状态
node scripts/debug-agent.mjs logs     # 查看 SDK Runner 日志
node scripts/debug-agent.mjs modules  # 查看 MM 注册的模块
```

旧的 `./scripts/debug-agent.sh` 仍可用（转发到 .mjs）。

完整调试手册：[docs/agent-debugging.md](docs/agent-debugging.md)

## 开发环境（必须了解）

### dev.sh（推荐的开发方式）

```bash
./dev.sh          # 启动：构建 TS + 启动 Module Manager + 启动 Vite HMR (port 5173)
./dev.sh stop     # 停止所有进程
./dev.sh build    # 只构建不启动
./dev.sh vite     # 只启动 Vite（后端已在运行时）
```

- 前端改代码 → 浏览器自动刷新（Vite HMR）
- 后端改代码 → 需要 `./dev.sh stop && ./dev.sh`（重新构建）
- **launcher.sh 不适合开发**：没有构建步骤，代码改了不生效

### 前端构建须知

- 前端源码在 `crabot-admin/web/src/`，构建产物在 `crabot-admin/dist/web/`
- Admin 后端（port 3000）serve 的是构建后的静态文件，不是源码
- Vite 开发服务器（port 5173）代理 `/api` 和 `/ws` 到后端 port 3000
- **改了前端代码不生效？** 检查是通过 port 5173（Vite）还是 port 3000（静态文件）访问的

### 环境变量

- `data/admin/.env` 含 `CRABOT_ADMIN_PASSWORD`
- `.env` 含 `LITELLM_BASE_URL`、`LITELLM_MASTER_KEY`、`LITELLM_CONFIG_PATH` 等
- LiteLLM 默认: port 4000, master key `sk-litellm-test-key-12345`

### 端口分配

| 服务 | 默认端口 | 说明 |
|------|----------|------|
| Module Manager | 19000 | 核心进程管理 |
| Admin (RPC) | 19001 | 模块间通信 |
| Admin (Web) | 3000 | REST API + 静态文件 |
| Agent | 19002+ | 由 Module Manager 动态分配 |
| LiteLLM | 4000 | LLM 代理 |
| Vite Dev | 5173 | 前端 HMR（仅开发） |

### 多实例部署

同一台机器可运行多个 Crabot 实例，通过 `CRABOT_PORT_OFFSET` 环境变量隔离端口和数据：

```bash
# 实例 A（默认，无需配置）
./dev.sh

# 实例 B（所有端口 +100，数据目录自动变为 data-100/）
CRABOT_PORT_OFFSET=100 ./dev.sh

# 实例 C（也可显式指定数据目录）
CRABOT_PORT_OFFSET=200 DATA_DIR=/data/tenant-c ./dev.sh
```

端口映射规则：所有默认端口 + offset（如 offset=100 时，MM=19100, Admin RPC=19101, Admin Web=3100, LiteLLM=4100）。每个实例占用 100 个端口范围（19002-19099 → 19102-19199）。

