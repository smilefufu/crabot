/**
 * TmuxDriver — 驱动 tmux 会话的最小封装,供外部 CLI worker adapter(claude-code/codex)复用。
 *
 * newSession 把 `new-session` 与 `pipe-pane` 合并进同一次 tmux 调用(用 `;` 分隔的批处理),
 * 而不是发两条独立的进程调用。原因:pipe-pane 只捕获挂上之后的新输出,不补历史;pane 内命令
 * 一旦创建就可能立即产生输出(如 `echo`),两次独立调用之间的进程启动开销就足以让这段输出在
 * pipe-pane 挂上前漏掉。批处理让 tmux server 在同一事务内背靠背执行两条子命令,消除这个竞态。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'

const execFileAsync = promisify(execFile)

export interface TmuxSessionSpec {
  name: string // 约定 crabot-w-<worker_id>-<seq>
  cwd: string
  command: string // 在 pane 内执行的命令行
  env?: Record<string, string>
  outputFile: string // pipe-pane 追加目标
}

export class TmuxDriver {
  private readonly tmuxBin: string

  constructor(opts?: { tmuxBin?: string }) {
    this.tmuxBin = opts?.tmuxBin ?? 'tmux'
  }

  async available(): Promise<boolean> {
    try {
      await execFileAsync(this.tmuxBin, ['-V'])
      return true
    } catch {
      return false
    }
  }

  async newSession(spec: TmuxSessionSpec): Promise<void> {
    // pipe-pane 首次落盘前文件应已存在,方便调用方直接 watch;不截断已存在内容。
    await fs.writeFile(spec.outputFile, '', { flag: 'a' })

    const envArgs: string[] = []
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      envArgs.push('-e', `${key}=${value}`)
    }

    const pipeCmd = `cat >> ${shQuote(spec.outputFile)}`
    await this.run([
      'new-session',
      '-d',
      '-s',
      spec.name,
      '-c',
      spec.cwd,
      ...envArgs,
      spec.command,
      ';',
      'pipe-pane',
      '-o',
      '-t',
      spec.name,
      pipeCmd,
    ])
  }

  async sendText(name: string, text: string): Promise<void> {
    let lines = text.split('\n')
    if (text.endsWith('\n')) lines = lines.slice(0, -1)

    for (const line of lines) {
      if (line.length > 0) {
        await this.run(['send-keys', '-t', name, '-l', '--', line])
      }
      await this.run(['send-keys', '-t', name, 'Enter'])
    }
  }

  async sendKeys(name: string, keys: string[]): Promise<void> {
    await this.run(['send-keys', '-t', name, ...keys])
  }

  async isAlive(name: string): Promise<boolean> {
    try {
      await this.run(['has-session', '-t', name])
      return true
    } catch {
      return false
    }
  }

  async paneCommand(name: string): Promise<string | null> {
    try {
      // tmux 对不存在的 target 也会以 exit 0 返回空输出(不抛错),所以用是否有内容来判定,
      // 而不是依赖 catch。
      const { stdout } = await this.run(['display-message', '-p', '-t', name, '#{pane_current_command}'])
      const trimmed = stdout.trim()
      return trimmed.length > 0 ? trimmed : null
    } catch {
      return null
    }
  }

  async killSession(name: string): Promise<void> {
    try {
      await this.run(['kill-session', '-t', name])
    } catch {
      // 幂等:会话不存在时不抛错
    }
  }

  private run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(this.tmuxBin, args)
  }
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
