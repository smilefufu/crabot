import { RpcError } from 'crabot-shared'
import { messageFeatures, messageText } from './event-mapper.js'
import { platformError } from './slack-client.js'
import { paginate } from './store.js'
import type { HistoryMessage, PaginationParams, SlackApi, SlackHistoryMessage } from './types.js'

interface HistoryTimeRange { start?: string; end?: string; after?: string; before?: string }
export interface GetHistoryParams {
  session_id: string
  time_range?: HistoryTimeRange
  keyword?: string
  limit?: number
  pagination?: PaginationParams
}

export function normalizeHistoryTimeRange(range?: HistoryTimeRange) {
  if (!range) return undefined
  const parse = (value: string | undefined) => {
    if (value === undefined) return undefined
    const ms = typeof value === 'string' ? Date.parse(value) : NaN
    if (!Number.isFinite(ms)) throw new RpcError('INVALID_ARGUMENT', '历史时间必须是有效日期')
    return ms
  }
  const start = parse(range.start), after = parse(range.after), end = parse(range.end), before = parse(range.before)
  if ((start !== undefined && after !== undefined && start !== after) || (end !== undefined && before !== undefined && end !== before)) {
    throw new RpcError('INVALID_ARGUMENT', '历史时间别名与 start/end 冲突')
  }
  const from = start ?? after, to = end ?? before
  if (from !== undefined && to !== undefined && from >= to) throw new RpcError('INVALID_ARGUMENT', '历史时间必须满足 start < end')
  return { start: range.start ?? range.after, end: range.end ?? range.before }
}

function unavailable(reason: string): never { throw new RpcError('CHANNEL_HISTORY_UNAVAILABLE', `Slack 历史查询不可用：${reason}`) }
function timestamp(ts: string): bigint {
  if (typeof ts !== 'string' || !/^\d+\.\d{1,6}$/.test(ts)) unavailable('消息时间无效')
  const [seconds, fraction] = ts.split('.')
  return BigInt(seconds) * 1000000n + BigInt(fraction.padEnd(6, '0'))
}
function slackTime(ms: number) { return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}000` }
function mapMessage(raw: SlackHistoryMessage, botUserId: string, time: bigint): HistoryMessage | undefined {
  if (raw.type !== 'message' || raw.hidden || (raw.subtype && !['bot_message', 'file_share', 'thread_broadcast', 'me_message'].includes(raw.subtype))) return undefined
  const sender = raw.user || raw.bot_id
  const text = messageText(raw)
  if (!sender || !text || (raw.thread_ts !== undefined && !/^\d+\.\d{1,6}$/.test(raw.thread_ts))) unavailable('聊天消息缺少可读取的正文、发送者或有效关系')
  const ms = Number(time / 1000n)
  if (!Number.isFinite(new Date(ms).getTime())) unavailable('消息时间超出支持范围')
  return {
    platform_message_id: raw.ts!,
    sender: { platform_user_id: sender, platform_display_name: raw.bot_profile?.name || raw.username || sender },
    content: { type: 'text', text }, features: messageFeatures(raw, botUserId),
    platform_timestamp: new Date(ms).toISOString(),
  }
}

export async function queryChannelHistory(api: SlackApi, conversationId: string, botUserId: string, params: GetHistoryParams) {
  // Validate before platform access; limit keeps its existing precedence over pagination.
  paginate([], params.pagination, params.limit)
  if (params.keyword !== undefined && typeof params.keyword !== 'string') throw new RpcError('INVALID_ARGUMENT', '历史关键词必须为字符串')
  const started = Date.now(), range = normalizeHistoryTimeRange(params.time_range)
  const start = range?.start === undefined ? undefined : Date.parse(range.start)
  const end = Math.min(range?.end === undefined ? started : Date.parse(range.end), started)
  const lower = start === undefined ? 0n : BigInt(start) * 1000n, upper = BigInt(end) * 1000n
  const items: Array<{ message: HistoryMessage; time: bigint }> = []
  const finish = () => paginate(items.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0).map(i => i.message), params.pagination, params.limit)
  if (lower >= upper) return finish()
  const keyword = params.keyword?.toLowerCase(), ids = new Set<string>(), cursors = new Set<string>()
  let cursor = ''
  for (let page = 0; page < 20; page++) {
    let result
    try {
      result = await api.call('conversations.history', { channel: conversationId, limit: 50, inclusive: true,
        latest: slackTime(end), ...(start === undefined ? {} : { oldest: slackTime(Math.max(0, start)) }), ...(cursor ? { cursor } : {}) })
      if (result.ok !== true) throw platformError({ data: result }, 'CHANNEL_HISTORY_UNAVAILABLE')
    } catch (error) {
      if (error instanceof RpcError) {
        let hint = '请根据错误稍后重试或检查渠道配置'
        if (error.code === 'PERMISSION_DENIED') hint = '检查 history scope 并重新授权，确认 Bot 已加入频道'
        if (error.code === 'RATE_LIMITED') {
          const seconds = Number(error.details?.retry_after)
          hint = Number.isFinite(seconds) && seconds > 0 ? `平台限流，请在 ${seconds} 秒后重试` : '平台限流，请稍后重试'
        }
        throw new RpcError(error.code, `Slack 历史查询失败：${hint}`, error.details)
      }
      unavailable('平台请求失败，请稍后重试')
    }
    if (result.is_limited) unavailable('平台历史受限，不能确认所需范围')
    if (!Array.isArray(result.messages)) unavailable('平台未返回消息列表')
    let added = 0
    const messages = result.messages.map(raw => {
      if (!raw || typeof raw !== 'object') unavailable('平台返回无效消息')
      return { raw, time: timestamp(raw.ts!) }
    }).sort((a, b) => a.time > b.time ? -1 : a.time < b.time ? 1 : 0)
    for (const { raw, time } of messages) {
      if (ids.has(raw.ts!)) continue
      ids.add(raw.ts!); added++
      if (time < lower || time >= upper) continue
      const message = mapMessage(raw, botUserId, time)
      if (!message || (keyword && !message.content.text!.toLowerCase().includes(keyword))) continue
      items.push({ message, time })
      if (params.limit !== undefined && items.length >= params.limit) return finish()
    }
    const next = result.response_metadata?.next_cursor?.trim() || ''
    if (!next && result.has_more !== true) return finish()
    if (!next || cursors.has(next) || (result.messages.length > 0 && added === 0)) unavailable('分页无进展，请缩小时间范围')
    cursors.add(next); cursor = next
  }
  unavailable('超过 20 页查询预算，请缩小时间范围')
}
