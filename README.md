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

macOS候选采用真正Crabot.app：从DMG拖到Applications后打开，首次启动选择数据位置。Windows/Ubuntu通过一次离线安装，完整运行环境随包提供。源码用于独立开发，使用项目内命令和数据，不覆盖release或历史源码部署。实现和验收状态见路径表；公开main尚不等于本轮候选。

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

源码开发使用Node >=22.14、仓库指定pnpm9、uv和本平台编译工具。新开发命令不注册全局crabot，数据在当前工作副本/data；release和旧源码部署的全局命令、原数据保留。详细工具链和错误处理见[开发指南](https://github.com/smilefufu/crabot-docs/blob/main/guides/development.md)。

```bash
git clone https://github.com/smilefufu/crabot.git
cd crabot
node scripts/dev.mjs build  # 只准备与构建，不启动业务
pnpm dev                   # 开发Core和Vite HMR
pnpm dev status
pnpm dev stop
pnpm dev desktop           # 显式准备并打开开发GUI
```

macOS/Linux的`./install.sh --from-source`及Windows的`./install.ps1 -FromSource`作为开发准备兼容入口；无桌面开发不强制下载Electron。`dev.sh`仍转发相同Node入口。

开发Admin为`http://127.0.0.1:13000`，Vite为`http://127.0.0.1:5173`；release默认Admin仍是3000。首次开发浏览器临时密码为admin123，登录后修改；开发GUI不询问该密码。前端使用Vite HMR，后端修改用`pnpm dev restart`，只停止本dev。

支持一个dev与一个release同时运行，数据和固定端口独立；占用时报告冲突，不杀占用者或自动改目录。若该源码副本还承载历史长期部署，先保留原部署并使用另一个工作副本开发，不在运行中重编它。旧源码部署继续原`crabot upgrade/start/stop`，不会被新dev入口自动转换成空数据。

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

> 以下crabot业务管理命令面向release或保留的历史源码部署。新源码开发的生命周期使用项目内pnpm dev，不抢占全局命令。完整命令列表：`crabot --help`。

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
| 历史源码user CLI | 保留原命令/data；保存本地修改并更新选定Git版本，按原crabot upgrade和停机纪律准备、迁移、启动核验，不自动git pull或转为新dev。 |
| 新源码开发 | pnpm dev stop → 更新源码 → pnpm dev；不升级或导入release业务数据。 |
| 新版独立release CLI | `crabot stop` → `crabot upgrade` → `crabot start` → `crabot status`。 |
| 旧release CLI | 首次升级到新版内置环境格式须独立验证；新版安装器不直接覆盖旧目录，同格式更新通过不代表此路径已验收。 |
| 桌面受管 | GUI或 `crabot upgrade` 打开同一更新界面，由用户确认；GUI/Core配对，开发候选关闭正式自动更新。 |
| system | 按上节与管理员指南区分release转换、受管更新和源码维护；普通员工不能升级共享代码。 |

只保护本次将迁移的配置/数据库，不整份复制data、workspace或安装根。失败保留原数据和维护记录，按对应恢复提示处理；保留旧代码不表示新数据库能任意降级。修复重装与全新安装分别处理，完整场景见[路径表](https://github.com/smilefufu/crabot-docs/blob/main/guides/installation-upgrade-paths.md)。

## 常见问题

**提示 `uv 未安装`、或找不到 `crabot` 命令？**

已有CLI安装可能把 `~/.local/bin` 写入shell profile（`~/.bashrc` / `~/.zshrc`），新终端生效。新源码开发不注册全局crabot；当前终端找不到uv或已有用户CLI时，先核对实际安装位置，可补充：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 许可

Apache-2.0
