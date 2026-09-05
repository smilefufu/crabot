# Crabot 项目进度

> 最后整理：2026-09-05
> 本文件只保留当前状态、明确 follow-up 和阶段性里程碑；详细实施流水、逐轮 review 与历史测试输出见 Git 历史。压缩前完整版本可用 `git show 49b9cb4:PROGRESS.md` 查看。

## 当前状态

### 模型目录刷新兼容缺省上下文长度：已修复

- OpenAI/Codex 模型目录缺少上下文长度时省略 `context_window`，避免 `undefined` 导致配置指纹
  计算异常并返回 500；已有数值和字段别名优先级保持不变。回归覆盖真实指纹、落盘和重复刷新。

### send_message 缺 channel_id 的确定性修复改为来源登记：已合入（PR #141，main `c8311d58`）

- 已将发送时的 Channel 枚举与逐实例 `get_session` 探测替换为当前 Manager 的运行时多值索引：
  成功的结构化 messaging 结果登记 `session_id → Set<channel_id>`，缺参发送只做本地查询；
  唯一命中或当前 Manager Channel 可消歧时补全，其余继续原样透传。
- 索引不持久化、不跨 Manager 共享，也不作为权限或当前可路由性的事实源；Loop 回收或 Agent
  重启后自然清空。raw MCP 仍要求显式 `channel_id`，内部观察元数据不进入工具结果。
- 正式协议 crab-messaging v0.3.7 与修订 Spec 已先行发布（crabot-docs `b725b1c`）。

### Agent Engine 自适应增量上下文压缩：已合入（PR #139，main `9be4c5fd`）

- Manager 与 builtin Worker 已共用 Engine 单一批次算法：按当前模型窗口的 80% 规划完整摘要请求，
  遇摘要截断或 Provider 上下文超限自适应缩批；成功批次不回滚，调用方各自保留持久化与生命周期语义。

### Manager 任务板 Admin Web 共管：开发完成，待 PR 审查

- 已按确认 spec（crabot-docs `a17871e`）实现会话列表的任务板入口与独立任务板页面；人类可查看、
  新建、完整编辑或归档当前任务项，并可查看 archive 终态快照。页面以整板 revision 保存，冲突后保留
  本地草稿并提示重新核对。
- Admin 写入经短期一次性 assertion 和 `callSensitive` 核销后才由 Agent 原子落盘；同一次保存持久化
  revision、Manager 必读栅栏、权限快照和待投递系统提示。Manager 读取受影响事项后才能再修改，避免
  人类与 Manager 的静默覆盖。
- 系统提示仅提醒 Manager 主动查阅最新任务板，不携带任务板正文，也不写入会话历史或 episode log；未消费
  提示可在 Agent 重启后恢复投递，连续保存只保留最新通知。会话列表始终返回任务板摘要（正常或 unknown）。
- 验证：Agent 定向 148/148、Admin API/assertion 6/6、前端 17/17 与生产构建、共享敏感 RPC 111/111；
  无网络只读 Docker 确定性评测 13/13。所有测试数据与报告均使用临时目录，未访问本机部署或 LLM 凭证。

### Manager 会话任务板与项目文档共享：已合入（PR #138，main `ab275c14`），边界收口验证完成

- 已确认并发布设计、计划及正式协议（crabot-docs 初版 `753c922`，边界修正 `500a030`）：每个 Manager
  会话一张支持多任务的轻量任务板；任务项以可独立理解的标题和完整当前快照作语义区分，不暴露 ID、
  优先级、修订理由、Worker 关联或决策链接。任务板不自动注入 LLM 请求，也不镜像到 Memory。
- Manager 新增 `inspect_workboard` / `change_workboard` 与 `inspect_project_docs` /
  `manage_decision_doc` 四个窄工具。项目文档工具按当前 episode 原始唤醒主体和 Worker workspace
  实时授权；项目路径、任务板内容和历史会话身份均不能授予访问权。
- `AGENTS.md` / `CLAUDE.md` 规范化为长期相对软链接的一份正文；双缺失保持 absent，历史双正文冲突
  fail loud，仅迁移有私有记录证明所有权的旧 bridge。builtin 注入不可变快照，Claude/Codex 使用
  原生文件发现；revive、fork、handoff 的新化身读取最新正文。
- Manager 提示词只保留一段简明的任务板使用规则；任务板和决策文档由 Manager 直接维护，Worker 只
  查阅决策文档并返回证据；无关任务必须使用新 Worker，要求变化时向仍相关 Worker 发送完整新要求。
  项目/任务偏好进入决策文档，只有跨项目、跨任务长期适用的通用偏好进入 Memory。
- 在 `c8311d58` 基线上重新构建验证：TypeScript 编译通过，定向测试 20/20，Docker 确定性评测
  13/13；`mirror-xinshu / gpt-5.6-sol` 真实行为评测 105/105，八个场景均 3/3，共 171 次脱敏 LLM
  请求且无请求错误。报告未包含 API key、Bearer 凭证或宿主绝对路径。
- 后续 main `79d2ab36` 将执行器派发与任务板建项、查询彻底解耦：建项只看人类事项是否需要后续持续
  管理，派发、改派或续办执行器本身不构成建项或查板理由。该次只修改提示词与工具说明，按人类明确
  决定未重复运行评测；正式协议已同步为 agent-v3 `3.9.1`。

### 事件面收敛（kind 粒度=处置规则粒度，一次物理事实一次唤醒）：已合入（PR #137，main `83da131a`）

- spec `2026-09-01-event-surface-convergence-design`（#136 follow-up ①）；协议 agent-v3
  3.8.0 先行（§4.1/§5.5.3/§5.5.4/§6.3/§9.2/§10.1）。五阶段：P1 唤醒/审计两档成文 +
  删 input_held 死代码；P2 生命周期五 kind 折叠为 `lifecycle_changed{change}`，
  interaction_required/liveness_stall 独立；P3 停止单回执 `operation_settled`（携带落账后
  task_status，首投固化重投读回；stop_verified/死信降审计；补现网缺口 stop unknown 无 bg
  → halted(stop_unverified)）；P4 崩溃单醒 `worker_recovery_required`（投递前校验，已处置
  不唤醒）；P5 回合单通知——enriched `turn_completed`（detail 并入 to/text/summary + 事件级
  task_status）为完成回合边界唯一唤醒，同拍 state_changed 让位，持久化失败回退补发。
- review 修复（`8c2687b3`）：markCrashed 判死降审计改为以「真建了 recovery notice」为条件
  ——停止残局（handoff 第 2 步后重启 / stop unknown 有 bg 的 op settle 后重启）建不出
  notice，无条件降审计会让该次崩溃零唤醒零 §9.2 推送、任务永久静默。
  routeOperationNotification 非 activity 通知补 origin 注入（trigger_type/task_id/outcome，
  prompt 记忆候选判据依赖）。
- **follow-up**：①Admin WorkerDetail `lifecycleActivity` 补 turn_completed 分支（回合边界
  现掉进 technical 列表）；②handoff 内部 supersede stop 的 operation_settled 仍唤醒——
  「一次 handoff 一次唤醒」未完全达成，加免通知标记需走 spec；③operation_settled 首写
  task_status 是投递时现读而非结算时刻钉值（理论窗口，需存进 op 记录，走 spec）；
  ④processStateChange crash 降审计按 recoveryNoticeCreated 对称收口（一行，当前不可达）。

### 任务状态机缩水为 4 态 + manager 停止监督修正：已合入（main `d6a76609`，PR #136）

- 引线：worker `finish_task` 停止后 manager 15/15 零处置，任务静默最长 6 小时直到人类
  追问（trace 核实：turn_completed 唤醒投递准时无丢失）。根因：builtin finish_task 的
  **自报** outcome 被 harness 提升为任务终态 `completed`（协议旧文背书"确证"），监督按
  设计对终态解除武装——系统把可确证的事实（化身退出+自称完成）越权升格为无法确证的
  判断（任务达成）。
- 修正（协议先行：base-protocol 0.2.4 / agent-v3 3.7.0，docs `bb679c9`）：
  TaskStatus 6 态→4 态 `queued/running/halted/closed`——worker 行为只产生事实边
  running⇄halted，停因与自报进 `TaskHaltEvidence` 标注（halt_reason/worker_self_report/
  detail）；`closed` 唯一终态仅 manager/admin 处置产生；`reviveTask` 接续例外退役；
  `finish_task` 自报不再产生终态。存量台账读路径归一迁移（fail-soft+回写）。
- manager 侧：事件渲染结构化（`<crabot-event class=content|blocked|review|info>`）+
  system prompt"你的对话对象是 crabot 系统"心智模型段与四类处置规则（内容类
  "沉默不是合法完成形态"、"自报不等于完成"两要件成文）。弃权防线=prompt 引导
  （机制兜底按用户决策不做，复发时再议）。
- review 4 轮 12 条全部处置：存量台账迁移、periodic_report 在 halted 不被 probe 短路
  吞没、stop 核验 unknown→halted(stop_unverified)+bg 存活保持 running、halted 停因
  有向升级（haltSeverity，良性不得抹掉严重）、stop_verified 处置回执归 info、
  liveness_stall 归 content、admin/web 枚举与 Master Chat 图标同步。
- **follow-up**（spec §11，docs `1a8dbba`）：①worker home 7 天 GC 判据（halted 不再自动
  回收，候选方案需单独 spec 决策）；②机制兜底（弃权复发时的首选方案）。
  （原①事件面收敛已完成，见上方 PR #137 段）

### manager 入站图片视觉注入（P7 拆分能力回退修复）+ get_message 媒体字段：已合入（main `29a25d08` + review 修复）

- 引线：用户 feishu 发图，manager（VLM）回复"媒体句柄解析失败"。trace 定位：channel
  下载/落盘/envelope 渲染全部正常，manager 装配层把图片拦成纯文本标记——P7 拆分时
  worker trigger 流的图片注入（`82f890bd` 首修）没搬进 manager envelope 装配，违背拆分
  spec「差异是策略差异不是机制差异」决策（2026-07-28-manager-worker-agent-split-design §4）。
- 修复（main `29a25d08`）：`manager/image-vision.ts` 注入机制——state 只存轻量图片引用
  `imageRefs`，episode 输入构造时读盘转 ImageBlock；`get_message` 透出
  media/media_url/file_path/handle/status（协议 crab-messaging v0.3.5 随补，docs 直推）。
- codex review 定性 5 条，修复 4 条：P1 base64 随 finalMessages 回写 recent/episode log
  → 注入改为仅 LLM 请求投影，收尾按 originals 映射还原后落盘（回归测试断言落盘无
  base64）；P1 collect 只认 media[] → 补齐遗留单图 media_url/file_path 形态（feishu
  普通单图走 file_path，标记 label 与 formatMediaRef 渲染同源，含完整路径形态）；
  P2 协议未同步 → v0.3.5；P2 读失败一律报"已清理" → 中性措辞「文件不可用，无法查看」。
- **插话带图（第二轮 review P1，用户拍板必修）**：episode 运行中人类插话（turn 间
  drain 注入）带图时原来只有文本标记。engine 侧 `HumanMessageQueueLike.drainPending`
  返回类型本就是 `string | ContentBlock[]`（query-loop 消费点原生支持，零改动）——
  修复全在 manager 侧：`TimedWakeMailbox.drainPending` 对带图插话同步读盘构造
  ImageBlock（远程 URL 同步无法下载，当轮降级为文本标记）；收尾拍平还原规则覆盖
  drain 产物（数组 content 取 text block 原文，base64 不落盘）；`commitPendingHumanInputs`
  补记 imageRefs（按渲染文本里 platform_message_id 属性定位 drain 消息 id），下一
  episode 幂等重注入。协议 v3.6.19（agent-v3）随补。
- **插话远程 URL 预取（第三轮 review P1 修复）**：初版降级把远程图标记改写为
  「文件不可用」——两处错误：误导（CDN 图明明可下载）且改写后文本流入持久化，
  下一 episode marker 精确匹配不到残留死标记。改为 enqueue 时对远程图 fire-and-forget
  预取（`fetchRemoteImage` 8s 超时，WeakMap 按 envelope 引用挂结果），drain 消费已
  就绪结果当轮注入；未就绪/失败**保留标记原样**（不臆断原因），由收尾补记的
  imageRefs 下一轮重试。
- **follow-up**：context overflow 的 force-hot 重试会把插话 envelope 重渲染成纯文本
  且使用 episode 开始时的旧 imageRefs 快照——「插话带图 + 当轮 overflow + 重试」同时
  发生时重试后看不到图。触发需三条件叠加，概率低；且重试时上下文已爆，再注图有加剧
  超限的风险，保守保留现状。

### manager 人类消息 turn 间注入（含 builtin worker 输入 turn 边界投递）：已合并（PR #131 → `28a3ae13`）+ PR #130（已合并 `bad70ce4`）

- 引线：2026-08-29 两起现网案例。① builtin 监控 worker 用 `Output(block=true)` 无限轮询
  （94 turn 连续 3.5h 不 end_turn），manager 三次投递（含 immediate_redirect）压队 43 分钟
  未达——投递消费点实际在 burst 边界（end_turn）；② 用户 19:35:50 发消息，manager 19:36:06
  仍在问旧问题，19:36:47 才处理——`routeHumanWake` 直接 `runWake` 阻塞等前一 episode，
  P7 cutover roadmap D 项「把人类消息接到 enqueueDuringEpisode」的接线在实现中遗漏。
- 契约口径（用户拍板）：投递/注入消费点**一直是 turn 边界**；协议 §5.5「burst 自然结束后」
  为 spec 措辞错误。两份契约文档随修复对齐。
- PR #130（已合并）：builtin worker 输入 turn 边界注入（engine `drainExternalInputs` +
  Output 探针提前返回，投递可见性从小时级降到 ≈2s）+ 协议 v3.6.15（docs `93975cf`）+
  spec 2026-08-20 同步。review 三轮：真实风险 2 项（测试 gate 失效、`[manager input]`
  前缀误标系统通知）已修。
- PR #131（三项门禁均已解除后合入：① 权限立项随 #133 落地（`57b6ea87`）；
  ② §4.1 例外措辞随 docs `ef6888ff` 进协议（admin 0.2.7 / agent-v3 3.6.16）；
  ③ 九审唯一阻塞线程（Admin Chat 注入 fail-loud 冷却 → 占位气泡永久挂死）的前提
  随 #135 占位退役消失，fail-loud 冷却语义保留。merge origin/main（`903ab278`）
  解 CONFLICTING 后触发十/十一审）：
  manager 人类消息 episode 运行中到达时**同步**入
  mailbox 走 turn 边界注入（check→push 零 await，与 routeWorkerEvent 同构原子）；store 提交
  延后到 episode 收尾临界区统一落盘（mutex 内单写者，消除注入 RMW 与收尾 save 的 lost
  update）；attention flush / 私聊 / Admin Chat 的结算与 fail-loud 全部委托被注入 episode
  的真实收尾（占位 result 不参与判定）。六轮 review：真实风险累计 9 项已修（未消费注入
  键在 recent 无=永久丢失；假结算 ×5 渐远；重复来源注入 LLM；RMW 并发；check-to-push
  窗口；占位 result 打掉私聊/Admin Chat fail-loud；catch 分支丢注入；discard 打掉自唤醒；
  currentEpisodeInjected 重复入账致 max_tokens 重试渲染两遍）。六审非阻塞观察已处置：
  删 commitHumanInputs 的 injectedEnvelope 残留（无消费者）、两处注释纠偏、待办池补记
  （见下 2/3）。十审修最后一条真实风险（复核 continuation 失败丢弃 finalMessages 时，
  期间被 drain 的注入人类消息经 scoped drain capture 还原回 mailbox 走自唤醒重投，
  消除「键在文本无」静默丢失，`2a521a02`）；十一审 Approve 后合入。
- **#131 待办与 follow-up 池**：
  1. ~~群聊消息档位随消息~~ → **已定性更正并立项**：原条目「spec 从未定义按发起人区分
     权限」不准确——§3.2.7 与 narrowWorkerPermissions（PR F/J）的既有实现就是按发言人
     区分（reviewer 反驳成立）。用户拍板：**群聊权限群级统一、与发言人无关（含 master
     在群里也按群档位），之前按发言人区分的 spec 视为设计错误**，单独立项推翻（spec
     流程）；#131 在该立项落地前不合入，落地后注入与 primary wake 同档位，权限线程
     前提消失。另：§4.1「首次 LLM/工具调用前原子写入」与收尾提交的字面冲突需协议补
     注入场景例外（措辞随权限 spec 一并确认）。
  2. 注入路径未过 `assertWakeAdmission`——isClosing 关停期间消息被静默收下返回 completed，
     调用方拿不到 fail-loud 信号。~~已落盘不丢~~（六审指出该理由已过期：四审后注入改
     为收尾才落盘）；实际收口路径：优雅停机走 abort → settleInjectedHooks(failed) →
     settle 回调补 fail-loud，通路正常；硬杀才会丢（注入尚未落盘）。后续统一收口。
  3. 结算钩子丢弃窗口——提前 return / `settleInjectedHooks` 之后到达的注入，其 hook 会在
     下个 episode 起始被清掉不触发 → 该批 flush 没人 reportResult。六审补记两个同定性
     入口：a) 重复来源批次（newEntries.length===0）提前 return 时 settle hook **从未
     注册**，该批 flush 永不 reportResult（Admin Chat 侧 claims 在 return 前已登记，
     仍能被 settleUnclaimedAdminChatWakes 结算）；b) 注入落在 runWake 计数 +1 与
     runEpisode 起始同步重置之间时，hook 与 pendingHumanCommit 记录一起被重置清掉——
     消息本身安全（已在 mailbox，作 carried envelope 走正常提交），仅 settle 与
     reaction 回调不触发，窗口窄（恰好落在 mutex 获取那一跳）；c) runEpisode 开头
     「重复来源/空批空转」提前 return（committedHumanMessages===0 且 carriedTexts 空
     且 eventText 空）同样不调 settleInjectedHooks 即返回，且前面隔着 ensureSession /
     load / commitHumanInputs 三次真实 I/O await，窗口比 b 宽（七审补记，定性相同）。
     后果（review 追过 scheduler 实现）：仅 `lastActionTime` 不更新，下一条消息 enqueue 时立即 flush，是
     「更积极」而非「变哑」，可接受。
  4. 注入未被 drain 时的委托值失真——消息实际由自唤醒 episode 处理，却以被注入 episode
     的 repliedToHuman 结算；一次性误报非系统性偏置，可接受。
  5. ~~fail-loud 只闭合了「丢失」~~ → **已修**（eef9f991）：onEpisodeSettled 透传
     routeHumanMessages，私聊/Admin Chat 在真实收尾 failed/aborted 时补发 fail-loud
     （Admin Chat 带 request_id 走 delivery CAS 结占位气泡）。
  6. 成功收尾时未被消费的注入留 mailbox 交自唤醒（五审修法），其 reaction 回调随之丢失
     （自唤醒无调用方回调）——与「写入即已接收」自洽（尚未写入本就不该打），窗口窄，
     如实记录不立项。
  7. commitPendingHumanInputs 在首个 await 前清空 pendingHumanCommit（六审非阻塞观察）：
     放弃分支里它自身抛错（store I/O 故障）时，catch 的二次调用看到空队列并报
     injectedHumansCommitted=true → 注入既未落盘也不重投。理论风险（收尾时 store 故障），
     后续统一收口。
  8. （#130 遗留）redirect 对 builtin 是否允许 interrupt/腰斩工具；v2 agent-handler 遗留
     （humanQueue/ask_human）清理；Output 超时参数与连续 block 硬性封顶。

### Admin Chat 删占位气泡 + 已接收标记（UX 对齐 channel）：已合并（PR #135 → `d7b62171`）

- 决策（2026-08-30）：直接删除 admin-web「正在思考」占位气泡；admin chat 增加类 feishu
  reaction 机制——人类消息被 agent 消费后打 ✓ 标记，把 UX 与 feishu channel 对齐。
- spec/协议先行 crabot-docs（`66d5a2d` + `9adeb8f`）：spec 2026-08-30-admin-chat-ack-reaction-design；
  protocol-admin 0.2.8（§3.20.2 chat_acknowledge / chat_message_acked / acknowledged_at、
  chat_status 退役）；protocol-agent-v3 3.6.18（§4.1 已接收标记与 Channel reaction 同语义同时机）。
- 实现：web 删乐观占位/8s 轮询/chat_status handler，chat_error → toast，回复一律独立追加，
  user 气泡 ✓ 标记（重连补齐按 timestamp 归位合并）；admin acknowledgeRequests（幂等 +
  未知 ID 静默）经 requestIndex 定位 user 消息打标落盘后推送；agent 人类输入 commit 后
  best-effort chat_acknowledge（复用 onHumanInputCommitted，只对 primary wake 触发，
  mailbox 重投不打标 = channel 无 reaction 兜底语义）。
- @claude review 三轮：一轮修真实风险（删 connected 分支时误删重连补齐，恢复为服务端
  权威合并）；二轮修真实风险（补齐 concat 队尾致提问沉到回复后，改按 timestamp 排序归位）；
  三轮 Approve。遗留 follow-up 见下方待办。
- 验证：web Chat 10/10、web/admin/agent tsc 干净、agent ack 用例 2/2；chat-integration
  重写为落库轮询（占位推送退役）。**需重建重启 admin + agent 生效。**
- #131 阻塞解除：九审唯一阻塞线程（Admin Chat 注入 fail-loud 冷却 → 占位气泡永久挂死）
  的前提随占位退役消失，fail-loud 冷却语义保留；#131 已合并（`28a3ae13`）。

### LLM 429 分类重试 + 重试层扁平化 + 重试期间配置热切换：已合并（PR #134 → `f705b104`）

- 引线：现网事故——z-ai/glm-5.3-flash 额度类 429 触发嵌套双重重试（adapter 层 10 次 ×
  callNonStreaming 10 次 ≈121 次尝试/13+ 分钟 sleep），期间 Admin 切换默认模型不生效。
- spec/协议先行 crabot-docs（`1299870`）：spec 2026-08-30-llm-retry-config-hotreload-design
  （Implemented）；protocol-agent-v3 3.6.17（重试阶段例外、429 分类、单层重试约束、
  invalidation 投递保证）。
- 实现：①429 三分类（额度类 body code fail-fast / Retry-After 有限重试且 60s 封顶、
  超上限按失败 / 无 header 通用 429 限 3 次）；②重试层扁平化（adapter 只留超时，
  唯一重试层 = callNonStreaming，DEFAULT_MAX_RETRIES 10→5，单调用 ≤6 次尝试）；
  ③重试等待响应配置热切换（configGeneration 代数记账 + 边沿 signal 唤醒，
  每次 LLMConfigSwap 换 adapter + model/maxTokens/thinking 参数，消费授予 1 次额外
  attempt 预算封顶 maxRetries，generic429 计数随切换清零）。spec §5.4 复核结论：
  Admin invalidation gate 关闭窗口静默跳过是既有设计，无代码改动。
- @claude review 四轮：三轮各修一条真实风险（worker onConfigChanged 读旧 sdkEnv 的
  notify 时序；一次性 AbortSignal 永久归零退避 → generation 探针方案；变更消费先于
  放弃判定 + 额外 attempt 预算）；四轮 Approve。遗留 follow-up 见下方待办。
- 验证：tsc 干净；engine 628/628 全绿；全量失败与 HEAD 基线逐一对照均为存量
  环境/flaky，无新增。**需重建重启 agent 生效。**

### LLM 重试/热切换 follow-up（PR #134 review 记录，均非阻塞）

- ① `Retry-After: 0`/已过期 HTTP-date 允许 0ms 延迟并绕过通用 429 次数上限
  （可设延迟下限；纯空白值解析缺陷已修）。
- ② onRetry.maxAttempts / admin web「正在重试 N/M」分母随 configSwitchBudget 跳动，
  观测口径与真实配额不一致。
- ③ 死代码清理：streamWithRetry / isMaterialChunk（本 PR 扁平化后仅测试引用）、
  anthropic 429 包装丢失 cause/stack、unified-agent `updateLlmClients`（存量）。
- ④ [理论风险] configGeneration 探针只看代数不看 model_config 是否真变：改
  system_prompt/skills 也触发一次换配置预算；equal-revision 恢复路径同样 +1。
  生产 revision 变更稀疏且有界，量级可接受。
- ⑤ [知情项] 热切换只救当前这一次 LLM 调用：同 runEngine 下一 turn 仍用 loop/episode
  级快照旧 provider，直到 episode/loop 结束才全面换走（spec §2.2 非目标、协议 3.6.17
  已写明）。

### 群聊权限群级统一（与发言人无关）：已合并（PR #133 → `57b6ea87`）

- 决策（2026-08-30）：群聊有群聊的权限，与发言人无关（含 master 在群里也按群档位）；
  推翻 protocol-admin §3.2.7 原按发言人解析的群聊语义。spec + 协议（admin 0.2.7 /
  agent-v3 3.6.16 §4.1 注入例外）随 crabot-docs `ef6888ff` 落地。
- 实现：admin `resolvePrincipalPermissions` 群聊路径提前返回（忽略 sender_friend_id、
  只按 GroupSessionPermissionConfig/缺省 group_default 解析，模板缺失 → minimal）；
  私聊不变；agent 侧无代码改动（唤醒边界照常调 RPC）。
- 关联：落地后解除 PR #131 权限 review 线程前提（注入借 primary wake 档位提权），
  #131 另一门禁（§4.1 协议例外）已随 docs 落地。
- **follow-up（#133 review 记录，schedule 权限语义属 spec 非目标、另行立项）**：
  `crabot-agent/src/manager/bootstrap.ts` `onScheduleWake` 用
  `principals.get(key)?.principal.sessionType ?? 'private'` 猜会话类型——群聊会话在
  agent 重启后、尚未被人类消息唤醒过的窗口内猜成 'private'，schedule 解析走私聊路径
  （master creator 拿回 master_private、普通 creator 拿 friend∪session 并集，均 ≥ 群档位），
  与群级统一不变量相悖。相对改动前无回归（旧代码群聊 master 本来也短路）；窗口窄
  （需重启 + 该群无人类消息 + 恰有带 creator 的 schedule 触发）。修法方向：
  TriggerScheduleParams.target_session 带 session_type（协议改动）或按 session_id
  特征/配置反查，需 spec。

### 移除 macOS FDA 放开机制，受保护目录无条件排除：已合并（PR #129 → `3e268439`）

- 决策：FDA 放开机制要求「设 CRABOT_ENABLE_FDA → 系统设置授权 → 重启」，授权动作必须在
  GUI 会话完成，agent 对话 / CLI / launchd 后台宿主场景人类无法即时处理，实际无人走完；
  收敛为受保护目录（~/Library、Desktop/Documents 等 TCC 目录）一律不扫。FDA 话题整体
  往后放（若未来做管理后台 GUI 引导授权，另行立项）。
- spec：crabot-docs `f95b06b`。实现 8 文件 +14/−207：删 fda-check.ts + 测试（探针/启动
  提示/弹设置面板）；getProtectedExcludeGlobs 去 scanProtected 参数，排除无放开路径；
  MM 不再读取/透传 CRABOT_ENABLE_FDA。
- 兼容性：唯一行为变化是「已设变量且已授权」的极边缘机器从放开变排除（spec 确认接受）。
- 验证：crabot-core 172/172 全绿；crabot-agent 全量与主仓基线失败集合一致（9 个存量
  flaky 文件，差异用例两边单独重跑均全过），无新增失败。**需重建重启 MM + agent 生效。**

### finish_task 终态守卫（worker 提前收尾连带杀 subagent）：已合并（PR #128 → `04e2681a`）

- 引线：现网事故（2026-08-28，feishu-fengyan::2mpxa9jb）——worker 在 code_writer subagent
  运行中调 `finish_task(completed)`，化身 exited 连带终止 subagent（stopWorkerSubagents），
  其完成通知又因 killed 状态被 onExit 静默丢弃；turn_completed 被 manager suppress 后再无
  事件，汇报永久落空。根因：finish_task 终态语义当初未定义与 bg-shell/subagent 共存的行为。
- spec/协议先行发布 crabot-docs main（`b5f7ed1`）：拆分 spec §7.5「2026-08-28 实现遗漏修订」；
  protocol-agent-v3 3.1.3（§5.1/§6.4 结构化 finalize 守卫）。
- 实现：`finish_task` 时名下仍有 running bg entity（bg-shell/subagent，复用
  hasRunningBgForWorker 查询口径）→ 不落终态：writeBack 前把 engine 合成的成功 `[exit_tool]`
  改写为 is_error=true + 提醒（markFinishTaskRejected），排空收尾期排队输入（immediate 优先，
  drainQueuedInputs 与既有 pendingInputs 分支共用）后原地续 burst；worker 契约尾巴补「有后台
  命令/子 Agent 在跑时不要 finish_task」。人工 killed 的连带终止 + 通知抑制语义不变。
- @claude review 两条真实风险已修（`0fcae184`）：①打回未排空 pending 队列（bg 通知被推迟、
  immediate_redirect 被饿死）；②协议要求「失败 tool_result」未实现（仅 user 提醒纠正）。
- 测试：builtin-adapter 64/64（新增 4 用例）；tsc 干净；workers/agent 全量失败均为既有 flaky
  （主仓基线可复现）。**需重建重启 agent 生效。**

### 模型槽位收敛 + 上下文/思考强度配置：已合并（PR #127 → `2e67b42e`）

- spec 与协议先行发布 crabot-docs main：spec `e4bc1da`（含 thinking 存储形态修正——ModelSlotRef
  保持纯引用，thinking 独立 map）；协议 `eeba0c8`（base-protocol 0.2.3、protocol-admin 0.2.6、
  protocol-agent-v3 3.1.2）。
- **槽位收敛**（用户决策）：`CoreAgentModelRole` 4→2（powerful/cost_effective）；Manager loop 直接用
  powerful（原"manager 槽 + 内部回退"按用户定性为多余设计移除）；vision 场景（research_collector）归
  cost_effective。存量迁移：槽位引用丢弃+warn（不搬运，防隐式改写保留槽解析）；subagent model_role
  角色引用归一化 vision→cost_effective / manager→powerful（幂等，经既有 seedBuiltin flush 落盘）。
  backup import preflight 收敛 2 key（旧备份含 legacy key fail-loud）。
- **思考强度配置**：`AgentInstanceConfig.thinking`（独立 map，level/custom 互斥；自定义值原样透传，
  数字仅 anthropic）；解析时"强度跟 slot 走"（回落全局默认仍生效）；三 adapter 映射
  （anthropic effort/disabled/budget_tokens、openai+gemini 兼容层 reasoning_effort、responses；
  **Codex 跟随默认保持 medium 现状**）；不做运行时降级，档位不匹配由 Provider 400、用户改档自愈。
- **上下文窗口配置**：`ModelInfo.context_window` 协议本就有字段，补 UI——详情抽屉"上下文"列内联
  编辑（清空=回退默认 200K），驱动 compaction 阈值。
- 分支 `worktree-slot-convergence-thinking-config`（PR #127，3 commits）；新增单测 41 例全绿；
  worktree 全量测试中 main 既有失败与负载 flaky 已逐个甄别标注。
- @claude review（2026-08-28）两条真实风险已修（`f5f430c6`）：①thinking 加进
  readCoreAgentSemanticSnapshot 投影（否则 thinking-only 保存被判 noop 400）；②AgentConfig
  的 getGlobalConfig 拆分容错（placeholder 级失败不再打空表单）。
- anthropic placeholder 措辞已改警示（数字 budget 在 thinking block 回传补齐前不再主动引导，
  见技术债段 ①）。
- **待做**：spec §9 手工验收三项（真实 provider effort 生效 / 128K compaction 提前 / 存量迁移演练）
  需起实例验证；改动横跨 admin/agent/web，需重建重启生效。

### wechat 群聊门控（@ + 引用放行）：已合并（PR #124 → `ffd32e55`）

- 已确认 spec 与计划发布到 `crabot-docs` main（`2631a13` / `d4d9560`）：`protocol-channel.md` 0.1.2
  §4.2 把 only_respond_to_mentions 字面扩展为「定向」语义（定向 = @ Crabot，Channel 可选扩展引用放行；
  feishu 仅 @，wechat @ + 引用）。
- 引用判定走 connector 反查补齐的 `quoted_sender_wxid === puppet.wxid` 精确对照（BOT_INTEGRATION.md
  §type=18 字段契约）；反查失败（字段缺失）直接丢弃，不做名字模糊降级。
- `feat/wechat-group-mention-gate`（PR #124）：module.yaml 开关（default false=行为不变）+ main.ts
  env 链路 + handleWechatEvent 门控（丢弃不建 session 不发布）+ 补齐协议 §6.1 MUST 的
  get_config/update_config。新增 16 用例 + 既有 62 全绿。
- @claude 四轮 review 共 7 条真实风险全部闭环、复审④ approve 后自动合并（squash `ffd32e55`）：
  ①update_config 字符串开关静默 no-op（`ce3f1feb`）②
  x-runtime-path 部分标注致 running 实例配置面板退化——用户确认撤回 spec §4.4 排除项，config RPC
  对齐 feishu 完整模式（`61c93baa`，spec 修订 docs `4c9f724`）③引用消息 agent 侧延迟巡检——
  follow-up（见技术债段）④占位文件漏删；三审 ⑤webhook_port 数字字符串（`edde5577`）⑥运行时
  配置不落盘——follow-up ⑦webhook_secret 请求回调实时读取（启动时快照修复 `72ff8a82`）。
- **人工验证待做**：真实群 ① 普通发言不触发 ② @ 触发 ③ 引用 Crabot 触发（预期延迟一个巡检周期）
  ④ 重启后开关回退 false（已知限制，见技术债③）。需重建重启 wechat channel 生效。

### 群聊响应纪律 prompt：已合并（main `d8ad16c3`）

- v3 拆分退役 Pre-Front Dispatcher 时，群聊静默判断语义（收件人判定优先 / 必须沉默 / 禁止沉默）
  未迁移到 manager prompt，生产实测群成员互聊时 agent 连发多条附和消息（插话正反馈：每次发言把
  群聊巡检间隔重置回 min）。
- 已把判据迁回：`isGroup=true` 的 manager system prompt 追加 `GROUP_CHAT_DISCIPLINE` 段
  （`manager/prompt.ts`），判据逐条来自 2026-05-19 / 2026-05-15 spec 的 dispatcher 群聊 triage，
  信号形态对齐 `formatChannelMessageLine` 渲染；另补 v3 新形态语义「刚发过言后不接话茬」。
- `isGroup` 走 `promptInputs` 通道（principal 缓存的 sessionType）；私聊 / 系统线程 / 每日反思
  装配结果与改动前逐字节一致（测试钉住）。改的是 agent 源码，需重建重启 agent 生效。

### P6 与后续 Worker 运行链：已合入

- P6 Slice 0～D 及模块关闭已由 PR #90、#92、#94、#97～#99 完成；统一 Worker Runtime、重启恢复、
  subagent 可观测性、用户级 CLI 安装、本地工具进程隔离、同步输入、activity 错误证据、内置能力归属和
  启动轻量对账随后由 PR #111、#113、#114、#117～#122、#125 完成。旧分支状态、逐轮 review 和当时
  测试数字不再保留在当前进度文件中，详见 Git 历史及对应设计。
- 当前不变量：Manager 负责决策和人类投递，Worker 负责实际执行；输入投递、原生 activity、化身状态、
  回合交付和任务关闭分别保留真实证据，不以 `idle` 或 Worker 自报替代 Manager 判断。

### Manager / Worker v3（已生产运行，背景）

- PR #76～#89 完成 CLI worker 输入/活性/权限/ManagerKey、legacy loop 退役、bg-shell durable notification、worker-scoped MCP、Admin Chat assertion、会话隔离与 v2 只读导入；生产切换见里程碑归档（`git show 49b9cb4:PROGRESS.md` 有完整细节）。

## 当前 follow-up

- **任务板 Admin Web 共管界面**：本期只落 Manager 工具与存储；人类查看、编辑和归档任务项的界面及
  API 另行设计，不阻塞当前能力。
- **`spawn_worker.workspace` 无效可选值容错**：真实上下文评测的无关任务场景前两轮分别传入不存在路径
  和空字符串，工具拒绝后模型省略参数并成功重试，三轮最终均创建新 Worker。需独立评估 schema 或参数
  修复层是否应把无效可选值视为省略，以减少额外模型回合；不阻塞任务板与偏好分流上线。
- **启动对账 PR #125 review 遗留**：① `realignAliveIncarnation` 矛盾修复硬写 `running`（理论风险：
  矛盾+idle 场景会被 sweep 误报一次停摆，触发面窄）；② `ensureInteractionInspected` 先清标记后执行，
  探测抛错时该次重检丢失（与合入前行为一致）。
- **测试基建 `detectTmux()` 缺陷（PR#125 调查中发现，需单独立任务）**：probe session `exit 0` 立即退出使 tmux server 消亡，`kill-server` 失败被 catch 后恒返回 false → `skipIf(!tmuxAvailable)` 的真实 tmux 测试（codex/claude-code 的四轮/五轮 review PoC 组）在部分环境从不执行；强制启用后 PoC②（rollout 内容 id 校验）、PoC③（重启后 resume 撞号）实测为主仓同样挂的预存失败。这使相关回归长期静默跳过，PR#125 首轮验证的"codex 全绿"即由此产生假阴性。
- **builtin resume 后 native activity 收集静默失效（w-7e31305e 调查，诊断日志已合入 main `2d2a2714`，待部署定位断点）**：resume 后 22 分钟活动收集全部静默失败（native-activity store 零写入），恢复后靠一次性全量补收兜底；任务执行本身不受影响。span 写入（appendTurn）与收集信号（onNativeActivity）同点触发、收集成功必然写盘，故失败点在 collect 链路的某条无日志静默 return。已做：守门分支化 + 源不可用（unavailableReason）留痕 + builtin readTrace 对齐 cc/codex 语义。**下一步**：部署后复现时看 agent stderr 的 `native activity collect skipped` 日志定位具体分支，再针对性修复。附带确认：Output 工具 block 600s 是 worker 传参 `timeout_ms=600000` 所致，非 bug。

### P6 遗留 follow-up

- **统一 observability retention**：自动回收终态 Worker 的 adapter output/session、events/context、ledger、
  过期 Manager episode/TraceStore；孤儿 adapter/events 24h grace；output log 10MB cap。所有 workspace
  零自动删除；workspace 管理和显式删除另行设计。
- **Worker onboarding / 选择器**：真实 pane 内失效尚缺实现级归因；verification binding 仍按整份 Worker
  配置 revision 失效；operation 占位、断言临时文件、终态时间、403 body、孤儿 Provider、代理出口、
  operation TTL，以及选择器 fence 的 revision/barrier 测试仍需分别评估。

### 技术债与既有 follow-up（P6 后或并行确认）

- **admin-chat ack PR #135 review follow-up（2026-08-30，均非阻塞）**：①附件路径的 ✓
  打标竞态——chat_message_acked 若早于 HTTP 响应返回到达则遍历不到本地消息（刷新经历史
  恢复，量级极小）；②附件路径的 ✓ 不经重连补齐——fresh 按 message_id 去重跳过已知的
  服务端 UUID user 消息，断连期间丢的 ack 推送补不回（刷新恢复 = channel 无 reaction
  兜底）；③handleChatAcknowledge 不校验 request_ids 类型（agent 唯一调用方恒传数组，
  同模块既有风格）。
- **finish_task 守卫 PR #128 review follow-up（2026-08-29）**：①常驻型 bg-shell（如 dev
  server）在跑时 finish_task 会被守卫永久拒绝，只能靠提醒引导 worker 先 Kill——需确认这是
  期望语义，必要时写进守卫文案或文档；②打回暂无次数上限（排空修复后重试循环由 bg 通知驱动、
  天然有界），现网若观察到连续打回再收紧；③crashed 路径的 subagent 连带终止与通知抑制维持
  现状，是否改为留活自愈（subagent 完成通知经透明接续更快唤醒）待评估；④窄竞态：subagent 已
  完成、通知在途时 finish_task 放行，排队通知进 dead-letter（review 记录不改）。
- **manager 压缩 hardCap 接模型 context_window：已合并（PR #132 → `ac09fd4d`）**。worker 侧
  阈值本就按 `context_window × 0.8` 生效（未设置回退 200K）；manager 自管压缩此前是写死常量
  （fold 20K / hardCap 160K）且 bootstrap 从未传 contextWindowTokens。现 `hardCapTokens` 从
  manager 实际模型（powerful 槽位）窗口推导（floor(window×0.8)，未配置回退现状常量），
  `foldTokenThreshold: 20K` 作为刻意保守策略保留不动；thunk 每 episode 解析（§11 热更语义）。
  spec：crabot-docs `2026-08-29-manager-compaction-model-window-design.md`（`4eece36`）。
  **需重建重启 agent 生效。**
- **槽位思考强度 PR #127 review follow-up（2026-08-28）**：① anthropic 数字 budget 档位
  （`thinking:{type:'enabled',budget_tokens:N}`）会开启经典 extended thinking，但
  anthropic-adapter 流处理只消费 text/input_json delta，thinking block 与 signature 既不产出
  也不回传——≤4.5 老模型 tool loop 第二轮大概率 400；触发需「anthropic + 老模型 + 主动填数字」
  组合且 fail-loud；placeholder 措辞已改警示（引导用户用枚举档位），block 回传支持属后续 spec。
  ② 数字 thinking_custom 的
  format 校验是保存时一次性判定：槽位无模型引用时事后换全局默认 Provider 不会重校验，
  `thinkingEffortValue` 对 number 返回 undefined → 静默退化为跟随默认（协议已知边界）。
  ③ backup import 对 legacy 槽位 key fail-loud 拒绝 vs 启动迁移丢弃+warn 的恢复体验不一致
  （有意为之，灾难恢复场景用户需手改归档 JSON，观察是否值得放宽）。
- **核心配置 revision 启动自检 fail-open：已合并**（PR #126 → `edab960a`）。PR #122 投影变更
  撞上一次性 rebaseline 申报通道锁死生产后，按 spec（crabot-docs
  `2026-08-28-config-revision-startup-fail-open-design.md`、protocol-admin 0.2.5）把启动漂移
  改为警告 + 重记账继续，marker 申报机制全链路退役；outbox 恢复/两阶段提交/seqlock/cutover
  gate 未动。部署约束：实例需重建重启后生效，升级不再需要任何申报动作。
- **wechat 群聊门控 PR #124 review follow-up（2026-08-28）**：① agent 侧注意力调度只对
  `is_mention_crab` 做即时唤醒（`attention-scheduler.ts:62` flushNow），引用放行消息要等一个巡检
  周期（2-30min）——「@ 与引用同等即时唤醒」是 protocol-agent-v3 §4.5 调度语义变更，需单独 spec
  （含引用放行是否算 replied/重置间隔）；落地前人工验收项 ③ 预期为触达但延迟一个周期。② feishu
  channel 存量问题：module.yaml 声明 `type: string` 而 `handleUpdateConfig` 只认 boolean，Admin
  热改开关静默 no-op（SchemaField enum 分支回传 string，全链路无类型还原），与本 PR 修复同款。
  ③ **channel 运行时配置不持久化**（feishu/wechat 同款存量，wechat 侧随 PR #124 打开此路径）：
  Admin `update_config` 只 RPC 落模块内存不写实例配置，模块任何重启即回退 env（wechat 门控开关
  缺省 false 回退方向不安全；feishu 默认 true 回退安全）。收口方向：update_config 成功后按
  `x-runtime-path` 反向映射回写 local-config + 明确配置真相来源，feishu/wechat 一起收口，需独立
  spec（持久化模型变更）。spec `2026-08-28-wechat-group-mention-gate-design.md` §9 已明示该限制。
  同源收口项（PR #124 三审补充）：`get_health` 读可变 config，未重启时健康视图显示未生效值，
  收口时改读启动快照；`webhook_port` 校验补 65535 上限；门控 drop 日志在大群的量评估。
- **telegram 群聊门控**：`group.only_respond_to_mentions` 协议已有契约，feishu / dingtalk 已实现，
  telegram 缺失（wechat 已随 PR #124 实现）。
- **内置能力归属完成后的后续设计**：当前能力归属 spec 实现并验收完成后，再依次处理三项独立设计：Schedule 支持受控的无 LLM operation，并用其承载 `Memory.run_maintenance("all")`；Manager 获得按 domain 枚举、复用既有权限/确认/undo/审核/脱敏语义的结构化 Crabot 管理工具面；清理活跃代码中会被误解为第三种 Agent 的遗留模块容器命名。三项均不得并入当前能力归属实现。
- **Worker/subagent trace 写点的同类硬截断**：`agent-handler.ts`（`.slice(0, 200/500)`）与 `unified-agent.ts`（`.slice(0, 300)`）对工具 span 摘要仍用整段硬截，与已修复的 manager episode span 同模式；目前无消费方受害（episode 投影不读这些 trace），若未来对其启用结构化提取应先改造为 `span-summary.ts` 的字段级截断（2026-08-27，`7cd86abf`）。
- **Worker 巡检调度收口**：启动对账与周期巡检应共享 due 投递排他；避免单个 Worker 的长锁阻塞全局活性巡检；默认巡检在全局 LLM 故障时需要有界的失败告警去重/退避。三项均需独立设计，不纳入当前任务巡检 PR。
- **移除 Agent 内部 legacy `roles` seam**：`AgentLayerConfig.roles` 是 v2 前多 Agent 时代残留（正式协议从未包含），现仅作内部测试 seam/恒真分支；应替换为显式的 worker-layer 开关后删除。
- **普通 Channel 未消费人类 wake 的跨重启恢复**：2026-08-19 实测，飞书私聊消息已落 Channel journal、reaction 已发且同 session Manager episode 已创建，但 Agent 在首次 LLM 调用前 OOM 重启；启动恢复只将遗留 episode 标为 `interrupted`，未将该 wake 重放，后续 worker 事件遂基于旧上下文回复。需独立设计普通 Channel 的持久化入站 wake、成功消费后结算、重启按原始顺序幂等重放；不得用扩大 Manager recent、滚动摘要或 prompt 约束替代。
- 失败 Manager episode 的通用带退避 mailbox retry；跨 session 代发目标 Manager 持久注记（§4.2）；Codex provision `auth.json` 错误吞没；P8 调试工具/内部文档重写。
- Claude project-scope MCP 文件（已接受边界）；权限 schema 纪律（新增 schema 前先迁移历史 worker context）。
- Admin source manager 的完整两阶段回滚：当前 mutation 源写入失败且内存态已推进时，靠重启恢复 fail-loud 兜底；各 manager 的事务性回滚（磁盘为准）另行设计。
- claude-review workflow 已修 retry 阶梯（main `55f9f3a`）：Verify attempt 1/2 加 `continue-on-error`，否则首次未提交 review 直接跳过 attempt 2/3。
- reviewer bot 的 OAuth token 有 session 配额（约 10 轮高强度 review 后触发 "session limit"，按 UTC 时间窗口重置）；配额耗尽时 review run 会即死，等重置后重触发即可。
- `handleGetAgentConfig` 的 epoch 有界重试会整体重放 MM verify/get_module 往返（失败模式下最多 ~26 倍验证调用）；后续可把重试收缩到解析段内部。
- Admin Web SubagentEditor 的 `crab_messaging` 开关置灰（下发时被协议硬置 false，UI 与行为不一致）。
- tests 未进入 TypeScript type-check 的债务；Agent 4 个 macOS 基线失败的独立校准。

### 非主线历史候选

备份导入 Plan 2、Memory 压缩/去重/混合检索、Windows 进程树、Claude Code 容器化/沙箱等需分别重新确认，不是当前已批准计划。

## 里程碑归档

| 日期 | 里程碑 |
|---|---|
| 08-13 | P6 Slice 0 开 PR #90：核心 Agent singleton、runtime bearer identity、authenticated config pull、management-only cutover、durable config revision、降级启动自愈；两轮 @claude review 意见全部修复，全模块测试基线刷新（Admin 1139/1139 首次真正全绿）。 |
| 08-11 | PR #86（merge `9546bae`）生产 cutover：2696 条 v2 task 一次性只读导入，legacy continuation、Admin Chat assertion、会话隔离与 Claude/Codex 真机 E2E 通过。 |
| 08-09～10 | PR #84 worker-scoped MCP capability；PR #82 CLI 交互输入提交；ManagerKey 会话台账与 v2 legacy 只读导入完成。 |
| 08-01～09 | PR #80 legacy 执行/恢复控制面退役 + builtin bg-shell durable delivery；PR #77/#78 Claude Code 真机修复；worker 活性信号纠偏。 |
| 07 月 | Manager/Worker P1～P5+P7 主链完成（adapter、ledger/harness、manager loop、read model、scheduler 路由）；agent-venv、subagent 模型实时解析。 |
| 06 月及更早 | Engine V2 + Provider 直连（LiteLLM 移除）、Memory v2、原生飞书、Master Chat、备份导出、Admin UI 等；详见 `git show 49b9cb4:PROGRESS.md`。 |

## 当前架构真相源

为避免本文件复制并腐化架构说明，以下内容不再展开：

- 项目开发与流程规则：根目录 `AGENTS.md`。
- 正式模块契约：`crabot-docs/protocols/`（当前版本以各协议文件头为准）。
- 设计决策与实施计划：`crabot-docs/superpowers/specs/` 与 `plans/`。
- 开发、部署、调试说明：`AGENTS.md` 与 `crabot-docs/guides/`。
