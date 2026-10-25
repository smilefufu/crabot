# 项目工作区基础

此审查边界基于 `feat/desktop-native-foundation`，仅包含已经确认的项目目录登记、稳定 default/project 标识、按目录去重和空间统计，以及只读文件/挂载边界检查。它不改变现有 Worker 创建方式，不接 HTTP、GUI、MCP 或目录授权，也不启动或迁移业务实例。

`WorkspaceCatalog` 只复用 Native 的中性文件锁及私有目录/文件能力。调用方负责业务身份、权限和执行停机证明；catalog 的迁移投影和提交不授予移动文件或退休执行器的能力。空间统计不跟随根外链接，不跨挂载点，把无法测量与成功的零占用区分开。

来源为完整桌面分支 `5a0886e1` 的相同实现/测试。workspace-types 仅取该版本的十二个目录及统计接口，逐字段相同；其余迁移/RPC 类型留给后续依赖批次。正式字段以 [protocol-workspaces](https://github.com/smilefufu/crabot-docs/blob/main/protocols/protocol-workspaces.md) 为准。

独立构建与验证：

```sh
node scripts/build-native.mjs
pnpm -C crabot-shared install --frozen-lockfile --ignore-scripts
node crabot-shared/node_modules/typescript/bin/tsc -p crabot-shared/tsconfig.json
node --import ./crabot-shared/node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 crabot-shared/src/*.test.ts
```

自身 CI 在四个平台使用同一 checkout 冷构建 Native 和 Shared。Linux 的实际 bind-mount 检查只在一次性 CI 的独立挂载命名空间执行，不作为普通用户应具备的权限。
