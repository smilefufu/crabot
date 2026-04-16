# 全局 HTTP 代理 + crabot-shared 共享包 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 抽取 crabot-shared 共享包消除 src/core/ 重复代码，并实现全局 HTTP 代理功能（Admin UI 配置 + 热更新推送）。

**Architecture:** 新建 crabot-shared 包，包含 base-protocol、module-base、proxy-manager 三个模块。ProxyManager 通过 undici `setGlobalDispatcher` 全局覆盖 fetch，同时提供 `getHttpsAgent()` 给 http.request 和 Anthropic SDK 使用。Admin 通过 REST API 管理代理配置，通过 RPC `update_proxy_config` 热推送到所有模块。

**Tech Stack:** TypeScript, undici (setGlobalDispatcher/ProxyAgent), https-proxy-agent, Node.js built-in http/https

---

## File Structure

### 新建文件

| 文件 | 职责 |
|------|------|
| `crabot-shared/package.json` | 包配置 |
| `crabot-shared/tsconfig.json` | TypeScript 配置 |
| `crabot-shared/src/index.ts` | 统一导出 |
| `crabot-shared/src/base-protocol.ts` | 基础协议类型和工具函数（合并自各模块 core/） |
| `crabot-shared/src/module-base.ts` | 模块基类 + RPC 客户端（超集版本，含 onRawRequest + tracing） |
| `crabot-shared/src/proxy-manager.ts` | ProxyManager 单例 |
| `crabot-admin/web/src/pages/Settings/ProxyConfigCard.tsx` | Admin UI 代理配置卡片 |
| `crabot-admin/web/src/services/proxy.ts` | 代理配置 API 客户端 |

### 修改文件

| 文件 | 改动说明 |
|------|---------|
| `crabot-admin/package.json` | 加 `crabot-shared` 依赖 |
| `crabot-agent/package.json` | 加 `crabot-shared` 依赖 |
| `crabot-channel-telegram/package.json` | 加 `crabot-shared` 依赖 |
| `crabot-channel-wechat/package.json` | 加 `crabot-shared` 依赖 |
| `crabot-channel-host/package.json` | 加 `crabot-shared` 依赖 |
| `crabot-core/package.json` | 加 `crabot-shared` 依赖 |
| 各模块所有 `from './core/...'` 的 import | 改为 `from 'crabot-shared'` |
| `crabot-admin/src/types.ts` | ProxyConfig 类型 + GlobalModelConfig 加 proxy 字段 |
| `crabot-admin/src/model-provider-manager.ts` | getProxyConfig / updateProxyConfig 方法 |
| `crabot-admin/src/index.ts` | REST API 端点 + pushProxyConfigToAllModules + 安全网推送 |
| `crabot-admin/web/src/pages/Settings/GlobalSettings.tsx` | 引入 ProxyConfigCard |
| `crabot-agent/src/engine/anthropic-adapter.ts` | createClient 传 httpAgent |
| `crabot-channel-wechat/src/wechat-client.ts` | transport.request 传 agent |
| `scripts/lib.sh` | sync_node_deps / build_all_modules 加 crabot-shared |
| `scripts/onboard.sh` | 依赖安装加 crabot-shared |
| `dev.sh` | build_all 加 crabot-shared |

### 删除文件

| 文件 | 原因 |
|------|------|
| `crabot-admin/src/core/base-protocol.ts` | 迁移到 crabot-shared |
| `crabot-admin/src/core/module-base.ts` | 迁移到 crabot-shared |
| `crabot-admin/src/core/base-protocol.test.ts` | 迁移测试到 crabot-shared |
| `crabot-admin/src/core/module-base.test.ts` | 迁移测试到 crabot-shared |
| `crabot-agent/src/core/base-protocol.ts` | 迁移到 crabot-shared |
| `crabot-agent/src/core/module-base.ts` | 迁移到 crabot-shared |
| `crabot-agent/src/core/index.ts` | 不再需要 |
| `crabot-channel-telegram/src/core/base-protocol.ts` | 迁移到 crabot-shared |
| `crabot-channel-telegram/src/core/module-base.ts` | 迁移到 crabot-shared |
| `crabot-channel-wechat/src/core/base-protocol.ts` | 迁移到 crabot-shared |
| `crabot-channel-wechat/src/core/module-base.ts` | 迁移到 crabot-shared |
| `crabot-channel-host/src/core/base-protocol.ts` | 迁移到 crabot-shared |
| `crabot-channel-host/src/core/module-base.ts` | 迁移到 crabot-shared |
| `crabot-core/src/core/base-protocol.ts` | 迁移到 crabot-shared |
| `crabot-core/src/core/module-base.ts` | 迁移到 crabot-shared |
| `crabot-core/src/core/base-protocol.test.ts` | 迁移测试到 crabot-shared |
| `crabot-core/src/core/module-base.test.ts` | 迁移测试到 crabot-shared |

**注意：** `crabot-agent/src/core/config-loader.ts` 和 `crabot-agent/src/core/trace-store.ts` 保留在 agent 内部，不迁移。它们是 agent-specific 的。

---

### Task 1: 创建 crabot-shared 包骨架

**Files:**
- Create: `crabot-shared/package.json`
- Create: `crabot-shared/tsconfig.json`
- Create: `crabot-shared/src/index.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "crabot-shared",
  "version": "0.1.0",
  "description": "Crabot shared infrastructure: base protocol, module base, proxy manager",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "node --import tsx --test src/**/*.test.ts"
  },
  "dependencies": {
    "https-proxy-agent": "^7.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "~5.8.0",
    "undici": "^7.0.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "dist"]
}
```

- [ ] **Step 3: 创建空的 index.ts（占位）**

```typescript
// crabot-shared/src/index.ts
// 各模块的统一导出将在后续 task 添加
export {}
```

- [ ] **Step 4: 安装依赖**

Run: `cd crabot-shared && npm install`
Expected: 成功安装，生成 node_modules 和 package-lock.json

- [ ] **Step 5: 验证编译**

Run: `cd crabot-shared && npm run build`
Expected: 成功编译，生成 dist/index.js 和 dist/index.d.ts

- [ ] **Step 6: Commit**

```bash
git add crabot-shared/
git commit -m "chore: create crabot-shared package skeleton"
```

---

### Task 2: 迁移 base-protocol.ts 到 crabot-shared

**Files:**
- Create: `crabot-shared/src/base-protocol.ts`
- Modify: `crabot-shared/src/index.ts`

需要合并所有模块版本的差异。关键差异：crabot-core 版本的 `ModuleDefinition` 多一个 `skip_health_check` 字段，这是正确的（用于 Vite 等非 Crabot 协议进程），共享版应该包含。

- [ ] **Step 1: 创建 base-protocol.ts**

从 `crabot-admin/src/core/base-protocol.ts`（376 行）复制为基础，然后在 `ModuleDefinition` 接口中加入 crabot-core 版本的 `skip_health_check` 字段。

最终文件内容：与 `crabot-admin/src/core/base-protocol.ts` 完全一致，仅在 `ModuleDefinition` 接口（line 223-236）加一行：

```typescript
export interface ModuleDefinition {
  module_id: ModuleId
  module_type: string
  /** 启动命令 */
  entry: string
  /** 模块工作目录 */
  cwd?: string
  /** 环境变量 */
  env?: Record<string, string>
  /** 是否随 Module Manager 启动时自动启动，默认 true */
  auto_start: boolean
  /** 启动顺序优先级，数字越小越先启动，默认 100 */
  start_priority: number
  /** 跳过健康检查和注册（用于不实现 Crabot 协议的工具进程，如 Vite） */
  skip_health_check?: boolean
}
```

其余内容不变。

- [ ] **Step 2: 同时加入 ProxyConfig 类型（供 proxy-manager 和 Admin 使用）**

在 base-protocol.ts 末尾工具函数之前，加入：

```typescript
// ============================================================================
// 代理配置
// ============================================================================

export interface ProxyConfig {
  mode: 'system' | 'custom' | 'none'
  custom_url?: string
}
```

- [ ] **Step 3: 更新 index.ts 导出**

```typescript
// crabot-shared/src/index.ts
export {
  // Types
  type ModuleId,
  type FriendId,
  type SessionId,
  type TaskId,
  type MemoryId,
  type ScheduleId,
  type ModuleStatus,
  type HealthStatus,
  type Request,
  type Response,
  type AcceptedResponse,
  type CallbackPayload,
  type ErrorDetail,
  type Event,
  type SubscribeParams,
  type PublishEventParams,
  type ResolveParams,
  type ResolvedModule,
  type ResolveResult,
  type HealthResult,
  type ModuleDefinition,
  type ModuleInfo,
  type RegisterParams,
  type PaginationParams,
  type PaginatedResult,
  type ProxyConfig,
  // Constants
  GlobalErrorCode,
  // Functions
  generateId,
  generateTimestamp,
  createSuccessResponse,
  createErrorResponse,
  createAcceptedResponse,
  createEvent,
} from './base-protocol.js'
```

- [ ] **Step 4: 验证编译**

Run: `cd crabot-shared && npm run build`
Expected: 成功

- [ ] **Step 5: Commit**

```bash
git add crabot-shared/src/
git commit -m "feat(shared): add base-protocol with ProxyConfig type"
```

---

### Task 3: 迁移 module-base.ts 到 crabot-shared（超集版本）

**Files:**
- Create: `crabot-shared/src/module-base.ts`
- Modify: `crabot-shared/src/index.ts`

需要创建一个"超集"版本，包含所有模块的特性：
1. `onRawRequest` hook（来自 channel-telegram/wechat/host 版本）
2. `RpcTraceContext` + tracing support in `RpcClient.call()`（来自 agent 版本）
3. 完整的 RpcClient 方法集（registerModuleDefinition、startModule、stopModule、unregisterModuleDefinition）

tracing 依赖 TraceStore，但 TraceStore 是 agent-only 的。解决方式：`RpcTraceContext` 使用泛型接口而不是直接 import TraceStore。

- [ ] **Step 1: 创建 module-base.ts**

从 `crabot-channel-telegram/src/core/module-base.ts`（599 行，含 onRawRequest）为基础，加入 agent 版本的 tracing 功能。

关键修改：

1. 在文件顶部加入 trace 相关类型定义（不 import TraceStore，用接口抽象）：

```typescript
/**
 * Trace span 结构（与 TraceStore.startSpan 返回值对齐）
 */
interface TraceSpan {
  span_id: string
}

/**
 * Trace store 接口（与 crabot-agent 的 TraceStore 对齐，但不直接依赖）
 */
export interface TraceStoreInterface {
  startSpan(traceId: string, opts: {
    type: string
    parent_span_id?: string
    details?: Record<string, unknown>
  }): TraceSpan
  endSpan(traceId: string, spanId: string, status: string, details?: Record<string, unknown>): void
}

/**
 * Trace 上下文 - 传给 RpcClient.call() 以自动记录 rpc_call span
 */
export interface RpcTraceContext {
  traceStore: TraceStoreInterface
  traceId: string
  parentSpanId?: string
}
```

2. `RpcClient.call()` 方法签名加入可选的 `traceCtx` 参数（来自 agent 版本）：

```typescript
async call<P, R>(
  targetPort: number,
  method: string,
  params: P,
  source: ModuleId,
  traceCtx?: RpcTraceContext
): Promise<R> {
```

3. call 方法体中加入 span 创建和结束逻辑（和 agent 版本一致），所有 tracing 代码都在 `if (traceCtx)` 分支内，不影响不使用 tracing 的模块。

4. 保留 `onRawRequest` hook 和完整的 RpcClient 方法集（registerModuleDefinition 等）。

5. ModuleBase 构造函数中加入 `update_proxy_config` RPC handler：

```typescript
constructor(config: ModuleConfig) {
  this.config = config
  this.rpcClient = new RpcClient()

  // 启动时默认使用系统代理
  proxyManager.updateConfig({ mode: 'system' })

  // 注册必需端点
  this.registerMethod('health', this.handleHealth.bind(this))
  this.registerMethod('shutdown', this.handleShutdown.bind(this))
  this.registerMethod('on_event', this.handleOnEvent.bind(this))
  this.registerMethod('callback', this.handleCallback.bind(this))

  // 代理配置热更新
  this.registerMethod('update_proxy_config', this.handleUpdateProxyConfig.bind(this))
}
```

6. 加入 handleUpdateProxyConfig 处理器：

```typescript
private handleUpdateProxyConfig(params: { proxy: ProxyConfig }): { success: true } {
  proxyManager.updateConfig(params.proxy)
  console.log(`[${this.config.moduleId}] Proxy config updated: mode=${params.proxy.mode}`)
  return { success: true }
}
```

7. 顶部 import 加入 proxy-manager：

```typescript
import { proxyManager } from './proxy-manager.js'
import type { ProxyConfig } from './base-protocol.js'
```

- [ ] **Step 2: 更新 index.ts 导出**

在 index.ts 中追加：

```typescript
export {
  ModuleBase,
  RpcClient,
  type ModuleConfig,
  type ModuleMetadata,
  type RpcTraceContext,
  type TraceStoreInterface,
} from './module-base.js'
```

- [ ] **Step 3: 验证编译**

Run: `cd crabot-shared && npm run build`
Expected: 成功（proxy-manager.ts 尚不存在会报错，先创建占位）

注意：如果 proxy-manager.ts 还没创建，先创建一个空占位：

```typescript
// crabot-shared/src/proxy-manager.ts（临时占位）
import type { ProxyConfig } from './base-protocol.js'

class ProxyManager {
  updateConfig(_config: ProxyConfig): void {}
}

export const proxyManager = new ProxyManager()
```

- [ ] **Step 4: Commit**

```bash
git add crabot-shared/src/
git commit -m "feat(shared): add module-base with tracing, onRawRequest, and proxy hooks"
```

---

### Task 4: 实现 ProxyManager

**Files:**
- Create: `crabot-shared/src/proxy-manager.ts`（替换占位）

- [ ] **Step 1: 实现 ProxyManager**

```typescript
/**
 * ProxyManager - 全局 HTTP 代理管理
 *
 * 通过 undici setGlobalDispatcher 覆盖 Node.js 全局 fetch 的代理行为，
 * 同时提供 getHttpsAgent() 供 http.request() 和第三方 SDK 使用。
 */

import https from 'node:https'
import { setGlobalDispatcher, ProxyAgent, Agent } from 'undici'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type { ProxyConfig } from './base-protocol.js'

export class ProxyManager {
  private proxyUrl: string | null = null
  private config: ProxyConfig = { mode: 'system' }

  /**
   * 更新代理配置。
   * 立即生效：全局 fetch dispatcher 和 getHttpsAgent() 都会使用新配置。
   */
  updateConfig(config: ProxyConfig): void {
    this.config = config
    this.proxyUrl = this.resolveProxyUrl(config)

    if (this.proxyUrl) {
      setGlobalDispatcher(new ProxyAgent(this.proxyUrl))
    } else {
      setGlobalDispatcher(new Agent())
    }
  }

  /**
   * 获取当前代理 URL（用于日志/诊断）
   */
  getProxyUrl(): string | null {
    return this.proxyUrl
  }

  /**
   * 获取当前配置
   */
  getConfig(): ProxyConfig {
    return this.config
  }

  /**
   * 获取 HTTPS Agent，供 http.request() 和第三方 SDK（如 @anthropic-ai/sdk）使用。
   * 每次调用返回新实例，确保使用最新的代理配置。
   */
  getHttpsAgent(): https.Agent | InstanceType<typeof HttpsProxyAgent> {
    if (this.proxyUrl) {
      return new HttpsProxyAgent(this.proxyUrl)
    }
    return new https.Agent()
  }

  /**
   * 解析代理 URL
   */
  private resolveProxyUrl(config: ProxyConfig): string | null {
    switch (config.mode) {
      case 'system':
        return process.env.HTTPS_PROXY
          || process.env.HTTP_PROXY
          || process.env.https_proxy
          || process.env.http_proxy
          || null
      case 'custom':
        return config.custom_url || null
      case 'none':
        return null
    }
  }
}

/** 进程级单例 */
export const proxyManager = new ProxyManager()
```

- [ ] **Step 2: 更新 index.ts 导出**

追加：

```typescript
export { ProxyManager, proxyManager } from './proxy-manager.js'
```

- [ ] **Step 3: 验证编译**

Run: `cd crabot-shared && npm run build`
Expected: 成功

- [ ] **Step 4: Commit**

```bash
git add crabot-shared/src/
git commit -m "feat(shared): implement ProxyManager with undici global dispatcher"
```

---

### Task 5: 迁移各模块 — 添加 crabot-shared 依赖 + 更新 import

**Files:**
- Modify: 6 个模块的 `package.json`
- Modify: 所有 `from './core/...'` import 语句
- Delete: 各模块的 `src/core/base-protocol.ts` 和 `src/core/module-base.ts`

这是改动量最大的 task。按模块逐个处理。

- [ ] **Step 1: 为所有模块添加 crabot-shared 依赖**

在以下 6 个模块的 package.json 的 `dependencies` 中添加：

```json
"crabot-shared": "file:../crabot-shared"
```

模块列表：
- `crabot-core/package.json`
- `crabot-admin/package.json`
- `crabot-agent/package.json`
- `crabot-channel-telegram/package.json`
- `crabot-channel-wechat/package.json`
- `crabot-channel-host/package.json`

然后在每个模块中运行 `npm install` 创建 symlink。

- [ ] **Step 2: 迁移 crabot-admin 的 import**

将以下文件中的 `from './core/base-protocol.js'` 改为 `from 'crabot-shared'`，`from './core/module-base.js'` 改为 `from 'crabot-shared'`：

| 文件 | 原 import | 新 import |
|------|-----------|-----------|
| `src/types.ts:7` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/index.ts:14` | `from './core/module-base.js'` | `from 'crabot-shared'` |
| `src/index.ts:23` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/agent-manager.ts:9` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/agent-manager.ts:10` | `from './core/module-base.js'` | `from 'crabot-shared'` |
| `src/model-provider-manager.ts:10` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/permission-template-manager.ts:15` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/chat-manager.ts:10` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/chat-manager.ts:11` | `from './core/module-base.js'` | `from 'crabot-shared'` |
| `src/channel-manager.ts:10` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/channel-manager.ts:11` | `from './core/module-base.js'` | `from 'crabot-shared'` |
| `src/module-installer.ts:10` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/mcp-skill-manager.ts:10` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/agent-manager.test.ts:9` | `from './core/module-base.js'` | `from 'crabot-shared'` |

然后删除 `crabot-admin/src/core/base-protocol.ts`、`crabot-admin/src/core/module-base.ts`、`crabot-admin/src/core/base-protocol.test.ts`、`crabot-admin/src/core/module-base.test.ts`。

如果 `src/core/` 目录为空则删除整个目录。

- [ ] **Step 3: 迁移 crabot-agent 的 import**

将以下文件中的 import 改为 `from 'crabot-shared'`：

| 文件 | 原 import | 新 import |
|------|-----------|-----------|
| `src/types.ts:16` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/unified-agent.ts:10` | `from './core/module-base.js'` | `from 'crabot-shared'` |
| `src/unified-agent.ts:11` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/main.ts:6` | `from './core/index.js'` | 拆为两行：`import { RpcClient } from 'crabot-shared'` 和 `import { ConfigLoader } from './core/config-loader.js'` |
| `src/orchestration/decision-dispatcher.ts:7` | `from '../core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/orchestration/decision-dispatcher.ts:8` | `from '../core/module-base.js'` | `from 'crabot-shared'` |
| `src/orchestration/context-assembler.ts:10` | `from '../core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/orchestration/context-assembler.ts:11` | `from '../core/module-base.js'` | `from 'crabot-shared'` |
| `src/orchestration/worker-selector.ts:7` | `from '../core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/orchestration/worker-selector.ts:8` | `from '../core/module-base.js'` | `from 'crabot-shared'` |
| `src/orchestration/switchmap-handler.ts:12` | `from '../core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/orchestration/switchmap-handler.ts:13` | `from '../core/module-base.js'` | `from 'crabot-shared'` |
| `src/orchestration/attention-scheduler.ts:15` | `from '../core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/orchestration/session-manager.ts:5` | `from '../core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/orchestration/permission-checker.ts:8` | `from '../core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/orchestration/permission-checker.ts:9` | `from '../core/module-base.js'` | `from 'crabot-shared'` |
| `src/orchestration/memory-writer.ts:10` | `from '../core/module-base.js'` | `from 'crabot-shared'` |
| `src/agent/tool-executor.ts:9` | `from '../core/module-base.js'` | `from 'crabot-shared'` |
| `src/agent/worker-handler.ts:41` | `from '../core/module-base.js'` | `from 'crabot-shared'` |
| `src/mcp/crab-messaging.ts:12` | `from '../core/module-base.js'` | `from 'crabot-shared'` |
| `src/mcp/crab-memory.ts:13` | `from '../core/module-base.js'` | `from 'crabot-shared'` |

**注意：** `src/unified-agent.ts:54` 中的 `import { TraceStore } from './core/trace-store.js'` 保持不变（TraceStore 留在 agent 内部）。

然后删除 `crabot-agent/src/core/base-protocol.ts`、`crabot-agent/src/core/module-base.ts`、`crabot-agent/src/core/index.ts`。

`crabot-agent/src/core/` 目录保留（还有 config-loader.ts、trace-store.ts、.gitkeep）。

**agent 的 TraceStore 需要实现 TraceStoreInterface：** 在 `crabot-agent/src/core/trace-store.ts` 中确认其 `startSpan` 和 `endSpan` 方法签名与 `TraceStoreInterface` 兼容。如果不兼容，添加 `implements TraceStoreInterface`（从 crabot-shared import）。

**agent 的 RpcTraceContext 引用需要改：** `decision-dispatcher.ts` 中 `import type { RpcTraceContext } from '../core/module-base.js'` 改为 `from 'crabot-shared'`（已在上表中列出）。

- [ ] **Step 4: 迁移 crabot-channel-telegram 的 import**

| 文件 | 原 import | 新 import |
|------|-----------|-----------|
| `src/types.ts:10` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/telegram-channel.ts` | `from './core/module-base.js'` 和 `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/session-manager.ts:10` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |

删除 `crabot-channel-telegram/src/core/` 整个目录。

- [ ] **Step 5: 迁移 crabot-channel-wechat 的 import**

| 文件 | 原 import | 新 import |
|------|-----------|-----------|
| `src/types.ts:10` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/wechat-channel.ts:13` | `from './core/module-base.js'` | `from 'crabot-shared'` |
| `src/wechat-channel.ts:14` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/session-manager.ts:10` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |

删除 `crabot-channel-wechat/src/core/` 整个目录。

- [ ] **Step 6: 迁移 crabot-channel-host 的 import**

| 文件 | 原 import | 新 import |
|------|-----------|-----------|
| `src/types.ts:12` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |
| `src/channel-host.ts:10` | `from './core/module-base.js'` | `from 'crabot-shared'` |
| `src/channel-host.ts:11` | `from './core/base-protocol.js'` | `from 'crabot-shared'` |

删除 `crabot-channel-host/src/core/` 整个目录。

- [ ] **Step 7: 迁移 crabot-core 的 import**

crabot-core（Module Manager）也使用 `src/core/`。需要将其 import 也改为 `from 'crabot-shared'`。

先搜索 crabot-core/src 中的 `from './core/` 和 `from '../core/` import 并逐一替换。

删除 `crabot-core/src/core/base-protocol.ts`、`crabot-core/src/core/module-base.ts` 和测试文件。

**注意：** crabot-core 的 module-base.ts 是最简版本（没有 onRawRequest、没有 registerModuleDefinition 等方法）。切换到 crabot-shared 的超集版本后功能只多不少，不会有兼容问题。

- [ ] **Step 8: 全量编译验证**

Run:
```bash
cd crabot-shared && npm run build && cd ..
cd crabot-core && npm run build && cd ..
cd crabot-admin && npx tsc --noEmit && cd ..
cd crabot-agent && npm run build && cd ..
cd crabot-channel-telegram && npm run build && cd ..
cd crabot-channel-wechat && npm run build && cd ..
cd crabot-channel-host && npm run build && cd ..
```

Expected: 全部编译通过

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: migrate all modules from src/core/ to crabot-shared"
```

---

### Task 6: 更新构建脚本

**Files:**
- Modify: `scripts/lib.sh`
- Modify: `scripts/onboard.sh`
- Modify: `dev.sh`

- [ ] **Step 1: 修改 scripts/lib.sh — sync_node_deps()**

在 `sync_node_deps()` 函数（line 134-156）的 for 循环中，将 `crabot-shared` 加在列表最前面：

```bash
for mod in crabot-shared crabot-core crabot-admin crabot-agent crabot-channel-host crabot-channel-wechat; do
```

- [ ] **Step 2: 修改 scripts/lib.sh — build_all_modules()**

在 `build_all_modules()` 函数（line 184-213）中，将 `crabot-shared` 加在列表最前面。由于 crabot-shared 必须先于其他模块编译，改为先单独编译 shared，再编译其余：

```bash
build_all_modules() {
  log_info "构建 TypeScript 模块..."

  # crabot-shared 必须先编译（其他模块依赖它）
  if [ -d "$CRABOT_HOME/crabot-shared" ]; then
    log_dim "  crabot-shared"
    local build_log
    build_log="$(cd "$CRABOT_HOME/crabot-shared" && npm run build 2>&1)" || {
      echo "$build_log" | sed 's/^/    /'
      log_error "crabot-shared 构建失败"
      return 1
    }
  fi

  local fail=0
  for mod in crabot-core crabot-admin crabot-agent crabot-channel-host crabot-channel-wechat; do
    if [ ! -d "$CRABOT_HOME/$mod" ]; then
      continue
    fi
    log_dim "  $mod"
    local build_log
    build_log="$(cd "$CRABOT_HOME/$mod" && npm run build 2>&1)" || {
      echo "$build_log" | sed 's/^/    /'
      log_error "$mod 构建失败"
      fail=1
    }
  done

  if [ "$fail" -eq 1 ]; then
    return 1
  fi

  # node-pty 的 spawn-helper 在 macOS 上需要可执行权限
  local spawn_helper="$CRABOT_HOME/crabot-admin/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
  if [ -f "$spawn_helper" ] && [ ! -x "$spawn_helper" ]; then
    chmod +x "$spawn_helper"
    log_info "已修复 node-pty spawn-helper 权限"
  fi

  log_info "TypeScript 构建完成"
}
```

- [ ] **Step 3: 修改 dev.sh — build_all()**

在 `build_all()` 函数（line 63-95）中同样加入 crabot-shared 先编译：

```bash
build_all() {
  log_info "构建 TypeScript 模块..."

  # crabot-shared 必须先编译
  if [ -d "$SCRIPT_DIR/crabot-shared" ]; then
    log_dim "  crabot-shared"
    (cd "$SCRIPT_DIR/crabot-shared" && npm run build 2>&1 | sed 's/^/    /') || {
      log_error "crabot-shared 构建失败"
      exit 1
    }
  fi

  local fail=0
  for mod in crabot-core crabot-admin crabot-agent crabot-channel-host crabot-channel-wechat; do
    # ... 原有逻辑不变 ...
```

- [ ] **Step 4: 修改 scripts/onboard.sh**

在并行安装依赖的部分（line 347-395），将 `crabot-shared` 加入并行安装列表：

```bash
for mod in crabot-shared crabot-core crabot-agent crabot-channel-host; do
```

- [ ] **Step 5: 验证 dev.sh build**

Run: `./dev.sh build`
Expected: crabot-shared 先编译，然后其他模块编译通过

- [ ] **Step 6: Commit**

```bash
git add scripts/lib.sh scripts/onboard.sh dev.sh
git commit -m "chore: add crabot-shared to build and install scripts"
```

---

### Task 7: Admin 后端 — 代理配置 API + 推送

**Files:**
- Modify: `crabot-admin/src/types.ts`
- Modify: `crabot-admin/src/model-provider-manager.ts`
- Modify: `crabot-admin/src/index.ts`

- [ ] **Step 1: 在 types.ts 中扩展 GlobalModelConfig**

在 `GlobalModelConfig` 接口（`crabot-admin/src/types.ts:896-901`）中加入 proxy 字段：

```typescript
export interface GlobalModelConfig {
  default_llm_provider_id?: string
  default_llm_model_id?: string
  default_embedding_provider_id?: string
  default_embedding_model_id?: string
  proxy?: ProxyConfig
}
```

并在文件顶部加入 import：

```typescript
import type { ProxyConfig } from 'crabot-shared'
```

同时 re-export：

```typescript
export type { ProxyConfig }
```

- [ ] **Step 2: 在 ModelProviderManager 中添加代理配置方法**

在 `crabot-admin/src/model-provider-manager.ts` 中添加两个方法：

```typescript
/**
 * 获取代理配置
 */
getProxyConfig(): ProxyConfig {
  return this.globalConfig.proxy ?? { mode: 'system' }
}

/**
 * 更新代理配置
 */
async updateProxyConfig(proxy: ProxyConfig): Promise<void> {
  this.globalConfig = { ...this.globalConfig, proxy }
  await this.saveGlobalConfig()
}
```

同时修改 `loadData()` 方法（line 733-742），在加载 globalConfig 时包含 proxy 字段：

```typescript
this.globalConfig = {
  default_llm_provider_id: raw.default_llm_provider_id,
  default_llm_model_id: raw.default_llm_model_id,
  default_embedding_provider_id: raw.default_embedding_provider_id,
  default_embedding_model_id: raw.default_embedding_model_id,
  proxy: raw.proxy,
}
```

- [ ] **Step 3: 在 Admin index.ts 中添加 REST API 端点**

在 `crabot-admin/src/index.ts` 的路由注册区域（搜索 `'/api/model-config/global'` 附近），添加两个新端点：

```typescript
// GET /api/proxy-config
if (pathname === '/api/proxy-config' && method === 'GET') {
  this.requireAuth(req, res)
  const config = this.modelProviderManager.getProxyConfig()
  const systemProxyUrl = process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || process.env.https_proxy
    || process.env.http_proxy
    || null
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ config, system_proxy_url: systemProxyUrl }))
  return true
}

// PATCH /api/proxy-config
if (pathname === '/api/proxy-config' && method === 'PATCH') {
  this.requireAuth(req, res)
  const body = await this.readRequestBody(req)
  const { mode, custom_url } = JSON.parse(body) as ProxyConfig
  const proxyConfig: ProxyConfig = { mode, custom_url }

  await this.modelProviderManager.updateProxyConfig(proxyConfig)

  // Admin 自身也应用代理配置
  proxyManager.updateConfig(proxyConfig)

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ config: proxyConfig }))

  // 后台推送到所有模块
  this.pushProxyConfigToAllModules(proxyConfig).catch((err: Error) => {
    console.warn('[Admin] pushProxyConfigToAllModules failed:', err.message)
  })
  return true
}
```

需要在文件顶部加入 import：

```typescript
import { proxyManager, type ProxyConfig } from 'crabot-shared'
```

- [ ] **Step 4: 实现 pushProxyConfigToAllModules**

在 Admin 类中添加：

```typescript
/**
 * 推送代理配置到所有运行中的模块
 */
private async pushProxyConfigToAllModules(proxyConfig?: ProxyConfig): Promise<void> {
  const config = proxyConfig ?? this.modelProviderManager.getProxyConfig()
  const params = { proxy: config }

  // 获取所有运行中的模块
  const modules = await this.rpcClient.resolve({ module_type: undefined }, this.config.moduleId)

  const pushPromises = modules
    .filter(m => m.module_id !== this.config.moduleId) // 排除 Admin 自身
    .map(m =>
      this.rpcClient.call(m.port, 'update_proxy_config', params, this.config.moduleId)
        .catch((err: Error) => {
          console.warn(`[Admin] Failed to push proxy config to ${m.module_id}:`, err.message)
        })
    )

  await Promise.allSettled(pushPromises)
}
```

- [ ] **Step 5: 在模块启动安全网中推送代理配置**

在 `onEvent` 方法中的 `module_manager.module_started` 处理（`index.ts` line 496-513），添加代理配置推送：

在现有的 memory 和 agent push 之后添加：

```typescript
// 所有模块启动时都推送代理配置
console.log(`[Admin] Module ${module_id} started, pushing proxy config...`)
this.pushProxyConfigToAllModules().catch((err: Error) => {
  console.warn(`[Admin] Failed to push proxy config to ${module_id}:`, err.message)
})
```

- [ ] **Step 6: Admin 启动时自身应用代理配置**

在 Admin 的 `onStart()` 方法中（搜索 `onStart` 或 `start` 方法），在加载数据后应用代理配置：

```typescript
// 启动时应用存储的代理配置（覆盖默认的 system 模式）
const proxyConfig = this.modelProviderManager.getProxyConfig()
proxyManager.updateConfig(proxyConfig)
console.log(`[Admin] Proxy config loaded: mode=${proxyConfig.mode}`)
```

- [ ] **Step 7: 验证编译**

Run: `cd crabot-admin && npx tsc --noEmit`
Expected: 编译通过

- [ ] **Step 8: Commit**

```bash
git add crabot-admin/src/
git commit -m "feat(admin): add proxy config REST API and push mechanism"
```

---

### Task 8: Admin UI — 代理配置卡片

**Files:**
- Create: `crabot-admin/web/src/services/proxy.ts`
- Create: `crabot-admin/web/src/pages/Settings/ProxyConfigCard.tsx`
- Modify: `crabot-admin/web/src/pages/Settings/GlobalSettings.tsx`

- [ ] **Step 1: 创建 proxy service**

```typescript
// crabot-admin/web/src/services/proxy.ts
import { api } from './api'

export interface ProxyConfig {
  mode: 'system' | 'custom' | 'none'
  custom_url?: string
}

export interface ProxyConfigResponse {
  config: ProxyConfig
  system_proxy_url: string | null
}

export const proxyService = {
  async getConfig(): Promise<ProxyConfigResponse> {
    return api.get<ProxyConfigResponse>('/proxy-config')
  },

  async updateConfig(config: ProxyConfig): Promise<ProxyConfig> {
    const res = await api.patch<{ config: ProxyConfig }>('/proxy-config', config)
    return res.config
  },
}
```

- [ ] **Step 2: 创建 ProxyConfigCard 组件**

```tsx
// crabot-admin/web/src/pages/Settings/ProxyConfigCard.tsx
import React, { useState, useEffect } from 'react'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { useToast } from '../../contexts/ToastContext'
import { proxyService, type ProxyConfig } from '../../services/proxy'

export const ProxyConfigCard: React.FC = () => {
  const [mode, setMode] = useState<ProxyConfig['mode']>('system')
  const [customUrl, setCustomUrl] = useState('')
  const [systemProxyUrl, setSystemProxyUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  useEffect(() => {
    proxyService.getConfig()
      .then(({ config, system_proxy_url }) => {
        setMode(config.mode)
        setCustomUrl(config.custom_url ?? '')
        setSystemProxyUrl(system_proxy_url)
      })
      .catch(() => {
        toast.error('加载代理配置失败')
      })
      .finally(() => setLoading(false))
  }, [toast])

  const handleSave = () => {
    if (mode === 'custom' && !customUrl.trim()) {
      toast.error('请输入代理地址')
      return
    }
    if (mode === 'custom' && !/^(https?|socks5):\/\/.+/.test(customUrl.trim())) {
      toast.error('代理地址格式不正确，需要以 http://, https:// 或 socks5:// 开头')
      return
    }

    setSaving(true)
    const config: ProxyConfig = {
      mode,
      ...(mode === 'custom' ? { custom_url: customUrl.trim() } : {}),
    }

    proxyService.updateConfig(config)
      .then(() => {
        toast.success('代理配置已更新并推送至所有模块')
      })
      .catch(() => {
        toast.error('更新代理配置失败')
      })
      .finally(() => setSaving(false))
  }

  if (loading) {
    return (
      <Card title="网络代理">
        <p style={{ color: 'var(--text-secondary)' }}>加载中...</p>
      </Card>
    )
  }

  return (
    <Card title="网络代理">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Radio: system */}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
          <input
            type="radio"
            name="proxy_mode"
            value="system"
            checked={mode === 'system'}
            onChange={() => setMode('system')}
            style={{ marginTop: '0.2rem' }}
          />
          <div>
            <div style={{ fontWeight: 500 }}>系统代理</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              读取环境变量 HTTPS_PROXY / HTTP_PROXY
            </div>
          </div>
        </label>

        {mode === 'system' && (
          <div style={{
            marginLeft: '1.5rem',
            padding: '0.5rem 0.75rem',
            backgroundColor: 'var(--bg-secondary, #f8f9fa)',
            borderRadius: '4px',
            fontSize: '0.85rem',
            color: 'var(--text-secondary)',
          }}>
            {systemProxyUrl
              ? <>当前系统代理：<code>{systemProxyUrl}</code></>
              : '未检测到系统代理环境变量'}
          </div>
        )}

        {/* Radio: custom */}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
          <input
            type="radio"
            name="proxy_mode"
            value="custom"
            checked={mode === 'custom'}
            onChange={() => setMode('custom')}
            style={{ marginTop: '0.2rem' }}
          />
          <div>
            <div style={{ fontWeight: 500 }}>自定义代理</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              指定代理服务器地址
            </div>
          </div>
        </label>

        {mode === 'custom' && (
          <div style={{ marginLeft: '1.5rem' }}>
            <input
              type="text"
              value={customUrl}
              onChange={e => setCustomUrl(e.target.value)}
              placeholder="http://127.0.0.1:7890"
              style={{
                width: '100%',
                maxWidth: '400px',
                padding: '0.5rem 0.75rem',
                border: '1px solid var(--border-color, #dee2e6)',
                borderRadius: '4px',
                fontSize: '0.9rem',
              }}
            />
          </div>
        )}

        {/* Radio: none */}
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer' }}>
          <input
            type="radio"
            name="proxy_mode"
            value="none"
            checked={mode === 'none'}
            onChange={() => setMode('none')}
            style={{ marginTop: '0.2rem' }}
          />
          <div>
            <div style={{ fontWeight: 500 }}>不使用代理</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              直接连接
            </div>
          </div>
        </label>

        {/* Save button */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>
    </Card>
  )
}
```

- [ ] **Step 3: 在 GlobalSettings 中引入 ProxyConfigCard**

在 `crabot-admin/web/src/pages/Settings/GlobalSettings.tsx` 中：

1. 顶部 import：
```typescript
import { ProxyConfigCard } from './ProxyConfigCard'
```

2. 在浏览器管理 Card 之后（`</div>` 闭合标签前）添加：
```tsx
<div style={{ marginTop: '1.5rem' }}>
  <ProxyConfigCard />
</div>
```

- [ ] **Step 4: 验证前端编译**

Run: `cd crabot-admin/web && npx tsc --noEmit`
Expected: 编译通过

- [ ] **Step 5: Commit**

```bash
git add crabot-admin/web/src/
git commit -m "feat(admin-ui): add proxy config card to global settings"
```

---

### Task 9: Agent 模块适配 — Anthropic SDK httpAgent

**Files:**
- Modify: `crabot-agent/src/engine/anthropic-adapter.ts`

- [ ] **Step 1: 修改 createClient 传入 httpAgent**

在 `crabot-agent/src/engine/anthropic-adapter.ts` 的 `createClient` 方法（line 109-113）中：

1. 顶部加入 import：
```typescript
import { proxyManager } from 'crabot-shared'
```

2. 修改 `createClient`：

```typescript
private createClient(config: LLMAdapterConfig): Anthropic {
  return new Anthropic({
    baseURL: config.endpoint,
    apiKey: config.apikey,
    httpAgent: proxyManager.getHttpsAgent(),
  })
}
```

**注意：** Anthropic SDK 的 `httpAgent` 选项是在构造时固定的。当代理配置热更新时，Agent 模块已有的 `update_config` RPC 会重建 adapter，此时会调用新的 `createClient`，自然拿到最新的 agent。

- [ ] **Step 2: 验证编译**

Run: `cd crabot-agent && npm run build`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add crabot-agent/src/engine/anthropic-adapter.ts
git commit -m "feat(agent): pass proxy httpAgent to Anthropic SDK"
```

---

### Task 10: WeChat 模块适配 — http.request agent

**Files:**
- Modify: `crabot-channel-wechat/src/wechat-client.ts`

- [ ] **Step 1: 修改 transport.request 传入 agent**

在 `crabot-channel-wechat/src/wechat-client.ts` 中：

1. 顶部加入 import：
```typescript
import { proxyManager } from 'crabot-shared'
```

2. 找到所有 `transport.request(` 调用（约 2 处，multipart 和 JSON 请求方法），在 request options 中加入 `agent`：

```typescript
const req = transport.request(
  {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: httpMethod,
    headers,
    agent: isHttps ? proxyManager.getHttpsAgent() : undefined,
  },
  // ...
)
```

**注意：** 仅 HTTPS 请求需要传 agent。如果 wechat-connector 是 HTTP（localhost），agent 为 undefined 即可（不走代理的本地连接）。实际上 ProxyManager 的全局 fetch dispatcher 已覆盖 fetch 调用，但 wechat-client 用的是 `http.request`，需要显式传 agent。

如果 wechat-connector 通常是本地 HTTP，那么 `isHttps` 为 false 时不传 agent，对性能无影响。

- [ ] **Step 2: 验证编译**

Run: `cd crabot-channel-wechat && npm run build`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add crabot-channel-wechat/src/wechat-client.ts
git commit -m "feat(wechat): pass proxy agent to http.request calls"
```

---

### Task 11: 端到端验证

**Files:** 无文件改动，纯测试

- [ ] **Step 1: 全量编译**

Run:
```bash
cd crabot-shared && npm run build && cd ..
cd crabot-core && npm run build && cd ..
cd crabot-admin && npx tsc --noEmit && cd ..
cd crabot-agent && npm run build && cd ..
cd crabot-channel-telegram && npm run build && cd ..
cd crabot-channel-wechat && npm run build && cd ..
cd crabot-channel-host && npm run build && cd ..
```

Expected: 全部通过

- [ ] **Step 2: dev.sh 构建验证**

Run: `./dev.sh build`
Expected: crabot-shared 先编译，然后其他模块编译通过

- [ ] **Step 3: 启动验证**

Run: `./dev.sh`

Expected:
- Module Manager 启动
- Admin 启动并加载代理配置（日志中应看到 `[Admin] Proxy config loaded: mode=system`）
- Agent 启动后收到代理配置推送（日志中应看到 `Proxy config updated: mode=system`）

- [ ] **Step 4: API 验证**

```bash
# 获取代理配置
curl -s http://localhost:3000/api/proxy-config -H "Authorization: Bearer <token>" | jq

# 更新为自定义代理
curl -s -X PATCH http://localhost:3000/api/proxy-config \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"mode":"custom","custom_url":"http://127.0.0.1:7890"}' | jq

# 恢复系统代理
curl -s -X PATCH http://localhost:3000/api/proxy-config \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"mode":"system"}' | jq
```

Expected: API 正常返回，切换后各模块日志中应看到 proxy config updated

- [ ] **Step 5: UI 验证**

打开 http://localhost:5173（Vite dev）→ 全局设置页面，确认：
1. 网络代理卡片正常显示
2. 三种模式切换正常
3. system 模式显示当前系统代理 URL
4. custom 模式输入框可用
5. 保存后 toast 提示成功

- [ ] **Step 6: Telegram 代理验证（如果已配置 bot）**

确认 Telegram Channel 模块的 fetch 请求通过代理正常连接到 api.telegram.org（之前的 ConnectTimeoutError 应该解决）。

- [ ] **Step 7: Commit（如有修复）**

```bash
git add -A
git commit -m "fix: address issues found in e2e testing"
```

---

### Task 12: 更新 CLAUDE.md 和模块文档

**Files:**
- Modify: `crabot-channel-telegram/CLAUDE.md`
- Modify: `crabot-channel-wechat/CLAUDE.md`

- [ ] **Step 1: 更新 crabot-channel-telegram/CLAUDE.md**

文件结构部分，删除 `└── core/` 条目，改为说明依赖 crabot-shared：

```markdown
## 依赖

- `crabot-shared` — 模块基类、RPC 客户端、代理管理
```

- [ ] **Step 2: 更新 crabot-channel-wechat/CLAUDE.md**

同样删除 `└── core/` 条目，加入 crabot-shared 依赖说明。

- [ ] **Step 3: Commit**

```bash
git add crabot-channel-telegram/CLAUDE.md crabot-channel-wechat/CLAUDE.md
git commit -m "docs: update module docs to reflect crabot-shared migration"
```
