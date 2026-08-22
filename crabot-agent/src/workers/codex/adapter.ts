/**
 * Codex WorkerAdapter.
 *
 * Interactive incarnations run in tmux with approve-for-me (which selects the workspace-write
 * sandbox), and
 * workspace network access. spawn/resume wait for bracketed-paste readiness and submit opening
 * input through the guarded `empty -> one paste -> pending -> Enter` transaction (one Enter retry,
 * never a second paste). `initial_input` on the returned handle gives the harness explicit state
 * and text ownership for accepted, not_pasted, and pending_in_ui outcomes.
 *
 * Runtime truth is one `CliControlState`: running, waiting_text, waiting_action, or exited.
 * agent-turn-complete notify events move running to waiting_text. Composer/footer rendering is
 * used only for primary/steering input safety and queued-message acceptance, not for liveness or
 * turn completion. raw sends only requested keys and re-probes before changing state.
 *
 * provision writes workspace-local Codex config, skills, MCP, and context files. Session discovery
 * reads native rollout metadata; a placeholder session can continue visually but cannot be
 * resumed. Native rollout data is trace/diagnostic evidence and never causes automatic re-paste.
 * Meta persists external state plus wait_mode/wait_reason and supports runtime reconstruction from
 * deterministic tmux names after an agent restart. Query forks use a separate headless app-server
 * process and never enter the interactive tmux session.
 */
import { promises as fs, type Dirent } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { homedir, tmpdir } from 'os'
import { execFile } from 'child_process'
import { buildChildEnv } from '../../core/runtime-env.js'
import { connectionCapabilitiesFor } from '../connections/registry.js'
import { promisify } from 'util'
import { TmuxDriver, type PaneSnapshot } from '../tmux/driver.js'
import { commitInput, waitForPaneChange, type InputMode } from '../tmux/input-commit.js'
import { parseRawControlKeys } from '../tmux/raw-control.js'
import { DEFAULT_PASTE_READY_TIMEOUT_MS, waitForPasteReady } from '../tmux/paste-ready.js'
import { CliEventChannel } from '../cli-events.js'
import { watchNativeSessionFile } from '../native-session-watch.js'
import { OutputLog } from '../output-log.js'
import type { TmuxControlEndpoint } from '../tmux/control-monitor.js'
import { readFinalTerminalSnapshot, writeFinalTerminalSnapshot } from '../tmux/terminal-snapshot.js'
import type { TerminalInteraction } from '../tmux/terminal-interaction.js'
import { AsyncMutex } from '../async-mutex.js'
import { writeMetaAtomic, maxSeqOnDisk, latestModifiedMs } from '../meta-store.js'
import { WorkerExitedError, CapabilityNotSupportedError, CliInputStallError, WorkerImplUnavailableError, ForkEstablishmentError } from '../errors.js'
import { probeCodexInput, acceptedCodexInput, classifyCodexTerminalInteraction } from './input-surface.js'
import { assertInputDeliveryActive } from '../input-delivery-control.js'
import { buildScrubbedChildEnv } from '../connections/secret-env.js'
import {
  CodexAppServerClient,
  CodexAppServerDeadlineError,
  CodexAppServerRpcError,
  probeCodexAppServerFork,
  type AppServerNotification,
} from './app-server-client.js'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { createHash } from 'node:crypto'
import { assertWorkspaceFilesUntracked, materializeSkills, renderCodexMcpToml, writeSensitiveFileAtomic, type ProvisionSources } from '../provision/materialize.js'
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
  ForkOptions,
  ResumeOptions,
  NormalizedTraceEvent,
  SpawnSpec,
  SendInputOptions,
  TraceCursor,
  WorkerAdapter,
  WorkerContractState,
  Workspace,
  WorkerTerminalView,
  WorkerUiResponse,
} from '../types.js'
import { classifySupervisionActivity } from '../types.js'
import type { SupervisionObservation } from '../types.js'

const execFileAsync = promisify(execFile)

/** spawn/resume 都要带的主命令级选项:放行 workspace-write 沙箱的出网。见文件头
 * "spawn/resume 启动参数"节。取值只含 `[A-Za-z_.=]`,不含 shell 元字符,拼进经 `sh -c`
 * 跑的 tmux 命令行时无需额外引号。 */
const CODEX_NETWORK_ACCESS_OPT = '-c sandbox_workspace_write.network_access=true'
const CODEX_HOOK_TRUST_OPT = '--dangerously-bypass-hook-trust'
const CODEX_CREDENTIAL_FILES = ['.codex/config.toml', '.codex/auth.json'] as const

/** POSIX shell 单引号转义,与 cc adapter 的私有 shQuote 同款用法(独立复制一份)。 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function safeProcessError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 1000)
}

/** 取一个 TOML table 值当普通对象用;不是 table(缺失/标量/数组)就当空表。 */
function asTable(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

async function assertNoCodexHookSources(codexDir: string, operation = 'provision'): Promise<void> {
  for (const entry of ['hooks.json', 'plugins'] as const) {
    try {
      await fs.lstat(join(codexDir, entry))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    throw new Error(
      `CodexWorkerAdapter.${operation}: refusing to enable generated hook trust while ${join(codexDir, entry)} exists`,
    )
  }
}

/**
 * 隔离 CODEX_HOME 可以继承连接设置，却绝不能继承会安装/启用第三方 hook 的配置。否则
 * --dangerously-bypass-hook-trust 会扩大到 Crabot 未生成、未审计的代码。
 */
function stripUntrustedCodexHookSources(config: Record<string, unknown>): void {
  delete config.hooks
  delete config.plugins
  delete config.marketplaces
  delete config.allow_managed_hooks_only
}

function generatedCodexPermissionRequestHooks(command: string): Record<string, unknown> {
  return {
    PermissionRequest: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: `/bin/sh -c ${shQuote(command)}`,
        timeout: 10,
      }],
    }],
  }
}

async function installGeneratedCodexHookConfiguration(
  codexDir: string,
  channel: CliEventChannel,
  operation: 'spawn' | 'resume',
): Promise<void> {
  const configPath = join(codexDir, 'config.toml')
  let config: Record<string, unknown>
  try {
    config = asTable(parseToml(await fs.readFile(configPath, 'utf-8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      config = {}
    } else {
      throw new Error(
        `CodexWorkerAdapter.${operation}: refusing to enable generated hook trust because ${configPath} is unreadable or invalid`,
      )
    }
  }
  // CODEX_HOME 是 Harness 管理的隔离目录。每次启动都恢复其 hook 段，既兼容上线前
  // 没有该段的配置，也不会让 worker 或 Codex 自己留下的 hook state 进入自动信任范围。
  stripUntrustedCodexHookSources(config)
  config.features = { ...asTable(config.features), hooks: true }
  config.hooks = generatedCodexPermissionRequestHooks(channel.hookCommand('permission_request'))
  try {
    await fs.mkdir(codexDir, { recursive: true })
    await writeSensitiveFileAtomic(configPath, stringifyToml(config))
  } catch {
    throw new Error(
      `CodexWorkerAdapter.${operation}: refusing to install generated hook trust at ${configPath}`,
    )
  }
}

/** 从 codexBin 配置里摘出"实际会被 exec 的可执行文件"这一个 token。生产配置通常就是单个
 * 命令名(如 'codex')或绝对路径;测试注入的 mock codexBin 是复合 shell 命令行
 * (`env VAR=... node fixture.mjs`),这里跳过 `env` 与它后面的 `KEY=VALUE` 前缀,取到真正
 * 的可执行文件 token(如 `node`)。 */
function firstExecutableToken(bin: string): string | undefined {
  const tokens = bin.trim().split(/\s+/).filter((t) => t.length > 0)
  let i = 0
  if (tokens[i] === 'env') {
    i += 1
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1
  }
  return tokens[i]
}

/** nvm 部署陷阱(m2 实测):codex 常是 nvm 装的 node 脚本(shebang `#!/usr/bin/env node`),
 * 经 tmux 拉起时若 tmux server 自身的环境不含这个 node 的 bin 目录,必现
 * `env: node: No such file or directory`——tmux server 是常驻进程,其环境不一定等于当前
 * agent 进程的环境(可能在 nvm 生效之前就已启动)。用 `command -v`(POSIX shell 内置,不
 * 依赖是否装了独立的 `which` 二进制)+ `fs.realpath` 解析出 codexBin 真实所在目录,调用方
 * 把它前置进传给 tmux/子进程的 PATH——不硬编码任何 nvm 路径,覆盖"CLI 与其 node 同目录"
 * 的任意安装形态(nvm/fnm/asdf/系统包管理器等)。解析不出来(codex 压根不在 PATH 上,或
 * 传入的就是一段无法定位可执行文件的复合命令)返回 undefined,调用方退回继承的 PATH,
 * 不阻塞。 */
async function resolveBinDir(bin: string): Promise<string | undefined> {
  const token = firstExecutableToken(bin)
  if (!token) return undefined
  try {
    let resolved: string
    if (token.includes('/')) {
      resolved = await fs.realpath(token)
    } else {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', `command -v ${shQuote(token)}`], { env: buildChildEnv() })
      resolved = await fs.realpath(stdout.trim())
    }
    return dirname(resolved)
  } catch {
    return undefined
  }
}

/** 标准 UUID 格式(8-4-4-4-12 十六进制段,由连字符分隔)——session_ref 前置校验与"从 rollout
 * 内容里读出的 session_id"校验共用同一条正则(五轮 review 修复:后者此前没做格式校验,畸形
 * id 会静默写进 meta/handle.session_ref)。 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** UUID 格式校验:标准 UUID 格式(8-4-4-4-12 十六进制段,由连字符分隔)。*/
function validateSessionRef(sessionRef: string): void {
  if (sessionRef === '') {
    // spawn 的就绪握手超时时 session_ref 如实留空(codex 那边根本没有会话可续)——把它与
    // "格式非法"区分开,否则调用方拿到的是一句看不懂的 UUID 格式错误。
    throw new Error(
      `CodexWorkerAdapter: this incarnation has no codex session (startup readiness handshake timed out, ` +
        `so no session was ever established); it cannot be resumed — kill it and spawn a new worker instead.`,
    )
  }
  if (!UUID_RE.test(sessionRef)) {
    throw new Error(
      `CodexWorkerAdapter: invalid session_ref format (expected UUID, got '${sessionRef.slice(0, 50)}'). ` +
        `session_ref must be a valid UUID and cannot contain shell metacharacters.`,
    )
  }
}

/** Re-export for backward compatibility and convenience. */
export { WorkerExitedError, CapabilityNotSupportedError }

/** hook/notify 事件文件路径约定:workspace 内 .codex/events-cli.jsonl,与 cc 的
 * .claude/events-cli.jsonl 同构。provision 与 spawn 都按此约定定位,保持一致。 */
export function eventsFilePath(ws: Workspace): string {
  return join(ws.root, '.codex', 'events-cli.jsonl')
}

interface Runtime {
  readonly worker_id: string
  readonly incarnation_id?: string
  readonly seq: number
  readonly dir: string
  readonly workspaceRoot: string
  /** 本 worker 专属的隔离 CODEX_HOME(= `<workspaceRoot>/.codex`),spawn/resume 全程不变。 */
  readonly codexHome: string
  readonly sessionName: string
  readonly controlEndpoint?: TmuxControlEndpoint
  sessionId: string
  /** 首投接受后发现的 rollout 文件绝对路径；发现失败时为 undefined。 */
  rolloutPath?: string
  /** 仅无头 fork 写入纯文本；交互式 tmux 化身不保留原始输出流。 */
  readonly outputLog?: OutputLog
  readonly eventChannel: CliEventChannel
  /** 仅消费本化身启动后新增的 hook；重连由 recovery capture 覆盖已有界面。 */
  readonly eventWatchOffset: number
  /** spawn 时 session 发现的结果:'discovered' 表示发现了真实 rollout 文件,'placeholder' 表示超时降级。
   * 内部状态机用,会透传到 meta 文件。 */
  sessionDiscoveryStatus: 'discovered' | 'placeholder'
  /** 首个 TUI 进程启动时刻，用于首投接受后的 rollout 发现。 */
  readonly discoveryStartedAt: number
  /** Session discovered by a synchronous sendInput; consumed by the harness settlement. */
  pendingSessionRef?: string
  controlState: CliControlState
  ended_reason?: IncarnationEndReason
  /** 自上一次 sendInput(或 spawn)以来"已计入"的 turn-complete 通知数;新计数超过它才判定
   * 本轮 idle。语义与 cc 的 stopBaseline 完全对应。 */
  stopBaseline: number
  killed: boolean
  /** CliEventChannel.watch() 的停止函数(协议 §6.2.3 的文件监视)。建立 runtime 时装上、
   * 落终态时摘掉,语义与 cc adapter 的同名字段完全一致。 */
  /** Set only for the narrow "accepted input then pane exited before return" settlement. */
  acceptedExitReport?: StateChangeReport
  stopEventWatch?: () => Promise<void>
  eventWatchDrain?: Promise<void>
  stopTraceWatch?: () => void
  interactionFingerprint?: string
  /** 是否已经被 resume 过一次。resume() 锁内检测"对同一 prev 的重复 resume"(先到先得,
   * 后来者报错),对齐 builtin/cc 同款语义(P2 review #2)。 */
  resumed?: boolean
  /** Present only for a headless query fork; mainline incarnations are owned by tmux. */
  headlessClient?: CodexAppServerClient
}

type CapturedPane = PaneSnapshot & { captured_at: string }

function controlMeta(runtime: Runtime): Record<string, string> {
  return runtime.controlEndpoint
    ? { control_socket: runtime.controlEndpoint.socket_path, control_monitor_id: runtime.controlEndpoint.monitor_id }
    : {}
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

const ROLLOUT_FILENAME_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/

/**
 * 递归遍历 sessionsDir(约定深度不超过 4 层,覆盖 `YYYY/MM/DD/` 的文档约定布局,也容忍更
 * 扁平的布局),收集文件名匹配 rollout 命名格式、mtime 不早于 cutoffMs 的候选,取文件名
 * 字典序最大的一个(文件名内嵌时间戳前缀,字典序等价时间序)。目录不存在(codex 还没来得及
 * 创建)按"没找到"处理,不抛错。
 */
async function findNewestRolloutFile(sessionsDir: string, cutoffMs: number): Promise<{ path: string; sessionId: string } | null> {
  const candidates: Array<{ path: string; sessionId: string; name: string }> = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      const match = ROLLOUT_FILENAME_RE.exec(entry.name)
      if (!match) continue
      let mtimeMs: number
      try {
        mtimeMs = (await fs.stat(full)).mtimeMs
      } catch {
        continue
      }
      if (mtimeMs < cutoffMs) continue
      candidates.push({ path: full, sessionId: match[1], name: entry.name })
    }
  }

  await walk(sessionsDir, 0)
  if (candidates.length === 0) return null
  const best = candidates.reduce((a, b) => (b.name > a.name ? b : a))
  return { path: best.path, sessionId: best.sessionId }
}

/** 有限时间轮询 findNewestRolloutFile,50ms 间隔;超时返回 null(调用方退化为占位 uuid)。
 * 找到候选文件后,优先读文件内容里的 session_meta.payload.session_id(m2 真机实测:与
 * 文件名内嵌的 uuid 完全一致,但内容字段是 codex 自己声明的权威值,文件名只是我们这边按
 * 命名约定反解——见文件头"session 发现"节);内容还没写完整/字段缺失(老版本 codex、写入
 * 竞态)就退回文件名解析出的 uuid,不因此判超时。 */
async function pollForNewRollout(sessionsDir: string, cutoffMs: number, timeoutMs: number): Promise<{ path: string; sessionId: string } | null> {
  const intervalMs = 50
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await findNewestRolloutFile(sessionsDir, cutoffMs)
    if (found) {
      const contentSessionId = await readSessionIdFromRolloutContent(found.path)
      return { path: found.path, sessionId: contentSessionId ?? found.sessionId }
    }
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** 读 rollout 文件首行的 session_meta.payload.session_id(m2 真机实测的权威字段)。首行还
 * 不是完整/合法的 session_meta(文件刚创建、还没来得及写完)一律返回 undefined,调用方退回
 * 文件名解析,不重试——真机实测文件名与内容里的 id 完全一致,这里只是"能拿到内容就优先信
 * 内容"的加固。`throwOnAccessError` 只供活性巡检定位路径时使用:ENOENT 仍是正常降级,
 * 其它读错误上抛给调用方记录 worker/seq/path;既有 spawn/readTrace 调用保持静默降级。
 * 五轮 review 修复:读出的 id 额外按 UUID_RE 校验格式,不合法(畸形值)一律当成"拿不到",
 * 打 warn 并退回文件名解析——避免畸形 id 未经校验就被写进 meta.session_id 与
 * handle.session_ref(会让 spawn 静默成功、resume/readTrace 必然失效)。 */
async function readSessionIdFromRolloutContent(
  path: string,
  throwOnAccessError: boolean = false,
): Promise<string | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf-8')
  } catch (err) {
    if (throwOnAccessError && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return undefined
  }
  const firstLine = raw.split('\n', 1)[0]
  if (!firstLine) return undefined
  let parsed: { type?: unknown; payload?: { session_id?: unknown } }
  try {
    parsed = JSON.parse(firstLine)
  } catch {
    return undefined
  }
  if (parsed?.type === 'session_meta' && typeof parsed.payload?.session_id === 'string') {
    const id = parsed.payload.session_id
    if (!UUID_RE.test(id)) {
      console.warn(`[codex-adapter] rollout content session_id is not a valid UUID, falling back to filename parse: ${path} id='${id.slice(0, 50)}'`)
      return undefined
    }
    return id
  }
  return undefined
}

/**
 * 四轮 review 修复:按已知 session_id 精确查找对应的 rollout 文件——
 * 不看 mtime,只看文件名里嵌的 uuid 是否匹配 exactly。meta 只落 session_id +
 * session_discovery 状态,不落 rolloutPath 这个绝对路径(升级前的 meta 结构就没有它,补
 * 一个字段不如直接按已知的确定性文件名规则重新找一遍,与 sessionName/outputFile 等其它
 * 重建字段的思路一致——见 ensureRuntime 注释)。同一遍历约定(深度不超过 4 层,目录不存在
 * 按"没找到"处理)复用自 findNewestRolloutFile。
 *
 * 五轮 review 修复:spawn 时的 session 发现优先信 rollout 内容里的 session_id(见
 * pollForNewRollout),与文件名内嵌的 uuid 分歧时,meta.session_id 落的是内容里的值——
 * 这里若仍然只按文件名精确匹配,分歧场景下重启后会精确匹配不到、rolloutPath 变 undefined、
 * readTrace 静默降级为空数组(尽管文件明明还在)。文件名不中时退一步遍历候选 rollout 文件
 * (同一趟遍历顺带收集,不重复扫盘),逐个读取其内容首行的 session_id 兜底匹配;命中打一条
 * warn(便于诊断"为什么按文件名找不到,但按内容能找到"),仍然找不到才返回 undefined(与
 * 原语义一致,readTrace 优雅降级)。
 */
async function findRolloutFileBySessionId(
  sessionsDir: string,
  sessionId: string,
  throwOnAccessError: boolean = false,
): Promise<string | undefined> {
  const candidates: string[] = []

  async function walk(dir: string, depth: number): Promise<string | undefined> {
    if (depth > 4) return undefined
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (throwOnAccessError && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return undefined
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const found = await walk(full, depth + 1)
        if (found) return found
        continue
      }
      const match = ROLLOUT_FILENAME_RE.exec(entry.name)
      if (!match) continue
      if (match[1] === sessionId) return full
      candidates.push(full)
    }
    return undefined
  }

  const exact = await walk(sessionsDir, 0)
  if (exact) return exact

  for (const candidate of candidates) {
    const contentSessionId = await readSessionIdFromRolloutContent(candidate, throwOnAccessError)
    if (contentSessionId === sessionId) {
      console.warn(`[codex-adapter] rollout file located via content session_id fallback (filename uuid did not match): ${candidate}`)
      return candidate
    }
  }
  return undefined
}

export class CodexWorkerAdapter implements WorkerAdapter {
  readonly implId = 'codex' as const

  private readonly tmux: TmuxDriver
  private readonly codexBin: string
  private readonly codexHomeSource: string
  private readonly sessionDiscoveryTimeoutMs: number
  private readonly pasteReadyTimeoutMs: number
  private readonly runtimes = new Map<string, Runtime>()
  private closing = false
  private disposePromise?: Promise<void>
  private get resolveUserLevelBinary(): (() => Promise<{ binary?: string; global_detected: boolean }>) | undefined {
    return this.deps.resolveUserLevelBinary
  }
  private lastDetectedVersion?: string
  private lastGlobalDetected = false
  private appServerForkSupported = false
  private lastCapabilityProbeKey?: string

  /** 同 claude adapter：resolver 存在时只认其结论，无用户级绝不回落裸命令。
   *  返回 { cmd: shell 引用形态, raw: 原始绝对路径 }（raw 供 PATH 前置等目录推导，
   *  不用正则反解 quote）。 */
  private async resolveBinForCommand(): Promise<{ cmd: string; raw?: string } | undefined> {
    // resolver 未注入（测试 fixture）：codexBin 可为 shell 片段，raw 不可知。
    if (!this.resolveUserLevelBinary) return { cmd: this.codexBin }
    const resolved = await this.resolveUserLevelBinary()
    this.lastGlobalDetected = resolved.global_detected
    return resolved.binary ? { cmd: shQuote(resolved.binary), raw: resolved.binary } : undefined
  }

  /** P6-B §6：与最近一次 detect 版本一致的静态 translator 声明。 */
  connectionCapabilities(): import('../types.js').WorkerConnectionCapability[] {
    if (!this.lastDetectedVersion) return []
    return connectionCapabilitiesFor('codex', this.lastDetectedVersion)
  }
  private readonly mutexes = new Map<string, AsyncMutex>()
  /** resolveBinDir(codexBin) 的缓存 promise——codexBin 构造后不变,没必要每次 detect/spawn/
   * resume 都重新 `command -v` + `realpath` 一遍。五轮 review 修复:只缓存*成功*的解析结果。
   * 解析失败(undefined)不固化——启动时 codex 还没装好/PATH 未生效是常见时序,若把失败也
   * 缓存住,用户随后装好 codex 后所有后续 spawn/resume 仍会拿到永久 undefined,PATH 不再
   * 前置,直接复现本文件要修的 nvm `env: node: No such file or directory` 陷阱,且要等
   * agent 重启才能自愈。见 resolveBinDirCached()。 */
  private cachedBinDir?: Promise<string | undefined>

  constructor(
    private readonly deps: {
      readonly dataDir: string
      readonly codexBin?: string
      readonly tmux?: TmuxDriver
      /** 真实登录态所在的 CODEX_HOME,默认 ~/.codex;provision 从这里搬一份 auth.json 到
       * workspace 隔离出来的 CODEX_HOME,detect() 的 activated 检查也读这里。测试用可注入
       * fixture 目录,不依赖开发机真实 home。 */
      readonly codexHomeSource?: string
      /** 用户级 CLI binary 解析（v1 无 managed install；全局安装忽略）。 */
      readonly resolveUserLevelBinary?: () => Promise<{ binary?: string; global_detected: boolean }>
      /** spawn() 发现真实 session id 的轮询上限(ms),默认 3000;测试用可调小避免拖慢用例。 */
      readonly sessionDiscoveryTimeoutMs?: number
      /** 启动期就绪握手的等待上限,默认 DEFAULT_PASTE_READY_TIMEOUT_MS(见该常量注释里的
       * 实测取值依据)。测试注入小值,避免为了走超时分支真的等一分钟。 */
      readonly pasteReadyTimeoutMs?: number
      /** `report.lastText` 本 adapter 刻意不报(理由同 cc),只报 `report.endReason`:
       * `transitionExited` 拿到的那个**必填**的 `ended_reason`。可信度与 cc 完全同构
       * (协议 §6.3):退出判定只认 `tmux.isAlive`,非 kill 一律记 `completed`,是**推断**
       * 不是确证。详见 cc adapter 同名 deps 的注释。 */
      readonly onStateChange?: (h: IncarnationHandle, state: WorkerContractState, report?: StateChangeReport) => void
      /** Signals an opportunity to incrementally read native rollout JSONL; never carries terminal output. */
      readonly onNativeActivity?: (h: IncarnationHandle) => void
    },
  ) {
    this.tmux = deps.tmux ?? new TmuxDriver()
    this.codexBin = deps.codexBin ?? 'codex'
    this.codexHomeSource = deps.codexHomeSource ?? join(homedir(), '.codex')
    this.sessionDiscoveryTimeoutMs = deps.sessionDiscoveryTimeoutMs ?? 3000
    this.pasteReadyTimeoutMs = deps.pasteReadyTimeoutMs ?? DEFAULT_PASTE_READY_TIMEOUT_MS
  }

  /** codexBin 所在真实目录(nvm 部署陷阱修复,见 resolveBinDir 注释),懒解析并缓存——但只
   * 缓存成功结果(见 cachedBinDir 字段注释)。解析中的 promise 仍然去重(并发调用不会打出
   * 一阵 `command -v` 风暴),解析出 undefined 时把缓存清空,让下一次调用重新解析;resolveBinDir
   * 内部已经 try/catch 过,这里的 promise 不会 reject,不产生 unhandled rejection。 */
  private resolveBinDirCached(): Promise<string | undefined> {
    if (!this.cachedBinDir) {
      this.cachedBinDir = resolveBinDir(this.codexBin).then((dir) => {
        if (!dir) this.cachedBinDir = undefined
        return dir
      })
    }
    return this.cachedBinDir
  }

  /** 传给 tmux newSession 的 env:PATH 前置 codexBin 所在真实目录(解析不出来就用继承的
   * PATH,不阻塞),外加调用方传入的额外变量(如 CODEX_HOME)。
   * P6-B：有 managed active binary 时 PATH 前置其目录（spawn/resume 跑的是它）。 */
  private async buildEnv(extra: Record<string, string>): Promise<Record<string, string>> {
    const binCmd = await this.resolveBinForCommand()
    // 无用户级安装时不前置任何目录（否则把被忽略的全局目录塞进 PATH）；
    // resolver 未注入（测试）沿用 resolveBinDirCached 的 PATH 前置语义。
    const dir = binCmd?.raw ? dirname(binCmd.raw) : (this.resolveUserLevelBinary ? undefined : await this.resolveBinDirCached())
    const path = dir ? `${dir}:${process.env.PATH ?? ''}` : (process.env.PATH ?? '')
    return { PATH: path, ...extra }
  }

  async detect(): Promise<DetectResult> {
    // 只认用户级安装；全局安装忽略（报 global_detected）。
    const resolved = await this.resolveBinForCommand()
    const effectiveBin = resolved?.cmd
    // binDir 只从可信来源取：resolver 的 realpath 或 resolveBinDirCached（存在性校验过）；
    // 不可从 codexBin 反解（测试注入的不存在路径会走错错误分支）。
    const binDir = resolved?.raw
      ? dirname(resolved.raw)
      : (this.resolveUserLevelBinary ? undefined : await this.resolveBinDirCached())
    const versionEnv = buildChildEnv({ PATH: binDir ? `${binDir}:${process.env.PATH ?? ''}` : (process.env.PATH ?? '') })
    let versionOutput: string
    if (!effectiveBin) {
      return { installed: false, activated: false, global_detected: this.lastGlobalDetected, detail: 'codex binary not found at user level' }
    }
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', `${effectiveBin} --version`], { env: versionEnv })
      versionOutput = stdout.trim()
    } catch (err) {
      if (binDir) {
        // codexBin 本身能被 `command -v` 定位到(装了),但跑起来仍然失败——大概率是它的
        // node 解释器解析不到(nvm 之类的部署形态、或安装本身损坏),不是"没装",错误信息
        // 需要能区分这两种情形,不能都归成一句"not found"。
        return {
          installed: false,
          activated: false,
          detail: `codex binary found at ${binDir} but failed to execute (its node interpreter may be unresolved, e.g. nvm-style install with a stale PATH): ${(err as Error).message}`,
        }
      }
      return { installed: false, activated: false, global_detected: this.lastGlobalDetected, detail: `codex binary not found or failed to run: ${(err as Error).message}` }
    }

    let activated = false
    let credentialGeneration: string | undefined
    try {
      const entries = await fs.readdir(this.codexHomeSource)
      // codex-docs: 凭据落在 CODEX_HOME/auth.json(learn.chatgpt.com/docs/auth)。config.toml
      // 存在但没登录过也可能出现,所以两者任一存在都算"至少配置过"——与 cc 检查
      // settings.json/.credentials.json 同一思路(宽松判定,不做网络调用)。
      activated = entries.includes('auth.json') || entries.includes('config.toml')
      // 代际信号要区分「换账号/重登」与「例行 token 刷新」：
      // - OAuth flavor（tokens.account_id）：刷新会重写文件（mtime 骗人），用 account_id
      //   这个非敏感身份字段（不是 credential 本体，且本来就出现在请求 header 里）；
      // - API key flavor（OPENAI_API_KEY 静态）：codex 不会因刷新重写，mtime+size 即可。
      // config.toml 的 mtime+size 恒参与（endpoint/model 变更必须让 binding 失效）。
      const parts: string[] = []
      try {
        const authRaw = await fs.readFile(join(this.codexHomeSource, 'auth.json'), 'utf-8')
        const parsed = JSON.parse(authRaw) as { tokens?: { account_id?: unknown } }
        const accountId = parsed.tokens?.account_id
        if (typeof accountId === 'string' && accountId) {
          parts.push(`account:${accountId}`)
        } else {
          const stat = await fs.stat(join(this.codexHomeSource, 'auth.json'))
          parts.push(`auth.json:${stat.mtimeMs}:${stat.size}`)
        }
      } catch { /* auth.json 缺失/损坏：不参与 */ }
      // config.toml 用语义摘要而非 mtime：codex 运行时会重写 config.toml（实测 verify 跑一次
      // mtime 就变），mtime 判据会让「verify 自己」把 binding 弄失效。只摘要决定请求去向的
      // 三个键（model_provider/model/model_providers），trust/projects 等日常变动不参与。
      try {
        const configRaw = await fs.readFile(join(this.codexHomeSource, 'config.toml'), 'utf-8')
        const parsed = asTable(parseToml(configRaw))
        const semantic = {
          model_provider: parsed.model_provider ?? null,
          model: parsed.model ?? null,
          model_providers: parsed.model_providers ?? null,
        }
        parts.push(`config:${createHash('sha256').update(JSON.stringify(semantic)).digest('hex').slice(0, 16)}`)
      } catch { /* 缺失/损坏不参与 */ }
      if (parts.length > 0) credentialGeneration = parts.join(',')
    } catch {
      activated = false
    }

    // 'codex-cli 0.146.0' → '0.146.0'
    const version = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(versionOutput)?.[1]
    this.lastDetectedVersion = version
    if (!version) {
      this.appServerForkSupported = false
      this.lastCapabilityProbeKey = undefined
    } else {
      const capabilityProbeKey = `${effectiveBin}\n${version}`
      if (this.lastCapabilityProbeKey !== capabilityProbeKey) {
        const probeHome = await fs.mkdtemp(join(tmpdir(), 'crabot-codex-app-server-probe-'))
        try {
          this.appServerForkSupported = await probeCodexAppServerFork({
            command: `${effectiveBin} app-server --stdio`,
            cwd: probeHome,
            env: {
              ...buildScrubbedChildEnv(),
              PATH: binDir ? `${binDir}:${process.env.PATH ?? ''}` : (process.env.PATH ?? ''),
              CODEX_HOME: probeHome,
            },
          })
          this.lastCapabilityProbeKey = capabilityProbeKey
        } finally {
          await fs.rm(probeHome, { recursive: true, force: true }).catch(() => {})
        }
      }
    }
    return { installed: true, activated, version, install_source: 'user', credential_generation: credentialGeneration, global_detected: false, detail: versionOutput }
  }

  /**
   * 读宿主 CODEX_HOME 的 config.toml 作为 workspace 配置的基底。
   *
   * - 文件不存在(全新机器 / 没配过 codex)→ 返回空表,干净降级成"只有 crabot 三块"。
   * - 其它读失败(权限等)与解析失败 → 显式抛错,**不静默降级**:降级出来的配置会精确
   *   重现本 adapter 修掉的那个生产事故——auth.json 搬了、端点回落到官方默认,worker 拿着
   *   自建镜像的 key 打 api.openai.com 报 401,而且无声无息。宁可 provision 失败。
   *   (同 cc adapter 写全局 ~/.claude.json 时"宁可 provision 失败也不能覆盖掉它"的纪律。)
   * - 错误消息只带路径与解析位置:smol-toml 的 err.message 里嵌了出错处的代码片段,宿主
   *   配置可能含凭据,那段内容绝不能进错误消息 / 日志。
   */
  private async readHostConfig(): Promise<Record<string, unknown>> {
    const hostConfigPath = join(this.codexHomeSource, 'config.toml')
    let raw: string
    try {
      raw = await fs.readFile(hostConfigPath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error(
        `CodexWorkerAdapter.provision: cannot read host codex config at ${hostConfigPath} ` +
          `(${(err as NodeJS.ErrnoException).code ?? 'unknown error'})`,
      )
    }
    try {
      return asTable(parseToml(raw))
    } catch (err) {
      const at = err as { line?: number; column?: number }
      const where = at.line !== undefined ? ` at line ${at.line}, column ${at.column}` : ''
      throw new Error(
        `CodexWorkerAdapter.provision: host codex config at ${hostConfigPath} is not valid TOML${where}. ` +
          `Fix it (or remove it) before running codex workers — provisioning without it would silently ` +
          `fall back to codex's built-in defaults, sending requests to the wrong endpoint.`,
      )
    }
  }

  /**
   * admin_provider：把 provision 生成的 workspace CODEX_HOME 配置与 translator 的
   * runtime 配置合并（translator 的 model_provider/model/[model_providers.*] 胜出；
   * notify/trust/mcp 等能力配置取自 provision 版）。auth.json 不复制（env_key 鉴权）。
   */
  private async mergeAdminProviderCodexHome(
    workspaceRoot: string,
    workspaceCodexHome: string,
    runtimeCodexHome: string,
    operation: 'spawn' | 'resume',
  ): Promise<void> {
    const readToml = async (file: string): Promise<Record<string, unknown>> => {
      try {
        return asTable(parseToml(await fs.readFile(file, 'utf-8')))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
        throw err
      }
    }
    // 此目录会成为交互式 worker 实际使用的 CODEX_HOME；即便它来自 admin runtime，也不能
    // 让未知 hooks.json/plugins 与自动 trust 同时存在。
    await assertNoCodexHookSources(runtimeCodexHome, operation)
    const provisioned = await readToml(join(workspaceCodexHome, 'config.toml'))
    const translator = await readToml(join(runtimeCodexHome, 'config.toml'))
    stripUntrustedCodexHookSources(translator)
    // 根级标量：translator 的 model/model_provider 覆盖；provision 的 notify 等保留。
    const merged: Record<string, unknown> = { ...provisioned, ...translator }
    // table 级：model_providers 两边都是表——translator 的 crabot-admin 条目必须保留，
    // provision 的宿主条目也保留（codex 只按 model_provider 指针选用，不冲突）。
    if (provisioned.model_providers && translator.model_providers) {
      merged.model_providers = { ...provisioned.model_providers as object, ...translator.model_providers as object }
    }
    await writeSensitiveFileAtomic(join(runtimeCodexHome, 'config.toml'), stringifyToml(asTable(merged)))
  }

  async preflightProvision(ws: Workspace, _caps: CapabilityBundle): Promise<void> {
    this.assertActive()
    await assertWorkspaceFilesUntracked(ws.root, CODEX_CREDENTIAL_FILES, 'CodexWorkerAdapter.provision')
  }

  async provision(ws: Workspace, caps: CapabilityBundle): Promise<void> {
    this.assertActive()
    const codexDir = join(ws.root, '.codex')
    // 已跟踪的 credential target 必须在任何 provision 写入前拒绝；ignore 必须先于敏感文件落盘。
    await this.preflightProvision(ws, caps)
    await fs.mkdir(codexDir, { recursive: true })
    await assertNoCodexHookSources(codexDir)
    await fs.writeFile(join(codexDir, '.gitignore'), '*\n', 'utf-8')

    const channel = new CliEventChannel(eventsFilePath(ws))
    // codex-docs: notify 只支持在"顶层用户配置"这层 config.toml 里声明,项目级
    // .codex/config.toml 里的 notify 会被 codex 忽略并打印启动告警(config-basic 限制清单
    // 明确包含 notify)。本 adapter 把 <ws.root>/.codex 整个目录当作这个 worker 专属的
    // CODEX_HOME(spawn/resume 经 tmux env 传递),绕开这条项目级限制。
    //
    // notify 的程序契约是"数组:可执行文件 + 固定参数",codex 运行时会在末尾追加一个 JSON
    // payload 作为额外参数(config-advanced 原文确认)。这里用 `/bin/sh -c <script>` 包一层;
    // payload 落在 shell 的 $0 上。Stop 事件只需要 turn 边界标记,不解析这个 argv payload;
    // Claude Code hook 则由 stdin 接收并记录原始 JSON。Codex notify 的 stdin 必须显式关闭,
    // 否则 hook 会从 pane pty 读取并与 TUI 争抢输入。
    const notify = ['/bin/sh', '-c', `(${channel.hookCommand('stop')}) </dev/null`]

    // codex 源码里交互式 TUI 判断"是否受信目录"的真实机制是 config.toml 的
    // [projects."<绝对路径>"] 表 + trust_level = "trusted"(取代不存在的 --skip-git-repo-check
    // flag,见文件头"spawn/resume 启动参数"节)。path 用 ws.root 的 realpath(worker workspace
    // 可能经符号链接到达,codex 内部按规范化后的路径比较)。
    const realRoot = await fs.realpath(ws.root)

    // 隔离 CODEX_HOME 必须整份继承宿主登录态,不能只搬 auth.json:宿主 config.toml 里的
    // model_provider / [model_providers.*].base_url 才是"请求发去哪"。只搬 key 不搬端点会
    // 让 worker 拿着自建镜像的 key 打官方 api.openai.com,报 401 invalid_api_key(生产实证)。
    const config = await this.readHostConfig()

    config.notify = notify
    // Worker 的隔离 CODEX_HOME 只继承连接相关配置，不能把宿主 hooks 或可安装 hook 的插件
    // 配置带进来；下方仅装配 Crabot 自己生成的 PermissionRequest hook，再由 spawn/resume
    // 自动信任这一已知来源。
    stripUntrustedCodexHookSources(config)
    // 隔离 home 需要自己的 PermissionRequest hook；不能继承宿主为了交互环境设下的
    // `[features] hooks = false`，否则本 worker 会静默失去交互唤醒能力。
    config.features = { ...asTable(config.features), hooks: true }
    config.hooks = generatedCodexPermissionRequestHooks(channel.hookCommand('permission_request'))

    // 宿主已有的 [projects."别的目录"] 一并留着(codex 只按路径匹配,带过来无害),但本
    // workspace 这条必须由 crabot 说了算,不能被宿主的同名表挤掉。
    const hostProjects = asTable(config.projects)
    config.projects = { ...hostProjects, [realRoot]: { trust_level: 'trusted' } }

    // mcp_servers 由 crabot 的能力集**整体覆盖**,不与宿主合并:caps 是这个任务的授权边界,
    // 宿主配置不该有能力把它扩大。复用 renderCodexMcpToml 保持 mcp 段形状的单一真相来源,
    // 解析回对象只是为了并进同一份文档统一序列化。
    const mcpServers = caps.mcp_servers as unknown as ProvisionSources['mcpServers']
    const renderedMcp = asTable(parseToml(renderCodexMcpToml(mcpServers)).mcp_servers)
    if (Object.keys(renderedMcp).length > 0) config.mcp_servers = renderedMcp
    else delete config.mcp_servers

    // TOML 要求根级 key 必须出现在第一个 table 之前,否则会被解析成前一个 table 的子字段。
    // 叠加了宿主配置之后靠字符串拼接已经保证不了这条(宿主自带 table),改由序列化器统一
    // 排布:smol-toml 的 stringify 先出根级标量、再出 table。
    await writeSensitiveFileAtomic(join(codexDir, 'config.toml'), stringifyToml(config))

    // codex-docs: 既然 .codex/ 在这里被当成独立 CODEX_HOME,真实登录态里的 auth.json 要搬
    // 一份过来,否则隔离出来的 CODEX_HOME 过不了鉴权。找不到就跳过(本机/CI 未 `codex
    // login`)——不阻塞 provision,登录态缺失会在真正 spawn 时体现为 codex 进程报错,不是
    // provision 的职责。
    try {
      const authRaw = await fs.readFile(join(this.codexHomeSource, 'auth.json'), 'utf-8')
      const authPath = join(codexDir, 'auth.json')
      await writeSensitiveFileAtomic(authPath, authRaw)
    } catch {
      // 忽略:本机未登录/测试环境本就没有 auth.json
    }

    // codex-docs: skills 支持 .codex/skills/(项目级)或 ~/.codex/skills/(个人级);本方案下
    // .codex/ 本身就是 CODEX_HOME,两个语义重合到同一目录。
    await materializeSkills(ws.root, caps.skills, '.codex/skills')

  }

  private async capture(runtime: Runtime): Promise<CapturedPane> {
    const snapshot = await this.tmux.capturePane(runtime.sessionName)
    const captured = { text: snapshot.text, dead: snapshot.dead, captured_at: new Date().toISOString() }
    if (!snapshot.dead) {
      await writeFinalTerminalSnapshot(runtime.dir, runtime.seq, captured.text, captured.captured_at).catch((error) => {
        console.warn(`[CodexWorkerAdapter] terminal snapshot write failed for ${runtime.worker_id}#${runtime.seq}:`, error)
      })
    }
    return captured
  }

  private liveTerminal(snapshot: PaneSnapshot): WorkerTerminalView {
    if (snapshot.dead) return { kind: 'unavailable', unavailable_reason: 'terminal_session_missing' }
    return { kind: 'live_terminal', text: snapshot.text, captured_at: snapshot.captured_at ?? new Date().toISOString() }
  }

  private async persistFinalTerminal(runtime: Runtime): Promise<WorkerTerminalView | undefined> {
    await this.capture(runtime).catch(() => undefined)
    const final = await readFinalTerminalSnapshot(runtime.dir, runtime.seq)
    return final ? { kind: 'final_terminal', ...final } : undefined
  }

  private async isPasteReady(runtime: Runtime): Promise<boolean> {
    return runtime.controlEndpoint
      ? (await this.tmux.getPasteReadiness(runtime.controlEndpoint)).state === 'ready'
      : false
  }

  private async sendRawInput(runtime: Runtime, h: IncarnationHandle, text: string): Promise<void> {
    return this.sendControlKeys(runtime, h, parseRawControlKeys(text))
  }

  private async sendControlKeys(runtime: Runtime, h: IncarnationHandle, keys: readonly string[], notify = false): Promise<void> {
    let keysSent = false
    try {
      const before = await this.capture(runtime)
      await this.tmux.sendKeys(runtime.sessionName, [...keys])
      keysSent = true
      const snapshot = await waitForPaneChange(() => this.capture(runtime), before.text)
      const interaction = classifyCodexTerminalInteraction(snapshot)
      const primaryProbe = probeCodexInput(snapshot, 'primary', undefined, false)
      const paneShowsWorkingAfterRaw = /Working\b/i.test(snapshot.text)
      if (primaryProbe === 'pending') {
        runtime.interactionFingerprint = undefined
        const next: CliControlState = runtime.controlState.kind === 'running' || paneShowsWorkingAfterRaw
          ? { kind: 'running' }
          : { kind: 'waiting_action', reason: 'input_pending' }
        const report: StateChangeReport = { terminal: this.liveTerminal(snapshot), waitReason: 'input_pending' }
        await this.transitionControlState(runtime, h, next, report, notify, notify)
        throw new CliInputStallError('pending_in_ui', next.kind, report)
      }
      if (primaryProbe === 'empty' && (runtime.controlState.kind === 'running' || paneShowsWorkingAfterRaw)) {
        runtime.interactionFingerprint = undefined
        await this.transitionControlState(runtime, h, { kind: 'running' })
        return
      }
      if (primaryProbe === 'empty') {
        runtime.interactionFingerprint = undefined
        await this.transitionControlState(runtime, h, { kind: 'waiting_text' })
        return
      }
      const reason = runtime.controlState.kind === 'waiting_action'
        ? runtime.controlState.reason
        : 'input_surface_unavailable'
      if (interaction.kind === 'none') runtime.interactionFingerprint = undefined
      const report: StateChangeReport = {
        terminal: this.liveTerminal(snapshot),
        waitReason: reason,
        ...(interaction.kind === 'manager_required' ? { ui: { fingerprint: interaction.fingerprint, actions: interaction.actions } } : {}),
        ...(interaction.kind === 'manager_required' ? { notification: { type: 'terminal_interaction' } } : {}),
      }
      await this.transitionControlState(
        runtime,
        h,
        { kind: 'waiting_action', reason },
        report,
        notify,
        notify,
      )
      throw new CliInputStallError('not_pasted', 'waiting_action', report)
    } catch (error) {
      if (!(await this.tmux.isAlive(runtime.sessionName))) {
        const reason: IncarnationEndReason = keysSent ? 'completed' : 'crashed'
        await this.transitionExited(runtime, h, reason, false)
        if (keysSent) {
          runtime.acceptedExitReport = { endReason: reason }
          return
        }
        throw new WorkerExitedError(h.worker_id, h.seq, reason)
      }
      throw error
    }
  }

  private async sendUiText(runtime: Runtime, h: IncarnationHandle, text: string, notify = false): Promise<void> {
    let submitted = false
    try {
      const before = await this.capture(runtime)
      await this.tmux.sendText(runtime.sessionName, text)
      submitted = true
      const snapshot = await waitForPaneChange(() => this.capture(runtime), before.text)
      const primaryProbe = probeCodexInput(snapshot, 'primary', undefined, false)
      if (primaryProbe !== 'empty') {
        const interaction = classifyCodexTerminalInteraction(snapshot)
        if (interaction.kind === 'none') runtime.interactionFingerprint = undefined
        const report: StateChangeReport = {
          terminal: this.liveTerminal(snapshot),
          waitReason: 'interaction_required',
          ...(interaction.kind === 'manager_required' ? { ui: { fingerprint: interaction.fingerprint, actions: interaction.actions } } : {}),
          ...(interaction.kind === 'manager_required' ? { notification: { type: 'terminal_interaction' } } : {}),
        }
        await this.transitionControlState(
          runtime,
          h,
          { kind: 'waiting_action', reason: 'interaction_required' },
          report,
          notify,
          notify,
        )
        return
      }
      runtime.interactionFingerprint = undefined
      await this.transitionControlState(runtime, h, { kind: 'running' })
    } catch (error) {
      if (!(await this.tmux.isAlive(runtime.sessionName))) {
        const reason: IncarnationEndReason = submitted ? 'completed' : 'crashed'
        await this.transitionExited(runtime, h, reason, false)
        if (submitted) return
        throw new WorkerExitedError(h.worker_id, h.seq, reason)
      }
      throw error
    }
  }

  private async discoverSpawnedSession(
    runtime: Runtime,
    h: IncarnationHandle,
  ): Promise<IncarnationHandle> {
    const discovered = await pollForNewRollout(join(runtime.codexHome, 'sessions'), runtime.discoveryStartedAt, this.sessionDiscoveryTimeoutMs)
    runtime.sessionId = discovered?.sessionId ?? randomUUID()
    runtime.rolloutPath = discovered?.path
    runtime.sessionDiscoveryStatus = discovered ? 'discovered' : 'placeholder'
    const discoveredHandle = { ...h, session_ref: runtime.sessionId }
    if (!discovered) {
      console.warn(
        `[codex-adapter] session discovery timed out for ${h.worker_id}, using placeholder uuid; resume/readTrace will degrade`,
      )
    }
    if (runtime.controlState.kind === 'exited') {
      await this.transitionExited(runtime, discoveredHandle, runtime.controlState.reason ?? runtime.ended_reason ?? 'crashed', false)
    } else {
      await this.transitionControlState(runtime, discoveredHandle, runtime.controlState, undefined, false)
    }
    this.startNativeTraceWatch(runtime, discoveredHandle)
    return discoveredHandle
  }

  private async commitGuardedInput(
    runtime: Runtime,
    h: IncarnationHandle,
    text: string,
    mode: InputMode,
    notify: boolean,
    foldStop: boolean,
    delivery?: SendInputOptions,
  ): Promise<InitialInputResult> {
    let baseline = ''
    let pasted = false
    let result
    try {
      baseline = (await this.capture(runtime)).text
      if (!(await this.isPasteReady(runtime))) {
        const snapshot = await this.capture(runtime)
        const report: StateChangeReport = { terminal: this.liveTerminal(snapshot), waitReason: 'input_surface_unavailable' }
        const next: CliControlState = mode === 'steering' && runtime.controlState.kind === 'running'
          ? { kind: 'running' }
          : { kind: 'waiting_action', reason: 'input_surface_unavailable' }
        await this.transitionControlState(runtime, h, next, report, notify)
        return { control_state: next.kind, disposition: 'not_pasted', report }
      }
      result = await commitInput(
        {
          pasteText: async (value) => {
            await this.tmux.pasteText(runtime.sessionName, value)
            pasted = true
          },
          sendEnter: () => this.tmux.sendKeys(runtime.sessionName, ['Enter']),
          capture: () => this.capture(runtime),
        },
        (snapshot, phase) => probeCodexInput(snapshot, mode, phase === 'after_paste' ? text : undefined, phase === 'before_paste'),
        (snapshot) => acceptedCodexInput(snapshot, mode, text, baseline),
        text,
        {
          beforeSideEffect: (phase) =>
            assertInputDeliveryActive(delivery, phase === 'paste' ? 'not_delivered' : 'unknown'),
        },
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
          const report: StateChangeReport = { completionSource: 'codex_turn_complete' }
          await this.transitionControlState(runtime, h, { kind: 'waiting_text' }, report, notify)
          return { control_state: 'waiting_text', disposition: 'accepted', report }
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
      terminal: this.liveTerminal(result.snapshot),
      waitReason,
    }
    await this.transitionControlState(runtime, h, next, report, notify)
    return { control_state: next.kind, disposition: result.disposition, report }
  }

  async spawn(spec: SpawnSpec): Promise<IncarnationHandle> {
    this.assertActive()
    const seq = 1
    if (this.runtimes.has(instanceKey({ worker_id: spec.worker_id, seq }))) {
      throw new Error(`CodexWorkerAdapter.spawn: worker_id ${spec.worker_id} already spawned in this process`)
    }

    const dir = join(this.deps.dataDir, spec.worker_id)
    await fs.mkdir(dir, { recursive: true })

    // P6-B admin_provider：CODEX_HOME 是 admission 产出的 runtime 目录——translator 的
    // config.toml（model_provider/model/model_providers）必须**合并** provision 写到
    // workspace 的那份（notify/trust/mcp/skills 都在里面），整体替换会把它们全丢掉。
    // 且该化身后续的 session/rollout 都落在 runtime CODEX_HOME——runtime.codexHome 必须
    // 指向它，否则 pollForNewRollout 扑空、resume 抛 has no discovered rollout。
    let codexHome = join(spec.workspace.root, '.codex')
    const runtimeCodexHome = spec.connection_env?.CODEX_HOME
    if (runtimeCodexHome) {
      await this.mergeAdminProviderCodexHome(spec.workspace.root, codexHome, runtimeCodexHome, 'spawn')
      codexHome = runtimeCodexHome
    }
    const sessionName = `crabot-w-${spec.worker_id}-${seq}`
    // codex-docs + m2 实测:交互态无 --session-id 等价参数;--approve-for-me 在
    // workspace-write 沙箱内把审批交给 Codex 的自动审查，不能用 never/yolo 跳过审批。
    // 不传 --skip-git-repo-check(m2 实测顶层交互式 codex 不支持这个 flag,只有 codex exec
    // 才有——见文件头"spawn/resume 启动参数"节);受信目录改由 provision 写进 config.toml 的
    // [projects."<realpath>"] trust_level = "trusted" 解决。
    // 网络放行见文件头"spawn/resume 启动参数"节。
    // newSession 成功之后才落 meta(running)+注册 runtime,同 cc 纪律:tmux 失败时不留任何
    // 持久痕迹,同 worker_id 可安全重试。CODEX_HOME 经 tmux -e 传给会话进程(execFile 直传
    // argv,不经过 shell 插值,不需要额外转义);PATH 同样经 -e 显式前置 codexBin 所在真实
    // 目录(nvm 部署陷阱,见 buildEnv/resolveBinDir 注释),不依赖 tmux server 自身环境。
    const eventChannel = new CliEventChannel(eventsFilePath(spec.workspace))
    const eventWatchOffset = await eventChannel.endOffset()
    const stopBaseline = await this.initialStopBaseline(eventChannel)
    const spawnBin = (await this.resolveBinForCommand())?.cmd
    if (!spawnBin) throw new WorkerImplUnavailableError('CodexWorkerAdapter.spawn: no user-level codex installation')
    const env = await this.buildEnv({ CODEX_HOME: spec.connection_env?.CODEX_HOME ?? codexHome, ...spec.connection_env })
    await assertNoCodexHookSources(codexHome, 'spawn')
    await installGeneratedCodexHookConfiguration(codexHome, eventChannel, 'spawn')
    const command = `${spawnBin} --approve-for-me ${CODEX_NETWORK_ACCESS_OPT} ${CODEX_HOOK_TRUST_OPT}`
    const spawnStartedAt = Date.now()
    const controlEndpoint = await this.tmux.newSession({
      name: sessionName, cwd: spec.workspace.root, command,
      // connection_env（admin_provider CODEX_HOME/env_key）优先级高于 workspace 默认。
      env,
    })

    // Codex 0.146 在首条 prompt 提交前不会创建 rollout。这里先建立空 session_ref 的
    // runtime，待 guarded initial input 被接受后再发现真实 session；启动期未投递则保持空值。
    const sessionId = ''
    const sessionDiscoveryStatus: 'discovered' | 'placeholder' = 'placeholder'

    let handle: IncarnationHandle = { worker_id: spec.worker_id, incarnation_id: spec.incarnation_id, seq, impl: 'codex', session_ref: sessionId }

    const runtime: Runtime = {
      worker_id: spec.worker_id,
      incarnation_id: spec.incarnation_id,
      seq,
      dir,
      workspaceRoot: spec.workspace.root,
      codexHome,
      sessionName,
      controlEndpoint,
      sessionId,
      rolloutPath: undefined,
      eventChannel,
      eventWatchOffset,
      sessionDiscoveryStatus,
      discoveryStartedAt: spawnStartedAt,
      controlState: { kind: 'running' },
      stopBaseline,
      killed: false,
    }

    await writeMetaAtomic(dir, seq, {
      seq,
      state: 'running',
      session_id: sessionId,
      session_discovery: sessionDiscoveryStatus,
      workspace_root: spec.workspace.root,
      codex_home: codexHome,
      ...controlMeta(runtime),
    })
    this.runtimes.set(instanceKey(handle), runtime)
    try {
      await controlEndpoint.enableRemainOnExit?.()
    } catch (error) {
      await this.transitionExited(runtime, handle, 'crashed')
      throw error
    }

    // 启动期就绪握手(见 tmux/paste-ready.ts),排在 session 发现**之前**:
    // - 它才是"能不能收输入"的判据。session 发现等的是 rollout 文件出现,那是"会话已建立"
    //   的信号——启动期被模态框挡住时会话根本不会建立,那个轮询于是空转到超时,然后照样把
    //   prompt 发出去(这正是本次要根治的"降级继续");
    // - 顺带让 session 发现更稳:m2 实测 rollout 文件在 tmux 建会话约 3 秒后才落盘,几乎顶满
    //   原来那个 3s 窗口;就绪握手先吸收掉启动耗时,发现窗口从"已经能收输入"那一刻才开始算。
    const pasteReady = await waitForPasteReady(() => this.tmux.getPasteReadiness(controlEndpoint), {
      timeoutMs: this.pasteReadyTimeoutMs,
      isAlive: () => this.tmux.isAlive(sessionName),
    })
    if (!pasteReady) {
      console.warn(
        `[codex-adapter] startup readiness handshake timed out for ${spec.worker_id}; opening input NOT delivered, session_ref left empty`,
      )
    }

    // 等不到就绪就**不投递**(协议 §5.5 的"不安全态暂扣"):prompt 原封不动留在 spec 里没被
    // 消耗,manager 处理掉障碍后经 send_to_worker 重新投递即可。这里绝不能退化成"超时了也
    // 照发"——那正是 pollForNewRollout 现在的写法,也正是本次要根治的行为。
    if (!pasteReady) {
      const initial_input = await this.initialStartupStall(runtime, handle)
      this.startEventWatch(runtime, handle)
      return { ...handle, initial_input }
    }

    let initial_input: InitialInputResult
    try {
      initial_input = await this.commitGuardedInput(runtime, handle, spec.prompt, 'primary', false, true)
    } catch (err) {
      await this.getMutex(handle.worker_id).run(async () => {
        if (runtime.controlState.kind === 'exited') return
        await this.transitionExited(runtime, handle, 'crashed')
      })
      throw err
    }
    if (initial_input.disposition === 'accepted') {
      handle = await this.discoverSpawnedSession(runtime, handle)
      await this.syncState(runtime, handle, 'completed', false)
      initial_input = {
        ...initial_input,
        control_state: runtime.controlState.kind,
        ...(runtime.controlState.kind === 'exited'
          ? { report: { ...initial_input.report, endReason: runtime.controlState.reason } }
          : {}),
      }
    }
    this.startEventWatch(runtime, handle)
    return { ...handle, initial_input }
  }

  async resume(prev: IncarnationRef, wakeInput: string, opts?: ResumeOptions): Promise<IncarnationHandle> {
    this.assertActive()
    validateSessionRef(prev.session_ref)

    // 四轮 review 修复(同 cc adapter):prevRuntime 不再要求"常驻本进程"——resume 的合法
    // 目标本来就是一个已终态的化身,ensureRuntime 从落盘 meta 重建它(重建不以 tmux 存活为
    // 门槛,只有 meta 完全不存在才返回 undefined,见该方法注释)。
    const prevRuntime = await this.ensureRuntime(prev)
    if (!prevRuntime) {
      throw new Error(`CodexWorkerAdapter.resume: no such incarnation ${prev.worker_id}#${prev.seq} resident in this process`)
    }
    const prevHandle: IncarnationHandle = { worker_id: prev.worker_id, incarnation_id: prev.incarnation_id, seq: prev.seq, impl: 'codex', session_ref: prev.session_ref }
    const { state: prevState } = await this.syncState(prevRuntime, prevHandle)
    if (prevState !== 'exited') {
      throw new Error(`CodexWorkerAdapter.resume: incarnation ${prev.worker_id}#${prev.seq} has not exited yet (state=${prevState})`)
    }
    // 重建出的 prevRuntime 若来自缺 workspace_root 的老 meta(升级前写入,已知限制),
    // workspaceRoot/codexHome 都退化为空串——不能悄悄传给 tmux newSession,显式拒绝。
    if (!prevRuntime.workspaceRoot) {
      throw new Error(
        `CodexWorkerAdapter.resume: cannot rebuild workspace for ${prev.worker_id}#${prev.seq} ` +
          `(meta.json predates workspace_root persistence; this incarnation cannot be resumed after an adapter restart)`,
      )
    }

    if (prevRuntime.sessionDiscoveryStatus !== 'discovered' || !prevRuntime.rolloutPath) {
      throw new Error(`CodexWorkerAdapter.resume: incarnation ${prev.worker_id}#${prev.seq} has no discovered rollout and cannot be resumed`)
    }

    const dir = prevRuntime.dir

    // 重复 resume 检测(先到先得)+ seq 分配(nextSeq(),该 worker 现存所有化身 max seq + 1)+
    // tmux newSession + 提交(meta+runtime+resumed 标记)整体在该 worker 的互斥锁内原子完成,
    // 与 cc adapter.ts 同款修复(见其 resume() 注释、P2 review #1/#2):nextSeq() 避免撞号;
    // resumed 标记避免并发/连续 resume 同一 exited prev 各起一个 tmux 会话跑 `codex resume`
    // 同一 session id——那不是 resume 想要的语义,应先到先得、后来者报错。resumed 标记必须
    // 在 writeMeta 成功之后才提交,保证失败路径(newSession 抛错)幂等可重试。
    let handle!: IncarnationHandle
    let runtime!: Runtime
    await this.getMutex(prev.worker_id).run(async () => {
      if (prevRuntime.resumed) {
        throw new Error(`CodexWorkerAdapter.resume: incarnation ${prev.worker_id}#${prev.seq} already resumed (concurrent resume of the same prev incarnation?)`)
      }
      const seq = await this.nextSeq(prev.worker_id)
      handle = { worker_id: prev.worker_id, incarnation_id: opts?.incarnation_id, seq, impl: 'codex', session_ref: prev.session_ref }
      const sessionName = `crabot-w-${prev.worker_id}-${seq}`
      // codex-docs: `codex resume <SESSION_ID>` 是独立子命令(不是 --resume flag)。
      // m2 实测:--approve-for-me/-c 这类主命令级选项必须排在 `resume` 子命令**之前**
      // ——放在 `resume <id>` 后面 codex 会报 usage 错、exit=2(原实现把它们放在 `resume <id>`
      // 之后,是未经真机验证的错误猜测,这里按实测结果改正)。不传 --skip-git-repo-check,
      // 理由同 spawn(见文件头"spawn/resume 启动参数"节)。-c 同属主命令级选项,同样放在
      // `resume` 之前。
      // P6-B admin_provider resume：上一化身的 runtime CODEX_HOME 已随终态清理，
      // 本次 admission 产出新目录——同样要合并 provision 配置（translator 配置胜出）。
      let resumeCodexHome = prevRuntime.codexHome
      const resumeRuntimeHome = opts?.connection_env?.CODEX_HOME
      if (resumeRuntimeHome) {
        await this.mergeAdminProviderCodexHome(prevRuntime.workspaceRoot, join(prevRuntime.workspaceRoot, '.codex'), resumeRuntimeHome, 'resume')
        resumeCodexHome = resumeRuntimeHome
      }

      // 锁纪律与 spawn 一致:tmux newSession 成功之后才落 meta(running)+注册 runtime;
      // PATH 前置同 spawn(nvm 部署陷阱)。
      const eventChannel = new CliEventChannel(eventsFilePath({ root: prevRuntime.workspaceRoot }))
      const eventWatchOffset = await eventChannel.endOffset()
      const stopBaseline = await this.initialStopBaseline(eventChannel)
      const resumeBin = (await this.resolveBinForCommand())?.cmd
      if (!resumeBin) throw new WorkerImplUnavailableError('CodexWorkerAdapter.resume: no user-level codex installation')
      const env = await this.buildEnv({ ...opts?.connection_env, CODEX_HOME: resumeCodexHome })
      await assertNoCodexHookSources(resumeCodexHome, 'resume')
      await installGeneratedCodexHookConfiguration(resumeCodexHome, eventChannel, 'resume')
      const command = `${resumeBin} --approve-for-me ${CODEX_NETWORK_ACCESS_OPT} ${CODEX_HOOK_TRUST_OPT} resume ${shQuote(prev.session_ref)}`
      const controlEndpoint = await this.tmux.newSession({
        name: sessionName, cwd: prevRuntime.workspaceRoot, command,
        env,
      })

      runtime = {
        worker_id: prev.worker_id,
        incarnation_id: opts?.incarnation_id,
        seq,
        dir,
        workspaceRoot: prevRuntime.workspaceRoot,
        codexHome: resumeCodexHome,
        sessionName,
        controlEndpoint,
        sessionId: prev.session_ref,
        // resume 续写的是同一个 rollout 文件(session id 不变),不需要重新发现——直接沿用上一
        // 化身已发现的路径;上一化身当时若发现失败(占位 uuid),这里同样拿不到,保持未知。
        rolloutPath: prevRuntime.rolloutPath,
        eventChannel,
        eventWatchOffset,
        sessionDiscoveryStatus: prevRuntime.sessionDiscoveryStatus,
        discoveryStartedAt: Date.now(),
        controlState: { kind: 'running' },
        // 复用上一化身的 workspace ⇒ 事件文件里已有它留下的通知,基线必须现读现算(见
        // initialStopBaseline 注释)。
        stopBaseline,
        killed: false,
      }

      await writeMetaAtomic(dir, seq, {
        seq,
        state: 'running',
        session_id: prev.session_ref,
        session_discovery: prevRuntime.sessionDiscoveryStatus,
        workspace_root: prevRuntime.workspaceRoot,
        codex_home: resumeCodexHome,
        ...controlMeta(runtime),
      })
      this.runtimes.set(instanceKey(handle), runtime)
      try {
        await controlEndpoint.enableRemainOnExit?.()
      } catch (error) {
        await this.transitionExited(runtime, handle, 'crashed')
        throw error
      }
      prevRuntime.resumed = true
    })

    const pasteReady = await waitForPasteReady(() => runtime.controlEndpoint
      ? this.tmux.getPasteReadiness(runtime.controlEndpoint)
      : Promise.resolve({ state: 'unknown' }), {
      timeoutMs: this.pasteReadyTimeoutMs,
      isAlive: () => this.tmux.isAlive(runtime.sessionName),
    })
    if (!pasteReady) {
      const initial_input = await this.initialStartupStall(runtime, handle)
      this.startEventWatch(runtime, handle)
      return { ...handle, initial_input }
    }

    let initial_input: InitialInputResult
    try {
      initial_input = await this.commitGuardedInput(runtime, handle, wakeInput, 'primary', false, true)
    } catch (err) {
      await this.getMutex(handle.worker_id).run(async () => {
        if (runtime.controlState.kind === 'exited') return
        await this.transitionExited(runtime, handle, 'crashed')
      })
      throw err
    }
    this.startEventWatch(runtime, handle)
    return { ...handle, initial_input }
  }

  async fork(prev: IncarnationRef, forkInput: string, opts: ForkOptions): Promise<IncarnationHandle> {
    this.assertActive()
    validateSessionRef(prev.session_ref)
    if (!this.appServerForkSupported) {
      throw new ForkEstablishmentError('fork_create', 'Codex app-server fork capability is unavailable', 'not_started')
    }
    if (Date.parse(opts.establishment_deadline_at) <= Date.now()) {
      throw new ForkEstablishmentError('timeout', 'fork establishment deadline already expired', 'not_started')
    }

    const prevRuntime = await this.ensureRuntime(prev)
    if (!prevRuntime) {
      throw new ForkEstablishmentError(
        'fork_create',
        `CodexWorkerAdapter.fork: no such incarnation ${prev.worker_id}#${prev.seq}`,
        'not_started',
      )
    }
    if (!prevRuntime.workspaceRoot || !prevRuntime.codexHome) {
      throw new ForkEstablishmentError(
        'fork_create',
        `CodexWorkerAdapter.fork: cannot rebuild workspace or CODEX_HOME for ${prev.worker_id}#${prev.seq}`,
        'not_started',
      )
    }

    const resolvedBin = await this.resolveBinForCommand()
    if (!resolvedBin) {
      throw new ForkEstablishmentError('fork_create', 'CodexWorkerAdapter.fork: no user-level codex installation', 'not_started')
    }

    const dir = prevRuntime.dir
    let runtime!: Runtime
    await this.getMutex(prev.worker_id).run(async () => {
      const seq = await this.nextSeq(prev.worker_id)
      runtime = {
        worker_id: prev.worker_id,
        incarnation_id: opts.incarnation_id,
        seq,
        dir,
        workspaceRoot: prevRuntime.workspaceRoot,
        codexHome: opts.connection_env?.CODEX_HOME ?? prevRuntime.codexHome,
        sessionName: '',
        sessionId: '',
        rolloutPath: undefined,
        outputLog: new OutputLog(join(dir, `output-${seq}.log`)),
        eventChannel: new CliEventChannel(join(dir, `fork-events-${seq}.jsonl`)),
        eventWatchOffset: 0,
        sessionDiscoveryStatus: 'placeholder',
        discoveryStartedAt: Date.now(),
        controlState: { kind: 'running' },
        stopBaseline: 0,
        killed: false,
      }
      this.runtimes.set(instanceKey(runtime), runtime)
    })

    let client: CodexAppServerClient
    try {
      const env = {
        ...buildScrubbedChildEnv(),
        ...(await this.buildEnv({
          CODEX_HOME: opts.connection_env?.CODEX_HOME ?? prevRuntime.codexHome,
          ...opts.connection_env,
        })),
      }
      client = new CodexAppServerClient({
        command: `${resolvedBin.cmd} app-server --stdio`,
        cwd: prevRuntime.workspaceRoot,
        env,
      })
      runtime.headlessClient = client
    } catch (error) {
      this.runtimes.delete(instanceKey(runtime))
      await fs.rm(join(dir, `meta-${runtime.seq}.json`), { force: true }).catch(() => {})
      throw new ForkEstablishmentError('fork_create', safeProcessError(error), 'not_started')
    }

    let forkThreadId: string | undefined
    let turnId: string | undefined
    let handle: IncarnationHandle | undefined
    let established = false
    let finished = false
    let processExitBeforeEstablishment: Error | undefined
    let pendingCompletion: { status: string; error?: unknown } | undefined
    let outputWrites = Promise.resolve()

    const appendOutput = (text: string) => {
      if (!text) return
      outputWrites = outputWrites.then(() => runtime.outputLog!.append(text))
    }
    const finish = async (reason: IncarnationEndReason, error?: unknown) => {
      if (finished || !handle) return
      finished = true
      if (error !== undefined) appendOutput(`\n[codex query failed: ${safeProcessError(error)}]\n`)
      await outputWrites.catch((writeError) => {
        console.error(`[CodexWorkerAdapter] fork output write failed for ${prev.worker_id}#${runtime.seq}:`, writeError)
      })
      await this.getMutex(prev.worker_id).run(async () => {
        if (runtime.controlState.kind !== 'exited') await this.transitionExited(runtime, handle!, reason)
      })
      await client.terminate()
    }
    const consumeNotification = (notification: AppServerNotification) => {
      const params = asTable(notification.params)
      if (notification.method === 'item/agentMessage/delta') {
        if (typeof params.threadId !== 'string' || params.threadId !== forkThreadId) return
        if (turnId !== undefined && params.turnId !== turnId) return
        if (typeof params.delta === 'string') appendOutput(params.delta)
        return
      }
      if (notification.method !== 'turn/completed') return
      if (typeof params.threadId !== 'string' || params.threadId !== forkThreadId) return
      const turn = asTable(params.turn)
      if (typeof turn.id !== 'string' || (turnId !== undefined && turn.id !== turnId)) return
      const completion = {
        status: typeof turn.status === 'string' ? turn.status : 'failed',
        ...('error' in turn ? { error: turn.error } : {}),
      }
      if (!established) {
        pendingCompletion = completion
        return
      }
      void finish(completion.status === 'completed' ? 'completed' : 'failed', completion.error)
    }
    client.onNotification(consumeNotification)
    client.onExit((error) => {
      if (!established) {
        processExitBeforeEstablishment = error ?? new Error('codex app-server exited during fork establishment')
        return
      }
      void finish('crashed', error ?? new Error('codex app-server exited before turn/completed'))
    })

    let stage: 'fork_create' | 'query_submit' = 'fork_create'
    let turnAccepted = false
    try {
      await client.initialize(opts.establishment_deadline_at)
      const forkResult = asTable(await client.request('thread/fork', {
        threadId: prev.session_ref,
        ephemeral: true,
        excludeTurns: true,
      }, opts.establishment_deadline_at))
      const thread = asTable(forkResult.thread)
      if (typeof thread.id !== 'string') {
        throw new Error('codex app-server thread/fork returned an incompatible response')
      }
      validateSessionRef(thread.id)
      if (thread.id === prev.session_ref) throw new Error('codex app-server fork reused the parent thread id')
      forkThreadId = thread.id
      runtime.sessionId = thread.id

      stage = 'query_submit'
      const turnResult = asTable(await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: forkInput }],
      }, opts.establishment_deadline_at))
      const turn = asTable(turnResult.turn)
      if (typeof turn.id !== 'string') {
        throw new Error('codex app-server turn/start returned an incompatible response')
      }
      turnId = turn.id
      turnAccepted = true
      handle = {
        worker_id: prev.worker_id,
        incarnation_id: opts.incarnation_id,
        seq: runtime.seq,
        impl: 'codex',
        session_ref: thread.id,
        query_id: opts.query_id,
      }
      await writeMetaAtomic(dir, runtime.seq, {
        seq: runtime.seq,
        state: 'running',
        session_id: thread.id,
        session_discovery: 'placeholder',
        workspace_root: prevRuntime.workspaceRoot,
        codex_home: runtime.codexHome,
      })
      if (processExitBeforeEstablishment && !pendingCompletion) throw processExitBeforeEstablishment
      established = true
      if (pendingCompletion) {
        void finish(
          pendingCompletion.status === 'completed' ? 'completed' : 'failed',
          pendingCompletion.error,
        )
      }
      return handle
    } catch (error) {
      const stopped = await client.terminate()
      this.runtimes.delete(instanceKey(runtime))
      await fs.rm(join(dir, `meta-${runtime.seq}.json`), { force: true }).catch(() => {})
      const isTimeout = error instanceof CodexAppServerDeadlineError
      const rpcRejected = error instanceof CodexAppServerRpcError
      let certainty: ForkEstablishmentError['certainty']
      if (isTimeout) certainty = 'unknown'
      else if (stage === 'fork_create' || rpcRejected) certainty = 'not_started'
      else if (turnAccepted && stopped) certainty = 'failed'
      else certainty = 'unknown'
      throw new ForkEstablishmentError(
        isTimeout ? 'timeout' : stage,
        safeProcessError(error),
        certainty,
      )
    }
  }

  async sendInput(h: IncarnationHandle, text: string, opts?: SendInputOptions): Promise<void> {
    this.assertActive()
    const runtime = await this.ensureRuntime(h)
    if (!runtime) throw new WorkerExitedError(h.worker_id, h.seq)
    const { state: current } = await this.syncState(runtime, h)
    if (current === 'exited') throw new WorkerExitedError(h.worker_id, h.seq, runtime.ended_reason)

    return this.getMutex(h.worker_id).run(async () => {
      if (runtime.controlState.kind === 'exited') throw new WorkerExitedError(h.worker_id, h.seq, runtime.ended_reason)

      if (opts?.raw) {
        assertInputDeliveryActive(opts, 'not_delivered')
        return this.sendRawInput(runtime, h, text)
      }

      if (runtime.controlState.kind === 'waiting_action') {
        const snapshot = await this.capture(runtime)
        const report: StateChangeReport = { terminal: this.liveTerminal(snapshot), waitReason: runtime.controlState.reason }
        throw new CliInputStallError('not_pasted', 'waiting_action', report)
      }
      const mode: InputMode = runtime.controlState.kind === 'running' ? 'steering' : 'primary'
      const result = await this.commitGuardedInput(runtime, h, text, mode, false, false, opts)
      if (result.disposition !== 'accepted') throw new CliInputStallError(result.disposition, result.control_state, result.report)
      if (!runtime.sessionId) {
        const discoveredHandle = await this.discoverSpawnedSession(runtime, h)
        runtime.pendingSessionRef = discoveredHandle.session_ref
      }
      if (result.control_state === 'exited') {
        runtime.acceptedExitReport = result.report ?? { endReason: runtime.ended_reason ?? 'completed' }
      }
    })
  }

  async respondToUi(h: IncarnationHandle, response: WorkerUiResponse): Promise<void> {
    this.assertActive()
    const runtime = await this.ensureRuntime(h)
    if (!runtime) throw new WorkerExitedError(h.worker_id, h.seq)
    await this.syncState(runtime, h)
    await this.getMutex(h.worker_id).run(async () => {
      if (runtime.controlState.kind !== 'waiting_action') throw new Error('Codex UI is no longer waiting for a manager response')
      try {
        if (response.kind === 'keys') await this.sendControlKeys(runtime, h, response.keys, true)
        else await this.sendUiText(runtime, h, response.text, true)
      } catch (error) {
        if (error instanceof CliInputStallError) return
        throw error
      }
    })
  }

  takeUpdatedSessionRef(h: IncarnationHandle): string | undefined {
    const runtime = this.runtimes.get(instanceKey(h))
    const value = runtime?.pendingSessionRef
    if (runtime) runtime.pendingSessionRef = undefined
    return value
  }

  takeAcceptedInputExit(h: IncarnationHandle): StateChangeReport | undefined {
    const runtime = this.runtimes.get(instanceKey(h))
    const report = runtime?.acceptedExitReport
    if (runtime) runtime.acceptedExitReport = undefined
    return report
  }

  async readTerminal(h: IncarnationHandle): Promise<WorkerTerminalView> {
    const dir = join(this.deps.dataDir, h.worker_id)
    if (h.query_id) {
      const { chunk } = await new OutputLog(join(dir, `output-${h.seq}.log`)).read({ offset: 0 })
      return chunk ? { kind: 'headless_text', text: chunk } : { kind: 'unavailable', unavailable_reason: 'headless_without_text' }
    }
    const runtime = await this.ensureRuntime(h)
    if (!runtime) {
      const final = await readFinalTerminalSnapshot(dir, h.seq)
      return final
        ? { kind: 'final_terminal', ...final }
        : { kind: 'unavailable', unavailable_reason: 'legacy_without_terminal_snapshot' }
    }
    if (runtime.headlessClient || !runtime.sessionName) {
      if (!runtime.outputLog) return { kind: 'unavailable', unavailable_reason: 'headless_without_text' }
      const { chunk } = await runtime.outputLog.read({ offset: 0 })
      return chunk ? { kind: 'headless_text', text: chunk } : { kind: 'unavailable', unavailable_reason: 'headless_without_text' }
    }
    if (await this.tmux.isAlive(runtime.sessionName)) {
      try {
        const snapshot = await this.capture(runtime)
        if (snapshot.dead) {
          const final = await readFinalTerminalSnapshot(runtime.dir, runtime.seq)
          return final
            ? { kind: 'final_terminal', ...final }
            : { kind: 'unavailable', unavailable_reason: 'terminal_session_missing' }
        }
        return this.liveTerminal(snapshot)
      } catch {
        return { kind: 'unavailable', unavailable_reason: 'terminal_capture_failed' }
      }
    }
    const final = await this.persistFinalTerminal(runtime)
    return final
      ? final
      : { kind: 'unavailable', unavailable_reason: runtime.controlState.kind === 'exited' ? 'no_final_terminal_snapshot' : 'terminal_session_missing' }
  }

  /**
   * 活性信号(protocol-agent-v3 §6.1):任务/执行进展的最近时刻。
   *
   * pane output 的 TUI 重绘不参与判定。rollout 是 Codex 的原生会话记录;meta 为
   * spawn/resume/input/state 转换提供控制进展基线。任一来源失败时继续使用另一来源。
   */
  async lastActivityAt(h: IncarnationHandle): Promise<number | undefined> {
    const dir = join(this.deps.dataDir, h.worker_id)
    const metaPath = join(dir, `meta-${h.seq}.json`)
    const runtime = this.runtimes.get(instanceKey(h))
    const meta = runtime ? undefined : await this.readMetaFile(dir, h.seq)
    let rolloutPath = runtime?.rolloutPath
    if (!rolloutPath && meta?.session_discovery === 'discovered' && meta.session_id) {
      const home = meta.codex_home ?? (meta.workspace_root ? join(meta.workspace_root, '.codex') : undefined)
      if (!home) return undefined
      const sessionsDir = join(home, 'sessions')
      try {
        rolloutPath = await findRolloutFileBySessionId(sessionsDir, meta.session_id, true)
      } catch (err) {
        console.warn(`[worker liveness] rollout discovery failed for ${h.worker_id}#${h.seq} at ${sessionsDir}:`, err)
      }
    }
    return latestModifiedMs([metaPath, rolloutPath], `${h.worker_id}#${h.seq}`)
  }

  /**
   * P3 Task 9 修复"无常驻 runtime 时不做真实存活探测就照抄 meta 旧值"的假阳性(与 cc
   * adapter 同款),四轮 review 进一步把这套重建逻辑收拢进 ensureRuntime,供 sendInput/
   * kill/resume/state/readTrace 共用(见该方法注释;codex 没有 fork)。ensureRuntime 返回
   * undefined 只有"落盘 meta 也完全不存在"这一种情形(真·未知化身)——与旧实现"tmux 会话
   * 不存在则返回 exited"的兜底语义一致,直接判 exited。
   */
  async state(h: IncarnationHandle): Promise<WorkerContractState> {
    const runtime = await this.ensureRuntime(h)
    if (!runtime) return 'exited'
    if (runtime.headlessClient) return contractState(runtime.controlState)
    return (await this.syncState(runtime, h)).state
  }

  async readTrace(h: IncarnationHandle, cursor?: TraceCursor): Promise<{ events: NormalizedTraceEvent[]; nextCursor: TraceCursor }> {
    const { events, nextCursor } = await this.readTraceWindow(h, cursor)
    return { events, nextCursor }
  }

  private async readTraceWindow(
    h: IncarnationHandle,
    cursor?: TraceCursor,
  ): Promise<{ sourceAvailable: boolean; events: NormalizedTraceEvent[]; nextCursor: TraceCursor }> {
    // 四轮 review 修复:以前只能对本进程内常驻的化身调用(rolloutPath 只存在于内存
    // runtime)。ensureRuntime 现在从 meta 的 session_discovery + workspace_root(本轮新增
    // 持久化)重新推导出 rolloutPath(见 findRolloutFileBySessionId),readTrace 因此也能在
    // 无常驻 runtime 时工作。
    const runtime = await this.ensureRuntime(h)
    if (!runtime) {
      throw new Error(`CodexWorkerAdapter.readTrace: no such incarnation ${h.worker_id}#${h.seq} resident in this process`)
    }

    if (!runtime.rolloutPath) {
      // spawn 时没能发现 rollout 文件(占位 session_id,已知限制)——没有路径可读,退化为空
      // 数组,cursor 原样透传。
      return { sourceAvailable: false, events: [], nextCursor: cursor ?? { offset: 0 } }
    }

    let raw: string
    try {
      raw = await fs.readFile(runtime.rolloutPath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { sourceAvailable: false, events: [], nextCursor: cursor ?? { offset: 0 } }
      throw err
    }

    // 半行纪律(对齐 cli-events.ts watch()):trace(rollout)文件由 codex 持续追加、这里懒
    // 解析式轮询读取,读到写入中途是常态。split 末尾要么是空串(文本以 \n 结尾)要么是尚未
    // 写完的半行,两种情况都不能当"已消费的完整行"处理——统一 pop 掉,不产事件也不推进
    // nextCursor,保证下次连同补全后的内容重新完整读取该行,不会永久丢事件。
    const rawLines = raw.split('\n')
    rawLines.pop()
    const lines = rawLines.filter((line) => line.length > 0)
    const start = cursor?.offset ?? 0
    const events: NormalizedTraceEvent[] = []
    // nextCursor.offset 是"实际消费到的行号",不是 start + events.length——未识别的顶层
    // type/子类型、坏 JSON 都不产事件但仍然消费了一行,调用方用 offset += events.length 推进
    // 游标会在这些被跳过的行上重复读或漏读(P2 review #4,同 cc adapter 修复)。
    let consumed = start
    for (let i = start; i < lines.length; i++) {
      const lineEvents = normalizeRolloutLine(lines[i])
      events.push(...lineEvents.map((event) => ({ ...event, source_offset: i })))
      consumed = i + 1
    }
    return { sourceAvailable: true, events, nextCursor: { offset: consumed } }
  }

  async inspectSupervisionActivity(
    h: IncarnationHandle,
    cursor?: { readonly offset: number },
  ): Promise<SupervisionObservation> {
    try {
      const trace = await this.readTraceWindow(h, cursor)
      if (!trace.sourceAvailable) return { kind: 'unknown', next_cursor: cursor ?? { offset: 0 } }
      return classifySupervisionActivity(trace.events, trace.nextCursor)
    } catch {
      return { kind: 'unknown', next_cursor: cursor ?? { offset: 0 } }
    }
  }

  async kill(h: IncarnationHandle): Promise<void> {
    this.assertActive()
    // Meta reconstruction makes kill work after an agent restart; missing meta and already-exited
    // incarnations are both idempotent no-ops.
    const runtime = await this.ensureRuntime(h)
    if (!runtime) return
    await this.getMutex(h.worker_id).run(async () => {
      if (runtime.controlState.kind === 'exited') return // 幂等:不覆盖原 ended_reason
      runtime.killed = true
      if (runtime.headlessClient) await runtime.headlessClient.terminate()
      await this.transitionExited(runtime, h, 'killed')
    })
  }

  async interrupt(h: IncarnationHandle): Promise<void> {
    this.assertActive()
    const runtime = await this.ensureRuntime(h)
    if (!runtime || runtime.controlState.kind === 'exited') return
    await this.tmux.sendKeys(runtime.sessionName, ['C-c'])
  }

  async stop(h: IncarnationHandle): Promise<void> {
    await this.kill(h)
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.closing = true
    this.disposePromise = (async () => {
      await Promise.all([...this.runtimes.values()].map((runtime) => this.stopEventWatch(runtime, true)))
    })()
    return this.disposePromise
  }

  capabilities(): AdapterCapabilities {
    return { fork: this.appServerForkSupported, revive: true, goalMode: false, subagent: false, structuredTrace: true }
  }

  // --- Internal ---

  /**
   * Reconcile tmux existence and turn-complete events with the resident control state. A
   * startup/action wait that dies before proven progress is classified crashed; other external
   * exits retain the protocol's completed inference. Serialized per worker.
   */
  private async syncState(
    runtime: Runtime,
    h: IncarnationHandle,
    deadReason: IncarnationEndReason = 'completed',
    notify = true,
  ): Promise<{ state: WorkerContractState; stopCount: number }> {
    if (runtime.controlState.kind === 'exited') return { state: 'exited', stopCount: runtime.stopBaseline }
    return this.getMutex(h.worker_id).run(async () => {
      if (runtime.controlState.kind === 'exited') return { state: 'exited', stopCount: runtime.stopBaseline }
      // Session discovery may complete while this callback waits for the adapter mutex. Construct
      // the callback handle only after acquiring it so an earlier empty/placeholder ref cannot win.
      const currentHandle = { ...h, session_ref: runtime.sessionId }
      const events = await runtime.eventChannel.readAll()
      const stopCount = events.filter((event) => event.kind === 'stop').length
      if (!(await this.tmux.isAlive(runtime.sessionName))) {
        let reason = deadReason
        if (runtime.killed) reason = 'killed'
        // waiting_action 本身就是"所需输入/控制动作尚未安全完成"的证据；在没有新 turn-complete
        // 的情况下 pane 消失不能推断任务已完成。按 spec，reason 只用于诊断、不产生不同终态
        // 分支，因此 startup_stall / interaction_required / input_pending 统一收敛 crashed。
        // 同一次 reconcile 若已观察到新 turn-complete，则完成证据优先，沿缺省 deadReason 推断。
        else if (runtime.controlState.kind === 'waiting_action' && stopCount <= runtime.stopBaseline) reason = 'crashed'
        await this.transitionExited(runtime, currentHandle, reason, notify)
      } else if (stopCount > runtime.stopBaseline) {
        runtime.stopBaseline = stopCount
        runtime.interactionFingerprint = undefined
        await this.transitionControlState(runtime, currentHandle, { kind: 'waiting_text' }, { completionSource: 'codex_turn_complete' }, notify)
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

  /** Rebuild a CLI runtime from meta plus the deterministic tmux name and rollout metadata. The
   * per-worker lock and lock-local map recheck prevent duplicate runtimes/watchers. */
  private async ensureRuntime(ref: { worker_id: string; incarnation_id?: string; seq: number; session_ref?: string }): Promise<Runtime | undefined> {
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
      if (!alive) await this.tmux.killSession(sessionName)
      const workspaceRoot = meta.workspace_root ?? ''
      const sessionId = meta.session_id ?? ref.session_ref ?? ''
      // P6-B：admin_provider 的 CODEX_HOME 在 worker 级 runtime 目录（spawn/resume 时落了
      // meta.codex_home）；老 meta 没有该字段才回退 workspace 推导（existing_host 语义）。
      const codexHome = meta.codex_home ?? (workspaceRoot ? join(workspaceRoot, '.codex') : '')
      const sessionDiscoveryStatus: 'discovered' | 'placeholder' = meta.session_discovery ?? 'placeholder'
      const rolloutPath =
        sessionDiscoveryStatus === 'discovered' && codexHome ? await findRolloutFileBySessionId(join(codexHome, 'sessions'), sessionId) : undefined
      const eventsPath = workspaceRoot ? eventsFilePath({ root: workspaceRoot }) : join(dir, `.no-workspace-events-${ref.seq}.jsonl`)
      const eventChannel = new CliEventChannel(eventsPath)
      const eventWatchOffset = await eventChannel.endOffset()

      let stopBaseline = 0
      if (workspaceRoot) {
        const events = await eventChannel.readAll()
        stopBaseline = events.filter((e) => e.kind === 'stop').length
      }

      const runtime: Runtime = {
        worker_id: ref.worker_id,
        incarnation_id: ref.incarnation_id,
        seq: ref.seq,
        dir,
        workspaceRoot,
        codexHome,
        sessionName,
        controlEndpoint: meta.control_socket && meta.control_monitor_id
          ? { socket_path: meta.control_socket, monitor_id: meta.control_monitor_id }
          : undefined,
        sessionId,
        rolloutPath,
        eventChannel,
        eventWatchOffset,
        sessionDiscoveryStatus,
        discoveryStartedAt: Date.now(),
        controlState: controlFromMeta(meta, alive),
        ended_reason: alive ? undefined : meta.ended_reason,
        stopBaseline,
        killed: false,
      }
      this.runtimes.set(key, runtime)
      // 重启后重连接管(§13):会话还活着的化身在这里重新装上文件监视。已终态的化身
      // startEventWatch 自己会短路掉。
      this.startEventWatch(runtime, { worker_id: ref.worker_id, incarnation_id: ref.incarnation_id, seq: ref.seq, impl: 'codex', session_ref: sessionId })
      if (alive) {
        await this.inspectTerminalInteractionLocked(runtime, {
          worker_id: ref.worker_id,
          incarnation_id: ref.incarnation_id,
          seq: ref.seq,
          impl: 'codex',
          session_ref: sessionId,
        }).catch((error) => {
          console.error(`[CodexWorkerAdapter] recovery interaction check failed for ${ref.worker_id}#${ref.seq}:`, error)
        })
      }
      return runtime
    })
  }

  /** meta-<seq>.json 读取,文件不存在/内容损坏一律返回 undefined(供 ensureRuntime 判定
   * "真·未知化身")。 */
  private async readMetaFile(
    dir: string,
    seq: number,
  ): Promise<
    | {
        session_id?: string
        workspace_root?: string
        ended_reason?: IncarnationEndReason
        session_discovery?: 'discovered' | 'placeholder'
        /** P6-B：admin_provider 形态下 CODEX_HOME 是 worker 级 runtime 目录（非 workspace）；
         *  不落 meta 的话重启重建会错回 workspace，resume/活性/trace 全断（R7）。 */
        codex_home?: string
        state?: WorkerContractState
        wait_mode?: 'text' | 'action'
        wait_reason?: string
        startup_stalled?: boolean
        control_socket?: string
        control_monitor_id?: string
      }
    | undefined
  > {
    try {
      const raw = await fs.readFile(join(dir, `meta-${seq}.json`), 'utf-8')
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }

  /**
   * worker_id 对应下一个可用的化身序号:该 worker 现存所有化身里最大 seq + 1。resume() 和
   * fork() 都在 mutex.run 内分配,保证并发操作不会撞号。与 cc adapter 的同名方法同一思路。
   *
   * 五轮 review 修复:磁盘感知,理由与 cc adapter 的同名方法一致——重启后新 adapter 实例
   * 的 runtimes 只含 ensureRuntime 按需重建过的那几条,只扫内存会把磁盘上未被重建的旧化身
   * 的号位当成"下一个"分配出去,静默覆盖其 meta/output。
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

  /** Codex 同样不报告 `lastText`；交互式 TUI 无法可靠划分 assistant 发言，详见 cc adapter。 */
  private async transitionControlState(
    runtime: Runtime,
    h: IncarnationHandle,
    state: CliControlState,
    report?: StateChangeReport,
    notify = true,
    forceNotify = false,
  ): Promise<void> {
    const external = contractState(state)
    const changed = runtime.controlState.kind !== state.kind ||
      (runtime.controlState.kind === 'waiting_action' && state.kind === 'waiting_action' && runtime.controlState.reason !== state.reason)
    await writeMetaAtomic(runtime.dir, runtime.seq, {
      seq: runtime.seq,
      state: external,
      session_id: runtime.sessionId,
      session_discovery: runtime.sessionDiscoveryStatus,
      workspace_root: runtime.workspaceRoot,
      codex_home: runtime.codexHome,
      ...controlMeta(runtime),
      ...(state.kind === 'waiting_text' ? { wait_mode: 'text' as const } : {}),
      ...(state.kind === 'waiting_action' ? { wait_mode: 'action' as const, wait_reason: state.reason } : {}),
    })
    runtime.controlState = state
    if (!notify || (!changed && !forceNotify)) return
    try {
      this.deps.onStateChange?.(h, external, report)
    } catch (err) {
      console.error(`[CodexWorkerAdapter] onStateChange callback error for ${h.worker_id}#${h.seq}:`, err)
    }
  }

  private async initialStartupStall(runtime: Runtime, h: IncarnationHandle): Promise<InitialInputResult> {
    const snapshot = await this.capture(runtime).catch(() => undefined)
    if (!(await this.tmux.isAlive(runtime.sessionName))) {
      await this.transitionExited(runtime, h, 'crashed', false)
      return {
        control_state: 'exited',
        disposition: 'not_pasted',
        report: { endReason: 'crashed', ...(snapshot ? { terminal: { kind: 'final_terminal', text: snapshot.text, captured_at: snapshot.captured_at } } : {}) },
      }
    }
    const report: StateChangeReport = {
      ...(snapshot ? { terminal: this.liveTerminal(snapshot) } : {}),
      waitReason: 'startup_stall',
    }
    await this.transitionControlState(runtime, h, { kind: 'waiting_action', reason: 'startup_stall' }, report, false)
    return { control_state: 'waiting_action', disposition: 'not_pasted', report }
  }

  private async transitionExited(runtime: Runtime, h: IncarnationHandle, ended_reason: IncarnationEndReason, notify = true): Promise<void> {
    let terminal: WorkerTerminalView | undefined
    if (!runtime.headlessClient && runtime.sessionName) {
      terminal = await this.persistFinalTerminal(runtime)
      await this.tmux.killSession(runtime.sessionName)
    }
    await writeMetaAtomic(runtime.dir, runtime.seq, {
      seq: runtime.seq,
      state: 'exited',
      session_id: runtime.sessionId,
      ended_reason,
      session_discovery: runtime.sessionDiscoveryStatus,
      workspace_root: runtime.workspaceRoot,
      codex_home: runtime.codexHome,
      ...controlMeta(runtime),
    })
    runtime.controlState = { kind: 'exited', reason: ended_reason }
    runtime.ended_reason = ended_reason
    // 终态唯一入口:文件监视在这里摘掉,同 cc adapter。
    await this.stopEventWatch(runtime)
    if (!notify) return
    try {
      this.deps.onStateChange?.(h, 'exited', { endReason: ended_reason, ...(terminal ? { terminal } : {}) })
    } catch (err) {
      console.error(`[CodexWorkerAdapter] onStateChange callback error for ${h.worker_id}#${h.seq}:`, err)
    }
  }

  /**
   * 协议 §6.2.3「hook 命令为向事件文件追加一行 JSON,**harness 以文件监视接收**」的接线。
   * codex 侧写事件文件的是 config.toml 的 notify 段;在此之前它老实在写,但生产侧没人读,
   * codex worker 连"这一轮干完了"的 push 都没有。设计与 cc adapter 的同名方法逐条一致
   * (起于建立 runtime 处、停于 transitionExited、回调只触发 syncState 不解析内容),
   * 详见 `workers/claude-code/adapter.ts` 的 startEventWatch 注释。
   */
  private startEventWatch(runtime: Runtime, h: IncarnationHandle): void {
    if (this.closing) return
    if (!runtime.sessionName) return
    if (runtime.controlState.kind === 'exited') return
    if (runtime.stopEventWatch) return // 幂等:同一 runtime 只装一个
    runtime.stopEventWatch = runtime.eventChannel.watch((event) => {
      if (event.kind === 'permission_request') {
        return this.inspectTerminalInteraction(runtime, h).catch((err) => {
          console.error(`[CodexWorkerAdapter] permission-request interaction check failed for ${h.worker_id}#${h.seq}:`, err)
        })
      }
      if (event.kind !== 'stop') return undefined
      return this.syncState(runtime, h).then(() => {}).catch((err) => {
        console.error(`[CodexWorkerAdapter] cli event driven syncState failed for ${h.worker_id}#${h.seq}:`, err)
      })
    }, { offset: runtime.eventWatchOffset })
    this.startNativeTraceWatch(runtime, h)
  }

  private startNativeTraceWatch(runtime: Runtime, h: IncarnationHandle): void {
    if (runtime.stopTraceWatch || !this.deps.onNativeActivity || !runtime.rolloutPath) return
    runtime.stopTraceWatch = watchNativeSessionFile(
      () => runtime.rolloutPath,
      () => {
        if (this.closing || runtime.controlState.kind === 'exited') return
        try {
          this.deps.onNativeActivity?.({ ...h, session_ref: runtime.sessionId })
        } catch (error) {
          console.error(`[CodexWorkerAdapter] native trace activity callback failed for ${h.worker_id}#${h.seq}:`, error)
        }
      },
    )
  }

  private async stopEventWatch(runtime: Runtime, waitForDrain = false): Promise<void> {
    runtime.interactionFingerprint = undefined
    runtime.stopTraceWatch?.()
    runtime.stopTraceWatch = undefined
    if (runtime.stopEventWatch) {
      const stop = runtime.stopEventWatch
      runtime.stopEventWatch = undefined
      runtime.eventWatchDrain = stop()
    }
    if (waitForDrain) await runtime.eventWatchDrain
  }

  private inspectTerminalInteraction(runtime: Runtime, h: IncarnationHandle): Promise<void> {
    return this.getMutex(h.worker_id).run(() => this.inspectTerminalInteractionLocked(runtime, h))
  }

  private async inspectTerminalInteractionLocked(runtime: Runtime, h: IncarnationHandle): Promise<void> {
    if (this.closing || runtime.controlState.kind === 'exited') return
    let snapshot: CapturedPane
    try {
      snapshot = await this.capture(runtime)
    } catch {
      return
    }
    const interaction: TerminalInteraction = classifyCodexTerminalInteraction(snapshot)
    if (interaction.kind === 'none') {
      runtime.interactionFingerprint = undefined
      return
    }
    if (interaction.kind !== 'manager_required') return
    if (runtime.interactionFingerprint === interaction.fingerprint) return
    runtime.interactionFingerprint = interaction.fingerprint
    await this.transitionControlState(runtime, h, { kind: 'waiting_action', reason: 'interaction_required' }, {
      terminal: this.liveTerminal(snapshot),
      waitReason: 'interaction_required',
      ui: { fingerprint: interaction.fingerprint, actions: interaction.actions },
      notification: { type: 'terminal_interaction' },
    }, true, true)
  }

  private assertActive(): void {
    if (this.closing) throw new Error('CodexWorkerAdapter is shutting down')
  }

  /** 新建 runtime 时的 stop 基线,见 `workers/claude-code/adapter.ts` 同名方法的注释:
   * 事件文件是 workspace 级的,resume 复用同一 workspace,基线不能一律取 0。 */
  private async initialStopBaseline(channel: CliEventChannel): Promise<number> {
    const events = await channel.readAll()
    return events.filter((e) => e.kind === 'stop').length
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/**
 * 归一化单行 codex rollout JSONL 为 NormalizedTraceEvent。
 *
 * m2 真机实测(codex-cli 0.144.1)校准的信封结构:每行是 `{type, timestamp, payload}`
 * (`timestamp` 挂在信封顶层,不是嵌在 payload 里——之前按 codex-docs 猜测的字段位置是错的,
 * 这里已按实测改正),顶层 type 取值 session_meta / event_msg / response_item / world_state /
 * turn_context 五种(未见 compacted/inter_agent_communication* 之类的推测类型):
 *
 * - `session_meta`:payload 有 `session_id`(权威,比文件名解析出的 uuid 更可靠,见 spawn()
 *   的"session 发现"节)、`cli_version`、`cwd`、`model_provider`、`context_window`、
 *   `originator`——映射为 lifecycle。
 * - `event_msg`:大多数 payload 有 `type`(如 `task_started`)、`turn_id`、`started_at`、
 *   `model_context_window`——映射为 lifecycle,摘要取 payload.type。codex-cli 0.147 把普通
 *   命令和文件修改作为 `item_completed` 记录，其中 `CommandExecution`/`FileChange` 分别展开
 *   为同一 call_id 的工具调用和结果；其余 completed item 仍视为协议噪音。
 * - `response_item`:见 normalizeResponseItem()。
 * - `world_state`:payload 是全量状态快照(`full`/`state`),对"发生了什么"的摘要时间线没有
 *   直接信息量(它是状态,不是事件),跳过——需要全量状态可以直接读原始 rollout 文件
 *   (detail 只保留 response_item/event_msg/session_meta 各自的 payload,不代表 world_state
 *   不存在,只是不进这条摘要时间线)。
 * - `turn_context`:payload 是回合配置(`model`/`effort`/`cwd`/`approval_policy`/`summary`
 *   等),同样不是"发生的事",跳过。
 */
function normalizeRolloutLine(line: string): NormalizedTraceEvent[] {
  let parsed: { type?: unknown; timestamp?: unknown; payload?: unknown }
  try {
    parsed = JSON.parse(line)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const ts = typeof parsed.timestamp === 'string' ? parsed.timestamp : ''
  const payload = parsed.payload as Record<string, unknown> | undefined

  if (parsed.type === 'session_meta') {
    const meta = payload as { session_id?: string; cli_version?: string; cwd?: string } | undefined
    const summary = `session_meta session_id=${meta?.session_id ?? ''} cli_version=${meta?.cli_version ?? ''} cwd=${meta?.cwd ?? ''}`
    return [{ ts, kind: 'lifecycle', role: 'system', summary: truncate(summary, 200), detail: payload }]
  }

  if (parsed.type === 'event_msg') {
    const completed = normalizeCompletedItem(payload, ts)
    if (completed) return completed
    const eventType = typeof payload?.type === 'string' ? payload.type : 'event_msg'
    return [{ ts, kind: 'lifecycle', role: 'system', summary: eventType, detail: payload }]
  }

  if (parsed.type === 'response_item') {
    const event = normalizeResponseItem(payload, ts)
    return event ? [event] : []
  }

  // world_state/turn_context(以及其它未在真机实测里见过的顶层 type)跳过,见函数头注释。
  return []
}

/**
 * 从 codex-cli 0.147 的 `event_msg/item_completed` 展开已知工具记录。一个原生行可生成一对
 * 事件，但二者保留同一 source_offset，cursor 仍只按原生行号推进。
 */
function normalizeCompletedItem(payload: Record<string, unknown> | undefined, fallbackTs: string): NormalizedTraceEvent[] | undefined {
  if (payload?.type !== 'item_completed' || !isRecord(payload.item)) return undefined
  const item = payload.item
  const callId = typeof item.id === 'string' ? item.id : undefined
  if (!callId) return undefined

  if (item.type === 'CommandExecution') {
    const command = stringArray(item.command)
    const input = { command }
    const startedAt = timestampFromEpochMs(payload.started_at_ms, fallbackTs)
    const completedAt = timestampFromEpochMs(payload.completed_at_ms, fallbackTs)
    const status = typeof item.status === 'string' ? item.status : 'completed'
    const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined
    const output = commandOutput(item, status, exitCode)
    const resultSummary = status === 'completed' && exitCode === 0
      ? 'command completed'
      : 'command ' + status + (exitCode === undefined ? '' : ' (exit ' + exitCode + ')')
    return [
      {
        ts: startedAt,
        kind: 'tool_call',
        role: 'assistant',
        summary: truncate('exec_command(' + command.join(' ') + ')', 200),
        detail: { type: 'command_execution', call_id: callId, name: 'exec_command', input },
      },
      {
        ts: completedAt,
        kind: 'tool_result',
        summary: truncate(resultSummary, 200),
        detail: {
          type: 'command_execution_result',
          call_id: callId,
          output,
          is_error: status !== 'completed' || (exitCode !== undefined && exitCode !== 0),
        },
      },
    ]
  }

  if (item.type === 'FileChange') {
    const paths = isRecord(item.changes) ? Object.keys(item.changes) : []
    const completedAt = timestampFromEpochMs(payload.completed_at_ms, fallbackTs)
    const output = paths.length === 0 ? 'file change completed' : 'updated ' + paths.length + ' file' + (paths.length === 1 ? '' : 's')
    return [
      {
        ts: timestampFromEpochMs(payload.started_at_ms, fallbackTs),
        kind: 'tool_call',
        role: 'assistant',
        summary: truncate('apply_patch(' + paths.join(', ') + ')', 200),
        detail: { type: 'file_change', call_id: callId, name: 'apply_patch', input: { paths } },
      },
      {
        ts: completedAt,
        kind: 'tool_result',
        summary: output,
        detail: { type: 'file_change_result', call_id: callId, output, is_error: false },
      },
    ]
  }

  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((part): part is string => typeof part === 'string') : []
}

function timestampFromEpochMs(value: unknown, fallback: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const timestamp = new Date(value)
  return Number.isNaN(timestamp.getTime()) ? fallback : timestamp.toISOString()
}

function commandOutput(item: Record<string, unknown>, status: string, exitCode: number | undefined): string {
  for (const field of ['aggregated_output', 'stdout', 'stderr']) {
    const output = item[field]
    if (typeof output === 'string' && output) return output
  }
  return status === 'completed' && exitCode === 0
    ? 'command completed without output'
    : 'command ' + status + (exitCode === undefined ? '' : ' with exit code ' + exitCode)
}

/**
 * response_item 的 payload 同样是内部 tag(`type` 字段区分子类型)。这里只认领已从 m2 真机
 * 实测或源码确认字段形状的四种子类型(message/function_call/function_call_output/
 * reasoning);其余子类型(local_shell_call/web_search_call/custom_tool_call/...)未逐一
 * 核实字段,跳过而非猜测映射。
 */
function normalizeResponseItem(payload: Record<string, unknown> | undefined, ts: string): NormalizedTraceEvent | null {
  if (!payload || typeof payload.type !== 'string') return null

  if (payload.type === 'message') {
    // m2 实测:role 取值 developer/user/assistant(developer 是 codex 侧的系统级指令角色,
    // 语义上对应我们协议里的 'system',见 types.ts 的 NormalizedTraceEvent.role 只允许
    // assistant/user/system 三种,不新增 'developer' 这个协议外的值)。summary 只取 content
    // 里第一个 input_text/output_text 块的 text(不是拼接全部块),截断。
    const role = payload.role
    const mappedRole = role === 'developer' ? 'system' : role === 'user' || role === 'assistant' || role === 'system' ? role : undefined
    const text = extractFirstContentText(payload.content)
    // 空内容（纯 reasoning 块等）不产事件——否则时间线出现空 summary 行。
    if (!text) return null
    return { ts, kind: 'message', role: mappedRole, summary: truncate(text, 200), detail: payload }
  }

  if (payload.type === 'function_call') {
    const name = typeof payload.name === 'string' ? payload.name : ''
    const args = typeof payload.arguments === 'string' ? payload.arguments : ''
    return { ts, kind: 'tool_call', role: 'assistant', summary: truncate(`${name}(${args})`, 200), detail: payload }
  }

  if (payload.type === 'function_call_output') {
    // codex-docs: FunctionCallOutput 在 ResponseItem 枚举里没有 role 字段,不像 cc 的
    // tool_result 挂在 role=user 的消息体里——role 留空(undefined)。
    const output = payload.output
    return { ts, kind: 'tool_result', summary: truncate(typeof output === 'string' ? output : JSON.stringify(output ?? {}), 200), detail: payload }
  }

  if (payload.type === 'reasoning') {
    const text = extractReasoningSummaryText(payload.summary)
    return { ts, kind: 'thinking', role: 'assistant', summary: truncate(text, 200), detail: payload }
  }

  return null
}

/** ContentItem 数组:取第一个 input_text/output_text 块的 text(m2 实测口径:summary 只要
 * "第一个",不是拼接全部块;跳过 input_image/input_audio 等非文本块)。 */
function extractFirstContentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const item = content.find(
    (it): it is { type: string; text?: string } =>
      !!it &&
      typeof it === 'object' &&
      typeof (it as { type?: unknown }).type === 'string' &&
      ((it as { type: string }).type === 'input_text' || (it as { type: string }).type === 'output_text'),
  )
  return item?.text ?? ''
}

// codex-docs: ReasoningItemReasoningSummary 的具体字段未在本次源码抓取范围内逐一核实,这里
// 只做防御性提取——数组里任意元素若带字符串 text 字段就拼接,拼不出内容时 summary 退化为空串
// (不抛错)。真机校准时需要用真实 reasoning 行核对字段名(见 Task 6 报告"未经确认"清单)。
function extractReasoningSummaryText(summary: unknown): string {
  if (!Array.isArray(summary)) return ''
  return summary
    .map((item) => (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : ''))
    .filter((t) => t.length > 0)
    .join('\n')
}
