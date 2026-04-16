# crabot-channel-host — 给 Claude 的上下文指南

## 这个模块是什么

`crabot-channel-host` 是一个 **OpenClaw 插件兼容层（Shim）**。

它的唯一职责：**让 OpenClaw 生态的 channel 插件（npm 包）能以 Crabot Channel 模块的形式运行**，无需改造插件本身。

## 为什么要做这个 Shim

OpenClaw 是一个竞品 AI 员工产品，拥有成熟的 channel 插件生态（微信、飞书、Telegram 等）。这些插件通过 `npm install` 安装，有自己的安装向导 CLI（如 `npx @tencent-weixin/openclaw-weixin-cli install`）。

Crabot 通过 Shim 层**直接兼容这些插件**，无需为每个 IM 平台单独开发 channel 模块。

## ⚠️ 修改此模块前必须理解的核心概念

### 两种安装方式（绝对不能搞混！）

OpenClaw 生态中，不同 IM 厂商的安装向导有两种不同的插件安装方式。这两种方式**都是正式的、都需要支持**：

#### 方式 A：npm 依赖式（飞书 `@larksuite/openclaw-lark-tools`）

- 插件包 `@openclaw/feishu` 是 channel-host 的 **npm 依赖**，在 `channel-host/node_modules/@openclaw/feishu/`
- 安装向导**不调用** `openclaw plugins install`，只写 `openclaw.json` 的 `plugins.entries` + `channels` 配置
- `openclaw.json` **没有** `plugins.installs` 段
- 运行时通过 channel 名（如 `feishu`）推断平台名，去 `node_modules/@openclaw/<platform>` 找插件入口

```json
// 飞书的 openclaw.json 示例
{
  "plugins": {
    "entries": { "openclaw-lark": { "enabled": true } },
    "allow": ["openclaw-lark"]
  },
  "channels": {
    "feishu": { "enabled": true, "appId": "cli_xxx", "appSecret": "xxx", ... }
  }
}
```

#### 方式 B：shim CLI 安装式（微信 `@tencent-weixin/openclaw-weixin-cli`）

- 安装向导调用 `openclaw plugins install "@tencent-weixin/openclaw-weixin"`
- shim 通过 `npm pack` + 解压安装到 `$OPENCLAW_STATE_DIR/extensions/<plugin-id>/`
- `openclaw.json` 的 `plugins.installs[id].installPath` 记录了**确切的安装目录**
- 运行时直接用 `installPath` 找插件入口，不需要推断

```json
// 微信的 openclaw.json 示例
{
  "plugins": {
    "entries": { "openclaw-weixin": { "enabled": true } },
    "installs": {
      "openclaw-weixin": {
        "source": "npm",
        "spec": "@tencent-weixin/openclaw-weixin",
        "installPath": "/path/to/extensions/openclaw-weixin"
      }
    }
  }
}
```

### 运行时加载逻辑（`main.ts` 的 `loadFromOpenclawJson`）

区分依据是 `openclaw.json` 中是否有 `plugins.installs`：

1. 有 `installs[pluginId].installPath` → 直接用 `installPath` 找入口（方式 B）
2. 没有 `installs` → 从 `channels` 段的 channel 名推断平台，去 `node_modules/@openclaw/<platform>` 找（方式 A）

**这不是 fallback！** 二者是两种独立的安装方式，由 openclaw.json 的内容决定走哪条路。

### 踩过的坑（必读）

- **2026-03-23**：实现微信 `channels login` 时，删除了方式 A 的 `node_modules` 加载逻辑，导致飞书插件全部无法启动。根因是没理解两种安装方式的区别，误以为所有插件都走 `installPath`。
- **fakeApi stub 不完整**：微信插件的 `register(api)` 调用了 `api.registerCli()`，但 fakeApi 最初没有这个 stub → 报错 `api.registerCli is not a function`。新插件可能调用其他 api 方法，遇到 `api.xxx is not a function` 错误时，在 fakeApi 中加 no-op stub 即可。

## Shim 的两个核心组成部分

### 1. `bin/openclaw.js` — CLI Shim（替代 OpenClaw CLI）

OpenClaw 插件的安装向导（如 `@tencent-weixin/openclaw-weixin-cli`）会调用系统上的 `openclaw` 命令。安装向导的调用序列固定是：

```
1. which openclaw                              → 检查 openclaw 是否在 PATH 上
2. openclaw plugins install "@scope/pkg"      → 安装 npm 插件包到 extensions/ 目录
3. openclaw channels login --channel <id>     → 加载插件 gateway，执行 QR 登录流程
4. openclaw gateway restart                   → 写 .install-complete 标记，Admin PTY 监听后触发扫描
```

`bin/openclaw.js` 完整模拟这四步：
- **plugins install**：真实执行 `npm pack` + 解压到 `$OPENCLAW_STATE_DIR/extensions/<plugin-id>/`，写入 `openclaw.json` 的 `plugins.installs`
- **channels login**：加载插件 gateway，调用 `loginWithQrStart`/`loginWithQrWait` 执行 QR 登录流程，成功后更新 `openclaw.json` 的 `channels` 段
- **gateway restart**：写入 `.install-complete` 标记文件（Admin PTY 监听此文件自动触发插件扫描），然后退出

注意：`openclaw.js` 是纯 CommonJS（不是 TypeScript），加载 TS 插件时用 jiti。其中 `buildOpenClawAlias()` 和 `loadPluginGateway()` 是从 `plugin-loader.ts` 提取的 CJS 版本。

### 2. `src/channel-host.ts` — 运行时 Shim（替代 OpenClaw Gateway Runtime）

OpenClaw 插件运行时需要一个 `channelRuntime`（"工具箱"）。`channel-host` 提供自己实现的 `channelRuntime`，将插件的消息回调桥接到 Crabot 的 RPC 事件系统：

```
插件收到 IM 消息
  → 调用 channelRuntime.reply.dispatchReply*(ctx, dispatcherOptions)
  → channel-host 的 runtime/reply.ts 处理
  → 发布 channel.message_received 事件到 MM
  → Agent 接收并处理
  → Agent 调用 channel.send_message
  → channel-host 调用 dispatcherOptions.deliver(payload)
  → 插件将消息发回 IM 平台
```

## Admin PTY 终端的作用（关键！）

**`ChannelPty` 页面（Admin UI 的 OpenClaw 安装终端）是插件安装向导的运行环境。**

用户**必须在这个 PTY 终端里**运行安装向导命令（如 `npx @tencent-weixin/openclaw-weixin-cli install`），而不是在普通系统终端里。原因：

1. PTY 终端的环境变量 `OPENCLAW_STATE_DIR` 指向 channel-host 为该次安装分配的专属 state 目录（位于 `data/admin/openclaw/<channel-module-id>/`）
2. `PATH` 包含 `bin/openclaw.js` 的软链接，使得安装向导调用的 `openclaw` 命令实际执行的是 Crabot 的 Shim
3. 普通系统终端没有这些环境，安装向导会找不到 `openclaw` 命令或写错配置路径

PTY 终端由 `crabot-admin/src/pty-manager.ts` 通过 WebSocket 提供，后端通过 `node-pty` spawn 子进程。

## 安装完成后的流程

安装向导执行 `openclaw gateway restart` 时，Shim 会写入 `$OPENCLAW_STATE_DIR/.install-complete` 文件。Admin 的 PTY Manager 监听此文件，检测到后向前端 WebSocket 发送 `{ type: 'install_complete' }` 消息，前端自动触发插件扫描（`scanStateDir`）。

扫描成功后，用户在 Admin UI 填写实例名称，点"注册并启动"，Admin 创建 channel-host 模块实例并启动。

## 登录（凭证配置）

不同插件的登录方式不同：

- **飞书**：通过 Admin 向导填写 appId/appSecret，直接写入 `openclaw.json` 的 `channels.feishu` 配置
- **微信**：需要 QR 扫码。CLI shim 调用插件的 `gateway.loginWithQrStart()`/`gateway.loginWithQrWait()` 完成登录，凭证由插件内部保存到 `$OPENCLAW_STATE_DIR/<plugin-id>/accounts/`，shim 只在 `openclaw.json` 的 `channels` 段写 `{ enabled: true }`

## 关键文件地图

```
crabot-channel-host/
├── bin/
│   └── openclaw.js          ← CLI Shim（纯 CJS）：拦截安装向导的所有 openclaw 命令
│                               包含 plugins install/update、channels login（QR 登录）、gateway restart
├── src/
│   ├── main.ts              ← 模块入口：loadFromStateDir → loadFromOpenclawJson（两种加载路径）
│   ├── channel-host.ts      ← 主类：实现 Crabot Channel 协议的所有 RPC 方法
│   ├── plugin-loader.ts     ← 运行时加载 OpenClaw 插件（支持两种格式，用 jiti 加载 TS 源码）
│   ├── runtime/
│   │   ├── index.ts         ← createChannelRuntime() 入口
│   │   ├── reply.ts         ← 核心桥接：OpenClaw dispatchReply* → Crabot send_message
│   │   ├── routing.ts       ← 消息路由逻辑
│   │   └── stubs.ts         ← 未实现功能的 Stub（pairing、subagent 等）
│   ├── msg-converter.ts     ← OpenClaw MsgContext → Crabot ChannelMessage 格式转换
│   ├── session-manager.ts   ← Session 生命周期管理（持久化到 data_dir）
│   ├── message-store.ts     ← 历史消息存储
│   └── pending-dispatch.ts  ← 等待 Agent 回复的 dispatch 映射（session_id → deliver fn）
```

**构建**：`npx tsc` 生成 `dist/`。`bin/openclaw.js` 不需要构建（纯 CJS）。修改 `src/*.ts` 后必须重新 `npx tsc` 才能生效。

## 插件格式兼容

OpenClaw 插件有两种格式，`plugin-loader.ts`（运行时）和 `openclaw.js`（CLI login）都支持：

1. **高级格式**（如 `@openclaw/feishu`、`@tencent-weixin/openclaw-weixin`）：导出 `{ register(api) }` 对象，通过 `api.runtime = channelRuntime` 注入，用 `jiti` 加载（插件是 TypeScript 源码，无 dist）
2. **简化格式**：直接导出 `{ gateway, config }` 对象

### fakeApi stub 列表（`plugin-loader.ts` 和 `openclaw.js` 各有一份）

插件的 `register(api)` 会调用 api 上的方法。目前已知需要的 stub：
- `api.runtime` — channelRuntime 注入（运行时传真实对象，CLI login 传空对象）
- `api.registerChannel({ plugin })` — 捕获 ChannelPlugin（含 gateway/config）
- `api.registerCli()` — 微信插件调用，no-op
- `api.registerTool/registerConfig/registerApp/registerAgent/registerSubagent/setStatus` — no-op
- `api.logger` — 日志转发

**新插件报 `api.xxx is not a function`？** 在 fakeApi 中加对应的 no-op stub。

## 数据存储位置

每个 channel-host 实例有独立的 state_dir：
```
data/admin/openclaw/<channel-module-id>/
├── openclaw.json      ← 插件配置（plugins.entries / installs / channels 段）
├── extensions/
│   └── <plugin-id>/   ← shim CLI 安装的插件文件（npm pack 解压）
└── .install-complete  ← 安装完成标记（由 openclaw gateway restart 写入）
```

运行时数据在 `data_dir`（由 MM 注入）：
```
data/<channel-module-id>/
├── sessions.json      ← Session 列表
└── messages/          ← 历史消息
    └── <session-id>.jsonl
```

## 已知 Stub（Phase 1，尚未实现）

- `stubs.ts`: `pairing` — 配对机制全部通过（`readAllowFromStore` 返回 `['*']`）
- `stubs.ts`: `subagent.run` — 抛出未实现错误
- `channel-host.ts`: `get_platform_user_info` — 返回 `supports_platform_user_query: false`
