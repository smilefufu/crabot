import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { WorkspaceCatalog } from 'crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson } from 'crabot-shared'
import ModuleManager from './index.js'

async function fixture(options: { wrongRuntime?: boolean; result?: string; withAgent?: boolean; agentResult?: string } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-current-admin-')))
  const native = require('../../scripts/lib/process-identity.cjs'), management = require('../../scripts/lib/desktop-management.cjs')
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), script = path.join(data, 'finite-admin.cjs'), callsFile = path.join(data, 'calls.json')
  const reserve = http.createServer(); await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()))
  await fs.writeFile(script, `const fs=require('node:fs'),http=require('node:http'),calls=[];
    const server=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);
      calls.push({method:req.url,authorization:req.headers.authorization?'present':undefined,body});fs.writeFileSync(process.env.FIXTURE_CALLS,JSON.stringify(calls));
      let data=req.url==='/get_runtime_identity'?{instance_id:process.env.CRABOT_INSTANCE_ID,module_id:'admin-web',runtime_id:process.env.FIXTURE_WRONG_RUNTIME?'other':process.env.CRABOT_MODULE_RUNTIME_ID}:{verified:true,...body.params};
      if(req.url!=='/get_runtime_identity'&&req.headers.authorization!=='Bearer fixture-human'){res.writeHead(403);res.end(JSON.stringify({id:body.id,success:false,error:{code:'FORBIDDEN',message:'denied'}}));return}
      if(req.url!=='/get_runtime_identity'&&process.env.FIXTURE_RESULT==='false')data.verified=false;
      if(req.url!=='/get_runtime_identity'&&process.env.FIXTURE_RESULT==='hash')data.intent_sha256='0'.repeat(64);
      if(req.url!=='/get_runtime_identity'&&process.env.FIXTURE_RESULT==='extra')data.unexpected='do-not-trust';
      setTimeout(()=>res.end(JSON.stringify({id:body.id,success:true,data})),0);
    });server.listen(Number(process.env.Crabot_PORT),'127.0.0.1',()=>fs.writeFileSync(process.env.FIXTURE_READY,'ready'));
    setTimeout(()=>process.exit(0),30000).unref();`)
  const manager = new ModuleManager({ port: 0, modules: [], shutdown_timeout: 0.1 }, data) as any
  manager.managementOnly = false
  const runtime = { module_id: 'admin-web', module_type: 'admin', entry: `"${process.execPath}" "${script}"`,
    env: { FIXTURE_CALLS: callsFile, FIXTURE_READY: path.join(data, 'ready'), ...(options.wrongRuntime ? { FIXTURE_WRONG_RUNTIME: '1' } : {}),
 ...(options.result ? { FIXTURE_RESULT: options.result } : {}) },
    port, auto_start: false, auto_restart: false, skip_health_check: true, start_priority: 1, status: 'stopped' }
  manager.modules.set('admin-web', runtime); await manager.startModuleProcess('admin-web')
  await vi.waitFor(async () => expect(await fs.readFile(path.join(data, 'ready'), 'utf8')).toBe('ready'))
  if (options.withAgent) {
    const agentPort = http.createServer(); await new Promise<void>(resolve => agentPort.listen(0, '127.0.0.1', resolve))
    const agentScript = path.join(data, 'finite-agent.cjs'), agentReady = path.join(data, 'agent-ready')
    await fs.writeFile(agentScript, `const fs=require('node:fs'),http=require('node:http'),calls=[];
      http.createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;const body=JSON.parse(text);
        calls.push({method:body.method,header_present:Boolean(req.headers.authorization),body});fs.writeFileSync(process.env.FIXTURE_CALLS,JSON.stringify(calls));
        if(req.url!=='/get_runtime_identity'&&process.env.FIXTURE_RESULT==='disconnect'){req.socket.destroy();return}
        let data=req.url==='/get_runtime_identity'?{instance_id:process.env.CRABOT_INSTANCE_ID,module_id:'crabot-agent',runtime_id:process.env.FIXTURE_RESULT==='wrong-runtime'?'other':process.env.CRABOT_MODULE_RUNTIME_ID}:{workers:[]};
        if(req.url!=='/get_runtime_identity'&&process.env.FIXTURE_RESULT==='extra')data.extra=true;
        if(req.url!=='/get_runtime_identity'&&process.env.FIXTURE_RESULT==='bad-worker')data.workers=[{worker_id:'bad'}];
        if(req.url!=='/get_runtime_identity'&&['large','one-worker'].includes(process.env.FIXTURE_RESULT))data.workers=Array.from({length:process.env.FIXTURE_RESULT==='large'?1500:1},(_,i)=>({worker_id:String(i).padStart(5,'0'),manager_key:'channel::session',task_id:'task-'+i,incarnations:[{incarnation_id:'inc-'+i,impl:'builtin',seq:1,workspace:'fixture/'+('a'.repeat(120)),started_at:new Date().toISOString()}]}));
        res.end(JSON.stringify({id:body.id,success:true,data}));
      }).listen(Number(process.env.Crabot_PORT),'127.0.0.1',()=>fs.writeFileSync(process.env.FIXTURE_READY,'ready'));setTimeout(()=>process.exit(0),30000).unref();`)
    const agent = { module_id: 'crabot-agent', module_type: 'agent', entry: `"${process.execPath}" "${agentScript}"`,
      env: { FIXTURE_CALLS: path.join(data, 'agent-calls.json'), FIXTURE_READY: agentReady, FIXTURE_RESULT: options.agentResult ?? '' },
      port: (agentPort.address() as { port: number }).port, auto_start: false, auto_restart: false, skip_health_check: true, start_priority: 1, status: 'stopped' }
    await new Promise<void>(resolve => agentPort.close(() => resolve()))
    manager.modules.set('crabot-agent', agent); await manager.startModuleProcess('crabot-agent')
    await vi.waitFor(async () => expect(await fs.readFile(agentReady, 'utf8')).toBe('ready'), { timeout: 10000 })
  }
  const catalog = new WorkspaceCatalog({ dataRoot: data, files: native }); await catalog.initialize()
  const locks = await import('../../scripts/lib/cli-lock.mjs'), relocation = await import('../../scripts/lib/workspace-relocation-intent.mjs')
  const lock = await locks.acquireCliLock(data, 'workspace-relocation'); let intent
  try { intent = await relocation.beginWorkspaceRelocationIntent({ dataDir: data, id: randomUUID(), target: path.join(root, 'relocated'),
    expectedRevision: (await catalog.snapshot()).revision, protectedRoots: [path.join(data, 'workspace-control')] }) }
  finally { locks.releaseCliLock(lock) }
  const params = { intent_id: intent.id, intent_sha256: sha256CanonicalJson(intent) }
  const calls = async (): Promise<any[]> => JSON.parse(await fs.readFile(callsFile, 'utf8').catch(() => '[]'))
  return { root, data, manager, runtime, port, params, calls, cleanup: async () => {
    vi.restoreAllMocks(); runtime.port = port; await manager.stop(); await fs.rm(root, { recursive: true, force: true })
  } }
}
describe('MM consumes a human intent proof only from its current Admin runtime', () => {
  it('verifies the actual spawned Admin/runtime and own intent without stopping or creating a coordinator', async () => {
    const f = await fixture()
    try {
      const records = await f.manager.runtimeRegistry.listRecords()
      expect(await f.manager.verifyWorkspaceRelocationRequest(f.params, 'fixture-human')).toEqual({ verified: true, ...f.params })
      const calls = await f.calls()
      expect(calls.map(item => item.method)).toEqual(['/get_runtime_identity', '/verify_workspace_relocation_request'])
      expect(calls.map(item => item.authorization)).toEqual([undefined, 'present'])
      expect(JSON.stringify(calls.map(item => item.body))).not.toContain('fixture-human')
      expect(f.manager.processes.get('admin-web').exitCode).toBeNull()
      expect(await f.manager.runtimeRegistry.listRecords()).toEqual(records)
      await expect(fs.stat(path.join(f.root, 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.cleanup() }
  }, 30_000)
  it('refuses missing bearer before consulting runtime records', async () => {
    const f = await fixture(), read = vi.spyOn(f.manager.runtimeRegistry, 'listRecords')
    try {
      await expect(f.manager.verifyWorkspaceRelocationRequest(f.params)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(read).not.toHaveBeenCalled(); expect(await f.calls()).toEqual([])
    } finally { await f.cleanup() }
  }, 30_000)
  for (const kind of ['missing record', 'changed creation identity']) it(`refuses unverified Admin ownership: ${kind}`, async () => {
    const f = await fixture()
    try {
      const state = f.manager.childStates.get(f.manager.processes.get('admin-web'))
      const file = path.join(f.data, 'module-runtime-registry/records', state.runtimeId + '.json')
      if (kind === 'missing record') await fs.rm(file)
      else { const record = JSON.parse(await fs.readFile(file, 'utf8')); record.process_start_identity = 'changed'; await fs.writeFile(file, JSON.stringify(record)) }
      await expect(f.manager.verifyWorkspaceRelocationRequest(f.params, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(await f.calls()).toEqual([])
    } finally { await f.cleanup() }
  }, 30_000)
  it('does not forward the human bearer to a mismatched runtime', async () => {
    const f = await fixture({ wrongRuntime: true })
    try {
      await expect(f.manager.verifyWorkspaceRelocationRequest(f.params, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect((await f.calls()).map(item => item.authorization)).toEqual([undefined])
    } finally { await f.cleanup() }
  }, 30_000)
  it('rechecks the current Admin after the identity response before forwarding a credential', async () => {
    const f = await fixture(), transport = require('../../scripts/lib/module-runtime-rpc.cjs')
    const open = transport.openModuleRuntimeRpc
    vi.spyOn(transport, 'openModuleRuntimeRpc').mockImplementation(async (...args: unknown[]) => {
      const rpc = await open(...args)
      f.runtime.port++
      return rpc
    })
    try {
      await expect(f.manager.verifyWorkspaceRelocationRequest(f.params, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect((await f.calls()).map(item => item.authorization)).toEqual([undefined])
    } finally { await f.cleanup() }
  }, 30_000)
  for (const result of ['false', 'hash', 'extra']) it(`does not trust a malformed positive authorization result: ${result}`, async () => {
    const f = await fixture({ result })
    try { await expect(f.manager.verifyWorkspaceRelocationRequest(f.params, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' }) }
    finally { await f.cleanup() }
  }, 30_000)
  it('requires the proof to match the MM data root even when a server claims it verified', async () => {
    const f = await fixture()
    try {
      await expect(f.manager.verifyWorkspaceRelocationRequest({ ...f.params, intent_id: randomUUID() }, 'fixture-human')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    } finally { await f.cleanup() }
  }, 30_000)
})


async function coordinator(f: Awaited<ReturnType<typeof fixture>>, journal = 'normal') {
  const locks = await import('../../scripts/lib/cli-lock.mjs'), relocation = await import('../../scripts/lib/workspace-relocation-intent.mjs')
  const native = require('../../scripts/lib/process-identity.cjs'), entry = new URL('../../scripts/lib/workspace-coordinator-entry.mjs', import.meta.url).href
  const journalEntry = new URL('../../scripts/lib/workspace-worker-journal.mjs', import.meta.url).href
  const code = `import{enterWorkspaceRelocationCoordinator}from ${JSON.stringify(entry)};import{serveWorkspaceWorkerJournal}from ${JSON.stringify(journalEntry)};const context=await enterWorkspaceRelocationCoordinator();let serving;
    if(${JSON.stringify(journal)}==='false-ack')process.on('message',m=>{if(m.kind==='workspace_worker_journal_request')process.send({kind:'workspace_worker_journal_reply',request_id:m.request_id,launch_id:m.launch_id,operation:m.operation,ok:true,result:true})});
    else{if(['drop-reply','drop-prepare','drop-complete'].includes(${JSON.stringify(journal)})){const send=process.send.bind(process);let dropped=false;process.send=(m,cb)=>{
      const op={'drop-reply':'capture','drop-prepare':'prepare','drop-complete':'complete'}[${JSON.stringify(journal)}];
      if(!dropped&&m.kind==='workspace_worker_journal_reply'&&m.operation===op){dropped=true;cb?.(null);return true}return send(m,cb)}}serving=serveWorkspaceWorkerJournal(context)}
    process.on('message',m=>{if(m.kind==='fixture-change-policy'){
      if(m.policy==='lost-lock')context.release();
      if(m.policy==='false-ack'){serving.close();process.on('message',r=>{if(r.kind==='workspace_worker_journal_request')process.send({kind:'workspace_worker_journal_reply',request_id:r.request_id,launch_id:r.launch_id,operation:r.operation,ok:true,result:'dispatch'})})}
      process.send({kind:'fixture-policy-changed'})}});
    if(${JSON.stringify(journal)}==='lost-lock')context.release();process.send({kind:'fixture-ready'});setTimeout(()=>process.exit(0),30000);`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let output = ''; child.stderr.on('data', bytes => { output += bytes.toString() })
  const exited = once(child, 'exit'); void exited.catch(() => {})
  try {
    await once(child, 'spawn')
    const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    let launch
    try { launch = relocation.commitWorkspaceRelocationCoordinator({ dataDir: f.data, id: f.params.intent_id, launchId: randomUUID(), coordinator: native.inspectProcess(child.pid) }) }
    finally { locks.releaseCliLock(lock) }
    const messages: any[] = []; child.on('message', message => messages.push(message))
    child.send({ kind: 'workspace_relocation_start', data_dir: f.data, intent_id: f.params.intent_id, launch_id: launch.launch_id, launch_sha256: sha256CanonicalJson(launch) })
    await vi.waitFor(() => expect(messages.some(item => item.kind === 'fixture-ready'), output).toBe(true), { timeout: 10000 })
    return { child, launch, cleanup: async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited } }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited
    throw error
  }
}

describe('MM dedicated fixed coordinator authorization', () => {
  it('binds a human-confirmed intent to actual coordinator and current Agent without publishing a signing method', async () => {
    const f = await fixture({ withAgent: true }), c = await coordinator(f)
    try {
      const auth = await f.manager.authorizeWorkspaceRelocationCoordinator(c.child, f.params, 'fixture-human')
      expect(Object.keys(auth)).toEqual(['authorizationBearer'])
      expect(typeof auth.authorizationBearer).toBe('string')
      expect(await f.manager.authorizeWorkspaceRelocationCoordinator(c.child, f.params, 'fixture-human')).toEqual(auth)
      const params = { intent_id: f.params.intent_id, launch_id: c.launch.launch_id, action: 'capture_workers' }
      expect(await f.manager.handleVerifyWorkspaceRelocationCoordinator(params, auth)).toEqual({ verified: true,
        ...params, intent_sha256: f.params.intent_sha256, launch_sha256: sha256CanonicalJson(c.launch) })
      expect(f.manager.methodHandlers.has('authorize_workspace_relocation_coordinator')).toBe(false)
      expect(f.manager.methodHandlers.has('verify_workspace_relocation_coordinator')).toBe(true)
      const files = await fs.readdir(path.join(f.data, 'workspace-control'))
      for (const file of files.filter(name => name.endsWith('.json'))) expect(await fs.readFile(path.join(f.data, 'workspace-control', file), 'utf8')).not.toContain(auth.authorizationBearer)
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('requires the original human credential before issuing a separate capability', async () => {
    const f = await fixture({ withAgent: true }), c = await coordinator(f)
    try {
      await expect(f.manager.authorizeWorkspaceRelocationCoordinator(c.child, f.params)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(f.manager.workspaceCoordinatorGrant).toBeUndefined()
      expect(await f.calls()).toEqual([])
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('rejects body/source credentials, wrong jobs and malformed action params', async () => {
    const f = await fixture({ withAgent: true }), c = await coordinator(f)
    try {
      const auth = await f.manager.authorizeWorkspaceRelocationCoordinator(c.child, f.params, 'fixture-human')
      const params = { intent_id: f.params.intent_id, launch_id: c.launch.launch_id, action: 'stop_workers' }
      await expect(Promise.resolve().then(() => f.manager.handleVerifyWorkspaceRelocationCoordinator({ ...params, token: auth.authorizationBearer, source: 'module-manager' }))).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      for (const authorizationBearer of ['fixture-human', 'wrong', f.manager.runtimeBearers.get('crabot-agent').token]) {
        await expect(Promise.resolve().then(() => f.manager.handleVerifyWorkspaceRelocationCoordinator(params, { authorizationBearer }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
      }
      await expect(Promise.resolve().then(() => f.manager.handleVerifyCoreAgentRuntime({ expected_module_id: 'crabot-agent' }, auth))).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(Promise.resolve().then(() => f.manager.handleVerifyWorkspaceRelocationCoordinator({ ...params, intent_id: randomUUID() }, auth))).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(Promise.resolve().then(() => f.manager.handleVerifyWorkspaceRelocationCoordinator({ ...params, action: 'move_files' }, auth))).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
      await expect(Promise.resolve().then(() => f.manager.handleVerifyWorkspaceRelocationCoordinator({ ...params, path: f.data }, auth))).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('keeps the original request snapshot across human verification before binding the grant', async () => {
    const f = await fixture({ withAgent: true }), c = await coordinator(f), request = { ...f.params }
    const original = f.manager.verifyWorkspaceRelocationRequest.bind(f.manager)
    vi.spyOn(f.manager, 'verifyWorkspaceRelocationRequest').mockImplementation(async (params, bearer) => {
      const proof = await original(params, bearer)
      request.intent_id = randomUUID(); request.intent_sha256 = '0'.repeat(64)
      return proof
    })
    try {
      const auth = await f.manager.authorizeWorkspaceRelocationCoordinator(c.child, request, 'fixture-human')
      expect(await f.manager.handleVerifyWorkspaceRelocationCoordinator({ intent_id: f.params.intent_id, launch_id: c.launch.launch_id, action: 'capture_workers' }, auth)).toMatchObject({ verified: true, intent_sha256: f.params.intent_sha256 })
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  it.each(['missing Agent', 'fabricated child object'])('does not issue for an unbound execution identity: %s', async kind => {
    const f = await fixture({ withAgent: kind !== 'missing Agent' }), c = await coordinator(f)
    try {
      const child = kind === 'fabricated child object' ? { pid: c.child.pid, connected: true, exitCode: null, signalCode: null } : c.child
      await expect(f.manager.authorizeWorkspaceRelocationCoordinator(child, f.params, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.manager.workspaceCoordinatorGrant).toBeUndefined()
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('never restores a revoked credential when the old Agent generation fields are restored', async () => {
    const f = await fixture({ withAgent: true }), c = await coordinator(f)
    const state = f.manager.childStates.get(f.manager.processes.get('crabot-agent')), original = state.runtimeId
    try {
      const auth = await f.manager.authorizeWorkspaceRelocationCoordinator(c.child, f.params, 'fixture-human')
      const params = { intent_id: f.params.intent_id, launch_id: c.launch.launch_id, action: 'capture_workers' }
      state.runtimeId = 'replacement-runtime'
      await expect(Promise.resolve().then(() => f.manager.handleVerifyWorkspaceRelocationCoordinator(params, auth))).rejects.toMatchObject({ code: 'FORBIDDEN' })
      state.runtimeId = original
      await expect(Promise.resolve().then(() => f.manager.handleVerifyWorkspaceRelocationCoordinator(params, auth))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    } finally { state.runtimeId = original; await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('uses the real sensitive HTTP header without trusting source or a body credential', async () => {
    const f = await fixture({ withAgent: true }), c = await coordinator(f)
    const { RpcClient } = await import('crabot-shared')
    const server = http.createServer((req, res) => { void f.manager.handleRequest(req, res) })
    try {
      const auth = await f.manager.authorizeWorkspaceRelocationCoordinator(c.child, f.params, 'fixture-human')
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port, client = new RpcClient()
      const params = { intent_id: f.params.intent_id, launch_id: c.launch.launch_id, action: 'stop_workers' as const }
      const trace = { startSpan: () => { throw new Error('trace must not start') }, endSpan: () => {} }
      await expect(client.call(port, 'verify_workspace_relocation_coordinator', params, 'module-manager', { traceStore: trace, traceId: 'fixture' })).rejects.toMatchObject({ code: 'SENSITIVE_RPC_REQUIRES_NO_TRACE_TRANSPORT' })
      expect(await client.callSensitive(port, 'verify_workspace_relocation_coordinator', params, 'forged-source', auth)).toMatchObject({ verified: true, ...params })
      await expect(client.callSensitive(port, 'verify_workspace_relocation_coordinator', { ...params, token: auth.authorizationBearer }, 'module-manager')).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
      await c.cleanup(); await f.cleanup()
    }
  }, 30000)
  for (const kind of ['coordinator exit', 'Agent planned exit', 'Agent generation changed', 'private receipt damaged']) it(`does not trust a stale or unverifiable binding: ${kind}`, async () => {
    const f = await fixture({ withAgent: true }), c = await coordinator(f)
    const agentChild = f.manager.processes.get('crabot-agent'), state = f.manager.childStates.get(agentChild), original = state.runtimeId
    try {
      const auth = await f.manager.authorizeWorkspaceRelocationCoordinator(c.child, f.params, 'fixture-human')
      if (kind === 'coordinator exit') await c.cleanup()
      if (kind === 'Agent planned exit') await f.manager.stopModuleProcess('crabot-agent', 'shutdown')
      if (kind === 'Agent generation changed') state.runtimeId = 'replacement-runtime'
      if (kind === 'private receipt damaged') await fs.writeFile(path.join(f.data, 'workspace-control/relocation-coordinator-ready.json'), '{}')
      await expect(Promise.resolve().then(() => f.manager.handleVerifyWorkspaceRelocationCoordinator({ intent_id: f.params.intent_id, launch_id: c.launch.launch_id, action: 'capture_workers' }, auth))).rejects.toMatchObject({ code: kind === 'private receipt damaged' ? 'SERVICE_UNAVAILABLE' : 'FORBIDDEN' })
    } finally { state.runtimeId = original; await c.cleanup(); await f.cleanup() }
  }, 30000)
})


describe('MM delegates capture only to the fixed Agent and persists through its actual coordinator', () => {
  const agentCalls = async (data: string): Promise<any[]> => JSON.parse(await fs.readFile(path.join(data, 'agent-calls.json'), 'utf8').catch(() => '[]'))
  for (const result of ['normal', 'large']) it(`captures and fixes the original full scope without a stop attempt: ${result}`, async () => {
    const f = await fixture({ withAgent: true, agentResult: result }), c = await coordinator(f)
    try {
      const first = await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      const again = await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      expect(again).toBe(first); expect(first).toHaveLength(result === 'large' ? 1500 : 0)
      expect(Object.isFrozen(first)).toBe(true)
      const records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
      expect(records.readWorkspaceRelocationWorkers(f.data, f.params.intent_id).workers).toEqual(first)
      expect(records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
      const calls = await agentCalls(f.data)
      expect(calls.map(item => item.method)).toEqual(['get_runtime_identity', 'capture_workspace_relocation_workers'])
      expect(calls.map(item => item.header_present)).toEqual([false, true])
      expect(JSON.stringify(calls)).not.toContain(f.manager.workspaceCoordinatorGrant.token)
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  for (const result of ['wrong-runtime', 'extra', 'bad-worker', 'disconnect']) it(`rejects an unverified scope without selecting a new one: ${result}`, async () => {
    const f = await fixture({ withAgent: true, agentResult: result }), c = await coordinator(f)
    try {
      await expect(f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      const count = (await agentCalls(f.data)).length
      await expect(f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(await agentCalls(f.data)).toHaveLength(count)
      if (result === 'wrong-runtime') expect((await agentCalls(f.data)).map(item => item.header_present)).toEqual([false])
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-workers.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('rechecks the current Agent after the real runtime handshake before sending its bearer', async () => {
    const f = await fixture({ withAgent: true }), c = await coordinator(f)
    const transport = require('../../scripts/lib/module-runtime-rpc.cjs'), open = transport.openModuleRuntimeRpc
    const state = f.manager.childStates.get(f.manager.processes.get('crabot-agent'))
    vi.spyOn(transport, 'openModuleRuntimeRpc').mockImplementation(async (...args: any[]) => {
      const rpc = await open(...args)
      if (args[2].module_id === 'crabot-agent') state.intentionalReason = 'shutdown'
      return rpc
    })
    try {
      await expect(f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect((await agentCalls(f.data)).map(item => [item.method, item.header_present])).toEqual([['get_runtime_identity', false]])
      expect(f.manager.workspaceCoordinatorGrant).toBeUndefined()
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-workers.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { state.intentionalReason = undefined; await c.cleanup(); await f.cleanup() }
  }, 30000)
  for (const journal of ['false-ack', 'lost-lock', 'drop-reply']) it(`requires actual durable coordinator confirmation, never repeats capture: ${journal}`, async () => {
    const f = await fixture({ withAgent: true }), c = await coordinator(f, journal)
    try {
      await expect(f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      await expect(f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect((await agentCalls(f.data)).map(item => item.method)).toEqual(['get_runtime_identity', 'capture_workspace_relocation_workers'])
      const records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
      if (journal === 'drop-reply') expect(records.readWorkspaceRelocationWorkers(f.data, f.params.intent_id).workers).toEqual([])
      else expect(records.readWorkspaceRelocationWorkers(f.data, f.params.intent_id)).toBeNull()
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-stop-attempt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
})


async function workerStopBridgeFixture(journal = 'normal', capture = true) {
  const f = await fixture({ withAgent: true, agentResult: 'one-worker' }), c = await coordinator(f, journal)
  const auth = await f.manager.authorizeWorkspaceRelocationCoordinator(c.child, f.params, 'fixture-human')
  const params = { intent_id: f.params.intent_id, launch_id: c.launch.launch_id }
  if (capture) await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
  const server = http.createServer((req, res) => { void f.manager.handleRequest(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const call = async (method: string, input = params, bearer = auth.authorizationBearer) => {
    const response = await fetch(url + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
      body: JSON.stringify({ id: randomUUID(), source: 'crabot-agent', method, params: input }) })
    const result = await response.json() as any
    if (!result.success) throw Object.assign(new Error('finite bridge response rejected'), { code: result.error?.code })
    return result.data
  }
  return { ...f, c, auth, params, call, records: await import('../../scripts/lib/workspace-relocation-intent.mjs'), cleanup: async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await c.cleanup(); await f.cleanup()
  } }
}

const prepareStops = 'prepare_workspace_relocation_worker_stops', completeStops = 'complete_workspace_relocation_worker_stops'
const submittedResult = { worker_id: '00000', incarnation_id: 'inc-0', status: 'submitted' }
describe('MM sensitive Worker stop journal bridge', () => {
  it('confirms one durable attempt and the original complete submission without dispatching any Worker stop', async () => {
    const f = await workerStopBridgeFixture()
    try {
      expect(await f.call(prepareStops)).toEqual({ dispatch: 'dispatch' })
      expect(await f.call(prepareStops)).toEqual({ dispatch: 'observe' })
      const input = { ...f.params, results: [submittedResult] }
      expect(await f.call(completeStops, input)).toEqual({ recorded: true })
      const first = f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id)
      expect(first.submission.results).toEqual([submittedResult])
      expect(await f.call(completeStops, input)).toEqual({ recorded: true })
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id)).toEqual(first)
      const calls = JSON.parse(await fs.readFile(path.join(f.data, 'agent-calls.json'), 'utf8'))
      expect(calls.map((item: any) => item.method)).toEqual(['get_runtime_identity', 'capture_workspace_relocation_workers'])
    } finally { await f.cleanup() }
  }, 30000)
  for (const mode of ['missing header', 'wrong bearer', 'wrong job', 'extra field']) it(`refuses before any attempt: ${mode}`, async () => {
    const f = await workerStopBridgeFixture()
    try {
      const input: typeof f.params & { token?: string; workers?: unknown[] } = { ...f.params }
      let bearer = f.auth.authorizationBearer, code = 'FORBIDDEN'
      if (mode === 'missing header') { input.token = bearer; bearer = ''; code = 'UNAUTHORIZED' }
      else if (mode === 'wrong bearer') bearer = 'forged'
      else if (mode === 'wrong job') input.intent_id = randomUUID()
      else if (mode === 'extra field') { input.workers = []; code = 'INVALID_PARAMS' }
      await expect(f.call(prepareStops, input, bearer)).rejects.toMatchObject({ code })
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
    } finally { await f.cleanup() }
  }, 30000)
  for (const policy of ['lost-lock', 'false-ack']) it(`does not accept an unverified stop attempt confirmation: ${policy}`, async () => {
    const f = await workerStopBridgeFixture()
    let acknowledged = false
    const receive = (message: any) => { if (message.kind === 'fixture-policy-changed') acknowledged = true }
    f.c.child.on('message', receive)
    try {
      f.c.child.send({ kind: 'fixture-change-policy', policy })
      await vi.waitFor(() => expect(acknowledged).toBe(true))
      await expect(f.call(prepareStops)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
    } finally { f.c.child.off('message', receive); await f.cleanup() }
  }, 30000)
  it('requires an existing fixed scope rather than creating one from request params', async () => {
    const f = await workerStopBridgeFixture('normal', false)
    try {
      await expect(f.call(prepareStops)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.records.readWorkspaceRelocationWorkers(f.data, f.params.intent_id)).toBeNull()
    } finally { await f.cleanup() }
  }, 30000)
  it('refuses incomplete or conflicting submissions and preserves the first complete receipt', async () => {
    const f = await workerStopBridgeFixture()
    try {
      await f.call(prepareStops)
      await expect(f.call(completeStops, { ...f.params, results: [] })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).submission).toBeNull()
      await f.call(completeStops, { ...f.params, results: [submittedResult] })
      const first = f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).submission
      await expect(f.call(completeStops, { ...f.params, results: [{ ...submittedResult, status: 'unknown' }] })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).submission).toEqual(first)
    } finally { await f.cleanup() }
  }, 30000)
  it('rejects an in-flight confirmation after its grant is explicitly revoked even while native processes remain alive', async () => {
    const f = await workerStopBridgeFixture(), grant = f.manager.workspaceCoordinatorGrant
    const revoke = (message: any) => { if (message.kind === 'workspace_worker_journal_reply' && message.operation === 'prepare' && message.ok) grant.revoke() }
    f.c.child.on('message', revoke)
    try {
      await expect(f.call(prepareStops)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).not.toBeNull()
      expect(f.manager.workspaceCoordinatorGrant).toBeUndefined()
      expect(f.c.child.exitCode).toBeNull()
    } finally { f.c.child.off('message', revoke); await f.cleanup() }
  }, 30000)
  for (const journal of ['drop-prepare', 'drop-complete']) it(`retains durable material after a lost acknowledgement: ${journal}`, async () => {
    const f = await workerStopBridgeFixture(journal)
    try {
      if (journal === 'drop-prepare') {
        await expect(f.call(prepareStops)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
        expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).not.toBeNull()
        expect(await f.call(prepareStops)).toEqual({ dispatch: 'observe' })
      } else {
        await f.call(prepareStops)
        const input = { ...f.params, results: [submittedResult] }
        await expect(f.call(completeStops, input)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
        const first = f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).submission
        expect(first.results).toEqual([submittedResult])
        expect(await f.call(completeStops, input)).toEqual({ recorded: true })
        expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).submission).toEqual(first)
      }
    } finally { await f.cleanup() }
  }, 30000)
})
