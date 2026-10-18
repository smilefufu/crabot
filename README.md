# Crabot

模块化硅基伙伴。将 AI 智能体连接到消息渠道（Telegram、微信等），通过 Web UI 或 CLI 管理，让它们自主处理任务。

## 桌面版（开发候选）

桌面版正在独立分支开发与验收，尚未正式发行。它会内置Node、Python、浏览器和必需依赖，安装后直接打开；GUI无需Crabot密码，原crabot管理命令继续保留并共用同一实例。关闭窗口继续后台运行，退出Crabot会停止共享服务。

候选的使用方式见[桌面版指南](https://github.com/smilefufu/crabot-docs/blob/main/guides/desktop-usage.md)，管理员共享部署见[System mode指南](https://github.com/smilefufu/crabot-docs/blob/main/guides/system-mode-operations.md)。旧部署的完整兼容转换仍在实施，当前公开旧发行包不因此具备新版转换和批量管理能力。

下面的快速开始仍介绍现有CLI发行和源码方式；桌面安装包及完整升级入口在正式发行时提供。

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

## 团队部署（System Mode）

针对"root 全局安装 + 多 Linux 用户各跑自己实例"的服务器部署形态。每个用户拿到独立 OFFSET 自动分配的端口、独立的 `~/.crabot/data-<OFF>/`，互不污染。

### 管理员视角

```bash
# 1. 装系统依赖（Node 22+ 和 uv 必须系统级可达，不要装在 root 的 ~/）

# 1a. Ubuntu/Debian：先卸掉发行版自带的 node 12（否则与 nodesource 22 的 /usr/include/node/common.gypi 冲突装不上）
sudo apt-get purge -y nodejs libnode-dev libnode72 2>/dev/null || true
sudo apt-get autoremove -y

# 1b. 加 nodesource 22 源并安装
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs

# 1c. 装 uv
#   - UV_INSTALL_DIR 是 flat layout，直接当 bin 目录用（不会自动加 /bin 后缀），所以写 /usr/local/bin
#   - sudo 默认会清环境变量，必须经 `sudo env` 传递
#   - UV_NO_MODIFY_PATH=1 跳过改 shell rc（system mode 下没必要污染 root）
curl -LsSf https://astral.sh/uv/install.sh | sudo env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh

# 2. 装 Crabot（system mode），二选一：
#    A. release 模式（推荐，稳定）
curl -fsSL https://raw.githubusercontent.com/smilefufu/crabot/main/install.sh | sudo bash -s -- --system
#    B. 源码模式（小补丁可直接 git pull + rebuild，免发版）—— 见下方"源码模式管理员视角"

# 装完后：
#   - 代码在 /opt/crabot（release）或你 clone 的目录（源码）
#   - /etc/crabot/ 骨架已创建（defaults/ + registry/ + cluster.version）
#   - crabot group 已创建
#   - /etc/logrotate.d/crabot 已铺
#   - /usr/local/bin/crabot 软链已建

# 3. 加员工到 crabot group
sudo usermod -a -G crabot alice
sudo usermod -a -G crabot bob
# 员工需要重新登录 shell 才能生效

# 4. (可选) 自定义员工"添加 provider"下拉里可选的供应商目录（只配厂商菜单，不含 key）
sudo crabot vendor add        # 交互向导；也可直接编辑 /etc/crabot/defaults/vendor.yaml
#   - 完全以 root 为准，无需 sync；各员工 admin 下次重启自动生效
#   - `crabot vendor mode replace` 可只保留你审批过的厂商（ChatGPT 订阅等 OAuth 内置项始终保留）
#   - 参考样例：/etc/crabot/defaults/vendor.yaml.example；查看/删除：crabot vendor list / remove <id>

# 5. 后续升级（crabot upgrade 检测 .git 自动选模式，两种模式命令一致）
#    release 模式：sudo crabot upgrade（下载新 release 包并解压到 /opt/crabot）
#    源码模式：cd /opt/crabot && sudo git pull && sudo crabot upgrade
```

### 源码模式管理员视角（适合需要打小补丁、不想等 release 的场景）

```bash
# 1. 选一个员工可读的目录 clone（不要放 /root/——700 权限员工读不到）
sudo mkdir -p /opt && cd /opt
sudo git clone https://github.com/smilefufu/crabot.git
cd crabot

# 2. 装（--system --from-source 组合）。会在当前 git 目录直接 pnpm install + build，
#    /usr/local/bin/crabot 软链直接指向 $(pwd)/cli.mjs，不会把源码拷到 /opt/crabot
sudo ./install.sh --system --from-source

# 3. 同 release 模式：加员工到 crabot group、(可选) 自定义供应商目录
#    （见上方第 3、4 步，命令一字不差）

# 4. 后续升级（源码模式相对 release 的核心收益：小补丁两条命令搞定）
cd /opt/crabot
sudo git pull
sudo crabot upgrade
# crabot upgrade 检测到 .git 自动走源码分支：依次跑 root install / shared /
# 各模块 install+build / 前端 / build:cli / scripts/lib / uv sync / data migration
# 员工无感升级——下次 `crabot start` 直接用新代码（cli.mjs 是软链，自动跟最新）
```

#### 源码模式的几个坑

- **clone 位置**：必须放员工 uid 可读处。`/opt/` 默认 0755 OK；`/root/`（0700）不行
- **代码归属 root**：员工进程能读不能写，符合预期。不要 `sudo chown crabot:` 之类乱改
- **管理员不要在源码目录跑 `crabot start`**：员工实例 data 走 `~/.crabot/data-<OFFSET>/`，跟源码无关；但 root `cd /opt/crabot && crabot start` 测试会污染 `/root/.crabot/`
- **`crabot upgrade` 前要先 `git pull`**：它不会自动 fetch，只负责检测到 `.git` 后跑完整 rebuild + migration
- **升级前最好让员工先 `crabot stop`**：upgrade 只检查 root 自己 DATA_DIR 的 mm pid，不会拦员工跑着的实例；员工进程读旧文件后 require cache 还在，新代码要等下次重启才生效

### 员工视角

第一次：

```
$ crabot start
[init] 检测到 system mode 安装（/opt/crabot）
[init] 申请端口偏移... 已分配 OFFSET=100
[init] 写入 shell 配置：~/.bashrc
[init] 完成。请重新登录 shell 或执行 `source ~/.bashrc` 让环境变量生效。

Set admin password: ****
[crabot] Starting Module Manager (port 19100)...
[crabot] Admin Web: http://localhost:3100
```

日常用后台 + 状态查询：

```bash
crabot start -d         # 后台启动（日志写到 ~/.crabot/data-<OFF>/logs/，自动轮转）
crabot status           # 看自己实例的端口/状态
crabot stop             # 停掉
```

### 排错

| 症状 | 解决 |
|---|---|
| `permission denied: /etc/crabot/registry/ports.json` | `sudo usermod -a -G crabot $USER`，重新登录 |
| `already running (pid=N)` | `crabot stop` 后再 start |
| `No admin password set`（`-d` 模式） | 先 `crabot start`（前台）一次设密码 |
| `please ask the administrator` | 让 root 跑 `sudo crabot upgrade` |
| `crabot start` 卡在 "root 默认配置已更新" | 按 y 接收或 N 跳过 |

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
