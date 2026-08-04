import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { decodeTerminalOutput } from '../../src/workers/terminal-output'

const FIXTURES = path.join(__dirname, 'fixtures')

// 两份固件都取自真实的 m2 运行日志(tmux pipe-pane 落盘的输出流),已脱敏:
// - codex-tui-tail.ansi:一次 codex 化身因 401 卡死时的日志尾部(12040 字节)
// - cc-tui-head.ansi:一次 claude-code 化身的启动段(2631 字节)
function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf-8')
}

describe('decodeTerminalOutput', () => {
  it('把 codex 的 TUI 重绘流解成可读文本,致命错误行完整可读', () => {
    const raw = fixture('codex-tui-tail.ansi')
    const decoded = decodeTerminalOutput(raw)

    // manager 归因要的那一行:原文里被 TUI 的行定位切成好几段,解码后必须成行可读
    expect(decoded).toContain('unexpected status 401 Unauthorized')
    expect(decoded).toContain('https://api.openai.com/v1/responses')
    expect(decoded).toContain('invalid_api_key')

    // 控制序列必须清干净:manager 读到的不应再有 ESC
    expect(decoded).not.toContain('\x1b')

    // 真实收益:同一份内容体积降一个数量级(12040 → ~800 字节)
    expect(decoded.length).toBeLessThan(raw.length / 5)
  })

  it('把 claude-code 的 TUI 启动段解成可读文本,列定位不再把词粘在一起', () => {
    const raw = fixture('cc-tui-head.ansi')
    const decoded = decodeTerminalOutput(raw)

    // 原文是 `Accessing` + CSI 12G + `workspace:`,只删转义会粘成 "Accessingworkspace:"
    expect(raw).not.toContain('Accessing workspace:')
    expect(decoded).toContain('Accessing workspace:')

    expect(decoded).toContain('Quick safety check')
    expect(decoded).toContain('Enter to confirm')
    expect(decoded).not.toContain('\x1b')
    expect(decoded.length).toBeLessThan(raw.length)
  })

  it('光标绝对定位换行时补 \\n:否则整份日志会塌成一行', () => {
    const raw = '\x1b[1;1Hfirst\x1b[2;1Hsecond\x1b[3;1Hthird'
    expect(decodeTerminalOutput(raw)).toBe('first\nsecond\nthird')
  })

  it('纯文本原样通过(只裁行尾空白与空行)', () => {
    expect(decodeTerminalOutput('hello\nworld\n')).toBe('hello\nworld')
    expect(decodeTerminalOutput('a   \n\n\nb')).toBe('a\nb')
  })

  it('丢弃 SGR / 擦除 / OSC 标题这类不产生可见文本的序列', () => {
    const raw = '\x1b]0;window title\x07\x1b[31m\x1b[1mred bold\x1b[0m\x1b[K'
    expect(decodeTerminalOutput(raw)).toBe('red bold')
  })
})
