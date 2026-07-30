/**
 * worker 工具集 —— manager 唯一的 worker 编排入口(protocol-agent-v3 §4.1/§4.3/§5.5)。
 *
 * 六个工具全部是 `WorkerHarness`(P3 已合并,本模块只调用、不修改)既有方法的薄封装:只负责
 * 1) 组装 harness 方法的入参(`spawn_worker` 据 `deps.context()` 填 `origin`/`report_to`);
 * 2) 把 harness 的返回值/异常转成 engine `ToolCallResult`——**异常永不穿透**成 engine 层错误,
 *    统一转成 `isError: true` 的可读文本,manager 能读到失败原因并自行决策(如 worker 不存在
 *    就换个 id 或重新 spawn,protocol-agent-v3 §4.3)。
 *
 * ---
 *
 * ## 同步性语义的实现取舍(protocol §4.1"等待 = end_turn")
 *
 * 协议表(§4.3)把 `spawn_worker`/`send_to_worker`/`query_worker` 标"异步",
 * `read_worker_output`/`list_workers`/`kill_worker` 标"同步"。但 `WorkerHarness` 对应的六个
 * 方法都各自返回一个不可拆分的 Promise——`spawnWorker` 内部顺序 await 了 workspace 解析、
 * 台账初始写入、`adapter.provision`、`adapter.spawn`;`sendToWorker` 顺序 await 了入信箱与
 * `inbox.flush`(经 `adapter.sendInput`,命中终态化身时还会走一整套 kill+provision+spawn 的
 * 透明接续);`queryWorker` 顺序 await 了 `adapter.fork` 与台账写入——三者都不是"发个信号就
 * 立刻返回"的轻量调用,而是"编排动作完整落地"才 resolve。
 *
 * 若把这三个工具做成字面意义的 JS fire-and-forget(调用后不 await、立即返回,类似
 * `harness.spawnWorker(p).catch(...)`),会丢失两样东西:
 * 1. `spawn_worker`/`query_worker` 依赖 harness 内部生成的标识符(`worker_id`/`forkSeq`)
 *    供 LLM 后续引用这次操作的产物——不 await 就拿不到这两个值,工具形同废掉;
 * 2. `WorkerNotFoundError`/`TaskCancelledError`/`ImplAlreadyUsedError` 一类的失败原因就没有
 *    办法在这次调用内回传给 LLM,直接违反"manager 应能读到失败原因并自行决策"这条明确要求
 *    (task-4-brief.md)。
 *
 * 因此六个工具在实现上都完整 `await` 对应的 harness 方法,把结果/异常同步转成 tool_result。
 * 这与协议"异步"的语义并不冲突:harness 这些方法本身只等到"这次编排动作完成"为止(spawn
 * 命令已发出且化身已 running、消息已经送进 worker 的信箱/tmux、侧问已经 fork 出新化身),
 * **不会**进一步阻塞等待 worker 自己执行任务、产出真正的回复——那部分永远经由 harness 的
 * `onEvent`/`onStateChange` 在这次调用之外异步发生(idle/exited/query 结果作为事件唤醒
 * manager,是 P4 唤醒机制的职责,不在本工具集范围内)。换句话说:我们等的是一次有限时长的
 * "发起"动作,不是等 worker 把活干完,因此完整 await 并不违反"manager 的 loop 内不存在阻塞
 * 等待原语"这条约束。三个"异步"工具的输出因此刻意写得简短(确认式:status + 关键标识符),
 * 提示 LLM 后续进展会由事件唤醒——这是协议"异步"语义在响应内容上的体现,不代表调用本身没有
 * 等待 harness 落地。
 *
 * 这是一处偏离最初"是否该用字面 fire-and-forget"设想的实现取舍,原因见上;若未来 harness
 * 提供了"仅等发起、不等落地"的拆分入口,应优先切换过去。
 *
 * ## isReadOnly
 *
 * 只有 `read_worker_output`/`list_workers` 标 `isReadOnly: true`(供 engine 并行调度只读工具,
 * `partitionToolCalls`)。`kill_worker` 虽然同步返回,但会改变 worker/task 状态,不是只读。
 *
 * @see crabot-docs/protocols/protocol-agent-v3.md §4.1、§4.3、§5.5
 */

import { defineTool } from '../../engine/index.js'
import type { ToolDefinition, ToolCallResult } from '../../engine/index.js'
import type { WorkerHarness } from '../../workers/harness/harness'
import type { DialogObjectId, ManagerKey, LedgerWorker } from '../../workers/harness/ledger-types'
import type { WorkerImplId } from '../../workers/types'

export interface WorkerToolsContext {
  /** 本次唤醒所属对话对象:决定 spawn 的台账归属与 `list_workers` 的查询范围。 */
  readonly dialogObjectId: DialogObjectId
  /** 当前 manager 实例键:填入 `origin.spawned_by_session`。 */
  readonly managerKey: ManagerKey
  /** 当前 episode 的 trace id(可跳转);填入 `origin.spawned_by_episode`。 */
  readonly episodeId?: string
  /** 权限身份:以谁的名义派发这个 worker;填入 `origin.creator_friend_id`。 */
  readonly creatorFriendId?: string
  /** 结果回报目标,默认 = 当前 session(protocol-agent-v3 §3)。 */
  readonly reportTo: { channel_id: string; session_id: string }
}

export interface WorkerToolsDeps {
  readonly harness: WorkerHarness
  /** 当前 manager 的归属:决定 spawn 的 dialogObjectId / origin / report_to。 */
  readonly context: () => WorkerToolsContext
}

// --- tool_result 构造辅助 ---

function ok(data: unknown): ToolCallResult {
  return { output: JSON.stringify(data), isError: false }
}

function invalid(message: string): ToolCallResult {
  return { output: message, isError: true }
}

/**
 * 把 harness 抛出的异常(`WorkerNotFoundError`/`TaskCancelledError`/`ImplAlreadyUsedError`
 * 及其它未预期异常)转成对 LLM 友好的 `tool_result` 文本——异常永不穿透成 engine 层错误。
 * 三种已知错误类本身的 message 已经足够可读(见 harness.ts 的构造函数),不需要按类型
 * 再各写一套文案;这里统一处理即可。同时 `console.error` 留一份诊断痕迹(harness 内部对
 * 自己台账/化身状态变化的失败已经有独立的事件流,这里补的是"这次工具调用本身失败了"这层,
 * 二者互补,不是重复)。
 */
function mapError(prefix: string, error: unknown): ToolCallResult {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[worker-tools] ${prefix} failed:`, error)
  return { output: `${prefix} 失败: ${message}`, isError: true }
}

const WORKER_IMPL_IDS: readonly WorkerImplId[] = ['builtin', 'claude-code', 'codex']

function isWorkerImplId(value: unknown): value is WorkerImplId {
  return typeof value === 'string' && (WORKER_IMPL_IDS as readonly string[]).includes(value)
}

export function buildWorkerTools(deps: WorkerToolsDeps): ToolDefinition[] {
  const { harness, context } = deps

  // --- spawn_worker(异步:发起即返回,任务进展由事件唤醒) ---
  const spawnWorker = defineTool({
    name: 'spawn_worker',
    description:
      '派发一个新的 worker 去执行一项任务。异步语义:本工具在 worker 化身创建完成后即返回' +
      '(不等 worker 把任务做完),返回 worker_id;worker 的后续状态变化(idle/exited)会作为' +
      '事件唤醒你,不需要主动轮询。impl 缺省按部署偏好选择;workspace 缺省新建;goal 仅对' +
      'builtin 实现生效。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题(简短)' },
        prompt: { type: 'string', description: '交给 worker 的任务描述/初始输入' },
        impl: { type: 'string', enum: WORKER_IMPL_IDS as unknown as string[], description: 'worker 实现,缺省按部署偏好' },
        workspace: { type: 'string', description: '复用的 workspace 路径,缺省新建一个' },
        goal: { type: 'string', description: '目标态描述,仅 builtin 实现使用' },
      },
      required: ['title', 'prompt'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      const { title, prompt, impl, workspace, goal } = input as {
        title?: string
        prompt?: string
        impl?: string
        workspace?: string
        goal?: string
      }
      if (!title || typeof title !== 'string') return invalid('spawn_worker: title 必填且为字符串')
      if (!prompt || typeof prompt !== 'string') return invalid('spawn_worker: prompt 必填且为字符串')
      if (impl !== undefined && !isWorkerImplId(impl)) {
        return invalid(`spawn_worker: impl 取值非法 '${impl}',合法值: ${WORKER_IMPL_IDS.join('/')}`)
      }

      const ctx = context()
      try {
        const worker: LedgerWorker = await harness.spawnWorker({
          dialogObjectId: ctx.dialogObjectId,
          title,
          prompt,
          origin: {
            spawned_by_session: ctx.managerKey,
            spawned_by_episode: ctx.episodeId,
            creator_friend_id: ctx.creatorFriendId,
            // 协议未给出更细的来源信号(deps.context() 不携带),这里按最常见场景填 'message';
            // 'scheduled'/'system' 场景需要 context() 补充触发来源才能精确区分,超出本任务范围。
            trigger_type: 'message',
          },
          report_to: ctx.reportTo,
          impl,
          workspace,
          goal,
        })
        return ok({ status: 'spawned', worker_id: worker.worker_id, impl: worker.incarnations[0]?.impl })
      } catch (error) {
        return mapError('spawn_worker', error)
      }
    },
  })

  // --- send_to_worker(异步:投递即返回,worker 的回应由事件唤醒) ---
  const sendToWorker = defineTool({
    name: 'send_to_worker',
    description:
      '向指定 worker 的信箱投递一条输入。异步语义:本工具在消息送达(或触发透明接续)后即' +
      '返回,不等 worker 处理完这条消息;worker 后续的状态变化会作为事件唤醒你。命中已' +
      'cancelled 的任务会被拒绝。raw=true 用于向卡住的交互式界面原样敲键,不是普通对话消息。',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker id' },
        text: { type: 'string', description: '要投递的文本' },
        raw: { type: 'boolean', description: '原样敲键(驱动卡住的交互界面专用),缺省 false' },
      },
      required: ['worker_id', 'text'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      const { worker_id, text, raw } = input as { worker_id?: string; text?: string; raw?: boolean }
      if (!worker_id || typeof worker_id !== 'string') return invalid('send_to_worker: worker_id 必填且为字符串')
      if (typeof text !== 'string' || text.length === 0) return invalid('send_to_worker: text 必填且为非空字符串')

      try {
        await harness.sendToWorker(worker_id, text, raw !== undefined ? { raw } : undefined)
        return ok({ status: 'sent', worker_id })
      } catch (error) {
        return mapError(`send_to_worker(${worker_id})`, error)
      }
    },
  })

  // --- query_worker(异步:侧问发起即返回,答案由事件唤醒) ---
  const queryWorker = defineTool({
    name: 'query_worker',
    description:
      '对正在跑的 worker 发起一次侧问(fork 语义),不打扰主线执行。异步语义:本工具在侧问' +
      '化身创建完成后即返回,不等答案;答案就绪会作为事件唤醒你,届时用 read_worker_output' +
      '(带返回的 fork_seq 所在化身)读取。目标实现需支持 fork 能力,否则会失败。',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker id' },
        question: { type: 'string', description: '侧问的问题内容' },
      },
      required: ['worker_id', 'question'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      const { worker_id, question } = input as { worker_id?: string; question?: string }
      if (!worker_id || typeof worker_id !== 'string') return invalid('query_worker: worker_id 必填且为字符串')
      if (!question || typeof question !== 'string') return invalid('query_worker: question 必填且为字符串')

      try {
        const { forkSeq } = await harness.queryWorker(worker_id, question)
        return ok({ status: 'queried', worker_id, fork_seq: forkSeq })
      } catch (error) {
        return mapError(`query_worker(${worker_id})`, error)
      }
    },
  })

  // --- read_worker_output(同步:真实增量输出) ---
  const readWorkerOutput = defineTool({
    name: 'read_worker_output',
    description:
      '同步读取 worker 主线化身的增量输出(从 offset 开始,byte-cap 截断,全文另落盘留路径)。' +
      '首次调用 offset 传 0,之后用上次返回的 next_offset 续读。',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker id' },
        offset: { type: 'number', description: '读取起点(上次返回的 next_offset),缺省 0' },
      },
      required: ['worker_id'],
    },
    isReadOnly: true,
    call: async (input): Promise<ToolCallResult> => {
      const { worker_id, offset } = input as { worker_id?: string; offset?: number }
      if (!worker_id || typeof worker_id !== 'string') return invalid('read_worker_output: worker_id 必填且为字符串')

      try {
        const { chunk, nextCursor } = await harness.readWorkerOutput(worker_id, { offset: offset ?? 0 })
        return ok({ worker_id, chunk, next_offset: nextCursor.offset })
      } catch (error) {
        return mapError(`read_worker_output(${worker_id})`, error)
      }
    },
  })

  // --- list_workers(同步:本对话对象全量台账) ---
  const listWorkers = defineTool({
    name: 'list_workers',
    description:
      '同步列出当前对话对象名下的全部 worker(含其它 session 派发到同一对话对象的条目):' +
      'worker_id、任务状态、化身链等台账信息。',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    call: async (): Promise<ToolCallResult> => {
      try {
        const workers = await harness.listWorkers(context().dialogObjectId)
        return ok({ workers })
      } catch (error) {
        return mapError('list_workers', error)
      }
    },
  })

  // --- kill_worker(同步:终止当前化身,幂等) ---
  const killWorker = defineTool({
    name: 'kill_worker',
    description:
      '终止 worker 当前主线化身,task 状态转为 cancelled。对已是终态的 worker 幂等(不重复' +
      '操作、不报错)。reason 可选,会记入事件留痕。',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string', description: '目标 worker id' },
        reason: { type: 'string', description: '终止原因,可选' },
      },
      required: ['worker_id'],
    },
    isReadOnly: false,
    call: async (input): Promise<ToolCallResult> => {
      const { worker_id, reason } = input as { worker_id?: string; reason?: string }
      if (!worker_id || typeof worker_id !== 'string') return invalid('kill_worker: worker_id 必填且为字符串')

      try {
        await harness.killWorker(worker_id, reason)
        return ok({ status: 'killed', worker_id })
      } catch (error) {
        return mapError(`kill_worker(${worker_id})`, error)
      }
    },
  })

  return [spawnWorker, sendToWorker, queryWorker, readWorkerOutput, listWorkers, killWorker]
}
