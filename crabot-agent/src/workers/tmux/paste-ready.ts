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
 * 就绪握手超时时随唤醒事件带给 manager 的那段正文:output 尾部 + 一句说明。
 *
 * 说明这一句是必须的——manager 光看一屏 TUI 字节推断不出"开工输入根本没投递出去",
 * 而这恰恰决定了它该做什么(先用 `raw` 敲键清掉挡路的界面、再把任务重新投一次),而不是
 * 按"worker 干完一轮在等下一步"处理。措辞在这里收口,cc/codex 两侧共用同一份。
 *
 * **说明排在尾部,不排在头部**:这段正文会经 harness 的 `truncateWakeText(..., 'tail')`
 * 截到 WAKE_TEXT_MAX_CHARS(2000 字符)——保尾丢头,因为屏幕内容越靠后越新。而
 * STARTUP_STALL_TAIL_BYTES 是 4096,一屏以文本为主的输出解码后超过 2000 字符并不罕见,
 * 说明句要是排在头部,恰好会被这次截断连同 `---` 一起丢掉,manager 只剩一堆屏幕字节,
 * 上面那句"必须的"就没了。排在尾部则保尾截断天然保住它,被丢掉的只是更早的屏幕内容
 * ——那部分本来就在 output 日志里,manager 用 `read_worker_output` 读得回来。
 *
 * (另一个可选修法是在这里先把 tail 自身截到"head + tail 必然不超过 2000",但那要求本
 * 模块知道 harness 的 WAKE_TEXT_MAX_CHARS,把截断这件事拆到两个模块里各做一半;换个顺序
 * 不引入任何跨模块常量,截断仍然只在 harness 一处发生。)
 */
export function describeStartupStall(opts: { impl: string; timeoutMs: number; tail: string }): string {
  const note =
    `[crabot] ${opts.impl} 启动后 ${Math.round(opts.timeoutMs / 1000)}s 内未就绪` +
    `(TUI 始终没有开启 bracketed paste),开工输入**一个字符都没有投递**——` +
    `否则它会被当成按键打进挡在前面的界面。上面是该化身终端输出的尾部(已解码成可读文本,` +
    `与 read_worker_output 同一形态),据此判断卡在哪:如需控制,send_to_worker 的 raw 模式只能敲控制键(如 y Enter),` +
    `不得附加任务正文;恢复可输入态后再以非 raw 投递任务。`
  return `${opts.tail || '(终端至今没有任何输出)'}\n---\n${note}`
}

/**
 * 投递验证失败的暂扣正文(与 describeStartupStall 平行):就绪握手已通过、prompt 已投递过
 * (可能两次)并已发过 Esc,但会话记录里始终没出现这条 user 消息——判定被启动期模态框(如
 * MCP 信任窗)吞掉。正文必须如实反映这一现场,不能复用"未就绪/一个字符都没投递"的失实描述
 * (2026-08-06 review 指正,否则 manager 会按错的现场做决策)。
 */
export function describeDeliveryStall(opts: { impl: string; timeoutMs: number; tail: string }): string {
  const seconds = Math.round(opts.timeoutMs / 1000)
  const note =
    `[crabot] ${opts.impl} 启动成功(就绪握手已通过),但首条任务输入投递后 ${seconds}s 内没有出现在会话记录里——` +
    `判定被启动期模态框(如 MCP 信任窗)吞掉,已自动按 Esc 并重投一次仍无效。进程/会话仍活着、台账仍记着 running。` +
    `上面是该化身终端输出的尾部(已解码成可读文本,与 read_worker_output 同一形态),据此判断卡在哪:` +
    `可用 send_to_worker 的 raw 模式敲键清掉界面,再以非 raw 重发完整任务。`
  return `${opts.tail || '(终端至今没有任何输出)'}\n---\n${note}`
}

/**
 * 读 output 日志的**尾部**(最多 maxBytes 字节),原样返回。
 *
 * 用途只有一个:就绪握手超时时把"屏幕这一刻在说什么"随唤醒事件交给 manager 判断
 * (protocol-agent-v3 §5.5「检测到无法识别的交互界面:暂扣 + 唤醒 manager(附界面内容)」)。
 * 尾部而非头部:启动期日志的头部是终端能力协商,模态框在最后。
 *
 * 这里只负责取字节,ANSI 归一化由调用方做:两个 CLI adapter 在 initialStartupStall 里把结果
 * 过一遍 `decodeTerminalOutput`,与它们 `readOutput` 的返回路径共用同一个解码器,解码边界因此
 * 统一留在 adapter 那一层(builtin 的输出是纯文本,从不经过这里)。截取起点可能落在一个多字节
 * UTF-8 字符中间,这里丢掉开头的续字节再解码,避免出现替换字符。
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
