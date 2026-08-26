import { execFile, spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { buildChildEnv } from '../core/runtime-env'

export interface HostProcessLimits {
  readonly timeoutMs: number
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly killGraceMs?: number
}

/**
 * 本地宿主进程唯一的启动描述。将来 sandbox 只能在这里包装 argv/cwd/env，工具调用方
 * 不应再自行拼 shell 或管理进程树。
 */
export interface HostProcessLaunchSpec {
  readonly argv: readonly [string, ...string[]]
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly stdio?: StdioOptions
  readonly detached?: boolean
  readonly policy?: Readonly<Record<string, never>>
}

export interface HostProcessRunSpec extends HostProcessLaunchSpec {
  readonly stdin?: string
  readonly limits: HostProcessLimits
  readonly abortSignal?: AbortSignal
  /** 供流式消费者使用；不会改变有限 collector 的超限判断。 */
  readonly onStdoutChunk?: (chunk: Buffer) => void
  readonly onStderrChunk?: (chunk: Buffer) => void
  /** Glob 等调用只消费 chunk，不把所有 stdout 再存一份。 */
  readonly captureStdout?: boolean
}

export type HostProcessOutcomeKind = 'exit' | 'spawn_error' | 'aborted' | 'timed_out' | 'output_limit'

export interface HostProcessOutcome {
  readonly kind: HostProcessOutcomeKind
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly message?: string
}

const DEFAULT_KILL_GRACE_MS = 500

/**
 * Start a command in its own POSIX process group. A no-op error listener is installed before
 * returning so a later caller failure can never become an Agent-level uncaught `error` event.
 */
export function launchHostProcess(spec: HostProcessLaunchSpec): ChildProcess {
  const [file, ...args] = spec.argv
  const child = spawn(file, args, {
    cwd: spec.cwd,
    env: spec.env ?? buildChildEnv(),
    stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe'],
    detached: spec.detached ?? process.platform !== 'win32',
  })
  child.on('error', () => {
    // runHostProcess / the owning background entity adds its own settlement handler.
  })
  return child
}

/** Terminate the whole controlled process tree. Calling this repeatedly is harmless. */
export function terminateHostProcessTree(pid: number, graceMs = DEFAULT_KILL_GRACE_MS): void {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { env: buildChildEnv() }, () => {
      // A process can race us to exit; there is no further local recovery action.
    })
    return
  }

  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already reaped.
    }
  }, graceMs).unref()
}

function isProcessTreeAlive(pid: number): boolean {
  if (process.platform === 'win32') return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForExit(isAlive: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isAlive() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

async function waitForProcessTreeExit(pid: number, timeoutMs: number): Promise<void> {
  if (process.platform !== 'win32') await waitForExit(() => isProcessTreeAlive(pid), timeoutMs)
}

function isDirectProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Terminate a controlled tree and wait until its process group has gone away. */
async function terminateHostProcessTreeAndWait(pid: number, graceMs: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { env: buildChildEnv() }, () => resolve())
    })
    return
  }

  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return
  }
  await waitForProcessTreeExit(pid, graceMs)
  if (!isProcessTreeAlive(pid)) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    return
  }
  await waitForProcessTreeExit(pid, graceMs)
}

async function terminateDirectProcessAndWait(pid: number, graceMs: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { env: buildChildEnv() }, () => resolve())
    })
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  await waitForExit(() => isDirectProcessAlive(pid), graceMs)
  if (!isDirectProcessAlive(pid)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return
  }
  await waitForExit(() => isDirectProcessAlive(pid), graceMs)
}

interface BoundedCollector {
  readonly push: (chunk: Buffer) => boolean
  readonly finish: () => string
  readonly bytes: () => number
}

function createCollector(limit: number, capture: boolean): BoundedCollector {
  const chunks: Buffer[] = []
  let retained = 0
  let bytes = 0

  return {
    push(chunk): boolean {
      bytes += chunk.length
      if (!capture) return bytes <= limit
      chunks.push(chunk)
      retained += chunk.length
      while (retained > limit && chunks.length > 0) {
        const excess = retained - limit
        const first = chunks[0]
        if (first.length <= excess) {
          chunks.shift()
          retained -= first.length
        } else {
          chunks[0] = first.subarray(excess)
          retained -= excess
        }
      }
      return bytes <= limit
    },
    finish(): string {
      if (!capture || retained === 0) return ''
      const output = Buffer.concat(chunks, retained)
      let start = 0
      while (start < output.length && (output[start] & 0xc0) === 0x80) start++
      return output.subarray(start).toString('utf8')
    },
    bytes(): number {
      return bytes
    },
  }
}

/**
 * Run a short-lived controlled process. Spawn failure is a structured outcome; normal non-zero
 * exits remain `exit`, so each operation retains its own exit-code contract.
 */
export function runHostProcess(spec: HostProcessRunSpec): Promise<HostProcessOutcome> {
  if (spec.abortSignal?.aborted) {
    return Promise.resolve({
      kind: 'aborted', exitCode: null, signal: null, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
    })
  }

  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = launchHostProcess({ ...spec, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({
        kind: 'spawn_error', exitCode: null, signal: null, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const stdout = createCollector(spec.limits.stdoutBytes, spec.captureStdout !== false)
    const stderr = createCollector(spec.limits.stderrBytes, true)
    const killGraceMs = spec.limits.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    let terminal: Exclude<HostProcessOutcomeKind, 'exit' | 'spawn_error'> | undefined
    let termination: Promise<void> | undefined
    let settled = false

    const requestTermination = (reason: Exclude<HostProcessOutcomeKind, 'exit' | 'spawn_error'>): void => {
      if (terminal !== undefined) return
      terminal = reason
      if (child.pid !== undefined) {
        termination = spec.detached === false
          ? terminateDirectProcessAndWait(child.pid, killGraceMs)
          : terminateHostProcessTreeAndWait(child.pid, killGraceMs)
      }
    }

    const onAbort = (): void => requestTermination('aborted')
    if (spec.abortSignal) spec.abortSignal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => requestTermination('timed_out'), spec.limits.timeoutMs)
    timer.unref?.()

    const finish = (outcome: HostProcessOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (spec.abortSignal) spec.abortSignal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      spec.onStdoutChunk?.(chunk)
      if (!stdout.push(chunk)) requestTermination('output_limit')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      spec.onStderrChunk?.(chunk)
      if (!stderr.push(chunk)) requestTermination('output_limit')
    })
    child.on('error', (error) => {
      finish({
        kind: 'spawn_error', exitCode: null, signal: null, stdout: stdout.finish(), stderr: stderr.finish(),
        stdoutBytes: stdout.bytes(), stderrBytes: stderr.bytes(),
        message: error instanceof Error ? error.message : String(error),
      })
    })
    child.on('close', (exitCode, signal) => {
      void (async () => {
        await termination
        finish({
          kind: terminal ?? 'exit', exitCode, signal,
          stdout: stdout.finish(), stderr: stderr.finish(), stdoutBytes: stdout.bytes(), stderrBytes: stderr.bytes(),
        })
      })()
    })

    if (spec.stdin !== undefined) {
      child.stdin?.on('error', () => {
        // EPIPE means the child declined the request. Its close result determines the tool error.
      })
      child.stdin?.end(spec.stdin)
    } else {
      child.stdin?.end()
    }
  })
}
