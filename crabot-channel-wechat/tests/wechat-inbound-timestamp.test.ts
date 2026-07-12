import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { WechatChannel } from '../src/wechat-channel.js'

describe('WechatChannel inbound platform timestamp', () => {
  let dataDir: string
  let channel: WechatChannel
  let publishEvent: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-timestamp-'))
    channel = new WechatChannel({
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
      },
    })
    ;(channel as any).sessionManager = {
      upsert: vi.fn().mockReturnValue({
        session: { id: 'session-1', type: 'private' },
        created: false,
      }),
    }
    publishEvent = vi.fn().mockResolvedValue(1)
    ;(channel as any).rpcClient = { publishEvent }
  })

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it.each([
    ['milliseconds', '1783850324000'],
    ['seconds', '1783850324'],
  ])('preserves connector createTime expressed in %s', async (_label, createTime) => {
    await (channel as any).handleWechatEvent({
      eventId: 'event-1',
      timestamp: 1783858373565,
      puppet: { puppetId: 'puppet-1', wxid: 'wxid_bot', nickname: 'Bot' },
      message: {
        id: 'message-1',
        msgSvrId: 'server-message-1',
        type: 0,
        createTime,
        content: { type: 0, text: 'hello' },
      },
      sender: { wxid: 'wxid_sender', name: 'Sender' },
      conversation: { id: 'wxid_sender', name: 'Sender', isGroup: false },
    })

    const event = publishEvent.mock.calls[0][0]
    expect(event.payload.message.platform_timestamp).toBe('2026-07-12T09:58:44.000Z')
  })
})
