# Crabot

模块化 AI 员工平台。将 AI 智能体连接到消息渠道（Telegram、微信等），通过 Web UI 或 CLI 管理，让它们自主处理任务。

## 架构

```
                    +-------------------+
                    |   Admin WebUI     |  :3000
                    |   + REST API      |
                    +--------+----------+
                             |
              +--------------+--------------+
              |                             |
     +--------v--------+          +--------v--------+
     |  Module Manager  |  :19000 |    CLI (crabot)  |
     |  (crabot-core)   |         |  REST API 客户端  |
     +--------+---------+         +-----------------+
              |
    +---------+---------+---------+
    |         |         |         |
 Agent    Channel    Channel   Memory
 :19002+  Host       Telegram  (Python)
          :19010+    :19020+
```

**模块一览：**

| 模块 | 语言 | 说明 |
|------|------|------|
| `crabot-core` | TypeScript | Module Manager — 进程生命周期、端口分配、RPC 路由 |
| `crabot-admin` | TypeScript | Admin WebUI + REST API + 编排层 |
| `crabot-agent` | TypeScript | AI 智能体，多格式 LLM 引擎（Anthropic/OpenAI/Gemini） |
| `crabot-memory` | Python | 长短期记忆（LanceDB + 向量嵌入） |
| `crabot-channel-host` | TypeScript | 渠道插件宿主 |
| `crabot-channel-telegram` | TypeScript | Telegram 渠道 |
| `crabot-channel-wechat` | TypeScript | 微信渠道 |
| `crabot-mcp-tools` | TypeScript | 内置 MCP 工具服务 |

## 快速开始

### 环境要求

- Node.js >= 22
- Python >= 3.11 + [uv](https://docs.astral.sh/uv/)

### 从 Release 安装

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/smilefufu/crabot/main/install.sh | bash

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/smilefufu/crabot/main/install.ps1 | iex"
```

安装脚本会自动检查并安装前置依赖（Node.js、uv），下载最新 Release 包，并提示设置管理员密码。

### 从源码安装

```bash
git clone https://github.com/smilefufu/crabot.git
cd crabot
./install.sh --from-source
```

### 运行

```bash
# 启动（首次启动会提示设置管理员密码）
crabot start

# 打开 Admin UI
open http://localhost:3000

# 检查状态
crabot check

# 停止
crabot stop
```

### 修改密码

```bash
crabot password
```

## CLI

CLI 覆盖了 Admin WebUI 的全部能力，人类和 AI 智能体均可使用。

```bash
crabot provider list          # 查看模型供应商
crabot agent list             # 查看智能体实例
crabot mcp list               # 查看 MCP 服务
crabot schedule list          # 查看定时任务
crabot channel list           # 查看渠道
crabot friend list            # 查看好友
crabot config show            # 查看全局配置
crabot permission list        # 查看权限模板

# JSON 输出（用于脚本或智能体调用）
crabot provider list --json
```

完整命令列表请执行 `crabot --help`。

## 开发

```bash
./dev.sh          # 构建 + 启动 Module Manager + Vite HMR（端口 5173）
./dev.sh stop     # 停止所有服务
./dev.sh build    # 仅构建
```

- 前端代码修改：浏览器自动刷新（Vite HMR，`http://localhost:5173`）
- 后端代码修改：需重启 `./dev.sh stop && ./dev.sh`

### 多实例

同一台机器可运行多个 Crabot 实例，通过端口偏移隔离：

```bash
CRABOT_PORT_OFFSET=100 ./dev.sh    # 所有端口 +100，数据目录自动变为 data-100/
```

## 配置

1. 启动系统 `crabot start`
2. 打开 Admin UI `http://localhost:3000`
3. 添加模型供应商、配置智能体、连接渠道

## 许可

Apache-2.0
