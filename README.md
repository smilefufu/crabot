# Crabot

模块化硅基伙伴。将 AI 智能体连接到消息渠道（Telegram、微信等），通过 Web UI 或 CLI 管理，让它们自主处理任务。

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
| `crabot-channel-telegram` | TypeScript | Telegram 渠道 |
| `crabot-channel-wechat` | TypeScript | 微信渠道 |
| `crabot-channel-feishu` | TypeScript | 飞书渠道 |
| `crabot-channel-slack` | TypeScript | Slack 私聊/群聊渠道（Socket Mode） |
| `crabot-mcp-tools` | TypeScript | 内置 MCP 工具服务 |

## 快速开始

先按[安装与升级路径表](https://github.com/smilefufu/crabot-docs/blob/main/guides/installation-upgrade-paths.md)区分源码/release、GUI/CLI及user/system。桌面版仍是候选，公开main安装脚本取得公开CLI，不会自动安装尚未发布的GUI。

完整桌面包由对应系统离线安装向导安装；独立完整Core通过包内脚本安装，两者内置运行环境。以下保留原公开CLI/源码入口。**本轮路径审计发现源码准备遗漏新共享SDK构建，干净源码安装和升级尚未收齐验收**；源码GUI也没有完整用户安装链，不能仅运行Electron启动脚本就视为支持。

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

1. 访问启动时实际输出的Admin地址，使用已设置的浏览器密码（不要从旧.env示例推断当前凭据）
2. 添加模型供应商（OpenAI / Anthropic / Ollama / ChatGPT OAuth 等）
3. 配置智能体实例（选择模型 slot、MCP 工具、权限模板）
4. 连接消息渠道（Telegram / 微信）

## 团队部署（System Mode）

仅面向Linux共享服务器，管理员统一部署，员工通过浏览器或渠道使用，不支持GUI。必须区分旧release首次转换、已受管release后续更新和源码维护，详见[管理员操作指南](https://github.com/smilefufu/crabot-docs/blob/main/guides/system-mode-operations.md)。

已校验新版完整Core的新安装入口与日常命令：

```bash
sudo ./install.sh --system
sudo crabot system user add alice
sudo crabot system start --all
sudo crabot system status
sudo crabot system restart --all  # 只重启原运行集合，原停止者保持停止
sudo crabot system stop --all
```

员工账号须已存在；管理员设置初始浏览器密码，员工不必先SSH、加入crabot group或手配shell/OFFSET。默认不开业务自启动，开通也不等于立即启动。批量/协调维护要求真实systemd，精简容器保留本人CLI。

旧release的首次转换须从新版完整Core运行安装器，指定核实的原共享根，先准备并展示影响，经一次维护确认后转换；自动识别仅覆盖已列明的v2026.10.14.1/v2026.10.15.1标准发行。已受管release后续使用 `sudo crabot upgrade`，仅恢复原运行且迁移成功的员工，原停止者保持停止。

源码 `sudo ./install.sh --system --from-source` 保留原Git部署，不自动转release；当前仍走旧初始化/升级分支，新批量命令及整机协调不能直接承诺可用，源码多UID升级还须补验。管理员保存本地修改、明确处理原员工实例后维护源码，不能在活实例旁在线原地构建并声称无感升级；也不能把仅检查root自己data的升级当成整机停机证明。不要删除.git或覆盖原部署来强行转换。供应商目录仍直读 `/etc/crabot/defaults/vendor.yaml`。

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

> 源码安装成功后全局命令指向该源码的cli.mjs；仓库根脚本也可从源码目录使用。完整命令列表：`crabot --help`。

### 人类直接使用 CLI

`crabot` 默认输出 JSON（对 LLM 友好）。如果你是人类直接在终端使用，建议加 alias：

```bash
# bash / zsh
alias crabot='crabot --human'

# fish
alias crabot 'crabot --human'
```

加上 alias 后：
- 列表和详情输出表格而非 JSON
- 错误信息按可读文本输出
- 删除类操作交互式 `Type YES to confirm`，而非返回确认 token

无 alias 时也可以在单条命令上加 `--human`：

```bash
crabot provider list --human
crabot provider delete my-provider --human
```

## 升级

| 已安装类型 | 操作与限制 |
| --- | --- |
| 源码user CLI | 保存本地修改并更新选定Git版本；`crabot upgrade`准备构建，在明确stop后切换/迁移，再start和核验。upgrade不自动git pull，准备要求干净工作副本；本轮SDK构建遗漏仍待补验。 |
| 新版独立release CLI | `crabot stop` → `crabot upgrade` → `crabot start` → `crabot status`。 |
| 旧release CLI | 首次升级到新版内置环境格式须独立验证；新版安装器不直接覆盖旧目录，同格式更新通过不代表此路径已验收。 |
| 桌面受管 | GUI或 `crabot upgrade` 打开同一更新界面，由用户确认；GUI/Core配对，开发候选关闭正式自动更新。 |
| system | 按上节与管理员指南区分release转换、受管更新和源码维护；普通员工不能升级共享代码。 |

只保护本次将迁移的配置/数据库，不整份复制data、workspace或安装根。失败保留原数据和维护记录，按对应恢复提示处理；保留旧代码不表示新数据库能任意降级。修复重装与全新安装分别处理，完整场景见[路径表](https://github.com/smilefufu/crabot-docs/blob/main/guides/installation-upgrade-paths.md)。

## 常见问题

**提示 `uv 未安装`、或找不到 `crabot` 命令？**

安装脚本把 `~/.local/bin` 写进了 shell profile（`~/.bashrc` / `~/.zshrc`）。新开的终端自动生效；源码模式下的根目录 `crabot` 脚本已内置 PATH 兜底不受影响。只有在**当前终端直接调用 `uv` 或全局 `crabot`** 时需要先执行：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 许可

Apache-2.0
