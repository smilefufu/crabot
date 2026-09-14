# Worker 执行判断重放

验证的是能否围绕调用方结果推进、辨认限制来源、修复实际阻塞并如实验收；不以拒绝率、工具调用数、测试通过数或完成措辞作为通过标准。Manager 次要验证无效复用后的停止与换新，以及健康执行者和真实权限拒绝两个反例。

## 已确认方案的固定多步验证

`scenarios.json` 固定 12 个场景、基线 `07872f60`、每条件 3 次、每次最多 12 个决策轮次；开发 8 个，保留 4 个。`multistep.mjs` 准备时保存 prompt、Skill 正文、工具 schema、评测器源码快照及相关编译产物哈希；运行前拒绝版本漂移。`runtime.mjs` 使用生产适配器。模型生成的命令不实际执行；Manager 工具会在临时目录执行真实的文档读取、Git 观测和任务板持久化。运行命令：

```sh
node crabot-agent/eval/worker-behavior/multistep.mjs prepare development
node crabot-agent/eval/worker-behavior/multistep.mjs run
node crabot-agent/eval/worker-behavior/multistep.mjs report
```

保留场景使用新输出目录和 `prepare holdout`；一轮修订使用 `prepare revision-development`。`revision-diagnostic` 仅复查已经看过的缺材料和真实拒绝案例，`manager-diagnostic` 覆盖四类 Manager 场景，`manager-memory-diagnostic` 仅补查换新场景；这些候选诊断均不能称为独立保留验证。环境变量与下文相同，固定目的地、模型及请求参数见已确认 spec §7。

`simulation.mjs` 的 Worker 部分是有限回执模型，不是通用 shell 或完整 Worker Harness。未知操作标记 `harnessGap`，驱动立即结束样本为 `harness_gap`，不把未实现能力伪装成工具拒绝交给模型重试。复合命令保留已模拟前缀的回执，未知后缀不执行；真实工具校验错误仍送回模型。

`manager-simulation.mjs` 装配生产 Worker、任务板、项目文档工具及 Memory MCP 桥，使用隔离的任务板、回合存储和 Git 项目。停止受理与停止完成分开，Worker ID、状态、回合及活动游标按执行者隔离；健康任务不注入旧阻塞。记忆搜索只查询隔离空存储，不访问线上 Memory。异步事件在决策边界推进，初次回复不能充当交付证据。

Manager 的 Worker 完成仍是预先编排的外部事件；即使记录了脚本、输入、退出码与产物内容，也不能证明派发正文能在真实 Worker 中执行。固定回执也不能验证任意追加验收要求。Manager 的 `objective_evidence` 保持 null、`delegation_execution_verified` 保持 false；结果读取、汇报、任务板及待处理事件分别保留，人工判断是否完成模拟行为链。`ended`、达到轮次预算和缺测都不直接计为质量通过。

`journal.mjs` 在每次请求前、响应后、工具回执和外部事件后逐条落盘并 fsync；进程中断保留完整记录，尾部断行单列。`report` 区分未开始、中断、请求未返回、轨迹结束与预算耗尽，不重抽已开始槽位，也不自动打行为通过分。

首次批次包含评测器缺陷：Engine 回执字段错误导致本地序列化失败；历史归档版的 `recover-receipts` 只复用这些样本的首条响应和相同回执继续，不重抽 HTTP 失败，当前驱动已移除该入口。随后发现健康任务误带旧阻塞、Worker 状态混用、部分 shell 回执丢失和 Manager 粗略完成标记。原记录和对应哈希快照保留，后续修复不回填旧样本成功；含这些缺陷的轨迹不能承担完整行为验收。修复及追加诊断见 `EVALUATOR-REPAIR.md`。

## 隔离真实执行

`isolated.mjs builtin|claude-code|codex` 经实际 runtime factory 或 CLI adapter 在临时 Git 项目中完成运行、文档纠错和新化身重读。输入来自本地 HTTP 桩服务，不使用业务凭据或 Fusion 项目。保留服务请求、产物、文件内容与原生 trace，真实执行与模拟回执分开报告。

CLI 沿用现有主机连接及适配器权限基线。只通过已有 UI 响应跳过明确的可选升级菜单；不升级、不绕过权限，也不在输入是否已被消费不明时重复粘贴。builtin 沿用 powerful 槽位和原生重试行为，测试截止时仍 running 的轨迹记录为未完成并停止，不能因为已有文件就宣布全流程完成。隔离目录保留供复查；Worker 停止后清理复制的 Codex 连接文件。

本次逐批结论见 `RESULTS.md`。下文是此前单决策历史片段工具，不能与本轮固定多步实验混算。

## 输入与边界

- 六个历史片段来自 bot-2 最近三天的 builtin 原生消息；精确 Worker ID、JSONL 行区间和评判条件见 `cases.mjs`。历史片段不是完整历史，片段中缺失的证据不能用今天的文件补齐。
- 六个 Worker 反事实用例覆盖本地执行、不能删输入凑通过、只读约束、真实权限拒绝、后续要求更新和负向实验结论；另有三个 Manager 用例。
- baseline 从准备时的 `HEAD` 读取，candidate 从工作树读取。实际拼接后的提示词、消息、工具定义和 SHA-256 保存在 `conditions.json`、`plan.json`。评价条件不放入模型输入。
- Provider 由指定实例的 Admin 配置经 `buildConnectionInfo` 解析，保持该实例 powerful 模型与 thinking 配置。`connection.json` 不保存 API key。运行前须确认此次历史、目的地和请求范围已有授权。
- 所有真实工具实现都被替换为抛错函数。模型生成的命令、文件修改、停止、新建和消息发送均不执行。
- 每个请求只有一次机会；HTTP 错误、超时、部分响应、进程中断保留为缺测或不完整观察，不自动重发，不计作任一候选获胜。

## 运行

从主仓根目录运行，环境变量由操作者指定，不在配置中保存机器路径：

```sh
export REPLAY_RUNTIME_ROOT=/path/to/compatible/release
export REPLAY_DATA_DIR=/path/to/instance/data
export REPLAY_OUTPUT_DIR=/path/to/private/new-output-directory
node crabot-agent/eval/worker-behavior/replay.mjs prepare
node crabot-agent/eval/worker-behavior/replay.mjs run
node crabot-agent/eval/worker-behavior/replay.mjs audit
```

`prepare-candidate` 只准备候选，`prepare-manager` 只准备 Manager 双版本，`prepare-selected <case-id> ...` 只准备指定候选用例。输出目录必须是新的；不得覆盖原批次。`run` 可继续尚未开始的槽位，已有 started 但无 result 的槽位保留为中断，不重跑。

`audit` 核对请求槽位、重复请求、完成状态和缺测。它不判断生成的操作是否正确，`quality_passes` 固定为 null。必须另行逐条审查工具参数、命令、任务范围及结果声明。`stopReason=tool_use` 不证明命令有效或任务完成。

## 多轮续办

把人工审阅后的模拟工具回执写入新目录的 `continuations.json`，包含 `mode: "synthetic_tool_receipts"` 和 `jobs`。每项记录 `id`、`previous_output`、`previous_id`、`rationale`、`receipts`；receipt 的 `tool_use_id` 必须与上一响应一一匹配。模拟异步事件放入 `events`，不能用工具受理回执伪造完成。

```sh
node crabot-agent/eval/worker-behavior/replay.mjs prepare-continuations
node crabot-agent/eval/worker-behavior/replay.mjs run
node crabot-agent/eval/worker-behavior/replay.mjs audit
```

回执只覆盖实际请求的操作；参数错误应返回错误，不得伪造成功。未覆盖的分支停止并记录覆盖缺口。模拟回执及其推导理由全部保留，不能称为真实历史执行或真实项目验收。

提示词迭代后接续时，显式记录 `refresh_candidate_manager_tools`（刷新 Manager 正文及真实源工具定义）或 `refresh_candidate_worker_prompt`（同时指定 `workspace`）。原版本输入和响应不变，新目录保存新条件；版本切换前后的结果不得混成同一版本的一次完整轨迹。

## 本轮记录

2026-09-12/13 的私有运行产物位于 `eval/manager-context/out/2026-09-12-worker-behavior-*`，不纳入 Git。首批 Manager 仅有 Worker 工具，缺少通讯工具，不能作为完整 Manager 验收；后续 `manager-full` 使用生产完整内置工具定义。

早期诊断出现两次零 chunk 的 90 秒 TTFB 超时后，另行声明并执行了各一次补测，放在 `v3-diagnostic-retry`，与原输入逐字段核对一致。原失败未改写；补测也没有继续重试。该阶段的结论与保留项见私有 `eval/manager-context/out/2026-09-12-worker-behavior-review/RESULTS.md`，不能代表后续候选已通过。

9 月 13 日候选删除具体错误诊断条款，主控会话改为代码解析并注入两个独立字段。提示词加载器仅新增对 Node 模块 import 的支持，输入用例与工具回执未改变。`2026-09-13-worker-behavior-structured-target` 保存本轮 8 次单决策重放：7 条响应、1 条 502；响应不等于行为通过。最新 diff 和详细局限见私有 `eval/manager-context/out/2026-09-13-worker-behavior-review/RESULTS.md`。

历史回放与短小反事实只能提供当前条件下的证据。builtin 正文不装配给 Claude Code/Codex 的原生系统提示词；第三方平台拒绝、工具故障、消息路由及生产部署效果不由这些重放证明。
