# WorkBuddy 端到端基线

本入口只测当前生产 UnifiedAgent 的普通人类请求 → Manager → builtin Worker → 实际产物 → 本地渠道答复。标准配置只包含 tmp-page Skill，不连接业务 MCP、不带用户私有历史和子 Agent profile；这是隔离基线，不代表全部个人生产配置。

依据文档仓 `2026-10-28-crabot-workbuddy-baseline-design.md`，首批只执行冻结的三题校准。用户批准的整体总预算为 120M token，包括所有模型、缓存输入、执行、裁判和重试。三题后暂停，不自动扩量。

## 准备与验证

- 固定 Crabot 基线、WorkBuddy 源码 `b516950be5b56eb3be406c2f76ee1c5111dcb57f` 和数据 `3e8ad839685c589d83a1dd60fe2d15eabb75f27a`，校验官方 SHA256SUMS。
- 按原始 task Dockerfile 构建 amd64 镜像；环境在 ARM 主机上经 Docker 模拟运行，时间结果不能与原生 x64 直接比较。
- `node budget.test.mjs` 应用 Node test runner：`node --test budget.test.mjs`。
- `node build.mjs "$BUILD_DIRECTORY"` 打包实际生产源码及 tmp-page，输出不包含运行凭据。
- 题目镜像另加 Linux 版 ripgrep、iptables、util-linux 和打包文件。`launch.sh` 作为入口，启动时只放行原生 Provider IPv4 的 443 出站及 loopback，禁用 IPv6、代理环境及 DNS 出站，随后撤销所有 capabilities。文件、进程和项目上下文均在容器内原生执行。
- `node check-smoke.mjs "$WORKBUDDY_OUTPUT"` 检查真实产物、普通消息来源、权限快照、Worker归属、消息查询及最终投递。
- `--smoke` 使用脚本化 HTTP 响应，走真实 SDK、工具、权限和投递链路，无收费模型；检查真实文件、任务来源、固定权限、目标和 Manager 消费结果后的答复。

## 收费执行

只有用户已批准明确任务范围和预算后才可使用 `--live`。必须提供以下环境变量：

- `REPLAY_DATA_DIR`：已授权实例的数据根；只读取模型引用、当前配置并由 Admin buildConnectionInfo 解析。
- `REPLAY_RUNTIME_ROOT`：含已构建 Admin 和 Agent 的源码根。
- `WORKBUDDY_OUTPUT`：本次全新的输出目录，不覆盖既有轨迹。
- `WORKBUDDY_TASK_ID`、`WORKBUDDY_INSTRUCTION`：冻结清单中的题目 ID 与原始指令。
- `WORKBUDDY_TIMEOUT_MS`：原始题目 agent timeout 乘已确认的 2 倍，与 Harness² 环境口径一致。
- `WORKBUDDY_PRIOR_TOKENS`：本次评测此前各执行/裁判的累计 usage，不得在每题归零。

```sh
node run.mjs --live "$TASK_IMAGE"
```

入口明确当前工作目录为 `/workspace`，除此之外不向模型提供评分提示。密钥只经私有 stdin 进入容器内存，不在环境变量、命令参数或结果文件中保存。Provider 原生端点、schema、SDK、输出限制和 high 思考配置沿用已确认实例。每次请求记录来源、配置、请求及 usage；缓存和推理不重复计数。请求串行准入，保留 10M token 的在途余量；这一准入余量不改变单次模型输出上限。观察器以独立分支读完整响应至EOF，记录响应状态、摘要和usage，不受消费侧遇错cancel影响。每个无法核对的请求单独预留10M并从总额度扣除；可重试错误让产品原有重试继续，网络长恢复也不被观察器截断。正常完成却缺usage、计费/鉴权错误、预算不足或未知RPC边界仍停止，不换账号、不额外重抽。产品每次原生尝试均计量。

## 原始裁判

`verify.py` 在 Agent 完全退出后创建另一个题目容器，才装入 tests/评分材料及被评产物。它调用固定版本原始 CompositeVerifier；没有重写 rubric、权重、阈值或证据提取。Code 不需要模型；空产物与原始 oracle 分别验证评分链路。

Web 的原始裁判含 CBC Agent（固定 `@tencent-ai/codebuddy-code@2.109.3`）、LLM 和 VLM；Office 还有宿主 LLM rubric。它们使用 `judge.mjs` 提供的仅供基准裁判的临时计量端点；Crabot 自身仍直连原生 Provider。该端点只接受随机运行凭据，原始 Provider key 不进入裁判容器。裁判仍沿用当前 powerful 模型及思考/输出配置，不沿用另一类模型的低输出 cap。此配置与论文 Gemini 裁判不同，必须在报告标明；不宣称同条件排行榜结果。

```sh
node judge.mjs --task-dir "$PINNED_TASK_DIRECTORY" --image "$VERIFIER_IMAGE" --workspace "$AGENT_WORKSPACE"
```

另需 `WORKBUDDY_JUDGE_OUTPUT`、`WORKBUDDY_PYTHON` 和完整的 `WORKBUDDY_PRIOR_TOKENS`。裁判请求也计入相同 120M 预算。单条已知边界失败保留原始分数与原因，不通过重抽或修改 rubric 修饰结果。

结果必须分别报告各类原始分、full-pass、已启动/已评分覆盖率、本地交付结果、输入/缓存/输出/推理用量、错误和环境差异。提前结束、Worker 自报与存在文件都不构成完成证明。120M 是批准的整体额度；每次10M未知预留是保守账目，不是实测费用。可重试失败缺usage时，先单独留额，再由原生机制决定后续尝试；正常响应读到EOF仍缺usage、计费错误或预算不足必须停止，不把未知伪造成已知消耗。

历史首次恢复授权（本轮已结束，当前以末段再次授权为准）：保留 Web 首次 SSE-502/缺 usage 记录，为该请求在原120M内单独预留10M；此预留不计作实测已用。恢复入口设置 `WORKBUDDY_UNKNOWN_RESERVE=10000000`，并按 `WORKBUDDY_PRIOR_TOKENS` 传入所有真实已知用量。预算同时扣除已知用量和未知预留，再为在途请求保留10M。Web只恢复一次，之后Office；再次缺usage即停，不重跑Code。

2026-10-28 再次授权：先诊断并修复接线，再完成同一Web/Office，Code不重跑，历史失败全部保留。两条历史未知各预留10M（共20M）；两条原生HTTP诊断共18,417 token纳入已知累计，续测起点为417,627。`WORKBUDDY_SMOKE_RECOVER=1` 模拟首次overloaded再成功，验证原生重试、独立预留和真实交付。运行 `node --test budget.test.mjs observe.test.mjs judge.test.mjs` 验证预算、EOF观察和无真实凭据的裁判HTTP转发。

评分产物：`verifier/score.json` 和 `reward.json` 保留原始CompositeVerifier宿主最终合分结果，`container-verifier/` 另存容器原始规则日志，避免下载覆盖综合分。用固定基准Python运行 `python -m unittest discover -s crabot-agent/eval/workbuddy -p verify_test.py` 验证保存顺序（无Docker/模型）。HTTP402计费失败会显式关闭评测准入。
