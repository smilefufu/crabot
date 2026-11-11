import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const installDir = process.env.CORDIS_INSTALL_DIR
if (!installDir) throw new Error('CORDIS_INSTALL_DIR must point to the installed npm plugin')
const require = createRequire(import.meta.url)
const { default: ModuleManager } = require('../../crabot-core/dist/index.js')
const identity = require('../../scripts/lib/process-identity.cjs')
const repo = fileURLToPath(new URL('../..', import.meta.url))

async function waitFor(read) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await read()
    if (result !== undefined) return result
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error('Managed Feishu startup timed out')
}

test('real MM loads npm Feishu through Cordis, routes calls/events and restarts without channel ports', { timeout: 30_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-managed-feishu-'))
  const preload = path.join(directory, 'platform.cjs')
  const pluginRequire = createRequire(path.resolve(installDir, 'package.json'))
  const pluginPath = pluginRequire.resolve('crabot-channel-feishu')
  await fs.writeFile(preload, `
    const {createRequire}=require('node:module')
    const load=createRequire(${JSON.stringify(path.resolve(installDir, 'package.json'))})
    const {FeishuClient}=load('crabot-channel-feishu/dist/feishu-client.js')
    const {WsSubscriber}=load('crabot-channel-feishu/dist/ws-subscriber.js')
    const {FeishuChannel}=load('crabot-channel-feishu/dist/feishu-channel.js')
    FeishuClient.prototype.getBotInfo=async()=>({app_id:'bot',app_name:'Synthetic bot',open_id:'bot'})
    FeishuClient.prototype.listChats=async()=>({items:[]})
    FeishuClient.prototype.getUser=async()=>({open_id:'user',name:'Synthetic user'})
    FeishuClient.prototype.listMessages=async()=>({items:[],has_more:false})
    FeishuClient.prototype.sendText=async(receive,text)=>({message_id:'sent',create_time:'0'})
    WsSubscriber.prototype.start=async function(){this.state='connected'}
    WsSubscriber.prototype.close=async function(){this.state='idle'}
    const original=FeishuChannel.prototype.start
    FeishuChannel.prototype.start=async function(){
      await original.call(this)
      await this.handleMessageReceive({sender:{sender_id:{open_id:'user'},sender_type:'user'},message:{message_id:'synthetic-in',chat_id:'chat',chat_type:'p2p',message_type:'text',content:JSON.stringify({text:'hello'}),create_time:String(Date.now())}})
    }
    require('node:net').Server.prototype.listen=()=>{throw new Error('Channel opened TCP listener')}
    require('node:net').Socket.prototype.connect=()=>{throw new Error('External network is forbidden')}
    globalThis.fetch=()=>{throw new Error('External fetch is forbidden')}
  `)
  const events = []
  const mm = new ModuleManager({ port: 19339, port_range: { range_start: 24101, range_end: 24110 },
    shutdown_timeout: 2, health_check_interval: 3600,
    modules: ['first', 'second'].map(module_id => ({ module_id, module_type: 'channel',
      entry: `"${process.execPath}" --require "${preload}" "${path.join(repo, 'crabot-core/dist/channel-host.js')}"`,
      cwd: repo, auto_start: false, start_priority: 30,
      env: { CRABOT_CHANNEL_PLUGIN_PATH: pluginPath, DATA_DIR: path.join(directory, module_id),
        FEISHU_APP_ID: module_id, FEISHU_APP_SECRET: 'synthetic-only', FEISHU_MARKDOWN_FORMAT: 'off' },
    })),
  }, directory, { transport: 'ipc' })
  const publish = mm.methodHandlers.get('publish_event')
  mm.methodHandlers.set('publish_event', async (params, context) => { events.push(structuredClone(params.event)); return publish(params, context) })
  try {
    await mm.start()
    for (const id of ['first', 'second']) await mm.handleStartModule({ module_id: id })
    await waitFor(() => [...mm.modules.values()].every(runtime => runtime.status === 'running') ? true : undefined)
    const a = mm.modules.get('first')
    const b = mm.modules.get('second')
    const raw = events.filter(event => event.type === 'channel.message_received')
    assert.deepEqual(new Set(raw.map(event => event.payload.channel_id)), new Set(['first', 'second']))
    assert.ok(raw.every(event => event.payload.message.sender.platform_user_id === 'user'))
    assert.equal(events.some(event => event.type === 'channel.message_authorized'), false)
    const first = await mm.sendToModule(a.port, 'find_or_create_private_session', { platform_user_id: 'user' })
    const second = await mm.sendToModule(b.port, 'find_or_create_private_session', { platform_user_id: 'user' })
    assert.notEqual(first.session.id, second.session.id)
    const sent = await mm.sendToModule(a.port, 'send_message', { session_id: first.session.id, content: { type: 'text', text: 'synthetic reply' } })
    assert.equal(sent.platform_message_id, 'sent')
    for (const runtime of [a, b]) {
      assert.deepEqual(identity.listListeningTcpPorts(runtime.pid), [])
      assert.equal((await mm.sendToModule(runtime.port, 'health', {})).details.platform_connected, true)
    }
    const old = mm.processes.get('first')
    await mm.stopModuleProcess('first', 'shutdown')
    assert.equal(old.exitCode, 0)
    assert.equal((await mm.sendToModule(b.port, 'health', {})).status, 'healthy')
    await mm.handleStartModule({ module_id: 'first' })
    await waitFor(() => a.status === 'running' ? true : undefined)
    assert.notEqual(a.pid, old.pid)
    const restored = await mm.sendToModule(a.port, 'find_or_create_private_session', { platform_user_id: 'user' })
    assert.equal(restored.session.id, first.session.id)
    assert.deepEqual(identity.listListeningTcpPorts(a.pid), [])
  } finally {
    await mm.stop()
    await fs.rm(directory, { recursive: true, force: true })
  }
})
