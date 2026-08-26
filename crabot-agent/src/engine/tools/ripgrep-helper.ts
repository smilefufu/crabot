/**
 * ripgrep adapter — Grep / Glob 工具共用的 rg 子进程封装。
 *
 * 历史原因：旧 grep-tool 用 `walkDirectory + files.map(searchFile)` 纯 JS 同步
 * 读所有文件到内存，在大仓 grep 一次就能爆 4GB+ 堆。对照 claude-code 的
 * GrepTool 实现（spawn rg + 流式 stdout），这里也走原生二进制方案：rg
 * 进程内做匹配，crabot agent 堆只承受输出行。
 *
 * 二进制由 @vscode/ripgrep 提供，npm install 时自动下载平台对应的 rg。
 */

import { homedir } from 'node:os'
import { relative, isAbsolute } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { shouldScanProtectedDirs } from './fda-check'
import { runHostProcess } from '../host-process'

export interface RipgrepResult {
  /** rg 进程 stdout 的前缀（已按 maxBytes 截断）。 */
  stdout: string
  /** rg 进程的 stderr 全文。 */
  stderr: string
  /** 是否因 maxBytes 提前 kill。 */
  truncated: boolean
  /** 是否因墙钟超时被 kill（区别于 maxBytes 截断，调用方据此提示"缩小范围"）。 */
  timedOut: boolean
  /** 进程退出码。rg 约定：0=找到匹配，1=没匹配，2=错误，128+=信号。 */
  exitCode: number
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024 // 16MB stdout 上限——再多上层也消化不了
// 墙钟超时上限。rg 卡在巨型目录遍历（网络盘 / FUSE / 海量缓存）或 macOS TCC 权限
// 弹窗时会无限挂起，把 agent 主循环一起拖死（实测挂过 144 分钟）。源码工程的合理
// glob/grep 远用不到 60s，超出即 kill 返回 partial，让上层提示缩小范围。
const DEFAULT_TIMEOUT_MS = 60_000

function createStdoutPrefixCollector(maxBytes: number): { push(chunk: Buffer): void; finish(): string } {
  const chunks: Buffer[] = []
  let retained = 0
  return {
    push(chunk): void {
      if (retained >= maxBytes) return
      const allowed = Math.min(chunk.length, maxBytes - retained)
      chunks.push(chunk.subarray(0, allowed))
      retained += allowed
    },
    finish(): string {
      return Buffer.concat(chunks, retained).toString('utf8')
    },
  }
}

/**
 * 强制注入到每次 rg 调用的硬限制。这些 flag 不可让上层覆盖：
 *
 * - `--max-filesize=10M`：跳过单个 > 10MB 的文件。
 *   2026-06-07 panic 复盘：用户机器在 crabot agent 主进程内同时 spawn 7+ 个 rg
 *   子进程，单个 rg RSS 飙到 17.5 GB（mmap 巨大日志/数据文件），瞬时占 50+ GB
 *   把 32 GB 机器逼到 kernel watchdog panic。源码工程的合理 grep 不需要扫
 *   10MB+ 的单文件——通常那种文件是 sqlite db / 历史日志 / 模型 weights /
 *   数据 CSV，对源码任务无意义但内存代价巨大。
 * - `--threads=1`：默认 rg 用所有物理核并行。改成单线程后，单 rg 进程内存
 *   占用降一个数量级（不需要每核一套 ranker / decompressor / mmap window），
 *   而且单次 grep 在 SSD 上 IO bound > CPU bound，加线程也快不了多少。
 *
 * 顺序：硬限制 flag 放最前面，让用户传入的 args 不能覆盖（rg 多次声明同 flag
 * 时后写覆盖前写，所以这里放前面意味着上层"加固"是允许的，"放宽"不允许）。
 */
const FORCED_LIMITS: ReadonlyArray<string> = [
  '--max-filesize=10M',
  '--threads=1',
]

/**
 * 跑 ripgrep，把 stdout 累到内存上限就 kill。stderr 总是收完（小）。
 *
 * - args: 不要带二进制路径，纯参数
 * - cwd: 不传则 rg 用当前进程 cwd
 * - signal: 可选外部 abort
 *
 * 退出码语义见 RipgrepResult。调用方自己根据 exitCode 决定怎么对外返回——
 * 比如 grep 工具 exitCode=1 应该映射成 "No matches found"，而 exitCode=2
 * 才是真正错误（invalid regex / path 不存在等）。
 */
export function runRipgrep(
  args: ReadonlyArray<string>,
  opts: {
    cwd?: string
    maxBytes?: number
    timeoutMs?: number
    signal?: AbortSignal
    /** A helper-owned rg must stay in the helper group so outer termination reaps both. */
    detached?: boolean
  } = {},
): Promise<RipgrepResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stdoutPrefix = createStdoutPrefixCollector(maxBytes)

  return runHostProcess({
    argv: [rgPath, ...FORCED_LIMITS, ...args],
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.signal ? { abortSignal: opts.signal } : {}),
    ...(opts.detached === false ? { detached: false } : {}),
    captureStdout: false,
    onStdoutChunk: (chunk) => stdoutPrefix.push(chunk),
    limits: { timeoutMs, stdoutBytes: maxBytes, stderrBytes: 64 * 1024 },
  }).then((outcome) => {
    if (outcome.kind === 'spawn_error') throw new Error(`ripgrep spawn failed: ${outcome.message ?? 'unknown error'}`)
    const signalCode = outcome.signal ? 128 + (signalNumber(outcome.signal) ?? 0) : 0
    return {
      stdout: stdoutPrefix.finish(),
      stderr: outcome.stderr,
      truncated: outcome.kind === 'output_limit' || outcome.kind === 'aborted' || outcome.kind === 'timed_out',
      timedOut: outcome.kind === 'timed_out',
      exitCode: outcome.exitCode ?? (outcome.kind === 'aborted' ? 130 : signalCode),
    }
  })
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  // 仅为 close 回调里映射用，覆盖常见值即可
  const map: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }
  return map[signal as string]
}

/**
 * ripgrep 默认就跳 .git 等 hidden VCS 目录，这里额外排掉：
 * - 非 hidden 的"基本不想搜"目录（node_modules / dist / .cache 等）
 * - **巨型诊断文件**：crabot-agent 启动带 --heapsnapshot-near-heap-limit=3，
 *   OOM 时自动 dump 几个 3-4 GB 的 .heapsnapshot 到 cwd。配合 `--no-ignore`
 *   时（grep-tool 默认开），rg 会扫到这些文件并 mmap，2026-06-07 panic 现场
 *   单个 rg RSS 17.5 GB 就是这么来的。无论用户传不传 .gitignore，强制跳过。
 */
export const DEFAULT_EXCLUDE_GLOBS: ReadonlyArray<string> = [
  '!node_modules',
  '!.git',
  '!.hg',
  '!.svn',
  '!dist',
  '!.next',
  '!.cache',
  '!*.heapsnapshot',
]

/**
 * macOS 受保护目录排除。agent 工作目录默认是家目录（~），rg 带 `--hidden --no-ignore`
 * 会爬进 `~/Library/Containers` 等别的 App 数据容器，以及 `~/Desktop`、`~/Documents`、
 * `~/Downloads` 等 macOS TCC「文件与文件夹」保护目录 → 触发 TCC 弹窗（卡死）/ EPERM
 * （退出码 2）。这些目录名都要跳过。
 *
 * 只在 macOS 加（其它系统没这些目录名）。`!Name` 按名字排除任意深度同名目录——所以
 * 这份列表**仅在搜索根是家目录或其祖先时**才注入（见 getProtectedExcludeGlobs），
 * 避免 set_cwd 到具体项目后误跳项目里叫 Documents/Downloads 的业务目录。
 */
export const MACOS_PROTECTED_EXCLUDE_GLOBS: ReadonlyArray<string> = [
  '!Library',
  '!.Trash',
  '!Desktop',
  '!Documents',
  '!Downloads',
  '!Movies',
  '!Music',
  '!Pictures',
]

/** searchRoot 是否就是家目录、或家目录的祖先（如 /Users、/）——只有这时扫描才会
 *  遍历到家目录下的 TCC 保护目录，需要注入排除。relative 处理了 '/' 等边界。 */
function isHomeOrAncestor(searchRoot: string): boolean {
  const rel = relative(searchRoot, homedir())
  // rel === '' → 相等；非 '..' 开头且非绝对 → searchRoot 是 home 的祖先
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 返回应注入的「受保护目录」排除 glob 列表。
 *
 * - 非 darwin：恒返回 []（没有这些目录名，无需排除）。
 * - darwin 且 `scanProtected`（= CRABOT_ENABLE_FDA 意图开启 **且** 真持有 FDA）：返回 []，
 *   即放开扫描 ~/Library 等。
 * - darwin、未持 FDA、且搜索根是家目录或其祖先：返回 MACOS_PROTECTED_EXCLUDE_GLOBS。
 * - darwin、未持 FDA、但搜索根是某个具体项目（TCC 目录是兄弟而非子节点）：返回 []，
 *   不注入排除，避免误跳项目里的同名目录。
 *
 * scanProtected / platform 参数可注入仅为单测；运行时调用方只传 searchRoot。
 */
export function getProtectedExcludeGlobs(
  searchRoot: string,
  scanProtected: boolean = shouldScanProtectedDirs(),
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<string> {
  if (platform !== 'darwin') return []
  if (scanProtected) return []
  return isHomeOrAncestor(searchRoot) ? MACOS_PROTECTED_EXCLUDE_GLOBS : []
}
