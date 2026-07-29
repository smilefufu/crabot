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
 * resume：从已 exited 的化身的 session_ref（tip node_id）派生 seq+1 新化身，
 * append wakeInput 后起新 burst。
 *
 * fork/kill 留给后续 task（Task 7-8）。
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

const NOT_IMPLEMENTED = 'not implemented until Task 7-8'

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
  state: WorkerContractState
  ended_reason?: IncarnationEndReason
  outcome?: 'completed' | 'failed'
  /** running 态下经 sendInput 排队、等下一次 burst 间隙统一 append 的用户消息（P1：内存，不跨重启持久）。 */
  pendingInputs: string[]
}

function instanceKey(worker_id: string, seq: number): string {
  return `${worker_id}#${seq}`
}

function resolve<T>(value: Resolvable<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value
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
    const seq = 1
    const dir = join(this.deps.dataDir, spec.worker_id)
    await fs.mkdir(dir, { recursive: true })

    const sessionTree = new SessionTree(join(dir, 'session.jsonl'))
    const outputLog = new OutputLog(join(dir, `output-${seq}.log`))
    await sessionTree.append(null, createUserMessage(spec.prompt))

    const instance: WorkerInstance = {
      worker_id: spec.worker_id,
      seq,
      dir,
      sessionTree,
      outputLog,
      state: 'running',
      pendingInputs: [],
    }
    this.instances.set(instanceKey(spec.worker_id, seq), instance)
    this.builtinConfigs.set(spec.worker_id, spec.builtin)

    const handle: IncarnationHandle = { worker_id: spec.worker_id, seq, impl: 'builtin' }
    await this.writeMeta(instance)

    // fire-and-forget：burst 在后台跑，spawn 立刻以 running 态返回。
    this.runBurst(instance, handle, spec.builtin).catch(async (err) => {
      // 安全网：runBurst 内部已经把 runEngine 的失败路径处理成 exited(crashed)，
      // 这里只兜住真正意外的同步/异步抛错（比如 append 磁盘写失败）。
      console.error('[builtin-adapter] runBurst threw unexpectedly:', err)
      await this.getMutex(instance.worker_id).run(async () => {
        await this.transitionExited(instance, handle, 'crashed')
      })
    })

    return handle
  }

  async resume(prev: IncarnationRef, wakeInput: string): Promise<IncarnationHandle> {
    const builtin = this.builtinConfigs.get(prev.worker_id)
    if (!builtin) {
      throw new Error(`BuiltinWorkerAdapter.resume: no builtin config resident in memory for worker ${prev.worker_id} (P1: worker must have been spawned in this process)`)
    }

    // assertExited + newSeq 计算 + append + 实例注册整体在锁内原子完成：两次并发 resume
    // 同一 prev 若不串行化，会各自算出相同的 newSeq、各自往 prev.session_ref 上挂一个孩子
    // ——树分叉。这里选择"先到先得，后来者报错"的语义：newSeq 对应的实例位一旦被占用，
    // 后来者视为对同一 prev 的重复 resume，直接失败，而不是静默产出第二个化身。
    const mutex = this.getMutex(prev.worker_id)
    const { instance, handle } = await mutex.run(async () => {
      await this.assertExited(prev.worker_id, prev.seq)

      const newSeq = prev.seq + 1
      const newKey = instanceKey(prev.worker_id, newSeq)
      if (this.instances.has(newKey)) {
        throw new Error(`BuiltinWorkerAdapter.resume: incarnation ${newKey} already exists (concurrent resume of the same prev incarnation?)`)
      }

      const dir = join(this.deps.dataDir, prev.worker_id)
      let sessionTree = this.findSessionTreeForWorker(prev.worker_id)
      if (!sessionTree) {
        sessionTree = await SessionTree.load(join(dir, 'session.jsonl'))
      }
      const outputLog = new OutputLog(join(dir, `output-${newSeq}.log`))
      await sessionTree.append(prev.session_ref, createUserMessage(wakeInput))

      const newInstance: WorkerInstance = {
        worker_id: prev.worker_id,
        seq: newSeq,
        dir,
        sessionTree,
        outputLog,
        state: 'running',
        pendingInputs: [],
      }
      this.instances.set(newKey, newInstance)

      const newHandle: IncarnationHandle = { worker_id: prev.worker_id, seq: newSeq, impl: 'builtin' }
      await this.writeMeta(newInstance)
      return { instance: newInstance, handle: newHandle }
    })

    this.runBurst(instance, handle, builtin).catch(async (err) => {
      console.error('[builtin-adapter] runBurst threw unexpectedly (resume):', err)
      await this.getMutex(instance.worker_id).run(async () => {
        await this.transitionExited(instance, handle, 'crashed')
      })
    })

    return handle
  }

  async fork(_prev: IncarnationRef, _forkInput: string): Promise<IncarnationHandle> {
    throw new Error(NOT_IMPLEMENTED)
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
      const tip = instance.sessionTree.latestTip()
      if (tip === null) throw new Error(`BuiltinWorkerAdapter: worker ${instance.worker_id} has empty session tree`)
      await instance.sessionTree.append(tip, createUserMessage(text))
      await this.transitionState(instance, h, 'running')
      return true
    })

    if (!startBurst) return

    // burst 的 runEngine 调用本身在锁外：否则并发 sendInput(running) 的入队会被这次
    // burst 的整个执行时长堵死。
    const instance = this.instances.get(instanceKey(h.worker_id, h.seq))!
    const builtin = this.builtinConfigs.get(h.worker_id)!
    this.runBurst(instance, h, builtin).catch(async (err) => {
      console.error('[builtin-adapter] runBurst threw unexpectedly (sendInput continuation):', err)
      await this.getMutex(instance.worker_id).run(async () => {
        await this.transitionExited(instance, h, 'crashed')
      })
    })
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

  async kill(_h: IncarnationHandle): Promise<void> {
    throw new Error(NOT_IMPLEMENTED)
  }

  capabilities(): AdapterCapabilities {
    return { fork: true, revive: true, goalMode: true, subagent: true, structuredTrace: true }
  }

  // --- Internal: burst execution ---

  private async runBurst(
    instance: WorkerInstance,
    handle: IncarnationHandle,
    builtin: NonNullable<SpawnSpec['builtin']>,
  ): Promise<void> {
    const tip = instance.sessionTree.latestTip()
    if (tip === null) throw new Error(`BuiltinWorkerAdapter: worker ${instance.worker_id} has empty session tree`)
    const initialMessages = instance.sessionTree.pathTo(tip)

    const pendingWrites: Promise<void>[] = []
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
        onTurn: (event) => {
          if (event.assistantText) {
            pendingWrites.push(instance.outputLog.append(event.assistantText + '\n'))
          }
        },
      },
    })
    await Promise.all(pendingWrites)

    // 收尾段（压缩防御 → append 新消息 → 判 outcome → 判队列 → 落 idle/续 burst）整体在该
    // worker 的互斥锁内原子完成：消除"同步判定 pendingInputs 为空后 await transitionState
    // 期间新 sendInput 插队"的窗口——判定与状态落定必须是同一个不可分割的临界区。
    // 续 burst 的递归调用放在锁外触发（见下），不然会把 runEngine 的执行时长堵在锁里。
    const mutex = this.getMutex(instance.worker_id)
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

      // end_turn（或 max_turns 耗尽）→ 若 sendInput 排了队，逐条 append 后原地续 burst
      // （不经过可见的 idle 态）；否则转 idle，等待下一次 resume/sendInput 唤醒。
      if (instance.pendingInputs.length > 0) {
        const queued = instance.pendingInputs.splice(0, instance.pendingInputs.length)
        let queueParent = instance.sessionTree.latestTip()
        if (queueParent === null) throw new Error(`BuiltinWorkerAdapter: worker ${instance.worker_id} has empty session tree`)
        for (const text of queued) {
          queueParent = await instance.sessionTree.append(queueParent, createUserMessage(text))
        }
        return true
      }

      await this.transitionState(instance, handle, 'idle')
      return false
    })

    if (continueBurst) {
      await this.runBurst(instance, handle, builtin)
    }
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
    this.deps.onStateChange?.(handle, state)
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
    this.deps.onStateChange?.(handle, 'exited')
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
      tip_node_id: instance.sessionTree.latestTip(),
      ...(ended_reason !== undefined ? { ended_reason } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
    }
    const metaPath = join(instance.dir, `meta-${instance.seq}.json`)
    const tmpPath = join(instance.dir, `.meta-${instance.seq}.json.tmp-${randomUUID()}`)
    await fs.writeFile(tmpPath, JSON.stringify(meta), 'utf-8')
    await fs.rename(tmpPath, metaPath)
  }
}
