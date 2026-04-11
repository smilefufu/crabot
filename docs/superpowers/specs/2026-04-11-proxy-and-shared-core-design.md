# 全局 HTTP 代理 + crabot-shared 共享包 设计文档

## 背景

Crabot 各模块需要访问外部服务（Telegram API、LLM API、GitHub 等），但 Node.js 内置 `fetch()` 不读取 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量。需要一个通用的代理能力，覆盖所有模块的外部 HTTP 请求。

同时，各模块各自维护 `src/core/`（base-protocol.ts、module-base.ts）的副本，同步维护成本高。借此机会抽取为共享包。

## 目标

1. 所有模块的外部 HTTP 请求统一支持代理
2. Admin UI 可配置代理模式（系统代理 / 自定义 / 不使用），热更新推送到所有模块
3. 抽取 `crabot-shared` 共享包，消除 `src/core/` 重复代码

## 非目标

- 不做 per-module 代理配置（全局统一）
- 不做 NO_PROXY 规则配置（依赖代理软件自身的分流规则）
- 不改变 Module Manager（crabot-core）的职责

---

## 设计

### 1. 数据模型

```typescript
interface ProxyConfig {
  mode: 'system' | 'custom' | 'none'
  custom_url?: string  // mode='custom' 时必填，如 http://127.0.0.1:7890
}
```

三种模式：
- `system`：读取 `HTTPS_PROXY` / `HTTP_PROXY` / `https_proxy` / `http_proxy` 环境变量（默认值）
- `custom`：使用 `custom_url` 指定的代理地址
- `none`：不使用代理

存储在 `global_model_config.json` 的 `proxy` 字段中，和全局模型配置复用同一文件。

### 2. crabot-shared 包

新建 `crabot-shared/` 目录，与其他模块同级：

```
crabot/
├── crabot-shared/         # 新建
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── base-protocol.ts    # 从现有 core/ 合并
│       ├── module-base.ts      # 从现有 core/ 合并
│       ├── proxy-manager.ts    # 新增
│       └── index.ts            # 统一导出
├── crabot-core/               # 保持不变，Module Manager
├── crabot-admin/
├── crabot-agent/
├── crabot-channel-telegram/
├── crabot-channel-wechat/
├── crabot-channel-host/
```

导出：

```typescript
// crabot-shared/src/index.ts
export { ModuleBase } from './module-base.js'
export { generateId, generateTimestamp } from './base-protocol.js'
export { ProxyManager, proxyManager } from './proxy-manager.js'
export type { ModuleId, SessionId, ProxyConfig } from './base-protocol.js'
```

各模块通过 `file:` 引用：

```json
{
  "dependencies": {
    "crabot-shared": "file:../crabot-shared"
  }
}
```

然后删除各模块的 `src/core/` 目录。

crabot-shared 的依赖：
- `https-proxy-agent`（runtime）
- `undici`（devDependencies，拿类型）
- `@types/node`（devDependencies）

### 3. ProxyManager 实现

核心类，每个 Node.js 进程一个单例。

```typescript
import { setGlobalDispatcher, ProxyAgent, Agent } from 'undici'
import { HttpsProxyAgent } from 'https-proxy-agent'

class ProxyManager {
  private proxyUrl: string | null = null

  updateConfig(config: ProxyConfig): void {
    this.proxyUrl = this.resolveProxyUrl(config)

    // 全局覆盖 fetch 的 dispatcher
    if (this.proxyUrl) {
      setGlobalDispatcher(new ProxyAgent(this.proxyUrl))
    } else {
      setGlobalDispatcher(new Agent())
    }
  }

  getHttpsAgent(): https.Agent | HttpsProxyAgent {
    if (this.proxyUrl) {
      return new HttpsProxyAgent(this.proxyUrl)
    }
    return new https.Agent()
  }

  private resolveProxyUrl(config: ProxyConfig): string | null {
    switch (config.mode) {
      case 'system':
        return process.env.HTTPS_PROXY || process.env.HTTP_PROXY ||
               process.env.https_proxy || process.env.http_proxy || null
      case 'custom':
        return config.custom_url || null
      case 'none':
        return null
    }
  }
}

export const proxyManager = new ProxyManager()
```

**覆盖范围：**

| HTTP 客户端 | 代理方式 | 需要代码改动 |
|-------------|---------|-------------|
| `fetch()` | `setGlobalDispatcher` 自动生效 | 无 |
| `http/https.request()` | `proxyManager.getHttpsAgent()` | wechat-client 传 agent 参数 |
| `@anthropic-ai/sdk` | `proxyManager.getHttpsAgent()` | Agent 模块构造 SDK 时传 httpAgent |

### 4. Admin 侧

**REST API：**

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/proxy-config` | GET | 获取代理配置 + 系统代理 URL |
| `/api/proxy-config` | PATCH | 更新代理配置 |

GET 响应：

```json
{
  "config": { "mode": "system" },
  "system_proxy_url": "http://127.0.0.1:7890"
}
```

**存储：** `ModelProviderManager` 新增 `getProxyConfig()` / `updateProxyConfig()`，读写 `global_model_config.json` 的 `proxy` 字段。

**推送流程：**

```
PATCH /api/proxy-config
  → modelProviderManager.updateProxyConfig(config)
    → 保存到 global_model_config.json
    → Admin 自身 proxyManager.updateConfig(config)
  → HTTP 200
  → 后台异步：pushProxyConfigToAllModules()
    → RPC update_proxy_config 推送给所有运行中的模块
```

**安全网：** 模块启动时（`module_manager.module_started` 事件），Admin 自动推送当前代理配置。

### 5. 模块侧

ModuleBase 内置代理支持：

```typescript
class ModuleBase {
  constructor() {
    // 启动默认 system 模式
    proxyManager.updateConfig({ mode: 'system' })

    // 注册 RPC handler
    this.registerMethod('update_proxy_config', (params) => {
      proxyManager.updateConfig(params.proxy)
      return { success: true }
    })
  }
}
```

生效时机：
1. 模块启动时：默认 `system` 模式，读环境变量
2. Admin 推送时：`update_proxy_config` RPC 热更新

Anthropic SDK 热更新：代理变更时需重建 SDK client 实例。Agent 模块已有 `update_config` 重建 adapter 的逻辑，代理变更走同样路径。

### 6. Admin UI

Settings 页面新增"网络代理"卡片：

```
┌─ 网络代理 ──────────────────────────────┐
│                                          │
│  代理模式：  ○ 系统代理（默认）            │
│              ○ 自定义代理                 │
│              ○ 不使用代理                 │
│                                          │
│  [mode=system] 当前系统代理：xxx          │
│  [mode=custom] 代理地址：[ input ]        │
│                                          │
│                          [ 保存 ]         │
└──────────────────────────────────────────┘
```

- `system` 模式显示从 API 返回的 `system_proxy_url`
- `custom` 模式显示输入框，校验 URL 格式（http:// 或 socks5://）
- 保存后 toast 提示

### 7. 构建与部署集成

crabot-shared 需要在所有消费方之前完成安装和编译。

**`scripts/onboard.sh`：** 依赖安装阶段加入 crabot-shared，排在最前。

**`scripts/lib.sh` — `sync_node_deps()`：** crabot-shared 排在安装列表最前。

**`scripts/lib.sh` — `build_all_modules()`：** crabot-shared 最先编译，其他模块可并行：

```bash
(cd crabot-shared && npm run build)
# 然后其他模块
(cd crabot-core && npm run build) &
(cd crabot-admin && npm run build) &
(cd crabot-agent && npm run build) &
...
wait
```

**`dev.sh` — `build_all()`：** 同样的顺序。

**不需要改的：** `./crabot` 脚本本身、Module Manager 启动逻辑、模块 spawn 逻辑。
