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
import os from 'node:os'
import { join } from 'node:path'
import { buildScrubbedChildEnv } from '../connections/secret-env.js'
import {
  controlMonitorPipeCommand,
  createTmuxControlEndpoint,
  readTmuxControlState,
  removeTmuxControlEndpoint,
  type PasteReadiness,
  type TmuxControlEndpoint,
} from './control-monitor.js'

const execFileAsync = promisify(execFile)

function normalizedPaneTerm(value: string | undefined): string {
  const term = value?.trim()
  return term && term.toLowerCase() !== 'dumb' ? term : 'xterm-256color'
}

export interface TmuxSessionSpec {
  name: string // 约定 crabot-w-<worker_id>-<seq>
  cwd: string
  command: string // 在 pane 内执行的命令行
  env?: Record<string, string>
}

export interface PaneSnapshot {
  text: string
  /** tmux 已用自己的 dead-pane 提示替换 viewport，text 不再是 worker 画面。 */
  dead?: boolean
  captured_at?: string
}

export type TmuxSession = TmuxControlEndpoint & {
  /** 仅在 adapter 已持久化可重建 meta 后调用，避免无主 dead pane。 */
  enableRemainOnExit?: () => Promise<void>
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

  async newSession(spec: TmuxSessionSpec): Promise<TmuxSession> {
    const controlEndpoint = await createTmuxControlEndpoint()

    // P6-B 安全（两层）：
    // ① credential 类值经 `-e` 会摊进 tmux argv（同机 ps 可读）→ 一律走 0600 wrapper；
    // ② pane 基础环境继承自 tmux server（宿主 shell 的 ANTHROPIC_API_KEY 等会原样进 pane
    //    并发往第三方 endpoint，§6.5 要求显式 scrub）→ wrapper 用 `env -i` 从 scrub 后的
    //    allowlist 基础重建（buildScrubbedChildEnv）再叠加本次连接注入。
    const envEntries = Object.entries(scrubChildEnv(spec.env ?? {}))
    const merged: Record<string, string> = {
      ...buildScrubbedChildEnv(),
      ...Object.fromEntries(envEntries),
    }
    // `env -i` drops tmux's own pane TERM. A detached Module Manager commonly
    // has TERM=dumb, which makes Codex stop for an interactive confirmation.
    merged.TERM = normalizedPaneTerm(merged.TERM ?? process.env.TERM)
    const wrapperDir = await fs.mkdtemp(join(os.tmpdir(), 'crabot-tmux-env-'))
    await fs.chmod(wrapperDir, 0o700)
    const wrapperPath = join(wrapperDir, 'env.sh')
    // ① `env -i` 在 tmux 命令行（argv 只有 wrapper 路径，无任何值）；② export 行只在
    // wrapper 文件里（0600），连 env 进程 argv 的瞬时窗口都没有（R12）；③ pane 自删除
    //（newSession 返回即删会赶在 exec 之前——竞态实证）。
    const lines = Object.entries(merged).map(([key, value]) => `export ${key}=${shQuote(value)}`)
    await fs.writeFile(
      wrapperPath,
      `#!/bin/sh
rm -f -- "$0"
rmdir -- "$(dirname "$0")" 2>/dev/null
${lines.join('\n')}
exec ${spec.command}
`,
      // 内层 exec：pane 的最终进程是真实命令本身（pane_current_command/liveness 依赖）
      { mode: 0o600 },
    )
    const command = `env -i sh ${shQuote(wrapperPath)}`

    const envArgs: string[] = ['-e', `${CORE_AGENT_RUNTIME_BEARER_ENV}=`]
    const pipeCmd = controlMonitorPipeCommand(controlEndpoint)
    let sessionCreated = false
    try {
      await this.run([
        'new-session',
        '-d',
        '-s',
        spec.name,
        '-c',
        spec.cwd,
        ...envArgs,
        command,
        ';',
        'pipe-pane',
        '-o',
        '-t',
        spec.name,
        pipeCmd,
      ])
      sessionCreated = true
      return {
        ...controlEndpoint,
        enableRemainOnExit: async () => {
          try {
            await this.run([
              'set-option',
              '-w',
              '-t',
              spec.name,
              'remain-on-exit',
              'on',
            ])
          } catch (error) {
            // meta 已经持久化，但 pane 可能恰好在这一步之前自行退出；目标已消失时让
            // adapter 接管那份 meta 并按 exited 收口，不能把这条正常竞态当成 spawn 失败。
            if (!(await this.hasSession(spec.name))) return
            throw error
          }
        },
      }
    } finally {
      // 成功：wrapper 由 pane 自删除（rm -f $0），本进程不动它（newSession 返回时 pane
      // 可能尚未 exec，提前删目录会让 session 秒退——实测竞态）。
      // 失败：pane 永远不会起来，清掉孤儿 wrapper 目录。
      if (wrapperDir && !sessionCreated) {
        await fs.rm(wrapperDir, { recursive: true, force: true }).catch(() => {})
        await removeTmuxControlEndpoint(controlEndpoint)
      }
    }
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
    const { stdout: text } = await this.run(['capture-pane', '-p', '-J', '-t', name])
    // The pane can exit while capture-pane is in flight. Check after capture so
    // tmux's replacement dead-pane text never masquerades as a live viewport.
    const dead = !(await this.isAlive(name))
    return { text, dead }
  }

  async sendKeys(name: string, keys: string[]): Promise<void> {
    await this.run(['send-keys', '-t', name, ...keys])
  }

  async isAlive(name: string): Promise<boolean> {
    try {
      const { stdout } = await this.run(['display-message', '-p', '-t', name, '#{pane_dead}'])
      return stdout.trim() === '0'
    } catch {
      return false
    }
  }

  private async hasSession(name: string): Promise<boolean> {
    try {
      await this.run(['has-session', '-t', name])
      return true
    } catch {
      return false
    }
  }

  async getPasteReadiness(endpoint: TmuxControlEndpoint): Promise<PasteReadiness> {
    return readTmuxControlState(endpoint)
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
