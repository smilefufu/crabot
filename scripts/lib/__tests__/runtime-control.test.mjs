import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import control from '../runtime-control.cjs'
import { probeMmModules, probeMmHealthy, probeHealthStatus } from '../mm-probe.mjs'
const require = createRequire(import.meta.url)
const identity = require('../process-identity.cjs')
const root = fileURLToPath(new URL('../../..', import.meta.url))

test('private runtime calls bind the current OS peer and keep bearer separate from params', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-control-'))
  const before = identity.listListeningTcpPorts(process.pid)
  const transport = require('../local-auth-transport.cjs')
  assert.notEqual(transport.authAddress(data), transport.authAddress(data, identity.inspectProcess(process.pid), 'runtime'))
  let observed
  const server = await control.startRuntimeControl({ dataDir: data, root, target: 19000, dispatch(call, peer) {
    observed = { call, peer }
    return { text: call.params.text, binary: new Uint8Array([1, 2]) }
  } })
  try {
    assert.equal(control.hasRuntimeControl(data), true)
    const result = await control.callRuntimeControl(data, { target: 19000, source: 'not-an-authenticated-identity', method: 'fixture',
      params: { text: 'synthetic' }, metadata: { authorizationBearer: 'metadata-only' } })
    assert.equal(result.text, 'synthetic')
    assert.deepEqual([...result.binary], [1, 2])
    assert.equal(observed.peer.pid, process.pid)
    assert.equal(observed.call.metadata.authorizationBearer, 'metadata-only')
    assert.equal(JSON.stringify(observed.call.params).includes('metadata-only'), false)
    assert.deepEqual(identity.listListeningTcpPorts(process.pid), before)
    const file = path.join(data, 'runtime-control.json')
    const description = JSON.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(file, JSON.stringify({ ...description, server: { ...description.server, started: 'stale' } }))
    await assert.rejects(control.callRuntimeControl(data, { target: 19000, source: 'fixture', method: 'fixture', params: {} }))
    await fs.writeFile(file, JSON.stringify(description) + '\n')
  } finally { await server.close(); await fs.rm(data, { recursive: true, force: true }) }
})


test('standalone shared client uses verified local control and retains sensitive error types', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-control-client-'))
  const { RuntimeRpcError } = require('../../../crabot-shared/dist/index.js')
  const origins = []
  const server = await control.startRuntimeControl({ dataDir: data, root, target: 19000, dispatch(call, peer) {
    origins.push(peer.pid)
    assert.equal(call.source, 'untrusted-source')
    if (call.metadata?.authorizationBearer !== 'synthetic-bearer') throw new RuntimeRpcError('FORBIDDEN', 'Denied')
    assert.deepEqual(call.params, { expected_module_id: 'crabot-agent' })
    return { verified: true }
  } })
  try {
    const entry = path.join(root, 'crabot-shared/dist/index.js')
    const source = `
      const {RpcClient,RpcCallError}=require(${JSON.stringify(entry)})
      const client=new RpcClient(19000)
      ;(async()=>{
        const result=await client.callSensitive(19000,'verify_core_agent_runtime',{expected_module_id:'crabot-agent'},'untrusted-source',{authorizationBearer:'synthetic-bearer'})
        let denied=false
        try {await client.callSensitive(19000,'verify_core_agent_runtime',{expected_module_id:'crabot-agent'},'untrusted-source',{})}
        catch(error){denied=error instanceof RpcCallError&&error.code==='FORBIDDEN'}
        console.log(JSON.stringify({verified:result.verified,denied}))
      })().catch(()=>{process.exitCode=1})
    `
    const result = await promisify(execFile)(process.execPath, ['--input-type=commonjs', '-e', source], {
      env: { ...process.env, CRABOT_RPC_TRANSPORT: 'ipc', CRABOT_HOME: root, CRABOT_RUNTIME_DATA_DIR: data }, timeout: 5000,
    })
    assert.deepEqual(JSON.parse(result.stdout), { verified: true, denied: true })
    assert.ok(origins.every(pid => pid !== process.pid))
    assert.equal(result.stderr, '')
  } finally { await server.close(); await fs.rm(data, { recursive: true, force: true }) }
})


test('health probes use the verified local pipe and never fall back to an unrelated HTTP listener', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-control-probe-'))
  const calls = []
  const server = await control.startRuntimeControl({ dataDir: data, root, target: 19000, dispatch(call) {
    calls.push(call)
    if (call.method === 'list_modules') return { modules: [{ module_id: 'admin-web', status: 'running', port: 19001 }] }
    return { status: call.target === 19000 ? 'healthy' : 'degraded' }
  } })
  const noHttp = () => { throw new Error('Unexpected HTTP probe') }
  try {
    assert.equal((await probeMmModules(19000, noHttp, { dataDir: data }))[0].module_id, 'admin-web')
    assert.equal(await probeMmHealthy(19000, noHttp, { dataDir: data }), true)
    assert.equal(await probeHealthStatus(19001, noHttp, { dataDir: data }), 'degraded')
    assert.equal(calls.length, 3)
    const file = path.join(data, 'runtime-control.json')
    const description = JSON.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(file, JSON.stringify({ ...description, server: { ...description.server, started: 'changed' } }))
    let attempts = 0
    assert.equal(await probeHealthStatus(19000, () => { attempts++; return {} }, { dataDir: data }), null)
    assert.equal(attempts, 0)
    await fs.writeFile(file, JSON.stringify(description) + '\n')
  } finally { await server.close(); await fs.rm(data, { recursive: true, force: true }) }
})
