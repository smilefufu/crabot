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

async function fixture(t, { exitEvidence = true, crossVolume = false } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'workspace-file-plan-中文 space-')))
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), id = randomUUID()
  const catalog = new WorkspaceCatalog({ dataRoot: data, files: native }); await catalog.initialize()
  const targetRoot = crossVolume ? fs.mkdtempSync('/dev/shm/crabot-file-tools-') : root
  const before = await catalog.snapshot(), source = before.storage_root, target = path.join(targetRoot, 'new')
  fs.writeFileSync(path.join(source, 'default/file'), 'original bytes')
  if (crossVolume) fs.writeFileSync(path.join(source, 'default/finite-archive.bin'), Buffer.alloc(1024 * 1024, 7))
  const lock = await acquireCliLock(data, 'workspace-relocation')
  await records.beginWorkspaceRelocationIntent({ dataDir: data, id, target, expectedRevision: before.revision, protectedRoots: [] })
  records.commitWorkspaceRelocationWorkers({ dataDir: data, id, workers: [] })
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
    process.once('disconnect',async()=>{await stop();process.exit(0)});process.send('ready');setTimeout(()=>process.exit(3),30000);`
  const code = `import fs from 'node:fs';import{spawn}from'node:child_process';import{once}from'node:events';import native from ${JSON.stringify(new URL('../process-identity.cjs', import.meta.url).href)};import{enterWorkspaceRelocationCoordinator}from ${JSON.stringify(entry)};import * as records from ${JSON.stringify(module)};
    const context=await enterWorkspaceRelocationCoordinator(), args={dataDir:context.dataDir,id:context.id};
    if(${exitEvidence}){records.prepareWorkspaceRelocationProcessStops(args);records.observeWorkspaceRelocationProcesses({...args,processes:[]});
      records.prepareWorkspaceRelocationStops({...args,workers:[]});records.completeWorkspaceRelocationStops({...args,results:[]});
      records.prepareWorkspaceRelocationModuleStops({...args,modules:[]});records.completeWorkspaceRelocationModuleStops({...args,results:[]});
      records.completeWorkspaceRelocationProcessStops(args);records.commitWorkspaceRelocationExecutionExit(args)}
    let host,hostIdentity,hostEnded,tools;
    async function ensureHost(){if(host)return;host=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(hostCode)}],{cwd:${JSON.stringify(source)},stdio:['ignore','ignore','ignore','ipc']});hostEnded=once(host,'exit');await once(host,'message');hostIdentity=native.inspectProcess(host.pid);process.send({kind:'fixture-actor',identity:hostIdentity})}
    process.send({kind:'fixture-ready'});process.on('message',async message=>{if(message.kind!=='command')return;
      const sync=fs.fsyncSync;try{if(message.operation==='unlock')context.release();
        if(message.operation==='fail-sync')fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory())throw Object.assign(new Error('finite sync failure'),{code:'EIO'});return sync(fd)};
        let result;
        if(['host-launch','host-launch-preload','host-launch-extra','host-launch-after-unlock'].includes(message.operation)){if(message.operation==='host-launch-preload')process.env.NODE_OPTIONS='--require '+JSON.stringify(${JSON.stringify(path.join(root, 'host-preload.cjs'))});const {launchWorkspaceFileHost}=await import(${JSON.stringify(new URL('../workspace-file-host.mjs', import.meta.url).href)});if(message.operation==='host-launch-after-unlock')context.release();const launched=await launchWorkspaceFileHost(message.operation==='host-launch-extra'?{...args,entry:'not-accepted'}:args);if(launched.child){host=launched.child;hostIdentity=launched.host;hostEnded=once(host,'exit');process.send({kind:'fixture-actor',identity:hostIdentity})}result={dispatch:launched.dispatch,host:launched.host}}
        else if(message.operation==='stage-create-failure'){const key=process.platform==='win32'?'createPrivateDirectory':'createPrivateStagingDirectory',create=native[key];native[key]=directory=>{create(directory);throw Object.assign(new Error('finite creation acknowledgement failure'),{code:'EIO'})};try{result=records.prepareWorkspaceRelocationStaging(args)}finally{native[key]=create}}
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
          else if(message.operation==='host-sync-failure'){const inode=fs.lstatSync(args.dataDir+'/workspace-control/relocation-file-actors.jsonl',{bigint:true}).ino;fs.fsyncSync=fd=>{if(fs.fstatSync(fd,{bigint:true}).ino===inode)throw Object.assign(new Error('finite sync failure'),{code:'EIO'});return sync(fd)};result=records.registerWorkspaceRelocationFileHost({...args,process:selected})}
          else result=records.registerWorkspaceRelocationFileHost({...args,process:selected});
        }else result=await records.prepareWorkspaceRelocationFilePlan(args);
        process.send({kind:'result',result})}
      catch(error){process.send({kind:'result',error:{code:error.code,message:error.message}})}finally{fs.fsyncSync=sync}});
    process.once('disconnect',()=>{context.release();process.exit(0)});setTimeout(()=>process.exit(3),30000);`
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
  const wait = async predicate => {
    const deadline = Date.now() + 10000
    while (!predicate()) { if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error('finite file-plan fixture: ' + error); await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  await wait(() => messages.some(message => message.kind === 'fixture-ready'))
  const command = async (operation = 'prepare') => {
    const offset = messages.length; child.send({ kind: 'command', operation })
    await wait(() => messages.slice(offset).some(message => message.kind === 'result'))
    return messages.slice(offset).find(message => message.kind === 'result')
  }
  return { root, data, id, source, target, catalog, before, child, exited, command, file: path.join(data, 'workspace-control/relocation-files.json') }
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
  fs.unlinkSync(path.join(f.data, 'workspace-control/relocation-execution-exit.json'))
  const bytes = fs.readFileSync(f.file)
  assert.throws(() => records.readWorkspaceRelocationFilePlan(f.data, f.id), { code: 'WORKSPACE_RELOCATION_INVALID' })
  assert.equal((await f.command()).error?.code, 'WORKSPACE_RELOCATION_INVALID'); assert.deepEqual(fs.readFileSync(f.file), bytes)
})


test('original file-host attempt, actual child identity and permission are durable once without filesystem effects', async t => {
  const f = await fixture(t), file = path.join(f.data, 'workspace-control/relocation-file-actors.jsonl')
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
  const file = path.join(f.data, 'workspace-control/relocation-file-actors.jsonl'), bytes = fs.readFileSync(file)
  assert.equal((await f.command('host-' + kind)).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(records.readWorkspaceRelocationFileActors(f.data, f.id).host, null)
})

test('an exited recorded file host cannot be permitted again or replaced with a new child', async t => {
  const f = await fixture(t); await f.command(); await f.command('actors-prepare'); await f.command('host-register'); await f.command('host-stop')
  const file = path.join(f.data, 'workspace-control/relocation-file-actors.jsonl'), bytes = fs.readFileSync(file)
  assert.equal((await f.command('host-permit')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.equal((await f.command('host-register')).result.dispatch, 'observe'); assert.deepEqual(fs.readFileSync(file), bytes)
  assert.equal(records.readWorkspaceRelocationFileActors(f.data, f.id).permission, null)
})

for (const damage of ['truncated', 'hash', 'extra', 'null-host', 'null-permission', 'hardlink', 'missing-plan']) test('damaged file actor records stay fenced without reconstruction: ' + damage, async t => {
  const f = await fixture(t); await f.command(); await f.command('actors-prepare'); await f.command('host-register')
  const file = path.join(f.data, 'workspace-control/relocation-file-actors.jsonl')
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
  const file = path.join(f.data, 'workspace-control/relocation-file-actors.jsonl'), bytes = fs.readFileSync(file)
  assert.equal((await f.command('host-register')).error?.code, 'WORKSPACE_RELOCATION_INVALID')
  assert.deepEqual(fs.readFileSync(file), bytes)
})

test('an unconfirmed complete actor append is synced on observation without registering a replacement', async t => {
  const f = await fixture(t); await f.command(); await f.command('actors-prepare')
  assert.equal((await f.command('host-sync-failure')).error?.code, 'EIO')
  const file = path.join(f.data, 'workspace-control/relocation-file-actors.jsonl'), bytes = fs.readFileSync(file)
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
  const actors = records.readWorkspaceRelocationFileActors(f.data, f.id), bytes = fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl'))
  assert.equal(actors.permission.type, 'host_permitted')
  const again = await f.command('host-launch'); assert.equal(again.result.dispatch, 'observe'); assert.deepEqual(again.result.host, launched.result.host)
  assert.deepEqual(fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl')), bytes)
  assert.equal(native.listChildProcessIds(f.child.pid).filter(pid => pid === launched.result.host.pid).length, 1)
  assert.equal(fs.existsSync(f.target), false); assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
})


for (const scenario of ['host-launch-extra', 'host-launch-after-unlock']) test('fixed file host rejects unsafe launch before a child exists: ' + scenario, async t => {
  const f = await fixture(t); await f.command()
  assert.equal((await f.command(scenario)).error?.code, 'CRABOT_WORKSPACE_FILE_HOST')
  assert.equal(records.readWorkspaceRelocationFileActors(f.data, f.id).attempt, null)
  assert.deepEqual(native.listChildProcessIds(f.child.pid), [])
})

test('an exited fixed file host is observed without automatically creating or permitting its replacement', async t => {
  const f = await fixture(t); await f.command(); const started = await f.command('host-launch'); await f.command('host-stop')
  const bytes = fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl'))
  const observed = await f.command('host-launch')
  assert.equal(observed.result.dispatch, 'observe'); assert.deepEqual(observed.result.host, started.result.host)
  assert.equal(native.isProcessExited(started.result.host.pid), true); assert.deepEqual(native.listChildProcessIds(f.child.pid), [])
  assert.deepEqual(fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl')), bytes)
})

test('the fixed file script cannot enter without a parent IPC channel', { timeout: 15000 }, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'workspace-host-no-ipc-'))), data = path.join(root, 'must-not-create')
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../workspace-file-host.mjs', import.meta.url))], { env: { ...process.env, DATA_DIR: data, NODE_OPTIONS: '', NODE_PATH: '' }, stdio: 'ignore' }), ended = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended; fs.rmSync(root, { recursive: true, force: true }) })
  assert.equal((await ended)[0], 1); assert.equal(fs.existsSync(data), false)
})

test('correct private material hashes cannot authorize a different real child and parent', { timeout: 30000 }, async t => {
  const f = await fixture(t); await f.command(); await f.command('actors-prepare'); await f.command('host-register')
  const actors = records.readWorkspaceRelocationFileActors(f.data, f.id), bytes = fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../workspace-file-host.mjs', import.meta.url))], { env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }), ended = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended })
  await once(child, 'spawn')
  child.send({ kind: 'workspace_file_host_start', data_dir: f.data, intent_id: f.id, attempt_sha256: sha256CanonicalJson(actors.attempt), host_sha256: sha256CanonicalJson(actors.host) })
  assert.equal((await ended)[0], 1)
  assert.equal(records.readWorkspaceRelocationFileActors(f.data, f.id).permission, null)
  assert.deepEqual(fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl')), bytes)
  assert.equal(fs.existsSync(f.target), false)
})


const crossVolumeTools = { skip: process.platform !== 'linux' || !fs.existsSync('/dev/shm') || fs.statSync(tmpdir()).dev === fs.statSync('/dev/shm').dev }
async function toolsFixture(t, permitHost = true) {
  const f = await fixture(t, { crossVolume: true })
  assert.equal((await f.command()).result.plan.mode, 'copy')
  await f.command('actors-prepare'); await f.command('host-register')
  if (permitHost) { await f.command('host-permit'); assert.equal((await f.command('stage-prepare')).error, undefined) }
  const created = await f.command('tools-create'); assert.equal(created.error, undefined)
  return { ...f, tools: created.result, actorsFile: path.join(f.data, 'workspace-control/relocation-file-actors.jsonl') }
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
  assert.equal(fs.existsSync(f.target), false); assert.equal(fs.existsSync(records.readWorkspaceRelocationFilePlan(f.data, f.id).staging_path), false)
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
  await f.command('host-permit'); await f.command('stage-prepare'); assert.equal((await f.command('tools-register')).result.dispatch, 'dispatch')
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
  const before = fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl')), context = { dataDir: f.data, id: f.id }
  assert.throws(() => createWorkspaceFileToolJournal(context), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
  assert.throws(() => serveWorkspaceFileToolJournal(f.child, context), { code: 'CRABOT_WORKSPACE_JOURNAL_UNAVAILABLE' })
  assert.deepEqual(fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl')), before)
})


for (const mode of ['confirmed', 'lost registration', 'lost permission']) test('real FD copier uses Host IPC before writing a cross-volume tree: ' + mode, crossVolumeTools, async t => {
  const f = await fixture(t, { crossVolume: true })
  await f.command(); await f.command('actors-prepare'); await f.command('host-register'); await f.command('host-permit'); await f.command('stage-prepare')
  await f.command(mode === 'confirmed' ? 'tools-relay' : mode === 'lost registration' ? 'tools-relay-drop' : 'tools-relay-drop-permit')
  const result = await f.command('tools-copy'), plan = records.readWorkspaceRelocationFilePlan(f.data, f.id), tree = path.join(plan.staging_path, 'tree')
  const facts = records.readWorkspaceRelocationFileActors(f.data, f.id), bytes = fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl'))
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
    assert.deepEqual(fs.readFileSync(path.join(f.data, 'workspace-control/relocation-file-actors.jsonl')), bytes)
    assert.deepEqual(fs.readdirSync(tree), [])
  }
  assert.equal(fs.existsSync(f.target), false); assert.deepEqual(await f.catalog.snapshot(), f.before)
  assert.equal(fs.readFileSync(path.join(f.source, 'default/file'), 'utf8'), 'original bytes')
})


async function stageFixture(t) {
  const f = await fixture(t); await f.command(); await f.command('actors-prepare'); await f.command('host-register')
  return { ...f, actorsFile: path.join(f.data, 'workspace-control/relocation-file-actors.jsonl'), staging: records.readWorkspaceRelocationFilePlan(f.data, f.id).staging_path }
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
