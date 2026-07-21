/**
 * UTF-8 byte-aware string truncation helpers.
 *
 * 三处共用：
 *   - tool-orchestration.ts：所有工具结果统一兜底（100KB），防止任何工具忘记自截断
 *   - LLM adapters（anthropic / openai / openai-responses）：normalize 阶段最后防线（9MB），
 *     避免 OpenAI Responses API 单字符串 10MB 协议上限触发整轮失败
 *   - 单个工具自截断（如 Grep）也可用 `byteLength` 累计判断
 *
 * 为什么按 UTF-8 byte 算而不是 char count：
 *   OpenAI Responses 的 `string_above_max_length` 错误消息里 length 是 UTF-8 byte 数，
 *   1 个中文字符 = 3 bytes。按 char 截断会高估容量。
 */

/** UTF-8 byte length of a string. */
export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * 把字符串截断到不超过 maxBytes 个 UTF-8 字节，避免在多字节字符中间切。
 * 流式扫描 code point，不物化整个 Buffer——避免对 72MB 这种大字符串吃掉 O(n) 临时内存。
 */
export function truncateUtf8(s: string, maxBytes: number): string {
  let bytes = 0
  let end = 0
  for (const ch of s) {
    const chBytes = Buffer.byteLength(ch, 'utf8')
    if (bytes + chBytes > maxBytes) break
    bytes += chBytes
    end += ch.length // surrogate pair → 2，否则 1
  }
  return end === 0 ? '' : s.slice(0, end)
}

/**
 * 保留尾部版本的 truncateUtf8：从末尾向前取不超过 maxBytes 个字节，不切多字节字符。
 * 供「错误信息通常在结尾」的截断场景（如 Bash 输出）使用。
 */
export function truncateUtf8Tail(s: string, maxBytes: number): string {
  const total = Buffer.byteLength(s, 'utf8')
  if (total <= maxBytes) return s
  // 至少要跳过的前导字节数；逐 code point 前进到累计 ≥ skip，保证不切多字节字符
  const skip = total - maxBytes
  let bytes = 0
  let idx = 0
  for (const ch of s) {
    if (bytes >= skip) break
    bytes += Buffer.byteLength(ch, 'utf8')
    idx += ch.length // surrogate pair → 2，否则 1
  }
  return s.slice(idx)
}

export interface CapResult {
  readonly content: string
  readonly truncated: boolean
  /** 原始字节数（仅在 truncated=true 时设置）。 */
  readonly originalBytes?: number
}

/**
 * 截断到 maxBytes，超出时在末尾追加截断标记。
 * 标记本身也算进 maxBytes，防止额外溢出。
 */
export function capWithMarker(
  s: string,
  maxBytes: number,
  markerBuilder: (originalBytes: number) => string,
): CapResult {
  const original = byteLength(s)
  if (original <= maxBytes) {
    return { content: s, truncated: false }
  }

  const marker = markerBuilder(original)
  const markerBytes = byteLength(marker)
  // 极端：marker 本身就比 cap 大，直接返回 marker（应该不会发生，写法防御）
  if (markerBytes >= maxBytes) {
    return { content: marker, truncated: true, originalBytes: original }
  }

  const head = truncateUtf8(s, maxBytes - markerBytes)
  return { content: head + marker, truncated: true, originalBytes: original }
}
