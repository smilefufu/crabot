import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { Server } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Event } from 'crabot-shared'

const connections = vi.hoisted(() => [] as Array<{ close: ReturnType<typeof vi.fn> }>)
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 'feishu', Lark: 'lark' },
  Client: class { im = {}; contact = {}; },
  EventDispatcher: class { register() { return this } },
  WSClient: class {
    close = vi.fn()
    constructor(private options: { onReady(): void }) { connections.push(this) }
    async start() { this.options.onReady() }
  },
}))

import * as plugin from '../src/main'
import { FeishuClient } from '../src/feishu-client'

let root: Context
let dir: string
function config(id: string) {
  return {
    module_id: id, module_type: 'channel' as const, version: '0.1.0', protocol_version: '0.1.0',
    data_dir: path.join(dir, id),
    feishu: { app_id: id, app_secret: 'synthetic-secret', domain: 'feishu' as const, only_respond_to_mentions: true, markdown_format: 'auto' as const },
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  connections.length = 0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cordis-feishu-'))
  root = new Context()
  root.provide('crabotChannels', new Map())
  vi.spyOn(FeishuClient.prototype, 'getBotInfo').mockResolvedValue({ app_id: 'bot', app_name: 'bot', open_id: 'bot' })
  vi.spyOn(FeishuClient.prototype, 'listChats').mockResolvedValue({ items: [] })
  vi.spyOn(FeishuClient.prototype, 'getUser').mockResolvedValue({ open_id: 'user', name: 'Synthetic user' })
})
afterEach(async () => {
  await root.fiber.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Cordis-only Feishu', () => {
  it('loads two isolated instances without a TCP listener and cleans up its own resources', async () => {
    const listen = vi.spyOn(Server.prototype, 'listen')
    const first = root.plugin(plugin, config('first'))
    const second = root.plugin(plugin, config('second'))
    await Promise.all([first, second])
    expect(first.state).toBe(2)
    expect(second.state).toBe(2)
    expect(listen).not.toHaveBeenCalled()
    const a = root.crabotChannels.get('first')!
    const b = root.crabotChannels.get('second')!
    const params = { platform_user_id: 'user' }
    const sessionA = await a.methods.find_or_create_private_session(params)
    const sessionB = await b.methods.find_or_create_private_session(params)
    expect(sessionA.session.id).not.toBe(sessionB.session.id)
    const originalId = sessionA.session.id
    sessionA.session.id = 'caller-mutation'
    expect((await a.methods.find_or_create_private_session(params)).session.id).toBe(originalId)
    await first.dispose()
    expect(root.crabotChannels.has('first')).toBe(false)
    expect(root.crabotChannels.has('second')).toBe(true)
    expect(connections[0].close).toHaveBeenCalledOnce()
    expect(connections[1].close).not.toHaveBeenCalled()
    await second.dispose()
    expect(root.crabotChannels.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('publishes raw inbound identity and routes sends in-process', async () => {
    const events: Event[] = []
    root.on('crabot/channel-event', event => { events.push(event) })
    const fiber = root.plugin(plugin, config('first'))
    await fiber
    const channel = root.crabotChannels.get('first')!
    await (channel as any).handleMessageReceive({
      sender: { sender_id: { open_id: 'user' }, sender_type: 'user' },
      message: { message_id: 'message', chat_id: 'chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hello' }), create_time: String(Date.now()) },
    })
    const inbound = events.find(event => event.type === 'channel.message_received')!
    expect(inbound).toBeDefined()
    expect(inbound.source).toBe('first')
    expect(inbound.payload).toMatchObject({ channel_id: 'first', message: { sender: { platform_user_id: 'user' } } })
    expect(events.some(event => event.type === 'channel.message_authorized')).toBe(false)
    const sessionId = (inbound.payload as any).message.session.session_id
    const send = vi.spyOn(FeishuClient.prototype, 'sendText').mockResolvedValue({ message_id: 'out', create_time: '0' })
    await channel.methods.send_message({ session_id: sessionId, content: { type: 'text', text: 'reply' } })
    expect(send).toHaveBeenCalledOnce()
  })

  it('keeps configuration ownership separate even when callers reuse an object', async () => {
    const firstConfig = config('first')
    const secondConfig = { ...config('second'), feishu: firstConfig.feishu }
    const first = root.plugin(plugin, firstConfig)
    await first
    await root.plugin(plugin, secondConfig)
    const a = root.crabotChannels.get('first')!
    const b = root.crabotChannels.get('second')!
    await a.methods.update_config({ config: { group: { only_respond_to_mentions: false } } })
    expect((await b.methods.get_config(undefined)).config.group).toMatchObject({ only_respond_to_mentions: true })
    expect(firstConfig.feishu.only_respond_to_mentions).toBe(true)
    await expect(a.methods.send_message({ session_id: 'missing', content: { type: 'text', text: 'reply' } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    firstConfig.module_id = 'caller-mutation'
    await first.dispose()
    expect(root.crabotChannels.has('first')).toBe(false)
    expect(root.crabotChannels.has('second')).toBe(true)
  })

  it('routes group images, lazy files and platform history through the real plugin', async () => {
    const events: Event[] = []
    root.on('crabot/channel-event', event => { events.push(event) })
    vi.spyOn(FeishuClient.prototype, 'getChat').mockResolvedValue({ chat_id: 'group', name: 'Synthetic group' })
    const download = vi.spyOn(FeishuClient.prototype, 'downloadResource').mockResolvedValue(Buffer.from('synthetic bytes'))
    await root.plugin(plugin, { ...config('first'), feishu: { ...config('first').feishu, only_respond_to_mentions: false } })
    const channel = root.crabotChannels.get('first')!
    for (const [type, content] of [
      ['image', { image_key: 'image' }],
      ['file', { file_key: 'file', file_name: 'example.txt', file_size: 15 }],
    ] as const) {
      await (channel as any).handleMessageReceive({
        sender: { sender_id: { open_id: 'user' }, sender_type: 'user' },
        message: { message_id: type, chat_id: 'group', chat_type: 'group', message_type: type, content: JSON.stringify(content), create_time: String(Date.now()) },
      })
    }
    const messages = events.filter(event => event.type === 'channel.message_received').map(event => (event.payload as any).message)
    expect(messages[0].session).toMatchObject({ channel_id: 'first', type: 'group' })
    expect(messages[0].content).toMatchObject({ type: 'image', status: 'ready' })
    expect(messages[1].content).toMatchObject({ type: 'file', status: 'not_fetched', filename: 'example.txt' })
    await channel.methods.fetch_media({ handle: messages[1].content.handle })
    expect(download).toHaveBeenCalledTimes(2)
    const history = vi.spyOn(FeishuClient.prototype, 'listMessages').mockResolvedValue({ items: [{ message_id: 'history', msg_type: 'text', create_time: String(Date.now()), sender: { id: 'user' }, body: { content: JSON.stringify({ text: 'history text' }) } }], has_more: false })
    const result = await channel.methods.get_history({ session_id: messages[0].session.session_id, limit: 10 })
    expect(history).toHaveBeenCalledWith(expect.objectContaining({ container_id: 'group' }))
    expect(result.items[0]).toMatchObject({ platform_message_id: 'history', content: { type: 'text', text: 'history text' } })
  })

  it('does not register a usable instance after initialization fails', async () => {
    vi.spyOn(FeishuClient.prototype, 'listChats').mockResolvedValue({ items: [] })
    const { WsSubscriber } = await import('../src/ws-subscriber')
    vi.spyOn(WsSubscriber.prototype, 'start').mockRejectedValue(new Error('synthetic connection failure'))
    const fiber = root.plugin(plugin, config('broken'))
    await expect(fiber).rejects.toThrow('synthetic connection failure')
    expect(fiber.state).toBe(3)
    expect(root.crabotChannels.has('broken')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
