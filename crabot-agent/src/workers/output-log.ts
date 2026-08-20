import * as fs from 'fs/promises'
import { AsyncMutex } from './async-mutex'

/** `OutputLog` 的内部读取位点；不属于 WorkerAdapter 或 RPC 契约。 */
interface OutputCursor { readonly offset: number }

/** 返回给调用方的默认字符上限(超了只保留尾部)。 */
const DEFAULT_CAP = 50_000

/**
 * 单次从磁盘读取的字节上限。纯文本 artifact 也必须有这个内存护栏，不能因异常长的
 * builtin 回答或 headless fork 结果撑大一次读取。
 */
const RAW_WINDOW_MAX = 1_000_000

// 读窗口取的是文件**尾部**,窗口起点可能落在某个多字节 UTF-8 字符中间。返回从开头起
// 应当丢弃的字节数:连续的续字节(10xxxxxx)就是被切掉一半的那个字符的残骸。窗口末尾
// 恒为 EOF,不会切断字符,不需要对称处理。
function skipIncompleteUtf8Head(buffer: Buffer, len: number): number {
  const maxSkip = Math.min(3, len)
  for (let i = 0; i < maxSkip; i++) {
    if ((buffer[i] & 0xc0) !== 0x80) return i
  }
  return maxSkip
}

/**
 * builtin worker 和 CLI headless fork 的纯文本 artifact。
 *
 * 交互式 Claude Code/Codex 主线的 TUI 画面不写这里；调用方必须通过
 * `WorkerAdapter.readTerminal()` 读取 tmux 当前画面或最终快照，不能从字节流反推渲染态。
 */
export class OutputLog {
  private mutex = new AsyncMutex()

  constructor(private filePath: string) {}

  async append(text: string): Promise<void> {
    return this.mutex.run(async () => {
      await fs.appendFile(this.filePath, text, 'utf-8')
    })
  }

  /**
   * 日志文件最后一次被写入的时刻(epoch ms);文件还不存在时返回 undefined。
   *
   * 只供 CLI adapter 的 `lastActivityAt` 使用(protocol-agent-v3 §6.1):活性巡检要的是
   * "有没有新字节落盘"这一件事,一次 `fs.stat` 就够,不需要像 `read` 那样把新增内容读出来
   * 再解码——巡检是周期性的,解码成本会持续付。不进 `mutex`:stat 不读内容,与 append/read
   * 的原子性无关,拿到的最坏情况只是"上一次 append 之前的 mtime",对"是否长时间零增长"的
   * 判定没有影响。
   */
  async lastModifiedMs(): Promise<number | undefined> {
    try {
      return (await fs.stat(this.filePath)).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  /**
   * 从 `cursor.offset` 读到文件末尾；内容超过 `cap` 时保留尾部。
   *
   * 这是内部纯文本 artifact 的读取辅助。没有 RPC 或 Manager 工具暴露这个 cursor；交互式
   * CLI 的完整终端视图由 tmux capture-pane 单独提供。
   */
  async read(
    cursor: OutputCursor,
    cap: number = DEFAULT_CAP,
  ): Promise<{ chunk: string; nextCursor: OutputCursor }> {
    return this.mutex.run(async () => {
      try {
        const stat = await fs.stat(this.filePath)
        const fileSize = stat.size

        // If cursor is already at or past end of file, return empty chunk
        if (cursor.offset >= fileSize) {
          return { chunk: '', nextCursor: cursor }
        }

        // 读窗口贴着文件末尾:[fileSize - windowBytes, fileSize)
        const windowBytes = Math.min(fileSize - cursor.offset, RAW_WINDOW_MAX)
        const windowStart = fileSize - windowBytes
        const skippedBytes = windowStart - cursor.offset

        const buffer = Buffer.alloc(windowBytes)
        const fd = await fs.open(this.filePath, 'r')
        let bytesRead: number
        try {
          ;({ bytesRead } = await fd.read(buffer, 0, windowBytes, windowStart))
        } finally {
          await fd.close()
        }

        const start = skippedBytes > 0 ? skipIncompleteUtf8Head(buffer, bytesRead) : 0
        let text = buffer.toString('utf-8', start, bytesRead)

        let trimmedChars = 0
        if (text.length > cap) {
          trimmedChars = text.length - cap
          // cap 按 UTF-16 code unit 数,边界可能落在代理对中间(emoji 这类星平面字符在
          // worker 输出里很常见)。多丢一个 code unit 把整对丢掉,否则开头会留下孤立的
          // 低位代理,经 UTF-8 序列化(JSON-RPC 投递)变成替换字符。
          const boundary = text.charCodeAt(trimmedChars)
          if (boundary >= 0xdc00 && boundary <= 0xdfff) trimmedChars += 1
          text = text.slice(trimmedChars)
        }

        const notes: string[] = []
        if (skippedBytes > 0) notes.push(`skipped ${skippedBytes} earlier bytes`)
        if (trimmedChars > 0) notes.push(`trimmed ${trimmedChars} leading chars`)
        const chunk =
          notes.length > 0
            ? `[output truncated: showing the latest output only (${notes.join(', ')}); ` +
              `the full log is on disk]\n${text}`
            : text

        return { chunk, nextCursor: { offset: windowStart + bytesRead } }
      } catch (error) {
        // File not found: return empty chunk with same cursor
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { chunk: '', nextCursor: cursor }
        }
        throw error
      }
    })
  }
}
