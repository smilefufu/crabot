/**
 * text-splitter - 超长文本按语义边界切分
 *
 * 钉钉单条消息有长度上限；出站文本超长时按段落 > 换行 > 句末 > 空格的优先级
 * 找切点，找不到才硬切。与 feishu / telegram 的切分思路一致。
 */

const SENTENCE_ENDINGS = /[。！？.!?]/

/** 在 [0, maxLen] 范围内为 text 找一个尽量靠后的语义切点，返回切分下标（exclusive）。 */
function findCut(text: string, maxLen: number): number {
  const window = text.slice(0, maxLen)

  // 1) 段落边界（连续换行）
  const paraIdx = window.lastIndexOf('\n\n')
  if (paraIdx > maxLen * 0.5) return paraIdx + 2

  // 2) 单个换行
  const nlIdx = window.lastIndexOf('\n')
  if (nlIdx > maxLen * 0.5) return nlIdx + 1

  // 3) 句末标点
  for (let i = window.length - 1; i > maxLen * 0.5; i--) {
    if (SENTENCE_ENDINGS.test(window[i])) return i + 1
  }

  // 4) 空格
  const spaceIdx = window.lastIndexOf(' ')
  if (spaceIdx > maxLen * 0.5) return spaceIdx + 1

  // 5) 硬切
  return maxLen
}

/**
 * 把 text 切成每段不超过 maxLen 的数组。
 * text 为空返回 []；不超长返回 [text]。
 */
export function splitText(text: string, maxLen: number): string[] {
  if (!text) return []
  if (maxLen <= 0 || text.length <= maxLen) return [text]

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxLen) {
    const cut = findCut(remaining, maxLen)
    const piece = remaining.slice(0, cut).replace(/\s+$/, '')
    if (piece) chunks.push(piece)
    remaining = remaining.slice(cut).replace(/^\s+/, '')
  }
  if (remaining) chunks.push(remaining)
  return chunks.length ? chunks : [text]
}
