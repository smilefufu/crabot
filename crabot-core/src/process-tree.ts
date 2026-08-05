import { execFile } from 'node:child_process'

export interface TerminateProcessTreeOptions {
  gracefulTimeoutMs: number
  forceImmediately?: boolean
  pollIntervalMs?: number
  /** MM-owned module port; Windows uses its listener PID when the launcher is gone. */
  modulePort?: number
  /** Crash cleanup fails closed when neither launcher nor listener can be identified. */
  requireOwnedProcess?: boolean
  /** Live observer for the managed launcher; Windows must not trust its PID after exit. */
  isRootPidExited?: () => boolean
}

interface WindowsOwnership {
  RootPid: number | null
  ListenerPids: number | number[] | null
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** POSIX probes the detached process group; Windows can synchronously probe only the root. */
export function isProcessTreeAlive(rootPid: number): boolean {
  if (process.platform === 'win32') return isPidAlive(rootPid)
  try {
    process.kill(-rootPid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitUntilPosixTreeGone(
  rootPid: number,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessTreeAlive(rootPid)) return true
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  return !isProcessTreeAlive(rootPid)
}

function signalPosixTree(rootPid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-rootPid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function terminatePosixTree(
  rootPid: number,
  timeoutMs: number,
  pollIntervalMs: number,
  forceImmediately: boolean,
): Promise<void> {
  if (!isProcessTreeAlive(rootPid)) return
  signalPosixTree(rootPid, forceImmediately ? 'SIGKILL' : 'SIGTERM')
  if (!forceImmediately && !await waitUntilPosixTreeGone(rootPid, timeoutMs, pollIntervalMs)) {
    signalPosixTree(rootPid, 'SIGKILL')
  }
  if (!await waitUntilPosixTreeGone(rootPid, Math.max(timeoutMs, 1000), pollIntervalMs)) {
    throw new Error(`Process tree ${rootPid} did not exit`)
  }
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

async function queryWindowsOwnership(
  rootPid: number,
  modulePort: number | undefined,
  isRootPidExited: () => boolean,
): Promise<{ rootPid?: number; listenerPids: number[] }> {
  const rootPidExitedBeforeQuery = isRootPidExited()
  const rootQuery = rootPidExitedBeforeQuery
    ? `$rootValue = $null; `
    : `$root = Get-CimInstance Win32_Process -Filter \"ProcessId = ${rootPid}\"; `
      + `$rootValue = if ($null -eq $root) { $null } else { [int]$root.ProcessId }; `
  const listenerQuery = modulePort === undefined
    ? ''
    : `$listeners = Get-NetTCPConnection -State Listen -LocalPort ${modulePort} -ErrorAction SilentlyContinue; `
      + `$listenerPids = @($listeners | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique); `
  const script = "$ErrorActionPreference='Stop'; "
    + rootQuery
    + `$listenerPids = @(); `
    + listenerQuery
    + `[pscustomobject]@{ RootPid = $rootValue; ListenerPids = @($listenerPids) } `
    + `| ConvertTo-Json -Compress -Depth 3`
  const output = await execFileText('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ])
  const decoded = JSON.parse(output.trim()) as WindowsOwnership
  const rawListeners = decoded.ListenerPids === null
    ? []
    : Array.isArray(decoded.ListenerPids) ? decoded.ListenerPids : [decoded.ListenerPids]
  if (!rootPidExitedBeforeQuery && isRootPidExited()) {
    // The root observation became stale while PowerShell was running. Re-query
    // listener ownership without the root before confirming or targeting anything.
    return queryWindowsOwnership(rootPid, modulePort, isRootPidExited)
  }
  return {
    ...(rootPidExitedBeforeQuery || decoded.RootPid === null ? {} : { rootPid: decoded.RootPid }),
    listenerPids: Array.from(new Set(rawListeners)),
  }
}

function resolveWindowsTarget(
  ownership: { rootPid?: number; listenerPids: number[] },
): number | undefined {
  if (ownership.rootPid !== undefined) return ownership.rootPid
  if (ownership.listenerPids.length > 1) {
    throw new Error(`Ambiguous Windows module listener ownership: ${ownership.listenerPids.join(', ')}`)
  }
  return ownership.listenerPids[0]
}

async function waitUntilWindowsTargetGone(
  rootPid: number,
  modulePort: number | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
  isRootPidExited: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (resolveWindowsTarget(
      await queryWindowsOwnership(rootPid, modulePort, isRootPidExited),
    ) === undefined) return true
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  return resolveWindowsTarget(
    await queryWindowsOwnership(rootPid, modulePort, isRootPidExited),
  ) === undefined
}

async function taskkillWindowsTarget(pid: number, force: boolean): Promise<void> {
  await execFileText('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])])
    .catch(() => undefined)
}

async function forceWindowsTargetGone(
  rootPid: number,
  modulePort: number | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
  isRootPidExited: () => boolean,
): Promise<void> {
  const deadline = Date.now() + Math.max(timeoutMs, 1000)
  while (Date.now() < deadline) {
    const target = resolveWindowsTarget(
      await queryWindowsOwnership(rootPid, modulePort, isRootPidExited),
    )
    if (target === undefined) return
    await taskkillWindowsTarget(target, true)
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  if (resolveWindowsTarget(
    await queryWindowsOwnership(rootPid, modulePort, isRootPidExited),
  ) !== undefined) {
    throw new Error(`Process tree ${rootPid} did not exit`)
  }
}

async function terminateWindowsTree(
  rootPid: number,
  modulePort: number | undefined,
  timeoutMs: number,
  pollIntervalMs: number,
  forceImmediately: boolean,
  requireOwnedProcess: boolean,
  isRootPidExited: () => boolean,
): Promise<void> {
  const initialTarget = resolveWindowsTarget(
    await queryWindowsOwnership(rootPid, modulePort, isRootPidExited),
  )
  if (initialTarget === undefined) {
    if (requireOwnedProcess) {
      throw new Error(`Cannot confirm Windows process ownership for tree ${rootPid}`)
    }
    return
  }

  if (forceImmediately) {
    await forceWindowsTargetGone(rootPid, modulePort, timeoutMs, pollIntervalMs, isRootPidExited)
    return
  }

  await taskkillWindowsTarget(initialTarget, false)
  if (await waitUntilWindowsTargetGone(
    rootPid,
    modulePort,
    timeoutMs,
    pollIntervalMs,
    isRootPidExited,
  )) return
  await forceWindowsTargetGone(rootPid, modulePort, timeoutMs, pollIntervalMs, isRootPidExited)
}

export async function waitForProcessTreeExit(
  rootPid: number,
  timeoutMs: number,
  pollIntervalMs = 25,
  modulePort?: number,
  isRootPidExited: () => boolean = () => false,
): Promise<boolean> {
  if (process.platform === 'win32') {
    return waitUntilWindowsTargetGone(
      rootPid,
      modulePort,
      timeoutMs,
      Math.max(pollIntervalMs, 100),
      isRootPidExited,
    )
  }
  return waitUntilPosixTreeGone(rootPid, timeoutMs, pollIntervalMs)
}

/**
 * Terminates and confirms the owned process boundary. Windows targets the
 * live root first and falls back to one MM-allocated listener only after the
 * launcher is gone.
 */
export async function terminateProcessTree(
  rootPid: number,
  options: TerminateProcessTreeOptions,
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 25
  const timeoutMs = Math.max(0, options.gracefulTimeoutMs)
  const forceImmediately = options.forceImmediately === true
  const isRootPidExited = options.isRootPidExited ?? (() => false)

  if (process.platform === 'win32') {
    await terminateWindowsTree(
      rootPid,
      options.modulePort,
      timeoutMs,
      Math.max(pollIntervalMs, 100),
      forceImmediately,
      options.requireOwnedProcess === true,
      isRootPidExited,
    )
  } else {
    await terminatePosixTree(rootPid, timeoutMs, pollIntervalMs, forceImmediately)
  }
}
