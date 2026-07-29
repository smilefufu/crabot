/**
 * ClaudeCodeAdapter — WorkerAdapter 契约的 claude-code 实现。
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
 *   1. tmux isAlive() 为 false → exited(终态优先,是否 killed 由本地 killed 标记区分
 *      killed/completed)——进程可能在发过 stop 事件之后自退(崩溃/OOM/自敲 exit),必须先判
 *      isAlive,否则 stop 计数恒大于 baseline 会一直判成 idle,永远走不到这条分支;
 *   2. 会话还活着时,事件文件:自上一次 sendInput(或 spawn)以来出现过新的 'stop' 事件 → idle;
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
 *
 * detect:`<claudeBin> --version`(经 `sh -c` 跑,claudeBin 本就是一段 shell 命令片段——
 * 与 spawn 把它塞进 tmux pane 命令是同一语义)成功 → installed;activated 看
 * `dirname(claudeProjectsDir)`(即约定的 `~/.claude/`)下是否有 settings.json 或
 * .credentials.json,不做任何网络调用。
 *
 * resume:先取 prev 化身常驻 runtime(未常驻则报错,P1 同款约束:只能 resume 本进程 spawn 过
 * 的化身),校验其已 exited(未 exited 直接拒绝)→ 新 tmux 会话跑
 * `<claudeBin> --resume <prev.session_ref>`(不重复传 --permission-mode,provision 阶段已把
 * acceptEdits 写进 settings.json 兜底命令行之外的场景)→ seq+1 化身、独立 meta/output、
 * session_ref 原样透传(cc 侧同一个会话 id)。锁纪律与 spawn 一致:tmux newSession 成功后才
 * 提交 meta+runtime,首条 wakeInput(sendText)失败按 kill 路径清理并落 exited(crashed)。
 *
 * fork(侧问,query_worker 的底座):无头一击,不进 tmux——
 * `<claudeBin> -p <forkInput> --resume <prev.session_ref> --fork-session --output-format text`
 * (经 `sh -c` 跑,forkInput/参数逐个 shQuote 转义)子进程 stdout 落到 fork 化身自己的
 * output-<seq>.log;退出码 0 → exited(completed),非 0 → exited(crashed)。为可观测起见,
 * 先在 per-worker 互斥锁内提交一段 meta(running)+注册 runtime,子进程本身(可能耗时较长)在
 * 锁外跑不阻塞同 worker_id 上的其它操作(主线不受影响),跑完后再在锁内提交终态。cc 的
 * --fork-session 在其内部生成一个新会话 id,但 `--output-format text` 的 stdout 不携带它,
 * 拿不到就拿不到——fork 化身的 session_id 落一个本地生成的占位 UUID,不对应真实 cc 会话
 * 文件,该化身自己的 readTrace 会优雅退化为空数组(已知限制,见 Task 5 报告)。
 *
 * readTrace:workspace root 经 cc 的 slug 规则(`/`与`.`都替换成`-`)映射到
 * `<claudeProjectsDir>/<slug>/<session_id>.jsonl`,按行增量解析并归一化——
 * type=user/assistant → kind message(role 对应,summary 取消息文本截 200);assistant 内的
 * tool_use content block → kind tool_call;user 记录带 toolUseResult 字段 → kind
 * tool_result;type=system → kind lifecycle;其余 type(mode/summary/queue-operation 等)跳过。
 * cursor.offset 是行号(非字节偏移);文件不存在时返回空数组(见下方"与 brief 的偏差")。
 * 只能对本进程内常驻 runtime 的化身调用——trace 文件路径依赖 workspace root,而这个信息
 * 只存在于内存 runtime 里,meta.json 不落它。
 */
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { TmuxDriver } from '../tmux/driver.js'
import { CliEventChannel } from '../cli-events.js'
import { OutputLog } from '../output-log.js'
import { AsyncMutex } from '../async-mutex.js'
import { writeMetaAtomic } from '../meta-store.js'
import { WorkerExitedError } from '../errors.js'
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

const execFileAsync = promisify(execFile)

/** POSIX shell 单引号转义,与 tmux/driver.ts 的私有 shQuote 同款用法(独立复制一份)。 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** UUID 格式校验:标准 UUID 格式(8-4-4-4-12 十六进制段,由连字符分隔)。*/
function validateSessionRef(sessionRef: string): void {
  const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
  if (!uuidPattern.test(sessionRef)) {
    throw new Error(
      `ClaudeCodeAdapter: invalid session_ref format (expected UUID, got '${sessionRef.slice(0, 50)}'). ` +
        `session_ref must be a valid UUID and cannot contain shell metacharacters.`,
    )
  }
}

/** Re-export for backward compatibility and convenience. */
export { WorkerExitedError }

/** hook 事件文件路径约定:workspace 内 .claude/events-cli.jsonl。provision 与 spawn 都按此约定定位,保持一致。 */
export function eventsFilePath(ws: Workspace): string {
  return join(ws.root, '.claude', 'events-cli.jsonl')
}

interface Runtime {
  readonly worker_id: string
  readonly seq: number
  readonly dir: string
  readonly workspaceRoot: string
  /** tmux 会话名;fork 化身不进 tmux,恒为空串。 */
  readonly sessionName: string
  readonly sessionId: string
  readonly outputLog: OutputLog
  readonly eventChannel: CliEventChannel
  state: WorkerContractState
  ended_reason?: IncarnationEndReason
  /** 自上一次 sendInput(或 spawn)以来"已计入"的 stop 事件数;新 stop 数超过它才判定本轮 idle。 */
  stopBaseline: number
  killed: boolean
  /** 是否已经被 resume 过一次。resume() 锁内检测"对同一 prev 的重复 resume"(先到先得,
   * 后来者报错),对齐 builtin 同款语义(P2 review #2)。fork 不受此限制。 */
  resumed?: boolean
}

function instanceKey(h: { worker_id: string; seq: number }): string {
  return `${h.worker_id}#${h.seq}`
}

export class ClaudeCodeAdapter implements WorkerAdapter {
  readonly implId = 'claude-code' as const

  private readonly tmux: TmuxDriver
  private readonly claudeBin: string
  private readonly claudeProjectsDir: string
  private readonly runtimes = new Map<string, Runtime>()
  private readonly mutexes = new Map<string, AsyncMutex>()

  constructor(
    private readonly deps: {
      readonly dataDir: string
      readonly claudeBin?: string
      readonly tmux?: TmuxDriver
      /** cc trace 文件根目录,默认 ~/.claude/projects;detect() 的 activated 检查也复用它
       *(取 dirname 得到 ~/.claude/)。测试用可注入 fixture 目录,不依赖开发机真实 home。 */
      readonly claudeProjectsDir?: string
      readonly onStateChange?: (h: IncarnationHandle, state: WorkerContractState) => void
    },
  ) {
    this.tmux = deps.tmux ?? new TmuxDriver()
    this.claudeBin = deps.claudeBin ?? 'claude'
    this.claudeProjectsDir = deps.claudeProjectsDir ?? join(homedir(), '.claude', 'projects')
  }

  async detect(): Promise<DetectResult> {
    let versionOutput: string
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', `${this.claudeBin} --version`])
      versionOutput = stdout.trim()
    } catch (err) {
      return { installed: false, activated: false, detail: `claude binary not found or failed to run: ${(err as Error).message}` }
    }

    const claudeHomeDir = dirname(this.claudeProjectsDir)
    let activated = false
    try {
      const entries = await fs.readdir(claudeHomeDir)
      activated = entries.includes('settings.json') || entries.includes('.credentials.json')
    } catch {
      activated = false
    }

    return { installed: true, activated, detail: versionOutput }
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
    const sessionId = randomUUID()
    const handle: IncarnationHandle = { worker_id: spec.worker_id, seq, impl: 'claude-code', session_ref: sessionId }
    if (this.runtimes.has(instanceKey(handle))) {
      throw new Error(`ClaudeCodeAdapter.spawn: worker_id ${spec.worker_id} already spawned in this process`)
    }

    const dir = join(this.deps.dataDir, spec.worker_id)
    await fs.mkdir(dir, { recursive: true })

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
      workspaceRoot: spec.workspace.root,
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

  async resume(prev: IncarnationRef, wakeInput: string): Promise<IncarnationHandle> {
    // API 边界校验:session_ref 必须是有效 UUID 格式,防止 shell 注入
    validateSessionRef(prev.session_ref)

    const prevRuntime = this.runtimes.get(instanceKey(prev))
    if (!prevRuntime) {
      throw new Error(`ClaudeCodeAdapter.resume: no such incarnation ${prev.worker_id}#${prev.seq} resident in this process`)
    }
    const prevHandle: IncarnationHandle = { worker_id: prev.worker_id, seq: prev.seq, impl: 'claude-code', session_ref: prev.session_ref }
    const { state: prevState } = await this.syncState(prevRuntime, prevHandle)
    if (prevState !== 'exited') {
      throw new Error(`ClaudeCodeAdapter.resume: incarnation ${prev.worker_id}#${prev.seq} has not exited yet (state=${prevState})`)
    }

    const dir = prevRuntime.dir

    // 重复 resume 检测(先到先得)+ seq 分配(nextSeq(),该 worker 现存所有化身 max seq + 1)+
    // tmux newSession + 提交(meta+runtime+resumed 标记)整体在该 worker 的互斥锁内原子完成:
    // - nextSeq() 不能再用 prev.seq+1 这种固定公式:fork 化身常驻 runtimes 不删,prev.seq+1
    //   可能早被更早一次 fork/resume 占用,继续用它会在"已存在"检查上假死(见文件头注释、
    //   P2 review #1)。newSession 只是起一个 tmux pane(不等待 CLI 完整应答),放进锁内不
    //   违反"耗时较长操作留在锁外"的纪律——那条纪律是专门针对 fork() 的无头子进程调用
    //   (等一整轮 CLI 应答,可能耗时较长)定的,见 fork() 注释。
    // - nextSeq() 修好撞号之后,并发/连续对同一 exited prev 的 resume 各自都能分到不撞号
    //   的 seq、各起一个 tmux 会话跑 --resume 同一 session_ref——语义上变成了对同一个 cc
    //   会话的并行续接,不是 resume 想要的语义。对齐 builtin 的 resumed 标记:prev 一旦被
    //   某次 resume 占用就不能再被 resume,后来者直接报错(不产出第二个化身)。resumed 标记
    //   必须在 writeMeta 成功之后才提交,保证失败路径(newSession 抛错)幂等可重试:若在
    //   此之前失败,resumed 仍未被设置,后续重试不会被"已 resume"拒绝(P2 review #2)。
    let handle!: IncarnationHandle
    let runtime!: Runtime
    await this.getMutex(prev.worker_id).run(async () => {
      if (prevRuntime.resumed) {
        throw new Error(`ClaudeCodeAdapter.resume: incarnation ${prev.worker_id}#${prev.seq} already resumed (concurrent resume of the same prev incarnation?)`)
      }
      const seq = this.nextSeq(prev.worker_id)
      handle = { worker_id: prev.worker_id, seq, impl: 'claude-code', session_ref: prev.session_ref }
      const sessionName = `crabot-w-${prev.worker_id}-${seq}`
      const outputFile = join(dir, `output-${seq}.log`)
      // 不重复传 --permission-mode:provision 阶段已把 acceptEdits 写进 settings.json,覆盖
      // 命令行没有重复声明的场景(resume 正是这样的场景)。session_ref 是 cc 侧的会话 uuid,
      // 沿用不变。拼接时用 shQuote 转义 session_ref,防止 shell 注入(双层防御:
      // 入口已校验 UUID 格式,拼接时再加引号转义,提高防御深度)。
      const command = `${this.claudeBin} --resume ${shQuote(prev.session_ref)}`

      // 锁纪律与 spawn 一致:tmux newSession 成功之后才落 meta(running)+注册 runtime。
      await this.tmux.newSession({ name: sessionName, cwd: prevRuntime.workspaceRoot, command, outputFile })

      runtime = {
        worker_id: prev.worker_id,
        seq,
        dir,
        workspaceRoot: prevRuntime.workspaceRoot,
        sessionName,
        sessionId: prev.session_ref,
        outputLog: new OutputLog(outputFile),
        eventChannel: new CliEventChannel(eventsFilePath({ root: prevRuntime.workspaceRoot })),
        state: 'running',
        stopBaseline: 0,
        killed: false,
      }

      await writeMetaAtomic(dir, seq, { seq, state: 'running', session_id: prev.session_ref })
      this.runtimes.set(instanceKey(handle), runtime)
      prevRuntime.resumed = true
    })

    // 首条 wakeInput 注入失败:按 spawn 同款纪律处理——已注册的化身清理 tmux 会话后落
    // exited(crashed)(不是 killed,不是用户发起的 kill),resume 仍然 reject。
    try {
      await this.tmux.sendText(runtime.sessionName, wakeInput)
    } catch (err) {
      await this.getMutex(handle.worker_id).run(async () => {
        if (runtime.state === 'exited') return
        await this.tmux.killSession(runtime.sessionName)
        await this.transitionExited(runtime, handle, 'crashed')
      })
      throw err
    }

    return handle
  }

  async fork(prev: IncarnationRef, forkInput: string): Promise<IncarnationHandle> {
    // API 边界校验:session_ref 必须是有效 UUID 格式,防止 shell 注入
    validateSessionRef(prev.session_ref)

    const prevRuntime = this.runtimes.get(instanceKey(prev))
    if (!prevRuntime) {
      throw new Error(`ClaudeCodeAdapter.fork: no such incarnation ${prev.worker_id}#${prev.seq} resident in this process`)
    }

    const dir = prevRuntime.dir
    // cc 的 --fork-session 在其内部生成一个新会话 id,--output-format text 的 stdout 不
    // 携带它,拿不到就拿不到:这里落一个本地占位 uuid,不对应真实 cc 会话文件(已知限制)。
    const sessionId = randomUUID()

    // seq 分配(nextSeq(),该 worker 现存所有化身 max seq + 1)+ 提交一段 meta(running)+
    // 注册 runtime 整体在 per-worker 互斥锁内完成——不能再用 prev.seq+1 这种固定公式:fork
    // 化身常驻 runtimes 不删,对同一个 prev 连续 fork 两次,prev.seq+1 算出来的号位第二次会
    // 撞上第一次已经占用的那个,而不是真正分配到空位(见文件头注释、P2 review #1)。nextSeq()
    // 与锁内的注册在同一次 mutex.run 内完成,保证分配即生效,不会被并发的另一次
    // fork/resume 抢到同一个号位。
    let handle!: IncarnationHandle
    let runtime!: Runtime
    await this.getMutex(prev.worker_id).run(async () => {
      const seq = this.nextSeq(prev.worker_id)
      handle = { worker_id: prev.worker_id, seq, impl: 'claude-code', session_ref: sessionId }
      const outputFile = join(dir, `output-${seq}.log`)
      runtime = {
        worker_id: prev.worker_id,
        seq,
        dir,
        workspaceRoot: prevRuntime.workspaceRoot,
        sessionName: '',
        sessionId,
        outputLog: new OutputLog(outputFile),
        eventChannel: new CliEventChannel(eventsFilePath({ root: prevRuntime.workspaceRoot })),
        state: 'running',
        stopBaseline: 0,
        killed: false,
      }
      await writeMetaAtomic(dir, seq, { seq, state: 'running', session_id: sessionId })
      this.runtimes.set(instanceKey(handle), runtime)
    })

    // 无头一击,不进 tmux:子进程在锁外跑(可能耗时较长),不阻塞同 worker_id 上其它操作
    // (主线不受影响)。claudeBin 与 spawn/resume 同款语义——一段 shell 命令片段,经 sh -c
    // 跑;forkInput 与其它参数逐个 shQuote 转义,防止内容里的 shell 元字符注入。
    const args = ['-p', forkInput, '--resume', prev.session_ref, '--fork-session', '--output-format', 'text']
    const shellCommand = `${this.claudeBin} ${args.map(shQuote).join(' ')}`

    let stdout = ''
    let endedReason: IncarnationEndReason
    try {
      const result = await execFileAsync('/bin/sh', ['-c', shellCommand], { cwd: prevRuntime.workspaceRoot })
      stdout = result.stdout
      endedReason = 'completed'
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? ''
      endedReason = 'crashed'
    }

    if (stdout) await runtime.outputLog.append(stdout)

    await this.getMutex(prev.worker_id).run(async () => {
      if (runtime.state === 'exited') return // 幂等兜底
      await this.transitionExited(runtime, handle, endedReason)
    })

    return handle
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
    if (runtime) return (await this.syncState(runtime, h)).state

    // 无常驻 runtime(典型场景:agent 进程重启后新建的 adapter 实例,内存里还没有这个化身
    // 的 runtime)——tmux 会话名是确定性命名(`crabot-w-<worker_id>-<seq>`,spawn/resume 落盘
    // 时的同一约定),不依赖内存态也能重建,先做一次真实存活探测,而不是无条件回落读可能
    // 早已过期的 meta 值(P3 Task 9 评审发现的缺口:旧实现在无 runtime 时直接读 meta,分不清
    // "tmux 会话仍活着"与"已经真死",reconcileOnStartup 对 cc/codex 只能照抄重启前的旧值,
    // 可能把一个真实已死的化身误判成 revived)。
    //
    // isAlive===false 时一律判 exited,不管 meta 写的是什么——消除"真死判活"的假阳性,是
    // 本次修复要解决的核心问题;这个分支不需要 meta 文件的任何字段,连读都不读。
    const sessionName = `crabot-w-${h.worker_id}-${h.seq}`
    if (!(await this.tmux.isAlive(sessionName))) return 'exited'

    // 会话仍存活:退回读 meta 的 running/idle——这只是"最近一次内存态 syncState 写盘时的
    // 快照",精度有限(不代表此刻真实的 running/idle,可能已经又转了几轮而这个进程从未
    // 观察到过),但至少不会再把一个真实存活的会话误判成 exited。未来若要提升精度,可以在
    // 无 runtime 时也经 CliEventChannel 读一遍事件文件(与 syncState 同款三源合成逻辑);
    // 这次修复先只解决"真死判活"这个更严重的假阳性,不做那一步。meta 文件缺失/损坏时的
    // 既有兜底语义(直接抛错)保持不变,不在这里额外兜底。
    const metaPath = join(this.deps.dataDir, h.worker_id, `meta-${h.seq}.json`)
    const raw = await fs.readFile(metaPath, 'utf-8')
    const meta = JSON.parse(raw) as { state: WorkerContractState }
    return meta.state
  }

  async readTrace(h: IncarnationHandle, cursor?: TraceCursor): Promise<{ events: NormalizedTraceEvent[]; nextCursor: TraceCursor }> {
    const runtime = this.runtimes.get(instanceKey(h))
    if (!runtime) {
      // trace 文件路径依赖 workspace root,这个信息只存在于内存 runtime 里(meta.json 不落
      // 它),不像 readOutput 那样有约定路径可以脱离内存重建。
      throw new Error(`ClaudeCodeAdapter.readTrace: no such incarnation ${h.worker_id}#${h.seq} resident in this process`)
    }

    const slug = projectSlug(runtime.workspaceRoot)
    const filePath = join(this.claudeProjectsDir, slug, `${runtime.sessionId}.jsonl`)

    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf-8')
    } catch (err) {
      // 文件缺失(化身还没写过 trace,或 fork 化身的占位 session_id 本就对不上真实文件)
      // 退化为空数组,cursor 原样透传——没有新内容可消费,调用方下次仍从原位置续读。
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], nextCursor: cursor ?? { offset: 0 } }
      throw err
    }

    // 半行纪律(对齐 cli-events.ts watch()):trace 文件由 cc 持续追加、这里懒解析式轮询读取,
    // 读到写入中途是常态。split 末尾要么是空串(文本以 \n 结尾)要么是尚未写完的半行,两种
    // 情况都不能当"已消费的完整行"处理——统一 pop 掉,不产事件也不推进 nextCursor,保证
    // 下次连同补全后的内容重新完整读取该行,不会永久丢事件。
    const rawLines = raw.split('\n')
    rawLines.pop()
    const lines = rawLines.filter((line) => line.length > 0)
    const start = cursor?.offset ?? 0
    const events: NormalizedTraceEvent[] = []
    // nextCursor.offset 是"实际消费到的行号",不是 start + events.length——归一化失败/不认识
    // 的 type(mode/summary/queue-operation 等)不产事件但仍然消费了一行,调用方若用
    // offset += events.length 来推进游标,会在这些被跳过的行上重复读或漏读(P2 review #4,
    // 契约见 protocol-agent-v3 §6.1 WorkerAdapter.readTrace;RPC 层 §8.3 GetWorkerTraceResult
    // 的 next_cursor 由这个 offset 序列化而来)。
    let consumed = start
    for (let i = start; i < lines.length; i++) {
      const event = normalizeTraceLine(lines[i])
      if (event) events.push(event)
      consumed = i + 1
    }
    return { events, nextCursor: { offset: consumed } }
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
   * 三源合成状态判定:tmux isAlive(false → exited,终态优先) > 事件文件(会话还活着时,新
   * stop → idle) > 默认 running。与内存态不同则在互斥锁内原子迁移(改内存 + 写 meta)。
   * 返回判定结果与本次读到的 stop 计数(供 sendInput 复用,避免重复读一遍事件文件)。
   */
  private async syncState(runtime: Runtime, h: IncarnationHandle): Promise<{ state: WorkerContractState; stopCount: number }> {
    if (runtime.state === 'exited') return { state: 'exited', stopCount: runtime.stopBaseline }

    return this.getMutex(h.worker_id).run(async () => {
      // 锁内重读:进锁前 runtime.state 可能已被并发操作(如 kill,或排在前面的另一次
      // syncState)抢先落定为 exited——终态不可覆盖。
      if (runtime.state === 'exited') return { state: 'exited', stopCount: runtime.stopBaseline }

      const events = await runtime.eventChannel.readAll()
      const stopCount = events.filter((e) => e.kind === 'stop').length

      // isAlive 检查提到最前(终态优先):进程可能在发过 stop 事件之后自退(崩溃/OOM/自敲
      // exit)——stopCount 恒 > baseline 会一直判成 idle,永远走不到下面的 isAlive 分支,
      // 化身不落 exited,resume 被永久拒绝(P2 review #2)。会话已经不在了就直接 exited,
      // 不管有没有新 stop 事件;只有会话还活着,才轮到 stop 事件区分 idle/running。
      let computed: WorkerContractState
      if (!(await this.tmux.isAlive(runtime.sessionName))) {
        computed = 'exited'
      } else if (stopCount > runtime.stopBaseline) {
        computed = 'idle'
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

  /**
   * worker_id 对应下一个可用的化身序号:该 worker 现存所有化身(主线 + fork 分支 + resume
   * 链)里最大 seq + 1。resume() 和 fork() 共用这一个分配逻辑,且都在各自的 mutex.run 内
   * 调用,保证互不撞号(fork 化身常驻不删,不能用 prev.seq+1 这种固定公式——见 fork()/
   * resume() 注释)。与 builtin adapter 的同名方法同一思路。
   */
  private nextSeq(worker_id: string): number {
    let max = 0
    for (const runtime of this.runtimes.values()) {
      if (runtime.worker_id === worker_id && runtime.seq > max) max = runtime.seq
    }
    return max + 1
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

/** cc 的 project 目录 slug 规则:cwd 路径里的 `/` 与 `.` 都替换成 `-`(已用真实 ~/.claude/projects/ 核实)。 */
function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/** message.content 既可能是纯字符串,也可能是 content block 数组;后者只取 text 块拼接,跳过 thinking/tool_use/tool_result。 */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text?: string } => !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
  }
  return ''
}

/**
 * 归一化单行 cc trace JSONL 为 NormalizedTraceEvent;不认识的行(JSON 解析失败、或
 * type 不在 user/assistant/system 之内,如 mode/summary/queue-operation 等)返回 null 跳过。
 */
function normalizeTraceLine(line: string): NormalizedTraceEvent | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const ts = typeof parsed.timestamp === 'string' ? parsed.timestamp : ''

  if (parsed.type === 'system') {
    const summary = typeof parsed.content === 'string' ? truncate(parsed.content, 200) : String(parsed.subtype ?? 'system')
    return { ts, kind: 'lifecycle', role: 'system', summary, detail: parsed }
  }

  if (parsed.type === 'user') {
    if ('toolUseResult' in parsed) {
      const result = parsed.toolUseResult
      const summary = truncate(typeof result === 'string' ? result : JSON.stringify(result ?? {}), 200)
      return { ts, kind: 'tool_result', role: 'user', summary, detail: result }
    }
    const message = parsed.message as { content?: unknown } | undefined
    const text = extractMessageText(message?.content)
    return { ts, kind: 'message', role: 'user', summary: truncate(text, 200), detail: message }
  }

  if (parsed.type === 'assistant') {
    const message = parsed.message as { content?: unknown } | undefined
    const content = message?.content
    if (Array.isArray(content)) {
      const toolUse = content.find(
        (block): block is { type: 'tool_use'; name: string; input?: unknown } =>
          !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_use',
      )
      if (toolUse) {
        const summary = truncate(`${toolUse.name}(${JSON.stringify(toolUse.input ?? {})})`, 200)
        return { ts, kind: 'tool_call', role: 'assistant', summary, detail: toolUse }
      }
    }
    const text = extractMessageText(content)
    return { ts, kind: 'message', role: 'assistant', summary: truncate(text, 200), detail: message }
  }

  return null
}
