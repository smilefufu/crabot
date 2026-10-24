import { afterEach, describe, it, expect, vi } from 'vitest'
import fs from 'node:fs/promises'
import syncFs, { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import { randomInt, randomUUID } from 'node:crypto'
import { ChildProcess, spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { WorkspaceCatalog } from 'crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson } from 'crabot-shared'
import ModuleManager from './index.js'
import { terminateProcessTree } from './process-tree.js'
import { relocationAgentConfig } from '../../crabot-agent/tests/core/fixtures/relocation-agent-config.js'

afterEach(() => vi.restoreAllMocks())

function coordinatorJournalFailures(child: ReturnType<typeof spawn>): string[] {
  return require('../../scripts/lib/workspace-coordinator-launch.mjs').workspaceCoordinatorDiagnostics(child)
    .split('\n').filter((line: string) => line.includes('workspace_journal_failed') || line.includes('workspace_root_probe_failed')).slice(-3)
}

// Finite CI diagnostics only: no arguments, paths, identities or credentials are recorded.
function observeColdTerminalProgress(cold: any, coordinator: any, grant: any) {
  const native = require('../../scripts/lib/process-identity.cjs'), counters: Record<string, { calls: number; pending: number; elapsed_ms: number }> = {}
  const restores: Array<() => void> = [], started = performance.now()
  const replace = (object: any, key: string, value: (...args: any[]) => any) => {
    const previous = Object.getOwnPropertyDescriptor(object, key)
    Object.defineProperty(object, key, { configurable: true, writable: true, enumerable: previous?.enumerable ?? false, value })
    restores.push(() => { if (previous) Object.defineProperty(object, key, previous); else delete object[key] })
  }
  const watch = (object: any, key: string, name = key) => {
    if (typeof object[key] !== 'function' || Object.getOwnPropertyDescriptor(object, key)?.configurable === false) return // Private ACL primitives are Windows-only.
    const original = object[key].bind(object), counter = counters[name] = { calls: 0, pending: 0, elapsed_ms: 0 }
    replace(object, key, (...args: any[]) => {
      const began = performance.now(); counter.calls++; counter.pending++
      const done = () => { counter.pending--; counter.elapsed_ms += performance.now() - began }
      try {
        const result = original(...args)
        if (result && typeof result.then === 'function') void result.then(done, done)
        else done()
        return result // Preserve the actual cached Promise and all original effects.
      } catch (error) { done(); throw error }
    })
  }
  for (const key of ['releaseWorkspaceRecoveryCompletion', 'prepareWorkspaceRecoveryCompletion', 'beginWorkspaceRecoveryCompletionObservation', 'restoreWorkspaceModules']) watch(cold, key)
  watch(grant, 'verifyHealth', 'current-health'); watch(grant, 'verify', 'current-facts')
  watch(syncFs, 'readFileSync', 'sync-file-read')
  for (const key of ['inspectProcess', 'isPrivateDirectory', 'isPrivateFile', 'listListeningTcpPorts']) watch(native, key, 'native-' + key)
  const ipc: Record<string, number> = {}, sent = coordinator.child.send.bind(coordinator.child)
  const kinds = new Set(['workspace_recovery_release', 'workspace_recovery_released', 'workspace_recovery_release_observe', 'workspace_recovery_release_observed', 'workspace_recovery_verify', 'workspace_recovery_verified'])
  const observe = (message: any) => { if (kinds.has(message?.kind)) ipc[message.kind] = (ipc[message.kind] ?? 0) + 1 }
  replace(coordinator.child, 'send', (message: any, ...args: any[]) => { observe(message); return sent(message, ...args) })
  coordinator.child.on('message', observe)
  const report = () => console.log('[Cold terminal progress]', { elapsed_ms: Math.round(performance.now() - started), phase: grant.phase, counters, ipc })
  report()
  const timer = setInterval(report, 15000); timer.unref()
  return () => { clearInterval(timer); report(); coordinator.child.off('message', observe); for (const restore of restores.reverse()) restore() }
}

// Keep fixture listeners out of the default OS ephemeral client-port range.
async function reserveFixturePort(): Promise<ReturnType<typeof http.createServer>> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const server = http.createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject); server.listen(randomInt(12000, 30000), '127.0.0.1', resolve)
      })
      return server
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error }
  }
  throw new Error('No finite fixture port was available')
}

// Diagnostic-only observer: install after the real reader has attached; never copy header values.
function observeActualAdminRecoveryRpc(callsFile: string): string {
  return `(function(){
    const fs=require('node:fs'),{default:Admin}=require(${JSON.stringify(path.resolve('../crabot-admin/dist/index.js'))});
    const original=Admin.prototype.handleRequest,calls=JSON.parse(fs.readFileSync(${JSON.stringify(callsFile)},'utf8'));
    Admin.prototype.handleRequest=function(req,res){
      const pending=original.call(this,req,res);
      if(['/prepare_workspace_relocation_recovery_completion','/resume_workspace_relocation_recovery_web'].includes(req.url)){
        let body='';req.on('data',part=>body+=part);req.once('end',()=>{calls.push({method:req.url,authorization:req.headers.authorization?'present':undefined,body:JSON.parse(body)});fs.writeFileSync(${JSON.stringify(callsFile)},JSON.stringify(calls))});
      }
      return pending;
    };
  })();`
}

async function fixture(options: { withMemory?: boolean; inactiveMemory?: boolean; wrongRuntime?: boolean; result?: string; withAgent?: boolean; agentResult?: string; actualAgent?: boolean; businessAgent?: boolean; businessMemory?: boolean; processLifetimeMs?: number; backgroundShell?: boolean; validationHealth?: 'healthy' | 'unhealthy'; validationServerReadyDelayMs?: number; runtimeRegistrationDelayMs?: number; validationRuntimeMismatch?: boolean; validationRootOverride?: boolean; validationRegistration?: 'delayed' | 'exit'; memoryHealth?: 'healthy' | 'degraded'; memoryBootstrap?: boolean; actualAdmin?: boolean; adminReadyDelayMs?: number; quiesceResult?: string; orphanDuringStop?: boolean; extraModule?: 'running' | 'inactive' | 'tool'; historyWorkspace?: boolean } = {}) {
  if ((options.businessAgent || options.businessMemory) && (process.env.GITHUB_ACTIONS !== 'true' || process.env.CRABOT_WORKSPACE_BUSINESS_ONSTART_CI !== '1')) throw new Error('Business onStart is isolated CI only')
  const fixtureTestName = expect.getState().currentTestName
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-current-admin-')))
  const native = require('../../scripts/lib/process-identity.cjs'), management = require('../../scripts/lib/desktop-management.cjs')
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), script = path.join(data, 'finite-admin.cjs'), callsFile = path.join(data, 'calls.json')
  const reserve = await reserveFixturePort()
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
          const file=${JSON.stringify(path.join(data, 'workspace-control/relocation-active/relocation.json'))},stored=JSON.parse(fs.readFileSync(file,'utf8'));
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
      admin.cutoverActivated=true;admin.verifyAuthenticatedToken=async token=>!fs.existsSync(${JSON.stringify(path.join(data, 'human-revoked'))})&&token==='fixture-human'?{sub:'admin'}:null;
      const server=http.createServer((req,res)=>{const record=body=>{calls.push({method:req.url,authorization:req.headers.authorization?'present':undefined,body});fs.writeFileSync(process.env.FIXTURE_CALLS,JSON.stringify(calls))};
        if(req.url.startsWith('/api/'))record();else{let text='';req.on('data',part=>text+=part);req.on('end',()=>{let body;try{if(text)body=JSON.parse(text)}catch{}record(body)})}
        if(${!!options.businessAgent}){
          const config=${JSON.stringify(relocationAgentConfig)};config.agent_config.model_config.powerful.endpoint='http://127.0.0.1:'+process.env.Crabot_PORT+'/v1';
          if(require(${JSON.stringify(path.resolve('src/test-fixtures/workspace-config-admin.cjs'))}).handleWorkspaceConfigRequest(req,res,{config,moduleManagerPort:Number(process.env.CRABOT_MM_PORT)}))return;
        }
        const handling=req.url.startsWith('/api/')?admin.handleWebRequest(req,res):admin.handleRequest(req,res);void handling.catch(()=>{if(!res.headersSent)res.writeHead(500);res.end('{}')})
      });(async()=>{await admin.workspaceService.initialize();await new Promise(resolve=>setTimeout(resolve,${options.adminReadyDelayMs ?? 0}));server.listen(Number(process.env.Crabot_PORT),'127.0.0.1',()=>fs.writeFileSync(process.env.FIXTURE_READY,'ready'))})().catch(error=>{console.error(error);process.exit(1)});
      setTimeout(()=>process.exit(0),${options.processLifetimeMs ?? 30000}).unref();`)
  }
  const manager = new ModuleManager({ port: 0, modules: [], shutdown_timeout: 0.1 }, data) as any
  if (options.runtimeRegistrationDelayMs) {
    const original = manager.runtimeRegistry.recordSpawn.bind(manager.runtimeRegistry)
    let first = true
    vi.spyOn(manager.runtimeRegistry, 'recordSpawn').mockImplementation(async (input: any) => {
      if (first && input.moduleId === 'crabot-agent') { first = false; await new Promise(resolve => setTimeout(resolve, options.runtimeRegistrationDelayMs)) }
      return original(input)
    })
  }
  let host: ReturnType<typeof http.createServer> | undefined
  if (options.actualAgent && !options.businessAgent && options.validationHealth) {
    const prototype = ModuleManager.prototype as any, start = prototype.startModuleProcess
    vi.spyOn(prototype, 'startModuleProcess').mockImplementation(async function (this: any, ...args: any[]) {
      const result = await start.apply(this, args)
      if (this.dataDir !== data || args[0] !== 'crabot-agent') return result
      const child = this.processes.get('crabot-agent'), state = child && this.childStates.get(child), bearer = this.runtimeBearers.get('crabot-agent')
      if (!child || !state || !bearer || bearer.revoked || bearer.child !== child || state.finalizeStarted || state.rootExited) throw new Error('Finite parent runtime was not published')
      // Test rendezvous only: gated descendants retain the root runtime id.
      // The real register RPC still authenticates their actual process tree.
      syncFs.writeFileSync(path.join(data, 'finite-agent-registration-' + state.runtimeId), state.runtimeId)
      return result
    })
  }
  const cleanup = async () => {
    if (expect.getState().currentTestName === fixtureTestName) vi.restoreAllMocks()
    const admin = manager.modules.get('admin-web'); if (admin) admin.port = port
    try { await manager.stop() }
    catch (error) {
      const actors = [...manager.processes].map(([id, child]: [string, any]) => {
        let actual = null, kernelExited = null, group = null, identityErrno, exitErrno
        try { actual = native.inspectProcess(child.pid) } catch (probe) { identityErrno = /macOS errno (\d+)/.exec((probe as Error).message)?.[1] }
        try { kernelExited = native.isProcessExited(child.pid) } catch (probe) { exitErrno = /macOS errno (\d+)/.exec((probe as Error).message)?.[1] }
        if (process.platform !== 'win32') {
          try { process.kill(-child.pid, 0); group = 'alive' } catch (probe) { group = (probe as NodeJS.ErrnoException).code }
        }
        return { module_id: id, pid: child.pid, exit_code: child.exitCode, signal: child.signalCode,
          actual_started: actual?.started, actual_owner: actual?.owner, kernel_exited: kernelExited, group_probe: group, identity_errno: identityErrno, exit_errno: exitErrno }
      })
      let numericGroups: unknown
      if (process.platform !== 'win32') {
        try {
          const groups = new Set(actors.map((actor: { pid?: number }) => actor.pid))
          numericGroups = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,uid=,stat='], { encoding: 'utf8', timeout: 1000, maxBuffer: 1024 * 1024 })
            .trim().split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 5 && (groups.has(Number(parts[2])) || Number(parts[0]) === process.pid)).slice(0, 32)
            .map(parts => ({ pid: Number(parts[0]), parent: Number(parts[1]), group: Number(parts[2]), uid: Number(parts[3]), status: parts[4] }))
        } catch (probe) { numericGroups = { code: (probe as NodeJS.ErrnoException).code } }
      }
      console.error('[Workspace fixture cleanup] ' + JSON.stringify({ code: (error as NodeJS.ErrnoException).code, actors, numeric_groups: numericGroups }))
      throw error
    } finally { if (host) { host.closeAllConnections(); await new Promise<void>(resolve => host!.close(() => resolve())) } }
    await fs.rm(root, { recursive: true, force: true })
  }
  try {
    if (options.businessAgent) {
      // Real main requires the same completed offline preparation as ordinary startup.
      await fs.mkdir(path.join(data, 'admin'), { recursive: true })
      const { prepareSharedRequests } = require('../../scripts/upgrade-lib/shared-requests.mjs')
      expect((await prepareSharedRequests(path.resolve('..'), data)).status).toBe('prepared')
      await require('../../crabot-agent/dist/manager/request-upgrade.js').assertRequestUpgradeReady(path.join(data, 'agent'))
    }
    if (options.actualAgent || options.extraModule) {
      host = http.createServer((req, res) => { void manager.handleRequest(req, res) })
      await new Promise<void>(resolve => host!.listen(0, '127.0.0.1', resolve))
      manager.config.port = (host.address() as { port: number }).port
    }
    manager.managementOnly = false
    const runtime = { module_id: 'admin-web', module_type: 'admin', entry: `"${process.execPath}" "${script}"`,
      env: { FIXTURE_CALLS: callsFile, FIXTURE_READY: path.join(data, 'ready'), FIXTURE_QUIESCE_RESULT: options.quiesceResult ?? '', DATA_DIR: data, CRABOT_AGENT_DATA_DIR: path.join(data, 'agent'), ...(options.wrongRuntime ? { FIXTURE_WRONG_RUNTIME: '1' } : {}),
   ...(options.result ? { FIXTURE_RESULT: options.result } : {}) },
      port, auto_start: false, auto_restart: false, skip_health_check: true, start_priority: 1, status: 'stopped' }
    manager.modules.set('admin-web', runtime); await manager.startModuleProcess('admin-web')
    await vi.waitFor(async () => expect(await fs.readFile(path.join(data, 'ready'), 'utf8')).toBe('ready'), { timeout: 10000 })
    if (options.withAgent || options.actualAgent) {
      const agentPort = await reserveFixturePort()
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
            await fs.writeFile(path.join(data, 'stops.txt'), '')
            await fs.writeFile(path.join(data, 'orphan-ready.json'), '')
            await fs.writeFile(path.join(data, 'finite-orphan.cjs'), `const fs=require('node:fs'),native=require(${JSON.stringify(path.resolve('../scripts/lib/process-identity.cjs'))});
              fs.writeFileSync(${JSON.stringify(path.join(data, 'orphan-ready.json'))},JSON.stringify({process:native.inspectProcess(process.pid),parent:Number(process.argv[2])}));
              const file=${JSON.stringify(path.join(data, 'project/orphan.txt'))};fs.writeFileSync(file,'orphan active');setInterval(()=>fs.appendFileSync(file,'x'),50);setTimeout(()=>process.exit(0),20000);`)
          }
          await fs.writeFile(path.join(data, 'finite-background.cjs'), `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(path.join(data, 'background-program.json'))},JSON.stringify({pid:process.pid}));const file=${JSON.stringify(path.join(data, 'project/background.txt'))};fs.writeFileSync(file,'active\\n');setInterval(()=>fs.appendFileSync(file,'x'),50);setTimeout(()=>process.exit(0),120000);
            ${options.orphanDuringStop ? `const timer=setInterval(()=>{
              if(!fs.existsSync(${JSON.stringify(path.join(data, 'stops.txt'))})||fs.statSync(${JSON.stringify(path.join(data, 'stops.txt'))}).size===0)return;clearInterval(timer);
              const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(path.join(data, 'finite-orphan.cjs'))},String(process.pid)],{detached:true,stdio:'ignore'});child.unref();
              setInterval(()=>{let observed=false;try{observed=fs.readFileSync(${JSON.stringify(path.join(data, 'workspace-control/relocation-active/relocation-process-stop.jsonl'))},'utf8').trimEnd().split('\\n').map(line=>JSON.parse(line)).some(row=>row.processes?.some(item=>item.pid===child.pid))}catch{}
                if(observed)process.exit(0)},10)
            },10);` : ''}`)
        }
        await fs.writeFile(agentScript, `const fs=require('node:fs');
          if(${!!options.businessAgent}&&fs.existsSync(${JSON.stringify(path.join(data, 'workspace-control/relocation-active/relocation-root-selected.json'))})){
            if(process.env.GITHUB_ACTIONS!=='true'||process.env.CRABOT_WORKSPACE_BUSINESS_ONSTART_CI!=='1')throw new Error('Business onStart is isolated CI only');
            setTimeout(()=>process.exit(1),${options.processLifetimeMs ?? 300000}).unref();
            require(${JSON.stringify(path.resolve('../crabot-agent/dist/main.js'))});
          }else{const http=require('node:http'),{UnifiedAgent}=require(${JSON.stringify(entry)}),calls=[];
          require(${JSON.stringify(path.resolve('../crabot-agent/dist/core/config-loader.js'))}).ConfigLoader.captureRuntimeBearer();
          const selected=${JSON.stringify(path.join(data, 'workspace-control/relocation-active/relocation-root-selected.json'))};
          const registrationRuntimeId=process.env.CRABOT_MODULE_RUNTIME_ID;
          if(${!!options.validationRuntimeMismatch}&&fs.existsSync(selected))process.env.CRABOT_MODULE_RUNTIME_ID='fixture-wrong-runtime';
          const config=${JSON.stringify(relocationAgentConfig)};config.port=Number(process.env.Crabot_PORT);const agent=new UnifiedAgent(config);
          if(${JSON.stringify(options.validationHealth ?? null)}&&fs.existsSync(selected))agent.getHealthStatus=async()=>fs.existsSync(${JSON.stringify(path.join(data, 'validation-health-unhealthy'))})?'unhealthy':${JSON.stringify(options.validationHealth ?? 'healthy')};
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
              const ready=${JSON.stringify(path.join(data, 'background-program.json'))},end=Date.now()+8000;while(!fs.existsSync(ready)){if(Date.now()>=end)throw new Error('finite background program did not start');await new Promise(resolve=>setTimeout(resolve,20));}
            }
            const at='2026-10-20T00:00:00.000Z';if(!(await agent.managerStack.ledger.listAllWorkers()).some(item=>item.worker.worker_id==='worker'))await agent.managerStack.ledger.upsertWorker('channel::session','worker',()=>({worker_id:'worker',manager_key:'channel::session',task:{id:'task',title:'private task',status:'running',created_at:at},origin:{trigger_type:'message',creator_friend_id:'unchanged'},report_to:{channel_id:'channel',session_id:'session'},incarnations:[{incarnation_id:'inc',impl:'builtin',seq:1,state:${JSON.stringify(options.backgroundShell ? 'idle' : 'running')},workspace:process.env.FIXTURE_WORKSPACE,session_ref:'fixture',started_at:at}],updated_at:at}));
            if(fs.existsSync(selected))await new Promise(resolve=>setTimeout(resolve,${options.validationServerReadyDelayMs ?? 0}));
            server.listen(Number(process.env.Crabot_PORT),'127.0.0.1',async()=>{
              if(${!!options.validationHealth}) {
                if(fs.existsSync(selected)&&${JSON.stringify(options.validationRegistration ?? null)}==='exit'){fs.writeFileSync(process.env.FIXTURE_READY,'ready');return}
                if(fs.existsSync(selected)&&${JSON.stringify(options.validationRegistration ?? null)}==='delayed')await new Promise(resolve=>setTimeout(resolve,300));
                try{
                  const publication=require('node:path').join(process.env.DATA_DIR,'finite-agent-registration-'+registrationRuntimeId),end=Date.now()+(process.platform==='win32'?30000:10000);
                  while(!fs.existsSync(publication)||fs.readFileSync(publication,'utf8')!==registrationRuntimeId){
                    if(Date.now()>=end)throw new Error('Finite parent runtime was not published');await new Promise(resolve=>setTimeout(resolve,10));
                  }
                  const response=await fetch('http://127.0.0.1:'+process.env.CRABOT_MM_PORT+'/register_core_agent',{method:'POST',
                  headers:{'Content-Type':'application/json',Authorization:'Bearer '+require(${JSON.stringify(path.resolve('../crabot-agent/dist/core/config-loader.js'))}).ConfigLoader.getRuntimeBearer()},
                  body:JSON.stringify({id:require('node:crypto').randomUUID(),source:'crabot-agent',method:'register_core_agent',params:{module_id:'crabot-agent',module_type:'agent',version:'0.1.0',protocol_version:'3.4.0',port:Number(process.env.Crabot_PORT),subscriptions:[]}})});
                  const reply=await response.json();if(!reply.success){fs.writeFileSync(process.env.FIXTURE_READY+'.registration-failed',['UNAUTHORIZED','FORBIDDEN','INVALID_PARAMS'].includes(reply.error?.code)?reply.error.code:'UNKNOWN');throw new Error('Finite Agent registration failed')}
                }catch(error){console.error(error);process.exit(1);return}
              }
              fs.writeFileSync(process.env.FIXTURE_READY,'ready');
            })})().catch(error=>{console.error(error);process.exit(1)});
          setTimeout(()=>process.exit(0),${options.processLifetimeMs ?? 30000}).unref();}`)
      }
      if (options.historyWorkspace) {
        await fs.mkdir(path.join(data, 'workspaces/default/tasks/worker'), { recursive: true })
        await fs.writeFile(path.join(data, 'workspaces/default/tasks/worker/history.md'), 'original history artifact')
      }
      const agent = { module_id: 'crabot-agent', module_type: 'agent', entry: `"${process.execPath}" "${agentScript}"`,
        env: { FIXTURE_CALLS: path.join(data, 'agent-calls.json'), FIXTURE_READY: agentReady, FIXTURE_RESULT: options.agentResult ?? '',
          DATA_DIR: data, CRABOT_AGENT_DATA_DIR: path.join(data, 'agent'), ...(options.validationRootOverride ? { WORKER_WORKSPACES_DIR: path.join(data, 'workspaces') } : {}), FIXTURE_WORKSPACE: options.historyWorkspace ? path.join(data, 'workspaces/default/tasks/worker') : path.join(data, 'project'), FIXTURE_STOPS: path.join(data, 'stops.txt'),
          ...(options.backgroundShell ? { FIXTURE_BG_COMMAND: `"${process.execPath.replaceAll('\\', '/')}" "${path.join(data, 'finite-background.cjs').replaceAll('\\', '/')}"`, FIXTURE_BG_READY: path.join(data, 'background-ready.json'), ...(options.orphanDuringStop ? { FIXTURE_ORPHAN_READY: path.join(data, 'orphan-ready.json') } : {}) } : {}) },
        port: (agentPort.address() as { port: number }).port, auto_start: false, auto_restart: false, skip_health_check: !options.validationHealth, start_priority: 1, status: 'stopped' }
      await new Promise<void>(resolve => agentPort.close(() => resolve()))
      if (options.validationHealth || options.validationRegistration || options.businessAgent) {
        await fs.writeFile(path.join(data, 'port-allocations.json'), JSON.stringify([{ module_id: 'crabot-agent', port: agent.port, allocated_at: new Date().toISOString() }]))
        await manager.portAllocator.initialize()
      }
      manager.modules.set('crabot-agent', agent); await manager.startModuleProcess('crabot-agent')
      await vi.waitFor(async () => expect(await fs.readFile(agentReady, 'utf8')).toBe('ready'), { timeout: 10000 })
    }
    if (options.withMemory || options.inactiveMemory) {
      const reserved = await reserveFixturePort(), port = (reserved.address() as { port: number }).port
      await new Promise<void>(resolve => reserved.close(() => resolve()))
      let memoryEntry = `"${process.execPath}" -e "setInterval(()=>{},1000)"`
      if (options.memoryHealth || options.businessMemory) {
        const recordsFile = path.join(data, 'port-allocations.json'), allocations = JSON.parse(await fs.readFile(recordsFile, 'utf8').catch(() => '[]'))
        await fs.writeFile(recordsFile, JSON.stringify([...allocations, { module_id: 'memory-default', port, allocated_at: new Date().toISOString() }]))
        await manager.portAllocator.initialize()
      }
      if (options.memoryHealth && !options.businessMemory) {
        const file = path.join(data, 'finite-memory-server.cjs'), carrier = path.join(data, 'finite-memory-carrier.cjs')
        await fs.writeFile(file, `const http=require('node:http'),fs=require('node:fs');const server=http.createServer(async(req,res)=>{
          let text='';for await(const part of req)text+=part;const body=JSON.parse(text);
          const data=body.method==='get_runtime_identity'?{instance_id:process.env.CRABOT_INSTANCE_ID,module_id:'memory-default',runtime_id:process.env.CRABOT_MODULE_RUNTIME_ID}:body.method==='health'?{status:fs.existsSync(${JSON.stringify(path.join(data, 'workspace-control/relocation-active/relocation-root-selected.json'))})?${JSON.stringify(options.memoryHealth)}:'healthy',details:{pid:process.pid}}:{};
          res.end(JSON.stringify({id:body.id,success:true,data}));if(body.method==='shutdown')setTimeout(()=>process.exit(0),25);
        });server.listen(Number(process.env.Crabot_PORT),'127.0.0.1',async()=>{
          try{const response=await fetch('http://127.0.0.1:'+process.env.CRABOT_MM_PORT+'/register',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({id:require('node:crypto').randomUUID(),source:'memory-default',method:'register',params:{module_id:'memory-default',module_type:'memory',version:'0.1.0',protocol_version:'0.1.0',port:Number(process.env.Crabot_PORT),subscriptions:[]}})});
            if(!(await response.json()).success)throw new Error('Finite Memory registration failed');fs.writeFileSync(${JSON.stringify(path.join(data, 'memory-ready'))},'ready')
          }catch(error){console.error(error);process.exit(1)}
        });setTimeout(()=>process.exit(0),${options.processLifetimeMs ?? 30000}).unref();`)
        await fs.writeFile(carrier, `const{spawn}=require('node:child_process');const child=spawn(process.execPath,[${JSON.stringify(file)}],{stdio:'inherit'});child.on('exit',(code)=>process.exit(code??1));setTimeout(()=>process.exit(0),${options.processLifetimeMs ?? 30000}).unref();`)
        memoryEntry = `"${process.execPath}" "${carrier}"`
        if (options.memoryBootstrap) {
          const gate = path.join(data, 'memory-bootstrap-gate'), bootstrap = path.join(data, 'finite-memory-bootstrap.sh')
          const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
          await fs.writeFile(gate, 'hold')
          await fs.writeFile(bootstrap, `if [ -f ${quote(path.join(data, 'workspace-control/relocation-active/relocation-root-selected.json'))} ]; then
  while [ "$(cat ${quote(gate)})" != release ]; do sleep 0.02; done
fi
exec ${quote(process.execPath)} ${quote(carrier)}
`)
          memoryEntry = `/bin/sh "${bootstrap}"`
        }
      }
      const memoryProject = path.resolve('../crabot-memory'), memoryData = path.join(data, 'memory')
      if (options.businessMemory) {
        const python = path.join(memoryProject, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
        await fs.access(python)
        const wrapper = path.join(data, 'business-memory.py')
        await fs.writeFile(wrapper, `import os,sys,runpy
if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('CRABOT_WORKSPACE_BUSINESS_ONSTART_CI') != '1':
    raise RuntimeError('Business Memory startup is isolated CI only')
sys.path.insert(0,${JSON.stringify(memoryProject)})
runpy.run_module('src.main',run_name='__main__')
`)
        memoryEntry = `"${python}" "${wrapper}"`
      }
      manager.modules.set('memory-default', { module_id: 'memory-default', module_type: 'memory', entry: memoryEntry,
        ...(options.businessMemory ? { cwd: memoryProject, data_dir: memoryData, env: {
          CRABOT_MEMORY_DATA_DIR: memoryData, CRABOT_MODULE_MANAGER_URL: `http://127.0.0.1:${manager.config.port}`,
          CRABOT_LLM_API_KEY: 'finite-fixture-only', CRABOT_LLM_MODEL: 'finite-fixture-model', CRABOT_LLM_FORMAT: 'openai',
          CRABOT_LLM_BASE_URL: `http://127.0.0.1:${manager.modules.get('admin-web').port}/v1`,
        } } : {}),
        port, auto_start: false, auto_restart: false, start_priority: 0, skip_health_check: !options.memoryHealth, status: 'stopped' })
      if (options.withMemory) {
        await manager.startModuleProcess('memory-default')
        if (options.businessMemory) {
          await vi.waitFor(async () => expect(await manager.sendToModule(port, 'health', {})).toMatchObject({ status: 'healthy' }), { timeout: 15000 })
        } else if (options.memoryHealth) await vi.waitFor(async () => expect(await fs.readFile(path.join(data, 'memory-ready'), 'utf8')).toBe('ready'), { timeout: 10000 })
      }
    }
    if (options.extraModule) {
      const reserved = await reserveFixturePort(), port = (reserved.address() as { port: number }).port
      await new Promise<void>(resolve => reserved.close(() => resolve()))
      const id = options.extraModule === 'tool' ? 'fixture-tool' : 'fixture-channel'
      const allocationsFile = path.join(data, 'port-allocations.json'), allocations = JSON.parse(await fs.readFile(allocationsFile, 'utf8').catch(() => '[]'))
      await fs.writeFile(allocationsFile, JSON.stringify([...allocations, { module_id: id, port, allocated_at: new Date().toISOString() }]))
      await manager.portAllocator.initialize()
      const entry = path.join(data, id + '.cjs'), ready = path.join(data, id + '-ready')
      await fs.writeFile(entry, options.extraModule === 'tool' ? `setInterval(()=>{},1000)` : `
        const http=require('node:http'),fs=require('node:fs'),crypto=require('node:crypto');
        const server=http.createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;const body=JSON.parse(text);
          const data=body.method==='get_runtime_identity'?{instance_id:process.env.CRABOT_INSTANCE_ID,module_id:${JSON.stringify(id)},runtime_id:process.env.CRABOT_MODULE_RUNTIME_ID}:
            body.method==='health'?{status:fs.existsSync(${JSON.stringify(path.join(data, 'extra-health-unhealthy'))})?'degraded':'healthy'}:{};
          res.end(JSON.stringify({id:body.id,success:true,data}));if(body.method==='shutdown')setTimeout(()=>process.exit(0),25);
        });server.listen(Number(process.env.Crabot_PORT),'127.0.0.1',async()=>{try{
          const response=await fetch('http://127.0.0.1:'+process.env.CRABOT_MM_PORT+'/register',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({id:crypto.randomUUID(),source:${JSON.stringify(id)},method:'register',params:{module_id:${JSON.stringify(id)},module_type:'channel',version:'0.1.0',protocol_version:'0.1.0',port:Number(process.env.Crabot_PORT),subscriptions:[]}})});
          if(!(await response.json()).success)throw new Error('Finite extra module registration failed');fs.writeFileSync(${JSON.stringify(ready)},'ready')
        }catch(error){console.error(error);process.exit(1)}});setTimeout(()=>process.exit(0),${options.processLifetimeMs ?? 300000}).unref();`)
      manager.modules.set(id, { module_id: id, module_type: 'channel', entry: `"${process.execPath}" "${entry}"`, port,
        auto_start: false, auto_restart: false, start_priority: 2, skip_health_check: options.extraModule === 'tool', status: 'stopped' })
      if (options.extraModule !== 'inactive') {
        await manager.startModuleProcess(id)
        if (options.extraModule !== 'tool') await vi.waitFor(async () => expect(await fs.readFile(ready, 'utf8')).toBe('ready'), { timeout: 10000 })
      }
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
  } catch (error) {
    const registration = await fs.readFile(path.join(data, 'agent-ready.registration-failed'), 'utf8').catch(() => undefined)
    if (registration && ['UNAUTHORIZED', 'FORBIDDEN', 'INVALID_PARAMS', 'UNKNOWN'].includes(registration)) console.error('[Finite initial registration rejected]', { code: registration })
    await cleanup(); throw error
  }
}

async function verifyRegisteredRuntimeGate({ manager, dataDir, coordinator, preparation, modules, afterClose, python, pythonBinary }: any) {
  const recoveryRecords = require('../../scripts/lib/workspace-recovery-records.mjs'), runtimePlan = preparation.plan
  expect(typeof recoveryRecords.commitWorkspaceRecoveryRuntimeStart).toBe('function')
  const gate = require('../../scripts/lib/workspace-runtime-gate.mjs').createWorkspaceRuntimeGate(), idleModule = gate.child
  const idleModuleExit = once(idleModule, 'exit')
  let identity: any, execution: any
  const spies: Array<{ mockRestore(): void }> = []
  let output = '', errors = ''
  if (python) {
    idleModule.stdout.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4096) })
    idleModule.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4096) })
  }
  try {
    await gate.ready()
    identity = require('../../scripts/lib/spawned-process-tree.cjs').captureSpawnedProcessTree(idleModule).find((item: any) => item.pid === idleModule.pid)
    const planned = runtimePlan.modules[0]
    const runtimeRecord = await manager.runtimeRegistry.recordSpawn({ runtimeId: planned.runtime_id, moduleId: planned.module_id, rootPid: idleModule.pid, modulePort: modules.find((module: any) => module.module_id === planned.module_id).module_port })
    const marker = 'gate-module-' + runtimePlan.recovery_id
    const moduleMarker = path.join(dataDir, marker + '.json'), preloadMarker = path.join(dataDir, marker + '-preload'), preload = path.join(dataDir, marker + '-preload.cjs')
    const finishMarker = path.join(dataDir, marker + '-finish')
    await fs.writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)},'only actual module')`)
    const pythonProgram = `import json,os,pathlib,time,sys
receipt=json.loads(pathlib.Path(${JSON.stringify(path.join(coordinator.launch.control_root.path, 'runtime-starts', planned.module_id + '.json'))}).read_text(encoding='utf-8'))
assert receipt['process']['pid']==os.getppid() and receipt['runtime']['runtime_id']==os.environ['CRABOT_MODULE_RUNTIME_ID']
print('workspace-gate-python-stdout',flush=True)
print('workspace-gate-python-stderr',file=sys.stderr,flush=True)
pathlib.Path(${JSON.stringify(moduleMarker)}).write_text(json.dumps(dict(parent=os.getppid(),pid=os.getpid(),runtime=os.environ['CRABOT_MODULE_RUNTIME_ID'],token=os.environ['TEST_GATE_TOKEN'],executable=sys.executable,cwd=os.getcwd())),encoding='utf-8')
time.sleep(300)`
    const invocation = { command: python ?? process.execPath, args: python ? ['-I', '-B', '-c', pythonProgram] : ['-e', `require('node:fs').writeFileSync(${JSON.stringify(moduleMarker)},JSON.stringify({parent:process.ppid,pid:process.pid,runtime:process.env.CRABOT_MODULE_RUNTIME_ID,token:process.env.TEST_GATE_TOKEN}));if(${!afterClose})setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(finishMarker)}))process.exit(17)},20);setTimeout(()=>process.exit(0),300000)`],
      cwd: dataDir, env: { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)), CRABOT_MODULE_RUNTIME_ID: planned.runtime_id, TEST_GATE_TOKEN: 'private-gate-fixture-token', NODE_OPTIONS: '--require ' + preload } }
    if (python) for (const key of Object.keys(invocation.env)) if (key.toLowerCase() === 'path') invocation.env[key] = ''
    const input = { dataDir, recoveryId: preparation.plan.recovery_id, moduleId: planned.module_id, process: identity, runtime: runtimeRecord, definitionHash: sha256CanonicalJson(invocation), verify: preparation.verify }
    expect(recoveryRecords.readWorkspaceRecoveryRuntimeStart(dataDir, input.recoveryId, input.moduleId)).toBeNull()
    for (const damaged of [{ ...runtimeRecord, runtime_id: randomUUID() }, { ...runtimeRecord, root_pid: process.pid }, { ...runtimeRecord, module_port: 1 }, { ...runtimeRecord, unexpected: true }]) {
      await expect(recoveryRecords.commitWorkspaceRecoveryRuntimeStart({ ...input, runtime: damaged })).rejects.toBeDefined()
      expect(recoveryRecords.readWorkspaceRecoveryRuntimeStart(dataDir, input.recoveryId, input.moduleId)).toBeNull()
    }
    await expect(recoveryRecords.commitWorkspaceRecoveryRuntimeStart({ ...input, verify: async () => { throw new Error('test role revoked') } })).rejects.toBeDefined()
    const start = await recoveryRecords.commitWorkspaceRecoveryRuntimeStart(input)
    expect(start).toEqual({ schema_version: 1, recovery_id: input.recoveryId, plan_sha256: sha256CanonicalJson(runtimePlan), definition_sha256: input.definitionHash,
      parent: coordinator.launch.parent, process: identity, runtime: runtimeRecord, created_at: expect.any(String) })
    expect(recoveryRecords.readWorkspaceRecoveryRuntimeStart(dataDir, input.recoveryId, input.moduleId)).toEqual(start)
    await expect(recoveryRecords.commitWorkspaceRecoveryRuntimeStart(input)).rejects.toBeDefined()
    const startFile = path.join(coordinator.launch.control_root.path, 'runtime-starts', input.moduleId + '.json'), startBytes = await fs.readFile(startFile)
    for (const change of [null, { ...start, plan_sha256: '0'.repeat(64) }, { ...start, unexpected: true }]) {
      await fs.writeFile(startFile, JSON.stringify(change))
      expect(() => recoveryRecords.readWorkspaceRecoveryRuntimeStart(dataDir, input.recoveryId, input.moduleId)).toThrow()
      await fs.writeFile(startFile, startBytes)
    }
    expect(await fs.readFile(startFile)).toEqual(startBytes)
    expect(JSON.stringify(start)).not.toContain('fixture-human')
    expect(JSON.stringify(start)).not.toContain('private-gate-fixture-token')
    await expect(fs.lstat(moduleMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(preloadMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    const instanceFile = path.join(dataDir, 'module-runtime-registry/instance-id'), instanceBytes = await fs.readFile(instanceFile)
    await fs.writeFile(instanceFile, 'changed-instance-id')
    try { expect(() => recoveryRecords.verifyWorkspaceRecoveryRuntimeStart({ dataDir, recoveryId: input.recoveryId, moduleId: input.moduleId, recordHash: sha256CanonicalJson(start), definitionHash: input.definitionHash })).toThrow() }
    finally { await fs.writeFile(instanceFile, instanceBytes) }
    const gateInput = { dataDir, recoveryId: input.recoveryId, moduleId: input.moduleId, recordHash: sha256CanonicalJson(start), invocation,
      verify: preparation.verify, assertCurrent: () => { expect(recoveryRecords.readWorkspaceRecoveryRuntimePlan(dataDir, input.recoveryId)).toEqual(runtimePlan) } }
    const originalEmit = idleModule.emit.bind(idleModule), originalTimeout = global.setTimeout
    const sent = vi.spyOn(idleModule, 'send')
    const dropped = vi.spyOn(idleModule, 'emit').mockImplementation((event: string, ...args: any[]) => event === 'message' && args[0]?.kind === 'workspace_runtime_gate_started' ? true : originalEmit(event, ...args))
    const timeout = vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: number, ...args: any[]) => originalTimeout(callback, delay === 60000 ? 1500 : delay, ...args)) as any)
    spies.push(sent, dropped, timeout)
    const firstStart = gate.start(gateInput)
    expect(gate.start(gateInput)).toBe(firstStart)
    try { await expect(firstStart).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_RUNTIME_GATE' }) }
    finally { timeout.mockRestore() }
    await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(moduleMarker, 'utf8')).runtime).toBe(planned.runtime_id), { timeout: 15000 })
    const actual = JSON.parse(await fs.readFile(moduleMarker, 'utf8'))
    execution = require('../../scripts/lib/process-identity.cjs').inspectProcess(actual.pid)
    try { await expect(gate.observe()).resolves.toMatchObject({ kind: 'workspace_runtime_gate_observed', runtime_id: planned.runtime_id }) }
    finally { dropped.mockRestore() }
    expect(gate.start(gateInput)).toBe(firstStart)
    expect(sent.mock.calls.filter(([message]: any[]) => message?.kind === 'workspace_runtime_gate_start')).toHaveLength(1)
    expect(actual).toMatchObject({ parent: idleModule.pid, runtime: planned.runtime_id, token: 'private-gate-fixture-token' })
    if (python) {
      expect(await fs.realpath(actual.executable)).toBe(pythonBinary)
      expect(await fs.realpath(actual.cwd)).toBe(dataDir)
      await vi.waitFor(() => { expect(output).toContain('workspace-gate-python-stdout'); expect(errors).toContain('workspace-gate-python-stderr') })
      await expect(fs.lstat(preloadMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    } else expect(await fs.readFile(preloadMarker, 'utf8')).toBe('only actual module')
    expect(require('../../scripts/lib/process-identity.cjs').inspectProcess(actual.pid).parent).toBe(idleModule.pid)
    gate.close()
    expect(require('../../scripts/lib/process-identity.cjs').sameProcess(identity, require('../../scripts/lib/process-identity.cjs').inspectProcess(idleModule.pid))).toBe(true)
    sent.mockRestore()
    if (afterClose) await afterClose({ identity, start })
    else if (!python) {
      await fs.writeFile(finishMarker, 'finish this finite module')
      expect(await idleModuleExit).toEqual([17, null])
      await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([identity, execution]).state).toBe('stopped'), { timeout: 15000 })
      expect(recoveryRecords.readWorkspaceRecoveryRuntimeStart(dataDir, input.recoveryId, input.moduleId)).toEqual(start)
      expect((await manager.runtimeRegistry.listRecords()).find((record: any) => record.runtime_id === planned.runtime_id)).toEqual(runtimeRecord)
    }
  } finally {
    for (const spy of spies) spy.mockRestore()
    gate.close()
    if (identity) await require('../../scripts/lib/known-process-stop.cjs').stopKnownProcessScope([identity, execution].filter(Boolean), { timeoutMs: 100, onObserved: async () => {} })
    else await terminateProcessTree(idleModule.pid, { gracefulTimeoutMs: 0, forceImmediately: true })
    await idleModuleExit
    await manager.runtimeRegistry.removeRuntime(runtimePlan.modules[0].runtime_id)
  }
}

describe('workspace fixture mock ownership', () => {
  it('late cleanup cannot restore a later test mock', async () => {
    const f = await fixture(), currentTestName = expect.getState().currentTestName
    const target = { value: () => 1 }, spy = vi.spyOn(target, 'value')
    target.value()
    try {
      expect.setState({ currentTestName: 'a later test with its own mocks' })
      await f.cleanup()
      target.value()
      expect(spy).toHaveBeenCalledTimes(2)
    } finally { expect.setState({ currentTestName }); vi.restoreAllMocks() }
  }, 30000)
})

describe('registered workspace gate bundled Python', () => {
  it.runIf(!!process.env.CRABOT_WORKSPACE_GATE_PYTHON)('runs the actual bundled interpreter only after its own durable gate registration', async () => {
    const python = await fs.realpath(process.env.CRABOT_WORKSPACE_GATE_PYTHON!)
    expect(process.env.CRABOT_WORKSPACE_GATE_PYTHON_BINARY).toBeTruthy()
    const pythonBinary = await fs.realpath(process.env.CRABOT_WORKSPACE_GATE_PYTHON_BINARY!)
    expect(JSON.parse(execFileSync(python, ['-I', '-B', '-c', 'import json,sys;print(json.dumps(sys.version_info[:2]))'], { encoding: 'utf8', timeout: 15000 }))).toEqual([3, 12])
    const f = await fixture({ actualAgent: true, actualAdmin: true, validationHealth: 'healthy', processLifetimeMs: 300000 })
    const locks = require('../../scripts/lib/cli-lock.mjs'), records = require('../../scripts/lib/workspace-relocation-intent.mjs')
    const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    let cold: any, coordinator: any
    try {
      const prepared = await f.manager.prepareWorkspaceRelocationCompletion(f.params, 'fixture-human')
      const definitions = new Map([...f.manager.modules].map(([id, runtime]: any) => [id, { ...runtime }]))
      await f.manager.stop()
      const fence = records.readWorkspaceRelocationFinalizing(f.data, f.params.intent_id)
      const request = { intent_id: f.params.intent_id, recovery_id: randomUUID(), completion_sha256: prepared.completion_sha256, finalizing_sha256: sha256CanonicalJson(fence) }
      cold = new ModuleManager({ port: 0, modules: [], shutdown_timeout: 0.1 }, f.data) as any
      for (const [id, definition] of definitions as Map<string, any>) cold.modules.set(id, { ...definition, status: 'stopped', pid: undefined, auto_start: false })
      await cold.start(); cold.config.port = cold.server.address().port
      await fs.unlink(path.join(f.data, 'ready')); await cold.startModuleProcess('admin-web')
      await vi.waitFor(async () => expect(await fs.readFile(path.join(f.data, 'ready'), 'utf8')).toBe('ready'), { timeout: 10000 })
      coordinator = await cold.initializeWorkspaceRelocationRecovery(request, 'fixture-human')
      const preparation = await cold.prepareWorkspaceRecoveryRuntimes(request, 'fixture-human')
      await verifyRegisteredRuntimeGate({ manager: cold, dataDir: f.data, coordinator, preparation, modules: records.readWorkspaceRelocationArchivedState(f.data, f.params.intent_id).modules.modules, python, pythonBinary })
      expect(records.readWorkspaceRelocationFinalizing(f.data, f.params.intent_id)).toEqual(fence)
    } finally {
      coordinator?.close()
      await cold?.stop()
      locks.releaseCliLock(lock)
      await f.cleanup()
    }
  }, process.platform === 'win32' ? 600000 : 240000)
})

describe('MM owns the initial workspace migration job', () => {
  const timeout = process.platform === 'win32' ? 180000 : 60000
  async function initial(withAgent = true) {
    const f = await fixture({ actualAdmin: true, actualAgent: withAgent, processLifetimeMs: 180000 })
    await fs.rename(path.join(f.data, 'workspace-control/relocation-active'), path.join(f.data, 'retained-initial-fixture'))
    const params = { intent_id: randomUUID(), target: path.join(f.root, 'owned-job-target'), expected_revision: 1, confirmed: true as const }
    return { ...f, start: params }
  }
  it.each(['concurrent confirmation', 'login revoked after acceptance'])('keeps one owned driver and original stop authority: %s', async mode => {
    const f = await initial(), records = require('../../scripts/lib/workspace-relocation-intent.mjs')
    try {
      expect(typeof f.manager.startWorkspaceRelocation).toBe('function')
      const launch = vi.spyOn(f.manager, 'launchWorkspaceRelocationCoordinator')
      const workerStop = vi.spyOn(f.manager, 'stopWorkspaceRelocationWorkersForCoordinator')
      const moduleStop = vi.spyOn(f.manager, 'requestWorkspaceRelocationModuleStops').mockRejectedValue(new Error('finite module stop boundary'))
      if (mode === 'login revoked after acceptance') {
        const mark = f.manager.markWorkspaceRelocationAccepted.bind(f.manager)
        vi.spyOn(f.manager, 'markWorkspaceRelocationAccepted').mockImplementation((request: any) => {
          mark(request); require('node:fs').writeFileSync(path.join(f.data, 'human-revoked'), 'revoked')
        })
      }
      const first = f.manager.startWorkspaceRelocation(f.start, 'fixture-human')
      const replies = mode === 'concurrent confirmation' ? await Promise.all([first, f.manager.startWorkspaceRelocation({ ...f.start }, 'fixture-human')]) : [await first]
      expect(replies.every(reply => JSON.stringify(reply) === JSON.stringify({ intent_id: f.start.intent_id, accepted: true }))).toBe(true)
      const job = f.manager.workspaceInitialJob
      expect(job).toBeDefined()
      await job.completion
      expect(job.phase).toBe('needs_attention')
      expect(launch).toHaveBeenCalledTimes(1); expect(workerStop).toHaveBeenCalledTimes(1); expect(moduleStop).toHaveBeenCalledTimes(1)
      const coordinator = records.readWorkspaceRelocationCoordinator(f.data, f.start.intent_id)
      expect(coordinator.ready).not.toBeNull()
      expect(records.readWorkspaceRelocationStops(f.data, f.start.intent_id).submission?.results).toHaveLength(1)
      expect(records.readWorkspaceRelocationExecutionExit(f.data, f.start.intent_id)).toBeNull()
      await expect(fs.stat(f.start.target)).rejects.toMatchObject({ code: 'ENOENT' })
      if (mode === 'login revoked after acceptance') await expect(f.manager.startWorkspaceRelocation(f.start, 'fixture-human')).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      else await expect(f.manager.startWorkspaceRelocation({ ...f.start, target: path.join(f.root, 'changed') }, 'fixture-human')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(launch).toHaveBeenCalledTimes(1)
    } finally { await f.cleanup() }
  }, timeout)
  it('observes the actual current coordinator without turning unknown ownership or a failed stop into running success', async () => {
    const f = await initial(), native = require('../../scripts/lib/process-identity.cjs')
    const { HttpClient, WorkspaceClient } = require('../../crabot-client/dist/index.js')
    const sdk = new WorkspaceClient(new HttpClient({ endpoint: `http://127.0.0.1:${f.port}/api`, token: () => 'fixture-human' }))
    let entered!: () => void, release!: () => void
    const stopping = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const moduleStop = vi.spyOn(f.manager, 'requestWorkspaceRelocationModuleStops').mockImplementation(async () => { entered(); await held; throw new Error('finite stop boundary') })
    try {
      expect(await f.manager.startWorkspaceRelocation(f.start, 'fixture-human')).toEqual({ intent_id: f.start.intent_id, accepted: true })
      await stopping
      const expected = { available: true, job: { intent_id: f.start.intent_id, state: 'running', stage: 'stopping', source: path.join(f.data, 'workspaces'), target: f.start.target } }
      expect(await sdk.currentRelocation()).toEqual(expected)
      expect(await sdk.relocationStatus(f.start.intent_id)).toEqual(expected)
      const actual = native.inspectProcess, owner = f.manager.workspaceInitialJob.coordinator.child.pid
      const unknown = vi.spyOn(native, 'inspectProcess').mockImplementation((pid: number) => { if (pid === owner) throw new Error('finite unknown coordinator identity'); return actual(pid) })
      try { expect(await sdk.currentRelocation()).toEqual({ available: false, job: null }) }
      finally { unknown.mockRestore() }
      release(); await f.manager.workspaceInitialJob.completion
      expect(await sdk.currentRelocation()).toEqual({ ...expected, job: { ...expected.job, state: 'needs_attention' } })
      expect(moduleStop).toHaveBeenCalledTimes(1)
      await expect(fs.stat(f.start.target)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { release(); await f.manager.workspaceInitialJob?.completion; await f.cleanup() }
  }, timeout)
  it.each(['revoked human', 'Agent stopped'])('rechecks readiness after waiting for the original lock: %s', async mode => {
    const f = await initial(), locks = require('../../scripts/lib/cli-lock.mjs')
    const held = await locks.acquireCliLock(f.data, 'finite competing operation')
    let pending: Promise<unknown> | undefined
    try {
      const originalVerify = f.manager.verifyWorkspaceRelocationStartRequest.bind(f.manager)
      let firstVerification: Promise<unknown> | undefined
      const verify = vi.spyOn(f.manager, 'verifyWorkspaceRelocationStartRequest').mockImplementationOnce((...args: any[]) => {
        firstVerification = originalVerify(...args).then(async (result: unknown) => {
          await new Promise(resolve => setTimeout(resolve, 1100)) // Admission can exceed the former one-second observation window.
          return result
        })
        return firstVerification
      })
      pending = f.manager.startWorkspaceRelocation(f.start, 'fixture-human')
      const rejected = expect(pending).rejects.toMatchObject({ code: mode === 'revoked human' ? 'UNAUTHORIZED' : 'SERVICE_UNAVAILABLE' })
      void rejected.catch(() => {})
      expect(firstVerification).toBeDefined()
      await firstVerification
      await vi.waitFor(() => expect(f.manager.workspaceInitialJob?.phase).toBe('preparing'))
      expect(verify).toHaveBeenCalledTimes(1)
      expect(locks.cliLockToken(held)).toBeDefined()
      if (mode === 'revoked human') await fs.writeFile(path.join(f.data, 'human-revoked'), 'revoked')
      else f.manager.modules.get('crabot-agent').status = 'stopped'
      locks.releaseCliLock(held)
      await rejected
      expect(verify).toHaveBeenCalledTimes(2)
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(locks.cliLockToken(held)).toBeUndefined()
    } finally { locks.releaseCliLock(held); await pending?.catch(() => {}); await f.cleanup() }
  }, timeout)
  it('treats the current directory as unchanged without an intent or coordinator', async () => {
    const f = await initial()
    try {
      expect(typeof f.manager.startWorkspaceRelocation).toBe('function')
      expect(await f.manager.startWorkspaceRelocation({ ...f.start, target: path.join(f.data, 'workspaces') }, 'fixture-human')).toEqual({ unchanged: true, source: path.join(f.data, 'workspaces') })
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(require('../../scripts/lib/cli-lock.mjs').cliLockToken(path.join(f.data, 'cli.lock'))).toBeUndefined()
    } finally { await f.cleanup() }
  }, timeout)
  it.each(['workspaceRecoveryAdmission', 'workspaceRecoveryInitialization', 'workspaceRecoveryFinalizationGrant', 'workspaceFinalizationGrant'])('refuses another initial job while its original %s is still settling', async key => {
    const f = await initial()
    try {
      f.manager[key] = { revoked: true }
      await expect(f.manager.startWorkspaceRelocation(f.start, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(f.manager.workspaceInitialJob).toBeUndefined()
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.stat(f.start.target)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { f.manager[key] = undefined; await f.cleanup() }
  }, timeout)
  it.runIf(process.env.GITHUB_ACTIONS === 'true')('completes two actually owned initial jobs and reopens original Web without reviving old work', async () => {
    const jobBudget = process.platform === 'win32' ? 600000 : 240000
    const f = await fixture({ actualAdmin: true, actualAgent: true, validationHealth: 'healthy', extraModule: 'running', processLifetimeMs: jobBudget * 2 + 60000 })
    const records = require('../../scripts/lib/workspace-relocation-intent.mjs'), native = require('../../scripts/lib/process-identity.cjs')
    try {
      expect(typeof native.renameFileNoReplace).toBe('function')
      await fs.rename(path.join(f.data, 'workspace-control/relocation-active'), path.join(f.data, 'retained-initial-fixture'))
      const catalog = new WorkspaceCatalog({ dataRoot: f.data, files: native })
      const { HttpClient, WorkspaceClient } = require('../../crabot-client/dist/index.js')
      const sdk = new WorkspaceClient(new HttpClient({ endpoint: `http://127.0.0.1:${f.port}/api`, token: () => 'fixture-human' }))
      for (const round of [1, 2]) {
        const before = await catalog.snapshot(), request = { intent_id: randomUUID(), target: round === 2 ? path.join(f.data, 'workspaces') : path.join(f.root, 'owned-success-' + round), expected_revision: before.revision, confirmed: true as const }
        const accepted = await sdk.startRelocation(request)
        expect(accepted).toEqual({ intent_id: request.intent_id, accepted: true })
        const job = f.manager.workspaceInitialJob
        await job.completion
        expect(job.phase).toBe('completed')
        expect(records.readWorkspaceRelocationJobStatus(f.data, request.intent_id).job.state).toBe('committed')
        expect((await sdk.relocationStatus(request.intent_id)).job).toMatchObject({ state: 'completed', stage: 'finished' })
        expect((await catalog.snapshot()).storage_root).toBe(request.target)
        expect(records.readWorkspaceRelocationReleased(f.data, request.intent_id)).not.toBeNull()
        expect(require('../../scripts/lib/workspace-maintenance.cjs').workspaceMaintenancePending(f.data)).toBe(false)
        const archived = records.readWorkspaceRelocationArchivedState(f.data, request.intent_id)
        expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([archived.launch.process]).state).toBe('stopped')
        expect(f.manager.modules.get('fixture-channel').status).toBe('running')
        const create = await fetch(`http://127.0.0.1:${f.port}/api/workspaces`, { method: 'POST', headers: { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: randomUUID(), name: 'After owned migration ' + round }) })
        const project = await create.json() as any
        expect(create.status, JSON.stringify(project)).toBe(200)
        expect(project.workspace.root.startsWith(path.join(request.target, 'projects') + path.sep)).toBe(true)
        const ledger = JSON.parse(await fs.readFile(path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), 'utf8'))
        expect(ledger.workers.length).toBeGreaterThan(0)
        expect(ledger.workers.every((worker: any) => worker.task.status === 'closed')).toBe(true)
      }
    } finally { await f.cleanup() }
  }, 2 * (process.platform === 'win32' ? 600000 : 240000))
  it.each(['no human', 'no Agent', 'private destination', 'old catalog'])('refuses before creating an intent: %s', async mode => {
    const f = await initial(mode !== 'no Agent')
    try {
      expect(typeof f.manager.startWorkspaceRelocation).toBe('function')
      const params = { ...f.start, ...(mode === 'private destination' ? { target: path.join(f.data, 'private-target') } : {}), ...(mode === 'old catalog' ? { expected_revision: 100 } : {}) }
      await expect(f.manager.startWorkspaceRelocation(params, mode === 'no human' ? undefined : 'fixture-human')).rejects.toBeDefined()
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.stat(params.target)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(require('../../scripts/lib/cli-lock.mjs').cliLockToken(path.join(f.data, 'cli.lock'))).toBeUndefined()
    } finally { await f.cleanup() }
  }, timeout)
})

describe('same MM workspace recovery and later migration', () => {
  const budget = process.platform === 'win32' ? 600000 : 240000
  it.runIf(process.env.GITHUB_ACTIONS === 'true')('recovers a failed owned job then performs a new migration in that same MM', async () => {
    const f = await fixture({ actualAdmin: true, actualAgent: true, validationHealth: 'healthy', extraModule: 'running', processLifetimeMs: budget * 3 + 60000 })
    const records = require('../../scripts/lib/workspace-relocation-intent.mjs'), native = require('../../scripts/lib/process-identity.cjs')
    try {
      expect(typeof native.renameFileNoReplace).toBe('function')
      await fs.rename(path.join(f.data, 'workspace-control/relocation-active'), path.join(f.data, 'retained-initial-fixture'))
      const catalog = new WorkspaceCatalog({ dataRoot: f.data, files: native }), first = { intent_id: randomUUID(), target: path.join(f.root, 'recover-in-place'), expected_revision: (await catalog.snapshot()).revision, confirmed: true as const }
      const { HttpClient, WorkspaceClient } = require('../../crabot-client/dist/index.js')
      const sdk = new WorkspaceClient(new HttpClient({ endpoint: `http://127.0.0.1:${f.port}/api`, token: () => 'fixture-human' }))
      const originalRpc = f.manager.withCurrentAdminRpc.bind(f.manager)
      let injected = false
      const corrupt = vi.spyOn(f.manager, 'withCurrentAdminRpc').mockImplementation((timeout: number, action: any) => originalRpc(timeout, (rpc: any, verify: any) => action({ ...rpc,
        call: async (method: string, ...args: any[]) => {
          const response = await rpc.call(method, ...args)
          if (method === 'prepare_workspace_relocation_completion' && !injected) { injected = true; return { ...response, unexpected: true } }
          return response
        },
      }, verify)))
      try {
        expect(await sdk.startRelocation(first)).toEqual({ intent_id: first.intent_id, accepted: true })
        await f.manager.workspaceInitialJob.completion
      } finally { corrupt.mockRestore() }
      expect(injected).toBe(true); expect(f.manager.workspaceInitialJob.phase).toBe('needs_attention')
      expect(f.manager.workspaceFinalizationCompletion).toBeDefined()
      const fence = records.readWorkspaceRelocationFinalizing(f.data, first.intent_id), archived = records.readWorkspaceRelocationArchivedState(f.data, first.intent_id)
      expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([archived.launch.process]).state).toBe('stopped')
      const request = { intent_id: first.intent_id, recovery_id: randomUUID(), completion_sha256: sha256CanonicalJson(archived.completion), finalizing_sha256: sha256CanonicalJson(fence) }
      expect(await sdk.previewRelocationRecovery(first.intent_id)).toEqual({ available: true, recovery: {
        intent_id: request.intent_id, completion_sha256: request.completion_sha256, finalizing_sha256: request.finalizing_sha256,
      } })
      const confirmation = { ...request, confirmed: true }
      const receipts = await Promise.all([sdk.startRelocationRecovery(confirmation), sdk.startRelocationRecovery({ ...confirmation })])
      expect(receipts).toEqual([{ intent_id: first.intent_id, recovery_id: request.recovery_id, accepted: true }, { intent_id: first.intent_id, recovery_id: request.recovery_id, accepted: true }])
      expect(await f.manager.workspaceRecoveryCompletions.get(request.recovery_id).pending).toMatchObject({ resumed: true, ...request })
      expect(f.manager.workspaceInitialJob.phase).toBe('completed')
      expect((await sdk.relocationStatus(first.intent_id)).job).toMatchObject({ state: 'completed', stage: 'finished' })
      expect((await catalog.snapshot()).storage_root).toBe(first.target)
      const next = { intent_id: randomUUID(), target: path.join(f.data, 'workspaces'), expected_revision: (await catalog.snapshot()).revision, confirmed: true as const }
      expect(await sdk.startRelocation(next)).toEqual({ intent_id: next.intent_id, accepted: true })
      await f.manager.workspaceInitialJob.completion
      expect(f.manager.workspaceInitialJob.phase).toBe('completed')
      expect((await sdk.currentRelocation()).job).toMatchObject({ intent_id: next.intent_id, state: 'completed', stage: 'finished' })
      expect((await catalog.snapshot()).storage_root).toBe(next.target)
      expect(f.manager.modules.get('fixture-channel').status).toBe('running')
      const ledger = JSON.parse(await fs.readFile(path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), 'utf8'))
      expect(ledger.workers.length).toBeGreaterThan(0); expect(ledger.workers.every((worker: any) => worker.task.status === 'closed')).toBe(true)
      for (const id of [first.intent_id, next.intent_id]) {
        expect(records.readWorkspaceRelocationReleased(f.data, id)).not.toBeNull()
        expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([records.readWorkspaceRelocationArchivedState(f.data, id).launch.process]).state).toBe('stopped')
      }
      expect(require('../../scripts/lib/workspace-maintenance.cjs').workspaceMaintenancePending(f.data)).toBe(false)
    } finally { await f.cleanup() }
  }, budget * 3)
})

describe('finite cold terminal diagnostics', () => {
  it('preserves cached Promises and records no arguments, paths or credentials', async () => {
    const events = new (require('node:events').EventEmitter)(), pending = Promise.resolve('unchanged')
    events.send = vi.fn((_message: any, callback?: () => void) => { callback?.(); return true })
    const cold = Object.fromEntries(['releaseWorkspaceRecoveryCompletion', 'prepareWorkspaceRecoveryCompletion', 'beginWorkspaceRecoveryCompletionObservation', 'restoreWorkspaceModules'].map(key => [key, () => pending]))
    const grant = { phase: 'prepared', verifyHealth: () => pending, verify: () => {} }, logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    const stop = observeColdTerminalProgress(cold, { child: events }, grant)
    try {
      expect(cold.releaseWorkspaceRecoveryCompletion('private-monitor-secret', '/private-monitor-path')).toBe(pending)
      expect(grant.verifyHealth()).toBe(pending)
      events.send({ kind: 'workspace_recovery_release', credential: 'private-monitor-secret', path: '/private-monitor-path' })
      events.emit('message', { kind: 'workspace_recovery_released', credential: 'private-monitor-secret' })
      await pending
    } finally { stop() }
    const output = JSON.stringify(logs.mock.calls)
    expect(output).toContain('workspace_recovery_release'); expect(output).not.toContain('private-monitor-secret'); expect(output).not.toContain('/private-monitor-path')
    expect(events.listenerCount('message')).toBe(0)
    logs.mockRestore()
  })
})

describe('actual Admin recovery RPC observer', () => {
  it('keeps the actual body reader working and records only selected wire bodies with header presence', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'crabot-admin-observer-')))
    const callsFile = path.join(root, 'calls.json'), script = path.join(root, 'observer.cjs'), secret = 'finite-observer-header-only'
    await fs.writeFile(callsFile, '[]')
    await fs.writeFile(script, `${observeActualAdminRecoveryRpc(callsFile)}
      const http=require('node:http'),{default:Admin}=require(${JSON.stringify(path.resolve('../crabot-admin/dist/index.js'))});
      const admin=Object.create(Admin.prototype);admin.methodHandlers=new Map(
        ['/prepare_workspace_relocation_recovery_completion','/resume_workspace_relocation_recovery_web','/unobserved_read'].map(method=>[method.slice(1),(params,context)=>({received:params.marker,header:context.authorizationBearer===${JSON.stringify(secret)}})]));
      const server=http.createServer((req,res)=>admin.handleRequest(req,res));server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
      process.on('message',()=>server.close(()=>process.exit(0)));setTimeout(()=>process.exit(1),30000).unref();`)
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }), ended = once(child, 'exit')
    try {
      const [ready] = await Promise.race([once(child, 'message'), ended.then(() => { throw new Error('Finite observer exited before readiness') })])
      for (const method of ['prepare_workspace_relocation_recovery_completion', 'resume_workspace_relocation_recovery_web', 'unobserved_read']) {
        const response = await fetch(`http://127.0.0.1:${ready.port}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret },
          body: JSON.stringify({ id: randomUUID(), source: 'finite-observer', method, params: { marker: method } }) })
        expect(await response.json()).toMatchObject({ success: true, data: { received: method, header: true } })
      }
      const observed = JSON.parse(await fs.readFile(callsFile, 'utf8'))
      expect(observed.map((item: any) => item.method)).toEqual(['/prepare_workspace_relocation_recovery_completion', '/resume_workspace_relocation_recovery_web'])
      expect(observed.every((item: any) => item.authorization === 'present' && item.body.params.marker === item.method.slice(1))).toBe(true)
      expect(JSON.stringify(observed)).not.toContain(secret)
    } finally { if (child.connected) child.send('finish'); await ended; await fs.rm(root, { recursive: true, force: true }) }
  }, process.platform === 'win32' ? 120000 : 30000)
})

describe('MM reads workspace job status under the current human identity', () => {
  it.each(['actual Admin', 'no human', 'wrong runtime', 'false', 'extra', 'hash', 'bad query'])('observes only original stored facts without effects: %s', async mode => {
    const f = await fixture({ actualAdmin: ['actual Admin', 'bad query'].includes(mode), wrongRuntime: mode === 'wrong runtime', result: mode })
    const file = path.join(f.data, 'workspace-control/relocation-active/relocation.json'), bytes = await fs.readFile(file)
    try {
      const params = mode === 'bad query' ? { source: 'admin-web' } : {}
      const observed = f.manager.getWorkspaceRelocationStatus(params, mode === 'no human' ? undefined : 'fixture-human')
      if (mode === 'actual Admin') {
        expect(await observed).toEqual({ available: true, job: { intent_id: f.params.intent_id, state: 'needs_attention', stage: 'unknown', source: path.join(f.data, 'workspaces'), target: path.join(f.root, 'relocated') } })
        expect(await f.manager.getWorkspaceRelocationStatus({ intent_id: randomUUID() }, 'fixture-human')).toEqual({ available: true, job: null })
        const other = randomUUID()
        f.manager.workspaceInitialJob = { request: { intent_id: other }, proof: { intent_id: other }, phase: 'completed', stage: 'finished' }
        try { expect((await f.manager.getWorkspaceRelocationStatus({}, 'fixture-human')).job?.intent_id).toBe(f.params.intent_id) }
        finally { f.manager.workspaceInitialJob = undefined }
        expect((await f.calls()).every((item: any) => ['/get_runtime_identity', '/verify_workspace_relocation_job_query'].includes(item.method))).toBe(true)
      } else await expect(observed).rejects.toMatchObject({ code: mode === 'no human' ? 'UNAUTHORIZED' : mode === 'bad query' ? 'INVALID_PARAMS' : 'SERVICE_UNAVAILABLE' })
      if (mode === 'wrong runtime') expect((await f.calls()).every((item: any) => !item.authorization)).toBe(true)
      expect(JSON.stringify((await f.calls()).map((item: any) => item.body))).not.toContain('fixture-human')
      expect(await fs.readFile(file)).toEqual(bytes)
      expect(f.manager.workspaceInitialJob).toBeUndefined(); expect(f.manager.workspaceStopSequence).toBeUndefined()
      expect(require('../../scripts/lib/cli-lock.mjs').cliLockToken(path.join(f.data, 'cli.lock'))).toBeUndefined()
    } finally { await f.cleanup() }
  }, process.platform === 'win32' ? 120000 : 30000)
})

describe('MM reads workspace recovery handoff under current human authority', () => {
  const timeout = process.platform === 'win32' ? 120000 : 30000
  it('previews without creating roles or files, and preserves unknown facts', async () => {
    const f = await fixture({ actualAdmin: true })
    const file = path.join(f.data, 'workspace-control/relocation-active/relocation.json'), before = await fs.readFile(file)
    try {
      expect(await f.manager.previewWorkspaceRelocationRecovery({ intent_id: f.params.intent_id }, 'fixture-human')).toEqual({ available: true, recovery: null })
      expect(f.manager.workspaceRecoveryAdmissionPreparation).toBeUndefined(); expect(f.manager.workspaceRecoveryInitializations.size).toBe(0)
      expect(f.manager.workspaceRecoveryReceipts.size).toBe(0)
      expect(require('../../scripts/lib/cli-lock.mjs').cliLockToken(path.join(f.data, 'cli.lock'))).toBeUndefined()
      expect(await fs.readFile(file)).toEqual(before)
      await fs.writeFile(file, 'unverifiable original fact')
      expect(await f.manager.previewWorkspaceRelocationRecovery({ intent_id: f.params.intent_id }, 'fixture-human')).toEqual({ available: false, recovery: null })
      await expect(f.manager.previewWorkspaceRelocationRecovery({}, 'fixture-human')).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    } finally { await fs.writeFile(file, before); await f.cleanup() }
  }, timeout)
  it('offers only the complete original archive after its actual coordinator has exited', async () => {
    const f = await fixture({ actualAdmin: true, actualAgent: true, validationHealth: 'healthy', processLifetimeMs: 180000 })
    const records = require('../../scripts/lib/workspace-relocation-intent.mjs'), locks = require('../../scripts/lib/cli-lock.mjs')
    const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    try {
      await f.manager.prepareWorkspaceRelocationCompletion(f.params, 'fixture-human')
      const grant = f.manager.workspaceFinalizationGrant
      const fence = records.readWorkspaceRelocationFinalizing(f.data, f.params.intent_id), archive = records.readWorkspaceRelocationArchivedState(f.data, f.params.intent_id)
      expect(await f.manager.previewWorkspaceRelocationRecovery({ intent_id: f.params.intent_id }, 'fixture-human')).toEqual({ available: true, recovery: null })
      // Retire the failed normal role while retaining its real process until it is closed.
      grant.revoked = true
      expect(await f.manager.previewWorkspaceRelocationRecovery({ intent_id: f.params.intent_id }, 'fixture-human')).toEqual({ available: false, recovery: null })
      grant.close(); await f.manager.closeWorkspaceCoordinatorChannel(grant.child)
      expect(await f.manager.previewWorkspaceRelocationRecovery({ intent_id: f.params.intent_id }, 'fixture-human')).toEqual({ available: true, recovery: {
        intent_id: f.params.intent_id, completion_sha256: sha256CanonicalJson(archive.completion), finalizing_sha256: sha256CanonicalJson(fence),
      } })
      expect(records.readWorkspaceRelocationFinalizing(f.data, f.params.intent_id)).toEqual(fence)
      expect(f.manager.workspaceRecoveryAdmissionPreparation).toBeUndefined(); expect(f.manager.workspaceRecoveryInitializations.size).toBe(0)
    } finally { locks.releaseCliLock(lock); await f.cleanup() }
  }, process.platform === 'win32' ? 180000 : 60000)
  it('shares one initialized receipt, rechecks each current human and leaves its driver independent', async () => {
    const f = await fixture({ actualAdmin: true })
    const request = { intent_id: f.params.intent_id, recovery_id: randomUUID(), completion_sha256: 'a'.repeat(64), finalizing_sha256: 'b'.repeat(64), confirmed: true }
    let initialize!: () => void, complete!: () => void, entered!: () => void
    const initialized = new Promise<void>(resolve => { initialize = resolve }), finished = new Promise<void>(resolve => { complete = resolve })
    const entering = new Promise<void>(resolve => { entered = resolve })
    const verifyHuman = f.manager.verifyWorkspaceRelocationJobQuery.bind(f.manager)
    let admissions = 0
    const verify = vi.spyOn(f.manager, 'verifyWorkspaceRelocationJobQuery').mockImplementation(async (...args: any[]) => {
      const result = await verifyHuman(...args)
      // Both real human admissions exceed the former one-second observation window.
      if (++admissions <= 2) await new Promise(resolve => setTimeout(resolve, 1100))
      return result
    })
    const coordinator = { verify: vi.fn(async () => {}) }
    const init = vi.spyOn(f.manager, 'initializeWorkspaceRelocationRecovery').mockImplementation(async () => { entered(); await initialized; return coordinator })
    const driver = vi.spyOn(f.manager, 'completeWorkspaceRecovery').mockImplementation(() => finished)
    let first: Promise<any> | undefined, second: Promise<any> | undefined
    try {
      first = f.manager.startWorkspaceRelocationRecovery(request, 'fixture-human')
      second = f.manager.startWorkspaceRelocationRecovery({ ...request }, 'fixture-human')
      await Promise.race([entering, first])
      expect(init).toHaveBeenCalledOnce()
      expect(driver).not.toHaveBeenCalled(); initialize()
      const expected = { intent_id: request.intent_id, recovery_id: request.recovery_id, accepted: true }
      expect(await first).toEqual(expected); expect(await second).toBe(await first)
      expect(admissions).toBe(2)
      expect(driver).toHaveBeenCalledOnce(); expect(driver).toHaveBeenCalledWith(expect.not.objectContaining({ confirmed: true }), 'fixture-human')
      expect(coordinator.verify).toHaveBeenCalledOnce()
      await expect(f.manager.startWorkspaceRelocationRecovery({ ...request, completion_sha256: 'c'.repeat(64) }, 'fixture-human')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await fs.writeFile(path.join(f.data, 'human-revoked'), 'revoked')
      await expect(f.manager.startWorkspaceRelocationRecovery(request, 'fixture-human')).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(init).toHaveBeenCalledOnce(); expect(driver).toHaveBeenCalledOnce(); expect(verify).toHaveBeenCalledTimes(4)
    } finally { initialize(); complete(); await Promise.allSettled([first, second].filter(Boolean)); await f.cleanup() }
  }, timeout)
  it('rejects missing identity before parsing and unknown initialization without replay', async () => {
    const f = await fixture({ actualAdmin: true })
    const request = { intent_id: f.params.intent_id, recovery_id: randomUUID(), completion_sha256: 'a'.repeat(64), finalizing_sha256: 'b'.repeat(64), confirmed: true }
    const init = vi.spyOn(f.manager, 'initializeWorkspaceRelocationRecovery').mockRejectedValue(new Error('finite unknown initialization'))
    const driver = vi.spyOn(f.manager, 'completeWorkspaceRecovery')
    try {
      await expect(f.manager.startWorkspaceRelocationRecovery(null)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      await expect(f.manager.startWorkspaceRelocationRecovery({ ...request, confirmed: false }, 'fixture-human')).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
      expect(init).not.toHaveBeenCalled()
      const first = f.manager.startWorkspaceRelocationRecovery(request, 'fixture-human')
      await expect(first).rejects.toThrow('finite unknown initialization')
      await expect(f.manager.startWorkspaceRelocationRecovery(request, 'fixture-human')).rejects.toThrow('finite unknown initialization')
      expect(init).toHaveBeenCalledOnce(); expect(driver).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  }, timeout)
})

describe('MM verifies an initial workspace request without creating an intent', () => {
  const timeout = process.platform === 'win32' ? 120000 : 30000
  it.each(['actual Admin', 'no human', 'wrong runtime', 'false', 'extra', 'hash'])('uses only the current fixed Admin and retains all files: %s', async mode => {
    const f = await fixture({ actualAdmin: mode === 'actual Admin', wrongRuntime: mode === 'wrong runtime', result: mode })
    const active = path.join(f.data, 'workspace-control/relocation-active'), retained = path.join(f.data, 'retained-initial-fixture')
    const before = await fs.readFile(path.join(active, 'relocation.json'))
    const params = { intent_id: randomUUID(), target: path.join(f.root, 'initial-target'), expected_revision: 1, confirmed: true as const }
    const bearer = mode === 'no human' ? undefined : 'fixture-human'
    try {
      await fs.rename(active, retained)
      const runtimes = await f.manager.runtimeRegistry.listRecords(), child = f.manager.processes.get('admin-web')
      const request = f.manager.verifyWorkspaceRelocationStartRequest(params, bearer)
      if (mode === 'actual Admin') await expect(request).resolves.toEqual({ verified: true, ...params })
      else await expect(request).rejects.toMatchObject({ code: mode === 'no human' ? 'UNAUTHORIZED' : 'SERVICE_UNAVAILABLE' })
      const calls = await f.calls()
      if (mode === 'actual Admin') expect(calls.map(item => item.method)).toEqual(['/get_runtime_identity', '/verify_workspace_relocation_start'])
      if (mode === 'no human') expect(calls).toEqual([])
      if (mode === 'wrong runtime') expect(calls.every(item => !item.authorization)).toBe(true)
      expect(JSON.stringify(calls.map(item => item.body))).not.toContain('fixture-human')
      expect(await f.manager.runtimeRegistry.listRecords()).toEqual(runtimes)
      expect(f.manager.processes.get('admin-web')).toBe(child); expect(child.exitCode).toBeNull()
      expect(await fs.readFile(path.join(retained, 'relocation.json'))).toEqual(before)
      await expect(fs.stat(active)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(fs.stat(params.target)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(f.manager.workspaceCoordinatorGrant).toBeUndefined()
    } finally { await f.cleanup() }
  }, timeout)
})

describe('MM consumes a human intent proof only from its current Admin runtime', () => {
  it('retains the actual Web request body across authentication without diagnostic listeners consuming it', async () => {
    const f = await fixture({ actualAdmin: true })
    try {
      const response = await fetch(`http://127.0.0.1:${f.port}/api/auth/change-password`, { method: 'POST',
        headers: { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }, body: JSON.stringify({ new_password: 'finite-fixture-only' }) })
      // Valid body reaches the real handler; this isolated constructor has no credentials to change.
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: 'ADMIN_SERVER_NOT_INITIALIZED' })
    } finally { await f.cleanup() }
  }, process.platform === 'win32' ? 120000 : 30000)

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
      if (kind === 'private receipt damaged') await fs.writeFile(path.join(f.data, 'workspace-control/relocation-active/relocation-coordinator-ready.json'), '{}')
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
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active/relocation-workers.json'))).rejects.toMatchObject({ code: 'ENOENT' })
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
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active/relocation-workers.json'))).rejects.toMatchObject({ code: 'ENOENT' })
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
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active/relocation-stop-attempt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
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
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active/relocation-workers.json'))).rejects.toMatchObject({ code: 'ENOENT' })
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
      const file = path.join(f.data, 'workspace-control/relocation-active/relocation-workers.json'), original = JSON.parse(await fs.readFile(file, 'utf8'))
      await fs.writeFile(file, JSON.stringify({ ...original, created_at: new Date(Date.parse(original.created_at) + 1000).toISOString() }))
      await expect(f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect((await agentCalls(f.data)).some(call => call.method === 'capture_workspace_relocation_processes')).toBe(false)
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active/relocation-worker-processes.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await c.cleanup(); await f.cleanup() }
  }, 30000)
  for (const result of ['lost-process-reply', 'extra-process-reply', 'bad-process-reply']) it('keeps the first failure without recapturing after an unverifiable actual Agent reply: ' + result, async () => {
    const f = await fixture({ actualAgent: true, agentResult: result }), c = await coordinator(f)
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await expect(f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      await expect(f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect((await agentCalls(f.data)).filter(call => call.method === 'capture_workspace_relocation_processes')).toHaveLength(1)
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active/relocation-worker-processes.json'))).rejects.toMatchObject({ code: 'ENOENT' })
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
      const file = path.join(f.data, 'workspace-control/relocation-active/relocation-workers.json'), original = JSON.parse(await fs.readFile(file, 'utf8'))
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
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active/relocation-worker-processes.json'))).rejects.toMatchObject({ code: 'ENOENT' })
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
      const file = path.join(f.data, 'workspace-control/relocation-active/relocation-worker-processes.json'), original = JSON.parse(await fs.readFile(file, 'utf8'))
      await fs.writeFile(file, JSON.stringify({ ...original, created_at: new Date(Date.parse(original.created_at) + 1000).toISOString() }))
      await expect(f.manager.captureWorkspaceRelocationModulesForCoordinator(c.child)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(capture).not.toHaveBeenCalled()
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active/relocation-modules.json'))).rejects.toMatchObject({ code: 'ENOENT' })
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
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active/relocation-modules.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      const file = path.join(f.data, 'workspace-control/relocation-active/relocation-worker-processes.json'), original = JSON.parse(await fs.readFile(file, 'utf8'))
      await fs.writeFile(file, JSON.stringify({ ...original, created_at: new Date(Date.parse(original.created_at) + 1000).toISOString() }))
      release(); await held; await rejected
      await expect(fs.stat(path.join(f.data, 'workspace-control/relocation-active/relocation-modules.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { release(); await held; await response?.catch(() => {}); await c.cleanup(); await f.cleanup() }
  }, 30000)
  it('checks the original module record even when returning its previously captured scope', async () => {
    const f = await fixture({ actualAgent: true }), c = await coordinator(f)
    const capture = vi.spyOn(f.manager, 'captureWorkspaceRelocationModules')
    try {
      await f.manager.captureWorkspaceRelocationWorkersForCoordinator(c.child, f.params, 'fixture-human')
      await f.manager.captureWorkspaceRelocationProcessesForCoordinator(c.child)
      await f.manager.captureWorkspaceRelocationModulesForCoordinator(c.child)
      const file = path.join(f.data, 'workspace-control/relocation-active/relocation-modules.json'), original = JSON.parse(await fs.readFile(file, 'utf8'))
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
      if (pid === process.pid && existsSync(path.join(f.data, 'workspace-control/relocation-active/relocation-coordinator-ready.json'))) f.manager.isShuttingDown = true
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
    const launch = f.manager.launchWorkspaceRelocationCoordinator.bind(f.manager)
    let child: ReturnType<typeof spawn> | undefined
    vi.spyOn(f.manager, 'launchWorkspaceRelocationCoordinator').mockImplementation(async (...args: any[]) => { child = await launch(...args); return child })
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
    } catch (error) {
      console.error(child ? coordinatorJournalFailures(child) : 'coordinator not launched')
      throw error
    } finally {
      const witness = await fs.readFile(path.join(f.data, 'orphan-ready.json'), 'utf8').then(JSON.parse).catch(() => undefined)
      if (witness) native.terminateKnownProcess(witness.process)
      await f.manager.closeWorkspaceCoordinatorChannel(child); locks.releaseCliLock(lock); await f.cleanup()
    }
  }, timeout)
  it.each(['prepare', 'new descendant observation', 'execution exit'])('retains an actual process journal with an uncertain %s reply before further stops', async phase => {
    const orphan = phase === 'new descendant observation'
    let injected = false
    let diagnosticChild: ReturnType<typeof spawn> | undefined
    const replies: Array<{ operation: string; ok: boolean }> = []
    const f = await fixture({ actualAgent: true, processLifetimeMs: 120000, backgroundShell: orphan, orphanDuringStop: orphan })
    const locks = require('../../scripts/lib/cli-lock.mjs'), records = require('../../scripts/lib/workspace-relocation-intent.mjs')
    const native = require('../../scripts/lib/process-identity.cjs'), lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    const launch = f.manager.launchWorkspaceRelocationCoordinator.bind(f.manager), modules = vi.spyOn(f.manager, 'requestWorkspaceRelocationModuleStops')
    const stop = vi.spyOn(f.manager, 'stopWorkspaceRelocationWorkersForCoordinator'), signals = vi.spyOn(native, 'terminateKnownProcess')
    vi.spyOn(f.manager, 'launchWorkspaceRelocationCoordinator').mockImplementation(async (...args: unknown[]) => {
      const child = await launch(...args), emit = child.emit.bind(child)
      diagnosticChild = child
      vi.spyOn(child, 'emit').mockImplementation((event: string | symbol, ...args: any[]) => {
        const message = args[0]
        if (event === 'message' && message?.kind === 'workspace_process_journal_reply') {
          replies.push({ operation: message.operation, ok: message.ok })
          let descendantObserved = false
          if (orphan && message.operation === 'observe' && message.ok === true && stop.mock.calls.length > 0) {
            const key = (item: any) => JSON.stringify([item.pid, item.started, item.owner])
            const initial = new Set(records.readWorkspaceRelocationProcesses(f.data, f.params.intent_id).processes.map(key))
            descendantObserved = records.readWorkspaceRelocationProcessStops(f.data, f.params.intent_id).observations
              .some((row: any) => row.processes.some((item: any) => !initial.has(key(item))))
          }
          if (phase === 'prepare' && message.operation === 'prepare' || descendantObserved
            || phase === 'execution exit' && message.operation === 'execution_exit') {
            injected = true
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
      const diagnostics = diagnosticChild ? coordinatorJournalFailures(diagnosticChild) : []
      expect(injected, JSON.stringify({ phase, replies, worker_stop_calls: stop.mock.calls.length, diagnostics })).toBe(true)
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
      for (const name of ['workspace-control/relocation-active/relocation-workers.json', 'workspace-control/relocation-active/relocation-stop-attempt.json', 'stops.txt']) {
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
  for (const mode of ['confirmed', 'lost preparation', 'lost publication', 'lost selection', 'lost current verification', 'late runtime registration']) it('keeps Admin and the original Root outcome: ' + mode, async () => {
    const f = await fixture({ actualAgent: true, actualAdmin: true, processLifetimeMs: process.platform === 'win32' ? 900000 : 300000 })
    const locks = require('../../scripts/lib/cli-lock.mjs'), records = await import('../../scripts/lib/workspace-relocation-intent.mjs')
    const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    const launch = f.manager.launchWorkspaceRelocationCoordinator.bind(f.manager)
    let child: ReturnType<typeof spawn> | undefined, dropped = false
    vi.spyOn(f.manager, 'launchWorkspaceRelocationCoordinator').mockImplementation(async (...args: any[]) => {
      child = await launch(...args)
      const operation = { 'lost preparation': 'prepare_root', 'lost publication': 'publish_root', 'lost selection': 'select_root', 'lost current verification': 'verify_selected_root' }[mode]
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
      const selected = mode === 'confirmed' || mode === 'lost selection' || mode === 'lost current verification'
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


describe('MM restricts post-relocation validation launches to the original job', () => {
  for (const mode of ['confirmed', 'confirmed probe rejected', 'confirmed memory', 'inactive memory', 'unready memory', 'lost proof', 'definition changed', 'foreign registration', 'definition changed before spawn']) it('keeps normal startup fenced while validation starts: ' + mode, async () => {
    const f = await fixture({ actualAgent: true, actualAdmin: true, withMemory: mode === 'confirmed memory' || mode === 'unready memory', inactiveMemory: mode === 'inactive memory', processLifetimeMs: process.platform === 'win32' ? 900000 : 300000 })
    const locks = require('../../scripts/lib/cli-lock.mjs'), native = require('../../scripts/lib/process-identity.cjs')
    const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    const originalAgent = f.manager.processes.get('crabot-agent'), originalState = f.manager.childStates.get(originalAgent), originalIdentity = native.inspectProcess(originalAgent.pid)
    const originalBearer = f.manager.runtimeBearers.get('crabot-agent'), runtime = f.manager.modules.get('crabot-agent'), entry = runtime.entry
    const unreadyData = path.join(f.root, 'memory-uninitialized')
    if (mode === 'unready memory') {
      const code = path.join(f.root, 'memory-fixture-code'); await fs.mkdir(code); await fs.writeFile(path.join(code, 'schema_version'), 'v2')
      const memory = f.manager.modules.get('memory-default'); memory.cwd = code; memory.data_dir = unreadyData
    }
    const recover = vi.spyOn(f.manager.runtimeRegistry, 'recoverOrphans')
    const launch = f.manager.launchWorkspaceRelocationCoordinator.bind(f.manager)
    let child: ReturnType<typeof spawn> | undefined, proofReplies = 0, injected = false, permit: object | undefined
    vi.spyOn(f.manager, 'launchWorkspaceRelocationCoordinator').mockImplementation(async (...args: any[]) => {
      child = await launch(...args)
      const emit = child!.emit.bind(child)
      vi.spyOn(child!, 'emit').mockImplementation((event: any, ...args: any[]) => {
        if (event === 'message' && args[0]?.kind === 'workspace_file_journal_reply' && args[0].operation === 'verify_selected_root' && args[0].ok === true && ++proofReplies === 2) {
          if (mode === 'lost proof') { injected = true; return emit(event, { ...args[0], ok: false }) }
          if (mode === 'definition changed') { injected = true; runtime.entry += ' untrusted-change' }
          if (mode === 'foreign registration') injected = true
        }
        return emit(event, ...args)
      })
      return child
    })
    const list = f.manager.runtimeRegistry.listRecords.bind(f.manager.runtimeRegistry)
    if (mode === 'foreign registration') vi.spyOn(f.manager.runtimeRegistry, 'listRecords').mockImplementation(async () => {
      const rows = await list(); return injected ? [...rows, { module_id: 'unexpected-module' }] : rows
    })
    const checkStart = f.manager.assertWorkspaceProcessStartAllowed.bind(f.manager)
    let startChecks = 0
    if (mode === 'definition changed before spawn') vi.spyOn(f.manager, 'assertWorkspaceProcessStartAllowed').mockImplementation(async (...args: any[]) => {
      await checkStart(...args)
      if (args[1] && ++startChecks === 4) { injected = true; runtime.entry += ' benign-fixture-extra-argument' }
    })
    const start = f.manager.startModuleProcess.bind(f.manager)
    const starts = vi.spyOn(f.manager, 'startModuleProcess').mockImplementation(async (...args: any[]) => {
      permit = args[3]
      await expect(f.manager.handleStartModule({ module_id: 'crabot-agent' })).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
      await expect(start(args[0] === 'crabot-agent' ? 'memory-default' : 'crabot-agent', undefined, undefined, permit)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      return start(...args)
    })
    try {
      const first = f.manager.startWorkspaceRelocationValidationModules(f.params, 'fixture-human')
      expect(f.manager.startWorkspaceRelocationValidationModules({ ...f.params }, 'fixture-human')).toBe(first)
      if (['confirmed', 'confirmed probe rejected', 'confirmed memory', 'inactive memory'].includes(mode)) {
        const result = await first
        if (mode === 'confirmed' || mode === 'confirmed probe rejected') {
          const records = require('../../scripts/lib/workspace-relocation-intent.mjs')
          const ids = { intent_id: f.params.intent_id, launch_id: records.readWorkspaceRelocationCoordinator(f.data, f.params.intent_id).launch.launch_id }
          const currentBearer = f.manager.runtimeBearers.get('crabot-agent').token
          await expect(f.manager.handleVerifyWorkspaceRelocationRuntime(ids, {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
          for (const token of [originalBearer.token, 'fixture-human', 'not-current']) {
            await expect(f.manager.handleVerifyWorkspaceRelocationRuntime(ids, { authorizationBearer: token })).rejects.toMatchObject({ code: 'FORBIDDEN' })
          }
          await expect(f.manager.handleVerifyWorkspaceRelocationRuntime({ ...ids, path: f.root }, { authorizationBearer: currentBearer })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
          const proof = await f.manager.handleVerifyWorkspaceRelocationRuntime(ids, { authorizationBearer: currentBearer })
          expect(proof).toEqual({ verified: true, ...ids, intent_sha256: f.params.intent_sha256,
            launch_sha256: sha256CanonicalJson(records.readWorkspaceRelocationCoordinator(f.data, f.params.intent_id).launch),
            root_selected_sha256: result.root_selected_sha256, instance_id: f.manager.runtimeRegistry.getInstanceId(), module_id: 'crabot-agent',
            runtime_id: result.validation_modules.find((item: any) => item.module_id === 'crabot-agent').runtime_id })
          const originalEntry = runtime.entry; runtime.entry += ' changed-after-start'
          await expect(f.manager.handleVerifyWorkspaceRelocationRuntime(ids, { authorizationBearer: currentBearer })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
          runtime.entry = originalEntry
          const callRoot = async (params: unknown, bearer?: string) => {
            const response = await fetch(`http://127.0.0.1:${runtime.port}/verify_workspace_relocation_root`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
              body: JSON.stringify({ id: randomUUID(), method: 'verify_workspace_relocation_root', params, source: 'module-manager' }),
            })
            return response.json() as Promise<any>
          }
          expect((await callRoot(ids)).error?.code).toBe('UNAUTHORIZED')
          for (const bearer of [originalBearer.token, 'fixture-human']) expect((await callRoot(ids, bearer)).error?.code).toBe('FORBIDDEN')
          expect((await callRoot({ ...ids, path: f.root }, currentBearer)).error?.code).toBe('INVALID_PARAMS')
          expect((await callRoot({ ...ids, launch_id: randomUUID() }, currentBearer)).error?.code).toBe('FORBIDDEN')
          const root = records.readWorkspaceRelocationRootPublished(f.data, f.params.intent_id).target.path
          const beforeFiles = await fs.readdir(root), beforeProbe = (await fs.stat(root, { bigint: true })).mtimeNs
          const foreign = { module_id: 'foreign', runtime_id: randomUUID() }
          if (mode === 'confirmed probe rejected') {
            vi.spyOn(f.manager.runtimeRegistry, 'listRecords').mockImplementation(async () => [...await list(), foreign])
            expect((await callRoot(ids, currentBearer)).success).toBe(false)
            vi.mocked(f.manager.runtimeRegistry.listRecords).mockRestore()
            expect(await f.manager.handleVerifyWorkspaceRelocationRuntime(ids, { authorizationBearer: currentBearer })).toEqual(proof)
            expect((await callRoot(ids, currentBearer)).success).toBe(false)
            expect((await fs.stat(root, { bigint: true })).mtimeNs).toBe(beforeProbe)
          } else {
            const probe = await callRoot(ids, currentBearer)
            expect(probe).toMatchObject({ success: true, data: proof })
            const probedAt = (await fs.stat(root, { bigint: true })).mtimeNs
            expect(await callRoot(ids, currentBearer)).toMatchObject({ success: true, data: proof })
            expect((await fs.stat(root, { bigint: true })).mtimeNs).toBe(probedAt)
            vi.spyOn(f.manager.runtimeRegistry, 'listRecords').mockImplementation(async () => [...await list(), foreign])
            expect((await callRoot(ids, currentBearer)).success).toBe(false)
            vi.mocked(f.manager.runtimeRegistry.listRecords).mockRestore()
          }
          expect(await fs.readdir(root)).toEqual(beforeFiles)
        }
        expect(starts).toHaveBeenCalledTimes(mode === 'confirmed memory' ? 2 : 1)
        expect(result.validation_modules.map((item: any) => item.module_id)).toEqual(mode === 'confirmed memory' ? ['memory-default', 'crabot-agent'] : ['crabot-agent'])
        if (mode === 'inactive memory') expect(f.manager.processes.has('memory-default')).toBe(false)
        const current = f.manager.processes.get('crabot-agent'), state = f.manager.childStates.get(current)
        expect(current).not.toBe(originalAgent); expect(state.runtimeId).not.toBe(originalState.runtimeId)
        expect(originalBearer.revoked).toBe(true); expect(f.manager.runtimeBearers.get('crabot-agent')).not.toBe(originalBearer)
        expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([originalIdentity]).state).toBe('stopped')
        expect(result.validation_modules.find((item: any) => item.module_id === 'crabot-agent')).toEqual({ module_id: 'crabot-agent', runtime_id: state.runtimeId, process: native.inspectProcess(current.pid) })
        await expect(start('crabot-agent', undefined, undefined, permit)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      } else {
        await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
        if (mode === 'unready memory') {
          expect(starts).toHaveBeenCalledOnce()
          await expect(fs.lstat(unreadyData)).rejects.toMatchObject({ code: 'ENOENT' })
        } else {
          expect(injected).toBe(true)
          if (mode === 'definition changed before spawn') expect(starts).toHaveBeenCalledOnce()
          else expect(starts).not.toHaveBeenCalled()
        }
        expect(f.manager.processes.has('crabot-agent')).toBe(false)
        await expect(f.manager.startWorkspaceRelocationValidationModules(f.params, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      }
      expect(recover).not.toHaveBeenCalled()
      expect(f.manager.startWorkspaceRelocationValidationModules(f.params, 'fixture-human')).toBe(first)
      const ledger = JSON.parse(await fs.readFile(path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), 'utf8'))
      expect(ledger.workers[0].task.status).toBe('closed')
      expect((await fetch(`http://127.0.0.1:${f.port}/api/friends`, { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(200)
      expect(require('../../scripts/lib/workspace-maintenance.cjs').workspaceMaintenancePending(f.data)).toBe(true)
    } finally {
      runtime.entry = entry
      if (child?.connected) { const ended = once(child, 'exit'); child.disconnect(); await ended }
      locks.releaseCliLock(lock); await f.cleanup()
    }
  }, process.platform === 'win32' ? 600000 : 120000)
})


describe('MM checks the new runtime health and Root under the original job', () => {
  it('registers the finite listener only after the original parent runtime publication under delayed persistence', async () => {
    const f = await fixture({ actualAgent: true, actualAdmin: true, validationHealth: 'healthy', runtimeRegistrationDelayMs: 4000 })
    try {
      expect(f.manager.modules.get('crabot-agent').status).toBe('running')
      const record = (await f.manager.runtimeRegistry.listRecords()).find((item: any) => item.module_id === 'crabot-agent')
      expect(record.root_pid).toBe(f.manager.processes.get('crabot-agent').pid)
      expect(await f.manager.sendToModule(f.manager.modules.get('crabot-agent').port, 'health', {})).toMatchObject({ status: 'healthy' })
    } finally { await f.cleanup() }
  }, process.platform === 'win32' ? 120000 : 30000)

  for (const mode of ['healthy Agent', 'healthy slow runtime reply', 'healthy Memory', ...(process.platform === 'win32' ? [] : ['healthy Memory bootstrap', 'Memory bootstrap generation changed', 'Memory bootstrap owner changed', 'Memory bootstrap executable changed after binding']), 'healthy delayed registration', 'unhealthy Agent', 'degraded Memory', 'wrong runtime', 'definition changed during health', 'exit before registration', 'lost health acknowledgement', 'runtime record changed before health record', 'Agent workspace override']) {
    it('retains maintenance until all exact runtime checks confirm: ' + mode, async () => {
      const withMemory = mode.includes('Memory'), bootstrap = mode.includes('bootstrap')
      const f = await fixture({ actualAgent: true, actualAdmin: true, withMemory,
        validationHealth: mode === 'unhealthy Agent' ? 'unhealthy' : 'healthy', validationRuntimeMismatch: mode === 'wrong runtime', validationRootOverride: mode === 'Agent workspace override',
        ...(mode.includes('registration') ? { validationRegistration: mode === 'exit before registration' ? 'exit' as const : 'delayed' as const } : {}),
        ...(withMemory ? { memoryHealth: mode === 'degraded Memory' ? 'degraded' as const : 'healthy' as const, memoryBootstrap: bootstrap } : {}),
        processLifetimeMs: process.platform === 'win32' ? 900000 : 300000 })
      const locks = require('../../scripts/lib/cli-lock.mjs'), rpc = require('../../scripts/lib/module-carrier-rpc.cjs')
      const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
      let slowReplies = 0
      if (mode === 'healthy slow runtime reply') {
        const handler = f.manager.methodHandlers.get('verify_workspace_relocation_runtime')
        f.manager.methodHandlers.set('verify_workspace_relocation_runtime', async (...args: any[]) => {
          const result = await handler(...args)
          if (!slowReplies++) await new Promise(resolve => setTimeout(resolve, 5600))
          return result
        })
      }
      const runtime = f.manager.modules.get('crabot-agent'), originalEntry = runtime.entry
      if (mode.includes('registration')) runtime.skip_health_check = false
      let injected = false, changedRuntime: { file: string; contents: string } | undefined
      let bootstrapRelease: Promise<void> | undefined, bootstrapChanged = false, bootstrapRegistered = false
      const bootstrapSpies: Array<{ mockRestore(): void }> = []
      if (bootstrap) {
        const native = require('../../scripts/lib/process-identity.cjs'), inspect = native.inspectProcess.bind(native)
        const oldMemory = f.manager.processes.get('memory-default'), list = f.manager.runtimeRegistry.listRecords.bind(f.manager.runtimeRegistry)
        bootstrapSpies.push(vi.spyOn(native, 'inspectProcess').mockImplementation((pid: number) => {
          const actual = inspect(pid), current = f.manager.processes.get('memory-default')
          if (!actual || current === oldMemory || current?.pid !== pid) return actual
          if (!bootstrapRelease) bootstrapRelease = (async () => {
            await fs.writeFile(path.join(f.data, 'memory-bootstrap-gate'), 'release')
            await vi.waitFor(() => {
              const service = inspect(pid)
              expect(service?.executable).toBeTruthy()
              expect(service.executable).not.toBe(actual.executable)
              expect(service.started).toBe(actual.started)
            }, { timeout: 10000 })
            bootstrapChanged = true
          })()
          if (bootstrapRegistered && mode === 'Memory bootstrap executable changed after binding') return { ...actual, executable: actual.executable + '-other' }
          if (bootstrapChanged && mode === 'Memory bootstrap generation changed') return { ...actual, started: actual.started + '-other' }
          if (bootstrapChanged && mode === 'Memory bootstrap owner changed') return { ...actual, owner: actual.owner + '-other' }
          return actual
        }))
        bootstrapSpies.push(vi.spyOn(f.manager.runtimeRegistry, 'listRecords').mockImplementation(async () => {
          if (bootstrapRelease) { await bootstrapRelease; bootstrapRegistered = true }
          return list()
        }))
      }
      const launchCoordinator = f.manager.launchWorkspaceRelocationCoordinator.bind(f.manager)
      if (mode === 'lost health acknowledgement' || mode === 'runtime record changed before health record') {
        vi.spyOn(f.manager, 'launchWorkspaceRelocationCoordinator').mockImplementation(async (...args: any[]) => {
          const child = await launchCoordinator(...args)
          const emit = child.emit.bind(child), send = child.send.bind(child)
          if (mode === 'lost health acknowledgement') vi.spyOn(child, 'emit').mockImplementation((event: any, ...values: any[]) => {
            if (event === 'message' && values[0]?.kind === 'workspace_file_journal_reply' && values[0].operation === 'record_health' && values[0].ok === true) {
              injected = true; return emit(event, { ...values[0], ok: false })
            }
            return emit(event, ...values)
          })
          else vi.spyOn(child, 'send').mockImplementation((message: any, ...values: any[]) => {
            if (!injected && message?.kind === 'workspace_file_journal_request' && message.operation === 'record_health') {
              const module = message.payload.modules.find((item: any) => item.module_id === 'crabot-agent')
              const file = path.join(f.data, 'module-runtime-registry/records', module.runtime_id + '.json'), contents = readFileSync(file, 'utf8')
              changedRuntime = { file, contents }; injected = true
              writeFileSync(file, JSON.stringify({ ...JSON.parse(contents), module_id: 'not-the-agent' }))
            }
            return send(message, ...values)
          })
          return child
        })
      }
      const open = rpc.openSpawnedModuleRuntimeRpc
      vi.spyOn(rpc, 'openSpawnedModuleRuntimeRpc').mockImplementation(async (...args: any[]) => {
        const connection = await open(...args)
        return { ...connection, call: async (method: string, ...callArgs: any[]) => {
          const result = await connection.call(method, ...callArgs)
          if (mode === 'definition changed during health' && method === 'health' && !injected) { injected = true; runtime.entry += ' fixture-change' }
          return result
        } }
      })
      const starts = vi.spyOn(f.manager, 'startModuleProcess')
      if (mode === 'exit before registration') {
        const launch = f.manager.startWorkspaceRelocationValidationModules.bind(f.manager)
        vi.spyOn(f.manager, 'startWorkspaceRelocationValidationModules').mockImplementation(async (...args: any[]) => {
          const result = await launch(...args), child = f.manager.processes.get('crabot-agent')
          const scope = require('../../scripts/lib/spawned-process-tree.cjs').captureSpawnedProcessTree(child)
          await require('../../scripts/lib/known-process-stop.cjs').stopKnownProcessScope(scope, { timeoutMs: 1000, onObserved: async () => {} })
          injected = true
          return result
        })
      }
      try {
        const first = f.manager.verifyWorkspaceRelocationValidationHealth(f.params, 'fixture-human')
        expect(f.manager.verifyWorkspaceRelocationValidationHealth({ ...f.params }, 'fixture-human')).toBe(first)
        await expect(f.manager.verifyWorkspaceRelocationValidationHealth({ ...f.params, intent_sha256: '0'.repeat(64) }, 'fixture-human')).rejects.toMatchObject({ code: 'FORBIDDEN' })
        if (mode.startsWith('healthy')) {
          const result = await first.catch((error: unknown) => {
            const coordinator = f.manager.workspaceValidationProof?.result.coordinator
            if (coordinator) console.error('[Workspace health journal]', coordinatorJournalFailures(coordinator))
            throw error
          })
          expect(result.healthy_modules.map((item: any) => item.module_id)).toEqual(withMemory ? ['memory-default', 'crabot-agent'] : ['crabot-agent'])
          expect(result.root_verified).toMatchObject({ verified: true, intent_id: f.params.intent_id, root_selected_sha256: result.root_selected_sha256,
            instance_id: f.manager.runtimeRegistry.getInstanceId(), module_id: 'crabot-agent', runtime_id: result.validation_modules.find((item: any) => item.module_id === 'crabot-agent').runtime_id })
          const health = JSON.parse(await fs.readFile(path.join(f.data, 'workspace-control/relocation-active/relocation-health.json'), 'utf8'))
          expect(Object.keys(health).sort()).toEqual(['checked_at', 'intent_id', 'modules', 'root_proof', 'schema_version'])
          expect(health).toMatchObject({ schema_version: 1, intent_id: f.params.intent_id, root_proof: result.root_verified })
          expect(health.modules).toEqual([...result.validation_modules].sort((a: any, b: any) => a.module_id.localeCompare(b.module_id)))
          expect(new Date(health.checked_at).toISOString()).toBe(health.checked_at)
          expect(result.health_sha256).toBe(sha256CanonicalJson(health))
          if (mode === 'healthy Agent') {
            const records = require('../../scripts/lib/workspace-relocation-intent.mjs'), report = { modules: health.modules, root_proof: health.root_proof }
            const original = await fs.readFile(path.join(f.data, 'workspace-control/relocation-active/relocation-health.json'), 'utf8')
            expect(records.readWorkspaceRelocationHealth(f.data, f.params.intent_id)).toEqual(health)
            const oldRuntime = records.readWorkspaceRelocationModules(f.data, f.params.intent_id).modules.find((item: any) => item.module_id === 'crabot-agent').runtime_id
            const healthFile = path.join(f.data, 'workspace-control/relocation-active/relocation-health.json'), wrong = structuredClone(health)
            wrong.modules[0].runtime_id = oldRuntime; wrong.root_proof.runtime_id = oldRuntime
            try {
              writeFileSync(healthFile, JSON.stringify(wrong))
              expect(() => records.readWorkspaceRelocationHealth(f.data, f.params.intent_id)).toThrow()
            } finally { writeFileSync(healthFile, original) }
            await expect(records.recordWorkspaceRelocationHealth({ dataDir: f.data, id: f.params.intent_id, report })).rejects.toMatchObject({ code: 'WORKSPACE_RELOCATION_INVALID' })
            const context = { dataDir: f.data, id: f.params.intent_id, launch: records.readWorkspaceRelocationCoordinator(f.data, f.params.intent_id).launch }
            let journal = require('../../scripts/lib/workspace-file-journal.mjs').createWorkspaceFileJournal(result.coordinator, context)
            try { await expect(journal.recordHealth({ ...report, root_proof: { ...report.root_proof, root_selected_sha256: '0'.repeat(64) } })).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) }
            finally { journal.close() }
            journal = require('../../scripts/lib/workspace-file-journal.mjs').createWorkspaceFileJournal(result.coordinator, context)
            try {
              const mutable = structuredClone(report), observe = journal.recordHealth(mutable)
              mutable.root_proof.runtime_id = 'not-the-original-report'
              expect(await observe).toEqual({ dispatch: 'observe', health_sha256: result.health_sha256 })
            } finally { journal.close() }
            expect(await fs.readFile(path.join(f.data, 'workspace-control/relocation-active/relocation-health.json'), 'utf8')).toBe(original)
          }
        } else {
          await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
          if (mode === 'unhealthy Agent' || mode === 'degraded Memory') await expect(first).rejects.toMatchObject({ stage: 'module-health' })
          if (mode === 'Agent workspace override') await expect(fs.readFile(path.join(f.data, 'workspace-control/relocation-active/relocation-health.json'))).rejects.toMatchObject({ code: 'ENOENT' })
          await expect(f.manager.verifyWorkspaceRelocationValidationHealth(f.params, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
          if (mode === 'definition changed during health' || mode === 'exit before registration') expect(injected).toBe(true)
          if (mode === 'lost health acknowledgement' || mode === 'runtime record changed before health record') {
            expect(injected).toBe(true)
            await expect(first).rejects.toMatchObject({ stage: 'record-health' })
            const file = path.join(f.data, 'workspace-control/relocation-active/relocation-health.json')
            if (mode === 'lost health acknowledgement') {
              const record = JSON.parse(await fs.readFile(file, 'utf8'))
              expect(record.intent_id).toBe(f.params.intent_id)
              expect(record.root_proof.runtime_id).toBe(f.manager.childStates.get(f.manager.processes.get('crabot-agent')).runtimeId)
            } else await expect(fs.readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
          }
        }
        if (bootstrap) { await bootstrapRelease; expect(bootstrapChanged).toBe(true) }
        expect(starts).toHaveBeenCalledTimes(bootstrap && !mode.startsWith('healthy') ? 1 : withMemory ? 2 : 1)
        const calls = JSON.parse(await fs.readFile(path.join(f.data, 'agent-calls.json'), 'utf8'))
        expect(calls.filter((item: any) => item.method === 'verify_workspace_relocation_root')).toHaveLength(mode.startsWith('healthy') || mode.includes('health record') || mode === 'lost health acknowledgement' || mode === 'Agent workspace override' ? 1 : 0)
        expect(f.manager.verifyWorkspaceRelocationValidationHealth(f.params, 'fixture-human')).toBe(first)
        expect((await fetch(`http://127.0.0.1:${f.port}/api/friends`, { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(200)
        if (mode === 'healthy slow runtime reply') expect(slowReplies).toBeGreaterThan(0)
        expect(require('../../scripts/lib/workspace-maintenance.cjs').workspaceMaintenancePending(f.data)).toBe(true)
        const ledger = JSON.parse(await fs.readFile(path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), 'utf8'))
        expect(ledger.workers[0].task.status).toBe('closed')
      } finally {
        for (const spy of bootstrapSpies) spy.mockRestore()
        if (bootstrapRelease) await bootstrapRelease
        runtime.entry = originalEntry
        if (changedRuntime) writeFileSync(changedRuntime.file, changedRuntime.contents)
        const child = f.manager.workspaceValidationProof?.result.coordinator
        if (child?.connected) { const ended = once(child, 'exit'); child.disconnect(); await ended }
        try {
          if (mode === 'exit before registration') {
            const process = f.manager.processes.get('crabot-agent'), state = process && f.manager.childStates.get(process)
            const identity = f.manager.workspaceValidationProof?.result.validation_modules.find((module: any) => module.module_id === 'crabot-agent')?.process
            expect(identity).toBeDefined()
            expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([identity]).state).toBe('stopped')
            await state.finalized
            expect(state.finalizeError).toMatchObject({ code: 'CRABOT_WORKSPACE_MODULE_SCOPE' })
            // This finite fixture never spawns a child. Drop only its independently exited test process for teardown.
            f.manager.processes.delete('crabot-agent')
            await f.manager.runtimeRegistry.removeRuntime(state.runtimeId)
          }
        } finally { locks.releaseCliLock(lock); await f.cleanup() }
      }
    }, process.platform === 'win32' ? 600000 : 120000)
  }
})


describe('normal fixed-job Admin completion preparation', () => {
  it('uses the actual finite validation listener after a delayed child boot', async () => {
    const f = await fixture({ actualAgent: true, actualAdmin: true, validationHealth: 'healthy', validationServerReadyDelayMs: 4000, processLifetimeMs: 180000 })
    const locks = require('../../scripts/lib/cli-lock.mjs'), lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    try {
      const prepared = await f.manager.prepareWorkspaceRelocationCompletion(f.params, 'fixture-human')
      expect(prepared.prepared).toBe(true)
      expect(require('../../scripts/lib/workspace-relocation-intent.mjs').readWorkspaceRelocationJobStatus(f.data)).toMatchObject({ available: true, job: { intent_id: f.params.intent_id, state: 'needs_attention', stage: 'finalizing' } })
      expect(require('../../scripts/lib/workspace-maintenance.cjs').workspaceMaintenancePending(f.data)).toBe(true)
    } finally { locks.releaseCliLock(lock); await f.cleanup() }
  }, process.platform === 'win32' ? 600000 : 120000)

  it('requires current human approval and the current Admin for a new protected recovery admission', async () => {
    const f = await fixture({ actualAgent: true, actualAdmin: true, validationHealth: 'healthy', processLifetimeMs: 300000 })
    const locks = require('../../scripts/lib/cli-lock.mjs'), records = require('../../scripts/lib/workspace-relocation-intent.mjs')
    const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    let cold: any
    try {
      const prepared = await f.manager.prepareWorkspaceRelocationCompletion(f.params, 'fixture-human'), old = f.manager.workspaceFinalizationGrant
      const definition = f.manager.modules.get('admin-web')
      await f.manager.stop()
      const fence = records.readWorkspaceRelocationFinalizing(f.data, f.params.intent_id), fenceFile = path.join(f.data, 'workspace-control/relocation-finalizing.json')
      const before = await fs.readFile(fenceFile), ledgerFile = path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), ledger = await fs.readFile(ledgerFile)
      const request = { intent_id: f.params.intent_id, recovery_id: randomUUID(), completion_sha256: prepared.completion_sha256, finalizing_sha256: sha256CanonicalJson(fence) }
      cold = new ModuleManager({ port: 0, modules: [], shutdown_timeout: 0.1 }, f.data) as any
      cold.modules.set('admin-web', { ...definition, status: 'stopped', pid: undefined, auto_start: false })
      cold.modules.set('crabot-agent', { module_id: 'crabot-agent', module_type: 'agent', entry: 'never-spawn', port: 19801, auto_start: false, status: 'stopped' })
      await cold.start(); const currentPort = cold.server.address().port
      cold.config.port = f.manager.config.port
      await fs.unlink(path.join(f.data, 'ready')); await cold.startModuleProcess('admin-web')
      await vi.waitFor(async () => expect(await fs.readFile(path.join(f.data, 'ready'), 'utf8')).toBe('ready'), { timeout: 10000 })
      for (const token of ['wrong-human', old.token]) {
        await expect(cold.prepareWorkspaceRelocationRecoveryAdmission(request, token)).rejects.toMatchObject({ code: expect.stringMatching(/UNAUTHORIZED|FORBIDDEN/) })
        expect(cold.workspaceRecoveryAdmission).toBeUndefined()
      }
      await expect(cold.prepareWorkspaceRelocationRecoveryAdmission(request, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      expect(cold.workspaceRecoveryAdmission).toBeUndefined()
      await cold.stopModuleProcess('admin-web', 'shutdown'); cold.config.port = currentPort
      await fs.unlink(path.join(f.data, 'ready')); await cold.startModuleProcess('admin-web')
      await vi.waitFor(async () => expect(await fs.readFile(path.join(f.data, 'ready'), 'utf8')).toBe('ready'), { timeout: 10000 })
      await expect(cold.prepareWorkspaceRelocationRecoveryAdmission({ ...request, completion_sha256: '0'.repeat(64) }, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      const role = await cold.prepareWorkspaceRelocationRecoveryAdmission(request, 'fixture-human')
      expect(role.accepted).toBe(true); expect(role.request).toEqual(request)
      expect(JSON.stringify(role.result)).not.toContain('fixture-human'); expect(JSON.stringify(await f.calls())).not.toContain('fixture-human')
      await expect(cold.prepareWorkspaceRelocationRecoveryAdmission(request, 'fixture-human')).resolves.toBe(role)
      const recoveryRecords = require('../../scripts/lib/workspace-recovery-records.mjs')
      const idle = spawn(process.execPath, ['-e', 'process.on("disconnect",()=>process.exit(0));process.send("idle-ready");setTimeout(()=>process.exit(0),10000)'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      const idleExited = once(idle, 'exit'); let idleErrors = ''
      let childIdentity: any
      idle.stderr.on('data', chunk => { idleErrors = (idleErrors + chunk.toString()).slice(-4096) })
      try {
        const ready = await Promise.race([once(idle, 'message'), idleExited.then(([code]) => { throw new Error('Finite idle exited before ready: ' + code + ' ' + idleErrors) })])
        expect(ready[0]).toBe('idle-ready')
        console.log('[finite recovery record]', { stage: 'idle-ready' })
        childIdentity = require('../../scripts/lib/spawned-process-tree.cjs').captureSpawnedProcessTree(idle).find((item: any) => item.pid === idle.pid)
        const launch = await recoveryRecords.commitWorkspaceRecoveryCoordinatorLaunch({ dataDir: f.data, request, admission: role.result, coordinator: childIdentity, verify: role.verify })
        console.log('[finite recovery record]', { stage: 'launch-written' })
        const recovered = recoveryRecords.readWorkspaceRecoveryCoordinator(f.data, request.recovery_id)
        expect(recovered).toEqual({ launch, ready: null })
        expect(launch.process).toEqual(childIdentity); expect(launch.admission_sha256).toBe(sha256CanonicalJson(role.result))
        console.log('[finite recovery record]', { stage: 'duplicate-launch-denial' })
        await expect(recoveryRecords.commitWorkspaceRecoveryCoordinatorLaunch({ dataDir: f.data, request, admission: role.result, coordinator: childIdentity, verify: role.verify })).rejects.toBeDefined()
        console.log('[finite recovery record]', { stage: 'parent-ready-denial' })
        await expect(recoveryRecords.commitWorkspaceRecoveryCoordinatorReady({ dataDir: f.data, recoveryId: request.recovery_id, launchHash: sha256CanonicalJson(launch) })).rejects.toBeDefined()
        expect(recoveryRecords.readWorkspaceRecoveryCoordinator(f.data, request.recovery_id)).toEqual(recovered)
        const launchFile = path.join(launch.control_root.path, 'launch.json'), launchBytes = await fs.readFile(launchFile)
        for (const changed of [{ ...launch, unexpected: true }, { ...launch, control_root: { ...launch.control_root, ino: '0' } }]) {
          await fs.writeFile(launchFile, JSON.stringify(changed))
          expect(() => recoveryRecords.readWorkspaceRecoveryCoordinator(f.data, request.recovery_id)).toThrow()
          await fs.writeFile(launchFile, launchBytes)
        }
        const linked = path.join(launch.control_root.path, 'retained-link')
        await fs.link(launchFile, linked)
        try { expect(() => recoveryRecords.readWorkspaceRecoveryCoordinator(f.data, request.recovery_id)).toThrow() }
        finally { await fs.unlink(linked) }
        const readyFile = path.join(launch.control_root.path, 'ready.json')
        await fs.writeFile(readyFile, '[]', { mode: 0o600 })
        try { expect(() => recoveryRecords.readWorkspaceRecoveryCoordinator(f.data, request.recovery_id)).toThrow() }
        finally { await fs.unlink(readyFile) }
        expect(recoveryRecords.readWorkspaceRecoveryCoordinator(f.data, request.recovery_id)).toEqual(recovered)
        expect(await fs.readFile(fenceFile)).toEqual(before); expect(await fs.readFile(ledgerFile)).toEqual(ledger)
      } finally {
        console.log('[finite recovery record]', { stage: 'idle-disconnect', exit_code: idle.exitCode, connected: idle.connected })
        if (idle.connected) idle.disconnect()
        await vi.waitFor(() => {
          if (childIdentity) expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([childIdentity]).state).toBe('stopped')
          else expect(!idle.pid || require('../../scripts/lib/process-identity.cjs').isProcessExited(idle.pid) === true).toBe(true)
        }, { timeout: 15000 })
        idle.stderr.destroy()
        console.log('[finite recovery record]', { stage: 'idle-kernel-exited' })
      }
      await expect(cold.handleVerifyWorkspaceRelocationRecoveryAdmission({ ...request, path: f.root }, { authorizationBearer: 'fixture-human' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
      await expect(cold.handleVerifyWorkspaceRelocationRecoveryAdmission({ ...request, recovery_id: randomUUID() }, { authorizationBearer: 'fixture-human' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect([...cold.processes.keys()]).toEqual(['admin-web']); expect(await fs.readFile(fenceFile)).toEqual(before); expect(await fs.readFile(ledgerFile)).toEqual(ledger)
      const state = cold.childStates.get(cold.processes.get('admin-web')), runtimeId = state.runtimeId
      state.runtimeId = randomUUID()
      await expect(role.verify()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      state.runtimeId = runtimeId
      expect(cold.workspaceRecoveryAdmission).toBeUndefined(); expect(role.accepted).toBe(false)
      await expect(role.verify()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      const freshRole = await cold.prepareWorkspaceRelocationRecoveryAdmission({ ...request, recovery_id: randomUUID() }, 'fixture-human')
      expect(freshRole.accepted).toBe(true); expect(freshRole).not.toBe(role)
      role.close(); expect(cold.workspaceRecoveryAdmission).toBe(freshRole)
      const injectedLoader = path.join(f.root, 'untrusted-loader.cjs'), injectedMarker = path.join(f.root, 'loader-ran')
      await fs.writeFile(injectedLoader, `require('node:fs').writeFileSync(${JSON.stringify(injectedMarker)}, 'unexpected')`)
      const oldNodeOptions = process.env.NODE_OPTIONS
      let initialized: any
      try {
        process.env.NODE_OPTIONS = '--require ' + JSON.stringify(injectedLoader)
        initialized = await cold.initializeWorkspaceRelocationRecovery(freshRole.request, 'fixture-human')
      } finally {
        if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS
        else process.env.NODE_OPTIONS = oldNodeOptions
      }
      await expect(fs.lstat(injectedMarker)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(freshRole.accepted).toBe(false)
      await expect(freshRole.verify()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      freshRole.close()
      await Promise.all([initialized.verify(), initialized.verify()])
      await expect(cold.initializeWorkspaceRelocationRecovery(freshRole.request, 'wrong-human')).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(freshRole.consume()).rejects.toBeDefined()
      expect(recoveryRecords.readWorkspaceRecoveryCoordinator(f.data, freshRole.request.recovery_id)).toEqual({ launch: initialized.launch, ready: initialized.ready })
      expect(await cold.initializeWorkspaceRelocationRecovery(freshRole.request, 'fixture-human')).toBe(initialized)
      const recoveryFacts = await cold.inspectWorkspaceRelocationRecovery(freshRole.request, 'fixture-human')
      expect(recoveryFacts).toMatchObject({ completion_sha256: freshRole.request.completion_sha256, root_selected_sha256: sha256CanonicalJson(records.readWorkspaceRelocationArchivedState(f.data, request.intent_id).selected) })
      expect(recoveryFacts.validation_roots).toEqual(expect.arrayContaining([expect.objectContaining({ module_id: 'crabot-agent', root_state: 'stopped' })]))
      await recoveryFacts.verify()
      const archivedState = records.readWorkspaceRelocationArchivedState(f.data, request.intent_id)
      const recoveryInspection = require('../../scripts/lib/workspace-recovery-admission.mjs'), exits = require('../../scripts/lib/known-process-exit.cjs')
      const originalProbe = exits.probeKnownProcessExit, root = archivedState.health.modules[0].process
      let rootStopped = false
      const observedRoot = vi.spyOn(exits, 'probeKnownProcessExit').mockImplementation((scope: any, ...args: any[]) => {
        if (scope.length === 1 && scope[0].pid === root.pid && scope[0].started === root.started) return {
          state: rootStopped ? 'stopped' : 'running', running_pids: rootStopped ? [] : [root.pid], unknown_pids: [],
        }
        return originalProbe(scope, ...args)
      })
      try {
        const options = { dataDir: f.data, request: freshRole.request, verify: initialized.verify }
        const controlFacts = await recoveryInspection.inspectWorkspaceRecoveryControlFacts(options)
        const rootSnapshot = await recoveryInspection.inspectWorkspaceRecoveryFacts(options)
        expect(controlFacts).not.toHaveProperty('validation_roots')
        expect(rootSnapshot.validation_roots[0].root_state).toBe('running')
        rootStopped = true
        await expect(controlFacts.verify()).resolves.toBeUndefined()
        await expect(rootSnapshot.verify()).rejects.toBeDefined()
        rootStopped = false
        await expect(rootSnapshot.verify()).rejects.toBeDefined()
        await expect(controlFacts.verify()).resolves.toBeUndefined()
      } finally { observedRoot.mockRestore() }
      const plannedModules = archivedState.health.modules.map((item: any) => ({ module_id: item.module_id, runtime_id: randomUUID() })).sort((a: any, b: any) => a.module_id.localeCompare(b.module_id))
      for (const modules of [[], [{ ...plannedModules[0], runtime_id: archivedState.health.modules[0].runtime_id }], [{ ...plannedModules[0], module_id: 'foreign-module' }]]) {
        await expect(recoveryRecords.commitWorkspaceRecoveryRuntimePlan({ dataDir: f.data, recoveryId: freshRole.request.recovery_id, modules, verify: initialized.verify })).rejects.toBeDefined()
        expect(recoveryRecords.readWorkspaceRecoveryRuntimePlan(f.data, freshRole.request.recovery_id)).toBeNull()
      }
      const runtimePreparation = await cold.prepareWorkspaceRecoveryRuntimes(freshRole.request, 'fixture-human'), runtimePlan = runtimePreparation.plan
      expect(await cold.prepareWorkspaceRecoveryRuntimes(freshRole.request, 'fixture-human')).toBe(runtimePreparation)
      await runtimePreparation.verify()
      expect(runtimePlan.modules.map((item: any) => item.module_id)).toEqual(plannedModules.map((item: any) => item.module_id))
      expect(runtimePlan.modules.some((item: any) => archivedState.health.modules.some((old: any) => old.runtime_id === item.runtime_id))).toBe(false)
      expect(Object.isFrozen(runtimePlan)).toBe(true); expect(Object.isFrozen(runtimePlan.modules)).toBe(true)
      expect(runtimePlan.root_selected_sha256).toBe(recoveryFacts.root_selected_sha256)
      expect(runtimePlan.launch_sha256).toBe(sha256CanonicalJson(initialized.launch))
      expect(recoveryRecords.readWorkspaceRecoveryRuntimePlan(f.data, freshRole.request.recovery_id)).toEqual(runtimePlan)
      await verifyRegisteredRuntimeGate({ manager: cold, dataDir: f.data, coordinator: initialized, preparation: runtimePreparation, modules: archivedState.modules.modules })
      const actualReadyFile = path.join(initialized.launch.control_root.path, 'ready.json'), actualReadyBytes = await fs.readFile(actualReadyFile)
      await fs.writeFile(actualReadyFile, 'null')
      try { expect(() => recoveryRecords.readWorkspaceRecoveryCoordinator(f.data, freshRole.request.recovery_id)).toThrow() }
      finally { await fs.writeFile(actualReadyFile, actualReadyBytes) }
      const planFile = path.join(initialized.launch.control_root.path, 'runtime-plan.json'), planBytes = await fs.readFile(planFile)
      for (const invalid of [null, [], { ...runtimePlan, unexpected: true }, { ...runtimePlan, launch_sha256: '0'.repeat(64) }]) {
        await fs.writeFile(planFile, JSON.stringify(invalid))
        expect(() => recoveryRecords.readWorkspaceRecoveryRuntimePlan(f.data, freshRole.request.recovery_id)).toThrow()
        await fs.writeFile(planFile, planBytes)
      }
      expect(recoveryRecords.readWorkspaceRecoveryRuntimePlan(f.data, freshRole.request.recovery_id)).toEqual(runtimePlan)
      await expect(recoveryRecords.commitWorkspaceRecoveryRuntimePlan({ dataDir: f.data, recoveryId: freshRole.request.recovery_id, modules: plannedModules, verify: initialized.verify })).rejects.toBeDefined()
      expect(await fs.readFile(ledgerFile)).toEqual(ledger)
      expect(initialized.launch.process.parent).toBe(process.pid)
      expect(initialized.launch.process.executable).toBe(require('../../scripts/lib/process-identity.cjs').inspectProcess(process.pid).executable)
      expect((await fetch(`http://127.0.0.1:${f.port}/api/workspaces`, { method: 'POST', headers: { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(503)
      expect(await fs.readFile(ledgerFile)).toEqual(ledger)
      const stateAfterHandoff = cold.childStates.get(cold.processes.get('admin-web')), runtimeAfterHandoff = stateAfterHandoff.runtimeId
      stateAfterHandoff.runtimeId = randomUUID()
      await expect(initialized.verify()).rejects.toBeDefined()
      stateAfterHandoff.runtimeId = runtimeAfterHandoff
      await expect(initialized.verify()).rejects.toBeDefined()
      await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([initialized.launch.process]).state).toBe('stopped'), { timeout: 15000 })
      await expect(cold.initializeWorkspaceRelocationRecovery(freshRole.request, 'fixture-human')).rejects.toBeDefined()
      const nextRequest = { ...request, recovery_id: randomUUID() }
      const next = await cold.initializeWorkspaceRelocationRecovery(nextRequest, 'fixture-human')
      freshRole.close(); initialized.close()
      await next.verify()
      const nextFacts = recoveryRecords.readWorkspaceRecoveryCoordinator(f.data, nextRequest.recovery_id)
      next.child.send({ kind: 'workspace_recovery_verify', recovery_id: nextRequest.recovery_id, launch_sha256: sha256CanonicalJson(next.launch), ready_sha256: sha256CanonicalJson(next.ready), nonce: 'invalid' })
      await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([next.launch.process]).state).toBe('stopped'), { timeout: 15000 })
      await expect(next.verify()).rejects.toBeDefined()
      await expect(cold.initializeWorkspaceRelocationRecovery(nextRequest, 'fixture-human')).rejects.toBeDefined()
      expect(recoveryRecords.readWorkspaceRecoveryCoordinator(f.data, nextRequest.recovery_id)).toEqual(nextFacts)
      const startRequest = { ...request, recovery_id: randomUUID() }, startCoordinator = await cold.initializeWorkspaceRelocationRecovery(startRequest, 'fixture-human')
      const startPreparation = await cold.prepareWorkspaceRecoveryRuntimes(startRequest, 'fixture-human'), modulePlan = startPreparation.plan.modules[0]
      const originalDefinition = cold.modules.get(modulePlan.module_id), observed = path.join(f.data, 'mm-gate-observed.json')
      const receipt = path.join(startCoordinator.launch.control_root.path, 'runtime-starts', modulePlan.module_id + '.json')
      const finiteModule = path.join(f.data, 'mm-gate-runtime.cjs'), finiteCalls = path.join(f.data, 'mm-gate-rpc.json'), finiteReady = path.join(f.data, 'mm-gate-ready')
      await fs.writeFile(finiteModule, `const fs=require('node:fs'),http=require('node:http');const calls=[];
        fs.writeFileSync(process.env.TEST_GATE_OBSERVED,JSON.stringify({pid:process.pid,parent:process.ppid,runtime:process.env.CRABOT_MODULE_RUNTIME_ID,registered:fs.existsSync(process.env.TEST_GATE_RECEIPT)}));
        const server=http.createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;const body=JSON.parse(text);calls.push(body.method);fs.writeFileSync(process.env.TEST_GATE_CALLS,JSON.stringify(calls));
          const data=body.method==='get_runtime_identity'?{instance_id:process.env.CRABOT_INSTANCE_ID,module_id:'crabot-agent',runtime_id:process.env.CRABOT_MODULE_RUNTIME_ID}:{};
          res.end(JSON.stringify({id:body.id,success:true,data}));if(body.method==='shutdown')setTimeout(()=>process.exit(0),25);
        });server.listen(Number(process.env.Crabot_PORT),'127.0.0.1',()=>fs.writeFileSync(process.env.TEST_GATE_READY,'ready'));
        setTimeout(()=>process.exit(1),300000).unref();`)
      const moduleDefinition = { ...originalDefinition, port: archivedState.modules.modules.find((module: any) => module.module_id === modulePlan.module_id).module_port,
        cwd: f.data, skip_health_check: false, env: { ...originalDefinition.env, TEST_GATE_OBSERVED: observed, TEST_GATE_RECEIPT: receipt, TEST_GATE_CALLS: finiteCalls, TEST_GATE_READY: finiteReady }, entry: `"${process.execPath}" "${finiteModule}"` }
      const startPermit = Object.freeze({})
      cold.modules.set(modulePlan.module_id, moduleDefinition)
      // This constructor fixture has no Admin.onStart; keep the real cutover gate separately verified.
      const managementOnly = cold.managementOnly
      await expect(cold.startModuleProcess(modulePlan.module_id)).rejects.toMatchObject({ code: 'MODULE_MANAGER_CUTOVER_INCOMPLETE' })
      cold.managementOnly = false
      cold.workspaceValidationPermits.set(startPermit, { moduleId: modulePlan.module_id, runtime: moduleDefinition, runtimeId: modulePlan.runtime_id, recoveryId: startRequest.recovery_id,
        verify: startPreparation.verify, assertCurrent: () => { expect(cold.modules.get(modulePlan.module_id)).toBe(moduleDefinition) } })
      let submissions = 0, observations = 0, sent: { mockRestore(): void } | undefined, timeout: { mockRestore(): void } | undefined
      const originalEmit = ChildProcess.prototype.emit, originalTimeout = global.setTimeout
      const dropped = vi.spyOn(ChildProcess.prototype, 'emit').mockImplementation(function (this: ChildProcess, event: string, ...args: any[]) {
        if (event === 'message' && args[0]?.kind === 'workspace_runtime_gate_ready' && !sent) {
          const originalSend = this.send
          sent = vi.spyOn(this, 'send').mockImplementation((message: any, ...values: any[]) => {
            if (message?.kind === 'workspace_runtime_gate_start') submissions++
            if (message?.kind === 'workspace_runtime_gate_observe') observations++
            return Reflect.apply(originalSend, this, [message, ...values])
          })
          timeout = vi.spyOn(global, 'setTimeout').mockImplementation(((callback: any, delay: number, ...values: any[]) => originalTimeout(callback, delay === 60000 ? 1500 : delay, ...values)) as any)
        }
        return event === 'message' && args[0]?.kind === 'workspace_runtime_gate_started' ? true : Reflect.apply(originalEmit, this, [event, ...args])
      })
      try {
        await cold.startModuleProcess(modulePlan.module_id, undefined, undefined, startPermit)
        expect(submissions).toBe(1); expect(observations).toBe(1)
        await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(observed, 'utf8')).registered).toBe(true), { timeout: 15000 })
        const child = cold.processes.get(modulePlan.module_id), data = JSON.parse(await fs.readFile(observed, 'utf8'))
        expect(data).toMatchObject({ parent: child.pid, runtime: modulePlan.runtime_id, registered: true })
        expect(data.pid).not.toBe(child.pid)
        expect(recoveryRecords.readWorkspaceRecoveryRuntimeStart(f.data, startRequest.recovery_id, modulePlan.module_id).runtime.root_pid).toBe(child.pid)
        expect(cold.childStates.get(child).runtimeId).toBe(modulePlan.runtime_id)
        await vi.waitFor(async () => expect(await fs.readFile(finiteReady, 'utf8')).toBe('ready'), { timeout: 15000 })
        await startPreparation.verify()
        startCoordinator.close()
        await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([startCoordinator.launch.process]).state).toBe('stopped'), { timeout: 15000 })
        const cleanupRequest = { ...request, recovery_id: randomUUID() }, admin = cold.processes.get('admin-web')
        const processApi = require('../../scripts/lib/process-identity.cjs'), signals = vi.spyOn(processApi, 'terminateKnownProcess')
        let cleanupCoordinator: any
        const gracefulTimeout = cold.config.shutdown_timeout
        try {
          const unrelated = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),300000)'], { detached: process.platform !== 'win32', stdio: 'ignore' })
          const unrelatedExited = once(unrelated, 'exit'), unknownRuntimeId = randomUUID(), deniedRequest = { ...request, recovery_id: randomUUID() }
          await once(unrelated, 'spawn')
          const unrelatedIdentity = processApi.inspectProcess(unrelated.pid)
          try {
            await cold.runtimeRegistry.recordSpawn({ runtimeId: unknownRuntimeId, moduleId: 'unrelated-fixture', rootPid: unrelated.pid, modulePort: 19099 })
            await expect(cold.cleanupWorkspaceRecoveryRuntimes(deniedRequest, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
            await expect(cold.cleanupWorkspaceRecoveryRuntimes(deniedRequest, 'fixture-human')).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_RECOVERY_COORDINATOR' })
            expect(signals).not.toHaveBeenCalled()
            expect(processApi.sameProcess(unrelatedIdentity, processApi.inspectProcess(unrelated.pid))).toBe(true)
            expect(processApi.sameProcess(recoveryRecords.readWorkspaceRecoveryRuntimeStart(f.data, startRequest.recovery_id, modulePlan.module_id).process, processApi.inspectProcess(child.pid))).toBe(true)
            expect((await cold.runtimeRegistry.listRecords()).some((row: any) => row.runtime_id === unknownRuntimeId)).toBe(true)
            await expect(fs.lstat(finiteCalls)).rejects.toMatchObject({ code: 'ENOENT' })
            const denied = recoveryRecords.readWorkspaceRecoveryCoordinator(f.data, deniedRequest.recovery_id)
            await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([denied.launch.process]).state).toBe('stopped'), { timeout: 15000 })
          } finally {
            if (require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([unrelatedIdentity]).state === 'running') processApi.terminateKnownProcess(unrelatedIdentity)
            await unrelatedExited
            await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([unrelatedIdentity]).state).toBe('stopped'), { timeout: 15000 })
            await cold.runtimeRegistry.removeRuntime(unknownRuntimeId)
            signals.mockClear()
          }
          // This assertion exercises graceful RPC, not the fixture's usual 100ms force-stop shortcut.
          cold.config.shutdown_timeout = 30
          const [first, second] = await Promise.all([
            cold.cleanupWorkspaceRecoveryRuntimes(cleanupRequest, 'fixture-human'),
            cold.cleanupWorkspaceRecoveryRuntimes(cleanupRequest, 'fixture-human'),
          ])
          expect(first).toBe(second)
          const sentTo = signals.mock.calls.map(([target]: any[]) => [target.pid, target.started, target.owner].join(':'))
          expect(new Set(sentTo).size).toBe(sentTo.length)
          expect(JSON.parse(await fs.readFile(finiteCalls, 'utf8'))).toEqual(['get_runtime_identity', 'shutdown'])
          expect(first.runtime_ids).toContain(modulePlan.runtime_id)
          await first.verify()
          expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([recoveryRecords.readWorkspaceRecoveryRuntimeStart(f.data, startRequest.recovery_id, modulePlan.module_id).process]).state).toBe('stopped')
          expect([...cold.processes.keys()]).toEqual(['admin-web'])
          expect(cold.processes.get('admin-web')).toBe(admin)
          expect((await cold.runtimeRegistry.listRecords()).filter((row: any) => row.module_id !== 'admin-web')).toEqual([])
          expect(await fs.readFile(ledgerFile)).toEqual(ledger)
          expect(await fs.readFile(fenceFile)).toEqual(before)
          expect((await fetch(`http://127.0.0.1:${f.port}/api/friends`, { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(200)
          cleanupCoordinator = await cold.initializeWorkspaceRelocationRecovery(cleanupRequest, 'fixture-human')
        } finally {
          cold.config.shutdown_timeout = gracefulTimeout
          signals.mockRestore()
          cleanupCoordinator?.close()
          if (cleanupCoordinator) await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([cleanupCoordinator.launch.process]).state).toBe('stopped'), { timeout: 15000 })
        }
      } finally {
        dropped.mockRestore(); sent?.mockRestore(); timeout?.mockRestore()
        cold.workspaceValidationPermits.delete(startPermit)
        await cold.stopModuleProcess(modulePlan.module_id, 'forced')
        startCoordinator.close()
        await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([startCoordinator.launch.process]).state).toBe('stopped'), { timeout: 15000 })
        cold.modules.set(modulePlan.module_id, originalDefinition)
        cold.managementOnly = managementOnly
      }
      const orphanRequest = { ...request, recovery_id: randomUUID() }, orphanCoordinator = await cold.initializeWorkspaceRelocationRecovery(orphanRequest, 'fixture-human')
      const orphanPreparation = await cold.prepareWorkspaceRecoveryRuntimes(orphanRequest, 'fixture-human')
      await verifyRegisteredRuntimeGate({ manager: cold, dataDir: f.data, coordinator: orphanCoordinator, preparation: orphanPreparation, modules: archivedState.modules.modules,
        afterClose: async ({ identity, start }: any) => {
          orphanCoordinator.close()
          await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([orphanCoordinator.launch.process]).state).toBe('stopped'), { timeout: 15000 })
          const currentRequest = { ...request, recovery_id: randomUUID() }
          let currentCoordinator: any
          try {
            const cleaned = await cold.cleanupWorkspaceRecoveryRuntimes(currentRequest, 'fixture-human')
            await cleaned.verify()
            expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([identity]).state).toBe('stopped')
            expect((await cold.runtimeRegistry.listRecords()).filter((row: any) => row.module_id !== 'admin-web')).toEqual([])
            currentCoordinator = await cold.initializeWorkspaceRelocationRecovery(currentRequest, 'fixture-human')
          } finally {
            currentCoordinator?.close()
            if (currentCoordinator) await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([currentCoordinator.launch.process]).state).toBe('stopped'), { timeout: 15000 })
          }
          // Simulate interruption after a confirmed tree exit but before its exact record was removed.
          const recordFile = path.join(f.data, 'module-runtime-registry/records', start.runtime.runtime_id + '.json')
          await fs.writeFile(recordFile, JSON.stringify(start.runtime) + '\n', { mode: 0o600 })
          const stoppedRequest = { ...request, recovery_id: randomUUID() }
          let stoppedCoordinator: any
          try {
            if (process.platform === 'win32') {
              await expect(cold.cleanupWorkspaceRecoveryRuntimes(stoppedRequest, 'fixture-human')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
              expect((await cold.runtimeRegistry.listRecords()).some((row: any) => row.runtime_id === start.runtime.runtime_id)).toBe(true)
              const stopped = recoveryRecords.readWorkspaceRecoveryCoordinator(f.data, stoppedRequest.recovery_id)
              await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([stopped.launch.process]).state).toBe('stopped'), { timeout: 15000 })
            } else {
              const cleaned = await cold.cleanupWorkspaceRecoveryRuntimes(stoppedRequest, 'fixture-human')
              await cleaned.verify()
              expect((await cold.runtimeRegistry.listRecords()).some((row: any) => row.runtime_id === start.runtime.runtime_id)).toBe(false)
              stoppedCoordinator = await cold.initializeWorkspaceRelocationRecovery(stoppedRequest, 'fixture-human')
            }
          } finally {
            stoppedCoordinator?.close()
            if (stoppedCoordinator) await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([stoppedCoordinator.launch.process]).state).toBe('stopped'), { timeout: 15000 })
            await cold.runtimeRegistry.removeRuntime(start.runtime.runtime_id)
          }
        } })
      for (const changed of ['runtime plan', 'environment', 'selected root', 'closed ledger']) {
        const inspectRequest = { ...request, recovery_id: randomUUID() }
        const inspected = await cold.initializeWorkspaceRelocationRecovery(inspectRequest, 'fixture-human')
        const facts = await cold.inspectWorkspaceRelocationRecovery(inspectRequest, 'fixture-human')
        const preparation = await cold.prepareWorkspaceRecoveryRuntimes(inspectRequest, 'fixture-human')
        const planFile = path.join(inspected.launch.control_root.path, 'runtime-plan.json'), planBytes = await fs.readFile(planFile)
        const allocate = vi.spyOn(cold.runtimeRegistry, 'createRuntimeId'), oldRootOverride = process.env.WORKER_WORKSPACES_DIR
        const selectedRoot = records.readWorkspaceRelocationArchivedState(f.data, request.intent_id).published.target.path
        try {
          if (changed === 'selected root') { await fs.rename(selectedRoot, selectedRoot + '-retained'); await fs.mkdir(selectedRoot) }
          else if (changed === 'runtime plan') await fs.writeFile(planFile, JSON.stringify({ ...preparation.plan, unexpected: true }))
          else if (changed === 'environment') process.env.WORKER_WORKSPACES_DIR = path.join(f.root, 'foreign-override')
          else await fs.appendFile(ledgerFile, ' ')
          await expect(cold.prepareWorkspaceRecoveryRuntimes(inspectRequest, 'fixture-human')).rejects.toBeDefined()
          expect(allocate).not.toHaveBeenCalled()
        } finally {
          allocate.mockRestore()
          if (changed === 'selected root') { await fs.rmdir(selectedRoot); await fs.rename(selectedRoot + '-retained', selectedRoot) }
          else if (changed === 'runtime plan') await fs.writeFile(planFile, planBytes)
          else if (changed === 'environment') { if (oldRootOverride === undefined) delete process.env.WORKER_WORKSPACES_DIR; else process.env.WORKER_WORKSPACES_DIR = oldRootOverride }
          else await fs.writeFile(ledgerFile, ledger)
        }
        await expect(preparation.verify()).rejects.toBeDefined()
        await expect(facts.verify()).rejects.toBeDefined()
        await expect(inspected.verify()).rejects.toBeDefined()
        await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([inspected.launch.process]).state).toBe('stopped'), { timeout: 15000 })
        expect(await fs.readFile(fenceFile)).toEqual(before)
      }
      expect(await fs.readFile(fenceFile)).toEqual(before)
      const historyRequest = { ...request, recovery_id: randomUUID() }
      const history = recoveryRecords.readWorkspaceRecoveryRuntimeHistory(f.data, historyRequest)
      expect(history).toHaveLength(7)
      expect(history.map((item: any) => item.recovery_id)).toContain(startRequest.recovery_id)
      const startHistory = history.find((item: any) => item.recovery_id === startRequest.recovery_id)
      expect(startHistory.plan).toEqual(startPreparation.plan)
      expect(startHistory.starts[0].runtime.runtime_id).toBe(modulePlan.runtime_id)
      expect(history.filter((item: any) => item.starts.length === 0)).toHaveLength(4)
      expect(recoveryRecords.readWorkspaceRecoveryRuntimeHistory(f.data, startRequest)).toHaveLength(6)
      const oldPlanFile = path.join(startCoordinator.launch.control_root.path, 'runtime-plan.json'), oldPlanBytes = await fs.readFile(oldPlanFile)
      await fs.writeFile(oldPlanFile, 'null')
      try { expect(() => recoveryRecords.readWorkspaceRecoveryRuntimeHistory(f.data, historyRequest)).toThrow() }
      finally { await fs.writeFile(oldPlanFile, oldPlanBytes) }
      const extraReceipt = path.join(startCoordinator.launch.control_root.path, 'runtime-starts/unexpected.json')
      await fs.writeFile(extraReceipt, '{}', { mode: 0o600 })
      try { expect(() => recoveryRecords.readWorkspaceRecoveryRuntimeHistory(f.data, historyRequest)).toThrow() }
      finally { await fs.unlink(extraReceipt) }
      const emptyAttempt = path.join(f.data, 'workspace-control/relocation-recovery', randomUUID())
      const native = require('../../scripts/lib/process-identity.cjs')
      if (process.platform === 'win32') native.createPrivateDirectory(emptyAttempt)
      else await fs.mkdir(emptyAttempt, { mode: 0o700 })
      try {
        expect(recoveryRecords.readWorkspaceRecoveryRuntimeHistory(f.data, historyRequest)).toEqual(history)
        const starts = path.join(emptyAttempt, 'runtime-starts')
        if (process.platform === 'win32') native.createPrivateDirectory(starts)
        else await fs.mkdir(starts, { mode: 0o700 })
        try { expect(() => recoveryRecords.readWorkspaceRecoveryRuntimeHistory(f.data, historyRequest)).toThrow() }
        finally { await fs.rmdir(starts) }
      } finally { await fs.rmdir(emptyAttempt) }
      expect(recoveryRecords.readWorkspaceRecoveryRuntimeHistory(f.data, historyRequest)).toEqual(history)
    } finally {
      if (cold) await cold.stop()
      const child = f.manager.workspaceValidationProof?.result.coordinator
      if (child?.connected) { const ended = once(child, 'exit'); child.disconnect(); await ended }
      locks.releaseCliLock(lock); await f.cleanup()
    }
  }, process.platform === 'win32' || process.platform === 'darwin' && process.arch === 'x64' ? 600000 : 120000)
  const hasNativeRelease = typeof require('../../scripts/lib/process-identity.cjs').renameFileNoReplace === 'function'
  const resumeModes = hasNativeRelease ? ['resume running module', 'resume inactive module', 'resume tool',
    ...(process.env.GITHUB_ACTIONS === 'true' && process.env.CRABOT_WORKSPACE_BUSINESS_ONSTART_CI === '1' ? ['resume actual Admin startup'] : [])] : []
  const releaseModes = [...resumeModes, ...(hasNativeRelease ? ['completion release', 'lost release acknowledgement'] : ['release unavailable']),
    ...(process.platform !== 'win32' && process.getuid?.() !== 0 ? ['release readonly root'] : [])]
  it.each(['Agent', 'Agent and Memory', 'catalog changed after probe', 'completion observation', 'released without observation', 'definition changed before release', 'plan changed before release', 'record changed during assertion', 'owned recovery status', 'released current observation', ...releaseModes])('starts only the planned cold validation generations: %s', async mode => {
    const caseStarted = performance.now()
    const phase = (stage: string) => console.log('[Cold workspace stage]', { mode, stage, elapsed_ms: Math.round(performance.now() - caseStarted) })
    const withMemory = mode === 'Agent and Memory'
    const checkRpcContract = !resumeModes.includes(mode) || mode === 'resume actual Admin startup'
    const extraModule = mode === 'resume tool' ? 'tool' : ['resume inactive module', 'resume actual Admin startup'].includes(mode) ? 'inactive' : mode === 'resume running module' ? 'running' : undefined
    const processLifetimeMs = process.platform === 'win32' ? 900000 : 300000
    const f = await fixture({ actualAgent: true, actualAdmin: true, extraModule, ...(mode === 'catalog changed after probe' ? { adminReadyDelayMs: 1100 } : {}), validationHealth: 'healthy', withMemory, inactiveMemory: !withMemory, memoryHealth: withMemory ? 'healthy' : undefined, processLifetimeMs })
    let human = 'fixture-human', webPort = f.port
    const actualAdminStartup = mode === 'resume actual Admin startup'
    const locks = require('../../scripts/lib/cli-lock.mjs'), records = require('../../scripts/lib/workspace-relocation-intent.mjs')
    const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    let cold: any, coordinator: any
    try {
      const prepared = await f.manager.prepareWorkspaceRelocationCompletion(f.params, human)
      phase('warm-prepared')
      const definitions = new Map([...f.manager.modules].map(([id, runtime]: any) => [id, { ...runtime }]))
      await f.manager.stop()
      const fence = records.readWorkspaceRelocationFinalizing(f.data, f.params.intent_id), fenceFile = path.join(f.data, 'workspace-control/relocation-finalizing.json')
      const before = await fs.readFile(fenceFile), ledgerFile = path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), ledger = await fs.readFile(ledgerFile)
      const request = { intent_id: f.params.intent_id, recovery_id: randomUUID(), completion_sha256: prepared.completion_sha256, finalizing_sha256: sha256CanonicalJson(fence) }
      if (mode === 'Agent') {
        let reads = 0
        const originalRead = syncFs.readFileSync
        const counting = vi.spyOn(syncFs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
          if (typeof file === 'number') reads++
          return (originalRead as any)(file, ...args)
        }) as any)
        try { require('../../scripts/lib/workspace-recovery-admission.mjs').readWorkspaceRecoveryCompletionScope(f.data, request) }
        finally { counting.mockRestore() }
        console.log('[Recovery fixed scope reads]', { reads })
        expect(reads).toBeLessThanOrEqual(256)
      }
      const entry = path.join(f.data, 'cold-finite-runtime.cjs')
      await fs.writeFile(entry, `const fs=require('node:fs'),http=require('node:http');const receipt=JSON.parse(fs.readFileSync(process.env.TEST_RECEIPT,'utf8'));
        fs.writeFileSync(process.env.TEST_MARKER,JSON.stringify({pid:process.pid,parent:process.ppid,runtime:process.env.CRABOT_MODULE_RUNTIME_ID,receipt}));
        let agent;
        if(process.env.TEST_MODULE_ID==='crabot-agent'){
          require(${JSON.stringify(path.resolve('../crabot-agent/dist/core/config-loader.js'))}).ConfigLoader.captureRuntimeBearer();
          const{UnifiedAgent}=require(${JSON.stringify(path.resolve('../crabot-agent/dist/unified-agent.js'))}),config=${JSON.stringify(relocationAgentConfig)};
          config.port=Number(process.env.Crabot_PORT);agent=new UnifiedAgent(config);agent.getHealthStatus=async()=> fs.existsSync(process.env.TEST_UNHEALTHY)&&fs.readFileSync(process.env.TEST_UNHEALTHY,'utf8')===process.env.TEST_MODULE_ID?'unhealthy':'healthy';
          // Finite Core configuration health only; this case exercises real Admin main, not Provider resolution.
          if(${actualAdminStartup})agent.getHealthDetails=async()=>({llm_status:'ready'});
        }
        let rootReads=0;const read=fs.readFileSync;
        if(${mode === 'Agent'})fs.readFileSync=function(file,...args){if(typeof file==='number')rootReads++;return read.call(this,file,...args)};
        const server=http.createServer(async(req,res)=>{
          if(${mode === 'Agent'}&&req.url==='/verify_workspace_relocation_recovery_root'){
            const before=rootReads,began=performance.now();res.once('finish',()=>console.log(JSON.stringify({event:'finite_cold_root_reads',reads:rootReads-before,elapsed_ms:Math.round(performance.now()-began)})));
          }
          if(agent&&req.url!=='/shutdown'){await agent.handleRequest(req,res);return}
          let text='';for await(const part of req)text+=part;const body=JSON.parse(text);
          const data=body.method==='get_runtime_identity'?{instance_id:process.env.CRABOT_INSTANCE_ID,module_id:process.env.TEST_MODULE_ID,runtime_id:process.env.CRABOT_MODULE_RUNTIME_ID}:body.method==='health'?{status:fs.existsSync(process.env.TEST_UNHEALTHY)&&fs.readFileSync(process.env.TEST_UNHEALTHY,'utf8')===process.env.TEST_MODULE_ID?'unhealthy':'healthy'}:{};
          if(body.method==='shutdown'&&agent)await agent.managerStack.dispose();
          res.end(JSON.stringify({id:body.id,success:true,data}));if(body.method==='shutdown')setTimeout(()=>process.exit(0),25);
        });server.listen(Number(process.env.Crabot_PORT),'127.0.0.1',()=>fs.writeFileSync(process.env.TEST_MARKER+'.ready','ready'));
        setTimeout(()=>process.exit(0),${processLifetimeMs});`)
      cold = new ModuleManager({ port: 0, modules: [], shutdown_timeout: 0.1 }, f.data) as any
      for (const [id, definition] of definitions as Map<string, any>) {
        const env = { ...definition.env, TEST_MODULE_ID: id, TEST_UNHEALTHY: path.join(f.data, 'cold-health-unhealthy'), TEST_RECEIPT: path.join(f.data, 'workspace-control/relocation-recovery', request.recovery_id, 'runtime-starts', id + '.json'), TEST_MARKER: path.join(f.data, 'cold-start-' + id + '.json') }
        const core = id === 'crabot-agent' || id === 'memory-default'
        cold.modules.set(id, { ...definition, status: 'stopped', pid: undefined, auto_start: false, ...(core ? { entry: `"${process.execPath}" "${entry}"`, skip_health_check: true, env } : {}) })
      }
      if (actualAdminStartup) {
        if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CRABOT_WORKSPACE_BUSINESS_ONSTART_CI !== '1') throw new Error('Actual Admin startup is isolated CI only')
        const web = await reserveFixturePort(); webPort = (web.address() as { port: number }).port
        await new Promise<void>(resolve => web.close(() => resolve()))
        const admin = cold.modules.get('admin-web')
        const adminMain = path.join(f.data, 'cold-admin-main.cjs')
        await fs.writeFile(adminMain, `
          ${observeActualAdminRecoveryRpc(path.join(f.data, 'calls.json'))}
          setTimeout(()=>process.exit(1),${processLifetimeMs}).unref();require(${JSON.stringify(path.resolve('../crabot-admin/dist/main.js'))});`)
        admin.entry = `"${process.execPath}" "${adminMain}"`
        admin.skip_health_check = false
        admin.env = { ...admin.env, CRABOT_ADMIN_DATA_DIR: path.join(f.data, 'admin'), CRABOT_ADMIN_WEB_PORT: String(webPort) }
        const packageDir = path.join(f.data, 'finite-channel-package')
        await fs.mkdir(path.join(packageDir, 'dist'), { recursive: true })
        await fs.writeFile(path.join(packageDir, 'dist/main.js'), 'throw new Error("Previously inactive channel must not auto-start")')
        const { ChannelManager } = require('../../crabot-admin/dist/channel-manager.js')
        await fs.mkdir(path.join(f.data, 'admin'), { recursive: true })
        const channels = new ChannelManager(path.join(f.data, 'admin'), { registerModuleDefinition: async () => ({}), startModule: async () => ({}) })
        await channels.addImplementation({ id: 'channel-fixture-cold', name: 'finite cold channel', platform: 'fixture', type: 'builtin',
          module_path: path.relative(path.resolve('../crabot-admin'), packageDir), version: '0.1.0', created_at: '', updated_at: '' })
        await channels.createInstance({ name: 'fixture-channel', implementation_id: 'channel-fixture-cold', auto_start: true })
        cold.modules.delete('fixture-channel')
        const credentials = require('../../crabot-admin/dist/credentials.js')
        await credentials.writeCredentials(path.join(f.data, 'admin'), await credentials.newCredentialsFromPassword('finite-cold-startup-password', { is_temp: false, changed_via: 'start' }))
        await fs.writeFile(path.join(f.data, 'port-allocations.json'), JSON.stringify([...definitions.values()].map((runtime: any) => ({ module_id: runtime.module_id, port: runtime.port, allocated_at: new Date().toISOString() }))))
      }
      await cold.start(); cold.config.port = cold.server.address().port
      await fs.unlink(path.join(f.data, 'ready')); await cold.startModuleProcess('admin-web')
      if (actualAdminStartup) {
        await vi.waitFor(async () => {
          const response = await fetch(`http://127.0.0.1:${webPort}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'finite-cold-startup-password' }) })
          expect(response.status).toBe(200)
          human = ((await response.json()) as { token: string }).token
          expect(human).toBeTruthy(); expect(cold.managementOnly).toBe(false)
          expect(cold.modules.get('fixture-channel')?.auto_start).toBe(true)
          expect(cold.processes.has('fixture-channel')).toBe(false)
          expect(await cold.sendToModule(f.port, 'health', {})).toMatchObject({ status: 'degraded', details: { recovery_reason: 'workspace maintenance is waiting for authenticated recovery' } })
        }, { timeout: 30000, interval: 250 })
        expect((await fetch(`http://127.0.0.1:${webPort}/api/chat/tasks`, { headers: { Authorization: 'Bearer ' + human } })).status).toBe(503)
      } else {
        await vi.waitFor(async () => expect(await fs.readFile(path.join(f.data, 'ready'), 'utf8')).toBe('ready'), { timeout: 10000 })
        // Constructors/finite processes only; actual startup consumes its own handshake above.
        cold.managementOnly = false
      }
      phase('cold-admin-ready')
      expect(typeof cold.startWorkspaceRecoveryValidationModules).toBe('function')
      coordinator = await cold.initializeWorkspaceRelocationRecovery(request, human)
      phase('current-coordinator-ready')
      if (mode.endsWith('before release')) {
        const recoveryRecords = require('../../scripts/lib/workspace-recovery-records.mjs')
        const authorize = cold.assertWorkspaceProcessStartAllowed.bind(cold)
        const starts = vi.spyOn(cold, 'startModuleProcess')
        let restore: () => Promise<void> = async () => {}
        let injected = false
        const tamper = vi.spyOn(cold, 'assertWorkspaceProcessStartAllowed').mockImplementation(async (...args: any[]) => {
          await authorize(...args)
          if (injected || !recoveryRecords.readWorkspaceRecoveryRuntimeStart(f.data, request.recovery_id, args[0])) return
          injected = true
          if (mode.startsWith('definition')) {
            const runtime = cold.modules.get(args[0]), port = runtime.port
            runtime.port++
            restore = async () => { runtime.port = port }
          } else {
            const file = path.join(coordinator.launch.control_root.path, 'runtime-plan.json'), bytes = await fs.readFile(file)
            const plan = JSON.parse(bytes.toString()); plan.created_at = new Date(Date.parse(plan.created_at) + 1000).toISOString()
            await fs.writeFile(file, JSON.stringify(plan))
            restore = async () => { await fs.writeFile(file, bytes) }
          }
        })
        try {
          await expect(Promise.all([
            cold.startWorkspaceRecoveryValidationModules(request, human),
            cold.startWorkspaceRecoveryValidationModules(request, human),
          ])).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
          await restore()
          await expect(cold.startWorkspaceRecoveryValidationModules(request, human)).rejects.toBeDefined()
          expect(injected).toBe(true); expect(starts).toHaveBeenCalledOnce()
          await expect(fs.lstat(path.join(f.data, 'cold-start-crabot-agent.json'))).rejects.toMatchObject({ code: 'ENOENT' })
          expect(await fs.readFile(fenceFile)).toEqual(before); expect(await fs.readFile(ledgerFile)).toEqual(ledger)
          expect(recoveryRecords.readWorkspaceRecoveryRuntimeStart(f.data, request.recovery_id, 'crabot-agent')).not.toBeNull()
        } finally { await restore(); tamper.mockRestore(); starts.mockRestore() }
        return
      }
      const [started, concurrent] = await Promise.all([
        cold.startWorkspaceRecoveryValidationModules(request, human),
        cold.startWorkspaceRecoveryValidationModules(request, human),
      ])
      expect(concurrent).toBe(started)
      coordinator = await cold.initializeWorkspaceRelocationRecovery(request, human)
      await started.verify()
      const ids = withMemory ? ['crabot-agent', 'memory-default'] : ['crabot-agent']
      expect(started.modules.map((item: any) => item.module_id).sort()).toEqual(ids)
      const rows = (await cold.runtimeRegistry.listRecords()).filter((row: any) => row.module_id !== 'admin-web')
      expect(rows).toHaveLength(ids.length)
      for (const module of started.modules) {
        const file = path.join(f.data, 'cold-start-' + module.module_id + '.json')
        await vi.waitFor(async () => expect(await fs.readFile(file, 'utf8')).toBeTruthy())
        await vi.waitFor(async () => expect(await fs.readFile(file + '.ready', 'utf8')).toBe('ready'), { timeout: 15000 })
        const marker = JSON.parse(await fs.readFile(file, 'utf8'))
        expect(marker).toMatchObject({ parent: module.process.pid, runtime: module.runtime_id,
          receipt: { process: module.process, runtime: { root_pid: module.process.pid, runtime_id: module.runtime_id } } })
        expect(marker.pid).not.toBe(module.process.pid)
        expect(started.plan.modules).toContainEqual({ module_id: module.module_id, runtime_id: module.runtime_id })
      }
      expect(await cold.startWorkspaceRecoveryValidationModules(request, human)).toBe(started)
      expect((await cold.runtimeRegistry.listRecords()).filter((row: any) => row.module_id !== 'admin-web')).toEqual(rows)
      expect(await fs.readFile(fenceFile)).toEqual(before); expect(await fs.readFile(ledgerFile)).toEqual(ledger)
      const token = cold.runtimeBearers.get('crabot-agent').token
      const call = async (params: any, bearer?: string) => {
        const response = await fetch(`http://127.0.0.1:${cold.config.port}/verify_workspace_relocation_recovery_runtime`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
          body: JSON.stringify({ id: randomUUID(), source: 'forged-source', method: 'verify_workspace_relocation_recovery_runtime', params }) })
        return response.json()
      }
      if (checkRpcContract) {
        expect(await call({ unexpected: true })).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } })
        expect(await call({ unexpected: true }, human)).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } })
        expect(await call({ ...request, unexpected: true }, token)).toMatchObject({ success: false, error: { code: 'INVALID_PARAMS' } })
        expect(await call({ ...request, recovery_id: randomUUID() }, token)).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } })
      }
      const proof = { verified: true, ...request, launch_sha256: sha256CanonicalJson(coordinator.launch), plan_sha256: sha256CanonicalJson(started.plan),
        root_selected_sha256: started.plan.root_selected_sha256, instance_id: cold.runtimeRegistry.getInstanceId(), module_id: 'crabot-agent',
        runtime_id: started.modules.find((module: any) => module.module_id === 'crabot-agent').runtime_id }
      expect(await call(request, token)).toMatchObject({ success: true, data: proof })
      const callRoot = async (params: any, bearer?: string) => {
        const response = await fetch(`http://127.0.0.1:${cold.modules.get('crabot-agent').port}/verify_workspace_relocation_recovery_root`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
          body: JSON.stringify({ id: randomUUID(), source: 'forged-source', method: 'verify_workspace_relocation_recovery_root', params }) })
        return response.json()
      }
      if (checkRpcContract) {
        expect(await callRoot(request)).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } })
        expect(await callRoot({ unexpected: true }, human)).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } })
        expect(await callRoot({ ...request, unexpected: true }, token)).toMatchObject({ success: false, error: { code: 'INVALID_PARAMS' } })
      }
      const root = records.readWorkspaceRelocationArchivedState(f.data, request.intent_id).published.target.path, files = await fs.readdir(root)
      expect(await callRoot(request, token)).toMatchObject({ success: true, data: proof })
      const probedAt = (await fs.stat(root, { bigint: true })).mtimeNs
      if (checkRpcContract) expect(await callRoot(request, token)).toMatchObject({ success: true, data: proof })
      expect((await fs.stat(root, { bigint: true })).mtimeNs).toBe(probedAt)
      expect(await fs.readdir(root)).toEqual(files)
      expect(typeof cold.verifyWorkspaceRecoveryValidationHealth).toBe('function')
      const health = await cold.verifyWorkspaceRecoveryValidationHealth(request, human)
      expect(health.healthy_modules.map((module: any) => module.module_id).sort()).toEqual(ids)
      expect(health.root_verified).toEqual(proof)
      if (mode === 'Agent') {
        let windows: Array<{ reads: number }> = []
        await vi.waitFor(async () => {
          const log = await fs.readFile(path.join(f.data, 'logs/crabot-agent.log'), 'utf8')
          windows = log.split('\n').filter(line => line.startsWith('{"event":"finite_cold_root_reads"')).map(line => JSON.parse(line))
          expect(windows.some(item => item.reads > 0)).toBe(true)
        })
        expect(Math.max(...windows.map(item => item.reads))).toBeLessThanOrEqual(1400)
        const successfulReads = windows.filter(item => item.reads > 0)
        expect(successfulReads.length).toBeGreaterThan(1)
        expect(Math.max(...successfulReads.slice(1).map(item => item.reads))).toBeLessThanOrEqual(320)
        let reads = 0, verifies = 0
        const originalRead = syncFs.readFileSync, originalSend = coordinator.child.send.bind(coordinator.child)
        const counting = vi.spyOn(syncFs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
          if (typeof file === 'number') reads++
          return (originalRead as any)(file, ...args)
        }) as any)
        const sending = vi.spyOn(coordinator.child, 'send').mockImplementation((message: any, ...args: any[]) => {
          if (message?.kind === 'workspace_recovery_verify') verifies++
          return originalSend(message, ...args)
        })
        const started = performance.now()
        try { await health.verify() }
        finally { counting.mockRestore(); sending.mockRestore() }
        console.log('[Recovery finite health cost]', { reads, verifies, elapsed_ms: Math.round(performance.now() - started) })
        expect(verifies).toBe(40)
        expect(reads).toBeLessThanOrEqual(12000)
      } else await health.verify()
      phase('current-root-health')
      if (mode === 'record changed during assertion') {
        const launched = await cold.startWorkspaceRecoveryValidationModules(request, human)
        const file = path.join(fence.archive_path, 'relocation.json'), bytes = await fs.readFile(file), lstat = syncFs.lstatSync
        let changed = false, failure: unknown
        const inject = vi.spyOn(syncFs, 'lstatSync').mockImplementation(((name: any, ...args: any[]) => {
          const stat = (lstat as any)(name, ...args)
          if (!changed && name === file && new Error().stack?.includes('verifyRecordObservation')) {
            changed = true; syncFs.appendFileSync(file, ' ')
          }
          return stat
        }) as any)
        try { try { launched.assertCurrent() } catch (error) { failure = error } }
        finally { inject.mockRestore(); await fs.writeFile(file, bytes) }
        expect(changed).toBe(true); expect(failure).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
        expect(() => launched.assertCurrent()).toThrow()
        await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([coordinator.launch.process]).state).toBe('stopped'), { timeout: 15000 })
        return
      }
      expect((await fs.stat(root, { bigint: true })).mtimeNs).toBe(probedAt)
      if (mode === 'owned recovery status') {
        let entered!: () => void, reject!: (cause: Error) => void
        const waiting = new Promise<void>(resolve => { entered = resolve })
        const holding = new Promise((_, no) => { reject = no })
        const resume = vi.spyOn(cold, 'resumeWorkspaceRecoveryWeb').mockImplementation(() => { entered(); return holding })
        const completion = cold.completeWorkspaceRecovery(request, human).then(() => undefined, (error: unknown) => error)
        try {
          await waiting
          const expected = { available: true, job: { intent_id: request.intent_id, state: 'running', stage: 'restoring', source: path.join(f.data, 'workspaces'), target: root } }
          expect(await cold.getWorkspaceRelocationStatus({}, human)).toEqual(expected)
          expect(await cold.getWorkspaceRelocationStatus({ intent_id: request.intent_id }, human)).toEqual(expected)
          const native = require('../../scripts/lib/process-identity.cjs'), original = native.inspectProcess
          const unknown = vi.spyOn(native, 'inspectProcess').mockImplementation((pid: number) => pid === coordinator.child.pid ? null : original(pid))
          try { expect(await cold.getWorkspaceRelocationStatus({}, human)).toEqual({ available: false, job: null }) }
          finally { unknown.mockRestore() }
          const currentContext = cold.workspaceRecoveryInitialization
          cold.workspaceRecoveryInitialization = undefined
          try { expect(await cold.getWorkspaceRelocationStatus({}, human)).toEqual({ available: false, job: null }) }
          finally { cold.workspaceRecoveryInitialization = currentContext }
          await coordinator.verify()
          expect(await cold.getWorkspaceRelocationStatus({}, human)).toEqual(expected)
          expect(await cold.getWorkspaceRelocationStatus({ intent_id: randomUUID() }, human)).toEqual({ available: true, job: null })
          expect(await fs.readFile(fenceFile)).toEqual(before); expect(await fs.readFile(ledgerFile)).toEqual(ledger)
          reject(new Error('finite recovery intentionally held before restoration'))
          expect(await completion).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
          expect(await cold.getWorkspaceRelocationStatus({ intent_id: request.intent_id }, human)).toEqual({ ...expected, job: { ...expected.job, state: 'needs_attention' } })
          expect(resume).toHaveBeenCalledTimes(1)
        } finally { reject(new Error('finite status cleanup')); await completion; resume.mockRestore() }
        return
      }
      if (mode === 'Agent' || mode === 'released current observation' || releaseModes.includes(mode)) {
        expect(typeof cold.prepareWorkspaceRecoveryCompletion).toBe('function')
        const [prepared, concurrent] = await Promise.all([
          cold.prepareWorkspaceRecoveryCompletion(request, human),
          cold.prepareWorkspaceRecoveryCompletion(request, human),
        ])
        expect(concurrent).toBe(prepared)
        phase('current-web-prepared')
        const adminState = cold.childStates.get(cold.processes.get('admin-web'))
        const expected = { ...request, launch_sha256: proof.launch_sha256, plan_sha256: proof.plan_sha256,
          instance_id: proof.instance_id, admin_runtime_id: adminState.runtimeId }
        expect(prepared).toEqual({ prepared: true, ...expected })
        expect(typeof cold.releaseWorkspaceRecoveryCompletion).toBe('function')
        expect(typeof cold.resumeWorkspaceRecoveryWeb).toBe('function')
        const grant = cold.workspaceRecoveryFinalizationGrant
        const finalization = async (params: any, bearer?: string) => {
          const response = await fetch(`http://127.0.0.1:${cold.config.port}/verify_workspace_relocation_recovery_finalization`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
            body: JSON.stringify({ id: randomUUID(), source: 'forged-source', method: 'verify_workspace_relocation_recovery_finalization', params }) })
          return response.json()
        }
        if (checkRpcContract) {
          expect(await finalization({ unexpected: true })).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } })
          expect(await finalization({ unexpected: true }, human)).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } })
          expect(await finalization({ action: 'prepare_web', unexpected: true }, grant.token)).toMatchObject({ success: false, error: { code: 'INVALID_PARAMS' } })
          expect(await finalization({ action: 'resume_web' }, grant.token)).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } })
          expect(await finalization({ action: 'prepare_web' }, grant.token)).toMatchObject({ success: true, data: { verified: true, ...expected, action: 'prepare_web' } })
        }
        phase('current-finalization-proof-checked')
        const releaseProof = async (params: any, bearer?: string) => {
          const response = await fetch(`http://127.0.0.1:${cold.config.port}/verify_workspace_relocation_recovery_release`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
            body: JSON.stringify({ id: randomUUID(), source: 'forged-source', method: 'verify_workspace_relocation_recovery_release', params }) })
          return response.json()
        }
        if (checkRpcContract) {
          expect(await releaseProof({ unexpected: true })).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } })
          expect(await releaseProof({ unexpected: true }, human)).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } })
          expect(await releaseProof({ ...request, unexpected: true }, grant.token)).toMatchObject({ success: false, error: { code: 'INVALID_PARAMS' } })
          expect(await releaseProof(request, grant.token)).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } })
        }

        const calls = await f.calls()
        expect(calls.filter((item: any) => item.method === '/prepare_workspace_relocation_recovery_completion')).toHaveLength(1)
        expect(JSON.stringify(calls)).not.toContain(grant.token)
        const callPrepare = async (params: any, bearer?: string) => {
          const response = await fetch(`http://127.0.0.1:${f.port}/prepare_workspace_relocation_recovery_completion`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
            body: JSON.stringify({ id: randomUUID(), source: 'forged-source', method: 'prepare_workspace_relocation_recovery_completion', params }) })
          return response.json()
        }
        if (checkRpcContract) {
          expect(await callPrepare({ unexpected: true })).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } })
          expect(await callPrepare({ unexpected: true }, human)).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } })
          expect(await callPrepare({ ...request, unexpected: true }, grant.token)).toMatchObject({ success: false, error: { code: 'INVALID_PARAMS' } })
          expect(await callPrepare({ ...request, recovery_id: randomUUID() }, grant.token)).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } })
          expect(await callPrepare(request, grant.token)).toMatchObject({ success: true, data: prepared })
        }
        expect(JSON.stringify(await f.calls())).not.toContain(grant.token)
        expect((await fetch(`http://127.0.0.1:${webPort}/api/friends`, { headers: { Authorization: 'Bearer ' + human } })).status).toBe(200)
        expect((await fetch(`http://127.0.0.1:${webPort}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + human }, body: '{}' })).status).toBe(503)
        phase('current-web-prepare-http-checked')
        if (mode === 'released current observation') {
          await cold.beginWorkspaceRecoveryCompletionObservation(request, human)
          grant.releasedHealth = cold.observeWorkspaceRecoveryReleasedHealth(request, coordinator, health, grant)
          grant.phase = 'releasing'; grant.verify()
          const native = require('../../scripts/lib/process-identity.cjs'), admission = require('../../scripts/lib/workspace-recovery-admission.mjs')
          const originalRename = native.renameFileNoReplace, releasedFile = path.join(f.data, 'workspace-control/relocation-history', request.intent_id + '.released.json')
          let moved = false
          try {
            // Read-observer fixture only: no coordinator effect acknowledgement or service-restore permission is fabricated.
            native.renameFileNoReplace = (source: string, destination: string) => require('node:fs').renameSync(source, destination)
            try {
              await records.commitWorkspaceRelocationFinalizing({ dataDir: f.data, id: request.intent_id, verify: grant.verifyHealth, assertCurrent: grant.verify,
                checkCapabilities: async (verify: () => Promise<void>) => { await verify() } })
              moved = true
            } finally { native.renameFileNoReplace = originalRename }
            await grant.verifyHealth()
            let reads = 0
            const originalRead = syncFs.readFileSync, counting = vi.spyOn(syncFs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
              if (typeof file === 'number') reads++
              return (originalRead as any)(file, ...args)
            }) as any)
            try { grant.releasedHealth.assertCurrent() }
            finally { counting.mockRestore() }
            console.log('[Released current observation cost]', { reads })
            expect(reads).toBeGreaterThan(0)
            expect(reads).toBeLessThanOrEqual(100)
            const catalog = new WorkspaceCatalog({ dataRoot: f.data, files: native }), previous = await catalog.snapshot()
            await catalog.createProject({ workspace_id: randomUUID(), name: 'Lawful post-release project' })
            expect((await catalog.snapshot()).revision).toBeGreaterThan(previous.revision)
            const afterWrite = (await fs.stat(root, { bigint: true })).mtimeNs
            await grant.verifyHealth()
            expect(await callRoot(request, token)).toMatchObject({ success: true, data: proof })
            expect((await fs.stat(root, { bigint: true })).mtimeNs).toBe(afterWrite)
            await expect(admission.inspectWorkspaceRecoveryControlFacts({ dataDir: f.data, request, verify: async () => {}, readScope: admission.readWorkspaceRecoveryCompletionScope })).rejects.toBeDefined()
            await grant.verifyHealth()
            expect(await finalization({ action: 'resume_web' }, grant.token)).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } })
            expect((await fetch(`http://127.0.0.1:${webPort}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + human }, body: '{}' })).status).toBe(503)
            const state = cold.childStates.get(cold.processes.get('admin-web')), originalId = state.runtimeId
            state.runtimeId = randomUUID(); expect(() => grant.verify()).toThrow(); state.runtimeId = originalId
            expect(grant.revoked).toBe(true); expect(() => grant.verify()).toThrow()
            expect(await fs.readFile(ledgerFile)).toEqual(ledger)
            return
          } finally { native.renameFileNoReplace = originalRename; if (moved) await fs.rename(releasedFile, fenceFile) }
        }
        if (releaseModes.includes(mode)) {
          const child = coordinator.child, send = child.send.bind(child), emit = child.emit.bind(child)
          let lost = false, rootMode: number | undefined
          const sent: string[] = []
          const sending = vi.spyOn(child, 'send').mockImplementation((message: any, ...args: any[]) => { sent.push(message.kind); return send(message, ...args) })
          const receiving = vi.spyOn(child, 'emit').mockImplementation((event: any, ...args: any[]) => {
            if (!lost && mode === 'lost release acknowledgement' && event === 'message' && args[0]?.kind === 'workspace_recovery_released' && args[0].ok === true) {
              lost = true; return emit(event, { ...args[0], ok: false, result: null })
            }
            return emit(event, ...args)
          })
          let stopObserving: (() => void) | undefined
          try {
            if (mode === 'release readonly root') { rootMode = (await fs.stat(root)).mode & 0o777; await fs.chmod(root, 0o500) }
            const restoring = resumeModes.includes(mode), operate = () => restoring ? cold.resumeWorkspaceRecoveryWeb(request, human) : cold.releaseWorkspaceRecoveryCompletion(request, human)
            const start = vi.spyOn(cold, 'startModuleProcess')
            stopObserving = ['resume running module', 'resume actual Admin startup'].includes(mode) && process.env.GITHUB_ACTIONS === 'true' ? observeColdTerminalProgress(cold, coordinator, grant) : undefined
            phase('current-terminal-request')
            const first = operate(), second = operate()
            if (hasNativeRelease && mode !== 'release readonly root') {
              const [released, concurrent] = await Promise.all([first, second])
              phase(restoring ? 'current-web-resumed' : 'current-release-confirmed')
              expect(released).toEqual({ ...(restoring ? { resumed: true } : { released: true }), ...expected }); expect(concurrent).toBe(released)
              expect(await operate()).toBe(released)
              expect(await fs.readFile(path.join(f.data, 'workspace-control/relocation-history', request.intent_id + '.released.json'))).toEqual(before)
              await expect(fs.lstat(fenceFile)).rejects.toMatchObject({ code: 'ENOENT' })
              await grant.verifyHealth()
              expect(await callRoot(request, token)).toMatchObject({ success: true, data: proof })
              if (restoring) {
                if (extraModule) {
                  const id = extraModule === 'tool' ? 'fixture-tool' : 'fixture-channel'
                  const oldScope = records.readWorkspaceRelocationArchivedState(f.data, request.intent_id).modules.modules.find((scope: any) => scope.module_id === id)
                  expect(start.mock.calls.filter((args: any[]) => args[0] === id)).toHaveLength(extraModule === 'inactive' ? 0 : 1)
                  if (extraModule === 'inactive') expect(cold.processes.has(id)).toBe(false)
                  else {
                    const row = (await cold.runtimeRegistry.listRecords()).find((row: any) => row.module_id === id)
                    expect(row.runtime_id).not.toBe(oldScope.runtime_id); expect(cold.modules.get(id).status).toBe('running')
                  }
                }
                expect(await finalization({ action: 'resume_web' }, grant.token)).toMatchObject({ success: true })
                if (actualAdminStartup) expect((await fetch(`http://127.0.0.1:${webPort}/api/chat/messages`, { headers: { Authorization: 'Bearer ' + human } })).status).toBe(200)
                const create = await fetch(`http://127.0.0.1:${webPort}/api/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + human },
                  body: JSON.stringify({ workspace_id: randomUUID(), name: 'After cold recovery' }) })
                const project = await create.json() as any
                expect(create.status, JSON.stringify(project)).toBe(200)
                expect(project.workspace.root.startsWith(path.join(root, 'projects') + path.sep)).toBe(true)
                expect((await fetch(`http://127.0.0.1:${webPort}/api/workspaces/default/usage/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + human }, body: '{}' })).status).toBe(202)
                await grant.verifyHealth(); grant.verifyRestored()
                const firstCompletion = cold.completeWorkspaceRecovery(request, human), nextCompletion = cold.completeWorkspaceRecovery(request, human)
                expect(nextCompletion).toBe(firstCompletion); expect(await firstCompletion).toBe(released)
                expect(await cold.getWorkspaceRelocationStatus({ intent_id: request.intent_id }, human)).toMatchObject({ available: true, job: { intent_id: request.intent_id, state: 'completed', stage: 'finished' } })
                phase('current-coordinator-exited')
                expect(await cold.completeWorkspaceRecovery(request, human)).toBe(released)
                expect(grant.revoked).toBe(true); expect(child.connected).toBe(false)
                expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([coordinator.launch.process]).state).toBe('stopped')
                expect(cold.workspaceRecoveryInitialization).toBeUndefined(); expect(cold.workspaceRecoveryFinalizationGrant).toBeUndefined()
                expect(await finalization({ action: 'resume_web' }, grant.token)).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } })
              } else {
                expect(await finalization({ action: 'resume_web' }, grant.token)).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } })
                expect((await fetch(`http://127.0.0.1:${webPort}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + human }, body: '{}' })).status).toBe(503)
              }
              expect(lost).toBe(mode === 'lost release acknowledgement')
            } else {
              let failure: any
              await expect(first.catch((error: unknown) => { failure = error; throw error })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
              await expect(second).rejects.toBeDefined()
              expect(JSON.stringify(failure)).not.toContain(grant.token)
              expect(failure.cause.diagnostics.length).toBeGreaterThan(0)
              expect(failure.cause.diagnostics.length).toBeLessThanOrEqual(4)
              for (const item of failure.cause.diagnostics) expect(Object.keys(item).sort()).toEqual(['code', 'event', 'stage'])
              await expect(cold.releaseWorkspaceRecoveryCompletion(request, human)).rejects.toBeDefined()
              expect(await fs.readFile(fenceFile)).toEqual(before)
            }
            expect(sent.filter(kind => kind === 'workspace_recovery_release')).toHaveLength(1)
            expect(sent.filter(kind => kind === 'workspace_recovery_release_observe')).toHaveLength(['lost release acknowledgement', 'release unavailable', 'release readonly root'].includes(mode) ? 1 : 0)
            expect(await fs.readFile(ledgerFile)).toEqual(ledger)
            start.mockRestore()
            return
          } finally { stopObserving?.(); if (rootMode !== undefined) await fs.chmod(root, rootMode); sending.mockRestore(); receiving.mockRestore() }
        }
      }
      if (mode === 'completion observation' || mode === 'released without observation') {
        expect(typeof cold.beginWorkspaceRecoveryCompletionObservation).toBe('function')
        const admission = require('../../scripts/lib/workspace-recovery-admission.mjs'), native = require('../../scripts/lib/process-identity.cjs')
        const protectedFacts = admission.readWorkspaceRecoveryAdmissionScope(f.data, request)
        const releasedFile = path.join(f.data, 'workspace-control/relocation-history', request.intent_id + '.released.json')
        if (mode === 'completion observation') {
          const [first, second] = await Promise.all([
            cold.beginWorkspaceRecoveryCompletionObservation(request, human),
            cold.beginWorkspaceRecoveryCompletionObservation(request, human),
          ])
          expect(first).toBe(health); expect(second).toBe(health)
        }
        // The primitive's storage checks run locally; only its final native effect is a finite fixture.
        await expect(fs.lstat(releasedFile)).rejects.toMatchObject({ code: 'ENOENT' })
        if (mode === 'completion observation') {
          const originalRename = native.renameFileNoReplace, effects: string[][] = []
          native.renameFileNoReplace = (source: string, destination: string) => { effects.push([source, destination]); require('node:fs').renameSync(source, destination) }
          try {
            await expect(records.releaseWorkspaceRelocationJob({ dataDir: f.data, id: request.intent_id, verify: health.verify })).rejects.toBeDefined()
            expect(effects).toEqual([])
            await expect(records.commitWorkspaceRelocationFinalizing({ dataDir: f.data, id: request.intent_id,
              verify: async () => { throw new Error('fixture role revoked') }, assertCurrent: () => {}, checkCapabilities: async () => {} })).rejects.toThrow('fixture role revoked')
            expect(effects).toEqual([])
            let currentRole = true
            const assertCurrent = () => { if (!currentRole) throw new Error('fixture synchronous role revoked') }
            await expect(records.commitWorkspaceRelocationFinalizing({ dataDir: f.data, id: request.intent_id, verify: async () => {}, assertCurrent,
              checkCapabilities: async () => { currentRole = false } })).rejects.toThrow('fixture synchronous role revoked')
            expect(effects).toEqual([]); currentRole = true
            const moved = await records.commitWorkspaceRelocationFinalizing({ dataDir: f.data, id: request.intent_id, verify: health.verify, assertCurrent,
              checkCapabilities: async (verify: () => Promise<void>) => { await verify() } })
            expect(moved).toEqual({ intent_id: request.intent_id, completion_sha256: request.completion_sha256, finalizing_sha256: request.finalizing_sha256 })
            expect(effects).toEqual([[fenceFile, releasedFile]])
          } finally { native.renameFileNoReplace = originalRename }
        } else await fs.rename(fenceFile, releasedFile)
        try {
          expect(() => admission.readWorkspaceRecoveryAdmissionScope(f.data, request)).toThrow()
          expect(admission.readWorkspaceRecoveryCompletionScope(f.data, request)).toMatchObject({ released: true, fingerprint: protectedFacts.fingerprint })
          if (mode === 'completion observation') {
            await health.verify()
            expect(await callRoot(request, token)).toMatchObject({ success: true, data: proof })
            expect((await fs.stat(root, { bigint: true })).mtimeNs).toBe(probedAt)
          } else {
            await expect(health.verify()).rejects.toBeDefined()
            expect(await callRoot(request, token)).toMatchObject({ success: false })
          }
          if (process.platform === 'win32') native.writePrivateFile(fenceFile, before.toString())
          else await fs.writeFile(fenceFile, before, { mode: 0o600 })
          try { expect(() => admission.readWorkspaceRecoveryCompletionScope(f.data, request)).toThrow() }
          finally { await fs.unlink(fenceFile) }
          expect(() => admission.readWorkspaceRecoveryCompletionScope(f.data, { ...request, completion_sha256: '0'.repeat(64) })).toThrow()
          const active = path.join(f.data, 'workspace-control/relocation-active')
          if (process.platform === 'win32') native.createPrivateDirectory(active)
          else await fs.mkdir(active, { mode: 0o700 })
          try { expect(() => admission.readWorkspaceRecoveryCompletionScope(f.data, request)).toThrow() }
          finally { await fs.rmdir(active) }
        } finally { await fs.rename(releasedFile, fenceFile) }
        // The same role cannot follow an observed released effect backwards.
        await expect(health.verify()).rejects.toBeDefined()
      } else if (withMemory) {
        const unhealthy = path.join(f.data, 'cold-health-unhealthy')
        await fs.writeFile(unhealthy, 'memory-default')
        try { await expect(health.verify()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' }) }
        finally { await fs.unlink(unhealthy) }
        await expect(health.verify()).rejects.toBeDefined()
      } else if (mode === 'catalog changed after probe') {
        const catalogFile = path.join(f.data, 'workspace-control/catalog.json'), bytes = await fs.readFile(catalogFile)
        await fs.writeFile(catalogFile, '{"unexpected":true}')
        try {
          expect(await callRoot(request, token)).toMatchObject({ success: false, error: { code: 'SERVICE_UNAVAILABLE' } })
          await expect(health.verify()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
        } finally { await fs.writeFile(catalogFile, bytes) }
        expect(await callRoot(request, token)).toMatchObject({ success: false })
        await expect(health.verify()).rejects.toBeDefined()
      }
      const admin = cold.childStates.get(cold.processes.get('admin-web')), oldRuntimeId = admin.runtimeId
      admin.runtimeId = randomUUID()
      await expect(started.verify()).rejects.toBeDefined()
      await expect(health.verify()).rejects.toBeDefined()
      admin.runtimeId = oldRuntimeId
      expect(await call(request, token)).toMatchObject({ success: false })
      if (mode === 'Agent') {
        const grant = cold.workspaceRecoveryFinalizationGrant
        expect(() => cold.handleVerifyWorkspaceRelocationRecoveryFinalization({ action: 'prepare_web' }, { authorizationBearer: grant.token })).toThrow()
        expect(grant.revoked).toBe(true)
        await expect(cold.prepareWorkspaceRecoveryCompletion(request, human)).rejects.toBeDefined()
      }
      await expect(started.verify()).rejects.toBeDefined()
      await expect(cold.startWorkspaceRecoveryValidationModules(request, human)).rejects.toBeDefined()
      expect((await cold.runtimeRegistry.listRecords()).filter((row: any) => row.module_id !== 'admin-web')).toEqual(rows)
      expect(await fs.readFile(fenceFile)).toEqual(before); expect(await fs.readFile(ledgerFile)).toEqual(ledger)
    } finally {
      coordinator?.close()
      if (cold) await cold.stop()
      locks.releaseCliLock(lock); await f.cleanup()
    }
  }, process.platform === 'win32' ? 600000 : 240000)

  it('locates sealed workspace history while the original archive still retains maintenance', async () => {
    const f = await fixture({ actualAgent: true, actualAdmin: true, validationHealth: 'healthy', historyWorkspace: true, processLifetimeMs: 300000 })
    const locks = require('../../scripts/lib/cli-lock.mjs'), lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    try {
      await f.manager.prepareWorkspaceRelocationCompletion(f.params, 'fixture-human')
      const { locateWorkspaceRelocationHistory } = require('../../scripts/lib/workspace-relocation-history.mjs')
      const query = { dataDir: f.data, managerKey: 'channel::session', workerId: 'worker', incarnationId: 'inc' }
      const location = await locateWorkspaceRelocationHistory(query)
      expect(location).toEqual({ intent_id: f.params.intent_id, manager_key: query.managerKey, worker_id: 'worker', incarnation_id: 'inc',
        before_root: path.join(f.data, 'workspaces/default/tasks/worker'), after_root: path.join(f.root, 'relocated/default/tasks/worker') })
      expect(await fs.readFile(path.join(location.after_root, 'history.md'), 'utf8')).toBe('original history artifact')
      expect(await locateWorkspaceRelocationHistory({ ...query, incarnationId: 'another-incarnation' })).toBeNull()
      const bytes = await fs.readFile(path.join(f.data, 'workspace-control/relocation-history', f.params.intent_id, 'relocation.json'))
      const archived = path.join(f.data, 'workspace-control/relocation-history', f.params.intent_id, 'relocation.json')
      await fs.appendFile(archived, '\n')
      await expect(locateWorkspaceRelocationHistory(query)).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_HISTORY_LOCATION' })
      await fs.writeFile(archived, bytes)
    } finally {
      f.manager.workspaceFinalizationGrant?.close()
      const child = f.manager.workspaceValidationProof?.result.coordinator
      if (child?.connected) { const ended = once(child, 'exit'); child.disconnect(); await ended }
      locks.releaseCliLock(lock); await f.cleanup()
    }
  }, process.platform === 'win32' ? 600000 : 120000)
  it.each(['running', 'inactive', 'tool'] as const)('observes the actual original finite %s module scope without starting business', async extraModule => {
    const f = await fixture({ extraModule })
    try {
      const id = extraModule === 'tool' ? 'fixture-tool' : 'fixture-channel'
      const native = require('../../scripts/lib/process-identity.cjs'), signal = vi.spyOn(native, 'terminateKnownProcess')
      const scope = (await f.manager.captureWorkspaceRelocationModules()).find((item: any) => item.module_id === id)
      expect(scope).toBeDefined(); expect(scope.module_port).toBe(f.manager.modules.get(id).port)
      if (extraModule === 'inactive') { expect(scope.processes).toEqual([]); expect(scope.runtime_id).toBeUndefined() }
      else {
        expect(scope.processes).toEqual(expect.arrayContaining([expect.objectContaining({ pid: f.manager.processes.get(id).pid })]))
        expect(scope.runtime_id).toBe(f.manager.childStates.get(f.manager.processes.get(id)).runtimeId)
      }
      expect(signal).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  }, process.platform === 'win32' ? 600000 : 120000)

  it('does not turn an unaccepted private completion call into original human admission', async () => {
    const f = await fixture(), records = require('../../scripts/lib/workspace-relocation-intent.mjs')
    const locks = require('../../scripts/lib/cli-lock.mjs'), lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    try {
      const original = records.readWorkspaceRelocationIntent(f.data)
      await expect(f.manager.resumeWorkspaceRelocationWeb(f.params)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      await expect(f.manager.completeWorkspaceRelocation(f.params)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      await expect(f.manager.prepareWorkspaceRelocationRecoveryAdmission({ intent_id: f.params.intent_id, recovery_id: randomUUID(), completion_sha256: '0'.repeat(64), finalizing_sha256: '1'.repeat(64) })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      expect(records.readWorkspaceRelocationIntent(f.data)).toEqual(original)
      expect(records.readWorkspaceRelocationCoordinator(f.data, f.params.intent_id).launch).toBeNull()
      expect(await f.calls()).toEqual([])
    } finally { locks.releaseCliLock(lock); await f.cleanup() }
  }, process.platform === 'win32' ? 600000 : 120000)

  it('prepares the current Admin after archive without reopening business or requiring the old human request', async () => {
    const f = await fixture({ actualAgent: true, actualAdmin: true, validationHealth: 'healthy', processLifetimeMs: process.platform === 'win32' ? 900000 : 300000 })
    const locks = require('../../scripts/lib/cli-lock.mjs'), records = require('../../scripts/lib/workspace-relocation-intent.mjs')
    const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    try {
      await f.manager.verifyWorkspaceRelocationValidationHealth(f.params, 'fixture-human')
      const result = await f.manager.prepareWorkspaceRelocationCompletion(f.params)
      expect(result).toMatchObject({ prepared: true, intent_id: f.params.intent_id, intent_sha256: f.params.intent_sha256 })
      const archived = records.readWorkspaceRelocationArchivedCompletion(f.data, f.params.intent_id)
      expect(result.completion_sha256).toBe(sha256CanonicalJson(archived))
      expect(records.readWorkspaceRelocationFinalizing(f.data, f.params.intent_id).completion_sha256).toBe(result.completion_sha256)
      const grant = f.manager.workspaceFinalizationGrant
      await expect(grant.observeRelease()).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
      await expect(records.releaseWorkspaceRelocationJob({ dataDir: f.data, id: f.params.intent_id, verify: async () => {} })).rejects.toMatchObject({ code: 'WORKSPACE_RELOCATION_INVALID' })
      expect(records.readWorkspaceRelocationReleased(f.data, f.params.intent_id)).toBeNull()
      expect(typeof grant.token).toBe('string')
      expect(JSON.stringify(result)).not.toContain(grant.token)
      const prepare = (input: unknown, token?: string) => f.manager.withCurrentAdminRpc(30000, (rpc: any) =>
        rpc.call('prepare_workspace_relocation_completion', input, { authorizationBearer: token }))
      const request = { intent_id: result.intent_id, launch_id: result.launch_id, completion_sha256: result.completion_sha256 }
      await expect(prepare(request)).rejects.toMatchObject({ remote_code: 'UNAUTHORIZED' })
      for (const token of ['fixture-human', f.manager.runtimeBearers.get('crabot-agent').token, 'not-the-grant']) {
        await expect(prepare(request, token)).rejects.toMatchObject({ remote_code: 'FORBIDDEN' })
      }
      await expect(prepare({ ...request, path: f.root }, grant.token)).rejects.toMatchObject({ remote_code: 'INVALID_PARAMS' })
      await expect(prepare({ ...request, completion_sha256: '0'.repeat(64) }, grant.token)).rejects.toMatchObject({ remote_code: 'FORBIDDEN' })
      await expect(prepare(request, grant.token)).resolves.toEqual(result)
      expect(JSON.stringify(await f.calls())).not.toContain(grant.token)
      const params = { intent_id: result.intent_id, launch_id: result.launch_id, completion_sha256: result.completion_sha256, action: 'prepare_web' }
      await expect(f.manager.handleVerifyWorkspaceRelocationFinalization(params, {})).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
      for (const token of ['fixture-human', f.manager.runtimeBearers.get('crabot-agent').token, 'not-the-grant']) {
        await expect(f.manager.handleVerifyWorkspaceRelocationFinalization(params, { authorizationBearer: token })).rejects.toMatchObject({ code: 'FORBIDDEN' })
      }
      await expect(f.manager.handleVerifyWorkspaceRelocationFinalization({ ...params, action: 'resume_web' }, { authorizationBearer: grant.token })).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(f.manager.handleVerifyWorkspaceRelocationFinalization({ ...params, path: f.root }, { authorizationBearer: grant.token })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
      await expect(f.manager.handleVerifyWorkspaceRelocationFinalization(params, { authorizationBearer: grant.token })).resolves.toMatchObject({ verified: true, ...params, intent_sha256: f.params.intent_sha256 })
      expect((await fetch(`http://127.0.0.1:${f.port}/api/friends`, { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(200)
      expect(require('../../scripts/lib/workspace-maintenance.cjs').workspaceMaintenancePending(f.data)).toBe(true)
      expect(JSON.parse(await fs.readFile(path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), 'utf8')).workers[0].task.status).toBe('closed')
      const fenceFile = path.join(f.data, 'workspace-control/relocation-finalizing.json'), fenceBytes = await fs.readFile(fenceFile)
      const fence = JSON.parse(fenceBytes.toString())
      await fs.writeFile(fenceFile, JSON.stringify({ ...fence, created_at: new Date(Date.parse(fence.created_at) + 1000).toISOString() }))
      await expect(f.manager.handleVerifyWorkspaceRelocationFinalization(params, { authorizationBearer: grant.token })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
      await expect(prepare(request, grant.token)).rejects.toMatchObject({ remote_code: 'SERVICE_UNAVAILABLE' })
      await fs.writeFile(fenceFile, fenceBytes)
      await expect(prepare(request, grant.token)).resolves.toEqual(result)
      const adminState = f.manager.childStates.get(f.manager.processes.get('admin-web')), runtimeId = adminState.runtimeId
      adminState.runtimeId = randomUUID()
      await expect(f.manager.handleVerifyWorkspaceRelocationFinalization(params, { authorizationBearer: grant.token })).rejects.toMatchObject({ code: 'FORBIDDEN' })
      adminState.runtimeId = runtimeId
      expect(grant.revoked).toBe(true)
      await expect(f.manager.prepareWorkspaceRelocationCompletion(f.params)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(prepare(request, grant.token)).rejects.toMatchObject({ remote_code: 'FORBIDDEN' })
      await expect(f.manager.handleVerifyWorkspaceRelocationFinalization(params, { authorizationBearer: grant.token })).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await f.manager.stop()
      expect(grant.child.connected).toBe(false)
      expect(records.readWorkspaceRelocationFinalizing(f.data, f.params.intent_id).completion_sha256).toBe(result.completion_sha256)
      const cold = new ModuleManager({ port: 0, modules: [] }, f.data) as any
      try {
        await expect(cold.handleVerifyWorkspaceRelocationFinalization(params, { authorizationBearer: grant.token })).rejects.toMatchObject({ code: 'FORBIDDEN' })
        expect(cold.workspaceFinalizationGrant).toBeUndefined(); expect(cold.processes.size).toBe(0)
        await expect(locks.acquireWorkspaceRelocationRecoveryLock(f.data, randomUUID(), 10)).rejects.toBeDefined()
        const recoveredLock = await locks.acquireWorkspaceRelocationRecoveryLock(f.data, f.params.intent_id, 1000)
        const firstRecoveryToken = locks.cliLockToken(recoveredLock)
        expect(firstRecoveryToken).toBeTruthy()
        expect(firstRecoveryToken).not.toBe(grant.token)
        locks.releaseCliLock(recoveredLock)
        const program = `const locks=require(${JSON.stringify(path.resolve('../scripts/lib/cli-lock.mjs'))}),native=require(${JSON.stringify(path.resolve('../scripts/lib/process-identity.cjs'))});
          setTimeout(()=>process.exit(2),10000).unref();(async()=>{const lock=await locks.acquireWorkspaceRelocationRecoveryLock(${JSON.stringify(f.data)},${JSON.stringify(f.params.intent_id)});
          try{process.stdout.write(JSON.stringify({owner:native.inspectProcess(process.pid),token:locks.cliLockToken(lock)}))}finally{locks.releaseCliLock(lock)}})().catch(error=>{console.error(error);process.exitCode=1})`
        const child = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } })
        let output = '', errors = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { errors += chunk })
        expect((await once(child, 'close'))[0], errors).toBe(0)
        const fresh = JSON.parse(output)
        expect(fresh.owner.pid).toBe(child.pid); expect(fresh.owner.pid).not.toBe(grant.launch.process.pid)
        expect(fresh.owner.parent).toBe(process.pid); expect(fresh.owner.owner).toBe(grant.launch.parent.owner)
        expect(fresh.token).toBeTruthy(); expect(fresh.token).not.toBe(grant.token); expect(fresh.token).not.toBe(firstRecoveryToken)
        await expect(locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id, 10)).rejects.toBeDefined()
        expect(await fs.readFile(fenceFile)).toEqual(fenceBytes)
        const native = require('../../scripts/lib/process-identity.cjs'), lockFile = path.join(f.data, 'cli.lock')
        const held = native.tryFileLock(lockFile, await fs.readFile(lockFile, 'utf8'))
        expect(held).toBeTruthy()
        const tryLock = vi.spyOn(native, 'tryFileLock'), waiting = locks.acquireWorkspaceRelocationRecoveryLock(f.data, f.params.intent_id, 2000)
        const observed = waiting.then((lock: string) => { locks.releaseCliLock(lock); return null }, (error: unknown) => error)
        let heldReleased = false
        try {
          await vi.waitFor(() => expect(tryLock.mock.calls.some((call: any[]) => JSON.parse(call[1]).command === 'workspace-relocation-recovery')).toBe(true))
          await fs.writeFile(fenceFile, JSON.stringify({ ...fence, created_at: new Date(Date.parse(fence.created_at) + 2000).toISOString() }))
          native.releaseFileLock(held); heldReleased = true
          expect(await observed).toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
        } finally {
          tryLock.mockRestore(); if (!heldReleased) native.releaseFileLock(held)
          await observed; await fs.writeFile(fenceFile, fenceBytes)
        }
        expect(cold.processes.size).toBe(0); expect(await fs.readFile(fenceFile)).toEqual(fenceBytes)
      } finally { await cold.stop() }
    } finally {
      const coordinator = f.manager.workspaceValidationProof?.result.coordinator
      if (coordinator?.connected) { const ended = once(coordinator, 'exit'); coordinator.disconnect(); await ended }
      locks.releaseCliLock(lock); await f.cleanup()
    }
  }, process.platform === 'win32' ? 600000 : 120000)
})


// This stage requires the new Native file move, rebuilt only in isolated CI.
describe.skipIf(process.env.GITHUB_ACTIONS !== 'true')('fixed terminal release and current Admin resume', () => {
  it.each(['healthy', 'controller lost acknowledgement', 'inactive module', 'skip-health tool', 'unhealthy restored module', 'changed restored definition', 'bad prepared result', 'unhealthy runtime', 'existing release fact', 'lost acknowledgement', 'new maintenance after effect'])(
    'does not replay or reopen an unconfirmed result: %s', async mode => {
      const extraModule = mode === 'skip-health tool' ? 'tool' : mode === 'inactive module' ? 'inactive' : ['healthy', 'controller lost acknowledgement', 'unhealthy restored module', 'changed restored definition'].includes(mode) ? 'running' : undefined
      const f = await fixture({ actualAgent: true, actualAdmin: true, validationHealth: 'healthy', extraModule, historyWorkspace: mode === 'healthy', processLifetimeMs: process.platform === 'win32' ? 900000 : 300000 })
      const locks = require('../../scripts/lib/cli-lock.mjs'), records = require('../../scripts/lib/workspace-relocation-intent.mjs')
      const native = require('../../scripts/lib/process-identity.cjs'), maintenance = require('../../scripts/lib/workspace-maintenance.cjs')
      const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
      let replySpy: ReturnType<typeof vi.spyOn> | undefined, sendSpy: ReturnType<typeof vi.spyOn> | undefined
      const sent: string[] = [], healthyFlow = ['healthy', 'controller lost acknowledgement', 'inactive module', 'skip-health tool'].includes(mode)
      try {
        if (mode === 'healthy') for (const operation of ['submitWorkspaceRelocationStops', 'prepareWorkspaceRelocationFiles', 'commitWorkspaceRelocationWorkers', 'commitWorkspaceRelocationRoot',
          'startWorkspaceRelocationValidationModules', 'verifyWorkspaceRelocationValidationHealth', 'prepareWorkspaceRelocationCompletion', 'resumeWorkspaceRelocationWeb', 'completeWorkspaceRelocation']) {
          const original = f.manager[operation].bind(f.manager)
          vi.spyOn(f.manager, operation).mockImplementation(async (...args: any[]) => {
            const started = Date.now()
            try { return await original(...args) }
            finally { console.log('[finite workspace stage]', { operation, elapsed_ms: Date.now() - started }) }
          })
        }
        expect(typeof native.renameFileNoReplace).toBe('function')
        const extraId = mode === 'skip-health tool' ? 'fixture-tool' : 'fixture-channel'
        const originalExtra = (await f.manager.runtimeRegistry.listRecords()).find((row: any) => row.module_id === extraId)
        const prepared = await f.manager.prepareWorkspaceRelocationCompletion(f.params, 'fixture-human'), grant = f.manager.workspaceFinalizationGrant
        if (mode === 'unhealthy restored module') await fs.writeFile(path.join(f.data, 'extra-health-unhealthy'), 'degraded after restoration')
        if (mode === 'changed restored definition') f.manager.modules.get(extraId).env = { CHANGED_DURING_FINALIZATION: '1' }
        const send = grant.child.send.bind(grant.child)
        sendSpy = vi.spyOn(grant.child, 'send').mockImplementation((message: any, ...values: any[]) => { sent.push(message.kind); return send(message, ...values) })
        await expect(grant.observeRelease()).rejects.toBeDefined()
        expect(sent).toEqual([])
        const receipt = path.join(f.data, 'workspace-control/relocation-history', f.params.intent_id + '.released.json')
        const fence = path.join(f.data, 'workspace-control/relocation-finalizing.json'), original = await fs.readFile(fence)
        const request = { intent_id: prepared.intent_id, launch_id: prepared.launch_id, completion_sha256: prepared.completion_sha256 }
        const resume = (token = grant.token, input: unknown = request) => f.manager.withCurrentAdminRpc(30000, (rpc: any) =>
          rpc.call('resume_workspace_relocation_web', input, { authorizationBearer: token }))
        await expect(resume()).rejects.toMatchObject({ remote_code: 'SERVICE_UNAVAILABLE' })
        if (mode === 'bad prepared result') {
          await expect(grant.release({ ...prepared, completion_sha256: '0'.repeat(64) })).rejects.toBeDefined()
        } else {
          if (mode === 'unhealthy runtime') await fs.writeFile(path.join(f.data, 'validation-health-unhealthy'), 'current runtime degraded')
          if (mode === 'existing release fact') await fs.writeFile(receipt, 'unrelated retained content')
          if (mode === 'lost acknowledgement' || mode === 'controller lost acknowledgement' || mode === 'new maintenance after effect') {
            const child = grant.child, emit = child.emit.bind(child)
            replySpy = vi.spyOn(child, 'emit').mockImplementation((event: string, ...args: unknown[]) => {
              const message = args[0] as any
              if (event === 'message' && message?.kind === 'workspace_relocation_release_reply' && message.ok) {
                if (mode === 'lost acknowledgement' || mode === 'controller lost acknowledgement') return emit(event, { ...message, ok: false, result: null })
                require('node:fs').mkdirSync(path.join(f.data, 'workspace-control/relocation-active'), { mode: 0o700 })
              }
              return emit(event, ...args)
            })
          }
          if (healthyFlow) {
            const result = await f.manager.resumeWorkspaceRelocationWeb(f.params)
            expect(grant.phase).toBe('released'); expect(maintenance.workspaceMaintenancePending(f.data)).toBe(false)
            await expect(f.manager.resumeWorkspaceRelocationWeb(f.params)).resolves.toEqual(result)
            if (extraModule === 'inactive') expect(f.manager.processes.has(extraId)).toBe(false)
            else if (extraModule) {
              const restored = (await f.manager.runtimeRegistry.listRecords()).find((row: any) => row.module_id === extraId)
              expect(restored).toBeDefined(); expect(restored.runtime_id).not.toBe(originalExtra.runtime_id)
              expect(f.manager.modules.get(extraId).status).toBe('running')
            }
            expect(result).toEqual({ resumed: true, ...request, intent_sha256: prepared.intent_sha256, launch_sha256: prepared.launch_sha256 })
            const create = await fetch(`http://127.0.0.1:${f.port}/api/workspaces`, { method: 'POST', headers: { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' },
              body: JSON.stringify({ workspace_id: randomUUID(), name: 'after relocation' }) })
            const created = await create.json() as any
            expect(create.status, JSON.stringify(created)).toBe(200)
            expect(created.workspace.root.startsWith(path.join(records.readWorkspaceRelocationArchivedState(f.data, f.params.intent_id).intent.target, 'projects') + path.sep)).toBe(true)
            expect((await fetch(`http://127.0.0.1:${f.port}/api/workspaces/default/usage/refresh`, { method: 'POST', headers: { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(202)
            await expect(resume()).resolves.toEqual(result)
            await expect(resume('fixture-human')).rejects.toMatchObject({ remote_code: 'FORBIDDEN' })
            await expect(resume(grant.token, { ...request, path: f.root })).rejects.toMatchObject({ remote_code: 'INVALID_PARAMS' })
            await expect(records.verifyWorkspaceRelocationReleasedCapabilities({ dataDir: f.data, id: f.params.intent_id, verify: async () => grant.verify() })).resolves.toMatchObject({ completion_sha256: prepared.completion_sha256 })
            await fs.mkdir(path.join(f.data, 'workspace-control/relocation-active'), { mode: 0o700 })
            expect(records.readWorkspaceRelocationReleased(f.data, f.params.intent_id).completion_sha256).toBe(prepared.completion_sha256)
            await expect(resume()).rejects.toMatchObject({ remote_code: 'SERVICE_UNAVAILABLE' })
            await expect(f.manager.resumeWorkspaceRelocationWeb(f.params)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
            await fs.rmdir(path.join(f.data, 'workspace-control/relocation-active'))
            await expect(f.manager.completeWorkspaceRelocation(f.params)).resolves.toEqual(result)
            expect(grant.revoked).toBe(true); expect(grant.child.connected).toBe(false)
            await expect(locks.acquireWorkspaceRelocationRecoveryLock(f.data, f.params.intent_id, 10)).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
            expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([grant.launch.process]).state).toBe('stopped')
            expect(f.manager.workspaceFinalizationGrant).toBeUndefined(); expect(f.manager.workspaceStopSequence).toBeUndefined()
            const nextLock = await locks.acquireCliLock(f.data, 'next-operation', 1000); locks.releaseCliLock(nextLock)
            await expect(f.manager.handleVerifyWorkspaceRelocationFinalization({ ...request, action: 'resume_web' }, { authorizationBearer: grant.token })).rejects.toMatchObject({ code: 'FORBIDDEN' })
            if (mode === 'healthy') {
              const { locateWorkspaceRelocationHistory } = require('../../scripts/lib/workspace-relocation-history.mjs')
              const query = { dataDir: f.data, managerKey: 'channel::session', workerId: 'worker', incarnationId: 'inc' }
              const first = await locateWorkspaceRelocationHistory(query)
              const { WorkspaceManager } = require('../../crabot-agent/dist/workers/harness/workspace-manager.js')
              const history = new WorkspaceManager(undefined, f.data)
              await expect(history.locateHistory(query.managerKey, query.workerId, query.incarnationId)).resolves.toEqual(first)
              expect(first.after_root).toBe(path.join(f.root, 'relocated/default/tasks/worker'))
              const catalog = new WorkspaceCatalog({ dataRoot: f.data, files: native }), beginLock = await locks.acquireCliLock(f.data, 'workspace-relocation')
              let next
              try { next = await records.beginWorkspaceRelocationIntent({ dataDir: f.data, id: randomUUID(), target: path.join(f.data, 'workspaces'),
                expectedRevision: (await catalog.snapshot()).revision, protectedRoots: [path.join(f.data, 'workspace-control')] }) }
              finally { locks.releaseCliLock(beginLock) }
              const nextLock = await locks.acquireWorkspaceRelocationLock(f.data, next.id)
              try {
                await f.manager.completeWorkspaceRelocation({ intent_id: next.id, intent_sha256: sha256CanonicalJson(next) }, 'fixture-human')
                const second = await locateWorkspaceRelocationHistory(query)
                expect(second).toEqual({ ...first, intent_id: next.id, after_root: first.before_root })
                await expect(history.locateHistory(query.managerKey, query.workerId, query.incarnationId)).resolves.toEqual(second)
                expect(await fs.readFile(path.join(second.after_root, 'history.md'), 'utf8')).toBe('original history artifact')
                expect(records.readWorkspaceRelocationReleased(f.data, f.params.intent_id).completion_sha256).toBe(prepared.completion_sha256)
                expect(f.manager.workspaceFinalizationGrant).toBeUndefined()
              } finally { locks.releaseCliLock(nextLock) }
            }
          } else if (mode === 'unhealthy restored module' || mode === 'changed restored definition') {
            await expect(f.manager.resumeWorkspaceRelocationWeb(f.params)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
            if (mode === 'changed restored definition') expect(f.manager.processes.has(extraId)).toBe(false)
          } else await expect(grant.release(prepared)).rejects.toBeDefined()
        }
        if (['bad prepared result', 'unhealthy runtime', 'existing release fact'].includes(mode)) {
          expect(await fs.readFile(fence)).toEqual(original); expect(maintenance.workspaceMaintenancePending(f.data)).toBe(true)
          if (mode === 'existing release fact') expect(await fs.readFile(receipt, 'utf8')).toBe('unrelated retained content')
        }
        if (mode === 'lost acknowledgement' || mode === 'new maintenance after effect') {
          expect(records.readWorkspaceRelocationReleased(f.data, f.params.intent_id).completion_sha256).toBe(prepared.completion_sha256)
          expect(grant.phase).toBe('prepared')
          await expect(resume()).rejects.toMatchObject({ remote_code: mode === 'lost acknowledgement' ? 'FORBIDDEN' : 'SERVICE_UNAVAILABLE' })
        }
        if (mode === 'lost acknowledgement') {
          await grant.observeRelease()
          expect(grant.phase).toBe('released')
          await expect(resume()).resolves.toMatchObject({ resumed: true, ...request })
          const create = await fetch(`http://127.0.0.1:${f.port}/api/workspaces`, { method: 'POST', headers: { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspace_id: randomUUID(), name: 'confirmed original effect' }) })
          expect(create.status).toBe(200)
        } else if (!healthyFlow) {
          await expect(grant.observeRelease()).rejects.toBeDefined()
          const create = await fetch(`http://127.0.0.1:${f.port}/api/workspaces`, { method: 'POST', headers: { Authorization: 'Bearer fixture-human', 'Content-Type': 'application/json' }, body: '{}' })
          expect(create.status).toBe(503)
        }
        expect(sent.filter(kind => kind === 'workspace_relocation_release_request')).toHaveLength(mode === 'bad prepared result' ? 0 : 1)
        expect(sent.filter(kind => kind === 'workspace_relocation_release_observe')).toHaveLength(['healthy', 'inactive module', 'skip-health tool', 'unhealthy restored module', 'changed restored definition', 'bad prepared result'].includes(mode) ? 0 : 1)
        expect((await fetch(`http://127.0.0.1:${f.port}/api/friends`, { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(200)
        expect(JSON.parse(await fs.readFile(path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), 'utf8')).workers[0].task.status).toBe('closed')
        expect(JSON.stringify(await f.calls())).not.toContain(grant.token)
      } finally {
        replySpy?.mockRestore(); sendSpy?.mockRestore(); f.manager.workspaceFinalizationGrant?.close()
        const child = f.manager.workspaceValidationProof?.result.coordinator
        if (child?.connected) { const ended = once(child, 'exit'); child.disconnect(); await ended }
        locks.releaseCliLock(lock); await f.cleanup()
      }
    }, process.platform === 'win32' ? 600000 : 240000)
})


describe('fixed job archive storage handoff', () => {
  const modes = ['healthy Agent', 'healthy Memory', ...['target conflict', 'fence conflict', 'runtime changed', 'unhealthy runtime', 'wrong launch', 'lost acknowledgement', 'coordinator exited after archive', 'archive changed', 'fence changed', 'active conflict after move', ...(process.platform !== 'win32' && process.getuid?.() !== 0 ? ['readonly root'] : [])].map(value => 'healthy archive ' + value)]
  it.each(modes)('keeps maintenance and preserves one job: %s', async mode => {
    const began = performance.now()
    const phase = (stage: string) => { if (mode === 'healthy Memory' && process.env.GITHUB_ACTIONS === 'true') console.log('[Archive Memory stage]', { stage, elapsed_ms: Math.round(performance.now() - began) }) }
    phase('fixture-start')
    const f = await fixture({ actualAgent: true, actualAdmin: true, validationHealth: 'healthy', withMemory: mode === 'healthy Memory', memoryHealth: 'healthy', processLifetimeMs: process.platform === 'win32' ? 900000 : 300000 })
    phase('fixture-ready')
    const locks = require('../../scripts/lib/cli-lock.mjs'), records = require('../../scripts/lib/workspace-relocation-intent.mjs')
    const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    let coordinator: ReturnType<typeof spawn> | undefined, changedRuntime: { file: string; contents: string } | undefined
    let readonlyRoot: { path: string; mode: number } | undefined
    try {
      const result = await f.manager.verifyWorkspaceRelocationValidationHealth(f.params, 'fixture-human')
      phase('health-ready')
      coordinator = result.coordinator
      const context = { dataDir: f.data, id: f.params.intent_id, launch: records.readWorkspaceRelocationCoordinator(f.data, f.params.intent_id).launch }
      const original = await fs.readFile(path.join(f.data, 'workspace-control/relocation-active/relocation-health.json'), 'utf8'), health = JSON.parse(original)
      const completionFile = path.join(f.data, 'workspace-control/relocation-active/relocation-complete.json')
      expect(records.readWorkspaceRelocationCompletion(f.data, f.params.intent_id)).toBeNull()
      await expect(records.prepareWorkspaceRelocationCompletion({ dataDir: f.data, id: f.params.intent_id })).rejects.toMatchObject({ code: 'WORKSPACE_RELOCATION_INVALID' })
      const complete = async () => {
        const transport = require('../../scripts/lib/workspace-coordinator-journal.mjs').createWorkspaceJournalClient(result.coordinator, context, 'file')
        try { return await transport.call('prepare_completion', {}) } catch (error) { console.error('[Workspace completion journal]', coordinatorJournalFailures(result.coordinator)); throw error } finally { transport.close() }
      }
      const prepared = await complete()
      phase('completion-published')
      const completion = records.readWorkspaceRelocationCompletion(f.data, f.params.intent_id)
      expect(prepared).toEqual({ dispatch: 'dispatch', completion_sha256: sha256CanonicalJson(completion) })
      expect(completion).toMatchObject({ schema_version: 1, intent_id: f.params.intent_id, health_sha256: result.health_sha256,
        selected_sha256: result.root_selected_sha256 })
      expect(completion.materials.some((row: any) => row.name === 'relocation-complete.json')).toBe(false)
      expect(completion.materials.some((row: any) => row.name === 'relocation-health.json')).toBe(true)
      const completionBytes = await fs.readFile(completionFile)
      expect(await complete()).toEqual({ dispatch: 'observe', completion_sha256: prepared.completion_sha256 })
      expect(await fs.readFile(completionFile)).toEqual(completionBytes)
      const healthPath = path.join(f.data, 'workspace-control/relocation-active/relocation-health.json')
      try {
        writeFileSync(healthPath, original + ' ')
        expect(() => records.readWorkspaceRelocationCompletion(f.data, f.params.intent_id)).toThrow()
        await expect(complete()).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
      } finally { writeFileSync(healthPath, original) }
      expect(records.readWorkspaceRelocationCompletion(f.data, f.params.intent_id)).toEqual(completion)
      const unknown = path.join(f.data, 'workspace-control/relocation-active/unexpected-preserve')
      try {
        writeFileSync(unknown, 'preserve unknown contents')
        expect(() => records.readWorkspaceRelocationCompletion(f.data, f.params.intent_id)).toThrow()
        await expect(complete()).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
        expect(readFileSync(unknown, 'utf8')).toBe('preserve unknown contents')
        expect(await fs.readFile(completionFile)).toEqual(completionBytes)
      } finally { await fs.unlink(unknown) }
      expect(records.readWorkspaceRelocationCompletion(f.data, f.params.intent_id)).toEqual(completion)
      expect(await fs.readFile(healthPath, 'utf8')).toBe(original)
      const generic = require('../../scripts/lib/workspace-coordinator-journal.mjs').createWorkspaceJournalClient(result.coordinator, context, 'file')
      try { await expect(generic.call('archive_job', {})).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' }) }
      finally { generic.close() }
      const catalogBeforeArchive = await fs.readFile(path.join(f.data, 'workspace-control/catalog.json'))
      const finalization = require('../../scripts/lib/workspace-finalization-journal.mjs').createWorkspaceFinalizationJournal(result.coordinator, context)
      const archiveMode = mode.startsWith('healthy archive ') ? mode.slice('healthy archive '.length) : ''
      const archiveDirectory = path.join(f.data, 'workspace-control/relocation-history', f.params.intent_id)
      const fenceFile = path.join(f.data, 'workspace-control/relocation-finalizing.json')
      const management = require('../../scripts/lib/desktop-management.cjs'), native = require('../../scripts/lib/process-identity.cjs')
      if (archiveMode === 'target conflict') {
        management.ensurePrivateDataRoot(path.dirname(archiveDirectory)); management.ensurePrivateDataRoot(archiveDirectory)
        writeFileSync(path.join(archiveDirectory, 'foreign-content'), 'preserve existing archive target')
      }
      if (archiveMode === 'fence conflict') {
        if (process.platform === 'win32') native.writePrivateFile(fenceFile, '{}')
        else await fs.writeFile(fenceFile, '{}', { mode: 0o600 })
      }
      if (archiveMode === 'readonly root') {
        const root = records.readWorkspaceRelocationRootPublished(f.data, f.params.intent_id).target.path
        readonlyRoot = { path: root, mode: (await fs.stat(root)).mode & 0o777 }
        await fs.chmod(root, 0o500)
      }
      if (archiveMode === 'unhealthy runtime') await fs.writeFile(path.join(f.data, 'validation-health-unhealthy'), 'finite health failure')
      if (archiveMode === 'runtime changed') {
        const file = path.join(f.data, 'module-runtime-registry/records', health.modules[0].runtime_id + '.json')
        const contents = readFileSync(file, 'utf8'); changedRuntime = { file, contents }
        writeFileSync(file, JSON.stringify({ ...JSON.parse(contents), module_id: 'foreign-runtime' }))
      }
      let archiveReplyChanged = false
      const emit = result.coordinator.emit.bind(result.coordinator), send = result.coordinator.send.bind(result.coordinator)
      const sendSpy = vi.spyOn(result.coordinator, 'send').mockImplementation((message: any, ...values: any[]) => {
        if (archiveMode === 'wrong launch' && message?.kind === 'workspace_relocation_archive_request') return send({ ...message, launch_id: randomUUID() }, ...values)
        return send(message, ...values)
      })
      const replySpy = vi.spyOn(result.coordinator, 'emit').mockImplementation((event: any, ...values: any[]) => {
        const message = values[0]
        if (!archiveReplyChanged && event === 'message' && message?.kind === 'workspace_relocation_archive_reply' && message.ok === true
          && ['lost acknowledgement', 'coordinator exited after archive', 'archive changed', 'fence changed', 'active conflict after move'].includes(archiveMode)) {
          archiveReplyChanged = true
          if (archiveMode === 'coordinator exited after archive') {
            expect(native.sameProcess(context.launch.process, native.inspectProcess(result.coordinator.pid))).toBe(true)
            result.coordinator.kill('SIGKILL')
            return true
          }
          if (archiveMode === 'lost acknowledgement') return emit(event, { ...message, ok: false })
          if (archiveMode === 'archive changed') writeFileSync(path.join(archiveDirectory, 'relocation.json'), readFileSync(path.join(archiveDirectory, 'relocation.json'), 'utf8') + ' ')
          if (archiveMode === 'fence changed') writeFileSync(fenceFile, JSON.stringify({ ...JSON.parse(readFileSync(fenceFile, 'utf8')), unexpected: true }))
          if (archiveMode === 'active conflict after move') { management.ensurePrivateDataRoot(path.dirname(completionFile)); writeFileSync(path.join(path.dirname(completionFile), 'foreign-content'), 'preserve foreign active job') }
        }
        return emit(event, ...values)
      })
      try {
        if (archiveMode) {
          const firstArchive = finalization.archive()
          expect(finalization.archive()).toBe(firstArchive)
          await expect(firstArchive).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
          expect(sendSpy.mock.calls.filter(([message]: any[]) => message?.kind === 'workspace_relocation_archive_request')).toHaveLength(1)
          const moved = ['lost acknowledgement', 'coordinator exited after archive', 'archive changed', 'fence changed', 'active conflict after move'].includes(archiveMode)
          expect(archiveReplyChanged).toBe(moved)
          if (moved) {
            if (archiveMode === 'active conflict after move') expect(await fs.readFile(path.join(path.dirname(completionFile), 'foreign-content'), 'utf8')).toBe('preserve foreign active job')
            else await expect(fs.lstat(path.dirname(completionFile))).rejects.toMatchObject({ code: 'ENOENT' })
            expect(await fs.readFile(path.join(archiveDirectory, 'relocation-complete.json'))).toEqual(completionBytes)
            if (archiveMode === 'archive changed') expect(() => records.readWorkspaceRelocationArchivedCompletion(f.data, f.params.intent_id)).toThrow()
            else expect(records.readWorkspaceRelocationArchivedCompletion(f.data, f.params.intent_id)).toEqual(completion)
            if (['fence changed', 'active conflict after move'].includes(archiveMode)) expect(() => records.readWorkspaceRelocationFinalizing(f.data, f.params.intent_id)).toThrow()
            else expect(records.readWorkspaceRelocationFinalizing(f.data, f.params.intent_id).completion_sha256).toBe(prepared.completion_sha256)
          } else {
            expect(await fs.readFile(completionFile)).toEqual(completionBytes)
            if (archiveMode === 'target conflict') expect(await fs.readFile(path.join(archiveDirectory, 'foreign-content'), 'utf8')).toBe('preserve existing archive target')
            else await expect(fs.lstat(archiveDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
            if (archiveMode === 'fence conflict') expect(await fs.readFile(fenceFile, 'utf8')).toBe('{}')
            else await expect(fs.lstat(fenceFile)).rejects.toMatchObject({ code: 'ENOENT' })
          }
          expect(require('../../scripts/lib/workspace-maintenance.cjs').workspaceMaintenancePending(f.data)).toBe(true)
          if (archiveMode === 'coordinator exited after archive') {
            await vi.waitFor(() => expect(require('../../scripts/lib/known-process-exit.cjs').probeKnownProcessExit([context.launch.process]).state).toBe('stopped'), { timeout: 10000 })
            expect(records.readCurrentWorkspaceRelocationFinalizing(f.data).intent_id).toBe(f.params.intent_id)
            expect(records.readWorkspaceRelocationArchivedState(f.data, f.params.intent_id).intent.id).toBe(f.params.intent_id)
            await expect(locks.acquireCliLock(f.data, 'start', 10)).rejects.toMatchObject({ code: 'WORKSPACE_MAINTENANCE' })
            await expect(finalization.archive()).rejects.toMatchObject({ code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
            expect(sendSpy.mock.calls.filter(([message]: any[]) => message?.kind === 'workspace_relocation_archive_request')).toHaveLength(1)
          }
          expect(await fs.readFile(path.join(f.data, 'workspace-control/catalog.json'))).toEqual(catalogBeforeArchive)
        } else {
          const archived = await finalization.archive()
          expect(archived.completion_sha256).toBe(prepared.completion_sha256)
          expect(records.readWorkspaceRelocationArchivedCompletion(f.data, f.params.intent_id)).toEqual(completion)
          await expect(fs.lstat(path.dirname(completionFile))).rejects.toMatchObject({ code: 'ENOENT' })
          expect(await fs.readFile(path.join(f.data, 'workspace-control/relocation-history', f.params.intent_id, 'relocation-complete.json'))).toEqual(completionBytes)
          expect(records.readWorkspaceRelocationFinalizing(f.data, f.params.intent_id).completion_sha256).toBe(prepared.completion_sha256)
          expect(require('../../scripts/lib/workspace-maintenance.cjs').workspaceMaintenancePending(f.data)).toBe(true)
          expect(finalization.archive()).toBe(finalization.archive())
          expect(await finalization.archive()).toEqual(archived)
          expect(() => records.readWorkspaceRelocationHealth(f.data, f.params.intent_id)).toThrow()
          expect(await fs.readFile(path.join(f.data, 'workspace-control/catalog.json'))).toEqual(catalogBeforeArchive)
          const inspection = require('../../crabot-agent/dist/core/workspace-relocation-closed-evidence.js')
          const ledgerFile = path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), ledgerBytes = await fs.readFile(ledgerFile)
          const verify = async () => { expect(records.readWorkspaceRelocationArchivedCompletion(f.data, f.params.intent_id)).toEqual(completion) }
          const closed = await inspection.inspectArchivedWorkspaceRelocationClosures({ dataDir: f.data, id: f.params.intent_id, verify })
          expect(closed.worker_commit_sha256).toBe(completion.worker_commit_sha256)
          expect(closed.recovery_commit_sha256).toBe(completion.recovery_commit_sha256)
          closed.verify()
          expect(records.readCurrentWorkspaceRelocationFinalizing(f.data)).toEqual(records.readWorkspaceRelocationFinalizing(f.data, f.params.intent_id))
          const state = records.readWorkspaceRelocationArchivedState(f.data, f.params.intent_id)
          expect(state.intent.id).toBe(f.params.intent_id)
          expect(state.health).toEqual(health)
          const capabilities = await records.verifyWorkspaceRelocationArchivedCapabilities({ dataDir: f.data, id: f.params.intent_id, verify })
          expect(capabilities).toEqual({ completion_sha256: prepared.completion_sha256, selected_sha256: result.root_selected_sha256, modules_sha256: sha256CanonicalJson(health.modules) })
          const unhealthy = path.join(f.data, 'validation-health-unhealthy')
          try {
            writeFileSync(unhealthy, 'same generation is no longer healthy')
            await expect(records.verifyWorkspaceRelocationArchivedCapabilities({ dataDir: f.data, id: f.params.intent_id, verify })).rejects.toBeDefined()
          } finally { await fs.unlink(unhealthy) }
          await expect(records.verifyWorkspaceRelocationArchivedCapabilities({ dataDir: f.data, id: f.params.intent_id,
            verify: async () => { throw Object.assign(new Error('original role revoked'), { code: 'FORBIDDEN' }) } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
          expect(await records.verifyWorkspaceRelocationArchivedCapabilities({ dataDir: f.data, id: f.params.intent_id, verify })).toEqual(capabilities)
          const cancellation = new AbortController()
          const cancelled = await inspection.inspectArchivedWorkspaceRelocationClosures({ dataDir: f.data, id: f.params.intent_id, verify, signal: cancellation.signal })
          cancelled.verify(); cancellation.abort()
          expect(() => cancelled.verify()).toThrowError(expect.objectContaining({ code: 'CRABOT_WORKSPACE_CLOSED_EVIDENCE' }))
          expect(await fs.readFile(ledgerFile)).toEqual(ledgerBytes)
          await expect(inspection.inspectWorkspaceRelocationClosures({ dataDir: f.data, id: f.params.intent_id, verify })).rejects.toBeDefined()
          try {
            writeFileSync(ledgerFile, ledgerBytes.toString('utf8') + ' ')
            expect(() => closed.verify()).toThrow()
            await expect(inspection.inspectArchivedWorkspaceRelocationClosures({ dataDir: f.data, id: f.params.intent_id, verify })).rejects.toBeDefined()
          } finally { writeFileSync(ledgerFile, ledgerBytes) }
        }
      } finally { sendSpy.mockRestore(); replySpy.mockRestore(); finalization.close() }
      expect((await fetch(`http://127.0.0.1:${f.port}/api/friends`, { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(200)
      const ledger = JSON.parse(await fs.readFile(path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), 'utf8'))
      expect(ledger.workers[0].task.status).toBe('closed')
    } finally {
      if (readonlyRoot) await fs.chmod(readonlyRoot.path, readonlyRoot.mode)
      if (changedRuntime) writeFileSync(changedRuntime.file, changedRuntime.contents)
      if (coordinator?.connected) { const ended = once(coordinator, 'exit'); coordinator.disconnect(); await ended }
      locks.releaseCliLock(lock); await f.cleanup()
    }
  }, process.platform === 'win32' ? 600000 : 120000)
})


// This group cannot start a business Agent on a developer machine.
describe.skipIf(process.env.GITHUB_ACTIONS !== 'true' || process.env.CRABOT_WORKSPACE_BUSINESS_ONSTART_CI !== '1')('isolated business Agent after workspace relocation', () => {
  const cases = [
    { memory: false, round: 1 },
    ...Array.from({ length: process.platform === 'darwin' && process.arch === 'x64' ? 3 : 1 }, (_, index) => ({ memory: true, round: index + 1 })),
  ]
  it.each(cases)('runs actual main/config/onStart/register at the selected Root while old work stays retired (real Memory=$memory, round=$round)', async ({ memory: businessMemory }) => {
    const f = await fixture({ actualAgent: true, actualAdmin: true, businessAgent: true, businessMemory, withMemory: businessMemory, ...(businessMemory ? { memoryHealth: 'healthy' as const } : {}), processLifetimeMs: 300000 })
    const locks = require('../../scripts/lib/cli-lock.mjs'), records = require('../../scripts/lib/workspace-relocation-intent.mjs')
    const lock = await locks.acquireWorkspaceRelocationLock(f.data, f.params.intent_id)
    const runtime = f.manager.modules.get('crabot-agent'); runtime.skip_health_check = false
    const oldChild = f.manager.processes.get('crabot-agent'), oldMemory = f.manager.processes.get('memory-default')
    const native = require('../../scripts/lib/process-identity.cjs'), inspect = native.inspectProcess, memoryImages = new Map<string, unknown>()
    const observer = businessMemory ? vi.spyOn(native, 'inspectProcess').mockImplementation((pid: number) => {
      const identity = inspect(pid)
      if (pid === f.manager.processes.get('memory-default')?.pid && identity && memoryImages.size < 8) {
        memoryImages.set(JSON.stringify([pid, identity.started, identity.executable]), { pid, started: identity.started, executable: identity.executable })
      }
      return identity
    }) : undefined
    const handler = f.manager.methodHandlers.get('verify_workspace_relocation_runtime')
    f.manager.methodHandlers.set('verify_workspace_relocation_runtime', async (...args: any[]) => {
      const started = performance.now()
      let verified = false
      try { const result = await handler(...args); verified = true; return result }
      finally { console.log('[Workspace business runtime verification]', { elapsed_ms: Math.round(performance.now() - started), verified }) }
    })
    try {
      const result = await f.manager.verifyWorkspaceRelocationValidationHealth(f.params, 'fixture-human')
      expect(f.manager.processes.get('crabot-agent')).not.toBe(oldChild)
      if (businessMemory) {
        expect(f.manager.processes.get('memory-default')).not.toBe(oldMemory)
        expect(result.healthy_modules.map((item: any) => item.module_id)).toEqual(['memory-default', 'crabot-agent'])
        expect((await fs.stat(path.join(f.data, 'memory/short_term.db'))).size).toBeGreaterThan(0)
        expect((await fs.readFile(path.join(f.data, 'memory/SCHEMA_VERSION'), 'utf8')).trim()).toBe((await fs.readFile(path.resolve('../crabot-memory/schema_version'), 'utf8')).trim())
        expect(await fs.readFile(path.join(f.data, 'logs/memory-default.log'), 'utf8')).toContain('Registered to Module Manager')
      }
      expect(result.root_verified.runtime_id).toBe(f.manager.childStates.get(f.manager.processes.get('crabot-agent')).runtimeId)
      await vi.waitFor(async () => expect(await fs.readFile(path.join(f.data, 'logs/crabot-agent.log'), 'utf8')).toContain('Unified Agent module started successfully'), { timeout: 10000 })
      const calls = await f.calls()
      expect(calls.filter(item => item.method === '/get_agent_config').length).toBeGreaterThanOrEqual(1)
      expect(await fs.readFile(path.join(f.data, 'logs/crabot-agent.log'), 'utf8')).toContain('- Configured: true')
      expect(calls.some(item => item.method.startsWith('/v1/'))).toBe(false)
      const ledger = JSON.parse(await fs.readFile(path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), 'utf8'))
      expect(ledger.workers[0].task.status).toBe('closed')
      expect(ledger.workers[0].task.closed.by).toBe('migration')
      expect(require('../../scripts/lib/workspace-maintenance.cjs').workspaceMaintenancePending(f.data)).toBe(true)
      expect(records.readWorkspaceRelocationHealth(f.data, f.params.intent_id).root_proof).toEqual(result.root_verified)
      expect((await fetch(`http://127.0.0.1:${f.port}/api/friends`, { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(200)
      const context = { dataDir: f.data, id: f.params.intent_id, launch: records.readWorkspaceRelocationCoordinator(f.data, f.params.intent_id).launch }
      const preparation = require('../../scripts/lib/workspace-coordinator-journal.mjs').createWorkspaceJournalClient(result.coordinator, context, 'file')
      let prepared
      try { prepared = await preparation.call('prepare_completion', {}) } finally { preparation.close() }
      const terminal = require('../../scripts/lib/workspace-finalization-journal.mjs').createWorkspaceFinalizationJournal(result.coordinator, context)
      try {
        const archived = await terminal.archive()
        expect(archived.completion_sha256).toBe(prepared.completion_sha256)
        expect(sha256CanonicalJson(records.readWorkspaceRelocationArchivedCompletion(f.data, f.params.intent_id))).toBe(archived.completion_sha256)
        expect(records.readWorkspaceRelocationFinalizing(f.data, f.params.intent_id).completion_sha256).toBe(archived.completion_sha256)
        expect(() => records.readWorkspaceRelocationHealth(f.data, f.params.intent_id)).toThrow()
        expect(JSON.parse(await fs.readFile(path.join(f.data, 'agent/worker-ledgers/channel%3A%3Asession.json'), 'utf8')).workers[0].task.status).toBe('closed')
        expect(require('../../scripts/lib/workspace-maintenance.cjs').workspaceMaintenancePending(f.data)).toBe(true)
        expect((await fetch(`http://127.0.0.1:${f.port}/api/friends`, { headers: { Authorization: 'Bearer fixture-human' } })).status).toBe(200)
      } finally { terminal.close() }
    } catch (error) {
      if (businessMemory) console.error('[Workspace Memory kernel images]', [...memoryImages.values()])
      if (businessMemory) console.error('[Workspace business Memory]', (await fs.readFile(path.join(f.data, 'logs/memory-default.log'), 'utf8').catch(() => '')).slice(-6000))
      console.error('[Workspace business startup]', (await fs.readFile(path.join(f.data, 'logs/crabot-agent.log'), 'utf8').catch(() => '')).slice(-6000))
      throw error
    } finally {
      observer?.mockRestore()
      const child = f.manager.workspaceValidationProof?.result.coordinator
      if (child?.connected) { const ended = once(child, 'exit'); child.disconnect(); await ended }
      locks.releaseCliLock(lock); await f.cleanup()
    }
  }, process.platform === 'win32' ? 600000 : 180000)
})
