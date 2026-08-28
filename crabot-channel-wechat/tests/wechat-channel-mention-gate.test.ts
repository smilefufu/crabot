import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { WechatChannel } from '../src/wechat-channel.js'

/**
 * 群聊门控（group.only_respond_to_mentions）单测
 *
 * spec: crabot-docs/superpowers/specs/2026-08-28-wechat-group-mention-gate-design.md
 * 放行条件：@ Crabot（at_string 命中 puppet.wxid）或引用/回复 Crabot 发言
 * （connector 反查补齐的 quoted_sender_wxid === puppet.wxid）；其余群消息丢弃
 * （不建 session、不发布事件）。私聊与开关关闭场景不受影响。
 */
describe('WechatChannel group mention gate', () => {
  const PUPPET_WXID = 'wxid_bot'
  const OTHER_WXID = 'wxid_alice'

  let dataDir: string
  let publishEvent: ReturnType<typeof vi.fn>
  let upsert: ReturnType<typeof vi.fn>

  function makeChannel(opts?: { onlyRespondToMentions?: boolean }): WechatChannel {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-gate-'))
    const channel = new WechatChannel({
      module_id: 'wechat-test',
      module_type: 'channel',
      version: '0.0.1',
      protocol_version: '0.1.0',
      port: 0,
      data_dir: dataDir,
      wechat: {
        connector_url: 'http://localhost:0',
        api_key: 'wct_test',
        mode: 'socketio',
        only_respond_to_mentions: opts?.onlyRespondToMentions,
      },
    })
    upsert = vi.fn().mockReturnValue({
      session: { id: 'session-1', type: 'group' },
      created: false,
    })
    ;(channel as any).sessionManager = { upsert }
    publishEvent = vi.fn().mockResolvedValue(1)
    ;(channel as any).rpcClient = { publishEvent }
    return channel
  }

  function groupEvent(overrides: {
    atString?: string
    quotedSenderWxid?: string
    senderWxid?: string
  }): Record<string, unknown> {
    const content: Record<string, unknown> = { type: 0, text: 'hello group' }
    if (overrides.atString !== undefined) content.at_string = overrides.atString
    if (overrides.quotedSenderWxid !== undefined) content.quoted_sender_wxid = overrides.quotedSenderWxid
    return {
      eventId: `event-${Math.random()}`,
      timestamp: 1783858373565,
      puppet: { puppetId: 'puppet-1', wxid: PUPPET_WXID, nickname: 'Bot' },
      message: {
        id: `message-${Math.random()}`,
        msgSvrId: null,
        type: 0,
        createTime: '1783850324000',
        content,
      },
      sender: { wxid: overrides.senderWxid ?? OTHER_WXID, name: 'Alice' },
      conversation: { id: 'chatroom-1', name: 'Test Group', isGroup: true },
    }
  }

  beforeEach(() => {
    dataDir = ''
  })

  afterEach(() => {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
  })

  describe('开关关闭（缺省）——行为与现状一致', () => {
    it('未配置开关时，非 @ 的普通群消息照常发布', async () => {
      const channel = makeChannel()
      await (channel as any).handleWechatEvent(groupEvent({}))
      expect(publishEvent).toHaveBeenCalledTimes(1)
      expect(upsert).toHaveBeenCalledTimes(1)
    })

    it('显式 false 时，非 @ 的普通群消息照常发布', async () => {
      const channel = makeChannel({ onlyRespondToMentions: false })
      await (channel as any).handleWechatEvent(groupEvent({}))
      expect(publishEvent).toHaveBeenCalledTimes(1)
    })
  })

  describe('开关开启——门控矩阵', () => {
    it('@ Crabot（at_string 命中 puppet.wxid）→ 放行', async () => {
      const channel = makeChannel({ onlyRespondToMentions: true })
      await (channel as any).handleWechatEvent(groupEvent({ atString: `${OTHER_WXID},${PUPPET_WXID}` }))
      expect(publishEvent).toHaveBeenCalledTimes(1)
      const event = publishEvent.mock.calls[0][0]
      expect(event.payload.message.features.is_mention_crab).toBe(true)
    })

    it('引用 Crabot 发言（quoted_sender_wxid === puppet.wxid）→ 放行，且不冒充 @ 标记', async () => {
      const channel = makeChannel({ onlyRespondToMentions: true })
      await (channel as any).handleWechatEvent(groupEvent({ quotedSenderWxid: PUPPET_WXID }))
      expect(publishEvent).toHaveBeenCalledTimes(1)
      const event = publishEvent.mock.calls[0][0]
      expect(event.payload.message.features.is_mention_crab).toBe(false)
    })

    it('引用他人（quoted_sender_wxid 为别人）→ 丢弃：不发布、不建 session', async () => {
      const channel = makeChannel({ onlyRespondToMentions: true })
      await (channel as any).handleWechatEvent(groupEvent({ quotedSenderWxid: OTHER_WXID }))
      expect(publishEvent).not.toHaveBeenCalled()
      expect(upsert).not.toHaveBeenCalled()
    })

    it('普通消息（无 @ 无引用）→ 丢弃', async () => {
      const channel = makeChannel({ onlyRespondToMentions: true })
      await (channel as any).handleWechatEvent(groupEvent({}))
      expect(publishEvent).not.toHaveBeenCalled()
      expect(upsert).not.toHaveBeenCalled()
    })

    it('@ 了别人但没 @ Crabot → 丢弃', async () => {
      const channel = makeChannel({ onlyRespondToMentions: true })
      await (channel as any).handleWechatEvent(groupEvent({ atString: OTHER_WXID }))
      expect(publishEvent).not.toHaveBeenCalled()
    })

    it('connector 反查失败（quoted_sender_wxid 缺失）→ 丢弃，不做名字模糊降级', async () => {
      const channel = makeChannel({ onlyRespondToMentions: true })
      await (channel as any).handleWechatEvent(groupEvent({}))
      expect(publishEvent).not.toHaveBeenCalled()
    })

    it('私聊消息不受门控影响 → 放行', async () => {
      const channel = makeChannel({ onlyRespondToMentions: true })
      const event = groupEvent({})
      ;(event.conversation as Record<string, unknown>).isGroup = false
      await (channel as any).handleWechatEvent(event)
      expect(publishEvent).toHaveBeenCalledTimes(1)
    })
  })

  describe('config RPC（protocol-channel.md §6.1）', () => {
    it('get_config：api_key 掩码、返回开关与 crab_platform_user_id、schema 声明热更新', () => {
      const channel = makeChannel({ onlyRespondToMentions: true })
      ;(channel as any).puppetWxid = PUPPET_WXID

      const result = (channel as any).handleGetConfig()
      expect(result.config.credentials.api_key).toBe('***')
      expect(result.config.credentials.connector_url).toBe('http://localhost:0')
      expect(result.config.group.only_respond_to_mentions).toBe(true)
      expect(result.config.crab_platform_user_id).toBe(PUPPET_WXID)
      expect(result.schema['group.only_respond_to_mentions'].hot_reload).toBe(true)
      expect(result.schema['credentials.api_key'].sensitive).toBe(true)
    })

    it('get_config：事件到来前 crab_platform_user_id 为空串', () => {
      const channel = makeChannel()
      const result = (channel as any).handleGetConfig()
      expect(result.config.crab_platform_user_id).toBe('')
    })

    it('update_config：开关热改立即生效（下一条消息按新开关门控）', async () => {
      const channel = makeChannel({ onlyRespondToMentions: false })
      ;(channel as any).handleUpdateConfig({ config: { group: { only_respond_to_mentions: true } } })

      // 热改后：普通群消息应被丢弃
      await (channel as any).handleWechatEvent(groupEvent({}))
      expect(publishEvent).not.toHaveBeenCalled()

      const result = (channel as any).handleGetConfig()
      expect(result.config.group.only_respond_to_mentions).toBe(true)
      expect(result.requires_restart === undefined || result.requires_restart === false).toBe(true)
    })

    it('update_config：api_key 掩码 *** 跳过覆盖，不置 requires_restart', () => {
      const channel = makeChannel()
      const result = (channel as any).handleUpdateConfig({
        config: { credentials: { api_key: '***' } },
      })
      expect(result.requires_restart).toBe(false)
      expect((channel as any).wechatConfig.api_key).toBe('wct_test')
    })

    it('update_config：credentials 实际变更置 requires_restart，但运行态 client 不重建', () => {
      const channel = makeChannel()
      const result = (channel as any).handleUpdateConfig({
        config: { credentials: { api_key: 'wct_new' } },
      })
      expect(result.requires_restart).toBe(true)
      expect((channel as any).wechatConfig.api_key).toBe('wct_new')
      // WechatClient 构造时持有旧凭据，未被重建
      expect((channel as any).client).toBeDefined()
    })

    it('update_config：非法类型忽略，不破坏状态', () => {
      const channel = makeChannel({ onlyRespondToMentions: true })
      const result = (channel as any).handleUpdateConfig({
        config: { group: { only_respond_to_mentions: 'yes' }, credentials: { api_key: 123 } },
      })
      expect(result.requires_restart).toBe(false)
      expect((channel as any).wechatConfig.only_respond_to_mentions).toBe(true)
      expect((channel as any).wechatConfig.api_key).toBe('wct_test')
    })
  })
})
