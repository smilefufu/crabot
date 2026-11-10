# Cordis 完整实例验证

本目录保存单端口迁移的临时数据复现。产品入口已接入真实 Core/Admin/Agent/Memory、Cordis 飞书和实例级 npm 安装；现有部署不变。全部外部业务验证使用合成账号与本地平台/模型夹具，不能冒充真人飞书扫码或真实模型能力验收。当前不发布 npm、不部署、不提未完成 PR。

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

首轮干净提交 `9b08cc26` 的 macOS ARM 候选已构建并解包核验：29,863 个清单文件、展开 1,145,223,367 B；tar.gz 445,021,546 B，SHA-256 `438f8728d4b9e2d440dba4e4c7f1a7b8bc06a4d090c682d8d0029be07c363d60`。正常实例、真实 CLI 启停及 npm 扫码/真实 Agent 合成收发 3/3 通过，运行后 seal 清单不变。最终修正后仍需重建候选；不同资源或构建格式的旧发行不能直接拿来计算瘦身比例。

通过 `CORDIS_CORE_ROOT=<解包后的Core根>` 可把正常实例、CLI 和完整收发夹具指向实际发行目录。主包飞书目录仅有 package.json / crabot-module.yaml，共 3,918 B；安装后的完整插件依赖约 40 MiB，缓存另计。已准备 `CORDIS_PUBLIC_NPM=1` 的真实公开源安装验证入口，届时不会替换安装器，也不使用离线 tarball/cache 注入；平台与 Provider 仍只用合成数据。公共包未发布，目前不能执行这项验收。

当前三种 Linux/Mac 平台 CI 整组通过；Windows 运行时大帧、长调用、慢读端、Voice 及 Core IPC 已通过。旧网关测试对 Windows 误用 POSIX 权限位，正在换成真实私有目录与原生 ACL 断言；Windows 整组不计全绿。

## 未完成及发布边界

Core 全量 572 项通过、16 项平台跳过；Shared 379/2skip、飞书 292、Memory 34、语音 55 通过。真实 CLI init/start/status/check/stop、独立 Electron ASAR / Node 维护包和 Voice 私有管道验证已通过。Admin 两条静态文档断言在未改动基线同样失败，其他隔离定向回归已通过；最终跨平台回归、最终候选重建与人工验收仍在收尾。当前 `crabot-channel-feishu@0.1.0` 在官方 npm 和国内镜像均返回 404，不能把本地 tarball 验证说成公共 npm 已可安装。在正式包发布与国内镜像可用之前，不能合入/发行依赖它的半成品。未获发布授权，未新增 npm 自动发布 workflow；自动审批已拒绝该外部发布副作用。包发布、真人扫码/真实客户端验收和现有部署都需要分别确认，不能由本地模拟结果代替。

不新增停用状态机、任务排空、强杀期限、HMR 或其它 Channel 批量 npm 化；不改变 Provider 直连与配置引用语义。

旧 HTTP 读取器会忽略新运输字段并接受当前 v1 记录；应拒绝新记录的实际旧读取器回归已复现失败。拟采用新瞬时运行记录 v2、新读取器兼容旧 HTTP v1、旧工具明确拒绝新实例的方案；见 `crabot-docs/superpowers/specs/2026-11-10-cordis-runtime-record-compatibility-design.md`。自动审批已拒绝直接修改持久化格式，等待用户确认；当前未改正式协议或实现，不把候选视为可合入版本。
