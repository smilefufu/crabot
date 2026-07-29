/**
 * ClaudeCodeAdapter — WorkerAdapter 契约的 claude-code 实现(spawn/sendInput/state/kill 的
 * 核心生命周期)。resume/fork/readTrace 留给 Task 5,本文件里抛 not-implemented。
 *
 * spawn:session_id = randomUUID() 出生即定(即 session_ref);建 <dataDir>/<worker_id>/ 目录;
 * tmux newSession 拉起 `<claudeBin> --session-id <uuid> --permission-mode acceptEdits`,交互态
 * 跑在 tmux pane 里,cwd=workspace,pane 输出经 tmux pipe-pane 落 output-<seq>.log;meta 落盘为
 * running;首条任务输入(spec.prompt)经 tmux sendText 注入(cc 把它当第一条用户消息)。
 *
 * provision:与 spawn 分离的独立步骤(WorkerAdapter 契约本就是两个方法),由调用方在 spawn 前
 * 调用一次,把 workspace 布好——.claude/settings.json(Stop/Notification hook 接到
 * CliEventChannel.hookCommand,permissions 预配置 acceptEdits 降弹窗)、.claude/skills/(复用
 * Task 3 的 materializeSkills)、.mcp.json(renderMcpJson)、CLAUDE.md(renderContextMd)。
 *
 * spawn 提交纪律:tmux newSession 成功之后才落 meta(running)+注册 runtime——newSession 失败
 * 时不留任何持久痕迹(session_id 可重生成,workspace 内 provision 产物残留可接受),同 worker_id
 * 可安全重试 spawn。首条输入(sendText)失败:此时已注册的化身按 kill 路径清理 tmux 会话后落
 * exited(crashed)(不是 killed——这不是用户发起的 kill),不放任 running;spawn 仍然 reject。
 *
 * state 三源合成,按优先级依次判定(前一源给出确定结果就不再看后一源):
 *   1. 事件文件:自上一次 sendInput(或 spawn)以来出现过新的 'stop' 事件 → idle;
 *   2. tmux isAlive() 为 false → exited(是否 killed 由本地 killed 标记区分 killed/completed);
 *   3. 默认 running。
 * 用"自上次输入以来的 stop 计数"(stopBaseline)而非"是否曾经见过 stop"来判定,是因为
 * cc 每答完一轮都会再触发一次 Stop——sendInput 时必须把 baseline 推到当前计数,否则上一轮
 * 遗留的 stop 事件会让新一轮还没答完就被误判成 idle。
 *
 * 状态判定(读事件基线/isAlive)与提交(改内存 + 写 meta)整体在该 worker 的互斥锁内原子完成
 * (锁按 worker 粒度,不阻塞其他 worker;isAlive 是 tmux 子进程调用,锁内执行可接受)——避免
 * "判定用的是过期快照,提交时才发现已被另一次并发调用改写"的窗口:两次并发 state() 若只在
 * 提交这一步加锁,后完成判定的那次会拿着过期快照无条件覆盖先完成的那次刚落的新鲜结果。
 * 判定与提交现在是同一个不可分割的临界区,保证 exited 终态不可覆盖、也不丢并发更新。
 *
 * sendInput:活会话直接 tmux sendText(cc 自带 steering 队列,不需要我们排队);raw 选项走
 * tmux sendKeys(text 按空白切分成按键名数组,如 "y Enter" → ['y','Enter']);exited 态抛
 * WorkerExitedError(与 builtin 同名同语义的独立类,不 import builtin)。
 *
 * kill:tmux killSession → exited(killed),幂等(已 exited 直接返回,不覆盖原 ended_reason)。
 *
 * meta-<seq>.json 布局沿用 P1:{ seq, state, session_id, ended_reason? },写法抽到
 * src/workers/meta-store.ts 共享(不改 builtin 自己的 writeMeta)。
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { TmuxDriver } from '../tmux/driver.js'
import { CliEventChannel } from '../cli-events.js'
import { OutputLog } from '../output-log.js'
import { AsyncMutex } from '../async-mutex.js'
import { writeMetaAtomic } from '../meta-store.js'
import { materializeSkills, renderMcpJson, renderContextMd, type ProvisionSources } from '../provision/materialize.js'
import type {
  AdapterCapabilities,
  CapabilityBundle,
  DetectResult,
  IncarnationEndReason,
  IncarnationHandle,
  IncarnationRef,
  NormalizedTraceEvent,
  OutputCursor,
  SpawnSpec,
  TraceCursor,
  WorkerAdapter,
  WorkerContractState,
  Workspace,
} from '../types.js'

/** sendInput 打到已 exited 的化身时抛出。与 builtin 的同名类语义一致,各自独立定义(不共享 import)。 */
export class WorkerExitedError extends Error {
  constructor(
    readonly worker_id: string,
    readonly seq: number,
  ) {
    super(`ClaudeCodeAdapter: incarnation ${worker_id}#${seq} has exited`)
    this.name = 'WorkerExitedError'
  }
}

/** hook 事件文件路径约定:workspace 内 .claude/events-cli.jsonl。provision 与 spawn 都按此约定定位,保持一致。 */
export function eventsFilePath(ws: Workspace): string {
  return join(ws.root, '.claude', 'events-cli.jsonl')
}

interface Runtime {
  readonly worker_id: string
  readonly seq: number
  readonly dir: string
  readonly sessionName: string
  readonly sessionId: string
  readonly outputLog: OutputLog
  readonly eventChannel: CliEventChannel
  state: WorkerContractState
  ended_reason?: IncarnationEndReason
  /** 自上一次 sendInput(或 spawn)以来"已计入"的 stop 事件数;新 stop 数超过它才判定本轮 idle。 */
  stopBaseline: number
  killed: boolean
}

function instanceKey(h: { worker_id: string; seq: number }): string {
  return `${h.worker_id}#${h.seq}`
}

export class ClaudeCodeAdapter implements WorkerAdapter {
  readonly implId = 'claude-code' as const

  private readonly tmux: TmuxDriver
  private readonly claudeBin: string
  private readonly runtimes = new Map<string, Runtime>()
  private readonly mutexes = new Map<string, AsyncMutex>()

  constructor(
    private readonly deps: {
      readonly dataDir: string
      readonly claudeBin?: string
      readonly tmux?: TmuxDriver
      readonly onStateChange?: (h: IncarnationHandle, state: WorkerContractState) => void
    },
  ) {
    this.tmux = deps.tmux ?? new TmuxDriver()
    this.claudeBin = deps.claudeBin ?? 'claude'
  }

  async detect(): Promise<DetectResult> {
    // 占位:真实探测(claude 二进制是否存在/是否已登录)留给 Task 5。
    return { installed: false, activated: false, detail: 'ClaudeCodeAdapter.detect: not implemented until Task 5' }
  }

  async provision(ws: Workspace, caps: CapabilityBundle): Promise<void> {
    const claudeDir = join(ws.root, '.claude')
    // hook 写入目录必须先 mkdir——printf >> 对缺目录静默失败(Task 2 评审裁决)。
    await fs.mkdir(claudeDir, { recursive: true })

    const channel = new CliEventChannel(eventsFilePath(ws))
    const settings = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: channel.hookCommand('stop') }] }],
        Notification: [{ hooks: [{ type: 'command', command: channel.hookCommand('notification') }] }],
      },
      // --permission-mode acceptEdits 已在命令行传了,这里在 settings.json 里重复声明一份,
      // 覆盖命令行参数之外(如未来 --resume)也走同一降弹窗策略的场景。
      permissions: { defaultMode: 'acceptEdits' },
    }
    await fs.writeFile(join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n', 'utf-8')

    await materializeSkills(ws.root, caps.skills, '.claude/skills')

    const mcpServers = caps.mcp_servers as unknown as ProvisionSources['mcpServers']
    await fs.writeFile(join(ws.root, '.mcp.json'), renderMcpJson(mcpServers), 'utf-8')

    await fs.writeFile(
      join(ws.root, 'CLAUDE.md'),
      renderContextMd({
        workerId: workerIdLabelFromWorkspace(ws),
        taskTitle: 'Crabot Worker Task',
        disciplines: '中间产物统一写入工作区内,不要写到工作区之外的路径。',
      }),
      'utf-8',
    )
  }

  async spawn(spec: SpawnSpec): Promise<IncarnationHandle> {
    const seq = 1
    const handle: IncarnationHandle = { worker_id: spec.worker_id, seq, impl: 'claude-code' }
    if (this.runtimes.has(instanceKey(handle))) {
      throw new Error(`ClaudeCodeAdapter.spawn: worker_id ${spec.worker_id} already spawned in this process`)
    }

    const dir = join(this.deps.dataDir, spec.worker_id)
    await fs.mkdir(dir, { recursive: true })

    const sessionId = randomUUID()
    const sessionName = `crabot-w-${spec.worker_id}-${seq}`
    const outputFile = join(dir, `output-${seq}.log`)
    const command = `${this.claudeBin} --session-id ${sessionId} --permission-mode acceptEdits`

    // newSession 成功之后才落 meta(running)+注册 runtime:tmux 失败时不留任何持久痕迹
    // (session_id 可重生成,workspace 内 provision 产物残留可接受),同 worker_id 可安全重试。
    await this.tmux.newSession({ name: sessionName, cwd: spec.workspace.root, command, outputFile })

    const runtime: Runtime = {
      worker_id: spec.worker_id,
      seq,
      dir,
      sessionName,
      sessionId,
      outputLog: new OutputLog(outputFile),
      eventChannel: new CliEventChannel(eventsFilePath(spec.workspace)),
      state: 'running',
      stopBaseline: 0,
      killed: false,
    }

    await writeMetaAtomic(dir, seq, { seq, state: 'running', session_id: sessionId })
    this.runtimes.set(instanceKey(handle), runtime)

    // 首条任务输入经 sendText 注入,cc 把它当第一条用户消息。注入失败:session 可能已经起来
    // 但没喂到任务,不能放任 running——按 kill 路径清理 tmux 会话后落 exited(crashed)(不是
    // killed,这不是用户发起的 kill),spawn 仍然 reject 把失败如实报给调用方。
    try {
      await this.tmux.sendText(sessionName, spec.prompt)
    } catch (err) {
      await this.getMutex(handle.worker_id).run(async () => {
        if (runtime.state === 'exited') return
        await this.tmux.killSession(sessionName)
        await this.transitionExited(runtime, handle, 'crashed')
      })
      throw err
    }

    return handle
  }

  async resume(_prev: IncarnationRef, _wakeInput: string): Promise<IncarnationHandle> {
    throw new Error('ClaudeCodeAdapter.resume: not implemented until Task 5')
  }

  async fork(_prev: IncarnationRef, _forkInput: string): Promise<IncarnationHandle> {
    throw new Error('ClaudeCodeAdapter.fork: not implemented until Task 5')
  }

  async sendInput(h: IncarnationHandle, text: string, opts?: { raw?: boolean }): Promise<void> {
    const runtime = this.runtimes.get(instanceKey(h))
    if (!runtime) {
      throw new Error(`ClaudeCodeAdapter.sendInput: no such incarnation ${h.worker_id}#${h.seq} resident in this process`)
    }

    const { state: current, stopCount } = await this.syncState(runtime, h)
    if (current === 'exited') throw new WorkerExitedError(h.worker_id, h.seq)

    // 新一轮开始:把 baseline 推到当前 stop 计数,上一轮遗留的 stop 事件不会被误算进新一轮。
    runtime.stopBaseline = stopCount

    if (opts?.raw) {
      const keys = text.split(/\s+/).filter((k) => k.length > 0)
      await this.tmux.sendKeys(runtime.sessionName, keys)
    } else {
      await this.tmux.sendText(runtime.sessionName, text)
    }

    await this.getMutex(h.worker_id).run(async () => {
      if (runtime.state !== 'exited') await this.transitionState(runtime, h, 'running')
    })
  }

  async readOutput(h: IncarnationHandle, cursor: OutputCursor): Promise<{ chunk: string; nextCursor: OutputCursor }> {
    const runtime = this.runtimes.get(instanceKey(h))
    const outputLog = runtime ? runtime.outputLog : new OutputLog(join(this.deps.dataDir, h.worker_id, `output-${h.seq}.log`))
    return outputLog.read(cursor)
  }

  async state(h: IncarnationHandle): Promise<WorkerContractState> {
    const runtime = this.runtimes.get(instanceKey(h))
    if (!runtime) {
      const metaPath = join(this.deps.dataDir, h.worker_id, `meta-${h.seq}.json`)
      const raw = await fs.readFile(metaPath, 'utf-8')
      const meta = JSON.parse(raw) as { state: WorkerContractState }
      return meta.state
    }
    return (await this.syncState(runtime, h)).state
  }

  async readTrace(_h: IncarnationHandle, _cursor?: TraceCursor): Promise<NormalizedTraceEvent[]> {
    throw new Error('ClaudeCodeAdapter.readTrace: not implemented until Task 5')
  }

  async kill(h: IncarnationHandle): Promise<void> {
    const runtime = this.runtimes.get(instanceKey(h))
    if (!runtime) {
      throw new Error(`ClaudeCodeAdapter.kill: no such incarnation ${h.worker_id}#${h.seq} resident in this process`)
    }
    await this.getMutex(h.worker_id).run(async () => {
      if (runtime.state === 'exited') return // 幂等:不覆盖原 ended_reason
      runtime.killed = true
      await this.tmux.killSession(runtime.sessionName)
      await this.transitionExited(runtime, h, 'killed')
    })
  }

  capabilities(): AdapterCapabilities {
    return { fork: true, revive: true, goalMode: false, subagent: false, structuredTrace: true }
  }

  // --- Internal ---

  /**
   * 三源合成状态判定:事件文件(新 stop → idle) > tmux isAlive(false → exited) > 默认 running。
   * 与内存态不同则在互斥锁内原子迁移(改内存 + 写 meta)。返回判定结果与本次读到的 stop 计数
   * (供 sendInput 复用,避免重复读一遍事件文件)。
   */
  private async syncState(runtime: Runtime, h: IncarnationHandle): Promise<{ state: WorkerContractState; stopCount: number }> {
    if (runtime.state === 'exited') return { state: 'exited', stopCount: runtime.stopBaseline }

    return this.getMutex(h.worker_id).run(async () => {
      // 锁内重读:进锁前 runtime.state 可能已被并发操作(如 kill,或排在前面的另一次
      // syncState)抢先落定为 exited——终态不可覆盖。
      if (runtime.state === 'exited') return { state: 'exited', stopCount: runtime.stopBaseline }

      const events = await runtime.eventChannel.readAll()
      const stopCount = events.filter((e) => e.kind === 'stop').length

      let computed: WorkerContractState
      if (stopCount > runtime.stopBaseline) {
        computed = 'idle'
      } else if (!(await this.tmux.isAlive(runtime.sessionName))) {
        computed = 'exited'
      } else {
        computed = 'running'
      }

      if (computed !== runtime.state) {
        if (computed === 'exited') {
          await this.transitionExited(runtime, h, runtime.killed ? 'killed' : 'completed')
        } else {
          await this.transitionState(runtime, h, computed)
        }
      }

      return { state: runtime.state, stopCount }
    })
  }

  private getMutex(worker_id: string): AsyncMutex {
    let mutex = this.mutexes.get(worker_id)
    if (!mutex) {
      mutex = new AsyncMutex()
      this.mutexes.set(worker_id, mutex)
    }
    return mutex
  }

  private async transitionState(runtime: Runtime, h: IncarnationHandle, state: WorkerContractState): Promise<void> {
    await writeMetaAtomic(runtime.dir, runtime.seq, { seq: runtime.seq, state, session_id: runtime.sessionId })
    runtime.state = state
    try {
      this.deps.onStateChange?.(h, state)
    } catch (err) {
      console.error(`[ClaudeCodeAdapter] onStateChange callback error for ${h.worker_id}#${h.seq}:`, err)
    }
  }

  private async transitionExited(runtime: Runtime, h: IncarnationHandle, ended_reason: IncarnationEndReason): Promise<void> {
    await writeMetaAtomic(runtime.dir, runtime.seq, {
      seq: runtime.seq,
      state: 'exited',
      session_id: runtime.sessionId,
      ended_reason,
    })
    runtime.state = 'exited'
    runtime.ended_reason = ended_reason
    try {
      this.deps.onStateChange?.(h, 'exited')
    } catch (err) {
      console.error(`[ClaudeCodeAdapter] onStateChange callback error for ${h.worker_id}#${h.seq}:`, err)
    }
  }
}

/** CLAUDE.md 里标注的 worker 标签:provision(ws, caps) 拿不到 worker_id,退而取 workspace 目录名兜底。 */
function workerIdLabelFromWorkspace(ws: Workspace): string {
  const trimmed = ws.root.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}
