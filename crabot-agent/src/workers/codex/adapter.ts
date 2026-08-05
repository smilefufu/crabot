/**
 * CodexWorkerAdapter — WorkerAdapter 契约的 OpenAI codex CLI 实现。
 *
 * 2026-07-30 在部署机 m2(codex-cli 0.144.1)上做了一轮真机校准,修正了四处此前只能靠文档/
 * 源码推断的行为:session 发现(优先信 rollout 内容里的权威 session_id,见下方"session 发现"
 * 节)、nvm 部署形态下 tmux 拉起子进程解析不到 codex 自身 node 的陷阱(见 resolveBinDir/
 * buildEnv)、spawn/resume 命令行参数顺序(见"spawn/resume 启动参数"节)、readTrace 的
 * rollout 行结构(见 normalizeRolloutLine)。同日的后续一轮校准修正了上一轮引入的一个回归:
 * 曾误把 `codex exec` 专属的 `--skip-git-repo-check` 当成交互式顶层命令也支持的参数加了
 * 上去,m2 实测顶层 `codex`/`codex resume` 的 Options 全清单里都没有这个 flag,传了会被 clap
 * 拒绝——已改为 provision 时把 workspace 写成 config.toml 里的受信任目录(见"provision"节的
 * trust_level 段)。未被这两轮校准覆盖的细节仍按公开文档/codex 源码(github.com/openai/codex,
 * developers.openai.com/codex 系列页面,已跳转到 learn.chatgpt.com/docs/*)推断实现,标注为
 * `codex-docs:` 的引用点维持原样,后续如有出入以真机行为为准。
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
 * ## 启动期就绪握手(spawn 专用,排在 session 发现之前)
 *
 * tmux newSession 之后**先等 pane 输出里出现 `\e[?2004h`**(TUI 已开启 bracketed paste),
 * 才谈 session 发现与投递开工输入;等不到就**不投递**,落 idle 并把 output 尾部随唤醒事件
 * 交给 manager 决策(见 spawn 内的握手段、reportStartupStall,机制细节见 tmux/paste-ready.ts)。
 * 这一段与 cc adapter 完全对称——两边发 prompt 走的是同一个 `TmuxDriver.sendText`,
 * `paste-buffer -p` 的前提(目标程序已请求 bracketed paste)此前两边都没有任何代码保障。
 *
 * ## session 发现(spawn 专用)
 *
 * codex 走的是交互式 TUI(本 adapter 用 tmux 拉起 `codex ...`,不是 `codex exec`),拿不到
 * `codex exec --json` 的 `thread.started` 事件流,只能靠事后发现——codex-docs: rollout 文件
 * 路径 `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`(来自
 * codex-rs/rollout/src/list.rs 注释)。spawn() 在 tmux newSession 成功后、注入首条 prompt
 * 之前,有限时间(`sessionDiscoveryTimeoutMs`,默认 3000ms)轮询这个目录树找新出现的
 * rollout 文件;m2 真机实测:文件一旦被发现,优先读它首行 `session_meta.payload.session_id`
 * 作为权威 session_id(比文件名解析更可靠,是 codex 自己声明的值),内容还没写完整(文件刚
 * 创建的竞态、或老版本 codex 不写这个字段)才退回文件名里嵌的 uuid(实测两者完全一致,退回
 * 不算精度损失)。轮询超时(codex 还没来得及落盘,或本次跑的是不写 rollout 文件的 mock)
 * 就退化为本地生成的占位 uuid——这个占位 uuid 不对应任何真实 codex 会话文件,该化身自己的
 * resume()/readTrace() 会因此失效(resume 传给 codex 的 session id 是假的;readTrace 因为
 * `rolloutPath` 是 undefined 直接退化为空数组),是已知限制,真机环境下正常运行基本不会
 * 触发(轮询窗口内文件必现)。
 *
 * ## provision:workspace 级配置
 *
 * `<ws.root>/.codex/config.toml`:notify 段(指向 `CliEventChannel.hookCommand('notification'
 * 概念上等价的 'stop')`,用 `/bin/sh -c` 包一层,因为 codex-docs 确认 notify 是"程序+固定参数
 * 数组,codex 会在末尾追加一个 JSON payload 作为额外参数"——见
 * learn.chatgpt.com/docs/config-file/config-advanced;固定参数脚本本身不读那个额外参数,
 * 效果上只是"turn 结束就打一个标记",与 cc 的 Stop hook 语义等价) + `[projects."<realpath>"]`
 * 段(`trust_level = "trusted"`,把 workspace 声明成受信任目录——codex 源码里交互式 TUI 判断
 * "是否受信目录"的真实机制,取代不存在的 `--skip-git-repo-check` flag,见"spawn/resume 启动
 * 参数"节;path 用 `fs.realpath(ws.root)` 解析符号链接) + mcp_servers 段(复用 Task 3 的
 * `renderCodexMcpToml`)。
 *
 * 这三块是**叠加在宿主 `<codexHomeSource>/config.toml` 之上**的,不是从零写出一份新配置:
 * `.codex/` 在这里被当成独立 `CODEX_HOME`,codex 就完全不会去读用户真正的 `~/.codex/
 * config.toml`,于是 `model_provider` / `[model_providers.*].base_url` 这些"请求发去哪"的
 * 配置会全部丢失,退回 codex 的内置默认端点。生产实证:auth.json 搬过来了、端点没搬,worker
 * 拿着自建镜像的 key 打 api.openai.com,报 401 invalid_api_key。隔离 home 就得整份继承宿主
 * 登录态,不能只搬凭据。宿主配置不存在 → 干净降级;损坏 → 显式抛错(见 `readHostConfig`)。
 * 其中 `[mcp_servers]` 由 crabot 的 caps **整体覆盖**宿主的,不做合并:caps 是这个任务的授权
 * 边界,宿主配置不该有能力把它扩大。
 *
 * TOML 要求根级 key 必须出现在第一个 table 之前(codex-docs: config.md 曾用这条规则解释
 * "notify 放最后不生效"的排查案例)。叠加宿主配置之后,宿主自带 table,靠字符串拼接已经保证
 * 不了这条,所以整份文档交给 `smol-toml` 的 `stringify` 统一排布(它先出根级标量、再出 table)。
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
 * `codex resume <SESSION_ID>` 是独立子命令(不是 `--resume` flag),同一文档页确认。
 *
 * m2 真机实测校准了两点原先靠猜测沿用、未经验证的行为:
 * 1. **主命令级选项必须排在 `resume` 子命令之前**:`codex resume <id> --ask-for-approval
 *    never --sandbox workspace-write`(选项跟在 `resume <id>` 后面)会被 codex 当成 usage
 *    错误、exit=2 拒绝——本 adapter 曾经就是这么拼的(未验证的猜测),已按实测改成
 *    `codex --ask-for-approval never --sandbox workspace-write resume <id>`(选项在前)。
 * 2. **不传 `--skip-git-repo-check`,改用 config.toml 的 `[projects."<path>"] trust_level`**:
 *    上一轮曾给 spawn/resume 加过 `--skip-git-repo-check`,诊断("worker workspace 不是受信
 *    目录,不处理会卡住")是对的,但这个 flag **只注册在 `codex exec` 子解析器上**——m2 实测
 *    `codex --help`/`codex resume --help` 的顶层交互式 Options 全清单里都没有它,传给交互式
 *    `codex`/`codex resume` 会被 clap 当 usage 错误直接拒绝(exit=2),是把 `codex exec` 路径
 *    下的真机结论错误套用到了交互式路径(exec 路径实测,交互态未单独验证)。已改为 provision
 *    时把 workspace 写成 config.toml 里的受信任目录,见"provision"节。
 *
 * **网络放行**:`--sandbox workspace-write` 下 `sandbox_workspace_write.network_access`
 * 默认 false,且沙箱(macOS seatbelt)的拒绝把 loopback 一起挡掉——worker 外网和本机端口
 * 同时不可达(m2 实测 codex-cli 0.146.0:只给 `--sandbox workspace-write` 时
 * `curl example.com` HTTP=000,补上 network_access=true 后 HTTP=200)。所以 spawn/resume
 * 都固定追加 `-c sandbox_workspace_write.network_access=true`(`-c/--config key=value` 是
 * 主命令级全局选项,值按 TOML 解析,同一文档页确认;与 `--sandbox` 同类,resume 时同样必须
 * 排在 `resume` 子命令之前)。**保留写限制**:worker 仍不能往 workspace 之外乱写,只放开网络。
 * 注:builtin worker 的 shell 本来就没有沙箱,单卡 codex 的网络只是把不对称当安全。
 *
 * 另外 PATH 显式经 `buildEnv()`/`resolveBinDir()` 前置了 codexBin 解析出的真实目录(nvm
 * 部署陷阱,见该函数注释):tmux server 是常驻进程,其环境不一定等于当前 agent 进程的环境
 * (m2 上 codex 是 nvm 装的 node 脚本,tmux server 环境不含对应 node 的 bin 目录时,子进程
 * 直接报 `env: node: No such file or directory`)。
 *
 * ## 提交纪律与状态判定
 *
 * 与 cc 完全一致(锁纪律、三源合成状态判定、spawn/resume 首条输入失败按 kill 路径清理落
 * exited(crashed)、session_ref UUID 边界校验 + shQuote):tmux newSession 成功之后才落
 * meta(running)+ 注册 runtime;判定与提交在该 worker 的互斥锁内原子完成。三源合成里的
 * "事件文件新增" 现在对应的是 codex 的 agent-turn-complete 通知(只有这一种事件类型,
 * codex-docs 确认目前 notify 仅支持 agent-turn-complete),复用同一个 'stop' kind 字符串
 * 与 stopBaseline 机制,语义与 cc 的"自上次输入以来新的 Stop 事件"完全对应。启动期就绪握手
 * 超时的暂扣标志(Runtime.startupStalled,落盘 meta.startup_stalled)同样是三源之外的一源,
 * 语义与 cc 逐字一致。
 *
 * ## readTrace
 *
 * 解析 `<CODEX_HOME>/sessions/.../rollout-*.jsonl`,信封结构与五种顶层 type 的字段形状已按
 * m2 真机实测校准(见 normalizeRolloutLine 注释),测试 fixture 按实测字段手写。rolloutPath
 * 经 ensureRuntime 从 meta 的 workspace_root + session_discovery 字段(四轮 review 新增持久化)
 * 重新按 session_id 精确查找重建,不再要求"只能对本进程内常驻 runtime 的化身调用"(同 cc)。
 */
import { promises as fs, type Dirent } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { TmuxDriver } from '../tmux/driver.js'
import { DEFAULT_PASTE_READY_TIMEOUT_MS, describeStartupStall, readOutputTail, waitForPasteReady } from '../tmux/paste-ready.js'
import { CliEventChannel } from '../cli-events.js'
import { OutputLog } from '../output-log.js'
import { decodeTerminalOutput } from '../terminal-output.js'
import { AsyncMutex } from '../async-mutex.js'
import { writeMetaAtomic, maxSeqOnDisk } from '../meta-store.js'
import { WorkerExitedError, CapabilityNotSupportedError } from '../errors.js'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { materializeSkills, renderCodexMcpToml, renderContextMd, type ProvisionSources } from '../provision/materialize.js'
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

/** spawn/resume 都要带的主命令级选项:放行 workspace-write 沙箱的出网。见文件头
 * "spawn/resume 启动参数"节。取值只含 `[A-Za-z_.=]`,不含 shell 元字符,拼进经 `sh -c`
 * 跑的 tmux 命令行时无需额外引号(与相邻的 `--sandbox workspace-write` 写法一致)。 */
const CODEX_NETWORK_ACCESS_OPT = '-c sandbox_workspace_write.network_access=true'

/** POSIX shell 单引号转义,与 cc adapter 的私有 shQuote 同款用法(独立复制一份)。 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** 取一个 TOML table 值当普通对象用;不是 table(缺失/标量/数组)就当空表。 */
function asTable(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
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
      const { stdout } = await execFileAsync('/bin/sh', ['-c', `command -v ${shQuote(token)}`])
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
  /**
   * 启动期就绪握手超时后的**暂扣态**(见 reportStartupStall)。语义、落盘方式与清除时机
   * 与 cc adapter 的同名字段逐字一致,见那里的注释:三源判定认不出这种 idle(pane 活着、
   * turn-complete 计数一个没涨,因为开工输入根本没投递过),不补这一源的话
   * reportStartupStall 刚落的 idle 会被下一次 syncState 翻回 running,台账上一个从没干过
   * 活的 worker 显示"正在干活"。跟着 meta 落盘(`startup_stalled`)以熬过 agent 重启。
   */
  startupStalled?: boolean
  /** CliEventChannel.watch() 的停止函数(协议 §6.2.3 的文件监视)。建立 runtime 时装上、
   * 落终态时摘掉,语义与 cc adapter 的同名字段完全一致。 */
  stopEventWatch?: () => void
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
 * 文件名解析,不抛错、不重试——真机实测文件名与内容里的 id 完全一致,这里只是"能拿到内容
 * 就优先信内容"的加固,拿不到不算失败。五轮 review 修复:读出的 id 额外按 UUID_RE 校验格式,
 * 不合法(畸形值)一律当成"拿不到",打 warn 并退回文件名解析——避免畸形 id 未经校验就被
 * 写进 meta.session_id 与 handle.session_ref(会让 spawn 静默成功、resume/readTrace 必然
 * 失效)。 */
async function readSessionIdFromRolloutContent(path: string): Promise<string | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf-8')
  } catch {
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
 * 四轮 review 修复(ensureRuntime 专用):按已知 session_id 精确查找对应的 rollout 文件——
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
async function findRolloutFileBySessionId(sessionsDir: string, sessionId: string): Promise<string | undefined> {
  const candidates: string[] = []

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
      if (!match) continue
      if (match[1] === sessionId) return full
      candidates.push(full)
    }
    return undefined
  }

  const exact = await walk(sessionsDir, 0)
  if (exact) return exact

  for (const candidate of candidates) {
    const contentSessionId = await readSessionIdFromRolloutContent(candidate)
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
   * PATH,不阻塞),外加调用方传入的额外变量(如 CODEX_HOME)。 */
  private async buildEnv(extra: Record<string, string>): Promise<Record<string, string>> {
    const dir = await this.resolveBinDirCached()
    const path = dir ? `${dir}:${process.env.PATH ?? ''}` : (process.env.PATH ?? '')
    return { PATH: path, ...extra }
  }

  async detect(): Promise<DetectResult> {
    const binDir = await this.resolveBinDirCached()
    const versionEnv = { ...process.env, PATH: binDir ? `${binDir}:${process.env.PATH ?? ''}` : (process.env.PATH ?? '') }
    let versionOutput: string
    try {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', `${this.codexBin} --version`], { env: versionEnv })
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
    const notify = ['/bin/sh', '-c', channel.hookCommand('stop')]

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
    await fs.writeFile(join(codexDir, 'config.toml'), stringifyToml(config), 'utf-8')

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
    // codex-docs + m2 实测:交互态无 --session-id 等价参数;--ask-for-approval never
    // --sandbox workspace-write 与 cc 用 --permission-mode acceptEdits 同样的自动化意图。
    // 不传 --skip-git-repo-check(m2 实测顶层交互式 codex 不支持这个 flag,只有 codex exec
    // 才有——见文件头"spawn/resume 启动参数"节);受信目录改由 provision 写进 config.toml 的
    // [projects."<realpath>"] trust_level = "trusted" 解决。
    // 网络放行见文件头"spawn/resume 启动参数"节。
    const command = `${this.codexBin} --ask-for-approval never --sandbox workspace-write ${CODEX_NETWORK_ACCESS_OPT}`
    const spawnStartedAt = Date.now()

    // newSession 成功之后才落 meta(running)+注册 runtime,同 cc 纪律:tmux 失败时不留任何
    // 持久痕迹,同 worker_id 可安全重试。CODEX_HOME 经 tmux -e 传给会话进程(execFile 直传
    // argv,不经过 shell 插值,不需要额外转义);PATH 同样经 -e 显式前置 codexBin 所在真实
    // 目录(nvm 部署陷阱,见 buildEnv/resolveBinDir 注释),不依赖 tmux server 自身环境。
    await this.tmux.newSession({ name: sessionName, cwd: spec.workspace.root, command, outputFile, env: await this.buildEnv({ CODEX_HOME: codexHome }) })

    // 启动期就绪握手(见 tmux/paste-ready.ts),排在 session 发现**之前**:
    // - 它才是"能不能收输入"的判据。session 发现等的是 rollout 文件出现,那是"会话已建立"
    //   的信号——启动期被模态框挡住时会话根本不会建立,那个轮询于是空转到超时,然后照样把
    //   prompt 发出去(这正是本次要根治的"降级继续");
    // - 顺带让 session 发现更稳:m2 实测 rollout 文件在 tmux 建会话约 3 秒后才落盘,几乎顶满
    //   原来那个 3s 窗口;就绪握手先吸收掉启动耗时,发现窗口从"已经能收输入"那一刻才开始算。
    const pasteReady = await waitForPasteReady(outputFile, {
      timeoutMs: this.pasteReadyTimeoutMs,
      isAlive: () => this.tmux.isAlive(sessionName),
    })

    // session 发现:见文件头注释"session 发现"节。
    // 未就绪时**不做发现、也不编占位 uuid**:此刻 codex 会话确实没建立,给一个长得像真值的
    // uuid 只会让 resume/readTrace 拿着假 id 静默失效。session_ref 留空,如实表示"没有会话"
    // (harness 在 adapter.spawn 返回前本来就用空串占位,空串是这一层既有的"未知"表示)。
    const discovered = pasteReady
      ? await pollForNewRollout(join(codexHome, 'sessions'), spawnStartedAt, this.sessionDiscoveryTimeoutMs)
      : null
    const sessionId = discovered ? discovered.sessionId : pasteReady ? randomUUID() : ''
    const sessionDiscoveryStatus = discovered ? 'discovered' : 'placeholder'
    if (!pasteReady) {
      console.warn(
        `[codex-adapter] startup readiness handshake timed out for ${spec.worker_id}; opening input NOT delivered, session_ref left empty`,
      )
    } else if (sessionDiscoveryStatus === 'placeholder') {
      console.warn(
        `[codex-adapter] session discovery timed out for ${spec.worker_id}, using placeholder uuid; resume/readTrace will degrade`,
      )
    }

    const handle: IncarnationHandle = { worker_id: spec.worker_id, seq, impl: 'codex', session_ref: sessionId }

    const eventChannel = new CliEventChannel(eventsFilePath(spec.workspace))
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
      eventChannel,
      sessionDiscoveryStatus,
      state: 'running',
      stopBaseline: await this.initialStopBaseline(eventChannel),
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
    this.startEventWatch(runtime, handle)

    // 等不到就绪就**不投递**(协议 §5.5 的"不安全态暂扣"):prompt 原封不动留在 spec 里没被
    // 消耗,manager 处理掉障碍后经 send_to_worker 重新投递即可。这里绝不能退化成"超时了也
    // 照发"——那正是 pollForNewRollout 现在的写法,也正是本次要根治的行为。
    if (!pasteReady) {
      await this.reportStartupStall(runtime, handle, outputFile)
      return handle
    }

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
      // m2 实测:--ask-for-approval/--sandbox 这类主命令级选项必须排在 `resume` 子命令**之前**
      // ——放在 `resume <id>` 后面 codex 会报 usage 错、exit=2(原实现把它们放在 `resume <id>`
      // 之后,是未经真机验证的错误猜测,这里按实测结果改正)。不传 --skip-git-repo-check,
      // 理由同 spawn(见文件头"spawn/resume 启动参数"节)。-c 同属主命令级选项,同样放在
      // `resume` 之前。
      const command = `${this.codexBin} --ask-for-approval never --sandbox workspace-write ${CODEX_NETWORK_ACCESS_OPT} resume ${shQuote(prev.session_ref)}`

      // 锁纪律与 spawn 一致:tmux newSession 成功之后才落 meta(running)+注册 runtime;
      // PATH 前置同 spawn(nvm 部署陷阱)。
      await this.tmux.newSession({ name: sessionName, cwd: prevRuntime.workspaceRoot, command, outputFile, env: await this.buildEnv({ CODEX_HOME: prevRuntime.codexHome }) })

      const eventChannel = new CliEventChannel(eventsFilePath({ root: prevRuntime.workspaceRoot }))
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
        eventChannel,
        sessionDiscoveryStatus: prevRuntime.sessionDiscoveryStatus,
        state: 'running',
        // 复用上一化身的 workspace ⇒ 事件文件里已有它留下的通知,基线必须现读现算(见
        // initialStopBaseline 注释)。
        stopBaseline: await this.initialStopBaseline(eventChannel),
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
      this.startEventWatch(runtime, handle)
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
    // 带上 ended_reason:harness 的透明接续要用它给"台账还没追上"的源化身补终态。
    // 上面 `!runtime` 那条分支给不出原因(重启后连落盘 meta 都读不回来),如实缺省。
    if (current === 'exited') throw new WorkerExitedError(h.worker_id, h.seq, runtime.ended_reason)

    // 新一轮开始:把 baseline 推到当前计数,上一轮遗留的 turn-complete 通知不会被误算进新一轮。
    runtime.stopBaseline = stopCount

    if (opts?.raw) {
      const keys = text.split(/\s+/).filter((k) => k.length > 0)
      await this.tmux.sendKeys(runtime.sessionName, keys)
    } else {
      await this.tmux.sendText(runtime.sessionName, text)
    }

    await this.getMutex(h.worker_id).run(async () => {
      if (runtime.state === 'exited') return
      // 暂扣解除:manager 已经出手(raw 敲键清界面,或重投 prompt)。与 transitionState 的
      // meta 写入同一临界区,落盘的 startup_stalled 随之消失(同 cc adapter)。
      runtime.startupStalled = false
      await this.transitionState(runtime, h, 'running')
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
   *
   * `deadReason`:发现会话已经不在了、且不是本进程发起的 kill 时落哪个 ended_reason。缺省
   * `'completed'` 是协议 §6.3 给"干过活之后自然退出"校准的推断;启动期就绪握手那条路径上
   * 这个前提不成立(开工输入一个字符都没投递过),由调用方显式传 `'crashed'`,免得"启动即
   * 死"在台账上落成"成功完成"终态。逐字同 cc adapter,见那里的注释。
   *
   * 七轮 review:`deadReason` 只管住"握手等待期间就死了"这一个时点,而暂扣是持续状态——
   * 标志置位、idle 落盘之后才死的化身,后续任何一次 syncState 仍会吃缺省推断。所以 exited
   * 分支直接看 `runtime.startupStalled`,置位就落 `'crashed'`;标志落盘,重启后由
   * ensureRuntime 复原,判定在新进程里同样成立。优先级 `killed > startupStalled > deadReason`,
   * `sendInput` 成功投递会清标志,"投递过之后才死"不受影响。逐字同 cc adapter。
   */
  private async syncState(
    runtime: Runtime,
    h: IncarnationHandle,
    deadReason: IncarnationEndReason = 'completed',
  ): Promise<{ state: WorkerContractState; stopCount: number }> {
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
      } else if (runtime.startupStalled) {
        // 启动期就绪握手超时的暂扣(见 Runtime.startupStalled):开工输入一个字符都没投递过,
        // turn-complete 计数永远不会涨,落回 running 就是谎报"正在干活"。维持 idle 到 sendInput。
        computed = 'idle'
      } else {
        computed = 'running'
      }

      if (computed !== runtime.state) {
        if (computed === 'exited') {
          // 暂扣态置位 ⇒ 开工输入一个字符都没投递过(sendInput 成功才清标志),缺省的
          // "非 kill ⇒ completed"推断在这里明确不可能成立。见本方法注释里的优先级说明。
          const reason: IncarnationEndReason = runtime.killed ? 'killed' : runtime.startupStalled ? 'crashed' : deadReason
          await this.transitionExited(runtime, h, reason)
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
   *
   * 重建整体在 per-worker 互斥锁内完成(锁内再查一次 map),理由与 cc adapter 完全一致:
   * 不加锁时并发首次触达会各自重建一个 Runtime、各装一个 watcher,败者的 watcher 永不被
   * 摘除,每个轮次边界重复唤醒 manager 一次。详见 cc adapter 的 ensureRuntime 注释。
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
      // 启动期就绪握手超时的暂扣态是"重建无法复原 running/idle 精细区分"的唯一例外:它有
      // 独立落盘的确证,且判错的代价是语义错误而非精度损失(同 cc adapter,见那里的注释)。
      const stalled = alive && meta.startup_stalled === true
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
        state: alive ? (stalled ? 'idle' : 'running') : 'exited',
        ended_reason: alive ? undefined : meta.ended_reason,
        stopBaseline,
        killed: false,
        startupStalled: stalled,
      }
      this.runtimes.set(key, runtime)
      // 重启后重连接管(§13):会话还活着的化身在这里重新装上文件监视。已终态的化身
      // startEventWatch 自己会短路掉。
      this.startEventWatch(runtime, { worker_id: ref.worker_id, seq: ref.seq, impl: 'codex', session_ref: sessionId })
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
        startup_stalled?: boolean
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

  /** `onStateChange` 的 `report.lastText` 在 codex 这边同样刻意不传,理由与 cc 完全一致
   * (输出是 tmux 落的 TUI 字节流,解码后也切不出"哪一段才算 assistant 发言")——见
   * `workers/claude-code/adapter.ts` 的 transitionState 注释;唯一的例外同样是
   * `report.outputTail`(启动期就绪握手超时,每个化身至多付一次,见 reportStartupStall)。 */
  private async transitionState(
    runtime: Runtime,
    h: IncarnationHandle,
    state: WorkerContractState,
    report?: StateChangeReport,
  ): Promise<void> {
    await writeMetaAtomic(runtime.dir, runtime.seq, {
      seq: runtime.seq,
      state,
      session_id: runtime.sessionId,
      session_discovery: runtime.sessionDiscoveryStatus,
      workspace_root: runtime.workspaceRoot,
      // 暂扣态跟着落盘,重启后 ensureRuntime 靠它复原 idle(见 Runtime.startupStalled)。
      // 只在置位时写;老 meta 缺这个字段等价于"没暂扣"。
      ...(runtime.startupStalled ? { startup_stalled: true } : {}),
    })
    runtime.state = state
    try {
      this.deps.onStateChange?.(h, state, report)
    } catch (err) {
      console.error(`[CodexWorkerAdapter] onStateChange callback error for ${h.worker_id}#${h.seq}:`, err)
    }
  }

  /** 就绪握手超时的收场:落 `idle` + 把 output 尾部随唤醒事件交给 manager。语义、取舍与
   * cc adapter 的同名方法逐字一致(零协议改动、不 kill 现场、尾部与 readOutput 共用同一个
   * 解码器),见那里的注释。 */
  private async reportStartupStall(runtime: Runtime, h: IncarnationHandle, outputFile: string): Promise<void> {
    const tail = decodeTerminalOutput(await readOutputTail(outputFile))
    // 等待期间进程可能是**自己死了**(启动即失败:二进制缺失、PATH 不对、pane 里的命令立刻
    // 退出),那不是"停在一个界面上等人",谎报 idle 会让 manager 对着一具尸体发指令。先让既有
    // 的三源判定跑一遍,它会如实落 exited;只有确实还活着才走下面的暂扣汇报。
    //
    // 落 `'crashed'` 而不是 syncState 缺省的 `'completed'`:此刻会话没了只可能是启动即失败,
    // 而开工输入一个字符都没投递过,completed 明确不可能成立(同 cc adapter)。
    if ((await this.syncState(runtime, h, 'crashed')).state === 'exited') return
    await this.getMutex(h.worker_id).run(async () => {
      if (runtime.state === 'exited') return // 判定与提交之间又被并发抢先:终态不可覆盖
      // 先置标志再迁移:这次 meta 写入要带上 startup_stalled,且此后每次 syncState 都必须
      // 维持 idle,否则这条 idle 只是"落了一下"(同 cc adapter,见 Runtime.startupStalled)。
      runtime.startupStalled = true
      await this.transitionState(runtime, h, 'idle', {
        outputTail: describeStartupStall({ impl: 'codex', timeoutMs: this.pasteReadyTimeoutMs, tail }),
      })
    })
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
    // 终态唯一入口:文件监视在这里摘掉,同 cc adapter。
    this.stopEventWatch(runtime)
    try {
      this.deps.onStateChange?.(h, 'exited', { endReason: ended_reason })
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
    if (!runtime.sessionName) return
    if (runtime.state === 'exited') return
    if (runtime.stopEventWatch) return // 幂等:同一 runtime 只装一个
    runtime.stopEventWatch = runtime.eventChannel.watch(() => {
      this.syncState(runtime, h).catch((err) => {
        console.error(`[CodexWorkerAdapter] cli event driven syncState failed for ${h.worker_id}#${h.seq}:`, err)
      })
    })
  }

  private stopEventWatch(runtime: Runtime): void {
    if (!runtime.stopEventWatch) return
    runtime.stopEventWatch()
    runtime.stopEventWatch = undefined
  }

  /** 新建 runtime 时的 stop 基线,见 `workers/claude-code/adapter.ts` 同名方法的注释:
   * 事件文件是 workspace 级的,resume 复用同一 workspace,基线不能一律取 0。 */
  private async initialStopBaseline(channel: CliEventChannel): Promise<number> {
    const events = await channel.readAll()
    return events.filter((e) => e.kind === 'stop').length
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
 * m2 真机实测(codex-cli 0.144.1)校准的信封结构:每行是 `{type, timestamp, payload}`
 * (`timestamp` 挂在信封顶层,不是嵌在 payload 里——之前按 codex-docs 猜测的字段位置是错的,
 * 这里已按实测改正),顶层 type 取值 session_meta / event_msg / response_item / world_state /
 * turn_context 五种(未见 compacted/inter_agent_communication* 之类的推测类型):
 *
 * - `session_meta`:payload 有 `session_id`(权威,比文件名解析出的 uuid 更可靠,见 spawn()
 *   的"session 发现"节)、`cli_version`、`cwd`、`model_provider`、`context_window`、
 *   `originator`——映射为 lifecycle。
 * - `event_msg`:payload 有 `type`(如 `task_started`)、`turn_id`、`started_at`、
 *   `model_context_window`——映射为 lifecycle,摘要取 payload.type。
 * - `response_item`:见 normalizeResponseItem()。
 * - `world_state`:payload 是全量状态快照(`full`/`state`),对"发生了什么"的摘要时间线没有
 *   直接信息量(它是状态,不是事件),跳过——需要全量状态可以直接读原始 rollout 文件
 *   (detail 只保留 response_item/event_msg/session_meta 各自的 payload,不代表 world_state
 *   不存在,只是不进这条摘要时间线)。
 * - `turn_context`:payload 是回合配置(`model`/`effort`/`cwd`/`approval_policy`/`summary`
 *   等),同样不是"发生的事",跳过。
 */
function normalizeRolloutLine(line: string): NormalizedTraceEvent | null {
  let parsed: { type?: unknown; timestamp?: unknown; payload?: unknown }
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const ts = typeof parsed.timestamp === 'string' ? parsed.timestamp : ''
  const payload = parsed.payload as Record<string, unknown> | undefined

  if (parsed.type === 'session_meta') {
    const meta = payload as { session_id?: string; cli_version?: string; cwd?: string } | undefined
    const summary = `session_meta session_id=${meta?.session_id ?? ''} cli_version=${meta?.cli_version ?? ''} cwd=${meta?.cwd ?? ''}`
    return { ts, kind: 'lifecycle', role: 'system', summary: truncate(summary, 200), detail: payload }
  }

  if (parsed.type === 'event_msg') {
    const eventType = typeof payload?.type === 'string' ? payload.type : 'event_msg'
    return { ts, kind: 'lifecycle', role: 'system', summary: eventType, detail: payload }
  }

  if (parsed.type === 'response_item') {
    return normalizeResponseItem(payload, ts)
  }

  // world_state/turn_context(以及其它未在真机实测里见过的顶层 type)跳过,见函数头注释。
  return null
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
