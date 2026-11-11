/**
 * FeishuChannel bootstrapGroupSessions 测试
 *
 * 覆盖飞书应用扫码刚完成 + 权限未审批通过的关键场景：
 * - getChatMembers 撞 PERMISSION_DENIED 时立即降级，后续群不再调，但仍用 listChats 自带 name 建 session
 * - listChats 撞 PERMISSION_DENIED 时整段 return，不抛
 * - 非权限错（network 等）单群 skip，不影响其他群
 * - 权限正常路径：成员正常拉到
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { RpcError } from 'crabot-shared'

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

interface ChannelInternals {
  client: {
    listChats: (...args: unknown[]) => Promise<{
      items: Array<{ chat_id: string; name: string; chat_mode: 'group' }>
      page_token?: string
      has_more: boolean
    }>
    getChatMembers: (chatId: string) => Promise<Array<{ open_id: string; name: string }>>
  }
  sessionManager: {
    listSessions: (type: 'group' | 'private') => Array<{
      id: string
      platform_session_id: string
      title: string
      participants: Array<{ platform_user_id: string; role: string }>
    }>
  }
  bootstrapGroupSessions: () => Promise<void>
}

let tmpDir: string
let channel: FeishuChannel

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-bootstrap-'))
  channel = new FeishuChannel({
    module_id: 'feishu-test',
    module_type: 'channel',
    version: '0.0.1',
    protocol_version: '0.1.0',
    data_dir: tmpDir,
    feishu: {
      app_id: 'a',
      app_secret: 's',
      domain: 'feishu',
      only_respond_to_mentions: true,
      markdown_format: 'auto',
    },
  }, { publishEvent: async () => {} })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('FeishuChannel.bootstrapGroupSessions', () => {
  it('权限正常时为每个群建 session 且带 members', async () => {
    const listChats = vi.fn().mockResolvedValue({
      items: [
        { chat_id: 'oc_1', name: '群A', chat_mode: 'group' },
        { chat_id: 'oc_2', name: '群B', chat_mode: 'group' },
      ],
      has_more: false,
    })
    const getChatMembers = vi.fn().mockImplementation(async (chatId: string) => {
      if (chatId === 'oc_1') return [{ open_id: 'ou_a', name: 'A' }]
      return [{ open_id: 'ou_b', name: 'B' }]
    })
    const internals = channel as unknown as ChannelInternals
    internals.client = { listChats, getChatMembers } as never

    await internals.bootstrapGroupSessions()

    expect(getChatMembers).toHaveBeenCalledTimes(2)
    const sessions = internals.sessionManager.listSessions('group')
    expect(sessions).toHaveLength(2)
    const s1 = sessions.find((s) => s.platform_session_id === 'oc_1')!
    expect(s1.title).toBe('群A')
    expect(s1.participants).toHaveLength(1)
    expect(s1.participants[0].platform_user_id).toBe('ou_a')
  })

  it('getChatMembers 首个群撞 PERMISSION_DENIED 后整段降级：后续群不再调，但仍建占位 session', async () => {
    const listChats = vi.fn().mockResolvedValue({
      items: [
        { chat_id: 'oc_1', name: '群A', chat_mode: 'group' },
        { chat_id: 'oc_2', name: '群B', chat_mode: 'group' },
        { chat_id: 'oc_3', name: '群C', chat_mode: 'group' },
      ],
      has_more: false,
    })
    const getChatMembers = vi
      .fn()
      .mockRejectedValueOnce(new RpcError('PERMISSION_DENIED', '缺 scope', { missing_scope: 'im:chat.members:read' }))
    const internals = channel as unknown as ChannelInternals
    internals.client = { listChats, getChatMembers } as never

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await internals.bootstrapGroupSessions()
    warnSpy.mockRestore()

    expect(getChatMembers).toHaveBeenCalledTimes(1)
    const sessions = internals.sessionManager.listSessions('group')
    expect(sessions).toHaveLength(3)
    for (const s of sessions) {
      expect(s.participants).toEqual([])
    }
    expect(sessions.find((s) => s.platform_session_id === 'oc_2')?.title).toBe('群B')
  })

  it('listChats 撞 PERMISSION_DENIED 时整段 return，不抛', async () => {
    const listChats = vi
      .fn()
      .mockRejectedValue(new RpcError('PERMISSION_DENIED', '缺 scope', { missing_scope: 'im:chat:readonly' }))
    const getChatMembers = vi.fn()
    const internals = channel as unknown as ChannelInternals
    internals.client = { listChats, getChatMembers } as never

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(internals.bootstrapGroupSessions()).resolves.toBeUndefined()
    warnSpy.mockRestore()

    expect(getChatMembers).not.toHaveBeenCalled()
  })

  it('getChatMembers 单群非权限错只 skip 该群成员，其他群仍尝试拉成员', async () => {
    const listChats = vi.fn().mockResolvedValue({
      items: [
        { chat_id: 'oc_1', name: '群A', chat_mode: 'group' },
        { chat_id: 'oc_2', name: '群B', chat_mode: 'group' },
      ],
      has_more: false,
    })
    const getChatMembers = vi
      .fn()
      .mockRejectedValueOnce(new Error('network glitch'))
      .mockResolvedValueOnce([{ open_id: 'ou_b', name: 'B' }])
    const internals = channel as unknown as ChannelInternals
    internals.client = { listChats, getChatMembers } as never

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await internals.bootstrapGroupSessions()
    warnSpy.mockRestore()

    expect(getChatMembers).toHaveBeenCalledTimes(2)
    const sessions = internals.sessionManager.listSessions('group')
    expect(sessions).toHaveLength(2)
    const s2 = sessions.find((s) => s.platform_session_id === 'oc_2')!
    expect(s2.participants).toHaveLength(1)
  })

  it('listChats 上层抛非权限错时冒泡', async () => {
    const listChats = vi.fn().mockRejectedValue(new Error('boom'))
    const getChatMembers = vi.fn()
    const internals = channel as unknown as ChannelInternals
    internals.client = { listChats, getChatMembers } as never

    await expect(internals.bootstrapGroupSessions()).rejects.toThrow('boom')
  })
})
