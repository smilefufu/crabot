## crabot-docs 目录下有设计文档和协议文档。Crabot 项目是一个文档驱动的项目。文档目录是独立仓库。

## PROGRESS.md 记录了项目进度，包括一些待办事项等。做好对该文件的维护，及时清理或压缩不再需要的已完成事项，以确保文件不会过长

## 写代码时必须要注意的核心原则

1. **先想清楚再写代码**：不要替用户偷偷假设；不确定就问；有多种理解要摊开说；该 push back 时要 push back。
2. **简单优先**：只写满足需求的最小代码；不做没要求的“灵活性/可配置”；不为了单次使用抽象一堆东西；200 行能变 50 行就重写。
3. **外科手术式修改**：只动必须动的地方；不顺手重构、不改相邻注释/格式；保持项目现有风格；发现无关死代码只提醒，不擅自删。判断标准是：每一行改动都能追溯到用户需求。
4. **目标驱动执行**：把任务转成可验证目标，比如“修 bug”先写复现测试再修到通过；多步任务要列“步骤 → 验证方式”；一直循环到验证通过。

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

完整调试手册：[crabot-docs/guides/agent-debugging.md](crabot-docs/guides/agent-debugging.md)

## 模块恢复机制（已上线）

### 自动重启

- 内置核心模块（admin/agent/memory）`auto_restart: true`，意外退出走指数退避
- 退避：1s → 2s → 4s → 8s → 10s 上限
- 限流：5 分钟内最多 3 次；超限置 status=error，发 module.health_changed 事件
- 仅 `crashed` 触发；`shutdown`/`forced` 不重启

### 人工兜底

- Admin Web `/modules` 页：模块状态 + 看日志 + 一键重启
- 子进程 stdout/stderr 持续落到 `data/logs/<moduleId>.log`
- agent fatal 错误（unhandled rejection / uncaught exception）写到 `data/agent/fatal.log`

### Self-healing recovery 任务

- agent 重启（restart_count>0）后，admin 自动：
  1. 把所有 status=executing 任务标 failed
  2. 为非 recovery in-flight 任务生成一条 recovery worker 任务（tags=['recovery'], priority=high）
  3. 让 agent 用 find_task / get_task_progress 自查每条进度并续办或汇报
- 防雪崩：recovery 任务自身崩了不再派生新 recovery

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

### 实例隔离（单实例约束）

Crabot **强制单实例运行**。每个用户 / 每台机器（dev 模式）最多跑一个 Crabot MM。多用户场景请走 system mode（见下方）。

- 生产 user mode（`install.sh` 默认装的 `~/.crabot`）：永远 OFFSET=0，DATA_DIR=`~/.crabot/data`
- 生产 system mode：每个 Linux 用户由 `crabot init` 自动绑定唯一 OFFSET，DATA_DIR=`~/.crabot/data-<OFF>`
- dev 模式（`./dev.sh`）：永远 OFFSET=0，DATA_DIR=`$REPO_ROOT/data`

`CRABOT_PORT_OFFSET` **不再是用户级配置入口**——它只在 system mode 下由 `crabot init` 内部自动分配，写入员工 shell rc + `~/.crabot/instance.json` 后**不要再手动改**。

单实例约束的实现：`scripts/start.mjs` / `dev.sh` 启动前检查 `$DATA_DIR/mm.pid`，活进程 → 报错"already running"；stale → 清理后继续。

### System Mode 多用户部署

针对"root 全局安装 + 多 Linux 用户各跑自己实例"的服务器部署形态。

- **入口**：`sudo install.sh --system` 装到 `/opt/crabot`，创建 `/etc/crabot/` 骨架 + `crabot` group + `/etc/logrotate.d/crabot` + `/usr/local/bin/crabot` 软链
- **员工首次跑 `crabot start`** 自动触发 `crabot init`：从 `/etc/crabot/registry/ports.json` 申请 OFFSET（文件锁原子分配，永久绑定该 Linux 用户）+ 写 shell rc。`/etc/crabot/cluster.version` 文件仅作 system mode 探测标记（`detectMode` / vendor-registry 判存在与否），其数字不再有任何门控语义
- **root→员工下发（仅供应商目录）**：root 改 `/etc/crabot/defaults/vendor.yaml`（或 `sudo crabot vendor add`）→ admin 在 system mode **直读**该文件（`crabot-admin/src/vendor-registry.ts`），各员工 admin 下次重启自动生效。**无需 sync、无需递增 cluster.version**
- **`crabot sync` 已退役（no-op）**：早期它把 `provider.yaml`/`agent.yaml` 默认下发到员工本地，但那两份文件从未被任何代码消费（孤儿），sync 实际不生效。已改为直读 vendor.yaml，sync 保留只为兼容旧习惯、不做任何事。`start` 也不再有 cluster.version 版本门
- **后台 + 状态命令**：`crabot start -d`（spawn supervisor + 日志轮转 10MB×5）；`crabot status`（人类视图 + `--json`）；`crabot stop` 自动找 PID（兼容前台/后台）
- **Migration**：`crabot upgrade` 主路径 + `crabot start` 兜底两边都跑（idempotent）
- **upgrade 权限**：system mode 下非 root 跑 `crabot upgrade` → 拒绝，提示请联系管理员

## 语义边界与复用审查（必须遵守）

### 核心原则

复用现有代码入口前，必须先确认它的语义边界。不要因为某个函数“刚好能跑通流程”，就把它当成通用入口使用。

### 禁止的行为

- 禁止把带有明确业务语义的入口当作通用工具复用。
  例如：名称、注释或协议中明确属于某类场景的 runner / handler / adapter，不得直接用于另一类场景，除非先抽出无语义的通用层。
- 禁止只验证“参数传进去了”而不验证“运行时语义仍正确”。
- 禁止在实现计划中用“复用现有 X”跳过语义审查。

### 正确做法

1. **复用前列出隐式语义**
   - 该入口会不会修改 task source / trigger type？
   - 会不会改变权限、身份、会话、投递目标？
   - 会不会影响状态机、审计、goal mode、delivery gate、错误处理？
   - 会不会注入特殊 system message 或占位 session？

2. **语义不一致时先抽通用层**
   - 如果多个流程只是共享“后台执行 worker loop”能力，应抽出无场景语义的通用执行入口。
   - 原有 scheduled / recovery / resume 等入口只负责组装各自语义，再调用通用层。

3. **测试必须覆盖语义不变量**
   - 不只断言函数被调用、参数被透传。
   - 必须断言关键语义保持正确：任务来源、权限身份、会话目标、状态迁移、审计/交付门控是否符合原场景。

### 实现计划检查清单

每次计划中出现“复用现有入口 / 复用现有 runner / 参考某路径实现”时，必须补一段：

- [ ] 被复用入口的原始语义是什么？
- [ ] 新场景与原始语义是否完全一致？
- [ ] 若不一致，是否已抽出无场景语义的通用层？
- [ ] 是否有测试覆盖关键语义不变量，而不仅是参数透传？
