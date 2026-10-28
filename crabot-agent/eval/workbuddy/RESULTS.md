# 2026-10-28 WorkBuddy 校准：三题已尝试，一题有效完成

已停止全部收费调用。用户批准总额度120M token（800M日常用量的15%），先测Code、Web、Office各一题；首次Provider缺usage后，用户另明确批准原额度内保留10M未知预留、只恢复Web一次再Office。第二次Provider缺usage后没有再恢复，也没有追加其他题。

| 类型与题目 | 原始运行得分 | 有效性与失败归因 | 已知token |
|---|---:|---|---:|
| Code / testing-medium-format_errors | 100 | 完整端到端执行、原始verifier通过、本地答复交付 | 311,704 |
| Web / rollout-support-static-page-L2-058 | 0 | 首次Provider SSE 502且无usage；获批恢复在get_message评测边界遗漏处中断 | 23,697，另1次未知 |
| Office / news-event-multifile-extract-L4-013 | 0 | Worker已启动，第8次请求Provider SSE overloaded且无usage，停止 | 63,809，另1次未知 |

**上游原始metrics结果：reward=0.3333，即33.33分；有效完成并判分覆盖率为1/3。这个运行分包含Provider和评测环境错误，不能当成Crabot综合能力分。** 已启动但缺少score.json按原始WorkBuddy规则计0，没有剔除失败抬高均值。Web另有一次入口权限启动错误（0次模型请求）也保留；因此metrics共记录5次试验、3道题。官方`compute_job_metrics`直接读取原始Code score.json及其余真实失败result，不伪造verifier分数。

## 用量与预算

37次真实请求中，35次有Provider原生usage，2次用量未知。已知合计399,210 token，即0.399210M；其中Manager264,354，Worker134,856，裁判0。输入388,333（含缓存290,432）、输出10,877（含推理4,727）；缓存与推理为子集，不重复相加。已知量约为120M额度的0.333%，但两条未知账目意味着不能声称精确实付总量已核对。

首条未知请求的获批10M预留与已知消耗分别记账，从原120M共同扣除；它不是实测消耗。第二条未知请求出现后立即停止，未增加收费裁判或后续题。没有更改Provider、账号、思考配置或模型输出上限。现在不能用一题成功和两题中断可靠外推30/200题总成本。

## 已验证内容与限制

Code使用26次请求：Manager9次、188,249 token；Worker17次、123,455 token。原始reward=1.0/full_pass；原始tests_passed=1/tests_total=1是聚合评分单位，不等于只执行一个用户测试。最终产物新增18项unittest，原始程序评分检查了实际文件，Manager消费Worker结果后向本地收件箱交付答复。此成绩只证明这一道题。

Web的评测接线存在两处遗漏：更新镜像入口丢失执行权限，以及本地Channel缺少get_message。入口权限已修复并无网络检查；get_message对照Channel协议补齐，并以脚本模型走真实消息工具、文件与交付链路通过无费用回放。恢复消耗23,697 token及原始失败均保留，没有在修复后追加重跑Web。Office使用修复后的边界，运行到Provider失败。真实LLM/VLM/CBC裁判尚未运行，因此不声称Web/Office裁判已验收。

验证通过：5项预算回归（包括未知预留不伪造成已知量）、正常生产链路脚本回放、get_message回归、SSE-502单请求后停止及原始错误保留、裁判脚本语法。原始Code空产物0分，自带oracle66.67分；Office空产物程序评分0分；Web缺裁判路由明确报错。未修改原始rubric、权重、阈值、生产提示词或部署。

## 固定条件与证据

Crabot源码`c6d240c94f566b3f73a402ce79a8858bc0632413`；WorkBuddy`b516950be5b56eb3be406c2f76ee1c5111dcb57f`；数据`3e8ad839685c589d83a1dd60fe2d15eabb75f27a`。模型为当前powerful `gpt-6.1-sol/high`。实际UnifiedAgent/Manager/builtin Worker与原生工具，普通人类消息入口；本地渠道，无私有历史，标准tmp-page Skill，无业务MCP与child profile。Linux amd64题目在ARM Docker主机模拟执行，时间不与原生x64比较。Agent执行期间没有tests/solution、宿主业务挂载，网络仅放行Provider IP的443及loopback。

私有逐请求证据、产物、原始评分、失败现场、原始metrics及SHA256摘要保存在主工作区既有忽略目录`crabot-agent/eval/manager-context/out/2026-10-28-workbuddy-calibration/`。`summary.json`按试验保留角色用量和未知请求；`upstream-metrics.json`为官方聚合器输出。下一步需先解决Provider稳定性与缺失usage，再决定是否重新授权恢复；当前不继续收费。
