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

两种路径，**选一种即可**。脚本会自动处理依赖（Node.js、uv；源码模式还包括 pnpm — 通过 corepack 自动激活），无需手动准备。

### 路径 A：二进制安装（只想用）

从 GitHub Release 下载预构建包到 `~/.crabot/`，并在 `~/.local/bin/` 创建全局 `crabot` 命令。

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/smilefufu/crabot/main/install.sh | bash

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/smilefufu/crabot/main/install.ps1 | iex"
```

安装完成后（若提示 PATH 有变更，重开一个终端即可）：

```bash
crabot start       # 启动（首次会提示设置管理员密码）
crabot stop        # 停止
crabot check       # 环境检查
crabot password    # 修改管理员密码
```

### 路径 B：源码运行（改代码 / 贡献）

从源码 clone 后用 `install.sh --from-source` 一键完成环境准备：装工具（Node/uv/pnpm）、装依赖、编译、生成 `.env`、把 `crabot` 命令软链到 `~/.local/bin/`。完成后即可在任意目录用全局 `crabot` 命令。

```bash
git clone https://github.com/smilefufu/crabot.git
cd crabot
./install.sh --from-source
crabot start       # 启动（dist/ 已就绪，无需重新构建）
crabot stop
crabot check
```

代码有更新（`git pull`）后，重装依赖 + 重编译：

```bash
crabot stop
git pull
crabot upgrade     # 增量同步依赖 + 重编译 + 数据迁移
crabot start
```

开发模式（前端 Vite HMR，热更新）：

```bash
./dev.sh             # 启动（http://localhost:5173 是 Vite dev server）
./dev.sh stop        # 停止
./dev.sh build       # 仅构建
```

- 首次跑 `./dev.sh` 前必须先 `./install.sh --from-source`
- `git pull` 拉到新依赖后 `./dev.sh` 会**自动同步**变更模块（基于 lock mtime），无需手动 install
- 前端代码修改：浏览器自动刷新
- 后端代码修改：需重启 `./dev.sh stop && ./dev.sh`

### 首次启动后

打开 Admin UI 完成配置：

1. 访问 http://localhost:3000（密码见 `.env` 或安装时设置的）
2. 添加模型供应商（OpenAI / Anthropic / Ollama / ChatGPT OAuth 等）
3. 配置智能体实例（选择模型 slot、MCP 工具、权限模板）
4. 连接消息渠道（Telegram / 微信）

### 多实例部署

同一台机器可运行多个 Crabot 实例，通过 `CRABOT_PORT_OFFSET` 隔离端口和数据目录：

```bash
CRABOT_PORT_OFFSET=100 crabot start   # 所有端口 +100，数据目录变为 data-100/
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

> 源码路径（B）下的 `crabot` 是项目根目录的脚本（不在 PATH），建议 `cd` 进项目后使用。完整命令列表：`crabot --help`。

## 升级

```bash
crabot stop

# Release 模式
crabot upgrade           # 检测最新 tag → 下载替换 → 数据迁移

# 源码模式
git pull                 # 拿新代码
crabot upgrade           # 重装依赖 → 构建 → 数据迁移

crabot start
```

> **注意：** 升级前会自动备份 `data/`（release 模式备份整个安装目录）。
> 升级失败时 backup 完整保留，按 stderr 指引手工恢复后再次执行 `crabot upgrade`。
> 模块如果数据 schema 与代码不匹配，Module Manager 会拒绝启动该模块并提示。

## 常见问题

**提示 `uv 未安装`、或找不到 `crabot` 命令？**

安装脚本把 `~/.local/bin` 写进了 shell profile（`~/.bashrc` / `~/.zshrc`）。新开的终端自动生效；源码模式下的根目录 `crabot` 脚本已内置 PATH 兜底不受影响。只有在**当前终端直接调用 `uv` 或全局 `crabot`** 时需要先执行：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 许可

Apache-2.0
