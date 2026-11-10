# Cordis 完整实例验证

本目录保存单端口迁移的临时数据复现。产品入口已接入真实 Core/Admin/Agent/Memory、Cordis 飞书和实例级 npm 安装；现有部署不变。全部外部业务验证使用合成账号与本地平台/模型夹具，不能冒充真人飞书扫码或真实模型能力验收。用户已授权先发布 npm 候选包；不部署现有实例、不提未完成 PR。

## 已有证据

- `normal-instance.test.mjs`：正常 managed Core main 启动真实核心模块，OS 盘点整个受管进程树（含 Python 孙进程），仅发现 Admin Web 监听；正常停止、子进程退出并清除运行记录。
- `product-e2e.test.mjs`：全新实例无飞书预装包，从已认证 Admin 扫码入口触发实际 npm 安装，再通过真实 onboarder 完成二维码、凭据保存和自动认主。原始平台消息经过 Admin 授权、真实 Agent、本地模拟 OpenAI 流与真实 `send_message` 工具投递回平台出口。覆盖私聊、群聊、图片进入模型输入、惰性文件下载、图片/文件发送、远端历史，以及 Web 重启飞书后 canonical session 保留。夹具只替换包来源和外部平台/模型，不模拟 Admin/Agent 授权或投递。
- 正式 `ChannelPackageStore` 空缓存国内源安装已通过，依赖 lock 与实际 HTTP 下载均为 `registry.npmmirror.com` / `cdn.npmmirror.com`；随后新产物从该缓存断网安装，并经完整实例加载。配置和 cache 属于实例；失败仅清理本次 staging、保留 cache/旧版本；不改全局 npm 配置，不回退国外源。npm 子进程不继承 Admin 凭据或 Node preload。
- `managed-runtime.test.mjs`：真实 MM、Cordis 与 npm 飞书双实例隔离、原始事件、重启持久化；`memory-runtime.test.mjs`：真实 Python Memory、MessagePack、SQLite、敏感 bearer 拒绝、大帧和两次启动。`full-instance.test.mjs` 是较早的真实核心装配验证。
- 固定控制连接核验 OS 用户、当前 MM/child/runtime；replacement 不接收旧连接请求。真实 durable workspace gate 在丢失启动确认后不重复启动，IPC 仍能承载二进制/BigInt 测试消息。Windows 路由编号不作为 TCP listener 归属证据。

当前 npm 包 `crabot-channel-feishu@0.1.0`：压缩 202,217 B，展开 879,162 B，227 个文件；SHA-1 `b70213ddc8ebf4122bad5c7bdb29eda3c738b4f8`。SDK/Cordis 等完整安装依赖约 40 MiB，下载 cache 另计；这些数字不是整个 Crabot 安装包大小。Unix/Windows 旧发行和 sealed Core staging 均改为只保留飞书目录元数据，完整发行包差额仍待实际构建计量。

## 复现

使用项目要求的 Node 22；先构建 shared/client/core/admin/agent、MCP tools、Admin Web、native helper，并准备 Memory 冻结依赖。不要使用现有业务 DATA_DIR。

```sh
node scripts/pack-channel-feishu.mjs <新的产物目录>
node --test experiments/cordis-feishu/normal-instance.test.mjs
CORDIS_PLUGIN_TARBALL=<tarball绝对路径> \
CORDIS_NPM_CACHE_DIR=<已准备的国内npm缓存> \
node --test experiments/cordis-feishu/product-e2e.test.mjs
```

完整收发夹具从本地 npm tarball 和显式离线 cache 安装依赖；平台与模型网络均是模拟。实际空缓存国内下载走正式 `ChannelPackageStore.ensure()`，其组件测试与合成实例验证分别保留，不能拿 cache 命中替代国内下载成功。

旧 `pack.mjs` 仅转发正式打包器；`install.mjs` / `smoke.test.mjs` / `install.test.mjs` 保留最初组件实验，不能替代正式实例证据。最初一次无重试下载曾遇国内 CDN FETCH_ERROR；正式安装器改为保留 cache 并有界重试后，新的空缓存下载实际通过。

## 发行归档与平台验证

首轮干净提交 `9b08cc26` 的 macOS ARM 候选已构建并解包核验：29,863 个清单文件、展开 1,145,223,367 B；tar.gz 445,021,546 B，SHA-256 `438f8728d4b9e2d440dba4e4c7f1a7b8bc06a4d090c682d8d0029be07c363d60`。正常实例、真实 CLI 启停及 npm 扫码/真实 Agent 合成收发 3/3 通过，运行后 seal 清单不变。不同资源或构建格式的旧发行不能直接拿来计算瘦身比例。

通过 `CORDIS_CORE_ROOT=<解包后的Core根>` 可把正常实例、CLI 和完整收发夹具指向实际发行目录。主包飞书目录仅有 package.json / crabot-module.yaml，共 3,918 B；安装后的完整插件依赖约 40 MiB，缓存另计。已准备 `CORDIS_PUBLIC_NPM=1` 的真实公开源安装验证入口，届时不会替换安装器，也不使用离线 tarball/cache 注入；平台与 Provider 仍只用合成数据。已首次公开发布 `crabot-channel-feishu@0.1.0`，标签 `cordis-validation`；官方与国内镜像元数据完整性一致。公开包模式端到端 1/1 通过（29.5 秒）：全新临时实例从正式扫码入口触发真实国内源安装，不替换安装器、不注入 tarball 或缓存；安装来源断言、真实 Agent 合成收发及完整进程树单 Web 监听均通过。日志 `/private/tmp/crabot-cordis-public-npm-e2e-20261110.tap`。

[四平台整组 CI](https://github.com/smilefufu/crabot/actions/runs/42772577876) 已全通过（提交 `025907a5`）：Windows、Linux、Mac ARM / Intel。覆盖 Windows 实际私有 ACL、超过 64 KiB 的帧、超过原握手期限的调用和慢读端背压、真实 Voice 子进程退出、Core IPC、完整停机等待、后台维护与启动/升级入口。生产请求期限与生命周期保持；八个 libuv worker 仅用于同进程承载多个管道两端的测试夹具。

## 未完成及发布边界

Core 全量 572 项通过、16 项平台跳过；Shared 379/2skip、飞书 292、Memory 34、语音 55 通过。真实 CLI init/start/status/check/stop、独立 Electron ASAR / Node 维护包和 Voice 私有管道验证已通过。Admin 两条静态文档断言在未改动基线同样失败，其他隔离定向回归已通过；最终跨平台回归与候选重建已完成，人工验收待进行。用户已明确授权并完成 npm 登录 / 2FA，飞书候选 0.1.0 已发布且在国内可安装；未新增自动发布 workflow。真人扫码/真实客户端验收与现有部署仍分别记录，不能由本地模拟结果代替。

不新增停用状态机、任务排空、强杀期限、HMR 或其它 Channel 批量 npm 化；不改变 Provider 直连与配置引用语义。

新实例和模块记录使用版本 2，CLI / 桌面与实例配套升级。新版只读取无运输字段的旧 HTTP v1 记录作升级前识别，旧程序明确拒绝新记录。`legacy-compatibility-repro.test.mjs` 使用原版 `45ac9153` 的真实读取器，已从红色复现转为通过，并验证拒绝后记录字节保持不变。运行记录写入与版本组合 8 项、模块登记 / 孤儿保护 26 项通过；运行记录控制回归 28 项通过、9 项平台跳过，workspace 门禁与恢复 11 项通过。正式行为见 `crabot-docs/superpowers/specs/2026-11-10-cordis-runtime-record-compatibility-design.md`。最终跨平台与干净候选验证结果见下文；真人收发验收前不提正式 PR。

## 最终自动验证（2026-11-10）

- 产品提交 `ec4b9c82` 的[四平台原生 CI](https://github.com/smilefufu/crabot/actions/runs/42799423129) 全部通过，含运行记录版本组合与真实旧读取器回归。
- 干净提交的完整 macOS ARM 候选：`2026.11.10-cordis.3`，29,863 个清单文件、展开 1,145,224,541 B；归档 445,003,459 B，SHA-256 `62d3d51236e80a8cda195e359d4fd2803cf619fd246ea5ff8c98e3d2b75ba259`。归档位于 worktree 的 `.desktop-build/crabot-cordis-validation-darwin-arm64-20261110-v3.tar.gz`。
- 实际归档解包目录的正常启动/停止、真实 CLI、公开 npm 国内安装扫码及真实 Agent 合成收发 3/3 通过，运行前后完整 seal 核验通过。日志 `/private/tmp/crabot-cordis-v3-sealed-public-e2e-20261110.tap`；这是公开包安装，不是本地 tarball 或暖缓存替代。
- 记录 v2 的 workspace 文件回归 179 项通过、1 项平台跳过；真实独立协调器、Admin/Agent 和 durable IPC 恢复定向用例通过。自动化没有使用真实业务账号、对话或外部 Provider。
- 正式协议已在独立文档仓同步到 main。产品分支保持独立，未提 PR、未合并、未部署。剩余为用户亲自扫码、真实飞书收发验收；需要模型时应在临时实例的 Admin 配置测试 Provider，不自动复制现有实例凭据。

公开标签核对：发布命令显式传入 `--tag=cordis-validation`，npm 首次发布处理后同时产生 `latest: 0.1.0`。经 2FA 执行官方 `npm dist-tag rm crabot-channel-feishu latest` 返回 HTTP 400；当前两个标签仍存在，没有删除版本或改指向占位包。Crabot 使用目录精确版本 0.1.0，国内源公开安装结果保持有效；不得声称包只有验证标签。
