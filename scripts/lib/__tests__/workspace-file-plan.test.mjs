import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import native from '../process-identity.cjs'
import exitProbe from '../known-process-exit.cjs'
import management from '../desktop-management.cjs'
import { acquireCliLock, acquireWorkspaceRelocationLock, releaseCliLock } from '../cli-lock.mjs'
import { WorkspaceCatalog } from '../../../crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson } from '../../../crabot-shared/dist/canonical-json.js'
import * as records from '../workspace-relocation-intent.mjs'
import { createWorkspaceFileToolJournal, serveWorkspaceFileToolJournal } from '../workspace-file-tool-journal.mjs'

const fixtureLifetimeMs = process.platform === 'win32' ? 120000 : 30000

async function fixture(t, { exitEvidence = true, exitRecord = true, crossVolume = false, withWorker = false, targetRelative = 'new' } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'workspace-file-plan-中文 space-')))
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), id = randomUUID()
  const catalog = new WorkspaceCatalog({ dataRoot: data, files: native }); await catalog.initialize()
  const targetRoot = crossVolume ? fs.mkdtempSync('/dev/shm/crabot-file-tools-') : root
  const before = await catalog.snapshot(), source = before.storage_root, target = path.join(targetRoot, targetRelative)
  const ledger = path.join(data, 'agent/worker-ledgers/channel%3A%3Aoriginal.json')
  const worker = { worker_id: 'original-worker', manager_key: 'channel::original', task: { id: 'original-task', title: 'preserve original goal', status: 'halted',
    created_at: '2026-10-27T00:00:00.000Z', halt: { halted_at: '2026-10-27T00:00:00.000Z', halt_reason: 'turn_end' } },
    origin: { trigger_type: 'scheduled' }, report_to: { channel_id: 'channel', session_id: 'original' }, incarnations: [], updated_at: '2026-10-27T00:00:00.000Z' }
  const workers = withWorker ? (await import('../../../crabot-agent/dist/workers/harness/workspace-relocation-scope.js')).captureWorkspaceRelocationWorkers([{ managerKey: worker.manager_key, worker }]) : []
  if (withWorker) { fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.writeFileSync(ledger, JSON.stringify({ manager_key: worker.manager_key, workers: [worker] }), { mode: 0o600 }) }
  fs.writeFileSync(path.join(source, 'default/file'), 'original bytes')
  if (crossVolume) fs.writeFileSync(path.join(source, 'default/finite-archive.bin'), Buffer.alloc(1024 * 1024, 7))
  const lock = await acquireCliLock(data, 'workspace-relocation')
  await records.beginWorkspaceRelocationIntent({ dataDir: data, id, target, expectedRevision: before.revision, protectedRoots: [] })
  records.commitWorkspaceRelocationWorkers({ dataDir: data, id, workers })
  records.commitWorkspaceRelocationProcesses({ dataDir: data, id, processes: [] })
  records.commitWorkspaceRelocationModules({ dataDir: data, id, modules: [] })
  const entry = new URL('../workspace-coordinator-entry.mjs', import.meta.url).href
  const module = new URL('../workspace-relocation-intent.mjs', import.meta.url).href
  const hostCode = `import fs from 'node:fs';import native from ${JSON.stringify(new URL('../process-identity.cjs', import.meta.url).href)};import {readWorkspaceRelocationFilePlan} from ${JSON.stringify(module)};import {copyWorkspaceTreeFd} from ${JSON.stringify(new URL('../workspace-posix-copy.mjs', import.meta.url).href)};import {verifyWorkspaceRelocationCopy} from ${JSON.stringify(new URL('../workspace-file-metadata.mjs', import.meta.url).href)};import {createWorkspaceFileToolJournal} from ${JSON.stringify(new URL('../workspace-file-tool-journal.mjs', import.meta.url).href)};import {spawnWorkspaceTar} from ${JSON.stringify(new URL('../workspace-tar.mjs', import.meta.url).href)};
    let actors=[],client;const hostContext={dataDir:${JSON.stringify(data)},id:${JSON.stringify(id)}};const stop=async()=>{for(const actor of actors){actor.cancel();actor.child.stdout.resume();if(actor.child.exitCode===null&&actor.child.signalCode===null)actor.child.kill('SIGTERM')}await Promise.all(actors.map(actor=>actor.closed))};
    process.on('message',async message=>{if(typeof message!=='string')return;try{let result;if(message==='tools-create'){actors=[await spawnWorkspaceTar('pack'),await spawnWorkspaceTar('unpack')];result=actors.map((actor,index)=>({role:index?'unpack':'pack',process:actor.identity}))}
      else if(message==='tools-pack'){actors[0].child.stdin.end();await actors[0].permit();result=true}
      else if(message==='tools-stop'){await stop();result=true}
      else if(message==='tools-copy'){client??=createWorkspaceFileToolJournal(hostContext);const plan=readWorkspaceRelocationFilePlan(hostContext.dataDir,hostContext.id);const container=plan.staging_path,tree=container+'/tree';const {readWorkspaceRelocationFileActors}=await import(${JSON.stringify(module)});const facts=readWorkspaceRelocationFileActors(hostContext.dataDir,hostContext.id);if(!facts.staging||facts.tools)throw Object.assign(new Error('finite staging already consumed'),{code:'CRABOT_PRIVATE_STAGING'});const fds=[];try{for(const directory of [${JSON.stringify(source)},tree,container])fds.push(fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW));await copyWorkspaceTreeFd(...fds,{journal:client})}finally{for(const fd of fds)fs.closeSync(fd)}result=await verifyWorkspaceRelocationCopy(${JSON.stringify(source)},tree)}
      else if(message==='tools-rpc-reset'){client?.close();client=createWorkspaceFileToolJournal(hostContext);result=true}
      else if(message.startsWith('tools-rpc-')){client??=createWorkspaceFileToolJournal(hostContext);const operation=message.slice('tools-rpc-'.length);result=await client[operation](operation==='register'?actors.map((actor,index)=>({role:index?'unpack':'pack',process:actor.identity})):undefined)}else throw new Error('finite unknown operation');process.send({kind:'fixture-tools-reply',result})}catch(error){process.send({kind:'fixture-tools-reply',error:error.code??error.message})}});
    process.once('disconnect',async()=>{await stop();process.exit(0)});process.send('ready');setTimeout(()=>process.exit(3),${fixtureLifetimeMs});`
  const code = `import fs from 'node:fs';import{spawn}from'node:child_process';import{once}from'node:events';import native from ${JSON.stringify(new URL('../process-identity.cjs', import.meta.url).href)};import{enterWorkspaceRelocationCoordinator}from ${JSON.stringify(entry)};import * as records from ${JSON.stringify(module)};
    const context=await enterWorkspaceRelocationCoordinator(), args={dataDir:context.dataDir,id:context.id};
    if(${exitEvidence}){records.prepareWorkspaceRelocationProcessStops(args);records.observeWorkspaceRelocationProcesses({...args,processes:[]});
      records.prepareWorkspaceRelocationStops({...args,workers:${JSON.stringify(workers)}});records.completeWorkspaceRelocationStops({...args,results:[]});
      records.prepareWorkspaceRelocationModuleStops({...args,modules:[]});records.completeWorkspaceRelocationModuleStops({...args,results:[]});
      records.completeWorkspaceRelocationProcessStops(args);if(${exitRecord})records.commitWorkspaceRelocationExecutionExit(args)}
    let host,hostIdentity,hostEnded,tools;
    async function ensureHost(){if(host)return;host=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(hostCode)}],{cwd:${JSON.stringify(source)},stdio:['ignore','ignore','ignore','ipc']});hostEnded=once(host,'exit');await once(host,'message');hostIdentity=native.inspectProcess(host.pid);process.send({kind:'fixture-actor',identity:hostIdentity})}
    process.send({kind:'fixture-ready'});process.on('message',async message=>{if(message.kind!=='command')return;
      const sync=fs.fsyncSync;try{if(message.operation==='unlock')context.release();
        if(message.operation==='fail-sync')fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory())throw Object.assign(new Error('finite sync failure'),{code:'EIO'});return sync(fd)};
        let result;
        if(['host-launch','host-launch-preload','host-launch-extra','host-launch-after-unlock'].includes(message.operation)){if(message.operation==='host-launch-preload')process.env.NODE_OPTIONS='--require '+JSON.stringify(${JSON.stringify(path.join(root, 'host-preload.cjs'))});const {launchWorkspaceFileHost}=await import(${JSON.stringify(new URL('../workspace-file-host.mjs', import.meta.url).href)});if(message.operation==='host-launch-after-unlock')context.release();const launched=await launchWorkspaceFileHost(message.operation==='host-launch-extra'?{...args,entry:'not-accepted'}:args);if(launched.child){host=launched.child;hostIdentity=launched.host;hostEnded=once(host,'exit');process.send({kind:'fixture-actor',identity:hostIdentity})}result={dispatch:launched.dispatch,host:launched.host}}
        else if(message.operation==='stage-create-failure'){const key=process.platform==='win32'?'createPrivateDirectory':'createPrivateStagingDirectory',create=native[key];native[key]=directory=>{create(directory);throw Object.assign(new Error('finite creation acknowledgement failure'),{code:'EIO'})};try{result=records.prepareWorkspaceRelocationStaging(args)}finally{native[key]=create}}
        else if(['file-prepare-wrong-receipt','file-prepare-extra-receipt','file-prepare-disconnected-receipt'].includes(message.operation)){
          const {prepareWorkspaceFilesWithHost}=await import(${JSON.stringify(new URL('../workspace-file-host.mjs', import.meta.url).href)});const send=host.send.bind(host);
          host.send=(value,...rest)=>{if(value?.kind==='workspace_file_completion_verified'){if(message.operation==='file-prepare-disconnected-receipt'){host.disconnect();const callback=rest.at(-1);if(typeof callback==='function')callback(Object.assign(new Error('finite disconnected receipt'),{code:'ERR_IPC_CHANNEL_CLOSED'}));return false}return send(message.operation==='file-prepare-extra-receipt'?{...value,command:'not-accepted'}:{...value,attempt_sha256:'0'.repeat(64)},...rest)}return send(value,...rest)};
          try{result=await prepareWorkspaceFilesWithHost(host,args)}finally{host.send=send}
        }
        else if(message.operation==='file-prepare-delayed-completion'){
          const {prepareWorkspaceFilesWithHost}=await import(${JSON.stringify(new URL('../workspace-file-host.mjs', import.meta.url).href)});const emit=host.emit.bind(host);let held=false,aliveAtDelivery=false;
          host.emit=(event,...values)=>{if(event==='message'&&values[0]?.kind==='workspace_file_prepared'&&!held){held=true;setTimeout(()=>{aliveAtDelivery=native.sameProcess(hostIdentity,native.inspectProcess(host.pid));emit(event,...values)},150);return true}return emit(event,...values)};
          try{const prepared=await prepareWorkspaceFilesWithHost(host,args);result={prepared,held,aliveAtDelivery}}finally{host.emit=emit}
        }
        else if(message.operation==='closure-prepare-fixture'){fs.mkdirSync(args.dataDir+'/agent/worker-ledgers',{recursive:true});const agent=await import(${JSON.stringify(new URL('../../../crabot-agent/dist/core/workspace-relocation-closure.js', import.meta.url).href)});result=await agent.prepareWorkspaceRelocationClosure(args)}
        else if(message.operation==='closure-commit-fixture'){const agent=await import(${JSON.stringify(new URL('../../../crabot-agent/dist/core/workspace-relocation-closure.js', import.meta.url).href)});result=await agent.commitWorkspaceRelocationClosure(args)}
        else if(message.operation==='recovery-prepare-fixture'){const agent=await import(${JSON.stringify(new URL('../../../crabot-agent/dist/core/workspace-relocation-recovery.js', import.meta.url).href)});result=await agent.prepareWorkspaceRelocationRecovery(args)}
        else if(message.operation==='recovery-commit-fixture'){const agent=await import(${JSON.stringify(new URL('../../../crabot-agent/dist/core/workspace-relocation-recovery.js', import.meta.url).href)});result=await agent.commitWorkspaceRelocationRecovery(args)}
        else if(message.operation==='root-plan-fixture')result=await records.prepareWorkspaceRelocationRootPlan(args)
        else if(message.operation==='root-publish-fixture')result=await records.publishWorkspaceRelocationRoot(args)
        else if(message.operation==='root-select-fixture')result=await records.selectWorkspaceRelocationRoot(args)
        else if(['closure-interrupt-prepared','closure-interrupt-replaced'].includes(message.operation)){const rename=fs.renameSync;fs.renameSync=(source,target)=>{if(target===${JSON.stringify(ledger)}){if(message.operation==='closure-interrupt-replaced')rename(source,target);throw Object.assign(new Error('finite closure interruption'),{code:'EIO'})}return rename(source,target)};try{const agent=await import(${JSON.stringify(new URL('../../../crabot-agent/dist/core/workspace-relocation-closure.js', import.meta.url).href)});result=await agent.commitWorkspaceRelocationClosure(args)}finally{fs.renameSync=rename}}
        else if(message.operation==='file-begin')result=await records.beginWorkspaceRelocationFiles(args);
        else if(message.operation==='file-ready')result=await records.commitWorkspaceRelocationFileReady(args);
        else if(message.operation==='file-move-fixture'){const intent=records.readWorkspaceRelocationIntent(args.dataDir),plan=records.readWorkspaceRelocationFilePlan(args.dataDir,args.id);native.renameDirectoryNoReplace(intent.source.path,plan.staging_path+'/tree');result=true}
        else if(message.operation==='stage-prepare')result=records.prepareWorkspaceRelocationStaging(args);
        else if(message.operation==='actors-prepare')result=records.prepareWorkspaceRelocationFileActors(args);
        else if(['tools-create','tools-pack','tools-stop','tools-copy'].includes(message.operation)||message.operation.startsWith('tools-rpc-')){await ensureHost();const response=new Promise(resolve=>{const receive=message=>{if(message.kind==='fixture-tools-reply'){host.off('message',receive);resolve(message)}};host.on('message',receive)});host.send(message.operation);const reply=await response;if(reply.error)throw Object.assign(new Error(reply.error),{code:reply.error});if(message.operation==='tools-create')tools=reply.result;result=reply.result}
        else if(['tools-relay','tools-relay-drop','tools-relay-drop-permit'].includes(message.operation)){const {serveWorkspaceFileToolJournal}=await import(${JSON.stringify(new URL('../workspace-file-tool-journal.mjs', import.meta.url).href)});serveWorkspaceFileToolJournal(host,args);if(message.operation!=='tools-relay'){const selected=message.operation==='tools-relay-drop'?'register':'permit',send=host.send.bind(host);let dropped=false;host.send=(message,...rest)=>{if(message.kind==='workspace_file_tool_reply'&&message.operation===selected&&!dropped){dropped=true;return send({...message,ok:false,result:null},...rest)}return send(message,...rest)}}result=true}
        else if(message.operation==='tools-permit')result=records.permitWorkspaceRelocationCopyTools(args);
        else if(message.operation==='tools-complete')result=records.completeWorkspaceRelocationCopyTools(args);
        else if(message.operation.startsWith('tools-register')){const selected=structuredClone(tools);if(message.operation==='tools-register-parent')selected[0].process.parent=process.pid;if(message.operation==='tools-register-generation')selected[0].process.started='replaced';if(message.operation==='tools-register-owner')selected[0].process.owner='other';if(message.operation==='tools-register-role')selected[0].role='copy';if(message.operation==='tools-register-duplicate')selected[1].process=selected[0].process;result=records.registerWorkspaceRelocationCopyTools({...args,tools:selected})}
        else if(message.operation==='host-permit')result=records.permitWorkspaceRelocationFileHost(args);
        else if(message.operation==='host-stop'){native.terminateKnownProcess(hostIdentity);await hostEnded;result={stopped:true}}
        else if(message.operation.startsWith('host-')){
          await ensureHost();let selected={...hostIdentity};
          if(message.operation==='host-generation')selected.started='replaced';
          if(message.operation==='host-parent')selected=native.inspectProcess(process.pid);
          if(message.operation==='host-owner')selected.owner='other-owner';
          if(message.operation==='host-executable')selected.executable='other-executable';
          if(message.operation==='host-write-failure'){const write=fs.writeSync;fs.writeSync=(fd,bytes,offset,length)=>{write(fd,bytes,offset,Math.min(length,9));throw Object.assign(new Error('finite append failure'),{code:'EIO'})};try{result=records.registerWorkspaceRelocationFileHost({...args,process:selected})}finally{fs.writeSync=write}}
          else if(message.operation==='host-sync-failure'){const inode=fs.lstatSync(args.dataDir+'/workspace-control/relocation-active/relocation-file-actors.jsonl',{bigint:true}).ino;fs.fsyncSync=fd=>{if(fs.fstatSync(fd,{bigint:true}).ino===inode)throw Object.assign(new Error('finite sync failure'),{code:'EIO'});return sync(fd)};result=records.registerWorkspaceRelocationFileHost({...args,process:selected})}
          else result=records.registerWorkspaceRelocationFileHost({...args,process:selected});
        }else result=await records.prepareWorkspaceRelocationFilePlan(args);
        process.send({kind:'result',result})}
      catch(error){process.send({kind:'result',error:{code:error.code,message:error.message}})}finally{fs.fsyncSync=sync}});
    process.once('disconnect',()=>{context.release();process.exit(0)});setTimeout(()=>process.exit(3),${fixtureLifetimeMs});`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const exited = once(child, 'exit'); let error = ''; child.stderr.on('data', bytes => { error += bytes })
  const messages = []; child.on('message', message => messages.push(message))
  t.after(async () => {
    releaseCliLock(lock)
    for (const message of messages) if (message.kind === 'fixture-actor') native.terminateKnownProcess(message.identity)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited; fs.rmSync(root, { recursive: true, force: true }); if (crossVolume) fs.rmSync(targetRoot, { recursive: true, force: true })
  })
  await once(child, 'spawn')
  const launch = records.commitWorkspaceRelocationCoordinator({ dataDir: data, id, launchId: randomUUID(), coordinator: native.inspectProcess(child.pid) })
  child.send({ kind: 'workspace_relocation_start', data_dir: data, intent_id: id, launch_id: launch.launch_id, launch_sha256: sha256CanonicalJson(launch) })
  releaseCliLock(lock)
  const wait = async (predicate, operation = 'initial-ready') => {
    const started = Date.now(), deadline = started + (process.platform === 'win32' ? 30000 : 10000)
    while (!predicate()) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error('finite file-plan fixture: ' + JSON.stringify({
        operation, elapsed_ms: Date.now() - started, exit_code: child.exitCode, signal: child.signalCode, stderr: error.slice(-4096),
      }))
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  await wait(() => messages.some(message => message.kind === 'fixture-ready'))
  const command = async (operation = 'prepare') => {
    const offset = messages.length; child.send({ kind: 'command', operation })
    await wait(() => messages.slice(offset).some(message => message.kind === 'result'), operation)
    return messages.slice(offset).find(message => message.kind === 'result')
  }
  return { root, data, id, source, target, catalog, before, child, exited, command, file: path.join(data, 'workspace-control/relocation-active/relocation-files.json') }
}

test('original coordinator publishes one fixed file plan without moving source or selecting a root', async t => {
  const f = await fixture(t), response = await f.command()
  assert.equal(response.error, undefined); assert.equal(response.result.dispatch, 'dispatch')
  const plan = records.readWorkspaceRelocationFilePlan(f.data, f.id)
  assert.deepEqual(response.result.plan, plan); assert.equal(plan.mode, 'rename')
  assert.equal(plan.catalog_sha256, sha256CanonicalJson(f.before))
  const { inspectWorkspaceRelocationContent } = await import('../../../crabot-shared/dist/workspace-relocation-content.js')
  assert.equal(plan.source_content_sha256, (await inspectWorkspaceRelocationContent(f.source, 'rename')).fingerprint)
  assert.equal(plan.execution_exit_sha256, sha256CanonicalJson(records.readWorkspaceRelocationExecutionExit(f.data, f.id)))
  assert.equal(plan.staging_path, path.join(f.root, '.crabot-workspace-' + f.id))
  assert.equal(fs.existsSync(plan.staging_path), false); assert.equal(fs.existsSync(f.target), false)
  assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
  assert.deepEqual(await f.catalog.snapshot(), f.before)
  const bytes = fs.readFileSync(f.file)
  assert.equal((await f.command()).result.dispatch, 'observe'); assert.deepEqual(fs.readFileSync(f.file), bytes)
})

test('readback after a file effect observes the first plan without re-inspecting or recreating the source', async t => {
  const f = await fixture(t); assert.equal((await f.command()).result.dispatch, 'dispatch')
  const first = fs.readFileSync(f.file); fs.renameSync(f.source, path.join(f.root, 'retained-original'))
  assert.equal((await f.command()).result.dispatch, 'observe')
  assert.deepEqual(fs.readFileSync(f.file), first); assert.equal(fs.existsSync(f.source), false)
})

for (const scenario of ['missing-exit', 'lost-lock', 'stale-catalog', 'target-occupied', 'stage-occupied']) test('file planning refuses unsafe preparation before filesystem effects: ' + scenario, async t => {
  const f = await fixture(t, { exitEvidence: scenario !== 'missing-exit' })
  if (scenario === 'stale-catalog') await f.catalog.update('default', { expected_revision: f.before.revision, name: 'changed', description: '' })
  if (scenario === 'target-occupied') { fs.mkdirSync(f.target); fs.writeFileSync(path.join(f.target, 'keep'), 'user content') }
  const staging = path.join(f.root, '.crabot-workspace-' + f.id)
  if (scenario === 'stage-occupied') fs.mkdirSync(staging)
  const response = await f.command(scenario === 'lost-lock' ? 'unlock' : 'prepare')
  assert.equal(response.error?.code, scenario === 'target-occupied' ? 'WORKSPACE_DIRECTORY_CONFLICT' : 'WORKSPACE_RELOCATION_INVALID'); assert.equal(fs.existsSync(f.file), false)
  assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
  if (scenario === 'target-occupied') assert.equal(fs.readFileSync(path.join(f.target, 'keep'), 'utf8'), 'user content')
})

for (const damage of ['hash', 'extra', 'mode', 'parent', 'content', 'hardlink', 'link']) test('damaged fixed file plan cannot be replaced or dispatched again: ' + damage, async t => {
  const f = await fixture(t); assert.equal((await f.command()).result.dispatch, 'dispatch')
  if (damage === 'hardlink') fs.linkSync(f.file, path.join(f.root, 'second-link'))
  else if (damage === 'link') { fs.renameSync(f.file, path.join(f.root, 'retained-plan')); fs.symlinkSync(path.join(f.root, 'retained-plan'), f.file) }
  else { const plan = JSON.parse(fs.readFileSync(f.file)); if (damage === 'hash') plan.execution_exit_sha256 = '0'.repeat(64); else if (damage === 'mode') plan.mode = 'copy'; else if (damage === 'content') plan.source_content_sha256 = 'not-a-digest'; else if (damage === 'parent') { plan.staging_parent.path = f.source; plan.staging_path = path.join(f.source, '.crabot-workspace-' + f.id) } else plan.command = 'not permitted'; fs.writeFileSync(f.file, JSON.stringify(plan)) }
  const first = fs.readFileSync(f.file)
  assert.throws(() => records.readWorkspaceRelocationFilePlan(f.data, f.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.ok((await f.command()).error); assert.deepEqual(fs.readFileSync(f.file), first)
})

test('a fresh lock owner cannot impersonate the exited original coordinator to dispatch file effects', async t => {
  const f = await fixture(t); f.child.disconnect(); await f.exited
  const lock = await acquireWorkspaceRelocationLock(f.data, f.id, 0)
  try { await assert.rejects(records.prepareWorkspaceRelocationFilePlan({ dataDir: f.data, id: f.id }), { code: 'WORKSPACE_RELOCATION_INVALID' }) }
  finally { releaseCliLock(lock) }
  assert.equal(fs.existsSync(f.file), false); assert.equal(fs.existsSync(f.target), false)
})


test('a lost directory-sync acknowledgement retains the first file plan and retries only its sync', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), response = await f.command('fail-sync')
  assert.equal(response.error?.code, 'EIO')
  const bytes = fs.readFileSync(f.file)
  assert.equal((await f.command()).result.dispatch, 'observe'); assert.deepEqual(fs.readFileSync(f.file), bytes)
  assert.equal(fs.existsSync(f.target), false)
})

test('a retained file plan prevents reconstruction of a missing original exit proof', async t => {
  const f = await fixture(t); assert.equal((await f.command()).result.dispatch, 'dispatch')
  fs.unlinkSync(path.join(f.data, 'workspace-control/relocation-active/relocation-execution-exit.json'))
  const bytes = fs.readFileSync(f.file)
  assert.throws(() => records.readWorkspaceRelocationFilePlan(f.data, f.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.equal((await f.command()).error?.code, 'WORKSPACE_RELOCATION_INVALID'); assert.deepEqual(fs.readFileSync(f.file), bytes)
})


test('original file-host attempt, actual child identity and permission are durable once without filesystem effects', async t => {
  const f = await fixture(t), file = path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl')
  assert.equal((await f.command('actors-prepare')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.equal(fs.existsSync(file), false)
  await f.command()
  assert.equal((await f.command('actors-prepare')).result.dispatch, 'dispatch')
  assert.equal((await f.command('host-permit')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  const host = (await f.command('host-register')).result.host
  assert.equal(host.process.parent, f.child.pid); assert.equal(native.isProcessExited(host.process.pid), false)
  assert.equal((await f.command('host-permit')).result.dispatch, 'dispatch')
  const bytes = fs.readFileSync(file)
  assert.equal((await f.command('host-register')).result.dispatch, 'observe')
  assert.equal((await f.command('host-permit')).result.dispatch, 'observe')
  assert.equal((await f.command('actors-prepare')).result.dispatch, 'observe')
  assert.deepEqual(fs.readFileSync(file), bytes)
  const result = records.readWorkspaceRelocationFileActors(f.data, f.id)
  assert.deepEqual(result.host, host); assert.equal(result.permission.type, 'host_permitted')
  assert.deepEqual(await f.catalog.snapshot(), f.before); assert.equal(fs.existsSync(f.target), false)
  assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
})

for (const kind of ['generation', 'parent', 'owner', 'executable']) test('file host cannot claim another incarnation or role: ' + kind, async t => {
  const f = await fixture(t); await f.command(); await f.command('actors-prepare')
  const file = path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl'), bytes = fs.readFileSync(file)
  assert.equal((await f.command('host-' + kind)).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(records.readWorkspaceRelocationFileActors(f.data, f.id).host, null)
})

test('an exited recorded file host cannot be permitted again or replaced with a new child', async t => {
  const f = await fixture(t); await f.command(); await f.command('actors-prepare'); await f.command('host-register'); await f.command('host-stop')
  const file = path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl'), bytes = fs.readFileSync(file)
  assert.equal((await f.command('host-permit')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.equal((await f.command('host-register')).result.dispatch, 'observe'); assert.deepEqual(fs.readFileSync(file), bytes)
  assert.equal(records.readWorkspaceRelocationFileActors(f.data, f.id).permission, null)
})

for (const damage of ['truncated', 'hash', 'extra', 'null-host', 'null-permission', 'hardlink', 'missing-plan']) test('damaged file actor records stay fenced without reconstruction: ' + damage, async t => {
  const f = await fixture(t); await f.command(); await f.command('actors-prepare'); await f.command('host-register')
  const file = path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl')
  if (damage === 'truncated') fs.appendFileSync(file, '{')
  else if (damage === 'hardlink') fs.linkSync(file, path.join(f.root, 'retained-actor-link'))
  else if (damage === 'missing-plan') fs.unlinkSync(f.file)
  else {
    const rows = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(JSON.parse)
    if (damage === 'hash') rows[1].previous_sha256 = '0'.repeat(64); else if (damage === 'null-host') rows[1] = null; else if (damage === 'null-permission') rows.push(null); else rows[0].command = 'untrusted'
    fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n')
  }
  const bytes = fs.readFileSync(file)
  assert.throws(() => records.readWorkspaceRelocationFileActors(f.data, f.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.equal((await f.command('actors-prepare')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.equal((await f.command('host-permit')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  if (damage === 'missing-plan') { assert.equal((await f.command()).error?.code, 'WORKSPACE_RELOCATION_INVALID'); assert.equal(fs.existsSync(f.file), false) }
  assert.deepEqual(fs.readFileSync(file), bytes)
})

test('partial actor append is never truncated or replayed after an I/O failure', async t => {
  const f = await fixture(t); await f.command(); await f.command('actors-prepare')
  assert.equal((await f.command('host-write-failure')).error?.code, 'EIO')
  const file = path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl'), bytes = fs.readFileSync(file)
  assert.equal((await f.command('host-register')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.deepEqual(fs.readFileSync(file), bytes)
})

test('an unconfirmed complete actor append is synced on observation without registering a replacement', async t => {
  const f = await fixture(t); await f.command(); await f.command('actors-prepare')
  assert.equal((await f.command('host-sync-failure')).error?.code, 'EIO')
  const file = path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl'), bytes = fs.readFileSync(file)
  assert.equal((await f.command('host-register')).result.dispatch, 'observe'); assert.deepEqual(fs.readFileSync(file), bytes)
})


for (const scenario of ['normal', 'blocked preload']) test('actual fixed file host enters once through the original coordinator: ' + scenario, async t => {
  const f = await fixture(t), marker = path.join(f.root, 'inherited-loader-ran')
  fs.writeFileSync(path.join(f.root, 'host-preload.cjs'), 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ',"must not load")')
  await f.command()
  const launched = await f.command(scenario === 'blocked preload' ? 'host-launch-preload' : 'host-launch')
  assert.equal(launched.error, undefined, JSON.stringify(launched.error)); assert.equal(launched.result.dispatch, 'dispatch')
  assert.equal(launched.result.host.parent, f.child.pid); assert.equal(native.isProcessExited(launched.result.host.pid), false)
  assert.equal(fs.existsSync(marker), false)
  const actors = records.readWorkspaceRelocationFileActors(f.data, f.id), bytes = fs.readFileSync(path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl'))
  assert.equal(actors.permission.type, 'host_permitted')
  const again = await f.command('host-launch'); assert.equal(again.result.dispatch, 'observe'); assert.deepEqual(again.result.host, launched.result.host)
  assert.deepEqual(fs.readFileSync(path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl')), bytes)
  assert.equal(native.listChildProcessIds(f.child.pid).filter(pid => pid === launched.result.host.pid).length, 1)
  assert.equal(fs.existsSync(f.target), false); assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
})


test('the actual file host remains identifiable until its delayed completion is verified', { timeout: fixtureLifetimeMs }, async t => {
  const f = await fixture(t)
  assert.equal((await f.command()).error, undefined)
  assert.equal((await f.command('host-launch')).error, undefined)
  assert.equal((await f.command('stage-prepare')).error, undefined)
  const response = await f.command('file-prepare-delayed-completion')
  assert.equal(response.error, undefined, JSON.stringify(response.error))
  assert.equal(response.result.held, true); assert.equal(response.result.aliveAtDelivery, true)
  assert.equal(response.result.prepared.dispatch, 'dispatch')
  const actors = records.readWorkspaceRelocationFileActors(f.data, f.id)
  assert.ok(actors.file_ready); assert.equal(exitProbe.probeKnownProcessExit([actors.host.process]).state, 'stopped')
  assert.deepEqual(await f.catalog.snapshot(), f.before)
  assert.equal(fs.readFileSync(path.join(actors.staging.container.path, 'tree/default/file'), 'utf8'), 'original bytes')
})

for (const mode of ['wrong', 'extra', 'disconnected']) test('a ' + mode + ' completion receipt never publishes file readiness', { timeout: fixtureLifetimeMs }, async t => {
  const f = await fixture(t)
  assert.equal((await f.command()).error, undefined)
  assert.equal((await f.command('host-launch')).error, undefined)
  assert.equal((await f.command('stage-prepare')).error, undefined)
  const response = await f.command('file-prepare-' + mode + '-receipt')
  assert.equal(response.error?.code, 'CRABOT_WORKSPACE_FILE_HOST')
  const actors = records.readWorkspaceRelocationFileActors(f.data, f.id)
  assert.equal(actors.file_ready, null); assert.equal(exitProbe.probeKnownProcessExit([actors.host.process]).state, 'stopped')
  assert.deepEqual(await f.catalog.snapshot(), f.before); assert.equal(fs.existsSync(f.target), false)
  assert.equal(fs.readFileSync(path.join(actors.staging.container.path, 'tree/default/file'), 'utf8'), 'original bytes')
})

for (const scenario of ['host-launch-extra', 'host-launch-after-unlock']) test('fixed file host rejects unsafe launch before a child exists: ' + scenario, async t => {
  const f = await fixture(t); await f.command()
  assert.equal((await f.command(scenario)).error?.code, 'CRABOT_WORKSPACE_FILE_HOST')
  assert.equal(records.readWorkspaceRelocationFileActors(f.data, f.id).attempt, null)
  assert.deepEqual(native.listChildProcessIds(f.child.pid), [])
})

test('an exited fixed file host is observed without automatically creating or permitting its replacement', async t => {
  const f = await fixture(t); await f.command(); const started = await f.command('host-launch'); await f.command('host-stop')
  const bytes = fs.readFileSync(path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl'))
  const observed = await f.command('host-launch')
  assert.equal(observed.result.dispatch, 'observe'); assert.deepEqual(observed.result.host, started.result.host)
  assert.equal(native.isProcessExited(started.result.host.pid), true); assert.deepEqual(native.listChildProcessIds(f.child.pid), [])
  assert.deepEqual(fs.readFileSync(path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl')), bytes)
})

test('the fixed file script cannot enter without a parent IPC channel', { timeout: 15000 }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'workspace-host-no-ipc-'))), data = path.join(root, 'must-not-create')
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../workspace-file-host.mjs', import.meta.url))], { env: { ...process.env, DATA_DIR: data, NODE_OPTIONS: '', NODE_PATH: '' }, stdio: 'ignore' }), ended = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended; fs.rmSync(root, { recursive: true, force: true }) })
  assert.equal((await ended)[0], 1); assert.equal(fs.existsSync(data), false)
})

test('correct private material hashes cannot authorize a different real child and parent', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.command(); await f.command('actors-prepare'); await f.command('host-register')
  const actors = records.readWorkspaceRelocationFileActors(f.data, f.id), bytes = fs.readFileSync(path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../workspace-file-host.mjs', import.meta.url))], { env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }), ended = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended })
  await once(child, 'spawn')
  child.send({ kind: 'workspace_file_host_start', data_dir: f.data, intent_id: f.id, attempt_sha256: sha256CanonicalJson(actors.attempt), host_sha256: sha256CanonicalJson(actors.host) })
  assert.equal((await ended)[0], 1)
  assert.equal(records.readWorkspaceRelocationFileActors(f.data, f.id).permission, null)
  assert.deepEqual(fs.readFileSync(path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl')), bytes)
  assert.equal(fs.existsSync(f.target), false)
})


const crossVolumeTools = { skip: process.platform !== 'linux' || !fs.existsSync('/dev/shm') || fs.statSync(tmpdir()).dev === fs.statSync('/dev/shm').dev }
async function toolsFixture(t, permitHost = true) {
  const f = await fixture(t, { crossVolume: true })
  assert.equal((await f.command()).result.plan.mode, 'copy')
  await f.command('actors-prepare'); await f.command('host-register')
  if (permitHost) { await f.command('host-permit'); assert.equal((await f.command('stage-prepare')).error, undefined); assert.equal((await f.command('file-begin')).error, undefined) }
  const created = await f.command('tools-create'); assert.equal(created.error, undefined)
  return { ...f, tools: created.result, actorsFile: path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl') }
}

test('real copy tools register and permit once, and exec remains active until the whole set exits', crossVolumeTools, async t => {
  const f = await toolsFixture(t)
  assert.equal((await f.command('tools-complete')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.equal((await f.command('tools-register')).result.dispatch, 'dispatch')
  assert.equal((await f.command('tools-complete')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.equal((await f.command('tools-permit')).result.dispatch, 'dispatch')
  const before = fs.readFileSync(f.actorsFile)
  assert.equal((await f.command('tools-register')).result.dispatch, 'observe'); assert.equal((await f.command('tools-permit')).result.dispatch, 'observe')
  assert.deepEqual(fs.readFileSync(f.actorsFile), before)
  assert.equal((await f.command('tools-pack')).error, undefined)
  const pack = f.tools[0].process, deadline = Date.now() + 2000
  while (native.inspectProcess(pack.pid)?.executable === pack.executable && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  const current = native.inspectProcess(pack.pid)
  assert.equal(current.started, pack.started); assert.notEqual(current.executable, pack.executable)
  assert.equal((await f.command('tools-complete')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.equal((await f.command('tools-stop')).error, undefined)
  assert.equal((await f.command('tools-complete')).result.dispatch, 'dispatch')
  const completed = fs.readFileSync(f.actorsFile), facts = records.readWorkspaceRelocationFileActors(f.data, f.id)
  assert.equal(facts.tool_exit.type, 'copy_tools_exited')
  assert.equal((await f.command('tools-complete')).result.dispatch, 'observe')
  assert.equal((await f.command('tools-permit')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.deepEqual(fs.readFileSync(f.actorsFile), completed)
  assert.equal(fs.existsSync(f.target), false)
  assert.equal(facts.staging.container.path, records.readWorkspaceRelocationFilePlan(f.data, f.id).staging_path)
  assert.deepEqual(fs.readdirSync(facts.staging.tree.path), [])
  assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
  assert.deepEqual(await f.catalog.snapshot(), f.before)
})

for (const mode of ['parent', 'generation', 'owner', 'role', 'duplicate']) test('copy tool registration rejects ' + mode, crossVolumeTools, async t => {
  const f = await toolsFixture(t), before = fs.readFileSync(f.actorsFile)
  assert.equal((await f.command('tools-register-' + mode)).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.deepEqual(fs.readFileSync(f.actorsFile), before); assert.equal(records.readWorkspaceRelocationFileActors(f.data, f.id).tools, null)
  await f.command('tools-stop')
})

test('unpermitted Host cannot register tools and cancellation never grants later permission', crossVolumeTools, async t => {
  const f = await toolsFixture(t, false)
  assert.equal((await f.command('tools-register')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  await f.command('host-permit'); await f.command('stage-prepare'); await f.command('file-begin'); assert.equal((await f.command('tools-register')).result.dispatch, 'dispatch')
  await f.command('tools-stop'); assert.equal((await f.command('tools-complete')).result.dispatch, 'dispatch')
  const facts = records.readWorkspaceRelocationFileActors(f.data, f.id)
  assert.equal(facts.tool_permission, null); assert.equal(facts.tool_exit.type, 'copy_tools_exited')
  assert.equal((await f.command('tools-permit')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
})

for (const damage of ['hash', 'null', 'role', 'extra', 'reordered']) test('copy tool chain remains fenced after damage: ' + damage, crossVolumeTools, async t => {
  const f = await toolsFixture(t); await f.command('tools-register'); await f.command('tools-permit'); await f.command('tools-stop')
  const rows = fs.readFileSync(f.actorsFile, 'utf8').trimEnd().split('\n').map(JSON.parse)
  const index = rows.findIndex(row => row.type === 'copy_tools')
  if (damage === 'hash') rows[index].previous_sha256 = '0'.repeat(64)
  else if (damage === 'null') rows[index] = null
  else if (damage === 'role') rows[index].tools[0].role = 'copy'
  else if (damage === 'extra') rows[index].command = 'not accepted'
  else rows.reverse()
  fs.writeFileSync(f.actorsFile, rows.map(JSON.stringify).join('\n') + '\n')
  const bytes = fs.readFileSync(f.actorsFile)
  assert.throws(() => records.readWorkspaceRelocationFileActors(f.data, f.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.equal((await f.command('tools-complete')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.deepEqual(fs.readFileSync(f.actorsFile), bytes)
})


for (const mode of ['confirmed', 'lost acknowledgement']) test('real Host IPC journals its fixed copy tools: ' + mode, crossVolumeTools, async t => {
  const f = await toolsFixture(t)
  assert.equal((await f.command(mode === 'confirmed' ? 'tools-relay' : 'tools-relay-drop')).error, undefined)
  if (mode === 'lost acknowledgement') {
    assert.equal((await f.command('tools-rpc-register')).error?.code, 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE')
    assert.ok(records.readWorkspaceRelocationFileActors(f.data, f.id).tools)
    await f.command('tools-rpc-reset')
  }
  const registered = await f.command('tools-rpc-register')
  assert.equal(registered.error, undefined); assert.equal(registered.result.dispatch, mode === 'confirmed' ? 'dispatch' : 'observe')
  assert.deepEqual(registered.result.record.tools, f.tools)
  assert.equal((await f.command('tools-rpc-permit')).result.dispatch, 'dispatch')
  const first = fs.readFileSync(f.actorsFile)
  assert.equal((await f.command('tools-rpc-register')).result.dispatch, 'observe')
  assert.equal((await f.command('tools-rpc-permit')).result.dispatch, 'observe')
  assert.deepEqual(fs.readFileSync(f.actorsFile), first)
  assert.equal((await f.command('tools-rpc-complete')).error?.code, 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE')
  await f.command('tools-rpc-reset'); await f.command('tools-stop')
  assert.equal((await f.command('tools-rpc-complete')).result.dispatch, 'dispatch')
  assert.equal((await f.command('tools-rpc-complete')).result.dispatch, 'observe')
  assert.ok(records.readWorkspaceRelocationFileActors(f.data, f.id).tool_exit)
  assert.equal(fs.existsSync(f.target), false); assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
})

test('Host IPC cannot publish copy tools after the original coordinator loses its lock', crossVolumeTools, async t => {
  const f = await toolsFixture(t); await f.command('tools-relay'); await f.command('unlock')
  const before = fs.readFileSync(f.actorsFile)
  assert.equal((await f.command('tools-rpc-register')).error?.code, 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE')
  assert.equal(records.readWorkspaceRelocationFileActors(f.data, f.id).tools, null)
  assert.deepEqual(fs.readFileSync(f.actorsFile), before); await f.command('tools-stop')
})

test('file tool transport rejects the MM or another child being used as the Host or coordinator', async t => {
  const f = await fixture(t); await f.command(); await f.command('actors-prepare'); await f.command('host-register'); await f.command('host-permit')
  const before = fs.readFileSync(path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl')), context = { dataDir: f.data, id: f.id }
  assert.throws(() => createWorkspaceFileToolJournal(context), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
  assert.throws(() => serveWorkspaceFileToolJournal(f.child, context), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
  assert.deepEqual(fs.readFileSync(path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl')), before)
})


for (const mode of ['confirmed', 'lost registration', 'lost permission']) test('real FD copier uses Host IPC before writing a cross-volume tree: ' + mode, crossVolumeTools, async t => {
  const f = await fixture(t, { crossVolume: true })
  await f.command(); await f.command('actors-prepare'); await f.command('host-register'); await f.command('host-permit'); await f.command('stage-prepare'); await f.command('file-begin')
  await f.command(mode === 'confirmed' ? 'tools-relay' : mode === 'lost registration' ? 'tools-relay-drop' : 'tools-relay-drop-permit')
  const result = await f.command('tools-copy'), plan = records.readWorkspaceRelocationFilePlan(f.data, f.id), tree = path.join(plan.staging_path, 'tree')
  const facts = records.readWorkspaceRelocationFileActors(f.data, f.id), bytes = fs.readFileSync(path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl'))
  assert.ok(facts.tools); assert.equal(exitProbe.probeKnownProcessExit(facts.tools.tools.map(item => item.process)).state, 'stopped')
  if (mode === 'confirmed') {
    assert.equal(result.error, undefined); assert.ok(facts.tool_permission); assert.ok(facts.tool_exit)
    assert.equal(result.result.source_fingerprint, plan.source_observation.tree_fingerprint)
    assert.equal(result.result.metadata_fingerprint, plan.source_observation.metadata_fingerprint)
    assert.equal(fs.readFileSync(path.join(tree, 'default/file'), 'utf8'), 'original bytes')
    assert.deepEqual(fs.readFileSync(path.join(tree, 'default/finite-archive.bin')), fs.readFileSync(path.join(f.source, 'default/finite-archive.bin')))
  } else {
    assert.equal(result.error?.code, 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE')
    assert.equal(Boolean(facts.tool_permission), mode === 'lost permission'); assert.equal(facts.tool_exit, null)
    assert.deepEqual(fs.readdirSync(tree), [])
    assert.equal((await f.command('tools-copy')).error?.code, 'CRABOT_PRIVATE_STAGING')
    assert.deepEqual(fs.readFileSync(path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl')), bytes)
    assert.deepEqual(fs.readdirSync(tree), [])
  }
  assert.equal(fs.existsSync(f.target), false); assert.deepEqual(await f.catalog.snapshot(), f.before)
  assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
})


async function stageFixture(t, options) {
  const f = await fixture(t, options); await f.command(); await f.command('actors-prepare'); await f.command('host-register')
  return { ...f, actorsFile: path.join(f.data, 'workspace-control/relocation-active/relocation-file-actors.jsonl'), staging: records.readWorkspaceRelocationFilePlan(f.data, f.id).staging_path }
}

test('the original coordinator creates one private rename container without a placeholder tree', async t => {
  const f = await stageFixture(t)
  assert.equal((await f.command('stage-prepare')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.equal(fs.existsSync(f.staging), false)
  await f.command('host-permit')
  const created = await f.command('stage-prepare')
  assert.equal(created.error, undefined); assert.equal(created.result.dispatch, 'dispatch'); assert.equal(created.result.staging.tree, null)
  assert.deepEqual(fs.readdirSync(f.staging), [])
  const stat = fs.lstatSync(f.staging, { bigint: true }), before = fs.readFileSync(f.actorsFile)
  assert.equal(created.result.staging.container.ino, stat.ino.toString())
  assert.equal(process.platform === 'win32' ? native.isPrivateDirectory(f.staging) : Number(stat.mode & 0o777n) === 0o700, true)
  assert.equal((await f.command('stage-prepare')).result.dispatch, 'observe'); assert.deepEqual(fs.readFileSync(f.actorsFile), before)
  fs.renameSync(f.staging, path.join(f.root, 'retained-staging'))
  assert.equal((await f.command('stage-prepare')).result.dispatch, 'observe'); assert.equal(fs.existsSync(f.staging), false)
  assert.equal(fs.existsSync(f.target), false); assert.deepEqual(await f.catalog.snapshot(), f.before)
  assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
})

for (const mode of ['directory', 'file', 'link']) test('staging never adopts an existing ' + mode, async t => {
  const f = await stageFixture(t); await f.command('host-permit')
  const before = fs.readFileSync(f.actorsFile), outside = path.join(f.root, 'outside-stage')
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'outside content')
  if (mode === 'directory') fs.mkdirSync(f.staging)
  else if (mode === 'file') fs.writeFileSync(f.staging, 'existing user bytes')
  else fs.symlinkSync(outside, f.staging, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await f.command('stage-prepare')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.deepEqual(fs.readFileSync(f.actorsFile), before); assert.equal(records.readWorkspaceRelocationFileActors(f.data, f.id).staging_attempt, null)
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside content')
  if (mode === 'file') assert.equal(fs.readFileSync(f.staging, 'utf8'), 'existing user bytes')
})

test('lost creation confirmation preserves the single staging attempt and never claims or recreates its directory', async t => {
  const f = await stageFixture(t); await f.command('host-permit')
  assert.equal((await f.command('stage-create-failure')).error?.code, 'EIO')
  const facts = records.readWorkspaceRelocationFileActors(f.data, f.id), before = fs.readFileSync(f.actorsFile), stat = fs.lstatSync(f.staging, { bigint: true })
  assert.ok(facts.staging_attempt); assert.equal(facts.staging, null)
  fs.writeFileSync(path.join(f.staging, 'preserved'), 'retained staging bytes')
  assert.equal((await f.command('stage-prepare')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.deepEqual(fs.readFileSync(f.actorsFile), before); assert.equal(fs.lstatSync(f.staging, { bigint: true }).ino, stat.ino)
  assert.equal(fs.readFileSync(path.join(f.staging, 'preserved'), 'utf8'), 'retained staging bytes')
  assert.equal(fs.existsSync(f.target), false)
})

for (const mode of ['tree replacement', 'container permissions', 'unexpected tree file']) test('copy tools refuse a changed registered staging: ' + mode, crossVolumeTools, async t => {
  const f = await toolsFixture(t), staging = records.readWorkspaceRelocationFileActors(f.data, f.id).staging, before = fs.readFileSync(f.actorsFile)
  if (mode === 'tree replacement') { fs.renameSync(staging.tree.path, path.join(staging.container.path, 'original-staging-tree')); fs.mkdirSync(staging.tree.path) }
  else if (mode === 'container permissions') fs.chmodSync(staging.container.path, 0o750)
  else fs.writeFileSync(path.join(staging.tree.path, 'user'), 'must not overwrite')
  assert.equal((await f.command('tools-register')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.deepEqual(fs.readFileSync(f.actorsFile), before); await f.command('tools-stop')
  if (mode === 'unexpected tree file') assert.equal(fs.readFileSync(path.join(staging.tree.path, 'user'), 'utf8'), 'must not overwrite')
})


for (const mode of ['confirmed', 'modified bytes', 'live Host', 'stale catalog']) test('original coordinator independently verifies a renamed tree: ' + mode, async t => {
  const f = await stageFixture(t); await f.command('host-permit'); await f.command('stage-prepare')
  assert.equal((await f.command('file-ready')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.equal((await f.command('file-begin')).result.dispatch, 'dispatch')
  const attempt = fs.readFileSync(f.actorsFile)
  assert.equal((await f.command('file-begin')).result.dispatch, 'observe'); assert.deepEqual(fs.readFileSync(f.actorsFile), attempt)
  if (mode === 'live Host') {
    assert.equal((await f.command('file-ready')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
    assert.equal(records.readWorkspaceRelocationFileActors(f.data, f.id).file_ready, null)
    return
  }
  if (mode === 'stale catalog') await f.catalog.update('default', { expected_revision: f.before.revision, name: 'changed', description: '' })
  await f.command('host-stop'); assert.equal((await f.command('file-move-fixture')).error, undefined)
  const tree = path.join(f.staging, 'tree')
  if (mode === 'modified bytes') fs.writeFileSync(path.join(tree, 'default/file'), 'modified bytes')
  const result = await f.command('file-ready')
  assert.equal(fs.existsSync(f.source), false); assert.equal(fs.existsSync(f.target), false)
  if (mode !== 'confirmed') { assert.equal(result.error?.code, 'WORKSPACE_RELOCATION_INVALID'); assert.equal(records.readWorkspaceRelocationFileActors(f.data, f.id).file_ready, null); return }
  assert.equal(result.error, undefined); assert.equal(result.result.dispatch, 'dispatch')
  assert.equal(result.result.ready.tree.path, tree); assert.equal(result.result.ready.tree.ino, records.readWorkspaceRelocationIntent(f.data).source.ino)
  assert.equal(fs.readFileSync(path.join(tree, 'default/file'), 'utf8'), 'original bytes')
  assert.deepEqual(await f.catalog.snapshot(), f.before)
  const bytes = fs.readFileSync(f.actorsFile)
  assert.equal((await f.command('file-ready')).result.dispatch, 'observe'); assert.deepEqual(fs.readFileSync(f.actorsFile), bytes)
})


test('interrupted checkpoint follows actual file preparation and does not execute the original live role', async t => {
  const f = await fixture(t)
  assert.equal((await f.command()).error, undefined)
  const first = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id)
  assert.equal(first.action, 'restore_source')
  assert.equal(first.execution_exit.intent_id, f.id)
  assert.equal(first.file_plan.mode, 'rename')
  assert.equal(first.coordinator.launch.process.pid, f.child.pid)
  assert.equal(first.file_actors, null)
  assert.equal((await f.command('actors-prepare')).error, undefined)
  const next = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id)
  assert.notEqual(next.checkpoint_sha256, first.checkpoint_sha256)
  assert.equal(next.file_actors.attempt.intent_id, f.id)
  assert.equal(next.action, 'restore_source')
  assert.equal(fs.existsSync(next.file_plan.staging_path), false)
  assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
  assert.deepEqual(await f.catalog.snapshot(), f.before)
})


for (const damage of ['none', 'changed moved bytes', 'new source', 'replaced tree']) test('interrupted rename inspection preserves actual source positions: ' + damage, async t => {
  const f = await stageFixture(t)
  await f.command('host-permit'); await f.command('stage-prepare'); await f.command('file-begin'); await f.command('host-stop')
  assert.equal((await f.command('file-move-fixture')).error, undefined)
  const tree = path.join(f.staging, 'tree'), originalFile = path.join(tree, 'default/file')
  const journal = fs.readFileSync(f.actorsFile)
  if (damage === 'changed moved bytes') fs.writeFileSync(originalFile, 'user changed original')
  if (damage === 'new source') fs.mkdirSync(f.source)
  if (damage === 'replaced tree') { fs.renameSync(tree, path.join(f.staging, 'retained-original')); fs.mkdirSync(tree) }
  const { inspectWorkspaceInterruptedRelocation } = await import('../workspace-interrupted-recovery.mjs')
  if (damage === 'none') {
    const observed = await inspectWorkspaceInterruptedRelocation({ dataDir: f.data, id: f.id })
    assert.equal(observed.checkpoint.action, 'restore_source')
    assert.equal(observed.positions.source, null)
    assert.equal(observed.positions.tree.path, tree)
    assert.equal(observed.positions.tree.ino, observed.checkpoint.intent.source.ino)
    assert.equal(observed.positions.published, false)
    assert.equal(observed.content.fingerprint, observed.checkpoint.file_plan.source_content_sha256)
    assert.deepEqual(await f.catalog.snapshot(), f.before)
    assert.equal(fs.readFileSync(originalFile, 'utf8'), 'original bytes')
  } else await assert.rejects(inspectWorkspaceInterruptedRelocation({ dataDir: f.data, id: f.id }), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.deepEqual(fs.readFileSync(f.actorsFile), journal)
  assert.equal(fs.existsSync(f.target), false)
})


for (const boundary of ['prepared', 'replaced', 'closed', 'complete', 'changed original material', 'changed staged bytes', 'missing original receipt']) test('fresh forward role completes only the original Worker closure at ' + boundary, { timeout: 60000 }, async t => {
  const f = await stageFixture(t, { withWorker: true })
  await f.command('host-permit'); await f.command('stage-prepare'); await f.command('file-begin'); await f.command('host-stop')
  assert.equal((await f.command('file-move-fixture')).error, undefined)
  assert.equal((await f.command('file-ready')).error, undefined)
  assert.equal((await f.command('closure-prepare-fixture')).error, undefined)
  const damaged = boundary.includes(' ')
  if (boundary === 'prepared' || boundary === 'replaced' || damaged) assert.ok((await f.command('closure-interrupt-' + (damaged ? 'prepared' : boundary))).error)
  else {
    assert.equal((await f.command('closure-commit-fixture')).error, undefined)
    if (boundary === 'closed') fs.unlinkSync(path.join(f.data, 'workspace-control/relocation-active/relocation-worker-commits/complete.json'))
  }
  f.child.disconnect(); await f.exited
  const checkpoint = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id)
  assert.equal(checkpoint.action, 'finish_commit')
  const locks = await import('../cli-lock.mjs'), recoveryId = randomUUID(), lock = await locks.acquireWorkspaceInterruptedRecoveryLock(f.data, f.id)
  const role = await (await import('../workspace-interrupted-launch.mjs')).launchWorkspaceInterruptedRecoveryCoordinator({ dataDir: f.data,
    request: { intent_id: f.id, recovery_id: recoveryId, checkpoint_sha256: checkpoint.checkpoint_sha256 }, verify: async () => {}, releaseParentLock: () => locks.releaseCliLock(lock) })
  const roleExited = once(role.child, 'exit')
  try {
    if (damaged) {
      const journal = path.join(f.data, 'workspace-control/relocation-active/relocation-worker-commits'), ledger = path.join(f.data, 'agent/worker-ledgers/channel%3A%3Aoriginal.json')
      const before = fs.readFileSync(ledger)
      if (boundary === 'missing original receipt') fs.unlinkSync(path.join(journal, '0.prepared.json'))
      else if (boundary === 'changed staged bytes') fs.appendFileSync(path.join(f.staging, 'tree/default/file'), 'external change')
      else {
        const target = path.join(journal, 'header.json'), replacement = path.join(f.root, 'changed-header.json'), contents = fs.readFileSync(target)
        if (process.platform === 'win32') native.writePrivateFile(replacement, contents.toString())
        else fs.writeFileSync(replacement, contents, { mode: 0o600 })
        fs.renameSync(replacement, target)
      }
      await assert.rejects(role.finishClosures())
      assert.deepEqual(fs.readFileSync(ledger), before)
      assert.equal(fs.existsSync(path.join(journal, 'complete.json')), false)
      return
    }
    const first = role.finishClosures()
    assert.equal(role.finishClosures(), first)
    const result = await first
    assert.equal(result.commit_sha256, sha256CanonicalJson(records.readWorkspaceRelocationClosureCommit(f.data, f.id)))
    const body = JSON.parse(fs.readFileSync(path.join(f.data, 'agent/worker-ledgers/channel%3A%3Aoriginal.json')))
    assert.equal(body.workers[0].task.status, 'closed')
    assert.equal(body.workers[0].task.title, 'preserve original goal')
    assert.deepEqual(body.workers[0].origin, { trigger_type: 'scheduled' })
    assert.deepEqual(body.workers[0].report_to, { channel_id: 'channel', session_id: 'original' })
    assert.deepEqual(body.workers[0].incarnations, [])
    await role.verify()
    for (const fact of checkpoint.materials) assert.deepEqual(records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id).materials.find(item => item.name === fact.name), fact)
    assert.deepEqual(await f.catalog.snapshot(), f.before)
    assert.equal(fs.existsSync(f.source), false)
    assert.equal(fs.readFileSync(path.join(f.staging, 'tree/default/file'), 'utf8'), 'original bytes')
  } finally { role.close(); await roleExited }
})

for (const boundary of ['unplanned', 'planned', 'archived', 'complete', 'changed checkpoint', 'missing archive receipt']) test('fresh forward role retires original Manager checkpoints without replay at ' + boundary, { timeout: 60000 }, async t => {
  const f = await stageFixture(t, { withWorker: true })
  await f.command('host-permit'); await f.command('stage-prepare'); await f.command('file-begin'); await f.command('host-stop')
  assert.equal((await f.command('file-move-fixture')).error, undefined)
  assert.equal((await f.command('file-ready')).error, undefined)
  const manager = path.join(f.data, 'agent/managers/channel%3A%3Aoriginal'), active = path.join(manager, 'running.json')
  fs.mkdirSync(manager, { recursive: true })
  const body = JSON.stringify({ episodeId: 'original-episode', state: { key: 'channel::original', recent: [{ role: 'user', content: 'PRESERVED_PRIVATE_INPUT' }], foldedCount: 0 },
    envelopes: [], wakeIndex: -1, pending: [], hasEngineMessages: true, turns: [], responses: [], tools: [], pendingToolCallIds: ['unknown-operation'],
    adminChatClaims: [], transientMessageIds: [], spawnedWorkerIds: [], execution: { successfulSendMessageTargets: [], continuedWorkers: [], needsSpawnRecheck: false,
      spawnRecheckInjected: false, spawnRecheckOutcomeRecorded: false, postSendRecheckSequence: 0 } }) + '\n'
  fs.writeFileSync(active, body, { mode: 0o600 })
  assert.equal((await f.command('closure-prepare-fixture')).error, undefined)
  assert.equal((await f.command('closure-commit-fixture')).error, undefined)
  if (boundary !== 'unplanned') assert.equal((await f.command('recovery-prepare-fixture')).error, undefined)
  if (boundary === 'archived' || boundary === 'complete' || boundary === 'missing archive receipt') {
    assert.equal((await f.command('recovery-commit-fixture')).error, undefined)
    if (boundary === 'archived') fs.unlinkSync(path.join(f.data, 'workspace-control/relocation-active/relocation-manager-complete.json'))
  }
  f.child.disconnect(); await f.exited
  const checkpoint = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id)
  const locks = await import('../cli-lock.mjs'), recoveryId = randomUUID(), lock = await locks.acquireWorkspaceInterruptedRecoveryLock(f.data, f.id)
  const role = await (await import('../workspace-interrupted-launch.mjs')).launchWorkspaceInterruptedRecoveryCoordinator({ dataDir: f.data,
    request: { intent_id: f.id, recovery_id: recoveryId, checkpoint_sha256: checkpoint.checkpoint_sha256 }, verify: async () => {}, releaseParentLock: () => locks.releaseCliLock(lock) })
  const ended = once(role.child, 'exit')
  try {
    const history = path.join(manager, 'workspace-relocation-history', f.id)
    if (boundary === 'changed checkpoint' || boundary === 'missing archive receipt') {
      const original = fs.readFileSync(boundary === 'changed checkpoint' ? active : path.join(history, 'checkpoint.json'))
      if (boundary === 'changed checkpoint') fs.appendFileSync(active, ' ')
      else fs.unlinkSync(path.join(history, 'complete.json'))
      await assert.rejects(role.finishManagerRecovery())
      assert.deepEqual(fs.readFileSync(boundary === 'changed checkpoint' ? active : path.join(history, 'checkpoint.json')),
        boundary === 'changed checkpoint' ? Buffer.concat([original, Buffer.from(' ')]) : original)
      assert.deepEqual(await f.catalog.snapshot(), f.before)
      return
    }
    const first = role.finishManagerRecovery()
    assert.equal(role.finishManagerRecovery(), first)
    const result = await first
    assert.equal(result.commit_sha256, sha256CanonicalJson(records.readWorkspaceRelocationRecoveryCommit(f.data, f.id)))
    assert.equal(fs.existsSync(active), false)
    assert.equal(fs.readFileSync(path.join(history, 'checkpoint.json'), 'utf8'), body)
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.data, 'agent/worker-ledgers/channel%3A%3Aoriginal.json'))).workers[0].task.status, 'closed')
    await role.verify()
    for (const fact of checkpoint.materials) assert.deepEqual(records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id).materials.find(item => item.name === fact.name), fact)
    assert.deepEqual(await f.catalog.snapshot(), f.before)
    assert.equal(fs.existsSync(f.source), false)
  } finally { role.close(); await ended }
})

for (const { nested, crossVolume } of [{ nested: false, crossVolume: false }, { nested: true, crossVolume: false }, { nested: false, crossVolume: true }]) {
const boundaries = crossVolume ? ['before plan', 'publication without receipt', 'selection without receipt']
  : ['before plan', 'planned', 'publication without receipt', 'published', 'selection without receipt', 'selected', 'target occupied', 'changed target content']
const suffix = (nested ? ' with missing parents' : '') + (crossVolume ? ' across volumes' : '')
for (const boundary of boundaries) test('fresh forward role selects only the original Root: ' + boundary + suffix, { skip: crossVolume && crossVolumeTools.skip, timeout: 60000 }, async t => {
  const f = await stageFixture(t, { withWorker: true, crossVolume, targetRelative: nested ? 'nested/project/new' : 'new' })
  await f.command('host-permit'); await f.command('stage-prepare'); await f.command('file-begin')
  if (crossVolume) { await f.command('tools-relay'); assert.equal((await f.command('tools-copy')).error, undefined) }
  await f.command('host-stop')
  if (!crossVolume) assert.equal((await f.command('file-move-fixture')).error, undefined)
  assert.equal((await f.command('file-ready')).error, undefined)
  for (const step of ['closure-prepare-fixture', 'closure-commit-fixture', 'recovery-prepare-fixture', 'recovery-commit-fixture']) assert.equal((await f.command(step)).error, undefined)
  if (boundary !== 'before plan') assert.equal((await f.command('root-plan-fixture')).error, undefined)
  if (boundary === 'publication without receipt') {
    const plan = records.readWorkspaceRelocationRootPlan(f.data, f.id)
    native.renameDirectoryNoReplace(plan.publication.tree.path, plan.publication.target)
  } else if (['published', 'selection without receipt', 'selected', 'changed target content'].includes(boundary)) assert.equal((await f.command('root-publish-fixture')).error, undefined)
  if (boundary === 'selection without receipt' || boundary === 'selected') {
    assert.equal((await f.command('root-select-fixture')).error, undefined)
    if (boundary === 'selection without receipt') fs.unlinkSync(path.join(f.data, 'workspace-control/relocation-active/relocation-root-selected.json'))
  }
  f.child.disconnect(); await f.exited
  const checkpoint = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id)
  const locks = await import('../cli-lock.mjs'), recoveryId = randomUUID(), lock = await locks.acquireWorkspaceInterruptedRecoveryLock(f.data, f.id)
  const role = await (await import('../workspace-interrupted-launch.mjs')).launchWorkspaceInterruptedRecoveryCoordinator({ dataDir: f.data,
    request: { intent_id: f.id, recovery_id: recoveryId, checkpoint_sha256: checkpoint.checkpoint_sha256 }, verify: async () => {}, releaseParentLock: () => locks.releaseCliLock(lock) })
  const ended = once(role.child, 'exit')
  try {
    if (boundary === 'target occupied' || boundary === 'changed target content') {
      if (boundary === 'target occupied') fs.mkdirSync(f.target)
      const changed = path.join(f.target, 'external-content.txt')
      fs.writeFileSync(changed, 'preserve external user content')
      await assert.rejects(role.finishRoot())
      assert.equal(fs.readFileSync(changed, 'utf8'), 'preserve external user content')
      assert.deepEqual(await f.catalog.snapshot(), f.before)
      return
    }
    const first = role.finishRoot()
    assert.equal(role.finishRoot(), first)
    const selected = await first, after = await f.catalog.snapshot()
    assert.equal(selected.catalog_sha256, sha256CanonicalJson(after))
    assert.equal(after.storage_root, f.target)
    assert.equal(after.revision, f.before.revision + 1)
    assert.equal(fs.readFileSync(path.join(f.target, 'default/file'), 'utf8'), 'original bytes')
    assert.equal(fs.existsSync(f.source), crossVolume)
    if (crossVolume) assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
    assert.equal(fs.existsSync(path.join(f.data, 'workspace-control/relocation-active')), true)
    assert.equal(records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id).completion, null)
    const preparation = role.prepareForwardService()
    assert.equal(role.prepareForwardService(), preparation)
    const prepared = await preparation
    const scope = (await import('../workspace-interrupted-forward-records.mjs')).readWorkspaceInterruptedForwardPreparation(f.data, f.id)
    assert.equal(prepared.scope_sha256, scope.marker.scope_sha256)
    assert.equal(scope.root.path, f.target)
    assert.deepEqual(scope.checkpoint, records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id))
    assert.equal((await import('../workspace-maintenance.cjs')).workspaceMaintenancePending(f.data), true)
    await role.verify()
    for (const fact of checkpoint.materials) assert.deepEqual(records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id).materials.find(item => item.name === fact.name), fact)
    if (boundary === 'before plan' && !nested && !crossVolume) {
      const marker = path.join(f.data, 'workspace-control/relocation-forward-finalizing.json'), bytes = fs.readFileSync(marker)
      role.close(); await ended
      const nextLock = await locks.acquireWorkspaceInterruptedRecoveryLock(f.data, f.id), current = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id)
      const next = await (await import('../workspace-interrupted-launch.mjs')).launchWorkspaceInterruptedRecoveryCoordinator({ dataDir: f.data,
        request: { intent_id: f.id, recovery_id: randomUUID(), checkpoint_sha256: current.checkpoint_sha256 }, verify: async () => {}, releaseParentLock: () => locks.releaseCliLock(nextLock) })
      const nextEnded = once(next.child, 'exit')
      try {
        assert.equal(native.sameProcess(next.launch.process, role.launch.process), false)
        assert.deepEqual(await next.prepareForwardService(), prepared)
        assert.deepEqual(fs.readFileSync(marker), bytes)
        await next.verify()
        assert.deepEqual(await next.archiveForward(), { committed: true, service_restored: false })
        await next.verify()
        const archived = (await import('../workspace-interrupted-forward-records.mjs')).readWorkspaceInterruptedForwardPreparation(f.data, f.id)
        assert.equal(archived.archived, true)
        assert.deepEqual(archived.checkpoint, current)
        assert.deepEqual(fs.readFileSync(marker), bytes)
        assert.equal(fs.existsSync(path.join(f.data, 'workspace-control/relocation-active')), false)
        assert.equal(fs.existsSync(path.join(archived.original.path, 'relocation-complete.json')), false)
        assert.equal(fs.readFileSync(path.join(f.target, 'default/file'), 'utf8'), 'original bytes')
        assert.equal(await (await import('../workspace-relocation-history.mjs')).locateWorkspaceRelocationHistory({ dataDir: f.data,
          managerKey: 'channel::original', workerId: 'original-worker', incarnationId: 'not-present' }), null)
      } finally { next.close(); await nextEnded }
      const thirdLock = await locks.acquireWorkspaceInterruptedRecoveryLock(f.data, f.id)
      const third = await (await import('../workspace-interrupted-launch.mjs')).launchWorkspaceInterruptedRecoveryCoordinator({ dataDir: f.data,
        request: { intent_id: f.id, recovery_id: randomUUID(), checkpoint_sha256: current.checkpoint_sha256 }, verify: async () => {}, releaseParentLock: () => locks.releaseCliLock(thirdLock) })
      const thirdEnded = once(third.child, 'exit')
      try { await third.verify(); assert.deepEqual(await third.archiveForward(), { committed: true, service_restored: false }) }
      finally { third.close(); await thirdEnded }
      fs.writeFileSync(marker, 'broken')
      const forwardRecords = await import('../workspace-interrupted-forward-records.mjs')
      assert.throws(() => forwardRecords.readWorkspaceInterruptedForwardPreparation(f.data, f.id))
      assert.equal(fs.readFileSync(path.join(f.target, 'default/file'), 'utf8'), 'original bytes')
    }
  } finally { role.close(); await ended }
})
}

test('interrupted checkpoint crosses closure commit before catalog selection and never classifies it as rollback', async t => {
  const f = await stageFixture(t)
  await f.command('host-permit'); await f.command('stage-prepare'); await f.command('file-begin'); await f.command('host-stop')
  assert.equal((await f.command('file-move-fixture')).error, undefined)
  assert.equal((await f.command('file-ready')).error, undefined)
  const prepare = await f.command('closure-prepare-fixture')
  assert.equal(prepare.error, undefined)
  assert.equal(records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id).action, 'restore_source')
  const commit = await f.command('closure-commit-fixture')
  assert.equal(commit.error, undefined)
  const state = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id)
  assert.equal(state.action, 'finish_commit')
  assert.ok(state.closure_commit)
  // A crash before the final receipt still has a prepared commit journal.
  fs.unlinkSync(path.join(f.data, 'workspace-control/relocation-active/relocation-worker-commits/complete.json'))
  const partial = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id)
  assert.equal(partial.action, 'finish_commit')
  assert.equal(partial.closure_commit, null)
  assert.notEqual(partial.checkpoint_sha256, state.checkpoint_sha256)
  assert.equal(state.root_plan, null)
  assert.equal(state.selected, null)
  assert.deepEqual(await f.catalog.snapshot(), f.before)
  assert.equal(fs.readFileSync(path.join(f.staging, 'tree/default/file'), 'utf8'), 'original bytes')
})


for (const mode of ['source unchanged', 'source in staging', 'partial cross-volume copy']) test('new recovery generation restores the original source without closing or replaying Workers: ' + mode,
  { skip: mode === 'partial cross-volume copy' && process.platform !== 'linux', timeout: 60000 }, async t => {
  const f = await stageFixture(t, { crossVolume: mode === 'partial cross-volume copy' })
  await f.command('host-permit'); await f.command('stage-prepare'); await f.command('file-begin'); await f.command('host-stop')
  if (mode === 'source in staging') assert.equal((await f.command('file-move-fixture')).error, undefined)
  if (mode === 'partial cross-volume copy') fs.writeFileSync(path.join(f.staging, 'tree/unfinished-copy'), 'keep interrupted bytes')
  f.child.disconnect(); await f.exited
  const original = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id)
  const { launchWorkspaceInterruptedRecoveryCoordinator } = await import('../workspace-interrupted-launch.mjs')
  const recoveryId = randomUUID(), lock = await acquireWorkspaceRelocationLock(f.data, f.id)
  let role
  try {
    role = await launchWorkspaceInterruptedRecoveryCoordinator({ dataDir: f.data,
      request: { intent_id: f.id, recovery_id: recoveryId, checkpoint_sha256: original.checkpoint_sha256 }, verify: async () => {}, releaseParentLock: () => releaseCliLock(lock) })
    const first = role.restoreSource()
    assert.equal(role.restoreSource(), first)
    assert.deepEqual(await first, { source_restored: true, source: f.source, retained_staging: f.staging })
    await role.verify()
    assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
    assert.deepEqual(await f.catalog.snapshot(), f.before)
    const after = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id)
    assert.equal(after.checkpoint_sha256, original.checkpoint_sha256)
    assert.equal(after.closure_plan, null); assert.equal(after.closure_commit, null)
    const control = path.join(f.data, 'workspace-control/relocation-recovery', recoveryId)
    const prepared = JSON.parse(fs.readFileSync(path.join(control, 'source-plan.json'))), complete = JSON.parse(fs.readFileSync(path.join(control, 'source-complete.json')))
    assert.equal(prepared.schema_version, 2); assert.equal(complete.plan_sha256, sha256CanonicalJson(prepared))
    assert.equal(complete.source.ino, original.intent.source.ino)
    assert.equal(complete.content_sha256, prepared.content_sha256)
    assert.equal(fs.existsSync(path.join(f.data, 'workspace-control/relocation-active')), true)
    assert.equal(fs.existsSync(f.target), false)
    if (mode === 'partial cross-volume copy') assert.equal(fs.readFileSync(path.join(f.staging, 'tree/unfinished-copy'), 'utf8'), 'keep interrupted bytes')
    else assert.deepEqual(fs.readdirSync(f.staging), [])
  } finally {
    if (role) { const exited = once(role.child, 'exit'); role.close(); await exited }
    releaseCliLock(lock)
  }
})

for (const settled of [false, true]) test('fresh recovery observes settled original stops without inventing the old execution receipt: ' + settled, { timeout: 60000 }, async t => {
  const f = await fixture(t, { exitEvidence: settled, exitRecord: false })
  f.child.disconnect(); await f.exited
  const checkpoint = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id)
  assert.equal(checkpoint.execution_exit, null)
  const lock = await acquireWorkspaceRelocationLock(f.data, f.id), recoveryId = randomUUID()
  const role = await (await import('../workspace-interrupted-launch.mjs')).launchWorkspaceInterruptedRecoveryCoordinator({ dataDir: f.data,
    request: { intent_id: f.id, recovery_id: recoveryId, checkpoint_sha256: checkpoint.checkpoint_sha256 }, verify: async () => {}, releaseParentLock: () => releaseCliLock(lock) })
  try {
    if (settled) {
      assert.equal((await role.restoreSource()).source_restored, true)
      const exit = JSON.parse(fs.readFileSync(path.join(role.launch.control_root.path, 'execution-exit.json')))
      assert.equal(exit.schema_version, 2); assert.equal(exit.recovery_id, recoveryId)
      assert.equal(exit.checkpoint_sha256, checkpoint.checkpoint_sha256)
    } else await assert.rejects(role.restoreSource())
    assert.equal(records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id).execution_exit, null)
    assert.equal(records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id).checkpoint_sha256, checkpoint.checkpoint_sha256)
    assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
    assert.deepEqual(await f.catalog.snapshot(), f.before)
    assert.equal((await import('../workspace-maintenance.cjs')).default.workspaceMaintenancePending(f.data), true)
  } finally {
    if (role.child.exitCode === null && role.child.signalCode === null) { const ended = once(role.child, 'exit'); role.close(); await ended }
    releaseCliLock(lock)
  }
})


test('a fresh explicit recovery verifies an actual rename that lost its completion receipt', { timeout: 60000 }, async t => {
  const f = await stageFixture(t)
  await f.command('host-permit'); await f.command('stage-prepare'); await f.command('file-begin'); await f.command('host-stop')
  assert.equal((await f.command('file-move-fixture')).error, undefined)
  f.child.disconnect(); await f.exited
  const checkpoint = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id), recoveryId = randomUUID()
  const roleModule = await import('../workspace-interrupted-role.mjs')
  let lock = await acquireWorkspaceRelocationLock(f.data, f.id)
  // Only the finite child injects termination immediately after the real OS rename.
  const code = `import native from ${JSON.stringify(new URL('../process-identity.cjs', import.meta.url).href)};
    const rename=native.renameDirectoryNoReplace;native.renameDirectoryNoReplace=(...args)=>{rename(...args);process.exit(3)};
    await import(${JSON.stringify(new URL('../../workspace-interrupted-coordinator.mjs', import.meta.url).href)});`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }), exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  await once(child, 'spawn')
  const request = { intent_id: f.id, recovery_id: recoveryId, checkpoint_sha256: checkpoint.checkpoint_sha256 }
  const launch = await roleModule.commitWorkspaceInterruptedRecoveryLaunch({ dataDir: f.data, request, coordinator: native.inspectProcess(child.pid), verify: async () => {} })
  const readyReply = once(child, 'message')
  releaseCliLock(lock)
  child.send({ kind: 'workspace_interrupted_initialize', data_dir: f.data, recovery_id: recoveryId, launch_sha256: sha256CanonicalJson(launch) })
  const [ready] = await readyReply
  assert.equal(ready.kind, 'workspace_interrupted_ready')
  child.send({ kind: 'workspace_interrupted_restore_source', recovery_id: recoveryId, launch_sha256: ready.launch_sha256, ready_sha256: ready.ready_sha256, nonce: randomUUID() })
  assert.equal((await exited)[0], 3)
  assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
  const previous = path.join(f.data, 'workspace-control/relocation-recovery', recoveryId)
  const planBytes = fs.readFileSync(path.join(previous, 'source-plan.json'))
  assert.equal(fs.existsSync(path.join(previous, 'source-complete.json')), false)
  const sourceVersion = fs.lstatSync(f.source, { bigint: true })
  lock = await acquireWorkspaceRelocationLock(f.data, f.id)
  const { launchWorkspaceInterruptedRecoveryCoordinator } = await import('../workspace-interrupted-launch.mjs')
  const next = await launchWorkspaceInterruptedRecoveryCoordinator({ dataDir: f.data, request: { ...request, recovery_id: randomUUID() },
    verify: async () => {}, releaseParentLock: () => releaseCliLock(lock) })
  try {
    assert.equal((await next.restoreSource()).source_restored, true)
    const after = fs.lstatSync(f.source, { bigint: true })
    assert.equal(after.ino, sourceVersion.ino); assert.equal(after.ctimeNs, sourceVersion.ctimeNs)
    assert.deepEqual(fs.readFileSync(path.join(previous, 'source-plan.json')), planBytes)
    assert.equal(fs.existsSync(path.join(previous, 'source-complete.json')), false)
    assert.deepEqual(await f.catalog.snapshot(), f.before)
    assert.equal(records.readWorkspaceRelocationClosurePlan(f.data, f.id), null)
  } finally { const ended = once(next.child, 'exit'); next.close(); await ended; releaseCliLock(lock) }
})


test('source restoration archives original materials under a continuous maintenance guard without claiming a moved root', { timeout: 60000 }, async t => {
  const f = await stageFixture(t)
  await f.command('host-permit'); await f.command('stage-prepare'); await f.command('file-begin'); await f.command('host-stop')
  assert.equal((await f.command('file-move-fixture')).error, undefined)
  f.child.disconnect(); await f.exited
  const original = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id)
  const { launchWorkspaceInterruptedRecoveryCoordinator } = await import('../workspace-interrupted-launch.mjs')
  const lock = await acquireWorkspaceRelocationLock(f.data, f.id), recoveryId = randomUUID()
  const role = await launchWorkspaceInterruptedRecoveryCoordinator({ dataDir: f.data,
    request: { intent_id: f.id, recovery_id: recoveryId, checkpoint_sha256: original.checkpoint_sha256 }, verify: async () => {}, releaseParentLock: () => releaseCliLock(lock) })
  try {
    await role.restoreSource()
    fs.mkdirSync(path.join(f.data, 'agent'), { recursive: true })
    const result = await role.archiveSource()
    assert.equal(result.source_restored, true)
    assert.equal(result.service_restored, false)
    assert.equal(fs.existsSync(path.join(f.data, 'workspace-control/relocation-active')), false)
    const archive = path.join(f.data, 'workspace-control/relocation-cancelled', f.id, 'original')
    assert.ok(fs.existsSync(path.join(archive, 'relocation.json')))
    assert.equal(fs.existsSync(path.join(f.data, 'workspace-control/relocation-history', f.id)), false)
    assert.deepEqual(await f.catalog.snapshot(), f.before)
    assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
    const guard = await import('../workspace-maintenance.cjs')
    assert.equal(guard.default.workspaceMaintenancePending(f.data), true)
    const reader = await import('../workspace-interrupted-source-records.mjs')
    const state = reader.readWorkspaceSourceRestoration(f.data, f.id)
    assert.equal(state.checkpoint.checkpoint_sha256, original.checkpoint_sha256)
    assert.deepEqual(state.checkpoint.materials, original.materials)
    assert.equal(state.scope.catalog_sha256, sha256CanonicalJson(f.before))
    await role.verify()
  } finally { const exited = once(role.child, 'exit'); role.close(); await exited; releaseCliLock(lock) }
})

for (const forward of [false, true])
for (const boundary of ['guard', 'job-directory', 'marker', 'archive-rename']) test('fresh ' + (forward ? 'forward completion' : 'source restoration') + ' continues after an actual interrupted ' + boundary, { timeout: 60000 }, async t => {
  const f = await stageFixture(t)
  await f.command('host-permit'); await f.command('stage-prepare'); await f.command('file-begin'); await f.command('host-stop')
  assert.equal((await f.command('file-move-fixture')).error, undefined)
  if (forward) for (const step of ['file-ready', 'closure-prepare-fixture', 'closure-commit-fixture']) assert.equal((await f.command(step)).error, undefined)
  f.child.disconnect(); await f.exited
  fs.mkdirSync(path.join(f.data, 'agent'), { recursive: true })
  const checkpoint = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id), recoveryId = randomUUID()
  const roleModule = await import('../workspace-interrupted-role.mjs'), locks = await import('../cli-lock.mjs')
  let lock = await locks.acquireWorkspaceInterruptedRecoveryLock(f.data, f.id)
  // Terminate only this finite current role after the real OS operation, with no
  // product fault-injection flag, original-record rewrite or simulated rename.
  const code = `import fs from 'node:fs';import path from 'node:path';
    import native from ${JSON.stringify(new URL('../process-identity.cjs', import.meta.url).href)};
    const boundary=${JSON.stringify(boundary)}, id=${JSON.stringify(f.id)}, forward=${forward};
    let published;const link=fs.linkSync,unlink=fs.unlinkSync,mkdir=fs.mkdirSync,privateDir=native.createPrivateDirectory,rename=native.renameDirectoryNoReplace;
    fs.linkSync=(from,to)=>{link(from,to);published=to};
    fs.unlinkSync=file=>{unlink(file);if(boundary==='guard'&&published?.endsWith(forward?'relocation-forward-finalizing.json':'relocation-source-finalizing.json')||boundary==='marker'&&published?.endsWith(forward?'forward-committed.json':'source-restored.json'))process.exit(3)};
    const afterDirectory=file=>{if(boundary==='job-directory'&&path.basename(file)===id&&path.basename(path.dirname(file))===(forward?'relocation-history':'relocation-cancelled'))process.exit(3)};
    fs.mkdirSync=(file,...args)=>{const result=mkdir(file,...args);afterDirectory(file);return result};
    native.createPrivateDirectory=file=>{const result=privateDir(file);afterDirectory(file);return result};
    native.renameDirectoryNoReplace=(from,to)=>{const result=rename(from,to);if(boundary==='archive-rename'&&path.basename(from)==='relocation-active')process.exit(3);return result};
    await import(${JSON.stringify(new URL('../../workspace-interrupted-coordinator.mjs', import.meta.url).href)});`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }), exited = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  await once(child, 'spawn')
  const request = { intent_id: f.id, recovery_id: recoveryId, checkpoint_sha256: checkpoint.checkpoint_sha256 }
  const launch = await roleModule.commitWorkspaceInterruptedRecoveryLaunch({ dataDir: f.data, request, coordinator: native.inspectProcess(child.pid), verify: async () => {} })
  const waiting = once(child, 'message'); releaseCliLock(lock)
  child.send({ kind: 'workspace_interrupted_initialize', data_dir: f.data, recovery_id: recoveryId, launch_sha256: sha256CanonicalJson(launch) })
  const [ready] = await waiting
  const base = { recovery_id: recoveryId, launch_sha256: ready.launch_sha256, ready_sha256: ready.ready_sha256 }
  const restored = once(child, 'message')
  child.send({ ...base, kind: forward ? 'workspace_interrupted_prepare_forward_service' : 'workspace_interrupted_restore_source', nonce: randomUUID() })
  if (!forward || boundary !== 'guard') {
    assert.equal((await restored)[0].result[forward ? 'prepared' : 'source_restored'], true)
    child.send({ ...base, kind: forward ? 'workspace_interrupted_archive_forward' : 'workspace_interrupted_archive_source', nonce: randomUUID() })
  } else void restored.catch(() => {})
  assert.equal((await exited)[0], 3)
  const reader = await import('../workspace-interrupted-source-records.mjs'), forwardReader = await import('../workspace-interrupted-forward-records.mjs')
  const pending = forward ? forwardReader.readWorkspaceInterruptedForwardPreparation(f.data, f.id) : reader.readPendingWorkspaceSourceRestoration(f.data, f.id)
  const terminal = path.join(pending.role.launch.control_root.path, forward ? 'forward-terminal.json' : 'source-terminal.json'), oldTerminal = fs.readFileSync(terminal)
  lock = await locks.acquireWorkspaceInterruptedRecoveryLock(f.data, f.id)
  const { launchWorkspaceInterruptedRecoveryCoordinator } = await import('../workspace-interrupted-launch.mjs')
  const next = await launchWorkspaceInterruptedRecoveryCoordinator({ dataDir: f.data, request: { ...request, recovery_id: randomUUID(), checkpoint_sha256: pending.checkpoint.checkpoint_sha256 },
    verify: async () => {}, releaseParentLock: () => releaseCliLock(lock) })
  try {
    if (forward) {
      assert.equal((await next.prepareForwardService()).prepared, true)
      assert.deepEqual(await next.archiveForward(), { committed: true, service_restored: false })
    } else {
      assert.equal((await next.restoreSource()).source_restored, true)
      assert.deepEqual(await next.archiveSource(), { source_restored: true, service_restored: false })
    }
    await next.verify()
    const retained = forward ? forwardReader.readWorkspaceInterruptedForwardPreparation(f.data, f.id) : reader.readWorkspaceSourceRestoration(f.data, f.id)
    assert.deepEqual(retained.marker, pending.marker)
    assert.deepEqual(fs.readFileSync(terminal), oldTerminal)
    const after = await f.catalog.snapshot()
    if (forward) { assert.equal(after.storage_root, f.target); assert.equal(after.revision, f.before.revision + 1) }
    else assert.deepEqual(after, f.before)
    assert.equal(fs.readFileSync(path.join(forward ? f.target : f.source, 'default/file'), 'utf8'), 'original bytes')
    assert.equal(fs.existsSync(path.join(f.data, 'workspace-control/relocation-history', f.id)), forward)
    assert.equal((await import('../workspace-maintenance.cjs')).default.workspaceMaintenancePending(f.data), true)
    if (forward && boundary === 'archive-rename') {
      fs.appendFileSync(path.join(retained.original.path, 'relocation.json'), '\n')
      assert.throws(() => forwardReader.readWorkspaceInterruptedForwardPreparation(f.data, f.id))
      assert.equal(fs.readFileSync(path.join(f.target, 'default/file'), 'utf8'), 'original bytes')
    }
  } finally { const ended = once(next.child, 'exit'); next.close(); await ended; releaseCliLock(lock) }
})

test('source recovery retires exact old wakes and archives unknown Manager work without closing Workers or replaying inputs', { timeout: 60000 }, async t => {
  const f = await stageFixture(t)
  await f.command('host-permit'); await f.command('stage-prepare'); await f.command('file-begin'); await f.command('host-stop')
  assert.equal((await f.command('file-move-fixture')).error, undefined)
  f.child.disconnect(); await f.exited
  const key = 'channel::original', manager = path.join(f.data, 'agent/managers/channel%3A%3Aoriginal'), active = path.join(manager, 'running.json')
  fs.mkdirSync(manager, { recursive: true })
  const body = JSON.stringify({ episodeId: 'original-episode', state: { key, recent: [{ role: 'user', content: 'ORIGINAL_PRIVATE_INPUT' }], foldedCount: 0 },
    envelopes: [], wakeIndex: -1, pending: [], hasEngineMessages: true, turns: [], responses: [], tools: [], pendingToolCallIds: ['unknown-operation'],
    adminChatClaims: [], transientMessageIds: [], spawnedWorkerIds: [], execution: { successfulSendMessageTargets: [], continuedWorkers: [],
      needsSpawnRecheck: false, spawnRecheckInjected: false, spawnRecheckOutcomeRecorded: false, postSendRecheckSequence: 0 } }) + '\n'
  fs.writeFileSync(active, body, { mode: 0o600 })
  const { ManagerWorkboardStore } = await import('../../../crabot-agent/dist/manager/workboard-store.js')
  const board = new ManagerWorkboardStore(path.join(f.data, 'agent/managers'))
  await board.adminCreateObjective(key, 0, { title: 'Unfinished objective', completion_criteria: ['user must decide'] })
  const beforeBoard = await board.loadAdmin(key), checkpoint = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id)
  const locks = await import('../cli-lock.mjs'), { launchWorkspaceInterruptedRecoveryCoordinator } = await import('../workspace-interrupted-launch.mjs')
  const start = async () => {
    const lock = await locks.acquireWorkspaceInterruptedRecoveryLock(f.data, f.id)
    return launchWorkspaceInterruptedRecoveryCoordinator({ dataDir: f.data,
      request: { intent_id: f.id, recovery_id: randomUUID(), checkpoint_sha256: checkpoint.checkpoint_sha256 }, verify: async () => {}, releaseParentLock: () => releaseCliLock(lock) })
  }
  let role = await start()
  const close = async () => { const ended = once(role.child, 'exit'); role.close(); await ended }
  try {
    await role.restoreSource(); await role.archiveSource()
    assert.equal(fs.readFileSync(active, 'utf8'), body)
    assert.deepEqual(await role.prepareSourceBusiness(), { prepared: true })
    assert.equal(fs.existsSync(active), false)
    const archived = path.join(manager, 'workspace-relocation-history', f.id, 'checkpoint.json')
    assert.equal(fs.readFileSync(archived, 'utf8'), body)
    assert.deepEqual(await board.loadAdmin(key), beforeBoard)
    const { WorkspaceRelocationRetirements } = await import('../../../crabot-agent/dist/core/workspace-relocation-retirements.js')
    assert.equal(new WorkspaceRelocationRetirements(f.data).workboard(key, 1), true)
    assert.equal(new WorkspaceRelocationRetirements(f.data).workboard(key, 2), false)
    assert.equal((await import('../workspace-interrupted-source-records.mjs')).readWorkspaceSourceRestoration(f.data, f.id).checkpoint.closure_commit, null)
    await close()
    role = await start()
    await role.restoreSource(); await role.archiveSource()
    assert.deepEqual(await role.prepareSourceBusiness(), { prepared: true })
    assert.equal(fs.readFileSync(archived, 'utf8'), body)
    const retained = (await import('../workspace-interrupted-source-records.mjs')).readWorkspaceSourceRestoration(f.data, f.id)
    assert.doesNotMatch(JSON.stringify(retained.scope), /ORIGINAL_PRIVATE_INPUT|unknown-operation|Unfinished objective/)
    assert.deepEqual(await f.catalog.snapshot(), f.before)
    await close()
    fs.mkdirSync(path.join(f.data, 'workspace-control/relocation-active'), { mode: 0o700 })
    assert.equal((await import('../workspace-interrupted-source-records.mjs')).readWorkspaceSourceRestoration(f.data, f.id).archived, true)
    assert.equal(new WorkspaceRelocationRetirements(f.data).workboard(key, 1), true)
  } finally { if (role.child.connected) await close() }
})

for (const forward of [false, true])
for (const mode of ['valid', 'unregistered', 'changed invocation']) test((forward ? 'forward' : 'source') + ' recovery starts a registered fixed carrier once: ' + mode, { timeout: 60000 }, async t => {
  const f = await stageFixture(t)
  await f.command('host-permit'); await f.command('stage-prepare'); await f.command('file-begin'); await f.command('host-stop')
  assert.equal((await f.command('file-move-fixture')).error, undefined)
  if (forward) for (const step of ['file-ready', 'closure-prepare-fixture', 'closure-commit-fixture']) assert.equal((await f.command(step)).error, undefined)
  f.child.disconnect(); await f.exited
  fs.mkdirSync(path.join(f.data, 'agent'), { recursive: true })
  const checkpoint = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id), recoveryId = randomUUID()
  const locks = await import('../cli-lock.mjs'), lock = await locks.acquireWorkspaceInterruptedRecoveryLock(f.data, f.id)
  const role = await (await import('../workspace-interrupted-launch.mjs')).launchWorkspaceInterruptedRecoveryCoordinator({ dataDir: f.data,
    request: { intent_id: f.id, recovery_id: recoveryId, checkpoint_sha256: checkpoint.checkpoint_sha256 }, verify: async () => {}, releaseParentLock: () => releaseCliLock(lock) })
  let gate
  try {
    if (forward) await role.prepareForwardService()
    else { await role.restoreSource(); await role.archiveSource(); await role.prepareSourceBusiness() }
    const selected = await f.catalog.snapshot()
    assert.equal(selected.storage_root, forward ? f.target : f.source)
    const runtime = await import('../workspace-interrupted-runtime.mjs'), dispatch = await import('../workspace-runtime-records.mjs')
    const instanceId = randomUUID(), runtimeId = randomUUID(), adminRuntimeId = randomUUID(), port = 19841
    await runtime.commitWorkspaceInterruptedRuntimePlan({ dataDir: f.data, recoveryId, instanceId, adminRuntimeId,
      modules: [{ module_id: 'memory-default', runtime_id: runtimeId, module_port: port }], verify: role.verify })
    gate = (await import('../workspace-runtime-gate.mjs')).createWorkspaceRuntimeGate()
    await gate.ready()
    const observed = path.join(f.root, 'finite-runtime-starts'), invocation = { command: process.execPath,
      args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(observed)},'started\\n');setTimeout(()=>process.exit(0),30000)`], cwd: f.root, env: {} }
    const processIdentity = native.inspectProcess(gate.child.pid), registry = path.join(f.data, 'module-runtime-registry/records')
    fs.mkdirSync(registry, { recursive: true })
    fs.writeFileSync(path.join(path.dirname(registry), 'instance-id'), instanceId + '\n', { mode: 0o600 })
    const registration = { schema_version: 1, instance_id: instanceId, runtime_id: runtimeId, module_id: 'memory-default', root_pid: gate.child.pid,
      process_start_identity: processIdentity.started, module_port: port, created_at: new Date().toISOString() }
    if (mode !== 'unregistered') fs.writeFileSync(path.join(registry, runtimeId + '.json'), JSON.stringify(registration), { mode: 0o600 })
    assert.equal(fs.existsSync(observed), false)
    const commit = () => dispatch.commitWorkspaceRuntimeStart({ dataDir: f.data, recoveryId, moduleId: 'memory-default', process: processIdentity,
      runtime: registration, definitionHash: sha256CanonicalJson(invocation), verify: role.verify })
    if (mode === 'unregistered') {
      await assert.rejects(commit)
      assert.equal(fs.existsSync(observed), false)
    } else {
      const receipt = await commit(), input = { dataDir: f.data, recoveryId, moduleId: 'memory-default', recordHash: sha256CanonicalJson(receipt),
        invocation: mode === 'changed invocation' ? { ...invocation, args: ['-e', 'process.exit(0)'] } : invocation, verify: role.verify, assertCurrent: () => {} }
      assert.equal(receipt.schema_version, 2)
      if (mode === 'changed invocation') {
        await assert.rejects(gate.start(input)); assert.equal(fs.existsSync(observed), false)
      } else {
        const first = gate.start(input)
        assert.equal(gate.start(input), first)
        await first
        await gate.observe()
        const deadline = Date.now() + 5000
        while (!fs.existsSync(observed) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
        assert.equal(fs.readFileSync(observed, 'utf8'), 'started\n')
        assert.deepEqual(await f.catalog.snapshot(), selected)
        assert.equal((await import('../workspace-maintenance.cjs')).default.workspaceMaintenancePending(f.data), true)
      }
    }
  } finally {
    if (gate) {
      const { captureSpawnedProcessTree } = await import('../spawned-process-tree.cjs')
      const processes = gate.child.exitCode === null && gate.child.signalCode === null ? captureSpawnedProcessTree(gate.child) : []
      const ended = gate.child.exitCode === null && gate.child.signalCode === null ? once(gate.child, 'exit') : Promise.resolve()
      for (const processIdentity of [...processes].reverse()) native.terminateKnownProcess(processIdentity)
      gate.close(); await ended
    }
    const ended = once(role.child, 'exit'); role.close(); await ended; releaseCliLock(lock)
    const history = (await import('../workspace-interrupted-runtime.mjs')).readWorkspaceInterruptedRuntimeHistory(f.data, f.id)
    assert.equal(history.length, 1)
    assert.equal(history[0].plan.recovery_id, recoveryId)
    assert.equal(history[0].starts.filter(Boolean).length, mode === 'unregistered' ? 0 : 1)
  }
})

for (const forward of [false, true])
for (const mode of ['verified', 'changed probed root', 'wrong bearer', 'wrong runtime', 'Core rejects']) test('actual interrupted Agent Root primitive under a finite Core transport: ' + (forward ? 'forward ' : '') + mode, { timeout: 60000 }, async t => {
  const f = await stageFixture(t)
  await f.command('host-permit'); await f.command('stage-prepare'); await f.command('file-begin'); await f.command('host-stop')
  assert.equal((await f.command('file-move-fixture')).error, undefined)
  if (forward) for (const step of ['file-ready', 'closure-prepare-fixture', 'closure-commit-fixture']) assert.equal((await f.command(step)).error, undefined)
  f.child.disconnect(); await f.exited
  fs.mkdirSync(path.join(f.data, 'agent'), { recursive: true })
  const checkpoint = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id), recoveryId = randomUUID()
  const locks = await import('../cli-lock.mjs'), lock = await locks.acquireWorkspaceInterruptedRecoveryLock(f.data, f.id)
  const role = await (await import('../workspace-interrupted-launch.mjs')).launchWorkspaceInterruptedRecoveryCoordinator({ dataDir: f.data,
    request: { intent_id: f.id, recovery_id: recoveryId, checkpoint_sha256: checkpoint.checkpoint_sha256 }, verify: async () => {}, releaseParentLock: () => releaseCliLock(lock) })
  const { createServer } = await import('node:http')
  let expected, calls = 0
  const server = createServer(async (req, res) => {
    let text = ''; for await (const bytes of req) text += bytes
    const message = JSON.parse(text); calls++
    assert.equal(req.headers.authorization, 'Bearer finite-Agent-credential')
    assert.equal(message.method, 'verify_workspace_interrupted_recovery_runtime')
    assert.deepEqual(message.params, role.launch.request)
    res.end(JSON.stringify({ id: message.id, success: true, data: { ...expected, verified: mode !== 'Core rejects' } }))
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  let gate
  try {
    if (forward) await role.prepareForwardService()
    else { await role.restoreSource(); await role.archiveSource(); await role.prepareSourceBusiness() }
    const selectedRoot = forward ? f.target : f.source, selected = await f.catalog.snapshot()
    assert.equal(selected.storage_root, selectedRoot)
    const runtime = await import('../workspace-interrupted-runtime.mjs'), instanceId = randomUUID(), runtimeId = randomUUID()
    const plan = await runtime.commitWorkspaceInterruptedRuntimePlan({ dataDir: f.data, recoveryId, instanceId, adminRuntimeId: randomUUID(),
      modules: [{ module_id: 'crabot-agent', runtime_id: runtimeId, module_port: 19842 }], verify: role.verify })
    expected = { verified: true, ...role.launch.request, launch_sha256: sha256CanonicalJson(role.launch), plan_sha256: sha256CanonicalJson(plan),
      catalog_sha256: sha256CanonicalJson(selected), instance_id: instanceId, module_id: 'crabot-agent', runtime_id: runtimeId }
    const resultFile = path.join(f.root, 'Root-result.json'), entry = fileURLToPath(new URL('../../../crabot-agent/dist/core/workspace-interrupted-validation.js', import.meta.url))
    const code = `const fs=require('node:fs'),{createWorkspaceInterruptedRootVerifier}=require(${JSON.stringify(entry)});
      const verify=createWorkspaceInterruptedRootVerifier({dataDir:${JSON.stringify(f.data)},moduleManagerPort:${server.address().port},runtimeBearer:()=> 'finite-Agent-credential',
        runtimeIdentity:()=>({instance_id:${JSON.stringify(instanceId)},module_id:'crabot-agent',runtime_id:${JSON.stringify(mode === 'wrong runtime' ? randomUUID() : runtimeId)}}),isClosing:()=>false});
      (async()=>{let replaced=false,result;try{const first=await verify(${JSON.stringify(role.launch.request)},${JSON.stringify(mode === 'wrong bearer' ? 'wrong' : 'finite-Agent-credential')});
        if(${mode === 'changed probed root'}){fs.renameSync(${JSON.stringify(selectedRoot)},${JSON.stringify(selectedRoot + '-retained')});fs.mkdirSync(${JSON.stringify(selectedRoot)});replaced=true}
        const second=await verify(${JSON.stringify(role.launch.request)},'finite-Agent-credential');result={ok:true,first,second}}
      catch(error){result={ok:false,code:error.code,stage:error.stage,message:error.message}}
      finally{if(replaced){fs.rmdirSync(${JSON.stringify(selectedRoot)});fs.renameSync(${JSON.stringify(selectedRoot + '-retained')},${JSON.stringify(selectedRoot)})}}
      fs.writeFileSync(${JSON.stringify(resultFile + ".tmp")},JSON.stringify(result));fs.renameSync(${JSON.stringify(resultFile + ".tmp")},${JSON.stringify(resultFile)})})();setTimeout(()=>process.exit(0),30000);`
    const invocation = { command: process.execPath, args: ['-e', code], cwd: f.root, env: {} }
    gate = (await import('../workspace-runtime-gate.mjs')).createWorkspaceRuntimeGate(); await gate.ready()
    const identity = native.inspectProcess(gate.child.pid), registry = path.join(f.data, 'module-runtime-registry/records')
    fs.mkdirSync(registry, { recursive: true }); fs.writeFileSync(path.join(path.dirname(registry), 'instance-id'), instanceId + '\n', { mode: 0o600 })
    const registration = { schema_version: 1, instance_id: instanceId, runtime_id: runtimeId, module_id: 'crabot-agent', root_pid: gate.child.pid,
      process_start_identity: identity.started, module_port: 19842, created_at: new Date().toISOString() }
    fs.writeFileSync(path.join(registry, runtimeId + '.json'), JSON.stringify(registration), { mode: 0o600 })
    const receipt = await runtime.commitWorkspaceInterruptedRuntimeStart({ dataDir: f.data, recoveryId, moduleId: 'crabot-agent', process: identity,
      runtime: registration, definitionHash: sha256CanonicalJson(invocation), verify: role.verify })
    await gate.start({ dataDir: f.data, recoveryId, moduleId: 'crabot-agent', recordHash: sha256CanonicalJson(receipt), invocation, verify: role.verify, assertCurrent: () => {} })
    const deadline = Date.now() + 15000
    while (!fs.existsSync(resultFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    assert.equal(result.ok, mode === 'verified', JSON.stringify(result))
    if (mode === 'verified') {
      assert.deepEqual(result.first, expected); assert.deepEqual(result.second, expected)
      assert.equal(calls, 4)
    } else if (mode === 'changed probed root') assert.equal(calls, 3)
    else if (mode === 'wrong bearer' || mode === 'wrong runtime') assert.equal(calls, 0)
    else assert.equal(calls, 1)
    assert.deepEqual(fs.readdirSync(selectedRoot), ['default'])
    assert.equal(fs.readFileSync(path.join(selectedRoot, 'default/file'), 'utf8'), 'original bytes')
    assert.equal((await import('../workspace-maintenance.cjs')).default.workspaceMaintenancePending(f.data), true)
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    if (gate) {
      const { captureSpawnedProcessTree } = await import('../spawned-process-tree.cjs')
      const identities = gate.child.exitCode === null && gate.child.signalCode === null ? captureSpawnedProcessTree(gate.child) : []
      const ended = gate.child.exitCode === null && gate.child.signalCode === null ? once(gate.child, 'exit') : Promise.resolve()
      for (const identity of [...identities].reverse()) native.terminateKnownProcess(identity)
      gate.close(); await ended
    }
    const ended = once(role.child, 'exit'); role.close(); await ended; releaseCliLock(lock)
  }
})

for (const forward of [false, true])
for (const accepted of [false, true, 'wrong action']) test((forward ? 'forward' : 'source') + ' protection handoff consumes the finite current Core acknowledgement: ' + accepted, { timeout: 60000 }, async t => {
  const f = await stageFixture(t)
  await f.command('host-permit'); await f.command('stage-prepare'); await f.command('file-begin'); await f.command('host-stop')
  assert.equal((await f.command('file-move-fixture')).error, undefined)
  if (forward) for (const step of ['file-ready', 'closure-prepare-fixture', 'closure-commit-fixture']) assert.equal((await f.command(step)).error, undefined)
  f.child.disconnect(); await f.exited
  fs.mkdirSync(path.join(f.data, 'agent'), { recursive: true })
  const checkpoint = records.readWorkspaceInterruptedRelocationCheckpoint(f.data, f.id), recoveryId = randomUUID()
  const locks = await import('../cli-lock.mjs'), lock = await locks.acquireWorkspaceInterruptedRecoveryLock(f.data, f.id)
  const role = await (await import('../workspace-interrupted-launch.mjs')).launchWorkspaceInterruptedRecoveryCoordinator({ dataDir: f.data,
    request: { intent_id: f.id, recovery_id: recoveryId, checkpoint_sha256: checkpoint.checkpoint_sha256 }, verify: async () => {}, releaseParentLock: () => releaseCliLock(lock) })
  const { createServer } = await import('node:http')
  let job, calls = 0
  // This is explicitly a finite transport fixture; actual Core health/Root is
  // tested by the Core driver, not inferred from this deliberately empty plan.
  const server = createServer(async (req, res) => {
    let text = ''; for await (const bytes of req) text += bytes
    const message = JSON.parse(text); calls++
    assert.equal(req.headers.authorization, 'Bearer finite-role-secret')
    assert.equal(message.method, 'verify_workspace_interrupted_recovery_web')
    assert.deepEqual(message.params, { action: 'prepare_web' })
    res.end(JSON.stringify({ id: message.id, success: true, data: { verified: accepted, ...job, action: 'prepare_web' } }))
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    if (forward) { await role.prepareForwardService(); await role.archiveForward() }
    else { await role.restoreSource(); await role.archiveSource(); await role.prepareSourceBusiness() }
    const selected = await f.catalog.snapshot(), selectedRoot = forward ? f.target : f.source
    const runtime = await import('../workspace-interrupted-runtime.mjs'), instanceId = randomUUID(), adminRuntimeId = randomUUID()
    const plan = await runtime.commitWorkspaceInterruptedRuntimePlan({ dataDir: f.data, recoveryId, instanceId, adminRuntimeId, modules: [], verify: role.verify })
    job = { ...role.launch.request, launch_sha256: sha256CanonicalJson(role.launch), plan_sha256: sha256CanonicalJson(plan), instance_id: instanceId, admin_runtime_id: adminRuntimeId }
    const release = role[(forward !== (accepted === 'wrong action')) ? 'releaseForward' : 'releaseSource']
    const first = release({ job, credential: 'finite-role-secret', moduleManagerPort: server.address().port })
    assert.equal(release({ job, credential: 'finite-role-secret', moduleManagerPort: server.address().port }), first)
    const maintenance = (await import('../workspace-maintenance.cjs')).default
    if (accepted === true) {
      assert.deepEqual(await first, { released: true, ...job })
      await role.verify()
      const state = forward ? (await import('../workspace-interrupted-forward-records.mjs')).readWorkspaceInterruptedForwardPreparation(f.data, f.id)
        : (await import('../workspace-interrupted-source-records.mjs')).readWorkspaceSourceCompletionScope(f.data, f.id)
      assert.equal(state.released, true); assert.equal(state.release.job.recovery_id, recoveryId)
      assert.equal(maintenance.workspaceMaintenancePending(f.data), false)
      assert.equal(calls, 2)
      await assert.rejects(locks.acquireWorkspaceInterruptedRecoveryLock(f.data, f.id))
    } else {
      await assert.rejects(first)
      assert.equal(maintenance.workspaceMaintenancePending(f.data), true)
      assert.equal(calls, accepted === 'wrong action' ? 0 : 1)
    }
    assert.deepEqual(await f.catalog.snapshot(), selected)
    assert.equal(fs.readFileSync(path.join(selectedRoot, 'default/file'), 'utf8'), 'original bytes')
    assert.equal(fs.existsSync(path.join(f.data, 'workspace-control/relocation-history', f.id)), forward)
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    if (role.child.exitCode === null && role.child.signalCode === null) { const ended = once(role.child, 'exit'); role.close(); await ended }
    releaseCliLock(lock)
  }
})
