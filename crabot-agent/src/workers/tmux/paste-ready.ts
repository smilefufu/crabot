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
 * `pipe-pane` 原始流只由伴随 pane 的控制状态监视器消费，监视器经本机 IPC 返回小状态；
 * 这里既不扫描文件，也不从终端画面猜测控制状态。
 */
import type { PasteReadiness } from './control-monitor.js'

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

const POLL_INTERVAL_MS = 50
const ALIVE_CHECK_INTERVAL_MS = 1000

/**
 * 轮询控制状态监视器，直到它确认 `\e[?2004h` 为止；超时返回 false(**调用方不得据此
 * 降级继续发送**——那正是本设计要消除的行为)。
 *
 * `isAlive`(可选)是提前收工的出口:会话已经不在了就没什么可等的了——启动即失败
 * (二进制缺失、PATH 不对、pane 里的命令立刻退出)是常见情形,让它也白等满整个超时,等于
 * 给一条本来秒级收敛的失败路径平白加上一分钟延迟。探活要拉 tmux 子进程,比读文件贵得多,
 * 因此按 ALIVE_CHECK_INTERVAL_MS 单独限频,不跟着 50ms 的读文件节奏走。
 */
export async function waitForPasteReady(
  getReadiness: () => Promise<PasteReadiness>,
  opts: { timeoutMs: number; intervalMs?: number; isAlive?: () => Promise<boolean> },
): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS
  const deadline = Date.now() + opts.timeoutMs
  let nextAliveCheckAt = Date.now() + ALIVE_CHECK_INTERVAL_MS

  for (;;) {
    if ((await getReadiness()).state === 'ready') return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
    if (opts.isAlive && Date.now() >= nextAliveCheckAt) {
      nextAliveCheckAt = Date.now() + ALIVE_CHECK_INTERVAL_MS
      // 退出前再读一次监视器；最后一刻收到的 ready 仍可安全使用。
      if (!(await opts.isAlive())) return (await getReadiness()).state === 'ready'
    }
  }
}
