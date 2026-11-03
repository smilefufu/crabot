import { Lexer } from 'marked'

const LIMIT = 4000
const length = (s: string) => Array.from(s).length
type Unit = { source: string; render: string; mention?: string; separate?: boolean }
export type SlackBlock = { type: 'markdown'; text: string } | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
export interface TextPart { source: string; blocks: SlackBlock[] }
const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? []
const escape = (s: string) => s.replace(/[\\`*_{}[\]()#+.!|>~<&-]/g, '\\$&')

function literal(source: string): Unit[] {
  const result: Unit[] = []
  let text = '', render = ''
  for (const char of source) {
    const escaped = escape(char)
    if (length(render) + length(escaped) > LIMIT) { result.push({ source: text, render }); text = ''; render = '' }
    text += char; render += escaped
  }
  if (text) result.push({ source: text, render })
  return result
}

function table(raw: string, columns: number): Unit[] {
  const rows = lines(raw), header = rows.splice(0, 2).join('')
  if (columns > 20 || length(header) >= LIMIT) return literal(raw)
  const result: Unit[] = []
  let source = header, render = header, count = 1
  const flush = () => { if (source) result.push({ source, render }); source = ''; render = header; count = 1 }
  for (const row of rows) {
    if (length(header + row) > LIMIT) {
      flush(); result.push(...literal(row)); continue
    }
    if (length(render + row) > LIMIT || count >= 100) flush()
    source += row; render += row; count++
  }
  flush()
  return result.map(unit => ({ ...unit, separate: result.length > 1 }))
}

function code(raw: string): Unit[] {
  const rows = lines(raw), opening = rows[0] ?? ''
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*\n$/.exec(opening)?.[1]
  if (!fence) return literal(raw)
  rows.shift()
  let closing = ''
  const tail = rows[rows.length - 1]
  if (tail && new RegExp(`^ {0,3}${fence[0]}{${fence.length},} *\\n?$`).test(tail)) closing = rows.pop()!
  const suffix = '\n' + fence + '\n', budget = LIMIT - Math.max(length(opening + suffix), length(opening + closing))
  if (budget < 1) return literal(raw)
  const pieces: string[] = []
  let piece = ''
  for (const row of rows) {
    if (length(piece + row) <= budget) { piece += row; continue }
    if (piece) { pieces.push(piece); piece = '' }
    const chars = Array.from(row)
    while (chars.length > budget) pieces.push(chars.splice(0, budget).join(''))
    piece = chars.join('')
  }
  if (piece || !pieces.length) pieces.push(piece)
  return pieces.map((part, i) => ({
    source: (i === 0 ? opening : '') + part + (i === pieces.length - 1 ? closing : ''),
    render: opening + part + suffix, separate: pieces.length > 1,
  }))
}

function units(text: string): Unit[] {
  const result: Unit[] = []
  let offset = 0
  for (const token of Lexer.lex(text, { gfm: true })) {
    const start = text.indexOf(token.raw, offset)
    if (start < offset) continue
    if (start > offset) result.push(...literal(text.slice(offset, start)))
    offset = start + token.raw.length
    if (token.type === 'html') result.push(...literal(token.raw))
    else if (token.type === 'table') result.push(...table(token.raw, token.header.length))
    else if (token.type === 'code' && length(token.raw) > LIMIT) result.push(...code(token.raw))
    else if (length(token.raw) <= LIMIT) result.push({ source: token.raw, render: token.raw })
    else {
      const pieces: string[] = token.type === 'list' ? token.items.map((item: { raw: string }) => item.raw)
        : token.type === 'blockquote' ? lines(token.raw) : Lexer.lexInline(token.raw).map(item => item.raw)
      // Some nested lexer tokens normalize whitespace; fall back rather than lose source bytes.
      if (pieces.join('') !== token.raw) result.push(...literal(token.raw))
      else for (const raw of pieces) result.push(...(length(raw) > LIMIT ? literal(raw) : [{ source: raw, render: raw }]))
    }
  }
  if (offset < text.length) result.push(...literal(text.slice(offset)))
  return result
}

export function formatSlackText(text: string, mentions: string[] = []): TextPart[] {
  const all: Unit[] = mentions.map(id => ({ source: `<@${id}> `, render: '', mention: `<@${id}>` }))
  all.push(...units(text))
  const result: TextPart[] = []
  let source = '', render = '', names: string[] = []
  const flush = () => {
    if (!source) return
    const blocks: SlackBlock[] = []
    let group = ''
    for (const name of names) {
      if (length(group + ' ' + name) > 3000) { blocks.push({ type: 'section', text: { type: 'mrkdwn', text: group } }); group = '' }
      group += (group ? ' ' : '') + name
    }
    if (group) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: group } })
    if (render) blocks.push({ type: 'markdown', text: render })
    result.push({ source, blocks }); source = ''; render = ''; names = []
  }
  for (const unit of all) {
    if (unit.separate) flush()
    if (length(source + unit.source) > LIMIT || length(render + unit.render) > LIMIT) flush()
    source += unit.source; render += unit.render
    if (unit.mention) names.push(unit.mention)
    if (unit.separate) flush()
  }
  flush()
  return result
}
