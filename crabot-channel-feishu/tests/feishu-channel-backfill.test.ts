/**
 * FeishuChannel backfill_history 测试
 *
 * 覆盖：
 * - 群 session 才能 backfill；private session 抛 INVALID_ARGUMENT
 * - dedup：已有 platform_message_id 跳过
 * - max_count 上限：超过即停止分页
 * - has_more：飞书还有更多分页时返回 true
 * - 并发互斥：同 session 第二次调用抛 CONFLICT
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { formatHandlerError } from 'crabot-shared/dist/module-base.js'

vi.mock('@larksuiteoapi/node-sdk', () => {
  return {
    Domain: { Feishu: 'feishu', Lark: 'lark' },
    Client: class MockLarkClient {
      im = {}
      contact = { v3: { user: {} } }
      request = vi.fn()
    },
    WSClient: class MockWSClient {
      start() { return Promise.resolve() }
      close() { return Promise.resolve() }
    },
    EventDispatcher: class MockEventDispatcher {
      register() { return this }
    },
  }
})

import { FeishuChannel } from '../src/feishu-channel.js'
import type { GetHistoryParams, GetMessageParams, HistoryMessage } from '../src/types.js'
import type { MessageStore } from '../src/message-store.js'

interface BackfillResult {
  session_id: string
  backfilled_count: number
  skipped_count: number
  has_more: boolean
  oldest_ts?: string
  newest_ts?: string
}

interface ChannelInternals {
  messageStore: MessageStore
  client: {
    listMessages: (...args: unknown[]) => Promise<{ items: Array<Record<string, unknown>>; page_token?: string; has_more: boolean }>
    getMessage?: (messageId: string) => Promise<Record<string, unknown> | null>
  }
  sessionManager: {
    upsertGroupSessionFromSnapshot: (p: { platform_session_id: string; title: string; participants: Array<{ platform_user_id: string; role: 'member' }> }) => { session: { id: string }; created: boolean }
    upsert: (p: { platform_session_id: string; type: 'private'; title: string; sender_id: string; sender_name: string }) => { session: { id: string }; created: boolean }
  }
  backfillHistory: (params: { session_id: string; max_count?: number; after?: string; before?: string }) => Promise<BackfillResult>
  handleGetHistory: (params: GetHistoryParams) => Promise<{ items: HistoryMessage[]; pagination: { page: number; page_size: number; total_items: number; total_pages: number } }>
  handleGetMessage: (params: GetMessageParams) => Promise<HistoryMessage>
}

let tmpDir: string
let channel: FeishuChannel

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-backfill-'))
  channel = new FeishuChannel({
    module_id: 'feishu-test',
    module_type: 'channel',
    version: '0.0.1',
    protocol_version: '0.1.0',
    port: 0,
    data_dir: tmpDir,
    feishu: {
      app_id: 'a',
      app_secret: 's',
      domain: 'feishu',
      only_respond_to_mentions: true,
      markdown_format: 'auto',
    },
  })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeFeishuMsg(id: string, text: string, createTimeMs: number) {
  return {
    message_id: id,
    msg_type: 'text',
    create_time: String(createTimeMs),
    sender: { id: 'ou_alice' },
    body: { content: JSON.stringify({ text }) },
  }
}

function makeFeishuFileMsg(id: string, fileKey: string, fileName: string, fileSize: number, createTimeMs: number, parentId?: string, rootId?: string) {
  return {
    message_id: id,
    msg_type: 'file',
    create_time: String(createTimeMs),
    sender: { id: 'ou_alice' },
    body: { content: JSON.stringify({ file_key: fileKey, file_name: fileName, file_size: fileSize }) },
    ...(parentId ? { parent_id: parentId } : {}),
    ...(rootId ? { root_id: rootId } : {}),
  }
}

describe('remote history query', () => {
  let sessionId: string
  let internals: ChannelInternals

  beforeEach(async () => {
    internals = channel as unknown as ChannelInternals
    sessionId = internals.sessionManager.upsert({
      platform_session_id: 'ou_history', type: 'private', title: 'History',
      sender_id: 'ou_history', sender_name: 'History',
    }).session.id
    for (let i = 0; i < 30; i++) {
      await internals.messageStore.append(sessionId, {
        platform_message_id: `history-${i}`,
        platform_timestamp: new Date(Date.UTC(2026, 8, 12, 0, i)).toISOString(),
        sender: { platform_user_id: 'ou_history', platform_display_name: 'History' },
        content: { type: 'text', text: `${i % 2 ? 'odd' : 'even'} ${i}` },
        features: { is_mention_crab: false }, direction: 'inbound',
      })
    }
    internals.client = {
      getMessage: vi.fn().mockResolvedValue({ chat_id: 'oc_history' }),
      listMessages: vi.fn().mockResolvedValue({
        items: Array.from({ length: 30 }, (_, i) => makeFeishuMsg(
          `history-${29 - i}`, `${(29 - i) % 2 ? 'odd' : 'even'} ${29 - i}`, Date.UTC(2026, 8, 12, 0, 29 - i),
        )), has_more: false,
      }),
    }
  })

  it('returns the latest remote messages with capped result counts, even when local history exists', async () => {
    const result = await internals.handleGetHistory({ session_id: sessionId, limit: 3 })
    expect(result.items.map(m => m.platform_message_id)).toEqual(['history-27', 'history-28', 'history-29'])
    expect(result.pagination).toEqual({ page: 1, page_size: 3, total_items: 3, total_pages: 1 })
    expect(internals.client.listMessages).toHaveBeenCalledWith(expect.objectContaining({ container_id: 'oc_history' }))
  })

  it('applies time and keyword filters before selecting the latest messages', async () => {
    const result = await internals.handleGetHistory({
      session_id: sessionId, limit: 2, keyword: 'even',
      time_range: { after: '2026-09-12T00:10:00Z', before: '2026-09-12T00:24:00Z' },
    })
    expect(result.items.map(m => m.platform_message_id)).toEqual(['history-22', 'history-24'])
    expect(result.pagination.total_items).toBe(2)
  })

  it('gives limit precedence over both pagination fields', async () => {
    const result = await internals.handleGetHistory({
      session_id: sessionId, limit: 3, pagination: { page: 2, page_size: 1 },
    })
    expect(result.items.map(m => m.platform_message_id)).toEqual(['history-27', 'history-28', 'history-29'])
    expect(result.pagination).toMatchObject({ page: 1, page_size: 3 })
  })

  it('preserves default and explicit pagination when limit is absent', async () => {
    const first = await internals.handleGetHistory({ session_id: sessionId })
    expect(first.items).toHaveLength(20)
    expect(first.items[0].platform_message_id).toBe('history-0')
    const page = await internals.handleGetHistory({ session_id: sessionId, pagination: { page: 2, page_size: 3 } })
    expect(page.items.map(m => m.platform_message_id)).toEqual(['history-3', 'history-4', 'history-5'])
  })

  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid limit %s', async (limit) => {
    await expect(internals.handleGetHistory({ session_id: sessionId, limit })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('resolves old private sessions using recent distinct message IDs without changing identity or writing history', async () => {
    const before = await internals.messageStore.query({ sessionId })
    const getMessage = vi.fn().mockRejectedValueOnce(new Error('deleted')).mockResolvedValueOnce({ chat_id: 'oc_old' })
    internals.client.getMessage = getMessage
    internals.client.listMessages = vi.fn().mockResolvedValue({
      items: [makeFeishuMsg('august', 'remote only', Date.UTC(2026, 7, 26))], has_more: false,
    })
    const result = await internals.handleGetHistory({ session_id: sessionId, time_range: { before: '2026-08-27T00:00:00Z' } })
    expect(result.items.map(m => m.platform_message_id)).toEqual(['august'])
    expect(getMessage.mock.calls).toEqual([['history-29'], ['history-28']])
    expect(internals.client.listMessages).toHaveBeenCalledWith(expect.objectContaining({ container_id: 'oc_old' }))
    expect(await internals.messageStore.query({ sessionId })).toEqual(before)
    expect(internals.sessionManager.upsert({ platform_session_id: 'ou_history', type: 'private', title: 'History', sender_id: 'ou_history', sender_name: 'History' }).session.id).toBe(sessionId)
    await internals.handleGetHistory({ session_id: sessionId, limit: 1 })
    expect(getMessage).toHaveBeenCalledTimes(2)
  })

  it('tries at most three distinct candidates, and fails explicitly if chat_id cannot be resolved', async () => {
    const newest = (await internals.messageStore.query({ sessionId, limit: 1 })).items[0]
    await internals.messageStore.append(sessionId, newest)
    const getMessage = vi.fn().mockResolvedValue({})
    internals.client.getMessage = getMessage
    await expect(internals.handleGetHistory({ session_id: sessionId })).rejects.toMatchObject({ code: 'CHANNEL_HISTORY_UNAVAILABLE' })
    expect(getMessage.mock.calls).toEqual([['history-29'], ['history-28'], ['history-27']])
    expect(internals.client.listMessages).not.toHaveBeenCalled()
  })

  it('does not silently serve the local fragment after a remote failure', async () => {
    internals.client.listMessages = vi.fn().mockRejectedValue(new Error('rate limit exceeded'))
    await expect(internals.handleGetHistory({ session_id: sessionId })).rejects.toThrow('rate limit exceeded')
  })

  it('uses the real inbound chat_id while keeping the private open_id identity', async () => {
    const raw = channel as any
    internals.client.getMessage = vi.fn().mockRejectedValue(new Error('must not resolve a cached chat'))
    raw.client.getUser = vi.fn().mockResolvedValue({ name: 'History' })
    vi.spyOn(raw.rpcClient, 'publishEvent').mockResolvedValue(undefined)
    await raw.handleMessageReceive({
      sender: { sender_id: { open_id: 'ou_history' }, sender_type: 'user' },
      message: { message_id: 'inbound', chat_id: 'oc_actual', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hi' }), create_time: String(Date.now()) },
    })
    await internals.handleGetHistory({ session_id: sessionId, limit: 1 })
    expect(internals.client.getMessage).not.toHaveBeenCalled()
    expect(internals.client.listMessages).toHaveBeenCalledWith(expect.objectContaining({ container_id: 'oc_actual' }))
    expect(raw.sessionManager.findById(sessionId).platform_session_id).toBe('ou_history')
  })

  it('fails explicitly for a private session with no message IDs to resolve', async () => {
    const empty = internals.sessionManager.upsert({ platform_session_id: 'ou_empty', type: 'private', title: 'Empty', sender_id: 'ou_empty', sender_name: 'Empty' }).session.id
    await expect(internals.handleGetHistory({ session_id: empty })).rejects.toMatchObject({ code: 'CHANNEL_HISTORY_UNAVAILABLE', message: expect.stringContaining('no local message IDs') })
    expect(internals.client.getMessage).not.toHaveBeenCalled()
    expect(internals.client.listMessages).not.toHaveBeenCalled()
  })
})

describe('history completeness and pagination', () => {
  let internals: ChannelInternals
  let sessionId: string
  const base = Date.UTC(2026, 7, 26)

  beforeEach(() => {
    internals = channel as unknown as ChannelInternals
    sessionId = internals.sessionManager.upsertGroupSessionFromSnapshot({ platform_session_id: 'oc_remote', title: 'Remote', participants: [] }).session.id
  })

  it('filters across pages, including filenames, deduplicates IDs and returns chronological results', async () => {
    const listMessages = vi.fn()
      .mockResolvedValueOnce({ items: [makeFeishuMsg('new', 'MATCH', base + 3_000), makeFeishuMsg('other', 'no', base + 2_000)], has_more: true, page_token: 'next' })
      .mockResolvedValueOnce({ items: [makeFeishuMsg('new', 'MATCH', base + 3_000), makeFeishuFileMsg('file', 'fk', 'match.pdf', 10, base + 1_000)], has_more: true, page_token: 'last' })
    internals.client = { listMessages }
    const result = await internals.handleGetHistory({ session_id: sessionId, keyword: 'MaTcH', limit: 2 })
    expect(result.items.map(m => m.platform_message_id)).toEqual(['file', 'new'])
    expect(listMessages).toHaveBeenCalledTimes(2)
    expect(listMessages.mock.calls[0][0]).toMatchObject({ container_id: 'oc_remote', page_size: 50, sort_type: 'ByCreateTimeDesc' })
    expect(listMessages.mock.calls[1][0]).toMatchObject({ page_token: 'next', end_time: listMessages.mock.calls[0][0].end_time })
    expect((await internals.messageStore.query({ sessionId })).items).toEqual([])
  })

  it('supports limits above 50 and equal timestamps without losing distinct messages', async () => {
    const listMessages = vi.fn()
      .mockResolvedValueOnce({ items: Array.from({ length: 50 }, (_, i) => makeFeishuMsg(`new-${i}`, 'text', base + 1_000)), has_more: true, page_token: 'next' })
      .mockResolvedValueOnce({ items: Array.from({ length: 20 }, (_, i) => makeFeishuMsg(`old-${i}`, 'text', base)), has_more: false })
    internals.client = { listMessages }
    const result = await internals.handleGetHistory({ session_id: sessionId, limit: 60 })
    expect(result.items).toHaveLength(60)
    expect(new Set(result.items.map(m => m.platform_message_id)).size).toBe(60)
    expect(result.items.slice(0, 10).every(m => m.platform_message_id.startsWith('old-'))).toBe(true)
    expect(result.pagination).toEqual({ page: 1, page_size: 60, total_items: 60, total_pages: 1 })
  })

  it.each([0, 100])('rounds remote time bounds outward and filters inclusive boundaries (after %s ms)', async (afterMs) => {
    const listMessages = vi.fn().mockResolvedValue({ items: [901, 900, afterMs, afterMs - 1].map(ms => makeFeishuMsg(`m-${ms}`, 'text', base + ms)), has_more: false })
    internals.client = { listMessages }
    const result = await internals.handleGetHistory({ session_id: sessionId, time_range: { after: new Date(base + afterMs).toISOString(), before: new Date(base + 900).toISOString() } })
    expect(listMessages).toHaveBeenCalledWith(expect.objectContaining({ start_time: String(base / 1000 - (afterMs === 0 ? 1 : 0)), end_time: String(base / 1000 + 1) }))
    expect(result.items.map(m => m.platform_message_id)).toEqual([`m-${afterMs}`, 'm-900'])
  })

  it('reads the entire range before applying legacy pagination and exact totals', async () => {
    const listMessages = vi.fn()
      .mockResolvedValueOnce({ items: [4, 3].map(i => makeFeishuMsg(`m-${i}`, 'text', base + i)), has_more: true, page_token: 'next' })
      .mockResolvedValueOnce({ items: [2, 1].map(i => makeFeishuMsg(`m-${i}`, 'text', base + i)), has_more: false })
    internals.client = { listMessages }
    const result = await internals.handleGetHistory({ session_id: sessionId, pagination: { page: 2, page_size: 2 } })
    expect(result.items.map(m => m.platform_message_id)).toEqual(['m-3', 'm-4'])
    expect(result.pagination).toEqual({ page: 2, page_size: 2, total_items: 4, total_pages: 2 })
  })

  it('returns empty only after a complete remote query', async () => {
    internals.client = { listMessages: vi.fn().mockResolvedValue({ items: [], has_more: false }) }
    expect((await internals.handleGetHistory({ session_id: sessionId })).items).toEqual([])
    expect(internals.client.listMessages).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, 'repeat'])('rejects missing or repeated cursors (%s)', async (token) => {
    internals.client = { listMessages: vi.fn().mockResolvedValue({ items: [], has_more: true, page_token: token }) }
    const response = await internals.handleGetHistory({ session_id: sessionId }).catch(error => formatHandlerError(error, 'history-query'))
    expect(response).toMatchObject({ success: false, error: { code: 'CHANNEL_HISTORY_UNAVAILABLE' } })
    expect(internals.client.listMessages).toHaveBeenCalledTimes(token ? 2 : 1)
  })

  it.each([undefined, 1])('fails at the page budget when the requested result is still incomplete (limit %s)', async (limit) => {
    const listMessages = vi.fn().mockImplementation(async () => ({ items: [], has_more: true, page_token: String(listMessages.mock.calls.length) }))
    internals.client = { listMessages }
    await expect(internals.handleGetHistory({ session_id: sessionId, limit })).rejects.toMatchObject({ code: 'CHANNEL_HISTORY_UNAVAILABLE' })
    expect(listMessages).toHaveBeenCalledTimes(20)
  })

  it.each([false, true])('allows completion at the page budget (limit reached: %s)', async (limitReached) => {
    const listMessages = vi.fn().mockImplementation(async () => {
      const last = listMessages.mock.calls.length === 20
      return { items: last ? [makeFeishuMsg('last', 'match', base)] : [], has_more: !last || limitReached, page_token: String(listMessages.mock.calls.length) }
    })
    internals.client = { listMessages }
    expect((await internals.handleGetHistory({ session_id: sessionId, limit: limitReached ? 1 : undefined })).items.map(m => m.platform_message_id)).toEqual(['last'])
    expect(listMessages).toHaveBeenCalledTimes(20)
  })

  it('freezes the default cutoff and filters messages newer than that cutoff', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const listMessages = vi.fn()
        .mockImplementationOnce(async () => { clock.mockReturnValue(now + 5000); return { items: [makeFeishuMsg('future', 'text', now + 1000)], has_more: true, page_token: 'next' } })
        .mockResolvedValueOnce({ items: [makeFeishuMsg('current', 'text', now)], has_more: false })
      internals.client = { listMessages }
      expect((await internals.handleGetHistory({ session_id: sessionId })).items.map(m => m.platform_message_id)).toEqual(['current'])
      expect(listMessages.mock.calls.map(([params]) => params.end_time)).toEqual([String(Math.floor(now / 1000) + 1), String(Math.floor(now / 1000) + 1)])
    } finally { clock.mockRestore() }
  })
})

describe('interactive history reads', () => {
  it('maps remote get/history/backfill consistently and uses the local cache after backfill', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_card', title: 'Cards', participants: [],
    })
    const remote = {
      ...makeFeishuMsg('om_card', '', 1_700_000_000_000),
      msg_type: 'interactive', parent_id: 'om_parent', root_id: 'om_root',
      body: { content: JSON.stringify({ schema: '2.0', body: { elements: [
        { tag: 'markdown', content: 'Last line: report.md' },
      ] } }) },
    }
    const getMessage = vi.fn().mockResolvedValue(remote)
    internals.client = { getMessage, listMessages: vi.fn().mockResolvedValue({ items: [remote], has_more: false }) }
    const params = { session_id: session.id, platform_message_id: 'om_card' }
    const message = await internals.handleGetMessage(params)
    expect(message.content).toEqual({ type: 'text', text: 'Last line: report.md' })
    expect(message.features).toMatchObject({ reply_to_message_id: 'om_parent', root_message_id: 'om_root' })
    expect((await internals.handleGetHistory({ session_id: session.id })).items).toEqual([message])
    await internals.backfillHistory({ session_id: session.id })
    getMessage.mockRejectedValue(new Error('remote unavailable'))
    expect(await internals.handleGetMessage(params)).toEqual(message)
    expect(getMessage).toHaveBeenCalledTimes(1)
  })
})

describe('FeishuChannel.backfillHistory', () => {
  it('单聊 session 抛 INVALID_ARGUMENT，飞书 listMessages 不被调用', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsert({
      platform_session_id: 'ou_alice',
      type: 'private',
      title: 'Alice',
      sender_id: 'ou_alice',
      sender_name: 'Alice',
    })
    const listMessages = vi.fn()
    internals.client = { listMessages } as never

    await expect(internals.backfillHistory({ session_id: session.id })).rejects.toThrow(/group sessions/i)
    expect(listMessages).not.toHaveBeenCalled()
  })

  it('回填飞书返回的全部消息，单次内 dedup 已存在的 platform_message_id', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_chat1',
      title: '产品群',
      participants: [],
    })

    // 已有一条消息 m1，飞书返回 [m1, m2, m3]
    await (channel as unknown as { messageStore: { append: (sid: string, m: unknown) => Promise<void> } }).messageStore.append(session.id, {
      direction: 'inbound',
      platform_message_id: 'm1',
      sender: { platform_user_id: 'ou_alice', platform_display_name: 'Alice' },
      content: { type: 'text', text: 'old m1' },
      features: { is_mention_crab: false },
      platform_timestamp: new Date(1_700_000_000_000).toISOString(),
    })

    internals.client = {
      listMessages: vi.fn().mockResolvedValueOnce({
        items: [
          makeFeishuMsg('m1', 'old m1', 1_700_000_000_000),
          makeFeishuMsg('m2', 'new m2', 1_700_000_010_000),
          makeFeishuMsg('m3', 'new m3', 1_700_000_020_000),
        ],
        has_more: false,
      }),
    } as never

    const result = await internals.backfillHistory({ session_id: session.id, max_count: 100 })

    expect(result.backfilled_count).toBe(2)
    expect(result.skipped_count).toBe(1)
    expect(result.has_more).toBe(false)
    expect(result.oldest_ts).toBe(new Date(1_700_000_010_000).toISOString())
    expect(result.newest_ts).toBe(new Date(1_700_000_020_000).toISOString())
  })

  it('达到 max_count 上限时停止分页', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_chat2',
      title: '产品群',
      participants: [],
    })

    internals.client = {
      listMessages: vi.fn().mockResolvedValueOnce({
        items: [
          makeFeishuMsg('m1', 't1', 1_700_000_000_000),
          makeFeishuMsg('m2', 't2', 1_700_000_001_000),
          makeFeishuMsg('m3', 't3', 1_700_000_002_000),
        ],
        page_token: 'next',
        has_more: true,
      }),
    } as never

    const result = await internals.backfillHistory({ session_id: session.id, max_count: 2 })

    expect(result.backfilled_count).toBe(2)
    expect(result.has_more).toBe(true)
    // 第二页不应该被请求（命中 max_count 即停）
    expect((internals.client.listMessages as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })

  it('飞书 has_more=true 时返回 has_more', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_chat3',
      title: '产品群',
      participants: [],
    })
    internals.client = {
      listMessages: vi.fn()
        .mockResolvedValueOnce({
          items: [makeFeishuMsg('m1', 't1', 1_700_000_000_000)],
          page_token: 'next',
          has_more: true,
        })
        .mockResolvedValueOnce({
          items: [makeFeishuMsg('m2', 't2', 1_700_000_001_000)],
          has_more: false,
        }),
    } as never

    const result = await internals.backfillHistory({ session_id: session.id, max_count: 500 })

    expect(result.backfilled_count).toBe(2)
    expect(result.has_more).toBe(false)
  })

  it('同 session 并发调用第二次抛 CONFLICT', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_chat4',
      title: '产品群',
      participants: [],
    })

    let resolveFirstCall: (v: { items: never[]; has_more: boolean }) => void = () => {}
    const listMessagesCalled = new Promise<void>((readyResolve) => {
      internals.client = {
        listMessages: vi.fn().mockImplementation(
          () => new Promise((resolve) => {
            resolveFirstCall = resolve
            readyResolve()
          })
        ),
      } as never
    })

    const first = internals.backfillHistory({ session_id: session.id })
    // 等第一次调用真正跑到 await client.listMessages
    await listMessagesCalled

    await expect(internals.backfillHistory({ session_id: session.id })).rejects.toThrow(/in progress/i)

    resolveFirstCall({ items: [], has_more: false })
    await first
  })
})

describe('file 消息回归契约（远端 history/message/backfill 三条路径）', () => {
  it('handleGetHistory 远端 fallback 返回 file 消息含 filename/size/status/handle 及 parent_id/root_id', async () => {
    const internals = channel as unknown as ChannelInternals
    await (channel as any).mediaHandleStore.init()

    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_file_history1',
      title: 'file 测试群',
      participants: [],
    })

    internals.client = {
      listMessages: vi.fn().mockResolvedValueOnce({
        items: [
          makeFeishuFileMsg('om_fh1', 'file_key_x', 'report.pdf', 102400, 1_700_000_000_000, 'om_parent1', 'om_root1'),
        ],
        has_more: false,
      }),
    } as never

    const result = await internals.handleGetHistory({ session_id: session.id })
    const msg = result.items[0]

    expect(msg.content.type).toBe('file')
    expect(msg.content.filename).toBe('report.pdf')
    expect(msg.content.size).toBe(102400)
    expect(msg.content.status).toBe('not_fetched')
    expect(msg.content.handle).toMatch(/^fm_[0-9a-f]{12}$/)
    expect(msg.content.file_path).toBeUndefined()

    // handle store 凭据含 platform_message_id + file_key
    const record = (channel as any).mediaHandleStore.get(msg.content.handle)
    expect(record.credential.platform_message_id).toBe('om_fh1')
    expect(record.credential.file_key).toBe('file_key_x')
    expect(record.session_id).toBe(session.id)

    // parent_id → reply_to_message_id, root_id → root_message_id
    expect(msg.features.reply_to_message_id).toBe('om_parent1')
    expect(msg.features.root_message_id).toBe('om_root1')
  })

  it('handleGetMessage 远端查询返回 file 消息含 filename/size/status/handle', async () => {
    const internals = channel as unknown as ChannelInternals
    await (channel as any).mediaHandleStore.init()

    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_file_getmsg',
      title: 'file 测试群',
      participants: [],
    })

    internals.client = {
      getMessage: vi.fn().mockResolvedValueOnce(
        makeFeishuFileMsg('om_fgm1', 'file_key_y', 'data.xlsx', 204800, 1_700_000_010_000, 'om_parent2', 'om_root2'),
      ),
    } as never

    const msg = await internals.handleGetMessage({ session_id: session.id, platform_message_id: 'om_fgm1' })

    expect(msg.content.type).toBe('file')
    expect(msg.content.filename).toBe('data.xlsx')
    expect(msg.content.size).toBe(204800)
    expect(msg.content.status).toBe('not_fetched')
    expect(msg.content.handle).toMatch(/^fm_[0-9a-f]{12}$/)
    expect(msg.content.file_path).toBeUndefined()

    // handle store 凭据
    const record = (channel as any).mediaHandleStore.get(msg.content.handle)
    expect(record.credential.platform_message_id).toBe('om_fgm1')
    expect(record.credential.file_key).toBe('file_key_y')
    expect(record.session_id).toBe(session.id)

    // parent_id/root_id
    expect(msg.features.reply_to_message_id).toBe('om_parent2')
    expect(msg.features.root_message_id).toBe('om_root2')
  })

  it('backfillHistory 持久化 file 消息含 filename/size/status/handle 及 parent_id/root_id', async () => {
    const internals = channel as unknown as ChannelInternals
    await (channel as any).mediaHandleStore.init()

    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_file_backfill',
      title: 'file 测试群',
      participants: [],
    })

    internals.client = {
      listMessages: vi.fn().mockResolvedValueOnce({
        items: [
          makeFeishuFileMsg('om_bf1', 'file_key_z', 'architecture.png', 512000, 1_700_000_020_000, 'om_parent3', 'om_root3'),
        ],
        has_more: false,
      }),
    } as never

    const result = await internals.backfillHistory({ session_id: session.id, max_count: 100 })

    expect(result.backfilled_count).toBe(1)
    expect(result.skipped_count).toBe(0)

    // 检查 messageStore 中持久化的内容
    const stored = await (channel as any).messageStore.query({ sessionId: session.id })
    expect(stored.items).toHaveLength(1)
    const msg = stored.items[0]
    expect(msg.content.type).toBe('file')
    expect(msg.content.filename).toBe('architecture.png')
    expect(msg.content.size).toBe(512000)
    expect(msg.content.status).toBe('not_fetched')
    expect(msg.content.handle).toMatch(/^fm_[0-9a-f]{12}$/)
    expect(msg.content.file_path).toBeUndefined()

    // handle store 凭据
    const record = (channel as any).mediaHandleStore.get(msg.content.handle)
    expect(record.credential.platform_message_id).toBe('om_bf1')
    expect(record.credential.file_key).toBe('file_key_z')
    expect(record.session_id).toBe(session.id)

    // parent_id/root_id
    expect(msg.features.reply_to_message_id).toBe('om_parent3')
    expect(msg.features.root_message_id).toBe('om_root3')
  })

  it('REST mentions 归一化：open_id mention 在 history/getMessage/backfill 三条路径保留', async () => {
    const internals = channel as unknown as ChannelInternals
    await (channel as any).mediaHandleStore.init()

    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_mentions',
      title: 'mentions 测试群',
      participants: [],
    })

    // REST 格式的 mentions：id 是字符串 + id_type
    const restMention = {
      key: '@_user_1',
      id: 'ou_rest_user',
      id_type: 'open_id',
      name: 'Alice',
      tenant_key: 'tk_1',
    }

    // handleGetHistory 远端 fallback
    internals.client = {
      listMessages: vi.fn().mockResolvedValueOnce({
        items: [{
          message_id: 'om_men_h',
          msg_type: 'text',
          create_time: String(1_700_000_000_000),
          sender: { id: 'ou_bob' },
          body: { content: JSON.stringify({ text: 'Hi @_user_1' }) },
          mentions: [restMention],
        }],
        has_more: false,
      }),
    } as never

    const histResult = await internals.handleGetHistory({ session_id: session.id })
    expect(histResult.items).toHaveLength(1)
    const histMsg = histResult.items[0]
    expect(histMsg.features.mentions).toBeDefined()
    expect(histMsg.features.mentions).toHaveLength(1)
    expect(histMsg.features.mentions![0].platform_user_id).toBe('ou_rest_user')
    expect(histMsg.content.text).toContain('@Alice')

    // handleGetMessage 远端查询
    internals.client = {
      getMessage: vi.fn().mockResolvedValueOnce({
        message_id: 'om_men_m',
        msg_type: 'text',
        create_time: String(1_700_000_001_000),
        sender: { id: 'ou_bob' },
        body: { content: JSON.stringify({ text: 'Hi @_user_1' }) },
        mentions: [restMention],
      }),
    } as never

    const getMsg = await internals.handleGetMessage({ session_id: session.id, platform_message_id: 'om_men_m' })
    expect(getMsg.features.mentions).toBeDefined()
    expect(getMsg.features.mentions).toHaveLength(1)
    expect(getMsg.features.mentions![0].platform_user_id).toBe('ou_rest_user')

    // backfillHistory 持久化后保留 mentions
    internals.client = {
      listMessages: vi.fn().mockResolvedValueOnce({
        items: [{
          message_id: 'om_men_b',
          msg_type: 'text',
          create_time: String(1_700_000_002_000),
          sender: { id: 'ou_bob' },
          body: { content: JSON.stringify({ text: 'Hi @_user_1' }) },
          mentions: [restMention],
        }],
        has_more: false,
      }),
    } as never

    const bfResult = await internals.backfillHistory({ session_id: session.id, max_count: 100 })
    expect(bfResult.backfilled_count).toBe(1)

    const stored = await (channel as any).messageStore.query({ sessionId: session.id })
    const bfMsg = stored.items.find((m: { platform_message_id: string }) => m.platform_message_id === 'om_men_b')
    expect(bfMsg).toBeDefined()
    expect(bfMsg.features.mentions).toBeDefined()
    expect(bfMsg.features.mentions).toHaveLength(1)
    expect(bfMsg.features.mentions[0].platform_user_id).toBe('ou_rest_user')
  })

  it('handle 去重：同一 message_id+file_key 重复查询复用已有 handle，store 条目不增长', async () => {
    const internals = channel as unknown as ChannelInternals
    await (channel as any).mediaHandleStore.init()

    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_dedup',
      title: 'handle 去重测试群',
      participants: [],
    })

    const fileMsg = makeFeishuFileMsg('om_dedup', 'fk_dedup', 'doc.pdf', 1000, 1_700_000_000_000)

    // 第一次查询：mint 新 handle
    internals.client = {
      listMessages: vi.fn().mockResolvedValue({
        items: [fileMsg],
        has_more: false,
      }),
    } as never

    const r1 = await internals.handleGetHistory({ session_id: session.id })
    expect(r1.items).toHaveLength(1)
    const handle1 = r1.items[0].content.handle
    expect(handle1).toMatch(/^fm_[0-9a-f]{12}$/)

    const storeSizeAfterFirst = (channel as any).mediaHandleStore['map'].size

    // 第二次查询：同一 message_id+file_key 应复用 handle
    const r2 = await internals.handleGetHistory({ session_id: session.id })
    expect(r2.items).toHaveLength(1)
    const handle2 = r2.items[0].content.handle
    expect(handle2).toBe(handle1) // 复用！

    const storeSizeAfterSecond = (channel as any).mediaHandleStore['map'].size
    expect(storeSizeAfterSecond).toBe(storeSizeAfterFirst) // 条目不增长

    // 不同 message_id+file_key 应产生不同 handle
    const anotherMsg = makeFeishuFileMsg('om_dedup2', 'fk_dedup2', 'other.pdf', 2000, 1_700_000_010_000)
    internals.client = {
      listMessages: vi.fn().mockResolvedValue({
        items: [anotherMsg],
        has_more: false,
      }),
    } as never

    const r3 = await internals.handleGetHistory({ session_id: session.id })
    expect(r3.items).toHaveLength(1)
    const handle3 = r3.items[0].content.handle
    expect(handle3).not.toBe(handle1) // 不同文件不同 handle
  })
})

describe('image 消息回归契约（远端 history/message/backfill 三条路径）', () => {
  function makeFeishuImageMsg(id: string, imageKey: string, createTimeMs: number) {
    return {
      message_id: id,
      msg_type: 'image',
      create_time: String(createTimeMs),
      sender: { id: 'ou_alice' },
      body: { content: JSON.stringify({ image_key: imageKey }) },
    }
  }

  it('handleGetHistory 远端 fallback 返回 image 消息含 text 占位符 [图片]，不触发下载', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_image_history1',
      title: 'image 测试群',
      participants: [],
    })

    internals.client = {
      listMessages: vi.fn().mockResolvedValueOnce({
        items: [
          makeFeishuImageMsg('om_ih1', 'img_key_a', 1_700_000_000_000),
        ],
        has_more: false,
      }),
    } as never

    const result = await internals.handleGetHistory({ session_id: session.id })
    const msg = result.items[0]

    // type 保持不变（语义契约）
    expect(msg.content.type).toBe('image')
    // 有 text 占位
    expect(msg.content.text).toBe('[图片]')
    // 不触发下载：无 file_path / handle / status
    expect(msg.content.file_path).toBeUndefined()
    expect(msg.content.handle).toBeUndefined()
    expect(msg.content.status).toBeUndefined()
  })

  it('handleGetMessage 远端查询返回 image 消息含 text 占位符 [图片]，不触发下载', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_image_getmsg',
      title: 'image 测试群',
      participants: [],
    })

    internals.client = {
      getMessage: vi.fn().mockResolvedValueOnce(
        makeFeishuImageMsg('om_igm1', 'img_key_b', 1_700_000_010_000),
      ),
    } as never

    const msg = await internals.handleGetMessage({ session_id: session.id, platform_message_id: 'om_igm1' })

    expect(msg.content.type).toBe('image')
    expect(msg.content.text).toBe('[图片]')
    expect(msg.content.file_path).toBeUndefined()
    expect(msg.content.handle).toBeUndefined()
    expect(msg.content.status).toBeUndefined()
  })

  it('backfillHistory 持久化 image 消息含 text 占位符 [图片]，不触发下载', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_image_backfill',
      title: 'image 测试群',
      participants: [],
    })

    internals.client = {
      listMessages: vi.fn().mockResolvedValueOnce({
        items: [
          makeFeishuImageMsg('om_ibf1', 'img_key_c', 1_700_000_020_000),
        ],
        has_more: false,
      }),
    } as never

    const result = await internals.backfillHistory({ session_id: session.id, max_count: 100 })

    expect(result.backfilled_count).toBe(1)
    expect(result.skipped_count).toBe(0)

    // 检查 messageStore 中持久化的内容
    const stored = await (channel as any).messageStore.query({ sessionId: session.id })
    expect(stored.items).toHaveLength(1)
    const msg = stored.items[0]
    expect(msg.content.type).toBe('image')
    expect(msg.content.text).toBe('[图片]')
    expect(msg.content.file_path).toBeUndefined()
    expect(msg.content.handle).toBeUndefined()
    expect(msg.content.status).toBeUndefined()
  })
})

describe('纯图片 post 消息回归契约（远端 history/message/backfill 三条路径）', () => {
  /** 构造一条纯图片 post 消息（elements 只有 img，无任何文本） */
  function makePureImagePostMsg(id: string, imageKey: string, createTimeMs: number) {
    return {
      message_id: id,
      msg_type: 'post',
      create_time: String(createTimeMs),
      sender: { id: 'ou_alice' },
      body: {
        content: JSON.stringify({
          content: [[{ tag: 'img', image_key: imageKey }]],
        }),
      },
    }
  }

  it('handleGetHistory 远端 fallback 返回纯图片 post 消息含 [图片] 占位，不触发下载', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_postimg_history',
      title: '纯图片 post 测试群',
      participants: [],
    })

    internals.client = {
      listMessages: vi.fn().mockResolvedValueOnce({
        items: [makePureImagePostMsg('om_pph1', 'img_post_key_a', 1_700_000_030_000)],
        has_more: false,
      }),
    } as never

    const result = await internals.handleGetHistory({ session_id: session.id })
    const msg = result.items[0]

    // type 应为 image（post 拍平后含 img 元素）
    expect(msg.content.type).toBe('image')
    // text 不为空，被 [图片] 兜住
    expect(msg.content.text).toBe('[图片]')
    // 不触发下载
    expect(msg.content.file_path).toBeUndefined()
    expect(msg.content.handle).toBeUndefined()
    expect(msg.content.status).toBeUndefined()
  })

  it('handleGetMessage 远端查询返回纯图片 post 消息含 [图片] 占位，不触发下载', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_postimg_getmsg',
      title: '纯图片 post 测试群',
      participants: [],
    })

    internals.client = {
      getMessage: vi.fn().mockResolvedValueOnce(
        makePureImagePostMsg('om_ppg1', 'img_post_key_b', 1_700_000_040_000),
      ),
    } as never

    const msg = await internals.handleGetMessage({
      session_id: session.id,
      platform_message_id: 'om_ppg1',
    })

    expect(msg.content.type).toBe('image')
    expect(msg.content.text).toBe('[图片]')
    expect(msg.content.file_path).toBeUndefined()
    expect(msg.content.handle).toBeUndefined()
    expect(msg.content.status).toBeUndefined()
  })

  it('backfillHistory 持久化纯图片 post 消息含 [图片] 占位，不触发下载', async () => {
    const internals = channel as unknown as ChannelInternals
    const { session } = internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_postimg_backfill',
      title: '纯图片 post 测试群',
      participants: [],
    })

    internals.client = {
      listMessages: vi.fn().mockResolvedValueOnce({
        items: [makePureImagePostMsg('om_ppb1', 'img_post_key_c', 1_700_000_050_000)],
        has_more: false,
      }),
    } as never

    const result = await internals.backfillHistory({ session_id: session.id, max_count: 100 })

    expect(result.backfilled_count).toBe(1)
    expect(result.skipped_count).toBe(0)

    const stored = await (channel as any).messageStore.query({ sessionId: session.id })
    expect(stored.items).toHaveLength(1)
    const msg = stored.items[0]
    expect(msg.content.type).toBe('image')
    expect(msg.content.text).toBe('[图片]')
    expect(msg.content.file_path).toBeUndefined()
    expect(msg.content.handle).toBeUndefined()
    expect(msg.content.status).toBeUndefined()
  })
})
