import type { PaneSnapshot } from './driver.js'

export interface StyledCell {
  readonly char: string
  readonly dim: boolean
  readonly startColumn: number
  readonly endColumn: number
}

/** Parse the small subset of terminal styling needed for placeholder detection. */
export function parseStyledRows(value: string): StyledCell[][] {
  const rows: StyledCell[][] = [[]]
  let dim = false
  let column = 0
  for (let offset = 0; offset < value.length;) {
    if (value[offset] === '\u001b') {
      const csi = value.slice(offset).match(/^\u001b\[([0-?]*)([ -/]*)([@-~])/)
      if (csi) {
        if (csi[3] === 'm') {
          dim = applyDimSgr(csi[1], dim)
        }
        offset += csi[0].length
        continue
      }
      const osc = value.slice(offset).match(/^\u001b\][^\u0007]*(?:\u0007|\u001b\\)/)
      if (osc) {
        offset += osc[0].length
        continue
      }
      offset += 1
      continue
    }
    const char = value[offset] === '\n' ? '\n' : String.fromCodePoint(value.codePointAt(offset) ?? 0)
    offset += char.length
    if (char === '\n') {
      rows.push([])
      column = 0
      continue
    }
    if (char === '\r') continue
    const width = displayWidth(char)
    rows[rows.length - 1].push({ char, dim, startColumn: column, endColumn: column + width })
    column += width
  }
  return rows
}

/** A dim active composer is a placeholder even when its wording is unknown/localized. */
export function hasDimComposerEvidence(
  snapshot: Pick<PaneSnapshot, 'styled_text' | 'cursor'>,
  marker: string,
  value: string,
): boolean {
  if (!snapshot.styled_text || value.length === 0) return false
  const rows = parseStyledRows(snapshot.styled_text)
  for (const row of rows) {
    const start = findCells(row, value)
    if (start < 0) continue
    const cells = row.slice(start, start + [...value].length)
    if (cells.some((cell) => !/\s/.test(cell.char)) && cells.filter((cell) => !/\s/.test(cell.char)).every((cell) => cell.dim)) return true
  }

  const cursor = snapshot.cursor
  if (!cursor) return false
  const row = rows[cursor.y]
  if (!row) return false
  const markerStart = findCells(row, marker)
  const markerLength = [...marker].length
  const valueStart = findCells(row, value)
  if (markerStart < 0 || valueStart < markerStart + markerLength) return false
  const markerEnd = row[markerStart + markerLength - 1]?.endColumn
  if (markerEnd === undefined) return false
  const cell = row.find((candidate) => candidate.startColumn <= cursor.x && cursor.x < candidate.endColumn)
  return Boolean(cell?.dim && cell.startColumn >= markerEnd)
}

function applyDimSgr(params: string, initial: boolean): boolean {
  const codes = params.length === 0 ? [0] : params.split(';').map((part) => Number(part) || 0)
  let dim = initial
  for (let index = 0; index < codes.length; index++) {
    switch (codes[index]) {
      case 0:
      case 22:
        dim = false
        break
      case 2:
        dim = true
        break
      case 38:
      case 48:
      case 58:
        if (codes[index + 1] === 5) index += 2
        else if (codes[index + 1] === 2) index += 4
        break
    }
  }
  return dim
}

function findCells(row: readonly StyledCell[], value: string): number {
  const characters = [...value]
  if (characters.length === 0 || characters.length > row.length) return -1
  for (let start = 0; start <= row.length - characters.length; start++) {
    if (characters.every((char, index) => row[start + index].char === char)) return start
  }
  return -1
}

function displayWidth(value: string): number {
  const codePoint = value.codePointAt(0) ?? 0
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  ) ? 2 : 1
}
