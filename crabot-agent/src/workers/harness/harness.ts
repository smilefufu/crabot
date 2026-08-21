/**
 * WorkerHarness —— 生命周期编排(protocol-agent-v3 §5.2/§5.5,plans/2026-07-29-mw-p3-ledger-harness.md Task 7)。
 *
 * 职责边界:harness 编排台账(LedgerStore)/信箱(WorkerInbox)/事件流(WorkerEventLog)/workspace
 * (WorkspaceManager)与三个 WorkerAdapter 实现,是 P4 manager 唯一的调用对象。harness 不感知任何
 * adapter 内部实现细节,只经 WorkerAdapter 契约方法(provision/spawn/sendInput/kill/fork/state/…)
 * 获取运行时事实——不读 adapter 的 meta-<seq>.json。
 *
 * 锁层级(必须遵守,避免 ABBA):
 *   外层:harness 自己维护的"每 worker 一把" AsyncMutex(this.mutexes,按 worker_id 取)。
 *   内层:LedgerStore 内部按 ManagerKey 维护的另一把 AsyncMutex,完全不透明,只在单次
 *        `ledger.upsertWorker(...)` 调用内部短暂持有(mutator 是同步纯函数,写盘后立即释放)。
 * harness 从不显式持有 ledger 的锁,也从不在“持有 ledger 锁”的状态下反过来等待自己的
 * per-worker 锁——每次 upsertWorker 调用都是一次独立的、有限时长的原子读改写,不会在其
 * 内部触发对 harness per-worker 锁的等待。因此两把锁只可能是“外层→内层”单向嵌套,不存在
 * ABBA。同一 worker_id 的所有编排动作(spawnWorker 的注册段、handleStateChange、killWorker、
 * queryWorker 的判定段/落账段)都在同一把 per-worker 锁的临界区内完成“读台账 → 判断 → 写台账”,
 * 不允许 check-then-act 跨 await。
 *
 * 慢调用是否在锁内:
 *   - adapter.provision / adapter.spawn:在锁内。理由——这是"从无到有注册一个 worker"的
 *     唯一时机,必须与"台账已存在该 worker_id"这件事保持原子;锁内持有的时长等于一次
 *     spawn 编排,不是高频路径,换来的正确性(不会有第二个并发操作在半注册状态下观察到
 *     这个 worker)值得。
 *   - adapter.kill:在锁内。是"一次性、有限时长"的编排动作(不是像 sendInput 那样可能被
 *     连续高频调用的路径),放锁内换来"整个 kill 序列原子完成,不会被并发的状态回调或
 *     另一次 kill/fork 打断"的简单正确性论证,没有值得牺牲这份简单性去换取的并发收益。
 *   - adapter.sendInput / adapter.fork:都不在 harness 的 per-worker 锁内(P4 Task 4 收口,
 *     fork 从锁内挪出——见下方 queryWorker 注释)。sendToWorker 只把"查台账 + 校验
 *     cancelled + 入信箱"这段放进锁的临界区(这段不含 slow adapter 调用),真正的投递
 *     经 `WorkerInbox.flush()` 在锁外进行——inbox 自己的内部 AsyncMutex 已经保证同一信箱
 *     的并发 flush 不会重复投递。这样长时间的 tmux/CLI 调用不会长期占住 harness 的
 *     per-worker 锁,不阻塞同一 worker 上的其它编排操作(如状态回调、kill)排队等待。
 *     deliver 内部对每个 item 都重新查一次台账取当前化身(而不是在入锁那次性 snapshot),
 *     避免投递期间化身已发生变化(如被 kill/交接)却仍拿着过期 handle 投递的问题;
 *     即便如此,`flush()` 与其它编排动作之间仍存在"投递到已失效化身"的极小窗口——
 *     这属于 §5.3 透明接续要处理的场景(Task 8 范围),Task 7 只保证 WorkerExitedError
 *     会原样从 sendInput → inbox.flush → sendToWorker 向上抛出,不做拦截或伪装。
 *     queryWorker 的 adapter.fork 同理:cc 的 fork() 是 `await execFileAsync` 整个无头
 *     `claude -p` 子进程跑完(几十秒到数分钟),放锁内会让同一 worker 上并发的
 *     kill_worker/send_to_worker/再次 query_worker 全部在这把锁上排队等到 fork 落地——
 *     manager 层面表现为"人类说停,卡几分钟才生效",违反 protocol-agent-v3 §4.1"manager
 *     的 loop 内不存在阻塞等待原语"的精神(P4 Task 4 review 实测复现)。修法与 sendInput
 *     同一范式:第一段锁只做"判定 + 构造 fork 请求所需的引用"(不含 adapter.fork 调用),
 *     fork 本身在锁外执行,落地后重新取锁把 fork 化身写进台账。见 queryWorker 方法注释
 *     "锁释放期间世界会变"一节。
 *
 * onStateChange 接线契约(P4 负责实际接线,P3 只提供出口):
 *   三个 adapter(builtin/claude-code/codex)都在各自构造函数的 deps 里接受一个可选的
 *   `onStateChange?: (h, state, report?) => void`,但 HarnessDeps.adapters 要求把"已经构造好的
 *   adapter"塞进来——adapter 构造在先、harness 构造在后,没法在 adapter 构造时就拿到
 *   harness 实例的方法引用,形成先有鸡还是先有蛋的问题。
 *
 *   解法:harness 把 `handleStateChange` 做成一个公开的、构造时就绑定好 this 的箭头函数
 *   字段(调用方不需要再 .bind),接线方(P4)按以下顺序组装:
 *     1. const adapters = new Map<WorkerImplId, WorkerAdapter>()   // 先建一个空壳
 *     2. const harness = new WorkerHarness({ adapters, ... })      // 把空壳传给 harness
 *     3. 逐个构造 builtin/cc/codex adapter,构造时 onStateChange: harness.handleStateChange
 *     4. adapters.set('builtin', builtinAdapter) 等
 *   第 4 步之所以能生效:HarnessDeps.adapters 的类型是 ReadonlyMap,但底层对象仍是同一个
 *   可写 Map 引用——本实现全程只通过 `this.deps.adapters.get(impl)` 按需取值,从不在构造
 *   时把它拷贝成快照,所以第 4 步之后往里 set 的内容对 harness 立即可见。三个 adapter 的
 *   状态回调最终都指向同一个 harness 实例的 `handleStateChange`,不需要 HarnessDeps 再加字段。
 */

import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import type {
  WorkerAdapter,
  WorkerImplId,
  WorkerContractState,
  IncarnationHandle,
  IncarnationRef,
  IncarnationEndReason,
  StateChangeReport,
  SpawnSpec,
  WorkerUiActionDescriptor,
  WorkerUiResponse,
  CapabilityBundle,
  WorkerCapabilityContext,
  Workspace,
  SendInputOptions,
  ForkOptions,
  WorkerTerminalView,
  NormalizedTraceEvent,
  WorkerActivity,
  IncarnationId,
} from '../types'
import type { BuiltinRuntimeFactory } from '../builtin/runtime'
import type { ResolvedPermissions } from '../../types'
import {
  CapabilityNotSupportedError,
  WorkerExitedError,
  CliInputStallError,
  WorkerImplUnavailableError,
  ForkEstablishmentError,
  QueryEstablishmentError,
} from '../errors'
import { AsyncMutex } from '../async-mutex'
import {
  isExecutableIncarnation,
  isLegacyIncarnation,
  type ExecutableIncarnation,
  type Incarnation,
  type LedgerWorker,
  type ManagerKey,
  type TaskStatus,
  type WorkerSupervision,
} from './ledger-types'
import type { LedgerStore } from './ledger-store'
import type { WorkspaceManager } from './workspace-manager'
import {
  WorkerInbox,
  type InboxItem,
  type InboxDeliveryResult,
  type InboxSettlement,
  type InboxSettledResult,
} from './inbox'
import { WorkerEventLog, type HarnessEvent, type HarnessEventDelivery, type HarnessEventKind } from './worker-events'
import { WorkerContextStore, type WorkerContext } from './context-store'
import {
  captureWorkspaceInstructions,
  cleanupClaudeWorkspaceBridge,
  prepareClaudeWorkspaceBridge,
} from './workspace-instructions'
import {
  renderHandoffPrompt,
  writeHandoffPackage,
  type HandoffEvidenceInput,
  type HandoffPackage,
} from './handoff-package'
import { WorkerTurnStore, type WorkerTurn, type WorkerTurnResolution } from './worker-turn-store'
import { NativeActivityStore } from './native-activity-store'
import {
  WorkerControlOperationStore,
  type WorkerControlOperation,
  type WorkerControlOperationKind,
  type WorkerControlOperationStatus,
} from './worker-control-operation-store'
import { WorkerUiSnapshotStore, type WorkerUiActionId, type WorkerUiSnapshot } from './worker-ui-snapshot-store'
import { projectWorkerActivity } from '../trace/activity-projection'
import { readLegacyTraces } from '../legacy-source-reader.js'
import { isLegacyContinuationAuth, type LegacyContinuationAuth } from './legacy-continuation-auth.js'
import { applyStatusTransition, canTransition, isTerminalStatus, reviveTask, taskStatusFromIncarnation } from './task-status'
import { join, dirname } from 'path'
import {
  InputDeliveryStore,
  type InputDeliveryFailure,
  type InputDeliveryFailureCode,
  type SendToWorkerResult,
  type WorkerInputDeliveryReceipt,
} from './input-delivery-store'
import {
  QueryReceiptStore,
  type QueryFailure,
  type QueryFailureCode,
  type QueryWorkerStartedResult,
  type WorkerQueryReceipt,
} from './query-receipt-store'

/**
 * 唤醒事件 `detail.text` 的上限(字符数)。
 *
 * 定值依据:
 * 1. **这是周期性成本,不是一次性成本**。这段文字每次 worker 转 idle/终态都会进一次
 *    manager 的上下文,并被 episode 日志持久化;handoff 那份 4096 是每次交接才付一回,
 *    量纲不同,不能照抄。取它的一半。
 * 2. 中文按 ~1 token/字符估,2000 字符 ≈ 2000 token,与 manager 单轮里几条最近消息同
 *    量级,不至于把台账/档案挤出窗口。
 * 3. worker 一轮的收尾发言(结论、进度、提问)绝大多数在几百字符内,2000 已覆盖典型情形。
 *
 * **截断方向按来源分**,不是一刀切(见 truncateWakeText 的 `keep`):`lastText` 是 worker
 * 说的话,开门见山给结论 → 保头；`terminal` 是 CLI 的当前终端画面,较新的内容通常在末尾
 * → 保尾。二者都只作为唤醒事件的有界现场，完整画面仍由 terminal view 读取。
 */
const WAKE_TEXT_MAX_CHARS = 2000

export const INPUT_DELIVERY_TIMEOUT_MS = 5 * 60_000
export const QUERY_ESTABLISHMENT_TIMEOUT_MS = 30_000

const INPUT_DELIVERY_FAILURE_CODES = new Set<InputDeliveryFailureCode>([
  'target_unavailable',
  'task_cancelled',
  'continuation_failed',
  'input_surface_timeout',
  'submission_unconfirmed_timeout',
  'delivery_attempt_failed',
  'abandoned_by_control_input',
  'confirmation_lost_after_restart',
])

function isInputDeliveryFailureCode(value: string | undefined): value is InputDeliveryFailureCode {
  return value !== undefined && INPUT_DELIVERY_FAILURE_CODES.has(value as InputDeliveryFailureCode)
}

function describeInputDeliveryFailure(code: InputDeliveryFailureCode): string {
  switch (code) {
    case 'task_cancelled': return 'task was cancelled before this input could be delivered'
    case 'continuation_failed': return 'worker continuation failed before accepting this input'
    case 'abandoned_by_control_input': return 'a later control input abandoned the pending composer text'
    default: return `input delivery failed: ${code}`
  }
}

function renderInputDeliveryNotification(receipt: WorkerInputDeliveryReceipt): string {
  if (receipt.state === 'delivered') {
    return (
      `[crabot] 输入 ${receipt.delivery_id} 已确认送达 worker ${receipt.worker_id}。` +
      `内容预览：${receipt.text_preview || '(空)'}`
    )
  }
  const failure = receipt.failure
  if (!failure) return `[crabot] 输入 ${receipt.delivery_id} 投递失败，但缺少失败详情。`
  const guidance = failure.certainty === 'unknown'
    ? '送达结果未知，禁止盲目重发；请先检查 worker 当前输出和输入框现场。'
    : '已确认未送达，可以根据任务当前状态决定是否重试。'
  return (
    `[crabot] 输入 ${receipt.delivery_id} 投递失败：${failure.reason} ` +
    `(reason_code=${failure.reason_code}, certainty=${failure.certainty})。${guidance}` +
    `内容预览：${receipt.text_preview || '(空)'}`
  )
}

function renderQueryNotification(receipt: WorkerQueryReceipt): string {
  if (receipt.state === 'completed') {
    return (
      `[crabot] 侧问 ${receipt.query_id} 已完成` +
      `${receipt.fork_seq === undefined ? '' : `（worker ${receipt.worker_id}#${receipt.fork_seq}）`}。` +
      `问题预览：${receipt.question_preview || '(空)'}`
    )
  }
  const failure = receipt.failure
  if (!failure) return `[crabot] 侧问 ${receipt.query_id} 失败，但缺少失败详情。`
  return (
    `[crabot] 侧问 ${receipt.query_id} 失败：${failure.reason} ` +
    `(reason_code=${failure.reason_code}, certainty=${failure.certainty})。` +
    `${failure.certainty === 'unknown' ? '执行结果未知，禁止自动重跑。' : ''}` +
    `问题预览：${receipt.question_preview || '(空)'}`
  )
}

function queryFailureCode(error: unknown): QueryFailureCode {
  if (error instanceof ForkEstablishmentError) {
    if (error.stage === 'query_submit') return 'query_submit_failed'
    if (error.stage === 'timeout') return 'fork_establishment_timeout'
  }
  return 'fork_create_failed'
}

function queryFailureCertainty(error: unknown): QueryFailure['certainty'] {
  return error instanceof ForkEstablishmentError ? error.certainty : 'unknown'
}

function sanitizeOperationFailureReason(
  error: unknown,
  redact: ((text: string) => string) | undefined,
  sensitiveText: string | undefined,
  fallback: string,
): string {
  let message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim()
  const normalizedSensitive = sensitiveText?.replace(/\s+/g, ' ').trim()
  if (normalizedSensitive) message = message.split(normalizedSensitive).join('<message>')
  try {
    if (redact) message = redact(message)
  } catch {
    return fallback
  }
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"'`]+/g, '<path>')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
    .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, '<redacted>')
    .slice(0, 1000) || fallback
}

/**
 * 唤醒事件 `detail.summary` 的上限(字符数)。比 `detail.text` 宽一倍,两条依据:
 *
 * 1. **这是一次性成本**。summary 只在化身落终态的那一次产生一条(`finish_task` 是唯一
 *    出处),不像 `text` 每个轮次边界都要付一遍。量纲对齐 handoff 那份
 *    `HANDOFF_TAIL_MAX_CHARS`(4096)——同样是"每次交接才付一回"。
 * 2. **它常常是唯一的交付物**。一个全程只调工具、最后 `finish_task` 收场的 worker,
 *    纯文本 artifact 与 `text` 双双为空,截狠了就是把交付物截没；而且截掉的部分**无处可补**。
 *    所以 summary 的上限比一般唤醒文本更宽。
 *
 * `finish_task` 要的是"一句话总结",典型几十到几百字符,4096 事实上是个防失控上限,
 * 不是常规裁剪线。
 */
const WAKE_SUMMARY_MAX_CHARS = 4096

/**
 * 唤醒事件 detail 里各段正文的统一截断。上限与溢出提示由调用方按该段的处境给(见
 * WAKE_TEXT_MAX_CHARS / WAKE_SUMMARY_MAX_CHARS);空白/空串一律折成 undefined
 * (不往 detail 里塞空字段)。
 *
 * `overflowHint` 必须如实:它只能指向确实可读到全文的路径；没有这样的路时就留空，不能
 * 为了显得可恢复而编造读取入口。
 *
 * `keep` 由调用方按该段正文"信息在哪一头"显式给出,**不设默认值**——三段正文的方向不是同
 * 一个:`lastText`/`summary` 是发言,重点在开头,保头;CLI `terminal` 是当前画面,较新的
 * 内容通常在末尾,保尾。截断标记跟着被丢弃的那一侧放。
 */
function truncateWakeText(
  text: string | undefined,
  maxChars: number,
  overflowHint: string,
  keep: 'head' | 'tail',
): string | undefined {
  if (!text) return undefined
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (trimmed.length <= maxChars) return trimmed
  const mark = `[已截断,共 ${trimmed.length} 字符${overflowHint}]`
  return keep === 'head' ? `${trimmed.slice(0, maxChars)}…${mark}` : `${mark}…${trimmed.slice(-maxChars)}`
}

function cliContractState(kind: NonNullable<IncarnationHandle['initial_input']>['control_state']): WorkerContractState {
  switch (kind) {
    case 'running': return 'running'
    case 'exited': return 'exited'
    default: return 'idle'
  }
}

function settleCliTask(
  task: LedgerWorker['task'],
  state: WorkerContractState,
  report: StateChangeReport | undefined,
  now: string,
): LedgerWorker['task'] {
  if (state === 'running') return task
  if (state === 'idle') return applyStatusTransition(task, 'waiting_input', { now })
  const target = taskStatusFromIncarnation('exited', report?.endReason)
  if (target === 'running') return task
  return applyStatusTransition(task, target, {
    now,
    ...(target === 'failed' ? { error: report?.endReason ?? 'initial CLI process exited' } : {}),
  })
}

function cliReportDetail(state: WorkerContractState, report: StateChangeReport | undefined): Record<string, unknown> {
  if (state === 'exited') {
    return { to: 'exited', kind: 'initial_input_settled', ...(report?.endReason ? { reason: report.endReason } : {}) }
  }
  if (report?.notification) {
    return {
      to: state,
      kind: 'interaction_required',
      wait_mode: 'action',
      wait_reason: report.waitReason ?? 'interaction_required',
      notification_type: report.notification.type,
      ...(report.notification.message ? { message: report.notification.message } : {}),
      ...(report.notification.title ? { title: report.notification.title } : {}),
    }
  }
  return {
    to: state,
    kind: report?.waitReason === 'input_pending' ? 'input_pending' : 'input_delivery_stalled',
    ...(state === 'idle' ? { wait_mode: 'action' } : {}),
    ...(report?.waitReason ? { wait_reason: report.waitReason } : {}),
  }
}

function uiSnapshotDetail(snapshot: WorkerUiSnapshot | undefined): Record<string, unknown> {
  if (!snapshot) return {}
  return {
    snapshot_id: snapshot.snapshot_id,
    snapshot_expires_at: snapshot.expires_at,
    available_actions: snapshot.actions,
  }
}

/** Raw keys that explicitly discard the current composer instead of submitting it. */
function rawAbandonsComposer(text: string): boolean {
  const keys = text.toLowerCase().split(/\s+/).filter(Boolean)
  return keys.some((key) => key === 'escape' || key === 'esc' || key === 'c-c' || key === 'c-u')
}

/**
 * continueTerminalWorker 锁内可重入求值循环的上限次数。每一轮代表"主线又换了一次"的
 * 重新判定,防止病态并发抖动(主线连续多次接续/切换)让这次投递在临界区内无限打转。3
 * 轮足以覆盖"补送失败一次 → 转接续一次"这种正常竞态收敛路径,仍在这个上限内打转说明
 * 是异常情况,不应该继续悄悄重试。
 */
const MAX_CONTINUATION_ITERATIONS = 3

/**
 * 活性巡检的停摆判据 T:主线化身的 `lastActivityAt` 超过这个时长没有前进,即视为
 * protocol-agent-v3 §6.3 第 3 条说的"静默异常"。
 *
 * 取 30 分钟,依据是 m2 现网日志的实测(见
 * `crabot-docs/superpowers/specs/2026-08-05-worker-liveness-sweep-design.md` 决策 5):
 * - **健康侧的噪声地板**:38 份健康的 cc/codex 原生会话记录里,相邻两条事件的最大间隔是
 *   codex 384s / cc 301s(p99 普遍在 10–110s)。30 分钟对最坏健康样本仍有 4.7 倍余量;
 * - **故障侧的量级**:四例真实停摆的任务进展零前进时长是 26min / 4h51m / 8h30m / 15h,
 *   与噪声地板之间隔着一个数量级。终端动画不参与此判据。
 *
 * 方向按 spec:宁可偏宽——漏报一次的代价(晚半小时发现)远小于误报打断一个真在干活的
 * worker(白烧一次 manager episode,还可能把它 kill 掉)。
 */
export const LIVENESS_STALL_MS = 30 * 60_000

/**
 * 巡检周期。协议原文是"低频巡扫",取 T 的 1/6:一轮的成本是每个在跑的 CLI 化身一次
 * `fs.stat`,可以忽略;换来的是最坏发现时延 = T + 周期 = 35 分钟,相对上面那四例(小时
 * 量级)可以忽略不计。
 */
export const LIVENESS_SWEEP_INTERVAL_MS = 5 * 60_000
export const SUPERVISION_DEFAULT_INTERVAL_MS = 15 * 60_000
const SUPERVISION_RETRY_INTERVAL_MS = 5 * 60_000

// findWorker() reloads and validates the worker's whole owning ledger. A manager can own thousands
// of workers, so a harness sweep must not start an unbounded number of those reads at once.
const WORKER_SWEEP_CONCURRENCY = 8

/**
 * 巡检发现停摆时,随唤醒事件交给 manager 的结构化事实。终端是 caller-driven 的诊断视图，
 * 不能因一次后台巡检自动 capture 并混入 Manager 上下文。
 */
function describeLivenessStall(opts: { impl: WorkerImplId; staleMs: number }): string {
  const minutes = Math.round(opts.staleMs / 60_000)
  return (
    `[crabot] 活性巡检:该 ${opts.impl} 化身已经 ${minutes} 分钟没有新的可观察任务活动,` +
    `但进程/会话仍然活着、台账仍记着 running。` +
    `**巡检不替你判断**它是干完了、在等输入,还是卡死了——` +
    `请先读取状态和原生会话活动；只有需要诊断未知界面时才读取终端，再决定继续、回应界面或请求停止。`
  )
}

/**
 * 停摆**重试**投递时的正文:一行,不带现场。
 *
 * 首报已经把停摆事实交出；episode 失败时 `ManagerLoop` 会把那份正文整体推回 mailbox。
 * 重试不重复同一份事实，避免 manager 恢复后一次收到堆积的重复告警。
 *
 * 重试的价值**不是再送一份正文,而是它本身就是一次 drain 触发器**:mailbox 只是被动缓冲,
 * 全仓没有任何周期性投递者(`maybeSelfWake` 只在成功后自唤醒,`evictIdle` 是回收器且无调用
 * 方),而停摆 worker 按定义不再产生任何事件、带不来下一次唤醒。所以这一行必须发,只是不必胖。
 */
function describeLivenessRetry(opts: { impl: WorkerImplId; staleMs: number }): string {
  return (
    `[crabot] 活性巡检:该 ${opts.impl} 化身仍然没有新的可观察任务活动(已静默 ${Math.round(opts.staleMs / 60_000)} 分钟)。` +
    `这条只是重试投递,不再重复首报。`
  )
}

/**
 * 第 n 次投递失败之后,下一次重试至少要等多久:**1×T → 2×T → 4×T 封顶**(T = `LIVENESS_STALL_MS`)。
 *
 * 为什么要退避:`maybeSelfWake` 明确拒绝在 episode 失败后自唤醒,理由是"LLM 持续故障时就变成
 * 失败→立刻重试→再失败的热循环"(`registry.ts`)。巡检按固定 5 分钟重试等于把那个热循环原样
 * 搬回来 —— LLM 挂 8 小时就是 96 个失败 episode,每个都带 engine 自己的重试(PR #75 review)。
 * 退避之后同样 8 小时只剩 ~5 次,而 `maybeSelfWake` 防的是**立刻**重试,低频重试不在它的范畴内。
 *
 * **封顶取 4×T = 2 小时的依据**:四例真实停摆是 26min / 4h51m / 8h30m / 15h。上限 2 小时意味着
 * 即便撞上最长的那例,manager 恢复后仍有 ~7 次投递机会;再往上加(比如 8×T)换来的成本节省
 * 已经可以忽略,却会让"恢复后多久能收到"退化到半天量级。
 */
function retryDelayMs(attempts: number): number {
  return LIVENESS_STALL_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 2)
}

/**
 * 一次停摆上报的去重记录(见 `sweepLiveness`)。进程重启后允许丢失并重新起算:
 * 重启后重报一次可接受,远好于永久丧失判定。
 */
interface StallReportMark {
  /** 上报时观察到的 `lastActivityAt`。它前进了就说明 worker 又动过,是新的一次停摆。 */
  readonly activityAt: number
  /** 这次唤醒的投递结局。`pending` 期间不重报(episode 正在跑,再唤一次就是插队重复)。 */
  delivery: 'pending' | 'consumed' | 'failed'
  /** 这次停摆已经投递失败过几次。=0 即"还没发过",决定正文带不带现场,也决定退避倍数。 */
  attempts: number
  /** 下一次重试最早可以发生的时刻(epoch ms);只在 `delivery === 'failed'` 时有意义。 */
  retryAfterMs: number
}

interface PreparedSupervisionDue {
  readonly handle: IncarnationHandle
  readonly event?: HarnessEvent
  readonly stateToSync?: WorkerContractState
}

type SupervisionProbe = WorkerContractState | 'failed'

/** 请求的 worker_id 在台账中不存在。 */
export class WorkerNotFoundError extends Error {
  constructor(readonly worker_id: string) {
    super(`worker not found: ${worker_id}`)
    this.name = 'WorkerNotFoundError'
  }
}

/** send_to_worker 命中已 cancelled 的 task(唯一硬拒绝场景,protocol-agent-v3 §5.5)。 */
export class TaskCancelledError extends Error {
  constructor(readonly worker_id: string) {
    super(`worker ${worker_id} task is cancelled`)
    this.name = 'TaskCancelledError'
  }
}

/** Ledger entry exists but has no worker incarnation (agent-native system task). */
export class WorkerHasNoIncarnationError extends Error {
  constructor(readonly worker_id: string) {
    super(`worker ${worker_id} has no incarnation; agent-native system tasks do not support worker operations`)
    this.name = 'WorkerHasNoIncarnationError'
  }
}

/**
 * handoff(switchWorkerImpl,或透明接续 revive:false 分支的自动交接)的目标 impl 在这个
 * worker 名下已经有过化身(含已终态、含 fork 分支)——三个 adapter(builtin/claude-code/
 * codex)的 spawn 都硬编码 seq=1 且带"already spawned"守卫,不支持对同一 worker_id 二次
 * spawn,即使旧化身已经被 kill(kill 不清除这个守卫记忆:cc/codex 的内存 runtimes 表不删除
 * 条目,builtin 的 builtinConfigs + 磁盘 meta-1.json 更是连跨进程都拦)。若不在
 * handoffIncarnation 的 pre-flight 拦下,step 3 的 newAdapter.spawn 必然抛错,而此时旧
 * 化身已在 step 1/2 被生成私有 handoff package、经核验停止并标 superseded——重蹈 pre-flight 本该防住的
 * "旧的没了、新的没建成"死结。根治需要 harness 自己分配 seq(不依赖各 adapter 内部
 * nextSeq/硬编码 1),这是协议级改动,留待后续(protocol-agent-v3 §6.1 已知限制);这里先
 * fail-fast,把死结换成一个清晰、可重试、可诊断的错误。
 */
export class ImplAlreadyUsedError extends Error {
  constructor(readonly worker_id: string, readonly impl: WorkerImplId) {
    super(
      `worker ${worker_id} already has an incarnation on impl '${impl}'; adapter.spawn is hardcoded to seq=1 and ` +
        `does not support re-spawning the same worker_id on the same impl (even after kill) — root fix requires ` +
        `harness-managed seq allocation (protocol-agent-v3 §6.1 known limitation)`
    )
    this.name = 'ImplAlreadyUsedError'
  }
}

export interface HarnessDeps {
  /**
   * 化身进入终态（exited）时触发一次（fire-and-forget，P6-A §8.10）：装配层用它做
   * native trace 终态收割（最后一次 read + 写 Agent-owned copy）。回调异常不得影响
   * 状态机推进（调用点已 catch）。
   */
  readonly onIncarnationTerminal?: (handle: IncarnationHandle) => void
  /** 已 detect 过的可用实现。见文件头"onStateChange 接线契约"——底层 Map 引用可在构造后继续填充。 */
  readonly adapters: ReadonlyMap<WorkerImplId, WorkerAdapter>
  readonly defaultImpl: WorkerImplId
  readonly ledger: LedgerStore
  readonly workspaces: WorkspaceManager
  /** <dataRoot>/agent/workers */
  readonly workersDir: string
  /** ISO 时间注入,便于测试 */
  readonly now: () => string
  /**
   * P4 manager 的唤醒入口(P3 是可插桩的出口)。
   *
   * 返回值**只有活性巡检看**(见 `sweepLiveness` 的去重规则与 `HarnessEventDelivery`):
   * 其余调用点一律 fire-and-forget,不 await、不看结果——它们跑在 per-worker 锁内,而
   * 一次唤醒是一整个 manager episode(可能几分钟,且 manager 的工具会反过来调 harness),
   * 在锁内等它就是自锁。返回 `void` 的实现(P3 桩、既有测试)行为逐字不变。
   */
  readonly onEvent?: (e: HarnessEvent) => void | HarnessEventDelivery | Promise<HarnessEventDelivery | void>
  /** Durable input/query terminal notification routed to the receipt's fixed Manager owner. */
  readonly onOperationNotification?: (
    managerKey: ManagerKey,
    event: HarnessEvent,
  ) => void | HarnessEventDelivery | Promise<HarnessEventDelivery | void>
  /** Removes runtime credentials before an operation failure reason is persisted or returned. */
  readonly redactFailureReason?: (text: string) => string
  /** provision 素材(P3 可返回空集)，必须按 worker 固定的权限快照生成。 */
  readonly capabilityBundle?: (ctx: WorkerCapabilityContext) => Promise<CapabilityBundle>
  /**
   * handoff(§5.3 交接续办 / switchWorkerImpl)目标实现是 'builtin' 时所需的 LLM 注入
   * 默认值。`spawnWorker` 的 builtin 注入由调用方随每次调用显式传入(`SpawnWorkerParams.
   * builtin`),但 handoff 是 harness 内部触发的动作(可能由 sendToWorker 命中终态化身
   * 自动触发,调用方拿不到再传一次 builtin 注入的机会),因此在 HarnessDeps 这一级配置
   * 一份可复用的默认值。缺省时 handoffIncarnation 对 builtin 目标做 pre-flight 拒绝
   * (见该方法注释),不尝试传 `undefined` 让 `BuiltinWorkerAdapter.spawn` 自己再抛错。
   *
   * PR F:`spawnWorker` 在 `p.builtin` 缺失且目标实现是 builtin 时也回退调它——manager 的
   * `spawn_worker` 工具不可能从 LLM 入参里拿到 LLMAdapter / tools 这类运行时对象,注入
   * 只能来自装配层。工厂带 per-worker 上下文(worker_id / workspace / origin / goal),
   * 无参签名装不下这些维度(见 `BuiltinRuntimeFactory`)。
   */
  readonly builtinSpawnDefaults?: BuiltinRuntimeFactory
  /** Rejects new spawn/resume/handoff while runtime config is stale; running incarnations remain untouched. */
  readonly assertExecutionAdmission?: () => void
  /**
   * P6-B §6.5：显式/接续目标 impl 的 activation registry gate（唯一 ready 判定点）。
   * spawn 显式 impl、resume 终态化身、handoff 目标 impl 前必须调用；
   * 省略 impl 的 spawn 走 defaultImpl（builtin 安全路径）不在此 gate。
   */
  readonly assertWorkerImplReady?: (impl: WorkerImplId) => void | Promise<void>
  /** P6-B 失败导向：adapter 级执行失败/成功上报（degraded 置位/清除）。 */
  readonly reportWorkerOutcome?: (impl: WorkerImplId, failure: string | null) => void | Promise<void>
  /** P6-C §2/§5：纯选择器（显式只查自己；省略 default→固定顺序；结构化错误）。 */
  readonly selectWorkerImpl?: (requestedImpl: WorkerImplId | undefined, excludedImpls?: ReadonlySet<WorkerImplId>) => WorkerImplId
  /** P6-C §5.9：operation-scoped activation fence（副作用线性化点）。 */
  readonly acquireWorkerFence?: (impl: WorkerImplId, kind: 'spawn' | 'resume' | 'handoff') => Promise<{ release(): void }>
  /**
   * P6-B §6.5：operation-time connection admission（registry gate 之后、副作用之前）。
   * 返回的 env 注入 SpawnSpec.connection_env；dispose 在 spawn 收口后调用。
   */
  readonly admitWorkerConnection?: (impl: WorkerImplId, operationLabel?: string) => Promise<{
    env: Record<string, string>
    connectionRevision?: string
    dispose(): Promise<void>
  }>
  /** True while this worker owns a running background entity. */
  readonly hasRunningBg?: (workerId: string) => Promise<boolean>
  /** Validates an opaque legacy continuation credential immediately before side effects. */
  readonly validateLegacyContinuationAuth?: (auth: LegacyContinuationAuth) => Promise<boolean>
  /** Stops periodic supervision from creating new work during shutdown. */
  readonly isClosing?: () => boolean
}

interface WorkerTurnActivityRead {
  readonly events: NormalizedTraceEvent[]
  readonly unavailableReason?: string
}

export interface SpawnWorkerParams {
  readonly managerKey: ManagerKey
  readonly title: string
  readonly prompt: string
  readonly origin: LedgerWorker['origin']
  readonly report_to: LedgerWorker['report_to']
  readonly impl?: WorkerImplId
  readonly workspace?: string
  readonly goal?: string
  /**
   * 派活时 manager 按 `origin.creator_friend_id` 算好的发起人权限档位(§8.2"manager 算好
   * 结果随 spawn 下传")。builtin adapter 把它随 workspace/origin 一起落盘,该 worker 之后
   * 所有化身都用这一份——权限是身份属性,在 spawn 时固定,不随会话里后来谁说话而变。
   * 缺省 = 无发起人档位(系统派工 / 身份未解析),worker 退回自己的固定档位。
   */
  readonly principal_permissions?: ResolvedPermissions
  /** builtin 实现所需的 LLM 注入(P4 提供) */
  readonly builtin?: SpawnSpec['builtin']
}

export interface HarnessSendToWorkerOptions {
  readonly raw?: boolean
  readonly managerKey?: ManagerKey
  readonly onSettled?: InboxItem['onSettled']
  readonly dedupeKey?: string
  readonly onDeduplicated?: () => void
  readonly legacyContinuationAuth?: LegacyContinuationAuth
}

/**
 * reconcileOnStartup 的巡检结果(protocol-agent-v3 §12,替代 admin 的一刀切自愈)。三个
 * 桶各装 worker_id,供 P4 manager 决定唤醒哪些 monitor:
 * - revived:本轮确认化身仍活着(running/idle),台账非终态状态得到确认或对齐,需要
 *   P4 接管后续监护;
 * - failed:本轮判死(adapter 报 exited、adapter 未注册、或 adapter.state() 抛错三种
 *   "无法证明还活着"的情形之一),台账已落 failed(ended_reason='crashed');
 * - unchanged:进入本轮巡检前就已是终态(含上一轮已经判死/前一次调用已经处理过的),
 *   本轮不做任何动作。
 */
export interface ReconcileReport {
  readonly revived: string[]
  readonly failed: string[]
  readonly unchanged: string[]
}

const EMPTY_CAPABILITY_BUNDLE: CapabilityBundle = { skills: [], mcp_servers: [] }

type InputAttempt =
  | { readonly kind: 'exited'; readonly endedReason?: IncarnationEndReason }
  | {
      readonly kind: 'stalled'
      readonly handle: IncarnationHandle
      readonly controlState: NonNullable<IncarnationHandle['initial_input']>['control_state']
      readonly report?: StateChangeReport
      readonly expectedStateChangeRevision: number
      readonly delivery: InboxDeliveryResult
    }
  | {
      readonly kind: 'delivered'
      readonly handle: IncarnationHandle
      readonly expectedStateChangeRevision?: number
      readonly acceptedExit?: StateChangeReport
    }

type SettledInputAttempt = Exclude<InputAttempt, { readonly kind: 'exited' }>

type ContinuationRetry = {
  readonly kind: 'retry_continuation'
  readonly impl: WorkerImplId
  readonly seq: number
  readonly endedReason?: IncarnationEndReason
}

type ContinuationDelivery = InboxSettlement | InboxDeliveryResult | InboxSettledResult | ContinuationRetry

function isContinuationRetry(delivery: ContinuationDelivery): delivery is ContinuationRetry {
  return typeof delivery === 'object' && 'kind' in delivery && delivery.kind === 'retry_continuation'
}

interface HandoffResult {
  readonly restoredDurableReceipt: boolean
  readonly delivery: ContinuationDelivery
}

function initialInputDelivery(
  initialInput: IncarnationHandle['initial_input'],
  requeueAfter = 0,
  replacement?: InboxDeliveryResult['replacement'],
): InboxSettlement | InboxDeliveryResult {
  if (!initialInput || initialInput.disposition === 'accepted') {
    return 'delivered'
  }
  return initialInput.disposition === 'not_pasted'
    ? { action: 'hold_requeue', reason: 'waiting_action', requeueAfter, replacement }
    : { action: 'hold_consumed', reason: 'input_pending', replacement }
}

function continuationDelivery(
  initialInput: IncarnationHandle['initial_input'],
  initialState: WorkerContractState,
  handle: IncarnationHandle,
  requeueAfter = 0,
  replacement?: InboxDeliveryResult['replacement'],
): ContinuationDelivery {
  if (initialState === 'exited' && initialInput?.disposition !== 'accepted') {
    return {
      kind: 'retry_continuation',
      impl: handle.impl,
      seq: handle.seq,
      endedReason: initialInput?.report?.endReason,
    }
  }
  return initialInputDelivery(initialInput, requeueAfter, replacement)
}

export class WorkerHarness {
  private readonly pendingBgNotifications = new Map<string, number>()
  private readonly contextStore: WorkerContextStore
  private readonly inputDeliveryStore: InputDeliveryStore
  private readonly queryReceiptStore: QueryReceiptStore
  private readonly turnStore: WorkerTurnStore
  private readonly nativeActivityStore: NativeActivityStore
  private readonly controlOperationStore: WorkerControlOperationStore
  private readonly uiSnapshotStore: WorkerUiSnapshotStore
  private readonly nativeActivityNotificationMutexes = new Map<string, AsyncMutex>()
  private readonly controlNotificationMutexes = new Map<string, AsyncMutex>()
  private readonly inputDeliveryControllers = new Map<string, AbortController>()
  private readonly pendingQueryStateChanges = new Map<
    string,
    { h: IncarnationHandle; state: WorkerContractState; report?: StateChangeReport }
  >()

  /**
   * Marks a shell-exit notification before its async rendering starts.  This
   * closes the idle-state race: task status cannot become waiting_input between
   * the registry terminal update and WorkerInbox enqueue.
   */
  beginBgNotification(workerId: string): () => void {
    this.pendingBgNotifications.set(workerId, (this.pendingBgNotifications.get(workerId) ?? 0) + 1)
    return () => {
      const remaining = (this.pendingBgNotifications.get(workerId) ?? 1) - 1
      if (remaining > 0) this.pendingBgNotifications.set(workerId, remaining)
      else this.pendingBgNotifications.delete(workerId)
    }
  }

  hasPendingBgNotification(workerId: string): boolean {
    return (this.pendingBgNotifications.get(workerId) ?? 0) > 0
  }
  private readonly mutexes = new Map<string, AsyncMutex>()
  private readonly inboxes = new Map<string, WorkerInbox>()
  private readonly eventLogs = new Map<string, WorkerEventLog>()
  /** 活性巡检的已报标记,键是 `<worker_id>#<impl>#<seq>`(见 `sweepLiveness`)。 */
  private readonly stallReports = new Map<string, StallReportMark>()
  /** Adapter state callbacks observed per incarnation; used to order harness-owned CLI input settlement. */
  private readonly stateChangeRevisions = new Map<string, number>()
  /** Synchronous generation of the pane that currently owns input for each logical worker. */
  private readonly inputOwnershipRevisions = new Map<string, number>()
  private sweepInFlight = false
  private sweepTimer?: ReturnType<typeof setInterval>
  /** `stopLivenessSweep` 置位后不再接受 `startLivenessSweep`(见该方法注释的停机竞态)。 */
  private sweepStopped = false

  constructor(private readonly deps: HarnessDeps) {
    this.contextStore = new WorkerContextStore(deps.workersDir)
    this.inputDeliveryStore = new InputDeliveryStore(deps.workersDir)
    this.queryReceiptStore = new QueryReceiptStore(deps.workersDir)
    this.turnStore = new WorkerTurnStore(deps.workersDir)
    this.nativeActivityStore = new NativeActivityStore(deps.workersDir)
    this.controlOperationStore = new WorkerControlOperationStore(deps.workersDir)
    this.uiSnapshotStore = new WorkerUiSnapshotStore(deps.workersDir)
  }

  private inputOwnershipRevision(workerId: string): number {
    return this.inputOwnershipRevisions.get(workerId) ?? 0
  }

  private bumpInputOwnershipRevision(workerId: string): void {
    this.inputOwnershipRevisions.set(workerId, this.inputOwnershipRevision(workerId) + 1)
  }

  /**
   * 见文件头"onStateChange 接线契约"。箭头函数字段:构造时绑定 this,P4 可直接把它作为
   * 三个 adapter 构造 deps 里的 `onStateChange` 传入,不需要 .bind(harness)。
   * 签名对齐三个 adapter 的 `deps.onStateChange?: (h, state, report?: StateChangeReport) => void`
   * (同步、无返回值)——内部把实际的异步台账更新做成 fire-and-forget,任何失败只
   * console.error,不抛给 adapter(adapter 侧本身也已经用 try/catch 包裹了对这个回调的调用,
   * 这里双重防御,理由一致:观察者的异常不能中断 adapter 自己的状态机推进)。
   *
   * `report` 里各字段的含义与"哪个 adapter 报得出"见 `StateChangeReport` 的字段注释;
   * 这里只说 harness 拿它做什么:
   *
   * - `lastText`:截断后放进 `state_changed` 事件的 detail,让 manager 醒来就看得到 worker
   *   说了什么；
   * - `endReason`:据此落台账,不再自己猜(修复前这里硬编码 'completed',把 builtin 经
   *   `finish_task(outcome:'failed')` 结构化上报的失败真值整个丢掉,台账/task.status/
   *   对外事件/私有 handoff package 一起记错)。
   */
  readonly handleStateChange = (h: IncarnationHandle, state: WorkerContractState, report?: StateChangeReport): void => {
    // 契约断言(同步抛,不进 fire-and-forget):endReason 只在 exited 时有意义。running/idle
    // 带着终止原因进来说明调用方的状态机接错了线,静默忽略会让台账落进说不清的中间态——
    // 抛给 adapter,由它的 try/catch 记 console.error(观察者异常不中断状态机推进)。
    if (report?.endReason !== undefined && state !== 'exited') {
      throw new Error(
        `WorkerHarness.handleStateChange: endReason '${report.endReason}' is only meaningful for state 'exited', got '${state}' ` +
          `(${h.worker_id}#${h.seq})`
      )
    }
    const revisionKey = `${h.worker_id}#${h.impl}#${h.seq}`
    this.stateChangeRevisions.set(revisionKey, (this.stateChangeRevisions.get(revisionKey) ?? 0) + 1)
    this.processStateChange(h, state, report)
      .then(() => this.verifyControlOperationsForStateChange(h))
      .catch((err) => {
        console.error(`[WorkerHarness] handleStateChange failed for ${h.worker_id}#${h.seq}:`, err)
      })
  }

  /**
   * Adapter-native trace append signal. It deliberately carries no terminal text: the Harness
   * reads the structured session incrementally and persists its own high-water mark before a
   * Manager can be woken.
   */
  readonly handleNativeActivity = (h: IncarnationHandle): void => {
    this.collectNativeActivity(h)
      .then(() => this.deliverNativeActivityNotifications(h.worker_id))
      .catch((error) => console.error(`[WorkerHarness] native activity collection failed for ${h.worker_id}#${h.seq}:`, error))
  }

  async spawnWorker(p: SpawnWorkerParams): Promise<LedgerWorker> {
    this.deps.assertExecutionAdmission?.()
    const workerId = `w-${randomUUID()}`
    const incarnationId = randomUUID()
    // P6-C §2：显式/省略统一走纯选择器（显式只查自己不 fallback；省略 default→固定顺序）。
    // 选择器抛 WORKER_IMPLEMENTATION_NOT_READY（含 ready list/reasons），无任何副作用。
    const impl = this.deps.selectWorkerImpl
      ? this.deps.selectWorkerImpl(p.impl)
      : (p.impl ?? this.deps.defaultImpl)
    // 选择器未注入的旧测试路径保留显式 gate。
    if (!this.deps.selectWorkerImpl && p.impl !== undefined) await this.deps.assertWorkerImplReady?.(p.impl)
    // P6-B §6.5：operation admission——当前调用内实时解析连接。
    const admission = await this.deps.admitWorkerConnection?.(impl, workerId)
    // P6-C §5.9：activation fence——第一项持久副作用（workspace/台账）前的线性化点。
    // fence 获取失败也要 dispose admission（plan §6.7 finally 清理纪律）。
    let fence: { release(): void } | undefined
    try {
      fence = this.deps.acquireWorkerFence ? await this.deps.acquireWorkerFence(impl, 'spawn') : undefined
    } catch (error) {
      if (admission) await admission.dispose()
      throw error
    }
    let fenceReleased = false
    const releaseFence = () => { if (fence && !fenceReleased) { fenceReleased = true; fence.release() } }
    const adapter = this.deps.adapters.get(impl)
    if (!adapter) {
      // 失败路径必须 dispose：runtime 目录（如 codex CODEX_HOME）不得残留。
      releaseFence()
      if (admission) await admission.dispose()
      throw new Error(`WorkerHarness.spawnWorker: no adapter registered for impl '${impl}'`)
    }

    // workspace 解析可能失败(InvalidWorkspaceError),放在拿锁/写台账之前——失败时台账
    // 完全不会出现这条 worker,不留半成品。
    let workspace
    try {
      workspace = await this.deps.workspaces.resolve(workerId, p.workspace)
    } catch (error) {
      releaseFence()
      if (admission) await admission.dispose()
      throw error
    }

    return this.withLock(workerId, async () => {
      const startedAt = this.deps.now()
      const instructions = await captureWorkspaceInstructions({
        workersDir: this.deps.workersDir,
        workerId,
        incarnationId,
        workspaceRoot: workspace.root,
        capturedAt: startedAt,
      })
      const claudeBridge = impl === 'claude-code'
        ? await prepareClaudeWorkspaceBridge({
            workersDir: this.deps.workersDir,
            workerId,
            incarnationId,
            workspaceRoot: workspace.root,
            instructions,
          })
        : undefined
      const initial: LedgerWorker = {
        worker_id: workerId,
        manager_key: p.managerKey,
        task: {
          id: workerId,
          title: p.title,
          status: 'queued',
          goal: p.goal,
          created_at: startedAt,
        },
        origin: p.origin,
        report_to: p.report_to,
        incarnations: [
          {
            incarnation_id: incarnationId,
            seq: 1,
            impl,
            state: 'running',
            workspace: workspace.root,
            workspace_instructions: instructions.snapshot,
            // adapter.spawn 尚未调用,真实 session_ref 此刻还不存在,先占位;spawn 成功后
            // 下面会用 adapter.spawn 返回的 IncarnationHandle.session_ref(protocol-agent-v3
            // §6.1,handle 自描述真值)原子补写,不依赖任何"从 handle 反查"的额外方法。
            session_ref: '',
            started_at: startedAt,
          },
        ],
        updated_at: startedAt,
      }
      await this.deps.ledger.upsertWorker(p.managerKey, workerId, () => initial)

      let spawnedHandle: IncarnationHandle
      try {
        // 跨实现身份快照必须先于 provision 落盘：CLI-first worker 与 builtin 一样需要它。
        const requestedContext: WorkerContext = p.principal_permissions === undefined
          ? {}
          : { principal_permissions: p.principal_permissions }
        const context = await this.contextStore.write(workerId, requestedContext)
        const caps = this.deps.capabilityBundle
          ? await this.deps.capabilityBundle({ worker_id: workerId, principal_permissions: context.principal_permissions })
          : EMPTY_CAPABILITY_BUNDLE
        await adapter.provision(workspace, caps)
        // builtin 注入:调用方显式传了就用它;没传(manager 的 spawn_worker 工具就不可能传——
        // LLMAdapter / tools 是运行时对象,不可能来自 LLM 入参)则回退到装配层注入的工厂,
        // 与 handoffIncarnation 走同一个工厂。目标实现不是 builtin 时不调工厂:CLI adapter
        // 忽略该字段,白解析一次 LLM 连接信息没有意义。工厂抛错走下面的 catch,如实落成一次
        // 失败的 spawn 尝试(queued→running→failed),不静默。
        const builtin =
          p.builtin ??
          (impl === 'builtin'
            ? this.deps.builtinSpawnDefaults?.({
                worker_id: workerId,
                workspace,
                origin: p.origin,
                goal: p.goal,
                principal_permissions: context.principal_permissions,
                workspace_instructions: instructions,
              })
            : undefined)
        const spec: SpawnSpec = {
          worker_id: workerId,
          incarnation_id: incarnationId,
          prompt: p.prompt,
          workspace,
          ...(impl === 'builtin' || claudeBridge?.kind === 'user_owned_claude_md'
            ? { workspace_instructions: instructions }
            : {}),
          goal: p.goal,
          origin: p.origin,
          principal_permissions: context.principal_permissions,
          builtin,
          ...(admission && Object.keys(admission.env).length > 0 ? { connection_env: admission.env } : {}),
        }
        // 失败归因只认 WorkerImplUnavailableError（能证明 impl 失效的 adapter 级错误）；
        // 调用方/状态/数据错误（already spawned、meta 缺失等）与 provision 错误都不置 degraded。
        try {
          const returnedHandle = await adapter.spawn(spec)
          if (returnedHandle.incarnation_id !== undefined && returnedHandle.incarnation_id !== incarnationId) {
            throw new Error(`WorkerHarness.spawnWorker: adapter returned mismatched incarnation_id for ${workerId}`)
          }
          spawnedHandle = { ...returnedHandle, incarnation_id: incarnationId }
        } catch (spawnError) {
          if (spawnError instanceof WorkerImplUnavailableError) {
            await this.deps.reportWorkerOutcome?.(impl, spawnError.message)
          }
          throw spawnError
        }
        await this.deps.reportWorkerOutcome?.(impl, null)
      } catch (err) {
        // This bridge is a Harness-owned workspace artifact. A failed spawn leaves no active
        // Claude incarnation to use it, so remove it only when this invocation created it.
        if (claudeBridge?.managed) {
          const { cleanupClaudeWorkspaceBridge } = await import('./workspace-instructions')
          await cleanupClaudeWorkspaceBridge({ workersDir: this.deps.workersDir, workerId, incarnationId, workspaceRoot: workspace.root })
            .catch((cleanupError) => console.warn(`[WorkerHarness] failed to clean Claude workspace bridge for ${workerId}:`, cleanupError))
        }
        releaseFence()
        if (admission) await admission.dispose()
        const now = this.deps.now()
        const failed = await this.deps.ledger.upsertWorker(p.managerKey, workerId, (prev) => {
          if (!prev) return undefined
          // VALID_TRANSITIONS 里 queued 没有直达 failed 的边(只能到 running/cancelled)。
          // spawn 尝试确实发生过(我们已经调用了 provision/spawn),用 queued→running→failed
          // 两跳把这次失败尝试如实记录下来,而不是绕开状态机改成不符合协议语义的 cancelled。
          const running = applyStatusTransition(prev.task, 'running', { now })
          const nextTask = applyStatusTransition(running, 'failed', {
            error: err instanceof Error ? err.message : String(err),
            now,
          })
          const incarnations = patchIncarnationBySeq(prev.incarnations, impl, 1, {
            state: 'exited',
            ended_at: now,
            ended_reason: 'failed',
          })
          return { ...prev, task: nextTask, incarnations, updated_at: now }
        })
        // 台账上是 queued→running→failed 两跳,但这里只落一条事件,事件带的是**落账后的
        // 终点** failed;中间的 running 没有对应事件,订阅方看到的仍是 queued→failed(不是
        // 状态机合法边)。这属于"两次迁移之间没有事件 → 中间态折叠",不是订阅方读晚了造成
        // 的——后者已由 task_status 修掉。见 manager/events.ts 文件头的边界说明。
        await this.appendEvent(
          workerId,
          1,
          'exited',
          { reason: 'spawn_failed', message: err instanceof Error ? err.message : String(err) },
          failed?.task.status
        )
        throw err
      }

      const now = this.deps.now()
      const initialInput = spawnedHandle.initial_input
      const initialState = cliContractState(initialInput?.control_state ?? 'running')
      const spawned = await this.deps.ledger.upsertWorker(p.managerKey, workerId, (prev) => {
        if (!prev) return undefined
        let nextTask = applyStatusTransition(prev.task, 'running', { now })
        nextTask = settleCliTask(nextTask, initialState, initialInput?.report, now)
        const incarnations = patchIncarnationBySeq(prev.incarnations, impl, 1, {
          session_ref: spawnedHandle.session_ref,
          state: initialState,
          ...(initialState === 'exited'
            ? { ended_at: now, ended_reason: initialInput?.report?.endReason ?? 'crashed' }
            : {}),
        })
        const supervision = supervisionAfterMainlineTransition(
          prev.supervision,
          nextTask.status,
          initialState,
          1,
          now,
          true,
        )
        return { ...prev, task: nextTask, incarnations, ...(supervision ? { supervision } : {}), updated_at: now }
      })

      // runtime file（如 codex admin_provider 的 CODEX_HOME）必须活到化身终态——
      // CLI 运行期持续读它；终态收割时统一清理（含崩溃路径的 fireIncarnationTerminal）。
      // spawn 返回即终态（启动期握手超时等）时不会有终态钩子再触发——立即 dispose。
      releaseFence()
      if (admission) {
        if (initialState === 'exited') await admission.dispose()
        else this.connectionDisposers.set(`${workerId}:1`, admission.dispose)
      }
      const inbox = this.getInbox(workerId)
      inbox.release()
      if (initialState !== 'exited' && initialInput?.disposition === 'not_pasted') {
        inbox.enqueueFront({ text: p.prompt, raw: false, enqueued_at: now })
        inbox.hold('waiting_action')
      } else if (initialState !== 'exited' && initialInput?.disposition === 'pending_in_ui') {
        inbox.hold('input_pending')
      }

      await this.appendEvent(workerId, 1, 'spawned', { impl }, spawned?.task.status)
      const uiSnapshot = await this.prepareUiSnapshot(spawnedHandle, p.managerKey, initialInput?.report, now)
      const turn = initialInput
        ? await this.createPendingTurn(p.managerKey, spawnedHandle, initialInput.report, now)
        : undefined
      if (initialInput && (initialInput.disposition !== 'accepted' || initialState !== 'running')) {
        await this.appendEvent(workerId, 1, 'state_changed', {
          ...cliReportDetail(initialState, initialInput.report),
          ...uiSnapshotDetail(uiSnapshot),
          ...(turn ? { turn_id: turn.turn_id, turn_pending: true } : {}),
        }, spawned?.task.status)
      }
      return spawned as LedgerWorker
    })
  }

  async sendToWorker(
    workerId: string,
    text: string,
    opts: HarnessSendToWorkerOptions & { readonly managerKey: ManagerKey },
  ): Promise<SendToWorkerResult>
  async sendToWorker(workerId: string, text: string, opts?: HarnessSendToWorkerOptions): Promise<void>
  async sendToWorker(
    workerId: string,
    text: string,
    opts?: HarnessSendToWorkerOptions,
  ): Promise<SendToWorkerResult | void> {
    const inbox = this.getInbox(workerId)
    let enqueued = true
    let receipt: WorkerInputDeliveryReceipt | undefined

    // "读台账状态 → 判断 cancelled/化身 → 入信箱"在同一临界区完成,不允许 check-then-act 跨 await。
    await this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) throw new WorkerNotFoundError(workerId)
      if (found.worker.task.status === 'cancelled') throw new TaskCancelledError(workerId)
      requireMainlineIncarnation(found.worker)

      if (opts?.managerKey) {
        const createdAt = this.deps.now()
        const deliveryId = randomUUID()
        try {
          receipt = await this.inputDeliveryStore.create({
            delivery_id: deliveryId,
            worker_id: workerId,
            manager_key: opts.managerKey,
            raw: opts.raw ?? false,
            text_preview: text,
            created_at: createdAt,
            updated_at: createdAt,
            deadline_at: new Date(Date.parse(createdAt) + INPUT_DELIVERY_TIMEOUT_MS).toISOString(),
            state: 'pending',
            phase: 'queued',
            manager_notification: { status: 'not_required' },
          })
        } catch (error) {
          throw new Error(`delivery receipt unavailable: ${sanitizeOperationFailureReason(
            error,
            this.deps.redactFailureReason,
            text,
            'receipt store failed',
          )}`)
        }
        this.inputDeliveryControllers.set(deliveryId, new AbortController())
      }

      const durableReceipt = receipt
      const item: InboxItem = {
        text,
        raw: opts?.raw ?? false,
        enqueued_at: this.deps.now(),
        allow_terminal_continuation: true,
        ...(durableReceipt
          ? {
              delivery_id: durableReceipt.delivery_id,
              onPending: (reason: InboxDeliveryResult['reason']) =>
                this.inputDeliveryStore.updatePendingPhase(
                  workerId,
                  durableReceipt.delivery_id,
                  reason === 'input_pending' ? 'pending_in_ui' : 'waiting_for_safe_input',
                  this.deps.now(),
                ).then(() => undefined),
              shouldDeliver: async () =>
                (await this.inputDeliveryStore.get(workerId, durableReceipt.delivery_id))?.state === 'pending',
              onSettled: async (settlement, detail) => {
                await this.settleDurableInput(durableReceipt, text, settlement, detail)
                await opts?.onSettled?.(settlement, detail)
              },
            }
          : opts?.onSettled ? { onSettled: opts.onSettled } : {}),
        ...(opts?.dedupeKey ? { dedupe_key: opts.dedupeKey } : {}),
        ...(opts?.legacyContinuationAuth ? { legacy_continuation_auth: opts.legacyContinuationAuth } : {}),
      }
      enqueued = opts?.dedupeKey && !durableReceipt ? inbox.enqueueUnique(item) : (inbox.enqueue(item), true)
    })

    if (!enqueued) opts?.onDeduplicated?.()
    try {
      await this.flushInbox(workerId)
    } catch (error) {
      if (!receipt) throw error
      await this.failDurableInputAttempt(receipt, inbox, error, text)
    }

    if (!receipt) return
    let current: WorkerInputDeliveryReceipt
    try {
      current = await this.inputDeliveryStore.readForToolResult(
        workerId,
        receipt.delivery_id,
        this.deps.now(),
      )
    } catch (error) {
      this.inputDeliveryControllers.get(receipt.delivery_id)?.abort()
      try {
        await this.failDurableInputAttempt(receipt, inbox, error, text)
      } catch (settlementError) {
        throw new Error(`delivery receipt unavailable after acceptance: ${sanitizeOperationFailureReason(
          settlementError,
          this.deps.redactFailureReason,
          text,
          'receipt store failed',
        )}`)
      }
      const settled = await this.inputDeliveryStore.get(workerId, receipt.delivery_id)
      if (!settled) throw error
      current = settled
    }
    return this.toSendToWorkerResult(current)
  }

  private async settleDurableInput(
    receipt: WorkerInputDeliveryReceipt,
    text: string,
    settlement: InboxSettlement,
    detail?: { readonly seq?: number; readonly reason?: string; readonly certainty?: 'not_delivered' | 'unknown' },
  ): Promise<void> {
    this.inputDeliveryControllers.delete(receipt.delivery_id)
    if (settlement === 'delivered') {
      await this.inputDeliveryStore.settleDelivered(receipt.worker_id, receipt.delivery_id, this.deps.now())
      await this.appendAuditEvent(receipt.worker_id, detail?.seq ?? 0, 'input_sent', {
        delivery_id: receipt.delivery_id,
        text_len: text.length,
      })
      return
    }

    const reasonCode = isInputDeliveryFailureCode(detail?.reason)
      ? detail.reason
      : 'delivery_attempt_failed'
    const failure: InputDeliveryFailure = {
      reason_code: reasonCode,
      reason: describeInputDeliveryFailure(reasonCode),
      certainty: detail?.certainty ?? 'unknown',
    }
    await this.inputDeliveryStore.settleFailed(receipt.worker_id, receipt.delivery_id, failure, this.deps.now())
    await this.appendAuditEvent(receipt.worker_id, detail?.seq ?? 0, 'input_delivery_failed', {
      delivery_id: receipt.delivery_id,
      ...failure,
    })
  }

  private async failDurableInputAttempt(
    receipt: WorkerInputDeliveryReceipt,
    inbox: WorkerInbox,
    error: unknown,
    text: string,
  ): Promise<void> {
    const cancellation = await inbox.cancelDelivery(receipt.delivery_id)
    const current = await this.inputDeliveryStore.get(receipt.worker_id, receipt.delivery_id)
    if (!current || current.state !== 'pending') return

    const reasonCode: InputDeliveryFailureCode = current.phase === 'continuing'
      ? 'continuation_failed'
      : 'delivery_attempt_failed'
    const reportedCertainty = (error as { certainty?: unknown })?.certainty
    let certainty: InputDeliveryFailure['certainty'] = 'unknown'
    if (reportedCertainty === 'not_delivered' || reportedCertainty === 'unknown') {
      certainty = reportedCertainty
    } else if (cancellation === 'cancelled' && current.phase !== 'attempting') {
      certainty = 'not_delivered'
    }
    const failure: InputDeliveryFailure = {
      reason_code: reasonCode,
      reason: sanitizeOperationFailureReason(
        error,
        this.deps.redactFailureReason,
        text,
        'input delivery attempt failed',
      ),
      certainty,
    }
    this.inputDeliveryControllers.delete(receipt.delivery_id)
    await this.inputDeliveryStore.settleFailed(receipt.worker_id, receipt.delivery_id, failure, this.deps.now())
    const found = await this.deps.ledger.findWorker(receipt.worker_id)
    await this.appendAuditEvent(
      receipt.worker_id,
      found ? requireMainlineIncarnation(found.worker).seq : 0,
      'input_delivery_failed',
      { delivery_id: receipt.delivery_id, ...failure },
    )
  }

  private toSendToWorkerResult(receipt: WorkerInputDeliveryReceipt): SendToWorkerResult {
    if (receipt.state === 'delivered') {
      return { status: 'delivered', delivery_id: receipt.delivery_id, worker_id: receipt.worker_id }
    }
    if (receipt.state === 'failed') {
      if (!receipt.failure) throw new Error(`failed delivery ${receipt.delivery_id} has no failure detail`)
      return {
        status: 'failed',
        delivery_id: receipt.delivery_id,
        worker_id: receipt.worker_id,
        ...receipt.failure,
      }
    }
    return {
      status: 'pending',
      delivery_id: receipt.delivery_id,
      worker_id: receipt.worker_id,
      pending_reason: receipt.phase === 'queued' || receipt.phase === 'waiting_for_safe_input'
        ? 'waiting_for_safe_input'
        : 'submission_unconfirmed',
      deadline_at: receipt.deadline_at,
    }
  }

  private async inputAttemptOptions(
    workerId: string,
    deliveryId: string,
  ): Promise<Pick<SendInputOptions, 'delivery_id' | 'deadline_at' | 'signal'>> {
    const receipt = await this.inputDeliveryStore.get(workerId, deliveryId)
    if (!receipt) throw new Error(`delivery receipt not found: ${deliveryId}`)
    return {
      delivery_id: deliveryId,
      deadline_at: receipt.deadline_at,
      signal: this.inputDeliveryControllers.get(deliveryId)?.signal,
    }
  }

  /** Queue an untrusted wake only while the task is non-terminal; never revive it later. */
  async sendToActiveWorker(workerId: string, text: string): Promise<boolean> {
    const inbox = this.getInbox(workerId)
    let queued = false
    await this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found || isTerminalStatus(found.worker.task.status)) return
      if (!mainlineIncarnation(found.worker)) return
      inbox.enqueue({
        text,
        raw: false,
        enqueued_at: this.deps.now(),
        allow_terminal_continuation: false,
      })
      queued = true
    })
    if (queued) await this.flushInbox(workerId)
    return queued
  }

  private async attemptInput(
    adapter: WorkerAdapter,
    handle: IncarnationHandle,
    text: string,
    raw: boolean,
    delivery?: Pick<SendInputOptions, 'delivery_id' | 'deadline_at' | 'signal'>,
  ): Promise<InputAttempt> {
    const revisionKey = `${handle.worker_id}#${handle.impl}#${handle.seq}`
    const stateChangeRevision = this.stateChangeRevisions.get(revisionKey) ?? 0
    const inputOwnershipRevision = this.inputOwnershipRevision(handle.worker_id)
    try {
      await adapter.sendInput(handle, text, { raw, ...delivery })
    } catch (error) {
      if (error instanceof WorkerExitedError) {
        return { kind: 'exited', endedReason: error.ended_reason }
      }
      if (error instanceof CliInputStallError) {
        const isCurrent = (): boolean =>
          this.inputOwnershipRevision(handle.worker_id) === inputOwnershipRevision &&
          (raw || error.disposition === 'pending_in_ui' ||
            (this.stateChangeRevisions.get(revisionKey) ?? 0) === stateChangeRevision)
        return {
          kind: 'stalled',
          handle,
          controlState: error.control_state,
          report: error.report,
          expectedStateChangeRevision: stateChangeRevision,
          delivery: {
            action: raw || error.disposition === 'pending_in_ui' ? 'hold_consumed' : 'hold_requeue',
            reason: error.disposition === 'pending_in_ui' ? 'input_pending' : 'waiting_action',
            isCurrent,
          },
        }
      }
      throw error
    }

    if (handle.impl === 'builtin') return { kind: 'delivered', handle }
    const cliAdapter = adapter as WorkerAdapter & {
      takeAcceptedInputExit?: (h: IncarnationHandle) => StateChangeReport | undefined
      takeUpdatedSessionRef?: (h: IncarnationHandle) => string | undefined
    }
    const sessionRef = cliAdapter.takeUpdatedSessionRef?.(handle)
    const settledHandle = sessionRef ? { ...handle, session_ref: sessionRef } : handle
    return {
      kind: 'delivered',
      handle: settledHandle,
      expectedStateChangeRevision: raw ? undefined : stateChangeRevision,
      acceptedExit: cliAdapter.takeAcceptedInputExit?.(settledHandle),
    }
  }

  private async settleInputAttempt(
    workerId: string,
    text: string,
    raw: boolean,
    attempt: SettledInputAttempt,
    item?: InboxItem,
  ): Promise<InboxSettlement | InboxDeliveryResult | InboxSettledResult> {
    if (attempt.kind === 'stalled') {
      if (attempt.delivery.isCurrent?.()) {
        await this.recordCliInputResult(
          attempt.handle,
          attempt.controlState,
          attempt.report,
          attempt.expectedStateChangeRevision,
        )
      }
      return attempt.delivery
    }

    if (raw) {
      const inbox = this.getInbox(workerId)
      const abandonsComposer = rawAbandonsComposer(text)
      await inbox.settleConsumed(
        abandonsComposer ? 'dead_letter' : 'delivered',
        abandonsComposer
          ? { seq: attempt.handle.seq, reason: 'abandoned_by_control_input', certainty: 'not_delivered' }
          : { seq: attempt.handle.seq },
      )
      inbox.release('waiting_action')
      inbox.release('input_pending')
    }
    if (attempt.acceptedExit) {
      await this.recordCliInputResult(attempt.handle, 'exited', attempt.acceptedExit)
    } else if (attempt.expectedStateChangeRevision !== undefined) {
      await this.recordCliInputResult(
        attempt.handle,
        'running',
        undefined,
        attempt.expectedStateChangeRevision,
      )
    }
    if (item?.delivery_id) {
      return { action: 'settled', settlement: 'delivered', detail: { seq: attempt.handle.seq } }
    }
    await this.appendEvent(workerId, attempt.handle.seq, 'input_sent', { text_len: text.length })
    return 'delivered'
  }

  private async flushInbox(workerId: string): Promise<void> {
    const inbox = this.getInbox(workerId)
    // 真正的投递不占用 harness 的 per-worker 锁(见文件头说明);inbox 自身的锁保证同一
    // 信箱的并发 flush 不重复投递。deliver 内部对每个 item 重新取一次当前化身,避免用
    // 入队时刻的过期 handle 投递。
    await inbox.flush(async (item) => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) throw new WorkerNotFoundError(workerId)
      // 主线化身,不能用"数组最后一个"——fork 之后数组末尾是侧问分支,投递必须仍然打到
      // 主线(protocol-agent-v3 §5.3:fork 不影响主线)。
      const incarnation = requireMainlineIncarnation(found.worker)

      if (isLegacyIncarnation(incarnation)) {
        if (item.allow_terminal_continuation === false) return 'delivered'
        if (item.delivery_id) {
          await this.inputDeliveryStore.updatePendingPhase(workerId, item.delivery_id, 'continuing', this.deps.now())
        }
        const delivery = await this.continueLegacyWorker(workerId, item)
        if (isContinuationRetry(delivery)) {
          return this.continueTerminalWorker(
            workerId,
            item.text,
            delivery.impl,
            delivery.seq,
            item.raw,
            delivery.endedReason,
            item,
          )
        }
        return delivery
      }

      if (incarnation.state === 'exited') {
        if (item.allow_terminal_continuation === false) return 'delivered'
        if (item.delivery_id) {
          await this.inputDeliveryStore.updatePendingPhase(workerId, item.delivery_id, 'continuing', this.deps.now())
        }
        return this.continueTerminalWorker(workerId, item.text, incarnation.impl, incarnation.seq, item.raw, undefined, item)
      }

      const adapter = this.deps.adapters.get(incarnation.impl)
      if (!adapter) {
        throw new Error(`WorkerHarness.sendToWorker: no adapter registered for impl '${incarnation.impl}'`)
      }
      const handle: IncarnationHandle = {
        worker_id: workerId,
        seq: incarnation.seq,
        impl: incarnation.impl,
        session_ref: incarnation.session_ref,
      }
      let deliveryOptions: Pick<SendInputOptions, 'delivery_id' | 'deadline_at' | 'signal'> | undefined
      if (item.delivery_id) {
        const current = await this.inputDeliveryStore.updatePendingPhase(
          workerId,
          item.delivery_id,
          'attempting',
          this.deps.now(),
        )
        deliveryOptions = {
          delivery_id: item.delivery_id,
          deadline_at: current.deadline_at,
          signal: this.inputDeliveryControllers.get(item.delivery_id)?.signal,
        }
      }
      const attempt = await this.attemptInput(adapter, handle, item.text, item.raw, deliveryOptions)
      if (attempt.kind === 'exited') {
        if (item.allow_terminal_continuation === false) return 'delivered'
        if (item.delivery_id) {
          await this.inputDeliveryStore.updatePendingPhase(workerId, item.delivery_id, 'continuing', this.deps.now())
        }
        return this.continueTerminalWorker(
          workerId,
          item.text,
          incarnation.impl,
          incarnation.seq,
          item.raw,
          attempt.endedReason,
          item,
        )
      }
      return this.settleInputAttempt(workerId, item.text, item.raw, attempt, item)
    })
  }

  private async continueLegacyWorker(
    workerId: string,
    item: InboxItem,
  ): Promise<ContinuationDelivery> {
    return this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) throw new WorkerNotFoundError(workerId)
      const { managerKey, worker } = found
      if (worker.task.status === 'cancelled') {
        await this.appendEvent(workerId, 1, 'state_changed', {
          kind: 'dead_letter',
          reason: 'task_cancelled',
          text_len: item.text.length,
        })
        return item.delivery_id
          ? {
              action: 'settled',
              settlement: 'dead_letter',
              detail: { seq: mainlineIncarnation(worker)?.seq ?? 0, reason: 'task_cancelled', certainty: 'not_delivered' },
            }
          : 'dead_letter'
      }

      const legacy = requireMainlineIncarnation(worker)
      if (!isLegacyIncarnation(legacy)) {
        throw new Error('WorkerHarness.legacyContinuation: mainline changed before continuation')
      }
      if (
        (worker.task.status !== 'completed' && worker.task.status !== 'failed') ||
        !['completed', 'failed', 'pre_migration'].includes(legacy.ended_reason)
      ) {
        throw new Error('WorkerHarness.sendToWorker: legacy worker is not eligible for continuation')
      }
      const auth = item.legacy_continuation_auth
      if (
        !isLegacyContinuationAuth(auth) ||
        auth.manager_key !== managerKey ||
        !this.deps.validateLegacyContinuationAuth ||
        !await this.deps.validateLegacyContinuationAuth(auth)
      ) {
        await this.appendEvent(workerId, legacy.seq, 'state_changed', {
          kind: 'dead_letter',
          reason: 'legacy_continuation_authorization_invalid',
          text_len: item.text.length,
        })
        return item.delivery_id
          ? {
              action: 'settled',
              settlement: 'dead_letter',
              detail: { seq: legacy.seq, reason: 'continuation_failed', certainty: 'not_delivered' },
            }
          : 'dead_letter'
      }

      // Source material is read-only. No legacy adapter, resume/checkpoint replay, or
      // source kill is involved in this path.
      const material = await this.readLegacyHandoffMaterial(worker, legacy.workspace)
      const workspace = await this.deps.workspaces.resolve(
        worker.worker_id,
        material.workspaceCandidate,
      )
      // P6-C：目标选择来自 registry（排除该 worker 已用过的实现）；无 selector 的旧测试
      // 路径保留 pickUnusedImpl。
      const usedImpls = new Set(worker.incarnations.map((inc) => inc.impl).filter((impl): impl is WorkerImplId => impl !== 'legacy'))
      const targetImpl = this.deps.selectWorkerImpl
        ? this.deps.selectWorkerImpl(undefined, usedImpls)
        : pickUnusedImpl(worker, this.deps.adapters, this.deps.defaultImpl)
      // P6-B §6.5：legacy 接续的 spawn 同样过 registry gate + connection admission——
      // 不得绕过 ready 校验，admin_provider 形态不得回落宿主凭证。
      await this.deps.assertWorkerImplReady?.(targetImpl)
      const admission = await this.deps.admitWorkerConnection?.(targetImpl, worker.worker_id)
      const targetAdapter = this.deps.adapters.get(targetImpl)
      if (!targetAdapter) {
        if (admission) await admission.dispose()
        throw new Error(`WorkerHarness.legacyContinuation: no adapter registered for impl '${targetImpl}'`)
      }
      if (implAlreadyUsed(worker, targetImpl)) {
        throw new ImplAlreadyUsedError(worker.worker_id, targetImpl)
      }

      const caps = this.deps.capabilityBundle
        ? await this.deps.capabilityBundle({
            worker_id: worker.worker_id,
            principal_permissions: auth.principal_permissions,
          })
        : EMPTY_CAPABILITY_BUNDLE
      if (targetImpl === 'builtin' && !this.deps.builtinSpawnDefaults) {
        throw new Error('WorkerHarness.legacyContinuation: builtin target requires builtinSpawnDefaults')
      }
      // No context, HANDOFF, ledger, provision or spawn side effect precedes target preflight.
      await targetAdapter.preflightProvision?.(workspace, caps)

      const handoffAt = this.deps.now()
      const incarnationId = randomUUID()
      const instructions = await captureWorkspaceInstructions({
        workersDir: this.deps.workersDir,
        workerId: worker.worker_id,
        incarnationId,
        workspaceRoot: workspace.root,
        capturedAt: handoffAt,
      })
      const builtin = targetImpl === 'builtin'
        ? this.deps.builtinSpawnDefaults?.({
            worker_id: worker.worker_id,
            workspace,
            origin: worker.origin,
            goal: worker.task.goal,
            principal_permissions: auth.principal_permissions,
            workspace_instructions: instructions,
          })
        : undefined
      if (targetImpl === 'builtin' && !builtin) {
        throw new Error('WorkerHarness.legacyContinuation: builtinSpawnDefaults returned no runtime config')
      }
      const claudeBridge = targetImpl === 'claude-code'
        ? await prepareClaudeWorkspaceBridge({
            workersDir: this.deps.workersDir,
            workerId: worker.worker_id,
            incarnationId,
            workspaceRoot: workspace.root,
            instructions,
          })
        : undefined
      const legacyIncarnationId = requireStableIncarnationId(legacy, worker.worker_id)
      const handoff = await writeHandoffPackage({
        workersDir: this.deps.workersDir,
        workerId: worker.worker_id,
        sourceIncarnationId: legacyIncarnationId,
        workspace: workspace.root,
        createdAt: handoffAt,
        evidence: [
          ...ledgerHandoffEvidence(worker, legacy),
          ...traceHandoffEvidence('persisted_activity', legacyIncarnationId, material.events),
        ],
      })
      await this.contextStore.write(worker.worker_id, {
        principal_permissions: auth.principal_permissions,
      })
      await this.appendEvent(worker.worker_id, legacy.seq, 'handoff_started', {
        target_impl: targetImpl,
        legacy: true,
        handoff_id: handoff.package_id,
      })

      const prompt = renderHandoffPrompt(handoff, item.text)
      let handle
      try {
        await targetAdapter.provision(workspace, caps)
        handle = await targetAdapter.spawn({
          worker_id: worker.worker_id,
          incarnation_id: incarnationId,
          prompt,
          workspace,
          ...(targetImpl === 'builtin' || claudeBridge?.kind === 'user_owned_claude_md'
            ? { workspace_instructions: instructions }
            : {}),
          goal: worker.task.goal,
          origin: worker.origin,
          principal_permissions: auth.principal_permissions,
          builtin,
          ...(admission && Object.keys(admission.env).length > 0 ? { connection_env: admission.env } : {}),
        })
      } catch (error) {
        if (claudeBridge?.managed) {
          await cleanupClaudeWorkspaceBridge({
            workersDir: this.deps.workersDir,
            workerId: worker.worker_id,
            incarnationId,
            workspaceRoot: workspace.root,
          }).catch((cleanupError) => console.warn(`[WorkerHarness] failed to clean Claude workspace bridge for ${worker.worker_id}:`, cleanupError))
        }
        if (admission) await admission.dispose()
        throw error
      }
      if (handle.incarnation_id !== undefined && handle.incarnation_id !== incarnationId) {
        throw new Error(`WorkerHarness.legacyContinuation: adapter returned mismatched incarnation_id for ${worker.worker_id}`)
      }
      handle = { ...handle, incarnation_id: incarnationId }
      if (admission) {
        if (handle.initial_input?.control_state === 'exited') await admission.dispose()
        else this.connectionDisposers.set(`${worker.worker_id}:${handle.seq}`, admission.dispose)
      }
      const initialInput = handle.initial_input
      const initialState = cliContractState(initialInput?.control_state ?? 'running')
      const now = this.deps.now()
      const updated = await this.deps.ledger.upsertWorker(managerKey, worker.worker_id, (previous) => {
        if (!previous) return undefined
        const incarnation: Incarnation = {
          incarnation_id: incarnationId,
          seq: handle.seq,
          impl: targetImpl,
          state: initialState,
          workspace: workspace.root,
          workspace_instructions: instructions.snapshot,
          session_ref: handle.session_ref,
          started_at: now,
          ...(initialState === 'exited'
            ? { ended_at: now, ended_reason: initialInput?.report?.endReason ?? 'crashed' }
            : {}),
        }
        let task = reopenTaskForContinuation(previous.task, now)
        task = settleCliTask(task, initialState, initialInput?.report, now)
        return {
          ...previous,
          task,
          incarnations: [...previous.incarnations, incarnation],
          updated_at: now,
        }
      })

      this.bumpInputOwnershipRevision(worker.worker_id)
      const inbox = this.getInbox(worker.worker_id)
      inbox.release()
      const replayedConsumed = inbox.requeueConsumed()
      await this.appendEvent(
        worker.worker_id,
        handle.seq,
        'spawned',
        { impl: targetImpl, from_seq: legacy.seq, legacy: true },
        updated?.task.status,
      )
      const uiSnapshot = await this.prepareUiSnapshot(handle, managerKey, initialInput?.report, now)
      const turn = initialInput
        ? await this.createPendingTurn(managerKey, handle, initialInput.report, now)
        : undefined
      if (initialInput && (initialInput.disposition !== 'accepted' || initialState !== 'running')) {
        await this.appendEvent(
          worker.worker_id,
          handle.seq,
          'state_changed',
          {
            ...cliReportDetail(initialState, initialInput.report),
            ...uiSnapshotDetail(uiSnapshot),
            ...(turn ? { turn_id: turn.turn_id, turn_pending: true } : {}),
          },
          updated?.task.status,
        )
      }
      return continuationDelivery(
        initialInput,
        initialState,
        handle,
        replayedConsumed,
        { text: prompt, raw: item.raw },
      )
    })
  }

  private async readLegacyHandoffMaterial(
    worker: LedgerWorker,
    fallbackWorkspace: string,
  ): Promise<{
    readonly events: ReadonlyArray<NormalizedTraceEvent>
    readonly workspaceCandidate: string
  }> {
    const snapshotPath = join(this.deps.workersDir, worker.worker_id, 'legacy-task.json')
    let snapshot: Record<string, unknown> | undefined
    try {
      const value: unknown = JSON.parse(await fs.readFile(snapshotPath, 'utf8'))
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        snapshot = value as Record<string, unknown>
      }
    } catch (error) {
      console.warn(`[WorkerHarness] legacy snapshot unavailable for ${worker.worker_id}:`, error)
    }

    let traces: Awaited<ReturnType<typeof readLegacyTraces>> | undefined
    try {
      traces = await readLegacyTraces(join(dirname(this.deps.workersDir), 'traces'))
    } catch (error) {
      console.warn(`[WorkerHarness] legacy traces unavailable for ${worker.worker_id}:`, error)
    }
    const byId = new Map(
      [...(traces?.values() ?? [])].flat().map((trace) => [trace.trace_id, trace]),
    )
    const selected = (worker.legacy_source?.trace_ids ?? [])
      .map((id) => byId.get(id))
      .filter((trace): trace is NonNullable<typeof trace> => trace !== undefined)
    const candidate = [...selected]
      .reverse()
      .find((trace) => typeof trace.resume_checkpoint?.worker_state?.cwd === 'string')
      ?.resume_checkpoint?.worker_state?.cwd

    // Never replay checkpoint messages/permissions into the new engine. Only the immutable
    // imported task snapshot and trace lifecycle/outcome metadata become a private package.
    const traceSummary = selected.map((trace) => ({
      trace_id: trace.trace_id,
      started_at: trace.started_at,
      ended_at: trace.ended_at,
      outcome: trace.outcome,
    }))
    const raw = JSON.stringify({ task: snapshot, traces: traceSummary })
    return {
      events: [{
        ts: this.deps.now(),
        kind: 'lifecycle',
        summary: raw,
      }],
      workspaceCandidate: candidate ?? fallbackWorkspace,
    }
  }

  /**
   * Handoff is derived from the native session parser while the source is still available.
   * A parser failure is non-fatal: the durable Harness event history still lets the next
   * incarnation see lifecycle facts, without reintroducing terminal capture as a data path.
   */
  private async captureHandoffPackage(
    worker: LedgerWorker,
    source: ExecutableIncarnation,
    adapter: WorkerAdapter | undefined,
    handle: IncarnationHandle,
    createdAt: string,
  ): Promise<HandoffPackage> {
    const sourceIncarnationId = requireStableIncarnationId(source, worker.worker_id)
    const evidence: HandoffEvidenceInput[] = ledgerHandoffEvidence(worker, source)
    const unavailable: string[] = []
    let activityCaptured = false
    if (adapter?.readTrace) {
      try {
        const trace = await adapter.readTrace(handle, { offset: 0 })
        if (trace.events.length > 0) {
          evidence.push(...traceHandoffEvidence('native_session', sourceIncarnationId, trace.events))
          activityCaptured = true
        } else {
          unavailable.push('native_session: no structured activity was available')
        }
      } catch (error) {
        unavailable.push('native_session: unreadable')
        console.warn(`[WorkerHarness] handoff native trace unavailable for ${worker.worker_id}#${source.seq}:`, error)
      }
    } else {
      unavailable.push('native_session: adapter has no structured trace reader')
    }

    if (!activityCaptured) {
      const persisted = await this.nativeActivityStore.activities(worker.worker_id, sourceIncarnationId)
      if (persisted.length > 0) {
        evidence.push(...traceHandoffEvidence('persisted_activity', sourceIncarnationId, persisted))
        activityCaptured = true
      } else {
        unavailable.push('persisted_activity: no recorded activity was available')
      }
    }

    if (!activityCaptured) {
      const ledgerEvents = (await this.readWorkerEvents(worker.worker_id))
        .filter((event) => event.seq === source.seq)
      if (ledgerEvents.length > 0) {
        evidence.push(...ledgerEventHandoffEvidence(worker.worker_id, source, ledgerEvents))
      } else {
        unavailable.push('ledger: no source lifecycle evidence was available')
      }
    }

    return writeHandoffPackage({
      workersDir: this.deps.workersDir,
      workerId: worker.worker_id,
      sourceIncarnationId,
      workspace: source.workspace,
      createdAt,
      evidence,
      unavailable,
    })
  }

  /**
   * 跨实现切换(manager 主导,protocol-agent-v3 §5.3"跨实现切换")。走与透明接续完全
   * 相同的交接路径(见 handoffIncarnation),区别只是:目标实现由调用方显式指定(不做
   * "原 impl 若仍可用则沿用"的自动选择),且源化身可能仍然存活(由 handoffIncarnation
   * 内部负责在这种情况下经 stop operation 核验后标 superseded)。
   *
   * 已知约束(三轮 review 修复,见 ImplAlreadyUsedError 类注释):不支持"切到该 worker
   * 曾经用过的实现"——含切回原实现(如 cc → codex → cc)、含切到当前正在用的同一实现。
   * 三个 adapter 的 spawn 都硬编码 seq=1 且带"already spawned"守卫,kill 不清除这道守卫
   * 记忆,对同一 worker_id 二次 spawn 必然失败。handoffIncarnation 的 pre-flight 会在写
   * 私有 handoff package、kill 源化身之前用 (worker.incarnations 是否已有 impl 匹配的记录) 判定并
   * fail-fast 抛 ImplAlreadyUsedError,不留半成品。根治需要 harness 自己分配 seq,是协议
   * 级改动,留待后续(protocol-agent-v3 §6.1 已知限制)。
   */
  async switchWorkerImpl(workerId: string, impl: WorkerImplId, note?: string): Promise<void> {
    this.deps.assertExecutionAdmission?.()
    let restoredDurableReceipt = false
    await this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) throw new WorkerNotFoundError(workerId)
      const { worker, managerKey } = found
      // cancelled 是唯一硬拒绝(protocol-agent-v3 §5.5,与 sendToWorker/continueTerminalWorker
      // 的 cancelled 短路对齐)。若主线化身已因 killWorker 落 exited,不加这道校验会让
      // handoffIncarnation 跳过 kill 段直接 provision+spawn 新化身,reopenTaskForContinuation
      // 命中终态走 reviveTask——用户明确要求终止的任务被无声复活成 running。completed/failed
      // 允许切换(等价于"在办任务换实现"续办的合理场景,§5.3),只有 cancelled 硬拒绝。
      if (worker.task.status === 'cancelled') throw new TaskCancelledError(workerId)
      const mainline = requireMainlineIncarnation(worker)
      const handoff = await this.handoffIncarnation(managerKey, worker, requireExecutableIncarnation(mainline), impl, note ?? '')
      restoredDurableReceipt = handoff.restoredDurableReceipt
    })
    // The old pane no longer owns a consumed durable receipt; resume its FIFO on the new incarnation.
    if (restoredDurableReceipt) await this.flushInbox(workerId)
  }

  /**
   * §5.3 透明接续:sendToWorker 命中终态化身时的分流入口。全程在该 worker 的 per-worker
   * 锁临界区内完成(brief 要求:"接续全过程在该 worker 的临界区内完成,避免与并发
   * sendToWorker/kill 交错"),调用方(inbox.flush 的 deliver 回调)本身跑在锁外,这里
   * 重新拿锁。
   *
   * sourceImpl/sourceSeq 是调用方在锁外观察到的"疑似已终态"的化身 (impl, seq)(来自台账
   * incarnation.state==='exited' 的读,或 adapter.sendInput 抛出的 WorkerExitedError 所对应
   * 的化身)。拿到锁之后必须用这对 (sourceImpl, sourceSeq)(而非再次读到的台账 state 字段)
   * 判断"这次接续还要不要做"——台账的 state 字段可能滞后于 adapter 的真实状态
   * (handleStateChange 是 fire-and-forget 异步写台账,sendInput 抛错时台账不一定已经写完),
   * 但 (sourceImpl, sourceSeq) 对应的化身"已经不是当前主线"这件事(mainline.impl !== sourceImpl
   * || mainline.seq !== sourceSeq)只有在真的发生过一次接续/切换之后才可能为真——这是判断
   * "是否已被并发接续抢先完成"唯一可靠的信号,不能用可能滞后的 state 字段替代。
   *
   * 只比 seq 不比 impl 是不够的(与 processStateChange 约 942 行的 M1 收口同一原则):等锁
   * 期间若发生的是跨实现接续/切换(如 codex#1 顶替 claude-code#1,两个 adapter 实例各自
   * nextSeq 从 1 计数,撞号是常态),新旧化身可能撞上同一个 seq——只比 seq 会把这次已经
   * 发生过的接续误判成"没发生",转而把当前存活的新主线当成终态源再接续一次(对活着的化身
   * 调 adapter.resume,adapter 侧会因"未终态"拒绝并抛错,错误经 inbox.flush 穿透给
   * sendToWorker 的调用方,打破"透明接续对调用方无感"的契约)。
   *
   * raw 透传:"补送到当前主线"分支和 sendToWorker 正常路径(见上面的 adapter.sendInput 调用)
   * 必须保持同一投递语义——`raw: true` 的原始敲键消息若在补送时丢了这个标志,会被当成普通
   * 消息投递,行为对调用方不再透明。
   *
   * 二轮 review 收口(锁内可重入求值):上面"补送到当前主线"分支曾经无条件把当前主线当存活
   * 化身直投,既不查 mainline.state,adapter.sendInput 抛出的 WorkerExitedError 也没像
   * sendToWorker 正常路径那样被接住转接续——deliver 卡在旧主线投递期间若发生并发接续/
   * 切换,且等锁期间新主线又自然退出(或 adapter 权威判定它已退出,即便台账还没追上),这个
   * WorkerExitedError 会原样穿透 inbox.flush,条目 unshift 回队首、错误砸给 sendToWorker
   * 的调用方,违反"投递永不因状态失败"与"接续对调用方无感"。
   *
   * 修法:整个"判定源化身 → 决定补送/接续"改成锁内(同一临界区,不重新拿锁——私有方法
   * 自身持锁,递归调用会死锁)的可重入求值循环:每轮拿当前源 (curImpl, curSeq) 重新读一次
   * 台账并判定——
   *   - 主线就是当前源且已终态 → 走 revive/handoff,结束;
   *   - 主线已换且存活 → 尝试补送;若 sendInput 抛 WorkerExitedError,不出锁,把这个新主线
   *     当作新的源回到循环顶部重新求值(即转接续);
   *   - 主线已换且台账里已是终态 → 不浪费一次注定失败的 sendInput,直接把它当作新的源
   *     回到循环顶部(同样转接续)。
   * 循环设上限(MAX_CONTINUATION_ITERATIONS)防病态抖动(主线在极端并发下连续多次切换/
   * 自然退出撞上同一次投递):超限说明短时间内发生了异常密集的接续/切换,不是本方法能
   * 收敛处理的情形,记事件后抛出明确错误(调用方 inbox.flush 会把这条消息放回队首,下次
   * flush 重试)。
   */
  private async continueTerminalWorker(
    workerId: string,
    text: string,
    sourceImpl: WorkerImplId,
    sourceSeq: number,
    raw: boolean,
    /**
     * 调用方是从 adapter 抛出的 WorkerExitedError 走到这里时,该错误携带的 adapter 侧
     * `ended_reason` 真值;调用方是读台账 state==='exited' 走到这里的则不带(那种情形下
     * 台账已经有终态记录,reviveIncarnation 的回填段本就不会触发)。
     */
    sourceEndReason?: IncarnationEndReason,
    item?: InboxItem,
  ): Promise<InboxSettlement | InboxDeliveryResult | InboxSettledResult> {
    const result = await this.withLock(
      workerId,
      async (): Promise<InboxSettlement | InboxDeliveryResult | InboxSettledResult | { attempt: SettledInputAttempt }> => {
      let curImpl = sourceImpl
      let curSeq = sourceSeq
      // 与 (curImpl, curSeq) 同步前进:每次改换源化身,这个原因也要跟着换成新源的,
      // 否则会把旧源的终止原因错记到新源头上。
      let curEndReason = sourceEndReason

      for (let iteration = 0; iteration < MAX_CONTINUATION_ITERATIONS; iteration++) {
        const found = await this.deps.ledger.findWorker(workerId)
        if (!found) throw new WorkerNotFoundError(workerId)
        const { worker, managerKey } = found

        // task 在锁外投递期间被 killWorker 打断(如 send 卡在 tmux 投递期间调 kill,这条
        // 消息在拿到这把锁之前就已经确定要走接续路径了):§5.5"唯一硬拒绝:cancelled"只
        // 约束 sendToWorker 入队前的把关(见该方法顶部),这里是入队之后才发现的迟到判定,
        // 不能再用同一处把关。cancelled 是终态,不能被下面的 reviveIncarnation/handoffIncarnation
        // 经 reopenTaskForContinuation → reviveTask 复活成 running——那样会让已经明确要求
        // 终止的 task 又"activate"出一个新化身。同时"send_to_worker 投递永不因状态失败"
        // 是调用方(inbox.flush)的既有契约,消息不能静默消失:丢弃这条并记 dead-letter 事件,
        // 不重新抛出(抛出会砸向早已异步返回的 sendToWorker 调用方,变成没人处理的 rejection)。
        if (worker.task.status === 'cancelled') {
          await this.appendEvent(workerId, curSeq, 'state_changed', {
            kind: 'dead_letter',
            reason: 'task_cancelled',
            text_len: text.length,
          })
          return item?.delivery_id
            ? {
                action: 'settled',
                settlement: 'dead_letter',
                detail: { seq: curSeq, reason: 'task_cancelled', certainty: 'not_delivered' },
              }
            : 'dead_letter'
        }

        const mainline = requireMainlineIncarnation(worker)
        if (!isExecutableIncarnation(mainline)) {
          throw new Error('WorkerHarness.sendToWorker: legacy worker continuation is not available')
        }

        if (mainline.seq !== curSeq || mainline.impl !== curImpl) {
          // 并发窗口:拿锁之前,该 worker 已经被另一次并发触发的接续/切换抢先完成——主线已经
          // 前进到更新的化身(按 (impl, seq) 判定,不能只比 seq,见上面方法注释)。
          if (mainline.state === 'exited') {
            // 台账已经把这个更新的主线也记为终态——不必再尝试一次注定失败的 sendInput,
            // 把它当作新的源头,回到循环顶部,以它走接续。
            curImpl = mainline.impl
            curSeq = mainline.seq
            // 台账已有这条化身的终态记录,回填段不会触发,没有原因要携带。
            curEndReason = undefined
            continue
          }
          // 按普通投递语义把这条消息补送到当前(存活)主线,不重复接续,并保留原条目的
          // raw 标志。
          const adapter = this.deps.adapters.get(mainline.impl)
          if (!adapter) {
            throw new Error(`WorkerHarness.sendToWorker: no adapter registered for impl '${mainline.impl}'`)
          }
          const handle: IncarnationHandle = {
            worker_id: workerId,
            seq: mainline.seq,
            impl: mainline.impl,
            session_ref: mainline.session_ref,
          }
          const attempt = await this.attemptInput(
            adapter,
            handle,
            text,
            raw,
            item?.delivery_id ? await this.inputAttemptOptions(workerId, item.delivery_id) : undefined,
          )
          if (attempt.kind === 'exited') {
            // adapter 侧权威判定这个"看起来存活"的新主线其实也已经终态(台账的异步状态
            // 回调还没追上)——同样不出锁,把它当作新的源头回到循环顶部转接续。
            curImpl = mainline.impl
            curSeq = mainline.seq
            curEndReason = attempt.endedReason
            continue
          }
          // CLI stall / accepted-exit / 延后 session_ref 必须与普通 flush 路径共用结算；
          // 结算可能重新获取 worker lock，所以先把 attempt 带出当前临界区。
          return { attempt }
        }

        // 主线就是当前源:走接续(revive/handoff)。
        const adapter = this.deps.adapters.get(mainline.impl)
        if (!adapter) {
          throw new Error(`WorkerHarness.sendToWorker: no adapter registered for impl '${mainline.impl}' (continuation)`)
        }

        if (adapter.capabilities().revive) {
          const delivery = await this.reviveIncarnation(
            managerKey,
            worker,
            mainline,
            adapter,
            text,
            curEndReason,
          )
          if (isContinuationRetry(delivery)) {
            curImpl = delivery.impl
            curSeq = delivery.seq
            curEndReason = delivery.endedReason
            continue
          }
          return delivery
        } else {
          // "原 impl 若仍可用则沿用,否则 defaultImpl"(brief)是加 ImplAlreadyUsedError 守卫
          // 之前的选择逻辑,现在必然自绝:mainline.impl 就是正在办理接续的这条化身所在的
          // impl,它在 worker.incarnations 里必然已经"用过",沿用它会被 handoffIncarnation
          // 的 pre-flight 直接拒绝。改选一个这个 worker 尚未用过的可用实现(pickUnusedImpl:
          // defaultImpl 优先,否则从 deps.adapters 里挑第一个未用过的);全都用过时原样交给
          // handoffIncarnation 的 pre-flight 统一抛 ImplAlreadyUsedError,不在这里重复判断。
          // 三个既有实现目前都是 revive:true,这条分支走不到真实 adapter;为将来的不可复活
          // 实现(如 legacy)保留。
          const usedImpls2 = new Set(worker.incarnations.map((inc) => inc.impl).filter((impl): impl is WorkerImplId => impl !== 'legacy'))
          const targetImpl = this.deps.selectWorkerImpl
            ? this.deps.selectWorkerImpl(undefined, usedImpls2)
            : pickUnusedImpl(worker, this.deps.adapters, this.deps.defaultImpl)
          const handoff = await this.handoffIncarnation(
            managerKey,
            worker,
            mainline,
            targetImpl,
            text,
            true,
            raw,
          )
          if (isContinuationRetry(handoff.delivery)) {
            curImpl = handoff.delivery.impl
            curSeq = handoff.delivery.seq
            curEndReason = handoff.delivery.endedReason
            continue
          }
          return handoff.delivery
        }
      }

      // 超出重求值上限:短时间内主线连续多次切换/自然退出,撞上了同一次投递的每一次重新
      // 判定,不是本方法能收敛处理的病态抖动。记事件留痕,抛出明确错误——inbox.flush 会把
      // 这条消息放回队首、原样向上抛,不静默丢弃,调用方或下一轮 flush 有机会重试。
      await this.appendEvent(workerId, curSeq, 'state_changed', {
        kind: 'continuation_loop_exceeded',
        max_iterations: MAX_CONTINUATION_ITERATIONS,
        text_len: text.length,
      })
      throw new Error(
        `WorkerHarness.continueTerminalWorker: exceeded max re-evaluation iterations (${MAX_CONTINUATION_ITERATIONS}) ` +
          `for worker ${workerId}; mainline kept changing/exiting faster than this delivery could settle on a source`
      )
    })
    if (typeof result === 'object' && 'attempt' in result) {
      return this.settleInputAttempt(workerId, text, raw, result.attempt, item)
    }
    if (!item?.delivery_id || typeof result !== 'string' || result !== 'delivered') return result
    const found = await this.deps.ledger.findWorker(workerId)
    return {
      action: 'settled',
      settlement: 'delivered',
      detail: { seq: found ? requireMainlineIncarnation(found.worker).seq : sourceSeq },
    }
  }

  /** capabilities().revive===true 分支:adapter.resume 拉起新化身,session 满保真接续。 */
  private async reviveIncarnation(
    managerKey: ManagerKey,
    worker: LedgerWorker,
    mainline: ExecutableIncarnation,
    adapter: WorkerAdapter,
    text: string,
    /** adapter 经 WorkerExitedError 报上来的源化身终止原因(见下面回填段的注释)。 */
    sourceEndReason?: IncarnationEndReason,
  ): Promise<ContinuationDelivery> {
    this.deps.assertExecutionAdmission?.()
    // P6-B：resume 重验 ready（「已有 running incarnation 不杀，新 resume/handoff 重验」）。
    await this.deps.assertWorkerImplReady?.(mainline.impl)
    const incarnationId = randomUUID()
    const instructions = await captureWorkspaceInstructions({
      workersDir: this.deps.workersDir,
      workerId: worker.worker_id,
      incarnationId,
      workspaceRoot: mainline.workspace,
      capturedAt: this.deps.now(),
    })
    const claudeBridge = mainline.impl === 'claude-code'
      ? await prepareClaudeWorkspaceBridge({
        workersDir: this.deps.workersDir,
        workerId: worker.worker_id,
        incarnationId,
        workspaceRoot: mainline.workspace,
        instructions,
      })
      : undefined
    // P6-B §6.5：resume 同样 operation-time 解析连接（revision 变化即拒绝）。
    const admission = await this.deps.admitWorkerConnection?.(mainline.impl, worker.worker_id)
    const prevRef: IncarnationRef = { worker_id: worker.worker_id, incarnation_id: mainline.incarnation_id, seq: mainline.seq, session_ref: mainline.session_ref }
    // resume 直接把 text 作为 wakeInput 传入——接续就是这次输入的投递方式,不需要在
    // resume 成功之后再补一次 adapter.sendInput。
    let newHandle
    try {
      const returnedHandle = await adapter.resume(prevRef, text, {
        ...(admission ? { connection_env: admission.env } : {}),
        incarnation_id: incarnationId,
        ...(mainline.impl === 'builtin' || claudeBridge?.kind === 'user_owned_claude_md'
          ? { workspace_instructions: instructions }
          : {}),
      })
      if (returnedHandle.incarnation_id !== undefined && returnedHandle.incarnation_id !== incarnationId) {
        throw new Error(`WorkerHarness.reviveIncarnation: adapter returned mismatched incarnation_id for ${worker.worker_id}`)
      }
      newHandle = { ...returnedHandle, incarnation_id: incarnationId }
      await this.deps.reportWorkerOutcome?.(mainline.impl, null)
    } catch (error) {
      if (error instanceof WorkerImplUnavailableError) {
        await this.deps.reportWorkerOutcome?.(mainline.impl, error.message)
      }
      if (admission) await admission.dispose()
      throw error
    }
    // 新化身的 runtime 资源活到新化身终态（spawn 路径同纪律）。
    if (admission) this.connectionDisposers.set(`${worker.worker_id}:${newHandle.seq}`, admission.dispose)

    const initialInput = newHandle.initial_input
    const initialState = cliContractState(initialInput?.control_state ?? 'running')
    // 返回即终态（启动期握手超时等）不会再有终态钩子——立即 dispose，不注册。
    if (admission && initialState === 'exited') {
      this.connectionDisposers.delete(`${worker.worker_id}:${newHandle.seq}`)
      await admission.dispose()
    }
    const now = this.deps.now()
    const revived = await this.deps.ledger.upsertWorker(managerKey, worker.worker_id, (prev) => {
      if (!prev) return undefined
      const newIncarnation: Incarnation = {
        incarnation_id: incarnationId,
        seq: newHandle.seq,
        impl: newHandle.impl,
        state: initialState,
        workspace: mainline.workspace,
        session_ref: newHandle.session_ref,
        started_at: now,
        workspace_instructions: instructions.snapshot,
        ...(initialState === 'exited'
          ? { ended_at: now, ended_reason: initialInput?.report?.endReason ?? 'crashed' }
          : {}),
        // forked_from 不填——resume 产出的新化身入主线链(protocol-agent-v3 §5.3)。
      }
      // 源化身(mainline)台账态若仍非 exited——sendToWorker 经 WorkerExitedError 走到这里时,
      // 台账的异步状态回调很可能还没追上 adapter 的真实状态(见 continueTerminalWorker 顶部
      // 注释)——必须在 revive 前把它收尾,否则新化身入链后主线就换成了新 seq,后续迟到的
      // processStateChange 会因 mainline.seq !== h.seq 被直接丢弃,旧化身永久卡在非终态、
      // 无终态记录。对齐 handoffIncarnation 对同一竞态的处理(§5.3):这里同样只在源化身
      // 台账态非 exited 时才回填,不覆盖已经真实记录过的终态。回填的原因优先取
      // `sourceEndReason`——adapter 抛 WorkerExitedError 时随错误带上来的自己那份
      // `ended_reason` 真值(builtin 是 finish_task 的结构化确证);它缺席只有一种情形:
      // 重启后 adapter 的常驻 runtime 表为空、连落盘 meta 都读不回来,对 adapter 而言
      // 这条化身只是"与已终态等价",确实无原因可给。那时沿用既有近似值 'completed'
      // ——语境是"已经在准备接续续命",不是被 kill。
      const incarnations =
        mainline.state !== 'exited'
          ? patchIncarnationBySeq(prev.incarnations, mainline.impl, mainline.seq, {
              state: 'exited',
              ended_at: now,
              ended_reason: sourceEndReason ?? 'completed',
            })
          : prev.incarnations
      let nextTask = reopenTaskForContinuation(prev.task, now)
      nextTask = settleCliTask(nextTask, initialState, initialInput?.report, now)
      const supervision = supervisionAfterMainlineTransition(
        prev.supervision,
        nextTask.status,
        initialState,
        newHandle.seq,
        now,
        true,
      )
      return {
        ...prev,
        task: nextTask,
        incarnations: [...incarnations, newIncarnation],
        ...(supervision ? { supervision } : {}),
        updated_at: now,
      }
    })

    this.bumpInputOwnershipRevision(worker.worker_id)
    const inbox = this.getInbox(worker.worker_id)
    inbox.release()
    const replayedConsumed = inbox.requeueConsumed()
    await this.appendEvent(worker.worker_id, newHandle.seq, 'resumed', { from_seq: mainline.seq }, revived?.task.status)
    const uiSnapshot = await this.prepareUiSnapshot(newHandle, managerKey, initialInput?.report, now)
    const turn = initialInput
      ? await this.createPendingTurn(managerKey, newHandle, initialInput.report, now)
      : undefined
    if (initialInput && (initialInput.disposition !== 'accepted' || initialState !== 'running')) {
      await this.appendEvent(worker.worker_id, newHandle.seq, 'state_changed', {
        ...cliReportDetail(initialState, initialInput.report),
        ...uiSnapshotDetail(uiSnapshot),
        ...(turn ? { turn_id: turn.turn_id, turn_pending: true } : {}),
      }, revived?.task.status)
    }
    return continuationDelivery(initialInput, initialState, newHandle, replayedConsumed)
  }

  /**
   * capabilities().revive===false 分支(交接续办),以及 switchWorkerImpl 复用的公共路径。
   * 顺序对齐 protocol-agent-v3 §5.3"跨实现切换":目标实现先完成无副作用 provision pre-flight
   * → Harness 持久化交接包 → (若仍存活)stop 核验并标 superseded → 同 workspace provision+spawn 新实现 → 化身链 +1。
   */
  private async handoffIncarnation(
    managerKey: ManagerKey,
    worker: LedgerWorker,
    source: ExecutableIncarnation,
    targetImpl: WorkerImplId,
    input: string,
    inputOwnedByInbox = false,
    inboxRaw = false,
  ): Promise<HandoffResult> {
    this.deps.assertExecutionAdmission?.()
    const sourceAdapter = this.deps.adapters.get(source.impl)
    const sourceHandle: IncarnationHandle = {
      worker_id: worker.worker_id,
      ...(source.incarnation_id ? { incarnation_id: source.incarnation_id } : {}),
      seq: source.seq,
      impl: source.impl,
      session_ref: source.session_ref,
    }

    // 0. Pre-flight(三轮 review 修复):目标 impl 若在这个 worker 名下已经有过任何化身
    // (含已终态、含 fork 分支,见 ImplAlreadyUsedError 类注释)——即"切到该 worker 曾经用过
    // 的实现"(含切回原实现、同实现切换)——必然会在下面 step 3 的 newAdapter.spawn 里抛错:
    // 三个 adapter 的 spawn 都硬编码 seq=1 且带"already spawned"守卫,kill 不清除这道守卫
    // 记忆。若这里不拦,失败会发生在 step 2(kill 源化身、标 superseded)之后,重蹈本方法
    // pre-flight 本该防住的"旧的没了、新的没建成"死结。放在最前面、比下面 targetImpl 是否
    // 有 adapter 注册的检查还早,因为它不需要先查 adapter 就能判定。
    if (implAlreadyUsed(worker, targetImpl)) {
      throw new ImplAlreadyUsedError(worker.worker_id, targetImpl)
    }

    // 0b. Pre-flight(裁决 B 修复):目标 adapter 必须存在;若目标是 'builtin',调用方必须
    // 通过 HarnessDeps.builtinSpawnDefaults 提供 LLM 注入,否则 step 3 的 newAdapter.spawn
    // 必然因 spec.builtin 缺失而抛错(BuiltinWorkerAdapter.spawn 本就 fail-loud)。修复前这
    // 个抛错发生在 step 3——此时旧化身已经在 step 2 被停止并标 superseded,worker 卡进
    // "旧的没了、新的没建成"的死结,且下次投递会重复整套 handoff（重复生成 package）。
    // 把这两项检查提到最前面、在生成 package 和停止旧化身之前做,失败时旧化身不动,
    // 保持可重试。
    // P6-B：目标 impl 重验 ready（配置可能在 source 运行期间已失效）。
    await this.deps.assertWorkerImplReady?.(targetImpl)
    // P6-B §6.5：handoff 同样过 connection admission——早于 package 生成与 source stop；
    // admin_provider 形态下目标 CLI 不得静默回落宿主原生凭证。
    const admission = await this.deps.admitWorkerConnection?.(targetImpl, worker.worker_id)
    const newAdapter = this.deps.adapters.get(targetImpl)
    if (!newAdapter) {
      if (admission) await admission.dispose()
      throw new Error(`WorkerHarness.handoffIncarnation: no adapter registered for impl '${targetImpl}' (handoff target)`)
    }
    let handoffContext
    let principalPermissions
    let builtinInjection: SpawnSpec['builtin']
    let workspace: Workspace
    let caps
    let targetIncarnationId: string
    let targetInstructions: Awaited<ReturnType<typeof captureWorkspaceInstructions>>
    let targetClaudeBridge: Awaited<ReturnType<typeof prepareClaudeWorkspaceBridge>> | undefined
    let handoff: HandoffPackage
    try {
      handoffContext = await this.contextStore.read(worker.worker_id)
      principalPermissions = handoffContext?.principal_permissions
      if (targetImpl === 'builtin' && !this.deps.builtinSpawnDefaults) {
        throw new Error(
          `WorkerHarness.handoffIncarnation: handoff target impl is 'builtin' but no builtinSpawnDefaults ` +
            `configured on HarnessDeps; refusing before touching the source incarnation (worker ${worker.worker_id}#${source.seq})`
        )
      }

      workspace = { root: source.workspace }
      caps = this.deps.capabilityBundle
        ? await this.deps.capabilityBundle({ worker_id: worker.worker_id, principal_permissions: principalPermissions })
        : EMPTY_CAPABILITY_BUNDLE
      // tracked credential target 等确定性检查必须在 package / source stop 之前完成；preflightProvision
      // 不得写 workspace。正式 provision 仍在 source teardown 之后执行并重检，避免 TOCTOU 静默越界。
      await newAdapter.preflightProvision?.(workspace, caps)

      // The target identity, workspace rules snapshot and the private handoff package all exist
      // before we stop the source. Any failure here leaves the source untouched and retryable.
      targetIncarnationId = randomUUID()
      const capturedAt = this.deps.now()
      targetInstructions = await captureWorkspaceInstructions({
        workersDir: this.deps.workersDir,
        workerId: worker.worker_id,
        incarnationId: targetIncarnationId,
        workspaceRoot: workspace.root,
        capturedAt,
      })
      if (targetImpl === 'builtin') {
        builtinInjection = this.deps.builtinSpawnDefaults?.({
          worker_id: worker.worker_id,
          workspace,
          origin: worker.origin,
          goal: worker.task.goal,
          principal_permissions: principalPermissions,
          workspace_instructions: targetInstructions,
        })
        if (!builtinInjection) {
          throw new Error(
            `WorkerHarness.handoffIncarnation: builtinSpawnDefaults returned no runtime config ` +
              `(worker ${worker.worker_id}#${source.seq})`,
          )
        }
      }
      targetClaudeBridge = targetImpl === 'claude-code'
        ? await prepareClaudeWorkspaceBridge({
            workersDir: this.deps.workersDir,
            workerId: worker.worker_id,
            incarnationId: targetIncarnationId,
            workspaceRoot: workspace.root,
            instructions: targetInstructions,
          })
        : undefined
      handoff = await this.captureHandoffPackage(worker, source, sourceAdapter, sourceHandle, capturedAt)
    } catch (error) {
      // admission 之后、package/kill 之前的前置失败：dispose admission，source 不动。
      if (admission) await admission.dispose()
      throw error
    }

    // 1. Persist the package before source teardown. Terminal capture is deliberately absent:
    // it is a caller-driven diagnostic viewport, not a handoff or result data source.
    try {
      await this.appendEvent(worker.worker_id, source.seq, 'handoff_started', {
        target_impl: targetImpl,
        handoff_id: handoff.package_id,
      })

      // 2. A live source crosses the same durable stop-and-verify boundary as the Manager tool.
      // An unknown or failed stop never starts a target, avoiding two simultaneous mainlines.
      if (source.state !== 'exited') {
        const stop = await this.stopSourceForHandoffLocked(managerKey, worker, source)
        if (stop.status !== 'succeeded') {
          throw new Error(`WorkerHarness.handoffIncarnation: source stop did not verify (${stop.status})`)
        }
      }
    } catch (error) {
      // Source teardown failure leaves the private package as evidence, but does not create a target.
      if (admission) await admission.dispose()
      throw error
    }

    // 3. Same workspace, new implementation. Its opening input embeds a bounded projection of
    // the package, so workers never need to read a workspace handoff file.
    // newAdapter / builtinInjection / workspace / caps 已在上面的 pre-flight 里取好。
    const prompt = renderHandoffPrompt(handoff, input)
    let newHandle
    try {
      await newAdapter.provision(workspace, caps)
      newHandle = await newAdapter.spawn({
        worker_id: worker.worker_id,
        incarnation_id: targetIncarnationId,
        prompt,
        workspace,
        ...(targetImpl === 'builtin' || targetClaudeBridge?.kind === 'user_owned_claude_md'
          ? { workspace_instructions: targetInstructions }
          : {}),
        goal: worker.task.goal,
        origin: worker.origin,
        principal_permissions: principalPermissions,
        builtin: builtinInjection,
        ...(admission && Object.keys(admission.env).length > 0 ? { connection_env: admission.env } : {}),
      })
    } catch (error) {
      if (targetClaudeBridge?.managed) {
        await cleanupClaudeWorkspaceBridge({
          workersDir: this.deps.workersDir,
          workerId: worker.worker_id,
          incarnationId: targetIncarnationId,
          workspaceRoot: workspace.root,
        }).catch((cleanupError) => console.warn(`[WorkerHarness] failed to clean Claude workspace bridge for ${worker.worker_id}:`, cleanupError))
      }
      // provision/spawn 失败：dispose admission；只认 impl 失效证据才置 degraded。
      if (error instanceof WorkerImplUnavailableError) {
        await this.deps.reportWorkerOutcome?.(targetImpl, error.message)
      }
      if (admission) await admission.dispose()
      throw error
    }
    if (newHandle.incarnation_id !== undefined && newHandle.incarnation_id !== targetIncarnationId) {
      throw new Error(`WorkerHarness.handoffIncarnation: adapter returned mismatched incarnation_id for ${worker.worker_id}`)
    }
    newHandle = { ...newHandle, incarnation_id: targetIncarnationId }
    await this.deps.reportWorkerOutcome?.(targetImpl, null)
    // 新化身持有 admission 资源至终态。
    if (admission) this.connectionDisposers.set(`${worker.worker_id}:${newHandle.seq}`, admission.dispose)

    // 4. 化身链 +1,task 重新回到 running(见 reopenTaskForContinuation 注释)。
    const initialInput = newHandle.initial_input
    const initialState = cliContractState(initialInput?.control_state ?? 'running')
    if (admission && initialState === 'exited') {
      this.connectionDisposers.delete(`${worker.worker_id}:${newHandle.seq}`)
      await admission.dispose()
    }
    const now = this.deps.now()
    const handedOff = await this.deps.ledger.upsertWorker(managerKey, worker.worker_id, (prev) => {
      if (!prev) return undefined
      const newIncarnation: Incarnation = {
        incarnation_id: targetIncarnationId,
        seq: newHandle.seq,
        impl: targetImpl,
        state: initialState,
        workspace: source.workspace,
        workspace_instructions: targetInstructions.snapshot,
        session_ref: newHandle.session_ref,
        started_at: now,
        ...(initialState === 'exited'
          ? { ended_at: now, ended_reason: initialInput?.report?.endReason ?? 'crashed' }
          : {}),
      }
      let nextTask = reopenTaskForContinuation(prev.task, now)
      nextTask = settleCliTask(nextTask, initialState, initialInput?.report, now)
      const supervision = supervisionAfterMainlineTransition(
        prev.supervision,
        nextTask.status,
        initialState,
        newHandle.seq,
        now,
        true,
      )
      return {
        ...prev,
        task: nextTask,
        incarnations: [...prev.incarnations, newIncarnation],
        ...(supervision ? { supervision } : {}),
        updated_at: now,
      }
    })

    this.bumpInputOwnershipRevision(worker.worker_id)
    const inbox = this.getInbox(worker.worker_id)
    inbox.release()
    if (!inputOwnedByInbox && initialState !== 'exited' && initialInput?.disposition === 'not_pasted') {
      inbox.enqueueFront({ text: prompt, raw: false, enqueued_at: now })
      inbox.hold('waiting_action')
    } else if (!inputOwnedByInbox && initialState !== 'exited' && initialInput?.disposition === 'pending_in_ui') {
      inbox.hold('input_pending')
    }
    const replayedConsumed = inbox.requeueConsumed()
    const restoredDurableReceipt = replayedConsumed > 0
    // 与 reviveIncarnation 收尾时发 'resumed' 事件对称——交接产出的新化身同样是一次"开工",
    // 缺了这个事件会让事件流看不到 handoff 之后新主线是何时、以何种 impl 建起来的。
    await this.appendEvent(
      worker.worker_id,
      newHandle.seq,
      'spawned',
      { impl: targetImpl, from_seq: source.seq, handoff_id: handoff.package_id },
      handedOff?.task.status
    )
    const uiSnapshot = await this.prepareUiSnapshot(newHandle, managerKey, initialInput?.report, now)
    const turn = initialInput
      ? await this.createPendingTurn(managerKey, newHandle, initialInput.report, now)
      : undefined
    if (initialInput && (initialInput.disposition !== 'accepted' || initialState !== 'running')) {
      await this.appendEvent(worker.worker_id, newHandle.seq, 'state_changed', {
        ...cliReportDetail(initialState, initialInput.report),
        ...uiSnapshotDetail(uiSnapshot),
        ...(turn ? { turn_id: turn.turn_id, turn_pending: true } : {}),
      }, handedOff?.task.status)
    }
    return {
      restoredDurableReceipt,
      delivery: inputOwnedByInbox
        ? continuationDelivery(
            initialInput,
            initialState,
            newHandle,
            replayedConsumed,
            { text: prompt, raw: inboxRaw },
          )
        : 'delivered',
    }
  }

  /**
   * P4 Task 4 additive:`opts.seq` 缺省时逐字沿用既有行为(读主线化身,同 sendToWorker——
   * 不被 fork 出的侧问分支顶替)。给了 `opts.seq` 则改读该 seq 对应的化身——供 query_worker
   * 的侧问答案就绪后按事件里给出的 seq 读取(P3 终审已预留:"queryWorker 的 fork 答案无法
   * 经 harness 读 → P4 接线时加按 seq 读输出的入口")。查找按 findIncarnationBySeq 的
   * "取最后一条匹配"原则,与 findIncarnation/patchIncarnationBySeq 的 (impl,seq) 判定同一
   * 纪律(见该函数注释)。seq 不存在时抛明确错误,不静默返回空 chunk。
   */
  async getWorkerTerminal(workerId: string, opts?: { seq?: number }): Promise<WorkerTerminalView> {
    const found = await this.deps.ledger.findWorker(workerId)
    if (!found) throw new WorkerNotFoundError(workerId)
    if (found.worker.incarnations.length === 0) throw new WorkerHasNoIncarnationError(workerId)
    const incarnation = opts?.seq === undefined
      ? requireMainlineIncarnation(found.worker)
      : findIncarnationBySeq(found.worker, opts.seq)
    if (!incarnation) {
      throw new Error(`WorkerHarness.getWorkerTerminal: no incarnation with seq=${opts?.seq} found for worker ${workerId}`)
    }
    if (isLegacyIncarnation(incarnation)) {
      return { kind: 'unavailable', unavailable_reason: 'legacy_without_terminal_snapshot' }
    }
    const adapter = this.deps.adapters.get(incarnation.impl)
    if (!adapter) {
      throw new Error(`WorkerHarness.getWorkerTerminal: no adapter registered for impl '${incarnation.impl}'`)
    }
    const handle: IncarnationHandle = {
      worker_id: workerId,
      seq: incarnation.seq,
      impl: incarnation.impl,
      session_ref: incarnation.session_ref,
      ...(incarnation.query_id ? { query_id: incarnation.query_id } : {}),
    }
    return adapter.readTerminal(handle)
  }

  async hasWorker(workerId: string): Promise<boolean> {
    return (await this.deps.ledger.findWorker(workerId)) !== undefined
  }

  async findWorker(workerId: string): Promise<{ managerKey: ManagerKey; worker: LedgerWorker } | undefined> {
    return this.deps.ledger.findWorker(workerId)
  }

  async getWorkerTurn(workerId: string, turnId?: string): Promise<WorkerTurn | undefined> {
    return this.turnStore.get(workerId, turnId)
  }

  async getLatestWorkerActivity(workerId: string, incarnationId: IncarnationId): Promise<WorkerActivity | undefined> {
    const latest = (await this.nativeActivityStore.activities(workerId, incarnationId)).at(-1)
    return latest && projectWorkerActivity([latest], 'all', { worker_id: workerId, incarnation_id: incarnationId })[0]
  }

  async getWorkerControlOperations(workerId: string): Promise<WorkerControlOperation[]> {
    return this.controlOperationStore.active(workerId)
  }

  private async prepareUiSnapshot(
    h: IncarnationHandle,
    managerKey: ManagerKey,
    report: StateChangeReport | undefined,
    now: string,
  ): Promise<WorkerUiSnapshot | undefined> {
    if (!h.incarnation_id || h.query_id) return undefined
    if (report?.waitReason !== 'interaction_required' || !report.ui) {
      await this.uiSnapshotStore.staleActive(h.worker_id)
      return undefined
    }
    return this.uiSnapshotStore.prepare({
      worker_id: h.worker_id,
      manager_key: managerKey,
      incarnation_id: h.incarnation_id,
      impl: h.impl,
      seq: h.seq,
      fingerprint: report.ui.fingerprint,
      actions: report.ui.actions,
      created_at: now,
    }, true, now)
  }

  async respondToWorkerUi(
    workerId: string,
    snapshotId: string,
    actionId: WorkerUiActionId,
    text?: string,
  ): Promise<{
    worker_id: string
    snapshot_id: string
    action_id: WorkerUiActionId
    status: 'submitted'
    operation: WorkerControlOperation
  }> {
    return this.withLock(workerId, async () => {
      const snapshot = await this.getActiveUiSnapshot(workerId, snapshotId)
      const action = snapshot.actions.find((candidate) => candidate.action_id === actionId)
      if (!action) throw new Error('worker UI action is not available for this snapshot')
      const response = this.materializeUiResponse(action, text)
      const found = await this.deps.ledger.findWorker(workerId)
      const mainline = found && mainlineIncarnation(found.worker)
      if (!found || !mainline || !isExecutableIncarnation(mainline) || mainline.incarnation_id !== snapshot.incarnation_id) {
        throw new Error('worker UI snapshot is stale for the current mainline incarnation')
      }
      const adapter = this.deps.adapters.get(mainline.impl)
      if (!adapter?.respondToUi) throw new Error(`worker impl '${mainline.impl}' does not support UI responses`)
      const acceptedAt = this.deps.now()
      const operation = await this.controlOperationStore.create({
        worker_id: workerId,
        manager_key: found.managerKey,
        incarnation_id: snapshot.incarnation_id,
        impl: mainline.impl,
        seq: mainline.seq,
        kind: 'ui_response',
        created_at: acceptedAt,
      })
      const executing = await this.controlOperationStore.transition(
        workerId,
        operation.operation_id,
        'executing',
        acceptedAt,
      )
      try {
        // A response is single-use once admitted. A native adapter error can mean that a key was
        // already accepted, so keep the snapshot consumed and settle unknown rather than retrying.
        await this.uiSnapshotStore.consume(workerId, snapshotId, acceptedAt)
        await adapter.respondToUi(handleForIncarnation(workerId, mainline), response)
      } catch (error) {
        await this.settleControlOperation(
          executing,
          'unknown',
          error instanceof Error ? error.message : String(error),
        )
        throw error
      }
      const settled = await this.settleControlOperation(executing, 'succeeded', 'UI response submitted to adapter')
      await this.appendAuditEvent(workerId, mainline.seq, 'state_changed', {
        kind: 'ui_response_submitted',
        snapshot_id: snapshotId,
        action_id: actionId,
        operation_id: settled.operation_id,
      })
      return {
        worker_id: workerId,
        snapshot_id: snapshotId,
        action_id: actionId,
        status: 'submitted',
        operation: settled,
      }
    })
  }

  private async getActiveUiSnapshot(workerId: string, snapshotId: string): Promise<WorkerUiSnapshot> {
    // `consume` is the durable, expiry-checked transition. This preflight only lets an invalid
    // action fail without burning the one-time snapshot.
    const snapshot = await this.uiSnapshotStore.get(workerId, snapshotId)
    if (!snapshot) throw new Error('worker UI snapshot not found')
    if (snapshot.status !== 'active') throw new Error(`worker UI snapshot is ${snapshot.status}`)
    return snapshot
  }

  private materializeUiResponse(action: WorkerUiActionDescriptor, text: string | undefined): WorkerUiResponse {
    if (action.kind === 'keys') {
      if (text !== undefined) throw new Error('worker UI key action does not accept text')
      return { kind: 'keys', keys: action.keys }
    }
    if (typeof text !== 'string') throw new Error('worker UI text action requires text')
    if (text.length < (action.min_length ?? 0) || text.length > action.max_length) {
      throw new Error(`worker UI text must contain ${action.min_length ?? 0}-${action.max_length} characters`)
    }
    return { kind: 'text', text }
  }

  async getWorkerTurnActivities(turn: WorkerTurn): Promise<WorkerTurnActivityRead> {
    const found = await this.deps.ledger.findWorker(turn.worker_id)
    const incarnation = found?.worker.incarnations.find(
      (candidate): candidate is ExecutableIncarnation =>
        isExecutableIncarnation(candidate) && candidate.incarnation_id === turn.incarnation_id,
    )
    if (!incarnation) return { events: [], unavailableReason: 'turn incarnation is unavailable' }
    const from = Number.parseInt(turn.activity_from, 10)
    const through = Number.parseInt(turn.activity_through, 10)
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(through) || from < 0 || through < from) {
      return { events: [], unavailableReason: 'turn activity range is unavailable' }
    }

    const persistedFallback = async (reason: string): Promise<WorkerTurnActivityRead> => {
      try {
        const events = (await this.nativeActivityStore.activities(turn.worker_id, turn.incarnation_id))
          .filter((activity) => activity.source_offset !== undefined && activity.source_offset >= from && activity.source_offset < through)
          .map((activity) => ({
            ts: activity.ts,
            kind: activity.kind,
            ...(activity.role ? { role: activity.role } : {}),
            summary: activity.summary,
            source: 'native' as const,
            source_offset: activity.source_offset,
          }))
        return events.length > 0 ? { events } : { events: [], unavailableReason: reason }
      } catch {
        return { events: [], unavailableReason: `${reason}; persisted activity is unavailable` }
      }
    }

    const adapter = this.deps.adapters.get(incarnation.impl)
    if (!adapter?.readTrace) return persistedFallback('worker adapter does not support structured trace reads')
    try {
      const trace = await adapter.readTrace({
        worker_id: turn.worker_id,
        incarnation_id: turn.incarnation_id,
        seq: incarnation.seq,
        impl: incarnation.impl,
        session_ref: incarnation.session_ref,
      }, { offset: from })
      if (trace.nextCursor.offset < through) return persistedFallback('native turn activity is unavailable')
      return { events: trace.events.filter((event) => event.source_offset === undefined || event.source_offset < through) }
    } catch {
      return persistedFallback('native turn activity is unavailable')
    }
  }

  async resolveWorkerTurn(
    workerId: string,
    turnId: string,
    resolution: WorkerTurnResolution,
    reason?: string,
  ): Promise<WorkerTurn> {
    return this.turnStore.resolve(workerId, turnId, resolution, this.deps.now(), reason)
  }

  private async createPendingTurn(
    managerKey: ManagerKey,
    handle: IncarnationHandle,
    report: StateChangeReport | undefined,
    completedAt: string,
  ): Promise<WorkerTurn | undefined> {
    if (!handle.incarnation_id || !report?.completionSource) return undefined
    const prior = await this.turnStore.latestForIncarnation(handle.worker_id, handle.incarnation_id)
    let activityThrough = prior?.activity_through ?? '0'
    try {
      activityThrough = String(await this.nativeActivityStore.cursor(handle.worker_id, handle.incarnation_id))
    } catch (error) {
      // The turn and its state event remain the delivery boundary. A degraded activity cache must
      // not erase a completed worker turn from the Manager's view.
      console.error(`[WorkerHarness] failed to read activity cursor for completed turn ${handle.worker_id}#${handle.seq}:`, error)
    }
    const turn = await this.turnStore.create({
      worker_id: handle.worker_id,
      manager_key: managerKey,
      incarnation_id: handle.incarnation_id,
      impl: handle.impl,
      seq: handle.seq,
      session_ref: handle.session_ref,
      activity_from: prior?.activity_through ?? '0',
      activity_through: activityThrough,
      completed_at: completedAt,
      completion_source: report.completionSource,
    })
    try {
      await this.persistTurnNotification(turn)
      void this.deliverNativeActivityNotifications(turn.worker_id)
    } catch (error) {
      // processStateChange emits a durable state_changed event carrying turn_id below. Keep that
      // path live even when the supplementary turn_completed notification cannot be recorded.
      console.error(`[WorkerHarness] failed to persist completed-turn notification ${turn.turn_id}:`, error)
    }
    return turn
  }

  private async collectNativeActivity(h: IncarnationHandle): Promise<void> {
    await this.withLock(h.worker_id, async () => {
      const found = await this.deps.ledger.findWorker(h.worker_id)
      const incarnation = found && findIncarnation(found.worker, h.impl, h.seq)
      if (!found || !incarnation || !isExecutableIncarnation(incarnation)) return
      await this.collectNativeActivityLocked({
        ...h,
        incarnation_id: incarnation.incarnation_id,
        session_ref: h.session_ref || incarnation.session_ref,
      }, found.managerKey)
    })
  }

  private async collectNativeActivityLocked(h: IncarnationHandle, managerKey: ManagerKey): Promise<void> {
    if (!h.incarnation_id) return
    const adapter = this.deps.adapters.get(h.impl)
    if (!adapter?.readTrace) return
    const offset = await this.nativeActivityStore.cursor(h.worker_id, h.incarnation_id)
    const trace = await adapter.readTrace(h, { offset })
    if (trace.nextCursor.offset < offset) {
      throw new Error(`native trace cursor moved backwards for ${h.worker_id}#${h.seq}`)
    }
    const assistant = projectWorkerActivity(trace.events, 'assistant', {
      worker_id: h.worker_id,
      incarnation_id: h.incarnation_id,
    })
    const notification = assistant.length === 0
      ? undefined
      : {
          worker_id: h.worker_id,
          manager_key: managerKey,
          incarnation_id: h.incarnation_id,
          impl: h.impl,
          seq: h.seq,
          activity_from: String(offset),
          activity_through: String(trace.nextCursor.offset),
          preview: truncateWakeText(assistant.map((event) => event.summary).join('\n'), 240, '', 'head') ?? 'assistant activity',
          event: this.buildEvent(h.worker_id, h.seq, 'activity_available', {
            incarnation_id: h.incarnation_id,
            from_cursor: String(offset),
            through_cursor: String(trace.nextCursor.offset),
            preview: truncateWakeText(assistant.map((event) => event.summary).join('\n'), 240, '', 'head') ?? 'assistant activity',
          }),
        }
    await this.nativeActivityStore.commitObservation({
      worker_id: h.worker_id,
      cursor: { incarnation_id: h.incarnation_id, impl: h.impl, seq: h.seq, offset: trace.nextCursor.offset },
      activity: trace.events,
      ...(notification ? { notification } : {}),
    })
  }

  private async persistTurnNotification(turn: WorkerTurn): Promise<void> {
    const event = this.buildEvent(turn.worker_id, turn.seq, 'turn_completed', {
      turn_id: turn.turn_id,
      incarnation_id: turn.incarnation_id,
      activity_from: turn.activity_from,
      activity_through: turn.activity_through,
      completion_source: turn.completion_source,
      turn_pending: true,
    })
    await this.nativeActivityStore.record({
      worker_id: turn.worker_id,
      manager_key: turn.manager_key,
      incarnation_id: turn.incarnation_id,
      impl: turn.impl,
      seq: turn.seq,
      activity_from: turn.activity_from,
      activity_through: turn.activity_through,
      preview: 'worker turn completed',
      event,
    })
  }

  private async deliverNativeActivityNotifications(workerId: string): Promise<void> {
    const notify = this.deps.onOperationNotification
    if (!notify) return
    const mutex = this.nativeActivityNotificationMutexes.get(workerId) ?? new AsyncMutex()
    this.nativeActivityNotificationMutexes.set(workerId, mutex)
    await mutex.run(async () => {
      for (const notification of await this.nativeActivityStore.pending(workerId)) {
        try {
          if (!notification.event_written) {
            await this.getEventLog(workerId).append(notification.event)
            await this.nativeActivityStore.markEventWritten(workerId, notification.notification_id)
          }
          const delivery = await notify(notification.manager_key, notification.event)
          if (delivery?.consumed) {
            await this.nativeActivityStore.markConsumed(workerId, notification.notification_id, this.deps.now())
          }
        } catch (error) {
          console.error(`[WorkerHarness] native activity notification failed for ${notification.notification_id}:`, error)
        }
      }
    })
  }

  async setWorkerPeriodicReport(
    workerId: string,
    reportTo: LedgerWorker['report_to'],
    intervalMs: number,
    expiresAt?: string,
  ): Promise<WorkerSupervision> {
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) throw new Error('interval_minutes 必须是正整数')
    const now = this.deps.now()
    if (expiresAt !== undefined) {
      const expiresAtMs = Date.parse(expiresAt)
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.parse(now)) {
        throw new Error('expires_at 必须是晚于当前时间的有效绝对时间')
      }
    }
    return this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) throw new WorkerNotFoundError(workerId)
      if (isTerminalStatus(found.worker.task.status)) throw new Error(`worker ${workerId} 已结束，不能设置定期汇报`)
      const supervision: WorkerSupervision = {
        version: 1,
        mode: 'periodic_report',
        next_due_at: plusMs(now, intervalMs),
        periodic_report: {
          interval_ms: intervalMs,
          ...(expiresAt ? { expires_at: expiresAt } : {}),
          report_to: reportTo,
        },
      }
      const updated = await this.deps.ledger.upsertWorker(found.managerKey, workerId, (prev) => prev && ({
        ...prev,
        supervision,
        updated_at: now,
      }))
      if (!updated?.supervision) throw new Error(`worker ${workerId} 的定期汇报规则未能保存`)
      return updated.supervision
    })
  }

  async clearWorkerPeriodicReport(workerId: string): Promise<WorkerSupervision> {
    const now = this.deps.now()
    return this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) throw new WorkerNotFoundError(workerId)
      if (isTerminalStatus(found.worker.task.status)) throw new Error(`worker ${workerId} 已结束，不能清除定期汇报`)
      const mainline = mainlineIncarnation(found.worker)
      const running = found.worker.task.status === 'running' && mainline?.state === 'running'
      const supervision: WorkerSupervision = {
        version: 1,
        mode: 'default',
        ...(running ? { next_due_at: plusMs(now, SUPERVISION_DEFAULT_INTERVAL_MS) } : {}),
      }
      const updated = await this.deps.ledger.upsertWorker(found.managerKey, workerId, (prev) => prev && ({
        ...prev,
        supervision,
        updated_at: now,
      }))
      if (!updated?.supervision) throw new Error(`worker ${workerId} 的例行巡检规则未能保存`)
      return updated.supervision
    })
  }

  /** Stale queued supervision events must not wake a Manager or mutate a replacement rule. */
  async isSupervisionDueCurrent(event: HarnessEvent): Promise<boolean> {
    if (event.kind !== 'supervision_due') return false
    return this.withLock(event.worker_id, async () => {
      const found = await this.deps.ledger.findWorker(event.worker_id)
      const pending = found?.worker.supervision?.pending
      return pending !== undefined
        && pending.due_id === event.detail?.due_id
        && pending.kind === supervisionKindForMode(event.detail?.mode)
        && found?.worker.supervision?.mode === event.detail?.mode
    })
  }

  async listAllWorkers(): Promise<Array<{ managerKey: ManagerKey; worker: LedgerWorker }>> {
    return this.deps.ledger.listAllWorkers()
  }

  async listWorkers(managerKey: ManagerKey): Promise<LedgerWorker[]> {
    return this.deps.ledger.listWorkers(managerKey)
  }

  /**
   * P5 Task 4 additive:harness 亲历事件流全量读——protocol-agent-v3 §10.2 worker trace 的
   * **第一层**信息源(`events.jsonl`),供 §8.3 `get_worker_trace` 使用。事件流本来就只经
   * `getEventLog` 这一个入口访问(带实例缓存),对外只补一个只读出口,不让调用方自己按
   * `workersDir` 拼路径另建 `WorkerEventLog`——那会让"事件流文件在哪"出现第二处真相。
   */
  async readWorkerEvents(workerId: string): Promise<HarnessEvent[]> {
    return this.getEventLog(workerId).readAll()
  }

  /**
   * Trace projection may expose only the receipt's bounded preview, never the
   * original Manager input retained in the in-memory inbox item.
   */
  async getInputDeliveryPreviews(workerId: string): Promise<Map<string, string>> {
    return new Map(
      (await this.inputDeliveryStore.list(workerId)).map((receipt) => [receipt.delivery_id, receipt.text_preview]),
    )
  }

  /** Restart recovery is fail-closed: pending input is never replayed. */
  async reconcileInputDeliveriesOnStartup(): Promise<void> {
    for (const receipt of await this.inputDeliveryStore.listPendingDeliveries()) {
      this.inputDeliveryControllers.get(receipt.delivery_id)?.abort()
      this.inputDeliveryControllers.delete(receipt.delivery_id)
      await this.getInbox(receipt.worker_id).cancelDelivery(receipt.delivery_id)
      const failure: InputDeliveryFailure = {
        reason_code: 'confirmation_lost_after_restart',
        reason: 'Agent restarted before input acceptance could be confirmed',
        certainty: 'unknown',
      }
      await this.settlePendingInputFailure(receipt, failure)
    }
    await this.deliverInputOperationNotifications()
  }

  /** Restart recovery never re-runs a side query; every in-flight receipt becomes explicit unknown. */
  async reconcileQueryReceiptsOnStartup(): Promise<void> {
    for (const receipt of await this.queryReceiptStore.listInFlight()) {
      const found = await this.deps.ledger.findWorker(receipt.worker_id)
      const incarnation = found?.worker.incarnations.find((item) => item.query_id === receipt.query_id)

      if (incarnation?.state === 'exited' && incarnation.ended_reason === 'completed') {
        if (receipt.state === 'starting') {
          await this.queryReceiptStore.markRunning(
            receipt.worker_id,
            receipt.query_id,
            incarnation.seq,
            this.deps.now(),
          )
        }
        await this.queryReceiptStore.settleCompleted(
          receipt.worker_id,
          receipt.query_id,
          this.deps.now(),
        )
        await this.appendAuditEvent(receipt.worker_id, incarnation.seq, 'query_completed', {
          query_id: receipt.query_id,
          fork_seq: incarnation.seq,
        })
        continue
      }

      const executionWasEstablished = receipt.state === 'running' || incarnation !== undefined
      const executionEnded = incarnation?.state === 'exited'
      let failure: QueryFailure
      if (executionEnded) {
        failure = {
          reason_code: 'query_execution_failed',
          reason: incarnation.ended_reason
            ? `query fork exited with reason '${incarnation.ended_reason}'`
            : 'query fork exited without a completion reason',
          phase: 'execution',
          certainty: 'failed',
        }
      } else if (executionWasEstablished) {
        failure = {
          reason_code: 'query_execution_lost_after_restart',
          reason: 'Agent restarted before query execution completion could be confirmed',
          phase: 'execution',
          certainty: 'unknown',
        }
      } else {
        failure = {
          reason_code: 'fork_establishment_lost_after_restart',
          reason: 'Agent restarted before fork establishment could be confirmed',
          phase: 'establishment',
          certainty: 'unknown',
        }
      }
      await this.queryReceiptStore.settleFailed(
        receipt.worker_id,
        receipt.query_id,
        failure,
        this.deps.now(),
      )
      await this.appendAuditEvent(
        receipt.worker_id,
        incarnation?.seq ?? 0,
        'query_failed',
        {
          query_id: receipt.query_id,
          ...(incarnation ? { fork_seq: incarnation.seq } : {}),
          ...failure,
        },
      )
      if (incarnation && incarnation.state !== 'exited' && isExecutableIncarnation(incarnation)) {
        const adapter = this.deps.adapters.get(incarnation.impl)
        if (adapter) {
          try {
            await adapter.kill({
              worker_id: receipt.worker_id,
              seq: incarnation.seq,
              impl: incarnation.impl,
              session_ref: incarnation.session_ref,
              query_id: receipt.query_id,
            })
          } catch (error) {
            console.error(`[WorkerHarness] failed to stop recovered query ${receipt.query_id}:`, error)
          }
        }
      }
    }
    await this.deliverQueryOperationNotifications()
  }

  /** Rebuild native-session high-water marks and replay any unconsumed Manager wake obligations. */
  async reconcileNativeActivityOnStartup(): Promise<void> {
    const all = await this.deps.ledger.listAllWorkers()
    for (const { worker } of all) {
      for (const incarnation of worker.incarnations) {
        if (!isExecutableIncarnation(incarnation)) continue
        try {
          await this.collectNativeActivity({
            worker_id: worker.worker_id,
            incarnation_id: incarnation.incarnation_id,
            seq: incarnation.seq,
            impl: incarnation.impl,
            session_ref: incarnation.session_ref,
            ...(incarnation.query_id ? { query_id: incarnation.query_id } : {}),
          })
        } catch (error) {
          console.error(`[WorkerHarness] native activity reconciliation failed for ${worker.worker_id}#${incarnation.seq}:`, error)
        }
      }
      try {
        await this.deliverNativeActivityNotifications(worker.worker_id)
      } catch (error) {
        console.error(`[WorkerHarness] native activity notification reconciliation failed for ${worker.worker_id}:`, error)
      }
    }
  }

  /** A crash after operation admission cannot be retried blindly; reconcile rechecks active operations. */
  async reconcileControlOperationsOnStartup(): Promise<void> {
    for (const { worker } of await this.deps.ledger.listAllWorkers()) {
      try {
        for (const operation of await this.controlOperationStore.active(worker.worker_id)) {
          try {
            await this.verifyControlOperation(operation)
          } catch (error) {
            console.error(`[WorkerHarness] control operation reconciliation failed for ${operation.operation_id}:`, error)
          }
        }
      } catch (error) {
        console.error(`[WorkerHarness] control operation reconciliation failed for ${worker.worker_id}:`, error)
      }
      try {
        await this.deliverControlOperationNotifications(worker.worker_id)
      } catch (error) {
        console.error(`[WorkerHarness] control operation notification reconciliation failed for ${worker.worker_id}:`, error)
      }
    }
  }

  private async reconcileInputDeliveryOperations(): Promise<void> {
    const nowMs = Date.parse(this.deps.now())
    for (const receipt of await this.inputDeliveryStore.listPendingDeliveries()) {
      if (Date.parse(receipt.deadline_at) > nowMs) continue
      this.inputDeliveryControllers.get(receipt.delivery_id)?.abort()
      const cancellation = await this.getInbox(receipt.worker_id).cancelDelivery(receipt.delivery_id)
      const current = await this.inputDeliveryStore.get(receipt.worker_id, receipt.delivery_id)
      if (!current || current.state !== 'pending') continue

      const safelyWithdrawn = cancellation === 'cancelled'
      const failure: InputDeliveryFailure = safelyWithdrawn
        ? {
            reason_code: 'input_surface_timeout',
            reason: 'input did not reach a safe input surface before the 5 minute deadline',
            certainty: 'not_delivered',
          }
        : {
            reason_code: 'submission_unconfirmed_timeout',
            reason: 'input acceptance could not be confirmed before the 5 minute deadline',
            certainty: 'unknown',
          }
      this.inputDeliveryControllers.delete(receipt.delivery_id)
      await this.settlePendingInputFailure(current, failure)
    }
    await this.deliverInputOperationNotifications()
  }

  private async settlePendingInputFailure(
    receipt: WorkerInputDeliveryReceipt,
    failure: InputDeliveryFailure,
  ): Promise<void> {
    const settled = await this.inputDeliveryStore.settleFailed(
      receipt.worker_id,
      receipt.delivery_id,
      failure,
      this.deps.now(),
    )
    const found = await this.deps.ledger.findWorker(receipt.worker_id)
    const seq = found ? requireMainlineIncarnation(found.worker).seq : 0
    await this.appendAuditEvent(receipt.worker_id, seq, 'input_delivery_failed', {
      delivery_id: receipt.delivery_id,
      ...settled.failure,
    })
  }

  private async deliverInputOperationNotifications(): Promise<void> {
    if (!this.deps.onOperationNotification) return
    for (const receipt of await this.inputDeliveryStore.listPendingNotifications()) {
      const found = await this.deps.ledger.findWorker(receipt.worker_id)
      const seq = found ? requireMainlineIncarnation(found.worker).seq : 0
      const event = this.buildEvent(
        receipt.worker_id,
        seq,
        receipt.state === 'delivered' ? 'input_sent' : 'input_delivery_failed',
        {
          delivery_id: receipt.delivery_id,
          text_preview: receipt.text_preview,
          ...(receipt.failure ?? {}),
          text: renderInputDeliveryNotification(receipt),
        },
      )
      try {
        const delivery = await this.deps.onOperationNotification(receipt.manager_key, event)
        if (delivery?.consumed === true) {
          await this.inputDeliveryStore.markNotificationConsumed(
            receipt.worker_id,
            receipt.delivery_id,
            this.deps.now(),
          )
        }
      } catch (error) {
        console.error(
          `[WorkerHarness] input delivery notification failed for ${receipt.delivery_id}:`,
          error,
        )
      }
    }
  }

  private async deliverQueryOperationNotifications(): Promise<void> {
    if (!this.deps.onOperationNotification) return
    for (const receipt of await this.queryReceiptStore.listPendingNotifications()) {
      const event = this.buildEvent(
        receipt.worker_id,
        receipt.fork_seq ?? 0,
        receipt.state === 'completed' ? 'query_completed' : 'query_failed',
        {
          query_id: receipt.query_id,
          ...(receipt.fork_seq === undefined ? {} : { fork_seq: receipt.fork_seq }),
          question_preview: receipt.question_preview,
          ...(receipt.failure ?? {}),
          text: renderQueryNotification(receipt),
        },
      )
      try {
        const delivery = await this.deps.onOperationNotification(receipt.manager_key, event)
        if (delivery?.consumed === true) {
          await this.queryReceiptStore.markNotificationConsumed(
            receipt.worker_id,
            receipt.query_id,
            this.deps.now(),
          )
        }
      } catch (error) {
        console.error(`[WorkerHarness] query notification failed for ${receipt.query_id}:`, error)
      }
    }
  }

  /** A transient settlement write must not leave a synchronous query receipt starting forever. */
  private async reconcileQueryEstablishmentOperations(): Promise<void> {
    const nowMs = Date.parse(this.deps.now())
    for (const receipt of await this.queryReceiptStore.listInFlight()) {
      if (receipt.state !== 'starting' || Date.parse(receipt.establishment_deadline_at) > nowMs) continue
      const failure: QueryFailure = {
        reason_code: 'fork_establishment_timeout',
        reason: 'fork establishment could not be committed before the 30 second deadline',
        phase: 'establishment',
        certainty: 'unknown',
      }
      try {
        await this.queryReceiptStore.settleFailed(
          receipt.worker_id,
          receipt.query_id,
          failure,
          this.deps.now(),
        )
      } catch (error) {
        const current = await this.queryReceiptStore.get(receipt.worker_id, receipt.query_id)
        if (current?.state === 'completed' || current?.state === 'failed') continue
        throw error
      }
      const found = await this.deps.ledger.findWorker(receipt.worker_id)
      const incarnation = found?.worker.incarnations.find((item) => item.query_id === receipt.query_id)
      await this.appendAuditEvent(receipt.worker_id, incarnation?.seq ?? 0, 'query_failed', {
        query_id: receipt.query_id,
        ...(incarnation ? { fork_seq: incarnation.seq } : {}),
        ...failure,
      })
      if (incarnation && incarnation.state !== 'exited' && isExecutableIncarnation(incarnation)) {
        const adapter = this.deps.adapters.get(incarnation.impl)
        if (adapter) {
          try {
            await adapter.kill({
              worker_id: receipt.worker_id,
              seq: incarnation.seq,
              impl: incarnation.impl,
              session_ref: incarnation.session_ref,
              query_id: receipt.query_id,
            })
          } catch (error) {
            console.error(`[WorkerHarness] failed to stop expired query ${receipt.query_id}:`, error)
          }
        }
      }
    }
  }

  /**
   * 崩溃恢复对账(protocol-agent-v3 §12,替代 admin 的一刀切自愈)。agent 进程重启后调用
   * 一次:巡检台账里所有非终态 worker 的主线化身,凭 adapter.state() 判定它到底是"进程
   * 没了、化身也没了"(判死)还是"化身独立于 agent 进程,可能还活着"(如 tmux worker),
   * 而不是像旧 admin 那样把所有非终态任务一律判死。
   *
   * 与 BuiltinWorkerAdapter.scanOrphans(P1)的关系——互补而非替代:scanOrphans 是
   * builtin 自己的 adapter 内部动作,修的是它自己 dataDir 下 meta-<seq>.json 这份"进程内
   * 存活状态由本进程独占计算"的私有真相(builtin 的执行就是本进程内的 runEngine burst,
   * 进程重启即等价于 burst 消失,重启前仍是 running 的 meta 就是孤儿,必须先纠正);本方法
   * 修的是台账(跨三种 impl 的公共真相源)。两者都要跑,顺序上 scanOrphans 必须先于本方法:
   * 本方法调用 adapter.state() 时,builtin 的 state() 在无常驻内存 instance 时直接回落读
   * meta-<seq>.json(见 BuiltinWorkerAdapter.state 实现),若 scanOrphans 没有先跑,孤儿
   * meta 仍标着 'running',本方法会把它误判进"revived"分支。scanOrphans 的调用时机是
   * "本进程任何 adapter 实例开始活动前"(其自身文档要求),比 harness 构造还早——harness
   * 拿不到、也不该拿到某个具体 adapter(如 builtin)的私有 dataDir(HarnessDeps 只有
   * workersDir,是 harness 自己的 events/output 目录,与各 adapter 的私有 dataDir 是两个
   * 目录),因此不在本方法内部调用 scanOrphans,调用顺序由 P4/bootstrap 层保证(先
   * `BuiltinWorkerAdapter.scanOrphans(dataDir)`,adapter 塞进 `adapters` Map 之后,再调
   * `harness.reconcileOnStartup()`)。claude-code/codex 不需要等价的孤儿扫描——它们的
   * `state()`(经 ensureRuntime,四轮 review 收拢)在无常驻 runtime 时会先做一次真实 tmux
   * isAlive 探测再重建,不像 builtin 那样单纯回落读可能过期的 meta 文件。
   *
   * 判定规则(逐 worker 独立判定,整轮不持有任何全局锁——只在每个 worker 自己的
   * per-worker 临界区内完成"读台账→判adapter.state()→提交"):
   * - 台账已是终态:跳过,归 unchanged(幂等:重复调用不会把上一轮已经判死的 worker 再判一次)。
   * - 主线化身的 impl 没有对应 adapter 注册(实现被禁用/未安装):判死。
   * - `adapter.state(handle)` 抛错:视为不可判定,判死;错误信息记进事件 detail,不让
   *   这次异常中断整轮对账(逐 worker try/catch,配合 Promise.allSettled 兜底任何未预料
   *   到的同步/异步异常,一个 worker 出问题不影响其它 worker 被处理)。
   * - 返回 `exited`:台账仍非终态却已经不在跑了,判死,ended_reason='crashed'。
   * - 返回 `running`/`idle`:台账保持(不判死)——tmux worker 独立于 agent 进程,重启后
   *   往往仍活着;按这次实际观察到的 contractState 用 taskStatusFromIncarnation 把
   *   task.status 对齐到真实值(可能一步都不用走,也可能需要更新化身的 state 字段),
   *   发 state_changed 事件(detail.source='reconcile',与被动回调路径区分)通知 P4 manager
   *   接管这个 worker 的后续监护;归 revived。
   */
  async reconcileOnStartup(): Promise<ReconcileReport> {
    const revived: string[] = []
    const failed: string[] = []
    const unchanged: string[] = []

    const all = await this.deps.ledger.listAllWorkers()
    const targets = all.filter(({ worker }) => !isTerminalStatus(worker.task.status))
    // 报告的 unchanged 桶按 brief 定义包含"终态"(不只是"无需动作但仍被判定过的非终态
    // worker")——已终态的 worker 在这里直接归档,不进 Promise.allSettled 那批,不占用
    // per-worker 锁、不调用 adapter.state()(即使重复调用 reconcileOnStartup,已判死过的
    // worker 从第二次起也是在这一步就被截住,不会再走到 reconcileOneWorker)。
    unchanged.push(...all.filter(({ worker }) => isTerminalStatus(worker.task.status)).map(({ worker }) => worker.worker_id))

    const settled: Array<PromiseSettledResult<'revived' | 'failed' | 'unchanged'>> = []
    for (let start = 0; start < targets.length; start += WORKER_SWEEP_CONCURRENCY) {
      const batch = targets.slice(start, start + WORKER_SWEEP_CONCURRENCY)
      settled.push(...await Promise.allSettled(
        batch.map(({ managerKey, worker }) => this.reconcileOneWorker(managerKey, worker.worker_id)),
      ))
    }

    settled.forEach((result, i) => {
      const workerId = targets[i].worker.worker_id
      if (result.status === 'fulfilled') {
        ;(result.value === 'revived' ? revived : result.value === 'failed' ? failed : unchanged).push(workerId)
      } else {
        // reconcileOneWorker 内部已经把 adapter.state() 的异常兜底成 'failed' 分类并落盘,
        // 这里兜的是更意外的情形(如 ledger 写盘失败)——记日志,报告里仍归 failed,不让
        // 一个 worker 的意外异常掐断整轮 Promise.allSettled 之外的收尾逻辑。
        console.error(`[WorkerHarness] reconcileOnStartup: unexpected error reconciling ${workerId}:`, result.reason)
        failed.push(workerId)
      }
    })

    return { revived, failed, unchanged }
  }

  /**
   * 启动 / 停止周期性的活性巡检(protocol-agent-v3 §6.3 第 3 条的兜底)。
   *
   * 装配层(`unified-agent.ts`)在启动对账之后开、停机时关。`unref()`:巡检是后台兜底,
   * 不该成为让进程赖着不退的理由。
   *
   * **`stop` 之后拒绝再 `start`**(PR #75 review):装配层是在启动对账的 `.finally` 里开的,
   * 而那条链**不被 await**、台账非空时耗时不可控。若 `onStop` 赶在对账仍在途时执行,
   * `stopLivenessSweep()` 会先跑(此时 timer 还没建,是个 no-op),随后对账收尾的 `.finally`
   * 又把 timer 建起来——巡检在模块已经停止之后被启动。timer 已 `unref()`,但只要进程还活着,
   * 就存在"停机后仍向 manager 发起唤醒(即 LLM 调用)"的窗口。一个标志位堵死它。
   * 停机是终态,没有"停完再开"的合法场景,所以标志不提供复位。
   */
  startLivenessSweep(intervalMs: number = LIVENESS_SWEEP_INTERVAL_MS): void {
    if (this.sweepStopped || this.sweepTimer) return
    this.sweepTimer = setInterval(() => {
      void this.sweepLiveness().catch((err) => {
        console.error('[WorkerHarness] sweepLiveness failed:', err)
      })
    }, intervalMs)
    this.sweepTimer.unref?.()
  }

  stopLivenessSweep(): void {
    this.sweepStopped = true
    if (!this.sweepTimer) return
    clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }

  /**
   * 一轮活性巡检:找出"进程还活着、台账还写着 running、却已经很久不产生任何输出"的化身,
   * 唤醒它的监护 manager 并附上现场(protocol-agent-v3 §6.3 第 3 条,
   * spec `2026-08-05-worker-liveness-sweep-design.md`)。
   *
   * 之所以需要这一层:三种 adapter 的 `state()` 返回 `running` 都是 else 兜底,不是正证 ——
   * 它在语义上区分不了"在干活"与"卡住了";`isAlive`、台账 `updated_at` 同样零区分力。
   * 唯一有区分力的信号是**任务/执行进展**,由可选契约方法 `lastActivityAt` 提供;
   * pane output 只用于首次告警时给 manager 看现场。
   *
   * 四条纪律:
   *
   * 1. **不写台账、不改化身状态,只发一条唤醒事件**。harness 单方面把台账写成 idle,下一次
   *    `syncState` 会把它翻回 running(adapter 才是化身状态的权威)——那是 #70 review 抓到的
   *    "idle 不粘"。而且判断语义(干完了 / 等输入 / 卡住)与决策的责任完全在 manager 侧(§4.3),
   *    巡检只负责让 manager 知道;
   * 2. **不做实现特判**。不实现 `lastActivityAt` 的 adapter 天然被跳过;三种内置实现
   *    都已提供信号,未来实现若无法建立可靠进展基线才可选择不实现。
   * 3. **只看主线化身**(`forked_from` 为空,与 §5.3 判定主线化身的规则同源)。cc 的 fork
   *    是无头 `claude -p` 侧问,整个执行期可能零输出,拿它当停摆就是纯误报;
   * 4. **同一次停摆只发一份首报**,之后的重试是**带退避的、不重复首报**。展开说:
   *    - 成功被消费 ⇒ 不再打扰;`lastActivityAt` 前进 ⇒ 清标记,下次停摆算新的一次;
   *    - 上一次唤醒没被 manager 消费(episode 失败,`consumedEvents !== true`)⇒ 允许重试。
   *      **重试是必须的**:episode 失败时 `ManagerLoop` 把正文整体推回 mailbox,而 mailbox
   *      只是**被动缓冲**——全仓没有任何周期性投递者(`maybeSelfWake` 只在成功后自唤醒,
   *      `evictIdle` 是回收器且无调用方),停摆 worker 按定义又不再产生事件、带不来下一次
   *      唤醒。**重试的价值不在于再送一份正文,而在于它本身就是那个 drain 触发器。**
   *    - 因此重试**不重复首报**(见 `describeLivenessRetry`):首报已在 mailbox 里,再送只会
   *      让它堆叠;并且**按 `retryDelayMs` 退避**(1×T → 2×T → 4×T 封顶),避免把
   *      `maybeSelfWake` 明确拒绝过的"失败→立刻重试"热循环换个地方重演。
   *    这三条都是 PR #75 review 的修正,推翻过程见 spec 决策 4。
   *
   * 重入保护:一次唤醒是一整个 manager episode(可能几分钟),定时器到点时上一轮可能还没走完,
   * 直接跳过这一轮——已报标记会让下一轮不重复唤醒同一个化身。
   */
  async sweepLiveness(): Promise<void> {
    if (this.sweepInFlight) return
    this.sweepInFlight = true
    try {
      await this.reconcileInputDeliveryOperations()
      await this.reconcileQueryEstablishmentOperations()
      await this.deliverQueryOperationNotifications()
      await this.reconcileControlOperationsOnStartup()
      for (const { worker } of await this.deps.ledger.listAllWorkers()) {
        await this.deliverNativeActivityNotifications(worker.worker_id)
      }
      await this.sweepSupervision()
      const nowMs = Date.parse(this.deps.now())
      const all = await this.deps.ledger.listAllWorkers()
      const reports: Array<Promise<void>> = []
      const liveKeys = new Set<string>()

      for (const { worker } of all) {
        if (isTerminalStatus(worker.task.status)) continue
        const mainline = mainlineIncarnation(worker)
        // `!mainline` 不是纯防御:#72 的 memory_maintenance system task 是**没有任何化身**的
        // 台账条目(`incarnations: []`,由 agent 自己跑,不派 worker),它在 running 期间同样
        // 会被 listAllWorkers 枚举到。没有化身就没有可探的活性,直接跳过。
        if (!mainline || !isExecutableIncarnation(mainline) || mainline.state !== 'running') continue
        const impl = mainline.impl
        const adapter = this.deps.adapters.get(impl)
        // 不实现 `lastActivityAt` 的实现不参与活性巡检(协议 §6.1),这里是它的**唯一**落点。
        if (!adapter?.lastActivityAt) continue

        const key = `${worker.worker_id}#${impl}#${mainline.seq}`
        liveKeys.add(key)
        const h = handleForIncarnation(worker.worker_id, mainline)

        let lastAt: number | undefined
        try {
          lastAt = await adapter.lastActivityAt(h)
        } catch (err) {
          // 探活本身失败(文件系统抖动等)只是这一轮判不了,不该被当成"停摆"上报,更不该
          // 掐断整轮巡检——下一轮再看。
          console.warn(`[WorkerHarness] sweepLiveness: lastActivityAt failed for ${key}:`, err)
          continue
        }
        // 判不了(实现说它无法判定)= 不参与本轮,与"刚动过"不是一回事,不清标记。
        if (lastAt === undefined) continue

        const staleMs = nowMs - lastAt
        if (staleMs <= LIVENESS_STALL_MS) {
          this.stallReports.delete(key) // 又动起来了:清标记,下次再停摆算新的一次
          continue
        }

        // 去重、重试与退避,见方法注释第 4 条。`activityAt` 变了就是新的一次停摆,走首报。
        const prev = this.stallReports.get(key)
        const sameStall = prev !== undefined && prev.activityAt === lastAt
        if (sameStall) {
          // `pending`:那次 episode 还在跑,别插队;`consumed`:manager 已经知道了,不再打扰。
          if (prev.delivery !== 'failed') continue
          // 上次没投递成功 → 可以重试,但要等退避窗口(见 retryDelayMs)。
          if (nowMs < prev.retryAfterMs) continue
        }
        const attempts = sameStall ? prev.attempts : 0
        this.stallReports.set(key, { activityAt: lastAt, delivery: 'pending', attempts, retryAfterMs: 0 })
        reports.push(this.reportLivenessStall(h, key, lastAt, staleMs, attempts, nowMs))
      }

      // 已经不在候选集里的化身(终态 / 已换主线 / 换了实现)不再需要标记,顺手回收。
      for (const key of this.stallReports.keys()) {
        if (!liveKeys.has(key)) this.stallReports.delete(key)
      }

      await Promise.allSettled(reports)
    } finally {
      this.sweepInFlight = false
    }
  }

  /** Startup recovery reuses the normal sweep: overdue windows coalesce into one pending due. */
  async reconcileSupervisionOnStartup(): Promise<void> {
    await this.sweepSupervision()
  }

  private async sweepSupervision(): Promise<void> {
    if (this.deps.isClosing?.()) return
    const now = this.deps.now()
    const candidates = (await this.deps.ledger.listAllWorkers()).filter(({ worker }) => {
      if (isTerminalStatus(worker.task.status)) return false
      const mainline = mainlineIncarnation(worker)
      return mainline !== undefined && isExecutableIncarnation(mainline)
    })
    const prepared: Array<PreparedSupervisionDue | undefined> = []
    for (let start = 0; start < candidates.length; start += WORKER_SWEEP_CONCURRENCY) {
      const batch = candidates.slice(start, start + WORKER_SWEEP_CONCURRENCY)
      prepared.push(...await Promise.all(
        batch.map(({ worker }) => this.prepareSupervisionDue(worker.worker_id, now)),
      ))
    }
    for (const item of prepared) {
      if (item?.stateToSync) {
        await this.processStateChange(item.handle, item.stateToSync)
      }
    }
    if (this.deps.isClosing?.()) return
    const events = prepared.flatMap((item) => item?.event ? [item.event] : [])
    for (let start = 0; start < events.length; start += WORKER_SWEEP_CONCURRENCY) {
      await Promise.allSettled(
        events.slice(start, start + WORKER_SWEEP_CONCURRENCY)
          .map((event) => this.deliverSupervisionDue(event)),
      )
    }
  }

  private async prepareSupervisionDue(
    workerId: string,
    now: string,
  ): Promise<PreparedSupervisionDue | undefined> {
    return this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found || isTerminalStatus(found.worker.task.status)) return undefined
      const worker = found.worker
      const mainline = mainlineIncarnation(worker)
      if (!mainline || !isExecutableIncarnation(mainline)) return undefined
      const handle = handleForIncarnation(worker.worker_id, mainline)
      const adapter = this.deps.adapters.get(mainline.impl)
      let supervision = worker.supervision
      if (!supervision) {
        if (worker.task.status !== 'running' || mainline.state !== 'running') return undefined
        supervision = { version: 1, mode: 'default', next_due_at: plusMs(now, SUPERVISION_DEFAULT_INTERVAL_MS) }
        await this.updateSupervision(found.managerKey, workerId, supervision, now)
        return undefined
      }

      if (supervision.mode === 'default' && (worker.task.status !== 'running' || mainline.state !== 'running')) {
        if (supervision.next_due_at || supervision.pending) {
          await this.updateSupervision(found.managerKey, workerId, { version: 1, mode: 'default' }, now)
        }
        return undefined
      }
      if (supervision.mode === 'periodic_report' && supervision.periodic_report?.expires_at && Date.parse(supervision.periodic_report.expires_at) <= Date.parse(now)) {
        const defaultRule: WorkerSupervision = {
          version: 1,
          mode: 'default',
          ...(worker.task.status === 'running' && mainline.state === 'running'
            ? { next_due_at: plusMs(now, SUPERVISION_DEFAULT_INTERVAL_MS) }
            : {}),
        }
        await this.updateSupervision(found.managerKey, workerId, defaultRule, now)
        return undefined
      }

      if (supervision.pending) {
        if (supervision.pending.retry_after_at && Date.parse(supervision.pending.retry_after_at) > Date.parse(now)) return undefined
        return {
          handle,
          event: this.buildSupervisionEvent(worker, handle, supervision, supervision.pending.due_id, 'unknown'),
        }
      }
      if (!supervision.next_due_at || Date.parse(supervision.next_due_at) > Date.parse(now)) return undefined

      let observation: 'text' | 'tool_only' | 'none' | 'unknown' = 'unknown'
      let cursor = supervision.observation?.mainline_seq === mainline.seq ? supervision.observation.cursor : undefined
      try {
        if (adapter) {
          const result = await adapter.inspectSupervisionActivity(handle, cursor)
          observation = result.kind
          cursor = result.next_cursor
        }
      } catch {
        observation = 'unknown'
      }

      const observed = {
        ...supervision,
        observation: cursor ? { mainline_seq: mainline.seq, cursor } : undefined,
        last_observed_at: now,
      }
      if (observed.mode === 'default' && observation === 'tool_only') {
        await this.updateSupervision(found.managerKey, workerId, {
          ...observed,
          next_due_at: plusMs(now, SUPERVISION_DEFAULT_INTERVAL_MS),
        }, now)
        return undefined
      }

      let probe: SupervisionProbe | undefined
      if (observation === 'none' || observation === 'unknown') {
        try {
          probe = adapter ? await adapter.state(handle) : 'failed'
        } catch {
          probe = 'failed'
        }
        if (probe === 'exited' || (observed.mode === 'default' && probe === 'idle')) {
          await this.updateSupervision(found.managerKey, workerId, observed, now)
          return { handle, stateToSync: probe }
        }
      }

      const pending = {
        due_id: randomUUID(),
        kind: observed.mode === 'periodic_report' ? 'periodic_report' as const : 'default_review' as const,
        due_at: now,
        attempts: 0,
      }
      const dueRule: WorkerSupervision = { ...observed, pending }
      await this.updateSupervision(found.managerKey, workerId, dueRule, now)
      return {
        handle,
        ...(observed.mode === 'periodic_report' && probe === 'idle' && worker.task.status === 'running'
          ? { stateToSync: 'idle' as const }
          : {}),
        event: this.buildSupervisionEvent(worker, handle, dueRule, pending.due_id, observation, probe),
      }
    })
  }

  private async deliverSupervisionDue(event: HarnessEvent): Promise<void> {
    let delivery: HarnessEventDelivery | undefined
    try {
      delivery = await this.appendPreparedEventAwaitingDelivery(event)
    } catch (error) {
      console.error(`[WorkerHarness] supervision delivery failed for ${event.worker_id}:`, error)
    }
    await this.withLock(event.worker_id, async () => {
      const found = await this.deps.ledger.findWorker(event.worker_id)
      const current = found?.worker.supervision
      const pending = current?.pending
      if (!found || !current || !pending || pending.due_id !== event.detail?.due_id || pending.kind !== supervisionKindForMode(event.detail?.mode) || current.mode !== event.detail?.mode) return
      const now = this.deps.now()
      if (delivery?.consumed) {
        const interval = current.mode === 'periodic_report'
          ? current.periodic_report?.interval_ms
          : SUPERVISION_DEFAULT_INTERVAL_MS
        if (!interval) return
        await this.updateSupervision(found.managerKey, event.worker_id, {
          ...current,
          pending: undefined,
          next_due_at: plusMs(now, interval),
          last_effective_review_at: now,
        }, now)
        return
      }
      const attempts = pending.attempts + 1
      await this.updateSupervision(found.managerKey, event.worker_id, {
        ...current,
        pending: {
          ...pending,
          attempts,
          retry_after_at: plusMs(now, SUPERVISION_RETRY_INTERVAL_MS * Math.min(2 ** (attempts - 1), 4)),
        },
      }, now)
    })
  }

  private buildSupervisionEvent(
    worker: LedgerWorker,
    handle: IncarnationHandle,
    supervision: WorkerSupervision,
    dueId: string,
    observation: 'text' | 'tool_only' | 'none' | 'unknown',
    probe?: SupervisionProbe,
  ): HarnessEvent {
    return this.buildEvent(worker.worker_id, handle.seq, 'supervision_due', {
      mode: supervision.mode,
      due_id: dueId,
      mainline_incarnation_id: handle.incarnation_id,
      mainline_seq: handle.seq,
      observation,
      ...(probe ? { probe } : {}),
      ...(supervision.mode === 'periodic_report' && supervision.periodic_report
        ? { report_to: supervision.periodic_report.report_to }
        : {}),
    })
  }

  private async updateSupervision(
    managerKey: ManagerKey,
    workerId: string,
    supervision: WorkerSupervision,
    now: string,
  ): Promise<void> {
    await this.deps.ledger.upsertWorker(managerKey, workerId, (worker) => worker && ({
      ...worker,
      supervision,
      updated_at: now,
    }))
  }

  /**
   * 上报一次停摆,走 `state_changed` + `detail.text` 这条既有的唤醒形状,并按投递结局更新
   * 已报标记(含退避)。
   *
   * **首报带停摆事实、重试不重复**(`attempts`):Harness 不主动读取终端；Manager 若需要
   * 诊断画面，显式调用 `get_worker_terminal`。重试只是**再触发一次投递**。
   *
   * `to` 取化身**当前**的状态 `'running'`:这条事件描述的不是一次状态迁移(巡检不改状态),
   * 而是"这个还在 running 的化身有情况"。不带 `taskStatus` 形参——没有伴随的 task 迁移,
   * 对外事件桥因此在"状态没变"那一步自然被去重掉(见 manager/events.ts)。
   *
   * 活性信号是 `lastActivityAt`，每轮只读取原生会话或控制元数据，不读取 TUI pane。
   */
  private async reportLivenessStall(
    h: IncarnationHandle,
    key: string,
    activityAt: number,
    staleMs: number,
    attempts: number,
    nowMs: number,
  ): Promise<void> {
    let text: string | undefined
    if (attempts === 0) {
      text = describeLivenessStall({ impl: h.impl, staleMs })
    } else {
      text = describeLivenessRetry({ impl: h.impl, staleMs })
    }
    let delivery: HarnessEventDelivery | undefined
    try {
      delivery = await this.appendEventAwaitingDelivery(h.worker_id, h.seq, 'state_changed', {
        to: 'running' satisfies WorkerContractState,
        ...(text ? { text } : {}),
      })
    } catch (err) {
      console.error(`[WorkerHarness] sweepLiveness: 上报停摆失败 ${key}:`, err)
    }
    const mark = this.stallReports.get(key)
    // 期间可能已经被别的路径清掉(worker 落终态/又动起来了),那就别把它写回来。
    if (mark && mark.activityAt !== activityAt) return
    if (!mark) return
    if (delivery?.consumed === true) {
      mark.delivery = 'consumed'
      return
    }
    mark.delivery = 'failed'
    mark.attempts = attempts + 1
    mark.retryAfterMs = nowMs + retryDelayMs(mark.attempts)
  }

  /** reconcileOnStartup 单个 worker 的判定+提交,整体在该 worker 的 per-worker 锁临界区内完成。 */
  private async reconcileOneWorker(
    managerKey: ManagerKey,
    workerId: string
  ): Promise<'revived' | 'failed' | 'unchanged'> {
    return this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) return 'unchanged' // 理论不该发生(枚举时刚读到过),防御性处理
      const { worker } = found
      // 幂等短路:进锁后重读仍可能已是终态(上一轮已判死,或本轮内已被并发触发的其它
      // harness 动作收尾)——不重复判定。
      if (isTerminalStatus(worker.task.status)) return 'unchanged'

      const mainline = mainlineIncarnation(worker)
      if (!mainline) {
        await this.markAgentNativeSystemTaskLost(managerKey, worker)
        return 'failed'
      }
      if (isLegacyIncarnation(mainline)) {
        // Imported legacy records are terminal; a malformed non-terminal one must not probe a
        // nonexistent adapter or mutate the historical record during startup reconciliation.
        return 'unchanged'
      }

      const adapter = this.deps.adapters.get(mainline.impl)
      if (!adapter) {
        await this.markCrashed(managerKey, worker, mainline, `no adapter registered for impl '${mainline.impl}'`)
        return 'failed'
      }

      const handle = handleForIncarnation(worker.worker_id, mainline)

      let observed: WorkerContractState
      try {
        observed = await adapter.state(handle)
      } catch (err) {
        await this.markCrashed(
          managerKey,
          worker,
          mainline,
          `adapter.state() threw: ${err instanceof Error ? err.message : String(err)}`
        )
        return 'failed'
      }

      if (observed === 'exited') {
        await this.markCrashed(managerKey, worker, mainline, 'adapter reports incarnation exited while ledger was non-terminal')
        return 'failed'
      }

      await this.realignAliveIncarnation(managerKey, worker, mainline, observed)
      return 'revived'
    })
  }

  private async markAgentNativeSystemTaskLost(
    managerKey: ManagerKey,
    worker: LedgerWorker,
  ): Promise<void> {
    const now = this.deps.now()
    const message = 'agent restart: execution context lost for agent-native system task'
    const failed = await this.deps.ledger.upsertWorker(managerKey, worker.worker_id, (prev) => {
      if (!prev) return undefined
      const nextTask = transitionTaskTo(prev.task, 'failed', { error: message, now })
      const supervision = supervisionAfterMainlineTransition(prev.supervision, nextTask.status, 'exited', 0, now)
      return { ...prev, task: nextTask, ...(supervision ? { supervision } : {}), updated_at: now }
    })
    await this.appendEvent(
      worker.worker_id,
      0,
      'exited',
      { reason: 'crashed', message },
      failed?.task.status,
    )
  }

  /**
   * reconcileOnStartup 判死分支:落 failed(ended_reason='crashed')+ exited 事件。三种判死
   * 场景(adapter 报 exited / adapter 未注册 / adapter.state() 抛错)共用同一段收尾——三者
   * 语义上都是"至此已经没有任何证据证明这个非终态 worker 还活着"。
   */
  private async markCrashed(
    managerKey: ManagerKey,
    worker: LedgerWorker,
    mainline: ExecutableIncarnation,
    detailReason: string
  ): Promise<void> {
    const now = this.deps.now()
    const crashed = await this.deps.ledger.upsertWorker(managerKey, worker.worker_id, (prev) => {
      if (!prev) return undefined
      const nextTask = transitionTaskTo(prev.task, 'failed', { error: detailReason, now })
      const incarnations = patchIncarnationBySeq(prev.incarnations, mainline.impl, mainline.seq, {
        state: 'exited',
        ended_at: now,
        ended_reason: 'crashed',
      })
      const supervision = supervisionAfterMainlineTransition(
        prev.supervision,
        nextTask.status,
        'exited',
        mainline.seq,
        now,
      )
      return { ...prev, task: nextTask, incarnations, ...(supervision ? { supervision } : {}), updated_at: now }
    })
    await this.appendEvent(
      worker.worker_id,
      mainline.seq,
      'exited',
      { reason: 'crashed', message: detailReason },
      crashed?.task.status
    )
  }

  /**
   * reconcileOnStartup 存活分支:台账不判死,只按这次实际观察到的 contractState 对齐
   * incarnation.state 与 task.status(taskStatusFromIncarnation 同一套映射,与
   * processStateChange 的被动回调路径共用规则)。若观察结果与台账现状完全一致(既没有
   * 化身 state 差异也没有 task 状态差异),不做任何写入、不发事件——避免每次巡检都产生
   * 噪声写盘/事件。
   */
  private async realignAliveIncarnation(
    managerKey: ManagerKey,
    worker: LedgerWorker,
    mainline: ExecutableIncarnation,
    observed: WorkerContractState
  ): Promise<void> {
    const waitingInput = observed === 'idle' ? true : undefined
    const nextStatus =
      observed === 'idle' && (this.hasPendingBgNotification(worker.worker_id) || await this.deps.hasRunningBg?.(worker.worker_id))
        ? 'running'
        : taskStatusFromIncarnation(observed, undefined, waitingInput)
    const stateChanged = mainline.state !== observed
    const statusChanged = worker.task.status !== nextStatus
    if (!stateChanged && !statusChanged) return

    const now = this.deps.now()
    const realigned = await this.deps.ledger.upsertWorker(managerKey, worker.worker_id, (prev) => {
      if (!prev) return undefined
      const nextTask = statusChanged ? transitionTaskTo(prev.task, nextStatus, { now }) : prev.task
      const incarnations = stateChanged
        ? patchIncarnationBySeq(prev.incarnations, mainline.impl, mainline.seq, { state: observed })
        : prev.incarnations
      const supervision = supervisionAfterMainlineTransition(
        prev.supervision,
        nextTask.status,
        observed,
        mainline.seq,
        now,
      )
      return { ...prev, task: nextTask, incarnations, ...(supervision ? { supervision } : {}), updated_at: now }
    })
    // 这条事件可能只改了化身 state 而没动 task.status(stateChanged 单独成立);带上落账后的
    // 状态是无害的——订阅方拿它与上次已知状态比对,相同即静默。
    await this.appendEvent(
      worker.worker_id,
      mainline.seq,
      'state_changed',
      { to: observed, source: 'reconcile' },
      realigned?.task.status
    )
  }

  async requestWorkerInterrupt(workerId: string): Promise<WorkerControlOperation> {
    return this.requestWorkerControlOperation(workerId, 'interrupt')
  }

  async requestWorkerStop(workerId: string): Promise<WorkerControlOperation> {
    return this.requestWorkerControlOperation(workerId, 'stop')
  }

  private async requestWorkerControlOperation(
    workerId: string,
    kind: WorkerControlOperationKind,
  ): Promise<WorkerControlOperation> {
    return this.withLock(workerId, async () => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) throw new WorkerNotFoundError(workerId)
      const incarnation = requireMainlineIncarnation(found.worker)
      if (!isExecutableIncarnation(incarnation)) throw new Error(`worker ${workerId} has no controllable incarnation`)
      if (!incarnation.incarnation_id) throw new Error(`worker ${workerId} incarnation has no stable identity`)
      return this.executeControlOperationLocked(found.managerKey, found.worker, incarnation, kind)
    })
  }

  private async stopSourceForHandoffLocked(
    managerKey: ManagerKey,
    worker: LedgerWorker,
    source: ExecutableIncarnation,
  ): Promise<WorkerControlOperation> {
    return this.executeControlOperationLocked(managerKey, worker, source, 'stop', { handoffSupersede: true })
  }

  private async executeControlOperationLocked(
    managerKey: ManagerKey,
    worker: LedgerWorker,
    incarnation: ExecutableIncarnation,
    kind: WorkerControlOperationKind,
    options?: { readonly handoffSupersede?: boolean },
  ): Promise<WorkerControlOperation> {
    if (!incarnation.incarnation_id) throw new Error(`worker ${worker.worker_id} incarnation has no stable identity`)
    const adapter = this.deps.adapters.get(incarnation.impl)
    if (!adapter) throw new Error(`worker adapter unavailable: ${incarnation.impl}`)
    const operation = await this.controlOperationStore.create({
      worker_id: worker.worker_id,
      manager_key: managerKey,
      incarnation_id: incarnation.incarnation_id,
      impl: incarnation.impl,
      seq: incarnation.seq,
      kind,
      created_at: this.deps.now(),
    }, options)
    const executing = await this.controlOperationStore.transition(
      worker.worker_id,
      operation.operation_id,
      'executing',
      this.deps.now(),
    )
    try {
      const handle = handleForIncarnation(worker.worker_id, incarnation)
      if (kind === 'interrupt') {
        if (!adapter.interrupt) throw new Error(`worker impl '${incarnation.impl}' does not support interrupt`)
        await adapter.interrupt(handle)
      } else {
        const stop = adapter.stop?.bind(adapter) ?? adapter.kill.bind(adapter)
        await stop(handle)
        for (const fork of worker.incarnations) {
          if (fork.forked_from === undefined || !isExecutableIncarnation(fork) || fork.state === 'exited') continue
          const forkAdapter = this.deps.adapters.get(fork.impl)
          if (!forkAdapter) throw new Error(`fork adapter unavailable: ${fork.impl}`)
          const stopFork = forkAdapter.stop?.bind(forkAdapter) ?? forkAdapter.kill.bind(forkAdapter)
          await stopFork(handleForIncarnation(worker.worker_id, fork))
        }
      }
      await this.controlOperationStore.transition(worker.worker_id, executing.operation_id, 'verifying', this.deps.now())
    } catch (error) {
      return this.settleControlOperation(
        executing,
        'failed',
        error instanceof Error ? error.message : String(error),
      )
    }
    return this.verifyControlOperationLocked(executing)
  }

  private async verifyControlOperation(operation: WorkerControlOperation): Promise<WorkerControlOperation> {
    return this.withLock(operation.worker_id, () => this.verifyControlOperationLocked(operation))
  }

  /** A control signal is only accepted synchronously; mainline and registered-fork callbacks provide its later proof. */
  private async verifyControlOperationsForStateChange(h: IncarnationHandle): Promise<void> {
    if (!h.incarnation_id) return
    for (const operation of await this.controlOperationStore.active(h.worker_id)) {
      if (operation.kind !== 'stop' && operation.incarnation_id !== h.incarnation_id) continue
      await this.verifyControlOperation(operation)
    }
  }

  private async verifyControlOperationLocked(operation: WorkerControlOperation): Promise<WorkerControlOperation> {
    const current = await this.controlOperationStore.get(operation.worker_id, operation.operation_id)
    if (!current || current.status === 'succeeded' || current.status === 'failed' || current.status === 'unknown') return current ?? operation
    let found: Awaited<ReturnType<LedgerStore['findWorker']>>
    let handoffSupersede: boolean
    try {
      found = await this.deps.ledger.findWorker(operation.worker_id)
      handoffSupersede = operation.kind === 'stop' &&
        await this.controlOperationStore.isHandoffSupersede(operation.worker_id, operation.operation_id)
    } catch (error) {
      return this.settleControlOperation(current, 'unknown', error instanceof Error ? error.message : String(error))
    }
    // `cancelAfterVerifiedStop` / `supersedeAfterVerifiedStop` writes ledger truth before the
    // operation becomes succeeded, so restart reconciliation can complete either boundary.
    if (operation.kind === 'stop' && !handoffSupersede && found?.worker.task.status === 'cancelled') {
      return this.settleControlOperation(current, 'succeeded', 'task was already cancelled after verified stop')
    }
    const incarnation = found?.worker.incarnations.find((item) => item.incarnation_id === operation.incarnation_id)
    if (operation.kind === 'stop' && handoffSupersede && incarnation?.ended_reason === 'superseded') {
      return this.settleControlOperation(current, 'succeeded', 'source was already superseded after verified stop')
    }
    if (!found || !incarnation || !isExecutableIncarnation(incarnation)) {
      return this.settleControlOperation(current, 'unknown', 'target incarnation is no longer available for verification')
    }
    const adapter = this.deps.adapters.get(incarnation.impl)
    if (!adapter) return this.settleControlOperation(current, 'unknown', `worker adapter unavailable: ${incarnation.impl}`)

    let observed: WorkerContractState
    try {
      observed = await adapter.state(handleForIncarnation(operation.worker_id, incarnation))
    } catch (error) {
      return this.settleControlOperation(current, 'unknown', error instanceof Error ? error.message : String(error))
    }
    try {
      if (operation.kind === 'interrupt') {
        return observed === 'running'
          ? current
          : this.settleControlOperation(current, 'succeeded', `native state=${observed}`)
      }
      if (operation.kind === 'ui_response') {
        return this.settleControlOperation(current, 'unknown', 'UI response requires adapter submission settlement')
      }
      if (observed !== 'exited') {
        return current
      }
      for (const fork of found.worker.incarnations) {
        if (fork.forked_from === undefined || !isExecutableIncarnation(fork) || fork.state === 'exited') continue
        const forkAdapter = this.deps.adapters.get(fork.impl)
        if (!forkAdapter) return this.settleControlOperation(current, 'unknown', `fork adapter unavailable: ${fork.impl}`)
        const forkState = await forkAdapter.state(handleForIncarnation(operation.worker_id, fork))
        if (forkState !== 'exited') return this.settleControlOperation(current, 'unknown', `registered fork ${fork.incarnation_id} remains ${forkState}`)
      }
      if (await this.deps.hasRunningBg?.(operation.worker_id)) {
        return this.settleControlOperation(current, 'unknown', 'worker-owned background execution remains active')
      }
      if (handoffSupersede) {
        await this.supersedeAfterVerifiedStop(found.managerKey, found.worker, incarnation)
        return this.settleControlOperation(current, 'succeeded', 'source and registered fork stop requests verified for handoff')
      }
      await this.cancelAfterVerifiedStop(found.managerKey, found.worker, incarnation)
      // A persisted successful stop must never precede the corresponding cancelled task. If the
      // process exits after cancellation, startup reconciliation completes the verifying op.
      return this.settleControlOperation(
        current,
        'succeeded',
        'mainline and registered fork stop requests verified',
      )
    } catch (error) {
      return this.settleControlOperation(current, 'unknown', error instanceof Error ? error.message : String(error))
    }
  }

  private async cancelAfterVerifiedStop(
    managerKey: ManagerKey,
    worker: LedgerWorker,
    incarnation: ExecutableIncarnation,
  ): Promise<void> {
    if (isTerminalStatus(worker.task.status)) return
    const now = this.deps.now()
    const cancelled = await this.deps.ledger.upsertWorker(managerKey, worker.worker_id, (previous) => {
      if (!previous || isTerminalStatus(previous.task.status)) return previous
      const mainline = mainlineIncarnation(previous)
      if (!mainline || mainline.incarnation_id !== incarnation.incarnation_id) return previous
      const task = applyStatusTransition(previous.task, 'cancelled', { now })
      const incarnations = previous.incarnations.map((item) => {
        if (item.forked_from !== undefined && isExecutableIncarnation(item) && item.state !== 'exited') {
          return { ...item, state: 'exited' as const, ended_at: now, ended_reason: 'killed' as const }
        }
        return item.incarnation_id === incarnation.incarnation_id
          ? { ...item, state: 'exited' as const, ended_at: now, ended_reason: 'killed' as const }
          : item
      })
      const supervision = supervisionAfterMainlineTransition(previous.supervision, task.status, 'exited', incarnation.seq, now)
      return { ...previous, task, incarnations, ...(supervision ? { supervision } : {}), updated_at: now }
    })
    await this.appendEvent(worker.worker_id, incarnation.seq, 'state_changed', { to: 'exited', reason: 'stop_verified' }, cancelled?.task.status)
    for (const item of this.getInbox(worker.worker_id).drain()) {
      await this.appendEvent(worker.worker_id, incarnation.seq, 'state_changed', {
        kind: 'dead_letter',
        reason: 'task_cancelled',
        text_len: item.text.length,
      })
      await item.onSettled?.('dead_letter', {
        seq: incarnation.seq,
        reason: 'task_cancelled',
        certainty: 'unknown',
      })
    }
  }

  private async supersedeAfterVerifiedStop(
    managerKey: ManagerKey,
    worker: LedgerWorker,
    incarnation: ExecutableIncarnation,
  ): Promise<void> {
    const now = this.deps.now()
    await this.deps.ledger.upsertWorker(managerKey, worker.worker_id, (previous) => {
      if (!previous) return undefined
      const source = previous.incarnations.find((item) => item.incarnation_id === incarnation.incarnation_id)
      if (!source || !isExecutableIncarnation(source)) return previous
      const incarnations = previous.incarnations.map((item) => {
        if (item.incarnation_id === incarnation.incarnation_id) {
          return { ...item, state: 'exited' as const, ended_at: now, ended_reason: 'superseded' as const }
        }
        if (item.forked_from !== undefined && isExecutableIncarnation(item) && item.state !== 'exited') {
          return { ...item, state: 'exited' as const, ended_at: now, ended_reason: 'killed' as const }
        }
        return item
      })
      return { ...previous, incarnations, updated_at: now }
    })
    await this.appendEvent(
      worker.worker_id,
      incarnation.seq,
      'superseded',
      { reason: 'handoff_stop_verified' },
    )
  }

  private async settleControlOperation(
    operation: WorkerControlOperation,
    status: Extract<WorkerControlOperationStatus, 'succeeded' | 'failed' | 'unknown'>,
    detail: string,
  ): Promise<WorkerControlOperation> {
    const settled = await this.controlOperationStore.transition(
      operation.worker_id,
      operation.operation_id,
      status,
      this.deps.now(),
      detail,
    )
    const delivery = this.deliverControlOperationNotifications(settled.worker_id)
    // Without a Manager operation router this is only the durable audit append. Finish it before
    // returning the control result; otherwise a short-lived harness can lose the audit record.
    if (this.deps.onOperationNotification) void delivery
    else await delivery
    return settled
  }

  private async deliverControlOperationNotifications(workerId: string): Promise<void> {
    const mutex = this.controlNotificationMutexes.get(workerId) ?? new AsyncMutex()
    this.controlNotificationMutexes.set(workerId, mutex)
    await mutex.run(async () => {
      for (const notification of await this.controlOperationStore.pendingNotifications(workerId)) {
        const { operation } = notification
        const event = this.buildEvent(workerId, operation.seq, 'operation_settled', {
          operation_id: operation.operation_id,
          incarnation_id: operation.incarnation_id,
          kind: operation.kind,
          status: operation.status,
          detail: operation.detail ?? '',
        })
        try {
          if (!notification.event_written) {
            await this.getEventLog(workerId).append(event)
            await this.controlOperationStore.markEventWritten(workerId, operation.operation_id)
          }
          if (!this.deps.onOperationNotification) continue
          const delivery = await this.deps.onOperationNotification(operation.manager_key, event)
          if (delivery?.consumed) {
            await this.controlOperationStore.markNotificationConsumed(workerId, operation.operation_id, this.deps.now())
          }
        } catch (error) {
          console.error(`[WorkerHarness] control operation notification failed for ${operation.operation_id}:`, error)
        }
      }
    })
  }

  async killWorker(workerId: string, reason?: string): Promise<void> {
    // Compatibility only: callers outside the Manager tool face still get the verified stop
    // semantics. The historical reason had no protocol meaning and is retained for signature
    // compatibility only.
    void reason
    const found = await this.deps.ledger.findWorker(workerId)
    if (!found) throw new WorkerNotFoundError(workerId)
    if (isTerminalStatus(found.worker.task.status)) return
    await this.requestWorkerStop(workerId)
  }

  /**
   * 同步建立侧问：锁内创建 receipt/捕获发起时主线，锁外等待 adapter 建立 fork 与接受首问，
   * 再锁内按 query_id 提交 fork ledger + running receipt。回答生成不在这次调用里等待。
   *
   * adapter 慢调用必须留在 worker 锁外，保证并发 kill/send/query 不被整轮回答阻塞；锁释放
   * 期间主线即使被 kill 或 handoff，已真实建立的 fork 仍按发起时的 source seq 落账。任何
   * 建立或持久提交失败都在本次调用抛 QueryEstablishmentError，并由 query receipt 保留通知
   * 责任；不会再合成第二条 fire-and-forget wake。
   */
  async queryWorker(
    workerId: string,
    question: string,
    opts?: { readonly managerKey?: ManagerKey },
  ): Promise<QueryWorkerStartedResult> {
    this.deps.assertExecutionAdmission?.()
    interface QueryPrep {
      readonly adapter: WorkerAdapter
      readonly implId: WorkerImplId
      readonly ref: IncarnationRef
      readonly workspace: string
      readonly managerKey: ManagerKey
      readonly receipt: WorkerQueryReceipt
    }

    const prep = await this.withLock(workerId, async (): Promise<QueryPrep> => {
      const found = await this.deps.ledger.findWorker(workerId)
      if (!found) throw new WorkerNotFoundError(workerId)
      const incarnation = requireExecutableIncarnation(requireMainlineIncarnation(found.worker))
      const queryId = randomUUID()
      const createdAt = this.deps.now()
      let receipt: WorkerQueryReceipt
      try {
        receipt = await this.queryReceiptStore.create({
          query_id: queryId,
          worker_id: workerId,
          manager_key: opts?.managerKey ?? found.managerKey,
          question_preview: question,
          created_at: createdAt,
          updated_at: createdAt,
          establishment_deadline_at: new Date(
            Date.parse(createdAt) + QUERY_ESTABLISHMENT_TIMEOUT_MS,
          ).toISOString(),
          state: 'starting',
          manager_notification: { status: 'not_required' },
        })
      } catch (error) {
        throw new Error(`query receipt unavailable: ${sanitizeOperationFailureReason(
          error,
          this.deps.redactFailureReason,
          question,
          'receipt store failed',
        )}`)
      }
      const adapter = this.deps.adapters.get(incarnation.impl)
      if (!adapter || !adapter.capabilities().fork) {
        await this.failQueryEstablishment(
          receipt,
          'fork_capability_unavailable',
          adapter
            ? `${incarnation.impl} does not support fork`
            : `no adapter registered for impl '${incarnation.impl}'`,
          'not_started',
        )
      }
      return {
        adapter: adapter!,
        implId: incarnation.impl,
        ref: {
          worker_id: workerId,
          incarnation_id: incarnation.incarnation_id,
          seq: incarnation.seq,
          session_ref: incarnation.session_ref,
        },
        workspace: incarnation.workspace,
        managerKey: found.managerKey,
        receipt,
      }
    })

    let admission: Awaited<ReturnType<NonNullable<HarnessDeps['admitWorkerConnection']>>> | undefined
    let forkHandle: IncarnationHandle | undefined
    const forkIncarnationId = randomUUID()
    const forkInstructions = await captureWorkspaceInstructions({
      workersDir: this.deps.workersDir,
      workerId,
      incarnationId: forkIncarnationId,
      workspaceRoot: prep.workspace,
      capturedAt: this.deps.now(),
    })
    const forkClaudeBridge = prep.implId === 'claude-code'
      ? await prepareClaudeWorkspaceBridge({
        workersDir: this.deps.workersDir,
        workerId,
        incarnationId: forkIncarnationId,
        workspaceRoot: prep.workspace,
        instructions: forkInstructions,
      })
      : undefined
    const disposeAdmission = async (): Promise<void> => {
      const owned = admission
      admission = undefined
      if (!owned) return
      try {
        await owned.dispose()
      } catch (error) {
        console.error(`[WorkerHarness] failed to dispose query admission ${prep.receipt.query_id}:`, error)
      }
    }
    try {
      admission = await this.deps.admitWorkerConnection?.(prep.implId, workerId)
      const forkOptions: ForkOptions = {
        query_id: prep.receipt.query_id,
        incarnation_id: forkIncarnationId,
        establishment_deadline_at: prep.receipt.establishment_deadline_at,
        ...(prep.implId === 'builtin' || forkClaudeBridge?.kind === 'user_owned_claude_md'
          ? { workspace_instructions: forkInstructions }
          : {}),
        ...(admission && Object.keys(admission.env).length > 0 ? { connection_env: admission.env } : {}),
      }
      const remainingMs = Date.parse(prep.receipt.establishment_deadline_at) - Date.parse(this.deps.now())
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        throw new ForkEstablishmentError(
          'timeout',
          'fork establishment deadline expired before the adapter was started',
          'not_started',
        )
      }
      forkHandle = await this.awaitForkEstablishment(
        prep.adapter.fork(prep.ref, question, forkOptions),
        prep.adapter,
        remainingMs,
      )
      if (forkHandle.incarnation_id !== undefined && forkHandle.incarnation_id !== forkIncarnationId) {
        throw new Error('adapter returned a fork handle with a mismatched incarnation_id')
      }
      forkHandle = { ...forkHandle, incarnation_id: forkIncarnationId }
      if (forkHandle.query_id !== prep.receipt.query_id) {
        throw new Error('adapter returned a fork handle with a mismatched query_id')
      }
    } catch (error) {
      if (forkHandle) {
        try {
          await prep.adapter.kill(forkHandle)
        } catch (killError) {
          console.error(`[WorkerHarness] failed to stop rejected query fork ${prep.receipt.query_id}:`, killError)
        }
      }
      await disposeAdmission()
      return this.failQueryEstablishment(
        prep.receipt,
        queryFailureCode(error),
        sanitizeOperationFailureReason(
          error,
          this.deps.redactFailureReason,
          question,
          'query establishment failed',
        ),
        queryFailureCertainty(error),
      )
    }

    let forkRecorded = false
    try {
      await this.withLock(workerId, async () => {
        const found = await this.deps.ledger.findWorker(workerId)
        if (!found) throw new WorkerNotFoundError(workerId)
        const now = this.deps.now()
        const committed = await this.deps.ledger.upsertWorker(prep.managerKey, workerId, (prevWorker) => {
          if (!prevWorker) return undefined
          const forkIncarnation: Incarnation = {
            incarnation_id: forkIncarnationId,
            seq: forkHandle!.seq,
            impl: prep.implId,
            state: 'running',
            workspace: prep.workspace,
            session_ref: forkHandle!.session_ref,
            started_at: now,
            workspace_instructions: forkInstructions.snapshot,
            forked_from: prep.ref.incarnation_id ?? prep.ref.seq,
            query_id: prep.receipt.query_id,
          }
          return {
            ...prevWorker,
            incarnations: [...prevWorker.incarnations, forkIncarnation],
            updated_at: now,
          }
        })
        if (!committed) throw new WorkerNotFoundError(workerId)
        forkRecorded = true
        await this.queryReceiptStore.markRunning(
          workerId,
          prep.receipt.query_id,
          forkHandle!.seq,
          this.deps.now(),
        )
        if (admission) {
          this.connectionDisposers.set(`${workerId}:${forkHandle!.seq}`, admission.dispose)
          admission = undefined
        }
      })
    } catch (error) {
      let forkStopped = false
      try {
        await prep.adapter.kill(forkHandle)
        forkStopped = true
      } catch {
        // The fork may still be running; the receipt must preserve that uncertainty.
      }
      if (forkRecorded && forkStopped) {
        try {
          await this.withLock(workerId, async () => {
            const found = await this.deps.ledger.findWorker(workerId)
            if (!found) return
            const target = found.worker.incarnations.find(
              (incarnation) => incarnation.query_id === prep.receipt.query_id,
            )
            if (!target || target.state === 'exited') return
            const endedAt = this.deps.now()
            await this.deps.ledger.upsertWorker(found.managerKey, workerId, (prev) => {
              if (!prev) return undefined
              return {
                ...prev,
                incarnations: patchIncarnationBySeq(prev.incarnations, target.impl, target.seq, {
                  state: 'exited',
                  ended_at: endedAt,
                  ended_reason: 'killed',
                }),
                updated_at: endedAt,
              }
            })
          })
        } catch (cleanupError) {
          console.error(`[WorkerHarness] failed to close rejected query fork ${prep.receipt.query_id}:`, cleanupError)
        }
      }
      await disposeAdmission()
      return this.failQueryEstablishment(
        prep.receipt,
        'fork_record_failed',
        sanitizeOperationFailureReason(
          error,
          this.deps.redactFailureReason,
          question,
          'query establishment failed',
        ),
        'unknown',
      )
    }

    await this.appendAuditEvent(workerId, forkHandle.seq, 'state_changed', {
      kind: 'fork',
      query_id: prep.receipt.query_id,
      from_seq: prep.ref.seq,
    })

    const pendingState = this.pendingQueryStateChanges.get(prep.receipt.query_id)
    if (pendingState) {
      this.pendingQueryStateChanges.delete(prep.receipt.query_id)
      await this.processStateChange(pendingState.h, pendingState.state, pendingState.report)
    }

    return {
      status: 'started',
      query_id: prep.receipt.query_id,
      worker_id: workerId,
      fork_seq: forkHandle.seq,
    }
  }

  private async awaitForkEstablishment(
    forkPromise: Promise<IncarnationHandle>,
    adapter: WorkerAdapter,
    remainingMs: number,
  ): Promise<IncarnationHandle> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new ForkEstablishmentError(
          'timeout',
          'fork establishment exceeded the 30 second deadline',
          'unknown',
        ))
      }, remainingMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([forkPromise, timeout])
    } catch (error) {
      if (error instanceof ForkEstablishmentError && error.stage === 'timeout') {
        void forkPromise.then((handle) => adapter.kill(handle)).catch((lateError) => {
          console.error('[WorkerHarness] late query fork cleanup failed:', lateError)
        })
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async failQueryEstablishment(
    receipt: WorkerQueryReceipt,
    reasonCode: QueryFailureCode,
    reason: string,
    certainty: QueryFailure['certainty'],
  ): Promise<never> {
    this.pendingQueryStateChanges.delete(receipt.query_id)
    const failure: QueryFailure = {
      reason_code: reasonCode,
      reason,
      phase: 'establishment',
      certainty,
    }
    const current = await this.queryReceiptStore.get(receipt.worker_id, receipt.query_id)
    if (current && current.state !== 'completed' && current.state !== 'failed') {
      try {
        await this.queryReceiptStore.settleFailed(
          receipt.worker_id,
          receipt.query_id,
          failure,
          this.deps.now(),
        )
        await this.appendAuditEvent(receipt.worker_id, 0, 'query_failed', {
          query_id: receipt.query_id,
          ...failure,
        })
      } catch (error) {
        console.error(`[WorkerHarness] failed to persist query establishment failure ${receipt.query_id}:`, error)
      }
    }
    throw new QueryEstablishmentError(receipt.query_id, reasonCode, reason, certainty)
  }

  // ---- 内部 ----

  private async recordCliInputResult(
    h: IncarnationHandle,
    controlState: NonNullable<IncarnationHandle['initial_input']>['control_state'],
    report?: StateChangeReport,
    expectedStateChangeRevision?: number,
  ): Promise<void> {
    const external = cliContractState(controlState)
    let stateCommitted = false
    let committedStatus: TaskStatus | undefined
    await this.withLock(h.worker_id, async () => {
      const found = await this.deps.ledger.findWorker(h.worker_id)
      if (!found) return
      const { worker, managerKey } = found
      const target = findIncarnation(worker, h.impl, h.seq)
      if (!target) return

      const revisionKey = `${h.worker_id}#${h.impl}#${h.seq}`
      const revisionMatches = expectedStateChangeRevision === undefined ||
        (this.stateChangeRevisions.get(revisionKey) ?? 0) === expectedStateChangeRevision
      if (!revisionMatches || target.state === 'exited' || isTerminalStatus(worker.task.status)) {
        // A concurrent callback owns the state transition, but session discovery is an independent
        // monotonic fact. Preserve a newly discovered non-empty ref even when synthetic running is stale.
        if (h.session_ref && target.session_ref !== h.session_ref) {
          await this.deps.ledger.upsertWorker(managerKey, h.worker_id, (prev) => {
            if (!prev) return undefined
            return {
              ...prev,
              incarnations: patchIncarnationBySeq(prev.incarnations, h.impl, h.seq, {
                session_ref: h.session_ref,
              }),
              updated_at: this.deps.now(),
            }
          })
        }
        return
      }

      let desired: TaskStatus
      if (external === 'running') desired = 'running'
      else if (external === 'idle') {
        const bgRunning = (await this.deps.hasRunningBg?.(h.worker_id)) ?? false
        desired = bgRunning || this.hasPendingBgNotification(h.worker_id) ? 'running' : 'waiting_input'
      } else {
        desired = taskStatusFromIncarnation('exited', report?.endReason)
      }
      const now = this.deps.now()
      const committed = await this.deps.ledger.upsertWorker(managerKey, h.worker_id, (prev) => {
        if (!prev) return undefined
        const task = prev.task.status === desired ? prev.task : applyStatusTransition(prev.task, desired, {
          now,
          ...(desired === 'failed' ? { error: report?.endReason ?? 'CLI incarnation exited' } : {}),
        })
        const incarnations = patchIncarnationBySeq(prev.incarnations, h.impl, h.seq, {
          state: external,
          session_ref: h.session_ref || target.session_ref,
          ...(external === 'exited' ? { ended_at: now, ended_reason: report?.endReason ?? 'crashed' } : {}),
        })
        return { ...prev, task, incarnations, updated_at: now }
      })
      committedStatus = committed?.task.status
      stateCommitted = committed !== undefined
    })
    if (!stateCommitted) return
    if (external === 'exited') {
      this.bumpInputOwnershipRevision(h.worker_id)
      const inbox = this.getInbox(h.worker_id)
      inbox.requeueConsumed()
      inbox.release()
      this.fireIncarnationTerminal(h)
    }
    if (report) {
      await this.appendEvent(h.worker_id, h.seq, 'state_changed', cliReportDetail(external, report), committedStatus)
    } else if (external !== 'running') {
      await this.appendEvent(h.worker_id, h.seq, 'state_changed', { to: external }, committedStatus)
    }
  }

  private async processStateChange(
    h: IncarnationHandle,
    state: WorkerContractState,
    report?: StateChangeReport,
  ): Promise<void> {
    let settledCurrentExit = false
    // 被动唤醒只携带 adapter 已经结构化识别出的 assistant text。tmux capture 是调用方
    // 显式请求的诊断视图，不能因一次状态回调被常规塞进 manager 上下文。
    const wakeText = truncateWakeText(report?.lastText, WAKE_TEXT_MAX_CHARS, '', 'head')
    const wakeSummary = truncateWakeText(report?.summary, WAKE_SUMMARY_MAX_CHARS, '', 'head')
    // detail 里两段正文的组装收口在这里,fork 分支与主线分支共用——不在两处各拼一遍。
    const wakeDetail = {
      ...(wakeText ? { text: wakeText } : {}),
      ...(wakeSummary ? { summary: wakeSummary } : {}),
      ...(report?.waitReason ? { wait_reason: report.waitReason } : {}),
    }
    await this.withLock(h.worker_id, async () => {
      const found = await this.deps.ledger.findWorker(h.worker_id)
      if (!found) return // 未知 worker,理论不该发生;防御性丢弃,不抛给 adapter 的回调
      const { worker, managerKey } = found

      const target = findIncarnation(worker, h.impl, h.seq)
      if (!target) {
        if (h.query_id) {
          const receipt = await this.queryReceiptStore.get(h.worker_id, h.query_id)
          if (receipt?.state === 'starting') {
            this.pendingQueryStateChanges.set(h.query_id, { h, state, ...(report ? { report } : {}) })
          }
        }
        return
      }

      // endReason 一律取 adapter 上报的真值:三个 adapter 的 transitionExited 形参本就是
      // 必填的 ended_reason,且都在调回调之前已经把它写进自己的 meta,所以常规路径上
      // `state==='exited'` 必然带着一个具体值(builtin 是 finish_task 的结构化确证;cc/codex
      // 是"会话消失且非本进程 kill ⇒ completed"的推断,可信度分级见协议 §6.3)。
      //
      // 缺席是**防守分支,不是常规路径**:只有未接线的第四个实现或测试替身才会走到。此时
      // 不替 adapter 编一个原因——原样把 undefined 交给 taskStatusFromIncarnation,由它既有的
      // 防守分支(exited + 无原因 ⇒ failed)兜住,宁可记成失败也不谎报成功。
      const endReason: IncarnationEndReason | undefined = state === 'exited' ? report?.endReason : undefined
      const now = this.deps.now()

      if (target.forked_from !== undefined) {
        // fork 化身(一次性侧问分支)自己的生命周期只更新它自己的化身条目,不影响主线
        // task.status——protocol-agent-v3 §5.3"fork 不影响主线"在这里的具体体现:即使这是
        // fork 化身的终态回调,也绝不能像"当前化身"那样去推进 task 状态机。
        if (target.state === 'exited') return // 已终态,迟到回调忽略
        await this.deps.ledger.upsertWorker(managerKey, h.worker_id, (prev) => {
          if (!prev) return undefined
          // session_ref 现读现取(h.session_ref,不是构造 handle 时闭包住的旧值)——
          // builtin 的 session_ref 随每轮 burst 前进,adapter 侧在每次 onStateChange 回调
          // 时都重新取 instance.tip 填入 handle(见 builtin/adapter.ts 的 transitionState/
          // transitionExited);台账因此在每次状态回调时顺带刷新到"最近一次完成的状态
          // 转换点"。cc/codex 的 session_ref 本就稳定,这里是等价 no-op。
          const incarnations = patchIncarnationBySeq(
            prev.incarnations,
            h.impl,
            h.seq,
            state === 'exited'
              ? { state, ended_at: now, ended_reason: endReason, session_ref: h.session_ref }
              : { state, session_ref: h.session_ref }
          )
          return { ...prev, incarnations, updated_at: now }
        })
        if (target.query_id) {
          if (state === 'exited') {
            await this.settleQueryExecution(target.query_id, h, endReason, wakeDetail)
          } else {
            await this.appendAuditEvent(h.worker_id, h.seq, 'state_changed', {
              to: state,
              query_id: target.query_id,
              ...wakeDetail,
            })
          }
        } else {
          await this.appendEvent(h.worker_id, h.seq, 'state_changed', { to: state, ...wakeDetail })
        }
        if (state === 'exited') this.fireIncarnationTerminal(h)
        return
      }

      // 主线分支:只有"当前主线化身"的回调才驱动 task.status——fork 之后数组末尾是侧问
      // 分支,不能再用"数组最后一个"判定"是不是当前化身"。
      const mainline = mainlineIncarnation(worker)
      if (!mainline) return
      // 按 (impl, seq) 判定,不能只比 seq——跨实现切换(switchWorkerImpl/handoff)后,新
      // 实现的 adapter 是全新实例,其 seq 计数从头开始,与被 kill 的旧实现化身撞号是常态
      // (如 codex#1 顶替 claude-code#1)。只比 seq 会把旧实现迟到的 exited 回调误判成
      // "当前主线化身的回调",错误地把新主线整个判死。这是 findIncarnation/patchIncarnationBySeq
      // 已经统一的 (impl,seq) 判定原则在这里的收口。
      if (mainline.seq !== h.seq || mainline.impl !== h.impl) return // 非当前主线化身的迟到回调,忽略
      if (target.state === 'exited') return // 目标化身已终态,迟到回调忽略(与上面 fork 分支的短路对称,避免对已终态化身再次施加迁移)
      if (isTerminalStatus(worker.task.status)) return // 已是终态(如已被 killWorker 落定),回调迟到,忽略
      const uiSnapshot = await this.prepareUiSnapshot(
        { ...h, incarnation_id: target.incarnation_id },
        managerKey,
        report,
        now,
      )

      // An idle builtin incarnation with an owned shell is still executing work:
      // end_turn is its wait primitive, not task completion.
      const waitingInput = state === 'idle' ? true : undefined
      const pendingStop = state === 'exited' && (await this.controlOperationStore.active(h.worker_id)).some(
        (operation) => operation.kind === 'stop' && operation.incarnation_id === target.incarnation_id,
      )
      const nextStatus: TaskStatus = pendingStop
        ? worker.task.status
        : state === 'idle' && (this.hasPendingBgNotification(h.worker_id) || await this.deps.hasRunningBg?.(h.worker_id))
          ? 'running'
          : taskStatusFromIncarnation(state, endReason, waitingInput)
      const shouldCreateTurn = report?.completionSource !== undefined && target.state !== state
      if (shouldCreateTurn) {
        try {
          await this.collectNativeActivityLocked({
            ...h,
            ...(target.incarnation_id ? { incarnation_id: target.incarnation_id } : {}),
            session_ref: h.session_ref || target.session_ref,
          }, managerKey)
        } catch (error) {
          // Native activity is preferred evidence, but the adapter has already authoritatively
          // reported this state transition. Do not lose the transition if the source is unreadable.
          console.error(`[WorkerHarness] native activity collection failed at turn boundary for ${h.worker_id}#${h.seq}:`, error)
        }
      }

      const committed = await this.deps.ledger.upsertWorker(managerKey, h.worker_id, (prev) => {
        if (!prev) return undefined
        // 同状态的 task 回调仍可能携带化身状态变化（例如 idle+owned bg
        // 应保持 task running）。只有两者都已经一致时才是无操作。
        const current = findIncarnation(prev, h.impl, h.seq)
        if (nextStatus === prev.task.status && current?.state === state) return prev
        const nextTask = nextStatus === prev.task.status
          ? prev.task
          : applyStatusTransition(prev.task, nextStatus, { now })
        // session_ref 现读现取,同上面 fork 分支的注释。
        const incarnations = patchIncarnationBySeq(
          prev.incarnations,
          h.impl,
          h.seq,
          state === 'exited'
            ? { state, ended_at: now, ended_reason: endReason, session_ref: h.session_ref }
            : { state, session_ref: h.session_ref }
        )
        const supervision = supervisionAfterMainlineTransition(
          prev.supervision,
          nextTask.status,
          state,
          h.seq,
          now,
        )
        return { ...prev, task: nextTask, incarnations, ...(supervision ? { supervision } : {}), updated_at: now }
      })
      settledCurrentExit = state === 'exited' && committed !== undefined
      const turn = shouldCreateTurn && committed
        ? await this.createPendingTurn(managerKey, {
            ...h,
            ...(target.incarnation_id ? { incarnation_id: target.incarnation_id } : {}),
            session_ref: h.session_ref || target.session_ref,
          }, report, now)
        : undefined
      // 主线分支是 task 状态机的主要推进点——事件必须自带落账后的状态,否则订阅方现读台账
      // 时若已经有下一次落账(如 §5.3 透明接续把终态拉回 running),这次迁移(含 completed
      // 这类终态)会被整条吞掉。见 worker-events.ts `HarnessEvent.task_status`。
      await this.appendEvent(
        h.worker_id,
        h.seq,
        'state_changed',
          {
            ...(report?.notification ? cliReportDetail(state, report) : { to: state, ...wakeDetail }),
            ...uiSnapshotDetail(uiSnapshot),
            ...(turn ? { turn_id: turn.turn_id, turn_pending: true } : {}),
        },
        committed?.task.status
      )
    })
    await this.deliverNativeActivityNotifications(h.worker_id)
    if (state === 'exited') this.fireIncarnationTerminal(h)

    if (!report?.notification && settledCurrentExit) {
      this.bumpInputOwnershipRevision(h.worker_id)
      const inbox = this.getInbox(h.worker_id)
      inbox.requeueConsumed()
      inbox.release()
      await this.flushInbox(h.worker_id)
    } else if (!report?.notification && (state === 'idle' || state === 'running')) {
      const inbox = this.getInbox(h.worker_id)
      inbox.release('waiting_action')
      await this.flushInbox(h.worker_id)
    }
  }

  private async settleQueryExecution(
    queryId: string,
    h: IncarnationHandle,
    endReason: IncarnationEndReason | undefined,
    wakeDetail: Record<string, string>,
  ): Promise<void> {
    const receipt = await this.queryReceiptStore.get(h.worker_id, queryId)
    if (!receipt || receipt.state !== 'running') return
    if (endReason === 'completed') {
      await this.queryReceiptStore.settleCompleted(h.worker_id, queryId, this.deps.now())
      await this.appendAuditEvent(h.worker_id, h.seq, 'query_completed', {
        query_id: queryId,
        fork_seq: h.seq,
        ...wakeDetail,
      })
      return
    }
    const failure: QueryFailure = {
      reason_code: 'query_execution_failed',
      reason: endReason ? `query fork exited with reason '${endReason}'` : 'query fork exited without a completion reason',
      phase: 'execution',
      certainty: 'failed',
    }
    await this.queryReceiptStore.settleFailed(h.worker_id, queryId, failure, this.deps.now())
    await this.appendAuditEvent(h.worker_id, h.seq, 'query_failed', {
      query_id: queryId,
      fork_seq: h.seq,
      ...failure,
      ...wakeDetail,
    })
  }

  private withLock<T>(workerId: string, fn: () => Promise<T>): Promise<T> {
    let mutex = this.mutexes.get(workerId)
    if (!mutex) {
      mutex = new AsyncMutex()
      this.mutexes.set(workerId, mutex)
    }
    return mutex.run(fn)
  }

  private getInbox(workerId: string): WorkerInbox {
    let inbox = this.inboxes.get(workerId)
    if (!inbox) {
      inbox = new WorkerInbox(workerId)
      this.inboxes.set(workerId, inbox)
    }
    return inbox
  }

  private getEventLog(workerId: string): WorkerEventLog {
    let log = this.eventLogs.get(workerId)
    if (!log) {
      log = new WorkerEventLog(join(this.deps.workersDir, workerId))
      this.eventLogs.set(workerId, log)
    }
    return log
  }

  /**
   * `taskStatus`:只有**真正伴随一次 task 状态迁移**的调用点才传,值取自那次
   * `ledger.upsertWorker` 的返回值(`committed?.task.status`)——即真正写进台账的那份
   * worker,不是 harness 另算一遍,保证事件里的值与盘上的值同源。见 worker-events.ts
   * `HarnessEvent.task_status` 的字段注释(为什么必须由事件自带,以及缺席时的语义)。
   *
   * 本文件里带这个参数的调用点(8 处,均为 task 级迁移):spawnWorker 的失败/成功收尾、
   * reviveIncarnation 的 `resumed`、handoffIncarnation 第 4 步的 `spawned`、markCrashed 的
   * `exited`、realignAliveIncarnation 的 `state_changed`、killWorker 的 `killed`、
   * processStateChange 主线分支的 `state_changed`。其余调用点(化身级事件:input_sent /
   * fork 分支 state_changed / query_failed / dead-letter / superseded / handoff_started …)
   * 都不动 task.status,一律不传。
   *
   * upsert 的 mutator 返回 undefined(worker 已不在台账)时 `committed` 是 undefined,这里
   * 原样落成"不带该字段",订阅方退回现读台账兜底,不构造假状态。
   */
  private async appendEvent(
    workerId: string,
    seq: number,
    kind: HarnessEventKind,
    detail?: Record<string, unknown>,
    taskStatus?: TaskStatus
  ): Promise<void> {
    const event = this.buildEvent(workerId, seq, kind, detail, taskStatus)
    await this.getEventLog(workerId).append(event)
    // fire-and-forget:本方法的调用点几乎都在 per-worker 锁内,而一次唤醒是一整个 manager
    // episode(见 HarnessDeps.onEvent)。返回值只有活性巡检看,走下面那条专用出口。
    void this.deps.onEvent?.(event)
  }

  /**
   * 与 `appendEvent` 唯一的区别:**等**订阅方把这条事件投递完,并把结果交回调用方。
   *
   * 只有活性巡检用它(见 `sweepLiveness` 的去重与重报规则),且它跑在任何 per-worker 锁
   * 之外——在锁内等一整个 manager episode 会把同一个 worker 上的其它编排动作全部堵住,
   * 而 manager 的工具反过来又要调 harness,那就是自锁。
   */
  private async appendEventAwaitingDelivery(
    workerId: string,
    seq: number,
    kind: HarnessEventKind,
    detail?: Record<string, unknown>,
  ): Promise<HarnessEventDelivery | undefined> {
    const event = this.buildEvent(workerId, seq, kind, detail)
    await this.getEventLog(workerId).append(event)
    return (await this.deps.onEvent?.(event)) ?? undefined
  }

  /** Persist and route a previously prepared event without changing its audit timestamp or detail. */
  private async appendPreparedEventAwaitingDelivery(event: HarnessEvent): Promise<HarnessEventDelivery | undefined> {
    await this.getEventLog(event.worker_id).append(event)
    return (await this.deps.onEvent?.(event)) ?? undefined
  }

  /** Persist operation evidence without using the ordinary Manager route or affecting operation truth. */
  private async appendAuditEvent(
    workerId: string,
    seq: number,
    kind: HarnessEventKind,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.getEventLog(workerId).append(this.buildEvent(workerId, seq, kind, detail))
    } catch (error) {
      console.error(
        `[WorkerHarness] failed to append operation audit event ` +
          `(worker=${workerId}, seq=${seq}, kind=${kind}):`,
        error,
      )
    }
  }

  /** 化身终态收割钩子（P6-A §8.10）：fire-and-forget，异常只记不打断。 */
  /** P6-B：化身级 connection runtime 资源清理（workerId:seq → dispose）。 */
  private readonly connectionDisposers = new Map<string, () => Promise<void>>()

  private fireIncarnationTerminal(h: IncarnationHandle): void {
    const disposer = this.connectionDisposers.get(`${h.worker_id}:${h.seq}`)
    if (disposer) {
      this.connectionDisposers.delete(`${h.worker_id}:${h.seq}`)
      void disposer().catch(() => {})
    }
    try {
      this.deps.onIncarnationTerminal?.(h)
    } catch (error) {
      console.error(`[WorkerHarness] onIncarnationTerminal failed for ${h.worker_id}#${h.seq}:`,
        error instanceof Error ? error.message : String(error))
    }
  }

  /** 事件对象的组装收口(两条 append 路径共用),字段语义见 `HarnessEvent`。 */
  private buildEvent(
    workerId: string,
    seq: number,
    kind: HarnessEventKind,
    detail?: Record<string, unknown>,
    taskStatus?: TaskStatus
  ): HarnessEvent {
    const ts = this.deps.now()
    const base: HarnessEvent = { ts, kind, worker_id: workerId, seq }
    const withDetail: HarnessEvent = detail !== undefined ? { ...base, detail } : base
    return taskStatus !== undefined ? { ...withDetail, task_status: taskStatus } : withDetail
  }
}

/**
 * 主线化身链上的最新化身:排除所有 forked_from 有值的一次性侧问分支(protocol-agent-v3
 * §3、§5.3)。fork 出的化身会被 push 进同一个 incarnations 数组,若继续取"数组最后一个"
 * 当作当前化身,fork 之后 send_to_worker / kill_worker / get_worker_terminal / 化身自然结束
 * 的状态回调全部会被错误地转发到侧问分支——主线因此失联(实测复现:spawn → queryWorker →
 * sendToWorker/killWorker 都 target 到 fork 的 seq,而不是主线 seq)。
 *
 * 前提:worker.incarnations 非空(每个已注册的 worker 至少有 spawn 落下的 seq=1 主线化身)。
 *
 * P5 review 修复 additive:导出给 `get_worker_trace` 的 handler 复用——§8.3 两个按化身读的
 * 端点(terminal/trace)在调用方没给 seq 时必须落在**同一个**化身上；terminal 读取也使用
 * 本函数取缺省。trace 侧若自己再写一遍"排除 forked_from
 * 取最后一条",就会让"主线是哪个化身"出现第二处真相。
 */
export function mainlineIncarnation(worker: LedgerWorker): Incarnation | undefined {
  const mainline = worker.incarnations.filter((inc) => inc.forked_from === undefined)
  return mainline[mainline.length - 1]
}

function plusMs(now: string, durationMs: number): string {
  return new Date(Date.parse(now) + durationMs).toISOString()
}

function supervisionKindForMode(mode: unknown): 'default_review' | 'periodic_report' | undefined {
  if (mode === 'default') return 'default_review'
  if (mode === 'periodic_report') return 'periodic_report'
  return undefined
}

/**
 * Applies the supervision lifecycle rules at the same ledger mutation that changes the mainline.
 * It deliberately does not observe or control a Worker; the caller already owns the state change.
 */
function supervisionAfterMainlineTransition(
  current: WorkerSupervision | undefined,
  taskStatus: TaskStatus,
  mainlineState: WorkerContractState,
  mainlineSeq: number,
  now: string,
  newMainline = false,
): WorkerSupervision | undefined {
  if (isTerminalStatus(taskStatus)) {
    return current ? { version: 1, mode: 'default' } : undefined
  }

  const supervision = current ?? { version: 1, mode: 'default' as const }
  const observation = supervision.observation?.mainline_seq === mainlineSeq
    ? supervision.observation
    : undefined

  if (supervision.mode === 'periodic_report' && supervision.periodic_report) {
    return {
      ...supervision,
      ...(observation ? { observation } : { observation: undefined }),
      ...(supervision.next_due_at
        ? {}
        : { next_due_at: plusMs(now, supervision.periodic_report.interval_ms) }),
    }
  }

  const {
    next_due_at: _nextDueAt,
    pending: _pending,
    periodic_report: _periodicReport,
    observation: _observation,
    ...defaultFields
  } = supervision
  if (taskStatus !== 'running' || mainlineState !== 'running') {
    return {
      ...defaultFields,
      version: 1,
      mode: 'default',
      ...(observation ? { observation } : {}),
    }
  }
  return {
    ...defaultFields,
    version: 1,
    mode: 'default',
    ...(observation ? { observation } : {}),
    next_due_at: !newMainline && supervision.next_due_at
      ? supervision.next_due_at
      : plusMs(now, SUPERVISION_DEFAULT_INTERVAL_MS),
    ...(!newMainline && supervision.pending ? { pending: supervision.pending } : {}),
  }
}

function requireStableIncarnationId(incarnation: Incarnation, workerId: string) {
  if (!incarnation.incarnation_id) {
    throw new Error(`WorkerHarness: worker ${workerId} incarnation ${incarnation.impl}#${incarnation.seq} has no stable identity`)
  }
  return incarnation.incarnation_id
}

function ledgerHandoffEvidence(worker: LedgerWorker, source: Incarnation): HandoffEvidenceInput[] {
  const sourceId = requireStableIncarnationId(source, worker.worker_id)
  return [
    {
      source: 'ledger',
      reference: `task:${worker.task.id}`,
      summary: `Task: ${worker.task.title}`,
    },
    ...(worker.task.goal ? [{
      source: 'ledger' as const,
      reference: `task:${worker.task.id}:goal`,
      summary: `Goal: ${worker.task.goal}`,
    }] : []),
    {
      source: 'ledger',
      reference: `incarnation:${sourceId}:outcome`,
      summary: `Source outcome: ${worker.task.outcome ?? source.ended_reason ?? 'unknown'}`,
    },
  ]
}

function traceHandoffEvidence(
  source: 'native_session' | 'persisted_activity',
  incarnationId: string,
  events: ReadonlyArray<Pick<NormalizedTraceEvent, 'ts' | 'kind' | 'role' | 'summary' | 'source_offset'>>,
): HandoffEvidenceInput[] {
  return events.flatMap((event, index) => {
    const summary = event.summary.trim()
    if (!summary) return []
    const role = event.role ? ` ${event.role}` : ''
    return [{
      source,
      reference: `incarnation:${incarnationId}:${event.source_offset ?? index}`,
      summary: `[${event.kind}${role}] ${summary}`,
    }]
  })
}

function ledgerEventHandoffEvidence(
  workerId: string,
  source: Incarnation,
  events: ReadonlyArray<HarnessEvent>,
): HandoffEvidenceInput[] {
  const sourceId = requireStableIncarnationId(source, workerId)
  return events.map((event, index) => ({
    source: 'ledger' as const,
    reference: `event:${sourceId}:${index}`,
    summary: `Harness lifecycle: ${event.kind}`,
  }))
}

function requireMainlineIncarnation(worker: LedgerWorker): Incarnation {
  const mainline = mainlineIncarnation(worker)
  if (!mainline) throw new WorkerHasNoIncarnationError(worker.worker_id)
  return mainline
}

function requireExecutableIncarnation(incarnation: Incarnation): ExecutableIncarnation {
  if (!isExecutableIncarnation(incarnation)) {
    throw new Error('WorkerHarness: legacy worker continuation is not available')
  }
  return incarnation
}

/**
 * 该 worker 名下是否已经存在过某个 impl 的化身——不限主线/fork、不限存活/终态,只要
 * `worker.incarnations` 里出现过一条 `impl` 匹配的记录就算"用过"。供 handoffIncarnation
 * 的 pre-flight(ImplAlreadyUsedError)与 pickUnusedImpl 共用同一判定。
 */
function implAlreadyUsed(worker: LedgerWorker, impl: WorkerImplId): boolean {
  return worker.incarnations.some((inc) => inc.impl === impl)
}

/**
 * continueTerminalWorker 的 revive:false 分支(自动 handoff)选目标 impl:旧逻辑"原 impl
 * 若仍可用则沿用"在加了 ImplAlreadyUsedError 守卫之后必然自绝——mainline.impl 本身必然
 * 已经用过(它就是正在办理接续的这条化身所在的 impl)。改为挑一个这个 worker 尚未用过的
 * 已注册实现:defaultImpl 优先(未用过就直接用),否则按 `deps.adapters` 的插入顺序取第一个
 * 未用过的。若全都用过,原样返回 defaultImpl——不在这里重复判断/提前抛错,交给
 * handoffIncarnation 唯一的 pre-flight 把关点统一抛 ImplAlreadyUsedError。
 */
function pickUnusedImpl(
  worker: LedgerWorker,
  adapters: ReadonlyMap<WorkerImplId, WorkerAdapter>,
  defaultImpl: WorkerImplId
): WorkerImplId {
  if (adapters.has(defaultImpl) && !implAlreadyUsed(worker, defaultImpl)) return defaultImpl
  for (const impl of adapters.keys()) {
    if (!implAlreadyUsed(worker, impl)) return impl
  }
  return defaultImpl
}

/**
 * 按 (impl, seq) 精确定位一个活跃的化身条目(取最后一条匹配,代表当前活跃化身)。
 *
 * 只按 seq 匹配是不够的(protocol-agent-v3 §6.1"已知限制"):IncarnationHandle.seq 由各
 * adapter 自行分配,只保证同一个 adapter 实例内递增不重复,不保证跨 adapter 实例(跨实现
 * 切换、进程重启后新建的 adapter 实例)全局唯一——(impl, seq) 相同的记录可能因此在同一
 * 台账里出现不止一条(旧的已归档,新的是当前活跃化身)。化身按时间顺序追加进数组,所以
 * (impl, seq) 相同的多条记录里,数组下标最大的那条才是当前活跃的。
 *
 * processStateChange 的读路径和 patchIncarnationBySeq 的写路径都必须使用同一原则,
 * 确保定位的是同一条活跃化身,避免读写分离导致的语义错位。
 */
function findIncarnation(worker: LedgerWorker, impl: WorkerImplId, seq: number): Incarnation | undefined {
  let lastMatch: Incarnation | undefined
  for (const inc of worker.incarnations) {
    if (inc.impl === impl && inc.seq === seq) lastMatch = inc
  }
  return lastMatch
}

/**
 * `getWorkerTerminal(workerId, { seq })` 专用:按 seq 精确定位一个化身条目(不限
 * 主线/fork,取最后一条匹配——与 findIncarnation 的 (impl,seq) 判定同一"取最后一条"原则)。
 * 调用方(query_worker 触发的事件只给出 seq,不携带 impl)拿不到 impl 参与判定,因此只按
 * seq 匹配;实践中 fork 化身的 impl 恒等于其父化身(adapter.fork 与父化身共用同一个
 * adapter 实例),不会产生跨 impl 撞号的歧义——唯一的例外是该 worker 曾经历跨实现切换
 * 且新旧 adapter 实例恰好在 seq 计数上撞号(protocol-agent-v3 §6.1 已知限制),这种边缘
 * 情况下"取最后一条"与本文件其它同类查找函数保持一致的降级行为,不单独处理。
 *
 * P5 review 修复(第二轮)additive:导出给 `get_worker_trace` 的 handler 复用——两个按化身读的
 * 端点(terminal/trace)对"显式给的 seq 存不存在"必须用同一份判定,否则 trace 侧自己写一遍
 * 就会与 getWorkerTerminal 的"取最后一条匹配"原则漂移。纯可见性变更,零行为改动。
 */
export function findIncarnationBySeq(worker: LedgerWorker, seq: number): Incarnation | undefined {
  let lastMatch: Incarnation | undefined
  for (const inc of worker.incarnations) {
    if (inc.seq === seq) lastMatch = inc
  }
  return lastMatch
}

function handleForIncarnation(workerId: string, incarnation: ExecutableIncarnation): IncarnationHandle {
  return {
    worker_id: workerId,
    incarnation_id: incarnation.incarnation_id,
    seq: incarnation.seq,
    impl: incarnation.impl,
    session_ref: incarnation.session_ref,
    ...(incarnation.query_id ? { query_id: incarnation.query_id } : {}),
  }
}

/**
 * 按 (impl, seq) 精确定位并 patch 一个化身条目,不假设它是数组的最后一个——fork 之后数组
 * 末尾是 fork 化身,继续用"改最后一个"的旧写法会把主线的落定动作(如 kill 后的 exited)
 * 误写进 fork 条目,或反过来让 fork 化身自己的状态变化误写进主线条目,两个方向都是错的。
 *
 * 只按 seq 匹配是不够的(protocol-agent-v3 §6.1"已知限制"):`IncarnationHandle.seq` 由各
 * adapter 自行分配,只保证同一个 adapter 实例内递增不重复,不保证跨 adapter 实例(跨实现
 * 切换、进程重启后新建的 adapter 实例)全局唯一——`(impl, seq)` 相同的记录可能因此在同一
 * 台账里出现不止一条(旧的已归档,新的是当前活跃化身)。化身按时间顺序追加进数组,所以
 * `(impl, seq)` 相同的多条记录里,数组下标最大的那条才是当前活跃的;用 `.map` 对所有匹配
 * 项一视同仁地改写,会连带篡改已经归档的旧记录。这里只精确定位并改写最后一条匹配记录,
 * 更早的同键记录原样保留。
 */
function patchIncarnationBySeq(
  incarnations: Incarnation[],
  impl: Incarnation['impl'],
  seq: number,
  patch: Partial<Incarnation>
): Incarnation[] {
  let lastMatchIndex = -1
  for (let i = 0; i < incarnations.length; i++) {
    if (incarnations[i].impl === impl && incarnations[i].seq === seq) lastMatchIndex = i
  }
  if (lastMatchIndex === -1) return incarnations
  return incarnations.map((inc, i) => (i === lastMatchIndex ? { ...inc, ...patch } : inc)) as Incarnation[]
}

/**
 * §5.3 化身接续:把 task 的状态与派生字段重新置回 running,供接续产出的新化身使用。
 *
 * 终态化身之上继续开一个新化身是显式的"延续"动作,不是 task-status.ts 描述的线性状态机
 * 内的一次迁移——VALID_TRANSITIONS 里终态(completed/failed/cancelled)无出边是"同一次
 * 尝试内不允许原地复活"的不变量。task 已经终态时,不由 harness 自行拼接字段绕开状态机,
 * 而是走 task-status.ts 官方暴露的受控出口 `reviveTask`(protocol-agent-v3 §5.2"接续
 * 例外")——状态机模块自己承载这条例外,harness 只是调用方。
 *
 * task 尚未终态时分两种情况:已经是 running 的(如台账的终态回调还没追上 adapter 的真实
 * 状态,接续发生前 task.status 本就还是 running)不需要任何迁移,直接原样返回(此时按
 * task-status.ts 维护的不变量,completed_at/error 本就已经是未设置状态,无需重置);
 * 其余非终态(queued/waiting_input)走 applyStatusTransition 的正常校验路径迁到 running。
 */
function reopenTaskForContinuation(task: LedgerWorker['task'], now: string): LedgerWorker['task'] {
  if (task.status === 'running') return task
  if (isTerminalStatus(task.status)) return reviveTask(task, { now })
  return applyStatusTransition(task, 'running', { now })
}

/**
 * reconcileOnStartup 专用:把 task 状态迁移到目标状态,目标不可从当前状态一步直达时先跳一步
 * running。VALID_TRANSITIONS 里 `queued` 只有到 `running`/`cancelled` 的边,没有到
 * `waiting_input`/`failed` 的直达边——但巡检可能在极窄的竞态窗口里撞见"task.status 仍是
 * queued、主线化身却已经真实 running/idle/判死"的台账(spawnWorker 落初始记录与落
 * spawn 成功后的第二次提交之间若进程崩溃,见 harness.ts 顶部锁纪律注释),此时直接
 * applyStatusTransition 会抛 InvalidTaskTransitionError。这里镜像 spawnWorker 失败路径
 * 已经用过的"queued→running→失败/目标状态"两跳写法,不新增状态机边、不绕开 canTransition
 * 校验(仍然全程只用 applyStatusTransition,只是必要时多套一层)。
 */
function transitionTaskTo(
  task: LedgerWorker['task'],
  to: TaskStatus,
  opts: { error?: string; now: string }
): LedgerWorker['task'] {
  if (canTransition(task.status, to)) {
    return applyStatusTransition(task, to, opts)
  }
  const hopped = applyStatusTransition(task, 'running', { now: opts.now })
  return applyStatusTransition(hopped, to, opts)
}

// re-export for callers that only import from harness.ts
export type { HarnessEvent, HarnessEventKind } from './worker-events'
export type { InboxItem } from './inbox'
