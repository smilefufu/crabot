/**
 * 把超长文本按语义边界切分成多段，每段长度不超过 limit。
 *
 * 切分优先级：段落分隔 (\n\n) > 行首换行 (\n) > 句号 / 问号 / 感叹号
 * > 分号 > 空白；找不到合适断点时按字符硬切，并避开 UTF-16 代理对中间。
 *
 * 仅在切分点位于 limit 的后半段（>= 50%）时才接受，避免出现极短段落
 * 把后续内容挤爆 limit 的尾部。
 */

const SENTENCE_TERMINATORS = ['。', '！', '？', '；', '. ', '! ', '? ', '; ']

export function splitText(text: string, limit: number): string[] {
  if (limit <= 0) {
    throw new Error(`splitText limit must be positive, got ${limit}`)
  }
  if (text.length <= limit) {
    return text.length === 0 ? [] : [text]
  }

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > limit) {
    const cut = findSplitPoint(remaining, limit)
    const head = remaining.slice(0, cut).replace(/\s+$/u, '')
    if (head.length > 0) chunks.push(head)
    remaining = remaining.slice(cut).replace(/^\s+/u, '')
  }

  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

function findSplitPoint(text: string, limit: number): number {
  const minCut = Math.floor(limit * 0.5)
  const window = text.slice(0, limit)

  const paragraphIdx = window.lastIndexOf('\n\n')
  if (paragraphIdx >= minCut) return paragraphIdx + 2

  const lineIdx = window.lastIndexOf('\n')
  if (lineIdx >= minCut) return lineIdx + 1

  for (const term of SENTENCE_TERMINATORS) {
    const idx = window.lastIndexOf(term)
    if (idx >= minCut) return idx + term.length
  }

  const spaceIdx = window.lastIndexOf(' ')
  if (spaceIdx >= minCut) return spaceIdx + 1

  return safeHardCut(text, limit)
}

function safeHardCut(text: string, limit: number): number {
  if (limit >= text.length) return text.length
  const code = text.charCodeAt(limit - 1)
  if (code >= 0xd800 && code <= 0xdbff) return limit - 1
  return limit
}
