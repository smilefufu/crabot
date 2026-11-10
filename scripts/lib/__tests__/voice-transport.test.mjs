import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import transport from '../voice-transport.cjs'
const require = createRequire(new URL('../../../crabot-channel-voice/package.json', import.meta.url))
const { WebSocket } = require('ws')
const { voiceTransport } = await import('../../../crabot-channel-voice/dist/transport.js')
const { VoiceGateway } = await import('../../../crabot-admin/dist/voice-gateway.js')

test('Voice relays binary frames over the verified private pipe with only the Admin TCP listener', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crabot-voice-pipe-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const voice = voiceTransport((_req, res) => { res.writeHead(404); res.end() }, socket => {
    socket.on('message', (bytes, binary) => socket.send(bytes, { binary }))
  }, true)
  console.log('VOICE_PIPE_STAGE creating listener')
  const listener = await transport.listenVoiceTransport(directory, voice.server)
  t.after(async () => { voice.close(); await listener.close() })
  assert.equal(voice.server.address(), null)
  await assert.rejects(transport.connectVoiceTransport(directory, { ...listener.description, socket_address: '/untrusted' }))
  await assert.rejects(transport.connectVoiceTransport(directory, { ...listener.description, server: { ...listener.description.server, started: 'wrong' } }))
  const gateway = new VoiceGateway({ connection: () => ({ base_url: 'http://phone.test', transport: 'ws' }),
    resolve: async () => { throw new Error('Virtual port must never be dialed') },
    connect: () => transport.connectVoiceTransport(directory, listener.description) })
  const admin = http.createServer()
  admin.on('upgrade', (req, socket, head) => { void gateway.upgrade(req, socket, head).catch(() => socket.destroy()) })
  admin.listen(0, '127.0.0.1'); await once(admin, 'listening')
  t.after(async () => { gateway.close(); await new Promise(resolve => admin.close(resolve)) })
  console.log('VOICE_PIPE_STAGE connecting public phone')
  const phone = new WebSocket(`ws://127.0.0.1:${admin.address().port}/ws/voice/phone`, { headers: { Authorization: 'not-forwarded' } })
  t.after(() => phone.terminate())
  await once(phone, 'open')
  console.log('VOICE_PIPE_STAGE phone open')
  const result = once(phone, 'message'), pcm = Buffer.alloc(640, 9)
  phone.send(pcm)
  const [bytes, binary] = await result
  assert.equal(binary, true); assert.deepEqual(Buffer.from(bytes), pcm)
  console.log('VOICE_PIPE_STAGE binary relayed')
  const closed = once(phone, 'close'); gateway.close('phone'); await closed
  console.log('VOICE_PIPE_STAGE closed')
})

test('the actual managed Voice child starts its private transport and cleans it on IPC disconnect', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crabot-voice-child-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const { RuntimeRpcPeer } = await import('../../../crabot-shared/dist/runtime-rpc.js')
  const program = `
    import {VoiceChannel} from ${JSON.stringify(new URL('../../../crabot-channel-voice/dist/voice-channel.js', import.meta.url).href)}
    const channel=new VoiceChannel({moduleId:'voice-fixture',moduleType:'channel',version:'0.1.0',protocolVersion:'0.9.0',port:24001},process.env.DATA_DIR,'synthetic-runtime')
    await channel.start();process.send({ready:true})
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], { cwd: root,
    env: { ...process.env, DATA_DIR: directory, CRABOT_HOME: root, CRABOT_RPC_TRANSPORT: 'ipc', CRABOT_MM_PORT: '19000' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' })
  let output = ''; child.stderr.on('data', bytes => { output += bytes }); child.stdout.on('data', bytes => { output += bytes })
  const peer = new RuntimeRpcPeer(child)
  peer.handle(call => {
    if (call.method === 'resolve') return { modules: [{ module_id: 'admin-web', port: 19002 }] }
    if (call.method === 'get_voice_config') {
      assert.equal(call.metadata.authorizationBearer, 'synthetic-runtime')
      return { terminal_entry: null }
    }
    if (call.method === 'sync_voice_terminal') return { synced: true }
    throw new Error('Unexpected Voice fixture call: ' + call.method)
  })
  t.after(() => { peer.close(); if (child.exitCode === null) child.kill() })
  const exited = once(child, 'exit')
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Managed Voice startup timed out: ' + output)), 10000)
    const ready = message => { if (message?.ready) { clearTimeout(timer); child.off('message', ready); resolve() } }
    child.on('message', ready)
    void exited.then(() => { clearTimeout(timer); reject(new Error(output)) })
  })
  console.log('VOICE_CHILD_STAGE ready')
  const description = await peer.call({ target: 24001, source: 'admin-web', method: 'get_voice_transport', params: {} }, 1000)
  assert.equal(description.server.pid, child.pid)
  console.log('VOICE_CHILD_STAGE description')
  const socket = await transport.connectVoiceTransport(directory, description)
  console.log('VOICE_CHILD_STAGE connected pipe')
  const phone = new WebSocket('ws://localhost/voice', { createConnection: () => socket })
  t.after(() => phone.terminate())
  await once(phone, 'open')
  console.log('VOICE_CHILD_STAGE phone open')
  const rejected = once(phone, 'message')
  phone.send('{}')
  assert.equal(JSON.parse((await rejected)[0].toString()).code, 'VOICE_REJECTED')
  console.log('VOICE_CHILD_STAGE rejected')
  child.disconnect()
  const [code] = await exited
  console.log('VOICE_CHILD_STAGE exited', code, output)
  assert.equal(code, 0, output)
  await assert.rejects(transport.connectVoiceTransport(directory, description))
})
