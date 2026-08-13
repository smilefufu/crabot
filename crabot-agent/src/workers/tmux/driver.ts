/**
 * TmuxDriver — 驱动 tmux 会话的最小封装,供外部 CLI worker adapter(claude-code/codex)复用。
 *
 * newSession 把 `new-session` 与 `pipe-pane` 合并进同一次 tmux 调用(用 `;` 分隔的批处理),
 * 而不是发两条独立的进程调用。原因:pipe-pane 只捕获挂上之后的新输出,不补历史;pane 内命令
 * 一旦创建就可能立即产生输出(如 `echo`),两次独立调用之间的进程启动开销就足以让这段输出在
 * pipe-pane 挂上前漏掉。批处理让 tmux server 在同一事务内背靠背执行两条子命令,消除这个竞态。
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { buildChildEnv, CORE_AGENT_RUNTIME_BEARER_ENV, scrubChildEnv } from '../../core/runtime-env.js'

const execFileAsync = promisify(execFile)

export interface TmuxSessionSpec {
  name: string // 约定 crabot-w-<worker_id>-<seq>
  cwd: string
  command: string // 在 pane 内执行的命令行
  env?: Record<string, string>
  outputFile: string // pipe-pane 追加目标
}

export interface PaneSnapshot {
  text: string
}

export class TmuxDriver {
  private readonly tmuxBin: string

  constructor(opts?: { tmuxBin?: string }) {
    this.tmuxBin = opts?.tmuxBin ?? 'tmux'
  }

  async available(): Promise<boolean> {
    try {
      await execFileAsync(this.tmuxBin, ['-V'], { env: buildChildEnv() })
      return true
    } catch {
      return false
    }
  }

  async newSession(spec: TmuxSessionSpec): Promise<void> {
    // pipe-pane 首次落盘前文件应已存在,方便调用方直接 watch;不截断已存在内容。
    await fs.writeFile(spec.outputFile, '', { flag: 'a' })

    const envArgs: string[] = ['-e', `${CORE_AGENT_RUNTIME_BEARER_ENV}=`]
    for (const [key, value] of Object.entries(scrubChildEnv(spec.env ?? {}))) {
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

  /**
   * 整段 text 当一条消息注入,走 bracketed paste 路径,而不是逐行 send-keys -l + Enter。
   * 后者对每一行都发一个 Enter,cc/codex TUI 收到 Enter 会把当前行当完整消息立即提交——
   * 多行 prompt(任务简报:标题+背景+验收,多行是常态)第一行就被提交、其余逐条进队列,
   * 语义碎裂。改法:load-buffer 从 stdin 读入整段文本(不经 shell 参数,注入安全)存进一个
   * 临时命名的 buffer,paste-buffer -p 触发 bracketed paste(目标程序若已请求 bracketed
   * paste,tmux 会用 \x1b[200~ ... \x1b[201~ 包裹这段内容,程序会把它当"粘贴的一整块",
   * 内部换行不当提交触发;未请求的程序则原样收到内容,行为等同直接输入),-r 禁用默认的
   * LF→CR 替换以保留原始换行符,-d 用完即删避免 buffer 堆积。最后单独发一个真实 Enter 提交
   * 整条消息。单行文本也走同一路径,不再区分单行/多行。
   */
  async sendText(name: string, text: string): Promise<void> {
    await this.pasteText(name, text)
    await this.run(['send-keys', '-t', name, 'Enter'])
  }

  /** Paste exactly one buffer and deliberately do not commit it. */
  async pasteText(name: string, text: string): Promise<void> {
    if (text.length === 0) return
    const bufferName = `crabot-sendtext-${randomUUID()}`
    await this.loadBufferFromStdin(bufferName, text)
    await this.run(['paste-buffer', '-p', '-r', '-d', '-b', bufferName, '-t', name])
  }

  /** Capture only the current viewport. */
  async capturePane(name: string): Promise<PaneSnapshot> {
    const { stdout: text } = await this.run(['capture-pane', '-p', '-e', '-J', '-t', name])
    return { text }
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
    return execFileAsync(this.tmuxBin, args, { env: buildChildEnv() })
  }

  /** `tmux load-buffer -b <name> -` 从 stdin 灌入内容,不把文本经过 shell 参数或临时文件。 */
  private loadBufferFromStdin(bufferName: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.tmuxBin, ['load-buffer', '-b', bufferName, '-'], { env: buildChildEnv() })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`tmux load-buffer exited with code ${code}: ${stderr}`))
      })
      child.stdin.write(content)
      child.stdin.end()
    })
  }
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
