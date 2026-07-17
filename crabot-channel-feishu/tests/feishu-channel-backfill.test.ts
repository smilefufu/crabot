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

interface BackfillResult {
  session_id: string
  backfilled_count: number
  skipped_count: number
  has_more: boolean
  oldest_ts?: string
  newest_ts?: string
}

interface ChannelInternals {
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
