# Crabot WorkBuddy 三题校准报告（2026-10-28 完成）

按用户再次授权完成原Web和Office；Code直接复用此前有效执行，没有重跑。三个类别均有完整产物、原始评分和本地最终答复。原有失败记录全部保留，未扩大题目范围，全部收费调用已结束。

## 正式结果及口径

| 类别 / 固定题目 | 原始最终分 | 执行已知token | 裁判已知token | 结果 |
|---|---:|---:|---:|---|
| Code / testing-medium-format_errors | 100 | 311,704 | 0 | 原始程序验证通过；26次请求；产物含18项unittest |
| Web / rollout-support-static-page-L2-058 | 80 | 676,109 | 290,434 | 原始12项通过11项，完成条件通过，未达full-pass |
| Office / news-event-multifile-extract-L4-013 | 77.63 | 447,902 | 146,858 | 规则115/169=68.05分，LLM 12/12=100分，原始70%/30%合分 |

原始`compute_job_metrics`对恢复批次（复用原有效Code，Web/Office各保留首次完整完成结果）输出 **reward=0.8588，即宏平均85.88**；full-pass=1/3，完整执行及评分覆盖3/3。本地最终交付3/3。仅为三个固定样本，不是完整200题成绩，也不足以代表Crabot综合能力。

全历史同样保留并经原始metrics聚合：3道题、7次试验，reward=0.5294，即52.94分。它包含此前Provider中断、评测get_message遗漏和0模型调用的容器启动错误。两个口径分别反映有效完成任务的质量与包含基础设施故障的完整运行历史，不删除失败抬高历史成绩。初次停止时的33.33分记录保存在旧报告和旧metrics中。

## 扣分的含义

Web扣20分的理由为“未证明390px移动端搜索减少可见.flag-card”。原始workflow只做通用fill/select，没有记录该项移动筛选结果。独立无模型、无外网、产物只读的Chromium核对：390px下4张卡片输入pilot-a后变1张，PILOT-A仍1张，清空后恢复4张，页面无JS错误。这证明该功能实际可用，扣分包含上游采证覆盖不足；**保留原始80分，不用额外检查替换或重抽裁判结果**。

Office的规则扣分包括3条预期事件未抽取、实体/来源覆盖及合并来源计数偏差。LLM rubric主要检查当前产物的一致性、别名区分和来源可追溯，12项都通过；它不能替代规则对预期事件覆盖的检查。原始权重为rule 0.7、LLM 0.3，综合77.63。

## Overloaded、usage与接入修复

1. **Provider确有过载且会缺报失败用量。** 修复后Office真实请求`598c966e-46ee-4e31-a758-1d52842861ac`返回HTTP200/SSE，发出upstream_error/overloaded后正常EOF；完整361字节无usage、无DONE。生产适配器将该SSE错误归为HTTP502。原生下一次尝试正常返回11853 token并继续Worker，未重开整题。
2. **旧评测也有缺陷。** 消费侧遇错cancel时连带取消上游，可能丢失稍后到达的usage；计量器又把首次失败设成全局fatal，拦住生产第二次尝试。无费用fixture复现了“本可收到17+3 usage尾包，却因cancel被丢弃”。历史两条失败没有完整EOF，不能倒推是否也有尾包。
3. **修复保持生产机制。** 独立tee审计分支读到EOF，记录HTTP状态、request ID、字节摘要、错误和usage；可重试错误不再提前截断。原代码对这类502最多6次尝试、约1/2/4/8/8秒退避；网络/流中断另有5/10/20/40/60秒持续恢复。本轮没有修改生产分类或增加评测重抽层。
4. **计量与停止。** 有usage就按原生输入+输出实记，缓存/推理不重复相加；真正无usage的请求各预留10M，仍从同一120M扣除。正常完成却缺usage、计费/鉴权错误、未知RPC或预算不足仍停止。新增HTTP402停机回归，避免无明确code的余额错误落入通用重试。
5. **评分文件保存也已修复。** 原始Office CompositeVerifier已返回0.7763，但额外下载容器日志覆盖了宿主最终score.json，留下0.6805规则分。现在原始容器日志写入`container-verifier/`，保留原生宿主合分文件。原始文件不覆盖；用保存的规则与十二条原始LLM判定调用固定版本原始finalize_score/ArtifactWriter恢复canonical副本，并断言reward payload与最初Verifier返回逐字段相同，零新增模型调用。

曾尝试严格请求SHA匹配的零模型缓存回放：8次命中、15次未命中，未启用Provider fallback，输出只作接线诊断，不作新的Agent成绩或最终判定；完整保留在`office-score-replay/`。最终canonical恢复使用原始判定，未采用该回放的任何分数。

## 用量、额度和下一批估算

共127次真实Provider请求：124次有usage，3次未知。**全部已知1,978,930 token=1.978930M**，包括历史失败、诊断、执行及裁判。Manager876,005、Worker647,216、裁判437,292、原生HTTP取证18,417。已知输入1,920,032、输出58,898；缓存和推理为子集，不额外加总。

3次未知分别是首次Web请求、首次Office第8次请求、恢复Office首请求；各预留10M，共30M。这不是实际已用token。已知量+保守预留合计31.978930M，占120M额度约26.65%；未知账目意味着精确实付总量尚未核对，未把未知按0计费。

三个有效任务执行加裁判共1,873,007已知token。仅按本次单样本粗估，30题（每类10题、复用这3题）全轮约18.84M已知token；加当前30M预留约48.84M。按80 Code/70 Web/50 Office外推200题约122.44M已知token，尚未计未来异常及尾部，不能承诺控制在120M内。建议后续先扩大到30题并持续校准；**本轮未自动开剩余27题**。

## 验证、固定条件与证据

15项Node无费用回归通过，另有1项Python无Docker/无模型回归验证综合评分不被覆盖。原c6d240c基线与当前main的真实UnifiedAgent脚本回放验证了过载后原生重试、普通消息来源、固定权限、Worker目标、真实文件和Manager本地投递。仅评测代码变化，未部署、重启或修改生产提示词/模型/权限/输出上限。

生产基线`c6d240c94f566b3f73a402ce79a8858bc0632413`；WorkBuddy`b516950be5b56eb3be406c2f76ee1c5111dcb57f`；公开数据`3e8ad839685c589d83a1dd60fe2d15eabb75f27a`；当前powerful模型gpt-6.1-sol/high。裁判也使用该配置，与论文Gemini裁判有差异，不能作同条件排行榜比较。标准tmp-page Skill、本地收件箱、空私有历史，无业务MCP及child profile；amd64任务在ARM Docker主机模拟运行，时间不可与原生x64直接比较。

证据位于既有忽略目录`crabot-agent/eval/manager-context/out/2026-10-28-workbuddy-calibration/`：
- 旧Code产物与评分、旧Web/Office失败、旧报告与metrics全部保留。
- `wire-diagnosis-20261028/`：两条原生HTTP取证及完整SSE，共18417 token。
- `recovery-20261028/web/`、`office/`：本轮执行、产物和交付；artifact-sha256.json冻结产物。
- `web-score/`、`office-score/`：原始裁判与逐请求用量；Office原始result.json已包含0.7763。
- `office-score-canonical/`：原始组件恢复的正确合分文件及输入SHA、原始返回一致性证明。
- `mobile-search-audit.json`：独立只读移动筛选检查，分数未变。
- `valid-upstream-metrics.json`、`all-history-upstream-metrics.json`、`final-summary.json`：两种统计与统一用量。
