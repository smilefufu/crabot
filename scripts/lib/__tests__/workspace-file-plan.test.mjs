import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import native from '../process-identity.cjs'
import management from '../desktop-management.cjs'
import { acquireCliLock, acquireWorkspaceRelocationLock, releaseCliLock } from '../cli-lock.mjs'
import { WorkspaceCatalog } from '../../../crabot-shared/dist/workspace-catalog.js'
import { sha256CanonicalJson } from '../../../crabot-shared/dist/canonical-json.js'
import * as records from '../workspace-relocation-intent.mjs'

async function fixture(t, { exitEvidence = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'workspace-file-plan-中文 space-')))
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), id = randomUUID()
  const catalog = new WorkspaceCatalog({ dataRoot: data, files: native }); await catalog.initialize()
  const before = await catalog.snapshot(), source = before.storage_root, target = path.join(root, 'new')
  fs.writeFileSync(path.join(source, 'default/file'), 'original bytes')
  const lock = await acquireCliLock(data, 'workspace-relocation')
  await records.beginWorkspaceRelocationIntent({ dataDir: data, id, target, expectedRevision: before.revision, protectedRoots: [] })
  records.commitWorkspaceRelocationWorkers({ dataDir: data, id, workers: [] })
  records.commitWorkspaceRelocationProcesses({ dataDir: data, id, processes: [] })
  records.commitWorkspaceRelocationModules({ dataDir: data, id, modules: [] })
  const entry = new URL('../workspace-coordinator-entry.mjs', import.meta.url).href
  const module = new URL('../workspace-relocation-intent.mjs', import.meta.url).href
  const code = `import fs from 'node:fs';import{enterWorkspaceRelocationCoordinator}from ${JSON.stringify(entry)};import * as records from ${JSON.stringify(module)};
    const context=await enterWorkspaceRelocationCoordinator(), args={dataDir:context.dataDir,id:context.id};
    if(${exitEvidence}){records.prepareWorkspaceRelocationProcessStops(args);records.observeWorkspaceRelocationProcesses({...args,processes:[]});
      records.prepareWorkspaceRelocationStops({...args,workers:[]});records.completeWorkspaceRelocationStops({...args,results:[]});
      records.prepareWorkspaceRelocationModuleStops({...args,modules:[]});records.completeWorkspaceRelocationModuleStops({...args,results:[]});
      records.completeWorkspaceRelocationProcessStops(args);records.commitWorkspaceRelocationExecutionExit(args)}
    process.send({kind:'fixture-ready'});process.on('message',async message=>{if(message.kind!=='command')return;
      const sync=fs.fsyncSync;try{if(message.operation==='unlock')context.release();
        if(message.operation==='fail-sync')fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory())throw Object.assign(new Error('finite sync failure'),{code:'EIO'});return sync(fd)};
        const result=await records.prepareWorkspaceRelocationFilePlan(args);process.send({kind:'result',result})}
      catch(error){process.send({kind:'result',error:{code:error.code,message:error.message}})}finally{fs.fsyncSync=sync}});
    process.once('disconnect',()=>{context.release();process.exit(0)});setTimeout(()=>process.exit(3),30000);`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const exited = once(child, 'exit'); let error = ''; child.stderr.on('data', bytes => { error += bytes })
  const messages = []; child.on('message', message => messages.push(message))
  t.after(async () => {
    releaseCliLock(lock)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited; fs.rmSync(root, { recursive: true, force: true })
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

for (const damage of ['hash', 'extra', 'mode', 'parent', 'hardlink', 'link']) test('damaged fixed file plan cannot be replaced or dispatched again: ' + damage, async t => {
  const f = await fixture(t); assert.equal((await f.command()).result.dispatch, 'dispatch')
  if (damage === 'hardlink') fs.linkSync(f.file, path.join(f.root, 'second-link'))
  else if (damage === 'link') { fs.renameSync(f.file, path.join(f.root, 'retained-plan')); fs.symlinkSync(path.join(f.root, 'retained-plan'), f.file) }
  else { const plan = JSON.parse(fs.readFileSync(f.file)); if (damage === 'hash') plan.execution_exit_sha256 = '0'.repeat(64); else if (damage === 'mode') plan.mode = 'copy'; else if (damage === 'parent') { plan.staging_parent.path = f.source; plan.staging_path = path.join(f.source, '.crabot-workspace-' + f.id) } else plan.command = 'not permitted'; fs.writeFileSync(f.file, JSON.stringify(plan)) }
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
