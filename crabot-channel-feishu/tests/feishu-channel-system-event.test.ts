/**
 * FeishuChannel.handleUsersAdded 触发 system_event 推送测试
 *
 * 见 crabot-docs/superpowers/specs/2026-06-02-channel-system-event-design.md
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

interface ChannelInternals {
  events: { publishEvent: (...args: unknown[]) => Promise<void> }
  sessionManager: {
    upsertGroupSessionFromSnapshot: (p: {
      platform_session_id: string
      title: string
      participants: Array<{ platform_user_id: string; role: 'member' }>
    }) => { session: { id: string }; created: boolean }
    upsert: (p: {
      platform_session_id: string
      type: 'private'
      title: string
      sender_id: string
      sender_name: string
    }) => { session: { id: string }; created: boolean }
  }
  botOpenId: string | null
  botName: string | null
  handleUsersAdded: (data: unknown) => Promise<void>
}

let tmpDir: string
let channel: FeishuChannel

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-sysevent-'))
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
  const internals = channel as unknown as ChannelInternals
  internals.botOpenId = 'ou_bot_x'
  internals.botName = 'Crabot'
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('FeishuChannel.handleUsersAdded → system_event', () => {
  it('群里加新成员时同时发出 session_changed 和 message_received(system_event)', async () => {
    const internals = channel as unknown as ChannelInternals
    internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_g1',
      title: '产品群',
      participants: [{ platform_user_id: 'ou_existing', role: 'member' }],
    })
    const publish = vi.spyOn(internals.events, 'publishEvent').mockResolvedValue(undefined)
    await internals.handleUsersAdded({
      chat_id: 'oc_g1',
      users: [
        { user_id: { open_id: 'ou_new_a' }, name: '张三' },
        { user_id: { open_id: 'ou_new_b' }, name: '李四' },
      ],
    })

    const calls = publish.mock.calls
    expect(calls).toHaveLength(2)
    const eventTypes = calls.map((c) => (c[0] as { type: string }).type)
    expect(eventTypes).toContain('channel.session_changed')
    expect(eventTypes).toContain('channel.message_received')

    const sysEventCall = calls.find((c) => (c[0] as { type: string }).type === 'channel.message_received')!
    const msg = (sysEventCall[0] as { payload: { message: any } }).payload.message
    expect(msg.content.type).toBe('system_event')
    expect(msg.content.event_type).toBe('members_added')
    expect(msg.content.affected_users).toEqual([
      { platform_user_id: 'ou_new_a', platform_display_name: '张三' },
      { platform_user_id: 'ou_new_b', platform_display_name: '李四' },
    ])
    expect(msg.content.text).toBe('已加入：张三、李四')
    expect(msg.sender.platform_user_id).toBe('ou_bot_x')
    expect(msg.session.type).toBe('group')
    expect(msg.session.channel_id).toBe('feishu-test')
  })

  it('单人进群时 affected_users 是 1 个元素的数组（飞书可能每人一条事件）', async () => {
    const internals = channel as unknown as ChannelInternals
    internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_g_solo',
      title: '小群',
      participants: [],
    })
    const publish = vi.spyOn(internals.events, 'publishEvent').mockResolvedValue(undefined)
    await internals.handleUsersAdded({
      chat_id: 'oc_g_solo',
      users: [{ user_id: { open_id: 'ou_solo' }, name: '王五' }],
    })
    const sysEventCall = publish.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'channel.message_received',
    )!
    const msg = (sysEventCall[0] as { payload: { message: any } }).payload.message
    expect(msg.content.affected_users).toEqual([
      { platform_user_id: 'ou_solo', platform_display_name: '王五' },
    ])
    expect(msg.content.text).toBe('已加入：王五')
  })

  it('用户 name 缺失时 fallback 为 open_id', async () => {
    const internals = channel as unknown as ChannelInternals
    internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_g2',
      title: '运维群',
      participants: [],
    })
    const publish = vi.spyOn(internals.events, 'publishEvent').mockResolvedValue(undefined)
    await internals.handleUsersAdded({
      chat_id: 'oc_g2',
      users: [{ user_id: { open_id: 'ou_anon' } }],
    })
    const sysEventCall = publish.mock.calls.find(
      (c) => (c[0] as { type: string }).type === 'channel.message_received',
    )!
    const msg = (sysEventCall[0] as { payload: { message: any } }).payload.message
    expect(msg.content.affected_users[0].platform_display_name).toBe('ou_anon')
    expect(msg.content.text).toBe('已加入：ou_anon')
  })

  it('chat_id 缺失时不发任何事件', async () => {
    const internals = channel as unknown as ChannelInternals
    const publish = vi.spyOn(internals.events, 'publishEvent').mockResolvedValue(undefined)
    await internals.handleUsersAdded({ users: [{ user_id: { open_id: 'ou_x' }, name: 'X' }] })
    expect(publish).not.toHaveBeenCalled()
  })

  it('users 全空（all open_id missing）时只发 session_changed 不发 system_event', async () => {
    const internals = channel as unknown as ChannelInternals
    internals.sessionManager.upsertGroupSessionFromSnapshot({
      platform_session_id: 'oc_g3',
      title: '空群',
      participants: [],
    })
    const publish = vi.spyOn(internals.events, 'publishEvent').mockResolvedValue(undefined)
    await internals.handleUsersAdded({
      chat_id: 'oc_g3',
      users: [{ name: '无 ID' }],
    })
    // session_changed 仍可能发（applyParticipantsAdded 内部判断）
    const sysEventCount = publish.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === 'channel.message_received',
    ).length
    expect(sysEventCount).toBe(0)
  })
})
