/**
 * BuiltinWorkerAdapter — worker 契约的 builtin 实现（P1：spawn + burst 状态机 + sendInput/resume）。
 *
 * 运行配置（LLM adapter / model / systemPrompt / tools）不是 adapter 自己造的，也不吃 spawn
 * 那一刻的快照：**每次起化身（spawn / resume / fork / idle→running 续 burst）都调注入工厂
 * 现取一次**（deps.resolveRuntime，spec 2026-08-01 决策 2）。per-worker 上下文（workspace /
 * origin / goal）在 spawn 时落 <dataDir>/<worker_id>/context.json，工厂据此重建运行配置——
 * 进程重启后 builtin worker 因此仍能 revive，而 LLM 连接信息始终不落盘。正在跑的 burst 用的
 * 是它启动时那一份，改配置只影响下一次起化身（与 cc/codex 的语义对齐）。
 *
 * worker 的工作目录就是它的 workspace，不可中途切换：工具集里不给 `set_cwd`，也不给 goal
 * 相关工具（决策 3/4），guardTools 在每轮 resolve 时硬断言。runEngine 每次都带上
 * hookRegistry（CLI 权限闸 / skill 目录 fence / git 写 fence）与固定权限档位（决策 6）。
 *
 * 每个 worker 落 <dataDir>/<worker_id>/session.jsonl（跨化身共享的 session 树）+
 * 每个化身独立的 output-<seq>.log / meta-<seq>.json。spawn 建目录、把 prompt 作为根
 * 节点 append 进 session 树、fire-and-forget 起一个 "burst"（一次 runEngine 调用），
 * 随即以 running 态返回。burst 结束后按 engine outcome / exitToolCall 迁移到 idle 或
 * exited，meta-<seq>.json 原子写。
 *
 * sendInput：idle 态追加新一轮用户消息并续 burst；running 态进入本化身的待注入队列，
 * 当前 burst 结束若判定为 idle 且队列非空则原地续 burst（不经过可见的 idle 态）；
 * exited 态抛 WorkerExitedError，交给上层 harness 做透明接续（P3）。
 *
 * resume：从已 exited 的化身的 session_ref（tip node_id）派生新化身（seq 见 nextSeq），
 * append wakeInput 后起新 burst。
 *
 * fork：侧问分支。不要求 prev 处于任何特定状态——主线 running/idle/exited 都能 fork。
 * 从 prev.session_ref 节点 append forkInput 为分支（不动主线 tip，树因此分叉，这是
 * fork 的合法用法）。新化身独立 meta/output，跑一次性 burst（不含 finish_task 工具，
 * 结束即 exited，没有 idle 态）。newSeq 与 resume 共用 nextSeq()，在同一把互斥锁内
 * 计算，避免二者撞号。
 *
 * kill：每化身持有一个 AbortController，burst 启动时创建、其 signal 传给 runEngine。
 * running 态 kill 在互斥锁内先置 instance.killRequested = true，再 abort() 当前 burst——
 * 单纯 abort 不够：sendInput(idle→running) 转态后到续 burst 安装新 controller 之间、以及
 * runBurst 续 burst 路径锁释放到递归调用之间都有窗口，其间 instance.abortController 还
 * 指向旧 burst，abort 旧 controller 对即将起的新 burst 无效。runBurst/runForkBurst 因此
 * 在安装新 controller 时、以及收尾段判定是否续 burst/正常收尾前，各在锁内核对一次
 * killRequested：已置位则不启动/不续 burst，直接落 exited(killed)，与 kill() 的置位+abort
 * 共享同一把锁，消除上述窗口。burst 正常被 abort 命中时仍以 outcome='aborted' 收尾落
 * exited(killed)（见 runBurst/runForkBurst 收尾段）；idle 态（没有 burst 在跑）kill 直接
 * 在互斥锁内落 exited(killed)；已 exited 幂等返回，不覆盖原 ended_reason。
 *
 * scanOrphans：进程重启后，内存 instances 已丢失，只能凭磁盘 meta 文件识别"重启前还
 * 没来得及收尾的化身"——把 state==='running' 的原子改写为 exited(crashed)。调用方须
 * 在本进程任何 adapter 实例开始活动前调用一次，之后的 spawn/resume/fork 才读到一致
 * 的磁盘状态。
 */
import { promises as fs } from 'fs'
import { assertInputDeliveryActive } from '../input-delivery-control.js'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { runEngine, defineTool, createUserMessage } from '../../engine/index.js'
import type { EngineMessage, EngineResult, ToolDefinition } from '../../engine/index.js'
import type { Resolvable } from '../../engine/types.js'
import { SessionTree } from '../session-tree.js'
import { OutputLog } from '../output-log.js'
import { AsyncMutex } from '../async-mutex.js'
import { latestModifiedMs } from '../meta-store.js'
import { WorkerExitedError, ForkEstablishmentError } from '../errors.js'
import {
  BUILTIN_WORKER_PERMISSIONS,
  FORBIDDEN_WORKER_TOOLS,
  createBuiltinWorkerHookRegistry,
  type BuiltinRuntimeContext,
  type BuiltinRuntimeFactory,
} from './runtime.js'
import type { HookRegistry } from '../../hooks/hook-registry.js'
import type { ToolPermissionConfig } from '../../engine/types.js'
import type {
  AdapterCapabilities,
  CapabilityBundle,
  DetectResult,
  IncarnationHandle,
  IncarnationRef,
  ForkOptions,
  IncarnationEndReason,
  StateChangeReport,
  SpawnSpec,
  SendInputOptions,
  WorkerAdapter,
  WorkerContractState,
  Workspace,
  WorkerTerminalView,
} from '../types.js'
import { classifySupervisionActivity } from '../types.js'
import type { SupervisionObservation } from '../types.js'

/** fork 是一次性侧问，maxTurns 取小值，避免侧问跑成一次完整任务。 */
const FORK_MAX_TURNS = 8

/** spawn 时落盘的 per-worker 上下文文件名（见 persistContext）。 */
const CONTEXT_FILE = 'context.json'

/** 上下文超限收场时写进 output.log 的信号（见 isSilentContextOverflow）。 */
const CONTEXT_OVERFLOW_NOTICE =
  '[builtin-worker] 上下文超限：压缩已用尽，模型仍只能返回空回复（stop_reason=max_tokens）。本化身以 failed 收场。\n'

/**
 * 识别"burst 因上下文超限静默收场"。engine 侧的真实表征（读 query-loop.ts 确认，不是猜的）：
 * 压缩重试配额（MAX_MAX_TOKENS_COMPACT_RETRIES=2）耗尽后，engine 对静默 max_tokens 直接
 * `finishTask()` 收场——outcome 变成 `'completed'`（不是 `'failed'`/`'max_turns'`！）、
 * `finalText=''`，唯一留下的痕迹是 `finalMessages` 末条 assistant 消息的
 * `stopReason === 'max_tokens'`。这是结构化信号，比在 `EngineResult.error` 里找文案更可靠
 * （这条路径下 error 根本不会被设置）。
 *
 * adapter 若照常落 `idle`，worker 就变成一个"看起来在等输入"的化身：零输出、零错误信号。
 * manager 看到 idle 会按"停下且没带问题"继续 `send_to_worker` 推它，**每推一次烧一个满窗口
 * 调用**，且上下文只增不减 —— 死循环。所以必须落成 `exited(failed)`。
 *
 * "静默"这个前提本身必须校验，不能只看 stopReason：LLM 输出被 max output tokens 截断
 * （有实际文字，只是没写完）时 stopReason 同样是 `'max_tokens'`，但 query-loop 的
 * `isSilentText`（`processed.text.trim().length === 0`）判它为非静默，走正常 end_turn 分支
 * completed 收场——与上下文超限无关。这里对齐同一判定：只统计末条 assistant 消息里的 text 块
 * （忽略 tool_use/raw_reasoning，与 partitionResponseContent 一致），trim 后为空才算静默。
 *
 * 判定与 `manager/loop.ts` 的 `isContextOverflow` 分支 1 同源（P4 在 manager 上踩的是同一个坑，
 * 那段注释是这条判定的原始考据）。这里没有直接 import 复用，两个原因：
 *   1. 那是 manager loop 的模块私有函数，worker 反向依赖 manager 是跨模块方向错误；
 *   2. 抽到 engine 公共层属于 engine 改动，超出本次"只动 builtin adapter"的修 bug 范围。
 * manager 那份还有"分支 2：outcome==='failed' 且 error 文案含超限关键字"，这里不需要——
 * builtin adapter 对 `outcome === 'failed'` 一律落 `exited(crashed)`，本就是 fail-loud 的终态。
 */
function isSilentContextOverflow(result: EngineResult): boolean {
  const last = result.finalMessages[result.finalMessages.length - 1]
  if (last?.role !== 'assistant' || last.stopReason !== 'max_tokens') return false
  const text = last.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return text.trim().length === 0
}

/** Re-export for backward compatibility and convenience. */
export { WorkerExitedError }

const FINISH_TASK_TOOL: ToolDefinition = {
  ...defineTool({
    name: 'finish_task',
    description: '结束当前 burst：任务完成或确认失败时调用，附一句话总结。',
    isReadOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['completed', 'failed'], description: '任务终态' },
        summary: { type: 'string', description: '一句话总结' },
      },
      required: ['outcome', 'summary'],
    },
    // exitsLoop=true 时引擎不会真的执行 call，直接把 input 写进 EngineResult.exitToolCall。
    call: async () => ({ output: '', isError: false }),
  }),
  exitsLoop: true,
}

interface WorkerInstance {
  readonly worker_id: string
  readonly seq: number
  readonly dir: string
  readonly sessionTree: SessionTree
  readonly outputLog: OutputLog
  /**
   * 本化身自己的当前 tip node_id（不是 sessionTree.latestTip()）。sessionTree 是跨化身
   * 共享的同一个对象，其内部 tip 是"整个文件最后一次 append"的全局游标——fork 分支往
   * 任意历史节点 append 时会把这个全局游标带偏。若主线继续依赖 sessionTree.latestTip()
   * 判断自己的续接点，fork 期间/之后会读到 fork 分支的节点，把新一轮消息误挂在 fork
   * 分支下面。每个化身必须维护自己的 tip，只在自己 append 时更新。
   */
  tip: string
  /** 最近一次真实 engine 进展;不使用定时心跳,避免把挂死调用伪装为健康。 */
  activityAt: number
  /** 本化身的 TraceStore trace 引用（P6-A §8.4；meta-<seq>.json 的 trace_id 同源）。 */
  traceId?: string
  state: WorkerContractState
  ended_reason?: IncarnationEndReason
  outcome?: 'completed' | 'failed'
  /** running 态下经 sendInput 排队、等下一次 burst 间隙统一 append 的用户消息（P1：内存，不跨重启持久）。 */
  pendingInputs: string[]
  /** 是否已经被 resume 过一次。用于在 resume() 里检测"对同一 prev 的重复 resume"（先到先得，后来者报错）。 */
  resumed?: boolean
  /**
   * 当前（或最近一次）burst 的 AbortController，在 runBurst/runForkBurst 每次调用 runEngine
   * 前创建，其 signal 传给 runEngine。kill() 在 running 态下 abort() 它——不直接改状态，
   * 状态迁移仍由 burst 自己收尾时的 outcome==='aborted' 分流完成。
   */
  abortController?: AbortController
  /**
   * kill() 在 running 态下于互斥锁内置位，一旦置位永不复位（化身终将落 exited）。
   * runBurst/runForkBurst 在安装新 controller 时、以及收尾段判定是否续 burst/正常收尾前，
   * 各在同一把锁内核对它——用于兜住 abortController 指向旧 burst 而 abort 落空的窗口
   * （见 kill() 顶部注释）。
   */
  killRequested?: boolean
}

function instanceKey(worker_id: string, seq: number): string {
  return `${worker_id}#${seq}`
}

function resolve<T>(value: Resolvable<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/**
 * builtin 结构化 trace 钩子（P6-A §8.4）：由装配层（unified-agent）用 TraceStore + 脱敏实现。
 * 每个化身一条 trace（`builtin-<worker_id>-<seq>` 语义引用持久化在 meta-<seq>.json 的
 * `trace_id` 字段——不按 task ID 猜、不靠内存）。
 */
export interface BuiltinTraceHooks {
  startIncarnationTrace(params: { worker_id: string; seq: number; summary: string }): string
  appendTurn(traceId: string, event: import('../../engine/types.js').EngineTurnEvent): void
  finishIncarnationTrace(traceId: string, patch: { status: 'completed' | 'failed'; summary: string }): void
}

export interface BuiltinTraceReader {
  readTrace(traceId: string): Promise<import('../../types.js').AgentTrace | undefined>
}


export class BuiltinWorkerAdapter implements WorkerAdapter {
  readonly implId = 'builtin' as const

  private readonly instances = new Map<string, WorkerInstance>()
  /**
   * worker_id → spawn 时注入的 builtin 执行配置（adapter/model/tools）。
   *
   * **仅在没有配置 `deps.resolveRuntime` 时才被当作运行配置来源**（契约套件 / 单测这类
   * 直接把 `spec.builtin` 塞进来的调用方）。配置了工厂时，起化身一律现取（见 runtimeFor），
   * 这张表只剩两个作用：spawn 的"已 spawn"守卫记忆，以及无工厂时的兜底。
   */
  private readonly builtinConfigs = new Map<string, NonNullable<SpawnSpec['builtin']>>()
  /** worker_id → spawn 时的 per-worker 上下文（workspace/origin/goal）。内存缓存，权威副本在 context.json。 */
  private readonly spawnContexts = new Map<string, BuiltinRuntimeContext>()
  /** 每个 adapter 实例一份 hook 注册表（无状态，可跨 worker / burst 共用）。 */
  private readonly hookRegistry: HookRegistry = createBuiltinWorkerHookRegistry()
  /**
   * worker_id → 互斥锁，惰性创建。sendInput 全程、resume 全程、runBurst 的收尾段（判定
   * pendingInputs 到状态落定）都在同一把锁内串行执行——同一化身任意时刻至多一个 burst
   * 在跑是该 adapter 的不变量。runEngine 本身的调用留在锁外，避免并发 sendInput(running)
   * 的入队被一整次 burst 的执行时长堵死。
   */
  private readonly workerMutexes = new Map<string, AsyncMutex>()
  private readonly activeRuns = new Set<Promise<void>>()
  private closing = false
  private disposePromise?: Promise<void>

  constructor(
    private readonly deps: {
      readonly dataDir: string
      /** P6-A §8.4：结构化 trace 写钩子；缺省时 trace 面静默关闭。 */
      readonly traceHooks?: BuiltinTraceHooks
      /** P6-A §8.4：readTrace 读取入口（TraceStore 窄口）。 */
      readonly traceReader?: BuiltinTraceReader
      /**
       * `report.lastText`：本次状态转换所在**轮次边界**上，worker 最后说的那段
       * assistant 文字。harness 会把它（截断后）塞进唤醒事件的 detail，manager 因此醒来
       * 就知道 worker 说了什么。
       * 只有 builtin 传：它的输出天然只有 assistant text（`partitionResponseContent` 只取
       * `type==='text'`，工具调用/结果一个字节都不进），符合"只要 text 不要 tool use"。
       * cc/codex 刻意不传，理由见各自 adapter 的 transitionState 注释。
       *
       * `report.endReason`：本次转换若是 `exited`，就是 `transitionExited` 拿到的那个
       * **必填**的 `ended_reason`。builtin 的它是确证（`finish_task(outcome)` 结构化上报 /
       * engine result / kill 标记），harness 直接据此落台账；不报的话这个真值就在回调
       * 这一跳被丢掉，harness 只能猜（协议 §6.3）。非 exited 转换不报。
       */
      readonly onStateChange?: (h: IncarnationHandle, state: WorkerContractState, report?: StateChangeReport) => void
      /**
       * 运行配置工厂：**每次起化身现取一次**（spec 决策 2）。spawn 的那次由调用方
       * （harness.spawnWorker / handoffIncarnation）调同一个工厂后放进 `spec.builtin`；
       * resume / fork / idle→running 续 burst 没有 spec 可依，由 adapter 自己调它——
       * 不再吃 spawn 那一刻的快照。
       * 因此：(1) 进程重启后 builtin worker 仍能 revive（工厂挂在装配层，重启后还在；
       * per-worker 上下文从 context.json 读回）；(2) 改了 model slot 下次起化身生效，正在跑的
       * burst 用旧的；(3) LLM 连接信息不落盘。不配置时退化为 P1 行为（吃 spawn 时的内存快照，
       * 跨重启不可用），供契约套件与单测使用。
       */
      readonly resolveRuntime?: BuiltinRuntimeFactory
    },
  ) {}

  async detect(): Promise<DetectResult> {
    return { installed: true, activated: true }
  }

  async provision(_ws: Workspace, _caps: CapabilityBundle): Promise<void> {
    this.assertActive()
    // P1 空实现：builtin 走现有下发通道，无需单独 provision。
  }

  async spawn(spec: SpawnSpec): Promise<IncarnationHandle> {
    this.assertActive()
    // per-worker 上下文：spawn 是它唯一的来源，后续所有化身（resume/fork/续 burst，含进程
    // 重启之后）都从这里回喂给运行配置工厂。workspace 就是 worker 的工作目录，落盘之后
    // 不再改变——worker 不可中途切 cwd（spec 决策 3，工具集里也不给 set_cwd，见 guardTools）。
    const context: BuiltinRuntimeContext = {
      worker_id: spec.worker_id,
      workspace: spec.workspace,
      ...(spec.origin !== undefined ? { origin: spec.origin } : {}),
      ...(spec.goal !== undefined ? { goal: spec.goal } : {}),
      // 权限档位跟着一起落盘:它是这个 worker 的身份属性,spawn 时定死。后续所有化身
      // (resume/fork/续 burst/重启 revive)经 runtimeFor 从这里读回同一份,绝不重新解析
      // ——重新解析就会随"该会话最近说话的人"漂移(见该字段注释)。
      ...(spec.principal_permissions !== undefined ? { principal_permissions: spec.principal_permissions } : {}),
    }
    // spawn 的注入由调用方给（harness.spawnWorker 在缺省时回退到同一个工厂）——这里不再兜
    // 一次：两处回退会互相掩盖，缺了 harness 那条回退也看不出问题。缺失即 fail-loud，不降级。
    if (!spec.builtin) {
      throw new Error(`BuiltinWorkerAdapter.spawn: spec.builtin missing for worker ${spec.worker_id}`)
    }
    const builtin = spec.builtin

    // 守卫（三重 fail-fast 检查）到提交（writeMeta→instances.set→builtinConfigs.set）整体
    // 在该 worker 的互斥锁内原子完成，与 resume/fork 对齐：不然两次并发 spawn 同一
    // worker_id 会双双穿过守卫（builtinConfigs/instances 命中检查、磁盘 meta-1.json 检查
    // 之间隔着多个 await），各自建根节点、各自 writeMeta、各自注册，产出双根节点、meta
    // 互相覆盖、两个 burst 各持不同 abortController 交错写同一 output/meta。锁内排队后，
    // 后到的那次会命中"已 spawn"守卫被拒——先到先得，语义与 resume 的重复检测一致。
    const mutex = this.getMutex(spec.worker_id)
    const { instance, handle } = await mutex.run(async () => {
      // fail-fast：拒绝对同一个 worker_id 重复 spawn。builtinConfigs/instances 命中说明本
      // 进程已经 spawn 过；磁盘已有 meta-1.json 覆盖跨进程场景（上一进程 spawn 过、本进程
      // 刚启动，内存态是空的但磁盘还留着旧化身）。不拦住的话，重复 spawn 会把新的根节点
      // append 进同一个 session.jsonl，跟旧化身的节点混进一棵树，是脏数据源头。
      if (this.builtinConfigs.has(spec.worker_id) || this.findSessionTreeForWorker(spec.worker_id)) {
        throw new Error(`BuiltinWorkerAdapter.spawn: worker_id ${spec.worker_id} already spawned in this process`)
      }
      const seq = 1
      const dir = join(this.deps.dataDir, spec.worker_id)
      if (await fileExists(join(dir, `meta-${seq}.json`))) {
        throw new Error(`BuiltinWorkerAdapter.spawn: worker_id ${spec.worker_id} already has meta-${seq}.json on disk`)
      }
      await fs.mkdir(dir, { recursive: true })

      const sessionTree = new SessionTree(join(dir, 'session.jsonl'))
      const outputLog = new OutputLog(join(dir, `output-${seq}.log`))
      const rootId = await sessionTree.append(null, createUserMessage(spec.prompt))

      const newInstance: WorkerInstance = {
        worker_id: spec.worker_id,
        seq,
        dir,
        sessionTree,
        outputLog,
        tip: rootId,
        activityAt: Date.now(),
        state: 'running',
        pendingInputs: [],
      }

      const newHandle: IncarnationHandle = { worker_id: spec.worker_id, seq, impl: 'builtin', session_ref: rootId }
      // writeMeta 成功之后才注册到 instances/builtinConfigs，跟 resume 保持一致的提交次序：
      // 磁盘失败时不留孤儿实例。注意此时上面的"已 spawn"三重守卫（builtinConfigs 命中 /
      // instances 命中 / 磁盘 meta-${seq}.json 存在）全部落空——writeMeta 还没成功过，没有
      // 一个会命中。调用方重试 spawn 因此不会被拦住，只会在 session.jsonl 里再 append 一个
      // 孤儿根节点（不被任何化身的 tip 引用，是良性的，不影响 pathTo）。
      // context.json 与 meta 一样在提交前落盘：resume/fork 起新化身（含跨进程重启）要靠它
      // 重建工厂 ctx，落盘失败就不该出现一个"已注册但事后起不了化身"的 worker。
      await this.persistContext(dir, context)
      await this.writeMeta(newInstance)
      this.instances.set(instanceKey(spec.worker_id, seq), newInstance)
      this.spawnContexts.set(spec.worker_id, context)
      this.builtinConfigs.set(spec.worker_id, builtin)
      return { instance: newInstance, handle: newHandle }
    })

    // fire-and-forget：burst 在后台跑，spawn 立刻以 running 态返回。留在锁外，不然会把
    // runEngine 的整个执行时长堵在锁里，挡住排队的其他 worker_id 无关操作。
    this.trackRun(this.runBurst(instance, handle, builtin), instance, handle, 'runBurst')

    return handle
  }

  async resume(prev: IncarnationRef, wakeInput: string, _opts?: { connection_env?: Record<string, string> }): Promise<IncarnationHandle> {
    this.assertActive()
    // 起化身 → 现取运行配置（spec 决策 2）。这条正是"进程重启后 builtin worker 能不能
    // revive"的分水岭：吃 spawn 时的内存快照时，重启后这里必然拿不到配置。
    const builtin = await this.runtimeFor(prev.worker_id, 'resume')

    // assertExited + 重复 resume 检测 + newSeq 计算 + append + 实例注册整体在锁内原子完成：
    // 两次并发 resume 同一 prev 若不串行化，会各自往 prev.session_ref 上挂一个孩子——树分叉。
    // 这里选择"先到先得，后来者报错"的语义：prevInstance.resumed 标记一旦被占用，后来者
    // 视为对同一 prev 的重复 resume，直接失败，而不是静默产出第二个化身。newSeq 用 nextSeq()
    // 而非 prev.seq+1——fork 可能已经消耗掉 prev.seq+1 这个号位（fork 分支和主线共享同一
    // seq 序列），继续用 prev.seq+1 会在这种情况下误判"并发 resume"或直接撞号覆盖。
    // resumed 标记必须在 writeMeta 成功之后才能提交，以确保失败路径幂等可重试：若 writeMeta
    // 抛错，resumed 仍未被设置，后续重试不会被"重复 resume"检查拒绝。instances.set 与
    // resumed 标记同时提交，整体在锁内原子完成。
    const mutex = this.getMutex(prev.worker_id)
    const { instance, handle } = await mutex.run(async () => {
      await this.assertExited(prev.worker_id, prev.seq)

      const prevInstance = this.instances.get(instanceKey(prev.worker_id, prev.seq))
      if (prevInstance?.resumed) {
        throw new Error(`BuiltinWorkerAdapter.resume: incarnation ${prev.worker_id}#${prev.seq} already resumed (concurrent resume of the same prev incarnation?)`)
      }

      const newSeq = await this.nextSeq(prev.worker_id)
      const dir = join(this.deps.dataDir, prev.worker_id)
      let sessionTree = this.findSessionTreeForWorker(prev.worker_id)
      if (!sessionTree) {
        sessionTree = await SessionTree.load(join(dir, 'session.jsonl'))
      }
      const outputLog = new OutputLog(join(dir, `output-${newSeq}.log`))
      const wakeId = await sessionTree.append(prev.session_ref, createUserMessage(wakeInput))

      const newInstance: WorkerInstance = {
        worker_id: prev.worker_id,
        seq: newSeq,
        dir,
        sessionTree,
        outputLog,
        tip: wakeId,
        activityAt: Date.now(),
        state: 'running',
        pendingInputs: [],
      }

      const newHandle: IncarnationHandle = { worker_id: prev.worker_id, seq: newSeq, impl: 'builtin', session_ref: wakeId }
      // writeMeta 成功之后才注册到 instances 并标记 resumed，确保磁盘失败时不留孤儿实例。
      await this.writeMeta(newInstance)
      this.instances.set(instanceKey(prev.worker_id, newSeq), newInstance)
      if (prevInstance) prevInstance.resumed = true
      return { instance: newInstance, handle: newHandle }
    })

    this.trackRun(this.runBurst(instance, handle, builtin), instance, handle, 'runBurst (resume)')

    return handle
  }

  async fork(prev: IncarnationRef, forkInput: string, opts: ForkOptions): Promise<IncarnationHandle> {
    this.assertActive()
    const assertEstablishmentActive = () => {
      if (Date.parse(opts.establishment_deadline_at) <= Date.now()) {
        throw new ForkEstablishmentError('timeout', 'fork establishment deadline expired', 'not_started')
      }
    }
    assertEstablishmentActive()
    // 同 resume：fork 也是起一个新化身，运行配置现取。
    const builtin = await this.runtimeFor(prev.worker_id, 'fork')

    // fork 不要求 prev 处于任何特定状态——这就是侧问的意义：主线跑着的时候也能问。不像
    // resume 那样校验 assertExited。newSeq 用 nextSeq()，与 resume 共用同一分配逻辑、
    // 在同一把互斥锁内计算，避免二者撞号。append 挂在 prev.session_ref 上是分支，不动
    // 主线 tip——session 树因此分叉，这是 fork 的合法用法（resume/sendInput 的"禁止分叉"
    // 不变量是它们各自场景下的语义，不适用于 fork）。
    const mutex = this.getMutex(prev.worker_id)
    const { instance, handle } = await mutex.run(async () => {
      assertEstablishmentActive()
      const dir = join(this.deps.dataDir, prev.worker_id)
      let sessionTree = this.findSessionTreeForWorker(prev.worker_id)
      if (!sessionTree) {
        sessionTree = await SessionTree.load(join(dir, 'session.jsonl'))
      }

      const newSeq = await this.nextSeq(prev.worker_id)
      const outputLog = new OutputLog(join(dir, `output-${newSeq}.log`))
      const forkId = await sessionTree.append(prev.session_ref, createUserMessage(forkInput))

      const newInstance: WorkerInstance = {
        worker_id: prev.worker_id,
        seq: newSeq,
        dir,
        sessionTree,
        outputLog,
        tip: forkId,
        activityAt: Date.now(),
        state: 'running',
        pendingInputs: [],
      }

      const newHandle: IncarnationHandle = {
        worker_id: prev.worker_id,
        seq: newSeq,
        impl: 'builtin',
        session_ref: forkId,
        query_id: opts.query_id,
      }
      // writeMeta 成功之后才注册到 instances，和 resume 保持一致的提交次序：磁盘失败时
      // 不留孤儿实例。
      await this.writeMeta(newInstance)
      this.instances.set(instanceKey(prev.worker_id, newSeq), newInstance)
      return { instance: newInstance, handle: newHandle }
    })

    // fire-and-forget：一次性 burst 在后台跑，fork 立刻以 running 态返回。
    this.trackRun(this.runForkBurst(instance, handle, builtin), instance, handle, 'runForkBurst')

    return handle
  }

  async sendInput(h: IncarnationHandle, text: string, opts?: SendInputOptions): Promise<void> {
    this.assertActive()
    // 状态检查 + 相应动作（入队 / append+转running）整体在该 worker 的互斥锁内完成，消除
    // "两次背靠背 sendInput 都读到 idle、拿同一 tip"的 check-then-act 竞态（跨 await 边界）。
    const mutex = this.getMutex(h.worker_id)
    const startBurst = await mutex.run(async () => {
      const instance = this.instances.get(instanceKey(h.worker_id, h.seq))
      if (!instance) {
        throw new Error(`BuiltinWorkerAdapter.sendInput: no such incarnation ${h.worker_id}#${h.seq} resident in this process`)
      }

      if (instance.state === 'exited') {
        // 带上 ended_reason:harness 的透明接续要用它给"台账还没追上"的源化身补终态。
        throw new WorkerExitedError(h.worker_id, h.seq, instance.ended_reason)
      }

      assertInputDeliveryActive(opts, 'not_delivered')

      if (instance.state === 'running') {
        instance.pendingInputs.push(text)
        instance.activityAt = Date.now()
        return undefined
      }

      // idle → 追加新一轮用户消息，转 running。起 burst 留到锁外（见下）。
      // 运行配置现取：idle 态下没有 burst 在跑，重新解析一次不会干扰任何正在执行的东西，
      // 语义与"起化身现取"一致（正在跑的 burst 用旧配置，见 runBurst 续 burst 路径）。
      const builtin = await this.runtimeFor(h.worker_id, 'sendInput')
      instance.tip = await instance.sessionTree.append(instance.tip, createUserMessage(text))
      await this.transitionState(instance, h, 'running')
      instance.activityAt = Date.now()
      return builtin
    })

    if (!startBurst) return

    // burst 的 runEngine 调用本身在锁外：否则并发 sendInput(running) 的入队会被这次
    // burst 的整个执行时长堵死。
    const instance = this.instances.get(instanceKey(h.worker_id, h.seq))!
    this.trackRun(this.runBurst(instance, h, startBurst), instance, h, 'runBurst (sendInput continuation)')
  }

  async readTerminal(h: IncarnationHandle): Promise<WorkerTerminalView> {
    const instance = this.instances.get(instanceKey(h.worker_id, h.seq))
    const outputLog = instance ? instance.outputLog : new OutputLog(join(this.deps.dataDir, h.worker_id, `output-${h.seq}.log`))
    const { chunk } = await outputLog.read({ offset: 0 })
    return chunk ? { kind: 'headless_text', text: chunk } : { kind: 'unavailable', unavailable_reason: 'headless_without_text' }
  }

  async lastActivityAt(h: IncarnationHandle): Promise<number | undefined> {
    const instance = this.instances.get(instanceKey(h.worker_id, h.seq))
    if (instance) return instance.activityAt
    return latestModifiedMs([join(this.deps.dataDir, h.worker_id, `meta-${h.seq}.json`)], `${h.worker_id}#${h.seq}`)
  }

  async state(h: IncarnationHandle): Promise<WorkerContractState> {
    const instance = this.instances.get(instanceKey(h.worker_id, h.seq))
    if (instance) return instance.state
    const metaPath = join(this.deps.dataDir, h.worker_id, `meta-${h.seq}.json`)
    const raw = await fs.readFile(metaPath, 'utf-8')
    const meta = JSON.parse(raw) as { state: WorkerContractState }
    return meta.state
  }

  /**
   * builtin 结构化 trace（P6-A §8.4）：从 TraceStore 读本化身的结构化事件，
   * trace 引用显式来自 meta-<seq>.json 的 trace_id（不按 task ID 猜）。
   * cursor.offset 是已消费 span 数。
   */
  async readTrace(h: IncarnationHandle, cursor?: import('../types.js').TraceCursor): Promise<{ events: import('../types.js').NormalizedTraceEvent[]; nextCursor: import('../types.js').TraceCursor }> {
    const { events, nextCursor } = await this.readTraceWindow(h, cursor)
    return { events, nextCursor }
  }

  private async readTraceWindow(
    h: IncarnationHandle,
    cursor?: import('../types.js').TraceCursor,
  ): Promise<{
    sourceAvailable: boolean
    spans: ReadonlyArray<import('../../types.js').AgentSpan>
    events: import('../types.js').NormalizedTraceEvent[]
    nextCursor: import('../types.js').TraceCursor
  }> {
    const metaPath = join(this.deps.dataDir, h.worker_id, `meta-${h.seq}.json`)
    let traceId: string | undefined
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as { trace_id?: string }
      traceId = typeof meta.trace_id === 'string' ? meta.trace_id : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sourceAvailable: false, spans: [], events: [], nextCursor: cursor ?? { offset: 0 } }
      throw error
    }
    if (!traceId || !this.deps.traceReader) {
      // 老 meta（升级前写入）没有 trace_id：退化为空、cursor 原样透传（可续读）。
      return { sourceAvailable: false, spans: [], events: [], nextCursor: cursor ?? { offset: 0 } }
    }
    const trace = await this.deps.traceReader.readTrace(traceId)
    if (!trace) return { sourceAvailable: false, spans: [], events: [], nextCursor: cursor ?? { offset: 0 } }
    const start = cursor?.offset ?? 0
    const spans = trace.spans.slice(start)
    const events: import('../types.js').NormalizedTraceEvent[] = []
    let consumed = start
    for (let i = start; i < trace.spans.length; i++) {
      const normalizedEvents = normalizeBuiltinSpan(trace.spans[i])
      events.push(...normalizedEvents.map((event) => ({ ...event, source_offset: i })))
      consumed = i + 1
    }
    return { sourceAvailable: true, spans, events, nextCursor: { offset: consumed } }
  }

  async inspectSupervisionActivity(
    h: IncarnationHandle,
    cursor?: { readonly offset: number },
  ): Promise<SupervisionObservation> {
    try {
      const trace = await this.readTraceWindow(h, cursor)
      if (!trace.sourceAvailable) return { kind: 'unknown', next_cursor: cursor ?? { offset: 0 } }
      // 页面 read model 不得改变既有 Manager 巡检语义：任何 LLM turn 都延续为 text。
      if (trace.spans.some((span) => span.type === 'llm_call')) return { kind: 'text', next_cursor: trace.nextCursor }
      return classifySupervisionActivity(trace.events, trace.nextCursor)
    } catch {
      return { kind: 'unknown', next_cursor: cursor ?? { offset: 0 } }
    }
  }

  async kill(h: IncarnationHandle): Promise<void> {
    this.assertActive()
    const mutex = this.getMutex(h.worker_id)
    await mutex.run(async () => {
      const instance = this.instances.get(instanceKey(h.worker_id, h.seq))
      if (!instance) {
        throw new Error(`BuiltinWorkerAdapter.kill: no such incarnation ${h.worker_id}#${h.seq} resident in this process`)
      }

      // 已 exited：幂等返回，不覆盖原 ended_reason（kill 打晚了不该篡改真实终态原因）。
      if (instance.state === 'exited') return

      // idle：没有 burst 在跑，没有什么可 abort 的，直接落终态。
      if (instance.state === 'idle') {
        await this.transitionExited(instance, h, 'killed')
        return
      }

      // running：先置位 killRequested，再 abort 当前 burst 的 signal。置位在 abort 之前，
      // 确保 runBurst/runForkBurst 在同一把锁内做的 killRequested 核对不会漏判。burst 的
      // runEngine 调用本身在锁外跑（见 runBurst 注释），abort() 后由它自己以
      // outcome='aborted' 收尾时落 exited(killed)——这里不代为转态，避免和 burst 收尾段的
      // 互斥锁临界区打架；abortController 若恰好指向已经跑完的旧 burst（交接窗口内），
      // abort 对它是空操作，届时由 killRequested 兜底。
      instance.killRequested = true
      instance.abortController?.abort()
    })
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.closing = true
    this.disposePromise = (async () => {
      await Promise.all([...this.instances.values()].map((instance) =>
        this.getMutex(instance.worker_id).run(async () => {
          if (instance.state !== 'running') return
          instance.abortController?.abort()
        }),
      ))
      await Promise.allSettled([...this.activeRuns])
    })()
    return this.disposePromise
  }

  /**
   * 崩溃恢复扫描：遍历 dataDir 下所有 worker 目录的 meta-<seq>.json，把 state==='running'
   * 的原子改写为 exited(crashed) 并收集返回。直接读写文件、不经过内存 instances、不加锁——
   * 调用方必须保证在本进程任何 adapter 实例开始活动（spawn/resume/fork）之前调用一次，
   * 此时不存在与运行中 burst 的并发写冲突。坏 meta 文件（读取或 JSON.parse 失败）原样跳过。
   */
  static async scanOrphans(dataDir: string): Promise<IncarnationHandle[]> {
    const orphans: IncarnationHandle[] = []
    let workerIds: string[]
    try {
      workerIds = await fs.readdir(dataDir)
    } catch {
      return orphans
    }

    for (const worker_id of workerIds) {
      const dir = join(dataDir, worker_id)
      let entries: string[]
      try {
        entries = await fs.readdir(dir)
      } catch {
        continue
      }

      for (const entry of entries) {
        const match = /^meta-(\d+)\.json$/.exec(entry)
        if (!match) continue
        const seq = Number(match[1])
        const metaPath = join(dir, entry)

        let meta: { state?: WorkerContractState; [key: string]: unknown }
        try {
          meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'))
        } catch {
          continue
        }
        if (meta.state !== 'running') continue

        const updated = { ...meta, state: 'exited', ended_reason: 'crashed' }
        const tmpPath = join(dir, `.meta-${seq}.json.tmp-${randomUUID()}`)
        await fs.writeFile(tmpPath, JSON.stringify(updated), 'utf-8')
        await fs.rename(tmpPath, metaPath)
        const tipNodeId = typeof meta.tip_node_id === 'string' ? meta.tip_node_id : ''
        orphans.push({ worker_id, seq, impl: 'builtin', session_ref: tipNodeId })
      }
    }

    return orphans
  }

  capabilities(): AdapterCapabilities {
    // goalMode=false：装配层不给 builtin worker 装 goal 模式，`guardTools` 更是把
    // `set_task_goal` 列进 `FORBIDDEN_WORKER_TOOLS` 硬禁（runtime.ts）——声明 true 与这条
    // 硬禁直接矛盾。今天还没有消费方读它，但 protocol-agent-v3 §6.5 的实现选择语义迟早会读，
    // 届时按 true 选型会选出一个根本没有 goal 能力的载体。protocol-agent-v3 §6.4。
    return { fork: true, revive: true, goalMode: false, subagent: true, structuredTrace: true }
  }

  private assertActive(): void {
    if (this.closing) throw new Error('BuiltinWorkerAdapter is shutting down')
  }

  private interruptionEndReason(instance: WorkerInstance): 'killed' | 'crashed' {
    return instance.killRequested ? 'killed' : 'crashed'
  }

  private trackRun(
    run: Promise<void>,
    instance: WorkerInstance,
    handle: IncarnationHandle,
    context: string,
  ): void {
    const tracked = run.catch((err) => this.safetyNetExit(instance, handle, err, context))
    this.activeRuns.add(tracked)
    void tracked.finally(() => { this.activeRuns.delete(tracked) })
  }

  /**
   * fire-and-forget 起 burst（spawn/resume/fork/sendInput 四处）后统一 .catch 到这里。
   * runBurst/runForkBurst 内部已经把 runEngine 的失败路径处理成 exited(crashed)，能落到
   * 这里的都是真正意外的同步/异步抛错（比如 pendingWrites 落盘失败后的兜底 throw）。
   * transitionExited 自己还要再摸一次磁盘（writeMeta，pendingInputs 非空时还有 dead-letter
   * append）——若它这次也抛错（ENOSPC/EIO 之类最容易撞上），这层 catch 回调本身就是一个
   * 没人再接的 async 函数，rejection 会直接命中 main.ts 的 process.on('unhandledRejection')
   * → process.exit(1)，把整个 agent 进程一起打崩。因此再包一层 try/catch 兜底：兜不住就
   * 只能 console.error 记录——此时化身状态已经不可靠（内存/磁盘可能没落到 exited），但至少
   * 保证不崩进程。
   */
  private async safetyNetExit(instance: WorkerInstance, handle: IncarnationHandle, err: unknown, context: string): Promise<void> {
    console.error(`[builtin-adapter] ${context} threw unexpectedly:`, err)
    try {
      await this.getMutex(instance.worker_id).run(async () => {
        await this.transitionExited(instance, handle, 'crashed')
      })
    } catch (innerErr) {
      console.error(
        `[builtin-adapter] safety net itself failed while exiting incarnation ${instance.worker_id}#${instance.seq} ` +
        '(incarnation state may now be unreliable; process kept alive):',
        innerErr,
      )
    }
  }

  // --- Internal: burst execution ---

  /**
   * 保证本化身的 trace 引用存在（P6-A §8.4）：spawn 时随 meta 持久化；旧 meta 缺
   * trace_id（升级前写入）时现建并补写 meta。所有 burst 入口共用，失败不阻塞 burst
   * （trace 是观测面，不是执行面）。
   */
  private async ensureTraceId(instance: WorkerInstance, summary: string): Promise<void> {
    if (instance.traceId || !this.deps.traceHooks) return
    try {
      instance.traceId = this.deps.traceHooks.startIncarnationTrace({
        worker_id: instance.worker_id,
        seq: instance.seq,
        summary,
      })
      await this.writeMeta(instance)
    } catch (error) {
      console.warn(`[BuiltinWorkerAdapter] trace start failed for ${instance.worker_id}#${instance.seq}:`,
        error instanceof Error ? error.message : String(error))
    }
  }

  private async runBurst(
    instance: WorkerInstance,
    handle: IncarnationHandle,
    builtin: NonNullable<SpawnSpec['builtin']>,
  ): Promise<void> {
    await this.ensureTraceId(instance, `worker ${instance.worker_id}#${instance.seq}`)
    const tip = instance.tip
    const initialMessages = instance.sessionTree.pathTo(tip)
    const mutex = this.getMutex(instance.worker_id)

    // 每次进入 runBurst（含续 burst 的递归调用）都换一个新 AbortController，供 kill() abort。
    // 安装与 killRequested 核对必须在同一把锁内原子完成，和 kill() 的"置位+abort"共享该锁：
    // 否则会有窗口——kill 已经决定要杀这个（还没起的）新 burst，但读到的 abortController
    // 还是上一个已经跑完的 burst 的，abort 它没有任何效果，新 burst 照样起来（P1 全分支
    // 终审 Important，见 kill() 顶部注释）。kill 或 shutdown 已开始时不装 controller、
    // 不起 runEngine；显式 kill 落 killed，模块 shutdown 落可恢复的 crashed。
    const abortController = await mutex.run(async () => {
      if (instance.killRequested || this.closing) {
        await this.transitionExited(instance, handle, this.interruptionEndReason(instance))
        return undefined
      }
      const ac = new AbortController()
      instance.abortController = ac
      return ac
    })
    if (!abortController) return
    instance.activityAt = Date.now()

    // pendingWrites 里的 promise 必须在 push 的同一刻就挂上 catch：burst 可能跑几分钟，
    // onTurn 到下面 await Promise.all(pendingWrites) 之间跨度很长，若 append 提前 reject
    // 却没有 handler，Node 会在本轮微任务结束时就判定为 unhandledRejection——命中
    // main.ts 的 process.on('unhandledRejection') 兜底，直接 process.exit(1) 打崩整个
    // agent 进程。这里改成收集错误到 writeErrors，Promise.all 结束后统一判定：与
    // spawn/resume/fork/sendInput 处包给 this.runBurst(...) 的安全网 catch（跑到
    // transitionExited(..., 'crashed')）走同一条错误路径——不在这里代为转态，避免
    // 和下面的收尾段互斥锁临界区重复处理。
    const pendingWrites: Promise<void>[] = []
    const writeErrors: unknown[] = []
    // 本次 burst 内是否真的发生过一次成功的压缩。压缩是对 messages 的**整体重写**
    // （query-loop.ts compactInPlace：messages.length = 0 后重填），一旦发生，
    // finalMessages 就不再是 initialMessages 的后缀，下面的 write-back 必须换一条路径。
    // 判据只看 failedReason 缺席：压缩失败 / abort 都会带上它且 messages 保持原样
    // （engine 压缩故障链修复后的语义，见 EngineOptions.onCompactionEnd 注释），
    // 所以"没带 failedReason" ⇒ messages 已被重写。宁可多判（压缩恰好是空操作时也走整条
    // 重写路径，代价只是多复制一份节点），也绝不能漏判——漏判就是静默数据损坏。
    let compactedThisBurst = false
    // 本次 burst 里 worker 最后说的那段话（末一个非空 assistantText）。收尾时随状态转换一起
    // 交给 harness，进唤醒事件的 detail——manager 醒来即可知道 worker 说了什么。
    // 取值与写进 output.log 的是同一个 `event.assistantText`（下面 onTurn 一处产出、两处消费），
    // 所以天然只有 assistant text、不含任何工具调用/结果，不需要额外过滤。
    // 用 `result.finalText` 不行：finish_task 这类早退工具收场时它可能为空串，而那恰恰是
    // manager 最需要看到的一轮。
    let lastAssistantText = ''
    const result: EngineResult = await runEngine({
      prompt: '',
      adapter: builtin.adapter,
      initialMessages,
      options: {
        systemPrompt: builtin.systemPrompt,
        tools: this.combineTools(builtin.tools),
        model: builtin.model,
        ...(builtin.maxTurnsPerBurst !== undefined ? { maxTurns: builtin.maxTurnsPerBurst } : {}),
        ...this.safetyOptions(builtin),
        // 长活 worker 的窗口是在**一次 burst 内部**被跑满的（maxTurns 默认 200），
        // burst 边界折叠够不着，只有 engine 的 per-turn 阈值压缩 + max_tokens 强压重试
        // 才治得了。session 树仍以原始消息为真相源：老节点一个不删，压缩后的序列另起
        // 一条新根链（见下面的 write-back）。
        disableCompaction: false,
        // engine 的 forced_summary 兜底（silent end_turn → 注入"你还没向人类发过内容，
        // 请调 send_message"追问，最多 3 次）是 v2 worker loop 的机制，对 v3 的 builtin
        // worker 完全不适用：worker 不跟人类说话，工具面里根本没有 send_message，被催
        // 也无从执行——每次 end_turn 白烧最多 3 轮 LLM。而且那段文案与 worker 的 system
        // prompt 直接冲突（prompt 刻意不提"联系人类"，就是不想把这个念头塞进上下文），
        // 还会污染带给 manager 的收尾 assistantText（催出来的废话）。
        // worker 的收尾信号是 finish_task；silent end_turn 只意味着"这一 burst 说完了"，
        // 由上面的收尾段落成 idle 等下一次唤醒，本就是正常态。
        suppressForcedSummary: () => true,
        onCompactionEnd: (info) => {
          if (info.failedReason === undefined) compactedThisBurst = true
        },
        abortSignal: abortController.signal,
        onLiveProgress: () => {
          instance.activityAt = Date.now()
        },
        onTurn: (event) => {
          instance.activityAt = Date.now()
          if (instance.traceId) this.deps.traceHooks?.appendTurn(instance.traceId, event)
          if (event.assistantText) {
            lastAssistantText = event.assistantText
            pendingWrites.push(
              instance.outputLog.append(event.assistantText + '\n').catch((err) => {
                writeErrors.push(err)
              }),
            )
          }
        },
      },
    })
    await Promise.all(pendingWrites)
    if (writeErrors.length > 0) {
      throw new Error(
        `[builtin-adapter] runBurst: ${writeErrors.length} outputLog.append write(s) failed for worker ${instance.worker_id}: ` +
        writeErrors.map((e) => (e instanceof Error ? e.message : String(e))).join('; '),
      )
    }

    // 收尾段（压缩防御 → append 新消息 → 判 outcome → 判队列 → 落 idle/续 burst）整体在该
    // worker 的互斥锁内原子完成：消除"同步判定 pendingInputs 为空后 await transitionState
    // 期间新 sendInput 插队"的窗口——判定与状态落定必须是同一个不可分割的临界区。
    // 续 burst 的递归调用放在锁外触发（见下），不然会把 runEngine 的执行时长堵在锁里。
    const continueBurst = await mutex.run(async () => {
      await this.writeBack(instance, tip, result, initialMessages.length, compactedThisBurst)

      if (result.outcome === 'failed' || result.outcome === 'aborted') {
        const endReason = result.outcome === 'aborted' ? this.interruptionEndReason(instance) : 'crashed'
        await this.transitionExited(instance, handle, endReason, undefined, lastAssistantText)
        return false
      }

      if (result.exitToolCall?.name === 'finish_task') {
        const rawOutcome = result.exitToolCall.input.outcome
        const outcome: 'completed' | 'failed' = rawOutcome === 'failed' ? 'failed' : 'completed'
        // summary 是 finish_task 的**必填**入参（见 FINISH_TASK_TOOL 的 inputSchema.required），
        // 但入参来自 LLM，schema 不是运行时保证：非字符串一律当没给，不把 `[object Object]`
        // 这类东西当作 worker 的结论上报。
        const rawSummary = result.exitToolCall.input.summary
        const summary = typeof rawSummary === 'string' ? rawSummary : undefined
        await this.transitionExited(instance, handle, outcome, outcome, lastAssistantText, summary)
        return false
      }

      // burst 正常收尾（非 aborted/failed/finish_task）但期间 killRequested 已被置位：
      // abort 大概率是打在了这次 burst 身上（下面 outcome==='aborted' 分支已经处理），但也
      // 可能是打晚了——engine 已经决定 end_turn，abort 信号没赶上（P1 全分支终审 Important
      // 收尾段检查点）。无论如何都不能继续/续 burst；显式 kill 与 shutdown 保持各自归因。
      if (instance.killRequested || this.closing) {
        await this.transitionExited(instance, handle, this.interruptionEndReason(instance), undefined, lastAssistantText)
        return false
      }

      // 上下文超限静默收场：必须落成真实终态，绝不能落 idle（见 isSilentContextOverflow）。
      // 位置在 pendingInputs 续 burst 之前——上下文已经压不下去了，再喂新输入续 burst 只是
      // 每轮再烧一个满窗口调用；排队的消息按既有语义进 dead-letter（transitionExited 负责）。
      if (isSilentContextOverflow(result)) {
        await instance.outputLog.append(CONTEXT_OVERFLOW_NOTICE)
        await this.transitionExited(instance, handle, 'failed', 'failed', lastAssistantText)
        return false
      }

      // end_turn（或 max_turns 耗尽）→ 若 sendInput 排了队，逐条 append 后原地续 burst
      // （不经过可见的 idle 态）；否则转 idle，等待下一次 resume/sendInput 唤醒。
      if (instance.pendingInputs.length > 0) {
        const queued = instance.pendingInputs.splice(0, instance.pendingInputs.length)
        let queueParent = instance.tip
        for (const text of queued) {
          queueParent = await instance.sessionTree.append(queueParent, createUserMessage(text))
        }
        instance.tip = queueParent
        return true
      }

      await this.transitionState(instance, handle, 'idle', lastAssistantText)
      return false
    })

    if (continueBurst) {
      await this.runBurst(instance, handle, builtin)
    }
  }

  /**
   * fork 专用的一次性 burst：不含 finish_task 工具（工具表用 spec 注入的原样），没有
   * "提前退出"这回事——end_turn 或 maxTurns 耗尽都视为侧问正常收尾，直接 exited(completed)，
   * 不经过 idle、不支持续 burst（没有 pendingInputs 排队逻辑）。engine 抛错/aborted 才是
   * exited(crashed)。收尾在该 worker 的互斥锁内完成，append 只作用于 fork 自己的分支链路，
   * 不触碰主线 tip。
   */
  private async runForkBurst(
    instance: WorkerInstance,
    handle: IncarnationHandle,
    builtin: NonNullable<SpawnSpec['builtin']>,
  ): Promise<void> {
    // fork 化身也有自己的结构化 trace（P6-A §8.4）：与主线 burst 同一 admission 纪律。
    await this.ensureTraceId(instance, `worker ${instance.worker_id}#${instance.seq} (fork)`)
    const tip = instance.tip
    const initialMessages = instance.sessionTree.pathTo(tip)
    const mutex = this.getMutex(instance.worker_id)

    // fork 化身同样支持被 kill() abort——见 runBurst 里对应注释，同样的窗口①在 fork 的
    // 一次性 burst 上也存在：fork() 把新化身以 running 态注册、锁外 fire-and-forget 起
    // runForkBurst，安装 controller 前先在锁内核对 killRequested。
    const abortController = await mutex.run(async () => {
      if (instance.killRequested || this.closing) {
        await this.transitionExited(instance, handle, this.interruptionEndReason(instance))
        return undefined
      }
      const ac = new AbortController()
      instance.abortController = ac
      return ac
    })
    if (!abortController) return
    instance.activityAt = Date.now()

    // 同 runBurst：push 时立即挂 catch，避免 append 在长时间跑的 burst 期间 reject 却
    // 没有 handler，触发 unhandledRejection 打崩进程。错误收集到 writeErrors，
    // Promise.all 后统一抛出，走 fork() 处包给 this.runForkBurst(...) 的安全网 catch
    // （crashed 收尾），与 runBurst 保持一致的错误语义。
    const pendingWrites: Promise<void>[] = []
    const writeErrors: unknown[] = []
    // 见 runBurst 同名变量的注释。
    let compactedThisBurst = false
    const result: EngineResult = await runEngine({
      prompt: '',
      adapter: builtin.adapter,
      initialMessages,
      options: {
        systemPrompt: builtin.systemPrompt,
        // fork 不加 finish_task（一次性侧问），但工具集守卫与安全项与主线完全一致——
        // 侧问同样是一次真实的 LLM + 工具执行，没有理由少一道闸。
        tools: this.guardTools(builtin.tools),
        model: builtin.model,
        maxTurns: FORK_MAX_TURNS,
        ...this.safetyOptions(builtin),
        // fork 也必须开：从压缩点**之前**的老节点 fork 时，pathTo 回溯拿到的是完整未压缩
        // 历史，本身就可能超窗口。不开压缩，老链 fork 必撞窗口。代价是轻量侧问也可能付一次
        // 摘要成本——可接受（只在真的超阈值时才付）。
        disableCompaction: false,
        // 同 runBurst：v2 的 forced_summary 兜底对 v3 worker 不适用。fork 更甚——它连
        // finish_task 都没有，end_turn 就是侧问的正常收尾信号，静默收尾（比如答案已经
        // 通过工具写出去了）不该被追着要"发给人类"。
        suppressForcedSummary: () => true,
        onCompactionEnd: (info) => {
          if (info.failedReason === undefined) compactedThisBurst = true
        },
        abortSignal: abortController.signal,
        onLiveProgress: () => {
          instance.activityAt = Date.now()
        },
        onTurn: (event) => {
          instance.activityAt = Date.now()
          if (instance.traceId) this.deps.traceHooks?.appendTurn(instance.traceId, event)
          if (event.assistantText) {
            pendingWrites.push(
              instance.outputLog.append(event.assistantText + '\n').catch((err) => {
                writeErrors.push(err)
              }),
            )
          }
        },
      },
    })
    await Promise.all(pendingWrites)
    if (writeErrors.length > 0) {
      throw new Error(
        `[builtin-adapter] runForkBurst: ${writeErrors.length} outputLog.append write(s) failed for worker ${instance.worker_id}: ` +
        writeErrors.map((e) => (e instanceof Error ? e.message : String(e))).join('; '),
      )
    }

    await mutex.run(async () => {
      await this.writeBack(instance, tip, result, initialMessages.length, compactedThisBurst)

      if (result.outcome === 'failed' || result.outcome === 'aborted') {
        const endReason = result.outcome === 'aborted' ? this.interruptionEndReason(instance) : 'crashed'
        await this.transitionExited(instance, handle, endReason)
        return
      }

      // outcome 是正常收尾但 killRequested 已置位：abort 打晚了，engine 已经决定收尾，
      // 但用户明确要求过 kill，不该落 completed（P1 全分支终审 Important 收尾段检查点）。
      if (instance.killRequested || this.closing) {
        await this.transitionExited(instance, handle, this.interruptionEndReason(instance))
        return
      }

      // 侧问同样不能因为"上下文满了"就静默报 completed（见 isSilentContextOverflow）。
      if (isSilentContextOverflow(result)) {
        await instance.outputLog.append(CONTEXT_OVERFLOW_NOTICE)
        await this.transitionExited(instance, handle, 'failed', 'failed')
        return
      }

      // 'completed'（end_turn）与 'max_turns' 都视为一次性侧问正常收尾。
      await this.transitionExited(instance, handle, 'completed', 'completed')
    })
  }

  /**
   * burst 收尾把消息写回 session 树。两条互斥路径：
   *
   * - **未压缩**：`finalMessages` 是 `initialMessages` + 一段后缀，只回写后缀、挂在 `tip`
   *   下（P1 起的原行为，一字不变）。
   * - **压缩过**：`compactInPlace` 是对 messages 的整体重写（`[首条, 摘要, 最近若干条]` 再
   *   续跑），与老链不再有"公共前缀"关系。此时按后缀 `slice(initialMessages.length)` 取到的
   *   是**压缩后数组的错位区间**：摘要节点被掐掉、压缩后新生成的前半段消息被掐掉，而切口那
   *   一条大概率正是一条 `tool_result`——它配对的 `assistant(tool_use)` 恰在被掐掉的那段里。
   *   这条孤儿 `tool_result` 一旦嫁接到老 tip 下就**落盘了**，之后任何 resume/fork 把
   *   `pathTo` 的结果发给 LLM 都是 API 400，且 400 文案不匹配任何自愈判定 = 永久卡死。
   *   （旧的 `finalMessages.length < initialMessages.length` 防御断言挡不住这一幕：长 burst
   *   压缩后继续跑，长度往往反而更大，断言静默放行；而它触发时又会把整个 burst 几十轮的
   *   工作全丢掉判 crashed——既漏判又误杀，故删除，由 `compacted` 信号取代。）
   *
   *   修法是把整条 `finalMessages` 作为一条**新根链**写入（`append(null, …)`，SessionTree
   *   本就允许多根，零改动）。老链一个节点不删，因此"从任意历史节点分支"仍然成立——从压缩点
   *   之前的节点 fork 拿到的是未压缩全量（贵，但可行，且 fork burst 也开着压缩）。
   */
  private async writeBack(
    instance: WorkerInstance,
    tip: string,
    result: EngineResult,
    initialCount: number,
    compacted: boolean,
  ): Promise<void> {
    if (compacted) {
      let parent: string | null = null
      for (const msg of result.finalMessages as EngineMessage[]) {
        parent = await instance.sessionTree.append(parent, msg)
      }
      // finalMessages 理论上不会为空（至少含被钉住的首条），空则保持 tip 不动。
      if (parent !== null) instance.tip = parent
      return
    }
    const newMessages = result.finalMessages.slice(initialCount)
    let parent = tip
    for (const msg of newMessages as EngineMessage[]) {
      parent = await instance.sessionTree.append(parent, msg)
    }
    instance.tip = parent
  }

  /** worker_id 对应的互斥锁，惰性创建（见 workerMutexes 字段注释）。 */
  private getMutex(worker_id: string): AsyncMutex {
    let mutex = this.workerMutexes.get(worker_id)
    if (!mutex) {
      mutex = new AsyncMutex()
      this.workerMutexes.set(worker_id, mutex)
    }
    return mutex
  }

  private findSessionTreeForWorker(worker_id: string): SessionTree | undefined {
    for (const instance of this.instances.values()) {
      if (instance.worker_id === worker_id) return instance.sessionTree
    }
    return undefined
  }

  /**
   * worker_id 对应下一个可用的化身序号：该 worker 现存所有化身（主线 + fork 分支）里
   * 最大 seq + 1。resume 和 fork 共用这一个分配逻辑，且都在各自的 mutex.run 内调用，
   * 保证两者不会分配出相同的 seq。
   *
   * 五轮 review 修复：磁盘感知，理由与 cc/codex adapter 的同名方法一致——只扫内存
   * instances 会漏掉磁盘上未被重建到内存的旧化身（如跨进程重启后的历史化身），算出的
   * "下一个"号位实际是别人已经占用的，静默覆盖其 meta-<seq>.json、复用其 output-<seq>.log。
   * 改为 max(内存已知 seq, 磁盘上 <dataDir>/<worker_id>/ 下 meta-*.json 的最大 seq) + 1——
   * builtin 的 writeMeta 是独立实现（不复用 meta-store.ts，见该方法注释），这里同样不引入
   * 跨模块耦合，本地内联一份同款扫盘逻辑。目录不存在（还没 spawn 过）视为无历史，不报错。
   */
  private async nextSeq(worker_id: string): Promise<number> {
    let max = 0
    for (const instance of this.instances.values()) {
      if (instance.worker_id === worker_id && instance.seq > max) max = instance.seq
    }
    const dir = join(this.deps.dataDir, worker_id)
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      entries = []
    }
    for (const name of entries) {
      const m = /^meta-(\d+)\.json$/.exec(name)
      if (!m) continue
      const seq = Number(m[1])
      if (Number.isFinite(seq) && seq > max) max = seq
    }
    return max + 1
  }

  private async assertExited(worker_id: string, seq: number): Promise<void> {
    const existing = this.instances.get(instanceKey(worker_id, seq))
    if (existing) {
      if (existing.state !== 'exited') {
        throw new Error(`BuiltinWorkerAdapter.resume: incarnation ${worker_id}#${seq} is not exited (state=${existing.state})`)
      }
      return
    }
    const metaPath = join(this.deps.dataDir, worker_id, `meta-${seq}.json`)
    let raw: string
    try {
      raw = await fs.readFile(metaPath, 'utf-8')
    } catch {
      throw new Error(`BuiltinWorkerAdapter.resume: no such incarnation ${worker_id}#${seq}`)
    }
    const meta = JSON.parse(raw) as { state: WorkerContractState }
    if (meta.state !== 'exited') {
      throw new Error(`BuiltinWorkerAdapter.resume: incarnation ${worker_id}#${seq} is not exited (state=${meta.state})`)
    }
  }

  private combineTools(tools: Resolvable<ReadonlyArray<ToolDefinition>>): Resolvable<ReadonlyArray<ToolDefinition>> {
    const guarded = this.guardTools(tools)
    return () => [...resolve(guarded), FINISH_TASK_TOOL]
  }

  /**
   * 工具集守卫（spec 决策 3 / 决策 4）：`set_cwd` / `set_task_goal` 绝不许出现在 builtin
   * worker 的工具集里。放在 resolve 路径上而不是 spawn 一次性检查——`tools` 是 Resolvable，
   * engine 每轮 turn 都会重新 resolve，装配层中途换出一份带 set_cwd 的工具表同样要被拦下。
   * 违规是装配层的配置错误，fail-loud 抛错（burst 因此落 exited(crashed)，错误信息指名道姓），
   * 不静默过滤——静默过滤会让"worker 悄悄换了工作目录"这类问题拖到线上才发现。
   */
  private guardTools(tools: Resolvable<ReadonlyArray<ToolDefinition>>): Resolvable<ReadonlyArray<ToolDefinition>> {
    return () => {
      const resolved = resolve(tools)
      const forbidden = resolved.filter((t) => FORBIDDEN_WORKER_TOOLS.has(t.name)).map((t) => t.name)
      if (forbidden.length > 0) {
        throw new Error(
          `[builtin-adapter] forbidden tool(s) in builtin worker toolset: ${forbidden.join(', ')}. ` +
          'worker 的工作目录固定为它的 workspace（不可中途切换），且不装配 goal 模式；' +
          '这两类工具不得注入（spec 2026-08-01-builtin-worker-injection-design 决策 3/4）。',
        )
      }
      return resolved
    }
  }

  /**
   * 每次 runEngine 都要带上的安全项与模型参数（spec 决策 6）。
   *
   * `hookRegistry` 是其中唯一不能省的一项：工具面过滤只保证"工具不出现在列表里"，挡不住
   * worker 在 Bash 里直接跑 `crabot` 写命令——CLI 闸口只有 PreToolUse hook 这一处。
   * `permissionConfig` 用 checkPermission 动态判定而不是静态 denyList：`tools` 是 Resolvable，
   * 静态清单会在装配层换工具表之后失真。
   * timezone / supportsVision / maxTokens / contextWindowTokens 随 model 由注入工厂给出，
   * adapter 自己无从知道；缺省则不传，由 engine 用它自己的默认值。
   */
  private safetyOptions(builtin: NonNullable<SpawnSpec['builtin']>): {
    permissionConfig: ToolPermissionConfig
    hookRegistry: HookRegistry
    resolvedPermissions: typeof BUILTIN_WORKER_PERMISSIONS
    senderIsMaster: boolean
    maxTokens?: number
    contextWindowTokens?: number
    supportsVision?: boolean
    timezone?: string
  } {
    return {
      permissionConfig: this.workerPermissionConfig(builtin.tools),
      hookRegistry: this.hookRegistry,
      resolvedPermissions: BUILTIN_WORKER_PERMISSIONS,
      // worker 不是任何人：F 阶段没有可信发起人身份（origin.creator_friend_id 现网恒空），
      // 不能走 CLI 闸的 master 短路。J 接线真实身份后由 origin 解析（见 runtime.ts 注释）。
      senderIsMaster: false,
      ...(builtin.maxTokens !== undefined ? { maxTokens: builtin.maxTokens } : {}),
      ...(builtin.contextWindowTokens !== undefined ? { contextWindowTokens: builtin.contextWindowTokens } : {}),
      ...(builtin.supportsVision !== undefined ? { supportsVision: builtin.supportsVision } : {}),
      ...(builtin.timezone !== undefined ? { timezone: builtin.timezone } : {}),
    }
  }

  /**
   * 按固定权限档位（BUILTIN_WORKER_PERMISSIONS.tool_access）过滤工具，映射方式与现网
   * worker loop 一致：工具的 `category` 落在被关掉的面上即拒。`finish_task` 是契约的终态
   * 信号（不是能力面），恒放行。
   */
  private workerPermissionConfig(tools: Resolvable<ReadonlyArray<ToolDefinition>>): ToolPermissionConfig {
    const toolAccess = BUILTIN_WORKER_PERMISSIONS.tool_access
    return {
      // checkPermission 存在时覆盖一切静态判定（engine/permission-checker.ts），
      // mode/toolNames 在这条路径上不参与决策。
      mode: 'denyList',
      toolNames: [],
      checkPermission: async (toolName: string) => {
        if (toolName === FINISH_TASK_TOOL.name) return { allowed: true }
        const tool = resolve(tools).find((t) => t.name === toolName)
        const category = tool?.category ?? 'mcp_skill'
        if (toolAccess[category]) return { allowed: true }
        return { allowed: false, reason: `builtin worker 权限档位未开放 ${category} 类工具（tool=${toolName}）` }
      },
    }
  }

  /**
   * 起化身时现取运行配置（spec 决策 2）。配置了工厂就一律现取——ctx 从内存缓存或
   * context.json 读回，因此进程重启后仍然可用（这是 builtin worker 能 revive 的前提）。
   * 没配工厂时退化为 P1 的内存快照，仅供契约套件与单测。
   */
  private async runtimeFor(worker_id: string, op: string): Promise<NonNullable<SpawnSpec['builtin']>> {
    if (this.deps.resolveRuntime) {
      const context = await this.loadContext(worker_id)
      if (!context) {
        throw new Error(
          `BuiltinWorkerAdapter.${op}: no spawn context for worker ${worker_id} ` +
          `(${CONTEXT_FILE} missing — worker was never spawned through this adapter?)`,
        )
      }
      const builtin = this.deps.resolveRuntime(context)
      if (!builtin) {
        throw new Error(`BuiltinWorkerAdapter.${op}: resolveRuntime returned no runtime config for worker ${worker_id}`)
      }
      return builtin
    }
    const resident = this.builtinConfigs.get(worker_id)
    if (!resident) {
      throw new Error(
        `BuiltinWorkerAdapter.${op}: no builtin config resident in memory for worker ${worker_id} ` +
        '(no resolveRuntime factory configured; worker must have been spawned in this process)',
      )
    }
    return resident
  }

  /** spawn 时把 per-worker 上下文原子落盘（tmp + rename，与 writeMeta 同款）。 */
  private async persistContext(dir: string, context: BuiltinRuntimeContext): Promise<void> {
    const path = join(dir, CONTEXT_FILE)
    const tmpPath = join(dir, `.${CONTEXT_FILE}.tmp-${randomUUID()}`)
    await fs.writeFile(tmpPath, JSON.stringify(context), 'utf-8')
    await fs.rename(tmpPath, path)
  }

  /** 读 per-worker 上下文：内存缓存优先，缺失时回落到磁盘（进程重启后走的就是这条）。 */
  private async loadContext(worker_id: string): Promise<BuiltinRuntimeContext | undefined> {
    const cached = this.spawnContexts.get(worker_id)
    if (cached) return cached
    const path = join(this.deps.dataDir, worker_id, CONTEXT_FILE)
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf-8')
    } catch {
      return undefined
    }
    let parsed: BuiltinRuntimeContext
    try {
      parsed = JSON.parse(raw) as BuiltinRuntimeContext
    } catch {
      return undefined
    }
    this.spawnContexts.set(worker_id, parsed)
    return parsed
  }

  // 先落盘、再切内存态：state() 优先读内存，若顺序反过来，外部在 writeMeta 的
  // await 期间读 state() 会看到"内存已切但磁盘还是旧值"的窗口。
  private async transitionState(
    instance: WorkerInstance,
    handle: IncarnationHandle,
    state: WorkerContractState,
    lastText?: string,
  ): Promise<void> {
    await this.writeMeta(instance, { state })
    instance.state = state
    // 观察者（onStateChange）的异常永远不能中断状态机的推进。任何回调错误都被捕获
    // 并仅作 console.error 记录，防止阻塞状态转移或导致后续 burst/sendInput 卡死。
    // session_ref 现读现取 instance.tip（不是调用方传入、创建化身那一刻闭包住的旧
    // handle.session_ref）——builtin 的 tip 每轮 burst 前进，harness 侧靠这个字段把台账
    // 刷新到"最近一次完成的状态转换点"，否则活跃化身上的 fork/resume 会从旧节点分叉、
    // 丢中间上下文（cc/codex 的 session id 整个化身稳定，不受这个问题影响）。
    try {
      this.deps.onStateChange?.({ ...handle, session_ref: instance.tip }, state, { ...(lastText !== undefined ? { lastText } : {}) })
    } catch (err) {
      console.error(`[BuiltinWorkerAdapter] onStateChange callback error for ${handle.worker_id}#${handle.seq}:`, err)
    }
  }

  private async transitionExited(
    instance: WorkerInstance,
    handle: IncarnationHandle,
    ended_reason: IncarnationEndReason,
    outcome?: 'completed' | 'failed',
    lastText?: string,
    /**
     * worker 写在 `finish_task(summary)` 里的收尾结论,只有那一条终止路径传得出
     * （其余路径——crashed/killed/上下文超限——worker 没机会写）。原样上抛给 harness，
     * 见下面回调处的注释。
     */
    summary?: string,
  ): Promise<void> {
    if (instance.pendingInputs.length > 0) {
      const deadLetterMsg = `[dead-letter] incarnation ${instance.worker_id}#${instance.seq} exited with ${instance.pendingInputs.length} unsent message(s): ${instance.pendingInputs.join(' | ')}\n`
      await instance.outputLog.append(deadLetterMsg)
    }
    if (instance.traceId) {
      // 化身终态收口 trace（§8.4）：终态后 live 读取走 TraceStore 持久记录。
      this.deps.traceHooks?.finishIncarnationTrace(instance.traceId, {
        status: outcome === 'completed' ? 'completed' : 'failed',
        summary: summary ?? `[${ended_reason}]`,
      })
    }
    await this.writeMeta(instance, { state: 'exited', ended_reason, outcome })
    instance.state = 'exited'
    instance.ended_reason = ended_reason
    if (outcome !== undefined) instance.outcome = outcome
    // 观察者（onStateChange）的异常永远不能中断状态机的推进。任何回调错误都被捕获
    // 并仅作 console.error 记录，防止阻塞状态转移或导致后续 burst/sendInput 卡死。
    // session_ref 现读现取 instance.tip，同 transitionState 的注释。
    // report.endReason 报的就是上面刚写进 meta 的那个 ended_reason——builtin 这一档是**确证**
    // （finish_task(outcome) 结构化上报 / engine result / kill 标记），harness 据此落台账。
    // 不报的话这个真值就在回调这一跳被丢掉，harness 只能猜（协议 §6.3）。
    //
    // report.summary 同理：一个全程只调工具、最后 finish_task 收场的 worker（定时反思/
    // 早报就是这个形态）从头到尾没有一句 assistant text —— outputLog 的写入条件
    // `if (event.assistantText)` 一次都不触发，output.log 根本不会被创建，lastText 也是空。
    // 那段 summary 就是它唯一的交付物；不报的话 manager 手里什么都没有。
    try {
      this.deps.onStateChange?.({ ...handle, session_ref: instance.tip }, 'exited', {
        ...(lastText !== undefined ? { lastText } : {}),
        endReason: ended_reason,
        ...(summary !== undefined ? { summary } : {}),
      })
    } catch (err) {
      console.error(`[BuiltinWorkerAdapter] onStateChange callback error for ${handle.worker_id}#${handle.seq}:`, err)
    }
  }

  private async writeMeta(
    instance: WorkerInstance,
    overrides: { state?: WorkerContractState; ended_reason?: IncarnationEndReason; outcome?: 'completed' | 'failed' } = {},
  ): Promise<void> {
    const state = overrides.state ?? instance.state
    const ended_reason = overrides.ended_reason ?? instance.ended_reason
    const outcome = overrides.outcome ?? instance.outcome
    const meta = {
      seq: instance.seq,
      state,
      tip_node_id: instance.tip,
      ...(instance.traceId !== undefined ? { trace_id: instance.traceId } : {}),
      ...(ended_reason !== undefined ? { ended_reason } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
    }
    const metaPath = join(instance.dir, `meta-${instance.seq}.json`)
    const tmpPath = join(instance.dir, `.meta-${instance.seq}.json.tmp-${randomUUID()}`)
    await fs.writeFile(tmpPath, JSON.stringify(meta), 'utf-8')
    await fs.rename(tmpPath, metaPath)
  }
}

/** builtin trace span → NormalizedTraceEvent（P6-A §8.4）。 */
function normalizeBuiltinSpan(span: import('../../types.js').AgentSpan): import('../types.js').NormalizedTraceEvent[] {
  const details = (span.details ?? {}) as Record<string, unknown>
  const base = { ts: span.started_at }
  switch (span.type) {
    case 'llm_call': {
      const { assistant_text: assistantText, ...technicalDetails } = details
      const events: import('../types.js').NormalizedTraceEvent[] = [{
        ...base,
        kind: 'llm_call',
        summary: typeof details.stop_reason === 'string' ? `llm ${details.stop_reason}` : 'llm call',
        detail: technicalDetails,
      }]
      if (typeof assistantText === 'string' && assistantText.trim()) {
        events.push({
          ...base,
          kind: 'message',
          role: 'assistant',
          summary: assistantText.replace(/\s+/g, ' ').trim().slice(0, 200),
          detail: { content: assistantText },
        })
      }
      return events
    }
    case 'tool_call':
      return [{
        ...base,
        kind: 'tool_call',
        summary: typeof details.name === 'string' ? String(details.name) : 'tool call',
        detail: details,
      }]
    default:
      return [{ ...base, kind: 'lifecycle', summary: span.type, detail: details }]
  }
}
