import * as fs from 'fs/promises'
import { AsyncMutex } from './async-mutex'
import type { OutputCursor } from './types'

/** 返回给调用方的默认字符上限(超了只保留尾部)。 */
const DEFAULT_CAP = 50_000

/**
 * 单次从磁盘读取的原始字节上限。它比 `cap` 大得多,因为 CLI worker 的原文要先解码
 * (`decode`)才是给人/给 manager 看的文本,而 TUI 重绘流的解码压缩比在 15~30 倍;
 * 按 `cap` 去读原始字节,50KB 预算最后只剩 1KB 有效内容。这里只是内存护栏。
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

export class OutputLog {
  private mutex = new AsyncMutex()

  constructor(private filePath: string) {}

  async append(text: string): Promise<void> {
    return this.mutex.run(async () => {
      await fs.appendFile(this.filePath, text, 'utf-8')
    })
  }

  /**
   * 从 `cursor.offset` 读到文件末尾;内容超过 `cap` 时**保留尾部,丢头部**。
   *
   * 方向是这么定的:这个入口的真实用途只有两类,而两类都要最新的那一段——
   * - manager 的 `read_worker_output` 是在诊断"worker 现在卡在哪",最早的启动噪音对它没有
   *   价值(现网踩过:172KB 日志里致命的 401 落在 byte 75618,头部 50KB 只有中途的重连症状,
   *   manager 据此把中途症状写成了 kill reason);
   * - admin 的 `read_worker_output_admin` 是终端输出的滚动视图,首帧要的也是最新画面。
   * 交接材料(`harness.handoffIncarnation`)读完还要自己取尾部,同样受益。
   * 没有"从头顺序读完整份日志"的调用方,所以不加开关,直接改缺省行为。
   *
   * 游标语义因此保持自洽:返回的 `nextCursor` 恒为本次读到的位置(即文件末尾),永远不倒退。
   * 增量轮询完全不受影响——两次轮询之间的新增不超过 `cap` 时,行为与改动前逐字一致;超过
   * 时保留新增部分的尾部。被跳过的字节数写在截断标记里(前缀,不是后缀:标记说明的是它
   * **前面**缺了什么)。
   *
   * `decode` 是给 CLI worker 用的返回路径转换(见 `terminal-output.ts`):落盘的原文一字不动,
   * 只有返回给调用方的这一份被解码。`cap` 作用在**解码后**的文本上——manager 的预算该花在
   * 它真能读懂的内容上,而不是 TUI 转义序列。
   */
  async read(
    cursor: OutputCursor,
    cap: number = DEFAULT_CAP,
    decode?: (raw: string) => string
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
        if (decode) text = decode(text)

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
