/**
 * CodexWorkerAdapter — WorkerAdapter 契约的 OpenAI codex CLI 实现。
 *
 * 本机没有安装 codex,以下行为全部依据公开文档/codex 源码(github.com/openai/codex,
 * developers.openai.com/codex 系列页面,已跳转到 learn.chatgpt.com/docs/*)推断实现,每个
 * 引用点在下面用 `codex-docs:` 标注出处;真机行为需要在真正装上 codex 之后校准(见 Task 6
 * 报告"未经确认待真机校准清单")。
 *
 * ## 与 cc adapter 的关键差异(决定了本文件的整体形状)
 *
 * 1. **没有 `--session-id` 等价参数**:交互态 `codex` 不接受预先指定 session id
 *    (codex-docs: openai/codex#3817"No way to resume in non-interactive mode when session
 *    id is not outputted"、openai/codex Discussion #3827"session_id 是会话开始时自动生成,
 *    无法手动指定/覆盖")。session id 由 codex 自己生成,只能靠事后发现——本 adapter 轮询
 *    `<CODEX_HOME>/sessions/**\/rollout-*.jsonl` 文件名里内嵌的 uuid(见下方"session 发现"节)。
 * 2. **notify 不能走"项目级配置自动发现"**:codex 会从 cwd 向上找 `.codex/config.toml`
 *    作为项目级覆盖层叠加到 `~/.codex/config.toml` 之上,但项目级覆盖明确排除了一批"跑在
 *    本机、涉及凭据/遥测"的 key,其中就包括 `notify`(codex-docs:
 *    learn.chatgpt.com/docs/config-file/config-basic 的限制清单原文:"Codex ignores the
 *    following keys in project-local .codex/config.toml and prints a startup warning...
 *    notify")。因此本 adapter **不依赖项目级自动发现**,而是把 `<workspace>/.codex/`
 *    整个目录当成这个 worker 专属的 `CODEX_HOME`(spawn/resume 时经 tmux env 传
 *    `CODEX_HOME=<workspace>/.codex`),让 notify 在"顶层用户配置"这一层生效。
 * 3. **没有无头 fork 等价物**:cc 的 fork 靠 `-p ... --resume ... --fork-session
 *    --output-format text` 一条命令跑完侧问退出;codex 的 `exec` 子命令没有这个能力
 *    (codex-docs: openai/codex#11750、#17568 两个 open 的 feature request,标题分别是
 *    "Add `codex exec fork` subcommand for headless/non-interactive fork"、"exec: add fork
 *    subcommand for non-interactive session forking";#11750 描述目前唯一的变通方案是拉起
 *    交互式 TUI 塞进伪终端、轮询文件系统等新 rollout 文件出现、杀掉 TUI、再用
 *    `codex exec resume` 接力——这已经不是"无头一击",是要在 fork() 内部重新实现一遍
 *    tmux 交互流程)。因此 `capabilities().fork` 如实定为 `false`,`fork()` 直接抛
 *    `CapabilityNotSupportedError`。
 *
 * ## session 发现(spawn 专用)
 *
 * codex-docs: rollout 文件路径 `<CODEX_HOME>/sessions/YYYY/MM/DD/
 * rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`,来自 codex-rs/rollout/src/list.rs 注释原文
 * "Directory layout: `~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`"
 * 与 codex-rs/rollout/src/lib.rs 的 `SESSIONS_SUBDIR = "sessions"` 常量。spawn() 在 tmux
 * newSession 成功后、注入首条 prompt 之前,有限时间(`sessionDiscoveryTimeoutMs`,默认
 * 3000ms)轮询这个目录树,取文件名里的 uuid 作为该化身的真实 session_id;轮询超时(codex
 * 还没来得及落盘,或本次跑的是不写 rollout 文件的 mock)就退化为本地生成的占位 uuid——
 * 这个占位 uuid 不对应任何真实 codex 会话文件,该化身自己的 resume()/readTrace() 会因此
 * 失效(resume 传给 codex 的 session id 是假的;readTrace 因为 `rolloutPath` 是 undefined
 * 直接退化为空数组),是已知限制,不是本 task 能在没有真机的前提下解决的缺口。
 *
 * ## provision:workspace 级配置
 *
 * `<ws.root>/.codex/config.toml`:notify 段(指向 `CliEventChannel.hookCommand('notification'
 * 概念上等价的 'stop')`,用 `/bin/sh -c` 包一层,因为 codex-docs 确认 notify 是"程序+固定参数
 * 数组,codex 会在末尾追加一个 JSON payload 作为额外参数"——见
 * learn.chatgpt.com/docs/config-file/config-advanced;固定参数脚本本身不读那个额外参数,
 * 效果上只是"turn 结束就打一个标记",与 cc 的 Stop hook 语义等价) + mcp_servers 段
 * (复用 Task 3 的 `renderCodexMcpToml`)。TOML 要求根级 key 必须出现在第一个 table 之前
 * (codex-docs: config.md 曾用这条规则解释"notify 放最后不生效"的排查案例),所以 notify
 * 行必须排在 mcp_servers 的 `[mcp_servers."x"]` 表头之前。
 *
 * `<ws.root>/.codex/auth.json`:既然 `.codex/` 在这里被当成独立 `CODEX_HOME`,真实登录态
 * (`codexHomeSource`,默认 `~/.codex`)里的 `auth.json`(codex-docs:
 * learn.chatgpt.com/docs/auth"Codex caches login details locally... at ~/.codex/auth.json"
 * )要搬一份过来,否则这个隔离出来的 CODEX_HOME 过不了鉴权;找不到就跳过(本机/CI 未登录),
 * 不阻塞 provision。
 *
 * `<ws.root>/.codex/skills/<name>/`:codex-docs 确认 skills 支持 `.codex/skills/`(项目级)
 * 或 `~/.codex/skills/`(个人级)两种位置;本方案下 `.codex/` 本身就是 CODEX_HOME,两个
 * 语义重合到同一目录,直接复用 Task 3 的 `materializeSkills`。
 *
 * `<ws.root>/AGENTS.md`:codex-docs 确认 codex 从项目根往下逐级查找 AGENTS.md,与 cc 的
 * CLAUDE.md 一样落在 workspace 根,复用 `renderContextMd`。
 *
 * ## spawn/resume 启动参数
 *
 * codex-docs(learn.chatgpt.com/docs/developer-commands):交互态 `codex` 主命令顶层支持
 * `--ask-for-approval`(`untrusted|on-request|never`)与 `--sandbox`
 * (`read-only|workspace-write|danger-full-access`)。本 adapter 固定传
 * `--ask-for-approval never --sandbox workspace-write`,与 cc 用
 * `--permission-mode acceptEdits` 同样的自动化意图——不能让审批弹窗卡住 tmux pane。
 * `codex resume <SESSION_ID>` 是独立子命令(不是 `--resume` flag),同一文档页确认;
 * resume 子命令是否接受与主命令相同的 `--ask-for-approval`/`--sandbox` 未逐条确认,按
 * 同一 CLI 顶层 flag 的一般惯例沿用,真机校准时需要核实。
 *
 * ## 提交纪律与状态判定
 *
 * 与 cc 完全一致(锁纪律、三源合成状态判定、spawn/resume 首条输入失败按 kill 路径清理落
 * exited(crashed)、session_ref UUID 边界校验 + shQuote):tmux newSession 成功之后才落
 * meta(running)+ 注册 runtime;判定与提交在该 worker 的互斥锁内原子完成。三源合成里的
 * "事件文件新增" 现在对应的是 codex 的 agent-turn-complete 通知(只有这一种事件类型,
 * codex-docs 确认目前 notify 仅支持 agent-turn-complete),复用同一个 'stop' kind 字符串
 * 与 stopBaseline 机制,语义与 cc 的"自上次输入以来新的 Stop 事件"完全对应。
 *
 * ## readTrace
 *
 * 解析 `<CODEX_HOME>/sessions/.../rollout-*.jsonl`,字段依据 codex-rs 源码抓取确认(见各
 * 归一化函数内的 codex-docs 注释),fixture 手工构造,真机校准留待安装。rolloutPath 经
 * ensureRuntime 从 meta 的 workspace_root + session_discovery 字段(四轮 review 新增持久化)
 * 重新按 session_id 精确查找重建,不再要求"只能对本进程内常驻 runtime 的化身调用"(同 cc)。
 */
import { promises as fs, type Dirent } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { TmuxDriver } from '../tmux/driver.js'
import { CliEventChannel } from '../cli-events.js'
import { OutputLog } from '../output-log.js'
import { AsyncMutex } from '../async-mutex.js'
import { writeMetaAtomic, maxSeqOnDisk } from '../meta-store.js'
import { WorkerExitedError, CapabilityNotSupportedError } from '../errors.js'
import { materializeSkills, renderCodexMcpToml, renderContextMd, type ProvisionSources } from '../provision/materialize.js'
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

/** POSIX shell 单引号转义,与 cc adapter 的私有 shQuote 同款用法(独立复制一份)。 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** TOML 双引号字符串转义 + 包裹,与 provision/materialize.ts 的私有 tomlString 同款用法
 * (独立复制一份,materialize.ts 未导出它——同 cc adapter 复制 shQuote 的先例)。 */
function tomlString(value: string): string {
  let out = ''
  for (const ch of value) {
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else {
      const code = ch.charCodeAt(0)
      if (code < 0x20 || code === 0x7f) out += '\\u' + code.toString(16).padStart(4, '0')
      else out += ch
    }
  }
  return `"${out}"`
}

/** UUID 格式校验:标准 UUID 格式(8-4-4-4-12 十六进制段,由连字符分隔)。*/
function validateSessionRef(sessionRef: string): void {
  const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
  if (!uuidPattern.test(sessionRef)) {
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
  readonly seq: number
  readonly dir: string
  readonly workspaceRoot: string
  /** 本 worker 专属的隔离 CODEX_HOME(= `<workspaceRoot>/.codex`),spawn/resume 全程不变。 */
  readonly codexHome: string
  readonly sessionName: string
  readonly sessionId: string
  /** spawn 时发现的 rollout 文件绝对路径;发现失败(占位 session_id)则为 undefined。 */
  readonly rolloutPath?: string
  readonly outputLog: OutputLog
  readonly eventChannel: CliEventChannel
  /** spawn 时 session 发现的结果:'discovered' 表示发现了真实 rollout 文件,'placeholder' 表示超时降级。
   * 内部状态机用,会透传到 meta 文件。 */
  readonly sessionDiscoveryStatus: 'discovered' | 'placeholder'
  state: WorkerContractState
  ended_reason?: IncarnationEndReason
  /** 自上一次 sendInput(或 spawn)以来"已计入"的 turn-complete 通知数;新计数超过它才判定
   * 本轮 idle。语义与 cc 的 stopBaseline 完全对应。 */
  stopBaseline: number
  killed: boolean
  /** 是否已经被 resume 过一次。resume() 锁内检测"对同一 prev 的重复 resume"(先到先得,
   * 后来者报错),对齐 builtin/cc 同款语义(P2 review #2)。 */
  resumed?: boolean
}

function instanceKey(h: { worker_id: string; seq: number }): string {
  return `${h.worker_id}#${h.seq}`
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

/** 有限时间轮询 findNewestRolloutFile,50ms 间隔;超时返回 null(调用方退化为占位 uuid)。 */
async function pollForNewRollout(sessionsDir: string, cutoffMs: number, timeoutMs: number): Promise<{ path: string; sessionId: string } | null> {
  const intervalMs = 50
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await findNewestRolloutFile(sessionsDir, cutoffMs)
    if (found) return found
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/**
 * 四轮 review 修复(ensureRuntime 专用):按已知 session_id 精确查找对应的 rollout 文件——
 * 不看 mtime,只看文件名里嵌的 uuid 是否匹配 exactly。meta 只落 session_id +
 * session_discovery 状态,不落 rolloutPath 这个绝对路径(升级前的 meta 结构就没有它,补
 * 一个字段不如直接按已知的确定性文件名规则重新找一遍,与 sessionName/outputFile 等其它
 * 重建字段的思路一致——见 ensureRuntime 注释)。同一遍历约定(深度不超过 4 层,目录不存在
 * 按"没找到"处理)复用自 findNewestRolloutFile。
 */
async function findRolloutFileBySessionId(sessionsDir: string, sessionId: string): Promise<string | undefined> {
  async function walk(dir: string, depth: number): Promise<string | undefined> {
    if (depth > 4) return undefined
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
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
      if (match && match[1] === sessionId) return full
    }
    return undefined
  }
  return walk(sessionsDir, 0)
}

export class CodexWorkerAdapter implements WorkerAdapter {
  readonly implId = 'codex' as const

  private readonly tmux: TmuxDriver
  private readonly codexBin: string
  private readonly codexHomeSource: string
  private readonly sessionDiscoveryTimeoutMs: number
  private readonly runtimes = new Map<string, Runtime>()
  private readonly mutexes = new Map<string, AsyncMutex>()

  constructor(
    private readonly deps: {
      readonly dataDir: string
      readonly codexBin?: string
      readonly tmux?: TmuxDriver
      /** 真实登录态所在的 CODEX_HOME,默认 ~/.codex;provision 从这里搬一份 auth.json 到
       * workspace 隔离出来的 CODEX_HOME,detect() 的 activated 检查也读这里。测试用可注入
       * fixture 目录,不依赖开发机真实 home。 */
      readonly codexHomeSource?: string
      /** spawn() 发现真实 session id 的轮询上限(ms),默认 3000;测试用可调小避免拖慢用例。 */
      readonly sessionDiscoveryTimeoutMs?: number
      readonly onStateChange?: (h: IncarnationHandle, state: WorkerContractState) => void
    },
  ) {
    this.tmux = deps.tmux ?? new TmuxDriver()
    this.codexBin = deps.codexBin ?? 'codex'
    this.codexHomeSource = deps.codexHomeSource ?? join(homedir(), '.codex')
    this.sessionDiscoveryTimeoutMs = deps.sessionDiscoveryTimeoutMs ?? 3000
  }

  async detect(): Promise<DetectResult> {
    let versionOutput: string
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', `${this.codexBin} --version`])
      versionOutput = stdout.trim()
    } catch (err) {
      return { installed: false, activated: false, detail: `codex binary not found or failed to run: ${(err as Error).message}` }
    }

    let activated = false
    try {
      const entries = await fs.readdir(this.codexHomeSource)
      // codex-docs: 凭据落在 CODEX_HOME/auth.json(learn.chatgpt.com/docs/auth)。config.toml
      // 存在但没登录过也可能出现,所以两者任一存在都算"至少配置过"——与 cc 检查
      // settings.json/.credentials.json 同一思路(宽松判定,不做网络调用)。
      activated = entries.includes('auth.json') || entries.includes('config.toml')
    } catch {
      activated = false
    }

    return { installed: true, activated, detail: versionOutput }
  }

  async provision(ws: Workspace, caps: CapabilityBundle): Promise<void> {
    const codexDir = join(ws.root, '.codex')
    await fs.mkdir(codexDir, { recursive: true })

    const channel = new CliEventChannel(eventsFilePath(ws))
    // codex-docs: notify 只支持在"顶层用户配置"这层 config.toml 里声明,项目级
    // .codex/config.toml 里的 notify 会被 codex 忽略并打印启动告警(config-basic 限制清单
    // 明确包含 notify)。本 adapter 把 <ws.root>/.codex 整个目录当作这个 worker 专属的
    // CODEX_HOME(spawn/resume 经 tmux env 传递),绕开这条项目级限制。
    //
    // notify 的程序契约是"数组:可执行文件 + 固定参数",codex 运行时会在末尾追加一个 JSON
    // payload 作为额外参数(config-advanced 原文确认)。这里用 `/bin/sh -c <script>` 包一层,
    // 额外参数会落在 shell 的 $0 上,脚本本身不引用位置参数,效果上只是"turn 结束就打一个
    // 标记"——与 cc 的 Stop hook(丢弃 stdin payload,同一设计取舍,见 CliEventChannel 头
    // 注释)语义一致。
    const notifyLine = `notify = [${tomlString('/bin/sh')}, ${tomlString('-c')}, ${tomlString(channel.hookCommand('stop'))}]\n`
    const mcpServers = caps.mcp_servers as unknown as ProvisionSources['mcpServers']
    const mcpToml = renderCodexMcpToml(mcpServers)
    // TOML 要求根级 key 必须出现在第一个 table 之前,否则会被解析成前一个 table 的子字段——
    // notify 必须排在 mcp_servers 的 [mcp_servers."x"] 表头之前。
    await fs.writeFile(join(codexDir, 'config.toml'), notifyLine + '\n' + mcpToml, 'utf-8')

    // codex-docs: 既然 .codex/ 在这里被当成独立 CODEX_HOME,真实登录态里的 auth.json 要搬
    // 一份过来,否则隔离出来的 CODEX_HOME 过不了鉴权。找不到就跳过(本机/CI 未 `codex
    // login`)——不阻塞 provision,登录态缺失会在真正 spawn 时体现为 codex 进程报错,不是
    // provision 的职责。
    try {
      const authRaw = await fs.readFile(join(this.codexHomeSource, 'auth.json'), 'utf-8')
      const authPath = join(codexDir, 'auth.json')
      await fs.writeFile(authPath, authRaw, 'utf-8')
      // auth.json 包含凭据,设置严格权限防止泄露
      await fs.chmod(authPath, 0o600)
    } catch {
      // 忽略:本机未登录/测试环境本就没有 auth.json
    }

    // .codex/ 整个隔离 HOME 都不应入库(凭据、临时缓存等),写入 .gitignore
    await fs.writeFile(join(codexDir, '.gitignore'), '*\n', 'utf-8')

    // codex-docs: skills 支持 .codex/skills/(项目级)或 ~/.codex/skills/(个人级);本方案下
    // .codex/ 本身就是 CODEX_HOME,两个语义重合到同一目录。
    await materializeSkills(ws.root, caps.skills, '.codex/skills')

    // codex-docs: AGENTS.md 从项目根往下逐级查找,落在 workspace 根,与 cc 的 CLAUDE.md 同构。
    await fs.writeFile(
      join(ws.root, 'AGENTS.md'),
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
    if (this.runtimes.has(instanceKey({ worker_id: spec.worker_id, seq }))) {
      throw new Error(`CodexWorkerAdapter.spawn: worker_id ${spec.worker_id} already spawned in this process`)
    }

    const dir = join(this.deps.dataDir, spec.worker_id)
    await fs.mkdir(dir, { recursive: true })

    const codexHome = join(spec.workspace.root, '.codex')
    const sessionName = `crabot-w-${spec.worker_id}-${seq}`
    const outputFile = join(dir, `output-${seq}.log`)
    // codex-docs: 交互态无 --session-id 等价参数;--ask-for-approval never --sandbox
    // workspace-write 与 cc 用 --permission-mode acceptEdits 同样的自动化意图。
    const command = `${this.codexBin} --ask-for-approval never --sandbox workspace-write`
    const spawnStartedAt = Date.now()

    // newSession 成功之后才落 meta(running)+注册 runtime,同 cc 纪律:tmux 失败时不留任何
    // 持久痕迹,同 worker_id 可安全重试。CODEX_HOME 经 tmux -e 传给会话进程(execFile 直传
    // argv,不经过 shell 插值,不需要额外转义)。
    await this.tmux.newSession({ name: sessionName, cwd: spec.workspace.root, command, outputFile, env: { CODEX_HOME: codexHome } })

    // session 发现:见文件头注释"session 发现"节。找不到就退化为本地占位 uuid(已知限制)。
    const discovered = await pollForNewRollout(join(codexHome, 'sessions'), spawnStartedAt, this.sessionDiscoveryTimeoutMs)
    const sessionId = discovered?.sessionId ?? randomUUID()
    const sessionDiscoveryStatus = discovered ? 'discovered' : 'placeholder'
    if (sessionDiscoveryStatus === 'placeholder') {
      console.warn(
        `[codex-adapter] session discovery timed out for ${spec.worker_id}, using placeholder uuid; resume/readTrace will degrade`,
      )
    }

    const handle: IncarnationHandle = { worker_id: spec.worker_id, seq, impl: 'codex', session_ref: sessionId }

    const runtime: Runtime = {
      worker_id: spec.worker_id,
      seq,
      dir,
      workspaceRoot: spec.workspace.root,
      codexHome,
      sessionName,
      sessionId,
      rolloutPath: discovered?.path,
      outputLog: new OutputLog(outputFile),
      eventChannel: new CliEventChannel(eventsFilePath(spec.workspace)),
      sessionDiscoveryStatus,
      state: 'running',
      stopBaseline: 0,
      killed: false,
    }

    await writeMetaAtomic(dir, seq, {
      seq,
      state: 'running',
      session_id: sessionId,
      session_discovery: sessionDiscoveryStatus,
      workspace_root: spec.workspace.root,
    })
    this.runtimes.set(instanceKey(handle), runtime)

    // 首条任务输入注入失败:不能放任 running——按 kill 路径清理 tmux 会话后落
    // exited(crashed)(不是 killed,不是用户发起的 kill),spawn 仍然 reject。
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
    validateSessionRef(prev.session_ref)

    // 四轮 review 修复(同 cc adapter):prevRuntime 不再要求"常驻本进程"——resume 的合法
    // 目标本来就是一个已终态的化身,ensureRuntime 从落盘 meta 重建它(重建不以 tmux 存活为
    // 门槛,只有 meta 完全不存在才返回 undefined,见该方法注释)。
    const prevRuntime = await this.ensureRuntime(prev)
    if (!prevRuntime) {
      throw new Error(`CodexWorkerAdapter.resume: no such incarnation ${prev.worker_id}#${prev.seq} resident in this process`)
    }
    const prevHandle: IncarnationHandle = { worker_id: prev.worker_id, seq: prev.seq, impl: 'codex', session_ref: prev.session_ref }
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
      handle = { worker_id: prev.worker_id, seq, impl: 'codex', session_ref: prev.session_ref }
      const sessionName = `crabot-w-${prev.worker_id}-${seq}`
      const outputFile = join(dir, `output-${seq}.log`)
      // codex-docs: `codex resume <SESSION_ID>` 是独立子命令(不是 --resume flag)。
      // --ask-for-approval/--sandbox 是否对 resume 子命令同样生效未逐条确认,按同一 CLI 顶层
      // flag 惯例沿用,真机校准时需要核实(见 Task 6 报告)。
      const command = `${this.codexBin} resume ${shQuote(prev.session_ref)} --ask-for-approval never --sandbox workspace-write`

      // 锁纪律与 spawn 一致:tmux newSession 成功之后才落 meta(running)+注册 runtime。
      await this.tmux.newSession({ name: sessionName, cwd: prevRuntime.workspaceRoot, command, outputFile, env: { CODEX_HOME: prevRuntime.codexHome } })

      runtime = {
        worker_id: prev.worker_id,
        seq,
        dir,
        workspaceRoot: prevRuntime.workspaceRoot,
        codexHome: prevRuntime.codexHome,
        sessionName,
        sessionId: prev.session_ref,
        // resume 续写的是同一个 rollout 文件(session id 不变),不需要重新发现——直接沿用上一
        // 化身已发现的路径;上一化身当时若发现失败(占位 uuid),这里同样拿不到,保持未知。
        rolloutPath: prevRuntime.rolloutPath,
        outputLog: new OutputLog(outputFile),
        eventChannel: new CliEventChannel(eventsFilePath({ root: prevRuntime.workspaceRoot })),
        sessionDiscoveryStatus: prevRuntime.sessionDiscoveryStatus,
        state: 'running',
        stopBaseline: 0,
        killed: false,
      }

      await writeMetaAtomic(dir, seq, {
        seq,
        state: 'running',
        session_id: prev.session_ref,
        session_discovery: prevRuntime.sessionDiscoveryStatus,
        workspace_root: prevRuntime.workspaceRoot,
      })
      this.runtimes.set(instanceKey(handle), runtime)
      prevRuntime.resumed = true
    })

    // 首条 wakeInput 注入失败:按 spawn 同款纪律处理——已注册的化身清理 tmux 会话后落
    // exited(crashed),resume 仍然 reject。
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

  async fork(_prev: IncarnationRef, _forkInput: string): Promise<IncarnationHandle> {
    // codex-docs: codex exec 没有 cc `-p ... --fork-session --output-format text` 那种
    // "一条命令完成侧问"的等价物——openai/codex#11750、#17568 两个 open feature request
    // 明确指出 exec CLI 目前不支持 fork,唯一记录在案的变通方案是拉起交互式 TUI 塞进伪终端、
    // 轮询文件系统等新 rollout 文件出现、杀掉 TUI、再用 `codex exec resume` 接力——这已经不是
    // "无头一击",是要在这里重新实现一遍 tmux 交互流程,不是本 adapter 想提供的 fork 语义。
    // capabilities().fork 如实定为 false,这里对应抛出同款语义的能力缺失错误。
    throw new CapabilityNotSupportedError('codex', 'fork')
  }

  async sendInput(h: IncarnationHandle, text: string, opts?: { raw?: boolean }): Promise<void> {
    // 四轮 review 修复(同 cc adapter):重启后新建的 adapter 实例 runtimes 必为空,旧实现
    // 在这里直接抛通用 Error,harness 只对 WorkerExitedError 转透明接续,通用 Error 会原样
    // 穿透砸给调用方,消息永久卡在队首。ensureRuntime 拿不到任何落盘记录(真·未知化身)
    // 时,对调用方而言效果与"已终态"等价,同样抛 WorkerExitedError。
    const runtime = await this.ensureRuntime(h)
    if (!runtime) throw new WorkerExitedError(h.worker_id, h.seq)

    const { state: current, stopCount } = await this.syncState(runtime, h)
    if (current === 'exited') throw new WorkerExitedError(h.worker_id, h.seq)

    // 新一轮开始:把 baseline 推到当前计数,上一轮遗留的 turn-complete 通知不会被误算进新一轮。
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
    return (await this.syncState(runtime, h)).state
  }

  async readTrace(h: IncarnationHandle, cursor?: TraceCursor): Promise<{ events: NormalizedTraceEvent[]; nextCursor: TraceCursor }> {
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
      return { events: [], nextCursor: cursor ?? { offset: 0 } }
    }

    let raw: string
    try {
      raw = await fs.readFile(runtime.rolloutPath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], nextCursor: cursor ?? { offset: 0 } }
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
      const event = normalizeRolloutLine(lines[i])
      if (event) events.push(event)
      consumed = i + 1
    }
    return { events, nextCursor: { offset: consumed } }
  }

  async kill(h: IncarnationHandle): Promise<void> {
    // 四轮 review 修复(同 cc adapter):重启后新建的 adapter 实例对确已终态(或压根没有
    // 落盘记录)的化身调 kill,以前直接抛通用 Error,harness.killWorker/handoffIncarnation
    // 没有 try/catch,错误会穿透打断整个操作。ensureRuntime 拿不到任何落盘记录时直接幂等
    // 返回;拿到时 runtime.state 已经是探活得到的真实值,下面既有的 exited 幂等分支自然
    // 覆盖"会话已经不在了"的情形。
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
    return { fork: false, revive: true, goalMode: false, subagent: false, structuredTrace: true }
  }

  // --- Internal ---

  /**
   * 三源合成状态判定:tmux isAlive(false → exited,终态优先) > 事件文件(会话还活着时,新
   * turn-complete 通知 → idle) > 默认 running。与内存态不同则在互斥锁内原子迁移(改内存 +
   * 写 meta)。判定与提交整体在锁内完成,理由与 cc 完全一致(见 cc adapter.ts 文件头注释,
   * 避免过期快照覆盖并发落定的新结果)。
   */
  private async syncState(runtime: Runtime, h: IncarnationHandle): Promise<{ state: WorkerContractState; stopCount: number }> {
    if (runtime.state === 'exited') return { state: 'exited', stopCount: runtime.stopBaseline }

    return this.getMutex(h.worker_id).run(async () => {
      if (runtime.state === 'exited') return { state: 'exited', stopCount: runtime.stopBaseline }

      const events = await runtime.eventChannel.readAll()
      const stopCount = events.filter((e) => e.kind === 'stop').length

      // isAlive 检查提到最前(终态优先):进程可能在发过 turn-complete 通知之后自退(崩溃/
      // OOM/自敲 exit)——stopCount 恒 > baseline 会一直判成 idle,永远走不到下面的 isAlive
      // 分支,化身不落 exited,resume 被永久拒绝(P2 review #2,同 cc adapter 修复)。会话
      // 已经不在了就直接 exited,不管有没有新通知;只有会话还活着,才轮到通知区分 idle/running。
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
   * 四轮 review 修复(与 cc adapter 同款设计,见其 ensureRuntime 注释——这里只记 codex
   * 特有的差异):runtimes 命中直接返回;未命中时读 meta-<seq>.json,meta 完全不存在才
   * 返回 undefined(真·未知化身)。tmux 会话是否还活着不作为"能不能重建"的门槛,只影响
   * 重建出的 runtime.state。
   *
   * codex 专属字段:codexHome 从 workspace_root 派生(`<workspaceRoot>/.codex`,与
   * provision/spawn 的约定一致);rolloutPath 不落盘(meta 只落 session_id +
   * session_discovery),session_discovery==='discovered' 时用
   * findRolloutFileBySessionId 按已知 session_id 重新在 codexHome/sessions 下精确查找,
   * 找不到(文件被移走/清理)则退化为 undefined,readTrace 优雅降级为空数组(与 spawn 时
   * 发现失败的已知限制同一降级路径)。
   */
  private async ensureRuntime(ref: { worker_id: string; seq: number; session_ref?: string }): Promise<Runtime | undefined> {
    const key = instanceKey(ref)
    const existing = this.runtimes.get(key)
    if (existing) return existing

    const dir = join(this.deps.dataDir, ref.worker_id)
    const meta = await this.readMetaFile(dir, ref.seq)
    if (!meta) return undefined

    const sessionName = `crabot-w-${ref.worker_id}-${ref.seq}`
    const alive = await this.tmux.isAlive(sessionName)
    const workspaceRoot = meta.workspace_root ?? ''
    const sessionId = meta.session_id ?? ref.session_ref ?? ''
    const codexHome = workspaceRoot ? join(workspaceRoot, '.codex') : ''
    const sessionDiscoveryStatus: 'discovered' | 'placeholder' = meta.session_discovery ?? 'placeholder'
    const rolloutPath =
      sessionDiscoveryStatus === 'discovered' && codexHome ? await findRolloutFileBySessionId(join(codexHome, 'sessions'), sessionId) : undefined
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
      codexHome,
      sessionName,
      sessionId,
      rolloutPath,
      outputLog: new OutputLog(outputFile),
      eventChannel,
      sessionDiscoveryStatus,
      state: alive ? 'running' : 'exited',
      ended_reason: alive ? undefined : meta.ended_reason,
      stopBaseline,
      killed: false,
    }
    this.runtimes.set(key, runtime)
    return runtime
  }

  /** meta-<seq>.json 读取,文件不存在/内容损坏一律返回 undefined(供 ensureRuntime 判定
   * "真·未知化身")。 */
  private async readMetaFile(
    dir: string,
    seq: number,
  ): Promise<
    | { session_id?: string; workspace_root?: string; ended_reason?: IncarnationEndReason; session_discovery?: 'discovered' | 'placeholder' }
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
   * worker_id 对应下一个可用的化身序号:该 worker 现存所有化身里最大 seq + 1。resume() 在
   * mutex.run 内调用,保证不与并发的另一次 resume 撞号。与 cc adapter 的同名方法同一思路
   * (codex 的 fork() 不支持,不参与这个分配)。
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

  private async transitionState(runtime: Runtime, h: IncarnationHandle, state: WorkerContractState): Promise<void> {
    await writeMetaAtomic(runtime.dir, runtime.seq, {
      seq: runtime.seq,
      state,
      session_id: runtime.sessionId,
      session_discovery: runtime.sessionDiscoveryStatus,
      workspace_root: runtime.workspaceRoot,
    })
    runtime.state = state
    try {
      this.deps.onStateChange?.(h, state)
    } catch (err) {
      console.error(`[CodexWorkerAdapter] onStateChange callback error for ${h.worker_id}#${h.seq}:`, err)
    }
  }

  private async transitionExited(runtime: Runtime, h: IncarnationHandle, ended_reason: IncarnationEndReason): Promise<void> {
    await writeMetaAtomic(runtime.dir, runtime.seq, {
      seq: runtime.seq,
      state: 'exited',
      session_id: runtime.sessionId,
      ended_reason,
      session_discovery: runtime.sessionDiscoveryStatus,
      workspace_root: runtime.workspaceRoot,
    })
    runtime.state = 'exited'
    runtime.ended_reason = ended_reason
    try {
      this.deps.onStateChange?.(h, 'exited')
    } catch (err) {
      console.error(`[CodexWorkerAdapter] onStateChange callback error for ${h.worker_id}#${h.seq}:`, err)
    }
  }
}

/** AGENTS.md 里标注的 worker 标签:provision(ws, caps) 拿不到 worker_id,退而取 workspace
 * 目录名兜底。与 cc adapter 同款独立实现。 */
function workerIdLabelFromWorkspace(ws: Workspace): string {
  const trimmed = ws.root.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/**
 * 归一化单行 codex rollout JSONL 为 NormalizedTraceEvent。
 *
 * codex-docs: 每行外层是 `{"type": ..., "payload": ...}`(codex-rs/protocol/src/protocol.rs
 * 的 `RolloutItem` 枚举 `#[serde(tag = "type", content = "payload", rename_all =
 * "snake_case")]` 确认),顶层 type 取值 session_meta / response_item / event_msg /
 * turn_context / world_state / compacted / inter_agent_communication /
 * inter_agent_communication_metadata——只有前三种映射为 trace 事件,其余跳过,同 cc 对
 * mode/summary/queue-operation 的处理方式(不认识的行归一化为 null,readTrace 跳过)。
 */
function normalizeRolloutLine(line: string): NormalizedTraceEvent | null {
  let parsed: { type?: unknown; payload?: unknown }
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const payload = parsed.payload as Record<string, unknown> | undefined

  if (parsed.type === 'session_meta') {
    const meta = payload as { timestamp?: string; cwd?: string } | undefined
    const ts = typeof meta?.timestamp === 'string' ? meta.timestamp : ''
    return { ts, kind: 'lifecycle', role: 'system', summary: truncate(`session_meta cwd=${meta?.cwd ?? ''}`, 200), detail: payload }
  }

  if (parsed.type === 'event_msg') {
    // codex-docs: EventMsg 是内部 tag(`#[serde(tag = "type", rename_all = "snake_case")]`,
    // 字段直接铺在 payload 里,不像 RolloutItem 那样外套一层 content),取 payload.type 当摘要。
    const eventType = typeof payload?.type === 'string' ? payload.type : 'event_msg'
    return { ts: '', kind: 'lifecycle', role: 'system', summary: eventType, detail: payload }
  }

  if (parsed.type === 'response_item') {
    return normalizeResponseItem(payload)
  }

  return null
}

/**
 * response_item 的 payload 同样是内部 tag(codex-rs/protocol/src/models.rs 的 `ResponseItem`
 * 枚举 `#[serde(tag = "type", rename_all = "snake_case")]`)。这里只认领已从源码确认字段形状
 * 的四种子类型(message/function_call/function_call_output/reasoning);其余子类型
 * (agent_message/local_shell_call/web_search_call/custom_tool_call/...)未逐一核实字段,
 * 跳过而非猜测映射。
 */
function normalizeResponseItem(payload: Record<string, unknown> | undefined): NormalizedTraceEvent | null {
  if (!payload || typeof payload.type !== 'string') return null

  if (payload.type === 'message') {
    const role = payload.role
    const text = extractContentItemsText(payload.content)
    return {
      ts: '',
      kind: 'message',
      role: role === 'user' || role === 'assistant' || role === 'system' ? role : undefined,
      summary: truncate(text, 200),
      detail: payload,
    }
  }

  if (payload.type === 'function_call') {
    const name = typeof payload.name === 'string' ? payload.name : ''
    const args = typeof payload.arguments === 'string' ? payload.arguments : ''
    return { ts: '', kind: 'tool_call', role: 'assistant', summary: truncate(`${name}(${args})`, 200), detail: payload }
  }

  if (payload.type === 'function_call_output') {
    // codex-docs: FunctionCallOutput 在 ResponseItem 枚举里没有 role 字段(models.rs),不像
    // cc 的 tool_result 挂在 role=user 的消息体里——role 留空(undefined)。
    const output = payload.output
    return { ts: '', kind: 'tool_result', summary: truncate(typeof output === 'string' ? output : JSON.stringify(output ?? {}), 200), detail: payload }
  }

  if (payload.type === 'reasoning') {
    const text = extractReasoningSummaryText(payload.summary)
    return { ts: '', kind: 'thinking', role: 'assistant', summary: truncate(text, 200), detail: payload }
  }

  return null
}

/** ContentItem 数组:只取 input_text/output_text 块的 text 拼接,跳过 input_image/input_audio。 */
function extractContentItemsText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((item): item is { type: string; text?: string } => !!item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string')
    .filter((item) => item.type === 'input_text' || item.type === 'output_text')
    .map((item) => item.text ?? '')
    .join('\n')
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
