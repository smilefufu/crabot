/**
 * CLI worker(claude-code / codex)的输出日志解码。
 *
 * 这些日志是 tmux `pipe-pane` 落的**输出流**,不是屏幕快照:里面是 TUI 逐帧重绘产生的控制
 * 序列增量。真实样本(m2 上一次 codex 化身卡死的日志)172281 字节里有 30887 个 ESC、只有
 * 34 个 `\n` —— manager 直接读原文既烧 token 又根本读不懂:一行错误信息会被行定位切成好
 * 几段,而 30 倍的转义噪音把关键信息挤出 byte-cap 之外。
 *
 * 这里做的是**恰好够读**的重放,不是终端模拟器(不维护屏幕缓冲,因为屏幕缓冲只剩最后一帧,
 * 反而丢掉滚出视口的历史 —— 而历史正是归因要看的东西):
 * - 丢掉不产生可见文本的序列(SGR 颜色、擦除、光标显隐、括号粘贴、OSC 标题等);
 * - 光标绝对定位(CUP `CSI r;c H`)行号变了就补一个 `\n` —— TUI 的"换行"就是定位到下一行,
 *   不补的话整份日志塌成一行;
 * - 列定位(CHA `CSI n G`、HPA、CUF `CSI n C`)按列差补空格 —— TUI 用列跳转代替空格,不补
 *   的话 `Accessing` + `CSI 12G` + `workspace:` 会粘成 `Accessingworkspace:`;
 * - 行尾空白裁掉、空行丢掉(重绘出来的空行占了绝大多数)。
 *
 * 光标回退(列变小、`\r`)只记位置不回写:输出流里的回退基本用于重绘同一处,按覆盖处理会
 * 丢历史,按追加处理只会多出一点重复片段(比如自旋动画的逐字符更新)——后者对归因更安全。
 *
 * **只在返回路径上解码**:`OutputLog.append` 写的仍是一字不动的原文,排障看原始日志的路径
 * 不变。builtin worker 的输出本来就是纯文本,不走这里。
 */

/** 单次列跳转最多补多少空格 —— 挡住畸形参数(如 `CSI 999999G`)撑爆内存。 */
const MAX_COLUMN_GAP = 200

/** OSC 序列(`ESC ] ... BEL` 或 `ESC ] ... ESC \`)最长认到多少字符,超了当作噪音逐字节丢。 */
const MAX_OSC_LENGTH = 4096

const OSC_RE = /^\x1b\][\s\S]{0,4096}?(?:\x07|\x1b\\)/
const CSI_RE = /^\x1b\[([0-9;:<=>?]*)[ -/]*([@-~])/
const SIMPLE_ESC_RE = /^\x1b[()][0-9A-B]|^\x1b[=><78MDEHc\\]/

function paramAt(params: string, index: number, fallback: number): number {
  const raw = params.split(';')[index]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function decodeTerminalOutput(raw: string): string {
  let out = ''
  // row = -1 表示"还没见过行定位",第一次定位不补前导换行(前导空行反正会被裁掉,
  // 但保持 row 的语义清晰:只有行号真的变化才换行)。
  let row = -1
  let col = 1

  const newline = () => {
    out += '\n'
    col = 1
  }
  const advanceTo = (target: number) => {
    if (target > col) {
      out += ' '.repeat(Math.min(target - col, MAX_COLUMN_GAP))
    }
    col = target
  }

  let i = 0
  while (i < raw.length) {
    const ch = raw[i]

    if (ch === '\x1b') {
      const rest = raw.slice(i, i + MAX_OSC_LENGTH + 2)

      const osc = OSC_RE.exec(rest)
      if (osc) {
        i += osc[0].length
        continue
      }

      const csi = CSI_RE.exec(rest)
      if (csi) {
        const params = csi[1]
        const final = csi[2]
        if (final === 'H' || final === 'f') {
          const targetRow = paramAt(params, 0, 1)
          const targetCol = paramAt(params, 1, 1)
          if (targetRow !== row) {
            row = targetRow
            newline()
          }
          advanceTo(targetCol)
        } else if (final === 'G' || final === '`') {
          advanceTo(paramAt(params, 0, 1))
        } else if (final === 'C' || final === 'a') {
          advanceTo(col + paramAt(params, 0, 1))
        } else if (final === 'A' || final === 'B' || final === 'E' || final === 'F' || final === 'd') {
          // 相对/绝对的纵向移动:行号无从精确跟踪,统一当作换到新行。
          row = -1
          newline()
        }
        // 其余 final(SGR `m`、擦除 `J`/`K`、模式 `h`/`l` 等)不产生可见文本,直接丢。
        i += csi[0].length
        continue
      }

      const simple = SIMPLE_ESC_RE.exec(rest)
      if (simple) {
        i += simple[0].length
        continue
      }

      // 认不出来的 ESC(含被窗口切在开头的半截序列):丢掉这一个字节继续。
      i += 1
      continue
    }

    if (ch === '\n') {
      if (row >= 0) row += 1
      newline()
      i += 1
      continue
    }
    if (ch === '\r') {
      col = 1
      i += 1
      continue
    }
    if (ch < ' ' || ch === '\x7f') {
      i += 1
      continue
    }

    out += ch
    col += 1
    i += 1
  }

  return out
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '')
    .join('\n')
}
