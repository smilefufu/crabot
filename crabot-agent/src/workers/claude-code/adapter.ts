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
 * Task 3 的 materializeSkills)、.mcp.json(renderMcpJson)、CLAUDE.md(renderContextMd),
 * 外加全局 ~/.claude.json 里该 workspace 的信任记录(trustWorkspace,消掉首次进入新目录的
 * 信任弹窗——它发生在 --permission-mode 之前,命令行拦不住)。
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
 * resume:先经 ensureRuntime 取 prev 化身的 runtime(常驻内存直接用,否则从落盘 meta 重建,
 * 四轮 review 修复;meta 也没有才报错——不再要求"只能 resume 本进程 spawn 过的化身"),校验
 * 其已 exited(未 exited 直接拒绝)→ 新 tmux 会话跑
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
 * 无头进程的 hook 事件经 env(CliEventChannel.EVENTS_FILE_ENV)重定向到 fork 化身私有的
 * `fork-events-<seq>.jsonl`,不写 workspace 共享的那份——否则侧问收尾会污染主线的 stop
 * 计数(详见 fork() 内 execOpts 注释)。
 *
 * readTrace:workspace root 经 cc 的 slug 规则(`/`与`.`都替换成`-`)映射到
 * `<claudeProjectsDir>/<slug>/<session_id>.jsonl`,按行增量解析并归一化——
 * type=user/assistant → kind message(role 对应,summary 取消息文本截 200);assistant 内的
 * tool_use content block → kind tool_call;user 记录带 toolUseResult 字段 → kind
 * tool_result;type=system → kind lifecycle;其余 type(mode/summary/queue-operation 等)跳过。
 * cursor.offset 是行号(非字节偏移);文件不存在时返回空数组(见下方"与 brief 的偏差")。
 * trace 文件路径依赖 workspace root——经 ensureRuntime 从 meta 的 workspace_root 字段
 * (四轮 review 新增持久化)重建,不再要求"只能对本进程内常驻 runtime 的化身调用";老化身
 * (升级前写的 meta 缺这个字段)时拒绝并给出可诊断错误,不是本次修复能补的历史缺口。
 */
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { TmuxDriver } from '../tmux/driver.js'
import { CliEventChannel, EVENTS_FILE_ENV } from '../cli-events.js'
import { OutputLog } from '../output-log.js'
import { decodeTerminalOutput } from '../terminal-output.js'
import { AsyncMutex } from '../async-mutex.js'
import { writeMetaAtomic, maxSeqOnDisk } from '../meta-store.js'
import { WorkerExitedError } from '../errors.js'
import { materializeSkills, renderMcpJson, renderContextMd, type ProvisionSources } from '../provision/materialize.js'
import type {
  AdapterCapabilities,
  CapabilityBundle,
  DetectResult,
  IncarnationEndReason,
  StateChangeReport,
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

/** 全局 ~/.claude.json 的读-改-写互斥锁,按文件路径共享(module 级,跨 adapter 实例生效)。
 * cc 的信任表是**全局单文件**(与 codex 写 workspace 内 config.toml 的天然隔离相反),多个
 * worker 并发 provision 时若各读各写,后写的一份会整份覆盖先写的,先写的那条信任记录丢失 →
 * 那个 worker 照样卡弹窗。跨进程侧 cc 自己也不加锁,同类竞态无法单方面消除,这里只保证
 * 本进程内(agent 是单实例,worker provision 全在这一个进程里)串行。 */
const claudeConfigMutexes = new Map<string, AsyncMutex>()
function claudeConfigMutex(path: string): AsyncMutex {
  let m = claudeConfigMutexes.get(path)
  if (!m) {
    m = new AsyncMutex()
    claudeConfigMutexes.set(path, m)
  }
  return m
}

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
  /** CliEventChannel.watch() 的停止函数(协议 §6.2.3 的文件监视)。tmux 化身在建立
   * runtime 时装上、落终态时摘掉;无头 fork 化身不装(见 startEventWatch)。 */
  stopEventWatch?: () => void
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
  private readonly claudeConfigPath: string
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
      /** cc 的全局配置文件(信任表所在),默认 ~/.claude.json。测试注入临时路径,
       * 避免往开发机的真实文件里写 workspace 记录。 */
      readonly claudeConfigPath?: string
      /**
       * `report.lastText` 本 adapter 刻意不报(理由见 transitionState 注释),只报
       * `report.endReason`:`transitionExited` 拿到的那个**必填**的 `ended_reason`。不报的
       * 话这个值会在回调这一跳被丢掉,harness 只能猜。
       *
       * 注意可信度(协议 §6.3):cc 的退出判定唯一依据是 `tmux.isAlive`——"会话消失且不是
       * 我们 kill 的"一律记 `completed`,这是**推断**,不是任务真的成功。把它如实上抛的
       * 意义在于:猜测点收敛到唯一有资格猜的这一层(只有 adapter 知道是不是自己 kill 的),
       * 且将来接上真实终态信号时只改这里、harness 不用再动。
       */
      readonly onStateChange?: (h: IncarnationHandle, state: WorkerContractState, report?: StateChangeReport) => void
    },
  ) {
    this.tmux = deps.tmux ?? new TmuxDriver()
    this.claudeBin = deps.claudeBin ?? 'claude'
    this.claudeProjectsDir = deps.claudeProjectsDir ?? join(homedir(), '.claude', 'projects')
    this.claudeConfigPath = deps.claudeConfigPath ?? join(homedir(), '.claude.json')
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

    await this.trustWorkspace(ws.root)

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

  /** 把 workspace 预置成"已信任",消灭 cc 首次进入新目录时的信任弹窗。
   *
   * m2 实测(cc 2.1.220):交互式启动遇到没见过的目录会先弹
   * `Do you trust this folder?`,这个检查发生在 `--permission-mode` **之前**,命令行没有
   * 任何 flag 能跳过——v3 给每个 worker 都建新 workspace,不预置就每次必卡:tmux 会话在、
   * 台账 running,但 hook 一次都不触发(生产实测 69 分钟零事件,events-cli.jsonl 都不存在)。
   * 开关是全局 ~/.claude.json 里 `projects["<路径>"].hasTrustDialogAccepted = true`。
   *
   * 路径必须用 realpath:cc 自己写入这张表时用的是解析过软链的路径(如 macOS 上 /tmp →
   * /private/tmp),用逻辑路径预写实测完全无效、弹窗照旧。与 codex 侧写
   * `[projects."<realpath>"] trust_level = "trusted"` 同一策略(见 codex/adapter.ts 的
   * provision),差别只在 cc 这张表是**全局共享单文件**,所以要加锁 + 原子替换 + 只补字段。
   *
   * 失败一律抛错(fail-loud),不吞:
   * - 吞掉 → worker 重新静默卡回弹窗,而这个故障态在外部看来是"running 但永远没动静",
   *   正是本次要根治的、最难诊断的那个现象;
   * - 文件存在但解析不出来时更不能兜底重写——用户真实项目的条目和登录信息都在同一份文件里,
   *   宁可 provision 失败(spawn 之前,不留半个 worker),也不能把它覆盖掉。
   * 文件不存在是正常情形(全新机器),按空配置创建。 */
  private async trustWorkspace(root: string): Promise<void> {
    const realRoot = await fs.realpath(root)
    const configPath = this.claudeConfigPath

    await claudeConfigMutex(configPath).run(async () => {
      let raw: string | undefined
      let mode: number | undefined
      try {
        raw = await fs.readFile(configPath, 'utf-8')
        // 只取权限位:原文件是 0644 还是 0600 都原样保留,不因为我们改一次配置就动它的权限。
        mode = (await fs.stat(configPath)).mode & 0o777
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`ClaudeCodeAdapter.provision: cannot read ${configPath} to pre-accept workspace trust: ${(err as Error).message}`)
        }
      }

      let config: Record<string, unknown> = {}
      if (raw !== undefined && raw.trim() !== '') {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch (err) {
          throw new Error(
            `ClaudeCodeAdapter.provision: ${configPath} is not valid JSON (${(err as Error).message}); ` +
              `refusing to rewrite it — fix or remove the file, then retry`,
          )
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error(`ClaudeCodeAdapter.provision: ${configPath} is not a JSON object; refusing to rewrite it`)
        }
        config = parsed as Record<string, unknown>
      }

      const existingProjects = config.projects
      if (existingProjects !== undefined && (typeof existingProjects !== 'object' || existingProjects === null || Array.isArray(existingProjects))) {
        throw new Error(`ClaudeCodeAdapter.provision: ${configPath} has a non-object "projects" field; refusing to rewrite it`)
      }
      const projects = { ...((existingProjects as Record<string, unknown>) ?? {}) }
      const entry = projects[realRoot]
      const merged = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? { ...(entry as Record<string, unknown>) } : {}
      // 只补这一个字段:同一个 path 下可能已有 allowedTools / history 等用户数据,不能覆盖。
      merged.hasTrustDialogAccepted = true
      projects[realRoot] = merged
      config.projects = projects

      // 原子替换:先写同目录临时文件再 rename,避免进程/机器在写一半时挂掉留下半截 JSON——
      // 这份文件是用户全局配置,截断的代价远大于一次 provision 失败。
      const tmpPath = `${configPath}.crabot-${randomUUID()}.tmp`
      try {
        await fs.writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: mode ?? 0o600 })
        await fs.rename(tmpPath, configPath)
      } catch (err) {
        await fs.rm(tmpPath, { force: true }).catch(() => {})
        throw new Error(`ClaudeCodeAdapter.provision: cannot write ${configPath} to pre-accept workspace trust: ${(err as Error).message}`)
      }
    })
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

    const eventChannel = new CliEventChannel(eventsFilePath(spec.workspace))
    const runtime: Runtime = {
      worker_id: spec.worker_id,
      seq,
      dir,
      workspaceRoot: spec.workspace.root,
      sessionName,
      sessionId,
      outputLog: new OutputLog(outputFile),
      eventChannel,
      state: 'running',
      stopBaseline: await this.initialStopBaseline(eventChannel),
      killed: false,
    }

    await writeMetaAtomic(dir, seq, { seq, state: 'running', session_id: sessionId, workspace_root: spec.workspace.root })
    this.runtimes.set(instanceKey(handle), runtime)
    this.startEventWatch(runtime, handle)

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

    // 四轮 review 修复:prevRuntime 不再要求"常驻本进程"——resume 的合法目标本来就是一个
    // 已终态的化身(它自己的 tmux 会话必然已经不在了),ensureRuntime 从落盘 meta 重建它
    // (见该方法注释:重建不以 tmux 存活为门槛,只有 meta 完全不存在才返回 undefined)。
    const prevRuntime = await this.ensureRuntime(prev)
    if (!prevRuntime) {
      throw new Error(`ClaudeCodeAdapter.resume: no such incarnation ${prev.worker_id}#${prev.seq} resident in this process`)
    }
    const prevHandle: IncarnationHandle = { worker_id: prev.worker_id, seq: prev.seq, impl: 'claude-code', session_ref: prev.session_ref }
    const { state: prevState } = await this.syncState(prevRuntime, prevHandle)
    if (prevState !== 'exited') {
      throw new Error(`ClaudeCodeAdapter.resume: incarnation ${prev.worker_id}#${prev.seq} has not exited yet (state=${prevState})`)
    }
    // 重建出的 prevRuntime 若来自缺 workspace_root 的老 meta(升级前写入,已知限制,见
    // ensureRuntime 注释),workspaceRoot 退化为空串——不能把空串悄悄当 cwd 传给 tmux
    // newSession,显式拒绝并给出可诊断的错误,而不是让 newSession 之后以费解的方式失败。
    if (!prevRuntime.workspaceRoot) {
      throw new Error(
        `ClaudeCodeAdapter.resume: cannot rebuild workspace for ${prev.worker_id}#${prev.seq} ` +
          `(meta.json predates workspace_root persistence; this incarnation cannot be resumed after an adapter restart)`,
      )
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
      const seq = await this.nextSeq(prev.worker_id)
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

      const eventChannel = new CliEventChannel(eventsFilePath({ root: prevRuntime.workspaceRoot }))
      runtime = {
        worker_id: prev.worker_id,
        seq,
        dir,
        workspaceRoot: prevRuntime.workspaceRoot,
        sessionName,
        sessionId: prev.session_ref,
        outputLog: new OutputLog(outputFile),
        eventChannel,
        state: 'running',
        // 复用上一化身的 workspace ⇒ 事件文件里已有它留下的 stop 事件,基线必须现读现算。
        stopBaseline: await this.initialStopBaseline(eventChannel),
        killed: false,
      }

      await writeMetaAtomic(dir, seq, { seq, state: 'running', session_id: prev.session_ref, workspace_root: prevRuntime.workspaceRoot })
      this.runtimes.set(instanceKey(handle), runtime)
      this.startEventWatch(runtime, handle)
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

    // fork 不检查 prevRuntime 是否存活(cc 的 --fork-session 无头一击直接靠 --resume 打给
    // cc 自己的会话文件,不依赖任何 tmux pane 还在跑)——ensureRuntime 因此对 fork 同样适用:
    // 只要 meta 还在,不管 tmux 会话死活都能重建出这里需要的 dir/workspaceRoot。
    const prevRuntime = await this.ensureRuntime(prev)
    if (!prevRuntime) {
      throw new Error(`ClaudeCodeAdapter.fork: no such incarnation ${prev.worker_id}#${prev.seq} resident in this process`)
    }
    if (!prevRuntime.workspaceRoot) {
      // 重建自缺 workspace_root 的老 meta(已知限制,见 ensureRuntime 注释)——fork 的子进程
      // cwd 依赖它,不能悄悄传空串。
      throw new Error(
        `ClaudeCodeAdapter.fork: cannot rebuild workspace for ${prev.worker_id}#${prev.seq} ` +
          `(meta.json predates workspace_root persistence; this incarnation cannot be forked after an adapter restart)`,
      )
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
    // 侧问收尾的 stop 事件必须落到 fork 化身自己的事件文件,不能进 workspace 共享的那份
    // (见下方 execFileAsync 的 env 注释)。
    let forkEventsFile!: string
    await this.getMutex(prev.worker_id).run(async () => {
      const seq = await this.nextSeq(prev.worker_id)
      handle = { worker_id: prev.worker_id, seq, impl: 'claude-code', session_ref: sessionId }
      const outputFile = join(dir, `output-${seq}.log`)
      forkEventsFile = join(dir, `fork-events-${seq}.jsonl`)
      runtime = {
        worker_id: prev.worker_id,
        seq,
        dir,
        workspaceRoot: prevRuntime.workspaceRoot,
        sessionName: '',
        sessionId,
        outputLog: new OutputLog(outputFile),
        eventChannel: new CliEventChannel(forkEventsFile),
        state: 'running',
        stopBaseline: 0,
        killed: false,
      }
      await writeMetaAtomic(dir, seq, { seq, state: 'running', session_id: sessionId, workspace_root: prevRuntime.workspaceRoot })
      this.runtimes.set(instanceKey(handle), runtime)
    })

    // 无头一击,不进 tmux:子进程在锁外跑(可能耗时较长),不阻塞同 worker_id 上其它操作
    // (主线不受影响)。claudeBin 与 spawn/resume 同款语义——一段 shell 命令片段,经 sh -c
    // 跑;forkInput 与其它参数逐个 shQuote 转义,防止内容里的 shell 元字符注入。
    const args = ['-p', forkInput, '--resume', prev.session_ref, '--fork-session', '--output-format', 'text']
    const shellCommand = `${this.claudeBin} ${args.map(shQuote).join(' ')}`

    // 事件文件重定向:cc 的 hooks 在 print 模式同样执行,而 Stop hook 配在 **workspace 级**
    // 的 .claude/settings.json 里、写的是 **workspace 级**共享的 events-cli.jsonl——不重定向
    // 的话,侧问收尾会往主线正在用的那份事件文件追加一条 stop,污染主线的 stop 计数:主线
    // 跑到一半被 watcher 判成 idle 推一条假唤醒,而它真正跑完这一轮时因为"状态没变"不再
    // 产生迁移,真正的轮次边界唤醒被整条吞掉。侧问按设计就是在主线还在跑的时候发起的
    // (queryWorker 把 fork 放在锁外、不阻塞主线),这不是罕见时序。
    // 这里给子进程 env 塞一个 fork 化身私有的事件文件路径,cc 拉起 hook 子进程时原样继承
    // 下去,hook 写私有文件(见 CliEventChannel.EVENTS_FILE_ENV)。交互态(tmux pane)不设
    // 这个变量,照旧写共享文件,行为不变。
    const execOpts = { cwd: prevRuntime.workspaceRoot, env: { ...process.env, [EVENTS_FILE_ENV]: forkEventsFile } }

    let stdout = ''
    let endedReason: IncarnationEndReason
    try {
      const result = await execFileAsync('/bin/sh', ['-c', shellCommand], execOpts)
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
    // 四轮 review 修复:重启后新建的 adapter 实例 runtimes 必为空,旧实现在这里直接抛通用
    // Error("no such incarnation...resident in this process")——harness 只对 WorkerExitedError
    // 转透明接续,通用 Error 会原样穿透砸给调用方,消息永久卡在队首(protocol-agent-v3 §13
    // "tmux worker 独立存活 → 重启后 harness 重连接管"在操作层的失效)。改用 ensureRuntime
    // 从落盘 meta 重建;它拿不到任何记录(真·未知化身)时,对 sendInput 的调用方而言效果
    // 与"已终态"等价(harness 的透明接续兜底不区分这两种情况),同样抛 WorkerExitedError。
    const runtime = await this.ensureRuntime(h)
    if (!runtime) throw new WorkerExitedError(h.worker_id, h.seq)

    const { state: current, stopCount } = await this.syncState(runtime, h)
    // 带上 ended_reason:harness 的透明接续要用它给"台账还没追上"的源化身补终态。
    // 上面 `!runtime` 那条分支给不出原因(重启后连落盘 meta 都读不回来),如实缺省。
    if (current === 'exited') throw new WorkerExitedError(h.worker_id, h.seq, runtime.ended_reason)

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

  /**
   * 落盘的是 tmux `pipe-pane` 抓的**输出流**(TUI 逐帧重绘的转义序列增量),不是纯文本。
   * 解码只发生在这条返回路径上(见 `terminal-output.ts`),磁盘上的原文一字不动。
   */
  async readOutput(h: IncarnationHandle, cursor: OutputCursor): Promise<{ chunk: string; nextCursor: OutputCursor }> {
    const runtime = this.runtimes.get(instanceKey(h))
    const outputLog = runtime ? runtime.outputLog : new OutputLog(join(this.deps.dataDir, h.worker_id, `output-${h.seq}.log`))
    return outputLog.read(cursor, undefined, decodeTerminalOutput)
  }

  /**
   * P3 Task 9 修复"无常驻 runtime 时不做真实存活探测就照抄 meta 旧值"的假阳性(tmux 会话
   * 名是确定性命名,不依赖内存态也能重建),四轮 review 进一步把这套重建逻辑收拢进
   * ensureRuntime,供 sendInput/kill/resume/fork/state/readTrace 共用(见该方法注释)。
   * ensureRuntime 返回 undefined 只有"落盘 meta 也完全不存在"这一种情形(真·未知化身)——
   * 与旧实现"tmux 会话不存在则返回 exited"的兜底语义一致,直接判 exited。
   */
  async state(h: IncarnationHandle): Promise<WorkerContractState> {
    const runtime = await this.ensureRuntime(h)
    if (!runtime) return 'exited'
    return (await this.syncState(runtime, h)).state
  }

  async readTrace(h: IncarnationHandle, cursor?: TraceCursor): Promise<{ events: NormalizedTraceEvent[]; nextCursor: TraceCursor }> {
    // 四轮 review 修复:trace 文件路径依赖 workspace root,以前这个信息只存在于内存 runtime
    // 里(meta.json 不落它),不像 readOutput 那样有约定路径可以脱离内存重建——ensureRuntime
    // 现在从 meta 里的 workspace_root 字段(本轮新增持久化)重建它,readTrace 因此也能在
    // 无常驻 runtime 时工作,不再是"只能对本进程内常驻的化身调用"。
    const runtime = await this.ensureRuntime(h)
    if (!runtime) {
      throw new Error(`ClaudeCodeAdapter.readTrace: no such incarnation ${h.worker_id}#${h.seq} resident in this process`)
    }
    if (!runtime.workspaceRoot) {
      // 重建自缺 workspace_root 的老 meta(升级前写入,已知限制,见 ensureRuntime 注释)。
      throw new Error(
        `ClaudeCodeAdapter.readTrace: cannot rebuild workspace for ${h.worker_id}#${h.seq} ` +
          `(meta.json predates workspace_root persistence; trace unavailable after an adapter restart)`,
      )
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
    // 四轮 review 修复:重启后新建的 adapter 实例对已经确已终态(或压根没有落盘记录)的
    // 化身调 kill,以前直接抛通用 Error,harness.killWorker/handoffIncarnation 对此没有
    // try/catch,错误会穿透打断整个操作(半成品:HANDOFF.md 已写、旧化身未标 superseded 却
    // 卡死)。ensureRuntime 拿不到任何落盘记录时直接幂等返回(无事可做);拿到时 runtime.state
    // 已经是探活得到的真实值,下面既有的 exited 幂等分支自然覆盖"会话已经不在了"的情形。
    const runtime = await this.ensureRuntime(h)
    if (!runtime) return
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
   * 四轮 review 修复:重启后新建的 adapter 实例 `runtimes` 必为空,以前 sendInput/kill/
   * resume/fork/readTrace 在这种情况下清一色直接抛通用 Error("no such incarnation ...
   * resident in this process")——这个错误不是 WorkerExitedError,harness 只对
   * WorkerExitedError 转透明接续,通用 Error 会原样穿透砸给调用方,消息永久卡在队首、
   * kill 抛错用户无法终止、switchWorkerImpl 半成品重复追加 HANDOFF.md(§13"tmux worker
   * 独立存活 → 重启后 harness 重连接管"在操作层的失效;Task 10 只修了 state() 自己的探活
   * 分支,这次把同一探活逻辑收拢成所有操作共用的单一重建入口)。
   *
   * runtimes 命中直接返回。未命中时读 meta-<seq>.json——**meta 完全不存在**(从未 spawn
   * 过,或目录已被清理)是唯一返回 undefined 的情形,调用方据此判断"真·未知化身"。
   *
   * 关键设计取舍:tmux 会话是否还活着**不**作为"能不能重建"的门槛,只影响重建出的
   * `runtime.state` 取值('exited'/'running')。原因:resume()/fork() 的合法调用目标本来
   * 就是一个已终态的化身——它自己的 tmux 会话必然已经不在了;若"会话不存在"直接返回
   * undefined,重启后 resume 永远无法工作,正好背离本轮修复的目的。改为让重建出的
   * runtime.state 如实反映一次真实 tmux isAlive 探测的结果(不采信 meta 里可能陈旧的
   * state 字段),后续操作各自基于这个准确的 state 得到正确行为:
   *   - sendInput:见该方法注释,`runtime.state==='exited'` 时既有的 syncState 快路径
   *     自然产出 WorkerExitedError,等价于"ensureRuntime 直接返回 undefined ⇒ 抛
   *     WorkerExitedError"这一表面语义(仅当 meta 也不存在时才真的走这条兜底分支)。
   *   - kill:既有的 exited 幂等分支(不重复 kill、不覆盖 ended_reason)天然覆盖"会话
   *     已经不在了"的情形,不需要在 kill() 里另外判断。
   *   - resume/fork:重建成功即可拿到 dir/workspaceRoot 继续走下去,不受 tmux 死活影响。
   *
   * workspace_root 是本轮修复新增进 meta 的持久化项(spawn/resume/fork/transitionState/
   * transitionExited 统一写入)。老化身(升级前写的 meta)缺这个字段时按已知限制降级——
   * workspaceRoot 退化为空串,eventChannel 指向一个不存在的占位路径(CliEventChannel.readAll
   * 对不存在的文件返回空数组,不抛错,只是探测不到新 stop 事件,不影响 exited 判定,因为
   * 那条判定只依赖 tmux isAlive,不依赖事件文件)。resume()/fork()/readTrace() 在真正需要
   * workspaceRoot 时(tmux newSession 的 cwd、execFile 的 cwd、trace 文件路径)显式拒绝并
   * 给出可诊断错误,不把空串悄悄传下去。
   *
   * stopBaseline 重建时刻起算新基线(当前已存在的 stop 事件数):不知道历史 baseline,把
   * "此刻已经存在的 stop 事件"当作已核销,避免重启前遗留的 stop 事件被误判成本轮新完成
   * (与 spawn()/sendInput() 推进 baseline 的动机一致)——代价是重建后首次 syncState 之前
   * 无法准确复原"当时到底是 running 还是 idle"这个精细区分(只影响 idle 报告精度,不影响
   * exited 判定的正确性,是可接受的已知限制)。
   *
   * **重建整体在 per-worker 互斥锁内完成**(锁内再查一次 map):重启后同一化身被并发首次
   * 触达(如启动对账的 state() 与 recovery 触发的 sendInput() 同时到达)是常态,而
   * "runtimes.get 未命中"到"runtimes.set"之间隔着 readMetaFile / isAlive / readAll 三个
   * await。不加锁时两次调用各自重建一个 Runtime、各装一个 watcher,后 set 的胜出;败者却被
   * 自己 watcher 的闭包持有——transitionExited 只摘胜者的,败者的 fs.watch + 2s 轮询到进程
   * 退出为止一直活着,每个 stop 事件两边各迁移一次,harness 收到两次 onStateChange、manager
   * 被重复唤醒,持续整个进程生命周期。锁内重查让后来者直接复用前一次的成果,不产出第二个
   * runtime,也就没有第二个 watcher 可泄漏。
   */
  private async ensureRuntime(ref: { worker_id: string; seq: number; session_ref?: string }): Promise<Runtime | undefined> {
    const key = instanceKey(ref)
    const existing = this.runtimes.get(key)
    if (existing) return existing

    return this.getMutex(ref.worker_id).run(async () => {
      // 锁内重查:排在前面的另一次 ensureRuntime 可能已经重建好了(见方法注释)。
      const resident = this.runtimes.get(key)
      if (resident) return resident

      const dir = join(this.deps.dataDir, ref.worker_id)
      const meta = await this.readMetaFile(dir, ref.seq)
      if (!meta) return undefined

      const sessionName = `crabot-w-${ref.worker_id}-${ref.seq}`
      const alive = await this.tmux.isAlive(sessionName)
      const workspaceRoot = meta.workspace_root ?? ''
      const sessionId = meta.session_id ?? ref.session_ref ?? ''
      const outputFile = join(dir, `output-${ref.seq}.log`)
      const eventsPath = workspaceRoot ? eventsFilePath({ root: workspaceRoot }) : join(dir, `.no-workspace-events-${ref.seq}.jsonl`)
      const eventChannel = new CliEventChannel(eventsPath)

      let stopBaseline = 0
      if (workspaceRoot) {
        const events = await eventChannel.readAll()
        stopBaseline = events.filter((e) => e.kind === 'stop').length
      }

      const runtime: Runtime = {
        worker_id: ref.worker_id,
        seq: ref.seq,
        dir,
        workspaceRoot,
        sessionName,
        sessionId,
        outputLog: new OutputLog(outputFile),
        eventChannel,
        state: alive ? 'running' : 'exited',
        ended_reason: alive ? undefined : meta.ended_reason,
        stopBaseline,
        killed: false,
      }
      this.runtimes.set(key, runtime)
      // 重启后重连接管(§13):会话还活着的化身在这里重新装上文件监视,它之后每一轮 hook
      // 都能继续推状态给 harness。已终态的化身 startEventWatch 自己会短路掉。
      this.startEventWatch(runtime, { worker_id: ref.worker_id, seq: ref.seq, impl: 'claude-code', session_ref: sessionId })
      return runtime
    })
  }

  /** meta-<seq>.json 读取,文件不存在/内容损坏一律返回 undefined(供 ensureRuntime 判定
   * "真·未知化身")。 */
  private async readMetaFile(
    dir: string,
    seq: number,
  ): Promise<{ session_id?: string; workspace_root?: string; ended_reason?: IncarnationEndReason } | undefined> {
    try {
      const raw = await fs.readFile(join(dir, `meta-${seq}.json`), 'utf-8')
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }

  /**
   * worker_id 对应下一个可用的化身序号:该 worker 现存所有化身(主线 + fork 分支 + resume
   * 链)里最大 seq + 1。resume() 和 fork() 共用这一个分配逻辑,且都在各自的 mutex.run 内
   * 调用,保证互不撞号(fork 化身常驻不删,不能用 prev.seq+1 这种固定公式——见 fork()/
   * resume() 注释)。与 builtin adapter 的同名方法同一思路。
   *
   * 五轮 review 修复:磁盘感知——重启后新 adapter 实例的 runtimes 只含 ensureRuntime 按需
   * 重建过的那几条(见 ensureRuntime 注释),不是该 worker 的全部历史化身;只扫内存会漏掉
   * 磁盘上未被重建的旧化身,算出的"下一个"号位实际是别人已经占用的,resume/fork 静默覆盖
   * 其 meta-<seq>.json、复用其 output-<seq>.log。改为 max(内存已知 seq, 磁盘上
   * <dataDir>/<worker_id>/ 下 meta-*.json 的最大 seq) + 1——扫盘用文件名解析 seq,坏名/
   * 目录不存在都当作没有历史处理,不因此报错。
   */
  private async nextSeq(worker_id: string): Promise<number> {
    let max = 0
    for (const runtime of this.runtimes.values()) {
      if (runtime.worker_id === worker_id && runtime.seq > max) max = runtime.seq
    }
    const diskMax = await maxSeqOnDisk(join(this.deps.dataDir, worker_id))
    if (diskMax > max) max = diskMax
    return max + 1
  }

  /**
   * `onStateChange` 的 `report.lastText`(轮次边界上 worker 最后说的那段话,harness 会把它
   * 放进唤醒事件的 detail)在 cc/codex 这边**刻意不传**:
   *
   * 这两个实现拉起的是交互式 TUI,输出靠 `tmux pipe-pane -o ... 'cat >> <file>'` 落盘
   * (见 workers/tmux/driver.ts),拿到的是**终端渲染态原始字节流**——ANSI 控制序列、光标
   * 移动造成的重复重绘、边框、工具调用面板混在一起,全仓没有任何剥离/归一化层。把它塞进
   * 唤醒事件等于把这堆字节永久写进 manager 的上下文和 episode 日志,污染远大于收益,而且
   * 每次转 idle 都要付一遍。
   *
   * ANSI 归一化要单独设计(还要处理"TUI 里哪一段才算 assistant 发言"这个问题),不在本次
   * 范围内。在那之前,cc/codex 的唤醒事件只带状态,manager 需要正文时走 `read_worker_output`
   * ——那条路本来就通,行为与本次改动之前逐字一致。
   */
  private async transitionState(runtime: Runtime, h: IncarnationHandle, state: WorkerContractState): Promise<void> {
    await writeMetaAtomic(runtime.dir, runtime.seq, { seq: runtime.seq, state, session_id: runtime.sessionId, workspace_root: runtime.workspaceRoot })
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
      workspace_root: runtime.workspaceRoot,
    })
    runtime.state = 'exited'
    runtime.ended_reason = ended_reason
    // 终态唯一入口:文件监视在这里摘掉(kill / 自然结束 / 崩溃都汇到这里),避免已经死掉
    // 的化身继续持有 fs watcher + 轮询定时器,也避免终态之后还往外推状态回调。
    this.stopEventWatch(runtime)
    try {
      this.deps.onStateChange?.(h, 'exited', { endReason: ended_reason })
    } catch (err) {
      console.error(`[ClaudeCodeAdapter] onStateChange callback error for ${h.worker_id}#${h.seq}:`, err)
    }
  }

  /**
   * 协议 §6.2.3「hook 命令为向事件文件追加一行 JSON,**harness 以文件监视接收**」的接线。
   * 在此之前 hook 老实往 events-cli.jsonl 写,但生产侧无人读、也无任何定时器轮询 worker
   * 状态,cc worker 连"这一轮干完了"的 push 都没有——派得出去收不回来。
   *
   * 起:每一处建立 runtime 的地方(spawn / resume / ensureRuntime 重建出的存活化身,
   * 后者即重启后重连接管的路径)。停:transitionExited(终态唯一入口)。
   * 不装:无头 fork 化身(sessionName 为空串,不进 tmux,同步一击即终态,没有 hook 写它)。
   *
   * 只触发不搬运:回调不解析事件内容,一律交给 syncState 按既有三源规则重算一次,状态机
   * 语义与 pull 路径逐字一致,不引入第二处真相。syncState 自带 per-worker 互斥与终态短路,
   * 重复/迟到触发都是幂等的。
   *
   * 仍未覆盖的一档:worker 进程在没发出 stop 事件的情况下自退(崩溃/OOM),事件文件不会
   * 再动,这里也就不会被触发——那属协议 §6.3 第 3 档"harness 低频巡扫 tmux pane",另作。
   */
  private startEventWatch(runtime: Runtime, h: IncarnationHandle): void {
    if (!runtime.sessionName) return // fork 化身,无 tmux 也无 hook
    if (runtime.state === 'exited') return
    if (runtime.stopEventWatch) return // 幂等:同一 runtime 只装一个
    runtime.stopEventWatch = runtime.eventChannel.watch(() => {
      this.syncState(runtime, h).catch((err) => {
        console.error(`[ClaudeCodeAdapter] cli event driven syncState failed for ${h.worker_id}#${h.seq}:`, err)
      })
    })
  }

  private stopEventWatch(runtime: Runtime): void {
    if (!runtime.stopEventWatch) return
    runtime.stopEventWatch()
    runtime.stopEventWatch = undefined
  }

  /**
   * 新建 runtime 时的 stop 基线。事件文件是 **workspace 级**的(`<ws>/.claude/events-cli.jsonl`,
   * 同一 workspace 上的历代化身共写一份),所以新化身必须以"此刻文件里已有的 stop 数"起算,
   * 不能一律取 0——resume 正是复用上一化身的 workspace,取 0 会让首次 syncState 立刻把刚
   * 起来的新化身判成 idle。接上文件监视之后这条从"潜伏"变成"必然":watch() 建立时会先读
   * 一遍历史内容,取 0 就会在 resume 返回前推一个假的"这一轮干完了"去唤醒 manager。
   * 与 ensureRuntime 重建时的同款处理保持一致(那里本来就是这么算的)。
   */
  private async initialStopBaseline(channel: CliEventChannel): Promise<number> {
    const events = await channel.readAll()
    return events.filter((e) => e.kind === 'stop').length
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
