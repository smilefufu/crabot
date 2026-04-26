## 目录下放的每一个文件夹是一个 git 仓库，它们一起组成了完整的项目和项目的参考代码，项目名是 Crabot，是一个 AI 员工

## crabot-docs 目录下有设计文档和协议文档。Crabot 项目是一个文档驱动的项目

## SimpleMem 和OpenViking 是两个值得参考的开源项目

## PROGRESS.md 记录了项目进度，包括一些待办事项等。做好对该文件的维护，及时清理或压缩不再需要的已完成事项，以确保文件不会过长

## 文档驱动开发规范（必须遵守）

### 核心原则

代码必须严格对齐协议文档。协议文档是唯一的真相来源（Single Source of Truth）。

### 实现流程

1. **写代码前**：先完整阅读相关协议文档（protocol-*.md、base-protocol.md），确认类型定义、字段名、接口签名
2. **写代码时**：类型名、字段名、方法签名必须与协议文档一字不差。不得自行简化、重命名或合并字段
3. **写代码后**：对照协议文档逐项检查，确保没有偏差

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
   data_path: "${DATA_DIR}/agent/state.json"
   ```

2. **使用相对路径**：相对于项目根目录或工作目录
   ```yaml
   data_path: "./data/agent/state.json"
   ```

### 检查清单

每次修改配置文件时：
- [ ] 配置文件中没有硬编码的绝对路径
- [ ] 路径通过环境变量或相对路径配置
- [ ] 配置在开发和生产环境都能正常工作

## LLM Provider 连接架构（必须理解）

### 核心原则

**Agent 直连 Provider 原生 API，不经过任何代理。** 由 Agent 内部的多格式适配器层（`crabot-agent/src/engine/llm-adapter.ts`）根据 `format` 路由到对应 SDK。

> 历史备注：2026-04 之前曾有 LiteLLM 代理层（port 4000）做格式转换，现已完全移除。如果在旧文档或 memory 里看到 LiteLLM、port 4000、`LITELLM_BASE_URL/MASTER_KEY`、`provider-<hash>-<model>` 这类命名，一律视为过时信息，以本文件和代码为准。

### 数据流

```
Agent (engine/llm-adapter.ts)
  ├── format=anthropic          → AnthropicAdapter      → Anthropic SDK
  ├── format=openai             → OpenAIAdapter         → OpenAI SDK
  ├── format=gemini             → OpenAIAdapter         → Gemini 的 OpenAI 兼容端点
  └── format=openai-responses   → OpenAIResponsesAdapter → ChatGPT Responses API（OAuth）
```

适配器工厂位置：`crabot-agent/src/engine/llm-adapter.ts` 的 `createAdapter({endpoint, apikey, format, accountId?})`。

### 连接信息解析入口

`ModelProviderManager.buildConnectionInfo(providerId, modelId)`（`crabot-admin/src/**` 内）是唯一的连接信息解析入口，返回 Provider 原生连接信息：

```typescript
{
  endpoint: provider.endpoint,    // 直接是 Provider 原生端点（如 https://api.openai.com）
  apikey: provider.api_key,       // 原生 API key；OAuth 场景返回已刷新的 access_token
  model_id: model.model_id,       // 原生模型名（如 gpt-4o、claude-sonnet-4-6）
  format: provider.format,        // 'anthropic' | 'openai' | 'gemini' | 'openai-responses'
  provider_id,
  max_tokens?, supports_vision?,
  account_id?                     // OAuth 专用
}
```

**OAuth token 自动刷新**：`buildConnectionInfo` 内部检测 token 过期并自动刷新，对调用方透明。

`handleGetAgentConfig` 在把配置返回给 Agent 前，对每个 model role 调 `buildConnectionInfo` 实时解析。

### 常见错误模式（已踩过的坑）

- **endpoint 不匹配 format**：endpoint 指向 OpenAI 但 format='anthropic' → 适配器发错 schema 请求
- **把废弃字段塞回配置**：旧代码里可能残留 `litellm_url`、`provider-<hash>-<name>` 这类字段，新代码严禁引入
- **OAuth 配置绕过 buildConnectionInfo**：会拿到过期 token，必须走解析入口以触发刷新

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
  1. 如果 Agent 实例配置了此 slot → buildConnectionInfo(provider_id, model_id) 实时解析
  2. 如果没配 → 用全局默认的 provider_id + model_id 实时解析
  3. 都没有 → 报错

返回给 Agent 的 model_config[role] 是 Provider 原生连接信息，Agent 侧直接喂给 createAdapter()
```

### 数据流

```
用户在 Admin UI 配置
  → 保存到磁盘（引用格式）
  → pushConfigToAgentModules()（推送到运行中的 Agent）

Agent 启动 / 收到 push
  → RPC: get_agent_config
    → handleGetAgentConfig() 读取存储的引用 + 实时解析为 Provider 原生连接信息
    → 返回给 Agent → createAdapter({endpoint, apikey, format, accountId?})
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
node scripts/debug-agent.mjs logs     # 查看 Worker Handler 日志
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
- `dev.sh` 只启动 Module Manager，由 MM 拉起 Admin / Agent / Memory 子进程；**不再启动任何 LLM 代理进程**

### 前端构建须知

- 前端源码在 `crabot-admin/web/src/`，构建产物在 `crabot-admin/dist/web/`
- Admin 后端（port 3000）serve 的是构建后的静态文件，不是源码
- Vite 开发服务器（port 5173）代理 `/api` 和 `/ws` 到后端 port 3000
- **改了前端代码不生效？** 检查是通过 port 5173（Vite）还是 port 3000（静态文件）访问的

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

端口映射规则：所有默认端口 + offset（如 offset=100 时，MM=19100, Admin RPC=19101, Admin Web=3100）。每个实例占用 100 个端口范围（19002-19099 → 19102-19199）。
