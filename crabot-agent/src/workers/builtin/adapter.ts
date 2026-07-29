/**
 * BuiltinWorkerAdapter — worker 契约的 builtin 实现（P1：spawn + burst 状态机 + sendInput/resume）。
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
import { join } from 'path'
import { randomUUID } from 'crypto'
import { runEngine, defineTool, createUserMessage } from '../../engine/index.js'
import type { EngineMessage, EngineResult, ToolDefinition } from '../../engine/index.js'
import type { Resolvable } from '../../engine/types.js'
import { SessionTree } from '../session-tree.js'
import { OutputLog } from '../output-log.js'
import { AsyncMutex } from '../async-mutex.js'
import type {
  AdapterCapabilities,
  CapabilityBundle,
  DetectResult,
  IncarnationHandle,
  IncarnationRef,
  IncarnationEndReason,
  OutputCursor,
  SpawnSpec,
  WorkerAdapter,
  WorkerContractState,
  Workspace,
} from '../types.js'

/** fork 是一次性侧问，maxTurns 取小值，避免侧问跑成一次完整任务。 */
const FORK_MAX_TURNS = 8

/**
 * sendInput 打到已 exited 的化身时抛出。透明接续（自动 resume 并重投）是 harness（P3）
 * 的职责，adapter 层保持窄语义，只负责如实报告"这个化身已经结束了"。
 */
export class WorkerExitedError extends Error {
  constructor(
    readonly worker_id: string,
    readonly seq: number,
  ) {
    super(`BuiltinWorkerAdapter: incarnation ${worker_id}#${seq} has exited`)
    this.name = 'WorkerExitedError'
  }
}

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

export class BuiltinWorkerAdapter implements WorkerAdapter {
  readonly implId = 'builtin' as const

  private readonly instances = new Map<string, WorkerInstance>()
  /** worker_id → spawn 时注入的 builtin 执行配置（adapter/model/tools），resume 与续 burst 复用。P1：仅内存，不跨重启持久。 */
  private readonly builtinConfigs = new Map<string, NonNullable<SpawnSpec['builtin']>>()
  /**
   * worker_id → 互斥锁，惰性创建。sendInput 全程、resume 全程、runBurst 的收尾段（判定
   * pendingInputs 到状态落定）都在同一把锁内串行执行——同一化身任意时刻至多一个 burst
   * 在跑是该 adapter 的不变量。runEngine 本身的调用留在锁外，避免并发 sendInput(running)
   * 的入队被一整次 burst 的执行时长堵死。
   */
  private readonly workerMutexes = new Map<string, AsyncMutex>()

  constructor(
    private readonly deps: {
      readonly dataDir: string
      readonly onStateChange?: (h: IncarnationHandle, state: WorkerContractState) => void
    },
  ) {}

  async detect(): Promise<DetectResult> {
    return { installed: true, activated: true }
  }

  async provision(_ws: Workspace, _caps: CapabilityBundle): Promise<void> {
    // P1 空实现：builtin 走现有下发通道，无需单独 provision。
  }

  async spawn(spec: SpawnSpec): Promise<IncarnationHandle> {
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
        state: 'running',
        pendingInputs: [],
      }

      const newHandle: IncarnationHandle = { worker_id: spec.worker_id, seq, impl: 'builtin' }
      // writeMeta 成功之后才注册到 instances/builtinConfigs，跟 resume 保持一致的提交次序：
      // 磁盘失败时不留孤儿实例。注意此时上面的"已 spawn"三重守卫（builtinConfigs 命中 /
      // instances 命中 / 磁盘 meta-${seq}.json 存在）全部落空——writeMeta 还没成功过，没有
      // 一个会命中。调用方重试 spawn 因此不会被拦住，只会在 session.jsonl 里再 append 一个
      // 孤儿根节点（不被任何化身的 tip 引用，是良性的，不影响 pathTo）。
      await this.writeMeta(newInstance)
      this.instances.set(instanceKey(spec.worker_id, seq), newInstance)
      this.builtinConfigs.set(spec.worker_id, builtin)
      return { instance: newInstance, handle: newHandle }
    })

    // fire-and-forget：burst 在后台跑，spawn 立刻以 running 态返回。留在锁外，不然会把
    // runEngine 的整个执行时长堵在锁里，挡住排队的其他 worker_id 无关操作。
    this.runBurst(instance, handle, builtin).catch((err) => this.safetyNetExit(instance, handle, err, 'runBurst'))

    return handle
  }

  async resume(prev: IncarnationRef, wakeInput: string): Promise<IncarnationHandle> {
    const builtin = this.builtinConfigs.get(prev.worker_id)
    if (!builtin) {
      throw new Error(`BuiltinWorkerAdapter.resume: no builtin config resident in memory for worker ${prev.worker_id} (P1: worker must have been spawned in this process)`)
    }

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

      const newSeq = this.nextSeq(prev.worker_id)
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
        state: 'running',
        pendingInputs: [],
      }

      const newHandle: IncarnationHandle = { worker_id: prev.worker_id, seq: newSeq, impl: 'builtin' }
      // writeMeta 成功之后才注册到 instances 并标记 resumed，确保磁盘失败时不留孤儿实例。
      await this.writeMeta(newInstance)
      this.instances.set(instanceKey(prev.worker_id, newSeq), newInstance)
      if (prevInstance) prevInstance.resumed = true
      return { instance: newInstance, handle: newHandle }
    })

    this.runBurst(instance, handle, builtin).catch((err) => this.safetyNetExit(instance, handle, err, 'runBurst (resume)'))

    return handle
  }

  async fork(prev: IncarnationRef, forkInput: string): Promise<IncarnationHandle> {
    const builtin = this.builtinConfigs.get(prev.worker_id)
    if (!builtin) {
      throw new Error(`BuiltinWorkerAdapter.fork: no builtin config resident in memory for worker ${prev.worker_id} (P1: worker must have been spawned in this process)`)
    }

    // fork 不要求 prev 处于任何特定状态——这就是侧问的意义：主线跑着的时候也能问。不像
    // resume 那样校验 assertExited。newSeq 用 nextSeq()，与 resume 共用同一分配逻辑、
    // 在同一把互斥锁内计算，避免二者撞号。append 挂在 prev.session_ref 上是分支，不动
    // 主线 tip——session 树因此分叉，这是 fork 的合法用法（resume/sendInput 的"禁止分叉"
    // 不变量是它们各自场景下的语义，不适用于 fork）。
    const mutex = this.getMutex(prev.worker_id)
    const { instance, handle } = await mutex.run(async () => {
      const dir = join(this.deps.dataDir, prev.worker_id)
      let sessionTree = this.findSessionTreeForWorker(prev.worker_id)
      if (!sessionTree) {
        sessionTree = await SessionTree.load(join(dir, 'session.jsonl'))
      }

      const newSeq = this.nextSeq(prev.worker_id)
      const outputLog = new OutputLog(join(dir, `output-${newSeq}.log`))
      const forkId = await sessionTree.append(prev.session_ref, createUserMessage(forkInput))

      const newInstance: WorkerInstance = {
        worker_id: prev.worker_id,
        seq: newSeq,
        dir,
        sessionTree,
        outputLog,
        tip: forkId,
        state: 'running',
        pendingInputs: [],
      }

      const newHandle: IncarnationHandle = { worker_id: prev.worker_id, seq: newSeq, impl: 'builtin' }
      // writeMeta 成功之后才注册到 instances，和 resume 保持一致的提交次序：磁盘失败时
      // 不留孤儿实例。
      await this.writeMeta(newInstance)
      this.instances.set(instanceKey(prev.worker_id, newSeq), newInstance)
      return { instance: newInstance, handle: newHandle }
    })

    // fire-and-forget：一次性 burst 在后台跑，fork 立刻以 running 态返回。
    this.runForkBurst(instance, handle, builtin).catch((err) => this.safetyNetExit(instance, handle, err, 'runForkBurst'))

    return handle
  }

  async sendInput(h: IncarnationHandle, text: string, _opts?: { raw?: boolean }): Promise<void> {
    // 状态检查 + 相应动作（入队 / append+转running）整体在该 worker 的互斥锁内完成，消除
    // "两次背靠背 sendInput 都读到 idle、拿同一 tip"的 check-then-act 竞态（跨 await 边界）。
    const mutex = this.getMutex(h.worker_id)
    const startBurst = await mutex.run(async () => {
      const instance = this.instances.get(instanceKey(h.worker_id, h.seq))
      if (!instance) {
        throw new Error(`BuiltinWorkerAdapter.sendInput: no such incarnation ${h.worker_id}#${h.seq} resident in this process`)
      }

      if (instance.state === 'exited') {
        throw new WorkerExitedError(h.worker_id, h.seq)
      }

      if (instance.state === 'running') {
        instance.pendingInputs.push(text)
        return false
      }

      // idle → 追加新一轮用户消息，转 running。起 burst 留到锁外（见下）。
      const builtin = this.builtinConfigs.get(h.worker_id)
      if (!builtin) {
        throw new Error(`BuiltinWorkerAdapter.sendInput: no builtin config resident in memory for worker ${h.worker_id}`)
      }
      instance.tip = await instance.sessionTree.append(instance.tip, createUserMessage(text))
      await this.transitionState(instance, h, 'running')
      return true
    })

    if (!startBurst) return

    // burst 的 runEngine 调用本身在锁外：否则并发 sendInput(running) 的入队会被这次
    // burst 的整个执行时长堵死。
    const instance = this.instances.get(instanceKey(h.worker_id, h.seq))!
    const builtin = this.builtinConfigs.get(h.worker_id)!
    this.runBurst(instance, h, builtin).catch((err) => this.safetyNetExit(instance, h, err, 'runBurst (sendInput continuation)'))
  }

  async readOutput(h: IncarnationHandle, cursor: OutputCursor): Promise<{ chunk: string; nextCursor: OutputCursor }> {
    const instance = this.instances.get(instanceKey(h.worker_id, h.seq))
    const outputLog = instance ? instance.outputLog : new OutputLog(join(this.deps.dataDir, h.worker_id, `output-${h.seq}.log`))
    return outputLog.read(cursor)
  }

  async state(h: IncarnationHandle): Promise<WorkerContractState> {
    const instance = this.instances.get(instanceKey(h.worker_id, h.seq))
    if (instance) return instance.state
    const metaPath = join(this.deps.dataDir, h.worker_id, `meta-${h.seq}.json`)
    const raw = await fs.readFile(metaPath, 'utf-8')
    const meta = JSON.parse(raw) as { state: WorkerContractState }
    return meta.state
  }

  async kill(h: IncarnationHandle): Promise<void> {
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
        orphans.push({ worker_id, seq, impl: 'builtin' })
      }
    }

    return orphans
  }

  capabilities(): AdapterCapabilities {
    return { fork: true, revive: true, goalMode: true, subagent: true, structuredTrace: true }
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

  private async runBurst(
    instance: WorkerInstance,
    handle: IncarnationHandle,
    builtin: NonNullable<SpawnSpec['builtin']>,
  ): Promise<void> {
    const tip = instance.tip
    const initialMessages = instance.sessionTree.pathTo(tip)
    const mutex = this.getMutex(instance.worker_id)

    // 每次进入 runBurst（含续 burst 的递归调用）都换一个新 AbortController，供 kill() abort。
    // 安装与 killRequested 核对必须在同一把锁内原子完成，和 kill() 的"置位+abort"共享该锁：
    // 否则会有窗口——kill 已经决定要杀这个（还没起的）新 burst，但读到的 abortController
    // 还是上一个已经跑完的 burst 的，abort 它没有任何效果，新 burst 照样起来（P1 全分支
    // 终审 Important，见 kill() 顶部注释）。已置位则不装 controller、不起 runEngine，直接
    // 在锁内落 exited(killed)。
    const abortController = await mutex.run(async () => {
      if (instance.killRequested) {
        await this.transitionExited(instance, handle, 'killed')
        return undefined
      }
      const ac = new AbortController()
      instance.abortController = ac
      return ac
    })
    if (!abortController) return

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
    const result: EngineResult = await runEngine({
      prompt: '',
      adapter: builtin.adapter,
      initialMessages,
      options: {
        systemPrompt: builtin.systemPrompt,
        tools: this.combineTools(builtin.tools),
        model: builtin.model,
        ...(builtin.maxTurnsPerBurst !== undefined ? { maxTurns: builtin.maxTurnsPerBurst } : {}),
        // session 树以原始消息为真相源，burst 内禁用压缩。压缩与树的协同（折叠节点）是 P7 集成议题。
        disableCompaction: true,
        abortSignal: abortController.signal,
        onTurn: (event) => {
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
        `[builtin-adapter] runBurst: ${writeErrors.length} outputLog.append write(s) failed for worker ${instance.worker_id}: ` +
        writeErrors.map((e) => (e instanceof Error ? e.message : String(e))).join('; '),
      )
    }

    // 收尾段（压缩防御 → append 新消息 → 判 outcome → 判队列 → 落 idle/续 burst）整体在该
    // worker 的互斥锁内原子完成：消除"同步判定 pendingInputs 为空后 await transitionState
    // 期间新 sendInput 插队"的窗口——判定与状态落定必须是同一个不可分割的临界区。
    // 续 burst 的递归调用放在锁外触发（见下），不然会把 runEngine 的执行时长堵在锁里。
    const continueBurst = await mutex.run(async () => {
      // burst 结束：把新增消息（finalMessages 相对 initialMessages 的后缀）逐条 append 进 session 树。
      // 防御断言：若压缩被意外启用，finalMessages.length 会小于 initialMessages.length，
      // 此时不回写新消息，标化身为 exited(crashed) 并记日志。
      if (result.finalMessages.length < initialMessages.length) {
        console.error(
          `[builtin-adapter] runBurst compaction guard triggered for worker ${instance.worker_id}: ` +
          `finalMessages.length (${result.finalMessages.length}) < initialMessages.length (${initialMessages.length}). ` +
          `Compaction was unexpectedly enabled; marking incarnation as crashed.`,
        )
        await this.transitionExited(instance, handle, 'crashed')
        return false
      }
      const newMessages = result.finalMessages.slice(initialMessages.length)
      let parent = tip
      for (const msg of newMessages as EngineMessage[]) {
        parent = await instance.sessionTree.append(parent, msg)
      }
      instance.tip = parent

      if (result.outcome === 'failed' || result.outcome === 'aborted') {
        await this.transitionExited(instance, handle, result.outcome === 'aborted' ? 'killed' : 'crashed')
        return false
      }

      if (result.exitToolCall?.name === 'finish_task') {
        const rawOutcome = result.exitToolCall.input.outcome
        const outcome: 'completed' | 'failed' = rawOutcome === 'failed' ? 'failed' : 'completed'
        await this.transitionExited(instance, handle, outcome, outcome)
        return false
      }

      // burst 正常收尾（非 aborted/failed/finish_task）但期间 killRequested 已被置位：
      // abort 大概率是打在了这次 burst 身上（下面 outcome==='aborted' 分支已经处理），但也
      // 可能是打晚了——engine 已经决定 end_turn，abort 信号没赶上（P1 全分支终审 Important
      // 收尾段检查点）。无论如何都不能继续/续 burst，直接落 exited(killed)。
      if (instance.killRequested) {
        await this.transitionExited(instance, handle, 'killed')
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

      await this.transitionState(instance, handle, 'idle')
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
    const tip = instance.tip
    const initialMessages = instance.sessionTree.pathTo(tip)
    const mutex = this.getMutex(instance.worker_id)

    // fork 化身同样支持被 kill() abort——见 runBurst 里对应注释，同样的窗口①在 fork 的
    // 一次性 burst 上也存在：fork() 把新化身以 running 态注册、锁外 fire-and-forget 起
    // runForkBurst，安装 controller 前先在锁内核对 killRequested。
    const abortController = await mutex.run(async () => {
      if (instance.killRequested) {
        await this.transitionExited(instance, handle, 'killed')
        return undefined
      }
      const ac = new AbortController()
      instance.abortController = ac
      return ac
    })
    if (!abortController) return

    // 同 runBurst：push 时立即挂 catch，避免 append 在长时间跑的 burst 期间 reject 却
    // 没有 handler，触发 unhandledRejection 打崩进程。错误收集到 writeErrors，
    // Promise.all 后统一抛出，走 fork() 处包给 this.runForkBurst(...) 的安全网 catch
    // （crashed 收尾），与 runBurst 保持一致的错误语义。
    const pendingWrites: Promise<void>[] = []
    const writeErrors: unknown[] = []
    const result: EngineResult = await runEngine({
      prompt: '',
      adapter: builtin.adapter,
      initialMessages,
      options: {
        systemPrompt: builtin.systemPrompt,
        tools: builtin.tools,
        model: builtin.model,
        maxTurns: FORK_MAX_TURNS,
        disableCompaction: true,
        abortSignal: abortController.signal,
        onTurn: (event) => {
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
      if (result.finalMessages.length < initialMessages.length) {
        console.error(
          `[builtin-adapter] runForkBurst compaction guard triggered for worker ${instance.worker_id}: ` +
          `finalMessages.length (${result.finalMessages.length}) < initialMessages.length (${initialMessages.length}). ` +
          `Compaction was unexpectedly enabled; marking incarnation as crashed.`,
        )
        await this.transitionExited(instance, handle, 'crashed')
        return
      }
      const newMessages = result.finalMessages.slice(initialMessages.length)
      let parent = tip
      for (const msg of newMessages as EngineMessage[]) {
        parent = await instance.sessionTree.append(parent, msg)
      }
      instance.tip = parent

      if (result.outcome === 'failed' || result.outcome === 'aborted') {
        await this.transitionExited(instance, handle, result.outcome === 'aborted' ? 'killed' : 'crashed')
        return
      }

      // outcome 是正常收尾但 killRequested 已置位：abort 打晚了，engine 已经决定收尾，
      // 但用户明确要求过 kill，不该落 completed（P1 全分支终审 Important 收尾段检查点）。
      if (instance.killRequested) {
        await this.transitionExited(instance, handle, 'killed')
        return
      }

      // 'completed'（end_turn）与 'max_turns' 都视为一次性侧问正常收尾。
      await this.transitionExited(instance, handle, 'completed', 'completed')
    })
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
   */
  private nextSeq(worker_id: string): number {
    let max = 0
    for (const instance of this.instances.values()) {
      if (instance.worker_id === worker_id && instance.seq > max) max = instance.seq
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
    return () => [...resolve(tools), FINISH_TASK_TOOL]
  }

  // 先落盘、再切内存态：state() 优先读内存，若顺序反过来，外部在 writeMeta 的
  // await 期间读 state() 会看到"内存已切但磁盘还是旧值"的窗口。
  private async transitionState(instance: WorkerInstance, handle: IncarnationHandle, state: WorkerContractState): Promise<void> {
    await this.writeMeta(instance, { state })
    instance.state = state
    // 观察者（onStateChange）的异常永远不能中断状态机的推进。任何回调错误都被捕获
    // 并仅作 console.error 记录，防止阻塞状态转移或导致后续 burst/sendInput 卡死。
    try {
      this.deps.onStateChange?.(handle, state)
    } catch (err) {
      console.error(`[BuiltinWorkerAdapter] onStateChange callback error for ${handle.worker_id}#${handle.seq}:`, err)
    }
  }

  private async transitionExited(
    instance: WorkerInstance,
    handle: IncarnationHandle,
    ended_reason: IncarnationEndReason,
    outcome?: 'completed' | 'failed',
  ): Promise<void> {
    if (instance.pendingInputs.length > 0) {
      const deadLetterMsg = `[dead-letter] incarnation ${instance.worker_id}#${instance.seq} exited with ${instance.pendingInputs.length} unsent message(s): ${instance.pendingInputs.join(' | ')}\n`
      await instance.outputLog.append(deadLetterMsg)
    }
    await this.writeMeta(instance, { state: 'exited', ended_reason, outcome })
    instance.state = 'exited'
    instance.ended_reason = ended_reason
    if (outcome !== undefined) instance.outcome = outcome
    // 观察者（onStateChange）的异常永远不能中断状态机的推进。任何回调错误都被捕获
    // 并仅作 console.error 记录，防止阻塞状态转移或导致后续 burst/sendInput 卡死。
    try {
      this.deps.onStateChange?.(handle, 'exited')
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
      ...(ended_reason !== undefined ? { ended_reason } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
    }
    const metaPath = join(instance.dir, `meta-${instance.seq}.json`)
    const tmpPath = join(instance.dir, `.meta-${instance.seq}.json.tmp-${randomUUID()}`)
    await fs.writeFile(tmpPath, JSON.stringify(meta), 'utf-8')
    await fs.rename(tmpPath, metaPath)
  }
}
