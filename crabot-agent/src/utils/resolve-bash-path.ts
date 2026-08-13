import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { buildChildEnv } from '../core/runtime-env.js'

/**
 * Resolve absolute path or PATH-relative name of bash for tool/bg-shell spawn.
 *
 * Linux/macOS: 直接返回 'bash'（系统自带，通过 PATH 解析）。
 * Windows: 三段式探测——
 *   1. env CRABOT_BASH_PATH（installer 自动写或用户手动设）
 *   2. PATH 中的 bash.exe（where bash）
 *   3. 用 git.exe 路径反推 ..\..\bin\bash.exe（Git for Windows 默认 PATH 选项的常见情况：
 *      git 在 PATH，bash 不在 PATH，但 bin\bash.exe 物理存在）
 *
 * 找不到返回 null——调用方应返回友好错误引导用户安装 Git for Windows / 设 CRABOT_BASH_PATH，
 * 而不是在启动时退出（crabot 是 server，不能因 bash 缺失就拒绝启动）。
 */

export type WhichFn = (name: string) => string | null
export type ExistsFn = (p: string) => boolean

let cached: string | null | undefined = undefined

export function resolveBashPath(): string | null {
  if (cached !== undefined) return cached
  cached = computeBashPathPure(process.platform, process.env, existsSync, defaultWhich)
  return cached
}

/**
 * Pure implementation — all I/O injected. Use this in unit tests; the
 * `resolveBashPath()` wrapper just plumbs real process/fs state in.
 */
export function computeBashPathPure(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  existsSyncFn: ExistsFn,
  whichFn: WhichFn,
): string | null {
  if (platform !== 'win32') return 'bash'

  const envPath = env.CRABOT_BASH_PATH
  if (envPath && existsSyncFn(envPath)) {
    return envPath
  }

  const bashFromPath = whichFn('bash.exe')
  if (bashFromPath && existsSyncFn(bashFromPath)) {
    return bashFromPath
  }

  const gitFromPath = whichFn('git.exe')
  if (gitFromPath) {
    // Git for Windows installs git at <prefix>\cmd\git.exe (PATH-friendly) and
    // bash at <prefix>\bin\bash.exe. Treat git.exe as a file path — the first
    // `..` peels off the filename (→ cmd\), the second climbs to <prefix>.
    // Use path.win32 explicitly so unit tests pass cross-platform.
    const candidate = path.win32.join(gitFromPath, '..', '..', 'bin', 'bash.exe')
    if (existsSyncFn(candidate)) return candidate
  }

  return null
}

function defaultWhich(name: string): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which'
    const out = execFileSync(cmd, [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: buildChildEnv(),
    })
    const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0)
    return first ?? null
  } catch {
    return null
  }
}

/**
 * Friendly error message returned by Bash tool when bash cannot be located.
 * Single source of truth so bash-tool / bg-shell stay in sync.
 */
export const BASH_NOT_FOUND_MESSAGE = `本机未检测到 bash。Windows 用户请安装 Git for Windows (https://git-scm.com/downloads/win)；若已安装但 crabot 找不到，请设置环境变量 CRABOT_BASH_PATH 指向 bash.exe（例如 C:\\Program Files\\Git\\bin\\bash.exe）。`
