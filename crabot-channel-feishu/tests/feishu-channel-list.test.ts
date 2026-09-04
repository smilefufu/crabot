/**
 * FeishuChannel list_contacts / list_groups handler 测试
 *
 * 覆盖：
 * - handleListGroups：委托 feishu-client.listChats，search self-filter，字段映射
 * - handleListContacts：委托 feishu-client.listContacts，search self-filter，字段映射，RpcError 透传
 * - handleGetCapabilities：上报 supports_list_contacts/groups = true
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
import { RpcError } from 'crabot-shared'

let tmpDir: string
let channel: FeishuChannel

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-list-'))
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

// ── list_groups ──────────────────────────────────────────────────────────────

describe('FeishuChannel list_groups handler', () => {
  it('委托 feishu-client.listChats 并映射字段', async () => {
    const listChatsMock = vi.fn().mockResolvedValue({
      items: [
        { chat_id: 'oc_1', name: '产品群', chat_mode: 'group' },
        { chat_id: 'oc_2', name: 'AI 群', chat_mode: 'group' },
      ],
      page_token: undefined,
      has_more: false,
    })
    ;(channel as unknown as { client: { listChats: typeof listChatsMock } }).client = { listChats: listChatsMock } as never

    const result = await (channel as unknown as { handleListGroups(p: unknown): Promise<{ items: unknown[] }> })
      .handleListGroups({ search: 'AI', pagination: { page: 1, page_size: 20 } })

    expect(result).toMatchObject({
      items: [
        { platform_session_id: 'oc_2', group_name: 'AI 群' },
      ],
    })
  })

  it('search 为空时返回所有群', async () => {
    const listChatsMock = vi.fn().mockResolvedValue({
      items: [
        { chat_id: 'oc_1', name: '产品群', chat_mode: 'group' },
        { chat_id: 'oc_2', name: 'AI 群', chat_mode: 'group' },
      ],
      has_more: false,
    })
    ;(channel as unknown as { client: { listChats: typeof listChatsMock } }).client = { listChats: listChatsMock } as never

    const result = await (channel as unknown as { handleListGroups(p: unknown): Promise<{ items: unknown[] }> })
      .handleListGroups({})

    expect(result.items).toHaveLength(2)
  })

  it('has_more=true 时 total_pages=2（cursor 分页近似）', async () => {
    const channel2 = new FeishuChannel({
      module_id: 'feishu-test-2',
      module_type: 'channel',
      version: '0.0.1',
      protocol_version: '0.1.0',
      port: 0,
      data_dir: fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-list-2-')),
      feishu: {
        app_id: 'a',
        app_secret: 's',
        domain: 'feishu',
        only_respond_to_mentions: true,
        markdown_format: 'auto',
      },
    })
    const listChatsMock = vi.fn().mockResolvedValue({
      items: [{ chat_id: 'oc_1', name: '群1' }],
      has_more: true,
    })
    ;(channel2 as unknown as { client: { listChats: typeof listChatsMock } }).client = { listChats: listChatsMock } as never

    const result = await (channel2 as unknown as { handleListGroups(p: unknown): Promise<{ pagination: { total_pages: number } }> })
      .handleListGroups({})

    expect(result.pagination.total_pages).toBe(2)
  })
})

// ── list_contacts ────────────────────────────────────────────────────────────

describe('FeishuChannel list_contacts handler', () => {
  it('正常返回时映射字段（avatar_url 仅有时输出）', async () => {
    const listContactsMock = vi.fn().mockResolvedValue({
      items: [
        { open_id: 'ou_1', name: '张三', avatar_url: 'https://x' },
        { open_id: 'ou_2', name: 'Lily' },
      ],
      has_more: false,
    })
    ;(channel as unknown as { client: { listContacts: typeof listContactsMock } }).client = { listContacts: listContactsMock } as never

    const result = await (channel as unknown as { handleListContacts(p: unknown): Promise<{ items: unknown[] }> })
      .handleListContacts({})

    expect(result.items).toEqual([
      { platform_user_id: 'ou_1', display_name: '张三', avatar_url: 'https://x' },
      { platform_user_id: 'ou_2', display_name: 'Lily' },
    ])
  })

  it('listContacts 抛 PERMISSION_DENIED 时静默忽略，回退到群成员（无群则返回空列表）', async () => {
    const listContactsMock = vi.fn().mockRejectedValue(
      new RpcError('PERMISSION_DENIED', '缺 scope', { missing_scope: 'contact:user.base:readonly' }),
    )
    ;(channel as unknown as { client: { listContacts: typeof listContactsMock; getChatMembers: () => Promise<never[]> } }).client = {
      listContacts: listContactsMock,
      getChatMembers: vi.fn().mockResolvedValue([]),
    } as never

    const result = await (channel as unknown as { handleListContacts(p: unknown): Promise<{ items: unknown[] }> })
      .handleListContacts({})

    expect(result.items).toEqual([])
  })

  it('合并 org contacts 与群成员后 total_pages 始终为 1', async () => {
    const listContactsMock = vi.fn().mockResolvedValue({
      items: [{ open_id: 'ou_1', name: '人1' }],
      has_more: true,
    })
    ;(channel as unknown as { client: { listContacts: typeof listContactsMock; getChatMembers: () => Promise<never[]> } }).client = {
      listContacts: listContactsMock,
      getChatMembers: vi.fn().mockResolvedValue([]),
    } as never

    const result = await (channel as unknown as { handleListContacts(p: unknown): Promise<{ pagination: { total_pages: number } }> })
      .handleListContacts({})

    expect(result.pagination.total_pages).toBe(1)
  })
})

// ── capabilities ─────────────────────────────────────────────────────────────

describe('FeishuChannel capabilities', () => {
  it('上报 supports_list_contacts/supports_list_groups: true', () => {
    const caps = (channel as unknown as { handleGetCapabilities(): unknown }).handleGetCapabilities()
    expect(caps).toMatchObject({ supports_list_contacts: true, supports_list_groups: true })
  })
})

describe('FeishuChannel get_session handler', () => {
  it('session 不存在时抛协议级 NOT_FOUND', () => {
    const invoke = () => (channel as unknown as {
      handleGetSession(params: { session_id: string }): unknown
    }).handleGetSession({ session_id: 'missing' })

    expect(invoke).toThrowError(expect.objectContaining({
      name: 'RpcError',
      code: 'NOT_FOUND',
    }))
  })
})
