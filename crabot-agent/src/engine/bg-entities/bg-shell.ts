/**
 * spawnPersistentShell — detached child_process spawn with disk log + BgEntityRegistry.
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-01-long-running-agent-design.md §6.1
 * Plan: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-2.md  Task 4
 */

import { spawn, execFile, type SpawnOptions, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { getBgEntitiesLogsDir } from '../../core/data-paths.js'
import { resolveBashPath, BASH_NOT_FOUND_MESSAGE } from '../../utils/resolve-bash-path.js'
import type { BgEntityOwner, BgShellRegistryRecord } from './types.js'
import type { BgEntityRegistry } from './registry.js'
import { emitInstantSpan, type BgEntityTraceContext } from './trace.js'

const execFileAsync = promisify(execFile)

/**
 * Spawn `bash -c <command>` with the cross-platform defaults bg-shell needs:
 * detached on POSIX (so the process group survives parent exit; lets us
 * SIGTERM the whole tree by negative pid); attached on Windows (no process
 * groups, and `detached: true` would pop a console window). Caller-supplied
 * `extraOpts` override the defaults via spread order.
 *
 * Throws BASH_NOT_FOUND_MESSAGE when bash cannot be located.
 */
function spawnBash(command: string, extraOpts: SpawnOptions = {}): ChildProcess {
  const bashPath = resolveBashPath()
  if (bashPath === null) {
    throw new Error(BASH_NOT_FOUND_MESSAGE)
  }
  return spawn(bashPath, ['-c', command], {
    detached: process.platform !== 'win32',
    env: process.env,
    ...extraOpts,
  })
}

/** POSIX 单引号转义：把任意字符串安全包成 bash 单引号字面量。 */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * 给命令包一层 exitcode sentinel：用户命令跑完后把退出码写到 `<exitcodeFile>`，再以同样
 * 退出码退出（保持 child.on('exit') 的码不变）。
 *
 * 目的：detached 进程的退出码只有父进程能 reap；agent 重启后新进程不是父进程、拿不到码。
 * 把码落盘后，任何进程（含重启后的新 agent）都能读 sentinel 得到真实成败，而非只能判活/死。
 * sentinel 不存在 = 进程还在跑或被强杀（未走到写盘那步）。
 */
export function wrapCommandWithExitSentinel(command: string, exitcodeFile: string): string {
  return (
    `${command}\n` +
    `__crabot_ec=$?\n` +
    `printf '%s' "$__crabot_ec" > ${shSingleQuote(exitcodeFile)} 2>/dev/null\n` +
    `exit $__crabot_ec`
  )
}

/** 由 shell entity 的 log_file 路径推导其 exitcode sentinel 路径（`.log` → `.exitcode`）。 */
export function exitcodeFileForLog(logFile: string): string {
  return logFile.replace(/\.log$/, '.exitcode')
}

export function stdoutFileForLog(logFile: string): string {
  return logFile.replace(/\.log$/, '.stdout')
}

export function stderrFileForLog(logFile: string): string {
  return logFile.replace(/\.log$/, '.stderr')
}

export function stdoutFifoForLog(logFile: string): string {
  return logFile.replace(/\.log$/, '.stdout.fifo')
}

export function stderrFifoForLog(logFile: string): string {
  return logFile.replace(/\.log$/, '.stderr.fifo')
}

function wrapCommandWithInlineStreamCapture(
  command: string,
  exitcodeFile: string,
  stdoutFile: string,
  stderrFile: string,
  stdoutFifo: string,
  stderrFifo: string,
): string {
  return (
    `rm -f ${shSingleQuote(stdoutFifo)} ${shSingleQuote(stderrFifo)}\n` +
    `mkfifo ${shSingleQuote(stdoutFifo)} ${shSingleQuote(stderrFifo)}\n` +
    `cleanup() {\n` +
    `  rm -f ${shSingleQuote(stdoutFifo)} ${shSingleQuote(stderrFifo)}\n` +
    `}\n` +
    `trap cleanup EXIT\n` +
    `tee -a ${shSingleQuote(stdoutFile)} < ${shSingleQuote(stdoutFifo)} &\n` +
    `__crabot_stdout_tee=$!\n` +
    `tee -a ${shSingleQuote(stderrFile)} >&2 < ${shSingleQuote(stderrFifo)} &\n` +
    `__crabot_stderr_tee=$!\n` +
    `{\n${command}\n` +
    `} > ${shSingleQuote(stdoutFifo)} 2> ${shSingleQuote(stderrFifo)}\n` +
    `__crabot_ec=$?\n` +
    `wait "$__crabot_stdout_tee"\n` +
    `wait "$__crabot_stderr_tee"\n` +
    `printf '%s' "$__crabot_ec" > ${shSingleQuote(exitcodeFile)} 2>/dev/null\n` +
    `exit $__crabot_ec`
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SpawnPersistentShellOpts {
  readonly command: string
  readonly owner: BgEntityOwner
  readonly spawned_by_task_id: string
  readonly registry: BgEntityRegistry
  readonly traceContext?: BgEntityTraceContext
  /** 子进程工作目录。subprocess 启动后锁死；调用方需 snapshot 当前 cwd 传入。 */
  readonly cwd: string
  /**
   * Async exit hook — 进程 exit 后、registry update 完成后调用。
   * 用于推送 push notification（worker 把它接到 enqueueBgNotification）。
   * 抛错只 log 不影响其他逻辑。
   */
  readonly onExit?: (info: {
    entity_id: string
    command: string
    status: 'completed' | 'failed' | 'killed'
    exit_code: number
    runtime_ms: number
    spawned_at: string
  }) => void
}

/**
 * Spawn `command` in a detached bash process, pipe stdout+stderr to a disk
 * log file, register the entity in `registry`, and return immediately.
 *
 * Returns entity_id (format: `shell_<12 hex chars>`).
 */
export async function spawnPersistentShell(opts: SpawnPersistentShellOpts): Promise<string> {
  const entity_id = `shell_${randomBytes(6).toString('hex')}`
  const logsDir = getBgEntitiesLogsDir()

  await fs.promises.mkdir(logsDir, { recursive: true })

  const logFile = path.join(logsDir, `${entity_id}.log`)
  const exitcodeFile = exitcodeFileForLog(logFile)
  const logFd = await fs.promises.open(logFile, 'a')

  // `registeredPromise` resolves after registry.register() succeeds, ensuring
  // that exit/error handlers don't call registry.update() before the record exists.
  // Create it BEFORE spawn so error handler (attached synchronously below) can
  // reference it without TDZ issues.
  let resolveRegistered!: () => void
  const registeredPromise = new Promise<void>((resolve) => {
    resolveRegistered = resolve
  })

  const child = spawnBash(wrapCommandWithExitSentinel(opts.command, exitcodeFile), {
    stdio: ['ignore', logFd.fd, logFd.fd],
    cwd: opts.cwd,
  })

  // CRITICAL: 'error' listener MUST attach BEFORE any await. Node emits spawn
  // failures (ENOENT etc.) asynchronously on next tick. If any await runs
  // between spawn() and on('error'), the error fires unhandled → uncaughtException
  // → main.ts handler kills the whole agent. Past incidents: see fatal.log
  // history of `Error: spawn bash ENOENT` with `onErrorNT` in stack.
  child.on('error', (err) => {
    console.error('[bg-shell] child process error:', err)
    void registeredPromise
      .then(() =>
        opts.registry.update(entity_id, {
          status: 'failed',
          exit_code: -1,
          ended_at: new Date().toISOString(),
        } as Partial<BgShellRegistryRecord>),
      )
      .catch(() => {
        // swallow — nothing we can do
      })
  })

  // Close our copy of the fd — child holds its own reference via stdio inheritance.
  await logFd.close()

  if (!child.pid) {
    throw new Error('[bg-shell] Failed to spawn child process: no pid returned')
  }

  // Attach exit listener — exit only fires for processes that successfully
  // spawned, so the timing isn't as tight as error.
  child.on('exit', (code) => {
    const exitCode = code ?? -1
    const exitedAt = Date.now()
    const runtimeMs = exitedAt - spawnedAtMs
    void registeredPromise
      .then(async () => {
        const status: 'completed' | 'failed' = exitCode === 0 ? 'completed' : 'failed'
        if (opts.traceContext) {
          emitInstantSpan(opts.traceContext, 'bg_entity_exit', {
            entity_id,
            type: 'shell',
            status,
            exit_code: exitCode,
            runtime_ms: runtimeMs,
          }, status)
        }
        await opts.registry.update(entity_id, {
          status,
          exit_code: exitCode,
          ended_at: new Date(exitedAt).toISOString(),
        } as Partial<BgShellRegistryRecord>)
        // 触发 push notification 给 worker（以便下一次 task 启动时通知 agent）
        // status='killed' 由 Kill 工具直接 update，bg-shell 这里只看 exit code
        if (opts.onExit) {
          try {
            opts.onExit({
              entity_id,
              command: opts.command,
              status,
              exit_code: exitCode,
              runtime_ms: runtimeMs,
              spawned_at: now,
            })
          } catch (err) {
            console.error(`[bg-shell] onExit callback failed for ${entity_id}:`, err)
          }
        }
      })
      .catch((err: unknown) => {
        console.error(`[bg-shell] exit registry update failed for ${entity_id}:`, err)
      })
  })

  // Unref so the host process event loop can exit without waiting for the child.
  child.unref()

  const spawnedAtMs = Date.now()
  const processStartedAt = await readProcStartTime(child.pid)
  const now = new Date(spawnedAtMs).toISOString()

  const record: BgShellRegistryRecord = {
    entity_id,
    type: 'shell',
    status: 'running',
    command: opts.command,
    log_file: logFile,
    pid: child.pid,
    // Linux/macOS: detached=true → pgid === pid. Windows: no process groups,
    // pgid is the pid itself (taskkill /T uses the pid as the tree root).
    pgid: child.pid,
    process_started_at: processStartedAt,
    owner: opts.owner,
    spawned_by_task_id: opts.spawned_by_task_id,
    spawned_at: now,
    exit_code: null,
    ended_at: null,
    last_activity_at: now,
  }

  await opts.registry.register(record)

  // Unblock the exit/error handlers — they will now apply any pending update.
  resolveRegistered()

  return entity_id
}

// ---------------------------------------------------------------------------
// runShellWithGrace — 统一前台/后台 shell 执行原语
// ---------------------------------------------------------------------------

export interface RunShellWithGraceOpts {
  readonly command: string
  readonly cwd: string
  readonly owner: BgEntityOwner
  readonly spawned_by_task_id: string
  readonly registry: BgEntityRegistry
  readonly traceContext?: BgEntityTraceContext
  /** 前台宽限期（ms）。期内退出 → inline 返回；超期仍在跑 → 转后台（注册 bgRegistry）。 */
  readonly gracePeriodMs: number
  readonly abortSignal?: AbortSignal
  /**
   * 转后台后子进程退出时回调（worker 接它做唤醒 + 通知）。
   * 仅 promotion 路径触发；宽限期内退出走 inline 返回、不触发。
   */
  readonly onShellExit?: (info: {
    entity_id: string
    command: string
    status: 'completed' | 'failed' | 'killed'
    exit_code: number
    runtime_ms: number
    spawned_at: string
  }) => void
}

export type RunShellWithGraceResult =
  | { kind: 'inline'; exitCode: number; status: 'completed' | 'failed'; stdout: string; stderr: string }
  | { kind: 'background'; entity_id: string }
  | { kind: 'aborted' }
  | { kind: 'spawn_error'; message: string }

async function unlinkQuiet(file: string): Promise<void> {
  try {
    await fs.promises.unlink(file)
  } catch {
    /* 文件不存在 / 已删 — 忽略 */
  }
}

async function readFileQuiet(file: string): Promise<string> {
  try {
    return await fs.promises.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 统一 shell 执行：命令从 spawn 起就 OS 直写磁盘日志（detached + sentinel），前台宽限
 * `gracePeriodMs`。
 * - 宽限期内退出：读完整 stdout/stderr capture inline 同步返回（kind='inline'），删临时文件，**不入 bgRegistry**。
 * - 超过宽限期仍在跑：注册进 bgRegistry（kind='background'），命令**不中断**；其后退出经
 *   onShellExit push 唤醒挂起的 worker。
 * - 期间 abort：kill + 清文件，返回 kind='aborted'。
 *
 * 「spawn 即直写盘」是 re-adopt 的物理前提（父进程死后子进程仍能继续写文件）；故任何命令
 * 都按可转后台对待。registeredPromise 门控解决「转后台瞬间退出但记录尚未注册」的竞态。
 */
export async function runShellWithGrace(opts: RunShellWithGraceOpts): Promise<RunShellWithGraceResult> {
  const entity_id = `shell_${randomBytes(6).toString('hex')}`
  const logsDir = getBgEntitiesLogsDir()
  await fs.promises.mkdir(logsDir, { recursive: true })
  const logFile = path.join(logsDir, `${entity_id}.log`)
  const exitcodeFile = exitcodeFileForLog(logFile)
  const stdoutFile = stdoutFileForLog(logFile)
  const stderrFile = stderrFileForLog(logFile)
  const stdoutFifo = stdoutFifoForLog(logFile)
  const stderrFifo = stderrFifoForLog(logFile)

  const spawnedAtMs = Date.now()
  const now = new Date(spawnedAtMs).toISOString()

  let backgrounded = false
  let resolveRegistered!: () => void
  const registeredPromise = new Promise<void>((resolve) => {
    resolveRegistered = resolve
  })

  type Outcome =
    | { kind: 'exit'; exitCode: number }
    | { kind: 'grace' }
    | { kind: 'abort' }
    | { kind: 'spawnerr'; message: string }
  let resolveRace!: (o: Outcome) => void
  const racePromise = new Promise<Outcome>((resolve) => {
    resolveRace = resolve
  })

  const graceTimer = setTimeout(() => {
    backgrounded = true
    resolveRace({ kind: 'grace' })
  }, opts.gracePeriodMs)
  graceTimer.unref?.()

  const onAbort = (): void => resolveRace({ kind: 'abort' })
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) resolveRace({ kind: 'abort' })
    else opts.abortSignal.addEventListener('abort', onAbort, { once: true })
  }
  const cleanupListeners = (): void => {
    clearTimeout(graceTimer)
    if (opts.abortSignal) opts.abortSignal.removeEventListener('abort', onAbort)
  }

  let logFd: Awaited<ReturnType<typeof fs.promises.open>>
  try {
    logFd = await fs.promises.open(logFile, 'a')
  } catch (err) {
    cleanupListeners()
    return { kind: 'spawn_error', message: err instanceof Error ? err.message : String(err) }
  }

  const child = spawnBash(
    wrapCommandWithInlineStreamCapture(
      opts.command,
      exitcodeFile,
      stdoutFile,
      stderrFile,
      stdoutFifo,
      stderrFifo,
    ),
    {
      stdio: ['ignore', logFd.fd, logFd.fd],
      cwd: opts.cwd,
    },
  )

  // 'error' 必须在任何 await 前挂（spawn 失败异步派发，漏挂 → uncaughtException 杀进程）。
  child.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err)
    if (backgrounded) {
      void registeredPromise
        .then(() =>
          opts.registry.update(entity_id, {
            status: 'failed',
            exit_code: -1,
            ended_at: new Date().toISOString(),
          } as Partial<BgShellRegistryRecord>),
        )
        .catch(() => {})
    } else {
      resolveRace({ kind: 'spawnerr', message })
    }
  })

  await logFd.close()

  child.on('exit', (code) => {
    const exitCode = code ?? -1
    if (!backgrounded) {
      resolveRace({ kind: 'exit', exitCode })
      return
    }
    // promotion 后退出：等注册完成 → 更新 registry + span + onShellExit
    const exitedAt = Date.now()
    const runtimeMs = exitedAt - spawnedAtMs
    void registeredPromise
      .then(async () => {
        try {
          const status: 'completed' | 'failed' = exitCode === 0 ? 'completed' : 'failed'
          if (opts.traceContext) {
            emitInstantSpan(opts.traceContext, 'bg_entity_exit', {
              entity_id,
              type: 'shell',
              status,
              exit_code: exitCode,
              runtime_ms: runtimeMs,
            }, status)
          }
          await opts.registry.update(entity_id, {
            status,
            exit_code: exitCode,
            ended_at: new Date(exitedAt).toISOString(),
          } as Partial<BgShellRegistryRecord>)
          if (opts.onShellExit) {
            try {
              opts.onShellExit({
                entity_id,
                command: opts.command,
                status,
                exit_code: exitCode,
                runtime_ms: runtimeMs,
                spawned_at: now,
              })
            } catch (err) {
              console.error(`[bg-shell] onShellExit callback failed for ${entity_id}:`, err)
            }
          }
        } finally {
          await unlinkQuiet(stdoutFile)
          await unlinkQuiet(stderrFile)
          await unlinkQuiet(stdoutFifo)
          await unlinkQuiet(stderrFifo)
        }
      })
      .catch((err: unknown) => {
        console.error(`[bg-shell] promoted-exit registry update failed for ${entity_id}:`, err)
      })
  })

  child.unref()

  const outcome = await racePromise
  cleanupListeners()

  if (outcome.kind === 'abort') {
    if (child.pid) killShellTree(child.pid)
    await unlinkQuiet(logFile)
    await unlinkQuiet(exitcodeFile)
    await unlinkQuiet(stdoutFile)
    await unlinkQuiet(stderrFile)
    await unlinkQuiet(stdoutFifo)
    await unlinkQuiet(stderrFifo)
    return { kind: 'aborted' }
  }

  if (outcome.kind === 'spawnerr') {
    await unlinkQuiet(logFile)
    await unlinkQuiet(exitcodeFile)
    await unlinkQuiet(stdoutFile)
    await unlinkQuiet(stderrFile)
    await unlinkQuiet(stdoutFifo)
    await unlinkQuiet(stderrFifo)
    return { kind: 'spawn_error', message: outcome.message }
  }

  if (outcome.kind === 'exit') {
    // 宽限期内退出：读分流 stdout/stderr 内联返回，combined log 仅供后台路径使用。
    const stdout = await readFileQuiet(stdoutFile)
    const stderr = await readFileQuiet(stderrFile)
    await unlinkQuiet(logFile)
    await unlinkQuiet(exitcodeFile)
    await unlinkQuiet(stdoutFile)
    await unlinkQuiet(stderrFile)
    await unlinkQuiet(stdoutFifo)
    await unlinkQuiet(stderrFifo)
    const status: 'completed' | 'failed' = outcome.exitCode === 0 ? 'completed' : 'failed'
    return { kind: 'inline', exitCode: outcome.exitCode, status, stdout, stderr }
  }

  // outcome.kind === 'grace'：转后台 → 注册 bgRegistry（命令不中断）。
  if (!child.pid) {
    await unlinkQuiet(logFile)
    await unlinkQuiet(exitcodeFile)
    await unlinkQuiet(stdoutFile)
    await unlinkQuiet(stderrFile)
    await unlinkQuiet(stdoutFifo)
    await unlinkQuiet(stderrFifo)
    return { kind: 'spawn_error', message: 'no pid after grace' }
  }
  const processStartedAt = await readProcStartTime(child.pid)
  const record: BgShellRegistryRecord = {
    entity_id,
    type: 'shell',
    status: 'running',
    command: opts.command,
    log_file: logFile,
    pid: child.pid,
    pgid: child.pid,
    process_started_at: processStartedAt,
    owner: opts.owner,
    spawned_by_task_id: opts.spawned_by_task_id,
    spawned_at: now,
    exit_code: null,
    ended_at: null,
    last_activity_at: now,
  }
  await opts.registry.register(record)
  resolveRegistered()
  return { kind: 'background', entity_id }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Read the actual start time of `pid` via `ps -o lstart=`，返回稳定的进程启动时间（ISO）。
 *
 * **必须强制 `LC_ALL=C`**：否则在中文等 locale 下 `ps -o lstart=` 输出本地化日期
 * （如 `一  6月/29 06:50:35 2026`），`new Date()` 解析失败 → 退化为 wall-clock now。
 * 那会毁掉 isShellAlive 的防-PID-复用校验：spawn 时记 now1、跨重启重读得 now2（相差宕机时长）
 * → |now1-now2| 远超 5s 窗口 → **活进程被误判为死、re-adopt 失效**（生产实测踩到）。
 * 强制 C locale 后 `ps` 输出英文日期（`Mon Jun 29 ...`）可解析，拿到真实稳定的启动时间，跨重启可比对。
 *
 * 仅在 ps 不可用（进程已退出、Windows）等真正失败时才退化为 now——此时 isShellAlive 已先用
 * `kill(pid,0)` 判出死/活，不依赖这里的时间。
 */
export async function readProcStartTime(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C' },
    })
    const trimmed = stdout.trim()
    if (!trimmed) throw new Error('empty ps output')
    const ms = Date.parse(trimmed)
    if (Number.isNaN(ms)) throw new Error(`unparseable ps lstart: ${trimmed}`)
    return new Date(ms).toISOString()
  } catch {
    return new Date().toISOString()
  }
}

/**
 * Cross-platform shell process tree termination.
 *
 * POSIX: SIGTERM → 3s grace → SIGKILL the process group (negative pid).
 * Windows: `taskkill /F /T /PID <pid>` — single forceful call kills the whole
 *   child tree (no SIGTERM/SIGKILL distinction; no process groups on Windows).
 *
 * Both forms swallow "already dead" errors silently.
 */
export function killShellTree(pid: number): void {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], () => {
      // Errors (process already exited, access denied for system-level pids)
      // are non-actionable here — the registry update already marks status=killed.
    })
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    /* already dead */
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* already dead */
    }
  }, 3000).unref()
}
