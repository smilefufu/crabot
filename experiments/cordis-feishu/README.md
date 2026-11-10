# Cordis 完整实例与 Channel 安装验证

独立分支 `research/cordis-validation`。正常产品入口运行真实 Core/Admin/Agent/Memory，Channel 经 Cordis 受管；自动化仅使用临时数据、合成账号和本地平台/Provider，不代表六个平台真人验收，不修改生产实例。

## 当前行为

- 主包不预装 Channel。模块页显式从国内 npm 源安装，只有完整安装成功的插件出现在已安装分类和新增实例列表；API 同样校验，安装本身不创建账号、不启动、不发消息。
- 六个精确官方包：飞书 `crabot-channel-feishu@0.1.1`；微信、Telegram、钉钉、Slack、语音 `crabot-channel-<platform>@0.1.3`。目录不消费 `latest`。此前候选不覆盖、不删除；五个新入口的真实受管回归发现 Cordis 会把普通 function 当构造函数，修正版使用 async apply 并同步包及模块版本。
- 国内源 `https://registry.npmmirror.com`，只允许该 registry 与国内 CDN；不改全局 npm 配置，不静默回退国外。失败清理本次 stage，保留缓存、旧版和账号；完整精确版本可离线重启。
- 已有实例保留 ID、配置、会话与自动启动选择；缺包恢复失败显示错误、不启动未登记实例。新账号先安装。飞书添加仅扫码；Telegram 仅 polling，微信仅 Socket.IO，二者 Webhook 已移除；其余 WebSocket 链路保留。
- 一个受管 child 只有一个父 IPC peer；语音保留 exact runtime bearer 与 RPC metadata，手机经 Admin Web 的原地址转发到私有管道。整个受管树只保留 Admin Web TCP 监听。

## 回归与复现

Node 22.22.3。先构建 client/shared/core/admin/agent、Admin Web、MCP tools 和 native，准备冻结的 Memory 依赖；勿使用业务 DATA_DIR。

```sh
# 本地候选完整安装、离线复用及六平台真实业务/宿主合成往返
CORDIS_CHANNEL_ARTIFACTS=<新的候选目录> \
node --test experiments/cordis-feishu/channel-packages.test.mjs

# 全新缓存实际下载公开精确包，检查来源，再走同一受管启动/收发/退出验证
node --test experiments/cordis-feishu/public-channel-packages.test.mjs

# 真实发行物可指定根目录；不借用源码 Channel
CORDIS_CORE_ROOT=<完整发行根> CORDIS_PUBLIC_NPM=1 \
node --test --test-concurrency=1 experiments/cordis-feishu/normal-instance.test.mjs \
  experiments/cordis-feishu/cli-instance.test.mjs experiments/cordis-feishu/product-e2e.test.mjs
```

`managed-package-fixture.mjs` 使用实际 npm 业务代码、Cordis 和 IPC，只替换外部平台客户端；验证初始化完成、入站事件、canonical session、回复目标、Slack 断连健康、语音敏感注册和私有通道、单 IPC listener、无 Channel TCP、正常退出及无凭据日志。`product-e2e` 则串联显式安装、飞书扫码、Admin 权限、真实 Agent、本地模拟模型与真实投递工具，覆盖私聊、群聊、图片、文件、历史和重启持久化。SDK 导入成功不能替代这些运行验证。

本轮 Core 全量 576 pass/16 skip、Shared 380/2 skip、飞书 292、Slack 138/5 skip、语音 55、Admin 增量 75及最新安装组 65、相关 Web 13通过；微信 118、钉钉58通过，Telegram 37通过及原基线已复现的1条 reaction 断言失败。六个本地真实 tgz 的受管合成往返已通过。公开精确版本六包空缓存国内安装、断网复用及真实受管往返通过；官方与国内镜像12份元数据的SHA-512均与发布tgz一致。刚发布时国内安装用元数据曾短暂滞后并返回ETARGET，镜像缓存同步后实际安装成功，未切换国外源。[最终四平台原生CI](https://github.com/smilefufu/crabot/actions/runs/42847959084)在生产提交 `75345346` 全部通过：Windows、Linux、macOS ARM/Intel，包含实际公开包安装/受管往返和完整退出组。

## 本轮完整归档（2026-11-10）

生产提交 `75345346`，候选 `2026.11.10-cordis.8`。macOS ARM 归档 `.desktop-build/crabot-cordis-validation-darwin-arm64-20261110-v8.tar.gz`：441,399,176 B，SHA-256 `f840dc0264d2bbc869d0ab6c556dfff05af4adc55ab2f2f8240af2e3507c1611`；25,291个清单文件、展开1,123,310,154 B。主包无六个Channel目录和平台专属SDK。

实际解包后的正常实例、CLI、公开npm显式安装/飞书扫码/真实Agent合成收发/重启持久化、六个国内公开包受管往返4/4通过，运行后完整seal保持。日志 `/private/tmp/cordis-v8-sealed-public-e2e-20261110.tap`；完整性与摘要 `/private/tmp/cordis-v8-proof-20261110.json`。归档验证发现并修正了重复定义错误码误判，按正式协议仅接受 `MODULE_MANAGER_DUPLICATE_ID`，其它登记失败继续保留账号并失败。

相较同平台、同格式的前一轮v3候选，本轮主包压缩少3,604,283 B（0.81%），展开少21,914,387 B（1.91%）。v3已拆出飞书，因此这不是六平台拆包相对原版的总差额；用户安装插件后其依赖和缓存另占实例目录，不承诺所有插件装全后的总占用减少。

## 历史证据与交付边界

此前飞书首轮产品提交 `ec4b9c82` 的[四平台原生 CI](https://github.com/smilefufu/crabot/actions/runs/42799423129) 全通过；macOS ARM `2026.11.10-cordis.3` 归档 445,003,459 B、展开 1,145,224,541 B，SHA-256 `62d3d51236e80a8cda195e359d4fd2803cf619fd246ea5ff8c98e3d2b75ba259`。实际解包后的正常实例、CLI、国内公开 npm 安装及真实 Agent 合成往返 3/3通过，前后 seal 完整。这是先前范围证据，不能替代本轮六平台验证。

Windows原生回归检出controller与stop并发清理同代际记录的ENOENT误报；确定性回归先失败后修复，运行记录与PID两处只容忍已消失文件，其它I/O错误继续报告；身份/代际/停止期限保持。10项定向、完整退出组29 pass/9 skip及上述四平台原生组通过。

用户已在隔离实例完成飞书扫码并确认流程可用。本轮将实际v8解包程序接回原 `http://127.0.0.1:55885` 数据目录；四个模块running、飞书真实连接、Agent模型ready，整个受管树仅55885监听。Provider/global/飞书配置哈希保持，原生产3000的精确进程身份未变。浏览器确认聊天已同步、已安装Channel(1)只有飞书、新增仅飞书扫码。证据 `/private/tmp/cordis-human-acceptance-v8-20261110.log`，页面截图 `/private/tmp/cordis-human-modules-v8-20261110.png` 与 `/private/tmp/cordis-human-new-channel-v8-20261110.png`。

另用完整归档和纯临时数据在浏览器验证零安装引导、从真实模块按钮安装两个国内公开插件、分类Channel(2)及新增仅显示对应两个平台、Telegram表单无Webhook字段；没有创建账号或调用模型，该测试实例已正常停止。

公开包、完整归档、四平台、最终diff review和页面验证完成，原实例现可进行最终真人收发验收。生产未部署，产品分支未合入；人工验收后才提正式PR，不自行合并。

运行记录 v2 与配套 CLI/桌面一同升级，已移除旧运行入口；残留旧工具拒绝新记录的回归使用原版 `45ac9153` 读取器，拒绝不改记录。正式契约以独立 `crabot-docs` 为准；旧实验 `install.mjs` / `smoke.test.mjs` 不作完整交付证据。不新增停用状态机、强杀期限、自动重发或 HMR。
