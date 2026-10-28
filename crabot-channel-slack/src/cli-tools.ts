import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fork, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { proxyManager, type ProxyConfig } from 'crabot-shared'
const execute = promisify(execFile)
export const CLI_VERSION = '4.11.0'
const RELEASE = `https://github.com/slackapi/slack-cli/releases/download/v${CLI_VERSION}/`
export const CLI_ASSETS = {
  'darwin-arm64': { file: 'slack_cli_4.11.0_macOS_arm64.tar.gz', sha256: 'd66049692424b1e91014df792b38000709c5361429e3f17f53e64720d8aeabbc' },
  'darwin-x64': { file: 'slack_cli_4.11.0_macOS_amd64.tar.gz', sha256: '9a7520bbba68f9943e010e3e1cb7375fab0b4935b4edc5aa4bcd87cd0402e1de' },
  'linux-x64': { file: 'slack_cli_4.11.0_linux_amd64.tar.gz', sha256: 'faebd25d8d27513b95aaabbfda3b73f80c7059c01a53bde65dcf2e9ba6f89afb' },
  'win32-x64': { file: 'slack_cli_4.11.0_windows_64-bit.zip', sha256: '3eb58cc9cd7210a1ca0ad6a0e701f2ef3c3c4f92f58e2ee5e52b21f96ab26e66' },
} as const
export async function privateDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') {
    const { stdout } = await execute('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5000 })
    const sid = stdout.match(/S-1-5-[0-9-]+/)?.[0]
    if (!sid) throw new Error('无法确认 Windows 用户权限')
    await execute('icacls', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true, timeout: 5000 })
  } else await fs.chmod(dir, 0o700)
}
export async function writePrivate(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
  await fs.rename(tmp, file)
}
export function cliEnvironment(config?: ProxyConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'LANG', 'LC_ALL', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const proxy = config ?? proxyManager.getConfig()
  if (proxy.mode !== 'system') {
    for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[key]
    if (proxy.mode === 'custom' && proxy.custom_url) env.HTTPS_PROXY = env.HTTP_PROXY = proxy.custom_url
  }
  env.SLACK_DISABLE_TELEMETRY = 'true'
  return env
}
export interface CliJob {
  result: Promise<{ code: number | null; output: string }>
  stop(): Promise<void>
}
export function startCli(executable: string, args: string[], cwd: string, proxy?: ProxyConfig): CliJob {
  const child = fork(fileURLToPath(new URL('./cli-supervisor.cjs', import.meta.url)), [cwd], { cwd, env: cliEnvironment(proxy), execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
  let resultValue: { code: number | null; output: string } | undefined
  let failed = false
  const result = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    child.on('message', (value: { type: string; code?: number; output?: string }) => {
      if (value.type === 'exit') resultValue = { code: value.code ?? null, output: value.output ?? '' }
      if (value.type === 'failed') failed = true
    })
    child.once('error', () => reject(new Error('无法启动 Slack CLI')))
    child.once('exit', code => {
      if (code !== 0 || failed || !resultValue) reject(new Error('Slack CLI 未完成或未能确认进程退出'))
      else resolve(resultValue)
    })
  })
  // The caller may wait for a handoff before awaiting CLI exit.
  void result.catch(() => {})
  child.send({ type: 'start', executable, args, cwd })
  return { result, async stop() {
    if (child.connected) child.send({ type: 'stop' })
    await result.catch(error => { if (child.exitCode !== 0) throw error })
  } }
}
export async function ensureCli(dataDir: string, signal: AbortSignal): Promise<string> {
  const target = `${process.platform}-${process.arch}` as keyof typeof CLI_ASSETS
  const asset = CLI_ASSETS[target]
  if (!asset) throw new Error('此系统暂不支持 Slack 本地授权')
  const root = path.join(dataDir, 'tools', 'slack-cli', CLI_VERSION, target)
  const executable = path.join(root, 'bin', process.platform === 'win32' ? 'slack.exe' : 'slack')
  // Binary integrity is checked on reuse, not just its existence.
  const receipt = path.join(root, 'binary.sha256')
  try {
    const expected = await fs.readFile(receipt, 'utf8')
    if (createHash('sha256').update(await fs.readFile(executable)).digest('hex') === expected) return executable
  } catch { /* install from verified official archive */ }
  const stage = `${root}.${randomUUID()}`
  await privateDirectory(stage)
  try {
    const response = await fetch(RELEASE + asset.file, { signal })
    if (!response.ok) throw new Error('Slack CLI 下载失败，请检查当前网络/代理后重试')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Slack CLI 官方载荷校验失败，已拒绝执行')
    const archive = path.join(stage, asset.file)
    await fs.writeFile(archive, bytes, { flag: 'wx', mode: 0o600 })
    await execute('tar', ['-xf', archive, '-C', stage], { signal, windowsHide: true })
    const binary = path.join(stage, 'bin', process.platform === 'win32' ? 'slack.exe' : 'slack')
    const digest = createHash('sha256').update(await fs.readFile(binary)).digest('hex')
    if (process.platform !== 'win32') await fs.chmod(binary, 0o700)
    await fs.writeFile(path.join(stage, 'binary.sha256'), digest, { flag: 'wx', mode: 0o600 })
    await fs.unlink(archive)
    await fs.mkdir(path.dirname(root), { recursive: true })
    await fs.rm(root, { recursive: true, force: true })
    await fs.rename(stage, root)
    return executable
  } finally { await fs.rm(stage, { recursive: true, force: true }) }
}

// Recovery trusts a live command line containing this private session path, never a stale PID alone.
export async function recoverSession(root: string): Promise<void> {
  const project = path.join(root, 'project')
  let state: { cli_pid?: number; supervisor_pid?: number } = {}
  let hook: { pid?: number } = {}
  try { state = JSON.parse(await fs.readFile(path.join(project, 'process-state.json'), 'utf8')) } catch { /* no invocation was started */ }
  try { hook = JSON.parse(await fs.readFile(path.join(root, 'hook-state.json'), 'utf8')) } catch { /* no hook was started */ }
  const candidates = [{ pid: state.supervisor_pid, marker: project, group: false }, { pid: state.cli_pid, marker: root, group: true }, { pid: hook.pid, marker: path.join(project, 'hook.mjs'), group: false }]
  async function owned(candidate: typeof candidates[number]): Promise<{ group: number } | undefined> {
    if (!Number.isInteger(candidate.pid) || candidate.pid! <= 1) return
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId = ${candidate.pid}" | Select-Object CommandLine | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 5000 })
        const info = JSON.parse(stdout || 'null')
        if (typeof info?.CommandLine === 'string' && info.CommandLine.includes(candidate.marker)) return { group: candidate.pid! }
      } else {
        const { stdout } = await execute('ps', ['-p', String(candidate.pid), '-o', 'pgid=', '-o', 'command='])
        const match = stdout.trim().match(/^(\d+)\s+([\s\S]*)$/)
        if (match?.[2].includes(candidate.marker)) return { group: Number(match[1]) }
      }
    } catch (error) {
      // ps returns 1 for an absent PID. Tool failure must not become permission to kill.
      if (process.platform !== 'win32' && (error as { code?: number }).code === 1) return
      throw new Error('无法核验遗留授权进程，请检查系统工具')
    }
  }
  await fs.writeFile(path.join(project, 'stop'), '', { mode: 0o600 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error })
  for (const candidate of candidates) {
    const view = await owned(candidate)
    if (view && process.platform !== 'win32') {
      try { process.kill(candidate.group && view.group === candidate.pid ? -candidate.pid! : candidate.pid!, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
  }
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (!(await Promise.all(candidates.map(owned))).some(Boolean)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  for (const candidate of candidates) {
    const view = await owned(candidate)
    if (!view) continue
    if (process.platform === 'win32') await execute('taskkill', ['/PID', String(candidate.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 })
    else { try { process.kill(candidate.group && view.group === candidate.pid ? -candidate.pid! : candidate.pid!, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
  }
  const forceDeadline = Date.now() + 5000
  while (Date.now() < forceDeadline) {
    if (!(await Promise.all(candidates.map(owned))).some(Boolean)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('遗留 Slack 授权进程尚未退出，请核对后重试')
}
