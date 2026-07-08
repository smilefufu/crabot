# Crabot 项目进度

> 最后更新：2026-07-08 — 修复 resume 执行入口语义污染

## 2026-07-08 — 修复 resume 执行入口语义污染

- 根因：`resume_task` / terminal supplement revive 复用了 `ScheduledTaskRunner.executeScheduledTaskInBackground`，该 runner 硬编码 `source.trigger_type='scheduled'`，导致 human message task 续跑后关闭 goal/end-turn delivery gate，空 `end_turn` 可直接完成。
- 修复：新增通用 Agent Loop Substrate，scheduled / human resume 通过显式 source/profile 进入同一个 worker loop；`ScheduledTaskRunner` 只保留真实 scheduled 任务组装职责；resume 后台执行失败会 best-effort 标 Admin task failed。
- 回归：human resume / terminal supplement revive 保留 `trigger_type='message'` 和 delivery epoch gate；scheduled resume 仍保持 scheduled silent policy；`send_master_private` 收紧为 scheduled/system 场景工具，human message task 不再暴露。
- 验证：`crabot-agent` resume/scheduled、agent-handler、messaging focused vitest 与 `tsc --noEmit`。

## 2026-07-06 — LLM 流缺终态改为可重试协议错误

- OpenAI Chat Completions / Responses stream 在已开始输出但缺少 `finish_reason` 或 terminal event 时，不再把 `stopReason=null` 传到 `query-loop`，而是在 adapter 层抛 `StreamProtocolError`，由 buffered LLM 调用重试整次请求。
- Chat Completions 明确拒绝旧版 `finish_reason='function_call'` 流式协议（当前 xinshu 实测为新版 `delta.tool_calls` + `finish_reason='tool_calls'`）；`content_filter` 明确抛非重试 provider 错误，避免落成 null stopReason。
- 验证：`llm-adapter.test.ts` 62 个通过；`retry-utils.test.ts` + `stream-timeout.test.ts` 24 个通过；`query-loop.test.ts` 35 个通过；`crabot-agent` `tsc --noEmit` 通过。

## 2026-07-05 — 移除 dispatcher action.text 上下文污染

- Dispatcher action schema 不再携带 supplement/new_task 正文；executor 对 active supplement 只路由 task_id，对 terminal revive/fallback 使用本轮真实 `ChannelMessage` 渲染内容，避免 completed task 拉起时把 `action.text` 当用户输入注入。
- terminal supplement wakeup 删除无用系统提示，只保留真实用户补充；引用消息渲染改短截断并保留 message id，降低大段引用原文造成的上下文漂移。
- Trace 页不再展示 `dispatch_action.text_summary`，协议 `protocol-agent-v2.md` 同步移除该字段与旧 `new_task(text)` / `supplement(target,text)` 语义。
- 验证：agent dispatcher/resume/prompt/register 定向测试 78 个通过；Admin Web trace utils 测试 19 个通过；`crabot-agent` / `crabot-admin/web` `tsc --noEmit` 通过。

## 2026-07-04 — 稳定 Channel Session ID 与无痛备份导入

- `Session.id` 明确为 Admin/Agent 使用的稳定对话指针，由 `channel_id + platform_session_id` 确定性派生；WeChat/Feishu/Telegram 加载旧 `sessions.json` 时把 legacy 随机 ID canonicalize 到 stable ID，legacy ID 仅作为兼容 lookup alias。
- `Schedule.target_session` 同时保存 `session_id` 和可选 `platform_session_id`：前者是运行时发送主指针，后者是迁移/修复锚点。Admin 只按 `channel_id + type + platform_session_id` 做确定性修复；缺证据的 legacy-only stale 引用保持无效，不做 fuzzy repair。
- 备份/导入不依赖 channel-local `sessions.json`。只要导入后 channel 实例和平台原生会话 ID 不变，重新发现会话即可得到同一 stable `Session.id`，导入的 schedule/config 能重新对上。
- Legacy-only `session-configs.json` 缺少 `channel_id/platform_session_id`，不安全自动迁移；这类旧配置保持无效，避免错误套用到另一个会话。
- 验证：三个 channel session-manager 测试与 build；Admin schedule repair / backup gather / target_session 测试与 build；Admin Web schedule 保存测试与 build。

## 2026-07-04 — 修复 resume checkpoint 悬空 tool_use 导致 OpenAI 400

- 根因：普通工具路径在 `toolResults` 入栈前触发 `onTurn`，worker checkpoint flush 把半截 `messages` 落盘；terminal supplement / restart resume 重放该 checkpoint 时，OpenAI 拒绝无 output 的 function call。
- 修复：`query-loop` 改为先写 tool result 再触发 `onTurn`；`exitsLoop` / `turnZeroOnly` 早退或拒绝路径对同轮所有 `tool_use` 补齐 tool result；新增 `tool-message-integrity` 共享校验，`isResumable` 拒绝历史坏 checkpoint。
- 验证：`resume-checkpoint.test.ts`、`query-loop.test.ts`、`query-loop-exit-tools.test.ts` 通过，并覆盖多 tool_use + exitsLoop / turnZeroOnly 混合场景。

## 2026-07-03 — 修复 async goal audit 结果未持久化与 no-delivery 空审计

- 根因：admin-chat 里用户看到的“收到...”来自 dispatcher `immediate_reply` / supplement ack，经 `chat_callback` 写入聊天消息；它不是 worker 的 `send_message` 工具调用。实际 worker trace 没有 `send_message`，所以 goal gate 判断“从未向人类交付”是成立的。
- no-delivery 路径不再在空 outboundBuffer 上强制派 audit；连续提醒 3 次仍直接 end_turn 时，engine 直接以 no-delivery failure 结束，要求 worker 在阈值前先 `send_message(intent=info)` 汇报或 `send_message(intent=ask_human)` 求助。
- async goal audit 路径只把 `<audit_result>` marker 推回 worker loop，没有像同步 `runGoalAudit()` 一样写 `append_task_goal_audit_entry` / trace verdict，导致 `audit_history` 为空、auto-block 失效、audit trace 顶层 outcome 空。已在 async audit on-exit 增加结构化 verdict 回调，由 `AgentHandler` 写 audit history，pass 时完成 goal，并 best-effort patch audit trace outcome。
- `scripts/debug-agent.mjs` 改为从 Module Manager 自动发现 Admin/Agent 端口，`tasks` 改用 `list_tasks` + 正确 filter/分页字段，trace 的 dispatcher action 显示 `dispatcher_ack=sent/none` 与 `supplement_ack=...`，避免把 dispatcher/admin ack 误读成 worker 交付。

## 2026-07-02 — 修复 Traces UI 活动排序、terminal supplement trace 续写与 null stopReason 误完成

- Traces 主列表的 task 行改按最后活动时间排序：`activity_at = max(task.updated_at, 最近关联 dispatcher started_at)`；标题/摘要优先显示最近 dispatcher 消息，避免旧 task 收到 supplement 后仍沉在创建时间位置、也避免只能看到原始长标题。
- `list_conversation_units` 搜索把关键词传给 `search_traces`，并在 Admin 侧对 orphan/related dispatcher 二次过滤，避免搜一个补充消息时混入大量无关孤儿对话。
- terminal supplement resume 才把历史 worker trace id 写入 `resumeFrom.resumeTraceId`，`handleExecuteTask` 通过 `TraceStore.reactivateTraceById()` 复用已完成 worker trace 继续追加 spans；普通 restart resume 不携带 `resumeTraceId`，仍走 `resumableCheckpoints` + `reactivateResumableTrace(task_id)`。修复同一 task 每次 terminal supplement 生成一条新 worker trace 的问题，同时避免把 restart 语义污染成历史 trace revive。旧历史数据里已产生的多 worker trace 不自动合并。
- `reactivateTraceById()` 同步刷新 `traceIndex` / `taskIndex`，避免详情页 full trace 已 running、列表 search/index 仍显示 completed 的状态漂移。
- 明确区分 `stopReason='end_turn'` 与 `stopReason=null`：任意已送达 `send_message(intent='info')` 仍允许作为“已有交付”收口；但 LLM stream 没有 terminal stopReason 时按失败处理，不能把空输出误标 completed（对应 trace `6646e158` 的事故形态）。
- 验证：Admin 定向回归 2 个通过；Agent resume/trace-store/query-loop 定向回归 14 个通过；query-loop 全量 33 个通过；`crabot-admin` / `crabot-agent` / `crabot-admin/web` `tsc --noEmit` 均通过。

## 2026-07-01 — 修复 recent terminal supplement 的 checkpoint 来源

- recent-terminal supplement 的 revive/resume 不再依赖 `resumableCheckpoints`（该 map 只负责 agent 重启后的 in-flight 任务恢复），改为按 `related_task_id` 查最近一条带 `resume_checkpoint` 的 worker trace。
- `TraceStore.findLatestResumeCheckpointByTaskId()` 先查内存 trace，再按 task index 读落盘 JSONL；只接受 `trigger.type='task'` 且有 checkpoint 的 trace，避免 dispatcher/message trace 干扰。
- 普通 `resume_task` / self-healing 重启恢复路径保持原语义，仍使用 `traces-running-<taskId>.jsonl` 加载的 `resumableCheckpoints`，并继续负责清理死 running checkpoint 文件。
- 回归：同进程刚完成的 task 即使不在 restart map 里，也能被 recent-terminal supplement 复活；历史 checkpoint 版本不匹配时只降级 new_task，不误清 running checkpoint。

## 2026-06-29 — Dispatcher 支持 recent terminal task 续聊

- dispatcher 的「可补充任务」清单从仅活跃任务扩展为：活跃任务 + 同 channel/session 最近 24h 内结束的 completed / recoverable failed 任务，recent terminal 按 `completed_at desc` 取最多 3 个；不限制 sender，排除 cancelled 和自恢复/人工取消类 failed。
- LLM 动作集合保持不变，仍然只暴露 `supplement / new_task / stay_silent`；recent terminal supplement 走内部 `revive_task_for_supplement` + `resume_task_with_supplement`，普通状态机仍禁止终态直接转回 executing。
- 失败兜底：revive 或本地 resume 失败时降级新建 task；若 admin revive 已成功但本地 resume 拒绝，会 best-effort 标 failed，避免留下假 executing。
- 协议已同步到 `crabot-docs`：`protocol-agent-v2.md` / `protocol-admin.md`。验证：agent dispatcher/orchestration/resume 测试 151 个通过，admin recent-task/state/self-healing 测试 45 个通过，agent/admin `tsc --noEmit` 通过。

## 2026-06-29 — Agent LLM 重试策略改为固定 10 次

- 按主人确认，取消 180s retry window；LLM 可重试错误改为固定最多 10 次重试，间隔 `1s → 2s → 4s → 8s`，之后封顶 `8s`。
- `retry-utils` 和 `callNonStreaming` 都走同一套 capped exponential backoff；保留流式缓冲整流重试，mid-stream 断流会重发整请求直到成功或 10 次耗尽。
- 回归：更新 `retry-utils.test.ts` 覆盖固定延迟序列；`tests/engine/call-non-streaming.test.ts` 覆盖“首个 attempt 超长仍继续重试”。验证：`pnpm --dir crabot-agent exec vitest run tests/engine/call-non-streaming.test.ts`、`pnpm --dir crabot-agent build`。
- 说明：`crabot-docs/superpowers/specs/2026-06-22-network-suspend-resume-design.md` 仍标记为草拟；正式协议/状态机尚无 `suspended`，本次未引入未定稿状态。

## 2026-06-26 — Admin UI 升级提醒与一键升级（已合 main + push origin `bf8b3f7`）

设计/计划：`crabot-docs/superpowers/specs/2026-06-25-admin-ui-upgrade-design.md` + `crabot-docs/superpowers/plans/2026-06-25-admin-ui-upgrade.md`。**source 模式一键升级端到端真实跑通（preparing→restarting→done），真空期仅 9 秒。**

- **三态安装形态适配**：`release`（无 `.git`，比 GitHub latest tag）/ `source`（有 `.git`，`git ls-remote origin main` + `merge-base --is-ancestor` 判远端是否领先本地，**不 fetch、不用 cat-file**）/ `system`（`/etc/crabot/cluster.version` 存在）。**deploy_mode（个人/团队）与 install_kind（源码/release）拆成独立维度做卡片标注**；system mode 改渲染只读卡片（版本+提示 `sudo crabot upgrade`，无升级按钮）。source 仅工作区干净且在 main 才启用一键升级。
- **后端**（`crabot-admin/src/version/`）：`VersionService`（capability + 6h 缓存 + release/source 检查，HTTP 走全局代理、git 注入 proxy env）；`UpgradeRunner`（canUpgrade 受理 + startUpgrade spawn detached + status 读写 + 10min stale 守卫）；3 接口 `/api/system/version{,/check}` + `/upgrade`。**`crabotHome` 用运行代码根（`CRABOT_HOME` env / 模块编译位置），不从 data_dir 反推**。
- **升级脚本 `scripts/ui-upgrade.mjs`（build 前置两阶段）**：① 准备阶段（实例照常运行）`git pull` + build/download，**失败不停服务、零影响**；② 切换阶段（停机秒级）`stop → migrate → start -d`。stdio 重定向到 `data/logs/upgrade.log`（失败可查死因）。脱离 admin 进程组，`crabot stop` pkill 不误杀。`release.mjs` 拆 `downloadRelease`（运行期）/`extractRelease`（停机期），`downloadAndExtract` 留兼容 CLI。
- **前端**：`services/version.ts` + `useSystemVersion`（共享缓存）+ Sidebar 红点 + `VersionUpgradeCard`（轮询状态机 preparing/restarting/done/failed，失联=重启中、5min 超时）。
- **前置根治**：memory `uv run/sync` 加 `--frozen`，禁启动改写 `uv.lock`（否则 source「工作区干净」判定被漂移打挂）。
- **端到端测试揪出并修复的真 bug**（多轮真实升级实证）：① crabotHome 从 data_dir 反推 → 误判 release + `current_version=null` + spawn 不存在脚本 → 改运行代码根；② `cat-file -e` 被任意 fetch 污染误判已含 → 改 `merge-base --is-ancestor`；③ 升级启动竞态（spawn 前同步写 status）；④ **build 在 stop 之后**（真空期=整个 rebuild）→ build 前置，真空期压到 9 秒；⑤ `stdio:ignore` 升级失败零日志 → 重定向 `upgrade.log`；⑥ **DATA_DIR 漂移**（ui-upgrade 继承模块级 DATA_DIR 当顶层 → status 写 `data/admin/admin/` 双层、`start -d` 误报「无密码」停机后起不来）→ startUpgrade 传顶层 DATA_DIR。终审另修 timer 卸载泄漏 / stale lock / CSS / ls-remote 空串守卫 + 清死代码。
- **遗留 minor**：source 模式 `last_upgrade.from/to_version` 显示 `null`（readVersion 读 VERSION 文件，source 用 git）——改读 `git rev-parse --short HEAD` 即可，纯显示不影响功能。

## 2026-06-19 — Crabot 备份/迁移 Plan 2：导入（worktree `crabot-backup-import`，未合 main）

设计/计划：`crabot-docs/superpowers/specs/2026-06-19-crabot-backup-import-design.md` + `crabot-docs/superpowers/plans/2026-06-19-crabot-backup-import.md`。

- **导入已实现**：归档按 id 记录级合并回运行中实例（skip/overwrite），保 id 不断交叉引用。统一「导入」向导（泛化原 OpenClaw 向导，按 manifest `product` 自动分流 crabot/openclaw）+ CLI `crabot import`（离线）。
- **Phase A 导出补强**：gather 改按记录过滤内置（`is_builtin`/`is_system`/`type==='builtin'`），移除 agent/channel implementations 类别条目——归档只含用户自建项。
- **Phase B 导入核心**：`mergeById` 纯函数 + `schedule-arm`（过期 once 置 disabled）+ `read-archive-category` + 各 manager `upsertById`（provider/channel/mcp/subagent/template）+ memory `import_long_term` RPC（写回 long_term + 同步索引）+ `runCrabotImport` 编排。
- **Phase C 入口**：Admin `/api/backup/import/{overview,execute}`（overview 按 product 分流，execute 接 ImportDeps）+ 向导泛化 + CLI `crabot import`。
- **验证**：单测全绿（backup 套件 44 + memory pytest 3 + 各 manager upsert）；**离线 CLI 全链路 round-trip 27 项不变量全 PASS**（id 保留 / 内置过滤 / 密钥 scrub / 过期 once 禁用 / 跨引用完好 / skip·overwrite / memory·skill 落盘）；round-trip 中发现并修复 CLI skill_dir 跨机器断链 bug。
- **待办**：Admin Web 在线导入 + memory RPC 在线路径 + scheduleEngine arm 的**浏览器端到端自测**（需 live 环境，被运行中实例挡住，未做）；C1 review 标注的两处跟进——导入引用非内置 agent-implementation 会孤儿（当前全内置不触发）、agent reload 用 `initialize()` 有幂等再入副作用。

## 2026-06-19 — Crabot 备份/迁移 Plan 1：导出（已合 main，merge 481e058）

设计/计划：`crabot-docs/superpowers/specs/2026-06-19-crabot-backup-migration-design.md` + `crabot-docs/superpowers/plans/2026-06-19-crabot-backup-export.md`。本质=泛化 OpenClaw 导入机器，备份/迁移走同一套在线 additive 导入。

- **导出已实现**：`crabot-admin/src/backup/`（types→categories→scrub-secrets→manifest→gather→pack→export-archive 七模块）+ Admin 端点 `GET /api/backup/{options,export}`（真流式下载）+ Admin Web `/backup` 页面 + CLI `crabot backup`（bootstrap，离线可用）
- 类别（粗粒度）：config / channels(+friends) / skills / memory / tasks；密钥默认 scrub，`--include-secrets`/勾选含入并强提示；归档 `crabot-backup-<ts>.tar.gz`（manifest.json + payload/）
- memory：长期记忆走 `long_term/` markdown 文件复制；短期记忆在线经 `export_memories` RPC、CLI 离线跳过
- 验证：19 单测（真文件 I/O + tar round-trip）全绿、CLI 端到端产出有效归档、前端 build 绿、整体终审通过
- **待办**：Task 10 浏览器端到端自测（需 live 环境，被运行中实例挡住，未做）；**Plan 2 = 导入**（在线 additive、skip/overwrite 冲突策略、跨版本门控、向导 UI）尚未开始

## 2026-06-11 — Master Chat 重构 Phase 2+3（已合并 main，merge 7be178d）

Phase 1 之后两期一并完成，整个三期重构收官。分支 `feat/master-chat-phase2`→`feat/master-chat-phase3`，33 commit 合入。spec：[`2026-06-10-master-chat-redesign-design.md`](crabot-docs/superpowers/specs/2026-06-10-master-chat-redesign-design.md)。

- **Phase 2 媒体双向**：base-protocol `MessageContent` 加 `media?: MediaItem[]` 多附件；Admin 内置 `MediaStore`（带 TTL 简易媒体存储，默认 30 天可在聊天设置弹窗配置 + 看占用，改 TTL 即时清扫，每日定时清扫）；入站走 `POST /api/chat/messages` multipart（Node 内建 `Request.formData()` 解析，无三方依赖，累计字节硬熔断）；出站 `send_message` 媒体收存进 store；media-resolver 多图注入同一 VLM turn；前端附件上传（粘贴/拖拽/选择）+ 图文卡 + lightbox + markdown 嵌图补 token
- **Phase 3 历史体验**：进页瞬时锚底（`useLayoutEffect` + `initialPositionedRef` 守门，修哨兵首屏连环加载）；**修了根因——消息容器 `flex:1` 缺 `minHeight:0` 导致整窗口滚动而非容器滚动**（[[feedback-frontend-verify-in-browser]]）；日期分隔符；ChatMessageItem 提取 + React.memo
- **消息级任务图标**（取代中途的"进行中任务条"设计）：任务状态挂到触发它的消息气泡旁（spinner/✓/✗ + tooltip + 点击跳 trace）；消息↔任务关联由 Admin 回填（chat_callback 回填 user 消息 / append_message 反向回填 worker 回复 + `chat_message_tagged` 推送）；30s 轮询兜底
- **交互**：消息引用（右键菜单引用/复制/删除 + 选中文本引用，markdown 引用块传递）；右键消息整行背景高亮；多行 textarea 输入框（双发送模式可切换并记忆）；整页粘贴附件；清空历史二次确认；删单条消息（`DELETE /api/chat/messages/:id` + `chat_message_deleted`）
- **测试隔离修复**：admin 测试经默认 MM 端口污染开发机 live 实例（写测试消息进真实聊天库 + 制造 recovery 噪音）——vitest.setup.ts 死端口隔离；存量污染用 `scripts/cleanup-test-pollution.mjs` 清理（309 消息 + 51 任务）
- 三端全绿：admin 739 / agent 1285 / web tsc+build。已知 flake：self-healing 跨文件并发偶发 1 失败，单跑必过

## 2026-06-11 — Master Chat 重构 Phase 1（已合并 main）

Admin Web 聊天界面从"几乎不可用"修到可用。spec：[`2026-06-10-master-chat-redesign-design.md`](crabot-docs/superpowers/specs/2026-06-10-master-chat-redesign-design.md)，三期分期，本次 Phase 1。

- **核心架构**：admin-web 成为伪 channel——Admin 注册标准 `send_message` RPC（协议 §3.20.3），worker 出站零特判直达聊天界面；`chat_callback` 保留给 dispatcher 同步路径
- **任务状态卡**：派 worker 时 `task_created`（携带 task_id）把占位转为状态卡；admin 状态机咽喉 `applyStatusTransition` + `handleUpdatePlan` 推 `chat_task_update` 驱动卡片实时更新；`GET /api/chat/tasks/:id` 供刷新 hydrate；点击跳 `/traces?task_id=`（顺手修掉 `/tasks/:id` 死链）
- **异步派发**：admin chat 派 worker 从 awaitWorker:true 改 false——旧同步等待会撑爆 process_message RPC 超时（"看不到输出"主因之一）
- **实测揪出的存量大坑**：chat-manager 合成身份 `friend_id='master'` 与真实 master friend UUID 不一致 → 权限解析落 minimal 模板 → **worker 工具全被滤光（tools=[]）**，模型只能把 send_message 写成 XML 正文，回复链路静默断裂数月。修复：`resolvePrincipalPermissions` 识别合成 master id（无记录时直接 master_private 模板）
- 其他修复：system_event 误降级为媒体占位、pushToClient WS 竞态抛错污染状态机、worker loop 异常时任务卡 executing 致状态卡永久转圈
- 新增测试 15 个（admin 713 全绿、agent 1281 全绿）；协议文档先行修订（protocol-admin §3.20）
- **Phase 2 待做**：MessageContent 加 `media[]` 多附件 + 图片/文件双向 + 上传 API（已知技术债：Phase 1 媒体占位文本有损落盘，见 spec）；**Phase 3**：历史滚动体验打磨

## 2026-06-11 — 修 agent ~13 小时 OOM 自动重启（zod globalRegistry 泄漏）

- 现象：home-m2u.local 上 agent 进程跑 ~13h 后堆 2.2GB OOM crash，MM auto_restart 拉起
- 根因（heap snapshot 实证）：worker 每轮 LLM turn 经 buildToolsDynamic 重建 crab-memory / crab-messaging in-process MCP server，zod v4 `.describe()` 把 schema clone 写入 globalRegistry（强引用 Map 永不清除）→ 每轮净增整棵 schema 树 ~2-3MB
- 修复：两个文件的工具 zod schema 全部提升为模块级常量（schema 与 task 上下文无关，ctx 都在 handler 闭包里）；registry 条目变成启动时固定有限集
- 回归测试：`tests/mcp/zod-registry-leak.test.ts`——重复构建 server 断言 globalRegistry 条目零增长

## 最新里程碑（2026-06-09 — Skill 改造 filesystem-native）

按 [Anthropic Agent Skills 业界标准](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) 重构 skill 存储模型：从"数据库 entry 嵌入 content 字段"改成"filesystem 目录是唯一真相源"。修了 zip 上传只取 SKILL.md 丢失 scripts/references/assets 的核心 bug。

- 起因：用户问"上传 skill 存哪"时发现 `importFromZip` 只读 SKILL.md，整个 zip 里的 scripts/references/assets 静默丢弃；git 导入同样残缺；importFromLocalPath 直接 reference 用户原目录用户 rm 就崩。深查后发现这不是单个 bug，是整套实现违反业界标准——业界规范要求"Skills exist as directories on a virtual machine"，而我们把"目录"压成了 JSON 的单个字符串字段
- 设计（spec：[`2026-06-09-skill-filesystem-native-design.md`](crabot-docs/superpowers/specs/2026-06-09-skill-filesystem-native-design.md)）：
  - skill 以标准 Anthropic 目录形态存储在 `<data_dir>/admin/skills/<skill-id>/`
  - 三条导入路径（zip / local / git）统一 unpack 到该目录
  - `registry.json` 只存元数据，不存 content（前端通过 REST 兼容 wrapper 即时附加 content 字段 → 零前端改动）
  - Agent 启动期只拿 Level 1 metadata（name + description）+ skill_dir 绝对路径；Skill 工具触发时才 fs.readFile（真正的 progressive disclosure）
  - previous_snapshot 改成 `.snapshots/<id>-<ts>/` 文件夹 swap，不再嵌进 JSON
  - 启动期自动迁移 legacy skills.json（含 .bak-<ts> 备份）
- 重要决策：
  - 前端零改动：REST `toRestEntry` wrapper 即时 readFile SKILL.md 拼回 content 字段
  - agent 子进程同主机，admin 传 skill_dir 绝对路径让 agent 直接 fs.read，不再"复制一份到 instance 私有目录"
  - 数据迁移幂等：legacy 字段已迁完的不重跑；scanned/builtin 不复制文件只清 content 字段
  - update/restore 改文件夹 swap 后 atomicity 经过 2 轮 review 加固：copy→tmp→rename + 三段 swap catch 分支区分 step A/B 失败
  - 三条导入路径全部走同一个 `installSkillFromDirectory(srcDir, sourceMeta, overwrite?)` 底层函数（DRY + 统一行为）

改动覆盖（14 个 commits + 1 个 polish）：
- `feat(admin/skills): 加 installSkillFromDirectory 底层函数（filesystem-native 三路径统一入口）`
- `fix(admin/skills): installSkillFromDirectory 加 rename 回滚 + 测试严格化（review I1+I2+I3）`
- `fix(admin/skills): importFromZip 完整 unpack zip 到磁盘（修 scripts/references/assets 丢失 bug）`
- `polish(admin/skills): importFromZip 补绝对路径 zip-slip + .extract 清理测试 + hoist path.resolve（review minor）`
- `fix(admin/skills): importFromLocalPath 改成复制到 data_dir（防用户原目录变动）`
- `fix(admin/skills): importFromGit 下载完整 archive 而非只取 SKILL.md`
- `refactor(admin/skills): 删除 handleDuplicateOnImport（已被 installSkillFromDirectory 取代）`
- `refactor(admin/skills): SkillRegistryEntry 删 content + update/restore 改文件夹 swap (filesystem-native)`
- `fix(admin/skills): update/restore atomicity 修复 + 测试守卫严格化（review I1+I2+I4+M3）`
- `feat(admin/skills): REST 序列化即时附加 content 字段（前端兼容过渡）`
- `feat(admin/skills): 加 GET /api/skills/:id/previous-content + diff modal 适配新接口`
- `refactor(agent/skills): SkillConfig 删 content 加 skill_dir + 删 writeSkillsToInstancePath/.skill_dir marker`
- `chore(agent/skills): 清理 Task 9-10 后的 unused imports`
- `feat(admin/skills): 启动期自动迁移 legacy entry 到 filesystem-native 布局（含 .bak 备份）`
- `docs(protocols): SkillConfig 协议改 filesystem-native（删 content 加 skill_dir）+ 加 previous-content endpoint 说明`（crabot-docs 子仓库）

涉及 8 个核心文件：
- `crabot-admin/src/mcp-skill-manager.ts` — SkillRegistryEntry / 三条导入路径 / update / restore / migrateLegacyEntries / toRestEntry / readPreviousContent
- `crabot-admin/src/index.ts` — 8 个 REST handler 走 toRestEntry + 新 `/previous-content` endpoint
- `crabot-admin/src/types.ts` — SkillConfig 删 content 加 skill_dir
- `crabot-admin/src/builtin-skills.ts` — 改 skill_dir 引用 + 3 个 builtin SKILL.md git mv 到目录结构
- `crabot-admin/web/src/pages/Skills/SkillDiffModal.tsx` — 改用 `/previous-content` endpoint + loading/error 状态
- `crabot-agent/src/types.ts` — SkillConfig 删 content 加 skill_dir required
- `crabot-agent/src/agent/agent-handler.ts` — 删 writeSkillsToInstancePath/getInstanceSkillsDir + computeSkillsHash 改 skill_dir
- `crabot-agent/src/engine/tools/skill-tool.ts` — 整个重写，从 skillDirByName 直接 fs.read，删 `.skill_dir` marker 解析

测试：13 个新测试 + 重写若干 + 删 3 个过时（覆盖 installSkillFromDirectory 4 用例 / importFromZip 5 用例 / importFromLocalPath 2 用例 / importFromGit 4 用例 / update+restore swap 5 用例 / toRestEntry 3 用例 / migrateLegacyEntries 5 用例 + agent-handler updateSkills 4 用例 + skill-tool 重写）。admin 全套 680/680 PASS，agent 端 skill-tool 12 PASS + agent-handler 46 PASS。

spec：[`crabot-docs/superpowers/specs/2026-06-09-skill-filesystem-native-design.md`](crabot-docs/superpowers/specs/2026-06-09-skill-filesystem-native-design.md)
plan：[`crabot-docs/superpowers/plans/2026-06-09-skill-filesystem-native.md`](crabot-docs/superpowers/plans/2026-06-09-skill-filesystem-native.md)

剩余手测（建议 ship 前完成）：
1. 准备一个标准 Anthropic skill（SKILL.md + scripts/ + references/）打成 zip → Web `/skills` 上传 → 检查 `data/admin/skills/<id>/` 含 scripts/references → 通过 agent 调 `Skill("xxx")` 验证 `<skill_resources>` 列出附属文件
2. 编辑 SKILL.md → 检查 `.snapshots/<id>-<ts>/` 完整保留旧目录 → 点"应用上一版"验证 restore swap
3. 启动 admin 让现网 10 个 legacy skill 走 migrate → 检查 `data/admin/skills.json.bak-<ts>` 备份 + `data/admin/skills/<id>/` 目录建立
4. 从 anthropics/skills GitHub repo 子目录导入 → 验证完整 archive 下载（不再只有 SKILL.md）

## 最新里程碑（2026-06-09 — Admin 密码管理重构）

把 admin 密码从 `data/admin/.env` 明文升级为 `data/admin/credentials.json`（scrypt hash），加首登强制改密 + JWT epoch 撤销老 token 机制 + Bash hook 拦截 agent 自改密码。

- 起因：明文存 .env 无首登强制改密机制，无运行时改密 API，无吊销老 token 手段；agent 可能自行修改密码而绕过审计
- 设计：
  - `data/admin/credentials.json`：算法 scrypt + salt + hash + params + is_temp（初始化密码标记）+ token_epoch（JWT 吊销计数器）+ 时间戳 + changed_via（start | cli | web）
  - readCredentials 内嵌 .env 兜底迁移（任何入口都走迁移逻辑；仅含密码键时自动删 .env，否则报错）
  - rotateCredentials 改密专用包装（验证旧密码 → epoch++ → hash 新密码）
  - JWT payload 增加 `e: token_epoch`；admin 改密后 epoch++，老 token 携带的 e 值不匹配，login 返回 TOKEN_REVOKED；internal-token（sub='internal'）豁免 epoch 检查
  - REST /api/auth/change-password 端点 + /api/auth/me 获取 isTemp 状态
  - chat-manager/pty-manager 同步切到 verifyJwtWithEpoch async 验证，避免 WebSocket 路径绕过 epoch 失效
  - Web 首登 PrivateRoute 守卫 isTemp=true → 强制跳 /setup-password 页；顶栏「修改密码」Dialog（旧密码 → 新密码二次确认）
  - Bash PreToolUse hook 拦截三类命令：`crabot password/reset-password` 子命令、`/api/auth/change-password` 端点、`data/admin/credentials.json` 直接文件修改
- 重要决策：
  - 临时密码沿用 crabot start 交互式输入（由用户决定初始密码），只多打一行日志 "This is a temporary password"
  - scrypt 使用 Node.js 原生 crypto 模块，无新依赖
  - admin 进程不缓存密码，每次 login 实时读 credentials.json，支持后台改密无需重启
  - .env 迁移后若仅含密码键自动删除；若含其他配置则拒绝迁移（保护用户手动维护的其他变量）

改动覆盖（17 个 commits）：
- `feat(admin): credentials.ts 加 scrypt hashPassword/verifyPassword 纯函数`
- `feat(admin): credentials.ts 加 read/write 原子落盘（0600）`
- `feat(admin): credentials 自动迁移旧 data/admin/.env 的 CRABOT_ADMIN_PASSWORD`
- `feat(admin): credentials.rotateCredentials 改密专用包装（epoch++/is_temp=false）`
- `feat(admin): types 加 ChangePassword/Me + 4 个错误码 + LoginResponse.is_temp`
- `feat(admin): verifyJwtWithEpoch async 包装（人类 token 受 epoch 失效，internal 豁免）`
- `feat(admin): handleLogin 改用 credentials.json + 返回 is_temp + JWT 带 epoch`
- `feat(admin): REST 拦截改用 verifyJwtWithEpoch async + 区分 TOKEN_REVOKED`
- `feat(admin): /api/auth/change-password + /api/auth/me + 首登免旧密语义`
- `feat(admin): chat-manager/pty-manager 切到 verifyJwtWithEpoch（改密同步失效 WS 老 token）`
- `feat(cli): crabot password 走 credentials 存储（hash + epoch++ + 撤销老 session）`
- `feat(cli): crabot start 切到 credentials.json（写 is_temp=true + 不再注入 env）`
- `chore(cli): start.mjs 清理不再使用的 writeFileSync 导入`
- `feat(admin-web): authService 加 getMe/changePassword + LoginResponse.is_temp`
- `feat(admin-web): AuthContext 加 isTemp + refreshMe + markPasswordChanged`
- `feat(admin-web): /setup-password 页 + PrivateRoute is_temp 路由守卫`
- `feat(admin-web): 顶栏加「修改密码」按钮 + ChangePasswordDialog`
- `feat(admin-web): 401 TOKEN_REVOKED 给出明确提示`

E2E（自动化）：
- ✅ start.mjs 新建 credentials.json is_temp=true
- ✅ crabot password 改密 epoch++、is_temp=false、changed_via=cli
- ✅ legacy .env 迁移 + 自动删 .env
- ✅ Bash hook deny：三种命令模式全部拦截，不误伤 crabot start

**待办（用户手动 e2e）**：
1. 启动 admin Web 用临时密码登录 → 强制跳 /setup-password
2. 新建密码 → logout 自动 → 用新密码重登成功
3. 顶栏「修改密码」走完整 flow（旧密码错误提示 / 成功改密后 → logout → 老 token 401 TOKEN_REVOKED）
4. CLI `crabot password` 改密时 admin 进程在跑 → UI 立即 401 → 用新密码重登
5. **手动 sync worktree .claude/settings.local.json 的 hook entry 到 main repo**（.claude/ gitignored，无法 commit；包含 deny-password-mutations PreToolUse hook）

**Follow-up（独立 spec / session）**：
- alert() 换 toast 方案（内在网络发散，留整个 session 处理）
- 登录失败 rate-limit（防暴力破解）
- 密码强度策略（必须含数字+字母，长度 8+ 字符）
- ChangePasswordDialog UI 接入项目通用 Modal 组件库
- AdminConfig.password_env 字段下个发布周期清理（预期无调用方）

spec: [crabot-docs/superpowers/specs/2026-06-08-admin-password-management-design.md](crabot-docs/superpowers/specs/2026-06-08-admin-password-management-design.md)
plan: [crabot-docs/superpowers/plans/2026-06-08-admin-password-management.md](crabot-docs/superpowers/plans/2026-06-08-admin-password-management.md)

---

## 上一里程碑（2026-06-07 — Skill 保留上一版 + Admin UI diff + 修 undo bug）

skill 加 N=1 上一版快照（嵌入式存进 skills.json），新增 restore swap 能力 + REST endpoint + CLI 命令；Admin Web 加角标 + diff modal + 应用上一版按钮；顺手修了 `crabot skill add --overwrite` 的 undo bug（旧 reverse 是 delete 等于删库）。

- 起因：master 想优化 skill 后能对比"改前 vs 改后"或一键回退；agent 自我反思后改自己的 skill 也需要回退能力。同时发现 `crabot skill add --overwrite` 的 undo 实际是 delete，是 silent data loss bug
- 设计：
  - SkillRegistryEntry 加 previous_snapshot 嵌入字段（N=1 覆盖式，含 content + skill_dir 附属文件；单文件 1MB / 总 5MB 阈值）
  - SkillManager.restore() swap 语义；磁盘 atomic rename 写回；失败 throw 不更新 json 保持一致
  - admin install 响应加 was_overwrite 标志；CLI 据此分支（true → restore reverse，false/undefined → delete reverse，旧 admin 兼容）
  - Admin Web 用 react-diff-viewer-continued 渲染 diff，左侧文件列表 + 右侧 split/unified diff
- 重要决策：builtin skill 不参与（update 路径已被拦死，restore 也拒）；附属文件 diff MVP 仅显示快照侧（当前侧需 admin 加 dir-files endpoint，留作 follow-up）；不支持任意历史（N=1 满足 80% 场景）

改动覆盖（9 个 commits）：
- `feat(admin): SkillRegistryEntry 加 previous_snapshot + update 打快照`
- `feat(admin): SkillManager 加 restore + writeSkillDirFiles`
- `feat(admin): POST /api/skills/:id/restore + install 响应加 was_overwrite`
- `feat(cli): 新增 crabot skill restore <ref> 命令`
- `fix(cli): skill add --overwrite 的 reverse 改成 restore（修 undo bug）`
- `feat(cli): undo executeReverse 加 skill restore <ref> 分支`
- `docs(skill): 重生成 crabot-cli 命令参考（含 skill restore）`
- `feat(admin-web): Skills 页加上一版角标 + 对比 modal + 应用上一版按钮`
- `docs(progress): skill 上一版 + Admin UI diff 完成`

spec：[`crabot-docs/superpowers/specs/2026-06-07-skill-previous-version-and-diff-design.md`](crabot-docs/superpowers/specs/2026-06-07-skill-previous-version-and-diff-design.md)
plan：[`crabot-docs/superpowers/plans/2026-06-07-skill-previous-version-and-diff.md`](crabot-docs/superpowers/plans/2026-06-07-skill-previous-version-and-diff.md)

测试：skill-snapshot.test.ts 全套（readSkillDirFiles / writeSkillDirFiles / update snapshot / restore swap）；skill.test.ts（buildSkillAddReverse 分支）；undo.test.ts（skill restore dispatch）。

**待办（用户手动 e2e）**：
1. 装一个 user skill → `crabot skill show <name>` 看 previous_snapshot 为 undefined
2. 改 SKILL.md 后 `crabot skill add --path X --overwrite` → previous_snapshot 有值，UI 角标显示 `v_prev → v_current`
3. UI 详情 "查看对比" → diff modal 显示 SKILL.md 红绿差异
4. UI "应用上一版" → 二次确认 → content 复位
5. `crabot skill restore <name>` 再切回去 → swap 工作
6. `crabot undo`（在 --overwrite 后跑）→ 走 skill restore 路径而不是 delete
7. builtin skill restore → 报错 "是内置的，不能 restore"
8. 在 skill 目录里加 references/foo.png → update → restore → png 被删

**Follow-up（独立 spec / session）**：
- admin 加 `GET /api/skills/:id/dir-files` endpoint 把当前附属文件传给前端，让 diff modal 完整显示双侧 references diff
- snapshot 多版本历史（N=3 或无限）作为下一阶段
- `skill add --overwrite` 加 LLM 内容审核（同 schedule add，agent 改 builtin/user skill 时双闸门）

---

## 上一里程碑（2026-06-06 — CLI schedule add target schema 修复 + schedule update 命令）

修 CLI `schedule add` 的 target schema bug（旧实现写 legacy `task_template.input.target_*`，新协议要求顶层 `target_session`），补 `--interval-seconds` 触发器对齐 admin UI，并新增 `schedule update <ref>` 命令字段覆盖范围对齐 admin UI 编辑器。

- 起因：2026-06-05 的 trigger_messages 统一改造把 `Schedule.target_session` 升级为顶层一等字段，admin POST handler 不再读 `task_template.input.target_*`；CLI 旧实现仍写 legacy 字段 → CLI 新建带 target 的 schedule 触发时 trigger_message.session 是 SYSTEM_SESSION 哨兵，send_message 硬拒绝 → schedule 触发了但 worker 发不出消息。同时 CLI 缺 update 命令，改任何字段只能 delete + add（违反 rollback-over-confirm 原则）。
- 设计：
  - **修 add target schema**：CLI 写顶层 `target_session: {channel_id, session_id, type}`，三个 target-* flag 共生共死（任一缺失抛 INVALID_ARGUMENT）；新增 `--target-type <private|group>` flag
  - **补 add --interval-seconds**：admin UI 已支持 interval 触发器，CLI 此前只有 cron + once；三种 trigger flag 互斥
  - **新增 schedule update**：字段覆盖范围对齐 admin UI 编辑器（name/description/enabled/trigger 字段级（同类型内）/task_template 字段级/target_session 三态）；纯函数 `buildUpdateScheduleBody(current, opts)` 集中字段映射 + 校验；GET snapshot → merge → PATCH，undo 走 `--restore-snapshot` 通用路径；TS 类型 `ScheduleSnapshot` 本地最小定义（CLI 不 import admin 类型）
  - **undo.ts 扩展**：`SNAPSHOT_RESTORE_PATH` 加 schedule + regex 加 schedule + executeReverse export 以便单测
- 重要决策：update 不进 LLM 内容审核（add 进，因为 add 是首次审；update 只改字段不扩展工具权限）；不引入 trigger 跨类型修改能力（cron → once 等需 delete + add 或 admin web）；不动 admin 协议 / agent 侧 runner / handleUpdateSchedule（已就位）

改动覆盖（9 个 commits）：
- `fix(cli): schedule add 写顶层 target_session 替代 legacy input.target_*`
- `feat(cli): schedule add 补 --interval-seconds 触发器`
- `feat(cli): 注册 schedule add 的 --interval-seconds 和 --target-type flag`
- `feat(cli): 加 buildUpdateScheduleBody 骨架 + 顶层标量字段`
- `feat(cli): buildUpdateScheduleBody 支持 trigger 字段级 merge`
- `feat(cli): buildUpdateScheduleBody 支持 task_template 字段级 merge`
- `feat(cli): buildUpdateScheduleBody 支持 target_session 三态`
- `feat(cli): 新增 schedule update <ref> 命令`
- `docs(skill): 重生成 crabot-cli 命令参考（schedule add/update 字段更新）`

spec：[`crabot-docs/superpowers/specs/2026-06-06-cli-schedule-update-and-target-fix-design.md`](crabot-docs/superpowers/specs/2026-06-06-cli-schedule-update-and-target-fix-design.md)
plan：[`crabot-docs/superpowers/plans/2026-06-06-cli-schedule-update-and-target-fix.md`](crabot-docs/superpowers/plans/2026-06-06-cli-schedule-update-and-target-fix.md)

测试：schedule.test.ts 65/65（29 add 既有 + 7+12+9+8=36 buildUpdateScheduleBody 全套），undo.test.ts 7/7（6 既有 + 1 新 executeReverse schedule restore-snapshot）。

**待办（用户手动 e2e）**：
1. `crabot schedule add --title test --priority normal --cron "*/5 * * * *" --target-channel <CH> --target-session <SESS> --target-type private --disabled` → GET 验证顶层 `target_session` 有值
2. `crabot schedule update <id> --description "改了"` + `crabot undo` 验证 snapshot 还原
3. 改 target_session 后跑 `crabot schedule trigger` 验证 trigger_message.session 切到新目标
4. 改内置 daily-reflection schedule description 验证 is_builtin 可编辑
5. 跨类型修改报错文案符合 spec §5（如 cron schedule 给 `--interval-seconds` 报"当前 schedule 是 cron 类型..."）
6. 三个 target-* 缺一报错文案

**Follow-up（独立 task / session）**：
- CLI `schedule update` 不进 LLM 内容审核的决策可能需要 revisit（如果用户实际 use case 揭示 update 也能造成 worker 越权）
- cmdParts 段历史性缺少 `--description` / `--task-description` / `--task-type` / `--tag` / `--timezone` / `--disabled` 的 push（pre-existing issue，影响 undo log 回溯完整性）
- 部分实施步骤里 TS LSP diagnostics 出现陈旧 cache（说 export 不存在但 tsc 实际通过），不阻塞，但若频繁出现可考虑研究 LSP cache 失效机制

---

## 上一里程碑（2026-06-05 — Goal 模式软约束化 + worker workflow 重组）

把 goal 模式从代码层硬门控改成 prompt 软约束；worker workflow 重组成 5 段方括号名字风格（[阅读理解]/[信息收集]/[意图澄清]/[目标承诺]/[规划与执行]）；删除 worker turn-0 supplement_task / stay_silent 早退工具（dispatcher 已吃掉决策）；GOAL_MODE_GUIDANCE 拆为流程图融入 WORKFLOW + 深度说明独立段 GOAL_MODE_DETAILS；supplement 注入文案常量化 + goal mode on/off 双 variant；删除 WORKFLOW_GROUP（群聊主流程跟私聊一致）。

- 起因：goal 模式当前两个落地决策过紧——(a) todo 工具被 hasGoal 硬门控，讨论场景也想用 todo 列分支被卡；(b) goal 判断段（GOAL_MODE_GUIDANCE）跟主工作流（WORKFLOW_PRIVATE）分裂，LLM 视角下流程跟决策点不在一起。同时 research_collector 在流程图里没显式位置（跟 code_planner 硬绑定不一致），实测 LLM 经常不派、context 撑大
- 设计：
  - **代码层**：取消 todo 工具的 hasGoal 硬门控（一行：`hasGoal: () => true`）；删除 worker 端 supplement_task / stay_silent 工具及相关代码（实际是 dead code，dispatcher 在 worker spawn 前已经做了相应决策）
  - **prompt 层**：WORKFLOW_PRIVATE 拆为 5 段方括号名字常量 + `buildWorkflow({ goalModeEnabled })` 函数化（goal mode 关时省略 [目标承诺] 段位）；GOAL_MODE_GUIDANCE → GOAL_MODE_DETAILS 用 agent 视角重写（没有 engine / hook / harness 等工程术语）；删 WORKFLOW_GROUP（dispatcher 已吃掉群独有 turn 0 triage）
  - **supplement 文案双 variant**：goal mode on/off 分别注入不同模板（GOAL 含 set_task_goal 三分支提示，BASIC 只含 "调整方向" 一句），由 deliverHumanResponse 按 taskState.triggerType 推算
  - **research_collector 流程位置**：when_to_use 首句加 "信息收集类工作的默认派遣对象——main 工作流 [信息收集] 段位优先派此 subagent"，跟 code_planner 在流程图硬绑定一致
- 重要决策：保留 dispatcher 端 supplement / stay_silent 决策（dispatcher 该有的能力不动）；保留 engine `turnZeroOnly` 框架作扩展点；保留 audit gate + endTurnGate 机制；scheduled 任务硬关 goal mode 保留（独立 follow-up 重新设计 audit 路径）

改动覆盖（7 个 commits）：
- `refactor(dispatcher): refine immediate_reply guidance`（pre-existing dirty diff cleanup）
- `feat(agent): remove todo hasGoal hard gating, todo always allowed`
- `refactor(agent): goal mode soft-control prompt redesign (WORKFLOW + GOAL_MODE_DETAILS + supplement template)`（Task 2-5 合并）
- `refactor(agent): remove worker-side supplement_task and stay_silent tools (dispatcher already covers these decisions)`
- `feat(admin): research_collector when_to_use first line emphasizes default for [信息收集] step`
- `docs(progress): mark goal soft-control workflow redesign as complete`

spec：[`crabot-docs/superpowers/specs/2026-06-05-goal-soft-control-workflow-redesign-design.md`](crabot-docs/superpowers/specs/2026-06-05-goal-soft-control-workflow-redesign-design.md)
plan：[`crabot-docs/superpowers/plans/2026-06-05-goal-soft-control-workflow-redesign.md`](crabot-docs/superpowers/plans/2026-06-05-goal-soft-control-workflow-redesign.md)

测试：crabot-agent 1174/1180（4 pre-existing engine 失败无关：trace-store SIGKILL / e2e permission / query-loop onTurn × 2）；crabot-admin tsc + build 全绿。

**待办（用户手动）**：
- Task 8 端到端 6 场景验证：讨论场景（无 goal + todo）/ 任务场景（有 goal + audit gate）/ supplement 注入文案 / scheduled task（goal mode 硬关）/ dispatcher 路径未损坏 / WORKFLOW_GROUP 删除后群聊行为一致

**Follow-up（独立 spec / session）**：
- scheduled 任务 audit 死锁问题——audit fail 时无法 ask_human 会永远循环。候选解法：A. audit fail N 次后 admin 代 agent 调 send_master_private 主动通知；B. scheduled audit 改"事后报告"不阻塞 worker；C. fail 一次即 task 标 failed。倾向 B+C 组合
- `createTodoTool` 接口的 `hasGoal` 参数本期保留向后兼容，可在确认无引用后彻底移除
- `agent-handle-trigger.test.ts` 等测试文件里残留的 `triggerArrivedAtMs` / `overdueInjected` 字段引用（pre-existing tech debt，2026-06-03 dispatcher-immediate-reply spec 删 overdue 时遗留）

---

## 上一里程碑（2026-06-05 — trigger_messages 统一 + Schedule.target_session 一等字段）

把 worker 接收任务输入的两条并行通道（`task.task_description` + `context.trigger_messages`）收敛为单通道，schedule 的目标会话从半结构化 input 字段升级为一等可选字段。

- 起因：`task_description` 字段在 dispatcher 触发路径只作"一句话分类标注"无实际价值，但在 scheduled 路径作为唯一输入兜底；同时 schedule 目标会话半埋在 `task_template.input.target_*`（部分 schedule 干脆把目标群 ID 直接埋在 description 文本里），口径不一致
- 设计：
  - `trigger_messages` 成为 worker 接收任务输入的**唯一通道**
  - `ExecuteTaskParams.task.task_description` 字段彻底删除（agent 协议 + 调用点）
  - Scheduled task 通过 `system_event` 子类型 `scheduled` 表达（sender=crabot 自身）
  - `Schedule.target_session?: { channel_id, session_id, type }` 升级一等可选字段，admin RPC + web UI 全套支持
  - 无 target_session 时用 `SYSTEM_SESSION` 哨兵（`crabot-shared`），`crab-messaging.send_message` 硬拒绝该哨兵
  - `buildTaskMessage` 重写为单段 `## 会话历史` 时间线，合并 trigger + recent 按 timestamp 排序

改动覆盖（10 个 commits）：
- **crabot-docs**：`protocol-agent-v2.md` §3.4 trigger_messages 注释补强；`base-protocol.md` `SystemEventType` 加 `'scheduled'` + system_event 双来源约束（Channel 平台事件 vs 系统内部触发）
- **crabot-shared**：新增 `SYSTEM_SESSION` 哨兵常量
- **crabot-agent**：`types.ts` SystemEventType 扩展；`ExecuteTaskParams.task.task_description` 删除；dispatcher schema/prompt 无需改动（已无该字段）；`buildTaskMessage` 重写单段时间线；`ScheduledTaskRunner` 构造 system_event trigger_message；`crab-messaging.send_message` 拒收 SYSTEM_SESSION；worker prompt 加 "系统触发任务说明" 段
- **crabot-admin**：`Schedule.target_session` 一等字段 + create/update/get/list RPC 支持 + `validateTargetSession` 校验；启动时一次性迁移 `task_template.input.target_*` → `target_session`（幂等，channel offline 兜底）
- **crabot-admin-web**：Schedule 编辑器加 channel + session 联动 dropdown，自动派生 session.type，支持"清除目标会话"

spec：[`crabot-docs/superpowers/specs/2026-06-04-trigger-messages-unified-design.md`](crabot-docs/superpowers/specs/2026-06-04-trigger-messages-unified-design.md)
plan：[`crabot-docs/superpowers/plans/2026-06-04-trigger-messages-unified.md`](crabot-docs/superpowers/plans/2026-06-04-trigger-messages-unified.md)

测试：crabot-agent 1175/1181（4 pre-existing engine 失败无关）；crabot-admin 561/561；admin-web tsc + build 全绿。subagent 路径 `BgAgentRegistryRecord.task_description` 等 13 处 task_description 引用按 spec 明确保留不动。

**待办（用户手动）**：
- Task 13 端到端 4 场景验证（每日反思无 target / github-ai-news 迁移后有 target / 普通消息触发无回归 / agi-a-share 文本埋藏未迁移）
- agi-a-share schedule 目标群 ID 当前仍埋在 description 文本里，可在 admin web 手动改成 target_session 配置

**已知 follow-up**：
- crabot-shared dist 传播到 channel-feishu pnpm cache 偶发延迟（dev.sh / Task 2 / Task 10 实施时遇到过），单独 follow-up
- `runScheduleMigration` 在 schedules-load try 块内，若 persist 失败 outer catch 会误打 "No existing schedules data" 日志（cosmetic）

---

## 上一里程碑（2026-06-03 — SceneProfile v0.3.0：删 global + scene 参数权限分级）

修一个被 trace c829e70b 暴露的产品语义错误 + agent 工具签名 bug：

- 起因：feishu-2 群一条 trace 死循环 22 轮调 `get_scene_profile({type:'global'})`——拿到的「global 画像」实际是另一个群的群规则，agent 反复重试 → 第 23 轮把本群规则又错写进 global slot
- 根因 1：`SceneIdentity` 的 `global` 分支在产品语义上不成立——跨场景共享应当走 agent 模块的「AI 性格提示词」，不该混进场景画像
- 根因 2：`scene` 参数在普通对话场景下不应暴露给 LLM——当前场景由 ctx 唯一确定，让 LLM 自己挑 = 给「猜错 scene」开门

改动：
- **protocol-memory.md**：v0.2.0 → v0.3.0；§"v0.3.0 协议变更" 子节 + §3.27.6 新 SceneProfile 章节（修原断链「详见 protocol-admin §SceneProfile」）
- **crabot-memory**：`SceneIdentity` 收 2 路；`scene_profile_store.py` 启动时 `DELETE WHERE scene_type='global'; DROP INDEX IF EXISTS ux_global;`；`_parse_scene` 接到 global 抛 ValueError；测试改写 8/8 PASS
- **crabot-agent**：`MemoryTaskContext` 加 `isMasterPrivate`；`crab-memory.ts` 三个 scene_profile 工具按 ctx 分叉——master 私聊 scene 必填可操作任意场景；其他 ctx scene 字段不暴露，强制 ctx 推断；删 `only_public` 字段；tsc 0 errors
- **crabot-admin**：URL key 解析去 global 分支；前端 `services/memory.ts` SceneIdentity 收 2 路、`SceneProfileList.tsx` 过滤器去掉「全局」选项；admin 34/34 + web 208/208 PASS
- **db 迁移**：`data/memory/metadata.db` 备份后 `DELETE FROM scene_profiles WHERE scene_type='global'`（1 行）+ `DROP INDEX ux_global`

spec：[`crabot-docs/superpowers/specs/2026-06-03-scene-profile-global-removal-and-permission.md`](crabot-docs/superpowers/specs/2026-06-03-scene-profile-global-removal-and-permission.md)

**Follow-up（未做）**：agent loop 检测「连续 N 轮同 tool + 同 input」guard，强制注入提示或 end_turn，避免类似死循环再次出现（独立小 spec，不在本里程碑范围）。

---

## 上一里程碑（2026-05-20 — Phase 5 阶段 3b：Trace 页面优化）

Trace 页面四块优化 + 文件拆分：
- dispatch_call / dispatch_action span 类型补全（agent union + admin web 渲染）
- sub_agent_call 内联嵌套展开（点击展开子 trace span 树，banner 显示 subagent name）
- 去 front/worker 二分 UI 文案（保留代码层兼容旧 trace 数据）
- 顶部 StatusBar（磁盘占用 + trace 数） + 手动清理 dialog + 自动清理 retention 设置 + daily cron
- 2002 行 pages/Traces/index.tsx 拆 9 个聚焦文件

spec：`crabot-docs/superpowers/specs/2026-05-19-trace-page-redesign-design.md`
plan：`crabot-docs/superpowers/plans/2026-05-19-trace-page-redesign.md`

主要改动：
- `crabot-agent/src/types.ts`：AgentSpanType union + DispatchCallDetails/ActionDetails
- `crabot-agent/src/core/trace-store.ts`：getDiskUsage + cleanupOldTraces(dryRun)
- `crabot-agent/src/unified-agent.ts`：注册 2 个新 RPC handler
- `crabot-admin/src/types.ts`：GlobalModelConfig.trace_retention_days
- `crabot-admin/src/index.ts`：/api/agent/traces/disk-usage GET + /api/agent/traces/old DELETE
- `crabot-admin/src/trace-cleanup-cron.ts`：daily cron + retention 检查 + parseCleanupParams
- `crabot-admin/web/src/pages/Traces/`：utils.ts + 8 个组件文件 + 多个测试文件
- `crabot-docs/protocols/`：§8.2 表 + §3.24 REST 表 + AdminGlobalModelConfig 字段

**已记录的 follow-up（不阻塞本里程碑）：**
- agent 端 `unified-agent.ts:2286-2304` 有独立每日清理（默认 30 天，用 `TRACE_RETENTION_DAYS` env 控制），与 admin cron 并行运行。后续应删除 agent 自清理，让 admin cron 是唯一入口。
- admin cron 实际是「启动后每 24h」一次，protocol §3.24 描述为「每天 03:00」——需要要么改 impl 算到下一个 03:00，要么把 protocol 改成「每 24h」。
- `cleanupOldFiles` 在 trace-store.ts:555 标 @deprecated 但暂未删除；上面项落地后可一起清。
- `SpanDetailPanel` 老 span type label 仍英文（Model/Iterations/Tool 等），新 dispatch 已中文化。下次顺手统一。
- web 端 `services/trace.ts` 与 agent 端 `types.ts` 双写 `AgentSpanType`/details union，存在 drift（如 web 有 llm_retry 但 agent 没有）。后续移到 `crabot-shared` 统一。

---

## 上一里程碑（2026-05-19 — Phase 5 阶段 3a：Subagent Admin UI 落地）

落地 Admin Web 的 Subagent 管理 UI：列表页 / 6-tab 编辑 dialog / Agent 配置页加 timeout_seconds + overdue_reminder_enabled。Backend REST `/api/subagents` 在阶段 1-2c 已成熟，本阶段只做 UI；可视化管理替代手动改 `data/admin/subagents.json`。

spec：`crabot-docs/superpowers/specs/2026-05-19-subagent-admin-ui-design.md`
plan：`crabot-docs/superpowers/plans/2026-05-19-subagent-admin-ui.md`

主要改动（4 个代码 commit，TDD 全程，subagent-driven-development 流程）：
- `crabot-admin/web/src/types/index.ts`：加 `ModelRole` / `BuiltinCapabilities` / `SubAgentBase` / `SubAgentRegistryEntry`（与后端 admin/src/types.ts 字段 100% 镜像）+ `AgentInstanceConfig` 加 `timeout_seconds?` / `overdue_reminder_enabled?`
- `crabot-admin/web/src/services/subagent.ts`：CRUD 5 个 method（list/get/create/update/remove，沿 skillService pattern）+ 5 测全过
- `crabot-admin/web/src/pages/Subagents/SubagentList.tsx`：列表 + enabled toggle + 删除（builtin 不可删，可禁用）+ 4 测全过
- `crabot-admin/web/src/pages/Subagents/SubagentEditor.tsx`：6-tab dialog（基本 / 触发条件 / 角色与工作流 / 模型 / 内置能力 / MCP + Skill 白名单）+ 7 测全过；研究角色 file_system 默认关在「内置能力」tab 直接展示
- `crabot-admin/web/src/pages/Agents/AgentConfig.tsx`：末尾追加「触发处理」section（2 字段）+ 7 测全过（含 2 新）
- `crabot-admin/web/src/App.tsx`：加 `/subagents` 路由
- `crabot-admin/web/src/components/Layout/Sidebar.tsx`：「模型与 Agent」section 加菜单「Subagent 管理」

验收：tsc 0 errors（admin + web） / 全 web 测试 162/162 PASS / 全 admin 测试 411/411 PASS / `./dev.sh build` 完整成功（Vite 31 modules / dist/web/assets/index-*.js 1.0MB gzip 284KB）。

待 master 跑端到端：
1. 浏览器打开 `/subagents` → 看到 3 个 builtin 行（code_planner / code_writer / research_collector）+ 「+ 新建」按钮 / 「编辑」「删除」按钮的禁用态
2. 编辑 research_collector → 6 tab 切换 + Tab 5 file_system 默认未勾 + Tab 6 勾上 scrapling → 保存 → `cat data/admin/subagents.json` 验证 allowed_mcp_server_ids 已更新
3. 新建一个自定义 subagent（如 test_helper），保存 → 列表显示「自定义」chip + 删除按钮可用
4. 切到 `/agents/config` → 看到「触发处理」section → 改 timeout_seconds=60 + 保存 → `data/admin/agent-instances.json` 验证

Follow-up（不阻塞，留待后续 commit）：
- SubagentList badge 颜色与 SkillList 不一致（灰 vs 紫）— 视觉一致性
- `subagentService.create` 类型签名（`Omit<...>`）与 `formToPayload` 返回（`Partial<...>`）不严格匹配，editor 用 `as never` 绕过；建议精确两者类型
- `SubagentEditor.WhitelistTab` provider/mcp/skill 加载失败无 toast，静默 fallback 空数组
- `SubagentEditor.ModelTab` 从 role 切到 specific 时 hardcode `model_role='cost_effective'`，round-trip 丢原值

## 上一里程碑（2026-05-19 — Phase 5 阶段 2c：research_collector 重构 + WORKFLOW 派发改造）

阶段 2b 落地后发现两个问题：① vision builtin 在多模态时代价值缩水（所有 vision-capable 模型已可直接读图）；② WORKFLOW [执行] 段预设 `[self]/[vision]/[code]` 派发标签把决策框死，自定义 subagent 没法自动接入。阶段 2c 一次性解决这两个：

- **vision → research_collector**：删 vision builtin，加 `research_collector`（model_role=vision 复用多模态能力 / max_turns=20 / `file_system: false` 干净边界——只调 mcp + crab-memory 不读写本地 / `allowed_mcp_server_ids: []` 默认空 → 用户启用时手动勾选 scrapling 等 web mcp / 5 段 prompt 强制 ≤2K tokens markdown summary 输出）
- **WORKFLOW 派发改造**：[规划] 段 todo content 不再标 `[self]/[vision]/[code]`；[执行] 段保留**唯一硬约束**（编码任务 code_planner → code_writer 串联）+ **main 自主决策**（看 `delegate_task` 工具 description 里的 `<available_subagents>` 选 when_to_use 最匹配的 subagent）+ **核心派发原则**（subagent 价值 = 消化大量 raw 输入并精炼输出，避免 main context 撑爆）。效果：用户自定义 subagent 自动出现在 `<available_subagents>` 段，main 看到就能用，无需改 prompt
- **新 lifecycle 操作 `pruneObsoleteBuiltins`**：admin 启动时把已经从 `getBuiltinSubAgents()` 列表中移除但 registry 还在的 builtin entry 删掉 + console.warn 告知"如曾通过 Admin UI 编辑过 prompt，自定义内容将丢失"。从 2b 升级 2c 时启动日志会看到 `[SubAgentManager] 删除已废弃的 builtin subagent: vision (id=builtin-vision)...`

spec：`crabot-docs/superpowers/specs/2026-05-19-subagent-phase2c-research-collector.md`
plan：`crabot-docs/superpowers/plans/2026-05-19-subagent-phase2c-research-collector.md`

主要改动（5 个代码 commit + 1 个协议文档 commit，TDD 全程）：

- `crabot-admin/src/builtin-subagents.ts` 删 5 个 VISION_* 常量 + 加 5 个 RESEARCH_COLLECTOR_*；entry 第 3 项整重写（`builtin-research-collector` / model_role=vision / file_system=false / allowed_mcp_server_ids=[]）
- `crabot-admin/src/subagent-manager.ts` `pruneObsoleteBuiltins(activeBuiltinIds)` 方法 + 5 个新单测（清理 / 保留自定义 / idempotent / 空 list / 多个废弃同清）
- `crabot-admin/src/index.ts` `initialize()` 在 `subAgentManager.initialize()` 后 `seedBuiltin()` 前接入 `pruneObsoleteBuiltins(getBuiltinSubAgents().map(s => s.id))`
- `crabot-admin/tests/builtin-seeding.test.ts` `vision` → `research_collector` 测试用例改写（验 model_role=vision + file_system=false + allowed_mcp_server_ids=[]）
- `crabot-agent/src/prompts/agent-sections.ts` `WORKFLOW_PRIVATE` [规划]/[执行] 段重写：删派发标签 / 加硬约束 + 例外条款 / 加 main 自主判断三层结构 / 加核心派发原则；snapshot 自动更新 12/12 PASS
- `crabot-docs/protocols/protocol-agent-v2.md` §11.8 表 vision → research_collector；§11.8.2 整段重写（删 `[self]/[vision]/[code]` 表 / 留硬约束 + main 自主决策 + 自定义自动可用说明）

启动验证（在 e2e 验收时观测到）：
- admin 启动日志含 `[SubAgentManager] 删除已废弃的 builtin subagent: vision (id=builtin-vision)...` + `[Admin] Seeded 3 builtin subagents`
- `cat data/admin/subagents.json` 看到 3 个 entry：code_planner / code_writer / research_collector（无 vision）
- `curl /api/subagents` 返回 3 个 entry，research_collector 的 model_role=vision、file_system=false
- `curl /get_config` agent 端拿到 3 个 subagent，model 已实时解析

待 master 跑端到端：
1. 发编码诉求消息 → trace 看 main 是否走硬约束（code_planner → code_writer 串联），不应自己用 Write 改用户代码
2. 发简单聊天消息 → trace 看 main 是否直接 send_message，不应误委派 research_collector
3. 配 vision-capable 全局默认 model（当前实例 `research_collector` model 解析时 fallback 到 cost_effective 的 `kimi-for-coding`，应配 vision role 让其用真正多模态模型）
4. 启用 scrapling 等 web mcp → 通过 admin UI 编辑 research_collector 的 `allowed_mcp_server_ids` 勾选

## 上一里程碑（2026-05-18 — Phase 5 阶段 2b：内置 subagent + plan-and-execute 落地）

阶段 2a 调研产物落地：admin 启动时 seed 3 个 builtin subagent（code_planner / code_writer / vision）+ 3 个 builtin skill（superpowers v5.0.7 MIT 的 writing-plans / systematic-debugging / verification-before-completion）+ main worker prompt 在 enabled subagents 含 code_planner 时自动注入 PLAN_AND_EXECUTE_GUIDE 引导段。

spec：`crabot-docs/superpowers/specs/2026-05-18-subagent-phase2b-builtin-design.md`
plan：`crabot-docs/superpowers/plans/2026-05-18-subagent-phase2b-builtin.md`
research：`crabot-docs/superpowers/research/2026-05-18-coding-skill-survey.md`

主要改动（6 个代码 commit + 1 个协议文档 commit + 1 个 progress commit，TDD 全程）：

- `crabot-admin/builtin-skills/*.md` 3 个 SKILL.md snapshot（superpowers v5.0.7 MIT，加 attribution header；项目根级，dev/prod 通过 `join(__dirname, '..', 'builtin-skills')` 均可访问）
- `crabot-admin/src/builtin-skills.ts` getBuiltinSkills() + BUILTIN_SKILL_IDS
- `crabot-admin/src/builtin-subagents.ts` getBuiltinSubAgents() + BUILTIN_SUBAGENT_IDS + 完整 5 段 prompt 文本（来自调研报告）
- `crabot-admin/src/mcp-skill-manager.ts` SkillManager.seedBuiltinSkills（idempotent）
- `crabot-admin/src/index.ts` AdminModule.initialize 接入两个 seedBuiltin + 启动日志
- `crabot-agent/src/prompts/agent-sections.ts` PLAN_AND_EXECUTE_GUIDE 常量
- `crabot-agent/src/prompts/assemble-agent.ts` hasCodePlanner option + 条件注入
- `crabot-agent/src/agent/agent-handler.ts` buildSystemPrompt 计算 hasCodePlanner = subAgents 含 code_planner
- `crabot-docs/protocols/protocol-agent-v2.md` §11.8 内置 subagent + §11.8.1 内置 skill + §11.8.2 plan-and-execute 引导段 + §11.8.3 writer 上报格式

build + dist smoke test 已通过：dist/builtin-skills.js + dist/builtin-subagents.js 编译后可加载 3 个 skill + 3 个 subagent（writing-plans content 6284 字节）。13 个新增 admin 测试 + 4 个新增 agent 测试全绿。

待 master 跑端到端：
1. `./dev.sh stop && ./dev.sh` 重启
2. `curl http://localhost:3000/api/skills` 看 3 个 is_builtin=true 的 builtin skill（writing-plans / systematic-debugging / verification-before-completion）
3. `curl http://localhost:3000/api/subagents` 看 3 个 builtin subagent
4. 发"帮我加个 X 功能"类编码消息 → trace 看 worker 先调 code_planner（拿 PLAN_PATH）再调 code_writer（按 plan 实施）

## 上一里程碑（2026-05-18 — Phase 5 阶段 1：subagent 架构骨架完成）

把 subagent 体系从 hardcoded `SUBAGENT_DEFINITIONS` 升级为 admin-managed 资源；worker 工具表注入单一 `delegate_task` 工具；agent role 整顿为 3 个 ModelRole；不预填任何内置 subagent（阶段 2b 才 seed code_planner/code_writer/vision）。

分支：`feature/subagent-phase1`（4 个 repo：root / crabot-admin / crabot-agent / crabot-docs）。12 个代码 commit + 2 个 docs commit，TDD 全程。

spec：`crabot-docs/superpowers/specs/2026-05-17-subagent-customization-and-admin-ui-design.md`
plan：`crabot-docs/superpowers/plans/2026-05-17-subagent-phase1-architecture.md`

**Admin 侧（Task 1-5）**：
- `crabot-admin/src/types.ts`：新增 `SubAgentRegistryEntry` / `SubAgentConfig` / `BuiltinCapabilities` / `ModelRole`；`AgentInstanceConfig` 加 `timeout_seconds` + `overdue_reminder_enabled`
- `crabot-admin/src/subagent-manager.ts`：`SubAgentManager` 类（CRUD + 原子写 + seed 内置 + validateModelSpec），12 个单测；新增 `resolveSubAgentModel`（specific 优先 / role 回退）
- `crabot-admin/src/index.ts`：`/api/subagents` 5 个 REST handler；mutating 触发 `triggerPushAfter`；`buildSubAgentConfigsForPush` 把 entry 转 SubAgentConfig（实时解析 LLMConnectionInfo），失败 skip + warn；`pushConfigToAgentModules` 把 subagents + timeout_seconds + overdue_reminder_enabled 加入 update_config payload
- `crabot-admin/src/agent-manager.ts`：`DEFAULT_IMPLEMENTATION.model_roles` 整顿为 `powerful` / `cost_effective` / `vision`；`migrateModelConfig` 启动 migration（default/worker/smart → powerful；triage/digest/fast → cost_effective；vision_expert → vision；coding_expert 丢弃），7 个单测

**Agent 侧（Task 6-12）**：
- `crabot-agent/src/types.ts`：新增 `SubAgentConfig` / `BuiltinCapabilities`；`AgentLayerConfig` 加 3 个新字段；`UpdateConfigParams` 同步
- `crabot-agent/src/agent/subagent-prompt-assembler.ts`：5 段拼装 + 头尾守则（不轮询 / 不持久化 / 不主动副作用 / 截断重读），6 个单测
- `crabot-agent/src/agent/subagent-tool-filter.ts`：`classifyTool`（9 group）+ `filterToolsForSubAgent`，24 个单测；`delegate_task` 永远从 subagent 工具集剔除（防嵌套）
- `crabot-agent/src/agent/delegate-task-tool.ts`：`buildDelegateTaskDescription`（`<available_subagents>` 装配）+ `createDelegateTaskTool`（单一工具入口 + dispatch by subagent_type），8 个单测
- `crabot-agent/src/agent/agent-handler.ts`：删 per-subagent 循环；注入单一 `delegate_task`；新增 `makeRunSubAgent`（filter → assemble → adapter → forkEngine + trace stitching + endTrace 双路径）
- `crabot-agent/src/unified-agent.ts`：buildSubAgentConfigs 改读 `config.subagents`；删 `buildSubAgentConfigs` / `resolveSubAgentSlot` 旧方法；`handleUpdateConfig` 加 subagents 变化检测（触发 worker 重建）+ timeout_seconds / overdue_reminder_enabled 软热更；新增 `resolveTimeoutSeconds` / `resolveOverdueReminder` 默认 30s/true，4 个 `handleTriggerMessage` 调用点接入
- `crabot-agent/src/agent/subagent-prompts.ts`：删 `SUBAGENT_DEFINITIONS` 常量 + `SubAgentDefinition` interface + `DELEGATE_TASK_SYSTEM_PROMPT`；保留 `formatSupplementForSubAgent`

**协议文档（Task 13）**：
- `crabot-docs/protocols/protocol-agent-v2.md`：新增 §11 "Subagent 配置"（7 子章节）；旧 §9 标注"已被 §11 替换"
- `crabot-docs/protocols/protocol-admin.md`：§3.19 加 Subagent 注册表 + ModelRole 重整两子章节

**端到端验证（待 master 自跑）**：

1. `./dev.sh stop && ./dev.sh` 重启加载新代码
2. `curl http://localhost:3000/api/subagents` → 期望返回 `[]`（阶段 1 不预填）
3. `curl -X POST http://localhost:3000/api/subagents -H 'Content-Type: application/json' -d '{...}'` 创建测试 subagent → 期望 201 + entry JSON
4. `node scripts/debug-agent.mjs traces` → 触发一条消息后看最新 trace，worker 工具表应有 `delegate_task` + description 含新 subagent
5. 检查 `data/admin/agent-instances/*.json`，原 model_config keys（如 `worker` / `triage`）应已迁移到 `powerful` / `cost_effective`
6. 删除测试 subagent + `./dev.sh stop`

阶段 2a / 2b / 3 留给后续 PR：
- 2a：coding skill 调研（hermes-agent superpowers + everything-claude-code）
- 2b：seed code_planner + code_writer + vision 内置 subagent，挂接 coding skill；main worker prompt 加 plan-and-execute 引导
- 3：Admin Web UI（SubagentList + SubagentEditor 6 tab）

## 上一里程碑（2026-05-08 — crab-messaging list_contacts/list_groups 路由修正 + 分页可见性）

修复 2026-05-08 早报 trace `f0f7d4bb` 暴露的"`list_groups` 必失败"bug：自 2026-04-04 commit `f48fbb9` 引入以来，`crab-messaging` MCP 的 `list_contacts` / `list_groups` 工具一直把 RPC 路由到 `adminPort.list_sessions`（admin 端从来没有这个 method），每次调用必返回 `Method "list_sessions" not found`，靠 LLM 改名重试到 `list_sessions` 兜底掩盖。

spec：`crabot-docs/superpowers/specs/2026-05-08-messaging-list-tools-alignment-design.md`
plan：`crabot-docs/superpowers/plans/2026-05-08-messaging-list-tools-alignment.md`

- **协议文档（crabot-docs 子 repo）**：`protocol-crab-messaging.md` §2.1 / §4 把笔误的 admin "list_contacts" 改回 `list_friends`（admin 管 Friend 表，channel 才有 Contact 概念）；§2.7 / §2.8 加错误码表。`protocol-channel.md` 新增 §3.13 list_contacts / §3.14 list_groups 接口定义（基于 PaginatedResult），§3.2 ChannelCapabilities 加 supports_list_contacts/groups 字段。`base-protocol.md` GlobalErrorCode 加 PERMISSION_DENIED。
- **crabot-shared**：`module-base.ts` 加 RpcError / RpcCallError / formatHandlerError，让 handler 抛 RpcError 时 code/details 透传到 response.error；让 RpcClient.call 收到 success=false 时 reject RpcCallError 携带原 code/details（之前只剩 message 的普通 Error）。`base-protocol.ts` GlobalErrorCode 加 PERMISSION_DENIED 常量避免下游用裸字符串。
- **crabot-channel-wechat**：types.ts 加 supports_list_contacts/groups（capability）+ 6 个 List* 协议类型。`wechat-client.ts` 加 listContacts() 调 `GET /api/v1/bot/contacts`（已有的 listGroups 复用）。`wechat-channel.ts` 注册 list_contacts / list_groups RPC handler，client 原生字段（username/nickname/chatroomName/name）映射到协议字段（platform_user_id/display_name/platform_session_id/group_name），分页 camelCase → snake_case 翻译。capability 上报 true。22 个测试。
- **crabot-channel-feishu**：同形扩展。`feishu-client.ts` 加 listContacts() 调 `contact.v3.user.list`；飞书错误码 99991672 / 99991663（通讯录读取权限缺失）翻译为 `RpcError('PERMISSION_DENIED', ..., { missing_scope: 'contact:user.base:readonly' })`，其他错误透传。`feishu-channel.ts` 注册 list_contacts / list_groups handler；handler 层 self-filter（飞书 contact API 不支持 keyword）+ case-insensitive；分页近似 has_more=true → total_pages=2（避免 N+1 误导下游）。86 个测试。
- **crabot-channel-telegram**：bot api 不支持列群/列联系人，capability 上报 false。crab-messaging 在路由前看 capability 直接返回 `CHANNEL_LIST_*_NOT_SUPPORTED` 错误码，agent 看到 hint 自然 fallback 到 list_sessions。
- **crabot-agent crab-messaging.ts**：抽出 `buildMessagingTools(deps, sandboxPathMappingsRef?)` 纯函数返回 8 个工具数组（lookup_friend / list_contacts / list_groups / list_sessions / send_private_message / send_message / get_history / get_message），让工具可单测。`createCrabMessagingServer` 改用循环 register。list_contacts / list_groups 改路由到 channelPort + 用新 list_contacts/list_groups RPC（不再调 admin.list_sessions）。三个 list 工具统一通过 `annotatePagination` 给返回叠加 has_more / is_truncated / default_page_size_applied / next_page 显式字段，避免 LLM 把单页结果当全集；通过 `translateChannelError` 把 RpcCallError 翻成结构化输出（`CHANNEL_LIST_*_NOT_SUPPORTED` 带 hint，`PERMISSION_DENIED` 透传 missing_scope）。新建 pagination-annotator / error-translator 两个独立模块。新增 6 个 crab-messaging-list 集成测试，全 agent 803 测试。
- **prompt-manager**：worker prompt 加"找群/找联系人优先顺序"段（lookup_friend → list_groups/list_contacts → list_sessions）+ 分页可见性提示（has_more=true 时不要把单页当全集）。
- **commits**：13 个 commit 全程 TDD（spec → plan → 4 个 phase 顺序推进 + 各 phase code review fix）。

**端到端验证（待 master 自跑）**：

1. `./dev.sh stop && ./dev.sh` 重启加载新代码
2. wechat：`@crabot 用 list_groups 在 wechat-棉花糖 上找包含 'Claude' 的群` → 看 trace 中只调一次 list_groups 直接命中、不再先失败再 fallback
3. wechat：`@crabot 用 list_contacts 在 wechat-棉花糖 列联系人` → 返回带 has_more / next_page / default_page_size_applied 的分页元信息
4. telegram：`@crabot 用 list_groups 在 telegram-fufu 找群` → 收到 `error_code: CHANNEL_LIST_GROUPS_NOT_SUPPORTED` + hint 引导改用 list_sessions
5. feishu：list_groups / list_contacts 看是否能正常返回；如果应用没拿通讯录 scope 应收到 `PERMISSION_DENIED` + missing_scope='contact:user.base:readonly'
6. 下一轮（2026-05-09 08:00）GitHub 早报调度：trace 应无 iter=fail+iter=retry 模式

## 上一里程碑（2026-05-07 — CLI 权限统一进 Friend + Session 模板）

把 crabot CLI 的权限闸从硬编码 `isMasterPrivate` 单 bit 升级为按发起人解析 effective permissions（friend ∪ session 并集）+ schedule add 内容 LLM 审核。master 在群聊享完整 CLI 权限；群友在被升级到 `group_scheduler` 模板的群里可创建受审核的简单定时任务。plan：`crabot-docs/superpowers/plans/2026-05-06-cli-permission-friend-session-union.md`。

- **types.ts（admin / agent / web）**：新增 `CliPerm`/`CliDomain`/`CLI_DOMAINS`/`CliAccessConfig`，扩 `PermissionTemplate`/`SessionPermissionConfig`/`FriendPermissionConfig`/`ResolvedPermissions` 各加 `cli_access` 字段。`crabot-shared` 是 `CliDomain` 的单一真相来源，admin/agent 各自重新定义 `CliPerm`/`CliAccessConfig` 但 union 字面量从 shared import 来防漂移。
- **PermissionTemplateManager**：5 个系统模板（master_private 全 write / group_default 全 none / minimal 全 none / standard 全 none / 新增 group_scheduler 仅 schedule=write 且 tool_access 含 messaging+memory+task）；normalize 自动给旧持久化数据补默认；resolvePermissions 合并 session.cli_access；旧 friendPermissionConfig 缺 cli_access 时由 normalizeFriendPermissionConfig 兜底全 'none'。
- **Admin RPC + REST**：新增 `resolve_principal_permissions`（friend ∪ session 并集；master 短路；都缺 → minimal 兜底）。helper 拆到 `permission-resolution.ts`：`unionCliPerm` rank 取大、`unionStorage` path 不一致时取受限侧（防提权）、`unionResolved` 单边返回也 deep clone（不暴露引用）。REST 路径 `POST /api/permissions/resolve-principal`。
- **Agent unified-agent**：原 `resolveSessionPermissions` / `resolveGroupPermissions` 双路径合并为 `resolvePrincipalPermissions(senderFriend?, sessionId, sessionType)` 调新 RPC；删除 4 个旧 method（净 -87/+38 行）。
- **crabot-shared cli-domains**：新增 `classifyCliSubcommand(subcommand) → {domain, kind} | null`（48 个映射含 provider test/refresh）+ `REQUIRES_CONTENT_REVIEW = new Set(['schedule add'])`。`CLI_WRITE_SUBCOMMANDS` 标 deprecated。
- **agent hook**：`block-cli-write` 升级为 `cli-permission-gate`（按 `cli_access[domain]` 判定 + schedule add LLM 审核）；worker-handler 无条件注册（不再分 master 私聊），把 `senderIsMaster` / `resolvedPermissions` / `contentReviewer` 通过 `EngineOptions → query-loop → HookExecutorContext` 透传到 hook 内部。`isMasterPrivate` 局部变量保留给 progress digest / bg entity persistence 独立语义。fail-closed 6 处：`--reveal` 永拦 / 未识别 subcommand / 缺 resolvedPermissions / cli_access 不够 / 缺 reviewer / reviewer deny。reviewer **抛错**也 fail-closed deny（hook 内显式 try/catch，防 hook-executor 把异常吞成 continue）。
- **cli-content-reviewer**：fast model 调 LLM judge schedule 描述工具是否落在 effective tool_access 范围内。fail-closed：throw / parse 失败 / 非法 verdict 全 deny。`parseVerdict` 用 bracket-balance 解析（避免 reason 字段含 `}` 提前截断）+ markdown 围栏剥离。复用 worker 自身 `sdkEnv` 的 adapter（schedule add 频率低，单独 review slot 留作 follow-up）。
- **Admin Web**：PermissionTemplate 编辑页加 cli_access 配置段（10 个 domain × none/read/write 下拉），types.ts + service 同步加 CliAccessConfig。
- **Prompt + Skill**：`crabot-cli` skill 重写到 v3.0.0；Worker prompt L264 / L401 去"仅 master 私聊"，引向"按发起人 cli_access"+ schedule 审核语义。
- **协议文档**：`crabot-docs/protocols/protocol-admin.md` §3.2 加 `cli_access` 字段 + §3.2.7 `resolve_principal_permissions` RPC 描述（**待 master 在 crabot-docs 仓库独立提交**——sibling repo 边界）。
- **测试**：crabot-shared 29/29 + crabot-admin 341/342（1 pre-existing model-provider flake）+ crabot-agent 776/776 + crabot-admin-web 145/145，4 个包 tsc 0 errors。新增覆盖：14 个 cli-permission-gate hook 单测（含 reviewer-throws fail-closed）+ 6 个 cli-content-reviewer 单测（含 bracket-balance 解析）+ 11 个 unionResolved/unionCliPerm/unionStorage 单测 + 12 个 PermissionTemplateManager.cli_access 单测 + 4 个 resolve_principal_permissions REST 集成 + 1 个 cli-domains shared 单测套（覆盖大小写敏感）。
- **端到端验证（待 master 自跑）**：4 条路径 — (a) master 群聊 `crabot mcp toggle` 全权 / (b) master 私聊回归 / (c) group_scheduler 模板群里普通群友 `@crabot 提醒张三 3 点开会` 通过审核 / (d) 同群普通群友 `@crabot 3 点跑 rm -rf` 被审核拒。

## 上一里程碑（2026-05-07 — 模块恢复 & Self-Healing）

补齐"模块意外退出后的自动/人工/agent 恢复"能力。spec/plan：`crabot-docs/superpowers/plans/2026-05-07-module-recovery-and-self-healing.md`。

- **MM 自动重启**：`ModuleDefinition.auto_restart` 字段实装；指数退避 1s/2s/4s/8s/10s + 5min 内 3 次窗口限流；超限置 status=error 并发 module.health_changed；admin/agent/memory 内置模块默认开启。
- **DiskWatcher**：MM 启动 60s 周期检查 dataDir 所在挂载点剩余空间，跌破 1GB 阈值发 system.disk_low 事件（注入式 statfsFn 便于单测，状态去抖避免重复广播）。修因 5/7 凌晨 agent 静默猝死的根因——磁盘满 ENOSPC + 没 fatal handler。
- **Admin 端口缓存失效**：onEvent 订阅 module_stopped / module_health_changed → 清 agentPort / memoryModules 相应缓存；新增 callAgentRpc helper 在 ECONNREFUSED 时清缓存重试一次；4 个 agent trace handler 切到 helper，把不可达错误返 503 而非 500（修因 5/7 admin 接口报 500 的根因）。
- **Admin REST + Web UI**：新增 `GET /api/modules`、`GET /api/modules/:id/log?tail=N`（读 data/logs/<id>.log）、`POST /api/modules/:id/restart`；admin web `/modules` 页加运行状态面板（5s 轮询 + 着色状态 + 查看日志弹窗 + 重启确认）。
- **Self-healing recovery 任务**：agent module_started(restart_count>0) 触发 admin runSelfHealingForAgentRestart：扫所有 status=executing 任务标 failed → 用 buildRecoveryTask 纯函数构造 recovery worker 任务（tags=['recovery'], priority=high, source.origin=system）→ handleCreateTask + saveData。防雪崩：跳过 tags 已含 'recovery' 的 in-flight，避免 recovery 任务自身崩了无限派生。
- **协议变更**：`protocol-module-manager.md` §6.0 加 auto_restart 字段定义 + §6.1 行为详细说明 + §4.3 system.disk_low 事件 schema + 内置模块示例 yaml；`protocol-admin.md` Task 类型尾追加 Recovery Task 约定（标识/来源/优先级/防雪崩/任务描述）。
- **测试**：crabot-core 69/69 + crabot-admin 316/317（pre-existing model-provider 失败跟本次无关）+ admin-web 145/145 + RestartPolicy/DiskWatcher/RecoveryHandler/agent-port-cache/module-rest-api 5 个新单测文件。
- **配套兜底（5/7 同期）**：crabot-agent main 入口加 process.on('uncaughtException'/'unhandledRejection') → 写 ${DATA_DIR}/fatal.log 后 exit(1)；MM 子进程 stdout/stderr 同步落到 ${DATA_DIR}/logs/<moduleId>.log（保留 console 转发用于 dev 体验）。

## 上一里程碑（2026-04-30 — 原生飞书 Channel）

新增 `crabot-channel-feishu` 模块，飞书接入脱离 OpenClaw shim，扫码 onboarding 完整 Web 流程。spec：`crabot-docs/superpowers/specs/2026-04-30-native-feishu-channel-design.md`，plan：`crabot-docs/superpowers/plans/2026-04-30-native-feishu-channel.md`。

- **新增模块 `crabot-channel-feishu`**：基于 `@larksuiteoapi/node-sdk` v1.62.1 长连接事件订阅。结构 = wechat 模块的飞书翻译版（types / SessionManager / MessageStore / event-mapper / FeishuClient / WsSubscriber / FeishuChannel / main）。支持 text/image/file 收发 + mention/quote 特性 + 6 类 IM 事件（im.message.receive_v1 + bot/user 群成员变更 + chat.updated）。WSClient onReady/onError/onReconnecting 状态对接 health。
- **协议化扫码 onboarding**（`base-protocol.md` §10 + `crabot-module-spec.md` §3.2）：新增 `onboarding_methods` 字段，模块声明交互式配置入口；`crabot-shared` 导出 `Onboarder` 接口（begin/poll/finish/cancel），handler 文件 export `createOnboarder()`。**onboarder 由 channel 模块自带**（不在 admin 内嵌平台知识），admin 仅做 UI 编排。
- **channel-feishu/src/onboard.ts**：实现 `Onboarder`，飞书设备码 OAuth（`POST /oauth/v1/app/registration` init/begin/poll）。
- **Admin OnboardingManager**：启动时扫 builtin yaml.onboarding_methods，require(handler) 加载 onboarder 缓存；通用 REST 路由 `/api/channels/onboard/(begin|poll|finish|cancel)`，body 带 `implementation_id` + `method_id`；admin 在 finish 收到 onboarder 返回的 env 后调 `channelManager.createInstance`。SSE 走 `?token=` query string 鉴权。
- **Admin Web UI**：`/channels/new` 数据驱动 picker（按每个 implementation × onboarding_methods 渲卡片 + 各 implementation 独立"手动填写"卡），`/channels/new/:implId/:methodId` 通用 onboarding 页（按 `ui_mode = qrcode/redirect/pending` 切换 widget）。
- **BUILTIN_MODULE_PATHS** 增加 `'../crabot-channel-feishu'`。
- **测试**：channel-feishu 52/52（含 11 个 onboard tests）+ admin 301/301 + admin-web 145/145，0 tsc 错误。

## 上一里程碑（2026-04-29 — Time Awareness）

让 Agent 拥有持续的时间感知能力。spec：`crabot-docs/superpowers/specs/2026-04-29-time-awareness-design.md`。

- **新增 `crabot-agent/src/utils/time.ts`**：`resolveTimezone`（含 IANA 校验 + env / Asia/Shanghai 三级 fallback）、`formatNow`（完整：日期+周+时分秒+offset+IANA）、`formatToolTimestamp`（紧凑：HH:MM:SS / 跨日 MM-DD HH:MM:SS）、`formatChannelMessageTime`（同日 HH:MM / 跨日 MM-DD HH:MM / 跨年 YYYY-MM-DD HH:MM）、`formatTaskCreatedAt`。
- **AgentInstanceConfig 加 `timezone?: string`**：admin types + agent-manager updateConfig 透传 + handleGetAgentConfig 通过 `...config` spread 自动透传给 Agent；web AgentInstanceConfig 镜像类型同步；Admin Web AgentConfig 页面加 timezone input（留空使用 Asia/Shanghai 默认）。
- **Tool result 时间戳前缀**：`tool-orchestration.ts:executeSingleTool` 所有返回路径（成功/Tool not found/Permission denied/Hook block/Tool execution error）统一在 content 前 prepend `[HH:MM:SS]\n`；`front-loop.ts` tool_result push 等价处理；`ToolCallContext` + `EngineOptions` 加 `timezone` 字段透传。
- **User message 顶部当前时间**：`buildUserMessage`（front-handler）和 `buildTaskMessage`（worker-handler）顶部拼 `当前时间: 2026-04-29 周三 18:30:00 +08:00 (Asia/Shanghai)`，作为日期/时区基准。
- **Channel 消息渲染统一**：抽 `prompt-manager.ts:formatChannelMessageLine`，Front recent_messages、Worker recent_messages、Worker trigger_messages 全部切到统一函数（之前 trigger 带 ISO、recent 不带的不一致已修复）。
- **任务字段调整**：Front handler 任务级别"执行已 X 秒"改"创建于 HH:MM"（绝对时间、cache 友好）；保留"第 N 轮"和工具级别"已 X 秒"。
- **System prompt 时间约定**：`FRONT_RULES_SHARED` 和 `WORKER_RULES` 各加"## 时间感知"段，约 80 tokens，被 cache，说明 user message / tool_result / 历史消息 / 任务字段的时间格式语义。
- **测试**：crabot-agent 573/573 + crabot-admin 298/298 + crabot-admin-web tsc 0 errors。手动验证：buildUserMessage 输出含 "[11:57] / [04-28 11:27]" 跨日切换；executeToolBatches 输出含 `[HH:MM:SS]\n<output>` 头部；invalid timezone 自动 fallback Asia/Shanghai。
- **已否决方案**：ephemeral marker（不写回历史无锚点）、每工具自己加（30+ 工具维护成本）、完整格式（p99 增量 1568 tokens 偏大）、按工具选择性（复杂度收益比不划算）、Hermes 式 system prompt 一次性注入（长任务跨小时失准）。

## 上一里程碑（2026-04-28 — Simplify Agent MCP/Skill Config）

砍掉 Agent 实例配置里的 `mcp_server_ids` / `skill_ids` 维度——这一层从来没被 Admin Web UI 暴露过（AgentConfig.tsx 是 unified 单页，没 instance/role 选择入口），数据模型表达 per-instance 灵活性但 UI 没对应入口暴露，是虚假能力。改成全局启用层：MCP/Skill 在各自管理页 enable/disable，所有 agent 实例共用。spec：`crabot-docs/superpowers/specs/2026-04-27-simplify-agent-mcp-skill-config-design.md`，plan：`crabot-docs/superpowers/plans/2026-04-27-simplify-agent-mcp-skill-config.md`。

- **types.ts**：`AgentInstanceConfig.mcp_server_ids/skill_ids` + `UpdateAgentConfigParams.mcp_server_ids/skill_ids` 标 `@deprecated`，软迁移保留兼容期，运行时忽略。
- **handleGetAgentConfig**：返回的 `mcp_servers` / `skills` 改为 `manager.list().filter(s => s.enabled)`（单一真相），不再做"用户绑定 + 内置"两路合并。
- **9 个 mcp/skill REST handler 加 push trigger**：`triggerPushAfter(reason)` 私有 helper + fire-and-forget，每次 mcp/skill 注册/更新/启用/禁用/删除/导入后通过 `pushConfigToAgentModules` 推到运行中的 Agent。新增 4 mcp + 5 skill push trigger 单元测试。
- **AgentConfig.tsx**：移除 MCP/Skill 勾选 section，改为 read-only 列表 + react-router Link 跳转到 `/mcp-servers` 和 `/skills` 管理页；`mcp_server_ids` / `skill_ids` 从 `AgentUnifiedConfig` interface 移除。新增 5 个组件渲染测试。
- **Skills 管理页补 toggle UI**：之前只有 MCP 管理页有启用/禁用按钮，Skills 没有；加 `handleToggle` + `StatusBadge` 启用/禁用 pill + toggle button（仿 MCPServerList pattern）。复用现成 `<StatusBadge status="active|inactive">` 替换内联 rgba。
- **测试**：admin 全套 + admin-web 145/145 + tsc 0 errors，e2e 手动验证通过。

## 上一里程碑（2026-04-25 — Phase A 自学习反馈信号闭环）

修复长期记忆 v2 Observation 观察期 pass/fail 信号链路。设计核心：Front Handler 在 reply / create_task / supplement_task 工具上携带 `user_attitude` 字段（4 档 strong_pass/pass/fail/strong_fail）；代码层根据工具语义自动锚定 task_id（reply/create_task→prev finished task 同 channel/sender 30 分钟内；supplement_task→payload task_id）；调 memory.report_task_feedback 累加 observation_pass_count / observation_fail_count；maintenance.observation_check 按净值判定 pass/fail/extend。spec：`crabot-docs/superpowers/specs/2026-04-25-self-learning-feedback-signal-design.md`，plan：`crabot-docs/superpowers/plans/2026-04-25-self-learning-feedback-signal.md`。

- **memory 侧 5 个 task**：lesson_task_usage 表 + observation_pass_count/fail_count 列；SqliteIndex 三个新方法（record/find/bump）；search_long_term 接 task_id 写表；report_task_feedback RPC + 三处分发表同步注册；maintenance.observation_check 按净值（pass-fail）判定。同步修了 stale_check_count >= 3 分支对 lesson/concept 写非法 maturity="stable" 的 pre-existing bug（按 type 分支：fact→stale / lesson→retired / concept→observation_stale tag）。
- **agent 侧 6 个 task**：types.ts 加 UserAttitude / UserAttitudeNegOnly 类型；front-tools.ts 给 3 个决策工具加 schema 字段；front-loop parseDecisionTool 解析 + 验证 enum；MemoryWriter.reportTaskFeedback fire-and-forget RPC；DecisionDispatcher dispatch 加 reportFeedbackIfPresent + findPrevFinishedTaskId 锚定钩子，删除旧 24h 时间窗 fail 路径；prompt-manager FRONT_RULES_SHARED 加 4 档判定引导（情绪用于判别不用于升级，fail 例子用"算了，就这样吧"避免"嗯，好吧"中性误判）。
- **协议文档**：protocol-agent-v2.md §5.4 加 user_attitude 字段表（含锚定对象映射 + 跳过条件）。同步发现 protocol-admin.md §3.22 误把 Front 决策工具列在 admin 协议里（架构分层错误），已拆分到 protocol-agent-v2.md §5.4 新增"Front Agent 决策工具实现"专节。
- **闭环真正收尾（Task 14）**：plan 当时把"Worker 召回时传 task_id"标了 Out of Scope，实际上不补这一环 lesson_task_usage 表永远不会被写入、整个反馈链路空跑。补 5 处：AssembleParams 加 task_id / FetchLongTermMemoryParams 加 taskId / assembleWorkerContext 透传 / fetchLongTermMemory 加守卫式 spread / decision-dispatcher.ts 创建 task 后传 task.id / mcp/crab-memory.ts MCP search_long_term 调 ctx.taskId。Front 端 tool-executor.ts 不动（Front 没 task_id）。
- **稳定 RPC ordering（I-1 fix）**：`find_lessons_used_in_task` SELECT 加 `ORDER BY lesson_id ASC`，避免 RPC report_task_feedback 返回值依赖 SQLite 隐式行序。
- **测试**：agent 477/477 pass + memory 233/233 pass（含 e2e dispatcher → memory RPC 链路 + 新增 context-assembler task_id 透传 2 测试），tsc 0 errors。
- **已知 follow-up**（不阻塞）：vote count 在 rollback/pass 后是否 reset（spec 未明示）；evolution mode 自动判定（spec §6.2 follow-up）；spec 文本说"maturity stable"应改为按 type 列举合法字面量；test fixture 重复（多个测试构造相同 store/idx/rpc 可提取）。

## 同期解决的前置 in-progress（2026-04-25）

- **N7 版本历史端到端**（spec §9.2）：数据/RPC/分发表/静态锁四层串通——store 旁路 `<id>.versions/v<n>.md`、`get_entry_version` RPC、move/purge 跟随 versions 目录迁移与清理；`tests/long_term_v2/test_rpc_spec_alignment.py` 静态扫 `module.py` 源码 `self._lt_v2_rpc.<name>` 引用集与 `LongTermV2Rpc` 公开方法集做差分，把"加了 RPC 忘了在分发表登记"这类盲区永久关掉。
- **N1-N10 测试覆盖第二轮**：spec §6/§7/§9/§10 细节口子 N1–N10 全部 ✅。修改既有 5 测试（test_maintenance/evolution/chain_of_note/rpc/rpc_update_phase3）+ 新增 6 测试文件（rule_promotion_e2e / pe_concurrent_write / pe_gated_recall_e2e / pe_gated_write_e2e / trash_cleanup_timezone / version_history_e2e）。同步 evolution.py spec §6.4 ≥3 case 晋升门槛硬约束。
- **Front prompt 防 XML mimicry**：原 worker capabilities 注入展开具体 tool 名（screenshot / mouse_click / git_status 等），某些模型（MiniMax-M2.5）看到后直接吐 `<invoke name="X">…</invoke>` 形式 XML 文本污染 reply。改为只列 category 名 + 加"工具调用硬性规则"段明示 Front 唯一可调用工具是 4 个决策工具。

## 上一里程碑（2026-04-24）

- **Memory v2 Phase 5 Admin UI 完成**：Admin Web 长期记忆管理页重做——一级 Tab（全部记忆/观察期）+ 类型/状态 Chips + 搜索 keyword/semantic + 批量操作 + 手动维护下拉 + 观察期面板替代 Proposals 审核（全自动路径）+ 详情 6 段 + 版本历史只读对比；MemoryEntriesPage 彻底清理；路由迁到 `/memory/long-term|short-term|scenes`。spec：`crabot-docs/superpowers/specs/2026-04-24-long-term-memory-admin-ui-design.md`，plan：`crabot-docs/superpowers/plans/2026-04-24-memory-v2-phase5-admin-ui.md`。24 task 全部完成，admin web 132 tests pass，tsc 无错。
- **Memory v2 全部 4 期落地**（2026-04-23）：Phase 1（数据模型 / 文件存储 / SQLite 索引 / v1→v2 迁移）+ Phase 2（6 步 hybrid 召回 + Eval harness）+ Phase 3（PE-Gated Write / Observation / Case→Rule / Frozen Snapshot / Evolution Mode）+ Phase 4（Admin UI 重做 + v1 路径清理 + 协议对齐）。Phase 4 共 22 task，1051 tests pass，验收记录见 `/tmp/memory-v2-acceptance.md`。

## 当前进行中：Agent Engine V2

**目标**：自研执行引擎，支持多 LLM 格式，内置工具，MCP 工具服务器  
**后续设计文档**：`crabot-docs/superpowers/specs/2026-05-15-agent-unified-loop-redesign-design.md`
**分支**：`feat/engine-v2`

### Phase 1 — 引擎核心 ✅ (2026-04-03)
10 个 engine 文件 ~1843 LOC, SDK 已移除, 93 tests

### Phase 2 — 多 LLM 格式 ✅ (2026-04-04)
OpenAI adapter, createAdapter factory, Front handler 迁移

### Phase 3 — 高级能力 ✅ (2026-04-04)
LLM auto-compact, sub-agent, permission system. 累计 200 tests

### Phase 4 — 核心内置工具 ✅ (2026-04-04)
Bash/Read/Write/Edit/Glob/Grep 6 个工具 + Worker 集成. 累计 203+49=252 tests
- [x] Task 17: Bash Tool (7 tests)
- [x] Task 18: Read Tool (8 tests)
- [x] Task 19: Write Tool (7 tests)
- [x] Task 20: Edit Tool (8 tests)
- [x] Task 21: Glob Tool (8 tests)
- [x] Task 22: Grep Tool (11 tests)
- [x] Task 23: Built-in Tools Index + Worker Integration (7 tests)

### Phase 5 — MCP 工具服务器 ✅ (2026-04-04)
Computer Use (12 tests), LSP (7 tests), Git (10 tests). 累计 285 tests
- [x] Task 24: Computer Use MCP (screenshot/mouse/keyboard)
- [x] Task 25: LSP MCP (TypeScript diagnostics, hover/definition stubs)
- [x] Task 26: Git MCP (status/diff/log/commit/branch/stash)

### Phase 6 — Admin 工具注册集成 ✅ (2026-04-04)
Built-in tool config, Skill tool, E2E integration. **全部 311 tests pass**
- [x] Task 27: Admin Built-in Tool Configuration (11 tests)
- [x] Task 28: Skill Execution Tool (5 tests)
- [x] Task 29: End-to-End Integration Test (10 tests)

### LSP 真实协议实现 ✅ (2026-04-04)
- [x] Task 30: LSP Client (JSON-RPC over stdio, 14 tests)
- [x] Task 31: LSP Server Manager (routing + file sync, 17 tests)
- [x] Task 32: LSP MCP Server rewrite (9 operations, 25 tests)

### 协议对齐 + 决策类型简化 ✅ (2026-04-04)
- [x] Task 33: Protocol docs alignment (7 处协议修改)
- [x] Task 34: Remove forward_to_worker → 4 种决策类型 (direct_reply, create_task, supplement_task, silent)
- [x] Task 35: Type alignment (ShortTermMemory, LongTerm, TaskSummary, Features, friend_id)
- [x] Task 36: Rename list_friends → list_contacts, add list_groups

### MCP 基础设施重构 ✅ (2026-04-04)
- [x] Task 37: crabot-mcp-tools 独立包 (Computer Use/LSP/Git stdio 入口)
- [x] Task 38: Admin MCP 注册表扩展 (stdio/streamable-http/sse + 内置注册)
- [x] Task 39: Agent McpConnector (多传输连接 + 工具转换)
- [x] Task 40: Skill 工具修复 (skillsDir 传递)

### Engine V2 重构完成 ✅
**总计**: 40+ Tasks, 298 tests (agent 298 + mcp-tools 2)
已合并到 main

---

## 已完成：去 LiteLLM 化 + ChatGPT 订阅 OAuth ✅ (~2026-04)

Agent V2 引擎直连 Provider 原生 API，LiteLLM 中间层完全移除（包括 dev.sh）。`createAdapter` 工厂按 `format` 路由到 Anthropic / OpenAI / Gemini / openai-responses。ChatGPT OAuth PKCE 落地，`buildConnectionInfo` 内部检测 token 过期并自动刷新。详见 [memory: project_remove_litellm.md](crabot-docs/memory)。

---

## 后续规划：权限系统打通

协议层完整定义，后端基础设施已有，但 Admin UI 和 Agent 工具权限未打通。

### 第一期 ✅ — 让当前能跑通（master 自用）
- [x] Worker 用 `bypass` 模式，所有工具可用
- [x] engine permission-checker 基础设施（allowList/denyList/bypass/callback）
- [x] deriveMemoryPermissions 已实现（master 无限制 / normal 按 session scope 过滤）
- [x] `ToolPermissionConfig.checkPermission` 回调接口支持路径级细粒度控制

### 第二期 — Admin UI 权限管理（让 master 能配置）
- [ ] 权限模板管理页面（CRUD 自定义模板，系统预设: master_private/group_default/minimal/standard）
- [ ] Friend 详情页增加权限模板选择器（permission_template_id）
- [ ] Session 配置页面（查看/编辑 permissions、memory_scopes、workspace_path）
- [ ] 内置工具管理页面（启用/禁用/权限级别覆盖，对应 BuiltinToolConfig）

### 第三期 — Agent 侧权限打通（让配置真正生效）
- [ ] 新增 `deriveToolPermissions(sessionPerms)` → `ToolPermissionConfig`
- [ ] Session.permissions.desktop → 控制 computer-use 工具
- [ ] Session.permissions.storage → 控制 Read/Write/Edit/Glob/Grep 路径
- [ ] Session.permissions.network → 控制 fetch/Bash 网络访问
- [ ] workspace_path → Worker task 沙箱根目录
- [ ] Worker 从硬编码 `bypass` 改为 `deriveToolPermissions` 动态计算

---

## 系统架构

```
Module Manager (port 19000)
├── Admin (RPC 19001, Web 3000)
│   ├── Friend / Permission 管理
│   ├── LLM Provider 管理（buildConnectionInfo 解析为 Provider 原生连接信息）
│   ├── MCP Server + Skill 注册表管理（全局管理 + Agent 配置引用）
│   ├── Agent 配置管理（含 MCP Server/Skill 关联）
│   ├── Web 管理界面 + Master Chat (WebSocket)
│   └── 消息鉴权网关（channel.message_received → channel.message_authorized）
├── Agent (port 由 MM 分配)
│   ├── Front Handler（快速分诊，默认 10 轮，3 次重试）
│   └── Worker Handler（深度执行）
├── Memory (Python, port 19002)
│   └── 短期/长期记忆（LanceDB 向量检索）
└── Channel(s)
    └── 微信 / Telegram / 飞书 原生模块
```

## 端口分配

| 服务 | 端口 |
|------|------|
| Module Manager | 19000 |
| Admin RPC | 19001 |
| Admin Web | 3000 |
| Memory | 19002 |
| Agent | 19005+ |
| Vite Dev | 5173 |

---

## 已完成

- [x] Module Manager — 生命周期、端口分配、事件总线
- [x] Admin 模块 — Friend 管理、Task/Schedule、LLM Provider、Agent 配置、Master Chat、PTY 终端
- [x] Agent 模块 — 编排层 + Front/Worker Handler，多格式 LLM 适配器（Anthropic/OpenAI/Gemini/openai-responses）
- [x] Memory 模块 — 短期记忆读写、向量检索、管理界面
- [x] Channel 飞书 — 完整 protocol-channel.md 实现
- [x] Channel OpenClaw Shim — 插件兼容层，jiti 加载 TS 插件
- [x] 消息鉴权网关重构 — Channel 只发布原始消息，Admin 做 Friend 解析和鉴权，Agent 订阅 channel.message_authorized
- [x] MCP Server + Skill 系统 Phase 1 — 全局注册表（protocol-admin.md §3.16/3.17 扩充），Admin 后端 Manager（MCPServerManager/SkillManager/EssentialToolsManager），Admin 前端 CRUD 页面，Agent 配置 ID 引用解析
- [x] Agent Loop 可观测性 — 通用 Trace 规范（protocol-agent-v2.md §8），Ring Buffer TraceStore，前后端可视化 Trace/Span 树
- [x] Front Handler 工具调用改进 — 保留默认工具集，maxTurns 1→3，结果路由（JSON 决策/纯文本/工具失败自动升级），简单任务直接执行、复杂任务创建 task 派 Worker
- [x] Agent 模块 Skills/MCP/聊天历史/crab-messaging 修复 — Skills UI 简化，消息预加载量优化（Front 10 条 / Worker 20 条），crab-messaging MCP Server 5 工具实现，对齐 protocol-crab-messaging.md，路径安全验证，TypeScript 编译零错误
- [x] 记忆管理界面重构 — `/memory/entries` 条目页模式拆分（browse/search/context）、长期记忆 browse API、SceneProfile 详情强化（描述非空校验 + 来源记忆链接）、SceneProfile 治理视图、记忆→画像反向链接、`/memory` 路由精简为直接跳转条目页；前端/后端定向测试与浏览器自测已通过
- [x] McpServer Protocol reuse bug 修复 — Claude Agent SDK 在 Front Handler 重试或并发消息时抛出 "Already connected to a transport" 错误；根因是 `createCrabMessagingServer()` 在 `initializeAgentLayer()` 中只调用一次，所有 `runSdk()` 共享同一个 McpServer 实例，SDK 的 `Protocol.connect()` 不允许重复连接；修复方案：将传入的 `SdkMcpServerConfig` 对象改为工厂函数 `() => Record<string, SdkMcpServerConfig>`，每次 `runSdk()` 调用时创建新的 McpServer 实例；涉及文件：`unified-agent.ts`、`front-handler.ts`、`worker-handler.ts`，TypeScript 编译零错误
- [x] SwitchMap 私聊消息合并 — 同 session 新消息到达时，被中断的消息 A 与新消息 B 合并为 `[A, B]` 一起传给 LLM（协议 §5.1）；`SwitchMapHandler` 新增 `pendingBatches` 追踪批次；`unified-agent.ts` 三处调用点（`processDirectMessage`/`handleProcessMessage`/`processAdminChatMessage`）均更新；dispatch 前增加 abort 检查防止并发双发 reply
- [x] 群聊 Debounce 消息合并 + 群聊行为改进 — 群聊已通过 DebounceHandler 合并批次传给 Front Agent；新增 `SilentDecision` 类型；Front Agent 群聊默认静默，仅 @提及或明确提问时回复；提示词外部化到 `prompts.md`（根目录），修改后重启生效
- [x] Front/Worker Handler 系统性修复 — 修复 `maxTurns` 硬编码为 3 的 bug（现在正确读取 `maxIterations` 配置）；Front 默认轮数 3→10；Worker 默认无限制轮数（不传 `maxTurns`）；提示词明确区分"已预注入的上下文"与"需工具查询的更多历史"；`prompts-worker.md` 外部化到根目录
- [x] supplement_task 纠偏机制 — Front Agent 识别用户对活跃任务的纠偏/补充消息，通过 interrupt() + streamInput() 直接注入运行中的 Worker，支持 confidence high/low 路由
- [x] Worker 进度报告改进 — 基于实际工具调用的自然进度报告，避免 generic "执行中"；content-type 判断；进度与最终结果去重
- [x] 群聊决策质量优化 — buildUserMessage 群聊 prompt 改进（参与者列表、Crabot 身份标识、sender role 标注、silent 引导）；system prompt 群聊规则强化（"你是旁听者"）；context-assembler session type 修复
- [x] Agent Trace 可观测性增强 — full LLM input/output 记录到 trace span；群聊消息批次快照；Trace 磁盘持久化（daily JSONL）
- [x] Admin guest authorization 修复 — 群聊 guest 鉴权路径缺失 return 导致消息重复处理
- [x] Channel Host 主动推送 — 通过插件 outbound adapter 主动发送消息（不依赖入站消息的 pendingDispatch），支持跨渠道发送场景
- [x] 微信 @Crabot 检测 — 通过 at_string 检测群聊 @提及，缓存群昵称
- [x] crab_display_name 管线 — Admin → Agent 传递 Crabot 在 channel 上的显示名
- [x] PromptManager 统一提示词管理 — 提示词分三层（personality / rules / additions），`data/agent/prompts/` 目录统一管理，Handler 不再自行加载提示词文件
- [x] 端到端集成测试 — 飞书/OpenClaw → Agent → 回复完整链路，验证群聊静默、私聊合并等新行为

---

## 待实现

### 🟡 中优先级

| 功能 | 说明 |
|------|------|
| AgentConfig `extra` 字段 | 支持热更新扩展配置，Admin UI key-value 编辑器 |
| 短期记忆压缩 | 保留窗口 + 语义无损压缩 |
| 长期记忆去重/合并 | CREATE/UPDATE/MERGE/SKIP 决策 |
| 混合检索 | 语义 + BM25 + 元数据多路召回 |
| MemoryBrowser 测试 OOM | `crabot-admin/web/src/pages/Memory/MemoryBrowser.test.tsx` 在当前 Vitest 环境下触发 worker out of memory，需后续拆分或瘦身测试 |
| Permission Template CRUD | 权限模板管理 |

### 🟢 低优先级

| 功能 | 说明 |
|------|------|
| Worker 多实现 | worker-code (claude-agent-sdk), worker-general (pydantic-ai) |
| Agent 自我进化 | 代码生成、自动测试 |
| Channel 微信 / Slack | 更多平台适配 |

---

## 运行命令

```bash
./dev.sh          # 构建 TS + 启动所有服务 + Vite HMR (5173)
./dev.sh stop     # 停止所有进程
./dev.sh build    # 只构建不启动
./dev.sh vite     # 只启动 Vite
```
