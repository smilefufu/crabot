const FALLBACK_TIMEZONE = 'Asia/Shanghai'

const validTimezoneCache = new Set<string>()

function isValidTimezone(tz: string): boolean {
  if (validTimezoneCache.has(tz)) return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    validTimezoneCache.add(tz)
    return true
  } catch {
    return false
  }
}

export function resolveTimezone(configured?: string): string {
  const candidate = (configured && configured.trim().length > 0)
    ? configured.trim()
    : (process.env.CRABOT_DEFAULT_TIMEZONE && process.env.CRABOT_DEFAULT_TIMEZONE.trim().length > 0)
      ? process.env.CRABOT_DEFAULT_TIMEZONE.trim()
      : FALLBACK_TIMEZONE
  return isValidTimezone(candidate) ? candidate : FALLBACK_TIMEZONE
}

const WEEKDAY_ZH: Record<string, string> = {
  Sun: '周日', Mon: '周一', Tue: '周二', Wed: '周三',
  Thu: '周四', Fri: '周五', Sat: '周六',
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>()
const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>()

function getPartsFormatter(timezone: string): Intl.DateTimeFormat {
  let fmt = partsFormatterCache.get(timezone)
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    partsFormatterCache.set(timezone, fmt)
  }
  return fmt
}

function getOffsetFormatter(timezone: string): Intl.DateTimeFormat {
  let fmt = offsetFormatterCache.get(timezone)
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    offsetFormatterCache.set(timezone, fmt)
  }
  return fmt
}

interface DateParts {
  year: string
  month: string
  day: string
  hour: string
  minute: string
  second: string
  weekday: string
}

function getParts(date: Date, timezone: string): DateParts {
  const out: Record<string, string> = {
    year: '', month: '', day: '', hour: '', minute: '', second: '', weekday: '',
  }
  for (const p of getPartsFormatter(timezone).formatToParts(date)) {
    if (p.type === 'literal') continue
    if (p.type === 'weekday') out.weekday = WEEKDAY_ZH[p.value] ?? ''
    else if (p.type in out) out[p.type] = p.value
  }
  return out as unknown as DateParts
}

function getOffset(date: Date, timezone: string): string {
  for (const p of getOffsetFormatter(timezone).formatToParts(date)) {
    if (p.type === 'timeZoneName') {
      const m = p.value.match(/GMT([+-]\d{2}:\d{2})?/)
      if (m) return m[1] ?? '+00:00'
    }
  }
  return '+00:00'
}

function sameDate(a: DateParts, b: DateParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day
}

/**
 * 完整时间字符串，用于 user message 顶部建立日期/时区基准。
 * 例：`2026-04-29 周三 18:30:00 +08:00 (Asia/Shanghai)`
 */
export function formatNow(timezone: string, now: Date = new Date()): string {
  const p = getParts(now, timezone)
  const offset = getOffset(now, timezone)
  return `${p.year}-${p.month}-${p.day} ${p.weekday} ${p.hour}:${p.minute}:${p.second} ${offset} (${timezone})`
}

/**
 * 紧凑时间戳 `HH:MM:SS`，用于 tool_result 头部。
 * 跨日不显式标注——日期 / 时区基准来自 user message 顶部的 formatNow 输出，
 * LLM 通过工具调用顺序自然推断跨日切换。
 */
export function formatToolTimestamp(timezone: string, now: Date = new Date()): string {
  const p = getParts(now, timezone)
  return `${p.hour}:${p.minute}:${p.second}`
}

/**
 * Channel 消息时间戳，用于历史消息列表条目前缀。
 * 同日 `HH:MM`，跨日 `MM-DD HH:MM`，跨年 `YYYY-MM-DD HH:MM`。
 * 输入 ISO 8601 字符串（platform_timestamp）。
 */
export function formatChannelMessageTime(isoTimestamp: string, timezone: string, now: Date = new Date()): string {
  const ts = new Date(isoTimestamp)
  if (Number.isNaN(ts.getTime())) return ''
  const p = getParts(ts, timezone)
  const today = getParts(now, timezone)
  if (sameDate(p, today)) return `${p.hour}:${p.minute}`
  if (p.year === today.year) return `${p.month}-${p.day} ${p.hour}:${p.minute}`
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/**
 * 任务创建时间渲染。同日 `HH:MM`，跨日 `MM-DD HH:MM`。
 * 输入毫秒时间戳。
 */
export function formatTaskCreatedAt(epochMs: number, timezone: string, now: Date = new Date()): string {
  const ts = new Date(epochMs)
  if (Number.isNaN(ts.getTime())) return ''
  const p = getParts(ts, timezone)
  const today = getParts(now, timezone)
  if (sameDate(p, today)) return `${p.hour}:${p.minute}`
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/**
 * 给 tool_result 内容加上 `[HH:MM:SS]\n` 时间戳头部。
 * Front loop 和 Engine tool-orchestration 共用，确保格式一致。
 */
export function stampToolResult(content: string, timezone: string, now: Date = new Date()): string {
  return `[${formatToolTimestamp(timezone, now)}]\n${content}`
}
