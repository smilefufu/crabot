/**
 * Channel 端 markdown 渲染工具：三态格式开关 + CommonMark 子集到 Telegram HTML 的转换。
 * 飞书走 interactive 卡片直接喂原文不需要转换；本模块只服务 Telegram。
 */

export type MarkdownFormat = 'auto' | 'on' | 'off'

export const MARKDOWN_FORMAT_VALUES: readonly MarkdownFormat[] = ['auto', 'on', 'off']

/** Telegram Bot API 的 parse_mode 取值（用 HTML 子集是因为更容易精确转义） */
export type TelegramParseMode = 'HTML'

export function parseMarkdownFormat(raw: string | undefined | null, fallback: MarkdownFormat = 'auto'): MarkdownFormat {
  if (typeof raw !== 'string') return fallback
  const v = raw.trim().toLowerCase()
  return (MARKDOWN_FORMAT_VALUES as readonly string[]).includes(v) ? (v as MarkdownFormat) : fallback
}

export function decideMarkdownEnabled(setting: MarkdownFormat, text: string): boolean {
  if (setting === 'on') return true
  if (setting === 'off') return false
  return hasMarkdownMarkers(text)
}

const MARKDOWN_MARKER_PATTERNS: readonly RegExp[] = [
  /\*\*[^*\n]+\*\*/,
  /__[^_\n]+__/,
  /(?<![*\w])\*[^*\n]+\*(?![*\w])/,
  /(?<![_\w])_[^_\n]+_(?![_\w])/,
  /~~[^~\n]+~~/,
  /`[^`\n]+`/,
  /^```/m,
  /^#{1,6}\s/m,
  /^[ \t]*[*+-]\s+/m,
  /^[ \t]*\d+\.\s+/m,
  /\[[^\]\n]+\]\([^)\n]+\)/,
  /^>\s/m,
]

export function hasMarkdownMarkers(text: string): boolean {
  if (!text) return false
  return MARKDOWN_MARKER_PATTERNS.some((p) => p.test(text))
}

const SENTINEL_OPEN = '\u0001'
const SENTINEL_CLOSE = '\u0002'
const SENTINEL_STRIP_RE = /[\u0001\u0002]/g
const CODE_BLOCK_RESTORE_RE = /\u0001CB(\d+)\u0002/g
const INLINE_CODE_RESTORE_RE = /\u0001IC(\d+)\u0002/g
const TABLE_RESTORE_RE = /\u0001TB(\d+)\u0002/g

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 视觉宽度：CJK / 全角字符算 2，其它算 1。Telegram 等宽字体里和实际渲染最接近 */
function visualWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||
      (cp >= 0x2E80 && cp <= 0x303E) ||
      (cp >= 0x3041 && cp <= 0x33FF) ||
      (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0xA000 && cp <= 0xA4CF) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE30 && cp <= 0xFE4F) ||
      (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x20000 && cp <= 0x2FFFD) ||
      (cp >= 0x30000 && cp <= 0x3FFFD)
    ) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}

type ColAlign = 'left' | 'center' | 'right'

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null
  return trimmed.slice(1, -1).split('|').map((c) => c.trim())
}

function parseAlignmentRow(line: string): ColAlign[] | null {
  const cells = parseTableRow(line)
  if (!cells || cells.length === 0) return null
  const aligns: ColAlign[] = []
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    aligns.push(right && left ? 'center' : right ? 'right' : 'left')
  }
  return aligns
}

function padCell(text: string, width: number, align: ColAlign): string {
  const pad = width - visualWidth(text)
  if (pad <= 0) return text
  if (align === 'right') return ' '.repeat(pad) + text
  if (align === 'center') {
    const left = Math.floor(pad / 2)
    return ' '.repeat(left) + text + ' '.repeat(pad - left)
  }
  return text + ' '.repeat(pad)
}

/**
 * GFM 表格 → 等宽文本：Telegram parse_mode=HTML 不认 <table>，只能塞进 <pre>
 * 让列在等宽字体下视觉对齐。返回值的单元格内容已 HTML escape，可直接放入 <pre>。
 */
function formatTable(rows: string[][], aligns: ColAlign[]): string {
  const colCount = Math.max(...rows.map((r) => r.length), aligns.length)
  const widths: number[] = []
  for (let c = 0; c < colCount; c++) {
    let w = 0
    for (const row of rows) w = Math.max(w, visualWidth(row[c] ?? ''))
    widths.push(w)
  }
  const lines: string[] = []
  rows.forEach((row, idx) => {
    const cells = widths.map((w, c) => escapeHtml(padCell(row[c] ?? '', w, aligns[c] ?? 'left')))
    lines.push(cells.join(' │ '))
    if (idx === 0) lines.push(widths.map((w) => '─'.repeat(w)).join('─┼─'))
  })
  return lines.join('\n')
}

/** 扫描原文找 GFM 表格块（header + 对齐行 + 至少一行数据），就地用占位符替换 */
function extractTables(input: string): { stripped: string; tables: string[] } {
  const lines = input.split('\n')
  const out: string[] = []
  const tables: string[] = []
  let i = 0
  while (i < lines.length) {
    const header = parseTableRow(lines[i])
    const aligns = i + 1 < lines.length ? parseAlignmentRow(lines[i + 1]) : null
    if (header && aligns && header.length === aligns.length && i + 2 < lines.length) {
      const dataRows: string[][] = []
      let j = i + 2
      while (j < lines.length) {
        const row = parseTableRow(lines[j])
        if (!row) break
        dataRows.push(row)
        j++
      }
      if (dataRows.length > 0) {
        const idx = tables.length
        tables.push(formatTable([header, ...dataRows], aligns))
        out.push(`\u0001TB${idx}\u0002`)
        i = j
        continue
      }
    }
    out.push(lines[i])
    i++
  }
  return { stripped: out.join('\n'), tables }
}

/**
 * CommonMark 子集 → Telegram parse_mode=HTML（<b>/<i>/<s>/<a>/<code>/<pre>/<blockquote>）。
 * 不支持的 markdown 语法会原样保留并经过 HTML escape。
 */
export function markdownToTelegramHtml(md: string): string {
  if (!md) return ''

  // U+0001 / U+0002 在用户输入里几乎不可能出现，但理论存在；提前剥掉避免占位符被伪造
  const codeBlocks: string[] = []
  const inlineCodes: string[] = []
  let text = md.replace(SENTINEL_STRIP_RE, '')

  text = text.replace(/```([\s\S]*?)```/g, (_, code: string) => {
    const idx = codeBlocks.length
    codeBlocks.push(code)
    return `${SENTINEL_OPEN}CB${idx}${SENTINEL_CLOSE}`
  })

  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    const idx = inlineCodes.length
    inlineCodes.push(code)
    return `${SENTINEL_OPEN}IC${idx}${SENTINEL_CLOSE}`
  })

  const tableExtract = extractTables(text)
  text = tableExtract.stripped
  const tables = tableExtract.tables

  text = escapeHtml(text)

  text = text.replace(/^(#{1,6})\s+(.+)$/gm, '<b>$2</b>')

  // ">" 已被 escapeHtml 转成 "&gt;"，所以这里要匹配 escape 后的形态
  text = text.replace(/(^|\n)((?:&gt;\s?[^\n]*(?:\n|$))+)/g, (_match, prefix: string, block: string) => {
    const inner = block.replace(/^&gt;\s?/gm, '').replace(/\n$/, '')
    return `${prefix}<blockquote>${inner}</blockquote>`
  })

  text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<b><i>$1</i></b>')
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  text = text.replace(/__([^_\n]+)__/g, '<b>$1</b>')

  // 单星 / 单下划线斜体不能贴在字母 / 下划线 / 星号旁边，避免误吃 snake_case
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<i>$2</i>')
  text = text.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<i>$2</i>')

  text = text.replace(/~~([^~\n]+)~~/g, '<s>$1</s>')

  text = text.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_match, label: string, url: string) => {
    const safeUrl = url.replace(/"/g, '%22')
    return `<a href="${safeUrl}">${label}</a>`
  })

  text = text.replace(/^([ \t]*)[*+-]\s+/gm, '$1• ')

  text = text.replace(CODE_BLOCK_RESTORE_RE, (_match, idxStr: string) => {
    const code = codeBlocks[Number(idxStr)] ?? ''
    const newlineIdx = code.indexOf('\n')
    let lang = ''
    let body = code
    if (newlineIdx >= 0) {
      const head = code.slice(0, newlineIdx).trim()
      if (/^[a-zA-Z0-9_+-]+$/.test(head)) {
        lang = head
        body = code.slice(newlineIdx + 1)
      }
    }
    body = body.replace(/^\n+/, '').replace(/\n+$/, '')
    const escapedBody = escapeHtml(body)
    return lang
      ? `<pre><code class="language-${lang}">${escapedBody}</code></pre>`
      : `<pre>${escapedBody}</pre>`
  })

  text = text.replace(INLINE_CODE_RESTORE_RE, (_match, idxStr: string) => {
    const code = inlineCodes[Number(idxStr)] ?? ''
    return `<code>${escapeHtml(code)}</code>`
  })

  text = text.replace(TABLE_RESTORE_RE, (_match, idxStr: string) => {
    const body = tables[Number(idxStr)] ?? ''
    return `<pre>${body}</pre>`
  })

  return text
}
