# 工具族加载重放

对照 2026-09-19 改造前的固定源码 `c4a7dd87` 与候选构建，使用实际 Manager 工具装配。
业务 handler 的 RPC 一律禁止执行；只允许本地发现和静态 guidance，所有业务结果为模拟值。

先分别构建基线与候选，再从候选仓库运行：

```bash
FAMILY_BASELINE="$BASELINE_WORKTREE" FAMILY_OUTPUT="$REPLAY_OUTPUT" \
FAMILY_ENDPOINT="$REPLAY_PROVIDER_ENDPOINT" FAMILY_MODEL="$REPLAY_MODEL" \
node crabot-agent/eval/tool-families/replay.mjs
```

默认只运行 9 个离线场景、输出 `offline.json`，并固定 `plan.json`，不读取凭据或联网。
离线变体显式指定族，因此只证明路径成本，不证明模型自主选择；原查询按固定 limit 重放。
服务配置、模型、路径均由环境提供，不从私有历史提取场景。

只有对具体目的地、模型、载荷和请求上限取得授权后，才追加 `--live`，并提供
`FAMILY_RUNTIME`（运行配置解析器所在源码根）、`FAMILY_DATA`（运行数据目录）。
使用 Admin 现有 buildConnectionInfo 解析配置，必须与固定 endpoint/model/format 一致；不记录凭据。
每次实际运行使用新的结果目录；已有事件日志禁止覆盖。Provider 请求失败单独记为缺测，无自动重试。

模型对照为 7 个合成场景、两版各一次，交替前后顺序，每条最多 7 轮、共最多 98 请求，
800,000 已报告 token 后不再发新请求。每次请求记录实际工具面、原始响应及 usage。
只验证工具发现和模拟目标工具选择，达到目标即停止；不验证真实业务副作用或最终投递。
只有目标名字被选择仍不等于参数/业务正确，结果须人工核对输入与场景要求；未通过的结果不得纳入节省汇总。
相同模板、单次抽样和模拟返回不能证明线上总体收益，也不能从目录加载动作直接推算真实 LLM 轮数。

参见 [本次结果](RESULTS.md)。
