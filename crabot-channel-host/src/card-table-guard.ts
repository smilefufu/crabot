/**
 * 飞书消息卡片表格数量限制保护
 *
 * 飞书卡片每张最多支持 5 个表格组件。当 markdown 文本中包含的表格超过此限制时，
 * 需要拆分为多段文本分别发送，避免飞书 API 返回 230099 错误。
 */

const FEISHU_CARD_TABLE_LIMIT = 5
const TABLE_SEPARATOR_PATTERN = /^\|[-:| ]+\|$/gm

function countMarkdownTables(text: string): number {
  const matches = text.match(TABLE_SEPARATOR_PATTERN)
  return matches ? matches.length : 0
}

/**
 * 按表格数量拆分 markdown 文本，每段不超过飞书卡片的 5 表格上限。
 * 无表格或未超限时原样返回单元素数组。
 */
export function splitTextByTableLimit(text: string): string[] {
  if (!text.includes('|') || countMarkdownTables(text) <= FEISHU_CARD_TABLE_LIMIT) {
    return [text]
  }

  const paragraphs = text.split(/\n{2,}/)
  const chunks: string[] = []
  let currentParagraphs: string[] = []
  let currentTableCount = 0

  for (const paragraph of paragraphs) {
    const tablesInParagraph = countMarkdownTables(paragraph)

    if (currentTableCount + tablesInParagraph > FEISHU_CARD_TABLE_LIMIT && currentParagraphs.length > 0) {
      chunks.push(currentParagraphs.join('\n\n'))
      currentParagraphs = []
      currentTableCount = 0
    }

    currentParagraphs.push(paragraph)
    currentTableCount += tablesInParagraph
  }

  if (currentParagraphs.length > 0) {
    chunks.push(currentParagraphs.join('\n\n'))
  }

  return chunks
}
