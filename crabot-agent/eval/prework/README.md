# 无意义前置检查的受控重放

比较已冻结基线与当前候选的主控、执行器核心及项目指南。六组人工场景覆盖主控交接、已有执行方法、只读源码问答、动态统计，以及必须核实当前归属、上次写入结果未知两个边界。每组两版各两次，共24条轨迹；主控案例继续运行其实际生成委托对应的执行器。

使用产品实际提示词装配与工具定义。Manager 使用与场景有关的工具子集，不运行完整 ManagerLoop；Worker 使用内置文件、Shell、Skill、后台与 guidance 工具定义，不包含外部 MCP 或子 Agent。所有工具回包由人工场景模拟器提供，绝不执行模型生成的 Shell、生产操作或消息投递。模拟器回归覆盖批量命令、当前归属、交易匹配和保存顺序。

先构建 Agent 并执行 `node --test crabot-agent/eval/prework/fixtures.test.mjs`。指定 `REPLAY_OUTPUT_DIR` 后运行 `node crabot-agent/eval/prework/replay.mjs prepare`，冻结场景、提示词、工具定义、基线提交、顺序及脚本 hash。可通过 `REPLAY_BASELINE_REF` 指定基线；后续 run 使用冻结提交，避免提交候选后改变基线。

真实调用前必须取得覆盖目标服务、模型、完整提示词/工具定义、场景与调用上限的授权。设置 `REPLAY_ALLOW_EXTERNAL=yes`、`REPLAY_DATA_DIR`、`REPLAY_RUNTIME_ROOT`，再运行同一脚本的 `run`。连接通过 `ModelProviderManager.buildConnectionInfo` 解析，临时私有副本销毁，不修改生产配置，不将密钥写入输入或结果。

最多每条16次请求、合计384次请求。若有被弃用的先行批次，prepare 时通过 `REPLAY_PREVIOUS_REQUESTS` 计入总上限。已开始的批次禁止原地重跑；API错误、截断、未完成以及模拟器缺口保留原始记录，不作为模型失败，也不算完成。

评估必须人工核对原始工具输入、回包、最终回答与状态。`goal_verified` 仅为模拟状态判定；不能代替对回答准确性的审查。`unnecessary` 表示调用中出现无需依赖的检查，混合了有效动作的 Bash 不代表整次调用都浪费；`first_effective_call` 是场景定义的有效动作序号，不是线上开工延迟。不以调用数、文本长度或 `completed` 单独判断效果。没有重现旧行为或缺失配对样本时，只报告对应限制。

2026-10-20 结果见 [results-2026-10-20.json](results-2026-10-20.json)：局部改善，主控交接仍有反例；网络缺失、首批模拟器作废与请求总量均单独保留。

已知模拟边界：该脚本不是 Shell 解释器，命令替换（如 `x=$(...)`）和子命令 `--help` 不能可靠模拟，自动 `fixture_gap` 也未完全覆盖。2026-10-20 人工复核已剔除这两类污染轨迹及其配对，未重跑或将模拟器报错归为模型失败。今后复用须先处理这些边界。
