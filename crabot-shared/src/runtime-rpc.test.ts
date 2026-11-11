import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { after, before, test } from 'node:test'
import { RuntimeRpcPeer, RuntimeRpcError } from './runtime-rpc.js'

const entry = new URL('../dist/index.js', import.meta.url).href
let child: ChildProcess
let peer: RuntimeRpcPeer
let diagnostics = ''
const received: unknown[] = []

before(async () => {
  child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { ModuleBase, RpcClient, RpcError, RuntimeRpcError, getProcessRpcPeer } from ${JSON.stringify(entry)}
    import * as peerCopy from ${JSON.stringify(new URL('../dist/runtime-rpc.js?channel-copy', import.meta.url).href)}
    class Fixture extends ModuleBase {
      constructor() {
        super({ moduleId: 'fixture', moduleType: 'channel', version: '0.1.0', protocolVersion: '0.2.0', port: 20001 })
        this.registerMethod('peer_copy', () => ({ samePeer: getProcessRpcPeer() === peerCopy.getProcessRpcPeer(), sameError: new RuntimeRpcError('FORBIDDEN', 'denied') instanceof peerCopy.RuntimeRpcError }))
        this.registerMethod('echo', params => { params.items.push('child'); return params })
        this.registerMethod('fail', () => { throw new RpcError('FORBIDDEN', 'denied', { retryable: false }) })
        this.registerMethod('nested', async params => this.rpcClient.call(19000, 'parent_echo', params, 'fixture'))
        this.registerMethod('sensitive', () => this.rpcClient.callSensitive(19000, 'get_agent_config', { marker: 'assertion-secret' }, 'fixture', { authorizationBearer: 'bearer-secret' }))
        this.registerMethod('unsafe', () => this.rpcClient.call(19000, 'get_agent_config', {}, 'fixture'))
        this.registerMethod('never', () => new Promise(() => {}))
        this.registerMethod('late', () => new Promise(resolve => setTimeout(() => resolve('late'), 40)))
        this.registerMethod('untransferable', () => ({ fn() {} }))
      }
      async onStart() { this.keepAlive = setInterval(() => {}, 1000) }
      async onStop() { clearInterval(this.keepAlive) }
      createServer() { throw new Error('IPC module must not create an HTTP server') }
    }
    const module = new Fixture()
    JSON.stringify = () => { throw new Error('Internal RPC must not encode JSON') }
    JSON.parse = () => { throw new Error('Internal RPC must not decode JSON') }
    await module.start()
    await module.register()
    process.send({ type: 'fixture:ready' })
  `], {
    env: { ...process.env, CRABOT_RPC_TRANSPORT: 'ipc', CRABOT_MM_PORT: '19000' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced',
  })
  child.stdout!.on('data', bytes => { diagnostics += bytes })
  child.stderr!.on('data', bytes => { diagnostics += bytes })
  peer = new RuntimeRpcPeer(child)
  peer.handle(call => {
    received.push(call)
    assert.equal(call.target, 19000)
    if (call.method === 'register') return { registered: true }
    if (call.method === 'get_agent_config') {
      assert.equal(call.metadata?.authorizationBearer, 'bearer-secret')
      assert.deepEqual(call.params, { marker: 'assertion-secret' })
      return { connection: 'connection-secret' }
    }
    return call.params
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture startup timed out: ${diagnostics}`)), 10_000)
    child.on('message', message => {
      if ((message as { type?: string }).type === 'fixture:ready') { clearTimeout(timer); resolve() }
    })
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Fixture exited: ${diagnostics}`)) })
  })
})
after(async () => {
  peer?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
})

function call<R>(method: string, params: unknown = {}, timeoutMs = 1000): Promise<R> {
  return peer.call<R>({ target: 20001, method, params, source: 'parent' }, timeoutMs)
}

test('managed ModuleBase starts and registers with no HTTP server', () => {
  assert.ok(received.some(value => (value as { method: string }).method === 'register'))
})
test('real IPC copies objects and preserves values JSON cannot encode', async () => {
  const value = { items: ['parent'], bigint: 123n, date: new Date('2026-01-01'), bytes: Buffer.from([1, 2]) }
  const result = await call<typeof value>('echo', value)
  assert.deepEqual(value.items, ['parent'])
  assert.deepEqual(result.items, ['parent', 'child'])
  assert.equal(result.bigint, 123n)
  assert.equal(result.date.getTime(), value.date.getTime())
  assert.deepEqual(result.bytes, value.bytes)
})
test('concurrent bidirectional calls retain their own results', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => call('nested', { index })))
  assert.deepEqual(results, Array.from({ length: 12 }, (_, index) => ({ index })))
})
test('business error code and details survive the process boundary', async () => {
  await assert.rejects(call('fail'), error => error instanceof RuntimeRpcError && error.code === 'FORBIDDEN' && error.details?.retryable === false)
  await assert.rejects(call('missing'), error => error instanceof RuntimeRpcError && error.code === 'METHOD_NOT_FOUND')
})
test('sensitive calls use separate metadata and never print secrets', async () => {
  assert.deepEqual(await call('sensitive'), { connection: 'connection-secret' })
  const count = received.length
  await assert.rejects(call('unsafe'), error => error instanceof RuntimeRpcError && error.code === 'SENSITIVE_RPC_REQUIRES_NO_TRACE_TRANSPORT')
  assert.equal(received.length, count)
  for (const marker of ['assertion-secret', 'bearer-secret', 'connection-secret']) assert.ok(!diagnostics.includes(marker))
})
test('bad target and malformed authorization are rejected', async () => {
  await assert.rejects(peer.call({ target: 20002, method: 'health', params: {}, source: 'parent' }), { code: 'NOT_FOUND' })
  await assert.rejects(peer.call({ target: 20001, method: 'health', params: {}, source: 'parent', metadata: { authorizationBearer: 'bad\nvalue' } }), { code: 'UNAUTHORIZED' })
})
test('timeout and unserializable result fail one call without breaking the peer', async () => {
  await assert.rejects(call('late', {}, 10), { code: 'RPC_TIMEOUT' })
  await new Promise(resolve => setTimeout(resolve, 60))
  await assert.rejects(call('untransferable'), { code: 'INTERNAL_ERROR' })
  assert.deepEqual(await call('nested', { alive: true }), { alive: true })
})
test('shutdown releases the IPC handle so a service can exit normally', async () => {
  const entryPath = new URL('../dist/index.js', import.meta.url).href
  const service = spawn(process.execPath, ['--input-type=module', '-e', `
    import { ModuleBase } from ${JSON.stringify(entryPath)}
    class Fixture extends ModuleBase { async onStart() {} async onStop() {} }
    const module = new Fixture({ moduleId: 'exit-fixture', moduleType: 'channel', version: '1', protocolVersion: '1', port: 21001 })
    await module.start()
    process.send({ type: 'ready' })
  `], { env: { ...process.env, CRABOT_RPC_TRANSPORT: 'ipc' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' })
  const servicePeer = new RuntimeRpcPeer(service)
  const exited = once(service, 'exit')
  try {
    await once(service, 'message')
    await servicePeer.call({ target: 21001, source: 'parent', method: 'shutdown', params: {} }, 1000)
    const result = await Promise.race([exited, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('IPC kept stopped service alive')), 2000)
      exited.finally(() => clearTimeout(timer))
    })])
    assert.deepEqual(result, [0, null])
  } finally {
    servicePeer.close()
    if (service.exitCode === null && service.signalCode === null) service.kill('SIGKILL')
    await exited
  }
})

test('independent npm Shared copies reuse the child peer and recognize its typed errors', async () => {
  assert.deepEqual(await call('peer_copy'), { samePeer: true, sameError: true })
})

test('disconnect rejects pending calls and never retries them', async () => {
  const pending = call('never', {}, 5000)
  const exited = once(child, 'exit')
  child.disconnect()
  await assert.rejects(pending, { code: 'SERVICE_UNAVAILABLE' })
  await assert.rejects(call('nested', {}), { code: 'SERVICE_UNAVAILABLE' })
  let timer: NodeJS.Timeout
  try {
    assert.deepEqual(await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Lost manager did not clean up its module')), 1000)
    })]), [0, null])
  } finally { clearTimeout(timer!) }
})
