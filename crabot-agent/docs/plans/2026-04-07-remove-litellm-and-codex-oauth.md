# 去 LiteLLM 化 + ChatGPT 订阅 OAuth 接入

> 创建日期: 2026-04-07
> 状态: 待实施

## Context

### 为什么要做这个改动

Agent Engine V2 已完成（2026-04-04），原生支持 anthropic/openai/gemini 三种 API 格式。LiteLLM 作为格式转换代理的核心价值已被 V2 adapter 替代。同时，Memory 模块本身就使用 OpenAI SDK 直连，不依赖 LiteLLM proxy。

当前 LiteLLM 带来的负面成本：
- 额外进程 + 端口占用（port 4000）
- 版本锁定 v1.82.6 + 两个自定义补丁维护
- 多一层网络跳转（Agent → LiteLLM → Provider）
- 第三方 bug 不可控（如 Responses API tool_use 翻译失败 #16215）
- 配置同步复杂度（config.yaml 生成 + requestSync + LiteLLM 重启）

去掉 LiteLLM 后，可以直接接入 ChatGPT 订阅 OAuth（走 Responses API），绕过 LiteLLM 的格式转换限制。

### 预期成果

- Agent 和 Memory 直连 Provider，无中间代理
- 支持 ChatGPT 订阅用户通过 OAuth 登录使用模型
- 架构更简洁：Admin 存引用 → 解析为 provider 原始连接信息 → 下发给各模块

### 架构变更概览

```
改动前:
  Agent (Anthropic SDK) → LiteLLM (port 4000) → Provider
  Memory (OpenAI SDK)   → LiteLLM (port 4000) → Provider

改动后:
  Agent (V2 multi-format adapter) → Provider (直连)
  Memory (multi-format adapter)   → Provider (直连)
```

---

## Phase 1: 去 LiteLLM 化

### Step 1.1: buildConnectionInfo 改为返回 provider 原始信息

**目标**：`buildConnectionInfo()` 不再返回 LiteLLM 路由信息，改为返回 provider 的原始 endpoint/apikey/model_id/format。

**改动文件**：
- `crabot-admin/src/model-provider-manager.ts` (核心改动)
  - `buildConnectionInfo()`: 返回 provider 原始 endpoint、apikey、model_id、format
  - 移除 `generateLiteLLMModelName()`
  - 移除 `buildLiteLLMModelId()`
  - 移除 `syncToLiteLLMConfig()`
  - 移除 `requestSync()`
  - 移除 `restartLiteLLM()`
  - 移除 `waitForLiteLLMHealth()`
  - 移除 `computeNeededModelKeys()` 相关逻辑
- `crabot-admin/src/litellm-client.ts` — 整个文件删除
- `crabot-admin/src/types.ts` — 移除 `litellm_model_name`、`litellm_key` 等 LiteLLM 相关字段

**改动前后对比**：
```typescript
// 改动前
buildConnectionInfo(providerId, modelId) {
  return {
    endpoint: this.litellmBaseUrl,           // http://localhost:4000
    apikey: this.litellmMasterKey,           // sk-litellm-test-key-12345
    model_id: 'provider-bdbf737d-qwen35',   // LiteLLM 别名
    format: 'anthropic' as const,            // 硬编码 anthropic
  }
}

// 改动后
buildConnectionInfo(providerId, modelId) {
  const provider = this.providers.get(providerId)
  const model = provider.models.find(m => m.model_id === modelId)
  return {
    endpoint: provider.endpoint,              // https://api.openai.com/v1
    apikey: provider.api_key,                 // sk-proj-xxx
    model_id: model.model_id,                 // gpt-4o
    format: provider.format,                  // 'openai'
    max_tokens: model.max_tokens,
    supports_vision: model.supports_vision,
  }
}
```

**Endpoint 格式约定**：
- endpoint 存储不含 `/v1` 的 base URL
- 各 adapter 自行拼接路径（AnthropicAdapter: SDK 自动追加 `/v1/messages`；OpenAIAdapter: 拼接 `/v1/chat/completions`）

### Step 1.2: 移除 LiteLLM 进程管理

**改动文件**：
- `dev.sh` — 移除 LiteLLM 启动/停止/健康检查/补丁逻辑
- `scripts/lib.sh` — 移除 `start_litellm()`、`apply_litellm_patches()`、版本锁定逻辑
- `launcher.sh` — 移除 LiteLLM 相关逻辑
- `.env` — 移除 `LITELLM_BASE_URL`、`LITELLM_MASTER_KEY`、`LITELLM_CONFIG_PATH`
- `crabot-admin/src/index.ts` — 移除 LiteLLM 相关的初始化和配置同步调用

**释放资源**：端口 4000、LiteLLM PID 文件、data/litellm/ 目录

### Step 1.3: Admin 配置下发流程适配

**改动文件**：
- `crabot-admin/src/index.ts`:
  - `handleGetAgentConfig()`: 无需大改，buildConnectionInfo 返回值变了，下游自动生效
  - `buildGlobalModelEnv()`: 返回 provider 原始 endpoint/apikey/model，而非 LiteLLM 路由信息
  - `syncGlobalConfigToMemoryModules()`: 移除 `requestSync()` 调用，其余不变
  - `pushConfigToAgentModules()`: 无需改动，model_config 结构不变

**新增字段**：Memory 配置需新增 `format` 字段（当前只传 api_key/base_url/model，不传 format）
```typescript
// buildMemoryRpcConfig 返回值新增 format
{
  llm: { api_key, base_url, model, format },        // 新增 format
  embedding: { api_key, base_url, model, dimension } // embedding 固定 OpenAI 格式，不需要 format
}
```

### Step 1.4: Memory 模块多格式支持

**目标**：Memory 的 LLM 调用支持 openai 和 anthropic 两种格式。Embedding 仍仅支持 OpenAI 格式（Anthropic 没有 embedding API）。

**改动文件**：
- `crabot-memory/src/utils/llm_client.py` — 重构为多格式 adapter
- `crabot-memory/src/config.py` — LLM config 新增 `format` 字段
- `crabot-memory/src/module.py` — `_update_config` 接收并传递 `format`
- `crabot-memory/pyproject.toml` — 新增 `anthropic` Python SDK 依赖

**实现方式**（参考 Agent V2 的 adapter 模式）：

```python
# llm_client.py
class LLMClient:
    def __init__(self, format: str, api_key: str, base_url: str, model: str):
        self._format = format  # 'openai' | 'anthropic'
        self._adapter = self._create_adapter(format, api_key, base_url)
        self._model = model

    def _create_adapter(self, format, api_key, base_url):
        if format == 'anthropic':
            from anthropic import AsyncAnthropic
            return AsyncAnthropic(api_key=api_key, base_url=base_url)
        else:  # openai, gemini 等都走 OpenAI 兼容
            from openai import AsyncOpenAI
            return AsyncOpenAI(api_key=api_key, base_url=base_url)

    async def chat(self, system_prompt: str, user_message: str, **kwargs) -> str:
        if self._format == 'anthropic':
            resp = await self._adapter.messages.create(
                model=self._model,
                system=system_prompt,
                messages=[{"role": "user", "content": user_message}],
                max_tokens=kwargs.get('max_tokens', 2048),
            )
            return resp.content[0].text
        else:
            resp = await self._adapter.chat.completions.create(
                model=self._model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ],
                **kwargs,
            )
            return resp.choices[0].message.content
```

Memory 的 LLM 用途都是简单的 prompt→response（关键词提取、摘要生成、去重判断），不涉及 streaming 或 tool_use，所以 adapter 非常轻量。

**Embedding 约束**：Embedding 仍只支持 OpenAI 兼容 API（Anthropic 无 embedding API）。Admin UI 在配置 Memory 的 embedding provider 时，应只显示 OpenAI 格式的 provider。

### Step 1.5: Admin UI 适配

#### 1.5a: 全局默认配置
- `crabot-admin/web/src/pages/Providers/GlobalModelConfigCard.tsx`:
  - **LLM 配置**：无格式限制，所有 provider 都可选（Agent V2 支持所有格式）
  - **Embedding 配置**：过滤只显示 `format !== 'anthropic'` 的 provider（Anthropic 无 embedding API）
  - 新增提示文案：当全局 LLM 和 Embedding 使用不同 provider 时，显示说明

#### 1.5b: Agent 模型角色配置
- `crabot-admin/web/src/pages/Agents/AgentConfig.tsx`:
  - 模型角色的 provider 下拉：显示所有 provider（V2 支持所有格式）
  - 每个 provider 选项旁显示 format 标签（如 `OpenAI [openai]`、`Claude [anthropic]`）

#### 1.5c: Provider 管理
- `crabot-admin/web/src/pages/Providers/ProviderManagement.tsx`:
  - 移除任何 LiteLLM 相关的状态展示（如果有）

### Step 1.6: 协议文档更新

- `crabot-docs/protocols/protocol-admin.md`:
  - §3.19: 移除 LiteLLM/New API 相关描述
  - 更新 buildConnectionInfo 行为描述（返回 provider 原始信息）
  - 更新数据流图
- `crabot-docs/protocols/base-protocol.md`:
  - §5.13 ModelConnectionInfo: format 字段说明更新（不再固定 anthropic）

---

## Phase 2: ChatGPT 订阅 OAuth 接入

### Step 2.1: V2 引擎新增 openai-responses adapter

**目标**：支持 OpenAI Responses API 格式（区别于现有的 Chat Completions 格式）。

**改动文件**：
- `crabot-agent/src/engine/llm-adapter.ts`:
  - 新增 `LLMFormat` 值：`'openai-responses'`
  - 新增 `OpenAIResponsesAdapter` 类
  - 更新 `createAdapter()` 工厂函数

**OpenAI Responses API vs Chat Completions 的关键差异**：

| 维度 | Chat Completions | Responses API |
|------|-----------------|---------------|
| 端点 | `/v1/chat/completions` | `/v1/responses` |
| 输入 | `messages` 数组 | `input` (string 或 items) + `instructions` |
| 输出 | `choices[].message` | `output` items |
| 状态管理 | 客户端管理完整历史 | 服务端 `previous_response_id` |
| Tool 调用 | `tool_calls[].function` | `output` 中的 function_call items |
| 流式格式 | delta-based chunks | event-driven items |

**实现要点**：
- 请求体构造：将 EngineMessage[] 转换为 Responses API 的 input items 格式
- SSE 解析：处理 Responses API 的事件流格式
- Tool call 提取：从 output items 中提取 function_call
- 对 `chatgpt.com/backend-api/codex/responses` 端点特殊处理：
  - 注入 `Authorization: Bearer <oauth_token>`
  - 注入 `ChatGPT-Account-Id: <account_id>`（可选）
  - 自动添加 `service_tier: "priority"`

### Step 2.2: Admin 新增 ChatGPT Subscription provider 类型

**改动文件**：
- `crabot-admin/src/types.ts`:
  - `ApiFormat` 新增 `'openai-responses'`
  - `ProviderConfigType` 新增 `'oauth'`
  - 新增 `OAuthCredential` 类型
- `crabot-admin/src/preset-vendors.ts`:
  - 新增 ChatGPT Subscription 预置厂商
- `crabot-admin/src/model-provider-manager.ts`:
  - `buildConnectionInfo` 对 oauth 类型 provider：返回 OAuth access_token 作为 apikey
  - 新增 `refreshOAuthToken()` 方法
  - 新增 ChatGPT 可用模型列表

### Step 2.3: OAuth PKCE 登录流程（Admin 后端）

**新增文件** `crabot-admin/src/oauth/`:
- `oauth-pkce.ts` — PKCE 流程实现
- `oauth-callback-server.ts` — localhost:1455 回调服务器
- `oauth-token-manager.ts` — token 存储、刷新、JWT 解析
- `openai-codex-oauth.ts` — OpenAI Codex OAuth 配置

**OAuth 流程**：
```
1. Admin 前端点击 "ChatGPT 登录"
2. Admin 后端生成 PKCE verifier + challenge + state
3. Admin 后端启动 localhost:1455 回调服务器
4. 返回授权 URL → 前端在新窗口打开
5. 用户在 OpenAI 页面登录
6. 回调到 localhost:1455/auth/callback?code=xxx&state=xxx
7. Admin 后端用 code 换 token（POST auth.openai.com/oauth/token）
8. 解析 JWT：提取 email、account_id、expiry
9. 存储 tokens 到 provider 配置
10. 关闭回调服务器，通知前端登录成功
```

**关键参数**：
- Authorization endpoint: `https://auth.openai.com/oauth/authorize`
- Token endpoint: `https://auth.openai.com/oauth/token`
- Client ID: `app_EMoamEEZ73f0CkXaXp7hrann`（Codex CLI 公开 client_id）
- Redirect URI: `http://127.0.0.1:1455/auth/callback`
- Scope: `openid profile email offline_access`
- Grant type: `authorization_code` (with PKCE)

### Step 2.4: Admin REST API

**新增端点**：
- `POST /api/oauth/chatgpt/login` — 发起 OAuth 登录，返回授权 URL
- `GET /api/oauth/chatgpt/status` — 查询 OAuth 登录状态
- `POST /api/oauth/chatgpt/logout` — 清除 OAuth token
- `GET /api/oauth/chatgpt/token-info` — 返回 token 信息

### Step 2.5: Admin UI — ChatGPT 订阅 Provider 界面

#### Provider 创建
- `ProviderDrawerCreate.tsx`: 预置厂商新增 "ChatGPT 订阅"
  - 隐藏 API Key 输入，显示 "登录 ChatGPT" 按钮
  - OAuth 登录成功后显示邮箱、订阅类型、token 有效期

#### Provider 详情/编辑
- `ProviderDrawerDetail.tsx`: OAuth provider 显示登录邮箱、Token 状态、重新登录/登出按钮
- `ProviderDrawerEdit.tsx`: OAuth provider endpoint 不可编辑

#### 前端类型
- `types/index.ts`: `ApiFormat` 新增 `'openai-responses'`，`ModelProvider` 新增 `auth_type`、`oauth_info`

#### 前端服务
- `services/provider.ts`: 新增 OAuth 相关 API 调用

---

## 风险与注意事项

### Phase 1 风险

1. **Endpoint 格式差异**：建议 endpoint 存储不含 `/v1` 的 base URL，各 adapter 自行拼接路径
2. **回归测试**：去 LiteLLM 后所有 provider 需重新测试直连
3. **Memory Embedding 约束**：Anthropic 无 embedding API，需在 UI 和后端双重验证
4. **Gemini 格式**：暂时走 Gemini 的 OpenAI 兼容端点，后续再做原生 adapter

### Phase 2 风险

1. **OAuth client_id 可能被封**：使用 Codex CLI 公开 client_id，OpenAI 未来可能限制
2. **Responses API 格式可能变化**：非公开 API，格式可能调整
3. **Token 刷新竞争**：多个 Agent 实例同时刷新同一 token 需要加锁

---

## 验证计划

### Phase 1

- buildConnectionInfo 返回 provider 原始信息（单元测试）
- Memory LLMClient 多格式 adapter（单元测试 + mock）
- dev 环境无 LiteLLM 启动 → Agent/Memory 正常工作（集成测试）
- 各 provider（OpenAI、Anthropic、Ollama、SiliconFlow）直连正常（回归测试）
- Admin UI provider 管理、全局配置、Agent 角色配置（端到端）

### Phase 2

- OAuth 登录 → token 存储 → 自动刷新（流程测试）
- Responses API adapter SSE 解析、消息转换、tool call（单元测试）
- ChatGPT 订阅 → Agent 执行任务含 tool use（端到端）
