import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { openSpawnedModuleRuntimeRpc } = require('../module-carrier-rpc.cjs')
const native = require('../process-identity.cjs')
const { captureSpawnedProcessTree } = require('../spawned-process-tree.cjs')
const { stopKnownProcessScope } = require('../known-process-stop.cjs')

async function carrier(serve) {
  const identity = { instance_id: randomUUID(), module_id: 'finite-module', runtime_id: randomUUID() }
  const child = spawn(process.execPath, ['-e', `const http=require('node:http');
    if(${serve})http.createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;const body=JSON.parse(text);
      const data=body.method==='get_runtime_identity'?${JSON.stringify(identity)}:{status:'healthy',details:{pid:process.pid}};
      res.end(JSON.stringify({id:body.id,success:true,data}));
    }).listen(0,'127.0.0.1',function(){process.send({port:this.address().port})});
    else process.send({port:0});setTimeout(()=>process.exit(0),30000);`], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const ended = once(child, 'exit'); void ended.catch(() => {})
  let scope
  try {
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5000) })
    scope = captureSpawnedProcessTree(child)
    const stop = async () => { await stopKnownProcessScope(scope, { timeoutMs: 10, onObserved: async () => {} }); await ended }
    return { child, identity, root: native.inspectProcess(child.pid), port: ready.port, stop, cleanup: stop }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      scope ??= captureSpawnedProcessTree(child)
      await stopKnownProcessScope(scope, { timeoutMs: 10, onObserved: async () => {} })
    }
    await ended; throw error
  }
}
const rejects = promise => assert.rejects(promise, { code: 'CRABOT_MODULE_CARRIER_UNVERIFIED' })

test('binds a direct actual ChildProcess runtime and one health connection', { timeout: 30000 }, async () => {
  const f = await carrier(true); let rpc
  try {
    rpc = await openSpawnedModuleRuntimeRpc(f.child, f.root, f.port, f.identity, { timeoutMs: 5000 })
    assert.deepEqual(await rpc.call('health', {}), { status: 'healthy', details: { pid: f.child.pid } })
  } finally { rpc?.close(); await f.cleanup() }
})

for (const mode of ['cold object', 'wrong birth', 'wrong runtime']) test('rejects a changed carrier binding: ' + mode, { timeout: 30000 }, async () => {
  const f = await carrier(true)
  try {
    await rejects(openSpawnedModuleRuntimeRpc(mode === 'cold object' ? { pid: f.child.pid, exitCode: null, signalCode: null } : f.child,
      mode === 'wrong birth' ? { ...f.root, started: f.root.started + '-changed' } : f.root, f.port,
      mode === 'wrong runtime' ? { ...f.identity, runtime_id: randomUUID() } : f.identity, { timeoutMs: 5000 }))
    assert.equal(native.sameProcess(f.root, native.inspectProcess(f.child.pid)), true)
  } finally { await f.cleanup() }
})

test('refuses an unrelated same-user listener before any request', { timeout: 30000 }, async () => {
  const f = await carrier(false); let calls = 0
  const server = http.createServer((req, res) => { calls++; res.end('{}') })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    await rejects(openSpawnedModuleRuntimeRpc(f.child, f.root, server.address().port, f.identity, { timeoutMs: 5000 }))
    assert.equal(calls, 0); assert.equal(server.listening, true)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.cleanup() }
})

test('does not follow another connection after the actual carrier exits', { timeout: 30000 }, async () => {
  const f = await carrier(true); let rpc
  try {
    rpc = await openSpawnedModuleRuntimeRpc(f.child, f.root, f.port, f.identity, { timeoutMs: 5000 })
    await f.stop()
    await rejects(rpc.call('health', {}))
  } finally { rpc?.close(); await f.cleanup() }
})

for (const phase of ['open', 'call']) test('retains the native observation failure and closes the fixed RPC: ' + phase, { timeout: 30000 }, async t => {
  const f = await carrier(true); let rpc, inspect
  const denied = Object.assign(new Error('Cannot inspect process identity (Windows error 299)'), { code: 'CRABOT_PROCESS_SCOPE', stage: 'identity-process-image' })
  try {
    if (phase === 'call') rpc = await openSpawnedModuleRuntimeRpc(f.child, f.root, f.port, f.identity, { timeoutMs: 5000 })
    const original = native.inspectProcess
    inspect = t.mock.method(native, 'inspectProcess', function(pid) { if (pid === f.child.pid) throw denied; return original.call(this, pid) })
    await assert.rejects(phase === 'open' ? openSpawnedModuleRuntimeRpc(f.child, f.root, f.port, f.identity, { timeoutMs: 5000 }) : rpc.call('health', {}),
      error => error.code === 'CRABOT_MODULE_CARRIER_UNVERIFIED' && error.cause === denied)
    inspect.mock.restore(); inspect = undefined
    if (rpc) await rejects(rpc.call('health', {}))
    assert.equal(native.sameProcess(f.root, native.inspectProcess(f.child.pid)), true)
  } finally { inspect?.mock.restore(); rpc?.close(); await f.cleanup() }
})
