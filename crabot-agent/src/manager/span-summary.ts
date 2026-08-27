/**
 * Manager episode span 摘要的结构化截断。
 *
 * span details 的 input_summary/output_summary 的消费方是 Admin 观测页与
 * episode-projection 的人话投影（extractStringField 按字段提取 worker_id/title/content）。
 * 因此摘要必须保持结构完整：
 * - input 是协议约束的固定结构对象——仅名单内长文本字段（text/prompt/content）超限截断，
 *   worker_id 等标识符字段无条件全保，产物恒为合法 JSON；
 * - output 是工具回执，固定形态为 `[HH:MM:SS]\n{json}`（JSON 部分同样字段级处理），
 *   纯文本错误信息整段截断兜底。
 *
 * 历史背景：曾对两者做 300 字符整段硬截，会把 JSON 尾部的 worker_id 切成带「…」的
 * 残缺前缀，投影层把该前缀当真 ID 写进 actions 造成 Admin 死链（2026-08 修复）。
 */

const INPUT_TRUNCATED_FIELDS: ReadonlySet<string> = new Set(['text', 'prompt', 'content'])
const FIELD_MAX_CHARS = 1024
const OUTPUT_MAX_CHARS = 4096

function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function summarizeFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      INPUT_TRUNCATED_FIELDS.has(key) && typeof field === 'string'
        ? truncateText(field, FIELD_MAX_CHARS)
        : field,
    ]),
  )
}

function trySummarizeJson(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return JSON.stringify(summarizeFields(parsed as Record<string, unknown>))
  } catch {
    return undefined
  }
}

/** 工具入参摘要：固定结构对象做字段级截断；非对象防御性退化为整段截断。 */
export function summarizeSpanInput(input: unknown): string {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return JSON.stringify(summarizeFields(input as Record<string, unknown>))
  }
  return truncateText(typeof input === 'string' ? input : String(input), OUTPUT_MAX_CHARS)
}

/** 工具回执摘要：整体或首行前缀后的 JSON 做字段级截断；纯文本整段截断兜底。 */
export function summarizeSpanOutput(output: string): string {
  const direct = trySummarizeJson(output)
  if (direct !== undefined) return direct
  const newlineAt = output.indexOf('\n')
  if (newlineAt >= 0) {
    const inner = trySummarizeJson(output.slice(newlineAt + 1))
    if (inner !== undefined) return output.slice(0, newlineAt + 1) + inner
  }
  return truncateText(output, OUTPUT_MAX_CHARS)
}
