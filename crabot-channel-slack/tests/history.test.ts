import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RpcError } from 'crabot-shared'
import { SlackChannel } from '../src/slack-channel.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function setup(nativeId = 'C1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-history-'))
  dirs.push(dir)
  const api = { connected: true, call: vi.fn(async (_method: string, _args?: Record<string, unknown>): Promise<any> => ({ ok: true, messages: [], has_more: false })), start: vi.fn(), stop: vi.fn() }
  const channel = new SlackChannel({ module_id: 'slack-history', port: 0, data_dir: dir,
    env: { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' } }, api as any)
  ;(channel as any).identity = { team_id: 'T1', user_id: 'UCRAB', app_id: 'A1' }
  const events = vi.fn()
  ;(channel as any).rpcClient.publishEvent = events
  const store = (channel as any).store
  const session = store.upsert({ id: nativeId, is_im: nativeId.startsWith('D'), is_member: true }, 'room').session
  const rpc = (params: Record<string, unknown>) => Promise.resolve().then(() => (channel as any).methodHandlers.get('get_history')({ session_id: session.id, ...params }))
  const snapshot = () => JSON.stringify([...store.sessions.values()]) + fs.readdirSync(path.join(dir, 'messages')).map((f: string) => fs.readFileSync(path.join(dir, 'messages', f), 'utf8')).join('')
  return { api, channel, session, store, events, rpc, snapshot }
}
const raw = (ts: string, text = 'old chat', extra = {}) => ({ type: 'message', user: 'U1', ts, text, ...extra })

describe('Slack remote channel history', () => {
  it.each(['C1', 'GPRIVATE'])('reads pre-join and unmentioned remote messages in %s without replay or cache writes', async id => {
    const s = setup(id)
    s.api.call.mockResolvedValueOnce({ ok: true, messages: [raw('100.000001')], has_more: false } as any)
    const before = s.snapshot()
    const result = await s.rpc({ limit: 20 })
    expect(result.items.map((m: any) => m.platform_message_id)).toEqual(['100.000001'])
    expect(result.items[0].features.is_mention_crab).toBe(false)
    expect(s.api.call).toHaveBeenCalledWith('conversations.history', expect.objectContaining({ channel: id, limit: 50, inclusive: true }))
    expect(s.events).not.toHaveBeenCalled()
    expect(s.snapshot()).toBe(before)
    expect(s.store.messages(s.session.id, { max_days: 30, max_messages_per_session: 1000 })).toEqual([])
  })
  it('uses the remote result despite a nonempty cache and keeps detail/DM queries local', async () => {
    for (const id of ['C1', 'D1']) {
      const s = setup(id)
      const cached = { platform_message_id: 'local', sender: { platform_user_id: 'U1', platform_display_name: 'Alice' },
        content: { type: 'text', text: 'cached' }, features: { is_mention_crab: false }, platform_timestamp: new Date().toISOString() }
      s.store.append(s.session.id, cached, { max_days: 30, max_messages_per_session: 1000 })
      s.api.call.mockResolvedValueOnce({ ok: true, messages: [raw('100.1', 'remote')], has_more: false })
      const before = s.snapshot()
      const result = await s.rpc({})
      expect(result.items.map((m: any) => m.content.text)).toEqual([id === 'D1' ? 'cached' : 'remote'])
      expect(s.snapshot()).toBe(before)
      if (id === 'D1') expect(s.api.call).not.toHaveBeenCalled()
      const detail = (s.channel as any).methodHandlers.get('get_message')
      expect(detail({ session_id: s.session.id, platform_message_id: 'local' })).toEqual(cached)
      expect(() => detail({ session_id: s.session.id, platform_message_id: '100.1' })).toThrow('消息未保留')
    }
  })
  it('converts aliases, includes start, excludes end and preserves sub-millisecond ordering', async () => {
    const s = setup()
    const start = '1970-01-01T00:01:40.001Z', end = '1970-01-01T00:01:40.002Z'
    s.api.call.mockResolvedValue({ ok: true, messages: [raw('100.002000'), raw('100.001999'), raw('100.001001'), raw('100.001000'), raw('100.000999')], has_more: false })
    const result = await s.rpc({ time_range: { after: start, before: end } })
    expect(result.items.map((m: any) => m.platform_message_id)).toEqual(['100.001000', '100.001001', '100.001999'])
    expect(s.api.call).toHaveBeenCalledWith('conversations.history', { channel: 'C1', inclusive: true, limit: 50, oldest: '100.001000', latest: '100.002000' })
    expect((await s.rpc({ time_range: { start, end, after: '1970-01-01T01:01:40.001+01:00', before: end } })).items).toEqual(result.items)
  })
  it.each([
    { time_range: { start: 'bad' } }, { time_range: { after: 'bad' } },
    { time_range: { start: '2000-01-01', end: '2000-01-01' } },
    { time_range: { after: '2001-01-01', before: '2000-01-01' } },
    { time_range: { start: '2000-01-01', after: '2001-01-01' } },
    { time_range: { end: '2000-01-01', before: '2001-01-01' } },
    { limit: 0 }, { limit: 1.5 }, { pagination: { page: 0, page_size: 20 } },
    { pagination: { page: 1, page_size: 101 } }, { keyword: 123 },
  ])('rejects invalid parameters before any API request: %j', async params => {
    const s = setup()
    await expect(s.rpc(params)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(s.api.call).not.toHaveBeenCalled()
  })
  it('fixes the query upper bound across pages and returns an empty future window without an API request', async () => {
    const s = setup(), now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      s.api.call.mockImplementation(async (_method, args) => {
        clock.mockReturnValue(now + 10000)
        return args?.cursor ? { ok: true, messages: [raw('99.1')], has_more: false }
          : { ok: true, messages: [raw('100.1')], has_more: false, response_metadata: { next_cursor: 'next' } }
      })
      await s.rpc({ time_range: { end: new Date(now + 60000).toISOString() } })
      expect(s.api.call.mock.calls[0][1]?.latest).toBe(s.api.call.mock.calls[1][1]?.latest)
      s.api.call.mockClear()
      const result = await s.rpc({ limit: 20, time_range: { start: new Date(now + 20000).toISOString(), end: new Date(now + 60000).toISOString() } })
      expect(result).toEqual({ items: [], pagination: { page: 1, page_size: 20, total_items: 0, total_pages: 1 } })
      expect(s.api.call).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })
  it('finds the latest matching N across short pages, deduplicates and keeps a chronological result', async () => {
    const s = setup()
    const newer = Array.from({ length: 50 }, (_, i) => raw(`${200 - i}.000001`, i === 0 ? 'other' : 'MATCH'))
    const older = Array.from({ length: 15 }, (_, i) => raw(`${150 - i}.000001`, 'match'))
    s.api.call.mockResolvedValueOnce({ ok: true, messages: newer, has_more: true, response_metadata: { next_cursor: 'two' } })
      .mockResolvedValueOnce({ ok: true, messages: [newer[49], ...older], has_more: false, response_metadata: { next_cursor: 'three' } })
    const result = await s.rpc({ keyword: 'match', limit: 55, pagination: { page: 99, page_size: 1 } })
    expect(s.api.call).toHaveBeenCalledTimes(2)
    expect(result.items).toHaveLength(55)
    expect(result.items[0].platform_message_id).toBe('145.000001')
    expect(result.items[54].platform_message_id).toBe('199.000001')
    expect(result.pagination).toEqual({ page: 1, page_size: 55, total_items: 55, total_pages: 1 })
  })
  it('computes exact chronological pagination only after reading the entire range', async () => {
    const s = setup()
    s.api.call.mockResolvedValueOnce({ ok: true, messages: [raw('5.1'), raw('4.1')], response_metadata: { next_cursor: 'two' } })
      .mockResolvedValueOnce({ ok: true, messages: [raw('3.1'), raw('2.1'), raw('1.1')], has_more: false })
    const result = await s.rpc({ pagination: { page: 2, page_size: 2 } })
    expect(result.items.map((m: any) => m.platform_message_id)).toEqual(['3.1', '4.1'])
    expect(result.pagination).toEqual({ page: 2, page_size: 2, total_items: 5, total_pages: 3 })
  })
  it('keeps bot, mention, file and broadcast metadata but never fetches thread replies or user profiles', async () => {
    const s = setup()
    s.api.call.mockResolvedValueOnce({ ok: true, messages: [
      raw('6.1', '<@UCRAB> hi', { bot_id: 'B1', user: undefined, subtype: 'bot_message', bot_profile: { name: 'Other Bot' } }),
      raw('5.1', '', { files: [{ name: 'Secret.PDF' }], subtype: 'file_share' }),
      raw('4.1', 'broadcast', { thread_ts: '3.1', subtype: 'thread_broadcast' }),
      raw('2.1', 'joined', { subtype: 'channel_join' }),
    ], has_more: false })
    const result = await s.rpc({})
    expect(result.items).toHaveLength(3)
    expect(result.items[0].features.thread_id).toBe('3.1')
    expect(result.items[1].content.text).toBe('[附件未读取：Secret.PDF]')
    expect(result.items[2]).toMatchObject({ sender: { platform_user_id: 'B1', platform_display_name: 'Other Bot' }, features: { is_mention_crab: true } })
    expect(s.api.call.mock.calls.map(c => c[0])).toEqual(['conversations.history'])
  })
  it.each([
    { ok: true, messages: [], has_more: true },
    { ok: true, messages: [raw('100.1')], has_more: true, response_metadata: { next_cursor: 'same' } },
    { ok: true, messages: [raw('100.1')], has_more: true, response_metadata: { next_cursor: 'new' } },
    { ok: true, messages: [raw('100.1')], is_limited: true },
    { ok: true }, { ok: true, messages: [raw('invalid')] },
    { ok: true, messages: [raw('99.1', '', { user: undefined })] },
    { ok: false, error: 'fatal_error' },
  ])('does not return a successful partial result for an incomplete query: %j', async bad => {
    const s = setup()
    s.api.call.mockResolvedValueOnce({ ok: true, messages: [raw('100.1')], response_metadata: { next_cursor: 'same' } })
      .mockResolvedValue(bad)
    await expect(s.rpc({})).rejects.toMatchObject({ code: 'CHANNEL_HISTORY_UNAVAILABLE' })
    expect(s.api.call.mock.calls.length).toBeLessThanOrEqual(3)
  })
  it('bounds scanning at 20 pages and still succeeds when the last permitted page determines the result', async () => {
    const s = setup()
    s.api.call.mockImplementation(async (_method, args) => {
      const page = Number(args?.cursor || 0) + 1
      return { ok: true, messages: [raw(`${100 - page}.1`, page === 20 ? 'target' : 'other')], has_more: true, response_metadata: { next_cursor: String(page) } }
    })
    await expect(s.rpc({ keyword: 'missing', limit: 1 })).rejects.toMatchObject({ code: 'CHANNEL_HISTORY_UNAVAILABLE' })
    expect(s.api.call).toHaveBeenCalledTimes(20)
    s.api.call.mockClear()
    expect((await s.rpc({ keyword: 'target', limit: 1 })).items).toHaveLength(1)
    expect(s.api.call).toHaveBeenCalledTimes(20)
  })
  it.each(['PERMISSION_DENIED', 'UNAUTHORIZED', 'RATE_LIMITED', 'NOT_FOUND', 'SERVICE_UNAVAILABLE'])('preserves %s without fallback, retries or token leakage', async code => {
    const s = setup()
    s.api.call.mockRejectedValueOnce(new RpcError(code, 'SECRET_TOKEN', { retry_after: 60 }))
    await expect(s.rpc({})).rejects.toMatchObject({ code, details: { retry_after: 60 } })
    s.api.call.mockRejectedValueOnce(new RpcError(code, 'SECRET_TOKEN', { retry_after: 60 }))
    await expect(s.rpc({})).rejects.not.toThrow('SECRET_TOKEN')
    expect(s.api.call).toHaveBeenCalledTimes(2)
    expect(s.events).not.toHaveBeenCalled()
  })
  it.each(['missing_scope', 'invalid_auth', 'not_in_channel', 'channel_not_found', 'ratelimited'])('maps Slack ok=false %s as a failure', async error => {
    const s = setup()
    const codes: Record<string, string> = { missing_scope: 'PERMISSION_DENIED', invalid_auth: 'UNAUTHORIZED', not_in_channel: 'PERMISSION_DENIED', channel_not_found: 'NOT_FOUND', ratelimited: 'RATE_LIMITED' }
    s.api.call.mockResolvedValueOnce({ ok: false, error, needed: 'groups:history' })
    await expect(s.rpc({})).rejects.toMatchObject({ code: codes[error] })
  })
  it('keeps Retry-After visible in the error text passed through messaging tools', async () => {
    const s = setup()
    s.api.call.mockRejectedValueOnce(new RpcError('RATE_LIMITED', 'limited', { retry_after: 60 }))
    await expect(s.rpc({})).rejects.toThrow('60 秒后重试')
    expect(s.api.call).toHaveBeenCalledTimes(1)
  })
  it('only returns an empty match after completion and reports raw network errors safely', async () => {
    const s = setup()
    s.api.call.mockResolvedValueOnce({ ok: true, messages: [raw('100.1')], response_metadata: { next_cursor: 'two' } })
      .mockResolvedValueOnce({ ok: true, messages: [], has_more: false })
    expect((await s.rpc({ keyword: 'missing' })).items).toEqual([])
    expect(s.api.call).toHaveBeenCalledTimes(2)
    s.api.call.mockRejectedValueOnce(new Error('SECRET_TOKEN'))
    await expect(s.rpc({})).rejects.toMatchObject({ code: 'CHANNEL_HISTORY_UNAVAILABLE' })
    await expect(s.rpc({ session_id: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
