import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { WorkspaceCatalog } from 'crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson } from 'crabot-shared'
import ModuleManager from './index.js'

async function fixture(options: { wrongRuntime?: boolean; delayIdentity?: boolean; result?: string } = {}) {
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
      setTimeout(()=>res.end(JSON.stringify({id:body.id,success:true,data})),req.url==='/get_runtime_identity'&&process.env.FIXTURE_DELAY_IDENTITY?200:0);
    });server.listen(Number(process.env.Crabot_PORT),'127.0.0.1',()=>fs.writeFileSync(process.env.FIXTURE_READY,'ready'));
    setTimeout(()=>process.exit(0),30000).unref();`)
  const manager = new ModuleManager({ port: 0, modules: [], shutdown_timeout: 0.1 }, data) as any
  manager.managementOnly = false
  const runtime = { module_id: 'admin-web', module_type: 'admin', entry: `"${process.execPath}" "${script}"`,
    env: { FIXTURE_CALLS: callsFile, FIXTURE_READY: path.join(data, 'ready'), ...(options.wrongRuntime ? { FIXTURE_WRONG_RUNTIME: '1' } : {}),
      ...(options.delayIdentity ? { FIXTURE_DELAY_IDENTITY: '1' } : {}), ...(options.result ? { FIXTURE_RESULT: options.result } : {}) },
    port, auto_start: false, auto_restart: false, skip_health_check: true, start_priority: 1, status: 'stopped' }
  manager.modules.set('admin-web', runtime); await manager.startModuleProcess('admin-web')
  await vi.waitFor(async () => expect(await fs.readFile(path.join(data, 'ready'), 'utf8')).toBe('ready'))
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
    const f = await fixture({ delayIdentity: true })
    try {
      const pending = f.manager.verifyWorkspaceRelocationRequest(f.params, 'fixture-human')
      const rejected = expect(pending).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      await vi.waitFor(async () => expect(await f.calls()).toHaveLength(1))
      f.runtime.port++
      await rejected
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
