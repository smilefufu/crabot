/**
 * Claude Code WorkerAdapter.
 *
 * Interactive incarnations run in tmux. spawn/resume wait for bracketed-paste readiness,
 * then submit their opening input through the guarded transaction
 * `empty composer -> one paste -> same composer pending -> Enter` (one Enter retry, never a
 * second paste). The returned handle carries `initial_input`, so the harness settles both
 * control state and text ownership only after the incarnation is addressable in the ledger.
 *
 * Runtime truth is one `CliControlState`: running, waiting_text, waiting_action, or exited.
 * Stop hooks move running to waiting_text. Supported Notification payloads move to
 * waiting_action only when the current pane still shows the matching interaction. Composer
 * presence is used only to guard one input transaction, never as turn-complete/liveness proof.
 * Normal input uses steering while running and primary input while waiting_text. waiting_action
 * rejects normal text without writing to the pane. raw sends only the requested keys, then
 * re-probes the pane before changing state.
 *
 * provision writes workspace hooks, skills, MCP/context files, and pre-accepts workspace trust.
 * spawn/resume retain bypassPermissions and inject the process-local dangerous-mode warning
 * setting; they do not modify ~/.claude/settings.json. Native session JSONL is used for trace and
 * diagnostics only: missing records never trigger an automatic re-paste.
 *
 * Meta persists the external running/idle/exited state plus wait_mode/wait_reason for idle CLI
 * states. ensureRuntime reconstructs a runtime from meta and deterministic tmux names after an
 * agent restart. Headless fork remains isolated from the main interaction event file.
 */
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { TmuxDriver, type PaneSnapshot } from '../tmux/driver.js'
import { commitInput, waitForPaneChange, type InputMode } from '../tmux/input-commit.js'
import { DEFAULT_PASTE_READY_TIMEOUT_MS, describeStartupStall, readOutputTail, waitForPasteReady } from '../tmux/paste-ready.js'
import { CliEventChannel, EVENTS_FILE_ENV } from '../cli-events.js'
import { OutputLog } from '../output-log.js'
import { decodeTerminalOutput } from '../terminal-output.js'
import { AsyncMutex } from '../async-mutex.js'
import { writeMetaAtomic, maxSeqOnDisk, latestModifiedMs } from '../meta-store.js'
import { WorkerExitedError, CliInputStallError } from '../errors.js'
import { probeClaudeInput, acceptedClaudeInput, hasClaudeInteraction } from './input-surface.js'
import { materializeSkills, renderMcpJson, renderContextMd, type ProvisionSources } from '../provision/materialize.js'
import type {
  AdapterCapabilities,
  CapabilityBundle,
  CliControlState,
  DetectResult,
  IncarnationEndReason,
  InitialInputResult,
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

/**
 * Claude Code 2.1.223 的 bypass 一次性危险确认开关。
 *
 * 真实 Admin Chat 验收证明旧的 ~/.claude.json.bypassPermissionsModeAccepted 已无效,project
 * settings 里的新字段也不生效;只有启动级 --settings 能在不永久修改用户级
 * ~/.claude/settings.json 的前提下消掉弹窗。值是 adapter 内部常量,仍经 shQuote 进入 shell。
 */
const BYPASS_WARNING_SETTINGS_ARG = `--settings ${shQuote(JSON.stringify({ skipDangerousModePermissionPrompt: true }))}`

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
  controlState: CliControlState
  ended_reason?: IncarnationEndReason
  /** 自上一次 sendInput(或 spawn)以来"已计入"的 stop 事件数;新 stop 数超过它才判定本轮 idle。 */
  stopBaseline: number
  killed: boolean
  /** Set only for the narrow "accepted input then pane exited before return" settlement. */
  acceptedExitReport?: StateChangeReport
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

function contractState(state: CliControlState): WorkerContractState {
  switch (state.kind) {
    case 'running': return 'running'
    case 'exited': return 'exited'
    default: return 'idle'
  }
}

function controlFromMeta(meta: { state?: WorkerContractState; wait_mode?: 'text' | 'action'; wait_reason?: string; startup_stalled?: boolean }, alive: boolean): CliControlState {
  if (!alive || meta.state === 'exited') return { kind: 'exited' }
  if (meta.startup_stalled || meta.wait_mode === 'action') return { kind: 'waiting_action', reason: meta.wait_reason ?? 'startup_stall' }
  if (meta.state === 'idle') return { kind: 'waiting_text' }
  return { kind: 'running' }
}

export class ClaudeCodeAdapter implements WorkerAdapter {
  readonly implId = 'claude-code' as const

  private readonly tmux: TmuxDriver
  private readonly claudeBin: string
  private readonly claudeProjectsDir: string
  private readonly claudeConfigPath: string
  private readonly pasteReadyTimeoutMs: number
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
      /** 启动期就绪握手的等待上限,默认 DEFAULT_PASTE_READY_TIMEOUT_MS(见该常量注释里的
       * 实测取值依据)。测试注入小值,避免为了走超时分支真的等一分钟。 */
      readonly pasteReadyTimeoutMs?: number
      /** @deprecated 原生 session 记录只作诊断；缺回执不得触发自动重贴。 */
      readonly promptDeliveryTimeoutMs?: number
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
    this.pasteReadyTimeoutMs = deps.pasteReadyTimeoutMs ?? DEFAULT_PASTE_READY_TIMEOUT_MS
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
      // --permission-mode bypassPermissions 已在 spawn 命令行传了,这里在 settings.json 里重复
      // 声明一份,让 resume 也选择同一模式。bypassPermissions = 等价
      // auto-mode/--dangerously-skip-permissions:工具调用零审批弹窗(否则每调一次 Bash/网络
      // 就要 manager 处理一次)。取舍见 specs/2026-08-06-worker-permission-auto-approve-design.md。
      permissions: { defaultMode: 'bypassPermissions' },
    }
    await fs.writeFile(join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n', 'utf-8')

    const mcpServers = caps.mcp_servers as unknown as ProvisionSources['mcpServers']
    await this.preAcceptStartupDialogs(ws.root, mcpServers.map((s) => s.name))

    await materializeSkills(ws.root, caps.skills, '.claude/skills')

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

  /** 在全局 ~/.claude.json 预置两类 project 级启动授权:
   * 1. workspace project entry 已信任;
   * 2. 已授权本项目的 MCP server。
   *
   * bypassPermissions 的危险确认由 spawn/resume 启动参数处理,不属于本文件的全局预写。
   *
   * ## 弹窗②:`New MCP server found in this project: <name>`
   *
   * provision 每次都往一个**全新** workspace 写 `.mcp.json`(见上面 renderMcpJson),于是 cc
   * 每次都认为"这个 project 里发现了新 MCP server"并停下来等选择。开关与信任记录同层:
   * `projects["<realpath>"].enabledMcpjsonServers = [<.mcp.json 里的 server 名>]`(键名已在
   * m2 的 ~/.claude.json 上实证:17 个 project entry 里 16 个带它)。
   *
   * 与就绪握手(见 spawn)的关系:握手是兜底,这里是消源。预写是幂等的、无时序依赖的,
   * 优于"读屏 + 匹配 + 按键应答";但它靠枚举,必然有漏网的新弹窗——所以两者都要有,
   * 不是二选一。
   *
   * ## 弹窗①:`Do you trust this folder?`
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
   * 当前方法只消除两类 project 级启动弹窗。bypassPermissions 的危险确认不接受这里的
   * ~/.claude.json 或 workspace settings,由 spawn/resume 的 --settings 启动参数处理。
   *
   * 失败一律抛错(fail-loud),不吞:
   * - 吞掉 → worker 重新静默卡回弹窗,而这个故障态在外部看来是"running 但永远没动静",
   *   正是本次要根治的、最难诊断的那个现象;
   * - 文件存在但解析不出来时更不能兜底重写——用户真实项目的条目和登录信息都在同一份文件里,
   *   宁可 provision 失败(spawn 之前,不留半个 worker),也不能把它覆盖掉。
   * 文件不存在是正常情形(全新机器),按空配置创建。 */
  private async preAcceptStartupDialogs(root: string, mcpServerNames: string[]): Promise<void> {
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
      // 只补这两个字段:同一个 path 下可能已有 allowedTools / history 等用户数据,不能覆盖。
      merged.hasTrustDialogAccepted = true
      // 覆盖而非并集:这一条 project entry 描述的是 crabot 刚刚写下的那份 .mcp.json,
      // caps 是本任务的授权边界,残留的旧名字不该继续被授权(与 codex 侧 mcp_servers
      // 整体覆盖宿主配置同一取舍)。没有 MCP server 时落 []——cc 见到空表就不会问。
      merged.enabledMcpjsonServers = [...mcpServerNames]
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

  private async capture(runtime: Runtime): Promise<PaneSnapshot> {
    const snapshot = await this.tmux.capturePane(runtime.sessionName)
    return { ...snapshot, text: decodeTerminalOutput(snapshot.text) }
  }

  private async commitGuardedInput(
    runtime: Runtime,
    h: IncarnationHandle,
    text: string,
    mode: InputMode,
    notify: boolean,
    foldStop: boolean,
  ): Promise<InitialInputResult> {
    let baseline = ''
    let pasted = false
    let result
    try {
      baseline = (await this.capture(runtime)).text
      result = await commitInput(
        {
          pasteText: async (value) => {
            await this.tmux.pasteText(runtime.sessionName, value)
            pasted = true
          },
          sendEnter: () => this.tmux.sendKeys(runtime.sessionName, ['Enter']),
          capture: () => this.capture(runtime),
        },
        (snapshot, phase) => probeClaudeInput(snapshot, mode, phase === 'after_paste' ? text : undefined, phase === 'before_paste'),
        (snapshot) => acceptedClaudeInput(snapshot, mode, text),
        text,
      )
    } catch (err) {
      if (!(await this.tmux.isAlive(runtime.sessionName))) {
        const reason: IncarnationEndReason = pasted ? 'completed' : 'crashed'
        await this.transitionExited(runtime, h, reason, notify)
        return {
          control_state: 'exited',
          disposition: pasted ? 'accepted' : 'not_pasted',
          report: { endReason: reason },
        }
      }
      throw err
    }

    if (result.disposition === 'accepted') {
      if (!(await this.tmux.isAlive(runtime.sessionName))) {
        await this.transitionExited(runtime, h, 'completed', notify)
        return { control_state: 'exited', disposition: 'accepted', report: { endReason: 'completed' } }
      }
      if (foldStop) {
        const events = await runtime.eventChannel.readAll()
        const stopCount = events.filter((event) => event.kind === 'stop').length
        if (stopCount > runtime.stopBaseline) {
          runtime.stopBaseline = stopCount
          await this.transitionControlState(runtime, h, { kind: 'waiting_text' }, undefined, notify)
          return { control_state: 'waiting_text', disposition: 'accepted' }
        }
      }
      await this.transitionControlState(runtime, h, { kind: 'running' }, undefined, notify)
      return { control_state: 'running', disposition: 'accepted' }
    }

    const next: CliControlState =
      mode === 'steering' && runtime.controlState.kind === 'running'
        ? { kind: 'running' }
        : { kind: 'waiting_action', reason: result.disposition === 'not_pasted' ? 'input_surface_unavailable' : 'input_pending' }
    let waitReason: string
    if (next.kind === 'waiting_action') waitReason = next.reason
    else if (result.disposition === 'pending_in_ui') waitReason = 'input_pending'
    else waitReason = 'input_surface_unavailable'
    const report: StateChangeReport = {
      outputTail: result.snapshot.text || baseline,
      waitReason,
    }
    await this.transitionControlState(runtime, h, next, report, notify)
    return { control_state: next.kind, disposition: result.disposition, report }
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
    const command = `${this.claudeBin} ${BYPASS_WARNING_SETTINGS_ARG} --session-id ${sessionId} --permission-mode bypassPermissions`

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
      controlState: { kind: 'running' },
      stopBaseline: await this.initialStopBaseline(eventChannel),
      killed: false,
    }

    await writeMetaAtomic(dir, seq, { seq, state: 'running', session_id: sessionId, workspace_root: spec.workspace.root })
    this.runtimes.set(instanceKey(handle), runtime)

    // 启动期就绪握手(见 tmux/paste-ready.ts):等 cc 在 pane 里发出 \e[?2004h 之后再投递,
    // 否则 paste-buffer -p 会静默降级成裸文本注入,prompt 里每个换行都变成一次 Enter——
    // 生产实证里前两个换行分别确认掉了信任弹窗与 MCP 弹窗,残句留在 composer 里从未提交。
    //
    // 等不到就**不投递**(协议 §5.5 的"不安全态暂扣"):prompt 原封不动留在 spec 里没有被
    // 消耗,manager 处理掉障碍后经 send_to_worker 重新投递即可,内容不丢。这里绝不能退化成
    // "超时了也照发"——那正是本次要根治的行为。
    const pasteReady = await waitForPasteReady(outputFile, {
      timeoutMs: this.pasteReadyTimeoutMs,
      isAlive: () => this.tmux.isAlive(sessionName),
    })
    if (!pasteReady) {
      const initial_input = await this.initialStartupStall(runtime, handle, outputFile)
      this.startEventWatch(runtime, handle)
      return { ...handle, initial_input }
    }

    let initial_input: InitialInputResult
    try {
      initial_input = await this.commitGuardedInput(runtime, handle, spec.prompt, 'primary', false, true)
    } catch (err) {
      await this.getMutex(handle.worker_id).run(async () => {
        if (runtime.controlState.kind === 'exited') return
        await this.tmux.killSession(runtime.sessionName)
        await this.transitionExited(runtime, handle, 'crashed')
      })
      throw err
    }
    this.startEventWatch(runtime, handle)
    return { ...handle, initial_input }
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
    let outputFile!: string
    await this.getMutex(prev.worker_id).run(async () => {
      if (prevRuntime.resumed) {
        throw new Error(`ClaudeCodeAdapter.resume: incarnation ${prev.worker_id}#${prev.seq} already resumed (concurrent resume of the same prev incarnation?)`)
      }
      const seq = await this.nextSeq(prev.worker_id)
      handle = { worker_id: prev.worker_id, seq, impl: 'claude-code', session_ref: prev.session_ref }
      const sessionName = `crabot-w-${prev.worker_id}-${seq}`
      outputFile = join(dir, `output-${seq}.log`)
      // 不重复传 --permission-mode:provision 阶段已把 bypassPermissions 写进 settings.json,覆盖
      // 命令行没有重复声明的场景(resume 正是这样的场景)。危险确认开关则不接受 project
      // settings,必须与 spawn 对称地每次通过 --settings 注入。session_ref 是 cc 侧的会话 uuid,
      // 沿用不变。拼接时用 shQuote 转义 session_ref,防止 shell 注入(双层防御:
      // 入口已校验 UUID 格式,拼接时再加引号转义,提高防御深度)。
      const command = `${this.claudeBin} ${BYPASS_WARNING_SETTINGS_ARG} --resume ${shQuote(prev.session_ref)}`

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
        controlState: { kind: 'running' },
        // 复用上一化身的 workspace ⇒ 事件文件里已有它留下的 stop 事件,基线必须现读现算。
        stopBaseline: await this.initialStopBaseline(eventChannel),
        killed: false,
      }

      await writeMetaAtomic(dir, seq, { seq, state: 'running', session_id: prev.session_ref, workspace_root: prevRuntime.workspaceRoot })
      this.runtimes.set(instanceKey(handle), runtime)
      prevRuntime.resumed = true
    })

    const pasteReady = await waitForPasteReady(outputFile, {
      timeoutMs: this.pasteReadyTimeoutMs,
      isAlive: () => this.tmux.isAlive(runtime.sessionName),
    })
    if (!pasteReady) {
      const initial_input = await this.initialStartupStall(runtime, handle, outputFile)
      this.startEventWatch(runtime, handle)
      return { ...handle, initial_input }
    }

    let initial_input: InitialInputResult
    try {
      initial_input = await this.commitGuardedInput(runtime, handle, wakeInput, 'primary', false, true)
    } catch (err) {
      await this.getMutex(handle.worker_id).run(async () => {
        if (runtime.controlState.kind === 'exited') return
        await this.tmux.killSession(runtime.sessionName)
        await this.transitionExited(runtime, handle, 'crashed')
      })
      throw err
    }
    this.startEventWatch(runtime, handle)
    return { ...handle, initial_input }
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
        controlState: { kind: 'running' },
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
      if (runtime.controlState.kind === 'exited') return // 幂等兜底
      await this.transitionExited(runtime, handle, endedReason)
    })

    return handle
  }

  async sendInput(h: IncarnationHandle, text: string, opts?: { raw?: boolean }): Promise<void> {
    const runtime = await this.ensureRuntime(h)
    if (!runtime) throw new WorkerExitedError(h.worker_id, h.seq)

    const { state: current } = await this.syncState(runtime, h)
    if (current === 'exited') throw new WorkerExitedError(h.worker_id, h.seq, runtime.ended_reason)

    return this.getMutex(h.worker_id).run(async () => {
      if (runtime.controlState.kind === 'exited') throw new WorkerExitedError(h.worker_id, h.seq, runtime.ended_reason)

      if (opts?.raw) {
        const before = await this.capture(runtime)
        const keys = text.split(/\s+/).filter((key) => key.length > 0)
        await this.tmux.sendKeys(runtime.sessionName, keys)
        const snapshot = await waitForPaneChange(() => this.capture(runtime), before.text)
        if (hasClaudeInteraction(snapshot.text)) {
          const report: StateChangeReport = { outputTail: snapshot.text, waitReason: 'interaction_required' }
          await this.transitionControlState(runtime, h, { kind: 'waiting_action', reason: 'interaction_required' }, report, false)
          throw new CliInputStallError('not_pasted', 'waiting_action', report)
        }
        const primaryProbe = probeClaudeInput(snapshot, 'primary', undefined, false)
        if (primaryProbe === 'pending') {
          const next: CliControlState = runtime.controlState.kind === 'running'
            ? { kind: 'running' }
            : { kind: 'waiting_action', reason: 'input_pending' }
          const report: StateChangeReport = { outputTail: snapshot.text, waitReason: 'input_pending' }
          await this.transitionControlState(runtime, h, next, report, false)
          throw new CliInputStallError('pending_in_ui', next.kind, report)
        }
        if (primaryProbe === 'empty' && (runtime.controlState.kind === 'running' || /esc to interrupt/i.test(snapshot.text))) {
          await this.transitionControlState(runtime, h, { kind: 'running' })
          return
        }
        if (primaryProbe === 'empty') {
          await this.transitionControlState(runtime, h, { kind: 'waiting_text' })
          return
        }
        const reason = runtime.controlState.kind === 'waiting_action'
          ? runtime.controlState.reason
          : 'input_surface_unavailable'
        const report: StateChangeReport = { outputTail: snapshot.text, waitReason: reason }
        await this.transitionControlState(runtime, h, { kind: 'waiting_action', reason }, report, false)
        throw new CliInputStallError('not_pasted', 'waiting_action', report)
      }

      if (runtime.controlState.kind === 'waiting_action') {
        const snapshot = await this.capture(runtime)
        const report: StateChangeReport = { outputTail: snapshot.text, waitReason: runtime.controlState.reason }
        throw new CliInputStallError('not_pasted', 'waiting_action', report)
      }

      const mode: InputMode = runtime.controlState.kind === 'running' ? 'steering' : 'primary'
      const result = await this.commitGuardedInput(runtime, h, text, mode, false, false)
      if (result.disposition !== 'accepted') {
        throw new CliInputStallError(result.disposition, result.control_state, result.report)
      }
      if (result.control_state === 'exited') {
        runtime.acceptedExitReport = result.report ?? { endReason: runtime.ended_reason ?? 'completed' }
      }
    })
  }

  takeAcceptedInputExit(h: IncarnationHandle): StateChangeReport | undefined {
    const runtime = this.runtimes.get(instanceKey(h))
    const report = runtime?.acceptedExitReport
    if (runtime) runtime.acceptedExitReport = undefined
    return report
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
   * 活性信号(protocol-agent-v3 §6.1):任务/执行进展的最近时刻。
   *
   * pane output 可能只是 TUI spinner 或 Auto-updating 重绘,不能拿它当任务活动。
   * 原生 session JSONL 记录实际会话进展;meta 则提供 spawn/resume/input/state 转换的
   * 控制进展基线。两者任一暂时不可读时用另一来源,都不可读才交给 harness 本轮跳过。
   */
  async lastActivityAt(h: IncarnationHandle): Promise<number | undefined> {
    const dir = join(this.deps.dataDir, h.worker_id)
    const metaPath = join(dir, `meta-${h.seq}.json`)
    const runtime = this.runtimes.get(instanceKey(h))
    const meta = runtime ? undefined : await this.readMetaFile(dir, h.seq)
    const workspaceRoot = runtime?.workspaceRoot ?? meta?.workspace_root
    const sessionId = runtime?.sessionId ?? meta?.session_id ?? h.session_ref
    const tracePath = workspaceRoot && sessionId
      ? join(this.claudeProjectsDir, projectSlug(workspaceRoot), `${sessionId}.jsonl`)
      : undefined
    return latestModifiedMs([metaPath, tracePath], `${h.worker_id}#${h.seq}`)
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
    // Meta reconstruction makes kill work after an agent restart; missing meta and already-exited
    // incarnations are both idempotent no-ops.
    const runtime = await this.ensureRuntime(h)
    if (!runtime) return
    await this.getMutex(h.worker_id).run(async () => {
      if (runtime.controlState.kind === 'exited') return // 幂等:不覆盖原 ended_reason
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
   * Reconcile tmux existence and Stop events with the resident control state. A startup/action
   * wait that dies before proven progress is classified crashed; other external exits retain the
   * protocol's completed inference. The whole read/transition is serialized per worker.
   */
  private async syncState(
    runtime: Runtime,
    h: IncarnationHandle,
    deadReason: IncarnationEndReason = 'completed',
  ): Promise<{ state: WorkerContractState; stopCount: number }> {
    if (runtime.controlState.kind === 'exited') return { state: 'exited', stopCount: runtime.stopBaseline }

    return this.getMutex(h.worker_id).run(async () => {
      if (runtime.controlState.kind === 'exited') return { state: 'exited', stopCount: runtime.stopBaseline }
      const events = await runtime.eventChannel.readAll()
      const stopCount = events.filter((event) => event.kind === 'stop').length
      if (!(await this.tmux.isAlive(runtime.sessionName))) {
        let reason = deadReason
        if (runtime.killed) reason = 'killed'
        else if (runtime.controlState.kind === 'waiting_action') reason = 'crashed'
        await this.transitionExited(runtime, h, reason)
      } else if (stopCount > runtime.stopBaseline && runtime.controlState.kind !== 'waiting_text') {
        runtime.stopBaseline = stopCount
        await this.transitionControlState(runtime, h, { kind: 'waiting_text' })
      }
      return { state: contractState(runtime.controlState), stopCount }
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

  /** Rebuild a CLI runtime from meta plus the deterministic tmux name. The per-worker lock and
   * lock-local map recheck prevent duplicate runtimes/watchers during concurrent first access. */
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
        controlState: controlFromMeta(meta, alive),
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
  ): Promise<
    { session_id?: string; workspace_root?: string; ended_reason?: IncarnationEndReason; state?: WorkerContractState; wait_mode?: 'text' | 'action'; wait_reason?: string; startup_stalled?: boolean } | undefined
  > {
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
   * 移动造成的重复重绘、边框、工具调用面板混在一起。把它塞进唤醒事件等于把这堆字节永久
   * 写进 manager 的上下文和 episode 日志,污染远大于收益,而且每次转 idle 都要付一遍。
   *
   * `terminal-output.ts` 的解码只解决了"读得懂"这一半,另一半——"TUI 里哪一段才算 assistant
   * 发言"——仍然无解,而那正是 `lastText` 的语义。所以 cc/codex 的唤醒事件只带状态,manager
   * 需要正文时走 `read_worker_output`——那条路本来就通,行为与本次改动之前逐字一致。
   *
   * 唯一的例外是 `report.outputTail`(见 initialStartupStall):启动期就绪握手超时时,manager
   * 手上没有任何别的线索能判断"卡在哪",而这是**每个化身至多付一次**的一次性成本,与上面
   * "每轮都付一遍"的量纲完全不同。
   */
  private async transitionControlState(
    runtime: Runtime,
    h: IncarnationHandle,
    state: CliControlState,
    report?: StateChangeReport,
    notify = true,
  ): Promise<void> {
    const external = contractState(state)
    const changed = runtime.controlState.kind !== state.kind ||
      (runtime.controlState.kind === 'waiting_action' && state.kind === 'waiting_action' && runtime.controlState.reason !== state.reason)
    await writeMetaAtomic(runtime.dir, runtime.seq, {
      seq: runtime.seq,
      state: external,
      session_id: runtime.sessionId,
      workspace_root: runtime.workspaceRoot,
      ...(state.kind === 'waiting_text' ? { wait_mode: 'text' as const } : {}),
      ...(state.kind === 'waiting_action' ? { wait_mode: 'action' as const, wait_reason: state.reason } : {}),
    })
    runtime.controlState = state
    if (!notify || !changed) return
    try {
      this.deps.onStateChange?.(h, external, report)
    } catch (err) {
      console.error(`[ClaudeCodeAdapter] onStateChange callback error for ${h.worker_id}#${h.seq}:`, err)
    }
  }

  private async initialStartupStall(
    runtime: Runtime,
    h: IncarnationHandle,
    outputFile: string,
  ): Promise<InitialInputResult> {
    const tail = decodeTerminalOutput(await readOutputTail(outputFile))
    if (!(await this.tmux.isAlive(runtime.sessionName))) {
      await this.transitionExited(runtime, h, 'crashed', false)
      return { control_state: 'exited', disposition: 'not_pasted', report: { endReason: 'crashed', outputTail: tail } }
    }
    const state: CliControlState = { kind: 'waiting_action', reason: 'startup_stall' }
    const report: StateChangeReport = {
      outputTail: describeStartupStall({ impl: 'claude-code', timeoutMs: this.pasteReadyTimeoutMs, tail }),
      waitReason: 'startup_stall',
    }
    await this.transitionControlState(runtime, h, state, report, false)
    return { control_state: 'waiting_action', disposition: 'not_pasted', report }
  }

  private async transitionExited(runtime: Runtime, h: IncarnationHandle, ended_reason: IncarnationEndReason, notify = true): Promise<void> {
    await writeMetaAtomic(runtime.dir, runtime.seq, {
      seq: runtime.seq,
      state: 'exited',
      session_id: runtime.sessionId,
      ended_reason,
      workspace_root: runtime.workspaceRoot,
    })
    runtime.controlState = { kind: 'exited', reason: ended_reason }
    runtime.ended_reason = ended_reason
    // 终态唯一入口:文件监视在这里摘掉(kill / 自然结束 / 崩溃都汇到这里),避免已经死掉
    // 的化身继续持有 fs watcher + 轮询定时器,也避免终态之后还往外推状态回调。
    this.stopEventWatch(runtime)
    if (!notify) return
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
    if (runtime.controlState.kind === 'exited') return
    if (runtime.stopEventWatch) return
    runtime.stopEventWatch = runtime.eventChannel.watch((event) => {
      if (event.kind === 'notification') {
        const raw = event.raw as { notification_type?: unknown; message?: unknown; title?: unknown } | null
        const type = typeof raw?.notification_type === 'string' ? raw.notification_type : undefined
        if (!type || !['permission_prompt', 'elicitation_dialog', 'agent_needs_input'].includes(type)) return
        void this.getMutex(h.worker_id).run(async () => {
          if (runtime.controlState.kind === 'exited') return
          const snapshot = await this.capture(runtime)
          if (!hasClaudeInteraction(snapshot.text)) return
          const message = typeof raw?.message === 'string' ? raw.message : undefined
          const title = typeof raw?.title === 'string' ? raw.title : undefined
          const report: StateChangeReport = {
            outputTail: snapshot.text,
            waitReason: 'interaction_required',
            notification: { type, ...(message ? { message } : {}), ...(title ? { title } : {}) },
          }
          await this.transitionControlState(runtime, h, { kind: 'waiting_action', reason: 'interaction_required' }, report)
        }).catch((err) => {
          console.error(`[ClaudeCodeAdapter] notification pane check failed for ${h.worker_id}#${h.seq}:`, err)
        })
        return
      }
      if (event.kind !== 'stop') return
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
