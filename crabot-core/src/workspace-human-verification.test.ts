import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { WorkspaceCatalog } from 'crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson } from 'crabot-shared'
import ModuleManager from './index.js'
import { relocationAgentConfig } from '../../crabot-agent/tests/core/fixtures/relocation-agent-config.js'

async function fixture(options: { wrongRuntime?: boolean; result?: string; withAgent?: boolean; agentResult?: string; actualAgent?: boolean; processLifetimeMs?: number; backgroundShell?: boolean; actualAdmin?: boolean; adminReadyDelayMs?: number; quiesceResult?: string; orphanDuringStop?: boolean } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-current-admin-')))
  const native = require('../../scripts/lib/process-identity.cjs'), management = require('../../scripts/lib/desktop-management.cjs')
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), script = path.join(data, 'finite-admin.cjs'), callsFile = path.join(data, 'calls.json')
  const reserve = http.createServer(); await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()))
  await fs.writeFile(script, `const fs=require('node:fs'),http=require('node:http'),calls=[];
    const server=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);
      calls.push({method:req.url,authorization:req.headers.authorization?'present':undefined,body});fs.writeFileSync(process.env.FIXTURE_CALLS,JSON.stringify(calls));
      let data=req.url==='/get_runtime_identity'?{instance_id:process.env.CRABOT_INSTANCE_ID,module_id:'admin-web',runtime_id:process.env.FIXTURE_WRONG_RUNTIME?'other':process.env.CRABOT_MODULE_RUNTIME_ID}:req.url==='/quiesce_workspace_relocation_web'?{quiesced:true,...body.params}:{verified:true,...body.params};
      if(req.url!=='/get_runtime_identity'&&req.headers.authorization!=='Bearer fixture-human'){res.writeHead(403);res.end(JSON.stringify({id:body.id,success:false,error:{code:'FORBIDDEN',message:'denied'}}));return}
      if(req.url==='/quiesce_workspace_relocation_web'){
        if(process.env.FIXTURE_QUIESCE_RESULT==='disconnect'){req.socket.destroy();return}
        if(process.env.FIXTURE_QUIESCE_RESULT==='false')data.quiesced=false;
        if(process.env.FIXTURE_QUIESCE_RESULT==='hash')data.intent_sha256='0'.repeat(64);
        if(process.env.FIXTURE_QUIESCE_RESULT==='extra')data.unexpected=true;
        if(process.env.FIXTURE_QUIESCE_RESULT==='mutate'){
          const file=${JSON.stringify(path.join(data, 'workspace-control/relocation.json'))},stored=JSON.parse(fs.readFileSync(file,'utf8'));
          fs.writeFileSync(file,JSON.stringify({...stored,created_at:new Date(Date.parse(stored.created_at)+1000).toISOString()}));
        }
      }
      if(req.url!=='/get_runtime_identity'&&process.env.FIXTURE_RESULT==='false')data.verified=false;
      if(req.url!=='/get_runtime_identity'&&process.env.FIXTURE_RESULT==='hash')data.intent_sha256='0'.repeat(64);
      if(req.url!=='/get_runtime_identity'&&process.env.FIXTURE_RESULT==='extra')data.unexpected='do-not-trust';
      setTimeout(()=>res.end(JSON.stringify({id:body.id,success:true,data})),0);
    });server.listen(Number(process.env.Crabot_PORT),'127.0.0.1',()=>fs.writeFileSync(process.env.FIXTURE_READY,'ready'));
    setTimeout(()=>process.exit(0),${options.processLifetimeMs ?? 30000}).unref();`)
  if (options.actualAdmin) {
    const entry = path.resolve('../crabot-admin/dist/index.js'); await fs.access(entry)
    await fs.writeFile(script, `const fs=require('node:fs'),http=require('node:http'),{default:Admin}=require(${JSON.stringify(entry)}),calls=[];
      const admin=new Admin({moduleId:'admin-web',moduleType:'admin',version:'0.1.0',protocolVersion:'0.1.0',port:Number(process.env.Crabot_PORT),subscriptions:[]},{data_dir:${JSON.stringify(path.join(data, 'admin'))},web_port:Number(process.env.Crabot_PORT)});
      admin.cutoverActivated=true;admin.verifyAuthenticatedToken=async token=>token==='fixture-human'?{sub:'admin'}:null;
      const server=http.createServer((req,res)=>{let text='';req.on('data',part=>text+=part);req.on('end',()=>{let body;try{if(text)body=JSON.parse(text)}catch{}calls.push({method:req.url,authorization:req.headers.authorization?'present':undefined,body});fs.writeFileSync(process.env.FIXTURE_CALLS,JSON.stringify(calls))});
        const handling=req.url.startsWith('/api/')?admin.handleWebRequest(req,res):admin.handleRequest(req,res);void handling.catch(()=>{if(!res.headersSent)res.writeHead(500);res.end('{}')})
      });(async()=>{await admin.workspaceService.initialize();await new Promise(resolve=>setTimeout(resolve,${options.adminReadyDelayMs ?? 0}));server.listen(Number(process.env.Crabot_PORT),'127.0.0.1',()=>fs.writeFileSync(process.env.FIXTURE_READY,'ready'))})().catch(error=>{console.error(error);process.exit(1)});
      setTimeout(()=>process.exit(0),${options.processLifetimeMs ?? 30000}).unref();`)
  }
  const manager = new ModuleManager({ port: 0, modules: [], shutdown_timeout: 0.1 }, data) as any
  let host: ReturnType<typeof http.createServer> | undefined
  const cleanup = async () => {
    vi.restoreAllMocks()
    const admin = manager.modules.get('admin-web'); if (admin) admin.port = port
    try { await manager.stop() }
    catch (error) {
      const actors = [...manager.processes].map(([id, child]: [string, any]) => {
        let actual = null, kernelExited = null, group = null
        try { actual = native.inspectProcess(child.pid) } catch { /* Diagnostic only. */ }
        try { kernelExited = native.isProcessExited(child.pid) } catch { /* Preserve unknown. */ }
        if (process.platform !== 'win32') {
          try { process.kill(-child.pid, 0); group = 'alive' } catch (probe) { group = (probe as NodeJS.ErrnoException).code }
        }
        return { module_id: id, pid: child.pid, exit_code: child.exitCode, signal: child.signalCode,
          actual_started: actual?.started, actual_owner: actual?.owner, kernel_exited: kernelExited, group_probe: group }
      })
      console.error('[Workspace fixture cleanup] ' + JSON.stringify({ code: (error as NodeJS.ErrnoException).code, actors }))
      throw error
    } finally { if (host) { host.closeAllConnections(); await new Promise<void>(resolve => host!.close(() => resolve())) } }
    await fs.rm(root, { recursive: true, force: true })
  }
  try {
    if (options.actualAgent) {
      host = http.createServer((req, res) => { void manager.handleRequest(req, res) })
      await new Promise<void>(resolve => host!.listen(0, '127.0.0.1', resolve))
      manager.config.port = (host.address() as { port: number }).port
    }
    manager.managementOnly = false
    const runtime = { module_id: 'admin-web', module_type: 'admin', entry: `"${process.execPath}" "${script}"`,
      env: { FIXTURE_CALLS: callsFile, FIXTURE_READY: path.join(data, 'ready'), FIXTURE_QUIESCE_RESULT: options.quiesceResult ?? '', DATA_DIR: data, CRABOT_AGENT_DATA_DIR: path.join(data, 'agent'), WORKER_WORKSPACES_DIR: path.join(data, 'workspaces'), ...(options.wrongRuntime ? { FIXTURE_WRONG_RUNTIME: '1' } : {}),
   ...(options.result ? { FIXTURE_RESULT: options.result } : {}) },
      port, auto_start: false, auto_restart: false, skip_health_check: true, start_priority: 1, status: 'stopped' }
    manager.modules.set('admin-web', runtime); await manager.startModuleProcess('admin-web')
    await vi.waitFor(async () => expect(await fs.readFile(path.join(data, 'ready'), 'utf8')).toBe('ready'), { timeout: 10000 })
    if (options.withAgent || options.actualAgent) {
      const agentPort = http.createServer(); await new Promise<void>(resolve => agentPort.listen(0, '127.0.0.1', resolve))
      const agentScript = path.join(data, 'finite-agent.cjs'), agentReady = path.join(data, 'agent-ready')
      await fs.writeFile(agentScript, `const fs=require('node:fs'),http=require('node:http'),calls=[];
        http.createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;const body=JSON.parse(text);
          calls.push({method:body.method,header_present:Boolean(req.headers.authorization),body});fs.writeFileSync(process.env.FIXTURE_CALLS,JSON.stringify(calls));
          if(req.url!=='/get_runtime_identity'&&process.env.FIXTURE_RESULT==='disconnect'){req.socket.destroy();return}
          let data=req.url==='/get_runtime_identity'?{instance_id:process.env.CRABOT_INSTANCE_ID,module_id:'crabot-agent',runtime_id:process.env.FIXTURE_RESULT==='wrong-runtime'?'other':process.env.CRABOT_MODULE_RUNTIME_ID}:{workers:[]};
          if(req.url!=='/get_runtime_identity'&&process.env.FIXTURE_RESULT==='extra')data.extra=true;
          if(req.url!=='/get_runtime_identity'&&process.env.FIXTURE_RESULT==='bad-worker')data.workers=[{worker_id:'bad'}];
          if(req.url!=='/get_runtime_identity'&&['large','one-worker','false-stop-reply'].includes(process.env.FIXTURE_RESULT))data.workers=Array.from({length:process.env.FIXTURE_RESULT==='large'?1500:1},(_,i)=>({worker_id:String(i).padStart(5,'0'),manager_key:'channel::session',task_id:'task-'+i,incarnations:[{incarnation_id:'inc-'+i,impl:'builtin',seq:1,workspace:'fixture/'+('a'.repeat(120)),started_at:new Date().toISOString()}]}));
          if(req.url==='/stop_workspace_relocation_workers'&&process.env.FIXTURE_RESULT==='false-stop-reply')data={dispatch:'dispatch',results:[{worker_id:'00000',incarnation_id:'inc-0',status:'submitted'}]};
        res.end(JSON.stringify({id:body.id,success:true,data}));
        }).listen(Number(process.env.Crabot_PORT),'127.0.0.1',()=>fs.writeFileSync(process.env.FIXTURE_READY,'ready'));setTimeout(()=>process.exit(0),${options.processLifetimeMs ?? 30000}).unref();`)
      if (options.actualAgent) {
        const entry = path.resolve('../crabot-agent/dist/unified-agent.js')
        await fs.access(entry)
        if (options.backgroundShell) {
          await fs.mkdir(path.join(data, 'project'))
          if (options.orphanDuringStop) {
            await fs.writeFile(path.join(data, 'finite-orphan.cjs'), `const fs=require('node:fs'),native=require(${JSON.stringify(path.resolve('../scripts/lib/process-identity.cjs'))});
              fs.writeFileSync(${JSON.stringify(path.join(data, 'orphan-ready.json'))},JSON.stringify({process:native.inspectProcess(process.pid),parent:Number(process.argv[2])}));
              const file=${JSON.stringify(path.join(data, 'project/orphan.txt'))};fs.writeFileSync(file,'orphan active');setInterval(()=>fs.appendFileSync(file,'x'),50);setTimeout(()=>process.exit(0),20000);`)
          }
          await fs.writeFile(path.join(data, 'finite-background.cjs'), `const fs=require('node:fs'),file=${JSON.stringify(path.join(data, 'project/background.txt'))};fs.writeFileSync(file,'active\\n');setInterval(()=>fs.appendFileSync(file,'x'),50);setTimeout(()=>process.exit(0),120000);
            ${options.orphanDuringStop ? `const timer=setInterval(()=>{
              if(!fs.existsSync(${JSON.stringify(path.join(data, 'stops.txt'))}))return;clearInterval(timer);
              const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(path.join(data, 'finite-orphan.cjs'))},String(process.pid)],{detached:true,stdio:'ignore'});child.unref();
              const end=Date.now()+4000;setInterval(()=>{let observed=false;try{observed=fs.readFileSync(${JSON.stringify(path.join(data, 'workspace-control/relocation-process-stop.jsonl'))},'utf8').trimEnd().split('\\n').map(line=>JSON.parse(line)).some(row=>row.processes?.some(item=>item.pid===child.pid))}catch{}
                if(observed||Date.now()>=end)process.exit(0)},10)
            },10);` : ''}`)
        }
        await fs.writeFile(agentScript, `const fs=require('node:fs'),http=require('node:http'),{UnifiedAgent}=require(${JSON.stringify(entry)}),calls=[];
          const config=${JSON.stringify(relocationAgentConfig)};config.port=Number(process.env.Crabot_PORT);const agent=new UnifiedAgent(config);
          agent.managerStack.harness.deps.isWorkspaceRelocationReady=()=>true;
          agent.managerStack.adapters.get('builtin').stop=async()=>{fs.appendFileSync(process.env.FIXTURE_STOPS,'stop\\n');
            if(process.env.FIXTURE_ORPHAN_READY){const native=require(${JSON.stringify(path.resolve('../scripts/lib/process-identity.cjs'))}),end=Date.now()+8000;for(;;){
              let witness;try{witness=JSON.parse(fs.readFileSync(process.env.FIXTURE_ORPHAN_READY,'utf8'))}catch{}
              if(witness&&native.isProcessExited(witness.parent))break;if(Date.now()>=end)throw new Error('finite background parent did not exit');await new Promise(resolve=>setTimeout(resolve,20));
            }}
          };
          const server=http.createServer((req,res)=>{
            let text='';req.on('data',part=>text+=part);req.on('end',()=>{const body=JSON.parse(text);calls.push({method:body.method,header_present:Boolean(req.headers.authorization),body});fs.writeFileSync(process.env.FIXTURE_CALLS,JSON.stringify(calls))});
            if(req.url==='/shutdown'){req.on('end',async()=>{await agent.managerStack.dispose();res.end(JSON.stringify({id:JSON.parse(text).id,success:true,data:{}}));setTimeout(()=>process.exit(0),25)});return}
            if(req.url==='/stop_workspace_relocation_workers'&&['lost-stop-reply','extra-stop-reply'].includes(process.env.FIXTURE_RESULT)){
            const end=res.end.bind(res);res.end=(body,...args)=>{if(process.env.FIXTURE_RESULT==='lost-stop-reply'){req.socket.destroy();return res}const value=JSON.parse(body.toString());value.data.extra=true;return end(JSON.stringify(value),...args)};
          }
          if(req.url==='/capture_workspace_relocation_processes'&&['lost-process-reply','extra-process-reply','bad-process-reply'].includes(process.env.FIXTURE_RESULT)){
            const end=res.end.bind(res);res.end=(body,...args)=>{
              if(process.env.FIXTURE_RESULT==='lost-process-reply'){req.socket.destroy();return res}
              const value=JSON.parse(body.toString());
              if(process.env.FIXTURE_RESULT==='extra-process-reply')value.data.extra=true;
              else value.data.processes=[{pid:process.pid,parent:process.ppid,started:'invalid',owner:'wrong',executable:'invalid'}];
              return end(JSON.stringify(value),...args)
            };
          }
          void agent.handleRequest(req,res);
          });
          (async()=>{
            if(process.env.FIXTURE_BG_COMMAND){
              const{spawnPersistentShell}=require(${JSON.stringify(path.resolve('../crabot-agent/dist/engine/bg-entities/bg-shell.js'))});
              const id=await spawnPersistentShell({command:process.env.FIXTURE_BG_COMMAND,cwd:process.env.FIXTURE_WORKSPACE,owner:{friend_id:'unchanged',worker_id:'worker',incarnation_id:'inc'},spawned_by_task_id:'task',registry:agent.builtinBgRegistry});
              const record=await agent.builtinBgRegistry.get(id);fs.writeFileSync(process.env.FIXTURE_BG_READY,JSON.stringify({entity_id:id,pid:record.pid}));
            }
            const at='2026-10-20T00:00:00.000Z';await agent.managerStack.ledger.upsertWorker('channel::session','worker',()=>({worker_id:'worker',manager_key:'channel::session',task:{id:'task',title:'private task',status:'running',created_at:at},origin:{trigger_type:'message',creator_friend_id:'unchanged'},report_to:{channel_id:'channel',session_id:'session'},incarnations:[{incarnation_id:'inc',impl:'builtin',seq:1,state:${JSON.stringify(options.backgroundShell ? 'idle' : 'running')},workspace:process.env.FIXTURE_WORKSPACE,session_ref:'fixture',started_at:at}],updated_at:at}));
            server.listen(Number(process.env.Crabot_PORT),'127.0.0.1',()=>fs.writeFileSync(process.env.FIXTURE_READY,'ready'))})().catch(error=>{console.error(error);process.exit(1)});
          setTimeout(()=>process.exit(0),${options.processLifetimeMs ?? 30000}).unref();`)
      }
      const agent = { module_id: 'crabot-agent', module_type: 'agent', entry: `"${process.execPath}" "${agentScript}"`,
        env: { FIXTURE_CALLS: path.join(data, 'agent-calls.json'), FIXTURE_READY: agentReady, FIXTURE_RESULT: options.agentResult ?? '',
          DATA_DIR: data, CRABOT_AGENT_DATA_DIR: path.join(data, 'agent'), WORKER_WORKSPACES_DIR: path.join(data, 'workspaces'), FIXTURE_WORKSPACE: path.join(data, 'project'), FIXTURE_STOPS: path.join(data, 'stops.txt'),
          ...(options.backgroundShell ? { FIXTURE_BG_COMMAND: `"${process.execPath.replaceAll('\\', '/')}" "${path.join(data, 'finite-background.cjs').replaceAll('\\', '/')}"`, FIXTURE_BG_READY: path.join(data, 'background-ready.json'), ...(options.orphanDuringStop ? { FIXTURE_ORPHAN_READY: path.join(data, 'orphan-ready.json') } : {}) } : {}) },
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
    return { root, data, manager, runtime, port, params, calls, cleanup }
  } catch (error) { await cleanup(); throw error }
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
  const moduleJournalEntry = new URL('../../scripts/lib/workspace-module-journal.mjs', import.meta.url).href
  const code = `import{enterWorkspaceRelocationCoordinator}from ${JSON.stringify(entry)};import{serveWorkspaceWorkerJournal}from ${JSON.stringify(journalEntry)};import{serveWorkspaceModuleJournal}from ${JSON.stringify(moduleJournalEntry)};const context=await enterWorkspaceRelocationCoordinator();let serving;const moduleServing=serveWorkspaceModuleJournal(context);
    if(${JSON.stringify(journal)}==='false-ack')process.on('message',m=>{if(m.kind==='workspace_worker_journal_request')process.send({kind:'workspace_worker_journal_reply',request_id:m.request_id,launch_id:m.launch_id,operation:m.operation,ok:true,result:true})});
    else{if(['drop-reply','drop-prepare','drop-complete','drop-processes','drop-module-capture'].includes(${JSON.stringify(journal)})){const send=process.send.bind(process);let dropped=false;process.send=(m,cb)=>{
      const op={'drop-reply':'capture','drop-prepare':'prepare','drop-complete':'complete','drop-processes':'capture_processes','drop-module-capture':'capture'}[${JSON.stringify(journal)}];
      if(!dropped&&m.kind===(${JSON.stringify(journal)}==='drop-module-capture'?'workspace_module_journal_reply':'workspace_worker_journal_reply')&&m.operation===op){dropped=true;cb?.(null);return true}return send(m,cb)}}serving=serveWorkspaceWorkerJournal(context)}
    process.on('message',m=>{if(m.kind==='fixture-change-policy'){
      if(m.policy==='lost-lock')context.release();
      if(m.policy==='false-module-ack'){moduleServing.close();process.on('message',r=>{if(r.kind==='workspace_module_journal_request')process.send({kind:'workspace_module_journal_reply',request_id:r.request_id,launch_id:r.launch_id,operation:r.operation,ok:true,result:true})})}
      if(m.policy==='false-ack'){serving.close();process.on('message',r=>{if(r.kind==='workspace_worker_journal_request')process.send({kind:'workspace_worker_journal_reply',request_id:r.request_id,launch_id:r.launch_id,operation:r.operation,ok:true,result:r.operation==='prepare'?'dispatch':true})})}
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


describe('MM delegates actual fixed Agent stop code through finite native processes', () => {
  it('refuses to submit stops before the original capture has been confirmed', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    try {
      await f.manager.authorizeWorkspaceRelocationCoordinator(c.child, f.params, 'fixture-human')
      await expect(f.manager.stopWorkspaceRelocationWorkersForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      await expect(fs.stat(path.join(f.data, 'stops.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-workers.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('only observes a prior attempt through actual Agent code', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await f.manager.handlePrepareWorkspaceRelocationWorkerStops({ intent_id: f.params.intent_id, launch_id: c.launch.launch_id },
        { authorizationBearer: f.manager.workspaceCoordinatorGrant.token })
      expect(await f.manager.stopWorkspaceRelocationWorkersForCoordinator(c.child)).toEqual({ dispatch: 'observe', results: [] })
      await expect(fs.stat(path.join(f.data, 'stops.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      const records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
      expect(records.readWorkspaceRelocationStops(f.data, f.params.intent_id).submission).toBeNull()
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  for (const result of ['lost-stop-reply', 'extra-stop-reply']) it(`never reissues the actual Agent stop after uncertain response: ${result}`, async () => {
    const f = await fixture({ actualAgent: true, agentResult: result }), c = await coordinator(f)
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await expect(f.manager.stopWorkspaceRelocationWorkersForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      await expect(f.manager.stopWorkspaceRelocationWorkersForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(await fs.readFile(path.join(f.data, 'stops.txt'), 'utf8')).toBe('stop\n')
      const calls = JSON.parse(await fs.readFile(path.join(f.data, 'agent-calls.json'), 'utf8'))
      expect(calls.filter((item: any) => item.method === 'stop_workspace_relocation_workers')).toHaveLength(1)
      const records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
      expect(records.readWorkspaceRelocationStops(f.data, f.params.intent_id).submission.results).toEqual([{ worker_id: 'worker', incarnation_id: 'inc', status: 'submitted' }])
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('independently rejects a plausible response without any actual attempt or complete receipt', async () => {
    const f = await fixture({ withAgent: true, agentResult: 'false-stop-reply' }), c = await coordinator(f)
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await expect(f.manager.stopWorkspaceRelocationWorkersForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      const records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
      expect(records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)

  it('rejects a replaced Agent lifecycle after the real handshake before forwarding the stop bearer', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    const state = f.manager.childStates.get(f.manager.processes.get('crabot-agent')), previous = state.intentionalReason
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      const transport = require('../../scripts/lib/module-runtime-rpc.cjs'), open = transport.openModuleRuntimeRpc
      vi.spyOn(transport, 'openModuleRuntimeRpc').mockImplementation(async (...args: any[]) => {
        const rpc = await open(...args)
        if (args[2].module_id === 'crabot-agent') state.intentionalReason = 'shutdown'
        return rpc
      })
      await expect(f.manager.stopWorkspaceRelocationWorkersForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      const calls = JSON.parse(await fs.readFile(path.join(f.data, 'agent-calls.json'), 'utf8'))
      expect(calls.map((item: any) => [item.method, item.header_present])).toEqual([
        ['get_runtime_identity', false], ['capture_workspace_relocation_workers', true], ['get_runtime_identity', false],
      ])
      expect(f.manager.workspaceCoordinatorGrant).toBeUndefined()
      await expect(fs.stat(path.join(f.data, 'stops.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { state.intentionalReason = previous; await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('joins real MM and compiled Agent RPC/Harness/journals, keeps one stop and never rechecks the browser credential', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    try {
      const scope = await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      expect(scope.map((worker: any) => worker.worker_id)).toEqual(['worker'])
      const verifyHuman = vi.spyOn(f.manager, 'verifyWorkspaceRelocationRequest').mockRejectedValue(new Error('browser already closed'))
      const first = await f.manager.stopWorkspaceRelocationWorkersForCoordinator(c.child)
      expect(first).toEqual({ dispatch: 'dispatch', results: [{ worker_id: 'worker', incarnation_id: 'inc', status: 'submitted' }] })
      expect(await f.manager.stopWorkspaceRelocationWorkersForCoordinator(c.child)).toBe(first)
      expect(verifyHuman).not.toHaveBeenCalled()
      expect(await fs.readFile(path.join(f.data, 'stops.txt'), 'utf8')).toBe('stop\n')
      const records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
      expect(records.readWorkspaceRelocationStops(f.data, f.params.intent_id).submission.results).toEqual(first.results)
      const ledgerFiles = await fs.readdir(path.join(f.data, 'agent', 'worker-ledgers'))
      expect(ledgerFiles.length).toBeGreaterThan(0)
      expect(f.manager.processes.get('admin-web').exitCode).toBeNull()
      await expect(fs.stat(path.join(f.root, 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
})


describe('fixed coordinator first CLI process observation journal', () => {
  async function observationFixture(policy = 'normal', seed?: unknown[]) {
    const f = await fixture()
    let c: Awaited<ReturnType<typeof coordinator>> | undefined, journal: any
    const cleanup = async () => { journal?.close(); await c?.cleanup(); await f.cleanup() }
    try {
      const records = await import('../../scripts/lib/workspace-relocation-intent.mjs'), locks = await import('../../scripts/lib/cli-lock.mjs')
      const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
      try {
        records.commitWorkspaceRelocationWorkers({ dataDir: f.data, id: f.params.intent_id, workers: [] })
        if (seed) records.commitWorkspaceRelocationProcesses({ dataDir: f.data, id: f.params.intent_id, processes: seed })
      } finally { locks.releaseCliLock(lock) }
      c = await coordinator(f, policy)
      const { createWorkspaceWorkerJournal } = await import('../../scripts/lib/workspace-worker-journal.mjs')
      journal = createWorkspaceWorkerJournal(c.child, { dataDir: f.data, id: f.params.intent_id, launch: c.launch })
      return { ...f, c, records, journal, cleanup }
    } catch (error) { await cleanup(); throw error }
  }
  it('publishes through the independently locked child and reads back the original observation', async () => {
    const f = await observationFixture()
    try {
      await f.journal.captureProcesses([])
      const first = f.records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id)
      expect(first.processes).toEqual([])
      await f.journal.captureProcesses([])
      expect(f.records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id)).toEqual(first)
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
    } finally { await f.cleanup() }
  }, 30000)
  it('does not accept a false acknowledgement for a different original process set', async () => {
    const native = require('../../scripts/lib/process-identity.cjs'), self = native.inspectProcess(process.pid)
    const seed = [{ pid: 881100, parent: process.pid, started: '100', owner: self.owner, executable: self.executable }]
    const f = await observationFixture('false-ack', seed)
    try {
      await expect(f.journal.captureProcesses([])).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
      expect(f.records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id).processes).toEqual(seed)
    } finally { await f.cleanup() }
  }, 30000)
  it('preserves a published first observation after its actual IPC reply is lost', async () => {
    const f = await observationFixture('drop-processes')
    let recovered: any
    try {
      await expect(f.journal.captureProcesses([])).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
      const original = f.records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id)
      expect(original.processes).toEqual([])
      const { createWorkspaceWorkerJournal } = await import('../../scripts/lib/workspace-worker-journal.mjs')
      recovered = createWorkspaceWorkerJournal(f.c.child, { dataDir: f.data, id: f.params.intent_id, launch: f.c.launch })
      await recovered.captureProcesses([])
      expect(f.records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id)).toEqual(original)
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
    } finally { recovered?.close(); await f.cleanup() }
  }, 30000)
  for (const policy of ['lost-lock', 'false-ack']) it('rejects first observation confirmation without real persistence: ' + policy, async () => {
    const f = await observationFixture(policy)
    try {
      await expect(f.journal.captureProcesses([])).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
      expect(f.records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id)).toBeNull()
      expect(f.records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
    } finally { await f.cleanup() }
  }, 30000)
})


describe('MM delegates fixed Native observation through actual Agent and coordinator code', () => {
  const agentCalls = async (data: string): Promise<any[]> => JSON.parse(await fs.readFile(path.join(data, 'agent-calls.json'), 'utf8').catch(() => '[]'))
  it('requires the original Worker scope capture before forwarding a process observation request', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    try {
      await f.manager.authorizeWorkspaceRelocationCoordinator(c.child, f.params, 'fixture-human')
      await expect(f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect((await agentCalls(f.data)).some(call => call.method === 'capture_workspace_relocation_processes')).toBe(false)
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('publishes the actual Agent observation once under the child lock without rechecking browser authorization', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      vi.spyOn(f.manager, 'verifyWorkspaceRelocationRequest').mockRejectedValue(new Error('browser credential has since expired'))
      const first = await f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)
      expect(first).toEqual([]); expect(Object.isFrozen(first)).toBe(true)
      expect(await f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)).toBe(first)
      const records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
      const original = records.readWorkspaceRelocationWorkers(f.data, f.params.intent_id)
      expect(records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id)).toMatchObject({ workers_sha256: sha256CanonicalJson(original), processes: first })
      expect(records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
      const calls = await agentCalls(f.data)
      expect(calls.filter(call => call.method === 'capture_workspace_relocation_processes')).toHaveLength(1)
      expect(calls.filter(call => call.method === 'capture_workspace_relocation_processes').every(call => call.header_present)).toBe(true)
      await expect(fs.stat(path.join(f.data, 'stops.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('rejects a replaced first Worker record before sending the Native observation bearer', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      const file = path.join(f.data, 'workspace-control/relocation-workers.json'), original = JSON.parse(await fs.readFile(file, 'utf8'))
      await fs.writeFile(file, JSON.stringify({ ...original, created_at: new Date(Date.parse(original.created_at) + 1000).toISOString() }))
      await expect(f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect((await agentCalls(f.data)).some(call => call.method === 'capture_workspace_relocation_processes')).toBe(false)
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-worker-processes.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  for (const result of ['lost-process-reply', 'extra-process-reply', 'bad-process-reply']) it('keeps the first failure without recapturing after an unverifiable actual Agent reply: ' + result, async () => {
    const f = await fixture({ actualAgent: true, agentResult: result }), c = await coordinator(f)
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await expect(f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      await expect(f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect((await agentCalls(f.data)).filter(call => call.method === 'capture_workspace_relocation_processes')).toHaveLength(1)
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-worker-processes.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.stat(path.join(f.data, 'stops.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  for (const policy of ['lost-lock', 'false-ack']) it('rejects a first observation that the actual child cannot durably confirm: ' + policy, async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    let acknowledged = false
    const receive = (message: any) => { if (message.kind === 'fixture-policy-changed') acknowledged = true }
    c.child.on('message', receive)
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      c.child.send({ kind: 'fixture-change-policy', policy })
      await vi.waitFor(() => expect(acknowledged).toBe(true))
      await expect(f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      const records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
      expect(records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id)).toBeNull()
      expect(records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
    } finally { c.child.off('message', receive); await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('retains the actual immutable observation after its coordinator IPC reply is lost', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f, 'drop-processes')
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await expect(f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      const records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
      const first = records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id)
      expect(first.processes).toEqual([])
      await expect(f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id)).toEqual(first)
      expect((await agentCalls(f.data)).filter(call => call.method === 'capture_workspace_relocation_processes')).toHaveLength(1)
      expect(records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)

  it('rechecks the original Worker record even when returning an already captured observation', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)
      const file = path.join(f.data, 'workspace-control/relocation-workers.json'), original = JSON.parse(await fs.readFile(file, 'utf8'))
      await fs.writeFile(file, JSON.stringify({ ...original, created_at: new Date(Date.parse(original.created_at) + 1000).toISOString() }))
      await expect(f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect((await agentCalls(f.data)).filter(call => call.method === 'capture_workspace_relocation_processes')).toHaveLength(1)
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('does not forward the observation bearer after the actual handshake enters a different Agent lifecycle', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    const state = f.manager.childStates.get(f.manager.processes.get('crabot-agent')), previous = state.intentionalReason
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      const transport = require('../../scripts/lib/module-runtime-rpc.cjs'), open = transport.openModuleRuntimeRpc
      vi.spyOn(transport, 'openModuleRuntimeRpc').mockImplementation(async (...args: any[]) => {
        const rpc = await open(...args)
        if (args[2].module_id === 'crabot-agent') state.intentionalReason = 'shutdown'
        return rpc
      })
      await expect(f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect((await agentCalls(f.data)).filter(call => call.method === 'capture_workspace_relocation_processes')).toHaveLength(0)
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-worker-processes.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(f.manager.workspaceCoordinatorGrant).toBeUndefined()
    } finally { state.intentionalReason = previous; await c.cleanup(); await f.cleanup() }
  }, 30000)

})


describe('MM fixes execution modules in the same original coordinator job', () => {
  it('requires the original Native capture before observing or fixing execution modules', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    const capture = vi.spyOn(f.manager, 'captureWorkspaceRelocationModules')
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await expect(f.manager.captureWorkspaceRelocationModulesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(capture).not.toHaveBeenCalled()
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('fixes actual non-Admin module roots once through the child lock without any stop or browser recheck', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)
      vi.spyOn(f.manager, 'verifyWorkspaceRelocationRequest').mockRejectedValue(new Error('browser login has since expired'))
      const first = await f.manager.captureWorkspaceRelocationModulesForCoordinator(c.child)
      expect(first.map((item: any) => item.module_id)).toEqual(['crabot-agent'])
      expect(first[0].processes.some((item: any) => item.pid === f.manager.processes.get('crabot-agent').pid)).toBe(true)
      expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first[0].processes[0])).toBe(true)
      expect(await f.manager.captureWorkspaceRelocationModulesForCoordinator(c.child)).toBe(first)
      const records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
      expect(records.readWorkspaceRelocationModules(f.data, f.params.intent_id).modules).toEqual(first)
      expect(records.readWorkspaceRelocationModuleStops(f.data, f.params.intent_id).attempt).toBeNull()
      expect(records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
      expect(f.manager.processes.get('admin-web').exitCode).toBeNull()
      await expect(fs.stat(path.join(f.data, 'stops.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('rejects a replaced original Native record before reading module roots', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    const capture = vi.spyOn(f.manager, 'captureWorkspaceRelocationModules')
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)
      const file = path.join(f.data, 'workspace-control/relocation-worker-processes.json'), original = JSON.parse(await fs.readFile(file, 'utf8'))
      await fs.writeFile(file, JSON.stringify({ ...original, created_at: new Date(Date.parse(original.created_at) + 1000).toISOString() }))
      await expect(f.manager.captureWorkspaceRelocationModulesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(capture).not.toHaveBeenCalled()
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-modules.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  for (const policy of ['lost-lock', 'false-module-ack']) it('rejects a module capture without actual locked persistence: ' + policy, async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    let acknowledged = false
    const receive = (message: any) => { if (message.kind === 'fixture-policy-changed') acknowledged = true }
    c.child.on('message', receive)
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)
      c.child.send({ kind: 'fixture-change-policy', policy }); await vi.waitFor(() => expect(acknowledged).toBe(true))
      await expect(f.manager.captureWorkspaceRelocationModulesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      const records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
      expect(records.readWorkspaceRelocationModules(f.data, f.params.intent_id)).toBeNull()
      expect(records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
    } finally { c.child.off('message', receive); await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('keeps the first module capture and failure when its actual IPC reply is lost', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f, 'drop-module-capture')
    const capture = vi.spyOn(f.manager, 'captureWorkspaceRelocationModules')
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)
      await expect(f.manager.captureWorkspaceRelocationModulesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      const records = await import('../../scripts/lib/workspace-relocation-intent.mjs'), first = records.readWorkspaceRelocationModules(f.data, f.params.intent_id)
      expect(first.modules.map((item: any) => item.module_id)).toEqual(['crabot-agent'])
      await expect(f.manager.captureWorkspaceRelocationModulesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(capture).toHaveBeenCalledOnce()
      expect(records.readWorkspaceRelocationModules(f.data, f.params.intent_id)).toEqual(first)
      expect(records.readWorkspaceRelocationModuleStops(f.data, f.params.intent_id).attempt).toBeNull()
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('rechecks original Native evidence after the actual lifecycle queue settles', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    let release!: () => void, response: Promise<any> | undefined
    const wait = new Promise<void>(resolve => { release = resolve }), held = wait.finally(() => f.manager.lifecycleQueues.delete('fixture-held'))
    const capture = vi.spyOn(f.manager, 'captureWorkspaceRelocationModules')
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)
      f.manager.lifecycleQueues.set('fixture-held', held)
      response = f.manager.captureWorkspaceRelocationModulesForCoordinator(c.child)
      const rejected = expect(response).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce())
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-modules.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      const file = path.join(f.data, 'workspace-control/relocation-worker-processes.json'), original = JSON.parse(await fs.readFile(file, 'utf8'))
      await fs.writeFile(file, JSON.stringify({ ...original, created_at: new Date(Date.parse(original.created_at) + 1000).toISOString() }))
      release(); await held; await rejected
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-modules.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { release(); await held; await response?.catch(() => {}); await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('checks the original module record even when returning its previously captured scope', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    const capture = vi.spyOn(f.manager, 'captureWorkspaceRelocationModules')
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)
      await f.manager.captureWorkspaceRelocationModulesForCoordinator(c.child)
      const file = path.join(f.data, 'workspace-control/relocation-modules.json'), original = JSON.parse(await fs.readFile(file, 'utf8'))
      await fs.writeFile(file, JSON.stringify({ ...original, created_at: new Date(Date.parse(original.created_at) + 1000).toISOString() }))
      await expect(f.manager.captureWorkspaceRelocationModulesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(capture).toHaveBeenCalledOnce()
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('joins the actual fixed captures, Worker submission and module exit while Admin remains available', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    let journal: any
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)
      const modules = await f.manager.captureWorkspaceRelocationModulesForCoordinator(c.child)
      expect((await f.manager.stopWorkspaceRelocationWorkersForCoordinator(c.child)).dispatch).toBe('dispatch')
      const { createWorkspaceModuleJournal } = await import('../../scripts/lib/workspace-module-journal.mjs')
      journal = createWorkspaceModuleJournal(c.child, { dataDir: f.data, id: f.params.intent_id, launch: c.launch })
      const result = await f.manager.requestWorkspaceRelocationModuleStops(modules, journal)
      expect(result.results).toEqual([expect.objectContaining({ module_id: 'crabot-agent', status: 'known_scope_exited' })])
      const { probeKnownProcessExit } = require('../../scripts/lib/known-process-exit.cjs')
      expect(probeKnownProcessExit(modules[0].processes).state).toBe('stopped')
      expect(f.manager.workspaceCoordinatorGrant).toBeUndefined()
      expect(f.manager.processes.get('admin-web').exitCode).toBeNull()
      expect((await f.manager.verifyWorkspaceRelocationRequest(f.params, 'fixture-human')).verified).toBe(true)
      expect(await fs.readFile(path.join(f.data, 'stops.txt'), 'utf8')).toBe('stop\n')
      await expect(fs.stat(path.join(f.root, 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { journal?.close(); await c.cleanup(); await f.cleanup() }
  }, 30000)

})


describe('MM launches the actual fixed coordinator under the original human intent', () => {
  // Match MM's production loader so the parent owns the same in-memory lock handle.
  const timeout = process.platform === 'win32' ? 90000 : 30000
  it('joins actual fixed-host scope journals and planned module exit while Admin remains online', async () => {
    const f = await fixture({ actualAgent: true, processLifetimeMs: 120000, backgroundShell: true }), locks = require('../../scripts/lib/cli-lock.mjs')
    const records = await import('../../scripts/lib/workspace-relocation-intent.mjs'), { createWorkspaceModuleJournal } = await import('../../scripts/lib/workspace-module-journal.mjs')
    const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    let child: ReturnType<typeof spawn> | undefined, journal: any
    try {
      const ledgerFile = path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), before = await fs.readFile(ledgerFile)
      const admin = f.manager.processes.get('admin-web')
      child = await f.manager.launchWorkspaceRelocationCoordinator(f.params, 'fixture-human')
      expect(locks.cliLockToken(lock)).toBeUndefined(); expect(f.manager.workspaceCoordinatorGrant).toBeUndefined()
      const workers = await f.manager.captureWorkspaceRelocationWorkersForCoordinator(child, f.params, 'fixture-human')
      expect(workers.map((item: any) => item.worker_id)).toEqual(['worker'])
      const background = JSON.parse(await fs.readFile(path.join(f.data, 'background-ready.json'), 'utf8'))
      const processes = await f.manager.captureWorkspaceRelocationProcessesForCoordinator(child)
      expect(processes).toEqual(expect.arrayContaining([expect.objectContaining({ pid: background.pid })]))
      expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit(processes).state).toBe('running')
      const modules = await f.manager.captureWorkspaceRelocationModulesForCoordinator(child)
      const submission = await f.manager.stopWorkspaceRelocationWorkersForCoordinator(child)
      expect(submission).toEqual({ dispatch: 'dispatch', results: [{ worker_id: 'worker', incarnation_id: 'inc', status: 'submitted' }] })
      const { launch } = records.readWorkspaceRelocationCoordinator(f.data, f.params.intent_id)
      journal = createWorkspaceModuleJournal(child, { dataDir: f.data, id: f.params.intent_id, launch })
      expect((await f.manager.requestWorkspaceRelocationModuleStops(modules, journal)).results).toEqual([
        expect.objectContaining({ module_id: 'crabot-agent', runtime_id: modules[0].runtime_id, status: 'known_scope_exited' }),
      ])
      expect(f.manager.processes.get('admin-web').exitCode).toBeNull()
      expect(f.manager.workspaceCoordinatorGrant).toBeUndefined()
      expect(f.manager.processes.get('admin-web')).toBe(admin)
      expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit(modules[0].processes).state).toBe('stopped')
      expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit(processes).state).toBe('stopped')
      expect(await fs.readFile(path.join(f.data, 'project/background.txt'), 'utf8')).toMatch(/^active\n[x]*$/)
      const calls = await f.calls()
      expect(calls.filter(item => item.method === '/verify_workspace_relocation_request')).toHaveLength(2)
      expect(JSON.stringify(calls.map(item => item.body))).not.toContain('fixture-human')
      expect(await fs.readFile(ledgerFile)).toEqual(before)
      expect(await fs.readFile(path.join(f.data, 'stops.txt'), 'utf8')).toBe('stop\n')
      await expect(fs.stat(path.join(f.root, 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      journal?.close()
      if (child?.connected) { const ended = once(child, 'exit'); child.disconnect(); await ended }
      locks.releaseCliLock(lock); await f.cleanup()
    }
  }, timeout)
  for (const kind of ['missing lock', 'missing bearer', 'lock replaced during human proof']) it(`does not launch a coordinator: ${kind}`, async () => {
    const f = await fixture(), locks = require('../../scripts/lib/cli-lock.mjs'), records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
    const lock = kind === 'missing lock' ? undefined : await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    if (kind === 'lock replaced during human proof') {
      const original = f.manager.verifyWorkspaceRelocationRequest.bind(f.manager)
      vi.spyOn(f.manager, 'verifyWorkspaceRelocationRequest').mockImplementation(async (...args: unknown[]) => {
        const proof = await original(...args); locks.releaseCliLock(lock)
        await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
        return proof
      })
    }
    try {
      await expect(f.manager.launchWorkspaceRelocationCoordinator(f.params, kind === 'missing bearer' ? undefined : 'fixture-human'))
        .rejects.toMatchObject({ code: kind === 'missing bearer' ? 'UNAUTHORIZED' : 'SERVICE_UNAVAILABLE' })
      expect(records.readWorkspaceRelocationCoordinator(f.data, f.params.intent_id)).toEqual({ launch: null, ready: null })
      expect(f.manager.workspaceCoordinatorGrant).toBeUndefined()
      if (kind !== 'lock replaced during human proof') expect(await f.calls()).toEqual([])
    } finally { locks.releaseCliLock(lock); await f.cleanup() }
  }, timeout)
  it('disconnects only its unexposed fixed host when MM starts closing during readiness', async () => {
    const f = await fixture(), locks = require('../../scripts/lib/cli-lock.mjs'), records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
    const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id), native = require('../../scripts/lib/process-identity.cjs')
    const inspect = native.inspectProcess
    vi.spyOn(native, 'inspectProcess').mockImplementation((pid: number) => {
      const result = inspect(pid)
      if (pid === process.pid && existsSync(path.join(f.data, 'workspace-control/relocation-coordinator-ready.json'))) f.manager.isShuttingDown = true
      return result
    })
    try {
      await expect(f.manager.launchWorkspaceRelocationCoordinator(f.params, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      const current = records.readWorkspaceRelocationCoordinator(f.data, f.params.intent_id)
      expect(current.ready).not.toBeNull()
      await vi.waitFor(() => expect(native.isProcessExited(current.launch!.process.pid)).toBe(true))
      expect(f.manager.processes.get('admin-web').exitCode).toBeNull(); expect(f.manager.workspaceCoordinatorGrant).toBeUndefined()
      expect(records.readWorkspaceRelocationWorkers(f.data, f.params.intent_id)).toBeNull()
    } finally { f.manager.isShuttingDown = false; locks.releaseCliLock(lock); await f.cleanup() }
  }, timeout)
})

describe('MM submits one fixed workspace stop sequence', () => {
  const timeout = process.platform === 'win32' ? 90000 : 30000
  it('joins concurrent callers to the real fixed host, scopes and first submissions while retaining Admin', async () => {
    const f = await fixture({ actualAgent: true, actualAdmin: true, adminReadyDelayMs: 1200, processLifetimeMs: 120000, backgroundShell: true }), locks = require('../../scripts/lib/cli-lock.mjs')
    const records = await import('../../scripts/lib/workspace-relocation-intent.mjs'), lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    const launch = vi.spyOn(f.manager, 'launchWorkspaceRelocationCoordinator'), stop = vi.spyOn(f.manager, 'stopWorkspaceRelocationWorkersForCoordinator')
    let child: ReturnType<typeof spawn> | undefined
    try {
      const ledger = path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), before = await fs.readFile(ledger), admin = f.manager.processes.get('admin-web')
      const first = f.manager.submitWorkspaceRelocationStops(f.params, 'fixture-human')
      expect(f.manager.submitWorkspaceRelocationStops({ ...f.params }, 'fixture-human')).toBe(first)
      await expect(f.manager.submitWorkspaceRelocationStops({ ...f.params, intent_id: randomUUID() }, 'fixture-human')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      const result = await first; child = result.coordinator
      expect(result.workerSubmission).toEqual({ dispatch: 'dispatch', results: [{ worker_id: 'worker', incarnation_id: 'inc', status: 'submitted' }] })
      expect(result.moduleSubmission.results).toEqual([expect.objectContaining({ module_id: 'crabot-agent', status: 'known_scope_exited' })])
      expect(launch).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce()
      const adminCalls = await f.calls()
      expect(adminCalls.filter(item => item.method === '/quiesce_workspace_relocation_web')).toHaveLength(1)
      const headers = { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }
      expect((await fetch(`http://127.0.0.1:${f.port}/api/friends`, { headers })).status).toBe(200)
      const denied = await fetch(`http://127.0.0.1:${f.port}/api/friends`, { method: 'POST', headers, body: '{}' })
      expect(denied.status).toBe(503); expect(await denied.json()).toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      const processStops = records.readWorkspaceRelocationProcessStops(f.data, f.params.intent_id)
      expect(records.readWorkspaceRelocationExecutionExit(f.data, f.params.intent_id)?.intent_id).toBe(f.params.intent_id)
      expect(processStops.completion?.type).toBe('known_scope_exited')
      expect(processStops.observations.at(-1).processes.length).toBeGreaterThan(0)
      expect(child!.connected).toBe(true); expect(f.manager.workspaceCoordinatorGrant).toBeUndefined()
      expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit(records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id).processes).state).toBe('stopped')
      expect(await fs.readFile(ledger)).toEqual(before); expect(await fs.readFile(path.join(f.data, 'stops.txt'), 'utf8')).toBe('stop\n')
      expect(f.manager.processes.get('admin-web')).toBe(admin); expect(admin.exitCode).toBeNull()
      await expect(fs.stat(path.join(f.root, 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (child?.connected) { const ended = once(child, 'exit'); child.disconnect(); await ended }
      locks.releaseCliLock(lock); await f.cleanup()
    }
  }, timeout)
  it('retains a background descendant created during Worker stop after its parent and Agent exit', async () => {
    const f = await fixture({ actualAgent: true, actualAdmin: true, backgroundShell: true, orphanDuringStop: true, processLifetimeMs: 120000 })
    const locks = require('../../scripts/lib/cli-lock.mjs'), records = require('../../scripts/lib/workspace-relocation-intent.mjs')
    const native = require('../../scripts/lib/process-identity.cjs'), lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    const ledger = path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), before = await fs.readFile(ledger)
    let child: ReturnType<typeof spawn> | undefined
    try {
      const result = await f.manager.submitWorkspaceRelocationStops(f.params, 'fixture-human'); child = result.coordinator
      const witness = JSON.parse(await fs.readFile(path.join(f.data, 'orphan-ready.json'), 'utf8'))
      const initial = records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id)
      const stopped = records.readWorkspaceRelocationProcessStops(f.data, f.params.intent_id)
      expect(native.isProcessExited(witness.parent)).toBe(true); expect(native.isProcessExited(witness.process.pid)).toBe(true)
      expect(initial.processes.some((item: any) => item.pid === witness.process.pid)).toBe(false)
      expect(stopped.observations.at(-1).processes).toContainEqual(expect.objectContaining({ pid: witness.process.pid, started: witness.process.started, owner: witness.process.owner }))
      expect(stopped.completion.type).toBe('known_scope_exited')
      expect(records.readWorkspaceRelocationExecutionExit(f.data, f.params.intent_id)?.intent_id).toBe(f.params.intent_id)
      expect(f.manager.processes.has('crabot-agent')).toBe(false); expect(f.manager.processes.get('admin-web').exitCode).toBeNull()
      expect(await fs.readFile(path.join(f.data, 'project/orphan.txt'), 'utf8')).toContain('orphan active')
      expect(await fs.readFile(ledger)).toEqual(before)
      await expect(fs.stat(path.join(f.root, 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      const witness = await fs.readFile(path.join(f.data, 'orphan-ready.json'), 'utf8').then(JSON.parse).catch(() => undefined)
      if (witness) native.terminateKnownProcess(witness.process)
      await f.manager.closeWorkspaceCoordinatorChannel(child); locks.releaseCliLock(lock); await f.cleanup()
    }
  }, timeout)
  it.each(['prepare', 'new descendant observation', 'execution exit'])('retains an actual process journal with an uncertain %s reply before further stops', async phase => {
    const orphan = phase === 'new descendant observation'
    const f = await fixture({ actualAgent: true, processLifetimeMs: 120000, backgroundShell: orphan, orphanDuringStop: orphan })
    const locks = require('../../scripts/lib/cli-lock.mjs'), records = require('../../scripts/lib/workspace-relocation-intent.mjs')
    const native = require('../../scripts/lib/process-identity.cjs'), lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    const launch = f.manager.launchWorkspaceRelocationCoordinator.bind(f.manager), modules = vi.spyOn(f.manager, 'requestWorkspaceRelocationModuleStops')
    const stop = vi.spyOn(f.manager, 'stopWorkspaceRelocationWorkersForCoordinator'), signals = vi.spyOn(native, 'terminateKnownProcess')
    vi.spyOn(f.manager, 'launchWorkspaceRelocationCoordinator').mockImplementation(async (...args: unknown[]) => {
      const child = await launch(...args), emit = child.emit.bind(child)
      vi.spyOn(child, 'emit').mockImplementation((event: string | symbol, ...args: any[]) => {
        const message = args[0]
        if (event === 'message' && message?.kind === 'workspace_process_journal_reply') {
          let descendantObserved = false
          if (orphan && message.operation === 'observe' && existsSync(path.join(f.data, 'orphan-ready.json'))) {
            const witness = JSON.parse(require('node:fs').readFileSync(path.join(f.data, 'orphan-ready.json'), 'utf8'))
            descendantObserved = records.readWorkspaceRelocationProcessStops(f.data, f.params.intent_id).observations
              .some((row: any) => row.processes.some((item: any) => item.pid === witness.process.pid && item.started === witness.process.started))
          }
          if (phase === 'prepare' && message.operation === 'prepare' || descendantObserved
            || phase === 'execution exit' && message.operation === 'execution_exit') {
            return emit(event, { ...message, ok: false })
          }
        }
        return emit(event, ...args)
      })
      return child
    })
    try {
      const first = f.manager.submitWorkspaceRelocationStops(f.params, 'fixture-human')
      await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      if (stop.mock.results[0]) await Promise.resolve(stop.mock.results[0].value).catch(() => undefined)
      expect(f.manager.submitWorkspaceRelocationStops(f.params, 'fixture-human')).toBe(first)
      await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      const stored = records.readWorkspaceRelocationProcessStops(f.data, f.params.intent_id)
      expect(stored.attempt).not.toBeNull()
      if (phase === 'execution exit') {
        expect(stored.completion.type).toBe('known_scope_exited')
        expect(records.readWorkspaceRelocationExecutionExit(f.data, f.params.intent_id)?.intent_id).toBe(f.params.intent_id)
        expect(modules).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce()
        expect(f.manager.processes.has('crabot-agent')).toBe(false)
        const count = signals.mock.calls.length
        await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' }); expect(signals.mock.calls).toHaveLength(count)
      } else {
        expect(stored.completion).toBeNull(); expect(records.readWorkspaceRelocationExecutionExit(f.data, f.params.intent_id)).toBeNull()
        expect(modules).not.toHaveBeenCalled(); expect(signals).not.toHaveBeenCalled()
        expect(f.manager.processes.get('crabot-agent').exitCode).toBeNull()
        if (phase === 'prepare') expect(stop).not.toHaveBeenCalled()
        else expect(stored.observations.length).toBeGreaterThan(1)
      }
      expect(f.manager.processes.get('admin-web').exitCode).toBeNull()
      await expect(fs.stat(path.join(f.root, 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      for (const item of records.readWorkspaceRelocationProcessStops(f.data, f.params.intent_id).observations.at(-1)?.processes ?? []) native.terminateKnownProcess(item)
      locks.releaseCliLock(lock); await f.cleanup()
    }
  }, timeout)
  it('keeps the first capture failure and disconnects only its fixed host before any stop', async () => {
    const f = await fixture({ actualAgent: true, processLifetimeMs: 120000 }), locks = require('../../scripts/lib/cli-lock.mjs')
    const records = await import('../../scripts/lib/workspace-relocation-intent.mjs'), lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    const capture = vi.spyOn(f.manager, 'captureWorkspaceRelocationProcessesForCoordinator').mockRejectedValue(new Error('fixture original observation unknown'))
    const stop = vi.spyOn(f.manager, 'stopWorkspaceRelocationWorkersForCoordinator')
    try {
      const first = f.manager.submitWorkspaceRelocationStops(f.params, 'fixture-human')
      await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.manager.submitWorkspaceRelocationStops(f.params, 'fixture-human')).toBe(first)
      await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(capture).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled()
      expect(records.readWorkspaceRelocationWorkers(f.data, f.params.intent_id)).not.toBeNull()
      expect(records.readWorkspaceRelocationStops(f.data, f.params.intent_id).attempt).toBeNull()
      expect(records.readWorkspaceRelocationModules(f.data, f.params.intent_id)).toBeNull()
      const { launch } = records.readWorkspaceRelocationCoordinator(f.data, f.params.intent_id)
      expect(require('../../scripts/lib/process-identity.cjs').isProcessExited(launch!.process.pid)).toBe(true)
      expect(f.manager.processes.get('admin-web').exitCode).toBeNull(); expect(f.manager.processes.get('crabot-agent').exitCode).toBeNull()
    } finally { locks.releaseCliLock(lock); await f.cleanup() }
  }, timeout)
  it('preserves an actual Worker submission whose HTTP reply was lost without stopping modules or replaying', async () => {
    const f = await fixture({ actualAgent: true, processLifetimeMs: 120000, agentResult: 'lost-stop-reply' }), locks = require('../../scripts/lib/cli-lock.mjs')
    const records = await import('../../scripts/lib/workspace-relocation-intent.mjs'), lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    const modules = vi.spyOn(f.manager, 'requestWorkspaceRelocationModuleStops')
    try {
      const first = f.manager.submitWorkspaceRelocationStops(f.params, 'fixture-human')
      await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.manager.submitWorkspaceRelocationStops(f.params, 'fixture-human')).toBe(first)
      await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(await fs.readFile(path.join(f.data, 'stops.txt'), 'utf8')).toBe('stop\n')
      expect(records.readWorkspaceRelocationStops(f.data, f.params.intent_id).submission.results).toEqual([{ worker_id: 'worker', incarnation_id: 'inc', status: 'submitted' }])
      expect(records.readWorkspaceRelocationModuleStops(f.data, f.params.intent_id).attempt).toBeNull(); expect(modules).not.toHaveBeenCalled()
      expect(f.manager.processes.get('admin-web').exitCode).toBeNull(); expect(f.manager.processes.get('crabot-agent').exitCode).toBeNull()
    } finally { locks.releaseCliLock(lock); await f.cleanup() }
  }, timeout)
})


describe('MM requires original Admin quiescence before execution capture', () => {
  const timeout = process.platform === 'win32' ? 90000 : 30000
  it.each(['false', 'hash', 'extra', 'disconnect', 'mutate'])('keeps a bad or uncertain quiescence before any Worker scope or stop: %s', async mode => {
    const f = await fixture({ actualAgent: true, processLifetimeMs: 120000, quiesceResult: mode }), locks = require('../../scripts/lib/cli-lock.mjs')
    const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    const capture = vi.spyOn(f.manager, 'captureWorkspaceRelocationWorkersForCoordinator')
    try {
      const first = f.manager.submitWorkspaceRelocationStops(f.params, 'fixture-human')
      await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.manager.submitWorkspaceRelocationStops(f.params, 'fixture-human')).toBe(first)
      await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(capture).not.toHaveBeenCalled()
      expect((await f.calls()).filter(item => item.method === '/quiesce_workspace_relocation_web')).toHaveLength(1)
      expect(f.manager.processes.get('admin-web').exitCode).toBeNull(); expect(f.manager.processes.get('crabot-agent').exitCode).toBeNull()
      for (const name of ['workspace-control/relocation-workers.json', 'workspace-control/relocation-stop-attempt.json', 'stops.txt']) {
        await expect(fs.stat(path.join(f.data, name))).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally { locks.releaseCliLock(lock); await f.cleanup() }
  }, timeout)
  it('does not capture or stop Workers when a runtime only claims the old verified response', async () => {
    const f = await fixture({ actualAgent: true, processLifetimeMs: 120000 }), locks = require('../../scripts/lib/cli-lock.mjs')
    const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id), records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
    const capture = vi.spyOn(f.manager, 'captureWorkspaceRelocationWorkersForCoordinator'), open = require('../../scripts/lib/module-runtime-rpc.cjs')
    const original = open.openModuleRuntimeRpc
    vi.spyOn(open, 'openModuleRuntimeRpc').mockImplementation(async (...args: unknown[]) => {
      const rpc = await original(...args), call = rpc.call.bind(rpc)
      rpc.call = (method: string, params: unknown, options: unknown) => method === 'quiesce_workspace_relocation_web'
        ? call('verify_workspace_relocation_request', params, options) : call(method, params, options)
      return rpc
    })
    try {
      await expect(f.manager.submitWorkspaceRelocationStops(f.params, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(capture).not.toHaveBeenCalled(); expect(records.readWorkspaceRelocationWorkers(f.data, f.params.intent_id)).toBeNull()
      expect(f.manager.processes.get('admin-web').exitCode).toBeNull(); expect(f.manager.processes.get('crabot-agent').exitCode).toBeNull()
      await expect(fs.stat(path.join(f.data, 'stops.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { locks.releaseCliLock(lock); await f.cleanup() }
  }, timeout)
})


describe('MM prepares the original fixed workspace file plan', () => {
  const native = require('../../scripts/lib/process-identity.cjs')
  const timeout = process.platform === 'win32' ? 90000 : 30000
  for (const mode of ['confirmed', 'lost acknowledgement', 'lost Host acknowledgement']) it('retains Admin and never repeats file preparation: ' + mode, async () => {
    const f = await fixture({ actualAgent: true, actualAdmin: true, processLifetimeMs: 120000 }), locks = require('../../scripts/lib/cli-lock.mjs')
    const records = await import('../../scripts/lib/workspace-relocation-intent.mjs'), lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    const launch = f.manager.launchWorkspaceRelocationCoordinator.bind(f.manager)
    let child: ReturnType<typeof spawn> | undefined
    vi.spyOn(f.manager, 'launchWorkspaceRelocationCoordinator').mockImplementation(async (...args: any[]) => {
      child = await launch(...args)
      if (mode !== 'confirmed') {
        const emit = child!.emit.bind(child); let rejected = false
        vi.spyOn(child!, 'emit').mockImplementation((event: any, ...args: any[]) => {
          if (event === 'message' && args[0]?.kind === 'workspace_file_journal_reply' && args[0]?.operation === (mode === 'lost Host acknowledgement' ? 'prepare_host' : 'prepare') && !rejected) { rejected = true; return emit(event, { ...args[0], ok: false }) }
          return emit(event, ...args)
        })
      }
      return child
    })
    const stop = vi.spyOn(f.manager, 'submitWorkspaceRelocationStops')
    try {
      const ledger = path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), before = await fs.readFile(ledger), admin = f.manager.processes.get('admin-web')
      const first = f.manager.prepareWorkspaceRelocationFiles(f.params, 'fixture-human')
      expect(f.manager.prepareWorkspaceRelocationFiles({ ...f.params }, 'fixture-human')).toBe(first)
      await expect(f.manager.prepareWorkspaceRelocationFiles({ ...f.params, intent_id: randomUUID() }, 'fixture-human')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      if (mode !== 'confirmed') await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      else {
        const result = await first
        expect(result.file_actors_sha256).toBe(sha256CanonicalJson(records.readWorkspaceRelocationFileActors(f.data, f.params.intent_id)))
        expect(result.coordinator).toBe(child); expect(result.plan_sha256).toBe(sha256CanonicalJson(records.readWorkspaceRelocationFilePlan(f.data, f.params.intent_id)))
      }
      const plan = records.readWorkspaceRelocationFilePlan(f.data, f.params.intent_id)
      expect(plan.intent_id).toBe(f.params.intent_id); expect(plan.mode).toBe('rename')
      expect(stop).toHaveBeenCalledOnce(); expect(f.manager.prepareWorkspaceRelocationFiles(f.params, 'fixture-human')).toBe(first)
      if (mode !== 'confirmed') { await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' }); expect(child!.connected).toBe(false) }
      const actors = records.readWorkspaceRelocationFileActors(f.data, f.params.intent_id)
      if (mode === 'lost acknowledgement') expect(actors.attempt).toBeNull()
      else {
        expect(actors.permission).not.toBeNull(); expect(actors.host.process.parent).toBe(child!.pid)
        if (mode === 'confirmed') expect(native.sameProcess(actors.host.process, native.inspectProcess(actors.host.process.pid))).toBe(true)
      }
      expect(await fs.readFile(ledger)).toEqual(before); expect(f.manager.processes.get('admin-web')).toBe(admin); expect(admin.exitCode).toBeNull()
      expect(f.manager.processes.has('crabot-agent')).toBe(false)
      await expect(fs.stat(plan.staging_path)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.stat(path.join(f.root, 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await fetch(`http://127.0.0.1:${f.port}/api/friends`, { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(200)
      if (mode === 'confirmed') {
        const { createWorkspaceFileJournal } = require('../../scripts/lib/workspace-file-journal.mjs')
        const files = createWorkspaceFileJournal(child, { dataDir: f.data, id: f.params.intent_id, launch: records.readWorkspaceRelocationCoordinator(f.data, f.params.intent_id).launch })
        try {
          const prepared = await files.prepareStage()
          expect(prepared.dispatch).toBe('dispatch'); expect(prepared.staging.tree).toBeNull()
          expect(await fs.readdir(plan.staging_path)).toEqual([])
          expect((await files.prepareStage()).dispatch).toBe('observe')
          expect((await files.prepareHost()).dispatch).toBe('observe')
          const fileResult = await files.prepareFiles()
          expect(fileResult.dispatch).toBe('dispatch'); expect(fileResult.ready.content_sha256).toBe(plan.source_content_sha256)
          expect((await files.prepareFiles()).dispatch).toBe('observe')
          await expect(fs.stat(records.readWorkspaceRelocationIntent(f.data).source.path)).rejects.toMatchObject({ code: 'ENOENT' })
          expect(await fs.readFile(ledger)).toEqual(before)
          expect((await fetch(`http://127.0.0.1:${f.port}/api/friends`, { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(200)
          await expect(fs.stat(path.join(f.root, 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
        } finally { files.close() }
      }
    } finally {
      if (child?.connected) { const ended = once(child, 'exit'); child.disconnect(); await ended }
      locks.releaseCliLock(lock); await f.cleanup()
    }
  }, timeout)
})


describe('MM commits the original workspace Worker closures', () => {
  const timeout = process.platform === 'win32' ? 600000 : 40000
  for (const mode of ['confirmed', 'lost closure preparation', 'lost closure commit', 'lost recovery preparation', 'lost recovery commit', 'late runtime registration']) it('retains Admin and the first closure outcome: ' + mode, async () => {
    const f = await fixture({ actualAgent: true, actualAdmin: true, processLifetimeMs: process.platform === 'win32' ? 900000 : 300000 }), locks = require('../../scripts/lib/cli-lock.mjs')
    const records = await import('../../scripts/lib/workspace-relocation-intent.mjs'), lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    const launch = f.manager.launchWorkspaceRelocationCoordinator.bind(f.manager)
    let child: ReturnType<typeof spawn> | undefined, dropped = false
    vi.spyOn(f.manager, 'launchWorkspaceRelocationCoordinator').mockImplementation(async (...args: any[]) => {
      child = await launch(...args)
      if (mode.startsWith('lost ')) {
        const emit = child!.emit.bind(child)
        vi.spyOn(child!, 'emit').mockImplementation((event: any, ...args: any[]) => {
          const operation = { 'lost closure preparation': 'prepare_closure', 'lost closure commit': 'commit_closure', 'lost recovery preparation': 'prepare_recovery', 'lost recovery commit': 'commit_recovery' }[mode]
          if (event === 'message' && args[0]?.kind === 'workspace_worker_journal_reply' && args[0]?.operation === operation && !dropped) {
            dropped = true; return emit(event, { ...args[0], ok: false })
          }
          return emit(event, ...args)
        })
      }
      return child
    })
    const stop = vi.spyOn(f.manager, 'submitWorkspaceRelocationStops')
    if (mode === 'late runtime registration') {
      const list = f.manager.runtimeRegistry.listRecords.bind(f.manager.runtimeRegistry)
      vi.spyOn(f.manager.runtimeRegistry, 'listRecords').mockImplementation(async () => {
        const rows = await list()
        let ready = false
        try { ready = Boolean(records.readWorkspaceRelocationFileActors(f.data, f.params.intent_id).file_ready) } catch { /* No file-ready observation yet. */ }
        return ready ? [...rows, { module_id: 'unexpected-live-module' }] : rows
      })
    }
    try {
      const ledger = path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), original = JSON.parse(await fs.readFile(ledger, 'utf8'))
      const checkpoint = path.join(f.data, 'agent/managers/channel%3A%3Asession/running.json')
      await fs.mkdir(path.dirname(checkpoint), { recursive: true })
      const checkpointBytes = JSON.stringify({ episodeId: 'original-mm-episode', state: { key: 'channel::session', recent: [], foldedCount: 0 },
        envelopes: [], wakeIndex: -1, pending: [], hasEngineMessages: false, turns: [], responses: [], tools: [], pendingToolCallIds: [],
        adminChatClaims: [], transientMessageIds: [], spawnedWorkerIds: ['worker'], execution: { successfulSendMessageTargets: [], continuedWorkers: [],
          needsSpawnRecheck: false, spawnRecheckInjected: false, spawnRecheckOutcomeRecorded: false, postSendRecheckSequence: 0 } })
      await fs.writeFile(checkpoint, checkpointBytes, { mode: 0o600 })
      const admin = f.manager.processes.get('admin-web'), first = f.manager.commitWorkspaceRelocationWorkers(f.params, 'fixture-human')
      expect(f.manager.commitWorkspaceRelocationWorkers({ ...f.params }, 'fixture-human')).toBe(first)
      await expect(f.manager.commitWorkspaceRelocationWorkers({ ...f.params, intent_id: randomUUID() }, 'fixture-human')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      if (mode !== 'confirmed') await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      else {
        const result = await first
        expect(result.coordinator).toBe(child)
        expect(result.file_ready_sha256).toBe(sha256CanonicalJson(records.readWorkspaceRelocationFileActors(f.data, f.params.intent_id).file_ready))
        expect(result.closure_plan_sha256).toBe(sha256CanonicalJson(records.readWorkspaceRelocationClosurePlan(f.data, f.params.intent_id)))
        expect(result.closure_commit_sha256).toBe(sha256CanonicalJson(records.readWorkspaceRelocationClosureCommit(f.data, f.params.intent_id)))
        expect(result.recovery_plan_sha256).toBe(sha256CanonicalJson(records.readWorkspaceRelocationRecoveryPlan(f.data, f.params.intent_id)))
        expect(result.recovery_commit_sha256).toBe(sha256CanonicalJson(records.readWorkspaceRelocationRecoveryCommit(f.data, f.params.intent_id)))
      }
      const current = JSON.parse(await fs.readFile(ledger, 'utf8')).workers[0], old = original.workers[0]
      expect(current.task.status).toBe(['lost closure preparation', 'late runtime registration'].includes(mode) ? 'running' : 'closed')
      expect(current.origin).toEqual(old.origin); expect(current.report_to).toEqual(old.report_to)
      expect(current.incarnations[0].incarnation_id).toBe(old.incarnations[0].incarnation_id)
      expect(current.incarnations[0].workspace).toBe(old.incarnations[0].workspace)
      if (current.task.status === 'closed') expect(current.task.closed).toMatchObject({ by: 'migration', note: 'workspace relocation ' + f.params.intent_id })
      if (mode === 'late runtime registration') expect(records.readWorkspaceRelocationClosurePlan(f.data, f.params.intent_id)).toBeNull()
      expect(stop).toHaveBeenCalledOnce(); expect(f.manager.commitWorkspaceRelocationWorkers(f.params, 'fixture-human')).toBe(first)
      if (mode !== 'confirmed') { expect(dropped).toBe(mode.startsWith('lost ')); await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' }); expect(child!.connected).toBe(false) }
      expect(f.manager.processes.get('admin-web')).toBe(admin); expect(admin.exitCode).toBeNull(); expect(f.manager.processes.has('crabot-agent')).toBe(false)
      expect((await fetch(`http://127.0.0.1:${f.port}/api/friends`, { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(200)
      expect(records.readWorkspaceRelocationFileActors(f.data, f.params.intent_id).file_ready).not.toBeNull()
      await expect(fs.stat(path.join(f.root, 'relocated'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(require('../../scripts/lib/workspace-maintenance.cjs').workspaceMaintenancePending(f.data)).toBe(true)
      if (['confirmed', 'lost recovery commit'].includes(mode)) {
        await expect(fs.stat(checkpoint)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await fs.readFile(path.join(path.dirname(checkpoint), 'workspace-relocation-history', f.params.intent_id, 'checkpoint.json'), 'utf8')).toBe(checkpointBytes)
        expect(records.readWorkspaceRelocationRecoveryCommit(f.data, f.params.intent_id)).not.toBeNull()
      } else expect(await fs.readFile(checkpoint, 'utf8')).toBe(checkpointBytes)
    } finally {
      if (child?.connected) { const ended = once(child, 'exit'); child.disconnect(); await ended }
      locks.releaseCliLock(lock); await f.cleanup()
    }
  }, timeout)
})


describe('MM commits the original workspace Root', () => {
  const timeout = process.platform === 'win32' ? 600000 : 120000
  for (const mode of ['confirmed', 'lost preparation', 'lost publication', 'lost selection', 'late runtime registration']) it('keeps Admin and the original Root outcome: ' + mode, async () => {
    const f = await fixture({ actualAgent: true, actualAdmin: true, processLifetimeMs: process.platform === 'win32' ? 900000 : 300000 })
    const locks = require('../../scripts/lib/cli-lock.mjs'), records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
    const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    const launch = f.manager.launchWorkspaceRelocationCoordinator.bind(f.manager)
    let child: ReturnType<typeof spawn> | undefined, dropped = false
    vi.spyOn(f.manager, 'launchWorkspaceRelocationCoordinator').mockImplementation(async (...args: any[]) => {
      child = await launch(...args)
      const operation = { 'lost preparation': 'prepare_root', 'lost publication': 'publish_root', 'lost selection': 'select_root' }[mode]
      if (operation) {
        const emit = child!.emit.bind(child)
        vi.spyOn(child!, 'emit').mockImplementation((event: any, ...args: any[]) => {
          if (event === 'message' && args[0]?.kind === 'workspace_file_journal_reply' && args[0]?.operation === operation && !dropped) {
            dropped = true; return emit(event, { ...args[0], ok: false })
          }
          return emit(event, ...args)
        })
      }
      return child
    })
    if (mode === 'late runtime registration') {
      const list = f.manager.runtimeRegistry.listRecords.bind(f.manager.runtimeRegistry)
      vi.spyOn(f.manager.runtimeRegistry, 'listRecords').mockImplementation(async () => {
        const rows = await list()
        return records.readWorkspaceRelocationRootPlan(f.data, f.params.intent_id) ? [...rows, { module_id: 'unexpected-live-module' }] : rows
      })
    }
    const stop = vi.spyOn(f.manager, 'submitWorkspaceRelocationStops')
    try {
      const admin = f.manager.processes.get('admin-web'), catalog = new WorkspaceCatalog({ dataRoot: f.data, files: require('../../scripts/lib/process-identity.cjs') })
      const before = await catalog.snapshot(), ledger = path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json')
      const old = JSON.parse(await fs.readFile(ledger, 'utf8')).workers[0]
      const first = f.manager.commitWorkspaceRelocationRoot(f.params, 'fixture-human')
      expect(f.manager.commitWorkspaceRelocationRoot({ ...f.params }, 'fixture-human')).toBe(first)
      await expect(f.manager.commitWorkspaceRelocationRoot({ ...f.params, intent_id: randomUUID() }, 'fixture-human')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      if (mode === 'confirmed') {
        const result = await first
        expect(result.coordinator).toBe(child)
        expect(result.root_plan_sha256).toBe(sha256CanonicalJson(records.readWorkspaceRelocationRootPlan(f.data, f.params.intent_id)))
        expect(result.root_published_sha256).toBe(sha256CanonicalJson(records.readWorkspaceRelocationRootPublished(f.data, f.params.intent_id)))
        expect(result.root_selected_sha256).toBe(sha256CanonicalJson(records.readWorkspaceRelocationRootSelected(f.data, f.params.intent_id)))
      } else {
        await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
        expect(child!.connected).toBe(false); expect(dropped).toBe(mode.startsWith('lost '))
        await expect(f.manager.commitWorkspaceRelocationRoot(f.params, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      }
      expect(stop).toHaveBeenCalledOnce(); expect(f.manager.commitWorkspaceRelocationRoot(f.params, 'fixture-human')).toBe(first)
      const selected = mode === 'confirmed' || mode === 'lost selection'
      expect((await catalog.snapshot()).storage_root).toBe(selected ? path.join(f.root, 'relocated') : before.storage_root)
      expect((await catalog.snapshot()).revision).toBe(before.revision + (selected ? 1 : 0))
      expect(records.readWorkspaceRelocationRootPlan(f.data, f.params.intent_id)).not.toBeNull()
      expect(Boolean(records.readWorkspaceRelocationRootPublished(f.data, f.params.intent_id))).toBe(selected || mode === 'lost publication')
      expect(Boolean(records.readWorkspaceRelocationRootSelected(f.data, f.params.intent_id))).toBe(selected)
      const current = JSON.parse(await fs.readFile(ledger, 'utf8')).workers[0]
      expect(current.task.status).toBe('closed'); expect(current.origin).toEqual(old.origin); expect(current.report_to).toEqual(old.report_to)
      expect(current.incarnations[0].workspace).toBe(old.incarnations[0].workspace)
      expect(f.manager.processes.get('admin-web')).toBe(admin); expect(admin.exitCode).toBeNull(); expect(f.manager.processes.has('crabot-agent')).toBe(false)
      expect((await fetch(`http://127.0.0.1:${f.port}/api/friends`, { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(200)
      expect(require('../../scripts/lib/workspace-maintenance.cjs').workspaceMaintenancePending(f.data)).toBe(true)
    } finally {
      if (child?.connected) { const ended = once(child, 'exit'); child.disconnect(); await ended }
      locks.releaseCliLock(lock); await f.cleanup()
    }
  }, timeout)
})
