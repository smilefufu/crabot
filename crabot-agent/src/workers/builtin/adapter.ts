/**
 * BuiltinWorkerAdapter — worker 契约的 builtin 实现（P1：spawn + burst 状态机）。
 *
 * 每个 worker 落 <dataDir>/<worker_id>/{session.jsonl,output.log,meta.json}。
 * spawn 建目录、把 prompt 作为根节点 append 进 session 树、fire-and-forget 起一个
 * "burst"（一次 runEngine 调用），随即以 running 态返回。burst 结束后按 engine
 * outcome / exitToolCall 迁移到 idle 或 exited，meta.json 原子写。
 *
 * resume/fork/sendInput/kill 留给后续 task（Task 6-8）。
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { runEngine, defineTool, createUserMessage } from '../../engine/index.js'
import type { EngineMessage, EngineResult, ToolDefinition } from '../../engine/index.js'
import type { Resolvable } from '../../engine/types.js'
import { SessionTree } from '../session-tree.js'
import { OutputLog } from '../output-log.js'
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

const NOT_IMPLEMENTED = 'not implemented until Task 6-8'

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
    const outputLog = new OutputLog(join(dir, 'output.log'))
    await sessionTree.append(null, createUserMessage(spec.prompt))

    const instance: WorkerInstance = {
      worker_id: spec.worker_id,
      seq,
      dir,
      sessionTree,
      outputLog,
      state: 'running',
    }
    this.instances.set(instanceKey(spec.worker_id, seq), instance)

    const handle: IncarnationHandle = { worker_id: spec.worker_id, seq, impl: 'builtin' }
    await this.writeMeta(instance)

    // fire-and-forget：burst 在后台跑，spawn 立刻以 running 态返回。
    this.runBurst(instance, handle, spec.builtin).catch(async (err) => {
      // 安全网：runBurst 内部已经把 runEngine 的失败路径处理成 exited(crashed)，
      // 这里只兜住真正意外的同步/异步抛错（比如 append 磁盘写失败）。
      console.error('[builtin-adapter] runBurst threw unexpectedly:', err)
      await this.transitionExited(instance, handle, 'crashed')
    })

    return handle
  }

  async resume(_prev: IncarnationRef, _wakeInput: string): Promise<IncarnationHandle> {
    throw new Error(NOT_IMPLEMENTED)
  }

  async fork(_prev: IncarnationRef, _forkInput: string): Promise<IncarnationHandle> {
    throw new Error(NOT_IMPLEMENTED)
  }

  async sendInput(_h: IncarnationHandle, _text: string, _opts?: { raw?: boolean }): Promise<void> {
    throw new Error(NOT_IMPLEMENTED)
  }

  async readOutput(h: IncarnationHandle, cursor: OutputCursor): Promise<{ chunk: string; nextCursor: OutputCursor }> {
    const instance = this.instances.get(instanceKey(h.worker_id, h.seq))
    const outputLog = instance ? instance.outputLog : new OutputLog(join(this.deps.dataDir, h.worker_id, 'output.log'))
    return outputLog.read(cursor)
  }

  async state(h: IncarnationHandle): Promise<WorkerContractState> {
    const instance = this.instances.get(instanceKey(h.worker_id, h.seq))
    if (instance) return instance.state
    const metaPath = join(this.deps.dataDir, h.worker_id, 'meta.json')
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
        onTurn: (event) => {
          if (event.assistantText) {
            pendingWrites.push(instance.outputLog.append(event.assistantText + '\n'))
          }
        },
      },
    })
    await Promise.all(pendingWrites)

    // burst 结束：把新增消息（finalMessages 相对 initialMessages 的后缀）逐条 append 进 session 树。
    const newMessages = result.finalMessages.slice(initialMessages.length)
    let parent = tip
    for (const msg of newMessages as EngineMessage[]) {
      parent = await instance.sessionTree.append(parent, msg)
    }

    if (result.outcome === 'failed' || result.outcome === 'aborted') {
      await this.transitionExited(instance, handle, result.outcome === 'aborted' ? 'killed' : 'crashed')
      return
    }

    if (result.exitToolCall?.name === 'finish_task') {
      const rawOutcome = result.exitToolCall.input.outcome
      const outcome: 'completed' | 'failed' = rawOutcome === 'failed' ? 'failed' : 'completed'
      await this.transitionExited(instance, handle, outcome, outcome)
      return
    }

    // end_turn（或 max_turns 耗尽）→ idle，等待下一次 resume/sendInput 唤醒。
    await this.transitionState(instance, handle, 'idle')
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
    const metaPath = join(instance.dir, 'meta.json')
    const tmpPath = join(instance.dir, `.meta.json.tmp-${randomUUID()}`)
    await fs.writeFile(tmpPath, JSON.stringify(meta), 'utf-8')
    await fs.rename(tmpPath, metaPath)
  }
}
