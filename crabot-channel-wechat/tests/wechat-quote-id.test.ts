import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WechatChannel } from '../src/wechat-channel.js'

let dir: string
afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })

describe('微信事件、历史和详情统一引用 ID', () => {
  it.each(['ready', 'late'])('原消息 %s 时身份一致，重查直接取上游最新引用', async arrival => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-quote-id-'))
    const channel = new WechatChannel({ module_id: 'wechat-test', module_type: 'channel', version: '0.0.1',
      protocol_version: '0.1.0', port: 0, data_dir: dir,
      wechat: { connector_url: 'http://localhost:0', api_key: 'test', mode: 'socketio' } })
    const internals = channel as any
    const session = { id: 's', type: 'private', platform_session_id: 'wxid_sender' }
    internals.sessionManager = { upsert: vi.fn().mockReturnValue({ session, created: false }), findById: () => session }
    const publishEvent = vi.fn().mockResolvedValue(1)
    internals.rpcClient = { publishEvent }
    let available = arrival === 'ready'
    const quote = () => ({ id: 'msg_quote', fieldType: 18, fieldIsSend: 0, fieldTalker: session.platform_session_id,
      fieldCreateTime: '1791636019000', content: { type: 18, text: '识别引用图', quoted_svr_id: '514607585156521130',
        quoted_content: available ? '[图片]' : '[消息]',
        ...(available ? { quoted_message_id: 'msg_original', quoted_msg_type: 1 } : {}) } })
    const original = { id: 'msg_original', fieldType: 1, fieldIsSend: 0, fieldTalker: session.platform_session_id,
      fieldCreateTime: '1791635507000', content: { type: 1, image_origin: 1 } }
    internals.client = { getMessages: vi.fn(async () => [original, quote()]), getMessageById: vi.fn(async () => quote()) }
    await internals.handleWechatEvent({ eventId: 'event', timestamp: 1791636019000,
      puppet: { puppetId: 'puppet', wxid: 'wxid_bot', nickname: 'Bot' },
      message: { id: 'msg_quote', msgSvrId: '92230669277014843', type: 18, createTime: quote().fieldCreateTime, content: quote().content },
      sender: { wxid: 'wxid_sender', name: 'Sender' }, conversation: { id: session.platform_session_id, name: 'Sender', isGroup: false } })
    const incoming = publishEvent.mock.calls[0][0].payload.message
    expect(incoming.platform_message_id).toBe('msg_quote')
    expect(incoming.features.quote_message_id).toBe(available ? original.id : undefined)
    available = true
    const detail = await internals.handleGetMessage({ session_id: session.id, platform_message_id: 'msg_quote' })
    const history = await internals.handleGetHistory({ session_id: session.id })
    expect(history.items[0].platform_message_id).toBe(original.id)
    for (const projected of [detail, history.items[1]]) {
      expect(projected.platform_message_id).toBe('msg_quote')
      expect(projected.features.quote_message_id).toBe(history.items[0].platform_message_id)
      expect(projected.platform_timestamp).toBe(incoming.platform_timestamp)
      expect(projected.content.text).toContain('识别引用图')
    }
    expect(internals.client.getMessageById.mock.calls).toEqual([['msg_quote']])
    expect(publishEvent).toHaveBeenCalledTimes(1)
  })
})
