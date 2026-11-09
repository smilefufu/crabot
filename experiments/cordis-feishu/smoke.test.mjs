import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Server, Socket } from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHost } from './host.mjs'

const installDir = process.env.CORDIS_INSTALL_DIR
if (!installDir) throw new Error('CORDIS_INSTALL_DIR must point to the npm-installed experiment')

test('npm-installed real Feishu plugin: two instances, one Web port, in-process events, restart without npm', async () => {
  const require = createRequire(path.resolve(installDir, 'package.json'))
  const { FeishuClient } = require('crabot-channel-feishu/dist/feishu-client.js')
  const { WsSubscriber } = require('crabot-channel-feishu/dist/ws-subscriber.js')
  mock.method(FeishuClient.prototype, 'getBotInfo', async () => ({ app_id: 'bot', app_name: 'bot', open_id: 'bot' }))
  mock.method(FeishuClient.prototype, 'listChats', async () => ({ items: [] }))
  mock.method(FeishuClient.prototype, 'getUser', async () => ({ open_id: 'user', name: 'Synthetic user' }))
  const send = mock.method(FeishuClient.prototype, 'sendText', async () => ({ message_id: 'sent', create_time: '0' }))
  mock.method(WsSubscriber.prototype, 'start', async () => {})
  const close = mock.method(WsSubscriber.prototype, 'close', async () => {})
  const listen = mock.method(Server.prototype, 'listen')
  mock.method(Socket.prototype, 'connect', () => { throw new Error('Outbound network forbidden in this fixture') })
  mock.method(globalThis, 'fetch', () => { throw new Error('Fetch forbidden in this fixture') })
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cordis-npm-smoke-'))
  const configs = ['first', 'second'].map(id => ({
    module_id: id, module_type: 'channel', version: '0.1.0', protocol_version: '0.1.0', data_dir: path.join(dir, id),
    feishu: { app_id: id, app_secret: 'synthetic', domain: 'feishu', only_respond_to_mentions: true, markdown_format: 'auto' },
  }))
  try {
    let stableSessionId
    for (let generation = 0; generation < 2; generation++) {
      const before = listen.mock.callCount()
      const host = await createHost(installDir, configs)
      try {
        assert.equal(listen.mock.callCount() - before, 1)
        assert.equal(host.channels.size, 2)
        const a = host.channels.get('first')
        const b = host.channels.get('second')
        const first = await a.methods.find_or_create_private_session({ platform_user_id: 'user' })
        const second = await b.methods.find_or_create_private_session({ platform_user_id: 'user' })
        assert.notEqual(first.session.id, second.session.id)
        if (stableSessionId) assert.equal(first.session.id, stableSessionId)
        stableSessionId = first.session.id
        await a.methods.send_message({ session_id: first.session.id, content: { type: 'text', text: 'synthetic reply' } })
        assert.equal(send.mock.callCount(), generation + 1)
        await a.handleMessageReceive({ sender: { sender_id: { open_id: 'user' }, sender_type: 'user' }, message: { message_id: `m${generation}`, chat_id: 'chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hello' }), create_time: String(Date.now()) } })
        const inbound = host.events.find(event => event.type === 'channel.message_received')
        assert.equal(inbound.payload.channel_id, 'first')
        assert.equal(inbound.payload.message.sender.platform_user_id, 'user')
        assert.equal(host.events.some(event => event.type === 'channel.message_authorized'), false)
      } finally { await host.close() }
      assert.equal(host.channels.size, 0)
    }
    assert.equal(close.mock.callCount(), 4)
  } finally {
    mock.restoreAll()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
