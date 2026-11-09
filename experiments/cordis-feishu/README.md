# Cordis 飞书独立验证

本分支的飞书只有 Cordis 插件入口，不再继承 ModuleBase、监听 Channel HTTP 端口或注册到旧 MM。现有主分支的发布实例不受影响。这里的宿主只验证进程内收发与一个 Web 监听，不替代生产 Admin、Agent 或鉴权链。

## 已实现

- 复用原飞书业务方法，通过 `channel.methods` 进程内调用；入站仅发布原始 `channel.message_received`，保持平台身份和 Session。配置、输入及结果保留各自对象所有权。
- 插件实例分别保存账号、ID、数据和连接；Cordis 加载失败及卸载清理本实例的既有连接、定时器，不引入 Agent 任务取消或自动补发。
- Admin Web 添加飞书只保留现有扫码入口；旧手填链接转向同一扫码流程。已有配置、扫码后的授权/事件订阅指引和其它平台保持。
- npm 发行包只内置尚未独立发布的 `crabot-shared` 编译产物，并声明其运行依赖；飞书 SDK 固定为基线已测的 1.62.1。宿主提供 Cordis 4.0.0-rc.12。

## 复现

使用 Node 22.22.3，在仓库根目录执行；所有安装源均显式指定，测试不需要真实账号。

```sh
pnpm --dir crabot-shared install --frozen-lockfile --ignore-scripts --registry=https://registry.npmmirror.com
pnpm --dir crabot-shared run build
pnpm --dir crabot-channel-feishu install --frozen-lockfile --ignore-scripts --registry=https://registry.npmmirror.com
pnpm --dir crabot-channel-feishu run build
pnpm --dir crabot-channel-feishu exec vitest run --maxWorkers=1 --minWorkers=1
VALIDATION_ROOT="$(mktemp -d)"
node experiments/cordis-feishu/pack.mjs "$VALIDATION_ROOT/artifacts"
node experiments/cordis-feishu/install.mjs "$VALIDATION_ROOT/installed" "$VALIDATION_ROOT/artifacts/crabot-channel-feishu-0.1.0.tgz"
CORDIS_INSTALL_DIR="$VALIDATION_ROOT/installed" node --test experiments/cordis-feishu/smoke.test.mjs
node --test experiments/cordis-feishu/install.test.mjs
```

`install.mjs` 也接受精确的 npm 包名与版本；当前未发布，所以验收使用本地 npm tarball，SDK 等依赖由国内 registry 实际下载。默认 `https://registry.npmmirror.com`，逐次传给 npm；独立 user/global config 与缓存，不修改用户全局 npm 配置。只允许写入新目录；失败删除本次新目录，已有安装不被覆盖。核对 lockfile resolved 和 npm 实际 HTTP 下载域名，国内源允许同属镜像的 `cdn.npmmirror.com`，不自动回退国外 registry。包导入成功后才报告安装成功，连接健康仍需另行判断。

smoke 测试从 npm 安装目录加载真实插件，用模拟飞书平台完成两实例收发与两次宿主启动；主动禁止 outbound socket/fetch。只有宿主的一个 loopback Web 监听，插件没有监听端口。这个测试不能替代真实飞书长连接、扫码真人授权或整个 Crabot 的端到端验收。

## 结果与限制

见 [evidence.json](./evidence.json) 中的运行环境、测试、下载源及包体积。npm 插件 tarball 大小与安装完成后的依赖体积分别记录；正式安装器尚未改变，不能据此报告主安装包已缩小。没有 npm publish、部署、付费模型或真实消息发送。

未纳入：旧 MM 适配、生产 Admin/Agent 同进程接入、其它 Channel/Memory、生产下载 UI、默认预装策略、HMR、升级回滚、完整离线安装、跨平台原生资源和大陆实网可达率。现有关闭行为不保证任意在途任务排空；需要生产化时再按具体场景设计。
