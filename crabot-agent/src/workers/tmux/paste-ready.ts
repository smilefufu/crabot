/**
 * CLI worker 启动期就绪握手 —— 在 TUI 真的能收下一整段粘贴之前,不把开工输入打进去。
 *
 * ## 为什么是 `\e[?2004h`,而不是"等某个副作用文件出现"
 *
 * `TmuxDriver.sendText` 用 `paste-buffer -p` 注入整段文本,`-p` 的语义是"**目标程序已经
 * 请求过 bracketed paste** 才用 `\e[200~ … \e[201~` 包裹";没请求时它静默降级成裸文本
 * 注入,于是 prompt 里每一个换行都变成一次 Enter 按键。生产实证(2026-08-04,m2):
 * claude-code 要到 pane 输出的 byte 871 / 1043 才发出 `\e[?2004h`(DECSET 2004,开启
 * bracketed paste),而 prompt 在 byte 0 就被打进去了——整份日志里 `200~` 出现 0 次,
 * prompt 的前几行分别确认掉了信任弹窗和 MCP 弹窗,剩下的残句躺在 composer 里从未提交,
 * worker 就此静默停在 `running` 达 8.5 小时。
 *
 * 所以本模块等的这个信号**不是就绪的代理指标,它正是 `-p` 需要的那个前提**:看到它,
 * 就等价于"接下来这次 paste 一定会被包裹、一定不会被当成按键"。
 *
 * 排除掉的替代方案是"等一个副作用文件出现"(cc 等 `~/.claude/projects/**.jsonl`、codex
 * 等 rollout 文件——codex adapter 的 `pollForNewRollout` 就是这么写的):那是**会话已经
 * 建立**的信号,不是**能收输入**的信号。会话建立恰恰会被启动期模态框挡住,于是这类轮询
 * 在最需要它的时候空转到超时,然后照样把 prompt 发出去。
 *
 * ## 为什么不读屏
 *
 * `TmuxDriver` 至今没有 `capture-pane`,本模块也不需要它:`pipe-pane` 落盘的 output 日志
 * 里搜一个固定字节序列就够了,不必重放 ANSI、不依赖任何 TUI 文案(cc/codex 升个版本就
 * 失效的那种依赖)。
 */
import { promises as fs } from 'fs'

/** DECSET 2004:目标程序请求开启 bracketed paste。 */
export const BRACKETED_PASTE_ENABLE = '\u001b[?2004h'

/**
 * 就绪握手默认超时(毫秒)。
 *
 * 取值依据(m2 生产日志实测,2026-08-04):
 * - 信号本身来得极早——claude-code 在 pane 输出的 byte 871 / 1043(两次独立运行)、
 *   codex 在 byte 0,都在启动后第一 KB 之内,健康路径上是毫秒级,**这个超时根本不会被付**;
 * - 慢的是整个 TUI 初始化:codex 那次从 tmux 建会话(16:01:26)到它自己落下 rollout 文件
 *   (磁盘 birth 16:01:29)约 3 秒。也就是说"正常但偏慢"的量级是秒,不是十秒。
 *
 * 于是取 60s ≈ 观测到的正常初始化耗时的 20–60 倍,给首次下载/自升级这类冷启动留足余量。
 * 方向上刻意宽松(spec:宁可等久,不可漏发):等久只在"确实出事了"的路径上付出,而它换来的
 * 是把"静默卡死"的上限从 8.5 小时压到 1 分钟。
 */
export const DEFAULT_PASTE_READY_TIMEOUT_MS = 60_000

/** 就绪握手超时后随唤醒事件带给 manager 的 output 尾部字节数上限。 */
export const STARTUP_STALL_TAIL_BYTES = 4096

const POLL_INTERVAL_MS = 50
const ALIVE_CHECK_INTERVAL_MS = 1000
const READ_CHUNK_BYTES = 64 * 1024

/**
 * 轮询 `outputFile`,直到里面出现过 `\e[?2004h` 为止;超时返回 false(**调用方不得据此
 * 降级继续发送**——那正是本设计要消除的行为)。
 *
 * 按游标增量读,跨块之间保留 `needle.length - 1` 字节的重叠,避免信号刚好骑在两次读取的
 * 边界上被漏掉。文件还不存在(pipe-pane 尚未落第一笔)不算失败,下一轮再看。
 *
 * `isAlive`(可选)是提前收工的出口:会话已经不在了就没什么可等的了——启动即失败
 * (二进制缺失、PATH 不对、pane 里的命令立刻退出)是常见情形,让它也白等满整个超时,等于
 * 给一条本来秒级收敛的失败路径平白加上一分钟延迟。探活要拉 tmux 子进程,比读文件贵得多,
 * 因此按 ALIVE_CHECK_INTERVAL_MS 单独限频,不跟着 50ms 的读文件节奏走。
 */
export async function waitForPasteReady(
  outputFile: string,
  opts: { timeoutMs: number; intervalMs?: number; isAlive?: () => Promise<boolean> },
): Promise<boolean> {
  const needle = Buffer.from(BRACKETED_PASTE_ENABLE, 'ascii')
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS
  const deadline = Date.now() + opts.timeoutMs
  let nextAliveCheckAt = Date.now() + ALIVE_CHECK_INTERVAL_MS
  let offset = 0
  let carry = Buffer.alloc(0)

  for (;;) {
    if (await scan()) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
    if (opts.isAlive && Date.now() >= nextAliveCheckAt) {
      nextAliveCheckAt = Date.now() + ALIVE_CHECK_INTERVAL_MS
      // 再扫一次收尾:进程可能在最后一刻写出信号才退出,那段输出已经落盘,不该丢。
      if (!(await opts.isAlive())) return scan()
    }
  }

  async function scan(): Promise<boolean> {
    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(outputFile, 'r')
    } catch {
      return false // 文件还没出现,或读不到:下一轮再看
    }
    try {
      const size = (await handle.stat()).size
      while (offset < size) {
        const len = Math.min(size - offset, READ_CHUNK_BYTES)
        const buf = Buffer.alloc(len)
        await handle.read(buf, 0, len, offset)
        offset += len
        const haystack = carry.length > 0 ? Buffer.concat([carry, buf]) : buf
        if (haystack.includes(needle)) return true
        // 复制而不是 subarray:subarray 是视图,会把整块 haystack 一起留在内存里。
        carry = Buffer.from(haystack.subarray(Math.max(0, haystack.length - (needle.length - 1))))
      }
      return false
    } finally {
      await handle.close()
    }
  }
}

/**
 * 就绪握手超时时随唤醒事件带给 manager 的那段正文:一句说明 + output 尾部。
 *
 * 说明这一句是必须的——manager 光看一屏 TUI 字节推断不出"开工输入根本没投递出去",
 * 而这恰恰决定了它该做什么(先用 `raw` 敲键清掉挡路的界面、再把任务重新投一次),而不是
 * 按"worker 干完一轮在等下一步"处理。措辞在这里收口,cc/codex 两侧共用同一份。
 */
export function describeStartupStall(opts: { impl: string; timeoutMs: number; tail: string }): string {
  const head =
    `[crabot] ${opts.impl} 启动后 ${Math.round(opts.timeoutMs / 1000)}s 内未就绪` +
    `(TUI 始终没有开启 bracketed paste),开工输入**一个字符都没有投递**——` +
    `否则它会被当成按键打进挡在前面的界面。下面是该化身终端输出的尾部(原始转义序列未解码),` +
    `据此判断卡在哪:可用 send_to_worker 的 raw 模式敲键清掉界面,再把任务内容重新投一次。`
  return opts.tail ? `${head}\n---\n${opts.tail}` : `${head}\n---\n(终端至今没有任何输出)`
}

/**
 * 读 output 日志的**尾部**(最多 maxBytes 字节),原样返回,不做 ANSI 归一化。
 *
 * 用途只有一个:就绪握手超时时把"屏幕这一刻在说什么"随唤醒事件交给 manager 判断
 * (protocol-agent-v3 §5.5「检测到无法识别的交互界面:暂扣 + 唤醒 manager(附界面内容)」)。
 * 尾部而非头部:启动期日志的头部是终端能力协商,模态框在最后。
 *
 * 不解码:pipe-pane 落的是终端输出**流**不是屏幕快照,还原成可读屏幕要重放 ANSI,那是
 * `read_worker_output` 返回路径上另做的事(§5.6),不在本次范围内。截取起点可能落在一个
 * 多字节 UTF-8 字符中间,这里丢掉开头的续字节再解码,避免出现替换字符。
 */
export async function readOutputTail(outputFile: string, maxBytes = STARTUP_STALL_TAIL_BYTES): Promise<string> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(outputFile, 'r')
  } catch {
    return ''
  }
  try {
    const size = (await handle.stat()).size
    const len = Math.min(size, maxBytes)
    if (len === 0) return ''
    const buf = Buffer.alloc(len)
    await handle.read(buf, 0, len, size - len)
    let start = 0
    if (len < size) {
      // 只有被截过头的读取才可能从字符中间开始:跳过开头的 UTF-8 续字节(10xxxxxx)。
      while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
    }
    return buf.toString('utf-8', start)
  } finally {
    await handle.close()
  }
}
